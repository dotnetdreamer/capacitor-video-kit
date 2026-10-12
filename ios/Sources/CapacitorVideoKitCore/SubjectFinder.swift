@preconcurrency import AVFoundation
import CoreGraphics
import CoreImage
import CoreVideo
import Foundation
import ImageIO
import Vision

/// One search's question: which file, read as what, at how many frames a second.
struct SubjectRequest: Sendable {
    let url: URL
    let kind: MediaLabelsResult.Kind
    /// 1...30, already held there; ignored for a picture.
    let fps: Double
}

/// The analysis behind `findSubjects`: a video's frames - or a picture's one - turned upright and
/// looked at small, each segmented by Vision into the subjects that stand out, followed from frame to
/// frame by `SubjectTracker`, and handed back as a subject track's content. `SubjectSearches` decides
/// when one runs and where its answer is kept; this only reads and looks.
///
/// THE FRAMES are read the way a clip's own frames are read for slow motion, forward through one
/// reader, never sought: a frame per seek from `AVAssetImageGenerator` costs a decode from the
/// keyframe before it every time, and fifteen of them a second of footage is most of a clip decoded
/// over and over. A track reader decodes each frame once. Of those, the ones looked at are the first
/// at or after each of the times `k * 1000 / fps`, each stamped with its own time rather than the time
/// asked for, so the track's frames sit where the footage's do; one whose time would not move the
/// track on - two frames in the same millisecond - is skipped.
///
/// UPRIGHT. Every frame is turned by the track's transform and scaled to `lookSize` on its longer side
/// before Vision sees it, so the mask comes back over the ORIENTED frame, which is what the track's
/// grid is over: Vision is handed an upright buffer and the orientation `.up`, and nothing has to be
/// believed about how Vision orients a mask of its own. A picture comes upright out of ImageIO's
/// thumbnail call, as `MediaLabels.picture` reads one.
enum SubjectFinder {
    enum FindError: Error {
        /// The file will not open, will not decode, or holds no picture.
        case unreadable(String)
        /// There is no segmenter here: the iOS simulator.
        case unsupported(String)
    }

    /// `FindSubjectsOptions.fps`: 15 on iOS when the call does not say, and never outside 1...30.
    static let defaultFps = 15.0
    static let minFps = 1.0
    static let maxFps = 30.0

    /// The longer side a frame is looked at, in pixels. Vision scales whatever it is given down to the
    /// small input of its own model - the instance mask is 512 square whatever the picture - so a frame
    /// handed over larger only costs the scale; and a track's grid is 320 on its longer side, so this
    /// keeps more than a pixel a cell.
    static let lookSize = 512

    /// The `fps` a call asked for, held to 1...30; the default for none, or for anything not a number.
    static func fps(_ asked: Double?) -> Double {
        guard let asked, asked.isFinite else { return defaultFps }
        return min(maxFps, max(minFps, asked))
    }

    /// How far a search has got, 0...1 of the frames to look at.
    typealias Progress = @Sendable (Double) -> Void

    /// The subjects of `request`'s file, as a subject track's content. `segmenter` makes the segmenter,
    /// once the file has been read: on the simulator it throws `unsupported` (`SubjectSegmenters.make`),
    /// so a file that will not read is still reported as one, and the tests hand in one of their own.
    /// `progress` hears 0...1 of the frames to look at, as often as there is a frame; `cancelled` is
    /// asked before every frame, and a yes throws `CancellationError`.
    static func analyse(_ request: SubjectRequest,
                        segmenter: @escaping @Sendable () throws -> SubjectSegmenter = { try SubjectSegmenters.make() },
                        progress: @escaping Progress = { _ in },
                        cancelled: @escaping @Sendable () -> Bool = { false }) async throws -> SubjectTrackContent {
        switch request.kind {
        case .image:
            return try await onSearchQueue {
                try picture(request.url, segmenter: segmenter)
            }
        case .video:
            let frames = try await SubjectVideoFrames.open(request.url, fps: request.fps)
            return try await onSearchQueue {
                try video(frames, segmenter: segmenter, progress: progress, cancelled: cancelled)
            }
        }
    }

    /// Where the frames are decoded and looked at: one thread of its own, off the cooperative pool,
    /// because a search is minutes of blocking work for a long clip, and one search runs at a time.
    private static let queue = DispatchQueue(label: "net.dotnetdreamer.videokit.subjects", qos: .userInitiated)

    private static func onSearchQueue<T: Sendable>(_ body: @escaping @Sendable () throws -> T) async throws -> T {
        try await withCheckedThrowingContinuation { continuation in
            queue.async {
                continuation.resume(with: Result { try autoreleasepool { try body() } })
            }
        }
    }

    /// A picture: one frame, at time 0, upright.
    private static func picture(_ url: URL, segmenter make: () throws -> SubjectSegmenter) throws -> SubjectTrackContent {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0 else {
            throw FindError.unreadable("\(url.lastPathComponent) will not open as a picture")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: lookSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              image.width > 0, image.height > 0,
              let frame = SubjectFrames.buffer(of: image) else {
            throw FindError.unreadable("\(url.lastPathComponent) will not decode")
        }
        let segmenter = try make()
        // The grid is in proportion to the picture as it stands upright, at its own size: the
        // thumbnail's sides are rounded to whole pixels at a smaller one.
        let upright = uprightSize(source) ?? CGSize(width: image.width, height: image.height)
        let grid = SubjectTracking.subjectGrid(width: Double(upright.width), height: Double(upright.height))
        let tracker = SubjectTracker(width: grid.width, height: grid.height)
        let (cells, count) = try segmenter.mask(of: frame).cells(width: grid.width, height: grid.height)
        tracker.add(timeMs: 0, instances: cells, count: count)
        return tracker.finish(engine: SubjectSegmenters.engine, kind: "image", durationMs: 0, fps: 0,
                              subjectKind: segmenter.subjectKind)
    }

    /// A video, frame by frame at the analysis cadence.
    private static func video(_ frames: SubjectVideoFrames, segmenter make: () throws -> SubjectSegmenter,
                              progress: Progress, cancelled: () -> Bool) throws -> SubjectTrackContent {
        // The first frame before the segmenter, so a video that gives none is reported as one wherever
        // the call is made, the simulator included.
        guard let first = try frames.next() else {
            throw FindError.unreadable("\(frames.name) gave no frame")
        }
        let segmenter = try make()
        let grid = SubjectTracking.subjectGrid(width: frames.uprightWidth, height: frames.uprightHeight)
        let tracker = SubjectTracker(width: grid.width, height: grid.height)
        var frame: (timeMs: Int64, buffer: CVPixelBuffer)? = first
        while let current = frame {
            if cancelled() { throw CancellationError() }
            try autoreleasepool {
                let (cells, count) = try segmenter.mask(of: current.buffer).cells(width: grid.width, height: grid.height)
                tracker.add(timeMs: Double(current.timeMs), instances: cells, count: count)
            }
            progress(frames.progress)
            frame = try frames.next()
        }
        return tracker.finish(engine: SubjectSegmenters.engine, kind: "video", durationMs: frames.durationMs,
                              fps: frames.fps, subjectKind: segmenter.subjectKind)
    }

    /// A picture's pixel size as it stands upright, its EXIF orientation applied.
    private static func uprightSize(_ source: CGImageSource) -> CGSize? {
        guard let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
              let width = properties[kCGImagePropertyPixelWidth] as? Int,
              let height = properties[kCGImagePropertyPixelHeight] as? Int,
              width > 0, height > 0 else { return nil }
        let orientation = properties[kCGImagePropertyOrientation] as? Int ?? 1
        // 5 to 8 are the four that turn the picture a quarter.
        return (5...8).contains(orientation) ? CGSize(width: height, height: width) : CGSize(width: width, height: height)
    }
}

/// A video's frames at the analysis cadence, upright and small, read forward through one track reader.
///
/// Confined to one thread at a time - it is opened by an async load and then read on the search queue
/// and nowhere else - which is what makes the `@unchecked Sendable` honest: `AVAssetReader` is not
/// sendable, and nothing here is touched from two threads at once.
final class SubjectVideoFrames: @unchecked Sendable {
    /// The file's name, for a failure.
    let name: String
    /// The frame's size upright, in the source's own pixels: what the track's grid is in proportion to.
    let uprightWidth: Double
    let uprightHeight: Double
    /// How long the source is, as `probe` reads it.
    let durationMs: Double
    let fps: Double
    /// How many frames are to be looked at: one for each `k * 1000 / fps` before the picture ends.
    let targets: Int

    private let reader: AVAssetReader
    private let output: AVAssetReaderTrackOutput
    private let orientation: CGImagePropertyOrientation
    private let frames: SubjectFrames
    /// The index of the next time to look at, and the millisecond of the last frame looked at.
    private var target = 0
    private var lastMs: Int64 = -1

    /// Two frames this close are one, as in slow motion (`SlowMotion.SAME_FRAME_S`), in ms.
    private static let sameFrameMs = 0.001

    private init(name: String, uprightWidth: Double, uprightHeight: Double, durationMs: Double, fps: Double,
                 targets: Int, reader: AVAssetReader, output: AVAssetReaderTrackOutput,
                 orientation: CGImagePropertyOrientation, frames: SubjectFrames) {
        self.name = name
        self.uprightWidth = uprightWidth
        self.uprightHeight = uprightHeight
        self.durationMs = durationMs
        self.fps = fps
        self.targets = targets
        self.reader = reader
        self.output = output
        self.orientation = orientation
        self.frames = frames
    }

    deinit { reader.cancelReading() }

    /// Opens `url`'s video track and starts a reader at its first frame.
    static func open(_ url: URL, fps: Double) async throws -> SubjectVideoFrames {
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let track: AVAssetTrack
        let duration: CMTime
        let transform: CGAffineTransform
        let natural: CGSize
        let range: CMTimeRange
        do {
            duration = try await asset.load(.duration)
            guard let found = try await asset.loadTracks(withMediaType: .video).first else {
                throw SubjectFinder.FindError.unreadable("\(url.lastPathComponent) has no picture in it")
            }
            track = found
            (transform, natural, range) = try await track.load(.preferredTransform, .naturalSize, .timeRange)
        } catch let refused as SubjectFinder.FindError {
            throw refused
        } catch {
            throw SubjectFinder.FindError.unreadable(ErrorMapping.describe(error))
        }

        let seconds = duration.seconds
        let durationMs = duration.isNumeric && seconds.isFinite ? max(0, seconds * 1000) : 0
        // The times looked at stop where the picture does, which for a file whose sound runs on past
        // its picture is before the asset's end.
        let pictureEnd = range.end.isNumeric && range.end.seconds.isFinite ? range.end.seconds * 1000 : durationMs
        let lastMs = min(durationMs > 0 ? durationMs : pictureEnd, pictureEnd)
        var targets = max(0, Int((lastMs * fps / 1000).rounded(.up)))
        while targets > 0 && Double(targets - 1) * 1000 / fps >= lastMs { targets -= 1 }
        while Double(targets) * 1000 / fps < lastMs { targets += 1 }

        // Transform the RECT, as `Thumbnailer.probe` does: a quarter turn hands back negative sizes.
        let upright = CGRect(origin: .zero, size: natural).applying(transform)
        let width = abs(upright.width), height = abs(upright.height)
        guard width > 0, height > 0 else {
            throw SubjectFinder.FindError.unreadable("\(url.lastPathComponent) has no picture in it")
        }

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: asset)
        } catch {
            throw SubjectFinder.FindError.unreadable(ErrorMapping.describe(error))
        }
        // Biplanar 4:2:0 in VIDEO range, what an H.264 or HEVC decoder hands over of an 8-bit stream as it
        // is: every frame is decoded and most are passed over, so none should be converted on the way out.
        // Measured on a 120 fps 1080x2340 recording, the full-range format cost 1.9 ms a frame against 0.7
        // for this one, the difference being a conversion of every frame, eight of them for each looked at.
        // Core Image turns the ones looked at into RGB.
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange),
            kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
        ])
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else {
            throw SubjectFinder.FindError.unreadable("\(url.lastPathComponent) will not decode")
        }
        reader.add(output)
        guard reader.startReading() else {
            throw SubjectFinder.FindError.unreadable(reader.error.map(ErrorMapping.describe) ?? "\(url.lastPathComponent) will not decode")
        }
        let look = SubjectFrames.lookSize(width: width, height: height)
        return SubjectVideoFrames(name: url.lastPathComponent, uprightWidth: Double(width), uprightHeight: Double(height),
                                  durationMs: durationMs, fps: fps, targets: targets, reader: reader, output: output,
                                  orientation: Orientation.imageOrientation(transform),
                                  frames: SubjectFrames(width: look.width, height: look.height))
    }

    /// 0...1 of the times to look at that have been looked at.
    var progress: Double { targets == 0 ? 1 : Double(min(target, targets)) / Double(targets) }

    /// The next frame to look at - the first at or after the next time, its own time rounded to the
    /// millisecond, upright and small - or nil when every time is behind or the footage has run out.
    func next() throws -> (timeMs: Int64, buffer: CVPixelBuffer)? {
        while target < targets {
            guard let sample = output.copyNextSampleBuffer() else {
                if reader.status == .failed {
                    throw SubjectFinder.FindError.unreadable(reader.error.map(ErrorMapping.describe) ?? "\(name) stopped decoding")
                }
                return nil
            }
            guard let image = CMSampleBufferGetImageBuffer(sample) else { continue }
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            guard pts.isNumeric else { continue }
            let t = pts.seconds * 1000
            if t + Self.sameFrameMs < time(target) { continue }
            // The track keeps whole milliseconds and refuses a time that does not move on.
            let ms = Int64(jsRound(t))
            if ms <= lastMs { continue }
            // Every time this frame is at or after is looked at, by this frame.
            while target < targets && time(target) <= t + Self.sameFrameMs { target += 1 }
            lastMs = ms
            guard let buffer = frames.upright(image, orientation: orientation) else {
                throw SubjectFinder.FindError.unreadable("\(name): a frame would not convert")
            }
            return (ms, buffer)
        }
        reader.cancelReading()
        return nil
    }

    private func time(_ index: Int) -> Double { Double(index) * 1000 / fps }
}

/// Frames made upright and small for Vision: 32BGRA, IOSurface-backed, from a pool of one size.
final class SubjectFrames {
    let width: Int
    let height: Int
    private var pool: CVPixelBufferPool?

    /// Colour management off, as the compositor's context has it: Vision is shown the stored values,
    /// and nothing is spent converting them into a space nobody looks at.
    private static let context = CIContext(options: [
        .workingColorSpace: NSNull(),
        .outputColorSpace: NSNull(),
        .cacheIntermediates: false,
        .name: "VideoKitSubjectFrames",
    ])

    init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    /// The size a frame of `width` x `height` is looked at: `SubjectFinder.lookSize` on its longer side,
    /// or its own size when that is smaller.
    static func lookSize(width: CGFloat, height: CGFloat) -> (width: Int, height: Int) {
        let scale = min(1, CGFloat(SubjectFinder.lookSize) / max(width, height))
        return (max(1, Int((width * scale).rounded())), max(1, Int((height * scale).rounded())))
    }

    /// `image`, a decoded frame as stored, turned by `orientation` and scaled into a frame of this size.
    func upright(_ image: CVPixelBuffer, orientation: CGImagePropertyOrientation) -> CVPixelBuffer? {
        let turned = CIImage(cvPixelBuffer: image).oriented(orientation)
        let extent = turned.extent
        guard extent.width > 0, extent.height > 0, let out = buffer() else { return nil }
        let fitted = turned.transformed(by: CGAffineTransform(translationX: -extent.minX, y: -extent.minY)
            .concatenating(CGAffineTransform(scaleX: CGFloat(width) / extent.width, y: CGFloat(height) / extent.height)))
        Self.context.render(fitted, to: out, bounds: CGRect(x: 0, y: 0, width: width, height: height), colorSpace: nil)
        return out
    }

    /// A picture drawn into a frame of its own size, on black: a transparent PNG shows what it is drawn
    /// over, and black is what a render draws it over.
    static func buffer(of image: CGImage) -> CVPixelBuffer? {
        let frames = SubjectFrames(width: image.width, height: image.height)
        guard let out = frames.buffer() else { return nil }
        CVPixelBufferLockBaseAddress(out, [])
        defer { CVPixelBufferUnlockBaseAddress(out, []) }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: CVPixelBufferGetBaseAddress(out), width: image.width, height: image.height,
                                  bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(out), space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue)
        else { return nil }
        let whole = CGRect(x: 0, y: 0, width: image.width, height: image.height)
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(whole)
        ctx.draw(image, in: whole)
        return out
    }

    private func buffer() -> CVPixelBuffer? {
        if pool == nil {
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ]
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool)
        }
        guard let pool else { return nil }
        var out: CVPixelBuffer?
        CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out)
        return out
    }
}

// MARK: - Segmenters

/// A segmenter's map of one frame, over the whole of it, row by row with no padding.
struct SubjectMask {
    let width: Int
    let height: Int
    let values: [UInt8]
    /// How many instances the values number, 1...`instances`, for Vision's instance mask; nil for a
    /// mask of confidences, 0...255, which `cells` thresholds at one half and splits into the groups
    /// that touch.
    let instances: Int?

    /// Nothing stood out.
    static let empty = SubjectMask(width: 1, height: 1, values: [0], instances: 0)

    /// The mask on a `width` x `height` grid, and how many instances the grid numbers: `toGrid`, and
    /// for confidences `componentsOf` after it, exactly as the reference tracker's callers do.
    func cells(width gridWidth: Int, height gridHeight: Int) -> (cells: [UInt8], count: Int) {
        var grid = [UInt8](repeating: 0, count: gridWidth * gridHeight)
        guard width > 0, height > 0, values.count >= width * height else { return (grid, 0) }
        if let instances {
            SubjectTracking.toGrid(maskWidth: width, maskHeight: height, gridWidth: gridWidth, gridHeight: gridHeight,
                                   into: &grid) { x, y in Double(values[y * width + x]) }
            return (grid, min(255, max(0, instances)))
        }
        SubjectTracking.toGrid(maskWidth: width, maskHeight: height, gridWidth: gridWidth, gridHeight: gridHeight,
                               threshold: 0.5, into: &grid) { x, y in Double(values[y * width + x]) / 255 }
        // Numbered first, then handed back: a tuple of the two would copy the grid before the numbers
        // were written over it.
        let groups = SubjectTracking.componentsOf(&grid, width: gridWidth, height: gridHeight)
        return (grid, groups)
    }

    /// A one-byte-a-pixel buffer's pixels, its row padding left out.
    static func bytes(of buffer: CVPixelBuffer) -> (width: Int, height: Int, values: [UInt8]) {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer)?.assumingMemoryBound(to: UInt8.self) else {
            return (0, 0, [])
        }
        var values = [UInt8](repeating: 0, count: width * height)
        for y in 0..<height {
            for x in 0..<width { values[y * width + x] = base[y * stride + x] }
        }
        return (width, height, values)
    }
}

/// What looks at a frame and says where its subjects are.
protocol SubjectSegmenter: AnyObject {
    /// `person` where it finds only people, `subject` where it finds anything that stands out.
    var subjectKind: String { get }
    /// The mask of `frame`, an upright 32BGRA frame.
    func mask(of frame: CVPixelBuffer) throws -> SubjectMask
}

/// Vision's segmenters, by what this OS has.
enum SubjectSegmenters {
    /// `SubjectEngine` on iOS, whichever model answers.
    static let engine = "vision"

    /// Which model answers on this OS, and its revision, for the cache key: a track Vision's next
    /// model would find differently is not answered from one the last model found.
    static var model: String {
        if #available(iOS 17.0, *) {
            return "instance-\(VNGenerateForegroundInstanceMaskRequest.currentRevision)"
        } else {
            return "person-\(VNGeneratePersonSegmentationRequest.currentRevision)"
        }
    }

    /// The segmenter for this OS. Refused in the simulator, after the file has been read, as
    /// `MediaLabels.classify` refuses there: Vision's models do not run reliably on the simulator's
    /// CPU, and a track that looks like an answer and is not one would steer a host wrong.
    static func make() throws -> SubjectSegmenter {
        #if targetEnvironment(simulator)
        throw SubjectFinder.FindError.unsupported(simulatorHasNoSegmenter)
        #else
        if #available(iOS 17.0, *) {
            return InstanceSegmenter()
        } else {
            return PersonSegmenter()
        }
        #endif
    }

    static let simulatorHasNoSegmenter =
        "Vision's subject segmentation does not run in the iOS simulator: run on a device"
}

/// iOS 17 and later: Vision's foreground instance masks, which separate people, pets and things from
/// what is behind them and number them 1...n. The mask is SQUARE whatever the picture and stretched
/// over all of it, which is exactly what `toGrid` reads it as.
@available(iOS 17.0, *)
final class InstanceSegmenter: SubjectSegmenter {
    let subjectKind = "subject"
    private let request = VNGenerateForegroundInstanceMaskRequest()

    func mask(of frame: CVPixelBuffer) throws -> SubjectMask {
        let handler = VNImageRequestHandler(cvPixelBuffer: frame, orientation: .up, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.first else { return .empty }
        let (width, height, values) = SubjectMask.bytes(of: observation.instanceMask)
        return SubjectMask(width: width, height: height, values: values,
                           instances: observation.allInstances.max() ?? 0)
    }
}

/// iOS 16: Vision's person segmentation - people and nothing else, one mask of everybody, 0...255 a
/// pixel for how sure it is - which `SubjectMask.cells` thresholds and splits into the people who do
/// not touch.
final class PersonSegmenter: SubjectSegmenter {
    let subjectKind = "person"
    private let request: VNGeneratePersonSegmentationRequest = {
        let request = VNGeneratePersonSegmentationRequest()
        request.qualityLevel = .balanced
        request.outputPixelFormat = kCVPixelFormatType_OneComponent8
        return request
    }()

    func mask(of frame: CVPixelBuffer) throws -> SubjectMask {
        let handler = VNImageRequestHandler(cvPixelBuffer: frame, orientation: .up, options: [:])
        try handler.perform([request])
        guard let observation = request.results?.first else { return .empty }
        let (width, height, values) = SubjectMask.bytes(of: observation.pixelBuffer)
        return SubjectMask(width: width, height: height, values: values, instances: nil)
    }
}
