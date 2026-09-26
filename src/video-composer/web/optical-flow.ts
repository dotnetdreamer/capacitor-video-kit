/**
 * How the pixels of a slowed clip MOVED between the two recorded frames a missing frame is made from -
 * the half of smooth slow motion that looks at a PAIR, done once per pair and read by every frame
 * made between them. The other half, the per-pixel step that draws a missing frame from the pair and
 * this, is `frame-interpolation.ts`.
 *
 * WHY. Phase 1 drew a missing frame as a cross-fade of its neighbours, and a cross-fade draws a moving
 * edge as two faint edges - where it was and where it is going - instead of one edge between them. On
 * anything fast that is a ghostly double exposure. Knowing where each pixel went lets the missing
 * frame take it from each neighbour part of the way along its path, which is one sharp edge in the
 * right place. That is what every editor's "optical flow" slow motion does.
 *
 * ONE ALGORITHM, TWO ENGINES. Everything here is fragment shaders over textures, because WebGL2 has no
 * compute shaders and Media3's effect chain is a chain of fragment programs. The passes are written
 * ONCE, in GLSL ES 1.00 - which a WebGL2 context and an OpenGL ES 3 context (what Media3 1.11.1 asks
 * for, SDR included) both compile - and the Android engine carries the very same text in
 * `OpticalFlow.kt`. `build/optical-flow-parity.unit.test.ts` holds the two copies to each other line by
 * line, so a constant or a pass cannot change in one engine alone. Only the orchestration - which
 * textures, in which order - is written twice (`optical-flow-gl.ts`, `FlowInterpolator.kt`), and the
 * same test holds the two to the same order of passes.
 *
 * THE METHOD: pyramidal Lucas-Kanade, both directions at once, then a forward-backward check, then
 * the occluded texels filled in from their neighbours. Chosen over Dense Inverse Search and
 * Horn-Schunck because it needs one pass per iteration and no sparse grid - on a tiled phone GPU the
 * fixed cost of a pass is most of what a pass costs - and tuned, setting by setting, on the ground-truth
 * benchmark in `scripts/slow-motion-bench` (README.md there has the numbers).
 *
 *  1. LUMA PYRAMIDS. Both frames' luma, box-filtered down to a working size whose longer side is
 *     [FlowSettings.maxSide] (180x320 for a 720x1280 or 1080x1920 portrait clip), then halved, 4x4
 *     box each time, down to [FlowSettings.maxLevels] levels. A and B share one texture per level (A in
 *     red, B in green), and so does every pass below: each pass does both directions for the price of
 *     one draw. The flow does not need the full picture - the missing frame's colour is still read at
 *     full resolution - and a fixed working size makes a pair cost the same for a 4K clip as a 720p one.
 *
 *  2. EXPOSURE. The mean and spread of each frame's luma, from the coarsest level, and the gain that
 *     brings B's spread to A's. Every comparison of A with B below compares A with B brought to A's
 *     exposure. A phone changes exposure while it records - and a flash, a light switched on, a cloud
 *     all change the brightness of the WHOLE picture - and plain Lucas-Kanade reads a change in
 *     brightness as motion. This one does not. The frames themselves are never changed: the missing
 *     frame still fades from A's brightness to B's.
 *
 *  3. FLOW, coarse to fine. At each level, a few Lucas-Kanade iterations for each direction: for every
 *     texel, the least-squares shift of a 5x5 window of the template frame that best matches the other
 *     frame where the estimate so far says the window went. The window is BILATERAL - a texel whose luma
 *     is far from the centre's counts for little - so a window that straddles the edge of a moving
 *     object is mostly the object's or mostly the background's rather than a smear of both. A small
 *     Tikhonov term keeps a window with no texture in it (a flat wall, the sky) where the coarser level
 *     put it instead of sending it wherever noise says, and every iteration also tries NO motion and
 *     starts again from zero where that explains the window better - which is what keeps a still
 *     background still when the coarse levels have only the moving subject's edges to see. Each level's
 *     result is median-filtered 3x3, which removes the isolated wrong vectors a window with too little
 *     in it produces, and seeds the next finer level through bilinear filtering.
 *
 *     The flow is kept in TEXTURE COORDINATES - a fraction of the frame - so it means the same thing at
 *     every level and at full resolution, and the missing frame can add it to the coordinate it samples
 *     at without knowing any sizes.
 *
 *  4. CONSISTENCY. Where A's texel goes by the forward flow, the backward flow should bring it back. A
 *     texel whose round trip misses (Sundaram et al. 2010's test, relative to the length of the motion)
 *     is either OCCLUDED in the other frame - the background a moving object covers - or a place where
 *     the estimate is wrong, and a texel whose destination is off the frame is simply not in the other
 *     frame. Either way the other frame cannot be asked about it, and the missing frame draws it from one
 *     side only. The same pass measures how well the flow explains the pair: A's luma against B's where
 *     the flow says A's texel went.
 *
 *  5. FILL. A texel hidden in the other frame has no match there, so its flow is noise; it is given the
 *     flow of the neighbours around it that passed the round trip and look like it. The background a
 *     moving subject uncovers then moves as the background does, and is drawn as background rather
 *     than as the ghost a lost point falls back to.
 *
 *  6. TRUST, for the whole pair. When most of the frame fails the round trip, or the flow leaves A and B
 *     disagreeing everywhere, the flow is not describing this pair at all: a cut inside a clip, a flash
 *     that changed more than brightness, a whip pan faster than the pyramid can follow. The pair is then
 *     drawn as the blend, which is a ghost - and a ghost is far better than the tearing a wrong flow
 *     draws. The fall between the two is a smoothstep, not a switch, so a pair near the line does not
 *     flicker between the two looks from one pair to the next.
 *
 * What each output frame then does with this - finding each frame's point by following its flow,
 * weighing the two by what each can see, and falling back to the blend per pixel - is
 * `frame-interpolation.ts`.
 *
 * WHERE THE COST IS: every pass above runs once per PAIR, at 180x320 or smaller - 40 small draws - and
 * a pair is drawn several times over (three or four output frames at 0.3x); the per-output-frame cost
 * is a dozen texture reads per pixel, in the step that was a mix before. Measured on the Samsung A13
 * (Mali-G52) in Media3: about 70 ms a pair, most of it the passes' fixed latency, and 13-19 ms a
 * synthesised 720x1280 frame. That put Velocity's export at +10% on phase 1 and The Drop's at +14%; a
 * post slowed from end to end pays it on every frame (12 s of 0.5x: 4.5 s to 17.4 s).
 *
 * WHAT THE TEXTURES ARE. Half-float RGBA everywhere (RGBA16F): flow needs signed values and sub-texel
 * precision, which 8 bits cannot hold, and half floats are renderable and linearly filterable in
 * WebGL2 with `EXT_color_buffer_float` and in OpenGL ES 3 with `EXT_color_buffer_half_float` - both of
 * which every device in question has. A context without them draws the blend, as phase 1 did.
 */

/** The knobs of [flowPasses]. Every engine uses [FLOW]; the benchmark tries others. */
export interface FlowSettings {
  /** The working size's longer side, in texels. A frame smaller than this is worked at its own size. */
  maxSide: number;
  /** The most pyramid levels, the working size included. */
  maxLevels: number;
  /** No level is made whose shorter side would fall below this. */
  minSide: number;
  /** Lucas-Kanade iterations per level, FINEST FIRST; a level past the end takes the last number. */
  iterations: readonly number[];
  /** The most bilinear reads per axis the luma pass takes over one working texel's footprint: see [lumaTaps]. */
  maxLumaTaps: number;
  /** The window's reach either side of its centre, in texels of the level: 2 is 5x5. */
  radius: number;
  /** The step between the window's taps: 1 reads every texel of it, 2 every other one each way. */
  windowStep: number;
  /** The window's spatial fall-off, in texels. */
  spatialSigma: number;
  /** The window's fall-off in luma (0..1): how different a texel may look before it stops counting. */
  rangeSigma: number;
  /** Tikhonov regularisation of each 2x2 solve, in the units of the summed squared gradients. */
  lambda: number;
  /** The most one iteration may move an estimate, in texels of its level. */
  maxStep: number;
  /** Whether each level's flow is median-filtered before it seeds the next. */
  median: boolean;
  /** The round-trip test: a miss counts when |F01 + F10'|^2 > alpha (|F01|^2 + |F10'|^2) + beta, in texels. */
  consistencyAlpha: number;
  consistencyBeta: number;
  /** A texel is fully visible below this round-trip ratio and fully hidden above the next. */
  occlusionLow: number;
  occlusionHigh: number;
  /** The share of the frame failing the round trip above which a pair starts, and ends, being distrusted. */
  badLow: number;
  badHigh: number;
  /** The mean luma disagreement after the flow above which a pair starts, and ends, being distrusted. */
  residualLow: number;
  residualHigh: number;
  /** The occlusion fill's reach either side of a texel, and the step between its taps, in working texels. */
  fillRadius: number;
  fillStep: number;
  /** Per pixel: how well at least one of the two points must have been found before the flow is used there. */
  supportLow: number;
  supportHigh: number;
  /** How many times each point is re-sought along its flow after the first guess: see [trackPoints]. */
  trackIterations: number;
  /** How far from the pixel, in working texels, a found point's own flow may carry it and still count as found. */
  missLow: number;
  missHigh: number;
  /** How much a point seen in only its own frame counts against one seen in both: see [synthesisWeights]. */
  hiddenWeight: number;
  /** Below this motion, in working texels, a pixel is the cross-fade; above the next, the flow's. */
  motionLow: number;
  motionHigh: number;
}

/**
 * The settings every engine renders with, chosen on the benchmark in `scripts/slow-motion-bench` (see
 * the table in its README). Changing one changes the pixels of every slowed clip in both engines, and
 * `OpticalFlow.kt` has to change with it - the parity test says where.
 */
export const FLOW: FlowSettings = {
  maxSide: 320,
  maxLevels: 5,
  minSide: 8,
  iterations: [3, 3, 4, 5, 5],
  maxLumaTaps: 6,
  radius: 2,
  windowStep: 1,
  spatialSigma: 1.5,
  rangeSigma: 0.2,
  lambda: 0.004,
  maxStep: 1.0,
  median: true,
  consistencyAlpha: 0.01,
  consistencyBeta: 0.5,
  occlusionLow: 1.0,
  occlusionHigh: 4.0,
  badLow: 0.25,
  badHigh: 0.5,
  residualLow: 0.06,
  residualHigh: 0.12,
  fillRadius: 6,
  fillStep: 2,
  supportLow: 0.1,
  supportHigh: 0.5,
  trackIterations: 1,
  missLow: 0.5,
  missHigh: 1.0,
  hiddenWeight: 0.2,
  motionLow: 0.1,
  motionHigh: 0.25,
};

/** A texture's size in texels. */
export interface FlowSize {
  width: number;
  height: number;
}

/**
 * The pyramid for a `width` x `height` frame, the working size first: the frame scaled so its longer
 * side is at most [FlowSettings.maxSide], then each level half the last (rounded up, so an odd size
 * loses nothing off its edge), for as long as the shorter side stays at or above
 * [FlowSettings.minSide] and there are fewer than [FlowSettings.maxLevels]. Always at least one level;
 * empty for a frame with no pixels.
 */
export function flowPyramid(width: number, height: number, settings: FlowSettings = FLOW): FlowSize[] {
  if (!(width >= 1) || !(height >= 1)) return [];
  const scale = Math.min(1, settings.maxSide / Math.max(width, height));
  let level: FlowSize = { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
  const levels = [level];
  while (levels.length < settings.maxLevels) {
    const next = { width: Math.ceil(level.width / 2), height: Math.ceil(level.height / 2) };
    if (Math.min(next.width, next.height) < settings.minSide) break;
    levels.push(next);
    level = next;
  }
  return levels;
}

/**
 * How many bilinear reads per axis the luma pass takes over each working texel's footprint in a
 * `width` x `height` frame worked at `working`: enough 2x2 reads to tile the footprint, which is an
 * exact box filter wherever the frame is an even multiple of the working size - 2 at 4:1 (720x1280),
 * 3 at 6:1 (1080x1920), 6 at 12:1 (2160x3840) - and one plain read where the frame IS the working
 * size. A fixed count cannot be right for every frame: two reads a side are the exact box at 4:1 and
 * four single texels out of thirty-six at 6:1, which lets fine texture alias into every level of the
 * pyramid. At most [FlowSettings.maxLumaTaps].
 */
export function lumaTaps(width: number, height: number, working: FlowSize, settings: FlowSettings = FLOW): number {
  const ratio = Math.max(width / working.width, height / working.height);
  return Math.min(settings.maxLumaTaps, Math.max(1, Math.ceil(ratio / 2 - 1e-6)));
}

/** Lucas-Kanade iterations at `level` (0 is the working size). */
export function iterationsAt(level: number, settings: FlowSettings = FLOW): number {
  const list = settings.iterations;
  return list[Math.min(level, list.length - 1)] ?? 1;
}

/* ---------------------------------------------------------------------------------------------- */
/* The maths the shaders do, as plain functions: what the unit tests pin, in both languages.      */

export type Vec2 = readonly [number, number];

/** GLSL's smoothstep, including its behaviour outside the edges. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/**
 * Super SloMo's linear-motion approximation (Jiang et al. 2018, eq. 4): where the missing frame at `t`
 * (0 is A, 1 is B) reads each neighbour, for the pixel whose forward flow is `f01` (A to B) and whose
 * backward flow is `f10` (B to A), both read AT THE PIXEL:
 *
 *   F_t0 = -(1 - t) t F01 + t^2 F10
 *   F_t1 = (1 - t)^2 F01 - t (1 - t) F10
 *
 * so the pixel `x` is A's at `x + F_t0` and B's at `x + F_t1`. For a point moving steadily by `d`
 * (F01 = d, F10 = -d) that is `x - t d` and `x + (1 - t) d`: a fraction `t` back along its path into A
 * and the rest of the way forward into B.
 *
 * NOT what the engines draw with - see [trackPoints], which answers the same question by following the
 * flow instead of reading it at the pixel, and which the benchmark found better on every moving scene.
 * Kept because it is the answer the two must agree on wherever the motion is uniform, which is what
 * the tests hold [trackPoints] to.
 */
export function intermediateFlows(f01: Vec2, f10: Vec2, t: number): { toA: Vec2; toB: Vec2 } {
  const u = 1 - t;
  return {
    toA: [-u * t * f01[0] + t * t * f10[0], -u * t * f01[1] + t * t * f10[1]],
    toB: [u * u * f01[0] - t * u * f10[0], u * u * f01[1] - t * u * f10[1]],
  };
}

/** The flow a texture holds at a point: forward (A to B) in 0-1, backward (B to A) in 2-3, texture coordinates. */
export type FlowField = (point: Vec2) => readonly [number, number, number, number];

/**
 * The two recorded points the missing frame's pixel `uv` at `t` is drawn from, found by FOLLOWING the
 * flow: the point `pa` of A whose own forward flow carries it to `uv` by `t` - `pa + t F01(pa) = uv` -
 * and the point `pb` of B whose backward flow carries it to `uv` by `1 - t` - `pb + (1 - t) F10(pb) =
 * uv`. Each is found by fixed-point iteration from the flow at the pixel: `pa <- uv - t F01(pa)`.
 *
 * WHY NOT [intermediateFlows]. That reads both flows at the pixel itself, which is right wherever the
 * flow is smooth and wrong exactly where it matters: at the edge of a moving object the pixel's
 * forward flow is the object's and its backward flow the background's, and the linear approximation
 * mixes the two into a point that belongs to neither - a halo round everything that moves. Following
 * each frame's own flow lands on a point of ONE surface in each frame; where the two frames land on
 * different surfaces, [synthesisWeights] decides between them.
 *
 * `missA`/`missB` are how far, in working texels (`size`), each found point's own flow leaves it from
 * `uv`: 0 for a point that is really there, and large where the iteration never settled - at the
 * trailing edge of a moving object, where no point of that frame lands on `uv` at all. `flowA`/`flowB`
 * are the found points' own motion, in working texels, which says whether anything moves there.
 */
export function trackPoints(
  flowAt: FlowField,
  uv: Vec2,
  t: number,
  size: FlowSize,
  settings: FlowSettings = FLOW,
): { pa: Vec2; pb: Vec2; missA: number; missB: number; flowA: Vec2; flowB: Vec2 } {
  const u = 1 - t;
  const here = flowAt(uv);
  let pa: Vec2 = [uv[0] - t * here[0], uv[1] - t * here[1]];
  let pb: Vec2 = [uv[0] - u * here[2], uv[1] - u * here[3]];
  for (let i = 0; i < settings.trackIterations; i++) {
    const fa = flowAt(pa);
    const fb = flowAt(pb);
    pa = [uv[0] - t * fa[0], uv[1] - t * fa[1]];
    pb = [uv[0] - u * fb[2], uv[1] - u * fb[3]];
  }
  const fa = flowAt(pa);
  const fb = flowAt(pb);
  const flowA: Vec2 = [fa[0] * size.width, fa[1] * size.height];
  const flowB: Vec2 = [fb[2] * size.width, fb[3] * size.height];
  const missA = Math.hypot((pa[0] - uv[0]) * size.width + t * flowA[0], (pa[1] - uv[1]) * size.height + t * flowA[1]);
  const missB = Math.hypot((pb[0] - uv[0]) * size.width + u * flowB[0], (pb[1] - uv[1]) * size.height + u * flowB[1]);
  return { pa, pb, missA, missB, flowA, flowB };
}

/**
 * The round-trip ratio of a texel whose flow is `forward` (in texels) and at whose destination the
 * opposite flow is `back`: the miss squared over what the test allows. At or below 1 the round trip
 * closes; above it the texel is taken to be hidden in the other frame. A destination off the frame is
 * [OFF_FRAME].
 */
export function consistencyRatio(forward: Vec2, back: Vec2, settings: FlowSettings = FLOW): number {
  const mx = forward[0] + back[0];
  const my = forward[1] + back[1];
  const lengths = forward[0] * forward[0] + forward[1] * forward[1] + back[0] * back[0] + back[1] * back[1];
  return (mx * mx + my * my) / (settings.consistencyAlpha * lengths + settings.consistencyBeta);
}

/** The ratio a texel whose flow takes it off the frame is given: hidden, whatever the test's thresholds. */
export const OFF_FRAME = 100;

/** How visible a texel is in the other frame, 1 to 0, from its round-trip ratio. */
export function visibility(ratio: number, settings: FlowSettings = FLOW): number {
  return 1 - smoothstep(settings.occlusionLow, settings.occlusionHigh, ratio);
}

/**
 * How far the flow is trusted for a whole pair, 1 to 0: `bad` is the share of the frame that failed
 * the round trip, `residual` the mean luma disagreement left after the flow.
 */
export function pairTrust(bad: number, residual: number, settings: FlowSettings = FLOW): number {
  return (1 - smoothstep(settings.badLow, settings.badHigh, bad)) * (1 - smoothstep(settings.residualLow, settings.residualHigh, residual));
}

/**
 * The exposure pass's answer: the gain that brings B's luma spread to A's, clamped to a factor of two
 * either way - beyond that the two frames are not one picture at two exposures, and the trust test
 * will say so. A flat frame has no spread, and a flat B is left at the lower clamp.
 */
export function exposureGain(stdA: number, stdB: number): number {
  return Math.min(2, Math.max(0.5, stdA / Math.max(stdB, 0.002)));
}

/** Whether a point is on the frame: 1 inside the texture coordinates' 0..1 square, edges included, else 0. */
export function insideFrame(point: Vec2): number {
  return point[0] >= 0 && point[1] >= 0 && point[0] <= 1 && point[1] <= 1 ? 1 : 0;
}

/**
 * How the missing frame weighs the two points [trackPoints] found, and how far it trusts the result
 * over the cross-fade.
 *
 * A point counts as FOUND (`landedA`, `landedB`, 1 to 0) when its own flow really does carry it to the
 * pixel (`miss` under [FlowSettings.missLow]) and it is on the frame. Each then weighs what it did in
 * the cross-fade, `(1 - t)` for A and `t` for B, times how sure the round trip is that the point is
 * seen in BOTH frames (`seenA`: A's point in B; `seenB`: B's point in A) plus a little
 * ([FlowSettings.hiddenWeight]). That is Super SloMo's visibility weighting (eq. 5) with the
 * visibilities taken from the round trip rather than learned, and it settles the one real ambiguity:
 * at the edge of a moving object A may land on the object and B on the background behind it, and the
 * surface seen in both frames is the one IN FRONT - the background is the one the object hides in one
 * of them. A point seen in only its own frame still counts when it is all there is - background the
 * object has just uncovered, which only B has.
 *
 *   wA = (1 - t) landedA (hidden + seenA),   wB = t landedB (hidden + seenB)
 *
 * `confidence` is how far the flow's picture is used over the cross-fade here: the pair's trust, times
 * whether ANYTHING moves (`motion`, the larger of the two points' own motion in working texels - where
 * nothing moves the cross-fade is already the right answer, and it has the noise of two frames
 * averaged rather than the flow's guess at a motion of nothing), times whether at least one point was
 * found at all.
 */
export function synthesisWeights(
  t: number,
  landedA: number,
  landedB: number,
  seenA: number,
  seenB: number,
  motion: number,
  trust: number,
  settings: FlowSettings = FLOW,
): { wA: number; wB: number; confidence: number } {
  return {
    wA: (1 - t) * landedA * (settings.hiddenWeight + seenA),
    wB: t * landedB * (settings.hiddenWeight + seenB),
    confidence: trust * smoothstep(settings.motionLow, settings.motionHigh, motion) * smoothstep(settings.supportLow, settings.supportHigh, Math.max(landedA, landedB)),
  };
}

/** How found a point is, 1 to 0, from how far its own flow leaves it from the pixel (see [trackPoints]). */
export function landed(miss: number, inside: number, settings: FlowSettings = FLOW): number {
  return (1 - smoothstep(settings.missLow, settings.missHigh, miss)) * inside;
}

/* ---------------------------------------------------------------------------------------------- */
/* The passes. GLSL ES 1.00, shared with OpticalFlow.kt TEXT FOR TEXT - see the parity test.      */

/** The passes, by the name both engines call them. */
export type FlowPassName = 'luma' | 'down' | 'exposure' | 'gradient' | 'lucasKanade' | 'median' | 'consistency' | 'fill' | 'trust' | 'visibility';

/**
 * A number as a GLSL float literal: `1` is `1.0`, which GLSL ES 1.00 insists on - it converts nothing
 * implicitly, so `x * 1` with a float `x` does not compile.
 */
export function glslFloat(value: number): string {
  if (!Number.isFinite(value)) throw new Error(`not a GLSL float: ${value}`);
  return Number.isInteger(value) ? value.toFixed(1) : String(value);
}

const HEADER = `#version 100
precision highp float;`;

/**
 * Every pass's fragment shader for `settings`. The vertex side is each engine's own - a quad over the
 * whole target - and none of these reads a varying: each one finds its texel from `gl_FragCoord` and
 * the target's size, `u_size`, so the orientation a texture is stored in is whatever the frames came in,
 * and every texture of the pair is in the same one.
 */
export function flowPasses(settings: FlowSettings = FLOW): Record<FlowPassName, string> {
  const f = glslFloat;
  const rangeK = f(1 / (2 * settings.rangeSigma * settings.rangeSigma));
  return {
    /*
     * The working size's luma for both frames, box-filtered: `u_taps` x `u_taps` bilinear reads spread
     * evenly over the texel's footprint in the frame (see lumaTaps). Each read lands between four of the
     * frame's texels and averages them, so where the frame is an even multiple of the working size the
     * reads tile the footprint exactly and the whole is a box.
     *
     * The luma is of the GRADED picture - `u_matrix` and `u_offset` are the post's colour matrix,
     * clamped as the layer shader clamps it - because that is the picture the Android engine's flow
     * sees (its frames reach the flow already graded; it passes the identity here) and the thresholds
     * below are in luma: a contrast of 1.5 makes every disagreement half as large again, and the two
     * engines would trust different pairs. The frames themselves are still mixed ungraded and graded
     * after, as a recorded frame is.
     */
    luma: `${HEADER}
uniform sampler2D u_frameA;
uniform sampler2D u_frameB;
uniform vec2 u_size;
uniform float u_taps;
uniform mat3 u_matrix;
uniform vec3 u_offset;
float luma(vec3 rgb) {
  return dot(clamp(u_matrix * rgb + u_offset, 0.0, 1.0), vec3(0.299, 0.587, 0.114));
}
void main() {
  vec2 texel = 1.0 / u_size;
  vec2 uv = gl_FragCoord.xy * texel;
  vec2 sum = vec2(0.0);
  for (int j = 0; j < ${settings.maxLumaTaps}; j++) {
    if (float(j) >= u_taps) break;
    for (int i = 0; i < ${settings.maxLumaTaps}; i++) {
      if (float(i) >= u_taps) break;
      vec2 p = uv + ((vec2(float(i), float(j)) + 0.5) / u_taps - 0.5) * texel;
      sum += vec2(luma(texture2D(u_frameA, p).rgb), luma(texture2D(u_frameB, p).rgb));
    }
  }
  gl_FragColor = vec4(sum / (u_taps * u_taps), 0.0, 1.0);
}`,

    /*
     * One level down: four bilinear reads a source texel either side of the target texel's centre,
     * which is the 4x4 box around it - wide enough that the coarser level does not alias what the
     * finer one could see.
     */
    down: `${HEADER}
uniform sampler2D u_source;
uniform vec2 u_size;
uniform vec2 u_sourceTexel;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec2 d = u_sourceTexel;
  vec4 sum = texture2D(u_source, uv + vec2(-d.x, -d.y)) + texture2D(u_source, uv + vec2(d.x, -d.y))
      + texture2D(u_source, uv + vec2(-d.x, d.y)) + texture2D(u_source, uv + vec2(d.x, d.y));
  gl_FragColor = sum * 0.25;
}`,

    /*
     * The two frames' exposure, into one texel: A's mean, B's mean and the gain that brings B's spread
     * to A's (exposureGain). Read from the coarsest level on a 32x32 grid, which is every texel of it
     * or close to.
     */
    exposure: `${HEADER}
uniform sampler2D u_pyramid;
void main() {
  vec2 sum = vec2(0.0);
  vec2 squares = vec2(0.0);
  for (int j = 0; j < 32; j++) {
    for (int i = 0; i < 32; i++) {
      vec2 y = texture2D(u_pyramid, (vec2(float(i), float(j)) + 0.5) / 32.0).xy;
      sum += y;
      squares += y * y;
    }
  }
  vec2 mean = sum / 1024.0;
  vec2 spread = sqrt(max(squares / 1024.0 - mean * mean, 0.0));
  float gain = clamp(spread.x / max(spread.y, 0.002), 0.5, 2.0);
  gl_FragColor = vec4(mean, gain, 1.0);
}`,

    /* Both frames' luma gradients at one level, central differences, in luma per texel. */
    gradient: `${HEADER}
uniform sampler2D u_pyramid;
uniform vec2 u_size;
void main() {
  vec2 texel = 1.0 / u_size;
  vec2 uv = gl_FragCoord.xy * texel;
  vec2 left = texture2D(u_pyramid, uv - vec2(texel.x, 0.0)).xy;
  vec2 right = texture2D(u_pyramid, uv + vec2(texel.x, 0.0)).xy;
  vec2 below = texture2D(u_pyramid, uv - vec2(0.0, texel.y)).xy;
  vec2 above = texture2D(u_pyramid, uv + vec2(0.0, texel.y)).xy;
  vec2 dx = (right - left) * 0.5;
  vec2 dy = (above - below) * 0.5;
  gl_FragColor = vec4(dx.x, dy.x, dx.y, dy.y);
}`,

    /*
     * One Lucas-Kanade iteration, both directions: the flow so far (A to B in xy, B to A in zw, in
     * texture coordinates) moved by the least-squares step of this texel's window, inverse
     * compositional - the template's own gradients, so the system is the template's and only the
     * mismatch is read from the other frame.
     *
     * `u_fresh` is 1 for the first iteration of the coarsest level, which has no estimate to start
     * from; every other first iteration reads the coarser level's flow through the same bilinear
     * filter that makes it this level's starting point.
     *
     * STILL, OR MOVED? Every iteration also asks whether NO motion explains the window better than the
     * estimate does, and starts again from zero where it does. It costs no extra reads - the window
     * already reads both frames at every tap, which is the static hypothesis's mismatch - and it is what
     * keeps a still background still. At the coarsest levels a finely textured background (gravel,
     * grass, a crowd) averages away to nothing, the only edges left are the moving subject's, and the
     * background next to it picks up a motion of its own that the finer levels, which can each correct a
     * texel or two, never undo; the round trip then fails across the frame and the whole pair falls
     * back to the cross-fade. A subject moving over a still background is most of what gets slowed down.
     */
    lucasKanade: `${HEADER}
uniform sampler2D u_pyramid;
uniform sampler2D u_gradient;
uniform sampler2D u_flow;
uniform sampler2D u_exposure;
uniform vec2 u_size;
uniform float u_fresh;
vec2 solve(vec3 h, vec2 b) {
  float a = h.x + ${f(settings.lambda)};
  float d = h.z + ${f(settings.lambda)};
  float det = a * d - h.y * h.y;
  vec2 move = vec2(d * b.x - h.y * b.y, a * b.y - h.y * b.x) / max(det, 1e-12);
  float length2 = dot(move, move);
  return length2 > ${f(settings.maxStep * settings.maxStep)} ? move * (${f(settings.maxStep)} / sqrt(length2)) : move;
}
void main() {
  vec2 texel = 1.0 / u_size;
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 exposure = texture2D(u_exposure, vec2(0.5));
  vec4 flow = u_fresh > 0.5 ? vec4(0.0) : texture2D(u_flow, uv);
  vec2 centre = texture2D(u_pyramid, uv).xy;
  float centreB = (centre.y - exposure.y) * exposure.z + exposure.x;
  vec3 hAB = vec3(0.0);
  vec2 bAB = vec2(0.0);
  vec2 stillAB = vec2(0.0);
  vec3 hBA = vec3(0.0);
  vec2 bBA = vec2(0.0);
  vec2 stillBA = vec2(0.0);
  // Each direction's windowed squared mismatch: under the estimate (x) and under no motion (y).
  vec2 costAB = vec2(0.0);
  vec2 costBA = vec2(0.0);
  for (int j = -${settings.radius}; j <= ${settings.radius}; j += ${settings.windowStep}) {
    for (int i = -${settings.radius}; i <= ${settings.radius}; i += ${settings.windowStep}) {
      vec2 offset = vec2(float(i), float(j));
      vec2 p = uv + offset * texel;
      float spatial = exp(-dot(offset, offset) * ${f(1 / (2 * settings.spatialSigma * settings.spatialSigma))});
      vec2 y = texture2D(u_pyramid, p).xy;
      vec4 g = texture2D(u_gradient, p);
      float yB = (y.y - exposure.y) * exposure.z + exposure.x;
      vec2 gB = g.zw * exposure.z;
      float dA = y.x - centre.x;
      float wAB = spatial * exp(-dA * dA * ${rangeK});
      float eAB = (texture2D(u_pyramid, p + flow.xy).y - exposure.y) * exposure.z + exposure.x - y.x;
      float e0AB = yB - y.x;
      hAB += wAB * vec3(g.x * g.x, g.x * g.y, g.y * g.y);
      bAB += (wAB * eAB) * g.xy;
      stillAB += (wAB * e0AB) * g.xy;
      costAB += wAB * vec2(eAB * eAB, e0AB * e0AB);
      float dB = yB - centreB;
      float wBA = spatial * exp(-dB * dB * ${rangeK});
      float eBA = texture2D(u_pyramid, p + flow.zw).x - yB;
      hBA += wBA * vec3(gB.x * gB.x, gB.x * gB.y, gB.y * gB.y);
      bBA += (wBA * eBA) * gB;
      stillBA -= (wBA * e0AB) * gB;
      costBA += wBA * vec2(eBA * eBA, e0AB * e0AB);
    }
  }
  // Where no motion is the better explanation, the step is taken from zero instead.
  bool resetAB = costAB.y < costAB.x;
  bool resetBA = costBA.y < costBA.x;
  vec2 fromAB = resetAB ? vec2(0.0) : flow.xy;
  vec2 fromBA = resetBA ? vec2(0.0) : flow.zw;
  gl_FragColor = vec4(fromAB - solve(hAB, resetAB ? stillAB : bAB) * texel, fromBA - solve(hBA, resetBA ? stillBA : bBA) * texel);
}`,

    /* A 3x3 median of the flow, each component on its own: the 19-exchange network for nine values. */
    median: `${HEADER}
uniform sampler2D u_flow;
uniform vec2 u_size;
#define SORT(a, b) { vec4 lo = min(a, b); b = max(a, b); a = lo; }
void main() {
  vec2 texel = 1.0 / u_size;
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 p0 = texture2D(u_flow, uv + vec2(-texel.x, -texel.y));
  vec4 p1 = texture2D(u_flow, uv + vec2(0.0, -texel.y));
  vec4 p2 = texture2D(u_flow, uv + vec2(texel.x, -texel.y));
  vec4 p3 = texture2D(u_flow, uv + vec2(-texel.x, 0.0));
  vec4 p4 = texture2D(u_flow, uv);
  vec4 p5 = texture2D(u_flow, uv + vec2(texel.x, 0.0));
  vec4 p6 = texture2D(u_flow, uv + vec2(-texel.x, texel.y));
  vec4 p7 = texture2D(u_flow, uv + vec2(0.0, texel.y));
  vec4 p8 = texture2D(u_flow, uv + vec2(texel.x, texel.y));
  SORT(p1, p2) SORT(p4, p5) SORT(p7, p8) SORT(p0, p1) SORT(p3, p4) SORT(p6, p7)
  SORT(p1, p2) SORT(p4, p5) SORT(p7, p8) SORT(p0, p3) SORT(p5, p8) SORT(p4, p7)
  SORT(p3, p6) SORT(p1, p4) SORT(p2, p5) SORT(p4, p7) SORT(p4, p2) SORT(p6, p4)
  SORT(p4, p2)
  gl_FragColor = p4;
}`,

    /*
     * Per texel of the working size: the round-trip ratio of A's texel (x) and of B's (y) -
     * consistencyRatio, OFF_FRAME for a texel the flow takes off the frame - and the luma disagreement
     * the flow leaves for each (z, w), B brought to A's exposure.
     */
    consistency: `${HEADER}
uniform sampler2D u_flow;
uniform sampler2D u_pyramid;
uniform sampler2D u_exposure;
uniform vec2 u_size;
float inside(vec2 p) {
  return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
}
float ratio(vec2 forward, vec2 back) {
  vec2 miss = forward + back;
  return dot(miss, miss) / (${f(settings.consistencyAlpha)} * (dot(forward, forward) + dot(back, back)) + ${f(settings.consistencyBeta)});
}
void main() {
  vec2 texel = 1.0 / u_size;
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 exposure = texture2D(u_exposure, vec2(0.5));
  vec4 flow = texture2D(u_flow, uv);
  vec2 inB = uv + flow.xy;
  vec2 inA = uv + flow.zw;
  float ratioA = inside(inB) > 0.5 ? ratio(flow.xy * u_size, texture2D(u_flow, inB).zw * u_size) : ${f(OFF_FRAME)};
  float ratioB = inside(inA) > 0.5 ? ratio(flow.zw * u_size, texture2D(u_flow, inA).xy * u_size) : ${f(OFF_FRAME)};
  vec2 here = texture2D(u_pyramid, uv).xy;
  float residualA = abs((texture2D(u_pyramid, inB).y - exposure.y) * exposure.z + exposure.x - here.x);
  float residualB = abs(texture2D(u_pyramid, inA).x - ((here.y - exposure.y) * exposure.z + exposure.x));
  gl_FragColor = vec4(ratioA, ratioB, residualA, residualB);
}`,

    /*
     * The flow where the round trip failed, filled in from the texels around it where it held - each
     * direction on its own, weighted by how visible each neighbour is, by distance, and by how alike
     * its luma is (A's for the forward flow, B's, at A's exposure, for the backward). A texel hidden in
     * the other frame has no match there, so what the passes above made of it is noise: the background
     * a moving subject has just uncovered, which only B has, gets a backward flow pointing anywhere, and
     * the missing frame then finds nothing to draw there and falls back to the ghost. Its neighbours of
     * the same surface do know how it moves, and that is the answer it is given. A texel the round trip
     * trusts keeps its own flow, and between the two the fill fades in as the trust fades out.
     */
    fill: `${HEADER}
uniform sampler2D u_flow;
uniform sampler2D u_consistency;
uniform sampler2D u_pyramid;
uniform sampler2D u_exposure;
uniform vec2 u_size;
void main() {
  vec2 texel = 1.0 / u_size;
  vec2 uv = gl_FragCoord.xy * texel;
  vec4 exposure = texture2D(u_exposure, vec2(0.5));
  vec4 flow = texture2D(u_flow, uv);
  vec2 seen = 1.0 - smoothstep(${f(settings.occlusionLow)}, ${f(settings.occlusionHigh)}, texture2D(u_consistency, uv).xy);
  vec2 centre = texture2D(u_pyramid, uv).xy;
  float centreB = (centre.y - exposure.y) * exposure.z + exposure.x;
  vec2 sumAB = vec2(0.0);
  vec2 sumBA = vec2(0.0);
  vec2 total = vec2(1e-6);
  for (int j = -${settings.fillRadius}; j <= ${settings.fillRadius}; j += ${settings.fillStep}) {
    for (int i = -${settings.fillRadius}; i <= ${settings.fillRadius}; i += ${settings.fillStep}) {
      vec2 offset = vec2(float(i), float(j));
      vec2 p = uv + offset * texel;
      vec4 f = texture2D(u_flow, p);
      vec2 v = 1.0 - smoothstep(${f(settings.occlusionLow)}, ${f(settings.occlusionHigh)}, texture2D(u_consistency, p).xy);
      vec2 y = texture2D(u_pyramid, p).xy;
      float dA = y.x - centre.x;
      float dB = (y.y - exposure.y) * exposure.z + exposure.x - centreB;
      float spatial = exp(-dot(offset, offset) * ${f(1 / (2 * settings.fillRadius * settings.fillRadius))});
      vec2 w = v * spatial * exp(-vec2(dA * dA, dB * dB) * ${rangeK});
      sumAB += w.x * f.xy;
      sumBA += w.y * f.zw;
      total += w;
    }
  }
  gl_FragColor = vec4(mix(sumAB / total.x, flow.xy, seen.x), mix(sumBA / total.y, flow.zw, seen.y));
}`,

    /*
     * The pair's trust, into one texel (pairTrust): the share of a 32x32 grid over the working size
     * that failed the round trip, each direction counted half, and the mean luma disagreement left -
     * the smaller of the two directions', so an occlusion, which one direction always fails, does not
     * count against a pair that is otherwise well explained. The share and the disagreement go in y
     * and z for the tests to read.
     */
    trust: `${HEADER}
uniform sampler2D u_consistency;
void main() {
  float bad = 0.0;
  float residual = 0.0;
  for (int j = 0; j < 32; j++) {
    for (int i = 0; i < 32; i++) {
      vec4 c = texture2D(u_consistency, (vec2(float(i), float(j)) + 0.5) / 32.0);
      bad += 0.5 * (step(1.0, c.x) + step(1.0, c.y));
      residual += min(c.z, c.w);
    }
  }
  bad /= 1024.0;
  residual /= 1024.0;
  float trust = (1.0 - smoothstep(${f(settings.badLow)}, ${f(settings.badHigh)}, bad)) * (1.0 - smoothstep(${f(settings.residualLow)}, ${f(settings.residualHigh)}, residual));
  gl_FragColor = vec4(trust, bad, residual, 1.0);
}`,

    /*
     * What the missing frames read per pixel besides the flow: how visible A's texel is in B (x), how
     * visible B's texel is in A (y), and the pair's trust (z) - carried in every texel so the missing
     * frame reads one texture where it would otherwise read two.
     */
    visibility: `${HEADER}
uniform sampler2D u_consistency;
uniform sampler2D u_trust;
uniform vec2 u_size;
void main() {
  vec4 c = texture2D(u_consistency, gl_FragCoord.xy / u_size);
  float trust = texture2D(u_trust, vec2(0.5)).x;
  vec2 seen = 1.0 - smoothstep(${f(settings.occlusionLow)}, ${f(settings.occlusionHigh)}, c.xy);
  gl_FragColor = vec4(seen, trust, 1.0);
}`,
  };
}

/**
 * The per-pixel step, shared by both engines as text: the body of `interpolateFrames` - see
 * `frame-interpolation.ts` for what it does and why, and [trackPoints] and [synthesisWeights] for the
 * same maths as plain functions. Each engine defines `SAMPLE(sampler, uv)` before it (`texture` in the
 * painter's GLSL ES 3.00 layer program, `texture2D` in Android's GLSL ES 1.00 one), which is the only
 * word the two dialects spell differently here.
 *
 * Its uniforms: `u_flow` and `u_visibility`, the pair's two answers; `u_flowSize`, their size in texels;
 * and `u_flowOn`, below 0.5 for a pair with no flow - no float targets, a failed pass, a preview drawing
 * the cheaper look - which is phase 1's cross-fade, exactly, and never reads the other three.
 */
export function interpolationBody(settings: FlowSettings = FLOW): string {
  const f = glslFloat;
  return `uniform sampler2D u_flow;
uniform sampler2D u_visibility;
uniform vec2 u_flowSize;
uniform float u_flowOn;
float insideFrame(vec2 p) {
  return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
}
vec3 interpolateFrames(sampler2D frameA, sampler2D frameB, vec2 uv, float w) {
  vec3 blend = mix(SAMPLE(frameA, uv).rgb, SAMPLE(frameB, uv).rgb, w);
  if (u_flowOn < 0.5) return blend;
  float u = 1.0 - w;
  vec4 here = SAMPLE(u_flow, uv);
  vec2 pa = uv - w * here.xy;
  vec2 pb = uv - u * here.zw;
  for (int i = 0; i < ${settings.trackIterations}; i++) {
    pa = uv - w * SAMPLE(u_flow, pa).xy;
    pb = uv - u * SAMPLE(u_flow, pb).zw;
  }
  vec2 flowA = SAMPLE(u_flow, pa).xy * u_flowSize;
  vec2 flowB = SAMPLE(u_flow, pb).zw * u_flowSize;
  float missA = length((pa - uv) * u_flowSize + w * flowA);
  float missB = length((pb - uv) * u_flowSize + u * flowB);
  float landedA = (1.0 - smoothstep(${f(settings.missLow)}, ${f(settings.missHigh)}, missA)) * insideFrame(pa);
  float landedB = (1.0 - smoothstep(${f(settings.missLow)}, ${f(settings.missHigh)}, missB)) * insideFrame(pb);
  float wA = u * landedA * (${f(settings.hiddenWeight)} + SAMPLE(u_visibility, pa).x);
  float wB = w * landedB * (${f(settings.hiddenWeight)} + SAMPLE(u_visibility, pb).y);
  vec3 warped = (wA * SAMPLE(frameA, pa).rgb + wB * SAMPLE(frameB, pb).rgb) / max(wA + wB, 1e-6);
  float moving = smoothstep(${f(settings.motionLow)}, ${f(settings.motionHigh)}, max(length(flowA), length(flowB)));
  float confidence = SAMPLE(u_visibility, uv).z * moving * smoothstep(${f(settings.supportLow)}, ${f(settings.supportHigh)}, max(landedA, landedB));
  return mix(blend, warped, confidence);
}`;
}
