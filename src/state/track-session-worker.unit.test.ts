import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TRACKER_WORKER_SOURCE } from '../editor/object-tracker-worker';
import { TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';

import { runTrack, startTrackRun, type TrackRun, type TrackRunLive, type TrackRunOutcome, type TrackRunRequest } from './track-session';

/*
 * A run whose tracker is in a worker. The unit environment has no Worker, so a stand-in plays one: it
 * starts on the script the run put in its Blob, read back from the Blob, and runs it on a stand-in for
 * the worker's global, every message cloned - transfers included - and handed over a turn of the event
 * loop later, as a real worker's are. Each run is held to the same run with no Worker to be had, which
 * is the page's own thread: the same answers, and the same frames told to the preview in the same order.
 *
 * The footage is track-session.unit.test.ts's: 30 fps, 180x320, a textured square drifting right and up.
 */

const W = 180;
const H = 320;
const STEP = 1000 / 30;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

function noise(x: number, y: number, seed: number, cell: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash(x0, y0, seed);
  const b = hash(x0 + 1, y0, seed);
  const c = hash(x0, y0 + 1, seed);
  const d = hash(x0 + 1, y0 + 1, seed);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/** Where the thing's middle is at `t` ms, in the tracker's own pixel coordinates. */
function truth(t: number): { x: number; y: number } {
  return { x: 50 + 0.03 * t, y: 200 - 0.012 * t };
}

const HALF = 20;

function render(t: number): Uint8Array {
  const at = truth(t);
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const u = (x - at.x) / HALF;
      const v = (y - at.y) / HALF;
      const cover = Math.min(1, Math.max(0, (1 - Math.max(Math.abs(u), Math.abs(v))) * HALF + 0.5));
      const back = 40 + 120 * noise(x, y, 7, 14) + 50 * noise(x, y, 11, 5);
      const s = (u + 1) * 30;
      const r = (v + 1) * 30;
      const thing = 20 + 90 * noise(s, r, 3, 16) + 70 * noise(s, r, 5, 7) + 50 * noise(s, r, 9, 3);
      out[y * W + x] = cover * thing + (1 - cover) * back;
    }
  }
  return out;
}

function source(): TrackFrameSource & { closed: number } {
  const made = {
    width: W,
    height: H,
    aspect: W / H,
    durationMs: 4000,
    closed: 0,
    async *frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame> {
      for (let k = Math.floor(fromMs / STEP + 1e-9); k * STEP <= toMs + 1e-9; k++) {
        if (signal.aborted) throw new TrackStoppedError('stopped');
        yield { timeMs: k * STEP, luma: render(k * STEP) };
      }
    },
    close() {
      made.closed++;
    },
  };
  return made;
}

function request(overrides: Partial<TrackRunRequest> = {}): TrackRunRequest {
  const at = truth(Math.floor(1000 / STEP + 1e-9) * STEP);
  return {
    uri: 'file:///clip.mp4',
    clipId: 'a',
    clipKey: 'a',
    anchorMs: 1000,
    box: { cx: (at.x + 0.5) / W, cy: (at.y + 0.5) / H, w: (2 * HALF) / W, h: (2 * HALF) / H },
    fromMs: 0,
    toMs: 2000,
    direction: 'both',
    ...overrides,
  };
}

/** What the stand-in does as the run's worker. */
type Behaviour = 'works' | 'refused' | 'broken' | 'silent' | { diesOn: number };

let behaviour: Behaviour = 'works';
/** Told of each message as the worker takes it up, before it is handled: the moment a frame is in the worker. */
let taking: ((n: number) => void) | null = null;
const blobs = new Map<string, Blob>();
const revoked: string[] = [];
const workers: StandInWorker[] = [];

/** A turn of the event loop later, as a message between threads arrives. */
function later(task: () => void): void {
  setTimeout(task, 0);
}

class StandInWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: { message: string; preventDefault(): void }) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminated = false;
  /** Messages posted to it, and frames its script has answered. */
  received = 0;
  answered = 0;
  private readonly started: Promise<((data: unknown) => void) | null>;

  constructor(readonly url: string) {
    if (behaviour === 'refused') throw new Error('Refused to create a worker from a blob: URL: the content security policy forbids it');
    workers.push(this);
    this.started = this.start();
  }

  postMessage(data: unknown, transfer: Transferable[] = []): void {
    // Cloned now, as a post does: what was handed over is gone from the page from here on.
    const message = structuredClone(data, { transfer });
    const n = ++this.received;
    void this.started.then(deliver =>
      later(() => {
        if (this.terminated || !deliver) return;
        taking?.(n);
        if (typeof behaviour === 'object' && n >= behaviour.diesOn) {
          this.onerror?.({ message: 'the worker is gone', preventDefault: () => undefined });
          return;
        }
        deliver(message);
      }),
    );
  }

  terminate(): void {
    this.terminated = true;
  }

  /** The script the run put in its Blob, started; how to hand it a message, or null for a worker that never runs it. */
  private async start(): Promise<((data: unknown) => void) | null> {
    const blob = blobs.get(this.url)!;
    expect(blob.type).toBe('text/javascript');
    const script = await blob.text();
    expect(script).toBe(TRACKER_WORKER_SOURCE);
    if (behaviour === 'silent') return null;
    if (behaviour === 'broken') {
      later(() => this.onerror?.({ message: 'SyntaxError: Unexpected token', preventDefault: () => undefined }));
      return null;
    }
    const self = {
      onmessage: null as ((event: { data: unknown }) => void) | null,
      postMessage: (answer: unknown, transfer: Transferable[] = []): void => {
        this.answered++;
        const cloned = structuredClone(answer, { transfer });
        later(() => {
          if (!this.terminated) this.onmessage?.({ data: cloned });
        });
      },
    };
    (new Function('self', script) as (self: unknown) => void)(self);
    return data => self.onmessage!({ data });
  }
}

/** A frame as the preview was told of it. */
interface Seen {
  progress: number;
  box: TrackRunLive['box'];
  lost: boolean;
  sourceMs: number;
  trail: number;
  luma: Uint8Array;
}

/** A whole run over fresh footage, and every frame the preview was told of. */
async function recorded(overrides: Partial<TrackRunRequest> = {}): Promise<{ outcome: TrackRunOutcome; seen: Seen[]; closed: number }> {
  const footage = source();
  const seen: Seen[] = [];
  const outcome = await runTrack(
    request(overrides),
    live => seen.push({ progress: live.progress, box: { ...live.box }, lost: live.lost, sourceMs: live.sourceMs, trail: live.trail.length, luma: live.frame.luma }),
    new AbortController().signal,
    async () => footage,
  );
  return { outcome, seen, closed: footage.closed };
}

/** The same run with no Worker to be had: what the page's own thread finds. */
async function onThisThread(overrides: Partial<TrackRunRequest> = {}): Promise<{ outcome: TrackRunOutcome; seen: Seen[] }> {
  vi.stubGlobal('Worker', undefined);
  try {
    return await recorded(overrides);
  } finally {
    vi.stubGlobal('Worker', StandInWorker);
  }
}

/** `run` held to `here`: the same path, the same frames shown, the preview drawing the frames' own pixels. */
function same(run: { outcome: TrackRunOutcome; seen: Seen[] }, here: { outcome: TrackRunOutcome; seen: Seen[] }): void {
  expect(run.outcome).toEqual(here.outcome);
  const plain = (seen: Seen[]) => seen.map(({ luma, ...rest }) => ({ ...rest, pixels: luma.byteLength }));
  expect(plain(run.seen)).toEqual(plain(here.seen));
  // Never handed over: the copy went to the worker.
  for (const { luma } of run.seen) expect(luma.byteLength).toBe(W * H);
}

beforeEach(() => {
  behaviour = 'works';
  taking = null;
  blobs.clear();
  revoked.length = 0;
  workers.length = 0;
  let made = 0;
  vi.spyOn(URL, 'createObjectURL').mockImplementation(blob => {
    const url = `blob:tracker/${++made}`;
    blobs.set(url, blob as Blob);
    return url;
  });
  vi.spyOn(URL, 'revokeObjectURL').mockImplementation(url => void revoked.push(url));
  vi.stubGlobal('Worker', StandInWorker);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('runTrack in a worker', () => {
  it('finds exactly what it finds on the page’s own thread, both ways, and lets the worker go at the end', async () => {
    const here = await onThisThread();
    const run = await recorded();
    same(run, here);
    expect(run.outcome.result!.atMs.length).toBe(61);
    // One worker for both passes, which followed every frame: 31 on, and the anchor and 30 back, each
    // pass let go at its end.
    expect(workers.length).toBe(1);
    expect(workers[0]!.answered).toBe(62);
    expect(workers[0]!.received).toBe(64);
    expect(workers[0]!.terminated).toBe(true);
    expect(revoked).toEqual([workers[0]!.url]);
    expect(run.closed).toBe(1);
  });

  it('stops each way where it meets the path it mends, as on the page’s own thread', async () => {
    const askedHere: number[] = [];
    const askedThere: number[] = [];
    const here = await onThisThread({ rejoin: t => askedHere.push(t) > 0 });
    const run = await recorded({ rejoin: t => askedThere.push(t) > 0 });
    same(run, here);
    expect(askedThere).toEqual(askedHere);
    expect(run.outcome.result!.atMs.length).toBeLessThan(61);
  });

  it('hears a stop with a frame still in the worker, and keeps only what it had found by then', async () => {
    const abort = new AbortController();
    let atStop: ReturnType<TrackRun['found']> = null;
    let afterStop = 0;
    const run: TrackRun = startTrackRun(
      request(),
      () => {
        if (abort.signal.aborted) afterStop++;
      },
      abort.signal,
      async () => source(),
    );
    taking = n => {
      // The twelfth frame on, in the worker when Stop is tapped.
      if (n !== 12) return;
      abort.abort();
      atStop = run.found();
    };
    const outcome = await run.done;
    expect(outcome.stopped).toBe(true);
    expect(afterStop).toBe(0);
    expect(outcome.result!.atMs.length).toBe(11);
    expect(outcome.result).toEqual(atStop);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('follows on the page’s own thread, to the same answers, when no worker can be made', async () => {
    behaviour = 'refused';
    const here = await onThisThread();
    const run = await recorded();
    same(run, here);
    expect(workers.length).toBe(0);
    // The script's URL, made before the worker was refused, is let go all the same.
    expect(revoked).toEqual(['blob:tracker/1']);
  });

  it('follows on the page’s own thread, from the frame the worker held, when the worker fails before it answers', async () => {
    behaviour = 'broken';
    const here = await onThisThread();
    const run = await recorded();
    same(run, here);
    expect(workers[0]!.terminated).toBe(true);
    expect(revoked).toEqual([workers[0]!.url]);
  });

  it('follows on the page’s own thread when the worker never answers its first frame', async () => {
    behaviour = 'silent';
    const here = await onThisThread();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    let settled = false;
    const running = recorded().finally(() => {
      settled = true;
    });
    for (let waited = 0; !settled && waited < 60_000; waited += 250) await vi.advanceTimersByTimeAsync(250);
    const run = await running;
    same(run, here);
    expect(workers[0]!.terminated).toBe(true);
  });

  it('fails the run when the worker dies part way through a pass, as an error in the tracker here would', async () => {
    behaviour = { diesOn: 6 };
    const footage = source();
    await expect(runTrack(request(), () => undefined, new AbortController().signal, async () => footage)).rejects.toThrow(/worker/);
    expect(workers[0]!.terminated).toBe(true);
    expect(revoked).toEqual([workers[0]!.url]);
    expect(footage.closed).toBe(1);
  });
});
