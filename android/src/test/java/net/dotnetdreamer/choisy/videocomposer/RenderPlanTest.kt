package net.dotnetdreamer.choisy.videocomposer

import androidx.media3.common.C
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The timeline arithmetic: where every clip lands after a speed change, how music repeats to cover
 * the video, where voiceover silence goes, and how a web overlay coordinate becomes a GL one.
 *
 * All of it is worth pinning because none of it is visible until a customer watches the result and
 * the music is half a second short or the sticker is on the wrong side of the frame.
 */
class RenderPlanTest {

    private fun clip(
        key: String,
        inMs: Long = 0,
        outMs: Long = 2_000,
        speed: Float = 1f,
        volume: Float = 1f,
        muted: Boolean = false,
        uri: String = "file:///$key.mp4",
    ) = Clip(key, uri, inMs, outMs, speed, volume, muted, Fit.CONTAIN)

    private fun spec(
        clips: List<Clip>,
        audio: Audio = Audio(false, 1f, null, emptyList()),
        overlays: List<Overlay> = emptyList(),
        filter: List<FilterOp> = emptyList(),
        posterAtMs: Long = 0,
    ) = ComposeSpec(
        jobId = "job",
        pendingPostId = "post",
        clips = clips,
        output = Output(720, 1280, 30, 4_000_000, 128_000),
        filter = filter,
        overlays = overlays,
        audio = audio,
        posterAtMs = posterAtMs,
    )

    private fun probe(durationMs: Long, hasAudio: Boolean = true) =
        ProbedInput(durationMs, hasAudio, hasVideo = true)

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `clips are laid end to end on the output timeline`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 2_000), clip("b", outMs = 3_000))),
            mapOf("file:///a.mp4" to probe(5_000), "file:///b.mp4" to probe(5_000)),
        )
        assertEquals(0L, plan.prefixOutUs[0])
        assertEquals(2_000_000L, plan.prefixOutUs[1])
        assertEquals(5_000_000L, plan.totalUs)
    }

    @Test
    fun `speed shortens a clip on the output timeline but not its trim`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 4_000, speed = 2f))),
            mapOf("file:///a.mp4" to probe(10_000)),
        )
        assertEquals(2_000_000L, plan.totalUs)
        assertEquals(4_000_000L, plan.clips[0].outUs)
        assertEquals(0L, plan.clips[0].inUs)
    }

    @Test
    fun `half speed doubles the output duration`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 3_000, speed = 0.5f))),
            mapOf("file:///a.mp4" to probe(10_000)),
        )
        assertEquals(6_000_000L, plan.totalUs)
    }

    @Test
    fun `a stale out point is clamped to the probed duration`() {
        val plan = RenderPlan.build(
            // The manifest thinks the clip is ten seconds; the file is only four.
            spec(listOf(clip("a", outMs = 10_000))),
            mapOf("file:///a.mp4" to probe(4_000)),
        )
        assertEquals(4_000_000L, plan.clips[0].outUs)
        assertEquals(4_000_000L, plan.totalUs)
    }

    @Test
    fun `audio is dropped when the clip is muted, silent or globally muted`() {
        val muted = RenderPlan.build(
            spec(listOf(clip("a", muted = true))),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        assertTrue(muted.clips[0].removeAudio)
        assertFalse(muted.videoSeqHasAudio)

        val noTrack = RenderPlan.build(
            spec(listOf(clip("a"))),
            mapOf("file:///a.mp4" to probe(2_000, hasAudio = false)),
        )
        assertTrue(noTrack.clips[0].removeAudio)

        val globallyMuted = RenderPlan.build(
            spec(listOf(clip("a")), audio = Audio(true, 1f, null, emptyList())),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        assertTrue(globallyMuted.clips[0].removeAudio)
    }

    @Test
    fun `the global original volume multiplies each clip's own`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", volume = 0.5f)),
                audio = Audio(false, 0.5f, null, emptyList()),
            ),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        assertEquals(0.25f, plan.clips[0].gain, 1e-6f)
        assertFalse(plan.clips[0].removeAudio)
        assertTrue(plan.videoSeqHasAudio)
    }

    @Test
    fun `one clip keeping its sound is enough for the sequence to carry audio`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", muted = true), clip("b"))),
            mapOf("file:///a.mp4" to probe(2_000), "file:///b.mp4" to probe(2_000)),
        )
        assertTrue(plan.videoSeqHasAudio)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `overlay coordinates move from web space to GL space`() {
        val overlay = Overlay("o", "data:image/png;base64,x", 0.1f, 0.1f, 100, 40, 30f, 0, 1_000, 1f)
        val plan = RenderPlan.build(
            spec(listOf(clip("a")), overlays = listOf(overlay)),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        val placed = plan.overlays[0]
        // Top-left in web space is top-left in GL space: x goes -1..1, y flips to point up.
        assertEquals(-0.8f, placed.anchorX, 1e-6f)
        assertEquals(0.8f, placed.anchorY, 1e-6f)
        // CSS rotates clockwise, GL counter-clockwise.
        assertEquals(-30f, placed.rotationGlDeg, 1e-6f)
        assertEquals(0L, placed.startUs)
        assertEquals(1_000_000L, placed.endUs)
    }

    @Test
    fun `an overlay at the bottom right maps to the positive x negative y corner`() {
        val overlay = Overlay("o", "data:image/png;base64,x", 0.9f, 0.9f, 10, 10, 0f, 0, 500, 1f)
        val plan = RenderPlan.build(
            spec(listOf(clip("a")), overlays = listOf(overlay)),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        assertEquals(0.8f, plan.overlays[0].anchorX, 1e-6f)
        assertEquals(-0.8f, plan.overlays[0].anchorY, 1e-6f)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a non-looping track shorter than the video plays once`() {
        val music = Music("file:///m.m4a", 0, 0, 3_000, 1f, loop = false, fadeInMs = 0, fadeOutMs = 0)
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 10_000)), audio = Audio(false, 1f, music, emptyList())),
            mapOf("file:///a.mp4" to probe(10_000), "file:///m.m4a" to probe(3_000)),
        )
        val musicPlan = plan.music!!
        assertEquals(1, musicPlan.items.size)
        assertEquals(0L, musicPlan.leadGapUs)
        assertEquals(3_000_000L, musicPlan.items[0].outUs - musicPlan.items[0].inUs)
    }

    @Test
    fun `a looping track repeats and the last repetition is clipped to the video's end`() {
        val music = Music("file:///m.m4a", 0, 0, 3_000, 1f, loop = true, fadeInMs = 0, fadeOutMs = 0)
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 10_000)), audio = Audio(false, 1f, music, emptyList())),
            mapOf("file:///a.mp4" to probe(10_000), "file:///m.m4a" to probe(3_000)),
        )
        val items = plan.music!!.items
        // Ten seconds of video, a three-second track: four repetitions, the last one a second long.
        assertEquals(4, items.size)
        assertEquals(1_000_000L, items.last().outUs - items.last().inUs)
        val total = items.sumOf { it.outUs - it.inUs }
        assertEquals(10_000_000L, total)
    }

    @Test
    fun `a track that starts late gets a leading gap and covers only the rest`() {
        val music = Music("file:///m.m4a", 4_000, 0, 3_000, 1f, loop = true, fadeInMs = 0, fadeOutMs = 0)
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 10_000)), audio = Audio(false, 1f, music, emptyList())),
            mapOf("file:///a.mp4" to probe(10_000), "file:///m.m4a" to probe(3_000)),
        )
        val musicPlan = plan.music!!
        assertEquals(4_000_000L, musicPlan.leadGapUs)
        assertEquals(6_000_000L, musicPlan.items.sumOf { it.outUs - it.inUs })
    }

    @Test
    fun `a track starting past the end of the video is dropped`() {
        val music = Music("file:///m.m4a", 20_000, 0, 3_000, 1f, loop = false, fadeInMs = 0, fadeOutMs = 0)
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 10_000)), audio = Audio(false, 1f, music, emptyList())),
            mapOf("file:///a.mp4" to probe(10_000), "file:///m.m4a" to probe(3_000)),
        )
        assertNull(plan.music)
    }

    @Test
    fun `fades belong to the first and last repetitions only`() {
        val music = Music("file:///m.m4a", 0, 0, 3_000, 0.6f, loop = true, fadeInMs = 500, fadeOutMs = 400)
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 9_000)), audio = Audio(false, 1f, music, emptyList())),
            mapOf("file:///a.mp4" to probe(9_000), "file:///m.m4a" to probe(3_000)),
        )
        val items = plan.music!!.items
        assertEquals(3, items.size)
        // The first repetition ramps in from silence...
        assertEquals(0f, items.first().gain.getGainFactorAtSamplePosition(0, 48_000), 1e-6f)
        // ...the middle one sits flat at the track's volume...
        assertEquals(0.6f, items[1].gain.getGainFactorAtSamplePosition(0, 48_000), 1e-6f)
        // ...and the last ends in silence, without ever exceeding the chosen volume.
        val lastSample = 3_000L * 48_000 / 1_000 - 1
        assertEquals(0f, items.last().gain.getGainFactorAtSamplePosition(lastSample, 48_000), 1e-3f)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `voiceovers are spaced by gaps and clipped to the end of the video`() {
        val takes = listOf(
            Voiceover("file:///v2.m4a", 5_000, 2_000, 1f),
            Voiceover("file:///v1.m4a", 1_000, 1_500, 0.8f),
        )
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 6_000)), audio = Audio(false, 1f, null, takes)),
            mapOf(
                "file:///a.mp4" to probe(6_000),
                "file:///v1.m4a" to probe(1_500),
                "file:///v2.m4a" to probe(2_000),
            ),
        )
        val items = plan.voice!!.items
        // Sorted by start time whatever order they arrived in.
        assertEquals(2, items.size)
        assertEquals("file:///v1.m4a", items[0].uri)
        assertEquals(1_000_000L, items[0].gapBeforeUs)
        assertEquals(1_500_000L, items[0].clipEndUs)
        // Second take starts at 5 s, i.e. 2.5 s after the first one ended.
        assertEquals(2_500_000L, items[1].gapBeforeUs)
        // ...and is cut at the six-second mark rather than running past the video.
        assertEquals(1_000_000L, items[1].clipEndUs)
    }

    @Test
    fun `an overlapping take is skipped rather than shifted`() {
        val takes = listOf(
            Voiceover("file:///v1.m4a", 0, 3_000, 1f),
            Voiceover("file:///v2.m4a", 1_000, 1_000, 1f),
        )
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 6_000)), audio = Audio(false, 1f, null, takes)),
            mapOf(
                "file:///a.mp4" to probe(6_000),
                "file:///v1.m4a" to probe(3_000),
                "file:///v2.m4a" to probe(1_000),
            ),
        )
        assertEquals(1, plan.voice!!.items.size)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `the poster time never lands past the end`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 2_000)), posterAtMs = 9_999),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        assertTrue(plan.posterAtUs < plan.totalUs)
    }

    @Test
    fun `an empty filter list means no colour matrix`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a"))),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        assertNull(plan.colorMatrix)
    }

    @Test
    fun `extra audio sequences are counted`() {
        val music = Music("file:///m.m4a", 0, 0, 3_000, 1f, loop = false, fadeInMs = 0, fadeOutMs = 0)
        val takes = listOf(Voiceover("file:///v.m4a", 0, 1_000, 1f))
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 6_000)), audio = Audio(false, 1f, music, takes)),
            mapOf(
                "file:///a.mp4" to probe(6_000),
                "file:///m.m4a" to probe(3_000),
                "file:///v.m4a" to probe(1_000),
            ),
        )
        assertEquals(2, plan.extraAudioSequences)
    }

    @Test
    fun `reweight is monotone and exact at the ends`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 1_000), clip("b", outMs = 9_000))),
            mapOf("file:///a.mp4" to probe(10_000), "file:///b.mp4" to probe(10_000)),
        )
        assertEquals(0f, plan.reweight(0), 1e-6f)
        var previous = 0f
        for (percent in 0..100) {
            val value = plan.reweight(percent)
            assertTrue("reweight went backwards at $percent", value >= previous - 1e-6f)
            previous = value
        }
        // Halfway through Transformer's item-count weighting is the boundary between the two clips,
        // which is one second into a ten-second timeline - not the halfway point.
        assertEquals(0.1f, plan.reweight(50), 1e-3f)
    }

    @Test
    fun `a single clip reweights straight through`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 4_000))),
            mapOf("file:///a.mp4" to probe(4_000)),
        )
        assertEquals(0.42f, plan.reweight(42), 1e-6f)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a full volume ramp with no fades is reported as unity so the processor can skip it`() {
        val gain = RampGainProvider(level = 1f)
        assertEquals(C.TIME_END_OF_SOURCE, gain.isUnityUntil(0, 48_000))
        assertTrue(gain.isNoOp())
    }

    @Test
    fun `a reduced level is never unity`() {
        val gain = RampGainProvider(level = 0.5f)
        assertEquals(C.TIME_UNSET, gain.isUnityUntil(0, 48_000))
        assertEquals(0.5f, gain.getGainFactorAtSamplePosition(0, 48_000), 1e-6f)
        assertFalse(gain.isNoOp())
    }

    @Test
    fun `a fade in ramps from zero to the level and never past it`() {
        val gain = RampGainProvider(level = 0.6f, fadeInUs = 1_000_000)
        assertEquals(0f, gain.getGainFactorAtSamplePosition(0, 48_000), 1e-6f)
        assertEquals(0.3f, gain.getGainFactorAtSamplePosition(24_000, 48_000), 1e-3f)
        assertEquals(0.6f, gain.getGainFactorAtSamplePosition(48_000, 48_000), 1e-6f)
        assertEquals(0.6f, gain.getGainFactorAtSamplePosition(96_000, 48_000), 1e-6f)
    }

    @Test
    fun `a fade out reaches silence at the end of its window`() {
        val gain = RampGainProvider(
            level = 1f,
            fadeOutStartUs = 1_000_000,
            fadeOutUs = 1_000_000,
        )
        assertEquals(1f, gain.getGainFactorAtSamplePosition(0, 48_000), 1e-6f)
        assertEquals(0.5f, gain.getGainFactorAtSamplePosition(72_000, 48_000), 1e-3f)
        assertEquals(0f, gain.getGainFactorAtSamplePosition(96_000, 48_000), 1e-6f)
        // Unity right up to the moment the fade starts, and not after.
        assertEquals(48_000L, gain.isUnityUntil(0, 48_000))
        assertEquals(C.TIME_UNSET, gain.isUnityUntil(72_000, 48_000))
    }
}
