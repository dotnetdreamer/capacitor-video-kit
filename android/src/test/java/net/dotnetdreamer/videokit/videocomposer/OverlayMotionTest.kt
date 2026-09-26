package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * A layer's motion on Android: the wire read by `normaliseOverlayMotion`'s rules and in its order,
 * the keys read by `overlayMotionAt`'s, and the pose the contract's "three numbers added and two
 * multiplied" becomes in Media3's normalised device coordinates.
 *
 * The pose is asserted on its floats and the settings on the two numbers that survive the stubbed
 * framework - the turn and the alpha - because `android.util.Pair`, which Media3 hands the anchors and
 * the scale back in, is a stub on the JVM. That is why the arithmetic lives in [OverlayPose].
 */
class OverlayMotionTest {

    /* ------------------------------------------------------------------------------------- */
    /* The wire                                                                                */
    /* ------------------------------------------------------------------------------------- */

    private fun specJson(motion: Any?): JSONObject {
        val overlay = JSONObject()
            .put("id", "o")
            .put("png", "data:image/png;base64,AAAA")
            .put("cx", 0.5)
            .put("cy", 0.5)
            .put("wPx", 100)
            .put("hPx", 50)
            .put("rotationDeg", 0)
            .put("startMs", 0)
            .put("endMs", 2000)
            .put("opacity", 1)
        if (motion != null) overlay.put("motion", motion)
        return JSONObject(
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
              "audio": { "originalMuted": false, "originalVolume": 1, "music": null, "voiceover": [] },
              "posterAtMs": 0
            }
            """.trimIndent(),
        ).put("overlays", JSONArray().put(overlay))
    }

    private fun motionOf(motion: Any?): OverlayMotion? = ComposeSpecParser.parse(specJson(motion)).overlays[0].motion

    private fun motionJson(vararg channels: Pair<String, List<Any?>>): JSONObject {
        val o = JSONObject()
        for ((name, values) in channels) o.put(name, JSONArray(values))
        return o
    }

    private fun expectInvalid(path: String, motion: Any?, message: String? = null) {
        try {
            motionOf(motion)
            fail("expected invalid_spec:$path")
        } catch (e: SpecException) {
            assertEquals(path, e.path)
            if (message != null) assertEquals(message, e.message)
        }
    }

    @Test
    fun `no motion, a null one, no times, no keys and a motion that moves nothing are all none`() {
        assertNull(motionOf(null))
        assertNull(motionOf(JSONObject.NULL))
        assertNull(motionOf(JSONObject()))
        assertNull(motionOf(motionJson("atMs" to emptyList())))
        assertNull(motionOf(motionJson("atMs" to listOf(0, 500))))
        assertNull(motionOf(motionJson("atMs" to listOf(0, 500), "scale" to listOf(1, 1), "x" to listOf(0, 0))))
    }

    @Test
    fun `a motion parses with every value clamped, a value that is not a number neutral, and still channels left off`() {
        val motion = motionOf(
            motionJson(
                "atMs" to listOf(0, 250, 250.5),
                "x" to listOf(-9, 9, 0.12),
                "y" to listOf(0, 0, 0),
                "scale" to listOf(-1, 99, "big"),
                "rotation" to listOf(-9999, 30, JSONObject.NULL),
                "opacity" to listOf(2, 0.5, 1),
            ),
        )!!
        assertEquals(listOf(0.0, 250.0, 250.5), motion.atMs.toList())
        assertEquals(listOf(-4.0, 4.0, 0.12), motion.x!!.toList())
        assertNull(motion.y)
        assertEquals(listOf(0.0, 20.0, 1.0), motion.scale!!.toList())
        assertEquals(listOf(-3600.0, 30.0, 0.0), motion.rotation!!.toList())
        assertEquals(listOf(1.0, 0.5, 1.0), motion.opacity!!.toList())
    }

    @Test
    fun `a motion of the wrong shape is refused with its path, in the contract's order`() {
        expectInvalid("overlays[0].motion", JSONArray(listOf(1, 2)))
        expectInvalid("overlays[0].motion", "pop")
        expectInvalid("overlays[0].motion.atMs", JSONObject().put("atMs", 5))
        expectInvalid("overlays[0].motion.x", motionJson("atMs" to listOf(0, 1), "x" to listOf(0)))
        // The channels in order: scale before opacity whatever order the object holds them in.
        expectInvalid("overlays[0].motion.scale", motionJson("atMs" to listOf(0, 1), "opacity" to listOf(0), "scale" to listOf(1)))
        expectInvalid("overlays[0].motion.scale", JSONObject().put("atMs", JSONArray(listOf(0, 1))).put("scale", 2))
        // Unknown keys after the channels: a broken channel is named first.
        expectInvalid("overlays[0].motion.glow", motionJson("atMs" to listOf(0, 1), "glow" to listOf(0, 1)))
        expectInvalid("overlays[0].motion.y", motionJson("atMs" to listOf(0, 1), "glow" to listOf(0, 1), "y" to listOf(0)))
    }

    @Test
    fun `too many keys are refused rather than truncated, in the words the web uses`() {
        val n = OverlayMotion.MAX_KEYS + 1
        val times = (0 until n).map { it }
        expectInvalid(
            "overlays[0].motion",
            motionJson("atMs" to times, "x" to List(n) { 0.1 }),
            "invalid_spec:overlays[0].motion at most ${OverlayMotion.MAX_KEYS} keys",
        )
        assertEquals(OverlayMotion.MAX_KEYS, motionOf(motionJson("atMs" to times.dropLast(1), "x" to List(n - 1) { 0.1 }))!!.size)
    }

    @Test
    fun `a time that is not a number or goes back in time is refused with its index`() {
        expectInvalid("overlays[0].motion.atMs[1]", motionJson("atMs" to listOf(0, "1s"), "x" to listOf(0, 1)))
        expectInvalid("overlays[0].motion.atMs[2]", motionJson("atMs" to listOf(0, 500, 499), "x" to listOf(0, 1, 1)))
        // Equal times are a step, not a fault.
        assertNotNull(motionOf(motionJson("atMs" to listOf(0, 500, 500), "x" to listOf(0, 1, 0))))
    }

    @Test
    fun `the motion is read after the rest of the layer, and rides through the plan`() {
        val json = specJson(JSONObject().put("atMs", "x"))
        json.getJSONArray("overlays").getJSONObject(0).put("wPx", 0)
        try {
            ComposeSpecParser.parse(json)
            fail("expected invalid_spec:overlays[0].wPx")
        } catch (e: SpecException) {
            assertEquals("overlays[0].wPx", e.path)
        }
        val spec = ComposeSpecParser.parse(specJson(motionJson("atMs" to listOf(0, 500), "opacity" to listOf(0, 1))))
        val plan = RenderPlan.build(spec, emptyMap())
        assertSame(spec.overlays[0].motion, plan.overlays[0].motion)
        // The plan the job keeps loses the pixels and keeps the moves.
        assertSame(spec.overlays[0].motion, spec.withoutOverlayPixels().overlays[0].motion)
        assertNull(RenderPlan.build(ComposeSpecParser.parse(specJson(null)), emptyMap()).overlays[0].motion)
    }

    /* ------------------------------------------------------------------------------------- */
    /* Reading the keys                                                                        */
    /* ------------------------------------------------------------------------------------- */

    private val motion = OverlayMotion(
        atMs = doubleArrayOf(100.0, 200.0, 200.0, 300.0),
        x = doubleArrayOf(0.1, 0.2, 0.0, 0.0),
        y = null,
        scale = null,
        rotation = null,
        opacity = doubleArrayOf(0.0, 1.0, 1.0, 0.5),
    )

    @Test
    fun `the keys are read in straight lines, the ends hold, and equal times are a step`() {
        assertEquals(MotionSample(0.1, 0.0, 1.0, 0.0, 0.0), motion.at(0.0))
        val mid = motion.at(150.0)!!
        assertEquals(0.15, mid.x, 1e-12)
        assertEquals(0.5, mid.opacity, 1e-12)
        // The later of the two keys at 200 wins, and there the layer is at rest.
        assertNull(motion.at(200.0))
        assertEquals(0.75, motion.at(250.0)!!.opacity, 1e-12)
        assertEquals(0.5, motion.at(1e9)!!.opacity, 0.0)
        assertEquals(0.75, motion.atUs(250_000L)!!.opacity, 1e-12)
    }

    @Test
    fun `a long track is searched to the right pair`() {
        val n = 5000
        val long = OverlayMotion(
            atMs = DoubleArray(n) { it * 10.0 },
            x = null,
            y = null,
            scale = DoubleArray(n) { 1.0 + (it % 2) },
            rotation = null,
            opacity = null,
        )
        assertEquals(1.75, long.at(43_212.5)!!.scale, 1e-9)
    }

    @Test
    fun `a sample at rest is neutral, and one that moves is not`() {
        assertTrue(MotionSample(1e-9, 0.0, 1.0, 0.0, 1.0).isNeutral)
        assertFalse(MotionSample(0.0, 0.0, 1.0, 0.01, 1.0).isNeutral)
    }

    /* ------------------------------------------------------------------------------------- */
    /* The pose                                                                                */
    /* ------------------------------------------------------------------------------------- */

    private val rest = OverlayPose(anchorX = 0.2f, anchorY = -0.4f, scaleX = 0.5f, scaleY = 0.25f, rotationGlDeg = -30f, alpha = 0.8f)

    @Test
    fun `a motion moves the centre in NDC, y up, and stretches and turns about it`() {
        val moved = rest.moved(MotionSample(x = 0.1, y = 0.25, scale = 2.0, rotation = 15.0, opacity = 0.5))
        // A tenth of the WIDTH right is a fifth of -1..1; a quarter of the height DOWN is half of it
        // DOWN, which is minus in GL's y-up space.
        assertEquals(0.4f, moved.anchorX, 1e-6f)
        assertEquals(-0.9f, moved.anchorY, 1e-6f)
        assertEquals(1f, moved.scaleX, 1e-6f)
        assertEquals(0.5f, moved.scaleY, 1e-6f)
        // Clockwise 15 more than the overlay's clockwise 30: GL's counter-clockwise -45.
        assertEquals(-45f, moved.rotationGlDeg, 1e-6f)
        assertEquals(0.4f, moved.alpha, 1e-6f)
        assertTrue(moved.isDrawn)
    }

    @Test
    fun `a pose shrunk to nothing or faded out is not drawn`() {
        assertFalse(rest.moved(MotionSample(0.0, 0.0, 0.0, 0.0, 1.0)).isDrawn)
        assertFalse(rest.moved(MotionSample(0.0, 0.0, 1.0, 0.0, 0.0)).isDrawn)
        assertTrue(rest.moved(MotionSample(0.0, 0.0, 0.01, 0.0, 0.01)).isDrawn)
    }

    @Test
    fun `a centre moved off the frame is placed by the overlay's own anchor, which Media3 accepts`() {
        // A 100 px wide layer on a 720 px frame is 0.139 of NDC either side of its centre. At cx 0.95
        // an offset of a tenth of the width puts its centre at 1.05 of the frame: 1.1 in NDC.
        val edge = OverlayPose(anchorX = 0.9f, anchorY = 0f, scaleX = 1f, scaleY = 1f, rotationGlDeg = 0f, alpha = 1f, halfWidth = 100f / 720f, halfHeight = 50f / 1280f)
        val moved = edge.moved(MotionSample(x = 0.1, y = 0.0, scale = 1.0, rotation = 0.0, opacity = 1.0))
        assertEquals(1.1f, moved.anchorX, 1e-5f)
        val anchors = moved.anchors()!!
        assertEquals(1f, anchors.backgroundX, 0f)
        // background - half * overlay is the centre: 1 - 0.139 * (-0.72) = 1.1.
        assertEquals(-0.72f, anchors.overlayX, 1e-5f)
        assertEquals(1.1f, anchors.backgroundX - moved.halfWidth * anchors.overlayX, 1e-5f)
        assertEquals(0f, anchors.overlayY, 0f)
        assertTrue(moved.isDrawn)
        // The builder checks both anchors for real on the JVM, and takes these.
        assertEquals(1f, overlaySettings(moved).alphaScale, 0f)

        // A centre more than half the layer past the edge has nothing of it on the frame.
        val gone = edge.moved(MotionSample(x = 0.3, y = 0.0, scale = 1.0, rotation = 0.0, opacity = 1.0))
        assertNull(gone.anchors())
        assertFalse(gone.isDrawn)
        assertEquals(0f, overlaySettings(gone).alphaScale, 0f)

        // On the frame, the anchors are what every overlay always had.
        val still = edge.anchors()!!
        assertEquals(OverlayPose.Anchors(0.9f, 0f, 0f, 0f), still)
        // And the size scales the half size it is placed by.
        assertEquals(2f * 100f / 720f, edge.moved(MotionSample(0.0, 0.0, 2.0, 0.0, 1.0)).halfWidth, 1e-6f)
    }

    @Test
    fun `the settings a moving layer gets carry its turn and its alpha`() {
        val settings = overlaySettings(rest.moved(MotionSample(0.0, 0.0, 1.0, 15.0, 0.5)))
        assertEquals(-45f, settings.rotationDegrees, 1e-6f)
        assertEquals(0.4f, settings.alphaScale, 1e-6f)
        val still = overlaySettings(rest)
        assertEquals(-30f, still.rotationDegrees, 0f)
        assertEquals(0.8f, still.alphaScale, 0f)
    }

    @Test
    fun `a pop compiled by the editor reads on Android as it does in the browser`() {
        // Three keys `compileOverlayMotion` writes for a text pop over 0..470 ms: out of nothing at
        // 0, past its size a third of the way in, and home at the end.
        val pop = OverlayMotion(
            atMs = doubleArrayOf(0.0, 169.2, 470.0),
            x = null,
            y = null,
            scale = doubleArrayOf(0.0, 1.2, 1.0),
            rotation = null,
            opacity = doubleArrayOf(0.0, 1.0, 1.0),
        )
        val start = rest.moved(pop.at(0.0)!!)
        assertFalse(start.isDrawn)
        val peak = rest.moved(pop.at(169.2)!!)
        assertEquals(0.6f, peak.scaleX, 1e-6f)
        assertEquals(0.3f, peak.scaleY, 1e-6f)
        assertEquals(rest.anchorX, peak.anchorX, 0f)
        assertNull(pop.at(470.0))
        assertNull(pop.at(2000.0))
    }
}
