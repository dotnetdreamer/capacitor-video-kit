package net.dotnetdreamer.choisy.videocomposer

import org.json.JSONArray
import org.json.JSONObject

/**
 * `JSONObject` -> [ComposeSpec]. Takes `org.json` rather than Capacitor's `JSObject` (which extends
 * it), so the whole parser runs on the JVM in a unit test with no emulator.
 *
 * The split between "reject" and "clamp" is on purpose. A shape error - a missing clip array, a
 * zero-width output, an overlay that is not a PNG data URL - is a programming error in the caller
 * and fails loudly with the JSON path that broke. A value that is merely out of range - a speed of
 * 8, a negative volume, an opacity of 1.4 - is clamped: a render that comes out slightly different
 * beats a post the customer cannot make.
 */
object ComposeSpecParser {

    /** The renderer draws one blended quad per overlay per frame, so the count is bounded. */
    const val MAX_OVERLAYS = 30

    /**
     * How many video layers a post may hold, the BASE TRACK INCLUDED - so sixteen means the base
     * plus fifteen entries in `tracks`. It is NOT a decoder budget: this parser feeds the export,
     * which composites offline with nothing racing a frame deadline, and the live preview keeps a
     * budget of its own that is a different number in a different file. The ceiling is here only so
     * that an absurd spec meets a readable refusal instead of a device running out of codecs
     * halfway through a render.
     */
    const val MAX_VIDEO_TRACKS = 16

    private const val PNG_DATA_URL_PREFIX = "data:image/png;base64,"

    fun parse(json: JSONObject): ComposeSpec {
        val jobId = json.nonEmptyString("jobId")
        val pendingPostId = json.nonEmptyString("pendingPostId")

        val clipsJson = json.optJSONArray("clips") ?: throw SpecException("clips")
        if (clipsJson.length() == 0) throw SpecException("clips")
        val clips = (0 until clipsJson.length()).map { i ->
            parseClip(clipsJson.optJSONObject(i) ?: throw SpecException("clips[$i]"), "clips[$i]")
        }

        val tracksJson = json.optJSONArray("tracks") ?: JSONArray()
        // Refused rather than truncated: a caller asking for four layers believes it is getting
        // four, and a post silently missing one of them is not the post it asked to make. The
        // wording is compared literally by the iOS port tests, so it is one string on both engines
        // down to the plural.
        if (tracksJson.length() > MAX_VIDEO_TRACKS - 1) {
            throw SpecException(
                "tracks",
                "invalid_spec:tracks at most ${MAX_VIDEO_TRACKS - 1} extra video tracks",
            )
        }
        val tracks = (0 until tracksJson.length()).map { i ->
            parseTrack(tracksJson.optJSONObject(i) ?: throw SpecException("tracks[$i]"), i)
        }

        val output = parseOutput(json.optJSONObject("output") ?: throw SpecException("output"))

        val filterJson = json.optJSONArray("filter") ?: JSONArray()
        val filter = (0 until filterJson.length()).mapNotNull { i ->
            parseFilterOp(filterJson.optJSONObject(i) ?: throw SpecException("filter[$i]"), i)
        }

        val overlaysJson = json.optJSONArray("overlays") ?: JSONArray()
        if (overlaysJson.length() > MAX_OVERLAYS) throw SpecException("overlays")
        val overlays = (0 until overlaysJson.length()).map { i ->
            parseOverlay(overlaysJson.optJSONObject(i) ?: throw SpecException("overlays[$i]"), i)
        }

        val audio = parseAudio(json.optJSONObject("audio"))

        return ComposeSpec(
            jobId = jobId,
            pendingPostId = pendingPostId,
            clips = clips,
            output = output,
            filter = filter,
            overlays = overlays,
            audio = audio,
            posterAtMs = json.optLong("posterAtMs", 0L).coerceAtLeast(0L),
            durationMs = json.optLong("durationMs", 0L).coerceAtLeast(0L),
            tracks = tracks,
        )
    }

    /**
     * Takes its JSON path rather than an index because the same reader serves the base track and
     * every extra one: a clip on the second layer is the same kind of thing as a clip on the first,
     * carrying the same trim, speed, sound and framing, and the ONLY difference between the layers
     * is which rectangle of the frame their clips are drawn in. One reader is also one set of error
     * paths, which is one fewer thing for the two native parsers to disagree about.
     */
    private fun parseClip(o: JSONObject, path: String): Clip {
        val key = o.optString("key").takeIf { it.isNotEmpty() } ?: throw SpecException("$path.key")
        val uri = o.optString("uri").takeIf { it.isNotEmpty() } ?: throw SpecException("$path.uri")
        val inMs = o.optLong("inMs", -1L)
        if (inMs < 0L) throw SpecException("$path.inMs")
        val outMs = o.optLong("outMs", -1L)
        if (outMs <= inMs) throw SpecException("$path.outMs")
        return Clip(
            key = key,
            uri = uri,
            inMs = inMs,
            outMs = outMs,
            speed = o.optDouble("speed", 1.0).toFloat().coerceIn(MIN_SPEED, MAX_SPEED),
            volume = o.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f),
            muted = o.optBoolean("muted", false),
            fit = if (o.optString("fit", "contain") == "cover") Fit.COVER else Fit.CONTAIN,
            crop = o.rectOrNull("crop", "$path.crop"),
            rect = o.placementOrNull("rect", "$path.rect"),
        )
    }

    /**
     * The shape errors are the track's own; everything else is a value and is clamped, on the same
     * line the rest of the file draws. A track with no clips is a shape error rather than an empty
     * layer that renders nothing, because JS drops an empty track before it builds the spec, so one
     * arriving here means the caller lost a clip on the way.
     */
    private fun parseTrack(o: JSONObject, i: Int): Track {
        val id = o.optString("id").takeIf { it.isNotEmpty() } ?: throw SpecException("tracks[$i].id")
        val clipsJson = o.optJSONArray("clips")
        if (clipsJson == null || clipsJson.length() == 0) {
            // The id goes in the message because the index alone names nothing the caller can look
            // up: the manifest knows its layers by id, and the id is what failures echo back.
            throw SpecException(
                "tracks[$i].clips",
                "invalid_spec:tracks[$i].clips track '$id' has no clips",
            )
        }
        val clips = (0 until clipsJson.length()).map { j ->
            parseClip(
                clipsJson.optJSONObject(j) ?: throw SpecException("tracks[$i].clips[$j]"),
                "tracks[$i].clips[$j]",
            )
        }
        return Track(
            id = id,
            clips = clips,
            startMs = o.optLong("startMs", 0L).coerceIn(0L, MAX_TIMELINE_MS),
            z = o.optInt("z", i + 1).coerceAtLeast(0),
            opacity = o.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f),
        )
    }

    /**
     * Absent stays absent. Every engine's fast path tests for null - a clip that asks for neither
     * field has to take exactly the code it took before the fields existed - so a missing rectangle
     * must NOT quietly become a full-frame one here, however much that would simplify what follows.
     *
     * `optJSONObject` answers null for a key that is missing, for one explicitly set to null and
     * for one holding a number or a string, and every one of those means the same thing to the
     * renderer: the whole frame. That is the one rectangle failure deliberately left as a shrug
     * rather than an error, and the iOS reader shrugs at it on purpose too.
     */
    private fun JSONObject.rectOrNull(key: String, path: String): Rect? =
        optJSONObject(key)?.let { parseRect(it, path) }

    /**
     * The same four numbers through the same clamp, with the angle carried across untouched.
     *
     * The angle is read HERE and not in [parseRect], which is why a `rotationDeg` sent on a crop is
     * ignored rather than acted on: turning the region sampled out of the source is a different
     * operation on different pixels, one neither engine performs and the builder never asks for.
     */
    private fun JSONObject.placementOrNull(key: String, path: String): Placement? =
        optJSONObject(key)?.let {
            val box = parseRect(it, path)
            Placement(box.x, box.y, box.w, box.h, it.rotationDegOrNull())
        }

    /**
     * The turn a rectangle stands at, straight off the wire.
     *
     * Absent stays absent, because absent is what the plan tests to leave the rotation out of the
     * transform entirely, and an unreadable or non-finite angle joins it there rather than carrying
     * a NaN into a matrix that would blacken the whole clip. Nothing else is done to it: it is not
     * clamped and not wrapped into a single turn, because 720 is a legal spec and sin and cos
     * reduce it themselves.
     */
    private fun JSONObject.rotationDegOrNull(): Float? {
        if (!has("rotationDeg")) return null
        val deg = optDouble("rotationDeg", Double.NaN)
        if (deg.isNaN()) return null
        val f = deg.toFloat()
        return if (f.isFinite()) f else null
    }

    /**
     * The split this file is built on, applied to a rectangle: a rectangle with no area is a shape
     * error and fails loudly, one that hangs off the edge of the frame is an out-of-range value and
     * is clamped back inside it.
     *
     * Which side of the line each number falls on follows the rest of the file rather than being
     * invented here. `x` and `y` are values like an overlay's `cx`: missing, or unreadable as a
     * number, takes the default and is clamped. `w` and `h` are the shape, like an overlay's `wPx`:
     * every non-numeric reading collapses to the same 0 that fails the test below, so "there is no
     * width" and "the width is not a number" report the same path, which is one error path fewer
     * for the two parsers to disagree about.
     */
    private fun parseRect(o: JSONObject, path: String): Rect {
        val x = o.finite("x", 0.0).coerceIn(0f, 1f)
        val y = o.finite("y", 0.0).coerceIn(0f, 1f)
        val w = o.finite("w", 0.0)
        if (w <= 0f) throw SpecException("$path.w")
        val h = o.finite("h", 0.0)
        if (h <= 0f) throw SpecException("$path.h")
        // The origin first, then each side against whatever room the origin left, so a rectangle
        // that overhangs the right edge keeps its position and loses the overhang rather than
        // sliding back inwards - reversing that would silently move a crop the customer placed.
        // The clamp stops at the four numbers and never reaches an angle: a turned rectangle
        // legitimately puts its corners outside the frame, and the frame is what crops them.
        return Rect(x = x, y = y, w = w.coerceAtMost(1f - x), h = h.coerceAtMost(1f - y))
    }

    private fun parseOutput(o: JSONObject): Output {
        val width = o.optInt("width", 0)
        val height = o.optInt("height", 0)
        if (width <= 0) throw SpecException("output.width")
        if (height <= 0) throw SpecException("output.height")
        val fps = o.optInt("fps", 0)
        if (fps <= 0) throw SpecException("output.fps")
        val videoBitrate = o.optInt("videoBitrate", 0)
        if (videoBitrate <= 0) throw SpecException("output.videoBitrate")
        val audioBitrate = o.optInt("audioBitrate", 0)
        if (audioBitrate <= 0) throw SpecException("output.audioBitrate")
        // H.264 encoders refuse odd dimensions; rounding down is invisible and always safe.
        return Output(width and 1.inv(), height and 1.inv(), fps, videoBitrate, audioBitrate)
    }

    private fun parseFilterOp(o: JSONObject, i: Int): FilterOp? = when (val op = o.optString("op")) {
        "brightness" -> FilterOp.Brightness(o.amount(i).coerceAtLeast(0f))
        "contrast" -> FilterOp.Contrast(o.amount(i).coerceAtLeast(0f))
        "saturate" -> FilterOp.Saturate(o.amount(i).coerceAtLeast(0f))
        "sepia" -> FilterOp.Sepia(o.amount(i).coerceIn(0f, 1f))
        "grayscale" -> FilterOp.Grayscale(o.amount(i).coerceIn(0f, 1f))
        "hueRotate" -> FilterOp.HueRotate(o.optDouble("degrees", 0.0).toFloat())
        "tint" -> {
            val rgb = o.optJSONArray("rgb") ?: throw SpecException("filter[$i].rgb")
            if (rgb.length() < 3) throw SpecException("filter[$i].rgb")
            FilterOp.Tint(
                r = rgb.optInt(0).coerceIn(0, 255),
                g = rgb.optInt(1).coerceIn(0, 255),
                b = rgb.optInt(2).coerceIn(0, 255),
                alpha = o.optDouble("alpha", 0.0).toFloat().coerceIn(0f, 1f),
            )
        }
        else -> throw SpecException("filter[$i].op", "invalid_spec:filter[$i].op unknown op '$op'")
    }

    private fun parseOverlay(o: JSONObject, i: Int): Overlay {
        val id = o.optString("id").takeIf { it.isNotEmpty() } ?: throw SpecException("overlays[$i].id")
        val png = o.optString("png")
        if (!png.startsWith(PNG_DATA_URL_PREFIX)) throw SpecException("overlays[$i].png")
        val wPx = o.optInt("wPx", 0)
        val hPx = o.optInt("hPx", 0)
        if (wPx <= 0) throw SpecException("overlays[$i].wPx")
        if (hPx <= 0) throw SpecException("overlays[$i].hPx")
        val startMs = o.optLong("startMs", 0L).coerceIn(0L, MAX_TIMELINE_MS)
        val endMs = o.optLong("endMs", 0L)
        if (endMs <= startMs) throw SpecException("overlays[$i].endMs")
        return Overlay(
            id = id,
            png = png,
            cx = o.optDouble("cx", 0.5).toFloat().coerceIn(0f, 1f),
            cy = o.optDouble("cy", 0.5).toFloat().coerceIn(0f, 1f),
            wPx = wPx,
            hPx = hPx,
            rotationDeg = o.optDouble("rotationDeg", 0.0).toFloat(),
            startMs = startMs,
            endMs = endMs,
            opacity = o.optDouble("opacity", 1.0).toFloat().coerceIn(0f, 1f),
        )
    }

    private fun parseAudio(o: JSONObject?): Audio {
        if (o == null) return Audio(originalMuted = false, originalVolume = 1f, music = null, voiceover = emptyList())
        val musicJson = o.optJSONObject("music")
        val music = if (musicJson == null) null else {
            val uri = musicJson.optString("uri")
            if (uri.isEmpty()) throw SpecException("audio.music.uri")
            val inMs = musicJson.optLong("inMs", 0L).coerceAtLeast(0L)
            val outMs = musicJson.optLong("outMs", 0L)
            if (outMs <= inMs) throw SpecException("audio.music.outMs")
            Music(
                uri = uri,
                startMs = musicJson.optLong("startMs", 0L).coerceIn(0L, MAX_TIMELINE_MS),
                inMs = inMs,
                outMs = outMs,
                volume = musicJson.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f),
                loop = musicJson.optBoolean("loop", false),
                fadeInMs = musicJson.optLong("fadeInMs", 0L).coerceAtLeast(0L),
                fadeOutMs = musicJson.optLong("fadeOutMs", 0L).coerceAtLeast(0L),
            )
        }
        val voJson = o.optJSONArray("voiceover") ?: JSONArray()
        val voiceover = (0 until voJson.length()).map { i ->
            val v = voJson.optJSONObject(i) ?: throw SpecException("audio.voiceover[$i]")
            val uri = v.optString("uri")
            if (uri.isEmpty()) throw SpecException("audio.voiceover[$i].uri")
            val durationMs = v.optLong("durationMs", 0L)
            if (durationMs <= 0L) throw SpecException("audio.voiceover[$i].durationMs")
            Voiceover(
                uri = uri,
                startMs = v.optLong("startMs", 0L).coerceIn(0L, MAX_TIMELINE_MS),
                durationMs = durationMs,
                volume = v.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f),
            )
        }
        return Audio(
            originalMuted = o.optBoolean("originalMuted", false),
            originalVolume = o.optDouble("originalVolume", 1.0).toFloat().coerceIn(0f, 1f),
            music = music,
            voiceover = voiceover,
        )
    }

    private fun JSONObject.nonEmptyString(key: String): String =
        optString(key).takeIf { it.isNotEmpty() } ?: throw SpecException(key)

    /**
     * A number that cannot poison the geometry. `optDouble` already falls back for a missing key
     * and for anything it cannot read as a double; this also folds in the two readings that survive
     * that and would still ruin a matrix - a NaN, and a double so large it becomes an infinity once
     * it is a float. Either one silently blackens a whole clip instead of failing, which is the one
     * outcome worth spending a branch to avoid.
     */
    private fun JSONObject.finite(key: String, fallback: Double): Float {
        val v = optDouble(key, fallback)
        val f = if (v.isNaN()) fallback.toFloat() else v.toFloat()
        return if (f.isInfinite()) fallback.toFloat() else f
    }

    private fun JSONObject.amount(i: Int): Float {
        if (!has("amount")) throw SpecException("filter[$i].amount")
        return optDouble("amount", 1.0).toFloat()
    }

    const val MIN_SPEED = 0.25f
    const val MAX_SPEED = 4.0f

    /**
     * The largest millisecond this parser will hand on, which is the largest one that still becomes
     * a microsecond. [RenderPlan] works in microseconds and multiplies every millisecond it is given
     * by a thousand; a hand-built spec naming a start above this would wrap that multiplication
     * round to a negative number, and a clamp downstream would then land somewhere meaningless
     * instead of at the end of the post. Clamped here because this is where every other bound in
     * the file lives, and because a value out of range is clamped rather than refused.
     */
    const val MAX_TIMELINE_MS = Long.MAX_VALUE / 1000L
}
