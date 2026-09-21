package net.dotnetdreamer.videokit.postpublisher

import android.util.Log
import kotlinx.coroutines.suspendCancellableCoroutine
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import org.json.JSONException
import org.json.JSONObject
import java.io.IOException
import java.util.concurrent.TimeUnit
import kotlin.coroutines.resume
import kotlin.coroutines.resumeWithException

/**
 * The HTTP client and the little bit of parsing the server's answers need.
 *
 * Worth knowing about the responses: they are JSON, but served as `text/plain`, and an error comes
 * back as a bare JSON string rather than an object. So nothing here trusts the content type, and a
 * body that is not an object is treated as the error message.
 */
object PublisherHttp {

    private const val TAG = "PostPublisher"

    val client: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(30, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            // The server buffers the whole file and may transcode before answering.
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

    fun parseDownloadId(body: String): Int? = parseObject(body)
        ?.optInt("downloadId", 0)
        ?.takeIf { it > 0 }

    data class CreatedPost(val postId: Int, val published: Boolean)

    fun parseCreatedPost(body: String): CreatedPost? {
        val json = parseObject(body) ?: return null
        val postId = json.optInt("postId", 0)
        if (postId <= 0) return null
        return CreatedPost(postId, json.optBoolean("published", false))
    }

    /**
     * Whatever the server said, as something worth showing a developer. An error body is usually a
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

    /** Looks up an upload the server may already have, so a lost response is not a second upload. */
    suspend fun lookupDownloadId(request: PublishRequest, uploadGuid: String): Int? {
        val url = request.lookupUrlFor(uploadGuid) ?: return null
        return try {
            val httpRequest = Request.Builder()
                .url(url)
                .get()
                .apply { request.headers.forEach { (name, value) -> header(name, value) } }
                .build()
            client.newCall(httpRequest).await().use { response ->
                if (!response.isSuccessful) return null
                parseDownloadId(response.body?.string().orEmpty())
            }
        } catch (e: IOException) {
            Log.w(TAG, "lookup for $uploadGuid failed: ${e.message}")
            null
        } catch (e: IllegalArgumentException) {
            Log.w(TAG, "lookup url for $uploadGuid is not usable: ${e.message}")
            null
        }
    }

    private fun parseObject(body: String): JSONObject? = try {
        JSONObject(body)
    } catch (e: JSONException) {
        null
    }

    private const val MAX_MESSAGE_CHARS = 500
}
