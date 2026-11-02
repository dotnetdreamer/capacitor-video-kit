/**
 * A box fitted round the thing under a tap: what the Track sheet's box becomes when the customer touches
 * what they want followed instead of drawing a box round it.
 *
 * Two looks at the footage, the surer first.
 *
 *  - HOW IT MOVES ([fitByMotion]), given a second frame a moment later. The points of the frame with
 *    something to hold on to are followed into it by pyramidal Lucas-Kanade; the movement of most of them
 *    is taken as one smooth field - a pan, a zoom, the sway of a hand-held phone - and the thing is the
 *    points round the tap that move together and NOT with that field: a runner against a still street, or
 *    a cyclist the camera pans with, against the street sliding past. Their bounding box, padded, is it.
 *  - HOW IT LOOKS ([fitByLooks]): otherwise - the thing stands still, or moves as everything does - the
 *    region round the tap of about its brightness, stopped by edges and held to under half the frame: a
 *    ball on grass, a sign on a wall.
 *
 * Neither is ever sure, and null is an answer: the caller meets it with a box a thumb wide round the tap,
 * which is a better start than a confident box round the wrong thing. So each look gives up at the first
 * sign it is looking at the background - the motion where the thing moves as the field does, the region
 * where it runs to its limit both ways - rather than answering with whatever it found.
 *
 * Pure arithmetic over the small grey frames a tracking run reads, worked at a quarter of their pixels or
 * fewer, so a tap costs a few milliseconds and the same answer comes out in a test as on a phone.
 */

/** A frame as a tracking run reads it: its size, and one byte of luma a pixel, row by row from the top-left. */
export interface FitFrame {
  readonly width: number;
  readonly height: number;
  readonly luma: Uint8Array;
}

/** A box on the frame, as fractions of its width and of its height: its middle and its size. */
export interface FitBox {
  cx: number;
  cy: number;
  w: number;
  h: number;
}

/**
 * The thing under (`x`, `y`) - fractions of the frame - as a box on `frame`, or null where neither look
 * finds one. `later` is the same footage a moment on (about 200 ms; a moment before works as well), for
 * the motion look; without it, or where nothing round the tap moves apart from its background, the looks
 * alone decide.
 */
export function fitBoxAt(frame: FitFrame, x: number, y: number, later?: FitFrame | null): FitBox | null {
  if (!readable(frame) || !(x >= 0 && x <= 1 && y >= 0 && y <= 1)) return null;
  if (later && readable(later) && later.width === frame.width && later.height === frame.height) {
    const moving = fitByMotion(frame, later, x, y);
    if (moving) return moving;
  }
  return fitByLooks(frame, x, y);
}

function readable(frame: FitFrame): boolean {
  return frame.width >= 8 && frame.height >= 8 && frame.luma.length >= frame.width * frame.height;
}

/* ========================================================================================= */
/* How it moves                                                                              */
/* ========================================================================================= */

/** The longer side the motion look works at: a tracking run's 512 halved, which is where most of its cost goes. */
const MOTION_EDGE = 256;

/** About how many points are followed: enough to outline a thing a tenth of the frame across, few enough to take milliseconds. */
const GRID_POINTS = 520;

/** The window a point is matched over: 7 by 7 of the worked frame, 14 by 14 of a run's. */
const RADIUS = 3;
const WINDOW = 2 * RADIUS + 1;
const CELLS = WINDOW * WINDOW;

/** Lucas-Kanade's iterations per level, and the step below which a point has arrived. */
const MAX_ITERATIONS = 10;
const ARRIVED = 0.03;

/** The coarsest a level may be on its shorter side, and the most levels: reach enough for a quick thing over 200 ms. */
const MIN_LEVEL_SIDE = 16;
const MAX_LEVELS = 4;

/**
 * The least texture a point's window may have: the smaller eigenvalue of its structure tensor, per pixel,
 * in luma levels squared per pixel squared. Below it the window is flat and fits any shift as well as any other.
 */
const MIN_EIGEN = 1;

/**
 * The most a followed window may differ from where it started, on average, in luma levels: past it, it
 * was not the same thing - most often a window the thing moved over, which matches nothing in the later
 * frame. Not much tighter: a person walking changes shape in 200 ms, and their points have to stay.
 */
const MAX_RESIDUAL = 10;

/** How near where it started, in worked pixels, a point followed into the later frame and back again has to come back to. */
const MAX_ROUND_TRIP = 1;

/** The points nearest the tap that say how the thing moves. */
const SEEDS = 5;

/** The fewest points that have to have been followed for the motion to say anything, and to make a thing. */
const MIN_POINTS = 12;
const MIN_CLUSTER = 3;

/** How far apart, in worked pixels over the two frames, the thing and its background have to move to be told apart. */
const MIN_APART = 1;

/** How near a point's move has to be to the thing's to be part of it: a share of how far apart the two moves are, at least [MIN_TOLERANCE]. */
const TOLERANCE = 0.4;
const MIN_TOLERANCE = 0.6;

/** How many grid steps apart two points of one thing may be: a flat patch a point or two across does not split it. */
const LINK = 2;

/** Each side of the box padded by half a grid step - the points stand about that far inside its edge - and this share of its size. */
const MOTION_PAD = 0.04;

/** The most of the frame a thing found by its motion may cover: more, and the "thing" is the background moving against a near foreground. */
const MAX_MOTION_AREA = 0.5;

/**
 * The thing under (`x`, `y`) by how it moves between `frame` and `later`, or null where it cannot be told
 * from its background: too little round the tap to follow, the points there not agreeing, or all of them
 * moving as the rest of the frame does.
 */
export function fitByMotion(frame: FitFrame, later: FitFrame, x: number, y: number): FitBox | null {
  const a = shrink(frame, MOTION_EDGE);
  const b = shrink(later, MOTION_EDGE);
  const count = levelCount(a.w, a.h);
  const prev = pyramid(a, count);
  const next = pyramid(b, count);
  const base = prev[0]!;
  const W = base.w;
  const H = base.h;
  // The tap in worked pixels, pixel centres on whole numbers.
  const tx = (x * frame.width) / a.factor - 0.5;
  const ty = (y * frame.height) / a.factor - 0.5;

  // Points on a grid over the whole frame - the far ones say how the background moves - each kept only
  // where it has texture, was followed into the later frame still looking like itself, and comes back to
  // where it started when it is followed back. That last is what keeps the box off the background the
  // thing moves over: a point whose window is half on that background, half on the thing's edge, goes
  // with the edge one way and cannot come back the other.
  const step = Math.max(4, Math.round(Math.sqrt((W * H) / GRID_POINTS)));
  const margin = RADIUS + 2;
  const cols = Math.floor((W - 1 - 2 * margin) / step) + 1;
  const rows = Math.floor((H - 1 - 2 * margin) / step) + 1;
  if (cols < 3 || rows < 3) return null;
  const at = new Int32Array(cols * rows).fill(-1);
  const px: number[] = [];
  const py: number[] = [];
  const fx: number[] = [];
  const fy: number[] = [];
  const col: number[] = [];
  const row: number[] = [];
  const flow = new Float64Array(2);
  const back = new Float64Array(2);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const gx = margin + c * step;
      const gy = margin + r * step;
      if (minEigenAt(base, gx, gy) < MIN_EIGEN || !follow(prev, next, gx, gy, 0, 0, flow)) continue;
      if (!follow(next, prev, gx + flow[0]!, gy + flow[1]!, -flow[0]!, -flow[1]!, back)) continue;
      if (Math.hypot(flow[0]! + back[0]!, flow[1]! + back[1]!) > MAX_ROUND_TRIP) continue;
      at[r * cols + c] = px.length;
      px.push(gx);
      py.push(gy);
      fx.push(flow[0]!);
      fy.push(flow[1]!);
      col.push(c);
      row.push(r);
    }
  }
  const n = px.length;
  if (n < MIN_POINTS) return null;

  // How the thing moves: the points nearest the tap, by their median, so one of them on the background
  // or on a hand crossing in front has no say.
  const away = new Float64Array(n);
  const near: number[] = [];
  for (let i = 0; i < n; i++) {
    away[i] = Math.hypot(px[i]! - tx, py[i]! - ty);
    near.push(i);
  }
  near.sort((i, j) => away[i]! - away[j]!);
  const reach = Math.max(2.5 * step, 0.08 * Math.min(W, H));
  const seeds = near.slice(0, SEEDS).filter(i => away[i]! <= reach);
  if (seeds.length < 3) return null;
  const mx = median(seeds.map(i => fx[i]!));
  const my = median(seeds.map(i => fy[i]!));

  // How everything else moves, as one smooth field, and whether the thing moves apart from it.
  const field = fitField(px, py, fx, fy);
  const fieldAt = (i: number): [number, number] => field.at(px[i]!, py[i]!);
  const [bx, by] = field.at(tx, ty);
  const apart = Math.hypot(mx - bx, my - by);
  if (apart < MIN_APART) return null;
  const tolerance = Math.max(MIN_TOLERANCE, TOLERANCE * apart);
  const moves = (i: number): boolean => {
    const own = Math.hypot(fx[i]! - mx, fy[i]! - my);
    if (own > tolerance) return false;
    const [ex, ey] = fieldAt(i);
    return own < Math.hypot(fx[i]! - ex, fy[i]! - ey);
  };
  const agreeing = seeds.filter(moves);
  if (agreeing.length < Math.ceil(seeds.length / 2)) return null;

  // The thing: every point moving with it that can be reached from the tap a few grid steps at a time.
  const member = new Uint8Array(n);
  const queue = [...agreeing];
  for (const i of queue) member[i] = 1;
  for (let q = 0; q < queue.length; q++) {
    const i = queue[q]!;
    for (let dr = -LINK; dr <= LINK; dr++) {
      const r = row[i]! + dr;
      if (r < 0 || r >= rows) continue;
      for (let dc = -LINK; dc <= LINK; dc++) {
        const c = col[i]! + dc;
        if (c < 0 || c >= cols) continue;
        const j = at[r * cols + c]!;
        if (j < 0 || member[j] || !moves(j)) continue;
        member[j] = 1;
        queue.push(j);
      }
    }
  }
  if (queue.length < MIN_CLUSTER) return null;

  let x0 = tx;
  let x1 = tx;
  let y0 = ty;
  let y1 = ty;
  for (const i of queue) {
    x0 = Math.min(x0, px[i]!);
    x1 = Math.max(x1, px[i]!);
    y0 = Math.min(y0, py[i]!);
    y1 = Math.max(y1, py[i]!);
  }
  const padX = 0.5 * step + MOTION_PAD * (x1 - x0);
  const padY = 0.5 * step + MOTION_PAD * (y1 - y0);
  // Pixel centres back to edges: the half pixel either side of the outermost centres.
  const left = Math.max(0, x0 - padX);
  const right = Math.min(W, x1 + 1 + padX);
  const top = Math.max(0, y0 - padY);
  const bottom = Math.min(H, y1 + 1 + padY);
  if ((right - left) * (bottom - top) > MAX_MOTION_AREA * W * H) return null;
  return boxOf(left, top, right, bottom, a.factor, frame);
}

/** How many levels a worked frame gets: halved while its shorter side stays at least [MIN_LEVEL_SIDE]. */
function levelCount(width: number, height: number): number {
  let count = 1;
  let side = Math.min(width, height);
  while (count < MAX_LEVELS && side / 2 >= MIN_LEVEL_SIDE) {
    side /= 2;
    count++;
  }
  return count;
}

/** One level of a frame's pyramid: the picture and its two gradients, which a point followed FROM it is matched by. */
interface Level {
  w: number;
  h: number;
  img: Float32Array;
  gx: Float32Array;
  gy: Float32Array;
}

function pyramid(plane: Plane, count: number): Level[] {
  const levels: Level[] = [];
  let img = plane.img;
  let w = plane.w;
  let h = plane.h;
  for (let l = 0; l < count; l++) {
    const level = gradientsOf(w, h, img);
    levels.push(level);
    if (l + 1 === count) break;
    const down = halve(img, w, h);
    img = down.img;
    w = down.w;
    h = down.h;
  }
  return levels;
}

/** The next level down: a [1 2 1] blur both ways, then every other pixel, the edges replicated. */
function halve(src: Float32Array, w: number, h: number): { img: Float32Array; w: number; h: number } {
  const hw = Math.max(1, w >> 1);
  const hh = Math.max(1, h >> 1);
  const out = new Float32Array(hw * hh);
  for (let y = 0; y < hh; y++) {
    const c = 2 * y;
    const up = Math.max(0, c - 1) * w;
    const mid = c * w;
    const down = Math.min(h - 1, c + 1) * w;
    for (let x = 0; x < hw; x++) {
      const m = 2 * x;
      const l = Math.max(0, m - 1);
      const r = Math.min(w - 1, m + 1);
      out[y * hw + x] =
        (src[up + l]! + 2 * src[up + m]! + src[up + r]! + 2 * (src[mid + l]! + 2 * src[mid + m]! + src[mid + r]!) + src[down + l]! + 2 * src[down + m]! + src[down + r]!) / 16;
    }
  }
  return { img: out, w: hw, h: hh };
}

/** A level of `img`, with its central differences across and down, in luma levels a pixel, the edges replicated. */
function gradientsOf(w: number, h: number, img: Float32Array): Level {
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const up = Math.max(0, y - 1) * w;
    const mid = y * w;
    const down = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      gx[mid + x] = (img[mid + Math.min(w - 1, x + 1)]! - img[mid + Math.max(0, x - 1)]!) * 0.5;
      gy[mid + x] = (img[down + x]! - img[up + x]!) * 0.5;
    }
  }
  return { w, h, img, gx, gy };
}

/** The smaller eigenvalue of the structure tensor over the window round whole pixel (`x`, `y`), per pixel: Shi and Tomasi's score. */
function minEigenAt(level: Level, x: number, y: number): number {
  let a = 0;
  let b = 0;
  let c = 0;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    let i = (y + dy) * level.w + x - RADIUS;
    for (let dx = -RADIUS; dx <= RADIUS; dx++, i++) {
      const gx = level.gx[i]!;
      const gy = level.gy[i]!;
      a += gx * gx;
      b += gx * gy;
      c += gy * gy;
    }
  }
  return (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / (2 * CELLS);
}

/** Scratch for [lucasKanade]: one point at a time, so one set. */
const iWin = new Float32Array(CELLS);
const xWin = new Float32Array(CELLS);
const yWin = new Float32Array(CELLS);
const jWin = new Float32Array(CELLS);
const shift = new Float64Array(2);
/** How far the last window followed differed from where it started, on average: see [MAX_RESIDUAL]. */
let residual = 0;

/**
 * The window of `src` - one of `level`'s arrays - centred on (`x`, `y`), bilinearly, into `out`; false
 * where any of it falls off the level.
 */
function sample(src: Float32Array, level: Level, x: number, y: number, out: Float32Array): boolean {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const w = level.w;
  if (!(x0 - RADIUS >= 0 && y0 - RADIUS >= 0 && x0 + RADIUS + 1 < w && y0 + RADIUS + 1 < level.h)) return false;
  const ax = x - x0;
  const ay = y - y0;
  const w00 = (1 - ax) * (1 - ay);
  const w10 = ax * (1 - ay);
  const w01 = (1 - ax) * ay;
  const w11 = ax * ay;
  let k = 0;
  for (let dy = -RADIUS; dy <= RADIUS; dy++) {
    let i = (y0 + dy) * w + x0 - RADIUS;
    for (let dx = -RADIUS; dx <= RADIUS; dx++, i++) out[k++] = w00 * src[i]! + w10 * src[i + 1]! + w01 * src[i + w]! + w11 * src[i + w + 1]!;
  }
  return true;
}

/**
 * One level of Lucas-Kanade (Bouguet's formulation): the shift of the window at (`px`, `py`) of `prev`
 * that best matches `next`, from the guess (`gx`, `gy`). Into [shift], and how well it matched into
 * [residual]; false where the window is flat or falls off either picture.
 */
function lucasKanade(prev: Level, next: Level, px: number, py: number, gx: number, gy: number): boolean {
  if (!sample(prev.img, prev, px, py, iWin)) return false;
  sample(prev.gx, prev, px, py, xWin);
  sample(prev.gy, prev, px, py, yWin);
  let a = 0;
  let b = 0;
  let c = 0;
  for (let k = 0; k < CELLS; k++) {
    const x = xWin[k]!;
    const y = yWin[k]!;
    a += x * x;
    b += x * y;
    c += y * y;
  }
  const det = a * c - b * b;
  const minEigen = (a + c - Math.sqrt((a - c) * (a - c) + 4 * b * b)) / (2 * CELLS);
  if (!(minEigen >= MIN_EIGEN) || !(det > 0)) return false;
  let vx = 0;
  let vy = 0;
  for (let it = 0; it < MAX_ITERATIONS; it++) {
    if (!sample(next.img, next, px + gx + vx, py + gy + vy, jWin)) return false;
    let bx = 0;
    let by = 0;
    let sad = 0;
    for (let k = 0; k < CELLS; k++) {
      const d = iWin[k]! - jWin[k]!;
      bx += d * xWin[k]!;
      by += d * yWin[k]!;
      sad += d < 0 ? -d : d;
    }
    residual = sad / CELLS;
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
 * How point (`x`, `y`) of `prev` moved into `next`, through the pyramid from its coarsest level, starting
 * from the guess (`guessX`, `guessY`) in finest-level pixels, into `out`. False where it could not be
 * followed at the finest level, or came out looking unlike itself. A coarser level the window does not
 * fit, or is flat at, is passed over with the guess kept.
 */
function follow(prev: Level[], next: Level[], x: number, y: number, guessX: number, guessY: number, out: Float64Array): boolean {
  const top = prev.length - 1;
  let gx = guessX / (1 << top);
  let gy = guessY / (1 << top);
  for (let l = top; l >= 0; l--) {
    const f = 1 / (1 << l);
    let dx = 0;
    let dy = 0;
    if (lucasKanade(prev[l]!, next[l]!, x * f, y * f, gx, gy)) {
      dx = shift[0]!;
      dy = shift[1]!;
    } else if (l === 0) {
      return false;
    }
    if (l > 0) {
      gx = 2 * (gx + dx);
      gy = 2 * (gy + dy);
    } else {
      out[0] = gx + dx;
      out[1] = gy + dy;
    }
  }
  return residual <= MAX_RESIDUAL;
}

/** A move over the whole frame, worked out from the points that make it: where a point at (`x`, `y`) went. */
interface Field {
  at(x: number, y: number): [number, number];
}

/**
 * The frame's own movement, as one affine field - a pan, a zoom, a turn and the lean of a hand-held phone
 * are all affine to within a pixel over 200 ms - fitted to every point, then twice more to the half of
 * them it fitted best, so a thing that moves against it, up to about half of the points, drops out of
 * its own background's fit. Falls back to the median move where the points are too few or in a line.
 */
function fitField(px: readonly number[], py: readonly number[], fx: readonly number[], fy: readonly number[]): Field {
  const n = px.length;
  let use: number[] = [];
  for (let i = 0; i < n; i++) use.push(i);
  const still: Field = { at: () => [median(fx), median(fy)] };
  let field: Field | null = null;
  for (let round = 0; round < 3; round++) {
    const fitted = affine(px, py, fx, fy, use);
    if (!fitted) return field ?? still;
    field = fitted;
    if (round === 2) break;
    const misses = use.map(i => {
      const [ex, ey] = fitted.at(px[i]!, py[i]!);
      return Math.hypot(fx[i]! - ex, fy[i]! - ey);
    });
    const cut = median(misses);
    const kept = use.filter((_, k) => misses[k]! <= cut);
    if (kept.length < 6) break;
    use = kept;
  }
  return field ?? still;
}

/** The least-squares affine move of points `use`, about their own middle; null for too few points, or points in a line. */
function affine(px: readonly number[], py: readonly number[], fx: readonly number[], fy: readonly number[], use: readonly number[]): Field | null {
  if (use.length < 6) return null;
  let ox = 0;
  let oy = 0;
  for (const i of use) {
    ox += px[i]!;
    oy += py[i]!;
  }
  ox /= use.length;
  oy /= use.length;
  // The normal equations of [1, dx, dy] against each channel; with the middle taken out, the first row is (n, 0, 0).
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  let u0 = 0;
  let ux = 0;
  let uy = 0;
  let v0 = 0;
  let vx = 0;
  let vy = 0;
  for (const i of use) {
    const dx = px[i]! - ox;
    const dy = py[i]! - oy;
    sxx += dx * dx;
    sxy += dx * dy;
    syy += dy * dy;
    u0 += fx[i]!;
    ux += fx[i]! * dx;
    uy += fx[i]! * dy;
    v0 += fy[i]!;
    vx += fy[i]! * dx;
    vy += fy[i]! * dy;
  }
  const det = sxx * syy - sxy * sxy;
  if (!(det > 1e-6 * Math.max(1, sxx * syy))) return null;
  const n = use.length;
  const a0 = u0 / n;
  const a1 = (ux * syy - uy * sxy) / det;
  const a2 = (uy * sxx - ux * sxy) / det;
  const b0 = v0 / n;
  const b1 = (vx * syy - vy * sxy) / det;
  const b2 = (vy * sxx - vx * sxy) / det;
  return { at: (x, y) => [a0 + a1 * (x - ox) + a2 * (y - oy), b0 + b1 * (x - ox) + b2 * (y - oy)] };
}

/* ========================================================================================= */
/* How it looks                                                                              */
/* ========================================================================================= */

/** The longer side the looks are worked at: a thing a thumb wide is a dozen of its pixels across, and noise is averaged away. */
const LOOK_EDGE = 128;

/** The most of the frame's width, and of its height, a region may take: one that wants more is the background. */
const MAX_REGION = 0.45;

/** The fewest pixels a region may have, and the least of its box it may fill: less is a speck, or a crack it ran along. */
const MIN_REGION = 12;
const MIN_FILL = 0.12;

/** Each side of a region's box padded by this share of its size: the edge it stopped at is the thing's own. */
const LOOK_PAD = 0.08;

/** A pixel is an edge, which stops a region, where it is at least this steep - luma levels a pixel, across and down added - ... */
const EDGE_FLOOR = 6;
/** ... and at least this many times as steep as most of the frame is (its 60th percentile), so texture all over does not stop it everywhere. */
const EDGE_SHARE = 2;

/** How near the region's brightness a pixel has to be, in luma levels: this much, and [SIMILAR_SPREAD] times how much the tapped spot itself varies. */
const SIMILAR_FLOOR = 10;
const SIMILAR_SPREAD = 2.5;
const MAX_SIMILAR = 40;

/**
 * The thing under (`x`, `y`) by how it looks: the region round the tap of about the brightness there,
 * grown a pixel at a time and stopped by edges, held to [MAX_REGION] of the frame either way. Null for a
 * speck, a crack, and a region that ran to its limit both ways - a wall, the sky - which is no thing at all.
 */
export function fitByLooks(frame: FitFrame, x: number, y: number): FitBox | null {
  const plane = shrink(frame, LOOK_EDGE);
  const { w, h, img } = plane;
  if (w < 4 || h < 4) return null;

  // How steep each pixel is, and how steep a pixel has to be to stop the region: from the frame's own
  // spread, read off a histogram rather than a sort.
  const steep = new Float32Array(w * h);
  const counts = new Uint32Array(256);
  for (let yy = 0; yy < h; yy++) {
    const up = Math.max(0, yy - 1) * w;
    const mid = yy * w;
    const down = Math.min(h - 1, yy + 1) * w;
    for (let xx = 0; xx < w; xx++) {
      const g = Math.abs(img[mid + Math.min(w - 1, xx + 1)]! - img[mid + Math.max(0, xx - 1)]!) * 0.5 + Math.abs(img[down + xx]! - img[up + xx]!) * 0.5;
      steep[mid + xx] = g;
      counts[Math.min(255, Math.floor(g))]!++;
    }
  }
  let seen = 0;
  let typical = 0;
  for (; typical < 255; typical++) {
    seen += counts[typical]!;
    if (seen >= 0.6 * w * h) break;
  }
  const edge = Math.max(EDGE_FLOOR, EDGE_SHARE * (typical + 1));

  // The seed: the tapped pixel, or the flattest one beside it where the finger landed on an edge.
  const tx = Math.min(w - 1, Math.max(0, Math.floor((x * frame.width) / plane.factor)));
  const ty = Math.min(h - 1, Math.max(0, Math.floor((y * frame.height) / plane.factor)));
  let seed = ty * w + tx;
  if (steep[seed]! >= edge) {
    seed = -1;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const sx = tx + dx;
        const sy = ty + dy;
        if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
        const i = sy * w + sx;
        if (steep[i]! < edge && (seed < 0 || steep[i]! < steep[seed]!)) seed = i;
      }
    }
  }
  if (seed < 0) return null;

  // How far from the region's brightness a pixel may be: by how much the spot under the finger varies.
  let sum = 0;
  let sumSq = 0;
  let spot = 0;
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      const sx = (seed % w) + dx;
      const sy = Math.floor(seed / w) + dy;
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      const v = img[sy * w + sx]!;
      sum += v;
      sumSq += v * v;
      spot++;
    }
  }
  const spread = Math.sqrt(Math.max(0, sumSq / spot - (sum / spot) ** 2));
  const similar = Math.min(MAX_SIMILAR, SIMILAR_FLOOR + SIMILAR_SPREAD * spread);
  const seedLevel = img[seed]!;

  const maxW = Math.max(2, Math.round(MAX_REGION * w));
  const maxH = Math.max(2, Math.round(MAX_REGION * h));
  const taken = new Uint8Array(w * h);
  const queue = new Int32Array(w * h);
  let head = 0;
  let tail = 0;
  queue[tail++] = seed;
  taken[seed] = 1;
  let x0 = seed % w;
  let x1 = x0;
  let y0 = Math.floor(seed / w);
  let y1 = y0;
  let total = seedLevel;
  let cappedX = false;
  let cappedY = false;
  while (head < tail) {
    const i = queue[head++]!;
    const ix = i % w;
    const iy = (i - ix) / w;
    for (let k = 0; k < 4; k++) {
      const nx = k === 0 ? ix - 1 : k === 1 ? ix + 1 : ix;
      const ny = k === 2 ? iy - 1 : k === 3 ? iy + 1 : iy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      const j = ny * w + nx;
      if (taken[j] || steep[j]! >= edge) continue;
      const v = img[j]!;
      // Near the region as it has grown, and never far from where it started, so a slow shading cannot carry it off.
      if (Math.abs(v - total / tail) > similar || Math.abs(v - seedLevel) > 1.5 * similar) continue;
      if (Math.max(x1, nx) - Math.min(x0, nx) + 1 > maxW) {
        cappedX = true;
        continue;
      }
      if (Math.max(y1, ny) - Math.min(y0, ny) + 1 > maxH) {
        cappedY = true;
        continue;
      }
      taken[j] = 1;
      queue[tail++] = j;
      total += v;
      if (nx < x0) x0 = nx;
      if (nx > x1) x1 = nx;
      if (ny < y0) y0 = ny;
      if (ny > y1) y1 = ny;
    }
  }
  if (tail < MIN_REGION || tail < MIN_FILL * (x1 - x0 + 1) * (y1 - y0 + 1) || (cappedX && cappedY)) return null;
  // The region stops a pixel short of its edge, where the pixel beside the edge is already steep: that
  // pixel is the thing's too, and goes back on each side before the padding.
  const left = x0 - 1;
  const right = x1 + 2;
  const top = y0 - 1;
  const bottom = y1 + 2;
  const padX = LOOK_PAD * (right - left);
  const padY = LOOK_PAD * (bottom - top);
  return boxOf(Math.max(0, left - padX), Math.max(0, top - padY), Math.min(w, right + padX), Math.min(h, bottom + padY), plane.factor, frame);
}

/* ========================================================================================= */
/* Shared                                                                                    */
/* ========================================================================================= */

/** A frame worked on: floats, each pixel the average of `factor` by `factor` of the frame's. */
interface Plane {
  w: number;
  h: number;
  img: Float32Array;
  factor: number;
}

/** `frame` averaged down by a whole factor until its longer side is about `edge`. */
function shrink(frame: FitFrame, edge: number): Plane {
  const factor = Math.max(1, Math.round(Math.max(frame.width, frame.height) / edge));
  const w = Math.max(1, Math.floor(frame.width / factor));
  const h = Math.max(1, Math.floor(frame.height / factor));
  const img = new Float32Array(w * h);
  const src = frame.luma;
  const stride = frame.width;
  const k = 1 / (factor * factor);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let j = 0; j < factor; j++) {
        let i = (y * factor + j) * stride + x * factor;
        for (let m = 0; m < factor; m++) sum += src[i++]!;
      }
      img[y * w + x] = sum * k;
    }
  }
  return { w, h, img, factor };
}

/** The box with edges `left`..`right` and `top`..`bottom` in a plane's pixels, as fractions of the frame it was worked from. */
function boxOf(left: number, top: number, right: number, bottom: number, factor: number, frame: FitFrame): FitBox | null {
  const w = ((right - left) * factor) / frame.width;
  const h = ((bottom - top) * factor) / frame.height;
  if (!(w > 0) || !(h > 0)) return null;
  return { cx: (((left + right) / 2) * factor) / frame.width, cy: (((top + bottom) / 2) * factor) / frame.height, w, h };
}

/** The middle value of `values` (the lower of the two middles for an even count); 0 for none. */
function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[(sorted.length - 1) >> 1]!;
}
