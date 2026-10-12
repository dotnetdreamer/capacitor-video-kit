package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
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
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.IOException
import java.io.InputStream
import java.security.MessageDigest
import kotlin.math.roundToLong

/**
 * `findSubjects`: the subjects of a video or a picture, found on the device by ML Kit's selfie
 * segmentation ([SubjectSegmenter]), followed through the footage ([SubjectTracker]) and written into a
 * subject track ([SubjectTracks.encode]) - the file a clip's focus names, which [FocusEffect] draws from
 * and the editor's preview reads.
 *
 * Every frame of a video is looked at, `fps` of them a second, decoded in order by a Media3 export that
 * encodes and writes nothing ([SubjectAnalysis]), so a minute of footage costs a minute's decode and a
 * few hundred inferences, not a few hundred seeks. Tracks are kept in the app's cache folder under a
 * name made from the file's identity and how it was looked at, so asking again for the same file
 * answers at once, `cached` - which is what the editor does before a render, since the system may have
 * emptied the cache since.
 *
 * Searches run one at a time, in the order they were asked for, and a second request for a search
 * already asked for joins it. A video's search never runs while a render does, for the reason
 * [PreviewProxy] gives for its copies - each holds a hardware decoder, and a render that could not open
 * one because a search held it would fail a post for the sake of something nobody is waiting on - and
 * one a render starts under is stopped and run again after it ([yieldToRender]). A picture holds no
 * decoder and is looked at whatever is rendering. A page that has moved on stops what it no longer
 * wants ([stopAllBut]); a track half made is never kept.
 */
@OptIn(UnstableApi::class)
object SubjectFinder {
    private const val TAG = "SubjectFinder"

    /** What [SubjectFinder] answers as `engine`: ML Kit, whose selfie segmentation finds people. */
    const val ENGINE = "mlkit"

    /** What every subject is: the selfie segmenter finds people and nothing else. */
    const val SUBJECT_KIND = "person"

    /** Frames looked at a second of video when the caller does not say: Android's, as `FindSubjectsOptions` has it. */
    const val DEFAULT_FPS = 10

    /** The range `fps` is brought into. */
    const val MIN_FPS = 1
    const val MAX_FPS = 30

    /** About four `subjectsProgress` events a second, plus the last one. */
    const val PROGRESS_INTERVAL_MS = 250L

    /** The folder is trimmed back under this, oldest first, after each track made. Tracks are small. */
    private const val MAX_CACHE_BYTES = 100L * 1024 * 1024

    /**
     * A track used more recently than this is never trimmed: a draft open in the editor reads it for
     * the preview, and a render reads it when it starts. Every request and every render touches it.
     */
    private const val IN_USE_MS = 2 * 60 * 60 * 1000L

    /** A half-written track older than this belongs to a run that was killed, and is deleted. */
    private const val ORPHAN_PART_MS = 30 * 60 * 1000L

    /** How often a waiting search looks again whether a render has finished. */
    private const val RENDER_POLL_MS = 500L

    /**
     * The largest track a render reads into memory. A minute at thirty frames a second is about a
     * megabyte; this is only there so a file that is not one cannot ask for the whole heap.
     */
    private const val MAX_TRACK_BYTES = 64 * 1024 * 1024

    /** Bumped when a track made by an older build should not be reused. */
    private const val VERSION = 1

    private const val FOLDER = "subject-tracks"
    private const val EXTENSION = ".vkst"

    /** What `findSubjects` resolves with - `FindSubjectsResult`. */
    data class Result(
        val uri: String,
        val cached: Boolean,
        val kind: MediaLabels.Kind,
        val width: Int,
        val height: Int,
        val frames: Int,
        val durationMs: Long,
        val engine: String,
        val subjects: List<SubjectInfo>,
    ) {
        fun toJson(): JSObject {
            val list = JSArray()
            subjects.forEach { list.put(it.toJson()) }
            return JSObject()
                .put("engine", engine)
                .put("uri", uri)
                .put("cached", cached)
                .put("kind", kind.wire)
                .put("width", width.toLong())
                .put("height", height.toLong())
                .put("frames", frames.toLong())
                .put("durationMs", durationMs)
                .put("subjects", list)
        }
    }

    /** The file will not open, or has no picture in it. */
    class UnreadableException(message: String) : IOException(message)

    /** No segmenter: the host built without one, or it would not start. */
    class UnsupportedException(message: String) : Exception(message)

    /** Nobody wants this search any more ([stopAllBut]): it was never started, or it was stopped. */
    class StoppedException : Exception("the search for subjects was stopped")

    /** The search being made was stopped for a render; it is made again once the render is done. */
    private class YieldedException : Exception("stopped for a render")

    /** One search at a time, in the order they were asked for. */
    private val queue = Mutex()

    /** A search being made, by its file name, so a second request for the same file joins the first. */
    private val inFlight = HashMap<String, CompletableDeferred<Result>>()

    /** The uri each search in [inFlight] was asked for, by the same name. Guarded by [inFlight]. */
    private val pending = HashMap<String, String>()

    /** Those of [pending] that [stopAllBut] stopped and nobody has asked for since. Guarded by [inFlight]. */
    private val dropped = HashSet<String>()

    /** The video being looked at right now, so a render or a page can stop it. */
    private class Running(val main: Handler, val name: String) {
        val done = CompletableDeferred<Unit>()

        @Volatile
        var transformer: Transformer? = null

        @Volatile
        var yielded = false
    }

    @Volatile
    private var running: Running? = null

    /**
     * A render is starting. A video being looked at stops now and is looked at again once no render
     * is running, and no other video's search starts until then; see the class comment.
     */
    fun yieldToRender() {
        val current = running ?: return
        current.yielded = true
        current.done.completeExceptionally(YieldedException())
        current.main.post { current.transformer?.cancel() }
    }

    /**
     * Stops every search asked for and not finished whose uri is not in [keep], as the strings
     * [find] was given: one waiting its turn is never started, the one being made is stopped, and
     * their requests fail with [StoppedException]. A uri asked for again before its search was reached
     * is searched after all. Answers how many searches were stopped.
     */
    fun stopAllBut(keep: Set<String>): Int {
        val names = synchronized(inFlight) {
            pending.filterValues { it !in keep }.keys.toSet().also { dropped += it }
        }
        val current = running
        // Asked for again since the lock was let go, and so no longer stopped: leave it running.
        if (current != null && current.name in names && isDropped(current.name)) {
            current.done.completeExceptionally(StoppedException())
            current.main.post { current.transformer?.cancel() }
        }
        if (names.isNotEmpty()) Log.i(TAG, "stopped ${names.size} searches nobody wants any more, keeping ${keep.size}")
        return names.size
    }

    private fun isDropped(name: String): Boolean = synchronized(inFlight) { name in dropped }

    /** `fps` as asked for, brought into [MIN_FPS]..[MAX_FPS] and rounded; absent or not a number is [DEFAULT_FPS]. */
    fun fpsFor(asked: Double?): Int {
        if (asked == null || !asked.isFinite()) return DEFAULT_FPS
        return asked.roundToLong().coerceIn(MIN_FPS.toLong(), MAX_FPS.toLong()).toInt()
    }

    /**
     * The subject track of [uri], made if it is not in the cache already. Suspends until it exists;
     * call off the main thread. [kind] null is read off the file. [onProgress] hears 0..1 of the frames
     * looked at, from Media3's GL thread, and 1 once the track is written. Throws [UnreadableException],
     * [UnsupportedException], [StoppedException], and whatever Media3 threw for a video it could not read.
     */
    suspend fun find(
        ctx: Context,
        uri: String,
        kind: MediaLabels.Kind?,
        fps: Int,
        onProgress: (Double) -> Unit,
    ): Result {
        val app = ctx.applicationContext
        if (!SubjectSegmenter.AVAILABLE) {
            throw UnsupportedException("this app was built without subject segmentation (videokitSubjects = false)")
        }
        val resolved = kind ?: MediaLabels.kindOf(app, uri)
        // A picture is one frame whatever was asked, and is the same track at any rate.
        val rate = if (resolved == MediaLabels.Kind.IMAGE) 0 else fps.coerceIn(MIN_FPS, MAX_FPS)
        val name = cacheName(app, uri, resolved, rate)
        val folder = File(app.cacheDir, FOLDER).apply { mkdirs() }
        val file = File(folder, name + EXTENSION)

        cached(file)?.let { return it }

        val (deferred, owner) = synchronized(inFlight) {
            val running = inFlight[name]
            if (running != null) {
                // Wanted again, so a stop that has not reached it yet no longer applies.
                dropped.remove(name)
                running to false
            } else {
                pending[name] = uri
                CompletableDeferred<Result>().also { inFlight[name] = it } to true
            }
        }
        if (!owner) return deferred.await()

        try {
            val result = queue.withLock {
                // Made while this request waited its turn, by an earlier run of the app.
                cached(file) ?: if (isDropped(name)) throw StoppedException() else findBetweenRenders(app, uri, resolved, rate, file, name, onProgress)
            }
            deferred.complete(result)
            return result
        } catch (e: Throwable) {
            deferred.completeExceptionally(e)
            throw e
        } finally {
            synchronized(inFlight) {
                inFlight.remove(name)
                pending.remove(name)
                dropped.remove(name)
            }
        }
    }

    /** [search], started for a video only while no render runs, and started again if one stops it. */
    private suspend fun findBetweenRenders(
        ctx: Context,
        uri: String,
        kind: MediaLabels.Kind,
        fps: Int,
        target: File,
        name: String,
        onProgress: (Double) -> Unit,
    ): Result {
        while (true) {
            if (kind == MediaLabels.Kind.VIDEO) {
                while (JobRegistry.active().isNotEmpty()) {
                    if (isDropped(name)) throw StoppedException()
                    delay(RENDER_POLL_MS)
                }
            }
            if (isDropped(name)) throw StoppedException()
            try {
                return search(ctx, uri, kind, fps, target, name, onProgress)
            } catch (e: YieldedException) {
                Log.i(TAG, "${target.name} stopped for a render; looked at again after it")
            }
        }
    }

    /** One search, start to finish: the frames looked at, the track written beside [target] and moved onto it. */
    private suspend fun search(
        ctx: Context,
        uri: String,
        kind: MediaLabels.Kind,
        fps: Int,
        target: File,
        name: String,
        onProgress: (Double) -> Unit,
    ): Result {
        val started = System.nanoTime()
        val content = when (kind) {
            MediaLabels.Kind.IMAGE -> SubjectAnalysis.picture(ctx, uri)
            MediaLabels.Kind.VIDEO -> video(ctx, uri, fps, name, onProgress)
        }
        // Stopped while it was being finished: a track nobody wants is not kept.
        if (isDropped(name)) throw StoppedException()
        val folder = target.parentFile!!
        trim(folder, keep = null)
        val partial = File(folder, target.name + ".part")
        try {
            partial.writeBytes(SubjectTracks.encode(content))
            if (!partial.renameTo(target)) throw IOException("the subject track could not be kept")
        } finally {
            partial.delete()
        }
        trim(folder, keep = target)
        Log.i(
            TAG,
            "found ${content.meta.subjects.size} subjects in ${content.frames.size} frames of ${target.name} " +
                "in ${(System.nanoTime() - started) / 1_000_000} ms",
        )
        onProgress(1.0)
        return resultOf(target, content.width, content.height, content.frames.size, content.meta, cached = false)
    }

    /**
     * A video looked at by a Media3 export that encodes and writes nothing, on the main looper as every
     * Transformer here is, suspended until it has seen every frame. A render starting meanwhile stops it
     * with a [YieldedException], and [stopAllBut] with a [StoppedException].
     */
    @OptIn(ExperimentalApi::class)
    private suspend fun video(ctx: Context, uri: String, fps: Int, name: String, onProgress: (Double) -> Unit): SubjectTrackContent {
        val probe = try {
            Thumbnailer.probe(ctx, uri)
        } catch (e: Exception) {
            throw UnreadableException("could not open $uri: ${e.message}")
        }
        if (!probe.hasVideo) throw UnreadableException("$uri has no picture in it")
        val analysis = SubjectAnalysis.video(uri, probe, fps, onProgress)
        val main = Handler(Looper.getMainLooper())
        val current = Running(main, name)
        running = current
        // Stopped between the check before this search and here, where [stopAllBut] could not see it.
        if (isDropped(name)) current.done.completeExceptionally(StoppedException())
        main.post {
            // Stopped for a render, or by the page, before it could start: nothing to start.
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
                val transformer = ExperimentalAnalyzerModeFactory.buildAnalyzer(
                    ctx,
                    Transformer.Builder(ctx).setLooper(Looper.getMainLooper()).addListener(listener).build(),
                )
                current.transformer = transformer
                // Nothing is written there: the analyzer's muxer writes nothing. A path is still asked for.
                transformer.start(analysis.composition, File(ctx.cacheDir, "$FOLDER/$name.analysis").absolutePath)
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

    /** A track already on disk, touched so the cache trim keeps it, answered as a result; or null. */
    private fun cached(file: File): Result? {
        if (!file.isFile || file.length() == 0L) return null
        return try {
            val track = SubjectTracks.parse(file.readBytes())
            val meta = track.meta ?: throw SubjectTrackException("its subjects cannot be read")
            file.setLastModified(System.currentTimeMillis())
            resultOf(file, track.width, track.height, track.frameCount, meta, cached = true)
        } catch (e: Exception) {
            // Half written by a run that was killed, or otherwise unreadable: made again.
            Log.w(TAG, "discarding unreadable track ${file.name}: ${e.message}")
            file.delete()
            null
        }
    }

    private fun resultOf(file: File, width: Int, height: Int, frames: Int, meta: SubjectTrackMeta, cached: Boolean): Result =
        Result(
            uri = Uri.fromFile(file).toString(),
            cached = cached,
            kind = meta.kind,
            width = width,
            height = height,
            frames = frames,
            durationMs = meta.durationMs,
            engine = meta.engine,
            subjects = meta.subjects,
        )

    /**
     * The track a render draws [uri]'s focus from, read whole and every frame decoded once, so one
     * that cannot be read fails the render before it starts, naming its clip, rather than half way
     * through it. Throws for a file that will not open, is not a subject track, is too large, or has a
     * frame that does not decode.
     */
    fun trackForRender(ctx: Context, uri: String): SubjectTrack {
        val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val bytes = (ctx.contentResolver.openInputStream(parsed) ?: throw IOException("could not open $uri")).use { readAtMost(it, MAX_TRACK_BYTES) }
        val track = SubjectTracks.parse(bytes)
        track.checkFrames()
        // Used, so the cache trim keeps it: a render reads it now, and its retry and the draft later.
        if (parsed.scheme == "file") parsed.path?.let(::File)?.takeIf { it.parentFile?.name == FOLDER }?.setLastModified(System.currentTimeMillis())
        return track
    }

    /** Every byte of [input], refusing one past [limit]. */
    private fun readAtMost(input: InputStream, limit: Int): ByteArray {
        val out = java.io.ByteArrayOutputStream()
        val chunk = ByteArray(64 * 1024)
        while (true) {
            val read = input.read(chunk)
            if (read < 0) return out.toByteArray()
            if (out.size() + read > limit) throw SubjectTrackException("subject track is larger than ${limit / (1024 * 1024)} MB")
            out.write(chunk, 0, read)
        }
    }

    /**
     * Deletes tracks, oldest first, until the folder fits [MAX_CACHE_BYTES] - never `keep`, the one just
     * made, and never one used within [IN_USE_MS] - and every half-written one left by a run that was
     * killed.
     */
    private fun trim(folder: File, keep: File?) {
        val now = System.currentTimeMillis()
        val files = folder.listFiles()?.filter { it.isFile } ?: return
        for (file in files) {
            if (file.name.endsWith(".part") && now - file.lastModified() > ORPHAN_PART_MS) file.delete()
        }
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

    /**
     * A file name for `uri`'s track: the file's identity - where it is, how big it is and when it was
     * last written, so an edited file is looked at again - and how it was looked at.
     */
    private fun cacheName(ctx: Context, uri: String, kind: MediaLabels.Kind, fps: Int): String {
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
        val digest = MessageDigest.getInstance("SHA-1")
            .digest("$VERSION|$uri|$size|$modified|${kind.wire}|$fps|$ENGINE".toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    /**
     * Which `subjectsProgress` events go out: the first, then one every [intervalMs] at most - about
     * four a second - and the last, 1, always and once. Asked from Media3's GL thread while frames are
     * looked at and from the search's own thread at the end, one after the other.
     */
    internal class ProgressThrottle(private val intervalMs: Long = PROGRESS_INTERVAL_MS) {
        private var lastMs = 0L
        private var sent = false
        private var finished = false

        @Synchronized
        fun offer(progress: Double, nowMs: Long): Boolean {
            if (finished) return false
            if (progress >= 1.0) {
                finished = true
                return true
            }
            if (sent && nowMs - lastMs < intervalMs) return false
            sent = true
            lastMs = nowMs
            return true
        }
    }
}
