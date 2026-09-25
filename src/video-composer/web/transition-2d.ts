import { maskAlpha, type RGB, type TransitionSide } from '../../editor/transitions';
import type { ComposeTransitionMask } from '../definitions';

import type { Frame } from './geometry';
import type { LayerDraw, TransitionDraw } from './painter';

/**
 * A transition without a GPU: the painter's fallback for a browser with no WebGL2, or one whose GL
 * refused a frame. Best effort, and honest about where it is not the contract.
 *
 * The shape is the GPU path's. Each side is drawn WHOLE - black, then its picture through the very
 * routine the fallback draws any layer with - into a frame-sized canvas of its own; that frame is
 * worked on in its own coordinates (blur, mosaic, colour split, gain, tint, in the contract's order);
 * and the finished frame is then placed on the output by the canvas's own transform, the outgoing
 * side over black and the incoming side over that through the mask.
 *
 * A zoom needs nothing here either: the painter's `drawLayer2d`, which `drawSide` is, draws a side
 * through its layer's camera onto the side's surface, so each side arrives as its clip's frame seen
 * through the camera - the order `ComposeCamera` asks for - and everything below acts on it in
 * output pixels as it always did.
 *
 * What it gets exactly right: the move, scale and turn (a canvas transform IS the forward mapping
 * the contract inverts), the gain (repeated additive draws, each clamped at white exactly as
 * `min(rgb * gain, 1)` clamps), the tint (a fill at the tint's alpha is `mix`), and the mask, which
 * is `maskAlpha` itself, evaluated on a grid no longer than [MASK_LONGEST_SIDE] and stretched.
 *
 * What it approximates, and why that is acceptable for a path that should almost never run:
 *
 *  - BLUR is the canvas's `blur()` filter, which is a Gaussian of the same sigma, where the browser
 *    has one. The edge clamp is imitated by stretching the frame's outermost pixels over a margin
 *    before blurring. A browser without canvas filters draws the side sharp.
 *  - The MOSAIC takes the colour at each cell's centre, as the contract does, but a cell cut by the
 *    frame's edge is drawn from the part of it that is on the frame rather than from the clamped edge.
 *  - The colour SPLIT shifts whole channels, leaving black rather than the clamped edge in the strip
 *    a shifted channel uncovers, and it is applied to the mosaic's result rather than read through
 *    it - no catalogue transition uses the two at once.
 *  - A mask on a large frame is stretched from the smaller grid, so its edge is up to a few pixels
 *    softer than the feather says.
 */

/** The longest side of the grid a mask is evaluated on. A 1080x1920 mask is then 90x160. */
const MASK_LONGEST_SIDE = 160;

/** The same threshold the GPU path uses, below which a blur changes no 8-bit value. */
const MIN_BLUR_PX = 0.25;

type Surface = { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D };

export class Transition2d {
  private readonly surfaces = new Map<string, Surface>();
  private mask: { image: ImageData; key: string } | null = null;
  private filters: boolean | null = null;

  constructor(private readonly output: Frame) {}

  /**
   * The whole transition onto `ctx`, over every pixel of it - the outgoing side over black and the
   * incoming side over that - exactly as the GPU path replaces the frame. `drawSide` draws one layer
   * onto a context the size of the output; it is the painter's own fallback layer routine.
   */
  paint(ctx: CanvasRenderingContext2D, draw: TransitionDraw, drawSide: (into: CanvasRenderingContext2D, layer: LayerDraw) => void): void {
    const { width, height } = this.output;
    const alpha = Math.min(1, draw.look.alpha);
    const from = hasPicture(draw.from) ? this.prepare('from', draw.from, draw.look.from, draw.transition.fromTint, drawSide) : null;
    // Not even prepared at no alpha, as on the GPU: it would be drawn, blurred and then not placed.
    const to = hasPicture(draw.to) && alpha > 0 ? this.prepare('to', draw.to, draw.look.to, draw.transition.toTint, drawSide) : null;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, width, height);
    if (from) this.place(ctx, from, draw.look.from);

    if (to) {
      const mask = draw.transition.mask;
      if (mask) {
        // The incoming side is placed on a clear layer first and cut by the mask there, so the mask
        // cuts the SIDE and not the outgoing picture already on the frame.
        const layer = this.surface('layer', width, height);
        reset(layer.ctx);
        layer.ctx.clearRect(0, 0, width, height);
        this.place(layer.ctx, to, draw.look.to);
        layer.ctx.globalCompositeOperation = 'destination-in';
        layer.ctx.imageSmoothingEnabled = true;
        layer.ctx.drawImage(this.maskCanvas(mask, draw.look.reveal), 0, 0, width, height);
        layer.ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = alpha;
        ctx.drawImage(layer.canvas, 0, 0);
      } else {
        ctx.globalAlpha = alpha;
        this.place(ctx, to, draw.look.to);
      }
    }
    ctx.restore();
  }

  /** Lets go of every canvas; a canvas sized to nothing gives its backing store back at once. */
  dispose(): void {
    for (const surface of this.surfaces.values()) {
      surface.canvas.width = 0;
      surface.canvas.height = 0;
    }
    this.surfaces.clear();
    this.mask = null;
  }

  /* ------------------------------------------------------------------------------------------ */

  /**
   * One side's whole frame, worked on in its own coordinates: drawn, blurred, pixelated, split,
   * brightened and tinted - the contract's order, every step but the move.
   */
  private prepare(
    name: 'from' | 'to',
    layer: LayerDraw,
    side: TransitionSide,
    tint: RGB | undefined,
    drawSide: (into: CanvasRenderingContext2D, layer: LayerDraw) => void,
  ): HTMLCanvasElement {
    const { width, height } = this.output;
    const frame = this.surface(name, width, height);
    const c = frame.ctx;
    reset(c);
    c.fillStyle = '#000';
    c.fillRect(0, 0, width, height);
    drawSide(c, layer);
    reset(c);

    const sigma = side.blur * Math.min(width, height);
    if (sigma >= MIN_BLUR_PX && this.hasFilters(c)) this.blur(frame, sigma);
    const cell = side.pixelate * Math.min(width, height);
    if (side.pixelate > 0 && cell > 1) this.pixelate(frame, cell);
    const shift = side.split * width;
    if (shift !== 0) this.split(frame, shift);
    if (side.gain !== 1) this.gain(frame, side.gain);
    if (side.tint > 0) {
      const colour = tint ?? [0, 0, 0];
      c.globalAlpha = Math.min(1, side.tint);
      c.fillStyle = `rgb(${colour[0] * 255}, ${colour[1] * 255}, ${colour[2] * 255})`;
      c.fillRect(0, 0, width, height);
      reset(c);
    }
    return frame.canvas;
  }

  /**
   * A side's finished frame onto `ctx`: scaled about the centre, turned clockwise about it, then
   * moved - the forward mapping `sideSource` is the inverse of. A canvas turns clockwise for a
   * positive angle in its y-down space, so there is no sign to flip.
   */
  private place(ctx: CanvasRenderingContext2D, frame: HTMLCanvasElement, side: TransitionSide): void {
    const { width, height } = this.output;
    const scale = side.scale > 1e-6 ? side.scale : 1e-6;
    ctx.save();
    ctx.translate(width / 2 + side.x * width, height / 2 + side.y * height);
    if (side.rotation !== 0) ctx.rotate((side.rotation * Math.PI) / 180);
    ctx.scale(scale, scale);
    ctx.drawImage(frame, -width / 2, -height / 2);
    ctx.restore();
  }

  /**
   * The canvas's own Gaussian, with the frame's outermost pixels stretched over a margin first so
   * the blur reads the edge beyond the edge - the contract's clamp - rather than transparent black,
   * which would darken every blurred side into a vignette.
   */
  private blur(frame: Surface, sigma: number): void {
    const { width, height } = this.output;
    const pad = Math.ceil(3 * sigma);
    // A surface of its own rather than the frame-sized `work` the gain and the split use: shared, a
    // bloom - blurred, then brightened - would resize that canvas twice on every frame of it.
    const work = this.surface('margin', width + 2 * pad, height + 2 * pad);
    const w = work.ctx;
    reset(w);
    w.clearRect(0, 0, width + 2 * pad, height + 2 * pad);
    w.drawImage(frame.canvas, pad, pad);
    // Edges, then corners: each a one-pixel strip of the frame stretched across the margin.
    w.drawImage(frame.canvas, 0, 0, 1, height, 0, pad, pad, height);
    w.drawImage(frame.canvas, width - 1, 0, 1, height, pad + width, pad, pad, height);
    w.drawImage(frame.canvas, 0, 0, width, 1, pad, 0, width, pad);
    w.drawImage(frame.canvas, 0, height - 1, width, 1, pad, pad + height, width, pad);
    w.drawImage(frame.canvas, 0, 0, 1, 1, 0, 0, pad, pad);
    w.drawImage(frame.canvas, width - 1, 0, 1, 1, pad + width, 0, pad, pad);
    w.drawImage(frame.canvas, 0, height - 1, 1, 1, 0, pad + height, pad, pad);
    w.drawImage(frame.canvas, width - 1, height - 1, 1, 1, pad + width, pad + height, pad, pad);

    const c = frame.ctx;
    c.filter = `blur(${sigma}px)`;
    c.drawImage(work.canvas, -pad, -pad);
    c.filter = 'none';
  }

  /**
   * The mosaic: the frame read at the centre of every cell and drawn back a cell to a colour. The
   * cells are laid out from the frame's centre, as the contract lays them, by starting the grid at
   * the last cell boundary at or before the frame's top-left corner.
   */
  private pixelate(frame: Surface, cell: number): void {
    const { width, height } = this.output;
    const x0 = width / 2 - Math.ceil(width / 2 / cell) * cell;
    const y0 = height / 2 - Math.ceil(height / 2 / cell) * cell;
    const across = Math.max(1, Math.ceil((width - x0) / cell));
    const down = Math.max(1, Math.ceil((height - y0) / cell));
    const cells = this.surface('cells', across, down);
    reset(cells.ctx);
    cells.ctx.clearRect(0, 0, across, down);
    // Smoothing OFF both ways: going down it reads the one pixel at each cell's centre, which is what
    // the contract samples, and coming back up it paints each cell one flat colour.
    cells.ctx.imageSmoothingEnabled = false;
    cells.ctx.drawImage(frame.canvas, x0, y0, across * cell, down * cell, 0, 0, across, down);
    const c = frame.ctx;
    c.imageSmoothingEnabled = false;
    c.drawImage(cells.canvas, 0, 0, across, down, x0, y0, across * cell, down * cell);
    c.imageSmoothingEnabled = true;
  }

  /**
   * Red read `shift` to the right and blue `shift` to the left: each channel isolated by multiplying
   * the shifted frame by its pure primary, and the three added back together.
   */
  private split(frame: Surface, shift: number): void {
    const { width, height } = this.output;
    const work = this.surface('work', width, height);
    const sum = this.surface('sum', width, height);
    reset(sum.ctx);
    sum.ctx.fillStyle = '#000';
    sum.ctx.fillRect(0, 0, width, height);
    sum.ctx.globalCompositeOperation = 'lighter';
    for (const [dx, primary] of [
      [-shift, '#f00'],
      [0, '#0f0'],
      [shift, '#00f'],
    ] as const) {
      const w = work.ctx;
      reset(w);
      w.fillStyle = '#000';
      w.fillRect(0, 0, width, height);
      w.drawImage(frame.canvas, dx, 0);
      w.globalCompositeOperation = 'multiply';
      w.fillStyle = primary;
      w.fillRect(0, 0, width, height);
      sum.ctx.drawImage(work.canvas, 0, 0, width, height, 0, 0, width, height);
    }
    reset(sum.ctx);
    reset(frame.ctx);
    frame.ctx.drawImage(sum.canvas, 0, 0, width, height, 0, 0, width, height);
  }

  /**
   * `min(rgb * gain, 1)`, exactly, with no filter: above one, the frame is added onto itself once
   * per whole step and once more at the fraction left, each addition saturating at white; below
   * one, black is laid over it at `1 - gain`.
   */
  private gain(frame: Surface, gain: number): void {
    const { width, height } = this.output;
    const c = frame.ctx;
    if (gain < 1) {
      c.globalAlpha = 1 - Math.max(0, gain);
      c.fillStyle = '#000';
      c.fillRect(0, 0, width, height);
      reset(c);
      return;
    }
    const copy = this.surface('work', width, height);
    reset(copy.ctx);
    copy.ctx.drawImage(frame.canvas, 0, 0);
    c.globalCompositeOperation = 'lighter';
    for (let left = gain - 1; left > 0; left -= 1) {
      c.globalAlpha = Math.min(1, left);
      c.drawImage(copy.canvas, 0, 0, width, height, 0, 0, width, height);
    }
    reset(c);
  }

  /** `maskAlpha` over a grid no longer than [MASK_LONGEST_SIDE], as the alpha of a small canvas. */
  private maskCanvas(mask: ComposeTransitionMask, reveal: number): HTMLCanvasElement {
    const { width, height } = this.output;
    const k = Math.min(1, MASK_LONGEST_SIDE / Math.max(width, height));
    const across = Math.max(1, Math.round(width * k));
    const down = Math.max(1, Math.round(height * k));
    const surface = this.surface('mask', across, down);
    const key = `${across}x${down}`;
    if (!this.mask || this.mask.key !== key) this.mask = { image: surface.ctx.createImageData(across, down), key };
    const data = this.mask.image.data;
    for (let j = 0; j < down; j++) {
      const qy = ((j + 0.5) * height) / down;
      for (let i = 0; i < across; i++) {
        const qx = ((i + 0.5) * width) / across;
        data[(j * across + i) * 4 + 3] = Math.round(maskAlpha(mask, reveal, qx, qy, width, height) * 255);
      }
    }
    surface.ctx.putImageData(this.mask.image, 0, 0);
    return surface.canvas;
  }

  /**
   * Whether this browser's canvas takes CSS filters at all. Asked once.
   *
   * The property is looked for BEFORE it is written. On a canvas without it - Safari before 18 -
   * writing `filter` makes an ordinary property of that name on the context, which reads back
   * exactly what was written and would pass a write-then-read test for a filter that draws nothing.
   */
  private hasFilters(ctx: CanvasRenderingContext2D): boolean {
    if (this.filters === null) {
      if (typeof ctx.filter !== 'string') {
        this.filters = false;
      } else {
        const before = ctx.filter;
        try {
          ctx.filter = 'blur(1px)';
          this.filters = ctx.filter === 'blur(1px)';
        } catch {
          this.filters = false;
        }
        ctx.filter = before;
      }
    }
    return this.filters;
  }

  /** A canvas of one purpose, made once and resized only when the size it is asked for changes. */
  private surface(name: string, width: number, height: number): Surface {
    const existing = this.surfaces.get(name);
    if (existing) {
      if (existing.canvas.width !== width || existing.canvas.height !== height) {
        existing.canvas.width = width;
        existing.canvas.height = height;
      }
      return existing;
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('this browser would not give the renderer a 2D canvas');
    const surface = { canvas, ctx };
    this.surfaces.set(name, surface);
    return surface;
  }
}

/** Every piece of state a step below may have left behind, back to the canvas's defaults. */
function reset(ctx: CanvasRenderingContext2D): void {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
}

function hasPicture(layer: LayerDraw | null): layer is LayerDraw {
  return layer !== null && layer.sourceWidth > 0 && layer.sourceHeight > 0;
}
