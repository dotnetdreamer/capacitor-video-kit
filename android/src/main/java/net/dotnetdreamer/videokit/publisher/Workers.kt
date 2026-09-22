package net.dotnetdreamer.videokit.publisher

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequest
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

/**
 * How the two steps are handed to WorkManager.
 *
 * Two workers chained rather than one doing both, so that a failure in the finalize call retries
 * only that call and not the uploads that already succeeded - and so that "upload everything, then
 * finalize" is WorkManager's own sequencing rather than a loop of ours that a process death could
 * unwind.
 *
 * WorkManager starts itself through `androidx.startup`, and its scheduled job can restart the
 * process to resume a worker even if the customer never reopens the app. That is the property
 * this whole plugin exists for.
 */
object Workers {

    const val KEY_BATCH_ID = "batchId"
    const val TAG = "videokit-background-publisher"

    /** Attempts per worker, counted by WorkManager across process deaths as well as failures. */
    const val MAX_ATTEMPTS = 3

    fun uniqueName(batchId: String) = "publish-$batchId"

    fun enqueue(context: Context, batchId: String, policy: ExistingWorkPolicy) {
        WorkManager.getInstance(context)
            .beginUniqueWork(
                uniqueName(batchId),
                policy,
                request<UploadWorker>(batchId),
            )
            .then(request<FinalizeWorker>(batchId))
            .enqueue()
    }

    fun cancel(context: Context, batchId: String) {
        WorkManager.getInstance(context).cancelUniqueWork(uniqueName(batchId))
    }

    private inline fun <reified W : androidx.work.ListenableWorker> request(
        batchId: String,
    ): OneTimeWorkRequest = OneTimeWorkRequestBuilder<W>()
        .setConstraints(
            Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build(),
        )
        // 30 s, 60 s, 120 s. Long enough to ride out a tunnel, short enough that a customer
        // watching the pill sees it move again.
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .setInputData(workDataOf(KEY_BATCH_ID to batchId))
        .addTag(TAG)
        .build()
}
