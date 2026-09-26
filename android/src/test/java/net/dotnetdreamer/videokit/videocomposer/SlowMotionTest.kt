package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.roundToLong

/**
 * The schedule a slowed clip is drawn on, and the protocol that feeds it to Media3, with the GL cut
 * out: which instants get a frame, how far between their neighbours each one lies, how the first and
 * last frames are held, and when the input is handed back and the stream is said to have ended.
 *
 * The frames are simulated as a source would deliver them after Media3's speed change: source frame
 * k of a `sourceFps` clip, played at `speed`, is stamped `start + k / sourceFps / speed` on the output
 * timeline, rounded to the microsecond the way Media3 stamps it.
 */
class SlowMotionTest {

    /** What the pump drew, in order, and what it did with the textures around it. */
    private data class Drawn(val timeUs: Long, val kind: String, val weight: Float)

    private class FakeFrames(var capacity: Int = Int.MAX_VALUE) : SlowMotionPump.Frames {
        val drawn = ArrayList<Drawn>()
        val events = ArrayList<String>()
        var lent = 0

        override fun canDraw(): Boolean = lent < capacity
        override fun drawBetween(timeUs: Long, weight: Float) = draw(Drawn(timeUs, "between", weight))
        override fun drawArrival(timeUs: Long) = draw(Drawn(timeUs, "arrival", 1f))
        override fun drawHeld(timeUs: Long) = draw(Drawn(timeUs, "held", 0f))
        override fun keepArrival() {
            events += "keep"
        }
        override fun releaseArrival() {
            events += "release"
        }
        override fun endStream() {
            events += "end"
        }

        private fun draw(d: Drawn) {
            check(lent < capacity) { "drew without a free texture" }
            lent++
            drawn += d
            events += "draw@${d.timeUs}"
        }

        /** The downstream hands one texture back. */
        fun free() {
            lent--
        }
    }

    /** The output-timeline stamps of a source's frames that fall inside `[startUs, endUs)` at [speed]. */
    private fun arrivals(startUs: Long, endUs: Long, speed: Double, sourceFps: Double = 30.0, phaseUs: Long = 0L): List<Long> {
        val out = ArrayList<Long>()
        var k = 0
        while (true) {
            val t = startUs + ((phaseUs + k * 1_000_000.0 / sourceFps) / speed).roundToLong()
            if (t >= endUs) break
            out += t
            k++
        }
        return out
    }

    /** Runs a whole item through a pump with unlimited textures, and hands back what was drawn. */
    private fun run(
        startUs: Long,
        endUs: Long,
        fps: Int,
        frames: List<Long>,
        blendable: (Int) -> Boolean = { true },
    ): Pair<List<Drawn>, FakeFrames> {
        val fake = FakeFrames()
        val pump = SlowMotionPump(SlowMotionCadence(startUs, endUs, fps), fake)
        for ((i, t) in frames.withIndex()) {
            pump.arrive(t, blendable(i))
            fake.lent = 0
        }
        pump.endOfStream()
        return fake.drawn to fake
    }

    /* ------------------------------------------------------------------------------------- */
    /* The schedule                                                                            */
    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `half speed doubles the frames, every other one a source frame and the rest even halves`() {
        val (drawn, _) = run(0L, 1_000_000L, 30, arrivals(0L, 1_000_000L, speed = 0.5))
        // 15 source frames a second become 30 output frames - the tail's hold of the last included.
        assertEquals(30, drawn.size)
        for ((i, d) in drawn.withIndex()) {
            assertEquals((i * 1_000_000.0 / 30).roundToLong(), d.timeUs)
        }
        // Source frames on the even instants, halves between them, and the last one held.
        for (i in 0 until 29) {
            if (i % 2 == 0) {
                assertEquals("arrival", drawn[i].kind)
            } else {
                assertEquals("between", drawn[i].kind)
                assertEquals(0.5f, drawn[i].weight, 1e-4f)
            }
        }
        assertEquals("held", drawn[29].kind)
    }

    @Test
    fun `at 0_3x each instant is weighted by where it falls between its two neighbours`() {
        val frames = arrivals(0L, 1_000_000L, speed = 0.3)
        // 9 source frames a second, 111 ms apart on the output.
        assertEquals(9, frames.size)
        val (drawn, _) = run(0L, 1_000_000L, 30, frames)
        assertEquals(30, drawn.size)
        for (d in drawn) {
            if (d.kind != "between") continue
            val b = frames.first { it > d.timeUs }
            val a = frames.last { it <= d.timeUs }
            assertEquals((d.timeUs - a).toFloat() / (b - a), d.weight, 1e-4f)
            assertTrue(d.weight > 0f && d.weight < 1f)
        }
        // The first instants after the first frame: 0.3 of the pair's width each, the pair being
        // 111 ms wide and the output interval 33 ms.
        assertEquals(0.3f, drawn[1].weight, 1e-4f)
        assertEquals(0.6f, drawn[2].weight, 1e-4f)
        assertEquals(0.9f, drawn[3].weight, 1e-4f)
    }

    @Test
    fun `a slowed clip comes out at the output cadence, one interval apart, whatever the speed`() {
        for (speed in listOf(0.25, 0.3, 0.4, 0.5, 0.6, 0.93)) {
            val startUs = 2_345_678L
            val endUs = startUs + 1_500_000L
            val frames = arrivals(startUs, endUs, speed)
            val (drawn, _) = run(startUs, endUs, 30, frames)
            val gaps = drawn.zipWithNext { a, b -> b.timeUs - a.timeUs }
            // Regular to the rounding of a microsecond: 33_333 or 33_334.
            assertTrue("speed $speed: $gaps", gaps.all { it == 33_333L || it == 33_334L })
            // Distinct frames a second: the output's rate, where the source gave speed x 30.
            val perSecond = drawn.size * 1_000_000.0 / 1_500_000.0
            assertTrue("speed $speed: $perSecond", abs(perSecond - 30.0) <= 1.0)
        }
    }

    @Test
    fun `other output rates are honoured`() {
        for (fps in listOf(24, 25, 60)) {
            val frames = arrivals(0L, 2_000_000L, speed = 0.25)
            val (drawn, _) = run(0L, 2_000_000L, fps, frames)
            val interval = 1_000_000.0 / fps
            val gaps = drawn.zipWithNext { a, b -> b.timeUs - a.timeUs }
            assertTrue("$fps: $gaps", gaps.all { abs(it - interval) <= 1.0 })
            // Two seconds at the output's rate, the last instant held out to the end.
            assertEquals(fps * 2, drawn.size)
        }
    }

    @Test
    fun `the grid starts at the first frame, so a clip cut between two source frames still draws them sharp`() {
        // The first frame lands 80 ms into the item - a clip cut 24 ms into a source frame at 0.3x.
        val startUs = 1_000_000L
        val endUs = 2_000_000L
        val frames = arrivals(startUs, endUs, speed = 0.3, phaseUs = 24_000L)
        assertEquals(1_080_000L, frames[0])
        val (drawn, _) = run(startUs, endUs, 30, frames)
        // The LEAD: the first frame held back to the first instant of its grid inside the item,
        // which is within one interval of the item's start - where the cut belongs.
        assertEquals(1_013_333L, drawn[0].timeUs)
        assertEquals(1_046_667L, drawn[1].timeUs)
        assertEquals("arrival", drawn[0].kind)
        assertEquals("arrival", drawn[1].kind)
        // Then the first frame on its own instant, as it is.
        assertEquals(Drawn(1_080_000L, "arrival", 1f), drawn[2])
        assertTrue(drawn[0].timeUs - startUs < 33_334L)
    }

    @Test
    fun `nothing is ever stamped outside the item, and the last frame stops half an interval short`() {
        for (speed in listOf(0.25, 0.3, 0.5)) {
            val startUs = 7_830_000L
            val endUs = 9_500_123L
            val (drawn, _) = run(startUs, endUs, 30, arrivals(startUs, endUs, speed, phaseUs = 11_000L))
            assertTrue(drawn.first().timeUs >= startUs)
            assertTrue(drawn.last().timeUs + 33_333L / 2 <= endUs)
            // ... and no more than an interval and a half short, so the tail is filled.
            assertTrue(endUs - drawn.last().timeUs <= 50_000L)
        }
    }

    @Test
    fun `the tail holds the last frame out to the end of the item`() {
        // A 0.25x clip whose last source frame lands 120 ms before its end.
        val frames = listOf(0L, 133_333L, 266_667L, 400_000L)
        val (drawn, _) = run(0L, 520_000L, 30, frames)
        val after = drawn.filter { it.timeUs > 400_000L }
        assertEquals(listOf(433_333L, 466_667L, 500_000L), after.map { it.timeUs })
        assertTrue(after.all { it.kind == "held" })
    }

    @Test
    fun `a frame that does not come after the one before it is passed over, never drawn`() {
        val fake = FakeFrames()
        val pump = SlowMotionPump(SlowMotionCadence(0L, 1_000_000L, 30), fake)
        pump.arrive(0L)
        pump.arrive(133_333L)
        val before = fake.drawn.size
        pump.arrive(133_333L)
        pump.arrive(100_000L)
        assertEquals(before, fake.drawn.size)
        // Both were handed straight back, and neither was kept as a neighbour.
        assertEquals(listOf("release", "release"), fake.events.takeLast(2))
        pump.arrive(266_667L)
        assertEquals(0.25f, fake.drawn.first { it.timeUs == 166_667L }.weight, 1e-4f)
    }

    @Test
    fun `a frame that cannot be blended with the one before it is drawn as it is`() {
        val frames = listOf(0L, 133_333L, 266_667L)
        val (drawn, _) = run(0L, 400_000L, 30, frames, blendable = { it != 2 })
        // Between 133 and 267 ms the pair is broken: those instants show the new frame whole.
        val broken = drawn.filter { it.timeUs in 133_334L..266_667L }
        assertTrue(broken.isNotEmpty())
        assertTrue(broken.all { it.kind == "arrival" })
        // The pair before it still blends.
        assertTrue(drawn.any { it.timeUs in 1L..133_332L && it.kind == "between" })
    }

    @Test
    fun `a source already at the output rate is drawn frame for frame`() {
        // 60 fps at 0.5x: 30 frames a second, on the grid. Nothing is missing, so nothing is made.
        val frames = arrivals(0L, 1_000_000L, speed = 0.5, sourceFps = 60.0)
        val (drawn, _) = run(0L, 1_000_000L, 30, frames)
        assertEquals(frames, drawn.take(frames.size).map { it.timeUs })
        assertTrue(drawn.take(frames.size).all { it.kind == "arrival" || it.weight > 0.999f })
    }

    @Test
    fun `an item with no frames at all ends at once`() {
        val (drawn, fake) = run(0L, 1_000_000L, 30, emptyList())
        assertTrue(drawn.isEmpty())
        assertEquals(listOf("end"), fake.events)
    }

    /* ------------------------------------------------------------------------------------- */
    /* The protocol                                                                            */
    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `the input is handed back only once every instant up to it is drawn, and kept first`() {
        val fake = FakeFrames()
        val pump = SlowMotionPump(SlowMotionCadence(0L, 1_000_000L, 30), fake)
        pump.arrive(0L)
        assertEquals(listOf("draw@0", "keep", "release"), fake.events)
        fake.events.clear()
        pump.arrive(133_333L)
        assertEquals(
            listOf("draw@33333", "draw@66667", "draw@100000", "draw@133333", "keep", "release"),
            fake.events,
        )
    }

    @Test
    fun `with no free texture the pump waits, holding the input, and picks up where it stopped`() {
        val fake = FakeFrames(capacity = 1)
        val pump = SlowMotionPump(SlowMotionCadence(0L, 1_000_000L, 30), fake)
        pump.arrive(0L)
        fake.free()
        fake.events.clear()
        pump.arrive(133_333L)
        // One texture: one instant drawn, and the input still held - not kept, not released.
        assertEquals(listOf("draw@33333"), fake.events)
        fake.free()
        pump.outputFreed()
        fake.free()
        pump.outputFreed()
        fake.free()
        pump.outputFreed()
        assertEquals(
            listOf("draw@33333", "draw@66667", "draw@100000", "draw@133333", "keep", "release"),
            fake.events,
        )
        // Nothing more happens for a texture freed when there is nothing to draw.
        fake.free()
        pump.outputFreed()
        assertEquals(6, fake.events.size)
    }

    @Test
    fun `the end is passed on after the last frame and its tail, never before`() {
        val fake = FakeFrames(capacity = 1)
        val pump = SlowMotionPump(SlowMotionCadence(0L, 300_000L, 30), fake)
        pump.arrive(0L)
        fake.free()
        pump.arrive(133_333L)
        // Media3 signals the end as soon as the last frame is QUEUED; here it is still being drawn.
        pump.endOfStream()
        assertFalse(fake.events.contains("end"))
        while (!fake.events.contains("end")) {
            fake.free()
            pump.outputFreed()
        }
        val tail = fake.events.dropWhile { it != "draw@133333" }
        // The last frame, kept and handed back, then its hold out to 300 ms less half an interval,
        // and only then the end.
        assertEquals(
            listOf("draw@133333", "keep", "release", "draw@166667", "draw@200000", "draw@233333", "draw@266667", "end"),
            tail,
        )
    }

    @Test
    fun `a flush forgets the frame in hand and the schedule`() {
        val fake = FakeFrames(capacity = 1)
        val pump = SlowMotionPump(SlowMotionCadence(0L, 1_000_000L, 30), fake)
        pump.arrive(0L)
        fake.free()
        pump.arrive(133_333L)
        pump.flush()
        fake.lent = 0
        fake.events.clear()
        // A fresh start: the next frame is a first frame, held back to the window's start.
        pump.arrive(500_000L)
        assertEquals("draw@0", fake.events.first())
        assertTrue(fake.drawn.last().kind == "arrival")
    }
}
