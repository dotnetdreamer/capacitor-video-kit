import { describe, expect, it } from 'vitest';

import { layoutPreset } from '../../editor';
import { layoutChips, matchLayoutPreset } from './layout-chips';

/**
 * The two ways the layout row can be quietly wrong: a diagram that draws something plausible but
 * not the arrangement it names, and a match that misses so no chip lights up after a tap.
 */

/** The portrait post this editor started as, and the shape most of these are written against. */
const PORTRAIT = 720 / 1280;
/** The same post turned on its side, which is the other shape a customer may choose. */
const LANDSCAPE = 1280 / 720;
const LAYOUT_CHIPS = layoutChips(PORTRAIT);

describe('layoutChips', () => {
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

  it('turns that window the other way up on a landscape frame', () => {
    // The same square on screen, and so a LARGER share of the height once the height is the short
    // side. A row of diagrams computed once, at load, went on drawing the portrait ones here.
    const corner = layoutChips(LANDSCAPE)[4];

    expect(corner.track.h).toBeGreaterThan(corner.track.w);
    expect(corner.track.h).toBeCloseTo(corner.track.w * LANDSCAPE, 6);
  });
});

describe('matchLayoutPreset', () => {
  it('reads an absent pair as the full frame rather than as no arrangement', () => {
    expect(matchLayoutPreset(null, null, PORTRAIT)).toBe('full');
  });

  it('finds the preset a pair of rectangles came from', () => {
    const preset = layoutPreset('splitTopBottom', PORTRAIT);
    expect(matchLayoutPreset(preset.base, preset.track, PORTRAIT)).toBe('splitTopBottom');
  });

  it('finds it the other way round too, an arrangement being the same one with its halves exchanged', () => {
    const preset = layoutPreset('splitLeftRight', PORTRAIT);
    expect(matchLayoutPreset(preset.track, preset.base, PORTRAIT)).toBe('splitLeftRight');
  });

  it('keeps a corner inset lit with the base in the corner, which is a post an older build saved', () => {
    const preset = layoutPreset('pipBR', PORTRAIT);
    expect(matchLayoutPreset(preset.track, preset.base, PORTRAIT)).toBe('pipBR');

    // And a corner cut for a LANDSCAPE frame is not the portrait one: the same id, different
    // numbers, so a post laid out on one shape does not light a chip on the other.
    expect(matchLayoutPreset(preset.track, preset.base, LANDSCAPE)).toBeNull();
  });

  it('names no preset for an arrangement none of them holds, which a crop can leave behind', () => {
    expect(matchLayoutPreset({ x: 0, y: 0, w: 1, h: 0.4 }, { x: 0, y: 0.6, w: 1, h: 0.4 }, PORTRAIT)).toBeNull();
  });
});
