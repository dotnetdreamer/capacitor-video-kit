package net.dotnetdreamer.videokit.videocomposer

import android.content.ContentResolver
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.provider.MediaStore
import java.io.File

/**
 * A picked file, kept openable in the launch AFTER the one that picked it: the Android half of
 * `retainMedia` and `checkMedia`.
 *
 * WHY THIS EXISTS AT ALL. The system photo picker does not hand over a file, it hands over a
 * content URI plus permission to read it, and that permission is scoped to the Activity that
 * asked. When the process dies the grant dies with it - the video is still sitting in the gallery,
 * untouched, but the host is no longer allowed to open it. A draft that stored only that URI
 * therefore came back to a clip it could not read, and could not tell that case apart from a video
 * the customer had actually deleted.
 *
 * Nothing is copied. A copy would put a second hundred megabytes of the same video in app storage,
 * and the customer's own library is where that file belongs. What is taken instead is a name that
 * outlives the process, by whichever of the two routes the device offers:
 *
 *  - A document URI can have its read grant made PERSISTABLE, which survives a reboot. That is what
 *    a picker which fell back to `ACTION_OPEN_DOCUMENT` returns, which is what androidx does on the
 *    devices with no system photo picker.
 *  - A photo-picker URI cannot - its grant is non-persistable by construction - but from Android 12
 *    it can be translated into the MediaStore URI behind it, which stays readable for as long as
 *    the host holds READ_MEDIA_VIDEO, and READ_MEDIA_IMAGES for a picture. `requestMediaAccess` is
 *    what asks for those, and the host declares them, for the reason [GalleryLibrary] gives.
 *
 * Both are attempted, best first, and the answer says which one it got. A URI that could not be
 * made durable is still handed back and still plays, so picking a clip never fails on account of
 * this - it only means a draft made from it will report that clip as missing on the next launch,
 * which is the truth rather than a blank screen.
 *
 * iOS is the opposite case and does the opposite thing. Its pickers hand over a file of the app's
 * own, copied into a folder the system empties by itself, so there the kit MOVES that file somewhere
 * that is kept. That is also why `releaseMedia` and `sweepMedia` delete nothing here: on Android the
 * kit holds no copy of anybody's media.
 *
 * What it does hold, after the first route, is a persisted grant, and those two leave it in place
 * too - a choice, not something with nothing to do. The system keeps only a bounded number of
 * persisted grants per app, a few hundred on a current phone, and past that silently drops the
 * oldest, so a draft old enough can lose its clip that way. They are not released because a grant
 * given back in error cannot be taken again without the customer picking the file again, while the
 * cap is reached only after hundreds of picks through the document route, which a device takes only
 * when it has no system photo picker at all.
 *
 * A name that is ALREADY durable - a MediaStore URI, the kit's own gallery ids among them, or a file
 * in the app's own storage - comes back `durable: false`, because neither route applies to it. That
 * is the answer to "did retaining make this last", not to "will this last", and such a name needs no
 * retaining.
 */
object RetainedMedia {

    /**
     * What [retain] answers. `durable` is the honest half of it: false means [uri] works now and
     * will not after a restart, which a draft store needs told rather than left to discover.
     */
    data class Retained(val uri: String, val durable: Boolean)

    /** The longest-lived name this device will give for a picked file. Never throws. */
    fun retain(ctx: Context, raw: String): Retained {
        val uri = Uri.parse(raw)
        return retain(
            raw,
            persist = { takePersistableRead(ctx, uri) },
            mediaStoreName = { mediaStoreUri(ctx, uri)?.toString() },
        )
    }

    /**
     * The two routes, best first, apart from the calls that walk them - so the order, and what comes
     * back when neither is open, can be pinned without a device. The MediaStore is not asked at all
     * once the grant was kept: the document URI is already the better name.
     */
    internal fun retain(raw: String, persist: () -> Boolean, mediaStoreName: () -> String?): Retained {
        if (persist()) return Retained(raw, durable = true)
        mediaStoreName()?.let { return Retained(it, durable = true) }
        /* Neither route was available. The URI goes back as it came, because it is still what plays
           for the rest of this session, and refusing it would break the pick today over a problem
           that only shows up tomorrow. */
        return Retained(raw, durable = false)
    }

    /**
     * Whether this URI still opens, which is the whole of what "is the clip still there" means.
     *
     * A descriptor is opened rather than MediaStore queried for a row, because the two can disagree:
     * a row outlives a file another app deleted, and a lapsed grant fails to open a file that is
     * very much still there. The editor's question is neither of those - it is "can I read these
     * bytes" - so that is the question asked. A bare path is read as the file it names, as every
     * other reader in the plugin reads one.
     */
    fun opens(ctx: Context, raw: String): Boolean {
        val uri = Uri.parse(raw).let { if (it.scheme == null) Uri.fromFile(File(raw)) else it }
        return try {
            ctx.contentResolver.openFileDescriptor(uri, "r")?.use { true } ?: false
        } catch (e: Exception) {
            /* Gone, revoked, or never readable - every way this fails is the same answer to the
               caller, and which of the three it was is not something a screen can act on. */
            false
        }
    }

    /** True when the system let the host keep reading this URI for good. */
    private fun takePersistableRead(ctx: Context, uri: Uri): Boolean = try {
        ctx.contentResolver.takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION)
        true
    } catch (e: Exception) {
        /* A SecurityException is the ordinary outcome for a photo-picker URI, whose grant is not
           persistable at all. Not a failure: it is the signal to try the MediaStore route instead.
           Anything else thrown here closes this route the same way, because a pick is never failed
           over a name that could not be kept - and this runs off the plugin thread, where an
           exception that escaped would end the app rather than the call. */
        false
    }

    /** The MediaStore URI behind a picker URI, or null when this device cannot say. */
    private fun mediaStoreUri(ctx: Context, uri: Uri): Uri? {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.S) return null
        if (uri.scheme != ContentResolver.SCHEME_CONTENT) return null
        return try {
            MediaStore.getMediaUri(ctx, uri)
        } catch (e: Exception) {
            /* Thrown for a URI that is not the picker's, and for one the host has no read access
               to. Both mean the same thing here: there is no durable name to be had. */
            null
        }
    }
}
