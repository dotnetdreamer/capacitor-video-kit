package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabel
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions

/**
 * `labelMedia`'s engine: ML Kit image labeling, with its base model bundled into the app.
 *
 * One of three files of this name, and the build compiles one: this one by default,
 * `src/labelingplay`'s when the host sets `videokitImageLabeling = 'playServices'`, and
 * `src/nolabeling`'s when it sets `false`, which leaves ML Kit out of the app altogether (see
 * `build.gradle`). Everything ML Kit is here, so the rest of [MediaLabels] compiles either way.
 */
internal class SceneLabeler(minConfidence: Float) : AutoCloseable {

    companion object {
        /** Whether this build has an engine at all. */
        const val AVAILABLE = true

        /** Nothing to fetch: the model is in the app. */
        fun prepare(ctx: Context) = Unit

        /** Always ready: the model is in the app. */
        fun notReadyReason(ctx: Context): String? = null
    }

    private val labeler = ImageLabeling.getClient(
        ImageLabelerOptions.Builder().setConfidenceThreshold(minConfidence).build(),
    )

    /**
     * ML Kit's labels for one picture, strongest first, none below `minConfidence`, `rotation` being
     * the quarter turns ML Kit applies before it looks. Waited for here, on the plugin's IO thread,
     * which is what `Tasks.await` asks for: never the main one.
     */
    fun classify(bitmap: Bitmap, rotation: Int, minConfidence: Float): List<MediaLabels.Label> =
        Tasks.await(labeler.process(InputImage.fromBitmap(bitmap, rotation)))
            .filter { it.confidence >= minConfidence }
            .sortedWith(compareByDescending<ImageLabel> { it.confidence }.thenBy { it.text })
            .map { MediaLabels.Label(it.text, it.confidence) }

    override fun close() = labeler.close()
}
