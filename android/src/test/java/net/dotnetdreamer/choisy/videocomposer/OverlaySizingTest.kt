package net.dotnetdreamer.choisy.videocomposer

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

/**
 * How an overlay PNG turns into the area it covers on the output frame.
 *
 * Worth pinning because the PNG and the area are allowed to differ - full-frame effects arrive at
 * half resolution and the decode budget can halve anything again - and a wrong factor here does not
 * fail the export, it just puts a quarter-size effect in the corner of every customer's video.
 */
class OverlaySizingTest {

    private val tolerance = 1e-6f
    private val mb = 1024L * 1024L

    /* ---- overlayScale ---------------------------------------------------------------------- */

    @Test
    fun `a bitmap drawn at output size is not scaled`() {
        val scale = OverlaySizing.overlayScale(wPx = 300, hPx = 120, bitmapW = 300, bitmapH = 120)
        assertEquals(1f, scale.x, tolerance)
        assertEquals(1f, scale.y, tolerance)
    }

    @Test
    fun `a half resolution full frame effect is stretched back to the whole frame`() {
        val scale = OverlaySizing.overlayScale(wPx = 720, hPx = 1280, bitmapW = 360, bitmapH = 640)
        assertEquals(2f, scale.x, tolerance)
        assertEquals(2f, scale.y, tolerance)
    }

    @Test
    fun `a half resolution effect halved again by the budget scales by four`() {
        val scale = OverlaySizing.overlayScale(wPx = 720, hPx = 1280, bitmapW = 180, bitmapH = 320)
        assertEquals(4f, scale.x, tolerance)
        assertEquals(4f, scale.y, tolerance)
    }

    @Test
    fun `an odd sized png floored by the decoder still covers its exact area`() {
        // BitmapFactory with inSampleSize 2 turns 721x1281 into 360x640, not 360.5x640.5, so a
        // flat factor of 2 would leave it one pixel short in each direction.
        val scale = OverlaySizing.overlayScale(wPx = 721, hPx = 1281, bitmapW = 360, bitmapH = 640)
        assertEquals(721f, scale.x * 360f, 1e-3f)
        assertEquals(1281f, scale.y * 640f, 1e-3f)
    }

    @Test
    fun `the two axes scale independently`() {
        val scale = OverlaySizing.overlayScale(wPx = 300, hPx = 100, bitmapW = 100, bitmapH = 50)
        assertEquals(3f, scale.x, tolerance)
        assertEquals(2f, scale.y, tolerance)
    }

    @Test(expected = IllegalArgumentException::class)
    fun `an empty bitmap is refused rather than scaled to infinity`() {
        OverlaySizing.overlayScale(wPx = 100, hPx = 100, bitmapW = 0, bitmapH = 100)
    }

    /* ---- pngSize --------------------------------------------------------------------------- */

    @Test
    fun `reads the size of a real png from its first 24 bytes`() {
        val png = Base64.getDecoder().decode(PNG_37_X_1001)
        assertEquals(OverlaySizing.PixelSize(37, 1001), OverlaySizing.pngSize(png.copyOf(24)))
    }

    @Test
    fun `the base64 prefix the plugin decodes is enough to read the size`() {
        // The plugin decodes only PNG_HEADER_BASE64_CHARS characters of the data URL; this proves
        // that prefix really carries the width and height, with no padding to trip on.
        val prefix = PNG_37_X_1001.substring(0, OverlaySizing.PNG_HEADER_BASE64_CHARS)
        val header = Base64.getDecoder().decode(prefix)
        assertEquals(24, header.size)
        assertEquals(OverlaySizing.PixelSize(37, 1001), OverlaySizing.pngSize(header))
    }

    @Test
    fun `reads all four bytes of each dimension big endian`() {
        val header = pngHeader(width = 0x01020304, height = 70_000)
        assertEquals(OverlaySizing.PixelSize(0x01020304, 70_000), OverlaySizing.pngSize(header))
    }

    @Test
    fun `anything that is not a png header gives null`() {
        assertNull(OverlaySizing.pngSize(null))
        assertNull(OverlaySizing.pngSize(pngHeader(360, 640).copyOf(23)))
        // A JPEG starts FF D8 FF.
        val jpeg = pngHeader(360, 640).also { it[0] = 0xFF.toByte(); it[1] = 0xD8.toByte() }
        assertNull(OverlaySizing.pngSize(jpeg))
        // The right signature followed by some other chunk is not a valid PNG either.
        val notIhdr = pngHeader(360, 640).also { it[12] = 'I'.code.toByte(); it[13] = 'D'.code.toByte() }
        assertNull(OverlaySizing.pngSize(notIhdr))
        // Zero and "negative" (above 2^31 - 1) sizes are not decodable.
        assertNull(OverlaySizing.pngSize(pngHeader(0, 640)))
        assertNull(OverlaySizing.pngSize(pngHeader(-1, 640)))
    }

    /* ---- sampleSizes ----------------------------------------------------------------------- */

    @Test
    fun `everything decodes at full size while it fits the budget`() {
        val sizes = listOf(OverlaySizing.PixelSize(720, 1280), OverlaySizing.PixelSize(200, 80))
        assertArrayEquals(intArrayOf(1, 1), OverlaySizing.sampleSizes(sizes, 48 * mb))
    }

    @Test
    fun `thirty half resolution effects are sized by their pngs and not halved`() {
        // 30 x 360x640 x 4 bytes is about 26 MB. Counted by the area they cover (720x1280) it would
        // be 105 MB and every one of them would be halved again for nothing.
        val sizes = List(30) { OverlaySizing.PixelSize(360, 640) }
        assertArrayEquals(IntArray(30) { 1 }, OverlaySizing.sampleSizes(sizes, 48 * mb))
    }

    @Test
    fun `past the budget the bitmaps at or above the median are halved`() {
        val big = OverlaySizing.PixelSize(720, 1280)
        val small = OverlaySizing.PixelSize(100, 100)
        // 20 x 720x1280 x 4 is about 70 MB, over a 48 MB budget.
        val sizes = List(10) { small } + List(20) { big }
        val expected = IntArray(10) { 1 } + IntArray(20) { 2 }
        assertArrayEquals(expected, OverlaySizing.sampleSizes(sizes, 48 * mb))
    }

    @Test
    fun `order is preserved so each sample size stays with its overlay`() {
        val sizes = listOf(
            OverlaySizing.PixelSize(720, 1280),
            OverlaySizing.PixelSize(10, 10),
            OverlaySizing.PixelSize(720, 1280),
        )
        assertArrayEquals(intArrayOf(2, 1, 2), OverlaySizing.sampleSizes(sizes, 1L))
    }

    @Test
    fun `no overlays need no sample sizes`() {
        assertEquals(0, OverlaySizing.sampleSizes(emptyList(), 48 * mb).size)
    }

    /* ---- helpers --------------------------------------------------------------------------- */

    private fun pngHeader(width: Int, height: Int): ByteArray {
        val bytes = ByteArray(24)
        val signature = intArrayOf(0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
        signature.forEachIndexed { i, b -> bytes[i] = b.toByte() }
        writeInt(bytes, 8, 13)
        "IHDR".forEachIndexed { i, c -> bytes[12 + i] = c.code.toByte() }
        writeInt(bytes, 16, width)
        writeInt(bytes, 20, height)
        return bytes
    }

    private fun writeInt(bytes: ByteArray, at: Int, value: Int) {
        bytes[at] = (value ushr 24).toByte()
        bytes[at + 1] = (value ushr 16).toByte()
        bytes[at + 2] = (value ushr 8).toByte()
        bytes[at + 3] = value.toByte()
    }

    private companion object {
        /**
         * A complete, valid 37x1001 transparent PNG, the shape of a canvas `toDataURL` payload, so
         * the header tests read an encoder's bytes rather than a header this file assembled.
         */
        const val PNG_37_X_1001 =
            "iVBORw0KGgoAAAANSUhEUgAAACUAAAPpCAYAAACSXORRAAAAp0lEQVR42u3BgQAAAADDoPlTn+AGVQEAAAAAAAAA" +
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
                "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" +
                "AAAAAMAxRrsAARqlvKsAAAAASUVORK5CYII="
    }
}
