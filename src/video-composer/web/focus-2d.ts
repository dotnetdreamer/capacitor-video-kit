import type { FocusDraw } from './focus-gl';
import type { Frame } from './geometry';

/**
 * A clip's focus without a shader, for the painter's 2D path: a browser with no WebGL2.
 *
 * It is the fallback's usual bargain - the preview's look, very nearly the native render's. The world
 * is blurred, greyed and darkened by `ctx.filter`, whose `blur()` is the same Gaussian and whose
 * `grayscale()` and `brightness()` are the contract's grey and dark exactly; the subject is the frame
 * cut out through the cell grid, stretched over it with the canvas's own smoothing. What it gives up
 * is the contract's weighting, so a subject's edge colour is smeared a little way into the blur
 * around it, and the ease on the mask's edge. Where the canvas has no `filter`, the world is left
 * sharp and only the cut-out is honest; such a browser has no encoder to post with either.
 */
export class Focus2d {
  private grid: HTMLCanvasElement | null = null;
  private soft: HTMLCanvasElement | null = null;
  private sharp: HTMLCanvasElement | null = null;
  private out: HTMLCanvasElement | null = null;

  /**
   * `picture`, a `sourceWidth` x `sourceHeight` frame, focused at `work` size onto a canvas of this
   * object's own, valid until the next call.
   */
  apply(picture: CanvasImageSource, sourceWidth: number, sourceHeight: number, focus: FocusDraw, work: Frame): HTMLCanvasElement {
    const grid = (this.grid = sized(this.grid, focus.maskWidth, focus.maskHeight));
    const gridCtx = grid.getContext('2d');
    if (gridCtx) {
      const image = gridCtx.createImageData(focus.maskWidth, focus.maskHeight);
      for (let c = 0; c < focus.mask.length; c++) image.data[c * 4 + 3] = focus.mask[c]!;
      gridCtx.putImageData(image, 0, 0);
    }

    // The world: the frame blurred, greyed and darkened, laid over the frame itself, so the edge the
    // filter fades towards transparent shows the frame there rather than black.
    const sigma = focus.blur * Math.min(sourceWidth, sourceHeight) * (work.width / sourceWidth);
    const filters = [sigma > 0 ? `blur(${sigma}px)` : '', focus.mono > 0 ? `grayscale(${focus.mono})` : '', focus.dim > 0 ? `brightness(${1 - focus.dim})` : ''].filter(Boolean).join(' ');
    const soft = (this.soft = sized(this.soft, work.width, work.height));
    const softCtx = soft.getContext('2d');
    if (softCtx) {
      softCtx.globalCompositeOperation = 'copy';
      softCtx.filter = 'none';
      softCtx.drawImage(picture, 0, 0, work.width, work.height);
      softCtx.globalCompositeOperation = 'source-over';
      softCtx.filter = filters || 'none';
      softCtx.drawImage(picture, 0, 0, work.width, work.height);
      softCtx.filter = 'none';
    }

    // The subjects: the frame, kept where the grid says it is in focus.
    const sharp = (this.sharp = sized(this.sharp, work.width, work.height));
    const sharpCtx = sharp.getContext('2d');
    if (sharpCtx) {
      sharpCtx.globalCompositeOperation = 'copy';
      sharpCtx.drawImage(picture, 0, 0, work.width, work.height);
      sharpCtx.globalCompositeOperation = 'destination-in';
      sharpCtx.imageSmoothingEnabled = true;
      sharpCtx.drawImage(grid, 0, 0, work.width, work.height);
      sharpCtx.globalCompositeOperation = 'source-over';
    }

    const out = (this.out = sized(this.out, work.width, work.height));
    const outCtx = out.getContext('2d');
    if (outCtx) {
      outCtx.globalCompositeOperation = 'copy';
      outCtx.drawImage(soft, 0, 0);
      outCtx.globalCompositeOperation = 'source-over';
      outCtx.drawImage(sharp, 0, 0);
    }
    return out;
  }

  /** Every canvas's pixels, which a WebView holds until the element is collected otherwise. */
  dispose(): void {
    for (const canvas of [this.grid, this.soft, this.sharp, this.out]) {
      if (!canvas) continue;
      canvas.width = 0;
      canvas.height = 0;
    }
    this.grid = this.soft = this.sharp = this.out = null;
  }
}

/** `canvas` at `width` x `height`, made when there is none; resizing clears it, which every caller wants. */
function sized(canvas: HTMLCanvasElement | null, width: number, height: number): HTMLCanvasElement {
  const out = canvas ?? document.createElement('canvas');
  if (out.width !== width || out.height !== height) {
    out.width = width;
    out.height = height;
  }
  return out;
}
