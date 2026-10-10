package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.PI
import kotlin.math.atan2
import kotlin.math.cos
import kotlin.math.exp
import kotlin.math.floor
import kotlin.math.ln
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

    /**
     * The pitch moved by [semitones] and, apart from it, the resonances - what makes a voice a man's or
     * a woman's - by [formant], a frame of 40 ms at a time and that much late.
     */
    data class Pitch(val semitones: Double, val formant: Double) : SoundOp
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

    /**
     * The pitch step, exactly as `ComposeSoundEffect` writes it down and `Pitch` in sound-effects.ts
     * runs it, expression for expression: a phase vocoder that moves every peak of the spectrum to its
     * new pitch with the bins around it locked to it, and weighs each by the spectrum's envelope where
     * it lands, so a voice's resonances move by its formant whatever the pitch does. Its buffers are
     * made here, once - some 160 KB at 48 kHz - and a sample only reads and writes them.
     */
    private class Pitch(op: SoundOp.Pitch, rate: Int) : Step {
        private val ratio = 2.0.pow(op.semitones / 12)
        private val formant = 2.0.pow(op.formant / 12)
        private val hop = max(1, floor(rate / 100.0 + 0.5).toInt())
        private val length = 4 * hop
        private val size = transformSize(length)
        private val half = size / 2

        /** How many bins either side a peak has to be the loudest of to mark the envelope. */
        private val reach = max(1, floor(ENVELOPE_REACH_HZ * size / rate + 0.5).toInt())

        /** `sqrt(ratio / formant)`: what keeps the sound as loud with its peaks spread or crowded. */
        private val loudness = sqrt(ratio / formant)

        /** What a bin's centre frequency turns through in a hop, per bin. */
        private val turn = 2 * PI * hop / size
        private val window = DoubleArray(length) { 0.5 - 0.5 * cos(2 * PI * it / length) }

        /** The window again, with the transform's and the overlap's scale in it. */
        private val synthesis = DoubleArray(length) { window[it] / (size * HANN_OVERLAP) }
        private val cosTable = DoubleArray(half) { cos(2 * PI * it / size) }
        private val sinTable = DoubleArray(half) { sin(2 * PI * it / size) }

        /** The last [length] inputs, the oldest at [at]. */
        private val input = DoubleArray(length)
        private var at = 0

        /** Inputs since the last frame. */
        private var count = 0

        /** The overlap-add, from the oldest sample a frame still reaches; and the [hop] it finished last. */
        private val sum = DoubleArray(length)
        private val ready = DoubleArray(hop)
        private val re = DoubleArray(size)
        private val im = DoubleArray(size)

        /** The frame before's spectrum, as it was read and as it was made, bins 0 to [half]. */
        private val lastRe = DoubleArray(half + 1)
        private val lastIm = DoubleArray(half + 1)
        private var outRe = DoubleArray(half + 1)
        private var outIm = DoubleArray(half + 1)
        private var lastOutRe = DoubleArray(half + 1)
        private var lastOutIm = DoubleArray(half + 1)
        private val power = DoubleArray(half + 1)
        private val peaks = IntArray(half + 1)

        /** The peaks that mark the envelope, and the log of each one's power. */
        private val marks = IntArray(half + 1)
        private val levels = DoubleArray(half + 1)
        private var markCount = 0

        override fun run(x: Double): Double {
            input[at] = x
            at = if (at + 1 == length) 0 else at + 1
            count++
            if (count == hop) {
                count = 0
                frame()
            }
            return ready[count]
        }

        private fun frame() {
            val mid = length / 2
            // The frame turned so its middle is the transform's first sample: a peak's neighbours then
            // carry its phase rather than a turn each, which is what lets them follow it.
            re.fill(0.0)
            im.fill(0.0)
            var p = at
            for (n in 0 until length) {
                re[if (n < mid) size - mid + n else n - mid] = input[p] * window[n]
                p = if (p + 1 == length) 0 else p + 1
            }
            fft(re, im, cosTable, sinTable, false)

            for (k in 0..half) power[k] = re[k] * re[k] + im[k] * im[k]

            outRe.fill(0.0)
            outIm.fill(0.0)
            var peakCount = 0
            for (k in 1 until half) {
                val v = power[k]
                if (v > power[k - 1] && (k < 2 || v > power[k - 2]) && v >= power[k + 1] && (k + 2 > half || v >= power[k + 2])) {
                    peaks[peakCount++] = k
                }
            }
            // The envelope runs through the peaks nothing near them outshines - a voice's harmonics,
            // and not the ripples between them - straight from one to the next in decibels.
            var loudest = 0.0
            for (i in 0 until peakCount) if (power[peaks[i]] > loudest) loudest = power[peaks[i]]
            val quietest = loudest * ENVELOPE_FLOOR
            var markTotal = 0
            for (i in 0 until peakCount) {
                val k = peaks[i]
                val v = power[k]
                if (v < quietest) continue
                val a = if (k - reach > 0) k - reach else 0
                val b = if (k + reach < half) k + reach else half
                var top = true
                for (m in a..b) {
                    if (power[m] > v) {
                        top = false
                        break
                    }
                }
                if (top) {
                    marks[markTotal] = k
                    levels[markTotal] = ln(v)
                    markTotal++
                }
            }
            markCount = markTotal
            // Each peak takes the bins from the last one's edge to the quietest bin before the next.
            var from = 1
            for (i in 0 until peakCount) {
                val k = peaks[i]
                var to = half - 1
                if (i + 1 < peakCount) {
                    val next = peaks[i + 1]
                    to = k + 1
                    for (b in k + 2 until next) if (power[b] < power[to]) to = b
                }
                move(k, from, to)
                from = to + 1
            }

            for (k in 0..half) {
                lastRe[k] = re[k]
                lastIm[k] = im[k]
            }
            re.fill(0.0)
            im.fill(0.0)
            for (k in 1 until half) {
                re[k] = outRe[k]
                im[k] = outIm[k]
                re[size - k] = outRe[k]
                im[size - k] = -outIm[k]
            }
            fft(re, im, cosTable, sinTable, true)
            for (n in 0 until length) sum[n] = sum[n] + re[if (n < mid) size - mid + n else n - mid] * synthesis[n]

            for (n in 0 until hop) ready[n] = sum[n]
            sum.copyInto(sum, 0, hop, length)
            sum.fill(0.0, length - hop, length)
            val madeRe = outRe
            val madeIm = outIm
            outRe = lastOutRe
            outIm = lastOutIm
            lastOutRe = madeRe
            lastOutIm = madeIm
        }

        /** Bins [from] to [to], the region of the peak at bin [k], moved to where its pitch goes. */
        private fun move(k: Int, from: Int, to: Int) {
            val phase = atan2(im[k], re[k])
            var d = phase - atan2(lastIm[k], lastRe[k]) - k * turn
            d -= 2 * PI * floor(d / (2 * PI) + 0.5)
            // Its true frequency, in bins, from how far its phase turned since the frame before.
            val bin = k + d / turn
            val shift = floor(bin * (ratio - 1) + 0.5).toInt()
            val j = k + shift
            if (j < 1 || j >= half) return
            // Carried on from the phase the frame before left at its new bin, so a held note stays one note.
            val previousRe = lastOutRe[j]
            val previousIm = lastOutIm[j]
            val theta = if (previousRe != 0.0 || previousIm != 0.0) atan2(previousIm, previousRe) + bin * ratio * turn - phase else 0.0
            // As loud as the envelope is where its resonances have moved to, against where it came from.
            val lift = exp(0.5 * (level(j / formant) - level(k.toDouble()))) * loudness
            val g = if (lift > PITCH_MAX_GAIN) PITCH_MAX_GAIN else if (lift < 1 / PITCH_MAX_GAIN) 1 / PITCH_MAX_GAIN else lift
            val c = g * cos(theta)
            val s = g * sin(theta)
            for (i in from..to) {
                val target = i + shift
                if (target < 1 || target >= half) continue
                val xr = re[i]
                val xi = im[i]
                outRe[target] = outRe[target] + (xr * c - xi * s)
                outIm[target] = outIm[target] + (xr * s + xi * c)
            }
        }

        /**
         * The log of the envelope's power at bin [at], which need not be whole: straight between the
         * marks either side of it, the nearest one's own beyond the first and the last, and 0 with no
         * mark at all.
         */
        private fun level(at: Double): Double {
            val total = markCount
            if (total == 0) return 0.0
            if (at <= marks[0]) return levels[0]
            if (at >= marks[total - 1]) return levels[total - 1]
            var lo = 0
            var hi = total - 1
            while (hi - lo > 1) {
                val m = (lo + hi) shr 1
                if (marks[m] <= at) lo = m else hi = m
            }
            val t = (at - marks[lo]) / (marks[hi] - marks[lo])
            return levels[lo] + t * (levels[hi] - levels[lo])
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

        /** A peak marks the pitch step's envelope when no bin this close to it, in Hz, is louder... */
        const val ENVELOPE_REACH_HZ = 100.0

        /** ...and when it is no more than 60 dB, in power, under the frame's loudest peak. */
        const val ENVELOPE_FLOOR = 1e-6

        /** The most the pitch step's envelope lifts a peak by, 20 dB, and lowers one by. */
        const val PITCH_MAX_GAIN = 10.0

        /** What a frame's spectrum loses to its two windows overlapping four times: a periodic Hann's squares sum to 1.5. */
        const val HANN_OVERLAP = 1.5

        /** The least power of two from [length], the pitch step's transform. */
        fun transformSize(length: Int): Int {
            var size = 2
            while (size < length) size *= 2
            return size
        }

        /**
         * The discrete Fourier transform of `re + i im`, in place, as `fft` in sound-effects.ts:
         * radix 2, its length a power of two, with tables of `cos` and `sin` of `2 * PI * k / length`
         * for the first half of `k`. Forward turns by `e^-i`, inverse by `e^+i`, and neither scales.
         */
        fun fft(re: DoubleArray, im: DoubleArray, cosTable: DoubleArray, sinTable: DoubleArray, inverse: Boolean) {
            val n = re.size
            var j = 0
            for (i in 1 until n) {
                var bit = n shr 1
                while ((j and bit) != 0) {
                    j = j xor bit
                    bit = bit shr 1
                }
                j = j xor bit
                if (i < j) {
                    val r = re[i]
                    re[i] = re[j]
                    re[j] = r
                    val m = im[i]
                    im[i] = im[j]
                    im[j] = m
                }
            }
            var width = 2
            while (width <= n) {
                val halfWidth = width / 2
                val step = n / width
                var i = 0
                while (i < n) {
                    for (k in 0 until halfWidth) {
                        val wr = cosTable[k * step]
                        val wi = if (inverse) sinTable[k * step] else -sinTable[k * step]
                        val a = i + k
                        val b = a + halfWidth
                        val xr = re[b] * wr - im[b] * wi
                        val xi = re[b] * wi + im[b] * wr
                        re[b] = re[a] - xr
                        im[b] = im[a] - xi
                        re[a] = re[a] + xr
                        im[a] = im[a] + xi
                    }
                    i += width
                }
                width *= 2
            }
        }

        /** The step [op] stands for at [rate], on the channel numbered [channel] - which only a reverb asks. */
        fun stepFor(op: SoundOp, rate: Int, channel: Int): Step = when (op) {
            is SoundOp.Pitch -> Pitch(op, rate)
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
