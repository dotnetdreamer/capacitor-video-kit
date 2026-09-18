import { cssFor } from '../../editor/edit-manifest';
import { describe } from '../../web-runtime/files';
import type { ComposeFailureCode, ComposeRect, ComposeSpec } from '../definitions';

import { mixdown } from './audio';
import { renderSupport } from './capabilities';
import { openSink, type FrameSink } from './encode';
import { decodeImage, FrameReader, probeMedia } from './media';
import { Painter, WHOLE_FRAME, type LayerDraw } from './painter';
import { buildPlan, clipIndexAt, sourceTimeUs, visibleIndexAt, type PlannedClip, type ProbedInput, type RenderPlan } from './plan';

/**
 * The render itself: plan, mix, then one pass down the output timeline.
 *
 * The loop is the shape the whole web implementation is built around. The output is stepped at
 * exactly one frame interval; at each step every visible layer is asked for the source frame it
 * needs, the painter assembles them, the overlays go on, and the finished canvas goes to the sink.
 * The loop itself is scheduled against nothing, so on the WebCodecs engine a phone produces the same
 * file as a desktop, just later. The recorder engine is the exception and owns its own pacing - see
 * `encode.ts` - because `MediaRecorder` timestamps by the wall clock and cannot be hurried.
 *
 * At most two decoders are open at once, which is the same budget `MAX_VIDEO_TRACKS` sets natively
 * and for the same reason - a mid-range phone has a handful of hardware decoders and the page
 * behind the editor may already hold some. Each layer keeps ONE `<video>` and re-points it when its
 * clip changes, so a post of ten clips still only ever has one video element open for the base.
 */

/** How often the bar is allowed to move. Any faster and it is work rather than feedback. */
const PROGRESS_STEP = 0.01;

/** Where the bar sits when the frames start, with probing and the audio mix behind it. */
const FRAMES_FROM = 0.1;
const FRAMES_TO = 0.98;

/** What the finished render hands back to the plugin. */
export interface RenderOutcome {
  blob: Blob;
  /** `video/mp4`, or `video/webm` where that is all this browser would encode. */
  mimeType: string;
  poster: Blob | null;
  durationMs: number;
  width: number;
  height: number;
  hasAudio: boolean;
}

/** A render that ended without a video, carrying the code the contract's `failed` event names. */
export class RenderFailure extends Error {
  constructor(
    readonly code: ComposeFailureCode,
    message: string,
    readonly clipKey?: string,
  ) {
    super(message);
    this.name = 'RenderFailure';
  }
}

export interface RenderOptions {
  signal: AbortSignal;
  onProgress(progress: number): void;
}

export async function renderSpec(spec: ComposeSpec, options: RenderOptions): Promise<RenderOutcome> {
  const support = await renderSupport(spec.output.width, spec.output.height, spec.output.fps);
  if (!support.supported) throw new RenderFailure('unsupported', support.reason);

  const probes = await probeInputs(spec, options.signal);
  const plan = buildPlan(spec, probes);
  options.onProgress(0.02);

  const mix = await guard(() => mixdown(plan, options.signal), 'unknown');
  options.onProgress(FRAMES_FROM);

  const painter = new Painter(plan.output);
  painter.setColour(plan.colorMatrix, cssFor(spec.filter));
  const layers = new LayerReaders();
  const overlays = new OverlayBitmaps();
  // Opened last, and immediately before the loop: the recorder engine starts recording the moment
  // it is opened, and every millisecond between that and the first frame is a millisecond of the
  // finished video with nothing in it.
  const sink = await guard(
    () =>
      openSink({
        output: plan.output,
        support,
        canvas: painter.frame,
        mix,
        signal: options.signal,
      }),
    'encoder',
  );

  try {
    const poster = await drawEveryFrame(plan, painter, sink, layers, overlays, options);
    const { blob, hasAudio, mimeType } = await guard(() => sink.finish(), 'muxer');
    options.onProgress(1);
    return {
      blob,
      mimeType,
      poster,
      durationMs: Math.round(plan.totalUs / 1000),
      width: plan.output.width,
      height: plan.output.height,
      hasAudio,
    };
  } finally {
    // Every decoder, texture and bitmap goes back on every path. A render that failed halfway and
    // left two `<video>` elements holding hardware decoders is a page whose next render cannot
    // start.
    layers.close();
    overlays.close();
    painter.dispose();
    await sink.close();
  }
}

/* -------------------------------------------------------------------------------------------- */

/**
 * One pass down the output timeline. Returns the poster, cut from the frame the spec asked for
 * rather than encoded a second time.
 */
async function drawEveryFrame(
  plan: RenderPlan,
  painter: Painter,
  sink: FrameSink,
  layers: LayerReaders,
  overlays: OverlayBitmaps,
  options: RenderOptions,
): Promise<Blob | null> {
  const fps = plan.output.fps;
  const frameUs = 1_000_000 / fps;
  // CEIL, with the last frame shortened below - so the video ends exactly where the plan says and
  // not on a frame boundary near it. Rounding the count instead makes the file disagree with its own
  // `durationMs` and with the audio, which is mixed to the plan's total to the sample: three
  // quarters of a second at 10 fps is seven and a half frames, and rounding that up to eight whole
  // ones is fifty milliseconds of video with no sound under it.
  const frames = Math.max(1, Math.ceil(plan.totalUs / frameUs));
  const frameSeconds = 1 / fps;
  let poster: Blob | null = null;
  let posterCut = false;
  let reported = FRAMES_FROM;

  for (let index = 0; index < frames; index++) {
    throwIfAborted(options.signal);
    const atUs = Math.round(index * frameUs);

    const draws: LayerDraw[] = [];

    // The base track. A moment past its last clip draws nothing and the frame is black - the same
    // picture the native engines leave when a layer outlasts what is under it.
    const baseIndex = clipIndexAt(plan, atUs);
    if (baseIndex >= 0) {
      const clip = plan.clips[baseIndex];
      const startUs = plan.prefixOutUs[baseIndex] ?? 0;
      if (clip) {
        // The base track's picture is placed by its `rect` INSIDE the whole frame rather than by a
        // destination of its own, so the angle comes off the clip; the painter turns it about that
        // same rectangle's centre either way.
        const draw = await layerDraw(layers, 'base', clip, atUs - startUs, frameSeconds, WHOLE_FRAME, 1, clip.clip.rect?.rotationDeg ?? 0);
        if (draw) draws.push(draw);
      }
    }

    // ...then every extra layer, bottom to top, each one placed by its own rectangle.
    for (const track of plan.tracks) {
      const visible = visibleIndexAt(track, atUs);
      if (visible < 0) continue;
      const clip = track.clips[visible];
      const placement = track.placements[visible];
      if (!clip || !placement) continue;
      const draw = await layerDraw(layers, track.id, clip, atUs - placement.startUs, frameSeconds, placement.rect, track.opacity, placement.rect.rotationDeg ?? 0);
      if (draw) draws.push(draw);
    }

    painter.paintLayers(draws);

    // Manifest order is drawing order, which the plan preserved.
    for (const overlay of plan.overlays) {
      if (atUs < overlay.startUs || atUs >= overlay.endUs) continue;
      const bitmap = await overlays.get(overlay.id, overlay.png);
      if (!bitmap) continue;
      painter.paintOverlay({
        bitmap,
        cx: overlay.cx,
        cy: overlay.cy,
        wPx: overlay.wPx,
        hPx: overlay.hPx,
        rotationDeg: overlay.rotationDeg,
        opacity: overlay.opacity,
      });
    }
    overlays.retire(plan, atUs);

    if (!posterCut && atUs >= plan.posterAtUs) {
      posterCut = true;
      poster = await toJpeg(painter.frame);
    }

    // The last frame is only as long as there is timeline left for it.
    const holdUs = Math.max(1, Math.min(frameUs, plan.totalUs - atUs));
    await guard(() => sink.addFrame(atUs, holdUs), 'encoder');

    const progress = FRAMES_FROM + ((index + 1) / frames) * (FRAMES_TO - FRAMES_FROM);
    if (progress - reported >= PROGRESS_STEP) {
      reported = progress;
      options.onProgress(progress);
    }
  }

  // A spec whose poster time fell past the last frame still gets one: the last frame drawn is a
  // frame of this video, and an empty poster is a broken thumbnail in the feed.
  if (!posterCut) poster = await toJpeg(painter.frame);
  return poster;
}

/** One layer's source frame, seeked and ready to draw, or null when its file would not open. */
async function layerDraw(
  layers: LayerReaders,
  layerId: string,
  clip: PlannedClip,
  offsetUs: number,
  frameSeconds: number,
  dest: ComposeRect,
  opacity: number,
  rotationDeg: number,
): Promise<LayerDraw | null> {
  const reader = await layers.reader(layerId, clip.clip.uri, clip.clip.key);
  await reader.seek(sourceTimeUs(clip, Math.max(0, offsetUs)) / 1_000_000, frameSeconds);
  if (reader.width <= 0 || reader.height <= 0) return null;
  return {
    source: reader.video,
    sourceWidth: reader.width,
    sourceHeight: reader.height,
    // An extra layer's `rect` became its destination when the plan was built and was taken off the
    // clip, so what is left here is the crop and the fit - which is the whole of the difference
    // between a clip on the base track and one on a layer.
    framing: { fit: clip.clip.fit, crop: clip.clip.crop, rect: clip.clip.rect },
    dest,
    opacity,
    rotationDeg,
  };
}

/**
 * Every distinct input, opened once to find out what it is.
 *
 * The plan needs real durations before it can lay anything out - a manifest may carry a length read
 * before the file was trimmed - and it needs to know which files have sound so the mixer does not
 * try to decode audio out of a silent screen recording. Serially, one file at a time: ten `<video>`
 * elements opened at once is exactly how a phone runs out of decoders.
 */
async function probeInputs(spec: ComposeSpec, signal: AbortSignal): Promise<Map<string, ProbedInput>> {
  const uris = new Set<string>();
  for (const clip of spec.clips) uris.add(clip.uri);
  for (const track of spec.tracks ?? []) for (const clip of track.clips) uris.add(clip.uri);

  const probes = new Map<string, ProbedInput>();
  for (const uri of uris) {
    throwIfAborted(signal);
    try {
      probes.set(uri, await probeMedia(uri));
    } catch (error) {
      const clip = spec.clips.find(candidate => candidate.uri === uri) ?? (spec.tracks ?? []).flatMap(track => track.clips).find(candidate => candidate.uri === uri);
      throw new RenderFailure('unreadable_input', describe(error), clip?.key);
    }
  }
  return probes;
}

/**
 * One `<video>` per LAYER, re-pointed when that layer's clip changes.
 *
 * A post of ten clips is ten files and one decoder, because the clips play one after another and
 * only one of them is on screen at a time. A clip split into six segments does not even cost a
 * re-open: the URI has not changed, so the same element seeks on.
 */
class LayerReaders {
  private readonly open = new Map<string, { uri: string; reader: FrameReader }>();

  async reader(layerId: string, uri: string, clipKey: string): Promise<FrameReader> {
    const current = this.open.get(layerId);
    if (current && current.uri === uri) return current.reader;
    current?.reader.close();
    this.open.delete(layerId);
    try {
      const reader = await FrameReader.open(uri);
      this.open.set(layerId, { uri, reader });
      return reader;
    } catch (error) {
      throw new RenderFailure('unreadable_input', describe(error), clipKey);
    }
  }

  close(): void {
    for (const entry of this.open.values()) entry.reader.close();
    this.open.clear();
  }
}

/**
 * Overlay bitmaps, decoded when their window opens and released when it closes.
 *
 * Thirty full-frame effect layers at output scale is over a hundred megabytes of decoded pixels,
 * which a phone does not have - and never needs to, because an overlay that is not on screen is not
 * being drawn. Holding only what is visible is the same budget the native engines keep, arrived at
 * from the other direction.
 */
class OverlayBitmaps {
  private readonly bitmaps = new Map<string, ImageBitmap | HTMLImageElement>();

  async get(id: string, png: string): Promise<ImageBitmap | HTMLImageElement | null> {
    const existing = this.bitmaps.get(id);
    if (existing) return existing;
    try {
      const bitmap = await decodeImage(png);
      this.bitmaps.set(id, bitmap);
      return bitmap;
    } catch {
      // One layer that will not decode is one layer missing from the post, not a post that cannot
      // be made. The spec already refused anything that is not a PNG data URL.
      return null;
    }
  }

  /** Lets go of every bitmap whose window has closed. */
  retire(plan: RenderPlan, atUs: number): void {
    if (this.bitmaps.size === 0) return;
    for (const overlay of plan.overlays) {
      if (atUs < overlay.endUs) continue;
      const bitmap = this.bitmaps.get(overlay.id);
      if (!bitmap) continue;
      this.bitmaps.delete(overlay.id);
      if ('close' in bitmap) bitmap.close();
    }
  }

  close(): void {
    for (const bitmap of this.bitmaps.values()) if ('close' in bitmap) bitmap.close();
    this.bitmaps.clear();
  }
}

/* -------------------------------------------------------------------------------------------- */

/**
 * Runs a step and turns whatever it throws into a `RenderFailure` with a code the contract knows.
 *
 * A cancel keeps its own code whatever step it landed in, and a `RenderFailure` thrown deeper down -
 * an unreadable clip, say - passes through with the clip key it already carries rather than being
 * relabelled by the step it happened to surface in.
 */
async function guard<T>(run: () => Promise<T>, code: ComposeFailureCode): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof RenderFailure) throw error;
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new RenderFailure('cancelled', 'cancelled by caller');
    }
    if (error instanceof DOMException && error.name === 'QuotaExceededError') {
      throw new RenderFailure('no_space', 'this browser has no room left for the video');
    }
    throw new RenderFailure(code, describe(error));
  }
}

/** The poster, as a JPEG. Null where the canvas would not give one - a tainted canvas, mostly. */
function toJpeg(canvas: HTMLCanvasElement): Promise<Blob | null> {
  return new Promise(resolve => {
    try {
      canvas.toBlob(blob => resolve(blob), 'image/jpeg', 0.85);
    } catch {
      resolve(null);
    }
  });
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new RenderFailure('cancelled', 'cancelled by caller');
}
