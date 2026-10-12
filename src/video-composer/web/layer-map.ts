import { isIdentityView } from '../../editor/camera';

import { cameraAffine } from './camera-draw';
import { FULL_FRAME, sourceWindow, type Frame } from './geometry';
import type { LayerDraw } from './painter';

/**
 * Where a layer's SOURCE lands on the output, and back: the painter's own placement - the window its
 * crop and fit make, the rectangle it is cut to, its turn about that rectangle's centre in output
 * pixels, and the camera after that - as arithmetic on points rather than on pixels, so a tap on the
 * preview can name the source pixel under it and a mark can be put where a source point is drawn.
 *
 * The layer program's vertex shader is the reference (`painter.ts`): a corner of the layer's frame at
 * `a` is sampled from `window.xy + a * window.wh` and drawn at `dest.xy + a * dest.wh` of the output,
 * turned about the pivot and then scaled by the camera. Nothing here may disagree with it, which is
 * why it reads the same [LayerDraw] the painter is handed.
 */
export class LayerMap {
  private readonly window;
  private readonly bounds;
  private readonly pivot: { x: number; y: number };
  private readonly cos: number;
  private readonly sin: number;
  private readonly camera: { scale: number; tx: number; ty: number };

  constructor(
    private readonly layer: Pick<LayerDraw, 'framing' | 'dest' | 'sourceWidth' | 'sourceHeight' | 'rotationDeg' | 'camera'>,
    private readonly output: Frame,
  ) {
    const frame: Frame = {
      width: Math.max(1, Math.round(layer.dest.w * output.width)),
      height: Math.max(1, Math.round(layer.dest.h * output.height)),
    };
    this.window = sourceWindow(layer.framing, frame, layer.sourceWidth, layer.sourceHeight);
    // The painter's `boundsOf`: a base clip keeps its rectangle inside a destination that is the whole frame.
    const rect = layer.framing.rect;
    this.bounds = rect ? { x: layer.dest.x + rect.x * layer.dest.w, y: layer.dest.y + rect.y * layer.dest.h, w: rect.w * layer.dest.w, h: rect.h * layer.dest.h } : layer.dest;
    this.pivot = { x: (this.bounds.x + this.bounds.w / 2) * output.width, y: (this.bounds.y + this.bounds.h / 2) * output.height };
    const radians = ((layer.rotationDeg ?? 0) * Math.PI) / 180;
    this.cos = Math.cos(radians);
    this.sin = Math.sin(radians);
    this.camera = layer.camera && !isIdentityView(layer.camera) ? cameraAffine(layer.camera, output) : { scale: 1, tx: 0, ty: 0 };
  }

  /**
   * The source point - 0..1 of the oriented source, top-left - drawn at output pixel (`x`, `y`), or
   * null where the layer draws no picture there: outside its rectangle, in a letterbox bar, or on the
   * part of the source its crop takes away.
   */
  toSource(x: number, y: number): { u: number; v: number } | null {
    // The camera undone, then the turn, which the shader applied in that order the other way round.
    const px = (x - this.camera.tx) / this.camera.scale;
    const py = (y - this.camera.ty) / this.camera.scale;
    const dx = px - this.pivot.x;
    const dy = py - this.pivot.y;
    const ox = (this.pivot.x + dx * this.cos + dy * this.sin) / this.output.width;
    const oy = (this.pivot.y - dx * this.sin + dy * this.cos) / this.output.height;
    const b = this.bounds;
    if (ox < b.x || oy < b.y || ox > b.x + b.w || oy > b.y + b.h) return null;
    const dest = this.layer.dest;
    const u = this.window.x + ((ox - dest.x) / dest.w) * this.window.w;
    const v = this.window.y + ((oy - dest.y) / dest.h) * this.window.h;
    const kept = this.layer.framing.crop ?? FULL_FRAME;
    if (u < kept.x || v < kept.y || u > kept.x + kept.w || v > kept.y + kept.h || u < 0 || v < 0 || u > 1 || v > 1) return null;
    return { u, v };
  }

  /** The output pixel source point (`u`, `v`) is drawn at, wherever that is, on the frame or off it. */
  toOutput(u: number, v: number): { x: number; y: number } {
    const dest = this.layer.dest;
    const ox = (dest.x + ((u - this.window.x) / this.window.w) * dest.w) * this.output.width;
    const oy = (dest.y + ((v - this.window.y) / this.window.h) * dest.h) * this.output.height;
    const dx = ox - this.pivot.x;
    const dy = oy - this.pivot.y;
    const px = this.pivot.x + dx * this.cos - dy * this.sin;
    const py = this.pivot.y + dx * this.sin + dy * this.cos;
    return { x: px * this.camera.scale + this.camera.tx, y: py * this.camera.scale + this.camera.ty };
  }
}
