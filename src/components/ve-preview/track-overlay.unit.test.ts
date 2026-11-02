import { describe, expect, it } from 'vitest';

import { aimCorners, between, boxedBy, easeOut, squareAt } from './track-overlay';

/*
 * The arithmetic of the Track sheet's picture that does not need a canvas: how a box locks on - opening out
 * from a square at the finger, quick to start and gentle to land - and when a person the finder found is
 * left to the box rather than outlined twice.
 */

describe("the Track sheet's lock-on", () => {
  it('eases out: quick to start, gentle to land, held to its ends', () => {
    expect(easeOut(0)).toBe(0);
    expect(easeOut(1)).toBe(1);
    expect(easeOut(0.5)).toBeCloseTo(0.875, 9);
    expect(easeOut(0.25) - easeOut(0)).toBeGreaterThan(easeOut(1) - easeOut(0.75));
    expect(easeOut(2)).toBe(1);
    expect(easeOut(-1)).toBe(0);
  });

  it('opens from a square at the finger to the box, corner by corner', () => {
    const from = squareAt(100, 50, 10);
    expect(from).toEqual([
      { x: 90, y: 40 },
      { x: 110, y: 40 },
      { x: 110, y: 60 },
      { x: 90, y: 60 },
    ]);
    const to = aimCorners({ cx: 0.5, cy: 0.5, w: 0.5, h: 0.5 }, 400, 200);
    expect(between(from, to, 0)).toEqual(from);
    expect(between(from, to, 1)).toEqual(to);
    expect(between(from, to, 0.5)[0]).toEqual({ x: 95, y: 45 });
    expect(between(from, to, 0.5)[2]).toEqual({ x: 205, y: 105 });
  });
});

describe('the people the finder found', () => {
  const person = { id: 1, cx: 0.5, cy: 0.5, w: 0.2, h: 0.4 };

  it('are left to the box once the box is round them', () => {
    expect(boxedBy(person, { cx: 0.5, cy: 0.5, w: 0.224, h: 0.448 })).toBe(true);
    expect(boxedBy(person, { cx: 0.52, cy: 0.48, w: 0.2, h: 0.4 })).toBe(true);
  });

  it('are outlined where the box is off them, or only half on them', () => {
    expect(boxedBy(person, { cx: 0.6, cy: 0.5, w: 0.2, h: 0.4 })).toBe(false);
    expect(boxedBy(person, { cx: 0.1, cy: 0.1, w: 0.1, h: 0.1 })).toBe(false);
  });
});
