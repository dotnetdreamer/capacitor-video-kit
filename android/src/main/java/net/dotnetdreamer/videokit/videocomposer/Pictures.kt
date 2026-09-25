package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.BitmapFactory
import android.net.Uri
import java.io.File
import java.io.IOException

/**
 * A picture on the timeline, asked the one question a render needs answered before it starts: is
 * this a picture this phone can decode, and of what type.
 *
 * [Thumbnailer.probe] cannot be asked: it opens a `MediaMetadataRetriever`, which reads a VIDEO
 * container and has nothing to say about a JPEG. What a picture has instead is a header, and
 * reading only that - `inJustDecodeBounds` - costs a few kilobytes of the file and allocates no
 * pixels, so a post of ten photos is checked in milliseconds.
 *
 * The type comes off the bytes rather than the name because the name may not have one: a picture
 * handed over as a blob that states no type is staged as a render input with no extension (see
 * [StagedRenderInputs]), and Media3 decides whether an item is an image by its MIME type. Asked of
 * the content resolver as a fallback, for a decoder that reads the size but names no type.
 */
object Pictures {

    data class Info(val width: Int, val height: Int, val mimeType: String)

    /** The picture's stored size and type. Throws [IOException] for a file that is not one. */
    fun probe(ctx: Context, uri: String): Info {
        val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val options = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        val stream = ctx.contentResolver.openInputStream(parsed) ?: throw IOException("could not open $uri")
        stream.use { BitmapFactory.decodeStream(it, null, options) }
        if (options.outWidth <= 0 || options.outHeight <= 0) {
            throw IOException("$uri is not a picture this phone can decode")
        }
        val mimeType = options.outMimeType
            ?: ctx.contentResolver.getType(parsed)?.takeIf { it.startsWith("image/") }
            ?: DEFAULT_MIME_TYPE
        return Info(options.outWidth, options.outHeight, mimeType)
    }

    /** What a picture is taken for when nothing will say: the type nearly every camera writes. */
    private const val DEFAULT_MIME_TYPE = "image/jpeg"
}
