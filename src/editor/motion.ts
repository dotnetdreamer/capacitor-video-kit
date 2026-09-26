import { MAX_OVERLAY_MOTION_KEYS, type ComposeOverlayMotion } from '../video-composer/definitions';
import type { OverlayAnimation, OverlayKind, OverlayLoop, OverlayMove } from './edit-manifest';

/**
 * Layers that MOVE: how a text, a sticker, a photo or an effect arrives, leaves and lives while it
 * is on screen - and those moves LOWERED to keys, which is the one place any of them is eased.
 *
 * A layer used to be a bitmap that cut on and cut off, and every editor a customer has used animates
 * them: a caption pops in on the beat, a sticker pulses, a light leak fades up and breathes. The
 * presets here are that catalogue, and their curves are drawn the way the best of those editors draw
 * theirs - a pop overshoots on a spring, a slam lands hard and shudders, a flicker stutters on like a
 * neon tube.
 *
 * What an engine is handed is not a preset. It is [ComposeOverlayMotion]: every channel sampled into
 * keys, and every engine (web, Android, iOS) and the preview only interpolate straight lines between
 * them. That is the camera's precedent and the transitions' before it, for the same reason: three
 * hand-written copies of a spring would drift apart one release at a time, and the customer would see
 * a different pop in the preview from the one in their export. A preset added here reaches every
 * engine without a line of native code.
 *
 * Ids are stored in manifests, so they are permanent: a renamed id silently drops the move from every
 * saved draft. Labels can change; ids cannot.
 */

/* -------------------------------------------------------------------------------------------- */
/* Catalogue                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** Which of a layer's three moves a preset is for. */
export type OverlayAnimationPart = 'in' | 'out' | 'loop';

export interface OverlayAnimationPreset {
  id: string;
  label: string;
  /** What the move is given when it is first chosen: an in's or an out's length, a loop's period. */
  defaultMs: number;
}

/** The shortest an in or an out may be asked to run: three frames at 30 fps, and still a move. */
export const MIN_OVERLAY_MOVE_MS = 100;
/** The longest an in or an out may be asked to run. Past two seconds a pop is a drift. */
export const MAX_OVERLAY_MOVE_MS = 2000;
/** The quickest a loop may cycle: five times a second is already a buzz. */
export const MIN_OVERLAY_LOOP_MS = 200;
/** The slowest a loop may cycle. Past four seconds a pulse is too slow to read as one, only as a drift. */
export const MAX_OVERLAY_LOOP_MS = 4000;

/**
 * The most a moving layer's bitmap is supersampled by. A slam lands from 1.8x, and a bitmap drawn at
 * its resting size would be magnified that much on the way down - soft exactly while the customer is
 * looking at it. Half as many pixels again covers every preset's peak but the first frames of a slam,
 * which are still mostly transparent, and of a stamp, which are over in a blink - and keeps a
 * thirty-layer post inside the bitmap budget a phone has.
 */
export const MAX_MOTION_RASTER_DETAIL = 1.5;

/**
 * Every preset, in the order a picker offers them, the first of each being the plainest. An effect
 * takes any of them and honours only what the preset does to its opacity (see [compileOverlayMotion]).
 */
export const OVERLAY_ANIMATIONS: Readonly<Record<OverlayAnimationPart, readonly OverlayAnimationPreset[]>> = Object.freeze({
  /*
   * The lengths are CapCut's: half a second in, and an exit a little quicker than the entrance it
   * mirrors, because a layer leaving is not something anyone waits to watch. A loop's period is a
   * whole number of beats at 120 bpm, so a template can put one on the music without arithmetic.
   */
  in: Object.freeze([
    { id: 'fade', label: 'Fade', defaultMs: 500 },
    { id: 'pop', label: 'Pop', defaultMs: 470 },
    { id: 'slam', label: 'Slam', defaultMs: 450 },
    { id: 'stamp', label: 'Stamp', defaultMs: 200 },
    { id: 'soft', label: 'Soft', defaultMs: 650 },
    { id: 'grow', label: 'Grow', defaultMs: 500 },
    { id: 'rise', label: 'Rise', defaultMs: 500 },
    { id: 'drop', label: 'Drop', defaultMs: 600 },
    { id: 'slide-left', label: 'Slide left', defaultMs: 500 },
    { id: 'slide-right', label: 'Slide right', defaultMs: 500 },
    { id: 'swing', label: 'Swing', defaultMs: 600 },
    { id: 'spin', label: 'Spin', defaultMs: 600 },
    { id: 'flicker', label: 'Flicker', defaultMs: 800 },
  ]),
  out: Object.freeze([
    { id: 'fade', label: 'Fade', defaultMs: 400 },
    { id: 'pop', label: 'Pop', defaultMs: 350 },
    { id: 'grow', label: 'Grow', defaultMs: 400 },
    { id: 'shrink', label: 'Shrink', defaultMs: 350 },
    { id: 'sink', label: 'Sink', defaultMs: 400 },
    { id: 'lift', label: 'Lift', defaultMs: 400 },
    { id: 'slide-left', label: 'Slide left', defaultMs: 400 },
    { id: 'slide-right', label: 'Slide right', defaultMs: 400 },
    { id: 'spin', label: 'Spin', defaultMs: 450 },
    { id: 'flicker', label: 'Flicker', defaultMs: 500 },
  ]),
  loop: Object.freeze([
    { id: 'pulse', label: 'Pulse', defaultMs: 1000 },
    { id: 'beat', label: 'Beat', defaultMs: 500 },
    { id: 'heartbeat', label: 'Heartbeat', defaultMs: 1500 },
    { id: 'float', label: 'Float', defaultMs: 1500 },
    { id: 'sway', label: 'Sway', defaultMs: 2000 },
    { id: 'wiggle', label: 'Wiggle', defaultMs: 1000 },
    { id: 'shake', label: 'Shake', defaultMs: 500 },
    { id: 'spin', label: 'Spin', defaultMs: 2000 },
    { id: 'breathe', label: 'Breathe', defaultMs: 2000 },
  ]),
});

/** The preset `id` names for that part, or null for an id this version does not know. */
export function overlayAnimationPreset(part: OverlayAnimationPart, id: unknown): OverlayAnimationPreset | null {
  return OVERLAY_ANIMATIONS[part].find(preset => preset.id === id) ?? null;
}

/**
 * A stored animation made into one every engine can draw: each move whose id this version does not
 * know is dropped, each length clamped to its range and rounded to a whole millisecond - one that is
 * not a number takes the preset's default - and `null` when nothing is left, which is the absent key.
 *
 * The SAME object back when it was already all of that, so an edit that did not touch the animation
 * leaves the layer's fields identical and is recognised as no change at all (an op that answers with
 * a new object for an unchanged layer is an undo step the customer did not make).
 */
export function normaliseOverlayAnimation(value: unknown): OverlayAnimation | null {
  if (!isRecord(value)) return null;
  const animation: OverlayAnimation = {};
  const arrive = readMove(value['in'], 'in');
  if (arrive) animation.in = arrive;
  const leave = readMove(value['out'], 'out');
  if (leave) animation.out = leave;
  const loop = readLoop(value['loop']);
  if (loop) animation.loop = loop;
  if (!animation.in && !animation.out && !animation.loop) return null;
  return sameAnimation(value, animation) ? (value as OverlayAnimation) : animation;
}

function readMove(value: unknown, part: 'in' | 'out'): OverlayMove | null {
  if (!isRecord(value)) return null;
  const preset = overlayAnimationPreset(part, value['id']);
  if (!preset) return null;
  return { id: preset.id, durationMs: wholeMs(value['durationMs'], preset.defaultMs, MIN_OVERLAY_MOVE_MS, MAX_OVERLAY_MOVE_MS) };
}

function readLoop(value: unknown): OverlayLoop | null {
  if (!isRecord(value)) return null;
  const preset = overlayAnimationPreset('loop', value['id']);
  if (!preset) return null;
  return { id: preset.id, periodMs: wholeMs(value['periodMs'], preset.defaultMs, MIN_OVERLAY_LOOP_MS, MAX_OVERLAY_LOOP_MS) };
}

function wholeMs(value: unknown, fallback: number, min: number, max: number): number {
  const ms = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.round(Math.min(max, Math.max(min, ms)));
}

/** Whether two animations make the same moves: the same ids, lengths and period, part for part. */
export function sameOverlayAnimation(a: OverlayAnimation | null | undefined, b: OverlayAnimation | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  return (
    a.in?.id === b.in?.id &&
    a.in?.durationMs === b.in?.durationMs &&
    a.out?.id === b.out?.id &&
    a.out?.durationMs === b.out?.durationMs &&
    a.loop?.id === b.loop?.id &&
    a.loop?.periodMs === b.loop?.periodMs
  );
}

/** Key for key: a stored animation carrying anything else - an extra key, a string length - is not normal. */
function sameAnimation(raw: Record<string, unknown>, normal: OverlayAnimation): boolean {
  const keys = Object.keys(raw);
  if (keys.length !== Object.keys(normal).length) return false;
  return keys.every(key => {
    const a = raw[key];
    const b = (normal as Record<string, Record<string, unknown> | undefined>)[key];
    if (!isRecord(a) || !b) return false;
    const fields = Object.keys(a);
    return fields.length === Object.keys(b).length && fields.every(field => a[field] === b[field]);
  });
}

/* -------------------------------------------------------------------------------------------- */
/* Timing                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** Where a layer's moves fall inside its window, in milliseconds from the window's start. */
export interface OverlayAnimationSpans {
  /** The in runs `0..inMs`. 0 for none. */
  inMs: number;
  /** The out runs `windowMs - outMs..windowMs`. 0 for none. */
  outMs: number;
  /** The loop runs `loopStartMs..loopEndMs`, its phase 0 at `loopStartMs`. Equal for no loop. */
  loopStartMs: number;
  loopEndMs: number;
}

/**
 * The moves as they PLAY in a window `windowMs` long: the in and the out as asked for, or squeezed in
 * proportion when together they would not fit, and the loop in whatever is left between them. What
 * the timeline would draw and what [compileOverlayMotion] compiles are the same numbers.
 */
export function overlayAnimationSpans(animation: OverlayAnimation | null | undefined, windowMs: number): OverlayAnimationSpans {
  const window = Number.isFinite(windowMs) ? Math.max(0, windowMs) : 0;
  let inMs = animation?.in ? Math.max(0, animation.in.durationMs) : 0;
  let outMs = animation?.out ? Math.max(0, animation.out.durationMs) : 0;
  if (inMs + outMs > window) {
    const k = inMs + outMs > 0 ? window / (inMs + outMs) : 0;
    inMs *= k;
    outMs *= k;
  }
  const loopStartMs = inMs;
  const loopEndMs = animation?.loop ? Math.max(loopStartMs, window - outMs) : loopStartMs;
  return { inMs, outMs, loopStartMs, loopEndMs };
}

/* -------------------------------------------------------------------------------------------- */
/* What a layer is at one moment                                                                  */
/* -------------------------------------------------------------------------------------------- */

/**
 * Every channel a layer's motion moves, at one moment: the same five [ComposeOverlayMotion] carries,
 * with the same meanings - offsets in fractions of the output's width and height (y down), a size
 * about the layer's centre, clockwise degrees added to its own, and an opacity multiplied into its own.
 */
export interface OverlayMotionSample {
  x: number;
  y: number;
  scale: number;
  rotation: number;
  opacity: number;
}

/** The layer where it was put, untouched: what absent channels hold, and what every move rests at. */
export const NEUTRAL_MOTION: Readonly<OverlayMotionSample> = Object.freeze({ x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 });

/** Below this a channel is at rest; it keeps float dust at the foot of a move from redrawing a layer. */
const NEUTRAL_EPSILON = 1e-6;

/** Whether a sample leaves the layer exactly as the static path draws it. */
export function isNeutralMotion(sample: OverlayMotionSample | null | undefined): boolean {
  return (
    !sample ||
    (Math.abs(sample.x) <= NEUTRAL_EPSILON &&
      Math.abs(sample.y) <= NEUTRAL_EPSILON &&
      Math.abs(sample.scale - 1) <= NEUTRAL_EPSILON &&
      Math.abs(sample.rotation) <= NEUTRAL_EPSILON &&
      Math.abs(sample.opacity - 1) <= NEUTRAL_EPSILON)
  );
}

/**
 * A layer's motion at output time `ms`, read exactly as [ComposeOverlayMotion] states - the camera's
 * reading, `cameraAt` line for line: end keys hold, every channel is interpolated in a straight line
 * between the keys either side, and keys at the same time are a step with the later one winning.
 * `null` for no motion and for a moment where the layer is at rest, so a caller takes the path a
 * still layer has always taken and the frame is the same to the pixel.
 *
 * The ONE reading of the wire in this package: the web render, the painter's tests and the live
 * preview all call it, so the move a customer checked in the editor is the move in their file.
 * Binary search, because a long looping layer compiles to thousands of keys and this runs per frame.
 */
export function overlayMotionAt(motion: ComposeOverlayMotion | null | undefined, ms: number): OverlayMotionSample | null {
  if (!motion) return null;
  const at = motion.atMs;
  const n = at?.length ?? 0;
  if (n === 0) return null;
  let sample: OverlayMotionSample;
  if (!(ms > at[0])) {
    // At or before the first key. Equal times are a step to the LAST key sharing that time.
    let i = 0;
    while (i + 1 < n && at[i + 1] <= ms) i++;
    sample = keySample(motion, i);
  } else if (ms >= at[n - 1]) {
    sample = keySample(motion, n - 1);
  } else {
    // The last key at or before `ms`: at[lo] <= ms < at[lo + 1].
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at[mid] <= ms) lo = mid;
      else hi = mid;
    }
    const span = at[lo + 1] - at[lo];
    const f = span > 0 ? (ms - at[lo]) / span : 1;
    sample = {
      x: channelAt(motion.x, 0, lo, f),
      y: channelAt(motion.y, 0, lo, f),
      scale: channelAt(motion.scale, 1, lo, f),
      rotation: channelAt(motion.rotation, 0, lo, f),
      opacity: channelAt(motion.opacity, 1, lo, f),
    };
  }
  return isNeutralMotion(sample) ? null : sample;
}

function keySample(motion: ComposeOverlayMotion, i: number): OverlayMotionSample {
  return {
    x: motion.x?.[i] ?? 0,
    y: motion.y?.[i] ?? 0,
    scale: motion.scale?.[i] ?? 1,
    rotation: motion.rotation?.[i] ?? 0,
    opacity: motion.opacity?.[i] ?? 1,
  };
}

function channelAt(values: readonly number[] | undefined, neutral: number, lo: number, f: number): number {
  if (!values) return neutral;
  const a = values[lo];
  return a + (values[lo + 1] - a) * f;
}

/**
 * How much sharper than its resting size a layer's bitmap is worth drawing: the most its motion
 * magnifies it, held to 1..[MAX_MOTION_RASTER_DETAIL]. 1 - the bitmap drawn exactly as it always was
 * - for no motion and for one that never grows the layer.
 */
export function overlayRasterDetail(motion: ComposeOverlayMotion | null | undefined): number {
  const scale = motion?.scale;
  if (!scale || scale.length === 0) return 1;
  let most = 1;
  for (const value of scale) if (value > most) most = value;
  return Math.min(MAX_MOTION_RASTER_DETAIL, most);
}

/* -------------------------------------------------------------------------------------------- */
/* The wire's rules                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * The channels in the order the contract declares them and every parser reads them, each with the
 * value it holds when absent and the range it is clamped to. The ranges are not taste: they are the
 * line past which a number is a bug rather than a look, the transitions' own bounds.
 */
const MOTION_CHANNELS = [
  ['x', 0, -4, 4],
  ['y', 0, -4, 4],
  ['scale', 1, 0, 20],
  ['rotation', 0, -3600, 3600],
  ['opacity', 1, 0, 1],
] as const satisfies readonly (readonly [keyof OverlayMotionSample, number, number, number])[];

type MotionChannel = (typeof MOTION_CHANNELS)[number][0];

const MOTION_KEYS: readonly string[] = ['atMs', ...MOTION_CHANNELS.map(([name]) => name)];

/**
 * What [normaliseOverlayMotion] refuses a motion with. `field` is the part of it that broke - `atMs`,
 * `atMs[3]`, a channel's name, an unknown key - or empty for the motion as a whole, and `detail` is
 * the words a refusal of the whole adds after its path. A parser turns the pair into its own
 * `invalid_spec:<path>`, with the layer's path in front.
 */
export class OverlayMotionError extends Error {
  constructor(
    readonly field: string,
    readonly detail = '',
  ) {
    super(`motion${field ? `.${field}` : ''}${detail}`);
    this.name = 'OverlayMotionError';
  }
}

/**
 * A layer's motion made safe to draw: the parser's rules, shared by the web engine and the tests and
 * mirrored check for check by the Kotlin and Swift parsers (see [ComposeOverlayMotion]). A NEW object,
 * every value clamped, every channel that never leaves its neutral value left off - or `null` when
 * nothing moves at all, which is the absent path. Throws [OverlayMotionError] for a motion no engine
 * could honour.
 */
export function normaliseOverlayMotion(value: unknown): ComposeOverlayMotion | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new OverlayMotionError('');
  const times = value['atMs'];
  if (times === undefined || times === null) return null;
  if (!Array.isArray(times)) throw new OverlayMotionError('atMs');
  const n = times.length;
  if (n === 0) return null;

  const channels: [MotionChannel, readonly unknown[], number, number, number][] = [];
  for (const [name, neutral, min, max] of MOTION_CHANNELS) {
    const raw = value[name];
    if (raw === undefined || raw === null) continue;
    if (!Array.isArray(raw) || raw.length !== n) throw new OverlayMotionError(name);
    channels.push([name, raw, neutral, min, max]);
  }
  for (const key of Object.keys(value)) {
    if (!MOTION_KEYS.includes(key)) throw new OverlayMotionError(key);
  }
  if (n > MAX_OVERLAY_MOTION_KEYS) throw new OverlayMotionError('', ` at most ${MAX_OVERLAY_MOTION_KEYS} keys`);

  const atMs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (typeof t !== 'number' || !Number.isFinite(t)) throw new OverlayMotionError(`atMs[${i}]`);
    if (i > 0 && t < atMs[i - 1]) throw new OverlayMotionError(`atMs[${i}]`);
    atMs.push(t);
  }

  const motion: ComposeOverlayMotion = { atMs };
  for (const [name, raw, neutral, min, max] of channels) {
    const values = raw.map(v => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : neutral));
    if (values.some(v => v !== neutral)) motion[name] = values;
  }
  return Object.keys(motion).length > 1 ? motion : null;
}

/* -------------------------------------------------------------------------------------------- */
/* The presets                                                                                    */
/* -------------------------------------------------------------------------------------------- */

/** What a move may shape itself by besides its progress: how long it really runs, and what it moves. */
export interface OverlayMoveContext {
  /** The move's length as it PLAYS, after any squeeze into a short window. */
  ms: number;
  kind: OverlayKind;
}

/**
 * An in or an out, as a function of `p`, 0..1 through it. An IN ends at rest at p = 1 and an OUT
 * starts at rest at p = 0, exactly - a unit test holds every one of them to it - because anything
 * else is a jump on the frame either side of the move. Only what the move changes is returned.
 */
interface MoveRecipe {
  at(p: number, move: OverlayMoveContext): Partial<OverlayMotionSample>;
  /** Where the value JUMPS rather than moves: the flicker's stutter. Compiled as steps, not ramps. */
  steps?: readonly number[];
}

/**
 * A loop, as a function of its phase `f`, 0..1 through one period. At rest at f = 0, so a loop picks
 * up from the in without a jump, and periodic, so every cycle meets the next.
 */
interface LoopRecipe {
  at(f: number): Partial<OverlayMotionSample>;
  /** Phases where the value jumps, once per cycle: a spin wraps from 360 to 0, which is no change at all. */
  steps?: readonly number[];
}

/*
 * The curves, written for how they LOOK. Where a number is a taste it says so; where it is a
 * constraint (a move must end at rest) the tests hold it.
 */

const IN_RECIPES: Record<string, MoveRecipe> = {
  'fade': { at: p => ({ opacity: easeInOutSine(p) }) },
  'pop': {
    // CapCut's pop, as its titles do it: out of nothing to a fifth past its size, a tenth under,
    // a twentieth over, home - each swing half the last, like a ball that has been dropped. The fade
    // is over in the first 120 ms, so what the eye reads is the bounce and not a dissolve. A pop
    // given 300 ms or less is the light caption pop instead, from 0.8 with one small overshoot: a
    // whole bounce squeezed into a few frames is a jitter.
    //
    // A STICKER also turns as it pops, from -12 degrees and swinging through upright with the size,
    // which is what a sticker slapped onto a video does in every editor that has them. Text stays
    // level: a caption that tilts on its way in is harder to read at exactly the moment it is new.
    at: (p, move) => {
      const scale = through(p, move.ms <= POP_LIGHT_MS ? POP_LIGHT_FRAMES : POP_FRAMES);
      const fade = Math.min(POP_FADE_MS, 0.4 * move.ms);
      const pose: Partial<OverlayMotionSample> = { scale, opacity: easeOutQuad(fade > 0 ? (p * move.ms) / fade : 1) };
      if (move.kind === 'sticker') pose.rotation = POP_STICKER_TURN * (scale - 1);
      return pose;
    },
  },
  'slam': {
    // Thrown at the lens: huge and see-through, accelerating onto its size, then the impact - a
    // squash and a shudder that die away over the last two fifths. The approach eases IN, so it is at
    // full speed when it lands, which is what makes the landing hard.
    at: p => {
      const approach = window01(p, 0, SLAM_IMPACT);
      const impact = window01(p, SLAM_IMPACT, 1);
      const settle = (1 - impact) * (1 - impact);
      const scale = p < SLAM_IMPACT ? 1.8 - 0.8 * easeInQuad(approach) : 1 - 0.07 * Math.sin(2 * Math.PI * impact) * settle;
      return {
        scale,
        x: p < SLAM_IMPACT ? 0 : 0.005 * Math.sin(6 * Math.PI * impact) * settle,
        y: p < SLAM_IMPACT ? 0 : 0.004 * Math.sin(5 * Math.PI * impact) * settle,
        opacity: easeOutQuad(window01(p, 0, 0.3)),
      };
    },
  },
  'stamp': {
    // The drop word: there at once, at 1.6x and fully opaque, hammered down a little past its size
    // and let back up. Quick enough to hit on a single beat; the slam is the long throw of it.
    at: p => ({ scale: through(p, STAMP_FRAMES) }),
  },
  'soft': {
    // Settling in out of a slight enlargement as it fades up. The stand-in for a blur-in, which no
    // engine can draw from a bitmap and a straight line.
    at: p => ({ scale: 1.08 - 0.08 * easeOutCubic(p), opacity: easeOutQuad(p) }),
  },
  'grow': { at: p => ({ scale: 0.6 + 0.4 * easeOutCubic(p), opacity: easeOutQuad(window01(p, 0, 0.6)) }) },
  'rise': { at: p => ({ y: 0.06 * (1 - easeOutQuart(p)), opacity: easeOutQuad(window01(p, 0, 0.6)) }) },
  'drop': {
    // Falls under gravity from an eighth of the frame above, lands, bounces a little and then less.
    at: p => {
      const fall = window01(p, 0, DROP_LAND);
      const after = window01(p, DROP_LAND, 1);
      let y: number;
      if (p < DROP_LAND) y = -0.12 * (1 - easeInQuad(fall));
      else if (after < 0.7) y = -0.018 * Math.sin((Math.PI * after) / 0.7);
      else y = -0.004 * Math.sin((Math.PI * (after - 0.7)) / 0.3);
      return { y, opacity: easeOutQuad(window01(p, 0, 0.3)) };
    },
  },
  'slide-left': { at: p => ({ x: 0.12 * (1 - easeOutQuart(p)), opacity: easeOutQuad(window01(p, 0, 0.5)) }) },
  'slide-right': { at: p => ({ x: -0.12 * (1 - easeOutQuart(p)), opacity: easeOutQuad(window01(p, 0, 0.5)) }) },
  'swing': {
    // Hung from nothing and let go at -14 degrees: past upright by a quarter of that, a wobble back,
    // still. A looser spring than the pop's, because a turn reads a bigger overshoot as sway.
    at: p => ({ rotation: -14 * (1 - spring(p, SWING_SPRING)), opacity: easeOutQuad(window01(p, 0, 0.3)) }),
  },
  'spin': {
    at: p => {
      const e = easeOutCubic(p);
      return { rotation: -180 * (1 - e), scale: 0.3 + 0.7 * e, opacity: easeOutQuad(window01(p, 0, 0.4)) };
    },
  },
  'flicker': steps([
    // A neon tube catching: two blinks, a dim stutter, then on for good.
    [0, 0],
    [0.1, 0.9],
    [0.16, 0],
    [0.3, 1],
    [0.36, 0.15],
    [0.42, 0.8],
    [0.55, 0.2],
    [0.6, 1],
  ]),
};

const OUT_RECIPES: Record<string, MoveRecipe> = {
  'fade': { at: p => ({ opacity: 1 - easeInOutSine(p) }) },
  'pop': {
    // A breath in and gone: a tenth bigger, then down to nothing, disappearing as it goes.
    at: p => {
      const swell = window01(p, 0, 0.3);
      const vanish = window01(p, 0.3, 1);
      const scale = p < 0.3 ? 1 + 0.1 * easeOutQuad(swell) : 1.1 * (1 - easeInCubic(vanish));
      return { scale, opacity: 1 - easeInQuad(window01(p, 0.6, 1)) };
    },
  },
  'grow': { at: p => ({ scale: 1 + 0.5 * easeOutCubic(p), opacity: 1 - easeOutQuad(p) }) },
  'shrink': { at: p => ({ scale: 1 - easeInCubic(p), opacity: 1 - easeInQuad(window01(p, 0.5, 1)) }) },
  'sink': { at: p => ({ y: 0.06 * easeInCubic(p), opacity: 1 - easeInOutSine(p) }) },
  'lift': { at: p => ({ y: -0.06 * easeInCubic(p), opacity: 1 - easeInOutSine(p) }) },
  'slide-left': { at: p => ({ x: -0.12 * easeInQuart(p), opacity: 1 - easeInQuad(window01(p, 0.3, 1)) }) },
  'slide-right': { at: p => ({ x: 0.12 * easeInQuart(p), opacity: 1 - easeInQuad(window01(p, 0.3, 1)) }) },
  'spin': {
    at: p => {
      const e = easeInCubic(p);
      return { rotation: 180 * e, scale: 1 - 0.7 * e, opacity: 1 - easeInQuad(window01(p, 0.4, 1)) };
    },
  },
  'flicker': steps([
    // The tube failing: a blink, a recovery, two dying stutters, dark.
    [0, 1],
    [0.25, 0.1],
    [0.3, 0.9],
    [0.45, 0],
    [0.52, 0.7],
    [0.6, 0],
    [0.7, 0.4],
    [0.76, 0],
  ]),
};

const LOOP_RECIPES: Record<string, LoopRecipe> = {
  pulse: { at: f => ({ scale: 1 + 0.04 * (1 - Math.cos(2 * Math.PI * f)) }) },
  beat: {
    // A kick drum: a punch to 1.08 in the first twelfth of the period and a quick fall back, then
    // still until the next one - so a period set to the tempo lands on every beat.
    at: f => ({ scale: 1 + 0.08 * punch(f, 0, BEAT_ATTACK, BEAT_RELEASE, easeOutCubic) }),
  },
  heartbeat: {
    // Lub-dub: a strong beat and a softer one close behind it, then a rest, both falling back
    // smoothly rather than snapping the way a kick does.
    at: f => ({ scale: 1 + 0.08 * punch(f, 0, 0.05, 0.16, easeInOutSine) + 0.05 * punch(f, 0.2, 0.05, 0.2, easeInOutSine) }),
  },
  float: { at: f => ({ y: -0.008 * Math.sin(2 * Math.PI * f) }) },
  sway: { at: f => ({ rotation: 6 * Math.sin(2 * Math.PI * f) }) },
  // Faster and smaller than a sway, and two frequencies rather than one so it never looks like a
  // metronome. Whole numbers of cycles per period, so every period meets the next.
  wiggle: { at: f => ({ rotation: 2.6 * Math.sin(4 * Math.PI * f) + 1 * Math.sin(10 * Math.PI * f) }) },
  shake: {
    // Unrelated whole-number frequencies on the two axes read as a hand-held jitter, not a circle.
    // The height fraction is smaller because a portrait frame is taller than it is wide.
    at: f => ({
      x: 0.005 * (Math.sin(8 * Math.PI * f) + 0.6 * Math.sin(18 * Math.PI * f)),
      y: 0.003 * (Math.sin(12 * Math.PI * f) - 0.5 * Math.sin(22 * Math.PI * f)),
    }),
  },
  spin: { at: f => ({ rotation: 360 * f }), steps: [0] },
  breathe: { at: f => ({ opacity: 0.9 + 0.1 * Math.cos(2 * Math.PI * f) }) },
};

/**
 * One preset's curve at `p` - 0..1 through an in or an out, or the phase of a loop - with every
 * channel filled in, exactly as the compiler reads it before it touches an effect. For the unit
 * tests' sweep over the whole catalogue and for anything that wants to draw a preset's shape; null
 * for an id this version does not know. `move` defaults to the preset's own length on a text layer.
 */
export function overlayAnimationCurve(part: OverlayAnimationPart, id: string, p: number, move?: Partial<OverlayMoveContext>): OverlayMotionSample | null {
  const preset = overlayAnimationPreset(part, id);
  if (!preset) return null;
  if (part === 'loop') {
    const loop = LOOP_RECIPES[id];
    return loop ? filled(loop.at(fract(p))) : null;
  }
  const recipe = part === 'in' ? IN_RECIPES[id] : OUT_RECIPES[id];
  return recipe ? filled(recipe.at(p, { ms: move?.ms ?? preset.defaultMs, kind: move?.kind ?? 'text' })) : null;
}

/* Tastes, named so the tests and the curves agree about where the pieces meet. */
const SLAM_IMPACT = 0.6;
const DROP_LAND = 0.6;
const BEAT_ATTACK = 0.08;
const BEAT_RELEASE = 0.52;

/** A pop this short or shorter is the light caption pop. */
const POP_LIGHT_MS = 300;
/** How long a pop takes to fade all the way up, when it runs long enough to spare it. */
const POP_FADE_MS = 120;
/** The degrees a sticker's pop turns through per unit of size it has not reached yet. */
const POP_STICKER_TURN = 12;

/**
 * The pop's size at its extremes, and where they fall. Out of nothing it EASES OUT to its peak, the
 * released throw; every swing after that eases in and out, because a bounce is still at the top.
 */
const POP_FRAMES: readonly Frame[] = [
  [0, 0],
  [0.36, 1.2, easeOutCubic],
  [0.6, 0.9],
  [0.8, 1.05],
  [1, 1],
];
const POP_LIGHT_FRAMES: readonly Frame[] = [
  [0, 0.8],
  [0.55, 1.05, easeOutCubic],
  [1, 1],
];
/** Down onto the paper at full speed, so it eases IN, and back up off it. */
const STAMP_FRAMES: readonly Frame[] = [
  [0, 1.6],
  [0.65, 0.95, easeInQuad],
  [1, 1, easeOutQuad],
];

/** A damped spring's two numbers, tuned by hand for the overshoot and the moment of its peak. */
interface Spring {
  decay: number;
  frequency: number;
}
/** Peaks 25% past rest at a third of the way in, 5% back the other way at three quarters. */
const SWING_SPRING: Spring = { decay: 3.7, frequency: 7.75 };

/** A value at a moment of a curve: `[p, value]`, and the ease of the piece that ARRIVES at it. */
type Frame = readonly [number, number, ((t: number) => number)?];

/**
 * The curve through `frames` at `p`: each piece runs from one frame's value to the next one's, over
 * the ease the next frame names - `easeInOutSine` where it names none, which is flat at both ends and
 * so turns smoothly at every peak and trough.
 */
function through(p: number, frames: readonly Frame[]): number {
  if (p <= frames[0][0]) return frames[0][1];
  for (let i = 1; i < frames.length; i++) {
    const [to, value, ease] = frames[i];
    if (p <= to) {
      const [from, start] = frames[i - 1];
      return start + (value - start) * (ease ?? easeInOutSine)((p - from) / (to - from));
    }
  }
  return frames[frames.length - 1][1];
}

/**
 * One punch of a loop that pulses: 0 until `at`, up to 1 over `attack` of the period, back to 0 over
 * `release` along `fall`, and 0 again after - all measured in the loop's phase.
 */
function punch(f: number, at: number, attack: number, release: number, fall: (t: number) => number): number {
  const t = f - at;
  if (t <= 0) return 0;
  if (t < attack) return easeOutQuad(t / attack);
  if (t < attack + release) return 1 - fall((t - attack) / release);
  return 0;
}

/**
 * A spring released from 0 towards 1, `1 - e^(-decay p) cos(frequency p)`, with what is left of its
 * wobble at p = 1 taken off in a straight line - a few thousandths - so it lands EXACTLY on 1 there
 * rather than on a number a rounding away from it.
 */
function spring(p: number, { decay, frequency }: Spring): number {
  const raw = (q: number) => 1 - Math.exp(-decay * q) * Math.cos(frequency * q);
  return raw(p) - p * (raw(1) - 1);
}

/** A curve that holds each level from its moment until the next one's, as steps. */
function steps(levels: readonly (readonly [number, number])[]): MoveRecipe {
  return {
    at: p => {
      let opacity = levels[0][1];
      for (const [from, level] of levels) if (p >= from) opacity = level;
      return { opacity };
    },
    steps: levels.slice(1).map(([from]) => from),
  };
}

/* -------------------------------------------------------------------------------------------- */
/* Compiling                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/** The finest a move is sampled: one key per frame at 60 fps, the camera's rate. */
const SAMPLE_MS = 1000 / 60;

/**
 * The fewest keys a loop's cycle is ever given. A sine drawn through eight straight lines is off by
 * under a tenth of its swing, and the eye takes it for the curve; fewer and a pulse starts to limp.
 */
const MIN_KEYS_PER_CYCLE = 8;

/** One key of the motion being built, in window-relative milliseconds until it is written out. */
interface Key {
  t: number;
  pose: OverlayMotionSample;
}

/**
 * The motion a layer's animation compiles to over `window` - the layer's own `startMs..endMs` on the
 * OUTPUT timeline, as the wire carries it - or `null` when it has none, which is the ABSENT key on the
 * wire and every engine's old path.
 *
 * The in runs from the window's start and ends at rest, the out starts at rest and runs to its end,
 * and the loop runs between them with its phase 0 where the in ends. The out moves from wherever the
 * loop LEFT the layer rather than snapping it back to rest first: every channel of the loop's last
 * pose is carried into the out (added, or multiplied for the size and the opacity), so a swaying
 * sticker leaves at the angle it had reached. Between moves, and without a loop, the layer is at
 * rest and needs no keys: the wire draws a straight line between two equal ones.
 *
 * An EFFECT is the whole frame and never moves: only the opacity of each preset reaches it, so a leak
 * that pops in fades in, and a loop with no opacity in it compiles to nothing at all.
 *
 * Sampled a key per 60th of a second. A layer so long that would pass [MAX_OVERLAY_MOTION_KEYS] is
 * COARSENED, the camera's rule - but a loop never below [MIN_KEYS_PER_CYCLE] keys a cycle, because a
 * shake sampled slower than it shakes is not a coarse shake, it is a different and wrong move. A loop
 * that still does not fit at that is played for as many whole cycles as do, from its start, and the
 * layer rests after them: at a cycle's end it is exactly at rest, so nothing jumps. That takes minutes
 * of a fast loop on one layer, and no template comes near it.
 */
export function compileOverlayMotion(window: { startMs: number; endMs: number }, animation: OverlayAnimation | null | undefined, kind: OverlayKind): ComposeOverlayMotion | null {
  const normal = normaliseOverlayAnimation(animation);
  if (!normal) return null;
  const windowMs = window.endMs - window.startMs;
  if (!Number.isFinite(window.startMs) || !(windowMs > 0)) return null;
  const spans = overlayAnimationSpans(normal, windowMs);
  const period = normal.loop?.periodMs ?? 0;
  let loopMs = spans.loopEndMs - spans.loopStartMs;
  for (let step = SAMPLE_MS; ; ) {
    const keys = compileKeys(normal, spans, loopMs, windowMs, step, kind);
    if (keys.length <= MAX_OVERLAY_MOTION_KEYS) return toMotion(keys, window.startMs);
    if (period > 0 && loopMs > period && step >= period / MIN_KEYS_PER_CYCLE) {
      // The loop is as coarse as it may be and is what does not fit: fewer whole cycles of it, cut
      // with a margin so the next pass lands under the cap rather than on it.
      const cycles = Math.floor((loopMs / period) * (MAX_OVERLAY_MOTION_KEYS / keys.length) * 0.9);
      if (cycles >= 1 && cycles * period < loopMs) {
        loopMs = cycles * period;
        continue;
      }
    }
    if (step > 10_000) return toMotion(keys.slice(0, MAX_OVERLAY_MOTION_KEYS), window.startMs);
    step *= 2;
  }
}

/**
 * Every key of the motion at one sampling `step`, in window-relative time, with the loop played for
 * `loopMs` from where the in ends - the whole of the room between the moves, unless the key cap took
 * some of it back.
 */
function compileKeys(animation: OverlayAnimation, spans: OverlayAnimationSpans, loopMs: number, windowMs: number, step: number, kind: OverlayKind): Key[] {
  const opacityOnly = kind === 'effect';
  const keys: Key[] = [];
  const push = (t: number, pose: OverlayMotionSample) => {
    const time = Math.round(t * 1000) / 1000;
    const value = roundPose(opacityOnly ? { ...NEUTRAL_MOTION, opacity: pose.opacity } : pose);
    const last = keys[keys.length - 1];
    if (last && last.t === time && samePose(last.pose, value)) return;
    keys.push({ t: time, pose: value });
  };

  const arrive = animation.in ? IN_RECIPES[animation.in.id] : undefined;
  if (arrive && spans.inMs > 0) {
    const move: OverlayMoveContext = { ms: spans.inMs, kind };
    sampleMove(push, 0, spans.inMs, step, arrive, move, NEUTRAL_MOTION);
  }

  const loop = animation.loop ? LOOP_RECIPES[animation.loop.id] : undefined;
  let left: OverlayMotionSample = NEUTRAL_MOTION;
  // A loop that moves nothing the layer can show - a pulse on an effect - is no loop at all.
  if (loop && animation.loop && loopMs > 0 && (!opacityOnly || touchesOpacity(loop))) {
    const period = animation.loop.periodMs;
    const at = (tau: number) => filled(loop.at(fract(tau / period)));
    const jumps: Jump[] = [];
    // Each cycle's jumps, strictly inside the loop: at its very start there is nothing to jump from.
    for (let cycle = 0; cycle * period < loopMs; cycle++) {
      for (const phase of loop.steps ?? []) {
        const tau = (cycle + phase) * period;
        if (tau > 0 && tau < loopMs) jumps.push({ u: tau, before: () => filled(loop.at(fract(phase - 1e-9))), after: () => filled(loop.at(phase)) });
      }
    }
    sampleSpan(push, spans.loopStartMs, loopMs, Math.min(step, period / MIN_KEYS_PER_CYCLE), at, jumps);
    left = at(loopMs);
    // Cut short by the key cap: the loop came to rest at the end of a whole cycle, and stays there.
    if (spans.loopStartMs + loopMs < spans.loopEndMs) push(spans.loopEndMs, left);
  }

  const leave = animation.out ? OUT_RECIPES[animation.out.id] : undefined;
  if (leave && spans.outMs > 0) {
    const move: OverlayMoveContext = { ms: spans.outMs, kind };
    sampleMove(push, windowMs - spans.outMs, spans.outMs, step, leave, move, left);
  }
  return withoutHolds(keys);
}

/** An in or an out, `span` long from `t0`, carried on from `from` (the loop's last pose, or rest). */
function sampleMove(
  push: (t: number, pose: OverlayMotionSample) => void,
  t0: number,
  span: number,
  step: number,
  recipe: MoveRecipe,
  move: OverlayMoveContext,
  from: OverlayMotionSample,
): void {
  const at = (p: number) => combine(from, filled(recipe.at(p, move)));
  const jumps: Jump[] = (recipe.steps ?? []).map(s => ({ u: s * span, before: () => at(Math.max(0, s - 1e-9)), after: () => at(s) }));
  sampleSpan(push, t0, span, step, u => at(u / span), jumps);
}

/**
 * A place where a curve JUMPS: `u` into its span, with its value just before and at the jump. Both
 * are worked out from the jump's own exact parameter rather than from `u`, which a round trip through
 * a division could land a hair either side of - on the wrong side of a flicker's step, or of a spin's
 * wrap from 360 back to 0.
 */
interface Jump {
  u: number;
  before: () => OverlayMotionSample;
  after: () => OverlayMotionSample;
}

/**
 * One curve sampled over `span` milliseconds from `t0`: evenly, at most `step` apart, both ends
 * included, and at every jump twice - its value before and at the jump, at one time, which the wire
 * reads as a step. `at` is read at a time into the span. A span with no length is no move: the keys
 * either side of it make the cut.
 */
function sampleSpan(
  push: (t: number, pose: OverlayMotionSample) => void,
  t0: number,
  span: number,
  step: number,
  at: (u: number) => OverlayMotionSample,
  jumps: readonly Jump[],
): void {
  if (!(span > 0)) return;
  const n = Math.max(1, Math.ceil(span / step - 1e-9));
  const sorted = [...jumps].sort((a, b) => a.u - b.u);
  let next = 0;
  for (let k = 0; k <= n; k++) {
    const u = (span * k) / n;
    while (next < sorted.length && sorted[next].u <= u + JUMP_SLACK_MS) {
      const jump = sorted[next++];
      push(t0 + jump.u, jump.before());
      push(t0 + jump.u, jump.after());
    }
    // A regular sample landing ON a jump would read one side of it by the accident of a rounding.
    const previous = sorted[next - 1];
    if (previous && Math.abs(previous.u - u) <= JUMP_SLACK_MS) continue;
    push(t0 + u, at(u));
  }
}

/** How close to a jump a regular sample is taken to be ON it: far under a frame, far over a rounding. */
const JUMP_SLACK_MS = 1e-3;

/** Whether a loop changes the opacity anywhere, which is all an effect can show of it. */
function touchesOpacity(loop: LoopRecipe): boolean {
  return [0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875].some(f => loop.at(f).opacity !== undefined);
}

/** The loop's last pose carried into the out: offsets and turns add, size and opacity multiply. */
function combine(a: OverlayMotionSample, b: OverlayMotionSample): OverlayMotionSample {
  return { x: a.x + b.x, y: a.y + b.y, scale: a.scale * b.scale, rotation: a.rotation + b.rotation, opacity: a.opacity * b.opacity };
}

/**
 * The keys with every one that sits in the middle of a HOLD taken out: a key equal to both of its
 * neighbours says nothing a straight line between them does not. That is all a flicker's plateaus and
 * a spin's straight runs cost otherwise, and it is exact - nothing that moves is touched.
 */
function withoutHolds(keys: Key[]): Key[] {
  if (keys.length < 3) return keys;
  const kept: Key[] = [keys[0]];
  for (let i = 1; i < keys.length - 1; i++) {
    const prev = kept[kept.length - 1];
    if (samePose(prev.pose, keys[i].pose) && samePose(keys[i].pose, keys[i + 1].pose)) continue;
    kept.push(keys[i]);
  }
  kept.push(keys[keys.length - 1]);
  return kept;
}

function toMotion(keys: Key[], startMs: number): ComposeOverlayMotion | null {
  if (keys.length === 0) return null;
  const motion: ComposeOverlayMotion = { atMs: keys.map(key => Math.round((startMs + key.t) * 1000) / 1000) };
  for (const [name, neutral] of MOTION_CHANNELS) {
    if (keys.some(key => key.pose[name] !== neutral)) motion[name] = keys.map(key => key.pose[name]);
  }
  return Object.keys(motion).length > 1 ? motion : null;
}

/* -------------------------------------------------------------------------------------------- */

function filled(partial: Partial<OverlayMotionSample>): OverlayMotionSample {
  return { ...NEUTRAL_MOTION, ...partial };
}

/** Six decimals keep a long layer's JSON small and are far below a pixel, a degree's thousandth and an alpha step. */
function roundPose(pose: OverlayMotionSample): OverlayMotionSample {
  return { x: round6(pose.x), y: round6(pose.y), scale: round6(pose.scale), rotation: round6(pose.rotation), opacity: round6(pose.opacity) };
}

function round6(value: number): number {
  // `+ 0` folds a -0 into 0, so a channel at rest compares equal to its neutral value.
  return Math.round(value * 1e6) / 1e6 + 0;
}

function samePose(a: OverlayMotionSample, b: OverlayMotionSample): boolean {
  return a.x === b.x && a.y === b.y && a.scale === b.scale && a.rotation === b.rotation && a.opacity === b.opacity;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fract(value: number): number {
  return value - Math.floor(value);
}

/** How far `p` is through `from..to`, held to 0..1: one piece of a move measured on its own. */
function window01(p: number, from: number, to: number): number {
  return clamp01((p - from) / (to - from));
}

function clamp01(v: number): number {
  return v <= 0 ? 0 : v >= 1 ? 1 : v;
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * clamp01(t)) - 1) / 2;
}

function easeOutQuad(t: number): number {
  const u = clamp01(t);
  return 1 - (1 - u) * (1 - u);
}

function easeInQuad(t: number): number {
  const u = clamp01(t);
  return u * u;
}

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - clamp01(t), 3);
}

function easeInCubic(t: number): number {
  return Math.pow(clamp01(t), 3);
}

function easeOutQuart(t: number): number {
  return 1 - Math.pow(1 - clamp01(t), 4);
}

function easeInQuart(t: number): number {
  return Math.pow(clamp01(t), 4);
}
