package net.dotnetdreamer.videokit.publisher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The record has to survive the app being killed and be read back by a worker with no JavaScript
 * anywhere, so the round-trip is the contract - including the auth header, without which a resumed
 * upload would be rejected, and including the field names, without which the request could not be
 * rebuilt at all.
 */
class PublishModelsTest {

    private fun requestJson(): JSONObject = JSONObject(
        """
        {
          "batchId": "batch-1",
          "headers": { "X-Token": "abc123" },
          "upload": {
            "url": "https://example.com/api/download/asyncUpload",
            "method": "POST",
            "fileField": "qqfile",
            "fields": { "qquuid": "{uploadId}", "qqfilename": "{fileName}" },
            "idPath": "downloadId",
            "lookupUrlTemplate": "https://example.com/api/download/byName/{uploadId}"
          },
          "uploads": [
            { "uploadId": "g1", "tag": "main", "path": "file:///a/main.mp4",
              "mimeType": "video/mp4", "fields": { "pictureId": "5" } },
            { "uploadId": "g2", "tag": "clip", "path": "file:///a/clip-1.mp4",
              "mimeType": "video/mp4" }
          ],
          "finalize": { "url": "https://example.com/api/Post/CreateContentPost",
                        "bodyTemplate": "{\"video\":\"${'$'}ID:g1\"}",
                        "requirePath": "postId" }
        }
        """.trimIndent(),
    )

    @Test
    fun `a request round-trips through json with its headers and field names intact`() {
        val original = PublishRequest.from(requestJson())
        val restored = PublishRequest.from(original.toJson())

        assertEquals("batch-1", restored.batchId)
        // The token has to survive: a resumed upload has no other way to authenticate.
        assertEquals("abc123", restored.headers["X-Token"])
        // So do the field names: the request cannot be rebuilt from a guess about the server.
        assertEquals("qqfile", restored.upload.fileField)
        assertEquals("{uploadId}", restored.upload.fields["qquuid"])
        assertEquals("downloadId", restored.upload.idPath)
        assertEquals(2, restored.uploads.size)
        assertEquals("main", restored.uploads[0].tag)
        assertEquals("5", restored.uploads[0].fields["pictureId"])
        assertTrue(restored.uploads[1].fields.isEmpty())
        assertEquals(original.finalize.bodyTemplate, restored.finalize.bodyTemplate)
        assertEquals("postId", restored.finalize.requirePath)
    }

    @Test
    fun `the defaults are the ones a caller who says nothing should get`() {
        val json = requestJson().apply {
            getJSONObject("upload").remove("method")
            getJSONObject("upload").remove("fileField")
            getJSONObject("finalize").remove("method")
            getJSONArray("uploads").getJSONObject(1).remove("tag")
        }
        val request = PublishRequest.from(json)
        assertEquals(UploadMethod.POST, request.upload.method)
        assertEquals(DEFAULT_FILE_FIELD, request.upload.fileField)
        assertEquals(UploadMethod.POST, request.finalize.method)
        assertEquals("", request.uploads[1].tag)
    }

    @Test
    fun `the lookup url is built from the template`() {
        val request = PublishRequest.from(requestJson())
        assertEquals("https://example.com/api/download/byName/g1", request.lookupUrlFor("g1"))
    }

    @Test
    fun `without a template there is no lookup url`() {
        val json = requestJson().apply { getJSONObject("upload").remove("lookupUrlTemplate") }
        assertNull(PublishRequest.from(json).lookupUrlFor("g1"))
    }

    @Test
    fun `the fields a file is sent with are the transport's and its own, its own winning`() {
        val request = PublishRequest.from(requestJson())
        val fields = request.fieldsFor(request.uploads[0])
        assertEquals("g1", fields["qquuid"])
        assertEquals("g1.mp4", fields["qqfilename"])
        assertEquals("5", fields["pictureId"])
    }

    @Test
    fun `a request missing something essential is rejected with its path`() {
        expectInvalid("invalid_request:batchId") { remove("batchId") }
        expectInvalid("invalid_request:upload") { remove("upload") }
        expectInvalid("invalid_request:upload.url") { getJSONObject("upload").remove("url") }
        expectInvalid("invalid_request:upload.method") { getJSONObject("upload").put("method", "PATCH") }
        expectInvalid("invalid_request:uploads") { remove("uploads") }
        expectInvalid("invalid_request:finalize") { remove("finalize") }
        expectInvalid("invalid_request:finalize.bodyTemplate") { getJSONObject("finalize").remove("bodyTemplate") }
        expectInvalid("invalid_request:uploads[0].uploadId") {
            getJSONArray("uploads").getJSONObject(0).remove("uploadId")
        }
        expectInvalid("invalid_request:uploads[1].path") {
            getJSONArray("uploads").getJSONObject(1).remove("path")
        }
    }

    @Test
    fun `any tag at all is accepted, because the plugin never interprets one`() {
        val json = requestJson().apply {
            getJSONArray("uploads").getJSONObject(0).put("tag", "sideways")
        }
        assertEquals("sideways", PublishRequest.from(json).uploads[0].tag)
    }

    private fun expectInvalid(message: String, mutate: JSONObject.() -> Unit) {
        try {
            PublishRequest.from(requestJson().apply(mutate))
            fail("expected $message")
        } catch (e: RequestException) {
            assertEquals(message, e.message)
        }
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a whole entry round-trips`() {
        val request = PublishRequest.from(requestJson())
        val state = PublishState.initial(request).apply {
            phase = Phase.UPLOADING
            attempts = 2
            uploads[0].remoteId = RemoteId("77", isNumber = true)
            uploads[0].status = UploadStatus.DONE
            uploads[0].bytesTotal = 1_000
            uploads[0].bytesSent = 1_000
            uploads[1].bytesTotal = 1_000
        }
        val entry = PublishEntry(request, state, acked = false, createdAt = 10, updatedAt = 20)
        val restored = PublishEntry.from(JSONObject(entry.toJson().toString()))

        assertEquals(Phase.UPLOADING, restored.state.phase)
        assertEquals(2, restored.state.attempts)
        assertEquals("77", restored.state.uploadFor("g1")?.remoteId?.value)
        assertEquals(true, restored.state.uploadFor("g1")?.remoteId?.isNumber)
        assertEquals(UploadStatus.DONE, restored.state.uploadFor("g1")?.status)
        assertNull(restored.state.uploadFor("g2")?.remoteId)
        assertEquals(10L, restored.createdAt)
    }

    @Test
    fun `a string id survives the record as a string`() {
        val request = PublishRequest.from(requestJson())
        val state = PublishState.initial(request).apply {
            uploads[0].remoteId = RemoteId("uploads/2026/a.mp4", isNumber = false)
        }
        val restored = PublishState.from(JSONObject(state.toJson().toString()))
        val id = restored.uploadFor("g1")?.remoteId
        assertEquals("uploads/2026/a.mp4", id?.value)
        assertEquals(false, id?.isNumber)
    }

    @Test
    fun `a record from the old shape is refused rather than half understood`() {
        // Version 1 named fields that no longer exist. Refusing it makes the store drop it, and
        // the batch is re-queued by the caller rather than resumed wrongly.
        val entry = PublishEntry(
            PublishRequest.from(requestJson()),
            PublishState.initial(PublishRequest.from(requestJson())),
            acked = false,
            createdAt = 1,
            updatedAt = 2,
        )
        val old = JSONObject(entry.toJson().toString()).put("version", 1)
        try {
            PublishEntry.from(old)
            fail("expected a version refusal")
        } catch (e: RequestException) {
            assertEquals("invalid_record:version=1", e.message)
        }
    }

    @Test
    fun `a failure round-trips including whether it is worth retrying`() {
        val request = PublishRequest.from(requestJson())
        val state = PublishState.initial(request).apply {
            phase = Phase.FAILED
            error = PublishFailure("auth", "token expired", 401, "uploading", "g1", true)
        }
        val restored = PublishState.from(JSONObject(state.toJson().toString()))
        val error = restored.error
        assertNotNull(error)
        assertEquals("auth", error!!.code)
        assertEquals(401, error.httpStatus)
        assertEquals("uploading", error.phase)
        assertTrue(error.retryable)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `percent is weighted by bytes, not by file count`() {
        val request = PublishRequest.from(requestJson())
        val state = PublishState.initial(request).apply {
            phase = Phase.UPLOADING
            // One big file and one small one: finishing the small one is not half the job.
            uploads[0].bytesTotal = 9_000
            uploads[1].bytesTotal = 1_000
            uploads[1].status = UploadStatus.DONE
        }
        // 1000 of 10000 bytes, against a ceiling of 95.
        assertEquals(9, state.computePercent())
    }

    @Test
    fun `percent never reaches 100 until the finalize call has answered`() {
        val request = PublishRequest.from(requestJson())
        val state = PublishState.initial(request).apply {
            phase = Phase.UPLOADING
            uploads.forEach {
                it.bytesTotal = 1_000
                it.status = UploadStatus.DONE
            }
        }
        // Every byte is up, but "uploaded" is not "done".
        assertEquals(95, state.computePercent())

        state.phase = Phase.DONE
        assertEquals(100, state.computePercent())
    }

    @Test
    fun `live byte counters move the percentage between record writes`() {
        val request = PublishRequest.from(requestJson())
        val state = PublishState.initial(request).apply {
            phase = Phase.UPLOADING
            uploads.forEach { it.bytesTotal = 1_000 }
        }
        assertEquals(0, state.computePercent())
        assertEquals(47, state.computePercent(mapOf("g1" to 1_000L)))
    }

    @Test
    fun `an unknown phase in a stored record reads as queued rather than throwing`() {
        // Forward compatibility: a record written by a newer build must not wedge an older one.
        assertEquals(Phase.QUEUED, Phase.from("teleporting"))
        assertEquals(UploadStatus.QUEUED, UploadStatus.from(null))
    }
}
