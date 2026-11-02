/**
 * Following one thing through a footage, frame by frame: what the Track tool pins a text, a sticker or
 * a photo to.
 *
 * Median flow (Kalal, Mikolajczyk and Matas, 2010), the tracker behind most "tap and follow" tools. A
 * few dozen points with something to hold on to are picked inside the box, each is followed into the
 * next frame by pyramidal Lucas-Kanade and back again, and only the points that came back to where they
 * started - and still look like themselves - get a say. The box then moves by the median of what they
 * did: their shift, how much further apart they drifted (the box grows) and how far round they turned
 * (the box turns). A median is what makes it hold: a third of the points can be on the background, or
 * on a hand that crossed in front, and the box still goes where the thing went.
 *
 * When the points stop agreeing - the thing is hidden, leaves the frame, or blurs past - the frame is
 * LOST: the box stays where it was last seen and the tracker looks for the thing again in every frame
 * after, by its picture (a normalised cross correlation of how it looked when it was last seen clearly,
 * and when the customer drew the box), over a search that widens the longer it stays gone. Found, it
 * carries on from there.
 *
 * Pure arithmetic over luma frames, so it runs the same over a phone's preview copy as in a test, in
 * either direction: a frame handed in is the next one, whichever way the footage is being read.
 */

/** A frame the tracker reads: one byte of luma per pixel, row by row from the top-left. */
export interface LumaFrame {
  readonly width: number;
  readonly height: number;
  readonly data: ArrayLike<number>;
}

/** Where the thing is to start with, in the first frame's pixels: its centre and its size. */
export interface TrackerBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/** What the tracker knows after a frame. Positions are in that frame's pixels. */
export interface TrackerState {
  cx: number;
  cy: number;
  /** The box as it is now: the start box's size times [scale]. */
  w: number;
  h: number;
  /** Size against the start box. */
  scale: number;
  /** Clockwise degrees against the start box, unwrapped: a thing turned twice round reads 720. */
  angle: number;
  /** How sure the frame's answer is, 0..1. */
  confidence: number;
  /** The thing was not seen in this frame: the box is where it was last seen. */
  lost: boolean;
}

/** The window each point is matched over: 11 by 11 pixels. */
const RADIUS = 5;
const WINDOW = 2 * RADIUS + 1;
const WINDOW_CELLS = WINDOW * WINDOW;

/** Lucas-Kanade's iterations per pyramid level, and the step below which a point has arrived. */
const MAX_ITERATIONS = 20;
const ARRIVED = 0.01;

/**
 * The least texture a point's window may have: the smaller eigenvalue of its structure tensor, per
 * pixel, in luma levels squared per pixel squared. Below it a window is flat - a wall, the sky - and
 * any shift fits it as well as any other.
 */
const MIN_EIGEN = 0.6;

/** The most points followed per frame, and the fewest that have to agree for a frame to count. */
const MAX_POINTS = 40;
const MIN_AGREEING = 4;

/** Points are picked inside this much of the box, so its edge - often background - says less. */
const SEED_INSET = 0.8;

/** The coarsest a pyramid level may be on its shorter side. */
const MIN_LEVEL_SIDE = 24;
const MAX_LEVELS = 4;

/** How far a frame may grow or shrink the box, and turn it, before the answer is taken for noise. */
const MAX_STEP_SCALE = 1.2;
const MAX_STEP_TURN = 20;

/** The patch a point is compared over, to see it still looks like itself: 7 by 7. */
const PATCH_RADIUS = 3;

/** The template a lost thing is looked for by: this many cells a side. */
const TEMPLATE = 16;

/** A match at least this alike finds the thing again. */
const FOUND_AT = 0.72;

/** How often, in frames seen clearly, the picture a lost thing is looked for by is renewed. */
const TEMPLATE_EVERY = 12;

/** How sure a frame has to be for the template to be renewed from it. */
const RENEW_AT = 0.55;

/** A part of a level, in its own pixels: `[x0, x1)` across by `[y0, y1)` down. */
interface Region {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/**
 * How far in from the edge of the part of a level that was worked out it is trusted: the blur and the
 * gradients at that edge read past it, where the arrays hold an older frame.
 */
const EDGE = 3;

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

/**
 * A frame as the tracker works on it: a pyramid, finest first - worked out round the thing only, since
 * nothing else of the frame is ever read while it is being followed. Working out the whole frame's was
 * most of the cost of a frame, and on a phone it was the difference between following a clip faster
 * than it plays and slower.
 */
class Pyramid {
  levels: Level[] = [];

  /**
   * Rebuilds the pyramid for `frame` with `count` levels over `region` of it - the whole frame for
   * null - reusing the arrays it already has.
   */
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
      // A whole frame is trusted to its edges, which are replicated; a part only inside its own edge.
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

/**
 * The next level down over `part` of it: a 5-tap binomial blur, then every other pixel - OpenCV's
 * `pyrDown`. The level above is read only inside the part of it that was worked out, edges replicated.
 */
function halve(from: Level, to: Level, part: Region): void {
  const fw = from.width;
  const src = from.img;
  const dst = to.img;
  const tw = to.width;
  const { x0: fx0, y0: fy0, x1: fx1, y1: fy1 } = from.part;
  const span = part.x1 - part.x0;
  // The five source rows under one output row, each blurred across first.
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

/** `i` held to `[lo, hi)`. */
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

/**
 * The window of `src` - one of `level`'s arrays - centred on (`x`, `y`), bilinearly, into `out`; or false
 * where any of it falls outside the part of the level that holds this frame. Every sample shares the same
 * fractional offset, so the four weights are worked out once.
 */
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
    for (let dx = -r; dx <= r; dx++, i++) {
      out[k++] = w00 * src[i]! + w10 * src[i + 1]! + w01 * src[i + w]! + w11 * src[i + w + 1]!;
    }
  }
  return true;
}

/** One bilinear sample of `level`'s picture, held to the part of it that holds this frame. */
function sampleAt(level: Level, x: number, y: number): number {
  const v = level.valid;
  if (!(v.x1 - v.x0 >= 2 && v.y1 - v.y0 >= 2)) return 0;
  const fx = x < v.x0 ? v.x0 : x > v.x1 - 1 ? v.x1 - 1 : x;
  const fy = y < v.y0 ? v.y0 : y > v.y1 - 1 ? v.y1 - 1 : y;
  const x0 = Math.min(v.x1 - 2, Math.floor(fx));
  const y0 = Math.min(v.y1 - 2, Math.floor(fy));
  const ax = fx - x0;
  const ay = fy - y0;
  const w = level.width;
  const src = level.img;
  const i = y0 * w + x0;
  return (1 - ay) * ((1 - ax) * src[i]! + ax * src[i + 1]!) + ay * ((1 - ax) * src[i + w]! + ax * src[i + w + 1]!);
}

/** Scratch for [lucasKanade]: one point at a time, so one set of arrays. */
const prevWin = new Float32Array(WINDOW_CELLS);
const prevGx = new Float32Array(WINDOW_CELLS);
const prevGy = new Float32Array(WINDOW_CELLS);
const nextWin = new Float32Array(WINDOW_CELLS);
const shift = new Float64Array(2);

/**
 * One pyramid level of Lucas-Kanade (Bouguet's formulation): the shift of the window at (`px`, `py`) in
 * `prev` that best matches `next`, starting from the guess (`gx`, `gy`). Into [shift]; false where the
 * window is flat or falls off either picture.
 */
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

/**
 * Where the point (`x`, `y`) of `prev` is in `next`, through the pyramid from level `top` down, starting
 * from the guess (`guessX`, `guessY`) in full-size pixels. False where it cannot be followed at the
 * finest level. A coarser level the window does not fit is skipped, so a point near the frame's edge is
 * still followed, over a shorter reach.
 */
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

/** The normalised cross correlation of the patches round (`ax`, `ay`) in `a` and (`bx`, `by`) in `b`. */
function patchLikeness(a: Level, ax: number, ay: number, b: Level, bx: number, by: number): number {
  let sa = 0;
  let sb = 0;
  let saa = 0;
  let sbb = 0;
  let sab = 0;
  let n = 0;
  for (let dy = -PATCH_RADIUS; dy <= PATCH_RADIUS; dy++) {
    for (let dx = -PATCH_RADIUS; dx <= PATCH_RADIUS; dx++) {
      const va = sampleAt(a, ax + dx, ay + dy);
      const vb = sampleAt(b, bx + dx, by + dy);
      sa += va;
      sb += vb;
      saa += va * va;
      sbb += vb * vb;
      sab += va * vb;
      n++;
    }
  }
  const cov = sab - (sa * sb) / n;
  const va = saa - (sa * sa) / n;
  const vb = sbb - (sb * sb) / n;
  return va > 1e-6 && vb > 1e-6 ? cov / Math.sqrt(va * vb) : 0;
}

/** The middle value of `values` (the lower of the two middles for an even count); 0 for none. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1]!;
}

/** `angle` brought into -180..180. */
function wrapDegrees(angle: number): number {
  let a = angle % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a;
}

/** How the thing looked: the box resampled to a [TEMPLATE]-square grid, zero mean, unit length. */
interface Template {
  cells: Float32Array;
  /** The level it was sampled at, so a search samples the same level. */
  level: number;
}

/** The box (`cx`, `cy`, `w`, `h`) of `pyramid` as a template, or null where it is flat. */
function templateOf(pyramid: Pyramid, cx: number, cy: number, w: number, h: number): Template | null {
  const level = templateLevel(pyramid, w, h);
  const cells = new Float32Array(TEMPLATE * TEMPLATE);
  if (!sampleTemplate(pyramid.levels[level]!, level, cx, cy, w, h, cells)) return null;
  return { cells, level };
}

/** The coarsest level at which the box is still at least a template wide, so a search is cheap and unaliased. */
function templateLevel(pyramid: Pyramid, w: number, h: number): number {
  let level = 0;
  while (level + 1 < pyramid.levels.length && Math.min(w, h) / (1 << (level + 1)) >= TEMPLATE) level++;
  return level;
}

/** Samples the box into `out`, zero mean and unit length. False where it is flat. */
function sampleTemplate(level: Level, l: number, cx: number, cy: number, w: number, h: number, out: Float32Array): boolean {
  const f = 1 / (1 << l);
  const x0 = (cx - w / 2) * f;
  const y0 = (cy - h / 2) * f;
  const sx = (w * f) / TEMPLATE;
  const sy = (h * f) / TEMPLATE;
  let sum = 0;
  let k = 0;
  for (let j = 0; j < TEMPLATE; j++) {
    for (let i = 0; i < TEMPLATE; i++) {
      const v = sampleAt(level, x0 + (i + 0.5) * sx, y0 + (j + 0.5) * sy);
      out[k++] = v;
      sum += v;
    }
  }
  const mean = sum / out.length;
  let energy = 0;
  for (let i = 0; i < out.length; i++) {
    const d = out[i]! - mean;
    out[i] = d;
    energy += d * d;
  }
  if (!(energy > 1e-3 * out.length)) return false;
  const norm = 1 / Math.sqrt(energy);
  for (let i = 0; i < out.length; i++) out[i] = out[i]! * norm;
  return true;
}

const probe = new Float32Array(TEMPLATE * TEMPLATE);

/** How alike `template` is to the box (`cx`, `cy`, `w`, `h`) of `pyramid`: -1..1. */
function likeness(pyramid: Pyramid, template: Template, cx: number, cy: number, w: number, h: number): number {
  const level = pyramid.levels[template.level];
  if (!level || !sampleTemplate(level, template.level, cx, cy, w, h, probe)) return -1;
  let dot = 0;
  const t = template.cells;
  for (let i = 0; i < t.length; i++) dot += t[i]! * probe[i]!;
  return dot;
}

/** Where a search found the best match, and how alike it was. */
interface Found {
  cx: number;
  cy: number;
  scale: number;
  score: number;
}

/**
 * How much a candidate's likeness is marked down per box-width it lies from where the thing was last
 * seen. Things do not jump, and a pattern that repeats - a checked shirt, a row of windows - is as alike
 * one period over as where it really is.
 */
const DISTANCE_PENALTY = 0.04;

/**
 * The best place for any of `templates` within `radius` of (`cx`, `cy`), at each of `scales`: a coarse
 * grid first, then finer and finer round the best, down to a pixel. Ranked by likeness less
 * [DISTANCE_PENALTY]; the score answered is the likeness itself.
 */
function search(pyramid: Pyramid, templates: readonly Template[], cx: number, cy: number, w: number, h: number, radius: number, scales: readonly number[]): Found {
  const frame = pyramid.levels[0]!;
  const side = Math.max(1, Math.min(w, h));
  let best: Found = { cx, cy, scale: 1, score: -1 };
  let bestRank = -Infinity;
  const consider = (x: number, y: number, scale: number): void => {
    for (const template of templates) {
      const score = likeness(pyramid, template, x, y, w * scale, h * scale);
      const rank = score - (DISTANCE_PENALTY * Math.hypot(x - cx, y - cy)) / side;
      if (rank > bestRank) {
        bestRank = rank;
        best = { cx: x, cy: y, scale, score };
      }
    }
  };
  let step = Math.max(1, side / 6);
  for (const scale of scales) {
    for (let y = cy - radius; y <= cy + radius; y += step) {
      if (y < 0 || y >= frame.height) continue;
      for (let x = cx - radius; x <= cx + radius; x += step) {
        if (x < 0 || x >= frame.width) continue;
        consider(x, y, scale);
      }
    }
  }
  while (step > 1) {
    const finer = Math.max(1, step / 3);
    const around = best;
    for (let y = around.cy - step; y <= around.cy + step + 1e-9; y += finer) {
      for (let x = around.cx - step; x <= around.cx + step + 1e-9; x += finer) consider(x, y, around.scale);
    }
    step = finer;
  }
  return best;
}

export class ObjectTracker {
  private prev = new Pyramid();
  private next = new Pyramid();
  private levelCount = 1;
  private state: TrackerState | null = null;
  /** The start box's size, which [TrackerState.scale] is against. */
  private baseW = 0;
  private baseH = 0;
  /** The last frame's shift, the guess for this one's. */
  private vx = 0;
  private vy = 0;
  /** How the thing looked in the first frame, and when it was last seen clearly. */
  private first: Template | null = null;
  private recent: Template | null = null;
  private clearFrames = 0;
  /** Frames in a row it has been lost for. */
  private lostFor = 0;

  private readonly from = new Float64Array(2 * MAX_POINTS);
  private readonly to = new Float64Array(2 * MAX_POINTS);
  private readonly back = new Float64Array(2);

  /** Where it is now, or null before [start]. */
  get current(): TrackerState | null {
    return this.state ? { ...this.state } : null;
  }

  /**
   * Starts on `frame`, with the thing inside `box`. Answers lost - with the box as given - when the box
   * holds nothing to follow: a flat wall, a patch of sky.
   */
  start(frame: LumaFrame, box: TrackerBox): TrackerState {
    this.levelCount = levelsFor(frame.width, frame.height);
    this.prev.build(frame, this.levelCount, null);
    this.baseW = Math.max(4, box.w);
    this.baseH = Math.max(4, box.h);
    this.vx = 0;
    this.vy = 0;
    this.lostFor = 0;
    this.clearFrames = 0;
    this.first = templateOf(this.prev, box.cx, box.cy, this.baseW, this.baseH);
    this.recent = this.first;
    const seeded = this.seedInto(box.cx, box.cy, this.baseW, this.baseH, this.from);
    const lost = seeded < MIN_AGREEING;
    this.state = { cx: box.cx, cy: box.cy, w: this.baseW, h: this.baseH, scale: 1, angle: 0, confidence: lost ? 0 : 1, lost };
    if (lost) this.lostFor = 1;
    return { ...this.state };
  }

  /** Follows the thing into `frame`, the one after the last frame handed in. */
  step(frame: LumaFrame): TrackerState {
    const state = this.state;
    if (!state) throw new Error('ObjectTracker.step before start');
    // Round where the thing is about to be, or the whole frame while it is being looked for.
    this.next.build(frame, this.levelCount, this.lostFor > 0 ? null : this.aroundThing(state));
    const result = this.lostFor > 0 ? this.recover(state) : this.follow(state);
    // The frame just read is the one the next is followed from.
    const swap = this.prev;
    this.prev = this.next;
    this.next = swap;
    this.state = result;
    return { ...result };
  }

  /** One frame of median flow from `state`, or the frame lost. */
  private follow(state: TrackerState): TrackerState {
    const from = this.from;
    const to = this.to;
    const count = this.seedInto(state.cx, state.cy, state.w, state.h, from);
    if (count < MIN_AGREEING) return this.lose(state);

    const top = topLevel(this.levelCount, Math.min(state.w, state.h));
    const fb = new Float64Array(count);
    const like = new Float64Array(count);
    const ok = new Uint8Array(count);
    let followed = 0;
    for (let i = 0; i < count; i++) {
      const x = from[2 * i]!;
      const y = from[2 * i + 1]!;
      const there = to.subarray(2 * i, 2 * i + 2);
      if (!followPoint(this.prev, this.next, top, x, y, this.vx, this.vy, there)) continue;
      // And back again: a point that does not return to where it started was never really followed.
      if (!followPoint(this.next, this.prev, top, there[0]!, there[1]!, x - there[0]!, y - there[1]!, this.back)) continue;
      fb[i] = Math.hypot(this.back[0]! - x, this.back[1]! - y);
      like[i] = patchLikeness(this.prev.levels[0]!, x, y, this.next.levels[0]!, there[0]!, there[1]!);
      ok[i] = 1;
      followed++;
    }
    if (followed < MIN_AGREEING) return this.lose(state);

    // Median flow's filter: the better half by how well a point came back, and by how alike it stayed.
    const fbs: number[] = [];
    const likes: number[] = [];
    for (let i = 0; i < count; i++) {
      if (!ok[i]) continue;
      fbs.push(fb[i]!);
      likes.push(like[i]!);
    }
    const fbMedian = median(fbs);
    const likeMedian = median(likes);
    const keep: number[] = [];
    for (let i = 0; i < count; i++) if (ok[i] && fb[i]! <= fbMedian && like[i]! >= likeMedian) keep.push(i);
    const side = Math.min(state.w, state.h);
    const fbLimit = Math.max(2, 0.12 * side);
    if (keep.length < MIN_AGREEING || fbMedian > fbLimit) return this.lose(state);

    // The box's own move: how much further apart the points drifted, and how far round they turned...
    const ratios: number[] = [];
    const turns: number[] = [];
    for (let a = 0; a < keep.length; a++) {
      const i = keep[a]!;
      for (let b = a + 1; b < keep.length; b++) {
        const j = keep[b]!;
        const px = from[2 * j]! - from[2 * i]!;
        const py = from[2 * j + 1]! - from[2 * i + 1]!;
        const span = Math.hypot(px, py);
        if (span < 2) continue;
        const qx = to[2 * j]! - to[2 * i]!;
        const qy = to[2 * j + 1]! - to[2 * i + 1]!;
        ratios.push(Math.hypot(qx, qy) / span);
        turns.push(wrapDegrees(((Math.atan2(qy, qx) - Math.atan2(py, px)) * 180) / Math.PI));
      }
    }
    const grow = ratios.length > 0 ? clamp(median(ratios), 1 / MAX_STEP_SCALE, MAX_STEP_SCALE) : 1;
    const turn = turns.length > 0 ? clamp(median(turns), -MAX_STEP_TURN, MAX_STEP_TURN) : 0;

    // ... and then where the middle went, once each point's own share of that grow and turn is taken out.
    const rad = (turn * Math.PI) / 180;
    const cos = Math.cos(rad) * grow;
    const sin = Math.sin(rad) * grow;
    const tx: number[] = [];
    const ty: number[] = [];
    for (const i of keep) {
      const dx = from[2 * i]! - state.cx;
      const dy = from[2 * i + 1]! - state.cy;
      tx.push(to[2 * i]! - (state.cx + dx * cos - dy * sin));
      ty.push(to[2 * i + 1]! - (state.cy + dx * sin + dy * cos));
    }
    const mx = median(tx);
    const my = median(ty);
    const cx = state.cx + mx;
    const cy = state.cy + my;
    const frame = this.next.levels[0]!;
    if (cx < 0 || cy < 0 || cx >= frame.width || cy >= frame.height) return this.lose(state);

    this.vx = mx;
    this.vy = my;
    const scale = state.scale * grow;
    const agreeing = keep.length / count;
    const confidence = clamp(agreeing * 2 * (1 - fbMedian / fbLimit), 0, 1);
    const next: TrackerState = { cx, cy, w: this.baseW * scale, h: this.baseH * scale, scale, angle: state.angle + turn, confidence, lost: false };
    this.renew(next);
    return next;
  }

  /** Looks for the thing by its picture, over a search that widens the longer it has been gone. */
  private recover(state: TrackerState): TrackerState {
    const templates = [this.recent, this.first].filter((t): t is Template => !!t);
    if (templates.length === 0) return this.lose(state);
    const frame = this.next.levels[0]!;
    const side = Math.min(state.w, state.h);
    const radius = Math.min(Math.max(frame.width, frame.height) / 2, side * (1.5 + 0.25 * this.lostFor));
    const found = search(this.next, templates, state.cx, state.cy, state.w, state.h, radius, [0.85, 1, 1.18]);
    if (found.score < FOUND_AT) return this.lose(state);
    this.lostFor = 0;
    this.vx = 0;
    this.vy = 0;
    const scale = state.scale * found.scale;
    return { cx: found.cx, cy: found.cy, w: this.baseW * scale, h: this.baseH * scale, scale, angle: state.angle, confidence: found.score, lost: false };
  }

  /**
   * The part of the next frame worth working out: round where the thing is and where its last move would
   * take it, by its own size again and a little more on every side. That holds the windows of its points
   * at the coarsest level they are followed from, and any move a frame makes before it would be lost.
   */
  private aroundThing(state: TrackerState): Region {
    const reach = Math.max(state.w, state.h) + 32 + 2 * Math.hypot(this.vx, this.vy);
    const ax = state.cx + this.vx;
    const ay = state.cy + this.vy;
    return { x0: Math.min(state.cx, ax) - reach, y0: Math.min(state.cy, ay) - reach, x1: Math.max(state.cx, ax) + reach, y1: Math.max(state.cy, ay) + reach };
  }

  /** The frame lost: the box stays where it was, and the next frames look for the thing again. */
  private lose(state: TrackerState): TrackerState {
    this.lostFor++;
    this.vx = 0;
    this.vy = 0;
    return { ...state, confidence: 0, lost: true };
  }

  /** Renews the picture a lost thing is looked for by, from a frame it was seen clearly in. */
  private renew(state: TrackerState): void {
    if (state.confidence < RENEW_AT) return;
    this.clearFrames++;
    if (this.clearFrames % TEMPLATE_EVERY !== 0) return;
    this.recent = templateOf(this.next, state.cx, state.cy, state.w, state.h) ?? this.recent;
  }

  /**
   * Up to [MAX_POINTS] points inside the box with something to hold on to, best first, into `out` (in
   * the PREVIOUS frame): a grid over the inner part of the box, each scored by the smaller eigenvalue of
   * its structure tensor, and the flat ones left out. Answers how many.
   */
  private seedInto(cx: number, cy: number, w: number, h: number, out: Float64Array): number {
    const level = this.prev.levels[0]!;
    const iw = w * SEED_INSET;
    const ih = h * SEED_INSET;
    const across = Math.max(3, Math.min(15, Math.round(iw / 3)));
    const down = Math.max(3, Math.min(15, Math.round(ih / 3)));
    const scored: { x: number; y: number; score: number }[] = [];
    const margin = RADIUS + 2;
    for (let j = 0; j < down; j++) {
      const y = cy - ih / 2 + ((j + 0.5) * ih) / down;
      if (y < level.valid.y0 + margin || y >= level.valid.y1 - margin) continue;
      for (let i = 0; i < across; i++) {
        const x = cx - iw / 2 + ((i + 0.5) * iw) / across;
        if (x < level.valid.x0 + margin || x >= level.valid.x1 - margin) continue;
        const score = cornerScore(level, x, y);
        if (score >= MIN_EIGEN) scored.push({ x, y, score });
      }
    }
    scored.sort((a, b) => b.score - a.score);
    const count = Math.min(MAX_POINTS, scored.length);
    for (let k = 0; k < count; k++) {
      out[2 * k] = scored[k]!.x;
      out[2 * k + 1] = scored[k]!.y;
    }
    return count;
  }
}

/** The smaller eigenvalue of the structure tensor over a 7 by 7 window, per pixel: Shi and Tomasi's score. */
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

/**
 * The coarsest level a box `side` pixels across is followed from: the coarsest at which it still fills
 * most of a point's window. Any coarser and the window is mostly background, whose motion then wins the
 * coarse guess and drags every finer level after it.
 */
function topLevel(levelCount: number, side: number): number {
  let top = 0;
  while (top + 1 < levelCount && side / (1 << (top + 1)) >= 0.75 * WINDOW) top++;
  return top;
}

/** How many pyramid levels a frame gets: halved while its shorter side stays at least [MIN_LEVEL_SIDE]. */
export function levelsFor(width: number, height: number): number {
  let levels = 1;
  let side = Math.min(width, height);
  while (levels < MAX_LEVELS && side / 2 >= MIN_LEVEL_SIDE) {
    side /= 2;
    levels++;
  }
  return levels;
}

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}
