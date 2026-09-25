package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * When a render is past the host's size ceiling, and the words it fails with.
 *
 * The decision is made twice on a real render - on every progress poll against the bytes the muxer
 * has been handed, and once against the finished file - and both ask [SizeCeiling.tooLarge], so
 * pinning it here pins both. The words are pinned literally because every engine has to write the
 * same line. The room a render asks the disk for is here too, because the ceiling bounds it.
 */
class SizeCeilingTest {

    @Test
    fun `with no ceiling no file is too large`() {
        assertNull(SizeCeiling.tooLarge(0L, null))
        assertNull(SizeCeiling.tooLarge(4L * 1024 * 1024 * 1024, null))
        assertNull(SizeCeiling.tooLarge(Long.MAX_VALUE, null))
    }

    @Test
    fun `a file of exactly the ceiling fits, and one byte more does not`() {
        // The ceiling is the most bytes the file MAY have.
        assertNull(SizeCeiling.tooLarge(0L, 100_000_000L))
        assertNull(SizeCeiling.tooLarge(99_999_999L, 100_000_000L))
        assertNull(SizeCeiling.tooLarge(100_000_000L, 100_000_000L))
        assertEquals(
            "too_large max=100000000 bytes=100000001",
            SizeCeiling.tooLarge(100_000_001L, 100_000_000L),
        )
    }

    @Test
    fun `the message names the ceiling and the bytes reached, as whole numbers, in one format`() {
        assertEquals(
            "too_large max=100000000 bytes=104857600",
            SizeCeiling.tooLarge(104_857_600L, 100_000_000L),
        )
        assertEquals("too_large max=1 bytes=2", SizeCeiling.tooLarge(2L, 1L))
        // A ceiling under a byte is read as 0, as iOS reads it, and says so.
        assertEquals("too_large max=0 bytes=1", SizeCeiling.tooLarge(1L, 0L))
    }

    @Test
    fun `the ceiling the parser hands on and the decision agree`() {
        // A spec's maxBytes as the parser reads it, straight into the decision: 1234.9 is 1234, and
        // a 1235-byte file is past a ceiling of 1234.9 bytes as surely as it is past 1234.
        val output = ComposeSpecParser.parse(
            JSONObject(
                """
                {
                  "jobId": "job-1", "batchId": "post-1",
                  "clips": [ { "key": "a", "uri": "file:///a.mp4", "inMs": 0, "outMs": 2000 } ],
                  "output": { "width": 720, "height": 1280, "fps": 30,
                              "videoBitrate": 4000000, "audioBitrate": 128000, "maxBytes": 1234.9 },
                  "filter": [], "overlays": [], "posterAtMs": 0
                }
                """.trimIndent(),
            ),
        ).output
        assertNull(SizeCeiling.tooLarge(1234L, output.maxBytes))
        assertEquals("too_large max=1234 bytes=1235", SizeCeiling.tooLarge(1235L, output.maxBytes))
    }

    @Test
    fun `with no ceiling the disk is asked for the whole estimate`() {
        assertEquals(356_000_000L, SizeCeiling.diskEstimate(356_000_000L, null, 5_000_000L))
    }

    @Test
    fun `with a ceiling the disk is asked for no more than the part file can reach`() {
        // A ten-minute post at 4 Mbps multiplies out to some 356 MB, and a 100 MB ceiling stops its
        // file long before that: the ceiling, the fifth Mp4Writer can leave ahead of the samples,
        // and the slack for one poll and the index.
        assertEquals(
            125_000_000L,
            SizeCeiling.diskEstimate(356_000_000L, 100_000_000L, 5_000_000L),
        )
        // An estimate already under that is asked for as it is.
        assertEquals(
            40_000_000L,
            SizeCeiling.diskEstimate(40_000_000L, 100_000_000L, 5_000_000L),
        )
        // The largest ceiling there is does not overflow into a small one.
        assertEquals(
            356_000_000L,
            SizeCeiling.diskEstimate(356_000_000L, Long.MAX_VALUE, 5_000_000L),
        )
    }
}
