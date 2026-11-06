package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Assert.assertTrue
import org.junit.Assert.fail
import org.junit.Test

/**
 * The people matte on Android: `ComposeSpec.matte` read off the wire by a focus's own rules, kept by the plan
 * only for a layer behind it, and read at an OUTPUT time exactly as a focus is read at a source time - the
 * levels on straight lines between keys, and the grid of the track's two frames either side mixed by how far
 * between them the instant is - which is what [LayerUnderlayEffect] uploads and eases.
 */
class PeopleMatteTest {

    private fun overlayJson(id: String, behind: Boolean = false): JSONObject = JSONObject()
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
        .apply { if (behind) put("behind", true) }

    private fun specJson(matte: Any?, vararg overlays: JSONObject): JSONObject = JSONObject(
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
    ).put("overlays", JSONArray(overlays.toList())).apply { if (matte != null) put("matte", matte) }

    private fun subject(id: Any?, levels: List<Any?>): JSONObject = JSONObject().put("id", id).put("focus", JSONArray(levels))

    private fun matteJson(atMs: List<Any?> = listOf(0, 1000), vararg subjects: JSONObject): JSONObject = JSONObject()
        .put("uri", "file:///data/cache/matte.vkst")
        .put("atMs", JSONArray(atMs))
        .put("subjects", JSONArray(subjects.toList()))

    private fun matteOf(matte: Any?): Matte? = ComposeSpecParser.parse(specJson(matte)).matte

    private fun expectInvalid(path: String, message: String? = null, json: () -> JSONObject) {
        try {
            ComposeSpecParser.parse(json())
            fail("expected invalid_spec:$path")
        } catch (e: SpecException) {
            assertEquals(path, e.path)
            if (message != null) assertEquals(message, e.message)
        }
    }

    private fun expectInvalidMatte(path: String, matte: Any, message: String? = null) =
        expectInvalid(path, message) { specJson(matte) }

    @Test
    fun `no matte and a null one are none`() {
        assertNull(matteOf(null))
        assertNull(matteOf(JSONObject.NULL))
    }

    @Test
    fun `a matte is read as a focus's keys are, every level held to 0 to 1 and every key it does not know ignored`() {
        val matte = matteOf(
            matteJson(listOf(0, 500, 500, 1000), subject(1, listOf(0, 1.5, 1, -2)), subject(7, listOf(1, 1, 1, 1)))
                .put("blur", "not a focus")
                .put("invert", true),
        )!!
        assertEquals("file:///data/cache/matte.vkst", matte.uri)
        assertEquals(listOf(0.0, 500.0, 500.0, 1000.0), matte.atMs)
        assertEquals(listOf(FocusSubject(1, listOf(0.0, 1.0, 1.0, 0.0)), FocusSubject(7, listOf(1.0, 1.0, 1.0, 1.0))), matte.subjects)
        // Nobody listed is a matte too: every layer behind, nobody put back.
        assertTrue(matteOf(matteJson())!!.subjects.isEmpty())
    }

    @Test
    fun `a matte of the wrong shape is refused as a focus would be, at its own path`() {
        expectInvalidMatte("matte", "people")
        expectInvalidMatte("matte", JSONArray())
        expectInvalidMatte("matte.uri", matteJson().put("uri", ""))
        expectInvalidMatte("matte.uri", matteJson().put("uri", 7))
        expectInvalidMatte("matte.atMs", matteJson().put("atMs", "0"))
        expectInvalidMatte("matte.atMs", matteJson(emptyList()), "invalid_spec:matte.atMs must have 1 to 2000 keys")
        expectInvalidMatte("matte.atMs", matteJson((0..2000).toList()), "invalid_spec:matte.atMs must have 1 to 2000 keys")
        expectInvalidMatte("matte.atMs[1]", matteJson(listOf(0, "1")))
        expectInvalidMatte("matte.atMs[2]", matteJson(listOf(0, 10, 9)))
        expectInvalidMatte("matte.subjects", matteJson().put("subjects", JSONObject()))
        expectInvalidMatte("matte.subjects[0]", matteJson().put("subjects", JSONArray().put(1)))
        expectInvalidMatte("matte.subjects[0].id", matteJson(listOf(0, 1000), subject(0, listOf(1, 1))))
        expectInvalidMatte("matte.subjects[0].id", matteJson(listOf(0, 1000), subject(256, listOf(1, 1))))
        expectInvalidMatte("matte.subjects[0].id", matteJson(listOf(0, 1000), subject(1.5, listOf(1, 1))))
        expectInvalidMatte("matte.subjects[1].id", matteJson(listOf(0, 1000), subject(3, listOf(1, 1)), subject(3, listOf(0, 0))))
        expectInvalidMatte("matte.subjects[0].focus", matteJson(listOf(0, 1000), subject(1, listOf(1))))
        expectInvalidMatte("matte.subjects[0].focus[1]", matteJson(listOf(0, 1000), subject(1, listOf(1, "1"))))
    }

    @Test
    fun `the matte is read after the rest of the spec`() {
        expectInvalid("background") { specJson("people").put("background", "red") }
        expectInvalid("overlays[0].id") { specJson("people", overlayJson("")) }
    }

    @Test
    fun `a matte is kept only for a layer behind it, and a layer is behind only with a matte`() {
        val matte = matteJson(listOf(0), subject(1, listOf(1)))
        val nobodyBehind = RenderPlan.build(ComposeSpecParser.parse(specJson(matte, overlayJson("a"))), emptyMap())
        assertNull(nobodyBehind.matte)
        assertFalse(nobodyBehind.overlays[0].drawnUnder)

        val spec = ComposeSpecParser.parse(specJson(matte, overlayJson("a"), overlayJson("b", behind = true)))
        val plan = RenderPlan.build(spec, emptyMap())
        assertSame(spec.matte, plan.matte)
        assertFalse(plan.overlays[0].behind)
        assertFalse(plan.overlays[0].drawnUnder)
        assertTrue(plan.overlays[1].behind)
        assertTrue(plan.overlays[1].drawnUnder)
        // The plan the job keeps keeps the matte.
        assertSame(spec.matte, spec.withoutOverlayPixels().matte)
        val (under, over) = CompositionBuilder.splitUnderlay(plan.overlays, listOf("a", "b"))
        assertEquals(listOf("b"), under.map { it.first })
        assertEquals(listOf("a"), over)

        val noMatte = RenderPlan.build(ComposeSpecParser.parse(specJson(null, overlayJson("b", behind = true))), emptyMap())
        assertNull(noMatte.matte)
        assertFalse(noMatte.overlays[0].behind)
        assertFalse(noMatte.overlays[0].drawnUnder)
    }

    @Test
    fun `the levels at an output time between two keys are on the straight line between them`() {
        val matte = matteOf(matteJson(listOf(1000, 2000, 3000), subject(1, listOf(0, 1, 1)), subject(2, listOf(1, 0.5, 0))))!!
        val keys = FocusKeys.of(matte.atMs, matte.subjects)
        fun levelsAt(ms: Double): List<Float> = SubjectTracks.focusLevels(keys, ms).copyOfRange(0, 4).toList()
        assertEquals(listOf(0f, 0f, 1f, 0f), levelsAt(0.0))
        assertEquals(listOf(0f, 0.25f, 0.875f, 0f), levelsAt(1250.0))
        assertEquals(listOf(0f, 1f, 0.25f, 0f), levelsAt(2500.0))
        assertEquals(listOf(0f, 1f, 0f, 0f), levelsAt(9000.0))
        // The same keys made from a focus are the same keys.
        val focus = Focus(uri = matte.uri, atMs = matte.atMs, subjects = matte.subjects, blur = 0.01f)
        assertEquals(levelsAt(1250.0), SubjectTracks.focusLevels(FocusKeys.of(focus), 1250.0).copyOfRange(0, 4).toList())
    }

    @Test
    fun `the mask at an output time between two frames of the track mixes them, cell for cell`() {
        // A 4 x 2 grid over the OUTPUT frame: subject 1 on the left half at 0 ms, everywhere at 100 ms.
        val meta = SubjectTrackMeta("mediapipe", MediaLabels.Kind.VIDEO, 100, 10.0, emptyList())
        val left = intArrayOf(1, 1, 0, 0, 1, 1, 0, 0).map { it.toByte() }.toByteArray()
        val all = ByteArray(8) { 1 }
        val track = SubjectTracks.parse(SubjectTracks.encode(SubjectTrackContent(4, 2, listOf(0L, 100L), listOf(left, all), meta)))
        // Subject 1 coming in over the same 100 ms.
        val matte = matteOf(matteJson(listOf(0, 100), subject(1, listOf(0, 1))))!!
        val levels = SubjectTracks.focusLevels(FocusKeys.of(matte.atMs, matte.subjects), 50.0)
        assertEquals(0.5f, levels[1], 0f)
        val cells = SubjectTracks.focusMask(track, levels, 50.0, false).map { it.toInt() and 0xff }
        // Half way: the left half is the person at half level in both frames, the right half only in the second.
        assertEquals(listOf(128, 128, 64, 64, 128, 128, 64, 64), cells)
    }
}
