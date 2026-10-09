package net.dotnetdreamer.videokit.videocomposer

import androidx.media3.common.C
import androidx.media3.common.audio.AudioProcessor.AudioFormat
import androidx.media3.common.audio.AudioProcessor.StreamMetadata
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test
import java.nio.ByteBuffer
import java.nio.ByteOrder
import kotlin.math.PI
import kotlin.math.abs
import kotlin.math.roundToInt
import kotlin.math.sin

/**
 * A sound's effect on Android: the parser's rules, the arithmetic [SoundEffectChain] runs, and Media3's
 * side of it. The rules and the numbers are `sound-effects.unit.test.ts`'s - the golden fragment at the
 * end is asserted by the TypeScript and the Swift tests too, to the same tolerance, which is what keeps
 * the three engines playing one megaphone.
 */
class SoundEffectTest {

    /** The megaphone exactly as the editor sends it (`SOUND_EFFECTS` in sound-effects.ts). */
    private val megaphoneJson = """
        {"mono":true,"ops":[
          {"op":"highpass","hz":600,"q":0.7071067811865476},
          {"op":"highpass","hz":600,"q":0.7071067811865476},
          {"op":"lowpass","hz":5000,"q":0.7071067811865476},
          {"op":"peak","hz":1800,"q":1,"db":6},
          {"op":"drive","db":20,"followMs":300},
          {"op":"lowpass","hz":3500,"q":0.7071067811865476},
          {"op":"lowpass","hz":3500,"q":0.7071067811865476},
          {"op":"gain","db":-4}
        ]}
    """.trimIndent()

    private fun specWith(effect: Any?): JSONObject = JSONObject(
        """
        {
          "jobId": "job-1", "batchId": "post-1",
          "clips": [{ "key": "a", "uri": "file:///a.mp4", "inMs": 0, "outMs": 2000,
                      "speed": 1, "volume": 1, "muted": false, "fit": "contain" }],
          "output": { "width": 720, "height": 1280, "fps": 30, "videoBitrate": 4000000, "audioBitrate": 128000 },
          "filter": [], "overlays": [],
          "audio": { "originalMuted": false, "originalVolume": 1, "voiceover": [],
                     "music": { "uri": "file:///m.m4a", "inMs": 0, "outMs": 5000 } },
          "posterAtMs": 0
        }
        """.trimIndent(),
    ).apply { if (effect != null) getJSONObject("audio").getJSONObject("music").put("effect", effect) }

    private fun parsed(effect: Any?): SoundEffect? = ComposeSpecParser.parse(specWith(effect)).audio.music!!.effect

    private val megaphone: SoundEffect get() = parsed(JSONObject(megaphoneJson))!!

    private fun refusal(effect: Any): String {
        try {
            ComposeSpecParser.parse(specWith(effect))
        } catch (e: SpecException) {
            return e.message!!.removePrefix("invalid_spec:audio.music.effect").removePrefix(".")
        }
        return "accepted"
    }

    /** [frames] of a sound through [effect] at [rate], channel by channel, as the processor hands them over. */
    private fun through(effect: SoundEffect, rate: Int, vararg channels: FloatArray): List<FloatArray> {
        val out = channels.map { it.copyOf() }
        val chain = SoundEffectChain(effect, rate)
        val frame = DoubleArray(out.size)
        for (i in out[0].indices) {
            for (c in out.indices) frame[c] = out[c][i].toDouble()
            chain.processFrame(frame)
            for (c in out.indices) out[c][i] = frame[c].toFloat()
        }
        return out
    }

    private fun sine(hz: Double, amplitude: Double, frames: Int, rate: Int = 48_000) =
        FloatArray(frames) { (amplitude * sin(2 * PI * hz * it / rate)).toFloat() }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `the megaphone the editor sends is read as it was sent`() {
        val effect = megaphone
        assertTrue(effect.mono)
        assertEquals(8, effect.ops.size)
        assertEquals(SoundOp.Highpass(600.0, 0.7071067811865476), effect.ops[0])
        assertEquals(SoundOp.Drive(20.0, 300.0), effect.ops[4])
        assertEquals(SoundOp.Gain(-4.0), effect.ops[7])
    }

    @Test
    fun `no effect, and one that does nothing, is none`() {
        assertNull(parsed(null))
        assertNull(parsed(JSONObject.NULL))
        assertNull(parsed(JSONObject()))
        assertNull(parsed(JSONObject("""{"ops":[]}""")))
        assertEquals(SoundEffect(true, emptyList()), parsed(JSONObject("""{"mono":true}""")))
    }

    @Test
    fun `a shape no engine could play is refused with the path that broke, in the browser's order`() {
        assertEquals("", refusal("megaphone"))
        assertEquals("mono", refusal(JSONObject("""{"mono":"yes","ops":[]}""")))
        assertEquals("ops", refusal(JSONObject("""{"ops":{}}""")))
        assertEquals("wet", refusal(JSONObject("""{"ops":[],"wet":0.5}""")))
        // The alphabetically first of several, as iOS and the browser name it.
        assertEquals("alpha", refusal(JSONObject("""{"zeta":1,"ops":[],"alpha":2}""")))
        assertEquals("ops[0]", refusal(JSONObject("""{"ops":[7]}""")))
        assertEquals("ops[0].op", refusal(JSONObject("""{"ops":[{"op":"reverb"}]}""")))
        assertEquals("ops[1].hz", refusal(JSONObject("""{"ops":[{"op":"gain","db":1},{"op":"lowpass","q":1}]}""")))
        // A string that spells a number is not one, as the browser reads it.
        assertEquals("ops[0].hz", refusal(JSONObject("""{"ops":[{"op":"lowpass","hz":"600","q":1}]}""")))
        assertEquals("ops[0].db", refusal(JSONObject("""{"ops":[{"op":"peak","hz":1000,"q":1}]}""")))
        assertEquals("ops[0].followMs", refusal(JSONObject("""{"ops":[{"op":"drive","db":6,"followMs":"slow"}]}""")))
        assertEquals("ops[0].hz", refusal(JSONObject("""{"ops":[{"op":"gain","db":1,"hz":10}]}""")))
        val many = (0..SoundEffect.MAX_OPS).joinToString(",", "[", "]") { """{"op":"gain","db":0}""" }
        assertEquals("ops at most ${SoundEffect.MAX_OPS} steps", refusal(JSONObject("""{"ops":$many}""")))
        // In order: mono, ops, the unknown keys, the count; then a step's op, its numbers, its keys.
        assertEquals("mono", refusal(JSONObject("""{"mono":1,"ops":1,"extra":1}""")))
        assertEquals("ops", refusal(JSONObject("""{"ops":1,"extra":1}""")))
        assertEquals("extra", refusal(JSONObject("""{"ops":[{"op":"nope"}],"extra":1}""")))
        assertEquals("ops[0].hz", refusal(JSONObject("""{"ops":[{"op":"peak","extra":1}]}""")))
    }

    @Test
    fun `every number is held to its range rather than refused`() {
        val effect = parsed(
            JSONObject(
                """{"ops":[{"op":"highpass","hz":1,"q":0},{"op":"lowpass","hz":96000,"q":50},
                   {"op":"peak","hz":1000,"q":1,"db":-99},{"op":"drive","db":99,"followMs":0},
                   {"op":"drive","db":-3},{"op":"gain","db":60}]}""",
            ),
        )!!
        assertEquals(
            listOf(
                SoundOp.Highpass(10.0, 0.1),
                SoundOp.Lowpass(20_000.0, 10.0),
                SoundOp.Peak(1000.0, 1.0, -24.0),
                SoundOp.Drive(40.0, 1.0),
                SoundOp.Drive(0.0, null),
                SoundOp.Gain(24.0),
            ),
            effect.ops,
        )
    }

    @Test
    fun `a quiet sound is driven as hard as a loud one and stays as quiet`() {
        val loud = sine(440.0, 0.8, 24_000)
        val quiet = FloatArray(loud.size) { loud[it] / 16f }
        val a = through(megaphone, 48_000, loud)[0]
        val b = through(megaphone, 48_000, quiet)[0]
        var worst = 0.0
        for (i in 960 until a.size) worst = maxOf(worst, abs(a[i] / 16.0 - b[i]))
        assertTrue("worst $worst", worst < 1e-7)
    }

    @Test
    fun `silence stays silent, and a sound falls back to exact silence`() {
        assertTrue(through(megaphone, 48_000, FloatArray(4_800))[0].all { it == 0f })
        val burst = FloatArray(3 * 48_000)
        sine(500.0, 0.9, 4_800).copyInto(burst)
        val after = through(megaphone, 48_000, burst)[0]
        assertTrue(after.copyOfRange(2 * 48_000, 3 * 48_000).all { it == 0f })
    }

    /*
     * The same fragment `sound-effects.unit.test.ts` and `SoundEffectTests.swift` hold their engines
     * to: stereo at 48 kHz, every sample a float as each engine reads one, through the megaphone. A
     * change to the arithmetic in one engine is a change to all three, and to all three tests.
     */
    @Test
    fun `the megaphone matches the golden numbers every engine is held to`() {
        val rate = 48_000
        val left = FloatArray(2_400) { (0.6 * sin(2 * PI * 440 * it / rate) + 0.2 * sin(2 * PI * 3100 * it / rate)).toFloat() }
        val right = FloatArray(2_400) { (0.3 * sin(2 * PI * 220 * it / rate + 0.5)).toFloat() }
        val (l, r) = through(megaphone, rate, left, right)
        val golden = listOf(
            0 to 0.000004868781616096385,
            1 to 0.00005642078031087294,
            2 to 0.0003210754366591573,
            3 to 0.001207839697599411,
            50 to -0.10473176091909409,
            100 to -0.055209930986166,
            480 to 0.03146327659487724,
            1000 to -0.03916871175169945,
            1500 to 0.11145441234111786,
            2399 to 0.043290454894304276,
        )
        for ((i, value) in golden) {
            assertEquals("sample $i", value, l[i].toDouble(), 1e-6)
            assertEquals("sample $i, the other channel", l[i], r[i])
        }
    }

    /* ------------------------------------------------------------------------------------- */

    /** Everything [p] hands over for [input], fed in buffers of [chunkFrames] frames. */
    private fun process(p: SoundEffectProcessor, format: AudioFormat, input: ByteBuffer, chunkFrames: Int): ByteBuffer {
        p.configure(format)
        p.flush(StreamMetadata.DEFAULT)
        val out = ByteBuffer.allocate(input.remaining()).order(ByteOrder.nativeOrder())
        while (input.hasRemaining()) {
            val take = minOf(input.remaining(), chunkFrames * format.bytesPerFrame)
            val chunk = ByteBuffer.allocateDirect(take).order(ByteOrder.nativeOrder())
            val slice = input.duplicate().order(ByteOrder.nativeOrder())
            slice.limit(input.position() + take)
            chunk.put(slice).flip()
            input.position(input.position() + take)
            p.queueInput(chunk)
            assertTrue("the processor must take the whole buffer", !chunk.hasRemaining())
            out.put(p.output)
        }
        p.queueEndOfStream()
        out.put(p.output)
        assertTrue(p.isEnded)
        out.flip()
        return out
    }

    @Test
    fun `media3's side plays 16-bit sound through the chain, in any size of buffer`() {
        val rate = 44_100
        val left = sine(440.0, 0.5, 4_410, rate)
        val right = sine(990.0, 0.25, 4_410, rate)
        val pcm = ByteBuffer.allocateDirect(left.size * 4).order(ByteOrder.nativeOrder())
        for (i in left.indices) {
            pcm.putShort((left[i] * 32768).roundToInt().toShort())
            pcm.putShort((right[i] * 32768).roundToInt().toShort())
        }
        pcm.flip()
        // What the chain makes of the very samples the buffer holds, rounded as the processor rounds.
        val heard = through(
            megaphone,
            rate,
            FloatArray(left.size) { pcm.getShort(it * 4) / 32768f },
            FloatArray(left.size) { pcm.getShort(it * 4 + 2) / 32768f },
        )
        val expected = ShortArray(left.size * 2) {
            val y = heard[it % 2][it / 2].toDouble()
            (y * 32768).roundToInt().coerceIn(-32768, 32767).toShort()
        }
        val out = process(SoundEffectProcessor(megaphone), AudioFormat(rate, 2, C.ENCODING_PCM_16BIT), pcm, 333)
        val got = ShortArray(out.remaining() / 2) { out.getShort(it * 2) }
        // Within a step of rounding: the reference ran on floats, the processor on the shorts themselves.
        assertEquals(expected.size, got.size)
        for (i in got.indices) assertTrue("sample $i: ${got[i]} vs ${expected[i]}", abs(got[i] - expected[i]) <= 1)
    }

    @Test
    fun `media3's side plays float sound, and starts afresh after every flush`() {
        val rate = 48_000
        val tone = sine(700.0, 0.5, 2_400, rate)
        val pcm = ByteBuffer.allocateDirect(tone.size * 4).order(ByteOrder.nativeOrder())
        for (v in tone) pcm.putFloat(v)
        pcm.flip()
        val p = SoundEffectProcessor(megaphone)
        val format = AudioFormat(rate, 1, C.ENCODING_PCM_FLOAT)
        val first = process(p, format, pcm.duplicate().order(ByteOrder.nativeOrder()), 512)
        val second = process(p, format, pcm.duplicate().order(ByteOrder.nativeOrder()), 100)
        val expected = through(megaphone, rate, tone)[0]
        val a = FloatArray(first.remaining() / 4) { first.getFloat(it * 4) }
        val b = FloatArray(second.remaining() / 4) { second.getFloat(it * 4) }
        assertArrayEquals(expected, a, 1e-7f)
        // The second pass is not the first one's continuation: every pass of a sound starts at 0.
        assertArrayEquals(expected, b, 1e-7f)
    }

    @Test
    fun `media3's side refuses an encoding it cannot treat`() {
        try {
            SoundEffectProcessor(megaphone).configure(AudioFormat(48_000, 2, C.ENCODING_PCM_24BIT))
            fail("expected an unhandled format")
        } catch (e: androidx.media3.common.audio.AudioProcessor.UnhandledAudioFormatException) {
            // As Media3's own GainProcessor answers it.
        }
    }
}
