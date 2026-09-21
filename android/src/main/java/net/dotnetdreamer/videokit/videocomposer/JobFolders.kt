package net.dotnetdreamer.choisy.videocomposer

import android.content.Context
import android.net.Uri
import android.os.StatFs
import android.provider.OpenableColumns
import android.util.Log
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileInputStream
import java.io.FileOutputStream
import java.io.IOException

/**
 * Where a pending post's files live, and how they get there.
 *
 * The rule the whole feature rests on: once a post is pending, every byte it needs is inside one
 * app-private folder that nothing but `cleanup` deletes. Camera files can be deleted by the
 * recorder's own housekeeping, a `content://` grant from the file picker dies with the Activity
 * that got it, and the customer can clear their gallery - so inputs are moved in (when they are
 * ours) or copied in (when they are not) before anything depends on them.
 */
object JobFolders {

    private const val TAG = "VideoComposer"

    /** Headroom demanded on top of the estimated write, so a render cannot fill the disk. */
    const val FREE_SPACE_HEADROOM_BYTES = 32L * 1024 * 1024

    /** Cache entries older than this are swept on plugin load. */
    const val CACHE_TTL_MS = 24L * 60 * 60 * 1000

    /**
     * Job folders whose post finished this long ago are swept. Only folders carrying the marker
     * written when a post completes are eligible - a failed post parked behind a Retry button keeps
     * its files however old it is.
     */
    const val DONE_TTL_MS = 24L * 60 * 60 * 1000

    /**
     * A folder with no marker at all is swept after this long. The marker is written when a post is
     * created, so an unmarked folder is either a post still waiting behind a Retry button - kept for
     * a week, far longer than any retry anyone comes back to - or the leftovers of an editor render
     * whose app was killed before it could clean up after itself, which would otherwise sit on the
     * customer's phone for good.
     */
    const val ORPHAN_TTL_MS = 7L * 24 * 60 * 60 * 1000

    fun root(ctx: Context): File = File(ctx.filesDir, "pending-posts")

    fun dir(ctx: Context, pendingPostId: String): File = File(root(ctx), safeSegment(pendingPostId))

    fun inputs(ctx: Context, pendingPostId: String): File = File(dir(ctx, pendingPostId), "in")

    fun stitched(ctx: Context, pendingPostId: String): File = File(dir(ctx, pendingPostId), "stitched.mp4")

    fun poster(ctx: Context, pendingPostId: String): File = File(dir(ctx, pendingPostId), "poster.jpg")

    fun part(ctx: Context, pendingPostId: String, jobId: String): File =
        File(dir(ctx, pendingPostId), "render-${safeSegment(jobId)}.mp4.part")

    /** Written by the publisher when the post is created; the sweep's only licence to delete. */
    fun doneMarker(ctx: Context, pendingPostId: String): File = File(dir(ctx, pendingPostId), ".done")

    fun thumbsCache(ctx: Context): File = File(ctx.cacheDir, "video-composer/thumbs")

    fun voiceCache(ctx: Context): File = File(ctx.cacheDir, "video-composer/voice")

    /** Keys are echoed back to the caller, so a `vo:<id>` key must not become a path separator. */
    fun safeSegment(s: String): String = s.replace(Regex("[^A-Za-z0-9._-]"), "_")

    fun availableBytes(dir: File): Long = try {
        val probe = generateSequence(dir) { it.parentFile }.firstOrNull { it.exists() } ?: dir
        StatFs(probe.path).availableBytes
    } catch (e: IllegalArgumentException) {
        Log.w(TAG, "could not stat ${dir.path}: ${e.message}")
        Long.MAX_VALUE
    }

    /**
     * True when the file is somewhere this app owns and may therefore move rather than copy.
     * Anything else - the shared gallery, another app's folder - is copied, because deleting what
     * is not ours is not our call.
     */
    fun isAppOwned(ctx: Context, file: File): Boolean {
        val canonical = try {
            file.canonicalPath
        } catch (e: IOException) {
            file.absolutePath
        }
        val owned = listOfNotNull(
            ctx.filesDir,
            ctx.cacheDir,
            ctx.codeCacheDir,
            ctx.getExternalFilesDir(null),
            ctx.externalCacheDir,
        )
        return owned.any { dirCandidate ->
            val dirPath = try {
                dirCandidate.canonicalPath
            } catch (e: IOException) {
                dirCandidate.absolutePath
            }
            canonical == dirPath || canonical.startsWith(dirPath + File.separator)
        }
    }

    /* ---------------------------------------------------------------------------------------- */

    sealed class PrepareOutcome {
        data class Ok(val inputs: List<Pair<String, File>>, val jobDir: File) : PrepareOutcome()
        data class Failed(val code: String, val message: String) : PrepareOutcome()
    }

    /**
     * Relocates every input into the job folder. Idempotent: an input that is already there, or
     * whose source is gone but whose destination exists, is simply echoed back - which is what
     * makes a second `prepareJob` after a crash harmless.
     */
    fun prepareJob(
        ctx: Context,
        pendingPostId: String,
        inputs: List<Pair<String, String>>,
    ): PrepareOutcome {
        val jobDir = dir(ctx, pendingPostId)
        val inDir = inputs(ctx, pendingPostId)
        if (!inDir.exists() && !inDir.mkdirs()) {
            return PrepareOutcome.Failed("io", "could not create ${inDir.path}")
        }

        // Size the copies first so the disk check happens before anything is written.
        var neededBytes = 0L
        for ((_, uri) in inputs) {
            val parsed = Uri.parse(uri)
            neededBytes += when (parsed.scheme) {
                "file", null -> fileOf(parsed)?.takeIf { it.exists() }?.length() ?: 0L
                "content" -> contentLength(ctx, parsed)
                else -> 0L
            }
        }
        val available = availableBytes(root(ctx))
        if (available < neededBytes + FREE_SPACE_HEADROOM_BYTES) {
            return PrepareOutcome.Failed(
                "no_space",
                "no_space need=${neededBytes + FREE_SPACE_HEADROOM_BYTES} free=$available",
            )
        }

        val placed = ArrayList<Pair<String, File>>(inputs.size)
        for ((key, uri) in inputs) {
            val parsed = Uri.parse(uri)
            val result = when (parsed.scheme) {
                "file", null -> placeFile(ctx, inDir, key, parsed)
                "content" -> placeContent(ctx, inDir, key, parsed)
                else -> PrepareOutcome.Failed("unsupported_uri", "unsupported_uri:$key")
            }
            when (result) {
                is PrepareOutcome.Failed -> return result
                is PrepareOutcome.Ok -> placed += result.inputs
            }
        }
        return PrepareOutcome.Ok(placed, jobDir)
    }

    private fun placeFile(ctx: Context, inDir: File, key: String, uri: Uri): PrepareOutcome {
        val source = fileOf(uri) ?: return PrepareOutcome.Failed("unsupported_uri", "unsupported_uri:$key")
        val extension = source.name.substringAfterLast('.', defaultExtension(key))
        val dest = File(inDir, "${safeSegment(key)}.$extension")

        // Already where it belongs - including the case where a previous run moved it there.
        if (source.canonicalPathOrAbsolute() == dest.canonicalPathOrAbsolute()) {
            return PrepareOutcome.Ok(listOf(key to dest), inDir.parentFile ?: inDir)
        }
        if (!source.exists()) {
            return if (dest.exists()) {
                PrepareOutcome.Ok(listOf(key to dest), inDir.parentFile ?: inDir)
            } else {
                PrepareOutcome.Failed("file_missing", "file_missing:$key")
            }
        }

        return try {
            // A sound the customer keeps is app-owned and must still be COPIED: moving it would
            // take it out of their library the first time a post used it. See [SoundLibrary.owns].
            if (isAppOwned(ctx, source) && !SoundLibrary.owns(ctx, source)) {
                // A rename is free, but the recorder writes to external storage and filesDir is on
                // a different volume on every device, so the copy path is the normal one.
                if (!source.renameTo(dest)) {
                    copy(source, dest)
                    if (!source.delete()) Log.w(TAG, "could not delete moved input ${source.path}")
                }
            } else {
                copy(source, dest)
            }
            PrepareOutcome.Ok(listOf(key to dest), inDir.parentFile ?: inDir)
        } catch (e: IOException) {
            PrepareOutcome.Failed("io", "could not place $key: ${e.message}")
        }
    }

    private fun placeContent(ctx: Context, inDir: File, key: String, uri: Uri): PrepareOutcome {
        val extension = contentExtension(ctx, uri) ?: defaultExtension(key)
        val dest = File(inDir, "${safeSegment(key)}.$extension")
        return try {
            // The picker's read grant belongs to the Activity that asked for it, which is precisely
            // why the bytes are taken now rather than at render time.
            ctx.contentResolver.openInputStream(uri).use { input ->
                if (input == null) {
                    return if (dest.exists()) {
                        PrepareOutcome.Ok(listOf(key to dest), inDir.parentFile ?: inDir)
                    } else {
                        PrepareOutcome.Failed("file_missing", "file_missing:$key")
                    }
                }
                FileOutputStream(dest).use { output -> input.copyTo(output, DEFAULT_BUFFER_SIZE) }
            }
            PrepareOutcome.Ok(listOf(key to dest), inDir.parentFile ?: inDir)
        } catch (e: SecurityException) {
            if (dest.exists()) {
                PrepareOutcome.Ok(listOf(key to dest), inDir.parentFile ?: inDir)
            } else {
                PrepareOutcome.Failed("file_missing", "file_missing:$key (${e.message})")
            }
        } catch (e: IOException) {
            PrepareOutcome.Failed("io", "could not copy $key: ${e.message}")
        }
    }

    private fun copy(source: File, dest: File) {
        FileInputStream(source).use { input ->
            FileOutputStream(dest).use { output ->
                input.channel.use { from ->
                    output.channel.use { to ->
                        var position = 0L
                        val size = from.size()
                        while (position < size) {
                            val moved = from.transferTo(position, size - position, to)
                            if (moved <= 0L) break
                            position += moved
                        }
                    }
                }
            }
        }
    }

    private fun contentLength(ctx: Context, uri: Uri): Long = try {
        ctx.contentResolver.query(uri, arrayOf(OpenableColumns.SIZE), null, null, null)?.use { cursor ->
            if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getLong(0) else 0L
        } ?: 0L
    } catch (e: Exception) {
        Log.w(TAG, "could not size $uri: ${e.message}")
        0L
    }

    private fun contentExtension(ctx: Context, uri: Uri): String? {
        val displayName = try {
            ctx.contentResolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME), null, null, null)
                ?.use { cursor -> if (cursor.moveToFirst() && !cursor.isNull(0)) cursor.getString(0) else null }
        } catch (e: Exception) {
            null
        }
        val fromName = displayName?.substringAfterLast('.', "")?.takeIf { it.isNotEmpty() }
        if (fromName != null) return fromName
        val mime = try {
            ctx.contentResolver.getType(uri)
        } catch (e: Exception) {
            null
        }
        return mime?.let { MimeTypeMap.getSingleton().getExtensionFromMimeType(it) }
    }

    private fun defaultExtension(key: String): String = when {
        key.startsWith("vo:") || key == "music" -> "m4a"
        else -> "mp4"
    }

    private fun fileOf(uri: Uri): File? = when (uri.scheme) {
        "file" -> uri.path?.let { File(it) }
        null -> File(uri.toString())
        else -> null
    }

    private fun File.canonicalPathOrAbsolute(): String = try {
        canonicalPath
    } catch (e: IOException) {
        absolutePath
    }

    /* ---------------------------------------------------------------------------------------- */

    fun cleanup(ctx: Context, pendingPostId: String) {
        val dir = dir(ctx, pendingPostId)
        if (dir.exists() && !dir.deleteRecursively()) {
            Log.w(TAG, "could not fully delete ${dir.path}")
        }
    }

    /**
     * Housekeeping on plugin load. Deliberately conservative about job folders: only ones whose
     * post is finished are touched, because the alternative is deleting the files behind a post the
     * customer can still retry.
     */
    fun sweep(ctx: Context, now: Long) {
        root(ctx).listFiles()?.forEach { folder ->
            if (!folder.isDirectory) return@forEach
            if (isSweepable(folder, now)) {
                if (!folder.deleteRecursively()) Log.w(TAG, "sweep could not delete ${folder.path}")
            }
        }
        sweepCache(thumbsCache(ctx), now)
        sweepCache(voiceCache(ctx), now)
    }

    /**
     * A finished post's folder goes a day after it finished; an unmarked one only after a week, and
     * the age counts from the newest file in it, so a folder someone is still adding to is never
     * swept out from under them.
     */
    fun isSweepable(folder: File, now: Long): Boolean {
        val marker = File(folder, ".done")
        if (marker.exists()) return now - marker.lastModified() > DONE_TTL_MS
        return now - newestModified(folder) > ORPHAN_TTL_MS
    }

    private fun newestModified(file: File): Long {
        val children = file.listFiles()
        if (children.isNullOrEmpty()) return file.lastModified()
        return children.maxOf { child ->
            maxOf(child.lastModified(), if (child.isDirectory) newestModified(child) else 0L)
        }
    }

    private fun sweepCache(dir: File, now: Long) {
        dir.listFiles()?.forEach { file ->
            if (now - file.lastModified() > CACHE_TTL_MS && !file.deleteRecursively()) {
                Log.w(TAG, "sweep could not delete ${file.path}")
            }
        }
    }
}
