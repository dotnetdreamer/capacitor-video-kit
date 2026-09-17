import { MAX_SPEED, MIN_SPEED, clamp } from '../../editor';

/**
 * The Speed sheet's arithmetic: the scale its slider runs on, and the two ways a speed is written
 * down.
 *
 * A plain module beside the component rather than part of `ve-speed-sheet.tsx`, because a `.tsx` is
 * a component module - importing one of these functions from it would pull a custom element's
 * source, its decorators and its stylesheet in behind the function. Being DOM free it is also the
 * whole of what a test can pin down without a browser, which matters here more than anywhere else
 * in the sheet: every number below is a curve, and a curve that is slightly wrong still draws a
 * slider that works.
 *
 * Deliberately not in `src/editor/edit-manifest.ts`. That file is the contract the Swift and Kotlin
 * engines are written against, and where a speed sits on a slider is not something a renderer has
 * any question about. The one thing both sides do have to agree on is [roundSpeed], which is a copy
 * of what `setClipSpeed` stores rather than a second opinion about it.
 */

/** The slider's own scale: whole steps from 0 to here, with 1x at 50. */
export const SLIDER_MAX = 100;

/**
 * The slider runs on a log scale: 0.25x..4x is a factor of 16, and a linear track would give slow
 * motion a quarter of its width while 2x..4x took half. Logarithmically 1x sits dead centre and
 * halving the speed is the same finger distance as doubling it.
 */
export function sliderToSpeed(value: number): number {
  return MIN_SPEED * Math.pow(MAX_SPEED / MIN_SPEED, value / SLIDER_MAX);
}

export function speedToSlider(speed: number): number {
  return (SLIDER_MAX * Math.log2(clamp(speed, MIN_SPEED, MAX_SPEED) / MIN_SPEED)) / Math.log2(MAX_SPEED / MIN_SPEED);
}

/** The same rounding `setClipSpeed` stores, so a slider value can be compared with the manifest. */
export function roundSpeed(speed: number): number {
  return Math.round(clamp(speed, MIN_SPEED, MAX_SPEED) * 100) / 100;
}

/** `1.5x`, `1x`, `0.25x`. */
export function formatSpeed(speed: number): string {
  return `${Number(speed.toFixed(2))}x`;
}

/** Where 1x sits on the slider; the knob sticks to it within a few units. */
export const ONE_X = speedToSlider(1);
