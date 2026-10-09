import { describe, expect, it } from 'vitest';

import { toComposeSoundSpec, toComposeSpec } from './compose';
import {
  MANIFEST_VERSION,
  MIN_LAYER_MS,
  audioEffectSpeed,
  defaultClipEdit,
  emptyManifest,
  isUntouched,
  normaliseManifest,
  type EditAudioClip,
  type EditAudioEffect,
  type EditManifest,
} from './edit-manifest';
import {
  addAudioClip,
  addAudioEffect,
  audioEffectAt,
  cutPostTo,
  deleteAudioEffect,
  duplicateAudioEffect,
  findAudioClip,
  setAudioEffectSetting,
  setAudioEffectWindow,
  splitAudioEffect,
  updateAudioEffect,
} from './edit-ops';
import type { RasterContext } from './raster-context';
import { soundEffectPreset, soundEffectSteps } from './sound-effects';

/*
 * The audio effect layers in the edit: windows of the post with an effect id, its sliders and, for an
 * effect that slows, its Slow - kept one at a time on one row, moved and cut like a zoom, and turned
 * into windows of steps on the wire. The steps are `sound-effects.unit.test.ts`'s and the arithmetic
 * over the mix `audio-effect-windows.unit.test.ts`'s.
 */

const TOTAL = 20_000;

const post = (): EditManifest => ({
  ...emptyManifest(),
  clips: [defaultClipEdit('video', TOTAL, 'seg-1')],
});

const layer = (id: string, startMs: number, endMs: number, over: Partial<EditAudioEffect> = {}): EditAudioEffect => ({ id, startMs, endMs, effect: 'megaphone', ...over });

const withLayers = (...layers: EditAudioEffect[]): EditManifest => ({ ...post(), audioEffects: layers });

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

describe('an audio effect layer in the manifest', () => {
  it('is read back as it was saved, sliders and Slow and all, and is version 18', () => {
    const saved = withLayers(layer('a', 1000, 4000, { effectSettings: { intensity: 80 } }), layer('b', 5000, 9000, { effect: 'slowReverb', speed: 0.6, effectSettings: { room: 90 } }));
    const read = normaliseManifest(JSON.parse(JSON.stringify(saved)));
    expect(MANIFEST_VERSION).toBe(18);
    expect(read.audioEffects).toEqual(saved.audioEffects);
  });

  it('is no key at all for a post with none, so it is stored as it always was', () => {
    expect('audioEffects' in normaliseManifest(JSON.parse(JSON.stringify(post())))).toBe(false);
    expect('audioEffects' in normaliseManifest({ ...post(), audioEffects: [] })).toBe(false);
  });

  it('keeps only sliders moved off their defaults, and a Slow only for an effect that slows, off its own', () => {
    const read = normaliseManifest(
      withLayers(
        layer('a', 0, 1000, { effectSettings: { intensity: 50, tone: 120, stray: 3 } }),
        layer('b', 1000, 2000, { speed: 0.6 }),
        layer('c', 2000, 3000, { effect: 'slowReverb', speed: 0.8 }),
        layer('d', 3000, 4000, { effect: 'slowReverb', speed: 0.2 }),
        layer('e', 4000, 5000, { effect: 'slowReverb', speed: 0.734 }),
      ),
    );
    const [a, b, c, d, e] = read.audioEffects!;
    expect(a!.effectSettings).toEqual({ tone: 100 });
    expect('speed' in b!).toBe(false);
    expect('speed' in c!).toBe(false);
    expect(d!.speed).toBe(0.5);
    expect(e!.speed).toBe(0.73);
  });

  it('drops a layer whose effect this version cannot play, and one too short to hear', () => {
    const read = normaliseManifest(withLayers(layer('a', 0, 1000, { effect: 'robot' }), layer('b', 2000, 2000 + MIN_LAYER_MS - 1), layer('c', 3000, 4000)));
    expect(read.audioEffects!.map(one => one.id)).toEqual(['c']);
  });

  it('keeps one effect at a time: sorted, a later layer starting where the one before it ends', () => {
    const read = normaliseManifest(withLayers(layer('late', 6000, 9000), layer('early', 1000, 7000), layer('inside', 2000, 6500), layer('dup', 9500, 9900), layer('dup', 9900, 12_000)));
    expect(read.audioEffects!.map(({ id, startMs, endMs }) => [id, startMs, endMs])).toEqual([
      ['early', 1000, 7000],
      ['late', 7000, 9000],
      ['dup', 9500, 9900],
      ['dup~', 9900, 12_000],
    ]);
  });

  it('keeps a layer past the end of the post, which is not heard and comes back when the end does', () => {
    const read = normaliseManifest(withLayers(layer('a', 25_000, 30_000)));
    expect(read.audioEffects).toHaveLength(1);
  });

  it('counts as an edit, so a clip with a layer over it is rendered rather than posted as it is', () => {
    const untouched = (m: EditManifest) => isUntouched(m, new Map([['video', TOTAL]]), m.output.width / m.output.height);
    expect(untouched(post())).toBe(true);
    expect(untouched(withLayers(layer('a', 1000, 4000)))).toBe(false);
    // A layer the post no longer reaches changes nothing.
    expect(untouched(withLayers(layer('a', 25_000, 30_000)))).toBe(true);
  });
});

describe('a version 17 draft, whose effects were on its sounds', () => {
  const v17 = (manifest: EditManifest, sounds: Record<string, unknown>[], music: Record<string, unknown> | null = null): unknown => ({
    ...JSON.parse(JSON.stringify(manifest)),
    version: 17,
    music,
    audioTracks: [{ id: 'at-1', clips: sounds }],
  });

  it('reads a megaphone on a sound as a layer over where the sound is heard', () => {
    const read = normaliseManifest(v17(post(), [{ ...sound('a', 1000), effect: 'megaphone', effectSettings: { intensity: 80 } }]));
    expect(findAudioClip(read, 'a')).not.toHaveProperty('effect');
    expect(findAudioClip(read, 'a')).not.toHaveProperty('effectSettings');
    expect(read.audioEffects).toEqual([{ id: 'afx-sound-0', startMs: 1000, endMs: 6000, effect: 'megaphone', effectSettings: { intensity: 80 } }]);
  });

  it('puts a slow + reverb sound back to 1x and makes its slowness the layer’s, over the time it was heard', () => {
    const read = normaliseManifest(v17(post(), [{ ...sound('a', 1000, { speed: 0.5 }), effect: 'slowReverb' }]));
    expect(findAudioClip(read, 'a')).not.toHaveProperty('speed');
    // Five seconds of sound slowed to half was heard for ten, which the layer plays from its start.
    expect(read.audioEffects).toEqual([{ id: 'afx-sound-0', startMs: 1000, endMs: 11_000, effect: 'slowReverb', speed: 0.5 }]);
  });

  it('keeps a sound’s own speed under a megaphone, which was never the effect’s', () => {
    const read = normaliseManifest(v17(post(), [{ ...sound('a', 1000, { speed: 2 }), effect: 'megaphone' }]));
    expect(findAudioClip(read, 'a')!.speed).toBe(2);
    expect(read.audioEffects![0]).toMatchObject({ startMs: 1000, endMs: 3500 });
  });

  it('reads the post’s one music the same way, and keeps the layers of two sounds apart', () => {
    const read = normaliseManifest(v17(post(), [{ ...sound('a', 2000, { loop: true, endMs: 8000 }), effect: 'megaphone' }], { ...sound('m', 0, { speed: 0.8 }), effect: 'slowReverb' }));
    expect(read.music).not.toHaveProperty('effect');
    expect(read.audioEffects!.map(({ startMs, endMs, effect }) => [startMs, endMs, effect])).toEqual([
      [0, 6250, 'slowReverb'],
      [6250, 8000, 'megaphone'],
    ]);
  });
});

describe('the layers as the editor changes them', () => {
  it('adds a layer shortened to the room before the next one and the end of the post', () => {
    const one = addAudioEffect(withLayers(layer('b', 8000, 9000)), layer('a', 2000, 20_000), TOTAL)!;
    expect(one.audioEffects!.map(({ id, startMs, endMs }) => [id, startMs, endMs])).toEqual([
      ['a', 2000, 8000],
      ['b', 8000, 9000],
    ]);
    expect(addAudioEffect(post(), layer('a', 18_000, 40_000), TOTAL)!.audioEffects![0]!.endMs).toBe(TOTAL);
  });

  it('refuses a layer with no room, one inside another, a taken id and an effect this version has not got', () => {
    const edit = withLayers(layer('b', 8000, 9000));
    expect(addAudioEffect(edit, layer('a', 8500, 12_000), TOTAL)).toBeNull();
    expect(addAudioEffect(edit, layer('a', 8000 - MIN_LAYER_MS + 1, 12_000), TOTAL)).toBeNull();
    expect(addAudioEffect(edit, layer('b', 1000, 2000), TOTAL)).toBeNull();
    expect(addAudioEffect(edit, layer('a', 1000, 2000, { effect: 'robot' }), TOTAL)).toBeNull();
  });

  it('finds the layer under a moment, its end not included', () => {
    const edit = withLayers(layer('a', 1000, 2000), layer('b', 2000, 3000));
    expect(audioEffectAt(edit, 1000)?.id).toBe('a');
    expect(audioEffectAt(edit, 2000)?.id).toBe('b');
    expect(audioEffectAt(edit, 3000)).toBeNull();
  });

  it('starts another effect at its defaults, sliders and Slow alike', () => {
    const edit = withLayers(layer('a', 1000, 4000, { effect: 'slowReverb', speed: 0.6, effectSettings: { room: 90 } }));
    expect(updateAudioEffect(edit, 'a', { effect: 'megaphone' }).audioEffects![0]).toEqual(layer('a', 1000, 4000));
    expect(audioEffectSpeed(updateAudioEffect(withLayers(layer('a', 0, 1000)), 'a', { effect: 'slowReverb' }).audioEffects![0]!)).toBe(0.8);
  });

  it('moves a slider, storing nothing for one back at its default, and nothing for one the effect has not got', () => {
    const edit = withLayers(layer('a', 1000, 4000));
    const harder = setAudioEffectSetting(edit, 'a', 'intensity', 90);
    expect(harder.audioEffects![0]!.effectSettings).toEqual({ intensity: 90 });
    expect(setAudioEffectSetting(harder, 'a', 'intensity', 50).audioEffects![0]).not.toHaveProperty('effectSettings');
    expect(setAudioEffectSetting(edit, 'a', 'room', 90)).toBe(edit);
  });

  it('hands back the same edit when nothing changes, so no empty undo step is made', () => {
    const edit = withLayers(layer('a', 1000, 4000, { effect: 'slowReverb', speed: 0.6 }));
    expect(updateAudioEffect(edit, 'a', { effect: 'slowReverb' })).toBe(edit);
    expect(updateAudioEffect(edit, 'a', { speed: 0.6 })).toBe(edit);
    expect(updateAudioEffect(edit, 'nope', { speed: 0.7 })).toBe(edit);
    expect(updateAudioEffect(edit, 'a', { speed: 0.7 }).audioEffects![0]!.speed).toBe(0.7);
  });

  it('moves and retimes a layer between its neighbours, a whole one keeping its length', () => {
    const edit = withLayers(layer('a', 1000, 3000), layer('b', 5000, 7000), layer('c', 9000, 10_000));
    const window = (m: EditManifest) => m.audioEffects!.find(one => one.id === 'b')!;
    expect(window(setAudioEffectWindow(edit, 'b', 4000, 8000, TOTAL))).toMatchObject({ startMs: 4000, endMs: 8000 });
    expect(window(setAudioEffectWindow(edit, 'b', 2000, 7000, TOTAL))).toMatchObject({ startMs: 3000, endMs: 7000 });
    expect(window(setAudioEffectWindow(edit, 'b', 5000, 12_000, TOTAL))).toMatchObject({ startMs: 5000, endMs: 9000 });
    expect(window(setAudioEffectWindow(edit, 'b', 8000, 10_000, TOTAL))).toMatchObject({ startMs: 7000, endMs: 9000 });
    expect(window(setAudioEffectWindow(edit, 'b', 5000, 5010, TOTAL))).toMatchObject({ startMs: 5000, endMs: 5000 + MIN_LAYER_MS });
  });

  it('puts a copy straight after a layer, shortened to the room there is, and none where there is no room', () => {
    const edit = withLayers(layer('a', 1000, 3000), layer('c', 4000, 5000));
    expect(duplicateAudioEffect(edit, 'a', 'b', TOTAL)!.audioEffects!.map(({ id, startMs, endMs }) => [id, startMs, endMs])).toEqual([
      ['a', 1000, 3000],
      ['b', 3000, 4000],
      ['c', 4000, 5000],
    ]);
    expect(duplicateAudioEffect(withLayers(layer('a', 1000, 3000), layer('c', 3000, 5000)), 'a', 'b', TOTAL)).toBeNull();
  });

  it('cuts a layer in two, both halves the same effect, and refuses a cut that leaves a sliver', () => {
    const edit = withLayers(layer('a', 1000, 3000, { effectSettings: { tone: 70 } }));
    expect(splitAudioEffect(edit, 'a', 2000, 'b')!.audioEffects).toEqual([layer('a', 1000, 2000, { effectSettings: { tone: 70 } }), layer('b', 2000, 3000, { effectSettings: { tone: 70 } })]);
    expect(splitAudioEffect(edit, 'a', 1050, 'b')).toBeNull();
    expect(splitAudioEffect(edit, 'a', 3500, 'b')).toBeNull();
  });

  it('deletes a layer, and the key with the last one', () => {
    const edit = withLayers(layer('a', 1000, 3000), layer('b', 4000, 5000));
    expect(deleteAudioEffect(edit, 'a').audioEffects!.map(one => one.id)).toEqual(['b']);
    expect('audioEffects' in deleteAudioEffect(deleteAudioEffect(edit, 'a'), 'b')).toBe(false);
    expect(deleteAudioEffect(edit, 'nope')).toBe(edit);
  });

  it('is cut with the post, as a zoom is', () => {
    const edit = { ...withLayers(layer('a', 1000, 6000), layer('b', 8000, 9000)), clips: [defaultClipEdit('video', TOTAL, 'seg-1')] };
    expect(cutPostTo(edit, 7000).audioEffects).toEqual([layer('a', 1000, 6000)]);
    expect(cutPostTo(edit, 4000).audioEffects).toEqual([layer('a', 1000, 4000)]);
  });

  it('is moved by no clip or sound op: it belongs to the post’s time', () => {
    const edit = addAudioClip(withLayers(layer('a', 1000, 3000)), sound('s', 2000), 'at-1')!;
    expect(edit.audioEffects).toEqual([layer('a', 1000, 3000)]);
  });
});

describe('the layers on the wire', () => {
  const raster = {} as RasterContext;
  const files = new Map([['video', 'file:///video.mp4']]);
  const spec = (manifest: EditManifest) => toComposeSpec(manifest, files, { jobId: 'j', batchId: 'b' }, raster);

  it('sends each layer as a window of its effect’s steps at its sliders, and Slow + reverb’s Slow', async () => {
    const sent = await spec(withLayers(layer('a', 1000, 3000, { effectSettings: { intensity: 90 } }), layer('b', 4000, 9000, { effect: 'slowReverb' }), layer('c', 9000, 10_000, { effect: 'slowReverb', speed: 0.6 })));
    expect(sent.audio.effects).toEqual([
      { startMs: 1000, endMs: 3000, effect: soundEffectSteps('megaphone', { intensity: 90 }) },
      { startMs: 4000, endMs: 9000, speed: 0.8, effect: soundEffectPreset('slowReverb')!.effect },
      { startMs: 9000, endMs: 10_000, speed: 0.6, effect: soundEffectPreset('slowReverb')!.effect },
    ]);
  });

  it('sends no key for a post with no layer, which is the spec every older edit made', async () => {
    expect('effects' in (await spec(post())).audio).toBe(false);
  });

  it('cuts a layer at the end of the post, and leaves out one the post never reaches', async () => {
    const sent = await spec(withLayers(layer('a', 18_000, 25_000), layer('b', 25_000, 30_000)));
    expect(sent.audio.effects).toEqual([{ startMs: 18_000, endMs: TOTAL, effect: soundEffectPreset('megaphone')!.effect }]);
  });

  it('puts no effect and no record speed on a sound any more: the layer is what changes it', async () => {
    const edit = addAudioClip(withLayers(layer('a', 0, 5000, { effect: 'slowReverb' })), sound('s', 0, { speed: 0.8 }), 'at-1')!;
    const wire = (await spec(edit)).audio.musicTracks![0]![0]!;
    expect(wire.speed).toBe(0.8);
    expect('effect' in wire).toBe(false);
    expect('varispeed' in wire).toBe(false);
  });

  it('sends copies of the catalogue’s steps, which nothing holding the spec can change', async () => {
    const sent = await spec(withLayers(layer('a', 1000, 3000)));
    (sent.audio.effects![0]!.effect!.ops[0] as { hz: number }).hz = 20;
    expect((soundEffectPreset('megaphone')!.effect.ops[0] as { hz: number }).hz).toBe(600);
  });

  it('is the same in the sound-only spec the preview plans its copies from', async () => {
    const edit = addAudioClip(withLayers(layer('a', 1000, 3000), layer('b', 4000, 9000, { effect: 'slowReverb' })), sound('s', 0), 'at-1')!;
    const full = await spec(edit);
    const heard = toComposeSoundSpec(edit, files);
    expect(heard.audio).toEqual(full.audio);
    expect(heard.clips).toEqual(full.clips);
    expect(heard.overlays).toEqual([]);
  });
});
