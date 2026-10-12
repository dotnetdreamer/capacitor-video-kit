package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The subject track is a file three engines read and two write, so its layout is held here byte for
 * byte - the header, the tables, the runs - case for case with `src/editor/subject-track.unit.test.ts`,
 * the reference this port answers to. [SubjectTracks.focusMask] and [SubjectTracks.focusLevels] are the
 * contract's steps 1 to 3, which every engine computes the same way before it uploads a mask.
 */
class SubjectTrackTest {

    private val meta = SubjectTrackMeta(
        engine = "mediapipe",
        kind = MediaLabels.Kind.VIDEO,
        durationMs = 1000,
        fps = 10.0,
        subjects = listOf(SubjectInfo(1, "person", 0, 900, 300, SubjectBox(0.0, 0.0, 0.5, 1.0), 0.5)),
    )

    /** A 4x2 grid: the left half subject [left], the right half subject [right]. */
    private fun halves(left: Int, right: Int): ByteArray =
        intArrayOf(left, left, right, right, left, left, right, right).map { it.toByte() }.toByteArray()

    private fun ByteArray.unsigned(): List<Int> = map { it.toInt() and 0xff }

    private fun encode(times: List<Long>, frames: List<ByteArray>, meta: SubjectTrackMeta = this.meta): ByteArray =
        SubjectTracks.encode(SubjectTrackContent(4, 2, times, frames, meta))

    private fun u16(bytes: ByteArray, at: Int): Int = (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8)

    private fun u32(bytes: ByteArray, at: Int): Long =
        (0 until 4).fold(0L) { sum, k -> sum or ((bytes[at + k].toLong() and 0xff) shl (8 * k)) }

    private fun putU16(bytes: ByteArray, at: Int, value: Int) {
        bytes[at] = value.toByte()
        bytes[at + 1] = (value ushr 8).toByte()
    }

    private fun putU32(bytes: ByteArray, at: Int, value: Long) {
        for (k in 0 until 4) bytes[at + k] = (value ushr (8 * k)).toByte()
    }

    private fun expectRefused(message: String? = null, block: () -> Unit) {
        try {
            block()
            fail("expected a SubjectTrackException")
        } catch (e: SubjectTrackException) {
            if (message != null) assertTrue("'${e.message}' should mention '$message'", e.message!!.contains(message))
        }
    }

    /* ------------------------------------------------------------------------------------- */
    /* runs                                                                                    */
    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `codes a value and its run, the run as LEB128`() {
        assertEquals(listOf(0, 3, 5, 2), SubjectTracks.encodeRuns(byteArrayOf(0, 0, 0, 5, 5)).unsigned())
        // 300 = 0b10_0101100: 0xAC (44 | 0x80), then 2.
        assertEquals(listOf(7, 0xac, 2), SubjectTracks.encodeRuns(ByteArray(300) { 7 }).unsigned())
    }

    @Test
    fun `decodes exactly what it coded`() {
        val cells = ByteArray(1000) { i -> if (i % 97 < 40) 0 else (i % 3).toByte() }
        val runs = SubjectTracks.encodeRuns(cells)
        val out = ByteArray(cells.size)
        SubjectTracks.decodeRuns(runs, 0, runs.size, out)
        assertArrayEquals(cells, out)
    }

    @Test
    fun `refuses runs that do not fill the grid, overrun it or stop in a varint`() {
        val out = ByteArray(4)
        expectRefused { SubjectTracks.decodeRuns(byteArrayOf(1, 3), 0, 2, out) }
        expectRefused { SubjectTracks.decodeRuns(byteArrayOf(1, 5), 0, 2, out) }
        expectRefused { SubjectTracks.decodeRuns(byteArrayOf(1, 0x84.toByte()), 0, 2, out) }
        expectRefused { SubjectTracks.decodeRuns(byteArrayOf(1, 0, 1, 4), 0, 4, out) }
    }

    @Test
    fun `refuses a run so long it would wrap past the grid`() {
        // 0x7fffffff, the largest positive run an int holds: past any grid, never wrapped into one.
        val runs = byteArrayOf(1, 0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0xff.toByte(), 0x07)
        expectRefused("does not fit") { SubjectTracks.decodeRuns(runs, 0, runs.size, ByteArray(4)) }
    }

    /* ------------------------------------------------------------------------------------- */
    /* the file                                                                                */
    /* ------------------------------------------------------------------------------------- */

    private val bytes = encode(listOf(0, 100, 250), listOf(halves(1, 0), halves(0, 1), halves(2, 2)))

    @Test
    fun `lays the header out as the contract has it`() {
        assertEquals(SubjectTracks.MAGIC, String(bytes, 0, 4, Charsets.ISO_8859_1))
        assertEquals(SubjectTracks.VERSION, bytes[4].toInt())
        assertEquals(0, bytes[5].toInt())
        assertEquals(4, u16(bytes, 6))
        assertEquals(2, u16(bytes, 8))
        assertEquals(0, u16(bytes, 10))
        assertEquals(3L, u32(bytes, 12))
        val json = u32(bytes, 16).toInt()
        val written = JSONObject(String(bytes, 20, json, Charsets.UTF_8))
        assertEquals("mediapipe", written.getString("engine"))
        assertEquals("video", written.getString("kind"))
        assertEquals(1000, written.getInt("durationMs"))
        assertEquals(10.0, written.getDouble("fps"), 0.0)
        val subject = written.getJSONArray("subjects").getJSONObject(0)
        assertEquals(1, subject.getInt("id"))
        assertEquals("person", subject.getString("kind"))
        assertEquals(listOf(0, 900, 300), listOf("startMs", "endMs", "peakMs").map { subject.getInt(it) })
        val box = subject.getJSONObject("box")
        assertEquals(listOf(0.0, 0.0, 0.5, 1.0), listOf("x", "y", "w", "h").map { box.getDouble(it) })
        assertEquals(0.5, subject.getDouble("area"), 0.0)
        // The times, then the offsets: the first frame at 0 of the data.
        assertEquals(listOf(0L, 100L, 250L), (0 until 3).map { u32(bytes, 20 + json + 4 * it) })
        assertEquals(0L, u32(bytes, 20 + json + 12))
    }

    @Test
    fun `reads back every frame, its times and its JSON`() {
        val track = SubjectTracks.parse(bytes)
        assertEquals(listOf(4, 2, 3), listOf(track.width, track.height, track.frameCount))
        assertEquals(listOf(0L, 100L, 250L), track.times)
        assertEquals(meta, track.meta)
        assertArrayEquals(halves(1, 0), track.frame(0))
        assertArrayEquals(halves(0, 1), track.frame(1))
        assertArrayEquals(halves(2, 2), track.frame(2))
        // A frame asked for again is the one kept.
        assertSame(track.frame(1), track.frame(1))
    }

    @Test
    fun `reads a copy and a slice taken out of a larger buffer`() {
        val padded = ByteArray(bytes.size + 16)
        bytes.copyInto(padded, 8)
        assertArrayEquals(halves(2, 2), SubjectTracks.parse(padded.copyOfRange(8, 8 + bytes.size)).frame(2))
        assertEquals(3, SubjectTracks.parse(bytes.copyOf()).frameCount)
    }

    @Test
    fun `refuses what is not a subject track it can read`() {
        fun broken(edit: (ByteArray) -> Unit): ByteArray = bytes.copyOf().also(edit)
        val json = u32(bytes, 16).toInt()
        expectRefused { SubjectTracks.parse(ByteArray(10)) }
        expectRefused("not a subject track") { SubjectTracks.parse(broken { it[0] = 0x41 }) }
        expectRefused("version 2") { SubjectTracks.parse(broken { it[4] = 2 }) }
        expectRefused { SubjectTracks.parse(broken { putU16(it, 6, 0) }) }
        expectRefused { SubjectTracks.parse(broken { putU32(it, 12, 0) }) }
        expectRefused("too large") { SubjectTracks.parse(broken { putU16(it, 6, 2000); putU16(it, 8, 2000) }) }
        expectRefused("past its end") { SubjectTracks.parse(broken { putU32(it, 16, 1L shl 20) }) }
        expectRefused("go back") { SubjectTracks.parse(broken { putU32(it, 20 + json + 4, 0) }) }
        expectRefused("offsets") { SubjectTracks.parse(broken { putU32(it, 20 + json + 16, 9999) }) }
    }

    @Test
    fun `refuses tables that claim gigabytes, rather than wrapping them round to fit`() {
        // F at its largest: four bytes a time and four an offset for each, read in longs.
        expectRefused("past its end") { SubjectTracks.parse(bytes.copyOf().also { putU32(it, 12, 0xffffffffL) }) }
        expectRefused("past its end") { SubjectTracks.parse(bytes.copyOf().also { putU32(it, 16, 0xffffffffL) }) }
    }

    @Test
    fun `still draws when its JSON is damaged, only with nothing to list`() {
        val json = u32(bytes, 16).toInt()
        val copy = bytes.copyOf()
        copy[20] = 0x7b // '{'
        copy[21] = 0x7b
        val track = SubjectTracks.parse(copy)
        assertNull(track.meta)
        assertTrue(json > 2)
        assertArrayEquals(halves(1, 0), track.frame(0))
    }

    @Test
    fun `refuses a frame whose runs do not add up when it is drawn, not when it is opened`() {
        val json = u32(bytes, 16).toInt()
        val data = 20 + json + 24
        val copy = bytes.copyOf()
        // The first frame's first run made one cell too long.
        copy[data + 1] = (copy[data + 1] + 1).toByte()
        val track = SubjectTracks.parse(copy)
        expectRefused { track.frame(0) }
        // And a render, which checks every frame before it starts, is refused there.
        expectRefused { SubjectTracks.parse(copy).checkFrames() }
        SubjectTracks.parse(bytes).checkFrames()
    }

    @Test
    fun `reads another engine's JSON leniently, whole milliseconds and all`() {
        val written = """{"engine":"vision","kind":"image","durationMs":12.6,"fps":15,"subjects":[{"id":2,"kind":"subject","startMs":0.4,"endMs":99.5,"peakMs":50,"box":{"x":0.25,"y":0,"w":0.5,"h":1},"area":0.3},7]}"""
        val content = encode(listOf(0), listOf(halves(2, 0)))
        val json = u32(content, 16).toInt()
        val header = content.copyOfRange(0, 20)
        val tail = content.copyOfRange(20 + json, content.size)
        val replaced = header + written.toByteArray() + tail
        putU32(replaced, 16, written.toByteArray().size.toLong())
        val track = SubjectTracks.parse(replaced)
        val read = assertNotNullAndGet(track.meta)
        assertEquals("vision", read.engine)
        assertEquals(MediaLabels.Kind.IMAGE, read.kind)
        assertEquals(13L, read.durationMs)
        assertEquals(15.0, read.fps, 0.0)
        // What is not a subject is left out; what is one keeps its numbers, its times to the millisecond.
        assertEquals(listOf(SubjectInfo(2, "subject", 0, 100, 50, SubjectBox(0.25, 0.0, 0.5, 1.0), 0.3)), read.subjects)
    }

    private fun <T> assertNotNullAndGet(value: T?): T {
        assertNotNull(value)
        return value!!
    }

    /* ------------------------------------------------------------------------------------- */
    /* span                                                                                    */
    /* ------------------------------------------------------------------------------------- */

    private val spaced = SubjectTracks.parse(encode(listOf(100, 200, 400), listOf(halves(1, 0), halves(0, 1), halves(2, 2))))

    @Test
    fun `holds the first frame before it and the last after it`() {
        assertEquals(FrameSpan(0, 0, 0.0), spaced.span(0.0))
        assertEquals(FrameSpan(0, 0, 0.0), spaced.span(100.0))
        assertEquals(FrameSpan(2, 2, 0.0), spaced.span(400.0))
        assertEquals(FrameSpan(2, 2, 0.0), spaced.span(9000.0))
    }

    @Test
    fun `finds the frames either side and how far between them`() {
        assertEquals(FrameSpan(0, 1, 0.5), spaced.span(150.0))
        assertEquals(FrameSpan(1, 2, 0.0), spaced.span(200.0))
        assertEquals(FrameSpan(1, 2, 0.75), spaced.span(350.0))
    }

    @Test
    fun `is one frame for ever on a picture`() {
        val picture = SubjectTracks.parse(encode(listOf(0), listOf(halves(1, 0)), meta.copy(kind = MediaLabels.Kind.IMAGE)))
        assertEquals(FrameSpan(0, 0, 0.0), picture.span(-5.0))
        assertEquals(FrameSpan(0, 0, 0.0), picture.span(123456.0))
    }

    /* ------------------------------------------------------------------------------------- */
    /* focusLevels                                                                             */
    /* ------------------------------------------------------------------------------------- */

    private fun keys(atMs: List<Double>, vararg subjects: Pair<Int, List<Double>>) = FocusKeys.of(
        Focus(uri = "file:///track.vkst", atMs = atMs, subjects = subjects.map { FocusSubject(it.first, it.second) }, blur = 0.01f),
    )

    private val stepped = keys(
        listOf(1000.0, 2000.0, 3000.0, 3000.0),
        1 to listOf(1.0, 0.0, 0.0, 1.0),
        2 to listOf(0.0, 1.0, 1.0, 0.0),
    )

    private fun levelsAt(ms: Double): List<Float> = SubjectTracks.focusLevels(stepped, ms).copyOfRange(0, 3).toList()

    @Test
    fun `reads the keys as a camera is read`() {
        assertEquals(listOf(0f, 1f, 0f), levelsAt(0.0))
        assertEquals(listOf(0f, 0.5f, 0.5f), levelsAt(1500.0))
        assertEquals(listOf(0f, 0f, 1f), levelsAt(2500.0))
        // Two keys at one time are a step: the later wins at that time.
        assertEquals(listOf(0f, 0f, 1f), levelsAt(2999.0))
        assertEquals(listOf(0f, 1f, 0f), levelsAt(3000.0))
        assertEquals(listOf(0f, 1f, 0f), levelsAt(9000.0))
    }

    @Test
    fun `leaves the background and every subject not listed out of focus`() {
        val levels = SubjectTracks.focusLevels(keys(listOf(0.0), 3 to listOf(0.25)), 0.0)
        assertEquals(0f, levels[0])
        assertEquals(0f, levels[1])
        assertEquals(0.25f, levels[3])
        assertEquals(0f, levels[255])
    }

    @Test
    fun `holds a level to 0 to 1`() {
        val levels = SubjectTracks.focusLevels(keys(listOf(0.0), 1 to listOf(7.0), 2 to listOf(-1.0)), 0.0)
        assertEquals(listOf(1f, 0f), listOf(levels[1], levels[2]))
    }

    @Test
    fun `fills the table it is handed, forgetting the last instant`() {
        val out = FloatArray(256) { 0.5f }
        assertSame(out, SubjectTracks.focusLevels(keys(listOf(0.0), 4 to listOf(1.0)), 0.0, out))
        assertEquals(listOf(0f, 0f, 1f), listOf(out[0], out[1], out[4]))
    }

    /* ------------------------------------------------------------------------------------- */
    /* focusMask                                                                               */
    /* ------------------------------------------------------------------------------------- */

    private val pair = SubjectTracks.parse(encode(listOf(0, 100), listOf(halves(1, 0), halves(0, 1))))
    private val oneInFocus = SubjectTracks.focusLevels(keys(listOf(0.0), 1 to listOf(1.0)), 0.0)

    @Test
    fun `is the subject in focus where it is, and 0 elsewhere`() {
        assertEquals(listOf(255, 255, 0, 0, 255, 255, 0, 0), SubjectTracks.focusMask(pair, oneInFocus, 0.0, false).unsigned())
        assertEquals(listOf(0, 0, 255, 255, 0, 0, 255, 255), SubjectTracks.focusMask(pair, oneInFocus, 100.0, false).unsigned())
    }

    @Test
    fun `mixes the frames either side by how far between them the instant is`() {
        assertEquals(listOf(191, 191, 64, 64, 191, 191, 64, 64), SubjectTracks.focusMask(pair, oneInFocus, 25.0, false).unsigned())
    }

    @Test
    fun `turns over for invert`() {
        assertEquals(listOf(0, 0, 255, 255, 0, 0, 255, 255), SubjectTracks.focusMask(pair, oneInFocus, 0.0, true).unsigned())
    }

    @Test
    fun `fills the array it is handed`() {
        val out = ByteArray(8) { 9 }
        assertSame(out, SubjectTracks.focusMask(pair, oneInFocus, 0.0, false, out))
        assertEquals(0, out[2].toInt())
    }
}
