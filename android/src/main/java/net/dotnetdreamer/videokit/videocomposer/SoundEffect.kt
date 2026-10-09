package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.pow
import kotlin.math.sin
import kotlin.math.sqrt
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

    /**
     * A room: a tail that falls 60 dB in [decayMs] with its highs damped from [dampHz], and out of it
     * [dry] of the sound and [wet] of the tail. Each channel gets a room of its own, a little longer
     * the further along the frame it is, which is what makes a stereo tail wide.
     */
    data class Reverb(val decayMs: Double, val dampHz: Double, val wet: Double, val dry: Double) : SoundOp
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
        // Each made with its own number, the channel `k` the contract counts from 0 in the frame's
        // order - the folded sound is 0. Only a reverb asks it.
        while (chains.size <= index) {
            val k = chains.size
            chains += effect.ops.map { stepFor(it, sampleRate, k) }
        }
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

    /**
     * The reverb, exactly as `ComposeSoundEffect` writes it down and `Reverb` in sound-effects.ts runs
     * it, expression for expression: Freeverb's eight combs side by side, then its four allpasses one
     * after another, every comb tuned to fall 60 dB in the same time and fed in proportion, so the
     * room's length and its level are two separate numbers. Its buffers are made here, once - 13,701
     * doubles, some 110 KB, a channel at 48 kHz - and a sample only reads and writes them.
     */
    private class Reverb(op: SoundOp.Reverb, rate: Int, channel: Int) : Step {
        private val wet = op.wet
        private val dry = op.dry
        private val combs: Array<DoubleArray>
        private val combAt: IntArray

        /** Each comb's `g` and `c`, and its damped value `f`. */
        private val feedback: DoubleArray
        private val take: DoubleArray
        private val damped: DoubleArray
        private val allpasses: Array<DoubleArray>
        private val allpassAt: IntArray
        private val d: Double
        private val undamped: Double

        init {
            val combLengths = IntArray(COMB_TUNING.size) { delay(COMB_TUNING[it], rate, channel) }
            combs = Array(combLengths.size) { DoubleArray(combLengths[it]) }
            combAt = IntArray(combLengths.size)
            feedback = DoubleArray(combLengths.size) { 10.0.pow((-3 * combLengths[it]) / ((rate * op.decayMs) / 1000)) }
            take = DoubleArray(feedback.size) { sqrt((1 - feedback[it] * feedback[it]) / 8) }
            damped = DoubleArray(combLengths.size)
            allpasses = Array(ALLPASS_TUNING.size) { DoubleArray(delay(ALLPASS_TUNING[it], rate, channel)) }
            allpassAt = IntArray(ALLPASS_TUNING.size)
            d = exp(-2 * PI * min(op.dampHz, MAX_HZ_OF_RATE * rate) / rate)
            undamped = 1 - d
        }

        override fun run(x: Double): Double {
            var r = 0.0
            for (i in combs.indices) {
                val buffer = combs[i]
                val p = combAt[i]
                val o = buffer[p]
                var f = undamped * o + d * damped[i]
                if (f < TINY && f > -TINY) f = 0.0
                damped[i] = f
                var stored = take[i] * x + feedback[i] * f
                if (stored < TINY && stored > -TINY) stored = 0.0
                buffer[p] = stored
                combAt[i] = if (p + 1 == buffer.size) 0 else p + 1
                r = r + o
            }
            for (j in allpasses.indices) {
                val buffer = allpasses[j]
                val p = allpassAt[j]
                val b = buffer[p]
                var v = r + 0.5 * b
                if (v < TINY && v > -TINY) v = 0.0
                buffer[p] = v
                r = b - 0.5 * v
                allpassAt[j] = if (p + 1 == buffer.size) 0 else p + 1
            }
            return dry * x + wet * r
        }
    }

    private companion object {
        /**
         * Under this a filter's state, the drive's level, a comb's `f` and every value a reverb stores
         * is set to 0, so silence never goes denormal and a room's tail ends in exact zeros.
         */
        const val TINY = 1e-20

        /** The quietest level the drive measures a sound against: -50 dBFS. */
        val DRIVE_FLOOR = 10.0.pow(-50.0 / 20.0)

        /** The highest a filter's frequency goes, as a fraction of the rate. */
        const val MAX_HZ_OF_RATE = 0.45

        /** Jezar's Freeverb tunings, in samples at [TUNING_RATE]: the combs' delays, then the allpasses'. */
        val COMB_TUNING = intArrayOf(1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617)
        val ALLPASS_TUNING = intArrayOf(556, 441, 341, 225)
        const val TUNING_RATE = 44_100

        /** How many samples, at [TUNING_RATE], each channel's delays are longer than the one before it's. */
        const val STEREO_SPREAD = 23

        /** The step [op] stands for at [rate], on the channel numbered [channel] - which only a reverb asks. */
        fun stepFor(op: SoundOp, rate: Int, channel: Int): Step = when (op) {
            is SoundOp.Drive -> Drive(
                10.0.pow(op.db / 20.0),
                op.followMs?.let { exp(-1000.0 / (it * rate)) },
            )
            is SoundOp.Gain -> Gain(10.0.pow(op.db / 20.0))
            is SoundOp.Reverb -> Reverb(op, rate, channel)
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

        /**
         * A Freeverb delay of [tuning] samples at [TUNING_RATE] as samples at [rate], on [channel]:
         * `n(t)` in the contract. In doubles from the integer sum on, as the TypeScript counts, so a
         * rate times a long delay cannot overflow and every engine rounds the same number.
         */
        fun delay(tuning: Int, rate: Int, channel: Int): Int =
            max(1, floor((tuning + STEREO_SPREAD * channel).toDouble() * rate / TUNING_RATE + 0.5).toInt())
    }
}
