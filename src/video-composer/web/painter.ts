import { isIdentityView, type CameraView } from '../../editor/camera';
import { isNeutralMotion, type OverlayMotionSample } from '../../editor/motion';
import type { TransitionLook } from '../../editor/transitions';
import type { ComposeRect, ComposeTransition } from '../definitions';

import { cameraAffine } from './camera-draw';
import { offsetVector, toGlColumnMajor, type ColorMatrix } from './color-matrix';
import { FULL_FRAME, drawRects, sourceWindow, type Frame, type Framing } from './geometry';
import { Transition2d } from './transition-2d';
import { TransitionGl } from './transition-gl';

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
 *
 * A TRANSITION between two base clips is one more kind of item in the same list, in the base
 * track's place: a [TransitionDraw] carrying the two clips as the ordinary layers each would be
 * drawn as on its own, and the look of the moment between them. Each side is drawn WHOLE by the
 * same code that draws any layer - into a frame of its own rather than onto the canvas - and the
 * two frames are then moved, softened and mixed by `transition-gl.ts`, which is the drawing contract
 * in `ComposeTransition` and nothing else. A frame with no transition in it never reaches any of
 * that: the loop below is the loop it always was, and nothing is allocated for transitions until a
 * post first asks for one.
 */

/**
 * One transition, in the base track's place in [Painter.paintLayers]: the outgoing and incoming base
 * clips as the plain layers each would be drawn as on its own - destination the whole frame, framing
 * its clip's fit, crop and rectangle, turned by its rectangle's angle - and the look at this moment.
 *
 * A side that is null has no frame to give yet, a `<video>` still loading, and is drawn as ABSENT:
 * transparent, so the outgoing side leaves black and the incoming side leaves the outgoing one.
 */
export interface TransitionDraw {
  kind: 'transition';
  from: LayerDraw | null;
  to: LayerDraw | null;
  /** `lookAt(curves, progress)`: what every channel is at this moment. */
  look: TransitionLook;
  transition: Pick<ComposeTransition, 'mask' | 'fromTint' | 'toTint'>;
}

export function isTransitionDraw(draw: LayerDraw | TransitionDraw): draw is TransitionDraw {
  return (draw as Partial<TransitionDraw>).kind === 'transition';
}

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
  /**
   * The CAMERA at this frame - the zoom a customer put on the timeline, `cameraAt(camera, t)` - or
   * absent for none. See `ComposeCamera` for the contract and `camera-draw.ts` for why it rides on
   * each layer rather than on the painter.
   *
   * Applied LAST, after the layer's placement, fit, crop and turn, as one uniform scale about a
   * point in OUTPUT PIXELS ([cameraAffine]). Because it is a similarity it commutes with the turn,
   * so nothing the layer's layout computes - its source window, its bounds, its pivot, the integer
   * rounding of its frame - changes under a zoom, and the SOURCE is still what is sampled: a 1080p
   * recording zoomed 2x into a 720p post reads real source pixels, not an enlarged 720p frame.
   *
   * On a transition side it acts INSIDE the side, which is exactly where this puts it: the side's
   * frame is drawn through it, and the transition then moves and mixes that frame as it always did.
   *
   * Absent, null, or a view that moves nothing is no camera, and takes exactly the path this layer
   * took before the field existed: an identity camera uniform in the shader (`x * 1.0 + 0.0` is exact
   * in IEEE arithmetic, so the frame is the same to the bit) and no transform on the 2D canvas.
   */
  camera?: CameraView | null;
}

export interface OverlayDraw {
  bitmap: CanvasImageSource;
  cx: number;
  cy: number;
  wPx: number;
  hPx: number;
  rotationDeg: number;
  opacity: number;
  /**
   * Where the layer's motion has it at this frame - `overlayMotionAt(motion, t)` - or absent for a
   * layer at rest. See `ComposeOverlayMotion` for the contract: the offsets are added to the centre
   * in fractions of the frame, the size multiplies `wPx`/`hPx` about that centre, the turn is added
   * to `rotationDeg`, and the opacity multiplies the layer's own.
   *
   * Absent, null, or a sample that moves nothing is the path every overlay took before layers moved,
   * the very same three canvas calls, so a still frame is the same to the bit.
   */
  motion?: OverlayMotionSample | null;
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
// The camera as (scale, tx, ty) in output pixels: a pixel p of the layer as placed lands at
// p * scale + (tx, ty). (1, 0, 0) is no camera.
uniform vec3 u_camera;
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
  // The camera, AFTER the turn: a uniform scale about a point commutes with a turn about the pivot,
  // so this is the turned layer seen through the camera. v_out and v_uv above are left as they were,
  // which keeps the cover clip in the layer's own frame and the crop test in the source's - and
  // since every corner of the quad goes through it, the texture is still read straight from the
  // SOURCE, which is what keeps a zoom sharp.
  px = px * u_camera.x + u_camera.yz;
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
  /** Not readonly only for [resize]. */
  private output: Frame;
  private readonly canvas: HTMLCanvasElement;
  private readonly ctx: CanvasRenderingContext2D;
  private gl: WebGL2RenderingContext | null = null;
  private glCanvas: HTMLCanvasElement | null = null;
  private program: WebGLProgram | null = null;
  private uniforms: Record<string, WebGLUniformLocation | null> = {};
  /** Where the quad's corners are bound, which the transition programs are linked to read too. */
  private position = 0;
  private readonly textures = new Map<LayerSource, WebGLTexture>();
  /** Built the first time a frame has a transition in it, and never for a post that has none. */
  private transitionGl: TransitionGl | null = null;
  private transition2d: Transition2d | null = null;
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
      this.position = built.position;
    } else {
      // A context with no program is one this painter will never draw with, and it still counts
      // against the handful a page may hold, so it is handed back rather than left to the collector.
      gl?.getExtension('WEBGL_lose_context')?.loseContext();
    }
  }

  /** Whether frames go through the shader, which is the path that agrees with the native engines. */
  get usesGpu(): boolean {
    return this.gl !== null;
  }

  /**
   * Assembles frames at a new size from now on, keeping everything a size does not touch: the GL
   * context, the layer program, every source's texture and the transition programs. Building a new
   * painter instead costs a context, a program compile and - on the first transition after - two
   * more programs linked, which is a visible hitch on the paused frame the customer is looking at
   * every time a sheet or the keyboard resizes the preview. Nothing a paint draws with depends on
   * what the painter was built at: the viewport, `u_frame` and every other uniform are set on every
   * paint, so a resized painter draws exactly what a new one of that size would.
   *
   * Assigning a size clears both canvases, exactly as building a new painter onto the same canvas
   * did. The transitions' frame targets are sized from the frame, so they go and are made again at
   * the new size the first time each is asked for.
   *
   * False, with nothing changed, when there is no live GPU context to keep: a painter that has
   * fallen back to 2D, or whose context was lost while nothing was painting. The caller builds a new
   * painter then, which is what brings the GPU back - and it is exactly what a resize did before.
   */
  resize(output: Frame): boolean {
    const gl = this.gl;
    const glCanvas = this.glCanvas;
    if (!gl || !glCanvas || gl.isContextLost()) return false;
    this.output = output;
    this.canvas.width = output.width;
    this.canvas.height = output.height;
    glCanvas.width = output.width;
    glCanvas.height = output.height;
    this.transitionGl?.resize(output);
    // Never built while the GPU path is up, but its frames are sized from the output if it were.
    this.transition2d?.dispose();
    this.transition2d = null;
    return true;
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

  /**
   * Everything before the overlays: black, then each video layer bottom to top. A [TransitionDraw]
   * stands where the base track's layer would, and paints the whole frame - the outgoing clip over
   * black and the incoming one over that - with the layers after it drawn over the result.
   */
  paintLayers(layers: ReadonlyArray<LayerDraw | TransitionDraw>): void {
    const gl = this.gl;
    if (gl && this.glCanvas && this.program) {
      // A LOST context - the GPU reclaimed while the page was in the background, or the browser
      // dropping its oldest context for a newer one - draws nothing and throws nothing, so without
      // this check the frame below would be the last one the context drew, over and over: a preview
      // frozen on one picture, and a web render encoding that picture to the end of the post.
      if (!gl.isContextLost() && this.paintLayersGl(gl, layers)) {
        this.ctx.globalAlpha = 1;
        this.ctx.globalCompositeOperation = 'source-over';
        this.ctx.filter = 'none';
        this.ctx.drawImage(this.glCanvas, 0, 0);
        return;
      }
      // Lost, or the shader refused a source and said so once: every frame after this one takes the
      // 2D path straight away rather than failing the same way thirty times a second. A context that
      // is still alive is handed back first, for the reason [dispose] gives.
      if (!gl.isContextLost()) gl.getExtension('WEBGL_lose_context')?.loseContext();
      this.dropGl();
    }
    this.paintLayers2d(layers);
  }

  /** One overlay, centred, rotated clockwise and blended - the same three lines in both paths. */
  paintOverlay(overlay: OverlayDraw): void {
    const motion = overlay.motion && !isNeutralMotion(overlay.motion) ? overlay.motion : null;
    if (motion) {
      this.paintMovingOverlay(overlay, motion);
      return;
    }
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
   * One overlay where its motion has it: the same three lines with the motion's numbers folded into
   * them - the centre moved, the turn added, the size and the opacity multiplied - which is the
   * static layer's own transform and so needs no second idea of where a layer's centre is. A layer
   * the motion has shrunk to nothing or faded out is simply not drawn.
   */
  private paintMovingOverlay(overlay: OverlayDraw, motion: OverlayMotionSample): void {
    const alpha = overlay.opacity * motion.opacity;
    const w = overlay.wPx * motion.scale;
    const h = overlay.hPx * motion.scale;
    if (!(alpha > 0) || !(w > 0) || !(h > 0)) return;
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = Math.min(1, alpha);
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.translate((overlay.cx + motion.x) * this.output.width, (overlay.cy + motion.y) * this.output.height);
    const degrees = overlay.rotationDeg + motion.rotation;
    if (degrees !== 0) ctx.rotate((degrees * Math.PI) / 180);
    ctx.drawImage(overlay.bitmap, -w / 2, -h / 2, w, h);
    ctx.restore();
  }

  /**
   * Lets go of the texture `source` was uploaded into, for a source that will not be drawn again.
   *
   * [textureFor] keeps one texture per source object for as long as the painter lives, which suits
   * the preview: its `<video>` elements are made once and re-pointed, so there are only ever a
   * handful. The web render is the other kind of caller. It opens a new element for every file a
   * layer moves on to, and another for every transition's tail, so without this each of them left a
   * frame-sized texture on the GPU until the render ended - a real share of a phone's GPU memory on a
   * post of a dozen clips, and roughly twice that with transitions between them.
   *
   * A source drawn again afterwards simply gets a new texture. The 2D path holds none, and a context
   * that has been lost or given back has already taken every texture with it.
   */
  forget(source: LayerSource): void {
    const texture = this.textures.get(source);
    if (!texture) return;
    this.textures.delete(source);
    this.gl?.deleteTexture(texture);
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
    // The 2D path's frames first, because they are held whether or not there is a context: a
    // painter that fell back to 2D mid-post would otherwise keep four frame-sized canvases alive.
    this.transition2d?.dispose();
    this.transition2d = null;
    const gl = this.gl;
    if (!gl) return;
    for (const texture of this.textures.values()) gl.deleteTexture(texture);
    this.textures.clear();
    this.transitionGl?.dispose();
    this.transitionGl = null;
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
    this.transitionGl = null;
  }

  /* ------------------------------------------------------------------------------------------ */

  /** Returns false when this browser would not let the shader have a frame; see the catch below. */
  private paintLayersGl(gl: WebGL2RenderingContext, layers: ReadonlyArray<LayerDraw | TransitionDraw>): boolean {
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
      if (isTransitionDraw(layer)) {
        if (!this.paintTransitionGl(gl, layer)) {
          gl.disable(gl.BLEND);
          return false;
        }
        continue;
      }
      if (!this.drawLayerGl(gl, layer)) return false;
    }
    gl.disable(gl.BLEND);
    return true;
  }

  /**
   * One layer through the layer program, into whatever framebuffer is bound: the canvas's own for
   * an ordinary layer, a side's frame for one half of a transition. False when the browser would
   * not let the shader have the frame.
   */
  private drawLayerGl(gl: WebGL2RenderingContext, layer: LayerDraw): boolean {
    if (layer.sourceWidth <= 0 || layer.sourceHeight <= 0) return true;
    const frame: Frame = {
      width: Math.max(1, Math.round(layer.dest.w * this.output.width)),
      height: Math.max(1, Math.round(layer.dest.h * this.output.height)),
    };
    const window = sourceWindow(layer.framing, frame, layer.sourceWidth, layer.sourceHeight);

    // A bitmap cannot change once it is made - it is a picture on the timeline, decoded once - so it
    // is uploaded the first time it is drawn and never again. Anything else is re-uploaded below.
    const still = typeof ImageBitmap !== 'undefined' && layer.source instanceof ImageBitmap;
    const uploaded = still && this.textures.has(layer.source);
    gl.bindTexture(gl.TEXTURE_2D, this.textureFor(gl, layer.source));
    try {
      // Re-uploaded every frame because the source is a `<video>` whose picture has moved on; the
      // texture object itself is kept, which is what saves the allocation.
      if (!uploaded) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, layer.source);
    } catch {
      // Not uploaded after all, so a bitmap must not be taken for one that was on its next frame.
      if (still) this.textures.delete(layer.source);
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
    // Set on EVERY layer, identity included: the program's uniforms outlive the draw, so a layer
    // with no camera drawn after one with a zoom would otherwise inherit it.
    const camera = layer.camera && !isIdentityView(layer.camera) ? cameraAffine(layer.camera, this.output) : null;
    gl.uniform3f(this.uniforms['u_camera'] ?? null, camera ? camera.scale : 1, camera ? camera.tx : 0, camera ? camera.ty : 0);
    gl.uniform1f(this.uniforms['u_opacity'] ?? null, layer.opacity);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return true;
  }

  /**
   * A transition, over the whole frame. Each present side is drawn by [drawLayerGl] into a frame of
   * its own that starts opaque black - so its picture is framed and graded exactly as it would be
   * with no transition, and its bars are black and part of it - and `TransitionGl` then blurs and
   * mixes the two onto the canvas. False, as for a layer, when a side's frame could not be had; the
   * whole frame then goes to the 2D path, which draws transitions too.
   *
   * Leaves the layer program in use, blending on and the canvas's framebuffer bound, which is what
   * every layer drawn over the transition expects to find.
   */
  private paintTransitionGl(gl: WebGL2RenderingContext, draw: TransitionDraw): boolean {
    const gpu = this.transitionGl ?? (this.transitionGl = TransitionGl.create(gl, this.output, this.position));
    if (!gpu) return false;
    const hasFrom = hasPicture(draw.from);
    // An incoming side at no alpha covers nothing anywhere - its coverage is alpha times the mask -
    // so it is left out rather than uploaded, drawn and blurred to be multiplied by nought. Half of a
    // zoom and the first third of a blur are frames like that.
    const hasTo = hasPicture(draw.to) && draw.look.alpha > 0;

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
    for (const [side, layer] of [
      ['from', hasFrom ? draw.from : null],
      ['to', hasTo ? draw.to : null],
    ] as const) {
      if (!layer) continue;
      gpu.beginSide(side);
      if (!this.drawLayerGl(gl, layer)) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, null);
        return false;
      }
    }
    gpu.composite(draw, hasFrom, hasTo);

    gl.useProgram(this.program);
    gl.enable(gl.BLEND);
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
  private paintLayers2d(layers: ReadonlyArray<LayerDraw | TransitionDraw>): void {
    const ctx = this.ctx;
    ctx.save();
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, this.output.width, this.output.height);
    ctx.restore();

    for (const layer of layers) {
      if (isTransitionDraw(layer)) {
        // Each side is drawn whole by the very routine below, into a frame of its own, so the
        // fallback's transition is framed and coloured exactly as its fallback layers are.
        const transition = this.transition2d ?? (this.transition2d = new Transition2d(this.output));
        transition.paint(ctx, layer, (into, side) => this.drawLayer2d(into, side));
        continue;
      }
      this.drawLayer2d(ctx, layer);
    }
  }

  /** One layer onto a 2D context the size of the output: the painter's own, or a transition side's. */
  private drawLayer2d(ctx: CanvasRenderingContext2D, layer: LayerDraw): void {
    if (layer.sourceWidth <= 0 || layer.sourceHeight <= 0) return;
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
    // The camera goes on FIRST, so it acts last: a canvas applies the transforms composed onto it in
    // reverse, which makes this `camera * turn` - the layer turned and then seen through the camera,
    // the shader's order. `transform` and not `setTransform`, because a transition side is drawn
    // here onto a surface of its own and the camera composes with whatever that surface holds.
    // Everything below - the clip, the black, the picture, the tints - goes through it, and
    // `drawImage` samples the SOURCE through the whole transform, so the fallback stays sharp too.
    // No camera, no transform: the fallback's old path exactly.
    if (layer.camera && !isIdentityView(layer.camera)) {
      const camera = cameraAffine(layer.camera, this.output);
      ctx.transform(camera.scale, 0, 0, camera.scale, camera.tx, camera.ty);
    }
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

  private textureFor(gl: WebGL2RenderingContext, source: LayerSource): WebGLTexture {
    const existing = this.textures.get(source);
    if (existing) return existing;
    if (typeof ImageBitmap !== 'undefined' && source instanceof ImageBitmap) this.sweepClosedBitmaps(gl);
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

  /**
   * Lets go of the texture of every picture that has since been closed.
   *
   * A picture on the timeline is a bitmap, and a new one is a new texture; the old one's owner
   * closes it when it moves on, and nothing else would ever tell the painter. A closed bitmap
   * reports a size of 0, which is how it is found. Run only when a new bitmap arrives, so it costs a
   * walk of a few entries per picture change and nothing per frame.
   */
  private sweepClosedBitmaps(gl: WebGL2RenderingContext): void {
    for (const [source, texture] of this.textures) {
      if (source instanceof ImageBitmap && source.width === 0 && source.height === 0) {
        gl.deleteTexture(texture);
        this.textures.delete(source);
      }
    }
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

/**
 * Whether a transition side has a picture to draw. A side with none is ABSENT - transparent over
 * whatever is under it - rather than a black frame, which is what drawing a source with no size
 * into a frame cleared to black would otherwise have made it.
 */
function hasPicture(layer: LayerDraw | null): layer is LayerDraw {
  return layer !== null && layer.sourceWidth > 0 && layer.sourceHeight > 0;
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
function buildProgram(gl: WebGL2RenderingContext): { program: WebGLProgram; uniforms: Record<string, WebGLUniformLocation | null>; position: number } | null {
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
    position,
    uniforms: {
      u_dest: gl.getUniformLocation(program, 'u_dest'),
      u_window: gl.getUniformLocation(program, 'u_window'),
      u_frame: gl.getUniformLocation(program, 'u_frame'),
      u_pivot: gl.getUniformLocation(program, 'u_pivot'),
      u_clip: gl.getUniformLocation(program, 'u_clip'),
      u_kept: gl.getUniformLocation(program, 'u_kept'),
      u_turn: gl.getUniformLocation(program, 'u_turn'),
      u_camera: gl.getUniformLocation(program, 'u_camera'),
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
