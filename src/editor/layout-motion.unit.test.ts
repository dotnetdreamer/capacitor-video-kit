import { describe, expect, it } from 'vitest';

import { MAX_RECT_MOTION_KEYS, type ComposeRectMotion, type ComposeSpec } from '../video-composer/definitions';
import { toComposeSpec } from './compose';
import { MANIFEST_VERSION, defaultClipEdit, emptyManifest, normaliseManifest, type EditClip, type EditManifest, type EditRect } from './edit-manifest';
import { setTrackLayoutAnimation } from './edit-ops';
import { DEFAULT_LAYOUT_ANIMATION_MS, MAX_LAYOUT_ANIMATION_MS, MIN_LAYOUT_ANIMATION_MS, normaliseLayoutAnimation } from './layout-animation';
import { RectMotionError, compileLayoutMotions, drawsNothing, layoutAnimationEnds, layoutOpenings, layoutRectAt, normaliseRectMotion, rectMotionAt } from './layout-motion';
import { applyLayoutPreset, type LayoutPresetId } from './layout-presets';
import type { RasterContext } from './raster-context';

/*
 * A 10 s base and a 4 s second video from 2 s to 6 s, on the default 720 x 1280 frame: the drama's
 * phone call. Every expectation below is read off that, with the 600 ms default opening, whose ease
 * is exactly half way at 300 ms - which is a key, because a 600 ms move is sampled 36 times.
 */
const BASE_MS = 10_000;
const LAYER_START = 2000;
const LAYER_MS = 4000;

function post(preset: LayoutPresetId, style: string | null, base: EditClip[] = [defaultClipEdit('a', BASE_MS, 'seg-a')]): EditManifest {
  let m: EditManifest = {
    ...emptyManifest(),
    clips: base,
    videoTracks: [{ id: 't', clips: [defaultClipEdit('b', LAYER_MS, 'seg-b')], startMs: LAYER_START, z: 1, opacity: 1 }],
  };
  m = applyLayoutPreset(m, 't', preset);
  return style ? setTrackLayoutAnimation(m, 't', { id: style, durationMs: DEFAULT_LAYOUT_ANIMATION_MS }) : m;
}

function rectOf(m: EditManifest, clipId: string, ms: number): EditRect | null {
  const clip = [...m.clips, ...m.videoTracks.flatMap(track => track.clips)].find(one => one.id === clipId)!;
  return layoutRectAt(compileLayoutMotions(m), clip, ms);
}

function near(actual: EditRect | null, expected: EditRect | null, digits = 6): void {
  if (!expected) {
    expect(actual).toBeNull();
    return;
  }
  expect(actual).not.toBeNull();
  for (const key of ['x', 'y', 'w', 'h'] as const) expect(actual![key]).toBeCloseTo(expected[key], digits);
}

describe('the stored setting', () => {
  it('keeps a known style and clamps its length, and drops what this version cannot draw', () => {
    expect(normaliseLayoutAnimation({ id: 'slide', durationMs: 600 })).toEqual({ id: 'slide', durationMs: 600 });
    expect(normaliseLayoutAnimation({ id: 'wipe', durationMs: 99_999 })).toEqual({ id: 'wipe', durationMs: MAX_LAYOUT_ANIMATION_MS });
    expect(normaliseLayoutAnimation({ id: 'wipe', durationMs: 1 })).toEqual({ id: 'wipe', durationMs: MIN_LAYOUT_ANIMATION_MS });
    expect(normaliseLayoutAnimation({ id: 'slide' })).toEqual({ id: 'slide', durationMs: DEFAULT_LAYOUT_ANIMATION_MS });
    expect(normaliseLayoutAnimation({ id: 'spiral', durationMs: 600 })).toBeNull();
    expect(normaliseLayoutAnimation('slide')).toBeNull();
    const normal = { id: 'slide', durationMs: 700 };
    expect(normaliseLayoutAnimation(normal)).toBe(normal);
  });

  it('reads back from a draft, and an older one has no key at all', () => {
    const read = normaliseManifest({
      version: 12,
      clips: [defaultClipEdit('a', 5000, 'seg-a')],
      videoTracks: [
        { id: 't1', clips: [defaultClipEdit('b', 3000, 'seg-b')], startMs: 0, z: 1, opacity: 1, layoutAnimation: { id: 'wipe', durationMs: 5000 } },
        { id: 't2', clips: [defaultClipEdit('c', 3000, 'seg-c')], startMs: 0, z: 2, opacity: 1, layoutAnimation: { id: 'nope', durationMs: 500 } },
        { id: 't3', clips: [defaultClipEdit('d', 3000, 'seg-d')], startMs: 0, z: 3, opacity: 1 },
      ],
    });
    expect(read.version).toBe(MANIFEST_VERSION);
    expect(MANIFEST_VERSION).toBeGreaterThanOrEqual(13);
    expect(read.videoTracks[0].layoutAnimation).toEqual({ id: 'wipe', durationMs: MAX_LAYOUT_ANIMATION_MS });
    expect('layoutAnimation' in read.videoTracks[1]).toBe(false);
    expect('layoutAnimation' in read.videoTracks[2]).toBe(false);
  });

  it('is set, re-set to the same move as no change, and taken off as no key', () => {
    const m = post('splitTopBottom', 'slide');
    expect(m.videoTracks[0].layoutAnimation).toEqual({ id: 'slide', durationMs: DEFAULT_LAYOUT_ANIMATION_MS });
    expect(setTrackLayoutAnimation(m, 't', { id: 'slide', durationMs: DEFAULT_LAYOUT_ANIMATION_MS })).toBe(m);
    expect(setTrackLayoutAnimation(m, 'missing', null)).toBe(m);
    const off = setTrackLayoutAnimation(m, 't', null);
    expect('layoutAnimation' in off.videoTracks[0]).toBe(false);
    expect(setTrackLayoutAnimation(off, 't', null)).toBe(off);
  });
});

describe('when an arrangement is open', () => {
  it('opens as the layer arrives and closes as it goes, both moves at the length asked for', () => {
    expect(layoutOpenings(post('splitTopBottom', 'slide'))).toEqual([{ trackId: 't', id: 'slide', startMs: 2000, endMs: 6000, inMs: 600, outMs: 600 }]);
  });

  it('squeezes both moves in proportion into a layer too short for them', () => {
    const m = post('splitTopBottom', 'slide');
    const short = { ...m, videoTracks: [{ ...m.videoTracks[0], clips: [defaultClipEdit('b', 800, 'seg-b')] }] };
    const [opening] = layoutOpenings(short);
    expect(opening.inMs).toBeCloseTo(400, 9);
    expect(opening.outMs).toBeCloseTo(400, 9);
  });

  it('is cut where the post ends, and a layer that never comes on has none', () => {
    const m = post('splitTopBottom', 'slide');
    const late = { ...m, videoTracks: [{ ...m.videoTracks[0], startMs: 8000 }] };
    expect(layoutOpenings(late)[0].endMs).toBe(12_000);
    expect(layoutOpenings(post('splitTopBottom', null))).toEqual([]);
  });
});

describe('compileLayoutMotions', () => {
  it('moves nothing on a post whose layers hold still', () => {
    expect(compileLayoutMotions(post('splitTopBottom', null)).size).toBe(0);
    expect(compileLayoutMotions(emptyManifest()).size).toBe(0);
  });

  it('slides the second video up from below while the first is squeezed into the top half', () => {
    const m = post('splitTopBottom', 'slide');
    // Before the second video, and after it: the first one has the whole frame.
    near(rectOf(m, 'seg-a', 1000), { x: 0, y: 0, w: 1, h: 1 });
    near(rectOf(m, 'seg-a', 2000), { x: 0, y: 0, w: 1, h: 1 });
    near(rectOf(m, 'seg-a', 6000), { x: 0, y: 0, w: 1, h: 1 });
    near(rectOf(m, 'seg-a', 9000), { x: 0, y: 0, w: 1, h: 1 });
    // Half way through the opening and the closing, and open in between.
    near(rectOf(m, 'seg-a', 2300), { x: 0, y: 0, w: 1, h: 0.75 });
    near(rectOf(m, 'seg-a', 2600), { x: 0, y: 0, w: 1, h: 0.5 });
    near(rectOf(m, 'seg-a', 4000), { x: 0, y: 0, w: 1, h: 0.5 });
    near(rectOf(m, 'seg-a', 5700), { x: 0, y: 0, w: 1, h: 0.75 });
    // The second video whole, from just under the bottom edge.
    near(rectOf(m, 'seg-b', 2000), { x: 0, y: 1, w: 1, h: 0.5 });
    near(rectOf(m, 'seg-b', 2300), { x: 0, y: 0.75, w: 1, h: 0.5 });
    near(rectOf(m, 'seg-b', 2600), { x: 0, y: 0.5, w: 1, h: 0.5 });
    near(rectOf(m, 'seg-b', 6000), { x: 0, y: 1, w: 1, h: 0.5 });
  });

  it('keeps the edge between the two pictures one edge for the whole move, so no black shows', () => {
    for (const style of ['slide', 'wipe']) {
      const m = post('splitTopBottom', style);
      for (let ms = 1990; ms <= 6010; ms += 7) {
        const base = rectOf(m, 'seg-a', ms)!;
        const layer = rectOf(m, 'seg-b', ms)!;
        expect(layer.y).toBeCloseTo(base.y + base.h, 3);
      }
    }
  });

  it('wipes the second video open out of the bottom edge', () => {
    const m = post('splitTopBottom', 'wipe');
    near(rectOf(m, 'seg-b', 2000), { x: 0, y: 1, w: 1, h: 0 });
    near(rectOf(m, 'seg-b', 2300), { x: 0, y: 0.75, w: 1, h: 0.25 });
    near(rectOf(m, 'seg-b', 2600), { x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(drawsNothing(rectOf(m, 'seg-b', 2000)!, 720, 1280)).toBe(true);
    expect(drawsNothing(rectOf(m, 'seg-b', 2050)!, 720, 1280)).toBe(false);
  });

  it('slides side by side in from the right, the first video squeezed into the left half', () => {
    const m = post('splitLeftRight', 'slide');
    near(rectOf(m, 'seg-b', 2000), { x: 1, y: 0, w: 0.5, h: 1 });
    near(rectOf(m, 'seg-b', 2300), { x: 0.75, y: 0, w: 0.5, h: 1 });
    near(rectOf(m, 'seg-a', 2300), { x: 0, y: 0, w: 0.75, h: 1 });
    near(rectOf(m, 'seg-a', 4000), { x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('leaves the first video alone under a corner inset, which comes in over it', () => {
    const m = post('pipBR', 'slide');
    const motions = compileLayoutMotions(m);
    expect(motions.has('seg-a')).toBe(false);
    const open = m.videoTracks[0].clips[0].rect!;
    near(rectOf(m, 'seg-b', 4000), open);
    // From under the edge it is nearest, whole.
    near(rectOf(m, 'seg-b', 2000), { ...open, y: 1 });
  });

  it('slides a second video that covers the whole frame in from the side of a portrait post', () => {
    const m = post('full', 'slide');
    near(rectOf(m, 'seg-b', 2000), { x: 1, y: 0, w: 1, h: 1 });
    near(rectOf(m, 'seg-b', 4000), { x: 0, y: 0, w: 1, h: 1 });
    expect(compileLayoutMotions(m).has('seg-a')).toBe(false);
  });

  it('slides a turned inset rather than wiping it, past the corners it turns through', () => {
    const m = post('pipBR', 'wipe');
    const turned = { ...m.videoTracks[0].clips[0].rect!, rotationDeg: 30 };
    const tilted = { ...m, videoTracks: [{ ...m.videoTracks[0], clips: [{ ...m.videoTracks[0].clips[0], rect: turned }] }] };
    const closed = rectOf(tilted, 'seg-b', 2000)!;
    expect(closed.h).toBeCloseTo(turned.h, 6);
    expect(closed.w).toBeCloseTo(turned.w, 6);
    // Its centre is past the edge by at least half the box the turned rectangle sweeps.
    const sweptHalf = (turned.w * (720 / 1280) * Math.sin(Math.PI / 6) + turned.h * Math.cos(Math.PI / 6)) / 2;
    expect(closed.y + closed.h / 2).toBeGreaterThanOrEqual(1 + sweptHalf - 1e-6);
    expect(layoutRectAt(compileLayoutMotions(tilted), tilted.videoTracks[0].clips[0], 2000)?.rotationDeg).toBe(30);
  });

  it('gives a base clip that only plays while the layout is closed the whole frame, and one inside it nothing to do', () => {
    const before = { ...defaultClipEdit('a', 1500, 'seg-1') };
    const across = { ...defaultClipEdit('a', 6500, 'seg-2') };
    const after = { ...defaultClipEdit('a', 2000, 'seg-3') };
    const m = post('splitTopBottom', 'slide', [before, across, after]);
    const motions = compileLayoutMotions(m);
    expect(motions.get('seg-1')).toEqual({ motion: null });
    expect(motions.get('seg-3')).toEqual({ motion: null });
    expect(motions.get('seg-2')?.motion).not.toBeNull();

    const inside = post('splitTopBottom', 'slide', [defaultClipEdit('a', 2700, 'seg-1'), defaultClipEdit('a', 2600, 'seg-2'), defaultClipEdit('a', 4700, 'seg-3')]);
    // 2700..5300 is inside the open stretch, 2600..5400.
    expect(compileLayoutMotions(inside).has('seg-2')).toBe(false);
  });

  it('gives each clip only the keys of its own time on screen', () => {
    const m = post('splitTopBottom', 'slide', [defaultClipEdit('a', 2300, 'seg-1'), defaultClipEdit('a', 7700, 'seg-2')]);
    const first = compileLayoutMotions(m).get('seg-1')!.motion!;
    expect(first.atMs[0]).toBe(0);
    expect(first.atMs[first.atMs.length - 1]).toBe(2300);
    near(rectMotionAt(first, 2300), { x: 0, y: 0, w: 1, h: 0.75 });
    const second = compileLayoutMotions(m).get('seg-2')!.motion!;
    expect(second.atMs[0]).toBe(2300);
    near(rectMotionAt(second, 2300), { x: 0, y: 0, w: 1, h: 0.75 });
  });

  it('opens the base as far as the most open of two animated layers', () => {
    const m = post('splitTopBottom', 'slide');
    const second = { id: 't2', clips: [defaultClipEdit('c', 1000, 'seg-c')], startMs: 7000, z: 2, opacity: 1, layoutAnimation: { id: 'wipe', durationMs: 400 } };
    const two = { ...m, videoTracks: [...m.videoTracks, second] };
    near(rectOf(two, 'seg-a', 4000), { x: 0, y: 0, w: 1, h: 0.5 });
    near(rectOf(two, 'seg-a', 6500), { x: 0, y: 0, w: 1, h: 1 });
    near(rectOf(two, 'seg-a', 7500), { x: 0, y: 0, w: 1, h: 0.5 });
    near(rectOf(two, 'seg-a', 9000), { x: 0, y: 0, w: 1, h: 1 });
  });
});

describe('layoutAnimationEnds', () => {
  it('names both ends of each picture for a tile to draw', () => {
    const m = post('splitTopBottom', null);
    const ends = layoutAnimationEnds(m.clips[0].rect, m.videoTracks[0].clips[0].rect, 'slide', 720 / 1280);
    expect(ends.base).toEqual({ closed: { x: 0, y: 0, w: 1, h: 1 }, open: { x: 0, y: 0, w: 1, h: 0.5 } });
    expect(ends.layer).toEqual({ closed: { x: 0, y: 1, w: 1, h: 0.5 }, open: { x: 0, y: 0.5, w: 1, h: 0.5 } });
  });
});

describe('the wire', () => {
  const motion = (over: Partial<Record<keyof ComposeRectMotion, unknown>> = {}): Record<string, unknown> => ({
    atMs: [0, 100],
    x: [0, 0],
    y: [1, 0.5],
    w: [1, 1],
    h: [0.5, 0.5],
    ...over,
  });

  function refusal(value: unknown): { field: string; message: string } {
    try {
      normaliseRectMotion(value);
    } catch (error) {
      expect(error).toBeInstanceOf(RectMotionError);
      return { field: (error as RectMotionError).field, message: (error as RectMotionError).message };
    }
    throw new Error('not refused');
  }

  it('reads the keys as the camera is read: ends hold, straight lines between, a step to the later key', () => {
    const keys: ComposeRectMotion = { atMs: [100, 200, 200, 300], x: [0, 1, 2, 3], y: [0, 0, 0, 0], w: [1, 1, 1, 1], h: [1, 1, 1, 1] };
    expect(rectMotionAt(keys, 0).x).toBe(0);
    expect(rectMotionAt(keys, 150).x).toBeCloseTo(0.5, 9);
    expect(rectMotionAt(keys, 200).x).toBe(2);
    expect(rectMotionAt(keys, 250).x).toBeCloseTo(2.5, 9);
    expect(rectMotionAt(keys, 999).x).toBe(3);
  });

  it('is absent when it is not there, and a new object, clamped, when it is', () => {
    expect(normaliseRectMotion(undefined)).toBeNull();
    expect(normaliseRectMotion(null)).toBeNull();
    const raw = motion({ x: [9, -9], w: [-1, 5] });
    const read = normaliseRectMotion(raw)!;
    expect(read).toEqual({ atMs: [0, 100], x: [4, -4], y: [1, 0.5], w: [0, 2], h: [0.5, 0.5] });
    expect(read.x).not.toBe(raw['x']);
  });

  it('refuses a motion no engine could draw, naming what broke', () => {
    expect(refusal('keys')).toEqual({ field: '', message: 'rectMotion' });
    expect(refusal(motion({ atMs: undefined })).field).toBe('atMs');
    expect(refusal(motion({ x: [0] })).field).toBe('x');
    expect(refusal(motion({ h: 'tall' })).field).toBe('h');
    expect(refusal({ ...motion(), zz: [], rotation: [0, 0] }).field).toBe('rotation');
    expect(refusal(motion({ atMs: [], x: [], y: [], w: [], h: [] })).message).toBe(`rectMotion must have 1 to ${MAX_RECT_MOTION_KEYS} keys`);
    expect(refusal(motion({ atMs: [100, 50] })).field).toBe('atMs[1]');
    expect(refusal(motion({ atMs: [0, Number.NaN] })).field).toBe('atMs[1]');
    expect(refusal(motion({ w: [1, null] })).field).toBe('w[1]');
  });
});

describe('toComposeSpec', () => {
  const uris = new Map([
    ['a', 'file:///a.mp4'],
    ['b', 'file:///b.mp4'],
  ]);
  const context = { output: emptyManifest().output, textStyle: () => ({}), stickerUrl: () => '', fileUrl: (u: string) => u } as unknown as RasterContext;
  const wire = (m: EditManifest): Promise<ComposeSpec> => toComposeSpec(m, uris, { jobId: 'j', batchId: 'b' }, context);

  it('sends a layout that holds still exactly as it always has: no rectMotion anywhere', async () => {
    const spec = await wire(post('splitTopBottom', null));
    expect(spec.clips[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect('rectMotion' in spec.clips[0]).toBe(false);
    expect('rectMotion' in spec.tracks![0].clips[0]).toBe(false);
  });

  it('sends each moving clip its resting rectangle and the keys that bring it there', async () => {
    const m = post('splitTopBottom', 'slide');
    const spec = await wire(m);
    const motions = compileLayoutMotions(m);
    expect(spec.clips[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(spec.clips[0].rectMotion).toEqual(motions.get('seg-a')!.motion);
    expect(spec.tracks![0].clips[0].rect).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    expect(spec.tracks![0].clips[0].rectMotion).toEqual(motions.get('seg-b')!.motion);
    // What the wire carries is what every parser accepts, untouched.
    expect(normaliseRectMotion(spec.clips[0].rectMotion)).toEqual(spec.clips[0].rectMotion);
  });

  it('sends a base clip that only plays while the layout is closed with no rectangle at all', async () => {
    const m = post('splitTopBottom', 'slide', [defaultClipEdit('a', 1500, 'seg-1'), defaultClipEdit('a', 8500, 'seg-2')]);
    const spec = await wire(m);
    expect('rect' in spec.clips[0]).toBe(false);
    expect('rectMotion' in spec.clips[0]).toBe(false);
    expect(spec.clips[1].rectMotion).toBeDefined();
  });

  it('carries the keys onto a transition tail, which plays on under the next clip as its clip would have', async () => {
    const outgoing = defaultClipEdit('a', 2300, 'seg-1');
    const incoming: EditClip = { ...defaultClipEdit('a', 7700, 'seg-2'), transitionIn: { kind: 'dissolve', durationMs: 500 } };
    const spec = await wire(post('splitTopBottom', 'slide', [outgoing, incoming]));
    const from = spec.clips[1].transitionIn!.from;
    expect(from.rectMotion).toEqual(spec.clips[0].rectMotion);
    // The tail plays 1800..2300 of the output, so its keys reach the end of that.
    expect(from.rectMotion!.atMs[from.rectMotion!.atMs.length - 1]).toBe(2300);
  });
});
