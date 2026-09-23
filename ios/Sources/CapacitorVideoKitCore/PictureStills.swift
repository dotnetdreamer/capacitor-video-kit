@preconcurrency import AVFoundation
import CoreGraphics
import CoreVideo
import Foundation
import ImageIO

/// Every picture on the timeline, turned into footage as the composition is laid.
///
/// AVFoundation has no still-image item. An `AVMutableComposition` is built from time ranges of
/// tracks and a JPEG has no track, so a picture handed to `SourceCache` as it is fails there with
/// "no video track". Android hands Media3 a picture as an image item and the web draws it off a
/// decoded bitmap; here each distinct picture becomes a short H.264 file of one frame instead,
/// written into the job folder, and `SourceCache` opens that file wherever the picture's `uri` is
/// named - on the base track, on a layer, and as a transition's outgoing side. From there on nothing
/// downstream can tell a picture from a video, and that is the point: orientation, crop, fit,
/// placement, turn and every transition apply to a picture because they apply to a frame.
///
/// A still is written when `SourceCache` first asks for its picture, not up front, so the files are
/// opened in one pass in the builder's order with pictures and videos mixed, as Android's preflight
/// opens them: when a broken video comes before a broken picture, the video is the clip blamed on
/// both platforms. A spec with no picture in it never creates the folder or reads a byte.
///
/// The stills are the render's alone. `JobRegistry.run` deletes them once the export has finished,
/// failed or been cancelled, or the build has thrown, before it reports how the render ended; a
/// render whose app was killed leaves them for `JobFolders.cleanup` or the launch sweep.
struct PictureStills {

    /// Where the stills are written: inside the job folder, so `JobFolders.cleanup` takes whatever a
    /// killed render left with the rest of the post.
    static func folder(_ batchId: String) -> URL {
        JobFolders.jobDir(batchId).appendingPathComponent("pictures", isDirectory: true)
    }

    /// The margin every still runs past the longest trim that names it: one frame at 30 fps. The
    /// builder clamps a clip's range to its file's video track, and a file that ended a rounding
    /// error short of the trim would shave that error off the picture's time on screen. It is also
    /// where the second frame goes, so the file's last sample has a length of its own.
    private static let frame = CMTime(value: 1, timescale: 30)

    /// The largest picture a still is ever made from, in pixels. Twice the output's long side leaves
    /// room for a crop or a transition's zoom to stay sharp, and 4096 caps it for an output that is
    /// already large. The area cap is H.264's own: 3840x2160 fits the frame-size limit of the levels
    /// a phone's encoder works to, and a 4:3 photo held only to a long side of 3840 would not.
    private static let maxLongSide = 4096
    private static let maxArea = 3840 * 2160

    /// How long each picture's still has to run, by the picture's `uri`. Empty for a post with no
    /// pictures, which then pays for nothing but the pass over its clips that found none.
    private let lengthsMs: [String: Int64]
    private let longSide: Int
    private let batchId: String

    /// Every picture `uri` in the spec, with the longest trim any clip asks of it.
    ///
    /// The builder reads a picture's range out of its still as it reads a video's out of its file,
    /// so the still must run to the furthest `outMs` that names it: a picture's own clips start at
    /// 0, but a transition's outgoing side is the same picture from later on, and a picture cut in
    /// two reads its second half from the middle. One still serves them all, so the length has to
    /// be known before the first of them is laid, and this pass over the spec is where it comes
    /// from.
    init(spec: ComposeSpec) {
        var lengthsMs: [String: Int64] = [:]
        for clip in spec.everyClip where clip.image {
            lengthsMs[clip.uri] = max(lengthsMs[clip.uri] ?? 0, clip.outMs)
        }
        self.lengthsMs = lengthsMs
        self.longSide = min(Self.maxLongSide, 2 * max(spec.output.width, spec.output.height))
        self.batchId = spec.batchId
    }

    /// Writes the still for `clip`'s picture and answers where it is, or answers nil when the
    /// clip's `uri` is not a picture. `SourceCache` calls this once per `uri`, for the first clip
    /// that names it, and that clip is the one a failure is reported against.
    ///
    /// Throws `BuildError.unreadable` naming `clip` for a picture that will not open or decode - the
    /// `unreadable_input` Android's preflight and the web's reader report for it - and whatever the
    /// writer threw for a still that would not encode, which `ErrorMapping` sorts into `no_space`,
    /// `encoder` and the rest exactly as it does an export's. Cancellation is checked before each
    /// still and while one is being written.
    func still(for clip: ComposeClip) async throws -> URL? {
        guard let lengthMs = lengthsMs[clip.uri] else { return nil }
        try Task.checkCancellation()

        let dir = Self.folder(batchId)
        do {
            try JobFolders.ensure(dir)
        } catch {
            throw BuildError.internalFailure("could not create \(dir.path): \(error)")
        }
        let image = try Self.decode(clip, longSide: longSide)
        let url = dir.appendingPathComponent("\(RenderInputs.stableName(for: clip.uri)).mp4")
        try await Self.encode(image, for: clip.key, lengthMs: lengthMs, to: url)
        return url
    }

    /// The picture, upright and no larger than a still needs, decoded straight to that size.
    ///
    /// ImageIO's thumbnail path does all three things at once: it turns the image by its EXIF
    /// orientation, it decodes a 48 MP photo to the size asked for without ever holding it whole,
    /// and it reads the file's CONTENT rather than its name. The last matters because `prepareJob`
    /// names an input that arrived without an extension `.mp4`, and a picture has to decode then.
    private static func decode(_ clip: ComposeClip, longSide: Int) throws -> CGImage {
        guard let url = JobFolders.fileURL(from: clip.uri) else {
            throw BuildError.unreadable(clip.key, "unsupported uri")
        }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: longSide,
            kCGImageSourceShouldCacheImmediately: true,
        ]
        guard let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let image = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary),
              image.width > 0, image.height > 0 else {
            throw BuildError.unreadable(clip.key, "\(url.lastPathComponent) is not a picture this phone can decode")
        }
        return image
    }

    /// Writes `image` as an H.264 file of `lengthMs` plus a frame, and checks it came out that long.
    /// `key` is the clip the still is written for, which every failure names.
    ///
    /// The file is the picture's OWN shape, never letterboxed or cropped to the output's: the
    /// compositor measures fit and crop against a source's natural size, so a still that changed the
    /// shape would change the framing. Each side is rounded down to an even number for H.264, which
    /// stretches the picture by less than a pixel. The orientation is already in the pixels, so the
    /// track's `preferredTransform` stays identity, and there is no audio track: a picture is silent
    /// and `gain(of:)` is already 0 for it.
    ///
    /// Two samples of the same frame, at 0 and one frame before the end, then the session is ended
    /// at the full length, which is what gives the last sample its duration.
    private static func encode(_ image: CGImage, for key: String, lengthMs: Int64, to url: URL) async throws {
        let scale = min(1, (Double(maxArea) / Double(image.width * image.height)).squareRoot())
        let width = max(2, Int(Double(image.width) * scale) & ~1)
        let height = max(2, Int(Double(image.height) * scale) & ~1)
        let buffer = try pixelBuffer(image, width: width, height: height)

        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            // Tagged as the video composition converts every source to, so nothing converts it again
            // and the matrix that encodes the pixels is the one that decodes them.
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ])
        input.expectsMediaDataInRealTime = false
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
        guard writer.canAdd(input) else {
            throw BuildError.internalFailure("still for \(key): the writer refused a \(width)x\(height) H.264 track")
        }
        writer.add(input)
        guard writer.startWriting() else {
            throw writer.error ?? BuildError.internalFailure("still for \(key) would not start")
        }
        writer.startSession(atSourceTime: .zero)

        let length = ms(lengthMs) + frame
        do {
            for time in [CMTime.zero, length - frame] {
                // The sleep is what makes the wait cancellable: it throws the moment the render is.
                // A writer that has failed never becomes ready, so that ends the wait as well.
                while !input.isReadyForMoreMediaData {
                    if writer.status == .failed {
                        throw writer.error ?? BuildError.internalFailure("still for \(key) failed")
                    }
                    try await Task.sleep(nanoseconds: 1_000_000)
                }
                guard adaptor.append(buffer, withPresentationTime: time) else {
                    throw writer.error ?? BuildError.internalFailure("still for \(key): a frame was refused")
                }
            }
            try Task.checkCancellation()
        } catch {
            writer.cancelWriting()
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        input.markAsFinished()
        writer.endSession(atSourceTime: length)
        await writer.finishWriting()
        guard writer.status == .completed else {
            try? FileManager.default.removeItem(at: url)
            throw writer.error ?? BuildError.internalFailure("still for \(key) did not finish")
        }

        // Read back rather than trusted. The builder clamps the picture's range to this track, so a
        // still that came out short would quietly shorten the picture's time on screen and the post
        // with it. The margin is not part of what is checked: it is there to absorb the muxer
        // rounding the end to its own timescale.
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw BuildError.internalFailure("still for \(key) has no video track")
        }
        let range = try await track.load(.timeRange)
        guard range.start <= .zero, range.end >= ms(lengthMs) else {
            throw BuildError.internalFailure(
                "still for \(key) covers \(range.start.seconds)-\(range.end.seconds)s, needed \(lengthMs) ms")
        }
    }

    /// The picture drawn into a frame of its own size, on black.
    ///
    /// Black because H.264 has no alpha: a transparent PNG shows what it is drawn over, and black is
    /// what the compositor starts every frame on. sRGB because the context converts into it - a
    /// Display P3 photo from the camera lands in the space the preview and the compositor blend in,
    /// rather than having its numbers read as if they were sRGB already.
    private static func pixelBuffer(_ image: CGImage, width: Int, height: Int) throws -> CVPixelBuffer {
        var created: CVPixelBuffer?
        let status = CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                                         [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &created)
        guard status == kCVReturnSuccess, let buffer = created else {
            throw BuildError.internalFailure("could not allocate a \(width)x\(height) frame for a picture")
        }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let space = CGColorSpace(name: CGColorSpace.sRGB),
              let ctx = CGContext(data: CVPixelBufferGetBaseAddress(buffer),
                                  width: width,
                                  height: height,
                                  bitsPerComponent: 8,
                                  bytesPerRow: CVPixelBufferGetBytesPerRow(buffer),
                                  space: space,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue
                                      | CGBitmapInfo.byteOrder32Little.rawValue) else {
            throw BuildError.internalFailure("could not draw a \(width)x\(height) frame for a picture")
        }
        let whole = CGRect(x: 0, y: 0, width: width, height: height)
        ctx.setFillColor(CGColor(gray: 0, alpha: 1))
        ctx.fill(whole)
        ctx.interpolationQuality = .high
        ctx.draw(image, in: whole)
        return buffer
    }
}
