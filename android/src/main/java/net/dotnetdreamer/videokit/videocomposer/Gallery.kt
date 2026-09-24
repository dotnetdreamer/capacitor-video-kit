package net.dotnetdreamer.videokit.videocomposer

import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.util.Locale

/**
 * A finished video, put where the phone's own gallery will show it.
 *
 * The two obvious ways to do this are both wrong, and both were in use before this existed:
 *
 * - Copying into `getExternalMediaDirs()` - `Android/media/<package>/` - puts the file in the app's
 *   OWN media storage. Android deletes that directory when the app is uninstalled, so every video
 *   a customer ever "saved to their gallery" goes with the app.
 * - Announcing the copy with an `ACTION_MEDIA_SCANNER_SCAN_FILE` broadcast. Deprecated at API 29
 *   and a no-op on the releases after it, so on a newer phone nothing is ever told the file exists.
 *
 * A MediaStore insert is neither: the row IS the announcement, the file belongs to the device
 * rather than to this app, and from API 29 it needs no permission because the insert is scoped to
 * the one directory it names. Below 29 there is no scoped insert, so the file is written into the
 * public directory and handed to the scanner through [MediaScannerConnection] - which, unlike the
 * broadcast, is still supported.
 */
object Gallery {

    /** What a video is when its own name does not say. Every render this package makes is one. */
    private const val DEFAULT_MIME_TYPE = "video/mp4"

    /** What a video is called when neither the caller nor its source names it. */
    private const val DEFAULT_NAME = "video.mp4"

    /**
     * Copies `uri` into the gallery and answers with the row it now occupies.
     *
     * Throws [IllegalArgumentException] for an option that cannot be honoured and [IOException] for
     * a copy that did not finish; the plugin turns those into the codes `definitions.ts` promises.
     */
    fun save(
        context: Context,
        uri: String,
        fileName: String?,
        album: String?,
        directory: String?,
    ): Uri {
        val source = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val name = nameOf(fileName, source.lastPathSegment)
        val folder = folderOf(directory)
        val subFolder = albumOf(album)

        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            insert(context, source, name, folder, subFolder)
        } else {
            writeToPublicDirectory(context, source, name, folder, subFolder)
        }
    }

    /**
     * The gallery's own copy, made by MediaStore rather than by this package.
     *
     * Inserted pending and cleared at the end, which is what keeps a gallery from showing a
     * half-copied video: while `IS_PENDING` is set the row is invisible to every other app. A copy
     * that fails takes its row with it for the same reason - a row with no bytes behind it is a
     * gallery entry that plays nothing.
     */
    private fun insert(context: Context, source: Uri, name: String, folder: String, album: String?): Uri {
        val resolver = context.contentResolver
        val pending = ContentValues().apply {
            put(MediaStore.Video.Media.DISPLAY_NAME, name)
            put(MediaStore.Video.Media.MIME_TYPE, mimeTypeOf(name))
            put(
                MediaStore.Video.Media.RELATIVE_PATH,
                if (album == null) folder else "$folder${File.separator}$album",
            )
            put(MediaStore.Video.Media.IS_PENDING, 1)
        }

        val item = resolver.insert(
            MediaStore.Video.Media.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            pending,
        ) ?: throw IOException("the gallery gave nowhere to put it")

        try {
            resolver.openInputStream(source).use { input ->
                input ?: throw IOException("there is nothing to read at $source")
                resolver.openOutputStream(item).use { output ->
                    output ?: throw IOException("the gallery gave nothing to write to")
                    input.copyTo(output, DEFAULT_BUFFER_SIZE)
                }
            }
        } catch (e: Throwable) {
            resolver.delete(item, null, null)
            throw e
        }

        resolver.update(item, ContentValues().apply { put(MediaStore.Video.Media.IS_PENDING, 0) }, null, null)
        return item
    }

    /** The same video on a phone with no scoped insert, where a gallery is a directory on disk. */
    private fun writeToPublicDirectory(
        context: Context,
        source: Uri,
        name: String,
        folder: String,
        album: String?,
    ): Uri {
        val root = Environment.getExternalStoragePublicDirectory(folder)
        val target = if (album == null) root else File(root, album)
        if (!target.isDirectory && !target.mkdirs()) throw IOException("could not make $target")

        val file = File(target, name)
        context.contentResolver.openInputStream(source).use { input ->
            input ?: throw IOException("there is nothing to read at $source")
            FileOutputStream(file).use { output -> input.copyTo(output, DEFAULT_BUFFER_SIZE) }
        }

        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf(mimeTypeOf(name)), null)
        return Uri.fromFile(file)
    }

    /**
     * The album, trimmed, or null for none; refused when it is not one folder name.
     *
     * A separator here would be a caller asking for a nested album, which iOS cannot express at
     * all - a photo library has albums and no folders under them. `.` and `..` are no folder of
     * their own either: below API 29 the album is a directory made on disk, and `..` would put the
     * video beside `Movies` rather than in it. Refused rather than flattened, so the same options
     * do the same thing on both platforms instead of quietly doing different ones; iOS's
     * `Gallery.album` refuses the same names in the same words.
     */
    internal fun albumOf(album: String?): String? {
        val name = album?.trim()?.takeIf { it.isNotEmpty() } ?: return null
        require(!name.contains('/') && !name.contains('\\') && name != "." && name != "..") {
            "album is one folder name, not a path: $name"
        }
        return name
    }

    /**
     * The name the video is saved under: [fileName], or else the source's own name, or else
     * `video.mp4`, trimmed, and made a NAME rather than a path.
     *
     * Below API 29 the video is written with `File(directory, name)`, so a name with a separator in
     * it - `a/../../x.mp4` - would put it outside `Movies` or `DCIM`, anywhere on shared storage.
     * From 29 on, MediaStore makes a valid file name of `DISPLAY_NAME` itself, a separator becoming
     * `_`, and files the row by `RELATIVE_PATH` alone. So a separator becomes `_` here, on every
     * release, and a name that is `.` or `..`, which names a folder rather than a file, is
     * `video.mp4` as a missing one is. Flattened rather than refused, unlike [albumOf]: a name is
     * what the gallery prints under the video, and a slash in a title is no reason to lose a save.
     */
    internal fun nameOf(fileName: String?, sourceName: String?): String {
        val name = (fileName?.takeIf { it.isNotBlank() } ?: sourceName ?: DEFAULT_NAME).trim()
            .replace('/', '_')
            .replace('\\', '_')
        return if (name.isEmpty() || name == "." || name == "..") DEFAULT_NAME else name
    }

    /**
     * `movies` and `dcim` and nothing else, because those are the two a gallery indexes and the
     * contract says so. An unknown value is the caller's mistake rather than a reason to guess.
     */
    private fun folderOf(directory: String?): String = when (directory?.lowercase(Locale.ROOT)) {
        null, "", "movies" -> Environment.DIRECTORY_MOVIES
        "dcim" -> Environment.DIRECTORY_DCIM
        else -> throw IllegalArgumentException("directory is movies or dcim, not: $directory")
    }

    /**
     * What the container is, read off the name the video is being saved under.
     *
     * MediaStore checks the extension against the type and renames the file when the two disagree,
     * so guessing `video/mp4` for a `.mov` would file somebody's clip as `holiday.mov.mp4`.
     */
    private fun mimeTypeOf(fileName: String): String {
        val extension = fileName.substringAfterLast('.', "")
        if (extension.isEmpty()) return DEFAULT_MIME_TYPE
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.lowercase(Locale.ROOT))
            ?: DEFAULT_MIME_TYPE
    }
}
