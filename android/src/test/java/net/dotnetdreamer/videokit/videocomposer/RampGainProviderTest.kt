package net.dotnetdreamer.videokit.videocomposer

import androidx.media3.common.C
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The contract `GainProcessor` holds a gain provider to, checked at every sample.
 *
 * Whenever `getGainFactorAtSamplePosition` says exactly 1f, `GainProcessor` asks `isUnityUntil` for
 * the end of the unity run and throws on `C.TIME_UNSET` - an export that dies in the audio graph
 * with "Expected a valid end boundary for unity region". Every transition on a clip at full volume
 * crossfades its sound, and the old provider broke the contract on the first sample of each
 * fade-out, so every such export failed on a phone while every JVM test here passed: nothing ran the
 * processor. This walks the curve the way the processor does.
 */
class RampGainProviderTest {

    private val rate = 48_000

    /** Every sample of [seconds] of audio: a unity sample has a real run, and the run is all unity. */
    private fun assertKeepsTheContract(provider: RampGainProvider, seconds: Double = 2.0) {
        val samples = (seconds * rate).toLong()
        var p = 0L
        while (p < samples) {
            val gain = provider.getGainFactorAtSamplePosition(p, rate)
            val end = provider.isUnityUntil(p, rate)
            if (gain == 1f) {
                assertNotEquals("unity at sample $p must say where it ends", C.TIME_UNSET, end)
                if (end != C.TIME_END_OF_SOURCE) {
                    assertTrue("the run from $p must move forward, not to $end", end > p)
                    for (q in p until minOf(end, samples)) {
                        assertEquals("sample $q is inside the run from $p", 1f, provider.getGainFactorAtSamplePosition(q, rate))
                    }
                    p = end
                    continue
                }
                for (q in p until samples) assertEquals(1f, provider.getGainFactorAtSamplePosition(q, rate))
                return
            } else {
                assertEquals("sample $p is not unity, so there is no run", C.TIME_UNSET, end)
            }
            p++
        }
    }

    @Test
    fun `a transition's incoming clip at full volume, fading in`() {
        assertKeepsTheContract(RampGainProvider(level = 1f, fadeInUs = 500_000L))
    }

    @Test
    fun `a transition's tail at full volume, fading out from its first sample`() {
        assertKeepsTheContract(RampGainProvider(level = 1f, fadeOutStartUs = 0L, fadeOutUs = 500_000L))
    }

    @Test
    fun `a clip with a transition at both ends`() {
        assertKeepsTheContract(RampGainProvider(level = 1f, fadeInUs = 300_000L, fadeOutStartUs = 1_200_000L, fadeOutUs = 300_000L))
    }

    @Test
    fun `a tail held silent through its lead, then fading out`() {
        assertKeepsTheContract(
            RampGainProvider(level = 1f, fadeOutStartUs = 100_000L, fadeOutUs = 400_000L, silentUntilUs = 100_000L),
        )
    }

    @Test
    fun `fade lengths that fall between samples`() {
        assertKeepsTheContract(RampGainProvider(level = 1f, fadeInUs = 333_333L, fadeOutStartUs = 777_777L, fadeOutUs = 222_223L))
    }

    @Test
    fun `below full volume nothing is ever unity`() {
        assertKeepsTheContract(RampGainProvider(level = 0.6f, fadeInUs = 500_000L, fadeOutStartUs = 1_000_000L, fadeOutUs = 500_000L))
    }

    @Test
    fun `no fades at all is one unity run to the end`() {
        assertEquals(C.TIME_END_OF_SOURCE, RampGainProvider(level = 1f).isUnityUntil(0L, rate))
    }
}
