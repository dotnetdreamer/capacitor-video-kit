import { describe, expect, it } from 'vitest';

import { timeStretch } from './time-stretch';

/**
 * Pitch, which is what a speed change on the web would otherwise quietly move.
 *
 * The test is a sine wave and a count of its zero crossings. A resampler - which is what
 * `playbackRate` does, and what this file exists to avoid - keeps the same NUMBER of crossings and
 * packs them into less time, so the frequency goes up. An overlap-add stretch keeps the crossings
 * per SECOND, which is the pitch, and changes how many there are.
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

describe('timeStretch', () => {
  it('hands back the same instance at 1x, because there is nothing to do', () => {
    const input = sine(0.5, 440);
    expect(timeStretch(input, 1, RATE)).toBe(input);
  });

  it('halves the length at 2x', () => {
    const input = sine(2, 440);
    const output = timeStretch(input, 2, RATE);
    // Within one frame of the overlap-add, which is 40 ms.
    expect(output.length).toBeGreaterThan(input.length / 2 - RATE * 0.05);
    expect(output.length).toBeLessThan(input.length / 2 + RATE * 0.05);
  });

  it('doubles the length at 0.5x', () => {
    const input = sine(1, 440);
    const output = timeStretch(input, 0.5, RATE);
    expect(output.length).toBeGreaterThan(input.length * 2 - RATE * 0.05);
    expect(output.length).toBeLessThan(input.length * 2 + RATE * 0.05);
  });

  it('keeps the pitch when it speeds the signal up', () => {
    const input = sine(2, 440);
    const before = crossingsPerSecond(input);
    const after = crossingsPerSecond(timeStretch(input, 2, RATE));
    // Same pitch to within a few percent. A resampler would land near 1760 crossings here rather
    // than 880, which is the octave this file exists to prevent.
    expect(after).toBeGreaterThan(before * 0.95);
    expect(after).toBeLessThan(before * 1.05);
  });

  it('keeps the pitch when it slows the signal down', () => {
    const input = sine(2, 440);
    const before = crossingsPerSecond(input);
    const after = crossingsPerSecond(timeStretch(input, 0.5, RATE));
    expect(after).toBeGreaterThan(before * 0.95);
    expect(after).toBeLessThan(before * 1.05);
  });

  it('stays inside the signal, whatever the rate', () => {
    const output = timeStretch(sine(1, 220), 4, RATE);
    for (let i = 0; i < output.length; i++) {
      const value = output[i] ?? 0;
      expect(Number.isFinite(value)).toBe(true);
      expect(Math.abs(value)).toBeLessThanOrEqual(1.001);
    }
  });

  it('copes with a fragment too short to overlap-add', () => {
    // Ten milliseconds is under one frame, so it takes the resampling fallback - which is a pitch
    // shift, and is inaudible at this length.
    const output = timeStretch(sine(0.01, 440), 2, RATE);
    expect(output.length).toBeGreaterThan(0);
    expect(output.length).toBeLessThan(Math.round(0.01 * RATE));
  });

  it('clamps a rate outside the manifest own limits instead of producing nonsense', () => {
    const input = sine(1, 440);
    expect(timeStretch(input, 100, RATE).length).toBe(timeStretch(input, 4, RATE).length);
  });

  it('gives an empty input back unchanged', () => {
    const empty = new Float32Array(0);
    expect(timeStretch(empty, 2, RATE)).toBe(empty);
  });
});
