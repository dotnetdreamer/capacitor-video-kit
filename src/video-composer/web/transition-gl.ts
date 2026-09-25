import type { RGB, TransitionSide } from '../../editor/transitions';

import type { Frame } from './geometry';
import type { TransitionDraw } from './painter';

/**
 * A transition on the GPU: the drawing contract in `ComposeTransition`, in two small shaders.
 *
 * The painter hands this each side's WHOLE frame, already drawn - the side's picture framed and
 * graded by the painter's own layer program into a frame-sized texture that was cleared to opaque
 * black first. That is the whole trick, and the reason the look of a side cannot drift from the look
 * of the same clip with no transition: it IS the same draw, into a different target. Everything this
 * file does happens after it, to a finished frame, which is exactly what the contract describes - a
 * side is its clip's output frame, bars and all, moved and softened and tinted as one piece.
 *
 * A ZOOM (`ComposeCamera`) needs nothing here, and that is by design rather than by omission. The
 * contract puts the camera INSIDE each side - a side is its clip's whole frame as seen through the
 * camera - and the painter's layer program already draws each side through the layer's own camera,
 * from the source, into the side's target. So the frames this receives are the zoomed ones, sharp,
 * and a slide still crosses the whole screen, a circle still opens from the screen's centre and a
 * blur's sigma is still a fraction of the screen, exactly as with no zoom. The other order - the
 * camera over the finished mix - would have to magnify these output-size frames, which is soft, or
 * draw them s x s times larger, which a phone cannot afford.
 *
 * Two programs, and neither of them knows which transition it is drawing:
 *
 *  - BLUR, a separable Gaussian run as two passes, across then down, and before them as many plain
 *    halvings as it takes to bring the sigma down to a few texels. A 720-wide post blurred by the
 *    catalogue's heaviest recipe has a sigma of about twenty pixels, which at full size is a hundred
 *    and thirty taps a pass; halved three times it is nineteen, over a sixty-fourth of the pixels,
 *    and the answer is the same Gaussian to within what an 8-bit frame can show. A side with no blur
 *    runs neither pass, and a transition with no blur on either side allocates nothing for them.
 *
 *  - MIX, one full-frame pass that is `transitionPixel` in GLSL: the inverse move of each side, the
 *    frame's edge as transparent, the mosaic snapped to cells laid out from the centre, the colour
 *    split, the gain clamped to one, the tint, the outgoing side over black and the incoming side
 *    over that through the mask. It writes every pixel of the frame opaque, so the transition
 *    REPLACES whatever was under it - which is right, because the contract composites it over black.
 *
 * Every target is kept across frames and freed by [dispose]. They are keyed by size, and the sizes a
 * blur runs at change as the blur does, so a transition allocates its handful the first time each
 * size comes up and none after.
 */

/** Which side of the transition a target holds. */
export type TransitionSideName = 'from' | 'to';

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

interface Program {
  program: WebGLProgram;
  uniforms: Record<string, WebGLUniformLocation | null>;
}

/**
 * Below this sigma, in output pixels, a Gaussian moves no 8-bit value by a whole step: the weight it
 * puts on a neighbour a pixel away is `exp(-8)`, about three parts in ten thousand, so even a pixel
 * between black and white neighbours moves by a fifth of a level. Such a side is sampled sharp and
 * both passes are skipped.
 */
const MIN_BLUR_PX = 0.25;

/**
 * The smallest sigma, in texels, a blur is run at. Halving stops before the sigma falls below this,
 * so a blur runs with a sigma of two to four texels: enough taps that the kernel is a Gaussian and
 * not a triangle, few enough that the heaviest one costs under thirty taps a pixel.
 */
const MIN_LEVEL_SIGMA = 2;

/** The most taps either side of centre. Only reached by a frame too small to halve any further. */
const MAX_TAPS = 64;

/** The mask shapes by the number the shader switches on. Anything else measures 0, as it does in `maskMeasure`. */
const MASK_SHAPES: Record<string, number> = { linear: 0, circle: 1, diamond: 2, clock: 3, blinds: 4, split: 5 };
const NO_MASK = -1;
const UNKNOWN_MASK = 6;

const BLACK: RGB = [0, 0, 0];

/**
 * One quad over the whole target. The painter's quad buffer runs 0..1 and is still bound when these
 * programs draw, so they read it through the same attribute location rather than keeping a buffer of
 * their own.
 */
const FULL_FRAME_VERTEX = `#version 300 es
in vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

const BLUR_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
// The target's size in its own texels. The source is read at the same place in texture coordinates,
// so a target half the size of its source is a halving, sampled bilinearly between four texels.
uniform vec2 u_size;
// One source texel along the pass, in texture coordinates. Unused by a plain resample.
uniform vec2 u_step;
uniform float u_sigma;
// Taps either side of centre; 0 is a plain resample, which is what a halving is.
uniform int u_radius;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 sum = textureLod(u_src, uv, 0.0);
  float total = 1.0;
  float k = u_radius > 0 ? -0.5 / (u_sigma * u_sigma) : 0.0;
  // Past the frame's edge the texture clamps, which is the EDGE-CLAMPED Gaussian the contract asks
  // for: the frame's outermost pixels stand in for whatever lies beyond them, so the edge of a blurred
  // side does not darken into a vignette.
  for (int i = 1; i <= ${MAX_TAPS}; i++) {
    if (i > u_radius) break;
    float w = exp(float(i * i) * k);
    sum += w * (textureLod(u_src, uv + float(i) * u_step, 0.0) + textureLod(u_src, uv - float(i) * u_step, 0.0));
    total += 2.0 * w;
  }
  fragColor = sum / total;
}`;

const MIX_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_fromTex;
uniform sampler2D u_toTex;
// The output frame, in pixels. Every distance below is in these pixels, so a circle is round and a
// turn is a turn on a frame that is not square.
uniform vec2 u_size;
uniform bool u_hasFrom;
uniform bool u_hasTo;
// Per side: the offset in pixels, the scale, and the mosaic cell in pixels (0 for none)...
uniform vec4 u_fromMove;
uniform vec4 u_toMove;
// ...cos and sin of MINUS its clockwise angle, which is the inverse turn a sample position needs...
uniform vec2 u_fromTurn;
uniform vec2 u_toTurn;
// ...the colour split in pixels, the gain and how far towards the tint colour...
uniform vec3 u_fromLook;
uniform vec3 u_toLook;
// ...and the tint colour itself.
uniform vec3 u_fromTint;
uniform vec3 u_toTint;
uniform float u_alpha;
uniform float u_reveal;
uniform int u_maskShape;
uniform vec2 u_maskDir;
uniform float u_maskCount;
uniform float u_maskFeather;
uniform bool u_maskInvert;
out vec4 fragColor;

// Where output pixel q samples a side's frame, or false where the moved frame does not cover it:
// the inverse of scale about the centre, turn about the centre, then offset - sideSource() exactly.
bool sideSource(vec4 move, vec2 turn, vec2 q, out vec2 s) {
  vec2 c = 0.5 * u_size;
  vec2 p = q - c - move.xy;
  s = c + vec2(p.x * turn.x - p.y * turn.y, p.x * turn.y + p.y * turn.x) / move.z;
  if (s.x < 0.0 || s.y < 0.0 || s.x >= u_size.x || s.y >= u_size.y) return false;
  // The mosaic snaps the position to the centre of its cell, the cells laid out from the frame's
  // centre so a pixelated frame is symmetrical rather than anchored to its top-left corner.
  if (move.w > 1.0) s = c + (floor((s - c) / move.w) + 0.5) * move.w;
  return true;
}

vec3 texel(sampler2D tex, vec2 s) {
  // The side was drawn with y DOWN into a texture whose rows run UP, so its top row is at t = 1.
  return textureLod(tex, vec2(s.x / u_size.x, 1.0 - s.y / u_size.y), 0.0).rgb;
}

vec3 shade(sampler2D tex, vec2 s, vec3 look, vec3 tint) {
  vec3 rgb;
  if (look.x != 0.0) {
    rgb = vec3(texel(tex, s + vec2(look.x, 0.0)).r, texel(tex, s).g, texel(tex, s - vec2(look.x, 0.0)).b);
  } else {
    rgb = texel(tex, s);
  }
  // Gain first and clamped, THEN the tint: a flash pushes the picture to white and tints over that.
  rgb = min(rgb * look.y, vec3(1.0));
  return mix(rgb, tint, look.z);
}

float maskMeasure(vec2 q) {
  vec2 v = q - 0.5 * u_size;
  float along = dot(v, u_maskDir);
  float extent = abs(u_size.x * u_maskDir.x) + abs(u_size.y * u_maskDir.y);
  if (u_maskShape == 0) return along / extent + 0.5;
  if (u_maskShape == 1) return length(v) / length(0.5 * u_size);
  if (u_maskShape == 2) return (abs(v.x) + abs(v.y)) / (0.5 * u_size.x + 0.5 * u_size.y);
  if (u_maskShape == 3) {
    // Clockwise from twelve o'clock, in y-down pixels.
    float turn = atan(v.x, -v.y) / 6.283185307179586;
    return turn < 0.0 ? turn + 1.0 : turn;
  }
  if (u_maskShape == 4) {
    float stripe = (along / extent + 0.5) * u_maskCount;
    return stripe - floor(stripe);
  }
  if (u_maskShape == 5) return abs(along) / (0.5 * extent);
  return 0.0;
}

float maskAlpha(vec2 q) {
  if (u_maskShape < 0) return 1.0;
  float fw = u_maskFeather;
  // Widened by the feather at both ends, so 0 lets nothing through and 1 everything, soft edge and all.
  float r = u_reveal * (1.0 + 2.0 * fw) - fw;
  float inside = 1.0 - smoothstep(r - fw, r + fw, maskMeasure(q));
  return u_maskInvert ? 1.0 - inside : inside;
}

void main() {
  // Pixel centres, y down: the reference is handed exactly these.
  vec2 q = vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y);
  vec3 rgb = vec3(0.0);
  vec2 s;
  if (u_hasFrom && sideSource(u_fromMove, u_fromTurn, q, s)) rgb = shade(u_fromTex, s, u_fromLook, u_fromTint);
  float cover = u_alpha * maskAlpha(q);
  if (u_hasTo && cover > 0.0 && sideSource(u_toMove, u_toTurn, q, s)) rgb = mix(rgb, shade(u_toTex, s, u_toLook, u_toTint), cover);
  fragColor = vec4(rgb, 1.0);
}`;

export class TransitionGl {
  private readonly targets = new Map<string, Target>();

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    /** Not readonly only for [resize]. */
    private frame: Frame,
    private readonly blur: Program,
    private readonly mix: Program,
  ) {}

  /**
   * Both programs, or null for a context that would not build them - which the painter reads as "no
   * GPU transitions here" and answers with its 2D path, the same way it answers a context that has
   * no GL at all.
   *
   * @param position the attribute location the painter's own quad is bound to, which both programs
   *   are linked to read.
   */
  static create(gl: WebGL2RenderingContext, frame: Frame, position: number): TransitionGl | null {
    const blur = link(gl, BLUR_FRAGMENT, position, ['u_src', 'u_size', 'u_step', 'u_sigma', 'u_radius']);
    const mix = link(gl, MIX_FRAGMENT, position, [
      'u_fromTex',
      'u_toTex',
      'u_size',
      'u_hasFrom',
      'u_hasTo',
      'u_fromMove',
      'u_toMove',
      'u_fromTurn',
      'u_toTurn',
      'u_fromLook',
      'u_toLook',
      'u_fromTint',
      'u_toTint',
      'u_alpha',
      'u_reveal',
      'u_maskShape',
      'u_maskDir',
      'u_maskCount',
      'u_maskFeather',
      'u_maskInvert',
    ]);
    if (!blur || !mix) {
      if (blur) gl.deleteProgram(blur.program);
      if (mix) gl.deleteProgram(mix.program);
      return null;
    }
    gl.useProgram(blur.program);
    gl.uniform1i(blur.uniforms['u_src'] ?? null, 0);
    gl.useProgram(mix.program);
    gl.uniform1i(mix.uniforms['u_fromTex'] ?? null, 0);
    gl.uniform1i(mix.uniforms['u_toTex'] ?? null, 1);
    return new TransitionGl(gl, frame, blur, mix);
  }

  /**
   * Points drawing at one side's own frame-sized target, cleared to OPAQUE black: the black a side's
   * bars are, and the black it is laid on. The painter then draws the side's layer into it with its
   * ordinary program, blending as it always does.
   */
  beginSide(side: TransitionSideName): void {
    const gl = this.gl;
    const target = this.target(side, this.frame.width, this.frame.height);
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /**
   * Blurs each side its look asks to have blurred, then mixes the two into the canvas's own
   * framebuffer, over every pixel of it.
   *
   * Leaves the canvas's framebuffer bound at the frame's viewport, blending OFF, the mix program in
   * use and texture unit 0 active with unit 1 emptied - the painter puts its own program and
   * blending back before it draws anything over the result. Unit 1 is emptied so that a later draw
   * INTO the incoming side's target can never find that same texture bound for sampling, which WebGL
   * refuses as a feedback loop.
   */
  composite(draw: TransitionDraw, hasFrom: boolean, hasTo: boolean): void {
    const gl = this.gl;
    const { width, height } = this.frame;
    gl.disable(gl.BLEND);
    const from = hasFrom ? this.blurred('from', draw.look.from.blur) : null;
    const to = hasTo ? this.blurred('to', draw.look.to.blur) : null;

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, width, height);
    gl.useProgram(this.mix.program);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, to?.texture ?? null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from?.texture ?? null);

    const u = this.mix.uniforms;
    gl.uniform2f(u['u_size'] ?? null, width, height);
    gl.uniform1i(u['u_hasFrom'] ?? null, from ? 1 : 0);
    gl.uniform1i(u['u_hasTo'] ?? null, to ? 1 : 0);
    this.sideUniforms('from', draw.look.from, draw.transition.fromTint);
    this.sideUniforms('to', draw.look.to, draw.transition.toTint);
    gl.uniform1f(u['u_alpha'] ?? null, draw.look.alpha);

    const mask = draw.transition.mask;
    if (mask) {
      const angle = ((mask.angleDeg ?? 0) * Math.PI) / 180;
      gl.uniform1i(u['u_maskShape'] ?? null, MASK_SHAPES[mask.shape] ?? UNKNOWN_MASK);
      gl.uniform2f(u['u_maskDir'] ?? null, Math.cos(angle), Math.sin(angle));
      gl.uniform1f(u['u_maskCount'] ?? null, Math.max(1, Math.round(mask.count ?? 1)));
      gl.uniform1f(u['u_maskFeather'] ?? null, Math.min(0.5, Math.max(0.0005, mask.feather ?? 0.01)));
      gl.uniform1i(u['u_maskInvert'] ?? null, mask.invert ? 1 : 0);
      gl.uniform1f(u['u_reveal'] ?? null, Math.min(1, Math.max(0, draw.look.reveal)));
    } else {
      gl.uniform1i(u['u_maskShape'] ?? null, NO_MASK);
    }

    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
  }

  /**
   * A new frame size, for a painter resized in place. Every target is sized from the frame, so every
   * one goes and is made again at the new size the first time it is asked for; both programs stay,
   * because nothing in them depends on the size - it is handed to them as a uniform on every draw.
   */
  resize(frame: Frame): void {
    const gl = this.gl;
    for (const target of this.targets.values()) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    this.targets.clear();
    this.frame = frame;
  }

  /** Every target and both programs. The context itself is the painter's to give back. */
  dispose(): void {
    const gl = this.gl;
    for (const target of this.targets.values()) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    this.targets.clear();
    gl.deleteProgram(this.blur.program);
    gl.deleteProgram(this.mix.program);
  }

  /* ------------------------------------------------------------------------------------------ */

  /**
   * One side's uniforms, worked out the way `sideSource` and `transitionPixel` work them out, so the
   * shader has no trigonometry to do per pixel and no clamp that the reference does not also make.
   */
  private sideUniforms(name: TransitionSideName, side: TransitionSide, tint: RGB | undefined): void {
    const gl = this.gl;
    const u = this.mix.uniforms;
    const { width, height } = this.frame;
    const turn = (-side.rotation * Math.PI) / 180;
    const cell = side.pixelate > 0 ? side.pixelate * Math.min(width, height) : 0;
    const colour = tint ?? BLACK;
    gl.uniform4f(u[`u_${name}Move`] ?? null, side.x * width, side.y * height, side.scale > 1e-6 ? side.scale : 1e-6, cell);
    gl.uniform2f(u[`u_${name}Turn`] ?? null, Math.cos(turn), Math.sin(turn));
    gl.uniform3f(u[`u_${name}Look`] ?? null, side.split * width, side.gain, side.tint);
    gl.uniform3f(u[`u_${name}Tint`] ?? null, colour[0], colour[1], colour[2]);
  }

  /**
   * The target to sample a side from: its own frame when it is sharp, and a Gaussian-blurred copy of
   * it when it is not.
   *
   * The sigma is `blur * min(W, H)` in OUTPUT pixels, as the contract has it. It is brought down to
   * [MIN_LEVEL_SIGMA]..2x texels by halving the frame, each halving a bilinear read at the exact
   * middle of four texels - a two-by-two box, with no texel skipped and no drift, because every
   * target is read by position rather than by texel index. What the halvings and the final bilinear
   * read back up blur on their own is taken off the sigma the passes are given, so the finished blur
   * has the sigma asked for rather than a few per cent more.
   *
   * A frame never halved is blurred IN PLACE - across into a scratch target, down back into its own -
   * because nothing reads it sharp once it is blurred.
   */
  private blurred(side: TransitionSideName, blur: number): Target {
    const { width, height } = this.frame;
    const sharp = this.target(side, width, height);
    const sigma = blur * Math.min(width, height);
    if (!(sigma >= MIN_BLUR_PX)) return sharp;

    let source = sharp;
    while (sigma / ((2 * width) / source.width) >= MIN_LEVEL_SIGMA && (source.width > 1 || source.height > 1)) {
      const next = this.target(side, Math.max(1, Math.round(source.width / 2)), Math.max(1, Math.round(source.height / 2)));
      this.pass(source, next, 0, 0, 0, 0);
      source = next;
    }

    const across = levelSigma(sigma, width / source.width, source !== sharp);
    const down = levelSigma(sigma, height / source.height, source !== sharp);
    const scratch = this.target('scratch', source.width, source.height);
    this.pass(source, scratch, 1 / source.width, 0, across, taps(across));
    this.pass(scratch, source, 0, 1 / source.height, down, taps(down));
    return source;
  }

  /** One full-target pass of the blur program: a plain resample with no taps, a 1D Gaussian with. */
  private pass(from: Target, into: Target, stepX: number, stepY: number, sigma: number, radius: number): void {
    const gl = this.gl;
    const u = this.blur.uniforms;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.viewport(0, 0, into.width, into.height);
    gl.useProgram(this.blur.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, from.texture);
    gl.uniform2f(u['u_size'] ?? null, into.width, into.height);
    gl.uniform2f(u['u_step'] ?? null, stepX, stepY);
    gl.uniform1f(u['u_sigma'] ?? null, Math.max(sigma, 1e-3));
    gl.uniform1i(u['u_radius'] ?? null, radius);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * A colour target of one size, made the first time it is asked for and kept. `role` separates the
   * two sides - both may be blurred at the same size in one frame, and each result has to survive
   * until the mix - from the scratch target a pass writes across into, which one side at a time uses.
   */
  private target(role: TransitionSideName | 'scratch', width: number, height: number): Target {
    const key = `${role}:${width}x${height}`;
    const existing = this.targets.get(key);
    if (existing) return existing;
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error('the GPU would not allocate a frame for the transition');
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // CLAMP_TO_EDGE is load-bearing here, not belt and braces: it is the edge clamp the contract's
    // blur and colour split are defined with. LINEAR is what reads a moved frame between its pixels.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const target = { texture, framebuffer, width, height };
    this.targets.set(key, target);
    return target;
  }
}

/**
 * The sigma a pass runs with, in texels of the target it runs over, for a wanted `sigma` in output
 * pixels and targets `texel` output pixels apart.
 *
 * On a halved frame the halvings have already blurred it - a box `texel` wide, variance
 * `(texel^2 - 1) / 12` - and the bilinear read back up blurs it again, by `texel^2 / 6` on average
 * over where a pixel falls between two texels. Variances add, so what is left for the Gaussian is
 * the difference. A frame never halved is read back at full size, where the reference reads between
 * pixels in the same way, so nothing is taken off - and nothing is FLOORED either: a sub-pixel sigma
 * is a real, faint blur that the first and last moments of a blur transition ramp through, and
 * rounding it up would soften exactly the frames either side of the cut.
 */
function levelSigma(sigma: number, texel: number, halved: boolean): number {
  if (!halved) return sigma;
  const already = (texel * texel - 1) / 12 + (texel * texel) / 6;
  // Halving stops while the sigma is still twice the texel, so what is left is never below
  // three quarters of it; the floor is there only so no rounding can take the square root negative.
  return Math.sqrt(Math.max(sigma * sigma - already, (sigma * sigma) / 4)) / texel;
}

/** Taps either side of centre for a sigma in texels: three sigma, where the Gaussian has 0.3% left. */
function taps(sigma: number): number {
  return Math.min(MAX_TAPS, Math.max(1, Math.ceil(3 * sigma)));
}

/**
 * Compiles and links one full-frame program, its quad attribute pinned to the painter's location.
 * Null for a context that refuses, with anything half made given back.
 */
function link(gl: WebGL2RenderingContext, fragmentSource: string, position: number, uniformNames: readonly string[]): Program | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, FULL_FRAME_VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) {
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    return null;
  }
  gl.attachShader(program, vertex);
  gl.attachShader(program, fragment);
  gl.bindAttribLocation(program, position, 'a_pos');
  gl.linkProgram(program);
  gl.deleteShader(vertex);
  gl.deleteShader(fragment);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    gl.deleteProgram(program);
    return null;
  }
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of uniformNames) uniforms[name] = gl.getUniformLocation(program, name);
  return { program, uniforms };
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
