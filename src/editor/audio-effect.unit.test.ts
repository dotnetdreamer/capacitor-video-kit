import { describe, expect, it } from 'vitest';

import { toComposeSpec } from './compose';
import { MANIFEST_VERSION, defaultClipEdit, emptyManifest, normaliseManifest, type EditAudioClip, type EditManifest } from './edit-manifest';
import {
  addAudioClip,
  duplicateAudioClip,
  findAudioClip,
  joinContinuousAudio,
  musicAsAudioLane,
  musicSpeed,
  patchAudioClip,
  patchMusic,
  replaceAudioClip,
  setAudioEffect,
  setAudioEffectSetting,
  setAudioSpeed,
  setMusicEffect,
  setMusicEffectSetting,
  splitAudioClipAt,
} from './edit-ops';
import type { RasterContext } from './raster-context';
import { soundEffectPreset, soundEffectSteps } from './sound-effects';

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
  it('is read back as it was saved, sliders and all, and is version 17', () => {
    const saved = { ...withSound({ effect: 'megaphone', effectSettings: { intensity: 80 } }), music: sound('m', 0, { effect: 'megaphone' }) };
    const read = normaliseManifest(JSON.parse(JSON.stringify(saved)));
    expect(MANIFEST_VERSION).toBe(17);
    expect(read.music?.effect).toBe('megaphone');
    expect('effectSettings' in read.music!).toBe(false);
    expect(findAudioClip(read, 'a')).toMatchObject({ effect: 'megaphone', effectSettings: { intensity: 80 } });
  });

  it('keeps only the sliders the effect has, moved off their defaults, and none without an effect', () => {
    const odd = withSound({ effect: 'megaphone', effectSettings: { intensity: 50, tone: 130, room: 9 } });
    expect(findAudioClip(normaliseManifest(JSON.parse(JSON.stringify(odd))), 'a')?.effectSettings).toEqual({ tone: 100 });
    const stray = withSound({ effectSettings: { intensity: 80 } });
    expect('effectSettings' in findAudioClip(normaliseManifest(JSON.parse(JSON.stringify(stray))), 'a')!).toBe(false);
  });

  it('is no key at all for none, so a sound with none reads back as it always did', () => {
    const read = normaliseManifest(JSON.parse(JSON.stringify(withSound())));
    expect('effect' in findAudioClip(read, 'a')!).toBe(false);
  });

  it('drops an effect this version cannot play rather than keep a sound it would play differently', () => {
    const read = normaliseManifest(JSON.parse(JSON.stringify(withSound({ effect: 'echo', effectSettings: { feedback: 70 } }))));
    expect('effect' in findAudioClip(read, 'a')!).toBe(false);
    expect('effectSettings' in findAudioClip(read, 'a')!).toBe(false);
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

describe('an effect’s sliders', () => {
  it('moves one slider on one sound, and stores nothing for a slider back at its default', () => {
    const on = setAudioEffect(withSound(), 'a', 'megaphone');
    const harder = setAudioEffectSetting(on, 'a', 'intensity', 80);
    expect(findAudioClip(harder, 'a')?.effectSettings).toEqual({ intensity: 80 });
    const both = setAudioEffectSetting(harder, 'a', 'tone', 20);
    expect(findAudioClip(both, 'a')?.effectSettings).toEqual({ intensity: 80, tone: 20 });
    const back = setAudioEffectSetting(setAudioEffectSetting(both, 'a', 'intensity', 50), 'a', 'tone', 50);
    expect('effectSettings' in findAudioClip(back, 'a')!).toBe(false);
  });

  it('hands back the same edit for a slider the effect has not got, or one left where it was', () => {
    const on = setAudioEffectSetting(setAudioEffect(withSound(), 'a', 'megaphone'), 'a', 'intensity', 80);
    expect(setAudioEffectSetting(on, 'a', 'intensity', 80)).toBe(on);
    expect(setAudioEffectSetting(on, 'a', 'intensity', 80.2)).toBe(on);
    expect(setAudioEffectSetting(on, 'a', 'room', 10)).toBe(on);
    const plain = withSound();
    expect(setAudioEffectSetting(plain, 'a', 'intensity', 80)).toBe(plain);
    expect(setAudioEffectSetting(plain, 'missing', 'intensity', 80)).toBe(plain);
  });

  it('is still the same edit after a patch of something else, so no empty undo step is made', () => {
    const on = setAudioEffectSetting(setAudioEffect(withSound(), 'a', 'megaphone'), 'a', 'tone', 10);
    expect(patchAudioClip(on, 'a', { volume: 0.8 })).toBe(on);
    expect(patchAudioClip(on, 'a', { effectSettings: { tone: 10 } })).toBe(on);
  });

  it('starts every effect at its defaults, the sliders of the one before going with it', () => {
    const tuned = setAudioEffectSetting(setAudioEffect(withSound(), 'a', 'megaphone'), 'a', 'intensity', 90);
    expect('effectSettings' in findAudioClip(setAudioEffect(tuned, 'a', 'slowReverb'), 'a')!).toBe(false);
    expect('effectSettings' in findAudioClip(setAudioEffect(tuned, 'a', null), 'a')!).toBe(false);
  });

  it('works on the post’s one music too', () => {
    const music = setMusicEffect({ ...post(), music: sound('m', 0) }, 'slowReverb');
    expect(setMusicEffectSetting(music, 'room', 80).music?.effectSettings).toEqual({ room: 80 });
    expect(setMusicEffectSetting({ ...post(), music: null }, 'room', 80).music).toBeNull();
  });
});

describe('slow + reverb and the sound’s speed', () => {
  it('slows the sound to its own speed as it goes on, and puts it back to 1x as it comes off', () => {
    const slowed = setAudioEffect(withSound(), 'a', 'slowReverb');
    expect(findAudioClip(slowed, 'a')).toMatchObject({ effect: 'slowReverb', speed: 0.8 });
    expect('speed' in findAudioClip(setAudioEffect(slowed, 'a', null), 'a')!).toBe(false);
    // Another effect in its place is the slowness coming off as well.
    expect(findAudioClip(setAudioEffect(slowed, 'a', 'megaphone'), 'a')).not.toHaveProperty('speed');
  });

  it('leaves a sound already slower than 1x at its own speed, and slows down one sped up', () => {
    expect(musicSpeed(findAudioClip(setAudioEffect(withSound({ speed: 0.6 }), 'a', 'slowReverb'), 'a')!)).toBe(0.6);
    expect(musicSpeed(findAudioClip(setAudioEffect(withSound({ speed: 1.5 }), 'a', 'slowReverb'), 'a')!)).toBe(0.8);
  });

  it('leaves the speed of a sound alone for an effect that does not hold it', () => {
    const fast = withSound({ speed: 1.5 });
    expect(musicSpeed(findAudioClip(setAudioEffect(fast, 'a', 'megaphone'), 'a')!)).toBe(1.5);
    expect(musicSpeed(findAudioClip(setAudioEffect(setAudioEffect(fast, 'a', 'megaphone'), 'a', null), 'a')!)).toBe(1.5);
  });

  it('stops a slowed sound where the next one on its lane begins, as a slower speed does', () => {
    // Five seconds at 1 s, and the next at 6.5 s: at 0.8 it would run on to 7.25 s.
    const two = addAudioClip(withSound(), sound('b', 6500), 'at-1', 'at-1')!;
    const slowed = setAudioEffect(two, 'a', 'slowReverb');
    expect(findAudioClip(slowed, 'a')).toMatchObject({ speed: 0.8, endMs: 6500 });
  });

  it('works on the post’s one music too', () => {
    const music = setMusicEffect({ ...post(), music: sound('m', 0) }, 'slowReverb');
    expect(music.music).toMatchObject({ effect: 'slowReverb', speed: 0.8 });
    expect(setMusicEffect(music, null).music).not.toHaveProperty('speed');
  });
});

describe('the effect goes where the sound goes', () => {
  it('stays on both halves of a cut, sliders and all, which is how one word of a line gets it', () => {
    const tuned = setAudioEffectSetting(setAudioEffect(withSound(), 'a', 'megaphone'), 'a', 'tone', 20);
    const cut = splitAudioClipAt(tuned, 'a', 3000, 'a2')!;
    expect(findAudioClip(cut, 'a')).toMatchObject({ effect: 'megaphone', effectSettings: { tone: 20 } });
    expect(findAudioClip(cut, 'a2')).toMatchObject({ effect: 'megaphone', effectSettings: { tone: 20 } });
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
    const both = setAudioEffect(setAudioEffect(three, 'word', 'megaphone'), 'rest', 'megaphone');
    expect(joinContinuousAudio(both.audioTracks![0]!.clips).map(one => one.effect ?? null)).toEqual([null, 'megaphone']);
    // Unless one of them is driven harder: the same megaphone, and a different sound.
    const harder = setAudioEffectSetting(both, 'rest', 'intensity', 90).audioTracks![0]!.clips;
    expect(joinContinuousAudio(harder).map(one => one.effectSettings ?? null)).toEqual([null, null, { intensity: 90 }]);
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

  it('is sent as the steps of the effect at the sound’s own settings', async () => {
    const edit = setAudioEffectSetting(setAudioEffect(withSound(), 'a', 'megaphone'), 'a', 'intensity', 90);
    const sent = await spec(edit);
    expect(sent.audio.musicTracks![0]![0]!.effect).toEqual(soundEffectSteps('megaphone', { intensity: 90 }));
  });

  it('plays slow + reverb’s speed as a record does, and every other speed at its own pitch', async () => {
    const slowed = await spec(setAudioEffect(withSound(), 'a', 'slowReverb'));
    expect(slowed.audio.musicTracks![0]![0]).toMatchObject({ speed: 0.8, varispeed: true, effect: soundEffectPreset('slowReverb')!.effect });
    const fast = await spec(setAudioEffect(withSound({ speed: 1.5 }), 'a', 'megaphone'));
    expect(fast.audio.musicTracks![0]![0]!.speed).toBe(1.5);
    expect('varispeed' in fast.audio.musicTracks![0]![0]!).toBe(false);
  });

  it('sends no varispeed for slow + reverb put back at 1x, where it would change nothing', async () => {
    const level = setAudioSpeed(setAudioEffect(withSound(), 'a', 'slowReverb'), 'a', 1);
    const sent = (await spec(level)).audio.musicTracks![0]![0]!;
    expect('speed' in sent).toBe(false);
    expect('varispeed' in sent).toBe(false);
    expect(sent.effect).toEqual(soundEffectPreset('slowReverb')!.effect);
  });

  it('is a copy of the catalogue’s steps, which nothing holding the spec can change', async () => {
    const sent = await spec(setAudioEffect(withSound(), 'a', 'megaphone'));
    const step = sent.audio.musicTracks![0]![0]!.effect!.ops[0] as { hz: number };
    step.hz = 20;
    expect((soundEffectPreset('megaphone')!.effect.ops[0] as { hz: number }).hz).toBe(600);
  });
});
