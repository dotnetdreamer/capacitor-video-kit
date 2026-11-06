package net.dotnetdreamer.videokit.videocomposer

import android.graphics.Bitmap
import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * A layer in perspective on Android: `ComposeOverlayQuad` read off the wire, its keys read corner by corner,
 * and the homography [LayerUnderlayEffect] draws it through - the bitmap's rectangle onto the quad and back,
 * its middle where the diagonals cross rather than half way down the screen - and a flat layer drawn there
 * landing exactly where Media3 would have put it.
 */
class OverlayQuadTest {

    /* ------------------------------------------------------------------------------------- */
    /* The wire                                                                                */
    /* ------------------------------------------------------------------------------------- */

    private fun overlayJson(id: String = "o"): JSONObject = JSONObject()
        .put("id", id)
        .put("png", "data:image/png;base64,AAAA")
        .put("cx", 0.5)
        .put("cy", 0.5)
        .put("wPx", 100)
        .put("hPx", 50)
        .put("rotationDeg", 0)
        .put("startMs", 0)
        .put("endMs", 2000)
        .put("opacity", 1)

    private fun specJson(vararg overlays: JSONObject): JSONObject = JSONObject(
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
    ).put("overlays", JSONArray(overlays.toList()))

    private fun quadJson(atMs: List<Any?>, corners: List<Any?>): JSONObject =
        JSONObject().put("atMs", JSONArray(atMs)).put("corners", JSONArray(corners))

    private fun quadOf(quad: Any?): OverlayQuad? =
        ComposeSpecParser.parse(specJson(overlayJson().apply { if (quad != null) put("quad", quad) })).overlays[0].quad

    private fun expectInvalid(path: String, message: String? = null, json: () -> JSONObject) {
        try {
            ComposeSpecParser.parse(json())
            fail("expected invalid_spec:$path")
        } catch (e: SpecException) {
            assertEquals(path, e.path)
            if (message != null) assertEquals(message, e.message)
        }
    }

    private fun expectInvalidQuad(path: String, quad: Any, message: String? = null) =
        expectInvalid(path, message) { specJson(overlayJson().put("quad", quad)) }

    /** Fractions of the frame, TL, TR, BR, BL: a square in the middle, and a floor running away from the camera. */
    private val square = listOf(0.25, 0.25, 0.75, 0.25, 0.75, 0.75, 0.25, 0.75)
    private val trapezoid = listOf(0.4, 0.3, 0.6, 0.3, 0.9, 0.7, 0.1, 0.7)

    @Test
    fun `no quad, a null one and one with no keys are none, and only a real true puts a layer behind`() {
        assertNull(quadOf(null))
        assertNull(quadOf(JSONObject.NULL))
        assertNull(quadOf(quadJson(emptyList(), emptyList())))
        assertFalse(ComposeSpecParser.parse(specJson(overlayJson())).overlays[0].behind)
        for (notTrue in listOf<Any>(false, "true", 1, JSONObject())) {
            assertFalse(ComposeSpecParser.parse(specJson(overlayJson().put("behind", notTrue))).overlays[0].behind)
        }
        assertTrue(ComposeSpecParser.parse(specJson(overlayJson().put("behind", true))).overlays[0].behind)
    }

    @Test
    fun `a quad keeps its times and its corners as they came, off the frame included, and ignores keys it does not know`() {
        val corners = square + listOf(-0.5, -0.25, 1.5, 0.0, 1.25, 1.75, 0.0, 1.0)
        val quad = quadOf(quadJson(listOf(0, 33.5), corners).put("smooth", "ignored"))!!
        assertEquals(2, quad.size)
        assertArrayEquals(doubleArrayOf(0.0, 33.5), quad.atMs, 0.0)
        assertArrayEquals(corners.toDoubleArray(), quad.corners, 0.0)
    }

    @Test
    fun `a quad of the wrong shape is refused with its path, corners before times before values`() {
        expectInvalidQuad("overlays[0].quad", "square")
        expectInvalidQuad("overlays[0].quad", JSONArray())
        expectInvalidQuad("overlays[0].quad.atMs", JSONObject().put("corners", JSONArray(square)))
        expectInvalidQuad("overlays[0].quad.atMs", JSONObject().put("atMs", 0).put("corners", JSONArray(square)))
        expectInvalidQuad("overlays[0].quad.corners", JSONObject().put("atMs", JSONArray(listOf(0))))
        expectInvalidQuad("overlays[0].quad.corners", JSONObject().put("atMs", JSONArray(listOf(0))).put("corners", "square"))
        expectInvalidQuad("overlays[0].quad.corners", quadJson(listOf(0), square.dropLast(1)))
        expectInvalidQuad("overlays[0].quad.corners", quadJson(listOf(0, 10), square))
        expectInvalidQuad("overlays[0].quad.corners", quadJson(listOf("x"), square.dropLast(1)))
        expectInvalidQuad("overlays[0].quad.atMs[0]", quadJson(listOf("x"), listOf("y") + square.drop(1)))
        expectInvalidQuad("overlays[0].quad.corners[3]", quadJson(listOf(0), square.take(3) + listOf("0.5") + square.drop(4)))
        expectInvalidQuad("overlays[0].quad.corners[9]", quadJson(listOf(0, 10), square + listOf(0.1, null) + square.drop(2)))
    }

    @Test
    fun `a time that is not a number, stands still or goes back is refused with its index`() {
        expectInvalidQuad("overlays[0].quad.atMs[1]", quadJson(listOf(0, "1"), square + square))
        expectInvalidQuad("overlays[0].quad.atMs[1]", quadJson(listOf(5, 5), square + square))
        expectInvalidQuad("overlays[0].quad.atMs[2]", quadJson(listOf(0, 10, 9), square + square + square))
    }

    @Test
    fun `more keys than the wire allows are refused rather than truncated`() {
        val n = OverlayQuad.MAX_KEYS + 1
        val atMs = (0 until n).map { it * 10 }
        val corners = (0 until n).flatMap { square }
        expectInvalidQuad("overlays[0].quad.atMs", quadJson(atMs, corners), "invalid_spec:overlays[0].quad.atMs at most 6000 keys")
        assertEquals(OverlayQuad.MAX_KEYS, quadOf(quadJson(atMs.dropLast(1), corners.dropLast(8)))!!.size)
    }

    @Test
    fun `the quad is read after the rest of the layer, its motion included, and is never one of the motion's keys`() {
        expectInvalid("overlays[0].wPx") { specJson(overlayJson().put("wPx", 0).put("quad", "square")) }
        expectInvalid("overlays[0].motion") { specJson(overlayJson().put("motion", "pop").put("quad", "square")) }
        expectInvalid("overlays[0].motion.quad") {
            specJson(overlayJson().put("motion", JSONObject().put("atMs", JSONArray(listOf(0))).put("quad", quadJson(listOf(0), square))))
        }
    }

    @Test
    fun `a quad rides through the plan and sends its layer under the rest, and a layer behind nobody stays ordinary`() {
        val spec = ComposeSpecParser.parse(
            specJson(
                overlayJson("a"),
                overlayJson("q").put("quad", quadJson(listOf(0), square)),
                overlayJson("b").put("behind", true),
            ),
        )
        val plan = RenderPlan.build(spec, emptyMap())
        assertFalse(plan.overlays[0].drawnUnder)
        assertSame(spec.overlays[1].quad, plan.overlays[1].quad)
        assertTrue(plan.overlays[1].drawnUnder)
        assertFalse(plan.overlays[1].behind)
        // No matte: nobody to be behind, so the layer is drawn over the picture as always.
        assertTrue(spec.overlays[2].behind)
        assertFalse(plan.overlays[2].behind)
        assertFalse(plan.overlays[2].drawnUnder)
        assertNull(plan.matte)
        // The plan the job keeps loses the pixels and keeps the quad.
        assertSame(spec.overlays[1].quad, spec.withoutOverlayPixels().overlays[1].quad)

        val (under, over) = CompositionBuilder.splitUnderlay(plan.overlays, listOf("a", "q", "b"))
        assertEquals(listOf("q"), under.map { it.first })
        assertSame(plan.overlays[1], under.single().second)
        assertEquals(listOf("a", "b"), over)
        // A post with no such layer hands every one to Media3, in order, as it always has.
        val plain = RenderPlan.build(ComposeSpecParser.parse(specJson(overlayJson("a"), overlayJson("b"))), emptyMap())
        assertEquals(listOf("a", "b"), CompositionBuilder.splitUnderlay(plain.overlays, listOf("a", "b")).second)
        assertTrue(CompositionBuilder.splitUnderlay(plain.overlays, listOf("a", "b")).first.isEmpty())
        assertTrue(CompositionBuilder.splitUnderlay(plan.overlays, emptyList<String>()).first.isEmpty())
    }

    /* ------------------------------------------------------------------------------------- */
    /* Reading the keys                                                                        */
    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `the corners are read in straight lines, one by one, and the end keys hold`() {
        val quad = OverlayQuad(doubleArrayOf(100.0, 200.0), (square + trapezoid).toDoubleArray())
        val out = DoubleArray(8)
        assertArrayEquals(square.toDoubleArray(), quad.at(0.0, out), 0.0)
        assertArrayEquals(square.toDoubleArray(), quad.at(100.0, out), 0.0)
        assertArrayEquals(DoubleArray(8) { (square[it] + trapezoid[it]) / 2 }, quad.at(150.0, out), 1e-12)
        assertArrayEquals(DoubleArray(8) { square[it] + (trapezoid[it] - square[it]) * 0.25 }, quad.atUs(125_000L, out), 1e-12)
        assertArrayEquals(trapezoid.toDoubleArray(), quad.at(200.0, out), 0.0)
        assertArrayEquals(trapezoid.toDoubleArray(), quad.at(9e9, out), 0.0)
        assertSame(out, quad.at(150.0, out))
    }

    @Test
    fun `a long track is searched to the right pair`() {
        val n = 5000
        val quad = OverlayQuad(DoubleArray(n) { it * 10.0 }, DoubleArray(n * 8) { (it / 8).toDouble() })
        val out = quad.at(31_234.5, DoubleArray(8))
        assertEquals(3123.45, out[0], 1e-9)
        assertEquals(3123.45, out[7], 1e-9)
    }

    /* ------------------------------------------------------------------------------------- */
    /* The homography                                                                          */
    /* ------------------------------------------------------------------------------------- */

    /** The bitmap's own corners as (u, v), in the wire's order: v runs DOWN its rows. */
    private val unit = doubleArrayOf(0.0, 0.0, 1.0, 0.0, 1.0, 1.0, 0.0, 1.0)

    private fun homographyOnto(corners: DoubleArray): DoubleArray =
        DoubleArray(9).also { assertTrue(LayerGeometry.squareToQuad(corners, it)) }

    @Test
    fun `the wire's corners become GL's, y turned up`() {
        val ndc = LayerGeometry.fractionsToNdc(trapezoid.toDoubleArray(), DoubleArray(8))
        assertArrayEquals(doubleArrayOf(-0.2, 0.4, 0.2, 0.4, 0.8, -0.4, -0.8, -0.4), ndc, 1e-12)
    }

    @Test
    fun `the bitmap's rectangle goes onto the quad, corner for corner, and back`() {
        val quad = LayerGeometry.fractionsToNdc(trapezoid.toDoubleArray(), DoubleArray(8))
        val h = homographyOnto(quad)
        val inverse = DoubleArray(9).also { assertTrue(LayerGeometry.invert(h, it)) }
        val p = DoubleArray(3)
        for (k in 0 until 4) {
            LayerGeometry.map(h, unit[2 * k], unit[2 * k + 1], p)
            assertEquals(quad[2 * k], p[0], 1e-12)
            assertEquals(quad[2 * k + 1], p[1], 1e-12)
            assertTrue("corner $k has weight ${p[2]}", p[2] > 0.0)
            LayerGeometry.map(inverse, quad[2 * k], quad[2 * k + 1], p)
            assertEquals(unit[2 * k], p[0], 1e-12)
            assertEquals(unit[2 * k + 1], p[1], 1e-12)
        }
        // And any point of the bitmap comes back to itself.
        LayerGeometry.map(h, 0.3, 0.8, p)
        LayerGeometry.map(inverse, p[0], p[1], p)
        assertEquals(0.3, p[0], 1e-12)
        assertEquals(0.8, p[1], 1e-12)
    }

    @Test
    fun `the bitmap's middle lands where the diagonals cross, which is what GL finds by dividing by w`() {
        // A floor running away from the camera, in NDC: narrow at the top, wide at the bottom.
        val h = homographyOnto(doubleArrayOf(-0.5, 0.5, 0.5, 0.5, 1.0, -0.5, -1.0, -0.5))
        val p = LayerGeometry.map(h, 0.5, 0.5, DoubleArray(3))
        // The diagonals cross at (0, 1/6): above the middle of the screen, because the far half is drawn smaller.
        assertEquals(0.0, p[0], 1e-12)
        assertEquals(1.0 / 6.0, p[1], 1e-12)
        // What the rasteriser does along the diagonal from the first corner (u, v = 0) to the third (1): each
        // varying over w interpolated on the screen, divided by 1 / w interpolated the same way. The crossing
        // is a third of the way along that diagonal on the screen, and there it reads the bitmap's middle.
        val w0 = LayerGeometry.map(h, 0.0, 0.0, DoubleArray(3))[2]
        val w2 = LayerGeometry.map(h, 1.0, 1.0, DoubleArray(3))[2]
        val along = (1.0 / 6.0 - 0.5) / (-0.5 - 0.5)
        assertEquals(1.0 / 3.0, along, 1e-12)
        val u = (along * 1.0 / w2) / ((1 - along) / w0 + along / w2)
        assertEquals(0.5, u, 1e-12)
        // Read without the weights, as an affine draw would, it is a third of the way across the bitmap: sheared.
        assertEquals(1.0 / 3.0, along * 1.0, 1e-12)
    }

    @Test
    fun `the matrix goes to GL column by column, which is what the vertex shader multiplies`() {
        val h = homographyOnto(LayerGeometry.fractionsToNdc(trapezoid.toDoubleArray(), DoubleArray(8)))
        val gl = FloatArray(9)
        assertTrue(LayerGeometry.toGl(h, gl))
        // uHomography * vec3(u, v, 1), a column-major mat3, is H's two numerators and its weight.
        val u = 0.7
        val v = 0.2
        val x = gl[0] * u + gl[3] * v + gl[6]
        val y = gl[1] * u + gl[4] * v + gl[7]
        val w = gl[2] * u + gl[5] * v + gl[8]
        val p = LayerGeometry.map(h, u, v, DoubleArray(3))
        assertEquals(p[0], x / w, 1e-6)
        assertEquals(p[1], y / w, 1e-6)
        assertEquals(p[2], w, 1e-6)
        assertArrayEquals(floatArrayOf(1f, 4f, 7f, 2f, 5f, 8f, 3f, 6f, 9f), FloatArray(9).also { LayerGeometry.toGl(DoubleArray(9) { k -> k + 1.0 }, it) }, 0f)
        assertFalse(LayerGeometry.toGl(doubleArrayOf(1e300, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 1.0), gl))
    }

    @Test
    fun `a flat layer's parallelogram is drawn affine, with a weight of one at every corner`() {
        val h = homographyOnto(doubleArrayOf(-0.4, 0.3, 0.2, 0.5, 0.4, -0.1, -0.2, -0.3))
        assertEquals(0.0, h[6], 1e-12)
        assertEquals(0.0, h[7], 1e-12)
        assertEquals(1.0, h[8], 0.0)
    }

    @Test
    fun `a quad no homography draws whole draws nothing, and a mirrored one is drawn`() {
        val out = DoubleArray(9)
        // Three corners on one line.
        assertFalse(LayerGeometry.squareToQuad(doubleArrayOf(0.0, 0.0, 0.5, 0.0, 1.0, 0.0, 0.0, 1.0), out))
        // A corner pushed in past the diagonal.
        assertFalse(LayerGeometry.squareToQuad(doubleArrayOf(-1.0, 1.0, 1.0, 1.0, -0.2, 0.2, -1.0, -1.0), out))
        // Two sides crossed: the top corners swapped over.
        assertFalse(LayerGeometry.squareToQuad(doubleArrayOf(1.0, 1.0, -1.0, 1.0, 1.0, -1.0, -1.0, -1.0), out))
        // Every corner in one place.
        assertFalse(LayerGeometry.squareToQuad(DoubleArray(8) { 0.25 }, out))
        // The floor seen from behind - its corners in the other winding - is a quad like any other.
        assertTrue(LayerGeometry.squareToQuad(doubleArrayOf(0.5, 0.5, -0.5, 0.5, -1.0, -0.5, 1.0, -0.5), out))
    }

    /* ------------------------------------------------------------------------------------- */
    /* A flat layer drawn here                                                                 */
    /* ------------------------------------------------------------------------------------- */

    private val rest = OverlayPose(anchorX = 0f, anchorY = 0f, scaleX = 1f, scaleY = 1f, rotationGlDeg = 0f, alpha = 1f)

    @Test
    fun `a flat layer's corners are where Media3 puts it, its size in pixels and its turn on the screen`() {
        // A 100 x 50 bitmap at its own size in the middle of a 720 x 1280 frame.
        val out = DoubleArray(8)
        val x = 100.0 / 720.0
        val y = 50.0 / 1280.0
        LayerGeometry.poseCorners(rest, 100, 50, 720, 1280, out)
        assertArrayEquals(doubleArrayOf(-x, y, x, y, x, -y, -x, -y), out, 1e-12)
        // A PNG decoded at half size and stretched back to its 100 x 50 covers the very same corners.
        LayerGeometry.poseCorners(rest.copy(scaleX = 2f, scaleY = 2f), 50, 25, 720, 1280, out)
        assertArrayEquals(doubleArrayOf(-x, y, x, y, x, -y, -x, -y), out, 1e-12)
        // A quarter turn counter-clockwise as GL counts - CSS's -90deg - is a turn in pixels: the top-left
        // corner goes 25 px left of the centre and 50 px down, so the layer stands 50 wide and 100 tall.
        LayerGeometry.poseCorners(rest.copy(rotationGlDeg = 90f), 100, 50, 720, 1280, out)
        assertEquals(-25.0 * 2 / 720, out[0], 1e-9)
        assertEquals(-50.0 * 2 / 1280, out[1], 1e-9)
        assertEquals(25.0 * 2 / 720, out[4], 1e-9)
        assertEquals(50.0 * 2 / 1280, out[5], 1e-9)
        // Placed at its centre wherever that is, off the frame included, where Media3's two anchors put it.
        val edge = OverlayPose(0.9f, 0f, 1f, 1f, 0f, 1f, halfWidth = 100f / 720f, halfHeight = 50f / 1280f)
        val moved = edge.moved(MotionSample(x = 0.1, y = 0.0, scale = 1.0, rotation = 0.0, opacity = 1.0))
        val anchors = moved.anchors()!!
        LayerGeometry.poseCorners(moved, 100, 50, 720, 1280, out)
        assertEquals((anchors.backgroundX - moved.halfWidth * anchors.overlayX).toDouble(), (out[0] + out[2]) / 2, 1e-6)
        assertEquals(moved.halfWidth.toDouble(), (out[2] - out[0]) / 2, 1e-6)
        // Its four corners make a parallelogram, which the homography draws as the affine map it is.
        val h = homographyOnto(LayerGeometry.poseCorners(rest.copy(rotationGlDeg = 30f, scaleX = 1.5f), 100, 50, 720, 1280, out))
        assertEquals(0.0, h[6], 1e-9)
        assertEquals(0.0, h[7], 1e-9)
    }

    /**
     * A bitmap the JVM can hold: the framework's stub, made without running a constructor. The layer below
     * never reads a pixel of it - it is only carried to [LayerUnderlayEffect].
     */
    private fun stubBitmap(): Bitmap {
        val unsafeClass = Class.forName("sun.misc.Unsafe")
        val unsafe = unsafeClass.getDeclaredField("theUnsafe").apply { isAccessible = true }.get(null)
        return unsafeClass.getMethod("allocateInstance", Class::class.java).invoke(unsafe, Bitmap::class.java) as Bitmap
    }

    @Test
    fun `a layer drawn here is read as Media3 reads it, hidden outside its window, moved by its motion, lit by its opacity`() {
        val pop = OverlayMotion(
            atMs = doubleArrayOf(500.0, 1000.0),
            x = doubleArrayOf(0.0, 0.25),
            y = null,
            scale = null,
            rotation = null,
            opacity = doubleArrayOf(0.5, 1.0),
        )
        val overlay = TimedBitmapOverlay(
            bitmap = stubBitmap(),
            startUs = 250_000L,
            endUs = 2_000_000L,
            anchorX = 0f,
            anchorY = 0f,
            rotationGlDeg = 0f,
            opacity = 0.8f,
            scaleX = 1f,
            scaleY = 1f,
            halfWidth = 100f / 720f,
            halfHeight = 50f / 1280f,
            motion = pop,
        )
        assertNull(overlay.poseAt(0L))
        assertNull(overlay.poseAt(2_000_000L))
        assertEquals(0f, overlay.alphaAt(2_000_000L), 0f)
        // Half way through the motion: an eighth of the width to the right - 0.25 in NDC - at 0.75 of its 0.8.
        val moving = overlay.poseAt(750_000L)!!
        assertEquals(0.25f, moving.anchorX, 1e-6f)
        assertEquals(0.6f, moving.alpha, 1e-6f)
        assertEquals(0.6f, overlay.alphaAt(750_000L), 1e-6f)
        // Past its last key the motion holds its end, as Media3 is handed it.
        assertEquals(0.5f, overlay.poseAt(1_500_000L)!!.anchorX, 1e-6f)
        assertEquals(0.8f, overlay.alphaAt(1_500_000L), 1e-6f)
        // A still layer rests where it was put, and one at no opacity draws nothing.
        val still = TimedBitmapOverlay(stubBitmap(), 0L, 1_000_000L, 0.5f, -0.25f, 10f, 1f, 1f, 1f)
        assertEquals(OverlayPose(0.5f, -0.25f, 1f, 1f, 10f, 1f), still.poseAt(0L))
        assertEquals(1f, still.alphaAt(999_999L), 0f)
        assertNull(TimedBitmapOverlay(stubBitmap(), 0L, 1_000_000L, 0f, 0f, 0f, 0f, 1f, 1f).poseAt(0L))
    }
}
