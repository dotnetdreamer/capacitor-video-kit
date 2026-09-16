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

    @Test
    fun `a clip with no crop and no rect keeps both absent`() {
        // The engines' fast paths test for null, so this is the back-compatibility promise itself:
        // a manifest written before the fields existed must not come out of here carrying them.
        val spec = ComposeSpecParser.parse(minimalJson())
        assertNull(spec.clips[0].crop)
        assertNull(spec.clips[0].rect)
        val explicitNull = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("crop", JSONObject.NULL)
        }
        assertNull(ComposeSpecParser.parse(explicitNull).clips[0].crop)
    }

    @Test
    fun `crop and rect parse`() {
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0)
                .put("crop", rectJson(0.25, 0.1, 0.5, 0.8))
                .put("rect", rectJson(0.0, 0.0, 1.0, 0.5))
        }
        val clip = ComposeSpecParser.parse(json).clips[0]
        assertEquals(0.25f, clip.crop!!.x, 1e-6f)
        assertEquals(0.1f, clip.crop!!.y, 1e-6f)
        assertEquals(0.5f, clip.crop!!.w, 1e-6f)
        assertEquals(0.8f, clip.crop!!.h, 1e-6f)
        assertEquals(0.5f, clip.rect!!.h, 1e-6f)
    }

    @Test
    fun `a rectangle with no area is rejected with its own path`() {
        expectInvalid("clips[0].crop.w") {
            getJSONArray("clips").getJSONObject(0).put("crop", rectJson(0.0, 0.0, 0.0, 1.0))
        }
        expectInvalid("clips[0].crop.h") {
            getJSONArray("clips").getJSONObject(0).put("crop", rectJson(0.0, 0.0, 1.0, -0.5))
        }
        expectInvalid("clips[0].rect.h") {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(0.0, 0.0, 1.0, 0.0))
        }
    }

    @Test
    fun `a width that is not a number fails on the same path as one that is missing`() {
        expectInvalid("clips[0].crop.w") {
            getJSONArray("clips").getJSONObject(0).put("crop", rectJson(0.0, 0.0, 1.0, 1.0).apply { remove("w") })
        }
        expectInvalid("clips[0].rect.h") {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(0.0, 0.0, 1.0, 1.0).put("h", "tall"))
        }
    }

    @Test
    fun `an origin that is missing or unreadable is a value, not a shape`() {
        // The same line the overlay centres are on: x and y take their default and are clamped,
        // like cx and cy, while w and h are the shape and fail like wPx.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0)
                .put("crop", rectJson(0.0, 0.0, 0.5, 0.5).apply { remove("x") }.put("y", "down"))
        }
        val crop = ComposeSpecParser.parse(json).clips[0].crop!!
        assertEquals(0f, crop.x, 1e-6f)
        assertEquals(0f, crop.y, 1e-6f)
        assertEquals(0.5f, crop.w, 1e-6f)
    }

    @Test
    fun `a crop that is not an object at all means the whole frame`() {
        // optJSONObject answers null for a number as well as for a missing key, and both mean the
        // same thing to the renderer. The iOS reader shrugs at this one on purpose too.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("crop", 0.5)
        }
        assertNull(ComposeSpecParser.parse(json).clips[0].crop)
    }

    @Test
    fun `a rectangle hanging off the frame is clamped back inside it`() {
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0)
                .put("crop", rectJson(-0.2, 0.6, 3.0, 0.9))
                .put("rect", rectJson(0.75, 0.0, 0.5, 1.0))
        }
        val clip = ComposeSpecParser.parse(json).clips[0]
        assertEquals(0f, clip.crop!!.x, 1e-6f)
        assertEquals(1f, clip.crop!!.w, 1e-6f)
        // y stood, so the height is cut to the room it left rather than the other way round.
        assertEquals(0.6f, clip.crop!!.y, 1e-6f)
        assertEquals(0.4f, clip.crop!!.h, 1e-6f)
        assertEquals(0.75f, clip.rect!!.x, 1e-6f)
        assertEquals(0.25f, clip.rect!!.w, 1e-6f)
    }

    private fun rectJson(x: Double, y: Double, w: Double, h: Double) =
        JSONObject().put("x", x).put("y", y).put("w", w).put("h", h)

    /* ------------------------------------------------------------------------------------- */

    private fun trackClipJson(key: String) = JSONObject()
        .put("key", key)
        .put("uri", "file:///$key.mp4")
        .put("inMs", 0)
        .put("outMs", 1_000)
        .put("speed", 1)
        .put("volume", 1)
        .put("muted", false)
        .put("fit", "cover")

    private fun trackJson(id: String, vararg keys: String): JSONObject {
        val clips = org.json.JSONArray()
        for (key in keys) clips.put(trackClipJson(key))
        return JSONObject()
            .put("id", id)
            .put("clips", clips)
            .put("startMs", 500)
            .put("z", 1)
            .put("opacity", 0.8)
    }

    private fun withTracks(vararg tracks: JSONObject) = minimalJson().apply {
        val array = org.json.JSONArray()
        for (track in tracks) array.put(track)
        put("tracks", array)
    }

    @Test
    fun `a spec with no tracks carries no layers at all`() {
        // Absence is the fast path itself: the renderer asks this list once and, finding it empty,
        // builds the composition it built before layers existed. An empty array says the same.
        assertTrue(ComposeSpecParser.parse(minimalJson()).tracks.isEmpty())
        assertTrue(ComposeSpecParser.parse(withTracks()).tracks.isEmpty())
    }

    @Test
    fun `a track parses with its clips and its own layer values`() {
        val spec = ComposeSpecParser.parse(withTracks(trackJson("pip", "b")))
        assertEquals(1, spec.tracks.size)
        val track = spec.tracks[0]
        assertEquals("pip", track.id)
        assertEquals(1, track.clips.size)
        assertEquals("b", track.clips[0].key)
        assertEquals(Fit.COVER, track.clips[0].fit)
        assertEquals(500L, track.startMs)
        assertEquals(1, track.z)
        assertEquals(0.8f, track.opacity, 1e-6f)
    }

    @Test
    fun `a clip on a track reports the path of the track it is on`() {
        expectInvalid("tracks[0].clips[1].outMs") {
            val track = trackJson("pip", "b", "c")
            track.getJSONArray("clips").getJSONObject(1).put("outMs", 0)
            put("tracks", org.json.JSONArray().put(track))
        }
    }

    @Test
    fun `a track with no clips is rejected and the error names it`() {
        val json = withTracks(trackJson("pip", "b").put("clips", org.json.JSONArray()))
        try {
            ComposeSpecParser.parse(json)
            fail("expected invalid_spec:tracks[0].clips")
        } catch (e: SpecException) {
            assertEquals("tracks[0].clips", e.path)
            // An index names nothing the caller can look up: the manifest knows its layers by id.
            assertTrue(e.message!!.contains("'pip'"))
        }
    }

    @Test
    fun `a track without an id is rejected`() {
        expectInvalid("tracks[0].id") {
            put("tracks", org.json.JSONArray().put(trackJson("pip", "b").apply { remove("id") }))
        }
    }

    @Test
    fun `more layers than the decoder budget are rejected rather than truncated`() {
        // The cap counts the base track, so as many extra layers as the cap allows in total is
        // always one too many.
        val tracks = org.json.JSONArray()
        repeat(ComposeSpecParser.MAX_VIDEO_TRACKS) { i -> tracks.put(trackJson("t$i", "b")) }
        expectInvalid("tracks") { put("tracks", tracks) }
    }

    @Test
    fun `a track's own values are clamped rather than rejected`() {
        val json = withTracks(
            trackJson("pip", "b").put("startMs", -400).put("opacity", 3).put("z", -2),
        )
        val track = ComposeSpecParser.parse(json).tracks[0]
        assertEquals(0L, track.startMs)
        assertEquals(1f, track.opacity, 1e-6f)
        assertEquals(0, track.z)
    }

    @Test
    fun `a track start too large to become microseconds is clamped here`() {
        // The planner multiplies every millisecond it is handed by a thousand. Unclamped, this one
        // wraps round to a negative microsecond, and the clamp waiting downstream then puts the
        // layer at the START of the post rather than past its end.
        val json = withTracks(trackJson("pip", "b").put("startMs", Long.MAX_VALUE))
        val track = ComposeSpecParser.parse(json).tracks[0]
        assertEquals(ComposeSpecParser.MAX_TIMELINE_MS, track.startMs)
        assertTrue(track.startMs * 1000L > 0L)
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
