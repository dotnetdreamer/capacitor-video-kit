@preconcurrency import AVFoundation
import CoreImage
import Metal
import XCTest
@testable import CapacitorVideoKitCore

/// A clip's focus in the render: the Core Image pass held to the contract's arithmetic in double
/// precision, the source time a frame is focused at for every shape of clip the builder lays, and
/// renders end to end - a subject kept in colour while the rest goes grey or dark, on the base track, a
/// layer, a transition's outgoing side, a picture and a slowed clip - and the pre-flight that refuses a
/// track it cannot read.
final class FocusRenderTests: RenderTestCase {

    // MARK: - Helpers

    /// A subject track of `frames` over a `width` x `height` grid, at `times`, written where `name` says.
    private func track(_ name: String, width: Int = 32, height: Int = 24, times: [Double] = [0],
                       frames: [[UInt8]]) throws -> URL {
        let url = file(name)
        let meta = SubjectTrackMeta(engine: "vision", kind: "video", durationMs: 1000, fps: 15, subjects: [])
        try SubjectTrack.encode(SubjectTrackContent(width: width, height: height, times: times, frames: frames, meta: meta))
            .write(to: url)
        return url
    }

    /// A grid with columns `0..<split` holding `left` and the rest `right`.
    private func halves(_ left: UInt8, _ right: UInt8, width: Int = 32, height: Int = 24, split: Int? = nil) -> [UInt8] {
        let at = split ?? width / 2
        return (0..<(width * height)).map { $0 % width < at ? left : right }
    }

    private func focus(_ track: URL, atMs: [Double] = [0], subjects: [[String: Any]] = [["id": 1, "focus": [1]]],
                       _ looks: [String: Any]) -> [String: Any] {
        var f: [String: Any] = ["uri": track.absoluteString, "atMs": atMs, "subjects": subjects]
        for (k, v) in looks { f[k] = v }
        return f
    }

    /// The compositor's frames for `options`, read as `WriterEngine` reads a render - the pixels an
    /// encoder is handed - so a colour is measured as it was drawn rather than through H.264 and back.
    private func composed(_ options: [String: Any]) async throws -> [ComposedFrame] {
        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        return try TestComposed.frames(try await CompositionBuilder.build(spec))
    }

    /// The colour drawn at (`x`, `y`) of the frame nearest `seconds`, fractions with a top-left origin,
    /// averaged over a 5 x 5 square.
    private func colour(_ frames: [ComposedFrame], at seconds: Double, x: Double, y: Double = 0.5) -> SIMD3<Double> {
        let frame = frames.min { abs($0.seconds - seconds) < abs($1.seconds - seconds) }!
        let cx = Int(Double(frame.width) * x), cy = Int(Double(frame.height) * y)
        var sum = SIMD3<Double>(0, 0, 0)
        var n = 0.0
        for py in max(0, cy - 2)...min(frame.height - 1, cy + 2) {
            for px in max(0, cx - 2)...min(frame.width - 1, cx + 2) {
                let i = (py * frame.width + px) * 4
                sum += SIMD3<Double>(Double(frame.bgra[i + 2]), Double(frame.bgra[i + 1]), Double(frame.bgra[i]))
                n += 1
            }
        }
        return sum / n
    }

    private func luma(_ c: SIMD3<Double>) -> Double { 0.2126 * c.x + 0.7152 * c.y + 0.0722 * c.z }

    /// `c` is `source` turned grey - its Rec. 709 luma on all three channels - to within a couple of code
    /// values. `source` is the footage's colour as the decoder handed it to the compositor, which is not
    /// the colour the test media was written with: H.264 does not hand pure red back as pure red.
    private func assertGrey(_ c: SIMD3<Double>, of source: SIMD3<Double>, file: StaticString = #filePath, line: UInt = #line) {
        let y = luma(source)
        for v in [c.x, c.y, c.z] {
            XCTAssertEqual(v, y, accuracy: 2.5, "expected \(source) turned to the grey \(y), got \(c)", file: file, line: line)
        }
    }

    private func assertSame(_ c: SIMD3<Double>, _ expected: SIMD3<Double>, tolerance: Double = 2.5,
                            file: StaticString = #filePath, line: UInt = #line) {
        let d = c - expected
        XCTAssertLessThanOrEqual(max(abs(d.x), abs(d.y), abs(d.z)), tolerance, "expected \(expected), got \(c)",
                                 file: file, line: line)
    }

    /// Red as the decoder hands over the test media's red: strongly red, whatever its exact numbers.
    private func assertRed(_ c: SIMD3<Double>, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(c.x > 190 && c.y < 70 && c.z < 70, "expected red, got \(c)", file: file, line: line)
    }

    /// A video whose every frame is `left` on the columns before `split` (a fraction) and `right` after.
    private func twoColours(_ name: String, durationMs: Int64 = 1000, width: Int = 320, height: Int = 240,
                            left: TestMedia.RGB, right: TestMedia.RGB, split: Double = 0.5,
                            transform: CGAffineTransform = .identity) async throws -> URL {
        let count = Int(durationMs * 30 / 1000)
        var rgba = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width {
                let c = Double(x) < split * Double(width) ? left : right
                let i = (y * width + x) * 4
                rgba[i] = UInt8(c.r); rgba[i + 1] = UInt8(c.g); rgba[i + 2] = UInt8(c.b)
            }
        }
        return try await TestMedia.frames(file(name), width: width, height: height, times: TestMedia.evenTimes(count),
                                          transform: transform) { _ in rgba }
    }

    // MARK: - The Core Image pass against the contract

    /// The contract's steps 4 to 8 in double precision, on a frame of `width` x `height` RGB values
    /// and a `columns` x `rows` grid, both row by row from the top.
    private func reference(_ frame: [SIMD3<Double>], width: Int, height: Int, grid: [UInt8], columns: Int, rows: Int,
                           blur: Double, mono: Double, dim: Double) -> [SIMD3<Double>] {
        func m(_ x: Int, _ y: Int) -> Double {
            // Bilinear between cell centres, the grid's edges clamped.
            let u = (Double(x) + 0.5) * Double(columns) / Double(width) - 0.5
            let v = (Double(y) + 0.5) * Double(rows) / Double(height) - 0.5
            let x0 = Int(u.rounded(.down)), y0 = Int(v.rounded(.down))
            let fx = u - Double(x0), fy = v - Double(y0)
            func cell(_ cx: Int, _ cy: Int) -> Double {
                Double(grid[min(rows - 1, max(0, cy)) * columns + min(columns - 1, max(0, cx))]) / 255
            }
            let top: Double = (1 - fx) * cell(x0, y0) + fx * cell(x0 + 1, y0)
            let bottom: Double = (1 - fx) * cell(x0, y0 + 1) + fx * cell(x0 + 1, y0 + 1)
            return (1 - fy) * top + fy * bottom
        }
        let count = width * height
        var e = [Double](repeating: 0, count: count)
        for y in 0..<height { for x in 0..<width { let v = m(x, y); e[y * width + x] = v * v * (3 - 2 * v) } }
        var soft = frame
        if blur > 0 {
            let sigma = blur * Double(min(width, height))
            let radius = Int((4 * sigma).rounded(.up))
            let kernel = (-radius...radius).map { exp(-Double($0 * $0) / (2 * sigma * sigma)) }
            let total = kernel.reduce(0, +)
            // Separable, edges clamped: across, then down, on (C * w, w).
            var num: [SIMD3<Double>] = (0..<count).map { (i: Int) -> SIMD3<Double> in frame[i] * (1 - e[i]) }
            var den: [Double] = (0..<count).map { (i: Int) -> Double in 1 - e[i] }
            func pass(_ step: (Int, Int)) {
                var n2 = num, d2 = den
                for y in 0..<height {
                    for x in 0..<width {
                        var sn = SIMD3<Double>(0, 0, 0), sd = 0.0
                        for k in -radius...radius {
                            let xx = min(width - 1, max(0, x + k * step.0)), yy = min(height - 1, max(0, y + k * step.1))
                            let wk = kernel[k + radius] / total
                            sn += num[yy * width + xx] * wk
                            sd += den[yy * width + xx] * wk
                        }
                        n2[y * width + x] = sn
                        d2[y * width + x] = sd
                    }
                }
                num = n2
                den = d2
            }
            pass((1, 0))
            pass((0, 1))
            for i in 0..<count where den[i] >= 1.0 / 1024 { soft[i] = num[i] / den[i] }
        }
        return (0..<count).map { (i: Int) -> SIMD3<Double> in
            var b: SIMD3<Double> = soft[i]
            let luma: Double = 0.2126 * b.x + 0.7152 * b.y + 0.0722 * b.z
            let grey = SIMD3<Double>(repeating: luma)
            b = b * (1 - mono) + grey * mono
            b *= (1 - dim)
            let out: SIMD3<Double> = b * (1 - e[i]) + frame[i] * e[i]
            return SIMD3<Double>(min(1, max(0, out.x)), min(1, max(0, out.y)), min(1, max(0, out.z)))
        }
    }

    /// `FocusRender.focused` on `frame`, rendered through a context configured as the compositor's.
    private func rendered(_ frame: [SIMD3<Double>], width: Int, height: Int, grid: [UInt8], columns: Int, rows: Int,
                          blur: Double, mono: Double, dim: Double) -> [SIMD3<Double>] {
        let ci = EditCompositor.context(on: MTLCreateSystemDefaultDevice())
        var input = [Float](repeating: 1, count: width * height * 4)
        for (i, c) in frame.enumerated() {
            input[i * 4] = Float(c.x); input[i * 4 + 1] = Float(c.y); input[i * 4 + 2] = Float(c.z)
        }
        let image = CIImage(bitmapData: input.withUnsafeBytes { Data($0) }, bytesPerRow: width * 16,
                            size: CGSize(width: width, height: height), format: .RGBAf, colorSpace: nil)
        let focused = FocusRender.focused(image, mask: grid, columns: columns, rows: rows, blur: blur, mono: mono, dim: dim)
        var out = [Float](repeating: 0, count: width * height * 4)
        ci.render(focused, toBitmap: &out, rowBytes: width * 16, bounds: CGRect(x: 0, y: 0, width: width, height: height),
                  format: .RGBAf, colorSpace: nil)
        return (0..<(width * height)).map { (i: Int) -> SIMD3<Double> in
            let r = Double(out[i * 4]), g = Double(out[i * 4 + 1]), b = Double(out[i * 4 + 2])
            return SIMD3<Double>(r, g, b)
        }
    }

    /// A frame with detail everywhere: two colours either side of the middle, a stripe of a third
    /// through them, and a ramp down the frame.
    private func patterned(width: Int, height: Int) -> [SIMD3<Double>] {
        (0..<(width * height)).map { (i: Int) -> SIMD3<Double> in
            let x = i % width, y = i / width
            let ramp = Double(y) / Double(height - 1)
            if x % 16 < 3 { return SIMD3<Double>(0.95, 0.9, 0.2) }
            if x < width / 2 { return SIMD3<Double>(0.85, 0.15 + 0.3 * ramp, 0.1) }
            return SIMD3<Double>(0.1, 0.35, 0.9 - 0.5 * ramp)
        }
    }

    private func largestDifference(_ a: [SIMD3<Double>], _ b: [SIMD3<Double>]) -> Double {
        var most = 0.0
        for (p, q) in zip(a, b) {
            let d: SIMD3<Double> = p - q
            most = max(most, abs(d.x), abs(d.y), abs(d.z))
        }
        return most
    }

    func testTheCoreImagePassIsTheContractToWithinWhatAFrameShows() {
        // The weighted blur divides one blurred number by another, which only holds in a float working
        // format: 8-bit intermediates would turn a small weight's quantisation into a wrong colour.
        let format = EditCompositor.context(on: MTLCreateSystemDefaultDevice()).workingFormat
        XCTAssertTrue(format == .RGBAh || format == .RGBAf, "working format \(format.rawValue)")

        let width = 64, height = 48, columns = 8, rows = 6
        let frame = patterned(width: width, height: height)
        // A subject in the middle-left, a half-focused cell beside it, and a lone cell near the top edge.
        var grid = [UInt8](repeating: 0, count: columns * rows)
        for cy in 1...4 { for cx in 1...3 { grid[cy * columns + cx] = 255 } }
        grid[2 * columns + 4] = 128
        grid[6] = 200
        for (blur, mono, dim, tolerance) in [(0.05, 0.0, 0.0, 0.012), (0.08, 0.5, 0.25, 0.012),
                                             (0.0, 1.0, 0.0, 0.006), (0.0, 0.3, 0.6, 0.006), (0.02, 1.0, 1.0, 0.012)] {
            let ours = rendered(frame, width: width, height: height, grid: grid, columns: columns, rows: rows,
                                blur: blur, mono: mono, dim: dim)
            let theirs = reference(frame, width: width, height: height, grid: grid, columns: columns, rows: rows,
                                   blur: blur, mono: mono, dim: dim)
            XCTAssertLessThanOrEqual(largestDifference(ours, theirs), tolerance, "blur \(blur) mono \(mono) dim \(dim)")
        }
    }

    func testDeepInsideASubjectTheFrameIsKeptAndNothingDividesByNothing() {
        let width = 40, height = 40
        let frame = patterned(width: width, height: height)
        // Everything in focus but one corner cell: almost every blurred weight is zero.
        var grid = [UInt8](repeating: 255, count: 16)
        grid[15] = 0
        let ours = rendered(frame, width: width, height: height, grid: grid, columns: 4, rows: 4, blur: 0.02, mono: 0, dim: 0)
        XCTAssertTrue(ours.allSatisfy { $0.x.isFinite && $0.y.isFinite && $0.z.isFinite })
        let theirs = reference(frame, width: width, height: height, grid: grid, columns: 4, rows: 4, blur: 0.02, mono: 0, dim: 0)
        // A sigma under a pixel is where Core Image's Gaussian strays furthest from the real one - still
        // under five code values, and only beside the one soft cell.
        XCTAssertLessThanOrEqual(largestDifference(ours, theirs), 0.02)
        // The top-left, far from the one soft cell, is the frame exactly.
        XCTAssertLessThanOrEqual(largestDifference(Array(ours[0..<5]), Array(frame[0..<5])), 0.002)
    }

    // MARK: - Source time

    private func clip(inMs: Int64, outMs: Int64, speed: Double = 1, focus: ComposeFocus) -> ComposeClip {
        ComposeClip(key: "a", uri: "file:///a.mp4", inMs: inMs, outMs: outMs, speed: speed, volume: 1, muted: false,
                    fit: .cover, crop: nil, rect: nil, transitionIn: nil, image: false, focus: focus)
    }

    private func range(_ fromMs: Double, _ toMs: Double) -> CMTimeRange {
        CMTimeRange(start: CMTime(value: CMTimeValue(fromMs * 1000), timescale: 1_000_000),
                    end: CMTime(value: CMTimeValue(toMs * 1000), timescale: 1_000_000))
    }

    func testAFrameIsFocusedAtTheSourceInstantItShowsHeldToTheClipsTrim() throws {
        let subjects = try SubjectTrack.parse(try Data(contentsOf: try track("t.vkst", frames: [halves(1, 0)])))
        let focus = ComposeFocus(uri: "x", atMs: [0], subjects: [], blur: 0.01, mono: 0, dim: 0, invert: false)

        // Trimmed to 1000...3000 at 2x, placed at 5 s of the post for a second.
        let fast = try FocusClip(clip: clip(inMs: 1000, outMs: 3000, speed: 2, focus: focus), focus: focus, track: subjects,
                                 inserted: range(1000, 3000), placed: range(5000, 6000))
        XCTAssertEqual(fast.sourceMs(atUs: 5_000_000), 1000, accuracy: 1e-6)
        XCTAssertEqual(fast.sourceMs(atUs: 5_500_000), 2000, accuracy: 1e-6)
        XCTAssertEqual(fast.sourceMs(atUs: 5_966_667), 2933.334, accuracy: 1e-3)
        // Never outside the trim: before its first instant, and at or past the end of what was inserted.
        XCTAssertEqual(fast.sourceMs(atUs: 4_000_000), 1000, accuracy: 1e-6)
        XCTAssertEqual(fast.sourceMs(atUs: 6_000_000), 2999.999, accuracy: 1e-6)

        // The builder's millisecond rounding is in the ranges, so the line is the one the composition plays.
        let slow = try FocusClip(clip: clip(inMs: 0, outMs: 1000, speed: 0.3, focus: focus), focus: focus, track: subjects,
                                 inserted: range(0, 1000), placed: range(0, 3333))
        XCTAssertEqual(slow.sourceMs(atUs: 3_333_000), 999.999, accuracy: 1e-6)
        XCTAssertEqual(slow.sourceMs(atUs: 1_666_500), 500, accuracy: 1e-6)

        // Held on its footage's last frame: an in-point past the end of the file, its inserted range the
        // last frame before it. Every instant is the in-point, where the web puts it.
        let held = try FocusClip(clip: clip(inMs: 5000, outMs: 6000, focus: focus), focus: focus, track: subjects,
                                 inserted: range(966.667, 1000), placed: range(2000, 2001))
        XCTAssertEqual(held.sourceMs(atUs: 2_000_000), 5000)
        XCTAssertEqual(held.sourceMs(atUs: 2_000_900), 5000)
    }

    func testTheMaskIsReadAtThatInstant() throws {
        // Subject 1 on the left in the track's first frame, on the right in its second, a second apart.
        let subjects = try SubjectTrack.parse(try Data(contentsOf: try track("t.vkst", times: [0, 1000],
                                                                            frames: [halves(1, 0), halves(0, 1)])))
        let focus = ComposeFocus(uri: "x", atMs: [0], subjects: [ComposeFocusSubject(id: 1, focus: [1])], blur: 0.01,
                                 mono: 0, dim: 0, invert: false)
        let clipped = try FocusClip(clip: clip(inMs: 0, outMs: 1000, focus: focus), focus: focus, track: subjects,
                                    inserted: range(0, 1000), placed: range(0, 1000))
        XCTAssertEqual(try clipped.mask(atUs: 0)[0], 255)
        XCTAssertEqual(try clipped.mask(atUs: 0)[31], 0)
        // Half way between the two frames, every cell is half in focus.
        XCTAssertEqual(try clipped.mask(atUs: 500_000)[0], 128)
        XCTAssertEqual(try clipped.mask(atUs: 500_000)[31], 128)
    }

    // MARK: - End to end

    func testASubjectKeepsItsColourWhileTheRestTurnsGrey() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let subjects = try track("red.vkst", frames: [halves(1, 0)])
        var clip = TestSpecs.clip("a", red, outMs: 1000)
        clip["focus"] = focus(subjects, ["blur": 0, "mono": 1])
        let options = TestSpecs.spec([clip], width: 320, height: 240)

        // As drawn: the subject is the footage untouched - the same pixels as with no focus at all - and
        // the rest is that colour's Rec. 709 luma, to a code value or two.
        var plain = clip
        plain["focus"] = nil
        let footage = colour(try await composed(TestSpecs.spec([plain], width: 320, height: 240)), at: 0.5, x: 0.2)
        let frames = try await composed(options)
        assertSame(colour(frames, at: 0.5, x: 0.2), footage)
        assertGrey(colour(frames, at: 0.5, x: 0.8), of: footage)

        // And through the encoder, end to end: red on the left, a grey on the right.
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))
        let subject = try await TestMedia.color(of: out, at: 0.5, x: 0.2)
        XCTAssertTrue(subject.near(.red), "the subject keeps its colour, got \(subject)")
        let rest = try await TestMedia.color(of: out, at: 0.5, x: 0.8)
        XCTAssertLessThanOrEqual(max(rest.r, rest.g, rest.b) - min(rest.r, rest.g, rest.b), 12, "expected grey, got \(rest)")
        XCTAssertLessThan(rest.r, 140, "expected grey, got \(rest)")
    }

    func testBlurredTheSubjectsColourDoesNotBleedIntoTheRest() async throws {
        // Red on the left - the subject - and green on the right.
        let video = try await twoColours("two.mp4", left: .red, right: .green)
        let subjects = try track("two.vkst", frames: [halves(1, 0)])
        let plain = colourOf(try await composed(TestSpecs.spec([TestSpecs.clip("a", video, outMs: 1000)], width: 320, height: 240)))
        var clip = TestSpecs.clip("a", video, outMs: 1000)
        clip["focus"] = focus(subjects, ["blur": 0.05])
        let focused = colourOf(try await composed(TestSpecs.spec([clip], width: 320, height: 240)))

        // The subject is sharp: its own pixels, right up to the cell its edge is eased across.
        assertSame(focused(0.4), plain(0.4))
        // Ten pixels past its edge, in the softened world. A sigma of 12 that weighed the subject in would
        // carry a fifth of its red here - some 35 code values over the green's own; weighted out, next to
        // none of it does.
        XCTAssertLessThan(focused(0.53).x - plain(0.53).x, 12, "the subject's colour bled: \(focused(0.53)) against \(plain(0.53))")
        XCTAssertEqual(focused(0.53).y, plain(0.53).y, accuracy: 12)
        // Far from the subject, a blur of one colour is that colour.
        assertSame(focused(0.9), plain(0.9), tolerance: 3)
    }

    /// The colour at `x` of the middle row, half a second in.
    private func colourOf(_ frames: [ComposedFrame]) -> (Double) -> SIMD3<Double> {
        { x in self.colour(frames, at: 0.5, x: x) }
    }

    func testDarkenedAllTheWayWhatIsOutOfFocusIsBlackBlurredOrNot() async throws {
        let video = try await twoColours("two.mp4", left: .red, right: .green)
        let subjects = try track("two.vkst", frames: [halves(1, 0)])
        let plain = colourOf(try await composed(TestSpecs.spec([TestSpecs.clip("a", video, outMs: 1000)], width: 320, height: 240)))
        for looks: [String: Any] in [["dim": 1], ["blur": 0.02, "dim": 1], ["blur": 0.02, "mono": 0.5, "dim": 1]] {
            var clip = TestSpecs.clip("a", video, outMs: 1000)
            clip["focus"] = focus(subjects, looks)
            let dark = colourOf(try await composed(TestSpecs.spec([clip], width: 320, height: 240)))
            assertSame(dark(0.85), SIMD3(0, 0, 0), tolerance: 1)
            assertSame(dark(0.15), plain(0.15))
        }
        // Half dark is half the colour.
        var half = TestSpecs.clip("a", video, outMs: 1000)
        half["focus"] = focus(subjects, ["dim": 0.5])
        let dimmed = colourOf(try await composed(TestSpecs.spec([half], width: 320, height: 240)))
        assertSame(dimmed(0.85), plain(0.85) * 0.5, tolerance: 1.5)
    }

    func testAFrameWhollyInFocusIsTheFootage() async throws {
        let video = try await twoColours("two.mp4", left: .red, right: .green)
        let everywhere = try track("all.vkst", frames: [halves(1, 1)])
        let plain = try await composed(TestSpecs.spec([TestSpecs.clip("a", video, outMs: 1000)], width: 320, height: 240))
        var clip = TestSpecs.clip("a", video, outMs: 1000)
        clip["focus"] = focus(everywhere, ["blur": 0.05, "mono": 1, "dim": 0.5])
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240))
        XCTAssertEqual(frames[15].largestDifference(plain[15]), 0)
    }

    func testInvertSoftensTheSubjectsAndKeepsTheRest() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let subjects = try track("red.vkst", frames: [halves(1, 0)])
        var clip = TestSpecs.clip("a", red, outMs: 1000)
        clip["focus"] = focus(subjects, ["mono": 1, "invert": true])
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240))
        let rest = colour(frames, at: 0.5, x: 0.8)
        assertRed(rest)
        assertGrey(colour(frames, at: 0.5, x: 0.2), of: rest)
    }

    func testAFocusIsReadAtTheSourceTimeOfATrimmedAndSpedUpClip() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 4000, color: .red, audio: false)
        // Subject 1 on the left and 2 on the right, all through the file. The focus steps from 1 to 2 at
        // 2000 ms of the SOURCE.
        let subjects = try track("red.vkst", frames: [halves(1, 2)])
        var clip = TestSpecs.clip("a", red, inMs: 1000, outMs: 3000, ["speed": 2])
        clip["focus"] = focus(subjects, atMs: [2000, 2000],
                              subjects: [["id": 1, "focus": [1, 0]], ["id": 2, "focus": [0, 1]]], ["mono": 1])
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240))
        XCTAssertEqual(frames.count, 30, "a second of output")

        // A quarter of a second in is 1500 ms of the source, before the step: subject 1 in colour.
        let early = colour(frames, at: 0.25, x: 0.2)
        assertRed(early)
        assertGrey(colour(frames, at: 0.25, x: 0.8), of: early)
        // Three quarters in is 2500 ms, after it: subject 2. Read off output time, or without the
        // in-point, or at 1x, it would still be subject 1.
        let late = colour(frames, at: 0.75, x: 0.8)
        assertRed(late)
        assertGrey(colour(frames, at: 0.75, x: 0.2), of: late)
    }

    func testTheTracksOwnFramesAreReadAtTheSourceTimeToo() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 4000, color: .red, audio: false)
        // Subject 1 on the left until 3000 ms of the source, and on the right from then on.
        let subjects = try track("red.vkst", times: [0, 3000], frames: [halves(1, 0), halves(0, 1)])
        var clip = TestSpecs.clip("a", red, inMs: 3000, outMs: 4000)
        clip["focus"] = focus(subjects, ["mono": 1])
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240))
        let subject = colour(frames, at: 0.3, x: 0.8)
        assertRed(subject)
        assertGrey(colour(frames, at: 0.3, x: 0.2), of: subject)
    }

    func testASlowedClipsSynthesisedFramesAreFocused() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let subjects = try track("red.vkst", frames: [halves(1, 0)])
        var clip = TestSpecs.clip("a", red, outMs: 1000, ["speed": 0.5])
        clip["focus"] = focus(subjects, ["blur": 0.01, "mono": 1])
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240))
        XCTAssertEqual(frames.count, 60, "two seconds of output")
        for at in [0.5, 1.017, 1.5] {
            let subject = colour(frames, at: at, x: 0.2)
            assertRed(subject)
            assertGrey(colour(frames, at: at, x: 0.8), of: subject)
        }
    }

    func testATransitionsOutgoingSideCarriesItsOwnFocus() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let blue = try await TestMedia.video(file("blue.mp4"), durationMs: 1000, color: .blue, audio: false)
        let subjects = try track("red.vkst", frames: [halves(1, 0)])
        let redFocus = focus(subjects, ["mono": 1])
        var outgoing = TestSpecs.clip("a", red, outMs: 600)
        outgoing["focus"] = redFocus
        var tail = TestSpecs.clip("a", red, inMs: 600, outMs: 1000)
        tail["focus"] = redFocus
        let incoming = TestSpecs.clip("b", blue, outMs: 1000, ["transitionIn": ["kind": "dissolve", "from": tail,
                                                                                "curves": ["alpha": [0.0, 1.0]]]])
        let frames = try await composed(TestSpecs.spec([outgoing, incoming], width: 320, height: 240))
        // The window's first frame is the outgoing side alone: its own focus, in its own source's time.
        let subject = colour(frames, at: 0.6, x: 0.2)
        assertRed(subject)
        assertGrey(colour(frames, at: 0.6, x: 0.8), of: subject)
        // Before the window, the same clip on the base track, focused the same way.
        assertGrey(colour(frames, at: 0.3, x: 0.8), of: colour(frames, at: 0.3, x: 0.2))
        // The incoming side has none.
        let after = colour(frames, at: 1.2, x: 0.8)
        XCTAssertTrue(after.z > 190 && after.x < 70, "expected the incoming side's blue, got \(after)")
    }

    func testALayersClipCarriesItsFocusInsideItsOwnRectangle() async throws {
        let blue = try await TestMedia.video(file("blue.mp4"), durationMs: 1000, color: .blue, audio: false)
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let subjects = try track("red.vkst", frames: [halves(1, 0)])
        // The layer over the right half of the frame, covering it: its own left half is its subject.
        var layer = TestSpecs.clip("p", red, outMs: 1000, fit: "cover", ["rect": ["x": 0.5, "y": 0, "w": 0.5, "h": 1]])
        layer["focus"] = focus(subjects, ["mono": 1])
        let frames = try await composed(TestSpecs.spec([TestSpecs.clip("a", blue, outMs: 1000)], width: 320, height: 240,
                                                       ["tracks": [["id": "pip", "z": 1, "clips": [layer]]]]))
        let base = colour(frames, at: 0.5, x: 0.2)
        XCTAssertTrue(base.z > 190 && base.x < 70, "the base has no focus: \(base)")
        let subject = colour(frames, at: 0.5, x: 0.6)
        assertRed(subject)
        assertGrey(colour(frames, at: 0.5, x: 0.92), of: subject)
    }

    func testAPictureIsFocusedThroughItsOneFrame() async throws {
        let picture = try TestMedia.picture(file("red.png"), type: .png, left: .red, middle: .red, right: .red)
        // 600 x 400, so the track's grid is 30 x 20.
        let subjects = try track("red.vkst", width: 30, height: 20, frames: [halves(1, 0, width: 30, height: 20)])
        var clip = TestSpecs.clip("p", picture, outMs: 800, ["image": true, "muted": true])
        clip["focus"] = focus(subjects, ["mono": 1])
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240))
        for at in [0.1, 0.7] {
            let subject = colour(frames, at: at, x: 0.2)
            assertRed(subject)
            assertGrey(colour(frames, at: at, x: 0.8), of: subject)
        }
    }

    func testAFocusIsOnTheUprightPictureOfATurnedRecording() async throws {
        // Stored 320 x 240 with red on its left, and turned a quarter clockwise as a phone held upright
        // writes it: upright it is 240 x 320 with red on TOP. The track is over the upright frame.
        let video = try await twoColours("turned.mp4", left: .red, right: .green,
                                         transform: CGAffineTransform(rotationAngle: .pi / 2))
        let topHalf = (0..<(24 * 32)).map { UInt8($0 / 24 < 16 ? 1 : 0) }
        let subjects = try track("turned.vkst", width: 24, height: 32, frames: [topHalf])
        let plain = try await composed(TestSpecs.spec([TestSpecs.clip("a", video, outMs: 1000)], width: 240, height: 320))
        var clip = TestSpecs.clip("a", video, outMs: 1000)
        clip["focus"] = focus(subjects, ["mono": 1])
        let frames = try await composed(TestSpecs.spec([clip], width: 240, height: 320))
        let top = colour(frames, at: 0.5, x: 0.5, y: 0.2)
        assertRed(top)
        assertSame(top, colour(plain, at: 0.5, x: 0.5, y: 0.2))
        assertGrey(colour(frames, at: 0.5, x: 0.5, y: 0.8), of: colour(plain, at: 0.5, x: 0.5, y: 0.8))
    }

    // MARK: - The pre-flight

    private func buildFailure(_ options: [String: Any], file: StaticString = #filePath, line: UInt = #line) async -> ComposeFailure? {
        do {
            let spec = try TestCalls.parse(options)
            _ = try await CompositionBuilder.build(spec)
            XCTFail("the build should have failed", file: file, line: line)
            return nil
        } catch {
            return ErrorMapping.failure(for: error, stopReason: nil)
        }
    }

    func testATrackThatCannotBeReadFailsTheRenderAsUnreadableNamingTheClip() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let garbage = file("garbage.vkst")
        try Data("not a subject track at all".utf8).write(to: garbage)
        for (name, uri) in [("missing", file("never.vkst")), ("garbage", garbage)] {
            var focused = TestSpecs.clip("b", red, outMs: 1000)
            focused["focus"] = focus(uri, ["mono": 1])
            let failure = await buildFailure(TestSpecs.spec([TestSpecs.clip("a", red, outMs: 1000), focused]))
            XCTAssertEqual(failure?.code, .unreadableInput, name)
            XCTAssertEqual(failure?.clipKey, "b", name)
            XCTAssertTrue(failure?.message.hasPrefix("subject track:") == true, "\(name): \(failure?.message ?? "")")
        }
    }

    func testADamagedFrameFailsTheRenderOnlyWhereTheClipCanReachIt() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 3000, color: .red, audio: false)
        // Three frames at 0, 1000 and 2000 ms; the LAST one's first run made too long.
        var bytes = [UInt8](try Data(contentsOf: try track("damaged.vkst", times: [0, 1000, 2000],
                                                           frames: [halves(1, 0), halves(1, 0), halves(1, 0)])))
        let json = Int(bytes[16]) | Int(bytes[17]) << 8
        let offsetsAt = 20 + json + 12
        let last = Int(bytes[offsetsAt + 8]) | Int(bytes[offsetsAt + 9]) << 8
        bytes[20 + json + 24 + last + 1] &+= 1
        try Data(bytes).write(to: file("damaged.vkst"))

        var reaching = TestSpecs.clip("late", red, inMs: 1500, outMs: 3000)
        reaching["focus"] = focus(file("damaged.vkst"), ["mono": 1])
        let failure = await buildFailure(TestSpecs.spec([reaching]))
        XCTAssertEqual(failure?.code, .unreadableInput)
        XCTAssertEqual(failure?.clipKey, "late")

        // A clip trimmed to the first second never draws the damaged frame, and renders.
        var early = TestSpecs.clip("early", red, inMs: 0, outMs: 900)
        early["focus"] = focus(file("damaged.vkst"), ["mono": 1])
        let frames = try await composed(TestSpecs.spec([early], width: 320, height: 240))
        assertGrey(colour(frames, at: 0.4, x: 0.8), of: colour(frames, at: 0.4, x: 0.2))
    }

    func testFootageThatCannotBeReadIsNamedBeforeATrack() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        var first = TestSpecs.clip("a", red, outMs: 1000)
        first["focus"] = focus(file("never.vkst"), ["mono": 1])
        let failure = await buildFailure(TestSpecs.spec([first, TestSpecs.clip("b", file("never.mp4"), outMs: 1000)]))
        XCTAssertEqual(failure?.code, .unreadableInput)
        // The web opens every clip's footage before any track, and so does this.
        XCTAssertEqual(failure?.clipKey, "b")
    }
}
