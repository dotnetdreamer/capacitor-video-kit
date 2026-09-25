package net.dotnetdreamer.videokit.videocomposer

import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.RgbMatrix
import java.util.concurrent.atomic.AtomicLong

/**
 * The render's progress meter, as an identity colour matrix that Media3 asks about every frame.
 *
 * `Transformer.getProgress` averages the progress of every sequence in the composition, so as soon
 * as there is music or a voiceover the number stops being invertible - a two-second voiceover that
 * finished at the start keeps reporting 99 % and drags the average up while the video is barely
 * started. The frames that reach the composition's effects carry the continuous OUTPUT-timeline
 * timestamp, which is exactly the quantity we want, so the newest one is published into [tap] and
 * the plugin divides it by the plan's total duration.
 *
 * It is an [RgbMatrix] rather than a shader program of its own because that is the one kind of
 * effect Media3 folds into a neighbour instead of running as a pass: `DefaultVideoFrameProcessor`
 * gathers every run of matrix transformations and RGB matrices into a single `DefaultShaderProgram`
 * - or into the final program that draws to the encoder, when nothing but matrices follows - and a
 * plain `GlEffect` ends that run and costs a full-frame pass of its own. As a separate identity pass
 * this used to cost one output-size draw and texture per frame - two on a post with no overlays,
 * where it also kept the geometry out of the final program and so left that program one more plain
 * copy to make. Folded in, those passes are gone. The picture cannot change for it: the matrix is
 * the identity, which multiplies every channel by exactly 1 and adds exactly 0, and the separate
 * pass it replaces multiplied by the same identity.
 *
 * `DefaultShaderProgram.drawFrame` reads every RGB matrix FIRST, before it decides whether there is
 * anything to draw, so [getMatrix] is still called once for every output frame with that frame's
 * output-timeline timestamp - which is the whole of what the plugin needs.
 */
@OptIn(UnstableApi::class)
class ProgressTap(private val tap: AtomicLong) : RgbMatrix {

    override fun getMatrix(presentationTimeUs: Long, useHdr: Boolean): FloatArray {
        tap.set(presentationTimeUs)
        return IDENTITY
    }

    /**
     * Never a no-op - dropping it would drop the timestamps with it. It is what `GlEffect` says by
     * default, spelled out because the answer is what keeps a plain trim from being transmuxed past
     * the meter.
     */
    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    private companion object {
        /**
         * Column-major 4x4 identity, written out rather than built with `android.opengl.Matrix` so
         * the JVM tests see the real numbers. Media3 only ever READS what [getMatrix] hands back -
         * it copies it into its own cache and multiplies it into its own array - so one shared
         * instance serves every frame.
         */
        val IDENTITY = floatArrayOf(
            1f, 0f, 0f, 0f,
            0f, 1f, 0f, 0f,
            0f, 0f, 1f, 0f,
            0f, 0f, 0f, 1f,
        )
    }
}
