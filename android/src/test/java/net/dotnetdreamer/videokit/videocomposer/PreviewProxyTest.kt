package net.dotnetdreamer.videokit.videocomposer

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * Which frames the thumbnailer may cut from a clip's preview copy rather than from the clip.
 *
 * The copy is what makes a long filmstrip's exact frames affordable, so a tile must find it big
 * enough; but the same call cuts a template's freeze stills, as tall as the post, and a still cut
 * from a 540p copy would come out soft beside the footage around it. Both are invisible on the
 * surface until a customer looks closely, which is why they are pinned here.
 */
class PreviewProxyTest {

    @Test
    fun `a filmstrip tile is cut from the copy, whichever way up the clip is`() {
        assertTrue(PreviewProxy.bigEnough(width = 540, height = 960, maxHeight = 160))
        assertTrue(PreviewProxy.bigEnough(width = 960, height = 540, maxHeight = 160))
    }

    @Test
    fun `a still as tall as a post is cut from the clip`() {
        assertFalse(PreviewProxy.bigEnough(width = 540, height = 960, maxHeight = 1080))
        assertFalse(PreviewProxy.bigEnough(width = 960, height = 540, maxHeight = 1080))
    }

    @Test
    fun `a copy that exactly fills the box is big enough, and a pixel more is not`() {
        // The box is twice as wide as it is tall: a portrait frame fills its height, a very wide one
        // its width.
        assertTrue(PreviewProxy.bigEnough(width = 540, height = 960, maxHeight = 960))
        assertFalse(PreviewProxy.bigEnough(width = 540, height = 960, maxHeight = 961))
        assertTrue(PreviewProxy.bigEnough(width = 1920, height = 540, maxHeight = 960))
    }
}
