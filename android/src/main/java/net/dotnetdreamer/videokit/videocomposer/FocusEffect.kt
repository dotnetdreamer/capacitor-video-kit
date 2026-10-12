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
import kotlin.math.sqrt

/**
 * A clip's focus drawn onto its frames: some of its subjects kept sharp and everything else blurred,
 * greyed and darkened - the drawing contract in `ComposeFocus`, all eight steps, on one clip.
 *
 * WHERE IT SITS. First in the clip's chain, before the grade (see `CompositionBuilder.editedClip`),
 * because the contract has focus be the first thing done to the oriented source frame: the grade, the
 * crop, the fit, the rectangle, the camera, slow motion and a transition's side all treat the focused
 * picture as the footage, and the grey and the dark of what is out of focus come before the post's
 * colour matrix, as they do on the web. The frames Media3 hands the first effect are the decoded
 * picture already upright (the decoder applies the container's rotation, and the bitmap loader a
 * picture's orientation tag), at the source's own size - the oriented source frame the subject track
 * was found on, so the track's grid lies over it exactly.
 *
 * A SLOWED clip's frames made between two source frames ([SlowMotionEffect], after this) are made from
 * two frames already focused at their own source times, the first of the two ways the contract allows.
 *
 * TIME. An effect is told a frame's SEQUENCE time, which is output time - see [TransitionEffect] for the
 * chain of offsets - and the keys and the track are in the clip's SOURCE time, so each frame is mapped
 * back through the item's placement, trim and speed ([FocusTiming]). Masks are looked up by time, never
 * by frame index: the track's frames are at times of their own, as many a second as `findSubjects` was
 * asked for, and a frame between two of them mixes the pair (the contract's step 3).
 *
 * The CPU side of each frame is [SubjectTracks.focusLevels] and [SubjectTracks.focusMask] - steps 1 to
 * 3, the same functions every engine ports - and the grid it comes to is uploaded as a one-channel
 * texture; everything after that is [FocusShaderProgram]'s.
 */
@OptIn(UnstableApi::class)
class FocusEffect(
    val focus: Focus,
    /** [Focus.uri], read and checked before the render started. */
    val track: SubjectTrack,
    val timing: FocusTiming,
) : GlEffect {

    private val loggedFirstFrame = AtomicBoolean(false)

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        FocusShaderProgram(useHdr, this)

    /** Never: the parser drops a focus that changes nothing, and what one changes is a per-frame question. */
    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    /**
     * The first frame's stamp and the source time it was read as, once, at debug level - the check
     * [TransitionEffect] and [SlowMotionEffect] make, so a device run can confirm the mapping.
     */
    internal fun noteFirstFrame(presentationTimeUs: Long, sourceMs: Double) {
        if (!loggedFirstFrame.compareAndSet(false, true)) return
        Log.d(
            TAG,
            "focus: first frame at $presentationTimeUs us is source ${"%.1f".format(sourceMs)} ms " +
                "(item at ${timing.startUs} us, trim ${timing.inUs}..${timing.outUs} us at ${timing.speed}x)",
        )
    }

    private companion object {
        /** The tag the rest of the render engine logs under. */
        const val TAG = "VideoComposer"
    }
}

/**
 * Where a frame of a focused clip stands in its SOURCE, which is where its keys and its subject track
 * are read: `inUs + (t - startUs) * speed` for a frame stamped `t` on the sequence's timeline, held to
 * the clip's trim.
 *
 * [startUs] is where the item starts on its sequence - a base clip's prefix sum, a layer clip's
 * placement, a transition tail's item start (its lead included, whose own [inUs] already reaches back
 * by as much) - and [inUs], [outUs] and [speed] are the plan's, the trim the item was handed and the
 * clamped speed it was timed with. A picture is 1x with the trim JS sends it with, 0 onwards, which is
 * where its keys start too: one frame of track, read at the picture's own elapsed time.
 */
data class FocusTiming(val startUs: Long, val inUs: Long, val outUs: Long, val speed: Double) {

    /** The source time, in ms, of the frame stamped [presentationTimeUs] on the sequence's timeline. */
    fun sourceMs(presentationTimeUs: Long): Double {
        val sourceUs = inUs + (presentationTimeUs - startUs) * speed
        return max(inUs.toDouble(), min(outUs.toDouble(), sourceUs)) / 1000.0
    }

    companion object {
        /** The timing of [planned] as an item starting at [startUs] of its sequence. */
        fun of(planned: RenderPlan.PlannedClip, startUs: Long): FocusTiming = FocusTiming(
            startUs = startUs,
            inUs = planned.inUs,
            outUs = planned.outUs,
            speed = planned.clip.speed.coerceIn(ComposeSpecParser.MIN_SPEED, ComposeSpecParser.MAX_SPEED).toDouble(),
        )
    }
}

/**
 * How the contract's Gaussian is approximated - `blurred()` and `levelSigma()` in the web engine's
 * `transition-gl.ts`, number for number, so a focus is as soft on a phone as in the preview.
 *
 * The sigma is `blur * min(W, H)` in SOURCE pixels, up to a tenth of the shorter side on the wire - 216
 * pixels of a 4K frame - far past what a run of taps over the frame itself can reach (see
 * [TransitionEffect]'s blur for where that breaks down). So the frame is halved, each halving a 2x2
 * box, until the sigma is [MIN_LEVEL_SIGMA] to twice that in texels, and blurred there by a separable
 * Gaussian; what the halvings and the bilinear read back up blur on their own is taken off the sigma
 * the passes run with ([levelSigma]), so the finished blur has the sigma asked for.
 */
internal object FocusBlur {

    /**
     * Below this sigma, in source pixels, a Gaussian moves no 8-bit value by a whole step - the web
     * engine's `MIN_BLUR_PX` - so the frame is taken as it is: `B = C`.
     */
    const val MIN_BLUR_PX = 0.25

    /** The smallest sigma, in texels, a blur is run at; halving stops before it falls below this. */
    const val MIN_LEVEL_SIGMA = 2.0

    /** The most taps either side of centre; only a frame too small to halve any further comes near it. */
    const val MAX_TAPS = 64

    /** A level of the pyramid, in texels. */
    data class Level(val width: Int, val height: Int)

    /**
     * The passes for one frame size: the halved [levels] (none when the sigma is already only a few
     * pixels), and the sigma each direction runs with at the last of them, in its texels.
     */
    data class Plan(val sigmaPx: Double, val levels: List<Level>, val across: Double, val down: Double) {
        val acrossTaps: Int get() = taps(across)
        val downTaps: Int get() = taps(down)
    }

    /** The plan for a `width` x `height` frame blurred by [blur] of its shorter side, or null for none. */
    fun plan(width: Int, height: Int, blur: Float): Plan? {
        val sigma = blur.toDouble() * min(width, height)
        if (!(sigma >= MIN_BLUR_PX)) return null
        var w = width
        var h = height
        val levels = ArrayList<Level>()
        while (sigma / ((2.0 * width) / w) >= MIN_LEVEL_SIGMA && (w > 1 || h > 1)) {
            // Half up, as JavaScript's Math.round is, which is what the web sizes the same frame with.
            w = max(1, Math.round(w / 2.0).toInt())
            h = max(1, Math.round(h / 2.0).toInt())
            levels += Level(w, h)
        }
        val halved = levels.isNotEmpty()
        return Plan(sigma, levels, levelSigma(sigma, width.toDouble() / w, halved), levelSigma(sigma, height.toDouble() / h, halved))
    }

    /**
     * The sigma a pass runs with, in texels of the level it runs over, for a wanted [sigma] in source
     * pixels and texels [texel] source pixels apart. The halvings have already blurred the level - a box
     * `texel` wide, variance `(texel^2 - 1) / 12` - and the bilinear read back up blurs it again, by
     * `texel^2 / 6` on average, and variances add. A frame never halved is read back at full size.
     */
    fun levelSigma(sigma: Double, texel: Double, halved: Boolean): Double {
        if (!halved) return sigma
        val already = (texel * texel - 1) / 12 + (texel * texel) / 6
        // Halving stops while the sigma is still twice the texel, so what is left is never below three
        // quarters of it; the floor only keeps a rounding from taking the root of a negative.
        return sqrt(max(sigma * sigma - already, (sigma * sigma) / 4)) / texel
    }

    /** Taps either side of centre for a sigma in texels: three sigma, where the Gaussian has 0.3% left. */
    fun taps(sigma: Double): Int = min(MAX_TAPS, max(1, ceil(3 * sigma).toInt()))
}

/**
 * [FocusEffect]'s passes, all inside one `BaseGlShaderProgram`, whose last draw goes into the target it
 * was handed - the arrangement [TransitionEffect] uses for its blur.
 *
 *  1. The mask: [SubjectTracks.focusMask]'s grid uploaded into a W x H one-channel texture, LINEAR and
 *     clamped to its edges, so sampling it at a pixel's place IS the contract's step 4 - a texel's
 *     centre is a cell's centre, and between centres the texture unit interpolates bilinearly. The
 *     grid's rows run from the top and the frame's texture coordinates from the bottom, so it is read
 *     at `(u, 1 - v)`. Then eased, `e = m * m * (3 - 2m)`, in every pass that reads it.
 *  2. The weighted frame, PREMULTIPLIED by what is out of focus: `(C * (1 - e), 1 - e)` into an RGBA
 *     target, straight into the first halving when the plan has one (four texels read at their own
 *     centres and averaged, which is the weighting and then the 2x2 box exactly) and at full size when
 *     it has none. The weight rides in the alpha channel through everything that follows, so the
 *     blur of the colour and the blur of the weight are the same blur.
 *  3. The rest of the halvings, each a single bilinear read at the centre of four texels.
 *  4. The separable Gaussian at the last level: across into a scratch target, down back into the level.
 *  5. The frame itself: `B = G.rgb / G.a` where `G.a` is at least 1/1024 and `C` where it is not; then
 *     grey (`mix(B, Y, mono)`, Y the Rec. 709 luma), then dark (`B * (1 - dim)`), then
 *     `mix(B, C, e)` held to 0..1, drawn into Media3's target with the frame's own alpha.
 *
 * With no blur worth drawing ([FocusBlur.plan] null) only pass 5 runs, with `B = C`. The targets are
 * half-float where the GPU can render to it, since a weight near 0 divided back out of eight bits would
 * band; eight bits where it cannot. They are made at the frame's size the first time it arrives and kept
 * while it stays. Blending is off for the passes into them, which carry the weight in their alpha.
 *
 * GPU MEMORY: for a 1080 x 1920 frame blurred by the editor's default, one 540 x 960 target and the
 * quarter and sixteenth below it, plus the 320-cell mask - under 6 MB per focused clip being drawn,
 * released when the chain moves on to the next item.
 */
@OptIn(UnstableApi::class)
private class FocusShaderProgram(
    useHdr: Boolean,
    private val effect: FocusEffect,
) : BaseGlShaderProgram(/* useHighPrecisionColorComponents= */ useHdr, /* texturePoolCapacity= */ 1) {

    private val track = effect.track
    private val keys = FocusKeys.of(effect.focus)
    private val levels = FloatArray(LEVELS)
    private val maskCells = ByteArray(track.width * track.height)
    private val maskBuffer: ByteBuffer = ByteBuffer.allocateDirect(maskCells.size).order(ByteOrder.nativeOrder())

    private val weightProgram: GlProgram
    private val weightHalveProgram: GlProgram
    private val resampleProgram: GlProgram
    private val blurProgram: GlProgram
    private val compositeProgram: GlProgram
    private val maskTexId: Int

    private var width = 0
    private var height = 0
    private var plan: FocusBlur.Plan? = null

    /** The full-size weighted frame, for a plan with no halving; null otherwise. */
    private var weighted: Target? = null

    /** One target per halved level of the plan, in order. */
    private val pyramid = ArrayList<Target>()

    /** The across pass's output, the size of the last level (or of the frame). */
    private var scratch: Target? = null

    /** Whether the GPU renders to half-float targets; null until the first one is asked for. */
    private var halfFloat: Boolean? = null

    private val boundFramebuffer = IntArray(1)
    private val unpackAlignment = IntArray(1)
    private val pair = FloatArray(2)

    init {
        val made = ArrayList<GlProgram>()
        fun program(fragment: String): GlProgram = GlProgram(VERTEX_SHADER, fragment).also {
            made += it
            it.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
            )
        }
        try {
            weightProgram = program(WEIGHT_FRAGMENT_SHADER)
            weightHalveProgram = program(WEIGHT_HALVE_FRAGMENT_SHADER)
            resampleProgram = program(RESAMPLE_FRAGMENT_SHADER)
            blurProgram = program(BLUR_FRAGMENT_SHADER)
            compositeProgram = program(COMPOSITE_FRAGMENT_SHADER)
            maskTexId = GlUtil.generateTexture()
            GlUtil.bindTexture(GLES20.GL_TEXTURE_2D, maskTexId, GLES20.GL_LINEAR)
            // One byte a cell: LUMINANCE, which ES 2 and ES 3 both take, unsized, for UNSIGNED_BYTE.
            GLES20.glTexImage2D(
                GLES20.GL_TEXTURE_2D, 0, GLES20.GL_LUMINANCE, track.width, track.height, 0,
                GLES20.GL_LUMINANCE, GLES20.GL_UNSIGNED_BYTE, null,
            )
            GlUtil.checkGlError()
        } catch (e: GlUtil.GlException) {
            made.forEach { runCatching { it.delete() } }
            throw VideoFrameProcessingException(e)
        }
    }

    override fun configure(inputWidth: Int, inputHeight: Int): Size {
        if (inputWidth != width || inputHeight != height) {
            releaseTargets()
            width = inputWidth
            height = inputHeight
            plan = FocusBlur.plan(inputWidth, inputHeight, effect.focus.blur)
        }
        return Size(inputWidth, inputHeight)
    }

    override fun drawFrame(inputTexId: Int, presentationTimeUs: Long) {
        try {
            val sourceMs = effect.timing.sourceMs(presentationTimeUs)
            effect.noteFirstFrame(presentationTimeUs, sourceMs)
            SubjectTracks.focusLevels(keys, sourceMs, levels)
            SubjectTracks.focusMask(track, levels, sourceMs, effect.focus.invert, maskCells)
            uploadMask()
            val blurred = plan?.let { blur(inputTexId, it) }
            drawComposite(inputTexId, blurred)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e, presentationTimeUs)
        } catch (e: SubjectTrackException) {
            // Every frame was decoded once before the render started (see SubjectTrack.checkFrames),
            // so this is a track changed under the render - still the track's failure, not the GPU's.
            throw VideoFrameProcessingException(e, presentationTimeUs)
        }
    }

    private fun uploadMask() {
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

    /** Passes 2 to 4 into targets of this program's own; answers the texture the blur ended in. */
    private fun blur(inputTexId: Int, plan: FocusBlur.Plan): Int {
        // The target BaseGlShaderProgram focused for this frame, to be focused again for pass 5.
        GLES20.glGetIntegerv(GLES20.GL_FRAMEBUFFER_BINDING, boundFramebuffer, 0)
        val blending = GLES20.glIsEnabled(GLES20.GL_BLEND)
        if (blending) GLES20.glDisable(GLES20.GL_BLEND)
        try {
            ensureTargets(plan)
            val first = pyramid.firstOrNull() ?: checkNotNull(weighted)
            val weigh = if (pyramid.isEmpty()) weightProgram else weightHalveProgram
            begin(weigh, first)
            weigh.setSamplerTexIdUniform("uFrame", inputTexId, 0)
            weigh.setSamplerTexIdUniform("uMask", maskTexId, 1)
            if (pyramid.isNotEmpty()) weigh.setFloatsUniform("uFrameTexel", pair.of(1f / width, 1f / height))
            finish(weigh)
            var source = first
            for (level in 1 until pyramid.size) {
                begin(resampleProgram, pyramid[level])
                resampleProgram.setSamplerTexIdUniform("uSource", source.texId, 0)
                finish(resampleProgram)
                source = pyramid[level]
            }
            val across = checkNotNull(scratch)
            begin(blurProgram, across)
            blurProgram.setSamplerTexIdUniform("uSource", source.texId, 0)
            blurProgram.setFloatsUniform("uStep", pair.of(1f / source.width, 0f))
            blurProgram.setFloatUniform("uSigma", max(plan.across, MIN_PASS_SIGMA).toFloat())
            blurProgram.setIntUniform("uRadius", plan.acrossTaps)
            finish(blurProgram)
            begin(blurProgram, source)
            blurProgram.setSamplerTexIdUniform("uSource", across.texId, 0)
            blurProgram.setFloatsUniform("uStep", pair.of(0f, 1f / source.height))
            blurProgram.setFloatUniform("uSigma", max(plan.down, MIN_PASS_SIGMA).toFloat())
            blurProgram.setIntUniform("uRadius", plan.downTaps)
            finish(blurProgram)
            return source.texId
        } finally {
            if (blending) GLES20.glEnable(GLES20.GL_BLEND)
            GlUtil.focusFramebufferUsingCurrentContext(boundFramebuffer[0], width, height)
        }
    }

    private fun drawComposite(inputTexId: Int, blurredTexId: Int?) {
        val p = compositeProgram
        p.use()
        p.setSamplerTexIdUniform("uFrame", inputTexId, 0)
        p.setSamplerTexIdUniform("uMask", maskTexId, 1)
        // A sampler is always handed a texture; with no blur the frame stands in, and is never read.
        p.setSamplerTexIdUniform("uBlurred", blurredTexId ?: inputTexId, 2)
        p.setIntUniform("uBlurs", if (blurredTexId != null) 1 else 0)
        p.setFloatUniform("uMono", effect.focus.mono)
        p.setFloatUniform("uDim", effect.focus.dim)
        p.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    /**
     * The start of a full-target pass of [program] into [target]: the target focused and cleared - so a
     * tiled GPU loads nothing back - and the program made current for its uniforms. [finish] draws it.
     */
    private fun begin(program: GlProgram, target: Target) {
        GlUtil.focusFramebufferUsingCurrentContext(target.fboId, target.width, target.height)
        GlUtil.clearFocusedBuffers()
        program.use()
    }

    /** The quad of a pass [begin] started, drawn with the uniforms set since. */
    private fun finish(program: GlProgram) {
        program.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    private fun ensureTargets(plan: FocusBlur.Plan) {
        if (scratch != null) return
        if (plan.levels.isEmpty()) {
            weighted = makeTarget(width, height)
            scratch = makeTarget(width, height)
        } else {
            plan.levels.forEach { pyramid += makeTarget(it.width, it.height) }
            val last = plan.levels.last()
            scratch = makeTarget(last.width, last.height)
        }
    }

    /** A target of the best precision the GPU will render to: half-float, or eight bits where it will not. */
    private fun makeTarget(width: Int, height: Int): Target {
        if (halfFloat != false) {
            val target = Target.make(width, height, highPrecision = true)
            if (target != null) {
                halfFloat = true
                return target
            }
            if (announcedEightBit.compareAndSet(false, true)) {
                Log.i(TAG, "focus: no half-float targets on this GPU; the blur is weighted in eight bits")
            }
            halfFloat = false
        }
        return Target.make(width, height, highPrecision = false)
            ?: throw GlUtil.GlException("no framebuffer for the focus blur at ${width}x$height")
    }

    private fun releaseTargets() {
        try {
            weighted?.release()
            scratch?.release()
            pyramid.forEach { it.release() }
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        } finally {
            weighted = null
            scratch = null
            pyramid.clear()
        }
    }

    override fun release() {
        super.release()
        releaseTargets()
        try {
            weightProgram.delete()
            weightHalveProgram.delete()
            resampleProgram.delete()
            blurProgram.delete()
            compositeProgram.delete()
            GlUtil.deleteTexture(maskTexId)
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    /** Fills a two-float scratch array; GlProgram copies it before the next call overwrites it. */
    private fun FloatArray.of(a: Float, b: Float): FloatArray {
        this[0] = a
        this[1] = b
        return this
    }

    /** A colour texture with a framebuffer on it. */
    private class Target(val texId: Int, val fboId: Int, val width: Int, val height: Int) {
        fun release() {
            GlUtil.deleteFbo(fboId)
            GlUtil.deleteTexture(texId)
        }

        companion object {
            /**
             * Null where the GPU will not make or render to one of [highPrecision] - checked here,
             * because Media3's helpers do not. An eight-bit target that fails is an error like any other.
             */
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
                if (GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) == GLES20.GL_FRAMEBUFFER_COMPLETE) {
                    return Target(texId, fboId, width, height)
                }
                GlUtil.deleteFbo(fboId)
                GlUtil.deleteTexture(texId)
                return null
            }
        }
    }

    private companion object {
        const val TAG = "VideoComposer"

        /** A table entry for every subject id a cell can hold. */
        const val LEVELS = 256

        /** Said once per process, not once per focused clip. */
        val announcedEightBit = AtomicBoolean(false)

        /** The floor on a pass's sigma, so the shader's `-0.5 / sigma^2` never divides by nothing. */
        const val MIN_PASS_SIGMA = 1e-3

        // ES 2.0 so the shaders compile on every device the plugin supports, like ColorMatrixEffect's;
        // full precision where the device has it, for the sampling coordinates' sake (see
        // SlowMotionShaders.COPY_FRAGMENT) and for the weight divided back out in the last pass.
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
         * The mask at a point of the frame, eased - steps 4 and the ease. The grid's rows run from the
         * top and a frame's texture coordinates from the bottom, so the grid is read at (u, 1 - v).
         */
        const val FOCUS_AT = """
            float focusAt(vec2 uv) {
              float m = texture2D(uMask, vec2(uv.x, 1.0 - uv.y)).r;
              return m * m * (3.0 - 2.0 * m);
            }
        """

        /* The frame premultiplied by what is out of focus at a point, the weight in the alpha: step 5's numerator and denominator. */
        const val WEIGHTED = """
            vec4 weighted(vec2 uv) {
              float keep = 1.0 - focusAt(uv);
              return vec4(texture2D(uFrame, uv).rgb * keep, keep);
            }
        """

        const val WEIGHT_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uFrame;
            uniform sampler2D uMask;
            varying vec2 vTexSamplingCoord;
        """ + FOCUS_AT + WEIGHTED + """
            void main() {
              gl_FragColor = weighted(vTexSamplingCoord);
            }
        """

        /*
         * The weighting and the first halving in one: the four frame texels under this one, each read at
         * its own centre - half a frame texel either way from the corner they share - with the mask at
         * that same centre, and averaged. So no full-size weighted frame is ever drawn.
         */
        const val WEIGHT_HALVE_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uFrame;
            uniform sampler2D uMask;
            uniform vec2 uFrameTexel;
            varying vec2 vTexSamplingCoord;
        """ + FOCUS_AT + WEIGHTED + """
            void main() {
              vec2 d = 0.5 * uFrameTexel;
              gl_FragColor = 0.25 * (weighted(vTexSamplingCoord + vec2(-d.x, -d.y))
                  + weighted(vTexSamplingCoord + vec2(d.x, -d.y))
                  + weighted(vTexSamplingCoord + vec2(-d.x, d.y))
                  + weighted(vTexSamplingCoord + vec2(d.x, d.y)));
            }
        """

        /* A halving: one bilinear read at the corner four texels of the level above share. */
        const val RESAMPLE_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uSource;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_FragColor = texture2D(uSource, vTexSamplingCoord);
            }
        """

        /*
         * One direction of the Gaussian, every channel alike - the colour and its weight are blurred by
         * the same kernel, which is what makes the division in the last pass the weighted blur. The
         * texture clamps at its edges, which is the contract's edge clamp. A constant loop bound with a
         * break, as GLSL ES 1.00 wants (see OpticalFlowShaders.LUMA).
         */
        const val BLUR_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uSource;
            uniform vec2 uStep;
            uniform float uSigma;
            uniform int uRadius;
            varying vec2 vTexSamplingCoord;
            const int MAX_TAPS = 64;
            void main() {
              vec4 sum = texture2D(uSource, vTexSamplingCoord);
              float total = 1.0;
              float k = -0.5 / (uSigma * uSigma);
              for (int i = 1; i <= MAX_TAPS; i++) {
                if (i > uRadius) break;
                float w = exp(float(i * i) * k);
                vec2 o = float(i) * uStep;
                sum += w * (texture2D(uSource, vTexSamplingCoord + o) + texture2D(uSource, vTexSamplingCoord - o));
                total += 2.0 * w;
              }
              gl_FragColor = sum / total;
            }
        """

        /* Steps 5 (the division) to 8, at full size, into Media3's target. */
        const val COMPOSITE_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uFrame;
            uniform sampler2D uMask;
            uniform sampler2D uBlurred;
            uniform int uBlurs;
            uniform float uMono;
            uniform float uDim;
            varying vec2 vTexSamplingCoord;
            const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);
            const float MIN_WEIGHT = 1.0 / 1024.0;
        """ + FOCUS_AT + """
            void main() {
              vec4 c = texture2D(uFrame, vTexSamplingCoord);
              float e = focusAt(vTexSamplingCoord);
              vec3 b = c.rgb;
              if (uBlurs == 1) {
                vec4 g = texture2D(uBlurred, vTexSamplingCoord);
                if (g.a >= MIN_WEIGHT) {
                  b = g.rgb / g.a;
                }
              }
              b = mix(b, vec3(dot(b, LUMA)), uMono);
              b = b * (1.0 - uDim);
              gl_FragColor = vec4(clamp(mix(b, c.rgb, e), 0.0, 1.0), c.a);
            }
        """
    }
}
