import { CUTOUT_EPSILON, CUTOUT_RADIUS, type ComposeCutout } from '../video-composer/definitions';

/**
 * [ComposeCutout]'s drawing contract on the CPU, step by step: the reference the GPU engines are
 * checked against, and the engine of the two places a cutout is drawn without a GPU - a photo layer's
 * bitmap, which every platform draws from the same rasteriser, and the web painter's 2D fallback.
 *
 * Everything is in the grid's cells until step 5, so the costly part - the guided filter - is a few
 * passes over a grid of half a million cells at most, whatever the size of the picture.
 */

/** The refinement's two grids, `A` and `B` of step 4: `q = A * Y + B` at every pixel. */
export interface MatteRefinement {
  a: Float32Array;
  b: Float32Array;
  width: number;
  height: number;
}

/** What [cutoutPixels] needs of a cutout: the wire's look. */
export type CutoutLook = Pick<ComposeCutout, 'soft' | 'shift' | 'fill' | 'outline'>;

/**
 * Every function of this module, made by one function that reads nothing from outside itself - no
 * import, no constant, no helper of the module's - with the refinement's window and regularisation
 * handed in. That is what lets a worker run the very same code: its script is this function's own
 * source (`cutout-worker.ts`), and whatever a bundler or a minifier makes of the module around it, the
 * function stays whole. Anything added here has to keep to that: plain loops and typed arrays, no
 * spread or rest, which a compiler can turn into a helper of the module's.
 */
export function cutoutKernel(defaultRadius: number, defaultEpsilon: number) {
  /** Rec. 709 luma, the contract's `Y`. */
  function luma(r: number, g: number, b: number): number {
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  /**
   * Step 3: the guide at the grid's size - each cell the mean luma, 0..1, of the pixels of the
   * `frameWidth` x `frameHeight` RGBA frame its footprint covers. A cell whose footprint holds no whole
   * pixel (a grid finer than the frame) reads the pixel under its corner.
   */
  function guideGrid(frame: Uint8ClampedArray | Uint8Array, frameWidth: number, frameHeight: number, width: number, height: number, out = new Float32Array(width * height)): Float32Array {
    for (let cy = 0; cy < height; cy++) {
      const y0 = Math.min(frameHeight - 1, Math.floor((cy * frameHeight) / height));
      const y1 = Math.min(frameHeight, Math.max(y0 + 1, Math.floor(((cy + 1) * frameHeight) / height)));
      for (let cx = 0; cx < width; cx++) {
        const x0 = Math.min(frameWidth - 1, Math.floor((cx * frameWidth) / width));
        const x1 = Math.min(frameWidth, Math.max(x0 + 1, Math.floor(((cx + 1) * frameWidth) / width)));
        let sum = 0;
        for (let y = y0; y < y1; y++) {
          let p = (y * frameWidth + x0) * 4;
          for (let x = x0; x < x1; x++, p += 4) sum += luma(frame[p]!, frame[p + 1]!, frame[p + 2]!);
        }
        out[cy * width + cx] = sum / ((y1 - y0) * (x1 - x0)) / 255;
      }
    }
    return out;
  }

  /**
   * The mean of `src` over the `(2r + 1)` x `(2r + 1)` cells centred on each cell, a cell past the
   * edge read as the nearest edge cell - the contract's `mean` - across and then down.
   */
  function boxMean(src: Float32Array, width: number, height: number, r: number, out = new Float32Array(width * height)): Float32Array {
    const across = new Float32Array(width * height);
    runningBox(src, across, width, height, r, true);
    runningBox(across, out, width, height, r, false);
    return out;
  }

  /**
   * Step 4, the guided filter on the grid: `m` the matte 0..255 a cell (step 2's, rounded as an engine
   * uploads it) and `y` the guide (step 3's). [CUTOUT_RADIUS] and [CUTOUT_EPSILON] unless a test asks
   * for others.
   */
  function refineMatte(m: Uint8Array, y: Float32Array, width: number, height: number, radius = defaultRadius, epsilon = defaultEpsilon): MatteRefinement {
    const cells = width * height;
    const p = new Float32Array(cells);
    const yy = new Float32Array(cells);
    const yp = new Float32Array(cells);
    for (let c = 0; c < cells; c++) {
      const v = m[c]! / 255;
      p[c] = v;
      yy[c] = y[c]! * y[c]!;
      yp[c] = y[c]! * v;
    }
    const meanY = boxMean(y, width, height, radius);
    const meanP = boxMean(p, width, height, radius);
    const meanYY = boxMean(yy, width, height, radius);
    const meanYP = boxMean(yp, width, height, radius);
    const a = new Float32Array(cells);
    const b = new Float32Array(cells);
    for (let c = 0; c < cells; c++) {
      const variance = meanYY[c]! - meanY[c]! * meanY[c]!;
      const covariance = meanYP[c]! - meanY[c]! * meanP[c]!;
      a[c] = covariance / (variance + epsilon);
      b[c] = meanP[c]! - a[c]! * meanY[c]!;
    }
    return { a: boxMean(a, width, height, radius), b: boxMean(b, width, height, radius), width, height };
  }

  /**
   * A grid read at a point of the frame, `u` and `v` 0..1 from its top-left: bilinear between cell
   * centres - cell (cx, cy) is centred at ((cx + 0.5) / W, (cy + 0.5) / H) - the edges clamped. The
   * contract's reading of a grid at a pixel, as a texture unit with LINEAR filtering reads it.
   */
  function sampleGrid(grid: ArrayLike<number>, width: number, height: number, u: number, v: number): number {
    const gx = clamp(u * width - 0.5, 0, width - 1);
    const gy = clamp(v * height - 0.5, 0, height - 1);
    const x0 = Math.floor(gx);
    const y0 = Math.floor(gy);
    const x1 = Math.min(width - 1, x0 + 1);
    const y1 = Math.min(height - 1, y0 + 1);
    const fx = gx - x0;
    const fy = gy - y0;
    const top = grid[y0 * width + x0]! * (1 - fx) + grid[y0 * width + x1]! * fx;
    const bottom = grid[y1 * width + x0]! * (1 - fx) + grid[y1 * width + x1]! * fx;
    return top * (1 - fy) + bottom * fy;
  }

  /** Step 6: the subject's alpha from the refined `q`, as soft and as shifted as the cutout asks. */
  function cutoutEdge(q: number, soft = 0, shift = 0): number {
    const t = 0.5 - 0.25 * shift;
    const h = 0.06 + 0.44 * soft;
    return smoothstep(t - h, t + h, q);
  }

  /** Step 7's sigma, in cells, for an outline as wide as `outlineWidth` of the source's shorter side, on a `width` x `height` grid. */
  function outlineSigma(outlineWidth: number, width: number, height: number): number {
    return (outlineWidth * Math.min(width, height)) / 1.55;
  }

  /** Step 7: the outline's own alpha from the blurred grid `D` read at a pixel. */
  function outlineAlpha(d: number, sigma: number): number {
    const spread = 0.04 / Math.max(1, sigma);
    return smoothstep(0.06 - spread, 0.06 + spread, d);
  }

  /**
   * Step 7's `D`: the matte, 0..1, Gaussian-blurred by `sigma` cells with its edges clamped - three
   * running boxes across and three down, which is a Gaussian to within what eight bits show and costs
   * the same at any sigma. A sigma under a cell is the matte itself.
   */
  function outlineField(m: Uint8Array, width: number, height: number, sigma: number): Float32Array {
    const field = new Float32Array(width * height);
    for (let c = 0; c < field.length; c++) field[c] = m[c]! / 255;
    if (!(sigma >= 1)) return field;
    // Three boxes of width w have a variance of 3 * (w^2 - 1) / 12: w is the odd width that comes nearest sigma^2.
    const w = Math.max(1, Math.round(Math.sqrt(4 * sigma * sigma + 1)) | 1);
    const r = (w - 1) / 2;
    const scratch = new Float32Array(field.length);
    for (let pass = 0; pass < 3; pass++) {
      runningBox(field, scratch, width, height, r, true);
      runningBox(scratch, field, width, height, r, false);
    }
    return field;
  }

  /**
   * One box of radius `r` along rows (`across`) or columns, a cell past the edge read as the edge cell, by a running sum.
   *
   * Down the columns it goes a row at a time with every column's sum at once: the same additions in the
   * same order as one column after another, so the same numbers, but read along the rows the grid is
   * kept in - a column at a time strides a whole row between reads, and on a photo's grid of a million
   * cells that was most of the refinement's time on a phone.
   */
  function runningBox(src: Float32Array, out: Float32Array, width: number, height: number, r: number, across: boolean): void {
    const n = 2 * r + 1;
    if (across) {
      for (let y = 0; y < height; y++) {
        const base = y * width;
        let sum = 0;
        for (let k = -r; k <= r; k++) sum += src[base + clamp(k, 0, width - 1)]!;
        for (let x = 0; x < width; x++) {
          out[base + x] = sum / n;
          sum += src[base + clamp(x + r + 1, 0, width - 1)]! - src[base + clamp(x - r, 0, width - 1)]!;
        }
      }
      return;
    }
    const sums = new Float64Array(width);
    for (let k = -r; k <= r; k++) {
      const row = clamp(k, 0, height - 1) * width;
      for (let x = 0; x < width; x++) sums[x] += src[row + x]!;
    }
    for (let y = 0; y < height; y++) {
      const at = y * width;
      const next = clamp(y + r + 1, 0, height - 1) * width;
      const last = clamp(y - r, 0, height - 1) * width;
      for (let x = 0; x < width; x++) {
        out[at + x] = sums[x]! / n;
        sums[x] += src[next + x]! - src[last + x]!;
      }
    }
  }

  /**
   * The whole contract over one frame: `frame` is `frameWidth` x `frameHeight` RGBA, straight, and
   * `matte` the grid at this instant (step 2), 0..255 a cell. Answers a new RGBA buffer of the frame's
   * size, STRAIGHT - the colour and the alpha steps 5 to 8 make - which a 2D canvas takes as it is.
   *
   * The frame's own alpha is part of the subject's (step 6), not a cut over the result: a photo layer's
   * transparent margin - the room [cutoutPhoto] pads it with - and a picture's transparent parts
   * take the outline drawn round what does show, and a fill behind it.
   *
   * `refine` false skips steps 3 and 4, as an engine with no float targets does.
   *
   * A grid the frame's own size - a photo's, brought down to its bitmap - is read cell for pixel: a
   * pixel's centre is its cell's, where the bilinear reading is the cell itself.
   */
  function cutoutPixels(
    frame: Uint8ClampedArray | Uint8Array,
    frameWidth: number,
    frameHeight: number,
    matte: Uint8Array,
    width: number,
    height: number,
    look: CutoutLook,
    refine = true,
  ): Uint8ClampedArray {
    const out = new Uint8ClampedArray(frameWidth * frameHeight * 4);
    const refinement = refine ? refineMatte(matte, guideGrid(frame, frameWidth, frameHeight, width, height), width, height) : null;
    const outline = look.outline && look.outline.width > 0 ? look.outline : null;
    const sigma = outline ? outlineSigma(outline.width, width, height) : 0;
    const field = outline ? outlineField(matte, width, height, sigma) : null;
    const soft = look.soft ?? 0;
    const shift = look.shift ?? 0;
    const fill = look.fill;
    const exact = width === frameWidth && height === frameHeight;
    for (let py = 0; py < frameHeight; py++) {
      const v = (py + 0.5) / frameHeight;
      for (let px = 0; px < frameWidth; px++) {
        const u = (px + 0.5) / frameWidth;
        const cell = py * frameWidth + px;
        const p = cell * 4;
        const r = frame[p]! / 255;
        const g = frame[p + 1]! / 255;
        const b = frame[p + 2]! / 255;
        const own = frame[p + 3]! / 255;
        let q: number;
        if (refinement) {
          const a = exact ? refinement.a[cell]! : sampleGrid(refinement.a, width, height, u, v);
          const bb = exact ? refinement.b[cell]! : sampleGrid(refinement.b, width, height, u, v);
          q = clamp(a * luma(r, g, b) + bb, 0, 1);
        } else {
          q = (exact ? matte[cell]! : sampleGrid(matte, width, height, u, v)) / 255;
        }
        const a0 = cutoutEdge(q, soft, shift) * own;
        let alpha = a0;
        let cr = r;
        let cg = g;
        let cb = b;
        if (outline && field) {
          const o = outlineAlpha(exact ? field[cell]! : sampleGrid(field, width, height, u, v), sigma);
          alpha = a0 + (1 - a0) * o;
          if (alpha > 0) {
            const line = (1 - a0) * o;
            cr = (r * a0 + outline.color[0] * line) / alpha;
            cg = (g * a0 + outline.color[1] * line) / alpha;
            cb = (b * a0 + outline.color[2] * line) / alpha;
          }
        }
        if (fill) {
          cr = fill[0] + (cr - fill[0]) * alpha;
          cg = fill[1] + (cg - fill[1]) * alpha;
          cb = fill[2] + (cb - fill[2]) * alpha;
          alpha = 1;
        }
        out[p] = Math.round(cr * 255);
        out[p + 1] = Math.round(cg * 255);
        out[p + 2] = Math.round(cb * 255);
        out[p + 3] = Math.round(alpha * 255);
      }
    }
    return out;
  }

  /** The contract's smoothstep, as `transitions.ts` has it: an edge of no width is a step. Here rather than imported, for the reason the kernel gives. */
  function smoothstep(e0: number, e1: number, x: number): number {
    if (e1 === e0) return x < e0 ? 0 : 1;
    const t = clamp((x - e0) / (e1 - e0), 0, 1);
    return t * t * (3 - 2 * t);
  }

  function clamp(value: number, min: number, max: number): number {
    return value < min ? min : value > max ? max : value;
  }

  return { luma, guideGrid, boxMean, refineMatte, sampleGrid, cutoutEdge, outlineSigma, outlineAlpha, outlineField, cutoutPixels };
}

/** The kernel with the contract's window and regularisation: what this module has always exported, one function each. */
export const { luma, guideGrid, boxMean, refineMatte, sampleGrid, cutoutEdge, outlineSigma, outlineAlpha, outlineField, cutoutPixels } = cutoutKernel(CUTOUT_RADIUS, CUTOUT_EPSILON);
