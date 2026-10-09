import { describe, expect, it } from 'vitest';

import { toComposeSpec } from './compose';
import { MANIFEST_VERSION, defaultClipEdit, emptyManifest, normaliseManifest, type EditAudioClip, type EditManifest } from './edit-manifest';
import {
  addAudioClip,
  duplicateAudioClip,
  findAudioClip,
  joinContinuousAudio,
  musicAsAudioLane,
  patchAudioClip,
  patchMusic,
  replaceAudioClip,
  setAudioEffect,
  setMusicEffect,
  splitAudioClipAt,
} from './edit-ops';
import type { RasterContext } from './raster-context';
import { soundEffectPreset } from './sound-effects';

/*
 * A sound's effect in the edit: an id on the sound and nothing else, kept by every op that keeps the
 * sound, and turned into the effect's steps on the wire. The steps themselves are
 * `sound-effects.unit.test.ts`'s.
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

/** One five-second sound `a` at 1 s, alone on lane `at-1`. */
const withSound = (over: Partial<EditAudioClip> = {}): EditManifest => addAudioClip(post(), sound('a', 1000, over), 'at-1')!;

describe('a sound’s effect in the manifest', () => {
  it('is read back as it was saved, and is version 16', () => {
    const saved = { ...withSound({ effect: 'megaphone' }), music: sound('m', 0, { effect: 'megaphone' }) };
    const read = normaliseManifest(JSON.parse(JSON.stringify(saved)));
    expect(MANIFEST_VERSION).toBe(16);
    expect(read.music?.effect).toBe('megaphone');
    expect(findAudioClip(read, 'a')?.effect).toBe('megaphone');
  });

  it('is no key at all for none, so a sound with none reads back as it always did', () => {
    const read = normaliseManifest(JSON.parse(JSON.stringify(withSound())));
    expect('effect' in findAudioClip(read, 'a')!).toBe(false);
  });

  it('drops an effect this version cannot play rather than keep a sound it would play differently', () => {
    const read = normaliseManifest(JSON.parse(JSON.stringify(withSound({ effect: 'reverb' }))));
    expect('effect' in findAudioClip(read, 'a')!).toBe(false);
  });
});

describe('putting a sound through an effect', () => {
  it('sets the effect on that sound alone, and takes it off again', () => {
    const two = addAudioClip(withSound(), sound('b', 8000), 'at-1', 'at-1')!;
    const on = setAudioEffect(two, 'a', 'megaphone');
    expect(findAudioClip(on, 'a')?.effect).toBe('megaphone');
    expect(findAudioClip(on, 'b')?.effect).toBeUndefined();
    const off = setAudioEffect(on, 'a', null);
    expect('effect' in findAudioClip(off, 'a')!).toBe(false);
  });

  it('changes nothing else about the sound', () => {
    const before = withSound({ speed: 1.5, fadeInMs: 200, loop: true, endMs: 6000 });
    const after = setAudioEffect(before, 'a', 'megaphone');
    const { effect, ...rest } = findAudioClip(after, 'a')!;
    expect(effect).toBe('megaphone');
    expect(rest).toEqual(findAudioClip(before, 'a'));
  });

  it('hands back the same edit when nothing changes, so no empty undo step is made', () => {
    const on = setAudioEffect(withSound(), 'a', 'megaphone');
    expect(setAudioEffect(on, 'a', 'megaphone')).toBe(on);
    const plain = withSound();
    expect(setAudioEffect(plain, 'a', null)).toBe(plain);
    expect(setAudioEffect(plain, 'a', 'echo')).toBe(plain);
    expect(setAudioEffect(plain, 'missing', 'megaphone')).toBe(plain);
  });

  it('works on the post’s one music too, and through a plain patch', () => {
    const music = { ...post(), music: sound('m', 0) };
    expect(setMusicEffect(music, 'megaphone').music?.effect).toBe('megaphone');
    expect('effect' in setMusicEffect(setMusicEffect(music, 'megaphone'), null).music!).toBe(false);
    expect('effect' in patchMusic(music, { effect: 'none' }).music!).toBe(false);
    expect(patchAudioClip(withSound(), 'a', { effect: 'megaphone' })).not.toBe(withSound());
  });
});

describe('the effect goes where the sound goes', () => {
  it('stays on both halves of a cut, which is how one word of a line gets it', () => {
    const cut = splitAudioClipAt(setAudioEffect(withSound(), 'a', 'megaphone'), 'a', 3000, 'a2')!;
    expect(findAudioClip(cut, 'a')?.effect).toBe('megaphone');
    expect(findAudioClip(cut, 'a2')?.effect).toBe('megaphone');
  });

  it('goes with a copy, onto the lane with the music, and under another file', () => {
    const on = setAudioEffect(withSound(), 'a', 'megaphone');
    expect(findAudioClip(duplicateAudioClip(on, 'a', 'copy', 'at-2')!, 'copy')?.effect).toBe('megaphone');
    const music = musicAsAudioLane({ ...post(), music: sound('m', 0, { effect: 'megaphone' }) }, 'm1', 'at-9')!;
    expect(findAudioClip(music, 'm1')?.effect).toBe('megaphone');
    const replaced = replaceAudioClip(on, 'a', { uri: 'file:///other.m4a', fileName: 'other.m4a', sourceDurationMs: 4000 })!;
    expect(findAudioClip(replaced, 'a')?.effect).toBe('megaphone');
  });

  it('keeps a word cut out for a megaphone apart from the line either side of it', () => {
    // A line cut in three, nothing done to it since: played as the one sound it still is.
    const line = withSound({ outMs: 5000 });
    const three = splitAudioClipAt(splitAudioClipAt(line, 'a', 2000, 'word')!, 'word', 3000, 'rest')!;
    const lane = three.audioTracks![0]!.clips;
    expect(joinContinuousAudio(lane)).toHaveLength(1);
    // The middle through the megaphone: three sounds, each heard as what it is.
    const word = setAudioEffect(three, 'word', 'megaphone').audioTracks![0]!.clips;
    expect(joinContinuousAudio(word).map(one => one.effect ?? null)).toEqual([null, 'megaphone', null]);
    // Both halves through it: one sound again, and through it.
    const both = setAudioEffect(setAudioEffect(three, 'word', 'megaphone'), 'rest', 'megaphone').audioTracks![0]!.clips;
    expect(joinContinuousAudio(both).map(one => one.effect ?? null)).toEqual([null, 'megaphone']);
  });
});

describe('a sound’s effect on the wire', () => {
  const raster = {} as RasterContext;
  const files = new Map([['video', 'file:///video.mp4']]);
  const spec = (manifest: EditManifest) => toComposeSpec(manifest, files, { jobId: 'j', batchId: 'b' }, raster);

  it('is sent as the steps its id stands for, for the music and for every lane', async () => {
    const edit = setMusicEffect(setAudioEffect({ ...withSound(), music: sound('m', 0) }, 'a', 'megaphone'), 'megaphone');
    const sent = await spec(edit);
    const steps = soundEffectPreset('megaphone')!.effect;
    expect(sent.audio.music?.effect).toEqual(steps);
    expect(sent.audio.musicTracks?.flat()[0]?.effect).toEqual(steps);
  });

  it('is not sent at all for a sound with none, which is the spec every older edit made', async () => {
    const sent = await spec({ ...withSound(), music: sound('m', 0) });
    expect('effect' in sent.audio.music!).toBe(false);
    expect(sent.audio.musicTracks?.flat().every(one => !('effect' in one))).toBe(true);
  });

  it('is a copy of the catalogue’s steps, which nothing holding the spec can change', async () => {
    const sent = await spec(setAudioEffect(withSound(), 'a', 'megaphone'));
    const step = sent.audio.musicTracks![0]![0]!.effect!.ops[0] as { hz: number };
    step.hz = 20;
    expect((soundEffectPreset('megaphone')!.effect.ops[0] as { hz: number }).hz).toBe(600);
  });
});
