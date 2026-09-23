package net.dotnetdreamer.videokit.videocomposer

import org.json.JSONArray
import org.json.JSONObject
import kotlin.math.floor

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

    /**
     * The largest a clip's placement rectangle may be, as a multiple of the output frame. A
     * placement may hang off the frame's edges (see [placementOrNull]), so its SIZE is what has to
     * stop somewhere: a clip on an extra layer is drawn into a texture of its rectangle's own size,
     * and twice a 1080x1920 output is 2160x3840, still inside the 4096 every GL implementation
     * guarantees. The same number as `MAX_PLACEMENT_SIZE` in the TypeScript, which is where a
     * customer's gesture meets it first.
     */
    private const val MAX_PLACEMENT_SIZE = 2f

    /**
     * How much of a placement rectangle has to stay ON the frame, as a fraction of it. The only
     * limit left on where a video may be put: a customer pushing one off an edge is framing the
     * shot, so it stops only where the video would be gone altogether - a rectangle with no part of
     * it on the frame draws nothing at all. The same number as `MIN_ON_FRAME` in the TypeScript.
     */
    private const val MIN_ON_FRAME = 1f / 12f

    private const val PNG_DATA_URL_PREFIX = "data:image/png;base64,"

    fun parse(json: JSONObject): ComposeSpec {
        val jobId = json.nonEmptyString("jobId")
        val batchId = json.nonEmptyString("batchId")

        val clipsJson = json.optJSONArray("clips") ?: throw SpecException("clips")
        if (clipsJson.length() == 0) throw SpecException("clips")
        val clips = (0 until clipsJson.length()).map { i ->
            val o = clipsJson.optJSONObject(i) ?: throw SpecException("clips[$i]")
            val clip = parseClip(o, "clips[$i]")
            // Read here and not in parseClip, because only a BASE clip with a clip before it has
            // anything to come from. The first base clip, every layer's clips and every tail are
            // left exactly as they were read, and whatever they carry under this key is not even
            // validated: a key an engine is told to ignore cannot also be a reason to fail a post.
            if (i == 0) clip else clip.copy(transitionIn = parseTransitionIn(o, "clips[$i].transitionIn"))
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
            batchId = batchId,
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
        // A picture is silent at 1x whatever the rest of the clip says - `ComposeClip.image` - and
        // is made so here, once, so the plan and the builder read the answer off the fields they
        // already read rather than each asking what kind of clip this is.
        val image = o.optBoolean("image", false)
        return Clip(
            key = key,
            uri = uri,
            inMs = inMs,
            outMs = outMs,
            speed = if (image) 1f else o.optDouble("speed", 1.0).toFloat().coerceIn(MIN_SPEED, MAX_SPEED),
            volume = o.optDouble("volume", 1.0).toFloat().coerceIn(0f, 1f),
            muted = image || o.optBoolean("muted", false),
            fit = if (o.optString("fit", "contain") == "cover") Fit.COVER else Fit.CONTAIN,
            crop = o.rectOrNull("crop", "$path.crop"),
            rect = o.placementOrNull("rect", "$path.rect"),
            image = image,
        )
    }

    /**
     * A base clip's `transitionIn`, or null for a cut.
     *
     * The same split as the rest of the file, drawn through a structure that is mostly numbers.
     * The SHAPE is refused with the path that broke: something that is not an object, a missing
     * kind, a tail that is not a clip, a curve that is not a run of finite numbers or disagrees
     * with the others about how many samples there are, a key nobody defined, a mask shape nobody
     * draws. Those are a caller out of step with this engine, and a transition drawn from a curve
     * it guessed at would be a different transition on every engine. The VALUES are clamped - an
     * alpha of 1.2, a blur of half the frame, a tint past white - because a render that comes out
     * a little different beats a post the customer cannot make.
     *
     * The fields are read in one fixed order, and the first failure is the one reported: `kind`,
     * then `from` (through [parseClip] at its own path, so a broken tail names itself exactly as a
     * broken clip does), then `curves`, then `mask`, then `fromTint` and `toTint`. Inside `curves`
     * the order is `alpha`, `reveal`, then each side's channels in the contract's order followed by
     * that side's unknown keys, then the unknown keys of `curves` itself, and last the check that
     * every curve has the length of the first one present. The browser's reader has to report the
     * same path for the same spec, and a fixed order is the only way two readers do.
     *
     * An explicit JSON null means the field is absent, here as it does for a crop: `transitionIn`,
     * `mask`, either tint and any single curve.
     */
    private fun parseTransitionIn(clip: JSONObject, path: String): Transition? {
        val raw = clip.opt("transitionIn")
        if (raw == null || raw == JSONObject.NULL) return null
        val o = raw as? JSONObject ?: throw SpecException(path)
        // A string and a non-empty one: the kind is only ever logged, but a spec that lost it lost
        // it somewhere, and a number coerced into a name would log a transition that never existed.
        val kind = (o.opt("kind") as? String)?.takeIf { it.isNotEmpty() } ?: throw SpecException("$path.kind")
        val fromJson = o.optJSONObject("from") ?: throw SpecException("$path.from")
        val from = parseClip(fromJson, "$path.from")
        val curves = parseCurves(o.opt("curves"), "$path.curves")
        val mask = parseMask(o.opt("mask"), "$path.mask")
        val fromTint = parseTint(o.opt("fromTint"), "$path.fromTint")
        val toTint = parseTint(o.opt("toTint"), "$path.toTint")
        return Transition(kind, from, mask, fromTint, toTint, curves)
    }

    /**
     * Every curve of a transition, each brought inside its channel's range.
     *
     * An unknown key is refused rather than skipped. The whole point of sending curves is that no
     * engine interprets them, so a channel this engine does not know is a channel it would silently
     * fail to draw while the preview drew it - the one disagreement this format exists to rule out.
     */
    private fun parseCurves(value: Any?, path: String): TransitionCurves {
        val o = value as? JSONObject ?: throw SpecException(path)
        // Every curve read, in the order read, so the length check can name the first one that
        // disagrees - the order the browser's reader has to walk them in too.
        val read = ArrayList<Pair<String, FloatArray>>()
        val alpha = readCurve(o, "alpha", "$path.alpha", 0f, 1f, read)
        val reveal = readCurve(o, "reveal", "$path.reveal", 0f, 1f, read)
        val from = parseSideCurves(o.opt("from"), "$path.from", read)
        val to = parseSideCurves(o.opt("to"), "$path.to", read)
        unknownKey(o, CURVE_KEYS)?.let { throw SpecException("$path.$it") }
        val samples = read.firstOrNull()?.second?.size
        for ((curvePath, curve) in read) {
            if (curve.size != samples) throw SpecException(curvePath)
        }
        return TransitionCurves(alpha, reveal, from, to)
    }

    private fun parseSideCurves(
        value: Any?,
        path: String,
        read: MutableList<Pair<String, FloatArray>>,
    ): TransitionSideCurves? {
        if (value == null || value == JSONObject.NULL) return null
        val o = value as? JSONObject ?: throw SpecException(path)
        val side = TransitionSideCurves(
            x = readCurve(o, "x", "$path.x", -MAX_OFFSET, MAX_OFFSET, read),
            y = readCurve(o, "y", "$path.y", -MAX_OFFSET, MAX_OFFSET, read),
            scale = readCurve(o, "scale", "$path.scale", MIN_SIDE_SCALE, MAX_SIDE_SCALE, read),
            rotation = readCurve(o, "rotation", "$path.rotation", -MAX_ROTATION, MAX_ROTATION, read),
            blur = readCurve(o, "blur", "$path.blur", 0f, MAX_FRACTION, read),
            pixelate = readCurve(o, "pixelate", "$path.pixelate", 0f, MAX_FRACTION, read),
            split = readCurve(o, "split", "$path.split", -MAX_FRACTION, MAX_FRACTION, read),
            gain = readCurve(o, "gain", "$path.gain", 0f, MAX_GAIN, read),
            tint = readCurve(o, "tint", "$path.tint", 0f, 1f, read),
        )
        unknownKey(o, SIDE_CHANNELS)?.let { throw SpecException("$path.$it") }
        return side
    }

    /**
     * One curve, or null when the key is absent. Anything else has to be an array of 2 to 121
     * finite NUMBERS: a string that happens to spell one is refused, as the contract's `number[]`
     * refuses it, and the browser's reader has to fail on the same specs. Each sample is then
     * clamped to its channel's range, a double too large for a float included - it becomes an
     * infinity on the way down and the clamp lands it on the bound, where it was headed anyway.
     */
    private fun readCurve(
        o: JSONObject,
        key: String,
        path: String,
        min: Float,
        max: Float,
        read: MutableList<Pair<String, FloatArray>>,
    ): FloatArray? {
        val value = o.opt(key)
        if (value == null || value == JSONObject.NULL) return null
        val array = value as? JSONArray ?: throw SpecException(path)
        if (array.length() < MIN_CURVE_SAMPLES || array.length() > MAX_CURVE_SAMPLES) {
            throw SpecException(path)
        }
        val curve = FloatArray(array.length()) { k ->
            val number = finiteNumber(array.opt(k)) ?: throw SpecException(path)
            number.toFloat().coerceIn(min, max)
        }
        read += path to curve
        return curve
    }

    /**
     * The mask: its shape is the shape error, the only one, and every number is a value that takes
     * its default when it is missing and is clamped when it is out of range - the contract's
     * defaults, so an absent field and the default written out draw the same edge.
     */
    private fun parseMask(value: Any?, path: String): TransitionMask? {
        if (value == null || value == JSONObject.NULL) return null
        val o = value as? JSONObject ?: throw SpecException(path)
        val shape = MaskShape.fromWire(o.opt("shape") as? String) ?: throw SpecException("$path.shape")
        // Each number is read as a JSON number or not at all, the way the curves are and the way
        // the iOS reader takes these very fields: `optDouble` would also read the string "30" as a
        // slat count, and a spec that one engine draws with thirty slats and the other with one is
        // the disagreement this format exists to rule out.
        fun number(key: String, fallback: Double): Double = finiteNumber(o.opt(key)) ?: fallback
        // Rounded half up, as `Math.round` rounds, after the clamp so a huge count cannot overflow
        // the conversion to an int.
        val count = floor(number("count", 1.0).coerceIn(1.0, MAX_BLINDS.toDouble()) + 0.5).toInt()
        return TransitionMask(
            shape = shape,
            // Whole turns taken off in double first: sine and cosine do not care, and a float
            // cannot hold a direction of 1e40 degrees at all, let alone the 90 that it is.
            angleDeg = (number("angleDeg", 0.0) % 360.0).toFloat(),
            count = count.coerceIn(1, MAX_BLINDS),
            feather = number("feather", DEFAULT_FEATHER).coerceIn(MIN_FEATHER.toDouble(), MAX_FEATHER.toDouble()).toFloat(),
            // Only a real `true` inverts. `optBoolean` would also read the string "true", which is
            // not the boolean the contract asks for.
            invert = o.opt("invert") == true,
        )
    }

    /** A tint colour: exactly three finite numbers, each clamped to 0..1, or null when absent. */
    private fun parseTint(value: Any?, path: String): FloatArray? {
        if (value == null || value == JSONObject.NULL) return null
        val array = value as? JSONArray ?: throw SpecException(path)
        if (array.length() != 3) throw SpecException(path)
        return FloatArray(3) { k ->
            (finiteNumber(array.opt(k)) ?: throw SpecException(path)).toFloat().coerceIn(0f, 1f)
        }
    }

    /** A finite JSON number, or null for anything else - a string that spells one included. */
    private fun finiteNumber(value: Any?): Double? {
        val number = (value as? Number)?.toDouble() ?: return null
        return if (number.isFinite()) number else null
    }

    /**
     * The first key of [o] that is not one of [known], in the order the object holds them - which on
     * Android is the order they arrived in, which is the order `Object.keys` gives the browser.
     */
    private fun unknownKey(o: JSONObject, known: Set<String>): String? {
        val keys = o.keys()
        while (keys.hasNext()) {
            val key = keys.next()
            if (key !in known) return key
        }
        return null
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
     * The same four numbers through a DIFFERENT clamp, with the angle carried across untouched.
     *
     * Different because a placement is not a crop. A crop is a window on the source frame and there
     * is nothing outside that frame to sample, so [parseRect] pulls one into the unit square; a
     * placement says where the picture is DRAWN, and a customer who drags a video off the side of
     * the canvas means the overhang to be cut off by the output frame. Pulling a placement inside
     * would slide that video back on screen and quietly rearrange the post.
     *
     * What is held is a STRIP of it on the frame, [MIN_ON_FRAME] wide, and nothing else: a video can
     * be pushed until only that strip is showing and no further, which is far enough to frame a shot
     * along an edge and not so far that the picture is gone. The rule is `normalisePlacement`'s in
     * the TypeScript, to the arithmetic: this parser, the iOS one and the browser's reader all have
     * to agree or the same post is a different picture per engine.
     *
     * The angle is read HERE and not in [parseRect], which is why a `rotationDeg` sent on a crop is
     * ignored rather than acted on: turning the region sampled out of the source is a different
     * operation on different pixels, one neither engine performs and the builder never asks for.
     */
    private fun JSONObject.placementOrNull(key: String, path: String): Placement? =
        optJSONObject(key)?.let {
            val box = parsePlacementRect(it, path)
            Placement(box.x, box.y, box.w, box.h, it.rotationDegOrNull())
        }

    /**
     * A placement's four numbers: the shape is a shape error exactly as it is for a crop, and the
     * position is a value and is held so that a strip of the rectangle stays on the frame.
     * [MAX_PLACEMENT_SIZE] is the ceiling on the size, and it is a real limit and not a taste: a
     * clip on an extra layer is drawn into a texture of its rectangle's own size, so an unbounded
     * `w` is an unbounded texture.
     */
    private fun parsePlacementRect(o: JSONObject, path: String): Rect {
        val w = o.finite("w", 0.0)
        if (w <= 0f) throw SpecException("$path.w")
        val h = o.finite("h", 0.0)
        if (h <= 0f) throw SpecException("$path.h")
        val width = w.coerceAtMost(MAX_PLACEMENT_SIZE)
        val height = h.coerceAtMost(MAX_PLACEMENT_SIZE)
        return Rect(
            x = o.finite("x", 0.0).coerceIn(nearEdge(width), farEdge(width)),
            y = o.finite("y", 0.0).coerceIn(nearEdge(height), farEdge(height)),
            w = width,
            h = height,
        )
    }

    /**
     * How far a placement of this size may run in one axis, as its own leading edge: pushed off the
     * near edge, and pushed off the far one. A rectangle SMALLER than [MIN_ON_FRAME] keeps all of
     * itself on the frame, because it cannot leave a twelfth of the frame behind.
     */
    private fun nearEdge(size: Float): Float = minOf(size, MIN_ON_FRAME) - size

    private fun farEdge(size: Float): Float = 1f - minOf(size, MIN_ON_FRAME)

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
     * The split this file is built on, applied to a CROP: a rectangle with no area is a shape error
     * and fails loudly, one that hangs off the edge of the source is an out-of-range value and is
     * clamped back inside it. A placement goes through [parsePlacementRect] and is held by its
     * centre instead, because the frame is something a picture is allowed to hang off.
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
        return Output(
            width and 1.inv(),
            height and 1.inv(),
            fps,
            videoBitrate,
            audioBitrate,
            maxBytes = ceilingOrNull(o.opt("maxBytes")),
        )
    }

    /**
     * `output.maxBytes` as a ceiling in whole bytes, or null for none.
     *
     * Only a finite JSON NUMBER above zero is a ceiling. Anything else - absent, null, zero, a
     * negative number, a string that spells a number - is no ceiling, because that is what the
     * contract says it means, and it is neither refused as a shape error nor clamped as a value: a
     * host with no ceiling of its own may well write out a 0 or a null it computed, and a ceiling
     * guessed at would stop renders the host never asked to stop. A number is read as a JSON number
     * or not at all, as the mask's fields are: `optDouble` would also read the string "1e8" as a
     * ceiling, and the contract's `number` is not a string.
     *
     * Rounded down, which changes no answer: a file's size is a whole number of bytes, and a whole
     * number is past a ceiling exactly when it is past that ceiling rounded down. A ceiling too
     * large for a Long becomes the largest one, which no file reaches, so it behaves as the no
     * ceiling it effectively is.
     */
    private fun ceilingOrNull(value: Any?): Long? {
        val bytes = finiteNumber(value) ?: return null
        return if (bytes > 0.0) floor(bytes).toLong() else null
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

    /*
     * The ranges a transition's numbers are held to. None of them is a taste: each is a bound past
     * which the picture stops meaning anything - a frame moved four frames away is off screen
     * whichever way it went, a blur or a mosaic cell of half the shorter side is already a flat
     * colour, and a gain of ten turns anything that is not black white. They exist so a hand-built
     * spec cannot hand the shader a number that turns into a NaN or a texture lookup nobody can
     * afford, and the browser's reader has to hold them to the same numbers.
     */

    /** Fewest samples a curve can have: its start and its end. */
    const val MIN_CURVE_SAMPLES = 2

    /** Most samples a curve can have. The editor sends 41. */
    const val MAX_CURVE_SAMPLES = 121

    private const val MAX_OFFSET = 4f
    private const val MIN_SIDE_SCALE = 0.01f
    private const val MAX_SIDE_SCALE = 20f
    private const val MAX_ROTATION = 3600f
    private const val MAX_FRACTION = 0.5f
    private const val MAX_GAIN = 10f
    private const val MAX_BLINDS = 64
    private const val DEFAULT_FEATHER = 0.01
    private const val MIN_FEATHER = 0.0005f
    private const val MAX_FEATHER = 0.5f

    private val CURVE_KEYS = setOf("alpha", "reveal", "from", "to")

    /** A side's channels in the contract's order, which is also the order they are read in. */
    private val SIDE_CHANNELS = linkedSetOf(
        "x", "y", "scale", "rotation", "blur", "pixelate", "split", "gain", "tint",
    )

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
