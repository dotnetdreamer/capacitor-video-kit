package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.sqrt

/**
 * The CPU half of drawing a focus: where a frame stands in its source ([FocusTiming]), and how the
 * contract's Gaussian is laid out as halvings and passes ([FocusBlur]) - the web engine's `blurred()` and
 * `levelSigma()`, held here to numbers worked from the same formulas, so a focus is as soft in a post
 * from a phone as in the preview. The passes themselves need a GPU; what they are handed does not.
 */
class FocusEffectTest {

    @Test
    fun `a frame stands at the item's in-point plus its elapsed time at the clip's speed`() {
        val timing = FocusTiming(startUs = 2_000_000L, inUs = 3_000_000L, outUs = 5_000_000L, speed = 0.5)
        assertEquals(3_000.0, timing.sourceMs(2_000_000L), 0.0)
        // A second of output at half speed is half a second of source.
        assertEquals(3_500.0, timing.sourceMs(3_000_000L), 0.0)
        assertEquals(3_000.033, timing.sourceMs(2_000_066L), 1e-9)
        assertEquals(5_000.0, timing.sourceMs(6_000_000L), 0.0)
    }

    @Test
    fun `a stamp outside the item reads the nearest end of its trim`() {
        val timing = FocusTiming(startUs = 1_000_000L, inUs = 250_000L, outUs = 750_000L, speed = 1.0)
        assertEquals(250.0, timing.sourceMs(0L), 0.0)
        assertEquals(750.0, timing.sourceMs(10_000_000L), 0.0)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `no blur, or one too small to move an 8-bit value, is the frame as it is`() {
        assertNull(FocusBlur.plan(1080, 1920, 0f))
        // 0.0002 of 1080 is 0.216 pixels, under the quarter pixel nothing shows below.
        assertNull(FocusBlur.plan(1080, 1920, 0.0002f))
    }

    @Test
    fun `a small blur runs at full size, with the sigma it asked for`() {
        // 0.003 of 1080 is 3.24 pixels: under four, so no halving.
        val plan = FocusBlur.plan(1080, 1920, 0.003f)!!
        assertTrue(plan.levels.isEmpty())
        assertEquals(3.24, plan.sigmaPx, 1e-4)
        assertEquals(plan.sigmaPx, plan.across, 0.0)
        assertEquals(plan.sigmaPx, plan.down, 0.0)
        assertEquals(10, plan.acrossTaps)
    }

    @Test
    fun `the editor's default focus is blurred three halvings down, at about two texels`() {
        // The default 0.5 of the editor's 0.03 ceiling: 0.015 of 1080, 16.2 pixels.
        val plan = FocusBlur.plan(1080, 1920, 0.015f)!!
        assertEquals(16.2, plan.sigmaPx, 1e-4)
        assertEquals(
            listOf(FocusBlur.Level(540, 960), FocusBlur.Level(270, 480), FocusBlur.Level(135, 240)),
            plan.levels,
        )
        // Eight pixels a texel: the halvings' box and the read back up take their variance off.
        val expected = sqrt(16.2 * 16.2 - (64.0 - 1) / 12 - 64.0 / 6) / 8
        assertEquals(expected, plan.across, 1e-4)
        assertEquals(expected, plan.down, 1e-4)
        assertEquals(1.9626, plan.across, 1e-3)
        assertEquals(6, plan.acrossTaps)
    }

    @Test
    fun `the widest blur the wire allows still runs a handful of taps a pass`() {
        // A tenth of a 4K frame's shorter side: 216 pixels, which no run of taps over the frame reaches.
        val plan = FocusBlur.plan(3840, 2160, ComposeSpecParser.MAX_FOCUS_BLUR.toFloat())!!
        assertEquals(6, plan.levels.size)
        assertEquals(FocusBlur.Level(60, 34), plan.levels.last())
        assertTrue(plan.across in 1.5..4.0)
        assertTrue(plan.down in 1.5..4.0)
        assertTrue(plan.acrossTaps <= 12)
        assertTrue(plan.downTaps <= 12)
    }

    @Test
    fun `an odd side is halved half up, as the web halves it`() {
        val plan = FocusBlur.plan(1081, 1921, 0.01f)!!
        assertEquals(FocusBlur.Level(541, 961), plan.levels.first())
    }

    @Test
    fun `a pass's sigma is what is left once the halvings and the read back up have blurred`() {
        assertEquals(5.0, FocusBlur.levelSigma(5.0, 4.0, halved = false), 0.0)
        assertEquals(sqrt(100.0 - 15.0 / 12 - 16.0 / 6) / 4, FocusBlur.levelSigma(10.0, 4.0, halved = true), 1e-12)
        // Never past the floor of half the sigma, whatever a rounding does.
        assertEquals(0.5 / 8, FocusBlur.levelSigma(1.0, 8.0, halved = true), 1e-12)
    }

    @Test
    fun `taps reach three sigma, at least one and at most sixty-four`() {
        assertEquals(1, FocusBlur.taps(0.1))
        assertEquals(3, FocusBlur.taps(1.0))
        assertEquals(7, FocusBlur.taps(2.1))
        assertEquals(FocusBlur.MAX_TAPS, FocusBlur.taps(30.0))
    }
}
