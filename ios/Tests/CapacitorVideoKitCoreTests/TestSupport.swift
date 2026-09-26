@preconcurrency import AVFoundation
import Capacitor
import CoreImage
import Foundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CapacitorVideoKitCore

/// What every test in this target shares: a `CAPPluginCall` built from a plain dictionary, media
/// written on the spot so no fixture has to be checked in, a render that runs the real builder and
/// exporter, and a way to read one pixel back off the result.
///
/// Everything is written under one temporary folder per test case, removed in `tearDown`.
class RenderTestCase: XCTestCase {
    private(set) var dir: URL!

    override func setUpWithError() throws {
        dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("vk-tests-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
    }

    override func tearDownWithError() throws {
        if let dir { try? FileManager.default.removeItem(at: dir) }
    }

    /// A file URL inside this test's folder.
    func file(_ name: String) -> URL { dir.appendingPathComponent(name) }
}

// MARK: - Calls and specs

enum TestCalls {
    /// A call whose options are `options`, as the bridge would hand one to a plugin method.
    ///
    /// Coerced through `JSTypes` first, because that is the shape the bridge's JSON arrives in:
    /// `CAPPluginCall.decode` casts `options` to `JSObject`, and a plain Swift dictionary holding
    /// `[[String: Any]]` arrays fails that cast and decodes as empty.
    static func call(_ options: [String: Any], method: String = "compose") -> CAPPluginCall {
        let coerced = JSTypes.coerceDictionaryToJSObject(options) ?? [:]
        return CAPPluginCall(callbackId: "test", methodName: method, options: coerced,
                             success: { _, _ in }, error: { _ in })!
    }

    /// Parses `options` the way `compose` does.
    static func parse(_ options: [String: Any]) throws -> ComposeSpec {
        try ComposeSpecParser.parse(call(options))
    }
}

enum TestSpecs {
    /// One clip as `toComposeSpec` writes it. Extra keys (image, crop, rect, transitionIn) are
    /// merged over the defaults.
    static func clip(_ key: String, _ url: URL, inMs: Int64 = 0, outMs: Int64,
                     fit: String = "cover", _ extra: [String: Any] = [:]) -> [String: Any] {
        var c: [String: Any] = ["key": key, "uri": url.absoluteString, "inMs": inMs, "outMs": outMs,
                                "speed": 1, "volume": 1, "muted": false, "fit": fit]
        for (k, v) in extra { c[k] = v }
        return c
    }

    /// A whole spec around `clips`, small and fast to render: 360x640 at 30 fps unless told
    /// otherwise.
    static func spec(_ clips: [[String: Any]], width: Int = 360, height: Int = 640, fps: Int = 30,
                     batchId: String = "batch-\(UUID().uuidString)",
                     _ extra: [String: Any] = [:]) -> [String: Any] {
        var s: [String: Any] = [
            "jobId": "job-\(UUID().uuidString)",
            "batchId": batchId,
            "clips": clips,
            "output": ["width": width, "height": height, "fps": fps,
                       "videoBitrate": 2_000_000, "audioBitrate": 128_000],
            "filter": [Any](),
            "overlays": [Any](),
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any]()],
            "posterAtMs": 0,
        ]
        for (k, v) in extra { s[k] = v }
        return s
    }
}

// MARK: - Media

enum TestMedia {
    struct RGB: Equatable, CustomStringConvertible {
        let r: Int, g: Int, b: Int
        var description: String { "rgb(\(r),\(g),\(b))" }
        /// Within `tolerance` on every channel, which is what survives H.264 and a colour matrix.
        func near(_ other: RGB, tolerance: Int = 40) -> Bool {
            abs(r - other.r) <= tolerance && abs(g - other.g) <= tolerance && abs(b - other.b) <= tolerance
        }
        static let red = RGB(r: 255, g: 0, b: 0)
        static let green = RGB(r: 0, g: 255, b: 0)
        static let blue = RGB(r: 0, g: 0, b: 255)
        static let white = RGB(r: 255, g: 255, b: 255)
        static let black = RGB(r: 0, g: 0, b: 0)
    }

    /// A solid-colour H.264 video of `durationMs`, with a 440 Hz AAC tone when `audio` is true.
    ///
    /// The picture and the tone are fed by readiness, a frame's worth of each at a time, whichever
    /// will take more, and both inputs are marked real time with frame reordering off: the same
    /// feeding `noise(_:)` does, and for its reason. Written one after the other - every frame, then
    /// all of the tone - the writer holds the picture back waiting for sound that has not come yet,
    /// and past a second or two on the simulator's software encoder both inputs refuse for good and
    /// the test hangs.
    ///
    /// `compression` is merged over the encoder's properties, for a test that needs two files whose
    /// pictures are the same size but whose streams were encoded differently.
    static func video(_ url: URL, durationMs: Int64, width: Int = 320, height: Int = 240,
                      color: RGB, fps: Int32 = 30, audio: Bool = true,
                      compression: [String: Any] = [:]) async throws -> URL {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        var properties: [String: Any] = [AVVideoAllowFrameReorderingKey: false]
        for (k, v) in compression { properties[k] = v }
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: properties,
        ])
        vIn.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: vIn, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(vIn)

        let rate = 44_100
        var aIn: AVAssetWriterInput?
        if audio {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: rate,
                AVNumberOfChannelsKey: 1,
                AVEncoderBitRateKey: 64_000,
            ])
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            aIn = input
        }

        guard writer.startWriting() else { throw writer.error ?? TestError("startWriting") }
        writer.startSession(atSourceTime: .zero)

        let frames = max(1, Int(Int64(fps) * durationMs / 1000))
        let buffer = try pixelBuffer(width: width, height: height, color: color)
        let samples = aIn == nil ? 0 : rate * Int(durationMs) / 1000
        let samplesPerFrame = rate / Int(fps)
        var framesDone = 0
        var samplesDone = 0
        while framesDone < frames || samplesDone < samples {
            var moved = false
            if framesDone < frames, vIn.isReadyForMoreMediaData {
                let at = CMTime(value: CMTimeValue(framesDone), timescale: fps)
                guard adaptor.append(buffer, withPresentationTime: at) else {
                    throw writer.error ?? TestError("append video")
                }
                framesDone += 1
                moved = true
            }
            if let aIn, samplesDone < samples, aIn.isReadyForMoreMediaData {
                let count = min(samplesPerFrame, samples - samplesDone)
                guard aIn.append(try toneBuffer(start: samplesDone, count: count, rate: rate)) else {
                    throw writer.error ?? TestError("append audio")
                }
                samplesDone += count
                moved = true
            }
            if !moved {
                // A writer that has failed never makes an input ready again, so waiting on one
                // without asking would wait forever.
                if writer.status == .failed { throw writer.error ?? TestError("writer failed") }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        }
        vIn.markAsFinished()
        aIn?.markAsFinished()

        writer.endSession(atSourceTime: ms(durationMs))
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? TestError("finishWriting") }
        return url
    }

    /// A picture file. The stored pixels are `width` x `height`, `left` on the left third, `right`
    /// on the right third and `middle` between them, and `orientation` (an EXIF value, 1...8) is
    /// written into it when given. With orientation 6 an upright engine shows it turned a quarter
    /// clockwise: portrait, `left` at the TOP.
    ///
    /// Filled with exactly the colours it is given (`srgb`), because a test that checks a picture
    /// reaches the frame unchanged has to know what the picture holds.
    static func picture(_ url: URL, type: UTType = .jpeg, width: Int = 600, height: Int = 400,
                        left: RGB = .red, middle: RGB = .blue, right: RGB = .green,
                        orientation: Int? = nil) throws -> URL {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw TestError("context")
        }
        func fill(_ c: RGB, _ rect: CGRect) {
            ctx.setFillColor(srgb(c))
            ctx.fill(rect)
        }
        let third = CGFloat(width) / 3
        fill(middle, CGRect(x: 0, y: 0, width: width, height: height))
        fill(left, CGRect(x: 0, y: 0, width: third, height: CGFloat(height)))
        fill(right, CGRect(x: CGFloat(width) - third, y: 0, width: third, height: CGFloat(height)))
        guard let image = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil) else {
            throw TestError("destination")
        }
        var props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: 0.95]
        if let orientation {
            props[kCGImagePropertyOrientation] = orientation
            props[kCGImagePropertyTIFFDictionary] = [kCGImagePropertyTIFFOrientation: orientation]
        }
        CGImageDestinationAddImage(dest, image, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { throw TestError("finalize") }
        return url
    }

    /// `c` as an sRGB colour, never a Generic RGB one. `CGColor(red:green:blue:alpha:)` is Generic
    /// RGB, which an sRGB context converts: its red is stored as rgb(255, 38, 0), and its blue
    /// carries green as well.
    static func srgb(_ c: RGB) -> CGColor {
        CGColor(colorSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                components: [CGFloat(c.r) / 255, CGFloat(c.g) / 255, CGFloat(c.b) / 255, 1])!
    }

    /// The colour of the frame at `seconds`, averaged over a small square around (`x`, `y`), both
    /// fractions of the DISPLAY frame with a top-left origin.
    static func color(of url: URL, at seconds: Double, x: Double = 0.5, y: Double = 0.5) async throws -> RGB {
        let asset = AVURLAsset(url: url)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.requestedTimeToleranceBefore = .zero
        generator.requestedTimeToleranceAfter = .zero
        let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
        let w = image.width, h = image.height
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw TestError("context")
        }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        let cx = Int(Double(w) * x), cy = Int(Double(h) * y)
        var r = 0, g = 0, b = 0, n = 0
        for py in max(0, cy - 2)...min(h - 1, cy + 2) {
            for px in max(0, cx - 2)...min(w - 1, cx + 2) {
                let i = (py * w + px) * 4
                r += Int(pixels[i]); g += Int(pixels[i + 1]); b += Int(pixels[i + 2]); n += 1
            }
        }
        return RGB(r: r / n, g: g / n, b: b / n)
    }

    /// Duration in ms and whether there is an audio track, read back off a finished file.
    static func probe(_ url: URL) async throws -> (durationMs: Int64, hasAudio: Bool, width: Int, height: Int) {
        let asset = AVURLAsset(url: url)
        let duration = try await asset.load(.duration)
        let audio = try await asset.loadTracks(withMediaType: .audio)
        let video = try await asset.loadTracks(withMediaType: .video).first
        var size = CGSize.zero
        if let video {
            let (natural, transform) = try await video.load(.naturalSize, .preferredTransform)
            size = natural.applying(transform)
        }
        return (msOf(duration), !audio.isEmpty, Int(abs(size.width)), Int(abs(size.height)))
    }

    private static func pixelBuffer(width: Int, height: Int, color: RGB) throws -> CVPixelBuffer {
        var out: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &out)
        guard let buffer = out else { throw TestError("pixel buffer") }
        CVPixelBufferLockBaseAddress(buffer, [])
        let base = CVPixelBufferGetBaseAddress(buffer)!.assumingMemoryBound(to: UInt8.self)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        for y in 0..<height {
            for x in 0..<width {
                let p = base + y * stride + x * 4
                p[0] = UInt8(color.b); p[1] = UInt8(color.g); p[2] = UInt8(color.r); p[3] = 255
            }
        }
        CVPixelBufferUnlockBaseAddress(buffer, [])
        return buffer
    }

    private static func toneBuffer(start: Int, count: Int, rate: Int) throws -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(mSampleRate: Float64(rate), mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                               mBytesPerPacket: 2, mFramesPerPacket: 1, mBytesPerFrame: 2,
                                               mChannelsPerFrame: 1, mBitsPerChannel: 16, mReserved: 0)
        var format: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                       magicCookieSize: 0, magicCookie: nil, extensions: nil,
                                       formatDescriptionOut: &format)
        var samples = [Int16](repeating: 0, count: count)
        for i in 0..<count {
            samples[i] = Int16(sin(2 * Double.pi * 440 * Double(start + i) / Double(rate)) * 8000)
        }
        var block: CMBlockBuffer?
        let bytes = count * 2
        CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes,
                                           blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
                                           offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
        guard let block else { throw TestError("block") }
        _ = samples.withUnsafeBytes { raw in
            CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0,
                                          dataLength: bytes)
        }
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format!,
            sampleCount: count, presentationTimeStamp: CMTime(value: CMTimeValue(start), timescale: CMTimeScale(rate)),
            packetDescriptions: nil, sampleBufferOut: &sample)
        guard let sample else { throw TestError("sample") }
        return sample
    }
}

// MARK: - Rendering

enum TestRender {
    /// Parses `options`, builds the composition and exports it with the module's own engine, and
    /// answers the finished file. The job folder is removed afterwards unless `keepJob` is set.
    @discardableResult
    static func render(_ options: [String: Any], to out: URL, keepJob: Bool = false) async throws -> (url: URL, result: ComposeResult) {
        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { if !keepJob { JobFolders.cleanup(batchId: spec.batchId) } }
        let built = try await CompositionBuilder.build(spec)
        try? FileManager.default.removeItem(at: out)
        let result = try await Exporter.export(built, to: out, tmpDir: JobFolders.exportTmp(spec.batchId),
                                               spec: spec, shouldStop: { false }, onProgress: { _ in })
        return (out, result)
    }
}

struct TestError: Error, CustomStringConvertible {
    let description: String
    init(_ description: String) { self.description = description }
}

// MARK: - Frame by frame

extension TestMedia {
    /// An H.264 video, no sound, whose frame `i` is `picture(i)` - tightly packed RGBA8, `width` x
    /// `height`, rows top first - presented at `times[i]`. For the tests that need to know which
    /// source frame a composed frame was drawn from, or to put a frame at an irregular time.
    ///
    /// `reorder` turns B-frames on (`AVVideoAllowFrameReorderingKey`), which makes the file decode in
    /// a different order from the one it presents in and gives it the edit list every phone and
    /// every ffmpeg recording with B-frames has - the two things a slowed clip's own frame list must
    /// see through. `bitrate` is generous by default, so the pictures survive nearly intact.
    /// `transform` is written as the track's `preferredTransform`, as a phone held upright writes one.
    /// `sessionStart` is where the file's timeline starts, the first frame's time when nil; one earlier
    /// than the first frame writes the file a phone or ffmpeg writes when its video starts after its
    /// sound - an EMPTY edit from `sessionStart` to the first frame, then the media (measured).
    static func frames(_ url: URL, width: Int, height: Int, times: [CMTime], reorder: Bool = false,
                       bitrate: Int = 8_000_000, transform: CGAffineTransform = .identity,
                       sessionStart: CMTime? = nil,
                       picture: (Int) -> [UInt8]) async throws -> URL {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        var properties: [String: Any] = [AVVideoAllowFrameReorderingKey: reorder,
                                         AVVideoAverageBitRateKey: bitrate]
        if reorder { properties[AVVideoProfileLevelKey] = AVVideoProfileLevelH264HighAutoLevel }
        let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: properties,
        ])
        input.expectsMediaDataInRealTime = false
        input.transform = transform
        // The track keeps the times' own timescale. Left to the writer, it picks one of its own (600 here),
        // and a frame written at 1.379 s lands at 1.378333 s - which would make every irregular time a test
        // writes a different time in the file.
        if let scale = times.first?.timescale { input.mediaTimeScale = scale }
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? TestError("startWriting") }
        writer.startSession(atSourceTime: sessionStart ?? times.first ?? .zero)
        for (i, time) in times.enumerated() {
            while !input.isReadyForMoreMediaData {
                if writer.status == .failed { throw writer.error ?? TestError("writer failed") }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
            guard let buffer = TestPixels.buffer(rgba: picture(i), width: width, height: height) else {
                throw TestError("pixel buffer")
            }
            guard adaptor.append(buffer, withPresentationTime: time) else {
                throw writer.error ?? TestError("append frame \(i)")
            }
        }
        input.markAsFinished()
        // The last frame lasts as long as the one before it.
        if let last = times.last {
            let step = times.count > 1 ? last - times[times.count - 2] : CMTime(value: 1, timescale: 30)
            writer.endSession(atSourceTime: last + step)
        }
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? TestError("finishWriting") }
        return url
    }

    /// `count` frame times `1/fps` apart from zero, exact in a 600 timescale.
    static func evenTimes(_ count: Int, fps: Int32 = 30) -> [CMTime] {
        (0..<count).map { CMTime(value: CMTimeValue($0) * 600 / CMTimeValue(fps), timescale: 600) }
    }

    /// A picture that says which frame it is, twice over: the TOP half is eight vertical stripes, stripe
    /// `k` white when bit `k` of `index` is set and black when it is not (`indexOf` reads it back), and
    /// the BOTTOM half is one flat grey, `grey(index)`, that differs between any two neighbouring
    /// frames - so every pixel of a frame between two others is a mix of different values, and the
    /// grey measures how far between them it is.
    static func indexPicture(_ index: Int, width: Int, height: Int) -> [UInt8] {
        var rgba = [UInt8](repeating: 255, count: width * height * 4)
        let g = UInt8(grey(index))
        for y in 0..<height {
            for x in 0..<width {
                let v: UInt8 = y < height / 2 ? ((index >> (x * 8 / width)) & 1 == 1 ? 255 : 0) : g
                let i = (y * width + x) * 4
                rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v
            }
        }
        return rgba
    }

    /// The bottom half's grey of frame `index`: 22 code values from its neighbours, 30 to 206.
    static func grey(_ index: Int) -> Int { 30 + (index % 9) * 22 }

    /// The frame index an `indexPicture` carries, read off tightly packed BGRA at the middle of each
    /// stripe on the top half's middle row.
    static func indexOf(_ bgra: [UInt8], width: Int, height: Int) -> Int {
        var n = 0
        let y = height / 4
        for k in 0..<8 where bgra[(y * width + (2 * k + 1) * width / 16) * 4 + 1] > 128 { n |= 1 << k }
        return n
    }
}

/// One frame the compositor drew: its time, and its pixels as tightly packed BGRA.
struct ComposedFrame: Equatable {
    let seconds: Double
    let width: Int
    let height: Int
    let bgra: [UInt8]

    /// The mean of one channel over a rectangle of the frame, in rows from the top.
    func mean(x: Int, y: Int, w: Int, h: Int, channel: Int = 1) -> Double {
        var sum = 0
        for yy in y..<(y + h) {
            for xx in x..<(x + w) { sum += Int(bgra[(yy * width + xx) * 4 + channel]) }
        }
        return Double(sum) / Double(w * h)
    }

    /// The largest difference of any colour channel of any pixel.
    func largestDifference(_ other: ComposedFrame) -> Int {
        var most = 0
        for i in 0..<bgra.count where i % 4 != 3 { most = max(most, abs(Int(bgra[i]) - Int(other.bgra[i]))) }
        return most
    }
}

enum TestComposed {
    /// Every frame the COMPOSITOR draws for `built`, read the way `WriterEngine` reads a render - the
    /// same reader range, an `AVAssetReaderVideoCompositionOutput` over every video track, the same
    /// `frameSettings` and video composition - so these are the frames an encoder would be handed, and
    /// nothing an encoder does to them can make two renders look alike or apart.
    static func frames(_ built: BuiltComposition) throws -> [ComposedFrame] {
        let reader = try AVAssetReader(asset: built.composition)
        reader.timeRange = CMTimeRange(start: .zero, duration: ms(built.totalMs))
        let output = AVAssetReaderVideoCompositionOutput(videoTracks: built.composition.tracks(withMediaType: .video),
                                                         videoSettings: WriterEngine.frameSettings)
        output.videoComposition = built.videoComposition
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw TestError("the reader refused the composed video output") }
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TestError("startReading") }
        var frames: [ComposedFrame] = []
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            frames.append(ComposedFrame(seconds: CMSampleBufferGetPresentationTimeStamp(sample).seconds,
                                        width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer),
                                        bgra: bgra(buffer)))
        }
        if reader.status != .completed { throw reader.error ?? TestError("the reader stopped at \(reader.status.rawValue)") }
        return frames
    }

    /// A 32BGRA buffer's pixels, tightly packed: row padding is not picture.
    static func bgra(_ buffer: CVPixelBuffer) -> [UInt8] {
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        let stride = CVPixelBufferGetBytesPerRow(buffer)
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
        var out = [UInt8](repeating: 0, count: width * height * 4)
        out.withUnsafeMutableBytes { dst in
            for y in 0..<height { memcpy(dst.baseAddress! + y * width * 4, base + y * stride, width * 4) }
        }
        return out
    }
}
