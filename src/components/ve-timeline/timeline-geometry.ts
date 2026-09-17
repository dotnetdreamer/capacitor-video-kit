import { clamp } from '../../editor';

import type { Filmstrip } from '../../state/editor.types';

/*
 * The timeline's maths, kept free of the DOM so it can be read (and tested) on its own.
 *
 * One coordinate system throughout: CONTENT pixels, measured from the left edge of the scrolling
 * content. The content is padded by half the viewport on both sides, so an output time `t` sits at
 * `pad + t / 1000 * pps` and the scroller's `scrollLeft` is exactly the time under the centre line
 * multiplied by `pps / 1000`.
 */

/**
 * Pinch zoom limits, pixels per second of output time.
 *
 * The floor decides the longest video that can be taken in at a glance: a viewport of about 390 px
 * holds `390 / MIN_PPS` seconds, so 6 is a little over a minute. At 16 it was 24 seconds - not even
 * a half-minute clip would fit on the screen at the furthest zoom out, and both of its ends could
 * never be seen at once.
 */
export const MIN_PPS = 6;
export const MAX_PPS = 320;

/** The video track's height, which is also the width of one filmstrip tile. */
export const TRACK_H = 56;
export const TRACK_H_COMPACT = 48;

/**
 * The second video layer's row, a lane's height rather than the base track's. It is a layer OF the
 * frame and not the spine of the post, and a row the same size as the filmstrip would say the
 * opposite. Its tiles are square like the filmstrip's, so this is their width too.
 */
export const TRACK2_H = 40;

/** A lane item's height plus the gap under it. */
export const LANE_PITCH = 48;

/**
 * The black gap TikTok leaves between two segments of the video track.
 *
 * Wide enough to read as a cut at a glance: a split leaves both halves looking like one unbroken
 * strip otherwise, which reads as a trim rather than as two clips.
 */
export const SEGMENT_GAP_PX = 5;

/**
 * Nothing on a lane is drawn narrower than this, so even a 100 ms layer can be tapped. It has to be
 * wide enough to stay a bar and not a sliver: selection draws a 2 px white border inside it and the
 * two trim handles stand 14 px wide just outside its edges, so anything narrower than this is all
 * chrome and none of the lane's own colour or label.
 */
export const MIN_ITEM_PX = 28;

/** How close, in pixels, a dragged edge has to come to something before it sticks to it. */
export const SNAP_PX = 8;

/** Candidate ruler spacings, in seconds. The first that leaves room for a label wins. */
const RULER_STEPS_S = [0.5, 1, 2, 5, 10, 15, 30] as const;
/** Room a label needs from its neighbour. */
const RULER_MIN_GAP_PX = 64;

/** The ruler's label spacing, in milliseconds, for a zoom. */
export function rulerStepMs(pps: number): number {
  for (const step of RULER_STEPS_S) {
    if (step * pps >= RULER_MIN_GAP_PX) return step * 1000;
  }
  return RULER_STEPS_S[RULER_STEPS_S.length - 1] * 1000;
}

/** `00:07`, or `00:07.5` on the half-second labels of the closest zoom. */
export function rulerLabel(ms: number): string {
  const whole = Math.floor(ms / 1000);
  const base = `${pad2(Math.floor(whole / 60))}:${pad2(whole % 60)}`;
  const tenths = Math.round((ms - whole * 1000) / 100);
  return tenths > 0 ? `${base}.${tenths}` : base;
}

/** `7.9s` - the selected segment's chip. */
export function durationChip(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** The filmstrip frame nearest a source time, or null while that clip's frames are still being cut. */
export function frameUrl(strip: Filmstrip | undefined, sourceMs: number): string | null {
  if (!strip || strip.stepMs <= 0 || !strip.urls.length) return null;
  const index = clamp(Math.floor(sourceMs / strip.stepMs), 0, strip.urls.length - 1);
  return strip.urls[index] || null;
}

export interface FilmTile {
  /** The tile's index on the SOURCE grid - stable while the timeline scrolls, so it is the tile's key. */
  key: number;
  /** Left edge relative to the segment's own left edge. May be negative for a tile the trim cuts. */
  x: number;
  url: string | null;
}

/**
 * The square tiles of one segment that fall inside `[winLeft, winRight)` (content px).
 *
 * The grid is anchored to SOURCE time, not to the segment's left edge: tile `k` always covers the
 * same stretch of the clip, and a trim only slides the segment's edge over it. That is what keeps
 * the pictures still under a trim handle instead of re-sampling on every frame of the drag. It also
 * keys cleanly: scrolling adds and removes tiles at the ends without re-keying the ones in between.
 */
export function segmentTiles(args: {
  inMs: number;
  outMs: number;
  speed: number;
  pps: number;
  tileW: number;
  /** The segment's left edge, content px (including any temporary drag shift). */
  segX: number;
  winLeft: number;
  winRight: number;
  strip: Filmstrip | undefined;
}): FilmTile[] {
  const { inMs, outMs, pps, tileW, segX, winLeft, winRight, strip } = args;
  const speed = args.speed || 1;
  if (pps <= 0 || tileW <= 0 || outMs <= inMs) return [];

  /** Source milliseconds one tile covers at this zoom and speed. */
  const tileSourceMs = (tileW / pps) * 1000 * speed;
  /** Where source time 0 would sit, relative to the segment's left edge. */
  const inPx = (inMs / speed / 1000) * pps;

  const firstK = Math.floor(inMs / tileSourceMs);
  const lastK = Math.ceil(outMs / tileSourceMs) - 1;
  const fromK = Math.max(firstK, Math.floor((winLeft - segX + inPx) / tileW) - 1);
  const toK = Math.min(lastK, Math.ceil((winRight - segX + inPx) / tileW));

  const tiles: FilmTile[] = [];
  for (let k = fromK; k <= toK; k++) {
    const sourceMs = Math.max(inMs, k * tileSourceMs);
    tiles.push({ key: k, x: k * tileW - inPx, url: frameUrl(strip, sourceMs) });
  }
  return tiles;
}

/**
 * The nearest snap for a set of moving edges: which target is within `thresholdPx` of which edge,
 * and how far (ms) the edges have to shift to meet it. Null when nothing is close enough.
 */
export function nearestSnap(
  edges: readonly number[],
  targets: readonly number[],
  pps: number,
  thresholdPx = SNAP_PX,
): { shiftMs: number; target: number } | null {
  let best: { shiftMs: number; target: number } | null = null;
  let bestPx = Infinity;
  for (const edge of edges) {
    for (const target of targets) {
      const px = (Math.abs(target - edge) / 1000) * pps;
      if (px <= thresholdPx && px < bestPx) {
        bestPx = px;
        best = { shiftMs: target - edge, target };
      }
    }
  }
  return best;
}

/** Takes an array rather than a `TouchList`: the caller has already dropped the touches that are not its own. */
export function touchDistance(touches: readonly Touch[]): number {
  const a = touches[0];
  const b = touches[1];
  return a && b ? Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) : 0;
}

function pad2(value: number): string {
  return String(value).padStart(2, '0');
}
