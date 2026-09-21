package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.media.MediaExtractor
import android.media.MediaFormat
import android.media.MediaMuxer
import android.net.Uri
import android.provider.OpenableColumns
import android.util.Log
import org.json.JSONObject
import java.io.File
import java.io.IOException
import java.nio.ByteBuffer

/**
 * The customer's own sound library: audio lifted out of videos, kept until they delete it.
 *
 * The folder IS the library. One `.m4a` and one `.json` beside it per sound, both named after the
 * same id, so there is no index anywhere that can disagree with what is on the disk - which is
 * exactly what an index held in the WebView would eventually do, the first time storage was cleared
 * on one side and not the other.
 *
 * It lives in `filesDir` rather than the cache, and [JobFolders.sweep] does not touch it. A sound is
 * the only thing this plugin writes that is meant to outlive the post it was made for: it is the
 * customer's, not a job's, and the only thing that takes one away is [delete].
 *
 * The extraction is a REMUX. [MediaExtractor] hands over the compressed audio samples already in
 * the video's container and [MediaMuxer] writes them into an MP4 with nothing but that track in it,
 * so a three minute video costs a two megabyte copy and about as long as reading the file takes.
 * Nothing is decoded and nothing is re-encoded, which is also why the result is bit for bit the
 * sound that was in the video.
 */
object SoundLibrary {

    private const val TAG = "VideoComposer"

    /** Both ends of the copy, sized for one compressed audio frame with room to spare. */
    private const val BUFFER_BYTES = 1 shl 18

    /**
     * Refused past this. A muxer that runs out of disk half way through leaves a file that opens
     * and plays silence, so the space is demanded before the first byte rather than discovered.
     */
    private const val HEADROOM_BYTES = 8L * 1024 * 1024

    fun dir(ctx: Context): File = File(ctx.filesDir, "sounds")

    fun cacheDir(ctx: Context): File = File(ctx.cacheDir, "video-composer/sounds")

    /**
     * Whether this file is one of the library's own.
     *
     * Asked by [JobFolders.prepareJob], which MOVES app-owned inputs into the job folder - and a
     * library sound moved out of the library is a row that plays nothing from the next post onwards.
     * A sound is the customer's and outlives every job that uses it, so a job takes a copy.
     */
    fun owns(ctx: Context, file: File): Boolean {
        val libraryPath = try {
            dir(ctx).canonicalPath
        } catch (e: IOException) {
            dir(ctx).absolutePath
        }
        val path = try {
            file.canonicalPath
        } catch (e: IOException) {
            file.absolutePath
        }
        return path.startsWith(libraryPath + File.separator)
    }

    data class Sound(
        val id: String,
        val file: File,
        val fileName: String,
        val durationMs: Long,
        val savedAt: Long,
        val sourceName: String?,
    )

    /* ---------------------------------------------------------------------------------------- */

    /**
     * Writes the video's audio track out on its own.
     *
     * Returns null when the video HAS no audio track, which is a normal answer about a normal file
     * and not a failure - a caller that showed an error for it would be telling the customer their
     * video is broken. Anything that actually goes wrong throws.
     *
     * @param keep false writes into the cache instead, for a caller that wants the track for this
     *   edit only. Such a sound is not in the library and [list] never reports it.
     */
    @Throws(IOException::class)
    fun extract(ctx: Context, uri: String, fileName: String?, keep: Boolean): Sound? {
        val extractor = MediaExtractor()
        try {
            extractor.open(ctx, uri)
        } catch (e: Exception) {
            extractor.release()
            throw IOException("could not open $uri: ${e.message}", e)
        }

        try {
            val track = audioTrack(extractor) ?: return null
            val format = extractor.getTrackFormat(track)

            val folder = if (keep) dir(ctx) else cacheDir(ctx)
            if (!folder.exists() && !folder.mkdirs()) throw IOException("could not create ${folder.path}")
            val needed = sourceLength(ctx, uri).coerceAtLeast(0L) / 8 + HEADROOM_BYTES
            val available = JobFolders.availableBytes(folder)
            if (available < needed) throw IOException("no_space need=$needed free=$available")

            val id = newId()
            val target = File(folder, "$id.m4a")
            extractor.selectTrack(track)
            writeTrack(extractor, format, target)

            // Read back from the file rather than trusting the source's own duration: what was
            // written is one track of it, and a container whose video runs longer than its audio
            // would otherwise put a length on the sound that it does not have.
            val durationMs = trackDurationMs(format).takeIf { it > 0 }
                ?: runCatching { Thumbnailer.probe(ctx, Uri.fromFile(target).toString()).durationMs }.getOrDefault(0L)

            val sourceName = displayName(ctx, uri)
            val sound = Sound(
                id = id,
                file = target,
                fileName = fileName?.takeIf { it.isNotBlank() } ?: withoutExtension(sourceName) ?: "Sound",
                durationMs = durationMs,
                savedAt = System.currentTimeMillis(),
                sourceName = sourceName,
            )
            if (keep) writeRecord(folder, sound)
            return sound
        } finally {
            extractor.release()
        }
    }

    /** Every kept sound, newest first. A record whose audio file has gone is swept as it is read. */
    fun list(ctx: Context): List<Sound> {
        val folder = dir(ctx)
        val records = folder.listFiles { file -> file.isFile && file.name.endsWith(".json") } ?: return emptyList()
        val sounds = ArrayList<Sound>(records.size)
        for (record in records) {
            val sound = readRecord(folder, record)
            if (sound == null || !sound.file.exists()) {
                // Either unreadable or orphaned. Both are a row that would play nothing, and the
                // record is the only thing left to delete.
                if (!record.delete()) Log.w(TAG, "could not delete stale record ${record.path}")
                continue
            }
            sounds += sound
        }
        sounds.sortByDescending { it.savedAt }
        return sounds
    }

    /** Idempotent: an id that is already gone is not an error, because the caller wanted it gone. */
    fun delete(ctx: Context, id: String) {
        val folder = dir(ctx)
        val safe = JobFolders.safeSegment(id)
        for (file in listOf(File(folder, "$safe.m4a"), File(folder, "$safe.json"))) {
            if (file.exists() && !file.delete()) Log.w(TAG, "could not delete ${file.path}")
        }
    }

    /* ---------------------------------------------------------------------------------------- */

    /**
     * Copies one track's compressed samples into an MP4 of their own.
     *
     * The muxer is started before the first sample and stopped after the last, and a failure in
     * between takes the half-written file with it: a partial `.m4a` has no `moov` atom, so it is not
     * a shorter sound but a file nothing can open, and leaving one in the library would be a row
     * that never plays.
     */
    @Throws(IOException::class)
    private fun writeTrack(extractor: MediaExtractor, format: MediaFormat, target: File) {
        val muxer = MediaMuxer(target.path, MediaMuxer.OutputFormat.MUXER_OUTPUT_MPEG_4)
        val buffer = ByteBuffer.allocate(maxInputSize(format))
        val info = android.media.MediaCodec.BufferInfo()
        var started = false
        try {
            val out = muxer.addTrack(format)
            muxer.start()
            started = true
            while (true) {
                val read = extractor.readSampleData(buffer, 0)
                if (read < 0) break
                info.offset = 0
                info.size = read
                info.presentationTimeUs = extractor.sampleTime
                info.flags = extractor.sampleFlags
                muxer.writeSampleData(out, buffer, info)
                extractor.advance()
            }
            muxer.stop()
            started = false
        } catch (e: Exception) {
            if (!target.delete()) Log.w(TAG, "could not delete partial ${target.path}")
            throw IOException("could not write ${target.name}: ${e.message}", e)
        } finally {
            if (started) runCatching { muxer.stop() }
            runCatching { muxer.release() }
        }
    }

    private fun audioTrack(extractor: MediaExtractor): Int? {
        for (i in 0 until extractor.trackCount) {
            val mime = extractor.getTrackFormat(i).getString(MediaFormat.KEY_MIME).orEmpty()
            if (mime.startsWith("audio/")) return i
        }
        return null
    }

    /**
     * How big one sample can be. Not every extractor sets it - a stream without the key still has
     * frames - so a generous default stands in rather than a buffer that throws part way through.
     */
    private fun maxInputSize(format: MediaFormat): Int =
        if (format.containsKey(MediaFormat.KEY_MAX_INPUT_SIZE)) {
            format.getInteger(MediaFormat.KEY_MAX_INPUT_SIZE).coerceIn(1 shl 14, 1 shl 22)
        } else {
            BUFFER_BYTES
        }

    private fun trackDurationMs(format: MediaFormat): Long =
        if (format.containsKey(MediaFormat.KEY_DURATION)) format.getLong(MediaFormat.KEY_DURATION) / 1000 else 0L

    private fun MediaExtractor.open(ctx: Context, uri: String) {
        val parsed = Uri.parse(uri)
        when (parsed.scheme) {
            "content" -> setDataSource(ctx, parsed, null)
            "file" -> setDataSource(parsed.path ?: uri)
            null -> setDataSource(uri)
            else -> setDataSource(ctx, parsed, null)
        }
    }

    /* ---------------------------------------------------------------------------------------- */

    private fun writeRecord(folder: File, sound: Sound) {
        val json = JSONObject()
            .put("id", sound.id)
            .put("file", sound.file.name)
            .put("fileName", sound.fileName)
            .put("durationMs", sound.durationMs)
            .put("savedAt", sound.savedAt)
        if (sound.sourceName != null) json.put("sourceName", sound.sourceName)
        try {
            File(folder, "${sound.id}.json").writeText(json.toString())
        } catch (e: IOException) {
            // The audio is already written and is what the caller is about to play. A sound with no
            // record is one that will not be in the list next time, which is worth a line in the log
            // and is not worth failing an extraction that otherwise worked.
            Log.w(TAG, "could not write record for ${sound.id}: ${e.message}")
        }
    }

    private fun readRecord(folder: File, record: File): Sound? = try {
        val json = JSONObject(record.readText())
        val id = json.optString("id").takeIf { it.isNotEmpty() }
        val name = json.optString("file").takeIf { it.isNotEmpty() }
        if (id == null || name == null) {
            null
        } else {
            Sound(
                id = id,
                file = File(folder, name),
                fileName = json.optString("fileName", "Sound"),
                durationMs = json.optLong("durationMs", 0L),
                savedAt = json.optLong("savedAt", record.lastModified()),
                sourceName = json.optString("sourceName").takeIf { it.isNotEmpty() },
            )
        }
    } catch (e: Exception) {
        Log.w(TAG, "unreadable record ${record.path}: ${e.message}")
        null
    }

    /** What the file is called where the customer chose it, which is what the library should show. */
    private fun displayName(ctx: Context, uri: String): String? {
        val parsed = Uri.parse(uri)
        if (parsed.scheme == "content") {
            val name = try {
                ctx.contentResolver.query(parsed, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                    ?.use { cursor -> if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null }
            } catch (e: Exception) {
                null
            }
            if (name != null) return name
        }
        return parsed.lastPathSegment?.takeIf { it.isNotEmpty() }
    }

    private fun sourceLength(ctx: Context, uri: String): Long {
        val parsed = Uri.parse(uri)
        return when (parsed.scheme) {
            "content" -> try {
                ctx.contentResolver.query(parsed, arrayOf(OpenableColumns.SIZE), null, null, null)
                    ?.use { cursor -> if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else 0L } ?: 0L
            } catch (e: Exception) {
                0L
            }
            "file", null -> parsed.path?.let { File(it).length() } ?: 0L
            else -> 0L
        }
    }

    private fun withoutExtension(name: String?): String? {
        if (name.isNullOrBlank()) return null
        val dot = name.lastIndexOf('.')
        return (if (dot > 0) name.substring(0, dot) else name).takeIf { it.isNotBlank() }
    }

    private fun newId(): String = "snd-${System.currentTimeMillis().toString(36)}-${(0..0xFFFF).random().toString(16)}"
}
