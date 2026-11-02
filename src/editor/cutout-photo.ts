import type { CutoutLook } from './cutout-pixels';
import type { RasterisedOverlay } from './raster-context';

/**
 * A cut-out photo layer's bitmap ([ImageOverlay.cutout]), from the photo to the PNG: the matte's grid
 * brought down to the bitmap, the contract's steps on the CPU ([cutoutPixels]), the shadow under the
 * subject, the trim to what is left. One function, so a worker and the main thread draw a photo the
 * same way - a worker with an `OffscreenCanvas`, the main thread where a page cannot run one.
 */

/**
 * What a cut-out photo is drawn from, beside the picture: numbers and the matte, nothing of the page's,
 * so it can be handed to a worker as it is.
 */
export interface CutoutPhotoJob {
  /** The size the photo covers on the output frame, in output pixels. */
  wPx: number;
  hPx: number;
  /** Bitmap pixels per output pixel (`bitmapRatio`). */
  k: number;
  /** The matte at the photo's one frame (step 2's grid), `matteWidth` x `matteHeight` cells. */
  cells: Uint8Array;
  matteWidth: number;
  matteHeight: number;
  soft: number;
  shift: number;
  /** The line round the subject: its 0..1 colour, and how wide, as a fraction of the photo's shorter side. */
  outline: { color: [number, number, number]; width: number } | null;
  /** The shadow under the subject: how soft and how far it falls, as fractions of the photo's shorter side, and its CSS colour. */
  shadow: { blur: number; drop: number; color: string } | null;
}

/** A canvas either thread can draw on: an element on the main thread, an `OffscreenCanvas` in a worker. */
export type AnyCanvas = HTMLCanvasElement | OffscreenCanvas;

/** What [cutoutPhoto] draws with, which is where the two threads differ. */
export interface CutoutPhotoTools {
  /** The kernel's [cutoutPixels]. */
  cutoutPixels(frame: Uint8ClampedArray, frameWidth: number, frameHeight: number, matte: Uint8Array, width: number, height: number, look: CutoutLook): Uint8ClampedArray;
  /** A blank canvas of a size. */
  canvas(width: number, height: number): AnyCanvas;
  /** A canvas as a `data:image/png;base64,...` URL. */
  png(canvas: AnyCanvas): Promise<string>;
}

/**
 * Draws the photo `image`, cut out as `job` says, and answers its bitmap trimmed to the subject, its line
 * and its shadow - so the box the editor draws round the layer is the subject's.
 *
 * The outline and the shadow reach past the photo, so it is drawn in a frame with room round it, the
 * same on every side, and the matte's grid is given that room as cells of nothing: a subject the photo
 * cuts off at an edge is outlined along the cut too, as a sticker cut from a print is. The room is a
 * whole number of cells, so the grid and the frame still lie over each other exactly.
 *
 * A grid finer than the bitmap is brought down to the bitmap's own pixels first. A photo's matte is a
 * thousand cells on its long side and a photo layer a few hundred pixels, and a cell smaller than a pixel
 * holds nothing a pixel can show - while the refinement over it was most of the time a cheap phone took:
 * measured on a Galaxy A13, a second for a plain photo and two with an outline, half of that once the
 * grid was the bitmap's.
 *
 * Null where the photo's pixels cannot be read - a canvas another origin's image has tainted - and the
 * photo is then drawn whole. The trim is the one `overlay-raster.ts` gives every layer: the same off both
 * sides of each axis, which keeps the layer's centre where it was, and none at all for a bitmap with
 * nothing in it.
 *
 * Runs in a worker as its own source text, so it reads nothing from outside itself, as [cutoutKernel]
 * does not: everything it needs comes in `job` and `tools`.
 */
export async function cutoutPhoto(image: CanvasImageSource, job: CutoutPhotoJob, tools: CutoutPhotoTools): Promise<RasterisedOverlay | null> {
  const w = Math.max(1, Math.round(job.wPx * job.k));
  const h = Math.max(1, Math.round(job.hPx * job.k));
  const short = Math.min(w, h);
  const outlinePx = job.outline ? job.outline.width * short : 0;
  const shadow = job.shadow ? { blur: job.shadow.blur * short, drop: job.shadow.drop * short, color: job.shadow.color } : null;
  const roomPx = Math.ceil(outlinePx * 1.4 + (shadow ? 2.5 * shadow.blur + shadow.drop : 0)) + 1;

  const matteW = Math.min(job.matteWidth, w);
  const matteH = Math.min(job.matteHeight, h);
  const cellX = w / matteW;
  const cellY = h / matteH;
  const roomX = Math.ceil(roomPx / cellX);
  const roomY = Math.ceil(roomPx / cellY);
  const gridW = matteW + 2 * roomX;
  const gridH = matteH + 2 * roomY;
  const frameW = Math.max(1, Math.round(gridW * cellX));
  const frameH = Math.max(1, Math.round(gridH * cellY));

  const frame = tools.canvas(frameW, frameH);
  const g = context(frame);
  g.imageSmoothingEnabled = true;
  g.imageSmoothingQuality = 'high';
  g.drawImage(image, roomX * cellX, roomY * cellY, w, h);
  let pixels: ImageData;
  try {
    pixels = g.getImageData(0, 0, frameW, frameH);
  } catch {
    release(frame);
    return null;
  }

  const grid = new Uint8Array(gridW * gridH);
  const cells = shrinkGrid(job.cells, job.matteWidth, job.matteHeight, matteW, matteH);
  for (let y = 0; y < matteH; y++) grid.set(cells.subarray(y * matteW, (y + 1) * matteW), (y + roomY) * gridW + roomX);
  // The outline's width is a fraction of the PHOTO's shorter side, and the frame it is drawn in is larger.
  const look: CutoutLook = { soft: job.soft, shift: job.shift };
  if (job.outline) look.outline = { color: job.outline.color, width: outlinePx / Math.min(frameW, frameH) };
  pixels.data.set(tools.cutoutPixels(pixels.data, frameW, frameH, grid, gridW, gridH, look));
  g.putImageData(pixels, 0, 0);

  let drawn = frame;
  if (shadow) {
    drawn = tools.canvas(frameW, frameH);
    const lifted = context(drawn);
    lifted.shadowColor = shadow.color;
    lifted.shadowBlur = shadow.blur;
    lifted.shadowOffsetY = shadow.drop;
    lifted.drawImage(frame, 0, 0);
    release(frame);
  }

  // The frame stands for `frameW / k` output pixels across, the room included; the trim takes off
  // whatever of it the subject, its line and its shadow left empty.
  const wide = frameW / job.k;
  const tall = frameH / job.k;
  const margin = emptyMargin((shadow ? context(drawn).getImageData(0, 0, frameW, frameH) : pixels).data, frameW, frameH);
  if (!margin) {
    const png = await tools.png(drawn);
    release(drawn);
    return { png, wPx: wide, hPx: tall };
  }
  const kept = tools.canvas(frameW - margin.x * 2, frameH - margin.y * 2);
  // Whole pixels both ways, so this is a copy and not a resample: nothing is softened by the trim.
  context(kept).drawImage(drawn, -margin.x, -margin.y);
  release(drawn);
  // Measured before the PNG is taken, which lets the canvas's pixels go and its size with them.
  const trimmed = {
    wPx: Math.max(1, Math.round((wide * kept.width) / frameW)),
    hPx: Math.max(1, Math.round((tall * kept.height) / frameH)),
  };
  const png = await tools.png(kept);
  release(kept);
  return { png, wPx: trimmed.wPx, hPx: trimmed.hPx };

  /**
   * A canvas's 2D context, read often: every canvas here is read back, and a canvas kept on the GPU
   * hands its pixels back through a copy that cost a phone more than the cutout's arithmetic. The
   * element's and the worker's contexts alike have everything used here.
   */
  function context(canvas: AnyCanvas): CanvasRenderingContext2D {
    const made = canvas.getContext('2d', { willReadFrequently: true }) as CanvasRenderingContext2D | null;
    if (!made) throw new Error('2D canvas is unavailable');
    return made;
  }

  /** A canvas's pixels let go of: a phone keeps them until the canvas is collected otherwise. */
  function release(canvas: AnyCanvas): void {
    canvas.width = 0;
    canvas.height = 0;
  }

  /**
   * A matte's grid of `width` x `height` cells brought down to `toWidth` x `toHeight`, no larger either
   * way: each new cell the mean of the cells its footprint covers. The same grid where nothing changes.
   */
  function shrinkGrid(source: Uint8Array, width: number, height: number, toWidth: number, toHeight: number): Uint8Array {
    if (toWidth === width && toHeight === height) return source;
    const out = new Uint8Array(toWidth * toHeight);
    for (let cy = 0; cy < toHeight; cy++) {
      const y0 = Math.floor((cy * height) / toHeight);
      const y1 = Math.max(y0 + 1, Math.floor(((cy + 1) * height) / toHeight));
      for (let cx = 0; cx < toWidth; cx++) {
        const x0 = Math.floor((cx * width) / toWidth);
        const x1 = Math.max(x0 + 1, Math.floor(((cx + 1) * width) / toWidth));
        let sum = 0;
        for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) sum += source[y * width + x]!;
        out[cy * toWidth + cx] = Math.round(sum / ((y1 - y0) * (x1 - x0)));
      }
    }
    return out;
  }

  /**
   * How many fully transparent pixels each axis can lose from BOTH of its edges, or null when there is
   * nothing worth cropping - nothing drawn at all included, which leaves no centre to keep.
   */
  function emptyMargin(rgba: Uint8ClampedArray, width: number, height: number): { x: number; y: number } | null {
    const rowEmpty = (y: number): boolean => {
      for (let x = 0, p = y * width * 4 + 3; x < width; x++, p += 4) if (rgba[p] !== 0) return false;
      return true;
    };
    const columnEmpty = (x: number): boolean => {
      for (let y = 0, p = x * 4 + 3; y < height; y++, p += width * 4) if (rgba[p] !== 0) return false;
      return true;
    };
    let top = 0;
    while (top < height && rowEmpty(top)) top++;
    if (top >= height) return null;
    let bottom = 0;
    while (rowEmpty(height - 1 - bottom)) bottom++;
    let left = 0;
    while (columnEmpty(left)) left++;
    let right = 0;
    while (columnEmpty(width - 1 - right)) right++;
    const x = Math.min(left, right);
    const y = Math.min(top, bottom);
    return x >= 1 || y >= 1 ? { x, y } : null;
  }
}
