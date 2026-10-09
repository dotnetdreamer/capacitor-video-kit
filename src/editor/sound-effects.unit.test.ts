import { describe, expect, it } from 'vitest';

import { MAX_SOUND_OPS, type ComposeSoundEffect } from '../video-composer/definitions';

import { SOUND_EFFECTS, SoundEffectError, SoundEffectRunner, normaliseSoundEffect, normaliseSoundEffectId, soundEffectPreset } from './sound-effects';

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
  it('offers the megaphone first', () => {
    expect(SOUND_EFFECTS.map(preset => preset.id)).toEqual(['megaphone']);
    expect(soundEffectPreset('megaphone')?.label).toBe('Megaphone');
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
  });

  it('keeps an id only when this version can play it', () => {
    expect(normaliseSoundEffectId('megaphone')).toBe('megaphone');
    for (const other of ['none', 'echo', '', 'Megaphone', 42, null, undefined, {}]) expect(normaliseSoundEffectId(other)).toBeUndefined();
    expect(soundEffectPreset('toString')).toBeNull();
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
    expect(refusal({ ops: [{ op: 'reverb' }] })).toBe('ops[0].op');
    expect(refusal({ ops: [{ op: 'toString' }] })).toBe('ops[0].op');
    expect(refusal({ ops: [{ op: 'gain', db: 1 }, { op: 'lowpass', q: 1 }] })).toBe('ops[1].hz');
    expect(refusal({ ops: [{ op: 'lowpass', hz: Number.NaN, q: 1 }] })).toBe('ops[0].hz');
    expect(refusal({ ops: [{ op: 'peak', hz: 1000, q: 1 }] })).toBe('ops[0].db');
    expect(refusal({ ops: [{ op: 'drive', db: 6, followMs: 'slow' }] })).toBe('ops[0].followMs');
    expect(refusal({ ops: [{ op: 'gain', db: 1, hz: 10 }] })).toBe('ops[0].hz');
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
