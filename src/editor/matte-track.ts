import { MATTE_TRACK_MAGIC, MATTE_TRACK_VERSION, type ComposeRect, type MatteEngine, type MatteTarget } from '../video-composer/definitions';
import type { FrameSpan } from './subject-track';

/**
 * A matte track, the file `findMatte` writes: how sure the segmenter was, cell by cell and frame by
 * frame, that the footage's subject is there. [MATTE_TRACK_MAGIC] has the layout; this is its one
 * reader and its one writer on the web side, and the native engines' are ports of these.
 *
 * Read in two halves, as a subject track is: the header, the times and the frame offsets at once, so
 * a file that is not a matte track is refused when it is opened; a frame only when it is drawn, a few
 * kept at a time, because a minute of footage is six hundred grids and a frame of the preview needs
 * two of them.
 *
 * What a frame IS to a picture is [matteAt]: the grid at one instant, the two frames either side mixed
 * - the contract's step 2 - which an engine uploads as a texture and refines against the frame.
 */

/** What [parseMatteTrack] refuses, and what decoding a damaged frame throws. */
export class MatteTrackError extends Error {}

/** The JSON after the header: the [FindMatteResult] fields a reader that shows a matte needs. */
export interface MatteTrackMeta {
  engine: MatteEngine;
  kind: 'video' | 'image';
  target: MatteTarget;
  durationMs: number;
  fps: number;
  coverage: number;
  box?: ComposeRect;
}

const HEADER_BYTES = 20;

/** The most cells a grid may have: [MATTE_TRACK_MAGIC]'s ceiling, 2048 squared. */
export const MAX_MATTE_CELLS = 4_194_304;

/** Frames kept decoded: the pair a moment is drawn between, and the pair either side of a seek. */
const KEPT_FRAMES = 6;

/** A cell at this certainty or above is the subject's, for [summariseMatte]: the segmenter's even odds. */
const SUBJECT_AT = 128;

export class MatteTrack {
  /** The decoded frames last asked for, oldest first. */
  private readonly kept = new Map<number, Uint8Array>();

  /** @internal Built by [parseMatteTrack]. */
  constructor(
    readonly width: number,
    readonly height: number,
    /** Each frame's source time, ms, strictly increasing. */
    readonly times: Uint32Array,
    /** The JSON, or null where it was missing or would not parse: a renderer never needs it. */
    readonly meta: MatteTrackMeta | null,
    private readonly bytes: Uint8Array,
    private readonly offsets: Uint32Array,
    private readonly dataStart: number,
  ) {}

  get frameCount(): number {
    return this.times.length;
  }

  /**
   * One frame's cells, W * H certainties row by row. The array is the track's own and is kept for the
   * next call; a caller that changes it changes the track. Throws [MatteTrackError] for a frame whose
   * packets do not fill the grid.
   */
  frame(index: number): Uint8Array {
    const kept = this.kept.get(index);
    if (kept) {
      // Most recently used goes last, so the first entry is always the one to let go of.
      this.kept.delete(index);
      this.kept.set(index, kept);
      return kept;
    }
    const cells = new Uint8Array(this.width * this.height);
    decodeMattePackets(this.bytes, this.frameStart(index), this.frameEnd(index), cells);
    this.kept.set(index, cells);
    if (this.kept.size > KEPT_FRAMES) this.kept.delete(this.kept.keys().next().value!);
    return cells;
  }

  /**
   * Decodes every frame once, into nothing kept, so a damaged one is refused now rather than half way
   * through a render that would meet it with no clip to name.
   */
  checkFrames(): void {
    const scratch = new Uint8Array(this.width * this.height);
    for (let i = 0; i < this.frameCount; i++) decodeMattePackets(this.bytes, this.frameStart(i), this.frameEnd(i), scratch);
  }

  /**
   * The two frames source time `sourceMs` falls between and how far from the first to the second: the
   * contract's step 1, a subject track's arithmetic. Before the first frame and after the last, that
   * frame holds alone (`from === to`, weight 0).
   */
  span(sourceMs: number): FrameSpan {
    const times = this.times;
    const last = times.length - 1;
    if (!(sourceMs > times[0]!)) return { from: 0, to: 0, weight: 0 };
    if (sourceMs >= times[last]!) return { from: last, to: last, weight: 0 };
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

  private frameStart(index: number): number {
    return this.dataStart + this.offsets[index]!;
  }

  private frameEnd(index: number): number {
    return index + 1 < this.offsets.length ? this.dataStart + this.offsets[index + 1]! : this.bytes.length;
  }
}

/**
 * Reads a matte track's header and tables, refusing what [MATTE_TRACK_MAGIC] says a reader refuses.
 * The frames are left coded until they are asked for ([MatteTrack.frame]).
 */
export function parseMatteTrack(data: ArrayBuffer | Uint8Array): MatteTrack {
  const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
  if (bytes.length < HEADER_BYTES) throw new MatteTrackError('not a matte track: too short');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const magic = String.fromCharCode(bytes[0]!, bytes[1]!, bytes[2]!, bytes[3]!);
  if (magic !== MATTE_TRACK_MAGIC) throw new MatteTrackError('not a matte track');
  const version = bytes[4]!;
  if (version !== MATTE_TRACK_VERSION) throw new MatteTrackError(`matte track version ${version} is not one this build reads`);
  const width = view.getUint16(6, true);
  const height = view.getUint16(8, true);
  const frames = view.getUint32(12, true);
  const jsonBytes = view.getUint32(16, true);
  if (width === 0 || height === 0 || frames === 0) throw new MatteTrackError('matte track has no cells or no frames');
  if (width * height > MAX_MATTE_CELLS) throw new MatteTrackError('matte track grid is too large');
  const timesAt = HEADER_BYTES + jsonBytes;
  const offsetsAt = timesAt + 4 * frames;
  const dataStart = offsetsAt + 4 * frames;
  if (dataStart > bytes.length) throw new MatteTrackError('matte track tables run past its end');

  const times = new Uint32Array(frames);
  const offsets = new Uint32Array(frames);
  const dataLength = bytes.length - dataStart;
  for (let i = 0; i < frames; i++) {
    times[i] = view.getUint32(timesAt + 4 * i, true);
    offsets[i] = view.getUint32(offsetsAt + 4 * i, true);
    if (i > 0 && !(times[i]! > times[i - 1]!)) throw new MatteTrackError('matte track times go back');
    if (offsets[i]! > dataLength || (i > 0 && offsets[i]! < offsets[i - 1]!)) throw new MatteTrackError('matte track offsets go back or past its end');
  }
  return new MatteTrack(width, height, times, readMeta(bytes.subarray(HEADER_BYTES, timesAt)), bytes, offsets, dataStart);
}

/** The JSON, read leniently: a track whose JSON is damaged still draws, it only cannot be described. */
function readMeta(json: Uint8Array): MatteTrackMeta | null {
  if (json.length === 0) return null;
  try {
    const raw = JSON.parse(new TextDecoder().decode(json)) as Partial<MatteTrackMeta> | null;
    if (!raw || typeof raw !== 'object') return null;
    const meta: MatteTrackMeta = {
      engine: raw.engine ?? 'mediapipe',
      kind: raw.kind === 'image' ? 'image' : 'video',
      target: raw.target === 'people' ? 'people' : 'subject',
      durationMs: finite(raw.durationMs),
      fps: finite(raw.fps),
      coverage: finite(raw.coverage),
    };
    const box = raw.box;
    if (box && typeof box === 'object') meta.box = { x: finite(box.x), y: finite(box.y), w: finite(box.w), h: finite(box.h) };
    return meta;
  } catch {
    return null;
  }
}

function finite(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/** What [encodeMatteTrack] writes: the grid, every frame's time and cells, and the JSON. */
export interface MatteTrackContent {
  width: number;
  height: number;
  /** Source ms, strictly increasing, one per frame. */
  times: readonly number[];
  /** W * H certainties each, 0..255, row by row from the top-left. */
  frames: readonly Uint8Array[];
  meta: MatteTrackMeta;
}

/** A matte track's bytes, laid out as [MATTE_TRACK_MAGIC] says. */
export function encodeMatteTrack(content: MatteTrackContent): Uint8Array {
  const { width, height, times, frames } = content;
  if (frames.length === 0 || frames.length !== times.length) throw new MatteTrackError('a matte track needs one time per frame, and a frame');
  const json = new TextEncoder().encode(JSON.stringify(content.meta));
  const coded = frames.map(cells => {
    if (cells.length !== width * height) throw new MatteTrackError('a frame is not the size of the grid');
    return encodeMattePackets(cells);
  });
  const dataLength = coded.reduce((sum, packets) => sum + packets.length, 0);
  const out = new Uint8Array(HEADER_BYTES + json.length + 8 * frames.length + dataLength);
  const view = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = MATTE_TRACK_MAGIC.charCodeAt(i);
  out[4] = MATTE_TRACK_VERSION;
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
  for (const packets of coded) {
    view.setUint32(at, offset, true);
    at += 4;
    offset += packets.length;
  }
  for (const packets of coded) {
    out.set(packets, at);
    at += packets.length;
  }
  return out;
}

/** The shortest repeat a run packet is worth: two bytes of packet for three or more cells. */
const MIN_RUN = 3;

/**
 * A frame's cells as packets: a varint `count << 1 | 1` and a byte for a run of at least [MIN_RUN],
 * a varint `count << 1` and the bytes themselves for everything between runs.
 */
export function encodeMattePackets(cells: Uint8Array): Uint8Array {
  let out = new Uint8Array(cells.length + (cells.length >> 4) + 16);
  let at = 0;
  const room = (bytes: number): void => {
    if (at + bytes <= out.length) return;
    const bigger = new Uint8Array(Math.max(out.length * 2, at + bytes));
    bigger.set(out.subarray(0, at));
    out = bigger;
  };
  const varint = (value: number): void => {
    room(5);
    let rest = value;
    while (rest >= 0x80) {
      out[at++] = (rest & 0x7f) | 0x80;
      rest = Math.floor(rest / 128);
    }
    out[at++] = rest;
  };
  let literalFrom = 0;
  const flushLiterals = (to: number): void => {
    const count = to - literalFrom;
    if (count <= 0) return;
    varint(count * 2);
    room(count);
    out.set(cells.subarray(literalFrom, to), at);
    at += count;
  };
  let i = 0;
  while (i < cells.length) {
    const value = cells[i]!;
    let run = 1;
    while (i + run < cells.length && cells[i + run] === value) run++;
    if (run >= MIN_RUN) {
      flushLiterals(i);
      varint(run * 2 + 1);
      room(1);
      out[at++] = value;
      literalFrom = i + run;
    }
    i += run;
  }
  flushLiterals(cells.length);
  return out.slice(0, at);
}

/**
 * Decodes the packets in `bytes[start..end)` into `out`, which they must fill exactly. Throws
 * [MatteTrackError] for packets that stop short of it, run past it, or leave bytes over.
 */
export function decodeMattePackets(bytes: Uint8Array, start: number, end: number, out: Uint8Array): void {
  let at = start;
  let filled = 0;
  while (at < end) {
    let n = 0;
    let scale = 1;
    for (let shift = 0; ; shift += 7) {
      if (at >= end || shift > 28) throw new MatteTrackError('a matte track frame is damaged');
      const byte = bytes[at++]!;
      // Multiplied rather than shifted, so a count past 2^30 cannot turn negative on the way.
      n += (byte & 0x7f) * scale;
      scale *= 128;
      if (byte < 0x80) break;
    }
    const count = Math.floor(n / 2);
    // Against the room left rather than added to what is filled, which a count near the ceiling would wrap.
    if (count < 1 || count > out.length - filled) throw new MatteTrackError('a matte track frame does not fit its grid');
    if (n % 2 === 1) {
      if (at >= end) throw new MatteTrackError('a matte track frame is damaged');
      out.fill(bytes[at++]!, filled, filled + count);
    } else {
      if (count > end - at) throw new MatteTrackError('a matte track frame is damaged');
      out.set(bytes.subarray(at, at + count), filled);
      at += count;
    }
    filled += count;
  }
  if (filled !== out.length) throw new MatteTrackError('a matte track frame does not fill its grid');
}

/**
 * The grid at source time `sourceMs` - the contract's step 2, the two frames either side mixed by how
 * far between them the instant is - as 0..255 a cell, rounded, ready to upload. `out` is filled and
 * handed back, made when absent.
 */
export function matteAt(track: MatteTrack, sourceMs: number, out: Uint8Array = new Uint8Array(track.width * track.height)): Uint8Array {
  const span = track.span(sourceMs);
  const a = track.frame(span.from);
  if (span.weight === 0 || span.from === span.to) {
    out.set(a);
    return out;
  }
  const b = track.frame(span.to);
  const w = span.weight;
  const cells = a.length;
  for (let c = 0; c < cells; c++) out[c] = Math.round((1 - w) * a[c]! + w * b[c]!);
  return out;
}

/** A grid for a `width` x `height` frame: `longSide` cells on its longer side, the other in proportion, at least 1. */
export function matteGrid(width: number, height: number, longSide: number): { width: number; height: number } {
  if (!(width > 0) || !(height > 0)) return { width: longSide, height: longSide };
  const scale = longSide / Math.max(width, height);
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * How much of the frame the subject covers on average, and where it is over the whole footage - the
 * `coverage` and `box` a track's JSON carries - from its frames, a cell at even odds or above being
 * the subject's. No box where there was nothing.
 */
export function summariseMatte(frames: readonly Uint8Array[], width: number, height: number): { coverage: number; box?: ComposeRect } {
  let covered = 0;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;
  for (const cells of frames) {
    for (let y = 0, c = 0; y < height; y++) {
      for (let x = 0; x < width; x++, c++) {
        if (cells[c]! < SUBJECT_AT) continue;
        covered++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  const total = frames.length * width * height;
  if (maxX < 0 || total === 0) return { coverage: 0 };
  return {
    coverage: round4(covered / total),
    box: { x: round4(minX / width), y: round4(minY / height), w: round4((maxX + 1 - minX) / width), h: round4((maxY + 1 - minY) / height) },
  };
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
