import { describe, expect, it } from 'vitest';

import { NEUTRAL_MOTION, OVERLAY_ANIMATIONS, compileOverlayMotion, overlayMotionAt, type OverlayAnimationPart } from '../../editor';

import {
  TILE_HOLD_MS,
  TILE_LEAD_MS,
  TILE_LOOP_MS,
  TILE_TAIL_MS,
  animationChoices,
  animationTabs,
  openingPart,
  tileDemo,
  tileGlyph,
  tilePoseAt,
  tileStyle,
} from './animation-tiles';

/*
 * The one promise these helpers exist to keep is that a tile IS its preset: the tile's clock is the
 * render's clock shifted, and at every moment the pose is what the render's own compiler and sampler
 * say the layer is at the same point of the same move. The rest is which tiles a layer is offered and
 * where a tile's pass starts over.
 */

describe('animationTabs and animationChoices', () => {
  it('gives text, stickers and photos In, Out and Loop, and the whole catalogue on each', () => {
    for (const kind of ['text', 'sticker', 'image'] as const) {
      expect(animationTabs(kind).map(tab => tab.label)).toEqual(['In', 'Out', 'Loop']);
      for (const part of ['in', 'out', 'loop'] as const) expect(animationChoices(kind, part)).toBe(OVERLAY_ANIMATIONS[part]);
    }
  });

  it('gives an effect a fade in and a fade out, and nothing to loop', () => {
    expect(animationTabs('effect').map(tab => tab.label)).toEqual(['In', 'Out']);
    expect(animationChoices('effect', 'in').map(preset => preset.id)).toEqual(['fade']);
    expect(animationChoices('effect', 'out').map(preset => preset.id)).toEqual(['fade']);
    expect(animationChoices('effect', 'loop')).toEqual([]);
  });

  it('opens on the first part the layer has, or In', () => {
    expect(openingPart('text', null)).toBe('in');
    expect(openingPart('sticker', { loop: { id: 'pulse', periodMs: 1000 } })).toBe('loop');
    expect(openingPart('sticker', { out: { id: 'fade', durationMs: 400 }, loop: { id: 'pulse', periodMs: 1000 } })).toBe('out');
    // An effect has no Loop tab to open on.
    expect(openingPart('effect', { loop: { id: 'breathe', periodMs: 2000 } })).toBe('in');
  });
});

describe('tileDemo', () => {
  it('shows an in arriving after an empty lead, then holding, and starting again', () => {
    const demo = tileDemo('in', 'pop', 470, 'sticker');
    expect(demo.cycleMs).toBe(TILE_LEAD_MS + 470 + TILE_HOLD_MS);
    // Not on the tile before it arrives, which is what an in is.
    expect(tilePoseAt(demo, 0)).toBeNull();
    expect(tilePoseAt(demo, TILE_LEAD_MS - 1)).toBeNull();
    // Landed and at rest for the hold.
    expect(tilePoseAt(demo, TILE_LEAD_MS + 470 + 100)).toEqual(NEUTRAL_MOTION);
    // And round again: a pass later is the same moment.
    expect(tilePoseAt(demo, demo.cycleMs + 10)).toBeNull();
  });

  it('is the render’s move, moment for moment, for every in, out and loop on every kind', () => {
    // The layer placed anywhere on a post, as the render compiles it, against the tile's own clock.
    const at = 7300;
    for (const kind of ['text', 'sticker', 'effect'] as const) {
      for (const part of ['in', 'out', 'loop'] as const satisfies readonly OverlayAnimationPart[]) {
        for (const preset of OVERLAY_ANIMATIONS[part]) {
          const demo = tileDemo(part, preset.id, preset.defaultMs, kind);
          const window = { startMs: at, endMs: at + (demo.toMs - demo.fromMs) };
          const animation = part === 'loop' ? { loop: { id: preset.id, periodMs: preset.defaultMs } } : { [part]: { id: preset.id, durationMs: preset.defaultMs } };
          const render = compileOverlayMotion(window, animation, kind);
          for (const f of [0, 0.1, 0.33, 0.5, 0.77, 0.99]) {
            const into = f * (demo.toMs - demo.fromMs);
            const onTile = tilePoseAt(demo, demo.fromMs + into);
            const inFile = overlayMotionAt(render, at + into) ?? NEUTRAL_MOTION;
            // Close rather than equal only because the two clocks are offset by different amounts,
            // which moves the last bits of a division; a millionth is far under anything drawn.
            const label = `${kind} ${part} ${preset.id} at ${f}`;
            expect(onTile, label).not.toBeNull();
            for (const channel of ['x', 'y', 'scale', 'rotation', 'opacity'] as const) {
              expect(onTile![channel], `${label}: ${channel}`).toBeCloseTo(inFile[channel], 6);
            }
          }
        }
      }
    }
  });

  it('holds an out at rest first, lets it leave, and leaves the tile empty for a beat', () => {
    const demo = tileDemo('out', 'sink', 400, 'text');
    expect(demo.cycleMs).toBe(TILE_HOLD_MS + 400 + TILE_TAIL_MS);
    expect(tilePoseAt(demo, 0)).toEqual(NEUTRAL_MOTION);
    expect(tilePoseAt(demo, TILE_HOLD_MS + 200)?.opacity).toBeLessThan(1);
    expect(tilePoseAt(demo, TILE_HOLD_MS + 400 + 10)).toBeNull();
  });

  it('plays whole cycles of a loop, so the pass meets the next without a jump', () => {
    const demo = tileDemo('loop', 'sway', 700, 'sticker');
    // Three cycles of 700 are the fewest that cover the least a loop's tile plays.
    expect(demo.cycleMs).toBe(2100);
    expect(demo.cycleMs).toBeGreaterThanOrEqual(TILE_LOOP_MS);
    const end = tilePoseAt(demo, demo.cycleMs - 1)!;
    const start = tilePoseAt(demo, demo.cycleMs)!;
    expect(Math.abs(end.rotation - start.rotation)).toBeLessThan(0.2);
    // Always on the tile: a loop has no empty frame.
    expect(tilePoseAt(demo, 0)).not.toBeNull();
  });

  it('moves an effect only by its opacity, as the render does', () => {
    const demo = tileDemo('in', 'pop', 470, 'effect');
    for (let t = demo.fromMs; t < demo.toMs; t += 40) {
      const pose = tilePoseAt(demo, t)!;
      expect({ x: pose.x, y: pose.y, scale: pose.scale, rotation: pose.rotation }).toEqual({ x: 0, y: 0, scale: 1, rotation: 0 });
    }
  });
});

describe('tileGlyph and tileStyle', () => {
  it('fits the layer into the glyph box and scales the frame with it', () => {
    // A caption half the frame wide and a tenth as tall, on a 720 x 1280 post: as wide as the box.
    const fit = tileGlyph({ w: 360, h: 128 }, { width: 720, height: 1280 }, { w: 48, h: 36 });
    expect(fit.w).toBeCloseTo(48, 6);
    expect(fit.h).toBeCloseTo(128 * (48 / 360), 6);
    // The frame is twice the caption's width at the same scale.
    expect(fit.reach.x).toBeCloseTo(96, 6);
    expect(fit.reach.y).toBeCloseTo(1280 * (48 / 360), 6);

    // A tall sticker is as tall as the box instead.
    const tall = tileGlyph({ w: 100, h: 200 }, { width: 720, height: 1280 }, { w: 48, h: 36 });
    expect(tall.w).toBeCloseTo(18, 6);
    expect(tall.h).toBeCloseTo(36, 6);
  });

  it('takes a layer it cannot measure to be a third of the frame, and square', () => {
    const fit = tileGlyph(null, { width: 720, height: 1280 }, { w: 48, h: 36 });
    expect(fit.w).toBeCloseTo(36, 6);
    expect(fit.h).toBeCloseTo(36, 6);
    expect(fit.reach.x).toBeCloseTo(36 / 0.33, 6);
  });

  it('writes a pose as the painter applies it, and nothing at all at rest', () => {
    expect(tileStyle(null, { x: 100, y: 200 })).toEqual({ transform: 'none', opacity: '0' });
    expect(tileStyle(NEUTRAL_MOTION, { x: 100, y: 200 })).toEqual({ transform: 'none', opacity: '1' });
    expect(tileStyle({ x: 0.12, y: -0.05, scale: 1.2, rotation: -14, opacity: 0.5 }, { x: 100, y: 200 })).toEqual({
      transform: 'translate(12px, -10px) rotate(-14deg) scale(1.2)',
      opacity: '0.5',
    });
  });
});
