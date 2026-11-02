import { describe, expect, it } from 'vitest';

import { MAX_CUTOUT_OUTLINE } from '../video-composer/definitions';
import { toComposeSpec } from './compose';
import {
  CutoutError,
  MIN_CUTOUT_COVERAGE,
  compileCutout,
  cutoutTarget,
  defaultCutout,
  matteKey,
  normaliseComposeCutout,
  normaliseCutout,
  sameCutout,
  type MatteRef,
} from './cutout';
import { MANIFEST_VERSION, defaultClipEdit, emptyManifest, isUntouched, normaliseManifest, type EditClip, type EditCutout, type EditManifest, type ImageOverlay } from './edit-manifest';
import { addOverlay, findClip, patchClipCutout, patchOverlayCutout, replaceClipSource, setClipCutout, setOverlayCutout, splitClipAt } from './edit-ops';
import type { RasterContext } from './raster-context';

/*
 * A cutout is stored as what the customer chose and sent as the look a render draws against a matte
 * track, so this holds both halves: what the manifest keeps, and what [compileCutout] turns it into -
 * plus the wire parser every engine's is checked against.
 */

const MATTE: MatteRef = { uri: 'file:///mattes/a.vkmt', coverage: 0.3 };

const clip = (cutout: EditCutout, over: Partial<EditClip> = {}): EditClip => ({ ...defaultClipEdit('a', 10_000, 'c1'), cutout, ...over });

const photo = (over: Partial<ImageOverlay> = {}): ImageOverlay => ({
  id: 'p1',
  kind: 'image',
  uri: 'file:///photo.jpg',
  fileName: 'photo.jpg',
  aspect: 0.75,
  cx: 0.5,
  cy: 0.5,
  scale: 1,
  rotationDeg: 0,
  opacity: 1,
  startMs: 0,
  endMs: 0,
  ...over,
});

describe('normaliseCutout', () => {
  it('reads nothing that is not an object', () => {
    expect(normaliseCutout(undefined)).toBeUndefined();
    expect(normaliseCutout(null)).toBeUndefined();
    expect(normaliseCutout('people')).toBeUndefined();
    expect(normaliseCutout([])).toBeUndefined();
  });

  it('keeps a new cutout as nothing at all, and leaves off every key that says nothing', () => {
    expect(normaliseCutout({})).toEqual({});
    expect(normaliseCutout(defaultCutout())).toEqual({});
    expect(normaliseCutout({ target: 'subject', soft: 0, shift: 0, shadow: false, fill: 'red' })).toEqual({});
  });

  it('holds the numbers to their ranges, a colour to lower case #rrggbb, and an outline to a width', () => {
    expect(normaliseCutout({ target: 'people', soft: 3, shift: -7, fill: '#FFD23F', shadow: true })).toEqual({ target: 'people', soft: 1, shift: -1, fill: '#ffd23f', shadow: true });
    expect(normaliseCutout({ outline: { color: '#ABCDEF', width: 0.5 } })).toEqual({ outline: { color: '#abcdef', width: 0.5 } });
    expect(normaliseCutout({ outline: { width: 9 } })).toEqual({ outline: { color: '#ffffff', width: 1 } });
    expect(normaliseCutout({ outline: { color: '#000000', width: 0 } })).toEqual({});
    expect(normaliseCutout({ soft: 0.123456, shift: Number.NaN })).toEqual({ soft: 0.1235 });
  });

  it('says what a cutout keeps, and files its matte by that and the source', () => {
    expect(cutoutTarget(undefined)).toBe('subject');
    expect(cutoutTarget({})).toBe('subject');
    expect(cutoutTarget({ target: 'people' })).toBe('people');
    expect(matteKey('clip-a', 'people')).toBe('people:clip-a');
    expect(matteKey('clip-a', 'subject')).not.toBe(matteKey('clip-a', 'people'));
  });

  it('tells two cutouts apart only by what they say', () => {
    expect(sameCutout({}, { soft: 0 } as EditCutout)).toBe(true);
    expect(sameCutout({ outline: { color: '#ffffff', width: 0.3 } }, { outline: { color: '#ffffff', width: 0.3 } })).toBe(true);
    expect(sameCutout({ outline: { color: '#ffffff', width: 0.3 } }, { outline: { color: '#000000', width: 0.3 } })).toBe(false);
    expect(sameCutout({}, { target: 'people' })).toBe(false);
    expect(sameCutout(undefined, {})).toBe(false);
  });
});

describe('compileCutout', () => {
  it('names the matte and sends only what says something', () => {
    expect(compileCutout(clip({}), MATTE)).toEqual({ uri: MATTE.uri });
  });

  it('sends the edge, the fill as 0..1 RGB and the outline as a fraction of the shorter side', () => {
    const wire = compileCutout(clip({ soft: 0.25, shift: -0.5, fill: '#ff0080', outline: { color: '#ffffff', width: 0.5 } }), MATTE);
    expect(wire).toEqual({ uri: MATTE.uri, soft: 0.25, shift: -0.5, fill: [1, 0, 0.502], outline: { color: [1, 1, 1], width: 0.5 * MAX_CUTOUT_OUTLINE } });
  });

  it('sends nothing for no cutout, or for a matte in which nothing stood out', () => {
    expect(compileCutout(defaultClipEdit('a', 1000, 'c1'), MATTE)).toBeNull();
    expect(compileCutout(clip({}), { uri: MATTE.uri, coverage: 0 })).toBeNull();
    expect(compileCutout(clip({}), { uri: MATTE.uri, coverage: MIN_CUTOUT_COVERAGE / 2 })).toBeNull();
    expect(compileCutout(clip({}), { uri: MATTE.uri, coverage: MIN_CUTOUT_COVERAGE })).not.toBeNull();
  });
});

describe('normaliseComposeCutout', () => {
  it('passes an absent cutout as none', () => {
    expect(normaliseComposeCutout(undefined)).toBeNull();
    expect(normaliseComposeCutout(null)).toBeNull();
  });

  it('refuses a shape no engine could draw, naming the part that broke', () => {
    const field = (value: unknown): string => {
      try {
        normaliseComposeCutout(value);
        return 'accepted';
      } catch (error) {
        expect(error).toBeInstanceOf(CutoutError);
        return (error as CutoutError).field;
      }
    };
    expect(field('matte')).toBe('');
    expect(field({})).toBe('uri');
    expect(field({ uri: '' })).toBe('uri');
    expect(field({ uri: 'a', soft: 'soft' })).toBe('soft');
    expect(field({ uri: 'a', shift: Number.POSITIVE_INFINITY })).toBe('shift');
    expect(field({ uri: 'a', fill: [1, 0] })).toBe('fill');
    expect(field({ uri: 'a', fill: [1, 0, 'x'] })).toBe('fill');
    expect(field({ uri: 'a', outline: 3 })).toBe('outline');
    expect(field({ uri: 'a', outline: { color: [1, 1], width: 0.01 } })).toBe('outline.color');
    expect(field({ uri: 'a', outline: { color: [1, 1, 1] } })).toBe('outline.width');
  });

  it('clamps every number, drops an outline of no width and ignores keys it does not know', () => {
    expect(normaliseComposeCutout({ uri: 'a', soft: 4, shift: -9, fill: [2, -1, 0.5], outline: { color: [0, 9, 1], width: 1 }, glow: true })).toEqual({
      uri: 'a',
      soft: 1,
      shift: -1,
      fill: [1, 0, 0.5],
      outline: { color: [0, 1, 1], width: MAX_CUTOUT_OUTLINE },
    });
    expect(normaliseComposeCutout({ uri: 'a', soft: 0, shift: 0, outline: { color: [1, 1, 1], width: 0 } })).toEqual({ uri: 'a' });
  });

  it('agrees with compileCutout, so a spec the editor writes reads back as it was written', () => {
    const wire = compileCutout(clip({ soft: 0.4, shift: 0.2, fill: '#3d6bff', outline: { color: '#ffd23f', width: 1 } }), MATTE)!;
    expect(normaliseComposeCutout(JSON.parse(JSON.stringify(wire)))).toEqual(wire);
  });
});

describe('the manifest', () => {
  it('is version 20', () => {
    expect(MANIFEST_VERSION).toBe(20);
  });

  it('reads a clip cutout back as it was written, a shadow left behind', () => {
    const manifest = normaliseManifest({ ...emptyManifest(), clips: [{ ...defaultClipEdit('a', 1000, 'c1'), cutout: { target: 'people', fill: '#FFFFFF', shadow: true } }] });
    expect(manifest.clips[0]!.cutout).toEqual({ target: 'people', fill: '#ffffff' });
  });

  it('reads a photo cutout back, a fill left behind, and gives none to any other layer', () => {
    const manifest = normaliseManifest({
      ...emptyManifest(),
      overlays: [photo({ cutout: { fill: '#ff0000', shadow: true, outline: { color: '#ffffff', width: 0.3 } } }), { ...photo({ id: 'p2' }), cutout: 'cut' }],
    });
    expect((manifest.overlays[0] as ImageOverlay).cutout).toEqual({ shadow: true, outline: { color: '#ffffff', width: 0.3 } });
    expect('cutout' in manifest.overlays[1]!).toBe(false);
  });

  it('reads a version-19 draft with no cutouts as it always read', () => {
    const v19 = { ...emptyManifest(), version: 19, clips: [defaultClipEdit('a', 1000, 'c1')], overlays: [photo()] };
    const manifest = normaliseManifest(v19);
    expect('cutout' in manifest.clips[0]!).toBe(false);
    expect('cutout' in manifest.overlays[0]!).toBe(false);
  });

  it('sends a cut-out clip through the renderer rather than posting the file as it is', () => {
    const durations = new Map([['a', 10_000]]);
    const lone: EditManifest = { ...emptyManifest(), clips: [defaultClipEdit('a', 10_000, 'c1')], fit: 'contain' };
    expect(isUntouched(lone, durations)).toBe(true);
    expect(isUntouched(setClipCutout(lone, 'c1', {}), durations)).toBe(false);
  });
});

describe('the ops', () => {
  const base: EditManifest = { ...emptyManifest(), clips: [defaultClipEdit('a', 10_000, 'c1')] };

  it('puts a cutout on, takes it off, and leaves a shadow off a clip', () => {
    const on = setClipCutout(base, 'c1', { soft: 0.2, shadow: true });
    expect(findClip(on, 'c1')!.cutout).toEqual({ soft: 0.2 });
    const off = setClipCutout(on, 'c1', null);
    expect('cutout' in findClip(off, 'c1')!).toBe(false);
  });

  it('patches the look, a null taking a key off, and is no change for the same look', () => {
    const on = setClipCutout(base, 'c1', { fill: '#ffffff' });
    const patched = patchClipCutout(on, 'c1', { fill: null, outline: { color: '#000000', width: 0.4 }, target: 'people' });
    expect(findClip(patched, 'c1')!.cutout).toEqual({ target: 'people', outline: { color: '#000000', width: 0.4 } });
    expect(patchClipCutout(patched, 'c1', { target: 'people' })).toBe(patched);
    expect(patchClipCutout(patched, 'c1', { target: 'subject' }).clips[0]!.cutout).toEqual({ outline: { color: '#000000', width: 0.4 } });
    // A segment with none is not given one by a patch.
    expect(patchClipCutout(base, 'c1', { soft: 0.5 })).toBe(base);
  });

  it('keeps the cutout on both halves of a split, and on new footage after a replace', () => {
    const on = setClipCutout(base, 'c1', { fill: '#ffd23f' });
    const split = splitClipAt(on, 5000, 'c2');
    expect(split?.clips.map(c => c.cutout)).toEqual([{ fill: '#ffd23f' }, { fill: '#ffd23f' }]);
    const replaced = replaceClipSource(on, 'c1', 'b', 8000);
    expect(findClip(replaced, 'c1')!.cutout).toEqual({ fill: '#ffd23f' });
  });

  it('cuts out a photo layer and nothing else, and keeps no fill on it', () => {
    const withPhoto = addOverlay(base, photo())!;
    const cut = setOverlayCutout(withPhoto, 'p1', { fill: '#ff0000', outline: { color: '#ffffff', width: 0.3 } });
    expect((cut.overlays[0] as ImageOverlay).cutout).toEqual({ outline: { color: '#ffffff', width: 0.3 } });
    const shadowed = patchOverlayCutout(cut, 'p1', { shadow: true });
    expect((shadowed.overlays[0] as ImageOverlay).cutout).toEqual({ outline: { color: '#ffffff', width: 0.3 }, shadow: true });
    expect(patchOverlayCutout(shadowed, 'p1', { shadow: true })).toBe(shadowed);
    const whole = setOverlayCutout(shadowed, 'p1', null);
    expect('cutout' in whole.overlays[0]!).toBe(false);
    expect(setOverlayCutout(base, 'nobody', {})).toBe(base);
  });
});

describe('toComposeSpec', () => {
  const raster = { output: { width: 720, height: 1280, fps: 30 } } as unknown as RasterContext;
  const uris = new Map([
    ['a', 'file:///a.mp4'],
    ['b', 'file:///b.mp4'],
  ]);
  const mattes = new Map([[matteKey('a', 'subject'), MATTE]]);

  it('sends a cutout only for a segment whose source has a matte for what it keeps', async () => {
    const manifest: EditManifest = {
      ...emptyManifest(),
      clips: [clip({ fill: '#000000' }), { ...defaultClipEdit('b', 4000, 'c2'), cutout: {} }, { ...defaultClipEdit('a', 4000, 'c3'), cutout: { target: 'people' } }],
    };
    const spec = await toComposeSpec(manifest, uris, { jobId: 'j', batchId: 'b' }, raster, {}, new Map(), mattes);
    expect(spec.clips[0]!.cutout).toEqual({ uri: MATTE.uri, fill: [0, 0, 0] });
    expect('cutout' in spec.clips[1]!).toBe(false);
    expect('cutout' in spec.clips[2]!).toBe(false);
    // And none at all without mattes: the spec a post with no cutout always was.
    const bare = await toComposeSpec(manifest, uris, { jobId: 'j', batchId: 'b' }, raster);
    expect(bare.clips.some(c => 'cutout' in c)).toBe(false);
  });

  it('carries the outgoing clip cutout onto the transition that plays its tail', async () => {
    const manifest: EditManifest = {
      ...emptyManifest(),
      clips: [clip({}), { ...defaultClipEdit('b', 4000, 'c2'), transitionIn: { kind: 'dissolve', durationMs: 1000 } }],
    };
    const spec = await toComposeSpec(manifest, uris, { jobId: 'j', batchId: 'b' }, raster, {}, new Map(), mattes);
    expect(spec.clips[1]!.transitionIn?.from.cutout).toEqual({ uri: MATTE.uri });
  });

  it('cuts out a clip on a video layer too', async () => {
    const manifest: EditManifest = {
      ...emptyManifest(),
      clips: [defaultClipEdit('b', 4000, 'c2')],
      videoTracks: [{ id: 't1', clips: [clip({})], startMs: 0, z: 1, opacity: 1 }],
    };
    const spec = await toComposeSpec(manifest, uris, { jobId: 'j', batchId: 'b' }, raster, {}, new Map(), mattes);
    expect(spec.tracks?.[0]!.clips[0]!.cutout).toEqual({ uri: MATTE.uri });
  });
});
