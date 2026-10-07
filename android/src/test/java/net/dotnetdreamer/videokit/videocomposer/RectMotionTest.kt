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
 * A split screen that opens and closes: the keys a clip's rectangle moves by, read off the wire the
 * way the browser reads them, and the plan that draws a moving layer into the whole frame.
 *
 * The readings and refusals are `layout-motion.unit.test.ts`'s, case for case, because the same spec
 * has to be the same picture - or the same refusal - on every engine.
 */
class RectMotionTest {

    private fun motion(atMs: DoubleArray, x: DoubleArray, y: DoubleArray, w: DoubleArray, h: DoubleArray) =
        RectMotion(atMs, x, y, w, h)

    private fun assertRect(x: Float, y: Float, w: Float, h: Float, actual: Rect) {
        assertEquals(x, actual.x, 1e-5f)
        assertEquals(y, actual.y, 1e-5f)
        assertEquals(w, actual.w, 1e-5f)
        assertEquals(h, actual.h, 1e-5f)
    }

    /* ------------------------------------------------------------------------------------- */
    /* Reading                                                                                 */
    /* ------------------------------------------------------------------------------------- */

    @Test
    fun `the keys are read as the camera is read - ends hold, straight lines between, a step to the later key`() {
        val keys = motion(
            doubleArrayOf(100.0, 200.0, 200.0, 300.0),
            doubleArrayOf(0.0, 1.0, 2.0, 3.0),
            doubleArrayOf(0.0, 0.0, 0.0, 0.0),
            doubleArrayOf(1.0, 1.0, 1.0, 1.0),
            doubleArrayOf(1.0, 1.0, 1.0, 1.0),
        )
        assertEquals(0f, keys.at(0.0).x, 0f)
        assertEquals(0.5f, keys.at(150.0).x, 1e-6f)
        assertEquals(2f, keys.at(200.0).x, 0f)
        assertEquals(2.5f, keys.at(250.0).x, 1e-6f)
        assertEquals(3f, keys.at(999.0).x, 0f)
        // Media3's microseconds, read on the same milliseconds.
        assertEquals(0.5f, keys.atUs(150_000L).x, 1e-6f)
    }

    @Test
    fun `a rectangle under half an output pixel either way draws nothing`() {
        assertTrue(RectMotion.drawsNothing(Rect(0f, 1f, 1f, 0f), 720, 1280))
        assertTrue(RectMotion.drawsNothing(Rect(0f, 0f, 0.0001f, 1f), 720, 1280))
        assertFalse(RectMotion.drawsNothing(Rect(0f, 0.99f, 1f, 0.001f), 720, 1280))
    }

    /* ------------------------------------------------------------------------------------- */
    /* Parsing                                                                                 */
    /* ------------------------------------------------------------------------------------- */

    private fun specJson(rectMotion: Any?, onLayer: Boolean = false): JSONObject {
        val clip = JSONObject(
            """{ "key": "a", "uri": "file:///a.mp4", "inMs": 0, "outMs": 4000, "fit": "cover",
                 "rect": { "x": 0, "y": 0.5, "w": 1, "h": 0.5 } }""",
        )
        if (rectMotion != null) clip.put("rectMotion", rectMotion)
        val json = JSONObject(
            """
            {
              "jobId": "job-1",
              "batchId": "post-1",
              "clips": [ { "key": "base", "uri": "file:///base.mp4", "inMs": 0, "outMs": 4000 } ],
              "output": { "width": 720, "height": 1280, "fps": 30, "videoBitrate": 4000000, "audioBitrate": 128000 },
              "filter": [],
              "overlays": [],
              "audio": { "originalMuted": false, "originalVolume": 1, "music": null, "voiceover": [] },
              "posterAtMs": 0
            }
            """.trimIndent(),
        )
        if (onLayer) {
            json.put("tracks", JSONArray().put(JSONObject().put("id", "t").put("z", 1).put("clips", JSONArray().put(clip))))
        } else {
            json.put("clips", JSONArray().put(clip))
        }
        return json
    }

    private fun keys(
        atMs: List<Any?> = listOf(0, 100),
        x: List<Any?> = listOf(0, 0),
        y: List<Any?> = listOf(1, 0.5),
        w: List<Any?> = listOf(1, 1),
        h: List<Any?> = listOf(0.5, 0.5),
    ): JSONObject = JSONObject()
        .put("atMs", JSONArray(atMs))
        .put("x", JSONArray(x))
        .put("y", JSONArray(y))
        .put("w", JSONArray(w))
        .put("h", JSONArray(h))

    private fun refused(rectMotion: Any?, onLayer: Boolean = false): SpecException {
        try {
            ComposeSpecParser.parse(specJson(rectMotion, onLayer))
        } catch (e: SpecException) {
            return e
        }
        fail("expected a refusal")
        throw AssertionError()
    }

    @Test
    fun `a clip with no motion holds still, and one with keys carries them clamped`() {
        assertNull(ComposeSpecParser.parse(specJson(null)).clips[0].rectMotion)
        val read = ComposeSpecParser.parse(specJson(keys(x = listOf(9, -9), w = listOf(-1, 5)))).clips[0].rectMotion
        assertNotNull(read)
        assertEquals(listOf(4.0, -4.0), read!!.x.toList())
        assertEquals(listOf(0.0, 2.0), read.w.toList())
        assertEquals(listOf(1.0, 0.5), read.y.toList())
        // The resting rectangle is read as it always was, beside them.
        assertEquals(0.5f, ComposeSpecParser.parse(specJson(keys())).clips[0].rect!!.y, 0f)
    }

    @Test
    fun `a layer clip's keys are read the same way, at its own path`() {
        val spec = ComposeSpecParser.parse(specJson(keys(), onLayer = true))
        assertNotNull(spec.tracks[0].clips[0].rectMotion)
        assertEquals("tracks[0].clips[0].rectMotion.atMs[1]", refused(keys(atMs = listOf(100, 50)), onLayer = true).path)
    }

    @Test
    fun `a motion no engine could draw is refused naming what broke, in the browser's order`() {
        assertEquals("clips[0].rectMotion", refused("keys").path)
        assertEquals("clips[0].rectMotion.atMs", refused(JSONObject().put("x", JSONArray())).path)
        assertEquals("clips[0].rectMotion.x", refused(keys(x = listOf(0))).path)
        assertEquals("clips[0].rectMotion.h", refused(keys().put("h", "tall")).path)
        assertEquals("clips[0].rectMotion.rotation", refused(keys().put("zz", JSONArray()).put("rotation", JSONArray())).path)
        val empty = refused(keys(atMs = emptyList(), x = emptyList(), y = emptyList(), w = emptyList(), h = emptyList()))
        assertEquals("clips[0].rectMotion", empty.path)
        assertEquals("invalid_spec:clips[0].rectMotion must have 1 to 6000 keys", empty.message)
        assertEquals("clips[0].rectMotion.atMs[1]", refused(keys(atMs = listOf(100, 50))).path)
        assertEquals("clips[0].rectMotion.atMs[1]", refused(keys(atMs = listOf(0, "soon"))).path)
        assertEquals("clips[0].rectMotion.w[1]", refused(keys(w = listOf(1, JSONObject.NULL))).path)
    }

    /* ------------------------------------------------------------------------------------- */
    /* Planning                                                                                */
    /* ------------------------------------------------------------------------------------- */

    private val output = Output(720, 1280, 30, 4_000_000, 128_000)

    private fun planWith(layerClip: Clip): RenderPlan = RenderPlan.build(
        ComposeSpec(
            jobId = "job",
            batchId = "post",
            clips = listOf(Clip("base", "file:///base.mp4", 0, 4_000, 1f, 1f, false, Fit.COVER)),
            output = output,
            filter = emptyList(),
            overlays = emptyList(),
            audio = Audio(false, 1f, null, emptyList()),
            posterAtMs = 0,
            tracks = listOf(Track("t", listOf(layerClip), 1_000, 1, 0.8f)),
        ),
        emptyMap(),
    )

    private val slidingIn = motion(
        doubleArrayOf(1_000.0, 1_600.0),
        doubleArrayOf(0.0, 0.0),
        doubleArrayOf(1.0, 0.5),
        doubleArrayOf(1.0, 1.0),
        doubleArrayOf(0.5, 0.5),
    )

    @Test
    fun `a layer whose rectangle moves is drawn into the whole frame, keeping the keys that place it`() {
        val clip = Clip("b", "file:///b.mp4", 0, 2_000, 1f, 1f, false, Fit.COVER, rect = Placement(0f, 0.5f, 1f, 0.5f, null), rectMotion = slidingIn)
        val track = planWith(clip).tracks.single()
        val planned = track.clips.single()
        assertEquals(output.width, planned.frame.width)
        assertEquals(output.height, planned.frame.height)
        assertTrue(planned.reframed)
        assertSame(slidingIn, planned.clip.rectMotion)
        assertNotNull(planned.clip.rect)
        val placement = track.placements.single()
        assertTrue(placement.wholeFrame)
        assertFalse(placement.zoomed)
        assertEquals(1_000_000L, placement.startUs)
        assertEquals(3_000_000L, placement.endUs)
        assertEquals(0.8f, track.opacity, 0f)
    }

    @Test
    fun `a layer that holds still is planned exactly as it always was`() {
        val clip = Clip("b", "file:///b.mp4", 0, 2_000, 1f, 1f, false, Fit.COVER, rect = Placement(0f, 0.5f, 1f, 0.5f, null))
        val track = planWith(clip).tracks.single()
        val planned = track.clips.single()
        assertEquals(720, planned.frame.width)
        assertEquals(640, planned.frame.height)
        assertNull(planned.clip.rect)
        assertFalse(track.placements.single().wholeFrame)
    }

    @Test
    fun `the window for a rectangle at one frame is the window a clip resting there has`() {
        val resting = Clip("b", "file:///b.mp4", 0, 2_000, 1f, 1f, false, Fit.COVER, rect = Placement(0f, 0.25f, 1f, 0.75f, null))
        val moving = resting.copy(rect = Placement(0f, 0.5f, 1f, 0.5f, null), rectMotion = slidingIn)
        val expected = RenderPlan.sourceWindow(resting, output, 1080, 1920)
        val actual = RenderPlan.sourceWindow(moving, output, 1080, 1920, Rect(0f, 0.25f, 1f, 0.75f))
        assertRect(expected.x, expected.y, expected.w, expected.h, actual)
        // Read off the keys half way through the slide.
        assertRect(0f, 0.75f, 1f, 0.5f, slidingIn.at(1_300.0))
    }

    @Test
    fun `a half sliding in from the top shows nothing below its own edge`() {
        // What a phone export showed: a 9:16 clip covering the top half of a 9:16 frame, half way in
        // (its rectangle at y -0.25). Its picture is twice the half's height, so drawn through the
        // one-matrix window it reached a quarter of the frame past the rectangle - the half looked a
        // quarter open on its first frame, and the two halves met a quarter off the middle.
        val clip = Clip("b", "file:///b.mp4", 0, 2_000, 1f, 1f, false, Fit.COVER, rect = Placement(0f, 0f, 1f, 0.5f, null))
        val halfWay = Rect(0f, -0.25f, 1f, 0.5f)
        val window = RenderPlan.sourceWindow(clip, output, 1080, 1920, halfWay)
        assertEquals(0.5f, (1f - window.y) / window.h, 1e-5f)

        // Cut to the half's own share of the picture and then placed, its bottom edge is the
        // rectangle's: a quarter of the frame down (NDC 0.5), and nothing of it below.
        val (source, target) = RenderPlan.fitBoxes(clip, output, 1080, 1920, halfWay)
        assertRect(0f, 0.25f, 1f, 0.5f, source)
        val bottomNdc = RenderPlan.placeInto(target).y(RenderPlan.cutOnto(source).y(1f - 2f * (source.y + source.h)))
        assertEquals(0.5f, bottomNdc, 1e-5f)
    }
}
