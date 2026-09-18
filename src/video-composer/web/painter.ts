import type { ComposeRect } from '../definitions';

import { offsetVector, toGlColumnMajor, type ColorMatrix } from './color-matrix';
import { FULL_FRAME, drawRects, sourceWindow, type Frame, type Framing } from './geometry';

/**
 * Where a frame is actually assembled: video layers first, overlays on top.
 *
 * Two canvases, and the split is the whole design. A WebGL2 canvas draws the video, because the one
 * thing a 2D canvas cannot do is the colour matrix - `ctx.filter` takes CSS filter functions, not a
 * 4x5 matrix, and the two disagree exactly where this package cannot afford them to. A 2D canvas
 * then takes that picture and puts the overlays on it, because rotating a bitmap about its centre
 * at a given opacity is three lines there and a vertex buffer in GL. One `drawImage` between them
 * is a GPU-side copy of one frame.
 *
 * The colour matrix is applied to the SAMPLED TEXEL and to nothing else, which is the rule both
 * native engines follow and the reason it is written out here: a filter with a tint or a fade,
 * applied to the finished frame instead, colours the black bars of every clip that is not 9:16 -
 * brown bars under "Golden", grey ones under a fade - which the customer never asked for. Bars are
 * the cleared background and they stay black.
 *
 * A browser with no WebGL2 falls back to drawing the video with the 2D canvas and the CSS filter
 * string the editor's own preview uses. That path is honest about what it is: it matches the
 * PREVIEW exactly and the native render very nearly, because CSS clamps after each operation while
 * a folded matrix clamps once at the end. It exists so a render is possible at all on a browser
 * that has an encoder and no GL, and `usesGpu` says which path a frame came from.
 */

/**
 * What a layer can be drawn from. Narrower than `CanvasImageSource` on purpose: `texImage2D` will
 * not take an `SVGImageElement`, so a type that admitted one would compile here and fail at the one
 * line that uploads a frame.
 */
export type LayerSource = HTMLVideoElement | HTMLCanvasElement | ImageBitmap;

export interface LayerDraw {
  /** Whatever the frame reader is holding - a `<video>` the renderer has already seeked. */
  source: LayerSource;
  sourceWidth: number;
  sourceHeight: number;
  /** The clip's crop and fit. An extra track's `rect` has already become `dest`, not this. */
  framing: Framing;
  /** Where on the OUTPUT frame this layer's own frame lands. The base track's is the whole frame. */
  dest: ComposeRect;
  /** 0..1 over the whole layer. */
  opacity: number;
  /**
   * CLOCKWISE degrees about the PLACEMENT RECTANGLE's centre, in OUTPUT PIXELS - the contract
   * `ComposePlacement` states, and the same units and sense `OverlayDraw.rotationDeg` already had.
   *
   * The pivot is the rectangle's centre and not the destination's, and the difference is real: an
   * extra layer's rectangle BECAME its `dest` when the plan was built, so the two coincide, while a
   * base-track clip keeps its rectangle inside `framing` and is drawn into a destination that is
   * the whole frame. One formula covers both - see [pivotOf] - because a rectangle read out of the
   * framing is expressed in the destination's own coordinates either way.
   *
   * Absent or 0 is upright, and an upright layer takes exactly the path it took before this field
   * existed: no transform on the 2D canvas, an identity turn in the shader.
   */
  rotationDeg?: number;
}

export interface OverlayDraw {
  bitmap: CanvasImageSource;
  cx: number;
  cy: number;
  wPx: number;
  hPx: number;
  rotationDeg: number;
  opacity: number;
}

/** The whole output frame, for a base-track layer that is not placed anywhere in particular. */
export const WHOLE_FRAME: ComposeRect = { x: 0, y: 0, w: 1, h: 1 };

const VERTEX_SHADER = `#version 300 es
in vec2 a_pos;
uniform vec4 u_dest;
uniform vec4 u_window;
uniform vec2 u_frame;
uniform vec2 u_pivot;
// cos and sin of the layer's angle, so the shader takes no trigonometry per vertex. (1, 0) is upright.
uniform vec2 u_turn;
out vec2 v_uv;
out vec2 v_out;
void main() {
  // a_pos runs 0..1 over the layer's own frame. The destination puts that frame on the output, and
  // the window says which part of the source the same corner stands for.
  vec2 outUV = u_dest.xy + a_pos * u_dest.zw;
  // Handed on BEFORE the turn, so the fragment shader cuts the layer in the rectangle's own frame:
  // cover clips to the rectangle, and the rectangle turns with the picture inside it.
  v_out = outUV;
  // Turned in OUTPUT PIXELS and nowhere else. Normalised space is stretched by the frame, so a
  // square window turned 45 degrees there comes out a rhombus on a post that is not square - which
  // is exactly what ComposePlacement says an engine must not do.
  vec2 px = outUV * u_frame;
  vec2 d = px - u_pivot;
  // y is DOWN here, as it is on a canvas, so this is the clockwise turn rotationDeg means with no
  // sign to flip - the same rotation paintOverlay gets from ctx.rotate().
  px = u_pivot + vec2(d.x * u_turn.x - d.y * u_turn.y, d.x * u_turn.y + d.y * u_turn.x);
  vec2 ndc = px / u_frame;
  gl_Position = vec4(ndc.x * 2.0 - 1.0, 1.0 - ndc.y * 2.0, 0.0, 1.0);
  v_uv = u_window.xy + a_pos * u_window.zw;
}`;

const FRAGMENT_SHADER = `#version 300 es
precision highp float;
in vec2 v_uv;
in vec2 v_out;
uniform sampler2D u_tex;
uniform vec4 u_clip;
uniform vec4 u_kept;
uniform mat3 u_matrix;
uniform vec3 u_offset;
uniform float u_opacity;
out vec4 fragColor;
void main() {
  // Outside the layer's own RECTANGLE there is no layer. It matters for a base-track clip, whose
  // rectangle sits inside a destination that is the whole frame: fitted cover, its picture is
  // larger than the rectangle it was put in, and every engine cuts it there.
  if (v_out.x < u_clip.x || v_out.y < u_clip.y || v_out.x > u_clip.x + u_clip.z || v_out.y > u_clip.y + u_clip.w) discard;
  // Outside the KEPT part of the source is a letterbox bar: a piece of the output that stands for
  // no piece of the picture. It is black, and the colour matrix never touches it.
  //
  // u_kept is the clip's crop, and the whole frame for a clip with none. The source's own edges are
  // not the bound: the window goes on mapping past the rectangle the kept picture lands on, and
  // what lies just outside it is the part of the source the customer cropped away - which a test
  // against 0..1 drew into the bars.
  vec3 rgb = vec3(0.0);
  if (v_uv.x >= u_kept.x && v_uv.x <= u_kept.x + u_kept.z && v_uv.y >= u_kept.y && v_uv.y <= u_kept.y + u_kept.w) {
    rgb = clamp(u_matrix * texture(u_tex, v_uv).rgb + u_offset, 0.0, 1.0);
  }
  // Premultiplied, which is what the blend function below expects.
  fragColor = vec4(rgb * u_opacity, u_opacity);
}`;

const IDENTITY_GL = new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]);
const ZERO_OFFSET = new Float32Array([0, 0, 0]);

export class Painter {
  private readonly output: Frame;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private gl: WebGL2RenderingContext | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  private readonly textures = new Map<LayerSource, WebGLTexture>();
  private matrix: ColorMatrix | null = null;
  /** The CSS filter the 2D fallback draws with; `none` when there is no colour work. */
  private cssFilter = 'none';
  private cssTints: string[] = [];

  /**
   * @param onto a canvas that is already ON SCREEN to assemble the frame in, for the editor's live
   *   preview. The render passes none and gets one of its own, which it hands to the encoder; the
   *   preview passes the element in its own DOM, so the finished frame IS the picture the customer
   *   is looking at rather than something copied onto it thirty times a second.
   */
  constructor(output: Frame, onto?: HTMLCanvasElement) {
    this.output = output;
    this.canvas = onto ?? createCanvas(output.width, output.height);
    this.canvas.width = output.width;
    this.canvas.height = output.height;
    const ctx = this.canvas.getContext('2d', { alpha: false, willReadFrequently: false });
    if (!ctx) throw new Error('this browser would not give the renderer a 2D canvas');
    this.ctx = ctx;

    const glCanvas = createCanvas(output.width, output.height);
    const gl = glCanvas.getContext('webgl2', {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: true,
      // The frame is read back after every draw, so the buffer has to survive the draw call.
      preserveDrawingBuffer: true,
      powerPreference: 'high-performance',
    });
    const built = gl ? buildProgram(gl) : null;
    if (gl && built) {
      this.gl = gl;
      this.glCanvas = glCanvas;
      this.program = built.program;
      this.uniforms = built.uniforms;
    }
  }

  /** Whether frames go through the shader, which is the path that agrees with the native engines. */
  get usesGpu(): boolean {
    return this.gl !== null;
  }

  /** The finished frame, for the encoder and for the poster. */
  get frame(): HTMLCanvasElement {
    return this.canvas;
  }

  /**
   * The colour work for this render, set once. The CSS form is kept beside the matrix for the
   * fallback path; both come from the same ordered op list, so the two cannot drift.
   */
  setColour(matrix: ColorMatrix | null, css: { filter: string; tints: string[] }): void {
    this.matrix = matrix;
    this.cssFilter = css.filter;
    this.cssTints = css.tints;
  }

  /** Everything before the overlays: black, then each video layer bottom to top. */
  paintLayers(layers: readonly LayerDraw[]): void {
    const gl = this.gl;
    if (gl && this.glCanvas && this.program) {
      if (this.paintLayersGl(gl, layers)) {
        this.ctx.globalAlpha = 1;
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.filter = 'none';
        this.ctx.drawImage(this.glCanvas, 0, 0);
        return;
      }
      // The shader refused a source and said so once; every frame after this one takes the 2D path
      // straight away rather than throwing the same SecurityError thirty times a second.
      this.dropGl();
    }
    this.paintLayers2d(layers);
  }

  /** One overlay, centred, rotated clockwise and blended - the same three lines in both paths. */
  paintOverlay(overlay: OverlayDraw): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = overlay.opacity;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.translate(overlay.cx * this.output.width, overlay.cy * this.output.height);
    // A canvas turns clockwise for a positive angle in its own y-down space, which is exactly what
    // `rotationDeg` means, so there is no sign to flip here. The GL engines flip it; this does not.
    if (overlay.rotationDeg !== 0) ctx.rotate((overlay.rotationDeg * Math.PI) / 180);
    ctx.drawImage(overlay.bitmap, -overlay.wPx / 2, -overlay.hPx / 2, overlay.wPx, overlay.hPx);
    ctx.restore();
  }

  /**
   * Frees the textures the layers were uploaded into, and hands the GL context itself back.
   *
   * The context matters as much as the textures where a painter is not a one-off: a browser keeps
   * only a handful of live WebGL contexts per page and drops the oldest when a new one is made, so
   * a preview that builds a painter every time its stage changes size would quietly kill the
   * context of the one it is still drawing with.
   */
  dispose(): void {
    const gl = this.gl;
    if (!gl) return;
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    this.textures.clear();
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    this.dropGl();
  }

  /** Forgets the GL path, for a context that has been given back or has refused a frame. */
  private dropGl(): void {
    this.gl = null;
    this.glCanvas = null;
    this.program = null;
    this.uniforms = {};
    this.textures.clear();
  }

  /* ------------------------------------------------------------------------------------------ */

  /** Returns false when this browser would not let the shader have a frame; see the catch below. */
  private paintLayersGl(gl: WebGL2RenderingContext, layers: readonly LayerDraw[]): boolean {
    gl.viewport(0, 0, this.output.width, this.output.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.enable(gl.BLEND);
    // Premultiplied source over: the fragment shader already multiplied by the layer's opacity.
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.program);

    const matrix = this.matrix;
    gl.uniformMatrix3fv(this.uniforms['u_matrix'] ?? null, false, matrix ? toGlColumnMajor(matrix) : IDENTITY_GL);
    gl.uniform3fv(this.uniforms['u_offset'] ?? null, matrix ? offsetVector(matrix) : ZERO_OFFSET);

    for (const layer of layers) {
      if (layer.sourceWidth <= 0 || layer.sourceHeight <= 0) continue;
      const frame: Frame = {
        width: Math.max(1, Math.round(layer.dest.w * this.output.width)),
        height: Math.max(1, Math.round(layer.dest.h * this.output.height)),
      };
      const window = sourceWindow(layer.framing, frame, layer.sourceWidth, layer.sourceHeight);

      gl.bindTexture(gl.TEXTURE_2D, this.textureFor(gl, layer.source));
      try {
        // Re-uploaded every frame because the source is a `<video>` whose picture has moved on; the
        // texture object itself is kept, which is what saves the allocation.
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source);
      } catch {
        // A cross-origin `<video>` does not merely TAINT a GL texture the way it taints a 2D
        // canvas: `texImage2D` throws a SecurityError outright. Every source this package loads is
        // same-origin (a blob, or the host's own file scheme), so this is the editor being pointed
        // at a remote URL by a host that may - and the honest answer is the picture drawn without a
        // shader rather than no picture at all.
        gl.disable(gl.BLEND);
        return false;
      }

      const bounds = boundsOf(layer);
      const kept = layer.framing.crop ?? FULL_FRAME;
      const pivot = this.pivotOf(layer);
      const radians = ((layer.rotationDeg ?? 0) * Math.PI) / 180;
      gl.uniform4f(this.uniforms['u_clip'] ?? null, bounds.x, bounds.y, bounds.w, bounds.h);
      gl.uniform4f(this.uniforms['u_kept'] ?? null, kept.x, kept.y, kept.w, kept.h);
      gl.uniform4f(this.uniforms['u_dest'] ?? null, layer.dest.x, layer.dest.y, layer.dest.w, layer.dest.h);
      gl.uniform4f(this.uniforms['u_window'] ?? null, window.x, window.y, window.w, window.h);
      gl.uniform2f(this.uniforms['u_frame'] ?? null, this.output.width, this.output.height);
      gl.uniform2f(this.uniforms['u_pivot'] ?? null, pivot.x, pivot.y);
      gl.uniform2f(this.uniforms['u_turn'] ?? null, Math.cos(radians), Math.sin(radians));
      gl.uniform1f(this.uniforms['u_opacity'] ?? null, layer.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    gl.disable(gl.BLEND);
    return true;
  }

  /**
   * The point a layer TURNS ABOUT, in output pixels: the centre of the rectangle its picture is
   * placed in, which is what `ComposePlacement` names and what the preview's gestures move.
   *
   * One formula for both kinds of layer. An extra track's rectangle became its `dest` when the plan
   * was built and was taken off the clip, so the framing has none and this is the destination's own
   * centre. A base-track clip keeps its rectangle in the framing and is drawn into a destination
   * that is the whole frame, so the rectangle - which is in fractions of that destination - is put
   * back through it here. Turning about the DESTINATION's centre instead would swing a base clip
   * around the middle of the frame rather than around itself.
   */
  private pivotOf(layer: LayerDraw): { x: number; y: number } {
    const bounds = boundsOf(layer);
    return {
      x: (bounds.x + bounds.w / 2) * this.output.width,
      y: (bounds.y + bounds.h / 2) * this.output.height,
    };
  }

  /**
   * The same frame without a shader.
   *
   * `ctx.filter` carries the colour work as CSS, which is what the preview already draws with, and
   * the tints go on afterwards as translucent fills clipped to the picture - CSS has no filter
   * function for a tint, which is exactly why `resolveFilterOps` moves every tint to the end of the
   * list in the first place.
   */
  private paintLayers2d(layers: readonly LayerDraw[]): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.output.width, this.output.height);
    ctx.restore();

    for (const layer of layers) {
      if (layer.sourceWidth <= 0 || layer.sourceHeight <= 0) continue;
      const frame: Frame = {
        width: Math.max(1, Math.round(layer.dest.w * this.output.width)),
        height: Math.max(1, Math.round(layer.dest.h * this.output.height)),
      };
      const window = sourceWindow(layer.framing, frame, layer.sourceWidth, layer.sourceHeight);
      const rects = drawRects(window, frame, layer.sourceWidth, layer.sourceHeight, layer.framing.crop);

      const originX = layer.dest.x * this.output.width;
      const originY = layer.dest.y * this.output.height;
      // Where this layer is allowed to paint: its own rectangle, which for an extra layer IS the
      // destination and for a base-track clip is a rectangle inside it. In output pixels.
      const bounds = boundsOf(layer);
      const clipX = bounds.x * this.output.width;
      const clipY = bounds.y * this.output.height;
      const clipW = Math.max(1, bounds.w * this.output.width);
      const clipH = Math.max(1, bounds.h * this.output.height);

      ctx.save();
      // Before the clip and before the draw, so the rectangle is cut in the layer's OWN turned
      // frame - which is what `cover` clipping to a turned rectangle means, and what the GL path
      // gets for free by turning the quad it samples through.
      const radians = ((layer.rotationDeg ?? 0) * Math.PI) / 180;
      if (radians !== 0) {
        const pivot = this.pivotOf(layer);
        ctx.translate(pivot.x, pivot.y);
        ctx.rotate(radians);
        ctx.translate(-pivot.x, -pivot.y);
      }
      ctx.beginPath();
      ctx.rect(clipX, clipY, clipW, clipH);
      ctx.clip();
      // A layer's own frame is black first, so its letterbox bars cover whatever is under them
      // exactly as they do natively rather than letting it show through. Unconditional, because the
      // GL path above is: its shader paints every sample that falls outside the source black at the
      // layer's opacity, whatever size the rectangle is. The test this replaces was `dest.w < 1 ||
      // dest.h < 1` - a layer smaller than the output - which stopped being a proxy for anything
      // the moment a rectangle could be larger than the output or hang off its edge, and would have
      // made a layer's bars turn transparent as a pinch took it through the frame's own size.
      ctx.globalAlpha = layer.opacity;
      ctx.fillStyle = '#000';
      ctx.fillRect(clipX, clipY, clipW, clipH);
      if (rects) {
        ctx.globalAlpha = layer.opacity;
        ctx.filter = this.cssFilter;
        ctx.drawImage(layer.source, rects.sx, rects.sy, rects.sw, rects.sh, originX + rects.dx, originY + rects.dy, rects.dw, rects.dh);
        ctx.filter = 'none';
        for (const tint of this.cssTints) {
          ctx.globalAlpha = layer.opacity;
          ctx.fillStyle = tint;
          ctx.fillRect(originX + rects.dx, originY + rects.dy, rects.dw, rects.dh);
        }
      }
      ctx.restore();
    }
  }

  private textureFor(gl: WebGL2RenderingContext, source: LayerSource): WebGLTexture {
    const existing = this.textures.get(source);
    if (existing) return existing;
    const texture = gl.createTexture();
    if (!texture) throw new Error('the GPU would not allocate a texture for the render');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    // CLAMP_TO_EDGE is belt and braces - the shader already refuses to sample outside the source -
    // and LINEAR is what makes a scaled clip look scaled rather than blocky.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    this.textures.set(source, texture);
    return texture;
  }
}

/**
 * The part of the OUTPUT a layer may paint on, in fractions of it: the rectangle its picture was
 * placed in.
 *
 * One formula for both kinds of layer, which is the point. An extra layer's rectangle BECAME its
 * `dest` when the plan was built and was taken off the clip, so the framing has none and this is
 * simply the destination. A base-track clip keeps its rectangle in the framing and is drawn into a
 * destination that is the whole frame, so the rectangle - in fractions of that destination - is put
 * back through it here.
 *
 * It is the layer's clip AND the point it turns about, and those have to be the same rectangle:
 * `ComposePlacement` says `fit` is measured in the upright rectangle and the fitted picture is
 * turned as one piece, with `cover` still clipping to the rectangle in the rectangle's own turned
 * frame. Without the clip a base clip fitted `cover` paints its overflow across the whole frame,
 * because the only edge the sampler knows about is the SOURCE's.
 */
function boundsOf(layer: LayerDraw): ComposeRect {
  const rect = layer.framing.rect;
  if (!rect) return layer.dest;
  return {
    x: layer.dest.x + rect.x * layer.dest.w,
    y: layer.dest.y + rect.y * layer.dest.h,
    w: rect.w * layer.dest.w,
    h: rect.h * layer.dest.h,
  };
}

function createCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  return canvas;
}

/**
 * Compiles the one program, or null for a context that would not give it - which is treated as "no
 * GL here" rather than as a failure, because the 2D path renders the same video.
 */
function buildProgram(gl: WebGL2RenderingContext): { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null> } | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER);
  if (!vertex || !fragment) return null;

  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }

  gl.useProgram(program);
  // One quad, uploaded once. Every layer is the same four corners with different uniforms.
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_pos');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);
  gl.activeTexture(gl.TEXTURE0);

  return {
    program,
    uniforms: {
      u_dest: gl.getUniformLocation(program, 'u_dest'),
      u_window: gl.getUniformLocation(program, 'u_window'),
      u_frame: gl.getUniformLocation(program, 'u_frame'),
      u_pivot: gl.getUniformLocation(program, 'u_pivot'),
      u_clip: gl.getUniformLocation(program, 'u_clip'),
      u_kept: gl.getUniformLocation(program, 'u_kept'),
      u_turn: gl.getUniformLocation(program, 'u_turn'),
      u_matrix: gl.getUniformLocation(program, 'u_matrix'),
      u_offset: gl.getUniformLocation(program, 'u_offset'),
      u_opacity: gl.getUniformLocation(program, 'u_opacity'),
    },
  };
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
