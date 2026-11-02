import { CUTOUT_EPSILON, CUTOUT_RADIUS } from '../definitions';
import type { Frame } from './geometry';
import { BLUR_FRAGMENT, link, type Program } from './transition-gl';

/**
 * A clip's cutout on the GPU: [ComposeCutout]'s drawing contract, steps 2 to 9, done to a SOURCE frame
 * before the painter's layer program samples it - the arrangement `focus-gl.ts` has, for its reason:
 * the painter hands this the layer's texture and gets back another of the same picture, cut out, which
 * it then draws exactly as it would have drawn the first.
 *
 * What comes back is PREMULTIPLIED and already GRADED. Graded because the contract has the cutout come
 * after the grade - its guide is the graded picture, and an outline or a fill is a colour the grade
 * never touches - so a layer drawn from it is drawn with no grade of its own. Premultiplied because
 * the layer program blends that way, and because a frame made between two of these (a slowed clip)
 * is then their plain mix.
 *
 * THE REFINEMENT, steps 3 and 4, runs at the GRID's size, which is what makes it cheap: a video's grid
 * is 512 cells on its longer side however large the footage, so the guided filter's box means are a
 * few passes over a few hundred thousand cells. Only the last pass - reading the coefficients at a
 * pixel, step 5, and everything after - is at the working size. The numbers it carries (variances,
 * coefficients far outside 0..1) need float targets; a browser that cannot render to one skips the
 * refinement, as the contract allows, and reads the matte as it is.
 *
 *  - STATS writes each cell's `(y, m, y * y, y * m)`: the guide from four bilinear reads of the graded
 *    frame a quarter of a cell either way from its centre, each the mean of the four pixels round it,
 *    and the matte at the cell's centre.
 *  - BOX takes the mean over `2R + 1` cells along one direction, the texture clamping at its edges
 *    (which is the contract's "nearest edge cell"); run across and then down, twice.
 *  - COEF turns the means into `a` and `b`.
 *  - The OUTLINE's `D` is the matte through the transitions' own separable Gaussian, at the grid's size.
 *  - COMPOSITE is steps 5 to 8, and the preview's reveal on top of them.
 */

/** What a layer's cutout is at the frame being drawn: see [LayerDraw.cutout]. */
export interface CutoutDraw {
  /** The grid's `m` at this instant, 0..255 a cell, row by row from the top-left (`matteAt`). */
  matte: Uint8Array;
  matteWidth: number;
  matteHeight: number;
  /** Names `matte`'s contents: the same key is the same grid, and its upload is skipped. */
  matteKey: string;
  soft: number;
  shift: number;
  /** 0..1 RGB behind the subject, or null for none. */
  fill: [number, number, number] | null;
  /** The outline's colour and its sigma and spread in CELLS (step 7), or null for none. */
  outline: { color: [number, number, number]; sigma: number; spread: number } | null;
  /**
   * The preview's reveal, 0..1: how far the frame has gone from the picture as it was (0) to the
   * cutout (1), with a glow run round the subject's edge on the way. Absent is 1 with no glow, which is
   * what a render always draws: the reveal is the editor's, and never reaches a spec.
   */
  reveal?: number;
}

/** The post's colour matrix as the layer program takes it: column-major 3x3 and an offset. */
export interface CutoutGrade {
  matrix: Float32Array;
  offset: Float32Array;
}

/** Which of a layer's frames a cutout is for: its one frame, or frame B of a synthesised one. */
export type CutoutRole = 'a' | 'b';

interface Target {
  texture: WebGLTexture;
  framebuffer: WebGLFramebuffer;
  width: number;
  height: number;
}

/** The colour the reveal's glow runs round the subject in, 0..1 RGB: a cool white. The 2D path's reveal ([Cutout2d]) is lit the same. */
export const REVEAL_GLOW: readonly [number, number, number] = [0.82, 0.93, 1.0];
const GLOW = REVEAL_GLOW.map(channel => channel.toFixed(2)).join(', ');

/** The most box taps either side of a cell; [CUTOUT_RADIUS] is the one used. */
const MAX_BOX_RADIUS = 8;

const STATS_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_matte;
uniform vec2 u_size;
uniform mat3 u_matrix;
uniform vec3 u_offset;
out vec4 fragColor;
float gradedLuma(vec2 uv) {
  vec3 c = clamp(u_matrix * texture(u_src, uv).rgb + u_offset, 0.0, 1.0);
  return dot(c, vec3(0.2126, 0.7152, 0.0722));
}
void main() {
  vec2 cell = 1.0 / u_size;
  vec2 uv = gl_FragCoord.xy * cell;
  vec2 q = 0.25 * cell;
  float y = 0.25 * (gradedLuma(uv - q) + gradedLuma(uv + vec2(q.x, -q.y)) + gradedLuma(uv + vec2(-q.x, q.y)) + gradedLuma(uv + q));
  float m = texture(u_matte, uv).r;
  fragColor = vec4(y, m, y * y, y * m);
}`;

const BOX_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
uniform vec2 u_step;
uniform int u_radius;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 sum = vec4(0.0);
  for (int i = -${MAX_BOX_RADIUS}; i <= ${MAX_BOX_RADIUS}; i++) {
    if (i < -u_radius || i > u_radius) continue;
    sum += textureLod(u_src, uv + float(i) * u_step, 0.0);
  }
  fragColor = sum / float(2 * u_radius + 1);
}`;

const COEF_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform vec2 u_size;
uniform float u_epsilon;
out vec4 fragColor;
void main() {
  vec4 s = textureLod(u_src, gl_FragCoord.xy / u_size, 0.0);
  float a = (s.w - s.x * s.y) / (s.z - s.x * s.x + u_epsilon);
  fragColor = vec4(a, s.y - a * s.x, 0.0, 1.0);
}`;

const COMPOSITE_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D u_src;
uniform sampler2D u_coef;
uniform sampler2D u_matte;
uniform sampler2D u_line;
uniform vec2 u_size;
uniform mat3 u_matrix;
uniform vec3 u_offset;
uniform bool u_refined;
uniform float u_soft;
uniform float u_shift;
uniform bool u_outlined;
uniform vec3 u_lineColor;
uniform float u_lineSpread;
uniform bool u_filled;
uniform vec3 u_fill;
uniform float u_reveal;
out vec4 fragColor;
void main() {
  vec2 uv = gl_FragCoord.xy / u_size;
  vec4 texel = texture(u_src, uv);
  vec3 c = clamp(u_matrix * texel.rgb + u_offset, 0.0, 1.0);
  float q;
  if (u_refined) {
    vec2 ab = texture(u_coef, uv).xy;
    q = clamp(ab.x * dot(c, vec3(0.2126, 0.7152, 0.0722)) + ab.y, 0.0, 1.0);
  } else {
    q = texture(u_matte, uv).r;
  }
  float t = 0.5 - 0.25 * u_shift;
  float h = 0.06 + 0.44 * u_soft;
  // A picture's own alpha is the subject's, so its transparent parts take the line and the fill.
  float a0 = smoothstep(t - h, t + h, q) * texel.a;
  float a = a0;
  vec3 colour = c;
  if (u_outlined) {
    float o = smoothstep(0.06 - u_lineSpread, 0.06 + u_lineSpread, texture(u_line, uv).r);
    a = a0 + (1.0 - a0) * o;
    if (a > 0.0) colour = (c * a0 + u_lineColor * (1.0 - a0) * o) / a;
  }
  if (u_filled) {
    colour = mix(u_fill, colour, a);
    a = 1.0;
  }
  vec4 cut = vec4(colour * a, a);
  if (u_reveal >= 1.0) {
    fragColor = cut;
    return;
  }
  // The preview's reveal: the picture as it was giving way to the cutout, and a glow round the
  // subject's edge that rises and falls with it. A render never has one.
  vec4 shown = mix(vec4(c * texel.a, texel.a), cut, u_reveal);
  float glow = 4.0 * a0 * (1.0 - a0) * sin(3.14159265 * clamp(u_reveal, 0.0, 1.0));
  fragColor = shown * (1.0 - glow) + vec4(${GLOW}, 1.0) * glow;
}`;

export class CutoutGl {
  private readonly targets = new Map<string, Target>();
  private readonly mattes = new Map<CutoutRole, { texture: WebGLTexture; key: string; width: number; height: number }>();
  /** Whether this context renders to half-float targets; settled the first time it is asked. */
  private floats: boolean | undefined = undefined;

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly stats: Program,
    private readonly box: Program,
    private readonly coef: Program,
    private readonly blur: Program,
    private readonly composite: Program,
  ) {}

  /**
   * The programs, or null for a context that would not build them - which the painter answers by
   * drawing the frame on its 2D path, which draws a cutout too.
   *
   * @param position the attribute location the painter's own quad is bound to.
   */
  static create(gl: WebGL2RenderingContext, position: number): CutoutGl | null {
    const stats = link(gl, STATS_FRAGMENT, position, ['u_src', 'u_matte', 'u_size', 'u_matrix', 'u_offset']);
    const box = link(gl, BOX_FRAGMENT, position, ['u_src', 'u_size', 'u_step', 'u_radius']);
    const coef = link(gl, COEF_FRAGMENT, position, ['u_src', 'u_size', 'u_epsilon']);
    const blur = link(gl, BLUR_FRAGMENT, position, ['u_src', 'u_size', 'u_step', 'u_sigma', 'u_radius']);
    const composite = link(gl, COMPOSITE_FRAGMENT, position, [
      'u_src',
      'u_coef',
      'u_matte',
      'u_line',
      'u_size',
      'u_matrix',
      'u_offset',
      'u_refined',
      'u_soft',
      'u_shift',
      'u_outlined',
      'u_lineColor',
      'u_lineSpread',
      'u_filled',
      'u_fill',
      'u_reveal',
    ]);
    if (!stats || !box || !coef || !blur || !composite) {
      for (const built of [stats, box, coef, blur, composite]) if (built) gl.deleteProgram(built.program);
      return null;
    }
    // Built in the middle of a layer's draw: the program that draw is using goes back in use after the
    // samplers are set, or the layer would be drawn by the last of these.
    const inUse = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const samplers = (program: Program, names: readonly string[]): void => {
      gl.useProgram(program.program);
      names.forEach((name, unit) => gl.uniform1i(program.uniforms[name] ?? null, unit));
    };
    samplers(stats, ['u_src', 'u_matte']);
    samplers(box, ['u_src']);
    samplers(coef, ['u_src']);
    samplers(blur, ['u_src']);
    samplers(composite, ['u_src', 'u_coef', 'u_matte', 'u_line']);
    gl.useProgram(inUse);
    return new CutoutGl(gl, stats, box, coef, blur, composite);
  }

  /**
   * `source` - a texture of a frame, the right way up as every layer texture is - cut out, graded
   * and premultiplied, at `work` size: a texture of this object's own, valid until the next call for
   * the same `role`.
   *
   * Leaves the framebuffer, the viewport, the program and blending as it found them, and unit 0
   * active; units 1 to 3 are emptied, so nothing a later draw renders into is left bound for
   * sampling, which WebGL refuses as a feedback loop.
   */
  apply(source: WebGLTexture, cutout: CutoutDraw, grade: CutoutGrade, work: Frame, role: CutoutRole): WebGLTexture {
    const gl = this.gl;
    const framebuffer = gl.getParameter(gl.FRAMEBUFFER_BINDING) as WebGLFramebuffer | null;
    const viewport = gl.getParameter(gl.VIEWPORT) as Int32Array;
    const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram | null;
    const blending = gl.isEnabled(gl.BLEND);
    gl.disable(gl.BLEND);

    const matte = this.uploadMatte(cutout, role);
    const gw = cutout.matteWidth;
    const gh = cutout.matteHeight;
    const floats = this.renderToFloat();
    let coefficients: Target | null = null;
    if (floats) {
      const stats = this.target('stats', gw, gh, true);
      this.pass(this.stats, stats, [source, matte], u => {
        gl.uniformMatrix3fv(u['u_matrix'] ?? null, false, grade.matrix);
        gl.uniform3fv(u['u_offset'] ?? null, grade.offset);
      });
      const means = this.boxed(stats, 'means');
      const coef = this.target('coef', gw, gh, true);
      this.pass(this.coef, coef, [means.texture], u => gl.uniform1f(u['u_epsilon'] ?? null, CUTOUT_EPSILON));
      coefficients = this.boxed(coef, 'coefs');
    }
    let line: Target | null = null;
    if (cutout.outline) {
      const across = this.target('line-across', gw, gh, floats);
      this.blurPass(matte, across, 1 / gw, 0, cutout.outline.sigma);
      line = this.target('line', gw, gh, floats);
      this.blurPass(across.texture, line, 0, 1 / gh, cutout.outline.sigma);
    }

    const out = this.target(`out-${role}`, work.width, work.height, false);
    const u = this.composite.uniforms;
    this.pass(this.composite, out, [source, coefficients?.texture ?? null, matte, line?.texture ?? null], () => {
      gl.uniformMatrix3fv(u['u_matrix'] ?? null, false, grade.matrix);
      gl.uniform3fv(u['u_offset'] ?? null, grade.offset);
      gl.uniform1i(u['u_refined'] ?? null, coefficients ? 1 : 0);
      gl.uniform1f(u['u_soft'] ?? null, cutout.soft);
      gl.uniform1f(u['u_shift'] ?? null, cutout.shift);
      gl.uniform1i(u['u_outlined'] ?? null, cutout.outline ? 1 : 0);
      gl.uniform3fv(u['u_lineColor'] ?? null, cutout.outline?.color ?? [0, 0, 0]);
      gl.uniform1f(u['u_lineSpread'] ?? null, cutout.outline?.spread ?? 0);
      gl.uniform1i(u['u_filled'] ?? null, cutout.fill ? 1 : 0);
      gl.uniform3fv(u['u_fill'] ?? null, cutout.fill ?? [0, 0, 0]);
      gl.uniform1f(u['u_reveal'] ?? null, cutout.reveal ?? 1);
    });

    for (const unit of [gl.TEXTURE3, gl.TEXTURE2, gl.TEXTURE1]) {
      gl.activeTexture(unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.viewport(viewport[0]!, viewport[1]!, viewport[2]!, viewport[3]!);
    gl.useProgram(program);
    if (blending) gl.enable(gl.BLEND);
    return out.texture;
  }

  /** Every target, matte and program. The context itself is the painter's to give back. */
  dispose(): void {
    const gl = this.gl;
    for (const target of this.targets.values()) this.release(target);
    this.targets.clear();
    for (const matte of this.mattes.values()) gl.deleteTexture(matte.texture);
    this.mattes.clear();
    for (const built of [this.stats, this.box, this.coef, this.blur, this.composite]) gl.deleteProgram(built.program);
  }

  /* ------------------------------------------------------------------------------------------ */

  /** Whether the refinement can run: half-float targets this context renders to, found out once. */
  private renderToFloat(): boolean {
    if (this.floats === undefined) {
      this.floats = !!this.gl.getExtension('EXT_color_buffer_float');
      if (this.floats) {
        // An extension claimed is not a target made: one is tried, and dropped, before it is relied on.
        const probe = this.makeTarget(4, 4, true);
        this.floats = probe !== null;
        if (probe) this.release(probe);
      }
    }
    return this.floats;
  }

  /** The role's matte texture with this cutout's grid in it, uploaded only when the grid has changed. */
  private uploadMatte(cutout: CutoutDraw, role: CutoutRole): WebGLTexture {
    const gl = this.gl;
    let held = this.mattes.get(role);
    if (!held) {
      const texture = gl.createTexture();
      if (!texture) throw new Error('the GPU would not allocate a texture for a cutout');
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      // LINEAR and clamped: reading it at a pixel is the contract's interpolation between cell centres.
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      held = { texture, key: '', width: 0, height: 0 };
      this.mattes.set(role, held);
    }
    if (held.key !== cutout.matteKey || held.width !== cutout.matteWidth || held.height !== cutout.matteHeight) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, held.texture);
      // One byte a cell, so a width that is not a multiple of four is not padded.
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cutout.matteWidth, cutout.matteHeight, 0, gl.RED, gl.UNSIGNED_BYTE, cutout.matte);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 4);
      held.key = cutout.matteKey;
      held.width = cutout.matteWidth;
      held.height = cutout.matteHeight;
    }
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.activeTexture(gl.TEXTURE0);
    return held.texture;
  }

  /** `from` box-averaged across into `<name>-across` and down into `<name>`: the contract's `mean`. */
  private boxed(from: Target, name: string): Target {
    const gl = this.gl;
    const across = this.target(`${name}-across`, from.width, from.height, true);
    this.pass(this.box, across, [from.texture], u => {
      gl.uniform2f(u['u_step'] ?? null, 1 / from.width, 0);
      gl.uniform1i(u['u_radius'] ?? null, CUTOUT_RADIUS);
    });
    const down = this.target(name, from.width, from.height, true);
    this.pass(this.box, down, [across.texture], u => {
      gl.uniform2f(u['u_step'] ?? null, 0, 1 / from.height);
      gl.uniform1i(u['u_radius'] ?? null, CUTOUT_RADIUS);
    });
    return down;
  }

  /** One direction of the outline's Gaussian, at the grid's size; a sigma under a cell copies. */
  private blurPass(from: WebGLTexture, into: Target, stepX: number, stepY: number, sigma: number): void {
    const gl = this.gl;
    const radius = sigma >= 1 ? Math.min(64, Math.ceil(3 * sigma)) : 0;
    this.pass(this.blur, into, [from], u => {
      gl.uniform2f(u['u_step'] ?? null, stepX, stepY);
      gl.uniform1f(u['u_sigma'] ?? null, Math.max(sigma, 1e-3));
      gl.uniform1i(u['u_radius'] ?? null, radius);
    });
  }

  /**
   * One full-target pass of `program` into `into`: `inputs` on units 0 up, a null input left unbound
   * (its sampler is never read), the size set, and `set` for the rest of the uniforms.
   */
  private pass(program: Program, into: Target, inputs: ReadonlyArray<WebGLTexture | null>, set: (uniforms: Program['uniforms']) => void): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
    gl.viewport(0, 0, into.width, into.height);
    gl.useProgram(program.program);
    for (let unit = inputs.length - 1; unit >= 0; unit--) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, inputs[unit] ?? null);
    }
    gl.uniform2f(program.uniforms['u_size'] ?? null, into.width, into.height);
    set(program.uniforms);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }

  /**
   * A target of one size and role, made the first time it is asked for and kept: half-float for the
   * refinement's numbers and the outline's, eight bits for the picture that leaves. A role holds one
   * size at a time, so a role asked for at a new size lets its old one go.
   */
  private target(role: string, width: number, height: number, float: boolean): Target {
    const key = `${role}:${width}x${height}:${float ? 'f' : 'b'}`;
    const existing = this.targets.get(key);
    if (existing) return existing;
    for (const [other, held] of this.targets) {
      if (!other.startsWith(`${role}:`)) continue;
      this.release(held);
      this.targets.delete(other);
    }
    const made = this.makeTarget(width, height, float) ?? (float ? this.makeTarget(width, height, false) : null);
    if (!made) throw new Error('the GPU would not allocate a frame for a cutout');
    this.targets.set(key, made);
    return made;
  }

  /** A colour texture with a framebuffer on it, or null where the GPU will not render to one of that kind. */
  private makeTarget(width: number, height: number, float: boolean): Target | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      return null;
    }
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    if (float) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    // CLAMP_TO_EDGE is the contract's edge rule for the means and the blur; LINEAR is its reading of a
    // grid at a pixel, and a box pass reads only texel centres, where it is exact.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindTexture(gl.TEXTURE_2D, null);
    if (complete) return { texture, framebuffer, width, height };
    gl.deleteFramebuffer(framebuffer);
    gl.deleteTexture(texture);
    return null;
  }

  private release(target: Target): void {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }
}
