package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.hypot
import kotlin.math.max
import kotlin.math.min

/**
 * Optical flow for smooth slow motion: the Android half of `optical-flow.ts`, which says what every
 * pass does and why. This file is the part of it that has no GL in it - the settings, the pyramid's
 * sizes and the per-pixel maths the shaders do, as plain functions the JVM pins against numbers the
 * TypeScript produced - and the passes themselves, [OpticalFlowShaders], as TEXT.
 *
 * ONE ALGORITHM, TWO ENGINES. The passes are GLSL ES 1.00, which both the painter's WebGL2 context and
 * Media3's OpenGL ES 3 context compile, and they are the SAME text here as there, down to every
 * constant: `build/optical-flow-parity.unit.test.ts` reads this file and holds each string to what
 * `flowPasses()` and `interpolationBody()` return, line by line, and [OpticalFlow.FLOW] to the
 * TypeScript's `FLOW`. So a pass or a threshold cannot change in one engine alone - change it there,
 * run that test and copy what it prints into this file. Only the orchestration, [FlowInterpolator], is
 * written twice.
 */

/** The knobs of the passes: `FlowSettings` in optical-flow.ts, field for field. */
data class FlowSettings(
    val maxSide: Int,
    val maxLevels: Int,
    val minSide: Int,
    /** Lucas-Kanade iterations per level, FINEST FIRST; a level past the end takes the last number. */
    val iterations: List<Int>,
    val maxLumaTaps: Int,
    val radius: Int,
    val windowStep: Int,
    val spatialSigma: Double,
    val rangeSigma: Double,
    val lambda: Double,
    val maxStep: Double,
    val median: Boolean,
    val consistencyAlpha: Double,
    val consistencyBeta: Double,
    val occlusionLow: Double,
    val occlusionHigh: Double,
    val badLow: Double,
    val badHigh: Double,
    val residualLow: Double,
    val residualHigh: Double,
    val fillRadius: Int,
    val fillStep: Int,
    val supportLow: Double,
    val supportHigh: Double,
    val trackIterations: Int,
    val missLow: Double,
    val missHigh: Double,
    val hiddenWeight: Double,
    val motionLow: Double,
    val motionHigh: Double,
)

/** A texture's size in texels. */
data class FlowSize(val width: Int, val height: Int)

/** A point or a vector in texture coordinates, or in texels where a function says so. */
data class Vec2(val x: Double, val y: Double)

object OpticalFlow {

    /** What every engine renders with: `FLOW` in optical-flow.ts, which says how it was chosen. */
    val FLOW = FlowSettings(
        maxSide = 320,
        maxLevels = 5,
        minSide = 8,
        iterations = listOf(3, 3, 4, 5, 5),
        maxLumaTaps = 6,
        radius = 2,
        windowStep = 1,
        spatialSigma = 1.5,
        rangeSigma = 0.2,
        lambda = 0.004,
        maxStep = 1.0,
        median = true,
        consistencyAlpha = 0.01,
        consistencyBeta = 0.5,
        occlusionLow = 1.0,
        occlusionHigh = 4.0,
        badLow = 0.25,
        badHigh = 0.5,
        residualLow = 0.06,
        residualHigh = 0.12,
        fillRadius = 6,
        fillStep = 2,
        supportLow = 0.1,
        supportHigh = 0.5,
        trackIterations = 1,
        missLow = 0.5,
        missHigh = 1.0,
        hiddenWeight = 0.2,
        motionLow = 0.1,
        motionHigh = 0.25,
    )

    /** The ratio a texel whose flow takes it off the frame is given: `OFF_FRAME`. */
    const val OFF_FRAME = 100.0

    /**
     * The pyramid for a `width` x `height` frame, the working size first - `flowPyramid`: the frame
     * scaled so its longer side is at most [FlowSettings.maxSide], then each level half the last,
     * rounded up, while the shorter side stays at or above [FlowSettings.minSide]. Empty for a frame
     * with no pixels.
     */
    fun pyramid(width: Int, height: Int, settings: FlowSettings = FLOW): List<FlowSize> {
        if (width < 1 || height < 1) return emptyList()
        val scale = min(1.0, settings.maxSide.toDouble() / max(width, height))
        // Half up, as JavaScript's Math.round is, which is what the TypeScript sizes the same frame with.
        var level = FlowSize(max(1, floor(width * scale + 0.5).toInt()), max(1, floor(height * scale + 0.5).toInt()))
        val levels = arrayListOf(level)
        while (levels.size < settings.maxLevels) {
            val next = FlowSize(ceil(level.width / 2.0).toInt(), ceil(level.height / 2.0).toInt())
            if (min(next.width, next.height) < settings.minSide) break
            levels += next
            level = next
        }
        return levels
    }

    /**
     * How many bilinear reads per axis the luma pass takes over each working texel's footprint -
     * `lumaTaps`, which says why: enough 2x2 reads to tile it, an exact box at 4:1, 6:1 and 12:1.
     */
    fun lumaTaps(width: Int, height: Int, working: FlowSize, settings: FlowSettings = FLOW): Int {
        val ratio = max(width.toDouble() / working.width, height.toDouble() / working.height)
        return min(settings.maxLumaTaps, max(1, ceil(ratio / 2 - 1e-6).toInt()))
    }

    /** Lucas-Kanade iterations at `level` (0 is the working size): `iterationsAt`. */
    fun iterationsAt(level: Int, settings: FlowSettings = FLOW): Int =
        settings.iterations[min(level, settings.iterations.size - 1)]

    /** GLSL's smoothstep. */
    fun smoothstep(edge0: Double, edge1: Double, x: Double): Double {
        val t = min(1.0, max(0.0, (x - edge0) / (edge1 - edge0)))
        return t * t * (3 - 2 * t)
    }

    /**
     * Super SloMo's linear-motion approximation - `intermediateFlows`: where the missing frame at `t`
     * reads A and B, from the forward and backward flow at the pixel. Not what the engines draw with
     * (see [trackPoints]); the answer the two agree on wherever the motion is uniform.
     */
    fun intermediateFlows(f01: Vec2, f10: Vec2, t: Double): Pair<Vec2, Vec2> {
        val u = 1 - t
        return Vec2(-u * t * f01.x + t * t * f10.x, -u * t * f01.y + t * t * f10.y) to
            Vec2(u * u * f01.x - t * u * f10.x, u * u * f01.y - t * u * f10.y)
    }

    /** The flow a texture holds at a point: forward (A to B) then backward (B to A), in texture coordinates. */
    fun interface FlowField {
        fun at(point: Vec2): DoubleArray
    }

    /** What [trackPoints] found: see `trackPoints` in optical-flow.ts. */
    data class Tracked(val pa: Vec2, val pb: Vec2, val missA: Double, val missB: Double, val flowA: Vec2, val flowB: Vec2)

    /**
     * The two recorded points the missing frame's pixel `uv` at `t` is drawn from, found by following
     * the flow - `trackPoints`, which says why, and what the interpolation shader does per pixel.
     */
    fun trackPoints(flowAt: FlowField, uv: Vec2, t: Double, size: FlowSize, settings: FlowSettings = FLOW): Tracked {
        val u = 1 - t
        val here = flowAt.at(uv)
        var pa = Vec2(uv.x - t * here[0], uv.y - t * here[1])
        var pb = Vec2(uv.x - u * here[2], uv.y - u * here[3])
        repeat(settings.trackIterations) {
            val fa = flowAt.at(pa)
            val fb = flowAt.at(pb)
            pa = Vec2(uv.x - t * fa[0], uv.y - t * fa[1])
            pb = Vec2(uv.x - u * fb[2], uv.y - u * fb[3])
        }
        val fa = flowAt.at(pa)
        val fb = flowAt.at(pb)
        val flowA = Vec2(fa[0] * size.width, fa[1] * size.height)
        val flowB = Vec2(fb[2] * size.width, fb[3] * size.height)
        val missA = hypot((pa.x - uv.x) * size.width + t * flowA.x, (pa.y - uv.y) * size.height + t * flowA.y)
        val missB = hypot((pb.x - uv.x) * size.width + u * flowB.x, (pb.y - uv.y) * size.height + u * flowB.y)
        return Tracked(pa, pb, missA, missB, flowA, flowB)
    }

    /** The round-trip ratio of a texel - `consistencyRatio`: 1 or less closes, above it the texel is hidden. */
    fun consistencyRatio(forward: Vec2, back: Vec2, settings: FlowSettings = FLOW): Double {
        val mx = forward.x + back.x
        val my = forward.y + back.y
        val lengths = forward.x * forward.x + forward.y * forward.y + back.x * back.x + back.y * back.y
        return (mx * mx + my * my) / (settings.consistencyAlpha * lengths + settings.consistencyBeta)
    }

    /** How visible a texel is in the other frame, from its round-trip ratio: `visibility`. */
    fun visibility(ratio: Double, settings: FlowSettings = FLOW): Double =
        1 - smoothstep(settings.occlusionLow, settings.occlusionHigh, ratio)

    /** How far the flow is trusted for a whole pair: `pairTrust`. */
    fun pairTrust(bad: Double, residual: Double, settings: FlowSettings = FLOW): Double =
        (1 - smoothstep(settings.badLow, settings.badHigh, bad)) * (1 - smoothstep(settings.residualLow, settings.residualHigh, residual))

    /** The gain that brings B's luma spread to A's: `exposureGain`. */
    fun exposureGain(stdA: Double, stdB: Double): Double = min(2.0, max(0.5, stdA / max(stdB, 0.002)))

    /** Whether a point is on the frame: `insideFrame`. */
    fun insideFrame(point: Vec2): Double = if (point.x >= 0 && point.y >= 0 && point.x <= 1 && point.y <= 1) 1.0 else 0.0

    /** How found a point is, from how far its own flow leaves it from the pixel: `landed`. */
    fun landed(miss: Double, inside: Double, settings: FlowSettings = FLOW): Double =
        (1 - smoothstep(settings.missLow, settings.missHigh, miss)) * inside

    /** The two points' weights and the trust in them over the cross-fade: `synthesisWeights`. */
    data class Weights(val wA: Double, val wB: Double, val confidence: Double)

    /** See `synthesisWeights` in optical-flow.ts for what each weight means and why. */
    fun synthesisWeights(
        t: Double,
        landedA: Double,
        landedB: Double,
        seenA: Double,
        seenB: Double,
        motion: Double,
        trust: Double,
        settings: FlowSettings = FLOW,
    ): Weights = Weights(
        wA = (1 - t) * landedA * (settings.hiddenWeight + seenA),
        wB = t * landedB * (settings.hiddenWeight + seenB),
        confidence = trust * smoothstep(settings.motionLow, settings.motionHigh, motion) *
            smoothstep(settings.supportLow, settings.supportHigh, max(landedA, landedB)),
    )
}

/**
 * The passes, as text - `flowPasses()` and `interpolationBody()` in optical-flow.ts, copied, and held
 * to them by the parity test. Their vertex side is [FlowInterpolator]'s.
 */
internal object OpticalFlowShaders {

    const val LUMA = """
        #version 100
        precision highp float;
        uniform sampler2D u_frameA;
        uniform sampler2D u_frameB;
        uniform vec2 u_size;
        uniform float u_taps;
        uniform mat3 u_matrix;
        uniform vec3 u_offset;
        float luma(vec3 rgb) {
          return dot(clamp(u_matrix * rgb + u_offset, 0.0, 1.0), vec3(0.299, 0.587, 0.114));
        }
        void main() {
          vec2 texel = 1.0 / u_size;
          vec2 uv = gl_FragCoord.xy * texel;
          vec2 sum = vec2(0.0);
          for (int j = 0; j < 6; j++) {
            if (float(j) >= u_taps) break;
            for (int i = 0; i < 6; i++) {
              if (float(i) >= u_taps) break;
              vec2 p = uv + ((vec2(float(i), float(j)) + 0.5) / u_taps - 0.5) * texel;
              sum += vec2(luma(texture2D(u_frameA, p).rgb), luma(texture2D(u_frameB, p).rgb));
            }
          }
          gl_FragColor = vec4(sum / (u_taps * u_taps), 0.0, 1.0);
        }
    """

    const val DOWN = """
        #version 100
        precision highp float;
        uniform sampler2D u_source;
        uniform vec2 u_size;
        uniform vec2 u_sourceTexel;
        void main() {
          vec2 uv = gl_FragCoord.xy / u_size;
          vec2 d = u_sourceTexel;
          vec4 sum = texture2D(u_source, uv + vec2(-d.x, -d.y)) + texture2D(u_source, uv + vec2(d.x, -d.y))
              + texture2D(u_source, uv + vec2(-d.x, d.y)) + texture2D(u_source, uv + vec2(d.x, d.y));
          gl_FragColor = sum * 0.25;
        }
    """

    const val EXPOSURE = """
        #version 100
        precision highp float;
        uniform sampler2D u_pyramid;
        void main() {
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
          vec2 spread = sqrt(max(squares / 1024.0 - mean * mean, 0.0));
          float gain = clamp(spread.x / max(spread.y, 0.002), 0.5, 2.0);
          gl_FragColor = vec4(mean, gain, 1.0);
        }
    """

    const val GRADIENT = """
        #version 100
        precision highp float;
        uniform sampler2D u_pyramid;
        uniform vec2 u_size;
        void main() {
          vec2 texel = 1.0 / u_size;
          vec2 uv = gl_FragCoord.xy * texel;
          vec2 left = texture2D(u_pyramid, uv - vec2(texel.x, 0.0)).xy;
          vec2 right = texture2D(u_pyramid, uv + vec2(texel.x, 0.0)).xy;
          vec2 below = texture2D(u_pyramid, uv - vec2(0.0, texel.y)).xy;
          vec2 above = texture2D(u_pyramid, uv + vec2(0.0, texel.y)).xy;
          vec2 dx = (right - left) * 0.5;
          vec2 dy = (above - below) * 0.5;
          gl_FragColor = vec4(dx.x, dy.x, dx.y, dy.y);
        }
    """

    const val LUCAS_KANADE = """
        #version 100
        precision highp float;
        uniform sampler2D u_pyramid;
        uniform sampler2D u_gradient;
        uniform sampler2D u_flow;
        uniform sampler2D u_exposure;
        uniform vec2 u_size;
        uniform float u_fresh;
        vec2 solve(vec3 h, vec2 b) {
          float a = h.x + 0.004;
          float d = h.z + 0.004;
          float det = a * d - h.y * h.y;
          vec2 move = vec2(d * b.x - h.y * b.y, a * b.y - h.y * b.x) / max(det, 1e-12);
          float length2 = dot(move, move);
          return length2 > 1.0 ? move * (1.0 / sqrt(length2)) : move;
        }
        void main() {
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
          for (int j = -2; j <= 2; j += 1) {
            for (int i = -2; i <= 2; i += 1) {
              vec2 offset = vec2(float(i), float(j));
              vec2 p = uv + offset * texel;
              float spatial = exp(-dot(offset, offset) * 0.2222222222222222);
              vec2 y = texture2D(u_pyramid, p).xy;
              vec4 g = texture2D(u_gradient, p);
              float yB = (y.y - exposure.y) * exposure.z + exposure.x;
              vec2 gB = g.zw * exposure.z;
              float dA = y.x - centre.x;
              float wAB = spatial * exp(-dA * dA * 12.499999999999998);
              float eAB = (texture2D(u_pyramid, p + flow.xy).y - exposure.y) * exposure.z + exposure.x - y.x;
              float e0AB = yB - y.x;
              hAB += wAB * vec3(g.x * g.x, g.x * g.y, g.y * g.y);
              bAB += (wAB * eAB) * g.xy;
              stillAB += (wAB * e0AB) * g.xy;
              costAB += wAB * vec2(eAB * eAB, e0AB * e0AB);
              float dB = yB - centreB;
              float wBA = spatial * exp(-dB * dB * 12.499999999999998);
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
          gl_FragColor = vec4(fromAB - solve(hAB, resetAB ? stillAB : bAB) * texel, fromBA - solve(hBA, resetBA ? stillBA : bBA) * texel);
        }
    """

    const val MEDIAN = """
        #version 100
        precision highp float;
        uniform sampler2D u_flow;
        uniform vec2 u_size;
        #define SORT(a, b) { vec4 lo = min(a, b); b = max(a, b); a = lo; }
        void main() {
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
          gl_FragColor = p4;
        }
    """

    const val CONSISTENCY = """
        #version 100
        precision highp float;
        uniform sampler2D u_flow;
        uniform sampler2D u_pyramid;
        uniform sampler2D u_exposure;
        uniform vec2 u_size;
        float inside(vec2 p) {
          return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
        }
        float ratio(vec2 forward, vec2 back) {
          vec2 miss = forward + back;
          return dot(miss, miss) / (0.01 * (dot(forward, forward) + dot(back, back)) + 0.5);
        }
        void main() {
          vec2 texel = 1.0 / u_size;
          vec2 uv = gl_FragCoord.xy * texel;
          vec4 exposure = texture2D(u_exposure, vec2(0.5));
          vec4 flow = texture2D(u_flow, uv);
          vec2 inB = uv + flow.xy;
          vec2 inA = uv + flow.zw;
          float ratioA = inside(inB) > 0.5 ? ratio(flow.xy * u_size, texture2D(u_flow, inB).zw * u_size) : 100.0;
          float ratioB = inside(inA) > 0.5 ? ratio(flow.zw * u_size, texture2D(u_flow, inA).xy * u_size) : 100.0;
          vec2 here = texture2D(u_pyramid, uv).xy;
          float residualA = abs((texture2D(u_pyramid, inB).y - exposure.y) * exposure.z + exposure.x - here.x);
          float residualB = abs(texture2D(u_pyramid, inA).x - ((here.y - exposure.y) * exposure.z + exposure.x));
          gl_FragColor = vec4(ratioA, ratioB, residualA, residualB);
        }
    """

    const val FILL = """
        #version 100
        precision highp float;
        uniform sampler2D u_flow;
        uniform sampler2D u_consistency;
        uniform sampler2D u_pyramid;
        uniform sampler2D u_exposure;
        uniform vec2 u_size;
        void main() {
          vec2 texel = 1.0 / u_size;
          vec2 uv = gl_FragCoord.xy * texel;
          vec4 exposure = texture2D(u_exposure, vec2(0.5));
          vec4 flow = texture2D(u_flow, uv);
          vec2 seen = 1.0 - smoothstep(1.0, 4.0, texture2D(u_consistency, uv).xy);
          vec2 centre = texture2D(u_pyramid, uv).xy;
          float centreB = (centre.y - exposure.y) * exposure.z + exposure.x;
          vec2 sumAB = vec2(0.0);
          vec2 sumBA = vec2(0.0);
          vec2 total = vec2(1e-6);
          for (int j = -6; j <= 6; j += 2) {
            for (int i = -6; i <= 6; i += 2) {
              vec2 offset = vec2(float(i), float(j));
              vec2 p = uv + offset * texel;
              vec4 f = texture2D(u_flow, p);
              vec2 v = 1.0 - smoothstep(1.0, 4.0, texture2D(u_consistency, p).xy);
              vec2 y = texture2D(u_pyramid, p).xy;
              float dA = y.x - centre.x;
              float dB = (y.y - exposure.y) * exposure.z + exposure.x - centreB;
              float spatial = exp(-dot(offset, offset) * 0.013888888888888888);
              vec2 w = v * spatial * exp(-vec2(dA * dA, dB * dB) * 12.499999999999998);
              sumAB += w.x * f.xy;
              sumBA += w.y * f.zw;
              total += w;
            }
          }
          gl_FragColor = vec4(mix(sumAB / total.x, flow.xy, seen.x), mix(sumBA / total.y, flow.zw, seen.y));
        }
    """

    const val TRUST = """
        #version 100
        precision highp float;
        uniform sampler2D u_consistency;
        void main() {
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
          float trust = (1.0 - smoothstep(0.25, 0.5, bad)) * (1.0 - smoothstep(0.06, 0.12, residual));
          gl_FragColor = vec4(trust, bad, residual, 1.0);
        }
    """

    const val VISIBILITY = """
        #version 100
        precision highp float;
        uniform sampler2D u_consistency;
        uniform sampler2D u_trust;
        uniform vec2 u_size;
        void main() {
          vec4 c = texture2D(u_consistency, gl_FragCoord.xy / u_size);
          float trust = texture2D(u_trust, vec2(0.5)).x;
          vec2 seen = 1.0 - smoothstep(1.0, 4.0, c.xy);
          gl_FragColor = vec4(seen, trust, 1.0);
        }
    """

    const val INTERPOLATION_BODY = """
        uniform sampler2D u_flow;
        uniform sampler2D u_visibility;
        uniform vec2 u_flowSize;
        uniform float u_flowOn;
        float insideFrame(vec2 p) {
          return step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0);
        }
        vec3 interpolateFrames(sampler2D frameA, sampler2D frameB, vec2 uv, float w) {
          vec3 blend = mix(SAMPLE(frameA, uv).rgb, SAMPLE(frameB, uv).rgb, w);
          if (u_flowOn < 0.5) return blend;
          float u = 1.0 - w;
          vec4 here = SAMPLE(u_flow, uv);
          vec2 pa = uv - w * here.xy;
          vec2 pb = uv - u * here.zw;
          for (int i = 0; i < 1; i++) {
            pa = uv - w * SAMPLE(u_flow, pa).xy;
            pb = uv - u * SAMPLE(u_flow, pb).zw;
          }
          vec2 flowA = SAMPLE(u_flow, pa).xy * u_flowSize;
          vec2 flowB = SAMPLE(u_flow, pb).zw * u_flowSize;
          float missA = length((pa - uv) * u_flowSize + w * flowA);
          float missB = length((pb - uv) * u_flowSize + u * flowB);
          float landedA = (1.0 - smoothstep(0.5, 1.0, missA)) * insideFrame(pa);
          float landedB = (1.0 - smoothstep(0.5, 1.0, missB)) * insideFrame(pb);
          float wA = u * landedA * (0.2 + SAMPLE(u_visibility, pa).x);
          float wB = w * landedB * (0.2 + SAMPLE(u_visibility, pb).y);
          vec3 warped = (wA * SAMPLE(frameA, pa).rgb + wB * SAMPLE(frameB, pb).rgb) / max(wA + wB, 1e-6);
          float moving = smoothstep(0.1, 0.25, max(length(flowA), length(flowB)));
          float confidence = SAMPLE(u_visibility, uv).z * moving * smoothstep(0.1, 0.5, max(landedA, landedB));
          return mix(blend, warped, confidence);
        }
    """
}
