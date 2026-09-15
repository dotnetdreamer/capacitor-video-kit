package net.dotnetdreamer.choisy.videocomposer

import android.graphics.Bitmap
import androidx.annotation.OptIn
import androidx.media3.common.OverlaySettings
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BitmapOverlay
import androidx.media3.effect.StaticOverlaySettings

/**
 * One pre-rasterised overlay, visible for a window of the output timeline.
 *
 * Text, emoji and stickers are all rasterised by the caller at output pixel scale, so there is no
 * font handling, text layout or SVG anywhere on this side - just a bitmap and where to put it. The
 * time gate is done with alpha rather than by adding and removing overlays, because the effect
 * chain is fixed for the whole export.
 *
 * Placement is exact: the overlay effect runs after `Presentation`, so the "background" the matrix
 * provider measures against is already the output frame, and a `wPx x hPx` bitmap at scale 1 covers
 * exactly `wPx x hPx` output pixels.
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
     * 2 when the PNG had to be decoded at half size to stay inside the bitmap budget. The matrix
     * provider scales by texture size, so scaling back up lands on the same pixels.
     */
    scale: Float = 1f,
) : BitmapOverlay() {

    private val visible: OverlaySettings = settings(anchorX, anchorY, rotationGlDeg, scale, opacity)
    private val hidden: OverlaySettings = settings(anchorX, anchorY, rotationGlDeg, scale, 0f)

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
        scale: Float,
        alpha: Float,
    ): OverlaySettings = StaticOverlaySettings.Builder()
        // Where on the output frame the overlay's own anchor lands, in NDC.
        .setBackgroundFrameAnchor(anchorX, anchorY)
        // ...and that anchor is the bitmap's centre.
        .setOverlayFrameAnchor(0f, 0f)
        .setScale(scale, scale)
        .setRotationDegrees(rotationGlDeg)
        .setAlphaScale(alpha)
        .build()
}
