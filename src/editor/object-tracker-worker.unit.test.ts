import { describe, expect, it } from 'vitest';

import { ObjectTracker, type LumaFrame, type TrackerBox, type TrackerState } from './object-tracker';
import { TRACKER_WORKER_SOURCE } from './object-tracker-worker';

/*
 * The worker's copy of the tracker, run here: TRACKER_WORKER_SOURCE evaluated by `new Function('self', ...)`
 * with a stand-in for the worker's global, whose `postMessage` keeps the answers. Every message is cloned
 * as a real post clones it, transfers included, so what goes in and what comes back is what a page and a
 * worker would see. Over the same frames it has to answer exactly what the tracker answers on this
 * thread: a run can follow its frames in the worker only because the two cannot be told apart.
 *
 * Whether the string is the tracker as it is now is build/object-tracker-worker.unit.test.ts's question.
 */

/** A phone's preview copy, as the run reads it: 512 by 288. */
const W = 512;
const H = 288;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Smooth noise: the hash on a `cell`-pixel grid, eased between grid points. */
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

interface Pose {
  cx: number;
  cy: number;
  /** Half the side, in pixels. */
  half: number;
  /** Clockwise degrees. */
  angle: number;
}

/** One frame: the background panned by `pan`, the thing at `pose` over it, and a flat band across both when `hidden`. */
function frame(pose: Pose, pan: number, hidden: boolean): LumaFrame {
  const data = new Uint8Array(W * H);
  const rad = (pose.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      if (hidden && y >= 80 && y < 210) {
        data[y * W + x] = 90;
        continue;
      }
      const u = ((x - pose.cx) * cos + (y - pose.cy) * sin) / pose.half;
      const v = (-(x - pose.cx) * sin + (y - pose.cy) * cos) / pose.half;
      const cover = Math.min(1, Math.max(0, (1 - Math.max(Math.abs(u), Math.abs(v))) * pose.half + 0.5));
      const back = 40 + 120 * noise(x + pan, y, 7, 14) + 50 * noise(x + pan, y, 11, 5);
      const s = (Math.max(-1, Math.min(1, u)) + 1) * 40;
      const t = (Math.max(-1, Math.min(1, v)) + 1) * 40;
      const thing = 20 + 80 * noise(s, t, 3, 22) + 60 * noise(s, t, 5, 9) + 40 * noise(s, t, 9, 4);
      data[y * W + x] = cover * thing + (1 - cover) * back;
    }
  }
  return { width: W, height: H, data };
}

/** A square drifting right and down over a panning background, growing a little and turning, out of sight for a while halfway. */
const POSES: Pose[] = Array.from({ length: 44 }, (_, i) => ({ cx: 150 + 4 * i, cy: 110 + 1.5 * i, half: 30 * Math.pow(1.002, i), angle: 0.2 * i }));
const FRAMES = POSES.map((pose, i) => frame(pose, 2 * i, i >= 18 && i < 24));

function boxAt(i: number): TrackerBox {
  const pose = POSES[i]!;
  return { cx: pose.cx, cy: pose.cy, w: 2 * pose.half, h: 2 * pose.half };
}

interface Answer {
  run: number;
  seq: number;
  state?: TrackerState;
  error?: string;
  data?: Uint8Array;
}

/** The worker's script, started on a stand-in for the worker's global. */
function startWorker(): { post(message: object, transfer?: Transferable[]): void; answers: Answer[] } {
  const answers: Answer[] = [];
  const self = {
    onmessage: null as ((event: { data: unknown }) => void) | null,
    postMessage(message: unknown, transfer: Transferable[] = []): void {
      answers.push(structuredClone(message, { transfer }) as Answer);
    },
  };
  (new Function('self', TRACKER_WORKER_SOURCE) as (self: unknown) => void)(self);
  return {
    answers,
    post(message, transfer = []) {
      self.onmessage!({ data: structuredClone(message, { transfer }) });
    },
  };
}

/** `frame` as the page posts it: its pixels copied, and the copy handed over. */
function sent(frame: LumaFrame): { frame: { width: number; height: number; data: Uint8Array }; transfer: Transferable[] } {
  const data = Uint8Array.from(frame.data);
  return { frame: { width: frame.width, height: frame.height, data }, transfer: [data.buffer] };
}

/** `frames` posted to `worker` as run `run`, started on `box`. */
function follow(worker: ReturnType<typeof startWorker>, run: number, frames: readonly LumaFrame[], box: TrackerBox): void {
  frames.forEach((f, i) => {
    const { frame, transfer } = sent(f);
    worker.post(i === 0 ? { op: 'start', run, frame, box } : { op: 'step', run, frame }, transfer);
  });
}

/** The tracker over `frames` on this thread. */
function here(frames: readonly LumaFrame[], box: TrackerBox): TrackerState[] {
  const tracker = new ObjectTracker();
  return frames.map((f, i) => (i === 0 ? tracker.start(f, box) : tracker.step(f)));
}

describe('the tracker worker', () => {
  it('answers every frame exactly as the tracker does on this thread, numbered within its run', () => {
    const expected = here(FRAMES, boxAt(0));
    // Followed, lost under the band and found again: every way the tracker has of answering is compared.
    expect(expected.map(state => (state.lost ? 'lost' : 'seen'))).toEqual(FRAMES.map((_, i) => (i >= 18 && i < 24 ? 'lost' : 'seen')));

    const worker = startWorker();
    follow(worker, 1, FRAMES, boxAt(0));
    expect(worker.answers.map(answer => answer.error)).toEqual(FRAMES.map(() => undefined));
    expect(worker.answers.map(answer => [answer.run, answer.seq])).toEqual(FRAMES.map((_, i) => [1, i]));
    expect(worker.answers.map(answer => answer.state)).toEqual(expected);
  });

  it('hands each frame’s pixels back as they went in, for the page to fill with the next', () => {
    const worker = startWorker();
    const { frame, transfer } = sent(FRAMES[0]!);
    worker.post({ op: 'start', run: 3, frame, box: boxAt(0) }, transfer);
    // Handed over whole: the page's copy is gone from the page...
    expect(frame.data.byteLength).toBe(0);
    // ... and comes back with the answer, unchanged.
    const back = worker.answers[0]!.data!;
    expect(back.length).toBe(W * H);
    expect(back).toEqual(Uint8Array.from(FRAMES[0]!.data));
  });

  it('keeps runs apart by their ids, and lets one go when it ends', () => {
    const on = FRAMES.slice(0, 14);
    const back = FRAMES.slice(0, 14).reverse();
    const runs = [
      { run: 1, frames: on, box: boxAt(0) },
      { run: 2, frames: back, box: boxAt(13) },
    ];
    const worker = startWorker();
    // A frame of one run, then a frame of the other: the worker keeps each run's tracker to itself.
    for (let i = 0; i < on.length; i++) {
      for (const { run, frames, box } of runs) {
        const { frame, transfer } = sent(frames[i]!);
        worker.post(i === 0 ? { op: 'start', run, frame, box } : { op: 'step', run, frame }, transfer);
      }
    }
    expect(worker.answers.filter(answer => answer.run === 1).map(answer => answer.state)).toEqual(here(on, boxAt(0)));
    expect(worker.answers.filter(answer => answer.run === 2).map(answer => answer.state)).toEqual(here(back, boxAt(13)));

    // Ended, the run is gone: a frame for it is answered with an error, not thrown.
    worker.post({ op: 'end', run: 1 });
    const { frame, transfer } = sent(FRAMES[14]!);
    worker.post({ op: 'step', run: 1, frame }, transfer);
    expect(worker.answers.at(-1)).toEqual({ run: 1, seq: -1, error: 'a run was stepped before it started' });
  });
});
