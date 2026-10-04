import type { LayoutAnimation } from './edit-manifest';

/**
 * How a layer's arrangement OPENS when it comes on screen and CLOSES when it goes - the split screen
 * of every drama's phone call, where the first shot is squeezed into its half as the second slides
 * in beside it, and is let back out to the whole frame when the call ends.
 *
 * This file is the catalogue and the stored setting's rules, and nothing else, so the manifest can
 * read a draft without importing the compiler that turns a setting into keys (`layout-motion.ts`).
 * It imports nothing from the manifest but its types, which is what keeps the two from importing
 * each other.
 *
 * Ids are stored in manifests, so they are permanent: a renamed id silently drops the animation from
 * every saved draft. Labels can change; ids cannot.
 */

export interface LayoutAnimationPreset {
  id: string;
  label: string;
}

/**
 * Every way an arrangement can open, in the order a picker offers them.
 *
 *  - `slide`: the layer slides in whole from the edge it is nearest, while the base is squeezed into
 *    the part of the frame it rests in. The phone call.
 *  - `wipe`: the line between the two sweeps across from that edge, and each picture is drawn in its
 *    own part of the frame as it opens - the layer grows out of the edge rather than arriving whole.
 *
 * Both close by running backwards, and both carry the base the same way, so the edge between the two
 * pictures is one edge for the whole move and never shows the black behind them.
 */
export const LAYOUT_ANIMATIONS: readonly LayoutAnimationPreset[] = Object.freeze([
  { id: 'slide', label: 'Slide' },
  { id: 'wipe', label: 'Wipe' },
]);

/**
 * How long an opening (and the closing) takes when an animation is first chosen. Long enough to read
 * as a move rather than a cut, short enough that the first line of a conversation is not spoken over
 * a picture still on its way in.
 */
export const DEFAULT_LAYOUT_ANIMATION_MS = 600;
/** The quickest an opening may be asked to run: a few frames at 30 fps, and still a move. */
export const MIN_LAYOUT_ANIMATION_MS = 200;
/** The slowest. Past two seconds a split screen opening is a drift, and the scene has moved on. */
export const MAX_LAYOUT_ANIMATION_MS = 2000;
/** The duration slider's step, and what its readout shows: a tenth of a second. */
export const LAYOUT_ANIMATION_STEP_MS = 100;

/** The preset `id` names, or null for an id this version does not know. */
export function layoutAnimationPreset(id: unknown): LayoutAnimationPreset | null {
  return LAYOUT_ANIMATIONS.find(preset => preset.id === id) ?? null;
}

/**
 * A stored setting made into one every engine can draw: an id this version does not know is dropped,
 * and the length is clamped to its range and rounded to a whole millisecond - one that is not a
 * number takes the default. `null` when nothing is left, which is the absent key.
 *
 * The SAME object back when it was already all of that, so an edit that did not touch the animation
 * leaves the track's fields identical and is recognised as no change at all.
 */
export function normaliseLayoutAnimation(value: unknown): LayoutAnimation | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const preset = layoutAnimationPreset(raw['id']);
  if (!preset) return null;
  const asked = typeof raw['durationMs'] === 'number' && Number.isFinite(raw['durationMs']) ? raw['durationMs'] : DEFAULT_LAYOUT_ANIMATION_MS;
  const durationMs = Math.round(Math.min(MAX_LAYOUT_ANIMATION_MS, Math.max(MIN_LAYOUT_ANIMATION_MS, asked)));
  if (Object.keys(raw).length === 2 && raw['durationMs'] === durationMs) return value as LayoutAnimation;
  return { id: preset.id, durationMs };
}

/** Whether two settings make the same move. Absent and `null` are the same: no animation. */
export function sameLayoutAnimation(a: LayoutAnimation | null | undefined, b: LayoutAnimation | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return a.id === b.id && a.durationMs === b.durationMs;
}
