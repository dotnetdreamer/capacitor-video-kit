package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.opengl.GLES20
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.BaseGlShaderProgram
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import java.util.concurrent.atomic.AtomicBoolean

/**
 * One side of a transition, drawn onto one clip's frames: the drawing half of the contract in
 * `ComposeTransition`, steps 1 to 4, with step 5 left to Media3's compositor.
 *
 * Media3 has no compositor hook of its own - `DefaultVideoCompositor` is hard-wired to
 * `DefaultCompositorGlProgram` - and a shader program sees one input, so neither side can be drawn
 * with the other in hand. It does not need to be. The compositor already blends every input over
 * the one below it with `SRC_ALPHA, ONE_MINUS_SRC_ALPHA` on NON-premultiplied colour, over a frame
 * cleared to transparent black, and the tails' sequence is registered right under the base. So:
 *
 *  - on a TAIL item ([TransitionRole.FROM]) this draws the outgoing side's look with an alpha of 1
 *    wherever its moved frame covers the pixel and 0 elsewhere, and the compositor puts that over
 *    the cleared frame - "the outgoing side over black";
 *  - on the incoming base clip ([TransitionRole.TO]) it draws the incoming side's look with an
 *    alpha of `alpha x mask` where its moved frame covers the pixel, and the compositor blends that
 *    over the tail - "the incoming side over that at alpha x the mask".
 *
 * which is `transitionPixel` in transitions.ts, pixel for pixel. Outside its window the incoming
 * clip is passed through as it is, made opaque; see [TransitionFrame.at].
 *
 * The effect is appended AFTER the clip's geometry, so it is handed the clip's WHOLE output frame -
 * the picture cropped, fitted, placed and graded exactly as it would be with no transition. The
 * letterbox bars arrive transparent, because every shader program clears its target to (0,0,0,0)
 * before it draws, and the contract says a side's frame is its picture "over black". Their colour is
 * already black, and a sample that straddles the picture's edge is already the picture's colour
 * times its coverage - the picture over black - so the colour is read as it is and the alpha is
 * never used as coverage: inside the moved frame the side is opaque, bars and all.
 *
 * Nothing here knows which transition it is drawing. The curves are read on the CPU once per
 * frame, from the frame's own timestamp, and handed over as uniforms; the shader applies the same
 * few operations to whatever numbers it is given.
 *
 * TIMESTAMPS. Media3 1.11.1 hands a per-item effect SEQUENCE time, which is output time here
 * because every sequence starts at 0. `VideoEncoderGraphInput.onMediaItemChanged` registers each
 * item with `offsetToAddUs = initialTimestampOffsetUs + mediaItemOffsetUs`, the offset being the sum
 * of every earlier item's post-speed duration - a gap's included, since `SequenceAssetLoader` calls
 * that for a gap too - and the initial offset is 0 for an ordinary export
 * (`DefaultExportOperation`). `ExternalTextureManager.maybeQueueFrameToExternalShaderProgram` then
 * stamps each decoded frame `frameTimeNs / 1000 + offsetToAddUs`, where the frame time is already
 * item-local (`ExoAssetLoaderVideoRenderer` subtracts the stream's start). The compositor's gate is
 * timed off the same stamps. Each instance logs the first one it sees, once, at debug level, so a
 * device run can confirm the window and the frames agree.
 *
 * WHERE THIS IS NOT THE CONTRACT. The contract reads both sides' curves at the one instant of the
 * output frame. Here each side reads them at its OWN frame's instant, because that is the only
 * time an effect is told, and `DefaultVideoCompositor` then pairs each base frame with the tails'
 * frame NEAREST it - so the two looks of one output frame are up to half a source frame apart, a
 * sixtieth of a second at 30 fps, depending on where each clip's frames happen to fall. Nothing
 * that fades, masks, tints or blurs shows that. Two frames that are meant to travel edge to edge
 * do: at the middle of a 500 ms slide the frames move a tenth of the width per sixtieth, so the
 * seam between them can open by up to that much, black, on the frames where the tail's frame is
 * the later of the two. Closing it takes the two sides' frames on the same instants, which
 * nothing in a per-input effect can arrange: it needs the tail's item shifted by the phase between
 * the two sources' frames, read off their sample times before the render, or a compositor of our
 * own, which `MultipleInputVideoGraph` in 1.11.1 does not let anyone supply.
 */
@OptIn(UnstableApi::class)
class TransitionEffect(
    val role: TransitionRole,
    val transition: Transition,
    /** Where the window opens on the output timeline. */
    val startUs: Long,
    /** How long it runs. */
    val durUs: Long,
) : GlEffect {

    private val loggedFirstFrame = AtomicBoolean(false)

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        TransitionShaderProgram(useHdr, this)

    /**
     * Never: the incoming side's pass outside its window is what makes its letterbox bars opaque,
     * and whether a frame is inside the window is a per-frame question Media3 asks only per stream.
     */
    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    internal fun frameAt(presentationTimeUs: Long, width: Int, height: Int): TransitionFrame =
        TransitionFrame.at(role, transition, startUs, durUs, presentationTimeUs, width, height)

    internal fun noteFirstFrame(presentationTimeUs: Long) {
        if (!loggedFirstFrame.compareAndSet(false, true)) return
        Log.d(
            TAG,
            "transition ${transition.kind} ${role.name.lowercase()}: first frame at $presentationTimeUs us, " +
                "window $startUs..${startUs + durUs} us",
        )
    }

    private companion object {
        /** The tag the rest of the render engine logs under. */
        const val TAG = "VideoComposer"
    }
}

/**
 * The two passes behind [TransitionEffect].
 *
 * THE BLUR. The contract asks for a true Gaussian, sigma up to half the shorter side, with the
 * frame's edges clamped, applied to the side's frame BEFORE it is moved - the frame is blurred and
 * then sampled wherever the transform says. A single pass cannot afford that at 1080 x 1920: a disc
 * of taps wide enough for the sigmas the catalogue uses (up to 0.03 of the shorter side, 32 pixels
 * at 1080) either costs thousands of taps per pixel or leaves visible holes. A Gaussian is
 * separable, and a `BaseGlShaderProgram` may draw as many passes as it likes provided its LAST pass
 * draws into the target it was handed - `queueInputFrame` focuses that target, calls [drawFrame]
 * and hands the target on, and nothing else - so this takes the separable route inside one
 * program: a horizontal pass of the input into a texture of its own, in the frame's own
 * coordinates, then the main pass, which samples that texture with a vertical run of taps at every
 * point the transform picks. That is exactly "blur the frame, then sample it". Each run is 65 taps
 * weighted `exp(-x^2 / 2 sigma^2)` and normalised by their own sum, so brightness is kept exactly.
 * The taps are one pixel apart, which makes the result the frame's exact discrete Gaussian (see
 * [TransitionFrame.blurTapStepPx]), until a pixel apart no longer reaches three sigma; past a sigma
 * of about 10.7 pixels they spread to three sigma / 32. From there it is an approximation, first a
 * close one - taps between texels add a sixth of a square pixel of variance to a sigma of eleven
 * pixels or more - and past about 21 pixels a looser one, the taps being more than two texels
 * apart, so the texels between them are only reached through their neighbours' bilinear fetches.
 * On a frame that soft, and moving, that shows at most as a faint ripple along a hard edge. The
 * catalogue's widest blur is 0.03 of the shorter side: 21.6 pixels on the editor's default
 * 720 x 1280, 32.4 at 1080, where the taps are three pixels apart. The textures clamp to their
 * edges, which is the contract's edge clamp for free. Below [TransitionFrame.MIN_BLUR_SIGMA_PX]
 * the horizontal pass is skipped and the main pass reads one tap: nothing narrower is visible.
 *
 * Both passes run at full precision where the device has it, because the geometry is done in
 * output pixels and a 16-bit float cannot tell pixel 1919 from 1920.
 */
@OptIn(UnstableApi::class)
private class TransitionShaderProgram(
    private val useHdr: Boolean,
    private val effect: TransitionEffect,
) : BaseGlShaderProgram(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1) {

    private val sideProgram: GlProgram
    private val blurProgram: GlProgram
    private var width = 0
    private var height = 0
    private var blurTexId = C.INDEX_UNSET
    private var blurFboId = C.INDEX_UNSET
    private val boundFramebuffer = IntArray(1)
    private val size = FloatArray(2)
    private val pair = FloatArray(2)
    private val rgb = FloatArray(3)

    init {
        try {
            sideProgram = GlProgram(VERTEX_SHADER, SIDE_FRAGMENT_SHADER)
            sideProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
            )
            blurProgram = GlProgram(VERTEX_SHADER, BLUR_FRAGMENT_SHADER)
            blurProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
            )
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size {
        if (inputWidth != width || inputHeight != height) {
            // The blur target is the frame's own size, so a new size is a new target - made again
            // the next time a frame actually blurs, which for most transitions is never.
            releaseBlurTarget()
            width = inputWidth
            height = inputHeight
        }
        return Size(inputWidth, inputHeight)
    }

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
        effect.noteFirstFrame(presentationTimeUs)
        val frame = effect.frameAt(presentationTimeUs, width, height)
        try {
            var source = inputTexId
            if (frame.blurs) {
                // The target BaseGlShaderProgram focused for this frame, so it can be focused again
                // once the horizontal pass has drawn into a target of its own.
                GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, boundFramebuffer, 0)
                ensureBlurTarget()
                GlUtil.focusFramebufferUsingCurrentContext(blurFboId, width, height)
                drawHorizontalBlur(inputTexId, frame)
                GlUtil.focusFramebufferUsingCurrentContext(boundFramebuffer[0], width, height)
                source = blurTexId
            }
            drawSide(source, frame)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e, presentationTimeUs)
        }
    }

    private fun drawHorizontalBlur(inputTexId: Int, frame: TransitionFrame) {
        blurProgram.use()
        blurProgram.setSamplerTexIdUniform("uTexSampler", inputTexId, /* texUnitIndex= */ 0)
        blurProgram.setFloatUniform("uTapStep", tapStepPx(frame.sigmaPx) / width)
        blurProgram.setFloatUniform("uTapFalloff", tapFalloff(frame.sigmaPx))
        blurProgram.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    private fun drawSide(sourceTexId: Int, frame: TransitionFrame) {
        val p = sideProgram
        p.use()
        p.setSamplerTexIdUniform("uTexSampler", sourceTexId, /* texUnitIndex= */ 0)
        size[0] = width.toFloat()
        size[1] = height.toFloat()
        p.setFloatsUniform("uSize", size)
        p.setIntUniform("uDrawLook", if (frame.drawLook) 1 else 0)
        p.setFloatsUniform("uOffset", pair.of(frame.offsetXPx, frame.offsetYPx))
        p.setFloatUniform("uInvScale", frame.invScale)
        p.setFloatsUniform("uTurn", pair.of(frame.turnCos, frame.turnSin))
        p.setFloatUniform("uCell", frame.cellPx)
        p.setFloatUniform("uShift", frame.shiftPx)
        // The vertical run only when the horizontal one has been drawn: the two halves of one blur.
        p.setFloatUniform("uTapStep", if (frame.blurs) tapStepPx(frame.sigmaPx) / height else 0f)
        p.setFloatUniform("uTapFalloff", if (frame.blurs) tapFalloff(frame.sigmaPx) else 0f)
        p.setFloatUniform("uGain", frame.gain)
        rgb[0] = frame.tintR
        rgb[1] = frame.tintG
        rgb[2] = frame.tintB
        p.setFloatsUniform("uTint", rgb)
        p.setFloatUniform("uTintAmount", frame.tintAmount)
        p.setFloatUniform("uAlpha", frame.alpha)
        p.setIntUniform("uMaskShape", frame.maskShape)
        p.setFloatsUniform("uMaskDir", pair.of(frame.maskDirX, frame.maskDirY))
        p.setFloatUniform("uMaskExtent", frame.maskExtentPx)
        p.setFloatUniform("uMaskCount", frame.maskCount)
        p.setFloatUniform("uMaskEdge", frame.maskEdge)
        p.setFloatUniform("uMaskFeather", frame.maskFeather)
        p.setIntUniform("uMaskInvert", if (frame.maskInvert) 1 else 0)
        p.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    /** Fills a two-float scratch array; GlProgram copies it before the next call overwrites it. */
    private fun FloatArray.of(a: Float, b: Float): FloatArray {
        this[0] = a
        this[1] = b
        return this
    }

    private fun ensureBlurTarget() {
        if (blurFboId != C.INDEX_UNSET) return
        blurTexId = GlUtil.createTexture(width, height, useHdr)
        blurFboId = GlUtil.createFboForTexture(blurTexId)
    }

    private fun releaseBlurTarget() {
        try {
            if (blurFboId != C.INDEX_UNSET) GlUtil.deleteFbo(blurFboId)
            if (blurTexId != C.INDEX_UNSET) GlUtil.deleteTexture(blurTexId)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        } finally {
            blurFboId = C.INDEX_UNSET
            blurTexId = C.INDEX_UNSET
        }
    }

    override fun release() {
        super.release()
        releaseBlurTarget()
        try {
            sideProgram.delete()
            blurProgram.delete()
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    private companion object {

        fun tapStepPx(sigmaPx: Float): Float = TransitionFrame.blurTapStepPx(sigmaPx)

        fun tapFalloff(sigmaPx: Float): Float = TransitionFrame.blurTapFalloff(sigmaPx)

        // ES 2.0 so the shaders compile on every device the plugin supports, like ColorMatrixEffect.
        // Both fragment shaders run TAPS = TransitionFrame.BLUR_TAPS taps each side of the centre;
        // GLSL ES 1.00 wants a constant loop bound, so the number is written into them as well.
        const val VERTEX_SHADER = """
            #version 100
            attribute vec4 aFramePosition;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_Position = aFramePosition;
              vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;
            }
        """

        /*
         * Tap k weighs exp(-uTapFalloff k^2 / 2) - see tapFalloff. The weights are built by
         * recurrence, w(k+1) = w(k) r(k) and r(k+1) = r(k) c, which is exact and costs two
         * multiplies a tap instead of an exp, and they are normalised by their own sum. The colour is
         * read as it is: the bars are already black (see TransitionEffect), and the output is opaque
         * because a blurred frame is a frame over black.
         */
        const val BLUR_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uTexSampler;
            uniform float uTapStep;
            uniform float uTapFalloff;
            varying vec2 vTexSamplingCoord;
            const int TAPS = 32;
            void main() {
              float r = exp(-0.5 * uTapFalloff);
              float c = exp(-uTapFalloff);
              float w = 1.0;
              float total = 1.0;
              vec3 sum = texture2D(uTexSampler, vTexSamplingCoord).rgb;
              for (int k = 1; k <= TAPS; k++) {
                w *= r;
                r *= c;
                vec2 o = vec2(float(k) * uTapStep, 0.0);
                sum += w * (texture2D(uTexSampler, vTexSamplingCoord + o).rgb
                    + texture2D(uTexSampler, vTexSamplingCoord - o).rgb);
                total += 2.0 * w;
              }
              gl_FragColor = vec4(sum / total, 1.0);
            }
        """

        /*
         * `sideSource`, the colour read, `maskMeasure` and `maskAlpha` from transitions.ts, in that
         * order, in output pixels with y DOWN: `q` is this fragment's pixel, and a sample point `s`
         * becomes a texture coordinate by flipping y back, because GL's textures count up from the
         * bottom. The shape numbers are MaskShape's ordinals.
         */
        const val SIDE_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uTexSampler;
            uniform vec2 uSize;
            uniform int uDrawLook;
            uniform vec2 uOffset;
            uniform float uInvScale;
            uniform vec2 uTurn;
            uniform float uCell;
            uniform float uShift;
            uniform float uTapStep;
            uniform float uTapFalloff;
            uniform float uGain;
            uniform vec3 uTint;
            uniform float uTintAmount;
            uniform float uAlpha;
            uniform int uMaskShape;
            uniform vec2 uMaskDir;
            uniform float uMaskExtent;
            uniform float uMaskCount;
            uniform float uMaskEdge;
            uniform float uMaskFeather;
            uniform int uMaskInvert;
            varying vec2 vTexSamplingCoord;
            const int TAPS = 32;
            const float TWO_PI = 6.283185307179586;

            vec3 colourAt(vec2 s) {
              vec2 uv = vec2(s.x / uSize.x, 1.0 - s.y / uSize.y);
              if (uTapStep <= 0.0) {
                return texture2D(uTexSampler, uv).rgb;
              }
              float r = exp(-0.5 * uTapFalloff);
              float c = exp(-uTapFalloff);
              float w = 1.0;
              float total = 1.0;
              vec3 sum = texture2D(uTexSampler, uv).rgb;
              for (int k = 1; k <= TAPS; k++) {
                w *= r;
                r *= c;
                vec2 o = vec2(0.0, float(k) * uTapStep);
                sum += w * (texture2D(uTexSampler, uv + o).rgb + texture2D(uTexSampler, uv - o).rgb);
                total += 2.0 * w;
              }
              return sum / total;
            }

            float maskMeasure(vec2 q) {
              vec2 d = q - 0.5 * uSize;
              if (uMaskShape == 0) {
                return dot(d, uMaskDir) / uMaskExtent + 0.5;
              } else if (uMaskShape == 1) {
                return length(d) / length(0.5 * uSize);
              } else if (uMaskShape == 2) {
                return (abs(d.x) + abs(d.y)) / (0.5 * uSize.x + 0.5 * uSize.y);
              } else if (uMaskShape == 3) {
                float turn = atan(d.x, -d.y) / TWO_PI;
                return turn < 0.0 ? turn + 1.0 : turn;
              } else if (uMaskShape == 4) {
                float along = (dot(d, uMaskDir) / uMaskExtent + 0.5) * uMaskCount;
                return along - floor(along);
              } else if (uMaskShape == 5) {
                return abs(dot(d, uMaskDir)) / (0.5 * uMaskExtent);
              }
              return 0.0;
            }

            float maskAlpha(vec2 q) {
              if (uMaskShape < 0) {
                return 1.0;
              }
              float inside = 1.0 - smoothstep(uMaskEdge - uMaskFeather, uMaskEdge + uMaskFeather, maskMeasure(q));
              return uMaskInvert == 1 ? 1.0 - inside : inside;
            }

            void main() {
              if (uDrawLook == 0) {
                gl_FragColor = vec4(texture2D(uTexSampler, vTexSamplingCoord).rgb, 1.0);
                return;
              }
              vec2 q = vec2(vTexSamplingCoord.x, 1.0 - vTexSamplingCoord.y) * uSize;
              vec2 centre = 0.5 * uSize;
              vec2 p = q - centre - uOffset;
              vec2 s = centre + vec2(p.x * uTurn.x - p.y * uTurn.y, p.x * uTurn.y + p.y * uTurn.x) * uInvScale;
              if (s.x < 0.0 || s.y < 0.0 || s.x >= uSize.x || s.y >= uSize.y) {
                gl_FragColor = vec4(0.0);
                return;
              }
              if (uCell > 1.0) {
                s = centre + (floor((s - centre) / uCell) + 0.5) * uCell;
              }
              vec3 rgb;
              if (uShift != 0.0) {
                rgb = vec3(
                    colourAt(s + vec2(uShift, 0.0)).r,
                    colourAt(s).g,
                    colourAt(s - vec2(uShift, 0.0)).b);
              } else {
                rgb = colourAt(s);
              }
              vec3 lit = min(rgb * uGain, vec3(1.0));
              vec3 tinted = lit + (uTint - lit) * uTintAmount;
              gl_FragColor = vec4(tinted, uAlpha * maskAlpha(q));
            }
        """
    }
}
