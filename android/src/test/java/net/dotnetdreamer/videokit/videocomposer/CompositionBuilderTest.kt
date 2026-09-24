package net.dotnetdreamer.videokit.videocomposer

import androidx.media3.common.MediaItem
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.effect.Presentation
import androidx.media3.effect.RgbMatrix
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotSame
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.atomic.AtomicLong
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

    /* ------------------------------------------------------------------------------------- */
    /* Transitions                                                                             */
    /* ------------------------------------------------------------------------------------- */

    /** How Media3 1.11.1 marks a gap item (`EditedMediaItem.GAP_MEDIA_ID`, package-private). */
    private val gapMediaId = "androidx-media3-GapMediaItem"

    private fun isGap(item: androidx.media3.transformer.EditedMediaItem) = item.mediaItem.mediaId == gapMediaId

    private fun dissolve(from: Clip) = Transition(
        kind = "dissolve",
        from = from,
        mask = null,
        fromTint = null,
        toTint = null,
        curves = TransitionCurves(floatArrayOf(0f, 1f), null, null, null),
    )

    /**
     * Three clips with a transition at each boundary, lowered as the editor sends them: `a` stops
     * at 1.5 s and gives its last half second to `b`, `b` stops at 1.7 s and gives 300 ms to `c`.
     * The windows are 1.5..2.0 s and 3.2..3.5 s of a 5.2 s post.
     */
    private fun twoTransitions(tracks: List<Track> = emptyList()): RenderPlan = RenderPlan.build(
        spec(
            listOf(
                clip("a", outMs = 1_500),
                clip("b", outMs = 1_700).copy(transitionIn = dissolve(clip("a", inMs = 1_500, outMs = 2_000))),
                clip("c", outMs = 2_000).copy(transitionIn = dissolve(clip("b", inMs = 1_700, outMs = 2_000))),
            ),
            tracks = tracks,
        ),
        probes("a", "b", "c", "d"),
    )

    private fun transitionOf(item: androidx.media3.transformer.EditedMediaItem): TransitionEffect? =
        item.effects.videoEffects.lastOrNull() as? TransitionEffect

    @Test
    fun `a spec with no transitions builds exactly the composition it always did`() {
        val plan = RenderPlan.build(spec(listOf(clip("a", outMs = 1_500), clip("b"))), probes("a", "b"))
        val composition = CompositionBuilder.toComposition(plan, emptyList(), null)
        // One sequence, no compositor settings at all, and every item with the one geometry effect
        // and no audio processor - the composition Media3 was handed before transitions existed.
        assertEquals(1, composition.sequences.size)
        assertSame(VideoCompositorSettings.DEFAULT, composition.videoCompositorSettings)
        for (item in composition.sequences[0].editedMediaItems) {
            assertEquals(1, item.effects.videoEffects.size)
            assertTrue(item.effects.videoEffects[0] is Presentation)
            assertTrue(item.effects.audioProcessors.isEmpty())
        }
    }

    @Test
    fun `transitions add one tails sequence right after the base, and the base stays primary`() {
        val plan = twoTransitions()
        val sequences = CompositionBuilder.toComposition(plan, emptyList(), null).sequences
        assertEquals(2, sequences.size)
        // The first sequence registered is Media3's primary, and with no layers it is still the
        // base: its three clips, trimmed where the lowering left them.
        assertEquals(
            listOf(1_500_000L, 1_700_000L, 2_000_000L),
            sequences[0].editedMediaItems.map { clippingOf(it).endPositionUs },
        )
        // Then the tails, under it: gap, tail, gap, tail, gap.
        assertEquals(listOf(true, false, true, false, true), sequences[1].editedMediaItems.map { isGap(it) })
    }

    @Test
    fun `the tails sequence tiles the output exactly, each tail on its window`() {
        val plan = twoTransitions()
        val tails = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[1]
        var cursorUs = 0L
        var tailIndex = 0
        for (item in tails.editedMediaItems) {
            if (isGap(item)) {
                assertTrue(item.durationUs > 0L)
                cursorUs += item.durationUs
                continue
            }
            val tail = plan.tails[tailIndex++]
            // Each tail starts exactly where its lead opens and runs to exactly where its window
            // closes, so no gap frame ever stands where the gate says a tail is.
            assertEquals(tail.itemStartUs, cursorUs)
            assertEquals(tail.startUs - 100_000L, cursorUs)
            val clipping = clippingOf(item)
            assertEquals(tail.clip.inUs, clipping.startPositionUs)
            assertEquals(tail.clip.outUs, clipping.endPositionUs)
            val itemOutUs = floor((clipping.endPositionUs - clipping.startPositionUs) / 1.0).toLong()
            assertEquals(tail.leadUs + tail.durUs, itemOutUs)
            cursorUs += itemOutUs
            assertEquals(tail.endUs, cursorUs)
        }
        assertEquals(plan.tails.size, tailIndex)
        assertEquals(plan.totalUs, cursorUs)
    }

    @Test
    fun `windows that meet still tile the output, the earlier item stopping where the next lead starts`() {
        // `b` is all transition, so the second tail borrows the last 50 ms of the first one's item
        // for its lead: tail, tail, back to back, with no gap between them for a hidden frame to
        // stand in, and each item exactly as long as Media3 will measure it.
        val plan = RenderPlan.build(
            spec(
                listOf(
                    clip("a", outMs = 1_000),
                    clip("b", outMs = 500).copy(transitionIn = dissolve(clip("a", inMs = 1_000, outMs = 1_500))),
                    clip("c").copy(transitionIn = dissolve(clip("b", inMs = 500, outMs = 1_000))),
                ),
            ),
            probes("a", "b", "c"),
        )
        val tails = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[1]
        assertEquals(listOf(true, false, false, true), tails.editedMediaItems.map { isGap(it) })
        var cursorUs = 0L
        var tailIndex = 0
        for (item in tails.editedMediaItems) {
            if (isGap(item)) {
                cursorUs += item.durationUs
                continue
            }
            val tail = plan.tails[tailIndex++]
            assertEquals(tail.itemStartUs, cursorUs)
            val clipping = clippingOf(item)
            cursorUs += clipping.endPositionUs - clipping.startPositionUs
            assertEquals(tail.itemEndUs, cursorUs)
            // Both sides still read the whole window: only the item was cut.
            assertEquals(tail.durUs, transitionOf(item)!!.durUs)
        }
        assertEquals(1_450_000L, plan.tails[0].itemEndUs)
        assertEquals(plan.totalUs, cursorUs)
    }

    @Test
    fun `the tails are drawn only while a tail is playing, and hidden over every gap`() {
        val settings = CompositionBuilder.toComposition(twoTransitions(), emptyList(), null).videoCompositorSettings
        // Input 0 is the base, composited as it arrives; input 1 is the tails, whose items run
        // 1.4..2.0 s and 3.1..3.5 s - each window with its tenth of a second of lead.
        assertEquals(1f, settings.getOverlaySettings(0, 1_750_000L).alphaScale, 0f)
        assertEquals(0f, settings.getOverlaySettings(1, 0L).alphaScale, 0f)
        assertEquals(0f, settings.getOverlaySettings(1, 1_399_999L).alphaScale, 0f)
        assertEquals(1f, settings.getOverlaySettings(1, 1_400_000L).alphaScale, 0f)
        assertEquals(1f, settings.getOverlaySettings(1, 1_999_999L).alphaScale, 0f)
        assertEquals(0f, settings.getOverlaySettings(1, 2_000_000L).alphaScale, 0f)
        assertEquals(1f, settings.getOverlaySettings(1, 3_300_000L).alphaScale, 0f)
        assertEquals(0f, settings.getOverlaySettings(1, 3_500_000L).alphaScale, 0f)
        // Full frame, where it is: the tail's own look already moved it.
        assertEquals(0f, settings.getOverlaySettings(1, 1_750_000L).rotationDegrees, 0f)
    }

    @Test
    fun `with layers the tails sit after the base, under it, and the top layer stays primary`() {
        val plan = twoTransitions(tracks = listOf(layer("pip", "d", 900, z = 1)))
        val composition = CompositionBuilder.toComposition(plan, emptyList(), null)
        // The layer, the base, the tails.
        assertEquals(3, composition.sequences.size)
        assertEquals(900_000L, clippingOf(composition.sequences[0].editedMediaItems[0]).endPositionUs)
        assertEquals(1_500_000L, clippingOf(composition.sequences[1].editedMediaItems[0]).endPositionUs)
        assertTrue(isGap(composition.sequences[2].editedMediaItems[0]))
        val settings = composition.videoCompositorSettings
        // The layer keeps its gate, the base its full frame, and the tails theirs.
        assertEquals(0f, settings.getOverlaySettings(0, 1_000_000L).alphaScale, 0f)
        assertEquals(1f, settings.getOverlaySettings(1, 1_000_000L).alphaScale, 0f)
        assertEquals(0f, settings.getOverlaySettings(2, 1_000_000L).alphaScale, 0f)
        assertEquals(1f, settings.getOverlaySettings(2, 1_600_000L).alphaScale, 0f)
    }

    @Test
    fun `only the incoming clips and the tails carry a side, and both hear the window`() {
        val plan = twoTransitions()
        val sequences = CompositionBuilder.toComposition(plan, emptyList(), null).sequences
        val base = sequences[0].editedMediaItems

        // The first clip is untouched: one geometry effect, no processor.
        assertEquals(null, transitionOf(base[0]))
        assertEquals(1, base[0].effects.videoEffects.size)
        assertTrue(base[0].effects.audioProcessors.isEmpty())

        // Each incoming clip draws the incoming side over its window, AFTER its geometry, and fades
        // its sound in over the same window - which is why a full-volume clip gets a processor.
        for ((index, item) in base.withIndex().drop(1)) {
            val side = transitionOf(item)!!
            val tail = plan.tails.first { it.index == index }
            assertEquals(TransitionRole.TO, side.role)
            assertEquals(tail.startUs, side.startUs)
            assertEquals(tail.durUs, side.durUs)
            assertTrue(item.effects.videoEffects[0] is Presentation)
            assertEquals(1, item.effects.audioProcessors.size)
        }

        // Each tail draws the outgoing side and fades its sound out.
        val tailItems = sequences[1].editedMediaItems.filterNot { isGap(it) }
        for ((i, item) in tailItems.withIndex()) {
            val side = transitionOf(item)!!
            assertEquals(TransitionRole.FROM, side.role)
            assertEquals(plan.tails[i].startUs, side.startUs)
            assertEquals(plan.tails[i].durUs, side.durUs)
            assertEquals(1, item.effects.audioProcessors.size)
        }
    }

    @Test
    fun `a silent tail makes the tails sequence picture only`() {
        val plan = RenderPlan.build(
            spec(
                listOf(
                    clip("a", outMs = 1_500),
                    clip("b").copy(transitionIn = dissolve(clip("a", inMs = 1_500, outMs = 2_000).copy(muted = true))),
                ),
            ),
            probes("a", "b"),
        )
        val tails = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[1]
        assertEquals(setOf(androidx.media3.common.C.TRACK_TYPE_VIDEO), tails.trackTypes)
        val loud = CompositionBuilder.toComposition(twoTransitions(), emptyList(), null).sequences[1]
        assertTrue(loud.trackTypes.contains(androidx.media3.common.C.TRACK_TYPE_AUDIO))
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

    /* ------------------------------------------------------------------------------------- */
    /* Shared effects and the progress tap                                                     */
    /* ------------------------------------------------------------------------------------- */

    private fun graded(clips: List<Clip>, tracks: List<Track> = emptyList()) = spec(clips, tracks).copy(
        filter = listOf(FilterOp.Sepia(0.5f)),
    )

    @Test
    fun `plain clips on one sequence hand media3 the same effects, so it keeps its chain`() {
        // Media3 rebuilds a sequence's whole chain - overlays included - at any item whose effect
        // list does not EQUAL the running one, and effects compare by identity.
        val plan = RenderPlan.build(graded(listOf(clip("a"), clip("b"), clip("c"))), probes("a", "b", "c"))
        val items = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[0].editedMediaItems
        assertEquals(2, items[0].effects.videoEffects.size)
        assertTrue(items[0].effects.videoEffects[0] is ColorMatrixEffect)
        assertTrue(items[0].effects.videoEffects[1] is Presentation)
        for (item in items.drop(1)) {
            assertEquals(items[0].effects.videoEffects, item.effects.videoEffects)
        }
    }

    @Test
    fun `a clip with another fit gets a presentation of its own`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a"), clip("b").copy(fit = Fit.COVER), clip("c"))),
            probes("a", "b", "c"),
        )
        val items = CompositionBuilder.toComposition(plan, emptyList(), null).sequences[0].editedMediaItems
        assertNotSame(items[0].effects.videoEffects[0], items[1].effects.videoEffects[0])
        assertSame(items[0].effects.videoEffects[0], items[2].effects.videoEffects[0])
    }

    @Test
    fun `a presentation is never shared between sequences, nor with the composition`() {
        // Every sequence under a compositor has its own frame processor, configuring its own
        // Presentation for its own inputs. The grade holds nothing but its matrix and is shared.
        val plan = RenderPlan.build(
            graded(
                listOf(clip("a"), clip("b")),
                tracks = listOf(Track("pip", listOf(clip("c"), clip("d")), 0, 1, 1f)),
            ),
            probes("a", "b", "c", "d"),
        )
        val composition = CompositionBuilder.toComposition(plan, emptyList(), AtomicLong())
        val layer = composition.sequences[0].editedMediaItems.filter { it.effects.videoEffects.isNotEmpty() }
        val base = composition.sequences[1].editedMediaItems
        val layerGeometry = layer.map { it.effects.videoEffects[1] }.toSet()
        val baseGeometry = base.map { it.effects.videoEffects[1] }.toSet()
        assertTrue(layerGeometry.none { it in baseGeometry })
        val compositionPresentation = composition.effects.videoEffects[0]
        assertTrue(compositionPresentation is Presentation)
        assertFalse(compositionPresentation in layerGeometry || compositionPresentation in baseGeometry)
        assertSame(layer[0].effects.videoEffects[0], base[0].effects.videoEffects[0])
    }

    @Test
    fun `the progress tap is an rgb matrix after the composition's presentation`() {
        val plan = RenderPlan.build(spec(listOf(clip("a"))), probes("a"))
        val effects = CompositionBuilder.toComposition(plan, emptyList(), AtomicLong()).effects.videoEffects
        assertEquals(2, effects.size)
        assertTrue(effects[0] is Presentation)
        assertTrue(effects[1] is ProgressTap)
        assertTrue(effects[1] is RgbMatrix)
        assertFalse((effects[1] as ProgressTap).isNoOp(720, 1280))
    }

    @Test
    fun `the progress tap publishes the frame's time and leaves the colour alone`() {
        val tap = AtomicLong(-1L)
        val matrix = ProgressTap(tap).getMatrix(1_234_567L, /* useHdr= */ false)
        assertEquals(1_234_567L, tap.get())
        assertArrayEquals(
            floatArrayOf(1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 0f, 1f),
            matrix,
            0f,
        )
    }
}
