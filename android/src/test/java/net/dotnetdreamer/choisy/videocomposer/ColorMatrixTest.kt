package net.dotnetdreamer.choisy.videocomposer

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Pins the colour maths to the CSS Filter Effects spec. These numbers are what make the native
 * render and the browser preview agree, so a change that looks harmless here is a visible change on
 * every customer's video.
 */
class ColorMatrixTest {

    private val tolerance = 1e-5f

    @Test
    fun `identity leaves a colour alone`() {
        val out = ColorMatrix.IDENTITY.apply(0.2f, 0.4f, 0.6f)
        assertArrayEquals(floatArrayOf(0.2f, 0.4f, 0.6f), out, tolerance)
        assertTrue(ColorMatrix.IDENTITY.isIdentity())
    }

    @Test
    fun `grayscale of pure red is its sRGB luminance`() {
        val out = ColorMatrix.grayscale(1f).apply(1f, 0f, 0f)
        assertArrayEquals(floatArrayOf(0.2126f, 0.2126f, 0.2126f), out, tolerance)
    }

    @Test
    fun `grayscale of zero is a no-op`() {
        assertTrue(ColorMatrix.grayscale(0f).isIdentity())
    }

    @Test
    fun `contrast pivots around mid grey`() {
        // Mid grey is the fixed point of every contrast value.
        val out = ColorMatrix.contrast(0.5f).apply(0.5f, 0.5f, 0.5f)
        assertArrayEquals(floatArrayOf(0.5f, 0.5f, 0.5f), out, tolerance)
        // White under 0.82 contrast: 1 * 0.82 + (0.5 - 0.41) = 0.91.
        val white = ColorMatrix.contrast(0.82f).apply(1f, 1f, 1f)
        assertArrayEquals(floatArrayOf(0.91f, 0.91f, 0.91f), white, tolerance)
    }

    @Test
    fun `brightness scales linearly and clamps at white`() {
        assertArrayEquals(
            floatArrayOf(0.4f, 0.2f, 0.1f),
            ColorMatrix.brightness(2f).apply(0.2f, 0.1f, 0.05f),
            tolerance,
        )
        assertArrayEquals(
            floatArrayOf(1f, 1f, 1f),
            ColorMatrix.brightness(2f).apply(0.9f, 0.8f, 0.7f),
            tolerance,
        )
    }

    @Test
    fun `saturate of one is a no-op and of zero is luminance`() {
        assertTrue(ColorMatrix.saturate(1f).isIdentity())
        val out = ColorMatrix.saturate(0f).apply(1f, 0f, 0f)
        assertArrayEquals(floatArrayOf(0.213f, 0.213f, 0.213f), out, tolerance)
    }

    @Test
    fun `sepia of zero is a no-op`() {
        assertTrue(ColorMatrix.sepia(0f).isIdentity())
    }

    @Test
    fun `hueRotate of zero is a no-op and of 360 comes back`() {
        assertTrue(ColorMatrix.hueRotate(0f).isIdentity())
        val out = ColorMatrix.hueRotate(360f).apply(0.8f, 0.3f, 0.1f)
        assertArrayEquals(floatArrayOf(0.8f, 0.3f, 0.1f), out, 1e-4f)
    }

    @Test
    fun `tint blends towards the given colour`() {
        // Black tinted 10 % with (255, 168, 72) is exactly one tenth of that colour.
        val out = ColorMatrix.tint(255, 168, 72, 0.1f).apply(0f, 0f, 0f)
        assertArrayEquals(floatArrayOf(0.1f, 0.1f * 168f / 255f, 0.1f * 72f / 255f), out, tolerance)
        assertTrue(ColorMatrix.tint(255, 0, 0, 0f).isIdentity())
    }

    @Test
    fun `composition applies the first op first`() {
        // brightness(2) then contrast(0.5): 0.25 -> 0.5 -> 0.5. The reverse gives a different value,
        // which is the whole reason order is part of the contract.
        val forward = ColorMatrix.fold(
            listOf(FilterOp.Brightness(2f), FilterOp.Contrast(0.5f)),
        ).apply(0.25f, 0.25f, 0.25f)
        assertArrayEquals(floatArrayOf(0.5f, 0.5f, 0.5f), forward, tolerance)

        val reverse = ColorMatrix.fold(
            listOf(FilterOp.Contrast(0.5f), FilterOp.Brightness(2f)),
        ).apply(0.25f, 0.25f, 0.25f)
        assertArrayEquals(floatArrayOf(0.75f, 0.75f, 0.75f), reverse, tolerance)
    }

    @Test
    fun `folding an empty list is the identity`() {
        assertTrue(ColorMatrix.fold(emptyList()).isIdentity())
    }

    @Test
    fun `the mono preset desaturates and lifts contrast`() {
        val mono = ColorMatrix.fold(listOf(FilterOp.Grayscale(1f), FilterOp.Contrast(1.08f)))
        val out = mono.apply(0.75f, 0.25f, 0.5f)
        // Grey first, so all three channels have to come out equal.
        assertArrayEquals(floatArrayOf(out[0], out[0], out[0]), out, tolerance)
        assertFalse(mono.isIdentity())
    }

    @Test
    fun `gl upload order is column-major`() {
        val m = ColorMatrix(
            floatArrayOf(1f, 2f, 3f, 4f, 5f, 6f, 7f, 8f, 9f),
            floatArrayOf(0.1f, 0.2f, 0.3f),
        )
        assertArrayEquals(
            floatArrayOf(1f, 4f, 7f, 2f, 5f, 8f, 3f, 6f, 9f),
            m.toGlColumnMajor(),
            tolerance,
        )
        assertArrayEquals(floatArrayOf(0.1f, 0.2f, 0.3f), m.offset(), tolerance)
    }
}
