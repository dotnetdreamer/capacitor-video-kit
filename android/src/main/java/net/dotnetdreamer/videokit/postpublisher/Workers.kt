package net.dotnetdreamer.videokit.postpublisher

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
 * Two workers chained rather than one doing both, so that a failure creating the post retries only
 * the create call and not the uploads that already succeeded - and so that "upload everything, then
 * post" is WorkManager's own sequencing rather than a loop of ours that a process death could
 * unwind.
 *
 * WorkManager starts itself through `androidx.startup`, and its scheduled job can restart the
 * process to resume a worker even if the customer never reopens the app. That is the property
 * this whole plugin exists for.
 */
object Workers {

    const val KEY_PENDING_POST_ID = "pendingPostId"
    const val TAG = "videokit-post-publisher"

    /** Attempts per worker, counted by WorkManager across process deaths as well as failures. */
    const val MAX_ATTEMPTS = 3

    fun uniqueName(pendingPostId: String) = "post-$pendingPostId"

    fun enqueue(context: Context, pendingPostId: String, policy: ExistingWorkPolicy) {
        WorkManager.getInstance(context)
            .beginUniqueWork(
                uniqueName(pendingPostId),
                policy,
                request<UploadWorker>(pendingPostId),
            )
            .then(request<CreatePostWorker>(pendingPostId))
            .enqueue()
    }

    fun cancel(context: Context, pendingPostId: String) {
        WorkManager.getInstance(context).cancelUniqueWork(uniqueName(pendingPostId))
    }

    private inline fun <reified W : androidx.work.ListenableWorker> request(
        pendingPostId: String,
    ): OneTimeWorkRequest = OneTimeWorkRequestBuilder<W>()
        .setConstraints(
            Constraints.Builder()
                .setRequiredNetworkType(NetworkType.CONNECTED)
                .build(),
        )
        // 30 s, 60 s, 120 s. Long enough to ride out a tunnel, short enough that a customer
        // watching the pill sees it move again.
        .setBackoffCriteria(BackoffPolicy.EXPONENTIAL, 30, TimeUnit.SECONDS)
        .setInputData(workDataOf(KEY_PENDING_POST_ID to pendingPostId))
        .addTag(TAG)
        .build()
}
