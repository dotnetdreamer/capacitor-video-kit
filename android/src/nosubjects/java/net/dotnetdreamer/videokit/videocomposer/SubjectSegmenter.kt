package net.dotnetdreamer.videokit.videocomposer

import android.graphics.Bitmap
import com.google.common.util.concurrent.ListenableFuture

/**
 * `findSubjects` with no engine: the build a host makes with `videokitSubjects = false`, which leaves
 * ML Kit's selfie segmentation and its model out of the app (see `build.gradle`). [SubjectFinder] asks
 * [AVAILABLE] before it reads anything and refuses the call as `unsupported`, as a browser without
 * MediaPipe does, so the editor offers no focus and every clip renders as it always did.
 */
internal class SubjectSegmenter(@Suppress("UNUSED_PARAMETER") stream: Boolean) : AutoCloseable {

    companion object {
        /** Whether this build has an engine at all. */
        const val AVAILABLE = false
    }

    /** Never asked: [SubjectFinder] refuses on [AVAILABLE] first. */
    fun segment(@Suppress("UNUSED_PARAMETER") bitmap: Bitmap): ListenableFuture<ConfidenceMask> =
        throw UnsupportedOperationException("this build leaves subject segmentation out")

    override fun close() = Unit
}
