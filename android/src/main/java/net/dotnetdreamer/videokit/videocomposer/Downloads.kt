package net.dotnetdreamer.videokit.videocomposer

import android.content.ContentResolver
import android.content.ContentValues
import android.content.Context
import android.media.MediaScannerConnection
import android.net.Uri
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import androidx.annotation.RequiresApi
import java.io.File
import java.io.FileNotFoundException
import java.io.FileOutputStream
import java.io.IOException
import java.io.InputStream
import java.util.Locale

/**
 * A file put in the phone's Downloads, where a files app finds it and the app's own storage has no
 * say over it any more: `saveToDownloads`, for a file that is not a video - a sound out of the
 * library, say - where a video has [Gallery].
 *
 * The same two routes as [Gallery], for the same reasons. From API 29 a MediaStore insert into the
 * Downloads collection, which is scoped to that one directory and needs no permission, inserted
 * pending so that no other app sees half a file, and gone again if the copy fails. Below 29 there
 * is no such collection, so the file is written into the public Download directory, which the
 * plugin has asked for the storage permission to write, and handed to [MediaScannerConnection].
 *
 * Straight into Downloads with no folder of the app's own, because that is where a person looks for
 * something they just saved, and every files app opens on it.
 */
object Downloads {

    /** What a file is when its own name does not say. The Downloads collection takes any type. */
    private const val DEFAULT_MIME_TYPE = "application/octet-stream"

    /** What a file is called when neither the caller nor its source names it. */
    internal const val DEFAULT_NAME = "download"

    /** The copy's buffer, as large as [Gallery]'s for the same FUSE round trips from API 30. */
    private const val COPY_BUFFER_BYTES = 1 shl 20

    /** How many `name (n).ext` are tried below API 29 before the save gives up on a free name. */
    private const val MAX_NUMBERED = 999

    /**
     * Copies `uri` into Downloads and answers with where it went: the row it occupies from API 29,
     * the file below.
     *
     * Throws [UnreadableSource] for a source that will not open, which is checked before anything is
     * made in Downloads, and [IOException] for a copy that did not finish; the plugin turns those
     * into the codes `definitions.ts` promises.
     */
    fun save(context: Context, uri: String, fileName: String?): Uri {
        val source = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val name = Gallery.nameOf(fileName, source.lastPathSegment, DEFAULT_NAME)

        return openSource(context.contentResolver, source).use { input ->
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                insert(context, input, name)
            } else {
                writeToPublicDirectory(context, input, name)
            }
        }
    }

    /** The source would not open: the one failure that is `unreadable_input` rather than the save's. */
    class UnreadableSource(message: String, cause: Throwable? = null) : IOException(message, cause)

    /**
     * The source, opened before Downloads is touched, so a file that is not there never leaves a row
     * or an empty file behind it. A grant the app does not hold is a source it cannot read, the same
     * as a missing one.
     */
    private fun openSource(resolver: ContentResolver, source: Uri): InputStream {
        val input = try {
            resolver.openInputStream(source)
        } catch (e: FileNotFoundException) {
            throw UnreadableSource("there is nothing to read at $source", e)
        } catch (e: SecurityException) {
            throw UnreadableSource("this app may not read $source", e)
        }
        return input ?: throw UnreadableSource("there is nothing to read at $source")
    }

    /**
     * The collection's own copy. A name already in Downloads is MediaStore's to change, which it
     * does as Android always has, `holiday (1).wav`, rather than writing over the one before.
     */
    @RequiresApi(Build.VERSION_CODES.Q)
    private fun insert(context: Context, input: InputStream, name: String): Uri {
        val resolver = context.contentResolver
        val pending = ContentValues().apply {
            put(MediaStore.MediaColumns.DISPLAY_NAME, name)
            put(MediaStore.MediaColumns.MIME_TYPE, mimeTypeOf(name))
            put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
            put(MediaStore.MediaColumns.IS_PENDING, 1)
        }

        val item = resolver.insert(
            MediaStore.Downloads.getContentUri(MediaStore.VOLUME_EXTERNAL_PRIMARY),
            pending,
        ) ?: throw IOException("Downloads gave nowhere to put it")

        try {
            resolver.openOutputStream(item).use { output ->
                output ?: throw IOException("Downloads gave nothing to write to")
                input.copyTo(output, COPY_BUFFER_BYTES)
            }
        } catch (e: Throwable) {
            resolver.delete(item, null, null)
            throw e
        }

        resolver.update(item, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
        return item
    }

    /**
     * The same file on a phone with no Downloads collection, where Downloads is a directory on disk.
     * Under a name nothing there has yet ([freeFile]), as MediaStore names one from 29, so a second
     * save of the same sound never writes over the first; and deleted again when the copy fails, so
     * that nothing half written is left for a person to find.
     */
    private fun writeToPublicDirectory(context: Context, input: InputStream, name: String): Uri {
        @Suppress("DEPRECATION")
        val folder = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
        if (!folder.isDirectory && !folder.mkdirs()) throw IOException("could not make $folder")

        val file = freeFile(folder, name)
        try {
            FileOutputStream(file).use { output -> input.copyTo(output, COPY_BUFFER_BYTES) }
        } catch (e: Throwable) {
            file.delete()
            throw e
        }

        MediaScannerConnection.scanFile(context, arrayOf(file.absolutePath), arrayOf(mimeTypeOf(name)), null)
        return Uri.fromFile(file)
    }

    /**
     * `name` in `folder`, or the first of `name (1).ext`, `name (2).ext` and on that is not there
     * yet, numbered before the extension the way MediaStore numbers one.
     */
    internal fun freeFile(folder: File, name: String): File {
        val first = File(folder, name)
        if (!first.exists()) return first
        val dot = name.lastIndexOf('.')
        val base = if (dot > 0) name.substring(0, dot) else name
        val extension = if (dot > 0) name.substring(dot) else ""
        for (n in 1..MAX_NUMBERED) {
            val numbered = File(folder, "$base ($n)$extension")
            if (!numbered.exists()) return numbered
        }
        throw IOException("no free name for $name in $folder")
    }

    /** What the file is, read off the name it is being saved under, as [Gallery] reads a video's. */
    private fun mimeTypeOf(fileName: String): String {
        val extension = fileName.substringAfterLast('.', "")
        if (extension.isEmpty()) return DEFAULT_MIME_TYPE
        return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension.lowercase(Locale.ROOT))
            ?: DEFAULT_MIME_TYPE
    }
}
