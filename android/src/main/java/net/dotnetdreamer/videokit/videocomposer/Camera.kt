package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.max
import kotlin.math.min

/**
 * Where the camera is at one moment - `CameraView` in `src/editor/camera.ts`: [scale] >= 1 and the
 * point ([cx], [cy]) of the unzoomed frame, in the 0..1 top-left fractions of the output every other
 * field uses, that it brings to the frame's centre.
 *
 * Doubles, because the TypeScript that wrote the keys counts in doubles and the parser's clamp has
 * to land on the same numbers the web engine's does; the GL side narrows to floats at the last step.
 */
data class CameraView(val scale: Double, val cx: Double, val cy: Double) {

    /** The centre in the compositor's normalised device coordinates: origin centre, y UP. */
    val focusNdcX: Double get() = 2.0 * cx - 1.0
    val focusNdcY: Double get() = 1.0 - 2.0 * cy

    /**
     * Where a point of the unzoomed frame lands, both in NDC: `q = k (p - f)`. The contract's
     * `p' = 0.5 + (p - c) * scale` said in the coordinates GL draws in - the flip of y changes the
     * sign of both sides, so the scale about the focus is the same line in either.
     */
    fun viewNdcX(x: Double): Double = scale * (x - focusNdcX)
    fun viewNdcY(y: Double): Double = scale * (y - focusNdcY)

    /** The same in output FRACTIONS, y down - `viewPoint` in camera.ts, for the tests to pin. */
    fun viewFractionX(x: Double): Double = 0.5 + (x - cx) * scale
    fun viewFractionY(y: Double): Double = 0.5 + (y - cy) * scale

    /**
     * The camera as the 3x3 row-major matrix a `MatrixTransformation` hands Media3 over NDC:
     * `translate(-f)` then `scale(k)`. Pure numbers, because `android.graphics.Matrix` is a stub on
     * the JVM; [CompositionBuilder] copies these nine into its one reused `Matrix` per frame.
     */
    fun ndcMatrix(): FloatArray {
        val k = scale.toFloat()
        return floatArrayOf(
            k, 0f, (-scale * focusNdcX).toFloat(),
            0f, k, (-scale * focusNdcY).toFloat(),
            0f, 0f, 1f,
        )
    }

    companion object {
        /** Below this a view is the whole frame; it keeps float dust from switching the camera on. */
        const val IDENTITY_EPSILON = 1e-4

        /** Whether a view leaves the frame as it is - `isIdentityView`. */
        fun isIdentity(view: CameraView?): Boolean = view == null || view.scale <= 1.0 + IDENTITY_EPSILON

        /**
         * A view held inside the frame - `clampView`: the scale to 1..[MAX_CAMERA_SCALE] and each
         * centre to `0.5 / scale .. 1 - 0.5 / scale`. Non-finite numbers fall back to the whole frame.
         *
         * The inside-the-frame half is what lets this engine fold the camera into each layer on its
         * own rather than over the finished composite: a base clip's geometry is clipped at the frame
         * BEFORE the camera and a layer is clipped by the compositor only AFTER it, and the two clips
         * agree only while the view never reaches past an edge. The set of views that obey it is
         * convex, so the straight lines between two clamped keys obey it too.
         */
        fun clamp(scale: Double, cx: Double, cy: Double): CameraView {
            val s = if (scale.isFinite()) min(MAX_CAMERA_SCALE, max(1.0, scale)) else 1.0
            val half = 0.5 / s
            val x = if (cx.isFinite()) min(1.0 - half, max(half, cx)) else 0.5
            val y = if (cy.isFinite()) min(1.0 - half, max(half, cy)) else 0.5
            return CameraView(s, x, y)
        }

        /** The most a camera may magnify - `MAX_CAMERA_SCALE` in definitions.ts. */
        const val MAX_CAMERA_SCALE = 8.0

        /** The most keys a camera may carry - `MAX_CAMERA_KEYS`. More is refused, never truncated. */
        const val MAX_CAMERA_KEYS = 20_000
    }
}

/**
 * The zoom camera over the OUTPUT timeline - `ComposeCamera`, as the parser leaves it: four arrays
 * of one length, times non-decreasing, every key already clamped and at least one of them zoomed in.
 * A spec with no camera, or one that never magnifies, carries null instead, and null is the whole of
 * the old render path: no effect is added to any clip and the compositor hands back what it always
 * did.
 *
 * JS compiles every ramp, ease and pan into these keys, so the engine eases nothing: [at] reads them
 * in straight lines and that is the whole of what "smoothness" costs here - the transitions
 * precedent, and the reason the preview, the web export and this one cannot disagree about a curve.
 *
 * A plain class and not a data class for the reason [Transition] gives: its fields are arrays.
 */
class CameraTrack(
    /** Output-timeline milliseconds, non-decreasing. Fractional, because JS writes them so. */
    val atMs: DoubleArray,
    val scale: DoubleArray,
    val cx: DoubleArray,
    val cy: DoubleArray,
) {

    val size: Int get() = atMs.size

    /**
     * The camera at output time [ms], read exactly as `cameraAt` in camera.ts reads it: the end keys
     * HOLD, fields are interpolated in a straight line between the keys either side, and keys at the
     * same time are a STEP with the later one winning. Null where the frame is whole, so a caller can
     * hand back its unzoomed answer for that frame without doing any arithmetic.
     *
     * Binary search, because a long post compiles to thousands of keys and this runs for every frame
     * of every video input.
     */
    fun at(ms: Double): CameraView? {
        val n = atMs.size
        if (n == 0) return null
        val view = if (!(ms > atMs[0])) {
            // At or before the first key. Equal times are a step to the LAST key sharing that time.
            var i = 0
            while (i + 1 < n && atMs[i + 1] <= ms) i++
            key(i)
        } else if (ms >= atMs[n - 1]) {
            key(n - 1)
        } else {
            // The last key at or before `ms`: atMs[lo] <= ms < atMs[lo + 1].
            var lo = 0
            var hi = n - 1
            while (hi - lo > 1) {
                val mid = (lo + hi) ushr 1
                if (atMs[mid] <= ms) lo = mid else hi = mid
            }
            val span = atMs[lo + 1] - atMs[lo]
            val f = if (span > 0.0) (ms - atMs[lo]) / span else 1.0
            CameraView(
                scale = lerp(scale[lo], scale[lo + 1], f),
                cx = lerp(cx[lo], cx[lo + 1], f),
                cy = lerp(cy[lo], cy[lo + 1], f),
            )
        }
        return if (CameraView.isIdentity(view)) null else view
    }

    /** [at] for a frame's presentation time, which Media3 stamps in microseconds. */
    fun atUs(timeUs: Long): CameraView? = at(timeUs / 1000.0)

    /**
     * The most the camera magnifies anywhere in `[fromMs, toMs]`. The track is piecewise linear, so
     * its largest value over a window is at one of the window's ends or at a key inside it - no
     * sampling, and exact however short a zoom is.
     */
    fun maxScaleBetween(fromMs: Double, toMs: Double): Double {
        if (atMs.isEmpty() || toMs < fromMs) return 1.0
        var most = max(scaleAt(fromMs), scaleAt(toMs))
        for (i in atMs.indices) {
            if (atMs[i] in fromMs..toMs) most = max(most, scale[i])
        }
        return most
    }

    /** Whether the camera moves the picture anywhere in `[fromMs, toMs]`. */
    fun zoomsBetween(fromMs: Double, toMs: Double): Boolean =
        maxScaleBetween(fromMs, toMs) > 1.0 + CameraView.IDENTITY_EPSILON

    /** [at]'s scale, 1 where the frame is whole. */
    private fun scaleAt(ms: Double): Double = at(ms)?.scale ?: 1.0

    private fun key(i: Int) = CameraView(scale[i], cx[i], cy[i])

    private fun lerp(a: Double, b: Double, f: Double): Double = a + (b - a) * f
}
