package net.dotnetdreamer.videokit.postpublisher

import org.json.JSONArray
import org.json.JSONObject

/**
 * Kotlin mirrors of `definitions.ts`, plus their JSON form.
 *
 * These are written to disk, not just passed around: the whole request - auth header and body
 * template included - has to survive the app being killed, because the upload continues without any
 * JavaScript to ask. So every shape here reads and writes itself, and the JSON is the record
 * format as well as the wire format.
 */

enum class Phase(val wire: String) {
    QUEUED("queued"),
    UPLOADING("uploading"),
    CREATING("creating"),
    DONE("done"),
    FAILED("failed"),
    CANCELLED("cancelled");

    companion object {
        fun from(value: String?): Phase = entries.firstOrNull { it.wire == value } ?: QUEUED
    }
}

enum class UploadStatus(val wire: String) {
    QUEUED("queued"),
    UPLOADING("uploading"),
    DONE("done"),
    FAILED("failed");

    companion object {
        fun from(value: String?): UploadStatus = entries.firstOrNull { it.wire == value } ?: QUEUED
    }
}

object FailureCodes {
    const val NETWORK = "network"
    const val HTTP = "http"
    const val AUTH = "auth"
    const val SERVER_REJECTED = "server_rejected"
    const val FILE_MISSING = "file_missing"
    const val CANCELLED = "cancelled"
    const val UNKNOWN = "unknown"
}

class RequestException(message: String) : IllegalArgumentException(message)

data class PublishUpload(
    val uploadGuid: String,
    val role: String,
    val path: String,
    val mimeType: String,
    val pictureId: Int?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("uploadGuid", uploadGuid)
        .put("role", role)
        .put("path", path)
        .put("mimeType", mimeType)
        .apply { pictureId?.let { put("pictureId", it) } }

    companion object {
        fun from(o: JSONObject, path: String): PublishUpload {
            val uploadGuid = o.optString("uploadGuid")
            if (uploadGuid.isEmpty()) throw RequestException("invalid_request:$path.uploadGuid")
            val filePath = o.optString("path")
            if (filePath.isEmpty()) throw RequestException("invalid_request:$path.path")
            val role = o.optString("role", "original")
            if (role != "stitched" && role != "original") {
                throw RequestException("invalid_request:$path.role")
            }
            return PublishUpload(
                uploadGuid = uploadGuid,
                role = role,
                path = filePath,
                mimeType = o.optString("mimeType", "application/octet-stream"),
                pictureId = o.optInt("pictureId", 0).takeIf { it > 0 },
            )
        }
    }
}

data class CreatePost(val url: String, val bodyTemplate: String) {
    fun toJson(): JSONObject = JSONObject().put("url", url).put("bodyTemplate", bodyTemplate)

    companion object {
        fun from(o: JSONObject?): CreatePost {
            if (o == null) throw RequestException("invalid_request:createPost")
            val url = o.optString("url")
            if (url.isEmpty()) throw RequestException("invalid_request:createPost.url")
            val template = o.optString("bodyTemplate")
            if (template.isEmpty()) throw RequestException("invalid_request:createPost.bodyTemplate")
            return CreatePost(url, template)
        }
    }
}

data class PublishRequest(
    val pendingPostId: String,
    var headers: Map<String, String>,
    val uploadUrl: String,
    val lookupUrlTemplate: String?,
    val uploads: List<PublishUpload>,
    val createPost: CreatePost,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("pendingPostId", pendingPostId)
        .put("headers", JSONObject(headers as Map<*, *>))
        .put("uploadUrl", uploadUrl)
        .apply { lookupUrlTemplate?.let { put("lookupUrlTemplate", it) } }
        .put("uploads", JSONArray().apply { uploads.forEach { put(it.toJson()) } })
        .put("createPost", createPost.toJson())

    /** The lookup URL for one guid, or null when the caller did not offer a template. */
    fun lookupUrlFor(uploadGuid: String): String? =
        lookupUrlTemplate?.replace("{uploadGuid}", uploadGuid)

    companion object {
        fun from(o: JSONObject): PublishRequest {
            val pendingPostId = o.optString("pendingPostId")
            if (pendingPostId.isEmpty()) throw RequestException("invalid_request:pendingPostId")
            val uploadUrl = o.optString("uploadUrl")
            if (uploadUrl.isEmpty()) throw RequestException("invalid_request:uploadUrl")

            val uploadsJson = o.optJSONArray("uploads")
                ?: throw RequestException("invalid_request:uploads")
            if (uploadsJson.length() == 0) throw RequestException("invalid_request:uploads")
            val uploads = (0 until uploadsJson.length()).map { i ->
                val entry = uploadsJson.optJSONObject(i)
                    ?: throw RequestException("invalid_request:uploads[$i]")
                PublishUpload.from(entry, "uploads[$i]")
            }

            return PublishRequest(
                pendingPostId = pendingPostId,
                headers = readHeaders(o.optJSONObject("headers")),
                uploadUrl = uploadUrl,
                lookupUrlTemplate = o.optString("lookupUrlTemplate").takeIf { it.isNotEmpty() },
                uploads = uploads,
                createPost = CreatePost.from(o.optJSONObject("createPost")),
            )
        }

        private fun readHeaders(o: JSONObject?): Map<String, String> {
            if (o == null) return emptyMap()
            val map = LinkedHashMap<String, String>()
            val keys = o.keys()
            while (keys.hasNext()) {
                val key = keys.next()
                map[key] = o.optString(key)
            }
            return map
        }
    }
}

data class UploadState(
    val uploadGuid: String,
    val role: String,
    var status: UploadStatus = UploadStatus.QUEUED,
    var downloadId: Int? = null,
    var pictureId: Int? = null,
    var httpStatus: Int? = null,
    var bytesSent: Long = 0L,
    var bytesTotal: Long = 0L,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("uploadGuid", uploadGuid)
        .put("role", role)
        .put("status", status.wire)
        .apply {
            downloadId?.let { put("downloadId", it) }
            pictureId?.let { put("pictureId", it) }
            httpStatus?.let { put("httpStatus", it) }
        }
        .put("bytesSent", bytesSent)
        .put("bytesTotal", bytesTotal)

    companion object {
        fun from(o: JSONObject): UploadState = UploadState(
            uploadGuid = o.optString("uploadGuid"),
            role = o.optString("role", "original"),
            status = UploadStatus.from(o.optString("status")),
            downloadId = o.optInt("downloadId", 0).takeIf { it > 0 },
            pictureId = o.optInt("pictureId", 0).takeIf { it > 0 },
            httpStatus = o.optInt("httpStatus", 0).takeIf { it > 0 },
            bytesSent = o.optLong("bytesSent", 0L),
            bytesTotal = o.optLong("bytesTotal", 0L),
        )
    }
}

data class PublishFailure(
    val code: String,
    val message: String,
    val httpStatus: Int?,
    /** Always one of the two working phases: the wire type has no room for `queued`. */
    val phase: String,
    val uploadGuid: String?,
    val retryable: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("code", code)
        .put("message", message)
        .apply {
            httpStatus?.let { put("httpStatus", it) }
            uploadGuid?.let { put("uploadGuid", it) }
        }
        .put("phase", phase)
        .put("retryable", retryable)

    companion object {
        fun from(o: JSONObject): PublishFailure = PublishFailure(
            code = o.optString("code", FailureCodes.UNKNOWN),
            message = o.optString("message"),
            httpStatus = o.optInt("httpStatus", 0).takeIf { it > 0 },
            phase = o.optString("phase", "uploading"),
            uploadGuid = o.optString("uploadGuid").takeIf { it.isNotEmpty() },
            retryable = o.optBoolean("retryable", true),
        )
    }
}

data class PublishState(
    val pendingPostId: String,
    var phase: Phase = Phase.QUEUED,
    var percent: Int = 0,
    var uploads: MutableList<UploadState> = mutableListOf(),
    var postId: Int? = null,
    var published: Boolean? = null,
    var error: PublishFailure? = null,
    var attempts: Int = 0,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("pendingPostId", pendingPostId)
        .put("phase", phase.wire)
        .put("percent", percent)
        .put("uploads", JSONArray().apply { uploads.forEach { put(it.toJson()) } })
        .apply {
            postId?.let { put("postId", it) }
            published?.let { put("published", it) }
            error?.let { put("error", it.toJson()) }
        }
        .put("attempts", attempts)

    fun uploadFor(uploadGuid: String): UploadState? = uploads.firstOrNull { it.uploadGuid == uploadGuid }

    /**
     * Bytes-weighted, and capped at 95 until the post itself exists. Nothing reaches 100 on the
     * strength of the files alone, because "uploaded" is not "posted" and showing otherwise would
     * be a lie the customer notices.
     */
    fun computePercent(liveBytes: Map<String, Long> = emptyMap()): Int {
        if (phase == Phase.DONE) return 100
        val total = uploads.sumOf { it.bytesTotal }
        if (total <= 0L) return percent.coerceIn(0, 95)
        val sent = uploads.sumOf { upload ->
            when {
                upload.status == UploadStatus.DONE -> upload.bytesTotal
                else -> maxOf(upload.bytesSent, liveBytes[upload.uploadGuid] ?: 0L)
            }
        }
        return ((sent.toDouble() / total.toDouble()) * 95.0).toInt().coerceIn(0, 95)
    }

    companion object {
        fun from(o: JSONObject): PublishState {
            val uploadsJson = o.optJSONArray("uploads") ?: JSONArray()
            return PublishState(
                pendingPostId = o.optString("pendingPostId"),
                phase = Phase.from(o.optString("phase")),
                percent = o.optInt("percent", 0),
                uploads = (0 until uploadsJson.length())
                    .mapNotNull { i -> uploadsJson.optJSONObject(i)?.let { UploadState.from(it) } }
                    .toMutableList(),
                postId = o.optInt("postId", 0).takeIf { it > 0 },
                published = if (o.has("published")) o.optBoolean("published") else null,
                error = o.optJSONObject("error")?.let { PublishFailure.from(it) },
                attempts = o.optInt("attempts", 0),
            )
        }

        fun initial(request: PublishRequest): PublishState = PublishState(
            pendingPostId = request.pendingPostId,
            phase = Phase.QUEUED,
            uploads = request.uploads
                .map { UploadState(it.uploadGuid, it.role, pictureId = it.pictureId) }
                .toMutableList(),
        )
    }
}

/** One post's whole record: what to do, and how far it got. */
data class PublishEntry(
    val request: PublishRequest,
    val state: PublishState,
    var acked: Boolean = false,
    val createdAt: Long,
    var updatedAt: Long,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("version", VERSION)
        .put("request", request.toJson())
        .put("state", state.toJson())
        .put("acked", acked)
        .put("createdAt", createdAt)
        .put("updatedAt", updatedAt)

    companion object {
        const val VERSION = 1

        fun from(o: JSONObject): PublishEntry = PublishEntry(
            request = PublishRequest.from(
                o.optJSONObject("request") ?: throw RequestException("invalid_record:request"),
            ),
            state = PublishState.from(
                o.optJSONObject("state") ?: throw RequestException("invalid_record:state"),
            ),
            acked = o.optBoolean("acked", false),
            createdAt = o.optLong("createdAt", 0L),
            updatedAt = o.optLong("updatedAt", 0L),
        )
    }
}
