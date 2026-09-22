package net.dotnetdreamer.videokit.videocomposer

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
        rect: Placement? = null,
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
        rect = rect,
    )

    private fun spec(clips: List<Clip>, tracks: List<Track> = emptyList()) = ComposeSpec(
        jobId = "job",
        batchId = "post",
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

    /** A layer of its own, whose clip is the only one that long, so the sequences can be told apart. */
    private fun layer(id: String, key: String, outMs: Long, z: Int, rect: Placement? = null) =
        Track(id, listOf(clip(key, outMs = outMs, rect = rect)), 0, z, 1f)

    private fun probes(vararg keys: String) =
        keys.associate { "file:///$it.mp4" to probe(2_000) }

    @Test
    fun `every layer is registered ahead of the base, top one first`() {
        // Media3 blends its compositor's frame list from the END backwards, so sequence i is drawn
        // over sequence i + 1 for as many sequences as there are. Registering the layers in
        // descending z and the base last is therefore the whole of "higher z draws on top", and it
        // is worth pinning with more than two of them, where an ordering mistake has somewhere to
        // hide. The clips are told apart by their length, because a stubbed Uri is null on the JVM.
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a")),
                tracks = listOf(
                    layer("top", "b", 500, z = 3),
                    layer("bottom", "c", 700, z = 1),
                    layer("middle", "d", 900, z = 2),
                ),
            ),
            probes("a", "b", "c", "d"),
        )
        val sequences = CompositionBuilder.toComposition(plan, emptyList(), null).sequences
        assertEquals(4, sequences.size)
        assertEquals(
            listOf(500_000L, 900_000L, 700_000L, 2_000_000L),
            sequences.map { clippingOf(it.editedMediaItems[0]).endPositionUs },
        )
    }

    @Test
    fun `every layer sequence is padded to the base's length, however many there are`() {
        // The first sequence registered is Media3's primary input and the composited video ends
        // when the primary's stream does, so whichever layer ends up primary has to run the whole
        // length of the base. That is the padding's job, and it is every layer's padding and not
        // just the first one's.
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a")),
                tracks = listOf(
                    layer("top", "b", 500, z = 3),
                    layer("bottom", "c", 700, z = 1),
                    layer("middle", "d", 900, z = 2),
                ),
            ),
            probes("a", "b", "c", "d"),
        )
        val sequences = CompositionBuilder.toComposition(plan, emptyList(), null).sequences
        for (sequence in sequences.take(plan.tracks.size)) {
            val clipping = clippingOf(sequence.editedMediaItems[0])
            val tailUs = sequence.editedMediaItems[1].durationUs
            assertEquals(plan.totalUs, clipping.endPositionUs - clipping.startPositionUs + tailUs)
        }
    }

    @Test
    fun `a layer's turn reaches the compositor as the angle it will be drawn at`() {
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a")),
                tracks = listOf(
                    layer("pip", "b", 2_000, z = 1, rect = Placement(0.5f, 0.5f, 0.4f, 0.4f, 45f)),
                ),
            ),
            probes("a", "b"),
        )
        val settings = CompositionBuilder.toComposition(plan, emptyList(), null).videoCompositorSettings
        // Input 0 is the layer, registered ahead of the base, and its angle is the wire's clockwise
        // 45 negated: Media3 turns an overlay counter-clockwise about +z, as GL does.
        assertEquals(-45f, settings.getOverlaySettings(0, 0L).rotationDegrees, 1e-6f)
        // The base is composited exactly as it arrives, which for a spec with no layers at all is
        // the only thing there is.
        assertEquals(0f, settings.getOverlaySettings(1, 0L).rotationDegrees, 0f)
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
