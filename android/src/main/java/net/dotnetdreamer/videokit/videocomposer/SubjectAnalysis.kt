package net.dotnetdreamer.videokit.videocomposer

import android.content.ContentResolver
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
import kotlin.math.max
import kotlin.math.min

/**
 * What a segmenter answered for one picture: a foreground confidence, 0..1, for every pixel of the
 * picture it was handed, row by row from the top-left, the picture being upright.
 */
class ConfidenceMask(val width: Int, val height: Int, val values: FloatArray)

/**
 * The looking half of `findSubjects`: a video's frames or a picture handed to the segmenter, upright and
 * small, and each answer brought onto the subject track's grid and into a [SubjectTracker]. Where the
 * tracks are kept, and when a search runs, is [SubjectFinder]'s.
 *
 * A VIDEO is decoded by a Media3 export that encodes and writes nothing - `ExperimentalAnalyzerModeFactory`,
 * its encoder dropping every frame and its muxer writing no byte - with the item capped at `fps`, a
 * decimator in the asset loader that hands on the first frame at or after each `k / fps` of a second and
 * no other. So the frames come in order off the hardware decoder, upright (the decoder applies the
 * container's rotation), tone-mapped to SDR where the source is HDR, from any codec Media3 decodes -
 * where `MediaMetadataRetriever` costs seconds for every exact frame (see [MediaLabels]). Each frame is
 * scaled down and turned upside down in one matrix pass ([Upright]), then read back by a
 * [ByteBufferGlEffect] whose [Video] processor hands it to the segmenter and, in frame order, to the
 * tracker. Upside down because a GL read-back starts with the bottom row and a bitmap with the top: so
 * flipped, the read-back is the upright picture row by row, which is what a selfie segmenter, trained
 * on people standing up, has to be shown.
 *
 * A PICTURE is decoded once, small, and turned by its orientation tag as Media3 turns it when it draws
 * the picture - by the tag's rotation alone, mirrored tags taken for their turn (`BitmapUtil.decode`) -
 * so the grid lies over the picture the render draws, cell for cell.
 */
@OptIn(UnstableApi::class)
internal object SubjectAnalysis {

    /**
     * The longer side of the picture the segmenter is shown. Its model looks at 256 x 256, and its mask
     * comes back at this size, which the grid's 320 cells are read off: enough that a cell's centre falls
     * on a pixel of its own, and small enough that a frame is a 600 KB copy.
     */
    const val ANALYSIS_LONG_SIDE = 512

    /** A pixel is a subject's at this confidence and above: the segmenter's own even odds. */
    const val THRESHOLD = 0.5f

    /**
     * The size the segmenter is shown a `width` x `height` frame at: [ANALYSIS_LONG_SIDE] on the longer
     * side, the other in proportion, and never larger than the frame.
     */
    fun analysisSize(width: Int, height: Int): Pair<Int, Int> = fitLongSide(width, height, ANALYSIS_LONG_SIDE)

    /**
     * The size the matrix pass draws a frame at before the read-back takes it to [analysisSize]: twice
     * that, where the frame is larger, so the read-back's own scaling is an exact halving - a bilinear
     * read at the corner four pixels share - and the picture is brought down from the frame in two clean
     * steps rather than one that skips most of its pixels.
     */
    fun prescaleSize(width: Int, height: Int): Pair<Int, Int> = fitLongSide(width, height, 2 * ANALYSIS_LONG_SIDE)

    private fun fitLongSide(width: Int, height: Int, longSide: Int): Pair<Int, Int> {
        val longest = max(width, height)
        if (longest <= longSide || width <= 0 || height <= 0) return width to height
        val scale = longSide.toDouble() / longest
        return max(1, Math.round(width * scale).toInt()) to max(1, Math.round(height * scale).toInt())
    }

    /** A segmenter of the kind asked for, or [SubjectFinder.UnsupportedException] where it will not start. */
    private fun openSegmenter(stream: Boolean): SubjectSegmenter = try {
        SubjectSegmenter(stream)
    } catch (e: Exception) {
        throw SubjectFinder.UnsupportedException("the segmenter would not start: ${ErrorMapping.describe(e)}")
    }

    /** One frame's answer on the grid: its instances numbered 1..[count], as [SubjectTracker.componentsOf] left them. */
    class FrameGrid(val cells: ByteArray, val count: Int)

    /** [mask] on a `width` x `height` grid, foreground at [THRESHOLD], split into the people who do not touch. */
    fun gridOf(mask: ConfidenceMask, width: Int, height: Int): FrameGrid {
        val cells = SubjectTracker.toGrid(mask.values, mask.width, mask.height, ByteArray(width * height), width, height, THRESHOLD)
        return FrameGrid(cells, SubjectTracker.componentsOf(cells, width, height))
    }

    /**
     * A picture's track: one frame at time 0. Throws [SubjectFinder.UnreadableException] for a file that
     * will not open or decode, and [SubjectFinder.UnsupportedException] where the segmenter will not look.
     */
    fun picture(ctx: Context, uri: String): SubjectTrackContent {
        val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
        val resolver = ctx.contentResolver
        val bounds = BitmapFactory.Options().apply { inJustDecodeBounds = true }
        try {
            (resolver.openInputStream(parsed) ?: throw SubjectFinder.UnreadableException("could not open $uri"))
                .use { BitmapFactory.decodeStream(it, null, bounds) }
        } catch (e: IOException) {
            throw e as? SubjectFinder.UnreadableException ?: SubjectFinder.UnreadableException("could not open $uri: ${e.message}")
        }
        if (bounds.outWidth <= 0 || bounds.outHeight <= 0) throw SubjectFinder.UnreadableException("$uri is not a picture this phone can decode")
        val options = BitmapFactory.Options().apply {
            inSampleSize = MediaLabels.sampleSize(bounds.outWidth, bounds.outHeight, ANALYSIS_LONG_SIDE)
        }
        val decoded = try {
            resolver.openInputStream(parsed)?.use { BitmapFactory.decodeStream(it, null, options) }
        } catch (e: IOException) {
            null
        } ?: throw SubjectFinder.UnreadableException("$uri will not decode")
        val rotation = rotationOf(resolver, parsed)
        val upright = turned(MediaLabels.forLabeler(decoded), rotation)
        val sideways = rotation == 90 || rotation == 270
        val (gridWidth, gridHeight) = SubjectTracker.subjectGrid(
            if (sideways) bounds.outHeight else bounds.outWidth,
            if (sideways) bounds.outWidth else bounds.outHeight,
        )
        val segmenter = openSegmenter(stream = false)
        val mask = try {
            segmenter.segment(upright).get()
        } catch (e: ExecutionException) {
            // The only frame there is: a segmenter that fails on it is one that does not work here.
            throw SubjectFinder.UnsupportedException("the segmenter would not look at $uri: ${ErrorMapping.describe(e.cause ?: e)}")
        } finally {
            segmenter.close()
        }
        val frame = gridOf(mask, gridWidth, gridHeight)
        val tracker = SubjectTracker(gridWidth, gridHeight)
        tracker.add(0L, frame.cells, frame.count)
        return tracker.finish(SubjectFinder.ENGINE, MediaLabels.Kind.IMAGE, durationMs = 0L, fps = 0.0, subjectKind = SubjectFinder.SUBJECT_KIND)
    }

    /** The quarter turn the picture's tag asks for, as Media3 reads it ([MediaLabels.rotationFor]). */
    private fun rotationOf(resolver: ContentResolver, uri: Uri): Int {
        val orientation = try {
            resolver.openInputStream(uri)?.use {
                ExifInterface(it).getAttributeInt(ExifInterface.TAG_ORIENTATION, ExifInterface.ORIENTATION_NORMAL)
            } ?: ExifInterface.ORIENTATION_NORMAL
        } catch (e: Exception) {
            // A format ExifInterface cannot read (HEIF below API 28) carries no tag it can see.
            ExifInterface.ORIENTATION_NORMAL
        }
        return MediaLabels.rotationFor(orientation)
    }

    /** [bitmap] turned clockwise by [rotation], recycled when a turned copy replaces it. */
    private fun turned(bitmap: Bitmap, rotation: Int): Bitmap {
        if (rotation == 0) return bitmap
        val matrix = Matrix().apply { postRotate(rotation.toFloat()) }
        val out = Bitmap.createBitmap(bitmap, 0, 0, bitmap.width, bitmap.height, matrix, false)
        if (out !== bitmap) bitmap.recycle()
        return out
    }

    /** A video's search, ready to start: see [Video]. */
    fun video(uri: String, probe: Thumbnailer.ProbeInfo, fps: Int, onProgress: (Double) -> Unit): Video =
        Video(uri, probe, fps, openSegmenter(stream = true), onProgress)

    /**
     * One video's frames, from the export that decodes them to the tracker: the [composition] to export,
     * the [ByteBufferGlEffect.Processor] at the end of its chain, and [finish] for the track once the
     * export has completed.
     *
     * Each frame is copied out of the read-back into a bitmap on the GL thread ([processImage]) and
     * handed to the segmenter, which answers on threads of its own; its answer is brought onto the grid
     * on one thread of this search's ([gridOf]), and the grid added to the tracker back on the GL thread
     * in [finishProcessingAndBlend], which Media3 calls in frame order whenever the answers came - the
     * order the tracker has to be fed in. A frame whose time, in whole milliseconds, does not move on
     * from the last one's is not added: the track's times strictly increase.
     *
     * The segmenter runs in STREAM mode, in which ML Kit smooths each mask with the ones before it - the
     * frames are handed over in order, so that is exactly the footage's own order.
     */
    class Video(
        private val uri: String,
        private val probe: Thumbnailer.ProbeInfo,
        private val fps: Int,
        private val segmenter: SubjectSegmenter,
        private val onProgress: (Double) -> Unit,
    ) : ByteBufferGlEffect.Processor<FrameGrid> {

        private val converter: ExecutorService = Executors.newSingleThreadExecutor { task ->
            Thread(task, "subject-grid").apply { isDaemon = true }
        }

        /** The grid, from the probe's upright size; from the first frame's where the probe had none. */
        @Volatile
        private var grid: Pair<Int, Int>? =
            if (probe.width > 0 && probe.height > 0) SubjectTracker.subjectGrid(probe.width, probe.height) else null

        private var inputWidth = 0
        private var inputHeight = 0

        /** Guards [tracker] and [lastTimeMs]: fed on the GL thread, finished on the search's. */
        private val lock = Any()
        private var tracker: SubjectTracker? = null
        private var lastTimeMs = -1L

        /** Masks the segmenter has answered, and the first failure, to tell a segmenter that never started. */
        private val masks = AtomicInteger(0)
        private val segmenterFailure = AtomicReference<Throwable?>(null)

        val composition: Composition by lazy {
            val parsed = Uri.parse(uri).let { if (it.scheme == null) Uri.fromFile(File(uri)) else it }
            val item = EditedMediaItem.Builder(MediaItem.fromUri(parsed))
                .setRemoveAudio(true)
                // The decimator: the first frame at or after each 1 / fps of a second, every other dropped
                // before an effect sees it - see ExoAssetLoaderVideoRenderer in Media3.
                .setFrameRate(fps)
                .setEffects(Effects(emptyList(), listOf(Upright(), ByteBufferGlEffect(this))))
                .build()
            val builder = Composition.Builder(listOf(EditedMediaItemSequence.Builder(setOf(C.TRACK_TYPE_VIDEO)).addItem(item).build()))
            // As a render reads the same footage, so a HDR clip is looked at as the post will show it -
            // and so the effects run in SDR, which the read-back effect requires.
            if (Build.VERSION.SDK_INT >= 29) builder.setHdrMode(Composition.HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL)
            builder.build()
        }

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            this.inputWidth = inputWidth
            this.inputHeight = inputHeight
            if (grid == null) grid = SubjectTracker.subjectGrid(inputWidth, inputHeight)
            val (width, height) = analysisSize(inputWidth, inputHeight)
            return Size(width, height)
        }

        override fun getScaledRegion(presentationTimeUs: Long): GlRect = GlRect(inputWidth, inputHeight)

        override fun processImage(image: ByteBufferGlEffect.Image, presentationTimeUs: Long): ListenableFuture<FrameGrid> {
            val bitmap = try {
                Bitmap.createBitmap(image.width, image.height, Bitmap.Config.ARGB_8888).also {
                    // RGBA bytes, which is ARGB_8888's own layout in memory, and upright rows thanks to Upright.
                    image.pixelBuffer.rewind()
                    it.copyPixelsFromBuffer(image.pixelBuffer)
                }
            } catch (e: Exception) {
                return Futures.immediateFailedFuture(e)
            }
            val mask = segmenter.segment(bitmap)
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
            val (width, height) = checkNotNull(grid)
            return Futures.transform(mask, { gridOf(checkNotNull(it), width, height) }, converter)
        }

        override fun finishProcessingAndBlend(outputFrame: GlTextureInfo, presentationTimeUs: Long, result: FrameGrid) {
            val timeMs = Math.round(presentationTimeUs / 1000.0)
            synchronized(lock) {
                if (timeMs <= lastTimeMs) return
                lastTimeMs = timeMs
                val (width, height) = checkNotNull(grid)
                (tracker ?: SubjectTracker(width, height).also { tracker = it }).add(timeMs, result.cells, result.count)
            }
            // Short of 1 until the track is written, which is when SubjectFinder says 1.
            if (probe.durationMs > 0) onProgress(min(LAST_PROGRESS, timeMs.toDouble() / probe.durationMs))
        }

        override fun release() = Unit

        /** The track, once the export has completed. [SubjectFinder.UnreadableException] for a video that gave no frame. */
        fun finish(): SubjectTrackContent = synchronized(lock) {
            val frames = tracker ?: throw SubjectFinder.UnreadableException("$uri gave no frame")
            val durationMs = if (probe.durationMs > 0) probe.durationMs else lastTimeMs
            frames.finish(SubjectFinder.ENGINE, MediaLabels.Kind.VIDEO, durationMs, fps.toDouble(), SubjectFinder.SUBJECT_KIND)
        }

        /**
         * What a failed export means: a segmenter that failed before it answered a single frame is one
         * that does not work on this phone, [SubjectFinder.UnsupportedException]; anything else is what
         * it was.
         */
        fun explain(e: Throwable): Throwable {
            val failure = segmenterFailure.get()
            if (e is ExportException && failure != null && masks.get() == 0) {
                return SubjectFinder.UnsupportedException("the segmenter would not start: ${ErrorMapping.describe(failure)}")
            }
            return e
        }

        /** Lets go of the segmenter and the grid's thread, whatever the export came to. */
        fun close() {
            runCatching { segmenter.close() }
            converter.shutdown()
        }

        private companion object {
            /** The most progress reported while frames are still being looked at. */
            const val LAST_PROGRESS = 0.99
        }
    }

    /**
     * The matrix pass ahead of the read-back: the frame drawn at [prescaleSize] and upside down - see
     * [SubjectAnalysis] for why upside down. Media3 folds it into one pass over the frame, and that pass
     * is the only one at more than the analysis size.
     */
    private class Upright : MatrixTransformation {
        private val flip = Matrix().apply { setScale(1f, -1f) }

        override fun configure(inputWidth: Int, inputHeight: Int): Size {
            val (width, height) = prescaleSize(inputWidth, inputHeight)
            return Size(width, height)
        }

        override fun getMatrix(presentationTimeUs: Long): Matrix = flip
    }
}
