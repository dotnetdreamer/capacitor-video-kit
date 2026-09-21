package net.dotnetdreamer.choisy.postpublisher

import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.MultipartBody
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.asRequestBody
import okio.Buffer
import okio.BufferedSink
import okio.ForwardingSink
import okio.Sink
import okio.buffer
import java.io.File

/**
 * The upload request, byte-compatible with what the web client sends.
 *
 * The field names and their order are not ours to choose - they are what the server's uploader
 * expects, and the filename is load-bearing: the server stores the file under the name without its
 * extension, which is what makes an upload findable by its guid afterwards.
 */
object MultipartBodies {

    fun uploadRequest(
        request: PublishRequest,
        upload: PublishUpload,
        file: File,
        onBytes: (Long) -> Unit,
    ): Request {
        val body = MultipartBody.Builder()
            .setType(MultipartBody.FORM)
            .addFormDataPart("qquuid", upload.uploadGuid)
            .addFormDataPart(
                "qqfile",
                fileNameFor(upload),
                // asRequestBody streams straight off disk with a known length, so a 100 MB video
                // never lands in memory and the request is not chunked.
                ProgressRequestBody(
                    file.asRequestBody(upload.mimeType.toMediaTypeOrNull()),
                    onBytes,
                ),
            )
            .addFormDataPart("qqfilename", fileNameFor(upload))
            .apply {
                upload.pictureId?.takeIf { it > 0 }?.let { addFormDataPart("pictureId", it.toString()) }
            }
            .build()

        return Request.Builder()
            .url(request.uploadUrl)
            .post(body)
            .apply { request.headers.forEach { (name, value) -> header(name, value) } }
            .build()
    }

    /** `<uploadGuid>.<ext>` - the server keys on the name without the extension. */
    fun fileNameFor(upload: PublishUpload): String {
        val extension = upload.path
            .substringBefore('?')
            .substringAfterLast('/')
            .substringAfterLast('.', "")
            .takeIf { it.isNotEmpty() && it.length <= 8 }
            ?: "mp4"
        return "${upload.uploadGuid}.$extension"
    }
}

/**
 * Counts bytes as they leave, so progress reflects what has actually been written rather than what
 * has been handed to the socket buffer. Wraps only the file part, so the small text fields do not
 * skew the count.
 */
class ProgressRequestBody(
    private val delegate: RequestBody,
    private val onBytes: (Long) -> Unit,
) : RequestBody() {

    override fun contentType() = delegate.contentType()

    override fun contentLength(): Long = delegate.contentLength()

    override fun writeTo(sink: BufferedSink) {
        // A retry or a redirect re-runs writeTo, so the counter starts again with it.
        val counting = object : ForwardingSink(sink) {
            private var written = 0L
            override fun write(source: Buffer, byteCount: Long) {
                super.write(source, byteCount)
                written += byteCount
                onBytes(written)
            }
        }
        val buffered = (counting as Sink).buffer()
        delegate.writeTo(buffered)
        buffered.flush()
    }
}
