package net.dotnetdreamer.videokit.videocomposer

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessingPipeline
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import androidx.media3.common.audio.SonicAudioProcessor
import com.google.common.collect.ImmutableList
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * The audio effect layers on Android: the arithmetic [AudioEffectRunner] runs on the finished mix, and
 * Media3's side of it. The cases and the numbers are `audio-effect-windows.unit.test.ts`'s - the golden
 * numbers at the end are asserted by the TypeScript and the Swift tests too, to the same tolerance,
 * which is what keeps the three engines playing one slowed room and one megaphone over a post.
 */
class AudioEffectWindowsTest {

    private val rate = 48_000

    private fun frameAt(ms: Double): Long = AudioEffectWindow.frameAt(ms, rate)

    private fun window(startMs: Double, endMs: Double, speed: Double = 1.0, effect: SoundEffect? = null) =
        AudioEffectWindow(startMs, endMs, speed, effect)

    private fun gain(db: Double) = SoundEffect(false, listOf(SoundOp.Gain(db)))

    /** The megaphone at the middle of its sliders, exactly as the editor sends it (`SOUND_EFFECTS` in sound-effects.ts). */
    private val megaphone = SoundEffect(
        mono = true,
        ops = listOf(
            SoundOp.Highpass(600.0, BUTTERWORTH_Q),
            SoundOp.Highpass(600.0, BUTTERWORTH_Q),
            SoundOp.Lowpass(5_000.0, BUTTERWORTH_Q),
            SoundOp.Peak(1_800.0, 1.0, 6.0),
            SoundOp.Drive(20.0, 300.0),
            SoundOp.Lowpass(3_500.0, BUTTERWORTH_Q),
            SoundOp.Lowpass(3_500.0, BUTTERWORTH_Q),
            SoundOp.Gain(-4.0),
        ),
    )

    /** Slow + reverb's room at the middle of its sliders, exactly as the editor sends it. */
    private val slowReverb = SoundEffect(false, listOf(SoundOp.Reverb(3_500.0, 5_500.0, 0.5, 0.8)))

    /** The same room at the smallest (`room: 0`) and the largest (`room: 100`) the editor makes. */
    private val smallRoom = SoundEffect(false, listOf(SoundOp.Reverb(1_000.0, 8_000.0, 0.5, 0.8)))
    private val bigRoom = SoundEffect(false, listOf(SoundOp.Reverb(6_000.0, 3_000.0, 0.5, 0.8)))

    private fun tone(hz: Double, amplitude: Double, frames: Int, phase: Double = 0.0) =
        FloatArray(frames) { (amplitude * sin(2 * PI * hz * it / rate + phase)).toFloat() }

    /** A second of two tones, a channel each: `quiet` in the TypeScript. */
    private fun quiet() = listOf(tone(440.0, 0.5, rate), tone(660.0, 0.4, rate, 1.0))

    /** [channels] through [windows], handed over [piece] frames at a time, the first being [firstFrame]. */
    private fun run(
        windows: List<AudioEffectWindow>,
        channels: List<FloatArray>,
        piece: Int = Int.MAX_VALUE,
        firstFrame: Long = 0L,
    ): List<FloatArray> {
        val copies = Array(channels.size) { channels[it].copyOf() }
        val runner = AudioEffectRunner(windows, rate, firstFrame)
        val length = copies[0].size
        var from = 0
        while (from < length) {
            val count = min(piece, length - from)
            runner.process(copies, from, count)
            from += count
        }
        return copies.toList()
    }

    /** Upward zero crossings of [samples] between two frames: a tone's pitch, counted. */
    private fun crossings(samples: FloatArray, from: Int, to: Int): Int {
        var count = 0
        for (i in from + 1 until to) if (samples[i - 1] < 0f && samples[i] >= 0f) count++
        return count
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a window's steps ring for twice the longest reverb, and never under half a second`() {
        assertEquals(500.0, AudioEffectWindow.tailMs(null), 0.0)
        assertEquals(500.0, AudioEffectWindow.tailMs(megaphone), 0.0)
        assertEquals(7_000.0, AudioEffectWindow.tailMs(slowReverb), 0.0)
        assertEquals(12_000.0, AudioEffectWindow.tailMs(bigRoom), 0.0)
        assertEquals(500.0, AudioEffectWindow.tailMs(SoundEffect(false, listOf(SoundOp.Reverb(100.0, 8_000.0, 1.0, 1.0)))), 0.0)
    }

    @Test
    fun `frames are counted rounding half up`() {
        assertEquals(1_200L, frameAt(25.0))
        assertEquals(0L, frameAt(0.0104))
        assertEquals(1L, frameAt(0.0105))
        assertEquals(1L, AudioEffectWindow.frameAt(1_000.0 / 44_100, 44_100))
    }

    @Test
    fun `every frame outside a window and its tail is left exactly as it was`() {
        val input = quiet()
        val out = run(listOf(window(200.0, 300.0, effect = gain(-12.0))), input)
        val start = frameAt(200.0).toInt()
        val tailEnd = frameAt(300.0 + 500.0).toInt()
        for (c in 0..1) {
            assertArrayEquals(input[c].copyOfRange(0, start), out[c].copyOfRange(0, start), 0f)
            assertArrayEquals(input[c].copyOfRange(tailEnd, rate), out[c].copyOfRange(tailEnd, rate), 0f)
        }
    }

    @Test
    fun `a window comes in and goes out over its ramp, so it starts and ends where the mix is`() {
        val flat = listOf(FloatArray(rate) { 0.5f }, FloatArray(rate) { -0.5f })
        val out = run(listOf(window(100.0, 500.0, effect = gain(-6.020599913279624))), flat)
        val start = frameAt(100.0).toInt()
        val end = frameAt(500.0).toInt()
        val ramp = frameAt(AudioEffectWindow.RAMP_MS).toInt()
        assertEquals(0.5, out[0][start].toDouble(), 5e-7)
        assertEquals(0.375, out[0][start + ramp / 2].toDouble(), 5e-7)
        assertEquals(0.25, out[0][start + ramp].toDouble(), 5e-7)
        assertEquals(-0.25, out[1][(start + end) / 2].toDouble(), 5e-7)
        assertEquals(0.25, out[0][end - ramp].toDouble(), 5e-7)
        assertEquals(0.375, out[0][end - ramp / 2].toDouble(), 5e-7)
        assertEquals(0.5, out[0][end].toDouble(), 5e-7)
    }

    @Test
    fun `a window too short for both ramps squeezes them in`() {
        val out = run(listOf(window(100.0, 120.0, effect = gain(-40.0))), listOf(FloatArray(rate) { 0.5f }))
        val start = frameAt(100.0).toInt()
        val end = frameAt(120.0).toInt()
        // Ten milliseconds up, ten down, and never all the way in.
        assertEquals(0.5, out[0][start].toDouble(), 5e-7)
        assertEquals(0.005, out[0][start + (end - start) / 2].toDouble(), 5e-7)
        assertEquals(0.5, out[0][end].toDouble(), 5e-7)
    }

    @Test
    fun `the stream comes out the same whether it is handed over whole or in pieces`() {
        val windows = listOf(window(50.0, 400.0, 0.6, slowReverb), window(600.0, 700.0, effect = megaphone))
        val input = quiet()
        val whole = run(windows, input)
        for (piece in listOf(1, 7, 333, 4_096, 10_000)) {
            val pieces = run(windows, input, piece)
            for (c in 0..1) assertArrayEquals("piece $piece, channel $c", whole[c], pieces[c], 0f)
        }
    }

    @Test
    fun `a stream handed over from just before the window starts as it would from the beginning`() {
        val windows = listOf(window(200.0, 450.0, 0.75, slowReverb))
        val input = quiet()
        val whole = run(windows, input)
        val first = frameAt(200.0).toInt() - 1
        val tail = run(windows, input.map { it.copyOfRange(first, rate) }, piece = 977, firstFrame = first.toLong())
        for (c in 0..1) assertArrayEquals(whole[c].copyOfRange(first, rate), tail[c], 0f)
    }

    @Test
    fun `a slowed window plays lower as well as slower, and goes back to where the timeline is after it`() {
        val input = listOf(tone(1_000.0, 0.5, rate))
        val out = run(listOf(window(0.0, 500.0, 0.5)), input)
        val ramp = frameAt(AudioEffectWindow.RAMP_MS).toInt()
        val end = frameAt(500.0).toInt()
        // Slowed to half, a 1 kHz tone rises through 0 half as often over the same stretch.
        val heard = crossings(out[0], ramp, end - ramp).toDouble()
        assertEquals(crossings(input[0], ramp, end - ramp) / 2.0, heard, 5.0)
        // After it, with no steps to ring, the very mix.
        for (i in end until rate step 13) assertEquals("sample $i", input[0][i], out[0][i], 1e-6f)
    }

    @Test
    fun `a slowed window reads nothing ahead of the frame it is making`() {
        // A click one frame after the window starts cannot be heard before it.
        val input = listOf(FloatArray(2_000).also { it[1_001] = 1f })
        val out = run(listOf(window(1_000.0 / rate * 1000, 1_500.0 / rate * 1000, 0.9)), input)
        assertEquals(0f, out[0][1_000], 0f)
    }

    @Test
    fun `a window's steps ring on after it, for its tail and no longer`() {
        val end = frameAt(700.0).toInt()
        val input = List(2) { tone(300.0, 0.5, 3 * rate).also { it.fill(0f, end, it.size) } }
        val out = run(listOf(window(500.0, 700.0, effect = smallRoom)), input)
        val tailEnd = end + frameAt(AudioEffectWindow.tailMs(smallRoom)).toInt()
        // The mix is silent after the window: what is heard there is the room.
        var rang = 0f
        for (i in end until end + rate / 10) rang = max(rang, abs(out[0][i]))
        assertTrue("rang $rang", rang > 0.01f)
        for (i in tailEnd until out[0].size) assertEquals("sample $i", 0f, out[0][i], 0f)
    }

    @Test
    fun `a mono window folds the channels inside it, and leaves them apart outside it`() {
        val out = run(listOf(window(200.0, 400.0, effect = megaphone)), quiet())
        val ramp = frameAt(AudioEffectWindow.RAMP_MS).toInt()
        for (i in frameAt(200.0).toInt() + ramp until frameAt(400.0).toInt() - ramp step 17) {
            assertEquals("sample $i", out[0][i], out[1][i], 0f)
        }
        assertTrue(out[0][100] != out[1][100])
    }

    @Test
    fun `each window runs on what the one before it left`() {
        val first = window(100.0, 300.0, effect = slowReverb)
        val second = window(300.0, 500.0, effect = megaphone)
        val both = run(listOf(first, second), quiet())
        val oneThenTheOther = run(listOf(second), run(listOf(first), quiet()))
        for (c in 0..1) assertArrayEquals(both[c], oneThenTheOther[c], 0f)
    }

    @Test
    fun `what a window makes is held to -1 to 1`() {
        val out = run(listOf(window(100.0, 400.0, effect = gain(12.0))), listOf(FloatArray(rate) { 1f }))
        assertTrue(out[0].all { abs(it) <= 1f })
    }

    @Test
    fun `a slowed window holds about what it has fallen behind, and lets go of it after its end`() {
        // Twenty seconds at 0.9x fall two seconds behind; remembering all of it would be the twenty.
        val start = frameAt(1_000.0)
        val end = frameAt(21_000.0)
        val lag = ((end - start) / 10).toInt()
        val runner = AudioEffectRunner(listOf(window(1_000.0, 21_000.0, 0.9)), rate)
        val piece = arrayOf(FloatArray(4_096))
        var most = 0
        var at = 0L
        while (at < end + 4_096) {
            runner.process(piece)
            at += 4_096
            most = max(most, runner.heldFrames)
        }
        assertTrue("held $most", most in 1..4 * (lag + 4_096))
        assertTrue("held $most", most < (end - start) / 2)
        assertEquals(0, runner.heldFrames)
    }

    /*
     * The same numbers as `audio-effect-windows.unit.test.ts` and `AudioEffectWindowsTests.swift`: the
     * slow + reverb layer at its middles over 25..125 ms at 0.8x, then the megaphone over 150..190 ms, on
     * the fragment the sound effects' golden tests use, a fifth of a second long, every sample a float.
     */
    private fun goldenFragment(): List<FloatArray> {
        val left = FloatArray(9_600) { (0.6 * sin(2 * PI * 440 * it / rate) + 0.2 * sin(2 * PI * 3100 * it / rate)).toFloat() }
        val right = FloatArray(9_600) { (0.3 * sin(2 * PI * 220 * it / rate + 0.5)).toFloat() }
        return listOf(left, right)
    }

    private val goldenWindows: List<AudioEffectWindow>
        get() = listOf(window(25.0, 125.0, 0.8, slowReverb), window(150.0, 190.0, effect = megaphone))

    private fun assertGolden(left: FloatArray, right: FloatArray) {
        for ((i, l, r) in GOLDEN) {
            assertEquals("sample $i, left", l, left[i].toDouble(), 5e-7)
            assertEquals("sample $i, right", r, right[i].toDouble(), 5e-7)
        }
    }

    @Test
    fun `the windows match the golden numbers every engine is held to`() {
        val (left, right) = goldenFragment()
        AudioEffectRunner(goldenWindows, rate).process(arrayOf(left, right))
        assertGolden(left, right)
    }

    /* ------------------------------------------------------------------------------------- */
    /* Media3's side                                                                           */
    /* ------------------------------------------------------------------------------------- */

    /** Interleaved float PCM of [channels], as Media3 hands a buffer over: direct, in the platform's order. */
    private fun floatPcm(channels: List<FloatArray>): ByteBuffer {
        val pcm = ByteBuffer.allocateDirect(channels[0].size * channels.size * 4).order(ByteOrder.nativeOrder())
        for (i in channels[0].indices) for (channel in channels) pcm.putFloat(channel[i])
        pcm.flip()
        return pcm
    }

    private fun shortPcm(channels: List<ShortArray>): ByteBuffer {
        val pcm = ByteBuffer.allocateDirect(channels[0].size * channels.size * 2).order(ByteOrder.nativeOrder())
        for (i in channels[0].indices) for (channel in channels) pcm.putShort(channel[i])
        pcm.flip()
        return pcm
    }

    /** Interleaved float PCM back into its [width] channels. */
    private fun floatsOf(pcm: ByteBuffer, width: Int): List<FloatArray> {
        val frames = pcm.remaining() / (4 * width)
        return List(width) { c -> FloatArray(frames) { pcm.getFloat((it * width + c) * 4) } }
    }

    private fun shortsOf(pcm: ByteBuffer): ShortArray = ShortArray(pcm.remaining() / 2) { pcm.getShort(it * 2) }

    /** A sample as the processor writes one in 16 bits: rounded, and held to the format. */
    private fun sixteen(y: Float): Short = (y * 32768.0).roundToInt().coerceIn(-32768, 32767).toShort()

    /**
     * What [processors] make of [input], as Media3's own pipeline drives them: configured for [format],
     * flushed at [offsetUs], and fed [piece] frames at a time, each buffer once the last one's output
     * has been read. The format that came out, and the sound.
     */
    private fun pipe(
        processors: List<AudioProcessor>,
        format: AudioFormat,
        input: ByteBuffer,
        piece: Int,
        offsetUs: Long = 0L,
    ): Pair<AudioFormat, ByteBuffer> {
        val pipeline = AudioProcessingPipeline(ImmutableList.copyOf(processors))
        pipeline.configure(format)
        pipeline.flush(StreamMetadata.Builder().setPositionOffsetUs(offsetUs).build())
        val out = ByteArrayOutputStream()
        fun drain() {
            while (true) {
                val o = pipeline.output
                if (!o.hasRemaining()) return
                val bytes = ByteArray(o.remaining())
                o.get(bytes)
                out.write(bytes)
            }
        }
        val source = input.duplicate().order(ByteOrder.nativeOrder())
        val chunk = ByteBuffer.allocateDirect(piece * format.bytesPerFrame).order(ByteOrder.nativeOrder())
        while (source.hasRemaining()) {
            val slice = source.duplicate().order(ByteOrder.nativeOrder())
            slice.limit(min(source.limit(), source.position() + chunk.capacity()))
            chunk.clear()
            chunk.put(slice).flip()
            source.position(slice.limit())
            pipeline.queueInput(chunk)
            assertFalse("the processor must take the whole buffer", chunk.hasRemaining())
            drain()
        }
        pipeline.queueEndOfStream()
        var guard = 0
        while (!pipeline.isEnded) {
            drain()
            assertTrue("never ended", ++guard < 1_000)
        }
        drain()
        return pipeline.outputAudioFormat to ByteBuffer.wrap(out.toByteArray()).order(ByteOrder.nativeOrder())
    }

    @Test
    fun `media3's side matches the golden numbers too`() {
        val (left, right) = goldenFragment()
        val format = AudioFormat(rate, 2, C.ENCODING_PCM_FLOAT)
        val (outFormat, out) = pipe(listOf(AudioEffectWindowsProcessor(goldenWindows)), format, floatPcm(listOf(left, right)), piece = 333)
        assertEquals(format, outFormat)
        val (l, r) = floatsOf(out, 2)
        assertEquals(9_600, l.size)
        assertGolden(l, r)
    }

    @Test
    fun `media3's side comes out the same whatever size of buffer it is handed`() {
        val windows = listOf(window(50.0, 400.0, 0.6, slowReverb), window(600.0, 700.0, effect = megaphone))
        val input = quiet()
        val whole = run(windows, input)
        for (piece in listOf(1, 7, 4_096)) {
            val (_, out) = pipe(listOf(AudioEffectWindowsProcessor(windows)), AudioFormat(rate, 2, C.ENCODING_PCM_FLOAT), floatPcm(input), piece)
            val got = floatsOf(out, 2)
            for (c in 0..1) assertArrayEquals("piece $piece, channel $c", whole[c], got[c], 0f)
        }
    }

    @Test
    fun `media3's side reads 16-bit sound as v over 32768 and writes it back rounded, untouched outside the window`() {
        val rate44 = 44_100
        val left = ShortArray(rate44) { (0.5 * sin(2 * PI * 440 * it / rate44) * 32767).roundToInt().toShort() }
        val right = ShortArray(rate44) { (0.4 * sin(2 * PI * 660 * it / rate44 + 1) * 32767).roundToInt().toShort() }
        val windows = listOf(window(200.0, 300.0, effect = megaphone))
        // What the runner makes of the very samples the buffer holds, rounded as the processor rounds.
        val heard = arrayOf(FloatArray(rate44) { left[it] / 32768f }, FloatArray(rate44) { right[it] / 32768f })
        AudioEffectRunner(windows, rate44).process(heard)
        val expected = ShortArray(2 * rate44) { sixteen(heard[it % 2][it / 2]) }
        val format = AudioFormat(rate44, 2, C.ENCODING_PCM_16BIT)
        val (outFormat, out) = pipe(listOf(AudioEffectWindowsProcessor(windows)), format, shortPcm(listOf(left, right)), piece = 1_000)
        assertEquals(format, outFormat)
        val got = shortsOf(out)
        assertArrayEquals(expected, got)
        // Before the window and after its tail, the very samples that came in.
        val start = AudioEffectWindow.frameAt(200.0, rate44).toInt()
        val tailEnd = AudioEffectWindow.frameAt(300.0 + 500.0, rate44).toInt()
        for (i in (0 until start) + (tailEnd until rate44)) {
            assertEquals("frame $i", left[i], got[2 * i])
            assertEquals("frame $i", right[i], got[2 * i + 1])
        }
        assertTrue((start until tailEnd).any { got[2 * it] != left[it] })
    }

    @Test
    fun `media3's side counts its frames from where it was flushed`() {
        val windows = listOf(window(200.0, 450.0, 0.75, slowReverb))
        val input = quiet()
        val whole = run(windows, input)
        // 199_979 us is frame 9_599.49 at 48 kHz: frame 9_599, the one before the window.
        val first = 9_599
        assertEquals(frameAt(200.0) - 1, first.toLong())
        val rest = floatPcm(input.map { it.copyOfRange(first, rate) })
        val format = AudioFormat(rate, 2, C.ENCODING_PCM_FLOAT)
        val (_, out) = pipe(listOf(AudioEffectWindowsProcessor(windows)), format, rest, piece = 977, offsetUs = 199_979L)
        val got = floatsOf(out, 2)
        for (c in 0..1) assertArrayEquals(whole[c].copyOfRange(first, rate), got[c], 0f)
        // Flushed at 0 instead, the same samples would be heard 9_599 frames early.
        val (_, early) = pipe(listOf(AudioEffectWindowsProcessor(windows)), format, rest, piece = 977)
        assertFalse(floatsOf(early, 2)[0].contentEquals(got[0]))
    }

    @Test
    fun `a flush half a frame in counts from the frame it rounds up to`() {
        // 5 ms at 44.1 kHz is frame 220.5, which every engine rounds to 221.
        val rate44 = 44_100
        val windows = listOf(window(221.0 / 44.1, 1_000.0, effect = gain(-12.0)))
        val input = FloatArray(4_410) { 0.5f }
        val (_, out) = pipe(listOf(AudioEffectWindowsProcessor(windows)), AudioFormat(rate44, 1, C.ENCODING_PCM_FLOAT), floatPcm(listOf(input)), piece = 100, offsetUs = 5_000L)
        val got = floatsOf(out, 2)[0]
        fun from(firstFrame: Long) = input.copyOf().also { AudioEffectRunner(windows, rate44, firstFrame).process(arrayOf(it)) }
        assertArrayEquals(from(221L), got, 0f)
        assertFalse(from(220L).contentEquals(got))
    }

    /*
     * Media3's mix can be mono - a post whose only sound is a voiceover, which is recorded in mono, or
     * whose first sound is a mono clip - where iOS and the web always mix in stereo. Run as the audio
     * graph runs it, ahead of the encoder's resampler (inactive at one rate), and read back the format the
     * graph hands the encoder.
     */
    @Test
    fun `a mono mix comes out stereo, its room as wide as a stereo mix's, and the encoder is set up for that`() {
        val windows = listOf(window(100.0, 400.0, effect = slowReverb))
        val mono = ShortArray(rate) { (0.5 * sin(2 * PI * 440 * it / rate) * 32767).roundToInt().toShort() }
        val (format, out) = pipe(
            listOf(AudioEffectWindowsProcessor(windows), SonicAudioProcessor()),
            AudioFormat(rate, 1, C.ENCODING_PCM_16BIT),
            shortPcm(listOf(mono)),
            piece = 1_000,
        )
        assertEquals(AudioFormat(rate, 2, C.ENCODING_PCM_16BIT), format)
        // The one channel played from both, each then in a room of its own.
        val heard = run(windows, List(2) { FloatArray(rate) { i -> mono[i] / 32768f } })
        val got = shortsOf(out)
        assertArrayEquals(ShortArray(2 * rate) { sixteen(heard[it % 2][it / 2]) }, got)
        assertTrue((0 until rate).any { got[2 * it] != got[2 * it + 1] })
    }

    @Test
    fun `media3's side starts afresh after every flush`() {
        val windows = listOf(window(50.0, 300.0, 0.8, slowReverb))
        val p = AudioEffectWindowsProcessor(windows)
        val format = AudioFormat(rate, 2, C.ENCODING_PCM_FLOAT)
        val expected = run(windows, quiet())
        for (piece in listOf(512, 100)) {
            val got = floatsOf(pipe(listOf(p), format, floatPcm(quiet()), piece).second, 2)
            for (c in 0..1) assertArrayEquals("piece $piece, channel $c", expected[c], got[c], 0f)
        }
    }

    @Test
    fun `media3's side is inactive with no window`() {
        val p = AudioEffectWindowsProcessor(emptyList())
        assertEquals(AudioFormat.NOT_SET, p.configure(AudioFormat(rate, 2, C.ENCODING_PCM_16BIT)))
        assertFalse(p.isActive)
        assertTrue(AudioEffectWindowsProcessor(goldenWindows).apply { configure(AudioFormat(rate, 2, C.ENCODING_PCM_16BIT)) }.isActive)
    }

    @Test
    fun `media3's side refuses an encoding it cannot treat`() {
        try {
            AudioEffectWindowsProcessor(goldenWindows).configure(AudioFormat(rate, 2, C.ENCODING_PCM_24BIT))
            fail("expected an unhandled format")
        } catch (e: AudioProcessor.UnhandledAudioFormatException) {
            // As Media3's own GainProcessor answers it.
        }
    }

    private companion object {
        /** A second-order Butterworth's Q, `Math.SQRT1_2` as the TypeScript writes it. */
        const val BUTTERWORTH_Q = 0.7071067811865476

        /** `GOLDEN` in audio-effect-windows.unit.test.ts: a frame, then the left channel and the right there. */
        val GOLDEN = listOf(
            Triple(0, 0.0, 0.1438276618719101),
            Triple(1199, 0.044410355389118195, -0.13618730008602142),
            Triple(1200, -4.215013398939848e-15, -0.1438276618719101),
            Triple(1201, -0.044400833547115326, -0.15132714807987213),
            Triple(1500, -0.49185290932655334, -0.11205031722784042),
            Triple(2000, 0.032768141478300095, 0.12249194085597992),
            Triple(2640, -0.2707182765007019, -0.18519802391529083),
            Triple(3000, 0.4564398229122162, 0.21684326231479645),
            Triple(4000, 0.05051703006029129, -0.1985909789800644),
            Triple(5000, -0.5568563342094421, -0.011580999940633774),
            Triple(5500, 0.22359101474285126, 0.2720637321472168),
            Triple(5999, 0.08727562427520752, -0.1298135370016098),
            Triple(6000, 0.04416274279356003, -0.1372629702091217),
            Triple(6500, -0.6737513542175293, -0.22825460135936737),
            Triple(7000, 0.5595630407333374, 0.23166373372077942),
            Triple(7199, -0.1436537653207779, 0.13226771354675293),
            Triple(7200, -0.016098592430353165, 0.13931874930858612),
            Triple(7700, -0.15952368080615997, 0.14356045424938202),
            Triple(8000, 0.03796369954943657, -0.05775051191449165),
            Triple(8160, 0.07709841430187225, 0.07709841430187225),
            Triple(8500, -0.13546541333198547, 0.08452267944812775),
            Triple(9000, 0.35746344923973083, 0.27276092767715454),
            Triple(9119, -0.16030138731002808, -0.20032526552677155),
            Triple(9120, -0.102406345307827, -0.1977843940258026),
            Triple(9599, -0.3330191373825073, 0.15811549127101898),
        )
    }
}
