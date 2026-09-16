package net.dotnetdreamer.choisy.videocomposer

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
    /** False when every clip's sound is gone, which lets the video sequence skip audio entirely. */
    val videoSeqHasAudio: Boolean,
    /**
     * The extra video layers, bottom to top, and only the ones that show something. EMPTY IS THE
     * WHOLE OF THE FAST PATH: the builder tests this once and, finding nothing, builds the
     * single-sequence composition it has always built, which is also what a spec whose only layer
     * starts after the base has ended comes back to.
     */
    val tracks: List<PlannedTrack>,
    /** Null when `filter` was empty. */
    val colorMatrix: ColorMatrix?,
    val overlays: List<OverlayPlacement>,
    val music: MusicPlan?,
    val voice: VoicePlan?,
    val posterAtUs: Long,
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
         * The frame this clip's picture is drawn into, in real pixels. A clip on the base track
         * draws into the output frame itself, which is what every clip did before layers existed.
         * A clip on an extra track draws into a frame the size of its own `rect`, and the
         * compositor then puts that frame where the rectangle says - see [LayerPlacement]. Its
         * `rect` is dropped from [clip] for exactly that reason: the rectangle has become the
         * frame, and leaving it on would place the picture inside the layer a second time.
         */
        val frame: Output,
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
    )

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

    /** Whether the composition is ONE sequence, which is the only case [reweight] can answer for. */
    val singleSequence: Boolean
        get() = tracks.isEmpty() && extraAudioSequences == 0

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

            // Exactly what was planned, not a floor over it. Every layer is cut to this length,
            // every audio sequence is measured against it and every trailing gap is the difference
            // between it and a layer's end, so a total LONGER than the clips that add up to it
            // would hand those a room the base never fills - the same disagreement between the plan
            // and the items that a coarser clip grid causes. A base whose whole planned length is
            // under a millisecond is rare but reachable: a one millisecond source at MAX_SPEED
            // plans 250 us. The floor survives only for an empty clip list, which the parser
            // refuses and only a direct caller can produce.
            val totalUs = if (planned.isEmpty()) MIN_CLIP_US else cursorUs
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

            return RenderPlan(
                spec = spec,
                clips = planned,
                prefixOutUs = prefix,
                totalUs = totalUs,
                videoSeqHasAudio = planned.any { !it.removeAudio },
                // Bottom to top, and `sortedBy` is stable, so two layers claiming one z keep the
                // order the spec listed them in - which is the tie-break the contract names. A
                // layer whose start time falls past the end of the base contributes nothing
                // anywhere and is dropped here, exactly as iOS declines to add its track: an empty
                // layer is a sequence, a decoder and a compositor input for a picture nobody sees.
                tracks = spec.tracks.sortedBy { it.z }
                    .map { planTrack(it, spec, probes, totalUs) }
                    .filter { it.clips.isNotEmpty() },
                colorMatrix = colorMatrix,
                overlays = overlays,
                music = planMusic(spec.audio.music, probes, totalUs),
                voice = planVoice(spec.audio.voiceover, probes, totalUs),
                posterAtUs = min(spec.posterAtMs * 1000L, max(0L, totalUs - 1L)),
            )
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
                frame = frame,
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
        ): PlannedTrack {
            val clips = ArrayList<PlannedClip>(track.clips.size)
            val placements = ArrayList<LayerPlacement>(track.clips.size)
            val startUs = (track.startMs * 1000L).coerceIn(0L, totalUs)
            var cursorUs = startUs

            for (clip in track.clips) {
                if (cursorUs >= totalUs) break
                val rect = clip.rect ?: FULL_FRAME
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
                clips += item
                placements += LayerPlacement(
                    startUs = cursorUs,
                    endUs = cursorUs + item.outDurUs,
                    anchorX = 2f * (rect.x + rect.w / 2f) - 1f,
                    anchorY = 1f - 2f * (rect.y + rect.h / 2f),
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
            val rect = clip.rect ?: FULL_FRAME

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

        /** What an absent `crop` or `rect` means: all of it. */
        private val FULL_FRAME = Rect(0f, 0f, 1f, 1f)

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
    }
}
