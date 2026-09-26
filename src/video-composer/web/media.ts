import { loadableUrl, resolve } from '../../web-runtime/files';
import { decodePicture, measurePicture, type DecodedPicture } from '../../web-runtime/picture';
import type { FrameTween, LayerSource } from './painter';
import type { ProbedInput } from './plan';
import { framePairAt, frameSeekTarget, frameTimes, type SourceWindow } from './slow-motion';

/**
 * The browser's decoder, which is a `<video>` element.
 *
 * It is worth saying why this is not `VideoDecoder`. WebCodecs decodes ELEMENTARY STREAMS: it wants
 * `EncodedVideoChunk`s, which means demuxing whatever container the customer picked - MP4 from an
 * iPhone, WebM from a screen recorder, MOV, 3GP - before a single frame comes out. A `<video>`
 * element already holds every demuxer and every decoder the platform has, applies rotation
 * metadata, copes with variable frame rates, and works the same on a five-year-old Android as on a
 * desktop. The cost is that it is driven by seeking rather than pulled frame by frame, and that
 * cost is paid here deliberately: a render that is slower and right beats one that is fast for the
 * three formats someone remembered to demux.
 *
 * Seeking is also what makes the renderer DETERMINISTIC. The output timeline is stepped at exactly
 * one frame interval and each step asks for the source time it needs, so a slow phone produces the
 * same video as a fast desktop - just later. Playing the source back in real time and capturing
 * whatever arrived would make the output depend on how busy the machine was.
 */

/** A media element that never fires either event would otherwise hang the caller for good. */
const METADATA_TIMEOUT_MS = 15_000;
const SEEK_TIMEOUT_MS = 8_000;

/** What a `<video>` reports beyond the standard interface, where the browser has it. */
interface AudioAwareVideo extends HTMLVideoElement {
  readonly mozHasAudio?: boolean;
  readonly webkitAudioDecodedByteCount?: number;
  readonly audioTracks?: { length: number };
}

/**
 * Opens one source and hands back an element already at its first frame.
 *
 * `crossOrigin` is set before `src`, which is the only moment it can be set: a cross-origin video
 * loaded without it taints every canvas it is drawn on, and a tainted canvas cannot be read back -
 * so the render would fail at its first frame with a SecurityError rather than here, with a
 * sentence naming the file. A server that answers no CORS header refuses the request outright
 * instead, which is the same failure one step earlier and far easier to act on.
 */
export async function openVideo(uri: string): Promise<HTMLVideoElement> {
  const url = await loadableUrl(uri);
  const video = document.createElement('video');
  if (/^https?:/i.test(url)) video.crossOrigin = 'anonymous';
  video.preload = 'auto';
  video.muted = true;
  video.playsInline = true;
  // Never attached to the document: a render draws the element, it does not show it, and an element
  // in the tree would be laid out and composited for nothing.
  video.src = url;
  video.load();

  if (!(await waitFor(video, 'loadeddata', METADATA_TIMEOUT_MS))) {
    throw new Error(`the browser could not open ${uri}`);
  }
  return video;
}

/** Gives back the decoder a source was holding. Every caller has to, and on every path. */
export function closeVideo(video: HTMLVideoElement): void {
  try {
    video.pause();
  } catch {
    /* Already stopped, or never started. */
  }
  video.removeAttribute('src');
  video.load();
}

/**
 * What a file is, for `probe()` and for the plan.
 *
 * `hasAudio` defaults to TRUE where the browser will not say. That direction is deliberate: a false
 * positive costs one silent decode in the mixer, which notices and moves on, while a false negative
 * silently drops the customer's sound from their post.
 */
export async function probeMedia(uri: string): Promise<ProbedInput & { rotation: number }> {
  const video = await openVideo(uri);
  try {
    const durationMs = Number.isFinite(video.duration) && video.duration > 0 ? Math.round(video.duration * 1000) : 0;
    return {
      durationMs,
      // Already the DISPLAY size: a browser applies the container's rotation before it reports
      // `videoWidth`, which is the same thing both native engines promise.
      width: video.videoWidth,
      height: video.videoHeight,
      hasAudio: hasAudioTrack(video),
      hasVideo: video.videoWidth > 0 && video.videoHeight > 0,
      // A `<video>` exposes no rotation flag, and it has already applied it, so there is nothing
      // honest to report but zero. The field is for the log on the platforms that have one.
      rotation: 0,
    };
  } finally {
    closeVideo(video);
  }
}

/**
 * Whether the file carries sound, as far as this browser is willing to say.
 *
 * Three browsers expose three different things and none of them is standard, so all three are asked
 * before falling back. `webkitAudioDecodedByteCount` is only non-zero once something has been
 * decoded, so a zero from it means "nothing yet" rather than "no audio" - which is why it is read
 * only as a positive signal.
 */
export function hasAudioTrack(video: HTMLVideoElement): boolean {
  const probe = video as AudioAwareVideo;
  if (typeof probe.mozHasAudio === 'boolean') return probe.mozHasAudio;
  if (probe.audioTracks && typeof probe.audioTracks.length === 'number') {
    return probe.audioTracks.length > 0;
  }
  if ((probe.webkitAudioDecodedByteCount ?? 0) > 0) return true;
  return true;
}

/**
 * What one layer is drawn from, whichever kind of source it is: something to hand the painter, its
 * size, a way to put it on the frame for an instant, and a way to give it back.
 */
export interface SourceReader {
  readonly source: LayerSource;
  readonly width: number;
  readonly height: number;
  /** Resolves true when there is a frame to draw at `seconds` into the source. */
  seek(seconds: number, frameIntervalSeconds: number): Promise<boolean>;
  /**
   * The picture at `seconds` into the source made from the two recorded frames either side of it,
   * for a clip slowed below 1x that plays `window` of the file - see `slow-motion.ts`. Null wherever that cannot be had, and the
   * caller then [seek]s and draws [source] exactly as it would at any other speed. Absent on a
   * reader that has only one frame to give, which is a picture.
   */
  tweenAt?(seconds: number, window: SourceWindow): Promise<SynthesisedFrame | null>;
  close(): void;
}

/** What [SourceReader.tweenAt] hands the painter: frame A, and frame B with how far towards it. */
export interface SynthesisedFrame {
  source: LayerSource;
  /** Null where A is drawn alone: an instant exactly on a frame, or the file's last frame. */
  tween: FrameTween | null;
}

/**
 * A picture on the timeline, which is the same frame at every instant: decoded once, upright and
 * at the size the render needs (see `web-runtime/picture`), and never seeked. See
 * `ComposeClip.image`.
 */
export class StillReader implements SourceReader {
  private constructor(private readonly picture: DecodedPicture) {}

  static async open(uri: string, maxEdge: number): Promise<StillReader> {
    return new StillReader(await decodePicture(await loadableUrl(uri), maxEdge));
  }

  get source(): LayerSource {
    return this.picture.bitmap;
  }

  get width(): number {
    return this.picture.width;
  }

  get height(): number {
    return this.picture.height;
  }

  /** Always there, whatever the time: a picture has one frame and it is already decoded. */
  seek(): Promise<boolean> {
    return Promise.resolve(true);
  }

  close(): void {
    const bitmap = this.picture.bitmap;
    if ('close' in bitmap) bitmap.close();
  }
}

/**
 * What a picture is, for `probe()` and for the plan: its size, and no length or sound of its own.
 * Rejects when it will not decode, which is the unreadable input the render reports.
 */
export async function probePicture(uri: string): Promise<ProbedInput> {
  const size = await measurePicture(await loadableUrl(uri));
  if (!size) throw new Error(`the browser could not open the picture ${uri}`);
  return { durationMs: 0, width: size.width, height: size.height, hasAudio: false, hasVideo: true };
}

/** What a [FrameReader] is opened with beyond its file. */
export interface FrameReaderOptions {
  /**
   * Hears about every picture the reader lets go of - one frame of a slowed clip that no output
   * frame will be made from again - before it is closed, so whatever was drawing it can let go too.
   */
  onDrop?: (source: LayerSource) => void;
  /**
   * The file's frame times, for a slowed clip; see [readFrameTimes]. Handed in rather than read here
   * so a render that comes back to a file reads them once, not once per visit. Absent is read here,
   * the first time it is needed.
   */
  frameTimes?: () => Promise<Float64Array | null>;
}

/**
 * One source, seeked frame by frame - the renderer's whole relationship with a decoder.
 *
 * The last time it was asked for is remembered, and a request inside half a frame of it draws
 * nothing new. That is not a micro-optimisation: a clip asks for the same source frame twice in a
 * row whenever two output frames land on it, and without this the render would seek, wait and decode
 * twice for one picture. The same holds for a frame held at the join between two clips.
 *
 * A clip SLOWED below 1x is read differently, through [tweenAt]: there each output frame is made from
 * the two recorded frames either side of it (see `slow-motion.ts`), so the reader needs two frames at
 * once where a `<video>` element holds one. It keeps them as bitmaps. Each is taken by seeking the
 * element to the middle of that frame's time on screen and copying what it shows, which needs the
 * frames' real timestamps - read from the container once, by [readFrameTimes] - and after that the
 * pair is kept for as long as output frames are made from it: at 0.3x that is three or four output
 * frames a pair, and walking forward costs ONE seek per source frame, fewer than the plain path pays.
 * The element is still the only decoder, so a slowed clip is decoded, oriented and coloured by
 * exactly what decodes the same file at 1x, and a clip split into a 1x part and a slowed one does not
 * change colour at the join.
 */
export class FrameReader implements SourceReader {
  private lastSeconds = Number.NaN;
  private grid: Promise<Float64Array | null> | null = null;
  /** Frames of a slowed clip, by index into the frame times: A, B, and nothing else. */
  private readonly held = new Map<number, ImageBitmap>();
  /** Set when this browser cannot copy a frame out of the element at all; the plain path from then on. */
  private cannotCopy = false;

  private constructor(
    readonly video: HTMLVideoElement,
    private readonly uri: string,
    private readonly options: FrameReaderOptions,
  ) {}

  static async open(uri: string, options: FrameReaderOptions = {}): Promise<FrameReader> {
    return new FrameReader(await openVideo(uri), uri, options);
  }

  get source(): LayerSource {
    return this.video;
  }

  get width(): number {
    return this.video.videoWidth;
  }

  get height(): number {
    return this.video.videoHeight;
  }

  /**
   * Puts the element on the frame covering `seconds`. Resolves true when there is a frame to draw -
   * which includes the case where the element was already on it.
   *
   * A seek that never lands resolves FALSE rather than rejecting. The caller then draws the frame
   * already there, which is one repeated frame in the finished video instead of a render that
   * failed twenty seconds in over one awkward keyframe.
   */
  async seek(seconds: number, frameIntervalSeconds: number): Promise<boolean> {
    // A plain draw is a layer that has left its slowed clip, or never had one: the frames held for
    // one will not be drawn again.
    this.dropHeld();
    const target = this.clampTarget(seconds);
    if (Number.isFinite(this.lastSeconds) && Math.abs(target - this.lastSeconds) < frameIntervalSeconds / 2) {
      return true;
    }
    return await this.goTo(target);
  }

  /**
   * The picture at `seconds` into the source for a slowed clip: frame A as a bitmap, and frame B with
   * its weight where the instant is between two frames. Null wherever the two frames cannot be had -
   * a file whose frame times will not read, a browser that will not copy a frame, a seek that did not
   * land - and the caller then draws the plain way, which is the stutter this replaces and never
   * anything worse.
   */
  async tweenAt(seconds: number, window: SourceWindow): Promise<SynthesisedFrame | null> {
    if (this.cannotCopy || typeof createImageBitmap !== 'function') return null;
    const times = await (this.grid ??= this.options.frameTimes?.() ?? readFrameTimes(this.uri));
    if (!times) return null;
    const pair = framePairAt(times, this.clampTarget(seconds), window);
    if (!pair) return null;
    // Only A and the frame after it are ever kept, so a slowed clip holds two frames however long it
    // runs; B is kept even at an instant that does not draw it, because the next instant will.
    this.keepOnly(pair.a, pair.a + 1);
    const a = await this.capture(times, pair.a);
    if (!a) return null;
    if (pair.b < 0 || !(pair.weight > 0)) return { source: a, tween: null };
    const b = await this.capture(times, pair.b);
    return { source: a, tween: b ? { source: b, weight: pair.weight } : null };
  }

  close(): void {
    this.dropHeld();
    closeVideo(this.video);
  }

  /** A time the element can be put at: inside the file, and a millisecond short of its very end. */
  private clampTarget(seconds: number): number {
    const duration = this.video.duration;
    return Math.max(0, Number.isFinite(duration) && duration > 0 ? Math.min(seconds, duration - 0.001) : seconds);
  }

  /** Frame `index`, copied out of the element: held already, or seeked to and copied now. */
  private async capture(times: Float64Array, index: number): Promise<ImageBitmap | null> {
    const held = this.held.get(index);
    if (held) return held;
    if (!(await this.goTo(this.clampTarget(frameSeekTarget(times, index))))) return null;
    let bitmap: ImageBitmap;
    try {
      bitmap = await createImageBitmap(this.video);
    } catch {
      // Not a frame that failed but a browser that cannot do this: every later frame would fail the
      // same way, one seek later.
      this.cannotCopy = true;
      return null;
    }
    // Drawn with the element's own size, which is what the layer's window is worked out from. A
    // stream that changes size partway is drawn the plain way across the change.
    if (bitmap.width !== this.video.videoWidth || bitmap.height !== this.video.videoHeight) {
      bitmap.close();
      return null;
    }
    this.held.set(index, bitmap);
    return bitmap;
  }

  /** Lets go of every held frame but `keepA` and `keepB`. */
  private keepOnly(keepA: number, keepB: number): void {
    for (const [index, bitmap] of this.held) {
      if (index === keepA || index === keepB) continue;
      this.held.delete(index);
      this.drop(bitmap);
    }
  }

  private dropHeld(): void {
    if (this.held.size === 0) return;
    for (const bitmap of this.held.values()) this.drop(bitmap);
    this.held.clear();
  }

  private drop(bitmap: ImageBitmap): void {
    this.options.onDrop?.(bitmap);
    bitmap.close();
  }

  /**
   * Puts the element at `target` and waits for the frame there. Resolves true once it has landed;
   * see [seek] for why a seek that never lands is a false rather than a failure.
   */
  private async goTo(target: number): Promise<boolean> {
    const landed = await new Promise<boolean>(resolve => {
      let settled = false;
      const done = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.video.removeEventListener('seeked', onSeeked);
        this.video.removeEventListener('error', onError);
        resolve(ok);
      };
      const onSeeked = (): void => done(true);
      const onError = (): void => done(false);
      const timer = setTimeout(() => done(false), SEEK_TIMEOUT_MS);
      this.video.addEventListener('seeked', onSeeked);
      this.video.addEventListener('error', onError);
      this.video.currentTime = target;
    });

    if (landed) {
      this.lastSeconds = this.video.currentTime;
      // `seeked` says the element's time has moved; it does not say a frame has been PAINTED, and
      // drawing between the two copies the previous picture. Where the browser offers the callback
      // that does say so, one turn of it is the difference between a correct frame and a stale one.
      await nextPaintedFrame(this.video);
    }
    return landed;
  }
}

/** Past this many frames a file's frame times are not worth holding: over two hours at 60 fps. */
const MAX_FRAME_TIMES = 500_000;

/**
 * Every frame's presentation time in a file, in seconds on the timeline a `<video>` element seeks
 * on, or null where they cannot be read - which is a slowed clip drawn the plain way, never a render
 * that fails.
 *
 * WHY THE CONTAINER, and not the element: a `<video>` says nothing about where its frames are. It
 * seeks to a time and shows the frame covering it, and the one callback that reports a frame's own
 * timestamp (`requestVideoFrameCallback`'s `mediaTime`) is not called at all for a paused element
 * that is not in the document - which is exactly what a render's element is, measured in Chromium.
 * The container has every frame's time already written down, and a demuxer reads them without
 * decoding a single one: the packets' METADATA only, which for an MP4 is its sample table, already in
 * memory once the file is open. The times are the ones the element plays by - both apply the edit
 * list - and they are the real ones, so footage with a variable frame rate is blended by the time
 * that actually passed between two frames.
 *
 * The demuxer is loaded on first use, as the waveform's is: a post with no slowed clip never loads
 * it. A file it cannot parse, or one with no video track, is null.
 */
export async function readFrameTimes(uri: string): Promise<Float64Array | null> {
  let input: { dispose(): void } | null = null;
  try {
    const url = await loadableUrl(uri);
    const { ALL_FORMATS, BlobSource, EncodedPacketSink, Input, UrlSource } = await import('mediabunny');
    // Read by range where it is a URL on the network; a blob is already the file, sliced rather than
    // copied.
    const source = /^https?:/i.test(url) ? new UrlSource(url) : new BlobSource(await resolve(url));
    const reader = new Input({ source, formats: ALL_FORMATS });
    input = reader;
    const track = await reader.getPrimaryVideoTrack();
    if (!track) return null;
    const stamps: number[] = [];
    for await (const packet of new EncodedPacketSink(track).packets(undefined, undefined, { metadataOnly: true })) {
      stamps.push(packet.timestamp);
      if (stamps.length > MAX_FRAME_TIMES) return null;
    }
    const times = frameTimes(stamps);
    // One frame has nothing to be blended with.
    return times.length >= 2 ? times : null;
  } catch {
    return null;
  } finally {
    input?.dispose();
  }
}

/**
 * Resolves once the element has a new frame on screen, or immediately in a browser without
 * `requestVideoFrameCallback`.
 *
 * The timeout matters: a paused element that has already painted the frame it was seeked to may
 * never call back again, and waiting for a callback that is not coming would stall the render at
 * the first frame of every clip.
 */
function nextPaintedFrame(video: HTMLVideoElement): Promise<void> {
  if (typeof video.requestVideoFrameCallback !== 'function') return Promise.resolve();
  return new Promise<void>(resolve => {
    let settled = false;
    const done = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, 100);
    video.requestVideoFrameCallback(() => done());
  });
}

/** Whether `event` arrived before `timeoutMs`, with `error` counting as a no. */
export function waitFor(element: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const done = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      element.removeEventListener(event, onEvent);
      element.removeEventListener('error', onError);
      resolve(ok);
    };
    const onEvent = (): void => done(true);
    const onError = (): void => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    element.addEventListener(event, onEvent);
    element.addEventListener('error', onError);
  });
}

/** A PNG data URL as something drawable, which is what an overlay is on the way to the frame. */
export async function decodeImage(dataUrl: string): Promise<ImageBitmap | HTMLImageElement> {
  if (typeof createImageBitmap === 'function' && typeof fetch === 'function') {
    try {
      const blob = await (await fetch(dataUrl)).blob();
      return await createImageBitmap(blob);
    } catch {
      // Safari has refused `createImageBitmap` on some data URLs; the element path below always
      // works and costs one decode either way.
    }
  }
  return await new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('an overlay bitmap could not be decoded'));
    image.src = dataUrl;
  });
}
