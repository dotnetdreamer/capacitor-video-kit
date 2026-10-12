import Foundation

/// A subject track, the file `findSubjects` writes: where every subject of a footage is, frame by
/// frame, as a coarse grid of subject ids over the ORIENTED frame. `SUBJECT_TRACK_MAGIC` in
/// `definitions.ts` has the layout; this is a port of `src/editor/subject-track.ts`, its reader and
/// its writer, with the same refusals in the same words, and `SubjectTrackTests` holds it to the
/// cases of `subject-track.unit.test.ts`.
///
/// Read in two halves, as the reference reads it. The header, the times and the frame offsets are
/// read at once, so a file that is not a subject track is refused when it is opened - in the
/// render's pre-flight, before a codec is opened (`FocusTracks`) - and the frames are decoded only
/// when one is drawn, a few at a time: a minute of footage at fifteen frames a second is nine hundred
/// grids, and a frame of the render needs two of them.
///
/// What a frame IS to a picture is `focusMask`: the grid of a clip's focus at one instant, 0...255 a
/// cell, which `FocusRender` stretches over the frame with linear sampling - the contract's step 4.

/// What `SubjectTrack.parse` refuses, and what decoding a damaged frame throws. The words are the
/// reference's, so a refusal reads the same from every engine.
struct SubjectTrackError: Error, CustomStringConvertible, Equatable {
    let description: String
    init(_ description: String) { self.description = description }
}

/// Where a subject is in the frame it is largest in: 0...1 of the oriented frame, top-left origin.
struct SubjectBox: Equatable, Sendable {
    let x: Double
    let y: Double
    let w: Double
    let h: Double
}

/// One subject found in a footage: `SubjectInfo` in `definitions.ts`.
struct SubjectInfo: Equatable, Sendable {
    let id: Int
    /// `person` where the engine finds only people, `subject` where it finds anything that stands out.
    let kind: String
    let startMs: Double
    let endMs: Double
    let peakMs: Double
    let box: SubjectBox
    let area: Double

    var json: [String: Any] {
        ["id": id, "kind": kind, "startMs": startMs, "endMs": endMs, "peakMs": peakMs,
         "box": ["x": box.x, "y": box.y, "w": box.w, "h": box.h], "area": area]
    }
}

/// The JSON after the header: the `FindSubjectsResult` fields a reader that shows subjects needs.
/// A renderer never reads it.
struct SubjectTrackMeta: Equatable, Sendable {
    let engine: String
    /// `video` or `image`.
    let kind: String
    let durationMs: Double
    let fps: Double
    let subjects: [SubjectInfo]
}

/// The two track frames a source instant falls between, and how far from the first to the second.
struct FrameSpan: Equatable, Sendable {
    let from: Int
    let to: Int
    /// 0...1 from `from` towards `to`.
    let weight: Double
}

/// What `SubjectTrack.encode` writes: the grid, every frame's time and cells, and the JSON.
struct SubjectTrackContent: Equatable, Sendable {
    let width: Int
    let height: Int
    /// Source ms, strictly increasing once rounded, one per frame.
    let times: [Double]
    /// `width * height` subject ids each, row by row from the top-left.
    let frames: [[UInt8]]
    let meta: SubjectTrackMeta
}

final class SubjectTrack: @unchecked Sendable {
    /// `SUBJECT_TRACK_MAGIC` and `SUBJECT_TRACK_VERSION`.
    static let magic: [UInt8] = Array("VKST".utf8)
    static let version: UInt8 = 1
    /// Where the JSON starts.
    static let headerBytes = 20
    /// The most cells a grid may have: the layout's ceiling, far past `SUBJECT_GRID` squared.
    static let maxCells = 1_000_000
    /// Frames kept decoded: the pair a moment is drawn between, and the pair either side of a seek.
    static let keptFrames = 6

    let width: Int
    let height: Int
    /// Each frame's source time, ms, strictly increasing.
    let times: [UInt32]
    /// The JSON, or nil where it was missing or would not parse: a renderer never needs it.
    let meta: SubjectTrackMeta?

    private let bytes: [UInt8]
    private let offsets: [UInt32]
    private let dataStart: Int

    /// The decoded frames last asked for, oldest first. Behind `lock`: a track is shared by every clip
    /// focused from the same file, and is drawn from the compositor's queue.
    private let lock = NSLock()
    private var kept: [(index: Int, cells: [UInt8])] = []
    private var decodeCount = 0

    private init(width: Int, height: Int, times: [UInt32], meta: SubjectTrackMeta?, bytes: [UInt8],
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

    /// One frame's cells, `width * height` subject ids row by row. Throws `SubjectTrackError` for an
    /// index the track does not have and for a frame whose runs do not add up to the grid.
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
        try SubjectTrack.decodeRuns(bytes, start: start, end: end, into: &cells)
        decodeCount += 1
        kept.append((index, cells))
        if kept.count > SubjectTrack.keptFrames { kept.removeFirst() }
        return cells
    }

    /// Checks that every frame from `first` through `last` decodes, without keeping any of them: the
    /// render's pre-flight (`FocusClip`), so a damaged frame fails the render as `unreadable_input`
    /// before anything is encoded rather than part of the way through.
    func validate(from first: Int, through last: Int) throws {
        let lo = max(0, first), hi = min(frameCount - 1, last)
        guard lo <= hi else { return }
        let cells = width * height
        for index in lo...hi {
            let (start, end) = try range(of: index)
            try SubjectTrack.checkRuns(bytes, start: start, end: end, cells: cells)
        }
    }

    /// The bytes frame `index` runs over: to the next frame's offset, the last to the end.
    private func range(of index: Int) throws -> (start: Int, end: Int) {
        guard index >= 0, index < offsets.count else {
            throw SubjectTrackError("a subject track has no frame \(index)")
        }
        let start = dataStart + Int(offsets[index])
        let end = index + 1 < offsets.count ? dataStart + Int(offsets[index + 1]) : bytes.count
        return (start, end)
    }

    /// The two frames source time `sourceMs` falls between and how far from the first to the second:
    /// the contract's step 1. Before the first frame and after the last, that frame holds alone
    /// (`from == to`, weight 0), and so does a track of one frame at every time.
    func span(_ sourceMs: Double) -> FrameSpan {
        let last = times.count - 1
        if !(sourceMs > Double(times[0])) { return FrameSpan(from: 0, to: 0, weight: 0) }
        if sourceMs >= Double(times[last]) { return FrameSpan(from: last, to: last, weight: 0) }
        // The last frame at or before the time: a binary search, since a render asks once a frame.
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

    /// Reads a subject track's header and tables, refusing what the layout says a reader refuses. The
    /// frames are left coded until they are asked for (`frame`).
    static func parse(_ data: Data) throws -> SubjectTrack {
        let bytes = [UInt8](data)
        guard bytes.count >= headerBytes else { throw SubjectTrackError("not a subject track: too short") }
        guard Array(bytes[0..<4]) == magic else { throw SubjectTrackError("not a subject track") }
        let version = bytes[4]
        guard version == self.version else {
            throw SubjectTrackError("subject track version \(version) is not one this build reads")
        }
        let width = Int(u16(bytes, 6))
        let height = Int(u16(bytes, 8))
        let frames = Int(u32(bytes, 12))
        let jsonBytes = Int(u32(bytes, 16))
        guard width > 0, height > 0, frames > 0 else {
            throw SubjectTrackError("subject track has no cells or no frames")
        }
        guard width * height <= maxCells else { throw SubjectTrackError("subject track grid is too large") }
        // Int is 64 bits on every device this builds for, so none of these sums can overflow: each
        // part is at most four billion.
        let timesAt = headerBytes + jsonBytes
        let offsetsAt = timesAt + 4 * frames
        let dataStart = offsetsAt + 4 * frames
        guard dataStart <= bytes.count else { throw SubjectTrackError("subject track tables run past its end") }

        var times = [UInt32](repeating: 0, count: frames)
        var offsets = [UInt32](repeating: 0, count: frames)
        let dataLength = bytes.count - dataStart
        for i in 0..<frames {
            times[i] = u32(bytes, timesAt + 4 * i)
            offsets[i] = u32(bytes, offsetsAt + 4 * i)
            if i > 0 && !(times[i] > times[i - 1]) { throw SubjectTrackError("subject track times go back") }
            if Int(offsets[i]) > dataLength || (i > 0 && offsets[i] < offsets[i - 1]) {
                throw SubjectTrackError("subject track offsets go back or past its end")
            }
        }
        return SubjectTrack(width: width, height: height, times: times,
                            meta: readMeta(Array(bytes[headerBytes..<timesAt])),
                            bytes: bytes, offsets: offsets, dataStart: dataStart)
    }

    /// The JSON, read leniently: a track whose JSON is damaged still draws, it only cannot be listed.
    /// The reference's defaults - an engine that does not say is `mediapipe`, a kind that is not
    /// `image` is `video`, a duration or rate that is not a number is 0 - and a subject that is not an
    /// object carrying a numeric id is left out of the list rather than listed as garbage.
    static func readMeta(_ json: [UInt8]) -> SubjectTrackMeta? {
        guard !json.isEmpty,
              let raw = try? JSONSerialization.jsonObject(with: Data(json)) as? [String: Any],
              let subjects = raw["subjects"] as? [Any] else { return nil }
        return SubjectTrackMeta(
            engine: raw["engine"] as? String ?? "mediapipe",
            kind: raw["kind"] as? String == "image" ? "image" : "video",
            durationMs: jsonNumber(raw["durationMs"]) ?? 0,
            fps: jsonNumber(raw["fps"]) ?? 0,
            subjects: subjects.compactMap { item -> SubjectInfo? in
                guard let s = item as? [String: Any], let id = jsonNumber(s["id"]) else { return nil }
                let box = s["box"] as? [String: Any] ?? [:]
                return SubjectInfo(id: Int(id), kind: s["kind"] as? String ?? "subject",
                                   startMs: jsonNumber(s["startMs"]) ?? 0, endMs: jsonNumber(s["endMs"]) ?? 0,
                                   peakMs: jsonNumber(s["peakMs"]) ?? 0,
                                   box: SubjectBox(x: jsonNumber(box["x"]) ?? 0, y: jsonNumber(box["y"]) ?? 0,
                                                   w: jsonNumber(box["w"]) ?? 0, h: jsonNumber(box["h"]) ?? 0),
                                   area: jsonNumber(s["area"]) ?? 0)
            })
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

    /// A subject track's bytes, laid out as `SUBJECT_TRACK_MAGIC` says.
    static func encode(_ content: SubjectTrackContent) throws -> Data {
        let width = content.width, height = content.height
        guard !content.frames.isEmpty, content.frames.count == content.times.count else {
            throw SubjectTrackError("a subject track needs one time per frame, and a frame")
        }
        let json = metaJSON(content.meta)
        let coded = try content.frames.map { cells -> [UInt8] in
            guard cells.count == width * height else { throw SubjectTrackError("a frame is not the size of the grid") }
            return encodeRuns(cells)
        }
        var out: [UInt8] = []
        out.reserveCapacity(headerBytes + json.count + 8 * coded.count + coded.reduce(0) { $0 + $1.count })
        out += magic
        out.append(version)
        out.append(0)                                   // flags
        put16(&out, UInt16(clamping: width))
        put16(&out, UInt16(clamping: height))
        put16(&out, 0)
        put32(&out, UInt32(clamping: coded.count))
        put32(&out, UInt32(clamping: json.count))
        out += json
        for time in content.times {
            // `Math.max(0, Math.round(time))`, as the reference writes it.
            let rounded = jsRound(time)
            put32(&out, rounded.isFinite ? UInt32(clamping: Int64(max(0, min(rounded, 4_294_967_295)))) : 0)
        }
        var offset = 0
        for runs in coded {
            put32(&out, UInt32(clamping: offset))
            offset += runs.count
        }
        for runs in coded { out += runs }
        return Data(out)
    }

    /// `JSON.stringify(meta)`, with the keys in the reference's order and its numbers: an integral
    /// value as an integer, any other as the shortest decimal that reads back as the same Double.
    /// Written by hand rather than through `JSONSerialization`, whose dictionaries keep no order and
    /// whose output of a Double has not always been the shortest one.
    static func metaJSON(_ meta: SubjectTrackMeta) -> [UInt8] {
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
        let subjects = meta.subjects.map { s in
            "{\"id\":\(s.id),\"kind\":\(string(s.kind)),\"startMs\":\(number(s.startMs)),\"endMs\":\(number(s.endMs))," +
                "\"peakMs\":\(number(s.peakMs)),\"box\":{\"x\":\(number(s.box.x)),\"y\":\(number(s.box.y))," +
                "\"w\":\(number(s.box.w)),\"h\":\(number(s.box.h))},\"area\":\(number(s.area))}"
        }
        let text = "{\"engine\":\(string(meta.engine)),\"kind\":\(string(meta.kind)),\"durationMs\":\(number(meta.durationMs))," +
            "\"fps\":\(number(meta.fps)),\"subjects\":[\(subjects.joined(separator: ","))]}"
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

    // MARK: - Runs

    /// A frame's cells as runs: a value byte, then its run as an unsigned LEB128 varint.
    static func encodeRuns(_ cells: [UInt8]) -> [UInt8] {
        var out: [UInt8] = []
        var i = 0
        while i < cells.count {
            let value = cells[i]
            var run = 1
            while i + run < cells.count && cells[i + run] == value { run += 1 }
            out.append(value)
            var rest = run
            while rest >= 0x80 {
                out.append(UInt8(rest & 0x7f) | 0x80)
                rest >>= 7
            }
            out.append(UInt8(rest))
            i += run
        }
        return out
    }

    /// Decodes the runs in `bytes[start..<end]` into `out`, which they must fill exactly. Throws
    /// `SubjectTrackError` for runs that stop short of it, run past it, or stop inside a varint.
    static func decodeRuns(_ bytes: [UInt8], start: Int, end: Int, into out: inout [UInt8]) throws {
        let total = out.count
        var filled = 0
        try walkRuns(bytes, start: start, end: end, cells: total) { value, run in
            for c in filled..<(filled + run) { out[c] = value }
            filled += run
        }
    }

    /// `decodeRuns`'s checks without the cells: whether the runs fill exactly `cells`.
    static func checkRuns(_ bytes: [UInt8], start: Int, end: Int, cells: Int) throws {
        try walkRuns(bytes, start: start, end: end, cells: cells) { _, _ in }
    }

    /// The one walk over a frame's runs that both of the above make, refusing as the reference refuses.
    private static func walkRuns(_ bytes: [UInt8], start: Int, end: Int, cells: Int,
                                 _ each: (UInt8, Int) -> Void) throws {
        guard start >= 0, end <= bytes.count, start <= end else {
            throw SubjectTrackError("a subject track frame is damaged")
        }
        var at = start
        var filled = 0
        while at < end {
            let value = bytes[at]
            at += 1
            var run = 0
            var shift = 0
            while true {
                if at >= end || shift > 28 { throw SubjectTrackError("a subject track frame is damaged") }
                let byte = bytes[at]
                at += 1
                run |= Int(byte & 0x7f) << shift
                if byte < 0x80 { break }
                shift += 7
            }
            if run < 1 || filled + run > cells {
                throw SubjectTrackError("a subject track frame does not fit its grid")
            }
            each(value, run)
            filled += run
        }
        if filled != cells { throw SubjectTrackError("a subject track frame does not fill its grid") }
    }
}

// MARK: - Steps 2 and 3

/// How in focus every subject id is at source time `sourceMs`: entry `id` of a 256-long table, 0 for
/// the background and for every subject the focus does not list. The contract's step 2, read off the
/// keys as a camera's are read: the last key at or before the instant - a step takes effect at its
/// own time, so of two keys at one time the later wins - and the straight line on to the next.
///
/// The table is Float, as the reference's `Float32Array` is, and the line is worked in Double, as
/// JavaScript works it: `focusMask` rounds the same numbers the same way on every engine.
func focusLevels(atMs: [Double], subjects: [ComposeFocusSubject], at sourceMs: Double, into out: inout [Float]) {
    if out.count != 256 { out = [Float](repeating: 0, count: 256) }
    for i in 0..<256 { out[i] = 0 }
    let n = atMs.count
    guard n > 0 else { return }
    var i = 0
    while i + 1 < n && atMs[i + 1] <= sourceMs { i += 1 }
    let between = i + 1 < n && sourceMs > atMs[i] ? (sourceMs - atMs[i]) / (atMs[i + 1] - atMs[i]) : 0
    for subject in subjects {
        let values = subject.focus
        guard i < values.count else { continue }
        let level = between > 0 && i + 1 < values.count ? values[i] + (values[i + 1] - values[i]) * between : values[i]
        out[subject.id & 0xff] = Float(min(1, max(0, level)))
    }
    out[0] = 0
}

/// `focusLevels` into a new table.
func focusLevels(atMs: [Double], subjects: [ComposeFocusSubject], at sourceMs: Double) -> [Float] {
    var out = [Float](repeating: 0, count: 256)
    focusLevels(atMs: atMs, subjects: subjects, at: sourceMs, into: &out)
    return out
}

/// The grid of a focus at one instant: each cell's `m` - the contract's step 3, the two frames either
/// side mixed by how far between them the instant is, and turned over for `invert` - as 0...255,
/// ready to draw. `levels` is what `focusLevels` answered for the same instant. `out` is filled, and
/// made the size of the grid when it is not. Throws `SubjectTrackError` for a frame that does not
/// decode.
func focusMask(_ track: SubjectTrack, levels: [Float], at sourceMs: Double, invert: Bool,
               into out: inout [UInt8]) throws {
    let span = track.span(sourceMs)
    let a = try track.frame(span.from)
    let cells = a.count
    if out.count != cells { out = [UInt8](repeating: 0, count: cells) }
    if span.weight == 0 || span.from == span.to {
        for c in 0..<cells {
            let m = Double(levels[Int(a[c])])
            out[c] = maskByte((invert ? 1 - m : m) * 255)
        }
        return
    }
    let b = try track.frame(span.to)
    let w = span.weight
    for c in 0..<cells {
        let m = (1 - w) * Double(levels[Int(a[c])]) + w * Double(levels[Int(b[c])])
        out[c] = maskByte((invert ? 1 - m : m) * 255)
    }
}

/// `Math.round` into a byte. The levels are already held to 0...1, so this only ever meets a value a
/// rounding error outside 0...255, and the hold is what keeps that from trapping the conversion.
private func maskByte(_ v: Double) -> UInt8 {
    let r = jsRound(v)
    guard r.isFinite else { return 0 }
    return UInt8(max(0, min(255, r)))
}

/// `Math.round`: halves go up, towards positive infinity, which `.rounded()` does not do for a
/// negative half. Every port of the reference rounds through this so the two give the same answers.
func jsRound(_ v: Double) -> Double { (v + 0.5).rounded(.down) }
