package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Test

/**
 * The one decision in the gallery reader that needs no MediaStore: which file a thumbnail is kept
 * in. It is the whole cache index, so two videos sharing a name would show each other's frame.
 */
class GalleryLibraryTest {

    @Test
    fun `a thumbnail is named after the video and its size`() {
        assertEquals(
            "content___media_external_video_media_42-384.jpg",
            GalleryLibrary.thumbnailName("content://media/external/video/media/42", 384),
        )
    }

    @Test
    fun `two videos never share a thumbnail`() {
        assertNotEquals(
            GalleryLibrary.thumbnailName("content://media/external/video/media/42", 384),
            GalleryLibrary.thumbnailName("content://media/external/video/media/421", 384),
        )
    }

    @Test
    fun `two sizes of one video are two files`() {
        assertNotEquals(
            GalleryLibrary.thumbnailName("content://media/external/video/media/42", 384),
            GalleryLibrary.thumbnailName("content://media/external/video/media/42", 256),
        )
    }
}
