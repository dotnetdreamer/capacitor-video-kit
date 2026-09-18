import { DEFAULT_OUTPUT, round4, type EditFit, type EditManifest, type EditPlacement } from './edit-manifest';
import { findVideoTrack, patchClip } from './edit-ops';

/**
 * Where two video layers sit on the frame, as a handful of named arrangements.
 *
 * A preset is nothing but a pair of rectangles: the base track's clips get one, the extra layer's
 * clips get the other, and every engine draws them with the [EditClip.rect] and [EditClip.fit] it
 * has understood since version 3. There is no split-screen mode and no picture-in-picture mode in
 * any of the four renderers, and there is not meant to be - anything an engine would have to learn
 * about an arrangement is geometry that belongs in these numbers instead.
 *
 * TypeScript only for that reason: the native side is handed rectangles and never hears the name of
 * the arrangement they came from, so a preset added here reaches the render without a single line
 * of Kotlin or Swift. A preset that wants a tilt is the same story, because the angle is one more
 * number on the rectangle it is already writing.
 *
 * These are a starting point and a way back, not the arrangements a post may have. A customer drags
 * and turns a layer wherever they want it from here, which writes the same rectangles by hand.
 */

export type LayoutPresetId =
  | 'full'
  | 'splitTopBottom'
  | 'splitLeftRight'
  | 'pipTL'
  | 'pipTR'
  | 'pipBL'
  | 'pipBR';

export interface LayoutPreset {
  id: LayoutPresetId;
  label: string;
  /**
   * Where the base track's clips are drawn, and at what angle. ABSENT is the whole frame standing
   * upright, the same absence a clip's own [EditClip.rect] means it by, so a preset that covers the
   * frame is stored as no rectangle at all and the post keeps the path it takes when nobody has
   * framed anything.
   */
  base?: EditPlacement;
  /** Where the extra layer's clips are drawn. Absent is the whole frame upright, as above. */
  track?: EditPlacement;
  /** The fit both layers are given. Absent hands them back to the post's own [EditManifest.fit]. */
  fit?: EditFit;
}

/**
 * The output frame's shape, which is what makes a picture-in-picture window actually square. A
 * square in output pixels is not a square in the 0..1 coordinates a rectangle is stored in, and on
 * a 720x1280 post the difference is a window nearly twice as tall as it is wide.
 */
const FRAME_ASPECT = DEFAULT_OUTPUT.width / DEFAULT_OUTPUT.height;

/** The side of a picture-in-picture window, as a fraction of the frame's WIDTH. */
const PIP_SIDE = 0.36;

/** How far that window sits off each of the two edges it is cornered into, also of the WIDTH. */
const PIP_INSET = 0.04;

/**
 * A picture-in-picture window in one corner. Both gaps are measured against the frame's width, so
 * the one along the top or bottom edge looks the same size as the one down the side rather than
 * being stretched by the frame it is on.
 */
function pipRect(right: boolean, bottom: boolean): EditPlacement {
  const h = round4(PIP_SIDE * FRAME_ASPECT);
  const insetY = round4(PIP_INSET * FRAME_ASPECT);
  return {
    x: right ? round4(1 - PIP_INSET - PIP_SIDE) : PIP_INSET,
    y: bottom ? round4(1 - insetY - h) : insetY,
    w: PIP_SIDE,
    h,
  };
}

/**
 * Every arrangement a customer can pick, in the order a picker shows them. `full` comes first
 * because it is where a post starts and what every other one is a departure from.
 */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  { id: 'full', label: 'Full frame' },
  {
    id: 'splitTopBottom',
    label: 'Top and bottom',
    base: { x: 0, y: 0, w: 1, h: 0.5 },
    track: { x: 0, y: 0.5, w: 1, h: 0.5 },
    fit: 'cover',
  },
  {
    id: 'splitLeftRight',
    label: 'Side by side',
    base: { x: 0, y: 0, w: 0.5, h: 1 },
    track: { x: 0.5, y: 0, w: 0.5, h: 1 },
    fit: 'cover',
  },
  { id: 'pipTL', label: 'Corner top left', track: pipRect(false, false), fit: 'cover' },
  { id: 'pipTR', label: 'Corner top right', track: pipRect(true, false), fit: 'cover' },
  { id: 'pipBL', label: 'Corner bottom left', track: pipRect(false, true), fit: 'cover' },
  { id: 'pipBR', label: 'Corner bottom right', track: pipRect(true, true), fit: 'cover' },
];

export function layoutPreset(id: LayoutPresetId): LayoutPreset {
  return LAYOUT_PRESETS.find((preset) => preset.id === id) ?? LAYOUT_PRESETS[0];
}

/**
 * Arranges the two layers, by writing each one's rectangle onto EVERY clip it carries.
 *
 * Every clip rather than the one on screen, because an arrangement belongs to the POST: a customer
 * who splits the screen and then splits a clip in two would otherwise watch half of their split
 * screen fall back to full frame partway through, with nothing on screen to say why.
 *
 * `full` clears the rectangles rather than writing whole-frame ones, and that is the whole
 * difference between a post that renders the way a one-layer post always has and one that carries
 * the same picture through the framing maths on every frame. [toComposeSpec] only leaves a
 * rectangle off the wire when the manifest has none to send.
 *
 * Clearing is also how an arrangement a customer dragged and turned by hand is put back: the angle
 * lives on the rectangle, so a rectangle that goes takes the angle with it and there is no second
 * field left behind saying a layer is tilted when nothing is placed anywhere.
 */
export function applyLayoutPreset(
  manifest: EditManifest,
  trackId: string,
  presetId: LayoutPresetId,
): EditManifest {
  const track = findVideoTrack(manifest, trackId);
  if (!track) return manifest;
  const preset = layoutPreset(presetId);
  // Spelled `null` rather than passed straight through: a framing patch reads `null` as "put this
  // back the way it was", and a preset with no rectangle of its own is asking for exactly that.
  const fit = preset.fit ?? null;
  let next = manifest;
  for (const clip of manifest.clips) next = patchClip(next, clip.id, { rect: preset.base ?? null, fit });
  for (const clip of track.clips) next = patchClip(next, clip.id, { rect: preset.track ?? null, fit });
  return next;
}
