package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.opengl.GLES20
import android.util.Log
import androidx.annotation.OptIn
import androidx.media3.common.GlObjectsProvider
import androidx.media3.common.GlTextureInfo
import androidx.media3.common.VideoFrameProcessingException
import androidx.media3.common.util.GlProgram
import androidx.media3.common.util.GlUtil
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.GlEffect
import androidx.media3.effect.GlShaderProgram
import java.util.concurrent.Executor
import java.util.concurrent.atomic.AtomicBoolean

/**
 * Smooth slow motion for ONE slowed clip: the frames Media3 never makes, synthesised from the two
 * source frames either side of each missing instant, so the clip reaches the output at the spec's
 * frame rate instead of at its source's rate times its speed.
 *
 * Media3 1.11.1 slows a clip by retiming its samples (`SpeedChangingMediaSource`) and has nothing
 * that adds a frame - `FrameDropEffect` only ever removes them - so 30 fps footage at 0.3x reaches
 * the encoder as nine pictures a second, and the camera, the transition's move and the overlays,
 * which are all drawn per frame, step nine times a second with it. This effect sits in the clip's own
 * chain and hands the rest of the chain a frame at every output instant instead; what each instant
 * is and how far it lies between its neighbours is [SlowMotionCadence], and the protocol that feeds
 * Media3 is [SlowMotionPump]. What an in-between frame LOOKS like is [FrameInterpolator], and nothing
 * else here knows: phase 1 blends, and motion-compensated interpolation replaces the blend by
 * replacing that one step.
 *
 * WHERE IT SITS - see `CompositionBuilder.editedClip` for the whole list. After the speed change,
 * which is not an effect at all but the source's own timestamps, so every frame arriving here is
 * already stamped on the output timeline. After the grade, so the grade runs once per SOURCE frame
 * rather than once per output frame; a colour matrix and a blend commute but for the clamp, which a
 * blend of two clamped colours cannot leave. And BEFORE the geometry, the camera and the transition's
 * side, because all three are functions of the frame's timestamp and have to be read at every
 * synthesised instant: the camera after the geometry is also what keeps a zoom sharp (Media3 folds
 * the two matrices into one pass over the source-resolution picture), and a pass of ours between
 * them would split that pass in two. Before the geometry is also where the pictures are the source's
 * own - no letterbox bars, no crop edges, no turned corners - which is what motion estimation will
 * want to look at.
 *
 * WHAT IT DOES NOT TOUCH. The per-item `setFrameRate` decimator runs in the asset loader, on the
 * decoder's output and before any effect, so it still caps a source above the output rate and can
 * never drop a frame made here. A clip at 1x or faster, and every picture, is never given this
 * effect at all (see [RenderPlan.PlannedClip.slowed]), so their chains are exactly what they were.
 *
 * THE WINDOW. [windowStartUs] and [windowEndUs] are where the item starts and stops on its
 * sequence's timeline, which Media3 stamps the item's frames against: the sum of the post-speed
 * lengths of the items ahead of it, gaps included, off the same floored numbers the plan hands out
 * (see [TransitionEffect] for the chain of offsets). The first frame is held back to the start, the
 * last out to the end, and nothing is ever stamped outside it.
 *
 * GPU MEMORY: two textures at the picture's decoded size per slowed item being drawn - the held
 * frame and the one output - on each sequence that is drawing one. A sequence's chain for an item is
 * released when the next item's is built, so a post with ten slowed clips still holds two at a time.
 */
@OptIn(UnstableApi::class)
class SlowMotionEffect(
    val windowStartUs: Long,
    val windowEndUs: Long,
    /** The spec's output frame rate: what the clip is brought up to. */
    val fps: Int,
    /**
     * The in-between step, made on the GL thread when Media3 builds the chain. The one thing phase 2
     * changes: a motion-compensated interpolator here, and the rest of this file stands as it is.
     */
    private val interpolator: () -> FrameInterpolator = { BlendInterpolator() },
) : GlEffect {

    private val loggedFirstFrame = AtomicBoolean(false)

    override fun toGlShaderProgram(context: Context, useHdr: Boolean): GlShaderProgram =
        SlowMotionShaderProgram(useHdr, this, interpolator())

    /** Never: whether a frame is missing is a per-frame question, and the lead and tail hold frames too. */
    override fun isNoOp(inputWidth: Int, inputHeight: Int): Boolean = false

    internal fun newCadence(): SlowMotionCadence = SlowMotionCadence(windowStartUs, windowEndUs, fps)

    /**
     * The first frame's stamp against the window, once, at debug level - the same check
     * [TransitionEffect] makes, so a device run can confirm the frames and the window agree.
     */
    internal fun noteFirstFrame(presentationTimeUs: Long) {
        if (!loggedFirstFrame.compareAndSet(false, true)) return
        Log.d(TAG, "slow motion: first frame at $presentationTimeUs us, window $windowStartUs..$windowEndUs us")
    }

    /** What the item came to, at debug level: source frames in, frames out. */
    internal fun noteEnd(arrivals: Int, drawn: Int) {
        Log.d(TAG, "slow motion: $arrivals source frames drawn as $drawn over $windowStartUs..$windowEndUs us")
    }

    private companion object {
        /** The tag the rest of the render engine logs under. */
        const val TAG = "VideoComposer"
    }
}

/**
 * The one step of frame synthesis that decides what a missing frame LOOKS like: given the two source
 * frames either side of an instant and how far between them it lies, draw the instant. Everything
 * around it - which instants, which neighbours, the textures, Media3's protocol - is
 * [SlowMotionEffect]'s and stays the same whatever this does.
 *
 * Phase 1 is [BlendInterpolator], a cross-fade. Phase 2 is motion-compensated interpolation: estimate
 * the motion between the two frames once, in [prepare], then warp both frames towards the instant
 * and blend what they agree on in [draw]. [prepare] is there for that alone - a pair of neighbours is
 * drawn at every instant between them, which is up to four draws at 0.25x, and the motion between
 * them is the same for every one.
 *
 * Every call is made on the GL thread with the render engine's context current. Both frames are
 * plain 2D textures of the same size, the upright pictures as the source has them after the grade,
 * and [draw] writes every pixel of the framebuffer that is focused when it is called - a viewport of
 * exactly that size, already cleared. It may use framebuffers of its own in [prepare], but never
 * inside [draw]: the target is focused before the call and read the moment it returns.
 */
interface FrameInterpolator {

    /** The size of both frames and of the target, before the first [prepare] and whenever it changes. */
    fun configure(width: Int, height: Int)

    /** A new pair of neighbours: every [draw] until the next call is between these two. */
    fun prepare(fromTexId: Int, toTexId: Int) {}

    /** Draws the instant [weight] of the way from [fromTexId] (0) to [toTexId] (1), exclusive of both. */
    fun draw(fromTexId: Int, toTexId: Int, weight: Float)

    fun release()
}

/**
 * Phase 1's in-between frame: the two neighbours cross-faded, `mix(A, B, w)`, per pixel.
 *
 * Linear in the working colour space, which for an SDR export is gamma-encoded (see
 * [ColorMatrixEffect]); that is the cross-fade every editor's frame blending draws. Anything that
 * moves shows as a double exposure between two sharp positions, which is the limit of blending and
 * the reason the step is swappable.
 */
@OptIn(UnstableApi::class)
class BlendInterpolator : FrameInterpolator {

    private val program: GlProgram = try {
        GlProgram(SlowMotionShaders.VERTEX, BLEND_FRAGMENT_SHADER).also {
            it.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
            )
        }
    } catch (e: GlUtil.GlException) {
        throw VideoFrameProcessingException(e)
    }

    override fun configure(width: Int, height: Int) = Unit

    override fun draw(fromTexId: Int, toTexId: Int, weight: Float) {
        program.use()
        program.setSamplerTexIdUniform("uFrom", fromTexId, /* texUnitIndex= */ 0)
        program.setSamplerTexIdUniform("uTo", toTexId, /* texUnitIndex= */ 1)
        program.setFloatUniform("uWeight", weight)
        program.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    override fun release() {
        program.delete()
    }

    private companion object {
        const val BLEND_FRAGMENT_SHADER = """
            #version 100
            #ifdef GL_FRAGMENT_PRECISION_HIGH
            precision highp float;
            #else
            precision mediump float;
            #endif
            uniform sampler2D uFrom;
            uniform sampler2D uTo;
            uniform float uWeight;
            varying vec2 vTexSamplingCoord;
            void main() {
              gl_FragColor = mix(
                  texture2D(uFrom, vTexSamplingCoord),
                  texture2D(uTo, vTexSamplingCoord),
                  uWeight);
            }
        """
    }
}

/** The shaders both halves share. */
internal object SlowMotionShaders {

    // ES 2.0 so they compile on every device the plugin supports, like ColorMatrixEffect's.
    const val VERTEX = """
        #version 100
        attribute vec4 aFramePosition;
        varying vec2 vTexSamplingCoord;
        void main() {
          gl_Position = aFramePosition;
          vTexSamplingCoord = aFramePosition.xy * 0.5 + 0.5;
        }
    """

    /*
     * Full precision where the device has it, for the sampling coordinate's sake: a Mali GPU runs
     * mediump as a 16-bit float, which cannot tell texel 1279 of a 1280-line picture from 1280, so a
     * copy at mediump would come out up to a pixel off the frames either side of it - a shimmer on
     * every held and every sharp frame, which is exactly what a slowed clip has most of.
     */
    const val COPY_FRAGMENT = """
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
}

/**
 * [SlowMotionEffect]'s program: Media3's `GlShaderProgram` contract on the outside, [SlowMotionPump]
 * deciding what to draw, and the textures in between.
 *
 * Not a `BaseGlShaderProgram`, whose whole shape is one output per input. It keeps its own textures -
 * Media3's `TexturePool` is package-private - which come to ONE held frame and [OUTPUT_CAPACITY]
 * outputs. One output is enough: every program in the chain runs on the one GL thread, so a second
 * texture would only let this one draw ahead of a downstream that cannot draw at the same time.
 *
 * Every draw clears its target first. Nothing needs the old contents, and on a tiled GPU a clear is
 * what tells the driver not to load them back from memory before drawing over them.
 */
@OptIn(UnstableApi::class)
private class SlowMotionShaderProgram(
    private val useHdr: Boolean,
    private val effect: SlowMotionEffect,
    private val interpolator: FrameInterpolator,
) : GlShaderProgram, SlowMotionPump.Frames {

    private var inputListener: GlShaderProgram.InputListener = object : GlShaderProgram.InputListener {}
    private var outputListener: GlShaderProgram.OutputListener = object : GlShaderProgram.OutputListener {}
    private var errorListener = GlShaderProgram.ErrorListener { Log.e(TAG, "slow motion failed", it) }
    private var errorExecutor = Executor { it.run() }

    private val pump = SlowMotionPump(effect.newCadence(), this)
    private val copyProgram: GlProgram

    private var glObjectsProvider: GlObjectsProvider? = null
    private var width = 0
    private var height = 0

    /** Every output texture this program owns, whether free or lent downstream. */
    private val outputs = ArrayList<GlTextureInfo>(OUTPUT_CAPACITY)
    private val freeOutputs = ArrayDeque<GlTextureInfo>(OUTPUT_CAPACITY)
    private val lentOutputs = ArrayList<GlTextureInfo>(OUTPUT_CAPACITY)

    /** The previous source frame's copy: the pair's first neighbour. */
    private var held: GlTextureInfo? = null

    /** The upstream's texture while it is being drawn from; handed back as soon as it has been kept. */
    private var arrival: GlTextureInfo? = null

    /** Whether [FrameInterpolator.prepare] has seen the current pair. */
    private var pairPrepared = false

    /** The stamp being drawn, for an error to report. */
    private var drawingUs = 0L

    init {
        try {
            copyProgram = GlProgram(SlowMotionShaders.VERTEX, SlowMotionShaders.COPY_FRAGMENT)
            copyProgram.setBufferAttribute(
                "aFramePosition",
                GlUtil.getNormalizedCoordinateBounds(),
                GlUtil.HOMOGENEOUS_COORDINATE_VECTOR_SIZE,
            )
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        }
    }

    override fun setInputListener(inputListener: GlShaderProgram.InputListener) {
        this.inputListener = inputListener
        // One input at a time - see SlowMotionPump.
        if (arrival == null) inputListener.onReadyToAcceptInputFrame()
    }

    override fun setOutputListener(outputListener: GlShaderProgram.OutputListener) {
        this.outputListener = outputListener
    }

    override fun setErrorListener(executor: Executor, errorListener: GlShaderProgram.ErrorListener) {
        this.errorExecutor = executor
        this.errorListener = errorListener
    }

    override fun queueInputFrame(
        glObjectsProvider: GlObjectsProvider,
        inputTexture: GlTextureInfo,
        presentationTimeUs: Long,
    ) {
        guarded(presentationTimeUs) {
            this.glObjectsProvider = glObjectsProvider
            effect.noteFirstFrame(presentationTimeUs)
            val resized = inputTexture.width != width || inputTexture.height != height
            if (resized) resize(inputTexture.width, inputTexture.height)
            arrival = inputTexture
            pairPrepared = false
            // A frame of another size has no neighbour to blend with; the first frame has none anyway.
            pump.arrive(presentationTimeUs, blendable = !resized)
        }
    }

    override fun releaseOutputFrame(outputTexture: GlTextureInfo) {
        guarded(drawingUs) {
            // Media3 may hand back a texture a program it replaced drew; it is not this one's to free.
            if (!lentOutputs.remove(outputTexture)) return@guarded
            if (outputTexture.width != width || outputTexture.height != height) {
                // Drawn before the frames changed size: it goes, and a texture of the new size will
                // take its place the next time one is needed.
                outputs.remove(outputTexture)
                outputTexture.release()
            } else {
                freeOutputs.addLast(outputTexture)
            }
            pump.outputFreed()
        }
    }

    override fun signalEndOfCurrentInputStream() {
        guarded(drawingUs) { pump.endOfStream() }
    }

    override fun flush() {
        guarded(drawingUs) {
            // The upstream flushes itself and takes its textures back, the arrival among them; ours
            // come back from the downstream the same way, so every one of them is free again - or
            // gone, if it was drawn at a size the frames have since left (see releaseOutputFrame).
            for (texture in lentOutputs) {
                if (texture.width == width && texture.height == height) {
                    freeOutputs.addLast(texture)
                } else {
                    outputs.remove(texture)
                    texture.release()
                }
            }
            lentOutputs.clear()
            arrival = null
            pump.flush()
            inputListener.onFlush()
            inputListener.onReadyToAcceptInputFrame()
        }
    }

    override fun release() {
        try {
            for (texture in outputs) texture.release()
            held?.release()
            copyProgram.delete()
            interpolator.release()
        } catch (e: GlUtil.GlException) {
            throw VideoFrameProcessingException(e)
        } finally {
            outputs.clear()
            freeOutputs.clear()
            lentOutputs.clear()
            held = null
            arrival = null
        }
    }

    /* SlowMotionPump.Frames -------------------------------------------------------------------- */

    override fun canDraw(): Boolean {
        if (freeOutputs.isNotEmpty()) return true
        if (outputs.size >= OUTPUT_CAPACITY) return false
        val texture = newTexture()
        outputs += texture
        freeOutputs.addLast(texture)
        return true
    }

    override fun drawBetween(timeUs: Long, weight: Float) {
        val from = checkNotNull(held).texId
        val to = checkNotNull(arrival).texId
        if (!pairPrepared) {
            // Before the target is focused: a motion estimator may draw into targets of its own.
            interpolator.prepare(from, to)
            pairPrepared = true
        }
        emit(timeUs) { interpolator.draw(from, to, weight) }
    }

    override fun drawArrival(timeUs: Long) {
        val source = checkNotNull(arrival).texId
        emit(timeUs) { copy(source) }
    }

    override fun drawHeld(timeUs: Long) {
        val source = checkNotNull(held).texId
        emit(timeUs) { copy(source) }
    }

    override fun keepArrival() {
        val target = held ?: newTexture().also { held = it }
        GlUtil.focusFramebufferUsingCurrentContext(target.fboId, target.width, target.height)
        GlUtil.clearFocusedBuffers()
        copy(checkNotNull(arrival).texId)
    }

    override fun releaseArrival() {
        val input = checkNotNull(arrival)
        arrival = null
        inputListener.onInputFrameProcessed(input)
        inputListener.onReadyToAcceptInputFrame()
    }

    override fun endStream() {
        effect.noteEnd(pump.arrivals, pump.drawn)
        outputListener.onCurrentOutputStreamEnded()
    }

    /* ------------------------------------------------------------------------------------------ */

    private inline fun emit(timeUs: Long, draw: () -> Unit) {
        drawingUs = timeUs
        val target = freeOutputs.removeFirst()
        lentOutputs += target
        GlUtil.focusFramebufferUsingCurrentContext(target.fboId, target.width, target.height)
        GlUtil.clearFocusedBuffers()
        draw()
        outputListener.onOutputFrameAvailable(target, timeUs)
    }

    private fun copy(sourceTexId: Int) {
        copyProgram.use()
        copyProgram.setSamplerTexIdUniform("uTexSampler", sourceTexId, /* texUnitIndex= */ 0)
        copyProgram.bindAttributesAndUniforms()
        GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, /* first= */ 0, /* count= */ 4)
        GlUtil.checkGlError()
    }

    /**
     * The frames have a new size - the first frame, or a decoder that changed it mid-stream. The held
     * frame goes, and so does every output nobody is using; the ones lent downstream go as they come
     * back (see [releaseOutputFrame]).
     */
    private fun resize(newWidth: Int, newHeight: Int) {
        width = newWidth
        height = newHeight
        interpolator.configure(newWidth, newHeight)
        for (texture in freeOutputs) {
            outputs.remove(texture)
            texture.release()
        }
        freeOutputs.clear()
        held?.release()
        held = null
    }

    private fun newTexture(): GlTextureInfo {
        val texId = GlUtil.createTexture(width, height, useHdr)
        return checkNotNull(glObjectsProvider).createBuffersForTexture(texId, width, height)
    }

    private inline fun guarded(presentationTimeUs: Long, block: () -> Unit) {
        try {
            block()
        } catch (e: Exception) {
            val error = VideoFrameProcessingException.from(e, presentationTimeUs)
            errorExecutor.execute { errorListener.onError(error) }
        }
    }

    private companion object {
        const val TAG = "VideoComposer"

        /** See the class comment: one output is all a single GL thread can use. */
        const val OUTPUT_CAPACITY = 1
    }
}
