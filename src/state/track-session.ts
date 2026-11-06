import { ObjectTracker, type LumaFrame, type TrackerBox, type TrackerState } from '../editor/object-tracker';
import { TRACKER_WORKER_SOURCE } from '../editor/object-tracker-worker';
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
 * The tracker runs in a worker where the WebView lets one be made ([RunTrackers]), so the page's own
 * thread only reads the footage, a frame ahead: it decodes the next frame while the worker follows the
 * last. Where none can be, the tracker runs here, a frame at a time, handing the thread back between
 * frames so the screen keeps drawing. Either way the answers are the same, and Stop is heard between
 * any two frames.
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
  const trackers = new RunTrackers(signal);
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

    // On from the anchor, a frame ahead: frame N goes to the tracker, N+1 is read from the footage while N
    // is followed, and only then is N's answer waited for, so a worker follows while this thread decodes.
    // A frame followed here is done with before the next is asked for, as it always was.
    let stopped = false;
    const on = trackers.pass(box);
    const frames = source.frames(request.anchorMs, request.toMs, signal);
    let ahead: Promise<IteratorResult<TrackFrame>> | null = null;
    try {
      let next = await frames.next();
      while (!next.done) {
        heard();
        const frame = next.value;
        const reading = on.read(lumaFrame(frame));
        ahead = frames.next();
        // Met where it is waited for, below; this only keeps a failure that lands first from reading as unhandled.
        ahead.catch(() => undefined);
        const state = await reading;
        if (!on.here) yielder.handedBack();
        forward.push({ t: frame.timeMs, state });
        const done = (frame.timeMs - request.anchorMs) / Math.max(1, request.toMs - request.anchorMs);
        onLive(toLive(frame, state, forwardShare * done));
        if (rejoined(frame.timeMs, state)) break;
        await yielder.maybe();
        next = await ahead;
        ahead = null;
      }
    } catch (error) {
      if (!(error instanceof TrackStoppedError)) throw error;
      stopped = true;
    } finally {
      on.end();
      await letGo(frames, ahead);
    }
    if (forward.length === 0 || forward[0]!.state.lost) return stopped;

    // Back from it, a stretch at a time, with a trail of its own.
    if (!stopped && request.direction === 'both' && request.anchorMs > request.fromMs) {
      trail = [];
      agreed = 0;
      const back = trackers.pass(box);
      try {
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
            const state = await back.read(lumaFrame(frame));
            if (!back.here) yielder.handedBack();
            if (!started) {
              // The anchor frame, which the run on already holds: here it only starts the tracker.
              started = true;
              continue;
            }
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
      } finally {
        back.end();
      }
    }

    return stopped;
  } finally {
    trackers.close();
    source.close();
  }
}

/**
 * Lets go of a pass's reading of the footage, as leaving a `for await` does: once the frame being read
 * ahead has landed, since a reading is let go between frames and not in the middle of one.
 */
async function letGo(frames: AsyncGenerator<TrackFrame>, ahead: Promise<unknown> | null): Promise<void> {
  if (ahead) await ahead.catch(() => undefined);
  await frames.return(undefined);
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

  /** Starts the slice again: the thread was handed back meanwhile, while a worker followed a frame. */
  handedBack(): void {
    this.since = performance.now();
  }

  async maybe(): Promise<void> {
    if (performance.now() - this.since < SLICE_MS) return;
    const scheduler = (globalThis as { scheduler?: { yield?: () => Promise<void> } }).scheduler;
    if (typeof scheduler?.yield === 'function') await scheduler.yield();
    else await new Promise<void>(resolve => setTimeout(resolve, 0));
    this.since = performance.now();
  }
}

/** How long a new worker may take over its first frame before the run carries on without it. */
const FIRST_ANSWER_MS = 3000;

/** The worker's answer to a frame: where the thing is in it, or what stopped the tracker. */
interface Answer {
  run: number;
  seq: number;
  state?: TrackerState;
  error?: string;
  /** The frame's pixels, handed back to carry the next frame's. */
  data?: Uint8Array<ArrayBuffer>;
}

/** The frame in the worker, and who waits on its answer. */
interface Waiting {
  pass: PassTracker;
  seq: number;
  /** The frame itself, not the copy sent: what a pass's first frame is started on here if the worker fails. */
  frame: LumaFrame;
  resolve: (state: TrackerState) => void;
  reject: (error: unknown) => void;
}

/**
 * Where a run's frames are followed: in a worker where the WebView lets one be made, so the page's own
 * thread is left to the screen and to reading the footage; on the page's own thread where none can be -
 * no Worker, a content policy that refuses a blob: script, a WebView too old for the script. One worker
 * for the whole run, both passes, let go by [close].
 *
 * The worker runs [TRACKER_WORKER_SOURCE], the tracker's own code generated into a string, since no
 * worker file survives a host app's build (scripts/build-tracker-worker.mjs says why). The answers are
 * the same either way - one tracker, handed the same frames in the same order - so falling back is
 * silent: a worker that cannot be made, that fails on a pass's first frame or that does not answer its
 * first frame at all leaves the rest of the run to this thread, the frame it held followed here instead.
 * Failing later in a pass, it fails the run, as an error in the tracker here would: the frames that
 * pass's tracker has seen are gone, and its next answer depends on them.
 *
 * One frame is in the worker at a time, as a copy, since the preview still draws the frame's own
 * pixels. A stop is heard at once, the frame's answer no longer waited for.
 */
class RunTrackers {
  private worker: Worker | null = null;
  private url: string | null = null;
  private passes = 0;
  private waiting: Waiting | null = null;
  /** Whether the worker has answered a frame, so is up and no longer timed. */
  private answered = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  /** A frame's worth of pixels back from the worker: the next frame's copy goes into it, rather than into a new array each frame. */
  private spare: Uint8Array<ArrayBuffer> | null = null;

  constructor(private readonly signal: AbortSignal) {
    signal.addEventListener('abort', this.onStop);
    if (typeof Worker !== 'function') return;
    try {
      this.url = URL.createObjectURL(new Blob([TRACKER_WORKER_SOURCE], { type: 'text/javascript' }));
      const worker = new Worker(this.url);
      worker.onmessage = event => this.answer(event.data as Answer);
      worker.onerror = event => {
        // The run carries on without it, so this is not an error for the page to report.
        event.preventDefault();
        this.failed(new Error(`the tracker's worker failed: ${event.message}`));
      };
      worker.onmessageerror = () => this.failed(new Error("the tracker's worker answered with something that could not be read"));
      this.worker = worker;
    } catch {
      this.release();
    }
  }

  /** Whether frames go to the worker. */
  get working(): boolean {
    return this.worker !== null;
  }

  /** A tracker for one pass, started on `box` by the first frame handed to it. */
  pass(box: TrackerBox): PassTracker {
    return new PassTracker(this, ++this.passes, box);
  }

  /** Hands `pass`'s frame number `seq` to the worker, for where the thing is in it. */
  send(pass: PassTracker, seq: number, frame: LumaFrame): Promise<TrackerState> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("the tracker's worker stopped part way through a pass"));
    if (this.signal.aborted) return Promise.reject(new TrackStoppedError('stopped'));
    return new Promise<TrackerState>((resolve, reject) => {
      this.waiting = { pass, seq, frame, resolve, reject };
      const data = this.copyOf(frame.data);
      const sent = { width: frame.width, height: frame.height, data };
      try {
        worker.postMessage(seq === 0 ? { op: 'start', run: pass.run, frame: sent, box: pass.box } : { op: 'step', run: pass.run, frame: sent }, [data.buffer]);
      } catch (error) {
        this.failed(error);
        return;
      }
      if (!this.answered && this.timer === null) this.timer = setTimeout(() => this.failed(new Error("the tracker's worker did not answer")), FIRST_ANSWER_MS);
    });
  }

  /** Lets `pass`'s tracker in the worker go. */
  end(pass: PassTracker): void {
    if (this.waiting?.pass === pass) this.waiting = null;
    this.worker?.postMessage({ op: 'end', run: pass.run });
  }

  /** Lets the worker go, once the run is over. */
  close(): void {
    this.signal.removeEventListener('abort', this.onStop);
    this.waiting = null;
    this.release();
  }

  /** A stop, heard at once with a frame in the worker: its answer is no longer waited for. */
  private readonly onStop = (): void => {
    const waiting = this.waiting;
    this.waiting = null;
    waiting?.reject(new TrackStoppedError('stopped'));
  };

  private answer(answer: Answer): void {
    if (answer.data) this.spare = answer.data;
    this.answered = true;
    this.clearTimer();
    const waiting = this.waiting;
    // An answer no longer waited for: a stop let its frame go.
    if (!waiting || answer.run !== waiting.pass.run || (answer.error === undefined && answer.seq !== waiting.seq)) return;
    this.waiting = null;
    if (answer.error !== undefined) waiting.reject(new Error(answer.error));
    else waiting.resolve(answer.state!);
  }

  /**
   * The worker has failed: it is let go, and the rest of the run is followed here. The frame it held is
   * followed here too when it was a pass's first, which is all that pass's tracker had seen; a later one
   * cannot be, and fails the run.
   */
  private failed(error: unknown): void {
    const waiting = this.waiting;
    this.waiting = null;
    this.release();
    if (!waiting) return;
    if (waiting.seq > 0) {
      waiting.reject(error);
      return;
    }
    try {
      waiting.resolve(waiting.pass.startHere(waiting.frame));
    } catch (thrown) {
      waiting.reject(thrown);
    }
  }

  /** `data` copied into the array the worker handed back, or into a new one the first time. */
  private copyOf(data: ArrayLike<number>): Uint8Array<ArrayBuffer> {
    const spare = this.spare;
    this.spare = null;
    const copy = spare && spare.length === data.length ? spare : new Uint8Array(data.length);
    copy.set(data);
    return copy;
  }

  /** Lets the worker and its script's URL go. */
  private release(): void {
    this.clearTimer();
    this.worker?.terminate();
    this.worker = null;
    if (this.url) URL.revokeObjectURL(this.url);
    this.url = null;
  }

  private clearTimer(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
  }
}

/** One pass's tracker: the first frame handed in starts it on [box]. */
class PassTracker {
  /** The tracker on this thread, once the pass is followed here. */
  private local: ObjectTracker | null = null;
  private count = 0;

  constructor(
    private readonly trackers: RunTrackers,
    readonly run: number,
    readonly box: TrackerBox,
  ) {}

  /** Whether the pass's frames are followed on the page's own thread rather than in the worker. */
  get here(): boolean {
    return this.local !== null || !this.trackers.working;
  }

  /** Where the thing is in `frame`, the pass's next. */
  async read(frame: LumaFrame): Promise<TrackerState> {
    const seq = this.count++;
    if (this.local) return this.local.step(frame);
    if (seq === 0 && !this.trackers.working) return this.startHere(frame);
    return this.trackers.send(this, seq, frame);
  }

  /** Starts the pass here, on its first frame. */
  startHere(frame: LumaFrame): TrackerState {
    this.local = new ObjectTracker();
    return this.local.start(frame, this.box);
  }

  /** Lets the pass's tracker go. */
  end(): void {
    this.trackers.end(this);
  }
}
