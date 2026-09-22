import { describe, expect, it } from 'vitest';

import { TRANSITIONS, compileTransition, maskAlpha, maskMeasure } from '../../editor';
import { LOOP_HOLD_END_MS, LOOP_HOLD_START_MS, LOOP_RUN_MS, coverRect, loopProgress, maskCoverage } from './transition-thumbs';

/*
 * The arithmetic behind the transition sheet's thumbnails. The drawing itself is a canvas and is
 * looked at in the sheet's browser test; what is held here is that the numbers it draws with are
 * the reference's own.
 */

describe('maskCoverage', () => {
  // Every mask in the catalogue, not a hand-picked one: a shape added later is held to this too.
  const masked = TRANSITIONS.map(preset => compileTransition(preset.id)).filter(compiled => !!compiled?.mask);

  it('is the reference maskAlpha, over a measure worked out once', () => {
    expect(masked.length).toBeGreaterThan(0);
    const w = 48;
    const h = 48;
    for (const compiled of masked) {
      const mask = compiled!.mask!;
      for (const reveal of [0, 0.13, 0.5, 0.87, 1]) {
        for (let y = 0.5; y < h; y += 7) {
          for (let x = 0.5; x < w; x += 5) {
            const u = maskMeasure(mask, x, y, w, h);
            expect(maskCoverage(mask, reveal, u)).toBeCloseTo(maskAlpha(mask, reveal, x, y, w, h), 10);
          }
        }
      }
    }
  });
});

describe('loopProgress', () => {
  it('rests on the first frame, runs straight through, then rests on the last', () => {
    expect(loopProgress(0)).toBe(0);
    expect(loopProgress(LOOP_HOLD_START_MS - 1)).toBe(0);
    expect(loopProgress(LOOP_HOLD_START_MS + LOOP_RUN_MS / 2)).toBeCloseTo(0.5, 10);
    expect(loopProgress(LOOP_HOLD_START_MS + LOOP_RUN_MS + 1)).toBe(1);
    expect(loopProgress(LOOP_HOLD_START_MS + LOOP_RUN_MS + LOOP_HOLD_END_MS - 1)).toBe(1);
  });

  it('starts again once round, and never leaves 0..1', () => {
    const loop = LOOP_HOLD_START_MS + LOOP_RUN_MS + LOOP_HOLD_END_MS;
    expect(loopProgress(loop)).toBe(0);
    expect(loopProgress(loop + LOOP_HOLD_START_MS + LOOP_RUN_MS / 4)).toBeCloseTo(0.25, 10);
    for (let t = -500; t < loop * 3; t += 37) {
      const p = loopProgress(t);
      expect(p).toBeGreaterThanOrEqual(0);
      expect(p).toBeLessThanOrEqual(1);
    }
  });
});

describe('coverRect', () => {
  it('takes the middle square of a portrait frame, as tall as it is wide', () => {
    expect(coverRect(1080, 1920, 128, 128)).toEqual({ x: 0, y: 420, w: 1080, h: 1080 });
  });

  it('takes the middle square of a landscape frame, as wide as it is tall', () => {
    expect(coverRect(1920, 1080, 64, 64)).toEqual({ x: 420, y: 0, w: 1080, h: 1080 });
  });

  it('takes a square frame whole', () => {
    expect(coverRect(500, 500, 64, 64)).toEqual({ x: 0, y: 0, w: 500, h: 500 });
  });
});
