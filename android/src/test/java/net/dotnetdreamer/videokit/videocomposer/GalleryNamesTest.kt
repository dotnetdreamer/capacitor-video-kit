package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.fail
import org.junit.Test

/**
 * The album and the file name `saveToGallery` is given, as names and never as paths.
 *
 * Below API 29 the video is written with `File(Movies or DCIM, album)` and `File(that, name)`, so a
 * `..` or a separator in either would put it anywhere on shared storage. The album is refused, as
 * iOS's `Gallery.album` refuses the same names (`GalleryCopyTests`); the file name is flattened.
 */
class GalleryNamesTest {

    @Test
    fun `an album is one folder name, trimmed, and none when blank`() {
        assertEquals("LightSnip", Gallery.albumOf("  LightSnip \n"))
        assertEquals("...", Gallery.albumOf("..."))
        assertEquals(".x", Gallery.albumOf(".x"))
        assertNull(Gallery.albumOf("   "))
        assertNull(Gallery.albumOf(null))
    }

    @Test
    fun `an album that is a path, or a dot or two, is refused in the words iOS refuses it in`() {
        for (album in listOf("Trips/2026", "Trips\\2026", " a/b ", ".", "..", " .. ")) {
            try {
                Gallery.albumOf(album)
                fail("expected a refusal for '$album'")
            } catch (e: IllegalArgumentException) {
                assertEquals("album is one folder name, not a path: ${album.trim()}", e.message)
            }
        }
    }

    @Test
    fun `a file name is a name and never a path`() {
        assertEquals("a_.._.._x.mp4", Gallery.nameOf("a/../../x.mp4", "render.mp4"))
        assertEquals("a_b.mp4", Gallery.nameOf("a\\b.mp4", "render.mp4"))
        assertEquals("_x.mp4", Gallery.nameOf("/x.mp4", "render.mp4"))
        // A dot or two names a folder rather than a file, and is the name a missing one gets.
        assertEquals("video.mp4", Gallery.nameOf("..", "render.mp4"))
        assertEquals("video.mp4", Gallery.nameOf(" . ", "render.mp4"))
    }

    @Test
    fun `a file name falls back to the source's own name, and then to video mp4`() {
        assertEquals("holiday.mp4", Gallery.nameOf("  holiday.mp4 ", "render.mp4"))
        assertEquals("render.mp4", Gallery.nameOf("   ", "render.mp4"))
        assertEquals("render.mp4", Gallery.nameOf(null, "render.mp4"))
        assertEquals("video.mp4", Gallery.nameOf(null, null))
        assertEquals("video.mp4", Gallery.nameOf(null, ".."))
        assertEquals("..mp4", Gallery.nameOf("..mp4", null))
    }
}
