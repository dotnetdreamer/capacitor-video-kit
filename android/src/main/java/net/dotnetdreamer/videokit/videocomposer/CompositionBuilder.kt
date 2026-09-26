package net.dotnetdreamer.videokit.videocomposer

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
import androidx.media3.transformer.DefaultMuxer
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.google.common.collect.ImmutableList
import java.util.concurrent.atomic.AtomicLong
import kotlin.math.max

/**
 * Turns a [RenderPlan] into the Media3 objects that actually do the work.
 *
 * The shape is one video sequence per layer - every extra layer's clips, top layer first, then the
 * base track's - then, when the post has transitions, one more holding the outgoing tail of every
 * one of them under the base, plus at most one audio-only sequence for music and one for
 * voiceovers. Concurrent sequences are how Media3 mixes and how it composites, so neither
 * "background music over the clips' own sound" nor "a second video over the first" needs a mixer
 * of ours. Why the base comes after the layers rather than first is written out in
 * [toComposition], where the order is decided.
 *
 * Nothing here is written for a particular NUMBER of layers: the list the plan hands over is what
 * the sequences are built from and what the compositor is indexed by, so fifteen layers take the
 * same code two do.
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
            1 + plan.tracks.size + (if (plan.tails.isEmpty()) 0 else 1) + plan.extraAudioSequences,
        )
        // The grade is ONE instance for the whole post, handed to every clip on every sequence. It
        // holds nothing but the matrix, and Media3 turns it into a fresh shader program wherever it
        // builds a chain, so sharing it cannot carry anything from one clip or sequence to another;
        // what it buys is that Media3 sees the SAME effect on consecutive clips - see [Geometries]
        // for why that saves rebuilding the whole chain at every cut.
        val grade = plan.colorMatrix?.let { ColorMatrixEffect(it) }

        // TOP LAYER FIRST and the base LAST, which is the order Media3 1.11.1 actually draws in.
        // DefaultCompositorGlProgram.drawFrame walks its frame list from the END backwards, blending
        // each one over what is already there, and DefaultVideoCompositor.getFramesToComposite puts
        // the PRIMARY input at the head of that list and then appends every other input in
        // ASCENDING input-id order - it walks `inputSources`, a SparseArray, by position, and a
        // SparseArray holds its keys sorted. So the frame list is the sequences in registration
        // order and the blend runs backwards along it: sequence i is drawn OVER sequence i + 1, for
        // as many sequences as there are, which is what makes an ordered list of layers the whole of
        // the stacking. The primary is whichever input registered first, Transformer registers each
        // input under its sequence's index, and Media3 itself assumes sequence 0 gets there first -
        // `maybeComposite` reads the primary's frame out of that list BY the primary's input index,
        // which only lands on the primary when the index is zero. So the first sequence is blended
        // LAST and ends up on top, and an extra layer registered after the base would be painted
        // under the base and never seen at all, the base being opaque and the size of the whole
        // frame. Registering the layers in front of the base is therefore the only arrangement that
        // honours "the extra track is drawn on top".
        //
        // That moves the primary from the base to the top layer, and the primary is also what the
        // output is measured by: the compositor emits one frame per primary frame, stamped with the
        // primary's timestamp, and stops when the primary's stream ends. The base would then decide
        // nothing. `layerSequence` is what makes that safe - EVERY layer sequence is padded with
        // gaps to exactly the base's length, however many there are, so whichever layer is primary
        // runs from 0 to the end of the base and no further. Rule 1 is kept by the padding and rule
        // 3 by the order.
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
        //
        // The one rate this engine RAISES is a slowed clip's. Media3 retimes a clip below 1x and
        // invents nothing, so 30 fps footage at 0.3x arrives as nine pictures a second; every such
        // clip carries a [SlowMotionEffect] that synthesises the missing frames at the spec's rate
        // inside the clip's own chain, before anything that moves with time is drawn (see
        // editedClip). It lives per input and so works with the compositor rather than against it:
        // a slowed clip on the PRIMARY input gives the compositor a frame to emit at every output
        // instant, and a slowed clip on any other input - the base under a layer, a transition's
        // tail - gives the nearest-timestamp pairing a frame within half an interval of every
        // primary frame, where it used to find one up to a source frame stale. What it cannot do is
        // lend its cadence to a primary that has none: a layer at 1x from 24 fps footage still sets
        // the post's rate while it is on screen, slowed base under it or not.
        val layers = plan.tracks.asReversed()
        for (track in layers) {
            sequences += layerSequence(track, plan.totalUs, output, grade)
        }
        sequences += videoSequence(
            plan.clips,
            plan.prefixOutUs,
            plan.totalUs - plan.baseUs,
            plan.videoSeqHasAudio,
            output,
            grade,
            plan.tails.associateBy { it.index },
            plan.camera,
        )
        // The tails go RIGHT AFTER the base, which by the order above draws them UNDER it - the
        // contract's "outgoing side over black, incoming side over that". Registered after it, they
        // are never the primary input either: the primary stays the top layer when there are
        // layers and the base when there are none, so the output keeps the cadence it has today
        // and never takes on the 30 fps of the blank frames that fill the tails' gaps.
        if (plan.tails.isNotEmpty()) {
            sequences += tailSequence(plan.tails, plan.totalUs, output, grade, plan.camera)
        }
        plan.music?.let { sequences += musicSequence(it) }
        plan.voice?.let { sequences += voiceSequence(it) }

        val compositionEffects = ArrayList<Effect>()
        // A no-op when every item already arrives at the output size, and a safety net when one
        // does not. Its own instance, never one of [Geometries]': Media3 folds this and the clip's
        // Presentation into one matrix list and configures each in turn, and the same instance
        // twice in that list would be configured twice and keep only the second size.
        compositionEffects += Presentation.createForWidthAndHeight(
            output.width,
            output.height,
            Presentation.LAYOUT_SCALE_TO_FIT,
        )
        // The colour itself is applied per clip (see editedClip); this is only the progress tap,
        // and it sits before the overlays like the colour did. An RGB matrix, so Media3 folds it
        // into the Presentation's pass instead of drawing the frame once more - see [ProgressTap].
        progressTap?.let { compositionEffects += ProgressTap(it) }
        overlays.chunked(OVERLAYS_PER_EFFECT).forEach { chunk ->
            compositionEffects += OverlayEffect(ImmutableList.copyOf(chunk))
        }

        val builder = Composition.Builder(sequences)
            .setEffects(Effects(/* audioProcessors= */ ImmutableList.of(), compositionEffects))
        // Asked once, here, and never per frame: a spec with no extra layers and no transitions gets
        // no compositor settings object at all, which is the composition Media3 has been handed all
        // along. The compositor is given the layers in REGISTRATION order, because the input id it
        // is asked about is the sequence's index in the list above - which is why this takes
        // `layers` and not the plan's own bottom-to-top list, whatever their length. A post with
        // transitions and no layers gets one too, so that the tails' input is drawn only while a
        // tail is playing. Between tails that input is a gap, which Media3 serves as small opaque
        // black frames; under the base those are black on black today, wherever the base is
        // transparent, but they are a picture nobody asked for, and a gate that costs a comparison
        // per frame is cheaper than reasoning about them every time the base learns to be
        // transparent somewhere new.
        if (layers.isNotEmpty() || plan.tails.isNotEmpty()) {
            builder.setVideoCompositorSettings(LayerCompositor(output, layers, plan.tails, plan.camera))
        }
        if (Build.VERSION.SDK_INT >= 29) {
            // Gallery picks from newer phones are frequently HLG or PQ; without this the export
            // fails outright instead of producing a watchable SDR video.
            builder.setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
        }
        return builder.build()
    }

    /**
     * A Transformer for [plan]'s output. [bytesWritten] is where the muxer counts the encoded bytes
     * it is handed, for the plugin's poll to hold against the host's size ceiling; with no ceiling
     * nothing is counted, and the export goes through the muxer Transformer picks for itself, by
     * the path every render took before there were ceilings.
     */
    fun newTransformer(
        context: Context,
        plan: RenderPlan,
        relaxEncoder: Boolean,
        bytesWritten: AtomicLong,
    ): Transformer.Builder {
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

        val builder = Transformer.Builder(context)
            .setVideoMimeType(MimeTypes.VIDEO_H264)
            .setAudioMimeType(MimeTypes.AUDIO_AAC)
            .setEncoderFactory(encoderFactory)
            // Transformer must be built, started, polled and cancelled on one Looper thread.
            .setLooper(Looper.getMainLooper())
        // The H.264 profile is deliberately NOT requested: DefaultEncoderFactory ignores a
        // requested profile and picks High itself on API 29+ wherever the encoder offers it.
        if (output.maxBytes != null) {
            // The muxer Transformer uses when given none, counting what it is handed.
            builder.setMuxerFactory(CountingMuxer.Factory(DefaultMuxer.Factory(), bytesWritten))
        }
        return builder
    }

    /* ---------------------------------------------------------------------------------------- */

    /**
     * The BASE track's clips as a sequence, and behind them the TAIL: the stretch of post that runs
     * on past the footage, where the picture is black.
     *
     * The gap is the same `addGap` [layerSequence] pads a layer with, and it draws the same thing -
     * Media3 serves a gap as a 16 x 16 opaque-black bitmap at 30 fps, plus silence for a sequence
     * that declares an audio track. On a LAYER that black has to be hidden behind an alpha gate,
     * because a layer sits over a picture; on the base there is nothing underneath and opaque black
     * is exactly what was asked for.
     *
     * With no tail this is the sequence this engine has always built, through the same two factory
     * methods, so a post nobody has stretched reaches the encoder by the path it always took.
     *
     * A clip that a transition runs INTO is the only one built differently: it draws the incoming
     * side of that transition over its window (see [TransitionEffect]) and its sound fades in over
     * the same window, under the outgoing clip's tail fading out on the sequence below. Every other
     * clip is built exactly as it was before transitions existed, and with no transitions at all
     * [transitionsInto] is empty and so is every difference.
     */
    private fun videoSequence(
        clips: List<RenderPlan.PlannedClip>,
        /** Where each clip starts on the output timeline: the plan's prefix sums. */
        startsUs: LongArray,
        tailUs: Long,
        hasAudio: Boolean,
        output: Output,
        grade: ColorMatrixEffect?,
        transitionsInto: Map<Int, RenderPlan.PlannedTail>,
        camera: CameraTrack? = null,
    ): EditedMediaItemSequence {
        val geometries = Geometries()
        val items = clips.mapIndexed { i, planned ->
            val tail = transitionsInto[i]
            if (tail == null) {
                editedClip(planned, startsUs[i], output, grade, geometries, camera = camera)
            } else {
                editedClip(
                    planned,
                    startsUs[i],
                    output,
                    grade,
                    geometries,
                    transition = TransitionEffect(TransitionRole.TO, tail.transition, tail.startUs, tail.durUs),
                    fadeInUs = tail.durUs,
                    camera = camera,
                )
            }
        }
        if (tailUs <= 0L) {
            return if (hasAudio) {
                EditedMediaItemSequence.withAudioAndVideoFrom(items)
            } else {
                EditedMediaItemSequence.withVideoFrom(items)
            }
        }
        val trackTypes = if (hasAudio) {
            setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO)
        } else {
            setOf(C.TRACK_TYPE_VIDEO)
        }
        val builder = EditedMediaItemSequence.Builder(trackTypes)
        for (item in items) builder.addItem(item)
        // A gap must have a positive duration or Media3 rejects it, which the branch above ensures.
        builder.addGap(tailUs)
        return builder.build()
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
        grade: ColorMatrixEffect?,
    ): EditedMediaItemSequence {
        val trackTypes = if (track.hasAudio) {
            setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO)
        } else {
            setOf(C.TRACK_TYPE_VIDEO)
        }
        val builder = EditedMediaItemSequence.Builder(trackTypes)
        if (track.startUs > 0L) builder.addGap(track.startUs)
        val geometries = Geometries()
        for ((i, planned) in track.clips.withIndex()) {
            builder.addItem(editedClip(planned, track.placements[i].startUs, output, grade, geometries))
        }
        // A gap must have a positive duration or Media3 rejects it, and a layer cut at the base's
        // own end has no room left for one.
        val tailUs = totalUs - track.endUs
        if (tailUs > 0L) builder.addGap(tailUs)
        return builder.build()
    }

    /**
     * Every transition's outgoing side on ONE sequence spanning the whole output: each tail laid at
     * its window, lead first (see [RenderPlan.PlannedTail]), with a gap before it for the stretch
     * since the last one closed, and a gap after the last to pad the sequence to the post's length.
     *
     * One sequence is enough because two windows never overlap - each lies inside its own incoming
     * clip (see [RenderPlan.PlannedTail]) - and it is the same trick a layer plays with its start
     * time, for the same reason: a tail has to be HEARD from its window's first instant as well as
     * seen, and a gap delays both. Every length comes off the plan's floored numbers - the gaps are
     * the differences between them and each item runs exactly its lead and its window, less any end
     * the next tail borrowed for its own lead ([RenderPlan.PlannedTail.itemEndUs]) - so an item
     * never ends while its gate still calls it open, which is the rule [layerSequence] explains.
     *
     * Padded to the post's length like a layer, although it is never the primary input. A secondary
     * input that has ended hands the compositor its LAST frame for every output frame that follows,
     * and the last frame of the last tail is stamped inside that tail's window, so the gate would
     * pass it: a frozen picture of an outgoing clip under the rest of the post, showing through the
     * letterbox bars of every clip after it.
     *
     * A tail item is a clip like any other - trimmed, sped, reframed and graded by [editedClip] -
     * with the outgoing side's look drawn over its frames and its sound silent through the lead,
     * where the base is still playing it, then fading out across the window, under the incoming
     * clip's sound fading in on the base.
     */
    private fun tailSequence(
        tails: List<RenderPlan.PlannedTail>,
        totalUs: Long,
        output: Output,
        grade: ColorMatrixEffect?,
        camera: CameraTrack? = null,
    ): EditedMediaItemSequence {
        val trackTypes = if (tails.any { !it.clip.removeAudio }) {
            setOf(C.TRACK_TYPE_AUDIO, C.TRACK_TYPE_VIDEO)
        } else {
            setOf(C.TRACK_TYPE_VIDEO)
        }
        val builder = EditedMediaItemSequence.Builder(trackTypes)
        val geometries = Geometries()
        var cursorUs = 0L
        for (tail in tails) {
            // A gap must have a positive duration or Media3 rejects it; two windows that meet
            // exactly have nothing between them.
            val gapUs = tail.itemStartUs - cursorUs
            if (gapUs > 0L) builder.addGap(gapUs)
            builder.addItem(
                editedClip(
                    tail.clip,
                    tail.itemStartUs,
                    output,
                    grade,
                    geometries,
                    transition = TransitionEffect(TransitionRole.FROM, tail.transition, tail.startUs, tail.durUs),
                    // Over the part of the window the item still plays: all of it, unless the next
                    // tail borrowed its end, and then the fade still reaches silence rather than
                    // stopping on a click at a tenth of the level.
                    fadeOutUs = tail.itemEndUs - tail.startUs,
                    silentUs = tail.leadUs,
                    camera = camera,
                ),
            )
            cursorUs = tail.itemEndUs
        }
        val trailingUs = totalUs - cursorUs
        if (trailingUs > 0L) builder.addGap(trailingUs)
        return builder.build()
    }

    /**
     * One clip as a Media3 item.
     *
     * [transition], [fadeInUs], [fadeOutUs] and [silentUs] are for a clip a transition touches and
     * nothing else: the incoming side's effect and fade-in on a base clip; the outgoing side's
     * effect on a tail, silent for its first [silentUs] and then fading out over [fadeOutUs]. Left
     * at their defaults they change nothing - the effect list and the audio processors are the ones
     * every clip was given before transitions existed.
     *
     * [startUs] is where the item starts on its sequence's timeline, which is the output's. Only a
     * slowed clip reads it, to know the piece of the timeline its synthesised frames may fill - see
     * [SlowMotionEffect].
     */
    private fun editedClip(
        planned: RenderPlan.PlannedClip,
        startUs: Long,
        output: Output,
        grade: ColorMatrixEffect?,
        geometries: Geometries,
        transition: TransitionEffect? = null,
        fadeInUs: Long = 0L,
        fadeOutUs: Long = 0L,
        silentUs: Long = 0L,
        camera: CameraTrack? = null,
    ): EditedMediaItem {
        val clip = planned.clip
        val mediaItem = if (clip.image) pictureItem(planned) else MediaItem.Builder()
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

        // A full-volume clip needs no processor at all, unless it fades: a fade is a gain that is
        // not 1, whatever the level it fades to. The ramps are linear and MULTIPLY the level (see
        // RampGainProvider), and they count from the item's own first sample, which is the first
        // instant of the window on both sides of a transition.
        val fades = fadeInUs > 0L || fadeOutUs > 0L || silentUs > 0L
        val audioProcessors: List<AudioProcessor> =
            if (planned.removeAudio || (planned.gain >= 1f && !fades)) {
                emptyList()
            } else if (!fades) {
                listOf(GainProcessor(RampGainProvider(level = planned.gain)))
            } else {
                listOf(
                    GainProcessor(
                        RampGainProvider(
                            level = planned.gain,
                            fadeInUs = fadeInUs,
                            fadeOutStartUs = if (fadeOutUs > 0L) silentUs else C.TIME_UNSET,
                            fadeOutUs = fadeOutUs,
                            silentUntilUs = silentUs,
                        ),
                    ),
                )
            }

        // Exactly one effect does the geometry, and which one is decided here rather than per
        // frame. A clip that asks for neither a crop nor a rect gets the Presentation it always
        // got, unchanged, which is the whole of the promise that every manifest written before
        // those fields renders as it did. A clip that asks for either gets a single transform that
        // folds crop, fit and rect together - see RenderPlan.sourceWindow for why it cannot be a
        // Crop followed by a Presentation. The frame both of them work against is the clip's own:
        // the output frame on the base track, and the layer's rectangle on any other.
        val geometry: Effect = if (planned.reframed) {
            Reframe(clip, planned.frame, planned.rotationGlDeg)
        } else {
            geometries.presentation(planned.frame.width, planned.frame.height, layoutFor(clip.fit))
        }

        // The colour goes on the picture BEFORE the geometry letterboxes it. Applied to the finished
        // frame, a filter's tint or fade coloured the black bars of every clip that is not 9:16 -
        // brown bars under "Golden", grey ones under a fade - which the customer never asked for.
        // A colour matrix commutes with the geometry's scaling, so the picture itself is unchanged,
        // and the bars a crop or a rect leaves are bars like any other: they stay black.
        //
        // A transition's side goes AFTER the geometry, so that it is handed the clip's finished
        // output frame - picture and bars together - which is what the contract moves, blurs and
        // tints as one piece. Before the geometry it would move the picture inside bars that stood
        // still.
        //
        // The zoom camera goes straight after the geometry, and that position is the whole of why a
        // zoom stays sharp. Two `MatrixTransformation`s in a row are merged by Media3 into ONE
        // shader pass that draws the source-resolution texture through the product of the two
        // matrices, so a 2x zoom into a 1080p recording posted at 720p samples the recording, not a
        // 720p picture of it blown up. And it goes BEFORE the transition's side, because the
        // contract has each side be its clip's whole frame as seen through the camera, with the
        // transition's move, blur and mask then acting in output pixels as they always have. A
        // clip the plan did not mark zoomed - every clip of a post with no camera - gets nothing.
        //
        // A SLOWED clip's frame synthesis goes between the grade and the geometry, and every other
        // position is wrong for a reason. It has to come after the speed change, which it does
        // wherever it goes: the speed is the source's own retimed samples, not an effect, so every
        // frame reaching the chain is already stamped on the output timeline. It has to come before
        // the camera and the transition's side, which read the frame's timestamp and so have to be
        // handed every synthesised instant to move on every one. It cannot sit between the geometry
        // and the camera, because that would split the one pass the zoom's sharpness depends on (the
        // paragraph above). And after the grade rather than before it, so the grade is drawn once per
        // SOURCE frame instead of once per output frame; a colour matrix and a cross-fade commute but
        // for the clamp, which a blend of two clamped colours never leaves. A clip at 1x or faster, and
        // every picture, gets nothing, and its list is the one it always had.
        val videoEffects: List<Effect> = listOfNotNull(
            grade,
            if (planned.slowed) SlowMotionEffect(startUs, startUs + planned.outDurUs, output.fps) else null,
            geometry,
            camera?.takeIf { planned.zoomed }?.let { CameraTransformation(it) },
            transition,
        )

        val builder = EditedMediaItem.Builder(mediaItem)
            .setRemoveAudio(planned.removeAudio)
            // A MAXIMUM, not a target: 60 fps sources and speed-ups are decimated to this. Media3
            // turns it into one frame interval in the asset loader's video renderer and drops any
            // decoded frame that arrives inside it, and the speed change has already been applied
            // to the sample timestamps by then, so a 4x clip is capped here like any other source.
            // That renderer is AHEAD of every effect, which is what lets a slowed clip keep it: it
            // still caps a fast source before [SlowMotionEffect] sees a frame, and it can never drop
            // one of the frames that effect makes. Nothing in Media3 itself raises a rate - see the
            // compositor note in toComposition for what that leaves to this engine.
            .setFrameRate(output.fps)
            .setEffects(Effects(audioProcessors, videoEffects))

        if (clip.image) {
            // A picture's length to the microsecond, which is the resolution the plan and the gates
            // count in - see [pictureItem] for why the item's own millisecond one is not enough. For
            // an image the frame rate above is not a ceiling but the rate the still is emitted at.
            builder.setDurationUs(pictureDurationUs(planned))
        } else if (clip.speed != 1f) {
            // Transformer retimes the video in the SOURCE - `ExoPlayerAssetLoader` wraps the item's
            // media source in a `SpeedChangingMediaSource`, so the samples are stamped post-speed
            // before they are even decoded - and inserts the speed change as the first audio
            // processor of the item. So our gain runs on post-speed audio, and every video effect,
            // the decimator ahead of them included, sees post-speed timestamps. Passing a
            // SpeedChangeEffect alongside this throws, so none is.
            builder.setSpeed(SpeedParameters(ConstantSpeedProvider(clip.speed), MAINTAIN_PITCH))
        }
        return builder.build()
    }

    /**
     * A picture as a Media3 image item: no clipping, no speed, one frame held for its length.
     *
     * Media3 takes an item for an image when its MIME type is one - read off the item, or guessed
     * from the content resolver or the file's extension - AND it has an image duration. The type is
     * set from the probe, which read it off the picture's own bytes, so a render input copied with no
     * extension is still a picture. The duration here is whole milliseconds because that is all
     * `setImageDurationMs` takes; it only has to be set for Media3 to treat the item as an image,
     * and [editedClip] then overrides it with the exact length in microseconds. The plan's cuts - a
     * layer cut to the room left, a transition tail's lead - land on any microsecond, and an item a
     * fraction of a millisecond short of its placement lets the gap behind it through, which is an
     * opaque black frame the alpha gate still calls visible.
     *
     * The frame comes out upright: Media3's bitmap loader applies the EXIF rotation, and caps the
     * decode at the largest texture it can upload.
     */
    private fun pictureItem(planned: RenderPlan.PlannedClip): MediaItem {
        val builder = MediaItem.Builder()
            .setUri(Uri.parse(planned.clip.uri))
            .setImageDurationMs(max(1L, (pictureDurationUs(planned) + 999L) / 1000L))
        planned.imageMimeType?.let { builder.setMimeType(it) }
        return builder.build()
    }

    /** How long a picture item runs: its whole trim, which the parser has already put at 1x. */
    private fun pictureDurationUs(planned: RenderPlan.PlannedClip): Long =
        max(1L, planned.outUs - planned.inUs)

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
     * One sequence's Presentations, one per frame size and fit, handed out again to every clip on
     * that sequence that asks for the same one.
     *
     * Media3 keeps a sequence's effect chain from one item to the next only when the next item's
     * effect list EQUALS the one running (`DefaultVideoFrameProcessor.configure`), and effects
     * compare by identity. A fresh Presentation per clip therefore tore the whole chain down at
     * every cut - every shader program released, recompiled and its textures reallocated - and on a
     * post that is one sequence, where the composition's effects ride on each item's list, that
     * included every overlay, whose texture `BitmapOverlay.release` deletes and the next frame
     * uploads again. The same instance on consecutive plain clips makes their lists equal, and the
     * chain simply carries on. A clip whose list differs anyway - reframed, sped, on either side of
     * a transition - still rebuilds exactly as it always did.
     *
     * The picture cannot tell: `Presentation.configure` works everything out afresh from the input
     * size it is handed and keeps nothing from the call before, and Media3 calls it again whenever
     * the size of the frames arriving changes (`BaseGlShaderProgram.queueInputFrame`,
     * `FinalShaderProgramWrapper.ensureConfigured`). The items of a sequence go through its one
     * frame processor one after another, so a shared instance is never configured for two clips at
     * once.
     *
     * PER SEQUENCE, never shared between them: under a compositor every sequence has its own frame
     * processor, running at the same time as the others, and one Presentation configured by two of
     * them would hand each the other's matrix. Nor is it ever used for the composition's own
     * Presentation - see [toComposition].
     */
    private class Geometries {
        private val presentations = HashMap<Triple<Int, Int, Int>, Presentation>()

        fun presentation(width: Int, height: Int, layout: Int): Presentation =
            presentations.getOrPut(Triple(width, height, layout)) {
                Presentation.createForWidthAndHeight(width, height, layout)
            }
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
     * The TURN comes after all of that and is the only part that is not a window: the window and
     * the fit are measured in the upright rectangle, and what turns is the finished result. It is
     * applied here, on the base track, because a base clip's rectangle is a part of the output
     * frame and the frame is what crops its corners. A clip on an extra layer is turned by the
     * compositor instead - see [LayerCompositor] - because its rectangle IS its frame, and a
     * rectangle turned inside itself would cut its own corners off.
     *
     * The matrix is rebuilt in [configure] because the window depends on the source's pixel size,
     * and [configure] is where Media3 finally knows it. It is rebuilt rather than recomputed per
     * frame because nothing in it moves: [getMatrix] hands back the same instance every frame, as
     * Media3's own `Crop` does, and Media3 copies it into a float array before drawing.
     */
    private class Reframe(
        private val clip: Clip,
        private val frame: Output,
        /** Counter-clockwise, as GL counts, and 0 for a clip that stands as it was drawn. */
        private val rotationGlDeg: Float,
    ) : MatrixTransformation {

        private val matrix = Matrix()

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            val window = RenderPlan.sourceWindow(clip, frame, inputWidth, inputHeight)
            val centreX = RenderPlan.centreNdcX(window)
            val centreY = RenderPlan.centreNdcY(window)
            matrix.reset()
            // Put the window's centre on the origin, then open it out until its sides are the
            // frame's: an NDC side of 2 spans a window side of w, so the scale is 1 / w.
            matrix.postTranslate(-centreX, -centreY)
            matrix.postScale(1f / window.w, 1f / window.h)
            // A SECOND step rather than something folded into the two lines above, so that a clip
            // which is not turned - every clip of every spec written before the angle existed -
            // leaves with exactly the transform it has always had. The angle can only have come off
            // a rectangle, so there is always one to turn about when there is an angle at all.
            val placement = clip.rect
            if (rotationGlDeg != 0f && placement != null) {
                turn(placement)
            }
            // The window has the frame's aspect ratio by construction, so declaring the frame's
            // size here scales the picture without stretching it.
            return Size(frame.width, frame.height)
        }

        /**
         * The picture as it stands, turned about the rectangle's own centre in OUTPUT PIXELS.
         *
         * Pixels, not the normalised fractions the rectangle is stored in: NDC is not square - x
         * spans the frame's width and y its height - so an angle applied to it straight would shear
         * a square window into a rhombus on a 720x1280 post, where the preview, which turns it in
         * CSS pixels, would not. Stretching x by the frame's aspect ratio first makes the units
         * square, and that IS turning it in pixels.
         *
         * Nothing clamps the result. A turned rectangle legitimately hangs its corners outside the
         * frame, and GL discards whatever the matrix pushes past the frame's edges, which is the
         * same crop the customer sees in the preview.
         */
        private fun turn(placement: Placement) {
            val pivotX = RenderPlan.centreNdcX(placement.bounds)
            val pivotY = RenderPlan.centreNdcY(placement.bounds)
            val aspect = frame.width.toFloat() / frame.height.toFloat()
            matrix.postTranslate(-pivotX, -pivotY)
            matrix.postScale(aspect, 1f)
            // Android's `Matrix` turns counter-clockwise in a y-UP frame, which is the frame these
            // vertices are in, so the plan's already-negated degrees go in as they are.
            matrix.postRotate(rotationGlDeg)
            matrix.postScale(1f / aspect, 1f)
            matrix.postTranslate(pivotX, pivotY)
        }

        override fun getMatrix(presentationTimeUs: Long): Matrix = matrix
    }

    /**
     * The zoom camera as one more vertex-shader matrix over a whole-frame picture - a base clip or a
     * transition tail - read at the frame's own presentation time.
     *
     * That time IS the output timeline's: in Media3 1.11.1 each item of a sequence is stamped from
     * the sum of the post-speed lengths of the items ahead of it, so nothing here converts a clip's
     * local time. [CameraTrack.atUs] is the same reading of the keys `cameraAt` does in the
     * preview; null is the whole frame and hands back the identity.
     *
     * The matrix is `k (p - f)` in NDC - the contract's `p' = 0.5 + (p - c) * scale` - so a
     * point of the finished frame is scaled about the focus onto the frame's centre. GL clips what
     * the geometry pushed off the frame BEFORE this matrix, and this one pushes the rest of the frame
     * outside the view, which is exactly a camera over the frame: the parser holds every view inside
     * it, so nothing past an edge can come back in.
     *
     * One `Matrix` per instance, reused every frame as [Reframe] reuses its own: Media3 copies it
     * into a float array before drawing, on the one GL thread that asks.
     */
    private class CameraTransformation(private val camera: CameraTrack) : MatrixTransformation {

        private val matrix = Matrix()

        override fun getMatrix(presentationTimeUs: Long): Matrix {
            val view = camera.atUs(presentationTimeUs)
            if (view == null) matrix.reset() else matrix.setValues(view.ndcMatrix())
            return matrix
        }
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
     * A turned layer is turned HERE rather than in its own texture, because its rectangle is its
     * texture's frame: turning it inside that frame would cut its corners off, and the corners of a
     * turned rectangle are exactly what has to survive. Turned here, the only thing that crops them
     * is the output frame.
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
        /** The plan's tails, in timeline order; empty when the post has no transition. */
        private val tails: List<RenderPlan.PlannedTail>,
        /**
         * The zoom camera, for the layers only: the base and the tails are whole-frame pictures that
         * took the camera in their own effect chains, and come through here unmoved.
         */
        camera: CameraTrack? = null,
    ) : VideoCompositorSettings {

        private val size = Size(output.width, output.height)
        private val layers: List<Layer> = tracks.map { Layer(it, camera) }

        /**
         * The tails' input: registered straight after the base, which is registered straight after
         * the layers. [C.INDEX_UNSET] when there are no tails, which no input id ever equals.
         */
        private val tailsInputId = if (tails.isEmpty()) C.INDEX_UNSET else layers.size + 1

        // Declared rather than derived from the inputs: every layer has been drawn against this
        // frame already, and the composition's own Presentation would only have to undo a
        // compositor that had chosen anything else.
        override fun getOutputSize(inputSizes: List<Size>): Size = size

        override fun getOverlaySettings(inputId: Int, presentationTimeUs: Long): OverlaySettings {
            // The input id is the sequence's index in the composition, and the extra layers were
            // registered first, top one first. Then comes the base sequence, composited exactly as
            // it arrives, and then the tails.
            if (inputId == tailsInputId) return tailAt(presentationTimeUs)
            val layer = layers.getOrNull(inputId) ?: return BASE
            return layer.settingsAt(presentationTimeUs)
        }

        /**
         * A tail's frame is drawn whole and where it is - it is already the output's size and its
         * look already moved it - and only while a tail item is playing, lead included. Anywhere
         * else the input is a gap, and the frame is hidden. The timestamp is the tail frame's OWN,
         * which is the same number the tail's effect computed its progress from.
         */
        private fun tailAt(timeUs: Long): OverlaySettings =
            if (RenderPlan.tailAt(tails, timeUs) == null) TAIL_HIDDEN else TAIL

        /**
         * One layer's settings, worked out once. Media3 asks for these on every frame of every
         * input, so nothing here allocates: the only thing that changes over a layer's life is
         * which of its clips is on screen, and there are a handful of those.
         */
        private class Layer(
            private val track: RenderPlan.PlannedTrack,
            private val camera: CameraTrack?,
        ) {

            private val hidden: OverlaySettings =
                StaticOverlaySettings.Builder().setAlphaScale(0f).build()
            private val placed: List<OverlaySettings> = track.placements.map {
                val builder = StaticOverlaySettings.Builder()
                // Only a supersampled clip is scaled, back down to its rectangle's size; every other
                // layer is built exactly as it was before zooms existed.
                if (it.drawScaleX != 1f || it.drawScaleY != 1f) builder.setScale(it.drawScaleX, it.drawScaleY)
                builder
                    .setBackgroundFrameAnchor(it.anchorX, it.anchorY)
                    // The turn, in the one place that can make it: the layer's picture is already
                    // drawn at its rectangle's size, and this is where that rectangle is put on the
                    // output frame. `OverlayMatrixProvider` sandwiches the rotation between the
                    // layer's own aspect matrix and that matrix's inverse, so the turn happens in
                    // the layer's PIXEL space about its centre, and the aspect matrix that follows
                    // maps a layer pixel onto exactly one output pixel - which is the contract's
                    // "about the rectangle's centre, in output pixels", said in Media3's own terms.
                    // The degrees are counter-clockwise here for the same reason they are on a
                    // sticker: `Matrix.rotateM` about +z turns counter-clockwise in a y-up frame.
                    .setRotationDegrees(it.rotationGlDeg)
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
                if (i == RenderPlan.PlannedTrack.HIDDEN) return hidden
                val placement = track.placements[i]
                if (camera == null || !placement.zoomed) return placed[i]
                val view = camera.atUs(timeUs) ?: return placed[i]
                // A NEW object for every zoomed frame, and that is not waste: Media3 asks at QUEUE
                // time and keeps the answer with the frame, so one shared object moved to a later
                // frame's camera would draw an earlier frame there. Under the camera the layer's
                // centre goes where the camera sends it and the layer grows by `k`, about its own
                // centre - the scale comes first in the compositor's matrix - which with the turn
                // left alone is the camera over the placed layer exactly.
                return StaticOverlaySettings.Builder()
                    .setBackgroundFrameAnchor(
                        view.viewNdcX(placement.anchorX.toDouble()).toFloat(),
                        view.viewNdcY(placement.anchorY.toDouble()).toFloat(),
                    )
                    .setScale(
                        (view.scale * placement.drawScaleX).toFloat(),
                        (view.scale * placement.drawScaleY).toFloat(),
                    )
                    .setRotationDegrees(placement.rotationGlDeg)
                    .setAlphaScale(track.opacity)
                    .build()
            }
        }

        private companion object {
            /** The base track, composited as it arrives: centred, unscaled and opaque. */
            val BASE: OverlaySettings = StaticOverlaySettings.Builder().build()

            /** A tail inside its window: full frame, centred and opaque, exactly like the base. */
            val TAIL: OverlaySettings = StaticOverlaySettings.Builder().build()

            /** The tails' input between windows, where all it carries is a gap. */
            val TAIL_HIDDEN: OverlaySettings = StaticOverlaySettings.Builder().setAlphaScale(0f).build()
        }
    }

    private class ConstantSpeedProvider(private val speed: Float) : SpeedProvider {
        override fun getSpeed(timeUs: Long): Float = speed
        override fun getNextSpeedChangeTimeUs(timeUs: Long): Long = C.TIME_UNSET
    }
}
