package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.tanh

/**
 * What a sound is put through - `ComposeSoundEffect` in definitions.ts, as the parser leaves it:
 * every number held to its range, and null in [Music.effect] for an effect that would do nothing.
 *
 * JS names the effects and lowers each one to these steps (`SOUND_EFFECTS` in
 * `src/editor/sound-effects.ts`), so this engine knows nothing about a megaphone: [SoundEffectChain]
 * runs the steps, which is the overlay motion's precedent and the reason the preview, the web export
 * and this one cannot disagree about how one sounds.
 */
data class SoundEffect(
    /** Fold the channels into one before the steps, and play the result from every channel. */
    val mono: Boolean,
    val ops: List<SoundOp>,
) {
    companion object {
        /** `MAX_SOUND_OPS` in definitions.ts: a spec with more is refused rather than cut short. */
        const val MAX_OPS = 16
    }
}

/** One step of a [SoundEffect]. Doubles, because the TypeScript that chose them counts in doubles. */
sealed interface SoundOp {
    data class Highpass(val hz: Double, val q: Double) : SoundOp
    data class Lowpass(val hz: Double, val q: Double) : SoundOp
    data class Peak(val hz: Double, val q: Double, val db: Double) : SoundOp

    /** Soft clipping by [db]; measured against the sound's own recent peak when [followMs] is set. */
    data class Drive(val db: Double, val followMs: Double?) : SoundOp
    data class Gain(val db: Double) : SoundOp
}

/**
 * A [SoundEffect] running on a stream of sound at [sampleRate], one frame at a time: the arithmetic
 * `ComposeSoundEffect` sets down, line for line as `SoundEffectRunner` in sound-effects.ts runs it, in
 * doubles throughout. It keeps its state from one frame to the next; a new pass of a sound is a new
 * chain, as Media3 makes a new item of every pass.
 */
class SoundEffectChain(private val effect: SoundEffect, private val sampleRate: Int) {

    /** One chain for a folded sound, else one per channel, made as each channel is first seen. */
    private val chains = ArrayList<List<Step>>()

    /** Puts one frame - a sample per channel, in -1..1 - through the effect, in place. */
    fun processFrame(frame: DoubleArray) {
        val n = frame.size
        if (n == 0) return
        if (effect.mono) {
            var sum = 0.0
            for (c in 0 until n) sum += frame[c]
            val y = held(run(chain(0), sum / n))
            for (c in 0 until n) frame[c] = y
            return
        }
        for (c in 0 until n) frame[c] = held(run(chain(c), frame[c]))
    }

    private fun chain(index: Int): List<Step> {
        while (chains.size <= index) chains += effect.ops.map { stepFor(it, sampleRate) }
        return chains[index]
    }

    private fun run(chain: List<Step>, input: Double): Double {
        var x = input
        for (step in chain) x = step.run(x)
        return x
    }

    private fun held(y: Double): Double = if (y > 1.0) 1.0 else if (y < -1.0) -1.0 else y

    private interface Step {
        fun run(x: Double): Double
    }

    /** One cookbook biquad in transposed direct form II, its coefficients already divided by `a0`. */
    private class Biquad(
        private val b0: Double,
        private val b1: Double,
        private val b2: Double,
        private val a1: Double,
        private val a2: Double,
    ) : Step {
        private var z1 = 0.0
        private var z2 = 0.0

        override fun run(x: Double): Double {
            val y = b0 * x + z1
            val n1 = b1 * x - a1 * y + z2
            val n2 = b2 * x - a2 * y
            // Both at once or neither, as the contract says: one zeroed alone holds the recurrence
            // just over the line for ever instead of letting it fall silent.
            if (n1 < TINY && n1 > -TINY && n2 < TINY && n2 > -TINY) {
                z1 = 0.0
                z2 = 0.0
            } else {
                z1 = n1
                z2 = n2
            }
            return y
        }
    }

    private class Drive(
        private val g: Double,
        /** The level's fall per sample, or null for a drive measured against full scale. */
        private val decay: Double?,
    ) : Step {
        private var level = 0.0

        override fun run(x: Double): Double {
            if (decay == null) return tanh(g * x)
            val a = if (x < 0.0) -x else x
            var next = if (a > level) a else level * decay
            if (next < TINY) next = 0.0
            level = next
            val e = if (next > DRIVE_FLOOR) next else DRIVE_FLOOR
            return e * tanh(g * x / e)
        }
    }

    private class Gain(private val g: Double) : Step {
        override fun run(x: Double): Double = g * x
    }

    private companion object {
        /** Under this a filter's state or the drive's level is set to 0, so silence never goes denormal. */
        const val TINY = 1e-20

        /** The quietest level the drive measures a sound against: -50 dBFS. */
        val DRIVE_FLOOR = 10.0.pow(-50.0 / 20.0)

        /** The highest a filter's frequency goes, as a fraction of the rate. */
        const val MAX_HZ_OF_RATE = 0.45

        fun stepFor(op: SoundOp, rate: Int): Step = when (op) {
            is SoundOp.Drive -> Drive(
                10.0.pow(op.db / 20.0),
                op.followMs?.let { exp(-1000.0 / (it * rate)) },
            )
            is SoundOp.Gain -> Gain(10.0.pow(op.db / 20.0))
            is SoundOp.Highpass -> {
                val (cosW, alpha) = corner(op.hz, op.q, rate)
                biquad((1 + cosW) / 2, -(1 + cosW), (1 + cosW) / 2, 1 + alpha, -2 * cosW, 1 - alpha)
            }
            is SoundOp.Lowpass -> {
                val (cosW, alpha) = corner(op.hz, op.q, rate)
                biquad((1 - cosW) / 2, 1 - cosW, (1 - cosW) / 2, 1 + alpha, -2 * cosW, 1 - alpha)
            }
            is SoundOp.Peak -> {
                val (cosW, alpha) = corner(op.hz, op.q, rate)
                val a = 10.0.pow(op.db / 40.0)
                biquad(1 + alpha * a, -2 * cosW, 1 - alpha * a, 1 + alpha / a, -2 * cosW, 1 - alpha / a)
            }
        }

        /** `cos w0` and `alpha` for a filter at [hz], held under [MAX_HZ_OF_RATE] of the rate. */
        fun corner(hz: Double, q: Double, rate: Int): Pair<Double, Double> {
            val w0 = 2 * PI * min(hz, MAX_HZ_OF_RATE * rate) / rate
            return cos(w0) to sin(w0) / (2 * q)
        }

        fun biquad(b0: Double, b1: Double, b2: Double, a0: Double, a1: Double, a2: Double): Biquad =
            Biquad(b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0)
    }
}
