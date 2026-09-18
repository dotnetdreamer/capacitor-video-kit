import type { ComposeFit, ComposePlacement, ComposeRect, ComposeSpec, FilterOp } from '../definitions';

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
  const pendingPostId = nonEmpty(spec.pendingPostId, 'pendingPostId');

  if (!Array.isArray(spec.clips) || spec.clips.length === 0) throw new SpecError('clips');
  const clips = spec.clips.map((clip, i) => readClip(clip, `clips[${i}]`));

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
    pendingPostId,
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
 * `rotationDeg` is not read here for the reason `plan.ts` gives: this renderer draws a clip's
 * rectangle but does not turn it, and a reader that accepted the angle would be claiming otherwise.
 */
function readPlacement(value: unknown, path: string): ComposePlacement | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'object') throw new SpecError(path);
  const rect = value as Record<string, unknown>;
  const w = clamp(finite(rect['w'], 1), 0.01, MAX_PLACEMENT_SIZE);
  const h = clamp(finite(rect['h'], 1), 0.01, MAX_PLACEMENT_SIZE);
  const across = placementRange(w);
  const down = placementRange(h);
  return {
    x: clamp(finite(rect['x'], 0), across.min, across.max),
    y: clamp(finite(rect['y'], 0), down.min, down.max),
    w,
    h,
  };
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
