import { describe, expect, it } from 'vitest';

import { layoutPreset } from '../../editor';
import { LAYOUT_CHIPS, matchLayoutPreset } from './layout-chips';

/**
 * The two ways the layout row can be quietly wrong: a diagram that draws something plausible but
 * not the arrangement it names, and a match that misses so no chip lights up after a tap.
 */

describe('LAYOUT_CHIPS', () => {
  it('names every preset, in the order the presets are written in', () => {
    expect(LAYOUT_CHIPS.map(chip => chip.id)).toEqual(['full', 'splitTopBottom', 'splitLeftRight', 'pipTL', 'pipTR', 'pipBL', 'pipBR']);
  });

  it('draws a preset with no rectangle of its own over the whole frame, which is what absent means', () => {
    const full = LAYOUT_CHIPS[0];
    expect(full.base).toEqual({ x: 0, y: 0, w: 100, h: 100 });
    expect(full.track).toEqual({ x: 0, y: 0, w: 100, h: 100 });
  });

  it('is in percentages, so the split halves are halves of the little frame', () => {
    const split = LAYOUT_CHIPS[1];
    expect(split.base).toEqual({ x: 0, y: 0, w: 100, h: 50 });
    expect(split.track).toEqual({ x: 0, y: 50, w: 100, h: 50 });
  });

  it('keeps a corner window square in the frame, so it is a smaller share of the tall side', () => {
    const corner = LAYOUT_CHIPS[4];
    // The frame is 9:16, so a window that is square on screen covers less of the height than of
    // the width. Percentages that came out equal would be the factor of the aspect gone missing.
    expect(corner.track.h).toBeLessThan(corner.track.w);
    expect(corner.track.h).toBeCloseTo(corner.track.w * (720 / 1280), 6);
    expect(corner.track.x + corner.track.w).toBeCloseTo(96, 6);
  });
});

describe('matchLayoutPreset', () => {
  it('reads an absent pair as the full frame rather than as no arrangement', () => {
    expect(matchLayoutPreset(null, null)).toBe('full');
  });

  it('finds the preset a pair of rectangles came from', () => {
    const preset = layoutPreset('splitTopBottom');
    expect(matchLayoutPreset(preset.base, preset.track)).toBe('splitTopBottom');
  });

  it('finds it the other way round too, because Swap exchanges the rectangles of the two layers', () => {
    const preset = layoutPreset('splitLeftRight');
    expect(matchLayoutPreset(preset.track, preset.base)).toBe('splitLeftRight');
  });

  it('keeps a corner inset lit after a swap, the base being the one over the whole frame', () => {
    const preset = layoutPreset('pipBR');
    expect(matchLayoutPreset(preset.track, preset.base)).toBe('pipBR');
  });

  it('names no preset for an arrangement none of them holds, which a crop can leave behind', () => {
    expect(matchLayoutPreset({ x: 0, y: 0, w: 1, h: 0.4 }, { x: 0, y: 0.6, w: 1, h: 0.4 })).toBeNull();
  });
});
