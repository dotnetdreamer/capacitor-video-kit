import { describe, expect, it, vi } from 'vitest';

import { MAX_OVERLAY_MOTION_KEYS, type ComposeOverlayMotion, type ComposeSpec } from '../video-composer/definitions';
import { overlayMotionFor, overlayWireWindow, toComposeSpec } from './compose';
import { MANIFEST_VERSION, defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest, type EditOverlay, type OverlayAnimation } from './edit-manifest';
import { duplicateOverlay, patchOverlay, splitOverlayAt } from './edit-ops';
import {
  MAX_MOTION_RASTER_DETAIL,
  MAX_OVERLAY_LOOP_MS,
  MAX_OVERLAY_MOVE_MS,
  MIN_OVERLAY_LOOP_MS,
  MIN_OVERLAY_MOVE_MS,
  NEUTRAL_MOTION,
  OVERLAY_ANIMATIONS,
  OverlayMotionError,
  compileOverlayMotion,
  isNeutralMotion,
  normaliseOverlayAnimation,
  normaliseOverlayMotion,
  overlayAnimationCurve,
  overlayAnimationSpans,
  overlayMotionAt,
  overlayRasterDetail,
  type OverlayAnimationPart,
  type OverlayMotionSample,
} from './motion';
import { rasteriseOverlay } from './overlay-raster';
import type { RasterContext } from './raster-context';

/* The mock DOM has no 2D canvas: a layer "drawn" here says which layer it was, and at what detail. */
vi.mock('./overlay-raster', async importOriginal => {
  const actual = await importOriginal<typeof import('./overlay-raster')>();
  return {
    ...actual,
    rasteriseOverlay: vi.fn(async (overlay: EditOverlay, _ctx: unknown, options?: { detail?: number }) => ({
      png: `drawn:${overlay.id}@${options?.detail ?? 1}`,
      wPx: 100,
      hPx: 50,
    })),
  };
});
const rasterise = vi.mocked(rasteriseOverlay);

/*
 * The one place a layer's moves are eased. Everything downstream - the web render, the preview, the
 * two native engines - reads straight lines between the keys this writes, so what is pinned here is
 * what every engine draws: each preset starts and ends where it must, a loop picks up where the in
 * left off and keeps its phase, an effect only ever fades, and a long layer stays under the key cap
 * without its loop turning into a different move.
 */

const PARTS: readonly OverlayAnimationPart[] = ['in', 'out', 'loop'];

function near(actual: OverlayMotionSample | null, expected: Partial<OverlayMotionSample>, digits = 6): void {
  const full = { ...NEUTRAL_MOTION, ...expected };
  const got = actual ?? NEUTRAL_MOTION;
  for (const key of Object.keys(full) as (keyof OverlayMotionSample)[]) {
    expect(got[key], key).toBeCloseTo(full[key], digits);
  }
}

/** The curve sampled finely: its smallest and largest value of one channel over 0..1. */
function range(part: OverlayAnimationPart, id: string, channel: keyof OverlayMotionSample, move?: { ms?: number; kind?: EditOverlay['kind'] }): [number, number] {
  let lo = Infinity;
  let hi = -Infinity;
  for (let i = 0; i <= 2000; i++) {
    const v = overlayAnimationCurve(part, id, i / 2000, move)![channel];
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
  }
  return [lo, hi];
}

describe('the catalogue', () => {
  it('has every preset the templates are written against, each with a curve, a label and a default in range', () => {
    const ids = (part: OverlayAnimationPart) => OVERLAY_ANIMATIONS[part].map(preset => preset.id);
    expect(ids('in')).toEqual(expect.arrayContaining(['fade', 'pop', 'slam', 'stamp', 'soft', 'grow', 'rise', 'drop', 'slide-left', 'slide-right', 'swing', 'spin', 'flicker']));
    expect(ids('out')).toEqual(expect.arrayContaining(['fade', 'pop', 'grow', 'shrink', 'sink', 'lift', 'slide-left', 'slide-right', 'spin', 'flicker']));
    expect(ids('loop')).toEqual(expect.arrayContaining(['pulse', 'beat', 'heartbeat', 'float', 'sway', 'wiggle', 'shake', 'spin', 'breathe']));
    for (const part of PARTS) {
      expect(new Set(ids(part)).size).toBe(ids(part).length);
      for (const preset of OVERLAY_ANIMATIONS[part]) {
        expect(preset.label.trim().length).toBeGreaterThan(0);
        expect(overlayAnimationCurve(part, preset.id, 0.5)).not.toBeNull();
        const [min, max] = part === 'loop' ? [MIN_OVERLAY_LOOP_MS, MAX_OVERLAY_LOOP_MS] : [MIN_OVERLAY_MOVE_MS, MAX_OVERLAY_MOVE_MS];
        expect(preset.defaultMs).toBeGreaterThanOrEqual(min);
        expect(preset.defaultMs).toBeLessThanOrEqual(max);
      }
    }
    expect(overlayAnimationCurve('in', 'nope', 0.5)).toBeNull();
    // A loop's name is not an in's.
    expect(overlayAnimationCurve('in', 'pulse', 0.5)).toBeNull();
  });

  it('gives exits a little less time than the entrances they mirror, and loops whole beats at 120 bpm', () => {
    const inMs = (id: string) => OVERLAY_ANIMATIONS.in.find(preset => preset.id === id)!.defaultMs;
    for (const out of OVERLAY_ANIMATIONS.out) {
      const mirror = OVERLAY_ANIMATIONS.in.find(preset => preset.id === out.id);
      if (mirror) expect(out.defaultMs).toBeLessThanOrEqual(inMs(out.id));
    }
    for (const loop of OVERLAY_ANIMATIONS.loop) expect(loop.defaultMs % 500).toBe(0);
  });
});

describe('every preset', () => {
  const moves = [
    { ms: undefined, kind: 'text' as const },
    { ms: undefined, kind: 'sticker' as const },
    { ms: 250, kind: 'text' as const },
    { ms: 250, kind: 'sticker' as const },
  ];

  it('ends an IN exactly at rest, whatever it is moving and however short it runs', () => {
    for (const preset of OVERLAY_ANIMATIONS.in) {
      for (const move of moves) near(overlayAnimationCurve('in', preset.id, 1, move), {}, 9);
    }
  });

  it('starts an OUT exactly at rest', () => {
    for (const preset of OVERLAY_ANIMATIONS.out) {
      for (const move of moves) near(overlayAnimationCurve('out', preset.id, 0, move), {}, 9);
    }
  });

  it('starts every loop at rest and meets itself one period on', () => {
    for (const preset of OVERLAY_ANIMATIONS.loop) {
      near(overlayAnimationCurve('loop', preset.id, 0), {}, 9);
      for (const f of [0.1, 0.33, 0.5, 0.77]) {
        const a = overlayAnimationCurve('loop', preset.id, f)!;
        const b = overlayAnimationCurve('loop', preset.id, f + 1)!;
        near(b, a, 9);
      }
    }
  });

  it('starts each IN where it says it comes from', () => {
    near(overlayAnimationCurve('in', 'fade', 0), { opacity: 0 });
    near(overlayAnimationCurve('in', 'pop', 0), { scale: 0, opacity: 0 });
    near(overlayAnimationCurve('in', 'slam', 0), { scale: 1.8, opacity: 0 });
    // Snaps on: there at once, opaque.
    near(overlayAnimationCurve('in', 'stamp', 0), { scale: 1.6 });
    near(overlayAnimationCurve('in', 'soft', 0), { scale: 1.08, opacity: 0 });
    near(overlayAnimationCurve('in', 'grow', 0), { scale: 0.6, opacity: 0 });
    near(overlayAnimationCurve('in', 'rise', 0), { y: 0.06, opacity: 0 });
    near(overlayAnimationCurve('in', 'drop', 0), { y: -0.12, opacity: 0 });
    // Slide LEFT travels left, so it comes in from the right; the transitions name it the same way.
    near(overlayAnimationCurve('in', 'slide-left', 0), { x: 0.12, opacity: 0 });
    near(overlayAnimationCurve('in', 'slide-right', 0), { x: -0.12, opacity: 0 });
    near(overlayAnimationCurve('in', 'swing', 0), { rotation: -14, opacity: 0 });
    near(overlayAnimationCurve('in', 'spin', 0), { rotation: -180, scale: 0.3, opacity: 0 });
    near(overlayAnimationCurve('in', 'flicker', 0), { opacity: 0 });
  });

  it('ends each OUT where it says it goes', () => {
    near(overlayAnimationCurve('out', 'fade', 1), { opacity: 0 });
    near(overlayAnimationCurve('out', 'pop', 1), { scale: 0, opacity: 0 });
    near(overlayAnimationCurve('out', 'grow', 1), { scale: 1.5, opacity: 0 });
    near(overlayAnimationCurve('out', 'shrink', 1), { scale: 0, opacity: 0 });
    near(overlayAnimationCurve('out', 'sink', 1), { y: 0.06, opacity: 0 });
    near(overlayAnimationCurve('out', 'lift', 1), { y: -0.06, opacity: 0 });
    near(overlayAnimationCurve('out', 'slide-left', 1), { x: -0.12, opacity: 0 });
    near(overlayAnimationCurve('out', 'slide-right', 1), { x: 0.12, opacity: 0 });
    near(overlayAnimationCurve('out', 'spin', 1), { rotation: 180, scale: 0.3, opacity: 0 });
    near(overlayAnimationCurve('out', 'flicker', 1), { opacity: 0 });
  });

  it('pops like CapCut: to 1.2, back to 0.9, 1.05 and home, faded up in the first 120 ms', () => {
    expect(range('in', 'pop', 'scale')[1]).toBeCloseTo(1.2, 3);
    near(overlayAnimationCurve('in', 'pop', 0.36), { scale: 1.2 }, 3);
    near(overlayAnimationCurve('in', 'pop', 0.6), { scale: 0.9 }, 3);
    near(overlayAnimationCurve('in', 'pop', 0.8), { scale: 1.05 }, 3);
    // 120 ms of a 470 ms pop.
    expect(overlayAnimationCurve('in', 'pop', 120 / 470)!.opacity).toBeCloseTo(1, 6);
    expect(overlayAnimationCurve('in', 'pop', 60 / 470)!.opacity).toBeLessThan(1);
    // Text stays level; a sticker turns from -12 degrees with the bounce.
    expect(range('in', 'pop', 'rotation')).toEqual([0, 0]);
    expect(overlayAnimationCurve('in', 'pop', 0, { kind: 'sticker' })!.rotation).toBeCloseTo(-12, 9);
    expect(overlayAnimationCurve('in', 'pop', 0.36, { kind: 'sticker' })!.rotation).toBeCloseTo(2.4, 3);
  });

  it('pops lightly when it is given 300 ms or less: from 0.8 with one small overshoot', () => {
    near(overlayAnimationCurve('in', 'pop', 0, { ms: 250 }), { scale: 0.8, opacity: 0 });
    const [lo, hi] = range('in', 'pop', 'scale', { ms: 250 });
    expect(lo).toBeCloseTo(0.8, 6);
    expect(hi).toBeCloseTo(1.05, 3);
  });

  it('lands a slam and a stamp hard, a little under their size, and a swing past upright', () => {
    const [slamLo] = range('in', 'slam', 'scale');
    expect(slamLo).toBeLessThan(0.97);
    expect(slamLo).toBeGreaterThan(0.9);
    // The shudder is on the landing only.
    expect(overlayAnimationCurve('in', 'slam', 0.3)!.x).toBe(0);
    expect(Math.abs(overlayAnimationCurve('in', 'slam', 0.65)!.x)).toBeGreaterThan(0);
    expect(range('in', 'stamp', 'scale')[0]).toBeCloseTo(0.95, 3);
    expect(range('in', 'stamp', 'opacity')).toEqual([1, 1]);
    const [, swingHi] = range('in', 'swing', 'rotation');
    expect(swingHi).toBeGreaterThan(2.5);
    expect(swingHi).toBeLessThan(4.5);
    // A drop bounces back UP after it lands.
    expect(range('in', 'drop', 'y')[0]).toBeCloseTo(-0.12, 6);
    expect(overlayAnimationCurve('in', 'drop', 0.75)!.y).toBeLessThan(0);
  });

  it('stutters a flicker between dark and lit rather than fading it', () => {
    const levels = new Set<number>();
    for (let i = 0; i <= 200; i++) levels.add(overlayAnimationCurve('in', 'flicker', i / 200)!.opacity);
    expect([...levels].sort()).toEqual([0, 0.15, 0.2, 0.8, 0.9, 1]);
  });

  it('keeps each loop inside the swing the lead asked for', () => {
    expect(range('loop', 'pulse', 'scale')[1]).toBeCloseTo(1.08, 3);
    expect(range('loop', 'beat', 'scale')[1]).toBeCloseTo(1.08, 3);
    expect(range('loop', 'heartbeat', 'scale')[1]).toBeGreaterThan(1.07);
    expect(range('loop', 'sway', 'rotation')).toEqual([expect.closeTo(-6, 3), expect.closeTo(6, 3)]);
    expect(range('loop', 'float', 'y')).toEqual([expect.closeTo(-0.008, 5), expect.closeTo(0.008, 5)]);
    expect(range('loop', 'breathe', 'opacity')[0]).toBeCloseTo(0.8, 5);
    const [wiggleLo, wiggleHi] = range('loop', 'wiggle', 'rotation');
    expect(Math.max(-wiggleLo, wiggleHi)).toBeLessThan(6);
    // The beat is still for the second half of its period: the gap between kicks.
    near(overlayAnimationCurve('loop', 'beat', 0.75), {});
    expect(overlayAnimationCurve('loop', 'spin', 0.999)!.rotation).toBeGreaterThan(359);
  });
});

describe('normaliseOverlayAnimation', () => {
  it('drops what this version cannot draw and clamps what it can', () => {
    expect(normaliseOverlayAnimation(undefined)).toBeNull();
    expect(normaliseOverlayAnimation({})).toBeNull();
    expect(normaliseOverlayAnimation({ in: { id: 'teleport', durationMs: 300 } })).toBeNull();
    expect(normaliseOverlayAnimation({ in: { id: 'pop', durationMs: 5 }, out: { id: 'fade', durationMs: 99_000 }, loop: { id: 'pulse', periodMs: 50 } })).toEqual({
      in: { id: 'pop', durationMs: MIN_OVERLAY_MOVE_MS },
      out: { id: 'fade', durationMs: MAX_OVERLAY_MOVE_MS },
      loop: { id: 'pulse', periodMs: MIN_OVERLAY_LOOP_MS },
    });
    expect(normaliseOverlayAnimation({ loop: { id: 'spin', periodMs: 1e9 } })).toEqual({ loop: { id: 'spin', periodMs: MAX_OVERLAY_LOOP_MS } });
    // A length that is not a number is the preset's own.
    expect(normaliseOverlayAnimation({ in: { id: 'stamp', durationMs: 'fast' }, out: { id: 'grow' } })).toEqual({
      in: { id: 'stamp', durationMs: 200 },
      out: { id: 'grow', durationMs: 400 },
    });
    // An in id that is only an out, and a loop id that is only an in, are unknown in their place.
    expect(normaliseOverlayAnimation({ in: { id: 'shrink', durationMs: 300 }, loop: { id: 'pop', periodMs: 500 } })).toBeNull();
  });

  it('hands back the very same object when it was already in shape', () => {
    const normal: OverlayAnimation = { in: { id: 'pop', durationMs: 470 }, loop: { id: 'beat', periodMs: 500 } };
    expect(normaliseOverlayAnimation(normal)).toBe(normal);
    const rounded = { in: { id: 'pop', durationMs: 470.4 } };
    expect(normaliseOverlayAnimation(rounded)).not.toBe(rounded);
    expect(normaliseOverlayAnimation({ ...normal, extra: true })).toEqual(normal);
  });
});

describe('overlayAnimationSpans', () => {
  it('squeezes an in and an out that do not fit, in proportion, and gives the loop the rest', () => {
    const animation: OverlayAnimation = { in: { id: 'fade', durationMs: 600 }, out: { id: 'fade', durationMs: 400 }, loop: { id: 'pulse', periodMs: 1000 } };
    expect(overlayAnimationSpans(animation, 500)).toEqual({ inMs: 300, outMs: 200, loopStartMs: 300, loopEndMs: 300 });
    expect(overlayAnimationSpans(animation, 3000)).toEqual({ inMs: 600, outMs: 400, loopStartMs: 600, loopEndMs: 2600 });
    expect(overlayAnimationSpans({ in: { id: 'pop', durationMs: 470 } }, 3000)).toEqual({ inMs: 470, outMs: 0, loopStartMs: 470, loopEndMs: 470 });
  });
});

describe('compileOverlayMotion', () => {
  const window = { startMs: 1000, endMs: 4000 };

  it('is null for a layer that does not move', () => {
    expect(compileOverlayMotion(window, undefined, 'text')).toBeNull();
    expect(compileOverlayMotion(window, { in: { id: 'warp', durationMs: 300 } } as OverlayAnimation, 'text')).toBeNull();
    expect(compileOverlayMotion({ startMs: 1000, endMs: 1000 }, { in: { id: 'fade', durationMs: 300 } }, 'text')).toBeNull();
    // A pulse has no opacity in it, and an effect shows nothing else.
    expect(compileOverlayMotion(window, { loop: { id: 'pulse', periodMs: 1000 } }, 'effect')).toBeNull();
  });

  it('runs on the output timeline from the start of the window to its end, each move at its end of it', () => {
    const motion = compileOverlayMotion(window, { in: { id: 'slide-left', durationMs: 500 }, out: { id: 'sink', durationMs: 400 } }, 'text')!;
    expect(motion.atMs[0]).toBe(1000);
    expect(motion.atMs[motion.atMs.length - 1]).toBe(4000);
    expect(Object.keys(motion)).toEqual(['atMs', 'x', 'y', 'opacity']);
    near(overlayMotionAt(motion, 1000), { x: 0.12, opacity: 0 });
    // Before the window the first key holds; the layer is not drawn there anyway.
    near(overlayMotionAt(motion, 0), { x: 0.12, opacity: 0 });
    expect(overlayMotionAt(motion, 1500)).toBeNull();
    expect(overlayMotionAt(motion, 2500)).toBeNull();
    expect(overlayMotionAt(motion, 3600)).toBeNull();
    near(overlayMotionAt(motion, 4000), { y: 0.06, opacity: 0 });
    // Between the moves the layer is at rest, and costs two keys, not a key a frame.
    const between = motion.atMs.filter(t => t > 1500 && t < 3600);
    expect(between).toEqual([]);
  });

  it('follows each curve closely at every frame, not only at its keys', () => {
    const motion = compileOverlayMotion({ startMs: 0, endMs: 2000 }, { in: { id: 'pop', durationMs: 470 } }, 'sticker')!;
    // A key a 60th of a second: at the pop's steepest, straight lines between them are off by under
    // a hundredth of the size and a tenth of a degree, which no frame shows.
    for (let ms = 0; ms <= 470; ms += 7) {
      const expected = overlayAnimationCurve('in', 'pop', ms / 470, { ms: 470, kind: 'sticker' })!;
      const got = overlayMotionAt(motion, ms) ?? NEUTRAL_MOTION;
      expect(Math.abs(got.scale - expected.scale), `scale at ${ms}`).toBeLessThan(0.012);
      expect(Math.abs(got.rotation - expected.rotation), `rotation at ${ms}`).toBeLessThan(0.15);
      expect(Math.abs(got.opacity - expected.opacity), `opacity at ${ms}`).toBeLessThan(0.02);
    }
  });

  it('starts a loop where the in ends, with its phase at 0 there, and carries it into the out', () => {
    const animation: OverlayAnimation = { in: { id: 'fade', durationMs: 500 }, loop: { id: 'sway', periodMs: 2000 }, out: { id: 'fade', durationMs: 500 } };
    const motion = compileOverlayMotion({ startMs: 0, endMs: 3000 }, animation, 'text')!;
    // A quarter period into the loop is the top of the sway.
    expect(overlayMotionAt(motion, 500 + 500)!.rotation).toBeCloseTo(6, 2);
    expect(overlayMotionAt(motion, 500 + 1500)!.rotation).toBeCloseTo(-6, 2);
    // The loop ends 2000 ms in, a whole period, at rest - and the out moves from there. Change the
    // window so it ends a quarter of the way through a sway, at its top, and the out keeps the angle
    // the loop had reached rather than snapping the layer upright.
    const mid = compileOverlayMotion({ startMs: 0, endMs: 1500 }, animation, 'text')!;
    const atOutStart = overlayMotionAt(mid, 1000)!;
    expect(atOutStart.rotation).toBeCloseTo(6, 3);
    expect(overlayMotionAt(mid, 1490)!.rotation).toBeCloseTo(6, 3);
    expect(overlayMotionAt(mid, 1250)!.opacity).toBeLessThan(1);
    // No jump at the seam either side of it.
    const before = overlayMotionAt(mid, 999.9)!.rotation;
    expect(Math.abs(before - atOutStart.rotation)).toBeLessThan(0.05);
  });

  it('writes a flicker and a spin wrap as STEPS: two keys at one time', () => {
    const flicker = compileOverlayMotion({ startMs: 0, endMs: 2000 }, { in: { id: 'flicker', durationMs: 800 } }, 'text')!;
    const steps = flicker.atMs.filter((t, i) => i > 0 && flicker.atMs[i - 1] === t);
    expect(steps.length).toBe(7);
    expect(overlayMotionAt(flicker, 79)!.opacity).toBe(0);
    expect(overlayMotionAt(flicker, 80)!.opacity).toBe(0.9);
    expect(Object.keys(flicker)).toEqual(['atMs', 'opacity']);

    const spin = compileOverlayMotion({ startMs: 0, endMs: 3000 }, { loop: { id: 'spin', periodMs: 1000 } }, 'text')!;
    const wraps = spin.atMs.map((t, i) => [t, i] as const).filter(([t, i]) => i > 0 && spin.atMs[i - 1] === t);
    expect(wraps.map(([t]) => t)).toEqual([1000, 2000]);
    for (const [, i] of wraps) {
      expect(spin.rotation![i - 1]).toBeCloseTo(360, 3);
      expect(spin.rotation![i]).toBe(0);
    }
    expect(overlayMotionAt(spin, 1250)!.rotation).toBeCloseTo(90, 1);
  });

  it('reaches an EFFECT only through its opacity', () => {
    const motion = compileOverlayMotion(
      window,
      { in: { id: 'slam', durationMs: 450 }, loop: { id: 'breathe', periodMs: 1000 }, out: { id: 'slide-left', durationMs: 400 } },
      'effect',
    )!;
    expect(Object.keys(motion)).toEqual(['atMs', 'opacity']);
    near(overlayMotionAt(motion, 1000), { opacity: 0 });
    expect(overlayMotionAt(motion, 1450 + 500)!.opacity).toBeCloseTo(0.8, 2);
    near(overlayMotionAt(motion, 4000), { opacity: 0 });
  });

  it('coarsens a long layer to fit the key cap rather than cutting it off', () => {
    const motion = compileOverlayMotion({ startMs: 0, endMs: 3 * 60_000 }, { in: { id: 'pop', durationMs: 470 }, loop: { id: 'pulse', periodMs: 1000 } }, 'text')!;
    expect(motion.atMs.length).toBeLessThanOrEqual(MAX_OVERLAY_MOTION_KEYS);
    expect(motion.atMs[motion.atMs.length - 1]).toBe(3 * 60_000);
    // Still pulsing at the far end of the layer: the loop started as the pop ended, at 470 ms, so
    // half a period on from any whole number of periods after that is the top of a pulse.
    expect(overlayMotionAt(motion, 470 + 170_000 + 500)!.scale).toBeGreaterThan(1.07);
  });

  it('never samples a loop slower than eight keys a cycle, and plays whole cycles of it when that does not fit', () => {
    const motion = compileOverlayMotion({ startMs: 0, endMs: 30 * 60_000 }, { loop: { id: 'shake', periodMs: 500 } }, 'text')!;
    expect(motion.atMs.length).toBeLessThanOrEqual(MAX_OVERLAY_MOTION_KEYS);
    const gaps = motion.atMs.slice(1).map((t, i) => t - motion.atMs[i]);
    const moving = gaps.slice(0, 100);
    expect(Math.max(...moving)).toBeLessThanOrEqual(500 / 8 + 1e-6);
    expect(motion.atMs[motion.atMs.length - 1]).toBe(30 * 60_000);
    // It comes to rest at the end of a whole cycle and stays there.
    expect(overlayMotionAt(motion, 29 * 60_000)).toBeNull();
  });

  it('writes six decimals and whole thousandths of a millisecond', () => {
    const motion = compileOverlayMotion({ startMs: 0, endMs: 3000 }, { loop: { id: 'wiggle', periodMs: 1000 } }, 'sticker')!;
    for (const t of motion.atMs) expect(Math.round(t * 1000) / 1000).toBe(t);
    for (const r of motion.rotation!) expect(Math.round(r * 1e6) / 1e6).toBe(r);
  });
});

describe('overlayMotionAt', () => {
  const motion: ComposeOverlayMotion = { atMs: [100, 200, 200, 300], x: [0.1, 0.2, 0, 0], opacity: [0, 1, 1, 0.5] };

  it('holds the ends, interpolates in straight lines, and steps at equal times', () => {
    expect(overlayMotionAt(null, 0)).toBeNull();
    expect(overlayMotionAt({ atMs: [] }, 0)).toBeNull();
    near(overlayMotionAt(motion, 0), { x: 0.1, opacity: 0 });
    near(overlayMotionAt(motion, 150), { x: 0.15, opacity: 0.5 });
    near(overlayMotionAt(motion, 199.999), { x: 0.2, opacity: 1 }, 4);
    // The later of the two keys at 200 wins, and the layer is at rest there.
    expect(overlayMotionAt(motion, 200)).toBeNull();
    near(overlayMotionAt(motion, 250), { opacity: 0.75 });
    near(overlayMotionAt(motion, 900), { opacity: 0.5 });
  });

  it('is null wherever the layer is at rest, so the still path draws it', () => {
    expect(overlayMotionAt({ atMs: [0, 100], scale: [1, 1] }, 50)).toBeNull();
    expect(isNeutralMotion({ ...NEUTRAL_MOTION, rotation: 1e-9 })).toBe(true);
    expect(isNeutralMotion({ ...NEUTRAL_MOTION, rotation: 0.01 })).toBe(false);
  });

  it('finds the right pair in a long track', () => {
    const n = 5000;
    const long: ComposeOverlayMotion = { atMs: Array.from({ length: n }, (_, i) => i * 10), scale: Array.from({ length: n }, (_, i) => 1 + (i % 2)) };
    expect(overlayMotionAt(long, 43_212.5)!.scale).toBeCloseTo(1.75, 9);
  });
});

describe('normaliseOverlayMotion', () => {
  const fieldOf = (value: unknown): string => {
    try {
      normaliseOverlayMotion(value);
    } catch (error) {
      if (error instanceof OverlayMotionError) return `${error.field}|${error.detail}`;
      throw error;
    }
    return 'accepted';
  };

  it('reads no motion, a null one, no times and no keys as absent', () => {
    expect(normaliseOverlayMotion(undefined)).toBeNull();
    expect(normaliseOverlayMotion(null)).toBeNull();
    expect(normaliseOverlayMotion({})).toBeNull();
    expect(normaliseOverlayMotion({ atMs: [] })).toBeNull();
    // Every channel neutral, or none at all, moves nothing.
    expect(normaliseOverlayMotion({ atMs: [0, 100] })).toBeNull();
    expect(normaliseOverlayMotion({ atMs: [0, 100], scale: [1, 1], x: [0, 0] })).toBeNull();
  });

  it('refuses what no engine could honour, naming what broke, in the contract order', () => {
    expect(fieldOf([1, 2])).toBe('|');
    expect(fieldOf('pop')).toBe('|');
    expect(fieldOf({ atMs: 'x' })).toBe('atMs|');
    expect(fieldOf({ atMs: [0, 1], x: [0] })).toBe('x|');
    expect(fieldOf({ atMs: [0, 1], opacity: 'x', scale: [1] })).toBe('scale|');
    expect(fieldOf({ atMs: [0, 1], blur: [0, 1] })).toBe('blur|');
    // The channels before the unknown keys: a broken channel is named first.
    expect(fieldOf({ atMs: [0, 1], blur: [0, 1], y: [0] })).toBe('y|');
    const many = Array.from({ length: MAX_OVERLAY_MOTION_KEYS + 1 }, (_, i) => i);
    expect(fieldOf({ atMs: many, scale: many.map(() => 2) })).toBe(`| at most ${MAX_OVERLAY_MOTION_KEYS} keys`);
    expect(fieldOf({ atMs: [0, Number.NaN], scale: [1, 2] })).toBe('atMs[1]|');
    expect(fieldOf({ atMs: [0, 500, 400], scale: [1, 2, 1] })).toBe('atMs[2]|');
    expect(fieldOf({ atMs: [0, 500, 500], scale: [1, 2, 1] })).toBe('accepted');
  });

  it('clamps every value, reads one that is not a number as neutral, and copies rather than aliases', () => {
    const raw = { atMs: [0, 100], x: [-9, 9], y: [0, 0], scale: [-1, 99], rotation: [-9999, Number.NaN], opacity: [2, 'x'] };
    const out = normaliseOverlayMotion(raw)!;
    // `y` never leaves 0 and `opacity` clamps to 1 twice over: both are dropped as moving nothing.
    expect(out).toEqual({ atMs: [0, 100], x: [-4, 4], scale: [0, 20], rotation: [-3600, 0] });
    expect(out.atMs).not.toBe(raw.atMs);
    raw.atMs[1] = 9999;
    expect(out.atMs[1]).toBe(100);
  });
});

describe('overlayRasterDetail', () => {
  it('asks for more pixels only for a motion that magnifies, and never past the cap', () => {
    expect(overlayRasterDetail(null)).toBe(1);
    expect(overlayRasterDetail({ atMs: [0, 1], opacity: [0, 1] })).toBe(1);
    expect(overlayRasterDetail({ atMs: [0, 1], scale: [0, 1] })).toBe(1);
    expect(overlayRasterDetail({ atMs: [0, 1], scale: [1.2, 1] })).toBe(1.2);
    expect(overlayRasterDetail({ atMs: [0, 1], scale: [1.8, 1] })).toBe(MAX_MOTION_RASTER_DETAIL);
  });
});

/* -------------------------------------------------------------------------------------------- */

const sticker = (over: Partial<EditOverlay> = {}): EditOverlay =>
  ({ kind: 'sticker', id: 's', emoji: null, assetId: 'crown', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0, ...over }) as EditOverlay;

function post(overlays: EditOverlay[]): EditManifest {
  return { ...emptyManifest(), clips: [defaultClipEdit('a', 4000)], overlays };
}

describe('the manifest', () => {
  it('is version 11, and reads an older layer as still', () => {
    expect(MANIFEST_VERSION).toBeGreaterThanOrEqual(11);
    const m = normaliseManifest({ version: 10, clips: [defaultClipEdit('a', 4000)], overlays: [{ ...sticker(), animation: undefined }] });
    expect('animation' in m.overlays[0]).toBe(false);
  });

  it('keeps a layer animation it can draw, clamped, and drops one it cannot', () => {
    const m = normaliseManifest({
      version: 11,
      clips: [defaultClipEdit('a', 4000)],
      overlays: [
        sticker({ id: 'a', animation: { in: { id: 'pop', durationMs: 5000 } } }),
        sticker({ id: 'b', animation: { loop: { id: 'teleport', periodMs: 100 } } as unknown as OverlayAnimation }),
      ],
    });
    expect(m.overlays[0].animation).toEqual({ in: { id: 'pop', durationMs: MAX_OVERLAY_MOVE_MS } });
    expect('animation' in m.overlays[1]).toBe(false);
  });

  it('keeps it through a duplicate, and shares it out across a split', () => {
    const animation: OverlayAnimation = { in: { id: 'pop', durationMs: 470 }, loop: { id: 'pulse', periodMs: 1000 }, out: { id: 'fade', durationMs: 400 } };
    const m = post([sticker({ animation })]);
    expect(duplicateOverlay(m, 's', 's2')!.overlays[1].animation).toBe(animation);
    const split = splitOverlayAt(m, 's', 2000, 's2', 4000)!;
    expect(split.overlays[0].animation).toEqual({ in: animation.in, loop: animation.loop });
    expect(split.overlays[1].animation).toEqual({ loop: animation.loop, out: animation.out });
    // A layer that only arrives leaves its right half with nothing, and no key.
    const arrives = splitOverlayAt(post([sticker({ animation: { in: animation.in } })]), 's', 2000, 's2', 4000)!;
    expect('animation' in arrives.overlays[1]).toBe(false);
  });

  it('takes the moves away on a patch with none, and calls a patch that changes nothing no change', () => {
    const animation: OverlayAnimation = { loop: { id: 'beat', periodMs: 500 } };
    const m = post([sticker({ animation })]);
    const cleared = patchOverlay(m, 's', { animation: undefined });
    expect('animation' in cleared.overlays[0]).toBe(false);
    expect(patchOverlay(m, 's', { cx: 0.5 })).toBe(m);
    expect(patchOverlay(m, 's', { animation: { loop: { id: 'beat', periodMs: 500 } } })).toBe(m);
    expect(patchOverlay(m, 's', { animation: { loop: { id: 'beat', periodMs: 50_000 } } }).overlays[0].animation).toEqual({ loop: { id: 'beat', periodMs: MAX_OVERLAY_LOOP_MS } });
  });
});

describe('toComposeSpec', () => {
  const uris = new Map([['a', 'file:///a.mp4']]);
  const shown = { png: 'data:image/png;base64,preview', wPx: 321, hPx: 123 };
  const context = {
    output: emptyManifest().output,
    textStyle: () => ({}),
    stickerUrl: () => '',
    fileUrl: (u: string) => u,
    drawn: () => shown,
  } as unknown as RasterContext;
  const wire = (m: EditManifest): Promise<ComposeSpec> => toComposeSpec(m, uris, { jobId: 'j', batchId: 'b' }, context);

  it('sends a still layer exactly as it always has: no motion key at all', async () => {
    const spec = await wire(post([sticker()]));
    expect('motion' in spec.overlays[0]).toBe(false);
    expect(Object.keys(spec.overlays[0])).toEqual(['id', 'png', 'wPx', 'hPx', 'cx', 'cy', 'rotationDeg', 'startMs', 'endMs', 'opacity']);
  });

  it('sends a moving layer its compiled motion, over the window it is sent with', async () => {
    rasterise.mockClear();
    const layer = sticker({ startMs: 500, endMs: 0, animation: { in: { id: 'fade', durationMs: 400 } } });
    const spec = await wire(post([layer]));
    const sent = spec.overlays[0];
    expect(sent.motion).toEqual(overlayMotionFor(layer, 4000));
    expect(sent.motion!.atMs[0]).toBe(500);
    expect(overlayWireWindow(layer, 4000)).toEqual({ startMs: sent.startMs, endMs: sent.endMs });
    // A fade never grows the layer, so the preview's own bitmap is placed.
    expect(sent.png).toBe(shown.png);
    expect(rasterise).not.toHaveBeenCalled();
  });

  it('draws a layer that grows again at up to half as many pixels again, and keeps its resting size', async () => {
    rasterise.mockClear();
    const spec = await wire(post([sticker({ animation: { in: { id: 'slam', durationMs: 450 } } }), sticker({ id: 'p', animation: { in: { id: 'pop', durationMs: 470 } } })]));
    // A slam starts at 1.8x, past the cap; a pop peaks a fifth over, near enough - its keys fall a
    // hair either side of the very top.
    expect(rasterise.mock.calls.map(([overlay, , options]) => [overlay.id, options?.detail])).toEqual([
      ['s', MAX_MOTION_RASTER_DETAIL],
      ['p', expect.closeTo(1.2, 3)],
    ]);
    expect(spec.overlays.map(o => [o.png.startsWith(`drawn:${o.id}@1.`), o.wPx, o.hPx])).toEqual([
      [true, 100, 50],
      [true, 100, 50],
    ]);
  });
});
