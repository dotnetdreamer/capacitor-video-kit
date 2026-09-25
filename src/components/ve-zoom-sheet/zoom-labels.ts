import { durationChip } from '../ve-timeline/timeline-geometry';

/*
 * The zoom sheet's two readouts, beside the component rather than inside it: a module with a
 * `@Component` in it may export nothing but the component, and the timeline names its bars with the
 * same one-decimal level.
 */

/**
 * `2.0x`, always with one decimal. A level is a magnification, and a readout that jumped between
 * `2x` and `2.1x` as the knob moved would change width under the finger.
 */
export function zoomLevelLabel(scale: number): string {
  return `${scale.toFixed(1)}x`;
}

/** `0.7s`, or `Instant` for no ramp at all, which is a cut rather than a very short move. */
export function zoomRampLabel(ms: number): string {
  return ms <= 0 ? 'Instant' : durationChip(ms);
}
