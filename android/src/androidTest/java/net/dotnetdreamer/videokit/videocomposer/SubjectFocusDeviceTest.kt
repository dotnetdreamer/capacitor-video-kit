package net.dotnetdreamer.videokit.videocomposer

import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import android.util.Log
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.async
import kotlinx.coroutines.delay
import kotlinx.coroutines.runBlocking
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID
import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicLong
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * `findSubjects` and a clip's focus on a real phone, where the parts no JVM test can reach run: the
 * Media3 analyzer export and its read-back, ML Kit's segmenter, and the focus's GL passes.
 *
 * The render is checked pixel by pixel on a picture whose top-left quarter is the only subject: in
 * focus that quarter keeps its hard red and green squares, and everything else comes out blurred to one
 * flat grey - which also catches a mask read upside down or mirrored, since either would sharpen a
 * quarter that is meant to be soft. Run through a host (lighsnip:
 * `gradlew :capacitor-video-kit:connectedDebugAndroidTest`). A clip of real people dropped at
 * `<external files>/subjects-fixture.mp4` is searched and rendered too, its frames written beside it.
 */
@RunWith(AndroidJUnit4::class)
class SubjectFocusDeviceTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val scratch = mutableListOf<File>()

    @After
    fun cleanUp() {
        scratch.forEach { runCatching { it.delete() } }
        scratch.clear()
    }

    @Test
    fun aVideosFramesAreLookedAtInOrderAndKept() = runBlocking {
        val clip = encodedClip()
        val progress = ArrayList<Double>()
        val started = SystemClock.elapsedRealtime()
        val result = try {
            SubjectFinder.find(context, clip.path, MediaLabels.Kind.VIDEO, 10) { synchronized(progress) { progress += it } }
        } catch (e: SubjectFinder.UnsupportedException) {
            assumeTrue("no segmenter on this phone: ${e.message}", false)
            return@runBlocking
        }
        Log.i(TAG, "two seconds of 320x240 looked at in ${SystemClock.elapsedRealtime() - started} ms: $result")
        scratch += File(Uri.parse(result.uri).path!!)

        assertEquals(MediaLabels.Kind.VIDEO, result.kind)
        assertFalse(result.cached)
        assertEquals(320 to 240, result.width to result.height)
        assertEquals(SubjectFinder.ENGINE, result.engine)
        assertEquals(20, result.frames)
        assertTrue("about two seconds, not ${result.durationMs}", result.durationMs in 1_900L..2_100L)
        // Flat colours: nobody there.
        assertTrue(result.subjects.isEmpty())

        val track = SubjectTracks.parse(File(Uri.parse(result.uri).path!!).readBytes())
        assertEquals(20, track.frameCount)
        // The decimator's frames: the first at or after each tenth of a second.
        track.times.forEachIndexed { k, timeMs -> assertTrue("frame $k at $timeMs ms", abs(timeMs - k * 100L) <= 34L) }
        track.checkFrames()
        assertEquals(1.0, synchronized(progress) { progress.last() }, 0.0)

        val again = SubjectFinder.find(context, clip.path, MediaLabels.Kind.VIDEO, 10) {}
        assertTrue(again.cached)
        assertEquals(result.uri, again.uri)
    }

    @Test
    fun aStoppedSearchRejectsAndKeepsNothing() = runBlocking {
        val clip = encodedClip(frames = 300)
        val folder = File(context.cacheDir, "subject-tracks")
        val before = folder.list()?.toSet() ?: emptySet()
        val search = async(Dispatchers.IO) { runCatching { SubjectFinder.find(context, clip.path, MediaLabels.Kind.VIDEO, 30) {} } }
        // Under way: ten seconds at thirty frames a second is a few seconds of looking.
        delay(700)
        assertEquals(1, SubjectFinder.stopAllBut(emptySet()))
        val outcome = search.await()
        val failure = outcome.exceptionOrNull()
        if (failure is SubjectFinder.UnsupportedException) {
            assumeTrue("no segmenter on this phone: ${failure.message}", false)
            return@runBlocking
        }
        assertTrue("stopped, not $outcome", failure is SubjectFinder.StoppedException)
        // A track half made is not kept.
        assertEquals(before, folder.list()?.toSet() ?: emptySet<String>())
    }

    @Test
    fun aSearchGivesWayToARenderAndFinishesAfterIt() = runBlocking {
        val clip = encodedClip(frames = 300)
        val search = async(Dispatchers.IO) { runCatching { SubjectFinder.find(context, clip.path, MediaLabels.Kind.VIDEO, 30) {} } }
        delay(700)
        // A render starting, as compose() registers one and then asks the search to give way.
        val render = renderJob()
        JobRegistry.register(render)
        SubjectFinder.yieldToRender()
        delay(1_500)
        assertFalse("the search should wait for the render", search.isCompleted)
        JobRegistry.forget(render.jobId)
        val result = search.await().getOrElse {
            if (it is SubjectFinder.UnsupportedException) {
                assumeTrue("no segmenter on this phone: ${it.message}", false)
                return@runBlocking
            }
            throw it
        }
        scratch += File(Uri.parse(result.uri).path!!)
        // Looked at again from the start, every frame of it.
        assertEquals(300, result.frames)
    }

    @Test
    fun aPictureIsLookedAtOnce() = runBlocking {
        val picture = checkerboard(240, 320)
        val result = try {
            SubjectFinder.find(context, picture.path, null, 10) {}
        } catch (e: SubjectFinder.UnsupportedException) {
            assumeTrue("no segmenter on this phone: ${e.message}", false)
            return@runBlocking
        }
        scratch += File(Uri.parse(result.uri).path!!)
        assertEquals(MediaLabels.Kind.IMAGE, result.kind)
        assertEquals(1, result.frames)
        assertEquals(0L, result.durationMs)
        assertEquals(240 to 320, result.width to result.height)
    }

    @Test
    fun aFocusKeepsItsSubjectSharpAndSoftensTheRest() {
        val width = 320
        val height = 240
        val picture = checkerboard(width, height)
        // The subject: the top-left quarter of the picture.
        val cells = ByteArray(width * height) { i -> if (i % width < width / 2 && i / width < height / 2) 1 else 0 }
        val trackFile = File(context.cacheDir, "videokit-focus-${UUID.randomUUID()}.vkst").also { scratch += it }
        trackFile.writeBytes(
            SubjectTracks.encode(
                SubjectTrackContent(width, height, listOf(0L), listOf(cells), SubjectTrackMeta("mlkit", MediaLabels.Kind.IMAGE, 0, 0.0, emptyList())),
            ),
        )
        val focus = Focus(Uri.fromFile(trackFile).toString(), listOf(0.0), listOf(FocusSubject(1, listOf(1.0))), blur = 0.05f, mono = 1f)
        val frame = render(picture, focus, width, height, "videokit-focus-render.png")

        val sharp = stats(frame, 20, 20, 140, 100)
        val soft = stats(frame, 180, 140, 300, 220)
        val softTop = stats(frame, 200, 20, 300, 80)
        val softLeft = stats(frame, 20, 160, 120, 220)
        Log.i(TAG, "focus render: sharp $sharp, soft $soft, soft top $softTop, soft left $softLeft")
        // In focus: the squares as they were, red against green.
        assertTrue("in focus should keep its colours: $sharp", sharp.chroma > 120)
        assertTrue("in focus should keep its edges: $sharp", sharp.lumaSpread > 30)
        // Out of focus, on every side of the subject: grey, and flat.
        for (region in listOf(soft, softTop, softLeft)) {
            assertTrue("out of focus should be grey: $region", region.chroma < 25)
            assertTrue("out of focus should be blurred flat: $region", region.lumaSpread < 12)
        }
    }

    @Test
    fun aRealClipsPeopleAreFoundAndKeptSharp() = runBlocking {
        val fixture = File(context.getExternalFilesDir(null), "subjects-fixture.mp4")
        assumeTrue("no fixture at ${fixture.path}", fixture.isFile)
        val started = SystemClock.elapsedRealtime()
        val result = try {
            SubjectFinder.find(context, fixture.path, MediaLabels.Kind.VIDEO, 10) {}
        } catch (e: SubjectFinder.UnsupportedException) {
            assumeTrue("no segmenter on this phone: ${e.message}", false)
            return@runBlocking
        }
        val elapsed = SystemClock.elapsedRealtime() - started
        Log.i(TAG, "fixture of ${result.durationMs} ms (${result.frames} frames) looked at in $elapsed ms: ${result.subjects}")
        assertTrue(result.frames > 0)
        File(context.getExternalFilesDir(null), "subjects-fixture.txt").writeText(
            "looked at in $elapsed ms, cached ${result.cached}\n$result\n",
        )
        val main = result.subjects.firstOrNull() ?: return@runBlocking
        val focus = Focus(
            result.uri,
            listOf(0.0),
            listOf(FocusSubject(main.id, listOf(1.0))),
            blur = 0.03f,
            mono = 1f,
            dim = 0.2f,
        )
        val probe = Thumbnailer.probe(context, fixture.path)
        render(fixture, focus, probe.width / 2 * 2, probe.height / 2 * 2, "subjects-fixture-render.png", image = false, atMs = main.peakMs)
    }

    /* ------------------------------------------------------------------------------------- */

    /** A render as the registry sees one between compose() and its first frame: pending. */
    private fun renderJob(): JobRegistry.Job {
        val spec = ComposeSpec(
            jobId = "render-${UUID.randomUUID()}",
            batchId = "render",
            clips = listOf(Clip("a", "file:///a.mp4", 0, 1_000, 1f, 1f, false, Fit.CONTAIN)),
            output = Output(320, 240, 30, 1_000_000, 128_000),
            filter = emptyList(),
            overlays = emptyList(),
            audio = Audio(false, 1f, null, emptyList()),
            posterAtMs = 0,
        )
        return JobRegistry.Job(spec.jobId, spec.batchId, context.cacheDir, File(context.cacheDir, "render.part"), RenderPlan.build(spec, emptyMap()))
    }

    private data class Stats(val chroma: Double, val lumaSpread: Double)

    /** The mean of |R - G| + |G - B| over a region, and the spread of its luma. */
    private fun stats(frame: Bitmap, x0: Int, y0: Int, x1: Int, y1: Int): Stats {
        var chroma = 0.0
        var sum = 0.0
        var squares = 0.0
        var n = 0
        for (y in y0 until y1) {
            for (x in x0 until x1) {
                val c = frame.getPixel(x, y)
                val r = Color.red(c)
                val g = Color.green(c)
                val b = Color.blue(c)
                chroma += (abs(r - g) + abs(g - b)) / 2.0
                val luma = 0.2126 * r + 0.7152 * g + 0.0722 * b
                sum += luma
                squares += luma * luma
                n++
            }
        }
        val mean = sum / n
        return Stats(chroma / n, sqrt(maxOf(0.0, squares / n - mean * mean)))
    }

    /** [source] as one clip with [focus], rendered by the real composition and Transformer, and its frame at [atMs]. */
    private fun render(source: File, focus: Focus, width: Int, height: Int, saveAs: String, image: Boolean = true, atMs: Long = 500): Bitmap {
        val outMs = if (image) 1_000L else minOf(Thumbnailer.probe(context, source.path).durationMs, atMs + 1_000L)
        val inMs = if (image) 0L else maxOf(0L, atMs - 500L)
        val clip = Clip(
            key = "focused",
            uri = Uri.fromFile(source).toString(),
            inMs = inMs,
            outMs = outMs,
            speed = 1f,
            volume = 1f,
            muted = true,
            fit = Fit.CONTAIN,
            image = image,
            focus = focus,
        )
        val spec = ComposeSpec(
            jobId = "focus",
            batchId = "focus",
            clips = listOf(clip),
            output = Output(width, height, 30, 8_000_000, 128_000),
            filter = emptyList(),
            overlays = emptyList(),
            audio = Audio(true, 1f, null, emptyList()),
            posterAtMs = 0,
        )
        val probes = mapOf(
            clip.uri to if (image) ProbedInput(0, hasAudio = false, hasVideo = true, imageMimeType = "image/png") else Thumbnailer.probe(context, source.path).toProbedInput(),
        )
        val plan = RenderPlan.build(spec, probes)
        val tracks = mapOf(focus.uri to SubjectFinder.trackForRender(context, focus.uri))
        val out = File(context.cacheDir, "videokit-focus-${UUID.randomUUID()}.mp4").also { scratch += it }
        val done = CountDownLatch(1)
        val failure = AtomicReference<Throwable?>(null)
        Handler(Looper.getMainLooper()).post {
            try {
                CompositionBuilder.newTransformer(context, plan, relaxEncoder = false, bytesWritten = AtomicLong())
                    .addListener(object : Transformer.Listener {
                        override fun onCompleted(composition: Composition, exportResult: ExportResult) = done.countDown()

                        override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                            failure.set(exportException)
                            done.countDown()
                        }
                    })
                    .build()
                    .start(CompositionBuilder.toComposition(plan, emptyList(), null, tracks), out.absolutePath)
            } catch (e: Throwable) {
                failure.set(e)
                done.countDown()
            }
        }
        assertTrue("the render did not finish in a minute", done.await(60, TimeUnit.SECONDS))
        failure.get()?.let { throw AssertionError("the render failed", it) }
        val retriever = MediaMetadataRetriever().apply { setDataSource(out.path) }
        val frame = try {
            retriever.getFrameAtTime(500_000L, MediaMetadataRetriever.OPTION_CLOSEST)!!.copy(Bitmap.Config.ARGB_8888, false)
        } finally {
            retriever.release()
        }
        // For a person to look at: adb pull <external files>/<saveAs>.
        File(context.getExternalFilesDir(null), saveAs).outputStream().use { frame.compress(Bitmap.CompressFormat.PNG, 100, it) }
        return frame
    }

    /** A picture of red and green squares eight pixels across: hard edges and strong colour everywhere. */
    private fun checkerboard(width: Int, height: Int): File {
        val bitmap = Bitmap.createBitmap(width, height, Bitmap.Config.ARGB_8888)
        val canvas = Canvas(bitmap)
        val paint = Paint()
        for (y in 0 until height step 8) {
            for (x in 0 until width step 8) {
                paint.color = if ((x / 8 + y / 8) % 2 == 0) Color.RED else Color.GREEN
                canvas.drawRect(x.toFloat(), y.toFloat(), (x + 8).toFloat(), (y + 8).toFloat(), paint)
            }
        }
        val file = File(context.cacheDir, "videokit-focus-${UUID.randomUUID()}.png").also { scratch += it }
        file.outputStream().use { bitmap.compress(Bitmap.CompressFormat.PNG, 100, it) }
        bitmap.recycle()
        return file
    }

    /**
     * Two seconds of 320x240 H.264 at thirty frames a second, each frame a different shade: made here
     * with the phone's own encoder, as [MediaLabelsDeviceTest] makes its clip.
     */
    private fun encodedClip(width: Int = 320, height: Int = 240, frames: Int = 60): File {
        val file = File(context.cacheDir, "videokit-subjects-${UUID.randomUUID()}.mp4").also { scratch += it }
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            setInteger(MediaFormat.KEY_BIT_RATE, 1_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 30)
            setInteger(MediaFormat.KEY_I_FRAME_INTERVAL, 1)
        }
        val codec = MediaCodec.createEncoderByType(MediaFormat.MIMETYPE_VIDEO_AVC)
        val muxer = MediaMuxer(file.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        try {
            codec.configure(format, null, null, MediaCodec.CONFIGURE_FLAG_ENCODE)
            codec.start()
            val info = MediaCodec.BufferInfo()
            var track = -1
            var fed = 0
            var ended = false
            val deadline = System.nanoTime() + 30_000_000_000L
            while (!ended) {
                check(System.nanoTime() < deadline) { "the encoder did not finish two seconds of video in 30 s" }
                if (fed <= frames) {
                    val input = codec.dequeueInputBuffer(10_000L)
                    if (input >= 0) {
                        // Thirty frames a second, on the microsecond: frame k at k / 30 s.
                        val timeUs = fed * 1_000_000L / 30
                        if (fed == frames) {
                            codec.queueInputBuffer(input, 0, 0, timeUs, MediaCodec.BUFFER_FLAG_END_OF_STREAM)
                        } else {
                            paint(codec.getInputImage(input)!!, fed)
                            codec.queueInputBuffer(input, 0, width * height * 3 / 2, timeUs, 0)
                        }
                        fed++
                    }
                }
                val output = codec.dequeueOutputBuffer(info, 10_000L)
                if (output == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    track = muxer.addTrack(codec.outputFormat)
                    muxer.start()
                } else if (output >= 0) {
                    if (info.flags and MediaCodec.BUFFER_FLAG_CODEC_CONFIG != 0) info.size = 0
                    if (info.size > 0) muxer.writeSampleData(track, codec.getOutputBuffer(output)!!, info)
                    codec.releaseOutputBuffer(output, false)
                    ended = info.flags and MediaCodec.BUFFER_FLAG_END_OF_STREAM != 0
                }
            }
            codec.stop()
            muxer.stop()
        } finally {
            codec.release()
            muxer.release()
        }
        return file
    }

    /** One frame of the clip: a flat luma that steps with [index], and a colour that does not. */
    private fun paint(image: Image, index: Int) {
        val values = intArrayOf(40 + index * 3, 90, 200)
        image.planes.forEachIndexed { plane, it ->
            val buffer = it.buffer
            val w = if (plane == 0) image.width else image.width / 2
            val h = if (plane == 0) image.height else image.height / 2
            for (row in 0 until h) {
                for (col in 0 until w) {
                    buffer.put(row * it.rowStride + col * it.pixelStride, values[plane].toByte())
                }
            }
        }
    }

    private companion object {
        const val TAG = "SubjectFocusDeviceTest"
    }
}
