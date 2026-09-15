package net.dotnetdreamer.choisy.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.util.UnstableApi
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToLong

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

    /** How many audio-only sequences this plan adds beside the video one. */
    val extraAudioSequences: Int
        get() = (if (music != null) 1 else 0) + (if (voice != null) 1 else 0)

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
                val outDurUs = ((outUs - inUs) / speed.toDouble()).roundToLong()

                val gain = if (spec.audio.originalMuted || clip.muted) {
                    0f
                } else {
                    (clip.volume * spec.audio.originalVolume).coerceIn(0f, 1f)
                }
                // A silent item inside a sequence that carries audio is filled with generated
                // silence, so dropping the track is free and saves a decoder.
                val sourceHasAudio = probe?.hasAudio ?: true
                val removeAudio = gain <= 0f || !sourceHasAudio

                prefix[i] = cursorUs
                cursorUs += outDurUs
                planned += PlannedClip(clip, inUs, outUs, outDurUs, gain, removeAudio)
            }

            val totalUs = max(cursorUs, MIN_CLIP_US)
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
                colorMatrix = colorMatrix,
                overlays = overlays,
                music = planMusic(spec.audio.music, probes, totalUs),
                voice = planVoice(spec.audio.voiceover, probes, totalUs),
                posterAtUs = min(spec.posterAtMs * 1000L, max(0L, totalUs - 1L)),
            )
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
    }
}
