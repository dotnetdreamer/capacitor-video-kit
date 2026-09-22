import type { ComposeTransition, ComposeTransitionCurves, ComposeTransitionMask, ComposeTransitionSideCurves } from '../video-composer/definitions';
import type { EditClip, EditTransition } from './edit-manifest';

/**
 * Transitions between two clips of the base track: what they are called, how long they may run, and
 * what each one LOOKS like at every moment of its run.
 *
 * The timing is the one every editor a customer has used shares. A transition OVERLAPS the two clips
 * it joins: the incoming clip starts `d` early, under the last `d` of the outgoing one, so the post
 * gets `d` shorter and both clips keep every frame they had. Nothing is frozen and nothing is
 * repeated, which is what a transition centred on the cut would have needed on whichever side ran out
 * of footage first.
 *
 * What a transition looks like is not code in each engine. It is a handful of numbers per side -
 * where the side's whole frame has moved to, how big it is, how blurred, how tinted - sampled at
 * evenly spaced moments by [compileTransition] and sent on the wire as they are, so the preview, the
 * web render and both native renders draw the SAME numbers through the same few operations. A new
 * transition built from those operations reaches every engine without a line of native code, and
 * two engines cannot disagree about an easing curve because none of them has one.
 *
 * Ids are stored in manifests, so they are permanent: a renamed id would silently drop the
 * transition from every saved draft. Labels can change; ids cannot.
 */

/* -------------------------------------------------------------------------------------------- */
/* Catalogue                                                                                      */
/* -------------------------------------------------------------------------------------------- */

export type TransitionCategory = 'basic' | 'camera' | 'mask' | 'effect';

export interface TransitionPreset {
  id: string;
  label: string;
  category: TransitionCategory;
  /**
   * The moment a still thumbnail is drawn at. The middle of most transitions says what they are - two
   * pictures half dissolved, half slid - but the middle of a dip to black is a black square.
   */
  posterAt: number;
}

export const TRANSITION_CATEGORIES: readonly { id: TransitionCategory; label: string }[] = [
  { id: 'basic', label: 'Basic' },
  { id: 'camera', label: 'Camera' },
  { id: 'mask', label: 'Mask' },
  { id: 'effect', label: 'Effect' },
];

/** Shortest transition worth drawing. Anything the clamp brings below this is a plain cut. */
export const MIN_TRANSITION_MS = 100;
/** Longest a customer can ask for. The clips either side can still hold it to less. */
export const MAX_TRANSITION_MS = 2000;
/** What a transition is given when it is first chosen. */
export const DEFAULT_TRANSITION_MS = 500;
/** The duration slider's step, and what [maxTransitionMs] rounds down to. */
export const TRANSITION_STEP_MS = 100;

/**
 * How many evenly spaced moments a transition is sampled at, both ends included. Forty intervals is
 * a sample every 25 ms of a one-second transition - finer than the frames of a 30 fps render - and
 * the fastest thing any transition does (a shake's wobble) still gets seven samples per swing.
 */
export const TRANSITION_SAMPLES = 41;

/* -------------------------------------------------------------------------------------------- */
/* What a transition looks like                                                                   */
/* -------------------------------------------------------------------------------------------- */

/**
 * One side of a transition - the outgoing clip or the incoming one - at one moment.
 *
 * Every field acts on the side's WHOLE output frame: its picture as it would be drawn with no
 * transition at all (cropped, fitted, placed, graded) together with the black around it. Moving the
 * picture alone would leave the black bars of a letterboxed clip standing still while the picture
 * slid out of them, which is not what anybody means by a slide.
 */
export interface TransitionSide {
  /** Offset of the whole frame, as a fraction of the output width. Positive is right. */
  x: number;
  /** Offset of the whole frame, as a fraction of the output height. Positive is down. */
  y: number;
  /** Size about the frame's centre. 1 is as it is. */
  scale: number;
  /** Clockwise degrees about the frame's centre, measured in output pixels. */
  rotation: number;
  /** Gaussian blur, its sigma a fraction of the output's SHORTER side. 0 is sharp. */
  blur: number;
  /** Mosaic cell size, a fraction of the output's shorter side, cells centred on the frame. 0 is none. */
  pixelate: number;
  /** Red and blue pulled apart sideways, each by this fraction of the output width. 0 is none. */
  split: number;
  /** Multiplies the colour before [tint]. 1 is as it is. */
  gain: number;
  /** 0..1 towards the side's tint colour: black for a dip to black, white for a flash. */
  tint: number;
}

export const NEUTRAL_SIDE: Readonly<TransitionSide> = Object.freeze({
  x: 0,
  y: 0,
  scale: 1,
  rotation: 0,
  blur: 0,
  pixelate: 0,
  split: 0,
  gain: 1,
  tint: 0,
});

/** Everything a transition is at one moment. */
export interface TransitionLook {
  /** How much of the incoming side is drawn over the outgoing one, 0..1, everywhere at once. */
  alpha: number;
  /** How far [ComposeTransitionMask] has opened, 0..1. Meaningless without a mask. */
  reveal: number;
  from: TransitionSide;
  to: TransitionSide;
}

export type RGB = [number, number, number];

interface Recipe {
  mask?: ComposeTransitionMask;
  fromTint?: RGB;
  toTint?: RGB;
  /** Only what the transition moves; everything left out holds its neutral value. */
  look(p: number): { alpha?: number; reveal?: number; from?: Partial<TransitionSide>; to?: Partial<TransitionSide> };
}

const BLACK: RGB = [0, 0, 0];
const WHITE: RGB = [1, 1, 1];
const EMBER: RGB = [1, 0.45, 0.1];

/*
 * Every recipe owes the two ends the same thing, and a unit test holds every one of them to it:
 * at p = 0 the frame is the outgoing clip exactly as it plays without a transition, and at p = 1 it
 * is the incoming clip exactly as it plays after. Anything else is a jump on the frame either side of
 * the window.
 */
const RECIPES: Record<string, Recipe> = {
  /* -- Basic --------------------------------------------------------------------------------- */
  'dissolve': { look: p => ({ alpha: easeInOutSine(p) }) },
  'blur': {
    look: p => ({
      alpha: smoothstep(0.3, 0.7, p),
      from: { blur: 0.022 * smooth(clamp01(p / 0.6)) },
      to: { blur: 0.022 * smooth(clamp01((1 - p) / 0.6)) },
    }),
  },
  'black': dip(BLACK),
  'white': dip(WHITE),
  'bloom': {
    fromTint: WHITE,
    toTint: WHITE,
    look: p => {
      const k = Math.sin(Math.PI * p);
      const glow = { gain: 1 + 1.4 * k, tint: 0.55 * k * k, blur: 0.012 * k };
      return { alpha: smoothstep(0.4, 0.6, p), from: glow, to: glow };
    },
  },
  'slide-left': push(-1, 0, easeInOutCubic),
  'slide-right': push(1, 0, easeInOutCubic),
  'slide-up': push(0, -1, easeInOutCubic),
  'slide-down': push(0, 1, easeInOutCubic),

  /* -- Camera -------------------------------------------------------------------------------- */
  'zoom-in': {
    look: p => {
      const a = easeInCubic(clamp01(p / 0.85));
      return { alpha: smoothstep(0.5, 1, p), from: { scale: 1 + 1.6 * a, blur: 0.02 * a } };
    },
  },
  'zoom-out': {
    look: p => {
      const b = easeOutCubic(clamp01((p - 0.15) / 0.85));
      return { alpha: smoothstep(0, 0.5, p), to: { scale: 2.6 - 1.6 * b, blur: 0.02 * (1 - b) } };
    },
  },
  'spin': {
    look: p => {
      const a = easeInCubic(clamp01(2 * p));
      const b = easeOutCubic(clamp01(2 * p - 1));
      return {
        alpha: p < 0.5 ? 0 : 1,
        from: { scale: 1 - 0.92 * a, rotation: 180 * a },
        to: { scale: 0.08 + 0.92 * b, rotation: -180 * (1 - b) },
      };
    },
  },
  'shake': {
    look: p => {
      const k = Math.sin(Math.PI * p);
      const amp = 0.035 * k;
      const side = {
        x: amp * Math.sin(2 * Math.PI * 4.5 * p + 0.3),
        y: 0.6 * amp * Math.sin(2 * Math.PI * 5.5 * p + 1.7),
        // A little larger while it shakes, so the edges it shakes away from never show black.
        scale: 1 + 0.12 * k,
        blur: 0.006 * k,
      };
      return { alpha: smoothstep(0.42, 0.58, p), from: side, to: side };
    },
  },
  'whip-left': whip(-1),
  'whip-right': whip(1),

  /* -- Mask ---------------------------------------------------------------------------------- */
  // `angleDeg` is the way the edge TRAVELS, so a wipe left reveals the incoming clip from the right.
  'wipe-left': wipe({ shape: 'linear', angleDeg: 180, feather: 0.015 }),
  'wipe-right': wipe({ shape: 'linear', angleDeg: 0, feather: 0.015 }),
  'wipe-up': wipe({ shape: 'linear', angleDeg: 270, feather: 0.015 }),
  'wipe-down': wipe({ shape: 'linear', angleDeg: 90, feather: 0.015 }),
  'circle-open': { mask: { shape: 'circle', feather: 0.02 }, look: p => ({ reveal: easeInOutCubic(p) }) },
  // The outgoing clip closes down to a point: the incoming one is what lies OUTSIDE a shrinking circle.
  'circle-close': { mask: { shape: 'circle', feather: 0.02, invert: true }, look: p => ({ reveal: 1 - easeInOutCubic(p) }) },
  'clock': wipe({ shape: 'clock', feather: 0.004 }),
  'blinds': wipe({ shape: 'blinds', angleDeg: 90, count: 8, feather: 0.04 }),

  /* -- Effect -------------------------------------------------------------------------------- */
  'flash': {
    fromTint: WHITE,
    toTint: WHITE,
    look: p => {
      const a = easeInCubic(clamp01(2 * p));
      const b = easeOutCubic(clamp01(2 * p - 1));
      return {
        alpha: p < 0.5 ? 0 : 1,
        from: { gain: 1 + 5 * a, tint: a },
        to: { gain: 1 + 5 * (1 - b), tint: 1 - b },
      };
    },
  },
  'pixelate': {
    look: p => {
      const cells = { pixelate: 0.09 * Math.sin(Math.PI * p) };
      return { alpha: smoothstep(0.4, 0.6, p), from: cells, to: cells };
    },
  },
  'glitch': {
    look: p => {
      const k = Math.sin(Math.PI * p);
      const side = {
        split: 0.025 * k * (0.6 + 0.4 * Math.sin(2 * Math.PI * 7 * p)),
        x: 0.02 * k * Math.sign(Math.sin(2 * Math.PI * 6 * p + 0.5)),
      };
      // The cut flickers: the incoming clip shows, drops out, and comes back for good.
      const alpha = p < 0.35 ? 0 : p < 0.42 ? 1 : p < 0.5 ? 0 : p < 0.58 ? 1 : p < 0.63 ? 0 : 1;
      return { alpha, from: side, to: side };
    },
  },
  'burn': {
    fromTint: EMBER,
    toTint: EMBER,
    look: p => {
      const a = easeInCubic(clamp01(2 * p));
      const b = easeOutCubic(clamp01(2 * p - 1));
      return {
        alpha: smoothstep(0.4, 0.6, p),
        from: { gain: 1 + 1.2 * a, tint: 0.9 * a },
        to: { gain: 1 + 1.2 * (1 - b), tint: 0.9 * (1 - b) },
      };
    },
  },
};

export const TRANSITIONS: readonly TransitionPreset[] = [
  { id: 'dissolve', label: 'Dissolve', category: 'basic', posterAt: 0.5 },
  { id: 'blur', label: 'Blur', category: 'basic', posterAt: 0.35 },
  { id: 'black', label: 'Black', category: 'basic', posterAt: 0.3 },
  { id: 'white', label: 'White', category: 'basic', posterAt: 0.3 },
  { id: 'bloom', label: 'Bloom', category: 'basic', posterAt: 0.4 },
  { id: 'slide-left', label: 'Slide left', category: 'basic', posterAt: 0.5 },
  { id: 'slide-right', label: 'Slide right', category: 'basic', posterAt: 0.5 },
  { id: 'slide-up', label: 'Slide up', category: 'basic', posterAt: 0.5 },
  { id: 'slide-down', label: 'Slide down', category: 'basic', posterAt: 0.5 },
  { id: 'zoom-in', label: 'Zoom in', category: 'camera', posterAt: 0.55 },
  { id: 'zoom-out', label: 'Zoom out', category: 'camera', posterAt: 0.4 },
  { id: 'spin', label: 'Spin', category: 'camera', posterAt: 0.35 },
  { id: 'shake', label: 'Shake', category: 'camera', posterAt: 0.3 },
  { id: 'whip-left', label: 'Whip left', category: 'camera', posterAt: 0.45 },
  { id: 'whip-right', label: 'Whip right', category: 'camera', posterAt: 0.45 },
  { id: 'wipe-left', label: 'Wipe left', category: 'mask', posterAt: 0.5 },
  { id: 'wipe-right', label: 'Wipe right', category: 'mask', posterAt: 0.5 },
  { id: 'wipe-up', label: 'Wipe up', category: 'mask', posterAt: 0.5 },
  { id: 'wipe-down', label: 'Wipe down', category: 'mask', posterAt: 0.5 },
  { id: 'circle-open', label: 'Circle open', category: 'mask', posterAt: 0.5 },
  { id: 'circle-close', label: 'Circle close', category: 'mask', posterAt: 0.5 },
  { id: 'clock', label: 'Clock', category: 'mask', posterAt: 0.4 },
  { id: 'blinds', label: 'Blinds', category: 'mask', posterAt: 0.5 },
  { id: 'flash', label: 'Flash', category: 'effect', posterAt: 0.3 },
  { id: 'pixelate', label: 'Pixelate', category: 'effect', posterAt: 0.4 },
  { id: 'glitch', label: 'Glitch', category: 'effect', posterAt: 0.4 },
  { id: 'burn', label: 'Burn', category: 'effect', posterAt: 0.4 },
];

export function transitionPreset(id: string): TransitionPreset | null {
  return TRANSITIONS.find(preset => preset.id === id) ?? null;
}

export function isTransitionKind(id: unknown): id is string {
  return typeof id === 'string' && Object.prototype.hasOwnProperty.call(RECIPES, id);
}

/* -------------------------------------------------------------------------------------------- */
/* Timing                                                                                         */
/* -------------------------------------------------------------------------------------------- */

/** A segment's length on the output timeline. Kept here so this file needs nothing from the ops. */
function durationOf(clip: EditClip): number {
  return Math.max(0, clip.outMs - clip.inMs) / (clip.speed || 1);
}

/**
 * How one boundary of the base track actually runs.
 *
 * `ms` is the overlap on the OUTPUT timeline and `sourceMs` is how much of the outgoing clip's
 * source that overlap takes, a whole number of milliseconds because the wire carries trims in whole
 * milliseconds. `ms` is `sourceMs` divided back through the outgoing clip's speed rather than the
 * duration asked for, so the editor's timeline and every engine's measure the same overlap to the
 * last fraction of a millisecond.
 */
export interface TransitionSpan {
  ms: number;
  sourceMs: number;
}

const NO_SPAN: TransitionSpan = Object.freeze({ ms: 0, sourceMs: 0 });

/**
 * The overlap between `prev` and `clip`, from `clip`'s [EditClip.transitionIn].
 *
 * What was STORED is what the customer picked, and it is clamped here, where it is read, rather
 * than when it is written. A trim dragged shorter and back again would otherwise shrink the
 * transition for good, because a live drag writes its every step through the same ops.
 *
 * Held to half of EITHER clip. That is the rule that makes the overlap model work: a clip's own
 * incoming and outgoing transitions then never overlap each other, so at most two clips are ever on
 * screen at once, and every engine can hold the outgoing tails on one extra sequence.
 */
export function transitionSpan(prev: EditClip | undefined, clip: EditClip): TransitionSpan {
  const wanted = clip.transitionIn;
  if (!prev || !wanted || !isTransitionKind(wanted.kind)) return NO_SPAN;
  // The room is rounded down to the slider's step, the same way [maxTransitionMs] rounds it, so a
  // transition the clips have squeezed runs for exactly the longest the slider can show.
  const room = maxTransitionMs(prev, clip);
  const ms = Math.floor(Math.min(wanted.durationMs, MAX_TRANSITION_MS, room));
  if (ms < MIN_TRANSITION_MS) return NO_SPAN;
  const speed = prev.speed || 1;
  const sourceMs = Math.floor(ms * speed);
  if (sourceMs < 1) return NO_SPAN;
  return { ms: sourceMs / speed, sourceMs };
}

/** [transitionSpan] for every clip of a sequence; the first clip's is always none. */
export function transitionSpans(clips: readonly EditClip[]): TransitionSpan[] {
  return clips.map((clip, i) => transitionSpan(clips[i - 1], clip));
}

/**
 * The longest transition the two clips either side of a boundary can hold, rounded down to the
 * slider's step. 0 when they cannot hold even [MIN_TRANSITION_MS].
 */
export function maxTransitionMs(prev: EditClip | undefined, clip: EditClip | undefined): number {
  if (!prev || !clip) return 0;
  const room = Math.min(durationOf(prev), durationOf(clip)) / 2;
  const max = Math.floor(Math.min(MAX_TRANSITION_MS, room) / TRANSITION_STEP_MS) * TRANSITION_STEP_MS;
  return max >= MIN_TRANSITION_MS ? max : 0;
}

/** A stored transition, brought into range. Null for anything that is not one. */
export function normaliseTransition(value: unknown): EditTransition | null {
  const raw = value as Partial<EditTransition> | null | undefined;
  if (!raw || !isTransitionKind(raw.kind)) return null;
  const durationMs = typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs) ? raw.durationMs : DEFAULT_TRANSITION_MS;
  return { kind: raw.kind, durationMs: Math.round(Math.min(MAX_TRANSITION_MS, Math.max(MIN_TRANSITION_MS, durationMs))) };
}

/* -------------------------------------------------------------------------------------------- */
/* The wire form                                                                                  */
/* -------------------------------------------------------------------------------------------- */

/** What a transition sends to an engine besides the outgoing clip. */
export type CompiledTransition = Omit<ComposeTransition, 'from'>;

const SIDE_CHANNELS = ['x', 'y', 'scale', 'rotation', 'blur', 'pixelate', 'split', 'gain', 'tint'] as const satisfies readonly (keyof TransitionSide)[];

const compiled = new Map<string, CompiledTransition>();

/**
 * A transition as numbers: its mask and tint colours, and every channel it moves sampled at
 * [TRANSITION_SAMPLES] evenly spaced moments. A channel that never leaves its neutral value is left
 * out, so a dissolve sends one curve rather than nineteen.
 *
 * Cached per kind and FROZEN, because the preview asks for it on every frame of a transition and
 * the result is the same every time.
 */
export function compileTransition(kind: string): CompiledTransition | null {
  const cached = compiled.get(kind);
  if (cached) return cached;
  if (!isTransitionKind(kind)) return null;
  const recipe = RECIPES[kind];
  const looks: TransitionLook[] = [];
  for (let i = 0; i < TRANSITION_SAMPLES; i++) looks.push(recipeLook(recipe, i / (TRANSITION_SAMPLES - 1)));

  const curves: ComposeTransitionCurves = {};
  const alpha = channel(looks, look => look.alpha, 1);
  if (alpha) curves.alpha = alpha;
  const reveal = channel(looks, look => look.reveal, 1);
  if (reveal) curves.reveal = reveal;
  for (const side of ['from', 'to'] as const) {
    const sideCurves: ComposeTransitionSideCurves = {};
    let any = false;
    for (const name of SIDE_CHANNELS) {
      const values = channel(looks, look => look[side][name], NEUTRAL_SIDE[name]);
      if (values) {
        sideCurves[name] = values;
        any = true;
      }
    }
    if (any) curves[side] = sideCurves;
  }

  const result: CompiledTransition = { kind, curves };
  if (recipe.mask) result.mask = { ...recipe.mask };
  if (recipe.fromTint && !sameRgb(recipe.fromTint, BLACK)) result.fromTint = [...recipe.fromTint];
  if (recipe.toTint && !sameRgb(recipe.toTint, BLACK)) result.toTint = [...recipe.toTint];
  deepFreeze(result);
  compiled.set(kind, result);
  return result;
}

function recipeLook(recipe: Recipe, p: number): TransitionLook {
  const look = recipe.look(p);
  return {
    alpha: clamp01(look.alpha ?? 1),
    reveal: clamp01(look.reveal ?? 1),
    from: { ...NEUTRAL_SIDE, ...look.from },
    to: { ...NEUTRAL_SIDE, ...look.to },
  };
}

/** Five decimals: a hundred-thousandth of the frame is well under a pixel of any output. */
function channel(looks: TransitionLook[], read: (look: TransitionLook) => number, neutral: number): number[] | null {
  const values = looks.map(look => Math.round(read(look) * 100_000) / 100_000 + 0);
  return values.every(v => v === neutral) ? null : values;
}

/**
 * The look at progress `p` (0..1 through the window), read off the sampled curves by straight-line
 * interpolation between the two samples either side. This is THE evaluation: every engine does
 * exactly this with the numbers it was sent, which is what keeps them in step.
 */
export function lookAt(curves: ComposeTransitionCurves, p: number): TransitionLook {
  return {
    alpha: sample(curves.alpha, p, 1),
    reveal: sample(curves.reveal, p, 1),
    from: sideAt(curves.from, p),
    to: sideAt(curves.to, p),
  };
}

function sideAt(curves: ComposeTransitionSideCurves | undefined, p: number): TransitionSide {
  if (!curves) return { ...NEUTRAL_SIDE };
  const side = { ...NEUTRAL_SIDE };
  for (const name of SIDE_CHANNELS) side[name] = sample(curves[name], p, NEUTRAL_SIDE[name]);
  return side;
}

/** One curve at `p`. Absent is the neutral value; `p` outside 0..1 holds the end sample. */
export function sample(values: readonly number[] | undefined, p: number, neutral: number): number {
  if (!values || values.length === 0) return neutral;
  if (values.length === 1) return values[0];
  const x = clamp01(Number.isFinite(p) ? p : 0) * (values.length - 1);
  const i = Math.min(Math.floor(x), values.length - 2);
  const f = x - i;
  return values[i] + (values[i + 1] - values[i]) * f;
}

/* -------------------------------------------------------------------------------------------- */
/* The reference drawing                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * How much of the incoming side a mask lets through at output pixel (`qx`, `qy`) of a `w` x `h`
 * frame, 0..1.
 *
 * Every shape is a measure `u` of where the pixel is, 0..1 over the frame, and the mask is the part
 * with `u` below the reveal, softened by `feather` (in the same 0..1 units). The reveal is widened by
 * the feather at both ends so that 0 lets nothing through and 1 lets everything through, soft edge
 * and all. All distances are in output PIXELS, so a circle is round on a portrait frame.
 */
export function maskAlpha(mask: ComposeTransitionMask, reveal: number, qx: number, qy: number, w: number, h: number): number {
  const u = maskMeasure(mask, qx, qy, w, h);
  const fw = Math.min(0.5, Math.max(0.0005, mask.feather ?? 0.01));
  const r = clamp01(reveal) * (1 + 2 * fw) - fw;
  const inside = 1 - smoothstep(r - fw, r + fw, u);
  return mask.invert ? 1 - inside : inside;
}

/** The shape's own measure of a pixel, 0..1 across the frame. Exported for the engines' tests. */
export function maskMeasure(mask: ComposeTransitionMask, qx: number, qy: number, w: number, h: number): number {
  const dx = qx - w / 2;
  const dy = qy - h / 2;
  const angle = ((mask.angleDeg ?? 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  // The frame's extent along the direction, so `u` runs 0..1 from the edge it starts at to the far one.
  const extent = Math.abs(w * cos) + Math.abs(h * sin);
  switch (mask.shape) {
    case 'linear':
      return (dx * cos + dy * sin) / extent + 0.5;
    case 'circle':
      return Math.hypot(dx, dy) / Math.hypot(w / 2, h / 2);
    case 'diamond':
      return (Math.abs(dx) + Math.abs(dy)) / (w / 2 + h / 2);
    case 'clock': {
      // Clockwise from twelve o'clock, in y-down pixels.
      const turn = Math.atan2(dx, -dy) / (2 * Math.PI);
      return turn < 0 ? turn + 1 : turn;
    }
    case 'blinds': {
      const along = ((dx * cos + dy * sin) / extent + 0.5) * Math.max(1, Math.round(mask.count ?? 1));
      return along - Math.floor(along);
    }
    case 'split':
      return Math.abs(dx * cos + dy * sin) / (extent / 2);
    default:
      return 0;
  }
}

/**
 * Where the pixel at output (`qx`, `qy`) samples a side's frame from, or null when the side's
 * moved frame does not cover it. The inverse of: scale about the centre, turn about the centre, then
 * offset. Pixelation snaps the answer to the centre of its cell.
 */
export function sideSource(side: TransitionSide, qx: number, qy: number, w: number, h: number): { sx: number; sy: number } | null {
  const cx = w / 2;
  const cy = h / 2;
  const scale = side.scale > 1e-6 ? side.scale : 1e-6;
  const px = qx - cx - side.x * w;
  const py = qy - cy - side.y * h;
  const turn = (-side.rotation * Math.PI) / 180;
  const cos = Math.cos(turn);
  const sin = Math.sin(turn);
  let sx = cx + (px * cos - py * sin) / scale;
  let sy = cy + (px * sin + py * cos) / scale;
  if (sx < 0 || sy < 0 || sx >= w || sy >= h) return null;
  if (side.pixelate > 0) {
    const cell = side.pixelate * Math.min(w, h);
    if (cell > 1) {
      sx = cx + (Math.floor((sx - cx) / cell) + 0.5) * cell;
      sy = cy + (Math.floor((sy - cy) / cell) + 0.5) * cell;
    }
  }
  return { sx, sy };
}

/**
 * One output pixel of a transition, worked out the slow, obvious way - the reference every engine's
 * drawing is tested against, and the definition of the order the operations run in:
 *
 *   1. each side's source position ([sideSource]); a side is transparent where its frame is not;
 *   2. its colour there, red and blue pulled apart by `split`, blurred by `blur`
 *      (the caller's `read` does the blur: it is handed the sigma in pixels);
 *   3. times `gain`, clamped to 1, then `tint` of the way to the side's tint colour;
 *   4. the outgoing side over black, then the incoming side over that at
 *      `alpha` x the mask.
 *
 * `read(side, x, y, sigmaPx)` returns the side's graded full frame at a pixel, edges clamped.
 */
export function transitionPixel(
  t: Pick<ComposeTransition, 'mask' | 'fromTint' | 'toTint'>,
  look: TransitionLook,
  qx: number,
  qy: number,
  w: number,
  h: number,
  read: (side: 'from' | 'to', x: number, y: number, sigmaPx: number) => RGB,
): RGB {
  const out: RGB = [0, 0, 0];
  const layer = (which: 'from' | 'to', coverage: number): void => {
    const side = look[which];
    const at = sideSource(side, qx, qy, w, h);
    if (!at || coverage <= 0) return;
    const sigma = side.blur * Math.min(w, h);
    const shift = side.split * w;
    let rgb: RGB;
    if (shift !== 0) {
      rgb = [read(which, at.sx + shift, at.sy, sigma)[0], read(which, at.sx, at.sy, sigma)[1], read(which, at.sx - shift, at.sy, sigma)[2]];
    } else {
      rgb = read(which, at.sx, at.sy, sigma);
    }
    const tint = (which === 'from' ? t.fromTint : t.toTint) ?? BLACK;
    for (let c = 0; c < 3; c++) {
      const lit = Math.min(1, rgb[c] * side.gain);
      const tinted = lit + (tint[c] - lit) * side.tint;
      out[c] = tinted * coverage + out[c] * (1 - coverage);
    }
  };
  layer('from', 1);
  layer('to', look.alpha * (t.mask ? maskAlpha(t.mask, look.reveal, qx, qy, w, h) : 1));
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* Curves and small helpers                                                                       */
/* -------------------------------------------------------------------------------------------- */

function dip(colour: RGB): Recipe {
  return {
    fromTint: colour,
    toTint: colour,
    look: p => ({
      // The switch happens at the one moment both sides are the flat colour, so it cannot be seen.
      alpha: p < 0.5 ? 0 : 1,
      from: { tint: easeInOutSine(clamp01(2 * p)) },
      to: { tint: 1 - easeInOutSine(clamp01(2 * p - 1)) },
    }),
  };
}

/** Both frames travel together, the incoming one arriving from the side the outgoing one leaves by. */
/**
 * The incoming frame slides in over the outgoing one, which drifts a third of the way the same
 * direction and darkens as it is covered - the push a phone's own navigation makes.
 *
 * Deliberately not two frames pushed edge to edge. Each engine reads a side's look off THAT side's
 * frame time, and Media3 pairs the two sides of a transition by the nearest timestamp, so on Android
 * the two frames can be up to half a frame apart in progress. Butted edge to edge, that opens a black
 * seam between them on the frames where the pair disagree - a tenth of the width in the middle of a
 * half-second slide. Here the outgoing frame always reaches under the incoming one, so however far
 * apart the pair are, the edge that moves is over picture and there is nothing to open.
 */
const DRIFT = 0.3;
const COVERED_TINT = 0.35;

function push(dx: number, dy: number, ease: (t: number) => number): Recipe {
  return {
    look: p => {
      const e = ease(p);
      return {
        from: { x: dx * DRIFT * e, y: dy * DRIFT * e, tint: COVERED_TINT * e },
        to: { x: -dx * (1 - e), y: -dy * (1 - e) },
      };
    },
  };
}

/** The same cover, much faster through the middle and smeared by motion blur while it is fast. */
function whip(dx: number): Recipe {
  return {
    look: p => {
      const e = easeInOutQuart(p);
      const k = Math.sin(Math.PI * p) ** 2;
      return {
        from: { x: dx * DRIFT * e, blur: 0.03 * k, tint: COVERED_TINT * e },
        to: { x: -dx * (1 - e), blur: 0.03 * k },
      };
    },
  };
}

function wipe(mask: ComposeTransitionMask): Recipe {
  return { mask, look: p => ({ reveal: easeInOutSine(p) }) };
}

export function smoothstep(e0: number, e1: number, x: number): number {
  if (e1 === e0) return x < e0 ? 0 : 1;
  const t = clamp01((x - e0) / (e1 - e0));
  return t * t * (3 - 2 * t);
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function easeInOutSine(t: number): number {
  return -(Math.cos(Math.PI * t) - 1) / 2;
}

function easeInOutCubic(t: number): number {
  return t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
}

function easeInOutQuart(t: number): number {
  return t < 0.5 ? 8 * t ** 4 : 1 - (-2 * t + 2) ** 4 / 2;
}

function easeInCubic(t: number): number {
  return t * t * t;
}

function easeOutCubic(t: number): number {
  return 1 - (1 - t) ** 3;
}

function sameRgb(a: RGB, b: RGB): boolean {
  return a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const inner of Object.values(value)) deepFreeze(inner);
    Object.freeze(value);
  }
  return value;
}
