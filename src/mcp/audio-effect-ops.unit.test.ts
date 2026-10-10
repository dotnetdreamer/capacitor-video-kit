import { describe, expect, it } from 'vitest';

import { MANIFEST_VERSION, MIN_LAYER_MS, defaultClipEdit, emptyManifest, type EditManifest } from '../editor/edit-manifest';
import {
  addAudioEffect,
  duplicateAudioEffect,
  findAudioClip,
  moveAudioEffect,
  moveAudioEffectTo,
  setAudioEffectSetting,
  setAudioEffectWindow,
  splitAudioEffect,
} from '../editor/edit-ops';
import { MAX_AUDIO_EFFECTS } from '../video-composer/definitions';
import { applyEditOps, type EditOp } from './ops';
import { summariseManifest } from './summary';
import { OP_REFERENCE, createTools, type ToolDefinition } from './tools';

/*
 * An agent's audio effect layers land where the editor's Audio effects sheet and timeline would put
 * them - on the post's time, stacked bottom to top as the picture's layers are, any number over the
 * same moment - and a layer the editor would not keep, or would keep somewhere other than asked, is
 * refused with the reason. What the layers do to the sound is the editor's to test
 * (`src/editor/audio-effect.unit.test.ts`); this is the agent's side.
 */

const TOTAL = 20_000;

/** Twenty seconds of video, and nothing else. */
const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', TOTAL)] });

/** A megaphone from `startMs`, to `endMs` when one is given. */
const add = (id: string, startMs: number, endMs?: number, extra: Record<string, unknown> = {}): EditOp => ({
  op: 'addAudioEffect',
  id,
  effect: 'megaphone',
  startMs,
  ...(endMs !== undefined ? { endMs } : {}),
  ...extra,
});

const patch = (id: string, fields: Record<string, unknown>): EditOp => ({ op: 'patchAudioEffect', id, patch: fields });

/** Every layer's window, in the order they stack, bottom first. */
const windows = (manifest: EditManifest): string[] => (manifest.audioEffects ?? []).map(({ id, startMs, endMs }) => `${id}@${startMs}..${endMs}`);

/** The ids in the order they stack, bottom first, run together: `abc`. */
const order = (manifest: EditManifest): string => (manifest.audioEffects ?? []).map(layer => layer.id).join('');

const layerOf = (manifest: EditManifest, id: string) => manifest.audioEffects?.find(layer => layer.id === id);

/** What the summary says above the layers. */
const HEADER =
  ' (everything heard inside one goes through its effect - clips, lanes and voiceover alike; where layers cover the same time, a later one works on what ' +
  'the ones before it made)';

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  return tools.find(candidate => candidate.name === name)!;
}

describe('addAudioEffect', () => {
  it('puts a layer on the post with its effect, sliders and speed, keeping only what is off their defaults', () => {
    const manifest = applyEditOps(post(), [
      { op: 'addAudioEffect', id: 'b', effect: 'slowReverb', startMs: 4000, endMs: 9000, speed: 0.6, effectSettings: { room: 90 } },
      add('a', 1000, 3000, { effectSettings: { intensity: 80, tone: 50 } }),
      { op: 'addAudioEffect', id: 'c', effect: 'slowReverb', startMs: 10_000, endMs: 12_000, speed: 0.8, effectSettings: {} },
    ]);
    // In the order they were added, which is the stack, whatever their times.
    expect(manifest.audioEffects).toEqual([
      { id: 'b', startMs: 4000, endMs: 9000, effect: 'slowReverb', effectSettings: { room: 90 }, speed: 0.6 },
      { id: 'a', startMs: 1000, endMs: 3000, effect: 'megaphone', effectSettings: { intensity: 80 } },
      { id: 'c', startMs: 10_000, endMs: 12_000, effect: 'slowReverb' },
    ]);
  });

  it('runs to the end of the post when it is given no end, as the sheet adds one from the playhead', () => {
    expect(windows(applyEditOps(post(), [add('a', 5000)]))).toEqual(['a@5000..20000']);
    expect(windows(applyEditOps(post(), [add('a', 5000, undefined, { endMs: null, effectSettings: null, speed: null })]))).toEqual(['a@5000..20000']);
  });

  /* The editor's add, and a picture layer's: over whatever is there, and on top of it. */
  it('goes on top of the others, over the time they cover, as the editor adds one', () => {
    const before = applyEditOps(post(), [add('b', 8000, 9000)]);
    const next = applyEditOps(before, [add('a', 2000, 15_000), add('c', 8500, 12_000), add('d', 7950, 8050)]);
    expect(windows(next)).toEqual(['b@8000..9000', 'a@2000..15000', 'c@8500..12000', 'd@7950..8050']);
    expect(applyEditOps(before, [add('a', 2000, 15_000)])).toEqual(addAudioEffect(before, { id: 'a', startMs: 2000, endMs: 15_000, effect: 'megaphone' }, TOTAL));
  });

  /* Five slow + reverbs over one line is the customer's choice, and so is the agent's. */
  it('stacks the same effect over the same time as many times as it is asked to', () => {
    const five = applyEditOps(
      post(),
      Array.from({ length: 5 }, (_, i) => add(`s${i}`, 0, 5000, { effect: 'slowReverb' })),
    );
    expect(windows(five)).toEqual(['s0@0..5000', 's1@0..5000', 's2@0..5000', 's3@0..5000', 's4@0..5000']);
  });

  it('cuts a layer at the end of the post, and refuses only one starting too near it, saying where the post ends', () => {
    const manifest = applyEditOps(post(), [add('b', 8000, 9000)]);
    expect(windows(applyEditOps(manifest, [add('a', 18_000, 40_000)]))).toEqual(['b@8000..9000', 'a@18000..20000']);
    expect(windows(applyEditOps(manifest, [add('a', 20_000 - MIN_LAYER_MS)]))).toEqual(['b@8000..9000', 'a@19900..20000']);
    expect(() => applyEditOps(manifest, [add('a', 19_950)])).toThrow(
      /^op 0 \(addAudioEffect\): "a" cannot start at 19950ms - the post ends at 20000ms, and a layer runs at least 100ms$/,
    );
    expect(() => applyEditOps(manifest, [add('a', 25_000, 26_000)])).toThrow(/^op 0 \(addAudioEffect\): "a" cannot start at 25000ms - the post ends at 20000ms/);
    // A post with nothing on it has no time for one at all.
    expect(() => applyEditOps(emptyManifest(), [add('a', 0)])).toThrow(/"a" cannot start at 0ms - the post ends at 0ms, and a layer runs at least 100ms$/);
  });

  it('refuses an effect this version does not have, naming the ones it does', () => {
    expect(() => applyEditOps(post(), [add('a', 0, 1000, { effect: 'echo' })])).toThrow(
      /^op 0 \(addAudioEffect\): "effect" must be one of megaphone, slowReverb, maleVoice, femaleVoice, telephone$/,
    );
    expect(() => applyEditOps(post(), [{ op: 'addAudioEffect', id: 'a', startMs: 0 }])).toThrow(/"effect" must be one of megaphone, slowReverb, maleVoice/);
  });

  it('refuses a slider the effect has not got, and one off its scale, naming what there is', () => {
    expect(() => applyEditOps(post(), [add('a', 0, 1000, { effectSettings: { room: 80 } })])).toThrow(
      /"effectSettings\.room" is not a slider of "megaphone" - its sliders are "intensity", "tone"$/,
    );
    expect(() => applyEditOps(post(), [add('a', 0, 1000, { effectSettings: { intensity: 120 } })])).toThrow(/"effectSettings\.intensity" must be a number from 0 to 100$/);
    expect(() => applyEditOps(post(), [add('a', 0, 1000, { effectSettings: { tone: 'dull' } })])).toThrow(/"effectSettings\.tone" must be a number from 0 to 100$/);
    expect(() => applyEditOps(post(), [add('a', 0, 1000, { effectSettings: [80] })])).toThrow(
      /"effectSettings" must be an object of the effect's sliders, each a number from 0 to 100$/,
    );
  });

  it('takes a speed only for an effect that slows, and only on its Slow slider’s range', () => {
    expect(() => applyEditOps(post(), [add('a', 0, 1000, { speed: 0.8 })])).toThrow(
      /"speed" is only for an effect that slows what it covers \("slowReverb"\), and "megaphone" does not$/,
    );
    for (const speed of [0.4, 1.2, 'slow']) {
      expect(() => applyEditOps(post(), [add('a', 0, 1000, { effect: 'slowReverb', speed })]), String(speed)).toThrow(
        /"speed" must be a number from 0\.5 to 1 - how slow "slowReverb" plays what it covers, 0\.8 by default$/,
      );
    }
    // Both ends of the range are its own, and a speed is kept to the hundredth as the slider keeps it.
    const edges = applyEditOps(post(), [
      add('a', 0, 1000, { effect: 'slowReverb', speed: 0.5 }),
      add('b', 1000, 2000, { effect: 'slowReverb', speed: 1 }),
      add('c', 2000, 3000, { effect: 'slowReverb', speed: 0.734 }),
    ]);
    expect(edges.audioEffects?.map(layer => layer.speed)).toEqual([0.5, 1, 0.73]);
  });

  it('refuses a window shorter than a layer runs, and a time before the post starts', () => {
    expect(() => applyEditOps(post(), [add('a', 1000, 1050)])).toThrow(
      /"endMs" must be at least 100ms after "startMs", which is 1000 - leave it out to run the layer to the end of the post$/,
    );
    // Not "until the end", as a sound's 0 is: a layer has a length.
    expect(() => applyEditOps(post(), [add('a', 1000, 0)])).toThrow(/"endMs" must be at least 100ms after "startMs"/);
    expect(() => applyEditOps(post(), [add('a', -500, 2000)])).toThrow(/"startMs" must be a number of milliseconds, 0 or more$/);
    expect(windows(applyEditOps(post(), [add('a', 1000, 1000 + MIN_LAYER_MS)]))).toEqual(['a@1000..1100']);
  });

  it('refuses a taken id, and one more layer than a post holds', () => {
    expect(() => applyEditOps(post(), [add('a', 0, 1000), add('a', 2000, 3000)])).toThrow(/^op 1 \(addAudioEffect\): audio effect id "a" is already on this post$/);
    // All of them over the same second: any number may cover a moment, up to the cap.
    const full = applyEditOps(
      post(),
      Array.from({ length: MAX_AUDIO_EFFECTS }, (_, i) => add(`l${i}`, 0, 1000)),
    );
    expect(full.audioEffects).toHaveLength(MAX_AUDIO_EFFECTS);
    for (const op of [add('more', 15_000, 16_000), { op: 'duplicateAudioEffect', id: 'l0', newId: 'more' }, { op: 'splitAudioEffect', id: 'l0', atMs: 500, newId: 'more' }]) {
      expect(() => applyEditOps(full, [op]), op.op).toThrow(/this post already has the maximum of 50 audio effects$/);
    }
    // A move makes no layer, so the cap does not stop it.
    expect(applyEditOps(full, [{ op: 'moveAudioEffect', id: 'l0', move: 'front' }]).audioEffects?.at(-1)?.id).toBe('l0');
  });

  /* What the old recipe - cut the word out of its sound and give that piece the megaphone - is now. */
  it('gives one word of a line a megaphone by a layer over just that word, leaving the sound as it is', () => {
    const line = applyEditOps(post(), [{ op: 'addAudio', id: 'line', sound: { uri: 'file:///line.m4a', sourceDurationMs: 5000, startMs: 0 } }, add('word', 1000, 2000)]);
    expect(line.audioEffects).toEqual([{ id: 'word', startMs: 1000, endMs: 2000, effect: 'megaphone' }]);
    expect(findAudioClip(line, 'line')).toMatchObject({ startMs: 0, endMs: 0, inMs: 0, outMs: 0 });
    expect(findAudioClip(line, 'line')).not.toHaveProperty('effect');
  });
});

describe('patchAudioEffect', () => {
  it('starts another effect at its defaults, sliders and speed alike, unless the patch sets them', () => {
    const manifest = applyEditOps(post(), [{ op: 'addAudioEffect', id: 'a', effect: 'slowReverb', startMs: 1000, endMs: 4000, speed: 0.6, effectSettings: { room: 90 } }]);
    const megaphone = applyEditOps(manifest, [patch('a', { effect: 'megaphone' })]);
    expect(layerOf(megaphone, 'a')).toEqual({ id: 'a', startMs: 1000, endMs: 4000, effect: 'megaphone' });
    expect(layerOf(applyEditOps(manifest, [patch('a', { effect: 'megaphone', effectSettings: { tone: 20 } })]), 'a')).toEqual({
      id: 'a',
      startMs: 1000,
      endMs: 4000,
      effect: 'megaphone',
      effectSettings: { tone: 20 },
    });
    // Back to slow + reverb is its own defaults, not what the layer had before it was a megaphone.
    expect(layerOf(applyEditOps(megaphone, [patch('a', { effect: 'slowReverb' })]), 'a')).toEqual({ id: 'a', startMs: 1000, endMs: 4000, effect: 'slowReverb' });
  });

  it('moves the sliders it names and leaves the rest where they are, as the sheet’s sliders do', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 4000, { effectSettings: { intensity: 80 } })]);
    const toned = applyEditOps(manifest, [patch('a', { effectSettings: { tone: 20 } })]);
    expect(layerOf(toned, 'a')?.effectSettings).toEqual({ intensity: 80, tone: 20 });
    // The editor's own slider, which is what the patch is, a slider at a time.
    expect(toned).toEqual(setAudioEffectSetting(manifest, 'a', 'tone', 20));
    // Put back at their defaults, they are stored as none.
    expect(layerOf(applyEditOps(toned, [patch('a', { effectSettings: { intensity: 50, tone: 50 } })]), 'a')).not.toHaveProperty('effectSettings');
    expect(() => applyEditOps(toned, [patch('a', { effectSettings: { reverb: 10 } })])).toThrow(/"patch\.effectSettings\.reverb" is not a slider of "megaphone"/);
  });

  it('sets how slow slow + reverb plays, judged against the effect the patch leaves the layer with', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 4000, { effect: 'slowReverb' }), add('b', 5000, 6000)]);
    expect(layerOf(applyEditOps(manifest, [patch('a', { speed: 0.55 })]), 'a')?.speed).toBe(0.55);
    expect(() => applyEditOps(manifest, [patch('a', { speed: 0.3 })])).toThrow(/"patch\.speed" must be a number from 0\.5 to 1/);
    expect(() => applyEditOps(manifest, [patch('b', { speed: 0.8 })])).toThrow(
      /"patch\.speed" is only for an effect that slows what it covers \("slowReverb"\), and "megaphone" does not$/,
    );
    expect(layerOf(applyEditOps(manifest, [patch('b', { effect: 'slowReverb', speed: 0.7 })]), 'b')).toMatchObject({ effect: 'slowReverb', speed: 0.7 });
    expect(() => applyEditOps(manifest, [patch('a', { effect: 'megaphone', speed: 0.7 })])).toThrow(/and "megaphone" does not$/);
  });

  it('answers a patch that asks for nothing new with the post as it was', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 4000, { effectSettings: { intensity: 80 } })]);
    for (const fields of [{}, { effect: 'megaphone' }, { effectSettings: { intensity: 80 } }, { startMs: 1000, endMs: 4000 }]) {
      expect(applyEditOps(manifest, [patch('a', fields)]), JSON.stringify(fields)).toBe(manifest);
    }
  });

  describe('its window', () => {
    /** Three layers with time between them, bottom to top. */
    const three = (): EditManifest => applyEditOps(post(), [add('a', 1000, 3000), add('b', 5000, 7000), add('c', 9000, 10_000)]);
    const moved = (fields: Record<string, unknown>) => windows(applyEditOps(three(), [patch('b', fields)]));

    it('moves and trims a layer anywhere on the post, over and under the others, as the timeline’s drag does', () => {
      expect(moved({ startMs: 3000, endMs: 9000 })).toEqual(['a@1000..3000', 'b@3000..9000', 'c@9000..10000']);
      expect(moved({ startMs: 4000 })).toEqual(['a@1000..3000', 'b@4000..7000', 'c@9000..10000']);
      expect(moved({ endMs: 8000 })).toEqual(['a@1000..3000', 'b@5000..8000', 'c@9000..10000']);
      // Over the layer under it, under the one over it, and past both: layers stack, so none stops it.
      expect(moved({ startMs: 2500 })).toEqual(['a@1000..3000', 'b@2500..7000', 'c@9000..10000']);
      expect(moved({ endMs: 9500 })).toEqual(['a@1000..3000', 'b@5000..9500', 'c@9000..10000']);
      expect(moved({ startMs: 11_000, endMs: 12_000 })).toEqual(['a@1000..3000', 'b@11000..12000', 'c@9000..10000']);
      expect(moved({ startMs: 0, endMs: 500 })).toEqual(['a@1000..3000', 'b@0..500', 'c@9000..10000']);
      expect(moved({ startMs: 0, endMs: TOTAL })).toEqual(['a@1000..3000', 'b@0..20000', 'c@9000..10000']);
      // Each one the editor's own drag, given the same window.
      for (const [startMs, endMs] of [
        [3000, 9000],
        [4000, 7000],
        [5000, 8000],
        [2500, 7000],
        [5000, 9500],
        [11_000, 12_000],
        [0, 500],
        [0, TOTAL],
      ] as const) {
        expect(applyEditOps(three(), [patch('b', { startMs, endMs })]), `${startMs}..${endMs}`).toEqual(setAudioEffectWindow(three(), 'b', startMs, endMs, TOTAL));
      }
    });

    it('keeps the layer’s place in the stack wherever its window goes', () => {
      expect(order(applyEditOps(three(), [patch('c', { startMs: 0, endMs: 2000 })]))).toBe('abc');
      expect(order(applyEditOps(three(), [patch('a', { startMs: 9000, endMs: 12_000 })]))).toBe('abc');
    });

    it('refuses a window under the shortest a layer runs, or starting too late for the post to hear', () => {
      expect(() => applyEditOps(three(), [patch('b', { endMs: 5050 })])).toThrow(/^op 0 \(patchAudioEffect\): "b" would run 5000ms\.\.5050ms, and a layer runs at least 100ms$/);
      expect(() => applyEditOps(three(), [patch('b', { endMs: 4000 })])).toThrow(/"b" would run 5000ms\.\.4000ms/);
      expect(() => applyEditOps(three(), [patch('c', { startMs: 19_950, endMs: 25_000 })])).toThrow(
        /^op 0 \(patchAudioEffect\): "c" cannot start at 19950ms - the post ends at 20000ms, and a layer runs at least 100ms$/,
      );
      expect(() => applyEditOps(three(), [patch('b', { startMs: -1 })])).toThrow(/"patch\.startMs" must be a number of milliseconds, 0 or more$/);
    });

    /*
     * Each refused window is one the drag would have put somewhere else. If the editor's drag ever
     * takes one of these, the op is refusing an edit the editor allows.
     */
    it('refuses only windows the editor’s drag would not give', () => {
      for (const [startMs, endMs] of [
        [5000, 5050],
        [4000, 3000],
        [19_950, 25_000],
        [25_000, 26_000],
      ] as const) {
        expect(() => applyEditOps(three(), [patch('b', { startMs, endMs })]), `${startMs}..${endMs}`).toThrow();
        expect(windows(setAudioEffectWindow(three(), 'b', startMs, endMs, TOTAL)), `${startMs}..${endMs}`).not.toContain(`b@${startMs}..${endMs}`);
      }
    });

    it('ends a window running past the end of the post there, as the drag and an add do', () => {
      expect(windows(applyEditOps(three(), [patch('c', { endMs: 25_000 })]))).toEqual(['a@1000..3000', 'b@5000..7000', 'c@9000..20000']);
    });

    it('moves the window and changes the effect in one patch', () => {
      const next = applyEditOps(three(), [patch('b', { effect: 'slowReverb', speed: 0.6, startMs: 4000, endMs: 8000 })]);
      expect(layerOf(next, 'b')).toEqual({ id: 'b', startMs: 4000, endMs: 8000, effect: 'slowReverb', speed: 0.6 });
    });
  });

  it('refuses a field a layer patch does not take, its id, and a null', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 4000, { effect: 'slowReverb' })]);
    expect(() => applyEditOps(manifest, [patch('a', { effectSetting: { room: 2 } })])).toThrow(
      /"patch\.effectSetting" is not an audio effect field - the fields are effect, effectSettings, speed, startMs, endMs$/,
    );
    expect(() => applyEditOps(manifest, [patch('a', { id: 'z' })])).toThrow(/an audio effect’s "id" cannot be patched$/);
    expect(() => applyEditOps(manifest, [patch('a', { effect: null })])).toThrow(/"patch\.effect" must be one of megaphone, slowReverb, maleVoice, femaleVoice, telephone$/);
    expect(() => applyEditOps(manifest, [patch('a', { effectSettings: null })])).toThrow(/"patch\.effectSettings" must be an object/);
    expect(() => applyEditOps(manifest, [patch('a', { speed: null })])).toThrow(/"patch\.speed" must be a number from 0\.5 to 1/);
    expect(() => applyEditOps(manifest, [patch('a', { endMs: null })])).toThrow(/"patch\.endMs" must be a number of milliseconds, 0 or more$/);
    expect(() => applyEditOps(manifest, [{ op: 'patchAudioEffect', id: 'a' }])).toThrow(/"patch" must be an object/);
  });
});

describe('splitAudioEffect, duplicateAudioEffect and removeAudioEffect', () => {
  it('cuts a layer in two, both halves the effect it was, so one half can be given another', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 3000, { effectSettings: { tone: 70 } })]);
    const cut = applyEditOps(manifest, [{ op: 'splitAudioEffect', id: 'a', atMs: 2000, newId: 'a2' }]);
    expect(cut.audioEffects).toEqual([
      { id: 'a', startMs: 1000, endMs: 2000, effect: 'megaphone', effectSettings: { tone: 70 } },
      { id: 'a2', startMs: 2000, endMs: 3000, effect: 'megaphone', effectSettings: { tone: 70 } },
    ]);
    const half = applyEditOps(cut, [patch('a2', { effect: 'slowReverb' })]);
    expect(half.audioEffects?.map(layer => layer.effect)).toEqual(['megaphone', 'slowReverb']);
  });

  it('keeps both halves of a cut where the layer was in the stack, the second just above the first', () => {
    const stack = applyEditOps(post(), [add('x', 0, 5000), add('a', 1000, 3000), add('y', 0, 5000)]);
    const cut = applyEditOps(stack, [{ op: 'splitAudioEffect', id: 'a', atMs: 2000, newId: 'a2' }]);
    expect(windows(cut)).toEqual(['x@0..5000', 'a@1000..2000', 'a2@2000..3000', 'y@0..5000']);
    expect(cut).toEqual(splitAudioEffect(stack, 'a', 2000, 'a2'));
  });

  it('refuses a cut that leaves a half too short, or lands outside the layer, or reuses an id', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 3000)]);
    expect(() => applyEditOps(manifest, [{ op: 'splitAudioEffect', id: 'a', atMs: 1050, newId: 'a2' }])).toThrow(
      /^op 0 \(splitAudioEffect\): "a" cannot be cut at 1050ms - it runs 1000ms\.\.3000ms, and both halves need to be at least 100ms$/,
    );
    expect(() => applyEditOps(manifest, [{ op: 'splitAudioEffect', id: 'a', atMs: 3500, newId: 'a2' }])).toThrow(/"a" cannot be cut at 3500ms/);
    expect(() => applyEditOps(manifest, [{ op: 'splitAudioEffect', id: 'a', atMs: 2000, newId: 'a' }])).toThrow(/audio effect id "a" is already on this post$/);
  });

  it('puts a copy straight after a layer in time, as long as it, and one place above it in the stack, over whatever is there', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 3000), add('c', 4000, 5000)]);
    // Under "c", which it now shares a second with, because the copy goes just above "a".
    expect(windows(applyEditOps(manifest, [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }]))).toEqual(['a@1000..3000', 'b@3000..5000', 'c@4000..5000']);
    expect(windows(applyEditOps(manifest, [{ op: 'duplicateAudioEffect', id: 'c', newId: 'd' }]))).toEqual(['a@1000..3000', 'c@4000..5000', 'd@5000..6000']);
    expect(applyEditOps(manifest, [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }])).toEqual(duplicateAudioEffect(manifest, 'a', 'b', TOTAL));
    const toned = applyEditOps(manifest, [patch('a', { effectSettings: { tone: 10 } }), { op: 'duplicateAudioEffect', id: 'a', newId: 'b' }]);
    expect(layerOf(toned, 'b')?.effectSettings).toEqual({ tone: 10 });
  });

  it('cuts a copy at the end of the post', () => {
    expect(windows(applyEditOps(post(), [add('a', 15_000, 19_000), { op: 'duplicateAudioEffect', id: 'a', newId: 'b' }]))).toEqual(['a@15000..19000', 'b@19000..20000']);
  });

  it('refuses a copy only when the post ends too soon after the layer, or under a taken id', () => {
    // A layer starting where the original ends is no reason: the copy stacks with it.
    const tight = applyEditOps(post(), [add('a', 1000, 3000), add('c', 3000, 5000)]);
    expect(windows(applyEditOps(tight, [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }]))).toEqual(['a@1000..3000', 'b@3000..5000', 'c@3000..5000']);
    expect(() => applyEditOps(applyEditOps(post(), [add('a', 18_000)]), [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }])).toThrow(
      /^op 0 \(duplicateAudioEffect\): "a" cannot be copied - its copy would start where it ends, at 20000ms, and the post ends at 20000ms; a layer runs at least 100ms$/,
    );
    expect(() => applyEditOps(applyEditOps(post(), [add('a', 18_000, 19_950)]), [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }])).toThrow(
      /"a" cannot be copied - its copy would start where it ends, at 19950ms/,
    );
    expect(() => applyEditOps(tight, [{ op: 'duplicateAudioEffect', id: 'a', newId: 'c' }])).toThrow(/audio effect id "c" is already on this post$/);
  });

  it('removes a layer, and the key with the last one', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 3000), add('b', 4000, 5000)]);
    expect(windows(applyEditOps(manifest, [{ op: 'removeAudioEffect', id: 'a' }]))).toEqual(['b@4000..5000']);
    expect(
      'audioEffects' in
        applyEditOps(manifest, [
          { op: 'removeAudioEffect', id: 'a' },
          { op: 'removeAudioEffect', id: 'b' },
        ]),
    ).toBe(false);
  });

  it('refuses an id the post has not got on every op, listing the ones it has', () => {
    const manifest = applyEditOps(post(), [add('a', 0, 1000), add('b', 2000, 3000)]);
    for (const op of [
      patch('zz', { effect: 'megaphone' }),
      { op: 'splitAudioEffect', id: 'zz', atMs: 500, newId: 'y' },
      { op: 'duplicateAudioEffect', id: 'zz', newId: 'y' },
      { op: 'moveAudioEffect', id: 'zz', move: 'front' },
      { op: 'moveAudioEffectTo', id: 'zz', toIndex: 0 },
      { op: 'removeAudioEffect', id: 'zz' },
    ]) {
      expect(() => applyEditOps(manifest, [op]), op.op).toThrow(new RegExp(`^op 0 \\(${op.op}\\): no audio effect "zz" - audio effects on this post: a, b$`));
    }
    expect(() => applyEditOps(post(), [{ op: 'removeAudioEffect', id: 'zz' }])).toThrow(/audio effects on this post: none$/);
  });

  it('changes nothing at all when one op in the list is refused', () => {
    const before = applyEditOps(post(), [add('a', 1000, 3000)]);
    const snapshot = JSON.stringify(before);
    expect(() =>
      applyEditOps(before, [{ op: 'splitAudioEffect', id: 'a', atMs: 2000, newId: 'a2' }, { op: 'removeAudioEffect', id: 'a' }, patch('a2', { effect: 'echo' })]),
    ).toThrow(/^op 2 \(patchAudioEffect\)/);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

/*
 * Where a layer is in the stack is what it works on: the layer's Forward, Backward, To front and To
 * back, and holding it on the timeline to drop it at another place.
 */
describe('moveAudioEffect and moveAudioEffectTo', () => {
  /** A megaphone, slow + reverb over the same time, and a second megaphone inside both, bottom to top. */
  const stack = (): EditManifest => applyEditOps(post(), [add('a', 0, 5000), add('b', 0, 5000, { effect: 'slowReverb' }), add('c', 2000, 4000)]);
  const move = (id: string, where: unknown): EditOp => ({ op: 'moveAudioEffect', id, move: where });
  const moveTo = (id: string, toIndex: unknown): EditOp => ({ op: 'moveAudioEffectTo', id, toIndex });

  it('moves a layer one place, or to the top or the bottom of the stack, as the editor’s four tools do', () => {
    expect(order(applyEditOps(stack(), [move('a', 'forward')]))).toBe('bac');
    expect(order(applyEditOps(stack(), [move('a', 'front')]))).toBe('bca');
    expect(order(applyEditOps(stack(), [move('c', 'backward')]))).toBe('acb');
    expect(order(applyEditOps(stack(), [move('c', 'back')]))).toBe('cab');
    expect(order(applyEditOps(stack(), [move('b', 'forward')]))).toBe('acb');
    expect(order(applyEditOps(stack(), [move('b', 'back')]))).toBe('bac');
    // Each the editor's own move, which changes where the layer is in the stack and nothing else.
    for (const [id, where] of [
      ['a', 'forward'],
      ['a', 'front'],
      ['c', 'backward'],
      ['c', 'back'],
    ] as const) {
      const moved = applyEditOps(stack(), [move(id, where)]);
      expect(moved, `${id} ${where}`).toEqual(moveAudioEffect(stack(), id, where));
      expect(layerOf(moved, id), `${id} ${where}`).toEqual(layerOf(stack(), id));
    }
  });

  it('refuses a move past the end of the stack, saying which end', () => {
    for (const where of ['forward', 'front']) {
      expect(() => applyEditOps(stack(), [move('c', where)]), where).toThrow(/^op 0 \(moveAudioEffect\): "c" is already on top - no audio effect is above it in the stack$/);
    }
    for (const where of ['backward', 'back']) {
      expect(() => applyEditOps(stack(), [move('a', where)]), where).toThrow(/^op 0 \(moveAudioEffect\): "a" is already at the bottom - no audio effect is under it in the stack$/);
    }
    const one = applyEditOps(post(), [add('a', 0, 5000)]);
    expect(() => applyEditOps(one, [move('a', 'front')])).toThrow(/"a" is already on top - it is the only audio effect on this post$/);
    expect(() => applyEditOps(one, [move('a', 'backward')])).toThrow(/"a" is already at the bottom - it is the only audio effect on this post$/);
  });

  it('refuses a move it does not know', () => {
    expect(() => applyEditOps(stack(), [move('a', 'up')])).toThrow(/^op 0 \(moveAudioEffect\): "move" must be one of forward, backward, front, back$/);
    expect(() => applyEditOps(stack(), [{ op: 'moveAudioEffect', id: 'a' }])).toThrow(/"move" must be a non-empty string$/);
  });

  it('puts a layer at an exact place in the stack, 0 the bottom, as dropping it there on the timeline does', () => {
    expect(order(applyEditOps(stack(), [moveTo('c', 0)]))).toBe('cab');
    expect(order(applyEditOps(stack(), [moveTo('a', 2)]))).toBe('bca');
    expect(order(applyEditOps(stack(), [moveTo('a', 1)]))).toBe('bac');
    expect(applyEditOps(stack(), [moveTo('c', 0)])).toEqual(moveAudioEffectTo(stack(), 'c', 0));
    // The place it has is no move and no refusal, as a lane dropped back where it was is neither.
    const manifest = stack();
    expect(applyEditOps(manifest, [moveTo('b', 1)])).toBe(manifest);
  });

  /* Held to an end instead, as the drop holds it, an agent's -1 for the top would be the bottom. */
  it('refuses a place the stack has not got', () => {
    for (const toIndex of [3, -1, 1.5]) {
      expect(() => applyEditOps(stack(), [moveTo('a', toIndex)]), String(toIndex)).toThrow(
        /^op 0 \(moveAudioEffectTo\): "toIndex" must be a whole number from 0, the bottom of the stack, to 2, the top$/,
      );
    }
    expect(() => applyEditOps(stack(), [moveTo('a', '1')])).toThrow(/"toIndex" must be a finite number$/);
  });

  it('changes what each layer works on, which the summary says', () => {
    const summary = summariseManifest(applyEditOps(stack(), [move('c', 'back')]));
    expect(summary).toContain(
      `\nAudio effects: 3 layers, bottom to top${HEADER}\n` +
        '  0. "c" 2000ms (0:02.0)..4000ms (0:04.0), megaphone (effect "megaphone"; intensity 50, tone 50)\n' +
        '  1. "a" 0ms..5000ms (0:05.0), megaphone (effect "megaphone"; intensity 50, tone 50); stacked on "c" at 2000ms (0:02.0)..4000ms (0:04.0)\n' +
        '  2. "b" 0ms..5000ms (0:05.0), slow + reverb (effect "slowReverb"; speed 0.8, reverb 50, room 50), playing what it covers at 0.8x as a record ' +
        'plays it, lower as well as slower; stacked on "c" at 2000ms (0:02.0)..4000ms (0:04.0), "a" at 0ms..5000ms (0:05.0)\n\n',
    );
  });
});

describe('what an agent reads about the audio effects', () => {
  it('lists every layer in the order they stack in the summary, numbered from the bottom, each with its sliders and slow + reverb with its speed', () => {
    const manifest = applyEditOps(post(), [
      { op: 'addAudioEffect', id: 'slow', effect: 'slowReverb', startMs: 4000, endMs: 9000, effectSettings: { room: 80 } },
      add('loud', 1000, 5000, { effectSettings: { intensity: 80 } }),
    ]);
    expect(summariseManifest(manifest)).toContain(
      '\nVoiceover: none\n' +
        `Audio effects: 2 layers, bottom to top${HEADER}\n` +
        '  0. "slow" 4000ms (0:04.0)..9000ms (0:09.0), slow + reverb (effect "slowReverb"; speed 0.8, reverb 50, room 80), ' +
        'playing what it covers at 0.8x as a record plays it, lower as well as slower\n' +
        '  1. "loud" 1000ms (0:01.0)..5000ms (0:05.0), megaphone (effect "megaphone"; intensity 80, tone 50); stacked on "slow" at 4000ms (0:04.0)..5000ms (0:05.0)\n\n',
    );
    expect(summariseManifest(post())).toMatch(/\nVoiceover: none\nAudio effects: none\n/);
    expect(summariseManifest(manifest)).not.toMatch(/one at a time/);
  });

  /* Each pair once, on the upper layer, by the time they share - so an agent can see what is stacked where. */
  it('says which layers each one is stacked on, and where, and nothing for layers that only meet', () => {
    const manifest = applyEditOps(post(), [add('a', 0, 5000), add('b', 5000, 8000), add('c', 4000, 6000), add('d', 0, TOTAL, { effect: 'slowReverb' })]);
    const lines = summariseManifest(manifest)
      .split('\nAudio effects: ')[1]!
      .split('\n')
      .filter(line => /^ {2}\d+\. "/.test(line));
    expect(lines.map(line => line.split('; stacked on ')[1] ?? 'nothing')).toEqual([
      'nothing',
      // "b" starts where "a" ends: next to it, not over it.
      'nothing',
      '"a" at 4000ms (0:04.0)..5000ms (0:05.0), "b" at 5000ms (0:05.0)..6000ms (0:06.0)',
      '"a" at 0ms..5000ms (0:05.0), "b" at 5000ms (0:05.0)..8000ms (0:08.0), "c" at 4000ms (0:04.0)..6000ms (0:06.0)',
    ]);
  });

  /* What the post plays of each, so two that meet only past the end of a shorter post share nothing heard. */
  it('stacks nothing on a layer the post does not play', () => {
    const long = applyEditOps(post(), [add('x', 1000, 18_000), add('y', 17_000, 19_000)]);
    expect(summariseManifest(long)).toContain('; stacked on "x" at 17000ms (0:17.0)..18000ms (0:18.0)');
    expect(summariseManifest({ ...long, clips: [defaultClipEdit('v', 16_000)] })).not.toContain('stacked on');
  });

  it('says what of a layer a post that got shorter still plays', () => {
    const long = applyEditOps(post(), [add('a', 15_000, 19_000), add('b', 19_000)]);
    const summary = summariseManifest({ ...long, clips: [defaultClipEdit('v', 16_000)] });
    expect(summary).toContain('"a" 15000ms (0:15.0)..19000ms (0:19.0), megaphone (effect "megaphone"; intensity 50, tone 50); heard only to 16000ms (0:16.0), where the post ends');
    expect(summary).toContain(
      '"b" 19000ms (0:19.0)..20000ms (0:20.0), megaphone (effect "megaphone"; intensity 50, tone 50); never heard: it starts at or after the end of the post',
    );
  });

  it('says no effect, and no record, on a sound any more', () => {
    const summary = summariseManifest(applyEditOps(post(), [{ op: 'addAudio', id: 's', sound: { uri: 'file:///s.m4a', fileName: 's.m4a', sourceDurationMs: 5000, speed: 0.8 } }]));
    expect(summary).toContain('"s" s.m4a, from 0ms, at 0ms on the post, 100%, at 0.8x; heard 0ms..6250ms (0:06.2)');
    expect(summary).not.toMatch(/as a record|through the/);
  });

  it('lists the effects, their sliders and slow + reverb’s speed in the catalogue', () => {
    const catalog = tool(createTools(), 'catalog_list');
    const result = catalog.run({ section: 'audioEffects' });
    expect(result.structuredContent?.['audioEffects']).toEqual({
      maxPerPost: MAX_AUDIO_EFFECTS,
      minMs: MIN_LAYER_MS,
      effects: [
        {
          id: 'megaphone',
          label: 'Megaphone',
          sliders: [
            { key: 'intensity', label: 'Intensity', default: 50, min: 0, max: 100 },
            { key: 'tone', label: 'Tone', default: 50, min: 0, max: 100 },
          ],
        },
        {
          id: 'slowReverb',
          label: 'Slow + reverb',
          sliders: [
            { key: 'reverb', label: 'Reverb', default: 50, min: 0, max: 100 },
            { key: 'room', label: 'Room', default: 50, min: 0, max: 100 },
          ],
          speed: { label: 'Slow', default: 0.8, min: 0.5, max: 1 },
        },
        {
          id: 'maleVoice',
          label: 'Male voice',
          sliders: [
            { key: 'pitch', label: 'Pitch', default: 50, min: 0, max: 100 },
            { key: 'tone', label: 'Tone', default: 50, min: 0, max: 100 },
          ],
        },
        {
          id: 'femaleVoice',
          label: 'Female voice',
          sliders: [
            { key: 'pitch', label: 'Pitch', default: 50, min: 0, max: 100 },
            { key: 'tone', label: 'Tone', default: 50, min: 0, max: 100 },
          ],
        },
        {
          id: 'telephone',
          label: 'Telephone',
          sliders: [
            { key: 'intensity', label: 'Intensity', default: 50, min: 0, max: 100 },
            { key: 'tone', label: 'Tone', default: 50, min: 0, max: 100 },
          ],
        },
      ],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^Audio effects \(addAudioEffect effect\), each a layer over a window of the post .* at most 50 on a post, each at least 100ms:\n/);
    expect(text).toContain('Layers stack in any number, a new one on top: where they cover the same time a later one works on what the ones before it made');
    expect(text).toContain('two slowReverb layers at 0.8 over the same time play it at 0.64x');
    expect(text).not.toMatch(/one at a time/);
    expect(text).toContain('\n  megaphone (Megaphone) - sliders (effectSettings) intensity 0..100, default 50; tone 0..100, default 50');
    expect(text).toContain(
      "\n  slowReverb (Slow + reverb) - speed (the sheet's Slow) 0.5..1, default 0.8; sliders (effectSettings) reverb 0..100, default 50; room 0..100, default 50",
    );
    expect(text).toContain('\n  maleVoice (Male voice) - sliders (effectSettings) pitch 0..100, default 50; tone 0..100, default 50');
    expect(text).toContain('\n  femaleVoice (Female voice) - sliders (effectSettings) pitch 0..100, default 50; tone 0..100, default 50');
    expect(text).toContain('\n  telephone (Telephone) - sliders (effectSettings) intensity 0..100, default 50; tone 0..100, default 50');
    // In the whole catalogue too, and in its limits.
    expect(Object.keys(catalog.run({}).structuredContent ?? {})).toContain('audioEffects');
    const limits = catalog.run({ section: 'limits' });
    expect((limits.structuredContent as { limits: Record<string, unknown> }).limits['maxAudioEffects']).toBe(MAX_AUDIO_EFFECTS);
    expect(limits.content[0]?.text).toContain('at most 50 audio effects, any number of them over the same time, each at least 100ms');
  });

  it('tells an agent in the op reference what each effect is, what it takes, how the layers stack, and what is refused', () => {
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/megaphone \{intensity \(default 50\), tone \(default 50\)\}, slowReverb \{reverb \(default 50\), room \(default 50\)\}/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/speed is for an effect that slows - slowReverb 0\.5\.\.1, default 0\.8 - and refused for any other/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/put a layer over just that word/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/Layers STACK, as the picture’s layers do: a new one goes on top of the others, over whatever already covers that time/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/a megaphone over slow \+ reverb puts the slowed room through the horn/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/two slowReverb layers at 0\.8 over the same time play it at 0\.64x/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/A layer is cut at the end of the post, and refused when it starts less than 100ms before the end/);
    expect(OP_REFERENCE['patchAudioEffect']).toMatch(/anywhere on the post, over or under any other layer, as a drag on the timeline does; it keeps its place in the stack/);
    expect(OP_REFERENCE['patchAudioEffect']).toMatch(/one running past the end of the post ends there/);
    expect(OP_REFERENCE['splitAudioEffect']).toMatch(/Both stay where the layer was in the stack, the second just above the first/);
    expect(OP_REFERENCE['duplicateAudioEffect']).toMatch(/a copy straight after the layer in time, .* and one place above it in the stack/);
    expect(OP_REFERENCE['moveAudioEffect']).toMatch(/^id, move \("forward" \| "backward" \| "front" \| "back"\) - the layer’s place in the stack/);
    expect(OP_REFERENCE['moveAudioEffect']).toMatch(/Refused when the layer is already on top \(forward, front\) or at the bottom \(backward, back\)\.$/);
    expect(OP_REFERENCE['moveAudioEffectTo']).toMatch(/^id, toIndex - the layer at that place in the stack, 0 the bottom/);
    // Nothing is left of the rule that layers never overlap.
    for (const [name, line] of Object.entries(OP_REFERENCE).filter(([name]) => /AudioEffect/.test(name))) {
      expect(line, name).not.toMatch(/at a time|never overlap|either side|room before the next/);
    }
  });
});

/*
 * A draft from version 17, when an effect was a sound's own. The editor's reader turns each into a
 * layer over where its sound was heard (`src/editor/audio-effect.unit.test.ts`); what is pinned here
 * is that an agent handed such a draft sees the layer, and can work on it like any other.
 */
describe('a draft saved when effects were on the sounds', () => {
  const sound = (id: string, startMs: number, over: Record<string, unknown> = {}) => ({
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
  const v17 = (over: Record<string, unknown>) => ({ ...JSON.parse(JSON.stringify(post())), version: 17, ...over });

  it('opens with a sound’s effect as a layer over where it was heard, and says so', () => {
    const tools = createTools();
    const draft = v17({ audioTracks: [{ id: 'at-1', clips: [sound('a', 1000, { effect: 'megaphone', effectSettings: { intensity: 80 } })] }] });
    const validated = tool(tools, 'manifest_validate').run({ manifest: draft });
    const { manifest, manifestId } = validated.structuredContent as { manifest: EditManifest; manifestId: string };
    expect(manifest.version).toBe(MANIFEST_VERSION);
    expect(manifest.audioEffects).toEqual([{ id: 'afx-sound-0', startMs: 1000, endMs: 6000, effect: 'megaphone', effectSettings: { intensity: 80 } }]);
    expect(findAudioClip(manifest, 'a')).not.toHaveProperty('effect');
    expect(validated.content[0]?.text).toMatch(/Migrated from version 17 to 18\./);
    expect(validated.content[0]?.text).toContain('\n  0. "afx-sound-0" 1000ms (0:01.0)..6000ms (0:06.0), megaphone (effect "megaphone"; intensity 80, tone 50)');

    // A layer like any other, reached by the id the summary gave it.
    const edited = tool(tools, 'manifest_edit').run({ manifestId, ops: [patch('afx-sound-0', { effectSettings: { tone: 20 } })] });
    expect(layerOf((edited.structuredContent as { manifest: EditManifest }).manifest, 'afx-sound-0')?.effectSettings).toEqual({ intensity: 80, tone: 20 });
  });

  it('opens a slow + reverb music at 1x, its slowness the layer’s speed', () => {
    const inspected = tool(createTools(), 'manifest_inspect').run({ manifest: v17({ music: { ...sound('m', 0, { speed: 0.5 }), effect: 'slowReverb' } }) });
    const manifest = (inspected.structuredContent as { manifest: EditManifest }).manifest;
    expect(manifest.music).not.toHaveProperty('speed');
    expect(manifest.music).not.toHaveProperty('effect');
    // Five seconds of song at half speed was heard for ten, which the layer plays from its start.
    expect(manifest.audioEffects).toEqual([{ id: 'afx-sound-0', startMs: 0, endMs: 10_000, effect: 'slowReverb', speed: 0.5 }]);
    expect(inspected.content[0]?.text).toContain('slow + reverb (effect "slowReverb"; speed 0.5, reverb 50, room 50), playing what it covers at 0.5x');
  });
});
