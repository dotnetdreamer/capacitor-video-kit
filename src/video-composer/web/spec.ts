import type {
  ComposeFit,
  ComposePlacement,
  ComposeRect,
  ComposeSpec,
  ComposeTransition,
  ComposeTransitionCurves,
  ComposeTransitionMask,
  ComposeTransitionSideCurves,
  FilterOp,
} from '../definitions';

import { MAX_PLACEMENT_SIZE, MAX_VIDEO_TRACKS, placementRange } from '../../editor';

import { clamp, MAX_SPEED, MIN_SPEED } from './plan';

/**
 * The web half of `ComposeSpecParser`: the same refusals, in the same words, for the same reasons.
 *
 * A native plugin gets a `JSObject` that has already crossed a bridge and has to be read field by
 * field. A web implementation is handed the caller's own object, so there is nothing to parse - but
 * there is still everything to CHECK, and checking it here is what stops the same malformed spec
 * being a loud `invalid_spec` on a phone and a silently black video in a browser.
 *
 * The split between "reject" and "clamp" is the native one. A shape error - a missing clip array, a
 * zero-width output, an overlay that is not a PNG data URL - is a programming error in the caller
 * and fails the call itself with the JSON path that broke. A value merely out of range - a speed of
 * 8, a negative volume, an opacity of 1.4 - is clamped, because a render that comes out slightly
 * different beats a post the customer cannot make.
 */

/** The renderer draws one blended quad per overlay per frame, so the count is bounded. */
export const MAX_OVERLAYS = 30;

/**
 * How many video layers a spec may carry, THE BASE TRACK INCLUDED.
 *
 * Re-exported from the editor contract rather than declared again here. It was a 2 of its own
 * while the contract said 16, so this renderer refused specs the Swift and Kotlin engines had
 * already been proven to draw: a duplicated constant is a constant that drifts, and this one did.
 * The cap is not a decoder budget either way - the export composites offline, and what a device
 * can PLAY at once is the preview's business and a different number in a different place.
 */
export { MAX_VIDEO_TRACKS };

const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/**
 * How many samples a transition curve may carry. Two is the fewest that still make a line between
 * the two ends of the window; 121 is three times what the catalogue sends, room for a finer recipe
 * without letting a caller hand over a curve per frame of a two-second transition.
 */
export const MIN_CURVE_SAMPLES = 2;
export const MAX_CURVE_SAMPLES = 121;

const MASK_SHAPES: readonly ComposeTransitionMask['shape'][] = ['linear', 'circle', 'diamond', 'clock', 'blinds', 'split'];

/**
 * Every channel a transition may move, with the range each is CLAMPED to, in the order they are
 * checked. The order is part of the contract rather than an accident of this file: the Kotlin and
 * Swift parsers read the same keys in the same order, so a spec with two broken curves names the
 * same one on every engine - and a dictionary's own key order is not something Swift keeps. See
 * [readCurves] for where the unknown keys and the lengths come in that order.
 *
 * The ranges are generous on purpose. They are not taste - a slide may well travel two frames, a
 * spin may turn ten times - they are the line past which a number is a bug rather than a look, and
 * past which a shader starts dividing by nothing or sampling a mile off the frame.
 */
const LOOK_CHANNELS = [
  ['alpha', 0, 1],
  ['reveal', 0, 1],
] as const satisfies readonly (readonly [keyof ComposeTransitionCurves, number, number])[];

const SIDE_CHANNELS = [
  ['x', -4, 4],
  ['y', -4, 4],
  ['scale', 0.01, 20],
  ['rotation', -3600, 3600],
  ['blur', 0, 0.5],
  ['pixelate', 0, 0.5],
  ['split', -0.5, 0.5],
  ['gain', 0, 10],
  ['tint', 0, 1],
] as const satisfies readonly (readonly [keyof ComposeTransitionSideCurves, number, number])[];

const CURVE_KEYS: readonly string[] = [...LOOK_CHANNELS.map(([name]) => name), 'from', 'to'];
const SIDE_KEYS: readonly string[] = SIDE_CHANNELS.map(([name]) => name);

/** What `compose()` rejects with for a spec that is the wrong shape. Code `invalid_spec`. */
export class SpecError extends Error {
  constructor(
    readonly path: string,
    message?: string,
  ) {
    super(message ?? `invalid_spec:${path}`);
    this.name = 'SpecError';
  }
}

/**
 * The caller's spec, checked and with every out-of-range number brought inside its range.
 *
 * A COPY is returned, field by field, rather than the caller's object with a few values changed:
 * the spec is held for the life of the render, and a caller that goes on mutating its own object -
 * an editor still running while the export bar fills - would otherwise change the render underneath
 * itself.
 */
export function validateSpec(input: ComposeSpec): ComposeSpec {
  const spec = input as Partial<ComposeSpec> | null | undefined;
  if (!spec || typeof spec !== 'object') throw new SpecError('spec');

  const jobId = nonEmpty(spec.jobId, 'jobId');
  const batchId = nonEmpty(spec.batchId, 'batchId');

  if (!Array.isArray(spec.clips) || spec.clips.length === 0) throw new SpecError('clips');
  const clips = spec.clips.map((clip, i) => {
    const path = `clips[${i}]`;
    const read = readClip(clip, path);
    // A transition brings a base clip in from the one before it, so only a base clip that HAS one
    // before it can carry one. The first clip's and every layer clip's are not read at all - not
    // even checked - which is what the contract says an engine does with them: a stale key left on
    // a clip that was dragged to the front is not a reason to refuse the post.
    if (i > 0) {
      const transition = readTransition((clip as unknown as Record<string, unknown>)['transitionIn'], `${path}.transitionIn`);
      if (transition) read.transitionIn = transition;
    }
    return read;
  });

  const rawTracks = spec.tracks ?? [];
  if (!Array.isArray(rawTracks)) throw new SpecError('tracks');
  // Refused rather than truncated: a caller asking for three layers believes it is getting three,
  // and a post silently missing one of them is not the post it asked to make.
  if (rawTracks.length > MAX_VIDEO_TRACKS - 1) {
    throw new SpecError('tracks', `invalid_spec:tracks at most ${MAX_VIDEO_TRACKS - 1} extra video track`);
  }
  const tracks = rawTracks.map((track, i) => {
    const path = `tracks[${i}]`;
    if (!track || typeof track !== 'object') throw new SpecError(path);
    const id = nonEmpty(track.id, `${path}.id`);
    if (!Array.isArray(track.clips) || track.clips.length === 0) throw new SpecError(`${path}.clips`);
    return {
      id,
      clips: track.clips.map((clip, k) => readClip(clip, `${path}.clips[${k}]`)),
      startMs: Math.max(0, finite(track.startMs, 0)),
      z: Math.round(finite(track.z, 0)),
      opacity: clamp(finite(track.opacity, 1), 0, 1),
    };
  });

  const output = spec.output;
  if (!output || typeof output !== 'object') throw new SpecError('output');
  const width = Math.round(finite(output.width, 0));
  const height = Math.round(finite(output.height, 0));
  if (width <= 0) throw new SpecError('output.width');
  if (height <= 0) throw new SpecError('output.height');

  const rawFilter = spec.filter ?? [];
  if (!Array.isArray(rawFilter)) throw new SpecError('filter');
  const filter = rawFilter.map((op, i) => readFilterOp(op, `filter[${i}]`));

  const rawOverlays = spec.overlays ?? [];
  if (!Array.isArray(rawOverlays)) throw new SpecError('overlays');
  if (rawOverlays.length > MAX_OVERLAYS) throw new SpecError('overlays');
  const overlays = rawOverlays.map((overlay, i) => {
    const path = `overlays[${i}]`;
    if (!overlay || typeof overlay !== 'object') throw new SpecError(path);
    const png = typeof overlay.png === 'string' ? overlay.png : '';
    // The one thing an engine cannot recover from: it places bitmaps and nothing else, so an
    // overlay that is not one is a caller bug rather than a render outcome.
    if (!png.startsWith(PNG_DATA_URL_PREFIX)) throw new SpecError(`${path}.png`);
    const wPx = Math.round(finite(overlay.wPx, 0));
    const hPx = Math.round(finite(overlay.hPx, 0));
    if (wPx <= 0) throw new SpecError(`${path}.wPx`);
    if (hPx <= 0) throw new SpecError(`${path}.hPx`);
    const startMs = Math.max(0, finite(overlay.startMs, 0));
    return {
      id: nonEmpty(overlay.id, `${path}.id`),
      png,
      cx: finite(overlay.cx, 0.5),
      cy: finite(overlay.cy, 0.5),
      wPx,
      hPx,
      rotationDeg: finite(overlay.rotationDeg, 0),
      startMs,
      endMs: Math.max(startMs, finite(overlay.endMs, startMs)),
      opacity: clamp(finite(overlay.opacity, 1), 0, 1),
    };
  });

  const durationMs = Math.max(0, Math.round(finite(spec.durationMs, 0)));

  const audio = spec.audio ?? {
    originalMuted: false,
    originalVolume: 1,
    music: null,
    voiceover: [],
  };
  const music = audio.music ?? null;
  const rawVoiceover = audio.voiceover ?? [];
  if (!Array.isArray(rawVoiceover)) throw new SpecError('audio.voiceover');

  return {
    jobId,
    batchId,
    clips,
    // A tail the base track already covers is no tail at all, and the key is left off rather than
    // read back as a number the plan would have to compare against the clips a second time.
    ...(durationMs > 0 ? { durationMs } : {}),
    ...(tracks.length > 0 ? { tracks } : {}),
    output: {
      width,
      height,
      fps: Math.max(1, Math.round(finite(output.fps, 30))),
      videoBitrate: Math.max(100_000, Math.round(finite(output.videoBitrate, 6_000_000))),
      audioBitrate: Math.max(32_000, Math.round(finite(output.audioBitrate, 128_000))),
    },
    filter,
    overlays,
    audio: {
      originalMuted: audio.originalMuted === true,
      originalVolume: clamp(finite(audio.originalVolume, 1), 0, 1),
      music: music
        ? {
            uri: nonEmpty(music.uri, 'audio.music.uri'),
            startMs: Math.max(0, finite(music.startMs, 0)),
            inMs: Math.max(0, finite(music.inMs, 0)),
            outMs: Math.max(0, finite(music.outMs, 0)),
            volume: clamp(finite(music.volume, 1), 0, 1),
            loop: music.loop === true,
            fadeInMs: Math.max(0, finite(music.fadeInMs, 0)),
            fadeOutMs: Math.max(0, finite(music.fadeOutMs, 0)),
          }
        : null,
      voiceover: rawVoiceover.map((take, i) => ({
        uri: nonEmpty(take?.uri, `audio.voiceover[${i}].uri`),
        startMs: Math.max(0, finite(take?.startMs, 0)),
        durationMs: Math.max(0, finite(take?.durationMs, 0)),
        volume: clamp(finite(take?.volume, 1), 0, 1),
      })),
    },
    posterAtMs: Math.max(0, finite(spec.posterAtMs, 0)),
  };
}

/** The base64 payload of an overlay's data URL, without the prefix the parser insisted on. */
export function pngPayload(dataUrl: string): string {
  return dataUrl.slice(PNG_DATA_URL_PREFIX.length);
}

/* -------------------------------------------------------------------------------------------- */

/**
 * One segment, read the same way for the base track and every extra layer - a clip on the second
 * layer is the same kind of thing as one on the first, and one reader is one set of error paths.
 */
function readClip(input: unknown, path: string): ComposeSpec['clips'][number] {
  const clip = input as Record<string, unknown> | null | undefined;
  if (!clip || typeof clip !== 'object') throw new SpecError(path);

  const key = nonEmpty(clip['key'], `${path}.key`);
  const uri = nonEmpty(clip['uri'], `${path}.uri`);
  const inMs = finite(clip['inMs'], -1);
  if (inMs < 0) throw new SpecError(`${path}.inMs`);
  const outMs = finite(clip['outMs'], -1);
  if (outMs <= inMs) throw new SpecError(`${path}.outMs`);

  const out: ComposeSpec['clips'][number] = {
    key,
    uri,
    inMs,
    outMs,
    speed: clamp(finite(clip['speed'], 1), MIN_SPEED, MAX_SPEED),
    volume: clamp(finite(clip['volume'], 1), 0, 1),
    muted: clip['muted'] === true,
    fit: readFit(clip['fit']),
  };
  // Set only when they say something - the absence of these two fields is what every engine tests
  // for to keep taking the path it took before crops and rectangles existed.
  const crop = readRect(clip['crop'], `${path}.crop`);
  if (crop) out.crop = crop;
  const rect = readPlacement(clip['rect'], `${path}.rect`);
  if (rect) out.rect = rect;
  return out;
}

function readFit(value: unknown): ComposeFit {
  return value === 'cover' ? 'cover' : 'contain';
}

/**
 * A crop brought inside the source, or undefined for anything that is not one.
 *
 * The size asked for is what is kept: a rectangle pushed off an edge slides back in rather than
 * being squashed against it, which is the rule `normaliseRect` follows in the manifest and the one
 * that keeps a crop dragged to the right edge from becoming a zero-width black frame. A placement
 * is read by `readPlacement` and is not held inside anything but its own centre.
 */
function readRect(value: unknown, path: string): ComposeRect | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new SpecError(path);
  const rect = value as Record<string, unknown>;
  const w = clamp(finite(rect['w'], 1), 0.01, 1);
  const h = clamp(finite(rect['h'], 1), 0.01, 1);
  return {
    x: clamp(finite(rect['x'], 0), 0, 1 - w),
    y: clamp(finite(rect['y'], 0), 0, 1 - h),
    w,
    h,
  };
}

/**
 * A placement rectangle, or undefined for anything that is not one.
 *
 * The same four numbers as `readRect` and a different bound, which is the difference between the
 * two fields rather than an inconsistency. A crop is a window on the source and cannot leave it; a
 * placement says where the picture is DRAWN, and a video placed off the edge of the frame is a
 * customer asking for the overhang to be cut off there. All that is held is a strip of it on the
 * frame, `MIN_ON_FRAME` wide, which is `normalisePlacement`'s rule word for word - the manifest,
 * this reader and both native parsers have to agree on it or the same post is a different picture
 * per engine.
 *
 * `rotationDeg` is carried through, clockwise degrees about the rectangle's centre, and is NOT
 * wrapped into a single turn: the builder does not wrap it either, a gesture spun twice round keeps
 * its total, and the compositor reduces the angle itself the moment it takes a cosine of it. A
 * whole number of turns is dropped instead of stored as an angle, because a missing key is what
 * tells the painter there is no transform to build - the same rule `normalisePlacement` follows on
 * the way out, so a rectangle turned and put back produces the spec it produced before.
 */
function readPlacement(value: unknown, path: string): ComposePlacement | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new SpecError(path);
  const rect = value as Record<string, unknown>;
  const w = clamp(finite(rect['w'], 1), 0.01, MAX_PLACEMENT_SIZE);
  const h = clamp(finite(rect['h'], 1), 0.01, MAX_PLACEMENT_SIZE);
  const across = placementRange(w);
  const down = placementRange(h);
  const placed: ComposePlacement = {
    x: clamp(finite(rect['x'], 0), across.min, across.max),
    y: clamp(finite(rect['y'], 0), down.min, down.max),
    w,
    h,
  };
  const rotationDeg = finite(rect['rotationDeg'], 0);
  return rotationDeg % 360 === 0 ? placed : { ...placed, rotationDeg };
}

/**
 * A base clip's `transitionIn`, or undefined where there is none.
 *
 * The split between refusing and clamping is the one the rest of this file makes. A transition
 * that is the wrong SHAPE - a curve that is not a list of numbers, two curves of different lengths,
 * a mask shape nobody draws, a key this engine has never heard of - is a caller bug and fails the
 * call with its path. A number merely out of range is brought into range, because a slide that
 * travels a little less far beats a post that cannot be made.
 *
 * Unknown keys INSIDE the curves are refused rather than ignored, which is stricter than anywhere
 * else in the spec and deliberately so. A channel is a thing the picture does: an engine that
 * silently dropped one it did not know would draw a different transition from the one the preview
 * showed and report success, and the only way two engines cannot disagree about a channel is for
 * neither to accept one it cannot draw.
 *
 * Fields are checked in a fixed order - `kind`, `from`, `curves`, `mask`, `fromTint`, `toTint` - and
 * inside the curves in the order [readCurves] gives. It is Android's `parseTransitionIn` order, which
 * the Swift parser follows too, so a spec with more than one thing wrong with it fails with the same
 * path on every engine. `null` is read as absent for every optional field, as it is for `crop` and
 * `rect`.
 */
function readTransition(value: unknown, path: string): ComposeTransition | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new SpecError(path);
  const kind = nonEmpty(value['kind'], `${path}.kind`);
  // The outgoing clip's tail is a clip in every respect - its trim, speed, sound and framing - and
  // is read by the one clip reader, so its refusals are the refusals any clip gets, at its own path.
  // Something that is not an object at all fails as `from` itself, before that reader sees it: an
  // array would otherwise get past the reader's own test and be refused as a missing `from.key`,
  // where both native parsers name `from`.
  if (!isRecord(value['from'])) throw new SpecError(`${path}.from`);
  const from = readClip(value['from'], `${path}.from`);
  const curves = readCurves(value['curves'], `${path}.curves`);

  const transition: ComposeTransition = { kind, from, curves };
  // Set only when present, for the reason `crop` and `rect` are: absence is what an engine tests for.
  const mask = readMask(value['mask'], `${path}.mask`);
  if (mask) transition.mask = mask;
  const fromTint = readTint(value['fromTint'], `${path}.fromTint`);
  if (fromTint) transition.fromTint = fromTint;
  const toTint = readTint(value['toTint'], `${path}.toTint`);
  if (toTint) transition.toTint = toTint;
  return transition;
}

/**
 * The sampled curves. Every curve present shares ONE length, between [MIN_CURVE_SAMPLES] and
 * [MAX_CURVE_SAMPLES]. Two lengths would make "the sample at 40% of the window" mean two different
 * moments, and the evaluation every engine shares has no answer for that.
 *
 * The order things are checked in is Android's `parseCurves`, step for step, because a spec with two
 * things wrong with it has to be refused with the same path on every engine: `alpha`, `reveal`, then
 * each side - `from` before `to` - its channels in [SIDE_CHANNELS] order and after them its unknown
 * keys, then the unknown keys of the curves object itself, and LAST the lengths, every curve read
 * held to the first one read and the first that disagrees named. Each curve's own 2..121 is checked
 * as it is read, so a curve of one sample is named there even when an earlier curve disagrees with
 * the first about its length.
 */
function readCurves(value: unknown, path: string): ComposeTransitionCurves {
  if (!isRecord(value)) throw new SpecError(path);
  const read: CurveRead[] = [];
  const curves: ComposeTransitionCurves = {};
  for (const [name, min, max] of LOOK_CHANNELS) {
    const curve = readCurve(value[name], `${path}.${name}`, min, max, read);
    if (curve) curves[name] = curve;
  }
  for (const side of ['from', 'to'] as const) {
    const raw = value[side];
    if (raw === undefined || raw === null) continue;
    const sidePath = `${path}.${side}`;
    if (!isRecord(raw)) throw new SpecError(sidePath);
    const channels: ComposeTransitionSideCurves = {};
    for (const [name, min, max] of SIDE_CHANNELS) {
      const curve = readCurve(raw[name], `${sidePath}.${name}`, min, max, read);
      if (curve) channels[name] = curve;
    }
    refuseUnknownKeys(raw, SIDE_KEYS, sidePath);
    curves[side] = channels;
  }
  refuseUnknownKeys(value, CURVE_KEYS, path);
  const first = read[0];
  const odd = first && read.find(curve => curve.samples !== first.samples);
  if (odd) throw new SpecError(odd.path);
  return curves;
}

/** A curve that has been read, kept for the length check [readCurves] makes once they all are. */
interface CurveRead {
  path: string;
  samples: number;
}

/**
 * One curve, every sample clamped into its channel's range, and noted in `read`. Absent is
 * undefined, not an error; anything else must be 2..121 finite numbers or it is refused at its path.
 */
function readCurve(value: unknown, path: string, min: number, max: number, read: CurveRead[]): number[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length < MIN_CURVE_SAMPLES || value.length > MAX_CURVE_SAMPLES || !value.every(isFiniteNumber)) {
    throw new SpecError(path);
  }
  read.push({ path, samples: value.length });
  return value.map(sample => clamp(sample, min, max));
}

/**
 * The shape the incoming side is revealed through, with every default written out. An unknown
 * shape is refused: a mask an engine cannot draw would reveal the incoming clip everywhere at once,
 * which is a different transition, silently.
 */
function readMask(value: unknown, path: string): ComposeTransitionMask | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) throw new SpecError(path);
  const shape = value['shape'];
  if (typeof shape !== 'string' || !(MASK_SHAPES as readonly string[]).includes(shape)) throw new SpecError(`${path}.shape`);
  return {
    shape: shape as ComposeTransitionMask['shape'],
    angleDeg: finite(value['angleDeg'], 0),
    count: clamp(Math.round(finite(value['count'], 1)), 1, 64),
    feather: clamp(finite(value['feather'], 0.01), 0.0005, 0.5),
    invert: value['invert'] === true,
  };
}

/** A tint colour, 0..1 RGB. Exactly three numbers: a fourth is not an alpha anyone asked for. */
function readTint(value: unknown, path: string): [number, number, number] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length !== 3 || !value.every(isFiniteNumber)) throw new SpecError(path);
  return [clamp(value[0], 0, 1), clamp(value[1], 0, 1), clamp(value[2], 0, 1)];
}

function refuseUnknownKeys(value: Record<string, unknown>, known: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!known.includes(key)) throw new SpecError(`${path}.${key}`);
  }
}

/** A plain object: not null, and not an array, which `typeof` would call an object too. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** One colour op. An unrecognised `op` is a caller bug, not a value to be guessed at. */
function readFilterOp(value: unknown, path: string): FilterOp {
  const op = value as Record<string, unknown> | null | undefined;
  if (!op || typeof op !== 'object') throw new SpecError(path);
  switch (op['op']) {
    case 'brightness':
    case 'contrast':
    case 'saturate':
      return { op: op['op'], amount: Math.max(0, finite(op['amount'], 1)) };
    case 'sepia':
    case 'grayscale':
      return { op: op['op'], amount: clamp(finite(op['amount'], 0), 0, 1) };
    case 'hueRotate':
      return { op: 'hueRotate', degrees: finite(op['degrees'], 0) };
    case 'tint': {
      const rgb = op['rgb'];
      if (!Array.isArray(rgb) || rgb.length < 3) throw new SpecError(`${path}.rgb`);
      return {
        op: 'tint',
        rgb: [clamp(finite(rgb[0], 0), 0, 255), clamp(finite(rgb[1], 0), 0, 255), clamp(finite(rgb[2], 0), 0, 255)],
        alpha: clamp(finite(op['alpha'], 0), 0, 1),
      };
    }
    default:
      throw new SpecError(`${path}.op`);
  }
}

function nonEmpty(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) throw new SpecError(path);
  return value;
}

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
