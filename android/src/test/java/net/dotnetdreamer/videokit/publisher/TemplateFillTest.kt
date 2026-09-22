package net.dotnetdreamer.videokit.publisher

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * The template is the caller's own JSON, filled in with ids that did not exist when it was
 * written. Getting this wrong means a body that either fails to parse server-side or quietly
 * references the wrong file, so the token handling is pinned down exactly.
 */
class TemplateFillTest {

    private fun upload(uploadId: String, tag: String, remoteId: RemoteId?) =
        UploadState(uploadId = uploadId, tag = tag, remoteId = remoteId)

    private fun number(value: Int) = RemoteId(value.toString(), isNumber = true)

    private val main = upload("u-main", "main", number(101))
    private val clipA = upload("u-a", "clip", number(102))
    private val clipB = upload("u-b", "clip", number(103))

    @Test
    fun `tokens become bare numbers and arrays, quotes and all`() {
        val template =
            """{"businessId":7,"video":"${'$'}ID:u-main","all":"${'$'}IDS","clips":"${'$'}IDS:clip"}"""
        val filled = TemplateFill.fill(template, listOf(main, clipA, clipB))

        assertEquals(
            """{"businessId":7,"video":101,"all":[101,102,103],"clips":[102,103]}""",
            filled,
        )
        // ...and the result is still valid JSON, which is the only thing the server cares about.
        val parsed = JSONObject(filled)
        assertEquals(101, parsed.getInt("video"))
        assertEquals(3, parsed.getJSONArray("all").length())
    }

    @Test
    fun `a string id stays a string, quoted and escaped`() {
        // The presigned case: the id is an object key, not a row number.
        val key = upload("u-1", "", RemoteId("""uploads/a"b.mp4""", isNumber = false))
        val filled = TemplateFill.fill("""{"key":"${'$'}ID:u-1"}""", listOf(key))
        assertEquals("""uploads/a"b.mp4""", JSONObject(filled).getString("key"))
    }

    @Test
    fun `a tag nothing carries becomes an empty array rather than a literal token`() {
        // The batch where the render failed and there are no clips to name. A literal
        // "${'$'}IDS:clip" reaching the server is a 400 with a baffling message.
        val filled = TemplateFill.fill("""{"video":"${'$'}ID:u-main","clips":"${'$'}IDS:clip"}""", listOf(main))
        assertEquals("""{"video":101,"clips":[]}""", filled)
        assertEquals(0, JSONObject(filled).getJSONArray("clips").length())
    }

    @Test
    fun `all ids come back in the order they were given`() {
        val filled = TemplateFill.fill("""{"ids":"${'$'}IDS"}""", listOf(main, clipA, clipB))
        assertEquals("""{"ids":[101,102,103]}""", filled)
    }

    @Test
    fun `customer text containing a dollar sign is left alone`() {
        // A title is customer-written and may contain anything at all.
        val template = """{"name":"Best ${'$'}5 pizza, ${'$'}IDX and ${'$'}IDSY","video":"${'$'}ID:u-main"}"""
        val filled = TemplateFill.fill(template, listOf(main))
        val parsed = JSONObject(filled)
        assertEquals("Best ${'$'}5 pizza, ${'$'}IDX and ${'$'}IDSY", parsed.getString("name"))
        assertEquals(101, parsed.getInt("video"))
    }

    @Test
    fun `a template with no tokens is returned unchanged`() {
        val template = """{"businessId":1,"ratings":[]}"""
        assertEquals(template, TemplateFill.fill(template, listOf(main)))
    }

    @Test
    fun `every occurrence is replaced, not just the first`() {
        val filled = TemplateFill.fill(
            """{"a":"${'$'}ID:u-main","b":"${'$'}ID:u-main"}""",
            listOf(main),
        )
        assertEquals("""{"a":101,"b":101}""", filled)
        assertTrue(!filled.contains("${'$'}ID:"))
    }

    @Test
    fun `a token naming nothing in the batch is left alone rather than guessed at`() {
        val template = """{"video":"${'$'}ID:typo"}"""
        assertEquals(template, TemplateFill.fill(template, listOf(main)))
    }
}
