import type { FilterOp } from '../definitions';

/**
 * The colour pipeline, as pure arithmetic - the third copy of `ColorMatrix.kt` and
 * `ColorMatrix.swift`, and deliberately the same arithmetic to the constant.
 *
 * Every filter and adjust control the editor offers is a CSS Filter Effects operation, and the
 * numbers below are the ones straight out of that spec, which is what makes the preview the
 * customer taps through, the frames Media3 encodes, the frames AVFoundation encodes and the frames
 * this file encodes agree by construction rather than by eyeballing.
 *
 * Only the RGB rows matter - no operation touches alpha - so a 4x5 matrix is stored as a 3x3
 * multiply `m` plus a 3-vector offset `o`: `out = clamp(m * rgb + o, 0, 1)`.
 *
 * Known approximation, shared with both native engines: CSS clamps after EACH operation and a
 * single composed matrix clamps once at the end. The two differ only near pure white and pure
 * black, and only for op pairs that push a channel out of range and then pull it back. All three
 * engines fold to one matrix, so all three share the identical error and therefore agree with each
 * other, which is what actually matters.
 */
export interface ColorMatrix {
  /** Row-major 3x3: `m[row * 3 + col]`. */
  readonly m: readonly number[];
  readonly o: readonly number[];
}

/** Luminance weights the spec uses for `saturate` and `hue-rotate`. */
const LR = 0.213;
const LG = 0.715;
const LB = 0.072;

/** ...and the (different) ones it uses for `grayscale`, which is defined via the sRGB primaries. */
const GR = 0.2126;
const GG = 0.7152;
const GB = 0.0722;

const EPSILON = 1e-6;

export const IDENTITY: ColorMatrix = { m: [1, 0, 0, 0, 1, 0, 0, 0, 1], o: [0, 0, 0] };

export function brightness(a: number): ColorMatrix {
  return { m: [a, 0, 0, 0, a, 0, 0, 0, a], o: [0, 0, 0] };
}

export function contrast(a: number): ColorMatrix {
  const t = 0.5 - 0.5 * a;
  return { m: [a, 0, 0, 0, a, 0, 0, 0, a], o: [t, t, t] };
}

export function saturate(s: number): ColorMatrix {
  return {
    m: [
      LR + (1 - LR) * s, LG - LG * s, LB - LB * s,
      LR - LR * s, LG + (1 - LG) * s, LB - LB * s,
      LR - LR * s, LG - LG * s, LB + (1 - LB) * s,
    ],
    o: [0, 0, 0],
  };
}

/** `grayscale(a)` is `saturate(1 - a)` with the sRGB luminance weights. */
export function grayscale(a: number): ColorMatrix {
  const s = 1 - a;
  return {
    m: [
      GR + (1 - GR) * s, GG - GG * s, GB - GB * s,
      GR - GR * s, GG + (1 - GG) * s, GB - GB * s,
      GR - GR * s, GG - GG * s, GB + (1 - GB) * s,
    ],
    o: [0, 0, 0],
  };
}

export function sepia(a: number): ColorMatrix {
  const s = 1 - a;
  return {
    m: [
      0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s,
      0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s,
      0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s,
    ],
    o: [0, 0, 0],
  };
}

export function hueRotate(degrees: number): ColorMatrix {
  const rad = (degrees * Math.PI) / 180;
  const c = Math.cos(rad);
  const s = Math.sin(rad);
  return {
    m: [
      LR + 0.787 * c - LR * s, LG - LG * c - LG * s, LB - LB * c + 0.928 * s,
      LR - LR * c + 0.143 * s, LG + 0.285 * c + 0.14 * s, LB - LB * c - 0.283 * s,
      LR - LR * c - 0.787 * s, LG - LG * c + LG * s, LB + 0.928 * c + LB * s,
    ],
    o: [0, 0, 0],
  };
}

/** A `source-over` fill of `rgba(r, g, b, alpha)` - the same thing the web preview draws. */
export function tint(r: number, g: number, b: number, alpha: number): ColorMatrix {
  const keep = 1 - alpha;
  return {
    m: [keep, 0, 0, 0, keep, 0, 0, 0, keep],
    o: [(alpha * r) / 255, (alpha * g) / 255, (alpha * b) / 255],
  };
}

export function matrixFor(op: FilterOp): ColorMatrix {
  switch (op.op) {
    case 'brightness':
      return brightness(op.amount);
    case 'contrast':
      return contrast(op.amount);
    case 'saturate':
      return saturate(op.amount);
    case 'sepia':
      return sepia(op.amount);
    case 'grayscale':
      return grayscale(op.amount);
    case 'hueRotate':
      return hueRotate(op.degrees);
    case 'tint':
      return tint(op.rgb[0], op.rgb[1], op.rgb[2], op.alpha);
  }
}

/** `next` applied AFTER `prev`. */
export function compose(next: ColorMatrix, prev: ColorMatrix): ColorMatrix {
  const m = new Array<number>(9).fill(0);
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      let sum = 0;
      for (let k = 0; k < 3; k++) sum += (next.m[row * 3 + k] ?? 0) * (prev.m[k * 3 + col] ?? 0);
      m[row * 3 + col] = sum;
    }
  }
  const o = new Array<number>(3).fill(0);
  for (let row = 0; row < 3; row++) {
    let sum = next.o[row] ?? 0;
    for (let k = 0; k < 3; k++) sum += (next.m[row * 3 + k] ?? 0) * (prev.o[k] ?? 0);
    o[row] = sum;
  }
  return { m, o };
}

/** Folds the ordered list into one matrix; the first entry is applied first. */
export function fold(ops: readonly FilterOp[]): ColorMatrix {
  return ops.reduce<ColorMatrix>((acc, op) => compose(matrixFor(op), acc), IDENTITY);
}

export function isIdentity(matrix: ColorMatrix): boolean {
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) {
      const expected = row === col ? 1 : 0;
      if (Math.abs((matrix.m[row * 3 + col] ?? 0) - expected) > EPSILON) return false;
    }
    if (Math.abs(matrix.o[row] ?? 0) > EPSILON) return false;
  }
  return true;
}

/** One colour, through the matrix. Channels are 0..1 and so is the answer. */
export function apply(matrix: ColorMatrix, r: number, g: number, b: number): [number, number, number] {
  const { m, o } = matrix;
  return [
    clamp01((m[0] ?? 0) * r + (m[1] ?? 0) * g + (m[2] ?? 0) * b + (o[0] ?? 0)),
    clamp01((m[3] ?? 0) * r + (m[4] ?? 0) * g + (m[5] ?? 0) * b + (o[1] ?? 0)),
    clamp01((m[6] ?? 0) * r + (m[7] ?? 0) * g + (m[8] ?? 0) * b + (o[2] ?? 0)),
  ];
}

/**
 * GLSL `mat3` uniforms are column-major and `uniformMatrix3fv` is called with `transpose = false`,
 * so the array has to be laid out column by column - the same conversion `toGlColumnMajor` makes
 * on Android, for the same reason.
 */
export function toGlColumnMajor(matrix: ColorMatrix): Float32Array {
  const m = matrix.m;
  return new Float32Array([
    m[0] ?? 0, m[3] ?? 0, m[6] ?? 0,
    m[1] ?? 0, m[4] ?? 0, m[7] ?? 0,
    m[2] ?? 0, m[5] ?? 0, m[8] ?? 0,
  ]);
}

export function offsetVector(matrix: ColorMatrix): Float32Array {
  return new Float32Array([matrix.o[0] ?? 0, matrix.o[1] ?? 0, matrix.o[2] ?? 0]);
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}
