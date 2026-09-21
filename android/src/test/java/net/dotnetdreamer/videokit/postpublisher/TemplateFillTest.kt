package net.dotnetdreamer.videokit.postpublisher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The template is the caller's own create-post JSON, filled in with ids that did not exist when it
 * was written. Getting this wrong means a post that either fails to parse server-side or quietly
 * references the wrong video, so the placeholder handling is pinned down exactly.
 */
class TemplateFillTest {

    @Test
    fun `placeholders become bare numbers and arrays, quotes and all`() {
        val template =
            """{"businessId":7,"downloadId":"${'$'}STITCHED","downloadIds":"${'$'}ALL","extra":"${'$'}ORIGINALS"}"""
        val filled = TemplateFill.fill(template, stitched = 101, originals = listOf(102, 103))

        assertEquals(
            """{"businessId":7,"downloadId":101,"downloadIds":[101,102,103],"extra":[102,103]}""",
            filled,
        )
        // ...and the result is still valid JSON, which is the only thing the server cares about.
        val parsed = JSONObject(filled)
        assertEquals(101, parsed.getInt("downloadId"))
        assertEquals(3, parsed.getJSONArray("downloadIds").length())
    }

    @Test
    fun `a post with only a stitched video gets an empty originals array`() {
        val template = """{"downloadId":"${'$'}STITCHED","downloadIds":"${'$'}ORIGINALS"}"""
        val filled = TemplateFill.fill(template, stitched = 9, originals = emptyList())
        assertEquals("""{"downloadId":9,"downloadIds":[]}""", filled)
        assertEquals(0, JSONObject(filled).getJSONArray("downloadIds").length())
    }

    @Test
    fun `all puts the stitched video first`() {
        val filled = TemplateFill.fill("""{"ids":"${'$'}ALL"}""", 5, listOf(6, 7))
        assertEquals("""{"ids":[5,6,7]}""", filled)
    }

    @Test
    fun `customer text containing a dollar sign is left alone`() {
        // A post title is customer-written and may contain anything at all.
        val template = """{"name":"Best ${'$'}5 pizza — ${'$'}STITCHEDX and ${'$'}ALLY","downloadId":"${'$'}STITCHED"}"""
        val filled = TemplateFill.fill(template, 42, emptyList())
        val parsed = JSONObject(filled)
        assertEquals("Best ${'$'}5 pizza — ${'$'}STITCHEDX and ${'$'}ALLY", parsed.getString("name"))
        assertEquals(42, parsed.getInt("downloadId"))
    }

    @Test
    fun `a template with no placeholders is returned unchanged`() {
        val template = """{"businessId":1,"ratings":[]}"""
        assertEquals(template, TemplateFill.fill(template, 1, listOf(2)))
    }

    @Test
    fun `every occurrence is replaced, not just the first`() {
        val filled = TemplateFill.fill(
            """{"a":"${'$'}STITCHED","b":"${'$'}STITCHED"}""",
            3,
            emptyList(),
        )
        assertEquals("""{"a":3,"b":3}""", filled)
        assertTrue(!filled.contains("STITCHED"))
    }
}
