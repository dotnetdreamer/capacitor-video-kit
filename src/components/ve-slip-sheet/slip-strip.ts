import type { Filmstrip } from '../../state/editor.types';
import { nearestFrameUrl } from '../ve-timeline/timeline-geometry';

/*
 * The Trim sheet's strip: the whole clip laid out under a frame that stays in the middle and is
 * exactly as long as the segment. Plain arithmetic, kept out of the component so it is pinned down
 * without a document.
 */

/** How much of the strip's width the frame takes, where the clip leaves room for it. */
export const FRAME_SHARE = 0.6;

/**
 * The longest the strip gets, in widths of itself. A short segment of a long clip would otherwise
 * stretch it across hundreds of screens - half a second at [FRAME_SHARE] of a phone makes a five
 * minute clip over two hundred phones wide - so past this the frame narrows instead, and a few
 * swipes still cross the whole clip.
 */
export const MAX_STRIP_WIDTHS = 15;

/** A tile is square, as the timeline draws them. */
export const TILE_PX = 56;

/** One square of the strip: where it starts along the clip, in px, and the frame it shows. */
export interface StripTile {
  readonly x: number;
  /** Null while the clip's frames are still being cut. */
  readonly url: string | null;
}

/**
 * How many px of strip one ms of the clip takes, on a strip `viewPx` wide: the segment at
 * [FRAME_SHARE] of it, unless the whole clip would then run past [MAX_STRIP_WIDTHS]. 0 until the
 * strip has a width.
 */
export function stripScale(viewPx: number, partMs: number, clipMs: number): number {
  if (viewPx <= 0 || clipMs <= 0) return 0;
  const fitted = partMs > 0 ? (viewPx * FRAME_SHARE) / partMs : Infinity;
  return Math.min(fitted, (viewPx * MAX_STRIP_WIDTHS) / clipMs);
}

/**
 * The square tiles along a clip `clipMs` long at `pxPerMs`, each showing the frame nearest its
 * middle - the shot that fills most of it, as on the timeline.
 */
export function stripTiles(clipMs: number, pxPerMs: number, strip: Filmstrip | undefined): StripTile[] {
  if (clipMs <= 0 || pxPerMs <= 0) return [];
  const count = Math.ceil((clipMs * pxPerMs) / TILE_PX);
  return Array.from({ length: count }, (_, i) => ({
    x: i * TILE_PX,
    url: nearestFrameUrl(strip, Math.min(clipMs, ((i + 0.5) * TILE_PX) / pxPerMs)),
  }));
}

/** Where a strip scrolled `scrollPx` along puts the segment's first frame, in ms, held to the clip. */
export function startFromScroll(scrollPx: number, pxPerMs: number, maxStartMs: number): number {
  if (pxPerMs <= 0) return 0;
  return Math.round(Math.min(maxStartMs, Math.max(0, scrollPx / pxPerMs)));
}

/**
 * A point in the clip as the sheet prints it: `00:12.4`. Tenths, because a part is often a second or
 * two long and whole seconds would not move while it slides. To the nearest tenth, as the timeline's
 * chip prints the segment's length: rounded down, a 58.06 s part slid to the clip's start read
 * `00:00.0 to 00:58.0` beside a chip saying 58.1s.
 */
export function clockTenths(ms: number): string {
  const tenths = Math.round(Math.max(0, ms) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

/** The same point as a screen reader should say it: `12.4 seconds`. */
export function spokenSeconds(ms: number): string {
  return `${Math.round(Math.max(0, ms) / 100) / 10} seconds`;
}
