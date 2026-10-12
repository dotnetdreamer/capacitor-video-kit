import { SUBJECT_TRACK_MAGIC, SUBJECT_TRACK_VERSION, type ComposeFocus, type SubjectEngine, type SubjectInfo } from '../video-composer/definitions';

/**
 * A subject track, the file `findSubjects` writes: where every subject of a footage is, frame by
 * frame, as a coarse grid of subject ids over the oriented frame. [SUBJECT_TRACK_MAGIC] has the
 * layout; this is its one reader and its one writer on the web side, and the native engines' are
 * ports of these.
 *
 * Read in two halves on purpose. The header, the times and the frame offsets are read at once, so a
 * file that is not a subject track is refused when it is opened rather than half way through a
 * render; the frames themselves are decoded only when a frame is drawn, a few at a time, because a
 * minute of footage at fifteen frames a second is nine hundred grids, and a phone's preview needs two
 * of them at any moment.
 *
 * What a frame IS to a picture is [focusMask]: the grid of a clip's focus at one instant, 0..255 per
 * cell, which an engine uploads as a texture and samples bilinearly - the contract's step 4.
 */

/** What [parseSubjectTrack] refuses, and what decoding a damaged frame throws. */
export class SubjectTrackError extends Error {}

/** The JSON after the header: the [FindSubjectsResult] fields a reader that shows subjects needs. */
export interface SubjectTrackMeta {
  engine: SubjectEngine;
  kind: 'video' | 'image';
  durationMs: number;
  fps: number;
  subjects: SubjectInfo[];
}

/** Where a frame's runs are, for the one that is being decoded. */
const HEADER_BYTES = 20;

/** The most cells a grid may have: [SUBJECT_TRACK_MAGIC]'s ceiling, far past [SUBJECT_GRID] squared. */
const MAX_CELLS = 1_000_000;

/** Frames kept decoded: the pair a moment is drawn between, and the pair either side of a seek. */
const KEPT_FRAMES = 6;

export class SubjectTrack {
  /** The decoded frames last asked for, oldest first. */
  private readonly kept = new Map<number, Uint8Array>();

  /** @internal Built by [parseSubjectTrack]. */
  constructor(
    readonly width: number,
    readonly height: number,
    /** Each frame's source time, ms, strictly increasing. */
    readonly times: Uint32Array,
    /** The JSON, or null where it was missing or would not parse: a renderer never needs it. */
    readonly meta: SubjectTrackMeta | null,
    private readonly bytes: Uint8Array,
    private readonly offsets: Uint32Array,
    private readonly dataStart: number,
  ) {}

  get frameCount(): number {
    return this.times.length;
  }

  /**
   * One frame's cells, W * H subject ids row by row. The array is the track's own and is kept for the
   * next call; a caller that changes it changes the track. Throws [SubjectTrackError] for a frame
   * whose runs do not add up to the grid.
   */
  frame(index: number): Uint8Array {
    const kept = this.kept.get(index);
    if (kept) {
      // Most recently used goes last, so the first entry is always the one to let go of.
      this.kept.delete(index);
      this.kept.set(index, kept);
      return kept;
    }
    const start = this.dataStart + this.offsets[index]!;
    const end = index + 1 < this.offsets.length ? this.dataStart + this.offsets[index + 1]! : this.bytes.length;
    const cells = new Uint8Array(this.width * this.height);
    decodeRuns(this.bytes, start, end, cells);
    this.kept.set(index, cells);
    if (this.kept.size > KEPT_FRAMES) this.kept.delete(this.kept.keys().next().value!);
    return cells;
  }

  /**
   * The two frames source time `sourceMs` falls between and how far from the first to the second:
   * the contract's step 1. Before the first frame and after the last, that frame holds alone
   * (`from === to`, weight 0).
   */
  span(sourceMs: number): FrameSpan {
    const times = this.times;
    const last = times.length - 1;
    if (!(sourceMs > times[0]!)) return { from: 0, to: 0, weight: 0 };
    if (sourceMs >= times[last]!) return { from: last, to: last, weight: 0 };
    // The last frame at or before the time: a binary search, since a render asks once a frame.
    let lo = 0;
    let hi = last;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (times[mid]! <= sourceMs) lo = mid;
      else hi = mid;
    }
    const t0 = times[lo]!;
    const t1 = times[hi]!;
    return { from: lo, to: hi, weight: (sourceMs - t0) / (t1 - t0) };
  }
}

/** See [SubjectTrack.span]. */
export interface FrameSpan {
  from: number;
  to: number;
  /** 0..1 from `from` towards `to`. */
  weight: number;
}

/**
 * Reads a subject track's header and tables, refusing what [SUBJECT_TRACK_MAGIC] says a reader
 * refuses. The frames are left coded until they are asked for ([SubjectTrack.frame]).
 */
export function parseSubjectTrack(data: ArrayBuffer | Uint8Array): SubjectTrack {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_BYTES) throw new SubjectTrackError('not a subject track: too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== SUBJECT_TRACK_MAGIC) throw new SubjectTrackError('not a subject track');
  const version = bytes[4]!;
  if (version !== SUBJECT_TRACK_VERSION) throw new SubjectTrackError(`subject track version ${version} is not one this build reads`);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const frames = view.getUint32(12, true);
  const jsonBytes = view.getUint32(16, true);
  if (width === 0 || height === 0 || frames === 0) throw new SubjectTrackError('subject track has no cells or no frames');
  if (width * height > MAX_CELLS) throw new SubjectTrackError('subject track grid is too large');
  const timesAt = HEADER_BYTES + jsonBytes;
  const offsetsAt = timesAt + 4 * frames;
  const dataStart = offsetsAt + 4 * frames;
  if (dataStart > bytes.length) throw new SubjectTrackError('subject track tables run past its end');

  const times = new Uint32Array(frames);
  const offsets = new Uint32Array(frames);
  const dataLength = bytes.length - dataStart;
  for (let i = 0; i < frames; i++) {
    times[i] = view.getUint32(timesAt + 4 * i, true);
    offsets[i] = view.getUint32(offsetsAt + 4 * i, true);
    if (i > 0 && !(times[i]! > times[i - 1]!)) throw new SubjectTrackError('subject track times go back');
    if (offsets[i]! > dataLength || (i > 0 && offsets[i]! < offsets[i - 1]!)) throw new SubjectTrackError('subject track offsets go back or past its end');
  }

  return new SubjectTrack(width, height, times, readMeta(bytes.subarray(HEADER_BYTES, timesAt)), bytes, offsets, dataStart);
}

/** The JSON, read leniently: a track whose JSON is damaged still draws, it only cannot be listed. */
function readMeta(json: Uint8Array): SubjectTrackMeta | null {
  if (json.length === 0) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(json)) as Partial<SubjectTrackMeta> | null;
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.subjects)) return null;
    return {
      engine: raw.engine ?? 'mediapipe',
      kind: raw.kind === 'image' ? 'image' : 'video',
      durationMs: typeof raw.durationMs === 'number' ? raw.durationMs : 0,
      fps: typeof raw.fps === 'number' ? raw.fps : 0,
      subjects: raw.subjects,
    };
  } catch {
    return null;
  }
}

/** What [encodeSubjectTrack] writes: the grid, every frame's time and cells, and the JSON. */
export interface SubjectTrackContent {
  width: number;
  height: number;
  /** Source ms, strictly increasing, one per frame. */
  times: readonly number[];
  /** W * H subject ids each, row by row from the top-left. */
  frames: readonly Uint8Array[];
  meta: SubjectTrackMeta;
}

/** A subject track's bytes, laid out as [SUBJECT_TRACK_MAGIC] says. */
export function encodeSubjectTrack(content: SubjectTrackContent): Uint8Array {
  const { width, height, times, frames } = content;
  if (frames.length === 0 || frames.length !== times.length) throw new SubjectTrackError('a subject track needs one time per frame, and a frame');
  const json = new TextEncoder().encode(JSON.stringify(content.meta));
  const coded = frames.map(cells => {
    if (cells.length !== width * height) throw new SubjectTrackError('a frame is not the size of the grid');
    return encodeRuns(cells);
  });
  const dataLength = coded.reduce((sum, runs) => sum + runs.length, 0);
  const out = new Uint8Array(HEADER_BYTES + json.length + 8 * frames.length + dataLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = SUBJECT_TRACK_MAGIC.charCodeAt(i);
  out[4] = SUBJECT_TRACK_VERSION;
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  view.setUint32(12, frames.length, true);
  view.setUint32(16, json.length, true);
  out.set(json, HEADER_BYTES);
  let at = HEADER_BYTES + json.length;
  for (const time of times) {
    view.setUint32(at, Math.max(0, Math.round(time)), true);
    at += 4;
  }
  let offset = 0;
  for (const runs of coded) {
    view.setUint32(at, offset, true);
    at += 4;
    offset += runs.length;
  }
  for (const runs of coded) {
    out.set(runs, at);
    at += runs.length;
  }
  return out;
}

/** A frame's cells as runs: a value byte, then its run as an unsigned LEB128 varint. */
export function encodeRuns(cells: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < cells.length) {
    const value = cells[i]!;
    let run = 1;
    while (i + run < cells.length && cells[i + run] === value) run++;
    out.push(value);
    let rest = run;
    while (rest >= 0x80) {
      out.push((rest & 0x7f) | 0x80);
      rest >>>= 7;
    }
    out.push(rest);
    i += run;
  }
  return Uint8Array.from(out);
}

/**
 * Decodes the runs in `bytes[start..end)` into `out`, which they must fill exactly. Throws
 * [SubjectTrackError] for runs that stop short of it, run past it, or leave bytes over.
 */
export function decodeRuns(bytes: Uint8Array, start: number, end: number, out: Uint8Array): void {
  let at = start;
  let filled = 0;
  while (at < end) {
    const value = bytes[at++]!;
    let run = 0;
    let shift = 0;
    for (;;) {
      if (at >= end || shift > 28) throw new SubjectTrackError('a subject track frame is damaged');
      const byte = bytes[at++]!;
      run |= (byte & 0x7f) << shift;
      if (byte < 0x80) break;
      shift += 7;
    }
    if (run < 1 || filled + run > out.length) throw new SubjectTrackError('a subject track frame does not fit its grid');
    out.fill(value, filled, filled + run);
    filled += run;
  }
  if (filled !== out.length) throw new SubjectTrackError('a subject track frame does not fill its grid');
}

/**
 * How in focus every subject id is at source time `sourceMs`: entry `id` of a 256-long table, 0 for
 * the background and for every subject the focus does not list. The contract's step 2, read off the
 * keys as a camera's are read.
 */
export function focusLevels(focus: Pick<ComposeFocus, 'atMs' | 'subjects'>, sourceMs: number, out: Float32Array = new Float32Array(256)): Float32Array {
  out.fill(0);
  const at = focus.atMs;
  const n = at.length;
  if (n === 0) return out;
  // Where the instant falls: the last key at or before it - a step takes effect at its own time, so
  // of two keys at one time the later wins - and the straight line on to the next.
  let i = 0;
  while (i + 1 < n && at[i + 1]! <= sourceMs) i++;
  const between = i + 1 < n && sourceMs > at[i]! ? (sourceMs - at[i]!) / (at[i + 1]! - at[i]!) : 0;
  for (const subject of focus.subjects) {
    const values = subject.focus;
    const level = between > 0 ? values[i]! + (values[i + 1]! - values[i]!) * between : values[i]!;
    out[subject.id & 0xff] = Math.min(1, Math.max(0, level));
  }
  out[0] = 0;
  return out;
}

/**
 * The grid of a focus at one instant: each cell's `m` - the contract's step 3, the two frames either
 * side mixed by how far between them the instant is - as 0..255, ready to upload. `levels` is what
 * [focusLevels] answered for the same instant. `out` is filled and handed back, made when absent.
 */
export function focusMask(track: SubjectTrack, levels: Float32Array, sourceMs: number, invert: boolean, out: Uint8Array = new Uint8Array(track.width * track.height)): Uint8Array {
  const span = track.span(sourceMs);
  const a = track.frame(span.from);
  const cells = a.length;
  if (span.weight === 0 || span.from === span.to) {
    for (let c = 0; c < cells; c++) {
      const m = levels[a[c]!]!;
      out[c] = Math.round((invert ? 1 - m : m) * 255);
    }
    return out;
  }
  const b = track.frame(span.to);
  const w = span.weight;
  for (let c = 0; c < cells; c++) {
    const m = (1 - w) * levels[a[c]!]! + w * levels[b[c]!]!;
    out[c] = Math.round((invert ? 1 - m : m) * 255);
  }
  return out;
}
