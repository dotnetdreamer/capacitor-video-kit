import { layoutAnimationEnds, layoutPresets, sameRect, type EditPlacement, type EditRect, type LayoutPreset, type LayoutPresetId } from '../../editor';
import { orWhole } from '../../state/clip-framing';

/**
 * The layout row's DOM free half: the little diagrams it draws, and the question of which
 * arrangement the two layers are in right now.
 *
 * It is a plain module rather than part of `ve-layout-sheet.tsx` because both answers are pure
 * arithmetic over the presets, and both are the kind of arithmetic that goes wrong quietly: a
 * diagram off by a factor of a hundred still draws something, and a match that misses leaves the
 * row with no chip lit and nothing to say why. Here they can be tested without a document.
 */

/** A rectangle as PERCENTAGES of the little frame, which is what the diagram's CSS takes. */
export interface ChipBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/** One preset as the row draws it: its two rectangles, in the frame's own coordinates. */
export interface LayoutChip {
  readonly id: LayoutPresetId;
  readonly label: string;
  readonly base: ChipBox;
  readonly track: ChipBox;
}

/** A preset's rectangle as percentages. Absent is the whole frame, exactly as it is on the wire. */
function percentOf(rect: EditRect | undefined): ChipBox {
  const box = orWhole(rect);
  return { x: box.x * 100, y: box.y * 100, w: box.w * 100, h: box.h * 100 };
}

/**
 * The diagrams, for a frame of this shape.
 *
 * A function and no longer a constant computed once: a corner inset is square in PIXELS, so the
 * fractions that draw it differ between a portrait post and a landscape one, and a row of diagrams
 * worked out at load time would go on showing the portrait ones after the customer had changed the
 * shape. The row asks for them per repaint, which is a handful of multiplications.
 */
export function layoutChips(frameAspect: number): readonly LayoutChip[] {
  return layoutPresets(frameAspect).map((preset: LayoutPreset) => ({
    id: preset.id,
    label: preset.label,
    base: percentOf(preset.base),
    track: percentOf(preset.track),
  }));
}

/** One box of an animation tile, at either end of its move, as PERCENTAGES of the little frame. */
export interface AnimationTileBox {
  readonly closed: ChipBox;
  readonly open: ChipBox;
}

/** An animation tile: the base and the layer, each closed and open. */
export interface AnimationTile {
  readonly base: AnimationTileBox;
  readonly layer: AnimationTileBox;
}

/**
 * What a style's tile draws, on the customer's OWN arrangement: the base's rectangle and the layer's
 * as the Layout tab left them, each from where the style has it closed to where it rests open - by
 * the very rules the render's keys are compiled with ([layoutAnimationEnds]), so a tile cannot show a
 * move the file does not make.
 */
export function animationTile(base: EditPlacement | undefined, layer: EditPlacement | undefined, style: string, frameAspect: number): AnimationTile {
  const ends = layoutAnimationEnds(base, layer, style, frameAspect);
  return {
    base: { closed: percentOf(ends.base.closed), open: percentOf(ends.base.open) },
    layer: { closed: percentOf(ends.layer.closed), open: percentOf(ends.layer.open) },
  };
}

/**
 * The preset a pair of rectangles is, or null for an arrangement none of them names - which a crop
 * of one of the clips can leave behind, and which is a perfectly good state to be in.
 *
 * The two rectangles are matched either way round, because an arrangement is the same arrangement
 * with its two rectangles exchanged: a top-and-bottom split with the halves the other way up is
 * still a top-and-bottom split, and leaving no chip lit for it would say the arrangement had been
 * lost. A post saved by a build whose Swap moved the rectangles as well as the clips arrives in
 * exactly that state, and so does anyone who frames the two layers by hand.
 */
export function matchLayoutPreset(baseRect: EditRect | null | undefined, trackRect: EditRect | null | undefined, frameAspect: number): LayoutPresetId | null {
  const preset = layoutPresets(frameAspect).find(
    candidate => (sameRect(candidate.base, baseRect) && sameRect(candidate.track, trackRect)) || (sameRect(candidate.base, trackRect) && sameRect(candidate.track, baseRect)),
  );
  return preset?.id ?? null;
}
