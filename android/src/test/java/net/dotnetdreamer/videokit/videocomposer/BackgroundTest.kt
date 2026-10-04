package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The canvas colour off the wire, by the tints' rule: exactly three finite numbers, each held to
 * 0..1; absent or null is black; anything else that is there is refused as `background`. The same
 * cases as the browser's `readTint` and iOS's `rgb` reader.
 */
class BackgroundTest {

    private fun specJson(background: Any?): JSONObject {
        val json = JSONObject(
            """
            {
              "jobId": "job-1",
              "batchId": "post-1",
              "clips": [ { "key": "a", "uri": "file:///a.mp4", "inMs": 0, "outMs": 2000 } ],
              "output": { "width": 720, "height": 1280, "fps": 30, "videoBitrate": 4000000, "audioBitrate": 128000 },
              "filter": [],
              "overlays": [],
              "audio": { "originalMuted": false, "originalVolume": 1, "music": null, "voiceover": [] },
              "posterAtMs": 0
            }
            """.trimIndent(),
        )
        if (background != null) json.put("background", background)
        return json
    }

    private fun refused(background: Any): String {
        try {
            ComposeSpecParser.parse(specJson(background))
        } catch (e: SpecException) {
            return e.path
        }
        fail("expected a refusal")
        throw AssertionError()
    }

    @Test
    fun `no background, and a null one, is the black every post has had`() {
        assertNull(ComposeSpecParser.parse(specJson(null)).background)
        assertNull(ComposeSpecParser.parse(specJson(JSONObject.NULL)).background)
    }

    @Test
    fun `a background is three channels, each held to 0 to 1`() {
        val read = ComposeSpecParser.parse(specJson(JSONArray(listOf(1.5, 0.5, -1)))).background
        assertArrayEquals(floatArrayOf(1f, 0.5f, 0f), read, 0f)
    }

    @Test
    fun `anything else that is there is refused as background`() {
        assertEquals("background", refused("white"))
        assertEquals("background", refused(JSONArray(listOf(1, 1))))
        assertEquals("background", refused(JSONArray(listOf(1, 1, 1, 1))))
        assertEquals("background", refused(JSONArray(listOf(1, "x", 1))))
    }

    @Test
    fun `black needs no pass at all`() {
        assertTrue(BackgroundEffect.isBlack(null))
        assertTrue(BackgroundEffect.isBlack(floatArrayOf(0f, 0f, 0f)))
        assertFalse(BackgroundEffect.isBlack(floatArrayOf(1f, 1f, 1f)))
        assertFalse(BackgroundEffect.isBlack(floatArrayOf(0f, 0f, 0.1f)))
    }
}
