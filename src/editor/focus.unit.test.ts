import { describe, expect, it } from 'vitest';

import type { RasterContext } from './raster-context';
import { toComposeSpec } from './compose';
import { defaultClipEdit, defaultPictureEdit, emptyManifest, isUntouched, normaliseManifest, type EditClip, type EditFocus, type EditManifest } from './edit-manifest';
import { addFocusChange, canJoinWithNext, findClip, patchClipFocus, removeFocusChange, replaceClipSource, setClipFocus, setFocusSubjects, splitClipAt } from './edit-ops';
import {
  DEFAULT_FOCUS_BLUR,
  FOCUS_MAX_SIGMA,
  compileFocus,
  defaultFocus,
  focusEntryAt,
  focusEntrySubjects,
  normaliseFocus,
  resolveFocusSubjects,
  sameFocus,
  type SubjectTrackRef,
} from './focus';

/*
 * A focus is stored as what the customer chose and sent as keys, so this holds both halves: what the
 * manifest keeps of a focus, and what [compileFocus] turns that into against a subject track - the
 * ids 'main' and 'all' stand for, the two keys of every pull, the cut to the segment's trim.
 */

const TRACK: SubjectTrackRef = { uri: 'file:///subjects/a.vkst', subjects: [{ id: 1 }, { id: 2 }, { id: 3 }] };

const clip = (focus: EditFocus, over: Partial<EditClip> = {}): EditClip => ({ ...defaultClipEdit('a', 10_000, 'c1'), focus, ...over });

describe('normaliseFocus', () => {
  it('reads nothing that is not an object', () => {
    expect(normaliseFocus(undefined)).toBeUndefined();
    expect(normaliseFocus(null)).toBeUndefined();
    expect(normaliseFocus('main')).toBeUndefined();
  });

  it('fills what is missing and leaves off what says nothing', () => {
    expect(normaliseFocus({})).toEqual({ subjects: 'main', blur: DEFAULT_FOCUS_BLUR });
    expect(normaliseFocus({ subjects: 'all', blur: 0.3, mono: 0, dim: 0, invert: false })).toEqual({ subjects: 'all', blur: 0.3 });
    expect(normaliseFocus({ subjects: 'all', blur: 0.3, mono: 0.5, dim: 0.25, invert: true })).toEqual({ subjects: 'all', blur: 0.3, mono: 0.5, dim: 0.25, invert: true });
  });

  it('holds the looks to 0..1 and a list to unique ids 1..255 in order', () => {
    expect(normaliseFocus({ subjects: [3, 1, 3, 0, 256, 2.5, 'x', 2], blur: 7, mono: -1, dim: Number.NaN })).toEqual({ subjects: [1, 2, 3], blur: 1 });
    expect(normaliseFocus({ subjects: [], blur: 0 })).toEqual({ subjects: [], blur: 0 });
    expect(normaliseFocus({ subjects: 'nobody' })?.subjects).toBe('main');
  });

  it('keeps one change per instant, in order, the later kept, with its pull only when it is not the default', () => {
    const focus = normaliseFocus({
      subjects: 'main',
      blur: 0.5,
      changes: [
        { atMs: 3000.4, subjects: [2], pullMs: 500 },
        { atMs: 1000, subjects: 'all', pullMs: 9000 },
        { atMs: 3000, subjects: [3], pullMs: 0 },
        { atMs: 'later', subjects: [1] },
        { atMs: 5000, subjects: 'everybody' },
        null,
      ],
    });
    expect(focus?.changes).toEqual([
      { atMs: 1000, subjects: 'all', pullMs: 3000 },
      { atMs: 3000, subjects: [3], pullMs: 0 },
    ]);
  });

  it('survives a manifest round trip, and a clip without one keeps no key', () => {
    const manifest = normaliseManifest({ ...emptyManifest(), clips: [clip({ subjects: [2], blur: 0.4, mono: 1 }), defaultClipEdit('b', 1000, 'c2')] });
    expect(manifest.clips[0]!.focus).toEqual({ subjects: [2], blur: 0.4, mono: 1 });
    expect('focus' in manifest.clips[1]!).toBe(false);
    expect(normaliseManifest(JSON.parse(JSON.stringify(manifest)))).toEqual(manifest);
  });
});

describe('choices of subjects', () => {
  it('resolves main to the strongest, all to every one, and a list to the ids the track has', () => {
    expect(resolveFocusSubjects('main', TRACK)).toEqual([1]);
    expect(resolveFocusSubjects('all', TRACK)).toEqual([1, 2, 3]);
    expect(resolveFocusSubjects([2, 9], TRACK)).toEqual([2]);
    expect(resolveFocusSubjects('main', { subjects: [] })).toEqual([]);
  });

  it('finds the choice in effect at an instant', () => {
    const focus: EditFocus = { subjects: 'main', blur: 0.5, changes: [{ atMs: 2000, subjects: [2] }, { atMs: 5000, subjects: 'all' }] };
    expect(focusEntryAt(focus, 0)).toBe(-1);
    expect(focusEntryAt(focus, 1999)).toBe(-1);
    expect(focusEntryAt(focus, 2000)).toBe(0);
    expect(focusEntryAt(focus, 9000)).toBe(1);
    expect(focusEntrySubjects(focus, -1)).toBe('main');
    expect(focusEntrySubjects(focus, 0)).toEqual([2]);
  });

  it('compares focuses key for key', () => {
    expect(sameFocus(defaultFocus(), defaultFocus())).toBe(true);
    expect(sameFocus({ subjects: [1, 2], blur: 0.5 }, { subjects: [1, 2], blur: 0.5 })).toBe(true);
    expect(sameFocus({ subjects: [1, 2], blur: 0.5 }, { subjects: [1], blur: 0.5 })).toBe(false);
    expect(sameFocus({ subjects: 'main', blur: 0.5, changes: [{ atMs: 1, subjects: 'all' }] }, { subjects: 'main', blur: 0.5, changes: [{ atMs: 1, subjects: 'all', pullMs: 500 }] })).toBe(true);
    expect(sameFocus(undefined, defaultFocus())).toBe(false);
  });
});

describe('compileFocus', () => {
  it('sends nothing for footage nothing stood out in, or a focus that changes nothing', () => {
    expect(compileFocus(clip(defaultFocus()), { uri: 'x', subjects: [] })).toBeNull();
    expect(compileFocus(clip({ subjects: 'main', blur: 0 }), TRACK)).toBeNull();
    expect(compileFocus({ ...defaultClipEdit('a', 1000) }, TRACK)).toBeNull();
  });

  it('is one key, the main subject in focus, for a focus that never changes', () => {
    expect(compileFocus(clip({ subjects: 'main', blur: 0.5, mono: 0.25, dim: 0.5, invert: true }, { inMs: 1000, outMs: 4000 }), TRACK)).toEqual({
      uri: TRACK.uri,
      atMs: [1000],
      subjects: [{ id: 1, focus: [1] }],
      blur: 0.5 * FOCUS_MAX_SIGMA,
      mono: 0.25,
      dim: 0.5,
      invert: true,
    });
  });

  it('lists only the subjects ever in focus, and none for a choice of nobody', () => {
    expect(compileFocus(clip({ subjects: 'all', blur: 1 }), TRACK)?.subjects).toEqual([
      { id: 1, focus: [1] },
      { id: 2, focus: [1] },
      { id: 3, focus: [1] },
    ]);
    const nobody = compileFocus(clip({ subjects: [], blur: 1 }), TRACK);
    expect(nobody?.subjects).toEqual([]);
    expect(nobody?.blur).toBe(FOCUS_MAX_SIGMA);
  });

  it('pulls focus in a straight line from where each change starts to where its pull ends', () => {
    const wire = compileFocus(clip({ subjects: 'main', blur: 0.5, changes: [{ atMs: 2000, subjects: [2] }, { atMs: 6000, subjects: [3], pullMs: 0 }] }), TRACK);
    expect(wire?.atMs).toEqual([0, 2000, 2500, 6000, 6000, 10_000]);
    expect(wire?.subjects).toEqual([
      { id: 1, focus: [1, 1, 0, 0, 0, 0] },
      { id: 2, focus: [0, 0, 1, 1, 0, 0] },
      { id: 3, focus: [0, 0, 0, 0, 1, 1] },
    ]);
  });

  it('starts a change made mid pull from wherever the pull had got to', () => {
    const wire = compileFocus(clip({ subjects: [1], blur: 0.5, changes: [{ atMs: 1000, subjects: [2], pullMs: 1000 }, { atMs: 1500, subjects: [1], pullMs: 1000 }] }), TRACK);
    expect(wire?.atMs).toEqual([0, 1000, 1500, 2500, 10_000]);
    expect(wire?.subjects).toEqual([
      { id: 1, focus: [1, 1, 0.5, 1, 1] },
      { id: 2, focus: [0, 0, 0.5, 0, 0] },
    ]);
  });

  it('is cut to the segment, the changes before it folded into where it starts', () => {
    const focus: EditFocus = { subjects: 'main', blur: 0.5, changes: [{ atMs: 2000, subjects: [2] }, { atMs: 8000, subjects: [3] }] };
    // A piece from 2250 to 5000: half way through the first pull, and nothing after.
    const wire = compileFocus(clip(focus, { inMs: 2250, outMs: 5000 }), TRACK);
    expect(wire?.atMs).toEqual([2250, 2500, 5000]);
    expect(wire?.subjects).toEqual([
      { id: 1, focus: [0.5, 0, 0] },
      { id: 2, focus: [0.5, 1, 1] },
    ]);
    // A piece wholly after the first pull is one key.
    expect(compileFocus(clip(focus, { inMs: 3000, outMs: 7000 }), TRACK)?.atMs).toEqual([3000]);
  });

  it('moves a picture to start at 0, as its trim does on the wire', () => {
    const picture = { ...defaultPictureEdit('p', 'c1', 3000), focus: { subjects: 'main', blur: 0.5, changes: [] } as EditFocus };
    picture.focus.changes = [{ atMs: picture.inMs + 1000, subjects: [2] }];
    const wire = compileFocus(picture, TRACK);
    expect(wire?.atMs).toEqual([0, 1000, 1500, 3000]);
  });
});

describe('focus ops', () => {
  const manifest: EditManifest = { ...emptyManifest(), clips: [defaultClipEdit('a', 10_000, 'c1'), defaultClipEdit('b', 4000, 'c2')] };

  it('puts a focus on and takes it off, held to what the manifest keeps', () => {
    const on = setClipFocus(manifest, 'c1', { subjects: [2, 2, 1], blur: 3 } as EditFocus);
    expect(findClip(on, 'c1')?.focus).toEqual({ subjects: [1, 2], blur: 1 });
    expect(setClipFocus(on, 'c1', { subjects: [1, 2], blur: 1 })).toBe(on);
    expect('focus' in findClip(setClipFocus(on, 'c1', null), 'c1')!).toBe(false);
  });

  it('changes the look and leaves the subjects alone', () => {
    const on = setClipFocus(manifest, 'c1', defaultFocus());
    const looked = patchClipFocus(on, 'c1', { mono: 0.5, invert: true });
    expect(findClip(looked, 'c1')?.focus).toEqual({ subjects: 'main', blur: DEFAULT_FOCUS_BLUR, mono: 0.5, invert: true });
    expect(findClip(patchClipFocus(looked, 'c1', { invert: false, mono: 0 }), 'c1')?.focus).toEqual(defaultFocus());
    expect(patchClipFocus(manifest, 'c1', { blur: 1 })).toBe(manifest);
  });

  it('adds, edits and takes off changes', () => {
    const on = setClipFocus(manifest, 'c1', defaultFocus());
    const changed = addFocusChange(on, 'c1', 3000, [2])!;
    expect(findClip(changed, 'c1')?.focus?.changes).toEqual([{ atMs: 3000, subjects: [2] }]);
    expect(addFocusChange(on, 'c1', 20_000, [2])).toBeNull();
    expect(addFocusChange(manifest, 'c1', 3000, [2])).toBeNull();
    const edited = setFocusSubjects(changed, 'c1', 0, 'all');
    expect(findClip(edited, 'c1')?.focus?.changes).toEqual([{ atMs: 3000, subjects: 'all' }]);
    expect(findClip(setFocusSubjects(edited, 'c1', -1, [3]), 'c1')?.focus?.subjects).toEqual([3]);
    expect('changes' in findClip(removeFocusChange(edited, 'c1', 0), 'c1')!.focus!).toBe(false);
  });

  it('keeps the focus on both halves of a split, and joins only halves that agree', () => {
    const on = setClipFocus(manifest, 'c1', defaultFocus());
    const split = splitClipAt(on, 5000, 'c1b')!;
    expect(findClip(split, 'c1b')?.focus).toEqual(defaultFocus());
    expect(canJoinWithNext(split, 'c1')).toBe(true);
    expect(canJoinWithNext(patchClipFocus(split, 'c1b', { blur: 1 }), 'c1')).toBe(false);
  });

  it('carries the look onto new footage, but not the old footage ids or moments', () => {
    const on = setClipFocus(manifest, 'c1', { subjects: [2], blur: 0.7, dim: 0.2, changes: [{ atMs: 1000, subjects: 'all' }] });
    const replaced = replaceClipSource(on, 'c1', 'z', 8000);
    expect(findClip(replaced, 'c1')?.focus).toEqual({ subjects: 'main', blur: 0.7, dim: 0.2 });
  });

  it('makes a lone clip a render rather than the file as it is', () => {
    const lone: EditManifest = { ...emptyManifest(), clips: [defaultClipEdit('a', 10_000, 'c1')] };
    const durations = new Map([['a', 10_000]]);
    expect(isUntouched({ ...lone, fit: 'contain' }, durations)).toBe(true);
    expect(isUntouched({ ...setClipFocus(lone, 'c1', defaultFocus()), fit: 'contain' }, durations)).toBe(false);
    expect(isUntouched({ ...setClipFocus(lone, 'c1', { subjects: 'main', blur: 0 }), fit: 'contain' }, durations)).toBe(true);
  });
});

describe('toComposeSpec', () => {
  const raster = { output: { width: 720, height: 1280, fps: 30 } } as unknown as RasterContext;
  const uris = new Map([
    ['a', 'file:///a.mp4'],
    ['b', 'file:///b.mp4'],
  ]);

  it('sends a focus only for a segment whose source has a subject track', async () => {
    const manifest: EditManifest = { ...emptyManifest(), clips: [clip(defaultFocus()), { ...defaultClipEdit('b', 4000, 'c2'), focus: defaultFocus() }] };
    const spec = await toComposeSpec(manifest, uris, { jobId: 'j', batchId: 'b' }, raster, {}, new Map([['a', TRACK]]));
    expect(spec.clips[0]!.focus).toEqual({ uri: TRACK.uri, atMs: [0], subjects: [{ id: 1, focus: [1] }], blur: DEFAULT_FOCUS_BLUR * FOCUS_MAX_SIGMA });
    expect('focus' in spec.clips[1]!).toBe(false);
    // And none at all without tracks: the spec a post with no focus always was.
    const bare = await toComposeSpec(manifest, uris, { jobId: 'j', batchId: 'b' }, raster);
    expect(bare.clips.some(c => 'focus' in c)).toBe(false);
  });

  it('carries the outgoing clip focus onto the transition that plays its tail', async () => {
    const manifest: EditManifest = {
      ...emptyManifest(),
      clips: [clip(defaultFocus()), { ...defaultClipEdit('b', 4000, 'c2'), transitionIn: { kind: 'dissolve', durationMs: 1000 } }],
    };
    const spec = await toComposeSpec(manifest, uris, { jobId: 'j', batchId: 'b' }, raster, {}, new Map([['a', TRACK]]));
    expect(spec.clips[1]!.transitionIn?.from.focus).toEqual(spec.clips[0]!.focus);
  });
});
