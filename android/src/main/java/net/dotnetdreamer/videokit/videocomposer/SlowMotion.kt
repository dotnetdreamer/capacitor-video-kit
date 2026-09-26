package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * Which instants a SLOWED clip is drawn at, and how far between its two neighbouring source frames
 * each one falls - the arithmetic half of [SlowMotionEffect], with nothing in it that needs a GL
 * context, so the JVM can pin it.
 *
 * Media3 retimes a slowed clip's frames and never invents one: 30 fps footage at 0.5x reaches the
 * encoder as 15 distinct pictures a second, at 0.3x as nine, and everything drawn over them - the
 * camera, the transition's move, the overlays - can only step when a picture arrives. This is the
 * schedule that fills the holes. Output instants are the source's FIRST frame plus whole output
 * intervals, and each one is drawn as `mix(A, B, w)`, A the last source frame at or before it, B the
 * first after it, `w` its fractional position between the two.
 *
 * WHY THE GRID STARTS AT THE FIRST FRAME rather than at the output's own zero. Any grid lands on the
 * source frames at some phase, and with a blend the phase is what the picture looks like: a grid
 * that lands on a source frame draws that frame sharp, and one that lands between two draws a double
 * exposure. Starting from the first frame puts the phase at 0, so at 0.5x every other output frame
 * IS a source frame and the ones between are even halves, and at 0.25x every fourth is. The output's
 * zero would put an arbitrary phase on every clip that does not start on a multiple of the interval,
 * which is nearly all of them, and make every frame of such a clip a blend. What it costs is one
 * uneven interval at each end of the clip, where the grid meets the clips either side - and those
 * intervals are already uneven today, the neighbours' frames falling wherever their sources put them.
 *
 * THE ENDS OF THE CLIP. Before the first source frame there is no A and after the last there is no
 * B, so those instants HOLD the frame there is:
 *
 *  - the LEAD, from the item's first instant up to its first frame, holds that first frame. A clip
 *    cut in between two source frames decodes its first picture up to a source frame late, which at
 *    0.3x is up to 111 ms of output, and until now the previous clip's last frame stood there - the
 *    cut landed that late, and nothing drawn over the picture moved. Held, the cut lands within one
 *    output interval of where the plan put it, and the camera and overlays keep stepping.
 *  - the TAIL, from the last frame to the item's end, holds the last frame, for the same two
 *    reasons in the other direction. It stops half an interval short of the item's end, so its last
 *    frame can never crowd the next item's first, whatever the next item's own grid.
 *
 * Every instant lies inside the item's own piece of the sequence's timeline - which is the output's,
 * because every sequence starts at 0 (see [TransitionEffect]) - so nothing drawn here can ever sort
 * among the neighbours' frames.
 *
 * A frame that does not come AFTER the one before it is passed over, never drawn: the pair would
 * have no width to put an instant in. A frame the caller says cannot be blended with the one before
 * it - a change of size mid-stream - starts over as if it were the first, without the lead.
 */
class SlowMotionCadence(
    /** Where the item's piece of the output timeline opens: its first frame may be held from here. */
    val windowStartUs: Long,
    /** Where it closes: the first instant that belongs to the next item. */
    val windowEndUs: Long,
    /** The spec's output frame rate - the cadence every slowed clip is brought up to. */
    fps: Int,
) {

    /** One output interval, in microseconds, unrounded: the grid is rounded per instant instead. */
    val intervalUs: Double = MICROS_PER_SECOND / max(1, fps)

    private var anchorUs = NONE
    private var nextIndex = 0L
    private var fromUs = NONE
    private var toUs = NONE

    /**
     * A source frame stamped [timeUs] has arrived. False when it has to be passed over - it does not
     * come after the frame before it - in which case nothing about the schedule has changed.
     */
    fun arrive(timeUs: Long, blendable: Boolean = true): Boolean {
        if (anchorUs == NONE) {
            anchorUs = timeUs
            // The first instant of this grid at or after the window's start. The guess can land one
            // off either way on rounding, and the loops settle it on the instant itself.
            nextIndex = ceil((windowStartUs - timeUs) / intervalUs).toLong()
            while (instantUs(nextIndex - 1) >= windowStartUs) nextIndex--
            while (instantUs(nextIndex) < windowStartUs) nextIndex++
            fromUs = NONE
            toUs = timeUs
            return true
        }
        if (timeUs <= toUs) return false
        fromUs = if (blendable) toUs else NONE
        toUs = timeUs
        return true
    }

    /**
     * The next instant to draw between the held frame and the one that just arrived - the arrival's
     * own instant included, when the grid lands on it - or [NONE] once every instant up to the
     * arrival has been drawn.
     */
    fun nextBetweenUs(): Long {
        if (toUs == NONE) return NONE
        val t = instantUs(nextIndex)
        return if (t <= toUs) t else NONE
    }

    /**
     * How far from the held frame (0) to the arriving one (1) the instant [timeUs] lies. Exactly 1
     * where there is no held frame to blend from - the lead, or a frame that could not be blended -
     * so the arrival is drawn as it is.
     */
    fun weightAt(timeUs: Long): Float {
        if (fromUs == NONE || timeUs >= toUs) return 1f
        if (timeUs <= fromUs) return 0f
        return ((timeUs - fromUs).toDouble() / (toUs - fromUs).toDouble()).toFloat()
    }

    /**
     * After the stream has ended: the next instant to hold the last frame at, or [NONE] once the
     * item is full. Asked only after every instant up to the last arrival has been drawn.
     */
    fun nextAfterEndUs(): Long {
        if (anchorUs == NONE) return NONE
        val t = instantUs(nextIndex)
        return if (t > toUs && t + intervalUs / 2.0 <= windowEndUs) t else NONE
    }

    /** The instant just handed out has been drawn. */
    fun advance() {
        nextIndex++
    }

    /** Back to before the first frame, for a flush or a stream that starts over. */
    fun reset() {
        anchorUs = NONE
        nextIndex = 0L
        fromUs = NONE
        toUs = NONE
    }

    private fun instantUs(index: Long): Long = anchorUs + (index * intervalUs).roundToLong()

    companion object {
        /** "No instant": what the schedule answers when there is nothing to draw right now. */
        const val NONE = Long.MIN_VALUE

        private const val MICROS_PER_SECOND = 1_000_000.0
    }
}

/**
 * [SlowMotionEffect]'s shader program with the GL cut out: when to draw which frame, when to hand
 * the input back, and when to say the stream has ended - the half of it that has to honour Media3's
 * `GlShaderProgram` contract and so is worth pinning on the JVM, where a fake [Frames] stands in
 * for the textures.
 *
 * ONE INPUT AT A TIME. The arriving frame is the upstream program's texture, and it cannot be kept:
 * every program ahead of this one in 1.11.1 has an output pool of exactly one texture, so holding
 * on to it would stop the upstream from ever drawing the next. So the arrival is drawn into every
 * instant it is a neighbour of, COPIED into the one texture this program keeps ([Frames.keepArrival]),
 * and only then handed back ([Frames.releaseArrival]), which is also what asks for the next. The copy
 * is the price of a held frame, and one texture is the whole of the memory it costs.
 *
 * BACKPRESSURE. An instant is drawn only into a free output texture ([Frames.canDraw]); when there
 * is none the pump simply stops where it is, holding the arrival, and [outputFreed] - the downstream
 * handing a texture back - picks up exactly there. The upstream cannot run ahead meanwhile, because
 * it is only asked for the next frame once this one is done with.
 *
 * THE END. Media3 signals the end of the item's stream after its last frame has been QUEUED, which
 * is not the same as drawn: the last arrival may still be waiting for textures. So the end is noted,
 * the arrival finished first, then the tail held out to the item's end ([SlowMotionCadence]), and
 * only then is the end passed on - after the last frame, never before it.
 *
 * Nothing here calls back into itself: every listener Media3 hands a program queues its work on the
 * GL thread rather than running it inline, so a draw or a release cannot re-enter [pump] midway.
 */
internal class SlowMotionPump(
    private val cadence: SlowMotionCadence,
    private val frames: Frames,
) {

    /** What the pump asks of the textures. Every call is made on the GL thread. */
    interface Frames {
        /** Whether an output texture is free to draw the next instant into. */
        fun canDraw(): Boolean

        /** Draws [weight] of the way from the held frame to the arrival, stamped [timeUs], and hands it on. */
        fun drawBetween(timeUs: Long, weight: Float)

        /** Draws the arrival as it is, stamped [timeUs], and hands it on. */
        fun drawArrival(timeUs: Long)

        /** Draws the held frame as it is, stamped [timeUs], and hands it on. */
        fun drawHeld(timeUs: Long)

        /** Copies the arrival into the held frame's texture: it is the next pair's first neighbour. */
        fun keepArrival()

        /** Hands the arrival back to the upstream program and says another may come. */
        fun releaseArrival()

        /** Tells the downstream that the item's stream has ended. */
        fun endStream()
    }

    private var holding = false
    private var ending = false

    /** Counts for the log line at the end of the item: source frames in, frames drawn out. */
    var arrivals = 0
        private set
    var drawn = 0
        private set

    /** A source frame has been queued; the pump owns it until [Frames.releaseArrival]. */
    fun arrive(timeUs: Long, blendable: Boolean = true) {
        check(!holding) { "a frame arrived while the last one was still being drawn" }
        arrivals++
        if (!cadence.arrive(timeUs, blendable)) {
            // Not after the one before it: there is no instant it can be a neighbour of.
            frames.releaseArrival()
            return
        }
        holding = true
        pump()
    }

    /** The downstream has handed an output texture back. */
    fun outputFreed() = pump()

    /** No more frames will come for this item. */
    fun endOfStream() {
        ending = true
        pump()
    }

    /** Media3 has taken every texture back: forget the arrival, the held frame and the schedule. */
    fun flush() {
        holding = false
        ending = false
        cadence.reset()
    }

    private fun pump() {
        if (holding) {
            while (true) {
                val t = cadence.nextBetweenUs()
                if (t == SlowMotionCadence.NONE) break
                if (!frames.canDraw()) return
                val w = cadence.weightAt(t)
                when {
                    w >= 1f -> frames.drawArrival(t)
                    w <= 0f -> frames.drawHeld(t)
                    else -> frames.drawBetween(t, w)
                }
                drawn++
                cadence.advance()
            }
            holding = false
            frames.keepArrival()
            frames.releaseArrival()
        }
        if (ending) {
            while (true) {
                val t = cadence.nextAfterEndUs()
                if (t == SlowMotionCadence.NONE) break
                if (!frames.canDraw()) return
                frames.drawHeld(t)
                drawn++
                cadence.advance()
            }
            ending = false
            frames.endStream()
        }
    }
}
