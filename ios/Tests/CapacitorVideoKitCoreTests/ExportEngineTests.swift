@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// The writer engine against what Android asks of its encoder: VBR at `output.videoBitrate`, a key
/// frame every second, High profile, AAC at `output.audioBitrate` - and no audio track at all when no
/// source has sound.
///
/// Every source here is NOISE, fresh random pixels on every frame. A solid colour compresses to a
/// few kilobytes whatever rate the encoder is given, so it can say nothing about whether the rate was
/// set; noise is the one picture that spends whatever it is allowed.
final class ExportEngineTests: RenderTestCase {

    func testVideoBitrateFollowsTheSpec() async throws {
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 3000)
        let low = try await render(source, durationMs: 3000, videoBitrate: 600_000, to: file("low.mp4"))
        let high = try await render(source, durationMs: 3000, videoBitrate: 4_000_000, to: file("high.mp4"))

        let lowRate = try await TestTracks.dataRate(of: low, .video)
        let highRate = try await TestTracks.dataRate(of: high, .video)
        // A third either way. A variable rate is allowed to miss on a three second clip, and the
        // preset engine this replaced landed nowhere near either number: it picked its own.
        XCTAssertEqual(lowRate, 600_000, accuracy: 200_000, "delivered \(lowRate) bps against 600000")
        XCTAssertEqual(highRate, 4_000_000, accuracy: 1_333_333, "delivered \(highRate) bps against 4000000")

        let lowBytes = Thumbnailer.fileBytes(low)
        let highBytes = Thumbnailer.fileBytes(high)
        XCTAssertGreaterThan(Double(highBytes), Double(lowBytes) * 3,
                             "\(highBytes) bytes at 4 Mbps against \(lowBytes) at 0.6 Mbps")
    }

    func testKeyFramesAreAtMostOneSecondApart() async throws {
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 4000)
        let out = try await render(source, durationMs: 4000, videoBitrate: 2_000_000, to: file("out.mp4"))

        let (sync, frames) = try await TestTracks.frameTimes(of: out)
        XCTAssertEqual(frames.count, 120)
        XCTAssertEqual(sync.first ?? -1, 0, accuracy: 0.001, "the first frame has to be a key frame")
        // Four seconds at one a second is at least four, and the last gap - to the end of the last
        // frame - is held to the same second as the rest.
        XCTAssertGreaterThanOrEqual(sync.count, 4, "key frames at \(sync)")
        let edges = sync + [(frames.last ?? 0) + 1.0 / 30]
        for (a, b) in zip(edges, edges.dropFirst()) {
            // One frame of slack: the interval is a maximum the encoder meets on a frame boundary.
            XCTAssertLessThanOrEqual(b - a, 1.0 + 1.0 / 30 + 0.001, "key frames at \(sync)")
        }
    }

    func testVideoIsHighProfileTaggedBT709() async throws {
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 1000)
        let out = try await render(source, durationMs: 1000, videoBitrate: 2_000_000, to: file("out.mp4"))

        let format = try await TestTracks.format(of: out, .video)
        let atoms = CMFormatDescriptionGetExtension(
            format, extensionKey: kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms) as? [String: Any]
        let avcC = try XCTUnwrap(atoms?["avcC"] as? Data, "no avcC atom")
        // AVCDecoderConfigurationRecord: version, then AVCProfileIndication. 100 is High.
        XCTAssertEqual(avcC[avcC.startIndex + 1], 100)

        let primaries = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_ColorPrimaries)
        XCTAssertEqual(primaries as? String, kCMFormatDescriptionColorPrimaries_ITU_R_709_2 as String)
        let matrix = CMFormatDescriptionGetExtension(format, extensionKey: kCMFormatDescriptionExtension_YCbCrMatrix)
        XCTAssertEqual(matrix as? String, kCMFormatDescriptionYCbCrMatrix_ITU_R_709_2 as String)
    }

    func testSoundIsStereoAACAtTheRequestedRate() async throws {
        // Two rates either side of the 128 kbps the encoder writes when it is given none, so that a
        // spec whose rate never reached the writer cannot pass as one that did.
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 3000, audio: true)
        let low = try await render(source, durationMs: 3000, videoBitrate: 1_000_000, audioBitrate: 64_000,
                                   to: file("low.mp4"))
        let high = try await render(source, durationMs: 3000, videoBitrate: 1_000_000, audioBitrate: 256_000,
                                    to: file("high.mp4"))

        let lowRate = try await TestTracks.dataRate(of: low, .audio)
        let highRate = try await TestTracks.dataRate(of: high, .audio)
        XCTAssertEqual(lowRate, 64_000, accuracy: 64_000 * 0.2, "delivered \(lowRate) bps against 64000")
        XCTAssertEqual(highRate, 256_000, accuracy: 256_000 * 0.2, "delivered \(highRate) bps against 256000")

        let format = try await TestTracks.format(of: high, .audio)
        let asbd = try XCTUnwrap(CMAudioFormatDescriptionGetStreamBasicDescription(format)?.pointee)
        XCTAssertEqual(asbd.mFormatID, kAudioFormatMPEG4AAC)
        XCTAssertEqual(asbd.mChannelsPerFrame, 2)
        XCTAssertEqual(asbd.mSampleRate, 48_000)
    }

    func testSilentSourcesMakeAFileWithNoAudioTrack() async throws {
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 1000, audio: false)
        let out = try await render(source, durationMs: 1000, videoBitrate: 1_000_000, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertFalse(probed.hasAudio)
        XCTAssertEqual(Double(probed.durationMs), 1000, accuracy: 70)
    }

    func testTheEncoderIsAskedForWhatAndroidAsksFor() throws {
        // Checked on the settings themselves as well as on the files above, because the files alone
        // cannot tell: an AVAssetWriter given nothing but a codec, a size and a rate already writes
        // High profile with a key frame every second on this simulator, measured.
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", file("a.mp4"), outMs: 1000)], [
            "output": ["width": 1080, "height": 1920, "fps": 60, "videoBitrate": 12_000_000, "audioBitrate": 192_000],
        ]))

        let video = WriterEngine.videoSettings(spec, renderSize: CGSize(width: 1080, height: 1920))
        XCTAssertEqual(video[AVVideoCodecKey] as? AVVideoCodecType, .h264)
        XCTAssertEqual(video[AVVideoWidthKey] as? Int, 1080)
        XCTAssertEqual(video[AVVideoHeightKey] as? Int, 1920)
        let compression = try XCTUnwrap(video[AVVideoCompressionPropertiesKey] as? [String: Any])
        XCTAssertEqual((compression[AVVideoAverageBitRateKey] as? NSNumber)?.intValue, 12_000_000)
        XCTAssertEqual((compression[AVVideoMaxKeyFrameIntervalDurationKey] as? NSNumber)?.doubleValue, 1)
        XCTAssertEqual((compression[AVVideoExpectedSourceFrameRateKey] as? NSNumber)?.intValue, 60)
        XCTAssertEqual(compression[AVVideoProfileLevelKey] as? String, AVVideoProfileLevelH264HighAutoLevel)
        let colour = try XCTUnwrap(video[AVVideoColorPropertiesKey] as? [String: String])
        XCTAssertEqual(colour[AVVideoColorPrimariesKey], AVVideoColorPrimaries_ITU_R_709_2)
        XCTAssertEqual(colour[AVVideoTransferFunctionKey], AVVideoTransferFunction_ITU_R_709_2)
        XCTAssertEqual(colour[AVVideoYCbCrMatrixKey], AVVideoYCbCrMatrix_ITU_R_709_2)

        let audio = WriterEngine.audioSettings(bitrate: spec.output.audioBitrate)
        XCTAssertEqual(audio[AVFormatIDKey] as? AudioFormatID, kAudioFormatMPEG4AAC)
        XCTAssertEqual(audio[AVEncoderBitRateKey] as? Int, 192_000)
        XCTAssertEqual(audio[AVSampleRateKey] as? Int, 48_000)
        XCTAssertEqual(audio[AVNumberOfChannelsKey] as? Int, 2)
    }

    func testAACRateMovesOntoOneTheEncoderTakes() {
        // The requested rate when the encoder takes it, the nearest one it does take otherwise. The
        // outside two are the rates measured to fail the first append with -11861 when passed as
        // they are.
        XCTAssertEqual(WriterEngine.aacBitrate(near: 128_000), 128_000)
        XCTAssertEqual(WriterEngine.aacBitrate(near: 100_000), 96_000)
        XCTAssertEqual(WriterEngine.aacBitrate(near: 32_000), 64_000)
        XCTAssertEqual(WriterEngine.aacBitrate(near: 500_000), 320_000)
    }

    /// One clip of `source`, rendered at the spec's default 360x640 with the rates given.
    private func render(_ source: URL, durationMs: Int64, videoBitrate: Int, audioBitrate: Int = 128_000,
                        to out: URL) async throws -> URL {
        let options = TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: durationMs)], [
            "output": ["width": 360, "height": 640, "fps": 30,
                       "videoBitrate": videoBitrate, "audioBitrate": audioBitrate],
        ])
        return try await TestRender.render(options, to: out).url
    }
}

// MARK: - Media and read-back for the export tests

extension TestMedia {
    /// An H.264 video of fresh random pixels on every frame, and, when `audio` is set, stereo white
    /// noise beside it.
    ///
    /// Noise of a SIXTEENTH of full scale around mid grey, and that is measured rather than taste:
    /// full-scale noise at 360x640 costs the encoder 6.8 Mbps at its coarsest quantiser, so every
    /// target below that comes back at the same size and says nothing. Around a sixteenth it still
    /// spends whatever it is given, and lands within ten percent of 0.6, 2 and 4 Mbps.
    ///
    /// The two inputs are fed by readiness, whichever will take more, and both are marked real
    /// time with frame reordering off. A writer fed from a loop like this one holds back whichever
    /// input runs ahead of the other while the video encoder keeps frames in flight, and on the
    /// simulator's software encoder that has been seen to leave BOTH inputs refusing for good. Real
    /// time is the mode in which an input refuses only when the encoder is genuinely behind, and
    /// `video(_:)` feeds its picture and tone the same way.
    ///
    /// The source's own rate is set high so the noise survives it: what the tests measure is how the
    /// render re-encodes a picture that will spend any budget, not the source's quantisation.
    static func noise(_ url: URL, durationMs: Int64, width: Int = 360, height: Int = 640,
                      fps: Int32 = 30, audio: Bool = false) async throws -> URL {
        try? FileManager.default.removeItem(at: url)
        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        let video = AVAssetWriterInput(mediaType: .video, outputSettings: [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: width,
            AVVideoHeightKey: height,
            AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 20_000_000,
                                              AVVideoAllowFrameReorderingKey: false],
        ])
        video.expectsMediaDataInRealTime = true
        let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: video, sourcePixelBufferAttributes: [
            kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
            kCVPixelBufferWidthKey as String: width,
            kCVPixelBufferHeightKey as String: height,
        ])
        writer.add(video)

        let sampleRate = 48_000
        var sound: AVAssetWriterInput?
        if audio {
            let input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: sampleRate,
                AVNumberOfChannelsKey: 2,
                AVEncoderBitRateKey: 256_000,
            ])
            input.expectsMediaDataInRealTime = true
            writer.add(input)
            sound = input
        }

        guard writer.startWriting() else { throw writer.error ?? TestError("startWriting") }
        writer.startSession(atSourceTime: .zero)

        var random = SplitMix64(seed: 0x5EED)
        let frames = max(1, Int(Int64(fps) * durationMs / 1000))
        let samplesPerFrame = sampleRate / Int(fps)
        var videoDone = 0
        var soundDone = sound == nil ? frames : 0
        while videoDone < frames || soundDone < frames {
            var moved = false
            if videoDone < frames, video.isReadyForMoreMediaData {
                guard let pool = adaptor.pixelBufferPool else { throw TestError("no pixel buffer pool") }
                var out: CVPixelBuffer?
                CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &out)
                guard let buffer = out else { throw TestError("pixel buffer") }
                fillWithNoise(buffer, &random)
                let at = CMTime(value: CMTimeValue(videoDone), timescale: fps)
                guard adaptor.append(buffer, withPresentationTime: at) else {
                    throw writer.error ?? TestError("append video")
                }
                videoDone += 1
                moved = true
            }
            if let sound, soundDone < frames, sound.isReadyForMoreMediaData {
                let sample = try noiseSound(start: soundDone * samplesPerFrame, count: samplesPerFrame,
                                            rate: sampleRate, &random)
                guard sound.append(sample) else { throw writer.error ?? TestError("append audio") }
                soundDone += 1
                moved = true
            }
            if !moved {
                // A writer that has failed never makes an input ready again, so waiting on one
                // without asking would wait forever.
                if writer.status == .failed { throw writer.error ?? TestError("writer failed") }
                try await Task.sleep(nanoseconds: 1_000_000)
            }
        }
        video.markAsFinished()
        sound?.markAsFinished()
        writer.endSession(atSourceTime: ms(durationMs))
        await writer.finishWriting()
        if writer.status != .completed { throw writer.error ?? TestError("finishWriting") }
        return url
    }

    /// Every byte 112...143, a word at a time: the low five bits of each random byte over a base of
    /// 112, which cannot carry into the next byte. The alpha byte gets the same and the encoder
    /// ignores it.
    private static func fillWithNoise(_ buffer: CVPixelBuffer, _ random: inout SplitMix64) {
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return }
        let words = CVPixelBufferGetBytesPerRow(buffer) * CVPixelBufferGetHeight(buffer) / 8
        let p = base.bindMemory(to: UInt64.self, capacity: words)
        for i in 0..<words { p[i] = (random.next() & 0x1F1F_1F1F_1F1F_1F1F) + 0x7070_7070_7070_7070 }
    }

    private static func noiseSound(start: Int, count: Int, rate: Int,
                                   _ random: inout SplitMix64) throws -> CMSampleBuffer {
        var asbd = AudioStreamBasicDescription(mSampleRate: Float64(rate), mFormatID: kAudioFormatLinearPCM,
                                               mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
                                               mBytesPerPacket: 4, mFramesPerPacket: 1, mBytesPerFrame: 4,
                                               mChannelsPerFrame: 2, mBitsPerChannel: 16, mReserved: 0)
        var format: CMAudioFormatDescription?
        CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: &asbd, layoutSize: 0, layout: nil,
                                       magicCookieSize: 0, magicCookie: nil, extensions: nil,
                                       formatDescriptionOut: &format)
        // A quarter of full scale, so the mix has room and nothing clips.
        var samples = [Int16](repeating: 0, count: count * 2)
        for i in samples.indices { samples[i] = Int16(truncatingIfNeeded: random.next()) / 4 }
        let bytes = samples.count * 2
        var block: CMBlockBuffer?
        CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil, blockLength: bytes,
                                           blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
                                           offsetToData: 0, dataLength: bytes, flags: 0, blockBufferOut: &block)
        guard let block, let format else { throw TestError("audio block") }
        _ = samples.withUnsafeBytes { raw in
            CMBlockBufferReplaceDataBytes(with: raw.baseAddress!, blockBuffer: block, offsetIntoDestination: 0,
                                          dataLength: bytes)
        }
        var sample: CMSampleBuffer?
        CMAudioSampleBufferCreateReadyWithPacketDescriptions(
            allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: format,
            sampleCount: count, presentationTimeStamp: CMTime(value: CMTimeValue(start), timescale: CMTimeScale(rate)),
            packetDescriptions: nil, sampleBufferOut: &sample)
        guard let sample else { throw TestError("audio sample") }
        return sample
    }
}

/// Steele, Lea and Flood's SplitMix64: fast enough to fill a frame of noise a word at a time, and
/// seeded, so a failure reproduces.
struct SplitMix64 {
    private var state: UInt64

    init(seed: UInt64) { state = seed }

    mutating func next() -> UInt64 {
        state &+= 0x9E37_79B9_7F4A_7C15
        var z = state
        z = (z ^ (z >> 30)) &* 0xBF58_476D_1CE4_E5B9
        z = (z ^ (z >> 27)) &* 0x94D0_49BB_1331_11EB
        return z ^ (z >> 31)
    }
}

enum TestTracks {
    /// Bits per second of one kind of media in a finished file: every sample's bytes over the
    /// track's length, which is exactly what the encoder spent and nothing the container added.
    static func dataRate(of url: URL, _ type: AVMediaType) async throws -> Double {
        // Held here and not only inside `firstTrack`: `AVAssetTrack.asset` is weak, and a track
        // whose asset has gone answers nothing.
        let asset = AVURLAsset(url: url)
        let track = try await firstTrack(type, in: asset)
        let (bytes, range) = try await track.load(.totalSampleDataLength, .timeRange)
        return Double(bytes) * 8 / range.duration.seconds
    }

    static func format(of url: URL, _ type: AVMediaType) async throws -> CMFormatDescription {
        let asset = AVURLAsset(url: url)
        let track = try await firstTrack(type, in: asset)
        guard let format = try await track.load(.formatDescriptions).first else { throw TestError("no format") }
        return format
    }

    /// The presentation times of the key frames and of every frame, in seconds, in order, and
    /// measured from the first frame shown: with frame reordering on, the track's own times start a
    /// frame or so in, where the edit list puts them. Read off the compressed samples themselves, in
    /// which a sample is a key frame unless it carries `NotSync`.
    static func frameTimes(of url: URL) async throws -> (sync: [Double], frames: [Double]) {
        let asset = AVURLAsset(url: url)
        let track = try await firstTrack(.video, in: asset)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TestError("startReading") }
        var sync: [Double] = []
        var frames: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let at = CMSampleBufferGetPresentationTimeStamp(sample).seconds
            frames.append(at)
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false)
                as? [[CFString: Any]]
            let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
            if !notSync { sync.append(at) }
        }
        if reader.status == .failed { throw reader.error ?? TestError("reading") }
        let origin = frames.min() ?? 0
        return (sync.map { $0 - origin }.sorted(), frames.map { $0 - origin }.sorted())
    }

    private static func firstTrack(_ type: AVMediaType, in asset: AVURLAsset) async throws -> AVAssetTrack {
        guard let track = try await asset.loadTracks(withMediaType: type).first else {
            throw TestError("no \(type.rawValue) track")
        }
        return track
    }
}
