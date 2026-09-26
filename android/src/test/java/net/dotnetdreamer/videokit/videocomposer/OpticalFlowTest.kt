package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The maths the flow's shaders do, as the Android engine keeps it, pinned to the SAME cases and the same
 * numbers as `optical-flow.unit.test.ts` holds the web engine's to - case for case, in the same order -
 * so the two copies cannot drift. The shaders themselves are held to each other as text by the web
 * package's `build/optical-flow-parity.unit.test.ts`, which also holds [OpticalFlow.FLOW] to `FLOW`.
 */
class OpticalFlowTest {

    private fun assertClose(expected: Double, actual: Double, what: String = "", tolerance: Double = 1e-9) =
        assertEquals(what, expected, actual, tolerance)

    private fun assertClose(expected: Vec2, actual: Vec2, tolerance: Double = 1e-9) {
        assertClose(expected.x, actual.x, "x of $actual", tolerance)
        assertClose(expected.y, actual.y, "y of $actual", tolerance)
    }

    /* The pyramid ------------------------------------------------------------------------------ */

    @Test
    fun `works a portrait clip at 180x320 whatever its resolution, and halves it four times`() {
        val portrait = listOf(FlowSize(180, 320), FlowSize(90, 160), FlowSize(45, 80), FlowSize(23, 40), FlowSize(12, 20))
        assertEquals(portrait, OpticalFlow.pyramid(720, 1280))
        assertEquals(portrait, OpticalFlow.pyramid(1080, 1920))
        assertEquals(portrait, OpticalFlow.pyramid(2160, 3840))
    }

    @Test
    fun `turns with the clip`() {
        assertEquals(
            listOf(FlowSize(320, 180), FlowSize(160, 90), FlowSize(80, 45), FlowSize(40, 23), FlowSize(20, 12)),
            OpticalFlow.pyramid(1920, 1080),
        )
    }

    @Test
    fun `never enlarges a small frame, and stops before a level would be too small to hold a window`() {
        assertEquals(listOf(FlowSize(200, 100), FlowSize(100, 50), FlowSize(50, 25), FlowSize(25, 13)), OpticalFlow.pyramid(200, 100))
        assertEquals(listOf(64, 32, 16, 8), OpticalFlow.pyramid(64, 64).map { it.width })
        assertEquals(listOf(FlowSize(1, 1)), OpticalFlow.pyramid(1, 1))
        assertEquals(emptyList<FlowSize>(), OpticalFlow.pyramid(0, 720))
    }

    @Test
    fun `tiles each working texel with 2x2 reads of the frame - an exact box at 4_1, 6_1 and 12_1`() {
        val portrait = FlowSize(180, 320)
        assertEquals(1, OpticalFlow.lumaTaps(360, 640, portrait))
        assertEquals(2, OpticalFlow.lumaTaps(720, 1280, portrait))
        assertEquals(3, OpticalFlow.lumaTaps(1080, 1920, portrait))
        assertEquals(4, OpticalFlow.lumaTaps(1440, 2560, portrait))
        assertEquals(6, OpticalFlow.lumaTaps(2160, 3840, portrait))
        assertEquals(OpticalFlow.FLOW.maxLumaTaps, OpticalFlow.lumaTaps(4320, 7680, portrait))
        assertEquals(1, OpticalFlow.lumaTaps(200, 100, FlowSize(200, 100)))
    }

    @Test
    fun `iterates finest first, and a level past the list takes its last number`() {
        assertEquals(listOf(3, 3, 4, 5, 5), OpticalFlow.FLOW.iterations)
        assertEquals(listOf(3, 3, 4, 5, 5, 5), listOf(0, 1, 2, 3, 4, 9).map { OpticalFlow.iterationsAt(it) })
    }

    /* Where the missing frame reads its neighbours ---------------------------------------------- */

    @Test
    fun `is, by Super SloMo's approximation, a fraction t back along the motion and the rest forward`() {
        val (toA, toB) = OpticalFlow.intermediateFlows(Vec2(4.0, -2.0), Vec2(-4.0, 2.0), 0.25)
        assertClose(Vec2(-1.0, 0.5), toA)
        assertClose(Vec2(3.0, -1.5), toB)
        val (skewA, skewB) = OpticalFlow.intermediateFlows(Vec2(4.0, 0.0), Vec2(0.0, 0.0), 0.5)
        assertClose(Vec2(-1.0, 0.0), skewA)
        assertClose(Vec2(1.0, 0.0), skewB)
    }

    private val size = FlowSize(100, 100)

    /** A picture moving steadily by `d` texels: every point's forward flow is d, backward -d. */
    private fun uniform(dx: Double, dy: Double) = OpticalFlow.FlowField {
        doubleArrayOf(dx / size.width, dy / size.height, -dx / size.width, -dy / size.height)
    }

    @Test
    fun `lands, by tracking, exactly where the approximation does wherever the motion is uniform`() {
        for (t in listOf(0.25, 0.5, 0.75)) {
            val uv = Vec2(0.4, 0.6)
            val tracked = OpticalFlow.trackPoints(uniform(6.0, -3.0), uv, t, size)
            val (toA, toB) = OpticalFlow.intermediateFlows(Vec2(0.06, -0.03), Vec2(-0.06, 0.03), t)
            assertClose(Vec2(uv.x + toA.x, uv.y + toA.y), tracked.pa)
            assertClose(Vec2(uv.x + toB.x, uv.y + toB.y), tracked.pb)
            assertClose(0.0, tracked.missA)
            assertClose(0.0, tracked.missB)
            assertClose(Vec2(6.0, -3.0), tracked.flowA)
            assertClose(Vec2(-6.0, 3.0), tracked.flowB)
        }
    }

    /** A block moving right by 20 texels over a still background: in A it covers x 30..50, in B 50..70. */
    private val block = OpticalFlow.FlowField { point ->
        val inA = point.x >= 0.3 && point.x <= 0.5
        val inB = point.x >= 0.5 && point.x <= 0.7
        doubleArrayOf(if (inA) 0.2 else 0.0, 0.0, if (inB) -0.2 else 0.0, 0.0)
    }

    @Test
    fun `finds the block in A where the linear approximation, at the block's edge, reads the background`() {
        val uv = Vec2(0.42, 0.5)
        val tracked = OpticalFlow.trackPoints(block, uv, 0.5, size)
        assertClose(Vec2(0.32, 0.5), tracked.pa)
        assertClose(0.0, tracked.missA)
        val f = block.at(uv)
        val (toA, _) = OpticalFlow.intermediateFlows(Vec2(f[0], f[1]), Vec2(f[2], f[3]), 0.5)
        assertClose(Vec2(-0.05, 0.0), toA)
    }

    @Test
    fun `knows when no point of A lands on a pixel - the background the block has just uncovered`() {
        val tracked = OpticalFlow.trackPoints(block, Vec2(0.35, 0.5), 0.5, size)
        assertClose(0.0, tracked.missB)
        assertTrue("missA ${tracked.missA}", tracked.missA > OpticalFlow.FLOW.missHigh)
        assertEquals(0.0, OpticalFlow.landed(tracked.missA, OpticalFlow.insideFrame(tracked.pa)), 0.0)
        assertEquals(1.0, OpticalFlow.landed(tracked.missB, OpticalFlow.insideFrame(tracked.pb)), 0.0)
    }

    /* The round trip, and how far the flow is trusted -------------------------------------------- */

    @Test
    fun `closes for a texel the backward flow brings back, and not for one it does not`() {
        assertEquals(0.0, OpticalFlow.consistencyRatio(Vec2(3.0, 0.0), Vec2(-3.0, 0.0)), 0.0)
        assertClose(15.254237288, OpticalFlow.consistencyRatio(Vec2(3.0, 0.0), Vec2(0.0, 0.0)), tolerance = 1e-8)
        assertClose(1 / (0.01 * (1600 + 1521) + 0.5), OpticalFlow.consistencyRatio(Vec2(40.0, 0.0), Vec2(-39.0, 0.0)), tolerance = 1e-12)
    }

    @Test
    fun `reads visibility off the ratio - seen to 1, hidden from 4, a smoothstep between`() {
        assertEquals(1.0, OpticalFlow.visibility(0.0), 0.0)
        assertEquals(1.0, OpticalFlow.visibility(1.0), 0.0)
        assertClose(0.5, OpticalFlow.visibility(2.5), tolerance = 1e-12)
        assertEquals(0.0, OpticalFlow.visibility(4.0), 0.0)
        assertEquals(0.0, OpticalFlow.visibility(OpticalFlow.OFF_FRAME), 0.0)
    }

    @Test
    fun `trusts a pair fully until a quarter of it fails or its luma disagrees by 0_06, and not at all past half or 0_12`() {
        assertEquals(1.0, OpticalFlow.pairTrust(0.0, 0.0), 0.0)
        assertEquals(1.0, OpticalFlow.pairTrust(0.25, 0.06), 0.0)
        assertEquals(0.0, OpticalFlow.pairTrust(0.5, 0.0), 0.0)
        assertEquals(0.0, OpticalFlow.pairTrust(0.0, 0.12), 0.0)
        assertClose(0.5, OpticalFlow.pairTrust(0.375, 0.0), tolerance = 1e-12)
        assertClose(0.25, OpticalFlow.pairTrust(0.375, 0.09), tolerance = 1e-12)
    }

    @Test
    fun `brings B to A's exposure, a factor of two at most either way`() {
        assertClose(1.5, OpticalFlow.exposureGain(0.15, 0.1), tolerance = 1e-12)
        assertEquals(2.0, OpticalFlow.exposureGain(0.3, 0.1), 0.0)
        assertEquals(0.5, OpticalFlow.exposureGain(0.1, 0.3), 0.0)
        assertEquals(0.5, OpticalFlow.exposureGain(0.0, 0.0), 0.0)
    }

    /* The weights ------------------------------------------------------------------------------ */

    @Test
    fun `are the cross-fade's where both points are found and seen`() {
        val w = OpticalFlow.synthesisWeights(0.25, 1.0, 1.0, 1.0, 1.0, 5.0, 1.0)
        assertClose(0.75, w.wA / (w.wA + w.wB), tolerance = 1e-12)
        assertEquals(1.0, w.confidence, 0.0)
    }

    @Test
    fun `prefer the point seen in both frames over one hidden in the other, by the hidden weight`() {
        val w = OpticalFlow.synthesisWeights(0.5, 1.0, 1.0, 1.0, 0.0, 5.0, 1.0)
        val hidden = OpticalFlow.FLOW.hiddenWeight
        assertClose((1 + hidden) / hidden, w.wA / w.wB, tolerance = 1e-12)
    }

    @Test
    fun `take a point seen in only its own frame when it is all there is`() {
        val w = OpticalFlow.synthesisWeights(0.5, 0.0, 1.0, 0.0, 0.0, 5.0, 1.0)
        assertEquals(0.0, w.wA, 0.0)
        assertTrue(w.wB > 0)
        assertEquals(1.0, w.confidence, 0.0)
    }

    @Test
    fun `are the cross-fade where nothing moves, where neither point was found, and on a pair not trusted`() {
        assertEquals(0.0, OpticalFlow.synthesisWeights(0.5, 1.0, 1.0, 1.0, 1.0, 0.1, 1.0).confidence, 0.0)
        assertClose(0.5, OpticalFlow.synthesisWeights(0.5, 1.0, 1.0, 1.0, 1.0, 0.175, 1.0).confidence, tolerance = 1e-12)
        assertEquals(0.0, OpticalFlow.synthesisWeights(0.5, 0.0, 0.0, 1.0, 1.0, 5.0, 1.0).confidence, 0.0)
        assertEquals(0.0, OpticalFlow.synthesisWeights(0.5, 1.0, 1.0, 1.0, 1.0, 5.0, 0.0).confidence, 0.0)
    }

    @Test
    fun `count a point as found up to half a texel off, and not from a whole texel`() {
        assertEquals(1.0, OpticalFlow.landed(0.5, 1.0), 0.0)
        assertClose(0.5, OpticalFlow.landed(0.75, 1.0), tolerance = 1e-12)
        assertEquals(0.0, OpticalFlow.landed(1.0, 1.0), 0.0)
        assertEquals(0.0, OpticalFlow.landed(0.0, 0.0), 0.0)
        assertEquals(1.0, OpticalFlow.insideFrame(Vec2(0.0, 1.0)), 0.0)
        assertEquals(0.0, OpticalFlow.insideFrame(Vec2(-0.001, 0.5)), 0.0)
    }

    /* The shader text -------------------------------------------------------------------------- */

    @Test
    fun `is GLSL ES 1_00 in every pass, which Media3's context compiles`() {
        val passes = listOf(
            OpticalFlowShaders.LUMA, OpticalFlowShaders.DOWN, OpticalFlowShaders.EXPOSURE, OpticalFlowShaders.GRADIENT,
            OpticalFlowShaders.LUCAS_KANADE, OpticalFlowShaders.MEDIAN, OpticalFlowShaders.CONSISTENCY,
            OpticalFlowShaders.FILL, OpticalFlowShaders.TRUST, OpticalFlowShaders.VISIBILITY,
        )
        for (pass in passes) {
            // What GlProgram is handed: whitespace, then the version line, which GLSL allows.
            assertTrue(pass, pass.trimStart().startsWith("#version 100\n"))
            assertTrue(pass, "precision highp float;" in pass)
            assertTrue(pass, "void main()" in pass)
        }
    }

    @Test
    fun `reads textures in the per-pixel step only through SAMPLE, which this engine defines as texture2D`() {
        val body = OpticalFlowShaders.INTERPOLATION_BODY
        assertTrue(Regex("\\btexture2D\\(|\\btexture\\(").find(body) == null)
        assertTrue("SAMPLE(frameA, uv)" in body)
        val program = FlowInterpolator.INTERPOLATE_FRAGMENT
        assertTrue(program, program.startsWith("#version 100\nprecision highp float;\n#define SAMPLE(sampler, uv) texture2D(sampler, uv)\n"))
        assertTrue(program, "gl_FragColor = vec4(interpolateFrames(uFrom, uTo, vTexSamplingCoord, uWeight), 1.0);" in program)
    }
}
