package net.dotnetdreamer.choisy.videocomposer

/**
 * Kotlin mirror of `definitions.ts`. Deliberately plain data classes with no Android or Media3
 * types in sight: the parser, the timeline maths and the colour maths are all pure, which is what
 * makes them testable on the JVM without Robolectric.
 */

enum class Fit { CONTAIN, COVER }

data class Clip(
    val key: String,
    val uri: String,
    val inMs: Long,
    val outMs: Long,
    val speed: Float,
    val volume: Float,
    val muted: Boolean,
    val fit: Fit,
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
    val pendingPostId: String,
    val clips: List<Clip>,
    val output: Output,
    val filter: List<FilterOp>,
    val overlays: List<Overlay>,
    val audio: Audio,
    val posterAtMs: Long,
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
