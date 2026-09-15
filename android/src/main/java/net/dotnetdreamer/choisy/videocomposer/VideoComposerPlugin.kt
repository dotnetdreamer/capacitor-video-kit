package net.dotnetdreamer.choisy.videocomposer

import android.Manifest
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import java.lang.ref.WeakReference
import kotlin.math.max
import kotlin.math.min

/**
 * The Capacitor face of the Android render engine.
 *
 * Almost nothing long-lived is stored here on purpose. A plugin instance dies with its Bridge and a
 * render does not, so the job table is a process-wide object, the encoder work belongs to
 * Transformer's own threads, and a foreground service keeps the process warm. What is left in this
 * class is the translation layer: parse a call, hand it to the piece that owns it, turn the outcome
 * into an event.
 *
 * Threading, because it matters here more than usual:
 *   - Capacitor runs every plugin method on ONE shared background thread for the whole app.
 *     Blocking it stalls SQLite, the camera and the maps plugin too, so no method here does IO.
 *   - Transformer has to be built, started, polled and cancelled on a single Looper thread; the
 *     main looper is the one that exists everywhere.
 *   - File work goes to [pluginScope] on the IO dispatcher. Resolving a call or emitting an event
 *     is safe from any thread.
 */
@OptIn(UnstableApi::class)
@CapacitorPlugin(
    name = "VideoComposer",
    permissions = [
        Permission(alias = VideoComposerPlugin.MICROPHONE, strings = [Manifest.permission.RECORD_AUDIO]),
    ],
)
class VideoComposerPlugin : Plugin() {

    private val main = Handler(Looper.getMainLooper())
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var voiceRecorder: VoiceRecorder? = null

    override fun load() {
        val appContext = context.applicationContext
        JobRegistry.appContext = appContext
        JobRegistry.emitter = WeakReference(this)
        voiceRecorder = VoiceRecorder(appContext)
        RenderNotification.ensureChannel(appContext)
        pluginScope.launch {
            JobFolders.sweep(appContext, System.currentTimeMillis())
            JobRegistry.sweep(android.os.SystemClock.elapsedRealtime())
        }
        // A render that finished while no WebView was attached has been waiting for this.
        JobRegistry.replayUnacked(this)
    }

    override fun handleOnDestroy() {
        // Jobs, the foreground service and the files all outlive the Bridge by design; only the
        // back-reference is dropped.
        JobRegistry.emitter = null
        voiceRecorder?.abandon()
        super.handleOnDestroy()
    }

    /** `notifyListeners` is protected; the registry reaches it through here. Safe from any thread. */
    internal fun emit(event: String, data: JSObject, retain: Boolean) {
        notifyListeners(event, data, retain)
    }

    /* ======================================================================================== */
    /* compose                                                                                   */
    /* ======================================================================================== */

    @PluginMethod
    fun compose(call: PluginCall) {
        val spec = try {
            ComposeSpecParser.parse(call.data)
        } catch (e: SpecException) {
            // A malformed spec is a bug in the caller, not a render outcome, so it fails the call
            // itself rather than arriving later as a `failed` event.
            call.reject(e.message ?: "invalid_spec:${e.path}", INVALID_SPEC)
            return
        }

        // Composing the same id twice starts one render; that is what makes a retry after a lost
        // response safe.
        JobRegistry.get(spec.jobId)?.let {
            call.resolve(JSObject().put("jobId", spec.jobId))
            return
        }

        val appContext = context.applicationContext
        val job = JobRegistry.Job(
            jobId = spec.jobId,
            pendingPostId = spec.pendingPostId,
            jobDir = JobFolders.dir(appContext, spec.pendingPostId),
            partFile = JobFolders.part(appContext, spec.pendingPostId, spec.jobId),
            plan = RenderPlan.build(spec, emptyMap()),
        )
        JobRegistry.register(job)
        call.resolve(JSObject().put("jobId", spec.jobId))

        // Asked for now, while the Activity is certainly visible: from API 31 a foreground service
        // cannot be started from the background at all.
        RenderService.start(appContext)

        pluginScope.launch { preflightAndStart(job, spec) }
    }

    /**
     * Everything that can fail cheaply, before a codec is opened: read the inputs, decode the
     * overlays, check there is room on disk. Each of these produces a failure the customer can act
     * on, which an `ExportException` three layers down would not.
     */
    private fun preflightAndStart(job: JobRegistry.Job, spec: ComposeSpec) {
        val appContext = context.applicationContext
        try {
            if (job.cancelRequested) {
                failJob(job, FailureCodes.CANCELLED, "cancelled before the render started")
                return
            }

            val probes = HashMap<String, ProbedInput>()
            for (clip in spec.clips) {
                if (probes.containsKey(clip.uri)) continue
                val info = try {
                    Thumbnailer.probe(appContext, clip.uri)
                } catch (e: Exception) {
                    failJob(
                        job,
                        FailureCodes.UNREADABLE_INPUT,
                        ErrorMapping.describe(e),
                        clipKey = clip.key,
                    )
                    return
                }
                if (!info.hasVideo) {
                    failJob(
                        job,
                        FailureCodes.UNREADABLE_INPUT,
                        "no video track in ${clip.key}",
                        clipKey = clip.key,
                    )
                    return
                }
                probes[clip.uri] = info.toProbedInput()
            }
            for (uri in listOfNotNull(spec.audio.music?.uri) + spec.audio.voiceover.map { it.uri }) {
                if (probes.containsKey(uri)) continue
                probes[uri] = try {
                    Thumbnailer.probe(appContext, uri).toProbedInput()
                } catch (e: Exception) {
                    // A missing soundtrack is not worth failing a whole post over; the plan simply
                    // proceeds with the manifest's own numbers.
                    Log.w(TAG, "could not probe audio $uri: ${e.message}")
                    continue
                }
            }

            val plan = RenderPlan.build(spec, probes)
            val overlays = try {
                decodeOverlays(plan)
            } catch (e: OverlayDecodeException) {
                failJob(job, FailureCodes.UNKNOWN, e.message ?: "overlay decode failed")
                return
            }

            val totalSeconds = max(1.0, plan.totalUs / 1_000_000.0)
            val estimateBytes =
                ((spec.output.videoBitrate + spec.output.audioBitrate) / 8.0 * totalSeconds * 1.15).toLong() +
                    4L * 1024 * 1024
            val available = JobFolders.availableBytes(job.jobDir)
            val needed = estimateBytes + 20L * 1024 * 1024
            if (available < needed) {
                overlays.forEach { it.recycle() }
                failJob(
                    job,
                    FailureCodes.NO_SPACE,
                    "no_space need=$needed free=$available",
                    needBytes = needed - available,
                )
                return
            }

            if (job.cancelRequested) {
                overlays.forEach { it.recycle() }
                failJob(job, FailureCodes.CANCELLED, "cancelled before the render started")
                return
            }

            job.plan = plan
            job.overlays = overlays
            main.post { startTransformer(job, overlays, relaxEncoder = false) }
        } catch (e: Exception) {
            Log.e(TAG, "pre-flight failed for ${job.jobId}", e)
            if (ErrorMapping.hasNoSpaceCause(e)) {
                failJob(job, FailureCodes.NO_SPACE, ErrorMapping.describe(e))
            } else {
                failJob(job, FailureCodes.UNKNOWN, ErrorMapping.describe(e))
            }
        }
    }

    /** Main looper only. */
    private fun startTransformer(
        job: JobRegistry.Job,
        overlays: List<TimedBitmapOverlay>,
        relaxEncoder: Boolean,
    ) {
        // Re-read the flag here as well: a cancel that arrived while the pre-flight was running
        // would otherwise be silently dropped and the job would render anyway.
        if (job.cancelRequested) {
            failJob(job, FailureCodes.CANCELLED, "cancelled before the render started")
            return
        }

        val appContext = context.applicationContext
        try {
            val composition = CompositionBuilder.toComposition(
                job.plan,
                overlays,
                job.lastFrameUs,
            )
            val transformer = CompositionBuilder
                .newTransformer(appContext, job.plan, relaxEncoder)
                .addListener(listenerFor(job, overlays))
                .build()

            job.transformer = transformer
            job.state = JobRegistry.State.RENDERING
            job.partFile.parentFile?.mkdirs()
            job.partFile.delete()
            transformer.start(composition, job.partFile.absolutePath)
            pollProgress(job)
        } catch (e: Exception) {
            job.partFile.delete()
            val mapped = ErrorMapping.map(e)
            failJob(job, mapped.code, mapped.message, nativeCode = mapped.nativeCode)
        }
    }

    private fun listenerFor(
        job: JobRegistry.Job,
        overlays: List<TimedBitmapOverlay>,
    ): Transformer.Listener = object : Transformer.Listener {

        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
            pluginScope.launch { finalizeJob(job, exportResult) }
        }

        override fun onError(
            composition: Composition,
            exportResult: ExportResult,
            exportException: ExportException,
        ) {
            val mapped = ErrorMapping.map(exportException)
            if (mapped.retryWithRelaxedEncoder && !job.retriedEncoder) {
                // One retry with whatever the encoder factory picks for itself. Low-end devices
                // routinely refuse a specific bitrate or size and then happily accept the default.
                Log.w(TAG, "encoder refused the request; retrying relaxed: ${mapped.message}")
                job.retriedEncoder = true
                job.partFile.delete()
                job.transformer = null
                // The same bitmaps are reused: they belong to the job, not to the attempt.
                main.post { startTransformer(job, overlays, relaxEncoder = true) }
                return
            }
            job.partFile.delete()
            failJob(
                job,
                mapped.code,
                mapped.message,
                nativeCode = mapped.nativeCode,
                clipKey = blameClip(job),
            )
        }

        override fun onFallbackApplied(
            composition: Composition,
            originalTransformationRequest: androidx.media3.transformer.TransformationRequest,
            fallbackTransformationRequest: androidx.media3.transformer.TransformationRequest,
        ) {
            // Worth a line in the log: it is the difference between "we asked for 720x1280 at
            // 4 Mbps" and what this particular encoder was willing to do.
            Log.i(
                TAG,
                "encoder fallback: $originalTransformationRequest -> $fallbackTransformationRequest",
            )
        }
    }

    /**
     * Progress comes from the output-timeline timestamp of the frames passing through the colour
     * pass, not from `Transformer.getProgress`. With music or a voiceover in the composition,
     * Transformer averages the progress of every sequence, and an audio sequence that finished
     * seconds ago keeps reporting 99 % - so the average says 55 % while the video is at 10 %.
     * The frame timestamps are the real thing. `getProgress` is still useful for the moment before
     * the first frame arrives, and only when a single sequence makes it invertible.
     */
    private fun pollProgress(job: JobRegistry.Job) {
        val holder = ProgressHolder()
        main.post(object : Runnable {
            override fun run() {
                if (job.state != JobRegistry.State.RENDERING) return
                val transformer = job.transformer ?: return

                val frameUs = job.lastFrameUs.get()
                val progress = if (frameUs > 0L && job.plan.totalUs > 0L) {
                    min(0.99f, frameUs.toFloat() / job.plan.totalUs.toFloat())
                } else if (job.plan.extraAudioSequences == 0 &&
                    transformer.getProgress(holder) == Transformer.PROGRESS_STATE_AVAILABLE
                ) {
                    job.plan.reweight(holder.progress)
                } else {
                    job.progress
                }

                if (progress >= job.progress + PROGRESS_STEP) {
                    job.progress = progress
                    emit(
                        "progress",
                        JSObject()
                            .put("jobId", job.jobId)
                            .put("progress", progress.toDouble()),
                        retain = false,
                    )
                }
                // Deliberately keeps polling whatever getProgress says: a released asset loader
                // reports NOT_STARTED before the listener has fired, and stopping here would freeze
                // the bar at whatever it last showed.
                main.postDelayed(this, PROGRESS_POLL_MS)
            }
        })
    }

    private fun finalizeJob(job: JobRegistry.Job, exportResult: ExportResult) {
        val appContext = context.applicationContext
        try {
            val stitched = JobFolders.stitched(appContext, job.pendingPostId)
            stitched.delete()
            if (!job.partFile.renameTo(stitched)) {
                failJob(job, FailureCodes.UNKNOWN, "could not move the render into place")
                return
            }

            val info = try {
                Thumbnailer.probe(appContext, Uri.fromFile(stitched).toString())
            } catch (e: Exception) {
                Log.w(TAG, "could not read back the render: ${e.message}")
                null
            }

            val posterFile = JobFolders.poster(appContext, job.pendingPostId)
            val posterAtUs = min(
                job.plan.posterAtUs,
                max(0L, ((info?.durationMs ?: 0L) - 1L) * 1000L),
            )
            val posterUri = if (Thumbnailer.poster(appContext, stitched, posterAtUs, posterFile)) {
                Uri.fromFile(posterFile).toString()
            } else {
                // Not fatal: the server cuts its own thumbnail when a post arrives without one.
                ""
            }

            val payload = JSObject()
                .put("jobId", job.jobId)
                .put("uri", Uri.fromFile(stitched).toString())
                .put("posterUri", posterUri)
                .put("durationMs", info?.durationMs ?: (job.plan.totalUs / 1000L))
                .put("width", (info?.width ?: job.plan.spec.output.width).toLong())
                .put("height", (info?.height ?: job.plan.spec.output.height).toLong())
                .put("bytes", stitched.length())

            disposeOverlays(job)
            JobRegistry.finish(job, JobRegistry.State.DONE, "completed", payload)
            Log.i(TAG, "render ${job.jobId} done: ${stitched.length()} bytes")
        } catch (e: Exception) {
            Log.e(TAG, "could not finalise ${job.jobId}", e)
            failJob(job, FailureCodes.UNKNOWN, ErrorMapping.describe(e))
        }
    }

    /**
     * Best effort at naming the clip an export failure belongs to. The exception does not carry the
     * item index, so this uses how far the timeline had got - which is right whenever the failure
     * is a decoder giving up on the clip it was reading.
     */
    private fun blameClip(job: JobRegistry.Job): String? {
        val at = job.lastFrameUs.get()
        if (at <= 0L) return job.plan.clips.firstOrNull()?.clip?.key
        val index = job.plan.prefixOutUs.indexOfLast { it <= at }
        return job.plan.clips.getOrNull(if (index < 0) 0 else index)?.clip?.key
    }

    /** The single place overlay bitmaps are handed back, on every terminal path. */
    private fun disposeOverlays(job: JobRegistry.Job) {
        val overlays = job.overlays
        job.overlays = emptyList()
        overlays.forEach { it.recycle() }
    }

    private fun failJob(
        job: JobRegistry.Job,
        code: String,
        message: String,
        nativeCode: Int? = null,
        clipKey: String? = null,
        needBytes: Long? = null,
    ) {
        val payload = JSObject()
            .put("jobId", job.jobId)
            .put("code", code)
            .put("message", message)
        nativeCode?.let { payload.put("nativeCode", it) }
        clipKey?.let { payload.put("clipKey", it) }
        needBytes?.let { payload.put("needBytes", it) }
        val state = if (code == FailureCodes.INTERRUPTED) {
            JobRegistry.State.INTERRUPTED
        } else {
            JobRegistry.State.FAILED
        }
        disposeOverlays(job)
        JobRegistry.finish(job, state, "failed", payload)
    }

    /* ======================================================================================== */
    /* Overlay decoding                                                                          */
    /* ======================================================================================== */

    private class OverlayDecodeException(message: String) : Exception(message)

    /**
     * Turns the spec's PNG data URLs into bitmaps, staying inside a memory budget. Thirty overlays
     * at output scale can add up to more than a mid-range phone will hand out in one go, so the
     * largest ones are decoded at half size and scaled back up by the placement matrix - the same
     * pixels, half the peak allocation.
     */
    private fun decodeOverlays(plan: RenderPlan): List<TimedBitmapOverlay> {
        if (plan.overlays.isEmpty()) return emptyList()

        val budgetExceeded =
            plan.overlays.sumOf { it.wPx.toLong() * it.hPx.toLong() * 4L } > OVERLAY_BITMAP_BUDGET_BYTES
        val halveAbove = if (!budgetExceeded) {
            Long.MAX_VALUE
        } else {
            plan.overlays.map { it.wPx.toLong() * it.hPx.toLong() }.sorted()
                .let { sizes -> sizes[sizes.size / 2] }
        }

        val decoded = ArrayList<TimedBitmapOverlay>(plan.overlays.size)
        try {
            for (placement in plan.overlays) {
                val sampleSize =
                    if (placement.wPx.toLong() * placement.hPx.toLong() >= halveAbove) 2 else 1
                val bitmap = decodePng(placement.png, sampleSize)
                    ?: throw OverlayDecodeException("overlay ${placement.id} could not be decoded")
                decoded += TimedBitmapOverlay(
                    bitmap = bitmap,
                    startUs = placement.startUs,
                    endUs = placement.endUs,
                    anchorX = placement.anchorX,
                    anchorY = placement.anchorY,
                    rotationGlDeg = placement.rotationGlDeg,
                    opacity = placement.opacity,
                    scale = sampleSize.toFloat(),
                )
            }
        } catch (e: Exception) {
            decoded.forEach { it.release() }
            throw if (e is OverlayDecodeException) e else OverlayDecodeException(ErrorMapping.describe(e))
        }
        return decoded
    }

    private fun decodePng(dataUrl: String, sampleSize: Int): Bitmap? {
        val base64 = dataUrl.substringAfter("base64,", "")
        if (base64.isEmpty()) return null
        val bytes = try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            return null
        }
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    /* ======================================================================================== */
    /* cancel / getState                                                                         */
    /* ======================================================================================== */

    @PluginMethod
    fun cancel(call: PluginCall) {
        val jobId = call.getString("jobId")
        if (jobId.isNullOrEmpty()) {
            call.reject("jobId is required", INVALID_SPEC)
            return
        }
        val job = JobRegistry.get(jobId)
        if (job == null || job.isTerminal) {
            call.resolve()
            return
        }
        job.cancelRequested = true

        if (job.state == JobRegistry.State.RENDERING) {
            main.post {
                try {
                    job.transformer?.cancel()
                } catch (e: IllegalStateException) {
                    Log.w(TAG, "cancel failed for $jobId: ${e.message}")
                }
                // Transformer emits no callback after cancel(), so the terminal state is written
                // here rather than waiting for a listener that will not fire.
                pluginScope.launch {
                    job.partFile.delete()
                    if (!job.isTerminal) {
                        failJob(job, FailureCodes.CANCELLED, "cancelled by caller")
                    }
                }
            }
        }
        // A PENDING job is stopped by the flag: the pre-flight re-reads it, and so does
        // startTransformer, so there is no window where a cancel is lost.
        call.resolve()
    }

    @PluginMethod
    fun getState(call: PluginCall) {
        val jobId = call.getString("jobId")
        if (jobId.isNullOrEmpty()) {
            call.reject("jobId is required", INVALID_SPEC)
            return
        }
        val job = JobRegistry.get(jobId)
        if (job == null) {
            // The process has been restarted since compose(). The caller has the manifest and can
            // start again; nothing here can tell it more than that.
            call.reject("no job with id $jobId", JOB_NOT_FOUND)
            return
        }
        val result = JSObject()
            .put("jobId", job.jobId)
            .put("state", job.state.name.lowercase())
            .put("progress", job.progress.toDouble())
        job.result?.let { result.put("result", it) }
        job.error?.let { result.put("error", it) }
        if (job.isTerminal) job.acked = true
        call.resolve(result)
    }

    /* ======================================================================================== */
    /* probe / thumbnails                                                                        */
    /* ======================================================================================== */

    @PluginMethod
    fun probe(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri.isNullOrEmpty()) {
            call.reject("uri is required", INVALID_SPEC)
            return
        }
        pluginScope.launch {
            try {
                val info = Thumbnailer.probe(context.applicationContext, uri)
                call.resolve(
                    JSObject()
                        .put("durationMs", info.durationMs)
                        .put("width", info.width.toLong())
                        .put("height", info.height.toLong())
                        .put("rotation", info.rotation.toLong())
                        .put("hasAudio", info.hasAudio)
                        .put("hasVideo", info.hasVideo),
                )
            } catch (e: Exception) {
                call.reject(ErrorMapping.describe(e), FailureCodes.UNREADABLE_INPUT)
            }
        }
    }

    @PluginMethod
    fun thumbnails(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri.isNullOrEmpty()) {
            call.reject("uri is required", INVALID_SPEC)
            return
        }
        val timesArray = call.getArray("timesMs")
        if (timesArray == null) {
            call.reject("timesMs is required", INVALID_SPEC)
            return
        }
        val times = ArrayList<Long>(timesArray.length())
        for (i in 0 until timesArray.length()) {
            times += timesArray.optLong(i, 0L).coerceAtLeast(0L)
        }
        val maxHeight = call.getInt("maxHeight") ?: 160

        pluginScope.launch {
            try {
                val uris = Thumbnailer.thumbnails(context.applicationContext, uri, times, maxHeight)
                val out = com.getcapacitor.JSArray()
                uris.forEach { out.put(it) }
                call.resolve(JSObject().put("uris", out))
            } catch (e: Exception) {
                call.reject(ErrorMapping.describe(e), FailureCodes.UNREADABLE_INPUT)
            }
        }
    }

    /* ======================================================================================== */
    /* Voice recording                                                                           */
    /* ======================================================================================== */

    @PluginMethod
    fun startVoiceRecording(call: PluginCall) {
        if (getPermissionState(MICROPHONE) != PermissionState.GRANTED) {
            requestPermissionForAlias(MICROPHONE, call, "microphonePermissionCallback")
            return
        }
        beginRecording(call)
    }

    @PermissionCallback
    private fun microphonePermissionCallback(call: PluginCall) {
        if (getPermissionState(MICROPHONE) == PermissionState.GRANTED) {
            beginRecording(call)
        } else {
            call.reject("microphone permission denied", PERMISSION_DENIED)
        }
    }

    private fun beginRecording(call: PluginCall) {
        val recorder = voiceRecorder ?: VoiceRecorder(context.applicationContext).also { voiceRecorder = it }
        try {
            recorder.start(call.getString("pendingPostId"))
            call.resolve()
        } catch (e: VoiceRecorder.RecordingException) {
            call.reject(e.message ?: RECORDING_FAILED, e.message ?: RECORDING_FAILED)
        }
    }

    @PluginMethod
    fun stopVoiceRecording(call: PluginCall) {
        val recorder = voiceRecorder
        if (recorder == null || !recorder.isRecording) {
            call.reject("not recording", NOT_RECORDING)
            return
        }
        pluginScope.launch {
            try {
                val result = recorder.stop()
                call.resolve(
                    JSObject()
                        .put("uri", result.uri)
                        .put("durationMs", result.durationMs),
                )
            } catch (e: VoiceRecorder.RecordingException) {
                call.reject(e.message ?: RECORDING_FAILED, e.message ?: RECORDING_FAILED)
            }
        }
    }

    /* ======================================================================================== */
    /* capabilities / prepareJob / cleanup                                                       */
    /* ======================================================================================== */

    @PluginMethod
    fun capabilities(call: PluginCall) {
        // An H.264 encoder and an AAC encoder are both CDD requirements at this minSdk, so there is
        // nothing worth probing for.
        call.resolve(
            JSObject()
                .put("supported", true)
                .put("videoCodec", "avc1")
                .put("audioCodec", "mp4a.40.2")
                .put("container", "mp4")
                .put("voiceRecording", true),
        )
    }

    @PluginMethod
    fun prepareJob(call: PluginCall) {
        val pendingPostId = call.getString("pendingPostId")
        if (pendingPostId.isNullOrEmpty()) {
            call.reject("pendingPostId is required", INVALID_SPEC)
            return
        }
        val inputsArray = call.getArray("inputs")
        if (inputsArray == null) {
            call.reject("inputs is required", INVALID_SPEC)
            return
        }
        val inputs = ArrayList<Pair<String, String>>(inputsArray.length())
        for (i in 0 until inputsArray.length()) {
            val entry = inputsArray.optJSONObject(i) ?: continue
            val key = entry.optString("key")
            val uri = entry.optString("uri")
            if (key.isEmpty() || uri.isEmpty()) {
                call.reject("inputs[$i] needs a key and a uri", INVALID_SPEC)
                return
            }
            inputs += key to uri
        }

        pluginScope.launch {
            when (val outcome = JobFolders.prepareJob(context.applicationContext, pendingPostId, inputs)) {
                is JobFolders.PrepareOutcome.Failed -> call.reject(outcome.message, outcome.code)
                is JobFolders.PrepareOutcome.Ok -> {
                    val array = com.getcapacitor.JSArray()
                    outcome.inputs.forEach { (key, file) ->
                        array.put(
                            JSObject()
                                .put("key", key)
                                .put("uri", Uri.fromFile(file).toString()),
                        )
                    }
                    call.resolve(
                        JSObject()
                            .put("jobDir", Uri.fromFile(outcome.jobDir).toString())
                            .put("inputs", array),
                    )
                }
            }
        }
    }

    @PluginMethod
    fun cleanup(call: PluginCall) {
        val pendingPostId = call.getString("pendingPostId")
        if (pendingPostId.isNullOrEmpty()) {
            call.reject("pendingPostId is required", INVALID_SPEC)
            return
        }
        // Anything still rendering into this folder has to stop before the folder goes.
        JobRegistry.forPendingPost(pendingPostId).forEach { job ->
            job.cancelRequested = true
            job.acked = true
            if (job.state == JobRegistry.State.RENDERING) {
                main.post {
                    try {
                        job.transformer?.cancel()
                    } catch (e: IllegalStateException) {
                        Log.w(TAG, "cancel during cleanup failed: ${e.message}")
                    }
                }
            }
            JobRegistry.forget(job.jobId)
        }
        pluginScope.launch {
            JobFolders.cleanup(context.applicationContext, pendingPostId)
            call.resolve()
        }
    }

    companion object {
        private const val TAG = "VideoComposer"

        const val MICROPHONE = "microphone"

        private const val INVALID_SPEC = "invalid_spec"
        private const val JOB_NOT_FOUND = "job_not_found"
        private const val PERMISSION_DENIED = "permission_denied"
        private const val NOT_RECORDING = "not_recording"
        private const val RECORDING_FAILED = "recording_failed"

        private const val PROGRESS_POLL_MS = 500L

        /** Only emit when the bar would visibly move. */
        private const val PROGRESS_STEP = 0.01f

        /** Peak bitmap allocation allowed for all overlays together. */
        private const val OVERLAY_BITMAP_BUDGET_BYTES = 48L * 1024 * 1024
    }
}
