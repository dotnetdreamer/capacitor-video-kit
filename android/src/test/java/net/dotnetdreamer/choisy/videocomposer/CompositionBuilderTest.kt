package net.dotnetdreamer.choisy.videocomposer

import androidx.media3.common.MediaItem
import org.junit.Assert.assertEquals
import org.junit.Test
import kotlin.math.floor

/**
 * What the plan says and what Media3 is actually handed have to be the same thing.
 *
 * The plan is the only thing the alpha gate is timed off, so a clip handed to Media3 on a coarser
 * grid than the plan works in ends somewhere the gate has not been told about, and the gap behind
 * it shows through. Building the composition on the JVM is enough to pin that: none of the objects
 * this asserts on needs a codec, a surface or a device.
 */
class CompositionBuilderTest {

    private fun clip(
        key: String,
        inMs: Long = 0,
        outMs: Long = 2_000,
        speed: Float = 1f,
    ) = Clip(
        key = key,
        uri = "file:///$key.mp4",
        inMs = inMs,
        outMs = outMs,
        speed = speed,
        volume = 1f,
        muted = false,
        fit = Fit.CONTAIN,
        crop = null,
        rect = null,
    )

    private fun spec(clips: List<Clip>, tracks: List<Track> = emptyList()) = ComposeSpec(
        jobId = "job",
        pendingPostId = "post",
        clips = clips,
        output = Output(720, 1280, 30, 4_000_000, 128_000),
        filter = emptyList(),
        overlays = emptyList(),
        audio = Audio(false, 1f, null, emptyList()),
        posterAtMs = 0,
        tracks = tracks,
    )

    private fun probe(durationMs: Long) = ProbedInput(durationMs, hasAudio = true, hasVideo = true)

    /**
     * A base that does not land on a whole millisecond - 1000 ms at 3x is 333_333 us - and a layer
     * clip long enough that the planner has to cut it to the room that leaves. The cut lands on
     * 83_333 us of source, which is the only way a clip's out point comes out finer than a
     * millisecond, and a quarter-speed clip multiplies the difference by four on the way out.
     */
    private fun cutLayerPlan(): RenderPlan = RenderPlan.build(
        spec(
            listOf(clip("a", outMs = 1_000, speed = 3f)),
            tracks = listOf(Track("pip", listOf(clip("b", outMs = 2_000, speed = 0.25f)), 0, 1, 1f)),
        ),
        mapOf("file:///a.mp4" to probe(1_000), "file:///b.mp4" to probe(2_000)),
    )

    private fun clippingOf(item: androidx.media3.transformer.EditedMediaItem):
        MediaItem.ClippingConfiguration = item.mediaItem.clippingConfiguration

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a clip is handed to media3 at the plan's own microsecond`() {
        val plan = cutLayerPlan()
        val planned = plan.tracks[0].clips[0]
        assertEquals(83_333L, planned.outUs)

        val layerSeq = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[0]
        val clipping = clippingOf(layerSeq.editedMediaItems[0])
        // The millisecond setter would floor this to 83_000 and the item would run 1_332 us short
        // of the placement the plan gave it.
        assertEquals(planned.inUs, clipping.startPositionUs)
        assertEquals(planned.outUs, clipping.endPositionUs)
    }

    @Test
    fun `a layer sequence tiles the base exactly, so no gap plays under a visible gate`() {
        val plan = cutLayerPlan()
        val layer = plan.tracks[0]
        val layerSeq = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[0]
        // The clip, then the trailing gap that pads the layer to the base's length.
        assertEquals(2, layerSeq.editedMediaItems.size)

        val clipping = clippingOf(layerSeq.editedMediaItems[0])
        // How long Media3 will run this item for: SpeedProviderUtil divides the clipped source by
        // the speed and FLOORS, which is what EditedMediaItem.getPresentationDurationUs reports.
        val itemOutUs = floor((clipping.endPositionUs - clipping.startPositionUs) / 0.25).toLong()
        val gapUs = layerSeq.editedMediaItems[1].durationUs

        // The gate shows the clip for the whole of its placement, so the gap must not start before
        // the placement ends, and the two together must be the base's length and no more.
        assertEquals(layer.placements[0].endUs - layer.placements[0].startUs, itemOutUs)
        assertEquals(plan.totalUs, itemOutUs + gapUs)
        assertEquals(RenderPlan.PlannedTrack.HIDDEN, layer.visibleIndexAt(itemOutUs))
    }

    @Test
    fun `a base clip carries the trim the plan worked out, not the one the manifest asked for`() {
        // The manifest's out point is past the real file, so the plan clamps it to the probe; the
        // item has to follow the plan rather than the manifest.
        val plan = RenderPlan.build(
            spec(listOf(clip("a", inMs = 250, outMs = 5_000))),
            mapOf("file:///a.mp4" to probe(2_000)),
        )
        val baseSeq = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[0]
        val clipping = clippingOf(baseSeq.editedMediaItems[0])
        assertEquals(250_000L, clipping.startPositionUs)
        assertEquals(2_000_000L, clipping.endPositionUs)
    }
}
