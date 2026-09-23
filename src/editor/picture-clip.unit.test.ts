import { describe, expect, it } from 'vitest';

import type { ComposeSpec } from '../video-composer/definitions';
import { toComposeSpec } from './compose';
import {
  MANIFEST_VERSION,
  PICTURE_CLIP_MS,
  PICTURE_SOURCE_MS,
  clipsDurationMs,
  defaultClipEdit,
  defaultPictureEdit,
  emptyManifest,
  isUntouched,
  normaliseManifest,
  reconcileManifest,
  type EditClip,
  type EditManifest,
} from './edit-manifest';
import { canJoinWithNext, clipDurationMs, joinWithNext, replaceClipSource, setClipSpeed, splitClipAt, trimClip } from './edit-ops';
import type { RasterContext } from './raster-context';

/*
 * A picture on the timeline is a segment like any other, and the whole design rests on that: it is
 * given a long "source" and trimmed out of the middle of it, so every op that trims, cuts, joins or
 * reorders a video does the same to a picture with no second code path. These pin the four places
 * that DO know about pictures - the constructor, the reader, the speed and Replace - and the one
 * translation that tells the engines.
 */

function post(...clips: EditClip[]): EditManifest {
  return { ...emptyManifest(), clips };
}

const picture = (key: string, lengthMs = PICTURE_CLIP_MS) => defaultPictureEdit(key, key, lengthMs);

describe('a picture segment', () => {
  it('lands three seconds long, at 1x, in the middle of its source', () => {
    const clip = defaultPictureEdit('photo', 'seg-1');
    expect(clip).toMatchObject({ id: 'seg-1', clipKey: 'photo', speed: 1, image: true });
    expect(clipDurationMs(clip)).toBe(PICTURE_CLIP_MS);
    expect(clip.inMs).toBeGreaterThan(0);
    expect(clip.outMs).toBeLessThan(PICTURE_SOURCE_MS);
  });

  it('can be pulled longer from EITHER end, which a segment starting at 0 cannot', () => {
    const start = post(picture('p'));
    const clip = start.clips[0];

    const leftPulled = trimClip(start, 'p', clip.inMs - 2000, clip.outMs, PICTURE_SOURCE_MS);
    expect(clipDurationMs(leftPulled.clips[0])).toBe(5000);

    const rightPulled = trimClip(start, 'p', clip.inMs, clip.outMs + 7000, PICTURE_SOURCE_MS);
    expect(clipDurationMs(rightPulled.clips[0])).toBe(10_000);
  });

  it('cuts into two pictures that meet exactly, so Join puts them back', () => {
    const cut = splitClipAt(post(picture('p')), 1200, 'p2')!;
    expect(cut.clips.map(c => [c.id, c.image, clipDurationMs(c)])).toEqual([
      ['p', true, 1200],
      ['p2', true, 1800],
    ]);
    expect(canJoinWithNext(cut, 'p')).toBe(true);
    expect(joinWithNext(cut, 'p')!.clips).toEqual([picture('p')]);
  });

  it('keeps 1x whatever speed it is asked for', () => {
    const before = post(defaultClipEdit('v', 4000), picture('p'));
    expect(setClipSpeed(before, 'p', 2)).toBe(before);
    expect(setClipSpeed(before, 'v', 2).clips[0].speed).toBe(2);
  });

  it('is never posted untouched: there is no file on disk that is the video', () => {
    expect(isUntouched(post(picture('p')), new Map(), 9 / 16)).toBe(false);
  });

  it('mixes with videos, adding up to the length of the post', () => {
    expect(clipsDurationMs([defaultClipEdit('v', 4000), picture('p'), defaultClipEdit('w', 2000)])).toBe(9000);
  });
});

describe('reading a manifest', () => {
  it('keeps the picture and holds it at 1x', () => {
    const read = normaliseManifest({ version: 9, clips: [{ ...picture('p'), speed: 3 }] });
    expect(read.version).toBe(MANIFEST_VERSION);
    expect(read.clips[0]).toMatchObject({ image: true, speed: 1 });
  });

  it('reads a version-8 manifest as it always was: no key, a video', () => {
    const read = normaliseManifest({ version: 8, clips: [defaultClipEdit('v', 4000)] });
    expect('image' in read.clips[0]).toBe(false);
  });

  it('opens a picture the host hands over as a picture segment', () => {
    const opened = reconcileManifest(undefined, ['v', 'photo'], new Map([['v', 4000]]), new Set(['photo']));
    expect(opened.clips.map(c => [c.clipKey, !!c.image, clipDurationMs(c)])).toEqual([
      ['v', false, 4000],
      ['photo', true, PICTURE_CLIP_MS],
    ]);
  });
});

describe('Replace', () => {
  it('puts a picture in a video segment for as long as that segment PLAYS', () => {
    // Four seconds of source at 2x is two seconds on screen, which is what the picture takes.
    const sped = post({ ...defaultClipEdit('v', 4000), speed: 2 });
    const next = replaceClipSource(sped, 'v', 'photo', PICTURE_SOURCE_MS, true, true);
    expect(next.clips[0]).toMatchObject({ clipKey: 'photo', image: true, speed: 1 });
    expect(clipDurationMs(next.clips[0])).toBe(2000);
  });

  it('gives a picture three seconds when the host does not keep lengths', () => {
    const next = replaceClipSource(post(defaultClipEdit('v', 8000)), 'v', 'photo', PICTURE_SOURCE_MS, false, true);
    expect(clipDurationMs(next.clips[0])).toBe(PICTURE_CLIP_MS);
  });

  it('turns a picture segment back into a video one', () => {
    const next = replaceClipSource(post(picture('p', 2500)), 'p', 'v', 10_000);
    expect(next.clips[0]).toMatchObject({ clipKey: 'v', inMs: 0, outMs: 2500 });
    expect('image' in next.clips[0]).toBe(false);
  });
});

describe('the wire', () => {
  const uris = new Map([
    ['v', 'file:///v.mp4'],
    ['p', 'content://media/external/images/media/7'],
  ]);
  const wire = (m: EditManifest): Promise<ComposeSpec> => toComposeSpec(m, uris, { jobId: 'j', batchId: 'b' }, {} as RasterContext);

  it('sends a picture from 0, for its length, silent and at 1x', async () => {
    const spec = await wire(post(defaultClipEdit('v', 4000), picture('p', 2500)));
    expect(spec.clips[1]).toEqual({
      key: 'p',
      uri: 'content://media/external/images/media/7',
      inMs: 0,
      outMs: 2500,
      speed: 1,
      volume: 1,
      muted: true,
      fit: 'cover',
      image: true,
    });
    expect('image' in spec.clips[0]).toBe(false);
  });

  it('lowers a transition out of a picture on the rebased numbers', async () => {
    const dissolve = { kind: 'dissolve', durationMs: 500 };
    const spec = await wire(post(picture('p', 3000), { ...defaultClipEdit('v', 4000), transitionIn: dissolve }));
    expect(spec.clips[0]).toMatchObject({ inMs: 0, outMs: 2500, image: true });
    expect(spec.clips[1].transitionIn!.from).toMatchObject({ key: 'p', inMs: 2500, outMs: 3000, image: true });
  });
});
