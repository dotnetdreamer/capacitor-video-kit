package net.dotnetdreamer.videokit.publisher

import android.util.Log
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject
import org.json.JSONTokener
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The HTTP client, and the little bit of reading the server's answers need.
 *
 * Nothing here knows a response key: the caller says where its id lives, by a dotted path, because
 * this code runs hours later in a process the caller's own code is not in. What it does own is the
 * rule that nothing trusts a content type. Servers that answer JSON as `text/plain`, or report an
 * error as a bare JSON string rather than an object, are common enough that parsing has to be
 * attempted rather than announced.
 */
object PublisherHttp {

    private const val TAG = "BackgroundPublisher"

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            // The server may buffer the whole file, and may transcode, before answering.
            .readTimeout(180, TimeUnit.SECONDS)
            .retryOnConnectionFailure(true)
            // Deliberately no callTimeout: a 100 MB upload on a slow connection legitimately takes
            // longer than any fixed budget, and a stall is already caught by the write timeout.
            .build()
    }

    /** Suspends on an OkHttp call and cancels it if the coroutine is cancelled. */
    suspend fun Call.await(): Response = suspendCancellableCoroutine { continuation ->
        enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (!continuation.isCancelled) continuation.resumeWithException(e)
            }

            override fun onResponse(call: Call, response: Response) {
                continuation.resume(response)
            }
        })
        continuation.invokeOnCancellation {
            try {
                cancel()
            } catch (e: Exception) {
                Log.w(TAG, "could not cancel call: ${e.message}")
            }
        }
    }

    /**
     * The server's id for a stored file, from wherever the caller said it lives.
     *
     * Null `idPath` is the presigned case: the URL already decided where the file went, so there
     * is nothing to read and the caller's own upload id stands in.
     */
    fun parseRemoteId(body: String, idPath: String?): RemoteId? {
        if (idPath.isNullOrEmpty()) return null
        return RemoteId.of(valueAt(parseJson(body), idPath))
    }

    /** Whether a 2xx body carries what the caller said it must. */
    fun hasValueAt(body: String, path: String?): Boolean {
        if (path.isNullOrEmpty()) return true
        val value = valueAt(parseJson(body), path)
        return value != null && value != JSONObject.NULL && value != ""
    }

    /** Walks a dotted path - `downloadId`, `data.id` - through a parsed body. */
    fun valueAt(json: Any?, path: String): Any? {
        var current: Any? = json
        for (key in path.split('.')) {
            val obj = current as? JSONObject ?: return null
            if (!obj.has(key)) return null
            current = obj.opt(key)
        }
        return current
    }

    /** The body as JSON - an object, an array or a scalar - or null when it is not JSON at all. */
    fun parseJson(body: String): Any? = try {
        JSONTokener(body).nextValue()
    } catch (e: JSONException) {
        null
    }

    /**
     * The parsed body as something that can go straight into a `JSObject` and into the record.
     * A scalar is fine; anything unparseable becomes null rather than a stray string.
     */
    fun parseResult(body: String): Any? = when (val parsed = parseJson(body)) {
        is JSONObject, is JSONArray, is String, is Number, is Boolean -> parsed
        else -> null
    }

    /**
     * Whatever the server said, as something worth showing a developer. An error body is often a
     * quoted JSON string, so the quotes come off.
     */
    fun errorMessage(body: String): String {
        val trimmed = body.trim()
        if (trimmed.isEmpty()) return "no response body"
        if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
            return trimmed.substring(1, trimmed.length - 1)
        }
        return trimmed.take(MAX_MESSAGE_CHARS)
    }

    /** Asks whether the server already has a file, so a lost response is not a second upload. */
    suspend fun lookupRemoteId(request: PublishRequest, uploadId: String): RemoteId? {
        val url = request.lookupUrlFor(uploadId) ?: return null
        return try {
            val httpRequest = Request.Builder()
                .url(url)
                .get()
                .apply { request.headers.forEach { (name, value) -> header(name, value) } }
                .build()
            client.newCall(httpRequest).await().use { response ->
                if (!response.isSuccessful) return null
                parseRemoteId(response.body?.string().orEmpty(), request.upload.idPath)
            }
        } catch (e: IOException) {
            Log.w(TAG, "lookup for $uploadId failed: ${e.message}")
            null
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "lookup url for $uploadId is not usable: ${e.message}")
            null
        }
    }

    private const val MAX_MESSAGE_CHARS = 500
}
