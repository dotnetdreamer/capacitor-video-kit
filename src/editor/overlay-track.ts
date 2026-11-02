import type { OverlayTrack, TrackPin, TrackSeam } from './edit-manifest';

/**
 * A layer's track as the manifest keeps it ([OverlayTrack]), and its path as it is drawn: smoothed, and
 * read at any instant of the footage.
 *
 * What a track means on the post - where the layer is at an output instant, through whatever the clip's
 * trim, speed, crop, fit, placement and the camera do to the footage - is `track-motion.ts`, which needs
 * the timeline's arithmetic. This file does not, so the manifest reader can use it.
 */

/** How much a path is smoothed when nothing says: about two frames either way at 30 fps. */
export const DEFAULT_TRACK_SMOOTH = 0.3;

/** The widest a path is smoothed, at a [OverlayTrack.smooth] of 1: the sigma of a Gaussian, in ms. */
export const MAX_SMOOTH_MS = 250;

/**
 * The most frames one track keeps: ten minutes at 30 fps, far past anything a layer is tracked over. A
 * longer run is read at a lower rate rather than refused.
 */
export const MAX_TRACK_SAMPLES = 18_000;

/**
 * How far past a mend its seam keeps what the earlier path went on to do ([TrackSeam.then]): as far as
 * the widest smoothing reaches, three of [MAX_SMOOTH_MS]'s sigmas.
 */
export const SEAM_REACH_MS = 3 * MAX_SMOOTH_MS;

/** The most mends one path keeps. */
const MAX_TRACK_SEAMS = 100;

/** The most samples one seam keeps: [SEAM_REACH_MS] of footage at well past any phone's frame rate. */
const MAX_SEAM_SAMPLES = 256;

/** A pin's offset is kept to a hundred-thousandth of the frame: a fiftieth of a pixel on 1080p. */
const ROUND = 1e5;

/**
 * A stored track as the manifest keeps one, or `undefined` for anything that is not one. Numbers are
 * held to their ranges, samples out of time order are left out, and a track already in shape comes back
 * as the very object - so a layer patch that did not touch the track is no change to it.
 */
export function normaliseOverlayTrack(value: unknown): OverlayTrack | undefined {
  if (!isRecord(value)) return undefined;
  const clipId = value['clipId'];
  const clipKey = value['clipKey'];
  if (typeof clipId !== 'string' || !clipId || typeof clipKey !== 'string' || !clipKey) return undefined;
  const aspect = value['aspect'];
  if (!positive(aspect)) return undefined;
  const box = value['box'];
  if (!isRecord(box) || !positive(box['w']) || !positive(box['h'])) return undefined;
  const pin = value['pin'];
  if (!isRecord(pin) || !finite(pin['atMs']) || !finite(pin['dx']) || !finite(pin['dy'])) return undefined;

  const atMs = value['atMs'];
  const x = value['x'];
  const y = value['y'];
  const scale = value['scale'];
  const turn = value['turn'];
  if (!Array.isArray(atMs) || !Array.isArray(x) || !Array.isArray(y) || !Array.isArray(scale) || !Array.isArray(turn)) return undefined;
  const n = atMs.length;
  if (n === 0 || x.length !== n || y.length !== n || scale.length !== n || turn.length !== n) return undefined;

  const track: OverlayTrack = {
    clipId,
    clipKey,
    aspect: clampTo(aspect, 0.05, 20),
    box: { w: clampTo(box['w'] as number, 0.002, 2), h: clampTo(box['h'] as number, 0.002, 2) },
    atMs: [],
    x: [],
    y: [],
    scale: [],
    turn: [],
    pin: { atMs: Math.round(pin['atMs'] as number), dx: clampTo(pin['dx'] as number, -4, 4), dy: clampTo(pin['dy'] as number, -4, 4) },
  };
  const grow = pin['grow'];
  if (positive(grow) && grow !== 1) track.pin.grow = clampTo(grow, 1e-3, 1e3);
  // Every sample of every channel a finite number, and the times strictly increasing: a sample that
  // breaks either is left out rather than refusing the whole path.
  const every = Math.max(1, Math.ceil(n / MAX_TRACK_SAMPLES));
  for (let i = 0; i < n; i += every) {
    const t = atMs[i];
    const px = x[i];
    const py = y[i];
    const ps = scale[i];
    const pt = turn[i];
    if (!finite(t) || !finite(px) || !finite(py) || !positive(ps) || !finite(pt)) continue;
    const time = Math.round(t);
    if (track.atMs.length > 0 && !(time > track.atMs[track.atMs.length - 1]!)) continue;
    track.atMs.push(time);
    track.x.push(clampTo(px, -2, 3));
    track.y.push(clampTo(py, -2, 3));
    track.scale.push(clampTo(ps, 0.05, 20));
    track.turn.push(clampTo(pt, -36_000, 36_000));
  }
  if (track.atMs.length === 0) return undefined;

  const lost = normaliseLost(value['lost']);
  if (lost.length > 0) track.lost = lost;
  if (value['scaleWith'] === true) track.scaleWith = true;
  if (value['turnWith'] === true) track.turnWith = true;
  const smooth = value['smooth'];
  if (finite(smooth)) track.smooth = clampTo(Math.round(smooth * 100) / 100, 0, 1);
  const seams = normaliseSeams(value['seams'], track.atMs);
  if (seams.length > 0) track.seams = seams;

  return sameTrack(value as unknown as OverlayTrack, track) ? (value as unknown as OverlayTrack) : track;
}

/**
 * Mends in time order, each strictly inside the path - after its first sample, at or before its last -
 * with what followed it held to the same rules as the path's own samples. A seam whose `then` is not in
 * shape keeps its place and loses the rest: the parts either side are still smoothed apart.
 */
function normaliseSeams(value: unknown, atMs: readonly number[]): TrackSeam[] {
  if (!Array.isArray(value)) return [];
  const first = atMs[0]!;
  const last = atMs[atMs.length - 1]!;
  const out: TrackSeam[] = [];
  for (const item of value) {
    if (out.length >= MAX_TRACK_SEAMS) break;
    if (!isRecord(item) || !finite(item['atMs'])) continue;
    const at = Math.round(item['atMs']);
    if (!(at > first) || at > last || (out.length > 0 && !(at > out[out.length - 1]!.atMs))) continue;
    out.push({ atMs: at, then: normaliseSeamSamples(item['then'], at) });
  }
  return out;
}

function normaliseSeamSamples(value: unknown, fromMs: number): TrackSeam['then'] {
  const then: TrackSeam['then'] = { atMs: [], x: [], y: [], scale: [], turn: [] };
  if (!isRecord(value)) return then;
  const atMs = value['atMs'];
  const x = value['x'];
  const y = value['y'];
  const scale = value['scale'];
  const turn = value['turn'];
  if (!Array.isArray(atMs) || !Array.isArray(x) || !Array.isArray(y) || !Array.isArray(scale) || !Array.isArray(turn)) return then;
  const n = Math.min(atMs.length, MAX_SEAM_SAMPLES);
  if (x.length !== atMs.length || y.length !== atMs.length || scale.length !== atMs.length || turn.length !== atMs.length) return then;
  for (let i = 0; i < n; i++) {
    const t = atMs[i];
    const px = x[i];
    const py = y[i];
    const ps = scale[i];
    const pt = turn[i];
    if (!finite(t) || !finite(px) || !finite(py) || !positive(ps) || !finite(pt)) continue;
    const time = Math.round(t);
    if (time < fromMs || time > fromMs + SEAM_REACH_MS + 1) continue;
    if (then.atMs.length > 0 && !(time > then.atMs[then.atMs.length - 1]!)) continue;
    then.atMs.push(time);
    then.x.push(clampTo(px, -2, 3));
    then.y.push(clampTo(py, -2, 3));
    then.scale.push(clampTo(ps, 0.05, 20));
    then.turn.push(clampTo(pt, -36_000, 36_000));
  }
  return then;
}

/** Pairs of finite times, each pair forwards, in order; anything else left out. */
function normaliseLost(value: unknown): number[] {
  if (!Array.isArray(value)) return [];
  const out: number[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    const from = value[i];
    const to = value[i + 1];
    if (!finite(from) || !finite(to) || !(to > from)) continue;
    const a = Math.round(from);
    const b = Math.round(to);
    if (out.length > 0 && a < out[out.length - 1]!) continue;
    out.push(a, b);
  }
  return out;
}

/** Two tracks that say the same thing, key for key and sample for sample. */
export function sameTrack(a: OverlayTrack | undefined, b: OverlayTrack | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.clipId === b.clipId &&
    a.clipKey === b.clipKey &&
    a.aspect === b.aspect &&
    a.box?.w === b.box?.w &&
    a.box?.h === b.box?.h &&
    a.pin?.atMs === b.pin?.atMs &&
    a.pin?.dx === b.pin?.dx &&
    a.pin?.dy === b.pin?.dy &&
    a.pin?.grow === b.pin?.grow &&
    a.scaleWith === b.scaleWith &&
    a.turnWith === b.turnWith &&
    a.smooth === b.smooth &&
    sameArray(a.atMs, b.atMs) &&
    sameArray(a.x, b.x) &&
    sameArray(a.y, b.y) &&
    sameArray(a.scale, b.scale) &&
    sameArray(a.turn, b.turn) &&
    sameArray(a.lost ?? [], b.lost ?? []) &&
    sameSeams(a.seams ?? [], b.seams ?? []) &&
    sameKeys(a, b) &&
    sameKeys(a.box, b.box) &&
    sameKeys(a.pin, b.pin)
  );
}

function sameSeams(a: readonly TrackSeam[], b: readonly TrackSeam[]): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  // Read off what may be anything at all: [normaliseOverlayTrack] asks this of the stored value as it came.
  return a.every((seam, i) => {
    const other = b[i];
    if (!seam || !other || typeof seam !== 'object' || seam.atMs !== other.atMs || !sameKeys(seam, other)) return false;
    const p = seam.then;
    const q = other.then;
    if (!p || !q || typeof p !== 'object' || !sameKeys(p, q)) return false;
    return sameArray(p.atMs, q.atMs) && sameArray(p.x, q.x) && sameArray(p.y, q.y) && sameArray(p.scale, q.scale) && sameArray(p.turn, q.turn);
  });
}

/** No key on one that the other lacks, so a stray extra key is not normal. */
function sameKeys(a: object, b: object): boolean {
  const ka = Object.keys(a).filter(k => (a as Record<string, unknown>)[k] !== undefined);
  const kb = Object.keys(b).filter(k => (b as Record<string, unknown>)[k] !== undefined);
  return ka.length === kb.length && ka.every(k => kb.includes(k));
}

function sameArray(a: readonly unknown[] | undefined, b: readonly unknown[] | undefined): boolean {
  if (a === b) return true;
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** How much a track is smoothed: its own setting, or [DEFAULT_TRACK_SMOOTH]. */
export function trackSmooth(track: Pick<OverlayTrack, 'smooth'>): number {
  return track.smooth ?? DEFAULT_TRACK_SMOOTH;
}

/** The SOURCE span a track covers: its first sample to its last. */
export function trackedSpan(track: Pick<OverlayTrack, 'atMs'>): { fromMs: number; toMs: number } {
  return { fromMs: track.atMs[0]!, toMs: track.atMs[track.atMs.length - 1]! };
}

/** Whether the tracker could not see the thing at SOURCE time `sourceMs`. */
export function lostAt(track: Pick<OverlayTrack, 'lost'>, sourceMs: number): boolean {
  const lost = track.lost;
  if (!lost) return false;
  for (let i = 0; i + 1 < lost.length; i += 2) if (sourceMs >= lost[i]! && sourceMs <= lost[i + 1]!) return true;
  return false;
}

/** A path as it is drawn: the track's samples, smoothed. */
export interface TrackPath {
  readonly atMs: Float64Array;
  readonly x: Float64Array;
  readonly y: Float64Array;
  readonly scale: Float64Array;
  readonly turn: Float64Array;
  /** Its mends, in time order: where the samples stop being one run's and start being the next's. */
  readonly seams: readonly PathSeam[];
}

/** A mend as the drawn path has it. */
export interface PathSeam {
  /** The later run's first sample, by its index in the path. */
  readonly index: number;
  readonly atMs: number;
  /**
   * Where the earlier path was headed: its next sample before the mend, smoothed as it was then. An
   * instant between the earlier part's last sample and the seam is read toward this, as it was before the
   * mend, never toward the later run. Null where the earlier path ended there.
   */
  readonly ahead: { readonly atMs: number; readonly point: PathPoint } | null;
}

/** Where the thing is at one instant of the footage. */
export interface PathPoint {
  x: number;
  y: number;
  scale: number;
  turn: number;
}

/** Each track's smoothed path, made once per track object: the manifest replaces a track to change it. */
const paths = new WeakMap<OverlayTrack, TrackPath>();

/**
 * The path a track is drawn along: every channel smoothed in TIME, `trackSmooth * MAX_SMOOTH_MS` wide, so
 * footage of any frame rate - and of a varying one - is smoothed alike.
 *
 * Each part between mends is smoothed on its own, with what followed it before it was mended standing in
 * for what follows it now ([TrackSeam.then]): the later run never reaches back across a seam, so the
 * layer before a mend is drawn exactly where it was.
 */
export function trackPath(track: OverlayTrack): TrackPath {
  const known = paths.get(track);
  if (known) return known;
  const n = track.atMs.length;
  const atMs = Float64Array.from(track.atMs);
  const out = [new Float64Array(n), new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const sigma = trackSmooth(track) * MAX_SMOOTH_MS;
  const seams: PathSeam[] = [];
  const cuts = track.seams ?? [];
  const channels = [track.x, track.y, track.scale, track.turn];
  let start = 0;
  for (let k = 0; k <= cuts.length; k++) {
    const seam = cuts[k];
    const end = seam ? Math.max(start, lowerBound(track.atMs, seam.atMs)) : n;
    const then = seam?.then;
    const own = end - start;
    const extra = then?.atMs.length ?? 0;
    const times = new Float64Array(own + extra);
    const raw = [new Float64Array(own + extra), new Float64Array(own + extra), new Float64Array(own + extra), new Float64Array(own + extra)];
    const after = then ? [then.x, then.y, then.scale, then.turn] : null;
    for (let i = 0; i < own; i++) {
      times[i] = track.atMs[start + i]!;
      for (let c = 0; c < 4; c++) raw[c]![i] = channels[c]![start + i]!;
    }
    for (let i = 0; i < extra; i++) {
      times[own + i] = then!.atMs[i]!;
      for (let c = 0; c < 4; c++) raw[c]![own + i] = after![c]![i]!;
    }
    const smoothed = smoothSeries(times, raw, sigma);
    for (let c = 0; c < 4; c++) out[c]!.set(smoothed[c]!.subarray(0, own), start);
    if (seam) {
      const ahead =
        extra > 0 && own > 0 ? { atMs: times[own]!, point: { x: smoothed[0]![own]!, y: smoothed[1]![own]!, scale: smoothed[2]![own]!, turn: smoothed[3]![own]! } } : null;
      seams.push({ index: end, atMs: seam.atMs, ahead });
    }
    start = end;
  }
  const path: TrackPath = { atMs, x: out[0]!, y: out[1]!, scale: out[2]!, turn: out[3]!, seams };
  paths.set(track, path);
  return path;
}

/**
 * Samples smoothed in time: at each one a straight line fitted to its neighbours, weighted by a Gaussian
 * of `sigma` ms, and read where the sample is. In the middle of a run that is the Gaussian's weighted mean;
 * at an end, where the neighbours are all on one side, the mean would drag the point toward them - ahead of
 * the thing at a run's first frame, behind it at its last - and the line does not: a steady move is
 * smoothed onto itself all the way to the end. A lone sample, or two at almost one instant, take the mean.
 */
function smoothSeries(times: Float64Array, channels: Float64Array[], sigma: number): Float64Array[] {
  const n = times.length;
  if (!(sigma > 1) || n < 3) return channels.map(values => Float64Array.from(values));
  const reach = 3 * sigma;
  const inv = 1 / (2 * sigma * sigma);
  const out = channels.map(() => new Float64Array(n));
  const m = channels.length;
  const t0 = new Float64Array(m);
  const t1 = new Float64Array(m);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const t = times[i]!;
    while (t - times[lo]! > reach) lo++;
    if (hi < i) hi = i;
    while (hi + 1 < n && times[hi + 1]! - t <= reach) hi++;
    let s0 = 0;
    let s1 = 0;
    let s2 = 0;
    t0.fill(0);
    t1.fill(0);
    for (let j = lo; j <= hi; j++) {
      const d = times[j]! - t;
      const w = Math.exp(-d * d * inv);
      s0 += w;
      s1 += w * d;
      s2 += w * d * d;
      for (let c = 0; c < m; c++) {
        const v = channels[c]![j]!;
        t0[c]! += w * v;
        t1[c]! += w * d * v;
      }
    }
    const det = s0 * s2 - s1 * s1;
    const line = s2 > 0 && det > 1e-6 * s0 * s2;
    for (let c = 0; c < m; c++) out[c]![i] = line ? (s2 * t0[c]! - s1 * t1[c]!) / det : t0[c]! / s0;
  }
  // A line read at an end can dip a size: never to nothing.
  const scale = out[2];
  if (scale) for (let i = 0; i < n; i++) if (!(scale[i]! >= 0.05)) scale[i] = 0.05;
  return out;
}

/** The first index of `sorted` at or after `value`, its length when there is none. */
function lowerBound(sorted: ArrayLike<number>, value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Where the path has the thing at SOURCE time `sourceMs`: a straight line between the frames either
 * side, the first frame held before it and the last after it.
 */
export function pathAt(path: TrackPath, sourceMs: number): PathPoint {
  const at = path.atMs;
  const n = at.length;
  if (!(sourceMs > at[0]!)) return pointAt(path, 0);
  if (sourceMs >= at[n - 1]!) return pointAt(path, n - 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! <= sourceMs) lo = mid;
    else hi = mid;
  }
  // Across a mend: before the seam the earlier path, read on toward where it was headed; from it, the later.
  const seam = path.seams.length > 0 ? path.seams.find(s => s.index === hi) : undefined;
  if (seam) {
    if (sourceMs >= seam.atMs) return pointAt(path, hi);
    const ahead = seam.ahead;
    if (!ahead || !(ahead.atMs > at[lo]!)) return pointAt(path, lo);
    return between(pointAt(path, lo), ahead.point, Math.min(1, (sourceMs - at[lo]!) / (ahead.atMs - at[lo]!)));
  }
  return between(pointAt(path, lo), pointAt(path, hi), (sourceMs - at[lo]!) / (at[hi]! - at[lo]!));
}

function between(a: PathPoint, b: PathPoint, f: number): PathPoint {
  return {
    x: a.x + (b.x - a.x) * f,
    y: a.y + (b.y - a.y) * f,
    scale: a.scale + (b.scale - a.scale) * f,
    turn: a.turn + (b.turn - a.turn) * f,
  };
}

function pointAt(path: TrackPath, i: number): PathPoint {
  return { x: path.x[i]!, y: path.y[i]!, scale: path.scale[i]!, turn: path.turn[i]! };
}

/**
 * `track`'s samples and mends before SOURCE ms `atMs`, and a seam there for a later run to start at: the
 * path cut where a mend begins. The seam keeps what the part being cut went on to do - its own samples on
 * from `atMs`, then what ITS seam kept, where it ends within reach - so the part is smoothed with exactly
 * what it was smoothed with before, and drawn where it was. Nothing before the path's first sample is a
 * cut at all: no samples, no seam.
 */
export function cutTrackAt(track: OverlayTrack, atMs: number): Pick<OverlayTrack, 'atMs' | 'x' | 'y' | 'scale' | 'turn'> & { seams: TrackSeam[] } {
  const cut = lowerBound(track.atMs, atMs);
  const kept = {
    atMs: track.atMs.slice(0, cut),
    x: track.x.slice(0, cut),
    y: track.y.slice(0, cut),
    scale: track.scale.slice(0, cut),
    turn: track.turn.slice(0, cut),
    seams: (track.seams ?? []).filter(seam => seam.atMs < atMs),
  };
  if (cut === 0) return kept;
  const reach = atMs + SEAM_REACH_MS;
  const then: TrackSeam['then'] = { atMs: [], x: [], y: [], scale: [], turn: [] };
  const take = (from: Pick<OverlayTrack, 'atMs' | 'x' | 'y' | 'scale' | 'turn'>, i: number) => {
    then.atMs.push(from.atMs[i]!);
    then.x.push(from.x[i]!);
    then.y.push(from.y[i]!);
    then.scale.push(from.scale[i]!);
    then.turn.push(from.turn[i]!);
  };
  // The part `atMs` is cut out of ends at the first mend at or after it.
  const next = (track.seams ?? []).find(seam => seam.atMs >= atMs);
  const end = next ? next.atMs : Infinity;
  for (let i = cut; i < track.atMs.length && track.atMs[i]! < end && track.atMs[i]! <= reach; i++) take(track, i);
  if (next) for (let i = 0; i < next.then.atMs.length && next.then.atMs[i]! <= reach; i++) take(next.then, i);
  kept.seams.push({ atMs: Math.round(atMs), then });
  return kept;
}

/**
 * The layer's centre in the SOURCE at `sourceMs`, as fractions of the source: the thing's middle there,
 * plus the pin's offset grown and turned with the thing as far as the layer follows it - and how much
 * the layer is drawn bigger than its own `scale` (what it has grown with the thing since the pin, times
 * the pin's own [TrackPin.grow]) and turned past its own angle. The offset is turned in PIXELS, since a
 * fraction of the width is not a fraction of the height, and back.
 */
export function pinnedPoint(track: OverlayTrack, path: TrackPath, sourceMs: number): { x: number; y: number; scale: number; turn: number } {
  const here = pathAt(path, sourceMs);
  const there = pathAt(path, track.pin.atMs);
  const grown = track.scaleWith ? here.scale / there.scale : 1;
  const turn = track.turnWith ? here.turn - there.turn : 0;
  const rad = (turn * Math.PI) / 180;
  const cos = Math.cos(rad) * grown;
  const sin = Math.sin(rad) * grown;
  // In units of the source's height, where the two axes are the same size.
  const ox = track.pin.dx * track.aspect;
  const oy = track.pin.dy;
  return {
    x: here.x + (ox * cos - oy * sin) / track.aspect,
    y: here.y + ox * sin + oy * cos,
    scale: grown * (track.pin.grow ?? 1),
    turn,
  };
}

/**
 * The pin that puts the layer's centre at source point (`x`, `y`) at `sourceMs`, against the thing as it
 * is THEN - so the layer's own angle, and its own scale times `grow`, are its drawn ones at that instant.
 */
export function pinAt(path: TrackPath, sourceMs: number, x: number, y: number, grow = 1): TrackPin {
  const here = pathAt(path, sourceMs);
  const pin: TrackPin = { atMs: Math.round(sourceMs), dx: roundFraction(x - here.x), dy: roundFraction(y - here.y) };
  if (grow !== 1) pin.grow = grow;
  return pin;
}

function roundFraction(value: number): number {
  return Math.round(value * ROUND) / ROUND + 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function finite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function positive(value: unknown): value is number {
  return finite(value) && value > 0;
}

function clampTo(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
