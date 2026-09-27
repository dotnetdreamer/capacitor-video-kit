package net.dotnetdreamer.videokit.videocomposer

import android.media.ExifInterface
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/**
 * The parts of `labelMedia` that need neither a decoder nor ML Kit: which frames a video is looked
 * at in, how a picture is decoded and turned, and what goes back across the bridge. [plan]'s times
 * are held to iOS's `MediaLabelsTests` case for case, because the two phones plan the same frames;
 * [cuts] is Android's alone, because only here is an exact frame expensive.
 */
class MediaLabelsTest {

    @Test
    fun `spreads the frames through the clip, each in its own share`() {
        assertEquals(listOf(1000L, 3000L, 5000L, 7000L, 9000L), MediaLabels.plan(10_000L, emptyList(), 5).times)
    }

    @Test
    fun `holds times inside the clip and asks for each once`() {
        assertEquals(listOf(0L, 1000L, 3999L), MediaLabels.plan(4000L, listOf(-5L, 1000L, 1000L, 99_999L), 5).times)
    }

    @Test
    fun `looks once at the middle for one frame, and at the start for a clip of no length`() {
        assertEquals(listOf(3000L), MediaLabels.plan(6000L, emptyList(), 1).times)
        assertEquals(listOf(0L), MediaLabels.plan(0L, listOf(500L), 5).times)
    }

    @Test
    fun `never looks at more than twenty frames, or fewer than one`() {
        assertEquals(20, MediaLabels.plan(100_000L, emptyList(), 50).times.size)
        assertEquals(1, MediaLabels.plan(100_000L, emptyList(), 0).times.size)
    }

    @Test
    fun `cuts each time at its keyframe when a phone's keyframes give every frame`() {
        // A phone video: a keyframe every second.
        val cuts = MediaLabels.cuts(listOf(1000L, 3000L, 5000L, 7000L, 9000L), listOf(1000L, 3000L, 5000L, 7000L, 9000L))
        assertEquals(listOf(1000L, 3000L, 5000L, 7000L, 9000L), cuts.map { it.keyframeMs })
    }

    @Test
    fun `takes two times that meet at one keyframe as one frame, and cuts nothing exactly past three`() {
        // The game capture measured on the emulator: keyframes at 0, 3.6 s and 7.766 s.
        val cuts = MediaLabels.cuts(listOf(800L, 2400L, 4000L, 5600L, 7200L), listOf(0L, 3600L, 3600L, 3600L, 7766L))
        assertEquals(listOf(MediaLabels.Cut(800L, 0L), MediaLabels.Cut(2400L, 3600L), MediaLabels.Cut(7200L, 7766L)), cuts)
    }

    @Test
    fun `cuts the times furthest from a lone keyframe exactly until there are three frames`() {
        // One keyframe, at the start, for the whole clip.
        val cuts = MediaLabels.cuts(listOf(800L, 2400L, 4000L, 5600L, 7200L), listOf(0L, 0L, 0L, 0L, 0L))
        assertEquals(listOf(MediaLabels.Cut(800L, 0L), MediaLabels.Cut(5600L, null), MediaLabels.Cut(7200L, null)), cuts)
    }

    @Test
    fun `wants no more frames than there are times`() {
        assertEquals(listOf(MediaLabels.Cut(3000L, 2000L)), MediaLabels.cuts(listOf(3000L), listOf(2000L)))
        // Two times at one keyframe: one keyframe, and the other time exactly.
        assertEquals(
            listOf(MediaLabels.Cut(1000L, 0L), MediaLabels.Cut(3000L, null)),
            MediaLabels.cuts(listOf(1000L, 3000L), listOf(0L, 0L)),
        )
    }

    @Test
    fun `cuts a time exactly when the index could not say where its keyframe is`() {
        assertEquals(
            listOf(MediaLabels.Cut(1000L, null), MediaLabels.Cut(3000L, null)),
            MediaLabels.cuts(listOf(1000L, 3000L), listOf(null, null)),
        )
    }

    @Test
    fun `decodes a picture at the largest power-of-two step that keeps its long edge at the look size`() {
        assertEquals(1, MediaLabels.sampleSize(600, 400, 720))
        assertEquals(1, MediaLabels.sampleSize(1439, 1000, 720))
        assertEquals(2, MediaLabels.sampleSize(1440, 1080, 720))
        // A 48 megapixel photo: 8000 / 8 = 1000, and 8000 / 16 would be under 720.
        assertEquals(8, MediaLabels.sampleSize(8000, 6000, 720))
        assertEquals(8, MediaLabels.sampleSize(6000, 8000, 720))
    }

    @Test
    fun `turns a picture by its orientation tag, a mirror counted as its turn alone`() {
        assertEquals(0, MediaLabels.rotationFor(ExifInterface.ORIENTATION_NORMAL))
        assertEquals(0, MediaLabels.rotationFor(ExifInterface.ORIENTATION_UNDEFINED))
        assertEquals(0, MediaLabels.rotationFor(ExifInterface.ORIENTATION_FLIP_HORIZONTAL))
        assertEquals(90, MediaLabels.rotationFor(ExifInterface.ORIENTATION_ROTATE_90))
        assertEquals(90, MediaLabels.rotationFor(ExifInterface.ORIENTATION_TRANSPOSE))
        assertEquals(180, MediaLabels.rotationFor(ExifInterface.ORIENTATION_ROTATE_180))
        assertEquals(180, MediaLabels.rotationFor(ExifInterface.ORIENTATION_FLIP_VERTICAL))
        assertEquals(270, MediaLabels.rotationFor(ExifInterface.ORIENTATION_ROTATE_270))
        assertEquals(270, MediaLabels.rotationFor(ExifInterface.ORIENTATION_TRANSVERSE))
    }

    @Test
    fun `reads the two kinds by their wire names and nothing else`() {
        assertEquals(MediaLabels.Kind.VIDEO, MediaLabels.Kind.of("video"))
        assertEquals(MediaLabels.Kind.IMAGE, MediaLabels.Kind.of("image"))
        assertNull(MediaLabels.Kind.of("audio"))
        assertNull(MediaLabels.Kind.of("Image"))
    }

    @Test
    fun `answers in the shape iOS answers in, with ML Kit's own label names`() {
        val result = MediaLabels.Result(
            MediaLabels.Kind.VIDEO,
            listOf(
                MediaLabels.Frame(1000L, listOf(MediaLabels.Label("Fast food", 0.91234f), MediaLabels.Label("Cuisine", 0.8f))),
                MediaLabels.Frame(3000L, emptyList()),
            ),
        )
        val json = result.toJson()
        assertEquals("mlkit", json.getString("engine"))
        assertEquals("video", json.getString("kind"))
        // No revision: ML Kit's model is the one the kit is built with.
        assertEquals(false, json.has("revision"))
        val frames = json.getJSONArray("frames")
        assertEquals(2, frames.length())
        assertEquals(1000L, frames.getJSONObject(0).getLong("timeMs"))
        val first = frames.getJSONObject(0).getJSONArray("labels").getJSONObject(0)
        assertEquals("Fast food", first.getString("label"))
        assertEquals(0.912, first.getDouble("confidence"), 0.0)
        assertEquals(0, frames.getJSONObject(1).getJSONArray("labels").length())
    }

    @Test
    fun `rounds a confidence to three places`() {
        assertEquals(0.5, MediaLabels.rounded(0.4996f), 0.0)
        assertEquals(0.123, MediaLabels.rounded(0.12345f), 0.0)
        assertEquals(1.0, MediaLabels.rounded(1f), 0.0)
    }
}
