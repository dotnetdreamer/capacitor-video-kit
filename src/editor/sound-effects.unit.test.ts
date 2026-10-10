import { describe, expect, it } from 'vitest';

import { MAX_SOUND_OPS, type ComposeSoundEffect } from '../video-composer/definitions';

import {
  SOUND_EFFECTS,
  SOUND_EFFECT_SETTING_MAX,
  PITCH_FRAME_MS,
  SoundEffectError,
  SoundEffectRunner,
  normaliseSoundEffect,
  normaliseSoundEffectId,
  normaliseSoundEffectSettings,
  pitchFrame,
  sameSoundEffectSettings,
  soundEffectPreset,
  soundEffectSettings,
  soundEffectSteps,
} from './sound-effects';

/*
 * A sound's effect: the steps the wire carries and the arithmetic every engine runs on them. The
 * TypeScript here is the reference - the web render and the preview's copy run it - and the golden
 * numbers at the end are asserted again, to the same tolerance, by the Kotlin and Swift tests.
 */

const RATE = 48_000;

const megaphone = (): ComposeSoundEffect => soundEffectPreset('megaphone')!.effect;

function sine(hz: number, amplitude: number, seconds: number, rate = RATE): Float32Array {
  const out = new Float32Array(Math.round(seconds * rate));
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / rate);
  return out;
}

/** Root mean square of the stretch from `from`, past the moment the filters take to settle. */
function rms(samples: Float32Array, from = Math.round(0.1 * RATE)): number {
  let sum = 0;
  for (let i = from; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2;
  return Math.sqrt(sum / Math.max(1, samples.length - from));
}

const db = (ratio: number): number => 20 * Math.log10(ratio);

function through(effect: ComposeSoundEffect, ...channels: Float32Array[]): Float32Array[] {
  const copies = channels.map(channel => channel.slice());
  new SoundEffectRunner(effect, RATE).process(copies);
  return copies;
}

function refusal(value: unknown): string {
  try {
    normaliseSoundEffect(value);
  } catch (error) {
    if (error instanceof SoundEffectError) return error.field + error.detail;
    throw error;
  }
  return 'accepted';
}

describe('the catalogue', () => {
  it('offers the megaphone first, then slow + reverb, the two voices and the telephone', () => {
    expect(SOUND_EFFECTS.map(preset => preset.id)).toEqual(['megaphone', 'slowReverb', 'maleVoice', 'femaleVoice', 'telephone']);
    expect(SOUND_EFFECTS.map(preset => preset.label)).toEqual(['Megaphone', 'Slow + reverb', 'Male voice', 'Female voice', 'Telephone']);
  });

  it('is wire data every engine takes as it is', () => {
    for (const preset of SOUND_EFFECTS) expect(normaliseSoundEffect(preset.effect)).toEqual(preset.effect);
  });

  it('cannot be changed in place, so no post changes an effect for the posts after it', () => {
    const step = megaphone().ops[0] as { hz: number };
    expect(Object.isFrozen(step)).toBe(true);
    expect(() => {
      step.hz = 20;
    }).toThrow();
    expect(Object.isFrozen(soundEffectPreset('slowReverb')!.controls[0])).toBe(true);
  });

  it('keeps an id only when this version can play it', () => {
    expect(normaliseSoundEffectId('megaphone')).toBe('megaphone');
    expect(normaliseSoundEffectId('slowReverb')).toBe('slowReverb');
    for (const other of ['none', 'echo', '', 'Megaphone', 42, null, undefined, {}]) expect(normaliseSoundEffectId(other)).toBeUndefined();
    expect(soundEffectPreset('toString')).toBeNull();
  });

  it('gives every slider a key of its own, a name for the undo step and a default on its scale', () => {
    for (const preset of SOUND_EFFECTS) {
      const keys = preset.controls.map(control => control.key);
      expect(new Set(keys).size).toBe(keys.length);
      for (const control of preset.controls) {
        expect(control.label).toMatch(/\S/);
        expect(control.name).toMatch(/\S/);
        expect(Number.isInteger(control.default)).toBe(true);
        expect(control.default).toBeGreaterThanOrEqual(0);
        expect(control.default).toBeLessThanOrEqual(SOUND_EFFECT_SETTING_MAX);
      }
    }
  });

  it('puts every effect on the wire at every corner of its sliders', () => {
    // A slider pushed to either end is still an effect each engine plays, held to nothing.
    for (const preset of SOUND_EFFECTS) {
      for (const at of [0, SOUND_EFFECT_SETTING_MAX]) {
        const settings = Object.fromEntries(preset.controls.map(control => [control.key, at]));
        const steps = soundEffectSteps(preset.id, settings)!;
        expect(normaliseSoundEffect(steps)).toEqual(steps);
      }
    }
  });

  /*
   * A megaphone put on a sound before the sliders existed is stored as the id alone, and has to sound
   * exactly as it did: these are the steps that shipped, number for number.
   */
  it('makes the megaphone that shipped at the middle of its sliders', () => {
    expect(megaphone()).toEqual({
      mono: true,
      ops: [
        { op: 'highpass', hz: 600, q: Math.SQRT1_2 },
        { op: 'highpass', hz: 600, q: Math.SQRT1_2 },
        { op: 'lowpass', hz: 5000, q: Math.SQRT1_2 },
        { op: 'peak', hz: 1800, q: 1, db: 6 },
        { op: 'drive', db: 20, followMs: 300 },
        { op: 'lowpass', hz: 3500, q: Math.SQRT1_2 },
        { op: 'lowpass', hz: 3500, q: Math.SQRT1_2 },
        { op: 'gain', db: -4 },
      ],
    });
    expect(soundEffectSteps('megaphone')).toEqual(megaphone());
    expect(soundEffectSteps('megaphone', { intensity: 50, tone: 50 })).toEqual(megaphone());
  });
});

describe('the settings', () => {
  it('keeps a value for each slider moved off its default, on the scale and in whole steps', () => {
    expect(normaliseSoundEffectSettings('megaphone', { intensity: 80 })).toEqual({ intensity: 80 });
    expect(normaliseSoundEffectSettings('megaphone', { intensity: 79.6, tone: -20 })).toEqual({ intensity: 80, tone: 0 });
    expect(normaliseSoundEffectSettings('megaphone', { tone: 250 })).toEqual({ tone: SOUND_EFFECT_SETTING_MAX });
    // In the effect's own order, whatever order they came in, so two equal settings are stored alike.
    expect(Object.keys(normaliseSoundEffectSettings('megaphone', { tone: 10, intensity: 90 })!)).toEqual(['intensity', 'tone']);
  });

  it('stores nothing for sliders at their defaults, as the sound before it had any', () => {
    expect(normaliseSoundEffectSettings('megaphone', { intensity: 50, tone: 50 })).toBeUndefined();
    expect(normaliseSoundEffectSettings('megaphone', { intensity: 50.2 })).toBeUndefined();
    expect(normaliseSoundEffectSettings('megaphone', {})).toBeUndefined();
  });

  it('drops what the effect has no slider for, and everything for an effect it does not know', () => {
    expect(normaliseSoundEffectSettings('megaphone', { intensity: 70, room: 10, toString: 3 })).toEqual({ intensity: 70 });
    expect(normaliseSoundEffectSettings('megaphone', { intensity: '70', tone: Number.NaN })).toBeUndefined();
    expect(normaliseSoundEffectSettings('echo', { intensity: 70 })).toBeUndefined();
    expect(normaliseSoundEffectSettings(undefined, { intensity: 70 })).toBeUndefined();
    expect(normaliseSoundEffectSettings('megaphone', [70])).toBeUndefined();
    expect(normaliseSoundEffectSettings('megaphone', null)).toBeUndefined();
  });

  it('reads every slider where a sound leaves it, the defaults filling the rest', () => {
    expect(soundEffectSettings('slowReverb', { room: 90 })).toEqual({ reverb: 50, room: 90 });
    expect(soundEffectSettings('slowReverb', undefined)).toEqual({ reverb: 50, room: 50 });
    expect(soundEffectSettings('echo', { room: 90 })).toEqual({});
  });

  it('tells two sounds’ settings apart by value, a missing one being the default', () => {
    expect(sameSoundEffectSettings(undefined, undefined)).toBe(true);
    expect(sameSoundEffectSettings({ room: 90 }, { room: 90 })).toBe(true);
    expect(sameSoundEffectSettings({ room: 90 }, undefined)).toBe(false);
    expect(sameSoundEffectSettings({ room: 90 }, { room: 91 })).toBe(false);
  });

  it('builds a new effect every time, so a spec can be changed without changing the catalogue', () => {
    const a = soundEffectSteps('megaphone', { intensity: 90 })!;
    const b = soundEffectSteps('megaphone', { intensity: 90 })!;
    expect(a).toEqual(b);
    expect(a).not.toBe(b);
    expect(Object.isFrozen(a.ops[0])).toBe(false);
    expect(soundEffectSteps('echo')).toBeNull();
    expect(soundEffectSteps(undefined)).toBeNull();
  });

  it('knows which effects slow what their layer covers, and how far', () => {
    expect(soundEffectPreset('slowReverb')!.speed).toMatchObject({ label: 'Slow', name: 'Slow speed', default: 0.8, min: 0.5, max: 1 });
    expect(soundEffectPreset('megaphone')!.speed).toBeUndefined();
    const speed = soundEffectPreset('slowReverb')!.speed!;
    expect(speed.default).toBeGreaterThanOrEqual(speed.min);
    expect(speed.default).toBeLessThan(speed.max);
  });
});

describe('the parser', () => {
  it('reads nothing at all as no effect, and an effect that does nothing as none', () => {
    expect(normaliseSoundEffect(undefined)).toBeNull();
    expect(normaliseSoundEffect(null)).toBeNull();
    expect(normaliseSoundEffect({})).toBeNull();
    expect(normaliseSoundEffect({ ops: [] })).toBeNull();
    expect(normaliseSoundEffect({ mono: false, ops: null })).toBeNull();
    // A fold on its own is something: a stereo sound comes out of both speakers alike.
    expect(normaliseSoundEffect({ mono: true })).toEqual({ mono: true, ops: [] });
  });

  it('refuses a shape no engine could play, naming where', () => {
    expect(refusal('megaphone')).toBe('');
    expect(refusal([])).toBe('');
    expect(refusal({ mono: 'yes', ops: [] })).toBe('mono');
    expect(refusal({ ops: {} })).toBe('ops');
    expect(refusal({ ops: [], wet: 0.5 })).toBe('wet');
    // The alphabetically first of several, as Android and iOS name it: iOS reads no order of its own.
    expect(refusal({ zeta: 1, ops: [], alpha: 2 })).toBe('alpha');
    expect(refusal({ ops: [{ op: 'gain', db: 1, zeta: 1, beta: 2 }] })).toBe('ops[0].beta');
    expect(refusal({ ops: [7] })).toBe('ops[0]');
    expect(refusal({ ops: [{ op: 'echo' }] })).toBe('ops[0].op');
    expect(refusal({ ops: [{ op: 'toString' }] })).toBe('ops[0].op');
    expect(refusal({ ops: [{ op: 'reverb', decayMs: 1000 }] })).toBe('ops[0].dampHz');
    expect(refusal({ ops: [{ op: 'reverb', decayMs: 1000, dampHz: 5000, wet: 0.5 }] })).toBe('ops[0].dry');
    expect(refusal({ ops: [{ op: 'reverb', decayMs: 1000, dampHz: 5000, wet: 0.5, dry: 1, size: 2 }] })).toBe('ops[0].size');
    expect(refusal({ ops: [{ op: 'gain', db: 1 }, { op: 'lowpass', q: 1 }] })).toBe('ops[1].hz');
    expect(refusal({ ops: [{ op: 'lowpass', hz: Number.NaN, q: 1 }] })).toBe('ops[0].hz');
    expect(refusal({ ops: [{ op: 'peak', hz: 1000, q: 1 }] })).toBe('ops[0].db');
    expect(refusal({ ops: [{ op: 'drive', db: 6, followMs: 'slow' }] })).toBe('ops[0].followMs');
    expect(refusal({ ops: [{ op: 'gain', db: 1, hz: 10 }] })).toBe('ops[0].hz');
    expect(refusal({ ops: [{ op: 'pitch', formant: 2 }] })).toBe('ops[0].semitones');
    expect(refusal({ ops: [{ op: 'pitch', semitones: -6 }] })).toBe('ops[0].formant');
    expect(refusal({ ops: [{ op: 'pitch', semitones: -6, formant: 0, ratio: 2 }] })).toBe('ops[0].ratio');
    expect(refusal({ ops: Array.from({ length: MAX_SOUND_OPS + 1 }, () => ({ op: 'gain', db: 0 })) })).toBe(`ops at most ${MAX_SOUND_OPS} steps`);
    expect(refusal({ ops: Array.from({ length: MAX_SOUND_OPS }, () => ({ op: 'gain', db: 0 })) })).toBe('accepted');
  });

  it('checks in the order the native parsers do', () => {
    // `mono` before `ops`, `ops` before the unknown keys, the count before the steps.
    expect(refusal({ mono: 1, ops: 1, extra: 1 })).toBe('mono');
    expect(refusal({ ops: 1, extra: 1 })).toBe('ops');
    expect(refusal({ ops: [{ op: 'nope' }], extra: 1 })).toBe('extra');
    expect(refusal({ ops: [...Array.from({ length: MAX_SOUND_OPS }, () => ({ op: 'gain', db: 0 })), { op: 'nope' }] })).toBe(`ops at most ${MAX_SOUND_OPS} steps`);
    // Within a step: its op, its numbers in order, then its unknown keys.
    expect(refusal({ ops: [{ op: 'peak', extra: 1 }] })).toBe('ops[0].hz');
    expect(refusal({ ops: [{ op: 'peak', hz: 1, q: 'x', extra: 1 }] })).toBe('ops[0].q');
  });

  it('holds every number to its range rather than refusing it', () => {
    expect(
      normaliseSoundEffect({
        ops: [
          { op: 'highpass', hz: 1, q: 0 },
          { op: 'lowpass', hz: 96_000, q: 50 },
          { op: 'peak', hz: 1000, q: 1, db: -99 },
          { op: 'drive', db: 99, followMs: 0 },
          { op: 'drive', db: -3 },
          { op: 'gain', db: 60 },
          { op: 'reverb', decayMs: 5, dampHz: 99_999, wet: 2, dry: -1 },
          { op: 'pitch', semitones: 30, formant: -40 },
        ],
      }),
    ).toEqual({
      ops: [
        { op: 'highpass', hz: 10, q: 0.1 },
        { op: 'lowpass', hz: 20_000, q: 10 },
        { op: 'peak', hz: 1000, q: 1, db: -24 },
        { op: 'drive', db: 40, followMs: 1 },
        { op: 'drive', db: 0 },
        { op: 'gain', db: 24 },
        { op: 'reverb', decayMs: 100, dampHz: 20_000, wet: 1, dry: 0 },
        { op: 'pitch', semitones: 12, formant: -12 },
      ],
    });
  });

  it('hands back a new object, so a caller still editing its spec cannot change a render', () => {
    const asked = { mono: true, ops: [{ op: 'gain' as const, db: -6 }] };
    const read = normaliseSoundEffect(asked)!;
    asked.ops[0]!.db = 6;
    expect(read.ops[0]).toEqual({ op: 'gain', db: -6 });
  });
});

describe('the arithmetic', () => {
  it('multiplies by a gain in decibels', () => {
    const [out] = through({ ops: [{ op: 'gain', db: -6 }] }, Float32Array.of(0.5, -1, 0.25));
    expect(Array.from(out!)).toEqual([0.5, -1, 0.25].map(v => Math.fround(v * Math.pow(10, -6 / 20))));
  });

  it('clips softly with a plain drive, and never past full scale', () => {
    const [out] = through({ ops: [{ op: 'drive', db: 12 }] }, Float32Array.of(0, 0.1, 0.5, -0.9));
    const g = Math.pow(10, 12 / 20);
    expect(Array.from(out!)).toEqual([0, 0.1, 0.5, -0.9].map(v => Math.fround(Math.tanh(g * v))));
    const [held] = through({ ops: [{ op: 'gain', db: 24 }] }, Float32Array.of(0.5, -0.5));
    expect(Array.from(held!)).toEqual([1, -1]);
  });

  it('passes what a low-pass is for and takes away what it is not', () => {
    const effect: ComposeSoundEffect = { ops: [{ op: 'lowpass', hz: 1000, q: Math.SQRT1_2 }] };
    expect(db(rms(through(effect, sine(100, 0.5, 0.5))[0]!) / rms(sine(100, 0.5, 0.5)))).toBeCloseTo(0, 1);
    // A second-order filter is 40 dB down a decade above its corner.
    expect(db(rms(through(effect, sine(10_000, 0.5, 0.5))[0]!) / rms(sine(10_000, 0.5, 0.5)))).toBeLessThan(-38);
    // And at the corner itself a Butterworth is 3 dB down.
    expect(db(rms(through(effect, sine(1000, 0.5, 0.5))[0]!) / rms(sine(1000, 0.5, 0.5)))).toBeCloseTo(-3, 0);
  });

  it('does the same the other way round with a high-pass', () => {
    const effect: ComposeSoundEffect = { ops: [{ op: 'highpass', hz: 1000, q: Math.SQRT1_2 }] };
    expect(db(rms(through(effect, sine(10_000, 0.5, 0.5))[0]!) / rms(sine(10_000, 0.5, 0.5)))).toBeCloseTo(0, 1);
    expect(db(rms(through(effect, sine(100, 0.5, 0.5))[0]!) / rms(sine(100, 0.5, 0.5)))).toBeLessThan(-38);
  });

  it('lifts a peak by its gain at its frequency and leaves the rest alone', () => {
    const effect: ComposeSoundEffect = { ops: [{ op: 'peak', hz: 1800, q: 1, db: 6 }] };
    expect(db(rms(through(effect, sine(1800, 0.25, 0.5))[0]!) / rms(sine(1800, 0.25, 0.5)))).toBeCloseTo(6, 1);
    expect(db(rms(through(effect, sine(100, 0.25, 0.5))[0]!) / rms(sine(100, 0.25, 0.5)))).toBeCloseTo(0, 0);
  });

  it('keeps a filter stable when its frequency is past what the rate can hold', () => {
    const effect: ComposeSoundEffect = { ops: [{ op: 'lowpass', hz: 20_000, q: Math.SQRT1_2 }] };
    const input = sine(1000, 0.5, 1, 8000);
    const out = input.slice();
    new SoundEffectRunner(effect, 8000).process([out]);
    expect(out.every(v => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
    // Held to 3.6 kHz, a 1 kHz tone goes through it.
    expect(rms(out, 800) / rms(input, 800)).toBeGreaterThan(0.9);
  });

  it('drives a quiet sound as hard as a loud one when the drive follows its level', () => {
    // Above the floor every step is linear but the drive, and the drive is measured against the
    // sound's own peak - so the whole effect scales with its input, the buzz with it.
    // A sixteenth is exact in a float, so the two inputs are the same sound at two levels.
    const loud = sine(440, 0.8, 0.5);
    const quiet = loud.map(v => v / 16);
    const [a] = through(megaphone(), loud);
    const [b] = through(megaphone(), quiet);
    // Past the first instants, while the level climbs out of the floor faster for the louder one.
    let worst = 0;
    for (let i = RATE / 50; i < a!.length; i++) worst = Math.max(worst, Math.abs(a![i]! / 16 - b![i]!));
    expect(worst).toBeLessThan(1e-7);
  });

  it('folds the channels into one and plays it from both', () => {
    const left = sine(440, 0.5, 0.2);
    const right = sine(660, 0.3, 0.2);
    const [l, r] = through(megaphone(), left, right);
    const mean = left.map((v, i) => (v + right[i]!) / 2);
    const [m] = through(megaphone(), mean);
    expect(Array.from(l!)).toEqual(Array.from(r!));
    for (let i = 0; i < m!.length; i += 97) expect(l![i]).toBeCloseTo(m![i]!, 6);
  });

  it('runs every channel apart when it does not fold', () => {
    const effect: ComposeSoundEffect = { ops: [{ op: 'lowpass', hz: 500, q: 1 }, { op: 'drive', db: 6 }] };
    const [l, r] = through(effect, sine(440, 0.5, 0.2), sine(2000, 0.5, 0.2));
    const [alone] = through(effect, sine(2000, 0.5, 0.2));
    expect(Array.from(r!)).toEqual(Array.from(alone!));
    expect(Array.from(l!)).not.toEqual(Array.from(r!));
  });

  it('comes out the same handed over in pieces as in one', () => {
    const input = sine(330, 0.7, 0.3);
    const [whole] = through(megaphone(), input);
    const pieces = input.slice();
    const runner = new SoundEffectRunner(megaphone(), RATE);
    for (const [from, count] of [
      [0, 1000],
      [1000, 1],
      [1001, 5000],
      [6001, pieces.length - 6001],
    ] as const) {
      runner.process([pieces], from, count);
    }
    expect(Array.from(pieces)).toEqual(Array.from(whole!));
  });

  it('leaves silence silent, and comes back to exact silence after a sound', () => {
    const [silent] = through(megaphone(), new Float32Array(4800));
    expect(silent!.every(v => v === 0)).toBe(true);
    const burst = new Float32Array(3 * RATE);
    burst.set(sine(500, 0.9, 0.1));
    const [after] = through(megaphone(), burst);
    // The filters ring down and their state is let go under 1e-20, rather than running on denormals.
    expect(after!.subarray(after!.length - RATE).every(v => v === 0)).toBe(true);
  });
});

describe('the megaphone', () => {
  const level = (hz: number): number => db(rms(through(megaphone(), sine(hz, 0.3, 0.6))[0]!) / rms(sine(hz, 0.3, 0.6)));

  it('is the middle of the voice, and little of either end', () => {
    const middle = level(1800);
    expect(middle).toBeGreaterThan(-6);
    expect(level(150) - middle).toBeLessThan(-30);
    expect(level(300) - middle).toBeLessThan(-18);
    expect(level(9000) - middle).toBeLessThan(-30);
  });

  it('buzzes: a pure tone comes out with harmonics the tone did not have', () => {
    // 600 Hz in, measured at its third harmonic, which the filters alone would never make.
    const [out] = through(megaphone(), sine(600, 0.5, 0.5));
    const at = (hz: number): number => {
      let re = 0;
      let im = 0;
      for (let i = RATE / 10; i < out!.length; i++) {
        re += out![i]! * Math.cos((2 * Math.PI * hz * i) / RATE);
        im += out![i]! * Math.sin((2 * Math.PI * hz * i) / RATE);
      }
      return Math.hypot(re, im);
    };
    expect(db(at(1800) / at(600))).toBeGreaterThan(-20);
  });

  it('peaks well under a voice it was given, so a treated word cannot clip the mix', () => {
    // A voice's own peaks are in its low harmonics, which the horn does not pass: a 140 Hz buzz with
    // every harmonic at 1/k^2 - the 12 dB an octave a glottal pulse falls by - at 0.95.
    const voice = new Float32Array(RATE / 2);
    for (let k = 1; k <= 40; k++) {
      for (let i = 0; i < voice.length; i++) voice[i] = voice[i]! + Math.sin((2 * Math.PI * 140 * k * i) / RATE) / (k * k);
    }
    const most = voice.reduce((peak, v) => Math.max(peak, Math.abs(v)), 0);
    for (let i = 0; i < voice.length; i++) voice[i] = (voice[i]! * 0.95) / most;
    const [out] = through(megaphone(), voice);
    const peak = out!.reduce((top, v) => Math.max(top, Math.abs(v)), 0);
    expect(db(peak / 0.95)).toBeLessThan(-3);
  });

  it('holds a tone on its presence peak to full scale rather than past it', () => {
    const [out] = through(megaphone(), sine(1800, 0.95, 0.3));
    expect(out!.every(v => Math.abs(v) <= 1)).toBe(true);
  });

  /*
   * The same numbers as `SoundEffectsTest.kt` and `SoundEffectTests.swift`: a stereo fragment at 48
   * kHz, each sample rounded to a float as every engine reads one, through the megaphone. A change
   * to the arithmetic here is a change to all three engines, and has to be made to all three tests.
   */
  it('matches the golden numbers every engine is held to', () => {
    const n = 2400;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 0.2 * Math.sin((2 * Math.PI * 3100 * i) / RATE);
      right[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE + 0.5);
    }
    new SoundEffectRunner(megaphone(), RATE).process([left, right]);
    const golden: [number, number][] = [
      [0, 0.000004868781616096385],
      [1, 0.00005642078031087294],
      [2, 0.0003210754366591573],
      [3, 0.001207839697599411],
      [50, -0.10473176091909409],
      [100, -0.055209930986166],
      [480, 0.03146327659487724],
      [1000, -0.03916871175169945],
      [1500, 0.11145441234111786],
      [2399, 0.043290454894304276],
    ];
    for (const [i, value] of golden) {
      expect(left[i]).toBeCloseTo(value, 6);
      expect(right[i]).toBe(left[i]);
    }
  });
});

describe('the megaphone’s sliders', () => {
  const at = (settings: Record<string, number>) => soundEffectSteps('megaphone', settings)!;
  const drive = (settings: Record<string, number>) => (at(settings).ops[4] as { db: number }).db;
  const corner = (settings: Record<string, number>) => (at(settings).ops[0] as { hz: number }).hz;

  it('drives harder with Intensity, from none at all to the most a drive takes', () => {
    expect(drive({ intensity: 0 })).toBe(0);
    expect(drive({ intensity: 50 })).toBe(20);
    expect(drive({ intensity: SOUND_EFFECT_SETTING_MAX })).toBe(40);
  });

  it('buzzes more with Intensity without coming out much louder', () => {
    // A 140 Hz buzz with every harmonic at 1/k^2, the voice the peak test above uses.
    const voice = new Float32Array(RATE / 2);
    for (let k = 1; k <= 40; k++) for (let i = 0; i < voice.length; i++) voice[i] = voice[i]! + (0.4 * Math.sin((2 * Math.PI * 140 * k * i) / RATE)) / (k * k);
    const middle = rms(through(at({ intensity: 50 }), voice)[0]!);
    const hard = rms(through(at({ intensity: SOUND_EFFECT_SETTING_MAX }), voice)[0]!);
    expect(Math.abs(db(hard / middle))).toBeLessThan(2);
  });

  it('moves the whole horn with Tone, by up to 0.6 of an octave either way', () => {
    expect(corner({ tone: 50 })).toBe(600);
    expect(corner({ tone: 0 })).toBe(Math.round(600 * Math.pow(2, -0.6)));
    expect(corner({ tone: SOUND_EFFECT_SETTING_MAX })).toBe(Math.round(600 * Math.pow(2, 0.6)));
    // Every corner and the honk together, so the horn changes size rather than shape.
    const corners = (at({ tone: 0 }).ops as { hz?: number }[]).flatMap(step => (step.hz === undefined ? [] : [step.hz]));
    expect(corners).toEqual([600, 600, 5000, 1800, 3500, 3500].map(hz => Math.round(hz * Math.pow(2, -0.6))));
  });
});

describe('the reverb', () => {
  const room = (overrides: Partial<{ decayMs: number; dampHz: number; wet: number; dry: number }> = {}): ComposeSoundEffect => ({
    ops: [{ op: 'reverb', decayMs: 2000, dampHz: 6000, wet: 1, dry: 0, ...overrides }],
  });

  it('is the dry sound alone until the first comb’s delay has passed', () => {
    const input = sine(440, 0.5, 0.05);
    const [out] = through(room({ wet: 0.7, dry: 0.6 }), input);
    // 1116 samples at 44.1 kHz is 1215 at 48, and the first of them is sample 0's own silence.
    for (let i = 0; i <= 1215; i++) expect(out![i]).toBe(Math.fround(0.6 * input[i]!));
    expect(out![1300]).not.toBe(Math.fround(0.6 * input[1300]!));
  });

  /** A click in every channel, `seconds` long: what a room is measured by. */
  const impulse = (seconds: number): Float32Array => {
    const out = new Float32Array(Math.round(seconds * RATE));
    out[0] = 1;
    return out;
  };

  /**
   * The same noise on every run - a linear congruential generator - with the slope of a song, most of
   * it under 1 kHz. A steady tone is a poor thing to measure a room with: it comes out as the same tone,
   * louder or quieter by where it falls among the combs' resonances.
   */
  const noise = (seconds: number, amplitude: number): Float32Array => {
    const out = new Float32Array(Math.round(seconds * RATE));
    const a = Math.exp((-2 * Math.PI * 1000) / RATE);
    let seed = 1;
    let y = 0;
    for (let i = 0; i < out.length; i++) {
      seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
      y = (1 - a) * (seed / 2 ** 31 - 1) + a * y;
      out[i] = 4 * amplitude * y;
    }
    return out;
  };

  it('rings on after the sound, falling 60 dB in about its decay', () => {
    // Measured as rooms are, by Schroeder's backward integral of the impulse response from 5 to 25 dB
    // down, times three. Damped above anything that matters, though a click's very top still dies a
    // little sooner than the rest, which is all that keeps it under the 1000 ms asked for.
    const [out] = through(room({ decayMs: 1000, dampHz: 20_000 }), impulse(3));
    const left = new Float64Array(out!.length);
    let sum = 0;
    for (let i = out!.length - 1; i >= 0; i--) left[i] = sum += out![i]! ** 2;
    const down = (dB: number) => left.findIndex(e => 10 * Math.log10(e / left[0]!) <= -dB);
    const rt60 = ((down(25) - down(5)) / RATE) * 3;
    expect(rt60).toBeGreaterThan(0.8);
    expect(rt60).toBeLessThan(1.1);
  });

  it('is about as loud as the sound at any length, so a longer room is not a louder one', () => {
    const sound = noise(3, 0.3);
    const short = rms(through(room({ decayMs: 800 }), sound)[0]!, RATE);
    const long = rms(through(room({ decayMs: 6000 }), sound)[0]!, RATE);
    expect(Math.abs(db(long / short))).toBeLessThan(2.5);
    expect(Math.abs(db(short / rms(sound, RATE)))).toBeLessThan(1.5);
  });

  it('gives each channel a tail of its own, so the room is as wide as the speakers', () => {
    const [l, r] = through(room(), impulse(1), impulse(1));
    let ab = 0;
    let aa = 0;
    let bb = 0;
    for (let i = RATE / 20; i < l!.length; i++) {
      ab += l![i]! * r![i]!;
      aa += l![i]! ** 2;
      bb += r![i]! ** 2;
    }
    expect(Math.abs(ab / Math.sqrt(aa * bb))).toBeLessThan(0.2);
  });

  it('is the first channel’s for a folded sound', () => {
    const left = sine(300, 0.5, 0.2);
    const right = sine(700, 0.3, 0.2);
    const [folded] = through({ mono: true, ...room() }, left, right);
    const [first] = through(room(), left.map((v, i) => (v + right[i]!) / 2));
    for (let i = 0; i < first!.length; i += 7) expect(folded![i]).toBeCloseTo(first![i]!, 6);
  });

  it('comes out the same handed over in pieces as in one', () => {
    const input = sine(330, 0.7, 0.2);
    const [whole] = through(room({ dry: 0.5 }), input);
    const pieces = input.slice();
    const runner = new SoundEffectRunner(room({ dry: 0.5 }), RATE);
    runner.process([pieces], 0, 1500);
    runner.process([pieces], 1500, 1);
    runner.process([pieces], 1501, pieces.length - 1501);
    expect(Array.from(pieces)).toEqual(Array.from(whole!));
  });

  it('leaves silence silent, and falls back to exact silence after a sound', () => {
    const [silent] = through(room(), new Float32Array(4800));
    expect(silent!.every(v => v === 0)).toBe(true);
    const burst = new Float32Array(9 * RATE);
    burst.set(sine(500, 0.9, 0.1));
    const [after] = through(room({ decayMs: 1000 }), burst);
    // Every value it keeps is let go under 1e-20, so the tail ends in zeros rather than denormals.
    expect(after!.subarray(after!.length - RATE).every(v => v === 0)).toBe(true);
  });

  it('stays stable at the longest room and the brightest damping', () => {
    const [out] = through(room({ decayMs: 20_000, dampHz: 20_000, wet: 1, dry: 1 }), sine(1000, 0.9, 1));
    expect(out!.every(v => Number.isFinite(v) && Math.abs(v) <= 1)).toBe(true);
  });
});

describe('slow + reverb', () => {
  const at = (settings: Record<string, number>) => soundEffectSteps('slowReverb', settings)!;

  it('is a room and nothing else, its slowing being the layer’s own Slow', () => {
    expect(at({}).ops.map(step => step.op)).toEqual(['reverb']);
    expect(at({}).mono).toBeUndefined();
    expect(soundEffectPreset('slowReverb')!.speed).toMatchObject({ default: 0.8, min: 0.5, max: 1 });
  });

  it('turns Reverb into how much of the room is heard, and Room into how long and dark it is', () => {
    expect(at({ reverb: 0 }).ops[0]).toMatchObject({ wet: 0, dry: 1 });
    expect(at({ reverb: 50 }).ops[0]).toMatchObject({ wet: 0.5, dry: 0.8 });
    expect(at({ reverb: 100 }).ops[0]).toMatchObject({ wet: 1, dry: 0.6 });
    expect(at({ room: 0 }).ops[0]).toMatchObject({ decayMs: 1000, dampHz: 8000 });
    expect(at({ room: 50 }).ops[0]).toMatchObject({ decayMs: 3500, dampHz: 5500 });
    expect(at({ room: 100 }).ops[0]).toMatchObject({ decayMs: 6000, dampHz: 3000 });
  });

  /*
   * The same numbers as `SoundEffectTest.kt` and `SoundEffectTests.swift`: the megaphone's fragment,
   * twice as long, through slow + reverb at the middle of its sliders. Not folded, so each channel has
   * a room of its own and both are held to their numbers.
   */
  it('matches the golden numbers every engine is held to', () => {
    const n = 4800;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 0.2 * Math.sin((2 * Math.PI * 3100 * i) / RATE);
      right[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE + 0.5);
    }
    expect(soundEffectPreset('slowReverb')!.effect).toEqual({ ops: [{ op: 'reverb', decayMs: 3500, dampHz: 5500, wet: 0.5, dry: 0.8 }] });
    new SoundEffectRunner(soundEffectPreset('slowReverb')!.effect, RATE).process([left, right]);
    const golden: [number, number, number][] = [
      [0, 0, 0.11506213247776031],
      [1, 0.09078975021839142, 0.1210789903998375],
      [1214, 0.4370698928833008, -0.18847058713436127],
      [1215, 0.3962092995643616, -0.19267092645168304],
      [1239, 0.39520999789237976, -0.23967154324054718],
      [1240, 0.4382869005203247, -0.2387159764766693],
      [1500, -0.5940757393836975, -0.06688307225704193],
      [2000, 0.5418930649757385, 0.23884811997413635],
      [3000, -0.2069074958562851, -0.22407972812652588],
      [4000, -0.2956431806087494, 0.14864428341388702],
      [4799, -0.1521013230085373, 0.08078738301992416],
    ];
    for (const [i, l, r] of golden) {
      expect(left[i]).toBeCloseTo(l, 6);
      expect(right[i]).toBeCloseTo(r, 6);
    }
  });
});

/** How strong `hz` is in `samples` from `from` on, as the amplitude of a sine: one bin of a DFT. */
function amplitudeAt(samples: Float32Array, hz: number, from = Math.round(0.5 * RATE)): number {
  let re = 0;
  let im = 0;
  for (let i = from; i < samples.length; i++) {
    re += samples[i]! * Math.cos((2 * Math.PI * hz * i) / RATE);
    im += samples[i]! * Math.sin((2 * Math.PI * hz * i) / RATE);
  }
  return (2 * Math.hypot(re, im)) / (samples.length - from);
}

/** A buzz at `f0` - every harmonic to 6 kHz - shaped by `shape` at each harmonic's frequency. */
function buzz(f0: number, amplitude: number, seconds: number, shape: (hz: number) => number): Float32Array {
  const out = new Float32Array(Math.round(seconds * RATE));
  for (let h = 1; h * f0 < 6000; h++) {
    const a = amplitude * shape(h * f0);
    for (let i = 0; i < out.length; i++) out[i] = out[i]! + a * Math.sin((2 * Math.PI * h * f0 * i) / RATE + h);
  }
  return out;
}

describe('the pitch step', () => {
  const pitch = (semitones: number, formant = 0): ComposeSoundEffect => ({ ops: [{ op: 'pitch', semitones, formant }] });

  it('reads a 40 ms frame every 10 ms at any rate, padded to a power of two', () => {
    expect(PITCH_FRAME_MS).toBe(40);
    expect(pitchFrame(48_000)).toEqual({ length: 1920, hop: 480, size: 2048 });
    expect(pitchFrame(44_100)).toEqual({ length: 1764, hop: 441, size: 2048 });
    expect(pitchFrame(32_000)).toEqual({ length: 1280, hop: 320, size: 2048 });
    expect(pitchFrame(22_050)).toEqual({ length: 884, hop: 221, size: 1024 });
  });

  it('gives the sound back a frame late, and otherwise as it was, when it moves nothing', () => {
    const input = sine(220, 0.3, 1).map((v, i) => v + 0.2 * Math.sin((2 * Math.PI * 1730 * i) / RATE + 1));
    const [out] = through(pitch(0), input);
    const late = pitchFrame(RATE).length - 1;
    let worst = 0;
    for (let i = 2 * late; i < input.length; i++) worst = Math.max(worst, Math.abs(out![i]! - input[i - late]!));
    // All but what the frames hold at 0 Hz, a window's leakage some 90 dB down.
    expect(worst).toBeLessThan(1e-4);
  });

  it('moves a tone by its semitones, up or down, and leaves nothing where it was', () => {
    for (const semitones of [-12, -6, 7, 12]) {
      const [out] = through(pitch(semitones), sine(440, 0.5, 1));
      // A tone alone is as loud as it was but for `sqrt(P)`, which keeps a voice's crowded harmonics as loud.
      expect(amplitudeAt(out!, 440 * Math.pow(2, semitones / 12))).toBeGreaterThan(0.3);
      expect(amplitudeAt(out!, 440)).toBeLessThan(0.01);
    }
  });

  it('moves every harmonic of a voice together, so it is still one voice', () => {
    const [out] = through(pitch(-6), buzz(210, 0.1, 1, hz => 1000 / (hz + 1000)));
    const f0 = 210 * Math.pow(2, -6 / 12);
    for (const h of [1, 2, 3, 5, 8]) {
      expect(amplitudeAt(out!, h * f0)).toBeGreaterThan(0.02);
      // Half way between two of the new harmonics there is nothing much.
      expect(amplitudeAt(out!, (h + 0.5) * f0)).toBeLessThan(0.1 * amplitudeAt(out!, h * f0));
    }
  });

  it('moves the resonance of a voice with its formant, the pitch staying where it is', () => {
    // A buzz at 200 Hz with one resonance, at 1 kHz: each harmonic comes out as loud as the resonance
    // moved half an octave is at its frequency, give or take what harmonics 200 Hz apart can say of it.
    const resonance = (hz: number) => 1 / (1 + Math.pow((hz - 1000) / 150, 2));
    for (const formant of [-6, 6]) {
      const [out] = through(pitch(0, formant), buzz(200, 0.2, 1, resonance));
      const moved = (hz: number) => resonance(hz / Math.pow(2, formant / 12));
      for (let hz = 400; hz <= 1600; hz += 200) expect(Math.abs(db(amplitudeAt(out!, hz) / 0.2 / moved(hz)))).toBeLessThan(3);
      expect(amplitudeAt(out!, 200 * Math.round(1000 / 200))).toBeLessThan(0.3 * 0.2);
    }
  });

  it('keeps a voice about as loud as it was, whichever way it moves it', () => {
    const voice = buzz(140, 0.05, 1, hz => 1000 / (hz + 500));
    for (const [semitones, formant] of [
      [-12, -6],
      [-6, -3],
      [6, 3],
      [12, 6],
    ] as const) {
      const [out] = through(pitch(semitones, formant), voice);
      expect(Math.abs(db(rms(out!, RATE / 2) / rms(voice, RATE / 2)))).toBeLessThan(2);
    }
  });

  it('comes out the same handed over in pieces as in one', () => {
    const input = sine(330, 0.7, 0.5);
    const [whole] = through(pitch(5, 2), input);
    const pieces = input.slice();
    const runner = new SoundEffectRunner(pitch(5, 2), RATE);
    for (const [from, count] of [
      [0, 479],
      [479, 1],
      [480, 5000],
      [5480, pieces.length - 5480],
    ] as const) {
      runner.process([pieces], from, count);
    }
    expect(Array.from(pieces)).toEqual(Array.from(whole!));
  });

  it('leaves silence silent, and falls back to exact silence two frames after a sound', () => {
    const [silent] = through(pitch(-6, -3), new Float32Array(4800));
    expect(silent!.every(v => v === 0)).toBe(true);
    const burst = new Float32Array(RATE);
    burst.set(sine(500, 0.9, 0.1));
    const [after] = through(pitch(5, 3), burst);
    const end = 0.1 * RATE + Math.round((2 * PITCH_FRAME_MS * RATE) / 1000);
    expect(after!.subarray(end).every(v => v === 0)).toBe(true);
    expect(after!.every(v => Math.abs(v) <= 1)).toBe(true);
  });

  it('folds the channels into one before it when the effect does', () => {
    const [l, r] = through({ mono: true, ...pitch(4) }, sine(300, 0.4, 0.3), sine(500, 0.2, 0.3));
    expect(Array.from(l!)).toEqual(Array.from(r!));
  });

  /*
   * The same numbers as `SoundEffectTest.kt` and `SoundEffectTests.swift`: the megaphone's fragment,
   * four times as long, through the male voice - folded - and through a pitch step on each channel.
   */
  it('matches the golden numbers every engine is held to', () => {
    const n = 9600;
    const fragment = (): [Float32Array, Float32Array] => {
      const left = new Float32Array(n);
      const right = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        left[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 0.2 * Math.sin((2 * Math.PI * 3100 * i) / RATE);
        right[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE + 0.5);
      }
      return [left, right];
    };
    const [left, right] = fragment();
    new SoundEffectRunner(soundEffectPreset('maleVoice')!.effect, RATE).process([left, right]);
    const male: [number, number][] = [
      [0, 0],
      [1918, -0.29614120721817017],
      [1919, -0.25232091546058655],
      [1920, -0.20355385541915894],
      [2399, 0.16940973699092865],
      [2400, 0.20098185539245605],
      [3000, 0.1624542772769928],
      [4321, -0.19919995963573456],
      [5000, -0.30933305621147156],
      [6000, 0.1856769174337387],
      [7777, -0.1872776299715042],
      [8000, 0.0756482258439064],
      [9599, -0.4480621814727783],
    ];
    for (const [i, value] of male) {
      expect(left[i]).toBeCloseTo(value, 6);
      expect(right[i]).toBe(left[i]);
    }
    const [l, r] = fragment();
    new SoundEffectRunner(pitch(7, 2), RATE).process([l, r]);
    const stereo: [number, number, number][] = [
      [0, 0, 0],
      [1918, 0.38877439498901367, -0.3224090039730072],
      [1919, 0.45995599031448364, -0.30201801657676697],
      [1920, 0.3744523227214813, -0.21382911503314972],
      [2399, -0.7527450919151306, 0.23698817193508148],
      [2400, -0.6146458387374878, 0.24650360643863678],
      [3000, 0.2789718508720398, 0.33405008912086487],
      [4321, 0.41194868087768555, 0.3025590479373932],
      [5000, -0.2085523009300232, -0.03757572919130325],
      [6000, 0.8355948328971863, -0.2713659107685089],
      [7777, -0.3335418999195099, 0.10749977827072144],
      [8000, -0.8190305233001709, -0.16935910284519196],
      [9599, -0.6935299038887024, -0.1321483850479126],
    ];
    for (const [i, a, b] of stereo) {
      expect(l[i]).toBeCloseTo(a, 6);
      expect(r[i]).toBeCloseTo(b, 6);
    }
  });
});

describe('the male and female voices', () => {
  const steps = (id: string, settings: Record<string, number> = {}) => soundEffectSteps(id, settings)!;

  it('folds the sound and moves it down for the male voice: Pitch to an octave, Tone to half of one', () => {
    expect(steps('maleVoice')).toEqual({
      mono: true,
      ops: [
        { op: 'pitch', semitones: -6, formant: -3 },
        { op: 'gain', db: 0.72 },
      ],
    });
    expect(steps('maleVoice', { pitch: 0, tone: 0 }).ops[0]).toEqual({ op: 'pitch', semitones: -12, formant: -6 });
    expect(steps('maleVoice', { pitch: 100, tone: 100 }).ops[0]).toEqual({ op: 'pitch', semitones: 0, formant: 0 });
  });

  it('folds the sound and moves it up for the female voice, as far the other way', () => {
    expect(steps('femaleVoice')).toEqual({
      mono: true,
      ops: [
        { op: 'pitch', semitones: 6, formant: 3 },
        { op: 'gain', db: 0.72 },
      ],
    });
    expect(steps('femaleVoice', { pitch: 0, tone: 0 }).ops[0]).toEqual({ op: 'pitch', semitones: 0, formant: 0 });
    expect(steps('femaleVoice', { pitch: 100, tone: 100 }).ops[0]).toEqual({ op: 'pitch', semitones: 12, formant: 6 });
  });

  it('makes up what moving a voice loses, more the further it goes', () => {
    expect(steps('maleVoice', { pitch: 0 }).ops[1]).toEqual({ op: 'gain', db: 1.44 });
    expect(steps('femaleVoice', { pitch: 0 }).ops[1]).toEqual({ op: 'gain', db: 0 });
  });

  it('puts a woman in the range of a man, and a man in the range of a woman', () => {
    // Two buzzes in the middle of each range, 210 Hz and 120 Hz, falling as a voice does.
    const slope = (hz: number) => 1000 / (hz + 1000);
    const [male] = through(soundEffectPreset('maleVoice')!.effect, buzz(210, 0.1, 1, slope));
    expect(amplitudeAt(male!, 210 * Math.pow(2, -0.5))).toBeGreaterThan(5 * amplitudeAt(male!, 210));
    const [female] = through(soundEffectPreset('femaleVoice')!.effect, buzz(120, 0.1, 1, slope));
    expect(amplitudeAt(female!, 120 * Math.pow(2, 0.5))).toBeGreaterThan(5 * amplitudeAt(female!, 120));
  });
});

describe('the telephone', () => {
  const telephone = (settings: Record<string, number> = {}) => soundEffectSteps('telephone', settings)!;
  const level = (hz: number, settings: Record<string, number> = {}): number =>
    db(rms(through(telephone(settings), sine(hz, 0.1, 0.6))[0]!) / rms(sine(hz, 0.1, 0.6)));

  it('is the band a phone line carries, 300 Hz to 3.4 kHz, and little of either side', () => {
    const ops = telephone().ops as { op: string; hz?: number }[];
    expect(ops.filter(step => step.op === 'highpass').map(step => step.hz)).toEqual([300, 300, 300]);
    expect(ops.filter(step => step.op === 'lowpass').map(step => step.hz)).toEqual([3400, 3400, 3400]);
    expect(telephone().mono).toBe(true);
    const middle = level(1000);
    expect(level(100) - middle).toBeLessThan(-30);
    expect(level(8000) - middle).toBeLessThan(-30);
    expect(level(500) - middle).toBeGreaterThan(-6);
    expect(level(2500) - middle).toBeGreaterThan(-6);
  });

  it('narrows its band and drives harder with Intensity, and moves the band with Tone', () => {
    const corners = (settings: Record<string, number>) => {
      const ops = telephone(settings).ops as { op: string; hz?: number; db?: number }[];
      return { low: ops[0]!.hz, high: ops[2]!.hz, drive: ops[4]!.db };
    };
    expect(corners({ intensity: 0 })).toEqual({ low: 198, high: 4808, drive: 0 });
    expect(corners({ intensity: 100 })).toEqual({ low: 455, high: 2404, drive: 20 });
    expect(corners({ tone: 0 })).toEqual({ low: 212, high: 2404, drive: 10 });
    expect(corners({ tone: 100 })).toEqual({ low: 424, high: 4808, drive: 10 });
  });

  it('comes out about as loud as a voice it was given, at any Intensity, and under full scale', () => {
    // A 140 Hz buzz falling 6 dB an octave above 500 Hz: most of a voice is in the band a line keeps.
    const voice = buzz(140, 0.05, 0.5, hz => 1000 / (hz + 500));
    for (const intensity of [0, 50, 100]) {
      const [out] = through(telephone({ intensity }), voice);
      expect(out!.every(v => Math.abs(v) < 1)).toBe(true);
      expect(Math.abs(db(rms(out!) / rms(voice)))).toBeLessThan(4.5);
    }
  });
});
