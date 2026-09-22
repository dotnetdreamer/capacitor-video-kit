package net.dotnetdreamer.videokit.publisher

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
 * The upload request, in the two shapes bytes travel in.
 *
 * `PUT` sends the file and nothing else, with its own content type - which is what a presigned URL
 * is signed for, and why wrapping it in an envelope there would break the signature. `POST` builds
 * the multipart form the transport describes: the caller's text parts first, in the order given,
 * then the file last, which is the order a streaming parser wants since it can read every small
 * field before it has to decide what to do with a large one.
 *
 * No field name is chosen here. They come out of the request, because a server's upload convention
 * is the server's business and this plugin has no way to ask about it hours later in a process the
 * caller's code is not running in.
 */
object UploadRequests {

    fun build(
        request: PublishRequest,
        upload: PublishUpload,
        file: File,
        onBytes: (Long) -> Unit,
    ): Request {
        // asRequestBody streams straight off disk with a known length, so a 100 MB video never
        // lands in memory and the request is not chunked.
        val fileBody = ProgressRequestBody(
            file.asRequestBody(upload.mimeType.toMediaTypeOrNull()),
            onBytes,
        )

        val body: RequestBody = when (request.upload.method) {
            UploadMethod.PUT -> fileBody
            UploadMethod.POST -> MultipartBody.Builder()
                .setType(MultipartBody.FORM)
                .apply {
                    request.fieldsFor(upload).forEach { (name, value) -> addFormDataPart(name, value) }
                }
                .addFormDataPart(request.upload.fileField, request.fileNameFor(upload), fileBody)
                .build()
        }

        val builder = Request.Builder()
            .url(request.uploadUrlFor(upload))
            .apply { request.headers.forEach { (name, value) -> header(name, value) } }

        return when (request.upload.method) {
            UploadMethod.PUT -> builder.put(body).build()
            UploadMethod.POST -> builder.post(body).build()
        }
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
