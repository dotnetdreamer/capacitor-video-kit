package net.dotnetdreamer.videokit.videocomposer

import net.dotnetdreamer.videokit.videocomposer.VideoComposerPlugin.Companion.GALLERY_IMAGES
import net.dotnetdreamer.videokit.videocomposer.VideoComposerPlugin.Companion.GALLERY_STORAGE
import net.dotnetdreamer.videokit.videocomposer.VideoComposerPlugin.Companion.GALLERY_VIDEO
import net.dotnetdreamer.videokit.videocomposer.VideoComposerPlugin.Companion.readAliases
import org.junit.Assert.assertArrayEquals
import org.junit.Test

/**
 * Which names a media read is asked for by, on each side of Android 13.
 *
 * Worth pinning because asking by the wrong name is not a smaller grant but a permission the system
 * does not recognise and never prompts for. No prompt appears, the answer is a refusal, and the
 * gallery and every retained MediaStore URI read as closed to a customer who was never asked.
 */
class ReadAliasesTest {

    @Test
    fun `below Android 13 one storage grant covers the videos and the pictures`() {
        assertArrayEquals(arrayOf(GALLERY_STORAGE), readAliases(sdk = 24, images = false))
        assertArrayEquals(arrayOf(GALLERY_STORAGE), readAliases(sdk = 32, images = false))
        assertArrayEquals(arrayOf(GALLERY_STORAGE), readAliases(sdk = 32, images = true))
    }

    @Test
    fun `from Android 13 the videos are asked for by their own name`() {
        assertArrayEquals(arrayOf(GALLERY_VIDEO), readAliases(sdk = 33, images = false))
        assertArrayEquals(arrayOf(GALLERY_VIDEO), readAliases(sdk = 36, images = false))
    }

    @Test
    fun `from Android 13 the pictures are a second name, asked for beside the videos`() {
        assertArrayEquals(arrayOf(GALLERY_VIDEO, GALLERY_IMAGES), readAliases(sdk = 33, images = true))
    }
}
