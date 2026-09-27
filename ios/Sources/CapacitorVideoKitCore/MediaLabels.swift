@preconcurrency import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers
import Vision

/// What `labelMedia` resolves with: Vision's labels for a picture, or for a few frames of a video.
/// Android's `MediaLabels.kt` answers the same shape from ML Kit, with `engine: "mlkit"` and no
/// revision.
struct MediaLabelsResult {
    enum Kind: String { case video, image }

    struct Label {
        let identifier: String
        let confidence: Float
    }

    struct Frame {
        let timeMs: Int64
        let labels: [Label]
    }

    let kind: Kind
    /// `VNClassifyImageRequest`'s revision on this OS: 1 on iOS 16, 2 from iOS 17.
    let revision: Int
    let frames: [Frame]

    var json: [String: Any] {
        ["engine": "vision", "revision": revision, "kind": kind.rawValue,
         "frames": frames.map { frame in
             ["timeMs": frame.timeMs,
              "labels": frame.labels.map { ["label": $0.identifier, "confidence": MediaLabels.rounded($0.confidence)] }]
         }]
    }
}

/// The phone's own image recogniser, asked what it sees: Vision's `VNClassifyImageRequest`, which is
/// part of iOS, needs no permission and sends nothing anywhere.
///
/// A picture is decoded small, turned upright by its orientation tag, and looked at once. A video is
/// looked at in a few frames, each cut the way the filmstrip cuts one (`Thumbnailer`), with the track's
/// transform applied, so a portrait recording is read portrait.
///
/// THE FRAMES ARE ALLOWED TO SNAP, BUT NOT TOO FAR. A frame cut at the nearest keyframe costs one
/// decode and a frame cut exactly costs every frame since the keyframe before it, so the generator is
/// told how far from each time it may go: half the gap to the next time asked for, which keeps every
/// frame in its own part of the clip. With no limit at all, the frames of a screen recording - whose
/// encoder writes a keyframe every few seconds, or only when the picture changes - all snapped to the
/// same one: four of five frames of a game capture were one picture, and read as one. With the limit,
/// a phone recording (a keyframe a second or two) still costs a keyframe decode per frame, and a clip
/// whose keyframes are further apart than that pays for the exact frames it needs.
enum MediaLabels {
    enum LabelError: Error {
        /// The file will not open, the picture will not decode, or the video gives no frame.
        case unreadable(String)
        /// There is no working classifier here: the iOS simulator ([classify]).
        case unsupported(String)
    }

    struct Options {
        /// Nil is read off the file ([kind(of:)]).
        var kind: MediaLabelsResult.Kind?
        /// Source times to look at, in ms; empty is [frames] spread through the clip.
        var timesMs: [Int64]
        var frames: Int
        var minConfidence: Float
    }

    static let defaultFrames = 5
    static let maxFrames = 20
    static let defaultMinConfidence: Float = 0.1

    /// The longest edge a picture or a frame is decoded at. The classifier scales everything it is
    /// given down to its own small input, so this is about the cost of the decode, not about detail:
    /// a 48 megapixel photo read whole would be two hundred megabytes of pixels for a 360 pixel look.
    static let lookSize = 720

    static func label(_ url: URL, options: Options) async throws -> MediaLabelsResult {
        let kind = options.kind ?? kind(of: url)
        switch kind {
        case .image:
            let image = try picture(url)
            let (labels, revision) = try classify(image, minConfidence: options.minConfidence)
            return MediaLabelsResult(kind: .image, revision: revision, frames: [.init(timeMs: 0, labels: labels)])
        case .video:
            var frames: [MediaLabelsResult.Frame] = []
            var revision = VNClassifyImageRequest().revision
            for (timeMs, image) in try await videoFrames(url, options: options) {
                let (labels, used) = try classify(image, minConfidence: options.minConfidence)
                revision = used
                frames.append(.init(timeMs: timeMs, labels: labels))
            }
            return MediaLabelsResult(kind: .video, revision: revision, frames: frames)
        }
    }

    /// A picture when ImageIO reads the file as one, whatever it is called; a video otherwise. ImageIO
    /// sniffs the first bytes, so a staged render input with no extension is still told apart, and a
    /// container it has no reader for - every video - comes back with no type.
    static func kind(of url: URL) -> MediaLabelsResult.Kind {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil),
              let type = CGImageSourceGetType(source).flatMap({ UTType($0 as String) }),
              type.conforms(to: .image),
              CGImageSourceGetCount(source) > 0 else { return .video }
        return .image
    }

    /// The picture, upright and no longer than [lookSize] on its long edge. The thumbnail call is
    /// what applies the orientation tag (`WithTransform`) and decodes at the small size directly,
    /// rather than decoding the whole photo and scaling it afterwards.
    static func picture(_ url: URL) throws -> CGImage {
        guard let source = CGImageSourceCreateWithURL(url as CFURL, nil), CGImageSourceGetCount(source) > 0 else {
            throw LabelError.unreadable("\(url.lastPathComponent) will not open as a picture")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: lookSize,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            throw LabelError.unreadable("\(url.lastPathComponent) will not decode")
        }
        return image
    }

    /// The frames to look at, in time order, each with the source time of the frame the decoder
    /// actually handed over. A time that yields no frame is left out; no frame at all is a failure.
    static func videoFrames(_ url: URL, options: Options) async throws -> [(Int64, CGImage)] {
        let asset = AVURLAsset(url: url)
        let duration: CMTime
        let tracks: [AVAssetTrack]
        do {
            duration = try await asset.load(.duration)
            tracks = try await asset.loadTracks(withMediaType: .video)
        } catch {
            throw LabelError.unreadable(ErrorMapping.describe(error))
        }
        guard !tracks.isEmpty else { throw LabelError.unreadable("\(url.lastPathComponent) has no picture in it") }

        let seconds = duration.seconds
        let durationMs = (duration.isNumeric && seconds.isFinite) ? max(0, Int64((seconds * 1000).rounded())) : 0
        let (times, toleranceMs) = plan(durationMs: durationMs, timesMs: options.timesMs, frames: options.frames)

        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: lookSize, height: lookSize)
        generator.requestedTimeToleranceBefore = ms(toleranceMs)
        generator.requestedTimeToleranceAfter = ms(toleranceMs)

        var frames: [(Int64, CGImage)] = []
        for await element in generator.images(for: times.map { ms($0) }) {
            guard case .success(requestedTime: _, image: let image, actualTime: let actual) = element else { continue }
            // Two times whose shares meet at one keyframe hand back that frame twice; it is one frame.
            let takenAt = max(0, msOf(actual))
            if !frames.contains(where: { $0.0 == takenAt }) { frames.append((takenAt, image)) }
        }
        guard !frames.isEmpty else { throw LabelError.unreadable("\(url.lastPathComponent) gave no frame") }
        return frames.sorted { $0.0 < $1.0 }
    }

    /// Which source times to ask for, in order and each once, and how far the decoder may go from
    /// each: half the smallest gap between two of them, or half the clip for a single time.
    ///
    /// Given no times, `frames` of them, each at the middle of its own equal share of the clip, so
    /// none is the first frame or the last, where a camera is still being raised or already lowered.
    /// Every time is held inside the clip: a negative one is its first frame and one past the end is
    /// its last. A clip whose length could not be read is looked at once, at its start.
    static func plan(durationMs: Int64, timesMs: [Int64], frames: Int) -> (times: [Int64], toleranceMs: Int64) {
        guard durationMs > 0 else { return ([0], 0) }
        let last = max(0, durationMs - 1)
        let times: [Int64]
        if timesMs.isEmpty {
            let count = min(maxFrames, max(1, frames))
            times = (0..<count).map { index in
                min(last, Int64((Double(durationMs) * (Double(index) + 0.5) / Double(count)).rounded(.down)))
            }
        } else {
            times = timesMs.map { min(last, max(0, $0)) }
        }
        let unique = Array(Set(times)).sorted()
        guard unique.count > 1 else { return (unique, durationMs / 2) }
        let gap = zip(unique, unique.dropFirst()).map { $1 - $0 }.min() ?? durationMs
        return (unique, gap / 2)
    }

    /// Vision's labels for one picture, strongest first, none below `minConfidence`, and the
    /// classifier revision that gave them.
    static func classify(_ image: CGImage, minConfidence: Float) throws -> ([MediaLabelsResult.Label], Int) {
        #if targetEnvironment(simulator)
        throw LabelError.unsupported(simulatorHasNoClassifier)
        #else
        return try autoreleasepool {
            let request = VNClassifyImageRequest()
            let handler = VNImageRequestHandler(cgImage: image, orientation: .up, options: [:])
            try handler.perform([request])
            let labels = (request.results ?? [])
                .filter { $0.confidence >= minConfidence }
                .sorted { $0.confidence != $1.confidence ? $0.confidence > $1.confidence : $0.identifier < $1.identifier }
                .map { MediaLabelsResult.Label(identifier: $0.identifier, confidence: $0.confidence) }
            return (labels, request.revision)
        }
        #endif
    }

    /// Why the simulator refuses. Vision's classifier does not run there, and it does not say so: on
    /// the simulator's CPU it answers every picture with the same labels - a black square and a
    /// skateboarder both "outdoor, night_sky, moon" at 0.49 on iOS 26.1 and 18.5, and on 16.4 labels
    /// just as wrong, a skateboarder as "material, textile, yarn" - and it cannot open the
    /// simulator's GPU or the Neural Engine at all
    /// ("Failed to create espresso context", "Could not create inference context"). Labels that
    /// look like an answer and are not one would steer a host wrong, so it is refused as a
    /// platform without a recogniser, exactly as a browser is, after the file itself has been read:
    /// a missing or broken file is still reported as one.
    static let simulatorHasNoClassifier =
        "Vision's image classifier does not run in the iOS simulator: run on a device"

    /// Three places, which is all a confidence means, and a smaller answer across the bridge.
    static func rounded(_ confidence: Float) -> Double {
        (Double(confidence) * 1000).rounded() / 1000
    }
}
