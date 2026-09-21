package net.dotnetdreamer.videokit.videocomposer

import android.graphics.Bitmap
import androidx.annotation.OptIn
import androidx.media3.common.OverlaySettings
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.StaticOverlaySettings

/**
 * One pre-rasterised overlay, visible for a window of the output timeline.
 *
 * Text, emoji and stickers are all rasterised by the caller, so there is no font handling, text
 * layout or SVG anywhere on this side - just a bitmap and where to put it. The time gate is done
 * with alpha rather than by adding and removing overlays, because the effect chain is fixed for the
 * whole export.
 *
 * Placement is exact even when the bitmap is smaller than the area it covers. The overlay effect
 * runs after `Presentation`, so the "background" Media3's matrix provider measures against is
 * already the output frame, and the provider sizes a quad as `scale x texture size` output pixels.
 * A `w x h` bitmap drawn at `(wPx / w, hPx / h)` therefore covers exactly `wPx x hPx` - whether the
 * PNG was drawn at half resolution by the web side, halved again by the decode budget, or both.
 */
@OptIn(UnstableApi::class)
class TimedBitmapOverlay(
    private val bitmap: Bitmap,
    /** Visible while `startUs <= t < endUs`. */
    private val startUs: Long,
    private val endUs: Long,
    anchorX: Float,
    anchorY: Float,
    rotationGlDeg: Float,
    opacity: Float,
    /**
     * How much to stretch the bitmap along its own axes to reach its size on the output frame;
     * see [OverlaySizing.overlayScale]. No default on purpose: the PNG is allowed to be smaller
     * than the area it covers, so "1" is only right by coincidence. The two usually match, but
     * they are kept apart so an odd-sized PNG halved by the decoder does not drift in one axis.
     */
    scaleX: Float,
    scaleY: Float,
) : BitmapOverlay() {

    private val visible: OverlaySettings =
        settings(anchorX, anchorY, rotationGlDeg, scaleX, scaleY, opacity)
    private val hidden: OverlaySettings =
        settings(anchorX, anchorY, rotationGlDeg, scaleX, scaleY, 0f)

    /**
     * The same instance every time on purpose: `BitmapOverlay` caches the uploaded texture per
     * bitmap instance, so returning one object means one upload for the whole export.
     */
    override fun getBitmap(presentationTimeUs: Long): Bitmap = bitmap

    override fun getOverlaySettings(presentationTimeUs: Long): OverlaySettings =
        if (presentationTimeUs in startUs until endUs) visible else hidden

    /**
     * Deliberately does NOT recycle the bitmap.
     *
     * Media3 rebuilds the shader-program chain whenever it registers a new input stream, which for
     * a multi-clip sequence means once per clip - and rebuilding releases every overlay first. An
     * overlay that destroyed its bitmap here would therefore work for the first clip and fail the
     * export at the very first item boundary, which is exactly what it did. The bitmap belongs to
     * whoever created the overlay; [recycle] is how they hand it back once the job is finished.
     */
    override fun release() {
        super.release()
    }

    /** Called by the owner when the job is over and the bitmap is genuinely finished with. */
    fun recycle() {
        if (!bitmap.isRecycled) bitmap.recycle()
    }

    private fun settings(
        anchorX: Float,
        anchorY: Float,
        rotationGlDeg: Float,
        scaleX: Float,
        scaleY: Float,
        alpha: Float,
    ): OverlaySettings = StaticOverlaySettings.Builder()
        // Where on the output frame the overlay's own anchor lands, in NDC.
        .setBackgroundFrameAnchor(anchorX, anchorY)
        // ...and that anchor is the bitmap's centre. With a centred anchor Media3's matrix reduces
        // to "scale in the bitmap's own axes, then rotate in pixel space", so a non-uniform scale
        // stays a clean stretch to wPx x hPx and the rotation does not shear it.
        .setOverlayFrameAnchor(0f, 0f)
        .setScale(scaleX, scaleY)
        .setRotationDegrees(rotationGlDeg)
        .setAlphaScale(alpha)
        .build()
}

/**
 * The arithmetic between an overlay's PNG and the area it covers, kept free of Android types so
 * the JVM unit tests can pin it. It lives outside [TimedBitmapOverlay] so that using it does not
 * load Media3's `BitmapOverlay`.
 */
internal object OverlaySizing {

    /** ARGB_8888, which is what every overlay is decoded as. */
    const val BYTES_PER_PIXEL = 4L

    /**
     * How many base64 characters cover the PNG signature and the IHDR width and height: 24 bytes,
     * and 32 characters is exactly 24 bytes with no padding.
     */
    const val PNG_HEADER_BASE64_CHARS = 32

    data class PixelSize(val width: Int, val height: Int) {
        val pixels: Long get() = width.toLong() * height.toLong()
    }

    data class Scale(val x: Float, val y: Float)

    /**
     * The factors that stretch a decoded `bitmapW x bitmapH` bitmap to cover `wPx x hPx` output
     * pixels. Computed from the bitmap that was actually decoded rather than from the sample size
     * asked for, because the decoder floors odd dimensions when it halves them.
     */
    fun overlayScale(wPx: Int, hPx: Int, bitmapW: Int, bitmapH: Int): Scale {
        require(bitmapW > 0 && bitmapH > 0) { "empty overlay bitmap ${bitmapW}x$bitmapH" }
        return Scale(wPx.toFloat() / bitmapW.toFloat(), hPx.toFloat() / bitmapH.toFloat())
    }

    /**
     * The pixel size a PNG will decode to, read straight from its IHDR chunk. That is the first
     * chunk the format allows, at a fixed offset, so the first 24 bytes are enough and nothing has
     * to be decompressed. Null for anything that is not a PNG, so the caller can ask the platform
     * decoder instead.
     */
    fun pngSize(header: ByteArray?): PixelSize? {
        if (header == null || header.size < 24) return null
        for (i in PNG_SIGNATURE.indices) {
            if (header[i] != PNG_SIGNATURE[i]) return null
        }
        if (header[12] != 'I'.code.toByte() || header[13] != 'H'.code.toByte() ||
            header[14] != 'D'.code.toByte() || header[15] != 'R'.code.toByte()
        ) {
            return null
        }
        val width = readIntBigEndian(header, 16)
        val height = readIntBigEndian(header, 20)
        return if (width > 0 && height > 0) PixelSize(width, height) else null
    }

    /**
     * The `inSampleSize` for each overlay, in order, so that all of them together stay near
     * [budgetBytes]. Everything is decoded at full size while it fits; past that, every bitmap at
     * or above the median pixel count is decoded at half size (a quarter of the memory), and the
     * placement scale makes up the difference on the output frame.
     *
     * The sizes are the PNGs' own, not the areas they cover: a half-resolution full-frame effect
     * costs a quarter of a full-resolution one, and counting it as full size would halve it again
     * for no reason.
     */
    fun sampleSizes(sizes: List<PixelSize>, budgetBytes: Long): IntArray {
        if (sizes.isEmpty()) return IntArray(0)
        val totalBytes = sizes.sumOf { it.pixels * BYTES_PER_PIXEL }
        if (totalBytes <= budgetBytes) return IntArray(sizes.size) { 1 }
        val halveAtOrAbove = sizes.map { it.pixels }.sorted()[sizes.size / 2]
        return IntArray(sizes.size) { i -> if (sizes[i].pixels >= halveAtOrAbove) 2 else 1 }
    }

    private val PNG_SIGNATURE = byteArrayOf(
        0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A,
    )

    private fun readIntBigEndian(bytes: ByteArray, at: Int): Int =
        ((bytes[at].toInt() and 0xFF) shl 24) or
            ((bytes[at + 1].toInt() and 0xFF) shl 16) or
            ((bytes[at + 2].toInt() and 0xFF) shl 8) or
            (bytes[at + 3].toInt() and 0xFF)
}
