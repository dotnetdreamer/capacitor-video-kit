package net.dotnetdreamer.videokit.videocomposer

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
          "batchId": "post-1",
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
        assertEquals("post-1", spec.batchId)
        assertEquals(1, spec.clips.size)
        assertEquals("a", spec.clips[0].key)
        assertEquals(720, spec.output.width)
        assertNull(spec.audio.music)
        assertTrue(spec.audio.voiceover.isEmpty())
    }

    @Test
    fun `missing identifiers are rejected with their path`() {
        expectInvalid("jobId") { remove("jobId") }
        expectInvalid("batchId") { remove("batchId") }
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
    fun `a rectangle with no angle keeps the angle absent too`() {
        // The same promise one level down: the plan tests this for null to leave the rotation out
        // of the transform altogether, so a rectangle that says nothing about an angle must not
        // arrive carrying a 0.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(0.0, 0.0, 1.0, 0.5))
        }
        assertNull(ComposeSpecParser.parse(json).clips[0].rect!!.rotationDeg)
    }

    @Test
    fun `an angle is carried across untouched, and is not clamped or wrapped`() {
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0)
                .put("rect", rectJson(0.0, 0.0, 1.0, 0.5).put("rotationDeg", 745.5))
        }
        // 720 of that is two whole turns, and reducing it here would be this parser deciding
        // something sin and cos decide for nothing.
        assertEquals(745.5f, ComposeSpecParser.parse(json).clips[0].rect!!.rotationDeg!!, 1e-4f)
    }

    @Test
    fun `an angle on a crop is ignored`() {
        // One reader serves both fields, so the key is READABLE here; acting on it would be a
        // different operation on different pixels, and no engine performs it.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0)
                .put("crop", rectJson(0.0, 0.0, 0.5, 0.5).put("rotationDeg", 30.0))
        }
        val crop = ComposeSpecParser.parse(json).clips[0].crop!!
        assertEquals(Rect(0f, 0f, 0.5f, 0.5f), crop)
    }

    @Test
    fun `an unreadable angle is upright rather than a NaN in the matrix`() {
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0)
                .put("rect", rectJson(0.0, 0.0, 1.0, 0.5).put("rotationDeg", "sideways"))
        }
        assertNull(ComposeSpecParser.parse(json).clips[0].rect!!.rotationDeg)
    }

    @Test
    fun `a turned rectangle keeps its size and its angle where it was placed`() {
        // A placement hanging off the right edge is a video the customer pushed half off the canvas,
        // and the frame is what crops it. Neither the four numbers nor the angle are touched here:
        // the centre is still on the frame, which is the only thing this parser holds a placement to.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0)
                .put("rect", rectJson(0.75, 0.0, 0.5, 1.0).put("rotationDeg", -540.0))
        }
        val rect = ComposeSpecParser.parse(json).clips[0].rect!!
        assertEquals(0.75f, rect.x, 1e-6f)
        assertEquals(0.5f, rect.w, 1e-6f)
        assertEquals(-540f, rect.rotationDeg!!, 1e-4f)
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
    fun `a crop hanging off the source is clamped back inside it`() {
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("crop", rectJson(-0.2, 0.6, 3.0, 0.9))
        }
        val crop = ComposeSpecParser.parse(json).clips[0].crop!!
        assertEquals(0f, crop.x, 1e-6f)
        assertEquals(1f, crop.w, 1e-6f)
        // y stood, so the height is cut to the room it left rather than the other way round.
        assertEquals(0.6f, crop.y, 1e-6f)
        assertEquals(0.4f, crop.h, 1e-6f)
    }

    @Test
    fun `a placement hanging off the frame keeps its overhang`() {
        // The difference between the two fields, in one test. A crop is a window on the source and
        // cannot leave it; a placement says where the picture is DRAWN, and a customer who drags a
        // video off the side of the canvas means the overhang to be cut off by the output frame.
        // Clamping it back inside would slide their video onto the screen and rearrange the post.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(-0.3, 0.4, 0.6, 0.6))
        }
        val rect = ComposeSpecParser.parse(json).clips[0].rect!!
        assertEquals(-0.3f, rect.x, 1e-6f)
        assertEquals(0.6f, rect.w, 1e-6f)
        assertEquals(0.4f, rect.y, 1e-6f)
    }

    @Test
    fun `a placement pushed clean off the frame keeps a strip of itself on it`() {
        // The one thing a placement IS held to, and it lets a video go a long way past half off: a
        // customer framing a strip of one along an edge means to keep pushing. It stops only where
        // the rectangle would leave the frame entirely, which draws nothing and cannot be grabbed.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(-4.0, 9.0, 0.5, 0.5))
        }
        val rect = ComposeSpecParser.parse(json).clips[0].rect!!
        assertEquals(1f / 12f - 0.5f, rect.x, 1e-6f)
        assertEquals(1f - 1f / 12f, rect.y, 1e-6f)
        assertEquals(0.5f, rect.w, 1e-6f)
        assertEquals(0.5f, rect.h, 1e-6f)
    }

    @Test
    fun `a placement smaller than that strip is kept whole instead`() {
        // A video a twentieth of the frame wide cannot leave a twelfth of the frame behind, so the
        // rule reads as "all of it" rather than pinning it somewhere it could never reach.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(-3.0, 3.0, 0.05, 0.05))
        }
        val rect = ComposeSpecParser.parse(json).clips[0].rect!!
        assertEquals(0f, rect.x, 1e-6f)
        assertEquals(0.95f, rect.y, 1e-6f)
    }

    @Test
    fun `a placement larger than the frame is capped, and held with the capped size`() {
        // A layer is drawn into a texture of its rectangle's own size, so an unbounded side is an
        // unbounded texture. Two frames is the cap, and the centre is then held against THAT size.
        val json = minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(0.0, 0.0, 9.0, 5.0))
        }
        val rect = ComposeSpecParser.parse(json).clips[0].rect!!
        assertEquals(2f, rect.w, 1e-6f)
        assertEquals(2f, rect.h, 1e-6f)
        assertEquals(0f, rect.x, 1e-6f)
        assertEquals(0f, rect.y, 1e-6f)
        // Held against the CAPPED size: two frames wide may start anywhere from a strip short of
        // the left edge to a strip short of the right one, and 0 is well inside that.
        assertEquals(1f / 12f - 2f, ComposeSpecParser.parse(minimalJson().apply {
            getJSONArray("clips").getJSONObject(0).put("rect", rectJson(-9.0, 0.0, 9.0, 5.0))
        }).clips[0].rect!!.x, 1e-6f)
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
    fun `as many layers as the cap allows are all kept`() {
        // The cap counts the base track, so one fewer than it is what `tracks` may hold. Nothing in
        // the parser, the plan or the builder is written for a particular number of them.
        val tracks = org.json.JSONArray()
        repeat(ComposeSpecParser.MAX_VIDEO_TRACKS - 1) { i -> tracks.put(trackJson("t$i", "b")) }
        val spec = ComposeSpecParser.parse(minimalJson().apply { put("tracks", tracks) })
        assertEquals(ComposeSpecParser.MAX_VIDEO_TRACKS - 1, spec.tracks.size)
    }

    @Test
    fun `more layers than the cap allows are rejected rather than truncated`() {
        // A caller asking for this many believes it is getting this many, and a post silently
        // missing one of them is not the post it asked to make. The message is compared literally
        // by the iOS port tests, so the plural is part of the contract and not a nicety.
        val tracks = org.json.JSONArray()
        repeat(ComposeSpecParser.MAX_VIDEO_TRACKS) { i -> tracks.put(trackJson("t$i", "b")) }
        try {
            ComposeSpecParser.parse(minimalJson().apply { put("tracks", tracks) })
            fail("expected invalid_spec:tracks")
        } catch (e: SpecException) {
            assertEquals("tracks", e.path)
            assertEquals("invalid_spec:tracks at most 15 extra video tracks", e.message)
        }
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

    /* ------------------------------------------------------------------------------------- */

    /**
     * A wipe from `a` into `b`, lowered the way the editor sends it: `a` already stops at 1.5 s
     * and the half second it gave up travels as the tail.
     */
    private fun transitionJson(): JSONObject = JSONObject(
        """
        { "kind": "wipe-left",
          "from": { "key": "a", "uri": "file:///a.mp4", "inMs": 1500, "outMs": 2000,
                    "speed": 1, "volume": 1, "muted": false, "fit": "contain" },
          "mask": { "shape": "linear", "angleDeg": 180, "feather": 0.015 },
          "curves": { "alpha": [0, 0.5, 1], "reveal": [0, 0.5, 1],
                      "from": { "x": [0, -0.5, -1] }, "to": { "x": [1, 0.5, 0] } } }
        """.trimIndent(),
    )

    private fun incomingJson(transitionIn: Any?): JSONObject = JSONObject()
        .put("key", "b")
        .put("uri", "file:///b.mp4")
        .put("inMs", 0)
        .put("outMs", 2_000)
        .put("speed", 1)
        .put("volume", 1)
        .put("muted", false)
        .put("fit", "contain")
        .apply { if (transitionIn != null) put("transitionIn", transitionIn) }

    private fun withTransition(transitionIn: Any? = transitionJson()): JSONObject = minimalJson().apply {
        getJSONArray("clips").getJSONObject(0).put("outMs", 1_500)
        getJSONArray("clips").put(incomingJson(transitionIn))
    }

    private fun expectInvalidTransition(path: String, mutate: JSONObject.() -> Unit) {
        val json = withTransition(transitionJson().apply(mutate))
        try {
            ComposeSpecParser.parse(json)
            fail("expected invalid_spec:$path")
        } catch (e: SpecException) {
            assertEquals(path, e.path)
        }
    }

    private fun JSONObject.curves(): JSONObject = getJSONObject("curves")

    private fun numbers(vararg values: Double) = org.json.JSONArray().apply { values.forEach { put(it) } }

    @Test
    fun `a transition parses with its tail, its curves and its mask`() {
        val spec = ComposeSpecParser.parse(withTransition())
        val transition = spec.clips[1].transitionIn!!
        assertEquals("wipe-left", transition.kind)
        // The tail is a clip in its own right, read by the same reader as any other.
        assertEquals("a", transition.from.key)
        assertEquals(1_500L, transition.from.inMs)
        assertEquals(2_000L, transition.from.outMs)
        assertEquals(MaskShape.LINEAR, transition.mask!!.shape)
        assertEquals(180f, transition.mask!!.angleDeg, 1e-6f)
        assertEquals(0.015f, transition.mask!!.feather, 1e-6f)
        // The contract's defaults, written in so the drawing never asks what an absent field means.
        assertEquals(1, transition.mask!!.count)
        assertEquals(false, transition.mask!!.invert)
        assertEquals(listOf(0f, 0.5f, 1f), transition.curves.alpha!!.toList())
        assertEquals(listOf(0f, -0.5f, -1f), transition.curves.from!!.x!!.toList())
        assertEquals(listOf(1f, 0.5f, 0f), transition.curves.to!!.x!!.toList())
        assertNull(transition.curves.from!!.blur)
        assertNull(transition.fromTint)
        assertNull(transition.toTint)
    }

    @Test
    fun `a clip with no transition keeps it absent, and an explicit null means the same`() {
        // The plan asks this once per clip, and null is the promise that a cut renders exactly as
        // it did before transitions existed.
        assertNull(ComposeSpecParser.parse(minimalJson()).clips[0].transitionIn)
        assertNull(ComposeSpecParser.parse(withTransition(null)).clips[1].transitionIn)
        assertNull(ComposeSpecParser.parse(withTransition(JSONObject.NULL)).clips[1].transitionIn)
    }

    @Test
    fun `a transition that is not an object is rejected`() {
        expectInvalid("clips[1].transitionIn") {
            getJSONArray("clips").put(incomingJson("dissolve"))
        }
        expectInvalid("clips[1].transitionIn") {
            getJSONArray("clips").put(incomingJson(org.json.JSONArray()))
        }
    }

    @Test
    fun `a transition without a kind is rejected`() {
        expectInvalidTransition("clips[1].transitionIn.kind") { remove("kind") }
        expectInvalidTransition("clips[1].transitionIn.kind") { put("kind", "") }
        // A number is not a name, however readily it turns into a string.
        expectInvalidTransition("clips[1].transitionIn.kind") { put("kind", 7) }
    }

    @Test
    fun `a tail that is not a clip is rejected at its own path`() {
        expectInvalidTransition("clips[1].transitionIn.from") { remove("from") }
        expectInvalidTransition("clips[1].transitionIn.from") { put("from", "a") }
        // The same reader as every other clip, so a broken tail names the field that broke.
        expectInvalidTransition("clips[1].transitionIn.from.outMs") { getJSONObject("from").put("outMs", 1_000) }
        expectInvalidTransition("clips[1].transitionIn.from.uri") { getJSONObject("from").remove("uri") }
    }

    @Test
    fun `missing or malformed curves are rejected`() {
        expectInvalidTransition("clips[1].transitionIn.curves") { remove("curves") }
        expectInvalidTransition("clips[1].transitionIn.curves") { put("curves", org.json.JSONArray()) }
        expectInvalidTransition("clips[1].transitionIn.curves.alpha") { curves().put("alpha", 0.5) }
        expectInvalidTransition("clips[1].transitionIn.curves.alpha") {
            curves().put("alpha", org.json.JSONArray().put(0).put("half").put(1))
        }
        expectInvalidTransition("clips[1].transitionIn.curves.reveal") {
            curves().put("reveal", org.json.JSONArray().put(0).put(true).put(1))
        }
        expectInvalidTransition("clips[1].transitionIn.curves.from") { curves().put("from", 1) }
        expectInvalidTransition("clips[1].transitionIn.curves.to") { curves().put("to", "right") }
        expectInvalidTransition("clips[1].transitionIn.curves.from.scale") {
            curves().getJSONObject("from").put("scale", JSONObject())
        }
        expectInvalidTransition("clips[1].transitionIn.curves.to.tint") {
            curves().getJSONObject("to").put("tint", org.json.JSONArray().put(0).put(JSONObject.NULL).put(1))
        }
    }

    @Test
    fun `a curve with too few or too many samples is rejected`() {
        expectInvalidTransition("clips[1].transitionIn.curves.alpha") { curves().put("alpha", numbers(1.0)) }
        expectInvalidTransition("clips[1].transitionIn.curves.alpha") {
            curves().put("alpha", numbers(*DoubleArray(ComposeSpecParser.MAX_CURVE_SAMPLES + 1) { 0.5 }))
        }
        // The two ends of the range are both fine: a run of 2 and a run of 121, alone in the spec.
        val shortest = withTransition(JSONObject(transitionJson().toString()).apply {
            put("curves", JSONObject().put("alpha", numbers(0.0, 1.0)))
        })
        assertEquals(2, ComposeSpecParser.parse(shortest).clips[1].transitionIn!!.curves.alpha!!.size)
        val longest = withTransition(JSONObject(transitionJson().toString()).apply {
            put("curves", JSONObject().put("alpha", numbers(*DoubleArray(ComposeSpecParser.MAX_CURVE_SAMPLES) { 0.5 })))
        })
        assertEquals(121, ComposeSpecParser.parse(longest).clips[1].transitionIn!!.curves.alpha!!.size)
    }

    @Test
    fun `curves that disagree about their length are rejected at the first one that differs`() {
        // alpha sets the length and is read first; the side curves follow in the contract's order.
        expectInvalidTransition("clips[1].transitionIn.curves.from.x") {
            curves().getJSONObject("from").put("x", numbers(0.0, -0.3, -0.6, -1.0))
        }
        expectInvalidTransition("clips[1].transitionIn.curves.reveal") {
            curves().put("reveal", numbers(0.0, 1.0))
        }
        expectInvalidTransition("clips[1].transitionIn.curves.to.gain") {
            curves().getJSONObject("to").put("gain", numbers(1.0, 2.0))
        }
    }

    @Test
    fun `a channel nobody defined is rejected rather than skipped`() {
        // A channel this engine skipped would be one the preview drew and the export did not.
        expectInvalidTransition("clips[1].transitionIn.curves.beta") { curves().put("beta", numbers(0.0, 0.5, 1.0)) }
        expectInvalidTransition("clips[1].transitionIn.curves.from.wobble") {
            curves().getJSONObject("from").put("wobble", numbers(0.0, 0.5, 1.0))
        }
    }

    @Test
    fun `a mask that is not a mask is rejected`() {
        expectInvalidTransition("clips[1].transitionIn.mask") { put("mask", "linear") }
        expectInvalidTransition("clips[1].transitionIn.mask.shape") { getJSONObject("mask").put("shape", "star") }
        expectInvalidTransition("clips[1].transitionIn.mask.shape") { getJSONObject("mask").remove("shape") }
    }

    @Test
    fun `a tint that is not three numbers is rejected`() {
        expectInvalidTransition("clips[1].transitionIn.fromTint") { put("fromTint", "white") }
        expectInvalidTransition("clips[1].transitionIn.fromTint") { put("fromTint", numbers(1.0, 1.0)) }
        expectInvalidTransition("clips[1].transitionIn.toTint") { put("toTint", numbers(1.0, 1.0, 1.0, 1.0)) }
        expectInvalidTransition("clips[1].transitionIn.toTint") {
            put("toTint", org.json.JSONArray().put(1).put("1").put(1))
        }
    }

    @Test
    fun `the first failure in reading order is the one reported`() {
        // kind, then the tail, then the curves, then the mask, then the tints: the browser's reader
        // walks the same order, so the same broken spec names the same path on both.
        expectInvalidTransition("clips[1].transitionIn.kind") { remove("kind"); remove("curves") }
        expectInvalidTransition("clips[1].transitionIn.from") { remove("from"); remove("curves") }
        expectInvalidTransition("clips[1].transitionIn.curves") { remove("curves"); put("mask", 1) }
        expectInvalidTransition("clips[1].transitionIn.mask") { put("mask", 1); put("fromTint", 1) }
        expectInvalidTransition("clips[1].transitionIn.fromTint") { put("fromTint", 1); put("toTint", 1) }
    }

    @Test
    fun `every channel is clamped to its range rather than rejected`() {
        val transition = transitionJson().apply {
            put(
                "curves",
                JSONObject()
                    .put("alpha", numbers(-1.0, 2.0))
                    .put("reveal", numbers(-0.5, 1.5))
                    .put(
                        "from",
                        JSONObject()
                            .put("x", numbers(-9.0, 9.0))
                            .put("y", numbers(-9.0, 9.0))
                            .put("scale", numbers(0.0, 100.0))
                            .put("rotation", numbers(-5_000.0, 5_000.0))
                            .put("blur", numbers(-1.0, 0.9))
                            .put("pixelate", numbers(-0.1, 0.9))
                            .put("split", numbers(-0.9, 0.9))
                            .put("gain", numbers(-1.0, 20.0))
                            .put("tint", numbers(-1.0, 2.0)),
                    ),
            )
            put("fromTint", numbers(2.0, -1.0, 0.5))
            put("mask", JSONObject().put("shape", "blinds").put("count", 100).put("feather", 0.0).put("invert", true))
        }
        val parsed = ComposeSpecParser.parse(withTransition(transition)).clips[1].transitionIn!!
        val from = parsed.curves.from!!
        assertEquals(listOf(0f, 1f), parsed.curves.alpha!!.toList())
        assertEquals(listOf(0f, 1f), parsed.curves.reveal!!.toList())
        assertEquals(listOf(-4f, 4f), from.x!!.toList())
        assertEquals(listOf(-4f, 4f), from.y!!.toList())
        assertEquals(listOf(0.01f, 20f), from.scale!!.toList())
        assertEquals(listOf(-3600f, 3600f), from.rotation!!.toList())
        assertEquals(listOf(0f, 0.5f), from.blur!!.toList())
        assertEquals(listOf(0f, 0.5f), from.pixelate!!.toList())
        assertEquals(listOf(-0.5f, 0.5f), from.split!!.toList())
        assertEquals(listOf(0f, 10f), from.gain!!.toList())
        assertEquals(listOf(0f, 1f), from.tint!!.toList())
        assertEquals(listOf(1f, 0f, 0.5f), parsed.fromTint!!.toList())
        assertEquals(64, parsed.mask!!.count)
        assertEquals(0.0005f, parsed.mask!!.feather, 1e-9f)
        assertTrue(parsed.mask!!.invert)
    }

    @Test
    fun `mask numbers take the contract's defaults and round the slat count`() {
        val bare = transitionJson().put("mask", JSONObject().put("shape", "circle"))
        val mask = ComposeSpecParser.parse(withTransition(bare)).clips[1].transitionIn!!.mask!!
        assertEquals(MaskShape.CIRCLE, mask.shape)
        assertEquals(0f, mask.angleDeg, 0f)
        assertEquals(1, mask.count)
        assertEquals(0.01f, mask.feather, 1e-9f)
        assertEquals(false, mask.invert)

        fun count(value: Double) = ComposeSpecParser.parse(
            withTransition(transitionJson().put("mask", JSONObject().put("shape", "blinds").put("count", value))),
        ).clips[1].transitionIn!!.mask!!.count
        assertEquals(3, count(2.5))
        assertEquals(2, count(2.4))
        assertEquals(1, count(0.0))
        // A number is a JSON number, as it is for every curve and for the iOS reader: a string
        // that spells one takes the default instead of being read as thirty slats on Android alone.
        val spelt = transitionJson().put(
            "mask",
            JSONObject().put("shape", "blinds").put("count", "30").put("feather", "0.2").put("angleDeg", "90"),
        )
        val read = ComposeSpecParser.parse(withTransition(spelt)).clips[1].transitionIn!!.mask!!
        assertEquals(1, read.count)
        assertEquals(0.01f, read.feather, 1e-9f)
        assertEquals(0f, read.angleDeg, 0f)
        // A direction is kept to within one turn, so a float can hold one no JSON number breaks.
        fun angle(value: Double) = ComposeSpecParser.parse(
            withTransition(transitionJson().put("mask", JSONObject().put("shape", "linear").put("angleDeg", value))),
        ).clips[1].transitionIn!!.mask!!.angleDeg
        assertEquals(90f, angle(450.0), 0f)
        assertEquals(-90f, angle(-450.0), 0f)
        assertEquals(180f, angle(180.0), 0f)
        assertTrue(angle(1e300).isFinite())
        // Only a real true inverts; a string that says so is not one.
        val stringy = transitionJson().put("mask", JSONObject().put("shape", "circle").put("invert", "true"))
        assertEquals(false, ComposeSpecParser.parse(withTransition(stringy)).clips[1].transitionIn!!.mask!!.invert)
    }

    @Test
    fun `a transition on the first clip or on a layer is ignored without being read`() {
        // Neither has an outgoing clip to come from, so whatever it carries is not a reason to fail.
        val json = withTransition().apply {
            getJSONArray("clips").getJSONObject(0).put("transitionIn", 5)
            val track = trackJson("pip", "b")
            track.getJSONArray("clips").getJSONObject(0).put("transitionIn", JSONObject().put("kind", ""))
            put("tracks", org.json.JSONArray().put(track))
        }
        val spec = ComposeSpecParser.parse(json)
        assertNull(spec.clips[0].transitionIn)
        assertNull(spec.tracks[0].clips[0].transitionIn)
        assertEquals("wipe-left", spec.clips[1].transitionIn!!.kind)
    }

    @Test
    fun `a tail's own transition is ignored too`() {
        // A tail is the outgoing clip's last moments; it has nothing before it on its own sequence.
        val transition = transitionJson().apply { getJSONObject("from").put("transitionIn", "garbage") }
        val parsed = ComposeSpecParser.parse(withTransition(transition)).clips[1].transitionIn!!
        assertNull(parsed.from.transitionIn)
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
