package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.media.MediaRecorder
import android.net.Uri
import android.os.Build
import android.os.SystemClock
import android.util.Log
import java.io.File
import java.io.IOException
import java.util.UUID

/**
 * Voiceover capture, straight to AAC in an MP4 container - the same thing the render can read back
 * without another transcode.
 *
 * No audio-focus dance: unlike iOS, Android has no exclusive recording session, so the preview can
 * keep playing while the microphone is open. The editor mutes the original sound itself, which is a
 * decision about what the customer hears, not about what the platform allows.
 */
class VoiceRecorder(private val appContext: Context) {

    private var recorder: MediaRecorder? = null
    private var outputFile: File? = null
    private var startedAtMs: Long = 0L

    val isRecording: Boolean
        get() = recorder != null

    class RecordingException(message: String, cause: Throwable? = null) : Exception(message, cause)

    companion object {
        /**
         * Where a take for [batchId] is written. When the post already exists, straight into its
         * job folder; the editor usually has no post yet, so the cache folder is the normal case and
         * `prepareJob` relocates the file later.
         *
         * An id `compose` would refuse - empty, `.` or `..` ([JobFolders.batchIdRefusal]) - counts
         * as none, as iOS's `VoiceRecorder.folder(for:)` reads it. The id only says where the take
         * is kept, so refusing it would lose a take the customer still wants, and filing it in the
         * folder [JobFolders.folderName] makes of it would put it in some other batch's (`..` is
         * `__`'s, and the empty id `_`'s). The web's `startVoiceRecording` does the same.
         */
        fun folderFor(ctx: Context, batchId: String?): File =
            if (batchId != null && JobFolders.batchIdRefusal(batchId) == null) {
                JobFolders.inputs(ctx, batchId)
            } else {
                JobFolders.voiceCache(ctx)
            }
    }

    data class Result(val uri: String, val durationMs: Long)

    /**
     * @param batchId where the take is written: see [folderFor].
     */
    @Throws(RecordingException::class)
    fun start(batchId: String?) {
        if (recorder != null) throw RecordingException("already_recording")

        val dir = folderFor(appContext, batchId)
        if (!dir.exists() && !dir.mkdirs()) {
            throw RecordingException("could not create ${dir.path}")
        }
        val file = File(dir, "vo-${UUID.randomUUID()}.m4a")

        val created = if (Build.VERSION.SDK_INT >= 31) {
            MediaRecorder(appContext)
        } else {
            @Suppress("DEPRECATION")
            MediaRecorder()
        }
        try {
            created.setAudioSource(MediaRecorder.AudioSource.MIC)
            created.setOutputFormat(MediaRecorder.OutputFormat.MPEG_4)
            created.setAudioEncoder(MediaRecorder.AudioEncoder.AAC)
            created.setAudioChannels(1)
            created.setAudioSamplingRate(44_100)
            created.setAudioEncodingBitRate(96_000)
            if (Build.VERSION.SDK_INT >= 26) {
                created.setOutputFile(file)
            } else {
                created.setOutputFile(file.absolutePath)
            }
            created.prepare()
            created.start()
        } catch (e: IOException) {
            created.releaseQuietly()
            file.delete()
            throw RecordingException("recording_failed", e)
        } catch (e: IllegalStateException) {
            created.releaseQuietly()
            file.delete()
            throw RecordingException("recording_failed", e)
        } catch (e: RuntimeException) {
            // start() throws a bare RuntimeException when the microphone is busy.
            created.releaseQuietly()
            file.delete()
            throw RecordingException("recording_failed", e)
        }

        recorder = created
        outputFile = file
        startedAtMs = SystemClock.elapsedRealtime()
    }

    @Throws(RecordingException::class)
    fun stop(): Result {
        val current = recorder ?: throw RecordingException("not_recording")
        val file = outputFile
        val elapsedMs = SystemClock.elapsedRealtime() - startedAtMs
        recorder = null
        outputFile = null

        try {
            current.stop()
        } catch (e: RuntimeException) {
            // stop() throws when nothing was captured - a tap shorter than roughly 300 ms. The file
            // it leaves behind is unusable, so it goes.
            current.releaseQuietly()
            file?.delete()
            throw RecordingException("recording_failed", e)
        }
        current.releaseQuietly()

        if (file == null || !file.exists() || file.length() == 0L) {
            file?.delete()
            throw RecordingException("recording_failed")
        }

        val durationMs = try {
            Thumbnailer.probe(appContext, Uri.fromFile(file).toString()).durationMs
        } catch (e: Exception) {
            0L
        }
        return Result(
            uri = Uri.fromFile(file).toString(),
            durationMs = if (durationMs > 0L) durationMs else elapsedMs,
        )
    }

    /** Used when the plugin instance goes away mid-take; the partial file is not worth keeping. */
    fun abandon() {
        val current = recorder ?: return
        recorder = null
        try {
            current.stop()
        } catch (e: RuntimeException) {
            // Nothing captured; the release below is all that matters.
        }
        current.releaseQuietly()
        outputFile?.delete()
        outputFile = null
    }

    private fun MediaRecorder.releaseQuietly() {
        try {
            reset()
            release()
        } catch (e: Exception) {
            Log.w("VideoComposer", "recorder release failed: ${e.message}")
        }
    }
}
