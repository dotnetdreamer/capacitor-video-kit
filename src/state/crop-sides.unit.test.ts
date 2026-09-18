import { describe, expect, it } from 'vitest';

import { MIN_CROP, resizeCrop, WHOLE_RECT, type CropSide } from './clip-framing';

/**
 * Dragging one side of the crop window, which is the freehand half of the crop tool.
 *
 * A pinch zooms the window about its centre and keeps the customer's shape; this is the customer
 * CHOOSING a shape, one edge at a time. So what every case below really asserts is that the other
 * three edges did not move.
 */

/** The four edges of a rectangle, which is the only honest way to say "nothing else moved". */
function edges(rect: { x: number; y: number; w: number; h: number }) {
  return { left: rect.x, right: rect.x + rect.w, top: rect.y, bottom: rect.y + rect.h };
}

const HALF = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

describe('resizeCrop', () => {
  it('moves only the edge that was taken hold of', () => {
    const cases: Array<[CropSide, 'left' | 'right' | 'top' | 'bottom']> = [
      ['left', 'left'],
      ['right', 'right'],
      ['top', 'top'],
      ['bottom', 'bottom'],
    ];
    for (const [side, moved] of cases) {
      const before = edges(HALF);
      const after = edges(resizeCrop(HALF, side, 0.1, 0.1));
      for (const edge of ['left', 'right', 'top', 'bottom'] as const) {
        if (edge === moved) expect(after[edge], `${side} moved ${edge}`).not.toBeCloseTo(before[edge], 4);
        else expect(after[edge], `${side} left ${edge} alone`).toBeCloseTo(before[edge], 4);
      }
    }
  });

  it('moves the two edges that meet at a corner, and no others', () => {
    const after = edges(resizeCrop(HALF, 'topLeft', 0.1, 0.1));
    expect(after.left).toBeCloseTo(0.35, 4);
    expect(after.top).toBeCloseTo(0.35, 4);
    // The far corner is where the customer left it.
    expect(after.right).toBeCloseTo(0.75, 4);
    expect(after.bottom).toBeCloseTo(0.75, 4);
  });

  it('holds every edge inside the source, because there is nothing outside it to keep', () => {
    expect(resizeCrop(HALF, 'left', -5, 0).x).toBe(0);
    expect(resizeCrop(HALF, 'top', 0, -5).y).toBe(0);
    const right = resizeCrop(HALF, 'right', 5, 0);
    expect(right.x + right.w).toBeCloseTo(1, 4);
    const bottom = resizeCrop(HALF, 'bottom', 0, 5);
    expect(bottom.y + bottom.h).toBeCloseTo(1, 4);
  });

  it('stops an edge [MIN_CROP] from its opposite rather than shutting the window', () => {
    // Dragged far past the other side: the edge stops, and the edge it was dragged towards has not
    // been pushed along with it - which is what clamping the SIZE instead would have done.
    const shut = resizeCrop(HALF, 'left', 5, 0);
    expect(shut.w).toBeCloseTo(MIN_CROP, 4);
    expect(shut.x + shut.w).toBeCloseTo(0.75, 4);

    const tall = resizeCrop(HALF, 'bottom', 0, -5);
    expect(tall.h).toBeCloseTo(MIN_CROP, 4);
    expect(tall.y).toBeCloseTo(0.25, 4);
  });

  it('lets a side be dragged out again from the whole frame', () => {
    // The starting state of every uncropped clip: pulling one edge in is the first crop it gets.
    const cropped = resizeCrop(WHOLE_RECT, 'top', 0, 0.3);
    expect(cropped).toEqual({ x: 0, y: 0.3, w: 1, h: 0.7 });
    // ...and back out again, exactly.
    expect(resizeCrop(cropped, 'top', 0, -0.3)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
  });

  it('changes the shape, which is the whole difference from a pinch', () => {
    const wide = resizeCrop(HALF, 'bottom', 0, -0.25);
    expect(wide.w / wide.h).toBeCloseTo(2, 4);
    expect(wide.w).toBeCloseTo(HALF.w, 4);
  });
});
