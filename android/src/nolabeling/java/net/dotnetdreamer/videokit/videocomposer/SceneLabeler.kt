package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap

/**
 * `labelMedia` with no engine: the build a host makes with `videokitImageLabeling = false`, which
 * leaves ML Kit and its model and native library out of the app (see `build.gradle`). [MediaLabels]
 * asks [AVAILABLE] before it reads anything and refuses the call as `unsupported`, as a browser does,
 * so `describeMedia` answers null and a host carries on without scenes.
 */
internal class SceneLabeler(@Suppress("UNUSED_PARAMETER") minConfidence: Float) : AutoCloseable {

    companion object {
        /** Whether this build has an engine at all. */
        const val AVAILABLE = false

        /** Nothing to fetch: there is no engine. */
        fun prepare(ctx: Context) = Unit

        /** Never asked: [MediaLabels] refuses on [AVAILABLE] first. */
        fun notReadyReason(ctx: Context): String? = null
    }

    fun classify(bitmap: Bitmap, rotation: Int, minConfidence: Float): List<MediaLabels.Label> =
        throw UnsupportedOperationException("this build leaves image labeling out")

    override fun close() = Unit
}
