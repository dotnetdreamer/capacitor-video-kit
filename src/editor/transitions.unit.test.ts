import { describe, expect, it } from 'vitest';

import type { ComposeSpec } from '../video-composer/definitions';
import { toComposeSpec } from './compose';
import { MANIFEST_VERSION, clipsDurationMs, defaultClipEdit, emptyManifest, normaliseManifest, totalDurationMs, type EditClip, type EditManifest } from './edit-manifest';
import {
  canJoinWithNext,
  duplicateClip,
  moveClip,
  moveClipToTrack,
  removeClip,
  setAllTransitions,
  setClipSpeed,
  setClipTransition,
  slotAt,
  splitClipAt,
  swapTrackZ,
  timelineSlots,
  transitionWindowAt,
} from './edit-ops';
import type { RasterContext } from './raster-context';
import {
  MAX_TRANSITION_MS,
  MIN_TRANSITION_MS,
  NEUTRAL_SIDE,
  TRANSITIONS,
  TRANSITION_CATEGORIES,
  TRANSITION_SAMPLES,
  compileTransition,
  isTransitionKind,
  lookAt,
  maskAlpha,
  maxTransitionMs,
  sample,
  transitionPixel,
  transitionSpan,
  type RGB,
} from './transitions';

/*
 * Transitions, from the manifest to the wire.
 *
 * The clips below are four seconds each unless a test says otherwise, so the overlap arithmetic
 * reads straight off the page: a half-second transition between the first two starts the second
 * clip at 3500 instead of 4000.
 */
const FOUR_S = 4000;

function seg(key: string, extra: Partial<EditClip> = {}): EditClip {
  return { ...defaultClipEdit(key, FOUR_S), ...extra };
}

function post(...clips: EditClip[]): EditManifest {
  return { ...emptyManifest(), clips };
}

const DISSOLVE = { kind: 'dissolve', durationMs: 500 };

describe('the catalogue', () => {
  it('has a recipe for every tile and a tile for every recipe, each in a real category', () => {
    const categories = new Set(TRANSITION_CATEGORIES.map(c => c.id));
    for (const preset of TRANSITIONS) {
      expect(isTransitionKind(preset.id), preset.id).toBe(true);
      expect(categories.has(preset.category), preset.id).toBe(true);
    }
    expect(new Set(TRANSITIONS.map(p => p.id)).size).toBe(TRANSITIONS.length);
    expect(new Set(TRANSITIONS.map(p => p.label)).size).toBe(TRANSITIONS.length);
    expect(isTransitionKind('nope')).toBe(false);
    expect(isTransitionKind('toString')).toBe(false);
  });

  it('samples every curve at the same number of evenly spaced moments', () => {
    for (const preset of TRANSITIONS) {
      const compiled = compileTransition(preset.id);
      expect(compiled, preset.id).not.toBeNull();
      const curves = [compiled!.curves.alpha, compiled!.curves.reveal, ...Object.values(compiled!.curves.from ?? {}), ...Object.values(compiled!.curves.to ?? {})].filter(Boolean);
      expect(curves.length, `${preset.id} moves nothing`).toBeGreaterThan(0);
      for (const curve of curves) expect(curve!.length).toBe(TRANSITION_SAMPLES);
    }
  });

  it('leaves out every channel that never moves', () => {
    const dissolve = compileTransition('dissolve')!;
    expect(Object.keys(dissolve.curves)).toEqual(['alpha']);
    expect(dissolve.mask).toBeUndefined();
    expect(dissolve.fromTint).toBeUndefined();
  });
});

/**
 * A two-colour world: the outgoing clip is solid red and the incoming one solid blue, so any pixel
 * of the drawing says which side (or which mix of them) is showing there.
 */
const RED: RGB = [1, 0, 0];
const BLUE: RGB = [0, 0, 1];
const read = (side: 'from' | 'to'): RGB => (side === 'from' ? RED : BLUE);

function pixelsAt(kind: string, p: number, w = 36, h = 64): RGB[] {
  const compiled = compileTransition(kind)!;
  const look = lookAt(compiled.curves, p);
  const out: RGB[] = [];
  for (let y = 0.5; y < h; y += 7) for (let x = 0.5; x < w; x += 5) out.push(transitionPixel(compiled, look, x, y, w, h, read));
  return out;
}

function near(a: RGB, b: RGB, tolerance = 1e-3): boolean {
  return Math.abs(a[0] - b[0]) < tolerance && Math.abs(a[1] - b[1]) < tolerance && Math.abs(a[2] - b[2]) < tolerance;
}

describe('every transition, at its two ends', () => {
  for (const preset of TRANSITIONS) {
    it(`${preset.id} starts on the outgoing clip and ends on the incoming one`, () => {
      expect(
        pixelsAt(preset.id, 0).every(px => near(px, RED)),
        'p = 0',
      ).toBe(true);
      expect(
        pixelsAt(preset.id, 1).every(px => near(px, BLUE)),
        'p = 1',
      ).toBe(true);
    });
  }

  it('is somewhere in between in the middle', () => {
    for (const preset of TRANSITIONS) {
      const middle = pixelsAt(preset.id, 0.5);
      const allRed = middle.every(px => near(px, RED));
      const allBlue = middle.every(px => near(px, BLUE));
      expect(allRed && allBlue, preset.id).toBe(false);
    }
  });
});

/** One output pixel of `kind` at `p` on a `w` x `h` frame, in the red and blue world above. */
function pixelOf(kind: string, p: number, x: number, y: number, w = 90, h = 160): RGB {
  const compiled = compileTransition(kind)!;
  return transitionPixel(compiled, lookAt(compiled.curves, p), x, y, w, h, read);
}

function lookOf(kind: string, p: number) {
  return lookAt(compileTransition(kind)!.curves, p);
}

describe('the transitions a template cuts on', () => {
  it('whips up and down: the incoming clip comes from below, or from above', () => {
    // Half way, a whip is half across: the incoming clip on one half, the outgoing one darkening on the other.
    expect(near(pixelOf('whip-up', 0.5, 45, 150), BLUE)).toBe(true);
    expect(pixelOf('whip-up', 0.5, 45, 5)[0]).toBeGreaterThan(0.6);
    expect(near(pixelOf('whip-down', 0.5, 45, 5), BLUE)).toBe(true);
    expect(pixelOf('whip-down', 0.5, 45, 150)[0]).toBeGreaterThan(0.6);
    // Straight up and down, so nothing moves sideways.
    expect(compileTransition('whip-up')!.curves.from?.x).toBeUndefined();
  });

  it('swipes up like a flick: most of the way there by the middle, and blurred most just after it lets go', () => {
    expect(lookOf('swipe-up', 0.5).to.y).toBeLessThan(0.2);
    expect(lookOf('swipe-up', 0.25).to.blur).toBeGreaterThan(lookOf('swipe-up', 0.75).to.blur);
    for (const p of [0, 1]) {
      expect(lookOf('swipe-up', p).from.blur).toBe(0);
      expect(lookOf('swipe-up', p).to.blur).toBe(0);
    }
    // Always moving up, never back down.
    for (let p = 0.02; p <= 1; p += 0.02) expect(lookOf('swipe-up', p).to.y).toBeLessThanOrEqual(lookOf('swipe-up', p - 0.02).to.y + 1e-9);
  });

  it('turns spin-blur on a frame that covers the picture at every moment, portrait, landscape or square', () => {
    for (const [w, h] of [
      [90, 160],
      [160, 90],
      [100, 100],
    ]) {
      for (let p = 0; p <= 1.0001; p += 0.01) {
        const alpha = lookOf('spin-blur', p).alpha;
        for (let y = 0.5; y < h; y += Math.max(1, (h - 1) / 12)) {
          for (let x = 0.5; x < w; x += Math.max(1, (w - 1) / 12)) {
            // Red and blue mixed by alpha, and nothing else: a side that did not cover this pixel
            // would let black through, or the other side alone.
            const px = pixelOf('spin-blur', p, x, y, w, h);
            expect(px[0], `${w}x${h} at ${p.toFixed(2)} (${x}, ${y})`).toBeCloseTo(1 - alpha, 6);
            expect(px[2], `${w}x${h} at ${p.toFixed(2)} (${x}, ${y})`).toBeCloseTo(alpha, 6);
          }
        }
      }
    }
    expect(Math.abs(lookOf('spin-blur', 0.45).from.rotation)).toBeGreaterThan(45);
  });

  it('punches both sides into the cut for zoom-blur', () => {
    const cut = lookOf('zoom-blur', 0.5);
    expect(cut.from.scale).toBeGreaterThan(1.8);
    expect(cut.to.scale).toBeGreaterThan(1.8);
    expect(cut.from.blur).toBeGreaterThan(0.02);
  });

  it('opens the incoming clip small in the middle for zoom-through, and never leaves an edge of it showing late', () => {
    expect(near(pixelOf('zoom-through', 0.45, 45, 80), BLUE)).toBe(true);
    expect(near(pixelOf('zoom-through', 0.45, 2, 2), RED)).toBe(true);
    for (let p = 0.55; p <= 1.0001; p += 0.01) expect(lookOf('zoom-through', p).to.scale, `at ${p.toFixed(2)}`).toBeGreaterThanOrEqual(1);
  });

  it('opens split from a line down the middle, and diamond from a point', () => {
    expect(near(pixelOf('split-open', 0.3, 45, 80), BLUE)).toBe(true);
    expect(near(pixelOf('split-open', 0.3, 45, 2), BLUE)).toBe(true);
    expect(near(pixelOf('split-open', 0.3, 2, 80), RED)).toBe(true);
    expect(near(pixelOf('split-open', 0.3, 88, 80), RED)).toBe(true);
    expect(compileTransition('split-open')!.mask).toMatchObject({ shape: 'split', angleDeg: 0 });

    // A diamond: as far along an axis is in, as far along a diagonal is out.
    expect(near(pixelOf('diamond', 0.4, 45 + 25, 80), BLUE)).toBe(true);
    expect(near(pixelOf('diamond', 0.4, 45 + 20, 80 + 20), RED)).toBe(true);
    expect(near(pixelOf('diamond', 0.4, 2, 2), RED)).toBe(true);
  });

  it('pulls the colours apart one way before the cut and the other way after it', () => {
    expect(lookOf('rgb-split', 0.4).from.split).toBeGreaterThan(0.02);
    expect(lookOf('rgb-split', 0.6).to.split).toBeLessThan(-0.02);
  });

  it('washes the leak in two warm tints that meet across a wide soft edge', () => {
    const leak = compileTransition('leak')!;
    expect(leak.fromTint).toBeDefined();
    expect(leak.toTint).toBeDefined();
    expect(leak.fromTint).not.toEqual(leak.toTint);
    expect(leak.mask).toMatchObject({ shape: 'linear' });
    expect(leak.mask!.feather!).toBeGreaterThan(0.2);
    const peak = lookOf('leak', 0.5);
    expect(peak.from.gain).toBeGreaterThan(2);
    expect(peak.to.tint).toBeGreaterThan(0.3);
  });
});

describe('reading a curve', () => {
  it('interpolates in a straight line between the samples either side', () => {
    expect(sample([0, 1], 0.25, 9)).toBeCloseTo(0.25);
    expect(sample([0, 10, 20], 0.75, 9)).toBeCloseTo(15);
    expect(sample([0, 10, 20], 1, 9)).toBe(20);
    expect(sample([0, 10, 20], 1.5, 9)).toBe(20);
    expect(sample([0, 10, 20], -1, 9)).toBe(0);
    expect(sample(undefined, 0.5, 9)).toBe(9);
  });

  it('reads the neutral side for a channel that was left out', () => {
    const look = lookAt({ alpha: [0, 1] }, 0.5);
    expect(look.from).toEqual(NEUTRAL_SIDE);
    expect(look.reveal).toBe(1);
  });
});

describe('masks', () => {
  it('open a circle from the centre of the frame, round in pixels', () => {
    const circle = { shape: 'circle' as const, feather: 0.001 };
    expect(maskAlpha(circle, 0.5, 50, 100, 100, 200)).toBe(1);
    expect(maskAlpha(circle, 0.5, 0, 0, 100, 200)).toBe(0);
    // The same distance from the centre across and down: in or out together, whatever the frame's shape.
    expect(maskAlpha(circle, 0.3, 50 + 30, 100, 100, 200)).toBe(maskAlpha(circle, 0.3, 50, 100 + 30, 100, 200));
  });

  it('travel a linear edge the way its angle points', () => {
    const right = { shape: 'linear' as const, angleDeg: 0, feather: 0.001 };
    expect(maskAlpha(right, 0.5, 10, 50, 100, 100)).toBe(1);
    expect(maskAlpha(right, 0.5, 90, 50, 100, 100)).toBe(0);
    const left = { shape: 'linear' as const, angleDeg: 180, feather: 0.001 };
    expect(maskAlpha(left, 0.5, 90, 50, 100, 100)).toBe(1);
    expect(maskAlpha(left, 0.5, 10, 50, 100, 100)).toBe(0);
  });

  it('sweep a clock hand clockwise from twelve', () => {
    const clock = { shape: 'clock' as const, feather: 0.001 };
    // A quarter turn in: three o'clock's side is revealed, nine o'clock's is not.
    expect(maskAlpha(clock, 0.3, 60, 45, 100, 100)).toBe(1);
    expect(maskAlpha(clock, 0.3, 40, 45, 100, 100)).toBe(0);
  });

  it('let nothing through at 0 and everything through at 1, feather and all', () => {
    for (const shape of ['linear', 'circle', 'diamond', 'clock', 'blinds', 'split'] as const) {
      const mask = { shape, count: 5, feather: 0.1 };
      for (const [x, y] of [
        [0, 0],
        [50, 50],
        [99, 1],
        [23, 77],
      ]) {
        expect(maskAlpha(mask, 0, x, y, 100, 100), `${shape} closed`).toBe(0);
        expect(maskAlpha(mask, 1, x, y, 100, 100), `${shape} open`).toBe(1);
      }
    }
  });
});

describe('how long a transition runs', () => {
  it('is what was asked for when both clips can hold it', () => {
    expect(transitionSpan(seg('a'), seg('b', { transitionIn: DISSOLVE }))).toEqual({ ms: 500, sourceMs: 500 });
  });

  it('is held to half of the shorter clip', () => {
    const short = seg('b', { outMs: 600, transitionIn: { kind: 'dissolve', durationMs: 2000 } });
    expect(transitionSpan(seg('a'), short).ms).toBe(300);
    expect(maxTransitionMs(seg('a'), short)).toBe(300);
  });

  it('is a cut when the clips cannot hold even the shortest one', () => {
    const tiny = seg('b', { outMs: 150, transitionIn: DISSOLVE });
    expect(transitionSpan(seg('a'), tiny).ms).toBe(0);
    expect(maxTransitionMs(seg('a'), tiny)).toBe(0);
  });

  it('takes its source from the outgoing clip, through that clip speed', () => {
    const fast = seg('a', { speed: 2 });
    expect(transitionSpan(fast, seg('b', { transitionIn: DISSOLVE }))).toEqual({ ms: 500, sourceMs: 1000 });
    const slow = seg('a', { speed: 0.3 });
    const span = transitionSpan(slow, seg('b', { transitionIn: DISSOLVE }));
    expect(span.sourceMs).toBe(150);
    expect(span.ms).toBeCloseTo(500, 6);
  });

  it('rounds the longest a boundary can hold down to the slider step', () => {
    expect(maxTransitionMs(seg('a', { outMs: 1290 }), seg('b'))).toBe(600);
    expect(maxTransitionMs(seg('a'), seg('b', { outMs: 60_000 }))).toBe(MAX_TRANSITION_MS);
  });
});

describe('the timeline with a transition on it', () => {
  const dressed = () => post(seg('a'), seg('b', { transitionIn: DISSOLVE }), seg('c'));

  it('starts the incoming clip under the end of the outgoing one, so the post is shorter', () => {
    const slots = timelineSlots(dressed());
    expect(slots.map(s => [s.startMs, s.durationMs, s.transitionInMs, s.tailMs])).toEqual([
      [0, 3500, 0, 500],
      [3500, 4000, 500, 0],
      [7500, 4000, 0, 0],
    ]);
    expect(clipsDurationMs(dressed().clips)).toBe(11_500);
    expect(totalDurationMs(dressed())).toBe(11_500);
  });

  it('gives every instant to one clip - the incoming one inside the window', () => {
    expect(slotAt(dressed(), 3499)?.clip.id).toBe('a');
    expect(slotAt(dressed(), 3500)?.clip.id).toBe('b');
    expect(slotAt(dressed(), 3999)?.clip.id).toBe('b');
  });

  it('says where both clips are inside the window, and nothing outside it', () => {
    const slots = timelineSlots(dressed());
    const window = transitionWindowAt(slots, 3750)!;
    expect(window.from.id).toBe('a');
    expect(window.to.id).toBe('b');
    expect(window.progress).toBeCloseTo(0.5);
    expect(window.fromSourceMs).toBe(3750);
    expect(window.toSourceMs).toBe(250);
    expect(transitionWindowAt(slots, 3499)).toBeNull();
    expect(transitionWindowAt(slots, 4000)).toBeNull();
  });

  it('gives a stored transition back when a trim that had squeezed it is undone', () => {
    const squeezed = setClipSpeed(dressed(), 'b', 4);
    expect(timelineSlots(squeezed)[1].transitionInMs).toBe(500);
    const shorter = { ...dressed(), clips: dressed().clips.map(c => (c.id === 'b' ? { ...c, outMs: 400 } : c)) };
    expect(timelineSlots(shorter)[1].transitionInMs).toBe(200);
    expect(shorter.clips[1].transitionIn).toEqual(DISSOLVE);
  });
});

describe('the ops, on a boundary with a transition', () => {
  const dressed = () => post(seg('a'), seg('b', { transitionIn: DISSOLVE }), seg('c'));

  it('sets one, clears one, and refuses the first clip and a layer', () => {
    const m = setClipTransition(post(seg('a'), seg('b')), 'b', DISSOLVE);
    expect(m.clips[1].transitionIn).toEqual(DISSOLVE);
    expect('transitionIn' in setClipTransition(m, 'b', null).clips[1]).toBe(false);
    const first = post(seg('a'), seg('b'));
    expect(setClipTransition(first, 'a', DISSOLVE)).toBe(first);
    expect(setClipTransition(m, 'b', { ...DISSOLVE })).toBe(m);
    expect(setClipTransition(m, 'b', { kind: 'no-such-thing', durationMs: 500 })).toBe(m);
  });

  it('holds what is stored to the catalogue range', () => {
    const m = setClipTransition(post(seg('a'), seg('b')), 'b', { kind: 'dissolve', durationMs: 99_999 });
    expect(m.clips[1].transitionIn?.durationMs).toBe(MAX_TRANSITION_MS);
    const n = setClipTransition(post(seg('a'), seg('b')), 'b', { kind: 'dissolve', durationMs: 1 });
    expect(n.clips[1].transitionIn?.durationMs).toBe(MIN_TRANSITION_MS);
  });

  it('puts one transition on every boundary in one op, and takes them all off', () => {
    const all = setAllTransitions(post(seg('a'), seg('b'), seg('c')), { kind: 'blur', durationMs: 700 });
    expect(all.clips.map(c => c.transitionIn?.kind)).toEqual([undefined, 'blur', 'blur']);
    expect(setAllTransitions(all, { kind: 'blur', durationMs: 700 })).toBe(all);
    expect(setAllTransitions(all, null).clips.every(c => !c.transitionIn)).toBe(true);
  });

  it('keeps the transition on the left piece of a split and starts the right piece on a cut', () => {
    const split = splitClipAt(dressed(), 5000, 'b2')!;
    expect(split.clips.map(c => [c.id, c.transitionIn?.kind])).toEqual([
      ['a', undefined],
      ['b', 'dissolve'],
      ['b2', undefined],
      ['c', undefined],
    ]);
  });

  it('starts a duplicate on a cut', () => {
    const copy = duplicateClip(dressed(), 'b', 'b2')!;
    expect(copy.clips.find(c => c.id === 'b2')?.transitionIn).toBeUndefined();
    expect(copy.clips.find(c => c.id === 'b')?.transitionIn).toEqual(DISSOLVE);
  });

  it('will not join two halves with a transition between them', () => {
    const split = splitClipAt(post(seg('a'), seg('b')), 5000, 'b2')!;
    expect(canJoinWithNext(split, 'b')).toBe(true);
    expect(canJoinWithNext(setClipTransition(split, 'b2', DISSOLVE), 'b')).toBe(false);
  });

  it('never leaves a transition on the first clip', () => {
    expect(removeClip(dressed(), 'a')!.clips[0].transitionIn).toBeUndefined();
    expect(moveClip(dressed(), 'b', 0).clips[0].transitionIn).toBeUndefined();
    // Moved anywhere else, the transition goes with the clip it brings in.
    expect(moveClip(dressed(), 'b', 2).clips.map(c => [c.id, c.transitionIn?.kind])).toEqual([
      ['a', undefined],
      ['c', undefined],
      ['b', 'dissolve'],
    ]);
  });

  it('leaves transitions behind on the base track when a clip goes up to a layer', () => {
    const lifted = moveClipToTrack(dressed(), 'b', { kind: 'new', index: 0 }, 0, 'vt')!;
    expect(lifted.videoTracks[0].clips[0].transitionIn).toBeUndefined();
    const layered: EditManifest = { ...dressed(), videoTracks: [{ id: 'vt', clips: [seg('x')], startMs: 0, z: 1, opacity: 1 }] };
    const swapped = swapTrackZ(layered, 'vt');
    expect(swapped.videoTracks[0].clips.every(c => !c.transitionIn)).toBe(true);
  });
});

describe('reading a stored manifest', () => {
  it('keeps a transition on the base track and drops one anywhere it cannot be', () => {
    const m = normaliseManifest({
      clips: [seg('a', { transitionIn: DISSOLVE }), seg('b', { transitionIn: DISSOLVE }), seg('c', { transitionIn: { kind: 'mystery', durationMs: 500 } })],
      videoTracks: [{ id: 'vt', clips: [seg('x'), seg('y', { transitionIn: DISSOLVE })], startMs: 0, z: 1, opacity: 1 }],
    });
    expect(m.version).toBe(MANIFEST_VERSION);
    expect(m.clips.map(c => c.transitionIn)).toEqual([undefined, DISSOLVE, undefined]);
    expect(m.videoTracks[0].clips.every(c => !('transitionIn' in c))).toBe(true);
  });

  it('reads an older manifest with nothing added', () => {
    const m = normaliseManifest({ version: 7, clips: [seg('a'), seg('b')] });
    expect(m.clips.every(c => !('transitionIn' in c))).toBe(true);
  });

  it('comes back unchanged through a round trip', () => {
    const once = normaliseManifest(post(seg('a'), seg('b', { transitionIn: DISSOLVE })));
    expect(normaliseManifest(JSON.parse(JSON.stringify(once)))).toEqual(once);
  });
});

describe('the wire', () => {
  const uris = new Map([
    ['a', 'file:///a.mp4'],
    ['b', 'file:///b.mp4'],
    ['c', 'file:///c.mp4'],
  ]);
  const ids = { jobId: 'j', batchId: 'b' };
  const raster = {} as RasterContext;
  const wire = (m: EditManifest): Promise<ComposeSpec> => toComposeSpec(m, uris, ids, raster);

  it('stops the outgoing clip where the incoming one starts, and sends its tail with the incoming one', async () => {
    const spec = await wire(post(seg('a'), seg('b', { transitionIn: DISSOLVE }), seg('c')));
    expect(spec.clips.map(c => [c.key, c.inMs, c.outMs])).toEqual([
      ['a', 0, 3500],
      ['b', 0, 4000],
      ['c', 0, 4000],
    ]);
    const t = spec.clips[1].transitionIn!;
    expect(t.kind).toBe('dissolve');
    expect(t.from).toMatchObject({ key: 'a', uri: 'file:///a.mp4', inMs: 3500, outMs: 4000, speed: 1 });
    expect(t.curves.alpha).toHaveLength(TRANSITION_SAMPLES);
    expect(spec.clips[0].transitionIn).toBeUndefined();
    // No tail is asked for: the base track's own length, overlap and all, is the post.
    expect(spec.durationMs).toBeUndefined();
  });

  it('carries the outgoing clip speed into its tail', async () => {
    const spec = await wire(post(seg('a', { speed: 2 }), seg('b', { transitionIn: DISSOLVE })));
    expect(spec.clips[0]).toMatchObject({ inMs: 0, outMs: 3000 });
    expect(spec.clips[1].transitionIn!.from).toMatchObject({ inMs: 3000, outMs: 4000, speed: 2 });
  });

  it('sends a post with no transitions exactly as it always has', async () => {
    const spec = await wire(post(seg('a'), seg('b')));
    expect(JSON.stringify(spec)).not.toContain('transition');
  });

  it('never shares the cached curves with a spec', async () => {
    const spec = await wire(post(seg('a'), seg('b', { transitionIn: DISSOLVE })));
    expect(Object.isFrozen(spec.clips[1].transitionIn!.curves)).toBe(false);
  });
});
