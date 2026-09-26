import { describe, expect, it } from 'vitest';

import {
  FLOW,
  OFF_FRAME,
  consistencyRatio,
  exposureGain,
  flowPasses,
  flowPyramid,
  glslFloat,
  insideFrame,
  intermediateFlows,
  interpolationBody,
  iterationsAt,
  landed,
  lumaTaps,
  pairTrust,
  synthesisWeights,
  trackPoints,
  visibility,
  type FlowField,
  type Vec2,
} from './optical-flow';

/**
 * The maths the flow's shaders do, as plain functions - the pyramid it works on, the Super SloMo
 * composition and the point-tracking that replaced it, the round-trip test, the trust and the weights
 * - pinned to numbers. `OpticalFlowTest.kt` holds the Android engine's copy of each function to the
 * SAME cases and the same numbers, so the two cannot drift; the shaders themselves are held to each
 * other as text by `build/optical-flow-parity.unit.test.ts`.
 */

const close = (actual: readonly number[], expected: readonly number[], digits = 9) =>
  expected.forEach((value, i) => expect(actual[i], `component ${i} of [${actual}]`).toBeCloseTo(value, digits));

describe('the pyramid', () => {
  it('works a portrait clip at 180x320 whatever its resolution, and halves it four times', () => {
    const portrait = [
      { width: 180, height: 320 },
      { width: 90, height: 160 },
      { width: 45, height: 80 },
      { width: 23, height: 40 },
      { width: 12, height: 20 },
    ];
    expect(flowPyramid(720, 1280)).toEqual(portrait);
    expect(flowPyramid(1080, 1920)).toEqual(portrait);
    expect(flowPyramid(2160, 3840)).toEqual(portrait);
  });

  it('turns with the clip', () => {
    expect(flowPyramid(1920, 1080)).toEqual([
      { width: 320, height: 180 },
      { width: 160, height: 90 },
      { width: 80, height: 45 },
      { width: 40, height: 23 },
      { width: 20, height: 12 },
    ]);
  });

  it('never enlarges a small frame, and stops before a level would be too small to hold a window', () => {
    expect(flowPyramid(200, 100)).toEqual([
      { width: 200, height: 100 },
      { width: 100, height: 50 },
      { width: 50, height: 25 },
      { width: 25, height: 13 },
    ]);
    expect(flowPyramid(64, 64).map(l => l.width)).toEqual([64, 32, 16, 8]);
    expect(flowPyramid(1, 1)).toEqual([{ width: 1, height: 1 }]);
    expect(flowPyramid(0, 720)).toEqual([]);
  });

  it('tiles each working texel with 2x2 reads of the frame: an exact box at 4:1, 6:1 and 12:1', () => {
    const portrait = { width: 180, height: 320 };
    expect(lumaTaps(360, 640, portrait)).toBe(1);
    expect(lumaTaps(720, 1280, portrait)).toBe(2);
    expect(lumaTaps(1080, 1920, portrait)).toBe(3);
    expect(lumaTaps(1440, 2560, portrait)).toBe(4);
    expect(lumaTaps(2160, 3840, portrait)).toBe(6);
    // Never more than the pass is written for, and one plain read where the frame is the working size.
    expect(lumaTaps(4320, 7680, portrait)).toBe(FLOW.maxLumaTaps);
    expect(lumaTaps(200, 100, { width: 200, height: 100 })).toBe(1);
  });

  it('iterates finest first, and a level past the list takes its last number', () => {
    expect(FLOW.iterations).toEqual([3, 3, 4, 5, 5]);
    expect([0, 1, 2, 3, 4, 9].map(level => iterationsAt(level))).toEqual([3, 3, 4, 5, 5, 5]);
  });
});

describe('where the missing frame reads its neighbours', () => {
  it('is, by Super SloMo’s approximation, a fraction t back along the motion and the rest forward', () => {
    const { toA, toB } = intermediateFlows([4, -2], [-4, 2], 0.25);
    close(toA, [-1, 0.5]);
    close(toB, [3, -1.5]);
    // Not symmetric where the two flows disagree: each term takes its own share.
    const skew = intermediateFlows([4, 0], [0, 0], 0.5);
    close(skew.toA, [-1, 0]);
    close(skew.toB, [1, 0]);
  });

  const size = { width: 100, height: 100 };
  /** A picture moving steadily by `d` texels: every point's forward flow is d, backward -d. */
  const uniform =
    (d: Vec2): FlowField =>
    () => [d[0] / size.width, d[1] / size.height, -d[0] / size.width, -d[1] / size.height];

  it('lands, by tracking, exactly where the approximation does wherever the motion is uniform', () => {
    for (const t of [0.25, 0.5, 0.75]) {
      const uv: Vec2 = [0.4, 0.6];
      const tracked = trackPoints(uniform([6, -3]), uv, t, size);
      const { toA, toB } = intermediateFlows([0.06, -0.03], [-0.06, 0.03], t);
      close(tracked.pa, [uv[0] + toA[0], uv[1] + toA[1]]);
      close(tracked.pb, [uv[0] + toB[0], uv[1] + toB[1]]);
      expect(tracked.missA).toBeCloseTo(0, 9);
      expect(tracked.missB).toBeCloseTo(0, 9);
      close(tracked.flowA, [6, -3]);
      close(tracked.flowB, [-6, 3]);
    }
  });

  /**
   * A block moving right by 20 texels over a still background: in A it covers x 30..50, in B 50..70.
   * Halfway, it covers 40..60.
   */
  const block: FlowField = ([x]) => {
    const inA = x >= 0.3 && x <= 0.5;
    const inB = x >= 0.5 && x <= 0.7;
    return [inA ? 0.2 : 0, 0, inB ? -0.2 : 0, 0];
  };

  it('finds the block in A where the linear approximation, at the block’s edge, reads the background', () => {
    // Just inside the block's left edge halfway: a point of the block, which A has 10 texels back.
    const uv: Vec2 = [0.42, 0.5];
    const tracked = trackPoints(block, uv, 0.5, size);
    close(tracked.pa, [0.32, 0.5]);
    expect(tracked.missA).toBeCloseTo(0, 9);
    // The linear approximation reads F10 = 0 at uv (B has background there) and sends A's read only
    // halfway back: 5 texels, not 10 - the halo tracking removes.
    const [f01x, f01y, f10x, f10y] = block(uv);
    close(intermediateFlows([f01x, f01y], [f10x, f10y], 0.5).toA, [-0.05, 0]);
  });

  it('knows when no point of A lands on a pixel: the background the block has just uncovered', () => {
    // 35 halfway is background B has and A had under the block.
    const tracked = trackPoints(block, [0.35, 0.5], 0.5, size);
    expect(tracked.missB).toBeCloseTo(0, 9);
    expect(tracked.missA).toBeGreaterThan(FLOW.missHigh);
    expect(landed(tracked.missA, insideFrame(tracked.pa))).toBe(0);
    expect(landed(tracked.missB, insideFrame(tracked.pb))).toBe(1);
  });
});

describe('the round trip, and how far the flow is trusted', () => {
  it('closes for a texel the backward flow brings back, and not for one it does not', () => {
    expect(consistencyRatio([3, 0], [-3, 0])).toBe(0);
    // 9 over 0.01 * 9 + 0.5: hidden.
    expect(consistencyRatio([3, 0], [0, 0])).toBeCloseTo(15.254237288, 8);
    // A long motion is allowed a longer miss.
    expect(consistencyRatio([40, 0], [-39, 0])).toBeCloseTo(1 / (0.01 * (1600 + 1521) + 0.5), 12);
  });

  it('reads visibility off the ratio: seen to 1, hidden from 4, a smoothstep between', () => {
    expect(visibility(0)).toBe(1);
    expect(visibility(1)).toBe(1);
    expect(visibility(2.5)).toBeCloseTo(0.5, 12);
    expect(visibility(4)).toBe(0);
    expect(visibility(OFF_FRAME)).toBe(0);
  });

  it('trusts a pair fully until a quarter of it fails or its luma disagrees by 0.06, and not at all past half or 0.12', () => {
    expect(pairTrust(0, 0)).toBe(1);
    expect(pairTrust(0.25, 0.06)).toBe(1);
    expect(pairTrust(0.5, 0)).toBe(0);
    expect(pairTrust(0, 0.12)).toBe(0);
    expect(pairTrust(0.375, 0)).toBeCloseTo(0.5, 12);
    expect(pairTrust(0.375, 0.09)).toBeCloseTo(0.25, 12);
  });

  it('brings B to A’s exposure, a factor of two at most either way', () => {
    expect(exposureGain(0.15, 0.1)).toBeCloseTo(1.5, 12);
    expect(exposureGain(0.3, 0.1)).toBe(2);
    expect(exposureGain(0.1, 0.3)).toBe(0.5);
    // Two flat frames have no spread between them to match.
    expect(exposureGain(0, 0)).toBe(0.5);
  });
});

describe('the weights', () => {
  it('are the cross-fade’s where both points are found and seen', () => {
    const { wA, wB, confidence } = synthesisWeights(0.25, 1, 1, 1, 1, 5, 1);
    expect(wA / (wA + wB)).toBeCloseTo(0.75, 12);
    expect(confidence).toBe(1);
  });

  it('prefer the point seen in both frames over one hidden in the other, by the hidden weight', () => {
    const { wA, wB } = synthesisWeights(0.5, 1, 1, 1, 0, 5, 1);
    expect(wA / wB).toBeCloseTo((1 + FLOW.hiddenWeight) / FLOW.hiddenWeight, 12);
  });

  it('take a point seen in only its own frame when it is all there is', () => {
    const { wA, wB, confidence } = synthesisWeights(0.5, 0, 1, 0, 0, 5, 1);
    expect(wA).toBe(0);
    expect(wB).toBeGreaterThan(0);
    expect(confidence).toBe(1);
  });

  it('are the cross-fade where nothing moves, where neither point was found, and on a pair not trusted', () => {
    expect(synthesisWeights(0.5, 1, 1, 1, 1, 0.1, 1).confidence).toBe(0);
    expect(synthesisWeights(0.5, 1, 1, 1, 1, 0.175, 1).confidence).toBeCloseTo(0.5, 12);
    expect(synthesisWeights(0.5, 0, 0, 1, 1, 5, 1).confidence).toBe(0);
    expect(synthesisWeights(0.5, 1, 1, 1, 1, 5, 0).confidence).toBe(0);
  });

  it('count a point as found up to half a texel off, and not from a whole texel', () => {
    expect(landed(0.5, 1)).toBe(1);
    expect(landed(0.75, 1)).toBeCloseTo(0.5, 12);
    expect(landed(1, 1)).toBe(0);
    expect(landed(0, 0)).toBe(0);
    expect(insideFrame([0, 1])).toBe(1);
    expect(insideFrame([-0.001, 0.5])).toBe(0);
  });
});

describe('the shader text', () => {
  it('writes every float as GLSL ES 1.00 will take it', () => {
    expect(glslFloat(1)).toBe('1.0');
    expect(glslFloat(-3)).toBe('-3.0');
    expect(glslFloat(0.25)).toBe('0.25');
    expect(() => glslFloat(Number.NaN)).toThrow();
  });

  it('is GLSL ES 1.00 in every pass, which both engines compile', () => {
    for (const [name, source] of Object.entries(flowPasses())) {
      expect(source.startsWith('#version 100\nprecision highp float;\n'), name).toBe(true);
      expect(source, name).toContain('void main()');
      expect(source, name).not.toMatch(/\btexture\(/);
    }
  });

  it('reads textures in the per-pixel step only through SAMPLE, the one word each engine defines for itself', () => {
    const body = interpolationBody();
    expect(body).not.toMatch(/\btexture2D\(|\btexture\(/);
    expect(body).toContain('SAMPLE(frameA, uv)');
    expect(body).toContain('vec3 interpolateFrames(sampler2D frameA, sampler2D frameB, vec2 uv, float w)');
  });
});
