package net.dotnetdreamer.videokit.videocomposer

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
        fit: Fit = Fit.CONTAIN,
        crop: Rect? = null,
        rect: Placement? = null,
    ) = Clip(key, uri, inMs, outMs, speed, volume, muted, fit, crop, rect)

    /** Where a picture is drawn, standing as it was drawn unless a test says otherwise. */
    private fun place(x: Float, y: Float, w: Float, h: Float, rotationDeg: Float? = null) =
        Placement(x, y, w, h, rotationDeg)

    private fun track(
        clips: List<Clip>,
        id: String = "pip",
        startMs: Long = 0,
        z: Int = 1,
        opacity: Float = 1f,
    ) = Track(id, clips, startMs, z, opacity)

    private fun spec(
        clips: List<Clip>,
        audio: Audio = Audio(false, 1f, null, emptyList()),
        overlays: List<Overlay> = emptyList(),
        filter: List<FilterOp> = emptyList(),
        posterAtMs: Long = 0,
        tracks: List<Track> = emptyList(),
        durationMs: Long = 0,
    ) = ComposeSpec(
        jobId = "job",
        batchId = "post",
        clips = clips,
        output = Output(720, 1280, 30, 4_000_000, 128_000),
        filter = filter,
        overlays = overlays,
        audio = audio,
        posterAtMs = posterAtMs,
        tracks = tracks,
        durationMs = durationMs,
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
    fun `a base shorter than a millisecond is not padded past what was planned`() {
        // One millisecond of source at the fastest speed plans 250 us of output. A floor of a whole
        // millisecond on the total would claim three quarters of a millisecond that no clip fills,
        // and every layer is cut to the total and every trailing gap measured from it.
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 1, speed = 4f))),
            mapOf("file:///a.mp4" to probe(1)),
        )
        assertEquals(250L, plan.clips[0].outDurUs)
        assertEquals(250L, plan.totalUs)
    }

    @Test
    fun `a sped up clip is planned at the length media3 will actually give it`() {
        // 2 ms of source at 3x is 666.67 us of output. Media3 FLOORS that, in
        // SpeedProviderUtil.getDurationAfterSpeedProviderApplied, so the plan has to floor it too:
        // rounding to 667 claims a microsecond the item does not have, and the alpha gate is timed
        // off the plan. One microsecond is one whole compositor frame's worth of disagreement,
        // because the gap that follows puts its first blank frame on its own first microsecond and
        // media3's gap bitmap is opaque black. This speed is deliberately one where rounding and
        // flooring differ; at 0.25x they agree and the bug hides.
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 2, speed = 3f))),
            mapOf("file:///a.mp4" to probe(2)),
        )
        assertEquals(666L, plan.clips[0].outDurUs)
        assertEquals(666L, plan.totalUs)
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

    private val output = Output(720, 1280, 30, 4_000_000, 128_000)

    /** A square source against the 9:16 output, which is the case where every fit shows its hand. */
    private fun window(
        fit: Fit = Fit.CONTAIN,
        crop: Rect? = null,
        rect: Placement? = null,
        sourceW: Int = 1_000,
        sourceH: Int = 1_000,
    ) = RenderPlan.sourceWindow(clip("a", fit = fit, crop = crop, rect = rect), output, sourceW, sourceH)

    private fun assertRect(x: Float, y: Float, w: Float, h: Float, actual: Rect) {
        assertEquals("x", x, actual.x, 1e-5f)
        assertEquals("y", y, actual.y, 1e-5f)
        assertEquals("w", w, actual.w, 1e-5f)
        assertEquals("h", h, actual.h, 1e-5f)
    }

    @Test
    fun `only a clip that asks for a crop or a rect is reframed`() {
        val plan = RenderPlan.build(
            spec(
                listOf(
                    clip("a"),
                    clip("b", crop = Rect(0.25f, 0.25f, 0.5f, 0.5f)),
                    clip("c", rect = place(0f, 0f, 1f, 0.5f)),
                ),
            ),
            emptyMap(),
        )
        assertFalse(plan.clips[0].reframed)
        assertTrue(plan.clips[1].reframed)
        assertTrue(plan.clips[2].reframed)
    }

    @Test
    fun `with no crop and no rect the window is what contain and cover always meant`() {
        // Contain: the output frame reaches past the top and bottom of the source, and what it
        // reaches is nothing at all - which is exactly where the black bars come from.
        assertRect(0f, -0.3888889f, 1f, 1.7777778f, window())
        // Cover: the frame stops inside the source, and the sides it stops short of are the crop.
        assertRect(0.21875f, 0f, 0.5625f, 1f, window(fit = Fit.COVER))
    }

    @Test
    fun `the fit measures the cropped picture and not the original`() {
        // Half of a square is still square, so this letterboxes like the whole frame would - but
        // against the crop, so the window is half as wide and the bars are half as deep.
        assertRect(0.25f, 0.0555556f, 0.5f, 0.8888889f, window(crop = Rect(0.25f, 0.25f, 0.5f, 0.5f)))
    }

    @Test
    fun `a rect fits the picture within itself rather than within the frame`() {
        // The top half of a 9:16 frame is 720x640, so a square source lands 640x640 inside it with
        // pillarboxing of its own, and the bottom half of the output is off the source entirely.
        assertRect(-0.0625f, 0f, 1.125f, 2f, window(rect = place(0f, 0f, 1f, 0.5f)))
        // Cover fills that same half and loses the top and bottom of the source instead.
        assertRect(0f, 0.0555556f, 1f, 1.7777778f, window(fit = Fit.COVER, rect = place(0f, 0f, 1f, 0.5f)))
    }

    @Test
    fun `a rect in the bottom right corner puts the source in the bottom right corner`() {
        // A 9:16 source into a 9:16 quarter-frame: no bars anywhere, so the window is purely the
        // output frame seen from the source - twice its size, with the source at the far corner.
        assertRect(
            -1f, -1f, 2f, 2f,
            window(rect = place(0.5f, 0.5f, 0.5f, 0.5f), sourceW = 360, sourceH = 640),
        )
    }

    @Test
    fun `the source window is the upright rectangle's, whatever the angle`() {
        // The fit is measured BEFORE the turn and the fitted result is turned as one piece, so an
        // angle must not reach this arithmetic at all. Fitting into the turned rectangle's bounding
        // box instead would swell and shrink the picture as the customer spun it.
        val upright = window(rect = place(0f, 0f, 1f, 0.5f))
        val turned = window(rect = place(0f, 0f, 1f, 0.5f, rotationDeg = 37f))
        assertEquals(upright, turned)
    }

    @Test
    fun `a turn reaches the plan as the counter-clockwise degrees GL counts`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", rect = place(0.1f, 0.1f, 0.5f, 0.5f, rotationDeg = 30f)))),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        // The wire counts clockwise, as CSS does, and a positive z-rotation in a y-up frame turns
        // the other way - the same flip an overlay's angle takes two fields above.
        assertEquals(-30f, plan.clips[0].rotationGlDeg, 1e-6f)
        assertTrue(plan.clips[0].reframed)
    }

    @Test
    fun `a rectangle nobody turned carries no turn at all`() {
        // Three readings have to collapse to the same 0, because the transform is built with no
        // rotation in it for that value and a whole turn IS the upright rectangle.
        val plan = RenderPlan.build(
            spec(
                listOf(
                    clip("a"),
                    clip("b", rect = place(0f, 0f, 1f, 0.5f)),
                    clip("c", rect = place(0f, 0f, 1f, 0.5f, rotationDeg = -720f)),
                    clip("d", rect = place(0f, 0f, 1f, 0.5f, rotationDeg = Float.NaN)),
                ),
            ),
            emptyMap(),
        )
        for (planned in plan.clips) assertEquals(0f, planned.rotationGlDeg, 0f)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a spec with no layers plans the single-sequence composition`() {
        val plan = RenderPlan.build(spec(listOf(clip("a"))), mapOf("file:///a.mp4" to probe(2_000)))
        assertTrue(plan.tracks.isEmpty())
        assertTrue(plan.singleSequence)
        // The base track's clips are drawn into the output frame, which is what every clip did
        // before layers existed and is the whole of what "absent means exactly today" buys.
        assertEquals(720, plan.clips[0].frame.width)
        assertEquals(1280, plan.clips[0].frame.height)
        assertFalse(plan.clips[0].reframed)
    }

    @Test
    fun `a layer's clips are laid end to end from its own start time`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 10_000)),
                tracks = listOf(
                    track(
                        listOf(clip("b", outMs = 2_000), clip("c", outMs = 3_000)),
                        startMs = 4_000,
                    ),
                ),
            ),
            mapOf(
                "file:///a.mp4" to probe(10_000),
                "file:///b.mp4" to probe(2_000),
                "file:///c.mp4" to probe(3_000),
            ),
        )
        val layer = plan.tracks[0]
        assertEquals(2, layer.clips.size)
        // A second sequence, so Transformer's own percentage is an average of two and the renderer
        // has to read the frame timestamps instead.
        assertFalse(plan.singleSequence)
        // `startMs` DELAYS the layer, so its first clip begins at four seconds and plays from its
        // own first frame. Laying it out from zero and hiding it until four would put the fourth
        // second of the clip on screen at the moment the customer expects its first.
        assertEquals(4_000_000L, layer.startUs)
        assertEquals(4_000_000L, layer.placements[0].startUs)
        assertEquals(6_000_000L, layer.placements[0].endUs)
        assertEquals(6_000_000L, layer.placements[1].startUs)
        assertEquals(9_000_000L, layer.placements[1].endUs)
        assertEquals(9_000_000L, layer.endUs)
        // The second before the base ends is what the trailing gap in the layer's sequence covers.
        assertEquals(1_000_000L, plan.totalUs - layer.endUs)
    }

    @Test
    fun `a layer that starts late is still cut at the base track's end`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 10_000)),
                tracks = listOf(track(listOf(clip("b", outMs = 5_000)), startMs = 8_000)),
            ),
            mapOf("file:///a.mp4" to probe(10_000), "file:///b.mp4" to probe(5_000)),
        )
        val layer = plan.tracks[0]
        // Two seconds of room left, so five seconds of clip become two. The delay eats into the
        // layer exactly as it does on iOS, where the room is measured from the same cursor.
        assertEquals(1, layer.clips.size)
        assertEquals(2_000_000L, layer.clips[0].outDurUs)
        assertEquals(8_000_000L, layer.placements[0].startUs)
        assertEquals(10_000_000L, layer.endUs)
        // Nothing left over, so the sequence needs no trailing gap.
        assertEquals(0L, plan.totalUs - layer.endUs)
    }

    @Test
    fun `a layer that starts after the base has ended is dropped`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 3_000)),
                tracks = listOf(track(listOf(clip("b", outMs = 2_000)), startMs = 5_000)),
            ),
            mapOf("file:///a.mp4" to probe(3_000), "file:///b.mp4" to probe(2_000)),
        )
        // A layer with no room shows nothing anywhere, so it buys a decoder and a compositor input
        // for nothing. Dropping it puts the render back on the single-sequence path it would have
        // taken had the manifest never mentioned the layer.
        assertTrue(plan.tracks.isEmpty())
        assertTrue(plan.singleSequence)
    }

    @Test
    fun `a layer is hidden before it starts and after it ends`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 10_000)),
                tracks = listOf(
                    track(
                        listOf(clip("b", outMs = 3_000), clip("c", outMs = 2_000)),
                        startMs = 2_000,
                    ),
                ),
            ),
            mapOf(
                "file:///a.mp4" to probe(10_000),
                "file:///b.mp4" to probe(3_000),
                "file:///c.mp4" to probe(2_000),
            ),
        )
        val layer = plan.tracks[0]
        val hidden = RenderPlan.PlannedTrack.HIDDEN
        // Nothing before the first clip: the base shows through, and the black frames of the gap
        // that carries the delay are hidden by the same answer.
        assertEquals(hidden, layer.visibleIndexAt(0L))
        assertEquals(hidden, layer.visibleIndexAt(1_999_999L))
        assertEquals(0, layer.visibleIndexAt(2_000_000L))
        assertEquals(0, layer.visibleIndexAt(4_999_999L))
        // The clips follow one another with no instant belonging to both.
        assertEquals(1, layer.visibleIndexAt(5_000_000L))
        assertEquals(1, layer.visibleIndexAt(6_999_999L))
        // And nothing after the last clip, whatever Media3 is still holding on that input.
        assertEquals(7_000_000L, layer.endUs)
        assertEquals(hidden, layer.visibleIndexAt(7_000_000L))
        assertEquals(hidden, layer.visibleIndexAt(9_999_999L))
    }

    @Test
    fun `a layer is cut to the base track's length`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 3_000)),
                tracks = listOf(track(listOf(clip("b", outMs = 5_000), clip("c", outMs = 5_000)))),
            ),
            mapOf(
                "file:///a.mp4" to probe(3_000),
                "file:///b.mp4" to probe(5_000),
                "file:///c.mp4" to probe(5_000),
            ),
        )
        val layer = plan.tracks[0]
        // The second clip never starts, and the first loses the two seconds it would have run past
        // the base - the base is what the post's length is measured by.
        assertEquals(1, layer.clips.size)
        assertEquals(3_000_000L, layer.clips[0].outDurUs)
        assertEquals(3_000_000L, layer.clips[0].outUs - layer.clips[0].inUs)
        assertEquals(3_000_000L, layer.placements[0].endUs)
    }

    @Test
    fun `a layer clip with under a millisecond of source left to show is dropped, not overrun`() {
        // A base that does not land on a whole millisecond, which is what a speed change makes of
        // one: 1000 ms at 3x is 333_333 us. The layer's first clip then leaves 333 us of room, and
        // at the slowest speed the shortest item this engine emits - one millisecond of source -
        // would occupy four milliseconds of the output and end 3_667 us past the base.
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 1_000, speed = 3f)),
                tracks = listOf(
                    track(listOf(clip("b", outMs = 333), clip("c", outMs = 2_000, speed = 0.25f))),
                ),
            ),
            mapOf(
                "file:///a.mp4" to probe(1_000),
                "file:///b.mp4" to probe(1_000),
                "file:///c.mp4" to probe(2_000),
            ),
        )
        assertEquals(333_333L, plan.totalUs)
        val layer = plan.tracks[0]
        assertEquals(1, layer.clips.size)
        assertEquals(333_000L, layer.endUs)
        // The whole point: the layer sequence is the compositor's primary input, so an end past the
        // base is a post longer than the base, and the trailing gap that would pad it back would
        // have a negative duration.
        assertTrue(layer.endUs <= plan.totalUs)
        assertTrue(plan.totalUs - layer.endUs > 0L)
    }

    @Test
    fun `a layer clip that exactly fills the room left is still kept`() {
        // 4_000 us of room and a quarter-speed clip: one millisecond of source stretches to exactly
        // the room available, so the refusal above must not take this clip as well.
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 1_000)),
                tracks = listOf(
                    track(listOf(clip("b", outMs = 996), clip("c", outMs = 2_000, speed = 0.25f))),
                ),
            ),
            mapOf(
                "file:///a.mp4" to probe(1_000),
                "file:///b.mp4" to probe(1_000),
                "file:///c.mp4" to probe(2_000),
            ),
        )
        val layer = plan.tracks[0]
        assertEquals(2, layer.clips.size)
        assertEquals(1_000L, layer.clips[1].outUs - layer.clips[1].inUs)
        assertEquals(4_000L, layer.clips[1].outDurUs)
        assertEquals(1_000_000L, layer.endUs)
        assertEquals(plan.totalUs, layer.endUs)
    }

    @Test
    fun `a layer clip is drawn at the size of its rectangle and anchored at its centre`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a")),
                tracks = listOf(
                    track(listOf(clip("b", fit = Fit.COVER, rect = place(0f, 0.5f, 1f, 0.5f)))),
                ),
            ),
            mapOf("file:///a.mp4" to probe(2_000), "file:///b.mp4" to probe(2_000)),
        )
        val layer = plan.tracks[0]
        // The bottom half of a 9:16 frame is 720 x 640, and its centre is halfway down the frame,
        // which is -0.5 once the axis is flipped to point up.
        assertEquals(720, layer.clips[0].frame.width)
        assertEquals(640, layer.clips[0].frame.height)
        assertEquals(0f, layer.placements[0].anchorX, 1e-6f)
        assertEquals(-0.5f, layer.placements[0].anchorY, 1e-6f)
        // The rectangle has become the frame, so it is gone from the clip: a fit measures the frame
        // it is drawn in, and leaving the rectangle on would place the picture inside it twice.
        assertNull(layer.clips[0].clip.rect)
        assertFalse(layer.clips[0].reframed)
    }

    @Test
    fun `a layer clip keeps its crop and measures it against the layer's own frame`() {
        // The picture-in-picture preset: a square in OUTPUT pixels, 0.36 of the frame's width, in
        // the top-left corner. Both sides come out at 259 px, which is what makes it a square.
        val pip = place(0.04f, 0.0225f, 0.36f, 0.2025f)
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a")),
                tracks = listOf(
                    track(
                        listOf(clip("b", fit = Fit.COVER, crop = Rect(0.25f, 0.25f, 0.5f, 0.5f), rect = pip)),
                    ),
                ),
            ),
            mapOf("file:///a.mp4" to probe(2_000), "file:///b.mp4" to probe(2_000)),
        )
        val placed = plan.tracks[0].clips[0]
        assertEquals(259, placed.frame.width)
        assertEquals(259, placed.frame.height)
        assertTrue(placed.reframed)
        assertEquals(0.25f, placed.clip.crop!!.x, 1e-6f)
        // Anchored at the centre of the square, which is its inset plus half its side.
        assertEquals(2f * (0.04f + 0.18f) - 1f, plan.tracks[0].placements[0].anchorX, 1e-6f)
        assertEquals(1f - 2f * (0.0225f + 0.10125f), plan.tracks[0].placements[0].anchorY, 1e-6f)
    }

    @Test
    fun `a layer is turned where it is placed, not inside its own frame`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a")),
                tracks = listOf(
                    track(listOf(clip("b", rect = place(0.5f, 0.5f, 0.5f, 0.5f, rotationDeg = 45f)))),
                ),
            ),
            mapOf("file:///a.mp4" to probe(2_000), "file:///b.mp4" to probe(2_000)),
        )
        val layer = plan.tracks[0]
        // The rectangle has become the layer's frame, so a turn applied inside it would cut the
        // layer's own corners off. The compositor turns the finished layer about its anchor
        // instead, and the clip that draws it stands as it was drawn.
        assertEquals(-45f, layer.placements[0].rotationGlDeg, 1e-6f)
        assertEquals(0f, layer.clips[0].rotationGlDeg, 0f)
        assertNull(layer.clips[0].clip.rect)
        // The anchor is still the rectangle's centre: a turn moves the picture, never the pivot.
        assertEquals(0.5f, layer.placements[0].anchorX, 1e-6f)
        assertEquals(-0.5f, layer.placements[0].anchorY, 1e-6f)
    }

    @Test
    fun `a layer's sound follows the same rules as the base track's`() {
        val loud = RenderPlan.build(
            spec(listOf(clip("a")), tracks = listOf(track(listOf(clip("b", volume = 0.5f))))),
            mapOf("file:///a.mp4" to probe(2_000), "file:///b.mp4" to probe(2_000)),
        )
        assertTrue(loud.tracks[0].hasAudio)
        assertEquals(0.5f, loud.tracks[0].clips[0].gain, 1e-6f)

        val silent = RenderPlan.build(
            spec(
                listOf(clip("a")),
                audio = Audio(true, 1f, null, emptyList()),
                tracks = listOf(track(listOf(clip("b")))),
            ),
            mapOf("file:///a.mp4" to probe(2_000), "file:///b.mp4" to probe(2_000)),
        )
        // The spec-level mute reaches a layer's clips exactly as it reaches the base track's.
        assertFalse(silent.tracks[0].hasAudio)
        assertTrue(silent.tracks[0].clips[0].removeAudio)
    }

    @Test
    fun `layers are ordered bottom to top by z, and a tie keeps the order it arrived in`() {
        // With one extra layer z was reliably 1 and any sort would have done. With fifteen of them
        // it is the only thing saying which picture is on top, and a tie is reachable: the editor
        // hands out one above the highest z, so two layers can only share a place after a removal
        // from the middle.
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a")),
                tracks = listOf(
                    track(listOf(clip("b")), id = "high", z = 9),
                    track(listOf(clip("c")), id = "tie-first", z = 3),
                    track(listOf(clip("d")), id = "tie-second", z = 3),
                    track(listOf(clip("e")), id = "low", z = 1),
                ),
            ),
            mapOf(
                "file:///a.mp4" to probe(2_000),
                "file:///b.mp4" to probe(2_000),
                "file:///c.mp4" to probe(2_000),
                "file:///d.mp4" to probe(2_000),
                "file:///e.mp4" to probe(2_000),
            ),
        )
        assertEquals(
            listOf("low", "tie-first", "tie-second", "high"),
            plan.tracks.map { it.id },
        )
        // The plan says bottom to top and CompositionBuilder registers the sequences in reverse,
        // because Media3 blends its compositor inputs from the LAST registered to the first. The
        // last entry here is therefore the first sequence in the composition.
        assertEquals("high", plan.tracks.last().id)
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

    /* ------------------------------------------------------------------------------------- */

    /*
     * The tail: the post running on past its base track, where the picture is black. It is what
     * makes a layer placeable anywhere rather than only where the footage underneath already
     * reaches, and `baseUs` is what tells the builder how much black to pad the base with.
     */

    @Test
    fun `a duration past the clips lengthens the output and leaves the base where it was`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 1000)), durationMs = 4000),
            mapOf("file:///a.mp4" to probe(10_000)),
        )

        assertEquals(4_000_000L, plan.totalUs)
        assertEquals(1_000_000L, plan.baseUs)
    }

    @Test
    fun `a duration the clips already cover asks for nothing`() {
        val probes = mapOf("file:///a.mp4" to probe(10_000))

        // 0, absent, and anything at or below the base track all say the same thing. A floor UNDER
        // what was planned would be a base track cut off by a key that only ever asks for more.
        assertEquals(1_000_000L, RenderPlan.build(spec(listOf(clip("a", outMs = 1000))), probes).totalUs)
        assertEquals(
            1_000_000L,
            RenderPlan.build(spec(listOf(clip("a", outMs = 1000)), durationMs = 500), probes).totalUs,
        )
    }

    @Test
    fun `a layer laid in the tail survives the plan`() {
        // Before the key existed this layer started past the end of the output and was planned away.
        val track = track(listOf(clip("b", outMs = 1000)), startMs = 2000)
        val probes = mapOf("file:///a.mp4" to probe(10_000), "file:///b.mp4" to probe(10_000))

        val plan = RenderPlan.build(spec(listOf(clip("a", outMs = 1000)), tracks = listOf(track), durationMs = 4000), probes)

        assertEquals(1, plan.tracks.size)
        assertEquals(2_000_000L, plan.tracks[0].startUs)
    }
}
