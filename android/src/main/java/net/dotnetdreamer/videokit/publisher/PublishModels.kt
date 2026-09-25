package net.dotnetdreamer.videokit.publisher

import net.dotnetdreamer.videokit.videocomposer.JobFolders
import org.json.JSONArray
import org.json.JSONObject

/**
 * Kotlin mirrors of `definitions.ts`, plus their JSON form.
 *
 * These are written to disk, not just passed around: the whole request - auth header, field names
 * and body template included - has to survive the app being killed, because the upload continues
 * without any JavaScript to ask. So every shape here reads and writes itself, and the JSON is the
 * record format as well as the wire format.
 *
 * Nothing here names a backend. A field name, a response key and a URL shape are all data the
 * caller hands over, for the simple reason that there is nobody to ask once the process is gone.
 */

enum class Phase(val wire: String) {
    QUEUED("queued"),
    UPLOADING("uploading"),
    FINALIZING("finalizing"),
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

/**
 * An id the server gave a stored file, keeping the JSON type it arrived as.
 *
 * The type is not cosmetic: it goes straight back into the caller's body template, and a row id
 * that left as `12` and comes back as `"12"` is a 400 from somebody's server. `string` and
 * `number` are the only two JSON scalars an id is ever sent as, so those are the only two here.
 */
data class RemoteId(val value: String, val isNumber: Boolean) {
    /** The id as a JSON value, ready to splice into the body. */
    fun toJsonLiteral(): String = if (isNumber) value else JSONObject.quote(value)

    /** What goes in the record, and in the state the caller reads. */
    fun toJsonValue(): Any = if (isNumber) (value.toLongOrNull() ?: value) else value

    companion object {
        fun of(raw: Any?): RemoteId? = when (raw) {
            null, JSONObject.NULL -> null
            is Int -> RemoteId(raw.toString(), isNumber = true)
            is Long -> RemoteId(raw.toString(), isNumber = true)
            is Double -> RemoteId(if (raw == raw.toLong().toDouble()) raw.toLong().toString() else raw.toString(), isNumber = true)
            is String -> raw.takeIf { it.isNotEmpty() }?.let { RemoteId(it, isNumber = false) }
            else -> null
        }
    }
}

/** How the bytes go up: `POST` a multipart form, or `PUT` the file as the raw body. */
enum class UploadMethod(val wire: String) {
    POST("POST"),
    PUT("PUT");

    companion object {
        fun from(value: String?, path: String): UploadMethod {
            if (value.isNullOrEmpty()) return POST
            return entries.firstOrNull { it.wire.equals(value, ignoreCase = true) }
                ?: throw RequestException("invalid_request:$path")
        }
    }
}

/** The multipart part that carries the bytes, when the transport does not name one. */
const val DEFAULT_FILE_FIELD = "file"

data class PublishTransport(
    val url: String,
    val method: UploadMethod,
    val fileField: String,
    val fields: Map<String, String>,
    val idPath: String?,
    val lookupUrlTemplate: String?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("url", url)
        .put("method", method.wire)
        .put("fileField", fileField)
        .put("fields", JSONObject(fields as Map<*, *>))
        .apply {
            idPath?.let { put("idPath", it) }
            lookupUrlTemplate?.let { put("lookupUrlTemplate", it) }
        }

    companion object {
        fun from(o: JSONObject?): PublishTransport {
            if (o == null) throw RequestException("invalid_request:upload")
            val url = o.optString("url")
            if (url.isEmpty()) throw RequestException("invalid_request:upload.url")
            return PublishTransport(
                url = url,
                method = UploadMethod.from(o.optString("method").takeIf { it.isNotEmpty() }, "upload.method"),
                fileField = o.optString("fileField").takeIf { it.isNotEmpty() } ?: DEFAULT_FILE_FIELD,
                fields = readStringMap(o.optJSONObject("fields")),
                idPath = o.optString("idPath").takeIf { it.isNotEmpty() },
                lookupUrlTemplate = o.optString("lookupUrlTemplate").takeIf { it.isNotEmpty() },
            )
        }
    }
}

data class PublishUpload(
    val uploadId: String,
    val tag: String,
    val path: String,
    val mimeType: String,
    val url: String?,
    val fileName: String?,
    val fields: Map<String, String>,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("uploadId", uploadId)
        .put("tag", tag)
        .put("path", path)
        .put("mimeType", mimeType)
        .put("fields", JSONObject(fields as Map<*, *>))
        .apply {
            url?.let { put("url", it) }
            fileName?.let { put("fileName", it) }
        }

    companion object {
        fun from(o: JSONObject, path: String): PublishUpload {
            val uploadId = o.optString("uploadId")
            if (uploadId.isEmpty()) throw RequestException("invalid_request:$path.uploadId")
            val filePath = o.optString("path")
            if (filePath.isEmpty()) throw RequestException("invalid_request:$path.path")
            return PublishUpload(
                uploadId = uploadId,
                tag = o.optString("tag"),
                path = filePath,
                mimeType = o.optString("mimeType").takeIf { it.isNotEmpty() } ?: "application/octet-stream",
                url = o.optString("url").takeIf { it.isNotEmpty() },
                fileName = o.optString("fileName").takeIf { it.isNotEmpty() },
                fields = readStringMap(o.optJSONObject("fields")),
            )
        }
    }
}

data class PublishFinalize(
    val url: String,
    val method: UploadMethod,
    val bodyTemplate: String,
    val requirePath: String?,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("url", url)
        .put("method", method.wire)
        .put("bodyTemplate", bodyTemplate)
        .apply { requirePath?.let { put("requirePath", it) } }

    companion object {
        fun from(o: JSONObject?): PublishFinalize {
            if (o == null) throw RequestException("invalid_request:finalize")
            val url = o.optString("url")
            if (url.isEmpty()) throw RequestException("invalid_request:finalize.url")
            val template = o.optString("bodyTemplate")
            if (template.isEmpty()) throw RequestException("invalid_request:finalize.bodyTemplate")
            return PublishFinalize(
                url = url,
                method = UploadMethod.from(o.optString("method").takeIf { it.isNotEmpty() }, "finalize.method"),
                bodyTemplate = template,
                requirePath = o.optString("requirePath").takeIf { it.isNotEmpty() },
            )
        }
    }
}

private fun readStringMap(o: JSONObject?): Map<String, String> {
    if (o == null) return emptyMap()
    val map = LinkedHashMap<String, String>()
    val keys = o.keys()
    while (keys.hasNext()) {
        val key = keys.next()
        map[key] = o.optString(key)
    }
    return map
}

data class PublishRequest(
    val batchId: String,
    var headers: Map<String, String>,
    val upload: PublishTransport,
    val uploads: List<PublishUpload>,
    val finalize: PublishFinalize,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("batchId", batchId)
        .put("headers", JSONObject(headers as Map<*, *>))
        .put("upload", upload.toJson())
        .put("uploads", JSONArray().apply { uploads.forEach { put(it.toJson()) } })
        .put("finalize", finalize.toJson())

    fun uploadFor(uploadId: String): PublishUpload? = uploads.firstOrNull { it.uploadId == uploadId }

    /** `<uploadId>.<ext>`, unless the caller named the file itself. */
    fun fileNameFor(upload: PublishUpload): String {
        upload.fileName?.let { return it }
        val extension = upload.path
            .substringBefore('?')
            .substringAfterLast('/')
            .substringAfterLast('.', "")
            .takeIf { it.isNotEmpty() && it.length <= 8 }
            ?: "mp4"
        return "${upload.uploadId}.$extension"
    }

    /** Where one file goes. The upload's own URL wins, which is how per-file presigning works. */
    fun uploadUrlFor(upload: PublishUpload): String =
        expandUrl(upload.url ?: this.upload.url, upload.uploadId, fileNameFor(upload))

    /** The transport's parts and this file's own, the file's winning, in a stable order. */
    fun fieldsFor(upload: PublishUpload): Map<String, String> {
        val merged = LinkedHashMap<String, String>(this.upload.fields)
        merged.putAll(upload.fields)
        val fileName = fileNameFor(upload)
        return merged.mapValues { (_, value) -> expandField(value, upload.uploadId, fileName) }
    }

    /** The lookup URL for one upload, or null when the caller did not offer a template. */
    fun lookupUrlFor(uploadId: String): String? {
        val template = upload.lookupUrlTemplate ?: return null
        val fileName = uploadFor(uploadId)?.let { fileNameFor(it) } ?: ""
        return expandUrl(template, uploadId, fileName)
    }

    companion object {
        fun from(o: JSONObject): PublishRequest {
            // Empty, `.` or `..` ([JobFolders.batchIdRefusal]). This engine names a batch's record
            // `<safe id>.json`, which nothing climbs out of, but iOS files a batch's bodies and done
            // marker under names made from its id, where `.` and `..` would be some other batch's,
            // and a request one platform refuses is refused on every one.
            val batchId = o.optString("batchId")
            if (JobFolders.batchIdRefusal(batchId) != null) throw RequestException("invalid_request:batchId")

            val uploadsJson = o.optJSONArray("uploads")
                ?: throw RequestException("invalid_request:uploads")
            if (uploadsJson.length() == 0) throw RequestException("invalid_request:uploads")
            val uploads = (0 until uploadsJson.length()).map { i ->
                val entry = uploadsJson.optJSONObject(i)
                    ?: throw RequestException("invalid_request:uploads[$i]")
                PublishUpload.from(entry, "uploads[$i]")
            }

            return PublishRequest(
                batchId = batchId,
                headers = readStringMap(o.optJSONObject("headers")),
                upload = PublishTransport.from(o.optJSONObject("upload")),
                uploads = uploads,
                finalize = PublishFinalize.from(o.optJSONObject("finalize")),
            )
        }

        /** Percent-encoded, because it is going in a URL. */
        fun expandUrl(template: String, uploadId: String, fileName: String): String = template
            .replace("{uploadId}", encode(uploadId))
            .replace("{fileName}", encode(fileName))

        /** Left literal: a form field is not a URL. */
        fun expandField(value: String, uploadId: String, fileName: String): String = value
            .replace("{uploadId}", uploadId)
            .replace("{fileName}", fileName)

        /**
         * `encodeURIComponent`, to the character.
         *
         * Not `URLEncoder`, which is a form encoder: it writes a space as `+` and escapes `~`,
         * `!`, `'`, `(` and `)` that JavaScript leaves alone. A URL built one way on the phone and
         * the other in the browser is two different object keys, and with a presigned URL it is
         * also a broken signature - so the unreserved set is spelled out rather than borrowed.
         */
        private const val UNRESERVED = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"

        private fun encode(value: String): String {
            val out = StringBuilder(value.length)
            for (byte in value.toByteArray(Charsets.UTF_8)) {
                val char = (byte.toInt() and 0xFF).toChar()
                if (UNRESERVED.indexOf(char) >= 0) {
                    out.append(char)
                } else {
                    out.append('%').append("%02X".format(byte.toInt() and 0xFF))
                }
            }
            return out.toString()
        }
    }
}

data class UploadState(
    val uploadId: String,
    val tag: String,
    var status: UploadStatus = UploadStatus.QUEUED,
    var remoteId: RemoteId? = null,
    var httpStatus: Int? = null,
    var bytesSent: Long = 0L,
    var bytesTotal: Long = 0L,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("uploadId", uploadId)
        .put("tag", tag)
        .put("status", status.wire)
        .apply {
            remoteId?.let { put("remoteId", it.toJsonValue()) }
            httpStatus?.let { put("httpStatus", it) }
        }
        .put("bytesSent", bytesSent)
        .put("bytesTotal", bytesTotal)

    companion object {
        fun from(o: JSONObject): UploadState = UploadState(
            uploadId = o.optString("uploadId"),
            tag = o.optString("tag"),
            status = UploadStatus.from(o.optString("status")),
            remoteId = RemoteId.of(o.opt("remoteId")),
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
    val uploadId: String?,
    val retryable: Boolean,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("code", code)
        .put("message", message)
        .apply {
            httpStatus?.let { put("httpStatus", it) }
            uploadId?.let { put("uploadId", it) }
        }
        .put("phase", phase)
        .put("retryable", retryable)

    companion object {
        fun from(o: JSONObject): PublishFailure = PublishFailure(
            code = o.optString("code", FailureCodes.UNKNOWN),
            message = o.optString("message"),
            httpStatus = o.optInt("httpStatus", 0).takeIf { it > 0 },
            phase = o.optString("phase", "uploading"),
            uploadId = o.optString("uploadId").takeIf { it.isNotEmpty() },
            retryable = o.optBoolean("retryable", true),
        )
    }
}

data class PublishState(
    val batchId: String,
    var phase: Phase = Phase.QUEUED,
    var percent: Int = 0,
    var uploads: MutableList<UploadState> = mutableListOf(),
    /** The finalize response, parsed. Informational: nothing here reads it. */
    var result: Any? = null,
    var error: PublishFailure? = null,
    var attempts: Int = 0,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("batchId", batchId)
        .put("phase", phase.wire)
        .put("percent", percent)
        .put("uploads", JSONArray().apply { uploads.forEach { put(it.toJson()) } })
        .apply {
            result?.let { put("result", it) }
            error?.let { put("error", it.toJson()) }
        }
        .put("attempts", attempts)

    fun uploadFor(uploadId: String): UploadState? = uploads.firstOrNull { it.uploadId == uploadId }

    /**
     * Bytes-weighted, and capped at 95 until the finalize call has answered. Nothing reaches 100 on
     * the strength of the files alone, because "uploaded" is not "done" and showing otherwise would
     * be a lie the customer notices.
     */
    fun computePercent(liveBytes: Map<String, Long> = emptyMap()): Int {
        if (phase == Phase.DONE) return 100
        val total = uploads.sumOf { it.bytesTotal }
        if (total <= 0L) return percent.coerceIn(0, 95)
        val sent = uploads.sumOf { upload ->
            when {
                upload.status == UploadStatus.DONE -> upload.bytesTotal
                else -> maxOf(upload.bytesSent, liveBytes[upload.uploadId] ?: 0L)
            }
        }
        return ((sent.toDouble() / total.toDouble()) * 95.0).toInt().coerceIn(0, 95)
    }

    companion object {
        fun from(o: JSONObject): PublishState {
            val uploadsJson = o.optJSONArray("uploads") ?: JSONArray()
            return PublishState(
                batchId = o.optString("batchId"),
                phase = Phase.from(o.optString("phase")),
                percent = o.optInt("percent", 0),
                uploads = (0 until uploadsJson.length())
                    .mapNotNull { i -> uploadsJson.optJSONObject(i)?.let { UploadState.from(it) } }
                    .toMutableList(),
                result = o.opt("result"),
                error = o.optJSONObject("error")?.let { PublishFailure.from(it) },
                attempts = o.optInt("attempts", 0),
            )
        }

        fun initial(request: PublishRequest): PublishState = PublishState(
            batchId = request.batchId,
            phase = Phase.QUEUED,
            uploads = request.uploads
                .map { UploadState(it.uploadId, it.tag) }
                .toMutableList(),
        )
    }
}

/** One batch's whole record: what to do, and how far it got. */
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
        /** Bumped from 1: the request and state shapes changed when the backend coupling went. */
        const val VERSION = 2

        fun from(o: JSONObject): PublishEntry {
            // A version 1 record describes a transaction this code can no longer carry out - it
            // names fields that no longer exist. Refusing it here is what makes the store drop it,
            // which is the right outcome: the batch is re-queued by the caller rather than resumed
            // wrongly. Anything in flight across the upgrade is re-sent, not silently mangled.
            val version = o.optInt("version", 1)
            if (version != VERSION) throw RequestException("invalid_record:version=$version")
            return PublishEntry(
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
}
