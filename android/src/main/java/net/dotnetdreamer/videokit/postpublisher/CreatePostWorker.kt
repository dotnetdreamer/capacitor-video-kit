package net.dotnetdreamer.choisy.postpublisher

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.dotnetdreamer.choisy.postpublisher.PublisherHttp.await
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException

/**
 * The second half: fill the caller's body template with the ids the uploads produced, and create
 * the post.
 *
 * Runs as its own worker so that a failure here retries only this call. The uploads are the
 * expensive part and they are already done by the time this starts; re-sending a hundred megabytes
 * because a create call got a 503 would be indefensible.
 */
class CreatePostWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val pendingPostId: String = inputData.getString(Workers.KEY_PENDING_POST_ID).orEmpty()
    private val store = PublishRequestStore(context)

    override suspend fun getForegroundInfo(): ForegroundInfo =
        PostingNotification.foregroundInfo(applicationContext, percent = 97, done = 0, total = 0)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (pendingPostId.isEmpty()) return@withContext Result.failure()
        val entry = store.load(pendingPostId) ?: return@withContext Result.failure()
        if (entry.state.phase == Phase.CANCELLED) return@withContext Result.failure()
        // Idempotent: if the post already exists, a rerun must not create a second one.
        if (entry.state.postId != null) return@withContext Result.success()

        goForeground()

        entry.state.phase = Phase.CREATING
        entry.state.percent = CREATING_PERCENT
        store.save(entry)
        PostingNotification.update(applicationContext, CREATING_PERCENT, entry.state.uploads.size, entry.state.uploads.size)
        PublisherEvents.progress(pendingPostId, "creating", CREATING_PERCENT)

        val stitched = entry.state.uploads.firstOrNull { it.role == "stitched" }?.downloadId
            ?: entry.state.uploads.firstOrNull()?.downloadId
            ?: return@withContext fail(entry, FailureCodes.UNKNOWN, "no uploaded video to post", retryable = false)

        val originals = entry.state.uploads
            .filter { it.role == "original" }
            .map { upload ->
                upload.downloadId ?: return@withContext fail(
                    entry,
                    FailureCodes.UNKNOWN,
                    "upload ${upload.uploadGuid} has no id",
                    retryable = false,
                )
            }

        val body = TemplateFill.fill(entry.request.createPost.bodyTemplate, stitched, originals)
        try {
            JSONObject(body)
        } catch (e: JSONException) {
            // The template is the caller's, so a body that does not parse is a caller bug - and one
            // no amount of retrying fixes.
            return@withContext fail(entry, FailureCodes.UNKNOWN, "the filled body is not valid JSON", retryable = false)
        }

        val request = Request.Builder()
            .url(entry.request.createPost.url)
            .post(body.toRequestBody(JSON))
            .apply { entry.request.headers.forEach { (name, value) -> header(name, value) } }
            .build()

        val response = try {
            PublisherHttp.client.newCall(request).await()
        } catch (e: CancellationException) {
            throw e
        } catch (e: IOException) {
            return@withContext retryOrFail(entry, FailureCodes.NETWORK, e.message ?: "connection failed")
        }

        val code = response.code
        val responseBody = response.use { it.body?.string().orEmpty() }

        when {
            code in 200..299 -> {
                val created = PublisherHttp.parseCreatedPost(responseBody)
                    ?: return@withContext fail(
                        entry,
                        FailureCodes.HTTP,
                        "no postId in the response: ${PublisherHttp.errorMessage(responseBody)}",
                        retryable = false,
                        httpStatus = code,
                    )
                entry.state.phase = Phase.DONE
                entry.state.percent = 100
                entry.state.postId = created.postId
                entry.state.published = created.published
                entry.state.error = null
                entry.acked = false
                store.save(entry)

                PostingNotification.cancel(applicationContext)
                PublisherEvents.forget(pendingPostId)
                PublisherEvents.finished(pendingPostId, created.postId, created.published)
                Log.i(TAG, "posted $pendingPostId as ${created.postId} (published=${created.published})")
                Result.success()
            }
            // The server looked at this post and said no. Sending it again changes nothing.
            code == 400 -> fail(
                entry,
                FailureCodes.SERVER_REJECTED,
                PublisherHttp.errorMessage(responseBody),
                retryable = false,
                httpStatus = code,
            )
            code == 401 || code == 403 -> fail(
                entry,
                FailureCodes.AUTH,
                PublisherHttp.errorMessage(responseBody),
                retryable = true,
                httpStatus = code,
            )
            code in 500..599 -> retryOrFail(
                entry,
                FailureCodes.HTTP,
                PublisherHttp.errorMessage(responseBody),
                httpStatus = code,
            )
            else -> fail(
                entry,
                FailureCodes.HTTP,
                PublisherHttp.errorMessage(responseBody),
                retryable = false,
                httpStatus = code,
            )
        }
    }

    /* ---------------------------------------------------------------------------------------- */

    private suspend fun goForeground() {
        try {
            setForeground(getForegroundInfo())
        } catch (e: IllegalStateException) {
            Log.w(TAG, "foreground not allowed, continuing without: ${e.message}")
        }
    }

    private fun retryOrFail(
        entry: PublishEntry,
        code: String,
        message: String,
        httpStatus: Int? = null,
    ): Result {
        if (runAttemptCount < Workers.MAX_ATTEMPTS - 1) {
            entry.state.error = PublishFailure(code, message, httpStatus, "creating", null, true)
            store.save(entry)
            return Result.retry()
        }
        return fail(entry, code, message, retryable = true, httpStatus = httpStatus)
    }

    private fun fail(
        entry: PublishEntry,
        code: String,
        message: String,
        retryable: Boolean,
        httpStatus: Int? = null,
    ): Result {
        val failure = PublishFailure(code, message, httpStatus, "creating", null, retryable)
        entry.state.phase = Phase.FAILED
        entry.state.error = failure
        entry.acked = false
        store.save(entry)
        PostingNotification.cancel(applicationContext)
        PublisherEvents.failed(pendingPostId, failure)
        Log.w(TAG, "create failed for $pendingPostId: $code $message")
        return Result.failure()
    }

    private companion object {
        const val TAG = "PostPublisher"

        /** Where the bar sits while the post is being created: the files are in, the post is not. */
        const val CREATING_PERCENT = 97

        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
