package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertEquals
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * The name a file is saved into Downloads under. The flattening is [Gallery.nameOf]'s
 * (`GalleryNamesTest`), with `download` for a file nothing names; below API 29 a name already taken
 * is numbered the way MediaStore numbers one from 29, so a second save never writes over the first.
 */
class DownloadsNamesTest {

    @get:Rule
    val folder = TemporaryFolder()

    @Test
    fun `a file name is a name and never a path, and download when nothing names it`() {
        assertEquals("holiday.wav", Gallery.nameOf(" holiday.wav ", "9F2C.wav", Downloads.DEFAULT_NAME))
        assertEquals("a_.._x.wav", Gallery.nameOf("a/../x.wav", "9F2C.wav", Downloads.DEFAULT_NAME))
        assertEquals("9F2C.wav", Gallery.nameOf(null, "9F2C.wav", Downloads.DEFAULT_NAME))
        assertEquals("download", Gallery.nameOf(null, null, Downloads.DEFAULT_NAME))
        assertEquals("download", Gallery.nameOf("..", "9F2C.wav", Downloads.DEFAULT_NAME))
    }

    @Test
    fun `a free name is the name itself`() {
        val downloads = folder.root
        assertEquals("holiday.wav", Downloads.freeFile(downloads, "holiday.wav").name)
    }

    @Test
    fun `a taken name is numbered before its extension, at the first number free`() {
        val downloads = folder.root
        folder.newFile("holiday.wav")
        assertEquals("holiday (1).wav", Downloads.freeFile(downloads, "holiday.wav").name)

        folder.newFile("holiday (1).wav")
        folder.newFile("holiday (3).wav")
        assertEquals("holiday (2).wav", Downloads.freeFile(downloads, "holiday.wav").name)
    }

    @Test
    fun `a taken name with no extension, or only a leading dot, is numbered at its end`() {
        val downloads = folder.root
        folder.newFile("download")
        folder.newFile(".wav")
        assertEquals("download (1)", Downloads.freeFile(downloads, "download").name)
        assertEquals(".wav (1)", Downloads.freeFile(downloads, ".wav").name)
    }
}
