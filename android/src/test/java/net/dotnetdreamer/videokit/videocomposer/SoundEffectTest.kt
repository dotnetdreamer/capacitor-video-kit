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
import kotlin.math.sqrt

/**
 * A sound's effect on Android: the parser's rules, the arithmetic [SoundEffectChain] runs, and Media3's
 * side of it. The rules and the numbers are `sound-effects.unit.test.ts`'s - the golden fragments, the
 * megaphone's and the reverb's, are asserted by the TypeScript and the Swift tests too, to the same
 * tolerance, which is what keeps the three engines playing one megaphone and one room.
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

    /**
     * Slow + reverb's room at the middle of its sliders, exactly as the editor sends it
     * (`SOUND_EFFECTS` in sound-effects.ts). Its slowing is the sound's own speed, not a step.
     */
    private val slowReverbJson = """{"ops":[{"op":"reverb","decayMs":3500,"dampHz":5500,"wet":0.5,"dry":0.8}]}"""

    /** A room as the reverb's tests measure one - `room()` in sound-effects.unit.test.ts - all tail unless asked. */
    private fun room(decayMs: Double = 2_000.0, dampHz: Double = 6_000.0, wet: Double = 1.0, dry: Double = 0.0) =
        SoundEffect(false, listOf(SoundOp.Reverb(decayMs, dampHz, wet, dry)))

    /** A click, [frames] long: what a room is measured by. */
    private fun impulse(frames: Int) = FloatArray(frames).also { it[0] = 1f }

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
        assertEquals("ops[0].op", refusal(JSONObject("""{"ops":[{"op":"echo"}]}""")))
        assertEquals("ops[0].op", refusal(JSONObject("""{"ops":[{"op":7}]}""")))
        // A reverb's numbers in the contract's order, then its unknown keys.
        assertEquals("ops[0].decayMs", refusal(JSONObject("""{"ops":[{"op":"reverb"}]}""")))
        assertEquals("ops[0].dampHz", refusal(JSONObject("""{"ops":[{"op":"reverb","decayMs":1000}]}""")))
        assertEquals("ops[0].dry", refusal(JSONObject("""{"ops":[{"op":"reverb","decayMs":1000,"dampHz":5000,"wet":0.5}]}""")))
        assertEquals("ops[0].wet", refusal(JSONObject("""{"ops":[{"op":"reverb","decayMs":1000,"dampHz":5000,"wet":"lots","dry":1}]}""")))
        assertEquals("ops[0].size", refusal(JSONObject("""{"ops":[{"op":"reverb","decayMs":1000,"dampHz":5000,"wet":0.5,"dry":1,"size":2}]}""")))
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
                   {"op":"drive","db":-3},{"op":"gain","db":60},
                   {"op":"reverb","decayMs":5,"dampHz":99999,"wet":2,"dry":-1}]}""",
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
                SoundOp.Reverb(100.0, 20_000.0, 1.0, 0.0),
            ),
            effect.ops,
        )
    }

    @Test
    fun `slow + reverb's room is read as it was sent`() {
        assertEquals(SoundEffect(false, listOf(SoundOp.Reverb(3_500.0, 5_500.0, 0.5, 0.8))), parsed(JSONObject(slowReverbJson)))
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

    @Test
    fun `a reverb is the dry sound alone until the first comb's delay has passed`() {
        val input = sine(440.0, 0.5, 2_400)
        val out = through(room(wet = 0.7, dry = 0.6), 48_000, input)[0]
        // 1116 samples at 44.1 kHz is 1215 at 48, and the first of them is sample 0's own silence.
        for (i in 0..1215) assertEquals("sample $i", (0.6 * input[i]).toFloat(), out[i], 0f)
        assertTrue(out[1300] != (0.6 * input[1300]).toFloat())
    }

    @Test
    fun `a reverb gives each channel a tail of its own, so the room is as wide as the speakers`() {
        val (l, r) = through(room(), 48_000, impulse(48_000), impulse(48_000))
        // Channel 1's delays are 23 samples longer at 44.1 kHz: its first comb answers at 1240, not 1215.
        assertEquals(0f, l[1214], 0f)
        assertTrue(l[1215] != 0f)
        assertEquals(0f, r[1239], 0f)
        assertTrue(r[1240] != 0f)
        var ab = 0.0
        var aa = 0.0
        var bb = 0.0
        for (i in 48_000 / 20 until l.size) {
            ab += l[i].toDouble() * r[i]
            aa += l[i].toDouble() * l[i]
            bb += r[i].toDouble() * r[i]
        }
        val correlation = ab / sqrt(aa * bb)
        assertTrue("correlation $correlation", abs(correlation) < 0.2)
    }

    @Test
    fun `a reverb is the first channel's for a folded sound`() {
        val left = sine(300.0, 0.5, 9_600)
        val right = sine(700.0, 0.3, 9_600)
        val (folded, other) = through(room().copy(mono = true), 48_000, left, right)
        val first = through(room(), 48_000, FloatArray(left.size) { ((left[it].toDouble() + right[it]) / 2).toFloat() })[0]
        for (i in first.indices step 7) assertEquals("sample $i", first[i], folded[i], 1e-6f)
        assertArrayEquals(folded, other, 0f)
    }

    @Test
    fun `a reverb leaves silence silent, and falls back to exact silence after a sound`() {
        assertTrue(through(room(), 48_000, FloatArray(4_800))[0].all { it == 0f })
        val burst = FloatArray(9 * 48_000)
        sine(500.0, 0.9, 4_800).copyInto(burst)
        val after = through(room(decayMs = 1_000.0), 48_000, burst)[0]
        // Every value it keeps is let go under 1e-20, so the tail ends in zeros rather than denormals.
        assertTrue(after.copyOfRange(after.size - 48_000, after.size).all { it == 0f })
    }

    @Test
    fun `a reverb stays stable at the longest room and the brightest damping`() {
        val out = through(room(decayMs = 20_000.0, dampHz = 20_000.0, wet = 1.0, dry = 1.0), 48_000, sine(1_000.0, 0.9, 48_000))[0]
        assertTrue(out.all { it.isFinite() && abs(it) <= 1f })
    }

    /*
     * The same numbers `sound-effects.unit.test.ts` and `SoundEffectTests.swift` hold their engines to:
     * the megaphone's fragment, twice as long, through slow + reverb at the middle of its sliders. Not
     * folded, so each channel has a room of its own and both are held to their numbers - 1214 and 1215
     * either side of the left channel's first comb, 1239 and 1240 of the right's.
     */
    @Test
    fun `the reverb matches the golden numbers every engine is held to`() {
        val rate = 48_000
        val left = FloatArray(4_800) { (0.6 * sin(2 * PI * 440 * it / rate) + 0.2 * sin(2 * PI * 3100 * it / rate)).toFloat() }
        val right = FloatArray(4_800) { (0.3 * sin(2 * PI * 220 * it / rate + 0.5)).toFloat() }
        val (l, r) = through(parsed(JSONObject(slowReverbJson))!!, rate, left, right)
        val golden = listOf(
            Triple(0, 0.0, 0.11506213247776031),
            Triple(1, 0.09078975021839142, 0.1210789903998375),
            Triple(1214, 0.4370698928833008, -0.18847058713436127),
            Triple(1215, 0.3962092995643616, -0.19267092645168304),
            Triple(1239, 0.39520999789237976, -0.23967154324054718),
            Triple(1240, 0.4382869005203247, -0.2387159764766693),
            Triple(1500, -0.5940757393836975, -0.06688307225704193),
            Triple(2000, 0.5418930649757385, 0.23884811997413635),
            Triple(3000, -0.2069074958562851, -0.22407972812652588),
            Triple(4000, -0.2956431806087494, 0.14864428341388702),
            Triple(4799, -0.1521013230085373, 0.08078738301992416),
        )
        for ((i, leftValue, rightValue) in golden) {
            assertEquals("sample $i, left", leftValue, l[i].toDouble(), 1e-6)
            assertEquals("sample $i, right", rightValue, r[i].toDouble(), 1e-6)
        }
    }

    /* ------------------------------------------------------------------------------------- */

    /** The male voice at the middle of its sliders, exactly as the editor sends it (`SOUND_EFFECTS` in sound-effects.ts). */
    private val maleVoiceJson = """{"mono":true,"ops":[{"op":"pitch","semitones":-6,"formant":-3},{"op":"gain","db":0.72}]}"""

    private fun pitch(semitones: Double, formant: Double = 0.0) = SoundEffect(false, listOf(SoundOp.Pitch(semitones, formant)))

    /** How strong [hz] is in [samples] from [from] on, as the amplitude of a sine: one bin of a DFT. */
    private fun amplitudeAt(samples: FloatArray, hz: Double, from: Int = 24_000, rate: Int = 48_000): Double {
        var re = 0.0
        var im = 0.0
        for (i in from until samples.size) {
            re += samples[i] * kotlin.math.cos(2 * PI * hz * i / rate)
            im += samples[i] * sin(2 * PI * hz * i / rate)
        }
        return 2 * kotlin.math.hypot(re, im) / (samples.size - from)
    }

    @Test
    fun `the male voice the editor sends is read as it was sent, and a pitch's numbers held to an octave`() {
        assertEquals(
            SoundEffect(true, listOf(SoundOp.Pitch(-6.0, -3.0), SoundOp.Gain(0.72))),
            parsed(JSONObject(maleVoiceJson)),
        )
        assertEquals(
            listOf(SoundOp.Pitch(12.0, -12.0)),
            parsed(JSONObject("""{"ops":[{"op":"pitch","semitones":30,"formant":-40}]}"""))!!.ops,
        )
        assertEquals("ops[0].semitones", refusal(JSONObject("""{"ops":[{"op":"pitch","formant":2}]}""")))
        assertEquals("ops[0].formant", refusal(JSONObject("""{"ops":[{"op":"pitch","semitones":-6}]}""")))
        assertEquals("ops[0].ratio", refusal(JSONObject("""{"ops":[{"op":"pitch","semitones":-6,"formant":0,"ratio":2}]}""")))
    }

    @Test
    fun `a pitch step that moves nothing gives the sound back a frame late, and otherwise as it was`() {
        val input = FloatArray(48_000) { (0.3 * sin(2 * PI * 220 * it / 48_000) + 0.2 * sin(2 * PI * 1730 * it / 48_000 + 1)).toFloat() }
        val out = through(pitch(0.0), 48_000, input)[0]
        // 40 ms a frame at 48 kHz, and the step is a frame less one sample late.
        val late = 1_919
        var worst = 0.0
        for (i in 2 * late until input.size) worst = maxOf(worst, abs(out[i].toDouble() - input[i - late]))
        assertTrue("worst $worst", worst < 1e-4)
    }

    @Test
    fun `a pitch step moves a tone by its semitones and leaves nothing where it was`() {
        for (semitones in listOf(-12.0, -6.0, 7.0, 12.0)) {
            val out = through(pitch(semitones), 48_000, sine(440.0, 0.5, 48_000))[0]
            val moved = amplitudeAt(out, 440 * Math.pow(2.0, semitones / 12))
            assertTrue("$semitones: $moved at the new pitch", moved > 0.3)
            assertTrue("$semitones: something left at 440 Hz", amplitudeAt(out, 440.0) < 0.01)
        }
    }

    @Test
    fun `a pitch step leaves silence silent, and falls back to exact silence two frames after a sound`() {
        assertTrue(through(pitch(-6.0, -3.0), 48_000, FloatArray(4_800))[0].all { it == 0f })
        val burst = FloatArray(48_000)
        sine(500.0, 0.9, 4_800).copyInto(burst)
        val after = through(pitch(5.0, 3.0), 48_000, burst)[0]
        assertTrue(after.copyOfRange(4_800 + 3_840, after.size).all { it == 0f })
        assertTrue(after.all { abs(it) <= 1f })
    }

    /*
     * The same numbers `sound-effects.unit.test.ts` and `SoundEffectTests.swift` hold their engines to:
     * the megaphone's fragment, four times as long, through the male voice - folded - and through a
     * pitch step on each channel. The transforms, the peaks and the envelope have to agree to the
     * operation for these to hold in all three.
     */
    @Test
    fun `the pitch step matches the golden numbers every engine is held to`() {
        val rate = 48_000
        fun fragment() = listOf(
            FloatArray(9_600) { (0.6 * sin(2 * PI * 440 * it / rate) + 0.2 * sin(2 * PI * 3100 * it / rate)).toFloat() },
            FloatArray(9_600) { (0.3 * sin(2 * PI * 220 * it / rate + 0.5)).toFloat() },
        )
        val (left, right) = fragment()
        val (l, r) = through(parsed(JSONObject(maleVoiceJson))!!, rate, left, right)
        val male = listOf(
            0 to 0.0,
            1918 to -0.29614120721817017,
            1919 to -0.25232091546058655,
            1920 to -0.20355385541915894,
            2399 to 0.16940973699092865,
            2400 to 0.20098185539245605,
            3000 to 0.1624542772769928,
            4321 to -0.19919995963573456,
            5000 to -0.30933305621147156,
            6000 to 0.1856769174337387,
            7777 to -0.1872776299715042,
            8000 to 0.0756482258439064,
            9599 to -0.4480621814727783,
        )
        for ((i, value) in male) {
            assertEquals("male voice, sample $i", value, l[i].toDouble(), 1e-6)
            assertEquals("male voice, sample $i, the other channel", l[i], r[i])
        }
        val (a, b) = fragment()
        val (pl, pr) = through(pitch(7.0, 2.0), rate, a, b)
        val stereo = listOf(
            Triple(0, 0.0, 0.0),
            Triple(1918, 0.38877439498901367, -0.3224090039730072),
            Triple(1919, 0.45995599031448364, -0.30201801657676697),
            Triple(1920, 0.3744523227214813, -0.21382911503314972),
            Triple(2399, -0.7527450919151306, 0.23698817193508148),
            Triple(2400, -0.6146458387374878, 0.24650360643863678),
            Triple(3000, 0.2789718508720398, 0.33405008912086487),
            Triple(4321, 0.41194868087768555, 0.3025590479373932),
            Triple(5000, -0.2085523009300232, -0.03757572919130325),
            Triple(6000, 0.8355948328971863, -0.2713659107685089),
            Triple(7777, -0.3335418999195099, 0.10749977827072144),
            Triple(8000, -0.8190305233001709, -0.16935910284519196),
            Triple(9599, -0.6935299038887024, -0.1321483850479126),
        )
        for ((i, leftValue, rightValue) in stereo) {
            assertEquals("pitch, sample $i, left", leftValue, pl[i].toDouble(), 1e-6)
            assertEquals("pitch, sample $i, right", rightValue, pr[i].toDouble(), 1e-6)
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
    fun `media3's side carries a room's tail across its buffers, each channel in a room of its own`() {
        val rate = 48_000
        val left = sine(440.0, 0.5, 9_600, rate)
        val right = sine(660.0, 0.4, 9_600, rate)
        val pcm = ByteBuffer.allocateDirect(left.size * 8).order(ByteOrder.nativeOrder())
        for (i in left.indices) {
            pcm.putFloat(left[i])
            pcm.putFloat(right[i])
        }
        pcm.flip()
        val effect = room(wet = 0.5, dry = 0.8)
        // Buffers far shorter than the shortest comb, so every echo is of a sample an earlier one held.
        val out = process(SoundEffectProcessor(effect), AudioFormat(rate, 2, C.ENCODING_PCM_FLOAT), pcm, 333)
        val (l, r) = through(effect, rate, left, right)
        assertArrayEquals(l, FloatArray(left.size) { out.getFloat(it * 8) }, 0f)
        assertArrayEquals(r, FloatArray(left.size) { out.getFloat(it * 8 + 4) }, 0f)
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
