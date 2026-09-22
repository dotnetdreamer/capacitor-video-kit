import { describe, expect, it } from 'vitest';

import { TRANSITIONS, compileTransition, lookAt } from '../../editor';
import { WHOLE_FRAME, isTransitionDraw, type LayerDraw } from '../../video-composer/web/painter';
import { sourceWindow } from '../../video-composer/web/geometry';
import { LOOP_HOLD_END_MS, LOOP_HOLD_START_MS, LOOP_RUN_MS, frameSize, loopProgress, thumbDraws, thumbLayer, type ThumbSource } from './transition-thumbs';

/*
 * The arithmetic behind the transition sheet's thumbnails. The drawing is the render's painter and is
 * held to the render in the sheet's browser test; what is held here is that the sheet hands that
 * painter what `web/render.ts` hands it, and hands it frames it can read one texel to a pixel.
 */

/** A frame as far as anything here reads one: its size. */
function frame(width: number, height: number): ThumbSource {
  return { width, height } as ThumbSource;
}

describe('thumbDraws', () => {
  const from = thumbLayer(frame(128, 228));
  const to = thumbLayer(frame(228, 128));

  it('is one transition in the base track’s place, at the moment asked for, for every kind in the catalogue', () => {
    for (const preset of TRANSITIONS) {
      const compiled = compileTransition(preset.id)!;
      for (const p of [0, preset.posterAt, 0.73, 1]) {
        const draws = thumbDraws(from, to, preset.id, p);
        expect(draws).toHaveLength(1);
        const draw = draws[0];
        if (!isTransitionDraw(draw)) throw new Error(`${preset.id} drew no transition`);
        expect(draw.from).toBe(from);
        expect(draw.to).toBe(to);
        // The render's own evaluation of the render's own curves - not a look of the sheet's.
        expect(draw.look).toEqual(lookAt(compiled.curves, p));
        expect(draw.transition).toBe(compiled);
      }
    }
  });

  it('draws the outgoing side alone for a kind it does not know, as a render draws a cut', () => {
    expect(thumbDraws(from, to, 'no-such-transition', 0.5)).toEqual([from]);
    expect(thumbDraws(null, to, 'no-such-transition', 0.5)).toEqual([]);
  });

  it('keeps a side with no picture as absent rather than inventing one', () => {
    const [draw] = thumbDraws(null, to, 'dissolve', 0.5);
    expect(isTransitionDraw(draw) && draw.from).toBeNull();
  });
});

describe('thumbLayer', () => {
  it('is the plain base-track layer, fitted cover into the whole frame', () => {
    const picture = frame(128, 228);
    const layer: LayerDraw = thumbLayer(picture);
    expect(layer).toEqual({ source: picture, sourceWidth: 128, sourceHeight: 228, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1 });
  });
});

describe('frameSize', () => {
  it('brings a portrait frame’s width to the tile, the part cover shows', () => {
    // A filmstrip frame is 90x160; at 2x the tile is 128.
    expect(frameSize(90, 160, 128)).toEqual({ width: 128, height: 228 });
    expect(frameSize(1080, 1920, 128)).toEqual({ width: 128, height: 228 });
  });

  it('brings a landscape frame’s height to the tile', () => {
    expect(frameSize(1920, 1080, 128)).toEqual({ width: 228, height: 128 });
  });

  it('takes a square frame as the tile', () => {
    expect(frameSize(500, 500, 64)).toEqual({ width: 64, height: 64 });
  });

  it('never makes a side shorter than the tile, and never a size of nothing', () => {
    expect(frameSize(0, 160, 128)).toEqual({ width: 128, height: 128 });
    expect(frameSize(160, 159.9, 128)).toEqual({ width: 128, height: 128 });
  });

  it('lands the cover window on whole pixels, so the tile is read one texel to a pixel', () => {
    for (const [w, h] of [
      [90, 160],
      [1080, 1920],
      [720, 1280],
      [480, 854],
      [1920, 1080],
      [3, 4],
      [1080, 1350],
    ]) {
      for (const cell of [64, 96, 128]) {
        const size = frameSize(w, h, cell);
        expect(Math.min(size.width, size.height)).toBe(cell);
        const window = sourceWindow({ fit: 'cover' }, { width: cell, height: cell }, size.width, size.height);
        // The window's corner in the frame's own pixels, and how many of them one tile pixel spans.
        expect(window.x * size.width).toBeCloseTo(Math.round(window.x * size.width), 6);
        expect(window.y * size.height).toBeCloseTo(Math.round(window.y * size.height), 6);
        expect((window.w * size.width) / cell).toBeCloseTo(1, 6);
        expect((window.h * size.height) / cell).toBeCloseTo(1, 6);
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
