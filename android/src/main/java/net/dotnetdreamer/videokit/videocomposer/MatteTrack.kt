package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONObject
import org.json.JSONTokener
import java.io.ByteArrayOutputStream
import java.io.IOException
import kotlin.math.max
import kotlin.math.roundToInt

/**
 * A matte track, the file `findMatte` writes: how sure the segmenter was, cell by cell and frame by
 * frame, that the footage's subject is there. `MATTE_TRACK_MAGIC` in definitions.ts has the layout,
 * and this is the Android port of its reference reader and writer, `src/editor/matte-track.ts`,
 * function for function: the web side and this one read each other's answers to the byte.
 *
 * Read in two halves, as [SubjectTrack] is: the header, the times and the offsets at once, so a file
 * that is not a matte track is refused when it is opened; a frame only when it is drawn, a few kept.
 * A render decodes every frame once before it starts ([checkFrames]), so it never meets a damaged one
 * half way through. Shared by every clip that names the same file, on whichever GL thread draws it.
 */
class MatteTrack internal constructor(
    val width: Int,
    val height: Int,
    private val timesMs: LongArray,
    /** The JSON, or null where it was missing or would not parse: a renderer never needs it. */
    val meta: MatteTrackMeta?,
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
     * One frame's cells, W x H certainties row by row from the top-left, as unsigned bytes. The array is
     * the track's own and kept for the next call: a caller reads it and never writes it.
     */
    fun frame(index: Int): ByteArray {
        synchronized(kept) {
            val known = kept.remove(index)
            if (known != null) {
                kept[index] = known
                return known
            }
            val cells = ByteArray(width * height)
            MatteTracks.decodePackets(bytes, frameStart(index), frameEnd(index), cells)
            kept[index] = cells
            if (kept.size > KEPT_FRAMES) kept.remove(kept.keys.first())
            return cells
        }
    }

    /** Decodes every frame once, into nothing kept, so a damaged one is refused NOW, before a render meets it. */
    fun checkFrames() {
        val scratch = ByteArray(width * height)
        for (index in 0 until frameCount) MatteTracks.decodePackets(bytes, frameStart(index), frameEnd(index), scratch)
    }

    /** The two frames [sourceMs] falls between and how far from the first to the second: [SubjectTrack.span]'s arithmetic. */
    fun span(sourceMs: Double): FrameSpan {
        val last = timesMs.size - 1
        if (!(sourceMs > timesMs[0])) return FrameSpan(0, 0, 0.0)
        if (sourceMs >= timesMs[last]) return FrameSpan(last, last, 0.0)
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

    private fun frameEnd(index: Int): Int = if (index + 1 < offsets.size) dataStart + offsets[index + 1] else bytes.size

    private companion object {
        const val KEPT_FRAMES = 6
    }
}

/** What [MatteTracks.parse] refuses, and what decoding a damaged frame throws. */
class MatteTrackException(message: String) : IOException(message)

/** A subject's box over the whole footage: `ComposeRect`, 0..1 of the oriented frame. */
data class MatteBox(val x: Double, val y: Double, val w: Double, val h: Double)

/** The JSON after a track's header - `MatteTrackMeta`: the `FindMatteResult` fields a reader shows. */
data class MatteTrackMeta(
    val engine: String,
    val kind: MediaLabels.Kind,
    /** `subject` or `people`. */
    val target: String,
    val durationMs: Long,
    val fps: Double,
    val coverage: Double,
    val box: MatteBox?,
) {
    fun toJson(): JSONObject {
        val json = JSONObject()
            .put("engine", engine)
            .put("kind", kind.wire)
            .put("target", target)
            .put("durationMs", durationMs)
            .put("fps", fps)
            .put("coverage", coverage)
        box?.let { json.put("box", JSONObject().put("x", it.x).put("y", it.y).put("w", it.w).put("h", it.h)) }
        return json
    }
}

/** What [MatteTracks.encode] writes: the grid, every frame's time and cells, and the JSON. */
class MatteTrackContent(
    val width: Int,
    val height: Int,
    /** Source ms, strictly increasing, one per frame. */
    val times: List<Long>,
    /** W x H certainties each, 0..255, row by row from the top-left. */
    val frames: List<ByteArray>,
    val meta: MatteTrackMeta,
)

/** The matte track's format - `matte-track.ts`, ported: [parse], [encode], [encodePackets], [decodePackets], [matteAt]. */
object MatteTracks {
    const val MAGIC = "VKMT"
    const val VERSION = 1
    private const val HEADER_BYTES = 20

    /** The most cells a grid may have: 2048 squared. */
    private const val MAX_CELLS = 4_194_304L

    /** The shortest repeat a run packet is worth. */
    private const val MIN_RUN = 3

    /** A cell at this certainty or above is the subject's, for [summarise]. */
    private const val SUBJECT_AT = 128

    fun parse(bytes: ByteArray): MatteTrack {
        if (bytes.size < HEADER_BYTES) throw MatteTrackException("not a matte track: too short")
        if (String(bytes, 0, 4, Charsets.ISO_8859_1) != MAGIC) throw MatteTrackException("not a matte track")
        val version = bytes[4].toInt() and 0xff
        if (version != VERSION) throw MatteTrackException("matte track version $version is not one this build reads")
        val width = u16(bytes, 6)
        val height = u16(bytes, 8)
        val frames = u32(bytes, 12)
        val jsonBytes = u32(bytes, 16)
        if (width == 0 || height == 0 || frames == 0L) throw MatteTrackException("matte track has no cells or no frames")
        if (width.toLong() * height > MAX_CELLS) throw MatteTrackException("matte track grid is too large")
        val timesAt = HEADER_BYTES + jsonBytes
        val offsetsAt = timesAt + 4 * frames
        val dataStartLong = offsetsAt + 4 * frames
        if (dataStartLong > bytes.size) throw MatteTrackException("matte track tables run past its end")
        val count = frames.toInt()
        val dataStart = dataStartLong.toInt()
        val times = LongArray(count)
        val offsets = IntArray(count)
        val dataLength = (bytes.size - dataStart).toLong()
        for (i in 0 until count) {
            times[i] = u32(bytes, timesAt.toInt() + 4 * i)
            val offset = u32(bytes, offsetsAt.toInt() + 4 * i)
            if (i > 0 && !(times[i] > times[i - 1])) throw MatteTrackException("matte track times go back")
            if (offset > dataLength || (i > 0 && offset < offsets[i - 1])) throw MatteTrackException("matte track offsets go back or past its end")
            offsets[i] = offset.toInt()
        }
        return MatteTrack(width, height, times, readMeta(bytes, HEADER_BYTES, timesAt.toInt()), bytes, offsets, dataStart)
    }

    private fun readMeta(bytes: ByteArray, from: Int, to: Int): MatteTrackMeta? {
        if (to <= from) return null
        return try {
            val raw = JSONTokener(String(bytes, from, to - from, Charsets.UTF_8)).nextValue() as? JSONObject ?: return null
            fun number(key: String, o: JSONObject = raw): Double = (o.opt(key) as? Number)?.toDouble()?.takeIf { it.isFinite() } ?: 0.0
            val box = raw.optJSONObject("box")?.let { MatteBox(number("x", it), number("y", it), number("w", it), number("h", it)) }
            MatteTrackMeta(
                engine = raw.opt("engine") as? String ?: "mediapipe",
                kind = if (raw.opt("kind") == "image") MediaLabels.Kind.IMAGE else MediaLabels.Kind.VIDEO,
                target = if (raw.opt("target") == "people") "people" else "subject",
                durationMs = Math.round(number("durationMs")),
                fps = number("fps"),
                coverage = number("coverage"),
                box = box,
            )
        } catch (e: Exception) {
            null
        }
    }

    /** A track's parts with its frames already coded ([encodePackets]): what a video's search keeps as it goes. */
    class Coded(val width: Int, val height: Int, val times: List<Long>, val packets: List<ByteArray>, val meta: MatteTrackMeta)

    fun encode(content: MatteTrackContent): ByteArray {
        if (content.frames.isEmpty() || content.frames.size != content.times.size) throw MatteTrackException("a matte track needs one time per frame, and a frame")
        val coded = content.frames.map { cells ->
            if (cells.size != content.width * content.height) throw MatteTrackException("a frame is not the size of the grid")
            encodePackets(cells)
        }
        return encode(Coded(content.width, content.height, content.times, coded, content.meta))
    }

    fun encode(content: Coded): ByteArray {
        val coded = content.packets
        if (coded.isEmpty() || coded.size != content.times.size) throw MatteTrackException("a matte track needs one time per frame, and a frame")
        val frames = coded
        val json = content.meta.toJson().toString().toByteArray(Charsets.UTF_8)
        val out = ByteArray(HEADER_BYTES + json.size + 8 * frames.size + coded.sumOf { it.size })
        MAGIC.forEachIndexed { i, c -> out[i] = c.code.toByte() }
        out[4] = VERSION.toByte()
        putU16(out, 6, content.width)
        putU16(out, 8, content.height)
        putU32(out, 12, frames.size.toLong())
        putU32(out, 16, json.size.toLong())
        json.copyInto(out, HEADER_BYTES)
        var at = HEADER_BYTES + json.size
        for (time in content.times) {
            putU32(out, at, max(0L, time))
            at += 4
        }
        var offset = 0L
        for (packets in coded) {
            putU32(out, at, offset)
            at += 4
            offset += packets.size
        }
        for (packets in coded) {
            packets.copyInto(out, at)
            at += packets.size
        }
        return out
    }

    /** A frame's cells as packets: `count << 1 | 1` and a byte for a run of at least [MIN_RUN], `count << 1` and the bytes otherwise. */
    fun encodePackets(cells: ByteArray): ByteArray {
        val out = ByteArrayOutputStream(cells.size / 8 + 16)
        fun varint(value: Long) {
            var rest = value
            while (rest >= 0x80) {
                out.write(((rest and 0x7f) or 0x80).toInt())
                rest = rest ushr 7
            }
            out.write(rest.toInt())
        }
        var literalFrom = 0
        fun flush(to: Int) {
            val count = to - literalFrom
            if (count <= 0) return
            varint(count.toLong() * 2)
            out.write(cells, literalFrom, count)
        }
        var i = 0
        while (i < cells.size) {
            val value = cells[i]
            var run = 1
            while (i + run < cells.size && cells[i + run] == value) run++
            if (run >= MIN_RUN) {
                flush(i)
                varint(run.toLong() * 2 + 1)
                out.write(value.toInt() and 0xff)
                literalFrom = i + run
            }
            i += run
        }
        flush(cells.size)
        return out.toByteArray()
    }

    /** Decodes the packets in `bytes[start until end]` into [out], which they must fill exactly. */
    fun decodePackets(bytes: ByteArray, start: Int, end: Int, out: ByteArray) {
        var at = start
        var filled = 0
        while (at < end) {
            var n = 0L
            var shift = 0
            while (true) {
                if (at >= end || shift > 28) throw MatteTrackException("a matte track frame is damaged")
                val byte = bytes[at++].toInt() and 0xff
                n = n or ((byte and 0x7f).toLong() shl shift)
                if (byte < 0x80) break
                shift += 7
            }
            val count = n ushr 1
            if (count < 1 || count > out.size - filled) throw MatteTrackException("a matte track frame does not fit its grid")
            val c = count.toInt()
            if (n and 1L == 1L) {
                if (at >= end) throw MatteTrackException("a matte track frame is damaged")
                out.fill(bytes[at++], filled, filled + c)
            } else {
                if (c > end - at) throw MatteTrackException("a matte track frame is damaged")
                bytes.copyInto(out, filled, at, at + c)
                at += c
            }
            filled += c
        }
        if (filled != out.size) throw MatteTrackException("a matte track frame does not fill its grid")
    }

    /** The grid at [sourceMs] - the contract's step 2 - 0..255 a cell, rounded half up as `Math.round` is, into [out]. */
    fun matteAt(track: MatteTrack, sourceMs: Double, out: ByteArray = ByteArray(track.width * track.height)): ByteArray {
        val span = track.span(sourceMs)
        val a = track.frame(span.from)
        if (span.weight == 0.0 || span.from == span.to) {
            a.copyInto(out)
            return out
        }
        val b = track.frame(span.to)
        val w = span.weight
        for (c in a.indices) {
            out[c] = Math.round((1 - w) * (a[c].toInt() and 0xff) + w * (b[c].toInt() and 0xff)).toInt().toByte()
        }
        return out
    }

    /** A grid for a `width` x `height` frame: [longSide] cells on its longer side, the other in proportion, at least 1. */
    fun grid(width: Int, height: Int, longSide: Int): Pair<Int, Int> {
        if (width <= 0 || height <= 0) return longSide to longSide
        val scale = longSide.toDouble() / max(width, height)
        return max(1, (width * scale).roundToInt()) to max(1, (height * scale).roundToInt())
    }

    /** `coverage` and `box` from the frames, as `summariseMatte` makes them. */
    fun summarise(frames: List<ByteArray>, width: Int, height: Int): Pair<Double, MatteBox?> {
        var covered = 0L
        var minX = width
        var minY = height
        var maxX = -1
        var maxY = -1
        for (cells in frames) {
            var c = 0
            for (y in 0 until height) {
                for (x in 0 until width) {
                    if ((cells[c++].toInt() and 0xff) < SUBJECT_AT) continue
                    covered++
                    if (x < minX) minX = x
                    if (x > maxX) maxX = x
                    if (y < minY) minY = y
                    if (y > maxY) maxY = y
                }
            }
        }
        val total = frames.size.toLong() * width * height
        if (maxX < 0 || total == 0L) return 0.0 to null
        fun round4(v: Double) = Math.round(v * 10_000) / 10_000.0
        return round4(covered.toDouble() / total) to
            MatteBox(round4(minX.toDouble() / width), round4(minY.toDouble() / height), round4((maxX + 1 - minX).toDouble() / width), round4((maxY + 1 - minY).toDouble() / height))
    }

    private fun u16(bytes: ByteArray, at: Int): Int = (bytes[at].toInt() and 0xff) or ((bytes[at + 1].toInt() and 0xff) shl 8)

    private fun u32(bytes: ByteArray, at: Int): Long =
        (bytes[at].toLong() and 0xff) or ((bytes[at + 1].toLong() and 0xff) shl 8) or ((bytes[at + 2].toLong() and 0xff) shl 16) or ((bytes[at + 3].toLong() and 0xff) shl 24)

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
