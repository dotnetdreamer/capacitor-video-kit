package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.opengl.GLES20
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One layer [LayerUnderlayEffect] draws instead of Media3's overlays: the overlay the pre-flight decoded -
 * its bitmap, its window, the pose it rests at and its motion - with what sent it here, as
 * [RenderPlan.OverlayPlacement] decided it.
 */
class UnderlayLayer(
    val overlay: TimedBitmapOverlay,
    /** Its corners key by key, for a layer in perspective; null for a flat layer behind the people. */
    val quad: OverlayQuad?,
    /** Drawn before the matte, which puts the people back over it. */
    val behind: Boolean,
)

/**
 * The layers Media3's overlays cannot draw, drawn under the ones they can: every layer in perspective
 * (`ComposeOverlay.quad`) and every layer behind the people (`ComposeOverlay.behind`, under
 * `ComposeSpec.matte`). One pass over the finished video picture, after the canvas ([BackgroundEffect])
 * and before every `OverlayEffect`, drawing at output time t, in the order every engine draws them:
 *
 *  1. the picture as it arrives - the footage with its focus and looks, the camera, the canvas;
 *  2. each layer BEHIND, in the spec's order: through its quad where it has one, and otherwise exactly
 *     where Media3 would have put it ([TimedBitmapOverlay.poseAt], [LayerGeometry.poseCorners]);
 *  3. the picture AGAIN, its alpha the matte at t eased as a focus is, which puts the people back over
 *     what step 2 drew. Only on a frame where step 2 drew something: anywhere else it would lay the
 *     picture over itself, and only add the rounding of an 8-bit blend;
 *  4. each layer with a quad that is not behind, in the spec's order.
 *
 * Every other layer is drawn after this by Media3, as always, so quad and behind layers lie under ordinary
 * ones - the documented choice. A post with neither never builds this pass (see
 * [CompositionBuilder.splitUnderlay]), and a frame on which nothing here is on screen is the copy of step 1.
 *
 * WHY A PASS OF ITS OWN. Media3's `OverlayShaderProgram` reaches each overlay through a 4 x 4 matrix and
 * never divides by w, so it can place, stretch and turn a bitmap and cannot foreshorten one; and the matte
 * has to come between two sets of layers, which nothing in Media3's overlays can say.
 *
 * DRAWING A LAYER. Each layer is the unit square - (u, v) its bitmap's texture coordinates - through the
 * homography H onto its four corners in NDC ([LayerGeometry.squareToQuad]). The vertex shader writes
 * `gl_Position = vec4(p.xy, 0, p.z)` for `p = H (u, v, 1)`, so the rasteriser's own divide by w is the
 * homography's, and the perspective-correct interpolation GL gives every varying is, at each pixel, the
 * inverse homography: the bitmap foreshortened as the surface is, not sheared along a diagonal. A flat
 * layer's corners are a parallelogram, whose H has w = 1 at every corner: the same draw, affine.
 *
 * BLENDING, as Media3's overlays blend, so a layer looks the same whichever of the two draws it. An overlay
 * bitmap is decoded PREMULTIPLIED (`BitmapFactory`'s default) and `GLUtils.texImage2D` uploads its bytes as
 * they are, which is what `BitmapOverlay` hands `OverlayShaderProgram`; that mixes `rgb * a + dst * (1 - a)`
 * and `a + dst.a * (1 - a)`, `a` the texel's alpha times the layer's (`getMixColor` in
 * `insert_overlay_fragment_shader_methods.glsl`). Here that is the blend function the compositor uses -
 * `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` on colour and `ONE, ONE_MINUS_SRC_ALPHA` on alpha - over the same texel
 * with the same alpha: the same arithmetic, the same soft edges. Sampling is LINEAR and clamped to the edge,
 * as `GlProgram` binds every texture, and there are no mipmaps, as there are none for Media3's overlays.
 *
 * TIME. A composition effect is handed OUTPUT time, which is what [TimedBitmapOverlay] reads its window and
 * motion off, and the matte's keys and frames are in output ms ([Matte]), so no time is mapped back to a clip.
 *
 * GL STATE. Blending is switched on for steps 2 to 4 and handed back exactly as it was found, function and
 * all. Media3 rebuilds a chain's shader programs at item boundaries, so each program uploads a layer's bitmap
 * the first time it draws it and deletes the texture when it is released; the bitmaps themselves belong to
 * the job (see [TimedBitmapOverlay.release]).
 */
@OptIn(UnstableApi::class)
class LayerUnderlayEffect(
    /** In the spec's order, which is the order each group is drawn in. */
    val layers: List<UnderlayLayer>,
    /** [RenderPlan.matte]: null when no layer is behind anyone. */
    val matte: Matte?,
    /** [Matte.uri], read and checked by the pre-flight. Null draws no matte pass. */
    val matteTrack: SubjectTrack?,
) : GlEffect {

    private val loggedFirstFrame = AtomicBoolean(false)

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        LayerUnderlayShaderProgram(useHdr, this)

    /** Never: whether a layer is on screen is a per-frame question. */
    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    /** What the pass draws and the first frame's stamp, once, at debug level, so a device run can check both. */
    internal fun noteFirstFrame(presentationTimeUs: Long) {
        if (!loggedFirstFrame.compareAndSet(false, true)) return
        val matteNote = matteTrack?.let { "a ${it.width}x${it.height} matte" } ?: "no matte"
        Log.d(
            TAG,
            "underlay: first frame at $presentationTimeUs us; ${layers.size} layers, " +
                "${layers.count { it.behind }} behind, ${layers.count { it.quad != null }} in perspective, $matteNote",
        )
    }

    private companion object {
        /** The tag the rest of the render engine logs under. */
        const val TAG = "VideoComposer"
    }
}

/**
 * [LayerUnderlayEffect]'s passes, in one `BaseGlShaderProgram`: the copy into the target Media3 focused and
 * cleared, then the layers and the matte blended over it, each a four-vertex strip. Nothing is allocated per
 * frame on this side: the corners, the matrix, the levels and the mask have arrays of their own, and a layer's
 * texture is made once.
 */
@OptIn(UnstableApi::class)
private class LayerUnderlayShaderProgram(
    useHdr: Boolean,
    private val effect: LayerUnderlayEffect,
) : BaseGlShaderProgram(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1) {

    private val layers = effect.layers

    /** The layers drawn before the matte and the ones drawn after it, by index, each in the spec's order. */
    private val behind = layers.indices.filter { layers[it].behind }.toIntArray()
    private val above = layers.indices.filter { !layers[it].behind }.toIntArray()

    /** Each layer's texture, made the first time this program draws the layer, and 0 until then. */
    private val textures = IntArray(layers.size)
    private val bitmapWidths = IntArray(layers.size) { layers[it].overlay.pixels.width }
    private val bitmapHeights = IntArray(layers.size) { layers[it].overlay.pixels.height }

    private val track: SubjectTrack? = effect.matteTrack.takeIf { effect.matte != null }
    private val keys: FocusKeys? = effect.matte?.takeIf { track != null }?.let { FocusKeys.of(it.atMs, it.subjects) }
    private val levels = FloatArray(LEVELS)
    private val maskCells = ByteArray(track?.let { it.width * it.height } ?: 0)
    private val maskBuffer: ByteBuffer = ByteBuffer.allocateDirect(maxOf(1, maskCells.size)).order(ByteOrder.nativeOrder())

    private val copyProgram: GlProgram
    private val layerProgram: GlProgram
    private val matteProgram: GlProgram?
    private val maskTexId: Int

    private var width = 0
    private var height = 0

    private val fractions = DoubleArray(OverlayQuad.NUMBERS_PER_KEY)
    private val corners = DoubleArray(OverlayQuad.NUMBERS_PER_KEY)
    private val homography = DoubleArray(9)
    private val glHomography = FloatArray(9)
    private val blendFunc = IntArray(4)
    private val unpackAlignment = IntArray(1)

    init {
        val made = ArrayList<GlProgram>()
        fun program(vertex: String, fragment: String): GlProgram = GlProgram(vertex, fragment).also {
            made += it
            it.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
            )
        }
        var mask = 0
        try {
            copyProgram = program(FRAME_VERTEX_SHADER, COPY_FRAGMENT_SHADER)
            layerProgram = program(LAYER_VERTEX_SHADER, LAYER_FRAGMENT_SHADER)
            matteProgram = if (track != null) program(FRAME_VERTEX_SHADER, MATTE_FRAGMENT_SHADER) else null
            if (track != null) {
                mask = GlUtil.generateTexture()
                GlUtil.bindTexture(GLES20.GL_TEXTURE_2D, mask, GLES20.GL_LINEAR)
                // One byte a cell: LUMINANCE, which ES 2 and ES 3 both take, unsized, for UNSIGNED_BYTE.
                GLES20.glTexImage2D(
                    GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, track.width, track.height, 0,
                    GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, null,
                )
                GlUtil.checkGlError()
            }
        } catch (e: GlUtil.GlException) {
            made.forEach { runCatching { it.delete() } }
            if (mask != 0) runCatching { GlUtil.deleteTexture(mask) }
            throw VideoFrameProcessingException(e)
        }
        maskTexId = mask
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size {
        width = inputWidth
        height = inputHeight
        return Size(inputWidth, inputHeight)
    }

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
        try {
            effect.noteFirstFrame(presentationTimeUs)
            val blending = GLES20.glIsEnabled(GLES20.GL_BLEND)
            GLES20.glGetIntegerv(GLES20.GL_BLEND_SRC_RGB, blendFunc, 0)
            GLES20.glGetIntegerv(GLES20.GL_BLEND_DST_RGB, blendFunc, 1)
            GLES20.glGetIntegerv(GLES20.GL_BLEND_SRC_ALPHA, blendFunc, 2)
            GLES20.glGetIntegerv(GLES20.GL_BLEND_DST_ALPHA, blendFunc, 3)
            try {
                // 1. The picture, copied as it is.
                GLES20.glDisable(GLES20.GL_BLEND)
                drawCopy(inputTexId)
                GLES20.glEnable(GLES20.GL_BLEND)
                GLES20.glBlendFuncSeparate(
                    GLES20.GL_SRC_ALPHA, GLES20.GL_ONE_MINUS_SRC_ALPHA,
                    GLES20.GL_ONE, GLES20.GL_ONE_MINUS_SRC_ALPHA,
                )
                // 2. The layers behind the people.
                var drewBehind = false
                for (i in behind) {
                    if (drawLayer(i, presentationTimeUs)) drewBehind = true
                }
                // 3. The people put back over them.
                if (drewBehind) drawMatte(inputTexId, presentationTimeUs)
                // 4. The layers in perspective that are not behind anyone.
                for (i in above) drawLayer(i, presentationTimeUs)
            } finally {
                GLES20.glBlendFuncSeparate(blendFunc[0], blendFunc[1], blendFunc[2], blendFunc[3])
                if (blending) GLES20.glEnable(GLES20.GL_BLEND) else GLES20.glDisable(GLES20.GL_BLEND)
            }
            GlUtil.checkGlError()
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e, presentationTimeUs)
        } catch (e: SubjectTrackException) {
            // Every frame was decoded once before the render started (see SubjectTrack.checkFrames), so this
            // is a track changed under the render - still the matte's failure, not the GPU's.
            throw VideoFrameProcessingException(e, presentationTimeUs)
        }
    }

    private fun drawCopy(inputTexId: Int) {
        copyProgram.use()
        copyProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, /* texUnitIndex= */ 0)
        copyProgram.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    /**
     * Layer [i] at [presentationTimeUs], blended over what is there; false where it draws nothing - outside
     * its window, faded out, shrunk to nothing, wholly off the frame, or a quad no homography draws.
     */
    private fun drawLayer(i: Int, presentationTimeUs: Long): Boolean {
        val layer = layers[i]
        val overlay = layer.overlay
        val quad = layer.quad
        val alpha: Float
        if (quad != null) {
            alpha = overlay.alphaAt(presentationTimeUs)
            if (!(alpha > 0f)) return false
            LayerGeometry.fractionsToNdc(quad.atUs(presentationTimeUs, fractions), corners)
        } else {
            val pose = overlay.poseAt(presentationTimeUs) ?: return false
            alpha = pose.alpha
            LayerGeometry.poseCorners(pose, bitmapWidths[i], bitmapHeights[i], width, height, corners)
        }
        if (!LayerGeometry.squareToQuad(corners, homography) || !LayerGeometry.toGl(homography, glHomography)) return false
        val texId = textureOf(i)
        layerProgram.use()
        layerProgram.setSamplerTexIdUniform("uLayer", texId, /* texUnitIndex= */ 0)
        layerProgram.setFloatsUniform("uHomography", glHomography)
        layerProgram.setFloatUniform("uAlpha", alpha)
        layerProgram.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
        return true
    }

    /** Layer [i]'s bitmap as a texture, uploaded as `BitmapOverlay` uploads one, the first time it is asked for. */
    private fun textureOf(i: Int): Int {
        if (textures[i] != 0) return textures[i]
        val texId = GlUtil.generateTexture()
        // Kept before the upload, so a texture whose upload fails is still deleted with the rest.
        textures[i] = texId
        try {
            GlUtil.setTexture(texId, layers[i].overlay.pixels)
        } catch (e: IllegalArgumentException) {
            // GLUtils refuses a recycled bitmap, which is a job torn down while a frame was still drawn.
            throw GlUtil.GlException("layer $i has no pixels to draw: ${e.message}")
        }
        return texId
    }

    /** Step 3: the picture over the layers behind, where the matte at [presentationTimeUs] says people are. */
    private fun drawMatte(inputTexId: Int, presentationTimeUs: Long) {
        val program = matteProgram ?: return
        val track = track ?: return
        val keys = keys ?: return
        val ms = presentationTimeUs / 1000.0
        SubjectTracks.focusLevels(keys, ms, levels)
        // Nobody to put back at this instant: the pass would blend the picture in at alpha 0 everywhere.
        if (keys.ids.none { levels[it and 0xff] > 0f }) return
        SubjectTracks.focusMask(track, levels, ms, /* invert= */ false, maskCells)
        uploadMask(track)
        program.use()
        program.setSamplerTexIdUniform("uFrame", inputTexId, /* texUnitIndex= */ 0)
        program.setSamplerTexIdUniform("uMask", maskTexId, /* texUnitIndex= */ 1)
        program.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    private fun uploadMask(track: SubjectTrack) {
        maskBuffer.clear()
        maskBuffer.put(maskCells)
        maskBuffer.flip()
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, maskTexId)
        // Rows of one byte a cell are as long as the grid is wide, which need not be a multiple of four.
        GLES20.glGetIntegerv(GLES20.GL_UNPACK_ALIGNMENT, unpackAlignment, 0)
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
        GLES20.glTexSubImage2D(
            GLES20.GL_TEXTURE_2D, 0, 0, 0, track.width, track.height,
            GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, maskBuffer,
        )
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, unpackAlignment[0])
        GlUtil.checkGlError()
    }

    override fun release() {
        super.release()
        try {
            copyProgram.delete()
            layerProgram.delete()
            matteProgram?.delete()
            for (i in textures.indices) {
                if (textures[i] != 0) GlUtil.deleteTexture(textures[i])
                textures[i] = 0
            }
            if (maskTexId != 0) GlUtil.deleteTexture(maskTexId)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    private companion object {
        /** A table entry for every subject id a cell can hold. */
        const val LEVELS = 256

        // ES 2.0 so the shaders compile on every device the plugin supports, like FocusEffect's; full
        // precision where the device has it, for the sampling coordinates' sake: a layer's bitmap may be
        // wider than mediump can address texel by texel.
        const val FRAME_VERTEX_SHADER = """
            #version 100
            attribute vec4 aFramePosition;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_Position = aFramePosition;
              vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;
            }
        """

        const val COPY_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uTexSampler;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_FragColor = texture2D(uTexSampler, vTexSamplingCoord);
            }
        """

        /*
         * The unit square through the homography: (u, v) from the strip's corners, the corner where H puts
         * it, and the weight left for the rasteriser to divide by - which makes the interpolated (u, v)
         * perspective-correct.
         */
        const val LAYER_VERTEX_SHADER = """
            #version 100
            attribute vec4 aFramePosition;
            uniform mat3 uHomography;
            varying vec2 vLayerCoord;
            void main() {
              vec2 uv = aFramePosition.xy * 0.5 + 0.5;
              vec3 p = uHomography * vec3(uv, 1.0);
              gl_Position = vec4(p.xy, 0.0, p.z);
              vLayerCoord = uv;
            }
        """

        /* The texel as uploaded, its alpha times the layer's: what Media3's overlays mix. */
        const val LAYER_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uLayer;
            uniform float uAlpha;
            varying vec2 vLayerCoord;
            void main() {
              vec4 texel = texture2D(uLayer, vLayerCoord);
              gl_FragColor = vec4(texel.rgb, texel.a * uAlpha);
            }
        """

        /*
         * The picture again, its alpha the matte eased as a focus is, e = m * m * (3 - 2m), m read between
         * cell centres by the texture unit. The grid's rows run from the top and a frame's texture
         * coordinates from the bottom, so the grid is read at (u, 1 - v), as FocusEffect reads one.
         */
        const val MATTE_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uFrame;
            uniform sampler2D uMask;
            varying vec2 vTexSamplingCoord;
            void main() {
              vec4 picture = texture2D(uFrame, vTexSamplingCoord);
              float m = texture2D(uMask, vec2(vTexSamplingCoord.x, 1.0 - vTexSamplingCoord.y)).r;
              gl_FragColor = vec4(picture.rgb, m * m * (3.0 - 2.0 * m));
            }
        """
    }
}
