import Foundation

/// A matte track, the file `findMatte` writes: how sure the segmenter was, cell by cell and frame by
/// frame, that the footage's subject is there. `MATTE_TRACK_MAGIC` in `definitions.ts` has the layout;
/// this is a port of `src/editor/matte-track.ts`, its reader and its writer, function for function and
/// with the same refusals in the same words, as `MatteTrack.kt` is on Android. The three engines read
/// each other's answers to the byte - the editor's preview reads the file this side writes - and
/// `MatteTrackTests` holds this one to the cases of `matte-track.unit.test.ts` and `MatteTrackTest.kt`.
///
/// Read in two halves, as a subject track is (`SubjectTrack`): the header, the times and the frame
/// offsets at once, so a file that is not a matte track is refused when it is opened - in the render's
/// pre-flight (`CutoutTracks`), before a codec is opened - and a frame only when it is drawn, a few
/// kept, because a minute of footage is six hundred grids and a frame of the render needs two of them.
///
/// What a frame IS to a picture is `matteAt`: the grid at one instant, the two frames either side mixed
/// - the contract's step 2 - which `CutoutClip` refines against the frame.

/// What `MatteTrack.parse` refuses, and what decoding a damaged frame throws. The words are the
/// reference's, so a refusal reads the same from every engine.
struct MatteTrackError: Error, CustomStringConvertible, Equatable {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Where the subject is over the whole footage: a `ComposeRect`, 0...1 of the oriented frame, top-left
/// origin.
struct MatteBox: Equatable, Sendable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

/// The JSON after a track's header: the `FindMatteResult` fields a reader that shows a matte needs. A
/// renderer never reads it.
struct MatteTrackMeta: Equatable, Sendable {
    let engine: String
    /// `video` or `image`.
    let kind: String
    /// `subject` or `people`: what the track keeps, which is `people` wherever the engine found only
    /// people, whatever was asked.
    let target: String
    let durationMs: Double
    let fps: Double
    /// 0...1, averaged over the frames.
    let coverage: Double
    /// nil with a `coverage` of 0.
    let box: MatteBox?
}

/// What `MatteTrack.encode` writes: the grid, every frame's time and cells, and the JSON.
struct MatteTrackContent: Equatable, Sendable {
    let width: Int
    let height: Int
    /// Source ms, strictly increasing once rounded, one per frame.
    let times: [Double]
    /// `width * height` certainties each, 0...255, row by row from the top-left.
    let frames: [[UInt8]]
    let meta: MatteTrackMeta
}

/// A track's parts with its frames already coded (`MatteTrack.encodePackets`): what a video's search
/// keeps as it goes, a few kilobytes a frame where the raw grids would be most of a megabyte - Android's
/// `MatteTracks.Coded`.
struct MatteTrackCoded: Sendable {
    let width: Int
    let height: Int
    /// Source ms, strictly increasing once rounded, one per frame.
    let times: [Double]
    /// Each frame's packets, as `encodePackets` codes them.
    let packets: [[UInt8]]
    let meta: MatteTrackMeta
}

final class MatteTrack: @unchecked Sendable {
    /// `MATTE_TRACK_MAGIC` and `MATTE_TRACK_VERSION`.
    static let magic: [UInt8] = Array("VKMT".utf8)
    static let version: UInt8 = 1
    /// Where the JSON starts.
    static let headerBytes = 20
    /// The most cells a grid may have: the layout's ceiling, 2048 squared.
    static let maxCells = 4_194_304
    /// Frames kept decoded: the pair a moment is drawn between, and the pair either side of a seek.
    static let keptFrames = 6
    /// The shortest repeat a run packet is worth: two bytes of packet for three or more cells.
    static let minRun = 3
    /// A cell at this certainty or above is the subject's, for `MatteSummary`: the segmenter's even odds.
    static let subjectAt: UInt8 = 128

    let width: Int
    let height: Int
    /// Each frame's source time, ms, strictly increasing.
    let times: [UInt32]
    /// The JSON, or nil where it was missing or would not parse: a renderer never needs it.
    let meta: MatteTrackMeta?

    private let bytes: [UInt8]
    private let offsets: [UInt32]
    private let dataStart: Int

    /// The decoded frames last asked for, oldest first. Behind `lock`: a track is shared by every clip
    /// cut out from the same file, and is drawn from the compositor's queue.
    private let lock = NSLock()
    private var kept: [(index: Int, cells: [UInt8])] = []
    private var decodeCount = 0

    private init(width: Int, height: Int, times: [UInt32], meta: MatteTrackMeta?, bytes: [UInt8],
                 offsets: [UInt32], dataStart: Int) {
        self.width = width
        self.height = height
        self.times = times
        self.meta = meta
        self.bytes = bytes
        self.offsets = offsets
        self.dataStart = dataStart
    }

    var frameCount: Int { times.count }

    /// How many frames have been decoded rather than answered from the kept ones. TESTS ONLY.
    var decodes: Int {
        lock.lock()
        defer { lock.unlock() }
        return decodeCount
    }

    /// One frame's cells, `width * height` certainties row by row from the top-left. The array is a
    /// copy the caller may change. Throws `MatteTrackError` for an index the track does not have and
    /// for a frame whose packets do not fill the grid exactly.
    func frame(_ index: Int) throws -> [UInt8] {
        lock.lock()
        defer { lock.unlock() }
        if let at = kept.firstIndex(where: { $0.index == index }) {
            // Most recently used goes last, so the first entry is always the one to let go of.
            let hit = kept.remove(at: at)
            kept.append(hit)
            return hit.cells
        }
        let (start, end) = try range(of: index)
        var cells = [UInt8](repeating: 0, count: width * height)
        try MatteTrack.decodePackets(bytes, start: start, end: end, into: &cells)
        decodeCount += 1
        kept.append((index, cells))
        if kept.count > MatteTrack.keptFrames { kept.removeFirst() }
        return cells
    }

    /// Decodes every frame once, into nothing kept, so a damaged one is refused now rather than half way
    /// through a render that would meet it with no clip to name: `checkFrames` in the reference.
    func checkFrames() throws {
        try validate(from: 0, through: frameCount - 1)
    }

    /// Checks that every frame from `first` through `last` decodes, without keeping any of them: the
    /// render's pre-flight (`CutoutClip`), as `SubjectTrack.validate` is a focus's.
    func validate(from first: Int, through last: Int) throws {
        let lo = max(0, first), hi = min(frameCount - 1, last)
        guard lo <= hi else { return }
        let cells = width * height
        for index in lo...hi {
            let (start, end) = try range(of: index)
            try MatteTrack.checkPackets(bytes, start: start, end: end, cells: cells)
        }
    }

    /// The bytes frame `index` runs over: to the next frame's offset, the last to the end.
    private func range(of index: Int) throws -> (start: Int, end: Int) {
        guard index >= 0, index < offsets.count else {
            throw MatteTrackError("a matte track has no frame \(index)")
        }
        let start = dataStart + Int(offsets[index])
        let end = index + 1 < offsets.count ? dataStart + Int(offsets[index + 1]) : bytes.count
        return (start, end)
    }

    /// The two frames source time `sourceMs` falls between and how far from the first to the second:
    /// the contract's step 1, a subject track's arithmetic (`SubjectTrack.span`). Before the first frame
    /// and after the last, that frame holds alone (`from == to`, weight 0), and so does a track of one
    /// frame - a picture's - at every time.
    func span(_ sourceMs: Double) -> FrameSpan {
        let last = times.count - 1
        if !(sourceMs > Double(times[0])) { return FrameSpan(from: 0, to: 0, weight: 0) }
        if sourceMs >= Double(times[last]) { return FrameSpan(from: last, to: last, weight: 0) }
        var lo = 0
        var hi = last
        while hi - lo > 1 {
            let mid = (lo + hi) >> 1
            if Double(times[mid]) <= sourceMs { lo = mid } else { hi = mid }
        }
        let t0 = Double(times[lo])
        let t1 = Double(times[hi])
        return FrameSpan(from: lo, to: hi, weight: (sourceMs - t0) / (t1 - t0))
    }

    // MARK: - Reading

    /// Reads a matte track's header and tables, refusing what the layout says a reader refuses. The
    /// frames are left coded until they are asked for (`frame`).
    static func parse(_ data: Data) throws -> MatteTrack {
        let bytes = [UInt8](data)
        guard bytes.count >= headerBytes else { throw MatteTrackError("not a matte track: too short") }
        guard Array(bytes[0..<4]) == magic else { throw MatteTrackError("not a matte track") }
        let version = bytes[4]
        guard version == self.version else {
            throw MatteTrackError("matte track version \(version) is not one this build reads")
        }
        let width = Int(u16(bytes, 6))
        let height = Int(u16(bytes, 8))
        let frames = Int(u32(bytes, 12))
        let jsonBytes = Int(u32(bytes, 16))
        guard width > 0, height > 0, frames > 0 else {
            throw MatteTrackError("matte track has no cells or no frames")
        }
        guard width * height <= maxCells else { throw MatteTrackError("matte track grid is too large") }
        // Int is 64 bits on every device this builds for, so none of these sums can overflow: each part
        // is at most four billion.
        let timesAt = headerBytes + jsonBytes
        let offsetsAt = timesAt + 4 * frames
        let dataStart = offsetsAt + 4 * frames
        guard dataStart <= bytes.count else { throw MatteTrackError("matte track tables run past its end") }

        var times = [UInt32](repeating: 0, count: frames)
        var offsets = [UInt32](repeating: 0, count: frames)
        let dataLength = bytes.count - dataStart
        for i in 0..<frames {
            times[i] = u32(bytes, timesAt + 4 * i)
            offsets[i] = u32(bytes, offsetsAt + 4 * i)
            if i > 0 && !(times[i] > times[i - 1]) { throw MatteTrackError("matte track times go back") }
            if Int(offsets[i]) > dataLength || (i > 0 && offsets[i] < offsets[i - 1]) {
                throw MatteTrackError("matte track offsets go back or past its end")
            }
        }
        return MatteTrack(width: width, height: height, times: times,
                          meta: readMeta(Array(bytes[headerBytes..<timesAt])),
                          bytes: bytes, offsets: offsets, dataStart: dataStart)
    }

    /// The JSON, read leniently: a track whose JSON is damaged still draws, it only cannot be described.
    /// The reference's defaults - an engine that does not say is `mediapipe`, a kind that is not `image`
    /// is `video`, a target that is not `people` is `subject`, a number that is not one is 0 - and a box
    /// only where the JSON has an object for one.
    static func readMeta(_ json: [UInt8]) -> MatteTrackMeta? {
        guard !json.isEmpty,
              let raw = try? JSONSerialization.jsonObject(with: Data(json)) as? [String: Any] else { return nil }
        var box: MatteBox?
        if let b = raw["box"] as? [String: Any] {
            box = MatteBox(x: jsonNumber(b["x"]) ?? 0, y: jsonNumber(b["y"]) ?? 0,
                           w: jsonNumber(b["w"]) ?? 0, h: jsonNumber(b["h"]) ?? 0)
        }
        return MatteTrackMeta(
            engine: raw["engine"] as? String ?? "mediapipe",
            kind: raw["kind"] as? String == "image" ? "image" : "video",
            target: raw["target"] as? String == "people" ? "people" : "subject",
            durationMs: jsonNumber(raw["durationMs"]) ?? 0,
            fps: jsonNumber(raw["fps"]) ?? 0,
            coverage: jsonNumber(raw["coverage"]) ?? 0,
            box: box)
    }

    /// A JSON number as a Double, or nil for anything else. `JSONSerialization` hands a boolean over as
    /// an `NSNumber` too, which the reference's `typeof x === 'number'` would not take for one.
    private static func jsonNumber(_ value: Any?) -> Double? {
        guard let number = value as? NSNumber, CFGetTypeID(number) != CFBooleanGetTypeID() else { return nil }
        let v = number.doubleValue
        return v.isFinite ? v : nil
    }

    private static func u16(_ b: [UInt8], _ at: Int) -> UInt16 {
        UInt16(b[at]) | UInt16(b[at + 1]) << 8
    }

    private static func u32(_ b: [UInt8], _ at: Int) -> UInt32 {
        UInt32(b[at]) | UInt32(b[at + 1]) << 8 | UInt32(b[at + 2]) << 16 | UInt32(b[at + 3]) << 24
    }

    // MARK: - Writing

    /// A matte track's bytes, laid out as `MATTE_TRACK_MAGIC` says.
    static func encode(_ content: MatteTrackContent) throws -> Data {
        guard !content.frames.isEmpty, content.frames.count == content.times.count else {
            throw MatteTrackError("a matte track needs one time per frame, and a frame")
        }
        let coded = try content.frames.map { cells -> [UInt8] in
            guard cells.count == content.width * content.height else {
                throw MatteTrackError("a frame is not the size of the grid")
            }
            return encodePackets(cells)
        }
        return try encode(MatteTrackCoded(width: content.width, height: content.height, times: content.times,
                                          packets: coded, meta: content.meta))
    }

    /// A matte track's bytes from frames already coded: what a video's search writes.
    static func encode(_ content: MatteTrackCoded) throws -> Data {
        guard !content.packets.isEmpty, content.packets.count == content.times.count else {
            throw MatteTrackError("a matte track needs one time per frame, and a frame")
        }
        let json = metaJSON(content.meta)
        var out: [UInt8] = []
        out.reserveCapacity(headerBytes + json.count + 8 * content.packets.count + content.packets.reduce(0) { $0 + $1.count })
        out += magic
        out.append(version)
        out.append(0)                                   // flags
        put16(&out, UInt16(clamping: content.width))
        put16(&out, UInt16(clamping: content.height))
        put16(&out, 0)
        put32(&out, UInt32(clamping: content.packets.count))
        put32(&out, UInt32(clamping: json.count))
        out += json
        for time in content.times {
            // `Math.max(0, Math.round(time))`, as the reference writes it.
            let rounded = jsRound(time)
            put32(&out, rounded.isFinite ? UInt32(clamping: Int64(max(0, min(rounded, 4_294_967_295)))) : 0)
        }
        var offset = 0
        for packets in content.packets {
            put32(&out, UInt32(clamping: offset))
            offset += packets.count
        }
        for packets in content.packets { out += packets }
        return Data(out)
    }

    /// `JSON.stringify(meta)`, with the keys in the reference's order - `engine`, `kind`, `target`,
    /// `durationMs`, `fps`, `coverage`, then `box` where there is one - and its numbers: an integral value
    /// as an integer, any other as the shortest decimal that reads back as the same Double. Written by
    /// hand rather than through `JSONSerialization`, whose dictionaries keep no order (`SubjectTrack`'s
    /// reason).
    static func metaJSON(_ meta: MatteTrackMeta) -> [UInt8] {
        func number(_ v: Double) -> String {
            guard v.isFinite else { return "null" }
            if v == v.rounded(), abs(v) < 1e15 { return String(Int64(v)) }
            return "\(v)"
        }
        func string(_ s: String) -> String {
            let data = (try? JSONSerialization.data(withJSONObject: [s], options: [.fragmentsAllowed])) ?? Data("[\"\"]".utf8)
            let wrapped = String(decoding: data, as: UTF8.self)
            return String(wrapped.dropFirst().dropLast())
        }
        var text = "{\"engine\":\(string(meta.engine)),\"kind\":\(string(meta.kind)),\"target\":\(string(meta.target))," +
            "\"durationMs\":\(number(meta.durationMs)),\"fps\":\(number(meta.fps)),\"coverage\":\(number(meta.coverage))"
        if let box = meta.box {
            text += ",\"box\":{\"x\":\(number(box.x)),\"y\":\(number(box.y)),\"w\":\(number(box.w)),\"h\":\(number(box.h))}"
        }
        text += "}"
        return Array(text.utf8)
    }

    private static func put16(_ out: inout [UInt8], _ v: UInt16) {
        out.append(UInt8(v & 0xff))
        out.append(UInt8(v >> 8))
    }

    private static func put32(_ out: inout [UInt8], _ v: UInt32) {
        out.append(UInt8(v & 0xff))
        out.append(UInt8((v >> 8) & 0xff))
        out.append(UInt8((v >> 16) & 0xff))
        out.append(UInt8(v >> 24))
    }

    // MARK: - Packets

    /// A frame's cells as packets: a varint `count << 1 | 1` and a byte for a run of at least `minRun`,
    /// a varint `count << 1` and the bytes themselves for everything between runs.
    static func encodePackets(_ cells: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        out.reserveCapacity(cells.count / 8 + 16)
        func varint(_ value: Int) {
            var rest = value
            while rest >= 0x80 {
                out.append(UInt8(rest & 0x7f) | 0x80)
                rest >>= 7
            }
            out.append(UInt8(rest))
        }
        var literalFrom = 0
        func flushLiterals(_ to: Int) {
            let count = to - literalFrom
            guard count > 0 else { return }
            varint(count * 2)
            out.append(contentsOf: cells[literalFrom..<to])
        }
        var i = 0
        while i < cells.count {
            let value = cells[i]
            var run = 1
            while i + run < cells.count && cells[i + run] == value { run += 1 }
            if run >= minRun {
                flushLiterals(i)
                varint(run * 2 + 1)
                out.append(value)
                literalFrom = i + run
            }
            i += run
        }
        flushLiterals(cells.count)
        return out
    }

    /// Decodes the packets in `bytes[start..<end]` into `out`, which they must fill exactly. Throws
    /// `MatteTrackError` for packets that stop short of it, run past it, or leave bytes over.
    static func decodePackets(_ bytes: [UInt8], start: Int, end: Int, into out: inout [UInt8]) throws {
        var filled = 0
        try walkPackets(bytes, start: start, end: end, cells: out.count) { packet, count in
            switch packet {
            case .run(let value):
                for c in filled..<(filled + count) { out[c] = value }
            case .literal(let from):
                for k in 0..<count { out[filled + k] = bytes[from + k] }
            }
            filled += count
        }
    }

    /// `decodePackets`'s checks without the cells: whether the packets fill exactly `cells`.
    static func checkPackets(_ bytes: [UInt8], start: Int, end: Int, cells: Int) throws {
        try walkPackets(bytes, start: start, end: end, cells: cells) { _, _ in }
    }

    private enum Packet {
        /// One byte to repeat.
        case run(UInt8)
        /// That many bytes, from this index of the file.
        case literal(Int)
    }

    /// The one walk over a frame's packets that both of the above make, refusing as the reference does:
    /// a varint that never ends or runs past five bytes, a count of 0 or one past the room left, a run
    /// with no byte to repeat, literals the frame does not hold, and packets that leave cells unfilled.
    private static func walkPackets(_ bytes: [UInt8], start: Int, end: Int, cells: Int,
                                    _ each: (Packet, Int) -> Void) throws {
        guard start >= 0, end <= bytes.count, start <= end else {
            throw MatteTrackError("a matte track frame is damaged")
        }
        var at = start
        var filled = 0
        while at < end {
            var n = 0
            var shift = 0
            while true {
                if at >= end || shift > 28 { throw MatteTrackError("a matte track frame is damaged") }
                let byte = bytes[at]
                at += 1
                n |= Int(byte & 0x7f) << shift
                if byte < 0x80 { break }
                shift += 7
            }
            let count = n >> 1
            // Against the room left rather than added to what is filled, as the reference checks it.
            if count < 1 || count > cells - filled {
                throw MatteTrackError("a matte track frame does not fit its grid")
            }
            if n & 1 == 1 {
                if at >= end { throw MatteTrackError("a matte track frame is damaged") }
                each(.run(bytes[at]), count)
                at += 1
            } else {
                if count > end - at { throw MatteTrackError("a matte track frame is damaged") }
                each(.literal(at), count)
                at += count
            }
            filled += count
        }
        if filled != cells { throw MatteTrackError("a matte track frame does not fill its grid") }
    }
}

// MARK: - Step 2, grids and summaries

/// The grid at source time `sourceMs` - the contract's step 2, the two frames either side mixed by how
/// far between them the instant is - as 0...255 a cell, rounded as `Math.round` rounds, ready to refine.
/// `out` is filled, and made the size of the grid when it is not. Throws `MatteTrackError` for a frame
/// that does not decode.
func matteAt(_ track: MatteTrack, _ sourceMs: Double, into out: inout [UInt8]) throws {
    let span = track.span(sourceMs)
    let a = try track.frame(span.from)
    if span.weight == 0 || span.from == span.to {
        out = a
        return
    }
    let b = try track.frame(span.to)
    let cells = a.count
    if out.count != cells { out = [UInt8](repeating: 0, count: cells) }
    let w = span.weight
    for c in 0..<cells {
        let v = jsRound((1 - w) * Double(a[c]) + w * Double(b[c]))
        out[c] = UInt8(max(0, min(255, v)))
    }
}

/// `matteAt` into a new array.
func matteAt(_ track: MatteTrack, _ sourceMs: Double) throws -> [UInt8] {
    var out: [UInt8] = []
    try matteAt(track, sourceMs, into: &out)
    return out
}

/// A grid for a `width` x `height` frame: `longSide` cells on its longer side, the other in proportion,
/// rounded, at least 1 - `matteGrid` in the reference.
func matteGrid(width: Double, height: Double, longSide: Int) -> (width: Int, height: Int) {
    guard width > 0, height > 0 else { return (longSide, longSide) }
    let scale = Double(longSide) / max(width, height)
    return (max(1, Int(jsRound(width * scale))), max(1, Int(jsRound(height * scale))))
}

/// How much of the frame the subject covers on average, and where it is over the whole footage - the
/// `coverage` and `box` a track's JSON carries - counted as frames are added, a cell at even odds or
/// above (`MatteTrack.subjectAt`) being the subject's: `summariseMatte` in the reference, kept as it
/// goes so that a video's search need keep none of its grids.
struct MatteSummary {
    let width: Int
    let height: Int
    private var covered = 0
    private var frames = 0
    private var minX: Int
    private var minY: Int
    private var maxX = -1
    private var maxY = -1

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
        minX = width
        minY = height
    }

    mutating func add(_ cells: [UInt8]) {
        frames += 1
        guard cells.count >= width * height else { return }
        for y in 0..<height {
            for x in 0..<width where cells[y * width + x] >= MatteTrack.subjectAt {
                covered += 1
                if x < minX { minX = x }
                if x > maxX { maxX = x }
                if y < minY { minY = y }
                if y > maxY { maxY = y }
            }
        }
    }

    /// The coverage, rounded to four places, and the box - none where nothing stood out.
    var result: (coverage: Double, box: MatteBox?) {
        let total = frames * width * height
        guard maxX >= 0, total > 0 else { return (0, nil) }
        func round4(_ v: Double) -> Double { jsRound(v * 10_000) / 10_000 }
        return (round4(Double(covered) / Double(total)),
                MatteBox(x: round4(Double(minX) / Double(width)), y: round4(Double(minY) / Double(height)),
                         w: round4(Double(maxX + 1 - minX) / Double(width)), h: round4(Double(maxY + 1 - minY) / Double(height))))
    }
}

/// `MatteSummary` over frames already in hand: `summariseMatte`.
func summariseMatte(_ frames: [[UInt8]], width: Int, height: Int) -> (coverage: Double, box: MatteBox?) {
    var summary = MatteSummary(width: width, height: height)
    for cells in frames { summary.add(cells) }
    return summary.result
}
