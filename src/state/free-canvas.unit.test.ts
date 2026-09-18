import { describe, expect, it } from 'vitest';

import { MAX_PLACEMENT_SIZE, MIN_ON_FRAME } from '../editor';
import { MIN_CLIP_RECT, placeClipRect, placeRect, scaleClipRect, scaleRect } from './clip-framing';

/**
 * The canvas is free: a video goes where the fingers put it, including off the edge of the frame,
 * and the frame cuts off whatever hangs over - which is what a customer means by moving a video to
 * the corner and what every phone editor does.
 *
 * These pin the two halves of that. A PICTURE is placed by its centre and nothing else holds it; a
 * CROP is a window on a source and is held inside it, because there are no pixels outside a source
 * to sample. The two rules are one function apart on purpose, and merging them by accident is the
 * failure these guard against: applied to a crop the free rule samples black, and applied to a
 * placement the crop rule slides the customer's video back on screen.
 */
describe('placing a video on a free canvas', () => {
  it('leaves the corners where they fall, however far off the frame', () => {
    const half = placeClipRect(0, 0.5, 0.6, 0.6);

    // Centred on the left edge: half the video is on screen and half of it is off, and the
    // rectangle says so rather than being squared up against the edge.
    expect(half).toEqual({ x: -0.3, y: 0.2, w: 0.6, h: 0.6 });
  });

  it('goes on past half off, and stops with a strip of the video still showing', () => {
    // Half off is where the old rule stopped, and it was not far enough: a customer framing a strip
    // of a video along the bottom of the frame means to keep pushing.
    const shoved = placeClipRect(-3, 4, 0.5, 0.5);

    expect(shoved.x).toBeCloseTo(MIN_ON_FRAME - 0.5, 4);
    expect(shoved.y).toBeCloseTo(1 - MIN_ON_FRAME, 4);
    // What is left on the frame is that strip, and it is never nothing: a rectangle wholly off the
    // frame draws nothing at all and no finger could find it again.
    expect(shoved.x + shoved.w).toBeCloseTo(MIN_ON_FRAME, 4);
  });

  it('carries the angle, and still writes no angle at all for an upright rectangle', () => {
    expect(placeClipRect(0.1, 0.9, 0.4, 0.4, 30).rotationDeg).toBe(30);
    // Absent is what keeps an untouched clip on the native fast path; a zero would be the same
    // picture at the cost of a re-encode.
    expect('rotationDeg' in placeClipRect(0.1, 0.9, 0.4, 0.4)).toBe(false);
  });

  it('pinches past the frame up to the renderers ceiling, keeping the shape throughout', () => {
    const rect = { x: 0.25, y: 0.25, w: 0.5, h: 0.5 };

    const grown = scaleClipRect(rect, 3, MIN_CLIP_RECT);
    expect(grown.w).toBeCloseTo(1.5, 4);
    expect(grown.h).toBeCloseTo(1.5, 4);
    // Still centred where it was: a pinch zooms about the middle and moves nothing.
    expect(grown.x + grown.w / 2).toBeCloseTo(0.5, 4);

    // The factor is squeezed before it is applied, never the result clamped afterwards, so a pinch
    // that asks for more than the ceiling stops at it with the customer's aspect choice intact.
    const capped = scaleClipRect({ x: 0, y: 0.25, w: 1, h: 0.5 }, 9, MIN_CLIP_RECT);
    expect(capped.w).toBeCloseTo(MAX_PLACEMENT_SIZE, 4);
    expect(capped.h).toBeCloseTo(MAX_PLACEMENT_SIZE / 2, 4);
  });

  it('stops shrinking where a fingertip would cover the whole video', () => {
    const tiny = scaleClipRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 0.01, MIN_CLIP_RECT);

    expect(tiny.w).toBeCloseTo(MIN_CLIP_RECT, 4);
  });

  it('leaves a crop held inside its source, which is the other rule entirely', () => {
    // The guard that matters: a crop that took the free rule would sample outside the source and
    // paint black into the middle of the picture.
    expect(placeRect(0, 0.5, 0.6, 0.6)).toEqual({ x: 0, y: 0.2, w: 0.6, h: 0.6 });
    expect(scaleRect({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, 3, 0.1).w).toBeCloseTo(1, 4);
  });
});
