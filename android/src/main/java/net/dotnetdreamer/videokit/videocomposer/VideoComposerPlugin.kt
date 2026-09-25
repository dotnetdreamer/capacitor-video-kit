package net.dotnetdreamer.videokit.videocomposer

import android.Manifest
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.media.MediaCodecInfo
import android.media.MediaCodecList
import android.media.MediaFormat
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Base64
import android.util.Log
import androidx.annotation.OptIn
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.ProgressHolder
import androidx.media3.transformer.Transformer
import com.getcapacitor.JSArray
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
 *   - Staging a render input is file work too, but goes to [stagingScope], which has one worker,
 *     because the chunks of a file have to be written in the order they came.
 *   - Opening and closing a voice take goes to [recorderScope], also one worker, because a stop
 *     has to find the start that came before it finished.
 */
@OptIn(UnstableApi::class)
@CapacitorPlugin(
    name = "VideoComposer",
    permissions = [
        Permission(alias = VideoComposerPlugin.MICROPHONE, strings = [Manifest.permission.RECORD_AUDIO]),
        // Only ever asked for below API 29; from there the gallery insert is scoped and free.
        Permission(alias = VideoComposerPlugin.STORAGE, strings = [Manifest.permission.WRITE_EXTERNAL_STORAGE]),
        // Reading the gallery, for a host that draws its own - and going on reading a picked file
        // through the MediaStore URI [RetainedMedia] kept for it, which is the same grant put to a
        // second use. Two names for one grant because Android 13 split the storage permission by
        // media type, and asking for the wrong one is not a smaller grant but one the system never
        // prompts for. Neither is declared in the kit's manifest: see [GalleryLibrary] for why that
        // is the host's to do.
        Permission(alias = VideoComposerPlugin.GALLERY_VIDEO, strings = [Manifest.permission.READ_MEDIA_VIDEO]),
        // The pictures, for a host that lists them beside the videos - and for going on reading a
        // picked picture through its MediaStore URI, which from Android 13 READ_MEDIA_VIDEO does
        // not cover. A third name for the same reason there are two above: Android 13 split
        // pictures from videos as well.
        Permission(alias = VideoComposerPlugin.GALLERY_IMAGES, strings = [Manifest.permission.READ_MEDIA_IMAGES]),
        Permission(alias = VideoComposerPlugin.GALLERY_STORAGE, strings = [Manifest.permission.READ_EXTERNAL_STORAGE]),
    ],
)
class VideoComposerPlugin : Plugin() {

    private val main = Handler(Looper.getMainLooper())
    private val pluginScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)

    /**
     * [StagedRenderInputs]' work, one call at a time and in the order the calls came, as iOS's
     * `VideoComposerPlugin.staging` queue runs it. The chunks of one render input are appended in
     * the order they were sent only if they are WRITTEN in that order: the plugin thread hands them
     * over in order, and [pluginScope]'s many threads would not keep it for a page that sends the
     * next chunk before the last has answered.
     */
    private val stagingScope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))

    /**
     * The microphone's work, one call at a time and in the order the calls came. Opening a take is
     * a folder, a file and `MediaRecorder.prepare()`/`start()` - the audio input and the encoder set
     * up over binder, tens to hundreds of milliseconds - which is IO the shared plugin thread must
     * not do, and which the permission callback would otherwise do on the MAIN thread, freezing the
     * WebView on the first take after a grant. One worker rather than [pluginScope]'s many because
     * a stop has to find the start that came before it finished: the calls are handed over in
     * order, and one worker keeps that order, so a stop sent straight after a start is answered
     * exactly as it was when the start ran on the plugin thread.
     */
    private val recorderScope = CoroutineScope(SupervisorJob() + Dispatchers.IO.limitedParallelism(1))

    @Volatile private var voiceRecorder: VoiceRecorder? = null

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
        // Queued behind whatever start [recorderScope] still holds rather than run here: a start a
        // permission grant queued would otherwise open the microphone after this had let it go, with
        // nothing left to close it, and waiting on the recorder here would hold the main thread for
        // a prepare that is still going.
        recorderScope.launch { voiceRecorder?.abandon() }
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
            batchId = spec.batchId,
            jobDir = JobFolders.dir(appContext, spec.batchId),
            partFile = JobFolders.part(appContext, spec.batchId, spec.jobId),
            // Without the overlays' pixels: this placeholder is what the registry holds if the
            // pre-flight fails, and it holds it for a day. The pre-flight is handed the whole spec.
            plan = RenderPlan.build(spec.withoutOverlayPixels(), emptyMap()),
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
            // Every layer's footage, not only the base track's: a clip on a second layer is read,
            // trimmed and decoded exactly like one on the first, and a file that cannot be opened
            // has to fail the post here, where the failure can still name the clip it came from.
            // A transition's tail is read too. It is the outgoing clip's own file today, so this
            // costs nothing, but the plan clamps the tail's trim to what the probe says, and a
            // tail missing from the map would be planned off the manifest's numbers alone. It
            // carries the outgoing clip's key, so a failure names the clip the customer knows.
            val tails = spec.clips.mapNotNull { it.transitionIn?.from }
            for (clip in spec.clips + tails + spec.tracks.flatMap { it.clips }) {
                if (probes.containsKey(clip.uri)) continue
                // A picture has a header to read rather than a container, and no length or sound of
                // its own - see [Pictures]. It fails the post here like a video that will not open.
                if (clip.image) {
                    val picture = try {
                        Pictures.probe(appContext, clip.uri)
                    } catch (e: Exception) {
                        failJob(job, FailureCodes.UNREADABLE_INPUT, ErrorMapping.describe(e), clipKey = clip.key)
                        return
                    }
                    probes[clip.uri] = ProbedInput(
                        durationMs = 0L,
                        hasAudio = false,
                        hasVideo = true,
                        imageMimeType = picture.mimeType,
                    )
                    continue
                }
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
            val bytesPerSecond = (spec.output.videoBitrate + spec.output.audioBitrate) / 8.0 * 1.15
            // The header and the index, which no bitrate pays for.
            val containerBytes = 4L * 1024 * 1024
            // Held to the host's ceiling when there is one, which stops the file long before a
            // long post's bitrate says it would end - see [SizeCeiling.diskEstimate].
            val estimateBytes = SizeCeiling.diskEstimate(
                estimate = (bytesPerSecond * totalSeconds).toLong() + containerBytes,
                maxBytes = spec.output.maxBytes,
                slackBytes = (bytesPerSecond * PROGRESS_POLL_MS / 1000.0).toLong() + containerBytes,
            )
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

            // The plan the job keeps is the same plan without the overlays' data URLs, which are
            // spent now that they are bitmaps - see [withoutOverlayPixels].
            job.plan = RenderPlan.build(spec.withoutOverlayPixels(), probes)
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
                .newTransformer(appContext, job.plan, relaxEncoder, job.bytesWritten)
                .addListener(listenerFor(job, overlays))
                .build()

            job.transformer = transformer
            job.state = JobRegistry.State.RENDERING
            job.partFile.parentFile?.mkdirs()
            job.partFile.delete()
            job.bytesWritten.set(0L)
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
            if (settled(job)) return
            // The export is over, so it is let go of here rather than when the job is finished,
            // which stops the progress poll on its next tick. Without that, the poll's size check
            // could stop an export that has already finished, and delete the file [finalizeJob] is
            // measuring and moving. Nothing is lost: a cancel of a finished export is a no-op.
            job.transformer = null
            pluginScope.launch { finalizeJob(job, exportResult) }
        }

        override fun onError(
            composition: Composition,
            exportResult: ExportResult,
            exportException: ExportException,
        ) {
            if (settled(job)) return
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
     * Whether a Transformer outcome arriving now is too late to act on: the job has already ended,
     * or somebody has asked for it to end. Main looper only, where the outcomes arrive.
     *
     * Transformer can hand over `onCompleted` or `onError` after `cancel()`. It closes the muxer on
     * its own thread and only then posts the outcome to this looper (`TransformerInternal
     * .endInternal`), and a cancel that runs in between - [stopTooLarge] from a poll, a caller's
     * [cancel], [cleanup] - finds nothing left to stop and does not take the posted outcome back.
     * Acting on it would finish the job a second time: [finalizeJob] on a part file that has been
     * deleted fails `unknown` after the `too_large` and overwrites the error [getState] reports,
     * and a relaxed retry puts a failed job back to rendering. Whoever asked for the end sees to it
     * instead: [stopTooLarge] has already failed the job, a caller's [cancel] fails it `cancelled`,
     * and [cleanup] forgets it along with its folder.
     */
    private fun settled(job: JobRegistry.Job): Boolean = job.isTerminal || job.cancelRequested

    /**
     * Progress comes from the output-timeline timestamp of the frames passing through the colour
     * pass, not from `Transformer.getProgress`. With music or a voiceover in the composition,
     * Transformer averages the progress of every sequence, and an audio sequence that finished
     * seconds ago keeps reporting 99 % - so the average says 55 % while the video is at 10 %.
     * The frame timestamps are the real thing. `getProgress` is still useful for the moment before
     * the first frame arrives, and only when a single sequence makes it invertible.
     *
     * The same tick holds the export to the host's ceiling, [Output.maxBytes], against the bytes
     * the muxer has been handed so far - see [SizeCeiling] for why those, and neither an estimate
     * nor the part file's length. Here because this is the looper the Transformer has to be
     * cancelled on, and twice a second is often enough that a render stopped past the ceiling is a
     * poll's worth of video past it and no more. Asking is one read of a counter.
     */
    private fun pollProgress(job: JobRegistry.Job) {
        val holder = ProgressHolder()
        val maxBytes = job.plan.spec.output.maxBytes
        main.post(object : Runnable {
            override fun run() {
                if (job.state != JobRegistry.State.RENDERING) return
                val transformer = job.transformer ?: return

                if (maxBytes != null) {
                    SizeCeiling.tooLarge(job.bytesWritten.get(), maxBytes)?.let { message ->
                        stopTooLarge(job, transformer, message)
                        return
                    }
                }

                val frameUs = job.lastFrameUs.get()
                val progress = if (frameUs > 0L && job.plan.totalUs > 0L) {
                    min(0.99f, frameUs.toFloat() / job.plan.totalUs.toFloat())
                } else if (job.plan.singleSequence &&
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

    /**
     * Stops an export whose file has grown past the host's ceiling, and fails the render
     * `too_large` with [message]. Main looper only, like every other call on a Transformer.
     *
     * The steps a caller's [cancel] takes, and for the same reason: Transformer fires no callback
     * after `cancel()`, so the terminal state is written here. Unlike [cancel] it is all done on
     * this looper and at once, as [listenerFor]'s `onError` does it, so the job is already finished
     * by the time anything else posted here runs: a caller's cancel landing a moment later finds a
     * terminal job and adds nothing, and a second poll loop - a relaxed retry starts one of its
     * own - finds no render to measure. An outcome Transformer had already posted when it was
     * cancelled is turned away by [settled].
     *
     * Any failure of the cancel is logged and gone past, not only the `IllegalStateException` a
     * caller's [cancel] expects: `TransformerInternal.cancel` rethrows whatever releasing a
     * decoder, an encoder or the muxer threw, and nobody asked for this cancel, so an exception let
     * out here would take the app down on the main looper and leave the partial file on disk with
     * the job still rendering. It rethrows only once it has been through every release, the
     * muxer's included, so the file is as finished with as it will ever be when it is deleted.
     */
    private fun stopTooLarge(job: JobRegistry.Job, transformer: Transformer, message: String) {
        Log.w(TAG, "render ${job.jobId} stopped: $message")
        try {
            transformer.cancel()
        } catch (e: RuntimeException) {
            Log.w(TAG, "cancel past the size ceiling failed for ${job.jobId}", e)
        }
        job.partFile.delete()
        failJob(job, FailureCodes.TOO_LARGE, message)
    }

    private fun finalizeJob(job: JobRegistry.Job, exportResult: ExportResult) {
        val appContext = context.applicationContext
        try {
            // The file itself, now that the muxer has closed it: the polls counted only its
            // samples, and it is those plus the header and the index, with the gap the muxer
            // kept while writing trimmed away. Measured before the file is moved, so a render that
            // fails here touches nothing but its own part file, as every other failed render does.
            val maxBytes = job.plan.spec.output.maxBytes
            SizeCeiling.tooLarge(job.partFile.length(), maxBytes)?.let { message ->
                Log.w(TAG, "render ${job.jobId} finished too large: $message")
                job.partFile.delete()
                failJob(job, FailureCodes.TOO_LARGE, message)
                return
            }

            val stitched = JobFolders.stitched(appContext, job.batchId)
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

            val posterFile = JobFolders.poster(appContext, job.batchId)
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
     * can add up to more than a mid-range phone will hand out in one go, so past the budget the
     * largest ones are decoded at half size - the same placement, a quarter of the peak allocation.
     *
     * A PNG does not have to match the area it covers (`wPx x hPx` is its size on the OUTPUT frame;
     * full-frame effects arrive at half resolution), so the budget is worked out from the PNGs' real
     * pixel sizes, read from their headers before anything is decoded, and every overlay's scale
     * comes from the bitmap that was actually produced.
     */
    private fun decodeOverlays(plan: RenderPlan): List<TimedBitmapOverlay> {
        if (plan.overlays.isEmpty()) return emptyList()

        val sourceSizes = plan.overlays.map { placement ->
            pngPixelSize(placement.png)
                ?: throw OverlayDecodeException("overlay ${placement.id} could not be decoded")
        }
        val sampleSizes = OverlaySizing.sampleSizes(sourceSizes, OVERLAY_BITMAP_BUDGET_BYTES)

        val decoded = ArrayList<TimedBitmapOverlay>(plan.overlays.size)
        try {
            for ((i, placement) in plan.overlays.withIndex()) {
                val bitmap = decodePng(placement.png, sampleSizes[i])
                    ?: throw OverlayDecodeException("overlay ${placement.id} could not be decoded")
                val scale = OverlaySizing.overlayScale(
                    wPx = placement.wPx,
                    hPx = placement.hPx,
                    bitmapW = bitmap.width,
                    bitmapH = bitmap.height,
                )
                decoded += TimedBitmapOverlay(
                    bitmap = bitmap,
                    startUs = placement.startUs,
                    endUs = placement.endUs,
                    anchorX = placement.anchorX,
                    anchorY = placement.anchorY,
                    rotationGlDeg = placement.rotationGlDeg,
                    opacity = placement.opacity,
                    scaleX = scale.x,
                    scaleY = scale.y,
                )
            }
        } catch (e: Exception) {
            // These bitmaps never reached a job, so nobody else will hand them back.
            decoded.forEach { it.recycle() }
            throw if (e is OverlayDecodeException) e else OverlayDecodeException(ErrorMapping.describe(e))
        }
        return decoded
    }

    /**
     * The pixel size an overlay's image will decode to at sample size 1, without decoding it.
     *
     * The fast path base64-decodes only the first few characters and reads the PNG header, so
     * sizing thirty overlays does not allocate thirty copies of their bytes. Anything else - a
     * payload with whitespace in it, or a format that is not PNG - falls back to the platform
     * decoder's bounds-only pass over the whole image.
     */
    private fun pngPixelSize(dataUrl: String): OverlaySizing.PixelSize? {
        val marker = dataUrl.indexOf(BASE64_MARKER)
        if (marker < 0) return null
        val from = marker + BASE64_MARKER.length
        if (dataUrl.length - from >= OverlaySizing.PNG_HEADER_BASE64_CHARS) {
            val header = try {
                Base64.decode(
                    dataUrl.substring(from, from + OverlaySizing.PNG_HEADER_BASE64_CHARS),
                    Base64.DEFAULT,
                )
            } catch (e: IllegalArgumentException) {
                null
            }
            OverlaySizing.pngSize(header)?.let { return it }
        }

        val bytes = decodeDataUrl(dataUrl) ?: return null
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
        return if (options.outWidth > 0 && options.outHeight > 0) {
            OverlaySizing.PixelSize(options.outWidth, options.outHeight)
        } else {
            null
        }
    }

    private fun decodePng(dataUrl: String, sampleSize: Int): Bitmap? {
        val bytes = decodeDataUrl(dataUrl) ?: return null
        val options = BitmapFactory.Options().apply {
            inSampleSize = sampleSize
            inPreferredConfig = Bitmap.Config.ARGB_8888
        }
        return BitmapFactory.decodeByteArray(bytes, 0, bytes.size, options)
    }

    private fun decodeDataUrl(dataUrl: String): ByteArray? {
        val base64 = dataUrl.substringAfter(BASE64_MARKER, "")
        if (base64.isEmpty()) return null
        return try {
            Base64.decode(base64, Base64.DEFAULT)
        } catch (e: IllegalArgumentException) {
            null
        }
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
        // Off unless asked for: a precise seek decodes forward from the previous keyframe, which is
        // worth paying for a short filmstrip and not for anything else (see [Thumbnailer.frameOption]).
        val precise = call.getBoolean("precise", false) ?: false

        pluginScope.launch {
            try {
                val uris = Thumbnailer.thumbnails(context.applicationContext, uri, times, maxHeight, precise)
                val out = com.getcapacitor.JSArray()
                uris.forEach { out.put(it) }
                call.resolve(JSObject().put("uris", out))
            } catch (e: Exception) {
                call.reject(ErrorMapping.describe(e), FailureCodes.UNREADABLE_INPUT)
            }
        }
    }

    /* ======================================================================================== */
    /* Sound library                                                                             */
    /* ======================================================================================== */

    @PluginMethod
    fun extractAudio(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri.isNullOrEmpty()) {
            call.reject("uri is required", INVALID_SPEC)
            return
        }
        val fileName = call.getString("fileName")
        val keep = call.getBoolean("keep", true) ?: true

        pluginScope.launch {
            try {
                val sound = SoundLibrary.extract(context.applicationContext, uri, fileName, keep)
                // No audio track. A normal answer about a normal file, so it resolves rather than
                // rejecting: the editor says "that video has no sound in it" and stays put.
                if (sound == null) {
                    call.resolve(JSObject().put("hasAudio", false))
                    return@launch
                }
                call.resolve(soundJson(sound).put("hasAudio", true))
            } catch (e: Exception) {
                val message = ErrorMapping.describe(e)
                val code = if (message.contains("no_space")) FailureCodes.NO_SPACE else FailureCodes.UNREADABLE_INPUT
                call.reject(message, code)
            }
        }
    }

    @PluginMethod
    fun listSounds(call: PluginCall) {
        pluginScope.launch {
            val out = JSArray()
            SoundLibrary.list(context.applicationContext).forEach { out.put(soundJson(it)) }
            call.resolve(JSObject().put("sounds", out))
        }
    }

    @PluginMethod
    fun deleteSound(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrEmpty()) {
            call.reject("id is required", INVALID_SPEC)
            return
        }
        pluginScope.launch {
            SoundLibrary.delete(context.applicationContext, id)
            call.resolve()
        }
    }

    /**
     * iOS only, and refused here with `UNIMPLEMENTED`, the code Capacitor gives a call a platform
     * does not have, which a host reads as "use the file input". The web refuses it the same way.
     *
     * It exists for a fault in WebKit: WKWebView copies a file picked through an `<input type="file">`
     * before the page sees it, and that copy comes out empty when the same song is picked again about
     * a minute after the first time. Android's WebView is not WebKit. Capacitor answers its file input
     * with the system's own content picker (`FileChooserParams.createIntent`) and the page reads the
     * file that picker chose, so the kit's browser media host keeps the input here, and a native
     * picker would be a second way to do what already works.
     */
    @PluginMethod
    fun pickAudioFile(call: PluginCall) {
        call.unimplemented("pickAudioFile is iOS only; a file input picks a sound on Android")
    }

    /* ======================================================================================== */
    /* saveToGallery                                                                             */
    /* ======================================================================================== */

    /**
     * Copies a finished video into the device's gallery. See [Gallery] for why this is a MediaStore
     * insert rather than the two shapes every host reaches for first.
     */
    @PluginMethod
    fun saveToGallery(call: PluginCall) {
        // Asked for only where it is real. From API 29 the insert is scoped to the directory it
        // names, so requesting there would put a storage prompt in front of a save that needs none
        // - and the manifest caps the declaration at 28, so there would be nothing to grant.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q && getPermissionState(STORAGE) != PermissionState.GRANTED) {
            requestPermissionForAlias(STORAGE, call, "storagePermissionCallback")
            return
        }
        copyToGallery(call)
    }

    @PermissionCallback
    private fun storagePermissionCallback(call: PluginCall) {
        if (getPermissionState(STORAGE) != PermissionState.GRANTED) {
            call.reject("Storage permission is needed to save a video to the gallery", PERMISSION_DENIED)
            return
        }
        copyToGallery(call)
    }

    private fun copyToGallery(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri.isNullOrEmpty()) {
            call.reject("uri is required", INVALID_SPEC)
            return
        }

        val fileName = call.getString("fileName")
        val album = call.getString("album")
        val directory = call.getString("directory")

        // Off the shared plugin thread: this copies a whole video, and that thread is the one every
        // other plugin in the app is queued behind.
        pluginScope.launch {
            try {
                val saved = Gallery.save(context.applicationContext, uri, fileName, album, directory)
                call.resolve(JSObject().put("uri", saved.toString()))
            } catch (e: IllegalArgumentException) {
                // An option this cannot honour is the caller's mistake, not a failed save.
                call.reject(e.message ?: "that is not somewhere a video can be saved", INVALID_SPEC)
            } catch (e: SecurityException) {
                call.reject(ErrorMapping.describe(e), PERMISSION_DENIED)
            } catch (e: Exception) {
                val message = ErrorMapping.describe(e)
                val code = if (message.contains("no_space")) FailureCodes.NO_SPACE else FailureCodes.UNREADABLE_INPUT
                call.reject(message, code)
            }
        }
    }

    /** One sound, in the shape `SavedSoundResult` describes. `hasAudio` is the caller's to add. */
    private fun soundJson(sound: SoundLibrary.Sound): JSObject {
        val json = JSObject()
            .put("id", sound.id)
            .put("uri", Uri.fromFile(sound.file).toString())
            .put("fileName", sound.fileName)
            .put("durationMs", sound.durationMs)
            .put("savedAt", sound.savedAt)
        if (sound.sourceName != null) json.put("sourceName", sound.sourceName)
        return json
    }

    /* ======================================================================================== */
    /* Gallery library                                                                           */
    /* ======================================================================================== */

    /**
     * Asks to read the device's videos when that has not been settled yet, and answers with what
     * the host may now see. Never rejects for a refusal: `denied` is an answer, and the host's
     * fallback - the system picker - needs no permission at all.
     */
    @PluginMethod
    fun requestGalleryAccess(call: PluginCall) {
        val aliases = readAliases(Build.VERSION.SDK_INT, images = call.getBoolean("images") ?: false)
        if (aliases.all { getPermissionState(it) == PermissionState.GRANTED }) {
            answerGalleryAccess(call)
            return
        }
        // Asked together, which Android shows as the one "photos and videos" prompt it is.
        requestPermissionForAliases(aliases, call, "readPermissionCallback")
    }

    /**
     * Where the answer to a read-permission prompt lands, for [requestGalleryAccess] and
     * [requestMediaAccess] alike, and it answers the call in the shape that call's method promised.
     *
     * One callback, and sorting by the call rather than by the prompt, because Capacitor queues the
     * calls waiting on a permission per PLUGIN, not per callback: whichever launcher fires is handed
     * the oldest call still waiting. The two can overlap - Android answers a second request made
     * while the first is still up at once, with nothing granted - so a callback per method would
     * answer each method's promise in the other one's shape.
     */
    @PermissionCallback
    private fun readPermissionCallback(call: PluginCall) {
        when (call.methodName) {
            "requestMediaAccess" -> answerMediaAccess(call)
            else -> answerGalleryAccess(call)
        }
    }

    private fun answerGalleryAccess(call: PluginCall) {
        call.resolve(JSObject().put("access", galleryAccess()))
    }

    @PluginMethod
    fun listGalleryVideos(call: PluginCall) {
        if (galleryAccess() == "denied") {
            call.reject("The video library is not available to this app", PERMISSION_DENIED)
            return
        }
        val offset = (call.getInt("offset") ?: 0).coerceAtLeast(0)
        val limit = (call.getInt("limit") ?: DEFAULT_GALLERY_PAGE).coerceIn(1, MAX_GALLERY_PAGE)
        val images = call.getBoolean("images") ?: false

        pluginScope.launch {
            try {
                val page = GalleryLibrary.list(context.applicationContext, offset, limit, images)
                val videos = JSArray()
                page.videos.forEach { videos.put(galleryVideoJson(it)) }
                call.resolve(JSObject().put("videos", videos).put("total", page.total))
            } catch (e: SecurityException) {
                call.reject(ErrorMapping.describe(e), PERMISSION_DENIED)
            } catch (e: Exception) {
                call.reject(ErrorMapping.describe(e), FailureCodes.UNREADABLE_INPUT)
            }
        }
    }

    @PluginMethod
    fun galleryThumbnail(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrEmpty()) {
            call.reject("id is required", INVALID_SPEC)
            return
        }
        val maxSize = (call.getInt("maxSize") ?: DEFAULT_GALLERY_THUMBNAIL).coerceIn(64, 1024)

        pluginScope.launch {
            try {
                val file = GalleryLibrary.thumbnail(context.applicationContext, id, maxSize)
                call.resolve(JSObject().put("uri", Uri.fromFile(file).toString()))
            } catch (e: SecurityException) {
                call.reject(ErrorMapping.describe(e), PERMISSION_DENIED)
            } catch (e: Exception) {
                call.reject(ErrorMapping.describe(e), FailureCodes.UNREADABLE_INPUT)
            }
        }
    }

    @PluginMethod
    fun resolveGalleryVideo(call: PluginCall) {
        val id = call.getString("id")
        if (id.isNullOrEmpty()) {
            call.reject("id is required", INVALID_SPEC)
            return
        }

        pluginScope.launch {
            try {
                val video = GalleryLibrary.resolve(context.applicationContext, id)
                if (video == null) {
                    call.reject("that video is no longer in the library", FailureCodes.UNREADABLE_INPUT)
                    return@launch
                }
                call.resolve(JSObject().put("uri", video.id).put("fileName", video.fileName))
            } catch (e: SecurityException) {
                call.reject(ErrorMapping.describe(e), PERMISSION_DENIED)
            } catch (e: Exception) {
                call.reject(ErrorMapping.describe(e), FailureCodes.UNREADABLE_INPUT)
            }
        }
    }

    /** What this Android calls the right to read the device's videos. */
    private fun galleryAlias(): String = readAliases(Build.VERSION.SDK_INT, images = false).single()

    private fun galleryAccess(): String =
        GalleryLibrary.access(context, getPermissionState(galleryAlias()) == PermissionState.GRANTED)

    private fun galleryVideoJson(video: GalleryLibrary.Video): JSObject =
        JSObject()
            .put("id", video.id)
            .put("fileName", video.fileName)
            .put("durationMs", video.durationMs)
            .put("kind", if (video.image) "image" else "video")

    /* ======================================================================================== */
    /* Retained media                                                                            */
    /* ======================================================================================== */

    /**
     * The longest-lived name this device will give for a picked file. See [RetainedMedia] for the
     * two routes and why neither of them copies anything.
     *
     * Rejects only a call with no uri. A pick that cannot be kept is an answer, `durable: false`,
     * and the name it came with still plays for the rest of this session. So is a name that already
     * lasts without help - a MediaStore URI, a file in the app's own storage - which iOS would answer
     * `durable: true`; [RetainedMedia] says why the two differ.
     */
    @PluginMethod
    fun retainMedia(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri.isNullOrEmpty()) {
            call.reject("uri is required", INVALID_SPEC)
            return
        }
        // Off the shared plugin thread: both routes are calls into the system, and the MediaStore
        // one is a query of the photo picker's own provider.
        pluginScope.launch {
            val retained = RetainedMedia.retain(context.applicationContext, uri)
            call.resolve(JSObject().put("uri", retained.uri).put("durable", retained.durable))
        }
    }

    /**
     * Whether a kept name still opens, and the name to open it by - which on Android is the one it
     * was given. A `content://` URI means the same thing to every install of the host, where an
     * iOS path names the app container it was written in and has to be rebased onto the current one.
     *
     * A call with no uri is answered `exists: false` rather than rejected: there is nothing there to
     * open, which is the question.
     */
    @PluginMethod
    fun checkMedia(call: PluginCall) {
        val uri = call.getString("uri")
        if (uri.isNullOrEmpty()) {
            call.resolve(JSObject().put("exists", false).put("uri", ""))
            return
        }
        // Off the shared plugin thread: opening a document can mean its provider fetching it first.
        pluginScope.launch {
            val exists = RetainedMedia.opens(context.applicationContext, uri)
            call.resolve(JSObject().put("exists", exists).put("uri", uri))
        }
    }

    /**
     * Asks for the right to go on reading the customer's media, and answers whether it was given.
     *
     * Needed because of what [retainMedia] hands back on a modern device: a MediaStore URI is
     * durable only for as long as the host is allowed to read media at all. Without the grant the
     * URI survives perfectly and opens nothing, which is the same blank clip by a longer road. The
     * aliases are [requestGalleryAccess]'s, because the grant is the same one - see [readAliases].
     *
     * Never rejects for a refusal. The customer said no, drafts will report their clips as missing
     * after a restart, and that is a worse app rather than a broken one. What does reject is a host
     * that never declared the permissions: Capacitor rejects the ask by naming the missing ones,
     * which is how the kit tells a host to declare them (see [GalleryLibrary]).
     */
    @PluginMethod
    fun requestMediaAccess(call: PluginCall) {
        val aliases = readAliases(Build.VERSION.SDK_INT, images = call.getBoolean("images") ?: false)
        if (aliases.all { getPermissionState(it) == PermissionState.GRANTED }) {
            answerMediaAccess(call)
            return
        }
        // Asked together, which Android shows as the one "photos and videos" prompt it is, and
        // answered through [readPermissionCallback] for the reason given there.
        requestPermissionForAliases(aliases, call, "readPermissionCallback")
    }

    private fun answerMediaAccess(call: PluginCall) {
        val aliases = readAliases(Build.VERSION.SDK_INT, images = call.getBoolean("images") ?: false)
        call.resolve(JSObject().put("granted", aliases.all { getPermissionState(it) == PermissionState.GRANTED }))
    }

    /**
     * Deletes nothing on Android: [RetainedMedia] keeps a name, never a copy, and the file behind
     * the name is the customer's. A persisted grant it took is left in place as well, by choice -
     * [RetainedMedia] says why. Answered all the same, so a host calls it on every platform alike.
     *
     * The arguments are checked as the contract has every platform check them, because on iOS they
     * decide what gets deleted: an absent `uris` is the caller's mistake and says so here too,
     * rather than passing on the one platform where it happens to cost nothing. An EMPTY one is
     * legal. `keep` - the names among `uris` a host still uses, whose copies iOS spares - may be left
     * out, and changes nothing here. One that is there and is not a list is refused, because a host
     * that sent a name where a list belongs meant to spare something. A JSON null is read as left
     * out, as the web's `releaseMedia` reads it (`keep != null`), so the one call is answered alike
     * by both.
     */
    @PluginMethod
    fun releaseMedia(call: PluginCall) {
        if (call.getArray("uris") == null) {
            call.reject("uris is required", INVALID_SPEC)
            return
        }
        if (!call.data.isNull("keep") && call.getArray("keep") == null) {
            call.reject("keep must be a list of uris", INVALID_SPEC)
            return
        }
        call.resolve()
    }

    /**
     * Deletes nothing, for the reason [releaseMedia] deletes nothing, and checks its arguments as
     * iOS does for the reason [releaseMedia] checks its own. On iOS an absent `keep` read as empty
     * would delete every copy a draft still uses, and an absent `before` read as now would take a
     * clip being picked this moment, so both are refused rather than given a default. An EMPTY
     * `keep` is legal.
     *
     * `before` is read as any JSON number, not with `getDouble`: a timestamp in milliseconds is past
     * what an Int holds, so it arrives as a Long, which `getDouble` answers as absent.
     */
    @PluginMethod
    fun sweepMedia(call: PluginCall) {
        if (call.getArray("keep") == null) {
            call.reject("keep is required", INVALID_SPEC)
            return
        }
        val before = (call.data.opt("before") as? Number)?.toDouble()
        if (before == null || !before.isFinite()) {
            call.reject("before is required", INVALID_SPEC)
            return
        }
        call.resolve(JSObject().put("removed", 0))
    }

    /* ======================================================================================== */
    /* Render inputs                                                                             */
    /* ======================================================================================== */

    /**
     * Writes one base64 chunk of a render input the page holds only as bytes, and answers the
     * `file://` URI of the file it went into. Without `uri` the chunk starts a new file, named with
     * `extension` when there is one; with it, the chunk is appended to the file `uri` names, which
     * must be one this call made. See [StagedRenderInputs] for why there is such a file, and why it
     * may only be one of the kit's own.
     *
     * Rejects `invalid_spec` for a call the page got wrong: no `data`, data that is not base64, a
     * `uri` that names anything but a staged file that is still there, or an extension that is not
     * one, on any chunk.
     * A disk that would not take the chunk is `no_space`, and any other failed write is `unknown`,
     * in the system's words.
     */
    @PluginMethod
    fun stageRenderInput(call: PluginCall) {
        val data = call.getString("data")
        if (data == null) {
            call.reject("data is required", INVALID_SPEC)
            return
        }
        val uri = call.getString("uri")
        val extension = call.getString("extension")
        stagingScope.launch {
            try {
                val file = StagedRenderInputs.stage(context.applicationContext, data, uri, extension)
                call.resolve(JSObject().put("uri", Uri.fromFile(file).toString()))
            } catch (e: StagedRenderInputs.Refused) {
                call.reject(e.message, INVALID_SPEC)
            } catch (e: Exception) {
                val code = if (ErrorMapping.hasNoSpaceCause(e)) FailureCodes.NO_SPACE else FailureCodes.UNKNOWN
                call.reject(ErrorMapping.describe(e), code)
            }
        }
    }

    /**
     * Deletes the staged render inputs among `uris`, and passes over every other name without a
     * word: a page releases everything it staged in a `finally`, whatever became of each file, and a
     * name that is not a staged file is one there is nothing to do about. An absent `uris` is refused
     * as [releaseMedia] refuses one; an empty one is legal.
     *
     * On [stagingScope], behind any chunk still being written, so a release sent straight after the
     * last append finds the file finished rather than racing it.
     */
    @PluginMethod
    fun releaseRenderInputs(call: PluginCall) {
        val uris = call.getArray("uris")
        if (uris == null) {
            call.reject("uris is required", INVALID_SPEC)
            return
        }
        val names = (0 until uris.length()).mapNotNull { uris.opt(it) as? String }
        stagingScope.launch {
            StagedRenderInputs.release(context.applicationContext, names)
            call.resolve()
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

    /**
     * `batchId` only says where the take is kept, and an id `compose` would refuse is a take with
     * no batch rather than a refusal ([VoiceRecorder.folderFor]).
     */
    private fun beginRecording(call: PluginCall) {
        // On [recorderScope]: see there. The call still resolves only once the take has started.
        recorderScope.launch {
            val recorder = voiceRecorder ?: VoiceRecorder(context.applicationContext).also { voiceRecorder = it }
            try {
                recorder.start(call.getString("batchId"))
                call.resolve()
            } catch (e: VoiceRecorder.RecordingException) {
                call.reject(e.message ?: RECORDING_FAILED, e.message ?: RECORDING_FAILED)
            } catch (e: Exception) {
                // Anything else would take the app down from this worker, where the permission
                // callback it can arrive through only ever logged it.
                call.reject(e.message ?: RECORDING_FAILED, RECORDING_FAILED)
            }
        }
    }

    @PluginMethod
    fun stopVoiceRecording(call: PluginCall) {
        // The whole of it on [recorderScope], the check included, so that it sees the start queued
        // ahead of it as finished - which it always was when the start ran on the plugin thread.
        recorderScope.launch {
            val recorder = voiceRecorder
            if (recorder == null || !recorder.isRecording) {
                call.reject("not recording", NOT_RECORDING)
                return@launch
            }
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

    /**
     * Which of the frames an editor would like to offer this phone's encoder will actually take.
     *
     * Asked of `MediaCodec` rather than assumed, because this is exactly the thing that differs
     * between two phones running the same Android: every device at this minSdk has an H.264 encoder
     * (it is a CDD requirement, which is why [capabilities] probes nothing), and what that encoder
     * will do at 4K60 is a property of the chip in it.
     *
     * `areSizeAndRateSupported` is the question in one call and it is the right one: a size the
     * encoder accepts at 30 fps may be beyond it at 60, and offering a customer a rung that fails
     * at the end of their editing is the failure this exists to prevent. Sizes are tried BOTH WAYS
     * ROUND, because an encoder advertises its capability in landscape and a portrait post asks for
     * the same pixels standing up.
     *
     * Never rejects. A frame nothing can take is a row that says so, with a sentence a customer can
     * read, which is what the ladder greys out.
     */
    @PluginMethod
    fun encodeSupport(call: PluginCall) {
        val frames = call.getArray("frames") ?: JSArray()
        val answers = JSArray()
        val capabilities = avcEncoderCapabilities()
        for (i in 0 until frames.length()) {
            val frame = frames.optJSONObject(i) ?: continue
            val width = frame.optInt("width", 0)
            val height = frame.optInt("height", 0)
            val fps = frame.optInt("fps", 30)
            val answer = JSObject().put("width", width).put("height", height).put("fps", fps)
            when {
                width <= 0 || height <= 0 -> answer.put("supported", false).put("reason", "That is not a frame.")
                capabilities == null ->
                    answer.put("supported", false).put("reason", "This phone has no H.264 encoder.")
                // Either way round: the encoder states its limits in landscape, and a portrait post
                // is the same pixels turned through a right angle.
                capabilities.areSizeAndRateSupported(width, height, fps.toDouble()) ||
                    capabilities.areSizeAndRateSupported(height, width, fps.toDouble()) ->
                    answer.put("supported", true)
                else ->
                    answer
                        .put("supported", false)
                        .put("reason", "${minOf(width, height)}P at ${fps}fps is more than this phone's encoder can take.")
            }
            answers.put(answer)
        }
        call.resolve(JSObject().put("frames", answers))
    }

    /**
     * What this phone's H.264 encoder can do, or null for the phone that somehow has none.
     *
     * The first ENCODER that offers AVC. `MediaCodecList.REGULAR_CODECS` leaves out the ones that
     * are only there for special cases, which is what an editor wants to ask about, and the list is
     * walked rather than `findEncoderForFormat`ed because a format needs a size before it can be
     * asked - and the size is the question.
     */
    private fun avcEncoderCapabilities(): MediaCodecInfo.VideoCapabilities? {
        return try {
            MediaCodecList(MediaCodecList.REGULAR_CODECS).codecInfos
                .asSequence()
                .filter { it.isEncoder }
                .mapNotNull { info ->
                    info.supportedTypes
                        .firstOrNull { it.equals(MediaFormat.MIMETYPE_VIDEO_AVC, ignoreCase = true) }
                        ?.let { runCatching { info.getCapabilitiesForType(it).videoCapabilities }.getOrNull() }
                }
                .firstOrNull()
        } catch (error: Exception) {
            Log.w(TAG, "could not read the encoder's capabilities", error)
            null
        }
    }

    /**
     * How much of the WebView the system bars actually cover, in CSS pixels.
     *
     * An editor puts its tools along the bottom edge, and on some phones the WebView is laid out under
     * a transparent navigation bar while `env(safe-area-inset-bottom)` still reports 0 (the core
     * SystemBars plugin only injects insets from Android 15). Measuring the overlap - rather than
     * returning the bar sizes - means a WebView that already sits above the bars gets 0, and never
     * double padding.
     */
    @PluginMethod
    fun systemInsets(call: PluginCall) {
        val host = activity
        val webView = bridge?.webView
        if (host == null || webView == null) {
            call.resolve(JSObject().put("top", 0).put("bottom", 0))
            return
        }
        host.runOnUiThread {
            val decor = host.window.decorView
            val bars = ViewCompat.getRootWindowInsets(decor)
                ?.getInsets(WindowInsetsCompat.Type.systemBars())
            val density = host.resources.displayMetrics.density
            if (bars == null || density <= 0f) {
                call.resolve(JSObject().put("top", 0).put("bottom", 0))
                return@runOnUiThread
            }
            val decorAt = IntArray(2).also { decor.getLocationOnScreen(it) }
            val webAt = IntArray(2).also { webView.getLocationOnScreen(it) }
            val webTop = webAt[1] - decorAt[1]
            val webBottom = webTop + webView.height
            val topOverlap = max(0, bars.top - webTop)
            val bottomOverlap = max(0, webBottom - (decor.height - bars.bottom))
            call.resolve(
                JSObject()
                    .put("top", topOverlap / density)
                    .put("bottom", bottomOverlap / density),
            )
        }
    }

    /**
     * `batchId` is refused as `invalid_spec` when it is missing or names no folder of its own, `.`
     * and `..` ([JobFolders.batchIdRefusal]), before anything is written: iOS refuses the same ids
     * with the same words.
     */
    @PluginMethod
    fun prepareJob(call: PluginCall) {
        val batchId = call.getString("batchId").orEmpty()
        JobFolders.batchIdRefusal(batchId)?.let {
            call.reject(it, INVALID_SPEC)
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
            when (val outcome = JobFolders.prepareJob(context.applicationContext, batchId, inputs)) {
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

    /**
     * Refuses `batchId` as [prepareJob] does, so a discard of `..` deletes nothing at all rather
     * than the folder [JobFolders.folderName] would put it in, which is the batch `__`'s.
     */
    @PluginMethod
    fun cleanup(call: PluginCall) {
        val batchId = call.getString("batchId").orEmpty()
        JobFolders.batchIdRefusal(batchId)?.let {
            call.reject(it, INVALID_SPEC)
            return
        }
        // Anything still rendering into this folder has to stop before the folder goes.
        JobRegistry.forBatch(batchId).forEach { job ->
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
            JobFolders.cleanup(context.applicationContext, batchId)
            call.resolve()
        }
    }

    companion object {
        private const val TAG = "VideoComposer"

        const val MICROPHONE = "microphone"
        const val STORAGE = "storage"
        const val GALLERY_VIDEO = "galleryVideo"
        const val GALLERY_IMAGES = "galleryImages"
        const val GALLERY_STORAGE = "galleryStorage"

        /**
         * Every right reading the device's media needs, by the names the Android at [sdk] gives
         * them: the videos', and the pictures' too with [images]. Below Android 13 one storage
         * grant covers both, so there is nothing more to ask for.
         *
         * One answer for two callers, because they want one right for two uses: listing the
         * library for a host that draws its own gallery, and opening again a MediaStore URI that
         * [RetainedMedia] kept for a pick. The version is an argument rather than read here so the
         * choice can be pinned for each one without a device.
         */
        internal fun readAliases(sdk: Int, images: Boolean): Array<String> = when {
            sdk < Build.VERSION_CODES.TIRAMISU -> arrayOf(GALLERY_STORAGE)
            images -> arrayOf(GALLERY_VIDEO, GALLERY_IMAGES)
            else -> arrayOf(GALLERY_VIDEO)
        }

        /** A gallery page, when the host does not say. Two phone screens of a four-column grid. */
        private const val DEFAULT_GALLERY_PAGE = 60

        /** Past this a single answer over the bridge stops being cheap, and nothing needs more. */
        private const val MAX_GALLERY_PAGE = 500

        /** The long edge of a gallery thumbnail, when the host does not say. */
        private const val DEFAULT_GALLERY_THUMBNAIL = 384

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

        /** What precedes the payload in an overlay's `data:image/png;base64,...` URL. */
        private const val BASE64_MARKER = "base64,"
    }
}
