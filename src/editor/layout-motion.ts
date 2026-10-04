import { MAX_RECT_MOTION_KEYS, type ComposeRectMotion } from '../video-composer/definitions';
import {
  MAX_PLACEMENT_SIZE,
  isFullFrameRect,
  isUprightRect,
  rectRotationDeg,
  totalDurationMs,
  type EditClip,
  type EditManifest,
  type EditPlacement,
  type EditRect,
  type EditVideoTrack,
} from './edit-manifest';
import { timelineSlots } from './edit-ops';
import { normaliseLayoutAnimation } from './layout-animation';
import { easeValue } from './zoom';

/**
 * Split screens that MOVE: a layer's arrangement opening as it comes on screen and closing as it
 * goes, LOWERED to keys on each clip's placement rectangle - the one place any of it is eased.
 *
 * What an engine is handed is not "slide" or "wipe". It is [ComposeRectMotion]: each clip's rectangle
 * sampled into keys, and every engine (web, Android, iOS) and the preview only interpolate straight
 * lines between them - the camera's precedent and the overlay motions' after it, for the same reason:
 * three hand-written copies of an ease would drift apart one release at a time, and the customer
 * would see a different opening in the preview from the one in their file. A style added here
 * reaches every engine without a line of native code.
 *
 * The arrangement itself is not invented here. It is the rectangles the layout presets (or the
 * customer's own fingers) already wrote onto the clips, and an animation only says how a clip gets
 * INTO its rectangle: the base from the whole frame, the layer from off the edge it is nearest.
 */

/* -------------------------------------------------------------------------------------------- */
/* Reading the wire                                                                               */
/* -------------------------------------------------------------------------------------------- */

/**
 * A clip's rectangle at output time `ms`, read exactly as [ComposeRectMotion] states - the camera's
 * reading, `cameraAt` line for line: end keys hold, each of the four is interpolated in a straight
 * line between the keys either side, and keys at the same time are a step with the later one winning.
 *
 * The ONE reading of the wire in this package: the web render, its tests and the live preview all
 * call it, so the opening a customer watched in the editor is the opening in their file. Binary
 * search, because it runs per frame for every clip that moves.
 */
export function rectMotionAt(motion: ComposeRectMotion, ms: number): EditRect {
  const at = motion.atMs;
  const n = at.length;
  if (n === 0) return { x: 0, y: 0, w: 1, h: 1 };
  if (!(ms > at[0])) {
    // At or before the first key. Equal times are a step to the LAST key sharing that time.
    let i = 0;
    while (i + 1 < n && at[i + 1] <= ms) i++;
    return keyRect(motion, i);
  }
  if (ms >= at[n - 1]) return keyRect(motion, n - 1);
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
  return {
    x: between(motion.x, lo, f),
    y: between(motion.y, lo, f),
    w: between(motion.w, lo, f),
    h: between(motion.h, lo, f),
  };
}

function keyRect(motion: ComposeRectMotion, i: number): EditRect {
  return { x: motion.x[i], y: motion.y[i], w: motion.w[i], h: motion.h[i] };
}

function between(values: readonly number[], lo: number, f: number): number {
  const a = values[lo];
  return a + (values[lo + 1] - a) * f;
}

/**
 * The narrowest a moving rectangle may be, in OUTPUT PIXELS, and still be drawn: under half a pixel
 * either way there is no picture to see, and the fit's arithmetic is dividing by next to nothing. A
 * wipe opens from exactly nothing, so its first frame is one of these.
 */
export const MIN_DRAWN_PX = 0.5;

/** Whether a rectangle on a `width` x `height` frame is too thin to draw anything at all. */
export function drawsNothing(rect: EditRect, width: number, height: number): boolean {
  return !(rect.w * width >= MIN_DRAWN_PX) || !(rect.h * height >= MIN_DRAWN_PX);
}

/* -------------------------------------------------------------------------------------------- */
/* The wire's rules                                                                               */
/* -------------------------------------------------------------------------------------------- */

const RECT_CHANNELS = ['x', 'y', 'w', 'h'] as const;
const RECT_MOTION_KEYS: readonly string[] = ['atMs', ...RECT_CHANNELS];
/** How far off the frame a moving rectangle's corner may be put, in frames. A slide needs one. */
const MAX_RECT_OFFSET = 4;

/**
 * What [normaliseRectMotion] refuses a motion with. `field` is the part that broke - `atMs`,
 * `atMs[3]`, `w[0]`, an unknown key - or empty for the motion as a whole, and `detail` is the words a
 * refusal of the whole adds after its path. A parser turns the pair into its own
 * `invalid_spec:<path>`, with the clip's path in front.
 */
export class RectMotionError extends Error {
  constructor(
    readonly field: string,
    readonly detail = '',
  ) {
    super(`rectMotion${field ? `.${field}` : ''}${detail}`);
    this.name = 'RectMotionError';
  }
}

/**
 * A clip's motion made safe to draw: the parser's rules, shared by the web engine and the tests and
 * mirrored check for check by the Kotlin and Swift parsers (see [ComposeRectMotion]). A NEW object,
 * every value clamped; `null` for an absent one. Throws [RectMotionError] for a motion no engine
 * could honour.
 */
export function normaliseRectMotion(value: unknown): ComposeRectMotion | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) throw new RectMotionError('');
  const times = value['atMs'];
  if (!Array.isArray(times)) throw new RectMotionError('atMs');
  const n = times.length;
  for (const name of RECT_CHANNELS) {
    const raw = value[name];
    if (!Array.isArray(raw) || raw.length !== n) throw new RectMotionError(name);
  }
  const unknown = Object.keys(value)
    .filter(key => !RECT_MOTION_KEYS.includes(key))
    .sort()[0];
  if (unknown !== undefined) throw new RectMotionError(unknown);
  if (n === 0 || n > MAX_RECT_MOTION_KEYS) throw new RectMotionError('', ` must have 1 to ${MAX_RECT_MOTION_KEYS} keys`);

  const atMs: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = times[i];
    if (typeof t !== 'number' || !Number.isFinite(t) || (i > 0 && t < atMs[i - 1])) throw new RectMotionError(`atMs[${i}]`);
    atMs.push(t);
  }
  const motion: ComposeRectMotion = { atMs, x: [], y: [], w: [], h: [] };
  for (const name of RECT_CHANNELS) {
    const raw = value[name] as readonly unknown[];
    const [min, max] = name === 'x' || name === 'y' ? [-MAX_RECT_OFFSET, MAX_RECT_OFFSET] : [0, MAX_PLACEMENT_SIZE];
    for (let i = 0; i < n; i++) {
      const v = raw[i];
      if (typeof v !== 'number' || !Number.isFinite(v)) throw new RectMotionError(`${name}[${i}]`);
      motion[name].push(Math.min(max, Math.max(min, v)));
    }
  }
  return motion;
}

/* -------------------------------------------------------------------------------------------- */
/* When an arrangement is open                                                                    */
/* -------------------------------------------------------------------------------------------- */

/**
 * One layer's time on screen and the two moves inside it, on the OUTPUT timeline: it opens over
 * `startMs..startMs + inMs` and closes over `endMs - outMs..endMs`.
 */
export interface LayoutOpening {
  trackId: string;
  /** Which animation: an id from [LAYOUT_ANIMATIONS]. */
  id: string;
  startMs: number;
  /** Where the layer goes off the frame: its last clip's end, or the post's, whichever is first. */
  endMs: number;
  /** How long the opening runs, squeezed in proportion with the closing when the two do not fit. */
  inMs: number;
  outMs: number;
}

/**
 * When each animated layer is on screen and how its arrangement moves inside that, in track order.
 * A layer with no animation, and one that is never on screen, has none. The timeline draws these and
 * [compileLayoutMotions] compiles them, so the two can never disagree about where a move is.
 */
export function layoutOpenings(manifest: Pick<EditManifest, 'clips' | 'videoTracks' | 'durationMs'>): LayoutOpening[] {
  const totalMs = totalDurationMs(manifest);
  const openings: LayoutOpening[] = [];
  for (const track of manifest.videoTracks) {
    const opening = openingOf(track, totalMs);
    if (opening) openings.push(opening);
  }
  return openings;
}

function openingOf(track: EditVideoTrack, totalMs: number): LayoutOpening | null {
  const animation = normaliseLayoutAnimation(track.layoutAnimation);
  if (!animation) return null;
  const startMs = Math.max(0, track.startMs);
  const lengthMs = timelineSlots({ clips: track.clips }).reduce((sum, slot) => sum + Math.max(0, slot.durationMs), 0);
  const endMs = Math.min(startMs + lengthMs, totalMs);
  const windowMs = endMs - startMs;
  if (!(windowMs > 0)) return null;
  // Squeezed in PROPORTION, the transition and zoom precedent: a layer too short for both moves
  // opens for half of its time and closes for the other half, rather than one move eating the other.
  const asked = animation.durationMs * 2;
  const k = asked > windowMs ? windowMs / asked : 1;
  return { trackId: track.id, id: animation.id, startMs, endMs, inMs: animation.durationMs * k, outMs: animation.durationMs * k };
}

/**
 * How far open an arrangement is at output time `ms`, eased: 0 closed, 1 open. Closed before the
 * layer arrives and after it has gone; the closing is the opening run backwards.
 */
export function openingAt(opening: LayoutOpening, ms: number): number {
  if (!(ms > opening.startMs) || !(ms < opening.endMs)) return 0;
  if (ms < opening.startMs + opening.inMs) return easeValue('smooth', (ms - opening.startMs) / opening.inMs);
  if (ms > opening.endMs - opening.outMs) return easeValue('smooth', (opening.endMs - ms) / opening.outMs);
  return 1;
}

/* -------------------------------------------------------------------------------------------- */
/* Where a clip is when its arrangement is closed                                                 */
/* -------------------------------------------------------------------------------------------- */

/** The whole frame, upright: where the base is drawn while no layer is on it. */
const WHOLE_FRAME: EditRect = Object.freeze({ x: 0, y: 0, w: 1, h: 1 });

type Edge = 'bottom' | 'right' | 'top' | 'left';

/** The order a tie between two edges goes in: a picture comes up from below before it comes in from a side. */
const EDGES: readonly Edge[] = ['bottom', 'right', 'top', 'left'];

/**
 * The edge of the frame a rectangle's centre is nearest, measured in output PIXELS - the frame's
 * height as 1 and its width as `aspect` - because a bottom half on a portrait post is nearer the
 * bottom than the sides only when the distances are counted in the same units.
 */
function nearestEdge(rect: EditRect, aspect: number): Edge {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const distance: Record<Edge, number> = { bottom: 1 - cy, right: (1 - cx) * aspect, top: cy, left: cx * aspect };
  let best: Edge = EDGES[0];
  for (const edge of EDGES) if (distance[edge] < distance[best] - 1e-9) best = edge;
  return best;
}

/**
 * Where a layer's clip is while its arrangement is closed, for the style it opens with.
 *
 *  - `slide`: the whole rectangle, pushed just off the frame past the edge it is nearest - past the
 *    box it TURNS through, so a tilted inset has no corner left poking in. Only `x` or `y` changes,
 *    so the picture travels in whole and the fit has nothing to redo on the way.
 *  - `wipe`: the rectangle folded flat against that same edge of itself, so it grows out of the edge
 *    as the arrangement opens. A TURNED rectangle slides instead: its own edges are not the frame's,
 *    and folding it about a corner that moves with the fold would swing it across the frame.
 */
function closedLayerRect(rest: EditPlacement, style: string, aspect: number): EditRect {
  const edge = nearestEdge(rest, aspect);
  if (style === 'wipe' && isUprightRect(rest)) {
    switch (edge) {
      case 'bottom':
        return { x: rest.x, y: rest.y + rest.h, w: rest.w, h: 0 };
      case 'top':
        return { x: rest.x, y: rest.y, w: rest.w, h: 0 };
      case 'right':
        return { x: rest.x + rest.w, y: rest.y, w: 0, h: rest.h };
      case 'left':
        return { x: rest.x, y: rest.y, w: 0, h: rest.h };
    }
  }
  // Half the box the turned rectangle sweeps, in fractions of the frame's width and height.
  const turn = (rectRotationDeg(rest) * Math.PI) / 180;
  const cos = Math.abs(Math.cos(turn));
  const sin = Math.abs(Math.sin(turn));
  const wide = rest.w * aspect;
  const halfW = (wide * cos + rest.h * sin) / 2 / aspect;
  const halfH = (wide * sin + rest.h * cos) / 2;
  const at = { x: rest.x, y: rest.y, w: rest.w, h: rest.h };
  switch (edge) {
    case 'bottom':
      return { ...at, y: 1 + halfH - rest.h / 2 };
    case 'top':
      return { ...at, y: -halfH - rest.h / 2 };
    case 'right':
      return { ...at, x: 1 + halfW - rest.w / 2 };
    case 'left':
      return { ...at, x: -halfW - rest.w / 2 };
  }
}

/** One side of an arrangement at either end of its move. */
export interface LayoutAnimationEnds {
  closed: EditRect;
  open: EditRect;
}

/**
 * The two pictures of an arrangement at either end of a style's move - the base and the layer, each
 * closed and open - for a picker that DRAWS the move rather than naming it. The rules are the ones
 * [compileLayoutMotions] moves the clips by: the base from the whole frame, unless its rectangle is
 * the whole frame already or is turned; the layer from [closedLayerRect].
 */
export function layoutAnimationEnds(
  base: EditPlacement | undefined,
  layer: EditPlacement | undefined,
  style: string,
  aspect: number,
): { base: LayoutAnimationEnds; layer: LayoutAnimationEnds } {
  const baseOpen = base && !isFullFrameRect(base) ? plainRect(base) : WHOLE_FRAME;
  const baseMoves = !!base && !isFullFrameRect(base) && isUprightRect(base);
  const layerRest: EditPlacement = layer ?? { ...WHOLE_FRAME };
  return {
    base: { closed: baseMoves ? WHOLE_FRAME : baseOpen, open: baseOpen },
    layer: { closed: closedLayerRect(layerRest, style, aspect), open: plainRect(layerRest) },
  };
}

function plainRect(rect: EditRect): EditRect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

/* -------------------------------------------------------------------------------------------- */
/* Compiling                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * How one clip is placed once arrangements open and close. A clip whose placement no opening ever
 * changes is not given one, and is drawn exactly as it is stored.
 */
export interface ClipLayoutMotion {
  /**
   * The keys, on the OUTPUT timeline, of a clip that moves while it is on screen. `null` for a base
   * clip that plays only while every arrangement is CLOSED - before the layers arrive, after they
   * have gone - and is drawn over the whole frame for all of it, whatever its own rectangle says.
   */
  motion: ComposeRectMotion | null;
}

/** By clip id, every clip an arrangement's opening or closing moves. */
export type LayoutMotions = ReadonlyMap<string, ClipLayoutMotion>;

/** The finest an opening is sampled: one key per frame at 60 fps, the camera's rate. */
const SAMPLE_MS = 1000 / 60;

/** How open an arrangement is at a run of instants: the keys a clip's rectangle is mapped from. */
interface Openness {
  atMs: number[];
  open: number[];
}

/**
 * Every clip's placement over the post, from the layers' animations, the clips' own rectangles and
 * where everything sits on the timeline. Empty - the map every post with no animated layer gets - is
 * exactly the clips as they are stored, which is what keeps [toComposeSpec] sending the spec it always
 * sent.
 *
 * A LAYER's clips move between the rectangle they rest in and that rectangle closed for the layer's
 * style (see [closedLayerRect]), over that layer's opening and closing.
 *
 * The BASE track's clips move between the WHOLE FRAME and their own rectangle, open as far as the
 * most open of the animated layers: a base split in half for one layer is let out to the whole frame
 * once every animated layer has gone, and squeezed back in as the next one arrives. A layer with no
 * animation holds no say over this - it is drawn over the base wherever it is, exactly as it is
 * today - and a base rectangle that is TURNED is left where it is, because the wire turns a moving
 * rectangle by its resting angle and the whole frame turned is a frame with black corners.
 *
 * Each clip is given only the keys of its own time on screen, its part under the next clip's
 * transition included, so a transition's outgoing side - which the wire carries as a copy of that
 * clip - moves on through the transition as the clip would have.
 */
export function compileLayoutMotions(manifest: EditManifest): LayoutMotions {
  const openings = layoutOpenings(manifest);
  const clips = new Map<string, ClipLayoutMotion>();
  if (openings.length === 0) return clips;
  const aspect = manifest.output.width / manifest.output.height;

  // The base: as open as the most open animated layer, at every key any of them has.
  const baseOpenness = mostOpen(openings);
  for (const slot of timelineSlots(manifest)) {
    const rest = slot.clip.rect;
    if (!rest || isFullFrameRect(rest) || !isUprightRect(rest)) continue;
    const from = slot.startMs;
    const to = slot.startMs + Math.max(0, slot.durationMs) + slot.tailMs;
    const placed = clipMotion(baseOpenness, from, to, WHOLE_FRAME, rest);
    if (placed) clips.set(slot.clip.id, placed);
  }

  // Each animated layer, from its own opening alone.
  for (const opening of openings) {
    const track = manifest.videoTracks.find(one => one.id === opening.trackId);
    if (!track) continue;
    const openness = mostOpen([opening]);
    for (const slot of timelineSlots({ clips: track.clips })) {
      const from = opening.startMs + slot.startMs;
      const to = Math.min(from + Math.max(0, slot.durationMs), opening.endMs);
      if (!(to > from)) continue;
      const rest: EditPlacement = slot.clip.rect ?? { ...WHOLE_FRAME };
      const placed = clipMotion(openness, from, to, closedLayerRect(rest, opening.id, aspect), rest);
      if (placed) clips.set(slot.clip.id, placed);
    }
  }
  return clips;
}

/**
 * The keys of the most open of `openings` at every instant any of them moves: each move sampled a key
 * per 60th of a second, both ends included, and the largest opening read at each of those instants.
 * Between two moves every opening holds still, so a straight line between their keys is exact there.
 */
function mostOpen(openings: readonly LayoutOpening[]): Openness {
  const times: number[] = [];
  for (const opening of openings) {
    sample(times, opening.startMs, opening.inMs);
    sample(times, opening.endMs - opening.outMs, opening.outMs);
  }
  times.sort((a, b) => a - b);
  const atMs: number[] = [];
  const open: number[] = [];
  for (const t of times) {
    if (atMs.length > 0 && atMs[atMs.length - 1] === t) continue;
    atMs.push(t);
    open.push(Math.max(...openings.map(opening => openingAt(opening, t))));
  }
  return { atMs, open };
}

/** A move `span` long from `t0`, sampled evenly at most a 60th of a second apart, both ends included. */
function sample(into: number[], t0: number, span: number): void {
  if (!(span > 0)) return;
  const n = Math.max(1, Math.ceil(span / SAMPLE_MS - 1e-9));
  for (let k = 0; k <= n; k++) into.push(round3(t0 + (span * k) / n));
}

/**
 * The keys of one clip on screen over `from..to`: how open its arrangement is at each instant of that
 * stretch, mapped onto the straight line from `closed` to `rest`. `undefined` for a clip its
 * arrangement holds OPEN the whole time - drawn as it is stored - and a null motion for one it holds
 * closed the whole time, which for the base is the whole frame.
 */
function clipMotion(openness: Openness, from: number, to: number, closed: EditRect, rest: EditRect): ClipLayoutMotion | undefined {
  const atMs: number[] = [round3(from)];
  const open: number[] = [opennessAtTime(openness, from)];
  for (let i = 0; i < openness.atMs.length; i++) {
    const t = openness.atMs[i];
    if (t > atMs[0] && t < to) {
      atMs.push(t);
      open.push(openness.open[i]);
    }
  }
  if (round3(to) > atMs[atMs.length - 1]) {
    atMs.push(round3(to));
    open.push(opennessAtTime(openness, to));
  }
  if (open.every(value => value === 1)) return undefined;
  if (open.every(value => value === 0) && isWholeFrame(closed)) return { motion: null };

  const motion: ComposeRectMotion = { atMs: [], x: [], y: [], w: [], h: [] };
  for (let i = 0; i < atMs.length; i++) {
    // A key equal to both of its neighbours says nothing a straight line between them does not.
    if (i > 0 && i < atMs.length - 1 && open[i] === open[i - 1] && open[i] === open[i + 1]) continue;
    const k = open[i];
    motion.atMs.push(atMs[i]);
    motion.x.push(round6(closed.x + (rest.x - closed.x) * k));
    motion.y.push(round6(closed.y + (rest.y - closed.y) * k));
    motion.w.push(round6(closed.w + (rest.w - closed.w) * k));
    motion.h.push(round6(closed.h + (rest.h - closed.h) * k));
  }
  return { motion };
}

/** How open the arrangement is at `ms`, read off its keys the way an engine reads a motion. */
function opennessAtTime(openness: Openness, ms: number): number {
  const { atMs, open } = openness;
  const n = atMs.length;
  if (n === 0) return 0;
  if (!(ms > atMs[0])) return open[0];
  if (ms >= atMs[n - 1]) return open[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (atMs[mid] <= ms) lo = mid;
    else hi = mid;
  }
  const span = atMs[lo + 1] - atMs[lo];
  const f = span > 0 ? (ms - atMs[lo]) / span : 1;
  return open[lo] + (open[lo + 1] - open[lo]) * f;
}

function isWholeFrame(rect: EditRect): boolean {
  return rect.x === 0 && rect.y === 0 && rect.w === 1 && rect.h === 1;
}

/**
 * The rectangle `clip` is drawn in at output time `ms`, its resting angle included: its motion's, the
 * whole frame (`null`) while its arrangement holds it closed, or as it is stored when nothing moves it.
 */
export function layoutRectAt(motions: LayoutMotions, clip: Pick<EditClip, 'id' | 'rect'>, ms: number): EditPlacement | null {
  const placed = motions.get(clip.id);
  if (!placed) return clip.rect ?? null;
  if (!placed.motion) return null;
  const rect = rectMotionAt(placed.motion, ms);
  const deg = rectRotationDeg(clip.rect);
  return deg % 360 === 0 ? rect : { ...rect, rotationDeg: deg };
}

/* -------------------------------------------------------------------------------------------- */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function round3(value: number): number {
  return Math.round(value * 1000) / 1000 + 0;
}

/** Six decimals keep a long post's JSON small and are far below a pixel. `+ 0` folds a -0 into 0. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6 + 0;
}
