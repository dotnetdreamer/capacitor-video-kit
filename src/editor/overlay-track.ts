import type { EditTrack, OverlayFollow, TrackPin, TrackSeam } from './edit-manifest';

/**
 * A track as the manifest keeps it ([EditTrack]) - a thing in the footage, a layer of its own that any
 * number of other layers follow ([OverlayFollow]) - and its path as it is drawn: smoothed, and read at any
 * instant of the footage.
 *
 * What a track means on the post - where a following layer is at an output instant, through whatever the
 * clip's trim, speed, crop, fit, placement and the camera do to the footage - is `track-motion.ts`, which
 * needs the timeline's arithmetic. This file does not, so the manifest reader can use it.
 */

/** How much a path is smoothed when nothing says: about two frames either way at 30 fps. */
export const DEFAULT_TRACK_SMOOTH = 0.3;

/** The widest a path is smoothed, at a [EditTrack.smooth] of 1: the sigma of a Gaussian, in ms. */
export const MAX_SMOOTH_MS = 250;

/** The most tracks one post keeps: more things than anyone follows in one short video. */
export const MAX_TRACKS = 8;

/** How many colours a track can be drawn in: [EditTrack.hue] is one of `0 .. TRACK_HUES - 1`. */
export const TRACK_HUES = 6;

/** The longest name a track keeps, in characters. */
export const MAX_TRACK_NAME = 24;

/** Below this [EditTrack.sure] a sample is one the tracker was unsure of: drawn amber, and a spot to check. */
export const UNSURE_BELOW = 50;

/** A weak stretch shorter than this is the tracker's ordinary wobble, not a spot to check. */
export const MIN_WEAK_MS = 150;

/** Two weak stretches nearer than this are one spot to check. */
const WEAK_JOIN_MS = 300;

/** How long a mend takes to hand over from the old path to the new one, and back, at either end. */
export const MEND_BLEND_MS = 300;

/**
 * How long the thing keeps going after it was last seen, past a stretch with no sighting after it: its
 * speed falls away with this time constant, so it drifts to a stop rather than flying off the frame.
 */
const COAST_TAU_MS = 400;

/** The longest look back (or ahead) for the speed a lost stretch starts (or ends) with. */
const SPEED_REACH_MS = 300;

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
 * held to their ranges, samples out of time order are left out - their sureness with them - and a track
 * already in shape comes back as the very object, so a patch that did not touch the track is no change.
 */
export function normaliseEditTrack(value: unknown): EditTrack | undefined {
  if (!isRecord(value)) return undefined;
  const id = value['id'];
  if (typeof id !== 'string' || !id) return undefined;
  const clipId = value['clipId'];
  const clipKey = value['clipKey'];
  if (typeof clipId !== 'string' || !clipId || typeof clipKey !== 'string' || !clipKey) return undefined;
  const aspect = value['aspect'];
  if (!positive(aspect)) return undefined;
  const box = value['box'];
  if (!isRecord(box) || !positive(box['w']) || !positive(box['h'])) return undefined;

  const atMs = value['atMs'];
  const x = value['x'];
  const y = value['y'];
  const scale = value['scale'];
  const turn = value['turn'];
  if (!Array.isArray(atMs) || !Array.isArray(x) || !Array.isArray(y) || !Array.isArray(scale) || !Array.isArray(turn)) return undefined;
  const n = atMs.length;
  if (n === 0 || x.length !== n || y.length !== n || scale.length !== n || turn.length !== n) return undefined;
  const sureIn = value['sure'];
  const sures = Array.isArray(sureIn) && sureIn.length === n ? sureIn : null;

  const name = value['name'];
  const hue = value['hue'];
  const track: EditTrack = {
    id,
    name: trackName(name),
    hue: finite(hue) ? (((Math.round(hue) % TRACK_HUES) + TRACK_HUES) % TRACK_HUES) + 0 : 0,
    clipId,
    clipKey,
    aspect: clampTo(aspect, 0.05, 20),
    box: { w: clampTo(box['w'] as number, 0.002, 2), h: clampTo(box['h'] as number, 0.002, 2) },
    atMs: [],
    x: [],
    y: [],
    scale: [],
    turn: [],
  };
  const sure: number[] = [];
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
    const s = sures?.[i];
    sure.push(finite(s) ? clampTo(Math.round(s), 0, 100) : 100);
  }
  if (track.atMs.length === 0) return undefined;
  // Sure throughout is the same as saying nothing, which is how a track from before version 21 reads.
  if (sure.some(s => s < 100)) track.sure = sure;

  const lost = normaliseLost(value['lost']);
  if (lost.length > 0) track.lost = lost;
  const smooth = value['smooth'];
  if (finite(smooth)) track.smooth = clampTo(Math.round(smooth * 100) / 100, 0, 1);
  const seams = normaliseSeams(value['seams'], track.atMs);
  if (seams.length > 0) track.seams = seams;

  return sameTrack(value as unknown as EditTrack, track) ? (value as unknown as EditTrack) : track;
}

/** "Track 1", "Track 2", ...: the name a new track lands with, the lowest number no track of the post is called. */
export function nextTrackName(tracks: readonly Pick<EditTrack, 'name'>[]): string {
  const taken = new Set(tracks.map(t => t.name));
  for (let n = 1; ; n++) if (!taken.has(`Track ${n}`)) return `Track ${n}`;
}

/**
 * The colour a new track lands with: the one the fewest of the post's tracks are drawn in, the first such,
 * so two tracks are never one colour while another is free.
 */
export function nextTrackHue(tracks: readonly Pick<EditTrack, 'hue'>[]): number {
  const used = new Array<number>(TRACK_HUES).fill(0);
  for (const t of tracks) if (t.hue >= 0 && t.hue < TRACK_HUES) used[t.hue] = used[t.hue]! + 1;
  let best = 0;
  for (let h = 1; h < TRACK_HUES; h++) if (used[h]! < used[best]!) best = h;
  return best;
}

/** A track's name as it is kept: trimmed, at most [MAX_TRACK_NAME] characters, "Track" when there is none. */
export function trackName(value: unknown): string {
  const name = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim().slice(0, MAX_TRACK_NAME).trim() : '';
  return name || 'Track';
}

/**
 * How a layer follows a track, or `undefined` for anything that is not a follow. A follow already in shape
 * comes back as the very object. Whether its track exists is the manifest's to say, not this.
 */
export function normaliseOverlayFollow(value: unknown): OverlayFollow | undefined {
  if (!isRecord(value)) return undefined;
  const trackId = value['trackId'];
  if (typeof trackId !== 'string' || !trackId) return undefined;
  const pin = normalisePin(value['pin']);
  if (!pin) return undefined;
  const follow: OverlayFollow = { trackId, pin };
  if (value['scaleWith'] === true) follow.scaleWith = true;
  if (value['turnWith'] === true) follow.turnWith = true;
  return sameFollow(value as unknown as OverlayFollow, follow) ? (value as unknown as OverlayFollow) : follow;
}

function normalisePin(value: unknown): TrackPin | undefined {
  if (!isRecord(value) || !finite(value['atMs']) || !finite(value['dx']) || !finite(value['dy'])) return undefined;
  const pin: TrackPin = { atMs: Math.round(value['atMs']), dx: clampTo(value['dx'], -4, 4), dy: clampTo(value['dy'], -4, 4) };
  const grow = value['grow'];
  if (positive(grow) && grow !== 1) pin.grow = clampTo(grow, 1e-3, 1e3);
  return pin;
}

/**
 * A version-20 layer's own `track` - its path and the layer's pin in one - as the track it becomes, with
 * the id, name and colour given, and the layer's follow of it. What the manifest reader makes of a draft
 * written before tracks were layers of their own. `undefined` for anything that was not one.
 */
export function splitLayerTrack(value: unknown, id: string, name: string, hue: number): { track: EditTrack; follow: OverlayFollow } | undefined {
  if (!isRecord(value)) return undefined;
  const { pin: rawPin, scaleWith, turnWith, ...path } = value;
  const track = normaliseEditTrack({ ...path, id, name, hue });
  const pin = normalisePin(rawPin);
  if (!track || !pin) return undefined;
  const follow: OverlayFollow = { trackId: id, pin };
  if (scaleWith === true) follow.scaleWith = true;
  if (turnWith === true) follow.turnWith = true;
  return { track, follow };
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
export function sameTrack(a: EditTrack | undefined, b: EditTrack | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    a.id === b.id &&
    a.name === b.name &&
    a.hue === b.hue &&
    a.clipId === b.clipId &&
    a.clipKey === b.clipKey &&
    a.aspect === b.aspect &&
    a.box?.w === b.box?.w &&
    a.box?.h === b.box?.h &&
    a.smooth === b.smooth &&
    sameArray(a.atMs, b.atMs) &&
    sameArray(a.x, b.x) &&
    sameArray(a.y, b.y) &&
    sameArray(a.scale, b.scale) &&
    sameArray(a.turn, b.turn) &&
    sameArray(a.sure ?? [], b.sure ?? []) &&
    sameArray(a.lost ?? [], b.lost ?? []) &&
    sameSeams(a.seams ?? [], b.seams ?? []) &&
    sameKeys(a, b) &&
    sameKeys(a.box, b.box)
  );
}

/** Two follows that say the same thing. */
export function sameFollow(a: OverlayFollow | undefined, b: OverlayFollow | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  return (
    a.trackId === b.trackId &&
    a.pin?.atMs === b.pin?.atMs &&
    a.pin?.dx === b.pin?.dx &&
    a.pin?.dy === b.pin?.dy &&
    a.pin?.grow === b.pin?.grow &&
    a.scaleWith === b.scaleWith &&
    a.turnWith === b.turnWith &&
    sameKeys(a, b) &&
    !!a.pin &&
    !!b.pin &&
    typeof a.pin === 'object' &&
    typeof b.pin === 'object' &&
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
export function trackSmooth(track: Pick<EditTrack, 'smooth'>): number {
  return track.smooth ?? DEFAULT_TRACK_SMOOTH;
}

/** The SOURCE span a track covers: its first sample to its last. */
export function trackedSpan(track: Pick<EditTrack, 'atMs'>): { fromMs: number; toMs: number } {
  return { fromMs: track.atMs[0]!, toMs: track.atMs[track.atMs.length - 1]! };
}

/** Whether the tracker could not see the thing at SOURCE time `sourceMs`. */
export function lostAt(track: Pick<EditTrack, 'lost'>, sourceMs: number): boolean {
  const lost = track.lost;
  if (!lost) return false;
  for (let i = 0; i + 1 < lost.length; i += 2) if (sourceMs >= lost[i]! && sourceMs <= lost[i + 1]!) return true;
  return false;
}

/** How sure the tracker was of the thing at SOURCE time `sourceMs`, 0..1: the nearer sample's, 0 where it was lost. */
export function sureAt(track: Pick<EditTrack, 'atMs' | 'sure' | 'lost'>, sourceMs: number): number {
  if (lostAt(track, sourceMs)) return 0;
  const sure = track.sure;
  if (!sure) return 1;
  const i = Math.min(track.atMs.length - 1, lowerBound(track.atMs, sourceMs));
  const j = i > 0 && Math.abs(track.atMs[i - 1]! - sourceMs) < Math.abs(track.atMs[i]! - sourceMs) ? i - 1 : i;
  return (sure[j] ?? 100) / 100;
}

/** How well a stretch of a track was followed: seen and sure, seen but unsure, or not seen at all. */
export type TrackHealth = 'sure' | 'unsure' | 'lost';

/** One stretch of a track at one [TrackHealth], in SOURCE ms. */
export interface TrackHealthSpan {
  fromMs: number;
  toMs: number;
  health: TrackHealth;
}

/**
 * A track's whole span as stretches of one health each, in time order and touching: what the timeline
 * colours the track's row by. A track that says nothing of how sure it was is sure where it was seen.
 */
export function trackHealth(track: Pick<EditTrack, 'atMs' | 'sure' | 'lost'>): TrackHealthSpan[] {
  const at = track.atMs;
  const n = at.length;
  const out: TrackHealthSpan[] = [];
  const healthOf = (i: number): TrackHealth => (lostAt(track, at[i]!) ? 'lost' : (track.sure?.[i] ?? 100) < UNSURE_BELOW ? 'unsure' : 'sure');
  for (let i = 0; i < n; i++) {
    const health = healthOf(i);
    // Each sample stands for the time up to halfway to its neighbours.
    const fromMs = i === 0 ? at[0]! : (at[i - 1]! + at[i]!) / 2;
    const toMs = i === n - 1 ? at[n - 1]! : (at[i]! + at[i + 1]!) / 2;
    const last = out[out.length - 1];
    if (last && last.health === health) last.toMs = toMs;
    else out.push({ fromMs, toMs, health });
  }
  return out;
}

/** A stretch of a track worth a second look: where it lost the thing, or was unsure of it. */
export interface WeakSpot {
  fromMs: number;
  toMs: number;
  /** Some of it was not seen at all. */
  lost: boolean;
}

/**
 * The spots of a track worth a second look, in time order, in SOURCE ms: its unsure and lost stretches,
 * near ones joined into one and the tracker's ordinary wobble - a stretch under [MIN_WEAK_MS] - left out.
 */
export function weakSpots(track: Pick<EditTrack, 'atMs' | 'sure' | 'lost'>): WeakSpot[] {
  const out: WeakSpot[] = [];
  for (const span of trackHealth(track)) {
    if (span.health === 'sure') continue;
    const last = out[out.length - 1];
    if (last && span.fromMs - last.toMs <= WEAK_JOIN_MS) {
      last.toMs = span.toMs;
      last.lost = last.lost || span.health === 'lost';
    } else out.push({ fromMs: span.fromMs, toMs: span.toMs, lost: span.health === 'lost' });
  }
  return out.filter(spot => spot.lost || spot.toMs - spot.fromMs >= MIN_WEAK_MS);
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
const paths = new WeakMap<EditTrack, TrackPath>();

/**
 * The path a track is drawn along: every channel smoothed in TIME, `trackSmooth * MAX_SMOOTH_MS` wide, so
 * footage of any frame rate - and of a varying one - is smoothed alike.
 *
 * Each part between mends is smoothed on its own, with what followed it before it was mended standing in
 * for what follows it now ([TrackSeam.then]): the later run never reaches back across a seam, so the
 * layer before a mend is drawn exactly where it was.
 */
export function trackPath(track: EditTrack): TrackPath {
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
export function cutTrackAt(track: EditTrack, atMs: number): Pick<EditTrack, 'atMs' | 'x' | 'y' | 'scale' | 'turn'> & { seams: TrackSeam[] } {
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
  const take = (from: Pick<EditTrack, 'atMs' | 'x' | 'y' | 'scale' | 'turn'>, i: number) => {
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
 * The following layer's centre in the SOURCE at `sourceMs`, as fractions of the source: the thing's middle
 * there, plus the pin's offset grown and turned with the thing as far as the layer follows it - and how
 * much the layer is drawn bigger than its own `scale` (what it has grown with the thing since the pin,
 * times the pin's own [TrackPin.grow]) and turned past its own angle. The offset is turned in PIXELS, since
 * a fraction of the width is not a fraction of the height, and back.
 */
export function pinnedPoint(track: Pick<EditTrack, 'aspect'>, follow: OverlayFollow, path: TrackPath, sourceMs: number): { x: number; y: number; scale: number; turn: number } {
  const here = pathAt(path, sourceMs);
  const there = pathAt(path, follow.pin.atMs);
  const grown = follow.scaleWith ? here.scale / there.scale : 1;
  const turn = follow.turnWith ? here.turn - there.turn : 0;
  const rad = (turn * Math.PI) / 180;
  const cos = Math.cos(rad) * grown;
  const sin = Math.sin(rad) * grown;
  // In units of the source's height, where the two axes are the same size.
  const ox = follow.pin.dx * track.aspect;
  const oy = follow.pin.dy;
  return {
    x: here.x + (ox * cos - oy * sin) / track.aspect,
    y: here.y + ox * sin + oy * cos,
    scale: grown * (follow.pin.grow ?? 1),
    turn,
  };
}

/** A run's samples as the path is mended or coasted with: one per frame read, in time order. */
export interface RunSamples {
  atMs: number[];
  x: number[];
  y: number[];
  scale: number[];
  turn: number[];
  /** How sure each sample is, 0..100: 0 where the thing was not seen. */
  sure: number[];
  /** Where the thing was not seen, as SOURCE ms pairs. */
  lost: number[];
  /** The SOURCE instant the run started from, where its scale is 1 and its turn 0. */
  anchorMs: number;
}

/**
 * `run`'s samples with every stretch where the thing was not seen carried along rather than held: between
 * two sightings the thing travels a curve that leaves the first at the speed it had there and arrives at
 * the second at the speed it has there (a cubic Hermite), its size and turn eased between the two; past
 * the last sighting, or before the first, it carries on at its speed, slowing to a stop with
 * [COAST_TAU_MS]. A layer pinned to it then glides behind whatever hid the thing, instead of freezing and
 * jumping when the thing comes out. `lost` is left as it was: the stretches are still not SEEN.
 */
export function coastLost<T extends RunSamples>(run: T, seen: (i: number) => boolean): T {
  const n = run.atMs.length;
  const x = run.x.slice();
  const y = run.y.slice();
  const scale = run.scale.slice();
  const turn = run.turn.slice();
  const t = run.atMs;
  let i = 0;
  while (i < n) {
    if (seen(i)) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && !seen(j + 1)) j++;
    const p = i - 1;
    const q = j + 1 < n ? j + 1 : -1;
    if (p >= 0 && q >= 0) {
      const gap = t[q]! - t[p]!;
      // A long gap damps the speeds it starts and ends with, so a curve over seconds does not swing wide.
      const damp = Math.min(1, 600 / Math.max(1, gap));
      const vp = speedAt(t, x, y, seen, p, -1);
      const vq = speedAt(t, x, y, seen, q, 1);
      for (let k = i; k <= j; k++) {
        const s = (t[k]! - t[p]!) / gap;
        const h00 = 2 * s * s * s - 3 * s * s + 1;
        const h10 = s * s * s - 2 * s * s + s;
        const h01 = -2 * s * s * s + 3 * s * s;
        const h11 = s * s * s - s * s;
        x[k] = h00 * x[p]! + h10 * gap * vp.x * damp + h01 * x[q]! + h11 * gap * vq.x * damp;
        y[k] = h00 * y[p]! + h10 * gap * vp.y * damp + h01 * y[q]! + h11 * gap * vq.y * damp;
        scale[k] = scale[p]! * Math.pow(scale[q]! / scale[p]!, s);
        turn[k] = turn[p]! + (turn[q]! - turn[p]!) * s;
      }
    } else if (p >= 0 || q >= 0) {
      const from = p >= 0 ? p : q;
      const v = speedAt(t, x, y, seen, from, p >= 0 ? -1 : 1);
      for (let k = i; k <= j; k++) {
        const dt = t[k]! - t[from]!;
        const carried = Math.sign(dt) * COAST_TAU_MS * (1 - Math.exp(-Math.abs(dt) / COAST_TAU_MS));
        x[k] = clampTo(x[from]! + v.x * carried, -0.25, 1.25);
        y[k] = clampTo(y[from]! + v.y * carried, -0.25, 1.25);
        scale[k] = scale[from]!;
        turn[k] = turn[from]!;
      }
    }
    i = j + 1;
  }
  const round5 = (v: number) => Math.round(v * 1e5) / 1e5 + 0;
  return { ...run, x: x.map(round5), y: y.map(round5), scale: scale.map(s => Math.round(s * 1e4) / 1e4), turn: turn.map(a => Math.round(a * 100) / 100 + 0) };
}

/**
 * The thing's speed at sighting `k`, fractions of the source a millisecond: from the sightings up to
 * [SPEED_REACH_MS] before it (`dir` -1) or after it (`dir` 1). Still where there is no other sighting.
 */
function speedAt(t: readonly number[], x: readonly number[], y: readonly number[], seen: (i: number) => boolean, k: number, dir: -1 | 1): { x: number; y: number } {
  let far = k;
  for (let m = k + dir; m >= 0 && m < t.length && Math.abs(t[m]! - t[k]!) <= SPEED_REACH_MS; m += dir) if (seen(m)) far = m;
  const dt = t[k]! - t[far]!;
  if (far === k || dt === 0) return { x: 0, y: 0 };
  return { x: (x[k]! - x[far]!) / dt, y: (y[k]! - y[far]!) / dt };
}

/**
 * A track mended by a run started on a frame where it had slipped: the run's samples over the run's own
 * span, their size and turn carried on from the old path's at the run's anchor (a run measures both
 * against the frame it started on), handed over from the old samples and back to them over
 * [MEND_BLEND_MS] at each end where the old path goes on past the run. So a fix moves the path only where
 * it was wrong, and nothing jumps where the two meet. The old seams, lost stretches and sureness inside
 * the run's span go; the run's come in.
 */
export function mendTrack(track: EditTrack, run: RunSamples): EditTrack {
  const n = run.atMs.length;
  if (n === 0) return track;
  const from = run.atMs[0]!;
  const to = run.atMs[n - 1]!;
  const at = pathAt(trackPath(track), run.anchorMs);
  const old = track.atMs;
  const head = lowerBound(old, from);
  let tail = lowerBound(old, to);
  while (tail < old.length && old[tail]! <= to) tail++;
  const hasBefore = head > 0;
  const hasAfter = tail < old.length;
  // The old samples read at any instant, raw: what the run hands over from and back to.
  const oldAt = (ms: number, channel: readonly number[]): number => {
    const i = lowerBound(old, ms);
    if (i <= 0) return channel[0]!;
    if (i >= old.length) return channel[old.length - 1]!;
    const f = (ms - old[i - 1]!) / (old[i]! - old[i - 1]!);
    return channel[i - 1]! + (channel[i]! - channel[i - 1]!) * f;
  };
  const ease = (f: number) => f * f * (3 - 2 * f);
  const atMs: number[] = old.slice(0, head);
  const x: number[] = track.x.slice(0, head);
  const y: number[] = track.y.slice(0, head);
  const scale: number[] = track.scale.slice(0, head);
  const turn: number[] = track.turn.slice(0, head);
  const sure: number[] = (track.sure ?? old.map(() => 100)).slice(0, head);
  for (let i = 0; i < n; i++) {
    const ms = run.atMs[i]!;
    const runScale = run.scale[i]! * at.scale;
    const runTurn = run.turn[i]! + at.turn;
    // How much of the run this sample is: none at a handed-over end, all of it a blend away from it.
    let w = 1;
    if (hasBefore) w = Math.min(w, ease(Math.min(1, (ms - from) / MEND_BLEND_MS)));
    if (hasAfter) w = Math.min(w, ease(Math.min(1, (to - ms) / MEND_BLEND_MS)));
    atMs.push(ms);
    x.push(roundTo(oldAt(ms, track.x) * (1 - w) + run.x[i]! * w, 5));
    y.push(roundTo(oldAt(ms, track.y) * (1 - w) + run.y[i]! * w, 5));
    scale.push(roundTo(oldAt(ms, track.scale) * (1 - w) + runScale * w, 4));
    turn.push(roundTo(oldAt(ms, track.turn) * (1 - w) + runTurn * w, 2));
    sure.push(Math.round(run.sure[i] ?? 100));
  }
  for (let i = tail; i < old.length; i++) {
    atMs.push(old[i]!);
    x.push(track.x[i]!);
    y.push(track.y[i]!);
    scale.push(track.scale[i]!);
    turn.push(track.turn[i]!);
    sure.push(track.sure?.[i] ?? 100);
  }
  // The old stretches kept only outside the run's span: one that reaches into it is cut at its edge, not lost
  // whole - the part the run never read is still not seen.
  const lost: number[] = [];
  const oldLost = track.lost ?? [];
  for (let i = 0; i + 1 < oldLost.length; i += 2) {
    const a = oldLost[i]!;
    const b = Math.min(oldLost[i + 1]!, from - 1);
    if (b > a) lost.push(a, b);
  }
  for (let i = 0; i + 1 < run.lost.length; i += 2) lost.push(run.lost[i]!, run.lost[i + 1]!);
  for (let i = 0; i + 1 < oldLost.length; i += 2) {
    const a = Math.max(oldLost[i]!, to + 1);
    const b = oldLost[i + 1]!;
    if (b > a) lost.push(a, b);
  }
  const mended: EditTrack = { ...track, atMs, x, y, scale, turn };
  if (sure.some(s => s < 100)) mended.sure = sure;
  else delete mended.sure;
  if (lost.length > 0) mended.lost = lost;
  else delete mended.lost;
  const seams = (track.seams ?? []).filter(seam => seam.atMs < from || seam.atMs > to);
  if (seams.length > 0) mended.seams = seams;
  else delete mended.seams;
  return normaliseEditTrack(mended) ?? track;
}

function roundTo(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f + 0;
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
