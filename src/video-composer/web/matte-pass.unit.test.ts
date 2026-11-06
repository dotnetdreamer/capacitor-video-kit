import { describe, expect, it } from 'vitest';

import { drawsSomething, flatCorners } from './matte-pass';

/* The corners a flat layer behind the people is drawn through, and what draws nothing. */

const FRAME = { width: 200, height: 100 };

describe('a flat layer behind the people', () => {
  it('has its corners where the painter draws its bitmap, in the bitmap order', () => {
    expect(flatCorners({ cx: 0.5, cy: 0.5, wPx: 40, hPx: 20, rotationDeg: 0 }, null, FRAME)).toEqual([0.4, 0.4, 0.6, 0.4, 0.6, 0.6, 0.4, 0.6]);
  });

  it('is moved, grown and turned clockwise by its motion, about its middle in pixels', () => {
    const corners = flatCorners({ cx: 0.5, cy: 0.5, wPx: 40, hPx: 20, rotationDeg: 60 }, { x: 0.1, y: 0, scale: 2, rotation: 30 }, FRAME)!;
    // A quarter turn clockwise, twice the size, its middle at (120, 50): the top-left corner goes to the top right.
    const px = corners.map((v, k) => v * (k % 2 === 0 ? FRAME.width : FRAME.height));
    expect(px[0]).toBeCloseTo(140, 9);
    expect(px[1]).toBeCloseTo(10, 9);
    expect(px[4]).toBeCloseTo(100, 9);
    expect(px[5]).toBeCloseTo(90, 9);
  });

  it('is nothing shrunk to nothing, and draws nothing faded out', () => {
    expect(flatCorners({ cx: 0.5, cy: 0.5, wPx: 40, hPx: 20, rotationDeg: 0 }, { x: 0, y: 0, scale: 0, rotation: 0 }, FRAME)).toBeNull();
    const corners = flatCorners({ cx: 0.5, cy: 0.5, wPx: 40, hPx: 20, rotationDeg: 0 }, null, FRAME)!;
    const bitmap = {} as HTMLCanvasElement;
    expect(drawsSomething({ bitmap, corners, opacity: 1 }, FRAME)).toBe(true);
    expect(drawsSomething({ bitmap, corners, opacity: 0 }, FRAME)).toBe(false);
    expect(drawsSomething({ bitmap, corners: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5], opacity: 1 }, FRAME)).toBe(false);
  });
});
