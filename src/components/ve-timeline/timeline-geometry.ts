import { clamp, type ClipDropTarget } from '../../editor';

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

/**
 * A lifted segment lands ON a row until the finger is this far into the row's foot, where it starts
 * to mean the gap under it instead.
 *
 * Small on purpose. The gap between two rows is [LANE_PITCH] minus a row's height and can be as
 * little as 8 px, which is not a target a thumb can hit: the band that opens a new layer has to
 * borrow a few pixels from the row on each side of it, or the only way to make a layer would be to
 * drag past the last row entirely.
 */
export const DROP_EDGE_PX = 10;

/** Lifted this far above the top row, the segment is being put back rather than carried anywhere. */
export const DROP_CANCEL_PX = 28;

/** One video row's vertical extent on the screen. `trackId` is null for the base track. */
export interface DropRow {
  trackId: string | null;
  top: number;
  bottom: number;
}

/**
 * What a finger at `y` is over: a row to drop onto, the gap under a row where a new layer would
 * open, or null for far enough above the whole stack to mean "put it back".
 *
 * `rows` are the video rows as they are drawn, TOP FIRST: the base track's filmstrip, then every
 * layer nearest the base first. The gap under row `i` opens a layer at row index `i`, which counting
 * from the base track is exactly the [ClipDropTarget] `new` index - the base being row 0 and its gap
 * being the first place a layer can go.
 *
 * Anything below the last row is that last gap: a finger dragged down past the lanes has said which
 * way it is going, and refusing it there would be a drag that stops working the further it is
 * carried.
 */
export function dropTargetAt(y: number, rows: readonly DropRow[]): ClipDropTarget | null {
  if (!rows.length || y < rows[0].top - DROP_CANCEL_PX) return null;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const foot = Math.max(row.top, row.bottom - DROP_EDGE_PX);
    if (y < foot) return row.trackId === null ? { kind: 'base' } : { kind: 'track', trackId: row.trackId };
    const next = rows[i + 1];
    if (!next) break;
    if (y < next.top + DROP_EDGE_PX) return { kind: 'new', index: i };
  }
  return { kind: 'new', index: rows.length - 1 };
}

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
 * Everything on the timeline a dragged edge may snap to: 0, the end of the post, and the START and
 * END of every segment on every row - the base track and each layer alike.
 *
 * The layers were missing, and they are the rows a customer most needs held in line: splitting a
 * video and carrying half of it onto a layer of its own leaves two pictures that are meant to meet
 * exactly, and nothing on the timeline would hold them there. The base track's own boundaries were
 * the only targets, so a clip on layer two could be dropped a frame short of the one beside it and
 * nothing said so.
 *
 * A layer is a SEQUENCE laid end to end from its own `startMs`, so its boundaries are that start
 * plus the running total of what is on it - which is also why the track's start is a target in its
 * own right even when the row is empty of anything else to meet.
 *
 * Duplicates are left in. `nearestSnap` takes the closest of whatever it is given, and two rows
 * whose segments end at the same instant are the one target twice over - which is the case a
 * customer is most often aiming at.
 */
export function snapTargets(post: SnapPost): number[] {
  const targets = [0, Math.max(0, post.totalMs)];
  for (const row of post.rows) {
    let at = Math.max(0, row.startMs);
    targets.push(at);
    for (const durationMs of row.durationsMs) {
      at += Math.max(0, durationMs);
      targets.push(at);
    }
  }
  return targets;
}

/** One row of the timeline as [snapTargets] reads it: where it begins, and what is laid along it. */
export interface SnapRow {
  startMs: number;
  /** Each segment's length on the OUTPUT timeline, so a sped-up clip counts as what it plays for. */
  durationsMs: readonly number[];
}

export interface SnapPost {
  totalMs: number;
  /** The base track first, then every layer - though the order makes no difference to the answer. */
  rows: readonly SnapRow[];
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
