package net.dotnetdreamer.videokit.publisher

import android.net.Uri
import android.util.Log
import androidx.work.ExistingWorkPolicy
import com.getcapacitor.JSObject
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.json.JSONObject
import java.io.File
import java.lang.ref.WeakReference

/**
 * The Capacitor face of the background publisher.
 *
 * Every method here is short by design: the plugin writes a record, tells WorkManager about it, and
 * gets out of the way. Nothing is held in memory that the job depends on, because the job routinely
 * outlives this object - and sometimes the whole process.
 *
 * All methods run on Capacitor's one shared plugin thread, which the rest of the app also uses, so
 * nothing here blocks on network or large file IO.
 */
@CapacitorPlugin(name = "BackgroundPublisher")
class BackgroundPublisherPlugin : Plugin() {

    private lateinit var store: PublishStore
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    override fun load() {
        val appContext = context.applicationContext
        store = PublishStore(appContext)
        PublisherEvents.emitter = WeakReference(this)
        UploadNotification.ensureChannel(appContext)
        pluginScope.launch {
            store.sweep(System.currentTimeMillis(), PublishStore.DONE_RETENTION_MS)
            // A batch that finished while no WebView was attached has been waiting to say so.
            PublisherEvents.replayUnacked(this@BackgroundPublisherPlugin, store)
        }
    }

    override fun handleOnDestroy() {
        // The workers, the notification and the records all outlive the Bridge by design.
        PublisherEvents.emitter = null
        super.handleOnDestroy()
    }

    internal fun emit(event: String, data: JSObject, retain: Boolean) {
        notifyListeners(event, data, retain)
    }

    /* ======================================================================================== */

    @PluginMethod
    fun publish(call: PluginCall) {
        val request = try {
            PublishRequest.from(call.data)
        } catch (e: RequestException) {
            call.reject(e.message ?: "invalid_request", INVALID_REQUEST)
            return
        }

        // Fail now, loudly, rather than in a worker an hour later with the app closed.
        for (upload in request.uploads) {
            val file = fileFor(upload.path)
            if (!file.exists() || file.length() == 0L) {
                call.reject("missing file for ${upload.uploadId}", FailureCodes.FILE_MISSING)
                return
            }
        }

        val existing = store.load(request.batchId)
        if (existing != null && existing.state.phase in IN_FLIGHT) {
            // Already going. Saying yes again is what keeps a retried call from sending twice.
            call.resolve()
            return
        }

        if (existing != null && existing.state.phase == Phase.DONE) {
            // A finished batch re-published would start a fresh record, and a fresh record is not
            // DONE, so the finalize worker's idempotence guard could not fire and the call would go
            // out a second time. Re-announce instead, so a caller that missed the first event still
            // hears it. iOS has always done this.
            PublisherEvents.finished(request.batchId, existing.state.result)
            call.resolve()
            return
        }

        val state = PublishState.initial(request)
        // An id obtained before a previous attempt was abandoned is still good - carrying it over
        // is what stops a retry from uploading the same file twice.
        existing?.state?.uploads?.forEach { previous ->
            if (previous.remoteId == null) return@forEach
            state.uploadFor(previous.uploadId)?.let { current ->
                current.remoteId = previous.remoteId
                current.status = UploadStatus.DONE
            }
        }
        state.attempts = (existing?.state?.attempts ?: 0) + 1

        val now = System.currentTimeMillis()
        store.save(
            PublishEntry(
                request = request,
                state = state,
                acked = false,
                createdAt = existing?.createdAt ?: now,
                updatedAt = now,
            ),
        )
        Workers.enqueue(context.applicationContext, request.batchId, ExistingWorkPolicy.KEEP)
        call.resolve()
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val batchId = call.getString("batchId")
        if (batchId.isNullOrEmpty()) {
            call.reject("batchId is required", INVALID_REQUEST)
            return
        }
        val entry = store.load(batchId)
        if (entry == null) {
            call.resolve(JSObject().put("state", JSONObject.NULL))
            return
        }
        // Fold in the live byte counters: the record is written every few percent, and the caller
        // asking right now wants the current number, not the last persisted one.
        val live = PublisherEvents.bytesFor(batchId)
        if (live.isNotEmpty()) {
            entry.state.uploads.forEach { upload ->
                live[upload.uploadId]?.let { bytes ->
                    if (bytes > upload.bytesSent) upload.bytesSent = bytes
                }
            }
            entry.state.percent = entry.state.computePercent(live)
        }
        if (entry.state.phase in TERMINAL && !entry.acked) {
            store.update(batchId) { it.acked = true }
        }
        call.resolve(JSObject().put("state", entry.state.toJson()))
    }

    @PluginMethod
    fun cancel(call: PluginCall) {
        val batchId = call.getString("batchId")
        if (batchId.isNullOrEmpty()) {
            call.reject("batchId is required", INVALID_REQUEST)
            return
        }
        Workers.cancel(context.applicationContext, batchId)
        store.update(batchId) { entry ->
            entry.state.phase = Phase.CANCELLED
            // No error is recorded: the phase already says what happened, and a code of "cancelled"
            // in the error slot would show up as a failure in anything reading the state.
            entry.state.error = null
            entry.acked = true
        }
        UploadNotification.cancel(context.applicationContext)
        PublisherEvents.forget(batchId)
        // Deliberately no event: cancel is usually the first half of a discard, and a failure event
        // arriving between the two reads as something going wrong.
        call.resolve()
    }

    @PluginMethod
    fun retry(call: PluginCall) {
        val batchId = call.getString("batchId")
        if (batchId.isNullOrEmpty()) {
            call.reject("batchId is required", INVALID_REQUEST)
            return
        }
        val headers = call.getObject("headers")
        val updated = store.update(batchId) { entry ->
            headers?.let { entry.request.headers = entry.request.headers + readHeaders(it) }
            entry.state.error = null
            entry.state.phase = Phase.QUEUED
            entry.state.attempts += 1
            entry.acked = false
            entry.state.uploads.forEach { upload ->
                // Anything without an id goes back in the queue; anything with one is already done.
                if (upload.remoteId == null) upload.status = UploadStatus.QUEUED
            }
        }
        if (updated == null) {
            call.reject("nothing to retry for $batchId", NOT_FOUND)
            return
        }
        // REPLACE rather than KEEP: a chain that already failed would otherwise be kept in place.
        Workers.enqueue(context.applicationContext, batchId, ExistingWorkPolicy.REPLACE)
        call.resolve()
    }

    @PluginMethod
    fun clear(call: PluginCall) {
        val batchId = call.getString("batchId")
        if (batchId.isNullOrEmpty()) {
            call.reject("batchId is required", INVALID_REQUEST)
            return
        }
        Workers.cancel(context.applicationContext, batchId)
        // Only the record goes; the files belong to whoever put them there.
        store.delete(batchId)
        PublisherEvents.forget(batchId)
        UploadNotification.cancel(context.applicationContext)
        call.resolve()
    }

    /* ======================================================================================== */

    private fun readHeaders(o: JSObject): Map<String, String> {
        val map = LinkedHashMap<String, String>()
        val keys = o.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            map[key] = o.optString(key)
        }
        return map
    }

    private fun fileFor(path: String): File {
        val uri = Uri.parse(path)
        return when (uri.scheme) {
            "file" -> File(uri.path ?: path)
            null -> File(path)
            else -> File(uri.path ?: path)
        }
    }

    private companion object {
        const val TAG = "BackgroundPublisher"

        const val INVALID_REQUEST = "invalid_request"
        const val NOT_FOUND = "not_found"

        val IN_FLIGHT = setOf(Phase.QUEUED, Phase.UPLOADING, Phase.FINALIZING)
        val TERMINAL = setOf(Phase.DONE, Phase.FAILED, Phase.CANCELLED)
    }
}
