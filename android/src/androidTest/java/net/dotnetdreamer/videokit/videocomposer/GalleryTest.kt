package net.dotnetdreamer.videokit.videocomposer

import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/**
 * That a saved video is somewhere a gallery app can actually see it.
 *
 * An instrumented test rather than a unit one because there is nothing here worth faking: the bug
 * this guards against was a save that succeeded against the wrong storage, and a stubbed
 * ContentResolver would have agreed with the broken version as readily as with this one. What is
 * asserted is what a gallery app does - a plain query of the external video collection - so this
 * fails in exactly the case the customer complained about, where the copy reported success and
 * nothing ever showed up.
 *
 * The history, so nobody re-introduces it: the app used to copy into `getExternalMediaDirs()` and
 * announce the file with an `ACTION_MEDIA_SCANNER_SCAN_FILE` broadcast. That directory is the app's
 * own, which Android empties on uninstall, and the broadcast has been a no-op since API 29.
 */
@RunWith(AndroidJUnit4::class)
class GalleryTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val album = "VideoKitTest"
    private val saved = mutableListOf<Uri>()
    private val scratch = mutableListOf<File>()

    @After
    fun cleanUp() {
        /* Rows first: deleting the row takes the file with it on API 29+. A test that left videos
           in somebody's gallery would be a worse bug than the one it guards against. */
        saved.forEach { runCatching { context.contentResolver.delete(it, null, null) } }
        saved.clear()
        scratch.forEach { runCatching { it.delete() } }
        scratch.clear()
    }

    /**
     * THE REGRESSION. A save has to land where a gallery app looks, which means a row a plain
     * MediaStore query finds - not a file in a folder that happens to hold videos.
     */
    @Test
    fun savedVideoIsFoundByTheQueryAGalleryAppMakes() {
        assumeScopedInsert()
        val name = "videokit-test-${UUID.randomUUID()}.mp4"

        saved += Gallery.save(context, sourceFile().toURI().toString(), name, album, "movies")

        val found = context.contentResolver.query(
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI,
            arrayOf(
                MediaStore.Video.Media.DISPLAY_NAME,
                MediaStore.Video.Media.RELATIVE_PATH,
                MediaStore.Video.Media.MIME_TYPE,
                MediaStore.Video.Media.SIZE,
            ),
            "${MediaStore.Video.Media.DISPLAY_NAME} = ?",
            arrayOf(name),
            null,
        )

        requireNotNull(found).use { cursor ->
            assertTrue("the gallery has no row for $name", cursor.moveToFirst())
            assertEquals(
                "Movies/$album/",
                cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.RELATIVE_PATH)),
            )
            assertEquals(
                "video/mp4",
                cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.MIME_TYPE)),
            )
            assertTrue(
                "the row is there but the bytes are not",
                cursor.getLong(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.SIZE)) > 0,
            )
        }
    }

    /**
     * Not pending once the copy is done.
     *
     * A row left pending is invisible to every other app, so a save that forgot to clear the flag
     * would pass the test above - which queries as the row's own owner - and still show a gallery
     * nothing at all.
     */
    @Test
    fun savedVideoIsNoLongerPending() {
        assumeScopedInsert()
        val name = "videokit-test-${UUID.randomUUID()}.mp4"

        val uri = Gallery.save(context, sourceFile().toURI().toString(), name, album, "movies")
        saved += uri

        context.contentResolver.query(
            uri, arrayOf(MediaStore.Video.Media.IS_PENDING), null, null, null,
        )!!.use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(0, cursor.getInt(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.IS_PENDING)))
        }
    }

    /** `dcim` is the other folder a gallery indexes, and what an app filing beside the camera picks. */
    @Test
    fun theDirectoryOptionChoosesWhichMediaFolder() {
        assumeScopedInsert()
        val name = "videokit-test-${UUID.randomUUID()}.mp4"

        val uri = Gallery.save(context, sourceFile().toURI().toString(), name, album, "dcim")
        saved += uri

        context.contentResolver.query(
            uri, arrayOf(MediaStore.Video.Media.RELATIVE_PATH), null, null, null,
        )!!.use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(
                "DCIM/$album/",
                cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.RELATIVE_PATH)),
            )
        }
    }

    /** No album is the top of the folder rather than one called "null" or "". */
    @Test
    fun noAlbumPutsTheVideoStraightIntoTheFolder() {
        assumeScopedInsert()
        val name = "videokit-test-${UUID.randomUUID()}.mp4"

        val uri = Gallery.save(context, sourceFile().toURI().toString(), name, null, null)
        saved += uri

        context.contentResolver.query(
            uri, arrayOf(MediaStore.Video.Media.RELATIVE_PATH), null, null, null,
        )!!.use { cursor ->
            assertTrue(cursor.moveToFirst())
            assertEquals(
                "Movies/",
                cursor.getString(cursor.getColumnIndexOrThrow(MediaStore.Video.Media.RELATIVE_PATH)),
            )
        }
    }

    /** iOS has albums and no folders under them, so a path here is refused on both platforms. */
    @Test(expected = IllegalArgumentException::class)
    fun anAlbumIsOneNameRatherThanAPath() {
        Gallery.save(context, sourceFile().toURI().toString(), "videokit-test.mp4", "One/Two", "movies")
    }

    /** A folder nothing indexes is the failure this call exists to prevent, so it is not offered. */
    @Test(expected = IllegalArgumentException::class)
    fun onlyTheFoldersAGalleryIndexesAreAccepted() {
        Gallery.save(context, sourceFile().toURI().toString(), "videokit-test.mp4", album, "downloads")
    }

    /**
     * Below API 29 the save writes into public storage, which needs a permission an instrumented
     * test cannot grant itself. What is worth guarding on a modern phone is the scoped insert, and
     * that is every device this ships to.
     */
    private fun assumeScopedInsert() {
        assumeTrue("a scoped MediaStore insert needs API 29", Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
    }

    /** Some bytes to copy. Deliberately not a real MP4: what is under test is where they land. */
    private fun sourceFile(): File {
        val file = File(context.cacheDir, "videokit-gallery-source-${UUID.randomUUID()}.mp4")
        file.writeBytes(ByteArray(4096) { it.toByte() })
        scratch += file
        return file
    }
}
