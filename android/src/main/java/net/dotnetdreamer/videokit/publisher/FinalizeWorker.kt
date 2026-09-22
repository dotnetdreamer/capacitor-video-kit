package net.dotnetdreamer.videokit.publisher

import android.content.Context
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.dotnetdreamer.videokit.publisher.PublisherHttp.await
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.io.IOException

/**
 * The second half: fill the caller's body template with the ids the uploads produced, and make the
 * one call that finishes the batch.
 *
 * Runs as its own worker so that a failure here retries only this call. The uploads are the
 * expensive part and they are already done by the time this starts; re-sending a hundred megabytes
 * because one call got a 503 would be indefensible.
 */
class FinalizeWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val batchId: String = inputData.getString(Workers.KEY_BATCH_ID).orEmpty()
    private val store = PublishStore(context)

    override suspend fun getForegroundInfo(): ForegroundInfo =
        UploadNotification.foregroundInfo(applicationContext, percent = 97, done = 0, total = 0)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (batchId.isEmpty()) return@withContext Result.failure()
        val entry = store.load(batchId) ?: return@withContext Result.failure()
        if (entry.state.phase == Phase.CANCELLED) return@withContext Result.failure()
        // Idempotent: the call has already been made and answered, so a rerun must not repeat
        // it. The phase is the marker rather than a field of the response, because the response
        // belongs to the caller and may be empty - a 204 finishes a batch just as well as a body.
        if (entry.state.phase == Phase.DONE) return@withContext Result.success()

        goForeground()

        entry.state.phase = Phase.FINALIZING
        entry.state.percent = FINALIZING_PERCENT
        store.save(entry)
        UploadNotification.update(applicationContext, FINALIZING_PERCENT, entry.state.uploads.size, entry.state.uploads.size)
        PublisherEvents.progress(batchId, "finalizing", FINALIZING_PERCENT)

        // Every file must have an id, or the body would go out with a token still in it. This is
        // the one thing about the template that IS checked - a token naming nothing is left alone,
        // because at this level a typo and a sentence look identical.
        entry.state.uploads.forEach { upload ->
            if (upload.remoteId == null) {
                return@withContext fail(
                    entry,
                    FailureCodes.UNKNOWN,
                    "upload ${upload.uploadId} has no id",
                    retryable = false,
                )
            }
        }

        val body = TemplateFill.fill(entry.request.finalize.bodyTemplate, entry.state.uploads)
        if (PublisherHttp.parseJson(body) == null) {
            // The template is the caller's, so a body that does not parse is a caller bug - and one
            // no amount of retrying fixes.
            return@withContext fail(entry, FailureCodes.UNKNOWN, "the filled body is not valid JSON", retryable = false)
        }

        val requestBody = body.toRequestBody(JSON)
        val request = Request.Builder()
            .url(entry.request.finalize.url)
            .apply {
                when (entry.request.finalize.method) {
                    UploadMethod.PUT -> put(requestBody)
                    UploadMethod.POST -> post(requestBody)
                }
                entry.request.headers.forEach { (name, value) -> header(name, value) }
            }
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
                // A server that reports failure in the body of a 200 - and there are many - is
                // caught here, but only when the caller said which field to look at. Guessing
                // would be worse than nothing.
                val requirePath = entry.request.finalize.requirePath
                if (!PublisherHttp.hasValueAt(responseBody, requirePath)) {
                    return@withContext fail(
                        entry,
                        FailureCodes.SERVER_REJECTED,
                        "nothing at $requirePath in the response: ${PublisherHttp.errorMessage(responseBody)}",
                        retryable = false,
                        httpStatus = code,
                    )
                }
                val result = PublisherHttp.parseResult(responseBody)
                entry.state.phase = Phase.DONE
                entry.state.percent = 100
                entry.state.result = result
                entry.state.error = null
                entry.acked = false
                store.save(entry)

                UploadNotification.cancel(applicationContext)
                PublisherEvents.forget(batchId)
                PublisherEvents.finished(batchId, result)
                Log.i(TAG, "finalized $batchId")
                Result.success()
            }
            // The server looked at this and said no. Sending it again changes nothing.
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
            entry.state.error = PublishFailure(code, message, httpStatus, "finalizing", null, true)
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
        val failure = PublishFailure(code, message, httpStatus, "finalizing", null, retryable)
        entry.state.phase = Phase.FAILED
        entry.state.error = failure
        entry.acked = false
        store.save(entry)
        UploadNotification.cancel(applicationContext)
        PublisherEvents.failed(batchId, failure)
        Log.w(TAG, "finalize failed for $batchId: $code $message")
        return Result.failure()
    }

    private companion object {
        const val TAG = "BackgroundPublisher"

        /** Where the bar sits while the call is in flight: the files are in, the batch is not. */
        const val FINALIZING_PERCENT = 97

        val JSON = "application/json; charset=utf-8".toMediaType()
    }
}
