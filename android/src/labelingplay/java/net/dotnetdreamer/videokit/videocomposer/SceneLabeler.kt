package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.tasks.Tasks
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.label.ImageLabel
import com.google.mlkit.vision.label.ImageLabeling
import com.google.mlkit.vision.label.defaults.ImageLabelerOptions

/**
 * `labelMedia`'s engine: ML Kit image labeling from Google Play services, which keeps the model and
 * its native library out of the app (about 200 KB in it instead of 14 MB installed) and downloads
 * them itself. The build compiles this file when the host sets `videokitImageLabeling = 'playServices'`
 * (see `build.gradle`); the labeling is `src/labeling`'s, line for line.
 *
 * The price is that the model may not be on the phone yet. [prepare] asks for it when the plugin
 * loads, and [notReadyReason] is asked before any frame is decoded: until the model has arrived, and
 * on a phone without Play services, [MediaLabels] refuses the call as `unsupported`, which
 * `describeMedia` reads as "no scenes here", as it does in a browser.
 */
internal class SceneLabeler(minConfidence: Float) : AutoCloseable {

    companion object {
        private const val TAG = "VideoComposer"

        /** Whether this build has an engine at all. */
        const val AVAILABLE = true

        /**
         * Asks Play services for the model now, so it has usually arrived before anything is labeled.
         * Nothing waits on it, and nothing here may fail the plugin's load: already installed, a
         * download started, or no Play services to ask all end in the log, and [notReadyReason] says
         * which at the call.
         */
        fun prepare(ctx: Context) {
            try {
                val labeler = ImageLabeling.getClient(ImageLabelerOptions.DEFAULT_OPTIONS)
                ModuleInstall.getClient(ctx)
                    .installModules(ModuleInstallRequest.newBuilder().addApi(labeler).build())
                    .addOnSuccessListener {
                        if (!it.areModulesAlreadyInstalled()) Log.i(TAG, "image labeling model requested from Play services")
                    }
                    .addOnFailureListener { Log.w(TAG, "Play services will not fetch the image labeling model: ${it.message}") }
                    .addOnCompleteListener { labeler.close() }
            } catch (e: Exception) {
                Log.w(TAG, "could not ask Play services for the image labeling model", e)
            }
        }

        /**
         * Why the model cannot answer yet, or null when it can. Waits on Play services, so it is asked
         * on the plugin's IO thread, as [classify] is. A model still missing is asked for again, in
         * case the request at load went nowhere (no network then, say).
         */
        fun notReadyReason(ctx: Context): String? {
            val labeler = ImageLabeling.getClient(ImageLabelerOptions.DEFAULT_OPTIONS)
            return try {
                if (Tasks.await(ModuleInstall.getClient(ctx).areModulesAvailable(labeler)).areModulesAvailable()) {
                    null
                } else {
                    prepare(ctx)
                    "the image labeling model is still downloading through Google Play services"
                }
            } catch (e: Exception) {
                "image labeling runs in Google Play services, which did not answer: ${(e.cause ?: e).message}"
            } finally {
                labeler.close()
            }
        }
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
