package net.dotnetdreamer.videokit.videocomposer

import android.opengl.GLES20
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.UnstableApi
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Phase 2's in-between frame: MOTION-COMPENSATED, where [BlendInterpolator] cross-fades. The motion
 * between the two neighbours is worked out once per pair in [prepare] - every pass of
 * `optical-flow.ts`, in the order the web engine runs them, from the very same shader text
 * ([OpticalFlowShaders]) - and [draw] then takes each output pixel from A a fraction of the way back
 * along its motion and from B the rest of the way forward, which draws a moving edge once, where it is,
 * instead of twice. `frame-interpolation.ts` says what the per-pixel step does and why; this is the
 * Media3 half of the orchestration, and nothing in it decides anything the web engine does not.
 *
 * WHAT IT NEEDS: an OpenGL ES 3 context - which Media3 1.11.1 asks for first, SDR included - that can
 * render to half-float textures (`EXT_color_buffer_half_float` or `EXT_color_buffer_float`, both part
 * of ES 3.2). The flow is signed and sub-texel, which eight bits cannot hold. Where either is missing,
 * or a pass will not compile, or a texture will not attach, this is [BlendInterpolator]: phase 1's
 * picture, never anything worse. A GL error in the middle of a pair's passes costs that pair the same
 * way, rather than the export. What it found is logged once per process.
 *
 * GPU MEMORY: the pyramid, gradients, two flows being refined per level and the round-trip test, all
 * at the working size (180x320 for a portrait clip, whatever its resolution) and below - under 4 MB
 * of half-float textures per slowed item being drawn, released with it.
 *
 * GL STATE: [prepare] draws into its own framebuffers with blending off, and puts blending back as it
 * found it; it leaves its own framebuffer bound, which is fine because every draw after it focuses its
 * own target first (see [FrameInterpolator]). [draw] only draws into the target it is handed.
 */
@OptIn(UnstableApi::class)
class FlowInterpolator(private val settings: FlowSettings = OpticalFlow.FLOW) : FrameInterpolator {

    /** Everything the flow draws with; null when this context cannot run it (see the class comment). */
    private val gpu: Programs? = Programs.build()

    /** Phase 1's step: the fallback, and the whole answer where [gpu] is null. */
    private val blend = BlendInterpolator()

    private var width = 0
    private var height = 0
    private var scratch: Scratch? = null

    /** Set when this size's textures could not be had, so every pair does not try again. */
    private var scratchRefused = false

    /** Whether the flow of the current pair was worked out; if not, [draw] cross-fades. */
    private var pairReady = false

    override fun configure(width: Int, height: Int) {
        this.width = width
        this.height = height
        // Made again for the new size the next time a pair is prepared.
        scratch?.release()
        scratch = null
        scratchRefused = false
        pairReady = false
        blend.configure(width, height)
    }

    override fun prepare(fromTexId: Int, toTexId: Int) {
        pairReady = false
        val gpu = gpu ?: return
        if (scratchRefused) return
        val scratch = scratch ?: Scratch.make(width, height, settings).also {
            scratch = it
            scratchRefused = it == null
        } ?: return
        val blending = GLES20.glIsEnabled(GLES20.GL_BLEND)
        if (blending) GLES20.glDisable(GLES20.GL_BLEND)
        try {
            run(gpu, scratch, fromTexId, toTexId)
            pairReady = true
        } catch (e: GlUtil.GlException) {
            Log.w(TAG, "optical flow: a pass failed; this pair is cross-faded", e)
        } finally {
            if (blending) GLES20.glEnable(GLES20.GL_BLEND)
        }
    }

    override fun draw(fromTexId: Int, toTexId: Int, weight: Float) {
        val gpu = gpu
        val scratch = scratch
        if (!pairReady || gpu == null || scratch == null) {
            blend.draw(fromTexId, toTexId, weight)
            return
        }
        val program = gpu.interpolate
        program.use()
        program.setSamplerTexIdUniform("uFrom", fromTexId, /* texUnitIndex= */ 0)
        program.setSamplerTexIdUniform("uTo", toTexId, /* texUnitIndex= */ 1)
        program.setSamplerTexIdUniform("u_flow", scratch.result.texId, /* texUnitIndex= */ 2)
        program.setSamplerTexIdUniform("u_visibility", scratch.visibility.texId, /* texUnitIndex= */ 3)
        program.setFloatUniform("uWeight", weight)
        program.setFloatUniform("u_flowOn", 1f)
        program.setFloatsUniform("u_flowSize", floatArrayOf(scratch.sizes[0].width.toFloat(), scratch.sizes[0].height.toFloat()))
        program.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    override fun release() {
        try {
            scratch?.release()
            gpu?.release()
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        } finally {
            scratch = null
            blend.release()
        }
    }

    /* ------------------------------------------------------------------------------------------ */

    /** Every pass, in `optical-flow-gl.ts`'s order: see `FlowEstimator.estimate` there. */
    private fun run(gpu: Programs, s: Scratch, frameA: Int, frameB: Int) {
        val levels = s.sizes.size
        val taps = OpticalFlow.lumaTaps(width, height, s.sizes[0], settings).toFloat()
        pass(gpu.luma, s.pyramid[0], listOf("u_frameA" to frameA, "u_frameB" to frameB)) {
            setFloatUniform("u_taps", taps)
            // The frames reach this effect already graded (see SlowMotionEffect), so the luma pass sees
            // them through no matrix of its own; the web engine hands it the post's matrix instead.
            setFloatsUniform("u_matrix", IDENTITY)
            setFloatsUniform("u_offset", NO_OFFSET)
        }
        for (level in 1 until levels) {
            val source = s.pyramid[level - 1]
            pass(gpu.down, s.pyramid[level], listOf("u_source" to source.texId)) {
                setFloatsUniform("u_sourceTexel", floatArrayOf(1f / source.width, 1f / source.height))
            }
        }
        pass(gpu.exposure, s.exposure, listOf("u_pyramid" to s.pyramid[levels - 1].texId))
        for (level in 0 until levels) pass(gpu.gradient, s.gradient[level], listOf("u_pyramid" to s.pyramid[level].texId))

        // Coarse to fine; `estimate` is whichever texture holds the latest flow. The coarsest level's
        // first iteration has none and is told so; its flow sampler is handed the exposure texel only
        // because a sampler must be handed something.
        var estimate: Int? = null
        for (level in levels - 1 downTo 0) {
            val (ping, pong) = s.flow[level]
            val bounce = { index: Int -> if (index % 2 == 0) ping else pong }
            val iterations = OpticalFlow.iterationsAt(level, settings)
            for (i in 0 until iterations) {
                val target = bounce(i)
                val fresh = if (estimate == null) 1f else 0f
                pass(
                    gpu.lucasKanade,
                    target,
                    listOf(
                        "u_pyramid" to s.pyramid[level].texId,
                        "u_gradient" to s.gradient[level].texId,
                        "u_flow" to (estimate ?: s.exposure.texId),
                        "u_exposure" to s.exposure.texId,
                    ),
                ) { setFloatUniform("u_fresh", fresh) }
                estimate = target.texId
            }
            if (settings.median) {
                val target = bounce(iterations)
                pass(gpu.median, target, listOf("u_flow" to estimate!!))
                estimate = target.texId
            }
        }

        // The round trip is tested on the flow as estimated, and the texels it fails are then filled in
        // from their neighbours into the answer; see the `fill` pass.
        val estimated = estimate ?: s.exposure.texId
        pass(gpu.consistency, s.consistency, listOf("u_flow" to estimated, "u_pyramid" to s.pyramid[0].texId, "u_exposure" to s.exposure.texId))
        pass(
            gpu.fill,
            s.result,
            listOf("u_flow" to estimated, "u_consistency" to s.consistency.texId, "u_pyramid" to s.pyramid[0].texId, "u_exposure" to s.exposure.texId),
        )
        pass(gpu.trust, s.trust, listOf("u_consistency" to s.consistency.texId))
        pass(gpu.visibility, s.visibility, listOf("u_consistency" to s.consistency.texId, "u_trust" to s.trust.texId))
    }

    /** One pass into `target`, its samplers on units 0, 1, ... in the order given. */
    private inline fun pass(program: GlProgram, target: Target, samplers: List<Pair<String, Int>>, uniforms: GlProgram.() -> Unit = {}) {
        GlUtil.focusFramebufferUsingCurrentContext(target.fboId, target.width, target.height)
        program.use()
        samplers.forEachIndexed { unit, (name, texId) -> program.setSamplerTexIdUniform(name, texId, unit) }
        program.setFloatsUniformIfPresent("u_size", floatArrayOf(target.width.toFloat(), target.height.toFloat()))
        program.uniforms()
        program.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    /** A half-float texture with a framebuffer on it. */
    private class Target(val texId: Int, val fboId: Int, val width: Int, val height: Int) {
        fun release() {
            GlUtil.deleteFbo(fboId)
            GlUtil.deleteTexture(texId)
        }

        companion object {
            /** Null where the GPU will not render to one - checked here, because Media3's helpers do not. */
            fun make(width: Int, height: Int): Target? {
                val texId = GlUtil.createTexture(width, height, /* useHighPrecisionColorComponents= */ true)
                val fboId = try {
                    GlUtil.createFboForTexture(texId)
                } catch (e: GlUtil.GlException) {
                    GlUtil.deleteTexture(texId)
                    throw e
                }
                GLES20.glBindFramebuffer(GLES20.GL_FRAMEBUFFER, fboId)
                val complete = GLES20.glCheckFramebufferStatus(GLES20.GL_FRAMEBUFFER) == GLES20.GL_FRAMEBUFFER_COMPLETE
                if (complete) return Target(texId, fboId, width, height)
                GlUtil.deleteFbo(fboId)
                GlUtil.deleteTexture(texId)
                return null
            }
        }
    }

    /** The textures for one frame size - `Scratch` in optical-flow-gl.ts; [result] and [visibility] are a pair's answer. */
    private class Scratch(
        val sizes: List<FlowSize>,
        val pyramid: List<Target>,
        val gradient: List<Target>,
        val flow: List<Pair<Target, Target>>,
        val consistency: Target,
        val exposure: Target,
        val trust: Target,
        val result: Target,
        val visibility: Target,
    ) {
        fun release() {
            (pyramid + gradient + flow.flatMap { listOf(it.first, it.second) } + listOf(consistency, exposure, trust, result, visibility))
                .forEach { it.release() }
        }

        companion object {
            /** Null, with everything made so far let go of, where any one texture could not be had. */
            fun make(width: Int, height: Int, settings: FlowSettings): Scratch? {
                val sizes = OpticalFlow.pyramid(width, height, settings)
                if (sizes.isEmpty()) return null
                val made = ArrayList<Target>()
                return try {
                    fun target(size: FlowSize): Target =
                        (Target.make(size.width, size.height) ?: throw GlUtil.GlException("incomplete half-float target")).also { made += it }
                    Scratch(
                        sizes = sizes,
                        pyramid = sizes.map(::target),
                        gradient = sizes.map(::target),
                        flow = sizes.map { target(it) to target(it) },
                        consistency = target(sizes[0]),
                        exposure = target(FlowSize(1, 1)),
                        trust = target(FlowSize(1, 1)),
                        result = target(sizes[0]),
                        visibility = target(sizes[0]),
                    )
                } catch (e: GlUtil.GlException) {
                    made.forEach { runCatching { it.release() } }
                    Log.w(TAG, "optical flow: no half-float targets at ${width}x$height; slowed frames are cross-faded", e)
                    null
                }
            }
        }
    }

    /** Every program the flow draws with, built once per interpolator on the GL thread. */
    private class Programs(
        val luma: GlProgram,
        val down: GlProgram,
        val exposure: GlProgram,
        val gradient: GlProgram,
        val lucasKanade: GlProgram,
        val median: GlProgram,
        val consistency: GlProgram,
        val fill: GlProgram,
        val trust: GlProgram,
        val visibility: GlProgram,
        val interpolate: GlProgram,
    ) {
        fun release() {
            listOf(luma, down, exposure, gradient, lucasKanade, median, consistency, fill, trust, visibility, interpolate).forEach { it.delete() }
        }

        companion object {
            /** Said once per process, not once per slowed clip. */
            private val announced = AtomicBoolean(false)

            /** The flow's programs, or null where this context cannot run them (see the class comment). */
            fun build(): Programs? {
                val version = GLES20.glGetString(GLES20.GL_VERSION) ?: ""
                val extensions = " " + (GLES20.glGetString(GLES20.GL_EXTENSIONS) ?: "") + " "
                val parsed = Regex("OpenGL ES (\\d+)\\.(\\d+)").find(version)
                val major = parsed?.groupValues?.get(1)?.toIntOrNull() ?: 2
                val minor = parsed?.groupValues?.get(2)?.toIntOrNull() ?: 0
                val es3 = major >= 3
                val halfFloatTargets = (major > 3 || (es3 && minor >= 2)) ||
                    " GL_EXT_color_buffer_half_float " in extensions || " GL_EXT_color_buffer_float " in extensions
                val programs = if (es3 && halfFloatTargets) {
                    try {
                        compile()
                    } catch (e: GlUtil.GlException) {
                        Log.w(TAG, "optical flow: a pass did not compile; slowed frames are cross-faded", e)
                        null
                    }
                } else {
                    null
                }
                if (announced.compareAndSet(false, true)) {
                    val state = if (programs != null) "on" else "off, slowed frames are cross-faded"
                    Log.i(TAG, "optical flow: $version, half-float targets ${if (halfFloatTargets) "yes" else "no"}: $state")
                }
                return programs
            }

            private fun compile(): Programs {
                val made = ArrayList<GlProgram>()
                fun program(vertex: String, fragment: String) = GlProgram(vertex, fragment).also {
                    made += it
                    it.setBufferAttribute("aFramePosition", GlUtil.getNormalizedCoordinateBounds(), GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE)
                }
                try {
                    return Programs(
                        luma = program(PASS_VERTEX, OpticalFlowShaders.LUMA),
                        down = program(PASS_VERTEX, OpticalFlowShaders.DOWN),
                        exposure = program(PASS_VERTEX, OpticalFlowShaders.EXPOSURE),
                        gradient = program(PASS_VERTEX, OpticalFlowShaders.GRADIENT),
                        lucasKanade = program(PASS_VERTEX, OpticalFlowShaders.LUCAS_KANADE),
                        median = program(PASS_VERTEX, OpticalFlowShaders.MEDIAN),
                        consistency = program(PASS_VERTEX, OpticalFlowShaders.CONSISTENCY),
                        fill = program(PASS_VERTEX, OpticalFlowShaders.FILL),
                        trust = program(PASS_VERTEX, OpticalFlowShaders.TRUST),
                        visibility = program(PASS_VERTEX, OpticalFlowShaders.VISIBILITY),
                        interpolate = program(SlowMotionShaders.VERTEX, INTERPOLATE_FRAGMENT),
                    )
                } catch (e: GlUtil.GlException) {
                    made.forEach { runCatching { it.delete() } }
                    throw e
                }
            }
        }
    }

    internal companion object {
        const val TAG = "VideoComposer"

        private val IDENTITY = floatArrayOf(1f, 0f, 0f, 0f, 1f, 0f, 0f, 0f, 1f)
        private val NO_OFFSET = floatArrayOf(0f, 0f, 0f)

        /** A quad over the whole target; the passes find their texel from gl_FragCoord. */
        private const val PASS_VERTEX = """
            #version 100
            attribute vec4 aFramePosition;
            void main() {
              gl_Position = aFramePosition;
            }
        """

        /**
         * The per-pixel step: the shared body ([OpticalFlowShaders.INTERPOLATION_BODY]) in GLSL ES 1.00,
         * where a texture is read with `texture2D`, called at the pixel's own coordinate - the same
         * coordinate [BlendInterpolator] reads at. Frames here are opaque, so the answer is too.
         */
        val INTERPOLATE_FRAGMENT = "#version 100\nprecision highp float;\n#define SAMPLE(sampler, uv) texture2D(sampler, uv)\n" +
            OpticalFlowShaders.INTERPOLATION_BODY.trimIndent() + "\n" + """
            uniform sampler2D uFrom;
            uniform sampler2D uTo;
            uniform float uWeight;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_FragColor = vec4(interpolateFrames(uFrom, uTo, vTexSamplingCoord, uWeight), 1.0);
            }
            """.trimIndent()
    }
}
