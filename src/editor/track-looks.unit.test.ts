import { describe, expect, it } from 'vitest';

import type { ComposeFocus } from '../video-composer/definitions';

import { toComposeSpec } from './compose';
import { defaultClipEdit, defaultPictureEdit, emptyManifest, type EditClip, type EditManifest, type EditTrack } from './edit-manifest';
import { FOCUS_MAX_SIGMA, defaultFocus } from './focus';
import type { RasterContext } from './raster-context';
import { focusLevels, focusMask, parseSubjectTrack, type SubjectTrack } from './subject-track';
import { LOOK_KEPT, LOOK_REACH, LOOK_RINGS, hasTrackLooks, segmentLook, segmentLooks, type SegmentLook } from './track-looks';

/*
 * A look that follows a track is drawn by the Focus engine from a subject track made off the track's path,
 * so this holds the made track to what the engine will read: the ellipse in the cells it covers, its rings
 * and their levels, the look off on the frames either side of the track's span, and the whole of it read
 * back through `focusLevels` and `focusMask` as every renderer reads it. Then what decides which looks a
 * segment shows, what is kept between two calls, and what `toComposeSpec` sends.
 *
 * The footage is square (aspect 1), so the grid is 320 cells each way and a cell is 1/320 of either side.
 */

const GRID = 320;

/** The thing's samples: a tenth of a second apart from 1 s to 2 s of the source. */
const AT = Array.from({ length: 11 }, (_, i) => 1000 + i * 100);

/** A blurred thing standing still at (0.4, 0.5) of the source over [AT], unless `over` says otherwise. */
function thing(over: Partial<EditTrack> = {}): EditTrack {
  const atMs = over.atMs ?? AT;
  return {
    id: 'face',
    name: 'Track 1',
    hue: 0,
    clipId: 'c1',
    clipKey: 'a',
    aspect: 1,
    box: { w: 0.2, h: 0.3 },
    atMs,
    x: atMs.map(() => 0.4),
    y: atMs.map(() => 0.5),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    smooth: 0,
    look: { kind: 'blur', amount: 0.7 },
    ...over,
  };
}

/** One sample on a picture: a still thing at (`x`, `y`), `w` by `h`. */
function stillThing(x: number, y: number, w: number, h: number, over: Partial<EditTrack> = {}): EditTrack {
  return thing({ atMs: [5000], x: [x], y: [y], scale: [1], turn: [0], box: { w, h }, ...over });
}

/** Segment `c1` of source `a`, three seconds of it from its start. */
const clip = (over: Partial<EditClip> = {}): EditClip => ({ ...defaultClipEdit('a', 3000, 'c1'), ...over });

const picture = (): EditClip => defaultPictureEdit('a', 'c1');

function made(look: SegmentLook | null): SubjectTrack {
  expect(look).not.toBeNull();
  return parseSubjectTrack(look!.bytes);
}

/** The cell whose centre is nearest (`x`, `y`). */
function cellAt(x: number, y: number): number {
  return Math.floor(y * GRID) * GRID + Math.floor(x * GRID);
}

/** Each ring's level, its id `first + k`. */
function rings(first: number): { id: number; focus: number[] }[] {
  return LOOK_RINGS.map((level, k) => ({ id: first + k, focus: [level] }));
}

describe('segmentLook: the subject track', () => {
  it('draws the thing as the ellipse inside its box, grown, in the cells whose centres it covers', () => {
    const track = made(segmentLook(picture(), [stillThing(0.3, 0.6, 0.2, 0.1, { scale: [1.5] })]));
    expect([track.width, track.height, track.frameCount, [...track.times]]).toEqual([GRID, GRID, 1, [0]]);
    const cells = track.frame(0);
    const a = (0.2 * 1.5 * LOOK_REACH) / 2;
    const b = (0.1 * 1.5 * LOOK_REACH) / 2;
    // The middle to the shape's edge, then a ring for every quarter of the feather - a tenth of the radius.
    const edges = [1, 1.025, 1.05, 1.075, 1.1];
    const wrong: string[] = [];
    let middle = 0;
    for (let gy = 0; gy < GRID; gy++) {
      for (let gx = 0; gx < GRID; gx++) {
        const d = Math.hypot(((gx + 0.5) / GRID - 0.3) / a, ((gy + 0.5) / GRID - 0.6) / b);
        // A centre on an edge, to rounding, is the arithmetic's to place either way.
        if (edges.some(edge => Math.abs(d - edge) < 1e-9)) continue;
        const ring = edges.findIndex(edge => d <= edge);
        const want = ring < 0 ? 0 : 1 + ring;
        if (want === 1) middle++;
        if (cells[gy * GRID + gx] !== want) wrong.push(`${gx},${gy}: ${cells[gy * GRID + gx]} not ${want}`);
      }
    }
    expect(wrong).toEqual([]);
    expect(middle).toBeGreaterThan(1000);
  });

  it('feathers its edge with rings of their own ids, each at a level that falls away', () => {
    const look = segmentLook(picture(), [stillThing(0.5, 0.5, 0.5, 0.5)])!;
    expect(look.focus).toEqual({ atMs: [0], subjects: rings(1), blur: Math.round(0.7 * FOCUS_MAX_SIGMA * 10_000) / 10_000, invert: true });
    // Out from the middle along a row: the middle, each ring in turn, then the world.
    const row = made(look).frame(0).subarray(160 * GRID + 160, 161 * GRID);
    const order = [...row].filter((id, i) => i === 0 || id !== row[i - 1]);
    expect(order).toEqual([1, 2, 3, 4, 5, 0]);
  });

  it('switches a blur off on the frame either side of the track: every cell the world, softened nowhere', () => {
    const track = made(segmentLook(clip(), [thing()]));
    expect([...track.times]).toEqual([999, ...AT, 2001]);
    expect(track.frame(0).every(id => id === 0)).toBe(true);
    expect(track.frame(track.frameCount - 1).every(id => id === 0)).toBe(true);
    expect(track.frame(1)[cellAt(0.4, 0.5)]).toBe(1);
    expect(track.frame(1)[cellAt(0.9, 0.1)]).toBe(0);
  });

  it('switches a spotlight off the same way, with every cell kept rather than dimmed', () => {
    const look = segmentLook(clip(), [thing({ look: { kind: 'spotlight', amount: 0.6 } })])!;
    expect(look.focus).toEqual({ atMs: [0], subjects: [{ id: LOOK_KEPT, focus: [1] }, ...rings(LOOK_KEPT + 1)], blur: 0, dim: 0.6 });
    const track = made(look);
    expect(track.frame(0).every(id => id === LOOK_KEPT)).toBe(true);
    expect(track.frame(track.frameCount - 1).every(id => id === LOOK_KEPT)).toBe(true);
    expect(track.frame(1)[cellAt(0.4, 0.5)]).toBe(LOOK_KEPT + 1);
    expect(track.frame(1)[cellAt(0.9, 0.1)]).toBe(0);
  });

  it('reads back through the focus engine: the thing in its look only while the track is on it', () => {
    const mask = (look: SegmentLook, t: number): Uint8Array => {
      const focus: ComposeFocus = { uri: 'blob:look', ...look.focus };
      return focusMask(parseSubjectTrack(look.bytes), focusLevels(focus, t), t, focus.invert === true);
    };
    const blur = segmentLook(clip(), [thing()])!;
    expect(mask(blur, 500).every(m => m === 255)).toBe(true);
    expect(mask(blur, 1500)[cellAt(0.4, 0.5)]).toBe(0);
    expect(mask(blur, 1500)[cellAt(0.9, 0.1)]).toBe(255);
    expect(mask(blur, 2500).every(m => m === 255)).toBe(true);

    const spotlight = segmentLook(clip(), [thing({ look: { kind: 'spotlight', amount: 0.6 } })])!;
    expect(mask(spotlight, 500).every(m => m === 255)).toBe(true);
    expect(mask(spotlight, 1500)[cellAt(0.4, 0.5)]).toBe(255);
    expect(mask(spotlight, 1500)[cellAt(0.9, 0.1)]).toBe(0);
    expect(mask(spotlight, 2500).every(m => m === 255)).toBe(true);
  });

  it('follows the thing from frame to frame', () => {
    const track = made(segmentLook(clip(), [thing({ x: AT.map((_, i) => 0.2 + i * 0.05) })]));
    // Frame 1 is the track's first sample, at 0.2 across; the last but one its last, at 0.7.
    expect(track.frame(1)[cellAt(0.2, 0.5)]).toBe(1);
    expect(track.frame(1)[cellAt(0.7, 0.5)]).toBe(0);
    expect(track.frame(11)[cellAt(0.7, 0.5)]).toBe(1);
    expect(track.frame(11)[cellAt(0.2, 0.5)]).toBe(0);
  });

  it('covers each track whole whatever the trim, so a trim dragged asks for the look already made', () => {
    const at30 = Array.from({ length: 91 }, (_, k) => Math.round((k * 1000) / 30));
    const steady = thing({ atMs: at30, x: at30.map(() => 0.5), y: at30.map(() => 0.5), scale: at30.map(() => 1), turn: at30.map(() => 0) });
    const whole = segmentLook(clip(), [steady])!;
    // Every sample, and the instant after the last: nothing comes before 0.
    expect([...made(whole).times]).toEqual([...at30, 3001]);
    expect(segmentLook(clip({ inMs: 1010, outMs: 2000 }), [steady])).toBe(whole);
  });

  it('leaves out frames too close to be told apart, but never one a look starts or stops on', () => {
    const steady = (atMs: number[]) => thing({ atMs, x: atMs.map(() => 0.5), y: atMs.map(() => 0.5), scale: atMs.map(() => 1), turn: atMs.map(() => 0) });
    const at60 = Array.from({ length: 181 }, (_, k) => Math.round((k * 1000) / 60));
    const thinned = [...made(segmentLook(clip(), [steady(at60)])).times];
    expect(thinned[0]).toBe(0);
    expect(thinned.slice(-2)).toEqual([3000, 3001]);
    expect(thinned.slice(0, -1).every((t, i) => i === 0 || t - thinned[i - 1]! >= 20)).toBe(true);
    expect(thinned.length).toBeLessThan(100);
  });
});

describe('segmentLook: which looks a segment shows', () => {
  const at = (x: number) => AT.map(() => x);

  it('draws blurs alone where a segment has blurs and spotlights, as strong as the strongest', () => {
    const faint = thing({ id: 'a', look: { kind: 'blur', amount: 0.3 } });
    const lit = thing({ id: 'b', x: at(0.8), look: { kind: 'spotlight', amount: 0.8 } });
    const strong = thing({ id: 'c', x: at(0.2), look: { kind: 'blur', amount: 0.9 } });
    expect(segmentLook(clip(), [faint, lit])!.focus).toEqual({ atMs: [0], subjects: rings(1), blur: 0.009, invert: true });

    const both = segmentLook(clip(), [faint, lit, strong])!;
    expect(both.focus).toEqual({ atMs: [0], subjects: [...rings(1), ...rings(1 + LOOK_RINGS.length)], blur: 0.027, invert: true });
    // Each blurred thing in ids of its own, and the spotlit one not drawn at all.
    const frame = made(both).frame(1);
    expect([frame[cellAt(0.4, 0.5)], frame[cellAt(0.2, 0.5)], frame[cellAt(0.8, 0.5)]]).toEqual([1, 1 + LOOK_RINGS.length, 0]);
  });

  it('draws spotlights and pops as one focus, the world dimmed and greyed round every thing', () => {
    const lit = thing({ id: 'a', look: { kind: 'spotlight', amount: 0.8 } });
    const popped = thing({ id: 'b', x: at(0.8), look: { kind: 'pop', amount: 0.4 } });
    const look = segmentLook(clip(), [lit, popped])!;
    expect(look.focus).toEqual({ atMs: [0], subjects: [{ id: LOOK_KEPT, focus: [1] }, ...rings(2), ...rings(2 + LOOK_RINGS.length)], blur: 0, mono: 0.4, dim: 0.8 });
    const frame = made(look).frame(1);
    expect([frame[cellAt(0.4, 0.5)], frame[cellAt(0.8, 0.5)], frame[cellAt(0.6, 0.1)]]).toEqual([2, 2 + LOOK_RINGS.length, 0]);
  });

  it('draws nothing where the segment has a Focus of its own, plays other footage, or misses the track', () => {
    expect(segmentLook(clip({ focus: defaultFocus() }), [thing()])).toBeNull();
    expect(segmentLook(clip({ clipKey: 'b' }), [thing()])).toBeNull();
    expect(segmentLook(clip({ inMs: 2500, outMs: 3000 }), [thing()])).toBeNull();
    expect(segmentLook(clip(), [thing({ look: undefined })])).toBeNull();
    expect(segmentLook(clip(), undefined)).toBeNull();
    // A Focus that changes nothing is no Focus.
    expect(segmentLook(clip({ focus: { subjects: 'main', blur: 0 } }), [thing()])).not.toBeNull();
  });

  it('keys a picture from 0, its one frame holding throughout', () => {
    const look = segmentLook(picture(), [stillThing(0.5, 0.5, 0.2, 0.2)])!;
    expect(look.focus.atMs).toEqual([0]);
    expect([...made(look).times]).toEqual([0]);
  });

  it('hands back the bytes it made while only a strength or the trim changes, and the very look while nothing does', () => {
    const face = thing();
    const first = segmentLook(clip(), [face])!;
    expect(segmentLook(clip(), [{ ...face, name: 'Face' }])).toBe(first);

    const fainter = segmentLook(clip(), [{ ...face, look: { kind: 'blur', amount: 0.2 } }])!;
    expect(fainter).not.toBe(first);
    expect(fainter.bytes).toBe(first.bytes);
    expect(fainter.focus.blur).toBe(0.006);
    expect(segmentLook(clip({ inMs: 500, outMs: 2500 }), [face])!.bytes).toBe(first.bytes);

    expect(segmentLook(clip(), [{ ...face, x: AT.map(() => 0.6) }])!.bytes).not.toBe(first.bytes);
    // The other way round is other bytes: its frames off the track are kept, not the world.
    expect(segmentLook(clip(), [{ ...face, look: { kind: 'spotlight', amount: 0.7 } }])!.bytes).not.toBe(first.bytes);
  });
});

describe('segmentLooks', () => {
  it('answers every looked segment by its id, and nothing for a post with no look', () => {
    const halves: EditClip[] = [clip({ outMs: 1500 }), clip({ id: 'c2', inMs: 1500 }), { ...defaultClipEdit('a', 3000, 'c3'), focus: defaultFocus() }];
    const manifest: EditManifest = { ...emptyManifest(), clips: halves, tracks: [thing()] };
    const looks = segmentLooks(manifest);
    expect([...looks.keys()]).toEqual(['c1', 'c2']);
    // A cut through the footage is one look, made once, read by both halves.
    expect(looks.get('c2')).toBe(looks.get('c1'));
    expect(looks.get('c2')!.focus.atMs).toEqual([0]);

    const plain: EditManifest = { ...manifest, tracks: [thing({ look: undefined })] };
    expect(hasTrackLooks(plain)).toBe(false);
    expect(segmentLooks(plain).size).toBe(0);
  });
});

describe('toComposeSpec with track looks', () => {
  const raster = { output: { width: 720, height: 1280, fps: 30 } } as unknown as RasterContext;
  const ids = { jobId: 'j', batchId: 'b' };
  const uris = new Map([
    ['a', 'file:///a.mp4'],
    ['b', 'file:///b.mp4'],
  ]);
  const subjects = new Map([['b', { uri: 'file:///subjects/b.vkst', subjects: [{ id: 1 }] }]]);

  /** The looks a render host hands over: each segment's focus under a `blob:` of its own. */
  function handed(manifest: EditManifest): Map<string, ComposeFocus> {
    return new Map([...segmentLooks(manifest)].map(([id, look]) => [id, { uri: `blob:look/${id}`, ...look.focus }]));
  }

  it('sends a looked segment its look, under the uri it was handed, and a focused one its own focus', async () => {
    const manifest: EditManifest = { ...emptyManifest(), clips: [clip(), { ...defaultClipEdit('b', 4000, 'c2'), focus: defaultFocus() }], tracks: [thing()] };
    const spec = await toComposeSpec(manifest, uris, ids, raster, {}, subjects, handed(manifest));
    expect(spec.clips[0]!.focus).toEqual({ uri: 'blob:look/c1', ...segmentLooks(manifest).get('c1')!.focus });
    expect(spec.clips[1]!.focus?.uri).toBe('file:///subjects/b.vkst');
  });

  it('never sends a look on a segment with a Focus of its own, even one whose subjects could not be had', async () => {
    const manifest: EditManifest = { ...emptyManifest(), clips: [clip({ focus: defaultFocus() })], tracks: [thing()] };
    const stray = new Map([['c1', { uri: 'blob:look/c1', atMs: [0], subjects: rings(1), blur: 0.021, invert: true }]]);
    const spec = await toComposeSpec(manifest, uris, ids, raster, {}, new Map(), stray);
    expect('focus' in spec.clips[0]!).toBe(false);
  });

  it('carries the look onto the transition that plays the segment out', async () => {
    const manifest: EditManifest = {
      ...emptyManifest(),
      clips: [clip(), { ...defaultClipEdit('b', 4000, 'c2'), transitionIn: { kind: 'dissolve', durationMs: 1000 } }],
      tracks: [thing()],
    };
    const spec = await toComposeSpec(manifest, uris, ids, raster, {}, new Map(), handed(manifest));
    expect(spec.clips[1]!.transitionIn?.from.focus).toEqual(spec.clips[0]!.focus);
    expect(spec.clips[0]!.focus?.uri).toBe('blob:look/c1');
  });

  it('sends a post with no look exactly as it always did', async () => {
    const manifest: EditManifest = { ...emptyManifest(), clips: [clip(), { ...defaultClipEdit('b', 4000, 'c2'), focus: defaultFocus() }], tracks: [thing({ look: undefined })] };
    const before = await toComposeSpec(manifest, uris, ids, raster, {}, subjects);
    const after = await toComposeSpec(manifest, uris, ids, raster, {}, subjects, handed(manifest));
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
    expect('focus' in after.clips[0]!).toBe(false);
  });
});
