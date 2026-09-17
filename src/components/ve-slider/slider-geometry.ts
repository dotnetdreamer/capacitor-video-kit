import { clamp } from '../../editor';

/**
 * The slider's DOM free half: the two measurements its look is built on, and the arithmetic that
 * turns a value into a position and a finger into a value.
 *
 * It is a plain module rather than part of `ve-slider.tsx` for two reasons. The Speed sheet draws
 * its own scale under the bar and has to put the 1x mark where the knob actually reaches, so it
 * imports [SLIDER_EDGE_PX]; a sheet cannot import from a `.tsx` without pulling the component's
 * decorators in with it. And pointer arithmetic is where a slider goes wrong - by a knob's width at
 * one end, by a rounding step in the middle - in ways that a running browser shows as "slightly
 * off" and a test shows as a number. Everything here is a pure function of numbers, so all of it
 * can be tested without a document.
 */

/**
 * How far the bar's ends sit inside the slider's own box.
 *
 * The knob, and the value floating above it, are centred on the bar's end points, so a bar that ran
 * the full width of the box would put half the knob - and half of a value readout that is wider
 * still - past the sheet's side padding: at 100% the knob came within 8px of the screen edge and
 * the readout was cut off by it. The bar stops this far in instead. It is two pixels under half the
 * readout's SMALLEST width (`min-width: 44px` in the stylesheet), so with the 20px a sheet already
 * pads its body by, a short readout ends no closer than 18px to the screen edge and a longer one
 * eats into that margin rather than losing a character to the edge.
 *
 * It is the default of the `--ve-slider-edge` custom property rather than a hard coded padding, so
 * a sheet that puts the slider in a row of its own can close the gap without the maths below going
 * out of step: the geometry measures the bar it was given rather than assuming this number.
 */
export const SLIDER_EDGE_PX = 20;

/** Half the knob's 24px: a finger this close to its centre has the knob, not the bar behind it. */
export const KNOB_RADIUS_PX = 12;

/** Whether the value floats above the knob: never, only while it is held, or always. */
export type SliderPin = 'none' | 'press' | 'always';

/** The bar's box in client coordinates, which is the whole of what a `DOMRect` is needed for here. */
export interface SliderTrack {
  readonly left: number;
  readonly width: number;
}

/** Where a press landed, and what the knob should keep doing about it. */
export interface SliderGrab {
  /** True when the finger came down on the knob, so the value must not move until it does. */
  readonly onKnob: boolean;
  /**
   * The distance from the finger to the knob's centre, kept for the rest of the drag so the knob
   * stays exactly where it was picked up. Zero for a press on the bar, which jumps under the finger.
   */
  readonly offsetPx: number;
}

/** Where a value sits along the bar: 0 at `min`, 1 at `max`. */
export function sliderFraction(value: number, min: number, max: number): number {
  if (max === min) return 0;
  return clamp((value - min) / (max - min), 0, 1);
}

/** Where the knob's centre is on screen for a value. */
export function sliderKnobX(value: number, track: SliderTrack, min: number, max: number): number {
  return track.left + sliderFraction(value, min, max) * track.width;
}

/**
 * The value a point on the bar means, quantised to `step` and clamped to the scale.
 *
 * A bar of no width answers `min` rather than dividing by zero. That is not a theoretical case: a
 * sheet whose body has not been laid out yet measures every one of its children as zero wide.
 */
export function sliderValueAt(clientX: number, track: SliderTrack, min: number, max: number, step: number): number {
  const fraction = track.width > 0 ? clamp((clientX - track.left) / track.width, 0, 1) : 0;
  return quantiseSlider(min + (max - min) * fraction, min, max, step);
}

/**
 * The nearest whole step of the scale, counted from `min` so that a scale which does not start at
 * zero still has a step on its own first value. A step of zero or less means a continuous scale.
 */
export function quantiseSlider(value: number, min: number, max: number, step: number): number {
  if (!(step > 0)) return clamp(value, min, max);
  return clamp(min + Math.round((value - min) / step) * step, min, max);
}

/**
 * Whether a press took hold of the knob or landed on the bar somewhere else.
 *
 * A press on the knob keeps its offset for the rest of the drag, so the knob travels with the
 * finger instead of jumping to sit under it. That is what makes a press which never moves change
 * nothing: the first move of a pixel is a pixel of travel, not a jump of however far the finger
 * happened to land from the centre.
 */
export function sliderGrab(clientX: number, knobX: number): SliderGrab {
  const offsetPx = knobX - clientX;
  return Math.abs(offsetPx) <= KNOB_RADIUS_PX ? { onKnob: true, offsetPx } : { onKnob: false, offsetPx: 0 };
}

/**
 * The snap point a value is close enough to stick to, or null for a value out in the open.
 *
 * Nearest rather than first, so a scale with two points inside one radius sticks to the one the
 * finger is actually by. Only the Speed sheet snaps today, to 1x, and it is the reason the
 * arithmetic exists at all: on a log scale a whole number track cannot hold 1x exactly.
 */
export function sliderSnap(value: number, points: readonly number[], radius: number): number | null {
  let best: number | null = null;
  let bestDistance = radius;
  for (const point of points) {
    const distance = Math.abs(value - point);
    if (distance <= bestDistance) {
      best = point;
      bestDistance = distance;
    }
  }
  return best;
}

/** `80%` - what the volume, opacity and layout sliders show above their knob. */
export const percentLabel = (value: number): string => `${Math.round(value)}%`;
