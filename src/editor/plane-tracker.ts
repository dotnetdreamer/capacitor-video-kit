import { fitH, fourPointH, IDENTITY_H, invertH, isConvexQuad, mapCorners, multiplyH, quadArea, squareToQuad, type Homography } from './homography';
import { levelsFor, type LumaFrame } from './object-tracker';

/**
 * Following a flat surface through a footage, frame by frame: a phone's screen, a sign, a wall - what the
 * Track tool's Flat surface follows, so a photo, a text or a sticker pinned to it is drawn ON it, in
 * perspective.
 *
 * The surface is four corners on the first frame (the ANCHOR). Points with something to hold on to are
 * picked across the inner 90% of the quad - its own edge is often a bezel or the background, and says
 * less - and each is followed into the next frame by pyramidal Lucas-Kanade and back again: a point that
 * does not come back to where it started was never really followed. The homography that takes the
 * anchor's surface onto this frame's is then found from the points that agree: RANSAC over four-point
 * solutions, then a least-squares fit to every point it kept.
 *
 * Every point remembers where it was on the ANCHOR, so the homography found is always the anchor's to
 * this frame's, never a product of frame-to-frame steps whose errors pile up. What is left to drift is
 * the points themselves, a little each frame, and the points picked later, whose place on the anchor is
 * only as right as the homography they were picked under. So every few frames the anchor's own points are
 * looked for again: this frame warped back onto the anchor by the homography found, where the surface
 * looks as it did however far it has turned since, and each point found there by Lucas-Kanade - which
 * corrects the homography to what the anchor itself says.
 *
 * LOST - fewer than [MIN_INLIERS] points agree, or the quad comes out folded, tiny or blown up - the frame
 * holds the last quad, and every frame after looks for the surface again, by the anchor's points, where it
 * was last seen. Found, it carries on from there.
 *
 * Pure arithmetic over luma frames, so it runs the same over a phone's preview copy as in a test, in
 * either direction: a frame handed in is the next one, whichever way the footage is being read. Kept to a
 * few dozen points so a 512 by 288 frame costs a few milliseconds even on a cheap phone.
 */

/** What the tracker knows after a frame. */
export interface PlaneTrackerState {
  /** The quad in this frame's pixels (pixel x's middle is at x): x0, y0, ... top-left, top-right, bottom-right, bottom-left. */
  corners: number[];
  /** How sure the frame's answer is, 0..1. */
  confidence: number;
  /** The surface was not seen in this frame: the quad is where it was last seen. */
  lost: boolean;
}

/** The window each point is matched over: 11 by 11 pixels. */
const RADIUS = 5;
const WINDOW = 2 * RADIUS + 1;
const WINDOW_CELLS = WINDOW * WINDOW;

/** Lucas-Kanade's iterations per pyramid level, and the step below which a point has arrived. */
const MAX_ITERATIONS = 16;
const ARRIVED = 0.02;

/** The least texture a point's window may have; see `object-tracker.ts`, whose number this is. */
const MIN_EIGEN = 0.6;

/** The most points followed frame to frame, and the most of the anchor's own looked for again. */
const MAX_POINTS = 48;
const CHECK_POINTS = 48;

/** New points are picked once fewer than this many are left. */
const RESEED_BELOW = 34;

/** Points are spread over a grid of this many cells each way across the surface. */
const GRID = 7;

/** How far in from each edge of the surface points are picked, as a share of it: the inner 90%. */
const INNER = 0.05;

/** Fewer points agreeing than this and the frame is lost. */
const MIN_INLIERS = 10;

/** How near, in pixels, where the homography puts a point must be to where it was followed to, to agree. */
const INLIER_PX = 2;

/**
 * How near, in pixels, a point followed forward and back must come to where it started: loose enough for a
 * little motion blur, since RANSAC still holds every point to [INLIER_PX] of the homography.
 */
const FB_PX = 1.5;

/** The most four-point guesses RANSAC tries, and how sure it wants to be it saw a clean four. */
const RANSAC_ROUNDS = 160;
const RANSAC_SURE = 0.995;

/** Every this many frames the anchor's own points are looked for again. */
const RECHECK_EVERY = 5;

/** The most a frame may grow or shrink the surface by before the answer is taken for noise. */
const MAX_STEP_AREA = 1.6;

/** The coarsest a pyramid level may be (see `levelsFor`). */
const EDGE = 3;

/** A part of a level, in its own pixels: `[x0, x1)` across by `[y0, y1)` down. */
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** One level of a frame's pyramid: the picture and its two gradients. */
interface Level {
  width: number;
  height: number;
  img: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
  /** The part worked out for this frame. Outside it the arrays hold whatever an older frame left there. */
  part: Region;
  /** The part of [part] that is trusted: all of it for a whole frame, [EDGE] inside it otherwise. */
  valid: Region;
}

/** A frame as the tracker works on it: `object-tracker.ts`'s pyramid, worked out over a part of the frame. */
class Pyramid {
  levels: Level[] = [];

  build(frame: LumaFrame, count: number, region: Region | null): void {
    let width = frame.width;
    let height = frame.height;
    let part: Region = region ? clampRegion(region, width, height) : { x0: 0, y0: 0, x1: width, y1: height };
    for (let l = 0; l < count; l++) {
      let level = this.levels[l];
      if (!level || level.width !== width || level.height !== height) {
        const cells = width * height;
        level = { width, height, img: new Float32Array(cells), gx: new Float32Array(cells), gy: new Float32Array(cells), part, valid: part };
        this.levels[l] = level;
      }
      if (l === 0) {
        const src = frame.data;
        const img = level.img;
        for (let y = part.y0; y < part.y1; y++) {
          for (let i = y * width + part.x0, end = y * width + part.x1; i < end; i++) img[i] = src[i]!;
        }
      } else {
        halve(this.levels[l - 1]!, level, part);
      }
      scharr(level, part);
      level.part = part;
      level.valid = region ? shrinkRegion(part, EDGE) : part;
      width = Math.max(1, width >> 1);
      height = Math.max(1, height >> 1);
      part = clampRegion({ x0: part.x0 >> 1, y0: part.y0 >> 1, x1: (part.x1 + 1) >> 1, y1: (part.y1 + 1) >> 1 }, width, height);
    }
    this.levels.length = count;
  }
}

function clampRegion(region: Region, width: number, height: number): Region {
  const x0 = Math.max(0, Math.min(width, Math.floor(region.x0)));
  const y0 = Math.max(0, Math.min(height, Math.floor(region.y0)));
  return { x0, y0, x1: Math.max(x0, Math.min(width, Math.ceil(region.x1))), y1: Math.max(y0, Math.min(height, Math.ceil(region.y1))) };
}

function shrinkRegion(region: Region, by: number): Region {
  return { x0: region.x0 + by, y0: region.y0 + by, x1: Math.max(region.x0 + by, region.x1 - by), y1: Math.max(region.y0 + by, region.y1 - by) };
}

/** OpenCV's `pyrDown` over `part`: a 5-tap binomial blur, then every other pixel. */
function halve(from: Level, to: Level, part: Region): void {
  const fw = from.width;
  const src = from.img;
  const dst = to.img;
  const tw = to.width;
  const { x0: fx0, y0: fy0, x1: fx1, y1: fy1 } = from.part;
  const span = part.x1 - part.x0;
  const rows = new Float32Array(Math.max(1, span) * 5);
  for (let y = part.y0; y < part.y1; y++) {
    for (let k = 0; k < 5; k++) {
      const base = clampTo(2 * y + k - 2, fy0, fy1) * fw;
      const out = k * span;
      for (let x = part.x0; x < part.x1; x++) {
        const sx = 2 * x;
        const a = src[base + clampTo(sx - 2, fx0, fx1)]!;
        const b = src[base + clampTo(sx - 1, fx0, fx1)]!;
        const c = src[base + clampTo(sx, fx0, fx1)]!;
        const d = src[base + clampTo(sx + 1, fx0, fx1)]!;
        const e = src[base + clampTo(sx + 2, fx0, fx1)]!;
        rows[out + x - part.x0] = (a + 4 * b + 6 * c + 4 * d + e) * 0.0625;
      }
    }
    const base = y * tw;
    for (let x = part.x0, i = 0; x < part.x1; x++, i++) {
      dst[base + x] = (rows[i]! + 4 * rows[span + i]! + 6 * rows[2 * span + i]! + 4 * rows[3 * span + i]! + rows[4 * span + i]!) * 0.0625;
    }
  }
}

function clampTo(i: number, lo: number, hi: number): number {
  return i < lo ? lo : i >= hi ? hi - 1 : i;
}

/** Scharr gradients over `part`, in luma levels per pixel, the part's edges replicated. */
function scharr(level: Level, part: Region): void {
  const { width: w, img, gx, gy } = level;
  for (let y = part.y0; y < part.y1; y++) {
    const up = clampTo(y - 1, part.y0, part.y1) * w;
    const mid = y * w;
    const down = clampTo(y + 1, part.y0, part.y1) * w;
    for (let x = part.x0; x < part.x1; x++) {
      const l = clampTo(x - 1, part.x0, part.x1);
      const r = clampTo(x + 1, part.x0, part.x1);
      gx[mid + x] = (3 * (img[up + r]! - img[up + l]!) + 10 * (img[mid + r]! - img[mid + l]!) + 3 * (img[down + r]! - img[down + l]!)) / 32;
      gy[mid + x] = (3 * (img[down + l]! - img[up + l]!) + 10 * (img[down + x]! - img[up + x]!) + 3 * (img[down + r]! - img[up + r]!)) / 32;
    }
  }
}

/** The window of `src` centred on (`x`, `y`), bilinearly, into `out`; false where any of it is outside the trusted part. */
function sampleWindow(src: Float32Array, level: Level, x: number, y: number, r: number, out: Float32Array): boolean {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const v = level.valid;
  if (!(x0 - r >= v.x0 && y0 - r >= v.y0 && x0 + r + 1 < v.x1 && y0 + r + 1 < v.y1)) return false;
  const w = level.width;
  const ax = x - x0;
  const ay = y - y0;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  let k = 0;
  for (let dy = -r; dy <= r; dy++) {
    let i = (y0 + dy) * w + x0 - r;
    for (let dx = -r; dx <= r; dx++, i++) out[k++] = w00 * src[i]! + w10 * src[i + 1]! + w01 * src[i + w]! + w11 * src[i + w + 1]!;
  }
  return true;
}

const prevWin = new Float32Array(WINDOW_CELLS);
const prevGx = new Float32Array(WINDOW_CELLS);
const prevGy = new Float32Array(WINDOW_CELLS);
const nextWin = new Float32Array(WINDOW_CELLS);
const shift = new Float64Array(2);

/** One level of Lucas-Kanade (Bouguet's): the shift of the window at (`px`, `py`) of `prev` into `next`, from the guess. */
function lucasKanade(prev: Level, next: Level, px: number, py: number, gx: number, gy: number): boolean {
  if (!sampleWindow(prev.img, prev, px, py, RADIUS, prevWin)) return false;
  sampleWindow(prev.gx, prev, px, py, RADIUS, prevGx);
  sampleWindow(prev.gy, prev, px, py, RADIUS, prevGy);
  let a = 0;
  let b = 0;
  let c = 0;
  for (let k = 0; k < WINDOW_CELLS; k++) {
    const x = prevGx[k]!;
    const y = prevGy[k]!;
    a += x * x;
    b += x * y;
    c += y * y;
  }
  const det = a * c - b * b;
  const minEigen = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / (2 * WINDOW_CELLS);
  if (!(minEigen >= MIN_EIGEN) || !(det > 0)) return false;
  let vx = 0;
  let vy = 0;
  for (let it = 0; it < MAX_ITERATIONS; it++) {
    if (!sampleWindow(next.img, next, px + gx + vx, py + gy + vy, RADIUS, nextWin)) return false;
    let bx = 0;
    let by = 0;
    for (let k = 0; k < WINDOW_CELLS; k++) {
      const d = prevWin[k]! - nextWin[k]!;
      bx += d * prevGx[k]!;
      by += d * prevGy[k]!;
    }
    const ex = (c * bx - b * by) / det;
    const ey = (a * by - b * bx) / det;
    vx += ex;
    vy += ey;
    if (ex * ex + ey * ey < ARRIVED * ARRIVED) break;
  }
  shift[0] = vx;
  shift[1] = vy;
  return true;
}

/** Where (`x`, `y`) of `prev` is in `next`, through the pyramid from level `top`, from a guess in full-size pixels. */
function followPoint(prev: Pyramid, next: Pyramid, top: number, x: number, y: number, guessX: number, guessY: number, out: Float64Array): boolean {
  let gx = guessX / (1 << top);
  let gy = guessY / (1 << top);
  for (let l = top; l >= 0; l--) {
    const f = 1 / (1 << l);
    let dx = 0;
    let dy = 0;
    if (lucasKanade(prev.levels[l]!, next.levels[l]!, x * f, y * f, gx, gy)) {
      dx = shift[0]!;
      dy = shift[1]!;
    } else if (l === 0) {
      return false;
    }
    if (l > 0) {
      gx = 2 * (gx + dx);
      gy = 2 * (gy + dy);
    } else {
      out[0] = x + gx + dx;
      out[1] = y + gy + dy;
    }
  }
  return true;
}

/** Shi and Tomasi's score over a 7 by 7 window: the smaller eigenvalue of the structure tensor, per pixel. */
function cornerScore(level: Level, x: number, y: number): number {
  const xi = Math.round(x);
  const yi = Math.round(y);
  const w = level.width;
  let a = 0;
  let b = 0;
  let c = 0;
  for (let dy = -3; dy <= 3; dy++) {
    const row = (yi + dy) * w;
    for (let dx = -3; dx <= 3; dx++) {
      const i = row + xi + dx;
      const gx = level.gx[i]!;
      const gy = level.gy[i]!;
      a += gx * gx;
      b += gx * gy;
      c += gy * gy;
    }
  }
  return (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / (2 * 49);
}

/** The coarsest level a surface `side` pixels across is followed from: the coarsest it still fills a window at. */
function topLevel(levelCount: number, side: number): number {
  let top = 0;
  while (top + 1 < levelCount && side / (1 << (top + 1)) >= 1.5 * WINDOW) top++;
  return top;
}

/** The points of one frame's match: where each was on the anchor, and where it is now. */
interface Matches {
  sx: Float64Array;
  sy: Float64Array;
  tx: Float64Array;
  ty: Float64Array;
  n: number;
}

/** What RANSAC settled on: the homography, which matches agree with it (into [Matches] order), and how well. */
interface Fit {
  h: Homography;
  count: number;
  /** The root mean square distance of the agreeing matches, in pixels. */
  rms: number;
  /** How much of the surface the agreeing matches are spread over, 0..1 of its inner square. */
  spread: number;
}

export class PlaneTracker {
  private prev = new Pyramid();
  private next = new Pyramid();
  private readonly anchor = new Pyramid();
  private readonly rectified = new Pyramid();
  /** This frame warped back onto the anchor, over the part the surface covers there. */
  private rectData: Float32Array | null = null;
  private levelCount = 1;
  private width = 0;
  private height = 0;
  private anchorQuad: number[] = [];
  /** The unit square onto the anchor's quad, and back. */
  private anchorSquare: Homography = [...IDENTITY_H];
  private toUnit: Homography = [...IDENTITY_H];
  /** The anchor's pixels to this frame's: the surface now, or where it was last seen while it is lost. */
  private h: Homography = [...IDENTITY_H];
  /** The same for the frame before, which the next frame's guess is made from. Null after a lost frame. */
  private before: Homography | null = null;
  private state: PlaneTrackerState | null = null;
  /** The points followed frame to frame: where each was on the anchor, and where it is in the last frame. */
  private readonly ax = new Float64Array(MAX_POINTS);
  private readonly ay = new Float64Array(MAX_POINTS);
  private readonly px = new Float64Array(MAX_POINTS);
  private readonly py = new Float64Array(MAX_POINTS);
  private count = 0;
  /** The anchor's own points, looked for again every few frames. */
  private readonly fx = new Float64Array(CHECK_POINTS);
  private readonly fy = new Float64Array(CHECK_POINTS);
  private features = 0;
  private sinceCheck = 0;
  private lostFor = 0;
  /** RANSAC's draws: the same every run, so a run gives the same answers every time. */
  private random = 0x2545f491;
  private readonly matches: Matches = {
    sx: new Float64Array(Math.max(MAX_POINTS, CHECK_POINTS)),
    sy: new Float64Array(Math.max(MAX_POINTS, CHECK_POINTS)),
    tx: new Float64Array(Math.max(MAX_POINTS, CHECK_POINTS)),
    ty: new Float64Array(Math.max(MAX_POINTS, CHECK_POINTS)),
    n: 0,
  };
  private readonly agree = new Int32Array(Math.max(MAX_POINTS, CHECK_POINTS));
  private readonly out = new Float64Array(2);
  private readonly back = new Float64Array(2);

  /** Where it is now, or null before [start]. */
  get current(): PlaneTrackerState | null {
    return this.state ? { ...this.state, corners: [...this.state.corners] } : null;
  }

  /**
   * Starts on `frame`, with the surface inside `corners` (pixels; see [PlaneTrackerState.corners]). Answers
   * lost - with the quad as given - when the quad is folded or tiny, or holds too little to follow: a blank
   * wall, a screen showing black.
   */
  start(frame: LumaFrame, corners: ArrayLike<number>): PlaneTrackerState {
    this.width = frame.width;
    this.height = frame.height;
    this.levelCount = levelsFor(frame.width, frame.height);
    this.anchorQuad = Array.from({ length: 8 }, (_, k) => Number(corners[k]));
    this.h = [...IDENTITY_H];
    this.before = null;
    this.count = 0;
    this.features = 0;
    this.sinceCheck = 0;
    this.lostFor = 0;
    this.random = 0x2545f491;
    this.anchor.build(frame, this.levelCount, null);
    this.prev.build(frame, this.levelCount, null);
    const square = squareToQuad(this.anchorQuad);
    const toUnit = square ? invertH(square) : null;
    let lost = !square || !toUnit || !this.isGood(this.anchorQuad, IDENTITY_H, null);
    if (square && toUnit && !lost) {
      this.anchorSquare = square;
      this.toUnit = toUnit;
      this.seed(this.prev.levels[0]!);
      for (let i = 0; i < this.count && this.features < CHECK_POINTS; i++) {
        this.fx[this.features] = this.ax[i]!;
        this.fy[this.features] = this.ay[i]!;
        this.features++;
      }
      lost = this.count < MIN_INLIERS;
    }
    if (lost) this.lostFor = 1;
    this.state = { corners: [...this.anchorQuad], confidence: lost ? 0 : 1, lost };
    return this.current!;
  }

  /** Follows the surface into `frame`, the one after the last frame handed in. */
  step(frame: LumaFrame): PlaneTrackerState {
    const state = this.state;
    if (!state) throw new Error('PlaneTracker.step before start');
    const result = this.lostFor > 0 ? this.recover(frame, state) : this.follow(frame, state);
    // The frame just read is the one the next is followed from.
    const swap = this.prev;
    this.prev = this.next;
    this.next = swap;
    this.state = result;
    return this.current!;
  }

  /** One frame followed from the last: the points forward and back, the homography they agree on, and now and then the anchor's word on it. */
  private follow(frame: LumaFrame, state: PlaneTrackerState): PlaneTrackerState {
    const h = this.h;
    const now = state.corners;
    // The step the last frame made, made again: where the surface is guessed to be.
    const back = this.before ? invertH(this.before) : null;
    const stepH = back ? multiplyH(h, back) : null;
    const guessed = stepH ? mapCorners(stepH, now) : now;
    const side = Math.min(spanOf(now, 0), spanOf(now, 1));
    const top = topLevel(this.levelCount, side);
    let move = 0;
    for (let k = 0; k < 8; k++) move = Math.max(move, Math.abs(guessed[k]! - now[k]!));
    if (!(move < 0.5 * Math.max(this.width, this.height))) move = 0;
    const reach = 24 + (RADIUS + EDGE + 2) * (1 << top) + 2 * move;
    this.next.build(frame, this.levelCount, boundsOf([now, move > 0 ? guessed : now], reach));

    // Forward and back, each point from where the step would take it.
    const m = this.matches;
    m.n = 0;
    const limit = 0.25 * Math.max(this.width, this.height);
    for (let i = 0; i < this.count; i++) {
      const x = this.px[i]!;
      const y = this.py[i]!;
      let gx = 0;
      let gy = 0;
      if (stepH) {
        const w = stepH[6]! * x + stepH[7]! * y + stepH[8]!;
        if (w > 0) {
          gx = (stepH[0]! * x + stepH[1]! * y + stepH[2]!) / w - x;
          gy = (stepH[3]! * x + stepH[4]! * y + stepH[5]!) / w - y;
        }
        if (!(Math.abs(gx) < limit && Math.abs(gy) < limit)) gx = gy = 0;
      }
      const out = this.out;
      if (!followPoint(this.prev, this.next, top, x, y, gx, gy, out)) continue;
      if (!followPoint(this.next, this.prev, top, out[0]!, out[1]!, x - out[0]!, y - out[1]!, this.back)) continue;
      if (Math.hypot(this.back[0]! - x, this.back[1]! - y) > FB_PX) continue;
      m.sx[m.n] = this.ax[i]!;
      m.sy[m.n] = this.ay[i]!;
      m.tx[m.n] = out[0]!;
      m.ty[m.n] = out[1]!;
      m.n++;
    }
    if (m.n < MIN_INLIERS) return this.lose(state);
    const fit = this.ransac(h);
    if (!fit || fit.count < MIN_INLIERS) return this.lose(state);
    let corners = mapCorners(fit.h, this.anchorQuad);
    if (!this.isGood(corners, fit.h, now)) return this.lose(state);

    // The points that agreed are the ones followed on.
    for (let k = 0; k < fit.count; k++) {
      const i = this.agree[k]!;
      this.ax[k] = m.sx[i]!;
      this.ay[k] = m.sy[i]!;
      this.px[k] = m.tx[i]!;
      this.py[k] = m.ty[i]!;
    }
    this.count = fit.count;
    this.before = this.h;
    this.h = fit.h;
    let confidence = confidenceOf(fit, m.n);

    // The anchor's word on it, every few frames - and at once when the points are thinning out.
    if (++this.sinceCheck >= RECHECK_EVERY || this.count < RESEED_BELOW) {
      this.sinceCheck = 0;
      const checked = this.recheck(frame, this.h, false);
      if (checked) {
        const checkedCorners = mapCorners(checked.h, this.anchorQuad);
        if (this.isGood(checkedCorners, checked.h, now)) {
          this.h = checked.h;
          corners = checkedCorners;
          confidence = Math.max(confidence, confidenceOf(checked, checked.count));
          this.reanchor();
        }
      }
    }
    if (this.count < RESEED_BELOW) this.seed(this.next.levels[0]!);
    return { corners, confidence, lost: false };
  }

  /** A frame while the surface is lost: looked for by the anchor's points, round where it was last seen. */
  private recover(frame: LumaFrame, state: PlaneTrackerState): PlaneTrackerState {
    if (this.features < MIN_INLIERS) return this.lose(state);
    this.next.build(frame, this.levelCount, null);
    const checked = this.recheck(frame, this.h, true);
    if (!checked) return this.lose(state);
    const corners = mapCorners(checked.h, this.anchorQuad);
    if (!this.isGood(corners, checked.h, null)) return this.lose(state);
    this.h = checked.h;
    this.before = null;
    this.lostFor = 0;
    this.sinceCheck = 0;
    this.count = 0;
    this.seed(this.next.levels[0]!);
    if (this.count < MIN_INLIERS) {
      this.lostFor = 1;
      return { ...state, confidence: 0, lost: true };
    }
    return { corners, confidence: confidenceOf(checked, checked.count), lost: false };
  }

  /** The frame lost: the quad stays where it was, and the next frames look for the surface again. */
  private lose(state: PlaneTrackerState): PlaneTrackerState {
    this.lostFor++;
    this.before = null;
    return { corners: [...state.corners], confidence: 0, lost: true };
  }

  /**
   * The anchor's own points looked for in `frame`: the frame warped back onto the anchor by `guess`, so the
   * surface there looks as it did on the anchor, and each point found in it by Lucas-Kanade from where it
   * was - a little way off where the guess has drifted. Deep (`deep`) while the surface is lost, so a guess
   * further off is still reached. Null where too few are found to say.
   */
  private recheck(frame: LumaFrame, guess: Homography, deep: boolean): Fit | null {
    const W = this.width;
    const H = this.height;
    const top = deep ? this.levelCount - 1 : Math.min(1, this.levelCount - 1);
    const region = clampRegion(boundsOf([this.anchorQuad], (RADIUS + EDGE + 2) * (1 << top) + 4), W, H);
    if (!(region.x1 > region.x0 && region.y1 > region.y0)) return null;
    if (!this.rectData || this.rectData.length !== W * H) this.rectData = new Float32Array(W * H);
    const data = this.rectData;
    const src = frame.data;
    for (let y = region.y0; y < region.y1; y++) {
      for (let x = region.x0; x < region.x1; x++) {
        const w = guess[6]! * x + guess[7]! * y + guess[8]!;
        let value = 0;
        if (w > 0) {
          const fx = Math.min(W - 1.001, Math.max(0, (guess[0]! * x + guess[1]! * y + guess[2]!) / w));
          const fy = Math.min(H - 1.001, Math.max(0, (guess[3]! * x + guess[4]! * y + guess[5]!) / w));
          const ix = Math.floor(fx);
          const iy = Math.floor(fy);
          const ax = fx - ix;
          const ay = fy - iy;
          const i = iy * W + ix;
          value = (1 - ay) * ((1 - ax) * src[i]! + ax * src[i + 1]!) + ay * ((1 - ax) * src[i + W]! + ax * src[i + W + 1]!);
        }
        data[y * W + x] = value;
      }
    }
    this.rectified.build({ width: W, height: H, data }, this.levelCount, region);
    const m = this.matches;
    m.n = 0;
    for (let i = 0; i < this.features; i++) {
      const x = this.fx[i]!;
      const y = this.fy[i]!;
      const out = this.out;
      if (!followPoint(this.anchor, this.rectified, top, x, y, 0, 0, out)) continue;
      if (!followPoint(this.rectified, this.anchor, top, out[0]!, out[1]!, x - out[0]!, y - out[1]!, this.back)) continue;
      if (Math.hypot(this.back[0]! - x, this.back[1]! - y) > FB_PX) continue;
      // Found at `out` on the warped frame, which is `guess` of it on the frame itself.
      const w = guess[6]! * out[0]! + guess[7]! * out[1]! + guess[8]!;
      if (!(w > 0)) continue;
      m.sx[m.n] = x;
      m.sy[m.n] = y;
      m.tx[m.n] = (guess[0]! * out[0]! + guess[1]! * out[1]! + guess[2]!) / w;
      m.ty[m.n] = (guess[3]! * out[0]! + guess[4]! * out[1]! + guess[5]!) / w;
      m.n++;
    }
    const least = Math.max(MIN_INLIERS + 2, Math.ceil(0.3 * this.features));
    if (m.n < least) return null;
    const fit = this.ransac(guess);
    return fit && fit.count >= least ? fit : null;
  }

  /** The points followed on, each given its place on the anchor again by the homography the anchor itself just corrected. */
  private reanchor(): void {
    const back = invertH(this.h);
    if (!back) return;
    let kept = 0;
    for (let i = 0; i < this.count; i++) {
      const x = this.px[i]!;
      const y = this.py[i]!;
      const w = back[6]! * x + back[7]! * y + back[8]!;
      if (!(w > 0)) continue;
      this.ax[kept] = (back[0]! * x + back[1]! * y + back[2]!) / w;
      this.ay[kept] = (back[3]! * x + back[4]! * y + back[5]!) / w;
      this.px[kept] = x;
      this.py[kept] = y;
      kept++;
    }
    this.count = kept;
  }

  /**
   * RANSAC over [matches]: four matches at a time, each four's homography scored by how many matches it puts
   * within [INLIER_PX], for as many rounds as it takes to be [RANSAC_SURE] of having drawn four clean ones -
   * then a least-squares fit to every match the best agreed with, and once more to every match the fit
   * agrees with. The agreeing matches' indices go into [agree]. `near` is the homography of the frame before,
   * which the fit starts from.
   */
  private ransac(near: Homography): Fit | null {
    const m = this.matches;
    const n = m.n;
    if (n < 4) return null;
    let best: Homography | null = null;
    let bestCount = 0;
    let bestError = Infinity;
    let rounds = RANSAC_ROUNDS;
    const from = new Array<number>(8);
    const to = new Array<number>(8);
    const pick = new Int32Array(4);
    for (let round = 0; round < rounds; round++) {
      if (!this.draw(n, pick)) continue;
      for (let k = 0; k < 4; k++) {
        from[2 * k] = m.sx[pick[k]!]!;
        from[2 * k + 1] = m.sy[pick[k]!]!;
        to[2 * k] = m.tx[pick[k]!]!;
        to[2 * k + 1] = m.ty[pick[k]!]!;
      }
      if (!spreadOut(from)) continue;
      const guess = fourPointH(from, to);
      if (!guess) continue;
      let count = 0;
      let error = 0;
      for (let i = 0; i < n; i++) {
        const d = distanceOf(guess, m.sx[i]!, m.sy[i]!, m.tx[i]!, m.ty[i]!);
        if (d < INLIER_PX) {
          count++;
          error += d;
        }
      }
      if (count > bestCount || (count === bestCount && error < bestError)) {
        best = guess;
        bestCount = count;
        bestError = error;
        const share = count / n;
        const clean = Math.pow(share, 4);
        rounds = clean >= 1 ? 0 : Math.min(RANSAC_ROUNDS, Math.ceil(Math.log(1 - RANSAC_SURE) / Math.log(1 - Math.max(1e-9, clean))));
      }
    }
    // Where no four agreed better, the last frame's own homography is tried: the surface may simply not have moved.
    const still = this.agreeing(near);
    if (still > bestCount) {
      best = near;
      bestCount = still;
    }
    if (!best || bestCount < 4) return null;
    let h: Homography = best;
    for (let pass = 0; pass < 2; pass++) {
      const count = this.agreeing(h);
      if (count < 4) return null;
      const fitted = fitH(m.sx, m.sy, m.tx, m.ty, this.agree, count, h);
      if (!fitted) break;
      h = fitted;
    }
    const count = this.agreeing(h);
    if (count < 4) return null;
    let sum = 0;
    let u0 = Infinity;
    let u1 = -Infinity;
    let v0 = Infinity;
    let v1 = -Infinity;
    const unit = this.toUnit;
    for (let k = 0; k < count; k++) {
      const i = this.agree[k]!;
      const d = distanceOf(h, m.sx[i]!, m.sy[i]!, m.tx[i]!, m.ty[i]!);
      sum += d * d;
      const w = unit[6]! * m.sx[i]! + unit[7]! * m.sy[i]! + unit[8]!;
      const u = (unit[0]! * m.sx[i]! + unit[1]! * m.sy[i]! + unit[2]!) / w;
      const v = (unit[3]! * m.sx[i]! + unit[4]! * m.sy[i]! + unit[5]!) / w;
      if (u < u0) u0 = u;
      if (u > u1) u1 = u;
      if (v < v0) v0 = v;
      if (v > v1) v1 = v;
    }
    const inner = (1 - 2 * INNER) * (1 - 2 * INNER);
    const spread = Math.min(1, (Math.max(0, u1 - u0) * Math.max(0, v1 - v0)) / inner);
    return { h, count, rms: Math.sqrt(sum / count), spread };
  }

  /** How many matches `h` puts within [INLIER_PX], their indices into [agree]. */
  private agreeing(h: Homography): number {
    const m = this.matches;
    let count = 0;
    for (let i = 0; i < m.n; i++) if (distanceOf(h, m.sx[i]!, m.sy[i]!, m.tx[i]!, m.ty[i]!) < INLIER_PX) this.agree[count++] = i;
    return count;
  }

  /** Four different matches out of `n`, into `pick`: xorshift, seeded the same every run. */
  private draw(n: number, pick: Int32Array): boolean {
    for (let k = 0; k < 4; k++) {
      let x = this.random;
      x ^= x << 13;
      x ^= x >>> 17;
      x ^= x << 5;
      this.random = x >>> 0;
      const i = this.random % n;
      for (let j = 0; j < k; j++) if (pick[j] === i) return false;
      pick[k] = i;
    }
    return true;
  }

  /**
   * Whether a frame's quad is a surface: every corner in front of the camera, convex and the anchor's way
   * round, neither tiny nor blown up past the frame, and - against `before`, the last frame's - not grown or
   * shrunk past [MAX_STEP_AREA] in one frame, which no surface does.
   */
  private isGood(corners: number[], h: ArrayLike<number>, before: number[] | null): boolean {
    for (let k = 0; k < 4; k++) {
      const x = this.anchorQuad[2 * k]!;
      const y = this.anchorQuad[2 * k + 1]!;
      if (!(h[6]! * x + h[7]! * y + h[8]! > 0)) return false;
    }
    if (!corners.every(Number.isFinite) || !isConvexQuad(corners)) return false;
    const area = quadArea(corners);
    const anchorArea = quadArea(this.anchorQuad);
    if (Math.sign(area) !== Math.sign(anchorArea) || anchorArea === 0) return false;
    const frame = this.width * this.height;
    const size = Math.abs(area);
    if (!(size >= Math.max(150, 0.0005 * frame)) || !(size <= 9 * frame)) return false;
    if (before) {
      const was = Math.abs(quadArea(before));
      if (!(was > 0) || size > was * MAX_STEP_AREA || size < was / MAX_STEP_AREA) return false;
    }
    return true;
  }

  /**
   * New points, where the surface has too few: a [GRID] by [GRID] grid over its inner 90%, the strongest
   * corner of a few spots in each cell no point already holds, the strongest cells first - into the points
   * followed, each with its place on the anchor by the homography now. `level` is this frame's finest.
   */
  private seed(level: Level): void {
    if (this.count >= MAX_POINTS) return;
    const square = multiplyH(this.h, this.anchorSquare);
    const back = invertH(this.h);
    if (!back) return;
    const unit = this.toUnit;
    const taken = new Uint8Array(GRID * GRID);
    const span = 1 - 2 * INNER;
    for (let i = 0; i < this.count; i++) {
      const x = this.ax[i]!;
      const y = this.ay[i]!;
      const w = unit[6]! * x + unit[7]! * y + unit[8]!;
      const u = (unit[0]! * x + unit[1]! * y + unit[2]!) / w;
      const v = (unit[3]! * x + unit[4]! * y + unit[5]!) / w;
      const ci = Math.floor(((u - INNER) / span) * GRID);
      const cj = Math.floor(((v - INNER) / span) * GRID);
      if (ci >= 0 && ci < GRID && cj >= 0 && cj < GRID) taken[cj * GRID + ci] = 1;
    }
    const margin = RADIUS + 4;
    const valid = level.valid;
    const found: { x: number; y: number; score: number }[] = [];
    for (let cj = 0; cj < GRID; cj++) {
      for (let ci = 0; ci < GRID; ci++) {
        if (taken[cj * GRID + ci]) continue;
        let best: { x: number; y: number; score: number } | null = null;
        for (let sj = 0; sj < 3; sj++) {
          for (let si = 0; si < 3; si++) {
            const u = INNER + ((ci + (si + 0.5) / 3) / GRID) * span;
            const v = INNER + ((cj + (sj + 0.5) / 3) / GRID) * span;
            const w = square[6]! * u + square[7]! * v + square[8]!;
            if (!(w > 0)) continue;
            const x = (square[0]! * u + square[1]! * v + square[2]!) / w;
            const y = (square[3]! * u + square[4]! * v + square[5]!) / w;
            if (!(x >= valid.x0 + margin && x < valid.x1 - margin && y >= valid.y0 + margin && y < valid.y1 - margin)) continue;
            const score = cornerScore(level, x, y);
            if (score >= MIN_EIGEN && (!best || score > best.score)) best = { x, y, score };
          }
        }
        if (best) found.push(best);
      }
    }
    found.sort((a, b) => b.score - a.score);
    for (const point of found) {
      if (this.count >= MAX_POINTS) break;
      const w = back[6]! * point.x + back[7]! * point.y + back[8]!;
      if (!(w > 0)) continue;
      this.ax[this.count] = (back[0]! * point.x + back[1]! * point.y + back[2]!) / w;
      this.ay[this.count] = (back[3]! * point.x + back[4]! * point.y + back[5]!) / w;
      this.px[this.count] = point.x;
      this.py[this.count] = point.y;
      this.count++;
    }
  }
}

/** How far `h` puts (`sx`, `sy`) from (`tx`, `ty`), in pixels; Infinity for a point it sends off the frame's plane. */
function distanceOf(h: ArrayLike<number>, sx: number, sy: number, tx: number, ty: number): number {
  const w = h[6]! * sx + h[7]! * sy + h[8]!;
  if (!(w > 0)) return Infinity;
  return Math.hypot((h[0]! * sx + h[1]! * sy + h[2]!) / w - tx, (h[3]! * sx + h[4]! * sy + h[5]!) / w - ty);
}

/** Whether four points are far enough apart, and far enough from one line, to fix a homography by. */
function spreadOut(p: number[]): boolean {
  for (let a = 0; a < 4; a++) {
    for (let b = a + 1; b < 4; b++) if (Math.hypot(p[2 * a]! - p[2 * b]!, p[2 * a + 1]! - p[2 * b + 1]!) < 4) return false;
  }
  for (let skip = 0; skip < 4; skip++) {
    const q: number[] = [];
    for (let k = 0; k < 4; k++) if (k !== skip) q.push(p[2 * k]!, p[2 * k + 1]!);
    const area = Math.abs((q[2]! - q[0]!) * (q[5]! - q[1]!) - (q[3]! - q[1]!) * (q[4]! - q[0]!)) / 2;
    if (area < 8) return false;
  }
  return true;
}

/** How sure a fit is: enough points, most of them agreeing, closely, and spread over the surface rather than in one corner of it. */
function confidenceOf(fit: Fit, tried: number): number {
  const many = Math.min(1, fit.count / 24);
  const share = tried > 0 ? fit.count / tried : 0;
  const close = Math.max(0, Math.min(1, 1 - fit.rms / INLIER_PX));
  const spread = Math.min(1, fit.spread / 0.3);
  return Math.max(0, Math.min(1, many * spread * (0.4 + 0.6 * share) * (0.5 + 0.5 * close)));
}

/** How far the quad reaches across (`axis` 0) or down (1). */
function spanOf(corners: ArrayLike<number>, axis: number): number {
  let lo = Infinity;
  let hi = -Infinity;
  for (let k = 0; k < 4; k++) {
    const v = corners[2 * k + axis]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return Math.max(0, hi - lo);
}

/** The box round every quad of `quads`, `pad` more on every side. */
function boundsOf(quads: ArrayLike<number>[], pad: number): Region {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const q of quads) {
    for (let k = 0; k < 4; k++) {
      const x = q[2 * k]!;
      const y = q[2 * k + 1]!;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad };
}
