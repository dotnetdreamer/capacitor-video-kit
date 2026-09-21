package net.dotnetdreamer.videokit.postpublisher

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

    private const val TAG = "PostPublisher"

    @Volatile
    var emitter: WeakReference<PostPublisherPlugin>? = null

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

    fun progress(pendingPostId: String, phase: String, percent: Int) {
        emit(
            "publishProgress",
            JSObject()
                .put("pendingPostId", pendingPostId)
                .put("phase", phase)
                .put("percent", percent),
            // A stale percentage is worth nothing and would pile up in the retained list.
            retain = false,
        )
    }

    fun finished(pendingPostId: String, postId: Int, published: Boolean) {
        emit(
            "publishFinished",
            JSObject()
                .put("pendingPostId", pendingPostId)
                .put("postId", postId)
                .put("published", published),
            retain = true,
        )
    }

    fun failed(pendingPostId: String, failure: PublishFailure) {
        val payload = JSObject()
            .put("pendingPostId", pendingPostId)
            .put("phase", failure.phase)
            .put("code", failure.code)
            .put("message", failure.message)
        failure.httpStatus?.let { payload.put("httpStatus", it) }
        emit("publishFailed", payload, retain = true)
    }

    fun setBytes(pendingPostId: String, uploadGuid: String, bytes: Long) {
        liveBytes.getOrPut(pendingPostId) { ConcurrentHashMap() }[uploadGuid] = bytes
    }

    fun bytesFor(pendingPostId: String): Map<String, Long> = liveBytes[pendingPostId] ?: emptyMap()

    fun forget(pendingPostId: String) {
        liveBytes.remove(pendingPostId)
    }

    /** Hands a fresh plugin instance every finished or failed post it has not seen yet. */
    fun replayUnacked(plugin: PostPublisherPlugin, store: PublishRequestStore) {
        store.all().forEach { entry ->
            if (entry.acked) return@forEach
            when (entry.state.phase) {
                Phase.DONE -> {
                    val postId = entry.state.postId ?: return@forEach
                    plugin.emit(
                        "publishFinished",
                        JSObject()
                            .put("pendingPostId", entry.request.pendingPostId)
                            .put("postId", postId)
                            .put("published", entry.state.published ?: false),
                        retain = true,
                    )
                }
                Phase.FAILED -> {
                    val failure = entry.state.error ?: return@forEach
                    val payload = JSObject()
                        .put("pendingPostId", entry.request.pendingPostId)
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
