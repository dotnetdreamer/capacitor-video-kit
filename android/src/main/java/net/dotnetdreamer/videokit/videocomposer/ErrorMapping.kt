package net.dotnetdreamer.videokit.videocomposer

import android.system.ErrnoException
import android.system.OsConstants
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.ExportException

/** One of the failure codes `definitions.ts` promises. Kept as strings because that is the wire shape. */
object FailureCodes {
    const val UNREADABLE_INPUT = "unreadable_input"
    const val ENCODER = "encoder"
    const val MUXER = "muxer"
    const val INTERRUPTED = "interrupted"
    const val CANCELLED = "cancelled"
    const val NO_SPACE = "no_space"
    const val UNSUPPORTED = "unsupported"

    /**
     * The file grew past the host's `output.maxBytes`. No Media3 error is ever mapped to it: only
     * [SizeCeiling] decides it, from the bytes the muxer has been handed and then from the finished
     * file itself.
     */
    const val TOO_LARGE = "too_large"
    const val UNKNOWN = "unknown"
}

data class MappedFailure(
    val code: String,
    val message: String,
    val nativeCode: Int?,
    /** True for the two encoder codes that are worth one retry with relaxed settings. */
    val retryWithRelaxedEncoder: Boolean = false,
)

/**
 * Media3's failure taxonomy, boiled down to something a customer-facing string can be chosen from.
 *
 * The distinction that matters to JS is "your clip is the problem" (offer to remove it) versus
 * "this device could not encode it" (offer to retry or post the originals) versus "the disk is
 * full" (name a number of megabytes). Everything else collapses to `unknown`, because a more
 * precise code nobody acts on is just noise.
 */
@OptIn(UnstableApi::class)
object ErrorMapping {

    fun map(throwable: Throwable): MappedFailure {
        if (hasNoSpaceCause(throwable)) {
            return MappedFailure(FailureCodes.NO_SPACE, describe(throwable), nativeCodeOf(throwable))
        }
        val export = throwable as? ExportException
            ?: return MappedFailure(FailureCodes.UNKNOWN, describe(throwable), null)

        val code = export.errorCode
        return when {
            code == ExportException.ERROR_CODE_DECODER_INIT_FAILED ||
                code == ExportException.ERROR_CODE_DECODING_FAILED ||
                code == ExportException.ERROR_CODE_DECODING_FORMAT_UNSUPPORTED ->
                MappedFailure(FailureCodes.UNREADABLE_INPUT, describe(export), code)

            // The whole 2xxx family is "we could not read the bytes", which for a local file means
            // the same thing to the customer as a broken clip.
            code in IO_ERROR_RANGE ->
                MappedFailure(FailureCodes.UNREADABLE_INPUT, describe(export), code)

            code == ExportException.ERROR_CODE_ENCODER_INIT_FAILED ||
                code == ExportException.ERROR_CODE_ENCODING_FORMAT_UNSUPPORTED ->
                MappedFailure(
                    FailureCodes.ENCODER,
                    describe(export),
                    code,
                    retryWithRelaxedEncoder = true,
                )

            code == ExportException.ERROR_CODE_ENCODING_FAILED ||
                code == ExportException.ERROR_CODE_VIDEO_FRAME_PROCESSING_FAILED ||
                code == ExportException.ERROR_CODE_AUDIO_PROCESSING_FAILED ->
                MappedFailure(FailureCodes.ENCODER, describe(export), code)

            code == ExportException.ERROR_CODE_MUXING_FAILED ||
                code == ExportException.ERROR_CODE_MUXING_TIMEOUT ->
                MappedFailure(FailureCodes.MUXER, describe(export), code)

            else -> MappedFailure(FailureCodes.UNKNOWN, describe(export), code)
        }
    }

    /** A full disk surfaces as an errno buried somewhere in the cause chain, never as its own code. */
    fun hasNoSpaceCause(throwable: Throwable): Boolean {
        var current: Throwable? = throwable
        var depth = 0
        while (current != null && depth < MAX_CAUSE_DEPTH) {
            if (current is ErrnoException && current.errno == OsConstants.ENOSPC) return true
            val message = current.message
            if (message != null &&
                (message.contains("ENOSPC") || message.contains("No space left", ignoreCase = true))
            ) {
                return true
            }
            current = current.cause
            depth++
        }
        return false
    }

    fun describe(throwable: Throwable): String {
        val head = throwable.message ?: throwable.javaClass.simpleName
        val cause = throwable.cause
        return if (cause != null && cause !== throwable) {
            val tail = cause.message ?: cause.javaClass.simpleName
            "$head (caused by $tail)"
        } else {
            head
        }
    }

    private fun nativeCodeOf(throwable: Throwable): Int? =
        (throwable as? ExportException)?.errorCode

    private val IO_ERROR_RANGE = 2000..2999
    private const val MAX_CAUSE_DEPTH = 12
}
