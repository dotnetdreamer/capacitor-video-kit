package net.dotnetdreamer.choisy.postpublisher

import okio.Buffer
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.io.File

/**
 * The upload body has to match what the web client sends, byte for byte in the parts that matter.
 * The server keys on the filename (minus its extension) to find the upload again afterwards, so a
 * change here breaks recovery in a way nothing else would catch until a customer lost a post.
 */
class MultipartBodiesTest {

    @get:Rule
    val temp = TemporaryFolder()

    private fun request(uploadUrl: String = "https://example.com/api/download/asyncUpload") =
        PublishRequest(
            pendingPostId = "post-1",
            headers = mapOf("X-Token" to "abc123"),
            uploadUrl = uploadUrl,
            lookupUrlTemplate = null,
            uploads = emptyList(),
            createPost = CreatePost("https://example.com/create", "{}"),
        )

    private fun upload(
        guid: String = "0f6b1c2a",
        path: String = "file:///videos/clip.mp4",
        pictureId: Int? = null,
    ) = PublishUpload(guid, "stitched", path, "video/mp4", pictureId)

    private fun bodyText(file: File, upload: PublishUpload): String {
        val request = MultipartBodies.uploadRequest(request(), upload, file) { }
        val buffer = Buffer()
        request.body!!.writeTo(buffer)
        return buffer.readUtf8()
    }

    @Test
    fun `the parts are named and ordered the way the server expects`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(2048) { 7 }) }
        val body = bodyText(file, upload())

        val uuidAt = body.indexOf("""name="qquuid"""")
        val fileAt = body.indexOf("""name="qqfile"""")
        val nameAt = body.indexOf("""name="qqfilename"""")
        assertTrue("qquuid missing", uuidAt >= 0)
        assertTrue("qqfile missing", fileAt >= 0)
        assertTrue("qqfilename missing", nameAt >= 0)
        assertTrue("qquuid must come first", uuidAt < fileAt)
        assertTrue("qqfile must come before qqfilename", fileAt < nameAt)

        assertTrue(body.contains("0f6b1c2a"))
        assertTrue(body.contains("""filename="0f6b1c2a.mp4""""))
        assertTrue(body.contains("Content-Type: video/mp4"))
    }

    @Test
    fun `pictureId is sent only when there is one`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(16)) }
        assertTrue(!bodyText(file, upload()).contains("pictureId"))

        val withPicture = bodyText(file, upload(pictureId = 42))
        assertTrue(withPicture.contains("""name="pictureId""""))
        assertTrue(withPicture.contains("42"))
    }

    @Test
    fun `the uploaded filename is the guid plus the source extension`() {
        assertEquals("g1.mp4", MultipartBodies.fileNameFor(upload("g1", "file:///a/b/clip.mp4")))
        assertEquals("g1.m4a", MultipartBodies.fileNameFor(upload("g1", "file:///a/voice.m4a")))
        // No extension at all, or something implausible, falls back rather than producing rubbish.
        assertEquals("g1.mp4", MultipartBodies.fileNameFor(upload("g1", "file:///a/noextension")))
        assertEquals(
            "g1.mp4",
            MultipartBodies.fileNameFor(upload("g1", "file:///a/weird.thisisnotanextension")),
        )
        // A directory further up carrying a dot must not be mistaken for the extension.
        assertEquals("g1.mp4", MultipartBodies.fileNameFor(upload("g1", "file:///a.b/clip")))
    }

    @Test
    fun `the auth header is on the request`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(16)) }
        val built = MultipartBodies.uploadRequest(request(), upload(), file) { }
        assertEquals("abc123", built.header("X-Token"))
        assertEquals("https://example.com/api/download/asyncUpload", built.url.toString())
    }

    @Test
    fun `the body streams off disk with a known length`() {
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(5000) { 1 }) }
        val built = MultipartBodies.uploadRequest(request(), upload(), file) { }
        // A known length means no chunked encoding, and no copy of the file in memory.
        assertTrue(built.body!!.contentLength() > 5000)
    }

    @Test
    fun `progress is reported monotonically and ends at the file size`() {
        val size = 300_000
        val file = temp.newFile("clip.mp4").apply { writeBytes(ByteArray(size) { 3 }) }
        val seen = mutableListOf<Long>()
        val built = MultipartBodies.uploadRequest(request(), upload(), file) { seen += it }
        built.body!!.writeTo(Buffer())

        assertTrue("no progress reported", seen.isNotEmpty())
        assertEquals(seen.sorted(), seen)
        // The counter wraps the file part only, so the last value is the file's own size.
        assertEquals(size.toLong(), seen.last())
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a download id is read out of the response`() {
        assertEquals(1234, PublisherHttp.parseDownloadId("""{"downloadId":1234,"pictureId":5}"""))
        assertEquals(null, PublisherHttp.parseDownloadId("""{"downloadId":0}"""))
        assertEquals(null, PublisherHttp.parseDownloadId("not json at all"))
        // The server answers JSON as text/plain, so an error body is a bare JSON string.
        assertEquals(null, PublisherHttp.parseDownloadId(""""Upload the video first.""""))
    }

    @Test
    fun `a created post is read out of the response`() {
        val created = PublisherHttp.parseCreatedPost("""{"postId":88,"published":false,"slug":"x"}""")
        assertEquals(88, created?.postId)
        assertEquals(false, created?.published)
        assertEquals(null, PublisherHttp.parseCreatedPost("""{"postId":0}"""))
    }

    @Test
    fun `an error body is unwrapped from its quotes`() {
        assertEquals("Upload the video first.", PublisherHttp.errorMessage(""""Upload the video first.""""))
        assertEquals("plain text", PublisherHttp.errorMessage("  plain text  "))
        assertEquals("no response body", PublisherHttp.errorMessage(""))
        // An object body is kept as-is; it is for a developer to read, not a customer.
        val json = JSONObject().put("message", "nope").toString()
        assertEquals(json, PublisherHttp.errorMessage(json))
    }
}
