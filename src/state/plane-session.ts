import { isConvexQuad, quadArea, quadMiddle } from '../editor/homography';
import type { LumaFrame } from '../editor/object-tracker';
import { coastLost, MAX_TRACK_SAMPLES } from '../editor/overlay-track';
import { PlaneTracker, type PlaneTrackerState } from '../editor/plane-tracker';
import type { SurfaceRunResult } from '../editor/surface';
import { openTrackFrames, TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';

import { BACK_CHUNK_MS } from './track-session';

/**
 * One surface run: a flat surface - its four corners put on one frame - followed through a stretch of its
 * footage by [PlaneTracker], from that frame on to the end of the stretch and back to its start. What
 * `track-session.ts` is for a thing in a box, and read the same way: on as it plays, back in short
 * stretches each decoded forwards and followed backwards, the preview told about every frame as it goes
 * ([PlaneRunLive]), a stop heard between any two frames, and what was found so far there to keep at any
 * moment ([PlaneRun.found]).
 *
 * The tracker runs here, on the page's own thread, a frame at a time, handing the thread back to the screen
 * once a slice of work has run: no worker carries it yet, and a frame costs a few milliseconds.
 */

/** What a surface run is asked to follow. */
export interface PlaneRunRequest {
  uri: string;
  clipId: string;
  clipKey: string;
  /** SOURCE ms of the frame the corners were put on. */
  anchorMs: number;
  /** The four corners on that frame, as fractions of the oriented source: x0, y0, ... top-left, top-right, bottom-right, bottom-left. */
  corners: readonly number[];
  /** The SOURCE stretch to follow the surface through, with the anchor inside it. */
  fromMs: number;
  toMs: number;
  /** Both ways from the anchor, or only on from it. */
  direction: 'both' | 'forward';
}

/** What the preview shows while a surface run goes: the frame being read, and where the surface is in it. */
export interface PlaneRunLive {
  /** 0..1 of the whole run. */
  progress: number;
  frame: { width: number; height: number; luma: Uint8Array };
  /** The surface's corners in that frame, as fractions of the source. */
  corners: number[];
  lost: boolean;
  sourceMs: number;
  /** The way the surface's middle has come this pass, oldest first, as fractions of the source. */
  trail: readonly { x: number; y: number; lost: boolean }[];
}

/** How a surface run ended. */
export interface PlaneRunOutcome {
  /** The surface's path, or null when there was nothing to follow: a blank surface, or footage that would not read. */
  result: SurfaceRunResult | null;
  /** Stopped by the caller; [result] holds what was found up to then. */
  stopped: boolean;
}

/** A surface run under way. */
export interface PlaneRun {
  /** What the run has found so far, there and then: what a stop keeps. Null before the first frame, and for a blank surface. */
  found(): SurfaceRunResult | null;
  /** How it ended, once it has let go of its footage. Rejects when the footage would not open at all. */
  readonly done: Promise<PlaneRunOutcome>;
}

/** Work done before the thread is handed back to the screen. */
const SLICE_MS = 12;

interface Sample {
  t: number;
  state: PlaneTrackerState;
}

interface FrameShape {
  width: number;
  height: number;
  aspect: number;
}

/** [startPlaneRun], waited out. */
export function runPlane(
  request: PlaneRunRequest,
  onLive: (live: PlaneRunLive) => void,
  signal: AbortSignal,
  open: (uri: string) => Promise<TrackFrameSource> = openTrackFrames,
): Promise<PlaneRunOutcome> {
  return startPlaneRun(request, onLive, signal, open).done;
}

/** Follows the surface `request` names through its stretch, telling `onLive` about every frame. */
export function startPlaneRun(
  request: PlaneRunRequest,
  onLive: (live: PlaneRunLive) => void,
  signal: AbortSignal,
  open: (uri: string) => Promise<TrackFrameSource> = openTrackFrames,
): PlaneRun {
  const forward: Sample[] = [];
  const backward: Sample[] = [];
  let shape: FrameShape | null = null;
  const found = (): SurfaceRunResult | null => {
    if (!shape || forward.length === 0 || forward[0]!.state.lost) return null;
    const samples: Sample[] = [];
    for (let i = backward.length - 1; i >= 0; i--) samples.push(backward[i]!);
    return resultOf(request, shape, samples.concat(forward));
  };
  const done = (async (): Promise<PlaneRunOutcome> => {
    const source = await open(request.uri);
    shape = { width: source.width, height: source.height, aspect: source.aspect };
    const stopped = await follow(request, source, onLive, signal, forward, backward);
    return { result: found(), stopped };
  })();
  return { found, done };
}

/** Both passes over `source`, into `forward` and `backward`; whether the caller stopped them. Closes `source`. */
async function follow(
  request: PlaneRunRequest,
  source: TrackFrameSource,
  onLive: (live: PlaneRunLive) => void,
  signal: AbortSignal,
  forward: Sample[],
  backward: Sample[],
): Promise<boolean> {
  const yielder = new Yielder();
  const heard = (): void => {
    if (signal.aborted) throw new TrackStoppedError('stopped');
  };
  try {
    const { width: W, height: H } = source;
    // Into the tracker's pixels, where pixel x's middle is at x.
    const corners = request.corners.map((v, k) => v * (k % 2 === 0 ? W : H) - 0.5);
    const span = Math.max(1, request.toMs - request.fromMs);
    const forwardShare = request.direction === 'both' ? Math.max(0.05, (request.toMs - request.anchorMs) / span) : 1;
    const lumaFrame = (frame: TrackFrame): LumaFrame => ({ width: W, height: H, data: frame.luma });
    let trail: { x: number; y: number; lost: boolean }[] = [];
    const toLive = (frame: TrackFrame, state: PlaneTrackerState, progress: number): PlaneRunLive => {
      const at = fractionsOf(state.corners, W, H);
      const middle = quadMiddle(at) ?? { x: (at[0]! + at[4]!) / 2, y: (at[1]! + at[5]!) / 2 };
      trail.push({ x: middle.x, y: middle.y, lost: state.lost });
      return { progress: Math.min(1, Math.max(0, progress)), frame: { width: W, height: H, luma: frame.luma }, corners: at, lost: state.lost, sourceMs: frame.timeMs, trail };
    };

    let stopped = false;
    const on = new PlaneTracker();
    try {
      for await (const frame of source.frames(request.anchorMs, request.toMs, signal)) {
        heard();
        const state = forward.length === 0 ? on.start(lumaFrame(frame), corners) : on.step(lumaFrame(frame));
        forward.push({ t: frame.timeMs, state });
        const done = (frame.timeMs - request.anchorMs) / Math.max(1, request.toMs - request.anchorMs);
        onLive(toLive(frame, state, forwardShare * done));
        // A surface with nothing on it to hold is a run with nothing to find.
        if (forward[0]!.state.lost) break;
        await yielder.maybe();
      }
    } catch (error) {
      if (!(error instanceof TrackStoppedError)) throw error;
      stopped = true;
    }
    if (forward.length === 0 || forward[0]!.state.lost) return stopped;

    // Back from it, a stretch at a time, with a trail of its own.
    if (!stopped && request.direction === 'both' && request.anchorMs > request.fromMs) {
      trail = [];
      const back = new PlaneTracker();
      let started = false;
      try {
        let end = request.anchorMs;
        while (end > request.fromMs) {
          const start = Math.max(request.fromMs, end - BACK_CHUNK_MS);
          const chunk: TrackFrame[] = [];
          for await (const frame of source.frames(start, end, signal)) {
            heard();
            chunk.push(frame);
          }
          if (chunk.length === 0) break;
          for (let i = chunk.length - 1; i >= 0; i--) {
            heard();
            const frame = chunk[i]!;
            if (!started) {
              // The anchor frame, which the run on already holds: here it only starts the tracker.
              back.start(lumaFrame(frame), corners);
              started = true;
              continue;
            }
            const state = back.step(lumaFrame(frame));
            backward.push({ t: frame.timeMs, state });
            const done = (request.anchorMs - frame.timeMs) / Math.max(1, request.anchorMs - request.fromMs);
            onLive(toLive(frame, state, forwardShare + (1 - forwardShare) * done));
            await yielder.maybe();
          }
          // The next stretch ends on the frame before this one's first.
          const first = chunk[0]!.timeMs;
          if (!(first < end) || first <= request.fromMs) break;
          end = first - 0.5;
          chunk.length = 0;
        }
      } catch (error) {
        if (!(error instanceof TrackStoppedError)) throw error;
        stopped = true;
      }
    }
    return stopped;
  } finally {
    source.close();
  }
}

/** Tracker pixels as fractions of a `width` by `height` frame. */
function fractionsOf(corners: readonly number[], width: number, height: number): number[] {
  return corners.map((v, k) => (v + 0.5) / (k % 2 === 0 ? width : height));
}

/**
 * The samples as a surface's path: in time order, at most [MAX_TRACK_SAMPLES] of them, its corners as
 * fractions of the source - carried along through every lost stretch corner by corner as [coastLost] carries
 * a thing's middle, a quad that comes out folded holding the nearest one that did not - and from the corners
 * its middle (where the diagonals cross), its size against the anchor's (the square root of the areas'
 * ratio) and its turn (its top edge's against the anchor's). Lost frames are spans, unsure ones under 100.
 */
function resultOf(request: PlaneRunRequest, source: FrameShape, samples: Sample[]): SurfaceRunResult {
  const every = Math.max(1, Math.ceil(samples.length / MAX_TRACK_SAMPLES));
  const kept: Sample[] = [];
  for (let i = 0; i < samples.length; i += every) {
    const sample = samples[i]!;
    const t = Math.round(sample.t);
    if (kept.length > 0 && !(t > Math.round(kept[kept.length - 1]!.t))) continue;
    kept.push(sample);
  }
  const lost: number[] = [];
  let lostFrom = -1;
  kept.forEach((sample, i) => {
    const t = Math.round(sample.t);
    if (sample.state.lost && lostFrom < 0) lostFrom = t;
    if (lostFrom >= 0 && (i === kept.length - 1 || !kept[i + 1]!.state.lost)) {
      lost.push(lostFrom, Math.max(t, lostFrom + 1));
      lostFrom = -1;
    }
  });
  const atMs = kept.map(s => Math.round(s.t));
  const sure = kept.map(s => (s.state.lost ? 0 : Math.round(Math.min(1, Math.max(0, s.state.confidence)) * 100)));
  const quads = kept.map(s => fractionsOf(s.state.corners, source.width, source.height));
  const anchorMs = Math.round(request.anchorMs);
  if (lost.length > 0) {
    const seen = (i: number): boolean => !kept[i]!.state.lost;
    for (let k = 0; k < 4; k++) {
      const coasted = coastLost(
        { atMs, x: quads.map(q => q[2 * k]!), y: quads.map(q => q[2 * k + 1]!), scale: atMs.map(() => 1), turn: atMs.map(() => 0), sure, lost, anchorMs },
        seen,
      );
      quads.forEach((q, i) => {
        q[2 * k] = coasted.x[i]!;
        q[2 * k + 1] = coasted.y[i]!;
      });
    }
  }
  // Square pixels, where a fold and an area mean what they look like.
  const metric = (q: readonly number[]): number[] => q.map((v, k) => (k % 2 === 0 ? v * source.aspect : v));
  const good = quads.map(q => isConvexQuad(metric(q)));
  for (let i = 0; i < quads.length; i++) {
    if (good[i]) continue;
    let j = -1;
    for (let d = 1; d < quads.length && j < 0; d++) {
      if (i - d >= 0 && good[i - d]) j = i - d;
      else if (i + d < quads.length && good[i + d]) j = i + d;
    }
    if (j >= 0) quads[i] = [...quads[j]!];
  }
  const round5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;
  // The anchor's own sample, which the corners were put on: the last frame on screen at or before it.
  let anchor = 0;
  for (let i = 0; i < atMs.length; i++) if (atMs[i]! <= anchorMs) anchor = i;
  const first = metric(quads[anchor] ?? quads[0]!);
  const area0 = Math.abs(quadArea(first)) || 1;
  const angle0 = Math.atan2(first[3]! - first[1]!, first[2]! - first[0]!);
  const x: number[] = [];
  const y: number[] = [];
  const scale: number[] = [];
  const turn: number[] = [];
  let last = 0;
  for (const q of quads) {
    const middle = quadMiddle(q) ?? { x: (q[0]! + q[2]! + q[4]! + q[6]!) / 4, y: (q[1]! + q[3]! + q[5]! + q[7]!) / 4 };
    const m = metric(q);
    let degrees = ((Math.atan2(m[3]! - m[1]!, m[2]! - m[0]!) - angle0) * 180) / Math.PI;
    while (degrees - last > 180) degrees -= 360;
    while (degrees - last < -180) degrees += 360;
    last = degrees;
    x.push(round5(middle.x));
    y.push(round5(middle.y));
    scale.push(Math.max(0.05, Math.round(Math.sqrt(Math.abs(quadArea(m)) / area0) * 1e4) / 1e4));
    turn.push(Math.round(degrees * 100) / 100 + 0);
  }
  const start = quads[anchor] ?? quads[0]!;
  const xs = [start[0]!, start[2]!, start[4]!, start[6]!];
  const ys = [start[1]!, start[3]!, start[5]!, start[7]!];
  return {
    clipId: request.clipId,
    clipKey: request.clipKey,
    aspect: source.aspect,
    box: { w: Math.max(0.002, Math.max(...xs) - Math.min(...xs)), h: Math.max(0.002, Math.max(...ys) - Math.min(...ys)) },
    atMs,
    x,
    y,
    scale,
    turn,
    sure,
    lost,
    anchorMs,
    corners: quads.flatMap(q => q.map(round5)),
  };
}

/**
 * Hands the thread back to the page once a slice of work has run: `scheduler.yield` where the WebView has
 * it, a timer otherwise - `track-session.ts`'s.
 */
class Yielder {
  private since = performance.now();

  async maybe(): Promise<void> {
    if (performance.now() - this.since < SLICE_MS) return;
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof scheduler?.yield === 'function') await scheduler.yield();
    else await new Promise<void>(resolve => setTimeout(resolve, 0));
    this.since = performance.now();
  }
}
