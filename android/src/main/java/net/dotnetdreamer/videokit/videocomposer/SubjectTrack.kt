package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONArray
import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import kotlin.math.max
import kotlin.math.min

/**
 * A subject track, the file `findSubjects` writes: where every subject of a footage is, frame by frame,
 * as a coarse grid of subject ids over the ORIENTED frame. `SUBJECT_TRACK_MAGIC` in definitions.ts has
 * the layout, and this file is the Android port of its reference reader and writer,
 * `src/editor/subject-track.ts`, function for function and error for error: the web engine, iOS and
 * this one read each other's answers to the byte.
 *
 * Read in two halves on purpose, as the reference is. The header, the times and the frame offsets are
 * read at once ([SubjectTracks.parse]), so a file that is not a subject track is refused when it is
 * opened; the frames themselves are decoded only when one is drawn ([frame]), a few kept at a time,
 * because a minute of footage is hundreds of grids and a frame of the render needs two of them. A
 * render that must not fail half way decodes every one once before it starts ([checkFrames]).
 *
 * Shared by every clip that names the same file, on whichever GL thread draws it: the bytes and the
 * tables never change after [SubjectTracks.parse], and the few decoded frames kept are guarded.
 */
class SubjectTrack internal constructor(
    val width: Int,
    val height: Int,
    private val timesMs: LongArray,
    /** The JSON, or null where it was missing or would not parse: a renderer never needs it. */
    val meta: SubjectTrackMeta?,
    private val bytes: ByteArray,
    private val offsets: IntArray,
    private val dataStart: Int,
) {

    /** The decoded frames last asked for, least recently used first. Guarded by itself. */
    private val kept = LinkedHashMap<Int, ByteArray>()

    val frameCount: Int get() = timesMs.size

    /** Each frame's source time, ms, strictly increasing. */
    val times: List<Long> get() = timesMs.asList()

    /**
     * One frame's cells, W x H subject ids row by row from the top-left, as unsigned bytes. The array is
     * the track's own and is kept for the next call: a caller reads it and never writes it. Throws
     * [SubjectTrackException] for a frame whose runs do not add up to the grid.
     */
    fun frame(index: Int): ByteArray {
        synchronized(kept) {
            val known = kept.remove(index)
            if (known != null) {
                // Most recently used goes last, so the first entry is always the one to let go of.
                kept[index] = known
                return known
            }
            val cells = ByteArray(width * height)
            SubjectTracks.decodeRuns(bytes, frameStart(index), frameEnd(index), cells)
            kept[index] = cells
            if (kept.size > KEPT_FRAMES) kept.remove(kept.keys.first())
            return cells
        }
    }

    /**
     * Decodes every frame once, into nothing kept, so a damaged one is refused NOW - before a render
     * that would otherwise meet it half way through and fail with no clip to name.
     */
    fun checkFrames() {
        val scratch = ByteArray(width * height)
        for (index in 0 until frameCount) SubjectTracks.decodeRuns(bytes, frameStart(index), frameEnd(index), scratch)
    }

    /**
     * The two frames source time [sourceMs] falls between and how far from the first to the second:
     * the contract's step 1. Before the first frame and after the last, that frame holds alone
     * (`from == to`, weight 0), and a track of one frame - a picture's - is that frame at every time.
     */
    fun span(sourceMs: Double): FrameSpan {
        val last = timesMs.size - 1
        if (!(sourceMs > timesMs[0])) return FrameSpan(0, 0, 0.0)
        if (sourceMs >= timesMs[last]) return FrameSpan(last, last, 0.0)
        // The last frame at or before the time: a binary search, since a render asks once a frame.
        var lo = 0
        var hi = last
        while (hi - lo > 1) {
            val mid = (lo + hi) ushr 1
            if (timesMs[mid] <= sourceMs) lo = mid else hi = mid
        }
        val t0 = timesMs[lo].toDouble()
        val t1 = timesMs[hi].toDouble()
        return FrameSpan(lo, hi, (sourceMs - t0) / (t1 - t0))
    }

    private fun frameStart(index: Int): Int = dataStart + offsets[index]

    private fun frameEnd(index: Int): Int =
        if (index + 1 < offsets.size) dataStart + offsets[index + 1] else bytes.size

    private companion object {
        /** Frames kept decoded: the pair a moment is drawn between, and the pair either side of a seek. */
        const val KEPT_FRAMES = 6
    }
}

/** See [SubjectTrack.span]. */
data class FrameSpan(val from: Int, val to: Int, /** 0..1 from [from] towards [to]. */ val weight: Double)

/** What [SubjectTracks.parse] refuses, and what decoding a damaged frame throws. */
class SubjectTrackException(message: String) : IOException(message)

/**
 * One subject found in a footage - `SubjectInfo`: what `findSubjects` answers with, and what the
 * track's JSON keeps for a reader that lists them.
 */
data class SubjectInfo(
    /** 1..255, and the value its cells have in the track; 1 is the main subject. */
    val id: Int,
    /** `person` where the engine finds only people, `subject` where it finds anything that stands out. */
    val kind: String,
    val startMs: Long,
    val endMs: Long,
    val peakMs: Long,
    /** Where it is in its peak frame, 0..1 of the oriented frame, top-left origin. */
    val box: SubjectBox,
    /** How much of the frame it covers on average while it is seen, 0..1. */
    val area: Double,
) {
    fun toJson(): JSONObject = JSONObject()
        .put("id", id)
        .put("kind", kind)
        .put("startMs", startMs)
        .put("endMs", endMs)
        .put("peakMs", peakMs)
        .put("box", JSONObject().put("x", box.x).put("y", box.y).put("w", box.w).put("h", box.h))
        .put("area", area)
}

/** A subject's box: `ComposeRect`, 0..1 of the oriented frame. */
data class SubjectBox(val x: Double, val y: Double, val w: Double, val h: Double)

/** The JSON after a track's header - `SubjectTrackMeta`: the `FindSubjectsResult` fields a list needs. */
data class SubjectTrackMeta(
    val engine: String,
    val kind: MediaLabels.Kind,
    val durationMs: Long,
    val fps: Double,
    val subjects: List<SubjectInfo>,
) {
    fun toJson(): JSONObject {
        val list = JSONArray()
        subjects.forEach { list.put(it.toJson()) }
        return JSONObject()
            .put("engine", engine)
            .put("kind", kind.wire)
            .put("durationMs", durationMs)
            .put("fps", fps)
            .put("subjects", list)
    }
}

/** What [SubjectTracks.encode] writes: the grid, every frame's time and cells, and the JSON. */
class SubjectTrackContent(
    val width: Int,
    val height: Int,
    /** Source ms, strictly increasing, one per frame. */
    val times: List<Long>,
    /** W x H subject ids each, row by row from the top-left. */
    val frames: List<ByteArray>,
    val meta: SubjectTrackMeta,
)

/**
 * A focus's keys as a frame reads them: [Focus.atMs] and each listed subject's values as plain arrays,
 * made once per clip rather than unboxed from the spec's lists on every frame.
 */
class FocusKeys(val atMs: DoubleArray, val ids: IntArray, val values: Array<DoubleArray>) {
    companion object {
        fun of(focus: Focus): FocusKeys = FocusKeys(
            atMs = focus.atMs.toDoubleArray(),
            ids = IntArray(focus.subjects.size) { focus.subjects[it].id },
            values = Array(focus.subjects.size) { focus.subjects[it].focus.toDoubleArray() },
        )
    }
}

/**
 * The subject track's format and the contract's steps 1 to 3 - `subject-track.ts`, ported: the reader
 * and writer of the file ([parse], [encode], [encodeRuns], [decodeRuns]), what a focus asks of each
 * subject at an instant ([focusLevels]), and the grid that instant comes to ([focusMask]), which an
 * engine uploads as a texture and samples bilinearly - the contract's step 4.
 */
object SubjectTracks {

    /** The four bytes a subject track starts with: `SUBJECT_TRACK_MAGIC`. */
    const val MAGIC = "VKST"

    /** `SUBJECT_TRACK_VERSION`: the one layout this build reads and writes. */
    const val VERSION = 1

    /** Magic, version, flags, W, H, a reserved u16, F and J: everything before the JSON. */
    private const val HEADER_BYTES = 20

    /** The most cells a grid may have: `SUBJECT_TRACK_MAGIC`'s ceiling, far past `SUBJECT_GRID` squared. */
    private const val MAX_CELLS = 1_000_000L

    /**
     * Reads a subject track's header and tables, refusing what `SUBJECT_TRACK_MAGIC` says a reader
     * refuses: a magic or version it does not know, a W, H or F of 0, more than [MAX_CELLS] cells,
     * tables that run past the end or go back. The frames are left coded until they are asked for.
     */
    fun parse(bytes: ByteArray): SubjectTrack {
        if (bytes.size < HEADER_BYTES) throw SubjectTrackException("not a subject track: too short")
        val magic = String(bytes, 0, 4, Charsets.ISO_8859_1)
        if (magic != MAGIC) throw SubjectTrackException("not a subject track")
        val version = bytes[4].toInt() and 0xff
        if (version != VERSION) throw SubjectTrackException("subject track version $version is not one this build reads")
        val width = u16(bytes, 6)
        val height = u16(bytes, 8)
        val frames = u32(bytes, 12)
        val jsonBytes = u32(bytes, 16)
        if (width == 0 || height == 0 || frames == 0L) throw SubjectTrackException("subject track has no cells or no frames")
        if (width.toLong() * height > MAX_CELLS) throw SubjectTrackException("subject track grid is too large")
        // In longs: F and J are each up to 4 GB on the wire, and a file claiming that much is refused
        // here rather than wrapped round into a table that seems to fit.
        val timesAt = HEADER_BYTES + jsonBytes
        val offsetsAt = timesAt + 4 * frames
        val dataStartLong = offsetsAt + 4 * frames
        if (dataStartLong > bytes.size) throw SubjectTrackException("subject track tables run past its end")

        val count = frames.toInt()
        val dataStart = dataStartLong.toInt()
        val times = LongArray(count)
        val offsets = IntArray(count)
        val dataLength = (bytes.size - dataStart).toLong()
        for (i in 0 until count) {
            times[i] = u32(bytes, timesAt.toInt() + 4 * i)
            val offset = u32(bytes, offsetsAt.toInt() + 4 * i)
            if (i > 0 && !(times[i] > times[i - 1])) throw SubjectTrackException("subject track times go back")
            if (offset > dataLength || (i > 0 && offset < offsets[i - 1])) {
                throw SubjectTrackException("subject track offsets go back or past its end")
            }
            offsets[i] = offset.toInt()
        }
        return SubjectTrack(width, height, times, readMeta(bytes, HEADER_BYTES, timesAt.toInt()), bytes, offsets, dataStart)
    }

    /** The JSON, read leniently: a track whose JSON is damaged still draws, it only cannot be listed. */
    private fun readMeta(bytes: ByteArray, from: Int, to: Int): SubjectTrackMeta? {
        if (to <= from) return null
        return try {
            val raw = JSONTokener(String(bytes, from, to - from, Charsets.UTF_8)).nextValue() as? JSONObject ?: return null
            val subjects = raw.opt("subjects") as? JSONArray ?: return null
            SubjectTrackMeta(
                engine = raw.opt("engine") as? String ?: "mediapipe",
                kind = if (raw.opt("kind") == "image") MediaLabels.Kind.IMAGE else MediaLabels.Kind.VIDEO,
                durationMs = wholeMs(raw.opt("durationMs")),
                fps = (raw.opt("fps") as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0,
                subjects = (0 until subjects.length()).mapNotNull { subjectOf(subjects.opt(it)) },
            )
        } catch (e: Exception) {
            null
        }
    }

    /** One listed subject as another engine may have written it: what is not there reads as 0. */
    private fun subjectOf(value: Any?): SubjectInfo? {
        val o = value as? JSONObject ?: return null
        val box = o.optJSONObject("box")
        fun boxed(key: String): Double = (box?.opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0
        return SubjectInfo(
            id = (o.opt("id") as? Number)?.toInt() ?: 0,
            kind = if (o.opt("kind") == "subject") "subject" else "person",
            startMs = wholeMs(o.opt("startMs")),
            endMs = wholeMs(o.opt("endMs")),
            peakMs = wholeMs(o.opt("peakMs")),
            box = SubjectBox(boxed("x"), boxed("y"), boxed("w"), boxed("h")),
            area = (o.opt("area") as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0,
        )
    }

    private fun wholeMs(value: Any?): Long =
        (value as? Number)?.toDouble()?.takeIf { it.isFinite() }?.let { Math.round(it) } ?: 0L

    /** A subject track's bytes, laid out as `SUBJECT_TRACK_MAGIC` says. */
    fun encode(content: SubjectTrackContent): ByteArray {
        val width = content.width
        val height = content.height
        val frames = content.frames
        if (frames.isEmpty() || frames.size != content.times.size) {
            throw SubjectTrackException("a subject track needs one time per frame, and a frame")
        }
        val json = content.meta.toJson().toString().toByteArray(Charsets.UTF_8)
        val coded = frames.map { cells ->
            if (cells.size != width * height) throw SubjectTrackException("a frame is not the size of the grid")
            encodeRuns(cells)
        }
        val dataLength = coded.sumOf { it.size }
        val out = ByteArray(HEADER_BYTES + json.size + 8 * frames.size + dataLength)
        MAGIC.forEachIndexed { i, c -> out[i] = c.code.toByte() }
        out[4] = VERSION.toByte()
        putU16(out, 6, width)
        putU16(out, 8, height)
        putU32(out, 12, frames.size.toLong())
        putU32(out, 16, json.size.toLong())
        json.copyInto(out, HEADER_BYTES)
        var at = HEADER_BYTES + json.size
        for (time in content.times) {
            putU32(out, at, max(0L, time))
            at += 4
        }
        var offset = 0L
        for (runs in coded) {
            putU32(out, at, offset)
            at += 4
            offset += runs.size
        }
        for (runs in coded) {
            runs.copyInto(out, at)
            at += runs.size
        }
        return out
    }

    /** A frame's cells as runs: a value byte, then its run as an unsigned LEB128 varint. */
    fun encodeRuns(cells: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(64)
        var i = 0
        while (i < cells.size) {
            val value = cells[i]
            var run = 1
            while (i + run < cells.size && cells[i + run] == value) run++
            out.write(value.toInt() and 0xff)
            var rest = run
            while (rest >= 0x80) {
                out.write((rest and 0x7f) or 0x80)
                rest = rest ushr 7
            }
            out.write(rest)
            i += run
        }
        return out.toByteArray()
    }

    /**
     * Decodes the runs in `bytes[start until end]` into [out], which they must fill exactly. Throws
     * [SubjectTrackException] for runs that stop short of it, run past it, or leave bytes over.
     */
    fun decodeRuns(bytes: ByteArray, start: Int, end: Int, out: ByteArray) {
        var at = start
        var filled = 0
        while (at < end) {
            val value = bytes[at++]
            var run = 0
            var shift = 0
            while (true) {
                if (at >= end || shift > 28) throw SubjectTrackException("a subject track frame is damaged")
                val byte = bytes[at++].toInt() and 0xff
                run = run or ((byte and 0x7f) shl shift)
                if (byte < 0x80) break
                shift += 7
            }
            // Measured against the room left rather than added to what is filled, which a run near
            // the largest int would wrap past the test.
            if (run < 1 || run > out.size - filled) throw SubjectTrackException("a subject track frame does not fit its grid")
            out.fill(value, filled, filled + run)
            filled += run
        }
        if (filled != out.size) throw SubjectTrackException("a subject track frame does not fill its grid")
    }

    /**
     * How in focus every subject id is at source time [sourceMs]: entry `id` of a 256-long table, 0 for
     * the background and for every subject the focus does not list. The contract's step 2, read off the
     * keys as a camera's are: holding before the first and after the last, straight lines between, and
     * of two keys at one time the later taking effect at that time.
     */
    fun focusLevels(keys: FocusKeys, sourceMs: Double, out: FloatArray = FloatArray(256)): FloatArray {
        out.fill(0f)
        val at = keys.atMs
        val n = at.size
        if (n == 0) return out
        // Where the instant falls: the last key at or before it - a step takes effect at its own time,
        // so of two keys at one time the later wins - and the straight line on to the next.
        var i = 0
        while (i + 1 < n && at[i + 1] <= sourceMs) i++
        val between = if (i + 1 < n && sourceMs > at[i]) (sourceMs - at[i]) / (at[i + 1] - at[i]) else 0.0
        for (s in keys.ids.indices) {
            val values = keys.values[s]
            val level = if (between > 0) values[i] + (values[i + 1] - values[i]) * between else values[i]
            out[keys.ids[s] and 0xff] = min(1.0, max(0.0, level)).toFloat()
        }
        out[0] = 0f
        return out
    }

    /**
     * The grid of a focus at one instant: each cell's `m` - the contract's step 3, the two frames either
     * side mixed by how far between them the instant is - as 0..255, ready to upload. [levels] is what
     * [focusLevels] answered for the same instant. [out] is filled and handed back.
     */
    fun focusMask(
        track: SubjectTrack,
        levels: FloatArray,
        sourceMs: Double,
        invert: Boolean,
        out: ByteArray = ByteArray(track.width * track.height),
    ): ByteArray {
        val span = track.span(sourceMs)
        val a = track.frame(span.from)
        val cells = a.size
        if (span.weight == 0.0 || span.from == span.to) {
            for (c in 0 until cells) {
                val m = levels[a[c].toInt() and 0xff].toDouble()
                out[c] = Math.round((if (invert) 1 - m else m) * 255).toInt().toByte()
            }
            return out
        }
        val b = track.frame(span.to)
        val w = span.weight
        for (c in 0 until cells) {
            val m = (1 - w) * levels[a[c].toInt() and 0xff] + w * levels[b[c].toInt() and 0xff]
            out[c] = Math.round((if (invert) 1 - m else m) * 255).toInt().toByte()
        }
        return out
    }

    private fun u16(bytes: ByteArray, at: Int): Int =
        (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8)

    private fun u32(bytes: ByteArray, at: Int): Long =
        (bytes[at].toLong() and 0xff) or
            ((bytes[at + 1].toLong() and 0xff) shl 8) or
            ((bytes[at + 2].toLong() and 0xff) shl 16) or
            ((bytes[at + 3].toLong() and 0xff) shl 24)

    private fun putU16(out: ByteArray, at: Int, value: Int) {
        out[at] = value.toByte()
        out[at + 1] = (value ushr 8).toByte()
    }

    private fun putU32(out: ByteArray, at: Int, value: Long) {
        out[at] = value.toByte()
        out[at + 1] = (value ushr 8).toByte()
        out[at + 2] = (value ushr 16).toByte()
        out[at + 3] = (value ushr 24).toByte()
    }
}
