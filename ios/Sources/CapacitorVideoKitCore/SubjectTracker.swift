import Foundation

/// How a footage's subjects are followed from frame to frame: a line-for-line port of
/// `src/video-composer/web/subject-tracker.ts`, so a subject is the same subject - the same id, the
/// same main one - whichever engine looked. `SubjectTrackerTests` runs the reference's cases.
///
/// A segmenter hands over, for each frame on its own, the instances it sees: Vision's foreground
/// masks number them 1...n in an order of their own, and its person segmentation gives one mask of
/// everybody that `componentsOf` splits into the people who do not touch. Nothing says that instance 2
/// of one frame is instance 2 of the next. The tracker says it, by overlap.
///
/// THE RULES, which every port keeps exactly:
///
///  - An instance smaller than `minInstanceCells` of the grid is a speck and is background.
///  - A frame's instances are matched to the subjects seen within the last `forgetAfterMs`, by the
///    intersection over union of the instance's cells and the cells the subject had the last time it
///    was seen. Every pair at or above `minIoU` is a candidate; the best pair is matched first, then
///    the best of what is left - greedily, one instance to one subject. An instance left over starts a
///    new subject. Ties go to the lower instance index, then the older subject.
///  - A subject not seen for longer than `forgetAfterMs` is not matched again.
///  - At the end, a subject seen in fewer than `min(frames, 3)` frames, or covering less than
///    `minMeanArea` of the frame on average while it is seen, was noise and becomes background. The
///    rest are ranked by the cells they covered over the whole footage, and the first `maxSubjects`
///    become ids 1, 2, 3... in that order. So id 1 is the main subject.
enum SubjectTracking {
    /// Below this intersection over union, an instance is not the subject it overlaps.
    static let minIoU = 0.2
    /// A subject unseen for longer than this is never matched again.
    static let forgetAfterMs = 1000.0
    /// A subject smaller than this on average, a fraction of the frame, was noise.
    static let minMeanArea = 0.005
    /// `SUBJECT_GRID`: the longer side of a track's grid, in cells.
    static let gridCells = 320
    /// `MAX_SUBJECTS`: the most subjects a track keeps, strongest first.
    static let maxSubjects = 8

    /// The fewest cells an instance may have, out of `cells`: 0.2% of the grid, and never under four.
    static func minInstanceCells(_ cells: Int) -> Int {
        max(4, Int((0.002 * Double(cells)).rounded(.up)))
    }

    /// The grid for an oriented frame of `width` x `height`: `gridCells` on the longer side and the
    /// other in proportion, rounded, at least one.
    static func subjectGrid(width: Double, height: Double) -> (width: Int, height: Int) {
        guard width > 0, height > 0 else { return (gridCells, gridCells) }
        if width >= height {
            return (gridCells, max(1, Int(jsRound(Double(gridCells) * height / width))))
        }
        return (max(1, Int(jsRound(Double(gridCells) * width / height))), gridCells)
    }

    /// A segmenter's map of a frame brought onto the grid: each cell takes the value of the mask's
    /// pixel under its CENTRE, nearest neighbour - an instance number, kept as it is, or a confidence,
    /// which is foreground (1) at `threshold` and above. The mask covers the whole oriented frame,
    /// stretched to whatever size the engine made it (Vision's instance masks are square whatever the
    /// picture). `value(x, y)` reads the mask's pixel, so a buffer with padded rows is read in place.
    static func toGrid(maskWidth: Int, maskHeight: Int, gridWidth: Int, gridHeight: Int, threshold: Double? = nil,
                       into grid: inout [UInt8], value: (_ x: Int, _ y: Int) -> Double) {
        if grid.count != gridWidth * gridHeight { grid = [UInt8](repeating: 0, count: gridWidth * gridHeight) }
        for gy in 0..<gridHeight {
            let my = min(maskHeight - 1, Int(((Double(gy) + 0.5) * Double(maskHeight) / Double(gridHeight)).rounded(.down)))
            for gx in 0..<gridWidth {
                let mx = min(maskWidth - 1, Int(((Double(gx) + 0.5) * Double(maskWidth) / Double(gridWidth)).rounded(.down)))
                let v = value(mx, my)
                if let threshold {
                    grid[gy * gridWidth + gx] = v >= threshold ? 1 : 0
                } else {
                    let r = jsRound(v)
                    grid[gy * gridWidth + gx] = r.isFinite ? UInt8(min(255, max(0, r))) : 0
                }
            }
        }
    }

    /// `toGrid` for a mask held as a plain array, row by row - what the tests hand it.
    static func toGrid(_ mask: [Double], maskWidth: Int, maskHeight: Int, gridWidth: Int, gridHeight: Int,
                       threshold: Double? = nil) -> [UInt8] {
        var grid = [UInt8](repeating: 0, count: gridWidth * gridHeight)
        toGrid(maskWidth: maskWidth, maskHeight: maskHeight, gridWidth: gridWidth, gridHeight: gridHeight,
               threshold: threshold, into: &grid) { x, y in mask[y * maskWidth + x] }
        return grid
    }

    /// The foreground cells of a grid (any value but 0) split into the groups that touch, sides or
    /// corners, numbered 1, 2, 3... in the order a row-by-row scan from the top-left first meets them.
    /// Groups smaller than `minInstanceCells` are background; past 254 groups the rest are too. Writes
    /// the numbers over `grid` and answers how many there are.
    @discardableResult
    static func componentsOf(_ grid: inout [UInt8], width: Int, height: Int) -> Int {
        let cells = width * height
        var labels = [Int32](repeating: 0, count: cells)
        var stack = [Int32](repeating: 0, count: cells)
        let min = minInstanceCells(cells)
        var next: Int32 = 0
        var sizes: [Int] = [0]
        for start in 0..<cells {
            if grid[start] == 0 || labels[start] != 0 { continue }
            next += 1
            let label = next
            var size = 0
            var top = 0
            stack[top] = Int32(start)
            top += 1
            labels[start] = label
            while top > 0 {
                top -= 1
                let at = Int(stack[top])
                size += 1
                let x = at % width
                let y = at / width
                for dy in -1...1 {
                    let ny = y + dy
                    if ny < 0 || ny >= height { continue }
                    for dx in -1...1 {
                        let nx = x + dx
                        if (dx == 0 && dy == 0) || nx < 0 || nx >= width { continue }
                        let n = ny * width + nx
                        if grid[n] != 0 && labels[n] == 0 {
                            labels[n] = label
                            stack[top] = Int32(n)
                            top += 1
                        }
                    }
                }
            }
            sizes.append(size)
        }
        // Kept groups renumbered in scan order, specks and anything past 254 made background.
        var renumber = [UInt8](repeating: 0, count: Int(next) + 1)
        var kept = 0
        if next > 0 {
            for label in 1...Int(next) where sizes[label] >= min && kept < 254 {
                kept += 1
                renumber[label] = UInt8(kept)
            }
        }
        for c in 0..<cells { grid[c] = labels[c] == 0 ? 0 : renumber[Int(labels[c])] }
        return kept
    }
}

/// Follows the subjects through the frames handed to `add`, in time order, and hands back the subject
/// track's content at `finish`. The frames are kept coded as they come, with provisional ids, so a
/// minute of footage costs the runs and not nine hundred grids.
final class SubjectTracker {
    /// One subject being followed. A class, as the reference's objects are references: a match holds
    /// the subject it was matched to, and seeing it updates the one in `followed`.
    private final class Followed {
        /// Provisional, in the order subjects were first seen; `finish` ranks them.
        let id: Int
        /// The cells it covered when it was last seen, and a mark for each, for the overlap.
        var cells: [Int32] = []
        var marks: [UInt8]
        var lastSeenMs: Double
        let firstSeenMs: Double
        var frames = 0
        /// Cells covered over every frame it was seen in.
        var total = 0
        var peakCells = 0
        var peakMs: Double
        /// Its box where it was largest, in cells: min x, min y, max x, max y.
        var peakBox: (Int, Int, Int, Int) = (0, 0, 0, 0)

        init(id: Int, cells: Int, timeMs: Double) {
            self.id = id
            marks = [UInt8](repeating: 0, count: cells)
            lastSeenMs = timeMs
            firstSeenMs = timeMs
            peakMs = timeMs
        }
    }

    /// An instance of the frame being added: its cells, and its box.
    private struct Instance {
        let cells: [Int32]
        let box: (Int, Int, Int, Int)
    }

    let width: Int
    let height: Int
    private let cells: Int
    private let min: Int
    private var followed: [Followed] = []
    private var forgotten: [Followed] = []
    private var nextId = 1
    private var times: [Double] = []
    private var coded: [[UInt8]] = []

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        cells = width * height
        min = SubjectTracking.minInstanceCells(cells)
    }

    /// How many frames have been added.
    var frames: Int { times.count }

    /// One analysed frame: its source time, later than the last one's, and its grid of instances - 0
    /// background, 1...`count` an instance in any order. The grid is read, never kept.
    func add(timeMs: Double, instances: [UInt8], count: Int) {
        let found = instancesOf(instances, count: count)
        // Forget whoever has been gone too long, before anybody is matched to them. Their marks go with
        // them: a subject forgotten is never matched again, and only its numbers are read at the end.
        for i in stride(from: followed.count - 1, through: 0, by: -1)
        where timeMs - followed[i].lastSeenMs > SubjectTracking.forgetAfterMs {
            let gone = followed.remove(at: i)
            gone.marks = []
            forgotten.append(gone)
        }

        // Every pair close enough, best first: the overlap of an instance's cells with a subject's marks.
        var pairs: [(instance: Int, subject: Int, iou: Double)] = []
        for (j, instance) in found.enumerated() {
            for (k, subject) in followed.enumerated() {
                var overlap = 0
                for c in instance.cells { overlap += Int(subject.marks[Int(c)]) }
                if overlap == 0 { continue }
                let iou = Double(overlap) / Double(instance.cells.count + subject.cells.count - overlap)
                if iou >= SubjectTracking.minIoU { pairs.append((j, k, iou)) }
            }
        }
        pairs.sort { a, b in
            if a.iou != b.iou { return a.iou > b.iou }
            if a.instance != b.instance { return a.instance < b.instance }
            return a.subject < b.subject
        }

        var owner = [Followed?](repeating: nil, count: found.count)
        var taken = Set<Int>()
        for pair in pairs {
            if owner[pair.instance] != nil || taken.contains(pair.subject) { continue }
            owner[pair.instance] = followed[pair.subject]
            taken.insert(pair.subject)
        }

        // Provisional ids as 32-bit numbers. The reference keeps them in a Uint16Array, which would
        // wrap a footage that starts more than 65535 subjects; no answer this can give differs short of
        // that, and past it this one is the right one.
        var ids = [UInt32](repeating: 0, count: cells)
        for (j, instance) in found.enumerated() {
            let subject = owner[j] ?? start(timeMs)
            see(subject, instance, timeMs)
            for c in instance.cells { ids[Int(c)] = UInt32(subject.id) }
        }
        times.append(timeMs)
        coded.append(SubjectTracker.codeIds(ids))
    }

    /// The track's content: the subjects that were not noise, ranked and numbered, every frame's cells
    /// renumbered to match, and what a reader lists them by.
    func finish(engine: String, kind: String, durationMs: Double, fps: Double, subjectKind: String) -> SubjectTrackContent {
        let frames = times.count
        let everyone = forgotten + followed
        let lasting = Swift.min(frames, 3)
        let kept = Array(everyone
            .filter { $0.frames >= lasting && Double($0.total) / Double($0.frames) / Double(cells) >= SubjectTracking.minMeanArea }
            .sorted { $0.total != $1.total ? $0.total > $1.total : $0.id < $1.id }
            .prefix(SubjectTracking.maxSubjects))
        var finalId: [UInt32: UInt8] = [:]
        for (i, subject) in kept.enumerated() { finalId[UInt32(subject.id)] = UInt8(i + 1) }

        let grids = coded.map { coded -> [UInt8] in
            let ids = SubjectTracker.decodeIds(coded, cells: cells)
            var out = [UInt8](repeating: 0, count: cells)
            for c in 0..<cells where ids[c] != 0 { out[c] = finalId[ids[c]] ?? 0 }
            return out
        }

        let subjects = kept.enumerated().map { i, subject -> SubjectInfo in
            let (x0, y0, x1, y1) = subject.peakBox
            return SubjectInfo(id: i + 1,
                               kind: subjectKind,
                               startMs: subject.firstSeenMs,
                               endMs: subject.lastSeenMs,
                               peakMs: subject.peakMs,
                               box: SubjectBox(x: round4(Double(x0) / Double(width)),
                                               y: round4(Double(y0) / Double(height)),
                                               w: round4(Double(x1 - x0 + 1) / Double(width)),
                                               h: round4(Double(y1 - y0 + 1) / Double(height))),
                               area: round4(Double(subject.total) / Double(subject.frames) / Double(cells)))
        }

        return SubjectTrackContent(width: width, height: height, times: times, frames: grids,
                                   meta: SubjectTrackMeta(engine: engine, kind: kind, durationMs: jsRound(durationMs),
                                                          fps: fps, subjects: subjects))
    }

    /// The frame's instances big enough to be somebody, each with its cells and its box.
    private func instancesOf(_ grid: [UInt8], count: Int) -> [Instance] {
        guard count > 0 else { return [] }
        var sizes = [Int](repeating: 0, count: count + 1)
        for c in 0..<cells where Int(grid[c]) <= count { sizes[Int(grid[c])] += 1 }
        var lists: [[Int32]?] = [nil]
        var boxes: [(Int, Int, Int, Int)] = [(0, 0, 0, 0)]
        for n in 1...count {
            lists.append(sizes[n] >= min ? [] : nil)
            boxes.append((width, height, -1, -1))
        }
        for n in 1...count where lists[n] != nil { lists[n]?.reserveCapacity(sizes[n]) }
        for c in 0..<cells {
            let n = Int(grid[c])
            guard n > 0, n <= count, lists[n] != nil else { continue }
            lists[n]?.append(Int32(c))
            let x = c % width
            let y = c / width
            var box = boxes[n]
            if x < box.0 { box.0 = x }
            if y < box.1 { box.1 = y }
            if x > box.2 { box.2 = x }
            if y > box.3 { box.3 = y }
            boxes[n] = box
        }
        var out: [Instance] = []
        for n in 1...count { if let list = lists[n] { out.append(Instance(cells: list, box: boxes[n])) } }
        return out
    }

    private func start(_ timeMs: Double) -> Followed {
        let subject = Followed(id: nextId, cells: cells, timeMs: timeMs)
        nextId += 1
        followed.append(subject)
        return subject
    }

    private func see(_ subject: Followed, _ instance: Instance, _ timeMs: Double) {
        for c in subject.cells { subject.marks[Int(c)] = 0 }
        for c in instance.cells { subject.marks[Int(c)] = 1 }
        subject.cells = instance.cells
        subject.lastSeenMs = timeMs
        subject.frames += 1
        subject.total += instance.cells.count
        if instance.cells.count > subject.peakCells {
            subject.peakCells = instance.cells.count
            subject.peakMs = timeMs
            subject.peakBox = instance.box
        }
    }

    /// A frame of provisional ids as runs of (id, run), both unsigned LEB128: the tracker's own, never
    /// written to a file.
    private static func codeIds(_ ids: [UInt32]) -> [UInt8] {
        var out: [UInt8] = []
        func varint(_ value: Int) {
            var rest = value
            while rest >= 0x80 {
                out.append(UInt8(rest & 0x7f) | 0x80)
                rest >>= 7
            }
            out.append(UInt8(rest))
        }
        var i = 0
        while i < ids.count {
            let value = ids[i]
            var run = 1
            while i + run < ids.count && ids[i + run] == value { run += 1 }
            varint(Int(value))
            varint(run)
            i += run
        }
        return out
    }

    private static func decodeIds(_ coded: [UInt8], cells: Int) -> [UInt32] {
        var ids = [UInt32](repeating: 0, count: cells)
        var at = 0
        var filled = 0
        func varint() -> Int {
            var value = 0
            var shift = 0
            while at < coded.count {
                let byte = coded[at]
                at += 1
                value |= Int(byte & 0x7f) << shift
                if byte < 0x80 { break }
                shift += 7
            }
            return value
        }
        while at < coded.count && filled < cells {
            let value = UInt32(truncatingIfNeeded: varint())
            let run = Swift.min(varint(), cells - filled)
            for c in filled..<(filled + run) { ids[c] = value }
            filled += run
        }
        return ids
    }

    private func round4(_ value: Double) -> Double { jsRound(value * 10_000) / 10_000 }
}
