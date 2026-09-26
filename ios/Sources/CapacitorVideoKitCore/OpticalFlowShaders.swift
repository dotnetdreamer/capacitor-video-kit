import Foundation

/// The flow's passes by the name every engine calls them (`FlowPassName` in optical-flow.ts). The raw
/// value is the name; the Metal kernel is `flow_<name>`.
enum FlowPass: String, CaseIterable, Sendable {
    case luma, down, exposure, gradient, lucasKanade, median, consistency, fill, trust, visibility

    /// The kernel's function name in its library.
    var kernelName: String { "flow_" + rawValue }
}

/// The optical flow's GPU half in the Metal Shading Language, GENERATED from `FlowSettings` exactly the
/// way `flowPasses(settings)` in optical-flow.ts generates the GLSL ES 1.00 the web and Android engines
/// run: the same passes, the same constants spliced in at the same places, the same structure line by
/// line wherever MSL allows. Metal is not GLSL, so the parity test cannot compare the text; it holds
/// the SETTINGS to the TypeScript field for field, and the numbers (the benchmark, the web-parity PSNR)
/// hold the kernels to the shaders. Keeping each kernel's body a near-verbatim copy of its GLSL twin is
/// what makes a reviewer's diff between the two short enough to read: `vec2`/`vec3`/`vec4`/`mat3` are
/// typedefs and `texture2D(t, uv)` is a macro over `t.sample(...)`, so only what MSL forces differs.
///
/// WHAT MSL FORCES, and why each is equivalent:
///  - Each pass is a COMPUTE kernel, not a fragment program: thread (x, y) of the dispatch is texel
///    (x, y) of the target, and `gl_FragCoord.xy` is `(x, y) + 0.5` - exactly what GL hands a fragment at
///    that texel's centre. There is no NDC and no viewport anywhere, so there is no y flip to get wrong:
///    row 0 of every texture is the first row of the CVPixelBuffer it came from (the TOP of the
///    picture), which is row 0 of the web painter's textures too (it uploads without UNPACK_FLIP_Y), and
///    a positive flow y means DOWN in the picture in all three engines. FlowEstimatorTests pins that.
///  - `gl_FragColor = c` is `target.write(c, gid)`; `uniform`s arrive in one `FlowUniforms` struct and
///    are copied into locals of the GLSL names at the top of each kernel; samplers are kernel arguments
///    with the GLSL names, bound at texture indices 0, 1, ... in the order optical-flow-gl.ts binds
///    texture units (`SAMPLERS` there), the target at `targetIndex`.
///  - A dispatch is rounded up to whole threadgroups (non-uniform threadgroups are an Apple4+ feature
///    the iOS Simulator does not have), so every kernel first returns for a thread outside its target.
///  - GLSL helper functions that read uniforms (`luma`, `interpolateFrames`) take them as parameters.
///  - Every read is `sample(flowSampler, uv, level(0))`: normalised coordinates, clamp to edge,
///    bilinear - the GL engines' LINEAR + CLAMP_TO_EDGE. A kernel has no derivatives, so the level is
///    explicit (the MSL spec: outside a fragment function a sample defaults to LOD 0 anyway).
///  - GLSL's genType-with-float overloads - `clamp(vec3, float, float)`, `max(vec2, float)`,
///    `smoothstep(float, float, vec2)`, `mix(vec3, vec3, float)` - are written with the scalar widened
///    to the vector (`vec3(0.0)`), each marked `GLSL:`. The Metal compiler on macOS 26 resolves the
///    scalar forms to the same float overloads (measured when the port was written), but a half overload chosen by
///    some future compiler would quietly cost ten bits of every flow vector; spelling it out costs nothing.
///  - Maths is `float` (32-bit) throughout, which is GLSL's `highp float`. No `half` anywhere: the
///    textures STORE half floats, as the GL engines' RGBA16F targets do, and sampling widens them.
///  - `mat3` from the grade: the GLSL `u_matrix` is uploaded column-major and used as `M * rgb`; here its
///    three COLUMNS arrive as `u_matrix[0..2]` and `mat3(c0, c1, c2)` is MSL's column constructor, so
///    `u_matrix * rgb` is the same product.
///
/// Unsuffixed literals (`0.5`, `1e-12`) are the GLSL's text; MSL has no double, and the compiler takes
/// them as float (measured: `max(x, 1e-12)` keeps 1e-10). The library is compiled with fast math OFF -
/// see `FlowEstimator.compileOptions` for why.
enum OpticalFlowShaders {

    /// Where each kernel's target (its `gl_FragColor`) is bound: past every pass's inputs (at most four).
    static let targetIndex = 7

    /// A number as an MSL float literal, the way `glslFloat` writes a GLSL one: `1` is `1.0`, anything else
    /// its shortest round-trip decimal (Swift's `description`, which is JavaScript's `String(number)` for
    /// every value FLOW holds).
    static func mslFloat(_ value: Double) -> String {
        precondition(value.isFinite, "not an MSL float: \(value)")
        if value == value.rounded(), abs(value) < 1e15 { return String(format: "%.1f", value) }
        return "\(value)"
    }

    /// What every pass's source starts with: the typedefs that let the GLSL bodies read unchanged, the
    /// one sampler every read goes through, and the uniforms. `FlowUniforms` is `PassUniforms` in
    /// FlowEstimator.swift, byte for byte (FlowEstimatorTests checks the Swift side's offsets).
    static let header = """
    #include <metal_stdlib>
    using namespace metal;
    typedef float2 vec2;
    typedef float3 vec3;
    typedef float4 vec4;
    typedef float3x3 mat3;
    // The GL engines' LINEAR + CLAMP_TO_EDGE on normalised coordinates, for every read of every pass.
    constexpr sampler flowSampler(coord::normalized, address::clamp_to_edge, filter::linear);
    // GLSL ES 1.00's texture read. LOD 0 explicitly: a kernel has no derivatives to choose one from.
    #define texture2D(t, uv) (t).sample(flowSampler, (uv), level(0))
    struct FlowUniforms {
      float2 u_size;
      float2 u_sourceTexel;
      float u_fresh;
      float u_taps;
      float u_flowOn;
      float u_w;
      float2 u_flowSize;
      float2 u_unused;
      float4 u_matrix[3];
      float4 u_offset;
    };
    // A dispatch covers whole threadgroups; a thread past the target's edge has no texel to write.
    #define FLOW_GUARD if (gid.x >= target.get_width() || gid.y >= target.get_height()) return; \\
      const vec4 gl_FragCoord = vec4(vec2(gid) + 0.5, 0.0, 1.0); (void)gl_FragCoord; \\
      const vec2 u_size = uniforms.u_size; (void)u_size;
    #define FLOW_TARGET texture2d<float, access::write> target [[texture(\(targetIndex))]], \\
      constant FlowUniforms& uniforms [[buffer(0)]], uint2 gid [[thread_position_in_grid]]
    """

    /// Every pass's kernel for `settings`, one complete MSL source each: `flowPasses(settings)` in
    /// optical-flow.ts, pass for pass. The comment over each is its GLSL twin's; read that file for why
    /// each pass does what it does.
    static func passes(_ settings: FlowSettings = OpticalFlow.FLOW) -> [FlowPass: String] {
        let f = mslFloat
        let rangeK = f(1 / (2 * settings.rangeSigma * settings.rangeSigma))
        return [
            // GLSL twin: flowPasses().luma - the working size's graded luma for both frames,
            // box-filtered by `u_taps` x `u_taps` bilinear reads over each texel's footprint.
            .luma: """
            \(header)
            float luma(vec3 rgb, mat3 u_matrix, vec3 u_offset) {
              // GLSL: clamp(u_matrix * rgb + u_offset, 0.0, 1.0)
              return dot(clamp(u_matrix * rgb + u_offset, vec3(0.0), vec3(1.0)), vec3(0.299, 0.587, 0.114));
            }
            kernel void flow_luma(texture2d<float> u_frameA [[texture(0)]], texture2d<float> u_frameB [[texture(1)]], FLOW_TARGET) {
              FLOW_GUARD
              const float u_taps = uniforms.u_taps;
              // The GLSL mat3's columns, in order: M * rgb as the GLSL computes it.
              const mat3 u_matrix = mat3(uniforms.u_matrix[0].xyz, uniforms.u_matrix[1].xyz, uniforms.u_matrix[2].xyz);
              const vec3 u_offset = uniforms.u_offset.xyz;
              vec2 texel = 1.0 / u_size;
              vec2 uv = gl_FragCoord.xy * texel;
              vec2 sum = vec2(0.0);
              for (int j = 0; j < \(settings.maxLumaTaps); j++) {
                if (float(j) >= u_taps) break;
                for (int i = 0; i < \(settings.maxLumaTaps); i++) {
                  if (float(i) >= u_taps) break;
                  vec2 p = uv + ((vec2(float(i), float(j)) + 0.5) / u_taps - 0.5) * texel;
                  sum += vec2(luma(texture2D(u_frameA, p).rgb, u_matrix, u_offset), luma(texture2D(u_frameB, p).rgb, u_matrix, u_offset));
                }
              }
              target.write(vec4(sum / (u_taps * u_taps), 0.0, 1.0), gid);
            }
            """,

            // GLSL twin: flowPasses().down - one level down, the 4x4 box as four bilinear reads.
            .down: """
            \(header)
            kernel void flow_down(texture2d<float> u_source [[texture(0)]], FLOW_TARGET) {
              FLOW_GUARD
              const vec2 u_sourceTexel = uniforms.u_sourceTexel;
              vec2 uv = gl_FragCoord.xy / u_size;
              vec2 d = u_sourceTexel;
              vec4 sum = texture2D(u_source, uv + vec2(-d.x, -d.y)) + texture2D(u_source, uv + vec2(d.x, -d.y))
                  + texture2D(u_source, uv + vec2(-d.x, d.y)) + texture2D(u_source, uv + vec2(d.x, d.y));
              target.write(sum * 0.25, gid);
            }
            """,

            // GLSL twin: flowPasses().exposure - A's mean, B's mean and the gain, into one texel.
            .exposure: """
            \(header)
            kernel void flow_exposure(texture2d<float> u_pyramid [[texture(0)]], FLOW_TARGET) {
              FLOW_GUARD
              vec2 sum = vec2(0.0);
              vec2 squares = vec2(0.0);
              for (int j = 0; j < 32; j++) {
                for (int i = 0; i < 32; i++) {
                  vec2 y = texture2D(u_pyramid, (vec2(float(i), float(j)) + 0.5) / 32.0).xy;
                  sum += y;
                  squares += y * y;
                }
              }
              vec2 mean = sum / 1024.0;
              // GLSL: max(squares / 1024.0 - mean * mean, 0.0)
              vec2 spread = sqrt(max(squares / 1024.0 - mean * mean, vec2(0.0)));
              float gain = clamp(spread.x / max(spread.y, 0.002), 0.5, 2.0);
              target.write(vec4(mean, gain, 1.0), gid);
            }
            """,

            // GLSL twin: flowPasses().gradient - both frames' central differences at one level.
            // `below`/`above` are the GLSL's names, from GL's bottom-up window rows; the maths is
            // "row - 1" and "row + 1" of the texture in every engine, so dy is the change along +y of
            // the texture - DOWN the picture here and on the web - the direction the flow's y is in.
            .gradient: """
            \(header)
            kernel void flow_gradient(texture2d<float> u_pyramid [[texture(0)]], FLOW_TARGET) {
              FLOW_GUARD
              vec2 texel = 1.0 / u_size;
              vec2 uv = gl_FragCoord.xy * texel;
              vec2 left = texture2D(u_pyramid, uv - vec2(texel.x, 0.0)).xy;
              vec2 right = texture2D(u_pyramid, uv + vec2(texel.x, 0.0)).xy;
              vec2 below = texture2D(u_pyramid, uv - vec2(0.0, texel.y)).xy;
              vec2 above = texture2D(u_pyramid, uv + vec2(0.0, texel.y)).xy;
              vec2 dx = (right - left) * 0.5;
              vec2 dy = (above - below) * 0.5;
              target.write(vec4(dx.x, dy.x, dx.y, dy.y), gid);
            }
            """,

            // GLSL twin: flowPasses().lucasKanade - one iteration both ways, with the still-or-moved
            // candidate.
            .lucasKanade: """
            \(header)
            vec2 solve(vec3 h, vec2 b) {
              float a = h.x + \(f(settings.lambda));
              float d = h.z + \(f(settings.lambda));
              float det = a * d - h.y * h.y;
              vec2 move = vec2(d * b.x - h.y * b.y, a * b.y - h.y * b.x) / max(det, 1e-12);
              float length2 = dot(move, move);
              return length2 > \(f(settings.maxStep * settings.maxStep)) ? move * (\(f(settings.maxStep)) / sqrt(length2)) : move;
            }
            kernel void flow_lucasKanade(texture2d<float> u_pyramid [[texture(0)]], texture2d<float> u_gradient [[texture(1)]],
                                         texture2d<float> u_flow [[texture(2)]], texture2d<float> u_exposure [[texture(3)]], FLOW_TARGET) {
              FLOW_GUARD
              const float u_fresh = uniforms.u_fresh;
              vec2 texel = 1.0 / u_size;
              vec2 uv = gl_FragCoord.xy * texel;
              vec4 exposure = texture2D(u_exposure, vec2(0.5));
              vec4 flow = u_fresh > 0.5 ? vec4(0.0) : texture2D(u_flow, uv);
              vec2 centre = texture2D(u_pyramid, uv).xy;
              float centreB = (centre.y - exposure.y) * exposure.z + exposure.x;
              vec3 hAB = vec3(0.0);
              vec2 bAB = vec2(0.0);
              vec2 stillAB = vec2(0.0);
              vec3 hBA = vec3(0.0);
              vec2 bBA = vec2(0.0);
              vec2 stillBA = vec2(0.0);
              // Each direction's windowed squared mismatch: under the estimate (x) and under no motion (y).
              vec2 costAB = vec2(0.0);
              vec2 costBA = vec2(0.0);
              for (int j = -\(settings.radius); j <= \(settings.radius); j += \(settings.windowStep)) {
                for (int i = -\(settings.radius); i <= \(settings.radius); i += \(settings.windowStep)) {
                  vec2 offset = vec2(float(i), float(j));
                  vec2 p = uv + offset * texel;
                  float spatial = exp(-dot(offset, offset) * \(f(1 / (2 * settings.spatialSigma * settings.spatialSigma))));
                  vec2 y = texture2D(u_pyramid, p).xy;
                  vec4 g = texture2D(u_gradient, p);
                  float yB = (y.y - exposure.y) * exposure.z + exposure.x;
                  vec2 gB = g.zw * exposure.z;
                  float dA = y.x - centre.x;
                  float wAB = spatial * exp(-dA * dA * \(rangeK));
                  float eAB = (texture2D(u_pyramid, p + flow.xy).y - exposure.y) * exposure.z + exposure.x - y.x;
                  float e0AB = yB - y.x;
                  hAB += wAB * vec3(g.x * g.x, g.x * g.y, g.y * g.y);
                  bAB += (wAB * eAB) * g.xy;
                  stillAB += (wAB * e0AB) * g.xy;
                  costAB += wAB * vec2(eAB * eAB, e0AB * e0AB);
                  float dB = yB - centreB;
                  float wBA = spatial * exp(-dB * dB * \(rangeK));
                  float eBA = texture2D(u_pyramid, p + flow.zw).x - yB;
                  hBA += wBA * vec3(gB.x * gB.x, gB.x * gB.y, gB.y * gB.y);
                  bBA += (wBA * eBA) * gB;
                  stillBA -= (wBA * e0AB) * gB;
                  costBA += wBA * vec2(eBA * eBA, e0AB * e0AB);
                }
              }
              // Where no motion is the better explanation, the step is taken from zero instead.
              bool resetAB = costAB.y < costAB.x;
              bool resetBA = costBA.y < costBA.x;
              vec2 fromAB = resetAB ? vec2(0.0) : flow.xy;
              vec2 fromBA = resetBA ? vec2(0.0) : flow.zw;
              target.write(vec4(fromAB - solve(hAB, resetAB ? stillAB : bAB) * texel, fromBA - solve(hBA, resetBA ? stillBA : bBA) * texel), gid);
            }
            """,

            // GLSL twin: flowPasses().median - 3x3 median per component, the 19-exchange network.
            .median: """
            \(header)
            #define SORT(a, b) { vec4 lo = min(a, b); b = max(a, b); a = lo; }
            kernel void flow_median(texture2d<float> u_flow [[texture(0)]], FLOW_TARGET) {
              FLOW_GUARD
              vec2 texel = 1.0 / u_size;
              vec2 uv = gl_FragCoord.xy * texel;
              vec4 p0 = texture2D(u_flow, uv + vec2(-texel.x, -texel.y));
              vec4 p1 = texture2D(u_flow, uv + vec2(0.0, -texel.y));
              vec4 p2 = texture2D(u_flow, uv + vec2(texel.x, -texel.y));
              vec4 p3 = texture2D(u_flow, uv + vec2(-texel.x, 0.0));
              vec4 p4 = texture2D(u_flow, uv);
              vec4 p5 = texture2D(u_flow, uv + vec2(texel.x, 0.0));
              vec4 p6 = texture2D(u_flow, uv + vec2(-texel.x, texel.y));
              vec4 p7 = texture2D(u_flow, uv + vec2(0.0, texel.y));
              vec4 p8 = texture2D(u_flow, uv + vec2(texel.x, texel.y));
              SORT(p1, p2) SORT(p4, p5) SORT(p7, p8) SORT(p0, p1) SORT(p3, p4) SORT(p6, p7)
              SORT(p1, p2) SORT(p4, p5) SORT(p7, p8) SORT(p0, p3) SORT(p5, p8) SORT(p4, p7)
              SORT(p3, p6) SORT(p1, p4) SORT(p2, p5) SORT(p4, p7) SORT(p4, p2) SORT(p6, p4)
              SORT(p4, p2)
              target.write(p4, gid);
            }
            """,

            // GLSL twin: flowPasses().consistency - round-trip ratios (x, y) and residuals (z, w).
            .consistency: """
            \(header)
            float inside(vec2 p) {
              return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
            }
            float ratio(vec2 forward, vec2 back) {
              vec2 miss = forward + back;
              return dot(miss, miss) / (\(f(settings.consistencyAlpha)) * (dot(forward, forward) + dot(back, back)) + \(f(settings.consistencyBeta)));
            }
            kernel void flow_consistency(texture2d<float> u_flow [[texture(0)]], texture2d<float> u_pyramid [[texture(1)]],
                                         texture2d<float> u_exposure [[texture(2)]], FLOW_TARGET) {
              FLOW_GUARD
              vec2 texel = 1.0 / u_size;
              vec2 uv = gl_FragCoord.xy * texel;
              vec4 exposure = texture2D(u_exposure, vec2(0.5));
              vec4 flow = texture2D(u_flow, uv);
              vec2 inB = uv + flow.xy;
              vec2 inA = uv + flow.zw;
              float ratioA = inside(inB) > 0.5 ? ratio(flow.xy * u_size, texture2D(u_flow, inB).zw * u_size) : \(f(OpticalFlow.OFF_FRAME));
              float ratioB = inside(inA) > 0.5 ? ratio(flow.zw * u_size, texture2D(u_flow, inA).xy * u_size) : \(f(OpticalFlow.OFF_FRAME));
              vec2 here = texture2D(u_pyramid, uv).xy;
              float residualA = abs((texture2D(u_pyramid, inB).y - exposure.y) * exposure.z + exposure.x - here.x);
              float residualB = abs(texture2D(u_pyramid, inA).x - ((here.y - exposure.y) * exposure.z + exposure.x));
              target.write(vec4(ratioA, ratioB, residualA, residualB), gid);
            }
            """,

            // GLSL twin: flowPasses().fill - the occluded texels' flow from consistent, alike neighbours.
            .fill: """
            \(header)
            kernel void flow_fill(texture2d<float> u_flow [[texture(0)]], texture2d<float> u_consistency [[texture(1)]],
                                  texture2d<float> u_pyramid [[texture(2)]], texture2d<float> u_exposure [[texture(3)]], FLOW_TARGET) {
              FLOW_GUARD
              vec2 texel = 1.0 / u_size;
              vec2 uv = gl_FragCoord.xy * texel;
              vec4 exposure = texture2D(u_exposure, vec2(0.5));
              vec4 flow = texture2D(u_flow, uv);
              // GLSL: smoothstep(low, high, vec2)
              vec2 seen = 1.0 - smoothstep(vec2(\(f(settings.occlusionLow))), vec2(\(f(settings.occlusionHigh))), texture2D(u_consistency, uv).xy);
              vec2 centre = texture2D(u_pyramid, uv).xy;
              float centreB = (centre.y - exposure.y) * exposure.z + exposure.x;
              vec2 sumAB = vec2(0.0);
              vec2 sumBA = vec2(0.0);
              vec2 total = vec2(1e-6);
              for (int j = -\(settings.fillRadius); j <= \(settings.fillRadius); j += \(settings.fillStep)) {
                for (int i = -\(settings.fillRadius); i <= \(settings.fillRadius); i += \(settings.fillStep)) {
                  vec2 offset = vec2(float(i), float(j));
                  vec2 p = uv + offset * texel;
                  vec4 f = texture2D(u_flow, p);
                  // GLSL: smoothstep(low, high, vec2)
                  vec2 v = 1.0 - smoothstep(vec2(\(f(settings.occlusionLow))), vec2(\(f(settings.occlusionHigh))), texture2D(u_consistency, p).xy);
                  vec2 y = texture2D(u_pyramid, p).xy;
                  float dA = y.x - centre.x;
                  float dB = (y.y - exposure.y) * exposure.z + exposure.x - centreB;
                  float spatial = exp(-dot(offset, offset) * \(f(1 / (2 * Double(settings.fillRadius * settings.fillRadius)))));
                  vec2 w = v * spatial * exp(-vec2(dA * dA, dB * dB) * \(rangeK));
                  sumAB += w.x * f.xy;
                  sumBA += w.y * f.zw;
                  total += w;
                }
              }
              // GLSL: mix(vec2, vec2, float)
              target.write(vec4(mix(sumAB / total.x, flow.xy, vec2(seen.x)), mix(sumBA / total.y, flow.zw, vec2(seen.y))), gid);
            }
            """,

            // GLSL twin: flowPasses().trust - the pair's trust into one texel (x), bad share (y), residual (z).
            .trust: """
            \(header)
            kernel void flow_trust(texture2d<float> u_consistency [[texture(0)]], FLOW_TARGET) {
              FLOW_GUARD
              float bad = 0.0;
              float residual = 0.0;
              for (int j = 0; j < 32; j++) {
                for (int i = 0; i < 32; i++) {
                  vec4 c = texture2D(u_consistency, (vec2(float(i), float(j)) + 0.5) / 32.0);
                  bad += 0.5 * (step(1.0, c.x) + step(1.0, c.y));
                  residual += min(c.z, c.w);
                }
              }
              bad /= 1024.0;
              residual /= 1024.0;
              float trust = (1.0 - smoothstep(\(f(settings.badLow)), \(f(settings.badHigh)), bad)) * (1.0 - smoothstep(\(f(settings.residualLow)), \(f(settings.residualHigh)), residual));
              target.write(vec4(trust, bad, residual, 1.0), gid);
            }
            """,

            // GLSL twin: flowPasses().visibility - visA (x), visB (y) and the pair's trust (z) per texel.
            .visibility: """
            \(header)
            kernel void flow_visibility(texture2d<float> u_consistency [[texture(0)]], texture2d<float> u_trust [[texture(1)]], FLOW_TARGET) {
              FLOW_GUARD
              vec4 c = texture2D(u_consistency, gl_FragCoord.xy / u_size);
              float trust = texture2D(u_trust, vec2(0.5)).x;
              // GLSL: smoothstep(low, high, vec2)
              vec2 seen = 1.0 - smoothstep(vec2(\(f(settings.occlusionLow))), vec2(\(f(settings.occlusionHigh))), c.xy);
              target.write(vec4(seen, trust, 1.0), gid);
            }
            """,
        ]
    }

    /// The synthesis kernel's function name.
    static let interpolateKernel = "flow_interpolate"

    /// The per-pixel step, `interpolationBody(settings)` in optical-flow.ts, with the kernel that runs it
    /// once per pixel of a full-size output frame. `SAMPLE` is this engine's spelling of a texture read,
    /// as it is `texture` in the painter's GLSL ES 3.00 and `texture2D` in Android's GLSL ES 1.00; the
    /// four uniforms the GLSL declares globally (`u_flow`, `u_visibility`, `u_flowSize`, `u_flowOn`) are
    /// parameters of `interpolateFrames` here, and otherwise the body is the GLSL's line for line.
    ///
    /// The frames are bgra8Unorm textures of the two recorded pictures; `sample` hands back their
    /// channels as rgba whatever the storage order, as GL's texture read does. The output pixel at
    /// (x, y) is drawn at uv = ((x, y) + 0.5) / size - the coordinate the painter's layer shader reads a
    /// full-frame layer at - and written straight (opaque, alpha 1), 8 bits, rounded by the GPU exactly
    /// as the GL engines' 8-bit targets round.
    static func interpolation(_ settings: FlowSettings = OpticalFlow.FLOW) -> String {
        let f = mslFloat
        return """
        \(header)
        #define SAMPLE(sampler, uv) (sampler).sample(flowSampler, (uv), level(0))
        float insideFrame(vec2 p) {
          return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
        }
        vec3 interpolateFrames(texture2d<float> frameA, texture2d<float> frameB, vec2 uv, float w,
                               texture2d<float> u_flow, texture2d<float> u_visibility, vec2 u_flowSize, float u_flowOn) {
          // GLSL: mix(vec3, vec3, float)
          vec3 blend = mix(SAMPLE(frameA, uv).rgb, SAMPLE(frameB, uv).rgb, vec3(w));
          if (u_flowOn < 0.5) return blend;
          float u = 1.0 - w;
          vec4 here = SAMPLE(u_flow, uv);
          vec2 pa = uv - w * here.xy;
          vec2 pb = uv - u * here.zw;
          for (int i = 0; i < \(settings.trackIterations); i++) {
            pa = uv - w * SAMPLE(u_flow, pa).xy;
            pb = uv - u * SAMPLE(u_flow, pb).zw;
          }
          vec2 flowA = SAMPLE(u_flow, pa).xy * u_flowSize;
          vec2 flowB = SAMPLE(u_flow, pb).zw * u_flowSize;
          float missA = length((pa - uv) * u_flowSize + w * flowA);
          float missB = length((pb - uv) * u_flowSize + u * flowB);
          float landedA = (1.0 - smoothstep(\(f(settings.missLow)), \(f(settings.missHigh)), missA)) * insideFrame(pa);
          float landedB = (1.0 - smoothstep(\(f(settings.missLow)), \(f(settings.missHigh)), missB)) * insideFrame(pb);
          float wA = u * landedA * (\(f(settings.hiddenWeight)) + SAMPLE(u_visibility, pa).x);
          float wB = w * landedB * (\(f(settings.hiddenWeight)) + SAMPLE(u_visibility, pb).y);
          vec3 warped = (wA * SAMPLE(frameA, pa).rgb + wB * SAMPLE(frameB, pb).rgb) / max(wA + wB, 1e-6);
          float moving = smoothstep(\(f(settings.motionLow)), \(f(settings.motionHigh)), max(length(flowA), length(flowB)));
          float confidence = SAMPLE(u_visibility, uv).z * moving * smoothstep(\(f(settings.supportLow)), \(f(settings.supportHigh)), max(landedA, landedB));
          // GLSL: mix(vec3, vec3, float)
          return mix(blend, warped, vec3(confidence));
        }
        kernel void \(interpolateKernel)(texture2d<float> frameA [[texture(0)]], texture2d<float> frameB [[texture(1)]],
                                     texture2d<float> u_flow [[texture(2)]], texture2d<float> u_visibility [[texture(3)]], FLOW_TARGET) {
          FLOW_GUARD
          vec2 uv = gl_FragCoord.xy / vec2(float(target.get_width()), float(target.get_height()));
          vec3 rgb = interpolateFrames(frameA, frameB, uv, uniforms.u_w, u_flow, u_visibility, uniforms.u_flowSize, uniforms.u_flowOn);
          target.write(vec4(rgb, 1.0), gid);
        }
        """
    }

    /// The probe kernel's function name.
    static let probeKernel = "flow_probe"

    /// Not a pass: what `FlowEstimator` runs once at creation to learn, on the real device, that a kernel
    /// can write an rgba16Float texel with a negative and a >1 value in it and read it back (see
    /// `FlowEstimator.probe`). The values are exactly representable in a half float.
    static let probe = """
    \(header)
    kernel void \(probeKernel)(FLOW_TARGET) {
      FLOW_GUARD
      target.write(vec4(0.25, -0.5, 1.5, 1.0), gid);
    }
    """
}
