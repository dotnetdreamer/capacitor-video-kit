package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import android.util.Log
import com.google.android.gms.common.moduleinstall.InstallStatusListener
import com.google.android.gms.common.moduleinstall.ModuleInstall
import com.google.android.gms.common.moduleinstall.ModuleInstallRequest
import com.google.android.gms.common.moduleinstall.ModuleInstallStatusUpdate
import com.google.android.gms.tasks.Task
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.subject.SubjectSegmentation
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenter
import com.google.mlkit.vision.segmentation.subject.SubjectSegmenterOptions
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.suspendCancellableCoroutine
import kotlinx.coroutines.withTimeoutOrNull
import java.util.concurrent.Executor
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * `findMatte`'s engine for `subject`: ML Kit's subject segmentation from Google Play services, which
 * finds whatever stands out of a picture - people, pets, things - and answers how sure it is of every
 * pixel. About 200 KB in the app; Play services keeps the model and downloads it, once per phone.
 *
 * One of two files of this name, and the build compiles one: this one by default, and
 * `src/nocutout`'s when the host sets `videokitCutout = false`, which leaves the dependency out (see
 * `build.gradle`). Everything Play services is here, so [MatteFinder] compiles either way.
 *
 * It is made for still pictures - there is no stream mode, as the selfie segmenter has - so a video's
 * frames are each looked at on their own, and [MatteAnalysis] smooths the answers over time itself.
 */
internal class MatteSegmenter : AutoCloseable {

    companion object {
        private const val TAG = "VideoComposer"

        /** Whether this build has the engine at all. */
        const val AVAILABLE = true

        /** How long a search waits for Play services to download the model before it gives up on it. */
        private const val INSTALL_WAIT_MS = 120_000L

        private val DIRECT = Executor { it.run() }

        private fun client(): SubjectSegmenter =
            SubjectSegmentation.getClient(SubjectSegmenterOptions.Builder().enableForegroundConfidenceMask().build())

        /**
         * Asks Play services for the model now, so it has usually arrived before anything is cut out -
         * the labeler's arrangement. Nothing waits on it and nothing here may fail the plugin's load.
         */
        fun prepare(ctx: Context) {
            try {
                val segmenter = client()
                ModuleInstall.getClient(ctx)
                    .installModules(ModuleInstallRequest.newBuilder().addApi(segmenter).build())
                    .addOnSuccessListener { if (!it.areModulesAlreadyInstalled()) Log.i(TAG, "subject segmentation model requested from Play services") }
                    .addOnFailureListener { Log.w(TAG, "Play services will not fetch the subject segmentation model: ${it.message}") }
                    .addOnCompleteListener { segmenter.close() }
            } catch (e: Exception) {
                Log.w(TAG, "could not ask Play services for the subject segmentation model", e)
            }
        }

        /**
         * Waits until the model is on the phone, asking Play services for it where it is not. True once
         * it can answer; false where it cannot - no Play services, a download refused, or one still
         * going after [INSTALL_WAIT_MS] - and the search then takes the selfie segmenter.
         *
         * [onProgress] hears how much of the model has arrived, 0..1, and only while it is arriving: a
         * phone that has it hears nothing, so nobody is told the app is getting ready when it is not.
         *
         * Suspends rather than blocks, so a cancel ends the wait at once: the listener comes off, and
         * the download, which is Play services' own, goes on for the next search.
         */
        suspend fun ready(ctx: Context, onProgress: (Double) -> Unit): Boolean {
            val segmenter = client()
            val modules = ModuleInstall.getClient(ctx)
            var listening: InstallStatusListener? = null
            try {
                if (modules.areModulesAvailable(segmenter).answer().areModulesAvailable()) return true
                onProgress(0.0)
                val installed = CompletableDeferred<Boolean>()
                val listener = InstallStatusListener { update ->
                    update.progressInfo?.let { info ->
                        if (info.totalBytesToDownload > 0) onProgress(info.bytesDownloaded.toDouble() / info.totalBytesToDownload)
                    }
                    when (update.installState) {
                        ModuleInstallStatusUpdate.InstallState.STATE_COMPLETED -> installed.complete(true)
                        ModuleInstallStatusUpdate.InstallState.STATE_FAILED,
                        ModuleInstallStatusUpdate.InstallState.STATE_CANCELED -> installed.complete(false)
                        else -> Unit
                    }
                }
                listening = listener
                val response = modules.installModules(ModuleInstallRequest.newBuilder().addApi(segmenter).setListener(listener, DIRECT).build()).answer()
                if (response.areModulesAlreadyInstalled()) return true
                val arrived = withTimeoutOrNull(INSTALL_WAIT_MS) { installed.await() } ?: false
                if (arrived) onProgress(1.0)
                return arrived
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "subject segmentation is not to be had from Play services: ${(e.cause ?: e).message}")
                return false
            } finally {
                listening?.let { runCatching { modules.unregisterListener(it) } }
                segmenter.close()
            }
        }

        /** A Play services task's answer, waited for without holding a thread. A wait cancelled leaves the task to Play services. */
        private suspend fun <T> Task<T>.answer(): T = suspendCancellableCoroutine { waiting ->
            addOnCompleteListener(DIRECT) { task ->
                val failure = task.exception
                when {
                    failure != null -> waiting.resumeWithException(failure)
                    task.isCanceled -> waiting.resumeWithException(IllegalStateException("Play services cancelled the request"))
                    else -> waiting.resume(task.result)
                }
            }
        }
    }

    private val segmenter: SubjectSegmenter = client()

    /**
     * The foreground confidence of every pixel of [bitmap], which has to be upright. Takes [bitmap] over
     * and recycles it once ML Kit has finished with it. Never throws: a failure is the answer's.
     */
    fun segment(bitmap: Bitmap): ListenableFuture<ConfidenceMask> {
        val answer = SettableFuture.create<ConfidenceMask>()
        val width = bitmap.width
        val height = bitmap.height
        try {
            segmenter.process(InputImage.fromBitmap(bitmap, 0)).addOnCompleteListener(DIRECT) { task ->
                try {
                    val mask = if (task.isSuccessful) task.result.foregroundConfidenceMask else null
                    if (mask != null) {
                        val values = FloatArray(width * height)
                        mask.rewind()
                        mask.get(values)
                        answer.set(ConfidenceMask(width, height, values))
                    } else {
                        answer.setException(task.exception ?: IllegalStateException("the subject segmenter gave no mask"))
                    }
                } catch (e: Exception) {
                    answer.setException(e)
                } finally {
                    bitmap.recycle()
                }
            }
        } catch (e: Exception) {
            bitmap.recycle()
            answer.setException(e)
        }
        return answer
    }

    override fun close() = segmenter.close()
}
