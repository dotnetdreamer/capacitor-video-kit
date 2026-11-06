import { isConvexQuad, squareToQuad, type Homography } from '../../editor/homography';

import type { Frame } from './geometry';

/**
 * The layers ON a flat surface in a web render ([ComposeOverlay.quad]): each bitmap drawn through the
 * homography that takes its rectangle onto its quad at the frame's instant, foreshortened as the surface
 * is, its alpha and opacity applied as any layer's. Drawn after the video and before every other layer, as
 * every engine draws them.
 *
 * On the GPU, inside the painter's GL pass: the bitmap's unit square is drawn as two triangles whose
 * clip-space w is the homography's own, so the rasteriser's perspective-correct interpolation IS the
 * projective map - the texture is read exactly where the homography says, not along the straight lines of
 * an affine split. The edges are smoothed over a pixel in the shader, since the GL canvas has no
 * multisampling, and the bitmap is mipmapped for a surface far away. Without WebGL2, the 2D canvas draws the
 * square cut into cells, each a pair of triangles placed by its own affine map.
 */

/** One layer on a surface at one instant. */
export interface QuadDraw {
  bitmap: ImageBitmap | HTMLImageElement | HTMLCanvasElement;
  /** Its corners on the output frame, as fractions of it, in the bitmap's own order: top-left, top-right, bottom-right, bottom-left. */
  corners: readonly number[];
  /** 0..1: its own opacity times its motion's. */
  opacity: number;
}

/** The homography taking the bitmap's unit square onto its quad in output pixels, or null for a quad no engine draws: folded, or three corners in a line. */
export function quadHomography(corners: readonly number[], frame: Frame): Homography | null {
  const px = corners.map((v, k) => v * (k % 2 === 0 ? frame.width : frame.height));
  return isConvexQuad(px) ? squareToQuad(px) : null;
}

const VERTEX = `#version 300 es
in vec2 a_pos;
// The unit square onto the quad, in output pixels, and the frame's size.
uniform mat3 u_h;
uniform vec2 u_frame;
// How far past the bitmap's edges, in its own units, the square is drawn: room for the edge to be smoothed.
uniform float u_grow;
out vec2 v_uv;
void main() {
  vec2 uv = mix(vec2(-u_grow), vec2(1.0 + u_grow), a_pos);
  vec3 p = u_h * vec3(uv, 1.0);
  // w is the homography's: divided out by the rasteriser, which interpolates v_uv perspective-correctly.
  gl_Position = vec4(2.0 * p.x / u_frame.x - p.z, p.z - 2.0 * p.y / u_frame.y, 0.0, p.z);
  v_uv = uv;
}`;

const FRAGMENT = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  // Coverage of the bitmap's own rectangle over the pixel, so its edge is smooth rather than stepped.
  vec2 inside = min(v_uv, 1.0 - v_uv);
  vec2 pixel = max(fwidth(v_uv), vec2(1e-6));
  vec2 cover = clamp(inside / pixel + 0.5, 0.0, 1.0);
  // Premultiplied, as the bitmap was uploaded and as the blend expects.
  fragColor = texture(u_tex, clamp(v_uv, 0.0, 1.0)) * (u_opacity * cover.x * cover.y);
}`;

/** The GPU half: one program, one square, and a mipmapped texture per bitmap while it is drawn. */
export class QuadGl {
  private readonly textures = new Map<QuadDraw['bitmap'], WebGLTexture>();

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly program: WebGLProgram,
    private readonly vao: WebGLVertexArrayObject,
    private readonly buffer: WebGLBuffer,
    private readonly uniforms: Record<'h' | 'frame' | 'grow' | 'opacity' | 'tex', WebGLUniformLocation | null>,
  ) {}

  /** The program on `gl`, or null for a context that will not build it - the 2D path draws the quads then. */
  static build(gl: WebGL2RenderingContext): QuadGl | null {
    const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
    const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT);
    const program = vertex && fragment ? gl.createProgram() : null;
    if (!program || !vertex || !fragment) return null;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      return null;
    }
    // A vertex array of its own, so the layer program's square, bound outside any, is left as it was.
    const vao = gl.createVertexArray();
    const buffer = gl.createBuffer();
    if (!vao || !buffer) {
      gl.deleteProgram(program);
      return null;
    }
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, 'a_pos');
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return new QuadGl(gl, program, vao, buffer, {
      h: gl.getUniformLocation(program, 'u_h'),
      frame: gl.getUniformLocation(program, 'u_frame'),
      grow: gl.getUniformLocation(program, 'u_grow'),
      opacity: gl.getUniformLocation(program, 'u_opacity'),
      tex: gl.getUniformLocation(program, 'u_tex'),
    });
  }

  /** `quads`, in order, over whatever the bound framebuffer holds. False where a bitmap would not upload. */
  draw(quads: readonly QuadDraw[], frame: Frame): boolean {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.viewport(0, 0, frame.width, frame.height);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(this.uniforms.tex, 0);
    gl.uniform2f(this.uniforms.frame, frame.width, frame.height);
    let ok = true;
    for (const quad of quads) {
      const h = quadHomography(quad.corners, frame);
      if (!h || !(quad.opacity > 0)) continue;
      const texture = this.textureOf(quad.bitmap);
      if (!texture) {
        ok = false;
        continue;
      }
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // Column by column, as GL reads a mat3.
      gl.uniformMatrix3fv(this.uniforms.h, false, new Float32Array([h[0]!, h[3]!, h[6]!, h[1]!, h[4]!, h[7]!, h[2]!, h[5]!, h[8]!]));
      gl.uniform1f(this.uniforms.grow, 1.5 / Math.max(1, shortestSide(quad.corners, frame)));
      gl.uniform1f(this.uniforms.opacity, Math.min(1, quad.opacity));
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.bindVertexArray(null);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.disable(gl.BLEND);
    return ok;
  }

  /**
   * Every bitmap of `quads` uploaded before anything is drawn: false where one would not be, so a caller drawing
   * several groups in an order of their own - behind the people, then over them - can fall back whole rather than
   * leave a group half drawn.
   */
  prepare(quads: readonly QuadDraw[]): boolean {
    for (const quad of quads) if (!this.textureOf(quad.bitmap)) return false;
    return true;
  }

  /** Lets go of `bitmap`'s texture: its layer's window has closed. */
  forget(bitmap: QuadDraw['bitmap']): void {
    const texture = this.textures.get(bitmap);
    if (texture) this.gl.deleteTexture(texture);
    this.textures.delete(bitmap);
  }

  dispose(): void {
    const gl = this.gl;
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    this.textures.clear();
    gl.deleteVertexArray(this.vao);
    gl.deleteBuffer(this.buffer);
    gl.deleteProgram(this.program);
  }

  /** The bitmap's texture, uploaded premultiplied and mipmapped the first time it is drawn; null where the browser refuses it. */
  private textureOf(bitmap: QuadDraw['bitmap']): WebGLTexture | null {
    const known = this.textures.get(bitmap);
    if (known) return known;
    const gl = this.gl;
    const texture = gl.createTexture();
    if (!texture) return null;
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    } catch {
      gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
      gl.deleteTexture(texture);
      return null;
    }
    // Every other upload of the painter's is opaque video, which expects the default.
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.textures.set(bitmap, texture);
    return texture;
  }
}

/** The quad's shortest side, in output pixels. */
function shortestSide(corners: readonly number[], frame: Frame): number {
  let least = Infinity;
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4;
    least = Math.min(least, Math.hypot((corners[2 * j]! - corners[2 * k]!) * frame.width, (corners[2 * j + 1]! - corners[2 * k + 1]!) * frame.height));
  }
  return least;
}

function compile(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/**
 * How many cells a side the 2D canvas cuts a quad into: enough that the straight lines of each cell's
 * affine map stay within about a pixel of the projective one, as far apart as the quad is foreshortened.
 */
export function quadCells(h: Homography, frame: Frame): number {
  // How unevenly the homography's w runs over the square: 1 for a parallelogram, which one cell draws exactly.
  const ws = [h[8]!, h[6]! + h[8]!, h[6]! + h[7]! + h[8]!, h[7]! + h[8]!];
  const spread = Math.max(...ws) / Math.max(1e-9, Math.min(...ws));
  const size = Math.hypot(frame.width, frame.height);
  return Math.max(1, Math.min(24, Math.ceil(Math.sqrt(Math.max(0, spread - 1) * size) / 3)));
}

/**
 * One layer on a surface onto a 2D context the size of `frame`: the bitmap's square cut into cells, each cell
 * two triangles, each triangle clipped to itself - a hair larger, so neighbours meet without a seam - and
 * drawn through the affine map that takes it onto the homography's image of it.
 */
export function drawQuad2d(ctx: CanvasRenderingContext2D, quad: QuadDraw, frame: Frame): void {
  const h = quadHomography(quad.corners, frame);
  if (!h || !(quad.opacity > 0)) return;
  const bw = 'naturalWidth' in quad.bitmap ? quad.bitmap.naturalWidth : quad.bitmap.width;
  const bh = 'naturalHeight' in quad.bitmap ? quad.bitmap.naturalHeight : quad.bitmap.height;
  if (!(bw > 0) || !(bh > 0)) return;
  const n = quadCells(h, frame);
  const at = (u: number, v: number): { x: number; y: number } => {
    const w = h[6]! * u + h[7]! * v + h[8]!;
    return { x: (h[0]! * u + h[1]! * v + h[2]!) / w, y: (h[3]! * u + h[4]! * v + h[5]!) / w };
  };
  ctx.save();
  ctx.globalAlpha = Math.min(1, quad.opacity);
  ctx.globalCompositeOperation = 'source-over';
  ctx.filter = 'none';
  ctx.imageSmoothingEnabled = true;
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const u0 = i / n;
      const u1 = (i + 1) / n;
      const v0 = j / n;
      const v1 = (j + 1) / n;
      const a = at(u0, v0);
      const b = at(u1, v0);
      const c = at(u1, v1);
      const d = at(u0, v1);
      triangle(ctx, quad.bitmap, bw, bh, [u0, v0, u1, v0, u1, v1], [a, b, c]);
      triangle(ctx, quad.bitmap, bw, bh, [u0, v0, u1, v1, u0, v1], [a, c, d]);
    }
  }
  ctx.restore();
}

/** The bitmap's triangle `uv` (fractions of it) drawn onto the output triangle `to`, clipped to it a hair larger. */
function triangle(ctx: CanvasRenderingContext2D, bitmap: CanvasImageSource, bw: number, bh: number, uv: number[], to: { x: number; y: number }[]): void {
  const [p0, p1, p2] = to as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  const sx0 = uv[0]! * bw;
  const sy0 = uv[1]! * bh;
  const sx1 = uv[2]! * bw;
  const sy1 = uv[3]! * bh;
  const sx2 = uv[4]! * bw;
  const sy2 = uv[5]! * bh;
  const den = (sx1 - sx0) * (sy2 - sy0) - (sx2 - sx0) * (sy1 - sy0);
  if (!(Math.abs(den) > 1e-12)) return;
  // The affine map taking the source triangle onto `to`: x' = a x + c y + e, y' = b x + d y + f.
  const a = ((p1.x - p0.x) * (sy2 - sy0) - (p2.x - p0.x) * (sy1 - sy0)) / den;
  const c = ((p2.x - p0.x) * (sx1 - sx0) - (p1.x - p0.x) * (sx2 - sx0)) / den;
  const b = ((p1.y - p0.y) * (sy2 - sy0) - (p2.y - p0.y) * (sy1 - sy0)) / den;
  const d = ((p2.y - p0.y) * (sx1 - sx0) - (p1.y - p0.y) * (sx2 - sx0)) / den;
  const e = p0.x - a * sx0 - c * sy0;
  const f = p0.y - b * sx0 - d * sy0;
  // Grown half a pixel about its middle, so two triangles side by side leave no hairline between them.
  const mx = (p0.x + p1.x + p2.x) / 3;
  const my = (p0.y + p1.y + p2.y) / 3;
  const grow = (p: { x: number; y: number }) => {
    const len = Math.hypot(p.x - mx, p.y - my) || 1;
    return { x: p.x + ((p.x - mx) / len) * 0.5, y: p.y + ((p.y - my) / len) * 0.5 };
  };
  const q0 = grow(p0);
  const q1 = grow(p1);
  const q2 = grow(p2);
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(q0.x, q0.y);
  ctx.lineTo(q1.x, q1.y);
  ctx.lineTo(q2.x, q2.y);
  ctx.closePath();
  ctx.clip();
  ctx.setTransform(a, b, c, d, e, f);
  ctx.drawImage(bitmap, 0, 0, bw, bh);
  ctx.restore();
}
