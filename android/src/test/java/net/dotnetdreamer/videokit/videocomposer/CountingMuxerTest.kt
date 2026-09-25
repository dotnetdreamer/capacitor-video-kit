package net.dotnetdreamer.videokit.videocomposer

import androidx.media3.common.C
import androidx.media3.common.Format
import androidx.media3.common.Metadata
import androidx.media3.common.MimeTypes
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.Muxer
import androidx.media3.muxer.MuxerException
import androidx.media3.transformer.DefaultMuxer
import com.google.common.collect.ImmutableList
import java.io.File
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder

/**
 * What the size poll counts, and why it counts rather than measuring the part file.
 *
 * The first tests pin [CountingMuxer] against a muxer that only records: every call reaches the
 * muxer it wraps unchanged, and every sample's bytes are counted once. The last one runs Media3's
 * own muxer, the one a render with a ceiling writes through, and pins the two facts [SizeCeiling]
 * rests on: every byte counted is in the finished file, so a poll on the count never stops a file
 * that fits; and the file being written is at times longer than the file it becomes, so a poll on
 * its length would.
 */
class CountingMuxerTest {

    @get:Rule
    val folder = TemporaryFolder()

    /** A muxer that writes nothing and remembers what it was asked. */
    private class RecordingMuxer(private val refuse: Boolean = false) : Muxer {
        val tracks = ArrayList<Format>()
        val samples = ArrayList<Triple<Int, Int, Long>>()
        val metadata = ArrayList<Metadata.Entry>()
        var closed = false

        override fun addTrack(format: Format): Int {
            tracks += format
            return tracks.size - 1
        }

        override fun writeSampleData(trackId: Int, byteBuffer: ByteBuffer, bufferInfo: BufferInfo) {
            if (refuse) throw MuxerException("refused", IllegalStateException())
            samples += Triple(trackId, byteBuffer.remaining(), bufferInfo.presentationTimeUs)
            // As a real muxer does: the buffer is consumed.
            byteBuffer.position(byteBuffer.limit())
        }

        override fun addMetadataEntry(metadataEntry: Metadata.Entry) {
            metadata += metadataEntry
        }

        override fun close() {
            closed = true
        }
    }

    private class RecordingFactory(val muxer: RecordingMuxer) : Muxer.Factory {
        val paths = ArrayList<String>()

        override fun create(path: String): Muxer {
            paths += path
            return muxer
        }

        override fun getSupportedSampleMimeTypes(trackType: Int): ImmutableList<String> =
            if (trackType == C.TRACK_TYPE_VIDEO) {
                ImmutableList.of(MimeTypes.VIDEO_H264)
            } else {
                ImmutableList.of(MimeTypes.AUDIO_AAC)
            }

        override fun supportsWritingNegativeTimestampsInEditList(): Boolean = true
    }

    private fun sample(bytes: Int): ByteBuffer = ByteBuffer.allocate(bytes)

    @Test
    fun `every sample's bytes are counted once, whichever track it is on`() {
        val written = AtomicLong(0L)
        val inner = RecordingMuxer()
        val muxer = CountingMuxer.Factory(RecordingFactory(inner), written).create("/x/part.mp4")

        val video = muxer.addTrack(Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).build())
        val audio = muxer.addTrack(Format.Builder().setSampleMimeType(MimeTypes.AUDIO_AAC).build())
        muxer.writeSampleData(video, sample(40_000), BufferInfo(0L, 40_000, C.BUFFER_FLAG_KEY_FRAME))
        muxer.writeSampleData(audio, sample(371), BufferInfo(0L, 371, C.BUFFER_FLAG_KEY_FRAME))
        muxer.writeSampleData(video, sample(9_000), BufferInfo(33_333L, 9_000, 0))

        assertEquals(49_371L, written.get())
        assertEquals(
            listOf(Triple(0, 40_000, 0L), Triple(1, 371, 0L), Triple(0, 9_000, 33_333L)),
            inner.samples,
        )
    }

    @Test
    fun `every other call reaches the muxer it wraps unchanged`() {
        val inner = RecordingMuxer()
        val factory = RecordingFactory(inner)
        val counting = CountingMuxer.Factory(factory, AtomicLong(0L))

        // The factory's answers too: Transformer asks them before it builds anything, and the
        // negative-timestamp one decides whether it may trim with an edit list.
        assertEquals(
            ImmutableList.of(MimeTypes.VIDEO_H264),
            counting.getSupportedSampleMimeTypes(C.TRACK_TYPE_VIDEO),
        )
        assertEquals(
            ImmutableList.of(MimeTypes.AUDIO_AAC),
            counting.getSupportedSampleMimeTypes(C.TRACK_TYPE_AUDIO),
        )
        assertTrue(counting.supportsWritingNegativeTimestampsInEditList())

        val muxer = counting.create("/x/part.mp4")
        assertEquals(listOf("/x/part.mp4"), factory.paths)
        val format = Format.Builder().setSampleMimeType(MimeTypes.VIDEO_H264).setWidth(720).build()
        assertEquals(0, muxer.addTrack(format))
        assertSame(format, inner.tracks.single())
        val entry = object : Metadata.Entry {}
        muxer.addMetadataEntry(entry)
        assertSame(entry, inner.metadata.single())
        assertFalse(inner.closed)
        muxer.close()
        assertTrue(inner.closed)
    }

    @Test
    fun `a sample the muxer refuses is not counted`() {
        val written = AtomicLong(0L)
        val muxer = CountingMuxer.Factory(RecordingFactory(RecordingMuxer(refuse = true)), written)
            .create("/x/part.mp4")
        try {
            muxer.writeSampleData(0, sample(1_000), BufferInfo(0L, 1_000, C.BUFFER_FLAG_KEY_FRAME))
            fail("the refusal should reach the caller")
        } catch (e: MuxerException) {
            assertEquals("refused", e.message)
        }
        assertEquals(0L, written.get())
    }

    @Test
    fun `Media3's muxer holds every byte counted, and its file runs past the finished size while written`() {
        // Enough AAC frames for the index to outgrow the 400,000 bytes Mp4Writer holds for it at
        // the front - about 12 bytes a frame, so some 31,500 frames - after which it goes to the
        // end of the file and is written again past a gap left for the samples to come, as a post
        // of some minutes does. Then a little more, less than that gap holds, so the render ends
        // with part of the gap still empty. The frames are small, so the test writes a few
        // megabytes and not a whole post.
        val frames = 33_000
        val frameBytes = 48
        val frameUs = 1_000_000L * 1024 / 44_100
        val part = File(folder.root, "part.mp4")
        val written = AtomicLong(0L)
        val muxer = CountingMuxer.Factory(DefaultMuxer.Factory(), written).create(part.absolutePath)
        val aac = Format.Builder()
            .setSampleMimeType(MimeTypes.AUDIO_AAC)
            .setSampleRate(44_100)
            .setChannelCount(2)
            // AAC LC, 44.1 kHz, stereo: the two-byte AudioSpecificConfig an encoder hands over.
            .setInitializationData(listOf(byteArrayOf(0x12, 0x10)))
            .build()
        val track = muxer.addTrack(aac)

        var longestWhileWriting = 0L
        for (i in 0 until frames) {
            muxer.writeSampleData(
                track,
                sample(frameBytes),
                BufferInfo(i * frameUs, frameBytes, C.BUFFER_FLAG_KEY_FRAME),
            )
            longestWhileWriting = maxOf(longestWhileWriting, part.length())
        }
        muxer.close()
        val finished = part.length()

        assertEquals(frames.toLong() * frameBytes, written.get())
        // Every byte counted is in the finished file, so with the ceiling at exactly the finished
        // size, no poll on the count would have stopped the render.
        assertTrue("finished $finished, counted ${written.get()}", finished >= written.get())
        assertNull(SizeCeiling.tooLarge(written.get(), finished))
        // While it was written the file was at times longer than it ended up, so a poll on its
        // length would have stopped, as too large, a file that fits.
        assertNotNull(
            "longest $longestWhileWriting, finished $finished",
            SizeCeiling.tooLarge(longestWhileWriting, finished),
        )
    }
}
