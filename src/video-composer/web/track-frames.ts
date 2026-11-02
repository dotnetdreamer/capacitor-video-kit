import { loadableUrl, resolve } from '../../web-runtime/files';

import { FrameReader } from './media';

/**
 * The frames a tracking run reads: a stretch of one source, in order, small and grey - every frame,
 * because a thing that moves between two frames read a third of a second apart has often left the box.
 *
 * WebCodecs first, through mediabunny's `CanvasSink`: it decodes as fast as the phone's decoder goes,
 * hands over every frame with its own time, upright, already scaled down, and never waits on a seek -
 * a run over ten seconds of a phone's preview copy reads in a few. Where the WebView has no decoder
 * for the file that way (WebCodecs is newer than some WebViews, and some decode HEVC only through a
 * `<video>`), the `<video>` element the render already trusts is stepped instead, at [STEPPED_FPS],
 * slower but able to read whatever the preview can play.
 */

/** One frame of the stretch: when it is, in SOURCE ms, and its luma, row by row. */
export interface TrackFrame {
  timeMs: number;
  luma: Uint8Array;
}

/** A source opened for tracking. */
export interface TrackFrameSource {
  /** The size the frames are read at. */
  readonly width: number;
  readonly height: number;
  /** The oriented source's width over its height. */
  readonly aspect: number;
  /** The source's length in ms, 0 when it will not say. */
  readonly durationMs: number;
  /**
   * The frames from the one on screen at `fromMs` to the one on screen at `toMs`, in order. Each frame's
   * luma is its own array; nothing is reused under the caller.
   */
  frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame>;
  close(): void;
}

/** The longest side a frame is read at: enough for a sub-pixel track of a thing a tenth of the frame across. */
export const TRACK_EDGE = 512;

/** How often the `<video>` fallback reads a frame. */
export const STEPPED_FPS = 15;

/** A run stopped by its caller. */
export class TrackStoppedError extends Error {}

/** Opens `uri` for tracking: WebCodecs where the file decodes that way, the `<video>` element otherwise. */
export async function openTrackFrames(uri: string, maxEdge = TRACK_EDGE): Promise<TrackFrameSource> {
  try {
    const decoded = await openDecoded(uri, maxEdge);
    if (decoded) return decoded;
  } catch {
    // A container mediabunny cannot read, a codec WebCodecs will not take: the element may still play it.
  }
  return openStepped(uri, maxEdge);
}

/** The working size for a frame of `width` x `height`: its longer side at most `maxEdge`. */
export function workingSize(width: number, height: number, maxEdge: number): { width: number; height: number } {
  const scale = Math.min(1, maxEdge / Math.max(width, height));
  return { width: Math.max(16, Math.round(width * scale)), height: Math.max(16, Math.round(height * scale)) };
}

/** A canvas the frames are read back from, held on the CPU because every frame is read back. */
function readbackCanvas(width: number, height: number): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('this browser will not read a canvas back');
  return ctx;
}

/** Whether this platform keeps a 32-bit word's lowest byte first, which is where a pixel's red is then. */
const LITTLE_ENDIAN = new Uint8Array(new Uint32Array([1]).buffer)[0] === 1;

/**
 * The picture on `ctx` as luma, Rec. 601's weights in integers. Each pixel is read as one word rather
 * than three bytes: on a phone this loop runs on every frame of a run, at the run's speed.
 */
function lumaOf(ctx: CanvasRenderingContext2D, width: number, height: number): Uint8Array {
  const rgba = ctx.getImageData(0, 0, width, height).data;
  const words = new Uint32Array(rgba.buffer, rgba.byteOffset, width * height);
  const luma = new Uint8Array(width * height);
  if (LITTLE_ENDIAN) {
    for (let i = 0; i < luma.length; i++) {
      const p = words[i]!;
      luma[i] = ((p & 0xff) * 77 + ((p >>> 8) & 0xff) * 150 + ((p >>> 16) & 0xff) * 29) >> 8;
    }
  } else {
    for (let i = 0; i < luma.length; i++) {
      const p = words[i]!;
      luma[i] = ((p >>> 24) * 77 + ((p >>> 16) & 0xff) * 150 + ((p >>> 8) & 0xff) * 29) >> 8;
    }
  }
  return luma;
}

async function openDecoded(uri: string, maxEdge: number): Promise<TrackFrameSource | null> {
  if (typeof VideoDecoder === 'undefined') return null;
  const url = await loadableUrl(uri);
  const { ALL_FORMATS, BlobSource, CanvasSink, Input, UrlSource } = await import('mediabunny');
  const source = /^https?:/i.test(url) ? new UrlSource(url) : new BlobSource(await resolve(url));
  const input = new Input({ source, formats: ALL_FORMATS });
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) {
      input.dispose();
      return null;
    }
    const shown = { width: track.displayWidth, height: track.displayHeight };
    if (!(shown.width > 0) || !(shown.height > 0)) {
      input.dispose();
      return null;
    }
    const size = workingSize(shown.width, shown.height, maxEdge);
    const durationMs = (await input.computeDuration().catch(() => 0)) * 1000;
    const sink = new CanvasSink(track, { width: size.width, height: size.height, fit: 'fill', poolSize: 2 });
    const ctx = readbackCanvas(size.width, size.height);
    return {
      width: size.width,
      height: size.height,
      aspect: shown.width / shown.height,
      durationMs,
      async *frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame> {
        // From a little before, so the frame already on screen at `fromMs` is read too, whatever the
        // sink counts as a frame's start.
        for await (const wrapped of sink.canvases(Math.max(0, fromMs - 100) / 1000, (toMs + 1) / 1000)) {
          if (signal.aborted) throw new TrackStoppedError('stopped');
          const start = wrapped.timestamp * 1000;
          const end = start + Math.max(1, wrapped.duration * 1000);
          if (end <= fromMs) continue;
          if (start > toMs) break;
          ctx.drawImage(wrapped.canvas, 0, 0);
          yield { timeMs: Math.max(start, 0), luma: lumaOf(ctx, size.width, size.height) };
        }
      },
      close: () => input.dispose(),
    };
  } catch (error) {
    input.dispose();
    throw error;
  }
}

async function openStepped(uri: string, maxEdge: number): Promise<TrackFrameSource> {
  const reader = await FrameReader.open(uri);
  const video = reader.video;
  if (!(video.videoWidth > 0) || !(video.videoHeight > 0)) {
    reader.close();
    throw new Error(`the browser decodes no picture in ${uri}`);
  }
  const size = workingSize(video.videoWidth, video.videoHeight, maxEdge);
  const ctx = readbackCanvas(size.width, size.height);
  const step = 1000 / STEPPED_FPS;
  return {
    width: size.width,
    height: size.height,
    aspect: video.videoWidth / video.videoHeight,
    durationMs: Number.isFinite(video.duration) ? video.duration * 1000 : 0,
    async *frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame> {
      for (let t = fromMs; t <= toMs + 0.5; t += step) {
        if (signal.aborted) throw new TrackStoppedError('stopped');
        if (!(await reader.seek(t / 1000, 0))) continue;
        ctx.drawImage(video, 0, 0, size.width, size.height);
        yield { timeMs: t, luma: lumaOf(ctx, size.width, size.height) };
      }
    },
    close: () => reader.close(),
  };
}
