package net.dotnetdreamer.videokit.videocomposer

import android.graphics.Bitmap
import com.google.common.util.concurrent.ListenableFuture
import com.google.common.util.concurrent.SettableFuture
import com.google.mlkit.vision.common.InputImage
import com.google.mlkit.vision.segmentation.Segmentation
import com.google.mlkit.vision.segmentation.SegmentationMask
import com.google.mlkit.vision.segmentation.Segmenter
import com.google.mlkit.vision.segmentation.selfie.SelfieSegmenterOptions
import java.util.concurrent.Executor

/**
 * `findSubjects`' engine: ML Kit's selfie segmentation, with its model bundled into the app.
 *
 * One of two files of this name, and the build compiles one: this one by default, and
 * `src/nosubjects`'s when the host sets `videokitSubjects = false`, which leaves ML Kit's segmenter out
 * of the app altogether (see `build.gradle`). Everything ML Kit is here, so the rest of [SubjectFinder]
 * compiles either way.
 *
 * The segmenter finds PEOPLE - one mask of everybody, a confidence per pixel - and nothing else, which
 * is why every subject Android finds is a `person`, and why two people are told apart only where they
 * do not touch ([SubjectTracker.componentsOf]).
 */
internal class SubjectSegmenter(stream: Boolean) : AutoCloseable {

    companion object {
        /** Whether this build has an engine at all. */
        const val AVAILABLE = true

        /** Where ML Kit's answers are read: on the thread it answers on, without a hop to the main one. */
        private val DIRECT = Executor { it.run() }
    }

    /**
     * STREAM mode for a video's frames, handed over in order, which ML Kit smooths each mask against the
     * ones before; SINGLE_IMAGE mode for a picture, which has no frames before it. The mask comes back
     * at the size of the picture it was shown, not the model's raw 256 x 256: the same picture, so the
     * grid is read off it as off the frame, whatever the model does inside.
     */
    private val client: Segmenter = Segmentation.getClient(
        SelfieSegmenterOptions.Builder()
            .setDetectorMode(if (stream) SelfieSegmenterOptions.STREAM_MODE else SelfieSegmenterOptions.SINGLE_IMAGE_MODE)
            .build(),
    )

    /**
     * The foreground confidence of every pixel of [bitmap], which has to be upright: the model was
     * trained on people standing up. Takes [bitmap] over and recycles it once ML Kit has finished with
     * it - not before, whatever happens to the answer meanwhile, because ML Kit reads it on its own
     * thread. Never throws: a failure is the answer's.
     */
    fun segment(bitmap: Bitmap): ListenableFuture<ConfidenceMask> {
        val answer = SettableFuture.create<ConfidenceMask>()
        try {
            client.process(InputImage.fromBitmap(bitmap, 0)).addOnCompleteListener(DIRECT) { task ->
                try {
                    if (task.isSuccessful) {
                        answer.set(read(task.result))
                    } else {
                        answer.setException(task.exception ?: IllegalStateException("the segmenter gave no answer"))
                    }
                } catch (e: Exception) {
                    answer.setException(e)
                } finally {
                    bitmap.recycle()
                }
            }
        } catch (e: Exception) {
            bitmap.recycle()
            answer.setException(e)
        }
        return answer
    }

    /** The mask's floats copied out, row by row from the top-left, before ML Kit reuses its buffer. */
    private fun read(mask: SegmentationMask): ConfidenceMask {
        val values = FloatArray(mask.width * mask.height)
        val buffer = mask.buffer
        buffer.rewind()
        buffer.asFloatBuffer().get(values)
        return ConfidenceMask(mask.width, mask.height, values)
    }

    override fun close() = client.close()
}
