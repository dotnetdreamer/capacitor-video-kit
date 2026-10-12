import { MAX_SUBJECTS, SUBJECT_GRID, type SubjectEngine, type SubjectInfo } from '../definitions';
import type { SubjectTrackContent } from '../../editor/subject-track';

/**
 * How a footage's subjects are followed from frame to frame, written once here and ported line for
 * line by the native engines (`SubjectTracker.kt`, `SubjectTracker.swift`), so a subject is the same
 * subject - the same id, the same main one - whichever engine looked.
 *
 * A segmenter hands over, for each frame on its own, the instances it sees: Vision's foreground
 * masks number them 1..n in an order of their own, and a selfie segmenter gives one mask of everybody
 * that [componentsOf] splits into the people who do not touch. Nothing says that instance 2 of one
 * frame is instance 2 of the next. The tracker says it, by overlap: an instance that covers most of
 * what a subject covered when it was last seen IS that subject, and one that covers nothing anybody
 * covered is somebody new.
 *
 * THE RULES, which the ports keep exactly:
 *
 *  - An instance smaller than [minInstanceCells] of the grid is a speck and is background.
 *  - A frame's instances are matched to the subjects seen within the last [FORGET_AFTER_MS], by the
 *    intersection over union of the instance's cells and the cells the subject had the last time it
 *    was seen. Every pair at or above [MIN_IOU] is a candidate; the best pair is matched first, then
 *    the best of what is left, and so on - greedily, one instance to one subject. An instance left
 *    over starts a new subject. Ties go to the lower instance index, then the older subject.
 *  - A subject not seen for longer than [FORGET_AFTER_MS] is not matched again: somebody who walks
 *    off and comes back a minute later is somebody new, rather than a stranger being taken for them.
 *  - At the end, a subject seen in fewer than `min(frames, 3)` frames, or covering less than
 *    [MIN_MEAN_AREA] of the frame on average while it is seen, was noise and becomes background. The
 *    rest are ranked by the cells they covered over the whole footage - largest for longest first -
 *    and the first [MAX_SUBJECTS] become ids 1, 2, 3... in that order. So id 1 is the main subject.
 */

/** Below this intersection over union, an instance is not the subject it overlaps. */
export const MIN_IOU = 0.2;

/** A subject unseen for longer than this is never matched again. */
export const FORGET_AFTER_MS = 1000;

/** A subject smaller than this on average, a fraction of the frame, was noise. */
export const MIN_MEAN_AREA = 0.005;

/** The fewest cells an instance may have, out of `cells`: 0.2% of the grid, and never under four. */
export function minInstanceCells(cells: number): number {
  return Math.max(4, Math.ceil(0.002 * cells));
}

/**
 * The grid for an oriented frame of `width` x `height`: [SUBJECT_GRID] cells on the longer side and
 * the other in proportion, rounded, at least one.
 */
export function subjectGrid(width: number, height: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: SUBJECT_GRID, height: SUBJECT_GRID };
  if (width >= height) return { width: SUBJECT_GRID, height: Math.max(1, Math.round((SUBJECT_GRID * height) / width)) };
  return { width: Math.max(1, Math.round((SUBJECT_GRID * width) / height)), height: SUBJECT_GRID };
}

/**
 * A segmenter's map of a frame brought onto the grid: each cell takes the value of the mask's pixel
 * under its CENTRE, nearest neighbour - an instance number, kept as it is, or a confidence, which is
 * foreground (1) at `threshold` and above. The mask covers the whole oriented frame, stretched to
 * whatever size the engine made it (Vision's are square whatever the picture).
 */
export function toGrid(mask: ArrayLike<number>, maskWidth: number, maskHeight: number, grid: Uint8Array, gridWidth: number, gridHeight: number, threshold?: number): Uint8Array {
  for (let gy = 0; gy < gridHeight; gy++) {
    const my = Math.min(maskHeight - 1, Math.floor(((gy + 0.5) * maskHeight) / gridHeight));
    for (let gx = 0; gx < gridWidth; gx++) {
      const mx = Math.min(maskWidth - 1, Math.floor(((gx + 0.5) * maskWidth) / gridWidth));
      const value = mask[my * maskWidth + mx]!;
      grid[gy * gridWidth + gx] = threshold === undefined ? Math.min(255, Math.max(0, Math.round(value))) : value >= threshold ? 1 : 0;
    }
  }
  return grid;
}

/**
 * The foreground cells of a grid (any value but 0) split into the groups that touch, sides or corners,
 * numbered 1, 2, 3... in the order a row-by-row scan from the top-left first meets them. Groups
 * smaller than [minInstanceCells] are background; past 254 groups the rest are too. Writes the
 * numbers over `grid` and answers how many there are.
 */
export function componentsOf(grid: Uint8Array, width: number, height: number): number {
  const cells = width * height;
  const labels = new Int32Array(cells);
  const stack = new Int32Array(cells);
  const min = minInstanceCells(cells);
  let next = 0;
  const sizes: number[] = [0];
  for (let start = 0; start < cells; start++) {
    if (grid[start] === 0 || labels[start] !== 0) continue;
    const label = ++next;
    let size = 0;
    let top = 0;
    stack[top++] = start;
    labels[start] = label;
    while (top > 0) {
      const at = stack[--top]!;
      size++;
      const x = at % width;
      const y = (at - x) / width;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = y + dy;
        if (ny < 0 || ny >= height) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          if ((dx === 0 && dy === 0) || nx < 0 || nx >= width) continue;
          const n = ny * width + nx;
          if (grid[n] !== 0 && labels[n] === 0) {
            labels[n] = label;
            stack[top++] = n;
          }
        }
      }
    }
    sizes.push(size);
  }
  // Kept groups renumbered in scan order, specks and anything past 254 made background.
  const renumber = new Int32Array(next + 1);
  let kept = 0;
  for (let label = 1; label <= next; label++) if (sizes[label]! >= min && kept < 254) renumber[label] = ++kept;
  for (let c = 0; c < cells; c++) grid[c] = labels[c] === 0 ? 0 : renumber[labels[c]!]!;
  return kept;
}

/** One subject being followed. */
interface Followed {
  /** Provisional, in the order subjects were first seen; [SubjectTracker.finish] ranks them. */
  id: number;
  /** The cells it covered when it was last seen, and a mark for each, for the overlap. */
  cells: Int32Array;
  marks: Uint8Array;
  lastSeenMs: number;
  firstSeenMs: number;
  frames: number;
  /** Cells covered over every frame it was seen in. */
  total: number;
  peakCells: number;
  peakMs: number;
  /** Its box where it was largest, in cells: min x, min y, max x, max y. */
  peakBox: [number, number, number, number];
}

/** An instance of the frame being added: its cells, and its box. */
interface Instance {
  cells: Int32Array;
  box: [number, number, number, number];
}

/**
 * Follows the subjects through the frames handed to [add], in time order, and hands back the subject
 * track's content at [finish]. The frames are kept coded as they come, with provisional ids, so a
 * minute of footage costs the runs and not nine hundred grids.
 */
export class SubjectTracker {
  private readonly cells: number;
  private readonly min: number;
  private readonly followed: Followed[] = [];
  private readonly forgotten: Followed[] = [];
  private nextId = 1;
  private readonly times: number[] = [];
  private readonly coded: Uint8Array[] = [];

  constructor(
    readonly width: number,
    readonly height: number,
  ) {
    this.cells = width * height;
    this.min = minInstanceCells(this.cells);
  }

  /** How many frames have been added. */
  get frames(): number {
    return this.times.length;
  }

  /**
   * One analysed frame: its source time, later than the last one's, and its grid of instances - 0
   * background, 1..`count` an instance in any order. The grid is read, never kept.
   */
  add(timeMs: number, instances: Uint8Array, count: number): void {
    const found = this.instancesOf(instances, count);
    // Forget whoever has been gone too long, before anybody is matched to them.
    for (let i = this.followed.length - 1; i >= 0; i--) {
      if (timeMs - this.followed[i]!.lastSeenMs > FORGET_AFTER_MS) this.forgotten.push(...this.followed.splice(i, 1));
    }

    // Every pair close enough, best first: the overlap of an instance's cells with a subject's marks.
    const pairs: { instance: number; subject: number; iou: number }[] = [];
    found.forEach((instance, j) => {
      this.followed.forEach((subject, k) => {
        let overlap = 0;
        for (const c of instance.cells) overlap += subject.marks[c]!;
        if (overlap === 0) return;
        const iou = overlap / (instance.cells.length + subject.cells.length - overlap);
        if (iou >= MIN_IOU) pairs.push({ instance: j, subject: k, iou });
      });
    });
    pairs.sort((a, b) => b.iou - a.iou || a.instance - b.instance || a.subject - b.subject);

    const owner = new Array<Followed | null>(found.length).fill(null);
    const taken = new Set<number>();
    for (const pair of pairs) {
      if (owner[pair.instance] || taken.has(pair.subject)) continue;
      owner[pair.instance] = this.followed[pair.subject]!;
      taken.add(pair.subject);
    }

    // 32 bits, as the native ports keep them: a long clip of a flickering segmenter starts a provisional
    // subject for every instance nobody is matched to, and 16 bits would wrap onto somebody else's id.
    const ids = new Uint32Array(this.cells);
    found.forEach((instance, j) => {
      const subject = owner[j] ?? this.start(timeMs);
      this.see(subject, instance, timeMs);
      for (const c of instance.cells) ids[c] = subject.id;
    });
    this.times.push(timeMs);
    this.coded.push(codeIds(ids));
  }

  /**
   * The track's content: the subjects that were not noise, ranked and numbered, every frame's cells
   * renumbered to match, and what a reader lists them by.
   */
  finish(meta: { engine: SubjectEngine; kind: 'video' | 'image'; durationMs: number; fps: number; subjectKind: SubjectInfo['kind'] }): SubjectTrackContent {
    const frames = this.times.length;
    const everyone = [...this.forgotten, ...this.followed];
    const lasting = Math.min(frames, 3);
    const kept = everyone
      .filter(subject => subject.frames >= lasting && subject.total / subject.frames / this.cells >= MIN_MEAN_AREA)
      .sort((a, b) => b.total - a.total || a.id - b.id)
      .slice(0, MAX_SUBJECTS);
    const finalId = new Map<number, number>();
    kept.forEach((subject, i) => finalId.set(subject.id, i + 1));

    const grids = this.coded.map(coded => {
      const ids = decodeIds(coded, this.cells);
      const out = new Uint8Array(this.cells);
      for (let c = 0; c < this.cells; c++) out[c] = ids[c] === 0 ? 0 : (finalId.get(ids[c]!) ?? 0);
      return out;
    });

    const subjects: SubjectInfo[] = kept.map((subject, i) => {
      const [x0, y0, x1, y1] = subject.peakBox;
      return {
        id: i + 1,
        kind: meta.subjectKind,
        startMs: subject.firstSeenMs,
        endMs: subject.lastSeenMs,
        peakMs: subject.peakMs,
        box: { x: round4(x0 / this.width), y: round4(y0 / this.height), w: round4((x1 - x0 + 1) / this.width), h: round4((y1 - y0 + 1) / this.height) },
        area: round4(subject.total / subject.frames / this.cells),
      };
    });

    return {
      width: this.width,
      height: this.height,
      times: [...this.times],
      frames: grids,
      meta: { engine: meta.engine, kind: meta.kind, durationMs: Math.round(meta.durationMs), fps: meta.fps, subjects },
    };
  }

  /** The frame's instances big enough to be somebody, each with its cells and its box. */
  private instancesOf(grid: Uint8Array, count: number): Instance[] {
    if (count <= 0) return [];
    const sizes = new Int32Array(count + 1);
    for (let c = 0; c < this.cells; c++) if (grid[c]! <= count) sizes[grid[c]!]++;
    const lists: (Int32Array | null)[] = [null];
    const boxes: [number, number, number, number][] = [[0, 0, 0, 0]];
    for (let n = 1; n <= count; n++) {
      lists.push(sizes[n]! >= this.min ? new Int32Array(sizes[n]!) : null);
      boxes.push([this.width, this.height, -1, -1]);
    }
    const filled = new Int32Array(count + 1);
    for (let c = 0; c < this.cells; c++) {
      const n = grid[c]!;
      const list = n > 0 && n <= count ? lists[n] : null;
      if (!list) continue;
      list[filled[n]!++] = c;
      const x = c % this.width;
      const y = (c - x) / this.width;
      const box = boxes[n]!;
      if (x < box[0]) box[0] = x;
      if (y < box[1]) box[1] = y;
      if (x > box[2]) box[2] = x;
      if (y > box[3]) box[3] = y;
    }
    const out: Instance[] = [];
    for (let n = 1; n <= count; n++) if (lists[n]) out.push({ cells: lists[n]!, box: boxes[n]! });
    return out;
  }

  private start(timeMs: number): Followed {
    const subject: Followed = {
      id: this.nextId++,
      cells: new Int32Array(0),
      marks: new Uint8Array(this.cells),
      lastSeenMs: timeMs,
      firstSeenMs: timeMs,
      frames: 0,
      total: 0,
      peakCells: 0,
      peakMs: timeMs,
      peakBox: [0, 0, 0, 0],
    };
    this.followed.push(subject);
    return subject;
  }

  private see(subject: Followed, instance: Instance, timeMs: number): void {
    for (const c of subject.cells) subject.marks[c] = 0;
    for (const c of instance.cells) subject.marks[c] = 1;
    subject.cells = instance.cells;
    subject.lastSeenMs = timeMs;
    subject.frames++;
    subject.total += instance.cells.length;
    if (instance.cells.length > subject.peakCells) {
      subject.peakCells = instance.cells.length;
      subject.peakMs = timeMs;
      subject.peakBox = [...instance.box];
    }
  }
}

/** A frame of provisional ids as runs of (id, run), both unsigned LEB128: the tracker's own, never written to a file. */
function codeIds(ids: Uint32Array): Uint8Array {
  const out: number[] = [];
  const varint = (value: number): void => {
    let rest = value;
    while (rest >= 0x80) {
      out.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    out.push(rest);
  };
  let i = 0;
  while (i < ids.length) {
    const value = ids[i]!;
    let run = 1;
    while (i + run < ids.length && ids[i + run] === value) run++;
    varint(value);
    varint(run);
    i += run;
  }
  return Uint8Array.from(out);
}

function decodeIds(coded: Uint8Array, cells: number): Uint32Array {
  const ids = new Uint32Array(cells);
  let at = 0;
  let filled = 0;
  const varint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = coded[at++]!;
      value |= (byte & 0x7f) << shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  while (at < coded.length && filled < cells) {
    const value = varint();
    const run = varint();
    ids.fill(value, filled, filled + run);
    filled += run;
  }
  return ids;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
