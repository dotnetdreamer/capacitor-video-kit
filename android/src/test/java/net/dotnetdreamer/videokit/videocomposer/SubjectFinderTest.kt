package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The parts of `findSubjects` that need neither a decoder nor ML Kit: how fast a video is looked at, how
 * often a page hears how far it has got, how small a frame is shown to the segmenter and in what two
 * steps it is brought down, and how a mask becomes the grid of people a track holds.
 */
class SubjectFinderTest {

    @Test
    fun `fps is brought into one to thirty and rounded, and is ten when it says nothing`() {
        assertEquals(10, SubjectFinder.fpsFor(null))
        assertEquals(10, SubjectFinder.fpsFor(Double.NaN))
        assertEquals(10, SubjectFinder.fpsFor(Double.POSITIVE_INFINITY))
        assertEquals(15, SubjectFinder.fpsFor(15.0))
        assertEquals(13, SubjectFinder.fpsFor(12.5))
        assertEquals(1, SubjectFinder.fpsFor(0.4))
        assertEquals(1, SubjectFinder.fpsFor(-3.0))
        assertEquals(30, SubjectFinder.fpsFor(240.0))
    }

    @Test
    fun `progress goes out about four times a second, and the last always and once`() {
        val throttle = SubjectFinder.ProgressThrottle()
        assertTrue(throttle.offer(0.01, nowMs = 1_000))
        assertFalse(throttle.offer(0.02, nowMs = 1_100))
        assertFalse(throttle.offer(0.03, nowMs = 1_249))
        assertTrue(throttle.offer(0.04, nowMs = 1_250))
        assertFalse(throttle.offer(0.05, nowMs = 1_300))
        // However soon after the one before.
        assertTrue(throttle.offer(1.0, nowMs = 1_301))
        assertFalse(throttle.offer(1.0, nowMs = 9_000))
        assertFalse(throttle.offer(0.5, nowMs = 9_000))
    }

    @Test
    fun `a search with nothing in between still says it is done`() {
        val throttle = SubjectFinder.ProgressThrottle()
        assertTrue(throttle.offer(1.0, nowMs = 0))
    }

    @Test
    fun `the segmenter is shown 512 pixels on the longer side, never more than the frame has`() {
        assertEquals(288 to 512, SubjectAnalysis.analysisSize(1080, 1920))
        assertEquals(512 to 288, SubjectAnalysis.analysisSize(1920, 1080))
        assertEquals(512 to 512, SubjectAnalysis.analysisSize(3000, 3000))
        assertEquals(320 to 240, SubjectAnalysis.analysisSize(320, 240))
    }

    @Test
    fun `a large frame is drawn at twice that first, so the read-back halves it exactly`() {
        assertEquals(576 to 1024, SubjectAnalysis.prescaleSize(1080, 1920))
        assertEquals(576 to 1024, SubjectAnalysis.prescaleSize(720, 1280))
        assertEquals(1024 to 576, SubjectAnalysis.prescaleSize(3840, 2160))
        assertEquals(288 to 512, SubjectAnalysis.analysisSize(576, 1024))
        // A frame already small enough goes on at its own size, and the read-back scales it once.
        assertEquals(480 to 854, SubjectAnalysis.prescaleSize(480, 854))
        assertEquals(288 to 512, SubjectAnalysis.analysisSize(480, 854))
    }

    @Test
    fun `a mask becomes the grid's people, at even odds and apart where they do not touch`() {
        // An 8x4 mask: two people, columns 0-2 and 5-7, sure of the first and barely of the second.
        val values = FloatArray(32) { i ->
            when (i % 8) {
                0, 1, 2 -> 0.9f
                5, 6, 7 -> 0.5f
                else -> 0.2f
            }
        }
        val frame = SubjectAnalysis.gridOf(ConfidenceMask(8, 4, values), 8, 4)
        assertEquals(2, frame.count)
        assertEquals(listOf(1, 1, 1, 0, 0, 2, 2, 2), frame.cells.copyOfRange(0, 8).map { it.toInt() })
    }

    @Test
    fun `a mask of another size is read off at the cells' centres`() {
        // The mask at twice the grid: each cell reads the pixel under its centre.
        val values = FloatArray(16 * 8) { i -> if (i % 16 < 8) 1f else 0f }
        val frame = SubjectAnalysis.gridOf(ConfidenceMask(16, 8, values), 8, 4)
        assertEquals(1, frame.count)
        assertEquals(listOf(1, 1, 1, 1, 0, 0, 0, 0), frame.cells.copyOfRange(0, 8).map { it.toInt() })
    }
}
