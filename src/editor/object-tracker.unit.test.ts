import { describe, expect, it } from 'vitest';

import { ObjectTracker, levelsFor, type LumaFrame } from './object-tracker';

/*
 * Footage made up for the test: a textured square moving over a textured background, drawn exactly, so
 * where the tracker should be is known to the pixel at every frame.
 */

const W = 288;
const H = 512;

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

function background(x: number, y: number): number {
  return 40 + 120 * noise(x, y, 7, 14) + 50 * noise(x, y, 11, 5);
}

/**
 * The thing, in its own coordinates -1..1 each way: blotches at three sizes over a faint checkerboard,
 * unlike the background. Detail at every scale, as a real surface has - a pattern of one size only
 * repeats, and a coarse pyramid level cannot tell one repeat from the next. Its edges are eased over a
 * pixel or so, as a camera's are, so a move of a fraction of a pixel shows in the frame.
 */
function thing(u: number, v: number): number {
  const check = 0.5 + 0.5 * Math.tanh(2 * Math.sin(u * 9) * Math.sin(v * 9));
  const s = (u + 1) * 40;
  const t = (v + 1) * 40;
  return 20 + 50 * check + 80 * noise(s, t, 3, 22) + 60 * noise(s, t, 5, 9) + 40 * noise(s, t, 9, 4);
}

interface Pose {
  /** Centre, in the tracker's own coordinates: pixel x's middle is at x. */
  cx: number;
  cy: number;
  /** Half the side, in pixels. */
  half: number;
  /** Clockwise degrees. */
  angle: number;
}

/** One frame: the background panned by (`panX`, `panY`), the thing at `pose`, and a flat block over `hidden`. */
function frame(pose: Pose, options: { panX?: number; panY?: number; hidden?: { x: number; y: number; w: number; h: number } } = {}): LumaFrame {
  const data = new Uint8ClampedArray(W * H);
  const rad = (pose.angle * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const panX = options.panX ?? 0;
  const panY = options.panY ?? 0;
  const hidden = options.hidden;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let value: number;
      if (hidden && x >= hidden.x && x < hidden.x + hidden.w && y >= hidden.y && y < hidden.y + hidden.h) {
        value = 90;
      } else {
        // Into the thing's own frame: back by the turn, then down to -1..1.
        const dx = x - pose.cx;
        const dy = y - pose.cy;
        const u = (dx * cos + dy * sin) / pose.half;
        const v = (-dx * sin + dy * cos) / pose.half;
        // How much of the pixel the thing covers, eased over a pixel at its edge.
        const cover = Math.min(1, Math.max(0, (1 - Math.max(Math.abs(u), Math.abs(v))) * pose.half + 0.5));
        const back = background(x + panX, y + panY);
        value = cover > 0 ? cover * thing(Math.max(-1, Math.min(1, u)), Math.max(-1, Math.min(1, v))) + (1 - cover) * back : back;
      }
      data[y * W + x] = value;
    }
  }
  return { width: W, height: H, data };
}

function run(poses: Pose[], options: (i: number) => Parameters<typeof frame>[1] = () => ({})) {
  const tracker = new ObjectTracker();
  const first = poses[0]!;
  const states = [tracker.start(frame(first, options(0)), { cx: first.cx, cy: first.cy, w: first.half * 2, h: first.half * 2 })];
  for (let i = 1; i < poses.length; i++) states.push(tracker.step(frame(poses[i]!, options(i))));
  return states;
}

describe('ObjectTracker', () => {
  it('follows a thing moving steadily, to within a pixel', () => {
    const poses = Array.from({ length: 40 }, (_, i) => ({ cx: 70 + 3 * i, cy: 150 + 1.5 * i, half: 26, angle: 0 }));
    const states = run(poses);
    states.forEach((state, i) => {
      expect(state.lost, `frame ${i}`).toBe(false);
      expect(Math.hypot(state.cx - poses[i]!.cx, state.cy - poses[i]!.cy), `frame ${i}`).toBeLessThan(1);
    });
    expect(states.at(-1)!.scale).toBeCloseTo(1, 1);
    expect(Math.abs(states.at(-1)!.angle)).toBeLessThan(2);
  });

  it('keeps up with a fast thing over a panning background', () => {
    const poses = Array.from({ length: 30 }, (_, i) => ({ cx: 60 + 6 * i, cy: 120 + 9 * i, half: 28, angle: 0 }));
    const states = run(poses, i => ({ panX: -5 * i, panY: 2 * i }));
    states.forEach((state, i) => {
      expect(state.lost, `frame ${i}`).toBe(false);
      expect(Math.hypot(state.cx - poses[i]!.cx, state.cy - poses[i]!.cy), `frame ${i}`).toBeLessThan(1.5);
    });
  });

  it('grows with a thing coming closer', () => {
    const poses = Array.from({ length: 30 }, (_, i) => ({ cx: 144, cy: 256, half: 22 * Math.pow(1.015, i), angle: 0 }));
    const states = run(poses);
    const last = states.at(-1)!;
    expect(last.lost).toBe(false);
    expect(last.scale).toBeGreaterThan(Math.pow(1.015, 29) * 0.95);
    expect(last.scale).toBeLessThan(Math.pow(1.015, 29) * 1.05);
  });

  it('turns with a thing that turns, clockwise positive', () => {
    const poses = Array.from({ length: 30 }, (_, i) => ({ cx: 144, cy: 256, half: 30, angle: 2 * i }));
    const states = run(poses);
    const last = states.at(-1)!;
    expect(last.lost).toBe(false);
    expect(last.angle).toBeGreaterThan(58 - 4);
    expect(last.angle).toBeLessThan(58 + 4);
    expect(Math.hypot(last.cx - 144, last.cy - 256)).toBeLessThan(1.5);
  });

  it('says it lost a thing that is hidden, holds where it was, and finds it again', () => {
    const poses = Array.from({ length: 40 }, (_, i) => ({ cx: 80 + 2 * i, cy: 200, half: 24, angle: 0 }));
    const cover = (i: number) => (i >= 15 && i < 22 ? { hidden: { x: 0, y: 150, w: W, h: 100 } } : {});
    const states = run(poses, cover);
    // Clear before the cover...
    for (let i = 0; i < 15; i++) expect(states[i]!.lost, `frame ${i}`).toBe(false);
    // ... lost under it, held where it was last seen ...
    for (let i = 16; i < 22; i++) {
      expect(states[i]!.lost, `frame ${i}`).toBe(true);
      expect(states[i]!.cx).toBeCloseTo(states[15]!.cx, 0);
    }
    // ... and found again within a frame of it coming back, right where it is.
    const back = states.findIndex((state, i) => i >= 22 && !state.lost);
    expect(back).toBeGreaterThanOrEqual(22);
    expect(back).toBeLessThanOrEqual(23);
    for (let i = back; i < 40; i++) {
      expect(Math.hypot(states[i]!.cx - poses[i]!.cx, states[i]!.cy - poses[i]!.cy), `frame ${i}`).toBeLessThan(1.5);
    }
  });

  it('refuses a box with nothing to follow in it', () => {
    const flat: LumaFrame = { width: W, height: H, data: new Uint8ClampedArray(W * H).fill(128) };
    const tracker = new ObjectTracker();
    const state = tracker.start(flat, { cx: 144, cy: 256, w: 60, h: 60 });
    expect(state.lost).toBe(true);
    expect(state.confidence).toBe(0);
    expect(tracker.step(flat).lost).toBe(true);
  });

  it('reads the footage either way round', () => {
    const poses = Array.from({ length: 25 }, (_, i) => ({ cx: 90 + 4 * i, cy: 300 - 3 * i, half: 26, angle: 0 }));
    const states = run([...poses].reverse());
    const expected = [...poses].reverse();
    states.forEach((state, i) => {
      expect(Math.hypot(state.cx - expected[i]!.cx, state.cy - expected[i]!.cy), `frame ${i}`).toBeLessThan(1);
    });
  });

  it('builds as many pyramid levels as a frame has room for', () => {
    expect(levelsFor(288, 512)).toBe(4);
    expect(levelsFor(64, 64)).toBe(2);
    expect(levelsFor(30, 30)).toBe(1);
  });
});
