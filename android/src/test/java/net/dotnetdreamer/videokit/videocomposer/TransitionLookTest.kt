package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs

/**
 * The numbers a transition is drawn from, pinned against the TypeScript that produced them.
 *
 * The shader only draws what these say, so this is where Android could quietly run a transition a
 * sample early or a side the wrong way round while every other engine got it right. The fixtures
 * are `compileTransition` output copied verbatim, and the expected values are what `lookAt`
 * returned for them in transitions.ts.
 */
class TransitionLookTest {

    /** `compileTransition('dissolve').curves.alpha`. */
    private val dissolveAlpha = floatArrayOf(
        0f, 0.00154f, 0.00616f, 0.01382f, 0.02447f, 0.03806f, 0.0545f, 0.07368f, 0.09549f, 0.1198f,
        0.14645f, 0.17528f, 0.20611f, 0.23875f, 0.273f, 0.30866f, 0.34549f, 0.38328f, 0.42178f,
        0.46077f, 0.5f, 0.53923f, 0.57822f, 0.61672f, 0.65451f, 0.69134f, 0.727f, 0.76125f, 0.79389f,
        0.82472f, 0.85355f, 0.8802f, 0.90451f, 0.92632f, 0.9455f, 0.96194f, 0.97553f, 0.98618f,
        0.99384f, 0.99846f, 1f,
    )

    /** `compileTransition('whip-right').curves.from.x`; `to.x` is this minus 1. */
    private val whipX = floatArrayOf(
        0f, 0f, 0.00005f, 0.00025f, 0.0008f, 0.00195f, 0.00405f, 0.0075f, 0.0128f, 0.0205f, 0.03125f,
        0.04575f, 0.0648f, 0.08925f, 0.12005f, 0.1582f, 0.2048f, 0.261f, 0.32805f, 0.40725f, 0.5f,
        0.59275f, 0.67195f, 0.739f, 0.7952f, 0.8418f, 0.87995f, 0.91075f, 0.9352f, 0.95425f, 0.96875f,
        0.9795f, 0.9872f, 0.9925f, 0.99595f, 0.99805f, 0.9992f, 0.99975f, 0.99995f, 1f, 1f,
    )

    /** `compileTransition('whip-right').curves.from.blur`, the same on both sides. */
    private val whipBlur = floatArrayOf(
        0f, 0.00018f, 0.00073f, 0.00163f, 0.00286f, 0.00439f, 0.00618f, 0.00819f, 0.01036f, 0.01265f,
        0.015f, 0.01735f, 0.01964f, 0.02181f, 0.02382f, 0.02561f, 0.02714f, 0.02837f, 0.02927f,
        0.02982f, 0.03f, 0.02982f, 0.02927f, 0.02837f, 0.02714f, 0.02561f, 0.02382f, 0.02181f,
        0.01964f, 0.01735f, 0.015f, 0.01265f, 0.01036f, 0.00819f, 0.00618f, 0.00439f, 0.00286f,
        0.00163f, 0.00073f, 0.00018f, 0f,
    )

    private fun side(x: FloatArray? = null, blur: FloatArray? = null, scale: FloatArray? = null) =
        TransitionSideCurves(x, null, scale, null, blur, null, null, null, null)

    private val whipRight = TransitionCurves(
        alpha = null,
        reveal = null,
        from = side(x = whipX, blur = whipBlur),
        to = side(x = FloatArray(whipX.size) { whipX[it] - 1f }, blur = whipBlur),
    )

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a curve is read in a straight line between the samples either side`() {
        // The same cases transitions.unit.test.ts holds `sample` to.
        assertEquals(0.25f, TransitionMath.sample(floatArrayOf(0f, 1f), 0.25, 9f), 1e-6f)
        assertEquals(15f, TransitionMath.sample(floatArrayOf(0f, 10f, 20f), 0.75, 9f), 1e-6f)
        assertEquals(20f, TransitionMath.sample(floatArrayOf(0f, 10f, 20f), 1.0, 9f), 0f)
        assertEquals(20f, TransitionMath.sample(floatArrayOf(0f, 10f, 20f), 1.5, 9f), 0f)
        assertEquals(0f, TransitionMath.sample(floatArrayOf(0f, 10f, 20f), -1.0, 9f), 0f)
        assertEquals(9f, TransitionMath.sample(null, 0.5, 9f), 0f)
    }

    @Test
    fun `a curve reads the way the TypeScript reads it at the edges of the domain`() {
        assertEquals(9f, TransitionMath.sample(FloatArray(0), 0.5, 9f), 0f)
        assertEquals(4f, TransitionMath.sample(floatArrayOf(4f), 0.9, 9f), 0f)
        // `Number.isFinite(p) ? p : 0`: an infinity is read as the start, not as the end.
        assertEquals(0f, TransitionMath.sample(floatArrayOf(0f, 10f), Double.NaN, 9f), 0f)
        assertEquals(0f, TransitionMath.sample(floatArrayOf(0f, 10f), Double.POSITIVE_INFINITY, 9f), 0f)
    }

    @Test
    fun `a dissolve is where lookAt put it`() {
        val curves = TransitionCurves(dissolveAlpha, null, null, null)
        // p = 0.26 is x = 10.4, four tenths of the way from sample 10 to sample 11.
        assertEquals(0.157982f, TransitionMath.lookAt(curves, 0.26).alpha, 1e-6f)
        assertEquals(0.5f, TransitionMath.lookAt(curves, 0.5).alpha, 0f)
        assertEquals(1f, TransitionMath.lookAt(curves, 1.0).alpha, 0f)
        // Every channel the dissolve left out holds its neutral value.
        val look = TransitionMath.lookAt(curves, 0.3)
        assertEquals(1f, look.reveal, 0f)
        assertEquals(SideLook.NEUTRAL, look.from)
        assertEquals(SideLook.NEUTRAL, look.to)
    }

    @Test
    fun `a whip moves both sides together, on the samples and between them`() {
        val on = TransitionMath.lookAt(whipRight, 0.4)
        assertEquals(0.2048f, on.from.x, 1e-6f)
        assertEquals(0.02714f, on.from.blur, 1e-6f)
        assertEquals(-0.7952f, on.to.x, 1e-6f)
        assertEquals(0.02714f, on.to.blur, 1e-6f)
        assertEquals(1f, on.alpha, 0f)
        // Halfway between samples 16 and 17.
        val between = TransitionMath.lookAt(whipRight, 16.5 / 40.0)
        assertEquals((0.2048f + 0.261f) / 2f, between.from.x, 1e-6f)
        assertEquals((0.02714f + 0.02837f) / 2f, between.from.blur, 1e-6f)
        assertEquals(1f, between.from.scale, 0f)
    }

    @Test
    fun `progress is the contract's clamp of time over length`() {
        assertEquals(0.0, TransitionMath.progress(1_000_000L, 500_000L, 0L), 0.0)
        assertEquals(0.0, TransitionMath.progress(1_000_000L, 500_000L, 1_000_000L), 0.0)
        assertEquals(0.4, TransitionMath.progress(1_000_000L, 500_000L, 1_200_000L), 1e-12)
        assertEquals(1.0, TransitionMath.progress(1_000_000L, 500_000L, 1_500_000L), 0.0)
        assertEquals(1.0, TransitionMath.progress(1_000_000L, 500_000L, 4_000_000L), 0.0)
        // A window with no length is over the instant it opens rather than a division by zero.
        assertEquals(1.0, TransitionMath.progress(1_000_000L, 0L, 1_000_000L), 0.0)
    }

    /* ------------------------------------------------------------------------------------- */

    private fun transition(
        curves: TransitionCurves,
        mask: TransitionMask? = null,
        fromTint: FloatArray? = null,
        toTint: FloatArray? = null,
    ) = Transition(
        kind = "test",
        from = Clip("a", "file:///a.mp4", 1_500, 2_000, 1f, 1f, false, Fit.CONTAIN),
        mask = mask,
        fromTint = fromTint,
        toTint = toTint,
        curves = curves,
    )

    /** Every channel of the FROM side at a constant value, so the frame can be read off directly. */
    private fun constant(value: Float) = floatArrayOf(value, value)

    private fun frame(
        role: TransitionRole,
        t: Transition,
        timeUs: Long = 1_250_000L,
        width: Int = 720,
        height: Int = 1280,
    ) = TransitionFrame.at(role, t, startUs = 1_000_000L, durUs = 500_000L, timeUs = timeUs, width = width, height = height)

    @Test
    fun `the incoming side draws its look only inside its window`() {
        val t = transition(TransitionCurves(floatArrayOf(0f, 1f), null, null, null))
        assertFalse(frame(TransitionRole.TO, t, timeUs = 999_999L).drawLook)
        assertTrue(frame(TransitionRole.TO, t, timeUs = 1_000_000L).drawLook)
        assertTrue(frame(TransitionRole.TO, t, timeUs = 1_499_999L).drawLook)
        // The window's end belongs to the incoming clip as it plays, opaque and untouched.
        val after = frame(TransitionRole.TO, t, timeUs = 1_500_000L)
        assertFalse(after.drawLook)
        assertFalse(after.blurs)
        // The outgoing side is a tail that exists only for its window, so it always draws.
        assertTrue(frame(TransitionRole.FROM, t, timeUs = 1_500_000L).drawLook)
    }

    @Test
    fun `a side's channels become pixels of the frame it is drawn on`() {
        val curves = TransitionCurves(
            alpha = floatArrayOf(0f, 1f),
            reveal = null,
            from = TransitionSideCurves(
                x = constant(0.25f),
                y = constant(-0.5f),
                scale = constant(2f),
                rotation = constant(90f),
                blur = constant(0.02f),
                pixelate = constant(0.05f),
                split = constant(0.01f),
                gain = constant(1.5f),
                tint = constant(0.3f),
            ),
            to = null,
        )
        val f = frame(TransitionRole.FROM, transition(curves, fromTint = floatArrayOf(1f, 0.45f, 0.1f)))
        assertEquals(180f, f.offsetXPx, 1e-4f) // 0.25 of 720
        assertEquals(-640f, f.offsetYPx, 1e-4f) // -0.5 of 1280, y down
        assertEquals(0.5f, f.invScale, 1e-6f)
        // The INVERSE turn, -90 degrees, which is what the sample position is carried through.
        assertEquals(0f, f.turnCos, 1e-6f)
        assertEquals(-1f, f.turnSin, 1e-6f)
        assertEquals(36f, f.cellPx, 1e-4f) // 0.05 of the shorter side
        assertEquals(7.2f, f.shiftPx, 1e-4f) // 0.01 of the width
        assertEquals(14.4f, f.sigmaPx, 1e-4f) // 0.02 of the shorter side
        assertTrue(f.blurs)
        assertEquals(1.5f, f.gain, 0f)
        assertEquals(0.3f, f.tintAmount, 1e-6f)
        assertEquals(listOf(1f, 0.45f, 0.1f), listOf(f.tintR, f.tintG, f.tintB))
        // The outgoing side is always drawn whole: alpha and mask are the incoming side's business.
        assertEquals(1f, f.alpha, 0f)
        assertEquals(TransitionFrame.MASK_NONE, f.maskShape)
    }

    @Test
    fun `each side takes its own tint, and an absent one is black`() {
        val curves = TransitionCurves(null, null, side(), side())
        val t = transition(curves, toTint = floatArrayOf(1f, 1f, 1f))
        val from = frame(TransitionRole.FROM, t)
        assertEquals(listOf(0f, 0f, 0f), listOf(from.tintR, from.tintG, from.tintB))
        val to = frame(TransitionRole.TO, t)
        assertEquals(listOf(1f, 1f, 1f), listOf(to.tintR, to.tintG, to.tintB))
    }

    @Test
    fun `a neutral side is the picture as it is`() {
        val f = frame(TransitionRole.TO, transition(TransitionCurves(floatArrayOf(0f, 1f), null, null, null)))
        assertEquals(0f, f.offsetXPx, 0f)
        assertEquals(1f, f.invScale, 0f)
        assertEquals(1f, f.turnCos, 0f)
        assertEquals(0f, abs(f.turnSin), 0f)
        assertEquals(0f, f.cellPx, 0f)
        assertEquals(0f, f.shiftPx, 0f)
        assertFalse(f.blurs)
        assertEquals(1f, f.gain, 0f)
        assertEquals(0f, f.tintAmount, 0f)
        // Halfway through a straight ramp.
        assertEquals(0.5f, f.alpha, 1e-6f)
    }

    @Test
    fun `a scale of nothing is floored rather than divided by`() {
        val curves = TransitionCurves(null, null, side(scale = constant(0f)), null)
        assertEquals(1e6f, frame(TransitionRole.FROM, transition(curves)).invScale, 1f)
    }

    @Test
    fun `a blur too narrow to see skips its passes`() {
        // 0.0003 of 720 is 0.216 pixels, under the quarter pixel worth a pass.
        val narrow = TransitionCurves(null, null, side(blur = constant(0.0003f)), null)
        assertFalse(frame(TransitionRole.FROM, transition(narrow)).blurs)
        val wide = TransitionCurves(null, null, side(blur = constant(0.0004f)), null)
        assertTrue(frame(TransitionRole.FROM, transition(wide)).blurs)
    }

    @Test
    fun `the blur's taps stay a whole pixel apart until they have to spread to reach three sigma`() {
        // A pixel apart is what keeps the blur the frame's exact discrete Gaussian.
        assertEquals(1f, TransitionFrame.blurTapStepPx(0.3f), 0f)
        assertEquals(1f, TransitionFrame.blurTapStepPx(10f), 0f)
        // 32 taps a pixel apart reach 32 pixels, three sigma of 10.67; past that they spread.
        assertEquals(3f * 21.6f / 32f, TransitionFrame.blurTapStepPx(21.6f), 1e-6f)
        // The weights fall off as exp(-falloff k^2 / 2), which puts tap k at k step / sigma sigmas.
        assertEquals(1f / (2f * 2f), TransitionFrame.blurTapFalloff(2f), 1e-6f)
        val wide = TransitionFrame.blurTapFalloff(32f)
        assertEquals((3f / 32f) * (3f / 32f), wide, 1e-7f)
        // So the last tap of a wide run sits at three sigma, whatever the sigma.
        assertEquals(9f, wide * TransitionFrame.BLUR_TAPS * TransitionFrame.BLUR_TAPS, 1e-3f)
    }

    @Test
    fun `a mask reaches the incoming side as maskAlpha's own numbers`() {
        val mask = TransitionMask(MaskShape.BLINDS, angleDeg = 90f, count = 8, feather = 0.04f, invert = true)
        val curves = TransitionCurves(null, floatArrayOf(0f, 1f), null, null)
        val f = frame(TransitionRole.TO, transition(curves, mask = mask), timeUs = 1_250_000L)
        assertEquals(MaskShape.BLINDS.ordinal, f.maskShape)
        assertEquals(0f, f.maskDirX, 1e-6f)
        assertEquals(1f, f.maskDirY, 1e-6f)
        // |720 cos 90| + |1280 sin 90|: the frame's extent along the way the edge travels.
        assertEquals(1280f, f.maskExtentPx, 1e-3f)
        assertEquals(8f, f.maskCount, 0f)
        // r = reveal (1 + 2 fw) - fw at reveal 0.5.
        assertEquals(0.5f * 1.08f - 0.04f, f.maskEdge, 1e-6f)
        assertEquals(0.04f, f.maskFeather, 0f)
        assertTrue(f.maskInvert)
        // The outgoing side is never masked, whatever the transition carries.
        assertEquals(TransitionFrame.MASK_NONE, frame(TransitionRole.FROM, transition(curves, mask = mask)).maskShape)
    }

    @Test
    fun `a mask's edge lets nothing through at 0 and everything at 1, feather and all`() {
        val mask = TransitionMask(MaskShape.CIRCLE, angleDeg = 0f, count = 1, feather = 0.02f, invert = false)
        fun edgeAt(reveal: Float): Float {
            val curves = TransitionCurves(null, floatArrayOf(reveal, reveal), null, null)
            return frame(TransitionRole.TO, transition(curves, mask = mask)).maskEdge
        }
        // The smoothstep runs from r - fw to r + fw, so at 0 it ends at u = 0 and at 1 starts at 1.
        assertEquals(0f, edgeAt(0f) + 0.02f, 1e-6f)
        assertEquals(1f, edgeAt(1f) - 0.02f, 1e-6f)
    }
}
