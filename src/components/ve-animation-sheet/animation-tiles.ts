import {
  NEUTRAL_MOTION,
  OVERLAY_ANIMATIONS,
  compileOverlayMotion,
  isNeutralMotion,
  overlayMotionAt,
  type ComposeOverlayMotion,
  type OverlayAnimation,
  type OverlayAnimationPart,
  type OverlayAnimationPreset,
  type OverlayKind,
  type OverlayMotionSample,
} from '../../editor';
import type { SheetTab } from '../sheet.types';

/*
 * The animation sheet's arithmetic, beside the component rather than inside it: a module with a
 * `@Component` in it may export nothing but the component, and every number here is one a unit test
 * wants to hold without a browser.
 *
 * The one rule all of it keeps is that a tile is not a drawing OF a preset. It is the preset: the
 * same `compileOverlayMotion` the render is handed, read through the same `overlayMotionAt` the
 * preview and the web engine read it through, on a little window of the tile's own. A pop that
 * overshoots on the tile overshoots by the same amount in the file, and a preset added to the
 * catalogue has a tile the moment it has a curve.
 */

/** The three tabs, in the order CapCut puts them. */
const PART_TABS: readonly (SheetTab & { id: OverlayAnimationPart })[] = [
  { id: 'in', label: 'In' },
  { id: 'out', label: 'Out' },
  { id: 'loop', label: 'Loop' },
];

/** An effect's two, made once: a new array per render would be a changed prop to the frame every time. */
const EFFECT_TABS = PART_TABS.slice(0, 2);

/**
 * The tabs for a layer of `kind`. An effect is the whole frame and only ever fades - every preset is
 * reduced to its opacity on one - so it gets In and Out and no Loop: a pulse that draws nothing on an
 * effect is not a choice worth offering.
 */
export function animationTabs(kind: OverlayKind): readonly SheetTab[] {
  return kind === 'effect' ? EFFECT_TABS : PART_TABS;
}

/**
 * The presets a tab offers a layer of `kind`: the whole catalogue for text, stickers and photos, and
 * Fade alone for an effect. Every other in and out an effect could be given comes out as a fade of
 * some other length or a flicker, and a row of ten tiles that all look like a fade is ten tiles that
 * each make the customer wonder what they missed.
 */
export function animationChoices(kind: OverlayKind, part: OverlayAnimationPart): readonly OverlayAnimationPreset[] {
  if (kind !== 'effect') return OVERLAY_ANIMATIONS[part];
  return part === 'loop' ? [] : OVERLAY_ANIMATIONS[part].filter(preset => preset.id === 'fade');
}

/** The part a sheet opens on: the first the layer has, of the ones its tabs offer, or In. */
export function openingPart(kind: OverlayKind, animation: OverlayAnimation | null | undefined): OverlayAnimationPart {
  const offered = animationTabs(kind).map(tab => tab.id as OverlayAnimationPart);
  return offered.find(part => !!animation?.[part]) ?? 'in';
}

/* -------------------------------------------------------------------------------------------- */
/* A tile's little timeline                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * How long an in's tile shows its empty frame before the layer arrives: long enough to see that it
 * was not there, short enough that the row does not look idle.
 */
export const TILE_LEAD_MS = 250;
/** How long a tile holds the layer at rest: after an in has landed, and before an out begins. */
export const TILE_HOLD_MS = 900;
/** How long an out's tile stays empty after the layer has gone, before it comes back to leave again. */
export const TILE_TAIL_MS = 350;
/**
 * The least a loop's tile plays before it starts over. A tile starting again every 200 ms would be
 * a flicker of its own; a whole number of cycles that covers this is seamless, because a loop is at
 * rest at the start of every cycle.
 */
export const TILE_LOOP_MS = 1600;

/**
 * One tile's demonstration: the layer's motion over a window of the tile's own clock, and the pass
 * the tile repeats. The layer is on the tile for `fromMs <= t < toMs` - the render's gate - and off
 * it the rest of the pass, which is exactly what an in and an out are about.
 */
export interface TileDemo {
  motion: ComposeOverlayMotion | null;
  fromMs: number;
  toMs: number;
  /** One pass, after which the tile starts again from its own 0. */
  cycleMs: number;
}

/**
 * The demonstration of preset `id` for `part`, `ms` long (an in's or an out's length, a loop's
 * period), on a layer of `kind`: compiled by the render's own compiler, because the kind changes the
 * move - a sticker turns as it pops, and an effect only fades.
 *
 * An in arrives after a short empty lead and then holds; an out holds first and then leaves, with a
 * beat of empty frame after it; a loop plays whole cycles and starts again where it began.
 */
export function tileDemo(part: OverlayAnimationPart, id: string, ms: number, kind: OverlayKind): TileDemo {
  switch (part) {
    case 'in': {
      const toMs = TILE_LEAD_MS + ms + TILE_HOLD_MS;
      const motion = compileOverlayMotion({ startMs: TILE_LEAD_MS, endMs: toMs }, { in: { id, durationMs: ms } }, kind);
      return { motion, fromMs: TILE_LEAD_MS, toMs, cycleMs: toMs };
    }
    case 'out': {
      const toMs = TILE_HOLD_MS + ms;
      const motion = compileOverlayMotion({ startMs: 0, endMs: toMs }, { out: { id, durationMs: ms } }, kind);
      return { motion, fromMs: 0, toMs, cycleMs: toMs + TILE_TAIL_MS };
    }
    case 'loop': {
      const period = Math.max(1, ms);
      const toMs = Math.max(1, Math.ceil(TILE_LOOP_MS / period)) * period;
      const motion = compileOverlayMotion({ startMs: 0, endMs: toMs }, { loop: { id, periodMs: ms } }, kind);
      return { motion, fromMs: 0, toMs, cycleMs: toMs };
    }
  }
}

/**
 * The layer on a tile `elapsedMs` after the tile started, pass after pass: null while it is off the
 * tile, otherwise its pose - [NEUTRAL_MOTION] where it is at rest, which is where the wire's reading
 * answers null.
 */
export function tilePoseAt(demo: TileDemo, elapsedMs: number): OverlayMotionSample | null {
  const t = demo.cycleMs > 0 ? ((elapsedMs % demo.cycleMs) + demo.cycleMs) % demo.cycleMs : 0;
  if (t < demo.fromMs || t >= demo.toMs) return null;
  return overlayMotionAt(demo.motion, t) ?? NEUTRAL_MOTION;
}

/* -------------------------------------------------------------------------------------------- */
/* The glyph on a tile                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * How wide a layer is taken to be when there is no bitmap to measure: a third of the frame, a
 * sticker's size, so a move's reach on the tile is a sticker's reach until the real one is drawn.
 */
const UNMEASURED_LAYER_FRACTION = 0.33;

/**
 * Where the glyph sits on a tile, and how far a move carries it there.
 *
 * The glyph is the layer fitted into a `box` - wider than it is tall, because a caption is, and a
 * caption fitted into a square is a line of text too small to read - and the tile is the frame drawn
 * at that SAME scale around it. The tile is far too small to show the frame, and does not need to:
 * all it needs is how many tile pixels one whole width and one whole height of the frame come to,
 * because that is what a motion's offsets are fractions of. A slide that crosses a tenth of the frame
 * in the render crosses a tenth of that reach on the tile, and so crosses the same number of the
 * layer's own widths in both places, which is what the eye compares.
 */
export function tileGlyph(
  layer: { w: number; h: number } | null,
  frame: { width: number; height: number },
  box: { w: number; h: number },
): { w: number; h: number; reach: { x: number; y: number } } {
  const side = UNMEASURED_LAYER_FRACTION * frame.width;
  const lw = layer && layer.w > 0 && layer.h > 0 ? layer.w : side;
  const lh = layer && layer.w > 0 && layer.h > 0 ? layer.h : side;
  const k = Math.min(box.w / lw, box.h / lh);
  return { w: lw * k, h: lh * k, reach: { x: frame.width * k, y: frame.height * k } };
}

/**
 * A pose as the glyph's CSS: its offsets in tile pixels through `reach`, and turned and sized about
 * its own centre - the `transform-origin` a box has unless told otherwise - after the move, which is
 * the order the painter applies them in. Off the tile is simply transparent; at rest is `none`, so a
 * still tile carries no transform at all.
 */
export function tileStyle(pose: OverlayMotionSample | null, reach: { x: number; y: number }): { transform: string; opacity: string } {
  if (!pose) return { transform: 'none', opacity: '0' };
  if (isNeutralMotion(pose)) return { transform: 'none', opacity: '1' };
  const x = round2(pose.x * reach.x);
  const y = round2(pose.y * reach.y);
  return {
    transform: `translate(${x}px, ${y}px) rotate(${round2(pose.rotation)}deg) scale(${round4(pose.scale)})`,
    opacity: String(round4(pose.opacity)),
  };
}

/** Far under a pixel, and short enough that the inspector shows a number rather than binary dust. */
function round2(value: number): number {
  return Math.round(value * 100) / 100 + 0;
}

function round4(value: number): number {
  return Math.round(value * 1e4) / 1e4 + 0;
}
