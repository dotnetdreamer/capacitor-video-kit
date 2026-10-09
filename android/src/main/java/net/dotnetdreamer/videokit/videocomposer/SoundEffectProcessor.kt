package net.dotnetdreamer.videokit.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException
import androidx.media3.common.audio.BaseAudioProcessor
import androidx.media3.common.util.UnstableApi
import java.nio.ByteBuffer
import kotlin.math.roundToInt

/**
 * One pass of a sound put through its [SoundEffect]: Media3's side of [SoundEffectChain].
 *
 * The builder puts it after the time-stretch of a sped-up sound and ahead of the pass's exact length
 * and its gain (`audioItem` in [CompositionBuilder]), so it hears the sound as it plays and the level
 * and the fades take down what it made - `ComposeMusic.effect`'s order on every engine. It changes no
 * length, so it is invisible to the arithmetic around it: the exact length counts the same samples
 * whether it is there or not.
 *
 * 16-bit and float PCM, which is what the decoders and Sonic hand over and the two encodings Media3's
 * own `GainProcessor` beside it takes. A 16-bit sample is read as `v / 32768` and written back
 * rounded and held to the format, as the contract says.
 *
 * A fresh chain after every flush, which Media3 calls before an item's first sample: every pass of a
 * sound is an item of its own and starts from a state at 0, as the web mix starts each repetition.
 */
@OptIn(UnstableApi::class)
class SoundEffectProcessor(private val effect: SoundEffect) : BaseAudioProcessor() {

    private var chain: SoundEffectChain? = null
    private var frame = DoubleArray(0)

    override fun onConfigure(inputAudioFormat: AudioFormat): AudioFormat {
        val encoding = inputAudioFormat.encoding
        if (encoding != C.ENCODING_PCM_16BIT && encoding != C.ENCODING_PCM_FLOAT) {
            throw UnhandledAudioFormatException("Expected 16 bit or float PCM.", inputAudioFormat)
        }
        return inputAudioFormat
    }

    override fun queueInput(inputBuffer: ByteBuffer) {
        if (!inputBuffer.hasRemaining()) return
        val format = inputAudioFormat
        val run = chain ?: started(format)
        val sixteen = format.encoding == C.ENCODING_PCM_16BIT
        val out = replaceOutputBuffer(inputBuffer.remaining())
        val channels = format.channelCount
        while (inputBuffer.remaining() >= format.bytesPerFrame) {
            for (c in 0 until channels) {
                frame[c] = if (sixteen) inputBuffer.short / 32768.0 else inputBuffer.float.toDouble()
            }
            run.processFrame(frame)
            for (c in 0 until channels) {
                if (sixteen) out.putShort(toShort(frame[c])) else out.putFloat(frame[c].toFloat())
            }
        }
        // A buffer always holds whole frames; anything less is consumed rather than left to stall on.
        inputBuffer.position(inputBuffer.limit())
        out.flip()
    }

    /** Made again on the first sample after, when the format the item plays in is known for certain. */
    override fun onFlush(streamMetadata: StreamMetadata) {
        chain = null
    }

    override fun onReset() {
        chain = null
        frame = DoubleArray(0)
    }

    private fun started(format: AudioFormat): SoundEffectChain {
        val made = SoundEffectChain(effect, format.sampleRate)
        chain = made
        frame = DoubleArray(maxOf(0, format.channelCount))
        return made
    }

    private fun toShort(y: Double): Short = (y * 32768.0).roundToInt().coerceIn(-32768, 32767).toShort()
}
