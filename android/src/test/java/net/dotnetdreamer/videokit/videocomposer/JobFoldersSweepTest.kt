package net.dotnetdreamer.choisy.videocomposer

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * What the sweep is allowed to delete.
 *
 * The rule it protects: a post the customer can still retry keeps its files, and the leftovers of a
 * render whose app was killed do not stay on the phone for good.
 */
class JobFoldersSweepTest {

    @get:Rule
    val temp = TemporaryFolder()

    private val now = 1_800_000_000_000L

    private fun folder(name: String, ageMs: Long, done: Boolean): File {
        val dir = temp.newFolder(name)
        val file = File(dir, "stitched.mp4").apply { writeText("x") }
        if (done) File(dir, ".done").apply { writeText("") }.setLastModified(now - ageMs)
        file.setLastModified(now - ageMs)
        dir.setLastModified(now - ageMs)
        return dir
    }

    @Test
    fun `a finished post is swept a day after it finished`() {
        assertTrue(JobFolders.isSweepable(folder("old-done", JobFolders.DONE_TTL_MS + 1000, done = true), now))
        assertFalse(JobFolders.isSweepable(folder("fresh-done", JobFolders.DONE_TTL_MS - 1000, done = true), now))
    }

    @Test
    fun `an unmarked folder is kept for a week, then swept`() {
        assertFalse(JobFolders.isSweepable(folder("retry", JobFolders.DONE_TTL_MS + 1000, done = false), now))
        assertTrue(JobFolders.isSweepable(folder("orphan", JobFolders.ORPHAN_TTL_MS + 1000, done = false), now))
    }

    @Test
    fun `a folder still being written to is not swept`() {
        val dir = folder("busy", JobFolders.ORPHAN_TTL_MS + 1000, done = false)
        File(dir, "in").mkdirs()
        File(dir, "in/clip.mp4").apply { writeText("x") }.setLastModified(now - 60_000)
        assertFalse(JobFolders.isSweepable(dir, now))
    }

    @Test
    fun `an empty folder is swept by its own age`() {
        val dir = temp.newFolder("empty")
        dir.setLastModified(now - JobFolders.ORPHAN_TTL_MS - 1000)
        assertTrue(JobFolders.isSweepable(dir, now))
    }
}
