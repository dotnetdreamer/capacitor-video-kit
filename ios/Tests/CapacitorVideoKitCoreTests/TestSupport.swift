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
    static func video(_ url: URL, durationMs: Int64, width: Int = 320, height: Int = 240,
                      color: RGB, fps: Int32 = 30, audio: Bool = true) async throws -> URL {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let vIn = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAllowFrameReorderingKey: false],
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
