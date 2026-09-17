import { describe, expect, it } from 'vitest';

import {
  KNOB_RADIUS_PX,
  SLIDER_EDGE_PX,
  percentLabel,
  quantiseSlider,
  sliderFraction,
  sliderGrab,
  sliderKnobX,
  sliderSnap,
  sliderValueAt,
  type SliderTrack,
} from './slider-geometry';

/**
 * A 393px phone with the 20px a sheet pads its body by, which is the box every one of these sliders
 * is actually drawn in: 353px of element, minus the bar's own inset at each end.
 */
const PHONE: SliderTrack = { left: 20 + SLIDER_EDGE_PX, width: 353 - SLIDER_EDGE_PX * 2 };

describe('sliderFraction', () => {
  it('runs 0 to 1 across the scale', () => {
    expect(sliderFraction(0, 0, 100)).toBe(0);
    expect(sliderFraction(50, 0, 100)).toBe(0.5);
    expect(sliderFraction(100, 0, 100)).toBe(1);
  });

  it('places the middle of a two sided scale in the middle, which is where Adjust draws its neutral mark', () => {
    expect(sliderFraction(0, -100, 100)).toBe(0.5);
    expect(sliderFraction(-50, -100, 100)).toBe(0.25);
  });

  it('clamps a value from outside the scale rather than letting the knob leave the bar', () => {
    expect(sliderFraction(-40, 0, 100)).toBe(0);
    expect(sliderFraction(140, 0, 100)).toBe(1);
  });

  it('answers 0 for a scale with no range, instead of dividing by zero', () => {
    expect(sliderFraction(5, 5, 5)).toBe(0);
  });
});

describe('sliderValueAt', () => {
  it('reads the ends of the bar as the ends of the scale', () => {
    expect(sliderValueAt(PHONE.left, PHONE, 0, 100, 1)).toBe(0);
    expect(sliderValueAt(PHONE.left + PHONE.width, PHONE, 0, 100, 1)).toBe(100);
  });

  it('clamps a finger dragged past either end, which every drag to 0 or 100 does', () => {
    expect(sliderValueAt(PHONE.left - 200, PHONE, 0, 100, 1)).toBe(0);
    expect(sliderValueAt(PHONE.left + PHONE.width + 200, PHONE, 0, 100, 1)).toBe(100);
  });

  it('quantises to whole steps', () => {
    // A third of the way along a 0..100 bar is 33.33, and the slider has no room for the third.
    const third = PHONE.left + PHONE.width / 3;
    expect(sliderValueAt(third, PHONE, 0, 100, 1)).toBe(33);
  });

  it('counts steps from the bottom of the scale, so Adjust has a step on its own -100', () => {
    expect(sliderValueAt(PHONE.left, PHONE, -100, 100, 1)).toBe(-100);
    expect(sliderValueAt(PHONE.left + PHONE.width / 2, PHONE, -100, 100, 1)).toBe(0);
  });

  it('answers the bottom of the scale for a bar that has not been laid out yet', () => {
    // A sheet measures every child as zero wide until its body has a size, and a slider touched in
    // that state must not report a value at all rather than one over a zero width bar.
    expect(sliderValueAt(180, { left: 0, width: 0 }, 0, 100, 1)).toBe(0);
  });

  it('is continuous when the step is zero', () => {
    const value = sliderValueAt(PHONE.left + PHONE.width / 3, PHONE, 0, 100, 0);
    expect(value).toBeCloseTo(100 / 3, 6);
  });
});

describe('quantiseSlider', () => {
  it('rounds to the nearest step and clamps to the scale', () => {
    expect(quantiseSlider(33.4, 0, 100, 1)).toBe(33);
    expect(quantiseSlider(33.6, 0, 100, 1)).toBe(34);
    expect(quantiseSlider(101, 0, 100, 1)).toBe(100);
    expect(quantiseSlider(-1, 0, 100, 1)).toBe(0);
  });

  it('measures a coarse step from the bottom of the scale rather than from zero', () => {
    expect(quantiseSlider(13, 10, 50, 5)).toBe(15);
    expect(quantiseSlider(12, 10, 50, 5)).toBe(10);
  });

  it('leaves a value alone when there is no step', () => {
    expect(quantiseSlider(33.33, 0, 100, 0)).toBe(33.33);
  });
});

describe('sliderGrab', () => {
  it('takes hold of the knob within its own radius, keeping the offset it was grabbed at', () => {
    const grab = sliderGrab(200, 200 + KNOB_RADIUS_PX);

    expect(grab.onKnob).toBe(true);
    expect(grab.offsetPx).toBe(KNOB_RADIUS_PX);
  });

  it('keeps a negative offset for a finger on the far side of the knob', () => {
    expect(sliderGrab(200, 195)).toEqual({ onKnob: true, offsetPx: -5 });
  });

  it('treats a press one pixel further out as a press on the bar, which jumps', () => {
    expect(sliderGrab(200, 200 + KNOB_RADIUS_PX + 1)).toEqual({ onKnob: false, offsetPx: 0 });
  });

  it('keeps the knob still for a press that does not move', () => {
    // The whole point of the offset: the value the first move reports is the value the knob was
    // already showing, so a press a few pixels off centre is not itself a change.
    const before = 40;
    const knobX = sliderKnobX(before, PHONE, 0, 100);
    const grab = sliderGrab(knobX - 9, knobX);

    expect(sliderValueAt(knobX - 9 + grab.offsetPx, PHONE, 0, 100, 1)).toBe(before);
  });
});

describe('sliderSnap', () => {
  it('sticks to a point inside the radius and lets go outside it', () => {
    expect(sliderSnap(52, [50], 3)).toBe(50);
    expect(sliderSnap(54, [50], 3)).toBeNull();
  });

  it('takes the nearer of two points that are both in reach', () => {
    expect(sliderSnap(46, [40, 50], 8)).toBe(50);
    expect(sliderSnap(44, [40, 50], 8)).toBe(40);
  });

  it('snaps to nothing when a slider has no points, which is every slider but Speed', () => {
    expect(sliderSnap(50, [], 3)).toBeNull();
  });

  it('still catches an exact hit with no radius at all', () => {
    expect(sliderSnap(50, [50], 0)).toBe(50);
    expect(sliderSnap(50.5, [50], 0)).toBeNull();
  });
});

describe('SLIDER_EDGE_PX', () => {
  it('is where the knob reaches, which is what the Speed sheet puts its 1x mark against', () => {
    // The sheet writes `calc(SLIDER_EDGE_PX + (100% - SLIDER_EDGE_PX * 2) * fraction)` against the
    // slider's own box. That has to be the same place the knob's centre lands, or the mark sits
    // beside the value it names.
    const box = { left: 0, width: 353 };
    const track: SliderTrack = { left: box.left + SLIDER_EDGE_PX, width: box.width - SLIDER_EDGE_PX * 2 };
    const oneX = 50;

    const mark = box.left + SLIDER_EDGE_PX + (box.width - SLIDER_EDGE_PX * 2) * (oneX / 100);

    expect(sliderKnobX(oneX, track, 0, 100)).toBe(mark);
  });

  it('leaves a short value above the knob 18px of the screen when the knob is at the far end', () => {
    /** Half of the readout's 44px `min-width` in the stylesheet: how far a short one hangs past the knob. */
    const PIN_HALF_WIDTH = 22;
    /** What a sheet already pads its body by, outside the slider's own box. */
    const SHEET_GUTTER = 20;

    expect(SHEET_GUTTER + SLIDER_EDGE_PX - PIN_HALF_WIDTH).toBe(18);
  });
});

describe('percentLabel', () => {
  it('reads as a whole percentage', () => {
    expect(percentLabel(80)).toBe('80%');
    expect(percentLabel(79.6)).toBe('80%');
    expect(percentLabel(0)).toBe('0%');
  });
});
