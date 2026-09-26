package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.abs

/**
 * How one overlay moves - `ComposeOverlayMotion` in definitions.ts, as the parser leaves it: times
 * non-decreasing, every value already clamped, and only the channels that ever leave their neutral
 * value present. A spec with no motion, or one that moves nothing, carries null instead, and null is
 * the old overlay path in full: [TimedBitmapOverlay] hands back the two settings objects it made up
 * front and evaluates nothing per frame.
 *
 * JS compiles every preset, spring and loop into these keys (`compileOverlayMotion` in
 * `src/editor/motion.ts`), so this engine eases nothing: [at] reads them in straight lines, which is
 * the camera's precedent and the reason the preview, the web export and this one cannot disagree
 * about a pop.
 *
 * Doubles for the camera's reason: the TypeScript that wrote the keys counts in doubles, and the GL
 * side narrows to floats at the last step. A plain class, because its fields are arrays.
 */
class OverlayMotion(
    /** Output-timeline milliseconds, non-decreasing. Fractional, because JS writes them so. */
    val atMs: DoubleArray,
    /** Offset of the centre, a fraction of the output WIDTH, positive right. Null holds 0. */
    val x: DoubleArray?,
    /** The same, a fraction of the output HEIGHT, positive DOWN. Null holds 0. */
    val y: DoubleArray?,
    /** Size about the centre, multiplying `wPx`/`hPx`. Null holds 1. */
    val scale: DoubleArray?,
    /** Clockwise degrees added to the overlay's own. Null holds 0. */
    val rotation: DoubleArray?,
    /** Multiplied into the overlay's opacity. Null holds 1. */
    val opacity: DoubleArray?,
) {

    val size: Int get() = atMs.size

    /**
     * The motion at output time [ms], read exactly as `overlayMotionAt` in motion.ts reads it - which
     * is `cameraAt`, and [CameraTrack.at], line for line: the end keys HOLD, every channel is
     * interpolated in a straight line between the keys either side, and keys at the same time are a
     * STEP with the later one winning. Null where the overlay is at rest, so the caller hands back
     * the settings it already has for that frame.
     *
     * Binary search, because a long looping layer compiles to thousands of keys and this runs for
     * every frame of every moving overlay.
     */
    fun at(ms: Double): MotionSample? {
        val n = atMs.size
        if (n == 0) return null
        val sample = if (!(ms > atMs[0])) {
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
            MotionSample(
                x = lerp(x, 0.0, lo, f),
                y = lerp(y, 0.0, lo, f),
                scale = lerp(scale, 1.0, lo, f),
                rotation = lerp(rotation, 0.0, lo, f),
                opacity = lerp(opacity, 1.0, lo, f),
            )
        }
        return if (sample.isNeutral) null else sample
    }

    /** [at] for a frame's presentation time, which Media3 stamps in microseconds. */
    fun atUs(timeUs: Long): MotionSample? = at(timeUs / 1000.0)

    private fun key(i: Int) = MotionSample(
        x = x?.get(i) ?: 0.0,
        y = y?.get(i) ?: 0.0,
        scale = scale?.get(i) ?: 1.0,
        rotation = rotation?.get(i) ?: 0.0,
        opacity = opacity?.get(i) ?: 1.0,
    )

    private fun lerp(values: DoubleArray?, neutral: Double, lo: Int, f: Double): Double {
        if (values == null) return neutral
        val a = values[lo]
        return a + (values[lo + 1] - a) * f
    }

    companion object {
        /** The most keys one overlay's motion may carry - `MAX_OVERLAY_MOTION_KEYS`. More is refused. */
        const val MAX_KEYS = 6000

        /** Below this a channel is at rest - `isNeutralMotion`'s epsilon. */
        const val NEUTRAL_EPSILON = 1e-6
    }
}

/** Where an overlay's motion has it at one moment: the five channels of `OverlayMotionSample`. */
data class MotionSample(
    val x: Double,
    val y: Double,
    val scale: Double,
    val rotation: Double,
    val opacity: Double,
) {
    /** Whether the overlay is exactly where the static path puts it - `isNeutralMotion`. */
    val isNeutral: Boolean
        get() = abs(x) <= OverlayMotion.NEUTRAL_EPSILON &&
            abs(y) <= OverlayMotion.NEUTRAL_EPSILON &&
            abs(scale - 1.0) <= OverlayMotion.NEUTRAL_EPSILON &&
            abs(rotation) <= OverlayMotion.NEUTRAL_EPSILON &&
            abs(opacity - 1.0) <= OverlayMotion.NEUTRAL_EPSILON
}

/**
 * An overlay's placement in the terms Media3's `OverlaySettings` takes: its centre in the output's
 * normalised device coordinates (origin centre, y UP), its stretch in its own axes, its turn as GL
 * counts it (counter-clockwise), and its alpha. What [TimedBitmapOverlay] builds its settings from,
 * kept free of Android and Media3 types so the JVM tests can pin the arithmetic.
 */
data class OverlayPose(
    val anchorX: Float,
    val anchorY: Float,
    val scaleX: Float,
    val scaleY: Float,
    val rotationGlDeg: Float,
    val alpha: Float,
    /**
     * Half the overlay's size on the output, in the same NDC as the anchor: `wPx / width` and
     * `hPx / height`. Only a centre OFF the frame needs them - see [anchors] - and a still overlay's
     * centre never is, so 0, the default, is right for one.
     */
    val halfWidth: Float = 0f,
    val halfHeight: Float = 0f,
) {

    /**
     * Whether there is anything to draw: a pose shrunk to nothing or faded out draws no pixel, and
     * neither does one whose centre has left the frame by more than half its size ([anchors]).
     */
    val isDrawn: Boolean get() = alpha > 0f && scaleX > 0f && scaleY > 0f && anchors() != null

    /**
     * The two anchors Media3 is given for this pose, or null when the overlay is wholly off the frame.
     *
     * Media3 REFUSES a background anchor outside -1..1 - `StaticOverlaySettings.Builder` throws, and
     * mid-export that is a failed render - while a moving layer's centre may well leave the frame: a
     * slide in from beside a caption near the edge starts there. So the background anchor is held to
     * the frame and the OVERLAY anchor makes up the rest. `OverlayMatrixProvider` puts the overlay's
     * centre at `background - half * overlay` (its matrix is `T(bg) A S T(-ov) S^-1 ...`, and the
     * `A S` in front of the `-ov` is exactly the overlay's half size in the output's NDC), and the
     * turn is made about the centre before that translation, so the centre lands where the pose says
     * whatever the angle. An overlay anchor has to be inside -1..1 as well, which is a centre at most
     * half the overlay's size past the edge; past that no part of the upright overlay is on the frame,
     * and the pose is not drawn.
     *
     * A centre on the frame - every still overlay, and a moving one almost always - gets the anchors
     * it always got: itself, and the overlay's own centre (0, 0).
     */
    fun anchors(): Anchors? {
        val backgroundX = anchorX.coerceIn(-1f, 1f)
        val backgroundY = anchorY.coerceIn(-1f, 1f)
        val overlayX = overlayAnchor(backgroundX - anchorX, halfWidth) ?: return null
        val overlayY = overlayAnchor(backgroundY - anchorY, halfHeight) ?: return null
        return Anchors(backgroundX, backgroundY, overlayX, overlayY)
    }

    private fun overlayAnchor(past: Float, half: Float): Float? = when {
        past == 0f -> 0f
        half > 0f && abs(past) <= half -> past / half
        else -> null
    }

    /** The anchors of [anchors]: the background's in the output's NDC, the overlay's in its own. */
    data class Anchors(val backgroundX: Float, val backgroundY: Float, val overlayX: Float, val overlayY: Float)

    /**
     * This pose where [sample] moves it - the contract's "three numbers added and two multiplied",
     * said in the coordinates GL draws in. The web's fractions become NDC by doubling, and its y and
     * its clockwise turn both flip, exactly as [RenderPlan.OverlayPlacement] flips `cy` and
     * `rotationDeg`: an offset of `x` of the WIDTH is `2x` across -1..1, `y` DOWN is `-2y` up, and a
     * clockwise `rotation` is a counter-clockwise `-rotation`. The size multiplies both stretches -
     * which Media3 applies in the bitmap's own axes, about the centre the anchor names - and the
     * opacity multiplies the alpha.
     */
    fun moved(sample: MotionSample): OverlayPose = OverlayPose(
        anchorX = (anchorX + 2.0 * sample.x).toFloat(),
        anchorY = (anchorY - 2.0 * sample.y).toFloat(),
        scaleX = (scaleX * sample.scale).toFloat(),
        scaleY = (scaleY * sample.scale).toFloat(),
        rotationGlDeg = (rotationGlDeg - sample.rotation).toFloat(),
        alpha = (alpha * sample.opacity).toFloat().coerceIn(0f, 1f),
        halfWidth = (halfWidth * sample.scale).toFloat(),
        halfHeight = (halfHeight * sample.scale).toFloat(),
    )
}
