package net.dotnetdreamer.videokit.videocomposer

import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Color
import android.media.Image
import android.media.MediaCodec
import android.media.MediaCodecInfo
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.media.MediaMuxer
import android.os.Build
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Test
import org.junit.runner.RunWith
import java.io.File
import java.util.UUID

/**
 * That `labelMedia` hands the phone's labeler a bitmap it takes, on a real phone with a real engine.
 *
 * THE REGRESSION. With `videokitImageLabeling = 'playServices'`, the first video a host asked about
 * killed the app: a frame from [MediaMetadataRetriever] is RGB_565, Play services' classifier takes
 * ARGB_8888 only, and it says so by throwing inside a JNI call - which the runtime turns into an abort
 * of the whole process, not an exception anybody can catch. The bundled model converts for itself, so
 * the same call passed there. Run this through a host whose build takes the engine from Play services
 * (lighsnip: `gradlew :capacitor-video-kit:connectedDebugAndroidTest`); before the fix the test
 * process died at the first frame. Where the model has not arrived yet the call refuses as
 * unsupported, and the test is skipped rather than passed.
 */
@RunWith(AndroidJUnit4::class)
class MediaLabelsDeviceTest {

    private val context = InstrumentationRegistry.getInstrumentation().targetContext
    private val scratch = mutableListOf<File>()

    @After
    fun cleanUp() {
        scratch.forEach { runCatching { it.delete() } }
        scratch.clear()
    }

    @Test
    fun aVideoIsLabeledWithoutTakingTheAppDown() {
        val clip = encodedClip()
        // What the frames come out as, which is the whole point: RGB_565 is what the classifier refused.
        val retriever = MediaMetadataRetriever().apply { setDataSource(clip.path) }
        val frame = try {
            retriever.getFrameAtTime(0L, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
        } finally {
            retriever.release()
        }
        assertEquals(Bitmap.Config.RGB_565, frame?.config)
        frame?.recycle()

        val result = try {
            MediaLabels.label(context, clip.path, MediaLabels.Kind.VIDEO, emptyList(), 3, MediaLabels.DEFAULT_MIN_CONFIDENCE)
        } catch (e: MediaLabels.UnsupportedException) {
            assumeTrue("no labeler on this phone yet: ${e.message}", false)
            return
        }

        assertEquals(MediaLabels.Kind.VIDEO, result.kind)
        assertTrue("every frame looked at", result.frames.isNotEmpty())
    }

    @Test
    fun aPictureThatDecodesWideIsLabeledToo() {
        // A 16-bit PNG decodes to RGBA_F16, the same trap by another door.
        assumeTrue("RGBA_F16 needs API 26", Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
        val wide = Bitmap.createBitmap(320, 240, Bitmap.Config.RGBA_F16).apply { eraseColor(Color.rgb(30, 120, 220)) }
        val file = File(context.cacheDir, "videokit-label-${UUID.randomUUID()}.png").also { scratch += it }
        file.outputStream().use { wide.compress(Bitmap.CompressFormat.PNG, 100, it) }
        wide.recycle()
        // Only a test of the trap where the PNG comes back wide: API 28 and 29 write it as 8 bits.
        val decoded = BitmapFactory.decodeFile(file.path)
        val decodedConfig = decoded?.config
        decoded?.recycle()
        assumeTrue("this phone decodes the PNG as $decodedConfig, not RGBA_F16", decodedConfig == Bitmap.Config.RGBA_F16)

        val result = try {
            MediaLabels.label(context, file.path, MediaLabels.Kind.IMAGE, emptyList(), 1, MediaLabels.DEFAULT_MIN_CONFIDENCE)
        } catch (e: MediaLabels.UnsupportedException) {
            assumeTrue("no labeler on this phone yet: ${e.message}", false)
            return
        }

        assertEquals(1, result.frames.size)
    }

    @Test
    fun anyOtherLayoutIsCopiedToArgb8888AndTheOriginalRecycled() {
        val narrow = Bitmap.createBitmap(64, 48, Bitmap.Config.RGB_565).apply { eraseColor(Color.RED) }
        val copied = MediaLabels.forLabeler(narrow)
        assertNotSame(narrow, copied)
        assertEquals(Bitmap.Config.ARGB_8888, copied.config)
        assertEquals(64, copied.width)
        assertEquals(48, copied.height)
        assertEquals(Color.RED, copied.getPixel(10, 10))
        assertTrue(narrow.isRecycled)
        copied.recycle()

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val wide = Bitmap.createBitmap(64, 48, Bitmap.Config.RGBA_F16)
            val fromWide = MediaLabels.forLabeler(wide)
            assertEquals(Bitmap.Config.ARGB_8888, fromWide.config)
            assertTrue(wide.isRecycled)
            fromWide.recycle()
        }
    }

    @Test
    fun argb8888IsHandedOnAsItIs() {
        val bitmap = Bitmap.createBitmap(64, 48, Bitmap.Config.ARGB_8888)
        assertSame(bitmap, MediaLabels.forLabeler(bitmap))
        assertFalse(bitmap.isRecycled)
        bitmap.recycle()
    }

    /**
     * Two seconds of 320x240 H.264 at ten frames a second, a keyframe every second, each frame a
     * different shade: made here with the phone's own encoder, so the test needs no fixture and no
     * seeded gallery.
     */
    private fun encodedClip(width: Int = 320, height: Int = 240, frames: Int = 20): File {
        val file = File(context.cacheDir, "videokit-label-${UUID.randomUUID()}.mp4").also { scratch += it }
        val format = MediaFormat.createVideoFormat(MediaFormat.MIMETYPE_VIDEO_AVC, width, height).apply {
            setInteger(MediaFormat.KEY_COLOR_FORMAT, MediaCodecInfo.CodecCapabilities.COLOR_FormatYUV420Flexible)
            setInteger(MediaFormat.KEY_BIT_RATE, 1_000_000)
            setInteger(MediaFormat.KEY_FRAME_RATE, 10)
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
            // An encoder that never signals the end fails the test rather than hanging the run.
            val deadline = System.nanoTime() + 20_000_000_000L
            while (!ended) {
                check(System.nanoTime() < deadline) { "the encoder did not finish two seconds of video in 20 s" }
                if (fed <= frames) {
                    val input = codec.dequeueInputBuffer(10_000L)
                    if (input >= 0) {
                        val timeUs = fed * 100_000L
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

    /** One frame of the clip: a flat luma that steps with `index`, and a colour that does not. */
    private fun paint(image: Image, index: Int) {
        val values = intArrayOf(40 + index * 8, 90, 200)
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
}
