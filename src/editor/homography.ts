/**
 * Plane-to-plane maps in perspective: what a flat surface does to a picture laid on it as a camera sees
 * it. The arithmetic the plane tracker finds a surface with (`plane-tracker.ts`) and the surface pin draws
 * a layer on one with (`surface.ts`), kept in one place so the two can never mean different things.
 *
 * A homography is nine numbers, row by row: (x, y) goes to ((h0 x + h1 y + h2) / w, (h3 x + h4 y + h5) / w)
 * with w = h6 x + h7 y + h8. Corners are eight numbers - x0, y0, x1, y1, x2, y2, x3, y3 - in a picture's
 * own order: top-left, top-right, bottom-right, bottom-left.
 */

/** Nine numbers, row by row; see the file's comment. */
export type Homography = number[];

export const IDENTITY_H: readonly number[] = Object.freeze([1, 0, 0, 0, 1, 0, 0, 0, 1]);

/**
 * The map that takes the unit square's corners - (0, 0), (1, 0), (1, 1), (0, 1) - onto `corners`, in that
 * order (Heckbert's square-to-quad). Null where three of the corners are in one line, which no flat surface
 * seen by a camera is.
 */
export function squareToQuad(corners: ArrayLike<number>): Homography | null {
  const x0 = corners[0]!;
  const y0 = corners[1]!;
  const x1 = corners[2]!;
  const y1 = corners[3]!;
  const x2 = corners[4]!;
  const y2 = corners[5]!;
  const x3 = corners[6]!;
  const y3 = corners[7]!;
  const sx = x0 - x1 + x2 - x3;
  const sy = y0 - y1 + y2 - y3;
  const dx1 = x1 - x2;
  const dx2 = x3 - x2;
  const dy1 = y1 - y2;
  const dy2 = y3 - y2;
  const den = dx1 * dy2 - dx2 * dy1;
  const scale = Math.abs(dx1 * dy2) + Math.abs(dx2 * dy1);
  if (!(Math.abs(den) > 1e-12 * Math.max(1e-300, scale))) return null;
  // A parallelogram is an affine map: no perspective terms, which the general case would round to dust.
  const g = sx === 0 && sy === 0 ? 0 : (sx * dy2 - dx2 * sy) / den;
  const h = sx === 0 && sy === 0 ? 0 : (dx1 * sy - sx * dy1) / den;
  const out = [x1 - x0 + g * x1, x3 - x0 + h * x3, x0, y1 - y0 + g * y1, y3 - y0 + h * y3, y0, g, h, 1];
  return out.every(Number.isFinite) ? out : null;
}

/** The map undone, or null where it has no inverse. */
export function invertH(m: ArrayLike<number>): Homography | null {
  const a = m[0]!;
  const b = m[1]!;
  const c = m[2]!;
  const d = m[3]!;
  const e = m[4]!;
  const f = m[5]!;
  const g = m[6]!;
  const h = m[7]!;
  const i = m[8]!;
  const A = e * i - f * h;
  const B = -(d * i - f * g);
  const C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (!(Math.abs(det) > 1e-300) || !Number.isFinite(det)) return null;
  const k = 1 / det;
  return [
    A * k,
    -(b * i - c * h) * k,
    (b * f - c * e) * k,
    B * k,
    (a * i - c * g) * k,
    -(a * f - c * d) * k,
    C * k,
    -(a * h - b * g) * k,
    (a * e - b * d) * k,
  ];
}

/** `a` after `b`: a point goes through `b` first. */
export function multiplyH(a: ArrayLike<number>, b: ArrayLike<number>): Homography {
  const out = new Array<number>(9);
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) out[r * 3 + c] = a[r * 3]! * b[c]! + a[r * 3 + 1]! * b[3 + c]! + a[r * 3 + 2]! * b[6 + c]!;
  }
  return out;
}

/** Where `h` takes (`x`, `y`); NaN where the point goes off to infinity. */
export function applyH(h: ArrayLike<number>, x: number, y: number): { x: number; y: number } {
  const w = h[6]! * x + h[7]! * y + h[8]!;
  if (w === 0) return { x: NaN, y: NaN };
  return { x: (h[0]! * x + h[1]! * y + h[2]!) / w, y: (h[3]! * x + h[4]! * y + h[5]!) / w };
}

/** `corners` (eight numbers) through `h`. */
export function mapCorners(h: ArrayLike<number>, corners: ArrayLike<number>): number[] {
  const out = new Array<number>(8);
  for (let k = 0; k < 4; k++) {
    const p = applyH(h, corners[2 * k]!, corners[2 * k + 1]!);
    out[2 * k] = p.x;
    out[2 * k + 1] = p.y;
  }
  return out;
}

/** The map that takes the four points `from` onto the four points `to`, pair by pair; null for a degenerate four. */
export function fourPointH(from: ArrayLike<number>, to: ArrayLike<number>): Homography | null {
  const a = squareToQuad(from);
  const b = squareToQuad(to);
  const back = a ? invertH(a) : null;
  return back && b ? multiplyH(b, back) : null;
}

/** The quad's signed area, positive for corners that go round clockwise on a y-down frame. */
export function quadArea(c: ArrayLike<number>): number {
  let sum = 0;
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    sum += c[2 * k]! * c[2 * j + 1]! - c[2 * j]! * c[2 * k + 1]!;
  }
  return sum / 2;
}

/** Whether the quad is convex and goes round the way its area's sign says, every corner turning the same way. */
export function isConvexQuad(c: ArrayLike<number>): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = c[2 * k]!;
    const ay = c[2 * k + 1]!;
    const bx = c[(2 * k + 2) % 8]!;
    const by = c[(2 * k + 3) % 8]!;
    const cx = c[(2 * k + 4) % 8]!;
    const cy = c[(2 * k + 5) % 8]!;
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (!Number.isFinite(cross) || cross === 0) return false;
    const s = cross > 0 ? 1 : -1;
    if (sign !== 0 && s !== sign) return false;
    sign = s;
  }
  return true;
}

/** Where the quad's two diagonals cross: the middle of the surface as the camera sees it. Null for a quad with no crossing. */
export function quadMiddle(c: ArrayLike<number>): { x: number; y: number } | null {
  const x0 = c[0]!;
  const y0 = c[1]!;
  const ux = c[4]! - x0;
  const uy = c[5]! - y0;
  const x1 = c[2]!;
  const y1 = c[3]!;
  const vx = c[6]! - x1;
  const vy = c[7]! - y1;
  const den = ux * vy - uy * vx;
  if (!(Math.abs(den) > 1e-12)) return null;
  const t = ((x1 - x0) * vy - (y1 - y0) * vx) / den;
  return { x: x0 + ux * t, y: y0 + uy * t };
}

/**
 * The homography that best takes `from` onto `to` over the pairs `index[0 .. count)`, in least squares:
 * the normalised direct linear transform (Hartley), then a few Gauss-Newton steps on the distance in `to`'s
 * own units. Null for fewer than four pairs or a set the transform cannot be found from.
 */
export function fitH(
  fromX: ArrayLike<number>,
  fromY: ArrayLike<number>,
  toX: ArrayLike<number>,
  toY: ArrayLike<number>,
  index: ArrayLike<number>,
  count: number,
  guess: ArrayLike<number> | null = null,
): Homography | null {
  if (count < 4) return null;
  const nf = normaliser(fromX, fromY, index, count);
  const nt = normaliser(toX, toY, index, count);
  if (!nf || !nt) return null;
  let h: number[] | null = null;
  // A guess in pixels, taken into the normalised frames, is where the fit starts from.
  if (guess) h = multiplyH(nt.to, multiplyH(guess, nf.back));
  if (!h) {
    // A^T A of the DLT's rows, and its eigenvector of the least eigenvalue.
    const ata = new Float64Array(81);
    const row = new Float64Array(9);
    for (let k = 0; k < count; k++) {
      const i = index[k]!;
      const x = (fromX[i]! - nf.cx) * nf.s;
      const y = (fromY[i]! - nf.cy) * nf.s;
      const u = (toX[i]! - nt.cx) * nt.s;
      const v = (toY[i]! - nt.cy) * nt.s;
      row.set([-x, -y, -1, 0, 0, 0, u * x, u * y, u]);
      addOuter(ata, row);
      row.set([0, 0, 0, -x, -y, -1, v * x, v * y, v]);
      addOuter(ata, row);
    }
    h = smallestEigenvector(ata);
    if (!h) return null;
  }
  h = refine(h, fromX, fromY, toX, toY, index, count, nf, nt) ?? h;
  // Back to pixels: T_to^-1 * h * T_from.
  const out = multiplyH(nt.back, multiplyH(h, nf.to));
  const s = out[8]!;
  if (!(Math.abs(s) > 1e-300)) return null;
  for (let k = 0; k < 9; k++) out[k] = out[k]! / s;
  return out.every(Number.isFinite) ? out : null;
}

interface Normaliser {
  cx: number;
  cy: number;
  s: number;
  /** Pixels to normalised, and back. */
  to: number[];
  back: number[];
}

/** Hartley's normalisation of the points: their centroid to the origin, their mean distance to sqrt(2). */
function normaliser(xs: ArrayLike<number>, ys: ArrayLike<number>, index: ArrayLike<number>, count: number): Normaliser | null {
  let cx = 0;
  let cy = 0;
  for (let k = 0; k < count; k++) {
    cx += xs[index[k]!]!;
    cy += ys[index[k]!]!;
  }
  cx /= count;
  cy /= count;
  let d = 0;
  for (let k = 0; k < count; k++) d += Math.hypot(xs[index[k]!]! - cx, ys[index[k]!]! - cy);
  d /= count;
  if (!(d > 1e-9)) return null;
  const s = Math.SQRT2 / d;
  return { cx, cy, s, to: [s, 0, -s * cx, 0, s, -s * cy, 0, 0, 1], back: [1 / s, 0, cx, 0, 1 / s, cy, 0, 0, 1] };
}

function addOuter(m: Float64Array, row: Float64Array): void {
  for (let r = 0; r < 9; r++) {
    const a = row[r]!;
    if (a === 0) continue;
    for (let c = r; c < 9; c++) m[r * 9 + c] = m[r * 9 + c]! + a * row[c]!;
  }
}

/** The unit eigenvector of the least eigenvalue of the symmetric 9 by 9 `m` (its upper triangle), by Jacobi's rotations. */
function smallestEigenvector(upper: Float64Array): number[] | null {
  const n = 9;
  const a = new Float64Array(81);
  for (let r = 0; r < n; r++) {
    for (let c = r; c < n; c++) {
      a[r * n + c] = upper[r * n + c]!;
      a[c * n + r] = upper[r * n + c]!;
    }
  }
  const v = new Float64Array(81);
  for (let i = 0; i < n; i++) v[i * n + i] = 1;
  for (let sweep = 0; sweep < 30; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += a[p * n + q]! * a[p * n + q]!;
    if (off < 1e-22) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        const apq = a[p * n + q]!;
        if (Math.abs(apq) < 1e-300) continue;
        const app = a[p * n + p]!;
        const aqq = a[q * n + q]!;
        const theta = (aqq - app) / (2 * apq);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1));
        const c = 1 / Math.sqrt(t * t + 1);
        const s = t * c;
        for (let k = 0; k < n; k++) {
          const akp = a[k * n + p]!;
          const akq = a[k * n + q]!;
          a[k * n + p] = c * akp - s * akq;
          a[k * n + q] = s * akp + c * akq;
        }
        for (let k = 0; k < n; k++) {
          const apk = a[p * n + k]!;
          const aqk = a[q * n + k]!;
          a[p * n + k] = c * apk - s * aqk;
          a[q * n + k] = s * apk + c * aqk;
        }
        for (let k = 0; k < n; k++) {
          const vkp = v[k * n + p]!;
          const vkq = v[k * n + q]!;
          v[k * n + p] = c * vkp - s * vkq;
          v[k * n + q] = s * vkp + c * vkq;
        }
      }
    }
  }
  let best = 0;
  for (let i = 1; i < n; i++) if (a[i * n + i]! < a[best * n + best]!) best = i;
  const out = new Array<number>(n);
  for (let k = 0; k < n; k++) out[k] = v[k * n + best]!;
  return out.every(Number.isFinite) ? out : null;
}

/**
 * A few Gauss-Newton steps on the distance between where `h` (normalised) takes each point and where it
 * went, with h8 held at 1. Null where a step will not solve; the caller keeps what it had.
 */
function refine(
  start: number[],
  fromX: ArrayLike<number>,
  fromY: ArrayLike<number>,
  toX: ArrayLike<number>,
  toY: ArrayLike<number>,
  index: ArrayLike<number>,
  count: number,
  nf: Normaliser,
  nt: Normaliser,
): number[] | null {
  if (!(Math.abs(start[8]!) > 1e-9)) return null;
  let h = start.map(v => v / start[8]!);
  const jtj = new Float64Array(64);
  const jtr = new Float64Array(8);
  const jx = new Float64Array(8);
  const jy = new Float64Array(8);
  for (let step = 0; step < 4; step++) {
    jtj.fill(0);
    jtr.fill(0);
    for (let k = 0; k < count; k++) {
      const i = index[k]!;
      const x = (fromX[i]! - nf.cx) * nf.s;
      const y = (fromY[i]! - nf.cy) * nf.s;
      const u = (toX[i]! - nt.cx) * nt.s;
      const v = (toY[i]! - nt.cy) * nt.s;
      const w = h[6]! * x + h[7]! * y + 1;
      if (!(Math.abs(w) > 1e-9)) return null;
      const px = (h[0]! * x + h[1]! * y + h[2]!) / w;
      const py = (h[3]! * x + h[4]! * y + h[5]!) / w;
      jx.set([x / w, y / w, 1 / w, 0, 0, 0, (-x * px) / w, (-y * px) / w]);
      jy.set([0, 0, 0, x / w, y / w, 1 / w, (-x * py) / w, (-y * py) / w]);
      const rx = u - px;
      const ry = v - py;
      for (let r = 0; r < 8; r++) {
        jtr[r] = jtr[r]! + jx[r]! * rx + jy[r]! * ry;
        for (let c = 0; c < 8; c++) jtj[r * 8 + c] = jtj[r * 8 + c]! + jx[r]! * jx[c]! + jy[r]! * jy[c]!;
      }
    }
    for (let r = 0; r < 8; r++) jtj[r * 9] = jtj[r * 9]! * (1 + 1e-6) + 1e-12;
    const delta = solve(jtj, jtr, 8);
    if (!delta) return null;
    let size = 0;
    for (let r = 0; r < 8; r++) {
      h[r] = h[r]! + delta[r]!;
      size += delta[r]! * delta[r]!;
    }
    if (size < 1e-20) break;
  }
  h[8] = 1;
  return h.every(Number.isFinite) ? h : null;
}

/** `m x = b` for an `n` by `n` system, by elimination with partial pivoting; null for a singular one. */
export function solve(m: ArrayLike<number>, b: ArrayLike<number>, n: number): number[] | null {
  const a = Float64Array.from(m as ArrayLike<number>);
  const x = Float64Array.from(b as ArrayLike<number>);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r * n + col]!) > Math.abs(a[pivot * n + col]!)) pivot = r;
    const p = a[pivot * n + col]!;
    if (!(Math.abs(p) > 1e-300)) return null;
    if (pivot !== col) {
      for (let c = 0; c < n; c++) {
        const t = a[col * n + c]!;
        a[col * n + c] = a[pivot * n + c]!;
        a[pivot * n + c] = t;
      }
      const t = x[col]!;
      x[col] = x[pivot]!;
      x[pivot] = t;
    }
    for (let r = col + 1; r < n; r++) {
      const f = a[r * n + col]! / p;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r * n + c] = a[r * n + c]! - f * a[col * n + c]!;
      x[r] = x[r]! - f * x[col]!;
    }
  }
  const out = new Array<number>(n);
  for (let r = n - 1; r >= 0; r--) {
    let s = x[r]!;
    for (let c = r + 1; c < n; c++) s -= a[r * n + c]! * out[c]!;
    out[r] = s / a[r * n + r]!;
  }
  return out.every(Number.isFinite) ? out : null;
}
