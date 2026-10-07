package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.OpenableColumns
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.Effect
import androidx.media3.common.MediaItem
import androidx.media3.common.MimeTypes
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.FrameDropEffect
import androidx.media3.effect.Presentation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.DefaultEncoderFactory
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import androidx.media3.transformer.ExportResult
import androidx.media3.transformer.Transformer
import androidx.media3.transformer.VideoEncoderSettings
import com.getcapacitor.JSObject
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import java.io.File
import java.io.IOException
import java.security.MessageDigest
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/**
 * A light copy of a clip for the live preview to play instead of the clip itself.
 *
 * The preview cuts a template's clips every half second or so, and every cut is an EXACT seek: the
 * WebView decodes every frame from the keyframe before the in-point up to it before it shows
 * anything. Phone footage is the worst case for that. Measured on a Galaxy A13 (Exynos 850,
 * 2026-09-28) with a 1080x1920 60 fps clip keyed every 3.6 s, the WebView's seeks took 2.6 to 7.0 s
 * each - it decodes a clip that size at about 30 frames a second - so a template played as a string
 * of multi-second freezes. The same clip at 540x960 keyed every half second seeked in 33 to 57 ms.
 *
 * So this makes that copy: the whole clip, on the SAME timeline (a frame at t in the clip is at t in
 * the copy, so the preview seeks the copy exactly where it would have seeked the clip), scaled so its
 * shorter side is [DEFAULT_SHORT_SIDE], keyed every [KEY_FRAME_INTERVAL_S], its sound carried over
 * as it is. It is only ever PLAYED - every render still reads the clip itself.
 *
 * Copies are kept in the app's cache folder under a name made from the clip's identity, so a clip
 * opened again - the editor after the template studio, a draft reopened - is ready at once. They are
 * made one at a time, in the order they were asked for, and never while a render runs: each holds a
 * hardware decoder and encoder, which the preview playing beside it needs, and which a render needs
 * more (see [yieldToRender]).
 */
@OptIn(UnstableApi::class)
object PreviewProxy {
    private const val TAG = "PreviewProxy"

    /** The shorter side of a copy. The preview's canvas is about this size on a phone. */
    const val DEFAULT_SHORT_SIDE = 540

    /** The most frames a second a copy keeps: slow motion still glides, and past this is waste. */
    const val DEFAULT_MAX_FPS = 60

    /** What makes a seek cheap: at most this much footage is decoded to reach any frame. */
    private const val KEY_FRAME_INTERVAL_S = 0.5f

    /** Bits per pixel per frame; plenty for a preview, which is watched at its own small size. */
    private const val BITS_PER_PIXEL = 0.1

    private const val MIN_BITRATE = 800_000
    private const val MAX_BITRATE = 4_000_000

    /**
     * The longest clip a copy is made of. A copy takes about as long as the clip on a phone like the
     * A13, holding a decoder the whole time, and a template or an edit uses seconds of a clip: past
     * this the clip simply plays itself, as it always did.
     */
    private const val MAX_SOURCE_MS = 5 * 60 * 1000L

    /** The folder is trimmed back under this, oldest first, after each copy made. */
    private const val MAX_CACHE_BYTES = 400L * 1024 * 1024

    /**
     * A copy asked for more recently than this is never trimmed: the preview may be playing it, and
     * the WebView reads it through Capacitor's local server a range at a time, so a file deleted under
     * it fails the next read. Every request for a copy - the studio's, the editor's - touches it.
     */
    private const val IN_USE_MS = 2 * 60 * 60 * 1000L

    /** A half-written copy older than this belongs to a run that was killed, and is deleted. */
    private const val ORPHAN_PART_MS = 30 * 60 * 1000L

    /** How often the queue looks again whether a render has finished. */
    private const val RENDER_POLL_MS = 500L

    /**
     * Bumped when a copy made by an older build should not be reused. 2: copies are coded upright
     * (see [run]); version 1's were coded on their side with a rotation flag.
     */
    private const val VERSION = 2

    private const val FOLDER = "preview-proxies"

    data class Result(val uri: String, val width: Int, val height: Int, val durationMs: Long, val cached: Boolean) {
        fun toJson(): JSObject = JSObject()
            .put("uri", uri)
            .put("width", width.toLong())
            .put("height", height.toLong())
            .put("durationMs", durationMs)
            .put("cached", cached)
    }

    class UnreadableException(message: String) : Exception(message)

    /** No copy is made of this clip - too long, or no room for it - and the clip plays itself. */
    class DeclinedException(message: String, val code: String) : Exception(message)

    /** The copy being made was stopped for a render; it is made again once the render is done. */
    private class YieldedException : Exception("stopped for a render")

    /** Nobody wants this copy any more ([dropAllBut]): it was never started, or it was stopped. */
    class DroppedException : Exception("the copy is no longer wanted")

    /** One copy at a time, in the order they were asked for. */
    private val queue = Mutex()

    /** A copy being made, by its file name, so a second request for the same clip joins the first. */
    private val inFlight = HashMap<String, CompletableDeferred<Result>>()

    /** The clip each copy in [inFlight] is made of, by the same name. Guarded by [inFlight]. */
    private val pending = HashMap<String, String>()

    /** Those of [pending] that [dropAllBut] dropped and nobody has asked for since. Guarded by [inFlight]. */
    private val dropped = HashSet<String>()

    /**
     * The copy each clip has had in this run of the app, by the uri [make] was given, as [make]
     * answered it: what [copyFor] hands the filmstrip. Guarded by itself.
     */
    private val made = HashMap<String, Result>()

    /** The export being made right now, so a render can stop it; see [yieldToRender]. */
    private class Running(val main: Handler, val name: String) {
        val done = CompletableDeferred<ExportResult>()

        @Volatile
        var transformer: Transformer? = null

        @Volatile
        var yielded = false
    }

    @Volatile
    private var running: Running? = null

    /**
     * A render is starting. A copy being made stops now and is made again once no render is running,
     * and no other copy starts until then.
     *
     * A copy and a render on the same hardware codecs slow each other down, and a phone keeps few of
     * them: a render whose decoder could not be opened because a preview copy held one would fail an
     * export for the sake of something nobody is waiting on. The copy loses only its progress.
     */
    fun yieldToRender() {
        val current = running ?: return
        current.yielded = true
        current.done.completeExceptionally(YieldedException())
        current.main.post { current.transformer?.cancel() }
    }

    /**
     * Drops every copy asked for and not made yet whose clip is not in `keep`, as the same strings
     * [make] was given: a page that has moved on to other clips, or left, stops paying for copies
     * nobody is going to play, and the copies it asks for next do not wait behind them. One waiting
     * its turn is never started; the one being made is stopped and its half-written file deleted.
     * Their requests fail with [DroppedException]. Copies already made stay in the cache, and a clip
     * asked for again before its turn came is made after all. Answers how many were dropped.
     */
    fun dropAllBut(keep: Set<String>): Int {
        val names = synchronized(inFlight) {
            pending.filterValues { it !in keep }.keys.toSet().also { dropped += it }
        }
        val current = running
        // Asked for again since the lock was let go, and so no longer dropped: leave it running.
        if (current != null && current.name in names && isDropped(current.name)) {
            current.done.completeExceptionally(DroppedException())
            current.main.post { current.transformer?.cancel() }
        }
        if (names.isNotEmpty()) Log.i(TAG, "dropped ${names.size} copies nobody wants any more, keeping ${keep.size} clips")
        return names.size
    }

    private fun isDropped(name: String): Boolean = synchronized(inFlight) { name in dropped }

    /**
     * The copy of `uri`, made if it is not in the cache already. Suspends until it exists; call off
     * the main thread. Throws [UnreadableException] for a clip that cannot be opened,
     * [DeclinedException] for one no copy is made of, [DroppedException] for one [dropAllBut] dropped
     * before it was made, and whatever Media3 threw for one it could not copy.
     */
    suspend fun make(ctx: Context, uri: String, shortSide: Int = DEFAULT_SHORT_SIDE, maxFps: Int = DEFAULT_MAX_FPS): Result {
        val app = ctx.applicationContext
        val side = shortSide.coerceIn(144, 1080)
        val fpsCap = maxFps.coerceIn(10, 120)
        val name = cacheName(app, uri, side, fpsCap)
        val folder = File(app.cacheDir, FOLDER).apply { mkdirs() }
        val file = File(folder, "$name.mp4")

        cached(file)?.let { return remember(uri, it) }

        val (deferred, owner) = synchronized(inFlight) {
            val running = inFlight[name]
            if (running != null) {
                // Wanted again, so a drop that has not reached it yet no longer applies.
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
                cached(file) ?: if (isDropped(name)) throw DroppedException() else makeBetweenRenders(app, uri, file, side, fpsCap, name)
            }
            deferred.complete(result)
            return remember(uri, result)
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

    private fun remember(uri: String, copy: Result): Result {
        synchronized(made) { made[uri] = copy }
        return copy
    }

    /**
     * The copy of `uri` [make] answered in this run of the app, when it is big enough to cut a frame
     * `maxHeight` tall from, or null.
     *
     * For the filmstrip's EXACT frames ([Thumbnailer.thumbnails]). The copy is the clip on the same
     * timeline, keyed every [KEY_FRAME_INTERVAL_S], so an exact frame of it decodes from a keyframe at
     * most half a second back, at a quarter of the pixels: about what a keyframe of the clip costs.
     * From the clip itself, keyed every few seconds, each one decodes seconds of full-size footage,
     * which is why a long strip was cut on keyframes - and a keyframe is the one NEAREST the time,
     * seconds from it either way. A frame the copy is too small for - a still for a post - is still
     * cut from the clip.
     */
    fun copyFor(uri: String, maxHeight: Int): File? {
        val copy = synchronized(made) { made[uri] } ?: return null
        if (!bigEnough(copy.width, copy.height, maxHeight)) return null
        val file = Uri.parse(copy.uri).path?.let(::File) ?: return null
        return if (file.isFile && file.length() > 0L) file else null
    }

    /**
     * Whether a copy `width` x `height`, as shown, fills the box a thumbnail `maxHeight` tall is fitted
     * into - [Thumbnailer]'s, twice as wide as it is tall - without being scaled up.
     */
    internal fun bigEnough(width: Int, height: Int, maxHeight: Int): Boolean =
        width >= maxHeight * 2 || height >= maxHeight

    /** [transcode], started only while no render runs, and started again if one stops it. */
    private suspend fun makeBetweenRenders(ctx: Context, uri: String, target: File, shortSide: Int, maxFps: Int, name: String): Result {
        while (true) {
            while (JobRegistry.active().isNotEmpty()) {
                if (isDropped(name)) throw DroppedException()
                delay(RENDER_POLL_MS)
            }
            if (isDropped(name)) throw DroppedException()
            try {
                return transcode(ctx, uri, target, shortSide, maxFps, name)
            } catch (e: YieldedException) {
                Log.i(TAG, "${target.name} stopped for a render; made again after it")
            }
        }
    }

    /** A copy already on disk, touched so the cache trim keeps it, or null. */
    private fun cached(file: File): Result? {
        if (!file.isFile || file.length() == 0L) return null
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(file.absolutePath)
            val rawWidth = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)?.toIntOrNull() ?: 0
            val rawHeight = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)?.toIntOrNull() ?: 0
            val rotation = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)?.toIntOrNull() ?: 0
            val turned = rotation == 90 || rotation == 270
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            if (rawWidth <= 0 || rawHeight <= 0) {
                file.delete()
                null
            } else {
                file.setLastModified(System.currentTimeMillis())
                // As shown, which is what the preview places it by.
                Result(Uri.fromFile(file).toString(), if (turned) rawHeight else rawWidth, if (turned) rawWidth else rawHeight, durationMs, cached = true)
            }
        } catch (e: Exception) {
            // Half written by a run that was killed, or otherwise unreadable: made again.
            Log.w(TAG, "discarding unreadable copy ${file.name}: ${e.message}")
            file.delete()
            null
        } finally {
            closeQuietly(retriever)
        }
    }

    private data class Source(val width: Int, val height: Int, val fps: Float, val durationMs: Long, val hasVideo: Boolean)

    private fun read(ctx: Context, uri: String): Source {
        val retriever = MediaMetadataRetriever()
        try {
            val parsed = Uri.parse(uri)
            when (parsed.scheme) {
                "content" -> retriever.setDataSource(ctx, parsed)
                "file" -> retriever.setDataSource(parsed.path ?: uri)
                null -> retriever.setDataSource(uri)
                else -> retriever.setDataSource(ctx, parsed)
            }
            fun int(key: Int) = retriever.extractMetadata(key)?.toIntOrNull() ?: 0
            val hasVideo = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes"
            val rotation = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
            val rawWidth = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
            val rawHeight = int(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
            val turned = rotation == 90 || rotation == 270
            val durationMs = retriever.extractMetadata(MediaMetadataRetriever.METADATA_KEY_DURATION)?.toLongOrNull() ?: 0L
            val frames = if (Build.VERSION.SDK_INT >= 28) int(MediaMetadataRetriever.METADATA_KEY_VIDEO_FRAME_COUNT) else 0
            val fps = if (frames > 0 && durationMs > 0) frames * 1000f / durationMs else 30f
            return Source(if (turned) rawHeight else rawWidth, if (turned) rawWidth else rawHeight, fps, durationMs, hasVideo)
        } catch (e: Exception) {
            throw UnreadableException(e.message ?: "the clip could not be opened")
        } finally {
            closeQuietly(retriever)
        }
    }

    private suspend fun transcode(ctx: Context, uri: String, target: File, shortSide: Int, maxFps: Int, name: String): Result {
        val source = read(ctx, uri)
        if (!source.hasVideo || source.width <= 0 || source.height <= 0) throw UnreadableException("the clip has no picture")
        if (source.durationMs > MAX_SOURCE_MS) {
            throw DeclinedException("a clip longer than ${MAX_SOURCE_MS / 60_000} minutes plays itself", FailureCodes.TOO_LARGE)
        }

        // Never scaled UP: a clip already smaller than the copy would be is copied at its own size,
        // which still buys the keyframes. Even sides, which every H.264 encoder wants.
        val sourceShort = min(source.width, source.height)
        val side = even(min(shortSide, sourceShort))
        val scale = side.toDouble() / sourceShort
        val width = even((source.width * scale).roundToInt())
        val height = even((source.height * scale).roundToInt())
        val fps = min(source.fps, maxFps.toFloat())
        val bitrate = (width.toDouble() * height * max(fps, 24f) * BITS_PER_PIXEL).toInt().coerceIn(MIN_BITRATE, MAX_BITRATE)

        // Room for the copy and as much again, so a render after it is not the one that runs out.
        val folder = target.parentFile!!
        trim(folder, keep = null)
        val expected = (bitrate + 256_000L) / 8 * max(1L, source.durationMs / 1000 + 1)
        if (folder.usableSpace < expected * 2) {
            throw DeclinedException("no room for a preview copy", FailureCodes.NO_SPACE)
        }

        val effects = ArrayList<Effect>()
        if (source.fps > maxFps + 1) effects += FrameDropEffect.createDefaultFrameDropEffect(maxFps.toFloat())
        effects += Presentation.createForWidthAndHeight(width, height, Presentation.LAYOUT_SCALE_TO_FIT)

        val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val item = EditedMediaItem.Builder(MediaItem.fromUri(parsed))
            .setEffects(Effects(emptyList(), effects))
            .build()
        val composition = Composition.Builder(EditedMediaItemSequence.Builder(item).build())
            // The export's own choice, so a HDR clip looks in the preview as it will in the post.
            .setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
            .build()

        val partial = File(folder, target.name + ".part")
        val started = System.nanoTime()
        try {
            run(ctx, composition, partial, bitrate, portrait = true, name = name)
        } catch (e: ExportException) {
            // Only an encoder that will not take the frame upright is asked again, on its side, as
            // Media3 codes it by default: slower for the preview to draw (see [run]), and still far
            // better than the clip. Any other failure would only fail the same way twice.
            if (!refusedByEncoder(e)) throw e
            Log.w(TAG, "upright encode refused (${e.errorCodeName}); coding ${target.name} on its side")
            run(ctx, composition, partial, bitrate, portrait = false, name = name)
        }
        if (!partial.renameTo(target)) {
            partial.delete()
            throw IOException("the copy could not be kept")
        }
        Log.i(TAG, "made ${target.name} ${width}x$height @${"%.0f".format(fps)} fps in ${(System.nanoTime() - started) / 1_000_000} ms")
        trim(folder, keep = target)
        return cached(target)?.copy(cached = false) ?: throw IOException("the copy could not be read back")
    }

    private fun refusedByEncoder(e: ExportException): Boolean =
        e.errorCode == ExportException.ERROR_CODE_ENCODER_INIT_FAILED ||
            e.errorCode == ExportException.ERROR_CODE_ENCODING_FORMAT_UNSUPPORTED ||
            e.errorCode == ExportException.ERROR_CODE_ENCODING_FAILED

    /**
     * One Media3 export of `composition` into `partial`, suspended until it has finished. On failure
     * the half-written file is deleted and the export's exception thrown; a render starting meanwhile
     * stops it with a [YieldedException] (see [yieldToRender]).
     *
     * `portrait` codes a tall frame upright. Media3 otherwise turns it on its side for the encoder and
     * writes a rotation flag, and Chromium draws a flagged video into WebGL by first copying every
     * frame into a new image of its own: measured on the A13 (2026-09-28), 171 of those a 5 s play,
     * 1.1 s of the GPU thread's time, against 20 and 0.1 s for the same copy coded upright - the
     * difference between the preview's frames keeping up and not.
     */
    private suspend fun run(ctx: Context, composition: Composition, partial: File, bitrate: Int, portrait: Boolean, name: String): ExportResult {
        partial.delete()
        val main = Handler(Looper.getMainLooper())
        val current = Running(main, name)
        running = current
        // Dropped between the check before this copy and here, where [dropAllBut] could not see it.
        if (isDropped(name)) current.done.completeExceptionally(DroppedException())
        // Transformer must be built, started and cancelled on one Looper thread; the export uses the
        // main one, and so does this.
        main.post {
            // Stopped for a render, or dropped, before it could start: nothing to start.
            if (current.yielded || current.done.isCompleted) return@post
            try {
                val settings = VideoEncoderSettings.Builder()
                    .setBitrate(bitrate)
                    .setiFrameIntervalSeconds(KEY_FRAME_INTERVAL_S)
                    .build()
                val encoders = DefaultEncoderFactory.Builder(ctx)
                    .setRequestedVideoEncoderSettings(settings)
                    .setEnableFallback(true)
                    .build()
                current.transformer = Transformer.Builder(ctx)
                    .setLooper(Looper.getMainLooper())
                    .setVideoMimeType(MimeTypes.VIDEO_H264)
                    .setEncoderFactory(encoders)
                    .setPortraitEncodingEnabled(portrait)
                    .addListener(object : Transformer.Listener {
                        override fun onCompleted(composition: Composition, exportResult: ExportResult) {
                            current.done.complete(exportResult)
                        }

                        override fun onError(composition: Composition, exportResult: ExportResult, exportException: ExportException) {
                            current.done.completeExceptionally(exportException)
                        }
                    })
                    .build()
                    .also { it.start(composition, partial.absolutePath) }
            } catch (e: Throwable) {
                current.done.completeExceptionally(e)
            }
        }
        try {
            return current.done.await()
        } catch (e: Throwable) {
            // Deleted again once cancel() has returned, which is once Media3 has let the file go: it
            // creates the file only as the first frame comes out, so one stopped just after it started
            // could otherwise write a half-copy after the delete here and leave it in the cache.
            main.post {
                current.transformer?.cancel()
                partial.delete()
            }
            partial.delete()
            throw e
        } finally {
            if (running === current) running = null
        }
    }

    /**
     * Deletes copies, oldest first, until the folder fits [MAX_CACHE_BYTES] - never `keep`, the one
     * just made, and never one asked for within [IN_USE_MS] - and every half-written copy left by a
     * run that was killed.
     */
    private fun trim(folder: File, keep: File?) {
        val now = System.currentTimeMillis()
        val files = folder.listFiles()?.filter { it.isFile } ?: return
        for (file in files) {
            // The copy being written now is younger than any run could be killed and restarted in.
            if (file.name.endsWith(".part") && now - file.lastModified() > ORPHAN_PART_MS) file.delete()
        }
        val copies = files.filter { it.exists() && it.name.endsWith(".mp4") }
        var total = copies.sumOf { it.length() }
        if (total <= MAX_CACHE_BYTES) return
        for (file in copies.sortedBy { it.lastModified() }) {
            if (total <= MAX_CACHE_BYTES) break
            if (file == keep || now - file.lastModified() < IN_USE_MS) continue
            total -= file.length()
            file.delete()
        }
    }

    /**
     * A file name for `uri`'s copy: the clip's identity - where it is, how big it is and when it was
     * last written, so an edited file is copied again - and how it is copied.
     */
    private fun cacheName(ctx: Context, uri: String, shortSide: Int, maxFps: Int): String {
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
            .digest("$VERSION|$uri|$size|$modified|$shortSide|$maxFps".toByteArray())
        return digest.joinToString("") { "%02x".format(it) }
    }

    private fun closeQuietly(retriever: MediaMetadataRetriever) {
        try {
            if (Build.VERSION.SDK_INT >= 29) retriever.close() else retriever.release()
        } catch (_: Exception) {
        }
    }

    private fun even(value: Int): Int = max(2, value - value % 2)
}
