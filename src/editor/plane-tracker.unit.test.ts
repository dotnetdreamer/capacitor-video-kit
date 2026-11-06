import { describe, expect, it } from 'vitest';

import { invertH, squareToQuad } from './homography';
import type { LumaFrame } from './object-tracker';
import { PlaneTracker, type PlaneTrackerState } from './plane-tracker';

/*
 * Footage made up for the test, at the size a phone's preview copy is read at (512 by 288): a textured
 * flat surface laid over a textured background through a known homography each frame, so where its four
 * corners are is known to the pixel.
 */

const W = 512;
const H = 288;

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

/** The surface's own picture, worked out once on a grid and read bilinearly: detail at three sizes, as a poster has. */
const TEX = 320;
const texture = (() => {
  const out = new Float32Array(TEX * TEX);
  for (let j = 0; j < TEX; j++) {
    for (let i = 0; i < TEX; i++) {
      const check = 0.5 + 0.5 * Math.tanh(2 * Math.sin(i * 0.21) * Math.sin(j * 0.21));
      out[j * TEX + i] = 25 + 45 * check + 80 * noise(i, j, 3, 26) + 55 * noise(i, j, 5, 10) + 40 * noise(i, j, 9, 4);
    }
  }
  return out;
})();

function surfaceAt(u: number, v: number): number {
  const x = Math.min(TEX - 1.001, Math.max(0, u * (TEX - 1)));
  const y = Math.min(TEX - 1.001, Math.max(0, v * (TEX - 1)));
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const ax = x - ix;
  const ay = y - iy;
  const i = iy * TEX + ix;
  return (1 - ay) * ((1 - ax) * texture[i]! + ax * texture[i + 1]!) + ay * ((1 - ax) * texture[i + TEX]! + ax * texture[i + TEX + 1]!);
}

const backdrop = (() => {
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = 40 + 110 * noise(x, y, 7, 15) + 45 * noise(x, y, 11, 5);
  return out;
})();

interface Scene {
  /** The surface's corners, pixel x's middle at x: top-left, top-right, bottom-right, bottom-left. */
  quad: number[];
  /** A block in front of everything, in pixels: flat grey, or textured unlike the surface. */
  block?: { x: number; y: number; w: number; h: number; textured?: boolean };
}

function render(scene: Scene): LumaFrame {
  const data = new Uint8ClampedArray(W * H);
  const square = squareToQuad(scene.quad)!;
  const back = invertH(square)!;
  const across = Math.hypot(scene.quad[2]! - scene.quad[0]!, scene.quad[3]! - scene.quad[1]!);
  const block = scene.block;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let value: number;
      if (block && x >= block.x && x < block.x + block.w && y >= block.y && y < block.y + block.h) {
        value = block.textured ? 60 + 120 * noise(x, y, 21, 6) : 90;
      } else {
        const w = back[6]! * x + back[7]! * y + back[8]!;
        const u = (back[0]! * x + back[1]! * y + back[2]!) / w;
        const v = (back[3]! * x + back[4]! * y + back[5]!) / w;
        const inside = Math.min(u, 1 - u, v, 1 - v);
        // How much of the pixel the surface covers, eased over a pixel at its edge.
        const cover = Math.min(1, Math.max(0, inside * across + 0.5));
        const bg = backdrop[y * W + x]!;
        value = cover > 0 ? cover * surfaceAt(u, v) + (1 - cover) * bg : bg;
      }
      data[y * W + x] = value;
    }
  }
  return { width: W, height: H, data };
}

/** A rectangle `w` by `h` centred on (`cx`, `cy`), turned clockwise by `deg`. */
function rect(cx: number, cy: number, w: number, h: number, deg = 0): number[] {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ].flatMap(([x, y]) => [cx + x! * c - y! * s, cy + x! * s + y! * c]);
}

/** A 2 by 1.2 card four units from a camera of focal length 330 px, turned `yaw` degrees about its upright axis. */
function card(yaw: number, shiftX = 0): number[] {
  const r = (yaw * Math.PI) / 180;
  return [
    [-1, -0.6],
    [1, -0.6],
    [1, 0.6],
    [-1, 0.6],
  ].flatMap(([x, y]) => {
    const X = x! * Math.cos(r) + shiftX;
    const Z = 4 + x! * Math.sin(r);
    return [W / 2 - 0.5 + (330 * X) / Z, H / 2 - 0.5 + (330 * y!) / Z];
  });
}

function worst(state: PlaneTrackerState, truth: number[]): number {
  let most = 0;
  for (let k = 0; k < 4; k++) most = Math.max(most, Math.hypot(state.corners[2 * k]! - truth[2 * k]!, state.corners[2 * k + 1]! - truth[2 * k + 1]!));
  return most;
}

function run(scenes: Scene[], startCorners = scenes[0]!.quad): { states: PlaneTrackerState[]; stepMs: number; slowestMs: number } {
  const tracker = new PlaneTracker();
  const frames = scenes.map(render);
  const states = [tracker.start(frames[0]!, startCorners)];
  const t0 = performance.now();
  let slowestMs = 0;
  for (let i = 1; i < frames.length; i++) {
    const t = performance.now();
    states.push(tracker.step(frames[i]!));
    slowestMs = Math.max(slowestMs, performance.now() - t);
  }
  return { states, stepMs: (performance.now() - t0) / Math.max(1, frames.length - 1), slowestMs };
}

describe('PlaneTracker', () => {
  it('follows a surface sliding across the frame, its corners to within a pixel', () => {
    const scenes = Array.from({ length: 36 }, (_, i) => ({ quad: rect(150 + 4 * i, 130 + 1.5 * i, 190, 120) }));
    const { states } = run(scenes);
    states.forEach((state, i) => {
      expect(state.lost, `frame ${i}`).toBe(false);
      expect(worst(state, scenes[i]!.quad), `frame ${i}`).toBeLessThan(1);
    });
    expect(states.at(-1)!.confidence).toBeGreaterThan(0.5);
  });

  it('turns with a surface that turns', () => {
    const scenes = Array.from({ length: 30 }, (_, i) => ({ quad: rect(256, 144, 200, 130, 1.5 * i) }));
    const { states } = run(scenes);
    states.forEach((state, i) => {
      expect(state.lost, `frame ${i}`).toBe(false);
      expect(worst(state, scenes[i]!.quad), `frame ${i}`).toBeLessThan(1.2);
    });
  });

  it('follows a surface tilting away in perspective', () => {
    const scenes = Array.from({ length: 30 }, (_, i) => ({ quad: card(1.2 * i, 0.01 * i) }));
    const { states } = run(scenes);
    states.forEach((state, i) => {
      expect(state.lost, `frame ${i}`).toBe(false);
      expect(worst(state, scenes[i]!.quad), `frame ${i}`).toBeLessThan(1.5);
    });
    // Foreshortened: the far (right) edge is shorter than the near (left) one by now, as the card's is.
    const last = states.at(-1)!.corners;
    expect(Math.abs(last[7]! - last[1]!)).toBeGreaterThan(Math.abs(last[5]! - last[3]!) + 10);
  });

  it('keeps a corner a hand covers where it is, from the rest of the surface', () => {
    const scenes = Array.from({ length: 30 }, (_, i): Scene => {
      const quad = rect(170 + 3 * i, 140, 200, 130);
      // Over the surface's top-left corner from frame 6 to 24, textured unlike it, standing still.
      return i >= 6 && i <= 24 ? { quad, block: { x: 70, y: 70, w: 95, h: 60, textured: true } } : { quad };
    });
    const { states } = run(scenes);
    states.forEach((state, i) => {
      expect(state.lost, `frame ${i}`).toBe(false);
      expect(worst(state, scenes[i]!.quad), `frame ${i}`).toBeLessThan(2);
    });
  });

  it('holds the last quad while the surface is hidden, and finds it again', () => {
    const scenes = Array.from({ length: 34 }, (_, i): Scene => {
      const quad = rect(230 + 1.5 * i, 150, 180, 120);
      return i >= 12 && i <= 20 ? { quad, block: { x: 100, y: 60, w: 330, h: 190 } } : { quad };
    });
    const { states } = run(scenes);
    expect(states[11]!.lost).toBe(false);
    const hidden = states.slice(13, 21);
    expect(hidden.every(s => s.lost)).toBe(true);
    // Held where it was last seen.
    expect(hidden[0]!.corners).toEqual(hidden.at(-1)!.corners);
    const back = states.slice(24);
    expect(back.every(s => !s.lost)).toBe(true);
    back.forEach((state, k) => expect(worst(state, scenes[24 + k]!.quad), `frame ${24 + k}`).toBeLessThan(1.5));
  });

  it('does not drift over a long back-and-forth', () => {
    const scenes = Array.from({ length: 121 }, (_, i) => {
      const phase = (i / 60) * Math.PI * 2;
      return { quad: rect(256 + 45 * Math.sin(phase), 144 + 12 * Math.sin(2 * phase), 190, 125, 8 * Math.sin(phase)) };
    });
    const { states } = run(scenes);
    expect(states.every(s => !s.lost)).toBe(true);
    expect(worst(states.at(-1)!, scenes.at(-1)!.quad)).toBeLessThan(1);
  });

  it('answers lost for a surface with nothing on it to hold', () => {
    const frame: LumaFrame = { width: W, height: H, data: new Uint8ClampedArray(W * H).fill(120) };
    const tracker = new PlaneTracker();
    const quad = rect(256, 144, 180, 120);
    expect(tracker.start(frame, quad).lost).toBe(true);
    const next = tracker.step(frame);
    expect(next.lost).toBe(true);
    expect(next.corners).toEqual(quad);
  });

  it('answers lost for a folded quad', () => {
    const tracker = new PlaneTracker();
    const quad = rect(256, 144, 180, 120);
    // Top-right and bottom-right swapped: a bow tie.
    const folded = [quad[0]!, quad[1]!, quad[4]!, quad[5]!, quad[2]!, quad[3]!, quad[6]!, quad[7]!];
    expect(tracker.start(render({ quad }), folded).lost).toBe(true);
  });

  it('costs a few milliseconds a frame at 512 by 288', () => {
    const scenes = Array.from({ length: 41 }, (_, i) => ({ quad: card(0.6 * i, 0.012 * i) }));
    const { states, stepMs, slowestMs } = run(scenes);
    expect(states.every(s => !s.lost)).toBe(true);
    console.info(`PlaneTracker: ${stepMs.toFixed(2)} ms a frame at ${W}x${H}, the slowest ${slowestMs.toFixed(2)} ms`);
    expect(stepMs).toBeLessThan(60);
  });
});
