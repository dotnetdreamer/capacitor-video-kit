package net.dotnetdreamer.videokit.videocomposer

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessingPipeline
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.GainProcessor
import com.google.common.collect.ImmutableList
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * One pass of a looping sound is exactly its piece of the output timeline, on the sample, whatever
 * Media3 decodes for it.
 *
 * THE 18.5 ms HOLE AT EVERY SEAM. On an Android render of the 12 s test tone (qa-sample.m4a, AAC with
 * the encoder's priming in its edit list) every pass was clipped at 12.000 s, and the clip end is
 * checked against frame timestamps that run ahead of the sound by the priming, so the last frame was
 * never decoded: 528_384 samples came out where 529_200 were due, and Media3 played the 816 missing
 * ones as silence, from 11.9917 s to 12.0102 s of the file. The plan now decodes a pass to the end of
 * its file (or past its cut), which is on the device to prove; what is pinned here is the other half,
 * that whatever a pass decodes it is then handed over at exactly its length - its own samples first,
 * silence only for what it truly lacks - so that the next pass starts on the very next sample.
 *
 * The processor is driven the way `AudioProcessingPipeline` drives one: configure, flush, then input
 * queued only once the previous output has been read, and output read until it says it has ended.
 */
class ExactLengthAudioProcessorTest {

    private val mono16 = AudioFormat(44_100, 1, C.ENCODING_PCM_16BIT)

    /** A 16 bit mono buffer of [frames] frames, each one its own index plus [from], so order shows. */
    private fun ramp(from: Int, frames: Int): ByteBuffer {
        val b = ByteBuffer.allocateDirect(frames * 2).order(ByteOrder.nativeOrder())
        for (i in 0 until frames) b.putShort(((from + i) % 30_000 + 1).toShort())
        b.flip()
        return b
    }

    /** Everything the processor hands over for [input], fed in [chunk]-frame buffers, then its end. */
    private fun run(p: ExactLengthAudioProcessor, format: AudioFormat, input: ByteBuffer, chunkBytes: Int): ByteArray {
        p.configure(format)
        p.flush(StreamMetadata.DEFAULT)
        val out = java.io.ByteArrayOutputStream()
        fun drain() {
            while (true) {
                val o = p.getOutput()
                if (!o.hasRemaining()) return
                val bytes = ByteArray(o.remaining())
                o.get(bytes)
                out.write(bytes)
            }
        }
        while (input.hasRemaining()) {
            val slice = input.duplicate().order(ByteOrder.nativeOrder())
            slice.limit(minOf(input.limit(), input.position() + chunkBytes))
            val view = ByteBuffer.allocateDirect(slice.remaining()).order(ByteOrder.nativeOrder())
            view.put(slice).flip()
            p.queueInput(view)
            assertFalse("the processor must take the whole buffer", view.hasRemaining())
            input.position(slice.limit())
            drain()
        }
        p.queueEndOfStream()
        var guard = 0
        while (!p.isEnded()) {
            drain()
            assertTrue("never ended", ++guard < 10_000)
        }
        drain()
        return out.toByteArray()
    }

    private fun shortsOf(bytes: ByteArray): ShortArray {
        val b = ByteBuffer.wrap(bytes).order(ByteOrder.nativeOrder())
        return ShortArray(bytes.size / 2) { b.short }
    }

    @Test
    fun `a pass that decodes the file's padding too is held to its length, and drops the rest`() {
        // 12 s at 44.1 kHz is 529_200 samples; the decoder handed over 208 more.
        val p = ExactLengthAudioProcessor(0L, 12_000_000L)
        val out = shortsOf(run(p, mono16, ramp(0, 529_408), chunkBytes = 2_048))
        assertEquals(529_200, out.size)
        // Its own samples, in order, to the very last one it has room for.
        assertEquals(1.toShort(), out[0])
        assertEquals(((529_199 % 30_000) + 1).toShort(), out[529_199])
    }

    @Test
    fun `a pass that comes up short is made up with silence after its own samples`() {
        // What a pass clipped at the file's length used to deliver: 816 samples short.
        val p = ExactLengthAudioProcessor(12_000_000L, 24_000_000L)
        val out = shortsOf(run(p, mono16, ramp(0, 528_384), chunkBytes = 2_048))
        assertEquals(529_200, out.size)
        assertEquals(((528_383 % 30_000) + 1).toShort(), out[528_383])
        for (i in 528_384 until 529_200) assertEquals("sample $i", 0.toShort(), out[i])
    }

    @Test
    fun `a pass with no sound at all is its whole length of silence`() {
        val p = ExactLengthAudioProcessor(0L, 1_000_000L)
        val out = shortsOf(run(p, mono16, ByteBuffer.allocateDirect(0), chunkBytes = 2_048))
        assertEquals(44_100, out.size)
        assertTrue(out.all { it == 0.toShort() })
    }

    /*
     * Passes laid end to end from a leading gap, at lengths that fall between samples. Counted each on
     * its own, their roundings would add up; counted off the timeline, every seam lands on the sample
     * `ceil(t * rate)`, which is also where Media3 ends a gap of `t` (`Util.durationUsToSampleCount`).
     */
    /** The samples from the top of the timeline to [us], rounded up: `ceil(us * rate / 1e6)`, exactly. */
    private fun samplesTo(us: Long, rate: Int): Long = (us * rate + 999_999L) / 1_000_000L

    @Test
    fun `seams land on the timeline's own samples however many passes there are`() {
        for (rate in listOf(44_100, 48_000, 22_050, 8_000)) {
            val gapUs = 1_000_001L
            val lenUs = 333_333L
            var total = samplesTo(gapUs, rate)
            var atUs = gapUs
            repeat(40) {
                total += ExactLengthAudioProcessor(atUs, atUs + lenUs).framesAt(rate)
                atUs += lenUs
                assertEquals("rate $rate at $atUs us", samplesTo(atUs, rate), total)
            }
        }
    }

    @Test
    fun `media3 is told no more than the pass's own length, and a position inside it is unchanged`() {
        val p = ExactLengthAudioProcessor(12_000_000L, 18_000_000L)
        // Decoded past its end: brought back to its length.
        assertEquals(6_000_000L, p.getDurationAfterProcessorApplied(6_500_000L))
        // A position is carried through as it is - above all the start, which is the start.
        assertEquals(0L, p.getDurationAfterProcessorApplied(0L))
        assertEquals(2_500_000L, p.getDurationAfterProcessorApplied(2_500_000L))
    }

    /*
     * THE FADES WENT THE FIRST TIME THIS RAN ON A PHONE. `AudioProcessingPipeline.flush` hands each
     * processor the stream's start mapped through `getDurationAfterProcessorApplied` of every one
     * before it, and this processor answered its length whatever it was asked. The gain after it was
     * told a 12 s pass started 12 s in: a 10 s fade in was already over on its first sample, and the
     * pass a fade out ran through was silent from its first. So the pair is run here as Media3 runs
     * it, through the pipeline and the real `GainProcessor`.
     */
    @Test
    fun `the gain after it still counts from the pass's first sample`() {
        val rate = 8_000
        val format = AudioFormat(rate, 1, C.ENCODING_PCM_16BIT)
        val pipeline = AudioProcessingPipeline(
            ImmutableList.of(
                ExactLengthAudioProcessor(12_000_000L, 13_000_000L),
                GainProcessor(RampGainProvider(level = 1f, fadeInUs = 1_000_000L)),
            ),
        )
        pipeline.configure(format)
        pipeline.flush(StreamMetadata.DEFAULT)
        val input = ByteBuffer.allocateDirect(2 * rate * 2).order(ByteOrder.nativeOrder())
        while (input.hasRemaining()) input.putShort(10_000)
        input.flip()
        val out = java.io.ByteArrayOutputStream()
        var guard = 0
        while (!pipeline.isEnded()) {
            if (input.hasRemaining()) pipeline.queueInput(input) else pipeline.queueEndOfStream()
            val o = pipeline.getOutput()
            val bytes = ByteArray(o.remaining())
            o.get(bytes)
            out.write(bytes)
            assertTrue("never ended", ++guard < 100_000)
        }
        val samples = shortsOf(out.toByteArray())
        assertEquals(rate, samples.size)
        // Up from silence over the pass's own first second, not already at the top.
        assertEquals(0, samples[0].toInt())
        assertEquals(5_000.0, samples[rate / 2].toDouble(), 2.0)
        assertEquals(9_998.0, samples[rate - 1].toDouble(), 2.0)
    }

    @Test
    fun `stereo float passes count frames, not samples`() {
        val stereoFloat = AudioFormat(48_000, 2, C.ENCODING_PCM_FLOAT)
        val p = ExactLengthAudioProcessor(0L, 500_000L)
        // 30_000 frames of 8 bytes where 24_000 are due.
        val input = ByteBuffer.allocateDirect(30_000 * 8).order(ByteOrder.nativeOrder())
        while (input.hasRemaining()) input.putFloat(0.5f)
        input.flip()
        val out = run(p, stereoFloat, input, chunkBytes = 4_096)
        assertEquals(24_000 * 8, out.size)
    }

    @Test
    fun `unsigned 8 bit silence is the middle of the range`() {
        val u8 = AudioFormat(8_000, 1, C.ENCODING_PCM_8BIT)
        val p = ExactLengthAudioProcessor(0L, 10_000L)
        val out = run(p, u8, ByteBuffer.allocateDirect(0), chunkBytes = 64)
        assertEquals(80, out.size)
        assertTrue(out.all { it == 0x80.toByte() })
    }

    @Test
    fun `a second flush starts the pass again`() {
        val p = ExactLengthAudioProcessor(0L, 100_000L)
        assertEquals(4_410, run(p, mono16, ramp(0, 5_000), chunkBytes = 1_000).size / 2)
        assertEquals(4_410, run(p, mono16, ramp(0, 100), chunkBytes = 1_000).size / 2)
    }

    @Test
    fun `it refuses what is not pcm`() {
        val p = ExactLengthAudioProcessor(0L, 1_000L)
        try {
            p.configure(AudioFormat(44_100, 2, C.ENCODING_AC3))
            throw AssertionError("configured for AC-3")
        } catch (expected: AudioProcessor.UnhandledAudioFormatException) {
            assertFalse(p.isActive())
        }
    }
}
