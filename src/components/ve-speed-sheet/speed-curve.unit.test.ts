import { describe, expect, it } from 'vitest';

import { MAX_SPEED, MIN_SPEED, SPEED_CHIPS, emptyManifest, findClip, setClipSpeed, type EditClip } from '../../editor';
import { ONE_X, SLIDER_MAX, formatSpeed, roundSpeed, sliderToSpeed, speedToSlider } from './speed-curve';

/** One four second segment, which is as much of a manifest as `setClipSpeed` reads. */
function clip(speed: number): EditClip {
  return { id: 'a', clipKey: 'a', inMs: 0, outMs: 4000, speed, volume: 1, muted: false };
}

/** What the manifest holds after a slider value has been through the sheet and back. */
function stored(sliderValue: number): number {
  const manifest = { ...emptyManifest(), clips: [clip(1)] };
  return findClip(setClipSpeed(manifest, 'a', roundSpeed(sliderToSpeed(sliderValue))), 'a')!.speed;
}

describe('sliderToSpeed', () => {
  it('runs the whole range, end to end', () => {
    expect(sliderToSpeed(0)).toBe(MIN_SPEED);
    expect(sliderToSpeed(SLIDER_MAX)).toBe(MAX_SPEED);
  });

  it('puts 1x dead centre, which is the whole reason the scale is logarithmic', () => {
    expect(sliderToSpeed(SLIDER_MAX / 2)).toBeCloseTo(1, 12);
  });

  it('gives halving and doubling the same finger distance', () => {
    const half = speedToSlider(0.5);
    const double = speedToSlider(2);
    expect(SLIDER_MAX / 2 - half).toBeCloseTo(double - SLIDER_MAX / 2, 12);
  });
});

describe('speedToSlider', () => {
  it('undoes sliderToSpeed', () => {
    for (const value of [0, 7, 25, 50, 73, 100]) {
      expect(speedToSlider(sliderToSpeed(value))).toBeCloseTo(value, 10);
    }
  });

  it('clamps a speed from outside the scale rather than pushing the knob off the bar', () => {
    expect(speedToSlider(0.05)).toBe(0);
    expect(speedToSlider(9)).toBe(SLIDER_MAX);
  });
});

describe('ONE_X', () => {
  it('is the exact middle, so the tick under the track and the snap point are the same place', () => {
    expect(ONE_X).toBe(SLIDER_MAX / 2);
  });

  /*
   * The knob sticks to this point within three units, and the value it lands on has to be exactly
   * 1x: a segment left at 1.01x is not "normal speed", and the chip for 1x would stay unlit beside
   * a readout saying 1x.
   */
  it('lands on exactly 1x once the sheet has rounded it', () => {
    expect(roundSpeed(sliderToSpeed(ONE_X))).toBe(1);
  });
});

describe('roundSpeed', () => {
  it('rounds and clamps exactly the way setClipSpeed stores, which is what lets the two be compared', () => {
    for (const value of [0, 1, 17, 33, 50, 64, 77, 99, 100]) {
      expect(roundSpeed(sliderToSpeed(value))).toBe(stored(value));
    }
  });

  it('keeps every preset chip at its own value, so tapping one lights it', () => {
    for (const chip of SPEED_CHIPS) {
      expect(roundSpeed(sliderToSpeed(speedToSlider(chip)))).toBe(chip);
    }
  });
});

describe('formatSpeed', () => {
  it('drops the trailing zeros a fixed two decimals would leave', () => {
    expect(formatSpeed(1)).toBe('1x');
    expect(formatSpeed(1.5)).toBe('1.5x');
    expect(formatSpeed(0.25)).toBe('0.25x');
    expect(formatSpeed(4)).toBe('4x');
  });

  it('never shows a speed at more decimals than the manifest holds', () => {
    expect(formatSpeed(roundSpeed(sliderToSpeed(64)))).toBe('1.47x');
  });
});
