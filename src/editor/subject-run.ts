import { coastLost, type RunSamples } from './overlay-track';
import type { SubjectTrack } from './subject-track';

/**
 * A subject the finder found ([SubjectTrack]) followed through a window of its footage, in a tracking run's own
 * terms ([RunSamples]): a sample at each frame the finder read - where the subject's middle is, how big it is
 * against one frame of it, how sure - and where it was not seen. [trackFromRun] makes a track of it like any
 * run's, so a template can pin a tag to somebody, keep them in a follow cam and light them with a look on
 * footage nobody drew a box on, with no tracker run on the phone: the finder has already been through every
 * frame, for the people matte and for Focus.
 *
 * THE POINT is the middle of a ROBUST box: the subject's cells by column and by row with [STRAYS] of them left
 * out at either end - the 2nd to the 98th percentile - each cell at its centre, `(i + 0.5) / W` as the
 * tracker's samples are, and the box spanning those two cells whole, so a solid rectangle gets exactly its own
 * size. The ends are left out because they are the finder's strays - a few cells of a bag swung out, a patch of
 * wall it took for hair - which would stretch the box and pull its middle, and a tag over the head would jump
 * with them.
 *
 * THE SIZE is the box's HEIGHT over the anchor's, never its area or its width. Somebody's height in the shot
 * changes as they come nearer or go further and with little else, while their width and their area swing with
 * every arm thrown out and every stride, and a tag that grows with them ([OverlayFollow.scaleWith]) would pump
 * on every step. The anchor is the seen frame of the median height, so the box the track keeps is the
 * subject's usual size and the scales sit either side of 1. The turn is 0: a segmentation has no angle a tag
 * should take.
 *
 * SEEN is a frame the subject has enough cells in to be itself ([MIN_SEEN_CELLS], [SEEN_SHARE]): the box of a
 * sliver of it going out of shot is the sliver's - its middle at the edge, a few rows high - and is not taken
 * for the subject's. The stretches it is not seen in are `lost`, written exactly as the tracker writes them
 * (`track-session.ts`): each as the times of its first and its last frame, the second at least a millisecond
 * past the first. The samples there are carried along ([coastLost]) as the tracker's are where it lost the
 * thing, so a tag glides on behind whatever hid the subject rather than freezing and jumping.
 */

/**
 * The fewest cells a subject is seen by in one frame. A cell of a [SUBJECT_GRID] grid is about six pixels of a
 * 1080x1920 post, so this is a speck some seventeen pixels across: below it is the finder's noise, or a
 * fingertip at the edge of the shot - never somebody a tag could sit on or a camera should chase.
 */
export const MIN_SEEN_CELLS = 8;

/**
 * The least share of its usual size - the median of its cells over the frames it has any in - a subject is
 * seen at. A fifth lets somebody walk from far off to close by and stay seen throughout, the far end of that
 * walk having about a quarter of the middle's cells; a shoulder going out of the side of the shot, or a head
 * sinking out of the bottom, has less, and its box - the sliver's, at the edge, a few rows high - would drag
 * the path off the person and shrink a tag that grows with them.
 */
export const SEEN_SHARE = 0.2;

/** The share of a subject's cells left out of its box at either end, by column and by row: the finder's strays. */
const STRAYS = 0.02;

/** What [subjectRun] follows, and through which stretch of the footage. */
export interface SubjectRunOptions {
  /** SOURCE ms of the footage to follow the subject through, both ends included. */
  fromMs: number;
  toMs: number;
  /** A [SubjectInfo.id]. Absent: the subject with the most cells over the window's frames. */
  subjectId?: number;
}

/**
 * A subject followed through a window of its subject track, in the tracker's own terms: [trackFromRun]-ready
 * once the clip it is of is named. Its `lost` stretches are already coasted across.
 */
export interface SubjectRun extends RunSamples {
  subjectId: number;
  /** The track grid's width over its height: the oriented source's shape. */
  aspect: number;
  /** The subject's box at [anchorMs], fractions of the source's width and height (scale 1 there). */
  box: { w: number; h: number };
  /** Share of the window's frames the subject was seen in, 0..1: of every sample, the frame either side included. */
  seen: number;
}

/** A subject in one frame: how many cells it has, and its robust box, 0..1 of the frame. */
interface Sighting {
  cells: number;
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

/**
 * Subject `subjectId` - or, absent, the one with the most cells over the window's frames among those the track
 * lists - followed from `fromMs` to `toMs` of its source: a sample at every frame of the track inside that
 * window and at the nearest frame either side of it, so the path spans the window wherever its frames fall. A
 * picture's track, one frame, is one sample. Null where the subject is seen in none of them, and for an id no
 * cell can hold.
 *
 * Each frame is read once and in order: a track keeps only a few decoded ([SubjectTrack.frame]), and the window
 * of a long clip is hundreds of them.
 */
export function subjectRun(track: SubjectTrack, options: SubjectRunOptions): SubjectRun | null {
  const { fromMs, toMs, subjectId } = options;
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) return null;
  // 0 is the background, and a cell holds one byte.
  if (subjectId !== undefined && !(Number.isInteger(subjectId) && subjectId >= 1 && subjectId <= 255)) return null;
  const times = track.times;
  const first = Math.max(0, firstAtOrAfter(times, Math.min(fromMs, toMs)) - 1);
  const last = Math.min(times.length - 1, firstAfter(times, Math.max(fromMs, toMs)));
  const frames = sightingsIn(track, first, last, subjectId);
  const id = subjectId ?? mostCells(frames, track.meta?.subjects);
  const mine = frames.map(frame => frame.get(id));

  const counts = mine.flatMap(s => (s ? [s.cells] : [])).sort((a, b) => a - b);
  if (counts.length === 0) return null;
  const least = Math.max(MIN_SEEN_CELLS, SEEN_SHARE * median(counts));
  const seen = mine.map(s => !!s && s.cells >= least);
  const seenCount = seen.filter(Boolean).length;
  if (seenCount === 0) return null;

  // The anchor: the seen frame of the median height, the earlier of two as tall.
  const heightAt = (k: number): number => mine[k]!.y1 - mine[k]!.y0;
  const tallest = seen.flatMap((yes, k) => (yes ? [k] : [])).sort((a, b) => heightAt(a) - heightAt(b) || a - b);
  const anchor = tallest[(tallest.length - 1) >> 1]!;
  const box = mine[anchor]!;
  const anchorHeight = heightAt(anchor);

  const run: SubjectRun = {
    atMs: [],
    x: [],
    y: [],
    scale: [],
    turn: [],
    sure: [],
    lost: [],
    anchorMs: times[first + anchor]!,
    subjectId: id,
    aspect: track.width / track.height,
    box: { w: roundTo(box.x1 - box.x0, 5), h: roundTo(anchorHeight, 5) },
    seen: seenCount / seen.length,
  };
  let lostFrom = -1;
  mine.forEach((s, k) => {
    const t = times[first + k]!;
    // Where it is not seen the sample is only a stand-in, which [coastLost] replaces below.
    run.atMs.push(t);
    run.x.push(roundTo(s ? (s.x0 + s.x1) / 2 : 0.5, 5));
    run.y.push(roundTo(s ? (s.y0 + s.y1) / 2 : 0.5, 5));
    run.scale.push(seen[k] ? roundTo(heightAt(k) / anchorHeight, 4) : 1);
    run.turn.push(0);
    run.sure.push(seen[k] ? 100 : 0);
    if (!seen[k] && lostFrom < 0) lostFrom = t;
    if (lostFrom >= 0 && (k === mine.length - 1 || seen[k + 1])) {
      run.lost.push(lostFrom, Math.max(t, lostFrom + 1));
      lostFrom = -1;
    }
  });
  return run.lost.length > 0 ? coastLost(run, k => seen[k]!) : run;
}

/**
 * Every subject's sighting in each frame from `first` to `last`, or only subject `only`'s: one pass over each
 * frame's cells counting every subject's cells by column and by row, and its box read off those counts.
 */
function sightingsIn(track: SubjectTrack, first: number, last: number, only: number | undefined): Map<number, Sighting>[] {
  const W = track.width;
  const H = track.height;
  const counts = new Uint32Array(256);
  const cols = new Uint32Array(256 * W);
  const rows = new Uint32Array(256 * H);
  const out: Map<number, Sighting>[] = [];
  for (let f = first; f <= last; f++) {
    const cells = track.frame(f);
    const present: number[] = [];
    for (let j = 0, c = 0; j < H; j++) {
      for (let i = 0; i < W; i++, c++) {
        const id = cells[c]!;
        if (id === 0 || (only !== undefined && id !== only)) continue;
        if (counts[id] === 0) present.push(id);
        counts[id]++;
        cols[id * W + i]++;
        rows[id * H + j]++;
      }
    }
    const frame = new Map<number, Sighting>();
    for (const id of present) {
      const n = counts[id]!;
      const low = Math.floor(STRAYS * (n - 1));
      const high = Math.ceil((1 - STRAYS) * (n - 1));
      const [i0, i1] = ranksIn(cols, id * W, W, low, high);
      const [j0, j1] = ranksIn(rows, id * H, H, low, high);
      frame.set(id, { cells: n, x0: i0 / W, x1: (i1 + 1) / W, y0: j0 / H, y1: (j1 + 1) / H });
      counts[id] = 0;
      cols.fill(0, id * W, (id + 1) * W);
      rows.fill(0, id * H, (id + 1) * H);
    }
    out.push(frame);
  }
  return out;
}

/**
 * The columns (or rows) the `low`th and the `high`th cell are in, counting from the first: `counts[at + k]` is
 * how many of the subject's cells column `k` holds.
 */
function ranksIn(counts: Uint32Array, at: number, length: number, low: number, high: number): [number, number] {
  let upTo = 0;
  let from = -1;
  for (let k = 0; k < length; k++) {
    upTo += counts[at + k]!;
    if (from < 0 && upTo > low) from = k;
    if (upTo > high) return [from, k];
  }
  return [Math.max(0, from), length - 1];
}

/** The subject with the most cells over `frames`, among those `listed` names where there is a list; 0 for none. */
function mostCells(frames: readonly ReadonlyMap<number, Sighting>[], listed: readonly { id: number }[] | undefined): number {
  const totals = new Float64Array(256);
  for (const frame of frames) for (const [id, sighting] of frame) totals[id] += sighting.cells;
  const known = listed ? new Set(listed.map(subject => subject.id)) : null;
  let best = 0;
  for (let id = 1; id < 256; id++) if (totals[id]! > totals[best]! && (!known || known.has(id))) best = id;
  return best;
}

/** The first frame at or after `ms`, or the count of them when none is. */
function firstAtOrAfter(times: Uint32Array, ms: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! < ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** The first frame after `ms`, or the count of them when none is. */
function firstAfter(times: Uint32Array, ms: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= ms) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function median(sorted: readonly number[]): number {
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function roundTo(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f + 0;
}
