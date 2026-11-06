package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * Where a layer's bitmap is drawn on a flat surface - `ComposeOverlayQuad` in definitions.ts, as the parser
 * leaves it: [atMs] strictly increasing, and eight finite numbers a key in [corners], the bitmap's top-left,
 * top-right, bottom-right and bottom-left corners in that order, as fractions of the OUTPUT frame with the
 * origin top-left and y DOWN. The keys stay in the wire's terms, as [OverlayMotion]'s do; [LayerGeometry]
 * turns an instant's corners into the ones GL draws.
 *
 * JS compiles the surface's path into these keys, so this engine eases nothing: [at] reads them in straight
 * lines, corner by corner, holding the end keys, which is how `ComposeOverlayQuad` has every engine read them.
 * A plain class, because its fields are arrays.
 */
class OverlayQuad(
    /** Output-timeline milliseconds, strictly increasing. Fractional, because JS writes them so. */
    val atMs: DoubleArray,
    /** [NUMBERS_PER_KEY] a key: x0, y0, x1, y1, x2, y2, x3, y3. */
    val corners: DoubleArray,
) {

    init {
        require(atMs.isNotEmpty() && corners.size == atMs.size * NUMBERS_PER_KEY) {
            "a quad needs at least one key and eight numbers for each, not ${atMs.size} keys and ${corners.size}"
        }
    }

    val size: Int get() = atMs.size

    /**
     * The corners at output time [ms], written into [out] - eight numbers in the keys' order - which is
     * handed back: the first key at or before the first time, the last at or after the last, and between
     * two keys every number on the straight line from one to the other. A binary search, as
     * [OverlayMotion.at] makes, because a tracked surface is a key a frame and this runs for every frame
     * the layer is on.
     */
    fun at(ms: Double, out: DoubleArray): DoubleArray {
        val n = atMs.size
        if (!(ms > atMs[0])) return key(0, out)
        if (ms >= atMs[n - 1]) return key(n - 1, out)
        // The last key at or before `ms`: atMs[lo] <= ms < atMs[lo + 1].
        var lo = 0
        var hi = n - 1
        while (hi - lo > 1) {
            val mid = (lo + hi) ushr 1
            if (atMs[mid] <= ms) lo = mid else hi = mid
        }
        val f = (ms - atMs[lo]) / (atMs[lo + 1] - atMs[lo])
        val from = lo * NUMBERS_PER_KEY
        val to = from + NUMBERS_PER_KEY
        for (j in 0 until NUMBERS_PER_KEY) out[j] = corners[from + j] + (corners[to + j] - corners[from + j]) * f
        return out
    }

    /** [at] for a frame's presentation time, which Media3 stamps in microseconds. */
    fun atUs(timeUs: Long, out: DoubleArray): DoubleArray = at(timeUs / 1000.0, out)

    private fun key(i: Int, out: DoubleArray): DoubleArray =
        corners.copyInto(out, destinationOffset = 0, startIndex = i * NUMBERS_PER_KEY, endIndex = (i + 1) * NUMBERS_PER_KEY)

    companion object {
        /** The most keys one quad may carry - `MAX_OVERLAY_QUAD_KEYS`. A spec with more is refused. */
        const val MAX_KEYS = 6000

        /** Two numbers for each of the four corners. */
        const val NUMBERS_PER_KEY = 8
    }
}

/**
 * The geometry [LayerUnderlayEffect] draws a layer with, free of Android and GL types so the JVM tests can pin
 * it: where the corners of a layer Media3 would have placed land ([poseCorners]), and the homography from a
 * bitmap's own rectangle onto any four corners ([squareToQuad]). Every position is in the output's normalised
 * device coordinates - origin centre, y UP - which is what GL draws in.
 */
internal object LayerGeometry {

    /**
     * The least a homography's weight may be at a corner, where it is 1 at the first. Below it the quad is
     * folded through infinity - or as near as makes no picture - and draws nothing.
     */
    const val MIN_WEIGHT = 1e-6

    /** Below this the corners the homography is solved from are as good as on one line. */
    private const val MIN_DETERMINANT = 1e-12

    /** A bitmap's corners in its own NDC, y UP, in the wire's order: top-left, top-right, bottom-right, bottom-left. */
    private val CORNER_X = doubleArrayOf(-1.0, 1.0, 1.0, -1.0)
    private val CORNER_Y = doubleArrayOf(1.0, 1.0, -1.0, -1.0)

    /** The wire's corners - fractions of the frame, y DOWN - in NDC, into [out], which is handed back. */
    fun fractionsToNdc(fractions: DoubleArray, out: DoubleArray): DoubleArray {
        for (k in 0 until 4) {
            out[2 * k] = 2.0 * fractions[2 * k] - 1.0
            out[2 * k + 1] = 1.0 - 2.0 * fractions[2 * k + 1]
        }
        return out
    }

    /**
     * Where Media3 puts the corners of a [bitmapW] x [bitmapH] bitmap drawn at [pose] on a [frameW] x
     * [frameH] frame, into [out] in the wire's corner order, in NDC: what [TimedBitmapOverlay] would have
     * Media3 draw, for a layer drawn by [LayerUnderlayEffect] instead.
     *
     * It is `OverlayMatrixProvider`'s product in 1.11.1 - `T(background) A S T(-overlay) S^-1 R' S`, `A` the
     * bitmap's size over the frame's and `R'` the turn wrapped in the bitmap's aspect - applied to the
     * bitmap's own corners and multiplied out. That comes to: each corner at the bitmap's half size in
     * PIXELS, `scale x size / 2` along its own axes, turned counter-clockwise by the pose's GL degrees in
     * pixels, at the centre the pose names. [OverlayPose.anchors] only splits that centre between Media3's
     * two anchors so each stays inside -1..1 - the background anchor minus half the size times the overlay
     * anchor is the centre again - so the pose's own centre is used whole. A stretched bitmap is never
     * sheared, and a turn is a turn on the screen rather than in NDC.
     */
    fun poseCorners(pose: OverlayPose, bitmapW: Int, bitmapH: Int, frameW: Int, frameH: Int, out: DoubleArray): DoubleArray {
        val halfW = pose.scaleX.toDouble() * bitmapW / 2.0
        val halfH = pose.scaleY.toDouble() * bitmapH / 2.0
        val turn = Math.toRadians(pose.rotationGlDeg.toDouble())
        val cos = cos(turn)
        val sin = sin(turn)
        for (k in 0 until 4) {
            val x = halfW * CORNER_X[k]
            val y = halfH * CORNER_Y[k]
            out[2 * k] = pose.anchorX + 2.0 * (cos * x - sin * y) / frameW
            out[2 * k + 1] = pose.anchorY + 2.0 * (sin * x + cos * y) / frameH
        }
        return out
    }

    /**
     * The homography from a bitmap's rectangle onto four [corners] (NDC, in the wire's order), into [out]
     * row by row - `a b c / d e f / g h 1` - over the bitmap's texture coordinates (u, v), u along its rows
     * and v DOWN them, which is how GL holds a bitmap `GLUtils` uploaded:
     *
     *   x = (a u + b v + c) / w,   y = (d u + e v + f) / w,   w = g u + h v + 1
     *
     * so (0, 0) lands on the first corner, (1, 0) on the second, (1, 1) on the third and (0, 1) on the
     * fourth. Heckbert's square to quadrilateral, in closed form: four corners fix the eight unknowns. A
     * parallelogram - every flat layer - has `g = h = 0`, and the map is the affine one.
     *
     * False where no such map draws the bitmap whole: three corners on one line, or a quad that is not
     * convex - a corner pushed in past a diagonal, or two sides crossed - whose map sends part of the
     * rectangle through infinity, which shows as the weight `w` changing sign between corners. [out] is not
     * to be read then. A convex quad of either winding is drawn, a mirrored one too: a surface from behind.
     */
    fun squareToQuad(corners: DoubleArray, out: DoubleArray): Boolean {
        val x0 = corners[0]
        val y0 = corners[1]
        val x1 = corners[2]
        val y1 = corners[3]
        val x2 = corners[4]
        val y2 = corners[5]
        val x3 = corners[6]
        val y3 = corners[7]
        val sx = x0 - x1 + x2 - x3
        val sy = y0 - y1 + y2 - y3
        val dx1 = x1 - x2
        val dx2 = x3 - x2
        val dy1 = y1 - y2
        val dy2 = y3 - y2
        val det = dx1 * dy2 - dx2 * dy1
        if (!(abs(det) >= MIN_DETERMINANT)) return false
        val g = (sx * dy2 - dx2 * sy) / det
        val h = (dx1 * sy - sx * dy1) / det
        // The weight at (1, 0), (1, 1) and (0, 1); at (0, 0) it is 1.
        if (!(1.0 + g >= MIN_WEIGHT && 1.0 + g + h >= MIN_WEIGHT && 1.0 + h >= MIN_WEIGHT)) return false
        out[0] = x1 - x0 + g * x1
        out[1] = x3 - x0 + h * x3
        out[2] = x0
        out[3] = y1 - y0 + g * y1
        out[4] = y3 - y0 + h * y3
        out[5] = y0
        out[6] = g
        out[7] = h
        out[8] = 1.0
        return true
    }

    /** [h] (row by row) at (u, v): x and y into [out], and the weight w third. */
    fun map(h: DoubleArray, u: Double, v: Double, out: DoubleArray): DoubleArray {
        val w = h[6] * u + h[7] * v + h[8]
        out[0] = (h[0] * u + h[1] * v + h[2]) / w
        out[1] = (h[3] * u + h[4] * v + h[5]) / w
        out[2] = w
        return out
    }

    /** The inverse of the 3 x 3 [h] (row by row) into [out]; false for one that has none. */
    fun invert(h: DoubleArray, out: DoubleArray): Boolean {
        val a = h[0]
        val b = h[1]
        val c = h[2]
        val d = h[3]
        val e = h[4]
        val f = h[5]
        val g = h[6]
        val k = h[7]
        val i = h[8]
        val c11 = e * i - f * k
        val c12 = -(d * i - f * g)
        val c13 = d * k - e * g
        val det = a * c11 + b * c12 + c * c13
        if (!(abs(det) > 0.0) || !det.isFinite()) return false
        out[0] = c11 / det
        out[1] = -(b * i - c * k) / det
        out[2] = (b * f - c * e) / det
        out[3] = c12 / det
        out[4] = (a * i - c * g) / det
        out[5] = -(a * f - c * d) / det
        out[6] = c13 / det
        out[7] = -(a * k - b * g) / det
        out[8] = (a * e - b * d) / det
        return true
    }

    /**
     * [h] (row by row) as GLSL's `mat3` takes it - column by column - in floats, into [out]. False where a
     * number does not survive as a float, which draws nothing rather than a NaN.
     */
    fun toGl(h: DoubleArray, out: FloatArray): Boolean {
        for (column in 0 until 3) {
            for (row in 0 until 3) {
                val value = h[row * 3 + column].toFloat()
                if (!value.isFinite()) return false
                out[column * 3 + row] = value
            }
        }
        return true
    }
}
