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
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

/**
 * A clip's cutout drawn onto its frames: its background taken away - the drawing contract in
 * `ComposeCutout`, steps 2 to 9 - which is `cutout-gl.ts` on the web, pass for pass.
 *
 * WHERE IT SITS. After the grade and after slow motion, before the geometry (see
 * `CompositionBuilder.editedClip`): the contract puts the cutout after the grade, so its guide is the
 * graded picture, and slow motion's flow interpolator draws an opaque frame, so a frame it makes is
 * cut out at its own source time - the contract's second way. Everything after it - the crop, the fit,
 * the rectangle, the camera, a transition's side - carries the alpha on.
 *
 * WHICH ALPHA. What comes out is STRAIGHT where the clip's frames go to Media3's compositor, which
 * blends `SRC_ALPHA, ONE_MINUS_SRC_ALPHA`, and PREMULTIPLIED where they do not: a post with no layers
 * and no transitions goes straight on to [BackgroundEffect] and the encoder, which read the colour as
 * premultiplied - so a cut-out base clip there shows the canvas, or black, where its background was -
 * and a clip with a transition goes through [TransitionEffect], whose `over()` reads it the same way.
 *
 * TIME. As [FocusEffect]: each frame is mapped back through the item's placement, trim and speed to its
 * source time ([FocusTiming]), where the track is read ([MatteTracks.matteAt]).
 */
@OptIn(UnstableApi::class)
class CutoutEffect(
    val cutout: Cutout,
    /** [Cutout.uri], read and checked before the render started. */
    val track: MatteTrack,
    val timing: FocusTiming,
    /** Premultiplied rather than straight: see the class comment. */
    val premultiplied: Boolean,
) : GlEffect {

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram = CutoutShaderProgram(useHdr, this)

    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false
}

/**
 * [CutoutEffect]'s passes, inside one `BaseGlShaderProgram` whose last draw goes into the target it was
 * handed, as [FocusEffect]'s do:
 *
 *  1. The matte at this instant ([MatteTracks.matteAt]) uploaded into a one-channel texture, LINEAR and
 *     clamped, read at `(u, 1 - v)` - the grid's rows run from the top, a frame's coordinates from the
 *     bottom.
 *  2. At the grid's size, into half-float targets: STATS `(y, m, y*y, y*m)`, the guide from four
 *     bilinear reads a quarter of a cell from the centre; the box means across and down; COEF's `a` and
 *     `b`; their box means across and down. Every grid target lies the frame's way up, so the last pass
 *     reads them at the frame's own coordinates.
 *  3. The outline's `D`, when there is one: the matte through a separable Gaussian, at the grid's size.
 *  4. COMPOSITE, steps 5 to 9, into Media3's target.
 *
 * A GPU that will not render to half-float targets skips step 2, as the contract allows, and reads the
 * matte as it is; the outline is then blurred in eight bits.
 */
@OptIn(UnstableApi::class)
private class CutoutShaderProgram(useHdr: Boolean, private val effect: CutoutEffect) :
    BaseGlShaderProgram(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1) {

    private val track = effect.track
    private val cutout = effect.cutout
    private val gw = track.width
    private val gh = track.height
    private val cells = ByteArray(gw * gh)
    private val cellBuffer: ByteBuffer = ByteBuffer.allocateDirect(cells.size).order(ByteOrder.nativeOrder())
    private val fill: FloatArray? = cutout.fill?.toFloatArray()
    private val lineColor: FloatArray = cutout.outline?.color?.toFloatArray() ?: floatArrayOf(0f, 0f, 0f)

    private val statsProgram: GlProgram
    private val boxProgram: GlProgram
    private val coefProgram: GlProgram
    private val blurProgram: GlProgram
    private val compositeProgram: GlProgram
    private val matteTexId: Int

    /** The outline's sigma in cells and its spread (step 7), or null for none. */
    private val outline: Pair<Float, Float>? = cutout.outline?.let {
        val sigma = (it.width * min(gw, gh) / 1.55).toFloat()
        sigma to (0.04f / max(1f, sigma))
    }

    private var width = 0
    private var height = 0
    private var targets: Targets? = null
    private val boundFramebuffer = IntArray(1)
    private val unpackAlignment = IntArray(1)
    private val pair = FloatArray(2)

    init {
        val made = ArrayList<GlProgram>()
        fun program(fragment: String): GlProgram = GlProgram(VERTEX_SHADER, fragment).also {
            made += it
            it.setBufferAttribute("aFramePosition", GlUtil.getNormalizedCoordinateBounds(), GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE)
        }
        try {
            statsProgram = program(STATS_FRAGMENT_SHADER)
            boxProgram = program(BOX_FRAGMENT_SHADER)
            coefProgram = program(COEF_FRAGMENT_SHADER)
            blurProgram = program(BLUR_FRAGMENT_SHADER)
            compositeProgram = program(COMPOSITE_FRAGMENT_SHADER)
            matteTexId = GlUtil.generateTexture()
            GlUtil.bindTexture(GLES20.GL_TEXTURE_2D, matteTexId, GLES20.GL_LINEAR)
            GLES20.glTexImage2D(GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, gw, gh, 0, GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, null)
            GlUtil.checkGlError()
        } catch (e: GlUtil.GlException) {
            made.forEach { runCatching { it.delete() } }
            throw VideoFrameProcessingException(e)
        }
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size {
        width = inputWidth
        height = inputHeight
        return Size(inputWidth, inputHeight)
    }

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
        try {
            MatteTracks.matteAt(track, effect.timing.sourceMs(presentationTimeUs), cells)
            uploadMatte()
            GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, boundFramebuffer, 0)
            val blending = GLES20.glIsEnabled(GLES20.GL_BLEND)
            if (blending) GLES20.glDisable(GLES20.GL_BLEND)
            val built = ensureTargets()
            var coefs: Target? = null
            var line: Target? = null
            try {
                if (built.refine != null) coefs = refine(inputTexId, built.refine)
                if (outline != null) line = blurLine(built.lineAcross, built.line, outline.first)
            } finally {
                if (blending) GLES20.glEnable(GLES20.GL_BLEND)
                GlUtil.focusFramebufferUsingCurrentContext(boundFramebuffer[0], width, height)
            }
            drawComposite(inputTexId, coefs, line)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e, presentationTimeUs)
        } catch (e: MatteTrackException) {
            // Every frame was decoded once before the render started (MatteTrack.checkFrames).
            throw VideoFrameProcessingException(e, presentationTimeUs)
        }
    }

    private fun uploadMatte() {
        cellBuffer.clear()
        cellBuffer.put(cells)
        cellBuffer.flip()
        GLES20.glBindTexture(GLES20.GL_TEXTURE_2D, matteTexId)
        GLES20.glGetIntegerv(GLES20.GL_UNPACK_ALIGNMENT, unpackAlignment, 0)
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, 1)
        GLES20.glTexSubImage2D(GLES20.GL_TEXTURE_2D, 0, 0, 0, gw, gh, GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, cellBuffer)
        GLES20.glPixelStorei(GLES20.GL_UNPACK_ALIGNMENT, unpackAlignment[0])
        GlUtil.checkGlError()
    }

    /** Step 4 at the grid's size; answers the target holding the box means of `a` and `b`. */
    private fun refine(inputTexId: Int, t: RefineTargets): Target {
        begin(statsProgram, t.stats)
        statsProgram.setSamplerTexIdUniform("uFrame", inputTexId, 0)
        statsProgram.setSamplerTexIdUniform("uMatte", matteTexId, 1)
        statsProgram.setFloatsUniform("uCell", pair.of(1f / gw, 1f / gh))
        finish(statsProgram)
        box(t.stats, t.across, t.means)
        begin(coefProgram, t.coef)
        coefProgram.setSamplerTexIdUniform("uSource", t.means.texId, 0)
        coefProgram.setFloatUniform("uEpsilon", ComposeSpecParser.CUTOUT_EPSILON)
        finish(coefProgram)
        box(t.coef, t.across, t.coefs)
        return t.coefs
    }

    /** The contract's `mean`: across into [scratch], down into [into]. */
    private fun box(from: Target, scratch: Target, into: Target) {
        begin(boxProgram, scratch)
        boxProgram.setSamplerTexIdUniform("uSource", from.texId, 0)
        boxProgram.setFloatsUniform("uStep", pair.of(1f / gw, 0f))
        boxProgram.setIntUniform("uRadius", ComposeSpecParser.CUTOUT_RADIUS)
        finish(boxProgram)
        begin(boxProgram, into)
        boxProgram.setSamplerTexIdUniform("uSource", scratch.texId, 0)
        boxProgram.setFloatsUniform("uStep", pair.of(0f, 1f / gh))
        boxProgram.setIntUniform("uRadius", ComposeSpecParser.CUTOUT_RADIUS)
        finish(boxProgram)
    }

    /** Step 7's `D`: the matte blurred across into [across] and down into [into]. */
    private fun blurLine(across: Target, into: Target, sigma: Float): Target {
        val radius = if (sigma >= 1f) min(MAX_TAPS, ceil(3 * sigma).toInt()) else 0
        begin(blurProgram, across)
        blurProgram.setSamplerTexIdUniform("uSource", matteTexId, 0)
        blurProgram.setFloatsUniform("uStep", pair.of(1f / gw, 0f))
        blurProgram.setFloatUniform("uSigma", max(sigma, 1e-3f))
        blurProgram.setIntUniform("uRadius", radius)
        blurProgram.setIntUniform("uFlip", 1)
        finish(blurProgram)
        begin(blurProgram, into)
        blurProgram.setSamplerTexIdUniform("uSource", across.texId, 0)
        blurProgram.setFloatsUniform("uStep", pair.of(0f, 1f / gh))
        blurProgram.setFloatUniform("uSigma", max(sigma, 1e-3f))
        blurProgram.setIntUniform("uRadius", radius)
        blurProgram.setIntUniform("uFlip", 0)
        finish(blurProgram)
        return into
    }

    private fun drawComposite(inputTexId: Int, coefs: Target?, line: Target?) {
        val p = compositeProgram
        p.use()
        p.setSamplerTexIdUniform("uFrame", inputTexId, 0)
        // A sampler is always handed a texture; one that is not read gets the matte.
        p.setSamplerTexIdUniform("uCoef", coefs?.texId ?: matteTexId, 1)
        p.setSamplerTexIdUniform("uMatte", matteTexId, 2)
        p.setSamplerTexIdUniform("uLine", line?.texId ?: matteTexId, 3)
        p.setIntUniform("uRefined", if (coefs != null) 1 else 0)
        p.setFloatUniform("uSoft", cutout.soft)
        p.setFloatUniform("uShift", cutout.shift)
        p.setIntUniform("uOutlined", if (line != null) 1 else 0)
        p.setFloatsUniform("uLineColor", lineColor)
        p.setFloatUniform("uLineSpread", outline?.second ?: 0f)
        p.setIntUniform("uFilled", if (fill != null) 1 else 0)
        p.setFloatsUniform("uFill", fill ?: lineColor)
        p.setIntUniform("uPremultiply", if (effect.premultiplied) 1 else 0)
        p.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GlUtil.checkGlError()
    }

    private fun begin(program: GlProgram, target: Target) {
        GlUtil.focusFramebufferUsingCurrentContext(target.fboId, target.width, target.height)
        GlUtil.clearFocusedBuffers()
        program.use()
    }

    private fun finish(program: GlProgram) {
        program.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
        GlUtil.checkGlError()
    }

    /** The grid's targets, made once: half-float for the refinement where the GPU renders to it, and none of it otherwise. */
    private fun ensureTargets(): Targets {
        targets?.let { return it }
        val stats = Target.make(gw, gh, highPrecision = true)
        val refine = if (stats != null) {
            RefineTargets(stats, target(true), target(true), target(true), target(true))
        } else {
            if (announcedEightBit.compareAndSet(false, true)) Log.i(TAG, "cutout: no half-float targets on this GPU; the matte is drawn unrefined")
            null
        }
        val built = Targets(refine, target(stats != null), target(stats != null))
        targets = built
        return built
    }

    /** A grid-sized target of the precision asked for, or eight bits where that one will not render. */
    private fun target(highPrecision: Boolean): Target =
        Target.make(gw, gh, highPrecision) ?: Target.make(gw, gh, false) ?: throw GlUtil.GlException("no framebuffer for the cutout at ${gw}x$gh")

    override fun release() {
        super.release()
        try {
            targets?.all()?.forEach { it.release() }
            targets = null
            statsProgram.delete()
            boxProgram.delete()
            coefProgram.delete()
            blurProgram.delete()
            compositeProgram.delete()
            GlUtil.deleteTexture(matteTexId)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    private fun FloatArray.of(a: Float, b: Float): FloatArray {
        this[0] = a
        this[1] = b
        return this
    }

    private class RefineTargets(val stats: Target, val across: Target, val means: Target, val coef: Target, val coefs: Target) {
        fun all() = listOf(stats, across, means, coef, coefs)
    }

    private class Targets(val refine: RefineTargets?, val lineAcross: Target, val line: Target) {
        fun all() = (refine?.all() ?: emptyList()) + listOf(lineAcross, line)
    }

    /** A colour texture with a framebuffer on it: [FocusEffect]'s. */
    private class Target(val texId: Int, val fboId: Int, val width: Int, val height: Int) {
        fun release() {
            GlUtil.deleteFbo(fboId)
            GlUtil.deleteTexture(texId)
        }

        companion object {
            fun make(width: Int, height: Int, highPrecision: Boolean): Target? {
                val texId = try {
                    GlUtil.createTexture(width, height, highPrecision)
                } catch (e: GlUtil.GlException) {
                    if (highPrecision) return null
                    throw e
                }
                val fboId = try {
                    GlUtil.createFboForTexture(texId)
                } catch (e: GlUtil.GlException) {
                    GlUtil.deleteTexture(texId)
                    if (highPrecision) return null
                    throw e
                }
                GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fboId)
                if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) == GLES20.GL_FRAMEBUFFER_COMPLETE) return Target(texId, fboId, width, height)
                GlUtil.deleteFbo(fboId)
                GlUtil.deleteTexture(texId)
                return null
            }
        }
    }

    private companion object {
        const val TAG = "VideoComposer"
        const val MAX_TAPS = 64
        val announcedEightBit = AtomicBoolean(false)

        const val VERTEX_SHADER = """
            #version 100
            attribute vec4 aFramePosition;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_Position = aFramePosition;
              vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;
            }
        """

        const val PRECISION = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
        """

        /* Each cell's (y, m, y*y, y*m): the guide from four bilinear reads, the matte at the cell's centre. */
        const val STATS_FRAGMENT_SHADER = PRECISION + """
            uniform sampler2D uFrame;
            uniform sampler2D uMatte;
            uniform vec2 uCell;
            varying vec2 vTexSamplingCoord;
            float lumaAt(vec2 uv) {
              return dot(texture2D(uFrame, uv).rgb, vec3(0.2126, 0.7152, 0.0722));
            }
            void main() {
              vec2 uv = vTexSamplingCoord;
              vec2 q = 0.25 * uCell;
              float y = 0.25 * (lumaAt(uv - q) + lumaAt(uv + vec2(q.x, -q.y)) + lumaAt(uv + vec2(-q.x, q.y)) + lumaAt(uv + q));
              float m = texture2D(uMatte, vec2(uv.x, 1.0 - uv.y)).r;
              gl_FragColor = vec4(y, m, y * y, y * m);
            }
        """

        /* One direction of the contract's box mean; the texture clamps at its edges, which is "the nearest edge cell". */
        const val BOX_FRAGMENT_SHADER = PRECISION + """
            uniform sampler2D uSource;
            uniform vec2 uStep;
            uniform int uRadius;
            varying vec2 vTexSamplingCoord;
            void main() {
              vec4 sum = vec4(0.0);
              for (int i = -8; i <= 8; i++) {
                if (i < -uRadius || i > uRadius) continue;
                sum += texture2D(uSource, vTexSamplingCoord + float(i) * uStep);
              }
              gl_FragColor = sum / float(2 * uRadius + 1);
            }
        """

        const val COEF_FRAGMENT_SHADER = PRECISION + """
            uniform sampler2D uSource;
            uniform float uEpsilon;
            varying vec2 vTexSamplingCoord;
            void main() {
              vec4 s = texture2D(uSource, vTexSamplingCoord);
              float a = (s.w - s.x * s.y) / (s.z - s.x * s.x + uEpsilon);
              gl_FragColor = vec4(a, s.y - a * s.x, 0.0, 1.0);
            }
        """

        /* One direction of the outline's Gaussian. The first pass reads the matte, whose rows run from the top. */
        const val BLUR_FRAGMENT_SHADER = PRECISION + """
            uniform sampler2D uSource;
            uniform vec2 uStep;
            uniform float uSigma;
            uniform int uRadius;
            uniform int uFlip;
            varying vec2 vTexSamplingCoord;
            const int MAX_TAPS = 64;
            float at(vec2 uv) {
              return texture2D(uSource, uFlip == 1 ? vec2(uv.x, 1.0 - uv.y) : uv).r;
            }
            void main() {
              vec2 uv = vTexSamplingCoord;
              float sum = at(uv);
              float total = 1.0;
              float k = -0.5 / (uSigma * uSigma);
              for (int i = 1; i <= MAX_TAPS; i++) {
                if (i > uRadius) break;
                float w = exp(float(i * i) * k);
                vec2 o = float(i) * uStep;
                sum += w * (at(uv + o) + at(uv - o));
                total += 2.0 * w;
              }
              gl_FragColor = vec4(sum / total, 0.0, 0.0, 1.0);
            }
        """

        /* Steps 5 to 9 into Media3's target, straight or premultiplied as the item's way on needs. */
        const val COMPOSITE_FRAGMENT_SHADER = PRECISION + """
            uniform sampler2D uFrame;
            uniform sampler2D uCoef;
            uniform sampler2D uMatte;
            uniform sampler2D uLine;
            uniform int uRefined;
            uniform float uSoft;
            uniform float uShift;
            uniform int uOutlined;
            uniform vec3 uLineColor;
            uniform float uLineSpread;
            uniform int uFilled;
            uniform vec3 uFill;
            uniform int uPremultiply;
            varying vec2 vTexSamplingCoord;
            void main() {
              vec2 uv = vTexSamplingCoord;
              vec4 texel = texture2D(uFrame, uv);
              vec3 c = texel.rgb;
              float q;
              if (uRefined == 1) {
                vec2 ab = texture2D(uCoef, uv).xy;
                q = clamp(ab.x * dot(c, vec3(0.2126, 0.7152, 0.0722)) + ab.y, 0.0, 1.0);
              } else {
                q = texture2D(uMatte, vec2(uv.x, 1.0 - uv.y)).r;
              }
              float t = 0.5 - 0.25 * uShift;
              float h = 0.06 + 0.44 * uSoft;
              // A picture's own alpha is the subject's, so its transparent parts take the line and the fill.
              float a0 = smoothstep(t - h, t + h, q) * texel.a;
              float a = a0;
              vec3 colour = c;
              if (uOutlined == 1) {
                float o = smoothstep(0.06 - uLineSpread, 0.06 + uLineSpread, texture2D(uLine, uv).r);
                a = a0 + (1.0 - a0) * o;
                if (a > 0.0) colour = (c * a0 + uLineColor * (1.0 - a0) * o) / a;
              }
              if (uFilled == 1) {
                colour = mix(uFill, colour, a);
                a = 1.0;
              }
              gl_FragColor = uPremultiply == 1 ? vec4(colour * a, a) : vec4(colour, a);
            }
        """
    }
}
