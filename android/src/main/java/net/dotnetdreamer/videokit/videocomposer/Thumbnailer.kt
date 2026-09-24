package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.os.Build
import android.provider.OpenableColumns
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * Everything that needs to look inside a media file without rendering it: durations, track
 * presence, filmstrip frames and the poster cut from a finished render.
 *
 * `MediaMetadataRetriever` opens a decoder, and decoders are a scarce, device-limited resource that
 * the preview and the feed are also competing for. So every batch shares ONE retriever, batches for
 * the same source are serialised, and frames are cached on disk - a filmstrip is asked for again
 * every time the editor reopens.
 */
object Thumbnailer {

    private const val TAG = "VideoComposer"
    private const val JPEG_QUALITY_THUMB = 80
    private const val JPEG_QUALITY_POSTER = 85

    /** One lock per source, so two filmstrip requests for one file do not open two decoders. */
    private val locks = HashMap<String, Any>()

    private fun lockFor(key: String): Any = synchronized(locks) { locks.getOrPut(key) { Any() } }

    /* ---------------------------------------------------------------------------------------- */

    fun probe(ctx: Context, uri: String): ProbeInfo {
        val retriever = MediaMetadataRetriever()
        try {
            retriever.open(ctx, uri)
            val durationMs = retriever.long(MediaMetadataRetriever.METADATA_KEY_DURATION)
            val rotation = retriever.int(MediaMetadataRetriever.METADATA_KEY_VIDEO_ROTATION)
            val rawWidth = retriever.int(MediaMetadataRetriever.METADATA_KEY_VIDEO_WIDTH)
            val rawHeight = retriever.int(MediaMetadataRetriever.METADATA_KEY_VIDEO_HEIGHT)
            // Report what a player would show, not what the encoder wrote.
            val swap = rotation == 90 || rotation == 270
            return ProbeInfo(
                durationMs = durationMs,
                width = if (swap) rawHeight else rawWidth,
                height = if (swap) rawWidth else rawHeight,
                rotation = rotation,
                hasAudio = retriever.string(MediaMetadataRetriever.METADATA_KEY_HAS_AUDIO) == "yes",
                hasVideo = retriever.string(MediaMetadataRetriever.METADATA_KEY_HAS_VIDEO) == "yes",
            )
        } finally {
            retriever.closeQuietly()
        }
    }

    data class ProbeInfo(
        val durationMs: Long,
        val width: Int,
        val height: Int,
        val rotation: Int,
        val hasAudio: Boolean,
        val hasVideo: Boolean,
    ) {
        fun toProbedInput(): ProbedInput = ProbedInput(durationMs, hasAudio, hasVideo)
    }

    /* ---------------------------------------------------------------------------------------- */

    /**
     * One JPEG per requested time, in order. The contract promises the arrays line up, so a time
     * that yields no frame reuses a neighbour rather than shortening the result - a filmstrip with
     * a repeated tile reads as a still moment; one with a missing tile reads as a bug.
     *
     * @param precise cuts the frame at each time rather than the nearest keyframe; see [frameOption]
     *   for what that costs and why it is the caller's decision.
     */
    fun thumbnails(
        ctx: Context,
        uri: String,
        timesMs: List<Long>,
        maxHeight: Int,
        precise: Boolean = false,
    ): List<String> {
        if (timesMs.isEmpty()) return emptyList()
        val height = maxHeight.coerceIn(16, 1080)
        val cacheDir = JobFolders.thumbsCache(ctx).apply { mkdirs() }
        val sourceKey = cacheKey(ctx, uri)

        return synchronized(lockFor(uri)) {
            val files = timesMs.map { File(cacheDir, cacheName(sourceKey, it, height, precise)) }
            // The editor asks for the same times every time it opens, so a strip it has seen before
            // is usually on disk whole - and then opening the source would buy nothing: a
            // descriptor through the content resolver and a container parse in the media server,
            // per clip, on every reopen, for frames nobody reads. The same files come back in the
            // same order the loop below would have handed them. The check is inside the lock
            // because [writeJpeg] writes straight to the final name, and the lock is what keeps a
            // reader from taking a tile that is still being written.
            if (allCached(files)) return@synchronized files.map { Uri.fromFile(it).toString() }
            val retriever = MediaMetadataRetriever()
            val out = ArrayList<String?>(timesMs.size)
            try {
                retriever.open(ctx, uri)
                for ((i, timeMs) in timesMs.withIndex()) {
                    val file = files[i]
                    if (cached(file)) {
                        out += Uri.fromFile(file).toString()
                        continue
                    }
                    val frame = frameAt(retriever, timeMs, height, precise)
                    if (frame == null) {
                        out += null
                        continue
                    }
                    out += try {
                        writeJpeg(frame, file, JPEG_QUALITY_THUMB)
                        Uri.fromFile(file).toString()
                    } catch (e: Exception) {
                        Log.w(TAG, "could not write thumbnail: ${e.message}")
                        null
                    } finally {
                        frame.recycle()
                    }
                }
            } catch (e: Exception) {
                Log.w(TAG, "thumbnails failed for $uri: ${e.message}")
            } finally {
                retriever.closeQuietly()
            }
            // The contract promises one URI per requested time, in order. If opening the source
            // threw part-way through, the tail is still owed - as placeholders rather than a short
            // array, because a caller lining these up against times would silently mis-align.
            while (out.size < timesMs.size) out += null
            fillGaps(out, cacheDir)
        }
    }

    private fun frameAt(
        retriever: MediaMetadataRetriever,
        timeMs: Long,
        maxHeight: Int,
        precise: Boolean,
    ): Bitmap? {
        val timeUs = timeMs * 1000L
        return try {
            val frame = grab(retriever, timeUs, maxHeight, frameOption(precise))
            // A precise seek is the one that can come back with nothing - past the last frame, or
            // where the container's index is not good enough to decode forward from. The keyframe
            // it would have landed on is a better answer than a gap the caller has to paper over.
            if (frame == null && precise) grab(retriever, timeUs, maxHeight, frameOption(false)) else frame
        } catch (e: Exception) {
            Log.w(TAG, "no frame at ${timeMs}ms: ${e.message}")
            null
        }
    }

    private fun grab(
        retriever: MediaMetadataRetriever,
        timeUs: Long,
        maxHeight: Int,
        option: Int,
    ): Bitmap? =
        if (Build.VERSION.SDK_INT >= 27) {
            // Scales during decode, so a 4K source never materialises a full-size bitmap.
            retriever.getScaledFrameAtTime(timeUs, option, maxHeight * 2, maxHeight)
        } else {
            retriever.getFrameAtTime(timeUs, option)?.let { full ->
                val scale = maxHeight.toFloat() / full.height.toFloat()
                val scaled = Bitmap.createScaledBitmap(
                    full,
                    (full.width * scale).toInt().coerceAtLeast(1),
                    maxHeight,
                    true,
                )
                if (scaled !== full) full.recycle()
                scaled
            }
        }

    /** Whether every tile of a strip is already on disk; an empty file is a write that failed. */
    internal fun allCached(files: List<File>): Boolean = files.all(::cached)

    private fun cached(file: File): Boolean = file.exists() && file.length() > 0L

    /**
     * Which frame a seek settles on.
     *
     * CLOSEST_SYNC is a jump straight to a keyframe and costs one decode, but cameras write a
     * keyframe only every one or two seconds, so several nearby times all land on the same picture -
     * a filmstrip at one frame per second then shows each frame twice over. CLOSEST decodes every
     * frame from that keyframe up to the time asked for instead, so one seek costs as many decodes
     * as there are frames since the last keyframe: about thirty on a 30fps clip with a one-second
     * keyframe interval. Cutting a whole strip precisely therefore costs roughly one decode of the
     * clip, which is why it is the caller's choice and not the default.
     */
    internal fun frameOption(precise: Boolean): Int =
        if (precise) MediaMetadataRetriever.OPTION_CLOSEST else MediaMetadataRetriever.OPTION_CLOSEST_SYNC

    /**
     * Where one frame is cached. Precise frames are kept under their own name because they are a
     * different picture at the same time - a strip asked for precisely must not be served the
     * keyframes a previous request left behind, or the other way round - and the default name is
     * left exactly as it was, so the tiles already on disk are still found.
     */
    internal fun cacheName(sourceKey: String, timeMs: Long, maxHeight: Int, precise: Boolean): String =
        "$sourceKey-$timeMs-$maxHeight${if (precise) "-p" else ""}.jpg"

    /** Replaces nulls with the nearest neighbour, and falls back to a 1x1 black tile. */
    private fun fillGaps(uris: List<String?>, cacheDir: File): List<String> {
        if (uris.all { it != null }) return uris.filterNotNull()
        val filled = uris.toMutableList()
        for (i in filled.indices) {
            if (filled[i] != null) continue
            filled[i] = (i - 1 downTo 0).firstNotNullOfOrNull { filled[it] }
                ?: (i + 1 until filled.size).firstNotNullOfOrNull { filled[it] }
        }
        val placeholder by lazy { Uri.fromFile(blackTile(cacheDir)).toString() }
        return filled.map { it ?: placeholder }
    }

    private fun blackTile(cacheDir: File): File {
        val file = File(cacheDir, "placeholder.jpg")
        if (!file.exists() || file.length() == 0L) {
            val bitmap = Bitmap.createBitmap(2, 2, Bitmap.Config.ARGB_8888)
            bitmap.eraseColor(android.graphics.Color.BLACK)
            try {
                writeJpeg(bitmap, file, JPEG_QUALITY_THUMB)
            } catch (e: Exception) {
                Log.w(TAG, "could not write placeholder tile: ${e.message}")
            } finally {
                bitmap.recycle()
            }
        }
        return file
    }

    /* ---------------------------------------------------------------------------------------- */

    /**
     * The poster frame for a finished render. Uses CLOSEST rather than CLOSEST_SYNC because our own
     * output has one-second keyframes, and half a second off is a visibly different moment.
     */
    fun poster(ctx: Context, videoFile: File, atUs: Long, dest: File): Boolean {
        val retriever = MediaMetadataRetriever()
        return try {
            retriever.setDataSource(videoFile.absolutePath)
            val bitmap = retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST)
                ?: retriever.getFrameAtTime(atUs, MediaMetadataRetriever.OPTION_CLOSEST_SYNC)
                ?: return false
            try {
                writeJpeg(bitmap, dest, JPEG_QUALITY_POSTER)
                true
            } finally {
                bitmap.recycle()
            }
        } catch (e: Exception) {
            Log.w(TAG, "could not cut poster: ${e.message}")
            false
        } finally {
            retriever.closeQuietly()
        }
    }

    private fun writeJpeg(bitmap: Bitmap, dest: File, quality: Int) {
        dest.parentFile?.mkdirs()
        FileOutputStream(dest).use { out ->
            bitmap.compress(Bitmap.CompressFormat.JPEG, quality, out)
        }
    }

    /* ---------------------------------------------------------------------------------------- */

    /**
     * Identifies the exact bytes behind a URI so an edited or replaced file never serves stale
     * tiles. `content://` has no path to stat, so its size and modification time come from the
     * resolver instead.
     */
    private fun cacheKey(ctx: Context, uri: String): String {
        val parsed = Uri.parse(uri)
        val signature = when (parsed.scheme) {
            "content" -> {
                val (size, modified) = contentStat(ctx, parsed)
                "$uri|$size|$modified"
            }
            else -> {
                val file = parsed.path?.let { File(it) }
                "$uri|${file?.length() ?: 0L}|${file?.lastModified() ?: 0L}"
            }
        }
        val digest = MessageDigest.getInstance("SHA-1").digest(signature.toByteArray())
        return digest.joinToString("") { "%02x".format(it) }.take(24)
    }

    private fun contentStat(ctx: Context, uri: Uri): Pair<Long, Long> = try {
        ctx.contentResolver.query(
            uri,
            arrayOf(OpenableColumns.SIZE, "last_modified"),
            null,
            null,
            null,
        )?.use { cursor ->
            if (cursor.moveToFirst()) {
                val size = if (cursor.columnCount > 0 && !cursor.isNull(0)) cursor.getLong(0) else 0L
                val modified = if (cursor.columnCount > 1 && !cursor.isNull(1)) cursor.getLong(1) else 0L
                size to modified
            } else {
                0L to 0L
            }
        } ?: (0L to 0L)
    } catch (e: Exception) {
        // Plenty of providers do not expose last_modified; the URI itself still distinguishes files.
        0L to 0L
    }

    /* ---------------------------------------------------------------------------------------- */

    private fun MediaMetadataRetriever.open(ctx: Context, uri: String) {
        val parsed = Uri.parse(uri)
        when (parsed.scheme) {
            "content" -> setDataSource(ctx, parsed)
            "file" -> setDataSource(parsed.path ?: uri)
            null -> setDataSource(uri)
            else -> setDataSource(ctx, parsed)
        }
    }

    private fun MediaMetadataRetriever.closeQuietly() {
        try {
            if (Build.VERSION.SDK_INT >= 29) close() else release()
        } catch (e: Exception) {
            Log.w(TAG, "retriever close failed: ${e.message}")
        }
    }

    private fun MediaMetadataRetriever.long(key: Int): Long =
        extractMetadata(key)?.toLongOrNull() ?: 0L

    private fun MediaMetadataRetriever.int(key: Int): Int =
        extractMetadata(key)?.toIntOrNull() ?: 0

    private fun MediaMetadataRetriever.string(key: Int): String? = extractMetadata(key)
}
