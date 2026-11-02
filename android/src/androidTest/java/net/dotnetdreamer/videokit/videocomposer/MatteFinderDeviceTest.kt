package net.dotnetdreamer.videokit.videocomposer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.net.Uri
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.Collections
import java.util.UUID

/**
 * `findMatte` while Play services is still downloading the subject model, on a real phone - the
 * Android half no JVM test reaches: the shared search queue, the selfie segmenter, the stop.
 *
 * No phone that has the model can show a download, and a phone without a Google account is refused
 * one at once, so the download here is a stand-in that never ends ([MatteFinder.subjectModel]): what
 * is held is that waiting for it holds nothing up and that a stop reaches it. Run through a host
 * (lighsnip: `gradlew :capacitor-video-kit:connectedDebugAndroidTest`).
 */
@RunWith(AndroidJUnit4::class)
class MatteFinderDeviceTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val scratch = mutableListOf<File>()
    private val model = MatteFinder.subjectModel

    @After
    fun cleanUp() {
        MatteFinder.subjectModel = model
        scratch.forEach { it.delete() }
    }

    /*
     * The wait for the model used to sit inside the search queue and block a thread for up to two
     * minutes, so a search stopped mid-download held every matte and Focus search behind it.
     */
    @Test
    fun aSearchWaitingForItsModelHoldsNothingUpAndStopsAtOnce() = runBlocking {
        val picture = picture(240, 320)
        val stages = Collections.synchronizedList(mutableListOf<String>())
        MatteFinder.subjectModel = { _, onProgress ->
            onProgress(0.0)
            awaitCancellation()
        }
        val subject = async(Dispatchers.IO) {
            runCatching { MatteFinder.find(context, picture.path, MediaLabels.Kind.IMAGE, "subject", 10) { stage, _ -> stages += stage } }
        }
        withTimeout(5_000) { while ("preparing" !in stages) delay(20) }

        // Another search goes through the queue the download no longer sits in.
        val people = try {
            withTimeout(30_000) { MatteFinder.find(context, picture.path, MediaLabels.Kind.IMAGE, "people", 15) { _, _ -> } }
        } catch (e: MatteFinder.UnsupportedException) {
            assumeTrue("no selfie segmenter in this build: ${e.message}", false)
            return@runBlocking
        }
        scratch += File(Uri.parse(people.uri).path!!)
        assertEquals("people", people.meta.target)
        assertFalse("the subject search is still waiting for its model", subject.isCompleted)

        val stoppedAt = SystemClock.elapsedRealtime()
        assertEquals(1, MatteFinder.stopAllBut(emptySet()))
        val outcome = withTimeout(5_000) { subject.await() }
        val took = SystemClock.elapsedRealtime() - stoppedAt
        assertTrue("stopped, not $outcome", outcome.exceptionOrNull() is MatteFinder.StoppedException)
        assertTrue("stopped in $took ms", took < 1_000)
    }

    /** A `width` x `height` picture: a red disc on blue, so the selfie segmenter has edges to look at. */
    private fun picture(width: Int, height: Int): File {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        canvas.drawColor(Color.BLUE)
        canvas.drawCircle(width / 2f, height / 2f, width / 3f, Paint().apply { color = Color.RED })
        val file = File(context.cacheDir, "videokit-matte-${UUID.randomUUID()}.png").also { scratch += it }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        return file
    }
}
