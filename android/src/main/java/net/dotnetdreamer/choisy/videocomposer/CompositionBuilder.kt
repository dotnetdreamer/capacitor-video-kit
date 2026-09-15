package net.dotnetdreamer.choisy.videocomposer

import android.content.Context
import android.media.MediaCodecInfo
import android.net.Uri
import android.os.Build
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.SpeedParameters
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.GainProcessor
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.TextureOverlay
import androidx.media3.transformer.AudioEncoderSettings
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.google.common.collect.ImmutableList
import java.util.concurrent.atomic.AtomicLong

/**
 * Turns a [RenderPlan] into the Media3 objects that actually do the work.
 *
 * The shape is always the same: one video sequence holding every clip in order, plus at most one
 * audio-only sequence for music and one for voiceovers. Concurrent sequences are how Media3 mixes,
 * so "background music over the clips' own sound" needs no mixer of ours.
 */
@OptIn(UnstableApi::class)
object CompositionBuilder {

    /**
     * How many overlays go into one `OverlayEffect`. Media3 allows 15, but that assumes 16 fragment
     * texture units; OpenGL ES 2.0 only guarantees 8, and one of those is the video itself. Seven
     * is the number that is safe on every device, and extra effects simply chain.
     */
    const val OVERLAYS_PER_EFFECT = 7

    /** Pitch is preserved across speed changes; flipping this also means flipping the other engines. */
    const val MAINTAIN_PITCH = true

    fun toComposition(
        plan: RenderPlan,
        overlays: List<TextureOverlay>,
        progressTap: AtomicLong?,
    ): Composition {
        val output = plan.spec.output

        val clipItems = plan.clips.map { editedClip(it, output) }
        val videoSequence = if (plan.videoSeqHasAudio) {
            EditedMediaItemSequence.withAudioAndVideoFrom(clipItems)
        } else {
            EditedMediaItemSequence.withVideoFrom(clipItems)
        }

        val sequences = ArrayList<EditedMediaItemSequence>(1 + plan.extraAudioSequences)
        sequences += videoSequence
        plan.music?.let { sequences += musicSequence(it) }
        plan.voice?.let { sequences += voiceSequence(it) }

        val compositionEffects = ArrayList<Effect>()
        // A no-op when every item already arrives at the output size, and a safety net when one
        // does not.
        compositionEffects += Presentation.createForWidthAndHeight(
            output.width,
            output.height,
            Presentation.LAYOUT_SCALE_TO_FIT,
        )
        // Colour before overlays: the overlays were rasterised in final colours and must not be
        // filtered along with the video.
        compositionEffects += ColorMatrixEffect(plan.colorMatrix ?: ColorMatrix.IDENTITY, progressTap)
        overlays.chunked(OVERLAYS_PER_EFFECT).forEach { chunk ->
            compositionEffects += OverlayEffect(ImmutableList.copyOf(chunk))
        }

        val builder = Composition.Builder(sequences)
            .setEffects(Effects(/* audioProcessors= */ ImmutableList.of(), compositionEffects))
        if (Build.VERSION.SDK_INT >= 29) {
            // Gallery picks from newer phones are frequently HLG or PQ; without this the export
            // fails outright instead of producing a watchable SDR video.
            builder.setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
        }
        return builder.build()
    }

    fun newTransformer(context: Context, plan: RenderPlan, relaxEncoder: Boolean): Transformer.Builder {
        val output = plan.spec.output
        val videoSettings = if (relaxEncoder) {
            // Second attempt after an encoder refused our request: let the factory choose
            // everything, including the resolution and bitrate it is actually happy with.
            VideoEncoderSettings.DEFAULT
        } else {
            VideoEncoderSettings.Builder()
                .setBitrate(output.videoBitrate)
                .setBitrateMode(MediaCodecInfo.EncoderCapabilities.BITRATE_MODE_VBR)
                .setiFrameIntervalSeconds(1f)
                .build()
        }
        val audioSettings = AudioEncoderSettings.Builder()
            .setBitrate(output.audioBitrate)
            .build()

        val encoderFactory = DefaultEncoderFactory.Builder(context)
            .setRequestedVideoEncoderSettings(videoSettings)
            .setRequestedAudioEncoderSettings(audioSettings)
            // Resolves an unsupported size or bitrate before the export starts rather than failing.
            .setEnableFallback(true)
            .build()

        return Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoderFactory)
            // Transformer must be built, started, polled and cancelled on one Looper thread.
            .setLooper(Looper.getMainLooper())
        // The H.264 profile is deliberately NOT requested: DefaultEncoderFactory ignores a
        // requested profile and picks High itself on API 29+ wherever the encoder offers it.
    }

    /* ---------------------------------------------------------------------------------------- */

    private fun editedClip(planned: RenderPlan.PlannedClip, output: Output): EditedMediaItem {
        val clip = planned.clip
        val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse(clip.uri))
            .setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    .setStartPositionMs(clip.inMs)
                    .setEndPositionMs(planned.outUs / 1000L)
                    .build(),
            )
            .build()

        val audioProcessors: List<AudioProcessor> =
            if (planned.removeAudio || planned.gain >= 1f) {
                emptyList()
            } else {
                listOf(GainProcessor(RampGainProvider(level = planned.gain)))
            }

        val videoEffects: List<Effect> = listOf(
            Presentation.createForWidthAndHeight(output.width, output.height, layoutFor(clip.fit)),
        )

        val builder = EditedMediaItem.Builder(mediaItem)
            .setRemoveAudio(planned.removeAudio)
            // A MAXIMUM, not a target: 60 fps sources and speed-ups are decimated to this.
            .setFrameRate(output.fps)
            .setEffects(Effects(audioProcessors, videoEffects))

        if (clip.speed != 1f) {
            // Transformer inserts the speed change as the first video effect and first audio
            // processor of the item, so our gain runs on post-speed audio and Presentation on
            // post-speed frames. Passing a SpeedChangeEffect alongside this throws, so none is.
            builder.setSpeed(SpeedParameters(ConstantSpeedProvider(clip.speed), MAINTAIN_PITCH))
        }
        return builder.build()
    }

    /**
     * Music as explicit repetitions rather than a looping sequence: looping repeats the whole
     * sequence including its leading gap, and a non-looping audio sequence longer than the video
     * would extend the composition. Clipping the last repetition to the exact remaining time avoids
     * both.
     */
    private fun musicSequence(plan: RenderPlan.MusicPlan): EditedMediaItemSequence {
        val builder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
        if (plan.leadGapUs > 0L) builder.addGap(plan.leadGapUs)
        for (item in plan.items) {
            builder.addItem(audioItem(plan.uri, item.inUs, item.outUs, item.gain))
        }
        return builder.build()
    }

    private fun voiceSequence(plan: RenderPlan.VoicePlan): EditedMediaItemSequence {
        val builder = EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_AUDIO))
        for (item in plan.items) {
            if (item.gapBeforeUs > 0L) builder.addGap(item.gapBeforeUs)
            builder.addItem(
                audioItem(item.uri, 0L, item.clipEndUs, RampGainProvider(level = item.level)),
            )
        }
        return builder.build()
    }

    private fun audioItem(
        uri: String,
        startUs: Long,
        endUs: Long,
        gain: RampGainProvider,
    ): EditedMediaItem {
        val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse(uri))
            .setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    // Microseconds, so repetitions total exactly the remaining video time instead
                    // of drifting by up to a millisecond each.
                    .setStartPositionUs(startUs)
                    .setEndPositionUs(endUs)
                    .build(),
            )
            .build()
        val processors: List<AudioProcessor> =
            if (gain.isNoOp()) emptyList() else listOf(GainProcessor(gain))
        return EditedMediaItem.Builder(mediaItem)
            .setRemoveVideo(true)
            .setEffects(Effects(processors, ImmutableList.of()))
            .build()
    }

    private fun layoutFor(fit: Fit): Int = when (fit) {
        Fit.COVER -> Presentation.LAYOUT_SCALE_TO_FIT_WITH_CROP
        Fit.CONTAIN -> Presentation.LAYOUT_SCALE_TO_FIT
    }

    private class ConstantSpeedProvider(private val speed: Float) : SpeedProvider {
        override fun getSpeed(timeUs: Long): Float = speed
        override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET
    }
}
