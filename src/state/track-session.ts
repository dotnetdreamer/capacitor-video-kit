import { ObjectTracker, type LumaFrame, type TrackerState } from '../editor/object-tracker';
import { coastLost, MAX_TRACK_SAMPLES } from '../editor/overlay-track';
import type { TrackRunResult } from '../editor/track-motion';
import { openTrackFrames, TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';

/**
 * One tracking run: the thing in the box followed through a stretch of its footage, frame by frame,
 * from the frame the box was drawn on - on to the end of the stretch, and back to its start.
 *
 * Read on as it plays; read back in short stretches, each decoded forwards and followed backwards, so a
 * long run holds a couple of seconds of frames at a time and never the whole clip. The preview is told
 * about every frame as it goes ([TrackRunLive]), which is what lets it show the box riding along while
 * the run works.
 *
 * Runs on the page's own thread, a frame at a time, handing the thread back between frames so the
 * screen keeps drawing - which is also what lets Stop be heard.
 */

/** What a run is asked to follow. */
export interface TrackRunRequest {
  uri: string;
  clipId: string;
  clipKey: string;
  /** SOURCE ms of the frame the box was drawn on. */
  anchorMs: number;
  /** The box on that frame, as fractions of the oriented source: its middle and its size. */
  box: { cx: number; cy: number; w: number; h: number };
  /** The SOURCE stretch to follow the thing through, with the anchor inside it. */
  fromMs: number;
  toMs: number;
  /** Both ways from the anchor, or only on from it. */
  direction: 'both' | 'forward';
  /**
   * A mend's test against the path it mends: whether the thing at SOURCE `sourceMs`, its middle at `at`
   * (fractions of the source), is where the old path already had it, and surely. Each pass ends once this
   * has held for [REJOIN_FRAMES] frames in a row - the old path is right from there on, and the mend hands
   * back to it. Absent, a pass runs to its end of the stretch.
   */
  rejoin?: (sourceMs: number, at: { x: number; y: number }) => boolean;
}

/** How many frames in a row a mend's pass must agree with the old path before it hands back to it. */
export const REJOIN_FRAMES = 8;

/** No pass hands back this near the frame the box was put on: the old path was wrong there. */
const REJOIN_AFTER_MS = 250;

/** What the preview shows while a run goes: the frame being read, and where the thing is in it. */
export interface TrackRunLive {
  /** 0..1 of the whole run. */
  progress: number;
  frame: { width: number; height: number; luma: Uint8Array };
  /** Where the thing is in that frame, as fractions of the source, and its size and turn against the anchor's. */
  box: { cx: number; cy: number; w: number; h: number; scale: number; angle: number };
  lost: boolean;
  sourceMs: number;
  /** The way this run has come so far, oldest first, as fractions of the source. */
  trail: readonly { x: number; y: number; lost: boolean }[];
}

/** How a run ended. */
export interface TrackRunOutcome {
  /** The path, or null when there was nothing to follow: a flat box, or footage that would not read. */
  result: TrackRunResult | null;
  /** Stopped by the caller; [result] holds what was found up to then. */
  stopped: boolean;
}

/** A run under way. */
export interface TrackRun {
  /**
   * What the run has found so far, as a path: what a stop keeps, there and then, without waiting for the
   * run to wind down - so a post exported the moment the sheet shuts already has it. Null before the
   * first frame, and when the box held nothing to follow.
   */
  found(): TrackRunResult | null;
  /** How it ended, once it has let go of its footage. Rejects when the footage would not open at all. */
  readonly done: Promise<TrackRunOutcome>;
}

/** The size frames are read at, and the oriented source's width over its height. */
interface FrameShape {
  width: number;
  height: number;
  aspect: number;
}

/** How much footage is held at once while reading back: about sixty frames of a phone's preview copy. */
export const BACK_CHUNK_MS = 2000;

/** Work done before the thread is handed back to the screen. */
const SLICE_MS = 12;

interface Sample {
  t: number;
  state: TrackerState;
}

/** [startTrackRun], waited out. */
export function runTrack(
  request: TrackRunRequest,
  onLive: (live: TrackRunLive) => void,
  signal: AbortSignal,
  open: (uri: string) => Promise<TrackFrameSource> = openTrackFrames,
): Promise<TrackRunOutcome> {
  return startTrackRun(request, onLive, signal, open).done;
}

/**
 * Follows the thing through the stretch `request` names, telling `onLive` about every frame. A stop
 * through `signal` is heard between any two frames of either pass - the frames already read back for the
 * way back included - and the run then settles with what it found.
 */
export function startTrackRun(
  request: TrackRunRequest,
  onLive: (live: TrackRunLive) => void,
  signal: AbortSignal,
  open: (uri: string) => Promise<TrackFrameSource> = openTrackFrames,
): TrackRun {
  // Both passes' samples, kept where [found] can read them at any moment of either.
  const forward: Sample[] = [];
  const backward: Sample[] = [];
  let shape: FrameShape | null = null;
  const found = (): TrackRunResult | null => {
    if (!shape || forward.length === 0 || forward[0]!.state.lost) return null;
    // The way back was walked backwards; oldest first, it is that walk reversed.
    const samples: Sample[] = [];
    for (let i = backward.length - 1; i >= 0; i--) samples.push(backward[i]!);
    return resultOf(request, shape, samples.concat(forward));
  };
  const done = (async (): Promise<TrackRunOutcome> => {
    const source = await open(request.uri);
    shape = { width: source.width, height: source.height, aspect: source.aspect };
    const stopped = await follow(request, source, onLive, signal, forward, backward);
    return { result: found(), stopped };
  })();
  return { found, done };
}

/** Both passes over `source`, into `forward` and `backward`; whether the caller stopped them. Closes `source`. */
async function follow(
  request: TrackRunRequest,
  source: TrackFrameSource,
  onLive: (live: TrackRunLive) => void,
  signal: AbortSignal,
  forward: Sample[],
  backward: Sample[],
): Promise<boolean> {
  const yielder = new Yielder();
  // Heard between frames whether or not the footage hears it: frames read back for the way back are
  // already in hand, and a source need not look at the signal at all.
  const heard = (): void => {
    if (signal.aborted) throw new TrackStoppedError('stopped');
  };
  try {
    const { width: W, height: H } = source;
    const box = { cx: request.box.cx * W - 0.5, cy: request.box.cy * H - 0.5, w: request.box.w * W, h: request.box.h * H };
    const span = Math.max(1, request.toMs - request.fromMs);
    const forwardShare = request.direction === 'both' ? Math.max(0.05, (request.toMs - request.anchorMs) / span) : 1;

    const lumaFrame = (frame: TrackFrame): LumaFrame => ({ width: W, height: H, data: frame.luma });
    // Each pass's way so far, added to a point at a time rather than rebuilt every frame: a long run
    // would otherwise copy its whole path once a frame.
    let trail: { x: number; y: number; lost: boolean }[] = [];
    const toLive = (frame: TrackFrame, state: TrackerState, progress: number): TrackRunLive => {
      trail.push({ x: (state.cx + 0.5) / W, y: (state.cy + 0.5) / H, lost: state.lost });
      return {
        progress: Math.min(1, Math.max(0, progress)),
        frame: { width: W, height: H, luma: frame.luma },
        box: { cx: (state.cx + 0.5) / W, cy: (state.cy + 0.5) / H, w: state.w / W, h: state.h / H, scale: state.scale, angle: state.angle },
        lost: state.lost,
        sourceMs: frame.timeMs,
        trail,
      };
    };

    // Whether a mend's pass has met the old path: REJOIN_FRAMES sightings in a row where the old path agrees.
    let agreed = 0;
    const rejoined = (timeMs: number, state: TrackerState): boolean => {
      const rejoin = request.rejoin;
      if (!rejoin || state.lost || Math.abs(timeMs - request.anchorMs) < REJOIN_AFTER_MS) {
        agreed = 0;
        return false;
      }
      agreed = rejoin(timeMs, { x: (state.cx + 0.5) / W, y: (state.cy + 0.5) / H }) ? agreed + 1 : 0;
      return agreed >= REJOIN_FRAMES;
    };

    // On from the anchor.
    let stopped = false;
    try {
      const tracker = new ObjectTracker();
      for await (const frame of source.frames(request.anchorMs, request.toMs, signal)) {
        heard();
        const luma = lumaFrame(frame);
        const state = forward.length === 0 ? tracker.start(luma, box) : tracker.step(luma);
        forward.push({ t: frame.timeMs, state });
        const done = (frame.timeMs - request.anchorMs) / Math.max(1, request.toMs - request.anchorMs);
        onLive(toLive(frame, state, forwardShare * done));
        if (rejoined(frame.timeMs, state)) break;
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
      agreed = 0;
      try {
        const tracker = new ObjectTracker();
        let end = request.anchorMs;
        let started = false;
        let met = false;
        while (end > request.fromMs && !met) {
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
              tracker.start(lumaFrame(frame), box);
              started = true;
              continue;
            }
            const state = tracker.step(lumaFrame(frame));
            backward.push({ t: frame.timeMs, state });
            const done = (request.anchorMs - frame.timeMs) / Math.max(1, request.anchorMs - request.fromMs);
            onLive(toLive(frame, state, forwardShare + (1 - forwardShare) * done));
            if (rejoined(frame.timeMs, state)) {
              met = true;
              break;
            }
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

/**
 * The samples as a run's path: fractions of the source, in time order, how sure each is, the lost frames as
 * spans - and carried along through those, rather than held where the thing was last seen ([coastLost]).
 */
function resultOf(request: TrackRunRequest, source: FrameShape, samples: Sample[]): TrackRunResult {
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
    const endsHere = lostFrom >= 0 && (i === kept.length - 1 || !kept[i + 1]!.state.lost);
    if (endsHere) {
      lost.push(lostFrom, Math.max(t, lostFrom + 1));
      lostFrom = -1;
    }
  });
  const round5 = (v: number) => Math.round(v * 1e5) / 1e5;
  const run: TrackRunResult = {
    clipId: request.clipId,
    clipKey: request.clipKey,
    aspect: source.aspect,
    box: { w: request.box.w, h: request.box.h },
    atMs: kept.map(s => Math.round(s.t)),
    x: kept.map(s => round5((s.state.cx + 0.5) / source.width)),
    y: kept.map(s => round5((s.state.cy + 0.5) / source.height)),
    scale: kept.map(s => Math.round(s.state.scale * 1e4) / 1e4),
    turn: kept.map(s => Math.round(s.state.angle * 100) / 100),
    sure: kept.map(s => (s.state.lost ? 0 : Math.round(Math.min(1, Math.max(0, s.state.confidence)) * 100))),
    lost,
    anchorMs: Math.round(request.anchorMs),
  };
  return lost.length > 0 ? coastLost(run, i => !kept[i]!.state.lost) : run;
}

/**
 * Hands the thread back to the page once a slice of work has run. `scheduler.yield` where the WebView
 * has it, which hands it back without a timer's four-millisecond floor; a timer otherwise.
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
