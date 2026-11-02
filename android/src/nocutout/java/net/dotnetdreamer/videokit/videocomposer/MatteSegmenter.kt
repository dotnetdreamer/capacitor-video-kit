package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import com.google.common.util.concurrent.ListenableFuture

/**
 * `findMatte`'s `subject` engine left out: the build a host makes with `videokitCutout = false`, which
 * keeps Play services' subject segmentation out of the app (see `build.gradle`). [MatteFinder] asks
 * [AVAILABLE] first and takes the selfie segmenter for every matte, keeping people.
 */
internal class MatteSegmenter : AutoCloseable {

    companion object {
        /** Whether this build has the engine at all. */
        const val AVAILABLE = false

        fun prepare(@Suppress("UNUSED_PARAMETER") ctx: Context) = Unit

        @Suppress("RedundantSuspendModifier")
        suspend fun ready(@Suppress("UNUSED_PARAMETER") ctx: Context, @Suppress("UNUSED_PARAMETER") onProgress: (Double) -> Unit): Boolean = false
    }

    /** Never asked: [MatteFinder] checks [AVAILABLE] first. */
    fun segment(@Suppress("UNUSED_PARAMETER") bitmap: Bitmap): ListenableFuture<ConfidenceMask> =
        throw UnsupportedOperationException("this build leaves subject segmentation out")

    override fun close() = Unit
}
