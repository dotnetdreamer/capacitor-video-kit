import { describe, expect, it } from 'vitest';
import type { RasterContext } from './raster-context';
import { toComposeSpec } from './compose';
import {
  addAudioClip,
  audioClipWindow,
  audioSpeedPatch,
  findAudioClip,
  moveAudioClipToTrack,
  musicSourceMsAt,
  musicSpeed,
  musicWindow,
  patchAudioClip,
  patchMusic,
  replaceAudioClip,
  setAudioSpeed,
  setMusicSpeed,
} from './edit-ops';
import { MANIFEST_VERSION, defaultClipEdit, emptyManifest, normaliseManifest, normaliseSpeed, type EditAudioClip, type EditManifest } from './edit-manifest';

/*
 * A sound's speed. The section stays a stretch of the FILE and the sound's place a stretch of the POST,
 * so a sped-up sound is heard for less of the post and reads its file that much faster - which is the
 * whole of what every engine, the preview and the timeline take from these functions.
 */

const post = (): EditManifest => ({
  ...emptyManifest(),
  clips: [defaultClipEdit('video', 20_000, 'seg-1')],
});

const sound = (id: string, startMs: number, over: Partial<EditAudioClip> = {}): EditAudioClip => ({
  id,
  uri: `file:///${id}.m4a`,
  fileName: `${id}.m4a`,
  sourceDurationMs: 5000,
  inMs: 0,
  outMs: 0,
  startMs,
  endMs: 0,
  volume: 0.8,
  loop: false,
  fadeOutMs: 0,
  ...over,
});

/** `a` at 1 s and `b` at `bAt` on one lane, both five-second sounds at 1x. */
function lane(bAt: number): EditManifest {
  return addAudioClip(addAudioClip(post(), sound('a', 1000), 'at-1')!, sound('b', bAt), 'at-1', 'at-1')!;
}

describe('a sound at a speed', () => {
  it('is heard for its section divided by its speed, from the same place', () => {
    expect(musicWindow(sound('a', 1000, { speed: 2 }), 20_000)).toEqual({ startMs: 1000, endMs: 3500 });
    expect(musicWindow(sound('a', 1000, { speed: 0.5 }), 20_000)).toEqual({ startMs: 1000, endMs: 11_000 });
    // What is left of the section after the phase, at that speed.
    expect(musicWindow(sound('a', 0, { speed: 2, phaseMs: 1000 }), 20_000)).toEqual({ startMs: 0, endMs: 2000 });
  });

  it('reads its file at its speed', () => {
    expect(musicSourceMsAt(sound('a', 1000, { speed: 2 }), 2000, 20_000)).toBe(2000);
    expect(musicSourceMsAt(sound('a', 1000, { speed: 0.5, inMs: 500 }), 3000, 20_000)).toBe(1500);
    // A loop goes round its section in the file: three seconds of post at 2x is six of file, one past
    // the end of a five-second section.
    expect(musicSourceMsAt(sound('a', 0, { speed: 2, loop: true, outMs: 5000 }), 3000, 20_000)).toBe(1000);
  });

  it('is 1x without a speed, and holds an absurd one to the range', () => {
    expect(musicSpeed(sound('a', 0))).toBe(1);
    expect(musicSpeed(sound('a', 0, { speed: 9 }))).toBe(4);
    expect(musicSpeed(sound('a', 0, { speed: Number.NaN }))).toBe(1);
  });
});

describe('storing a speed', () => {
  const withMusic = (speed?: number): EditManifest => ({ ...post(), music: { ...sound('m', 0), ...(speed ? { speed } : {}) } });

  it('rounds to the hundredth and holds the range, as a clip’s is', () => {
    expect(patchMusic(withMusic(), { speed: 1.234 }).music?.speed).toBe(1.23);
    expect(patchMusic(withMusic(), { speed: 10 }).music?.speed).toBe(4);
    expect(normaliseSpeed(0.01)).toBe(0.25);
    expect(normaliseSpeed(Number.NaN)).toBe(1);
  });

  it('takes the key off at 1x, and a 1x patch of a 1x sound is no change', () => {
    expect(patchMusic(withMusic(2), { speed: 1 }).music).not.toHaveProperty('speed');
    const plain = withMusic();
    expect(patchMusic(plain, { speed: 1 })).toBe(plain);
    expect(setMusicSpeed(plain, 1)).toBe(plain);
  });

  it('sets the music’s speed, which only makes it run longer or shorter', () => {
    const fast = setMusicSpeed(withMusic(), 2);
    expect(fast.music?.speed).toBe(2);
    expect(musicWindow(fast.music!, 20_000)).toEqual({ startMs: 0, endMs: 2500 });
  });

  it('reads a stored speed back, and a draft without one as 1x', () => {
    const read = normaliseManifest({ ...post(), music: { ...sound('m', 0), speed: 1.5 }, audioTracks: [{ id: 'at-1', clips: [sound('a', 0, { speed: 99 })] }] });
    expect(read.version).toBe(MANIFEST_VERSION);
    expect(read.music?.speed).toBe(1.5);
    expect(read.audioTracks?.[0]?.clips[0]?.speed).toBe(4);
    expect(normaliseManifest({ ...post(), music: { ...sound('m', 0), speed: 1 } }).music).not.toHaveProperty('speed');
    expect(normaliseManifest({ ...post(), music: { ...sound('m', 0), speed: 'fast' } }).music).not.toHaveProperty('speed');
  });

  it('spreads a damaged lane by each sound’s heard length at its speed', () => {
    // `a` slowed to 0.5x runs 0..10 s, over `b` at 6 s, so `b` goes to a lane of its own.
    const read = normaliseManifest({ ...post(), audioTracks: [{ id: 'at-1', clips: [sound('a', 0, { speed: 0.5 }), sound('b', 6000)] }] });
    expect(read.audioTracks?.map(track => [track.id, track.clips.map(clip => clip.id)])).toEqual([
      ['at-1-overflow', ['b']],
      ['at-1', ['a']],
    ]);
  });
});

describe('a sound’s speed on its lane', () => {
  it('stops a slowed sound where the next one on its lane begins, as Loop does', () => {
    const slowed = setAudioSpeed(lane(7000), 'a', 0.5);
    const a = findAudioClip(slowed, 'a')!;
    expect(a).toMatchObject({ speed: 0.5, startMs: 1000, endMs: 7000 });
    expect(audioClipWindow(a, 20_000)).toEqual({ startMs: 1000, endMs: 7000 });
    // Its neighbour is where it was.
    expect(findAudioClip(slowed, 'b')?.startMs).toBe(7000);
  });

  it('needs no stop when the slower sound still ends before its neighbour', () => {
    const slowed = setAudioSpeed(lane(12_000), 'a', 0.5);
    expect(findAudioClip(slowed, 'a')).toMatchObject({ speed: 0.5, endMs: 0 });
    expect(audioClipWindow(findAudioClip(slowed, 'a')!, 20_000)).toEqual({ startMs: 1000, endMs: 11_000 });
    expect(audioSpeedPatch(lane(12_000), 'a', 0.5)).toEqual({ speed: 0.5 });
  });

  it('speeds a sound up without touching anything around it', () => {
    const fast = setAudioSpeed(lane(7000), 'a', 2);
    expect(findAudioClip(fast, 'a')).toMatchObject({ speed: 2, endMs: 0 });
    expect(audioClipWindow(findAudioClip(fast, 'a')!, 20_000)).toEqual({ startMs: 1000, endMs: 3500 });
  });

  it('refuses a speed that would leave the sound heard for less than the shortest layer', () => {
    const short = addAudioClip(post(), sound('a', 0, { outMs: 150 }), 'at-1')!;
    // 150 ms of file at 4x is 37.5 ms of post.
    expect(setAudioSpeed(short, 'a', 4)).toBe(short);
    expect(findAudioClip(setAudioSpeed(short, 'a', 1.5), 'a')?.speed).toBe(1.5);
  });

  it('keeps a speed through Replace, as it keeps the level and the fades', () => {
    const fast = setAudioSpeed(lane(12_000), 'a', 2);
    const replaced = replaceAudioClip(fast, 'a', { uri: 'file:///other.m4a', fileName: 'other.m4a', sourceDurationMs: 4000 })!;
    expect(findAudioClip(replaced, 'a')).toMatchObject({ uri: 'file:///other.m4a', speed: 2 });
  });

  it('places a sound flush against a sped-up neighbour whose length is not whole milliseconds', () => {
    // Five seconds at 3x is 1666.67 ms. `b` starts over it, so it opens a lane of its own first.
    const first = addAudioClip(post(), sound('a', 0, { speed: 3 }), 'at-1')!;
    const both = addAudioClip(first, sound('b', 500), 'at-2')!;
    expect(both.audioTracks?.map(track => track.id)).toEqual(['at-1', 'at-2']);
    const moved = moveAudioClipToTrack(both, 'b', { kind: 'track', trackId: 'at-1' }, 1000, 'unused')!;
    expect(findAudioClip(moved, 'b')?.startMs).toBe(1667);
    expect(moved.audioTracks?.map(track => track.clips.map(clip => clip.id))).toEqual([['a', 'b']]);
  });

  it('is patched through the lane’s rules like any other field', () => {
    const fast = patchAudioClip(lane(12_000), 'a', { speed: 2 });
    expect(findAudioClip(fast, 'a')?.speed).toBe(2);
    // Run into its neighbour by a plain patch, rather than by the Speed sheet's rule, it is refused.
    const tight = lane(7000);
    expect(patchAudioClip(tight, 'a', { speed: 0.5 })).toBe(tight);
  });
});

describe('a sound’s speed on the wire', () => {
  const raster = {} as RasterContext;
  const files = new Map([['video', 'file:///video.mp4']]);

  it('is sent only when it is not 1x, for the music and for every lane', async () => {
    const plain = addAudioClip({ ...post(), music: sound('m', 0) }, sound('a', 0), 'at-1')!;
    const plainSpec = await toComposeSpec(plain, files, { jobId: 'j', batchId: 'b' }, raster);
    expect(plainSpec.audio.musicTracks?.flat()).toHaveLength(2);
    expect(plainSpec.audio.musicTracks?.flat().every(clip => !('speed' in clip))).toBe(true);

    const legacy = setMusicSpeed({ ...post(), music: sound('m', 0) }, 1.5);
    const legacySpec = await toComposeSpec(legacy, files, { jobId: 'j', batchId: 'b' }, raster);
    expect(legacySpec.audio.music?.speed).toBe(1.5);

    const sped = setAudioSpeed(plain, 'a', 0.5);
    const spedSpec = await toComposeSpec(sped, files, { jobId: 'j', batchId: 'b' }, raster);
    expect(spedSpec.audio.musicTracks?.flat().find(clip => clip.uri === 'file:///a.m4a')?.speed).toBe(0.5);
  });
});
