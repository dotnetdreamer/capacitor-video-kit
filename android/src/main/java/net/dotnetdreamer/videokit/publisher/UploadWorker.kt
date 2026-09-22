package net.dotnetdreamer.videokit.publisher

import android.content.Context
import android.net.Uri
import android.os.SystemClock
import android.util.Log
import androidx.work.CoroutineWorker
import androidx.work.ForegroundInfo
import androidx.work.WorkerParameters
import androidx.work.workDataOf
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import net.dotnetdreamer.videokit.publisher.PublisherHttp.await
import okhttp3.Response
import java.io.File
import java.io.IOException

/**
 * Sends every file of one batch, in order, and records the id the server gives back for each.
 *
 * The invariant that makes this safe to re-run: an upload with a `remoteId` is never sent again.
 * WorkManager will restart this worker after a process death, a network drop or a reboot, and each
 * time it picks up exactly where the record says it stopped. A file that was mid-flight when the
 * process died is looked up by its guid first, because the server may well have the whole thing
 * already and only the response was lost.
 */
class UploadWorker(context: Context, params: WorkerParameters) : CoroutineWorker(context, params) {

    private val batchId: String = inputData.getString(Workers.KEY_BATCH_ID).orEmpty()
    private val store = PublishStore(context)

    override suspend fun getForegroundInfo(): ForegroundInfo =
        UploadNotification.foregroundInfo(applicationContext, percent = 0, done = 0, total = 0)

    override suspend fun doWork(): Result = withContext(Dispatchers.IO) {
        if (batchId.isEmpty()) return@withContext Result.failure()
        val entry = store.load(batchId) ?: return@withContext Result.failure()
        if (entry.state.phase == Phase.CANCELLED) return@withContext Result.failure()

        UploadNotification.ensureChannel(applicationContext)
        goForeground()

        entry.state.phase = Phase.UPLOADING
        val uploads = entry.request.uploads
        // Sizes are read once up front so the percentage is stable even as files finish.
        uploads.forEach { upload ->
            val state = entry.state.uploadFor(upload.uploadId) ?: return@forEach
            if (state.bytesTotal <= 0L) state.bytesTotal = fileFor(upload).length()
        }
        store.save(entry)

        for (upload in uploads) {
            val state = entry.state.uploadFor(upload.uploadId)
                ?: return@withContext fail(
                    entry,
                    FailureCodes.UNKNOWN,
                    "no record for ${upload.uploadId}",
                    upload.uploadId,
                    retryable = false,
                )

            // Already accepted by the server, this run or a previous one.
            if (state.remoteId != null) continue

            // Interrupted mid-flight: the server may have the file even though we never saw the
            // answer. Asking is a great deal cheaper than sending it again.
            if (state.status == UploadStatus.UPLOADING) {
                val recovered = PublisherHttp.lookupRemoteId(entry.request, upload.uploadId)
                if (recovered != null) {
                    Log.i(TAG, "recovered ${upload.uploadId} without re-sending")
                    state.remoteId = recovered
                    state.status = UploadStatus.DONE
                    state.bytesSent = state.bytesTotal
                    store.save(entry)
                    emitProgress(entry)
                    continue
                }
            }

            val file = fileFor(upload)
            if (!file.exists() || file.length() == 0L) {
                return@withContext fail(
                    entry,
                    FailureCodes.FILE_MISSING,
                    "missing ${upload.uploadId}",
                    upload.uploadId,
                    retryable = false,
                )
            }

            state.status = UploadStatus.UPLOADING
            state.bytesTotal = file.length()
            store.save(entry)

            val response: Response = try {
                PublisherHttp.client
                    .newCall(
                        UploadRequests.build(entry.request, upload, file) { sent ->
                            onBytes(entry, upload.uploadId, sent)
                        },
                    )
                    .await()
            } catch (e: CancellationException) {
                // The job was cancelled; never swallowed, or the chain would carry on regardless.
                throw e
            } catch (e: IOException) {
                return@withContext retryOrFail(
                    entry,
                    FailureCodes.NETWORK,
                    e.message ?: "connection failed",
                    upload.uploadId,
                )
            }

            val code = response.code
            val body = response.use { it.body?.string().orEmpty() }

            when {
                code in 200..299 -> {
                    // Without an `idPath` the URL already decided where the file went - the
                    // presigned case - so the caller's own id is its id and nothing is parsed.
                    val idPath = entry.request.upload.idPath
                    val remoteId = if (idPath.isNullOrEmpty()) {
                        RemoteId(upload.uploadId, isNumber = false)
                    } else {
                        PublisherHttp.parseRemoteId(body, idPath)
                    } ?: return@withContext fail(
                        entry,
                        FailureCodes.HTTP,
                        "no id at $idPath in the response: ${PublisherHttp.errorMessage(body)}",
                        upload.uploadId,
                        retryable = false,
                        httpStatus = code,
                    )
                    state.remoteId = remoteId
                    state.status = UploadStatus.DONE
                    state.httpStatus = code
                    state.bytesSent = state.bytesTotal
                    store.save(entry)
                    emitProgress(entry)
                }
                // The token expired mid-job. Retryable, but only once the caller has a new one,
                // so it stops here rather than burning attempts against a wall.
                code == 401 || code == 403 -> return@withContext fail(
                    entry,
                    FailureCodes.AUTH,
                    PublisherHttp.errorMessage(body),
                    upload.uploadId,
                    retryable = true,
                    httpStatus = code,
                )
                code in 500..599 -> return@withContext retryOrFail(
                    entry,
                    FailureCodes.HTTP,
                    PublisherHttp.errorMessage(body),
                    upload.uploadId,
                    httpStatus = code,
                )
                else -> return@withContext fail(
                    entry,
                    FailureCodes.HTTP,
                    PublisherHttp.errorMessage(body),
                    upload.uploadId,
                    retryable = false,
                    httpStatus = code,
                )
            }
        }

        Result.success()
    }

    /* ---------------------------------------------------------------------------------------- */

    private suspend fun goForeground() {
        try {
            setForeground(getForegroundInfo())
        } catch (e: IllegalStateException) {
            // Both the background-start restriction (API 31+) and the exhausted-budget case
            // (API 35) land here. The work still runs, just without the foreground protection,
            // which is better than not running at all.
            Log.w(TAG, "foreground not allowed, continuing without: ${e.message}")
        }
    }

    private fun fileFor(upload: PublishUpload): File {
        val uri = Uri.parse(upload.path)
        return when (uri.scheme) {
            "file" -> File(uri.path ?: upload.path)
            null -> File(upload.path)
            else -> File(uri.path ?: upload.path)
        }
    }

    private fun onBytes(entry: PublishEntry, uploadId: String, sent: Long) {
        PublisherEvents.setBytes(batchId, uploadId, sent)
        val now = SystemClock.elapsedRealtime()
        if (now - lastTickAt < PROGRESS_TICK_MS) return
        lastTickAt = now

        val percent = entry.state.computePercent(PublisherEvents.bytesFor(batchId))
        if (percent == lastPercent) return
        lastPercent = percent

        setProgressAsyncSafely(percent)
        val done = entry.state.uploads.count { it.status == UploadStatus.DONE }
        UploadNotification.update(applicationContext, percent, done, entry.state.uploads.size)
        PublisherEvents.progress(batchId, "uploading", percent)

        // The record is written far less often than the counter moves; it only has to be good
        // enough to resume from.
        if (percent - lastPersistedPercent >= PERSIST_EVERY_PERCENT) {
            lastPersistedPercent = percent
            entry.state.percent = percent
            entry.state.uploadFor(uploadId)?.bytesSent = sent
            store.save(entry)
        }
    }

    private fun setProgressAsyncSafely(percent: Int) {
        try {
            setProgressAsync(workDataOf("percent" to percent))
        } catch (e: IllegalStateException) {
            // The worker is already finishing; the progress value is of no further interest.
        }
    }

    private fun emitProgress(entry: PublishEntry) {
        val percent = entry.state.computePercent(PublisherEvents.bytesFor(batchId))
        entry.state.percent = percent
        val done = entry.state.uploads.count { it.status == UploadStatus.DONE }
        UploadNotification.update(applicationContext, percent, done, entry.state.uploads.size)
        PublisherEvents.progress(batchId, "uploading", percent)
    }

    /**
     * A transient failure: record it, keep the phase as it is, and let WorkManager back off. No
     * event goes out - the caller shows "waiting for connection", not "it failed" - until the
     * attempts are actually used up.
     */
    private fun retryOrFail(
        entry: PublishEntry,
        code: String,
        message: String,
        uploadId: String?,
        httpStatus: Int? = null,
    ): Result {
        if (runAttemptCount < Workers.MAX_ATTEMPTS - 1) {
            entry.state.error = PublishFailure(code, message, httpStatus, "uploading", uploadId, true)
            store.save(entry)
            Log.i(TAG, "attempt ${runAttemptCount + 1} failed ($code); backing off")
            return Result.retry()
        }
        return fail(entry, code, message, uploadId, retryable = true, httpStatus = httpStatus)
    }

    private fun fail(
        entry: PublishEntry,
        code: String,
        message: String,
        uploadId: String?,
        retryable: Boolean,
        httpStatus: Int? = null,
    ): Result {
        val failure = PublishFailure(code, message, httpStatus, "uploading", uploadId, retryable)
        entry.state.phase = Phase.FAILED
        entry.state.error = failure
        entry.acked = false
        store.save(entry)
        UploadNotification.cancel(applicationContext)
        PublisherEvents.failed(batchId, failure)
        Log.w(TAG, "upload failed for $batchId: $code $message")
        // Failing also drops the chained create step, which is exactly what should happen.
        return Result.failure()
    }

    private var lastTickAt = 0L
    private var lastPercent = -1
    private var lastPersistedPercent = 0

    private companion object {
        const val TAG = "BackgroundPublisher"
        const val PROGRESS_TICK_MS = 500L
        const val PERSIST_EVERY_PERCENT = 5
    }
}
