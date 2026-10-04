package net.dotnetdreamer.videokit.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException
import androidx.media3.common.util.UnstableApi
import androidx.media3.common.util.Util
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.min

/**
 * Holds one audio item to EXACTLY the samples its piece of the output timeline has room for: what
 * the item decodes past that is dropped, and what it comes up short of is filled with silence.
 *
 * It exists for the passes of a looping sound, which Media3 does not join by itself. A sequence's
 * audio is the items' samples one after another, with no timestamps between them (Transformer's
 * `AudioGraphInput`), so an item that hands over a little too little leaves silence where the next
 * pass should already be playing, and one that hands over a little too much pushes every pass after
 * it late. Both happen at the end of a pass, and neither is anything the plan asked for:
 *
 * - An `.m4a` or an `.mp3` normally starts with the encoder's priming and ends on a padded frame, and
 *   says so in its header (an MP4 edit list, an MP3's gapless tag). Media3 then leaves the frames'
 *   timestamps where they were and has the decoder drop the priming instead - and a clip END is
 *   checked against those timestamps, which run ahead of the sound by the priming. So the last
 *   frame of the sound starts past a clip end at the file's own length and is never decoded: every
 *   pass of the 12 s test tone came 816 samples short, and Media3 filled those with silence
 *   (`SilenceAppendingAudioProcessor`), an 18.5 ms hole and a tick at every seam. A pass that runs
 *   to the end of its file is therefore no longer clipped at its end at all - see
 *   [RenderPlan.MusicItem.decodeEndUs] - and the decoder's own trim makes it exactly the file.
 * - A pass cut short of the end of its file, and a file with no such header, end on whole codec
 *   frames wherever the cut falls: a frame that starts before the cut is decoded whole, one that
 *   starts after it not at all. So a cut pass is decoded a little PAST its end, and this processor
 *   stops it on the sample.
 *
 * The count is taken off the item's place on the OUTPUT timeline, `startUs..endUs`, as the samples
 * up to `endUs` less the samples up to `startUs`, each rounded up the way Media3 rounds a gap
 * (`Util.durationUsToSampleCount`). Counted that way the passes can never drift apart by the rounding
 * of their lengths, however many there are: the seam between two of them lands on the sample
 * `ceil(seam * rate)` whatever came before it, and so does the first one after a leading gap.
 *
 * It runs on the item's own samples, before Media3 converts them to the mix's rate, so a sound at
 * another rate is counted at its own - one rounding per pass rather than none, well under a
 * sample's worth of drift. It is added FIRST among the item's processors so that the gain that
 * follows is handed the very samples that play, counted from the pass's first one.
 *
 * [getDurationAfterProcessorApplied] holds a duration to the same length, so that Media3's own idea
 * of how long a pass decoded past its end runs is the plan's too - and passes a position inside the
 * item through unchanged, which is what keeps the fade after it counting from the pass's start.
 *
 * The web engine needs none of this: it mixes the passes sample by sample onto one buffer. Nor does
 * iOS, which lays each pass on one composition track at the time range it names and lets
 * AVFoundation read it through the file's own edit list.
 */
@OptIn(UnstableApi::class)
class ExactLengthAudioProcessor(
    /** Where the item starts on the output timeline. */
    private val startUs: Long,
    /** Where it ends: the item is exactly the samples between the two, however much it decodes. */
    private val endUs: Long,
) : AudioProcessor {

    init {
        require(startUs >= 0L && endUs >= startUs) { "bad window $startUs..$endUs" }
    }

    private var pendingFormat = AudioFormat.NOT_SET
    private var format = AudioFormat.NOT_SET

    /** How many sample frames the item is held to, for the format it was last flushed in. */
    private var targetFrames = 0L

    /** How many frames have gone out so far: the item's own, then any silence after them. */
    private var framesOut = 0L

    private var inputEnded = false
    private var buffer: ByteBuffer = AudioProcessor.EMPTY_BUFFER
    private var outputBuffer: ByteBuffer = AudioProcessor.EMPTY_BUFFER
    private var silence: ByteBuffer = AudioProcessor.EMPTY_BUFFER

    /** The byte [silence] is filled with; see [silenceOf]. */
    private var silenceFill: Byte = 0

    /** How many frames the item is held to at [sampleRate]. Public so the tests can count seams. */
    fun framesAt(sampleRate: Int): Long =
        Util.durationUsToSampleCount(endUs, sampleRate) - Util.durationUsToSampleCount(startUs, sampleRate)

    /**
     * What [durationUs] of the item's input comes out as: all of it up to the item's length, and
     * never more. Media3 asks this for two things, and both need that answer rather than the length
     * alone. It is the item's length on the timeline (`EditedMediaItem.getDurationAfterEffectsApplied`)
     * - the item is decoded past its end, and this brings it back. And it is how a POSITION is carried
     * through the item's processors: `AudioProcessingPipeline.flush` hands each processor the stream's
     * start mapped through every one before it. Answering the length whatever was asked told the gain
     * after this that the item started at its END - a fade in was already over on the first sample,
     * and the pass a fade out ran through was silent from its first. A position inside the item is
     * the same position after it, and the start is still the start.
     *
     * An item that decodes SHORT of its length is padded to it here but reported at what it decoded;
     * Media3 reads that length only to stamp the next item's timestamps, and places a sequence's sound
     * by its first sample alone.
     */
    override fun getDurationAfterProcessorApplied(durationUs: Long): Long = min(durationUs, endUs - startUs)

    override fun configure(inputAudioFormat: AudioFormat): AudioFormat {
        if (!Util.isEncodingLinearPcm(inputAudioFormat.encoding) || inputAudioFormat.sampleRate <= 0) {
            throw UnhandledAudioFormatException(inputAudioFormat)
        }
        pendingFormat = inputAudioFormat
        return inputAudioFormat
    }

    override fun isActive(): Boolean = pendingFormat != AudioFormat.NOT_SET

    override fun queueInput(inputBuffer: ByteBuffer) {
        val bytesPerFrame = format.bytesPerFrame
        val roomBytes = (targetFrames - framesOut).coerceAtLeast(0L) * bytesPerFrame
        // Whole frames only: a buffer always holds whole frames, and so does the room, but the
        // arithmetic is kept honest rather than trusted.
        val takeBytes = (min(inputBuffer.remaining().toLong(), roomBytes) / bytesPerFrame * bytesPerFrame).toInt()
        if (takeBytes <= 0) {
            // Past the end of the item: consumed and dropped, so the decoder can run on to its end.
            inputBuffer.position(inputBuffer.limit())
            return
        }
        val out = replaceOutputBuffer(takeBytes)
        val limit = inputBuffer.limit()
        inputBuffer.limit(inputBuffer.position() + takeBytes)
        out.put(inputBuffer)
        inputBuffer.limit(limit)
        // Whatever this buffer held past the item's end is dropped with it.
        inputBuffer.position(limit)
        out.flip()
        outputBuffer = out
        framesOut += takeBytes / bytesPerFrame
    }

    override fun queueEndOfStream() {
        inputEnded = true
    }

    override fun getOutput(): ByteBuffer {
        if (outputBuffer.hasRemaining()) {
            val out = outputBuffer
            outputBuffer = AudioProcessor.EMPTY_BUFFER
            return out
        }
        if (!inputEnded || framesOut >= targetFrames) return AudioProcessor.EMPTY_BUFFER
        // The item came up short: silence to the end of its piece, a chunk at a time so that a pass
        // that decoded nothing at all does not ask for its whole length in one allocation.
        val frames = min(targetFrames - framesOut, SILENCE_CHUNK_FRAMES)
        val out = silenceOf((frames * format.bytesPerFrame).toInt())
        framesOut += frames
        return out
    }

    override fun isEnded(): Boolean =
        inputEnded && framesOut >= targetFrames && !outputBuffer.hasRemaining()

    override fun flush(streamMetadata: StreamMetadata) {
        format = pendingFormat
        targetFrames = if (format == AudioFormat.NOT_SET) 0L else framesAt(format.sampleRate)
        // Transformer always starts an item at its first sample. A player that seeks into one would
        // flush at an offset, and the count then starts there rather than at the top.
        val offsetUs = streamMetadata.positionOffsetUs
        framesOut = if (format == AudioFormat.NOT_SET || offsetUs == C.TIME_UNSET || offsetUs <= 0L) {
            0L
        } else {
            min(targetFrames, Util.durationUsToSampleCount(offsetUs, format.sampleRate))
        }
        inputEnded = false
        outputBuffer = AudioProcessor.EMPTY_BUFFER
    }

    @Deprecated("Media3 calls flush(StreamMetadata); this is the old overload it forwards from.")
    override fun flush() {
        flush(StreamMetadata.DEFAULT)
    }

    override fun reset() {
        pendingFormat = AudioFormat.NOT_SET
        format = AudioFormat.NOT_SET
        targetFrames = 0L
        framesOut = 0L
        inputEnded = false
        buffer = AudioProcessor.EMPTY_BUFFER
        outputBuffer = AudioProcessor.EMPTY_BUFFER
        silence = AudioProcessor.EMPTY_BUFFER
        silenceFill = 0
    }

    private fun replaceOutputBuffer(size: Int): ByteBuffer {
        if (buffer.capacity() < size) {
            buffer = ByteBuffer.allocateDirect(size).order(ByteOrder.nativeOrder())
        } else {
            buffer.clear()
        }
        return buffer
    }

    /**
     * [bytes] of silence, from one buffer that is filled once and never written again - the reader
     * only moves its position. Silence is zero in every PCM encoding but unsigned 8 bit, whose middle
     * is 0x80.
     */
    private fun silenceOf(bytes: Int): ByteBuffer {
        val capacity = (SILENCE_CHUNK_FRAMES * format.bytesPerFrame).toInt()
        val fill: Byte = if (format.encoding == C.ENCODING_PCM_8BIT) 0x80.toByte() else 0
        if (silence.capacity() < capacity || fill != silenceFill) {
            silence = ByteBuffer.allocateDirect(capacity).order(ByteOrder.nativeOrder())
            while (silence.hasRemaining()) silence.put(fill)
            silenceFill = fill
        }
        silence.clear()
        silence.limit(bytes)
        return silence
    }

    private companion object {
        /** About a tenth of a second at 44.1 kHz; the most silence handed over at once. */
        const val SILENCE_CHUNK_FRAMES = 4_096L
    }
}
