import { describe, expect, it } from 'vitest';

import { MANIFEST_VERSION, MIN_LAYER_MS, defaultClipEdit, emptyManifest, type EditManifest } from '../editor/edit-manifest';
import { addAudioEffect, findAudioClip, setAudioEffectSetting, setAudioEffectWindow } from '../editor/edit-ops';
import { MAX_AUDIO_EFFECTS } from '../video-composer/definitions';
import { applyEditOps, type EditOp } from './ops';
import { summariseManifest } from './summary';
import { OP_REFERENCE, createTools, type ToolDefinition } from './tools';

/*
 * An agent's audio effect layers land where the editor's Audio effects sheet and timeline would put
 * them - one effect at a time, on the post's time - and a layer the editor would not keep, or would
 * keep somewhere other than asked, is refused with what is in the way. What the layers do to the
 * sound is the editor's to test (`src/editor/audio-effect.unit.test.ts`); this is the agent's side.
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

const windows = (manifest: EditManifest): string[] => (manifest.audioEffects ?? []).map(({ id, startMs, endMs }) => `${id}@${startMs}..${endMs}`);

const layerOf = (manifest: EditManifest, id: string) => manifest.audioEffects?.find(layer => layer.id === id);

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
    expect(manifest.audioEffects).toEqual([
      { id: 'a', startMs: 1000, endMs: 3000, effect: 'megaphone', effectSettings: { intensity: 80 } },
      { id: 'b', startMs: 4000, endMs: 9000, effect: 'slowReverb', effectSettings: { room: 90 }, speed: 0.6 },
      { id: 'c', startMs: 10_000, endMs: 12_000, effect: 'slowReverb' },
    ]);
  });

  it('runs to the end of the post when it is given no end, as the sheet adds one from the playhead', () => {
    expect(windows(applyEditOps(post(), [add('a', 5000)]))).toEqual(['a@5000..20000']);
    expect(windows(applyEditOps(post(), [add('a', 5000, undefined, { endMs: null, effectSettings: null, speed: null })]))).toEqual(['a@5000..20000']);
  });

  /* The editor's add, and `addZoom`'s: a layer dropped just before another is the one asked for, shorter. */
  it('is shortened to the room before the next layer and the end of the post, as the editor adds one', () => {
    const before = applyEditOps(post(), [add('b', 8000, 9000)]);
    const next = applyEditOps(before, [add('a', 2000, 15_000), add('c', 18_000, 40_000)]);
    expect(windows(next)).toEqual(['a@2000..8000', 'b@8000..9000', 'c@18000..20000']);
    expect(applyEditOps(before, [add('a', 2000, 15_000)])).toEqual(addAudioEffect(before, { id: 'a', startMs: 2000, endMs: 15_000, effect: 'megaphone' }, TOTAL));
  });

  it('refuses a layer with no room where it starts, naming what is in the way', () => {
    const manifest = applyEditOps(post(), [add('b', 8000, 9000)]);
    expect(() => applyEditOps(manifest, [add('a', 8500, 12_000)])).toThrow(
      /^op 0 \(addAudioEffect\): there is no room for an audio effect at 8500ms - "b" runs 8000ms\.\.9000ms there, and one audio effect is heard at a time$/,
    );
    expect(() => applyEditOps(manifest, [add('a', 7950, 12_000)])).toThrow(/at 7950ms - "b" starts at 8000ms, and a layer runs at least 100ms$/);
    expect(() => applyEditOps(manifest, [add('a', 19_950)])).toThrow(/at 19950ms - the post ends at 20000ms, and a layer runs at least 100ms$/);
    expect(() => applyEditOps(manifest, [add('a', 25_000, 26_000)])).toThrow(/at 25000ms - the post ends at 20000ms/);
  });

  it('refuses an effect this version does not have, naming the ones it does', () => {
    expect(() => applyEditOps(post(), [add('a', 0, 1000, { effect: 'echo' })])).toThrow(/^op 0 \(addAudioEffect\): "effect" must be one of megaphone, slowReverb$/);
    expect(() => applyEditOps(post(), [{ op: 'addAudioEffect', id: 'a', startMs: 0 }])).toThrow(/"effect" must be one of megaphone, slowReverb/);
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
    const full = applyEditOps(post(), Array.from({ length: MAX_AUDIO_EFFECTS }, (_, i) => add(`l${i}`, i * 200, i * 200 + 200)));
    expect(full.audioEffects).toHaveLength(MAX_AUDIO_EFFECTS);
    for (const op of [add('more', 15_000, 16_000), { op: 'duplicateAudioEffect', id: 'l0', newId: 'more' }, { op: 'splitAudioEffect', id: 'l0', atMs: 100, newId: 'more' }]) {
      expect(() => applyEditOps(full, [op]), op.op).toThrow(/this post already has the maximum of 50 audio effects$/);
    }
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
    /** Three layers with room between them. */
    const three = (): EditManifest => applyEditOps(post(), [add('a', 1000, 3000), add('b', 5000, 7000), add('c', 9000, 10_000)]);
    const moved = (fields: Record<string, unknown>) => windows(applyEditOps(three(), [patch('b', fields)]));

    it('moves and trims a layer between the layers either side, as the timeline’s drag does', () => {
      expect(moved({ startMs: 3000, endMs: 9000 })).toEqual(['a@1000..3000', 'b@3000..9000', 'c@9000..10000']);
      expect(moved({ startMs: 4000 })).toEqual(['a@1000..3000', 'b@4000..7000', 'c@9000..10000']);
      expect(moved({ endMs: 8000 })).toEqual(['a@1000..3000', 'b@5000..8000', 'c@9000..10000']);
      expect(moved({ startMs: 6000, endMs: 8000 })).toEqual(['a@1000..3000', 'b@6000..8000', 'c@9000..10000']);
      // Each one the editor's own drag, given the same window.
      for (const [startMs, endMs] of [
        [3000, 9000],
        [4000, 7000],
        [5000, 8000],
        [6000, 8000],
      ] as const) {
        expect(applyEditOps(three(), [patch('b', { startMs, endMs })])).toEqual(setAudioEffectWindow(three(), 'b', startMs, endMs, TOTAL));
      }
    });

    it('refuses a window over the layer either side, naming it', () => {
      expect(() => applyEditOps(three(), [patch('b', { startMs: 2500 })])).toThrow(
        /^op 0 \(patchAudioEffect\): "b" cannot start at 2500ms - "a" runs 1000ms\.\.3000ms, and one audio effect is heard at a time$/,
      );
      expect(() => applyEditOps(three(), [patch('b', { endMs: 9500 })])).toThrow(/"b" cannot end at 9500ms - "c" runs 9000ms\.\.10000ms, and one audio effect is heard at a time$/);
    });

    /* The drag cannot get there, so neither does the patch; taking it out and adding it there can. */
    it('refuses a window past the layer either side, and says how to put it there', () => {
      expect(() => applyEditOps(three(), [patch('b', { startMs: 11_000, endMs: 12_000 })])).toThrow(
        /"b" cannot move past "c" \(9000ms\.\.10000ms\) - a layer moves only between the layers either side of it, as on the timeline; remove it and add it again there instead$/,
      );
      expect(() => applyEditOps(three(), [patch('b', { startMs: 0, endMs: 500 })])).toThrow(/"b" cannot move past "a" \(1000ms\.\.3000ms\)/);
      expect(windows(applyEditOps(three(), [{ op: 'removeAudioEffect', id: 'b' }, add('b', 11_000, 12_000)]))).toEqual(['a@1000..3000', 'c@9000..10000', 'b@11000..12000']);
    });

    it('refuses a window under the shortest a layer runs, or starting too late for the post to hear', () => {
      expect(() => applyEditOps(three(), [patch('b', { endMs: 5050 })])).toThrow(/"b" would run 5000ms\.\.5050ms, and a layer runs at least 100ms$/);
      expect(() => applyEditOps(three(), [patch('b', { endMs: 4000 })])).toThrow(/"b" would run 5000ms\.\.4000ms/);
      expect(() => applyEditOps(three(), [patch('c', { startMs: 19_950, endMs: 25_000 })])).toThrow(
        /"c" cannot start at 19950ms - the post ends at 20000ms, and a layer runs at least 100ms$/,
      );
      expect(() => applyEditOps(three(), [patch('b', { startMs: -1 })])).toThrow(/"patch\.startMs" must be a number of milliseconds, 0 or more$/);
    });

    /*
     * Each refused window is one the drag would have put somewhere else. If the editor's drag ever
     * takes one of these, the op is refusing an edit the editor allows.
     */
    it('refuses only windows the editor’s drag would not give', () => {
      for (const [startMs, endMs] of [
        [2500, 7000],
        [5000, 9500],
        [11_000, 12_000],
        [0, 500],
        [5000, 5050],
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
    expect(() => applyEditOps(manifest, [patch('a', { effect: null })])).toThrow(/"patch\.effect" must be one of megaphone, slowReverb$/);
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

  it('refuses a cut that leaves a half too short, or lands outside the layer, or reuses an id', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 3000)]);
    expect(() => applyEditOps(manifest, [{ op: 'splitAudioEffect', id: 'a', atMs: 1050, newId: 'a2' }])).toThrow(
      /^op 0 \(splitAudioEffect\): "a" cannot be cut at 1050ms - it runs 1000ms\.\.3000ms, and both halves need to be at least 100ms$/,
    );
    expect(() => applyEditOps(manifest, [{ op: 'splitAudioEffect', id: 'a', atMs: 3500, newId: 'a2' }])).toThrow(/"a" cannot be cut at 3500ms/);
    expect(() => applyEditOps(manifest, [{ op: 'splitAudioEffect', id: 'a', atMs: 2000, newId: 'a' }])).toThrow(/audio effect id "a" is already on this post$/);
  });

  it('puts a copy straight after a layer, shortened to the room there is', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 3000), add('c', 4000, 5000)]);
    expect(windows(applyEditOps(manifest, [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }]))).toEqual(['a@1000..3000', 'b@3000..4000', 'c@4000..5000']);
    expect(windows(applyEditOps(manifest, [{ op: 'duplicateAudioEffect', id: 'c', newId: 'd' }]))).toEqual(['a@1000..3000', 'c@4000..5000', 'd@5000..6000']);
    const toned = applyEditOps(manifest, [patch('a', { effectSettings: { tone: 10 } }), { op: 'duplicateAudioEffect', id: 'a', newId: 'b' }]);
    expect(layerOf(toned, 'b')?.effectSettings).toEqual({ tone: 10 });
  });

  it('refuses a copy with no room after the layer, naming what is in the way', () => {
    const tight = applyEditOps(post(), [add('a', 1000, 3000), add('c', 3000, 5000)]);
    expect(() => applyEditOps(tight, [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }])).toThrow(
      /^op 0 \(duplicateAudioEffect\): there is no room for a copy right after audio effect "a", at 3000ms - "c" runs 3000ms\.\.5000ms there, and one audio effect is heard at a time$/,
    );
    expect(() => applyEditOps(applyEditOps(post(), [add('a', 18_000)]), [{ op: 'duplicateAudioEffect', id: 'a', newId: 'b' }])).toThrow(
      /at 20000ms - the post ends at 20000ms, and a layer runs at least 100ms$/,
    );
    expect(() => applyEditOps(tight, [{ op: 'duplicateAudioEffect', id: 'a', newId: 'c' }])).toThrow(/audio effect id "c" is already on this post$/);
  });

  it('removes a layer, and the key with the last one', () => {
    const manifest = applyEditOps(post(), [add('a', 1000, 3000), add('b', 4000, 5000)]);
    expect(windows(applyEditOps(manifest, [{ op: 'removeAudioEffect', id: 'a' }]))).toEqual(['b@4000..5000']);
    expect('audioEffects' in applyEditOps(manifest, [{ op: 'removeAudioEffect', id: 'a' }, { op: 'removeAudioEffect', id: 'b' }])).toBe(false);
  });

  it('refuses an id the post has not got on every op, listing the ones it has', () => {
    const manifest = applyEditOps(post(), [add('a', 0, 1000), add('b', 2000, 3000)]);
    for (const op of [
      patch('zz', { effect: 'megaphone' }),
      { op: 'splitAudioEffect', id: 'zz', atMs: 500, newId: 'y' },
      { op: 'duplicateAudioEffect', id: 'zz', newId: 'y' },
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
      applyEditOps(before, [
        { op: 'splitAudioEffect', id: 'a', atMs: 2000, newId: 'a2' },
        { op: 'removeAudioEffect', id: 'a' },
        patch('a2', { effect: 'echo' }),
      ]),
    ).toThrow(/^op 2 \(patchAudioEffect\)/);
    expect(JSON.stringify(before)).toBe(snapshot);
  });
});

describe('what an agent reads about the audio effects', () => {
  it('lists every layer in time order in the summary, each with its sliders, and slow + reverb with its speed', () => {
    const manifest = applyEditOps(post(), [
      { op: 'addAudioEffect', id: 'slow', effect: 'slowReverb', startMs: 4000, endMs: 9000, effectSettings: { room: 80 } },
      add('loud', 1000, 3000, { effectSettings: { intensity: 80 } }),
    ]);
    expect(summariseManifest(manifest)).toContain(
      '\nVoiceover: none\n' +
        'Audio effects: 2 layers (everything heard inside one goes through its effect - clips, lanes and voiceover alike; one at a time)\n' +
        '  "loud" 1000ms (0:01.0)..3000ms (0:03.0), megaphone (effect "megaphone"; intensity 80, tone 50)\n' +
        '  "slow" 4000ms (0:04.0)..9000ms (0:09.0), slow + reverb (effect "slowReverb"; speed 0.8, reverb 50, room 80), ' +
        'playing what it covers at 0.8x as a record plays it, lower as well as slower\n\n',
    );
    expect(summariseManifest(post())).toMatch(/\nVoiceover: none\nAudio effects: none\n/);
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
      ],
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/^Audio effects \(addAudioEffect effect\), each a layer over a window of the post .* at most 50 on a post, each at least 100ms:\n/);
    expect(text).toContain('\n  megaphone (Megaphone) - sliders (effectSettings) intensity 0..100, default 50; tone 0..100, default 50');
    expect(text).toContain(
      "\n  slowReverb (Slow + reverb) - speed (the sheet's Slow) 0.5..1, default 0.8; sliders (effectSettings) reverb 0..100, default 50; room 0..100, default 50",
    );
    // In the whole catalogue too, and in its limits.
    expect(Object.keys(catalog.run({}).structuredContent ?? {})).toContain('audioEffects');
    const limits = catalog.run({ section: 'limits' });
    expect((limits.structuredContent as { limits: Record<string, unknown> }).limits['maxAudioEffects']).toBe(MAX_AUDIO_EFFECTS);
    expect(limits.content[0]?.text).toContain('at most 50 audio effects, one heard at a time, each at least 100ms');
  });

  it('tells an agent in the op reference what each effect is, what it takes, and what is shortened or refused', () => {
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/megaphone \{intensity \(default 50\), tone \(default 50\)\}, slowReverb \{reverb \(default 50\), room \(default 50\)\}/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/speed is for an effect that slows - slowReverb 0\.5\.\.1, default 0\.8 - and refused for any other/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/shortened to the room before the next layer and the end of the post, and refused when less than 100ms fits/);
    expect(OP_REFERENCE['addAudioEffect']).toMatch(/put a layer over just that word/);
    expect(OP_REFERENCE['patchAudioEffect']).toMatch(/would overlap one or pass it is refused naming it/);
    expect(OP_REFERENCE['patchAudioEffect']).toMatch(/one running past the end of the post ends there/);
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
    expect(validated.content[0]?.text).toContain('\n  "afx-sound-0" 1000ms (0:01.0)..6000ms (0:06.0), megaphone (effect "megaphone"; intensity 80, tone 50)');

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
