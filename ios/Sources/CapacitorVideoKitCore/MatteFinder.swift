import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import Vision

/// One matte search's question: which file, read as what, keeping what, at how many frames a second.
struct MatteRequest: Sendable {
    let url: URL
    let kind: MediaLabelsResult.Kind
    /// What the track will keep on this OS, `subject` or `people` - `MatteSegmenters.target(for:)` of
    /// what was asked - which is also part of the name the track is kept under.
    let target: String
    /// 1...30, whole, already held there; ignored for a picture.
    let fps: Double
}

/// The analysis behind `findMatte`: a video's frames - or a picture's one - turned upright and looked
/// at by Vision, each answer kept SOFT on the matte grid, where `findSubjects` thresholds its segmenter's
/// into subjects, and handed back as a matte track's coded content. `MatteSearches` decides when one
/// runs and where its answer is kept; this only reads and looks. `MatteAnalysis.kt` and the looking half
/// of `MatteFinder.kt` on Android, with `SubjectFinder`'s frames on this side.
///
/// THE FRAMES are `SubjectFinder`'s, read the same way for the same reasons: forward through one track
/// reader (`SubjectVideoFrames`), the first frame at or after each of the times `k * 1000 / fps`, each
/// stamped with its own time, turned upright and scaled to `SubjectFinder.lookSize` - 512, the matte
/// grid's own longer side, so a pixel of the frame Vision sees is a cell of the track wherever the
/// footage is at least that large. A picture comes upright out of ImageIO's thumbnail call, at the
/// picture grid's size.
///
/// THE ENGINES (`MatteSegmenters`). `subject` is Vision's foreground instance mask (iOS 17), every
/// instance it finds combined into one soft mask - the "combined foreground" ML Kit's subject
/// segmentation answers on Android, which keeps everything that stands out together. `people` is
/// Vision's person segmentation (iOS 15), which also answers a `subject` search on iOS 16, as the
/// selfie segmenter answers one on an Android phone with no subject segmenter - and the track keeps
/// `people`.
///
/// THE SMOOTHING, for an engine that looks at each frame on its own - the instance mask has no notion of
/// the frame before - is Android's (`MatteAnalysis.smooth`): a cell's answer mixed with the one before
/// it as far as the picture there has stayed the same, so a background that does not move stops
/// flickering while an edge that moves follows the new frame. Person segmentation is a STATEFUL request
/// that Vision smooths over a sequence itself, as ML Kit's stream mode does, so it gets none.
///
/// ONE SEARCH AT A TIME, between the two kinds: a matte search runs on `SubjectFinder`'s own serial
/// queue, so it never looks at frames while a subject search does - Android's shared lock
/// (`SubjectFinder.searches`), because each holds a decoder and a segmenter.
enum MatteFinder {
    /// `findMatte` refuses as `findSubjects` does: the two share their frames and their refusals.
    typealias FindError = SubjectFinder.FindError

    /// `MatteEngine`: Vision, whichever of its two segmenters answers.
    static let engine = "vision"

    /// Frames looked at a second when the call does not say: the subject segmenter's, and the people
    /// one's, which is quicker - Android's numbers, so a track is looked at as often on either phone.
    static let defaultFps = 10.0
    static let defaultPeopleFps = 15.0

    /// `MATTE_GRID`: a video's grid on its longer side.
    static let videoGrid = 512
    /// `MATTE_PICTURE_GRID`: a picture's for the subject segmenter, which is looked at once and can
    /// afford more.
    static let pictureGrid = 1024
    /// A picture's for people, kept at the video's as Android keeps it (`PEOPLE_PICTURE_GRID`).
    static let peoplePictureGrid = 512
    /// The most frames a track keeps: past this a long clip is looked at less often a second, so its
    /// track stays a size the page reads at once (`MatteAnalysis.MAX_FRAMES`).
    static let maxFrames = 1800

    /// The `fps` a call asked for, rounded and held to 1...30, as Android's `fpsFor`; the engine's own
    /// for none, or for anything not a number. `target` is the one ASKED for, as on Android.
    static func fps(_ asked: Double?, target: String) -> Double {
        guard let asked, asked.isFinite else { return target == "people" ? defaultPeopleFps : defaultFps }
        return min(30, max(1, jsRound(asked)))
    }

    /// The rate a video of `durationMs` is looked at when `fps` was asked: lowered for a clip long enough
    /// to make more than `maxFrames`, whole, at least 1 - `MatteAnalysis.video`'s arithmetic.
    static func rate(_ fps: Double, durationMs: Double) -> Double {
        let seconds = durationMs / 1000
        guard seconds > 0 else { return fps }
        return max(1, jsRound(min(fps, max(1, Double(maxFrames) / seconds))))
    }

    /// How far a search has got, 0...1 of the frames to look at.
    typealias Progress = @Sendable (Double) -> Void

    /// Makes the segmenter for what a track keeps, and whether it looks at a still or a sequence.
    typealias MakeSegmenter = @Sendable (_ target: String, _ still: Bool) throws -> MatteSegmenter

    /// The matte of `request`'s file, its frames coded. `segmenter` makes the segmenter once the file has
    /// been read: in the simulator it throws `unsupported` (`MatteSegmenters.make`), so a file that will
    /// not read is still reported as one, and the tests hand in one of their own. `progress` hears 0 as
    /// the looking starts and then 0...1 of the frames, as often as there is a frame; `cancelled` is asked
    /// before every frame, and a yes throws `CancellationError`.
    static func analyse(_ request: MatteRequest,
                        segmenter: @escaping MakeSegmenter = { try MatteSegmenters.make(target: $0, still: $1) },
                        progress: @escaping Progress = { _ in },
                        cancelled: @escaping @Sendable () -> Bool = { false }) async throws -> MatteTrackCoded {
        switch request.kind {
        case .image:
            return try await SubjectFinder.onSearchQueue { () throws -> MatteTrackCoded in
                progress(0)
                return try picture(request.url, target: request.target, segmenter: segmenter)
            }
        case .video:
            var opened = try await SubjectVideoFrames.open(request.url, fps: request.fps)
            // Opened again, at the lower rate, for a clip long enough to make more frames than a track
            // keeps: the reader is what decides which frames are looked at, and its length is only known
            // once it is open.
            let cadence = MatteFinder.rate(request.fps, durationMs: opened.durationMs)
            if cadence < request.fps { opened = try await SubjectVideoFrames.open(request.url, fps: cadence) }
            let frames = opened
            return try await SubjectFinder.onSearchQueue { () throws -> MatteTrackCoded in
                try video(frames, rate: cadence, target: request.target, segmenter: segmenter,
                          progress: progress, cancelled: cancelled)
            }
        }
    }

    /// A picture: one frame, at time 0, upright, at the picture grid of what the track keeps.
    private static func picture(_ url: URL, target: String, segmenter make: MakeSegmenter) throws -> MatteTrackCoded {
        let gridLong = target == "people" ? peoplePictureGrid : pictureGrid
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0 else {
            throw FindError.unreadable("\(url.lastPathComponent) will not open as a picture")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: gridLong,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              image.width > 0, image.height > 0,
              let frame = SubjectFrames.buffer(of: image) else {
            throw FindError.unreadable("\(url.lastPathComponent) will not decode")
        }
        let segmenter = try make(target, true)
        // The grid is in proportion to the picture as it stands upright, at its own size, as a subject
        // track's is: the thumbnail's sides are rounded to whole pixels at a smaller one.
        let upright = SubjectFinder.uprightSize(source) ?? CGSize(width: image.width, height: image.height)
        let grid = matteGrid(width: Double(upright.width), height: Double(upright.height), longSide: gridLong)
        let cells = try segmenter.confidence(of: frame).onto(width: grid.width, height: grid.height)
        var summary = MatteSummary(width: grid.width, height: grid.height)
        summary.add(cells)
        let (coverage, box) = summary.result
        return MatteTrackCoded(width: grid.width, height: grid.height, times: [0],
                               packets: [MatteTrack.encodePackets(cells)],
                               meta: MatteTrackMeta(engine: engine, kind: "image", target: segmenter.target,
                                                    durationMs: 0, fps: 0, coverage: coverage, box: box))
    }

    /// A video, frame by frame at `rate`, each answer smoothed where the engine needs it and coded as it
    /// arrives, in frame order, so a minute of footage holds a few megabytes rather than its raw grids.
    private static func video(_ frames: SubjectVideoFrames, rate: Double, target: String, segmenter make: MakeSegmenter,
                              progress: Progress, cancelled: () -> Bool) throws -> MatteTrackCoded {
        progress(0)
        // The first frame before the segmenter, so a video that gives none is reported as one wherever
        // the call is made, the simulator included.
        guard let first = try frames.next() else {
            throw FindError.unreadable("\(frames.name) gave no frame")
        }
        let segmenter = try make(target, false)
        let grid = matteGrid(width: frames.uprightWidth, height: frames.uprightHeight, longSide: videoGrid)
        var times: [Double] = []
        var packets: [[UInt8]] = []
        var summary = MatteSummary(width: grid.width, height: grid.height)
        var previous: (cells: [UInt8], luma: [UInt8])?
        var lastMs: Int64 = 0
        var frame: (timeMs: Int64, buffer: CVPixelBuffer)? = first
        while let current = frame {
            if cancelled() { throw CancellationError() }
            try autoreleasepool {
                var cells = try segmenter.confidence(of: current.buffer).onto(width: grid.width, height: grid.height)
                if segmenter.smooth {
                    let luma = MatteFrames.luma(of: current.buffer, width: grid.width, height: grid.height)
                    if let before = previous {
                        MatteFrames.smooth(&cells, luma: luma, previous: before.cells, previousLuma: before.luma)
                    }
                    previous = (cells: cells, luma: luma)
                }
                summary.add(cells)
                times.append(Double(current.timeMs))
                packets.append(MatteTrack.encodePackets(cells))
                lastMs = current.timeMs
            }
            progress(frames.progress)
            frame = try frames.next()
        }
        let (coverage, box) = summary.result
        // Whole milliseconds, as Android keeps a track's length; the last frame's time for a file that
        // does not say how long it is.
        let durationMs = frames.durationMs > 0 ? jsRound(frames.durationMs) : Double(lastMs)
        return MatteTrackCoded(width: grid.width, height: grid.height, times: times, packets: packets,
                               meta: MatteTrackMeta(engine: engine, kind: "video", target: segmenter.target,
                                                    durationMs: durationMs, fps: rate, coverage: coverage, box: box))
    }
}

// MARK: - Frames

/// What a matte search does with a frame besides showing it to Vision: each cell's luma, and the
/// smoothing that reads it.
enum MatteFrames {
    /// Each cell's luma, 0...255, from an upright 32BGRA frame: every pixel's `(2126 R + 7152 G + 722 B) /
    /// 10000` - Android's, off the grid-sized frame it reads back - read bilinearly at the cell's centre,
    /// which is the pixel itself where the frame is the grid's size, as it is for footage at least
    /// `SubjectFinder.lookSize` on its longer side.
    static func luma(of frame: CVPixelBuffer, width: Int, height: Int) -> [UInt8] {
        var out = [UInt8](repeating: 0, count: width * height)
        CVPixelBufferLockBaseAddress(frame, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
        let fw = CVPixelBufferGetWidth(frame), fh = CVPixelBufferGetHeight(frame)
        let stride = CVPixelBufferGetBytesPerRow(frame)
        guard fw > 0, fh > 0, width > 0, height > 0,
              let base = CVPixelBufferGetBaseAddress(frame)?.assumingMemoryBound(to: UInt8.self) else { return out }
        func pixel(_ x: Int, _ y: Int) -> Double {
            let p = base + y * stride + x * 4
            // BGRA: blue first.
            return Double((2126 * Int(p[2]) + 7152 * Int(p[1]) + 722 * Int(p[0])) / 10_000)
        }
        for cy in 0..<height {
            let gy = min(Double(fh - 1), max(0, (Double(cy) + 0.5) * Double(fh) / Double(height) - 0.5))
            let y0 = Int(gy)
            let y1 = min(fh - 1, y0 + 1)
            let fy = gy - Double(y0)
            for cx in 0..<width {
                let gx = min(Double(fw - 1), max(0, (Double(cx) + 0.5) * Double(fw) / Double(width) - 0.5))
                let x0 = Int(gx)
                let x1 = min(fw - 1, x0 + 1)
                let fx = gx - Double(x0)
                let top = pixel(x0, y0) * (1 - fx) + pixel(x1, y0) * fx
                let bottom = pixel(x0, y1) * (1 - fx) + pixel(x1, y1) * fx
                out[cy * width + cx] = UInt8(max(0, min(255, jsRound(top * (1 - fy) + bottom * fy))))
            }
        }
        return out
    }

    /// `cells` mixed with `previous` where the picture has not moved, in place: `w = clamp(|dY| * 8,
    /// 0.35, 1)` of the new answer, `dY` the cell's change in luma, 0...1 - `MatteAnalysis.smooth`.
    static func smooth(_ cells: inout [UInt8], luma: [UInt8], previous: [UInt8], previousLuma: [UInt8]) {
        let n = min(cells.count, luma.count, previous.count, previousLuma.count)
        for c in 0..<n {
            let change = Double(abs(Int(luma[c]) - Int(previousLuma[c]))) / 255
            let w = min(1, max(0.35, change * 8))
            cells[c] = UInt8(max(0, min(255, jsRound(w * Double(cells[c]) + (1 - w) * Double(previous[c])))))
        }
    }
}

// MARK: - Masks

/// A segmenter's answer for one frame: how sure it is that each pixel is the subject, 0...1, over the
/// whole frame, row by row from the top with no padding.
struct MatteConfidence {
    let width: Int
    let height: Int
    let values: [Float]

    /// Nothing stood out.
    static let empty = MatteConfidence(width: 1, height: 1, values: [0])

    /// The mask brought onto a `gridWidth` x `gridHeight` grid: each cell the mask read bilinearly at
    /// the cell's centre, 0...255 - `onto` in `web/mattes.ts` and `MatteAnalysis.onto`. A mask of
    /// another aspect than the frame's is read by the same fractions, as covering the whole frame.
    func onto(width gridWidth: Int, height gridHeight: Int) -> [UInt8] {
        var cells = [UInt8](repeating: 0, count: gridWidth * gridHeight)
        let mw = width, mh = height
        guard mw > 0, mh > 0, values.count >= mw * mh else { return cells }
        values.withUnsafeBufferPointer { v in
            for cy in 0..<gridHeight {
                let gy = min(Double(mh - 1), max(0, (Double(cy) + 0.5) * Double(mh) / Double(gridHeight) - 0.5))
                let y0 = Int(gy)
                let y1 = min(mh - 1, y0 + 1)
                let fy = gy - Double(y0)
                for cx in 0..<gridWidth {
                    let gx = min(Double(mw - 1), max(0, (Double(cx) + 0.5) * Double(mw) / Double(gridWidth) - 0.5))
                    let x0 = Int(gx)
                    let x1 = min(mw - 1, x0 + 1)
                    let fx = gx - Double(x0)
                    let top = Double(v[y0 * mw + x0]) * (1 - fx) + Double(v[y0 * mw + x1]) * fx
                    let bottom = Double(v[y1 * mw + x0]) * (1 - fx) + Double(v[y1 * mw + x1]) * fx
                    let value = min(1, max(0, top * (1 - fy) + bottom * fy))
                    cells[cy * gridWidth + cx] = UInt8(jsRound(value * 255))
                }
            }
        }
        return cells
    }

    /// Colour management off, as every context in the kit has it: a mask is numbers, not a picture.
    private static let context = CIContext(options: [
        .workingColorSpace: NSNull(),
        .outputColorSpace: NSNull(),
        .cacheIntermediates: false,
        .name: "VideoKitMatteMasks",
    ])

    /// A mask buffer's values, whatever Vision handed it over as: one byte a pixel (0...255), a half or a
    /// full float a pixel (0...1), read straight; anything else read through Core Image, as its red. Apple
    /// does not say which of the float formats `generateScaledMaskForImage` answers in, so none is
    /// assumed. The empty mask for a buffer with no pixels.
    static func read(_ buffer: CVPixelBuffer) -> MatteConfidence {
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        guard width > 0, height > 0 else { return .empty }
        let format = CVPixelBufferGetPixelFormatType(buffer)
        // How one pixel of a row is read, for the three formats read straight; nil for any other.
        let reader: ((UnsafeMutableRawPointer, Int) -> Float)?
        switch format {
        case kCVPixelFormatType_OneComponent8:
            reader = { row, x in Float(row.load(fromByteOffset: x, as: UInt8.self)) / 255 }
        case kCVPixelFormatType_OneComponent16Half:
            reader = { row, x in MatteConfidence.halfToFloat(row.load(fromByteOffset: x * 2, as: UInt16.self)) }
        case kCVPixelFormatType_OneComponent32Float:
            reader = { row, x in row.load(fromByteOffset: x * 4, as: Float.self) }
        default:
            reader = nil
        }
        if let reader {
            CVPixelBufferLockBaseAddress(buffer, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
            guard let base = CVPixelBufferGetBaseAddress(buffer) else { return .empty }
            let stride = CVPixelBufferGetBytesPerRow(buffer)
            var values = [Float](repeating: 0, count: width * height)
            for y in 0..<height {
                let row = base + y * stride
                for x in 0..<width {
                    let v = reader(row, x)
                    values[y * width + x] = v.isFinite ? min(1, max(0, v)) : 0
                }
            }
            return MatteConfidence(width: width, height: height, values: values)
        }
        // Any other format: Core Image reads it, and its red is the mask. A bitmap's first row is its
        // top, as a pixel buffer's is (`FocusRenderTests` reads frames back the same way).
        let image = CIImage(cvPixelBuffer: buffer, options: [.colorSpace: NSNull()])
        var rgba = [Float](repeating: 0, count: width * height * 4)
        context.render(image, toBitmap: &rgba, rowBytes: width * 16,
                       bounds: CGRect(x: 0, y: 0, width: width, height: height), format: .RGBAf, colorSpace: nil)
        var values = [Float](repeating: 0, count: width * height)
        for i in 0..<(width * height) {
            let v = rgba[i * 4]
            values[i] = v.isFinite ? min(1, max(0, v)) : 0
        }
        return MatteConfidence(width: width, height: height, values: values)
    }

    /// An IEEE half as a Float, by its bits: `Float16` is not on every architecture this builds for.
    static func halfToFloat(_ h: UInt16) -> Float {
        let sign = UInt32(h >> 15) << 31
        let exponent = UInt32((h >> 10) & 0x1f)
        let mantissa = UInt32(h & 0x3ff)
        if exponent == 0 {
            // Zero, or a subnormal: mantissa * 2^-24.
            let magnitude = Float(mantissa) / 16_777_216
            return sign == 0 ? magnitude : -magnitude
        }
        if exponent == 31 {
            return Float(bitPattern: sign | 0x7f80_0000 | (mantissa << 13))
        }
        return Float(bitPattern: sign | ((exponent + 112) << 23) | (mantissa << 13))
    }
}

/// What looks at an upright frame and says how sure it is, pixel by pixel, that it is the subject.
protocol MatteSegmenter: AnyObject {
    /// What its answers keep, as the track says: `subject` or `people`.
    var target: String { get }
    /// Whether its answers want smoothing over time: true where each frame is looked at on its own.
    var smooth: Bool { get }
    /// The confidence of every pixel of `frame`, an upright 32BGRA frame.
    func confidence(of frame: CVPixelBuffer) throws -> MatteConfidence
}

/// Vision's segmenters for a matte, by what this OS has.
enum MatteSegmenters {
    /// What a search asked for `asked` keeps here: `subject` where Vision has the foreground instance
    /// mask (iOS 17), and `people` for everything else.
    static func target(for asked: String) -> String {
        guard asked == "subject" else { return "people" }
        if #available(iOS 17.0, *) { return "subject" }
        return "people"
    }

    /// The model that keeps `target`, and its revision, for the cache key: a track Vision's next model
    /// would find differently is not answered from one the last model found.
    static func model(for target: String) -> String {
        if target == "subject" {
            if #available(iOS 17.0, *) {
                return "instance-\(VNGenerateForegroundInstanceMaskRequest.currentRevision)"
            }
        }
        return "person-\(VNGeneratePersonSegmentationRequest.currentRevision)"
    }

    /// The segmenter for `target` - a still picture's when `still`, a video's frames otherwise. Refused
    /// in the simulator, after the file has been read, as `SubjectSegmenters.make` refuses there.
    static func make(target: String, still: Bool) throws -> MatteSegmenter {
        #if targetEnvironment(simulator)
        throw MatteFinder.FindError.unsupported(simulatorHasNoSegmenter)
        #else
        if target == "subject" {
            if #available(iOS 17.0, *) { return ForegroundMatteSegmenter() }
        }
        return PersonMatteSegmenter(still: still)
        #endif
    }

    static let simulatorHasNoSegmenter = SubjectSegmenters.simulatorHasNoSegmenter
}

/// iOS 17 and later: Vision's foreground instance masks, EVERY instance combined into one soft mask over
/// the whole frame at the frame's own size (`generateScaledMaskForImage`) - whatever stands out of the
/// picture, kept together. Nothing found is the empty mask.
@available(iOS 17.0, *)
final class ForegroundMatteSegmenter: MatteSegmenter {
    let target = "subject"
    let smooth = true
    private let request = VNGenerateForegroundInstanceMaskRequest()

    func confidence(of frame: CVPixelBuffer) throws -> MatteConfidence {
        let handler = VNImageRequestHandler(cvPixelBuffer: frame, orientation: .up, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.first, !observation.allInstances.isEmpty else { return .empty }
        // The same handler that performed the request: the scaled mask is made against its image.
        let mask = try observation.generateScaledMaskForImage(forInstances: observation.allInstances, from: handler)
        return MatteConfidence.read(mask)
    }
}

/// Vision's person segmentation: people and nothing else, one mask of everybody, 0...255 a pixel. A
/// picture is looked at once at `.accurate`; a video's frames at `.balanced` - `SubjectFinder`'s
/// `PersonSegmenter` - through one SEQUENCE handler, so the stateful request carries what it saw from
/// frame to frame and smooths its masks over time, as ML Kit's stream mode does on Android.
final class PersonMatteSegmenter: MatteSegmenter {
    let target = "people"
    let smooth = false
    private let still: Bool
    private let request: VNGeneratePersonSegmentationRequest
    private let sequence = VNSequenceRequestHandler()

    init(still: Bool) {
        self.still = still
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = still ? .accurate : .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        self.request = request
    }

    func confidence(of frame: CVPixelBuffer) throws -> MatteConfidence {
        if still {
            try VNImageRequestHandler(cvPixelBuffer: frame, orientation: .up, options: [:]).perform([request])
        } else {
            try sequence.perform([request], on: frame, orientation: .up)
        }
        guard let observation = request.results?.first else { return .empty }
        return MatteConfidence.read(observation.pixelBuffer)
    }
}
