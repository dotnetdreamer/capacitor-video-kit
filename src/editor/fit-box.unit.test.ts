import { describe, expect, it } from 'vitest';

import { fitBoxAt, fitByLooks, fitByMotion, type FitBox, type FitFrame } from './fit-box';

/*
 * The box a tap fits round a thing, on frames made up the size a tracking run reads a phone's footage at:
 * 512 by 288. The street is value noise a few pixels across, which every point can hold on to; the thing
 * is a bright square with a texture of its own that moves with it, or a flat disc on a flat field, which
 * has nothing to follow and is found by how it looks.
 */

const W = 512;
const H = 288;

function hash(x: number, y: number, seed: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263) + Math.imul(seed, 1442695041);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

/** Value noise `cell` pixels across, 0..1. */
function noise(x: number, y: number, cell: number, seed: number): number {
  const gx = x / cell;
  const gy = y / cell;
  const x0 = Math.floor(gx);
  const y0 = Math.floor(gy);
  const fx = gx - x0;
  const fy = gy - y0;
  const top = hash(x0, y0, seed) + (hash(x0 + 1, y0, seed) - hash(x0, y0, seed)) * fx;
  const bottom = hash(x0, y0 + 1, seed) + (hash(x0 + 1, y0 + 1, seed) - hash(x0, y0 + 1, seed)) * fx;
  return top + (bottom - top) * fy;
}

/** The street, slid by (`dx`, `dy`) pixels for a camera that pans across it. */
function street(dx = 0, dy = 0): Uint8Array {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) out[y * W + x] = 30 + 120 * noise(x + dx, y + dy, 6, 1);
  return out;
}

/** The thing: a bright square `side` pixels across with its top-left at (`x`, `y`), its own texture moving with it. */
function withSquare(under: Uint8Array, x: number, y: number, side: number): FitFrame {
  const luma = under.slice();
  for (let j = 0; j < side; j++) {
    for (let i = 0; i < side; i++) {
      const X = x + i;
      const Y = y + j;
      if (X >= 0 && Y >= 0 && X < W && Y < H) luma[Y * W + X] = 170 + 80 * noise(i, j, 5, 2);
    }
  }
  return { width: W, height: H, luma };
}

/** A flat disc of luma `inside` on a flat field of `outside`. */
function disc(cx: number, cy: number, radius: number, inside: number, outside: number): FitFrame {
  const luma = new Uint8Array(W * H).fill(outside);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) luma[y * W + x] = inside;
  return { width: W, height: H, luma };
}

/** A box's edges in pixels of the frame, which read better in a failure than fractions do. */
function edges(box: FitBox): { left: number; right: number; top: number; bottom: number } {
  return { left: (box.cx - box.w / 2) * W, right: (box.cx + box.w / 2) * W, top: (box.cy - box.h / 2) * H, bottom: (box.cy + box.h / 2) * H };
}

/** Whether `box` holds the square at (`x`, `y`), `side` across, give or take `slack` pixels on every side, and is no more than `spare` past it. */
function holdsSquare(box: FitBox | null, x: number, y: number, side: number, slack: number, spare: number): boolean {
  if (!box) return false;
  const e = edges(box);
  const inside = e.left <= x + slack && e.right >= x + side - slack && e.top <= y + slack && e.bottom >= y + side - slack;
  const tight = e.left >= x - spare && e.right <= x + side + spare && e.top >= y - spare && e.bottom <= y + side + spare;
  return inside && tight;
}

describe('fitting a box round the thing under a tap', () => {
  const still = street();
  const before = withSquare(still, 200, 100, 64);

  it('fits round a thing that moves across a still background, by how it moves', () => {
    const after = withSquare(still, 212, 104, 64);
    const box = fitBoxAt(before, 232 / W, 132 / H, after);
    expect(box, 'a box').not.toBeNull();
    expect(holdsSquare(box, 200, 100, 64, 10, 20), JSON.stringify(edges(box!))).toBe(true);
    // The motion found it, not the looks: the square is too busy to be a region of one brightness.
    expect(fitByMotion(before, after, 232 / W, 132 / H)).not.toBeNull();
  });

  it('fits round a thing the camera pans with, against the street sliding past', () => {
    const after = withSquare(street(10, 2), 200, 100, 64);
    const box = fitBoxAt(before, 232 / W, 132 / H, after);
    expect(holdsSquare(box, 200, 100, 64, 10, 20), JSON.stringify(box && edges(box))).toBe(true);
  });

  it('works the same with the later frame a moment before instead', () => {
    const earlier = withSquare(still, 188, 96, 64);
    const box = fitBoxAt(before, 232 / W, 132 / H, earlier);
    expect(holdsSquare(box, 200, 100, 64, 10, 20), JSON.stringify(box && edges(box))).toBe(true);
  });

  it('fits round the whole of a thing two fifths of the frame across, from a tap anywhere on it', () => {
    const big = withSquare(still, 100, 40, 200);
    const moved = withSquare(still, 110, 44, 200);
    for (const [x, y] of [
      [200, 140],
      [130, 70],
      [270, 210],
    ] as const) {
      const box = fitBoxAt(big, x / W, y / H, moved);
      expect(holdsSquare(box, 100, 40, 200, 12, 24), `tapped at ${x}, ${y}: ${JSON.stringify(box && edges(box))}`).toBe(true);
    }
  });

  it('fits round a thing a twentieth of the frame across', () => {
    const small = withSquare(still, 300, 150, 24);
    const moved = withSquare(still, 306, 152, 24);
    expect(holdsSquare(fitBoxAt(small, 312 / W, 162 / H, moved), 300, 150, 24, 4, 12)).toBe(true);
  });

  it('does not answer a tap on the still street with the thing moving beside it', () => {
    const after = withSquare(still, 212, 104, 64);
    const box = fitBoxAt(before, 80 / W, 220 / H, after);
    if (box) {
      const e = edges(box);
      expect(e.left > 232 || e.right < 232 || e.top > 132 || e.bottom < 132, JSON.stringify(e)).toBe(true);
    }
    expect(fitByMotion(before, after, 80 / W, 220 / H), 'nothing there moves apart from the street').toBeNull();
  });

  it('finds a flat disc on a flat field by how it looks, padded a little', () => {
    const frame = disc(300, 150, 40, 200, 60);
    // The same frame twice: nothing moves, and nothing in the disc could be followed anyway.
    const box = fitBoxAt(frame, 300 / W, 150 / H, frame);
    expect(box, 'a box').not.toBeNull();
    const e = edges(box!);
    expect((e.left + e.right) / 2, 'its middle across').toBeCloseTo(300, -1);
    expect((e.top + e.bottom) / 2, 'its middle down').toBeCloseTo(150, -1);
    expect(e.right - e.left, 'its width').toBeGreaterThanOrEqual(80);
    expect(e.right - e.left, 'its width').toBeLessThanOrEqual(104);
    expect(e.bottom - e.top, 'its height').toBeGreaterThanOrEqual(80);
    expect(e.bottom - e.top, 'its height').toBeLessThanOrEqual(104);
    expect(fitBoxAt(frame, 300 / W, 150 / H), 'without a later frame').toEqual(box);
  });

  it('finds the disc from a tap on its edge', () => {
    const frame = disc(300, 150, 40, 200, 60);
    const box = fitByLooks(frame, 300 / W, 112 / H);
    expect(box, 'a box').not.toBeNull();
    expect(edges(box!).bottom - edges(box!).top).toBeGreaterThanOrEqual(76);
  });

  it('finds nothing on a flat field, rather than half the frame', () => {
    const flat: FitFrame = { width: W, height: H, luma: new Uint8Array(W * H).fill(90) };
    expect(fitBoxAt(flat, 0.5, 0.5, flat)).toBeNull();
  });

  it('finds nothing for a tap off the frame, or on a frame too small to read', () => {
    expect(fitBoxAt(before, 1.2, 0.5)).toBeNull();
    expect(fitBoxAt(before, Number.NaN, 0.5)).toBeNull();
    expect(fitBoxAt({ width: 4, height: 4, luma: new Uint8Array(16) }, 0.5, 0.5)).toBeNull();
  });

  it("takes well under 50 ms on a tracking run's frame", () => {
    const after = withSquare(still, 212, 104, 64);
    const times: number[] = [];
    for (let run = 0; run < 7; run++) {
      const start = performance.now();
      fitBoxAt(before, 232 / W, 132 / H, after);
      // And the slower way to nothing: the motion giving up, then the looks.
      fitBoxAt(before, 80 / W, 220 / H, after);
      times.push((performance.now() - start) / 2);
    }
    times.sort((a, b) => a - b);
    expect(times[3]!, `median of ${times.map(t => t.toFixed(1)).join(', ')} ms`).toBeLessThan(50);
  });
});
