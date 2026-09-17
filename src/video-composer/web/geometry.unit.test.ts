import { describe, expect, it } from 'vitest';

import { drawRects, sourceWindow } from './geometry';

/**
 * The window that decides which pixels of a source land where on the output - the one piece of
 * arithmetic where a browser and a phone disagreeing shows up as a visibly different post.
 *
 * The frame throughout is 720x1280, the output every manifest renders at.
 */
const FRAME = { width: 720, height: 1280 };

describe('sourceWindow', () => {
  it('shows the whole of a source that already has the output shape', () => {
    const window = sourceWindow({ fit: 'contain' }, FRAME, 720, 1280);
    expect(window.x).toBeCloseTo(0, 6);
    expect(window.y).toBeCloseTo(0, 6);
    expect(window.w).toBeCloseTo(1, 6);
    expect(window.h).toBeCloseTo(1, 6);
  });

  it('contain leaves bars, which come back as a window OUTSIDE the source', () => {
    // A 16:9 landscape clip in a 9:16 frame: the picture fills the width and the rest is bars.
    const window = sourceWindow({ fit: 'contain' }, FRAME, 1920, 1080);
    expect(window.x).toBeCloseTo(0, 6);
    expect(window.w).toBeCloseTo(1, 6);
    // Taller than the source, and starting above it. That is not a bug in the numbers: a bar is a
    // piece of the output standing for no piece of the source, and the sampler paints it black.
    expect(window.h).toBeGreaterThan(1);
    expect(window.y).toBeLessThan(0);
    // Symmetric, so the picture is centred.
    expect(window.y).toBeCloseTo((1 - window.h) / 2, 6);
  });

  it('cover narrows the window instead of overflowing the frame', () => {
    const window = sourceWindow({ fit: 'cover' }, FRAME, 1920, 1080);
    // The full height of the source is kept and the sides are what go.
    expect(window.h).toBeCloseTo(1, 6);
    expect(window.w).toBeLessThan(1);
    expect(window.x).toBeCloseTo((1 - window.w) / 2, 6);
    // 9:16 of a 16:9 source is 0.31640625 of its width.
    expect(window.w).toBeCloseTo((1080 * (720 / 1280)) / 1920, 6);
  });

  it('a crop is applied before the fit, so the fit measures the CROPPED picture', () => {
    // The left half of a square source, which is already 9:18 - taller than the frame - so cover
    // takes a little off the top and bottom rather than off the sides.
    const window = sourceWindow({ fit: 'cover', crop: { x: 0, y: 0, w: 0.5, h: 1 } }, FRAME, 1000, 1000);
    expect(window.x).toBeCloseTo(0, 6);
    expect(window.w).toBeCloseTo(0.5, 6);
    expect(window.h).toBeLessThan(1);
    expect(window.y).toBeCloseTo((1 - window.h) / 2, 6);
  });

  it('a rect is the frame as far as the fit is concerned', () => {
    // A quarter of the output, top left. A square source covering it shows the same 9:16 slice of
    // itself it would show if that rectangle were the whole frame.
    const half = sourceWindow({ fit: 'cover', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } }, FRAME, 1000, 1000);
    const whole = sourceWindow({ fit: 'cover' }, FRAME, 1000, 1000);
    // The window covering the WHOLE output is half the rectangle's in each direction, because the
    // rectangle is half of it - the shape of what is shown is the same.
    expect(half.w / whole.w).toBeCloseTo(2, 6);
    expect(half.h / whole.h).toBeCloseTo(2, 6);
    // ...and it starts where the rectangle does, which is at the origin here.
    expect(half.x).toBeCloseTo(whole.x, 6);
  });

  it('never divides by zero, however degenerate the rectangle', () => {
    const window = sourceWindow({ fit: 'contain', crop: { x: 0, y: 0, w: 0, h: 0 }, rect: { x: 0, y: 0, w: 0, h: 0 } }, FRAME, 1000, 1000);
    expect(Number.isFinite(window.x)).toBe(true);
    expect(Number.isFinite(window.w)).toBe(true);
  });
});

describe('drawRects', () => {
  it('turns a full-frame window into the whole source over the whole frame', () => {
    const rects = drawRects({ x: 0, y: 0, w: 1, h: 1 }, FRAME, 720, 1280);
    expect(rects).toEqual({ sx: 0, sy: 0, sw: 720, sh: 1280, dx: 0, dy: 0, dw: 720, dh: 1280 });
  });

  it('clips a letterboxed window to the source and centres what is left', () => {
    const window = sourceWindow({ fit: 'contain' }, FRAME, 1920, 1080);
    const rects = drawRects(window, FRAME, 1920, 1080);
    expect(rects).not.toBeNull();
    // The whole source is drawn...
    expect(rects?.sx).toBeCloseTo(0, 6);
    expect(rects?.sw).toBeCloseTo(1920, 6);
    expect(rects?.sh).toBeCloseTo(1080, 6);
    // ...into a band the full width of the frame, with equal bars above and below.
    expect(rects?.dx).toBeCloseTo(0, 6);
    expect(rects?.dw).toBeCloseTo(720, 6);
    expect(rects?.dh).toBeCloseTo((1080 / 1920) * 720, 4);
    expect(rects?.dy).toBeCloseTo((1280 - (1080 / 1920) * 720) / 2, 4);
  });

  it('answers null for a window that misses the source entirely', () => {
    expect(drawRects({ x: 2, y: 0, w: 1, h: 1 }, FRAME, 720, 1280)).toBeNull();
  });
});
