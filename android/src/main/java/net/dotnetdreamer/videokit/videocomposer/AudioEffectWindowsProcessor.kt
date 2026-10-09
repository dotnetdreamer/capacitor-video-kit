package net.dotnetdreamer.videokit.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * The audio effect layers on Media3's side: [AudioEffectRunner] over the FINISHED mix.
 *
 * The builder hands it to the composition, never to an item ([CompositionBuilder.toComposition]), and
 * Media3 1.11.1 runs a composition's audio processors on the mixer's output (`AudioSampleExporter` ->
 * `AudioGraph`): every sound already in it and held to 16 bits by `DefaultAudioMixer`, at the rate and
 * the channels of the first item of the first sequence with sound, and on from here to the encoder's
 * resampler. The graph configures and flushes it at the mix's start - `positionOffsetUs` 0 in an
 * export - so a frame counted from the flush is the output's own, `n / rate`, which is all a window
 * needs to know where it is. When the encoder takes another rate Media3 resets the graph, and it is
 * configured and flushed again before any sound flows; every flush starts every window afresh.
 *
 * It changes no length - a frame in is a frame out, a slowed window reading what it remembers - so
 * nothing Media3 counts after it moves. 16-bit and float PCM, a 16-bit sample read as `v / 32768` and
 * written back rounded and held, as [SoundEffectProcessor] does.
 *
 * A MONO mix comes out STEREO, the one change it makes to the format. iOS and the web run the windows
 * on a stereo mix, and a reverb gives each channel a room of its own ([SoundOp.Reverb]), so on one
 * channel the room would be narrower here than there. The encoder is set up with whatever the graph
 * hands out after this (`AudioSampleExporter` reads `AudioGraph.getOutputAudioFormat`), so it takes
 * the stereo; every other width goes through as it came. Inactive with no window, which the builder
 * never hands it.
 */
@OptIn(UnstableApi::class)
class AudioEffectWindowsProcessor(private val windows: List<AudioEffectWindow>) : BaseAudioProcessor() {

    private var runner: AudioEffectRunner? = null

    /** The output frame the first frame after the last flush is. */
    private var firstFrame = 0L

    /** Up to [BLOCK_FRAMES] of the stream, a channel to an array, as the runner takes it. */
    private var block = emptyArray<FloatArray>()

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
        if (windows.isEmpty()) return AudioFormat.NOT_SET
        val encoding = inputAudioFormat.encoding
        if (encoding != C.ENCODING_PCM_16BIT && encoding != C.ENCODING_PCM_FLOAT) {
            throw UnhandledAudioFormatException("Expected 16 bit or float PCM.", inputAudioFormat)
        }
        if (inputAudioFormat.channelCount != 1) return inputAudioFormat
        return AudioFormat(inputAudioFormat.sampleRate, 2, encoding)
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        if (!inputBuffer.hasRemaining()) return
        val input = inputAudioFormat
        val run = runner ?: started()
        val sixteen = input.encoding == C.ENCODING_PCM_16BIT
        val inWidth = input.channelCount
        val width = outputAudioFormat.channelCount
        val frames = inputBuffer.remaining() / input.bytesPerFrame
        val out = replaceOutputBuffer(frames * outputAudioFormat.bytesPerFrame)
        var done = 0
        while (done < frames) {
            val count = min(BLOCK_FRAMES, frames - done)
            for (i in 0 until count) {
                for (c in 0 until inWidth) block[c][i] = if (sixteen) inputBuffer.short / 32768f else inputBuffer.float
                // A mono mix played from both channels.
                for (c in inWidth until width) block[c][i] = block[0][i]
            }
            run.process(block, 0, count)
            for (i in 0 until count) {
                for (c in 0 until width) {
                    if (sixteen) out.putShort(toShort(block[c][i])) else out.putFloat(block[c][i])
                }
            }
            done += count
        }
        // A buffer always holds whole frames; anything less is consumed rather than left to stall on.
        inputBuffer.position(inputBuffer.limit())
        out.flip()
    }

    /** Made again on the first sample after, when the format the mix plays in is known for certain. */
    override fun onFlush(streamMetadata: StreamMetadata) {
        runner = null
        firstFrame = frameOf(streamMetadata.positionOffsetUs, inputAudioFormat.sampleRate)
    }

    override fun onReset() {
        runner = null
        firstFrame = 0L
        block = emptyArray()
    }

    private fun started(): AudioEffectRunner {
        val format = outputAudioFormat
        val made = AudioEffectRunner(windows, format.sampleRate, firstFrame)
        runner = made
        if (block.size != format.channelCount) block = Array(format.channelCount) { FloatArray(BLOCK_FRAMES) }
        return made
    }

    private fun toShort(y: Float): Short = (y * 32768.0).roundToInt().coerceIn(-32768, 32767).toShort()

    private companion object {
        /** How many frames are converted at a time: a bound on [block], nothing more. */
        const val BLOCK_FRAMES = 4_096

        /** The frame [offsetUs] falls on at [sampleRate], rounded half up; 0 for none, or for no rate. */
        fun frameOf(offsetUs: Long, sampleRate: Int): Long =
            if (offsetUs <= 0L || sampleRate <= 0) 0L else (offsetUs * sampleRate + 500_000L) / 1_000_000L
    }
}
