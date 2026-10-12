package net.dotnetdreamer.videokit.videocomposer

import kotlin.math.ceil
import kotlin.math.floor
import kotlin.math.max
import kotlin.math.min

/**
 * How a footage's subjects are followed from frame to frame: the Android port of the reference in
 * `src/video-composer/web/subject-tracker.ts`, line for line, so a subject is the same subject - the
 * same id, the same main one - whichever engine looked. Its rules, and why each is what it is, are
 * written out there; [SubjectTrackerTest] holds this port to the reference's own cases.
 *
 * A segmenter hands over, for each frame on its own, the instances it sees - ML Kit's selfie
 * segmentation one mask of everybody, which [componentsOf] splits into the people who do not touch -
 * and nothing says that instance 2 of one frame is instance 2 of the next. The tracker says it, by
 * overlap: an instance that covers most of what a subject covered when it was last seen IS that
 * subject, and one that covers nothing anybody covered is somebody new.
 *
 * THE RULES, kept exactly:
 *
 *  - An instance smaller than [minInstanceCells] of the grid is a speck and is background.
 *  - A frame's instances are matched to the subjects seen within the last [FORGET_AFTER_MS], by the
 *    intersection over union of the instance's cells and the cells the subject had when last seen.
 *    Every pair at or above [MIN_IOU] is a candidate; the best pair is matched first, then the best of
 *    what is left - greedily, one instance to one subject. An instance left over starts a new subject.
 *    Ties go to the lower instance index, then the older subject.
 *  - A subject not seen for longer than [FORGET_AFTER_MS] is not matched again.
 *  - At the end, a subject seen in fewer than `min(frames, 3)` frames, or covering less than
 *    [MIN_MEAN_AREA] of the frame on average while it is seen, was noise and becomes background. The
 *    rest are ranked by the cells they covered over the whole footage, and the first [MAX_SUBJECTS]
 *    become ids 1, 2, 3... in that order. So id 1 is the main subject.
 *
 * The frames are kept coded as they come, with provisional ids, so a minute of footage costs the runs
 * and not hundreds of grids. Not thread-safe: one search feeds one tracker, in time order.
 */
class SubjectTracker(val width: Int, val height: Int) {

    private val cells = width * height
    private val min = minInstanceCells(cells)
    private val followed = ArrayList<Followed>()
    private val forgotten = ArrayList<Followed>()
    private var nextId = 1
    private val times = ArrayList<Long>()
    private val coded = ArrayList<ByteArray>()

    /** How many frames have been added. */
    val frames: Int get() = times.size

    /**
     * One analysed frame: its source time, later than the last one's, and its grid of instances - 0
     * background, 1..[count] an instance in any order. The grid is read, never kept.
     */
    fun add(timeMs: Long, instances: ByteArray, count: Int) {
        val found = instancesOf(instances, count)
        // Forget whoever has been gone too long, before anybody is matched to them.
        for (i in followed.indices.reversed()) {
            if (timeMs - followed[i].lastSeenMs > FORGET_AFTER_MS) forgotten += followed.removeAt(i)
        }

        // Every pair close enough, best first: the overlap of an instance's cells with a subject's marks.
        val pairs = ArrayList<Pairing>()
        found.forEachIndexed { j, instance ->
            followed.forEachIndexed { k, subject ->
                var overlap = 0
                for (c in instance.cells) overlap += subject.marks[c]
                if (overlap == 0) return@forEachIndexed
                val iou = overlap.toDouble() / (instance.cells.size + subject.cells.size - overlap)
                if (iou >= MIN_IOU) pairs += Pairing(j, k, iou)
            }
        }
        pairs.sortWith(compareByDescending<Pairing> { it.iou }.thenBy { it.instance }.thenBy { it.subject })

        val owner = arrayOfNulls<Followed>(found.size)
        val taken = HashSet<Int>()
        for (pair in pairs) {
            if (owner[pair.instance] != null || pair.subject in taken) continue
            owner[pair.instance] = followed[pair.subject]
            taken += pair.subject
        }

        val ids = IntArray(cells)
        found.forEachIndexed { j, instance ->
            val subject = owner[j] ?: start(timeMs)
            see(subject, instance, timeMs)
            for (c in instance.cells) ids[c] = subject.id
        }
        times += timeMs
        coded += codeIds(ids)
    }

    /**
     * The track's content: the subjects that were not noise, ranked and numbered, every frame's cells
     * renumbered to match, and what a reader lists them by.
     */
    fun finish(engine: String, kind: MediaLabels.Kind, durationMs: Long, fps: Double, subjectKind: String): SubjectTrackContent {
        val frames = times.size
        val everyone = forgotten + followed
        val lasting = min(frames, 3)
        val kept = everyone
            .filter { it.frames >= lasting && it.total.toDouble() / it.frames / cells >= MIN_MEAN_AREA }
            .sortedWith(compareByDescending<Followed> { it.total }.thenBy { it.id })
            .take(MAX_SUBJECTS)
        val finalId = HashMap<Int, Int>()
        kept.forEachIndexed { i, subject -> finalId[subject.id] = i + 1 }

        val grids = coded.map { frame ->
            val ids = decodeIds(frame, cells)
            ByteArray(cells) { c -> if (ids[c] == 0) 0 else (finalId[ids[c]] ?: 0).toByte() }
        }

        val subjects = kept.mapIndexed { i, subject ->
            val (x0, y0, x1, y1) = subject.peakBox
            SubjectInfo(
                id = i + 1,
                kind = subjectKind,
                startMs = subject.firstSeenMs,
                endMs = subject.lastSeenMs,
                peakMs = subject.peakMs,
                box = SubjectBox(
                    x = round4(x0.toDouble() / width),
                    y = round4(y0.toDouble() / height),
                    w = round4((x1 - x0 + 1).toDouble() / width),
                    h = round4((y1 - y0 + 1).toDouble() / height),
                ),
                area = round4(subject.total.toDouble() / subject.frames / cells),
            )
        }

        return SubjectTrackContent(
            width = width,
            height = height,
            times = times.toList(),
            frames = grids,
            meta = SubjectTrackMeta(engine, kind, durationMs, fps, subjects),
        )
    }

    /** The frame's instances big enough to be somebody, each with its cells and its box. */
    private fun instancesOf(grid: ByteArray, count: Int): List<Instance> {
        if (count <= 0) return emptyList()
        val sizes = IntArray(count + 1)
        for (c in 0 until cells) {
            val n = grid[c].toInt() and 0xff
            if (n <= count) sizes[n]++
        }
        val lists = arrayOfNulls<IntArray>(count + 1)
        val boxes = arrayOfNulls<IntArray>(count + 1)
        for (n in 1..count) {
            lists[n] = if (sizes[n] >= min) IntArray(sizes[n]) else null
            boxes[n] = intArrayOf(width, height, -1, -1)
        }
        val filled = IntArray(count + 1)
        for (c in 0 until cells) {
            val n = grid[c].toInt() and 0xff
            val list = if (n in 1..count) lists[n] else null
            if (list == null) continue
            list[filled[n]++] = c
            val x = c % width
            val y = (c - x) / width
            val box = boxes[n]!!
            if (x < box[0]) box[0] = x
            if (y < box[1]) box[1] = y
            if (x > box[2]) box[2] = x
            if (y > box[3]) box[3] = y
        }
        val out = ArrayList<Instance>()
        for (n in 1..count) lists[n]?.let { out += Instance(it, boxes[n]!!) }
        return out
    }

    private fun start(timeMs: Long): Followed {
        val subject = Followed(id = nextId++, marks = ByteArray(cells), firstSeenMs = timeMs, lastSeenMs = timeMs, peakMs = timeMs)
        followed += subject
        return subject
    }

    private fun see(subject: Followed, instance: Instance, timeMs: Long) {
        for (c in subject.cells) subject.marks[c] = 0
        for (c in instance.cells) subject.marks[c] = 1
        subject.cells = instance.cells
        subject.lastSeenMs = timeMs
        subject.frames++
        subject.total += instance.cells.size
        if (instance.cells.size > subject.peakCells) {
            subject.peakCells = instance.cells.size
            subject.peakMs = timeMs
            subject.peakBox = instance.box.copyOf()
        }
    }

    /** One subject being followed. */
    private class Followed(
        /** Provisional, in the order subjects were first seen; [finish] ranks them. */
        val id: Int,
        /** A mark for each cell it covered when it was last seen, for the overlap. */
        val marks: ByteArray,
        val firstSeenMs: Long,
        var lastSeenMs: Long,
        var peakMs: Long,
    ) {
        /** The cells it covered when it was last seen. */
        var cells: IntArray = IntArray(0)
        var frames = 0

        /** Cells covered over every frame it was seen in: a long, since a long video adds up past an int. */
        var total = 0L
        var peakCells = 0

        /** Its box where it was largest, in cells: min x, min y, max x, max y. */
        var peakBox: IntArray = IntArray(4)
    }

    /** An instance of the frame being added: its cells, and its box. */
    private class Instance(val cells: IntArray, val box: IntArray)

    /** An instance and a subject close enough to be the same, and how close. */
    private class Pairing(val instance: Int, val subject: Int, val iou: Double)

    companion object {
        /** Below this intersection over union, an instance is not the subject it overlaps. */
        const val MIN_IOU = 0.2

        /** A subject unseen for longer than this is never matched again. */
        const val FORGET_AFTER_MS = 1000L

        /** A subject smaller than this on average, a fraction of the frame, was noise. */
        const val MIN_MEAN_AREA = 0.005

        /** `SUBJECT_GRID`: the longer side of a track's grid, in cells. */
        const val SUBJECT_GRID = 320

        /** `MAX_SUBJECTS`: the most subjects a track keeps, strongest first. More are background. */
        const val MAX_SUBJECTS = 8

        /** The most instances [componentsOf] numbers: one byte a cell, 0 being the background. */
        private const val MAX_INSTANCES = 254

        /** The fewest cells an instance may have, out of [cells]: 0.2% of the grid, and never under four. */
        fun minInstanceCells(cells: Int): Int = max(4, ceil(0.002 * cells).toInt())

        /**
         * The grid for an oriented frame of [width] x [height]: [SUBJECT_GRID] cells on the longer side
         * and the other in proportion, rounded, at least one. Answered as (width, height).
         */
        fun subjectGrid(width: Int, height: Int): Pair<Int, Int> {
            if (width <= 0 || height <= 0) return SUBJECT_GRID to SUBJECT_GRID
            if (width >= height) return SUBJECT_GRID to max(1, Math.round((SUBJECT_GRID * height).toDouble() / width).toInt())
            return max(1, Math.round((SUBJECT_GRID * width).toDouble() / height).toInt()) to SUBJECT_GRID
        }

        /**
         * A segmenter's map of a frame brought onto the grid: each cell takes the value of the mask's
         * pixel under its CENTRE, nearest neighbour - an instance number, kept as it is, or with a
         * [threshold] a confidence, which is foreground (1) at the threshold and above. The mask covers
         * the whole oriented frame, stretched to whatever size the engine made it.
         */
        fun toGrid(
            mask: FloatArray,
            maskWidth: Int,
            maskHeight: Int,
            grid: ByteArray,
            gridWidth: Int,
            gridHeight: Int,
            threshold: Float? = null,
        ): ByteArray {
            for (gy in 0 until gridHeight) {
                val my = min(maskHeight - 1, floor((gy + 0.5) * maskHeight / gridHeight).toInt())
                for (gx in 0 until gridWidth) {
                    val mx = min(maskWidth - 1, floor((gx + 0.5) * maskWidth / gridWidth).toInt())
                    val value = mask[my * maskWidth + mx]
                    grid[gy * gridWidth + gx] = if (threshold == null) {
                        min(255L, max(0L, Math.round(value.toDouble()))).toInt().toByte()
                    } else if (value >= threshold) {
                        1
                    } else {
                        0
                    }
                }
            }
            return grid
        }

        /**
         * The foreground cells of a grid (any value but 0) split into the groups that touch, sides or
         * corners, numbered 1, 2, 3... in the order a row-by-row scan from the top-left first meets
         * them. Groups smaller than [minInstanceCells] are background; past 254 groups the rest are
         * too. Writes the numbers over [grid] and answers how many there are.
         */
        fun componentsOf(grid: ByteArray, width: Int, height: Int): Int {
            val cells = width * height
            val labels = IntArray(cells)
            val stack = IntArray(cells)
            val min = minInstanceCells(cells)
            var next = 0
            val sizes = arrayListOf(0)
            for (start in 0 until cells) {
                if (grid[start].toInt() == 0 || labels[start] != 0) continue
                val label = ++next
                var size = 0
                var top = 0
                stack[top++] = start
                labels[start] = label
                while (top > 0) {
                    val at = stack[--top]
                    size++
                    val x = at % width
                    val y = (at - x) / width
                    for (dy in -1..1) {
                        val ny = y + dy
                        if (ny < 0 || ny >= height) continue
                        for (dx in -1..1) {
                            val nx = x + dx
                            if ((dx == 0 && dy == 0) || nx < 0 || nx >= width) continue
                            val n = ny * width + nx
                            if (grid[n].toInt() != 0 && labels[n] == 0) {
                                labels[n] = label
                                stack[top++] = n
                            }
                        }
                    }
                }
                sizes += size
            }
            // Kept groups renumbered in scan order, specks and anything past 254 made background.
            val renumber = IntArray(next + 1)
            var kept = 0
            for (label in 1..next) if (sizes[label] >= min && kept < MAX_INSTANCES) renumber[label] = ++kept
            for (c in 0 until cells) grid[c] = if (labels[c] == 0) 0 else renumber[labels[c]].toByte()
            return kept
        }

        /** A frame of provisional ids as runs of (id, run), both unsigned LEB128: the tracker's own, never written to a file. */
        private fun codeIds(ids: IntArray): ByteArray {
            val out = java.io.ByteArrayOutputStream(64)
            fun varint(value: Int) {
                var rest = value
                while (rest >= 0x80) {
                    out.write((rest and 0x7f) or 0x80)
                    rest = rest ushr 7
                }
                out.write(rest)
            }
            var i = 0
            while (i < ids.size) {
                val value = ids[i]
                var run = 1
                while (i + run < ids.size && ids[i + run] == value) run++
                varint(value)
                varint(run)
                i += run
            }
            return out.toByteArray()
        }

        private fun decodeIds(coded: ByteArray, cells: Int): IntArray {
            val ids = IntArray(cells)
            var at = 0
            var filled = 0
            fun varint(): Int {
                var value = 0
                var shift = 0
                while (true) {
                    val byte = coded[at++].toInt() and 0xff
                    value = value or ((byte and 0x7f) shl shift)
                    if (byte < 0x80) return value
                    shift += 7
                }
            }
            while (at < coded.size && filled < cells) {
                val value = varint()
                val run = varint()
                ids.fill(value, filled, filled + run)
                filled += run
            }
            return ids
        }

        private fun round4(value: Double): Double = Math.round(value * 10_000) / 10_000.0
    }
}
