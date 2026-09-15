package net.dotnetdreamer.choisy.videocomposer

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The line between "this spec is broken, fail the call" and "this value is odd, clamp it".
 *
 * Shape errors are the caller's bug and must be loud, with the JSON path that broke. Out-of-range
 * values are not worth failing a post over - a slightly different render beats no post at all.
 */
class ComposeSpecParserTest {

    private fun minimalJson(): JSONObject = JSONObject(
        """
        {
          "jobId": "job-1",
          "pendingPostId": "post-1",
          "clips": [
            { "key": "a", "uri": "file:///a.mp4", "inMs": 0, "outMs": 2000,
              "speed": 1, "volume": 1, "muted": false, "fit": "contain" }
          ],
          "output": { "width": 720, "height": 1280, "fps": 30,
                      "videoBitrate": 4000000, "audioBitrate": 128000 },
          "filter": [],
          "overlays": [],
          "audio": { "originalMuted": false, "originalVolume": 1, "music": null, "voiceover": [] },
          "posterAtMs": 0
        }
        """.trimIndent(),
    )

    private fun expectInvalid(path: String, mutate: JSONObject.() -> Unit) {
        val json = minimalJson().apply(mutate)
        try {
            ComposeSpecParser.parse(json)
            fail("expected invalid_spec:$path")
        } catch (e: SpecException) {
            assertEquals(path, e.path)
        }
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `a minimal spec round-trips`() {
        val spec = ComposeSpecParser.parse(minimalJson())
        assertEquals("job-1", spec.jobId)
        assertEquals("post-1", spec.pendingPostId)
        assertEquals(1, spec.clips.size)
        assertEquals("a", spec.clips[0].key)
        assertEquals(720, spec.output.width)
        assertNull(spec.audio.music)
        assertTrue(spec.audio.voiceover.isEmpty())
    }

    @Test
    fun `missing identifiers are rejected with their path`() {
        expectInvalid("jobId") { remove("jobId") }
        expectInvalid("pendingPostId") { remove("pendingPostId") }
    }

    @Test
    fun `a spec with no clips is rejected`() {
        expectInvalid("clips") { remove("clips") }
        expectInvalid("clips") { put("clips", org.json.JSONArray()) }
    }

    @Test
    fun `a clip with an end before its start is rejected`() {
        expectInvalid("clips[0].outMs") {
            getJSONArray("clips").getJSONObject(0).put("outMs", 0)
        }
    }

    @Test
    fun `a clip without a uri is rejected`() {
        expectInvalid("clips[0].uri") {
            getJSONArray("clips").getJSONObject(0).remove("uri")
        }
    }

    @Test
    fun `a zero-sized or unpaced output is rejected`() {
        expectInvalid("output.width") { getJSONObject("output").put("width", 0) }
        expectInvalid("output.fps") { getJSONObject("output").put("fps", 0) }
        expectInvalid("output.videoBitrate") { getJSONObject("output").put("videoBitrate", 0) }
    }

    @Test
    fun `odd output dimensions are rounded down because H264 refuses them`() {
        val json = minimalJson().apply {
            getJSONObject("output").put("width", 721).put("height", 1281)
        }
        val spec = ComposeSpecParser.parse(json)
        assertEquals(720, spec.output.width)
        assertEquals(1280, spec.output.height)
    }

    @Test
    fun `speed volume and opacity are clamped rather than rejected`() {
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("speed", 99).put("volume", 4)
        }
        val spec = ComposeSpecParser.parse(json)
        assertEquals(ComposeSpecParser.MAX_SPEED, spec.clips[0].speed, 1e-6f)
        assertEquals(1f, spec.clips[0].volume, 1e-6f)

        val slow = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("speed", 0.01).put("volume", -3)
        }
        val slowSpec = ComposeSpecParser.parse(slow)
        assertEquals(ComposeSpecParser.MIN_SPEED, slowSpec.clips[0].speed, 1e-6f)
        assertEquals(0f, slowSpec.clips[0].volume, 1e-6f)
    }

    @Test
    fun `fit defaults to contain and reads cover`() {
        assertEquals(Fit.CONTAIN, ComposeSpecParser.parse(minimalJson()).clips[0].fit)
        val cover = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("fit", "cover")
        }
        assertEquals(Fit.COVER, ComposeSpecParser.parse(cover).clips[0].fit)
        val nonsense = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("fit", "squish")
        }
        assertEquals(Fit.CONTAIN, ComposeSpecParser.parse(nonsense).clips[0].fit)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `every filter op parses`() {
        val json = minimalJson().apply {
            put(
                "filter",
                org.json.JSONArray(
                    """
                    [ { "op": "brightness", "amount": 1.03 },
                      { "op": "contrast", "amount": 0.9 },
                      { "op": "saturate", "amount": 1.15 },
                      { "op": "sepia", "amount": 0.2 },
                      { "op": "grayscale", "amount": 1 },
                      { "op": "hueRotate", "degrees": 90 },
                      { "op": "tint", "rgb": [255, 168, 72], "alpha": 0.1 } ]
                    """.trimIndent(),
                ),
            )
        }
        val spec = ComposeSpecParser.parse(json)
        assertEquals(7, spec.filter.size)
        assertTrue(spec.filter[0] is FilterOp.Brightness)
        val tint = spec.filter[6] as FilterOp.Tint
        assertEquals(255, tint.r)
        assertEquals(0.1f, tint.alpha, 1e-6f)
    }

    @Test
    fun `an unknown filter op is rejected`() {
        expectInvalid("filter[0].op") {
            put("filter", org.json.JSONArray("""[ { "op": "bloom", "amount": 1 } ]"""))
        }
    }

    @Test
    fun `sepia and grayscale amounts are clamped to nought and one`() {
        val json = minimalJson().apply {
            put("filter", org.json.JSONArray("""[ { "op": "grayscale", "amount": 5 } ]"""))
        }
        val op = ComposeSpecParser.parse(json).filter[0] as FilterOp.Grayscale
        assertEquals(1f, op.amount, 1e-6f)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `an overlay that is not a png data url is rejected`() {
        expectInvalid("overlays[0].png") {
            put(
                "overlays",
                org.json.JSONArray(
                    """
                    [ { "id": "o", "png": "https://example.com/a.png", "cx": 0.5, "cy": 0.5,
                        "wPx": 10, "hPx": 10, "rotationDeg": 0, "startMs": 0, "endMs": 100,
                        "opacity": 1 } ]
                    """.trimIndent(),
                ),
            )
        }
    }

    @Test
    fun `an overlay window that ends before it starts is rejected`() {
        expectInvalid("overlays[0].endMs") {
            put(
                "overlays",
                org.json.JSONArray(
                    """
                    [ { "id": "o", "png": "data:image/png;base64,AA", "cx": 0.5, "cy": 0.5,
                        "wPx": 10, "hPx": 10, "rotationDeg": 0, "startMs": 500, "endMs": 100,
                        "opacity": 1 } ]
                    """.trimIndent(),
                ),
            )
        }
    }

    @Test
    fun `too many overlays are rejected`() {
        val many = org.json.JSONArray()
        repeat(ComposeSpecParser.MAX_OVERLAYS + 1) { i ->
            many.put(
                JSONObject()
                    .put("id", "o$i")
                    .put("png", "data:image/png;base64,AA")
                    .put("cx", 0.5).put("cy", 0.5)
                    .put("wPx", 10).put("hPx", 10)
                    .put("rotationDeg", 0).put("startMs", 0).put("endMs", 100)
                    .put("opacity", 1),
            )
        }
        expectInvalid("overlays") { put("overlays", many) }
    }

    @Test
    fun `overlay centres are clamped into the frame`() {
        val json = minimalJson().apply {
            put(
                "overlays",
                org.json.JSONArray(
                    """
                    [ { "id": "o", "png": "data:image/png;base64,AA", "cx": 1.8, "cy": -0.4,
                        "wPx": 10, "hPx": 10, "rotationDeg": 400, "startMs": 0, "endMs": 100,
                        "opacity": 3 } ]
                    """.trimIndent(),
                ),
            )
        }
        val overlay = ComposeSpecParser.parse(json).overlays[0]
        assertEquals(1f, overlay.cx, 1e-6f)
        assertEquals(0f, overlay.cy, 1e-6f)
        assertEquals(1f, overlay.opacity, 1e-6f)
        // Rotation is deliberately NOT clamped - 400 degrees is just 40 degrees.
        assertEquals(400f, overlay.rotationDeg, 1e-6f)
    }

    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `music and voiceovers parse`() {
        val json = minimalJson().apply {
            put(
                "audio",
                JSONObject(
                    """
                    { "originalMuted": true, "originalVolume": 0.5,
                      "music": { "uri": "file:///m.m4a", "startMs": 100, "inMs": 0, "outMs": 5000,
                                 "volume": 0.6, "loop": true, "fadeInMs": 0, "fadeOutMs": 400 },
                      "voiceover": [ { "uri": "file:///v.m4a", "startMs": 200,
                                       "durationMs": 1500, "volume": 0.9 } ] }
                    """.trimIndent(),
                ),
            )
        }
        val audio = ComposeSpecParser.parse(json).audio
        assertTrue(audio.originalMuted)
        assertEquals(0.5f, audio.originalVolume, 1e-6f)
        assertEquals(true, audio.music!!.loop)
        assertEquals(400L, audio.music!!.fadeOutMs)
        assertEquals(1, audio.voiceover.size)
        assertEquals(1500L, audio.voiceover[0].durationMs)
    }

    @Test
    fun `a missing audio block is treated as unedited sound`() {
        val json = minimalJson().apply { remove("audio") }
        val audio = ComposeSpecParser.parse(json).audio
        assertEquals(false, audio.originalMuted)
        assertEquals(1f, audio.originalVolume, 1e-6f)
        assertNull(audio.music)
    }

    @Test
    fun `a music trim that ends before it starts is rejected`() {
        expectInvalid("audio.music.outMs") {
            put(
                "audio",
                JSONObject(
                    """
                    { "originalMuted": false, "originalVolume": 1,
                      "music": { "uri": "file:///m.m4a", "startMs": 0, "inMs": 5000, "outMs": 1000,
                                 "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0 },
                      "voiceover": [] }
                    """.trimIndent(),
                ),
            )
        }
    }
}
