import { describe, expect, it } from 'vitest';

import { invertH, quadMiddle, squareToQuad } from '../editor/homography';
import { TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';

import { runPlane, startPlaneRun, type PlaneRunLive, type PlaneRunRequest } from './plane-session';

/*
 * A source made up for the test: 30 fps, 320 by 180, a textured card sliding right and turning away over a
 * textured background, where its four corners are at every frame known exactly.
 */

const W = 320;
const H = 180;
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

/** The card's corners at `t` ms, in the tracker's pixels: 2 by 1.2 units, four units off, 210 px focal length. */
function truth(t: number): number[] {
  const yaw = (t / 1000) * 14;
  const r = (yaw * Math.PI) / 180;
  const shift = (t / 1000) * 0.12;
  return [
    [-1, -0.6],
    [1, -0.6],
    [1, 0.6],
    [-1, 0.6],
  ].flatMap(([x, y]) => {
    const X = x! * Math.cos(r) + shift - 0.15;
    const Z = 4 + x! * Math.sin(r);
    return [W / 2 - 0.5 + (210 * X) / Z, H / 2 - 0.5 + (210 * y!) / Z];
  });
}

function render(t: number, hidden = false, blank = false): Uint8Array {
  const quad = truth(t);
  const back = invertH(squareToQuad(quad)!)!;
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const w = back[6]! * x + back[7]! * y + back[8]!;
      const u = (back[0]! * x + back[1]! * y + back[2]!) / w;
      const v = (back[3]! * x + back[4]! * y + back[5]!) / w;
      const cover = Math.min(1, Math.max(0, Math.min(u, 1 - u, v, 1 - v) * 120 + 0.5));
      const bg = 40 + 110 * noise(x, y, 7, 13) + 45 * noise(x, y, 11, 5);
      const card = blank ? 128 : 25 + 90 * noise(u * 200, v * 120, 3, 17) + 70 * noise(u * 200, v * 120, 5, 7) + 45 * noise(u * 200, v * 120, 9, 3);
      out[y * W + x] = hidden && x > 40 && x < 290 && y > 10 && y < 170 ? 90 : cover * card + (1 - cover) * bg;
    }
  }
  return out;
}

function source(options: { hiddenFrom?: number; hiddenTo?: number; blank?: boolean } = {}): TrackFrameSource & { closed: number } {
  const made = {
    width: W,
    height: H,
    aspect: W / H,
    durationMs: 3000,
    closed: 0,
    async *frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame> {
      for (let k = Math.floor(fromMs / STEP + 1e-9); k * STEP <= toMs + 1e-9; k++) {
        if (signal.aborted) throw new TrackStoppedError('stopped');
        const t = k * STEP;
        const hidden = options.hiddenFrom !== undefined && t >= options.hiddenFrom && t < (options.hiddenTo ?? Infinity);
        yield { timeMs: t, luma: render(t, hidden, options.blank) };
      }
    },
    close() {
      made.closed++;
    },
  };
  return made;
}

function request(overrides: Partial<PlaneRunRequest> = {}): PlaneRunRequest {
  const anchorMs = overrides.anchorMs ?? 600;
  const at = truth(Math.floor(anchorMs / STEP + 1e-9) * STEP);
  return {
    uri: 'file:///clip.mp4',
    clipId: 'a',
    clipKey: 'a',
    anchorMs,
    corners: at.map((v, k) => (v + 0.5) / (k % 2 === 0 ? W : H)),
    fromMs: 0,
    toMs: 1400,
    direction: 'both',
    ...overrides,
  };
}

/** The farthest any corner of sample `i` is from where the card really was, in pixels. */
function cornerError(corners: number[], i: number, t: number): number {
  const real = truth(Math.round(t / STEP) * STEP);
  let most = 0;
  for (let k = 0; k < 4; k++) {
    const x = corners[8 * i + 2 * k]! * W - 0.5;
    const y = corners[8 * i + 2 * k + 1]! * H - 0.5;
    most = Math.max(most, Math.hypot(x - real[2 * k]!, y - real[2 * k + 1]!));
  }
  return most;
}

describe('runPlane', () => {
  it('follows the surface both ways from the frame its corners were put on, corners on every sample', async () => {
    const src = source();
    const lives: PlaneRunLive[] = [];
    const outcome = await runPlane(request(), live => lives.push(live), new AbortController().signal, async () => src);
    const result = outcome.result!;
    expect(outcome.stopped).toBe(false);
    expect(src.closed).toBe(1);
    expect(result.atMs[0]).toBe(0);
    expect(result.atMs.at(-1)).toBe(1400);
    expect(result.corners.length).toBe(8 * result.atMs.length);
    for (let i = 1; i < result.atMs.length; i++) expect(result.atMs[i]!).toBeGreaterThan(result.atMs[i - 1]!);
    result.atMs.forEach((t, i) => expect(cornerError(result.corners, i, t), `corners at ${t}`).toBeLessThan(1.5));
    // Its middle is where the diagonals cross; its size and turn are against the anchor's.
    const anchor = result.atMs.findIndex(t => t === 600);
    expect(result.scale[anchor]).toBe(1);
    expect(result.turn[anchor]).toBe(0);
    const mid = quadMiddle(result.corners.slice(8 * anchor, 8 * anchor + 8))!;
    expect(result.x[anchor]).toBeCloseTo(mid.x, 4);
    expect(result.y[anchor]).toBeCloseTo(mid.y, 4);
    // Turned away, the card's area shrinks: smaller later, bigger earlier.
    expect(result.scale.at(-1)!).toBeLessThan(1);
    expect(result.scale[0]!).toBeGreaterThan(1);
    expect(result.lost).toEqual([]);
    expect(lives.length).toBe(result.atMs.length);
    expect(lives.at(-1)!.progress).toBeCloseTo(1, 1);
    expect(lives[0]!.corners.length).toBe(8);
  });

  it('keeps what it found when it is stopped between frames', async () => {
    const abort = new AbortController();
    let seen = 0;
    const run = startPlaneRun(
      request(),
      () => {
        if (++seen === 8) abort.abort();
      },
      abort.signal,
      async () => source(),
    );
    const outcome = await run.done;
    expect(outcome.stopped).toBe(true);
    expect(outcome.result!.atMs.length).toBe(8);
    expect(run.found()!.corners.length).toBe(64);
  });

  it('finds nothing on a blank surface', async () => {
    const outcome = await runPlane(request(), () => undefined, new AbortController().signal, async () => source({ blank: true }));
    expect(outcome.result).toBeNull();
  });

  it('carries the corners along where the surface was hidden, and says it was not seen there', async () => {
    const outcome = await runPlane(request({ anchorMs: 200, fromMs: 200, toMs: 1400, direction: 'forward' }), () => undefined, new AbortController().signal, async () =>
      source({ hiddenFrom: 600, hiddenTo: 800 }),
    );
    const result = outcome.result!;
    expect(result.lost.length).toBe(2);
    expect(result.lost[0]!).toBeGreaterThanOrEqual(600);
    expect(result.lost[1]!).toBeLessThanOrEqual(834);
    result.atMs.forEach((t, i) => {
      if (t >= 600 && t < 800) expect(result.sure[i]).toBe(0);
      // Carried between the two sightings rather than held where it was last seen.
      if (t >= 600 && t < 800) expect(cornerError(result.corners, i, t), `coasted at ${t}`).toBeLessThan(4);
    });
    expect(result.atMs.at(-1)).toBe(1400);
    expect(cornerError(result.corners, result.atMs.length - 1, 1400)).toBeLessThan(2);
  });
});
