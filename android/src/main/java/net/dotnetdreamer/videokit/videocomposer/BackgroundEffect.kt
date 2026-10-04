package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.opengl.GLES20
import androidx.annotation.OptIn
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram

/**
 * The canvas - `ComposeSpec.background` - laid under the finished video picture, in one pass.
 *
 * Everything this engine leaves uncovered arrives here TRANSPARENT: every shader program clears its
 * target to (0,0,0,0) before it draws (see [TransitionEffect]), so a base clip's letterbox bars, the
 * room round a clip placed smaller than the frame and every gap a layer leaves are alpha 0, and the
 * compositor blends each input over that with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`, which leaves the
 * colour PREMULTIPLIED by the coverage it builds up. So the picture over the canvas is one line,
 * `rgb + background * (1 - a)`, and the frame leaves opaque. Before this pass the encoder simply
 * dropped the alpha, which is the black every post had - and which is exactly what this draws for a
 * black canvas, so a post nobody coloured is never handed one.
 *
 * A composition effect, after the colour work and before the overlays: the background is no picture,
 * so the grade never touches it - the rule a letterbox bar has always had - and a caption is drawn
 * over the canvas exactly as it is drawn over a picture.
 */
@OptIn(UnstableApi::class)
class BackgroundEffect(
    /** 0..1 RGB, three channels, as the parser leaves them. */
    private val rgb: FloatArray,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        BackgroundShaderProgram(useHdr, rgb)

    /** Never: whether a frame has anything transparent in it is a per-frame question. */
    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    companion object {
        /** Whether [rgb] is black, which needs no pass at all: it is what the encoder already draws. */
        fun isBlack(rgb: FloatArray?): Boolean = rgb == null || (rgb.size == 3 && rgb.all { it <= 0f })
    }
}

@OptIn(UnstableApi::class)
private class BackgroundShaderProgram(
    useHdr: Boolean,
    rgb: FloatArray,
) : BaseGlShaderProgram(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1) {

    private val glProgram: GlProgram

    init {
        try {
            glProgram = GlProgram(VERTEX_SHADER, FRAGMENT_SHADER)
            glProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
            )
            glProgram.setFloatsUniform("uBackground", rgb)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size = Size(inputWidth, inputHeight)

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
        try {
            glProgram.use()
            glProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, /* texUnitIndex= */ 0)
            glProgram.bindAttributesAndUniforms()
            GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
            GlUtil.checkGlError()
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e, presentationTimeUs)
        }
    }

    override fun release() {
        super.release()
        try {
            glProgram.delete()
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    private companion object {
        // ES 2.0, like ColorMatrixEffect, so it compiles on every device the plugin supports.
        const val VERTEX_SHADER = """
            #version 100
            attribute vec4 aFramePosition;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_Position = aFramePosition;
              vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;
            }
        """

        const val FRAGMENT_SHADER = """
            #version 100
            precision mediump float;
            uniform sampler2D uTexSampler;
            uniform vec3 uBackground;
            varying vec2 vTexSamplingCoord;
            void main() {
              vec4 picture = texture2D(uTexSampler, vTexSamplingCoord);
              gl_FragColor = vec4(picture.rgb + uBackground * (1.0 - picture.a), 1.0);
            }
        """
    }
}
