package net.dotnetdreamer.videokit.videocomposer

import android.media.MediaMetadataRetriever
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File
import java.nio.file.Files

/**
 * The two decisions in the thumbnailer that do not need a decoder: which seek a request asks for,
 * and which file the frame it brings back is kept in.
 *
 * Both are worth pinning because getting them wrong is invisible on the surface. A precise strip
 * served the keyframes a previous request cached looks exactly like a strip that ignored `precise`,
 * and a default strip whose file names changed would silently re-cut every tile the editor had
 * already paid for.
 */
class ThumbnailerTest {

    @Test
    fun `a precise request asks for the frame at the time, not the keyframe`() {
        assertEquals(MediaMetadataRetriever.OPTION_CLOSEST, Thumbnailer.frameOption(precise = true))
    }

    @Test
    fun `the default request stays on keyframes`() {
        assertEquals(MediaMetadataRetriever.OPTION_CLOSEST_SYNC, Thumbnailer.frameOption(precise = false))
    }

    @Test
    fun `the two seeks are not the same seek`() {
        assertNotEquals(Thumbnailer.frameOption(precise = true), Thumbnailer.frameOption(precise = false))
    }

    @Test
    fun `the default cache name is the one already on disk`() {
        assertEquals(
            "abc123-2000-160.jpg",
            Thumbnailer.cacheName(sourceKey = "abc123", timeMs = 2000L, maxHeight = 160, precise = false),
        )
    }

    @Test
    fun `a precise frame is cached apart from the keyframe at the same time`() {
        val sync = Thumbnailer.cacheName("abc123", 2000L, 160, precise = false)
        val precise = Thumbnailer.cacheName("abc123", 2000L, 160, precise = true)
        assertEquals("abc123-2000-160-p.jpg", precise)
        assertNotEquals(sync, precise)
    }

    @Test
    fun `time, size and source all still separate one frame from another`() {
        val names = listOf(
            Thumbnailer.cacheName("abc123", 2000L, 160, precise = true),
            Thumbnailer.cacheName("abc123", 3000L, 160, precise = true),
            Thumbnailer.cacheName("abc123", 2000L, 320, precise = true),
            Thumbnailer.cacheName("def456", 2000L, 160, precise = true),
        )
        assertEquals(names.size, names.toSet().size)
    }

    /**
     * A strip that is on disk whole is served without opening the source, so "whole" has to mean
     * what the loop that writes the tiles means by it: every file there, and none of them empty.
     */
    private fun tiles(vararg sizes: Int?): List<File> {
        val dir = Files.createTempDirectory("thumbs").toFile().apply { deleteOnExit() }
        return sizes.mapIndexed { i, size ->
            File(dir, "tile-$i.jpg").also { file ->
                if (size != null) file.writeBytes(ByteArray(size))
                file.deleteOnExit()
            }
        }
    }

    @Test
    fun `a strip with every tile on disk is served from the cache`() {
        assertTrue(Thumbnailer.allCached(tiles(10, 10, 10)))
    }

    @Test
    fun `one missing tile sends the strip back to the source`() {
        assertFalse(Thumbnailer.allCached(tiles(10, null, 10)))
    }

    @Test
    fun `an empty tile is a write that failed, not a cached frame`() {
        assertFalse(Thumbnailer.allCached(tiles(10, 10, 0)))
    }
}
