package net.dotnetdreamer.videokit.publisher

import okio.Buffer
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The upload body has to match what the web client sends, byte for byte in the parts that matter,
 * and both have to build it out of the caller's own field names rather than any this plugin picked.
 * A change here breaks recovery in a way nothing else would catch until a customer lost a batch.
 */
class UploadRequestsTest {

    @get:Rule
    val temp = TemporaryFolder()

    /** A transport shaped like Fine Uploader's, which is the convention this used to hard-code. */
    private fun fineUploader(url: String = "https://example.com/api/download/asyncUpload") =
        PublishTransport(
            url = url,
            method = UploadMethod.POST,
            fileField = "qqfile",
            fields = linkedMapOf("qquuid" to "{uploadId}", "qqfilename" to "{fileName}"),
            idPath = "downloadId",
            lookupUrlTemplate = null,
        )

    private fun request(
        transport: PublishTransport = fineUploader(),
        uploads: List<PublishUpload> = emptyList(),
    ) = PublishRequest(
        batchId = "batch-1",
        headers = mapOf("X-Token" to "abc123"),
        upload = transport,
        uploads = uploads,
        finalize = PublishFinalize("https://example.com/create", UploadMethod.POST, "{}", null),
    )

    private fun upload(
        id: String = "0f6b1c2a",
        path: String = "file:///videos/clip.mp4",
        fields: Map<String, String> = emptyMap(),
        url: String? = null,
    ) = PublishUpload(id, "main", path, "video/mp4", url, null, fields)

    private fun bodyText(file: File, upload: PublishUpload, transport: PublishTransport = fineUploader()): String {
        val built = UploadRequests.build(request(transport), upload, file) { }
        val buffer = Buffer()
        built.body!!.writeTo(buffer)
        return buffer.readUtf8()
    }

    @Test
    fun `the multipart parts are the caller's, with the file last`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(2048) { 7 }) }
        val body = bodyText(file, upload())

        val uuidAt = body.indexOf("""name="qquuid"""")
        val nameAt = body.indexOf("""name="qqfilename"""")
        val fileAt = body.indexOf("""name="qqfile"""")
        assertTrue("qquuid missing", uuidAt >= 0)
        assertTrue("qqfilename missing", nameAt >= 0)
        assertTrue("qqfile missing", fileAt >= 0)
        assertTrue("the text parts keep the order they were given", uuidAt < nameAt)
        assertTrue("the file goes last, so a streaming parser reads every field first", nameAt < fileAt)

        // The placeholders are expanded, and left literal because a field is not a URL.
        assertTrue(body.contains("0f6b1c2a"))
        assertTrue(body.contains("""filename="0f6b1c2a.mp4""""))
        assertTrue(body.contains("Content-Type: video/mp4"))
    }

    @Test
    fun `a per-file field is merged over the transport's`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(16)) }
        assertTrue(!bodyText(file, upload()).contains("pictureId"))

        val withExtra = bodyText(file, upload(fields = mapOf("pictureId" to "42")))
        assertTrue(withExtra.contains("""name="pictureId""""))
        assertTrue(withExtra.contains("42"))
    }

    @Test
    fun `PUT sends the bytes and nothing else, for a presigned URL`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(64) { 9 }) }
        val transport = PublishTransport(
            url = "https://bucket.r2.test/{uploadId}",
            method = UploadMethod.PUT,
            fileField = DEFAULT_FILE_FIELD,
            fields = emptyMap(),
            idPath = null,
            lookupUrlTemplate = null,
        )
        val built = UploadRequests.build(request(transport), upload(), file) { }

        assertEquals("PUT", built.method)
        assertEquals("https://bucket.r2.test/0f6b1c2a", built.url.toString())
        // No envelope at all: the body is the file, so a signature over it still verifies.
        assertEquals(file.length(), built.body!!.contentLength())
        assertEquals("video/mp4", built.body!!.contentType().toString())
    }

    @Test
    fun `one file's own URL wins over the transport's`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(16)) }
        val signed = upload(url = "https://bucket.r2.test/put?sig=abc")
        val built = UploadRequests.build(request(), signed, file) { }
        assertEquals("https://bucket.r2.test/put?sig=abc", built.url.toString())
    }

    @Test
    fun `the uploaded filename is the upload id plus the source extension`() {
        val r = request()
        assertEquals("g1.mp4", r.fileNameFor(upload("g1", "file:///a/b/clip.mp4")))
        assertEquals("g1.m4a", r.fileNameFor(upload("g1", "file:///a/voice.m4a")))
        // No extension at all, or something implausible, falls back rather than producing rubbish.
        assertEquals("g1.mp4", r.fileNameFor(upload("g1", "file:///a/noextension")))
        assertEquals("g1.mp4", r.fileNameFor(upload("g1", "file:///a/weird.thisisnotanextension")))
        // A directory further up carrying a dot must not be mistaken for the extension.
        assertEquals("g1.mp4", r.fileNameFor(upload("g1", "file:///a.b/clip")))
    }

    @Test
    fun `a URL placeholder is percent-encoded the way encodeURIComponent does it`() {
        // Not URLEncoder: a space is %20 and not +, and ~ ! ' ( ) are left alone, or a URL built
        // on the phone and one built in the browser are two different object keys.
        assertEquals("a%2Fb", PublishRequest.expandUrl("{uploadId}", "a/b", ""))
        assertEquals("a%20b", PublishRequest.expandUrl("{uploadId}", "a b", ""))
        assertEquals("a~b!c'd(e)", PublishRequest.expandUrl("{uploadId}", "a~b!c'd(e)", ""))
    }

    @Test
    fun `the auth header is on the request`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(16)) }
        val built = UploadRequests.build(request(), upload(), file) { }
        assertEquals("abc123", built.header("X-Token"))
        assertEquals("https://example.com/api/download/asyncUpload", built.url.toString())
    }

    @Test
    fun `the body streams off disk with a known length`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(5000) { 1 }) }
        val built = UploadRequests.build(request(), upload(), file) { }
        // A known length means no chunked encoding, and no copy of the file in memory.
        assertTrue(built.body!!.contentLength() > 5000)
    }

    @Test
    fun `progress is reported monotonically and ends at the file size`() {
        val size = 300_000
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(size) { 3 }) }
        val seen = mutableListOf<Long>()
        val built = UploadRequests.build(request(), upload(), file) { seen += it }
        built.body!!.writeTo(Buffer())

        assertTrue("no progress reported", seen.isNotEmpty())
        assertEquals(seen.sorted(), seen)
        // The counter wraps the file part only, so the last value is the file's own size.
        assertEquals(size.toLong(), seen.last())
    }
}
