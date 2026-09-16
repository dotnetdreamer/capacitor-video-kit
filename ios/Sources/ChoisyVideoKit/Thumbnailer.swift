@preconcurrency import AVFoundation
import CoreGraphics
import CryptoKit
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// What `probe({ uri })` resolves with. All six keys are always present: `rotation` is informational
/// but the TS contract declares it, and an absent key reads as `undefined` in JS, which is a
/// different thing from `0`.
struct ProbeResult: Sendable {
    let durationMs: Int64
    /// DISPLAY dimensions, with the track's preferred transform already applied, so a portrait
    /// recording that stores 1920x1080 plus a 90 degree rotation reports 1080x1920 the way the
    /// editor draws it.
    let width: Int
    let height: Int
    let rotation: Int
    let hasAudio: Bool
    let hasVideo: Bool

    var json: [String: Any] {
        ["durationMs": durationMs, "width": width, "height": height,
         "rotation": rotation, "hasAudio": hasAudio, "hasVideo": hasVideo]
    }
}

/// Frame extraction and file inspection, shared by the plugin's `probe` and `thumbnails` methods,
/// by the exporter's result builder and by the voice recorder.
///
/// Android reaches for `MediaMetadataRetriever` for all three jobs; iOS splits them between
/// `AVURLAsset` property loads and `AVAssetImageGenerator`, but the answers are deliberately the
/// same shape so a filmstrip cut on one platform lines up with the other's.
enum Thumbnailer {

    // MARK: - Probe

    /// Works on audio-only files, answering `hasVideo: false` with zero dimensions: the editor
    /// probes music and voice takes through this same call purely for their duration.
    ///
    /// Every caller treats `durationMs <= 0` as "could not read it" and falls back, so returning 0
    /// is a legitimate answer. Throwing is reserved for a file that cannot be opened at all.
    static func probe(_ url: URL) async throws -> ProbeResult {
        // Precise timing costs a container scan on a file with no duration atom, which is exactly
        // the case (a still-muxing recording) where the cheap answer is wrong.
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let duration = try await asset.load(.duration)
        let video = try await asset.loadTracks(withMediaType: .video).first
        let audio = try await asset.loadTracks(withMediaType: .audio).first

        var width = 0
        var height = 0
        var rotation = 0
        if let track = video {
            let (natural, transform) = try await track.load(.naturalSize, .preferredTransform)
            // Transform the RECT, not the size. CGSize.applying can hand back negative components
            // for a 90 or 180 degree transform, while a rect's bounding box is always positive.
            let box = CGRect(origin: .zero, size: natural).applying(transform)
            width = Int(abs(box.width).rounded())
            height = Int(abs(box.height).rounded())
            rotation = rotationDegrees(transform)
        }

        // An indefinite or invalid duration (a live stream, a truncated container) makes `.seconds`
        // NaN, and Int64(NaN) traps rather than returning anything.
        let seconds = duration.seconds
        let durationMs = (duration.isNumeric && seconds.isFinite) ? Int64((seconds * 1000).rounded()) : 0

        return ProbeResult(durationMs: max(0, durationMs), width: width, height: height,
                           rotation: rotation, hasAudio: audio != nil, hasVideo: video != nil)
    }

    /// Clockwise degrees, the same convention as Android's `METADATA_KEY_VIDEO_ROTATION`:
    /// identity is 0, (0,1,-1,0) is 90, (-1,0,0,-1) is 180, (0,-1,1,0) is 270.
    ///
    /// The snap to a quarter turn is not cosmetic: a mirrored front-camera transform carries a
    /// scale of -1 on one axis and lands a degree or two off, and the contract promises one of
    /// exactly four values.
    static func rotationDegrees(_ t: CGAffineTransform) -> Int {
        let radians = atan2(t.b, t.a)
        guard radians.isFinite else { return 0 }
        var degrees = Int((radians * 180 / .pi).rounded())
        degrees = ((degrees % 360) + 360) % 360
        return Int((Double(degrees) / 90).rounded()) * 90 % 360
    }

    // MARK: - Filmstrip

    /// Returns one URL per requested time, in the requested order, always. The editor indexes the
    /// returned array against its own time array to position tiles, so a dropped entry does not
    /// shorten the strip, it shifts every tile after it against the timeline.
    ///
    /// Cached on disk by (source signature, time, maxHeight, precise). Reopening a clip in the
    /// editor is the common case and it should not decode a single frame.
    static func thumbnails(_ url: URL, timesMs: [Int64], maxHeight rawMaxHeight: Int,
                           precise: Bool) async throws -> [URL] {
        if timesMs.isEmpty { return [] }                            // never open a decoder for nothing
        let maxHeight = min(1080, max(16, rawMaxHeight))            // Android's coerceIn(16, 1080)
        let dir = JobFolders.thumbsDir()
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let sourceKey = cacheKey(for: url)

        // Pass 1: whatever is already on disk. Android checks this per time before it opens a
        // retriever, and the editor's own "paid once, the frames are cached by time" comment
        // depends on it being here rather than in JS.
        var results = [URL?](repeating: nil, count: timesMs.count)
        var wanted: [(index: Int, timeMs: Int64)] = []
        for (i, raw) in timesMs.enumerated() {
            let clamped = max(0, raw)
            let file = dir.appendingPathComponent(cacheName(sourceKey, clamped, maxHeight, precise))
            if fileBytes(file) > 0 {
                results[i] = file
            } else {
                wanted.append((i, clamped))
            }
        }

        if !wanted.isEmpty {
            // A duplicated time (the strip's step can land twice on a very short clip) must not be
            // asked for twice; the generator would decode it twice for one picture.
            var uniqueTimes: [Int64] = []
            var seen = Set<Int64>()
            for entry in wanted where !seen.contains(entry.timeMs) {
                seen.insert(entry.timeMs)
                uniqueTimes.append(entry.timeMs)
            }
            uniqueTimes.sort()

            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true         // a portrait clip comes out portrait
            // Android's getScaledFrameAtTime box. A full box rather than an unconstrained width,
            // so an ultra-wide source produces the same tile on both platforms.
            generator.maximumSize = CGSize(width: maxHeight * 2, height: maxHeight)
            // `precise` maps to tolerances and to nothing else. false is Android's
            // OPTION_CLOSEST_SYNC (jump to the keyframe, one decode), true is OPTION_CLOSEST
            // (decode forward from the keyframe before the time). A fixed half-second tolerance
            // would be neither, and the two platforms would disagree about which frame a tile shows.
            generator.requestedTimeToleranceBefore = precise ? .zero : .positiveInfinity
            generator.requestedTimeToleranceAfter = precise ? .zero : .positiveInfinity

            // Key by the REQUESTED time rather than trusting the sequence order: the batch mode is
            // documented as time ordered, not request ordered, and we asked in ascending order.
            var byTime: [Int64: URL] = [:]
            for await element in generator.images(for: uniqueTimes.map { ms($0) }) {
                guard case .success(requestedTime: let time, image: let image, actualTime: _) = element else {
                    continue                                        // fillGaps deals with it below
                }
                let key = msOf(time)
                let file = dir.appendingPathComponent(cacheName(sourceKey, key, maxHeight, precise))
                if let written = try? writeJPEG(downsample(image, maxHeight: maxHeight), to: file, quality: 0.8) {
                    byTime[key] = written
                }
            }
            for entry in wanted { results[entry.index] = byTime[entry.timeMs] }
        }

        return fillGaps(results, in: dir)
    }

    /// `"<sourceKey>-<timeMs>-<maxHeight>[-p].jpg"`. The height and the precise suffix both belong
    /// in the name: a precise tile is a different picture of the same moment, and a strip asked for
    /// precisely must never be served the keyframes an earlier sloppy request left behind.
    private static func cacheName(_ sourceKey: String, _ timeMs: Int64, _ maxHeight: Int, _ precise: Bool) -> String {
        "\(sourceKey)-\(timeMs)-\(maxHeight)\(precise ? "-p" : "").jpg"
    }

    /// The signature covers path, length and modification time, exactly as Android's does, so a
    /// re-recorded take written to the same job-folder path can never serve the old clip's strip.
    private static func cacheKey(for url: URL) -> String {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = values?.fileSize ?? 0
        let modified = Int64(((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded())
        let signature = "\(url.absoluteString)|\(size)|\(modified)"
        let digest = SHA256.hash(data: Data(signature.utf8))
        return String(digest.map { String(format: "%02x", $0) }.joined().prefix(24))
    }

    /// Android's `fillGaps`: nearest earlier tile, then nearest later one, then one shared
    /// placeholder. Filling forward from an already-filled slot is intentional and matches Android;
    /// both routes end at the same picture.
    private static func fillGaps(_ urls: [URL?], in dir: URL) -> [URL] {
        guard urls.contains(where: { $0 == nil }) else { return urls.compactMap { $0 } }
        var filled = urls
        for i in filled.indices where filled[i] == nil {
            filled[i] = (0..<i).reversed().compactMap { filled[$0] }.first
                ?? ((i + 1)..<filled.count).compactMap { filled[$0] }.first
        }
        guard filled.contains(where: { $0 == nil }) else { return filled.compactMap { $0 } }
        let placeholder = blackTile(in: dir)
        return filled.map { $0 ?? placeholder }
    }

    /// One shared 2x2 black tile, written once under a name that cannot collide with a real time.
    ///
    /// Never write this under a requested time's cache name. The cache-hit pass above would serve
    /// it forever, so a single transient decode failure would black that tile out for the life of
    /// the file.
    private static func blackTile(in dir: URL) -> URL {
        let file = dir.appendingPathComponent("placeholder.jpg")
        if fileBytes(file) > 0 { return file }
        if let ctx = CGContext(data: nil, width: 2, height: 2, bitsPerComponent: 8, bytesPerRow: 0,
                               space: CGColorSpaceCreateDeviceRGB(),
                               bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) {
            ctx.setFillColor(red: 0, green: 0, blue: 0, alpha: 1)
            ctx.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
            if let image = ctx.makeImage() { _ = try? writeJPEG(image, to: file, quality: 0.8) }
        }
        return file
    }

    // MARK: - Poster

    /// Android's `OPTION_CLOSEST` then `OPTION_CLOSEST_SYNC`, translated: ask for the exact frame
    /// first, fall back to the nearest keyframe.
    ///
    /// Returns false rather than throwing. A finished render is never failed because its poster
    /// could not be cut; the caller sends `posterUri: ""` and the server cuts its own.
    static func poster(from videoURL: URL, atMs: Int64, to dest: URL) async -> Bool {
        let generator = AVAssetImageGenerator(asset: AVURLAsset(url: videoURL))
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = .zero                               // .zero is "do not scale"
        // Our own output carries roughly one keyframe a second, so half a second off is a visibly
        // different moment. Ask precisely first.
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero

        let at = ms(max(0, atMs))
        try? FileManager.default.createDirectory(at: dest.deletingLastPathComponent(),
                                                 withIntermediateDirectories: true)
        if let image = try? await generator.image(at: at).image,
           (try? writeJPEG(image, to: dest, quality: 0.85)) != nil {
            return true
        }
        // The second attempt has to be a DIFFERENT request. Retrying at zero tolerance repeats the
        // one that just failed; infinite tolerance is what lets the decoder answer with the
        // keyframe it already has.
        generator.requestedTimeToleranceBefore = .positiveInfinity
        generator.requestedTimeToleranceAfter = .positiveInfinity
        if let image = try? await generator.image(at: at).image,
           (try? writeJPEG(image, to: dest, quality: 0.85)) != nil {
            return true
        }
        return false
    }

    // MARK: - Pixels and bytes

    /// Belt and braces around `maximumSize`, which is a bounding box and rounds to the encoder's
    /// liking: the contract promises the longest edge of the produced JPEG, not an approximation.
    private static func downsample(_ image: CGImage, maxHeight: Int) -> CGImage {
        guard image.height > maxHeight, image.height > 0 else { return image }
        let scale = Double(maxHeight) / Double(image.height)
        let width = max(1, Int((Double(image.width) * scale).rounded()))
        guard let ctx = CGContext(data: nil, width: width, height: maxHeight, bitsPerComponent: 8,
                                  bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return image }
        ctx.interpolationQuality = .high
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: width, height: maxHeight))
        return ctx.makeImage() ?? image
    }

    /// ImageIO rather than UIKit, so none of this needs a main thread or a UIImage round trip.
    ///
    /// The file is written under a hidden sibling name and moved into place, because the cache-hit
    /// check is a size test: a half-written file that an interrupted call left behind would look
    /// like a valid tile forever.
    @discardableResult
    private static func writeJPEG(_ image: CGImage, to dest: URL, quality: Double) throws -> URL {
        let tmp = dest.deletingLastPathComponent().appendingPathComponent(".\(UUID().uuidString).jpg")
        guard let out = CGImageDestinationCreateWithURL(tmp as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else {
            throw CocoaError(.fileWriteUnknown)
        }
        CGImageDestinationAddImage(out, image, [kCGImageDestinationLossyCompressionQuality: quality] as CFDictionary)
        guard CGImageDestinationFinalize(out) else {
            try? FileManager.default.removeItem(at: tmp)
            throw CocoaError(.fileWriteUnknown)
        }
        try? FileManager.default.removeItem(at: dest)               // moveItem refuses an existing destination
        do {
            try FileManager.default.moveItem(at: tmp, to: dest)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
        return dest
    }

    /// 0 for a file that is not there, which is what every caller means by "unusable".
    static func fileBytes(_ url: URL) -> Int64 {
        guard let size = try? url.resourceValues(forKeys: [.fileSizeKey]).fileSize else { return 0 }
        return Int64(size)
    }
}
