package net.dotnetdreamer.videokit.videocomposer

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.graphics.Matrix
import android.media.ExifInterface
import android.net.Uri
import android.os.Build
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.GlTextureInfo
import androidx.media3.common.MediaItem
import androidx.media3.common.util.GlRect
import androidx.media3.common.util.Size
import androidx.media3.common.util.UnstableApi
import androidx.media3.effect.ByteBufferGlEffect
import androidx.media3.effect.MatrixTransformation
import androidx.media3.transformer.Composition
import androidx.media3.transformer.EditedMediaItem
import androidx.media3.transformer.EditedMediaItemSequence
import androidx.media3.transformer.Effects
import androidx.media3.transformer.ExportException
import com.google.common.util.concurrent.FutureCallback
import com.google.common.util.concurrent.Futures
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.MoreExecutors
import java.io.File
import java.io.IOException
import java.util.concurrent.ExecutionException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicInteger
import java.util.concurrent.atomic.AtomicReference
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.min
import kotlin.math.roundToInt

/** One segmenter as a matte search uses it: the subject segmenter or the selfie one, behind one call. */
internal interface MatteEngine : AutoCloseable {
    /** The foreground confidence of every pixel of an upright [bitmap], which it takes over and recycles. */
    fun segment(bitmap: Bitmap): ListenableFuture<ConfidenceMask>

    /** What it keeps, as the track says: `subject` or `people`. */
    val target: String

    /** Whether its answers want smoothing over time: true where each frame is looked at on its own. */
    val smooth: Boolean
}

/**
 * The looking half of `findMatte`: a picture, or a video's frames, handed to a [MatteEngine] upright,
 * and each answer kept SOFT on the matte grid - where `findSubjects` thresholds its segmenter's into
 * subjects. Where the tracks are kept, and when a search runs, is [MatteFinder]'s.
 *
 * A VIDEO is decoded the way [SubjectAnalysis] decodes one - a Media3 export that encodes and writes
 * nothing, capped at `fps`, each frame scaled and turned upside down in one matrix pass and read back -
 * at the grid's own size, so a pixel of the read-back is a cell. Each frame's answer is coded into the
 * track's packets as it arrives, in frame order, so a minute of footage holds a few megabytes rather
 * than its raw grids; only the frame before is kept whole, for the smoothing.
 *
 * THE SMOOTHING, for an engine that looks at each frame on its own (the subject segmenter has no
 * stream mode): a cell's answer is mixed with the one before it as far as the picture there has
 * stayed the same - `w = clamp(|dY| * 8, 0.35, 1)` of the new answer, `dY` the cell's change in luma -
 * so a background that does not move stops flickering while an edge that moves follows the new frame.
 */
@OptIn(UnstableApi::class)
internal object MatteAnalysis {

    /** A video's grid on its longer side: `MATTE_GRID`. */
    const val VIDEO_GRID = 512

    /** A picture's grid on its longer side for the subject segmenter: `MATTE_PICTURE_GRID`. */
    const val PICTURE_GRID = 1024

    /** The selfie segmenter looks at 256 x 256 whatever it is shown, so its pictures stay at the video's grid. */
    const val PEOPLE_PICTURE_GRID = 512

    /** The most frames a track keeps: past this a long clip is looked at less often a second. */
    const val MAX_FRAMES = 1800

    /**
     * A picture's matte: one frame at time 0, its grid [PICTURE_GRID] or [PEOPLE_PICTURE_GRID] on its
     * longer side, the picture turned by its orientation tag as Media3 turns it when it draws it. Throws
     * [MatteFinder.UnreadableException] for a file that will not open or decode.
     */
    fun picture(ctx: Context, uri: String, engine: MatteEngine, engineName: String): MatteTrackContent {
        val gridLong = if (engine.target == "people") PEOPLE_PICTURE_GRID else PICTURE_GRID
        val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val resolver = ctx.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            (resolver.openInputStream(parsed) ?: throw MatteFinder.UnreadableException("could not open $uri")).use { BitmapFactory.decodeStream(it, null, bounds) }
        } catch (e: IOException) {
            throw e as? MatteFinder.UnreadableException ?: MatteFinder.UnreadableException("could not open $uri: ${e.message}")
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw MatteFinder.UnreadableException("$uri is not a picture this phone can decode")
        val options = BitmapFactory.Options().apply { inSampleSize = MediaLabels.sampleSize(bounds.outWidth, bounds.outHeight, gridLong) }
        val decoded = try {
            resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it, null, options) }
        } catch (e: IOException) {
            null
        } ?: throw MatteFinder.UnreadableException("$uri will not decode")
        val upright = turned(fitted(MediaLabels.forLabeler(decoded), gridLong), rotationOf(ctx, parsed))
        val (gw, gh) = MatteTracks.grid(upright.width, upright.height, gridLong)
        val mask = try {
            engine.segment(upright).get()
        } catch (e: ExecutionException) {
            throw MatteFinder.UnsupportedException("the segmenter would not look at $uri: ${ErrorMapping.describe(e.cause ?: e)}")
        }
        val cells = ByteArray(gw * gh)
        onto(mask, cells, gw, gh)
        val (coverage, box) = MatteTracks.summarise(listOf(cells), gw, gh)
        return MatteTrackContent(gw, gh, listOf(0L), listOf(cells), MatteTrackMeta(engineName, MediaLabels.Kind.IMAGE, engine.target, 0L, 0.0, coverage, box))
    }

    /** A video's search, ready to start: see [Video]. */
    fun video(uri: String, probe: Thumbnailer.ProbeInfo, fps: Int, engine: MatteEngine, engineName: String, onProgress: (Double) -> Unit): Video {
        // A long clip is looked at less often a second, so its track stays a size the page reads at once.
        val seconds = probe.durationMs / 1000.0
        val rate = if (seconds > 0) min(fps.toDouble(), max(1.0, MAX_FRAMES / seconds)).roundToInt().coerceAtLeast(1) else fps
        return Video(uri, probe, rate, engine, engineName, onProgress)
    }

    /**
     * A confidence mask brought onto a `width` x `height` grid: each cell the mask read bilinearly at
     * the cell's centre, 0..255 - `onto` in `web/mattes.ts`.
     */
    fun onto(mask: ConfidenceMask, cells: ByteArray, width: Int, height: Int) {
        val mw = mask.width
        val mh = mask.height
        val values = mask.values
        for (cy in 0 until height) {
            val gy = (((cy + 0.5) * mh) / height - 0.5).coerceIn(0.0, (mh - 1).toDouble())
            val y0 = gy.toInt()
            val y1 = min(mh - 1, y0 + 1)
            val fy = gy - y0
            for (cx in 0 until width) {
                val gx = (((cx + 0.5) * mw) / width - 0.5).coerceIn(0.0, (mw - 1).toDouble())
                val x0 = gx.toInt()
                val x1 = min(mw - 1, x0 + 1)
                val fx = gx - x0
                val top = values[y0 * mw + x0] * (1 - fx) + values[y0 * mw + x1] * fx
                val bottom = values[y1 * mw + x0] * (1 - fx) + values[y1 * mw + x1] * fx
                cells[cy * width + cx] = Math.round((top * (1 - fy) + bottom * fy).coerceIn(0.0, 1.0) * 255).toInt().toByte()
            }
        }
    }

    /**
     * [cells] mixed with [previous] where the picture has not moved - the class comment's smoothing - in
     * place. [luma] and [previousLuma] are each cell's luma, 0..255.
     */
    fun smooth(cells: ByteArray, luma: ByteArray, previous: ByteArray, previousLuma: ByteArray) {
        for (c in cells.indices) {
            val change = abs((luma[c].toInt() and 0xff) - (previousLuma[c].toInt() and 0xff)) / 255.0
            val w = (change * 8).coerceIn(0.35, 1.0)
            cells[c] = Math.round(w * (cells[c].toInt() and 0xff) + (1 - w) * (previous[c].toInt() and 0xff)).toInt().toByte()
        }
    }

    /** [bitmap] brought down to [longSide] on its longer side where it is larger, recycled when replaced. */
    private fun fitted(bitmap: Bitmap, longSide: Int): Bitmap {
        val longest = max(bitmap.width, bitmap.height)
        if (longest <= longSide) return bitmap
        val scale = longSide.toDouble() / longest
        val out = Bitmap.createScaledBitmap(bitmap, max(1, (bitmap.width * scale).roundToInt()), max(1, (bitmap.height * scale).roundToInt()), true)
        if (out !== bitmap) bitmap.recycle()
        return out
    }

    private fun rotationOf(ctx: Context, uri: Uri): Int {
        val orientation = try {
            ctx.contentResolver.openInputStream(uri)?.use { ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL) }
                ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            ExifInterface.ORIENTATION_NORMAL
        }
        return MediaLabels.rotationFor(orientation)
    }

    private fun turned(bitmap: Bitmap, rotation: Int): Bitmap {
        if (rotation == 0) return bitmap
        val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, Matrix().apply { postRotate(rotation.toFloat()) }, false)
        if (out !== bitmap) bitmap.recycle()
        return out
    }

    /** One frame's answer on the grid, and its cells' luma for the smoothing (null where the engine needs none). */
    class MatteFrame(val cells: ByteArray, val luma: ByteArray?)

    /**
     * One video's frames, from the export that decodes them to the track: [SubjectAnalysis.Video]'s
     * arrangement, the answers kept soft and coded as they come, in frame order.
     */
    class Video(
        private val uri: String,
        private val probe: Thumbnailer.ProbeInfo,
        val fps: Int,
        private val engine: MatteEngine,
        private val engineName: String,
        private val onProgress: (Double) -> Unit,
    ) : ByteBufferGlEffect.Processor<MatteFrame> {

        private val converter: ExecutorService = Executors.newSingleThreadExecutor { task -> Thread(task, "matte-grid").apply { isDaemon = true } }

        private var inputWidth = 0
        private var inputHeight = 0

        @Volatile
        private var grid: Pair<Int, Int>? = null

        /** Guards everything below: fed on the GL thread, finished on the search's. */
        private val lock = Any()
        private val times = ArrayList<Long>()
        private val packets = ArrayList<ByteArray>()
        private var previous: ByteArray? = null
        private var previousLuma: ByteArray? = null
        private var lastTimeMs = -1L
        private var covered = 0L
        private var minX = Int.MAX_VALUE
        private var minY = Int.MAX_VALUE
        private var maxX = -1
        private var maxY = -1

        private val masks = AtomicInteger(0)
        private val segmenterFailure = AtomicReference<Throwable?>(null)

        val composition: Composition by lazy {
            val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
            val item = EditedMediaItem.Builder(MediaItem.fromUri(parsed))
                .setRemoveAudio(true)
                .setFrameRate(fps)
                .setEffects(Effects(emptyList(), listOf(Upright(), ByteBufferGlEffect(this))))
                .build()
            val builder = Composition.Builder(listOf(EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO)).addItem(item).build()))
            if (Build.VERSION.SDK_INT >= 29) builder.setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
            builder.build()
        }

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            this.inputWidth = inputWidth
            this.inputHeight = inputHeight
            val (w, h) = MatteTracks.grid(inputWidth, inputHeight, VIDEO_GRID)
            grid = w to h
            return Size(w, h)
        }

        override fun getScaledRegion(presentationTimeUs: Long): GlRect = GlRect(inputWidth, inputHeight)

        override fun processImage(image: ByteBufferGlEffect.Image, presentationTimeUs: Long): ListenableFuture<MatteFrame> {
            val (w, h) = checkNotNull(grid)
            val luma: ByteArray?
            val bitmap = try {
                image.pixelBuffer.rewind()
                luma = if (engine.smooth) lumaOf(image) else null
                image.pixelBuffer.rewind()
                Bitmap.createBitmap(image.width, image.height, Bitmap.Config.ARGB_8888).also { it.copyPixelsFromBuffer(image.pixelBuffer) }
            } catch (e: Exception) {
                return Futures.immediateFailedFuture(e)
            }
            val mask = engine.segment(bitmap)
            Futures.addCallback(
                mask,
                object : FutureCallback<ConfidenceMask> {
                    override fun onSuccess(result: ConfidenceMask?) {
                        masks.incrementAndGet()
                    }

                    override fun onFailure(t: Throwable) {
                        segmenterFailure.compareAndSet(null, t)
                    }
                },
                MoreExecutors.directExecutor(),
            )
            return Futures.transform(mask, { found -> MatteFrame(ByteArray(w * h).also { onto(checkNotNull(found), it, w, h) }, luma) }, converter)
        }

        /** Each pixel's luma, 0..255, the read-back being the grid's own size: a cell's. */
        private fun lumaOf(image: ByteBufferGlEffect.Image): ByteArray {
            val buffer = image.pixelBuffer
            val out = ByteArray(image.width * image.height)
            for (i in out.indices) {
                val r = buffer.get().toInt() and 0xff
                val g = buffer.get().toInt() and 0xff
                val b = buffer.get().toInt() and 0xff
                buffer.get()
                out[i] = ((2126 * r + 7152 * g + 722 * b) / 10_000).toByte()
            }
            return out
        }

        override fun finishProcessingAndBlend(outputFrame: GlTextureInfo, presentationTimeUs: Long, result: MatteFrame) {
            val timeMs = Math.round(presentationTimeUs / 1000.0)
            val (w, h) = checkNotNull(grid)
            synchronized(lock) {
                if (timeMs <= lastTimeMs) return
                lastTimeMs = timeMs
                val before = previous
                val beforeLuma = previousLuma
                if (result.luma != null && before != null && beforeLuma != null) smooth(result.cells, result.luma, before, beforeLuma)
                previous = result.cells
                previousLuma = result.luma
                var c = 0
                for (y in 0 until h) {
                    for (x in 0 until w) {
                        if ((result.cells[c++].toInt() and 0xff) < 128) continue
                        covered++
                        if (x < minX) minX = x
                        if (x > maxX) maxX = x
                        if (y < minY) minY = y
                        if (y > maxY) maxY = y
                    }
                }
                times += timeMs
                packets += MatteTracks.encodePackets(result.cells)
            }
            if (probe.durationMs > 0) onProgress(min(0.99, timeMs.toDouble() / probe.durationMs))
        }

        override fun release() = Unit

        /** The track's parts once the export has completed: coded frames and the JSON. */
        fun finish(): MatteTracks.Coded = synchronized(lock) {
            if (packets.isEmpty()) throw MatteFinder.UnreadableException("$uri gave no frame")
            val (w, h) = checkNotNull(grid)
            val total = packets.size.toLong() * w * h
            fun round4(v: Double) = Math.round(v * 10_000) / 10_000.0
            val box = if (maxX < 0) null else MatteBox(round4(minX.toDouble() / w), round4(minY.toDouble() / h), round4((maxX + 1 - minX).toDouble() / w), round4((maxY + 1 - minY).toDouble() / h))
            val coverage = if (maxX < 0 || total == 0L) 0.0 else round4(covered.toDouble() / total)
            val durationMs = if (probe.durationMs > 0) probe.durationMs else lastTimeMs
            MatteTracks.Coded(w, h, times.toList(), packets.toList(), MatteTrackMeta(engineName, MediaLabels.Kind.VIDEO, engine.target, durationMs, fps.toDouble(), coverage, box))
        }

        /** What a failed export means: a segmenter that never answered once is one that does not work here. */
        fun explain(e: Throwable): Throwable {
            val failure = segmenterFailure.get()
            if (e is ExportException && failure != null && masks.get() == 0) {
                return MatteFinder.UnsupportedException("the segmenter would not start: ${ErrorMapping.describe(failure)}")
            }
            return e
        }

        fun close() {
            runCatching { engine.close() }
            converter.shutdown()
        }
    }

    /** The frame drawn at twice the grid and upside down ahead of the read-back: [SubjectAnalysis]'s matrix pass. */
    private class Upright : MatrixTransformation {
        private val flip = Matrix().apply { setScale(1f, -1f) }

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            if (max(inputWidth, inputHeight) <= 2 * VIDEO_GRID) return Size(inputWidth, inputHeight)
            val (w, h) = MatteTracks.grid(inputWidth, inputHeight, 2 * VIDEO_GRID)
            return Size(w, h)
        }

        override fun getMatrix(presentationTimeUs: Long): Matrix = flip
    }
}
