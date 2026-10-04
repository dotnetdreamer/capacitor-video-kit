package net.dotnetdreamer.videokit.videocomposer

/**
 * A clip's placement rectangle MOVING over output time - `ComposeRectMotion` in definitions.ts, as
 * the parser leaves it: times non-decreasing, `x` and `y` held to -[MAX_OFFSET]..[MAX_OFFSET] and the
 * sides to 0..`MAX_PLACEMENT_SIZE`. A clip that holds still carries null instead, and null is the old
 * path in full: the plan builds the clip's geometry once and nothing is evaluated per frame.
 *
 * JS compiles a split screen opening and closing into these keys (`compileLayoutMotions` in
 * `src/editor/layout-motion.ts`), so this engine eases nothing: [at] reads them in straight lines,
 * which is the camera's precedent and the reason the preview, the web export and this one cannot
 * disagree about where the line between two videos is.
 *
 * Doubles for the camera's reason: the TypeScript that wrote the keys counts in doubles, and the GL
 * side narrows to floats at the last step. A plain class, because its fields are arrays.
 */
class RectMotion(
    /** Output-timeline milliseconds, non-decreasing. Fractional, because JS writes them so. */
    val atMs: DoubleArray,
    /** The rectangle's left edge, a fraction of the output width. */
    val x: DoubleArray,
    /** Its top edge, a fraction of the output height, y DOWN. */
    val y: DoubleArray,
    val w: DoubleArray,
    val h: DoubleArray,
) {

    val size: Int get() = atMs.size

    /**
     * The rectangle at output time [ms], read exactly as `rectMotionAt` in layout-motion.ts reads it
     * - which is `cameraAt`, and [CameraTrack.at], line for line: the end keys HOLD, each of the four
     * is interpolated in a straight line between the keys either side, and keys at the same time are
     * a STEP with the later one winning.
     */
    fun at(ms: Double): Rect {
        val n = atMs.size
        if (n == 0) return Rect(0f, 0f, 1f, 1f)
        if (!(ms > atMs[0])) {
            // At or before the first key. Equal times are a step to the LAST key sharing that time.
            var i = 0
            while (i + 1 < n && atMs[i + 1] <= ms) i++
            return key(i)
        }
        if (ms >= atMs[n - 1]) return key(n - 1)
        // The last key at or before `ms`: atMs[lo] <= ms < atMs[lo + 1].
        var lo = 0
        var hi = n - 1
        while (hi - lo > 1) {
            val mid = (lo + hi) ushr 1
            if (atMs[mid] <= ms) lo = mid else hi = mid
        }
        val span = atMs[lo + 1] - atMs[lo]
        val f = if (span > 0.0) (ms - atMs[lo]) / span else 1.0
        return Rect(
            lerp(x, lo, f).toFloat(),
            lerp(y, lo, f).toFloat(),
            lerp(w, lo, f).toFloat(),
            lerp(h, lo, f).toFloat(),
        )
    }

    /** [at] for a frame's presentation time, which Media3 stamps in microseconds. */
    fun atUs(timeUs: Long): Rect = at(timeUs / 1000.0)

    private fun key(i: Int) = Rect(x[i].toFloat(), y[i].toFloat(), w[i].toFloat(), h[i].toFloat())

    private fun lerp(values: DoubleArray, lo: Int, f: Double): Double {
        val a = values[lo]
        return a + (values[lo + 1] - a) * f
    }

    companion object {
        /** The most keys one clip's motion may carry - `MAX_RECT_MOTION_KEYS`. More is refused. */
        const val MAX_KEYS = 6000

        /** How far off the frame a moving rectangle's corner may be put, in frames. A slide needs one. */
        const val MAX_OFFSET = 4.0

        /**
         * The narrowest a moving rectangle may be, in output pixels, and still be drawn -
         * `MIN_DRAWN_PX`. A wipe opens from exactly nothing, so its first frame is one of these.
         */
        const val MIN_DRAWN_PX = 0.5f

        /** Whether [rect] on a [width] x [height] frame is too thin to draw anything at all. */
        fun drawsNothing(rect: Rect, width: Int, height: Int): Boolean =
            !(rect.w * width >= MIN_DRAWN_PX) || !(rect.h * height >= MIN_DRAWN_PX)
    }
}
