package net.dotnetdreamer.videokit.publisher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Reading the server's answer without knowing anything about the server.
 *
 * The caller says where its id lives, by a dotted path, and the JSON type of what is found has to
 * survive: a row id that left as `12` and comes back into the finalize body as `"12"` is a 400
 * from somebody's server, and nothing on this side would notice.
 */
class PublisherHttpTest {

    @Test
    fun `an id is read from wherever the caller said it lives`() {
        assertEquals("1234", PublisherHttp.parseRemoteId("""{"downloadId":1234}""", "downloadId")?.value)
        assertEquals("7", PublisherHttp.parseRemoteId("""{"data":{"id":7}}""", "data.id")?.value)
        assertEquals("abc", PublisherHttp.parseRemoteId("""{"id":"abc"}""", "id")?.value)
    }

    @Test
    fun `the JSON type of the id is kept, because the finalize body depends on it`() {
        val number = PublisherHttp.parseRemoteId("""{"id":12}""", "id")
        assertTrue(number!!.isNumber)
        assertEquals("12", number.toJsonLiteral())

        val text = PublisherHttp.parseRemoteId("""{"id":"12"}""", "id")
        assertFalse(text!!.isNumber)
        assertEquals(""""12"""", text.toJsonLiteral())
    }

    @Test
    fun `an id that is not there is null rather than guessed at`() {
        assertEquals(null, PublisherHttp.parseRemoteId("""{"downloadId":null}""", "downloadId"))
        assertEquals(null, PublisherHttp.parseRemoteId("""{"id":""}""", "id"))
        assertEquals(null, PublisherHttp.parseRemoteId("not json at all", "downloadId"))
        // The server answers JSON as text/plain, so an error body is a bare JSON string.
        assertEquals(null, PublisherHttp.parseRemoteId(""""Upload the video first."""", "downloadId"))
        // No path configured is the presigned case: the id never comes from the body.
        assertEquals(null, PublisherHttp.parseRemoteId("""{"downloadId":1}""", null))
    }

    @Test
    fun `a dotted path gives up on anything that is not an object`() {
        assertEquals(1, PublisherHttp.valueAt(PublisherHttp.parseJson("""{"a":{"b":1}}"""), "a.b"))
        assertEquals(null, PublisherHttp.valueAt(PublisherHttp.parseJson("""{"a":[1]}"""), "a.b"))
        assertEquals(null, PublisherHttp.valueAt(null, "a"))
    }

    @Test
    fun `a required path is checked only when the caller named one`() {
        assertTrue(PublisherHttp.hasValueAt("""{"postId":5}""", "postId"))
        assertFalse(PublisherHttp.hasValueAt("""{"postId":null}""", "postId"))
        assertFalse(PublisherHttp.hasValueAt("""{}""", "postId"))
        // Nothing named means nothing to check, which is the default for a server that uses codes.
        assertTrue(PublisherHttp.hasValueAt("", null))
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
