package net.dotnetdreamer.videokit.videocomposer

/**
 * Kotlin mirror of `definitions.ts`. Deliberately plain data classes with no Android or Media3
 * types in sight: the parser, the timeline maths and the colour maths are all pure, which is what
 * makes them testable on the JVM without Robolectric.
 */

enum class Fit { CONTAIN, COVER }

/**
 * A rectangle in normalised coordinates: 0..1, TOP-LEFT origin, y down - the same system
 * [Overlay.cx] and [Overlay.cy] already use, and the web's.
 *
 * The parser guarantees a CROP that came off the wire is finite and sits inside the source frame:
 * 0 <= x, x + w <= 1, and the same in y. A side can still come out as 0, but only for a rectangle
 * whose origin was clamped onto the far edge, which is a rectangle that was never on the frame in
 * the first place. A [Placement] carries no such promise; see there.
 *
 * A rectangle COMPUTED from one is under no such promise. [RenderPlan.sourceWindow] returns a
 * window that deliberately runs outside 0..1, because the part of the output a letterbox bar covers
 * maps to no part of the source at all.
 */
data class Rect(val x: Float, val y: Float, val w: Float, val h: Float)

/**
 * Where a clip's picture is drawn: a rectangle that may also be TURNED.
 *
 * The four numbers are a [Rect]'s and are FINITE and positive like one, but they do not sit inside
 * the frame and are not meant to. A picture may be drawn off the edge of the output, and a customer
 * who drags a video half off the canvas is asking for exactly that - the frame cuts the overhang
 * off, in this renderer as in the preview. What the parser guarantees instead is that the
 * rectangle keeps a strip of itself on the frame, `MIN_ON_FRAME` wide, and that neither side is
 * larger than `MAX_PLACEMENT_SIZE` of the frame - a layer is drawn into a texture of its
 * rectangle's own size, and an unbounded side would be an unbounded texture.
 *
 * What is new is the angle, and it is the angle [Overlay.rotationDeg]
 * already carries in every respect that matters: CLOCKWISE degrees as CSS `rotate()` means them,
 * about the rectangle's CENTRE, and NOT clamped, because a caller may legitimately send 720 and
 * sin/cos reduce it.
 *
 * Null is upright, which is what every spec written before this field means. It stays null rather
 * than becoming a 0 for the same reason [Clip.crop] stays null: the plan asks this ONCE, when it is
 * built, to decide whether a rotation belongs in the transform at all, and a 0 written here would
 * put a rotation nobody asked for into every one of those specs.
 */
data class Placement(
    val x: Float,
    val y: Float,
    val w: Float,
    val h: Float,
    val rotationDeg: Float?,
) {

    /**
     * The four numbers on their own, for the placement maths, which resolves a rectangle into
     * output pixels and knows nothing about angles. The turn is applied to the RESULT of that, in
     * pixels: applied to these normalised fractions it would shear a square window into a rhombus
     * on any frame that is not square.
     */
    val bounds: Rect get() = Rect(x, y, w, h)
}

data class Clip(
    val key: String,
    val uri: String,
    val inMs: Long,
    val outMs: Long,
    val speed: Float,
    val volume: Float,
    val muted: Boolean,
    val fit: Fit,
    /**
     * The part of the ORIENTED source frame to keep, as a fraction of it. Null is the whole frame,
     * which is what every manifest written before this field existed meant and still means. Applied
     * BEFORE [fit], so [fit] measures the cropped picture and not the original.
     */
    val crop: Rect? = null,
    /**
     * Where the cropped picture is drawn on the output frame, and at what angle. Null is the whole
     * frame upright, and [fit] then letterboxes exactly as it did before this field existed.
     * Present, [fit] applies WITHIN this rectangle: the rectangle is the "frame" as far as contain
     * and cover are concerned.
     *
     * The order every engine agrees on: orient the source, CROP to [crop], fit the result into this
     * rectangle with [fit], TURN that fitted rectangle about its own centre by
     * [Placement.rotationDeg], then the colour matrix, then the overlays. The fit is measured BEFORE
     * the turn, in the upright rectangle, so the picture keeps its size as the customer spins it
     * instead of swelling to fill a growing bounding box.
     *
     * Null is not the same as `Placement(0f, 0f, 1f, 1f, null)` even though the two describe the
     * same picture. Null is what the fast path in [CompositionBuilder] tests for, and that path is
     * the promise that a clip which asks for neither field renders byte for byte as it did before.
     */
    val rect: Placement? = null,
)

/**
 * One layer of video over [ComposeSpec.clips]. Its own clips are a flat SEQUENCE, exactly like the
 * base track's: they play one after another and never overlap EACH OTHER. Overlap happens BETWEEN
 * tracks, and that is the whole reason a track exists rather than a start time on the clip - a
 * track is one `EditedMediaItemSequence`, and the items in one of those cannot overlap.
 *
 * Where a layer sits on the frame is not a property of the track: it is each clip's own [Clip.rect],
 * which the renderer has drawn since crops existed. A layout preset is a pair of rectangles written
 * onto the clips of the two tracks and nothing else.
 */
data class Track(
    /** Stable id from the manifest; echoed back on a failure alongside the clip key. */
    val id: String,
    /** Never empty: the parser refuses a track with nothing on it. */
    val clips: List<Clip>,
    /** Where this track's first clip lands on the OUTPUT timeline. Before it, the base shows. */
    val startMs: Long,
    /**
     * Higher draws later, so on top. The base track is 0 and ties break on array order. It is the
     * whole of the ordering now that a post may hold fifteen of these: with one layer z was
     * reliably 1 and nothing depended on reading it.
     */
    val z: Int,
    /** 0..1 over the whole track, multiplied into whatever the clip already has. */
    val opacity: Float,
)

data class Output(
    val width: Int,
    val height: Int,
    val fps: Int,
    val videoBitrate: Int,
    val audioBitrate: Int,
)

/**
 * A CSS Filter Effects operation. The renderer never applies these one at a time - they are folded
 * into a single colour matrix - but keeping them as a list is what lets every engine agree on the
 * maths instead of each inventing its own "saturation".
 */
sealed class FilterOp {
    data class Brightness(val amount: Float) : FilterOp()
    data class Contrast(val amount: Float) : FilterOp()
    data class Saturate(val amount: Float) : FilterOp()
    data class Sepia(val amount: Float) : FilterOp()
    data class Grayscale(val amount: Float) : FilterOp()
    data class HueRotate(val degrees: Float) : FilterOp()
    data class Tint(val r: Int, val g: Int, val b: Int, val alpha: Float) : FilterOp()
}

data class Overlay(
    val id: String,
    /** `data:image/png;base64,...`, already at output pixel scale. */
    val png: String,
    /** Centre, 0..1, top-left origin, y down (the web's coordinate system). */
    val cx: Float,
    val cy: Float,
    val wPx: Int,
    val hPx: Int,
    /** Clockwise, as CSS `rotate()` means it. */
    val rotationDeg: Float,
    val startMs: Long,
    val endMs: Long,
    val opacity: Float,
)

data class Music(
    val uri: String,
    val startMs: Long,
    val inMs: Long,
    val outMs: Long,
    val volume: Float,
    val loop: Boolean,
    val fadeInMs: Long,
    val fadeOutMs: Long,
)

data class Voiceover(
    val uri: String,
    val startMs: Long,
    val durationMs: Long,
    val volume: Float,
)

data class Audio(
    val originalMuted: Boolean,
    val originalVolume: Float,
    val music: Music?,
    val voiceover: List<Voiceover>,
)

data class ComposeSpec(
    val jobId: String,
    val batchId: String,
    /**
     * The BASE track. It always starts at 0 and ITS length is the output's length: a track in
     * [tracks] running past the OUTPUT is cut, and one ending early leaves what is under it showing.
     */
    val clips: List<Clip>,
    /**
     * How long the output runs, when that is MORE than the base track adds up to. 0 - what every
     * spec written before this field said, and what a spec carrying no tail still says - means "as
     * long as the base track".
     *
     * Past the base track's last frame the picture is BLACK, which is not a new kind of frame for
     * this engine to make: a gap item is already how a layer's lead and tail are drawn, and Media3
     * serves one as opaque black. Everything measured against the output - a layer's cut, the music,
     * a voiceover, the poster - is measured against the longer number, and nothing else changes.
     */
    val durationMs: Long = 0L,
    val output: Output,
    val filter: List<FilterOp>,
    val overlays: List<Overlay>,
    val audio: Audio,
    val posterAtMs: Long,
    /**
     * Extra video layers drawn over [clips], bottom to top by [Track.z]. Empty is exactly what
     * every spec written before this field said, and [RenderPlan] decides that ONCE when the plan
     * is built rather than per frame - the same discipline [Clip.crop] and [Clip.rect] ask for, and
     * what keeps a single untouched clip posted without a re-encode at all.
     *
     * At most [ComposeSpecParser.MAX_VIDEO_TRACKS] layers INCLUDING the base; the parser refuses a
     * longer list rather than truncating it. The cap is not a decoder budget - see there for what
     * it is and is not.
     *
     * A track's clips contribute audio exactly as the base track's do, through their own volume and
     * the spec-level [Audio.originalMuted] and [Audio.originalVolume].
     */
    val tracks: List<Track> = emptyList(),
)

/** What a `MediaMetadataRetriever` pass told us about one input file. */
data class ProbedInput(
    val durationMs: Long,
    val hasAudio: Boolean,
    val hasVideo: Boolean,
)

/** Thrown by the parser; the plugin turns it into `invalid_spec:<path>`. */
class SpecException(val path: String, message: String? = null) :
    IllegalArgumentException(message ?: "invalid_spec:$path")
