import { describe, expect, it } from 'vitest';

import type { FilterOp } from '../definitions';

import { apply, fold, grayscale, isIdentity, matrixFor, saturate, toGlColumnMajor } from './color-matrix';

/**
 * The web engine's copy of the colour maths, checked against the CSS Filter Effects spec's own
 * numbers rather than against the Kotlin - because agreeing with the Kotlin is only worth anything
 * if both agree with the spec, and this is the copy a browser runs.
 */
describe('colour matrix', () => {
  it('leaves a colour alone when there is nothing to do', () => {
    expect(isIdentity(fold([]))).toBe(true);
    const [r, g, b] = apply(fold([]), 0.25, 0.5, 0.75);
    expect(r).toBeCloseTo(0.25, 6);
    expect(g).toBeCloseTo(0.5, 6);
    expect(b).toBeCloseTo(0.75, 6);
  });

  it('brightness scales every channel and clamps at white', () => {
    const [r, g, b] = apply(matrixFor({ op: 'brightness', amount: 2 }), 0.25, 0.4, 0.6);
    expect(r).toBeCloseTo(0.5, 6);
    expect(g).toBeCloseTo(0.8, 6);
    // 1.2 is out of range, and the one clamp at the end is what brings it back.
    expect(b).toBe(1);
  });

  it('contrast pivots about mid grey', () => {
    const matrix = matrixFor({ op: 'contrast', amount: 2 });
    const [mid] = apply(matrix, 0.5, 0.5, 0.5);
    expect(mid).toBeCloseTo(0.5, 6);
    const [low] = apply(matrix, 0.25, 0.25, 0.25);
    expect(low).toBeCloseTo(0, 6);
  });

  it('saturate(0) is a grey, weighted the way the spec weights it', () => {
    const [r, g, b] = apply(saturate(0), 1, 0, 0);
    // 0.213 is the spec's red luminance for `saturate`, and all three channels come out equal.
    expect(r).toBeCloseTo(0.213, 6);
    expect(g).toBeCloseTo(0.213, 6);
    expect(b).toBeCloseTo(0.213, 6);
  });

  it('grayscale uses the sRGB primaries, which are NOT the saturate weights', () => {
    const [grey] = apply(grayscale(1), 1, 0, 0);
    expect(grey).toBeCloseTo(0.2126, 6);
    // The difference between the two tables is small and real, and one set of weights doing for
    // both is exactly the kind of drift this file exists to catch.
    expect(grey).not.toBeCloseTo(0.213, 6);
  });

  it('a tint is a source-over fill of the same colour', () => {
    const [r, g, b] = apply(matrixFor({ op: 'tint', rgb: [255, 0, 0], alpha: 0.5 }), 0, 0, 0);
    expect(r).toBeCloseTo(0.5, 6);
    expect(g).toBeCloseTo(0, 6);
    expect(b).toBeCloseTo(0, 6);
  });

  it('folds in order: the first op is applied first', () => {
    // Brightness then contrast is not contrast then brightness, and the fold has to keep them apart.
    const forward: FilterOp[] = [
      { op: 'brightness', amount: 0.5 },
      { op: 'contrast', amount: 2 },
    ];
    const backward: FilterOp[] = [
      { op: 'contrast', amount: 2 },
      { op: 'brightness', amount: 0.5 },
    ];
    expect(apply(fold(forward), 0.6, 0.6, 0.6)[0]).toBeCloseTo(0.1, 6);
    expect(apply(fold(backward), 0.6, 0.6, 0.6)[0]).toBeCloseTo(0.35, 6);
  });

  it('hands GL its matrix column by column', () => {
    const columns = toGlColumnMajor({ m: [1, 2, 3, 4, 5, 6, 7, 8, 9], o: [0, 0, 0] });
    // Row-major [1..9] read down the columns is 1,4,7, 2,5,8, 3,6,9 - and uploading the row-major
    // array instead would transpose every colour operation in the shader.
    expect(Array.from(columns)).toEqual([1, 4, 7, 2, 5, 8, 3, 6, 9]);
  });
});
