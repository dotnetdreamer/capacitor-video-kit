package net.dotnetdreamer.choisy.videocomposer

import android.content.Context
import android.os.SystemClock
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Transformer
import com.getcapacitor.JSObject
import java.io.File
import java.lang.ref.WeakReference
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.atomic.AtomicLong

/**
 * The render jobs, held for the whole process rather than for the life of a plugin instance.
 *
 * This is the piece that makes a background render survivable. A Capacitor plugin instance belongs
 * to a Bridge, a Bridge to the Activity; the system is free to destroy the Activity while a
 * foreground service keeps the process alive, and when it does, a render that finishes afterwards
 * completes into an object no WebView will ever talk to again. Retained events do not help - they
 * are retained on that dead instance.
 *
 * So the outcome lives here instead, and the next plugin instance replays whatever JS has not
 * acknowledged. Two layers of safety net sit under that: `getState` can always be asked directly,
 * and if even the process died, `getState` rejects with `job_not_found` and the caller restarts
 * from its own persisted manifest.
 */
@OptIn(UnstableApi::class)
object JobRegistry {

    private const val TAG = "VideoComposer"

    /** Terminal jobs are forgotten after this long, so the table cannot grow without bound. */
    private const val TERMINAL_TTL_MS = 24L * 60 * 60 * 1000

    enum class State { PENDING, RENDERING, INTERRUPTED, DONE, FAILED }

    class Job(
        val jobId: String,
        val pendingPostId: String,
        val jobDir: File,
        val partFile: File,
        /** Replaced once the pre-flight has probed the inputs and can build the real timeline. */
        @Volatile var plan: RenderPlan,
    ) {
        @Volatile var state: State = State.PENDING

        /** 0..1, on the output timeline. */
        @Volatile var progress: Float = 0f

        /** Latest output-timeline timestamp a frame carried; the real progress signal. */
        val lastFrameUs = AtomicLong(0L)

        /** Touched only from the Transformer looper. */
        @Volatile var transformer: Transformer? = null

        /**
         * Held for the job's whole life, not the shader chain's: Media3 releases and rebuilds its
         * shader programs at every item boundary, so the bitmaps have to outlive that.
         */
        @Volatile var overlays: List<TimedBitmapOverlay> = emptyList()

        @Volatile var cancelRequested: Boolean = false

        /** One relaxed-settings retry is allowed when an encoder refuses our request. */
        @Volatile var retriedEncoder: Boolean = false

        @Volatile var result: JSObject? = null

        @Volatile var error: JSObject? = null

        /** Set once JS has seen the terminal state, either by event or by asking. */
        @Volatile var acked: Boolean = false

        val createdAt: Long = SystemClock.elapsedRealtime()

        @Volatile var terminalAt: Long = 0L

        val isTerminal: Boolean
            get() = state == State.DONE || state == State.FAILED || state == State.INTERRUPTED
    }

    private val jobs = ConcurrentHashMap<String, Job>()

    @Volatile
    var emitter: WeakReference<VideoComposerPlugin>? = null

    /** Set by whichever of the plugin or the render service comes up first. */
    @Volatile
    var appContext: Context? = null

    fun register(job: Job) {
        jobs[job.jobId] = job
    }

    fun get(jobId: String): Job? = jobs[jobId]

    fun active(): List<Job> = jobs.values.filter { it.state == State.PENDING || it.state == State.RENDERING }

    fun forPendingPost(pendingPostId: String): List<Job> =
        jobs.values.filter { it.pendingPostId == pendingPostId }

    fun forget(jobId: String) {
        jobs.remove(jobId)
    }

    /** What the foreground notification shows: the least advanced job still running. */
    fun overallProgress(): Float = active().minOfOrNull { it.progress } ?: 1f

    fun emit(event: String, payload: JSObject, retain: Boolean) {
        val plugin = emitter?.get()
        if (plugin == null) {
            Log.d(TAG, "no bridge attached; '$event' kept for replay")
            return
        }
        plugin.emit(event, payload, retain)
    }

    /**
     * Moves a job to its terminal state and tells JS. Deliberately does NOT stop the foreground
     * service: the service polls [active] and stops itself, which avoids racing a `stopService`
     * against a `startForegroundService` that has not been delivered yet.
     */
    fun finish(job: Job, state: State, event: String, payload: JSObject) {
        job.state = state
        job.terminalAt = SystemClock.elapsedRealtime()
        if (state == State.DONE) {
            job.result = payload
            job.progress = 1f
        } else {
            job.error = payload
        }
        job.transformer = null
        emit(event, payload, retain = true)
    }

    /** Hands a fresh plugin instance every terminal outcome JS has not acknowledged yet. */
    fun replayUnacked(plugin: VideoComposerPlugin) {
        jobs.values.filter { it.isTerminal && !it.acked }.forEach { job ->
            val payload = job.result ?: job.error ?: return@forEach
            val event = if (job.state == State.DONE) "completed" else "failed"
            Log.d(TAG, "replaying '$event' for ${job.jobId}")
            plugin.emit(event, payload, retain = true)
        }
    }

    /**
     * The foreground service ran out of its system budget. Every running render is stopped and
     * reported as interrupted, so the caller can start it again the next time the app is visible.
     */
    fun interruptAll(reason: String) {
        active().forEach { job ->
            job.cancelRequested = true
            try {
                job.transformer?.cancel()
            } catch (e: IllegalStateException) {
                Log.w(TAG, "cancel on interrupt failed for ${job.jobId}: ${e.message}")
            }
            job.partFile.delete()
            finish(
                job,
                State.INTERRUPTED,
                "failed",
                JSObject()
                    .put("jobId", job.jobId)
                    .put("code", FailureCodes.INTERRUPTED)
                    .put("message", reason),
            )
        }
    }

    fun sweep(now: Long) {
        jobs.entries.removeAll { (_, job) ->
            job.isTerminal && job.terminalAt > 0L && now - job.terminalAt > TERMINAL_TTL_MS
        }
    }
}
