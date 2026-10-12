import type { Frame } from './geometry';
import { BLUR_FRAGMENT, MIN_BLUR_PX, MIN_LEVEL_SIGMA, levelSigma, link, taps, type Program } from './transition-gl';

/**
 * A clip's focus on the GPU: the drawing contract in `ComposeFocus`, steps 4 to 8, done to a SOURCE
 * frame before the painter's layer program ever samples it.
 *
 * Before, not after, and that is the whole design. The contract makes focus the first thing done to
 * the footage - the crop, the fit, the turn, the grade, the camera and a transition all act on the
 * focused picture - so the painter hands this the layer's own texture and gets back another of the
 * same picture, focused, which it then draws exactly as it would have drawn the first. Nothing about
 * how a layer is placed has to know focus exists, and a clip with none never reaches this file.
 *
 * Three programs, run into frames of the source's shape at a working size (see [Painter]):
 *
 *  - PREP writes each pixel's colour WEIGHTED by how far out of focus it is, premultiplied: `(C * w,
 *    w)` with `w = 1 - e`. Blurring that and dividing by its alpha is the contract's weighted blur, in
 *    one pass of the Gaussian rather than two, and it is what keeps a subject's colour from bleeding
 *    into the softened world around it: a pixel in focus weighs nothing.
 *  - BLUR is the transitions' own separable Gaussian, after as many halvings as bring the sigma down
 *    to a few texels (see `TransitionGl.blurred`, whose arithmetic this repeats). Its four channels
 *    are all blurred, which is exactly what a premultiplied image needs.
 *  - COMPOSITE divides the blur out, greys and darkens it, and mixes the sharp frame back through the
 *    mask: `mix(B, C, e)`.
 *
 * The mask is the cell grid `focusMask` made for this instant, uploaded as a one-channel texture with
 * LINEAR filtering and its edges clamped, so reading it at a pixel IS the contract's bilinear
 * interpolation between cell centres; the ease is applied after, in both shaders, as the contract
 * orders it. A focus with no blur skips the first two programs: its out-of-focus colour is the frame.
 */

/** What a layer's focus is at the frame being drawn: see [LayerDraw.focus]. */
export interface FocusDraw {
  /** The grid's `m` at this instant, 0..255 a cell, row by row from the top-left (`focusMask`). */
  mask: Uint8Array;
  maskWidth: number;
  maskHeight: number;
  /**
   * Names `mask`'s contents: the same key is the same grid, and its upload is skipped. A caller that
   * cannot say passes something new every time and pays one small upload a frame.
   */
  maskKey: string;
  /** Gaussian sigma, a fraction of the source's shorter side: `ComposeFocus.blur`. */
  blur: number;
  mono: number;
  dim: number;
}

/** Which of a layer's frames a focus is for: its one frame, or frame B of a synthesised one. */
export type FocusRole = 'a' | 'b';

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

const PREP_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform vec2 u_size;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  float m = texture(u_mask, uv).r;
  float e = m * m * (3.0 - 2.0 * m);
  float w = 1.0 - e;
  fragColor = vec4(texture(u_src, uv).rgb * w, w);
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_mask;
uniform sampler2D u_soft;
uniform vec2 u_size;
uniform bool u_blurred;
uniform float u_mono;
uniform float u_dim;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec3 c = texture(u_src, uv).rgb;
  float m = texture(u_mask, uv).r;
  float e = m * m * (3.0 - 2.0 * m);
  vec3 b = c;
  if (u_blurred) {
    // Below 1/1024 nothing out of focus is near enough to say what is behind this pixel - deep
    // inside a subject, where e keeps the frame anyway - and the colour is the frame's own.
    vec4 soft = texture(u_soft, uv);
    if (soft.a >= 1.0 / 1024.0) b = soft.rgb / soft.a;
  }
  b = mix(b, vec3(dot(b, vec3(0.2126, 0.7152, 0.0722))), u_mono);
  b *= 1.0 - u_dim;
  fragColor = vec4(clamp(mix(b, c, e), 0.0, 1.0), 1.0);
}`;

export class FocusGl {
  private readonly targets = new Map<string, Target>();
  private readonly masks = new Map<FocusRole, { texture: WebGLTexture; key: string; width: number; height: number }>();

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly blur: Program,
    private readonly prep: Program,
    private readonly composite: Program,
  ) {}

  /**
   * The three programs, or null for a context that would not build them - which the painter answers
   * by drawing the frame without a shader, as it answers a context with no GL at all.
   *
   * @param position the attribute location the painter's own quad is bound to.
   */
  static create(gl: WebGL2RenderingContext, position: number): FocusGl | null {
    const blur = link(gl, BLUR_FRAGMENT, position, ['u_src', 'u_size', 'u_step', 'u_sigma', 'u_radius']);
    const prep = link(gl, PREP_FRAGMENT, position, ['u_src', 'u_mask', 'u_size']);
    const composite = link(gl, COMPOSITE_FRAGMENT, position, ['u_src', 'u_mask', 'u_soft', 'u_size', 'u_blurred', 'u_mono', 'u_dim']);
    if (!blur || !prep || !composite) {
      for (const built of [blur, prep, composite]) if (built) gl.deleteProgram(built.program);
      return null;
    }
    // Built in the middle of a layer's draw: the program that draw is using goes back in use after
    // the samplers are set, or the layer would be drawn by the last of these.
    const inUse = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    gl.useProgram(blur.program);
    gl.uniform1i(blur.uniforms['u_src'] ?? null, 0);
    gl.useProgram(prep.program);
    gl.uniform1i(prep.uniforms['u_src'] ?? null, 0);
    gl.uniform1i(prep.uniforms['u_mask'] ?? null, 1);
    gl.useProgram(composite.program);
    gl.uniform1i(composite.uniforms['u_src'] ?? null, 0);
    gl.uniform1i(composite.uniforms['u_mask'] ?? null, 1);
    gl.uniform1i(composite.uniforms['u_soft'] ?? null, 2);
    gl.useProgram(inUse);
    return new FocusGl(gl, blur, prep, composite);
  }

  /**
   * `source` - a texture of a `sourceWidth` x `sourceHeight` frame, the right way up as every layer
   * texture is - focused, at `work` size: a texture of this object's own, valid until the next call
   * for the same `role`.
   *
   * Leaves the framebuffer, the viewport, the program and blending as it found them, and unit 0
   * active; units 1 and 2 are emptied, so nothing a later draw renders into is left bound for
   * sampling, which WebGL refuses as a feedback loop.
   */
  apply(source: WebGLTexture, sourceWidth: number, sourceHeight: number, focus: FocusDraw, work: Frame, role: FocusRole): WebGLTexture {
    const gl = this.gl;
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const blending = gl.isEnabled(gl.BLEND);
    gl.disable(gl.BLEND);

    const mask = this.uploadMask(focus, role);
    // The sigma in WORKING texels: a fraction of the source's shorter side, scaled with the frame.
    const sigma = focus.blur * Math.min(sourceWidth, sourceHeight) * (work.width / sourceWidth);
    let soft: Target | null = null;
    if (sigma >= MIN_BLUR_PX) {
      const weighted = this.target('prep', work.width, work.height);
      this.draw(this.prep, weighted, source, mask, null);
      soft = this.blurred(weighted, sigma);
    }

    const out = this.target(`out-${role}`, work.width, work.height);
    const u = this.composite.uniforms;
    gl.useProgram(this.composite.program);
    gl.uniform1i(u['u_blurred'] ?? null, soft ? 1 : 0);
    gl.uniform1f(u['u_mono'] ?? null, focus.mono);
    gl.uniform1f(u['u_dim'] ?? null, focus.dim);
    this.draw(this.composite, out, source, mask, soft);

    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!);
    gl.useProgram(program);
    if (blending) gl.enable(gl.BLEND);
    return out.texture;
  }

  /** Every target, mask and program. The context itself is the painter's to give back. */
  dispose(): void {
    const gl = this.gl;
    for (const target of this.targets.values()) {
      gl.deleteFramebuffer(target.framebuffer);
      gl.deleteTexture(target.texture);
    }
    this.targets.clear();
    for (const mask of this.masks.values()) gl.deleteTexture(mask.texture);
    this.masks.clear();
    gl.deleteProgram(this.blur.program);
    gl.deleteProgram(this.prep.program);
    gl.deleteProgram(this.composite.program);
  }

  /* ------------------------------------------------------------------------------------------ */

  /** The role's mask texture with this focus's grid in it, uploaded only when the grid has changed. */
  private uploadMask(focus: FocusDraw, role: FocusRole): WebGLTexture {
    const gl = this.gl;
    let held = this.masks.get(role);
    if (!held) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('the GPU would not allocate a texture for a focus');
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // LINEAR and clamped: reading it at a pixel is the contract's interpolation between cell centres.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      held = { texture, key: '', width: 0, height: 0 };
      this.masks.set(role, held);
    }
    if (held.key === focus.maskKey && held.width === focus.maskWidth && held.height === focus.maskHeight) return held.texture;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, held.texture);
    // A grid's rows are one byte a cell, so a width that is not a multiple of four is not padded.
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, focus.maskWidth, focus.maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, focus.mask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
    gl.activeTexture(gl.TEXTURE0);
    held.key = focus.maskKey;
    held.width = focus.maskWidth;
    held.height = focus.maskHeight;
    return held.texture;
  }

  /** One full-target pass of PREP or COMPOSITE: the frame on unit 0, the mask on 1, the blur on 2. */
  private draw(program: Program, into: Target, source: WebGLTexture, mask: WebGLTexture, soft: Target | null): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.viewport(0, 0, into.width, into.height);
    gl.useProgram(program.program);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, soft?.texture ?? null);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, mask);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, source);
    gl.uniform2f(program.uniforms['u_size'] ?? null, into.width, into.height);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * The weighted frame Gaussian-blurred by `sigma` working texels: halved until the sigma is a few
   * texels, then blurred across and down at that size, the halvings' own softening taken off the
   * sigma the passes run with - `TransitionGl.blurred`, over a frame of the source's shape. A frame
   * never halved is blurred in place; nothing reads it sharp afterwards.
   */
  private blurred(weighted: Target, sigma: number): Target {
    const { width, height } = weighted;
    let source = weighted;
    while (sigma / ((2 * width) / source.width) >= MIN_LEVEL_SIGMA && (source.width > 1 || source.height > 1)) {
      const next = this.target('level', Math.max(1, Math.round(source.width / 2)), Math.max(1, Math.round(source.height / 2)));
      this.pass(source, next, 0, 0, 0, 0);
      source = next;
    }
    const across = levelSigma(sigma, width / source.width, source !== weighted);
    const down = levelSigma(sigma, height / source.height, source !== weighted);
    const scratch = this.target('scratch', source.width, source.height);
    this.pass(source, scratch, 1 / source.width, 0, across, taps(across));
    this.pass(scratch, source, 0, 1 / source.height, down, taps(down));
    return source;
  }

  /** One pass of the blur program: a plain resample with no taps, a 1D Gaussian with. */
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
   * A colour target of one size and role, made the first time it is asked for and kept. The roles keep
   * apart what must survive together: frame A's result until it is drawn while frame B is focused,
   * and a level from the scratch a pass writes across into.
   */
  private target(role: string, width: number, height: number): Target {
    const key = `${role}:${width}x${height}`;
    const existing = this.targets.get(key);
    if (existing) return existing;
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) throw new Error('the GPU would not allocate a frame for a focus');
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // CLAMP_TO_EDGE is the contract's edge clamp for the blur; LINEAR reads a level back up between texels.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const target = { texture, framebuffer, width, height };
    // A frame's size follows its source and the preview's stage, so old sizes are let go of rather
    // than kept for a source that has moved on: a role holds one size at a time. The halvings are a
    // chain of sizes together, made from the weighted frame's, so they go when it changes size.
    for (const [other, held] of this.targets) {
      const stale = role === 'level' ? false : other.startsWith(`${role}:`) || (role === 'prep' && other.startsWith('level:'));
      if (!stale) continue;
      gl.deleteFramebuffer(held.framebuffer);
      gl.deleteTexture(held.texture);
      this.targets.delete(other);
    }
    this.targets.set(key, target);
    return target;
  }
}
