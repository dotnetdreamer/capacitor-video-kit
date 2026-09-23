package net.dotnetdreamer.videokit.videocomposer

import net.dotnetdreamer.videokit.videocomposer.RetainedMedia.Retained
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Test

/**
 * The order [RetainedMedia] walks its two routes in, and what comes back when neither is open.
 *
 * Both are worth pinning because getting them wrong is invisible until a restart. A draft that
 * stored the picker's own name plays today and opens nothing tomorrow; a pick refused because its
 * name would not last breaks today over a problem that only shows up tomorrow.
 */
class RetainedMediaTest {

    private val picked = "content://media/picker/0/com.android.providers.media.photopicker/media/1000000042"
    private val library = "content://media/external/video/media/42"

    @Test
    fun `a persistable grant keeps the name the pick came with`() {
        assertEquals(
            Retained(picked, durable = true),
            RetainedMedia.retain(picked, persist = { true }, mediaStoreName = { library }),
        )
    }

    @Test
    fun `the MediaStore is not asked once the grant was kept`() {
        var asked = false
        RetainedMedia.retain(picked, persist = { true }, mediaStoreName = { asked = true; library })
        assertFalse(asked)
    }

    @Test
    fun `a photo-picker pick comes back as the MediaStore name behind it`() {
        assertEquals(
            Retained(library, durable = true),
            RetainedMedia.retain(picked, persist = { false }, mediaStoreName = { library }),
        )
    }

    @Test
    fun `a pick neither route can keep goes back as it came, and says it will not last`() {
        assertEquals(
            Retained(picked, durable = false),
            RetainedMedia.retain(picked, persist = { false }, mediaStoreName = { null }),
        )
    }
}
