package net.dotnetdreamer.videokit.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * Everything the renderer needs to know that can be worked out without touching a codec.
 *
 * Keeping this separate from [CompositionBuilder] is what makes the hard parts testable: clip
 * durations after a speed change, where each clip lands on the output timeline, how many times a
 * music track has to repeat to cover the video and how long the last repetition runs, where a
 * voiceover's silence goes, and how an overlay's web coordinates become GL ones. None of that
 * needs an emulator to check.
 */
@OptIn(UnstableApi::class)
class RenderPlan private constructor(
    val spec: ComposeSpec,
    val clips: List<PlannedClip>,
    /** Start of clip i on the OUTPUT timeline. */
    val prefixOutUs: LongArray,
    val totalUs: Long,
    /**
     * Where the base track's own footage ends. The same as [totalUs] for a post nobody has
     * stretched, and the start of the black tail for one somebody has.
     */
    val baseUs: Long,
    /** False when every clip's sound is gone, which lets the video sequence skip audio entirely. */
    val videoSeqHasAudio: Boolean,
    /**
     * The extra video layers, bottom to top, and only the ones that show something. EMPTY IS THE
     * WHOLE OF THE FAST PATH: the builder tests this once and, finding nothing, builds the
     * single-sequence composition it has always built, which is also what a spec whose only layer
     * starts after the base has ended comes back to.
     */
    val tracks: List<PlannedTrack>,
    /**
     * The outgoing side of every transition on the base track, in timeline order. EMPTY IS THE
     * WHOLE OF THE OTHER FAST PATH: the builder asks this once and, finding nothing, builds exactly
     * the composition it built before transitions existed - no extra sequence, no compositor, no
     * extra pass on any clip. The base clips themselves are the same either way, because the spec
     * arrives with the outgoing clips already trimmed to stop where the incoming ones start.
     */
    val tails: List<PlannedTail>,
    /** Null when `filter` was empty. */
    val colorMatrix: ColorMatrix?,
    val overlays: List<OverlayPlacement>,
    val music: MusicPlan?,
    val voice: VoicePlan?,
    val posterAtUs: Long,
    /**
     * The zoom camera, or null for the old path - decided HERE, once, like [tracks] and [tails]: a
     * spec with no camera, or one that never magnifies, plans no zoomed clip and no supersampled
     * layer, and the builder then adds nothing to any chain. See [CameraTrack].
     */
    val camera: CameraTrack? = null,
) {

    data class PlannedClip(
        val clip: Clip,
        val inUs: Long,
        /** Already clamped to the probed source duration. */
        val outUs: Long,
        /** How long this clip occupies on the OUTPUT timeline, i.e. after the speed change. */
        val outDurUs: Long,
        val gain: Float,
        val removeAudio: Boolean,
        /**
         * True when the clip asks for a crop, a rect, or both. Worked out once, here, rather than
         * re-derived per clip or - far worse - per frame, because the rule the whole feature hangs
         * on is that a clip with neither takes exactly the effect chain it took before either field
         * existed. One boolean is the whole of the fast path.
         */
        val reframed: Boolean,
        /**
         * How far this clip's rectangle is TURNED, in the degrees GL counts: counter-clockwise,
         * which is the wire's clockwise negated - the same flip [OverlayPlacement.rotationGlDeg]
         * makes, so a turned video and a turned sticker agree on which way round is which.
         *
         * 0 is a picture that stands exactly as it was drawn, and it is what every clip of every
         * spec written before the angle existed comes out as. Like [reframed] it is settled HERE,
         * once, so the transform is built with no rotation in it at all rather than with a rotation
         * of nothing: a whole number of turns collapses to 0 for that reason, being the same upright
         * rectangle by the manifest's own definition.
         *
         * A clip on an extra layer always carries 0, whatever its rectangle asked for. Its
         * rectangle has become its frame, so turning it inside that frame would only cut its own
         * corners off; the layer is turned where it is placed instead - see
         * [LayerPlacement.rotationGlDeg].
         */
        val rotationGlDeg: Float,
        /**
         * The frame this clip's picture is drawn into, in real pixels. A clip on the base track
         * draws into the output frame itself, which is what every clip did before layers existed.
         * A clip on an extra track draws into a frame the size of its own `rect`, and the
         * compositor then puts that frame where the rectangle says - see [LayerPlacement]. Its
         * `rect` is dropped from [clip] for exactly that reason: the rectangle has become the
         * frame, and leaving it on would place the picture inside the layer a second time.
         */
        val frame: Output,
        /**
         * The type a PICTURE's bytes decode as, from its probe, so the builder can tell Media3 what
         * the item is rather than leave it to guess from a name that may have no extension. Null for
         * a video, and for a picture no probe was made for.
         */
        val imageMimeType: String? = null,
        /**
         * True when the zoom camera magnifies anywhere in this clip's piece of the output timeline,
         * widened by a frame interval either side for the stamp drift [TransitionFrame.at] explains.
         * Only a base clip or a transition tail can be zoomed this way - its picture is the whole
         * output frame, so the camera is one more matrix after its geometry. A layer clip never is:
         * its picture is its rectangle, and the compositor zooms the rectangle (see
         * [LayerPlacement.zoomed]). False for every clip of a spec with no camera, which is what
         * keeps their effect chains the ones they always were.
         */
        val zoomed: Boolean = false,
    )

    /**
     * One extra layer, already placed at its start time and cut to the base track's length.
     *
     * [clips] and [placements] are the same length and in the same order: a layer's clips are a
     * flat sequence like the base's, and each one carries the piece of the timeline it covers.
     * Never empty: a layer whose clips all fell outside the base is dropped when the plan is built,
     * because a layer that shows nothing anywhere is a sequence Media3 would still have to decode.
     */
    data class PlannedTrack(
        val id: String,
        val clips: List<PlannedClip>,
        val placements: List<LayerPlacement>,
        /**
         * Where the layer's FIRST clip lands on the output timeline. Before this instant the layer
         * contributes nothing at all, picture or sound, and the base shows through.
         */
        val startUs: Long,
        /** Higher draws later. The base track is 0. */
        val z: Int,
        val opacity: Float,
        /** False when every clip's sound is gone, exactly as [videoSeqHasAudio] is for the base. */
        val hasAudio: Boolean,
    ) {

        /** Where the layer's last clip ends on the output timeline. */
        val endUs: Long get() = placements.lastOrNull()?.endUs ?: startUs

        /**
         * Which of [placements] is on screen at an instant of the OUTPUT timeline, or [HIDDEN].
         *
         * Pure, and here rather than in [CompositionBuilder], because it is the whole of rule 4 and
         * rule 1 as the compositor sees them - nothing before the first clip, nothing after the
         * last - and both are worth pinning on the JVM instead of on a device.
         */
        fun visibleIndexAt(timeUs: Long): Int {
            if (timeUs < startUs) return HIDDEN
            for (i in placements.indices) if (timeUs < placements[i].endUs) return i
            return HIDDEN
        }

        companion object {
            /** What [visibleIndexAt] answers when the layer has nothing on screen at that instant. */
            const val HIDDEN = -1
        }
    }

    /**
     * Where one clip of an extra layer sits on the output frame, over the window of the OUTPUT
     * timeline that clip covers.
     *
     * The anchor is the centre of the clip's `rect` in the compositor's normalised device
     * coordinates - origin centre, y UP, edges at -1 and 1 - which is the same flip
     * [OverlayPlacement] makes, for the same reason: the web counts from the top-left with y down
     * and GL counts from the middle with y up.
     *
     * The size is not here because it is not needed. The clip's picture is already drawn at the
     * rectangle's own size (see [PlannedClip.frame]), so the compositor draws one output pixel per
     * layer pixel and the centre is the whole of the placement.
     */
    data class LayerPlacement(
        val startUs: Long,
        val endUs: Long,
        val anchorX: Float,
        val anchorY: Float,
        /**
         * How far the layer is turned about that anchor, counter-clockwise as GL counts - see
         * [PlannedClip.rotationGlDeg], which is the same number for a clip on the base track.
         *
         * The compositor turns the layer's whole picture about its own centre in OUTPUT pixels,
         * which is what makes the fit a property of the upright rectangle: the picture was already
         * fitted into the rectangle when the layer was drawn, and what turns is the finished result.
         */
        val rotationGlDeg: Float,
        /**
         * True when the zoom camera magnifies anywhere in this clip's window (a frame's margin
         * included). The compositor then moves and scales the layer per frame - anchor `k (a - f)`,
         * size times `k` - instead of handing back the one settings object it worked out up front.
         */
        val zoomed: Boolean = false,
        /**
         * What the compositor scales the layer's texture by to put it back at its rectangle's size:
         * 1 unless the clip was SUPERSAMPLED, drawn into a frame larger than its rectangle so that a
         * zoom magnifies real source pixels rather than the rectangle-sized picture. Then it is the
         * rectangle's pixels over the frame's, per axis, about `1 / S` - see [layerSupersample].
         */
        val drawScaleX: Float = 1f,
        val drawScaleY: Float = 1f,
    )

    /**
     * The outgoing side of one transition: the tail the outgoing clip gave up when the spec was
     * lowered, placed under the incoming clip on the OUTPUT timeline.
     *
     * The tail is planned exactly like a clip - the probe clamps its trim, its crop and rectangle
     * reframe it, its volume and the post's sound settings give its gain - because it IS the
     * outgoing clip, its last moments, and the frame it shows on the first frame of the window has
     * to be the frame that clip would have shown there with no transition at all.
     *
     * [startUs] is where the incoming clip starts, which is [prefixOutUs] of it and nothing else:
     * the base track arrives already lowered, so no arithmetic here moves a clip. [durUs] is the
     * tail's own length, floored the way every item is, and never longer than the incoming clip -
     * the window cannot outlast the clip whose start it hides. That is also what keeps two tails
     * apart: each window lies inside its incoming clip, so the next one cannot open until this one
     * has closed, and one extra sequence holds every tail of a post.
     *
     * THE LEAD. The item handed to Media3 usually starts a little BEFORE the window, [leadUs]
     * early, on the outgoing clip's own footage - the very frames the base is showing at those
     * instants. It is there because of how Media3 pairs inputs: the compositor draws each base
     * frame with the tails' frame NEAREST in time, and the frames of the gap before a tail tick at
     * a fixed 30 fps from the gap's own start. A window whose tail happens to decode its first
     * frame a few milliseconds late would have the gap's last frame paired with the window's first
     * base frame, and a gap frame is hidden - so the incoming side, nearly transparent at the start
     * of most transitions, would be drawn over nothing: one black frame. With real footage laid
     * before the window, the nearest frame is always a tail frame. During the lead the tail shows
     * the outgoing side at progress 0, which every transition defines as the outgoing clip exactly
     * as it plays, under the base's identical picture, so it cannot be seen; its sound is held
     * silent, because the base is playing that sound already.
     *
     * The lead is taken out of footage the outgoing clip really has, and only when the tail is that
     * clip carried on: the same file, trimmed to start where the base's copy stops, framed and sped
     * the same. Anything else gets no lead and keeps the one-frame risk rather than showing the
     * wrong picture. The window itself never moves: it is [startUs] and [durUs] whatever the lead.
     *
     * The room for it is whatever lies between the previous tail's window and this one, and where
     * that is less than [TAIL_MIN_LEAD_US] - two windows that meet, which is every clip the editor
     * held to half of itself on both sides, so any clip under a second between two default
     * transitions - the rest is BORROWED from the end of the previous tail's item, which then stops
     * short of its window's end (see [itemEndUs]). Without it the risk is not a black frame but a
     * wrong one: the last frame of the PREVIOUS tail, still inside its own item and so still drawn,
     * is the one paired with this window's first base frame about one time in twelve, and under an
     * incoming side that is all but transparent that shows the clip from two cuts back, or black
     * for a slide. What the borrow costs is the last few hundredths of the previous window, where
     * the incoming side over it is all but opaque and settled: there the frames under it are the
     * incoming clip's own, laid by this lead, instead of the outgoing side's last moments.
     */
    data class PlannedTail(
        /** The base clip this tail runs under: the INCOMING one, whose `transitionIn` it came from. */
        val index: Int,
        /**
         * The item: the outgoing clip's last moments, planned like any clip and cut to the window
         * if need be, with the lead laid before them. Its `outDurUs` is `leadUs + durUs`, less
         * whatever the next tail borrowed for its own lead - see [itemEndUs].
         */
        val clip: PlannedClip,
        /** Where the window opens on the output timeline: where the incoming clip starts. */
        val startUs: Long,
        /** How long the window runs. */
        val durUs: Long,
        /** How much of the outgoing clip is laid before the window; 0 when there was no room. */
        val leadUs: Long,
        /** The curves, the mask and the tints, for both sides. */
        val transition: Transition,
    ) {

        /** Where the window closes: the first instant that belongs to the incoming clip alone. */
        val endUs: Long get() = startUs + durUs

        /** Where the item starts on the output timeline: the lead's first instant. */
        val itemStartUs: Long get() = startUs - leadUs

        /**
         * Where the item stops on the output timeline. [endUs], unless the next tail's window
         * followed this one too closely to lead out of free room and borrowed the end of this
         * item instead, in which case it is where that tail's lead starts. Read off the item's own
         * floored length, so the sequence, the gate and Media3 measure the same item.
         */
        val itemEndUs: Long get() = itemStartUs + clip.outDurUs
    }

    data class OverlayPlacement(
        val id: String,
        val png: String,
        /** Normalised device coordinates of the output frame: origin centre, y UP. */
        val anchorX: Float,
        val anchorY: Float,
        /** Counter-clockwise, because that is what GL means by a positive z-rotation. */
        val rotationGlDeg: Float,
        val startUs: Long,
        val endUs: Long,
        val opacity: Float,
        val wPx: Int,
        val hPx: Int,
    )

    data class MusicItem(
        val inUs: Long,
        val outUs: Long,
        val gain: RampGainProvider,
    )

    data class MusicPlan(
        val uri: String,
        /** Silence before the first repetition. */
        val leadGapUs: Long,
        val items: List<MusicItem>,
    )

    data class VoiceItem(
        val gapBeforeUs: Long,
        val uri: String,
        /** Clip the take here so a slightly long m4a cannot extend the composition. */
        val clipEndUs: Long,
        val level: Float,
    )

    data class VoicePlan(val items: List<VoiceItem>)

    /** How many audio-only sequences this plan adds beside the video ones. */
    val extraAudioSequences: Int
        get() = (if (music != null) 1 else 0) + (if (voice != null) 1 else 0)

    /**
     * Whether the composition is ONE sequence, which is the only case [reweight] can answer for. The
     * tails are a sequence of their own, so a post with a transition in it never is.
     */
    val singleSequence: Boolean
        get() = tracks.isEmpty() && extraAudioSequences == 0 && tails.isEmpty()

    /** The tail whose item - lead and window - holds [timeUs] on the output timeline, or null. */
    fun tailAt(timeUs: Long): PlannedTail? = tailAt(tails, timeUs)

    /**
     * Turns Transformer's own item-count-weighted percentage into a duration-weighted 0..1.
     *
     * Only meaningful when the composition has exactly ONE sequence: with several, Transformer
     * averages each sequence's progress, and a short voiceover that finished long ago keeps
     * reporting 99 %, which drags the average away from anything invertible. The renderer uses the
     * frame-timestamp tap for the real number and falls back to this only in the single-sequence
     * case, before the first frame arrives.
     */
    fun reweight(percent: Int): Float {
        val n = clips.size
        if (n <= 0 || totalUs <= 0L) return 0f
        if (n == 1) return (percent / 100f).coerceIn(0f, 1f)
        val x = percent * n / 100f
        val idx = min(n - 1, x.toInt())
        val frac = (x - idx).coerceIn(0f, 1f)
        val at = prefixOutUs[idx] + (frac * clips[idx].outDurUs).toLong()
        return (at.toFloat() / totalUs.toFloat()).coerceIn(0f, 1f)
    }

    companion object {

        fun build(spec: ComposeSpec, probes: Map<String, ProbedInput>): RenderPlan {
            val planned = ArrayList<PlannedClip>(spec.clips.size)
            val prefix = LongArray(spec.clips.size)
            var cursorUs = 0L

            for ((i, clip) in spec.clips.withIndex()) {
                val item = planClip(clip, spec.audio, probes, spec.output)
                prefix[i] = cursorUs
                cursorUs += item.outDurUs
                planned += item
            }

            // What was planned, or the tail `durationMs` asks for past it. Every layer is cut to
            // this length, every audio sequence is measured against it and every trailing gap is the
            // difference between it and a layer's end - and the base sequence now gets a trailing
            // gap of its own, so the room the plan hands out is room the items really fill. A base
            // whose whole planned length is under a millisecond is rare but reachable: a one
            // millisecond source at MAX_SPEED plans 250 us. The floor survives only for an empty
            // clip list, which the parser refuses and only a direct caller can produce.
            val baseUs = if (planned.isEmpty()) MIN_CLIP_US else cursorUs
            val totalUs = max(baseUs, spec.durationMs * 1000L)
            val colorMatrix = if (spec.filter.isEmpty()) null else ColorMatrix.fold(spec.filter)

            val overlays = spec.overlays.map { o ->
                OverlayPlacement(
                    id = o.id,
                    png = o.png,
                    // Web space is 0..1 with y down and the origin top-left; GL is -1..1 with y up.
                    anchorX = 2f * o.cx - 1f,
                    anchorY = 1f - 2f * o.cy,
                    // CSS rotates clockwise, a positive GL z-rotation turns counter-clockwise.
                    rotationGlDeg = -o.rotationDeg,
                    startUs = o.startMs * 1000L,
                    endUs = o.endMs * 1000L,
                    opacity = o.opacity,
                    wPx = o.wPx,
                    hPx = o.hPx,
                )
            }

            // Null for a camera that never magnifies. The parser already drops one, and this is the
            // same rule again for a caller that built its spec by hand.
            val camera = spec.camera?.takeIf {
                it.zoomsBetween(Double.NEGATIVE_INFINITY, Double.POSITIVE_INFINITY)
            }
            val marginUs = frameIntervalUs(spec.output)
            if (camera != null) {
                for (i in planned.indices) {
                    val zoomed = camera.zoomsBetween(
                        (prefix[i] - marginUs) / 1000.0,
                        (prefix[i] + planned[i].outDurUs + marginUs) / 1000.0,
                    )
                    if (zoomed) planned[i] = planned[i].copy(zoomed = true)
                }
            }
            // A tail is the outgoing clip carried on, a whole-frame picture like a base clip's, so it
            // takes the camera the same way: after its geometry and BEFORE its transition side, which
            // is the contract's "each side is its clip's whole frame as seen through the camera".
            val tails = planTails(spec, planned, prefix, probes).map { tail ->
                val zoomed = camera?.zoomsBetween(
                    (tail.itemStartUs - marginUs) / 1000.0,
                    (tail.itemEndUs + marginUs) / 1000.0,
                ) == true
                if (zoomed) tail.copy(clip = tail.clip.copy(zoomed = true)) else tail
            }

            return RenderPlan(
                spec = spec,
                clips = planned,
                prefixOutUs = prefix,
                totalUs = totalUs,
                baseUs = baseUs,
                videoSeqHasAudio = planned.any { !it.removeAudio },
                // Bottom to top, and `sortedBy` is stable, so two layers claiming one z keep the
                // order the spec listed them in - which is the tie-break the contract names. A
                // layer whose start time falls past the end of the base contributes nothing
                // anywhere and is dropped here, exactly as iOS declines to add its track: an empty
                // layer is a sequence, a decoder and a compositor input for a picture nobody sees.
                tracks = spec.tracks.sortedBy { it.z }
                    .map { planTrack(it, spec, probes, totalUs, camera, marginUs) }
                    .filter { it.clips.isNotEmpty() },
                tails = tails,
                colorMatrix = colorMatrix,
                overlays = overlays,
                music = planMusic(spec.audio.music, probes, totalUs),
                voice = planVoice(spec.audio.voiceover, probes, totalUs),
                posterAtUs = min(spec.posterAtMs * 1000L, max(0L, totalUs - 1L)),
                camera = camera,
            )
        }

        /** One frame at the post's rate, in microseconds: the margin a zoom decision is widened by. */
        private fun frameIntervalUs(output: Output): Long = 1_000_000L / max(1, output.fps)

        /**
         * How many times larger than its rectangle a layer clip is drawn, so a zoom into it still
         * samples its source rather than magnifying a rectangle-sized picture: the most the camera
         * magnifies over the clip's window, held to [MAX_LAYER_SUPERSAMPLE] and to what keeps the
         * texture inside the [MAX_TEXTURE_PX] every GL implementation guarantees. 1 - the frame it
         * has always been drawn into - for a clip the camera never zooms.
         */
        fun layerSupersample(maxScale: Double, rectWPx: Int, rectHPx: Int): Float {
            val longest = max(rectWPx, rectHPx).coerceAtLeast(1)
            val cap = min(MAX_LAYER_SUPERSAMPLE.toDouble(), MAX_TEXTURE_PX.toDouble() / longest)
            return min(maxScale, cap).coerceAtLeast(1.0).toFloat()
        }

        /**
         * One clip's timing and sound, which are the same arithmetic on every layer. The frame the
         * clip is drawn into is the only thing the layers differ by, and it is a parameter for that
         * reason alone - see [PlannedClip.frame].
         */
        private fun planClip(
            clip: Clip,
            audio: Audio,
            probes: Map<String, ProbedInput>,
            frame: Output,
        ): PlannedClip {
            val probe = probes[clip.uri]
            // The manifest may carry a duration read before the file was trimmed or re-encoded.
            val outMs = if (probe != null && probe.durationMs > 0L) {
                min(clip.outMs, probe.durationMs)
            } else {
                clip.outMs
            }
            val inUs = clip.inMs * 1000L
            val outUs = max(outMs * 1000L, inUs + MIN_CLIP_US)
            val speed = clip.speed.coerceIn(ComposeSpecParser.MIN_SPEED, ComposeSpecParser.MAX_SPEED)

            val gain = if (audio.originalMuted || clip.muted) {
                0f
            } else {
                (clip.volume * audio.originalVolume).coerceIn(0f, 1f)
            }
            // A silent item inside a sequence that carries audio is filled with generated silence,
            // so dropping the track is free and saves a decoder.
            val sourceHasAudio = probe?.hasAudio ?: true

            return PlannedClip(
                clip = clip,
                inUs = inUs,
                outUs = outUs,
                // FLOORED, not rounded, because Media3 floors. SpeedProviderUtil
                // .getDurationAfterSpeedProviderApplied accumulates the sped up source and ends on
                // Math.floor, so a rounded plan would claim a microsecond the item does not have.
                // That microsecond is not academic: the alpha gate is timed off this number, so the
                // gate would still say visible for one compositor frame after the clip had run out,
                // and the trailing gap's first blank frame sits on the gap's own first microsecond -
                // media3's gap bitmap is OPAQUE BLACK, so the customer would see one black frame
                // over their video. Flooring makes the plan and the item the same number.
                outDurUs = floor((outUs - inUs) / speed.toDouble()).toLong(),
                gain = gain,
                removeAudio = gain <= 0f || !sourceHasAudio,
                reframed = clip.crop != null || clip.rect != null,
                rotationGlDeg = rotationGlDegOf(clip.rect),
                frame = frame,
                imageMimeType = if (clip.image) probe?.imageMimeType else null,
            )
        }

        /**
         * An extra layer's clips, laid end to end FROM [Track.startMs] and cut to the base track's
         * length.
         *
         * From `startMs`, because `startMs` DELAYS the layer rather than seeking into it: the
         * contract says the first clip lands at that instant, so at `startMs + 1s` the layer is one
         * second into its own first clip and not `startMs + 1s` into it. Laying the clips out from
         * zero and hiding the picture until `startMs` would show the wrong second of footage and
         * would play the layer's sound from the top of the post, because an alpha gate only ever
         * touches the picture. The silence that has to come before the sound is a gap at the head
         * of the layer's sequence - see `layerSequence` in [CompositionBuilder].
         *
         * Cut, because the base decides how long the post is. A layer whose clips outlast it would
         * otherwise leave a sequence running past the one the output is measured by, and the
         * contract says a track running past the base is clipped, not that the post grows. A layer
         * that starts after the base has ended therefore plans no clips at all, and [build] drops
         * it. A clip with too little room left for even the shortest item this engine will emit is
         * dropped for the same reason, which is [cutTo]'s answer of null.
         */
        private fun planTrack(
            track: Track,
            spec: ComposeSpec,
            probes: Map<String, ProbedInput>,
            totalUs: Long,
            camera: CameraTrack? = null,
            marginUs: Long = 0L,
        ): PlannedTrack {
            val clips = ArrayList<PlannedClip>(track.clips.size)
            val placements = ArrayList<LayerPlacement>(track.clips.size)
            val startUs = (track.startMs * 1000L).coerceIn(0L, totalUs)
            var cursorUs = startUs

            for (clip in track.clips) {
                if (cursorUs >= totalUs) break
                // The four numbers alone: they size the layer and anchor it, and the angle is not
                // theirs to answer for. It travels on the placement instead, because a layer is
                // turned where the compositor puts it and not inside its own texture.
                val rect = clip.rect?.bounds ?: FULL_FRAME
                // The layer is drawn at the size of the rectangle it goes in, so the compositor can
                // place it one output pixel per layer pixel and needs nothing but its centre. The
                // pixel floor is only there so that a hand-built spec cannot ask for a texture with
                // no area; the smallest rectangle JS will write is a hundredth of the frame, which
                // is seven pixels across at 720.
                val frame = spec.output.copy(
                    width = (rect.w * spec.output.width).roundToInt().coerceAtLeast(MIN_LAYER_PX),
                    height = (rect.h * spec.output.height).roundToInt().coerceAtLeast(MIN_LAYER_PX),
                )
                var item = planClip(clip.copy(rect = null), spec.audio, probes, frame)
                // What is left of the base is a CEILING for this clip rather than a target, and
                // [cutTo] answers null when the clip cannot be made to fit under it - see there for
                // why a layer that runs even a millisecond past the base lengthens the whole post.
                val roomUs = totalUs - cursorUs
                if (item.outDurUs > roomUs) item = item.cutTo(roomUs) ?: break
                // Under a zoom the layer is drawn LARGER than its rectangle and scaled back down by
                // the compositor, so the camera's magnification lands on source pixels. Settled off
                // the clip's own window, so a webcam bubble that is never under a zoom keeps the
                // rectangle-sized texture - and a spec with no camera never gets past the null.
                val maxScale = camera?.maxScaleBetween(
                    (cursorUs - marginUs) / 1000.0,
                    (cursorUs + item.outDurUs + marginUs) / 1000.0,
                ) ?: 1.0
                val zoomed = maxScale > 1.0 + CameraView.IDENTITY_EPSILON
                var drawScaleX = 1f
                var drawScaleY = 1f
                if (zoomed) {
                    val s = layerSupersample(maxScale, frame.width, frame.height)
                    if (s > 1f) {
                        val big = frame.copy(
                            width = (frame.width * s).roundToInt().coerceAtLeast(MIN_LAYER_PX),
                            height = (frame.height * s).roundToInt().coerceAtLeast(MIN_LAYER_PX),
                        )
                        drawScaleX = frame.width.toFloat() / big.width
                        drawScaleY = frame.height.toFloat() / big.height
                        item = item.copy(frame = big)
                    }
                }
                clips += item
                placements += LayerPlacement(
                    startUs = cursorUs,
                    endUs = cursorUs + item.outDurUs,
                    anchorX = centreNdcX(rect),
                    anchorY = centreNdcY(rect),
                    rotationGlDeg = rotationGlDegOf(clip.rect),
                    zoomed = zoomed,
                    drawScaleX = drawScaleX,
                    drawScaleY = drawScaleY,
                )
                cursorUs += item.outDurUs
            }

            return PlannedTrack(
                id = track.id,
                clips = clips,
                placements = placements,
                startUs = startUs,
                z = track.z,
                opacity = track.opacity.coerceIn(0f, 1f),
                hasAudio = clips.any { !it.removeAudio },
            )
        }

        /**
         * The outgoing side of the transition into base clip [index], or null when there is no
         * tail left to draw and the boundary renders as the cut an engine that ignored the field
         * would have drawn.
         *
         * Null in two cases, and both are the probe correcting the manifest rather than a spec
         * being wrong. A tail that starts at or past the end of the real file has no footage at
         * all, and handing Media3 a trim that starts past the end fails the whole export. A tail
         * that cannot be cut short enough to fit under the incoming clip without dropping below a
         * millisecond of source has nothing worth showing - [cutTo] explains that floor.
         *
         * The cut is there because the window must not outlast the incoming clip: the lowering
         * held the tail to half of either clip, but the probe may since have found the incoming
         * clip's file shorter than the manifest thought. Cut, the tail still starts on the frame
         * the outgoing clip stopped on, and the transition simply runs in the room there is.
         */
        private fun planTail(
            index: Int,
            transition: Transition,
            outgoing: PlannedClip,
            incoming: PlannedClip,
            startUs: Long,
            leadRoomUs: Long,
            spec: ComposeSpec,
            probes: Map<String, ProbedInput>,
        ): PlannedTail? {
            val from = transition.from
            val probe = probes[from.uri]
            if (probe != null && probe.durationMs > 0L && probe.durationMs <= from.inMs) return null
            var tail = planClip(from, spec.audio, probes, spec.output)
            if (tail.outDurUs > incoming.outDurUs) tail = tail.cutTo(incoming.outDurUs) ?: return null
            if (tail.outDurUs <= 0L) return null
            val durUs = tail.outDurUs
            val item = tail.withLead(outgoing, roomUs = leadRoomUs)
            return PlannedTail(
                index = index,
                clip = item,
                startUs = startUs,
                durUs = durUs,
                leadUs = item.outDurUs - durUs,
                transition = transition,
            )
        }

        /**
         * Every base clip's tail, in base order - which is timeline order, each window sitting at
         * the start of its own incoming clip. In order and one at a time, because each tail's lead
         * may only use the room the one before it left - or, where it left less than
         * [TAIL_MIN_LEAD_US], borrow the difference from the end of that tail's item, which is
         * then cut to stop where this lead starts (see [PlannedTail]). The first clip is never
         * asked, because the parser never gives it a transition to answer with.
         */
        private fun planTails(
            spec: ComposeSpec,
            planned: List<PlannedClip>,
            prefix: LongArray,
            probes: Map<String, ProbedInput>,
        ): List<PlannedTail> {
            val tails = ArrayList<PlannedTail>()
            for (i in 1 until planned.size) {
                val transition = spec.clips[i].transitionIn ?: continue
                val previous = tails.lastOrNull()
                // Never negative: the previous window lies inside a clip that ends by this one's start.
                val freeUs = prefix[i] - (previous?.endUs ?: 0L)
                val borrowUs = if (previous == null) {
                    0L
                } else {
                    (TAIL_MIN_LEAD_US - freeUs).coerceIn(0L, previous.durUs / TAIL_BORROW_SHARE)
                }
                val tail = planTail(
                    i, transition, planned[i - 1], planned[i], prefix[i], freeUs + borrowUs, spec, probes,
                ) ?: continue
                // Only a lead that actually reached back into the previous item cuts it: a tail that
                // is not its clip carried on takes no lead at all, and so borrows nothing.
                if (previous != null && tail.itemStartUs < previous.itemEndUs) {
                    tails[tails.lastIndex] = previous.endingBy(tail.itemStartUs)
                }
                tails += tail
            }
            return tails
        }

        /**
         * This tail with its item stopping at [itemEndUs] of the output timeline, or at most a few
         * microseconds before it: the most source that plays for no longer than the room, measured
         * through the same floor Media3 measures the item with, so the item can never run into the
         * next one. Exactly at [itemEndUs] for a tail at normal speed or faster; a slowed one can
         * only land on every few microseconds, and the gap that leaves is a gap like any other.
         */
        private fun PlannedTail.endingBy(itemEndUs: Long): PlannedTail {
            val speed = clip.clip.speed.coerceIn(ComposeSpecParser.MIN_SPEED, ComposeSpecParser.MAX_SPEED).toDouble()
            val keepUs = itemEndUs - itemStartUs
            var sourceUs = floor((keepUs + 1) * speed).toLong()
            while (sourceUs > 0L && floor(sourceUs / speed).toLong() > keepUs) sourceUs--
            return copy(clip = clip.copy(outUs = clip.inUs + sourceUs, outDurUs = floor(sourceUs / speed).toLong()))
        }

        /**
         * This tail with up to [TAIL_LEAD_US] of [outgoing]'s footage laid before it, within
         * [roomUs] of the output timeline - see [PlannedTail] for why. This clip unchanged when
         * there is no room or when it is not [outgoing] carried on.
         *
         * "Carried on" is checked rather than assumed, because the lead is only invisible while it
         * is the very picture the base shows at the same instants: the same clip in every field
         * but its trim, with the base's copy stopping exactly where this one starts. The editor
         * always sends that; a hand-built spec, or a probe that clamped the outgoing clip short,
         * may not.
         *
         * The lead is rounded so that it never needs more room than it was given: the source it
         * takes is floored, and so is the longer item, so the item can only come out shorter than
         * asked, never reaching further back than the room it was given - which is the free room
         * before the window plus whatever [planTails] borrowed, and nothing it has not cut free.
         */
        private fun PlannedClip.withLead(outgoing: PlannedClip, roomUs: Long): PlannedClip {
            val carriedOn = outgoing.outUs == inUs &&
                outgoing.clip.copy(inMs = clip.inMs, outMs = clip.outMs, transitionIn = null) ==
                clip.copy(transitionIn = null)
            if (!carriedOn) return this
            val wantUs = min(TAIL_LEAD_US, roomUs)
            if (wantUs <= 0L) return this
            val speed = clip.speed.coerceIn(ComposeSpecParser.MIN_SPEED, ComposeSpecParser.MAX_SPEED)
            val sourceUs = min((wantUs * speed.toDouble()).toLong(), inUs - outgoing.inUs)
            if (sourceUs <= 0L) return this
            val leadInUs = inUs - sourceUs
            return copy(inUs = leadInUs, outDurUs = floor((outUs - leadInUs) / speed.toDouble()).toLong())
        }

        /**
         * How much of the outgoing clip a tail is given before its window: longer than the gap
         * between two frames of any ordinary source - a 24 fps clip's is 42 ms, and a phone that
         * drops a frame doubles it - so that the frame paired with a window's first frame is the
         * tail's own, and short enough to cost next to nothing to decode. A source slower than
         * 10 fps can still pair a window's first frame with the gap before it.
         */
        private const val TAIL_LEAD_US = 100_000L

        /**
         * The lead a tail is owed even when the window before it leaves no room: a little over the
         * frame interval of a 24 fps source, which is what it takes for the frame nearest the
         * window's first base frame to be this tail's own rather than the previous tail's last.
         * Borrowed from the end of the previous item when the room is not there - see [PlannedTail].
         */
        private const val TAIL_MIN_LEAD_US = 50_000L

        /**
         * Never more than this fraction of the previous window is borrowed, as its divisor. The
         * borrow is at most [TAIL_MIN_LEAD_US] anyway, the last tenth of a default 500 ms window,
         * where every transition in the catalogue has all but settled on its incoming side; the
         * cap is for the short ones, so that a 100 ms window gives up 25 ms rather than half of
         * itself, and the tail after it leads with what it can spare and keeps the rest of the risk.
         */
        private const val TAIL_BORROW_SHARE = 4L

        /**
         * How far through its window a tail is at [timeUs] on the output timeline:
         * `clamp((t - start) / length, 0, 1)`, the contract's progress. Both sides read the same
         * number off the same window, each from the timestamp of its own frame.
         */
        fun progress(tail: PlannedTail, timeUs: Long): Double =
            TransitionMath.progress(tail.startUs, tail.durUs, timeUs)

        /**
         * The tail whose ITEM - its lead and its window - holds [timeUs], or null. Pure and here,
         * rather than inside the compositor that asks it, because it is the whole of what hides the
         * tails' gaps, which are served as opaque black frames and are never anything the post
         * should show. The lead is inside, so that its frames are drawn: they are what the
         * compositor pairs with a window's first frame. The items are in order and never overlap,
         * so the first one that has not ended yet is the only candidate.
         */
        fun tailAt(tails: List<PlannedTail>, timeUs: Long): PlannedTail? {
            for (tail in tails) {
                if (timeUs < tail.itemStartUs) return null
                if (timeUs < tail.itemEndUs) return tail
            }
            return null
        }

        /**
         * The same clip ending sooner, so that it occupies at most [roomUs] of the output timeline,
         * or null when no cut of it fits in that room at all.
         *
         * The trim moves rather than the speed, so the picture plays at the pace the customer chose
         * right up to the cut.
         *
         * [roomUs] is a hard ceiling and not a target, which is why the kept source is rounded DOWN
         * and the answer is checked rather than assumed. The layer sequences are registered ahead of
         * the base, so one of them is Media3's primary input, and the primary is what the composited
         * video is measured by - it ends when the primary's stream does. A layer planned even a
         * millisecond past the base would therefore make the finished post longer than the base
         * track, and `layerSequence` could not pad it back, because the trailing gap it would ask
         * for has a negative duration and a gap of negative duration is no gap at all.
         *
         * Null, rather than a clip shortened below [MIN_CLIP_US] of source, because that floor is
         * what stops a degenerate spec handing Media3 a zero-length item and so cannot be lowered.
         * At the slowest speed the floor buys four milliseconds of OUTPUT for its one millisecond of
         * source, which is exactly how a clip placed in the last fraction of a millisecond of the
         * base used to overrun it. Refusing the clip is the honest answer of the two available: the
         * base fixes the length of the post, and a layer with under a millisecond of source left to
         * show has nothing left to show. Clamping the placement instead would only move the lie -
         * the item would still be handed to Media3 at its full length and would still run long.
         */
        private fun PlannedClip.cutTo(roomUs: Long): PlannedClip? {
            val speed = clip.speed.coerceIn(ComposeSpecParser.MIN_SPEED, ComposeSpecParser.MAX_SPEED)
            val keptUs = min(outUs - inUs, (roomUs * speed.toDouble()).toLong())
            if (keptUs < MIN_CLIP_US) return null
            val cutDurUs = floor(keptUs / speed.toDouble()).toLong()
            // Enforced rather than trusted: the arithmetic above travels through a double, and not
            // overrunning the base is the whole of what this method is for.
            if (cutDurUs > roomUs) return null
            return copy(outUs = inUs + keptUs, outDurUs = cutDurUs)
        }

        /**
         * Which part of the ORIENTED source frame the OUTPUT frame shows, in fractions of the
         * source with a top-left origin and y down - crop, fit and rect folded into ONE rectangle.
         *
         * It is one rectangle because it has to be. Media3 merges every consecutive
         * `GlMatrixTransformation` into a single shader program and draws ONE quad through the
         * product of their matrices, so the sizes the intermediate steps report are used to work
         * the next matrix out and nothing else: there is no intermediate framebuffer and therefore
         * no intermediate clip. A `Crop` followed by a `Presentation` that letterboxes would put
         * the picture in the middle of the output and then paint the very pixels the crop threw
         * away into the bars around it, because the only clip in the chain is the output's own
         * edges. Folding the lot into one rectangle sidesteps that: everything outside it lands
         * outside the output frame, where GL discards it, whether Media3 merges the passes or not.
         *
         * The result is deliberately allowed OUTSIDE 0..1. A letterbox bar is a piece of the output
         * that corresponds to no piece of the source, so a clip that is letterboxed top and bottom
         * returns a window with a negative y and a height above 1 - exactly the "crop to a larger
         * frame" that Media3's own `Crop` documents, and the reason the padding comes out black.
         *
         * `fit` is measured on the CROPPED picture against the destination rectangle, both in real
         * pixels, because a ratio of two shapes cannot be taken in fractions of two different
         * frames. COVER overflows its rectangle and the overflow has to go somewhere; with one
         * matrix and nothing to clip against, the only place it can go is out of the source window,
         * so COVER narrows the crop to the destination's shape instead of scaling past it. The
         * picture that reaches the screen is the same either way.
         *
         * Pure, and it lives here rather than in [CompositionBuilder] so it can be checked on the
         * JVM: the GL side only reads it back out in `configure`, where the source frame's real
         * size is finally known.
         */
        fun sourceWindow(clip: Clip, output: Output, inputWidth: Int, inputHeight: Int): Rect {
            val crop = clip.crop ?: FULL_FRAME
            // The rectangle's four numbers and not its angle, because the fit is measured BEFORE
            // the turn, in the upright rectangle, and the whole fitted result is turned afterwards
            // as one piece. Measuring it against the turned rectangle's bounding box instead would
            // swell and shrink the picture as the customer spun it.
            val rect = clip.rect?.bounds ?: FULL_FRAME

            // One pixel floors everywhere, so a hand-built spec cannot divide by zero below and
            // turn the matrix into NaN, which would show up as a black clip and nothing else.
            val picW = (crop.w * inputWidth).coerceAtLeast(1f)
            val picH = (crop.h * inputHeight).coerceAtLeast(1f)
            val boxW = (rect.w * output.width).coerceAtLeast(1f)
            val boxH = (rect.h * output.height).coerceAtLeast(1f)

            // src maps onto dst exactly, with no part of the picture left over: the whole of the
            // fit is in the pair, and what follows is the same three lines for either fit.
            val src: Rect
            val dst: Rect
            if (clip.fit == Fit.COVER) {
                val scale = max(boxW / picW, boxH / picH)
                // What the destination can actually show of the picture, back in source fractions.
                // The min() is only there because the axis the scale came from divides out to the
                // crop's own side and float arithmetic can land a hair over it.
                val visW = min(boxW / scale / inputWidth, crop.w)
                val visH = min(boxH / scale / inputHeight, crop.h)
                src = Rect(crop.x + (crop.w - visW) / 2f, crop.y + (crop.h - visH) / 2f, visW, visH)
                dst = rect
            } else {
                val scale = min(boxW / picW, boxH / picH)
                val drawW = picW * scale / output.width
                val drawH = picH * scale / output.height
                src = crop
                dst = Rect(rect.x + (rect.w - drawW) / 2f, rect.y + (rect.h - drawH) / 2f, drawW, drawH)
            }

            // src sits on dst, so source fractions per output fraction is the ratio of their sides;
            // running that back out to the whole output frame says where its corners sit on the
            // source. The window's aspect is the OUTPUT's by construction, which is what lets the
            // caller declare the output size and get no distortion out of it.
            val kx = src.w / dst.w
            val ky = src.h / dst.h
            return Rect(
                x = src.x - dst.x * kx,
                y = src.y - dst.y * ky,
                w = kx,
                h = ky,
            )
        }

        /**
         * The centre of a rectangle in normalised device coordinates: origin centre, y UP, edges at
         * -1 and 1.
         *
         * One function because there is one flip. The web counts from the top-left with y down and
         * GL counts from the middle with y up, and a layer's anchor, the pivot a turn happens about
         * and the centre of a source window are the same arithmetic on three different rectangles.
         * Two copies of it could disagree, and a picture turned about a point half a frame from
         * where it was placed is not a bug anyone reads off the code.
         */
        fun centreNdcX(rect: Rect): Float = 2f * (rect.x + rect.w / 2f) - 1f

        fun centreNdcY(rect: Rect): Float = 1f - 2f * (rect.y + rect.h / 2f)

        /** What an absent `crop` or `rect` means: all of it. */
        private val FULL_FRAME = Rect(0f, 0f, 1f, 1f)

        /**
         * The wire's angle as GL counts angles, or 0 for a picture that is not turned at all.
         *
         * Three readings collapse to 0, and each has to. An ABSENT angle, which is every clip the
         * editor has ever sent. A non-finite one, which is the second line of defence behind the
         * parser and keeps a NaN out of a matrix that would otherwise blacken the whole clip. And a
         * whole number of turns, which is the same upright rectangle by the manifest's own
         * definition and would otherwise be resampled through a transform whose cosine is a
         * rounding error away from 1.
         *
         * The sign is [OverlayPlacement.rotationGlDeg]'s, for the same reason: the wire counts
         * CLOCKWISE as CSS `rotate()` does, and a positive z-rotation in a y-up frame turns
         * counter-clockwise.
         */
        private fun rotationGlDegOf(rect: Placement?): Float {
            val deg = rect?.rotationDeg ?: return 0f
            if (!deg.isFinite()) return 0f
            return if (deg % 360f == 0f) 0f else -deg
        }

        /**
         * Music is laid out as explicit repetitions rather than with `setIsLooping`, which repeats
         * the WHOLE sequence: a track that starts three seconds in would go silent for three
         * seconds on every repeat. Explicit items also let the last one be clipped exactly to the
         * end of the video, so the audio sequence can never outlast (and therefore extend) it.
         */
        private fun planMusic(music: Music?, probes: Map<String, ProbedInput>, totalUs: Long): MusicPlan? {
            if (music == null) return null
            val probed = probes[music.uri]
            val outMs = if (probed != null && probed.durationMs > 0L) {
                min(music.outMs, probed.durationMs)
            } else {
                music.outMs
            }
            val trackLenUs = (outMs - music.inMs) * 1000L
            if (trackLenUs <= 0L) return null

            val startUs = music.startMs * 1000L
            val availableUs = totalUs - startUs
            if (availableUs <= 0L) return null

            val reps = if (music.loop) {
                max(1, ceil(availableUs.toDouble() / trackLenUs.toDouble()).toInt())
            } else {
                1
            }
            val lastLenUs = if (music.loop) {
                availableUs - (reps - 1) * trackLenUs
            } else {
                min(trackLenUs, availableUs)
            }
            if (lastLenUs <= 0L) return null

            val inUs = music.inMs * 1000L
            val fadeInUs = music.fadeInMs * 1000L
            val fadeOutUs = music.fadeOutMs * 1000L

            val items = (0 until reps).map { k ->
                val lenUs = if (k == reps - 1) lastLenUs else trackLenUs
                MusicItem(
                    inUs = inUs,
                    outUs = inUs + lenUs,
                    gain = RampGainProvider(
                        level = music.volume,
                        // A fade belongs to the start of the track and the end of the video, not to
                        // every repetition.
                        fadeInUs = if (k == 0) fadeInUs else 0L,
                        fadeOutStartUs = if (k == reps - 1 && fadeOutUs > 0L) {
                            max(0L, lenUs - fadeOutUs)
                        } else {
                            C.TIME_UNSET
                        },
                        fadeOutUs = if (k == reps - 1) fadeOutUs else 0L,
                    ),
                )
            }
            return MusicPlan(uri = music.uri, leadGapUs = startUs, items = items)
        }

        private fun planVoice(
            takes: List<Voiceover>,
            probes: Map<String, ProbedInput>,
            totalUs: Long,
        ): VoicePlan? {
            if (takes.isEmpty()) return null
            val items = ArrayList<VoiceItem>(takes.size)
            var cursorUs = 0L
            for (take in takes.sortedBy { it.startMs }) {
                val startUs = take.startMs * 1000L
                if (startUs >= totalUs) continue
                // The editor prevents overlaps; a manifest that still has one loses the later take
                // rather than silently shifting it.
                if (startUs < cursorUs) continue
                val probed = probes[take.uri]
                val sourceMs = if (probed != null && probed.durationMs > 0L) {
                    min(take.durationMs, probed.durationMs)
                } else {
                    take.durationMs
                }
                val lenUs = min(sourceMs * 1000L, totalUs - startUs)
                if (lenUs <= 0L) continue
                items += VoiceItem(
                    gapBeforeUs = startUs - cursorUs,
                    uri = take.uri,
                    clipEndUs = lenUs,
                    level = take.volume,
                )
                cursorUs = startUs + lenUs
            }
            return if (items.isEmpty()) null else VoicePlan(items)
        }

        /** One millisecond: a floor that keeps a degenerate spec from producing a zero-length item. */
        private const val MIN_CLIP_US = 1_000L

        /** Two pixels: the same kind of floor as [MIN_CLIP_US], for a layer's own frame. */
        private const val MIN_LAYER_PX = 2

        /**
         * The most a layer clip is supersampled under a zoom. Four is a webcam bubble a quarter of
         * the frame wide drawn at the frame's own width, which is about all its source has to give.
         */
        const val MAX_LAYER_SUPERSAMPLE = 4f

        /** The texture side every GL ES implementation this plugin runs on guarantees. */
        const val MAX_TEXTURE_PX = 4096
    }
}
