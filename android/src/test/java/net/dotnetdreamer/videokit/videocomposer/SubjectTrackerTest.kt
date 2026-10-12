package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The tracker is the reference's port, so its rules are held here to the very cases
 * `src/video-composer/web/subject-tracker.unit.test.ts` holds the reference to: what a speck is, what
 * touching means, who is matched to whom, who is forgotten, who was noise, and the order the survivors
 * are numbered in. Two engines that disagreed on any of them would number the same footage's people
 * differently, and a focus compiled against one track would land on the wrong person in the other.
 */
class SubjectTrackerTest {

    private val w = 20
    private val h = 10

    /** A W x H grid with each rectangle (x0, y0, x1, y1, value), inclusive, filled with its value. */
    private fun grid(vararg boxes: IntArray): ByteArray {
        val out = ByteArray(w * h)
        for ((x0, y0, x1, y1, value) in boxes) {
            for (y in y0..y1) for (x in x0..x1) out[y * w + x] = value.toByte()
        }
        return out
    }

    private fun box(x0: Int, y0: Int, x1: Int, y1: Int, value: Int) = intArrayOf(x0, y0, x1, y1, value)

    private fun finish(tracker: SubjectTracker) =
        tracker.finish("mediapipe", MediaLabels.Kind.VIDEO, durationMs = 1000, fps = 10.0, subjectKind = "person")

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `subjectGrid puts SUBJECT_GRID cells on the longer side and the other in proportion`() {
        assertEquals(180 to SubjectTracker.SUBJECT_GRID, SubjectTracker.subjectGrid(1080, 1920))
        assertEquals(SubjectTracker.SUBJECT_GRID to 180, SubjectTracker.subjectGrid(1920, 1080))
        assertEquals(SubjectTracker.SUBJECT_GRID to SubjectTracker.SUBJECT_GRID, SubjectTracker.subjectGrid(1000, 1000))
        assertEquals(SubjectTracker.SUBJECT_GRID to 1, SubjectTracker.subjectGrid(10_000, 1))
    }

    @Test
    fun `toGrid takes the pixel under each cell centre, stretched over the whole frame`() {
        // A 4x4 mask, left half instance 1, read onto a 2x1 grid.
        val mask = floatArrayOf(1f, 1f, 0f, 0f, 1f, 1f, 0f, 0f, 1f, 1f, 0f, 0f, 1f, 1f, 0f, 0f)
        assertEquals(listOf<Byte>(1, 0), SubjectTracker.toGrid(mask, 4, 4, ByteArray(2), 2, 1).toList())
    }

    @Test
    fun `toGrid makes a confidence foreground at the threshold and above`() {
        val mask = floatArrayOf(0.49f, 0.5f, 0.9f, 0.1f)
        assertEquals(listOf<Byte>(0, 1, 1, 0), SubjectTracker.toGrid(mask, 4, 1, ByteArray(4), 4, 1, 0.5f).toList())
    }

    @Test
    fun `componentsOf numbers the groups that touch in scan order, corners counting as touching`() {
        val cells = grid(box(0, 0, 4, 9, 1), box(5, 0, 9, 9, 1), box(12, 0, 19, 9, 1))
        assertEquals(2, SubjectTracker.componentsOf(cells, w, h))
        assertEquals(1, cells[0].toInt())
        assertEquals(1, cells[9].toInt())
        assertEquals(2, cells[12].toInt())
        // Diagonal neighbours are one group.
        val diagonal = grid(box(0, 0, 2, 2, 1), box(3, 3, 5, 5, 1))
        assertEquals(1, SubjectTracker.componentsOf(diagonal, w, h))
    }

    @Test
    fun `componentsOf makes a speck background`() {
        assertEquals(4, SubjectTracker.minInstanceCells(w * h))
        val cells = grid(box(0, 0, 0, 2, 1), box(10, 0, 19, 9, 1))
        assertEquals(1, SubjectTracker.componentsOf(cells, w, h))
        assertEquals(0, cells[0].toInt())
        assertEquals(1, cells[10].toInt())
    }

    @Test
    fun `a speck is a fifth of a percent of the grid, never under four cells`() {
        // A portrait track's grid, 180 x 320: 115.2 cells, so 116.
        assertEquals(116, SubjectTracker.minInstanceCells(180 * 320))
        assertEquals(4, SubjectTracker.minInstanceCells(1))
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `follows a subject that moves, by overlap, as one id`() {
        val tracker = SubjectTracker(w, h)
        for (f in 0 until 5) tracker.add(f * 100L, grid(box(f, 0, f + 6, 9, 1)), 1)
        val content = finish(tracker)
        assertEquals(listOf(1), content.meta.subjects.map { it.id })
        assertTrue(content.frames.all { frame -> frame.any { it.toInt() == 1 } })
        val subject = content.meta.subjects[0]
        assertEquals(listOf(0L, 400L), listOf(subject.startMs, subject.endMs))
        assertEquals("person", subject.kind)
    }

    @Test
    fun `keeps two subjects apart even when the segmenter numbers them differently in each frame`() {
        val tracker = SubjectTracker(w, h)
        tracker.add(0, grid(box(0, 0, 5, 9, 1), box(12, 0, 19, 9, 2)), 2)
        tracker.add(100, grid(box(0, 0, 5, 9, 2), box(12, 0, 19, 9, 1)), 2)
        tracker.add(200, grid(box(0, 0, 5, 9, 1), box(12, 0, 19, 9, 2)), 2)
        val content = finish(tracker)
        // The larger subject (the right one, 8 columns) is the main one, id 1, in every frame.
        for (frame in content.frames) {
            assertEquals(1, frame[12].toInt())
            assertEquals(2, frame[0].toInt())
        }
    }

    @Test
    fun `starts somebody new for an instance that overlaps nobody`() {
        val tracker = SubjectTracker(w, h)
        tracker.add(0, grid(box(0, 0, 5, 9, 1)), 1)
        tracker.add(100, grid(box(0, 0, 5, 9, 1), box(12, 0, 19, 9, 2)), 2)
        tracker.add(200, grid(box(0, 0, 5, 9, 1), box(12, 0, 19, 9, 2)), 2)
        tracker.add(300, grid(box(0, 0, 5, 9, 1), box(12, 0, 19, 9, 2)), 2)
        val subjects = finish(tracker).meta.subjects
        assertEquals(2, subjects.size)
        assertTrue(subjects.any { it.startMs == 100L })
    }

    @Test
    fun `forgets somebody gone longer than a second, and takes their return for somebody new`() {
        val tracker = SubjectTracker(w, h)
        for (f in 0 until 3) tracker.add(f * 100L, grid(box(0, 0, 9, 9, 1)), 1)
        for (f in 0 until 3) tracker.add(1400 + f * 100L, grid(box(0, 0, 9, 9, 1)), 1)
        val subjects = finish(tracker).meta.subjects
        assertEquals(2, subjects.size)
        assertEquals(listOf(0L to 200L, 1400L to 1600L), subjects.map { it.startMs to it.endMs })
    }

    @Test
    fun `drops a subject seen in fewer than three frames, or too small to be one`() {
        val tracker = SubjectTracker(w, h)
        tracker.add(0, grid(box(0, 0, 9, 9, 1), box(15, 0, 19, 9, 2)), 2)
        tracker.add(100, grid(box(0, 0, 9, 9, 1)), 1)
        tracker.add(200, grid(box(0, 0, 9, 9, 1)), 1)
        val content = finish(tracker)
        assertEquals(listOf(1), content.meta.subjects.map { it.id })
        // The blip's cells are background in the frame it was in.
        assertEquals(0, content.frames[0][15].toInt())
    }

    @Test
    fun `keeps a picture subject seen in its one frame`() {
        val tracker = SubjectTracker(w, h)
        tracker.add(0, grid(box(2, 2, 8, 8, 1)), 1)
        val content = tracker.finish("vision", MediaLabels.Kind.IMAGE, durationMs = 0, fps = 0.0, subjectKind = "subject")
        assertEquals(
            listOf(SubjectInfo(1, "subject", 0, 0, 0, SubjectBox(0.1, 0.2, 0.35, 0.7), 0.245)),
            content.meta.subjects,
        )
    }

    @Test
    fun `keeps at most MAX_SUBJECTS, the largest`() {
        val tracker = SubjectTracker(w, h)
        // Ten subjects in two rows of five, each 2x4 with a gap, the later ones a column wider.
        val boxes = (0 until 10).map { n ->
            val row = if (n < 5) 0 else 5
            val x = (n % 5) * 4
            box(x, row, x + (if (n >= 8) 2 else 1), row + 3, n + 1)
        }
        for (f in 0 until 3) tracker.add(f * 100L, grid(*boxes.toTypedArray()), 10)
        val subjects = finish(tracker).meta.subjects
        assertEquals(SubjectTracker.MAX_SUBJECTS, subjects.size)
        // The two wider ones are first.
        assertEquals(listOf(0.06, 0.06), subjects.take(2).map { it.area })
    }

    @Test
    fun `writes a track another engine reads back, times and grids and subjects`() {
        val tracker = SubjectTracker(w, h)
        for (f in 0 until 4) tracker.add(f * 100L, grid(box(f, 0, f + 6, 9, 1)), 1)
        val content = finish(tracker)
        val track = SubjectTracks.parse(SubjectTracks.encode(content))
        assertEquals(listOf(0L, 100L, 200L, 300L), track.times)
        assertEquals(content.meta, track.meta)
        for (i in 0 until 4) assertEquals(content.frames[i].toList(), track.frame(i).toList())
    }
}
