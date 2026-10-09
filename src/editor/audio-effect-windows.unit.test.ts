import { describe, expect, it } from 'vitest';

import { AUDIO_EFFECT_RAMP_MS, MAX_AUDIO_EFFECTS, type ComposeAudioEffect } from '../video-composer/definitions';

import { AudioEffectRunner, AudioEffectWindowError, audioEffectTailMs, frameAt, normaliseAudioEffectWindows } from './audio-effect-windows';
import { soundEffectPreset, soundEffectSteps } from './sound-effects';

/*
 * The audio effect layers' windows: the parser's rules and the arithmetic every engine runs on the
 * finished mix. The TypeScript here is the reference - the web render and the preview's copy run it -
 * and the golden numbers at the end are asserted again, to the same tolerance, by the Kotlin and Swift
 * tests.
 */

const RATE = 48_000;

function refusal(value: unknown): string {
  try {
    normaliseAudioEffectWindows(value);
  } catch (error) {
    if (error instanceof AudioEffectWindowError) return error.field + error.detail;
    throw error;
  }
  return 'accepted';
}

function tone(hz: number, amplitude: number, frames: number, phase = 0): Float32Array {
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) out[i] = amplitude * Math.sin((2 * Math.PI * hz * i) / RATE + phase);
  return out;
}

function run(windows: ComposeAudioEffect[], channels: Float32Array[], piece = Number.POSITIVE_INFINITY, firstFrame = 0): Float32Array[] {
  const copies = channels.map(channel => channel.slice());
  const runner = new AudioEffectRunner(windows, RATE, firstFrame);
  const length = copies[0]!.length;
  for (let from = 0; from < length; from += Math.min(piece, length)) runner.process(copies, from, Math.min(piece, length - from));
  return copies;
}

/** Upward zero crossings of `samples` between two frames: a tone's pitch, counted. */
function crossings(samples: Float32Array, from: number, to: number): number {
  let count = 0;
  for (let i = from + 1; i < to; i++) if (samples[i - 1]! < 0 && samples[i]! >= 0) count++;
  return count;
}

const megaphone = (): ComposeAudioEffect['effect'] => soundEffectSteps('megaphone', {})!;
const slowReverb = (): ComposeAudioEffect['effect'] => soundEffectSteps('slowReverb', {})!;

describe('the parser', () => {
  it('reads no list as no windows', () => {
    expect(normaliseAudioEffectWindows(undefined)).toEqual([]);
    expect(normaliseAudioEffectWindows(null)).toEqual([]);
    expect(normaliseAudioEffectWindows([])).toEqual([]);
  });

  it('keeps a window as it came, a speed under 1 and the steps checked', () => {
    const effect = megaphone()!;
    expect(normaliseAudioEffectWindows([{ startMs: 100, endMs: 900, effect }])).toEqual([{ startMs: 100, endMs: 900, effect }]);
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900, speed: 0.8, effect }])).toEqual([{ startMs: 0, endMs: 900, speed: 0.8, effect }]);
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900, speed: 0.7 }])).toEqual([{ startMs: 0, endMs: 900, speed: 0.7 }]);
  });

  it('clamps the start to 0 and the speed to its range, and leaves off a speed of 1', () => {
    const effect = megaphone()!;
    expect(normaliseAudioEffectWindows([{ startMs: -50, endMs: 900, effect }])).toEqual([{ startMs: 0, endMs: 900, effect }]);
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900, speed: 0.1, effect }])[0]!.speed).toBe(0.5);
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900, speed: 3, effect }])[0]).not.toHaveProperty('speed');
  });

  it('drops a window that would change nothing', () => {
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900 }])).toEqual([]);
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900, speed: 1, effect: { ops: [] } }])).toEqual([]);
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900, effect: null }])).toEqual([]);
  });

  it('refuses the shapes no engine could play, with the path that broke', () => {
    const effect = megaphone()!;
    expect(refusal({})).toBe('');
    expect(refusal('windows')).toBe('');
    expect(refusal(Array.from({ length: MAX_AUDIO_EFFECTS + 1 }, (_, i) => ({ startMs: i * 10, endMs: i * 10 + 5, effect })))).toBe(` at most ${MAX_AUDIO_EFFECTS} windows`);
    expect(refusal([null])).toBe('[0]');
    expect(refusal([[1, 2]])).toBe('[0]');
    expect(refusal([{ endMs: 900, effect }])).toBe('[0].startMs');
    expect(refusal([{ startMs: '0', endMs: 900, effect }])).toBe('[0].startMs');
    expect(refusal([{ startMs: Number.NaN, endMs: 900, effect }])).toBe('[0].startMs');
    expect(refusal([{ startMs: 0, effect }])).toBe('[0].endMs');
    expect(refusal([{ startMs: 0, endMs: Number.POSITIVE_INFINITY, effect }])).toBe('[0].endMs');
    expect(refusal([{ startMs: 500, endMs: 500, effect }])).toBe('[0].endMs');
    expect(refusal([{ startMs: 500, endMs: 400, effect }])).toBe('[0].endMs');
    // Held to 0 first, so a window from before the start to 0 has no length.
    expect(refusal([{ startMs: -500, endMs: 0, effect }])).toBe('[0].endMs');
    expect(refusal([{ startMs: 0, endMs: 900, speed: 'slow', effect }])).toBe('[0].speed');
    expect(refusal([{ startMs: 0, endMs: 900, speed: Number.NaN, effect }])).toBe('[0].speed');
    expect(refusal([{ startMs: 0, endMs: 900, effect: 'megaphone' }])).toBe('[0].effect');
    expect(refusal([{ startMs: 0, endMs: 900, effect: { ops: [{ op: 'gain', db: 'loud' }] } }])).toBe('[0].effect.ops[0].db');
    expect(refusal([{ startMs: 0, endMs: 900, effect: { ops: new Array(17).fill({ op: 'gain', db: 1 }) } }])).toBe('[0].effect.ops at most 16 steps');
    expect(refusal([{ startMs: 0, endMs: 900, effect, volume: 1, layer: 2 }])).toBe('[0].layer');
  });

  it('checks a window field by field, in the order every engine does', () => {
    const effect = megaphone()!;
    expect(refusal([{ startMs: 'a', endMs: 'b', speed: 'c', effect: 'd', zz: 1 }])).toBe('[0].startMs');
    expect(refusal([{ startMs: 0, endMs: 'b', speed: 'c', effect: 'd', zz: 1 }])).toBe('[0].endMs');
    expect(refusal([{ startMs: 0, endMs: 9, speed: 'c', effect: 'd', zz: 1 }])).toBe('[0].speed');
    expect(refusal([{ startMs: 0, endMs: 9, effect: 'd', zz: 1 }])).toBe('[0].effect');
    expect(refusal([{ startMs: 0, endMs: 9, effect, zz: 1 }])).toBe('[0].zz');
    // A window's own fields come before where it sits, and the first window that breaks is the one named.
    expect(refusal([{ startMs: 0, endMs: 900, effect }, { startMs: 800, endMs: 'b', effect }])).toBe('[1].endMs');
    expect(refusal([{ startMs: 0, endMs: 900, effect }, { startMs: 800, endMs: 1000, effect }])).toBe('[1].startMs');
    expect(refusal([{ startMs: 'a' }, { startMs: 'b' }])).toBe('[0].startMs');
  });

  it('lets one window start where the one before it ends, and orders by how they came', () => {
    const effect = megaphone()!;
    expect(normaliseAudioEffectWindows([{ startMs: 0, endMs: 900, effect }, { startMs: 900, endMs: 1000, effect }])).toHaveLength(2);
    // A window left out still holds its place: the next one may not start inside it.
    expect(refusal([{ startMs: 0, endMs: 900 }, { startMs: 800, endMs: 1000, effect }])).toBe('[1].startMs');
  });

  it('hands back new objects, so nothing that holds a spec can change it', () => {
    const effect = megaphone()!;
    const given = [{ startMs: 0, endMs: 900, effect }];
    const read = normaliseAudioEffectWindows(given);
    expect(read[0]).not.toBe(given[0]);
    expect(read[0]!.effect).not.toBe(effect);
  });
});

describe('the tail', () => {
  it('rings for twice the longest reverb, and never under half a second', () => {
    expect(audioEffectTailMs(null)).toBe(500);
    expect(audioEffectTailMs(megaphone())).toBe(500);
    expect(audioEffectTailMs(slowReverb())).toBe(7000);
    expect(audioEffectTailMs(soundEffectSteps('slowReverb', { room: 100 }))).toBe(12_000);
    expect(audioEffectTailMs({ ops: [{ op: 'reverb', decayMs: 100, dampHz: 8000, wet: 1, dry: 1 }] })).toBe(500);
  });

  it('counts frames rounding half up', () => {
    expect(frameAt(25, RATE)).toBe(1200);
    expect(frameAt(0.0104, RATE)).toBe(0);
    expect(frameAt(0.0105, RATE)).toBe(1);
    expect(frameAt(1000 / 44_100, 44_100)).toBe(1);
  });
});

describe('the arithmetic', () => {
  const quiet = (frames: number) => [tone(440, 0.5, frames), tone(660, 0.4, frames, 1)];

  it('leaves every frame outside a window and its tail exactly as it was', () => {
    const input = quiet(RATE);
    const out = run([{ startMs: 200, endMs: 300, effect: { ops: [{ op: 'gain', db: -12 }] } }], input);
    const start = frameAt(200, RATE);
    const tailEnd = frameAt(300 + 500, RATE);
    for (let c = 0; c < 2; c++) {
      expect(Array.from(out[c]!.subarray(0, start))).toEqual(Array.from(input[c]!.subarray(0, start)));
      expect(Array.from(out[c]!.subarray(tailEnd))).toEqual(Array.from(input[c]!.subarray(tailEnd)));
    }
  });

  it('comes in and goes out over the ramp, so the window starts and ends where the mix is', () => {
    const frames = RATE;
    const flat = [new Float32Array(frames).fill(0.5), new Float32Array(frames).fill(-0.5)];
    const out = run([{ startMs: 100, endMs: 500, effect: { ops: [{ op: 'gain', db: -6.020599913279624 }] } }], flat);
    const start = frameAt(100, RATE);
    const end = frameAt(500, RATE);
    const ramp = frameAt(AUDIO_EFFECT_RAMP_MS, RATE);
    expect(out[0]![start]).toBeCloseTo(0.5, 6);
    expect(out[0]![start + ramp / 2]).toBeCloseTo(0.375, 6);
    expect(out[0]![start + ramp]).toBeCloseTo(0.25, 6);
    expect(out[1]![(start + end) / 2]).toBeCloseTo(-0.25, 6);
    expect(out[0]![end - ramp]).toBeCloseTo(0.25, 6);
    expect(out[0]![end - ramp / 2]).toBeCloseTo(0.375, 6);
    expect(out[0]![end]).toBeCloseTo(0.5, 6);
  });

  it('squeezes the ramps into a window too short for both', () => {
    const flat = [new Float32Array(RATE).fill(0.5)];
    const out = run([{ startMs: 100, endMs: 120, effect: { ops: [{ op: 'gain', db: -40 }] } }], flat);
    const start = frameAt(100, RATE);
    const end = frameAt(120, RATE);
    // Ten milliseconds up, ten down, and never all the way in.
    expect(out[0]![start]).toBeCloseTo(0.5, 6);
    expect(out[0]![start + (end - start) / 2]).toBeCloseTo(0.005, 6);
    expect(out[0]![end]).toBeCloseTo(0.5, 6);
  });

  it('comes out the same whether the stream is handed over whole or in pieces', () => {
    const windows: ComposeAudioEffect[] = [
      { startMs: 50, endMs: 400, speed: 0.6, effect: slowReverb()! },
      { startMs: 600, endMs: 700, effect: megaphone()! },
    ];
    const input = quiet(RATE);
    const whole = run(windows, input);
    for (const piece of [1, 7, 333, 4096, 10_000]) {
      const pieces = run(windows, input, piece);
      for (let c = 0; c < 2; c++) for (let i = 0; i < RATE; i += 101) expect(pieces[c]![i]).toBe(whole[c]![i]);
    }
  });

  it('starts from a stream handed over from just before the window as it would from the beginning', () => {
    const windows: ComposeAudioEffect[] = [{ startMs: 200, endMs: 450, speed: 0.75, effect: slowReverb()! }];
    const input = quiet(RATE);
    const whole = run(windows, input);
    const first = frameAt(200, RATE) - 1;
    const tail = run(
      windows,
      input.map(channel => channel.slice(first)),
      977,
      first,
    );
    for (let c = 0; c < 2; c++) for (let i = 0; i < tail[c]!.length; i += 37) expect(tail[c]![i]).toBe(whole[c]![first + i]);
  });

  it('plays a slowed window lower as well as slower, and goes back to where the timeline is after it', () => {
    const frames = RATE;
    const input = [tone(1000, 0.5, frames)];
    const out = run([{ startMs: 0, endMs: 500, speed: 0.5 }], input);
    const ramp = frameAt(AUDIO_EFFECT_RAMP_MS, RATE);
    const end = frameAt(500, RATE);
    // A second of 1 kHz has a thousand crossings; slowed to half, half a second inside has 250.
    expect(crossings(out[0]!, ramp, end - ramp)).toBeCloseTo(crossings(input[0]!, ramp, end - ramp) / 2, -1);
    // After the window and the half second of tail a window with no steps has, the very mix.
    const tailEnd = end + frameAt(500, RATE);
    for (let i = tailEnd; i < frames; i += 13) expect(out[0]![i]).toBe(input[0]![i]);
    // And inside the tail too: with no steps there is nothing to ring.
    for (let i = end; i < tailEnd; i += 13) expect(out[0]![i]).toBeCloseTo(input[0]![i]!, 6);
  });

  it('reads nothing ahead of the frame it is making', () => {
    // A click one frame after the window starts cannot be heard before it.
    const input = [new Float32Array(2000)];
    input[0]![1001] = 1;
    const out = run([{ startMs: 1000 / RATE * 1000, endMs: 1500 / RATE * 1000, speed: 0.9 }], input);
    expect(out[0]![1000]).toBe(0);
  });

  it('rings on after the window, for its tail and no longer', () => {
    const input = [tone(300, 0.5, 3 * RATE), tone(300, 0.5, 3 * RATE)];
    const effect = soundEffectSteps('slowReverb', { room: 0 })!;
    const out = run([{ startMs: 500, endMs: 700, effect }], input.map(channel => channel.map((v, i) => (i < frameAt(700, RATE) ? v : 0))));
    const end = frameAt(700, RATE);
    const tailEnd = end + frameAt(audioEffectTailMs(effect), RATE);
    // The mix is silent after the window: what is heard there is the room.
    let rang = 0;
    for (let i = end; i < end + RATE / 10; i++) rang = Math.max(rang, Math.abs(out[0]![i]!));
    expect(rang).toBeGreaterThan(0.01);
    for (let i = tailEnd; i < out[0]!.length; i++) expect(out[0]![i]).toBe(0);
  });

  it('folds the channels inside a mono window, and leaves them apart outside it', () => {
    const input = quiet(RATE);
    const out = run([{ startMs: 200, endMs: 400, effect: megaphone()! }], input);
    const ramp = frameAt(AUDIO_EFFECT_RAMP_MS, RATE);
    for (let i = frameAt(200, RATE) + ramp; i < frameAt(400, RATE) - ramp; i += 17) expect(out[0]![i]).toBe(out[1]![i]);
    expect(out[0]![100]).not.toBe(out[1]![100]);
  });

  it('runs each window on what the one before it left', () => {
    const input = quiet(RATE);
    const first: ComposeAudioEffect = { startMs: 100, endMs: 300, effect: slowReverb()! };
    const second: ComposeAudioEffect = { startMs: 300, endMs: 500, effect: megaphone()! };
    const both = run([first, second], input);
    const oneThenOther = run([second], run([first], input));
    for (let c = 0; c < 2; c++) for (let i = 0; i < RATE; i += 53) expect(both[c]![i]).toBe(oneThenOther[c]![i]);
  });

  it('holds what it makes to -1..1', () => {
    const loud = [new Float32Array(RATE).fill(1)];
    const out = run([{ startMs: 100, endMs: 400, effect: { ops: [{ op: 'gain', db: 12 }] } }], loud);
    for (let i = 0; i < RATE; i += 11) expect(Math.abs(out[0]![i]!)).toBeLessThanOrEqual(1);
  });

  /*
   * The same numbers as `AudioEffectWindowsTest.kt` and `AudioEffectWindowsTests.swift`: the slow +
   * reverb layer at its middles over 25..125 ms at 0.8x, then the megaphone over 150..190 ms, on the
   * fragment the sound effects' golden tests use, a fifth of a second long.
   */
  it('matches the golden numbers every engine is held to', () => {
    const n = 9600;
    const left = new Float32Array(n);
    const right = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      left[i] = 0.6 * Math.sin((2 * Math.PI * 440 * i) / RATE) + 0.2 * Math.sin((2 * Math.PI * 3100 * i) / RATE);
      right[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / RATE + 0.5);
    }
    const windows: ComposeAudioEffect[] = [
      { startMs: 25, endMs: 125, speed: 0.8, effect: soundEffectPreset('slowReverb')!.effect },
      { startMs: 150, endMs: 190, effect: soundEffectPreset('megaphone')!.effect },
    ];
    new AudioEffectRunner(windows, RATE).process([left, right]);
    const golden: [number, number, number][] = GOLDEN;
    for (const [i, l, r] of golden) {
      expect(left[i]).toBeCloseTo(l, 6);
      expect(right[i]).toBeCloseTo(r, 6);
    }
  });
});

const GOLDEN: [number, number, number][] = [
  [0, 0.0, 0.1438276618719101],
  [1199, 0.044410355389118195, -0.13618730008602142],
  [1200, -4.215013398939848e-15, -0.1438276618719101],
  [1201, -0.044400833547115326, -0.15132714807987213],
  [1500, -0.49185290932655334, -0.11205031722784042],
  [2000, 0.032768141478300095, 0.12249194085597992],
  [2640, -0.2707182765007019, -0.18519802391529083],
  [3000, 0.4564398229122162, 0.21684326231479645],
  [4000, 0.05051703006029129, -0.1985909789800644],
  [5000, -0.5568563342094421, -0.011580999940633774],
  [5500, 0.22359101474285126, 0.2720637321472168],
  [5999, 0.08727562427520752, -0.1298135370016098],
  [6000, 0.04416274279356003, -0.1372629702091217],
  [6500, -0.6737513542175293, -0.22825460135936737],
  [7000, 0.5595630407333374, 0.23166373372077942],
  [7199, -0.1436537653207779, 0.13226771354675293],
  [7200, -0.016098592430353165, 0.13931874930858612],
  [7700, -0.15952368080615997, 0.14356045424938202],
  [8000, 0.03796369954943657, -0.05775051191449165],
  [8160, 0.07709841430187225, 0.07709841430187225],
  [8500, -0.13546541333198547, 0.08452267944812775],
  [9000, 0.35746344923973083, 0.27276092767715454],
  [9119, -0.16030138731002808, -0.20032526552677155],
  [9120, -0.102406345307827, -0.1977843940258026],
  [9599, -0.3330191373825073, 0.15811549127101898],
];
