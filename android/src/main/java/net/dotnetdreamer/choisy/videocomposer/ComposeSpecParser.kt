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

    private const val PNG_DATA_URL_PREFIX = "data:image/png;base64,"

    fun parse(json: JSONObject): ComposeSpec {
        val jobId = json.nonEmptyString("jobId")
        val pendingPostId = json.nonEmptyString("pendingPostId")

        val clipsJson = json.optJSONArray("clips") ?: throw SpecException("clips")
        if (clipsJson.length() == 0) throw SpecException("clips")
        val clips = (0 until clipsJson.length()).map { i ->
            parseClip(clipsJson.optJSONObject(i) ?: throw SpecException("clips[$i]"), i)
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
        )
    }

    private fun parseClip(o: JSONObject, i: Int): Clip {
        val key = o.optString("key").takeIf { it.isNotEmpty() } ?: throw SpecException("clips[$i].key")
        val uri = o.optString("uri").takeIf { it.isNotEmpty() } ?: throw SpecException("clips[$i].uri")
        val inMs = o.optLong("inMs", -1L)
        if (inMs < 0L) throw SpecException("clips[$i].inMs")
        val outMs = o.optLong("outMs", -1L)
        if (outMs <= inMs) throw SpecException("clips[$i].outMs")
        return Clip(
            key = key,
            uri = uri,
            inMs = inMs,
            outMs = outMs,
            speed = o.optDouble("speed", 1.0).toFloat().coerceIn(MIN_SPEED, MAX_SPEED),
            volume = o.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f),
            muted = o.optBoolean("muted", false),
            fit = if (o.optString("fit", "contain") == "cover") Fit.COVER else Fit.CONTAIN,
        )
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
        val startMs = o.optLong("startMs", 0L).coerceAtLeast(0L)
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
                startMs = musicJson.optLong("startMs", 0L).coerceAtLeast(0L),
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
                startMs = v.optLong("startMs", 0L).coerceAtLeast(0L),
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

    private fun JSONObject.amount(i: Int): Float {
        if (!has("amount")) throw SpecException("filter[$i].amount")
        return optDouble("amount", 1.0).toFloat()
    }

    const val MIN_SPEED = 0.25f
    const val MAX_SPEED = 4.0f
}
