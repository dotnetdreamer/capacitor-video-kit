import { cutoutPixels } from '../../editor/cutout-pixels';

import { REVEAL_GLOW, type CutoutDraw } from './cutout-gl';
import type { Frame } from './geometry';

/**
 * The longest side a frame is cut out at without a shader. The contract on the CPU ([cutoutPixels]) is
 * a few dozen operations a pixel; at this size a frame costs a few milliseconds, and the canvas's own
 * smoothing takes it up to the size it is drawn at.
 */
const MAX_SIDE_2D = 480;

/**
 * A clip's cutout without a shader, for the painter's 2D path: a browser with no WebGL2.
 *
 * Unlike the 2D focus it is the contract itself, steps 3 to 8, on the CPU - the same function that
 * draws a cut-out photo's bitmap - only at a smaller size, so the fallback's edge is the GPU path's
 * edge seen softer. The frame is graded on the way in, with the canvas's own `filter` and the tints
 * laid over it, so the guide is the graded picture and an outline or a fill keeps its own colour, as
 * on the GPU path; the painter then draws what comes back with no grade of its own. A canvas another
 * origin's picture has tainted cannot be read: the frame is drawn as it is then.
 */
export class Cutout2d {
  private work: HTMLCanvasElement | null = null;

  /**
   * `picture` cut out onto a canvas of this object's own - STRAIGHT colour with the cutout's alpha,
   * graded by `filter` and `tints` - valid until the next call, or null where its pixels cannot be read.
   * The canvas is at most [MAX_SIDE_2D] on its longer side and in the picture's proportion; `work` is
   * the size the caller would have cut it out at.
   */
  apply(picture: CanvasImageSource, cutout: CutoutDraw, work: Frame, filter: string, tints: readonly string[]): HTMLCanvasElement | null {
    const scale = Math.min(1, MAX_SIDE_2D / Math.max(work.width, work.height));
    const width = Math.max(1, Math.round(work.width * scale));
    const height = Math.max(1, Math.round(work.height * scale));
    const canvas = (this.work = sized(this.work, width, height));
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.globalCompositeOperation = 'copy';
    ctx.globalAlpha = 1;
    ctx.filter = filter;
    ctx.drawImage(picture, 0, 0, width, height);
    ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-atop';
    for (const tint of tints) {
      ctx.fillStyle = tint;
      ctx.fillRect(0, 0, width, height);
    }
    ctx.globalCompositeOperation = 'source-over';
    let pixels: ImageData;
    try {
      pixels = ctx.getImageData(0, 0, width, height);
    } catch {
      return null;
    }
    const look = {
      soft: cutout.soft,
      shift: cutout.shift,
      ...(cutout.fill ? { fill: cutout.fill } : {}),
      ...(cutout.outline ? { outline: { color: cutout.outline.color, width: outlineWidthOf(cutout) } } : {}),
    };
    const cut = cutoutPixels(pixels.data, width, height, cutout.matte, cutout.matteWidth, cutout.matteHeight, look);
    if (cutout.reveal !== undefined && cutout.reveal < 1) revealOver(pixels.data, cut, cutout.reveal);
    pixels.data.set(cut);
    ctx.putImageData(pixels, 0, 0);
    return canvas;
  }

  /** The canvas's pixels, which a WebView holds until the element is collected otherwise. */
  dispose(): void {
    if (!this.work) return;
    this.work.width = 0;
    this.work.height = 0;
    this.work = null;
  }
}

/**
 * The preview's reveal without a shader, written into `cut`: the picture as it was giving way to the
 * cutout, mixed premultiplied by `reveal` as the composite shader mixes them, and its glow rising and
 * falling round the edge - read off the cut's alpha, which is the subject's own where there is no
 * outline or fill, and near enough to it where there is. Both buffers are straight RGBA.
 */
export function revealOver(picture: Uint8ClampedArray, cut: Uint8ClampedArray, reveal: number): void {
  const t = Math.max(0, Math.min(1, reveal));
  const rise = Math.sin(Math.PI * t);
  for (let p = 0; p < cut.length; p += 4) {
    const was = picture[p + 3]! / 255;
    const now = cut[p + 3]! / 255;
    const glow = 4 * now * (1 - now) * rise;
    const alpha = (was * (1 - t) + now * t) * (1 - glow) + glow;
    for (let c = 0; c < 3; c++) {
      const premultiplied = ((picture[p + c]! / 255) * was * (1 - t) + (cut[p + c]! / 255) * now * t) * (1 - glow) + REVEAL_GLOW[c]! * glow;
      cut[p + c] = alpha > 0 ? Math.round((premultiplied / alpha) * 255) : 0;
    }
    cut[p + 3] = Math.round(alpha * 255);
  }
}

/**
 * The outline's width as a fraction of the shorter side, back from the sigma in cells the draw
 * carries ([CutoutDraw.outline]): `cutoutPixels` takes the wire's measure.
 */
function outlineWidthOf(cutout: CutoutDraw): number {
  const sigma = cutout.outline?.sigma ?? 0;
  return (sigma * 1.55) / Math.min(cutout.matteWidth, cutout.matteHeight);
}

function sized(canvas: HTMLCanvasElement | null, width: number, height: number): HTMLCanvasElement {
  const out = canvas ?? document.createElement('canvas');
  if (out.width !== width) out.width = width;
  if (out.height !== height) out.height = height;
  return out;
}
