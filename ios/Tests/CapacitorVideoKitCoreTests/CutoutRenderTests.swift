@preconcurrency import AVFoundation
import CoreImage
import Metal
import XCTest
@testable import CapacitorVideoKitCore

/// A clip's cutout in the render: the grid's arithmetic held to `cutout-pixels.ts`, the guide read off a
/// frame (its values and which way up it comes back), the Core Image pass held to the contract worked in
/// double precision, the source time a frame is cut out at, the pre-flight that refuses a matte track it
/// cannot read, and renders end to end - a clip whose background shows the canvas, a fill, and a layer
/// whose background shows the layer under it.
final class CutoutRenderTests: RenderTestCase {

    private let meta = MatteTrackMeta(engine: "vision", kind: "video", target: "subject", durationMs: 1000, fps: 10,
                                      coverage: 0.5, box: nil)

    // MARK: - The grid's arithmetic

    func testABoxMeanIsTheMeanOverItsWindowItsEdgesClamped() {
        XCTAssertEqual(CutoutMath.boxMean([0, 3, 6], width: 3, height: 1, radius: 1), [1, 3, 5])
        XCTAssertEqual(CutoutMath.boxMean([0, 3, 6], width: 1, height: 3, radius: 1), [1, 3, 5])
        XCTAssertEqual(CutoutMath.boxMean([2, 4, 6, 8], width: 2, height: 2, radius: 0), [2, 4, 6, 8])
    }

    func testAFlatGuideLeavesTheMatteSmoothedAndNothingOfThePicture() {
        let w = 8, h = 6
        let m: [UInt8] = (0..<(w * h)).map { $0 % w < 4 ? 255 : 0 }
        let (a, b) = CutoutMath.refine(matte: m, guide: [Float](repeating: 0.5, count: w * h), width: w, height: h)
        let p = m.map { Float(Double($0) / 255) }
        let expected = CutoutMath.boxMean(CutoutMath.boxMean(p, width: w, height: h, radius: 2), width: w, height: h, radius: 2)
        for c in 0..<(w * h) {
            XCTAssertEqual(a[c], 0, accuracy: 1e-5)
            XCTAssertEqual(b[c], expected[c], accuracy: 1e-5)
        }
    }

    func testAGuideThatIsTheMatteGivesTheMatteBack() {
        // A step, a ramp across, and nothing below row 8: edges both ways.
        let w = 16, h = 12
        let m: [UInt8] = (0..<(w * h)).map { c in
            let cx = c % w, cy = c / w
            if cy >= 8 || cx >= 10 { return 0 }
            return cx < 5 ? 255 : UInt8(255 - (cx - 4) * 50)
        }
        let y = m.map { Float(Double($0) / 255) }
        let (a, b) = CutoutMath.refine(matte: m, guide: y, width: w, height: h, epsilon: 1e-6)
        for c in 0..<(w * h) {
            XCTAssertEqual(Double(a[c]) * Double(y[c]) + Double(b[c]), Double(y[c]), accuracy: 3e-3, "cell \(c)")
        }
    }

    func testTheOutlinesFieldIsTheMatteUnderACellAndASpreadOfItAbove() {
        XCTAssertEqual(CutoutMath.outlineField([0, 255, 0, 128], width: 2, height: 2, sigma: 0.5),
                       [0, 1, 0, Float(Double(128) / 255)])
        // One bright cell in the middle of a wide grid spreads evenly and keeps its mass.
        let n = 41
        var one = [UInt8](repeating: 0, count: n * n)
        one[20 * n + 20] = 255
        let field = CutoutMath.outlineField(one, width: n, height: n, sigma: 3)
        XCTAssertEqual(Double(field.reduce(0, +)), 1, accuracy: 1e-4)
        XCTAssertEqual(field[20 * n + 17], field[20 * n + 23], accuracy: 1e-6)
        XCTAssertEqual(field[17 * n + 20], field[23 * n + 20], accuracy: 1e-6)
        XCTAssertGreaterThan(field[20 * n + 20], field[20 * n + 22])
        // The contract's sigma: the width in cells over 1.55, and the line's edge narrower for a wider one.
        XCTAssertEqual(CutoutMath.outlineSigma(0.04, columns: 288, rows: 512), 0.04 * 288 / 1.55, accuracy: 1e-12)
        XCTAssertEqual(CutoutMath.outlineSpread(0.5), 0.04)
        XCTAssertEqual(CutoutMath.outlineSpread(4), 0.01)
    }

    func testTheEdgeIsHalfWayAtItsThresholdAndShiftAndSoftMoveAndWidenIt() {
        XCTAssertEqual(CutoutMath.edge(0.5, soft: 0, shift: 0), 0.5, accuracy: 1e-9)
        XCTAssertEqual(CutoutMath.edge(0.44, soft: 0, shift: 0), 0, accuracy: 1e-9)
        XCTAssertEqual(CutoutMath.edge(0.56, soft: 0, shift: 0), 1, accuracy: 1e-9)
        // A shift of 1 takes the edge out, to a quarter; one of -1 in, to three quarters.
        XCTAssertEqual(CutoutMath.edge(0.25, soft: 0, shift: 1), 0.5, accuracy: 1e-9)
        XCTAssertEqual(CutoutMath.edge(0.75, soft: 0, shift: -1), 0.5, accuracy: 1e-9)
        // Soft all the way: an edge across the whole range.
        XCTAssertEqual(CutoutMath.edge(0, soft: 1, shift: 0), 0, accuracy: 1e-9)
        XCTAssertGreaterThan(CutoutMath.edge(0.2, soft: 1, shift: 0), 0.1)
        XCTAssertEqual(CutoutMath.outlineAlpha(0.06, sigma: 4), 0.5, accuracy: 1e-9)
    }

    // MARK: - Core Image against the contract

    /// The compositor's own context: colour management off, a float working format.
    private lazy var ci = EditCompositor.context(on: MTLCreateSystemDefaultDevice())

    /// A frame of `width` x `height` RGBA values, straight, row by row from the top, as Core Image takes a
    /// bitmap: its first row the top.
    private func image(_ pixels: [SIMD4<Double>], width: Int, height: Int) -> CIImage {
        var input = [Float](repeating: 0, count: width * height * 4)
        for (i, p) in pixels.enumerated() {
            // Premultiplied, as Core Image reads a bitmap.
            input[i * 4] = Float(p.x * p.w); input[i * 4 + 1] = Float(p.y * p.w)
            input[i * 4 + 2] = Float(p.z * p.w); input[i * 4 + 3] = Float(p.w)
        }
        return CIImage(bitmapData: input.withUnsafeBytes { Data($0) }, bytesPerRow: width * 16,
                       size: CGSize(width: width, height: height), format: .RGBAf, colorSpace: nil)
    }

    /// `image` rendered through the compositor's context: premultiplied RGBA, first row the top.
    private func pixels(_ image: CIImage, width: Int, height: Int) -> [SIMD4<Double>] {
        var out = [Float](repeating: 0, count: width * height * 4)
        ci.render(image, toBitmap: &out, rowBytes: width * 16, bounds: CGRect(x: 0, y: 0, width: width, height: height),
                  format: .RGBAf, colorSpace: nil)
        return (0..<(width * height)).map { (i: Int) -> SIMD4<Double> in
            SIMD4(Double(out[i * 4]), Double(out[i * 4 + 1]), Double(out[i * 4 + 2]), Double(out[i * 4 + 3]))
        }
    }

    /// A clip laid at 0 for a second, from 0 of its source at 1x.
    private func laid(_ cutout: ComposeCutout, matte: [UInt8], columns: Int, rows: Int) throws -> CutoutClip {
        let track = try MatteTrack.parse(try MatteTrack.encode(MatteTrackContent(width: columns, height: rows, times: [0],
                                                                                 frames: [matte], meta: meta)))
        let clip = ComposeClip(key: "a", uri: "file:///a.mp4", inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false,
                               fit: .cover, crop: nil, rect: nil, transitionIn: nil, image: false, cutout: cutout)
        return try CutoutClip(clip: clip, cutout: cutout, track: track, inserted: range(0, 1000), placed: range(0, 1000))
    }

    private func range(_ fromMs: Double, _ toMs: Double) -> CMTimeRange {
        CMTimeRange(start: CMTime(value: CMTimeValue(fromMs * 1000), timescale: 1_000_000),
                    end: CMTime(value: CMTimeValue(toMs * 1000), timescale: 1_000_000))
    }

    private func luma(_ p: SIMD4<Double>) -> Double { 0.2126 * p.x + 0.7152 * p.y + 0.0722 * p.z }

    /// Step 3 as the reference takes it (`guideGrid`): each cell the mean luma of the pixels its footprint
    /// covers - which is exactly what the engine's halvings give where a cell is a power of two pixels.
    private func footprintGuide(_ frame: [SIMD4<Double>], width: Int, height: Int, columns: Int, rows: Int) -> [Float] {
        (0..<(columns * rows)).map { (c: Int) -> Float in
            let cx = c % columns, cy = c / columns
            let x0 = cx * width / columns, x1 = max(x0 + 1, (cx + 1) * width / columns)
            let y0 = cy * height / rows, y1 = max(y0 + 1, (cy + 1) * height / rows)
            var sum = 0.0
            for y in y0..<y1 { for x in x0..<x1 { sum += luma(frame[y * width + x]) } }
            return Float(sum / Double((x1 - x0) * (y1 - y0)))
        }
    }

    /// A grid read at `u`, `v` of the frame, from its top-left: bilinear between cell centres, the edges
    /// clamped (`sampleGrid`).
    private func sample(_ grid: [Float], _ columns: Int, _ rows: Int, _ u: Double, _ v: Double) -> Double {
        let gx = min(Double(columns - 1), max(0, u * Double(columns) - 0.5))
        let gy = min(Double(rows - 1), max(0, v * Double(rows) - 0.5))
        let x0 = Int(gx), y0 = Int(gy)
        let x1 = min(columns - 1, x0 + 1), y1 = min(rows - 1, y0 + 1)
        let fx = gx - Double(x0), fy = gy - Double(y0)
        let top = Double(grid[y0 * columns + x0]) * (1 - fx) + Double(grid[y0 * columns + x1]) * fx
        let bottom = Double(grid[y1 * columns + x0]) * (1 - fx) + Double(grid[y1 * columns + x1]) * fx
        return top * (1 - fy) + bottom * fy
    }

    /// Steps 4 to 8 in double precision, from `guide`: premultiplied RGBA a pixel, and each pixel's `q`.
    private func reference(_ frame: [SIMD4<Double>], width: Int, height: Int, matte: [UInt8], columns: Int, rows: Int,
                           guide: [Float], cutout: ComposeCutout) -> (pixels: [SIMD4<Double>], q: [Double]) {
        let (a, b) = CutoutMath.refine(matte: matte, guide: guide, width: columns, height: rows)
        let sigma = cutout.outline.map { CutoutMath.outlineSigma($0.width, columns: columns, rows: rows) }
        let field = sigma.map { CutoutMath.outlineField(matte, width: columns, height: rows, sigma: $0) }
        var out: [SIMD4<Double>] = []
        var qs: [Double] = []
        for py in 0..<height {
            let v = (Double(py) + 0.5) / Double(height)
            for px in 0..<width {
                let u = (Double(px) + 0.5) / Double(width)
                let c = frame[py * width + px]
                let q = min(1, max(0, sample(a, columns, rows, u, v) * luma(c) + sample(b, columns, rows, u, v)))
                let a0 = CutoutMath.edge(q, soft: cutout.soft, shift: cutout.shift) * c.w
                var alpha = a0
                var colour = SIMD3(c.x, c.y, c.z)
                if let line = cutout.outline, let field, let sigma {
                    let o = CutoutMath.outlineAlpha(sample(field, columns, rows, u, v), sigma: sigma)
                    alpha = a0 + (1 - a0) * o
                    if alpha > 0 {
                        colour = (colour * a0 + SIMD3(line.color.r, line.color.g, line.color.b) * ((1 - a0) * o)) / alpha
                    }
                }
                if let fill = cutout.fill {
                    let f = SIMD3(fill.r, fill.g, fill.b)
                    colour = f + (colour - f) * alpha
                    alpha = 1
                }
                out.append(SIMD4(colour.x * alpha, colour.y * alpha, colour.z * alpha, alpha))
                qs.append(q)
            }
        }
        return (out, qs)
    }

    /// A light subject, an ellipse left of centre, on a darker background with a little texture.
    private func subjectFrame(width: Int, height: Int) -> [SIMD4<Double>] {
        (0..<(width * height)).map { (i: Int) -> SIMD4<Double> in
            let x = Double(i % width) + 0.5, y = Double(i / width) + 0.5
            let dx = (x - Double(width) * 0.4) / (Double(width) * 0.22)
            let dy = (y - Double(height) * 0.5) / (Double(height) * 0.3)
            if dx * dx + dy * dy < 1 { return SIMD4(0.9, 0.75, 0.6, 1) }
            return SIMD4(0.15 + 0.05 * Double((i % width) % 3), 0.25, 0.35, 1)
        }
    }

    /// The segmenter's guess at it: a soft blob a little too large, as a coarse matte is.
    private func subjectMatte(columns: Int, rows: Int) -> [UInt8] {
        (0..<(columns * rows)).map { (c: Int) -> UInt8 in
            let x = (Double(c % columns) + 0.5) / Double(columns), y = (Double(c / columns) + 0.5) / Double(rows)
            let dx = (x - 0.4) / 0.26, dy = (y - 0.5) / 0.34
            let r = (dx * dx + dy * dy).squareRoot()
            return UInt8(max(0, min(255, jsRound((1.15 - r) / 0.3 * 255))))
        }
    }

    private func largestDifference(_ a: [SIMD4<Double>], _ b: [SIMD4<Double>], where keep: (Int) -> Bool = { _ in true }) -> Double {
        var most = 0.0
        for i in a.indices where keep(i) {
            let d = a[i] - b[i]
            most = max(most, abs(d.x), abs(d.y), abs(d.z), abs(d.w))
        }
        return most
    }

    func testTheGuideIsTheMeanLumaOfEachCellsFootprintTopRowFirst() {
        // Bright on top, dark below, and lighter on the left: 4 x 4 pixels a cell.
        let width = 64, height = 48, columns = 16, rows = 12
        let frame = (0..<(width * height)).map { (i: Int) -> SIMD4<Double> in
            let top = i / width < 24, left = i % width < 32
            let v = top ? (left ? 1.0 : 0.6) : (left ? 0.2 : 0.0)
            return SIMD4(v, v, v, 1)
        }
        let rect = CGRect(x: 0, y: 0, width: width, height: height)
        let luma = CutoutRender.luma(image(frame, width: width, height: height), rect: rect)
        var bitmap: [Float] = [], guide: [Float] = []
        XCTAssertTrue(CutoutRender.guide(luma, rect: rect, columns: columns, rows: rows, context: ci, bitmap: &bitmap, into: &guide))
        XCTAssertEqual(guide.count, columns * rows)
        XCTAssertEqual(Double(guide[0]), 1, accuracy: 2e-3, "row 0 is the TOP of the frame")
        XCTAssertEqual(Double(guide[columns - 1]), 0.6, accuracy: 2e-3)
        XCTAssertEqual(Double(guide[(rows - 1) * columns]), 0.2, accuracy: 2e-3)
        XCTAssertEqual(Double(guide[rows * columns - 1]), 0, accuracy: 2e-3)
        let expected = footprintGuide(frame, width: width, height: height, columns: columns, rows: rows)
        for c in 0..<(columns * rows) { XCTAssertEqual(guide[c], expected[c], accuracy: 2e-3, "cell \(c)") }

        // A frame that is no power of two of the grid still reads the right way up, and near the means.
        let odd = (0..<(100 * 75)).map { (i: Int) -> SIMD4<Double> in i / 100 < 37 ? SIMD4(1, 1, 1, 1) : SIMD4(0, 0, 0, 1) }
        let oddRect = CGRect(x: 0, y: 0, width: 100, height: 75)
        XCTAssertTrue(CutoutRender.guide(CutoutRender.luma(image(odd, width: 100, height: 75), rect: oddRect), rect: oddRect,
                                         columns: columns, rows: rows, context: ci, bitmap: &bitmap, into: &guide))
        XCTAssertGreaterThan(guide[columns + 3], 0.95)
        XCTAssertLessThan(guide[(rows - 2) * columns + 3], 0.05)
    }

    func testTheCoreImagePassIsTheContractToWithinWhatAFrameShows() throws {
        let width = 64, height = 48, columns = 16, rows = 12
        let frame = subjectFrame(width: width, height: height)
        let matte = subjectMatte(columns: columns, rows: rows)
        let guide = footprintGuide(frame, width: width, height: height, columns: columns, rows: rows)
        let looks: [ComposeCutout] = [
            ComposeCutout(uri: "x", soft: 0.5, shift: 0, fill: nil, outline: nil),
            ComposeCutout(uri: "x", soft: 0.4, shift: 0.5, fill: ComposeRGB(r: 0, g: 0.5, b: 1), outline: nil),
            ComposeCutout(uri: "x", soft: 0.6, shift: -0.4, fill: nil,
                          outline: ComposeCutoutOutline(color: ComposeRGB(r: 1, g: 0, b: 0), width: 0.2)),
            ComposeCutout(uri: "x", soft: 0.5, shift: 0, fill: ComposeRGB(r: 1, g: 1, b: 1),
                          outline: ComposeCutoutOutline(color: ComposeRGB(r: 0, g: 0, b: 0), width: 0.3)),
        ]
        for look in looks {
            let clip = try laid(look, matte: matte, columns: columns, rows: rows)
            let ours = pixels(clip.cutOut(image(frame, width: width, height: height), atUs: 0, context: ci), width: width, height: height)
            let theirs = reference(frame, width: width, height: height, matte: matte, columns: columns, rows: rows,
                                   guide: guide, cutout: look).pixels
            XCTAssertLessThanOrEqual(largestDifference(ours, theirs), 0.02, "soft \(look.soft) shift \(look.shift)")
        }
    }

    func testACrispEdgeIsTheContractAwayFromItsThreshold() throws {
        let width = 64, height = 48, columns = 16, rows = 12
        let frame = subjectFrame(width: width, height: height)
        let matte = subjectMatte(columns: columns, rows: rows)
        let guide = footprintGuide(frame, width: width, height: height, columns: columns, rows: rows)
        let crisp = ComposeCutout(uri: "x", soft: 0, shift: 0, fill: nil, outline: nil)
        let ours = pixels(try laid(crisp, matte: matte, columns: columns, rows: rows)
            .cutOut(image(frame, width: width, height: height), atUs: 0, context: ci), width: width, height: height)
        let theirs = reference(frame, width: width, height: height, matte: matte, columns: columns, rows: rows,
                               guide: guide, cutout: crisp)
        // Within the edge's own band a few thousandths of `q` are a visible step; outside it, the frame or
        // nothing, exactly.
        XCTAssertLessThanOrEqual(largestDifference(ours, theirs.pixels, where: { abs(theirs.q[$0] - 0.5) > 0.08 }), 0.01)
        // The subject is kept and the background gone: the refinement put the edge on the ellipse.
        XCTAssertEqual(ours[24 * width + 25].w, 1, accuracy: 0.01, "inside the subject")
        XCTAssertEqual(ours[24 * width + 60].w, 0, accuracy: 0.01, "far outside it")
        // Just past the ellipse, where the coarse blob still says subject - an alpha of 1 unrefined - the
        // frame says background, and the refinement takes it away.
        let unrefined = sample(matte.map { Float(Double($0) / 255) }, columns, rows, 40.5 / Double(width), 24.5 / Double(height))
        XCTAssertGreaterThan(unrefined, 0.6)
        XCTAssertLessThan(ours[24 * width + 40].w, 0.5, "the edge follows the frame, not the blob")
    }

    func testTheMatteIsOverTheFrameTheRightWayUp() throws {
        // A frame of one grey - nothing for the refinement to follow - and a matte that keeps the top half.
        let width = 64, height = 48, columns = 16, rows = 12
        let frame = [SIMD4<Double>](repeating: SIMD4(0.5, 0.5, 0.5, 1), count: width * height)
        let matte: [UInt8] = (0..<(columns * rows)).map { $0 / columns < rows / 2 ? 255 : 0 }
        let clip = try laid(ComposeCutout(uri: "x", soft: 0, shift: 0, fill: nil, outline: nil), matte: matte,
                            columns: columns, rows: rows)
        let ours = pixels(clip.cutOut(image(frame, width: width, height: height), atUs: 0, context: ci), width: width, height: height)
        XCTAssertEqual(ours[2 * width + 30].w, 1, accuracy: 0.01, "the top is kept")
        XCTAssertEqual(ours[2 * width + 30].x, 0.5, accuracy: 0.01)
        XCTAssertEqual(ours[45 * width + 30].w, 0, accuracy: 0.01, "the bottom is taken away")
    }

    func testNothingStandingOutIsTheFillEverywhereOrNothing() throws {
        let width = 32, height = 24, columns = 8, rows = 6
        let frame = subjectFrame(width: width, height: height)
        let empty = [UInt8](repeating: 0, count: columns * rows)
        let filled = try laid(ComposeCutout(uri: "x", soft: 0, shift: 0, fill: ComposeRGB(r: 0.2, g: 0.4, b: 0.6), outline: nil),
                              matte: empty, columns: columns, rows: rows)
        for p in pixels(filled.cutOut(image(frame, width: width, height: height), atUs: 0, context: ci), width: width, height: height) {
            XCTAssertLessThanOrEqual(largestDifference([p], [SIMD4(0.2, 0.4, 0.6, 1)]), 0.004)
        }
        let bare = try laid(ComposeCutout(uri: "x", soft: 0, shift: 0, fill: nil, outline: nil), matte: empty, columns: columns, rows: rows)
        for p in pixels(bare.cutOut(image(frame, width: width, height: height), atUs: 0, context: ci), width: width, height: height) {
            XCTAssertEqual(p.w, 0, accuracy: 0.004)
        }
    }

    func testThePicturesOwnAlphaIsFoldedIntoTheSubjects() throws {
        // A subject everywhere, in a frame whose right half is transparent: the right half stays so, and a
        // fill fills it.
        let width = 32, height = 24, columns = 8, rows = 6
        let frame = (0..<(width * height)).map { (i: Int) -> SIMD4<Double> in
            i % width < 16 ? SIMD4(0.8, 0.2, 0.2, 1) : SIMD4(0.8, 0.2, 0.2, 0)
        }
        let full = [UInt8](repeating: 255, count: columns * rows)
        let kept = pixels(try laid(ComposeCutout(uri: "x", soft: 0, shift: 0, fill: nil, outline: nil), matte: full,
                                   columns: columns, rows: rows)
            .cutOut(image(frame, width: width, height: height), atUs: 0, context: ci), width: width, height: height)
        XCTAssertEqual(kept[12 * width + 4].w, 1, accuracy: 0.01)
        XCTAssertEqual(kept[12 * width + 28].w, 0, accuracy: 0.01)
        let filled = pixels(try laid(ComposeCutout(uri: "x", soft: 0, shift: 0, fill: ComposeRGB(r: 0, g: 0, b: 1), outline: nil),
                                     matte: full, columns: columns, rows: rows)
            .cutOut(image(frame, width: width, height: height), atUs: 0, context: ci), width: width, height: height)
        XCTAssertLessThanOrEqual(largestDifference([filled[12 * width + 28]], [SIMD4(0, 0, 1, 1)]), 0.01)
    }

    // MARK: - Source time and the pre-flight

    func testAFrameIsCutOutAtTheSourceInstantItShowsHeldToTheClipsTrim() throws {
        let halvesA: [UInt8] = (0..<8).map { $0 % 4 < 2 ? 255 : 0 }
        let halvesB: [UInt8] = (0..<8).map { $0 % 4 < 2 ? 0 : 255 }
        let track = try MatteTrack.parse(try MatteTrack.encode(MatteTrackContent(width: 4, height: 2, times: [1000, 3000],
                                                                                 frames: [halvesA, halvesB], meta: meta)))
        let cutout = ComposeCutout(uri: "x", soft: 0, shift: 0, fill: nil, outline: nil)
        // Trimmed to 1000...3000 at 2x, placed at 5 s of the post for a second.
        let clip = ComposeClip(key: "a", uri: "file:///a.mp4", inMs: 1000, outMs: 3000, speed: 2, volume: 1, muted: false,
                               fit: .cover, crop: nil, rect: nil, transitionIn: nil, image: false, cutout: cutout)
        let fast = try CutoutClip(clip: clip, cutout: cutout, track: track, inserted: range(1000, 3000), placed: range(5000, 6000))
        XCTAssertEqual(fast.sourceMs(atUs: 5_000_000), 1000, accuracy: 1e-6)
        XCTAssertEqual(fast.sourceMs(atUs: 5_500_000), 2000, accuracy: 1e-6)
        XCTAssertEqual(fast.sourceMs(atUs: 4_000_000), 1000, accuracy: 1e-6)
        XCTAssertEqual(fast.sourceMs(atUs: 6_000_000), 2999.999, accuracy: 1e-6)
        // And the matte there: the first frame at the in-point, half way to the second at 2000 ms.
        XCTAssertEqual(try fast.matte(atUs: 5_000_000), halvesA)
        XCTAssertEqual(try fast.matte(atUs: 5_500_000)[0], 128)
    }

    func testADamagedFrameFailsTheClipOnlyWhereItCanReachIt() throws {
        let frame: [UInt8] = (0..<8).map { $0 % 4 < 2 ? 255 : 0 }
        var bytes = [UInt8](try MatteTrack.encode(MatteTrackContent(width: 4, height: 2, times: [0, 1000, 2000],
                                                                    frames: [frame, frame, frame], meta: meta)))
        // Each frame is one packet of eight literals, nine bytes; the LAST one now promises nine.
        let json = Int(bytes[16]) | Int(bytes[17]) << 8
        bytes[20 + json + 24 + 18] = 18
        let track = try MatteTrack.parse(Data(bytes))
        let cutout = ComposeCutout(uri: "x", soft: 0, shift: 0, fill: nil, outline: nil)
        func clip(_ key: String, _ inMs: Int64, _ outMs: Int64) -> ComposeClip {
            ComposeClip(key: key, uri: "file:///a.mp4", inMs: inMs, outMs: outMs, speed: 1, volume: 1, muted: false,
                        fit: .cover, crop: nil, rect: nil, transitionIn: nil, image: false, cutout: cutout)
        }
        XCTAssertThrowsError(try CutoutClip(clip: clip("late", 1500, 3000), cutout: cutout, track: track,
                                            inserted: range(1500, 3000), placed: range(0, 1500))) { error in
            guard case let BuildError.unreadable(key, detail) = error else { return XCTFail("\(error)") }
            XCTAssertEqual(key, "late")
            XCTAssertTrue(detail.hasPrefix("matte track:"), detail)
        }
        XCTAssertNoThrow(try CutoutClip(clip: clip("early", 0, 900), cutout: cutout, track: track,
                                        inserted: range(0, 900), placed: range(0, 900)))
    }

    func testATrackThatCannotBeReadIsRefusedNamingTheClip() throws {
        let garbage = file("garbage.vkmt")
        try Data("not a matte track at all".utf8).write(to: garbage)
        for (name, url) in [("missing", file("never.vkmt")), ("garbage", garbage)] {
            XCTAssertThrowsError(try CutoutTracks.read(url.absoluteString, for: "b"), name) { error in
                guard case let BuildError.unreadable(key, detail) = error else { return XCTFail("\(name): \(error)") }
                XCTAssertEqual(key, "b", name)
                XCTAssertTrue(detail.hasPrefix("matte track:"), "\(name): \(detail)")
            }
        }
    }

    // MARK: - End to end

    /// The compositor's frames for `options`, as `FocusRenderTests` reads them.
    private func composed(_ options: [String: Any]) async throws -> [ComposedFrame] {
        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        return try TestComposed.frames(try await CompositionBuilder.build(spec))
    }

    /// The colour at (`x`, `y`) of the frame nearest `seconds`, top-left origin, over a 5 x 5 square.
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

    private func assertRed(_ c: SIMD3<Double>, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(c.x > 190 && c.y < 70 && c.z < 70, "expected red, got \(c)", file: file, line: line)
    }

    private func assertNear(_ c: SIMD3<Double>, _ expected: SIMD3<Double>, tolerance: Double = 3,
                            file: StaticString = #filePath, line: UInt = #line) {
        let d = c - expected
        XCTAssertLessThanOrEqual(max(abs(d.x), abs(d.y), abs(d.z)), tolerance, "expected \(expected), got \(c)", file: file, line: line)
    }

    /// A matte track of the left half kept, over a `columns` x `rows` grid.
    private func leftHalf(_ name: String, columns: Int = 32, rows: Int = 24) throws -> URL {
        let url = file(name)
        let cells: [UInt8] = (0..<(columns * rows)).map { $0 % columns < columns / 2 ? 255 : 0 }
        try MatteTrack.encode(MatteTrackContent(width: columns, height: rows, times: [0], frames: [cells], meta: meta)).write(to: url)
        return url
    }

    func testABaseClipsBackgroundShowsTheCanvas() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        var clip = TestSpecs.clip("a", red, outMs: 1000)
        clip["cutout"] = ["uri": try leftHalf("red.vkmt").absoluteString]
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240, ["background": [0, 1, 0]]))
        assertRed(colour(frames, at: 0.5, x: 0.2))
        assertNear(colour(frames, at: 0.5, x: 0.8), SIMD3(0, 255, 0))
    }

    func testAFillShowsWhereTheBackgroundWas() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        var clip = TestSpecs.clip("a", red, outMs: 1000)
        clip["cutout"] = ["uri": try leftHalf("red.vkmt").absoluteString, "fill": [0, 0, 1]]
        let frames = try await composed(TestSpecs.spec([clip], width: 320, height: 240, ["background": [0, 1, 0]]))
        assertRed(colour(frames, at: 0.5, x: 0.2))
        assertNear(colour(frames, at: 0.5, x: 0.8), SIMD3(0, 0, 255))
    }

    func testALayersBackgroundShowsTheLayerUnderIt() async throws {
        let blue = try await TestMedia.video(file("blue.mp4"), durationMs: 1000, color: .blue, audio: false)
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        var layer = TestSpecs.clip("p", red, outMs: 1000)
        layer["cutout"] = ["uri": try leftHalf("red.vkmt").absoluteString]
        let frames = try await composed(TestSpecs.spec([TestSpecs.clip("a", blue, outMs: 1000)], width: 320, height: 240,
                                                       ["tracks": [["id": "pip", "z": 1, "clips": [layer]]]]))
        assertRed(colour(frames, at: 0.5, x: 0.2))
        let under = colour(frames, at: 0.5, x: 0.8)
        XCTAssertTrue(under.z > 190 && under.x < 70, "expected the base's blue, got \(under)")
    }

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
        let garbage = file("garbage.vkmt")
        try Data("not a matte track at all".utf8).write(to: garbage)
        for (name, uri) in [("missing", file("never.vkmt")), ("garbage", garbage)] {
            var cut = TestSpecs.clip("b", red, outMs: 1000)
            cut["cutout"] = ["uri": uri.absoluteString]
            let failure = await buildFailure(TestSpecs.spec([TestSpecs.clip("a", red, outMs: 1000), cut]))
            XCTAssertEqual(failure?.code, .unreadableInput, name)
            XCTAssertEqual(failure?.clipKey, "b", name)
            XCTAssertTrue(failure?.message.hasPrefix("matte track:") == true, "\(name): \(failure?.message ?? "")")
        }
    }
}
