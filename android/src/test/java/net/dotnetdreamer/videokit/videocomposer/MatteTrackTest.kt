package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The matte track is a file the web side and this engine both write and both read, so its layout is
 * held here byte for byte, case for case with `src/editor/matte-track.unit.test.ts`: the same packets
 * for the same cells, the same refusals, the same mix of two frames.
 */
class MatteTrackTest {

    private val meta = MatteTrackMeta("mlkit", MediaLabels.Kind.VIDEO, "subject", 1000, 10.0, 0.5, MatteBox(0.0, 0.0, 0.5, 1.0))

    /** A 4x2 grid: the left half `left`, the right half `right`. */
    private fun halves(left: Int, right: Int): ByteArray =
        intArrayOf(left, left, right, right, left, left, right, right).map { it.toByte() }.toByteArray()

    private fun bytes(vararg values: Int): ByteArray = values.map { it.toByte() }.toByteArray()

    @Test
    fun codesRunsOfThreeOrMoreAndLiteralsBetween() {
        assertArrayEquals(bytes(9, 0), MatteTracks.encodePackets(bytes(0, 0, 0, 0)))
        assertArrayEquals(bytes(6, 10, 20, 30), MatteTracks.encodePackets(bytes(10, 20, 30)))
        assertArrayEquals(bytes(4, 5, 5, 9, 255, 2, 7), MatteTracks.encodePackets(bytes(5, 5, 255, 255, 255, 255, 7)))
        // 300 << 1 | 1 = 601: 0xD9, then 4.
        assertArrayEquals(bytes(0xd9, 4, 255), MatteTracks.encodePackets(ByteArray(300) { 255.toByte() }))
    }

    @Test
    fun decodesExactlyWhatItCoded() {
        val cells = ByteArray(5000) { i ->
            val x = i % 100
            (if (x < 40) 0 else if (x > 60) 255 else Math.round((x - 40) / 20.0 * 255).toInt()).toByte()
        }
        val packets = MatteTracks.encodePackets(cells)
        val out = ByteArray(cells.size)
        MatteTracks.decodePackets(packets, 0, packets.size, out)
        assertArrayEquals(cells, out)
        assertTrue(packets.size < cells.size / 3)
    }

    @Test
    fun refusesPacketsThatDoNotFillTheGrid() {
        val out = ByteArray(4)
        for (bad in listOf(bytes(7, 1), bytes(11, 1), bytes(1, 1, 9, 1), bytes(8, 1, 2), bytes(9), bytes(0x89))) {
            try {
                MatteTracks.decodePackets(bad, 0, bad.size, out)
                fail("accepted ${bad.toList()}")
            } catch (e: MatteTrackException) {
                // Refused, as the reference refuses it.
            }
        }
    }

    @Test
    fun laysOutTheFileAsTheReferenceDoes() {
        val encoded = MatteTracks.encode(MatteTrackContent(4, 2, listOf(0L, 100L), listOf(halves(255, 0), halves(0, 255)), meta))
        assertEquals("VKMT", String(encoded, 0, 4, Charsets.ISO_8859_1))
        assertEquals(1, encoded[4].toInt())
        val json = (encoded[16].toInt() and 0xff) or ((encoded[17].toInt() and 0xff) shl 8)
        val timesAt = 20 + json
        // No run of three in a frame of halves: one packet of eight literals, nine bytes - the TS bytes.
        assertArrayEquals(bytes(16, 255, 255, 0, 0, 255, 255, 0, 0), encoded.copyOfRange(timesAt + 16, timesAt + 25))
        assertEquals(timesAt + 16 + 18, encoded.size)
        val track = MatteTracks.parse(encoded)
        assertEquals(listOf(0L, 100L), track.times)
        assertArrayEquals(halves(0, 255), track.frame(1))
        assertEquals(meta, track.meta)
        track.checkFrames()
    }

    @Test
    fun mixesTheTwoFramesEitherSideRounded() {
        val track = MatteTracks.parse(MatteTracks.encode(MatteTrackContent(4, 2, listOf(100L, 200L), listOf(halves(255, 0), halves(0, 255)), meta)))
        assertArrayEquals(halves(255, 0), MatteTracks.matteAt(track, 0.0))
        assertArrayEquals(halves(128, 128), MatteTracks.matteAt(track, 150.0))
        assertArrayEquals(halves(191, 64), MatteTracks.matteAt(track, 125.0))
        assertArrayEquals(halves(0, 255), MatteTracks.matteAt(track, 9999.0))
    }

    @Test
    fun refusesWhatIsNotAMatteTrack() {
        val good = MatteTracks.encode(MatteTrackContent(4, 2, listOf(0L), listOf(halves(255, 0)), meta))
        for (change in listOf<(ByteArray) -> Unit>({ it[0] = 0x57 }, { it[4] = 2 }, { it[6] = 0; it[7] = 0 }, { it[12] = 0xe8.toByte(); it[13] = 3 })) {
            val copy = good.copyOf()
            change(copy)
            try {
                MatteTracks.parse(copy)
                fail("accepted a damaged track")
            } catch (e: MatteTrackException) {
                // Refused.
            }
        }
    }

    @Test
    fun summarisesCoverageAndBoxAsTheReferenceDoes() {
        val a = bytes(255, 0, 0, 0, 255, 0, 0, 0)
        val b = bytes(0, 0, 0, 200, 0, 0, 0, 100)
        assertEquals(0.1875 to MatteBox(0.0, 0.0, 1.0, 1.0), MatteTracks.summarise(listOf(a, b), 4, 2))
        assertEquals(0.0 to null, MatteTracks.summarise(listOf(ByteArray(8) { 127 }), 4, 2))
    }

    @Test
    fun smoothsOnlyWhereThePictureStayedTheSame() {
        val cells = bytes(255, 255)
        MatteAnalysis.smooth(cells, luma = bytes(10, 200), previous = bytes(0, 0), previousLuma = bytes(10, 10))
        // Still: 35% of the new answer. Moved by 190 of 255: all of it.
        assertEquals(89, cells[0].toInt() and 0xff)
        assertEquals(255, cells[1].toInt() and 0xff)
    }
}
