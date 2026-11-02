import { describe, expect, it } from 'vitest';

import { boxMean, cutoutEdge, cutoutPixels, guideGrid, outlineAlpha, outlineField, outlineSigma, refineMatte, sampleGrid } from './cutout-pixels';

/*
 * The CPU half of [ComposeCutout]'s drawing contract, which the GPU engines are checked against and
 * which draws a cut-out photo's bitmap on every platform. What matters is held here as behaviour: the
 * refinement puts a coarse matte's edge on the frame's own, the edge moves and softens as asked, the
 * outline sits outside the subject, a fill makes the clip opaque.
 */

/** A `w` x `h` RGBA frame whose pixel colour is `colour(x, y)`, fully opaque. */
function frameOf(w: number, h: number, colour: (x: number, y: number) => [number, number, number]): Uint8ClampedArray {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [r, g, b] = colour(x, y);
      out.set([r, g, b, 255], (y * w + x) * 4);
    }
  }
  return out;
}

const alphaAt = (pixels: Uint8ClampedArray, w: number, x: number, y: number): number => pixels[(y * w + x) * 4 + 3]! / 255;

/** How many pixels left of x = 16 the outline reaches along the middle row, for an outline of `width`. */
function outlineReach(matte: Uint8Array, size: number, width: number): number {
  const sigma = outlineSigma(width, size, size);
  const field = outlineField(matte, size, size, sigma);
  let x = 15;
  while (x > 0 && outlineAlpha(sampleGrid(field, size, size, (x + 0.5) / size, 0.5), sigma) > 0.5) x--;
  return 16 - x;
}

describe('the grid arithmetic', () => {
  it('takes a box mean over (2r + 1) cells each way, the edges read as the edge cell', () => {
    const w = 7;
    const h = 5;
    const src = Float32Array.from({ length: w * h }, (_, i) => (i * 37) % 11);
    const fast = boxMean(src, w, h, 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        let sum = 0;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) sum += src[Math.min(h - 1, Math.max(0, y + dy)) * w + Math.min(w - 1, Math.max(0, x + dx))]!;
        expect(fast[y * w + x]).toBeCloseTo(sum / 25, 4);
      }
    }
  });

  it('reads a grid bilinearly between cell centres, clamped at its edges', () => {
    const grid = [0, 100, 200, 300];
    expect(sampleGrid(grid, 4, 1, 0, 0.5)).toBe(0);
    expect(sampleGrid(grid, 4, 1, 0.125, 0.5)).toBe(0);
    expect(sampleGrid(grid, 4, 1, 0.25, 0.5)).toBeCloseTo(50);
    expect(sampleGrid(grid, 4, 1, 1, 0.5)).toBe(300);
  });

  it('takes the guide as the mean luma of each cell footprint', () => {
    const frame = frameOf(4, 2, x => (x < 2 ? [0, 0, 0] : [255, 255, 255]));
    expect([...guideGrid(frame, 4, 2, 2, 1)].map(v => Math.round(v * 1000) / 1000)).toEqual([0, 1]);
  });
});

describe('the refinement', () => {
  it('is the matte smoothed where the frame has no edge to follow', () => {
    const w = 8;
    const h = 8;
    const matte = Uint8Array.from({ length: w * h }, (_, i) => (i % w < 4 ? 255 : 0));
    const flat = new Float32Array(w * h).fill(0.5);
    const { a, b } = refineMatte(matte, flat, w, h);
    // No variance in the guide: a is 0 and b the doubly box-averaged matte.
    expect(Math.max(...a.map(Math.abs))).toBeLessThan(1e-6);
    expect(b[3]).toBeGreaterThan(0.5);
    expect(b[4]).toBeLessThan(0.5);
  });

  it('puts the edge of a coarse, misplaced matte where the frame has its own', () => {
    // A 64 x 16 frame dark on the left and bright on the right, the subject the bright half; the
    // matte is 16 x 4 cells, its edge a ramp a cell to the left of the frame's.
    const fw = 64;
    const fh = 16;
    const frame = frameOf(fw, fh, x => (x < 32 ? [20, 20, 20] : [235, 235, 235]));
    const gw = 16;
    const gh = 4;
    const matte = Uint8Array.from({ length: gw * gh }, (_, i) => {
      const x = i % gw;
      return x <= 6 ? 0 : x >= 8 ? 255 : 128;
    });
    const refined = cutoutPixels(frame, fw, fh, matte, gw, gh, {});
    const plain = cutoutPixels(frame, fw, fh, matte, gw, gh, {}, false);
    // Refined: nothing of the dark side is kept, all of the bright side is, either side of x = 32.
    expect(alphaAt(refined, fw, 30, 8)).toBeLessThan(0.05);
    expect(alphaAt(refined, fw, 31, 8)).toBeLessThan(0.05);
    expect(alphaAt(refined, fw, 33, 8)).toBeGreaterThan(0.95);
    // Unrefined, the matte's own edge stands half a cell off, at x = 30: the dark pixel at 31 is kept.
    expect(alphaAt(plain, fw, 31, 8)).toBeGreaterThan(0.95);
  });
});

describe('the edge', () => {
  it('is even odds at the middle and steep with no softness', () => {
    expect(cutoutEdge(0.5)).toBeCloseTo(0.5);
    expect(cutoutEdge(0.44)).toBe(0);
    expect(cutoutEdge(0.56)).toBe(1);
  });

  it('moves out with a positive shift and in with a negative one', () => {
    expect(cutoutEdge(0.4, 0, 1)).toBe(1);
    expect(cutoutEdge(0.6, 0, -1)).toBe(0);
  });

  it('spreads across the whole range at full softness', () => {
    expect(cutoutEdge(0.1, 1)).toBeGreaterThan(0);
    expect(cutoutEdge(0.9, 1)).toBeLessThan(1);
    expect(cutoutEdge(0, 1)).toBe(0);
    expect(cutoutEdge(1, 1)).toBe(1);
  });
});

describe('the outline and the fill', () => {
  // A 48 x 48 frame of blue, the subject a 16 x 16 square in its middle; the matte is the square too.
  const fw = 48;
  const frame = frameOf(fw, fw, () => [0, 0, 255]);
  const matte = Uint8Array.from({ length: fw * fw }, (_, i) => {
    const x = i % fw;
    const y = Math.floor(i / fw);
    return x >= 16 && x < 32 && y >= 16 && y < 32 ? 255 : 0;
  });

  it('draws the line just outside the subject, in its colour, and nothing far from it', () => {
    // 0.1 of the shorter side: about five pixels of line.
    const pixels = cutoutPixels(frame, fw, fw, matte, fw, fw, { outline: { color: [1, 1, 1], width: 0.1 } });
    const at = (x: number, y: number): number[] => [...pixels.subarray((y * fw + x) * 4, (y * fw + x) * 4 + 4)];
    expect(at(24, 24)).toEqual([0, 0, 255, 255]);
    expect(at(13, 24)).toEqual([255, 255, 255, 255]);
    expect(at(2, 24)[3]).toBe(0);
    expect(at(45, 45)[3]).toBe(0);
  });

  it('takes the line wider with a wider outline', () => {
    expect(outlineReach(matte, fw, 0.2)).toBeGreaterThan(outlineReach(matte, fw, 0.1));
    expect(outlineReach(matte, fw, 0.1)).toBeGreaterThan(2);
  });

  it('makes the clip opaque with a fill, the fill behind the subject', () => {
    const pixels = cutoutPixels(frame, fw, fw, matte, fw, fw, { fill: [1, 0, 0] });
    expect([...pixels.subarray(0, 4)]).toEqual([255, 0, 0, 255]);
    const middle = (24 * fw + 24) * 4;
    expect([...pixels.subarray(middle, middle + 4)]).toEqual([0, 0, 255, 255]);
  });

  it('takes the frame alpha as part of the subject where the frame has one', () => {
    const halfSeen = frame.slice();
    for (let i = 3; i < halfSeen.length; i += 4) halfSeen[i] = 128;
    const pixels = cutoutPixels(halfSeen, fw, fw, matte, fw, fw, {});
    expect(pixels[(24 * fw + 24) * 4 + 3]).toBe(128);
    expect(pixels[3]).toBe(0);
  });

  /** The frame with everything left of the subject transparent: a photo layer's padded margin. */
  function withMargin(): Uint8ClampedArray {
    const margin = frame.slice();
    for (let y = 0; y < fw; y++) for (let x = 0; x < 16; x++) margin[(y * fw + x) * 4 + 3] = 0;
    return margin;
  }

  /* The margin is there to give the line room past the photo's own edge; it once wiped the line out. */
  it('draws the line over the transparent parts of a frame, round what shows', () => {
    const margin = withMargin();
    const lined = cutoutPixels(margin, fw, fw, matte, fw, fw, { outline: { color: [1, 1, 1], width: 0.1 } });
    const at = (x: number, y: number): number[] => [...lined.subarray((y * fw + x) * 4, (y * fw + x) * 4 + 4)];
    expect(at(13, 24)).toEqual([255, 255, 255, 255]);
    expect(at(24, 24)).toEqual([0, 0, 255, 255]);
    expect(at(2, 24)[3]).toBe(0);
    expect(alphaAt(cutoutPixels(margin, fw, fw, matte, fw, fw, {}), fw, 13, 24)).toBe(0);
  });

  it('fills the transparent parts of a frame behind the subject', () => {
    const pixels = cutoutPixels(withMargin(), fw, fw, matte, fw, fw, { fill: [1, 0, 0] });
    const p = (24 * fw + 2) * 4;
    expect([...pixels.subarray(p, p + 4)]).toEqual([255, 0, 0, 255]);
  });
});
