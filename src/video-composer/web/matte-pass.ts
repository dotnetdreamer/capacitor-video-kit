import type { OverlayMotionSample } from '../../editor/motion';

import type { Frame } from './geometry';
import { drawQuad2d, quadHomography, type QuadDraw } from './quad-layers';
import { link, type Program } from './transition-gl';

/**
 * The people put back over the layers behind them ([ComposeSpec.matte]) in a web render: the frame's video drawn
 * AGAIN over those layers, its alpha the matte at the frame's instant read as a focus mask is read - bilinear
 * between the cells' centres, then eased, `e = m * m * (3 - 2 m)` - which is what Android's `LayerUnderlayEffect`
 * draws. The painter keeps the video before the layers behind go on ([MatteGl.keep]), draws them, and then this.
 *
 * A layer behind the people that is not on a surface is drawn through a quad as well, its four corners where the
 * painter's own overlay drawing puts them ([flatCorners]), so the layers behind are one kind of draw in one pass
 * between the video and the matte. Without WebGL2 the 2D canvas does both: the corners as one transform where
 * they make a parallelogram, and the matte by `destination-in` through the cell grid stretched with the canvas's
 * smoothing - the ease given up there, as the 2D focus gives it up.
 */

/** What the painter puts the people back with at one frame: the matte's grid then. */
export interface MatteDraw {
  /** The matte's `m` at this instant, 0..255 a cell, row by row from the OUTPUT frame's top-left (`focusMask`). */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  /** Names `mask`'s contents, as a focus's key does: the same key is the same grid, and its upload is skipped. */
  maskKey: string;
}

/**
 * A flat layer's four corners on the output frame - fractions of it, top-left, top-right, bottom-right, bottom-left -
 * exactly where `Painter.paintOverlay` draws its bitmap: centred on (cx, cy) moved by the motion, `wPx` by `hPx`
 * times the motion's scale, turned clockwise by its angle and the motion's. Null where it is drawn as nothing.
 */
export function flatCorners(
  layer: { cx: number; cy: number; wPx: number; hPx: number; rotationDeg: number },
  motion: Pick<OverlayMotionSample, 'x' | 'y' | 'scale' | 'rotation'> | null,
  frame: Frame,
): number[] | null {
  const scale = motion?.scale ?? 1;
  const w = layer.wPx * scale;
  const h = layer.hPx * scale;
  if (!(w > 0) || !(h > 0)) return null;
  const cx = (layer.cx + (motion?.x ?? 0)) * frame.width;
  const cy = (layer.cy + (motion?.y ?? 0)) * frame.height;
  const radians = ((layer.rotationDeg + (motion?.rotation ?? 0)) * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  const out: number[] = [];
  for (const [dx, dy] of [
    [-w / 2, -h / 2],
    [w / 2, -h / 2],
    [w / 2, h / 2],
    [-w / 2, h / 2],
  ] as const) {
    out.push((cx + dx * cos - dy * sin) / frame.width, (cy + dx * sin + dy * cos) / frame.height);
  }
  return out;
}

/** Whether `quad` draws anything on `frame`: some opacity, and a quad an engine draws. */
export function drawsSomething(quad: QuadDraw, frame: Frame): boolean {
  return quad.opacity > 0 && quadHomography(quad.corners, frame) !== null;
}

/**
 * One layer of the matte's pass onto a 2D context: a parallelogram - every flat layer, and a surface seen square on -
 * as the one affine map it is, with no seam down a diagonal; anything foreshortened through `drawQuad2d`'s cells.
 */
export function drawUnder2d(ctx: CanvasRenderingContext2D, quad: QuadDraw, frame: Frame): void {
  const h = quadHomography(quad.corners, frame);
  if (!h || !(quad.opacity > 0)) return;
  const w = h[8]!;
  if (!(Math.abs(h[6]!) <= 1e-12 * Math.abs(w) && Math.abs(h[7]!) <= 1e-12 * Math.abs(w))) {
    drawQuad2d(ctx, quad, frame);
    return;
  }
  const bitmap = quad.bitmap;
  const bw = 'naturalWidth' in bitmap ? bitmap.naturalWidth : bitmap.width;
  const bh = 'naturalHeight' in bitmap ? bitmap.naturalHeight : bitmap.height;
  if (!(bw > 0) || !(bh > 0)) return;
  ctx.save();
  ctx.globalAlpha = Math.min(1, quad.opacity);
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
  // The unit square onto the parallelogram, per bitmap pixel: x' = h0 u + h1 v + h2 with u = x / bw, v = y / bh.
  ctx.setTransform(h[0]! / w / bw, h[3]! / w / bw, h[1]! / w / bh, h[4]! / w / bh, h[2]! / w, h[5]! / w);
  ctx.drawImage(bitmap, 0, 0, bw, bh);
  ctx.restore();
}

/*
 * The frame again through the matte. The kept picture is the framebuffer's own, rows from the bottom as GL keeps
 * them, so it is read at the fragment's own place; the grid's rows run from the top, so it is read at 1 - v.
 */
const MATTE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_frame;
uniform sampler2D u_mask;
uniform vec2 u_size;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float m = texture(u_mask, vec2(uv.x, 1.0 - uv.y)).r;
  float e = m * m * (3.0 - 2.0 * m);
  // Premultiplied, as the blend expects: the picture at e over what the layers behind left.
  fragColor = vec4(texture(u_frame, uv).rgb * e, e);
}`;

/** The matte pass on the GPU: the kept frame, the grid, and the program that mixes the one back by the other. */
export class MatteGl {
  private frameSize = { width: 0, height: 0 };
  private maskKey = '';
  private maskSize = { width: 0, height: 0 };

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly program: Program,
    private readonly frame: WebGLTexture,
    private readonly mask: WebGLTexture,
  ) {}

  /**
   * The program on `gl`, or null for a context that will not build it - the painter draws the matte on its 2D canvas
   * then. `position` is the attribute the painter's own quad is bound to, which the program draws its square with.
   */
  static build(gl: WebGL2RenderingContext, position: number): MatteGl | null {
    const program = link(gl, MATTE_FRAGMENT, position, ['u_frame', 'u_mask', 'u_size']);
    if (!program) return null;
    const frame = gl.createTexture();
    const mask = gl.createTexture();
    if (!frame || !mask) {
      gl.deleteProgram(program.program);
      if (frame) gl.deleteTexture(frame);
      if (mask) gl.deleteTexture(mask);
      return null;
    }
    // The kept frame is read texel for texel; the grid between its cells' centres, its edges clamped, as a focus's.
    for (const [texture, filter] of [
      [frame, gl.NEAREST],
      [mask, gl.LINEAR],
    ] as const) {
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
    const inUse = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    gl.useProgram(program.program);
    gl.uniform1i(program.uniforms['u_frame'] ?? null, 0);
    gl.uniform1i(program.uniforms['u_mask'] ?? null, 1);
    gl.useProgram(inUse);
    return new MatteGl(gl, program, frame, mask);
  }

  /** The picture in the bound framebuffer, kept to draw again: taken before the layers behind go on. RGB, as an opaque frame is. */
  keep(size: Frame): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    if (this.frameSize.width !== size.width || this.frameSize.height !== size.height) {
      gl.copyTexImage2D(gl.TEXTURE_2D, 0, gl.RGB, 0, 0, size.width, size.height, 0);
      this.frameSize = { width: size.width, height: size.height };
    } else {
      gl.copyTexSubImage2D(gl.TEXTURE_2D, 0, 0, 0, 0, 0, size.width, size.height);
    }
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  /** The kept picture over the bound framebuffer, its alpha the matte eased. Leaves blending off and units 0 and 1 empty. */
  draw(matte: MatteDraw, size: Frame): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.mask);
    if (matte.maskKey !== this.maskKey || matte.maskWidth !== this.maskSize.width || matte.maskHeight !== this.maskSize.height) {
      // A grid's rows are one byte a cell, so a width that is not a multiple of four is not padded.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, matte.maskWidth, matte.maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, matte.mask);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      this.maskKey = matte.maskKey;
      this.maskSize = { width: matte.maskWidth, height: matte.maskHeight };
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.frame);
    gl.useProgram(this.program.program);
    gl.uniform2f(this.program.uniforms['u_size'] ?? null, size.width, size.height);
    gl.viewport(0, 0, size.width, size.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, null);
  }

  dispose(): void {
    const gl = this.gl;
    gl.deleteTexture(this.frame);
    gl.deleteTexture(this.mask);
    gl.deleteProgram(this.program.program);
  }
}

/** The matte pass on a 2D canvas: the frame kept, the grid as a canvas of its own, and the people cut out through it. */
export class Matte2d {
  private kept: HTMLCanvasElement | null = null;
  private grid: HTMLCanvasElement | null = null;
  private people: HTMLCanvasElement | null = null;
  private gridKey = '';

  /** The picture on `ctx`, kept to draw again: taken before the layers behind go on. */
  keep(ctx: CanvasRenderingContext2D, size: Frame): void {
    const kept = (this.kept = sized(this.kept, size.width, size.height));
    const keptCtx = kept.getContext('2d');
    if (!keptCtx) return;
    keptCtx.globalAlpha = 1;
    keptCtx.globalCompositeOperation = 'copy';
    keptCtx.drawImage(ctx.canvas, 0, 0, size.width, size.height);
  }

  /** The kept picture over `ctx` where the matte says people are, each cell eased and the canvas smoothing between them. */
  draw(ctx: CanvasRenderingContext2D, matte: MatteDraw, size: Frame): void {
    if (!this.kept) return;
    const grid = (this.grid = sized(this.grid, matte.maskWidth, matte.maskHeight));
    const gridCtx = grid.getContext('2d');
    if (!gridCtx) return;
    if (this.gridKey !== matte.maskKey) {
      const image = gridCtx.createImageData(matte.maskWidth, matte.maskHeight);
      for (let c = 0; c < matte.mask.length; c++) {
        const m = matte.mask[c]! / 255;
        image.data[c * 4 + 3] = Math.round(m * m * (3 - 2 * m) * 255);
      }
      gridCtx.putImageData(image, 0, 0);
      this.gridKey = matte.maskKey;
    }
    const people = (this.people = sized(this.people, size.width, size.height));
    const peopleCtx = people.getContext('2d');
    if (!peopleCtx) return;
    peopleCtx.globalCompositeOperation = 'copy';
    peopleCtx.drawImage(this.kept, 0, 0);
    peopleCtx.globalCompositeOperation = 'destination-in';
    peopleCtx.imageSmoothingEnabled = true;
    peopleCtx.drawImage(grid, 0, 0, size.width, size.height);
    peopleCtx.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.drawImage(people, 0, 0);
    ctx.restore();
  }

  /** Every canvas's pixels, which a WebView holds until the element is collected otherwise. */
  dispose(): void {
    for (const canvas of [this.kept, this.grid, this.people]) {
      if (!canvas) continue;
      canvas.width = 0;
      canvas.height = 0;
    }
    this.kept = this.grid = this.people = null;
    this.gridKey = '';
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
