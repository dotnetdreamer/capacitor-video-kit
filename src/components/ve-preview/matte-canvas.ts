import type { PeopleMaskFrame } from '../../editor/people-matte';
import type { EditorStore } from '../../state/editor-store';

/**
 * The people put back over the layers behind them ([OverlayCommon.behind]) on the preview: a canvas between those
 * layers' `<img>`s and every other layer's, showing the preview's own picture - the composited canvas under it all,
 * which holds the video and nothing else - wherever the people are at the frame's instant
 * ([EditorStore.peopleMaskAt]). So a title behind a dancer is behind her on the frame as it is in the file.
 *
 * Drawn as the picture is, a frame at a time: the composited canvas hands [paint] the instant of every frame it
 * paints, right after painting it, so the people are never a frame ahead of or behind the picture they are cut from.
 * While no layer behind anybody is on screen it is emptied once, hidden, and does nothing more. The mask is the
 * store's grid of the output frame, drawn into a canvas of the grid's own size only when the grid changes, and
 * stretched over the picture with the canvas's own smoothing, `destination-in`, which leaves the picture where the
 * people are. The export eases the mask's edge as well (`matte-pass.ts`), which a stretch cannot; the two differ by
 * less than a cell.
 */
export class MatteCanvas {
  private readonly ctx: CanvasRenderingContext2D | null;
  private readonly grid = document.createElement('canvas');
  private image: ImageData | null = null;
  /** The grid last drawn into [grid], so a frame whose people have not moved draws none of it again. */
  private drawnVersion = -1;
  private drawnCells: Uint8Array | null = null;
  private shown = false;
  private destroyed = false;

  constructor(
    private readonly store: EditorStore,
    private readonly canvas: HTMLCanvasElement,
    /** The composited picture: the preview's canvas, which this cuts the people out of. */
    private readonly picture: HTMLCanvasElement,
  ) {
    this.ctx = canvas.getContext('2d');
    canvas.hidden = true;
  }

  /** The picture has just been painted with output instant `atMs`: the people at that instant, cut out of it. */
  paint(atMs: number): void {
    const ctx = this.ctx;
    if (!ctx || this.destroyed) return;
    // The crop sheet draws its segment as a tool and not as the post: the people would be cut out of a picture that is not the frame.
    const mask = this.store.panel.value === 'crop' ? null : this.store.peopleMaskAt(atMs);
    const width = this.picture.width;
    const height = this.picture.height;
    if (!mask?.any || !(width > 0) || !(height > 0)) {
      this.hide();
      return;
    }
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    if (!this.drawGrid(mask)) {
      this.hide();
      return;
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'copy';
    ctx.drawImage(this.picture, 0, 0);
    ctx.globalCompositeOperation = 'destination-in';
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.grid, 0, 0, width, height);
    ctx.globalCompositeOperation = 'source-over';
    if (!this.shown) {
      this.canvas.hidden = false;
      this.shown = true;
    }
  }

  destroy(): void {
    this.destroyed = true;
    this.canvas.width = 0;
    this.canvas.height = 0;
    this.grid.width = 0;
    this.grid.height = 0;
    this.image = null;
  }

  /** The mask's cells as the grid canvas's alpha, a person opaque; false where the canvas will not draw. */
  private drawGrid(mask: PeopleMaskFrame): boolean {
    const ctx = this.grid.getContext('2d');
    if (!ctx) return false;
    if (mask.version === this.drawnVersion && mask.cells === this.drawnCells && this.grid.width === mask.width && this.grid.height === mask.height) return true;
    if (this.grid.width !== mask.width || this.grid.height !== mask.height) {
      this.grid.width = mask.width;
      this.grid.height = mask.height;
      this.image = null;
    }
    const image = this.image ?? (this.image = ctx.createImageData(mask.width, mask.height));
    const data = image.data;
    const cells = mask.cells;
    for (let c = 0; c < cells.length; c++) data[c * 4 + 3] = cells[c] ? 255 : 0;
    ctx.putImageData(image, 0, 0);
    this.drawnVersion = mask.version;
    this.drawnCells = mask.cells;
    return true;
  }

  /** Nobody to put back: emptied once, and out of the page's compositing until somebody is. */
  private hide(): void {
    if (!this.shown) return;
    this.shown = false;
    this.canvas.hidden = true;
    this.ctx?.clearRect(0, 0, this.canvas.width, this.canvas.height);
  }
}
