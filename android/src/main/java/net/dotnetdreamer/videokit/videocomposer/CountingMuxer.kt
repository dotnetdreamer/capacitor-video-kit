package net.dotnetdreamer.videokit.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.Format
import androidx.media3.common.Metadata
import androidx.media3.common.util.UnstableApi
import androidx.media3.muxer.BufferInfo
import androidx.media3.muxer.Muxer
import com.google.common.collect.ImmutableList
import java.nio.ByteBuffer
import java.util.concurrent.atomic.AtomicLong

/**
 * A muxer that adds up the bytes of every encoded sample it is handed into [written], and otherwise
 * is the muxer it wraps - so that a render can be held to the host's [Output.maxBytes] while it is
 * still being written. See [SizeCeiling] for why the count and not the part file's length.
 *
 * Every call is forwarded unchanged, the factory's answers included: which sample formats the muxer
 * takes, and whether it can write negative timestamps into an edit list, which Transformer asks
 * before it trims with one. A sample is counted once the muxer has taken it, so a write that throws adds
 * nothing, though it fails the export anyway. [written] is added to from Transformer's muxer thread
 * and read from the main looper's progress poll, which is why it is atomic.
 *
 * The web engine counts the same thing, every packet its encoders hand its muxer (`encode.ts`), for
 * a reason of its own: its muxer writes nothing out until the end. iOS's `WriterEngine` has no
 * muxer of its own to wrap and measures the files its `AVAssetWriter` is writing instead, in its
 * `watchSize`.
 */
@OptIn(UnstableApi::class)
class CountingMuxer private constructor(
    private val muxer: Muxer,
    private val written: AtomicLong,
) : Muxer {

    /** Wraps every muxer [factory] makes, all of them counting into the same [written]. */
    class Factory(
        private val factory: Muxer.Factory,
        private val written: AtomicLong,
    ) : Muxer.Factory {

        override fun create(path: String): Muxer = CountingMuxer(factory.create(path), written)

        override fun getSupportedSampleMimeTypes(trackType: Int): ImmutableList<String> =
            factory.getSupportedSampleMimeTypes(trackType)

        override fun supportsWritingNegativeTimestampsInEditList(): Boolean =
            factory.supportsWritingNegativeTimestampsInEditList()
    }

    override fun addTrack(format: Format): Int = muxer.addTrack(format)

    override fun writeSampleData(trackId: Int, byteBuffer: ByteBuffer, bufferInfo: BufferInfo) {
        // Read before the muxer consumes the buffer, which leaves nothing remaining.
        val bytes = byteBuffer.remaining().toLong()
        muxer.writeSampleData(trackId, byteBuffer, bufferInfo)
        written.addAndGet(bytes)
    }

    override fun addMetadataEntry(metadataEntry: Metadata.Entry) {
        muxer.addMetadataEntry(metadataEntry)
    }

    override fun close() {
        muxer.close()
    }
}
