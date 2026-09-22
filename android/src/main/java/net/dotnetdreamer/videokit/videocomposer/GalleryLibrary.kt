package net.dotnetdreamer.videokit.videocomposer

import android.Manifest
import android.content.ContentUris
import android.content.Context
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import android.util.Size
import androidx.core.content.ContextCompat
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import java.io.File
import java.io.FileOutputStream
import java.io.IOException

/**
 * The device's own videos, READ, for a host that draws its own gallery - the other direction from
 * [Gallery], which only ever writes one.
 *
 * WHY A HOST WANTS THIS. The system photo picker is a separate Activity that answers with a set: the
 * order somebody tapped their clips in, which is the order they want them on a timeline, is gone by
 * the time it comes back. An app that numbers its picks the way every phone video editor does has
 * to list the library itself, and that means MediaStore.
 *
 * What goes out is a `content://` MediaStore URI per video, which is already everything the rest of
 * the plugin reads - `probe`, `thumbnails` and `compose` all open one - and which stays openable for
 * as long as the host holds the read grant. So [resolve] has nothing to copy on this platform; it
 * exists because iOS has no such URI, and a host should not have to know which platform it is on.
 *
 * NOTHING HERE IS DECLARED IN THE KIT'S MANIFEST. Reading the library needs READ_MEDIA_VIDEO, which
 * Google Play reviews app by app, and declaring it here would put it on every host whether it draws
 * a gallery or not. A host that calls these declares it; one that does not is asked by Capacitor to,
 * in the rejection, the first time it tries.
 */
object GalleryLibrary {

    data class Video(val id: String, val fileName: String, val durationMs: Long)

    data class Page(val videos: List<Video>, val total: Int)

    private const val JPEG_QUALITY = 80

    /*
     * Every thumbnail is a binder call into MediaProvider, which does the decoding in ITS process
     * and serves every other app on the phone from the same pool. A grid asks for a page of them at
     * once; three at a time keeps the first screen filling quickly without queueing sixty decodes
     * in front of the system gallery's own.
     */
    private val thumbnailPermits = Semaphore(3)

    /**
     * What the host is allowed to see: everything, the few videos the person chose (Android 14's
     * "Select photos and videos"), or nothing.
     *
     * `fullGranted` is the plugin's own permission state for READ_MEDIA_VIDEO, passed in because
     * the plugin is what owns the alias. The partial grant is read here directly, because it is a
     * permission a host may not declare at all - and an undeclared one simply reads as not granted.
     */
    fun access(ctx: Context, fullGranted: Boolean): String = when {
        fullGranted -> "granted"
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE &&
            ContextCompat.checkSelfPermission(ctx, Manifest.permission.READ_MEDIA_VISUAL_USER_SELECTED) ==
            PackageManager.PERMISSION_GRANTED -> "limited"
        else -> "denied"
    }

    /**
     * One page of the library, newest first, and how many videos it holds in all.
     *
     * Paged by walking a cursor rather than by a LIMIT clause, because how to ask MediaStore for a
     * LIMIT changed twice between API 24 and API 30 and a cursor move works on all of them. Three
     * columns, so opening the whole library costs milliseconds.
     */
    fun list(ctx: Context, offset: Int, limit: Int): Page {
        val collection = collection()
        val projection = arrayOf(
            MediaStore.Video.Media._ID,
            MediaStore.Video.Media.DISPLAY_NAME,
            MediaStore.Video.Media.DURATION,
        )
        // A file still being written - a recording in progress, a download halfway down - is listed
        // with IS_PENDING set and opens as a truncated video.
        val selection = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) "${MediaStore.MediaColumns.IS_PENDING} = 0" else null
        // The id breaks ties, so two videos added in the same second keep one order between pages.
        val order = "${MediaStore.MediaColumns.DATE_ADDED} DESC, ${MediaStore.Video.Media._ID} DESC"

        ctx.contentResolver.query(collection, projection, selection, null, order)?.use { cursor ->
            val total = cursor.count
            val idColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media._ID)
            val nameColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DISPLAY_NAME)
            val durationColumn = cursor.getColumnIndexOrThrow(MediaStore.Video.Media.DURATION)

            val videos = ArrayList<Video>(limit)
            if (cursor.moveToPosition(offset)) {
                do {
                    videos += Video(
                        id = ContentUris.withAppendedId(collection, cursor.getLong(idColumn)).toString(),
                        fileName = cursor.getString(nameColumn) ?: "",
                        // Null until the scanner has measured the file, which reads as 0: the host
                        // shows no length rather than a wrong one, and `probe` can always measure it.
                        durationMs = cursor.getLong(durationColumn),
                    )
                } while (videos.size < limit && cursor.moveToNext())
            }
            return Page(videos, total)
        }
        return Page(emptyList(), 0)
    }

    /**
     * A poster frame for one video, as a JPEG in the cache, cut by the system's own thumbnailer.
     *
     * MediaStore's thumbnail rather than [Thumbnailer]'s frame grab, on purpose: the system keeps
     * one for every video the gallery app has ever shown, so most of a grid comes back without a
     * decoder being opened at all - and a decoder is exactly what the editor's preview and filmstrip
     * are competing for. Kept on disk so the grid opened a second time reads files it already has.
     */
    suspend fun thumbnail(ctx: Context, id: String, maxSize: Int): File = thumbnailPermits.withPermit {
        val target = File(thumbnailFolder(ctx), thumbnailName(id, maxSize))
        if (target.exists()) return@withPermit target

        val bitmap = frame(ctx, Uri.parse(id), maxSize) ?: throw IOException("that video has no frame to show")
        // Under a temporary name first, so a second request for the same video - a grid tile and
        // the tray under it - can never read a file this one has not finished writing.
        val partial = File(target.path + ".${Thread.currentThread().id}.part")
        try {
            FileOutputStream(partial).use { bitmap.compress(Bitmap.CompressFormat.JPEG, JPEG_QUALITY, it) }
        } finally {
            bitmap.recycle()
        }
        if (!partial.renameTo(target)) {
            partial.delete()
            if (!target.exists()) throw IOException("the thumbnail could not be kept")
        }
        target
    }

    /**
     * What the rest of the plugin should be handed for this video, or null when it has gone from the
     * library since it was listed.
     *
     * The MediaStore URI itself: every reader in the plugin opens one, so there is nothing to copy.
     */
    fun resolve(ctx: Context, id: String): Video? {
        val projection = arrayOf(MediaStore.Video.Media.DISPLAY_NAME, MediaStore.Video.Media.DURATION)
        ctx.contentResolver.query(Uri.parse(id), projection, null, null, null)?.use { cursor ->
            if (!cursor.moveToFirst()) return null
            return Video(id = id, fileName = cursor.getString(0) ?: "", durationMs = cursor.getLong(1))
        }
        return null
    }

    /** One file per video and size, named after the URI itself so no index has to be kept. */
    internal fun thumbnailName(id: String, maxSize: Int): String =
        "${id.replace(Regex("[^A-Za-z0-9]"), "_")}-$maxSize.jpg"

    /** Every volume from Android 10 - an SD card included - and the primary one before it. */
    private fun collection(): Uri =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL)
        } else {
            MediaStore.Video.Media.EXTERNAL_CONTENT_URI
        }

    @Suppress("DEPRECATION")
    private fun frame(ctx: Context, uri: Uri, maxSize: Int): Bitmap? =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            ctx.contentResolver.loadThumbnail(uri, Size(maxSize, maxSize), null)
        } else {
            MediaStore.Video.Thumbnails.getThumbnail(
                ctx.contentResolver,
                ContentUris.parseId(uri),
                MediaStore.Video.Thumbnails.MINI_KIND,
                null,
            )
        }

    private fun thumbnailFolder(ctx: Context): File =
        File(ctx.cacheDir, "videokit-gallery-thumbnails").apply { mkdirs() }
}
