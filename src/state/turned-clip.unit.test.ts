import { describe, expect, it } from 'vitest';

import { placeClipRect, placeRect, scaleClipRect, scaleRect, slideRect } from './clip-framing';

/**
 * A clip's placement rectangle can be TURNED, which is what makes a free canvas free. These pin the
 * two rules that are easy to lose and expensive to notice: an upright rectangle carries no angle at
 * all, and a turn survives every other thing a gesture does to it.
 */
describe('a turned placement', () => {
  it('leaves the key off an upright rectangle, rather than writing a zero', () => {
    const upright = placeRect(0.5, 0.5, 0.4, 0.3);

    // Not a style preference. `absent means exactly today` is what keeps an untouched clip on the
    // native fast path and what the byte comparison against the pre-rotation output rests on, and
    // a zero would be a different spec for the same picture.
    expect('rotationDeg' in upright).toBe(false);
    expect(placeRect(0.5, 0.5, 0.4, 0.3, 0)).toEqual(upright);
  });

  it('keeps the angle through a drag and through a pinch', () => {
    const turned = placeRect(0.5, 0.5, 0.4, 0.3, 30);
    expect(turned.rotationDeg).toBe(30);

    // A customer who turns a video and then moves or resizes it expects to still have a turned
    // video. Both of these went through placeRect, which is where an angle would be dropped.
    expect(slideRect(turned, 0.1, 0.2).rotationDeg).toBe(30);
    expect(scaleRect(turned, 1.5, 0.12).rotationDeg).toBe(30);

    // And the two a CLIP takes, which are the ones a finger on the frame actually reaches. The drag
    // hands the angle in by hand - it builds a rectangle from the size it grabbed rather than
    // sliding the old one - so a drag that forgot to pass it straightened the video as it moved.
    expect(placeClipRect(0.6, 0.7, turned.w, turned.h, turned.rotationDeg!).rotationDeg).toBe(30);
    expect(scaleClipRect(turned, 1.5, 0.12).rotationDeg).toBe(30);
  });

  it('takes a new angle from a twist while keeping the size the pinch asked for', () => {
    const turned = placeRect(0.5, 0.5, 0.4, 0.3, 30);
    const twisted = scaleRect(turned, 1.25, 0.12, -45);

    expect(twisted.rotationDeg).toBe(-45);
    expect(twisted.w).toBeCloseTo(0.5, 4);
  });

  it('holds a turned rectangle inside the frame by its upright box', () => {
    // Clamping the turned CORNERS instead would make a rectangle shrink as it spins, and a
    // customer turning a video expects it to turn rather than to resize.
    const corner = placeRect(0.95, 0.95, 0.4, 0.3, 40);

    expect(corner.w).toBe(0.4);
    expect(corner.h).toBe(0.3);
    expect(corner.x).toBeCloseTo(0.6, 4);
    expect(corner.y).toBeCloseTo(0.7, 4);
  });
});
