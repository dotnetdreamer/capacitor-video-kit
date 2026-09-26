import { FLOW, flowPasses, flowPyramid, iterationsAt, lumaTaps, type FlowPassName, type FlowSettings, type FlowSize } from './optical-flow';

/**
 * The web engine's half of `optical-flow.ts`: the passes run on the painter's WebGL2 context, in the
 * order both engines run them, into half-float textures of the estimator's own. See that file for
 * what each pass does and why; this one only decides which texture each reads and writes.
 *
 * A PAIR'S ANSWER is two textures at the working size, a [FlowResult]: the flow both ways, and what
 * the missing frames read beside it (visibility both ways, the pair's trust). They belong to the
 * caller from then on - the painter keeps one per pair for as long as frames are drawn from that pair,
 * and hands it back with [release]. Everything else the passes use - pyramids, gradients, the flow
 * being refined, the round-trip test, the exposure and the trust - is scratch, kept across pairs for
 * up to [SCRATCH_SIZES] frame sizes at once, so a slowed clip allocates its handful of small textures
 * once, and so do two slowed clips of different resolutions drawn in the same frames.
 *
 * GL STATE. [estimate] draws into its own framebuffers, so it binds them, sets the viewport, turns
 * blending off and binds textures on units 0-3; it leaves the default framebuffer bound, unit 0 active
 * and units 0-3 empty, and the caller sets up everything else it draws with afterwards. The painter
 * runs it for every pair a frame needs BEFORE it draws any of the frame, never in the middle of a draw.
 *
 * The quad is the painter's: its 0..1 buffer is bound to the attribute location handed in, and every
 * program here is linked with `a_pos` at that location, as the transition programs are.
 */

/** A pair's answer: see the file comment. Both textures are the working size of the pair's frames. */
export interface FlowResult {
  /** Forward flow (A to B) in xy and backward flow (B to A) in zw, in texture coordinates. */
  flow: WebGLTexture;
  /** How visible A's texel is in B (x), B's in A (y), and the pair's trust (z). */
  visibility: WebGLTexture;
  width: number;
  height: number;
}

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

/** The scratch for one frame size: see the file comment. */
interface Scratch {
  width: number;
  height: number;
  sizes: FlowSize[];
  pyramid: Target[];
  gradient: Target[];
  /** Two per level: the flow being refined bounces between them. */
  flow: [Target, Target][];
  consistency: Target;
  exposure: Target;
  trust: Target;
}

const VERTEX = `#version 100
attribute vec2 a_pos;
void main() {
  gl_Position = vec4(a_pos * 2.0 - 1.0, 0.0, 1.0);
}`;

/** Each pass's samplers, in the texture units they are bound to. */
const SAMPLERS: Record<FlowPassName, readonly string[]> = {
  luma: ['u_frameA', 'u_frameB'],
  down: ['u_source'],
  exposure: ['u_pyramid'],
  gradient: ['u_pyramid'],
  lucasKanade: ['u_pyramid', 'u_gradient', 'u_flow', 'u_exposure'],
  median: ['u_flow'],
  consistency: ['u_flow', 'u_pyramid', 'u_exposure'],
  fill: ['u_flow', 'u_consistency', 'u_pyramid', 'u_exposure'],
  trust: ['u_consistency'],
  visibility: ['u_consistency', 'u_trust'],
};

const UNIFORMS = ['u_size', 'u_sourceTexel', 'u_fresh', 'u_taps', 'u_matrix', 'u_offset'];

/** The colour matrix the luma pass sees the frames through, as the layer shader takes it: see `luma`. */
export interface FlowGrade {
  /** Column-major 3x3. */
  matrix: Float32Array;
  offset: Float32Array;
}

const NO_GRADE: FlowGrade = { matrix: new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), offset: new Float32Array([0, 0, 0]) };

/**
 * How many frame sizes the scratch is kept for at once. One slowed clip is one size; a post with a
 * slowed layer over a slowed base clip of another resolution is two, and would otherwise make every
 * pair of each throw away and make again the other's textures.
 */
const SCRATCH_SIZES = 2;

export class FlowEstimator {
  /** By size, least recently used first; see [SCRATCH_SIZES]. */
  private readonly scratches = new Map<string, Scratch>();
  /** Every result handed out and not yet released, so [dispose] can free them too. */
  private readonly results = new Set<FlowResult>();
  private readonly resultTargets = new Map<WebGLTexture, Target>();

  private constructor(
    private readonly gl: WebGL2RenderingContext,
    private readonly programs: Record<FlowPassName, Program>,
    private readonly settings: FlowSettings,
  ) {}

  /**
   * An estimator on `gl`, or null where this context cannot run one: no half-float render targets, or
   * a pass that will not compile (a GPU without full-precision fragment shaders, which the flow cannot
   * do without). Null is not an error - the painter draws the blend, as it did before flow existed.
   *
   * @param position the attribute location the painter's quad buffer is bound to.
   */
  static create(gl: WebGL2RenderingContext, position: number, settings: FlowSettings = FLOW): FlowEstimator | null {
    // Enabling the extension is what makes a half-float framebuffer complete; without it a WebGL2
    // context refuses RGBA16F as a colour attachment even where the GPU could render to it.
    if (!gl.getExtension('EXT_color_buffer_float') && !gl.getExtension('EXT_color_buffer_half_float')) return null;
    const sources = flowPasses(settings);
    const programs: Partial<Record<FlowPassName, Program>> = {};
    for (const name of Object.keys(sources) as FlowPassName[]) {
      const built = link(gl, sources[name], position, SAMPLERS[name]);
      if (!built) {
        for (const made of Object.values(programs)) if (made) gl.deleteProgram(made.program);
        return null;
      }
      programs[name] = built;
    }
    const estimator = new FlowEstimator(gl, programs as Record<FlowPassName, Program>, settings);
    // A driver can accept the extension and still refuse the attachment; better to find out now, on
    // one texel, than halfway through the first pair.
    const probe = estimator.target(1, 1);
    if (!probe) {
      estimator.dispose();
      return null;
    }
    estimator.free(probe);
    return estimator;
  }

  /**
   * The flow between `frameA` and `frameB`, two textures of one `width` x `height` picture seen through
   * `grade` (the post's colour matrix; the identity for none): every pass of `optical-flow.ts`, in
   * order. Null when the GPU would not give a texture for it, in which case the pair is drawn as the
   * blend.
   */
  estimate(frameA: WebGLTexture, frameB: WebGLTexture, width: number, height: number, grade: FlowGrade = NO_GRADE): FlowResult | null {
    const gl = this.gl;
    const scratch = this.scratchFor(width, height);
    if (!scratch) return null;
    const result = this.newResult(scratch.sizes[0]!);
    if (!result) return null;
    const levels = scratch.sizes.length;
    gl.disable(gl.BLEND);

    this.pass('luma', scratch.pyramid[0]!, [frameA, frameB], {
      u_taps: [lumaTaps(width, height, scratch.sizes[0]!, this.settings)],
      u_matrix: grade.matrix,
      u_offset: grade.offset,
    });
    for (let level = 1; level < levels; level++) {
      const source = scratch.pyramid[level - 1]!;
      this.pass('down', scratch.pyramid[level]!, [source.texture], { u_sourceTexel: [1 / source.width, 1 / source.height] });
    }
    this.pass('exposure', scratch.exposure, [scratch.pyramid[levels - 1]!.texture]);
    for (let level = 0; level < levels; level++) this.pass('gradient', scratch.gradient[level]!, [scratch.pyramid[level]!.texture]);

    // Coarse to fine. `estimate` is whichever texture holds the latest flow; at the start of a level it
    // is the coarser level's answer, which the first iteration reads through bilinear filtering. The
    // coarsest level's first iteration has none and is told so; its flow sampler is given the
    // exposure texel only so that nothing it could be bound to is a target.
    let estimate: WebGLTexture | null = null;
    for (let level = levels - 1; level >= 0; level--) {
      const [ping, pong] = scratch.flow[level]!;
      const bounce = (index: number): Target => (index % 2 === 0 ? ping : pong);
      const iterations = iterationsAt(level, this.settings);
      for (let i = 0; i < iterations; i++) {
        const target = bounce(i);
        this.pass('lucasKanade', target, [scratch.pyramid[level]!.texture, scratch.gradient[level]!.texture, estimate ?? scratch.exposure.texture, scratch.exposure.texture], {
          u_fresh: [estimate === null ? 1 : 0],
        });
        estimate = target.texture;
      }
      if (this.settings.median && estimate) {
        const target = bounce(iterations);
        this.pass('median', target, [estimate]);
        estimate = target.texture;
      }
    }

    // The round trip is tested on the flow as estimated, and the texels it fails are then filled in
    // from their neighbours into the answer; see the `fill` pass.
    const estimated = estimate ?? scratch.exposure.texture;
    this.pass('consistency', scratch.consistency, [estimated, scratch.pyramid[0]!.texture, scratch.exposure.texture]);
    this.pass('fill', this.resultTarget(result.flow), [estimated, scratch.consistency.texture, scratch.pyramid[0]!.texture, scratch.exposure.texture]);
    this.pass('trust', scratch.trust, [scratch.consistency.texture]);
    this.pass('visibility', this.resultTarget(result.visibility), [scratch.consistency.texture, scratch.trust.texture]);

    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.activeTexture(gl.TEXTURE0);
    return result;
  }

  /** Frees a result handed out by [estimate]. */
  release(result: FlowResult): void {
    if (!this.results.delete(result)) return;
    for (const texture of [result.flow, result.visibility]) {
      const target = this.resultTargets.get(texture);
      this.resultTargets.delete(texture);
      if (target) this.free(target);
    }
  }

  /** Frees everything: the programs, the scratch and every result not yet released. */
  dispose(): void {
    for (const result of [...this.results]) this.release(result);
    for (const scratch of this.scratches.values()) this.dropScratch(scratch);
    this.scratches.clear();
    for (const program of Object.values(this.programs)) this.gl.deleteProgram(program.program);
  }

  /* ------------------------------------------------------------------------------------------ */

  /** One pass: `name` into `target`, reading `inputs` on units 0, 1, ... in its sampler order. */
  private pass(name: FlowPassName, target: Target, inputs: readonly WebGLTexture[], uniforms: Record<string, ArrayLike<number>> = {}): void {
    const gl = this.gl;
    const program = this.programs[name];
    gl.bindFramebuffer(gl.FRAMEBUFFER, target.framebuffer);
    gl.viewport(0, 0, target.width, target.height);
    gl.useProgram(program.program);
    inputs.forEach((texture, unit) => {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, texture);
    });
    const size = program.uniforms['u_size'];
    if (size) gl.uniform2f(size, target.width, target.height);
    for (const [key, value] of Object.entries(uniforms)) {
      const location = program.uniforms[key];
      if (!location) continue;
      if (value.length === 9) gl.uniformMatrix3fv(location, false, Array.from(value));
      else if (value.length === 3) gl.uniform3f(location, value[0]!, value[1]!, value[2]!);
      else if (value.length === 2) gl.uniform2f(location, value[0]!, value[1]!);
      else gl.uniform1f(location, value[0]!);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    // Unbound again at once: the next pass may render into one of these, and a texture that is both
    // bound for sampling and attached to the framebuffer being drawn is a feedback loop WebGL refuses.
    for (let unit = inputs.length - 1; unit >= 0; unit--) {
      gl.activeTexture(gl.TEXTURE0 + unit);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  private scratchFor(width: number, height: number): Scratch | null {
    const key = `${width}x${height}`;
    const kept = this.scratches.get(key);
    if (kept) {
      this.scratches.delete(key);
      this.scratches.set(key, kept);
      return kept;
    }
    while (this.scratches.size >= SCRATCH_SIZES) {
      const oldest = this.scratches.keys().next().value as string;
      this.dropScratch(this.scratches.get(oldest)!);
      this.scratches.delete(oldest);
    }
    const sizes = flowPyramid(width, height, this.settings);
    if (sizes.length === 0) return null;
    const made: Target[] = [];
    let failed = false;
    const make = (size: FlowSize): Target => {
      const target = this.target(size.width, size.height);
      if (!target) {
        failed = true;
        return null as unknown as Target;
      }
      made.push(target);
      return target;
    };
    const scratch: Scratch = {
      width,
      height,
      sizes,
      pyramid: sizes.map(make),
      gradient: sizes.map(make),
      flow: sizes.map(size => [make(size), make(size)]),
      consistency: make(sizes[0]!),
      exposure: make({ width: 1, height: 1 }),
      trust: make({ width: 1, height: 1 }),
    };
    if (failed) {
      for (const target of made) this.free(target);
      return null;
    }
    this.scratches.set(key, scratch);
    return scratch;
  }

  private dropScratch(scratch: Scratch): void {
    for (const target of [...scratch.pyramid, ...scratch.gradient, ...scratch.flow.flat(), scratch.consistency, scratch.exposure, scratch.trust]) this.free(target);
  }

  private newResult(size: FlowSize): FlowResult | null {
    const flow = this.target(size.width, size.height);
    const visibility = this.target(size.width, size.height);
    if (!flow || !visibility) {
      if (flow) this.free(flow);
      if (visibility) this.free(visibility);
      return null;
    }
    this.resultTargets.set(flow.texture, flow);
    this.resultTargets.set(visibility.texture, visibility);
    const result: FlowResult = { flow: flow.texture, visibility: visibility.texture, width: size.width, height: size.height };
    this.results.add(result);
    return result;
  }

  private resultTarget(texture: WebGLTexture): Target {
    const target = this.resultTargets.get(texture);
    if (!target) throw new Error('a flow result that is not this estimator’s');
    return target;
  }

  /** A half-float texture of this size with a framebuffer on it, or null where the GPU will not render to one. */
  private target(width: number, height: number): Target | null {
    const gl = this.gl;
    const texture = gl.createTexture();
    const framebuffer = gl.createFramebuffer();
    if (!texture || !framebuffer) {
      if (texture) gl.deleteTexture(texture);
      if (framebuffer) gl.deleteFramebuffer(framebuffer);
      return null;
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, width, height, 0, gl.RGBA, gl.HALF_FLOAT, null);
    // LINEAR is what makes a coarser level's flow this level's starting point, and what spreads the
    // working-size flow over the full-resolution picture; CLAMP_TO_EDGE is what a read past the frame's
    // edge should see.
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindTexture(gl.TEXTURE_2D, null);
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    const complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (!complete) {
      gl.deleteFramebuffer(framebuffer);
      gl.deleteTexture(texture);
      return null;
    }
    return { texture, framebuffer, width, height };
  }

  private free(target: Target): void {
    this.gl.deleteFramebuffer(target.framebuffer);
    this.gl.deleteTexture(target.texture);
  }
}

function link(gl: WebGL2RenderingContext, fragmentSource: string, position: number, samplers: readonly string[]): Program | null {
  const vertex = compile(gl, gl.VERTEX_SHADER, VERTEX);
  const fragment = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) {
    if (vertex) gl.deleteShader(vertex);
    if (fragment) gl.deleteShader(fragment);
    return null;
  }
  const program = gl.createProgram();
  if (!program) return null;
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
  gl.useProgram(program);
  samplers.forEach((name, unit) => gl.uniform1i(gl.getUniformLocation(program, name), unit));
  const uniforms: Record<string, WebGLUniformLocation | null> = {};
  for (const name of UNIFORMS) uniforms[name] = gl.getUniformLocation(program, name);
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
