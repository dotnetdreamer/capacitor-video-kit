package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.sin

/**
 * The colour pipeline, as pure arithmetic.
 *
 * Every filter and adjust control the editor offers is a CSS Filter Effects operation, and the
 * numbers below are the ones straight out of that spec. That is the whole point: Chromium's
 * `ctx.filter` uses the same constants, so the preview the customer taps through and the frames
 * this plugin encodes agree by construction rather than by eyeballing.
 *
 * Only the RGB rows matter - no operation touches alpha - so a 4x5 matrix is stored as a 3x3
 * multiply [m] plus a 3-vector offset [o]: `out = clamp(m * rgb + o, 0, 1)`.
 *
 * Known approximation: CSS clamps after EACH operation, a single composed matrix clamps once at
 * the end. The two differ only near pure white and pure black, and only for op pairs that push a
 * channel out of range and then pull it back (a brightness lift followed by a contrast cut). Every
 * engine folds to one matrix, so all of them share the identical error and therefore agree with
 * each other, which is what actually matters here.
 */
class ColorMatrix(
    /** Row-major 3x3: `m[row * 3 + col]`. */
    val m: FloatArray,
    val o: FloatArray,
) {
    init {
        require(m.size == 9) { "m must be 3x3" }
        require(o.size == 3) { "o must be a 3-vector" }
    }

    fun apply(r: Float, g: Float, b: Float): FloatArray = floatArrayOf(
        (m[0] * r + m[1] * g + m[2] * b + o[0]).coerceIn(0f, 1f),
        (m[3] * r + m[4] * g + m[5] * b + o[1]).coerceIn(0f, 1f),
        (m[6] * r + m[7] * g + m[8] * b + o[2]).coerceIn(0f, 1f),
    )

    /** `this` applied AFTER [prev]. */
    fun compose(prev: ColorMatrix): ColorMatrix {
        val n = FloatArray(9)
        for (row in 0..2) {
            for (col in 0..2) {
                var sum = 0f
                for (k in 0..2) sum += m[row * 3 + k] * prev.m[k * 3 + col]
                n[row * 3 + col] = sum
            }
        }
        val off = FloatArray(3)
        for (row in 0..2) {
            var sum = o[row]
            for (k in 0..2) sum += m[row * 3 + k] * prev.o[k]
            off[row] = sum
        }
        return ColorMatrix(n, off)
    }

    fun isIdentity(): Boolean {
        for (row in 0..2) {
            for (col in 0..2) {
                val expected = if (row == col) 1f else 0f
                if (abs(m[row * 3 + col] - expected) > EPSILON) return false
            }
            if (abs(o[row]) > EPSILON) return false
        }
        return true
    }

    /**
     * GLSL `mat3` uniforms are column-major and `GlProgram.setFloatsUniform` uploads them with
     * `transpose = false`, so the array has to be laid out column by column.
     */
    fun toGlColumnMajor(): FloatArray = floatArrayOf(
        m[0], m[3], m[6],
        m[1], m[4], m[7],
        m[2], m[5], m[8],
    )

    fun offset(): FloatArray = o.copyOf()

    companion object {
        private const val EPSILON = 1e-6f

        /** Luminance weights the spec uses for `saturate` and `hue-rotate`. */
        private const val LR = 0.213f
        private const val LG = 0.715f
        private const val LB = 0.072f

        /** ...and the (different) ones it uses for `grayscale`, which is defined via the sRGB primaries. */
        private const val GR = 0.2126f
        private const val GG = 0.7152f
        private const val GB = 0.0722f

        val IDENTITY = ColorMatrix(
            floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f),
            floatArrayOf(0f, 0f, 0f),
        )

        fun brightness(a: Float) = ColorMatrix(
            floatArrayOf(a, 0f, 0f, 0f, a, 0f, 0f, 0f, a),
            floatArrayOf(0f, 0f, 0f),
        )

        fun contrast(a: Float): ColorMatrix {
            val t = 0.5f - 0.5f * a
            return ColorMatrix(
                floatArrayOf(a, 0f, 0f, 0f, a, 0f, 0f, 0f, a),
                floatArrayOf(t, t, t),
            )
        }

        fun saturate(s: Float) = ColorMatrix(
            floatArrayOf(
                LR + LR_COMPLEMENT * s, LG - LG * s, LB - LB * s,
                LR - LR * s, LG + (1f - LG) * s, LB - LB * s,
                LR - LR * s, LG - LG * s, LB + (1f - LB) * s,
            ),
            floatArrayOf(0f, 0f, 0f),
        )

        /** `grayscale(a)` is `saturate(1 - a)` with the sRGB luminance weights. */
        fun grayscale(a: Float): ColorMatrix {
            val s = 1f - a
            return ColorMatrix(
                floatArrayOf(
                    GR + (1f - GR) * s, GG - GG * s, GB - GB * s,
                    GR - GR * s, GG + (1f - GG) * s, GB - GB * s,
                    GR - GR * s, GG - GG * s, GB + (1f - GB) * s,
                ),
                floatArrayOf(0f, 0f, 0f),
            )
        }

        fun sepia(a: Float): ColorMatrix {
            val s = 1f - a
            return ColorMatrix(
                floatArrayOf(
                    0.393f + 0.607f * s, 0.769f - 0.769f * s, 0.189f - 0.189f * s,
                    0.349f - 0.349f * s, 0.686f + 0.314f * s, 0.168f - 0.168f * s,
                    0.272f - 0.272f * s, 0.534f - 0.534f * s, 0.131f + 0.869f * s,
                ),
                floatArrayOf(0f, 0f, 0f),
            )
        }

        fun hueRotate(degrees: Float): ColorMatrix {
            val rad = Math.toRadians(degrees.toDouble())
            val c = cos(rad).toFloat()
            val s = sin(rad).toFloat()
            return ColorMatrix(
                floatArrayOf(
                    LR + 0.787f * c - LR * s, LG - LG * c - LG * s, LB - LB * c + 0.928f * s,
                    LR - LR * c + 0.143f * s, LG + 0.285f * c + 0.140f * s, LB - LB * c - 0.283f * s,
                    LR - LR * c - 0.787f * s, LG - LG * c + LG * s, LB + 0.928f * c + LB * s,
                ),
                floatArrayOf(0f, 0f, 0f),
            )
        }

        /** A `source-over` fill of `rgba(r, g, b, alpha)` - the same thing the web preview draws. */
        fun tint(r: Int, g: Int, b: Int, alpha: Float): ColorMatrix {
            val keep = 1f - alpha
            return ColorMatrix(
                floatArrayOf(keep, 0f, 0f, 0f, keep, 0f, 0f, 0f, keep),
                floatArrayOf(alpha * r / 255f, alpha * g / 255f, alpha * b / 255f),
            )
        }

        fun of(op: FilterOp): ColorMatrix = when (op) {
            is FilterOp.Brightness -> brightness(op.amount)
            is FilterOp.Contrast -> contrast(op.amount)
            is FilterOp.Saturate -> saturate(op.amount)
            is FilterOp.Sepia -> sepia(op.amount)
            is FilterOp.Grayscale -> grayscale(op.amount)
            is FilterOp.HueRotate -> hueRotate(op.degrees)
            is FilterOp.Tint -> tint(op.r, op.g, op.b, op.alpha)
        }

        /** Folds the ordered list into one matrix; the first entry is applied first. */
        fun fold(ops: List<FilterOp>): ColorMatrix =
            ops.fold(IDENTITY) { acc, op -> of(op).compose(acc) }

        private const val LR_COMPLEMENT = 1f - LR
    }
}
