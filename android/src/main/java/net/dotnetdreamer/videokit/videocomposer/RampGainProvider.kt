package net.dotnetdreamer.videokit.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.audio.GainProcessor
import androidx.media3.common.util.UnstableApi
import kotlin.math.min

/**
 * Volume, with optional fades, as a gain curve.
 *
 * Media3 ships `DefaultGainProvider`, whose `addFadeAt` REPLACES the default gain inside the fade
 * window rather than multiplying by it - so a track set to 60 % with a fade-in would ramp all the
 * way to 100 % and then drop back to 60 % when the fade ended. That is audible and wrong, so this
 * provider multiplies the level by the ramps instead.
 *
 * Positions are relative to the start of the item being processed: Media3 hands each exported item
 * its own sample positions starting at zero. A fade that belongs to more than one item - music, whose
 * fades are the whole window it is heard in and run across the seams between its repetitions - is
 * given to each item it covers in that item's own terms: [fadeInFromUs] and [fadeOutStartUs] are
 * where the ramp starts relative to THIS item's first sample, and either is negative for a ramp that
 * began in an item before it. The line then carries on across the seam as if the items were one.
 */
@OptIn(UnstableApi::class)
class RampGainProvider(
    /** 0..1. */
    private val level: Float,
    private val fadeInUs: Long = 0L,
    /**
     * Where the fade in starts, relative to the item start: 0 for the item it starts in, negative
     * for a later item it is still running through.
     */
    private val fadeInFromUs: Long = 0L,
    /**
     * Relative to the item start, and negative for a fade that started in an item before this one;
     * [C.TIME_UNSET] when there is no fade-out.
     */
    private val fadeOutStartUs: Long = C.TIME_UNSET,
    private val fadeOutUs: Long = 0L,
    /**
     * Silence before this point, relative to the item start. For a transition's tail, whose first
     * moments are laid under the base only so the compositor has a real frame to pair with the
     * window's first one: the base is playing that same stretch of sound already, and the tail
     * would double it. 0 - every other item - is no silence at all.
     */
    private val silentUntilUs: Long = 0L,
) : GainProcessor.GainProvider {

    override fun getGainFactorAtSamplePosition(samplePosition: Long, sampleRate: Int): Float {
        val tUs = toUs(samplePosition, sampleRate)
        if (tUs < silentUntilUs) return 0f
        var gain = level
        if (fadeInUs > 0L && tUs - fadeInFromUs < fadeInUs) {
            gain *= (tUs - fadeInFromUs).toFloat() / fadeInUs.toFloat()
        }
        if (fadeOutStartUs != C.TIME_UNSET && fadeOutUs > 0L && tUs >= fadeOutStartUs) {
            gain *= 1f - min(1f, (tUs - fadeOutStartUs).toFloat() / fadeOutUs.toFloat())
        }
        return gain.coerceIn(0f, 1f)
    }

    /**
     * How long the gain stays at exactly 1 from [samplePosition]. `GainProcessor` uses this to skip
     * the per-sample multiply entirely, so a full-volume track with no fades costs nothing at all.
     *
     * It must agree with [getGainFactorAtSamplePosition] sample for sample: whenever that returns
     * exactly 1f, `GainProcessor` asks for the end of the unity run and THROWS ("Expected a valid end
     * boundary for unity region") on [C.TIME_UNSET]. Deciding it from the regions alone got two cases
     * wrong at full volume - the first sample of a fade-out, where the ramp has not moved yet, and the
     * last samples of a fade-in, where the float ratio rounds up to exactly 1 - and a transition's
     * crossfade on a clip at full volume hits the first of them on every export. So the gain itself
     * is asked first, and a unity sample inside a ramp is reported as a run of one sample, which is
     * all that can be promised there.
     */
    override fun isUnityUntil(samplePosition: Long, sampleRate: Int): Long {
        if (getGainFactorAtSamplePosition(samplePosition, sampleRate) != 1f) return C.TIME_UNSET
        val tUs = toUs(samplePosition, sampleRate)
        if (fadeInUs > 0L && tUs - fadeInFromUs < fadeInUs) return samplePosition + 1
        if (fadeOutStartUs == C.TIME_UNSET || fadeOutUs <= 0L) return C.TIME_END_OF_SOURCE
        if (tUs >= fadeOutStartUs) return samplePosition + 1
        // Flat up to the first sample at or after the fade-out's start, back in sample positions.
        val rate = sampleRate.toLong()
        val firstRamped = (fadeOutStartUs * rate + 999_999L) / 1_000_000L
        return maxOf(firstRamped, samplePosition + 1)
    }

    private fun toUs(samplePosition: Long, sampleRate: Int): Long =
        if (sampleRate <= 0) 0L else samplePosition * 1_000_000L / sampleRate

    /** True when this provider would leave every sample untouched. */
    fun isNoOp(): Boolean =
        level == 1f && fadeInUs <= 0L && silentUntilUs <= 0L &&
            (fadeOutStartUs == C.TIME_UNSET || fadeOutUs <= 0L)
}
