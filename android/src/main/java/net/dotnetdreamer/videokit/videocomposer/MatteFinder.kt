package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.util.ExperimentalApi
import androidx.media3.common.util.UnstableApi
import androidx.media3.transformer.Composition
import androidx.media3.transformer.ExperimentalAnalyzerModeFactory
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import com.getcapacitor.JSObject
import com.google.common.util.concurrent.ListenableFuture
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.withLock
import kotlinx.coroutines.withTimeoutOrNull
import java.io.File
import java.io.IOException
import java.security.MessageDigest

/**
 * `findMatte`: a video's or a picture's subject found on the device, kept soft and written into a
 * matte track ([MatteTracks.encode]) - the file a clip's cutout names, which [CutoutEffect] draws from
 * and the editor's preview reads.
 *
 * [SubjectFinder]'s arrangement throughout, for its reasons: tracks kept in the app's cache under a
 * name made of the file's identity and how it was looked at, so asking again answers at once,
 * `cached`; one search at a time - in the SAME queue as the subject searches, since every search holds
 * a decoder and a segmenter; a second request for a search already asked for joins it; a video's
 * search never runs while a render does, and one a render starts under is stopped and run again after
 * it ([yieldToRender]); a page that has moved on stops what it no longer wants ([stopAllBut]).
 *
 * THE ENGINE. `subject` is ML Kit's subject segmentation from Play services ([MatteSegmenter]), which
 * the search first makes sure of, before it joins the queue ([subjectReady]) - downloading it once per
 * phone where Play services has not already, which alone is reported, as the `preparing` stage.
 * Where it is not to be had (no Play services, a build without it) and for `people`, the bundled selfie
 * segmenter ([SubjectSegmenter]) answers, and the track keeps `people`. A track says which it kept, and
 * its name does too, so a matte made with the selfie segmenter while the subject model was still on
 * its way is not what a later search, with the model there, is answered with.
 */
@OptIn(UnstableApi::class)
object MatteFinder {
    private const val TAG = "MatteFinder"

    /** What every matte here was made with: ML Kit, one of its two segmenters. */
    const val ENGINE = "mlkit"

    /** Frames looked at a second when the call does not say: the subject segmenter's, and the selfie one's. */
    const val DEFAULT_FPS = 10
    const val DEFAULT_PEOPLE_FPS = 15

    private const val MAX_CACHE_BYTES = 200L * 1024 * 1024
    private const val IN_USE_MS = 2 * 60 * 60 * 1000L
    private const val ORPHAN_PART_MS = 30 * 60 * 1000L
    private const val RENDER_POLL_MS = 500L
    private const val STOP_POLL_MS = 250L
    private const val MAX_TRACK_BYTES = 96 * 1024 * 1024

    /** Bumped when a track made by an older build should not be reused. */
    private const val VERSION = 1
    private const val FOLDER = "matte-tracks"
    private const val EXTENSION = ".vkmt"

    /** What `findMatte` resolves with - `FindMatteResult`. */
    data class Result(val uri: String, val cached: Boolean, val width: Int, val height: Int, val frames: Int, val meta: MatteTrackMeta) {
        fun toJson(): JSObject {
            val json = JSObject()
                .put("engine", meta.engine)
                .put("uri", uri)
                .put("cached", cached)
                .put("kind", meta.kind.wire)
                .put("target", meta.target)
                .put("width", width.toLong())
                .put("height", height.toLong())
                .put("frames", frames.toLong())
                .put("durationMs", meta.durationMs)
                .put("coverage", meta.coverage)
            meta.box?.let { json.put("box", JSObject().put("x", it.x).put("y", it.y).put("w", it.w).put("h", it.h)) }
            return json
        }
    }

    class UnreadableException(message: String) : IOException(message)

    class UnsupportedException(message: String) : Exception(message)

    class StoppedException : Exception("the search for a matte was stopped")

    private class YieldedException : Exception("stopped for a render")

    private val inFlight = HashMap<String, CompletableDeferred<Result>>()
    private val pending = HashMap<String, String>()
    private val dropped = HashSet<String>()

    private class Running(val main: Handler, val name: String) {
        val done = CompletableDeferred<Unit>()

        @Volatile
        var transformer: Transformer? = null

        @Volatile
        var yielded = false
    }

    @Volatile
    private var running: Running? = null

    /** A render is starting: see [SubjectFinder.yieldToRender]. */
    fun yieldToRender() {
        val current = running ?: return
        current.yielded = true
        current.done.completeExceptionally(YieldedException())
        current.main.post { current.transformer?.cancel() }
    }

    /** Stops every search asked for and not finished whose uri is not in [keep]: see [SubjectFinder.stopAllBut]. */
    fun stopAllBut(keep: Set<String>): Int {
        val names = synchronized(inFlight) { pending.filterValues { it !in keep }.keys.toSet().also { dropped += it } }
        val current = running
        if (current != null && current.name in names && isDropped(current.name)) {
            current.done.completeExceptionally(StoppedException())
            current.main.post { current.transformer?.cancel() }
        }
        if (names.isNotEmpty()) Log.i(TAG, "stopped ${names.size} matte searches nobody wants any more")
        return names.size
    }

    private fun isDropped(name: String): Boolean = synchronized(inFlight) { name in dropped }

    /** `fps` as asked for, brought into 1..30; absent is the engine's own. */
    fun fpsFor(asked: Double?, target: String): Int {
        if (asked == null || !asked.isFinite()) return if (target == "people") DEFAULT_PEOPLE_FPS else DEFAULT_FPS
        return Math.round(asked).coerceIn(1, 30).toInt()
    }

    /**
     * The matte track of [uri] keeping [target], made if it is not in the cache. Suspends until it
     * exists; call off the main thread. [onProgress] hears the stage and 0..1 of it. Throws
     * [UnreadableException], [UnsupportedException], [StoppedException], and what Media3 threw for a
     * video it could not read.
     */
    suspend fun find(ctx: Context, uri: String, kind: MediaLabels.Kind?, target: String, fps: Int, onProgress: (stage: String, progress: Double) -> Unit): Result {
        val app = ctx.applicationContext
        if (!MatteSegmenter.AVAILABLE && !SubjectSegmenter.AVAILABLE) {
            throw UnsupportedException("this app was built with no segmenter (videokitCutout and videokitSubjects both false)")
        }
        val resolved = kind ?: MediaLabels.kindOf(app, uri)
        val rate = if (resolved == MediaLabels.Kind.IMAGE) 0 else fps.coerceIn(1, 30)
        val folder = File(app.cacheDir, FOLDER).apply { mkdirs() }
        val identity = identityOf(app, uri)
        // The subject model is asked for first where it is wanted and in the build: a matte it made is
        // the answer, and one the selfie segmenter made in its place is the answer only when it is not.
        val preferred = if (target == "subject" && MatteSegmenter.AVAILABLE) "subject" else "people"
        cached(fileFor(folder, identity, resolved, rate, preferred))?.let { return it }

        val request = "$uri|${resolved.wire}|$rate|$target"
        val (deferred, owner) = synchronized(inFlight) {
            val existing = inFlight[request]
            if (existing != null) {
                dropped.remove(request)
                existing to false
            } else {
                pending[request] = uri
                CompletableDeferred<Result>().also { inFlight[request] = it } to true
            }
        }
        if (!owner) return deferred.await()

        try {
            // Made sure of before the queue rather than in it: a download holds no decoder, so a Focus
            // search or a render's pre-flight never waits behind one, and a stop reaches it where it waits.
            val subject = preferred == "subject" && subjectReady(app, request, onProgress)
            if (preferred == "subject" && !subject) Log.i(TAG, "the subject segmenter is not to be had; keeping people instead")
            val result = SubjectFinder.searches.withLock {
                cached(fileFor(folder, identity, resolved, rate, preferred)) ?: run {
                    if (isDropped(request)) throw StoppedException()
                    val engine = engineFor(subject)
                    val file = fileFor(folder, identity, resolved, rate, engine.target)
                    val known = cached(file)
                    if (known != null) {
                        engine.close()
                        known
                    } else {
                        findBetweenRenders(app, uri, resolved, rate, engine, file, request, onProgress)
                    }
                }
            }
            deferred.complete(result)
            return result
        } catch (e: Throwable) {
            deferred.completeExceptionally(e)
            throw e
        } finally {
            synchronized(inFlight) {
                inFlight.remove(request)
                pending.remove(request)
                dropped.remove(request)
            }
        }
    }

    /**
     * Whether the subject segmenter can answer this search, waiting while Play services downloads it
     * ([MatteSegmenter.ready]) - the `preparing` stage, which a phone that has the model never hears.
     *
     * A stop ([stopAllBut]) ends the wait within [STOP_POLL_MS] and throws [StoppedException]: the
     * download is Play services' and goes on for the next search, but nothing here waits for it - the
     * wait used to sit inside the queue, so a search stopped mid-download held every Focus and matte
     * search behind it for as long as the download's two minutes.
     */
    private suspend fun subjectReady(ctx: Context, request: String, onProgress: (String, Double) -> Unit): Boolean = coroutineScope {
        var prepared = false
        val wait = async {
            subjectModel(ctx) {
                prepared = true
                onProgress("preparing", it.coerceIn(0.0, 1.0))
            }
        }
        var ready: Boolean? = null
        while (ready == null) {
            if (isDropped(request)) {
                wait.cancel()
                throw StoppedException()
            }
            ready = withTimeoutOrNull(STOP_POLL_MS) { wait.await() }
        }
        // Back to the search's own stage, which is what a search waiting its turn in the queue says.
        if (prepared) onProgress("looking", 0.0)
        ready == true
    }

    /**
     * How a search learns whether the subject model can answer: [MatteSegmenter.ready]. A device test
     * puts a download that never ends in its place - the case a stop has to reach, and one no phone
     * that already has the model can show.
     */
    internal var subjectModel: suspend (Context, (Double) -> Unit) -> Boolean = { ctx, onProgress -> MatteSegmenter.ready(ctx, onProgress) }

    /** The engine for a search: the subject segmenter where it can answer ([subjectReady]), and the selfie segmenter otherwise. */
    private fun engineFor(subject: Boolean): MatteEngine {
        if (subject) return SubjectEngine(MatteSegmenter())
        if (!SubjectSegmenter.AVAILABLE) throw UnsupportedException("this app was built without the selfie segmenter, and Play services has no subject segmenter")
        return PeopleEngine(SubjectSegmenter(stream = true), SubjectSegmenter(stream = false))
    }

    private suspend fun findBetweenRenders(ctx: Context, uri: String, kind: MediaLabels.Kind, fps: Int, engine: MatteEngine, target: File, name: String, onProgress: (String, Double) -> Unit): Result {
        try {
            while (true) {
                if (kind == MediaLabels.Kind.VIDEO) {
                    while (JobRegistry.active().isNotEmpty()) {
                        if (isDropped(name)) throw StoppedException()
                        delay(RENDER_POLL_MS)
                    }
                }
                if (isDropped(name)) throw StoppedException()
                try {
                    return search(ctx, uri, kind, fps, engine, target, name, onProgress)
                } catch (e: YieldedException) {
                    Log.i(TAG, "${target.name} stopped for a render; looked at again after it")
                }
            }
        } finally {
            runCatching { engine.close() }
        }
    }

    private suspend fun search(ctx: Context, uri: String, kind: MediaLabels.Kind, fps: Int, engine: MatteEngine, target: File, name: String, onProgress: (String, Double) -> Unit): Result {
        val started = System.nanoTime()
        onProgress("looking", 0.0)
        val bytes = when (kind) {
            MediaLabels.Kind.IMAGE -> MatteTracks.encode(MatteAnalysis.picture(ctx, uri, engine.forPictures(), ENGINE))
            MediaLabels.Kind.VIDEO -> MatteTracks.encode(video(ctx, uri, fps, engine, name) { onProgress("looking", it) })
        }
        if (isDropped(name)) throw StoppedException()
        val folder = target.parentFile!!
        trim(folder, keep = null)
        val partial = File(folder, target.name + ".part")
        try {
            partial.writeBytes(bytes)
            if (!partial.renameTo(target)) throw IOException("the matte track could not be kept")
        } finally {
            partial.delete()
        }
        trim(folder, keep = target)
        val track = MatteTracks.parse(bytes)
        Log.i(TAG, "matte of ${track.frameCount} frames (${track.width}x${track.height}, ${bytes.size / 1024} KB, ${engine.target}) in ${(System.nanoTime() - started) / 1_000_000} ms")
        onProgress("looking", 1.0)
        return Result(Uri.fromFile(target).toString(), false, track.width, track.height, track.frameCount, checkNotNull(track.meta))
    }

    @OptIn(ExperimentalApi::class)
    private suspend fun video(ctx: Context, uri: String, fps: Int, engine: MatteEngine, name: String, onProgress: (Double) -> Unit): MatteTracks.Coded {
        val probe = try {
            Thumbnailer.probe(ctx, uri)
        } catch (e: Exception) {
            throw UnreadableException("could not open $uri: ${e.message}")
        }
        if (!probe.hasVideo) throw UnreadableException("$uri has no picture in it")
        val analysis = MatteAnalysis.video(uri, probe, fps, engine.forVideo(), ENGINE, onProgress)
        val main = Handler(Looper.getMainLooper())
        val current = Running(main, name)
        running = current
        if (isDropped(name)) current.done.completeExceptionally(StoppedException())
        main.post {
            if (current.yielded || current.done.isCompleted) return@post
            try {
                val listener = object : Transformer.Listener {
                    override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                        current.done.complete(Unit)
                    }

                    override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                        current.done.completeExceptionally(exportException)
                    }
                }
                val transformer = ExperimentalAnalyzerModeFactory.buildAnalyzer(ctx, Transformer.Builder(ctx).setLooper(Looper.getMainLooper()).addListener(listener).build())
                current.transformer = transformer
                // Nothing is written there: the analyzer's muxer writes nothing. A path is still asked for.
                transformer.start(analysis.composition, File(ctx.cacheDir, "$FOLDER/analysis.mp4").absolutePath)
            } catch (e: Throwable) {
                current.done.completeExceptionally(e)
            }
        }
        try {
            current.done.await()
            return analysis.finish()
        } catch (e: Throwable) {
            main.post { current.transformer?.cancel() }
            throw analysis.explain(e)
        } finally {
            if (running === current) running = null
            analysis.close()
        }
    }

    private fun cached(file: File): Result? {
        if (!file.isFile || file.length() == 0L) return null
        return try {
            val track = MatteTracks.parse(file.readBytes())
            val meta = track.meta ?: throw MatteTrackException("its description cannot be read")
            file.setLastModified(System.currentTimeMillis())
            Result(Uri.fromFile(file).toString(), true, track.width, track.height, track.frameCount, meta)
        } catch (e: Exception) {
            Log.w(TAG, "discarding unreadable matte ${file.name}: ${e.message}")
            file.delete()
            null
        }
    }

    /** The track a render draws [uri]'s cutout from, read whole and every frame decoded once: see [SubjectFinder.trackForRender]. */
    fun trackForRender(ctx: Context, uri: String): MatteTrack {
        val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val bytes = (ctx.contentResolver.openInputStream(parsed) ?: throw IOException("could not open $uri")).use { input ->
            val out = java.io.ByteArrayOutputStream()
            val chunk = ByteArray(64 * 1024)
            while (true) {
                val read = input.read(chunk)
                if (read < 0) break
                if (out.size() + read > MAX_TRACK_BYTES) throw MatteTrackException("matte track is larger than ${MAX_TRACK_BYTES / (1024 * 1024)} MB")
                out.write(chunk, 0, read)
            }
            out.toByteArray()
        }
        val track = MatteTracks.parse(bytes)
        track.checkFrames()
        if (parsed.scheme == "file") parsed.path?.let(::File)?.takeIf { it.parentFile?.name == FOLDER }?.setLastModified(System.currentTimeMillis())
        return track
    }

    private fun trim(folder: File, keep: File?) {
        val now = System.currentTimeMillis()
        val files = folder.listFiles()?.filter { it.isFile } ?: return
        for (file in files) if (file.name.endsWith(".part") && now - file.lastModified() > ORPHAN_PART_MS) file.delete()
        val tracks = files.filter { it.exists() && it.name.endsWith(EXTENSION) }
        var total = tracks.sumOf { it.length() }
        if (total <= MAX_CACHE_BYTES) return
        for (file in tracks.sortedBy { it.lastModified() }) {
            if (total <= MAX_CACHE_BYTES) break
            if (file == keep || now - file.lastModified() < IN_USE_MS) continue
            total -= file.length()
            file.delete()
        }
    }

    /** Where a file is, how big it is and when it was last written, so an edited file is looked at again. */
    private fun identityOf(ctx: Context, uri: String): String {
        var size = -1L
        var modified = -1L
        try {
            val parsed = Uri.parse(uri)
            if (parsed.scheme == "content") {
                ctx.contentResolver.query(parsed, null, null, null, null)?.use { cursor ->
                    if (cursor.moveToFirst()) {
                        val sizeAt = cursor.getColumnIndex(OpenableColumns.SIZE)
                        if (sizeAt >= 0 && !cursor.isNull(sizeAt)) size = cursor.getLong(sizeAt)
                        val modifiedAt = cursor.getColumnIndex("date_modified")
                        if (modifiedAt >= 0 && !cursor.isNull(modifiedAt)) modified = cursor.getLong(modifiedAt)
                    }
                }
            } else {
                val file = File(parsed.path ?: uri)
                size = file.length()
                modified = file.lastModified()
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not read the identity of $uri: ${e.message}")
        }
        return "$uri|$size|$modified"
    }

    private fun fileFor(folder: File, identity: String, kind: MediaLabels.Kind, fps: Int, target: String): File {
        val digest = MessageDigest.getInstance("SHA-1").digest("$VERSION|$identity|${kind.wire}|$fps|$target|$ENGINE".toByteArray())
        return File(folder, digest.joinToString("") { "%02x".format(it) } + EXTENSION)
    }

    /**
     * Which `matteProgress` events go out: the first of each stage, then one every [intervalMs] at most,
     * and the last of each stage always - [SubjectFinder.ProgressThrottle] with a stage.
     */
    internal class ProgressThrottle(private val intervalMs: Long = SubjectFinder.PROGRESS_INTERVAL_MS) {
        private var stage = ""
        private var lastMs = 0L

        @Synchronized
        fun offer(stage: String, progress: Double, nowMs: Long): Boolean {
            if (stage != this.stage || progress >= 1.0) {
                this.stage = stage
                lastMs = nowMs
                return true
            }
            if (nowMs - lastMs < intervalMs) return false
            lastMs = nowMs
            return true
        }
    }

    /** The subject segmenter as an engine: each frame on its own, so its answers are smoothed over time. */
    private class SubjectEngine(private val segmenter: MatteSegmenter) : MatteEngine {
        override val target = "subject"
        override val smooth = true

        override fun segment(bitmap: Bitmap): ListenableFuture<ConfidenceMask> = segmenter.segment(bitmap)

        override fun close() = segmenter.close()
    }

    /**
     * The selfie segmenter as an engine: STREAM mode for a video, which smooths each mask against the
     * ones before it itself, and SINGLE_IMAGE for a picture.
     */
    private class PeopleEngine(private val stream: SubjectSegmenter, private val single: SubjectSegmenter) : MatteEngine {
        override val target = "people"
        override val smooth = false

        override fun segment(bitmap: Bitmap): ListenableFuture<ConfidenceMask> = stream.segment(bitmap)

        override fun close() {
            stream.close()
            single.close()
        }

        fun forPictures(): MatteEngine = object : MatteEngine {
            override val target = "people"
            override val smooth = false

            override fun segment(bitmap: Bitmap): ListenableFuture<ConfidenceMask> = single.segment(bitmap)

            override fun close() = Unit
        }
    }

    /** The engine a picture is looked at with: the selfie segmenter's single-image mode where it is that one. */
    private fun MatteEngine.forPictures(): MatteEngine = (this as? PeopleEngine)?.forPictures() ?: unclosing(this)

    /** The engine a video is looked at with, which the search closes itself when it is done. */
    private fun MatteEngine.forVideo(): MatteEngine = unclosing(this)

    /** [engine] behind a close that does nothing: the search owns the engine and closes it once. */
    private fun unclosing(engine: MatteEngine): MatteEngine = object : MatteEngine by engine {
        override fun close() = Unit
    }
}
