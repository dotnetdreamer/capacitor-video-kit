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
 * Applies the whole filter stack as ONE colour matrix, in a single fragment-shader pass.
 *
 * It holds nothing but the matrix, so one instance serves every clip of the post (see
 * CompositionBuilder.toComposition, where the sharing is what keeps Media3 from rebuilding its
 * effect chain at every cut). The render's progress meter used to ride along on an identity copy of
 * this effect; it is [ProgressTap] now, which Media3 folds into a neighbouring pass instead of
 * running one of its own.
 */
@OptIn(UnstableApi::class)
class ColorMatrixEffect(
    private val matrix: ColorMatrix,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        ColorMatrixShaderProgram(useHdr, matrix)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = matrix.isIdentity()
}

@OptIn(UnstableApi::class)
private class ColorMatrixShaderProgram(
    useHdr: Boolean,
    matrix: ColorMatrix,
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
            glProgram.setFloatsUniform("uColorMatrix", matrix.toGlColumnMajor())
            glProgram.setFloatsUniform("uColorOffset", matrix.offset())
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
        // ES 2.0 so the shader compiles on every device this plugin supports. Transformer's SDR
        // working colour space leaves frames gamma-encoded between shader programs, which is what
        // the CSS maths in ColorMatrix expects.
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
            uniform mat3 uColorMatrix;
            uniform vec3 uColorOffset;
            varying vec2 vTexSamplingCoord;
            void main() {
              vec4 inputColor = texture2D(uTexSampler, vTexSamplingCoord);
              vec3 rgb = clamp(uColorMatrix * inputColor.rgb + uColorOffset, 0.0, 1.0);
              gl_FragColor = vec4(rgb, inputColor.a);
            }
        """
    }
}
