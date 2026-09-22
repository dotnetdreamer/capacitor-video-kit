package net.dotnetdreamer.videokit.publisher

import android.util.Log
import com.getcapacitor.JSObject
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap

/**
 * Events out of the workers, and live byte counters the store is too slow to carry.
 *
 * The workers outlive the Bridge - that is the whole point - so they cannot hold a reference to a
 * plugin instance. They publish through here instead, and anything emitted while no WebView is
 * attached is simply dropped: the record on disk is the source of truth, a fresh plugin instance
 * replays whatever has not been acknowledged, and the caller asks `getState` on every launch
 * anyway. A lost event is never load-bearing.
 */
object PublisherEvents {

    private const val TAG = "BackgroundPublisher"

    @Volatile
    var emitter: WeakReference<BackgroundPublisherPlugin>? = null

    /** Bytes sent per upload, updated far more often than the record is written. */
    val liveBytes = ConcurrentHashMap<String, MutableMap<String, Long>>()

    fun emit(event: String, payload: JSObject, retain: Boolean) {
        val plugin = emitter?.get()
        if (plugin == null) {
            Log.d(TAG, "no bridge attached; '$event' will be replayed from the record")
            return
        }
        plugin.emit(event, payload, retain)
    }

    fun progress(batchId: String, phase: String, percent: Int) {
        emit(
            "publishProgress",
            JSObject()
                .put("batchId", batchId)
                .put("phase", phase)
                .put("percent", percent),
            // A stale percentage is worth nothing and would pile up in the retained list.
            retain = false,
        )
    }

    fun finished(batchId: String, result: Any?) {
        val payload = JSObject().put("batchId", batchId)
        // Absent rather than null when the body was not JSON: a 204 finishes a batch too, and the
        // caller reading `result` should be able to tell "nothing was sent" from "null was sent".
        result?.let { payload.put("result", it) }
        emit("publishFinished", payload, retain = true)
    }

    fun failed(batchId: String, failure: PublishFailure) {
        val payload = JSObject()
            .put("batchId", batchId)
            .put("phase", failure.phase)
            .put("code", failure.code)
            .put("message", failure.message)
        failure.httpStatus?.let { payload.put("httpStatus", it) }
        emit("publishFailed", payload, retain = true)
    }

    fun setBytes(batchId: String, uploadId: String, bytes: Long) {
        liveBytes.getOrPut(batchId) { ConcurrentHashMap() }[uploadId] = bytes
    }

    fun bytesFor(batchId: String): Map<String, Long> = liveBytes[batchId] ?: emptyMap()

    fun forget(batchId: String) {
        liveBytes.remove(batchId)
    }

    /** Hands a fresh plugin instance every finished or failed batch it has not seen yet. */
    fun replayUnacked(plugin: BackgroundPublisherPlugin, store: PublishStore) {
        store.all().forEach { entry ->
            if (entry.acked) return@forEach
            when (entry.state.phase) {
                Phase.DONE -> {
                    val payload = JSObject().put("batchId", entry.request.batchId)
                    entry.state.result?.let { payload.put("result", it) }
                    plugin.emit("publishFinished", payload, retain = true)
                }
                Phase.FAILED -> {
                    val failure = entry.state.error ?: return@forEach
                    val payload = JSObject()
                        .put("batchId", entry.request.batchId)
                        .put("phase", failure.phase)
                        .put("code", failure.code)
                        .put("message", failure.message)
                    failure.httpStatus?.let { payload.put("httpStatus", it) }
                    plugin.emit("publishFailed", payload, retain = true)
                }
                else -> Unit
            }
        }
    }
}
