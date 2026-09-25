package net.dotnetdreamer.videokit.videocomposer

import androidx.media3.effect.Presentation
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The zoom camera on Android: the wire read by `normaliseCamera`'s rules, the keys read by
 * `cameraAt`'s, the matrix the contract's `p' = 0.5 + (p - c) * scale` becomes in NDC, which clips
 * the plan marks zoomed, and where the builder puts the camera in each chain.
 *
 * Everything asserted here is a number or a type, because `android.graphics.Matrix` and
 * `android.util.Pair` are stubs on the JVM: the camera's arithmetic lives in pure functions for
 * exactly that reason, and the compositor is checked on the floats that survive the stubbing.
 */
class CameraTest {

    /* ------------------------------------------------------------------------------------- */
    /* The wire                                                                                */
    /* ------------------------------------------------------------------------------------- */

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

    private fun cameraJson(at: List<Any?>, scale: List<Any?>, cx: List<Any?>, cy: List<Any?>) =
        JSONObject()
            .put("atMs", JSONArray(at))
            .put("scale", JSONArray(scale))
            .put("cx", JSONArray(cx))
            .put("cy", JSONArray(cy))

    private fun parseWith(camera: Any?): ComposeSpec =
        ComposeSpecParser.parse(minimalJson().put("camera", camera))

    private fun expectInvalid(path: String, camera: Any?) {
        try {
            parseWith(camera)
            fail("expected invalid_spec:$path")
        } catch (e: SpecException) {
            assertEquals(path, e.path)
        }
    }

    @Test
    fun `no camera, a null one or one with no keys is none`() {
        assertNull(ComposeSpecParser.parse(minimalJson()).camera)
        assertNull(parseWith(JSONObject.NULL).camera)
        assertNull(parseWith(cameraJson(emptyList(), emptyList(), emptyList(), emptyList())).camera)
        assertNull(parseWith(JSONObject()).camera)
    }

    @Test
    fun `a camera that never magnifies is dropped, which is the old path`() {
        assertNull(parseWith(cameraJson(listOf(0, 1000), listOf(1, 1.00005), listOf(0.2, 0.5), listOf(0.5, 0.9))).camera)
        // Scales below 1 clamp up to 1, so a "zoom out" is no camera at all.
        assertNull(parseWith(cameraJson(listOf(0), listOf(0.5), listOf(0.5), listOf(0.5))).camera)
    }

    @Test
    fun `a camera parses with its keys in order, each clamped onto the frame`() {
        val camera = parseWith(
            cameraJson(
                listOf(0, 500, 500, 1000.5),
                listOf(1, 2, 20, 2),
                listOf(0.5, 0.1, 0.5, 0.9),
                listOf(0.5, 0.95, 0.5, 0.3),
            ),
        ).camera!!
        assertEquals(4, camera.size)
        assertEquals(listOf(0.0, 500.0, 500.0, 1000.5), camera.atMs.toList())
        // Scale to 1..8.
        assertEquals(listOf(1.0, 2.0, 8.0, 2.0), camera.scale.toList())
        // Centres to 0.5 / scale .. 1 - 0.5 / scale: at 2x, 0.25..0.75.
        assertEquals(0.5, camera.cx[0], 0.0)
        assertEquals(0.25, camera.cx[1], 1e-12)
        assertEquals(0.75, camera.cy[1], 1e-12)
        assertEquals(0.75, camera.cx[3], 1e-12)
        assertEquals(0.3, camera.cy[3], 1e-12)
    }

    @Test
    fun `a scale or centre that is not a number falls back to the whole frame`() {
        val camera = parseWith(
            cameraJson(listOf(0, 100), listOf("2", 3), listOf(0.5, "left"), listOf(0.5, JSONObject.NULL)),
        ).camera!!
        assertEquals(1.0, camera.scale[0], 0.0)
        assertEquals(0.5, camera.cx[1], 0.0)
        assertEquals(0.5, camera.cy[1], 0.0)
    }

    @Test
    fun `a camera that is not an object, or whose arrays disagree in length, is refused`() {
        expectInvalid("camera", JSONArray(listOf(1, 2)))
        expectInvalid("camera", "zoom")
        expectInvalid("camera", cameraJson(listOf(0, 100), listOf(2), listOf(0.5, 0.5), listOf(0.5, 0.5)))
        expectInvalid("camera", JSONObject().put("atMs", JSONArray(listOf(0))).put("scale", JSONArray(listOf(2))))
        expectInvalid("camera.atMs", JSONObject().put("atMs", 5))
    }

    @Test
    fun `a time that is not a number or goes back in time is refused with its index`() {
        expectInvalid("camera.atMs[1]", cameraJson(listOf(0, "1s", 2000), listOf(2, 2, 2), listOf(0.5, 0.5, 0.5), listOf(0.5, 0.5, 0.5)))
        expectInvalid("camera.atMs[2]", cameraJson(listOf(0, 1000, 999), listOf(2, 2, 2), listOf(0.5, 0.5, 0.5), listOf(0.5, 0.5, 0.5)))
        // Equal times are a step, not a fault.
        assertNotNull(parseWith(cameraJson(listOf(0, 1000, 1000), listOf(2, 2, 1), listOf(0.5, 0.5, 0.5), listOf(0.5, 0.5, 0.5))).camera)
    }

    @Test
    fun `too many keys are refused rather than truncated`() {
        val n = CameraView.MAX_CAMERA_KEYS + 1
        val times = (0 until n).map { it }
        val twos = List(n) { 2 }
        val halves = List(n) { 0.5 }
        expectInvalid("camera", cameraJson(times, twos, halves, halves))
        val ok = cameraJson(times.dropLast(1), twos.dropLast(1), halves.dropLast(1), halves.dropLast(1))
        assertEquals(CameraView.MAX_CAMERA_KEYS, parseWith(ok).camera!!.size)
    }

    /* ------------------------------------------------------------------------------------- */
    /* Reading the keys                                                                        */
    /* ------------------------------------------------------------------------------------- */

    private fun track(vararg keys: DoubleArray) = CameraTrack(
        atMs = DoubleArray(keys.size) { keys[it][0] },
        scale = DoubleArray(keys.size) { keys[it][1] },
        cx = DoubleArray(keys.size) { keys[it][2] },
        cy = DoubleArray(keys.size) { keys[it][3] },
    )

    private fun key(at: Double, scale: Double, cx: Double = 0.5, cy: Double = 0.5) =
        doubleArrayOf(at, scale, cx, cy)

    @Test
    fun `a camera is read in a straight line between the keys either side`() {
        val camera = track(key(1000.0, 1.0), key(2000.0, 3.0, 0.3, 0.7))
        val mid = camera.at(1500.0)!!
        assertEquals(2.0, mid.scale, 1e-12)
        assertEquals(0.4, mid.cx, 1e-12)
        assertEquals(0.6, mid.cy, 1e-12)
        assertEquals(2.5, camera.at(1750.0)!!.scale, 1e-12)
    }

    @Test
    fun `it holds its first key before it and its last after it`() {
        val camera = track(key(1000.0, 2.0, 0.3, 0.3), key(2000.0, 3.0, 0.6, 0.6))
        assertEquals(CameraView(2.0, 0.3, 0.3), camera.at(-5.0))
        assertEquals(CameraView(2.0, 0.3, 0.3), camera.at(1000.0))
        assertEquals(CameraView(3.0, 0.6, 0.6), camera.at(2000.0))
        assertEquals(CameraView(3.0, 0.6, 0.6), camera.at(1e9))
        // One key never moves.
        val one = track(key(500.0, 2.0, 0.4, 0.6))
        for (t in listOf(0.0, 500.0, 7000.0)) assertEquals(CameraView(2.0, 0.4, 0.6), one.at(t))
    }

    @Test
    fun `keys at the same time are a step, the later one winning`() {
        val camera = track(key(0.0, 1.0), key(1000.0, 2.0), key(1000.0, 4.0, 0.2, 0.2), key(2000.0, 4.0, 0.2, 0.2))
        assertEquals(1.5, camera.at(500.0)!!.scale, 1e-12)
        assertEquals(4.0, camera.at(1000.0)!!.scale, 0.0)
        // A step at the very first key takes the last key sharing its time.
        val first = track(key(0.0, 2.0), key(0.0, 3.0), key(100.0, 3.0))
        assertEquals(3.0, first.at(0.0)!!.scale, 0.0)
        // Before that time the step has not happened yet: the earlier key holds, as cameraAt reads it.
        assertEquals(2.0, first.at(-1.0)!!.scale, 0.0)
    }

    @Test
    fun `the whole frame reads as no camera`() {
        val camera = track(key(0.0, 1.0), key(1000.0, 2.0), key(2000.0, 1.0))
        assertNull(camera.at(0.0))
        assertNull(camera.at(2000.0))
        assertNull(camera.at(0.04))
        assertNotNull(camera.at(1.0))
        assertNull(camera.atUs(3_000_000L))
        assertEquals(2.0, camera.atUs(1_000_000L)!!.scale, 0.0)
    }

    @Test
    fun `the binary search agrees with a straight walk over thousands of keys`() {
        val n = 3001
        val camera = CameraTrack(
            DoubleArray(n) { it * 33.3 },
            DoubleArray(n) { 1.5 + (it % 7) * 0.25 },
            DoubleArray(n) { 0.5 },
            DoubleArray(n) { 0.5 },
        )
        var t = -10.0
        while (t < n * 33.3 + 10) {
            var i = 0
            while (i + 1 < n && camera.atMs[i + 1] <= t) i++
            val expected = if (t <= camera.atMs[0]) camera.scale[0] else if (i == n - 1) camera.scale[n - 1] else {
                val f = (t - camera.atMs[i]) / (camera.atMs[i + 1] - camera.atMs[i])
                camera.scale[i] + (camera.scale[i + 1] - camera.scale[i]) * f
            }
            assertEquals("at $t", expected, camera.at(t)!!.scale, 1e-9)
            t += 17.1
        }
    }

    @Test
    fun `the most a window magnifies counts its ends and every key inside it`() {
        val camera = track(key(1000.0, 1.0), key(1500.0, 2.0), key(2000.0, 2.0), key(2500.0, 1.0))
        assertEquals(1.0, camera.maxScaleBetween(0.0, 1000.0), 0.0)
        assertEquals(2.0, camera.maxScaleBetween(0.0, 1500.0), 0.0)
        assertEquals(1.5, camera.maxScaleBetween(0.0, 1250.0), 1e-12)
        assertEquals(2.0, camera.maxScaleBetween(1600.0, 1700.0), 0.0)
        assertEquals(1.0, camera.maxScaleBetween(2500.0, 9000.0), 0.0)
        assertFalse(camera.zoomsBetween(2500.0, 9000.0))
        assertTrue(camera.zoomsBetween(2400.0, 9000.0))
    }

    /* ------------------------------------------------------------------------------------- */
    /* The matrix                                                                              */
    /* ------------------------------------------------------------------------------------- */

    /** The row-major 3x3 applied to a point, as Media3 applies it to a vertex. */
    private fun transform(m: FloatArray, x: Float, y: Float): Pair<Float, Float> =
        Pair(m[0] * x + m[1] * y + m[2], m[3] * x + m[4] * y + m[5])

    @Test
    fun `the focus lands on the frame's centre and the view's corners on its edges`() {
        val view = CameraView.clamp(2.0, 0.25, 0.75)
        val m = view.ndcMatrix()
        // The focus, in NDC: (2 cx - 1, 1 - 2 cy).
        val (fx, fy) = transform(m, view.focusNdcX.toFloat(), view.focusNdcY.toFloat())
        assertEquals(0f, fx, 1e-6f)
        assertEquals(0f, fy, 1e-6f)
        // The view is the quarter of the frame at the bottom left: x 0..0.5, y 0.5..1 (y down),
        // which is NDC x -1..0, y -1..0.
        val (lx, by) = transform(m, -1f, -1f)
        val (rx, ty) = transform(m, 0f, 0f)
        assertEquals(-1f, lx, 1e-6f)
        assertEquals(-1f, by, 1e-6f)
        assertEquals(1f, rx, 1e-6f)
        assertEquals(1f, ty, 1e-6f)
    }

    @Test
    fun `the NDC matrix is the contract's fractions, y flipped`() {
        val view = CameraView.clamp(3.0, 0.6, 0.3)
        val m = view.ndcMatrix()
        for (px in listOf(0.0, 0.2, 0.5, 0.77, 1.0)) {
            for (py in listOf(0.0, 0.33, 0.5, 1.0)) {
                val (qx, qy) = transform(m, (2 * px - 1).toFloat(), (1 - 2 * py).toFloat())
                assertEquals(2 * view.viewFractionX(px) - 1, qx.toDouble(), 1e-5)
                assertEquals(1 - 2 * view.viewFractionY(py), qy.toDouble(), 1e-5)
                assertEquals(view.viewNdcX(2 * px - 1), qx.toDouble(), 1e-5)
                assertEquals(view.viewNdcY(1 - 2 * py), qy.toDouble(), 1e-5)
            }
        }
        // `viewPoint` in camera.ts: p' = 0.5 + (p - c) * scale.
        assertEquals(0.5 + (0.2 - 0.6) * 3.0, view.viewFractionX(0.2), 1e-12)
    }

    @Test
    fun `a view between two clamped keys stays on the frame`() {
        val a = CameraView.clamp(1.2, 0.0, 1.0)
        val b = CameraView.clamp(8.0, 1.0, 0.0)
        val camera = CameraTrack(doubleArrayOf(0.0, 100.0), doubleArrayOf(a.scale, b.scale), doubleArrayOf(a.cx, b.cx), doubleArrayOf(a.cy, b.cy))
        for (i in 0..100) {
            val v = camera.at(i.toDouble())!!
            val half = 0.5 / v.scale
            assertTrue(v.cx - half >= -1e-12 && v.cx + half <= 1 + 1e-12)
            assertTrue(v.cy - half >= -1e-12 && v.cy + half <= 1 + 1e-12)
        }
    }

    /* ------------------------------------------------------------------------------------- */
    /* The plan and the builder                                                                */
    /* ------------------------------------------------------------------------------------- */

    private fun clip(key: String, inMs: Long = 0, outMs: Long = 2_000, rect: Placement? = null) = Clip(
        key = key,
        uri = "file:///$key.mp4",
        inMs = inMs,
        outMs = outMs,
        speed = 1f,
        volume = 1f,
        muted = false,
        fit = Fit.CONTAIN,
        crop = null,
        rect = rect,
    )

    private fun spec(clips: List<Clip>, tracks: List<Track> = emptyList(), camera: CameraTrack? = null) = ComposeSpec(
        jobId = "job",
        batchId = "post",
        clips = clips,
        output = Output(720, 1280, 30, 4_000_000, 128_000),
        filter = emptyList(),
        overlays = emptyList(),
        audio = Audio(false, 1f, null, emptyList()),
        posterAtMs = 0,
        tracks = tracks,
        camera = camera,
    )

    private fun probes(vararg keys: String) =
        keys.associate { "file:///$it.mp4" to ProbedInput(2_000, hasAudio = true, hasVideo = true) }

    /** In at 1.0 s, held 1.5..2.0 s at 2x, out by 2.5 s. */
    private val zoom = CameraTrack(
        doubleArrayOf(1000.0, 1500.0, 2000.0, 2500.0),
        doubleArrayOf(1.0, 2.0, 2.0, 1.0),
        doubleArrayOf(0.5, 0.25, 0.25, 0.5),
        doubleArrayOf(0.5, 0.25, 0.25, 0.5),
    )

    private fun isCamera(effect: Any) = effect.javaClass.simpleName == "CameraTransformation"

    private fun dissolve(from: Clip) = Transition(
        kind = "dissolve",
        from = from,
        mask = null,
        fromTint = null,
        toTint = null,
        curves = TransitionCurves(floatArrayOf(0f, 1f), null, null, null),
    )

    @Test
    fun `no camera plans none, zooms no clip and adds nothing to any chain`() {
        val plan = RenderPlan.build(spec(listOf(clip("a", outMs = 1_500), clip("b"))), probes("a", "b"))
        assertNull(plan.camera)
        assertTrue(plan.clips.none { it.zoomed })
        val composition = CompositionBuilder.toComposition(plan, emptyList(), null)
        for (item in composition.sequences[0].editedMediaItems) {
            assertEquals(1, item.effects.videoEffects.size)
            assertTrue(item.effects.videoEffects[0] is Presentation)
        }
        // The composition's own effects are the Presentation and the progress tap, never a camera,
        // so overlays - chained after them - stay where they were put.
        assertEquals(2, composition.effects.videoEffects.size)
    }

    @Test
    fun `an all-identity camera handed in by hand plans none`() {
        val flat = CameraTrack(doubleArrayOf(0.0, 1000.0), doubleArrayOf(1.0, 1.0), doubleArrayOf(0.5, 0.5), doubleArrayOf(0.5, 0.5))
        val plan = RenderPlan.build(spec(listOf(clip("a")), camera = flat), probes("a"))
        assertNull(plan.camera)
        assertTrue(plan.clips.none { it.zoomed })
    }

    @Test
    fun `only the clips whose window the camera magnifies in are zoomed, a frame's margin included`() {
        // a 0..1.5 s, b 1.5..3.5 s, c 3.5..5.5 s.
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 1_500), clip("b"), clip("c")), camera = zoom),
            probes("a", "b", "c"),
        )
        assertEquals(listOf(true, true, false), plan.clips.map { it.zoomed })
        // A clip ending a frame before the zoom starts still counts: the margin covers stamp drift.
        val early = RenderPlan.build(
            spec(listOf(clip("a", outMs = 990), clip("b")), camera = zoom),
            probes("a", "b"),
        )
        assertEquals(listOf(true, true), early.clips.map { it.zoomed })
        val clear = RenderPlan.build(
            spec(listOf(clip("a", outMs = 900), clip("b")), camera = zoom),
            probes("a", "b"),
        )
        assertEquals(listOf(false, true), clear.clips.map { it.zoomed })
    }

    @Test
    fun `a zoomed clip takes the camera straight after its geometry, and overlays stay out of it`() {
        val plan = RenderPlan.build(
            spec(listOf(clip("a", outMs = 1_500), clip("b"), clip("c")), camera = zoom),
            probes("a", "b", "c"),
        )
        val composition = CompositionBuilder.toComposition(plan, emptyList(), null)
        val items = composition.sequences[0].editedMediaItems
        for (i in 0..1) {
            val effects = items[i].effects.videoEffects
            assertEquals(2, effects.size)
            assertTrue(effects[0] is Presentation)
            assertTrue(isCamera(effects[1]))
        }
        assertEquals(1, items[2].effects.videoEffects.size)
        assertTrue(composition.effects.videoEffects.none { isCamera(it) })
    }

    @Test
    fun `both sides of a transition see the camera before their look`() {
        // a stops at 1.5 s and gives its last half second to b: the window is 1.5..2.0 s, inside
        // the zoom's hold.
        val plan = RenderPlan.build(
            spec(
                listOf(
                    clip("a", outMs = 1_500),
                    clip("b", outMs = 1_700).copy(transitionIn = dissolve(clip("a", inMs = 1_500, outMs = 2_000))),
                ),
                camera = zoom,
            ),
            probes("a", "b"),
        )
        assertTrue(plan.tails.single().clip.zoomed)
        val sequences = CompositionBuilder.toComposition(plan, emptyList(), null).sequences
        val incoming = sequences[0].editedMediaItems[1].effects.videoEffects
        assertTrue(incoming[0] is Presentation)
        assertTrue(isCamera(incoming[1]))
        assertTrue(incoming[2] is TransitionEffect)
        val tail = sequences[1].editedMediaItems.first { it.mediaItem.mediaId != "androidx-media3-GapMediaItem" }
        val outgoing = tail.effects.videoEffects
        assertTrue(outgoing[0] is Presentation)
        assertTrue(isCamera(outgoing[1]))
        assertTrue(outgoing[2] is TransitionEffect)
    }

    @Test
    fun `a zoomed layer is drawn at its most magnified and scaled back to its rectangle`() {
        val rect = Placement(0.5f, 0.5f, 0.5f, 0.5f, 0f)
        val plan = RenderPlan.build(
            spec(listOf(clip("a")), tracks = listOf(Track("pip", listOf(clip("b", rect = rect)), 0, 1, 1f)), camera = zoom),
            probes("a", "b"),
        )
        val layer = plan.tracks.single()
        // 360 x 640 at 2x.
        assertEquals(720, layer.clips[0].frame.width)
        assertEquals(1280, layer.clips[0].frame.height)
        assertFalse(layer.clips[0].zoomed)
        val placement = layer.placements[0]
        assertTrue(placement.zoomed)
        assertEquals(0.5f, placement.drawScaleX, 1e-6f)
        assertEquals(0.5f, placement.drawScaleY, 1e-6f)

        // No camera: the rectangle-sized frame it has always had.
        val plain = RenderPlan.build(
            spec(listOf(clip("a")), tracks = listOf(Track("pip", listOf(clip("b", rect = rect)), 0, 1, 1f))),
            probes("a", "b"),
        ).tracks.single()
        assertEquals(360, plain.clips[0].frame.width)
        assertFalse(plain.placements[0].zoomed)
        assertEquals(1f, plain.placements[0].drawScaleX, 0f)
    }

    @Test
    fun `a layer's supersample is held to four and to the largest texture`() {
        assertEquals(1f, RenderPlan.layerSupersample(1.0, 360, 640), 0f)
        assertEquals(2f, RenderPlan.layerSupersample(2.0, 360, 640), 0f)
        assertEquals(4f, RenderPlan.layerSupersample(8.0, 360, 640), 0f)
        assertEquals(4096f / 2560f, RenderPlan.layerSupersample(8.0, 1440, 2560), 1e-6f)
        assertEquals(1f, RenderPlan.layerSupersample(3.0, 4096, 100), 0f)
    }

    @Test
    fun `under a zoom the compositor still gates a layer and keeps its turn`() {
        val rect = Placement(0.1f, 0.1f, 0.4f, 0.4f, 30f)
        val plan = RenderPlan.build(
            spec(
                listOf(clip("a", outMs = 2_000), clip("c", outMs = 2_000)),
                tracks = listOf(Track("pip", listOf(clip("b", outMs = 1_800, rect = rect)), 200, 1, 0.8f)),
                camera = zoom,
            ),
            probes("a", "b", "c"),
        )
        val settings = CompositionBuilder.toComposition(plan, emptyList(), null).videoCompositorSettings
        // Before the layer starts, and after it ends: hidden.
        assertEquals(0f, settings.getOverlaySettings(0, 100_000L).alphaScale, 0f)
        assertEquals(0f, settings.getOverlaySettings(0, 2_500_000L).alphaScale, 0f)
        // Unzoomed and zoomed moments alike keep the opacity and the turn.
        for (t in listOf(500_000L, 1_700_000L)) {
            val s = settings.getOverlaySettings(0, t)
            assertEquals(0.8f, s.alphaScale, 1e-6f)
            assertEquals(-30f, s.rotationDegrees, 1e-6f)
        }
        // The base is composited as it arrives: it took the camera in its own chain.
        assertEquals(1f, settings.getOverlaySettings(1, 1_700_000L).alphaScale, 0f)
    }
}
