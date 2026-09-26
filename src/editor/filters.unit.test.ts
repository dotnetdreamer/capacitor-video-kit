import { describe, expect, it } from 'vitest';

import { apply, fold } from '../video-composer/web/color-matrix';
import { FILTER_CATEGORIES, FILTER_PRESETS, filterPreset, neutralAdjust, resolveFilterOps } from './edit-manifest';

/*
 * The filter presets as numbers: the catalogue a sheet and an agent read, the one rule every preset
 * keeps (tints last), and the promise the graded looks make - a look, not a colour wash, on ordinary
 * footage at the strengths a customer actually leaves them at.
 */

const GRADES = ['cinematic', 'moody', 'kodak', 'fuji', 'y2k', 'cyber', 'dusk', 'sepia'];

/** A grey of `v` through a preset at `intensity`. */
function grey(id: string, v: number, intensity = 1): [number, number, number] {
  const ops = resolveFilterOps({ filterId: id, filterIntensity: intensity, adjust: neutralAdjust() });
  return apply(fold(ops), v, v, v);
}

describe('the filter catalogue', () => {
  it('has unique ids and labels, each in a real category, and something in every category', () => {
    const categories = new Set(FILTER_CATEGORIES.map(c => c.id));
    expect(new Set(FILTER_PRESETS.map(p => p.id)).size).toBe(FILTER_PRESETS.length);
    expect(new Set(FILTER_PRESETS.map(p => p.label)).size).toBe(FILTER_PRESETS.length);
    for (const preset of FILTER_PRESETS) expect(categories.has(preset.category), preset.id).toBe(true);
    for (const category of categories) {
      expect(
        FILTER_PRESETS.some(p => p.category === category && p.id !== 'none'),
        category,
      ).toBe(true);
    }
    for (const id of GRADES) expect(filterPreset(id).id).toBe(id);
  });

  it('keeps every tint at the end of its preset', () => {
    for (const preset of FILTER_PRESETS) {
      const firstTint = preset.ops.findIndex(op => op.op === 'tint');
      if (firstTint < 0) continue;
      expect(
        preset.ops.slice(firstTint).every(op => op.op === 'tint'),
        preset.id,
      ).toBe(true);
    }
  });
});

describe('the graded looks', () => {
  it('stay looks at full strength: black stays dark, white stays light, and a mid grey moves only so far', () => {
    for (const id of GRADES) {
      const black = grey(id, 0);
      const white = grey(id, 1);
      expect(Math.max(...black), `${id} black`).toBeLessThan(0.1);
      expect(Math.min(...white), `${id} white`).toBeGreaterThan(0.8);
      // Sepia is a colour wash by definition, and is held to being brown instead.
      if (id === 'sepia') continue;
      for (const c of grey(id, 0.5)) expect(Math.abs(c - 0.5), `${id} mid grey`).toBeLessThan(0.12);
    }
    const [r, g, b] = grey('sepia', 0.5);
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });

  it('grade cinematic cool in the shadows and warm in the light', () => {
    const [sr, , sb] = grey('cinematic', 0.15);
    const [hr, , hb] = grey('cinematic', 0.85);
    expect(sb).toBeGreaterThan(sr);
    expect(hr).toBeGreaterThan(hb);
  });

  it('warm kodak, lift moody to a matte, and brighten y2k', () => {
    const [kr, , kb] = grey('kodak', 0.5);
    expect(kr).toBeGreaterThan(kb);
    expect(Math.min(...grey('moody', 0))).toBeGreaterThan(0);
    expect(Math.max(...grey('moody', 1))).toBeLessThan(1);
    expect(grey('y2k', 0.6)[1]).toBeGreaterThan(0.6);
  });

  it('come back to the picture as the strength comes down', () => {
    for (const id of GRADES) {
      const full = grey(id, 0.5, 1);
      const most = grey(id, 0.5, 0.7);
      for (let c = 0; c < 3; c++) expect(Math.abs(most[c] - 0.5), id).toBeLessThanOrEqual(Math.abs(full[c] - 0.5) + 1e-9);
    }
  });
});
