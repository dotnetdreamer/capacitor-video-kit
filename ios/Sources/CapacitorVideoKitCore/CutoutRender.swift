import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import os

// A clip's CUTOUT in the render: its background taken away, drawn by `ComposeCutout`'s contract in
// `definitions.ts` - whose steps are not repeated here - AFTER the clip's focus and its grade and before
// everything else. `EditCompositor` hands each cut-out layer's oriented, focused, graded picture to
// `CutoutClip.cutOut`, and the crop, the fit, the rectangle and its turn, the camera, the opacity and a
// transition's side then carry the alpha it makes on, exactly as they carry a picture's: a base clip's
// background shows the canvas, a layer's the layers under it, and a transition side is its clip drawn
// over the canvas (`EditCompositor.wholeFrame`).
//
// Four parts, as a focus has three (`FocusRender.swift`):
//  - `CutoutTracks`, the pre-flight: every cut-out clip's matte track read and its header parsed before
//    a frame is drawn, a track that will not read failing the render as `unreadable_input` naming the
//    clip, as footage that will not read does.
//  - `CutoutClip`, one per timeline entry the builder lays: the cutout, its track, and the entry's own
//    time mapping, which turns the compositor's OUTPUT time into the SOURCE time the track's frames are
//    in. Steps 2 to 4 happen here, on the grid.
//  - `CutoutMath`, the grid's arithmetic on the CPU - the guided filter and the outline's blur - ported
//    from `cutout-pixels.ts`, the reference every engine is checked against.
//  - `CutoutRender`, the guide read off the frame and steps 5 to 8 in BUILT-IN Core Image filters.
//
// WHY THE REFINEMENT IS ON THE CPU. Steps 3 and 4 are box means, products and a division over a grid of
// at most half a million cells (a million for a picture). In Core Image they would be a chain of blurs
// and blends whose box widths and edge handling Apple does not document, worked in the context's half
// floats, where `mean(y * y) - mean(y)^2` loses most of its digits; a Metal kernel would do them exactly
// but needs build flags neither package manager here sets. On the CPU they are the reference's own
// arithmetic, in single and double precision, in a few milliseconds a frame. What crosses over is one
// small read-back a frame - the guide, a float a cell - and one small upload - `A`, `B` and the outline's
// `D`, four floats a cell - and the per-pixel steps stay on the GPU.

/// The matte tracks a render's cut-out clips are drawn from, each file read once.
enum CutoutTracks {
    /// The largest track a render reads, as Android's `MatteFinder.trackForRender` refuses past it: far
    /// past any track `findMatte` writes, which is a few megabytes a minute of footage.
    static let maxTrackBytes = 96 * 1024 * 1024

    /// Every cut-out clip's track, by its `uri`, read in `ComposeSpec.everyClip`'s order - the base clips,
    /// the transitions' outgoing sides, the layers - after every clip's footage and every focus's subject
    /// track have been read, which is Android's order, so a post broken in two places names the same clip
    /// on both. Empty for a spec with no cutout, which reads nothing.
    ///
    /// Throws `BuildError.unreadable` naming the first clip that needs a track that is missing, is not a
    /// matte track, or is one this build cannot read.
    static func load(_ spec: ComposeSpec) throws -> [String: MatteTrack] {
        var tracks: [String: MatteTrack] = [:]
        for clip in spec.everyClip {
            guard let cutout = clip.cutout, tracks[cutout.uri] == nil else { continue }
            tracks[cutout.uri] = try read(cutout.uri, for: clip.key)
        }
        return tracks
    }

    /// One track, its header and tables parsed; `key` is the clip a failure names.
    static func read(_ uri: String, for key: String) throws -> MatteTrack {
        guard let url = JobFolders.fileURL(from: uri) else {
            throw BuildError.unreadable(key, "matte track: unsupported uri")
        }
        if let size = (try? url.resourceValues(forKeys: [.fileSizeKey]))?.fileSize, size > maxTrackBytes {
            throw BuildError.unreadable(key, "matte track: larger than \(maxTrackBytes / (1024 * 1024)) MB")
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw BuildError.unreadable(key, "matte track: \(ErrorMapping.describe(error))")
        }
        let track: MatteTrack
        do {
            track = try MatteTrack.parse(data)
        } catch {
            throw BuildError.unreadable(key, "matte track: \(error)")
        }
        // A track a render reads is a track asked for: the launch sweep and the cache's trim count from
        // now, as Android touches one its render reads.
        if url.deletingLastPathComponent().standardizedFileURL.path == JobFolders.mattesDir().standardizedFileURL.path {
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        }
        return track
    }
}

/// One cut-out clip - a base clip, a transition's outgoing side or a layer's clip - as the builder laid
/// it: what the compositor needs to take its frames' background away.
///
/// IMMUTABLE in everything but its scratch, and a class for its identity, as `FocusClip` is: the builder
/// makes ONE per timeline entry, and every `EditLayer` the instructions cut from that entry carries the
/// same instance, so the track is validated once and the scratch is shared rather than made per
/// instruction.
///
/// SOURCE TIME is `FocusClip`'s, rule for rule: the straight line the composition plays the clip by -
/// `SlowMotion.sourceSeconds` over the entry's `inserted` and `placed` ranges - held to the clip's own
/// trim, from its in-point to a microsecond short of the end of what was inserted. That covers a clip at
/// any speed, a layer or a tail cut to its window, a clip held on its footage's last frame, a picture
/// (one track frame, which holds), and a slowed clip, whose synthesised frame is cut out at the source
/// instant it stands for - the contract's second reading of a slowed clip.
final class CutoutClip: @unchecked Sendable {
    let key: String
    let cutout: ComposeCutout
    let track: MatteTrack

    // The ranges in Double seconds, and the hold in milliseconds, worked out once rather than per frame.
    private let insertedStart: Double
    private let insertedDuration: Double
    private let placedStart: Double
    private let placedDuration: Double
    private let lowMs: Double
    private let highMs: Double

    /// The outline's colour, its sigma in cells and its edge's spread (step 7), or nil for none.
    private let outline: (color: ComposeRGB, sigma: Double, spread: Double)?

    /// The matte and the guide of the frame being drawn, the guide's read-back, and the last grid made -
    /// reused while neither the matte nor the guide changes, which is every frame of a picture and of a
    /// clip held on a frame. Behind `lock`, which the compositor's one serial queue never contends; it is
    /// there so that nothing else ever can.
    private let lock = NSLock()
    private var cells: [UInt8] = []
    private var guide: [Float] = []
    private var bitmap: [Float] = []
    private var made: (cells: [UInt8], guide: [Float], grid: CIImage)?

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Cutout")
    private static let warned = OnceFlag()

    /// `inserted` and `placed` are the entry's ranges as the builder laid it. Throws
    /// `BuildError.unreadable` naming the clip when a frame of the track the clip can reach does not
    /// decode: checked here, once, so a damaged track fails the render before anything is encoded rather
    /// than part of the way through it.
    init(clip: ComposeClip, cutout: ComposeCutout, track: MatteTrack, inserted: CMTimeRange, placed: CMTimeRange) throws {
        key = clip.key
        self.cutout = cutout
        self.track = track
        insertedStart = inserted.start.seconds
        insertedDuration = inserted.duration.seconds
        placedStart = placed.start.seconds
        placedDuration = placed.duration.seconds
        lowMs = Double(clip.inMs)
        highMs = max(lowMs, inserted.end.seconds * 1000 - 0.001)
        outline = cutout.outline.map { line -> (color: ComposeRGB, sigma: Double, spread: Double) in
            let sigma = CutoutMath.outlineSigma(line.width, columns: track.width, rows: track.height)
            return (color: line.color, sigma: sigma, spread: CutoutMath.outlineSpread(sigma))
        }
        do {
            try track.validate(from: track.span(lowMs).from, through: track.span(highMs).to)
        } catch {
            throw BuildError.unreadable(clip.key, "matte track: \(error)")
        }
    }

    /// The SOURCE instant, in ms of the clip's file, that output instant `tUs` shows: see the class.
    func sourceMs(atUs tUs: Int64) -> Double {
        let s = SlowMotion.sourceSeconds(composition: Double(tUs) / 1_000_000, placedStart: placedStart,
                                         placedDuration: placedDuration, insertedStart: insertedStart,
                                         insertedDuration: insertedDuration) * 1000
        guard s.isFinite else { return lowMs }
        return min(highMs, max(lowMs, s))
    }

    /// The contract's step 2 at the instant output time `tUs` shows, 0...255 a cell. Throws only for a
    /// frame that does not decode, which `init` has ruled out.
    func matte(atUs tUs: Int64) throws -> [UInt8] {
        let s = sourceMs(atUs: tUs)
        lock.lock()
        defer { lock.unlock() }
        try matteAt(track, s, into: &cells)
        return cells
    }

    /// `frame`, the layer's ORIENTED, focused and graded picture at output time `tUs`, cut out: steps 2
    /// to 8, over the frame's own extent. `context` is the compositor's, which reads the guide back.
    func cutOut(_ frame: CIImage, atUs tUs: Int64, context: CIContext) -> CIImage {
        let rect = frame.extent
        guard !rect.isInfinite, rect.width >= 1, rect.height >= 1 else { return frame }
        let s = sourceMs(atUs: tUs)
        lock.lock()
        defer { lock.unlock() }
        do {
            try matteAt(track, s, into: &cells)
        } catch {
            // Validated when the clip was laid, so this is a bug rather than a file; the frame is drawn
            // as the footage rather than failing a render over it, and it is said once.
            if Self.warned.setOnce() {
                Self.log.error("cutout: a matte track frame would not decode mid-render, drawn whole: \(String(describing: error), privacy: .public)")
            }
            return frame
        }
        let columns = track.width, rows = track.height
        let luma = CutoutRender.luma(frame, rect: rect)
        // Steps 3 and 4, or neither: an engine that cannot read the guide reads `q` as the matte itself,
        // as the contract lets one with no float targets.
        let refined = CutoutRender.guide(luma, rect: rect, columns: columns, rows: rows, context: context,
                                         bitmap: &bitmap, into: &guide)
        if !refined { guide = [] }
        let grid: CIImage
        if let made, made.cells == cells, made.guide == guide {
            grid = made.grid
        } else {
            let values = CutoutRender.gridValues(matte: cells, guide: refined ? guide : nil, columns: columns, rows: rows,
                                                 outlineSigma: outline?.sigma)
            grid = CutoutRender.gridImage(values, columns: columns, rows: rows)
            made = (cells: cells, guide: guide, grid: grid)
        }
        var line: (color: ComposeRGB, spread: Double)?
        if let outline { line = (color: outline.color, spread: outline.spread) }
        return CutoutRender.cutOut(frame, luma: luma,
                                   grid: CutoutRender.stretched(grid, columns: columns, rows: rows, over: rect),
                                   soft: cutout.soft, shift: cutout.shift, fill: cutout.fill, outline: line, rect: rect)
    }
}

// MARK: - The grid's arithmetic

/// The cutout's arithmetic on the grid, on the CPU: `cutout-pixels.ts`, function for function - the
/// guided filter (step 4), the outline's blur and its sigma (step 7), the edge (step 6) - so this engine
/// works the reference's own numbers. Grids are row by row from the top-left, as the track's are.
enum CutoutMath {
    /// The mean of `src` over the `(2r + 1)` x `(2r + 1)` cells centred on each cell, a cell past the edge
    /// read as the nearest edge cell - the contract's `mean` - across and then down.
    static func boxMean(_ src: [Float], width: Int, height: Int, radius r: Int) -> [Float] {
        var across = [Float](repeating: 0, count: width * height)
        var out = [Float](repeating: 0, count: width * height)
        runningBox(src, into: &across, width: width, height: height, radius: r, across: true)
        runningBox(across, into: &out, width: width, height: height, radius: r, across: false)
        return out
    }

    /// One box of radius `r` along rows (`across`) or down columns, a cell past the edge read as the edge
    /// cell, by a running sum - down the columns a row at a time with every column's sum at once, the
    /// reference's order of additions, so the same numbers.
    static func runningBox(_ src: [Float], into out: inout [Float], width: Int, height: Int, radius r: Int, across: Bool) {
        guard width > 0, height > 0, src.count >= width * height else { return }
        if out.count != width * height { out = [Float](repeating: 0, count: width * height) }
        let n = Double(2 * r + 1)
        func clamp(_ v: Int, _ lo: Int, _ hi: Int) -> Int { v < lo ? lo : (v > hi ? hi : v) }
        src.withUnsafeBufferPointer { s in
            out.withUnsafeMutableBufferPointer { o in
                if across {
                    for y in 0..<height {
                        let base = y * width
                        var sum = 0.0
                        for k in -r...r { sum += Double(s[base + clamp(k, 0, width - 1)]) }
                        for x in 0..<width {
                            o[base + x] = Float(sum / n)
                            sum += Double(s[base + clamp(x + r + 1, 0, width - 1)]) - Double(s[base + clamp(x - r, 0, width - 1)])
                        }
                    }
                } else {
                    var sums = [Double](repeating: 0, count: width)
                    for k in -r...r {
                        let row = clamp(k, 0, height - 1) * width
                        for x in 0..<width { sums[x] += Double(s[row + x]) }
                    }
                    for y in 0..<height {
                        let at = y * width
                        let next = clamp(y + r + 1, 0, height - 1) * width
                        let last = clamp(y - r, 0, height - 1) * width
                        for x in 0..<width {
                            o[at + x] = Float(sums[x] / n)
                            sums[x] += Double(s[next + x]) - Double(s[last + x])
                        }
                    }
                }
            }
        }
    }

    /// Step 4, the guided filter on the grid: `m` the matte, 0...255 a cell (step 2's, rounded as an
    /// engine uploads it), and `y` the guide, 0...1 a cell (step 3's). Answers `A` and `B`, so that `q = A
    /// * Y + B` at every pixel. `CUTOUT_RADIUS` and `CUTOUT_EPSILON` unless a test asks for others.
    static func refine(matte m: [UInt8], guide y: [Float], width: Int, height: Int,
                       radius: Int = ComposeCutout.radius, epsilon: Double = ComposeCutout.epsilon) -> (a: [Float], b: [Float]) {
        let cells = width * height
        guard cells > 0, m.count >= cells, y.count >= cells else {
            return ([Float](repeating: 0, count: max(0, cells)), [Float](repeating: 0, count: max(0, cells)))
        }
        var p = [Float](repeating: 0, count: cells)
        var yy = [Float](repeating: 0, count: cells)
        var yp = [Float](repeating: 0, count: cells)
        for c in 0..<cells {
            let v = Float(Double(m[c]) / 255)
            let g = Double(y[c])
            p[c] = v
            yy[c] = Float(g * g)
            yp[c] = Float(g * Double(v))
        }
        let meanY = boxMean(y, width: width, height: height, radius: radius)
        let meanP = boxMean(p, width: width, height: height, radius: radius)
        let meanYY = boxMean(yy, width: width, height: height, radius: radius)
        let meanYP = boxMean(yp, width: width, height: height, radius: radius)
        var a = [Float](repeating: 0, count: cells)
        var b = [Float](repeating: 0, count: cells)
        for c in 0..<cells {
            let my = Double(meanY[c])
            let variance = Double(meanYY[c]) - my * my
            let covariance = Double(meanYP[c]) - my * Double(meanP[c])
            a[c] = Float(covariance / (variance + epsilon))
            b[c] = Float(Double(meanP[c]) - Double(a[c]) * my)
        }
        return (boxMean(a, width: width, height: height, radius: radius),
                boxMean(b, width: width, height: height, radius: radius))
    }

    /// Step 7's sigma, in cells, for an outline as wide as `outlineWidth` of the source's shorter side,
    /// on a `columns` x `rows` grid.
    static func outlineSigma(_ outlineWidth: Double, columns: Int, rows: Int) -> Double {
        outlineWidth * Double(min(columns, rows)) / 1.55
    }

    /// Step 7's `d`, the half width of the outline's own edge.
    static func outlineSpread(_ sigma: Double) -> Double {
        0.04 / max(1, sigma)
    }

    /// Step 7's `D`: the matte, 0...1, Gaussian-blurred by `sigma` cells with its edges clamped - three
    /// running boxes across and three down, which is a Gaussian to within what eight bits show and costs
    /// the same at any sigma. A sigma under a cell is the matte itself.
    static func outlineField(_ m: [UInt8], width: Int, height: Int, sigma: Double) -> [Float] {
        var field = m.map { Float(Double($0) / 255) }
        guard sigma >= 1, width > 0, height > 0, field.count == width * height else { return field }
        // Three boxes of width w have a variance of 3 * (w^2 - 1) / 12: w is the odd width that comes
        // nearest sigma^2.
        let w = max(1, Int(jsRound((4 * sigma * sigma + 1).squareRoot())) | 1)
        let r = (w - 1) / 2
        var scratch = [Float](repeating: 0, count: field.count)
        for _ in 0..<3 {
            runningBox(field, into: &scratch, width: width, height: height, radius: r, across: true)
            runningBox(scratch, into: &field, width: width, height: height, radius: r, across: false)
        }
        return field
    }

    /// Step 6: the subject's alpha from the refined `q`, as soft and as shifted as the cutout asks.
    static func edge(_ q: Double, soft: Double, shift: Double) -> Double {
        let t = 0.5 - 0.25 * shift
        let h = 0.06 + 0.44 * soft
        return smoothstep(t - h, t + h, q)
    }

    /// Step 7: the outline's own alpha from the blurred `D` read at a pixel.
    static func outlineAlpha(_ d: Double, sigma: Double) -> Double {
        let spread = outlineSpread(sigma)
        return smoothstep(0.06 - spread, 0.06 + spread, d)
    }

    /// The contract's smoothstep: an edge of no width is a step.
    static func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
        if e1 == e0 { return x < e0 ? 0 : 1 }
        let t = min(1, max(0, (x - e0) / (e1 - e0)))
        return t * t * (3 - 2 * t)
    }
}

// MARK: - Core Image

/// The guide off the frame, and steps 5 to 8 in BUILT-IN Core Image filters - no kernel of our own, for
/// `FocusRender`'s reason: a Metal kernel needs a metallib, and `-fcikernel`, that neither package
/// manager here builds. Every filter runs in the compositor's context, colour management off, so on the
/// stored, gamma-encoded values the contract is written in. What each step is:
///  - THE GUIDE (step 3) is the frame's luma brought down to the grid by halvings - each a scale of
///    one half read LINEARLY, which lands on the corner of four pixels and so is their exact mean - until
///    no more than two of what is left lie across a cell, and then onto the grid with one linear read at
///    each cell's centre: a mean of the pixels round the centre between one and two cells wide, which
///    the contract allows. Read back as one float a cell, first row the top, as the matte's.
///  - A, B AND D go up as one grid of four floats a cell, `(A + B, B, D, 1)`, stretched over the frame
///    with LINEAR sampling and its edges clamped - exactly `TransitionRender.gridImage`'s reading, the
///    bilinear between cell centres that steps 5 and 7 ask for.
///  - `q = A * Y + B` (step 5) is `CIBlendWithMask` of `A + B` over `B` through the pixel's own luma: a
///    linear mix by `Y` is `B + (A + B - B) * Y`, the product with no multiply filter, and then
///    `CIColorClamp`. The values mixed may be below 0 or above 1; the working format is a float one.
///  - SMOOTHSTEP (steps 6 and 7) is a `CIColorMatrix` scaling into the edge, `CIColorClamp`, and the cubic
///    `t * t * (3 - 2t)` as `CIColorPolynomial` (0, 0, 3, -2), `FocusRender`'s ease.
///  - THE ALPHA (step 6) is `CIBlendWithMask` of the frame over clear through the edge: Core Image keeps
///    colour premultiplied, so that is the colour at `a0 = edge * a`, the frame's own alpha folded in.
///  - THE OUTLINE (step 7) is the subject OVER the line colour at alpha `o` - source-over, whose
///    premultiplied sum is the contract's `(C * a0 + L * (1 - a0) * o) / a1` at `a1 = a0 + (1 - a0) * o`.
///  - THE FILL (step 8) is all of that over the fill colour: `mix(F, colour, a1)`, opaque.
enum CutoutRender {
    /// The Rec. 709 luma of `frame`'s own colour on all three channels, opaque, over `rect`.
    /// `CIColorMatrix` unpremultiplies on the way in, so the luma is the straight colour's.
    static func luma(_ frame: CIImage, rect: CGRect) -> CIImage {
        let row = CIVector(x: 0.2126, y: 0.7152, z: 0.0722, w: 0)
        return frame.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": row,
            "inputGVector": row,
            "inputBVector": row,
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        ]).cropped(to: rect)
    }

    /// Step 3: `luma` - `luma(_:rect:)`'s - brought down to a `columns` x `rows` grid and read back into
    /// `guide`, 0...1 a cell, row by row from the TOP. `bitmap` is the read-back's own scratch, four floats
    /// a cell. False only for a grid of no cells.
    static func guide(_ luma: CIImage, rect: CGRect, columns: Int, rows: Int, context: CIContext,
                      bitmap: inout [Float], into guide: inout [Float]) -> Bool {
        guard columns > 0, rows > 0, rect.width >= 1, rect.height >= 1 else { return false }
        let cols = CGFloat(columns), lines = CGFloat(rows)
        var size = rect.size
        var image = luma.transformed(by: CGAffineTransform(translationX: -rect.minX, y: -rect.minY))
        // Halved while more than two of what is left lie across a cell. Each halving is rendered to a
        // buffer of its own (`insertingIntermediate`), or Core Image would fold the scales into one and
        // read a single point where a mean was meant - `TransitionRender.pixelated`'s reason.
        var halvings = 0
        while (size.width > 2 * cols || size.height > 2 * lines) && halvings < 16 {
            let sx: CGFloat = size.width > 2 * cols ? 0.5 : 1
            let sy: CGFloat = size.height > 2 * lines ? 0.5 : 1
            let whole = CGRect(origin: .zero, size: size)
            size = CGSize(width: size.width * sx, height: size.height * sy)
            image = image.cropped(to: whole).clampedToExtent()
                .samplingLinear()
                .transformed(by: CGAffineTransform(scaleX: sx, y: sy))
                .cropped(to: CGRect(origin: .zero, size: size))
                .insertingIntermediate()
            halvings += 1
        }
        let cells = CGRect(x: 0, y: 0, width: columns, height: rows)
        let onto = image.cropped(to: CGRect(origin: .zero, size: size)).clampedToExtent()
            .samplingLinear()
            .transformed(by: CGAffineTransform(scaleX: cols / size.width, y: lines / size.height))
            .cropped(to: cells)
        let count = columns * rows
        if bitmap.count != count * 4 { bitmap = [Float](repeating: 0, count: count * 4) }
        // The four-argument render with `colorSpace: nil`, as the compositor renders its frames. A
        // bitmap's first row is the TOP of `bounds`, the order the matte's rows are in.
        context.render(onto, toBitmap: &bitmap, rowBytes: columns * 16, bounds: cells, format: .RGBAf, colorSpace: nil)
        if guide.count != count { guide = [Float](repeating: 0, count: count) }
        for c in 0..<count {
            let v = bitmap[c * 4]
            guide[c] = v.isFinite ? min(1, max(0, v)) : 0
        }
        return true
    }

    /// The grid the per-pixel steps read, four floats a cell, row by row from the top: `(A + B, B, D, 1)`
    /// - steps 4 and 7 on the CPU (`CutoutMath`). With no `guide`, steps 3 and 4 are skipped and `A` is 0
    /// and `B` the matte, which reads `q` as `m` at every pixel. `D` is 0 with no outline.
    static func gridValues(matte m: [UInt8], guide: [Float]?, columns: Int, rows: Int, outlineSigma: Double?) -> [Float] {
        let cells = columns * rows
        var rgba = [Float](repeating: 1, count: cells * 4)
        guard cells > 0, m.count >= cells else { return rgba }
        if let guide, guide.count >= cells {
            let (a, b) = CutoutMath.refine(matte: m, guide: guide, width: columns, height: rows)
            for c in 0..<cells {
                rgba[c * 4] = a[c] + b[c]
                rgba[c * 4 + 1] = b[c]
            }
        } else {
            for c in 0..<cells {
                let v = Float(Double(m[c]) / 255)
                rgba[c * 4] = v
                rgba[c * 4 + 1] = v
            }
        }
        if let outlineSigma {
            let d = CutoutMath.outlineField(m, width: columns, height: rows, sigma: outlineSigma)
            for c in 0..<cells { rgba[c * 4 + 2] = d[c] }
        } else {
            for c in 0..<cells { rgba[c * 4 + 2] = 0 }
        }
        return rgba
    }

    /// `values` - `gridValues`' - as an image of one pixel a cell, its first row the TOP, as a bitmap's is
    /// to Core Image. Opaque, so premultiplied and straight are the same numbers.
    static func gridImage(_ values: [Float], columns: Int, rows: Int) -> CIImage {
        let data = values.withUnsafeBufferPointer { Data(buffer: $0) }
        return CIImage(bitmapData: data, bytesPerRow: columns * 16, size: CGSize(width: columns, height: rows),
                       format: .RGBAf, colorSpace: nil)
    }

    /// `grid` stretched over `rect` and read LINEARLY between cell centres, its outermost cells held out to
    /// the edges: `TransitionRender.gridImage`'s stretch.
    static func stretched(_ grid: CIImage, columns: Int, rows: Int, over rect: CGRect) -> CIImage {
        let stretch = CGAffineTransform(scaleX: rect.width / CGFloat(columns), y: rect.height / CGFloat(rows))
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY))
        return grid.clampedToExtent()
            .samplingLinear()
            .transformed(by: stretch)
            .cropped(to: rect)
    }

    /// Steps 5 to 8 on `frame` (premultiplied, as Core Image keeps it), over `rect`: `luma` is
    /// `luma(_:rect:)` of the frame, `grid` the stretched `(A + B, B, D, 1)`, and `outline` the line's
    /// colour and its edge's spread, or nil. Transparent where the background was, unless there is a fill.
    static func cutOut(_ frame: CIImage, luma: CIImage, grid: CIImage, soft: Double, shift: Double,
                       fill: ComposeRGB?, outline: (color: ComposeRGB, spread: Double)?, rect: CGRect) -> CIImage {
        // Step 5: q = B + A * Y, as the mix of B and A + B by Y, held to 0...1.
        let q = channel(grid, 0)
            .applyingFilter("CIBlendWithMask", parameters: [
                "inputBackgroundImage": channel(grid, 1),
                "inputMaskImage": luma,
            ])
            .applyingFilter("CIColorClamp")
            .cropped(to: rect)
        // Step 6: a0 = smoothstep(t - h, t + h, q) * a.
        let t = 0.5 - 0.25 * shift
        let h = 0.06 + 0.44 * soft
        let edge = smoothstep(q, from: t - h, to: t + h, rect: rect)
        let clear = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)).cropped(to: rect)
        var out = frame
            .applyingFilter("CIBlendWithMask", parameters: [
                "inputBackgroundImage": clear,
                "inputMaskImage": edge,
            ])
            .cropped(to: rect)
        // Step 7: the subject over the line at alpha o = smoothstep(0.06 - d, 0.06 + d, D).
        if let outline {
            let o = smoothstep(channel(grid, 2), from: 0.06 - outline.spread, to: 0.06 + outline.spread, rect: rect)
            let line = solid(outline.color, rect)
                .applyingFilter("CIBlendWithMask", parameters: [
                    "inputBackgroundImage": clear,
                    "inputMaskImage": o,
                ])
                .cropped(to: rect)
            out = out.composited(over: line)
        }
        // Step 8: all of it over the fill, which makes it opaque.
        if let fill {
            out = out.composited(over: solid(fill, rect))
        }
        return out.cropped(to: rect)
    }

    /// Channel `index` (0 red, 1 green, 2 blue) of an opaque image on all three, alpha 1.
    private static func channel(_ image: CIImage, _ index: Int) -> CIImage {
        let pick = CIVector(x: index == 0 ? 1 : 0, y: index == 1 ? 1 : 0, z: index == 2 ? 1 : 0, w: 0)
        return image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": pick,
            "inputGVector": pick,
            "inputBVector": pick,
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 0),
        ])
    }

    /// `smoothstep(e0, e1, v)` on the three channels of an opaque grey image, alpha 1: scaled into the
    /// edge and clamped, then the cubic. `e1 > e0` always here: `2h` is at least 0.12, and `2d` above 0.
    private static func smoothstep(_ image: CIImage, from e0: Double, to e1: Double, rect: CGRect) -> CIImage {
        let k = CGFloat(1 / (e1 - e0))
        let c = CGFloat(-e0 / (e1 - e0))
        let scaled = image
            .applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: k, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: k, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: k, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                "inputBiasVector": CIVector(x: c, y: c, z: c, w: 0),
            ])
            .applyingFilter("CIColorClamp")
            // A non-zero bias is defined over the infinite plane: back to the frame.
            .cropped(to: rect)
        let cubic = CIVector(x: 0, y: 0, z: 3, w: -2)
        return scaled.applyingFilter("CIColorPolynomial", parameters: [
            "inputRedCoefficients": cubic,
            "inputGreenCoefficients": cubic,
            "inputBlueCoefficients": cubic,
            "inputAlphaCoefficients": CIVector(x: 1, y: 0, z: 0, w: 0),
        ])
    }

    /// An opaque colour over `rect`.
    private static func solid(_ rgb: ComposeRGB, _ rect: CGRect) -> CIImage {
        CIImage(color: CIColor(red: CGFloat(rgb.r), green: CGFloat(rgb.g), blue: CGFloat(rgb.b))).cropped(to: rect)
    }
}
