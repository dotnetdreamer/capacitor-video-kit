import { describe, expect, it } from 'vitest';

import { varispeed } from './varispeed';

/**
 * A speed played as a record plays one, which is what `timeStretch` is careful never to do: the tone
 * goes down with the speed. The same test as `time-stretch.unit.test.ts`, the other way round - a
 * resampler keeps the NUMBER of zero crossings and spreads them over more time.
 */

const RATE = 48_000;

function sine(seconds: number, hz: number): Float32Array {
  const samples = new Float32Array(Math.round(seconds * RATE));
  for (let i = 0; i < samples.length; i++) samples[i] = Math.sin((2 * Math.PI * hz * i) / RATE);
  return samples;
}

/** Crossings per second, which is twice the frequency for a clean tone. */
function crossingsPerSecond(samples: Float32Array): number {
  let crossings = 0;
  for (let i = 1; i < samples.length; i++) {
    const previous = samples[i - 1] ?? 0;
    const current = samples[i] ?? 0;
    if ((previous < 0 && current >= 0) || (previous >= 0 && current < 0)) crossings++;
  }
  return (crossings / samples.length) * RATE;
}

describe('varispeed', () => {
  it('reads a tone at 0.8 as a tone a fifth of itself lower, over a quarter more time', () => {
    const input = sine(1, 1000);
    const out = varispeed(input, 0.8, Math.floor(input.length / 0.8));
    expect(out.length).toBe(60_000);
    expect(crossingsPerSecond(out) / 2).toBeCloseTo(800, -1);
  });

  it('reads it an octave lower at half speed, and an octave higher at double', () => {
    expect(crossingsPerSecond(varispeed(sine(1, 600), 0.5, 2 * RATE - 4)) / 2).toBeCloseTo(300, -1);
    expect(crossingsPerSecond(varispeed(sine(1, 600), 2, RATE / 2 - 4)) / 2).toBeCloseTo(1200, -1);
  });

  it('passes through every sample it lands on, so 1x is the sound itself', () => {
    const input = sine(0.1, 440);
    expect(Array.from(varispeed(input, 1, input.length))).toEqual(Array.from(input));
    // Every other output sample at half speed is an input sample.
    const half = varispeed(input, 0.5, 2 * input.length - 4);
    for (let i = 0; i < 100; i++) expect(half[2 * i]).toBe(input[i]);
  });

  it('reads between samples smoothly, so a slowed tone keeps its shape', () => {
    // A cubic between the samples of a sine sampled forty times a cycle strays from the sine by about
    // the cube of the step, 2 * PI / 40: under half a percent, some 48 dB down.
    const out = varispeed(sine(0.5, 1200), 0.37, 20_000);
    let worst = 0;
    for (let i = 2; i < out.length - 2; i++) worst = Math.max(worst, Math.abs(out[i]! - Math.sin((2 * Math.PI * 1200 * i * 0.37) / RATE)));
    expect(worst).toBeLessThan(5e-3);
  });

  it('starts where it is told, so a sample before the stretch can lead the cubic in', () => {
    const input = sine(0.1, 440);
    const led = varispeed(input, 0.75, 100, 1);
    expect(led[0]).toBe(input[1]);
    expect(led[4]).toBe(input[4]);
  });

  it('holds a read past either end to that end, and makes nothing of nothing', () => {
    expect(Array.from(varispeed(Float32Array.of(0.5), 0.5, 3))).toEqual([0.5, 0.5, 0.5]);
    expect(varispeed(new Float32Array(0), 0.5, 3)).toHaveLength(3);
    expect(varispeed(Float32Array.of(1, 2), 0.5, 0)).toHaveLength(0);
  });
});
