package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.ExifInterface
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.util.Log
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import java.io.File
import java.io.IOException
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.roundToLong

/**
 * The phone's own image recogniser, asked what it sees: ML Kit's image labeling, with the base model
 * bundled into the app (`com.google.mlkit:image-labeling`) by default, so it runs offline from the
 * first call and downloads nothing. It needs no permission, and the pictures never leave the device;
 * ML Kit itself sends Google metrics about how the API performs, which the README's **Reading what
 * footage shows** says a host has to tell its users about. Everything that touches ML Kit is in
 * [SceneLabeler], which a host can take from Google Play services instead
 * (`videokitImageLabeling = 'playServices'`: this refuses as unsupported until its model has
 * downloaded) or leave out of its build (`false`: this refuses every call as unsupported).
 *
 * iOS's `MediaLabels.swift` answers the same shape from Vision. The frames of a video are chosen by
 * the same [plan], and a picture is read upright by its orientation tag, as iOS reads one.
 *
 * KEYFRAMES FIRST, AND AT LEAST THREE DIFFERENT FRAMES. A frame cut at the nearest keyframe costs one
 * decode, and a frame cut exactly costs every frame since the keyframe before it - which
 * `MediaMetadataRetriever` decodes in software: measured on the Pixel 7 Pro emulator, 0.7 s for a
 * keyframe of a 1080x1920 screen recording against 5.5 s for the exact frame 2.4 s past one, and
 * with five frames a clip, that was twenty seconds for eight seconds of game. So each time the
 * plan asks for is taken at its nearest keyframe, looked up first in the index ([MediaExtractor],
 * which decodes nothing), and two times that meet at one keyframe are one frame. Only when that
 * leaves fewer than [MIN_FRAMES] different frames - a recording whose encoder wrote one keyframe, or
 * two - are the times furthest from any keyframe cut exactly, until there are. A phone's own video,
 * with a keyframe every second or two, gives every frame asked for at a keyframe each.
 *
 * iOS cuts every time the plan asks for, within half the gap to the next one: its generator decodes
 * forward on the hardware decoder, where an exact frame costs next to nothing.
 */
object MediaLabels {

    private const val TAG = "VideoComposer"

    const val DEFAULT_FRAMES = 5
    const val MAX_FRAMES = 20
    const val DEFAULT_MIN_CONFIDENCE = 0.1f

    /** How many [label] calls run at once, the rest waiting their turn: each holds a decoder. */
    const val AT_ONCE = 2

    /**
     * How long a video is looked at before the frames read so far are the answer. An exact frame of
     * phone footage can cost seconds (see KEYFRAMES FIRST above), and a page asking about a clip waits
     * for a while and then gives up on it - lighsnip's One tap after 15 s. The answer has to come
     * before that: past this no new frame is started, so a call ends within this and one frame more,
     * with the frames it has. The first frame is always read, however long it takes. Counted from
     * when the call was made, its wait for a turn ([AT_ONCE]) included, since the page's own wait
     * began then too.
     */
    const val LOOK_BUDGET_MS = 8_000L

    /** When a call made now has looked long enough; see [LOOK_BUDGET_MS]. */
    fun lookDeadline(): Long = System.nanoTime() + LOOK_BUDGET_MS * 1_000_000L

    /**
     * The longest edge a picture or a frame is decoded at. ML Kit scales everything it is given down
     * to its model's 224 pixel input, so this is about the cost of the decode, not about detail.
     */
    const val LOOK_SIZE = 720

    enum class Kind(val wire: String) {
        VIDEO("video"),
        IMAGE("image");

        companion object {
            fun of(wire: String): Kind? = entries.firstOrNull { it.wire == wire }
        }
    }

    data class Label(val text: String, val confidence: Float)

    data class Frame(val timeMs: Long, val labels: List<Label>)

    data class Result(val kind: Kind, val frames: List<Frame>) {
        fun toJson(): JSObject {
            val frames = JSArray()
            for (frame in this.frames) {
                val labels = JSArray()
                for (label in frame.labels) {
                    labels.put(JSObject().put("label", label.text).put("confidence", rounded(label.confidence)))
                }
                frames.put(JSObject().put("timeMs", frame.timeMs).put("labels", labels))
            }
            return JSObject().put("engine", "mlkit").put("kind", kind.wire).put("frames", frames)
        }
    }

    /** The file will not open, the picture will not decode, or the video gives no frame. */
    class UnreadableException(message: String) : IOException(message)

    /** This build has no engine: the host left ML Kit out ([SceneLabeler.AVAILABLE]). */
    class UnsupportedException(message: String) : Exception(message)

    /** Which source times to ask for, in order and each once. */
    data class Plan(val times: List<Long>)

    /**
     * The fewest different frames a video is looked at in, when its keyframes give fewer: enough that
     * one odd frame - a cut to black, a menu over a game - cannot decide what the whole clip shows.
     */
    const val MIN_FRAMES = 3

    /** One frame to cut: at the keyframe it was matched to, or exactly at `timeMs` when that is null. */
    data class Cut(val timeMs: Long, val keyframeMs: Long?)

    fun label(
        ctx: Context,
        uri: String,
        kind: Kind?,
        timesMs: List<Long>,
        frames: Int,
        minConfidence: Float,
        deadline: Long = lookDeadline(),
    ): Result {
        if (!SceneLabeler.AVAILABLE) {
            throw UnsupportedException("this app was built without image labeling (videokitImageLabeling = false)")
        }
        // Before any decode: the Play services engine's model may not have arrived yet.
        SceneLabeler.notReadyReason(ctx)?.let { throw UnsupportedException(it) }
        val resolved = kind ?: kindOf(ctx, uri)
        SceneLabeler(minConfidence).use { labeler ->
            return when (resolved) {
                Kind.IMAGE -> {
                    val (bitmap, rotation) = picture(ctx, uri)
                    try {
                        Result(Kind.IMAGE, listOf(Frame(0L, labeler.classify(bitmap, rotation, minConfidence))))
                    } finally {
                        bitmap.recycle()
                    }
                }
                Kind.VIDEO -> Result(Kind.VIDEO, videoFrames(ctx, uri, labeler, timesMs, frames, minConfidence, deadline))
            }
        }
    }

    /**
     * A picture when a picture decoder reads the file's header, whatever the file is called; a video
     * otherwise. [Pictures.probe] reads the bytes, so a staged render input with no extension is
     * still told apart, and a video container has no header it can read.
     */
    fun kindOf(ctx: Context, uri: String): Kind = try {
        Pictures.probe(ctx, uri)
        Kind.IMAGE
    } catch (e: Exception) {
        Kind.VIDEO
    }

    /**
     * The times of iOS's `MediaLabels.plan`, number for number: given no times, `frames` of them (1 to
     * 20), each at the middle of its own equal share of the clip, so none is the first frame or the
     * last; every time held inside the clip; each asked for once. A clip of no known length is looked
     * at once, at its start. iOS also works out how far its generator may snap from each; here
     * [cuts] decides that instead, from where the keyframes are.
     */
    fun plan(durationMs: Long, timesMs: List<Long>, frames: Int): Plan {
        if (durationMs <= 0L) return Plan(listOf(0L))
        val last = max(0L, durationMs - 1)
        val times = if (timesMs.isEmpty()) {
            val count = frames.coerceIn(1, MAX_FRAMES)
            (0 until count).map { index ->
                minOf(last, kotlin.math.floor(durationMs.toDouble() * (index + 0.5) / count).toLong())
            }
        } else {
            timesMs.map { it.coerceIn(0L, last) }
        }
        return Plan(times.distinct().sorted())
    }

    /**
     * Which frames to cut for the planned `times`, given the keyframe a seek to each would land on
     * (`keyframes`, the same length; null where the index said nothing): every time at its keyframe,
     * two at one keyframe being one frame; and then, only while there are fewer than [MIN_FRAMES]
     * different frames (or fewer than there are times), the times furthest from their keyframe cut
     * exactly, furthest first. In time order.
     */
    fun cuts(times: List<Long>, keyframes: List<Long?>): List<Cut> {
        val chosen = LinkedHashMap<Long, Cut>()
        val exact = ArrayList<Long>()
        for ((index, timeMs) in times.withIndex()) {
            val keyframe = keyframes.getOrNull(index)
            if (keyframe == null) exact += timeMs else chosen.putIfAbsent(keyframe, Cut(timeMs, keyframe))
        }
        val want = minOf(MIN_FRAMES, times.size)
        // A time with no keyframe at all is cut exactly whatever the count: it is all there is of it.
        val out = chosen.values.toMutableList()
        exact.forEach { out += Cut(it, null) }
        if (out.size < want) {
            val taken = out.map { it.keyframeMs ?: it.timeMs }.toMutableSet()
            val furthest = times.indices
                .filter { keyframes.getOrNull(it) != null && times[it] !in taken }
                .sortedByDescending { abs(times[it] - keyframes[it]!!) }
            for (index in furthest) {
                if (out.size >= want) break
                out += Cut(times[index], null)
                taken += times[index]
            }
        }
        return out.sortedBy { it.keyframeMs ?: it.timeMs }
    }

    /**
     * The picture, decoded to at least [LOOK_SIZE] on its long edge and at most twice that, and the
     * quarter turns its orientation tag asks for, which ML Kit applies itself
     * (`InputImage.fromBitmap(bitmap, rotation)`). A mirrored tag is read as its turn alone: a picture
     * and its mirror image show the same thing.
     */
    fun picture(ctx: Context, uri: String): Pair<Bitmap, Int> {
        val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val resolver = ctx.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            (resolver.openInputStream(parsed) ?: throw UnreadableException("could not open $uri"))
                .use { BitmapFactory.decodeStream(it, null, bounds) }
        } catch (e: IOException) {
            throw e as? UnreadableException ?: UnreadableException("could not open $uri: ${e.message}")
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw UnreadableException("$uri is not a picture this phone can decode")
        val options = BitmapFactory.Options().apply { inSampleSize = sampleSize(bounds.outWidth, bounds.outHeight, LOOK_SIZE) }
        val bitmap = try {
            resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it, null, options) }
        } catch (e: IOException) {
            null
        } ?: throw UnreadableException("$uri will not decode")
        val orientation = try {
            resolver.openInputStream(parsed)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            // A format ExifInterface cannot read (HEIF below API 28) carries no tag it can see.
            ExifInterface.ORIENTATION_NORMAL
        }
        return forLabeler(bitmap) to rotationFor(orientation)
    }

    /**
     * `bitmap` as the labeler is handed it: ARGB_8888, and nothing else. Play services' classifier
     * (`videokitImageLabeling = 'playServices'`) takes no other layout, and it does not refuse one: it
     * throws inside a JNI call, which aborts the whole app rather than failing the call. A frame from
     * [MediaMetadataRetriever] is RGB_565 unless asked otherwise, and a 16-bit PNG or a 10-bit HEIF
     * decodes to RGBA_F16 or RGBA_1010102, so any of those is copied once here - at [LOOK_SIZE], a few
     * milliseconds. `bitmap` is recycled when a copy replaces it.
     */
    fun forLabeler(bitmap: Bitmap): Bitmap {
        val config = bitmap.config
        if (config == Bitmap.Config.ARGB_8888) return bitmap
        val copy = bitmap.copy(Bitmap.Config.ARGB_8888, false)
        bitmap.recycle()
        return copy ?: throw UnreadableException("a $config picture would not convert to ARGB_8888")
    }

    /** The largest power of two that still leaves the long edge at least `target`: BitmapFactory's own rule for `inSampleSize`. */
    fun sampleSize(width: Int, height: Int, target: Int): Int {
        var sample = 1
        val longest = max(width, height)
        while (longest / (sample * 2) >= target) sample *= 2
        return sample
    }

    /** The quarter turns an EXIF orientation asks for, clockwise, its mirroring left out. */
    fun rotationFor(orientation: Int): Int = when (orientation) {
        ExifInterface.ORIENTATION_ROTATE_90, ExifInterface.ORIENTATION_TRANSPOSE -> 90
        ExifInterface.ORIENTATION_ROTATE_180, ExifInterface.ORIENTATION_FLIP_VERTICAL -> 180
        ExifInterface.ORIENTATION_ROTATE_270, ExifInterface.ORIENTATION_TRANSVERSE -> 270
        else -> 0
    }

    private fun videoFrames(
        ctx: Context,
        uri: String,
        labeler: SceneLabeler,
        timesMs: List<Long>,
        frames: Int,
        minConfidence: Float,
        deadline: Long,
    ): List<Frame> {
        val retriever = try {
            Thumbnailer.openRetriever(ctx, uri)
        } catch (e: Exception) {
            throw UnreadableException("could not open $uri: ${e.message}")
        }
        try {
            if (retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) != "yes") {
                throw UnreadableException("$uri has no picture in it")
            }
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            val plan = plan(durationMs, timesMs, frames)
            val out = ArrayList<Frame>(plan.times.size)
            for (cut in cuts(plan.times, keyframesAt(ctx, uri, plan.times))) {
                if (out.isNotEmpty() && System.nanoTime() > deadline) {
                    Log.i(TAG, "looked at $uri for ${LOOK_BUDGET_MS} ms; answering with ${out.size} frames")
                    break
                }
                val atKeyframe = cut.keyframeMs != null
                // At a keyframe the seek is to the keyframe itself, so the frame is the one looked up.
                val seekMs = cut.keyframeMs ?: cut.timeMs
                val option = if (atKeyframe) MediaMetadataRetriever.OPTION_CLOSEST_SYNC else MediaMetadataRetriever.OPTION_CLOSEST
                var bitmap = grab(retriever, seekMs, option)
                if (bitmap == null && !atKeyframe) {
                    // An exact seek can come back with nothing where the index is too thin to decode
                    // forward from; the keyframe nearest it is still a frame of this part of the clip.
                    bitmap = grab(retriever, cut.timeMs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                }
                if (bitmap == null) continue
                if (out.any { it.timeMs == seekMs }) {
                    bitmap.recycle()
                    continue
                }
                try {
                    out += Frame(seekMs, labeler.classify(bitmap, 0, minConfidence))
                } finally {
                    bitmap.recycle()
                }
            }
            if (out.isEmpty()) throw UnreadableException("$uri gave no frame")
            return out.sortedBy { it.timeMs }
        } finally {
            Thumbnailer.closeRetriever(retriever)
        }
    }

    /**
     * The keyframe a seek to each time would land on, in ms, read off the video track's index;
     * null where it could not be read, which makes that frame an exact one. Nothing is decoded.
     */
    private fun keyframesAt(ctx: Context, uri: String, timesMs: List<Long>): List<Long?> {
        val extractor = MediaExtractor()
        return try {
            val parsed = Uri.parse(uri)
            when (parsed.scheme) {
                "file" -> extractor.setDataSource(parsed.path ?: uri)
                null -> extractor.setDataSource(uri)
                else -> extractor.setDataSource(ctx, parsed, null)
            }
            val track = (0 until extractor.trackCount).firstOrNull {
                extractor.getTrackFormat(it).getString(MediaFormat.KEY_MIME)?.startsWith("video/") == true
            } ?: return timesMs.map { null }
            extractor.selectTrack(track)
            timesMs.map { timeMs ->
                extractor.seekTo(timeMs * 1000L, MediaExtractor.SEEK_TO_CLOSEST_SYNC)
                extractor.sampleTime.takeIf { it >= 0L }?.let { it / 1000L }
            }
        } catch (e: Exception) {
            Log.w(TAG, "no keyframe index for $uri: ${e.message}")
            timesMs.map { null }
        } finally {
            extractor.release()
        }
    }

    /**
     * One frame, no longer than [LOOK_SIZE] on its long edge, scaled as it is decoded where the platform
     * can, and in the layout the labeler takes ([forLabeler]).
     */
    private fun grab(retriever: MediaMetadataRetriever, timeMs: Long, option: Int): Bitmap? = try {
        if (Build.VERSION.SDK_INT >= 27) {
            retriever.getScaledFrameAtTime(timeMs * 1000L, option, LOOK_SIZE, LOOK_SIZE)
        } else {
            retriever.getFrameAtTime(timeMs * 1000L, option)?.let { full ->
                val scale = LOOK_SIZE.toFloat() / max(full.width, full.height).toFloat()
                if (scale >= 1f) {
                    full
                } else {
                    val scaled = Bitmap.createScaledBitmap(
                        full,
                        (full.width * scale).toInt().coerceAtLeast(1),
                        (full.height * scale).toInt().coerceAtLeast(1),
                        true,
                    )
                    if (scaled !== full) full.recycle()
                    scaled
                }
            }
        }?.let(::forLabeler)
    } catch (e: Exception) {
        Log.w(TAG, "no frame at ${timeMs}ms: ${e.message}")
        null
    }

    /** Three places, which is all a confidence means, and a smaller answer across the bridge. */
    fun rounded(confidence: Float): Double = (confidence.toDouble() * 1000.0).roundToLong() / 1000.0
}
