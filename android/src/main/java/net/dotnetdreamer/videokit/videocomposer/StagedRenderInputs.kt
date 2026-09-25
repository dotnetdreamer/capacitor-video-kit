package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.util.Base64
import android.util.Log
import java.io.File
import java.io.FileOutputStream
import java.io.IOException
import java.net.URI
import java.net.URISyntaxException
import java.util.UUID

/**
 * Files a render reads an input from when the page holds that input only as bytes: the Android half
 * of `stageRenderInput` and `releaseRenderInputs`.
 *
 * WHY THIS EXISTS AT ALL. A sound the page made or read in - the browser sound library's WAV, a
 * track picked through a file input - lives behind a `blob:` URL, which names memory inside the
 * WebView and nothing Media3 can open. The render needs a file, so the page writes one through
 * here: `withNativeRenderInputs` reads each blob and sends its bytes over as base64, a megabyte at a
 * time, the first chunk making a new file and every later one appended to it, and releases the files
 * once the render has finished, failed or been cancelled. A megabyte at a time because the bridge
 * carries a call as one string: a three minute WAV sent whole is thirty megabytes held several
 * times over - the blob, its base64, the bridge's copy, the decoded bytes - on a phone that is about
 * to start an encoder.
 *
 * The folder is the kit's own, `cacheDir/videokit-render-inputs`, and both calls act only inside it.
 * Each takes a name from the page and does something to the file it names, and without that rule a
 * page could append to any file the app can write - a draft store, the customer's sound library - or
 * delete one. So an append must name a file directly in the folder, which only this makes, and a
 * release passes over every name that is not one. The check is made on canonical paths, so neither
 * a `..` nor a link gets out.
 *
 * Nothing but the page's release normally deletes a file here. A render whose app was killed before
 * the page could release its inputs leaves them behind, and [JobFolders.sweep] clears anything here
 * older than a day when the plugin next loads. Not sooner, because the plugin loads again with every
 * new Bridge - an Activity made again while [RenderService] keeps the process, and a render in it,
 * going - and that render may still be reading what the page staged. A day is long past any render,
 * and soon enough that a leftover never matters.
 *
 * iOS does the same in `tmp/videokit-render-inputs`, with one more reason to name a new file with
 * the extension the page gives: AVFoundation picks its reader by a file's extension, and the iOS
 * `RenderInputs` has to sniff the bytes of a file named wrongly. Media3 reads the bytes and needs
 * none, so here the extension is only the file saying what it holds, and the same call means the
 * same thing on both.
 */
object StagedRenderInputs {

    private const val TAG = "VideoComposer"

    fun folder(ctx: Context): File = File(ctx.cacheDir, "videokit-render-inputs")

    /**
     * A call the page got wrong - a name outside the folder, data that is not base64, an extension
     * that is not one - which the plugin answers `invalid_spec`. Its own type so that a disk that
     * refused a write, which is not the page's mistake, cannot be answered the same way.
     */
    class Refused(message: String) : IllegalArgumentException(message)

    /**
     * Writes one chunk and answers the file it went into, named as the folder names it. See the
     * internal [stage] for the rules.
     */
    fun stage(ctx: Context, data: String, uri: String?, extension: String?): File =
        stage(folder(ctx), data, uri, extension) { Base64.decode(it, Base64.DEFAULT) }

    /**
     * Without [uri] the chunk starts a new file, `<uuid>` plus [extension] after a dot when there is
     * one; with it, the chunk is appended to the file [uri] names, which must be one this made and
     * still there. An append to nothing is refused rather than begun again, because a file that
     * lost its head opens as a broken sound, and the page would rather be told than render one.
     *
     * [extension] is checked on every chunk and used only on the first, as the contract's
     * `StageRenderInputOptions.extension` says and as iOS's `stage` does it: the name is settled
     * once the file exists, but a caller that sends `../x` with its fifth chunk has the same bug as
     * one that sends it with its first, and is told so on either engine. It is checked before
     * anything else, the file [uri] names included, so a call wrong in two ways is refused for the
     * same one on both.
     *
     * Every chunk is decoded on its own. The page encodes each one on its own - `btoa` in
     * `withNativeRenderInputs` - so every chunk carries its own padding, and the chunks cannot be
     * joined as text and decoded once, but their bytes join as they are.
     *
     * [data] is checked here, before [decode] sees it, because the framework's decoder is lenient:
     * `android.util.Base64` passes over every character outside the alphabet and takes a last group
     * without its padding, so `AAAA!`, a chunk broken into lines, or one still behind its `data:`
     * prefix would be written as whatever the rest decodes to. iOS's `Data(base64Encoded:)` refuses
     * all of those, and the same call is refused on both.
     *
     * The decoder is an argument so the whole of it can be pinned without a device: the framework's
     * `android.util.Base64` is a stub on the JVM, and `java.util.Base64` is not there below API 26.
     * Because the check is made here rather than by the decoder, the strict one a test passes in
     * cannot hide a chunk the lenient one on a phone would let through. iOS's counterpart is
     * `StagedRenderInputs.stage` in StagedRenderInputs.swift.
     */
    internal fun stage(
        folder: File,
        data: String,
        uri: String?,
        extension: String?,
        decode: (String) -> ByteArray,
    ): File {
        val suffix = extension(extension)?.let { ".$it" }.orEmpty()
        val target = if (uri == null) {
            File(folder, "${UUID.randomUUID()}$suffix")
        } else {
            staged(folder, uri)?.takeIf { it.isFile }
                ?: throw Refused("$uri is not a render input staged here")
        }
        if (!isBase64(data)) throw Refused("data is not base64")
        val bytes = decode(data)
        if (uri == null && !folder.isDirectory && !folder.mkdirs()) {
            throw IOException("could not create ${folder.path}")
        }
        try {
            FileOutputStream(target, uri != null).use { it.write(bytes) }
        } catch (e: IOException) {
            /* A new file the write failed on is deleted here, because the page never learned its
               name and so can never release it. An append that failed leaves its file, whose name
               the page holds and releases like any other. */
            if (uri == null) target.delete()
            throw e
        }
        return target
    }

    /**
     * Deletes every file [uris] names in the folder, and passes over every other name. Never
     * throws. iOS's counterpart is `StagedRenderInputs.release`.
     */
    fun release(ctx: Context, uris: List<String>) = release(folder(ctx), uris)

    internal fun release(folder: File, uris: List<String>) {
        for (uri in uris) {
            val file = staged(folder, uri)?.takeIf { it.isFile } ?: continue
            /* A file that will not go is the sweep's on the next launch; the render it fed is over
               either way, so the page is not told. */
            if (!file.delete()) Log.w(TAG, "could not release render input ${file.path}")
        }
    }

    /**
     * The file [uri] names when it sits directly in [folder], spelled as a new one's name is, or
     * null for any other name: a file elsewhere, the folder itself, a URI of another scheme. Whether
     * the file exists is the caller's question.
     *
     * A `file://` URI and a bare path are both read, as every other reader in the plugin reads them.
     * Both sides are made canonical before they are compared, which settles a `..` and a link, and
     * what comes back is built from [folder] rather than from [uri], so a name the page sends in some
     * other spelling of the same file is answered in the one the page was first given. iOS's
     * `StagedRenderInputs.staged` answers the same names the same way.
     */
    internal fun staged(folder: File, uri: String): File? {
        val path = when {
            uri.startsWith("/") -> uri
            uri.startsWith("file:") -> try {
                URI(uri).path
            } catch (e: URISyntaxException) {
                null
            }
            else -> null
        } ?: return null
        return try {
            val file = File(path).canonicalFile
            if (file.parentFile?.path != folder.canonicalPath) return null
            File(folder, file.name)
        } catch (e: IOException) {
            /* A path the filesystem cannot resolve is not one this made. */
            null
        }
    }

    /**
     * The extension a new file is named with, without its dot, or null for none.
     *
     * The contract asks for it without the dot, and a leading one is taken off all the same, because
     * `.wav` is how an extension is often written and plainly means the same file. What is left must
     * be letters and digits, and anything else is refused rather than cleaned: it becomes part of a
     * path, and a caller that sends `../x` has a bug worth hearing about. Empty, as absent, is none.
     * The same rule as iOS's `StagedRenderInputs.extensionName`, so an extension is refused on both
     * or neither.
     */
    internal fun extension(raw: String?): String? {
        val bare = raw?.removePrefix(".")?.takeIf { it.isNotEmpty() } ?: return null
        if (!EXTENSION.matches(bare)) throw Refused("$raw is not an extension")
        return bare
    }

    private val EXTENSION = Regex("[A-Za-z0-9]{1,16}")

    /**
     * Whether [text] is base64 as `btoa` writes it and `Data(base64Encoded:)` reads it: nothing but
     * the alphabet, then at most two `=`, in a length that is a multiple of four. Empty is the
     * base64 of no bytes, which `withNativeRenderInputs` never sends but which is not wrong. See
     * [stage] for why the decoder is not left to say so.
     */
    private fun isBase64(text: String): Boolean {
        if (text.length % 4 != 0) return false
        val body = text.trimEnd('=')
        return text.length - body.length <= 2 &&
            body.all { it in 'A'..'Z' || it in 'a'..'z' || it in '0'..'9' || it == '+' || it == '/' }
    }
}
