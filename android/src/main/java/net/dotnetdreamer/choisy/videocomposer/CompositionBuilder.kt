package net.dotnetdreamer.choisy.videocomposer

import android.content.Context
import android.graphics.Matrix
import android.media.MediaCodecInfo
import android.net.Uri
import android.os.Build
import android.os.Looper
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.OverlaySettings
import androidx.media3.common.SpeedParameters
import androidx.media3.common.VideoCompositorSettings
import androidx.media3.common.audio.AudioProcessor
import androidx.media3.common.audio.GainProcessor
import androidx.media3.common.audio.SpeedProvider
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.MatrixTransformation
import androidx.media3.effect.OverlayEffect
import androidx.media3.effect.Presentation
import androidx.media3.effect.StaticOverlaySettings
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
 * The shape is one video sequence per layer - any extra layer's clips, top layer first, then the
 * base track's - plus at most one audio-only sequence for music and one for voiceovers. Concurrent
 * sequences are how Media3 mixes and how it composites, so neither "background music over the
 * clips' own sound" nor "a second video over the first" needs a mixer of ours. Why the base comes
 * last rather than first is written out in [toComposition], where the order is decided.
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

        val sequences = ArrayList<EditedMediaItemSequence>(
            1 + plan.tracks.size + plan.extraAudioSequences,
        )
        // TOP LAYER FIRST and the base LAST, which is the order Media3 1.11.1 actually draws in.
        // DefaultCompositorGlProgram.drawFrame walks its frame list from the END backwards, blending
        // each one over what is already there, and DefaultVideoCompositor.getFramesToComposite puts
        // the PRIMARY input at the head of that list; the primary is whichever input registered
        // first, Transformer registers each input under its sequence's index, and Media3 itself
        // assumes sequence 0 gets there first - `maybeComposite` reads the primary's frame out of
        // that list BY the primary's input index, which only lands on the primary when the index is
        // zero. So the first sequence is blended LAST and ends up on top, and an extra layer
        // registered after the base would be painted under the base and never seen at all, the base
        // being opaque and the size of the whole frame. Registering the layers in front of the base
        // is therefore the only arrangement that honours "the extra track is drawn on top".
        //
        // That moves the primary from the base to the top layer, and the primary is also what the
        // output is measured by: the compositor emits one frame per primary frame, stamped with the
        // primary's timestamp, and stops when the primary's stream ends. The base would then decide
        // nothing. `layerSequence` is what makes that safe - every layer sequence is padded with
        // gaps to exactly the base's length, so whichever layer is primary runs from 0 to the end
        // of the base and no further. Rule 1 is kept by the padding and rule 3 by the order.
        //
        // The PRICE of that order is the output's cadence, and it is a real limit rather than an
        // oversight. `maybeComposite` emits exactly one frame per primary frame and stamps it with
        // the primary's presentation time, and `getFramesToComposite` gives the secondaries by
        // nearest timestamp, so while an extra layer is on screen the whole post runs at that
        // layer's frame rate and the base is resampled onto it: a 24 fps layer over a 30 fps base
        // holds each base frame a little longer for the length of the overlap. Nothing downstream
        // puts it back. The composited texture goes straight to the encoder's surface carrying that
        // timestamp; `DefaultEncoderFactory` writes MediaFormat's `frame-rate` from the format it
        // is asked to encode, substituting 30 when that format carries no frame rate OR when the
        // device is on its default-frame-rate workaround list, and it is a rate-control hint rather
        // than a resampler. `VideoEncoderSettings` in 1.11.1 has no frame rate field at all,
        // and neither `Composition.Builder` nor `Transformer.Builder` has one either.
        // The only frame rate effect in `androidx.media3.effect` is `FrameDropEffect`, whose two
        // shader programs DROP frames and cannot invent one, so it can cap a cadence and never
        // raise it. And the cadence cannot be handed back to the base, because the primary is the
        // first input registered and the first input registered is the one drawn last: on top and
        // primary are the same thing in 1.11.1, so a layer cannot have one without the other.
        //
        // What is bounded is the other direction. Every clip on every sequence is given
        // `setFrameRate(output.fps)` (see editedClip), which Media3 turns into a per-item decimator
        // in the asset loader, so no source can push the post above the spec's ceiling. The gaps
        // that pad a layer are the one exception: Media3 emits blank frames at a hardcoded 30 fps,
        // which is exactly the 30 every manifest the editor writes asks for, but a spec naming a
        // lower ceiling would still see its gaps run at 30, and there is no way to ask a gap for
        // anything else.
        val layers = plan.tracks.asReversed()
        for (track in layers) {
            sequences += layerSequence(track, plan.totalUs, output, plan.colorMatrix)
        }
        sequences += videoSequence(plan.clips, plan.videoSeqHasAudio, output, plan.colorMatrix)
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
        // The colour itself is applied per clip (see editedClip); this identity pass is only the
        // progress tap, and it sits before the overlays like the colour did.
        compositionEffects += ColorMatrixEffect(ColorMatrix.IDENTITY, progressTap)
        overlays.chunked(OVERLAYS_PER_EFFECT).forEach { chunk ->
            compositionEffects += OverlayEffect(ImmutableList.copyOf(chunk))
        }

        val builder = Composition.Builder(sequences)
            .setEffects(Effects(/* audioProcessors= */ ImmutableList.of(), compositionEffects))
        // Asked once, here, and never per frame: a spec with no extra layers gets no compositor
        // settings object at all, which is the composition Media3 has been handed all along. The
        // compositor is given the layers in REGISTRATION order, because the input id it is asked
        // about is the sequence's index in the list above.
        if (layers.isNotEmpty()) {
            builder.setVideoCompositorSettings(LayerCompositor(output, layers))
        }
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

    /**
     * The BASE track's clips as a sequence, which is the sequence this engine has always built.
     */
    private fun videoSequence(
        clips: List<RenderPlan.PlannedClip>,
        hasAudio: Boolean,
        output: Output,
        colorMatrix: ColorMatrix?,
    ): EditedMediaItemSequence {
        val items = clips.map { editedClip(it, output, colorMatrix) }
        return if (hasAudio) {
            EditedMediaItemSequence.withAudioAndVideoFrom(items)
        } else {
            EditedMediaItemSequence.withVideoFrom(items)
        }
    }

    /**
     * One extra layer as a sequence that spans the WHOLE output: a gap, the layer's own clips, then
     * another gap.
     *
     * A clip is a clip, so the items themselves are built exactly as the base track's are - the only
     * thing a layer changes is the frame each clip is drawn into, and the plan decided that already
     * (see [RenderPlan.PlannedClip.frame]). The gaps are what make the layer a layer.
     *
     * The LEADING gap is the track's `startMs`, and it is a gap rather than an alpha gate because
     * `startMs` has to delay the sound as well as the picture. `EditedMediaItemSequence.Builder`'s
     * `addGap` adds an ordinary item with no source, and `SequenceAssetLoader` serves it by feeding
     * the sequence a 16 x 16 opaque-black bitmap at a fixed 30 fps for the gap's duration, plus - if
     * the sequence declares an audio track - a signalled audio gap, which is silence. Frames and
     * silence are exactly what is wanted: the layer's first clip then starts at `startMs` on its own
     * timeline as well as the output's, so the footage on screen matches iOS and the preview, and
     * nothing of the layer is audible before then.
     *
     * The TRAILING gap runs from the layer's last clip to the end of the base. It is there because
     * the first sequence registered is Media3's primary input and the composited video ends when the
     * primary's stream does; padding every layer to the base's length means the layer that ends up
     * primary cannot cut the post short, whichever one it is.
     *
     * The black frames both gaps emit never reach the screen: [LayerCompositor] gives the layer an
     * alpha of 0 outside its clips, so the belt holds even if the braces fail. Rule 4 and rule 1 are
     * the gaps' job, hiding the black is the gate's.
     *
     * That claim only holds while the gate's windows and the clips' own windows are the SAME
     * windows, which is why [editedClip] clips in microseconds. The gate is timed off the plan's
     * placements, so an item clipped to a coarser grid would run out inside a window the gate still
     * calls visible, and the gap waiting behind it would paint its opaque black over the base for
     * the difference.
     *
     * The track types are declared up front rather than through `experimentalSetForceAudioTrack`,
     * which in 1.11.1 asserts that the builder was made with one of the deprecated constructors and
     * throws on this one. Declaring them is also what lets a sequence OPEN with a gap at all, and
     * what tells the gap whether to carry silence: a video-only layer's gap is picture alone.
     *
     * Declaring them is also what keeps the audio MIX format out of the gap's hands. Media3 takes
     * the format the whole mix is done in from the first audio input registered, and now that the
     * layers register ahead of the base that input can be a layer that opens with a gap. What the
     * gap reports is not a half-format: `GapSignalingAssetLoader` hands the sequence a complete
     * 44.1 kHz stereo 16-bit PCM format, which is a format the mixer is happy with and one every
     * other input is resampled into, so the worst of it is a sample rate conversion for a 48 kHz
     * source. The case actually worth worrying about - a silent layer whose gap's silence displaces
     * the base's music - cannot arise, because a silent layer declares TRACK_TYPE_VIDEO alone, the
     * gap produces audio only for a sequence that declared TRACK_TYPE_AUDIO, and a sequence that
     * reports no audio track registers no audio input and so cannot set the mix format. Nor is any
     * of this new: `musicSequence` has always been able to open with a gap, and did set the mix
     * format whenever every clip on the base was muted.
     */
    private fun layerSequence(
        track: RenderPlan.PlannedTrack,
        totalUs: Long,
        output: Output,
        colorMatrix: ColorMatrix?,
    ): EditedMediaItemSequence {
        val trackTypes = if (track.hasAudio) {
            setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO)
        } else {
            setOf(C.TRACK_TYPE_VIDEO)
        }
        val builder = EditedMediaItemSequence.Builder(trackTypes)
        if (track.startUs > 0L) builder.addGap(track.startUs)
        for (planned in track.clips) builder.addItem(editedClip(planned, output, colorMatrix))
        // A gap must have a positive duration or Media3 rejects it, and a layer cut at the base's
        // own end has no room left for one.
        val tailUs = totalUs - track.endUs
        if (tailUs > 0L) builder.addGap(tailUs)
        return builder.build()
    }

    private fun editedClip(planned: RenderPlan.PlannedClip, output: Output, colorMatrix: ColorMatrix?): EditedMediaItem {
        val clip = planned.clip
        val mediaItem = MediaItem.Builder()
            .setUri(Uri.parse(clip.uri))
            .setClippingConfiguration(
                MediaItem.ClippingConfiguration.Builder()
                    // Microseconds, because the plan is in microseconds and feeding it through the
                    // millisecond setters means dividing by 1000 first, which FLOORS. (The setters
                    // themselves do not: they multiply back up. The loss is in the conversion.) A
                    // layer clip cut to the room the base has left rarely ends on a whole
                    // millisecond, and the up to 999 us that division drops are up to 3_996 us of
                    // OUTPUT at the slowest speed: the item would run short of the placement the
                    // plan gave it, so the layer sequence would come up short of the base, and
                    // where a trailing gap follows, that gap's opaque black would be composited
                    // over the base while the alpha gate - which is timed off the plan - still said
                    // the clip was visible. Both ends are read off the plan rather than off the
                    // manifest so that the item and the gate measure the same clip with the same
                    // numbers. `ClippingConfiguration` stores only the microseconds and derives its
                    // millisecond fields from them, and `EditedMediaItem.getClippedDuration` reads
                    // the microsecond ones, so this is the resolution the mechanism really has.
                    .setStartPositionUs(planned.inUs)
                    .setEndPositionUs(planned.outUs)
                    .build(),
            )
            .build()

        val audioProcessors: List<AudioProcessor> =
            if (planned.removeAudio || planned.gain >= 1f) {
                emptyList()
            } else {
                listOf(GainProcessor(RampGainProvider(level = planned.gain)))
            }

        // Exactly one effect does the geometry, and which one is decided here rather than per
        // frame. A clip that asks for neither a crop nor a rect gets the Presentation it always
        // got, unchanged, which is the whole of the promise that every manifest written before
        // those fields renders as it did. A clip that asks for either gets a single transform that
        // folds crop, fit and rect together - see RenderPlan.sourceWindow for why it cannot be a
        // Crop followed by a Presentation. The frame both of them work against is the clip's own:
        // the output frame on the base track, and the layer's rectangle on any other.
        val geometry: Effect = if (planned.reframed) {
            Reframe(clip, planned.frame)
        } else {
            Presentation.createForWidthAndHeight(
                planned.frame.width,
                planned.frame.height,
                layoutFor(clip.fit),
            )
        }

        // The colour goes on the picture BEFORE the geometry letterboxes it. Applied to the finished
        // frame, a filter's tint or fade coloured the black bars of every clip that is not 9:16 -
        // brown bars under "Golden", grey ones under a fade - which the customer never asked for.
        // A colour matrix commutes with the geometry's scaling, so the picture itself is unchanged,
        // and the bars a crop or a rect leaves are bars like any other: they stay black.
        val videoEffects: List<Effect> = listOfNotNull(
            colorMatrix?.let { ColorMatrixEffect(it, progressTap = null) },
            geometry,
        )

        val builder = EditedMediaItem.Builder(mediaItem)
            .setRemoveAudio(planned.removeAudio)
            // A MAXIMUM, not a target: 60 fps sources and speed-ups are decimated to this. Media3
            // turns it into one frame interval in the asset loader's video renderer and drops any
            // decoded frame that arrives inside it, and the speed change has already been applied
            // to the sample timestamps by then, so a 4x clip is capped here like any other source.
            // Nothing in Media3 can raise a rate, which is why this is the whole of the cadence
            // this engine controls - see the compositor note in toComposition.
            .setFrameRate(output.fps)
            .setEffects(Effects(audioProcessors, videoEffects))

        if (clip.speed != 1f) {
            // Transformer inserts the speed change as the first video effect and first audio
            // processor of the item, so our gain runs on post-speed audio and the geometry on
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

    /**
     * Crop, fit and rect as one vertex-shader matrix, for the clips that ask for any of them.
     *
     * Media3 hands a `MatrixTransformation` the source frame's real size in [configure] and then
     * asks for a 3x3 matrix over normalised device coordinates, which it applies to the corners of
     * the quad the frame is drawn on - not to the texture. Everything the matrix pushes past the
     * edge of the frame is clipped by GL, and everything the quad does not reach is left at the
     * cleared background, which encodes as black. That is the whole mechanism: pick the window of
     * the source the frame stands for, and map it onto the frame's own -1..1 square. The frame is
     * the output's for a clip on the base track and the layer's rectangle for any other, which is
     * the only difference between the two.
     *
     * [RenderPlan.sourceWindow] picks the window, and the maths for why it is ONE window and not a
     * crop pass followed by a presentation pass is written out there. Here there is only the change
     * of coordinates: the window is 0..1 with y DOWN, NDC is -1..1 with y UP, the same flip the
     * overlay anchors get.
     *
     * The matrix is rebuilt in [configure] because the window depends on the source's pixel size,
     * and [configure] is where Media3 finally knows it. It is rebuilt rather than recomputed per
     * frame because nothing in it moves: [getMatrix] hands back the same instance every frame, as
     * Media3's own `Crop` does, and Media3 copies it into a float array before drawing.
     */
    private class Reframe(private val clip: Clip, private val frame: Output) : MatrixTransformation {

        private val matrix = Matrix()

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            val window = RenderPlan.sourceWindow(clip, frame, inputWidth, inputHeight)
            val centreX = 2f * (window.x + window.w / 2f) - 1f
            val centreY = 1f - 2f * (window.y + window.h / 2f)
            matrix.reset()
            // Put the window's centre on the origin, then open it out until its sides are the
            // frame's: an NDC side of 2 spans a window side of w, so the scale is 1 / w.
            matrix.postTranslate(-centreX, -centreY)
            matrix.postScale(1f / window.w, 1f / window.h)
            // The window has the frame's aspect ratio by construction, so declaring the frame's
            // size here scales the picture without stretching it.
            return Size(frame.width, frame.height)
        }

        override fun getMatrix(presentationTimeUs: Long): Matrix = matrix
    }

    /**
     * Where each video layer is drawn, per input and per frame.
     *
     * Media3 treats every input of its compositor as an overlay on the output frame and asks this
     * about each one. `backgroundFrameAnchor` is the point of the OUTPUT frame that the layer's own
     * anchor is put on, in normalised device coordinates - origin centre, y up, edges at -1 and 1 -
     * and a layer's own anchor defaults to its centre. The scale is deliberately left alone: the
     * compositor's matrix already carries layerWidth / outputWidth, so a layer is drawn at one
     * output pixel per layer pixel, and the plan has drawn every clip at the size of the rectangle
     * it goes in. That leaves the centre as the whole of the placement, which is the same
     * arithmetic iOS does when it turns the rectangle into a destination CGRect, said in the one
     * form Media3 accepts.
     *
     * A layer's `startMs` is LAID OUT, in the layer's own sequence, and this gate only hides what
     * the layout leaves behind - see `layerSequence`. The two gaps that pad a layer to the base's
     * length feed Media3 black frames, and black over the base is a black box rather than the base
     * showing through, so the gate hands back an alpha of 0 for every instant outside the layer's
     * clips: before its first, after its last, and for the whole of both gaps.
     */
    private class LayerCompositor(
        output: Output,
        tracks: List<RenderPlan.PlannedTrack>,
    ) : VideoCompositorSettings {

        private val size = Size(output.width, output.height)
        private val layers: List<Layer> = tracks.map { Layer(it) }

        // Declared rather than derived from the inputs: every layer has been drawn against this
        // frame already, and the composition's own Presentation would only have to undo a
        // compositor that had chosen anything else.
        override fun getOutputSize(inputSizes: List<Size>): Size = size

        override fun getOverlaySettings(inputId: Int, presentationTimeUs: Long): OverlaySettings {
            // The input id is the sequence's index in the composition, and the extra layers were
            // registered first, top one first. Anything past them is the base sequence, which is
            // composited exactly as it arrives.
            val layer = layers.getOrNull(inputId) ?: return BASE
            return layer.settingsAt(presentationTimeUs)
        }

        /**
         * One layer's settings, worked out once. Media3 asks for these on every frame of every
         * input, so nothing here allocates: the only thing that changes over a layer's life is
         * which of its clips is on screen, and there are a handful of those.
         */
        private class Layer(private val track: RenderPlan.PlannedTrack) {

            private val hidden: OverlaySettings =
                StaticOverlaySettings.Builder().setAlphaScale(0f).build()
            private val placed: List<OverlaySettings> = track.placements.map {
                StaticOverlaySettings.Builder()
                    .setBackgroundFrameAnchor(it.anchorX, it.anchorY)
                    // The track's opacity multiplies the picture's own alpha, which for a video
                    // frame is 1 everywhere, so this IS the track's opacity on the output.
                    .setAlphaScale(track.opacity)
                    .build()
            }

            /**
             * Hidden past the layer's last clip, and the 1.11.1 bytecode says the freeze is real
             * rather than theoretical. `releaseExcessFramesInSecondaryStream` releases all but ONE
             * of a secondary input's frames up to the primary's time, and `getFramesToComposite`
             * declines to wait for more only when that input has ended, so an ended secondary hands
             * the compositor the same final frame on every output frame that follows. A layer that
             * stopped there would have its last picture pinned over the base for the rest of the
             * post, where rule 1 says the base shows through.
             *
             * The trailing gap in `layerSequence` means the stream no longer ends early at all, so
             * this is the second of two defences and not the only one. It costs a comparison.
             */
            fun settingsAt(timeUs: Long): OverlaySettings {
                val i = track.visibleIndexAt(timeUs)
                return if (i == RenderPlan.PlannedTrack.HIDDEN) hidden else placed[i]
            }
        }

        private companion object {
            /** The base track, composited as it arrives: centred, unscaled and opaque. */
            val BASE: OverlaySettings = StaticOverlaySettings.Builder().build()
        }
    }

    private class ConstantSpeedProvider(private val speed: Float) : SpeedProvider {
        override fun getSpeed(timeUs: Long): Float = speed
        override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET
    }
}
