import { describe, expect, it } from 'vitest';

import { EFFECT_CATEGORIES, EFFECT_PRESETS, drawEffect, effectPreset } from './effects';

/*
 * The full-frame effects, drawn by a real canvas: the catalogue a sheet and an agent read, and the
 * promises the drawings make - the same pixels every time they are drawn, marks where the effect
 * says it puts them, and nothing where it says it leaves the picture alone.
 */

const W = 180;
const H = 320;

/** An effect drawn on a fresh transparent canvas, as its RGBA bytes. */
function drawn(id: string, w = W, h = H): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  drawEffect(g, id, w, h);
  return g.getImageData(0, 0, w, h).data;
}

/** The mean alpha, 0..1, of the rows `y0..y1` and columns `x0..x1` of a drawing, as fractions of it. */
function coverage(data: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number, w = W, h = H): number {
  let sum = 0;
  let n = 0;
  for (let y = Math.floor(y0 * h); y < Math.floor(y1 * h); y++) {
    for (let x = Math.floor(x0 * w); x < Math.floor(x1 * w); x++) {
      sum += data[(y * w + x) * 4 + 3];
      n++;
    }
  }
  return n ? sum / n / 255 : 0;
}

describe('the effects catalogue', () => {
  it('has unique ids and labels, each in a real category, and finds each by id', () => {
    const categories = new Set(EFFECT_CATEGORIES.map(c => c.id));
    expect(new Set(EFFECT_PRESETS.map(p => p.id)).size).toBe(EFFECT_PRESETS.length);
    expect(new Set(EFFECT_PRESETS.map(p => p.label)).size).toBe(EFFECT_PRESETS.length);
    for (const preset of EFFECT_PRESETS) {
      expect(categories.has(preset.category), preset.id).toBe(true);
      expect(effectPreset(preset.id)).toEqual(preset);
    }
    for (const id of ['confetti', 'sparkle', 'flare', 'dust', 'scanlines', 'rec', 'paper', 'flash-frame', 'letterbox', 'glow']) {
      expect(effectPreset(id), id).not.toBeNull();
    }
  });

  it('draws every effect, and the same pixels each time it is drawn', () => {
    for (const preset of EFFECT_PRESETS) {
      const once = drawn(preset.id);
      expect(coverage(once, 0, 0, 1, 1), `${preset.id} drew nothing`).toBeGreaterThan(0);
      expect(
        drawn(preset.id).every((byte, i) => byte === once[i]),
        `${preset.id} drew differently the second time`,
      ).toBe(true);
    }
  });
});

describe('the effects a template times to its music', () => {
  it('flashes plain white, all of it, at full strength', () => {
    const data = drawn('flash-frame');
    for (let i = 0; i < data.length; i += 4) {
      if (data[i] !== 255 || data[i + 1] !== 255 || data[i + 2] !== 255 || data[i + 3] !== 255) throw new Error(`not white at ${i / 4}`);
    }
  });

  it('letterboxes with bars thinner than Cinema, and nothing between them', () => {
    const bars = drawn('letterbox');
    const cinema = drawn('cinema');
    // A bar row is solid; the picture between is untouched.
    expect(coverage(bars, 0, 0, 1, 0.05)).toBe(1);
    expect(coverage(bars, 0, 0.95, 1, 1)).toBe(1);
    expect(coverage(bars, 0, 0.08, 1, 0.92)).toBe(0);
    // Cinema still covers where Letterbox has stopped.
    expect(coverage(cinema, 0, 0.08, 1, 0.1)).toBe(1);
  });

  it('scatters confetti along the top and the sides and keeps the middle nearly clear', () => {
    const data = drawn('confetti', 360, 640);
    const top = coverage(data, 0, 0, 1, 0.15, 360, 640);
    const middle = coverage(data, 0.3, 0.35, 0.7, 0.65, 360, 640);
    // Pieces are small, so even the busy top is mostly picture: a few percent of it is confetti.
    expect(top).toBeGreaterThan(0.015);
    expect(middle).toBeLessThan(top / 3);
  });

  it('leaves the middle of the camcorder and paper frames to the picture', () => {
    for (const id of ['rec', 'paper']) {
      const data = drawn(id);
      expect(coverage(data, 0.25, 0.3, 0.75, 0.7), id).toBe(0);
    }
    // The paper border is solid all the way round.
    const paper = drawn('paper');
    expect(coverage(paper, 0, 0, 1, 0.02)).toBe(1);
    expect(coverage(paper, 0, 0, 0.02, 1)).toBe(1);
  });

  it('draws the same scatter at the size of a thumbnail and at the size of a render', () => {
    // Every drawer takes the same numbers from its seed in the same order whatever the canvas, so
    // the thumbnail a customer picks is the render in miniature: compared on a coarse grid, where
    // antialiasing at the two sizes cannot tell them apart.
    for (const id of ['confetti', 'sparkle', 'dust']) {
      const small = drawn(id, 180, 320);
      const large = drawn(id, 360, 640);
      let agree = 0;
      let cells = 0;
      for (let cy = 0; cy < 16; cy++) {
        for (let cx = 0; cx < 9; cx++) {
          const a = coverage(small, cx / 9, cy / 16, (cx + 1) / 9, (cy + 1) / 16, 180, 320);
          const b = coverage(large, cx / 9, cy / 16, (cx + 1) / 9, (cy + 1) / 16, 360, 640);
          cells++;
          if (Math.abs(a - b) < 0.05) agree++;
        }
      }
      expect(agree / cells, id).toBeGreaterThan(0.9);
    }
  });
});
