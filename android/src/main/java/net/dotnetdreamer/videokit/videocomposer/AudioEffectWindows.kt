package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * One window of [Audio.effects] - `ComposeAudioEffect` in definitions.ts, as the parser leaves it: its
 * start held to 0 and up, its [speed] to [MIN_SPEED]..1, and a window that would change nothing left
 * out. It is one of the editor's audio effect layers: for [startMs]..[endMs] of the output the FINISHED
 * mix - every clip's own sound, every sound on every lane, every voiceover - is played at [speed] from
 * the window's start and put through [effect]'s steps, and nothing outside it is touched but the tail
 * those steps leave ringing. [AudioEffectRunner] is the arithmetic, [AudioEffectWindowsProcessor]
 * Media3's side of it.
 */
data class AudioEffectWindow(
    /** Output-timeline milliseconds. */
    val startMs: Double,
    /** Output-timeline milliseconds, after [startMs]. */
    val endMs: Double,
    /** [MIN_SPEED]..1: the mix from the window's start played this fast, lower as well as slower. */
    val speed: Double = 1.0,
    /** The steps, or null for a window that only slows. */
    val effect: SoundEffect?,
) {
    companion object {
        /** `MAX_AUDIO_EFFECTS` in definitions.ts: a spec with more is refused rather than cut short. */
        const val MAX_WINDOWS = 50

        /** `AUDIO_EFFECT_RAMP_MS`: how long a window takes to come in and to go out. */
        const val RAMP_MS = 30.0

        /** `AUDIO_EFFECT_MIN_TAIL_MS`: the least a window's steps run on after it. */
        const val MIN_TAIL_MS = 500.0

        /** `MIN_AUDIO_EFFECT_SPEED`: the slowest a window plays the mix. Its lag is what it holds, so a memory bound too. */
        const val MIN_SPEED = 0.5

        /**
         * How long [effect]'s steps ring on after a window, in ms: twice the longest reverb's `decayMs` -
         * 120 dB down, past anything a 16-bit file carries - and never under [MIN_TAIL_MS].
         */
        fun tailMs(effect: SoundEffect?): Double {
            var decayMs = 0.0
            for (op in effect?.ops.orEmpty()) if (op is SoundOp.Reverb) decayMs = max(decayMs, op.decayMs)
            return max(MIN_TAIL_MS, 2 * decayMs)
        }

        /** A time on the stream as a frame number, rounded half up as every engine rounds it. */
        fun frameAt(ms: Double, sampleRate: Int): Long = floor(ms * sampleRate / 1000 + 0.5).toLong()
    }
}

/**
 * Every window of a list running on a stream of sound at [sampleRate]: `ComposeAudioEffect`'s arithmetic,
 * frame for frame, as `AudioEffectRunner` in audio-effect-windows.ts runs it, line for line. Its buffers
 * are FLOATS where that one's are - the channels, a window's copy of what it is handed, what it puts
 * through the steps, what a slowed one remembers - so the two round in the same places and meet the
 * same golden numbers; everything between is doubles, as there, and the steps are [SoundEffectChain].
 *
 * The stream comes in order, in pieces of any size, and leaves exactly as it would in one; the first
 * frame of the first piece is output frame [firstFrame]. Each window runs on what the ones before it in
 * the list left - where they cover the same frames, that is the stack - and keeps what it has not yet
 * read of that: for a slowed window, what it has fallen behind.
 */
class AudioEffectRunner(
    windows: List<AudioEffectWindow>,
    sampleRate: Int,
    firstFrame: Long = 0L,
) {
    private val stages = windows.map { WindowStage(it, sampleRate) }
    private var frame = firstFrame

    /** How many frames of the mix, per channel, the slowed windows hold room for now. For the tests. */
    internal val heldFrames: Int get() = stages.sumOf { it.heldFrames }

    /** [count] frames of [channels] from [from] through every window, in place. Every channel is as long. */
    fun process(channels: Array<FloatArray>, from: Int = 0, count: Int = (channels.firstOrNull()?.size ?: 0) - from) {
        if (channels.isEmpty() || count <= 0) return
        for (stage in stages) stage.process(channels, from, count, frame)
        frame += count
    }
}

/** How many frames a window works through at a time: a bound on its scratch, nothing more. */
private const val BLOCK = 4096

/** One window of the list, with its own steps and its own memory of its input. */
private class WindowStage(window: AudioEffectWindow, sampleRate: Int) {
    val start = AudioEffectWindow.frameAt(window.startMs, sampleRate)
    val end = max(start, AudioEffectWindow.frameAt(window.endMs, sampleRate))

    /** Held at the last frame there is rather than wrapped, for a window that ends past any stream. */
    val tailEnd = AudioEffectWindow.frameAt(AudioEffectWindow.tailMs(window.effect), sampleRate)
        .let { tail -> if (end > Long.MAX_VALUE - tail) Long.MAX_VALUE else end + tail }
    private val ramp = min(AudioEffectWindow.frameAt(AudioEffectWindow.RAMP_MS, sampleRate), (end - start) / 2)
    private val speed = window.speed
    private val steps = window.effect?.let { SoundEffectChain(it, sampleRate) }
    private val slows = speed < 1.0

    /** The block's input, and what goes through the steps; one of each per channel, made at first use. */
    private var dry = emptyArray<FloatArray>()
    private var wet = emptyArray<FloatArray>()

    /** One frame for [steps], which take a frame at a time. */
    private var stepFrame = DoubleArray(0)

    /**
     * A slowed window's input, per channel: entry `i` is frame `historyFrom + i`, the first
     * [historyLength] entries are filled, and the first [historyDead] of those it will never read again.
     */
    private var history = emptyArray<FloatArray>()
    private var historyFrom = 0L
    private var historyLength = 0
    private var historyDead = 0

    val heldFrames: Int get() = history.firstOrNull()?.size ?: 0

    fun process(channels: Array<FloatArray>, from: Int, count: Int, at: Long) {
        if (dry.size != channels.size) allocate(channels.size)
        // A slowed window remembers the frame before it as well: its first frames read it.
        val first = max(at, if (slows) start - 1 else start)
        val last = min(at + count, tailEnd)
        var n = first
        while (n < last) {
            run(channels, from + (n - at).toInt(), n, min(BLOCK.toLong(), last - n).toInt())
            n += BLOCK
        }
    }

    private fun allocate(width: Int) {
        dry = Array(width) { FloatArray(BLOCK) }
        wet = Array(width) { FloatArray(BLOCK) }
        stepFrame = DoubleArray(width)
        history = if (slows) Array(width) { FloatArray(BLOCK) } else emptyArray()
        historyLength = 0
    }

    /** Frames `n until n + count` of the stream, which sit at [offset] in [channels]. */
    private fun run(channels: Array<FloatArray>, offset: Int, n: Long, count: Int) {
        val width = channels.size
        for (c in 0 until width) channels[c].copyInto(dry[c], 0, offset, offset + count)
        if (slows) remember(n, count)
        // The frame before the window is only remembered, never changed.
        val skip = max(0L, start - n).toInt()
        if (skip >= count) return

        for (j in skip until count) {
            val frame = n + j
            val g = gate(frame)
            for (c in 0 until width) {
                val w = if (frame >= end) 0.0 else if (slows) slowed(c, frame) else dry[c][j].toDouble()
                wet[c][j] = (g * w).toFloat()
            }
        }
        steps?.let { chain ->
            for (j in skip until count) {
                for (c in 0 until width) stepFrame[c] = wet[c][j].toDouble()
                chain.processFrame(stepFrame)
                for (c in 0 until width) wet[c][j] = stepFrame[c].toFloat()
            }
        }
        for (j in skip until count) {
            val keep = 1.0 - gate(n + j)
            for (c in 0 until width) channels[c][offset + j] = held(keep * dry[c][j] + wet[c][j]).toFloat()
        }
        if (slows) forget(n + count)
    }

    /** g(n): 0 at the start, up over the ramp, 1, down over the ramp to 0 at the end; 0 outside. */
    private fun gate(frame: Long): Double {
        if (frame < start || frame >= end) return 0.0
        if (ramp <= 0L) return 1.0
        val g = min(frame - start, end - frame).toDouble() / ramp
        return if (g < 1.0) g else 1.0
    }

    /** w(n) of a slowed window: the input read at `start + (n - start) * speed`, by Catmull-Rom. */
    private fun slowed(c: Int, frame: Long): Double {
        val position = start + (frame - start) * speed
        val k = floor(position)
        val t = position - k
        val at = k.toLong()
        val x0 = input(c, at - 1, frame)
        val x1 = input(c, at, frame)
        val x2 = input(c, at + 1, frame)
        val x3 = input(c, at + 2, frame)
        return x1 + 0.5 * t * (x2 - x0 + t * (2 * x0 - 5 * x1 + 4 * x2 - x3 + t * (3 * (x1 - x2) + x3 - x0)))
    }

    /**
     * x(k) as the slowed mix reads it: a frame after [now] reads [now], and one before 0 reads 0. A frame
     * before what is remembered - only for a stream handed over from inside the window - reads the
     * earliest there is.
     */
    private fun input(c: Int, k: Long, now: Long): Double {
        val frame = if (k > now) now else if (k < 0L) 0L else k
        val index = min(max(0L, frame - historyFrom), historyLength - 1L).toInt()
        return history[c][index].toDouble()
    }

    /** Keeps the block's input from the frame before the window to its end, for the slowed mix to read. */
    private fun remember(n: Long, count: Int) {
        val from = max(n, start - 1)
        val to = min(n + count, end)
        if (to <= from || history.isEmpty()) return
        if (historyLength == 0) {
            historyFrom = from
            historyDead = 0
        }
        val adding = (to - from).toInt()
        val capacity = history[0].size
        if (historyLength + adding > capacity) {
            // What it will never read again goes first, once that is half the room: the copy down is then
            // paid for by what it frees. Otherwise there is room to be made.
            if (2 * historyDead >= capacity) {
                for (channel in history) channel.copyInto(channel, 0, historyDead, historyLength)
                historyFrom += historyDead
                historyLength -= historyDead
                historyDead = 0
            }
            val needed = historyLength + adding
            if (needed > capacity) {
                val size = max(needed, 2 * capacity)
                history = Array(history.size) { c -> history[c].copyInto(FloatArray(size), 0, 0, historyLength) }
            }
        }
        for (c in history.indices) dry[c].copyInto(history[c], historyLength, (from - n).toInt(), (to - n).toInt())
        historyLength += adding
    }

    /** Marks what the slowed mix will never read again, from frame [next] on: everything before `k - 1`. */
    private fun forget(next: Long) {
        if (next >= end) {
            // Past the window nothing reads its input at all.
            history = emptyArray()
            historyLength = 0
            return
        }
        val oldest = floor(start + (next - start) * speed).toLong() - 1
        historyDead = max(0L, min(historyLength.toLong(), oldest - historyFrom)).toInt()
    }

    private fun held(y: Double): Double = if (y > 1.0) 1.0 else if (y < -1.0) -1.0 else y
}
