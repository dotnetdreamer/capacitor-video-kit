package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.cos
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.sin

/**
 * What a transition looks like at one moment, read off the curves the spec carries - the Kotlin
 * half of `lookAt` and `sample` in transitions.ts, with identical maths.
 *
 * Pure, and in a file of its own, because it is the one part of a transition this engine can get
 * wrong without a device noticing: the shader only draws what these numbers say, so an off-by-one
 * in the interpolation would be a transition that runs a sample early on Android and on time
 * everywhere else. On the JVM it is pinned against values the TypeScript produced.
 */

/** Which side of a transition a clip is playing. */
enum class TransitionRole {
    /** The outgoing clip's tail, drawn under the incoming one over black. */
    FROM,

    /** The incoming clip, drawn over the tail at `alpha` times the mask. */
    TO,
}

/**
 * One side at one moment - `TransitionSide` in transitions.ts. Every field acts on the side's WHOLE
 * output frame, the black around a letterboxed picture included.
 */
data class SideLook(
    val x: Float,
    val y: Float,
    val scale: Float,
    val rotation: Float,
    val blur: Float,
    val pixelate: Float,
    val split: Float,
    val gain: Float,
    val tint: Float,
) {
    companion object {
        /** Every channel at the value it holds when a transition does not move it. */
        val NEUTRAL = SideLook(
            x = 0f,
            y = 0f,
            scale = 1f,
            rotation = 0f,
            blur = 0f,
            pixelate = 0f,
            split = 0f,
            gain = 1f,
            tint = 0f,
        )
    }
}

/** Everything a transition is at one moment - `TransitionLook` in transitions.ts. */
data class TransitionLook(
    /** How much of the incoming side is drawn over the outgoing one, everywhere at once. */
    val alpha: Float,
    /** How far the mask has opened. Meaningless without one. */
    val reveal: Float,
    val from: SideLook,
    val to: SideLook,
)

object TransitionMath {

    /**
     * One curve at progress [p], 0..1 through the window: straight-line interpolation between the
     * two samples either side, exactly as `sample` does it. Absent is the neutral value, and a [p]
     * outside 0..1 holds the end sample - a non-finite one is read as 0, as the TypeScript reads it.
     */
    fun sample(values: FloatArray?, p: Double, neutral: Float): Float {
        if (values == null || values.isEmpty()) return neutral
        if (values.size == 1) return values[0]
        val x = (if (p.isFinite()) p else 0.0).coerceIn(0.0, 1.0) * (values.size - 1)
        val i = min(floor(x).toInt(), values.size - 2)
        val f = x - i
        return (values[i] + (values[i + 1] - values[i]) * f).toFloat()
    }

    /** The whole look at [p] - `lookAt` - every absent curve at its neutral value. */
    fun lookAt(curves: TransitionCurves, p: Double): TransitionLook = TransitionLook(
        alpha = sample(curves.alpha, p, 1f),
        reveal = sample(curves.reveal, p, 1f),
        from = sideAt(curves.from, p),
        to = sideAt(curves.to, p),
    )

    private fun sideAt(curves: TransitionSideCurves?, p: Double): SideLook {
        if (curves == null) return SideLook.NEUTRAL
        val n = SideLook.NEUTRAL
        return SideLook(
            x = sample(curves.x, p, n.x),
            y = sample(curves.y, p, n.y),
            scale = sample(curves.scale, p, n.scale),
            rotation = sample(curves.rotation, p, n.rotation),
            blur = sample(curves.blur, p, n.blur),
            pixelate = sample(curves.pixelate, p, n.pixelate),
            split = sample(curves.split, p, n.split),
            gain = sample(curves.gain, p, n.gain),
            tint = sample(curves.tint, p, n.tint),
        )
    }

    /**
     * Where a window is at an instant of the OUTPUT timeline: `clamp((t - start) / length, 0, 1)`,
     * the contract's own definition. A window with no length is over the instant it starts.
     */
    fun progress(startUs: Long, durUs: Long, timeUs: Long): Double {
        if (durUs <= 0L) return if (timeUs < startUs) 0.0 else 1.0
        return ((timeUs - startUs).toDouble() / durUs.toDouble()).coerceIn(0.0, 1.0)
    }
}

/**
 * One frame of one side, reduced to the numbers the shader is handed - worked out on the CPU, once
 * per frame, so the fragment shader does per pixel only what has to be done per pixel.
 *
 * Every field is the contract's quantity in OUTPUT PIXELS, y down, so the shader's arithmetic reads
 * like `sideSource`, `maskMeasure` and `maskAlpha` in transitions.ts line for line. What is folded
 * here is only what does not depend on the pixel: an offset times the frame size, the sine and
 * cosine of the turn, the mask's reveal widened by its feather.
 */
class TransitionFrame(
    /**
     * False once the incoming clip's window has closed, and for a window with no length at all:
     * its frame passes through, made opaque. Never false for the outgoing side, nor for an
     * incoming frame stamped early - see [TransitionFrame.at] for why an early one is not "before".
     */
    val drawLook: Boolean,
    /** `(x * W, y * H)`: how far the side's frame has moved, in pixels, y down. */
    val offsetXPx: Float,
    val offsetYPx: Float,
    /** One over the side's scale, which is floored at a millionth as `sideSource` floors it. */
    val invScale: Float,
    /** Cosine and sine of the INVERSE turn, `-rotation`, in radians. */
    val turnCos: Float,
    val turnSin: Float,
    /** The mosaic cell in pixels; the shader snaps only when it is wider than one pixel. */
    val cellPx: Float,
    /** How far red and blue are pulled apart, in pixels. */
    val shiftPx: Float,
    /** The Gaussian's sigma in pixels; below [MIN_BLUR_SIGMA_PX] the blur passes are skipped. */
    val sigmaPx: Float,
    val gain: Float,
    val tintR: Float,
    val tintG: Float,
    val tintB: Float,
    val tintAmount: Float,
    /** What the side's coverage is multiplied by before the mask: `alpha` for TO, 1 for FROM. */
    val alpha: Float,
    /** [MASK_NONE], or the shape's index in [MaskShape]. */
    val maskShape: Int,
    /** `(cos angleDeg, sin angleDeg)`, the way a linear edge travels, y down. */
    val maskDirX: Float,
    val maskDirY: Float,
    /** `|W cos| + |H sin|`: the frame's extent along that direction. */
    val maskExtentPx: Float,
    val maskCount: Float,
    /** `r = reveal * (1 + 2 fw) - fw`: where the edge stands in the shape's own units. */
    val maskEdge: Float,
    /** `fw`, the feather already clamped to 0.0005..0.5. */
    val maskFeather: Float,
    val maskInvert: Boolean,
) {

    val blurs: Boolean get() = drawLook && sigmaPx >= MIN_BLUR_SIGMA_PX

    companion object {

        /** What [maskShape] holds when there is no mask to draw. */
        const val MASK_NONE = -1

        /**
         * The smallest blur worth two passes: a Gaussian this narrow moves a neighbouring pixel's
         * colour into this one by about three parts in ten thousand, which no 8-bit frame can show.
         */
        const val MIN_BLUR_SIGMA_PX = 0.25f

        /**
         * Taps each side of the centre in one run of the blur; 2 x 32 + 1 = 65 per run. The
         * shaders carry the same number as a constant, because GLSL ES 1.00 wants loop bounds that
         * are constant expressions.
         */
        const val BLUR_TAPS = 32

        /**
         * How far apart the blur's taps are, in pixels: one pixel, or wider when a pixel apart
         * would not reach three sigma, which holds all but 0.3 % of the weight.
         *
         * Never closer than a pixel, because a pixel apart is what makes the blur EXACT. A run of
         * taps a whole number of texels apart commutes with bilinear sampling, so the vertical run
         * the main pass takes at an arbitrary point is precisely the bilinear sample of the
         * frame's discrete Gaussian there - the same numbers a CSS blur or the reference drawing
         * produce. Taps a fraction of a pixel apart would convolve the bilinear reconstruction
         * instead, a slightly wider blur that showed as up to nine levels of difference on fine
         * detail at a sigma under a pixel when this was checked against the reference.
         */
        fun blurTapStepPx(sigmaPx: Float): Float = max(1f, 3f * sigmaPx / BLUR_TAPS)

        /**
         * `(step / sigma)^2`, the one number the shaders build the weights from: tap k weighs
         * `exp(-(k step)^2 / 2 sigma^2)`, which is `exp(-falloff k^2 / 2)`.
         */
        fun blurTapFalloff(sigmaPx: Float): Float {
            val ratio = blurTapStepPx(sigmaPx) / sigmaPx
            return ratio * ratio
        }

        /**
         * The frame a side draws at [timeUs] on the OUTPUT timeline, for a window that opens at
         * [startUs] and runs [durUs], on a [width] x [height] frame.
         *
         * The incoming side draws its look until the window CLOSES. From then on the clip is simply
         * itself, and it is drawn opaque - its letterbox bars black instead of transparent - so
         * that nothing underneath could show through them even on the frame where the compositor's
         * nearest-timestamp pairing puts the tail's last frame, still inside its own window and so
         * still let through by the gate, under it.
         *
         * There is no "before the window" for the incoming side, only EARLY. Its effect rides on
         * the incoming clip's own item and nothing else, and that item starts the window by
         * construction, so a frame it is handed with a stamp short of [startUs] is the window's
         * first frame stamped a little soon - never footage from before the window. Real files do
         * this: Media3 stamps each item from the sum of the ACTUAL lengths of the items ahead of it,
         * and those come up a hair short of the plan's prefix sums wherever a ClippingMediaSource
         * clamps an untrimmed clip's end to the real stream (a MediaMetadataRetriever probe is
         * rounded to the nearest millisecond, so the plan's end can sit up to half of one past it)
         * or a speed change rounds. Read as outside the window, that first frame came out opaque:
         * the whole incoming clip for one frame at the very start of a dissolve, gone again on the
         * next. Read at progress 0 - the clamp in [TransitionMath.progress] - it is exactly the
         * window's first frame, however early it was stamped, so there is no tolerance to tune.
         *
         * The outgoing side is a tail item that exists only for its lead and its window, so it
         * draws its look on every frame it has, and the same clamp holds it at both ends: at
         * progress 0 through the lead, and at progress 1 for a frame stamped at or past the window's
         * end, whatever rounding put it there - never passed through as the outgoing clip unmoved,
         * which is what [opaque] would draw on a tail. Whether such a frame is SHOWN at all is the
         * compositor's gate's call, from [RenderPlan.tailAt], not this one's.
         *
         * A window with no length has nothing to draw, so the incoming side passes through opaque
         * throughout. The plan never builds one; this keeps a caller that does from reading an
         * early frame at progress 0, which for a fade would hide it outright.
         */
        fun at(
            role: TransitionRole,
            transition: Transition,
            startUs: Long,
            durUs: Long,
            timeUs: Long,
            width: Int,
            height: Int,
        ): TransitionFrame {
            if (role == TransitionRole.TO && (durUs <= 0L || timeUs >= startUs + durUs)) return opaque()
            val look = TransitionMath.lookAt(transition.curves, TransitionMath.progress(startUs, durUs, timeUs))
            val side = if (role == TransitionRole.FROM) look.from else look.to
            val tint = (if (role == TransitionRole.FROM) transition.fromTint else transition.toTint) ?: BLACK
            val w = width.toFloat()
            val h = height.toFloat()
            val shorter = min(w, h)
            val turn = -side.rotation.toDouble() * PI / 180.0
            val mask = if (role == TransitionRole.TO) transition.mask else null
            val angle = (mask?.angleDeg ?: 0f).toDouble() * PI / 180.0
            val dirX = cos(angle).toFloat()
            val dirY = sin(angle).toFloat()
            val feather = (mask?.feather ?: DEFAULT_FEATHER).coerceIn(MIN_FEATHER, MAX_FEATHER)
            return TransitionFrame(
                drawLook = true,
                offsetXPx = side.x * w,
                offsetYPx = side.y * h,
                invScale = 1f / (if (side.scale > MIN_SCALE) side.scale else MIN_SCALE),
                turnCos = cos(turn).toFloat(),
                turnSin = sin(turn).toFloat(),
                cellPx = if (side.pixelate > 0f) side.pixelate * shorter else 0f,
                shiftPx = side.split * w,
                sigmaPx = side.blur * shorter,
                gain = side.gain,
                tintR = tint[0],
                tintG = tint[1],
                tintB = tint[2],
                tintAmount = side.tint,
                alpha = if (role == TransitionRole.TO) look.alpha else 1f,
                maskShape = mask?.shape?.ordinal ?: MASK_NONE,
                maskDirX = dirX,
                maskDirY = dirY,
                maskExtentPx = abs(w * dirX) + abs(h * dirY),
                maskCount = (mask?.count ?: 1).coerceAtLeast(1).toFloat(),
                maskEdge = look.reveal.coerceIn(0f, 1f) * (1f + 2f * feather) - feather,
                maskFeather = feather,
                maskInvert = mask?.invert == true,
            )
        }

        private fun opaque() = TransitionFrame(
            drawLook = false,
            offsetXPx = 0f,
            offsetYPx = 0f,
            invScale = 1f,
            turnCos = 1f,
            turnSin = 0f,
            cellPx = 0f,
            shiftPx = 0f,
            sigmaPx = 0f,
            gain = 1f,
            tintR = 0f,
            tintG = 0f,
            tintB = 0f,
            tintAmount = 0f,
            alpha = 1f,
            maskShape = MASK_NONE,
            maskDirX = 1f,
            maskDirY = 0f,
            maskExtentPx = 1f,
            maskCount = 1f,
            maskEdge = 1f,
            maskFeather = DEFAULT_FEATHER,
            maskInvert = false,
        )

        private val BLACK = floatArrayOf(0f, 0f, 0f)
        private const val MIN_SCALE = 1e-6f
        private const val DEFAULT_FEATHER = 0.01f
        private const val MIN_FEATHER = 0.0005f
        private const val MAX_FEATHER = 0.5f
    }
}
