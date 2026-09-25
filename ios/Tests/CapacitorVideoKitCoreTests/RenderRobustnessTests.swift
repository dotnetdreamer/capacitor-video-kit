@preconcurrency import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CapacitorVideoKitCore

/// Specs the other engines render and this one used to refuse or render wrongly: inputs named so that
/// AVFoundation will not open them, music trimmed past its file, music fades on a loop, a clip whose
/// in-point is past its footage, a clip's sound fading out toward a silent neighbour, the parser's
/// track defaults, and an overlay's opacity.
final class RenderRobustnessTests: RenderTestCase {

    // MARK: - Parser parity with Android

    func testATrackWithNoZSitsAboveEveryTrackListedBeforeIt() throws {
        let url = file("a.mp4")
        let clip = TestSpecs.clip("l", url, outMs: 500)
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("b", url, outMs: 1000)], [
            "tracks": [
                ["id": "first", "clips": [clip]],
                ["id": "second", "clips": [clip], "z": 5],
                ["id": "third", "clips": [clip]],
                ["id": "fourth", "clips": [clip], "z": -3],
            ],
        ]))
        // Android's `optInt("z", i + 1)`, and a z that is there is kept or clamped as before.
        XCTAssertEqual(spec.tracks?.map(\.z), [1, 5, 3, 0])
    }

    func testAnEmptyTrackIsRefusedInAndroidsWords() throws {
        let url = file("a.mp4")
        let base = [TestSpecs.clip("b", url, outMs: 1000)]
        let layer = ["id": "ok", "clips": [TestSpecs.clip("l", url, outMs: 500)]] as [String: Any]

        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec(base, [
            "tracks": [layer, ["id": "pip", "clips": [Any]()]],
        ]))) { error in
            let spec = error as? SpecError
            XCTAssertEqual(spec?.path, "tracks[1].clips")
            XCTAssertEqual(spec?.message, "invalid_spec:tracks[1].clips track 'pip' has no clips")
        }
        // A missing `clips` is the same refusal, as it is on Android.
        XCTAssertThrowsError(try TestCalls.parse(TestSpecs.spec(base, ["tracks": [["id": "solo"]]]))) { error in
            XCTAssertEqual((error as? SpecError)?.message, "invalid_spec:tracks[0].clips track 'solo' has no clips")
        }
    }

    // MARK: - Inputs AVFoundation will not open by their names

    func testRenderInputsLinksOnlyWhatItsNameWouldNotOpen() throws {
        let batchId = "batch-\(UUID().uuidString)"
        defer { JobFolders.cleanup(batchId: batchId) }

        let bare = try RobustnessSupport.wav(file("render-input-1"), durationMs: 200)
        let linked = RenderInputs.openable(bare, batchId: batchId)
        XCTAssertEqual(linked.pathExtension, "wav")
        XCTAssertEqual(linked.deletingLastPathComponent().standardizedFileURL,
                       RenderInputs.folder(batchId).standardizedFileURL)
        XCTAssertEqual(try Data(contentsOf: linked), try Data(contentsOf: bare))
        XCTAssertTrue(FileManager.default.fileExists(atPath: bare.path), "the original must be left where it was")

        // The name `prepareJob` gives music that arrived without one.
        let misnamed = try RobustnessSupport.wav(file("music.m4a"), durationMs: 200)
        XCTAssertEqual(RenderInputs.openable(misnamed, batchId: batchId).pathExtension, "wav")

        // A name that already opens its content, and content nothing opens, are both left alone.
        let wav = try RobustnessSupport.wav(file("tone.wav"), durationMs: 200)
        XCTAssertEqual(RenderInputs.openable(wav, batchId: batchId), wav)
        let junk = file("junk")
        try Data("not media".utf8).write(to: junk)
        XCTAssertEqual(RenderInputs.openable(junk, batchId: batchId), junk)
    }

    func testAnExtensionlessWavSoundtrackRenders() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        // What a host that keeps the browser's sound library writes: `render-input-<uuid>`, no extension.
        let music = try RobustnessSupport.wav(file("render-input-\(UUID().uuidString)"), durationMs: 2000)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 1000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 0, "inMs": 0, "outMs": 600_000,
                                "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertTrue(probed.hasAudio)
        let level = try await RobustnessSupport.rms(of: out, from: 0.2, to: 0.8)
        XCTAssertGreaterThan(level, 0.05, "the soundtrack should be heard")
    }

    func testAWavSoundtrackNamedM4aRenders() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let music = try RobustnessSupport.wav(file("music.m4a"), durationMs: 2000)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 1000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 0, "inMs": 0, "outMs": 2000,
                                "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))
        let level = try await RobustnessSupport.rms(of: out, from: 0.2, to: 0.8)
        XCTAssertGreaterThan(level, 0.05, "the soundtrack should be heard")
    }

    func testAnExtensionlessVideoRenders() async throws {
        let named = try await TestMedia.video(file("blue.mp4"), durationMs: 1000, color: .blue)
        let bare = file("render-input-\(UUID().uuidString)")
        try FileManager.default.moveItem(at: named, to: bare)
        let (out, _) = try await TestRender.render(TestSpecs.spec([TestSpecs.clip("v", bare, outMs: 1000)]),
                                                   to: file("out.mp4"))
        let middle = try await TestMedia.color(of: out, at: 0.5)
        XCTAssertTrue(middle.near(.blue), "expected blue, got \(middle)")
    }

    // MARK: - Music

    func testMusicTrimmedPastTheEndOfItsFileIsDropped() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let music = try RobustnessSupport.wav(file("tone.wav"), durationMs: 1000)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 1000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 0, "inMs": 5000, "outMs": 6000,
                                "volume": 1, "loop": true, "fadeInMs": 0, "fadeOutMs": 400]],
        ])
        // Android's `planMusic` and the web's return null here and render the post without it.
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))
        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 1000, accuracy: 70)
        XCTAssertFalse(probed.hasAudio, "a silent video with its music dropped has nothing to mix")
    }

    func testMusicThatWillNotOpenStillFailsNamingTheMusic() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red, audio: false)
        let junk = file("music.wav")
        try Data(repeating: 7, count: 4096).write(to: junk)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 500)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": junk.absoluteString, "startMs": 0, "inMs": 0, "outMs": 1000,
                                "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]],
        ])
        do {
            _ = try await RobustnessSupport.build(options)
            XCTFail("an unreadable soundtrack should fail the build")
        } catch BuildError.unreadable(let key, _) {
            XCTAssertEqual(key, "music")
        }
    }

    func testAMusicFadeLongerThanTheMusicKeepsAndroidsSlope() {
        // Played once, 600 ms of it from 1 s.
        let once = CMTimeRange(start: ms(1000), duration: ms(600))

        // Android's `1 - t / fadeOut` from the music's start: 600 ms of a 1000 ms fade leaves 40%.
        let out = AVMutableAudioMixInputParameters()
        Fades.apply(out, first: once, last: once, volume: 0.8, fadeInMs: 0, fadeOutMs: 1000)
        let fadeOut = RobustnessSupport.ramp(of: out, at: ms(1300))
        XCTAssertEqual(fadeOut?.range, once, "a fade-out longer than the music starts where the music does")
        XCTAssertEqual(fadeOut?.from, 0.8)
        XCTAssertEqual(Double(fadeOut?.to ?? -1), 0.32, accuracy: 0.001)

        // And `t / fadeIn` up: 600 ms of a 900 ms fade reaches two thirds.
        let into = AVMutableAudioMixInputParameters()
        Fades.apply(into, first: once, last: once, volume: 1, fadeInMs: 900, fadeOutMs: 0)
        let fadeIn = RobustnessSupport.ramp(of: into, at: ms(1300))
        XCTAssertEqual(fadeIn?.range, once)
        XCTAssertEqual(fadeIn?.from, 0)
        XCTAssertEqual(Double(fadeIn?.to ?? -1), 2.0 / 3.0, accuracy: 0.001)

        // Both at once in one pass still share it, because two ramps on one track must not overlap.
        let both = AVMutableAudioMixInputParameters()
        Fades.apply(both, first: once, last: once, volume: 1, fadeInMs: 400, fadeOutMs: 400)
        XCTAssertEqual(RobustnessSupport.ramp(of: both, at: ms(1100))?.range,
                       CMTimeRange(start: ms(1000), duration: ms(300)))
        XCTAssertEqual(RobustnessSupport.ramp(of: both, at: ms(1500))?.range,
                       CMTimeRange(start: ms(1300), duration: ms(300)))
    }

    func testALoopedMusicFadesOnlyItsFirstAndLastRepetitions() throws {
        // A 300 ms piece looped across a second: 0-300, 300-600, 600-900 and a last pass of 100 ms.
        let first = CMTimeRange(start: .zero, duration: ms(300))
        let last = CMTimeRange(start: ms(900), duration: ms(100))

        // Android fades only the last pass, at its slope: a quarter of the way down, not to silence
        // across the seam before it.
        let out = AVMutableAudioMixInputParameters()
        Fades.apply(out, first: first, last: last, volume: 1, fadeInMs: 0, fadeOutMs: 400)
        let fadeOut = RobustnessSupport.ramp(of: out, at: ms(950))
        XCTAssertEqual(fadeOut?.range, last)
        XCTAssertEqual(fadeOut?.from, 1)
        XCTAssertEqual(Double(fadeOut?.to ?? -1), 0.75, accuracy: 0.001)
        let before = RobustnessSupport.ramp(of: out, at: ms(700))
        XCTAssertTrue(before?.from == 1 && before?.to == 1, "nothing fades before the last pass, got \(String(describing: before))")

        // The fade-in stops with the first pass, at 300/500 of the level, and the second pass
        // starts at the level.
        let into = AVMutableAudioMixInputParameters()
        Fades.apply(into, first: first, last: last, volume: 1, fadeInMs: 500, fadeOutMs: 0)
        let fadeIn = try XCTUnwrap(RobustnessSupport.ramp(of: into, at: ms(100)))
        XCTAssertEqual(fadeIn.range.start, .zero)
        XCTAssertEqual(Double(msOf(fadeIn.range.end)), 300, accuracy: 1)
        XCTAssertEqual(Double(fadeIn.to), 0.6, accuracy: 0.005)
        let second = RobustnessSupport.ramp(of: into, at: ms(400))
        XCTAssertTrue(second?.from == 1 && second?.to == 1, "the second pass plays at the level, got \(String(describing: second))")
    }

    // MARK: - An in-point past the footage

    func testABaseClipWhoseInPointIsPastItsFootageHoldsItsLastFrame() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red, audio: false)
        let blue = try await TestMedia.video(file("blue.mp4"), durationMs: 500, color: .blue, audio: false)
        let options = TestSpecs.spec([
            TestSpecs.clip("a", red, outMs: 500),
            // The manifest believed this file ran past 800 ms. It runs to 500.
            TestSpecs.clip("stale", blue, inMs: 800, outMs: 1300),
            TestSpecs.clip("b", red, outMs: 500),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        // The held frame is Android's and the web's MIN_CLIP_US, a millisecond of output.
        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 1001, accuracy: 70)
        let late = try await TestMedia.color(of: out, at: 0.8)
        XCTAssertTrue(late.near(.red), "expected the last clip, got \(late)")
    }

    func testALayerClipWhoseInPointIsPastItsFootageHoldsItsLastFrame() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let green = try await TestMedia.video(file("green.mp4"), durationMs: 500, color: .green, audio: false)
        let blue = try await TestMedia.video(file("blue.mp4"), durationMs: 500, color: .blue, audio: false)
        let options = TestSpecs.spec([TestSpecs.clip("base", red, outMs: 1000)], [
            "tracks": [["id": "layer", "z": 1, "clips": [
                TestSpecs.clip("stale", green, inMs: 700, outMs: 900),
                TestSpecs.clip("next", blue, outMs: 500),
            ]]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let onLayer = try await TestMedia.color(of: out, at: 0.3)
        XCTAssertTrue(onLayer.near(.blue), "expected the layer's next clip, got \(onLayer)")
        let afterLayer = try await TestMedia.color(of: out, at: 0.8)
        XCTAssertTrue(afterLayer.near(.red), "expected the base once the layer has ended, got \(afterLayer)")
    }

    // MARK: - Each clip's level, held to its end

    func testAHeldFrameLeavesTheSoundBeforeItWhole() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let green = try await TestMedia.video(file("green.mp4"), durationMs: 1000, color: .green)
        let options = TestSpecs.spec([
            TestSpecs.clip("a", red, outMs: 1000),
            // Past its footage, so held and silent.
            TestSpecs.clip("stale", green, inMs: 1500, outMs: 2000),
            TestSpecs.clip("b", green, outMs: 1000),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))
        let reference = try await RobustnessSupport.rms(of: red, from: 0.1, to: 0.9)
        try await RobustnessSupport.assertHeld(out, from: 0, to: 1, near: reference, "the clip before the held frame")
    }

    func testAClipATransitionLeadsOutOfKeepsItsLevelUntilTheWindow() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let green = try await TestMedia.video(file("green.mp4"), durationMs: 1000, color: .green)
        let options = TestSpecs.spec([
            TestSpecs.clip("a", red, outMs: 600),
            TestSpecs.clip("b", green, outMs: 1000, ["transitionIn": [
                "kind": "dissolve", "from": TestSpecs.clip("a", red, inMs: 600, outMs: 1000),
                "curves": ["alpha": [0.0, 1.0]],
            ]]),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))
        // The fade-in the window opens with starts from silence, and the clip before it used to
        // slide toward that silence across the whole of itself.
        let reference = try await RobustnessSupport.rms(of: red, from: 0.1, to: 0.9)
        try await RobustnessSupport.assertHeld(out, from: 0, to: 0.6, near: reference, "the outgoing clip")
    }

    func testEachVoiceoverTakeHoldsItsOwnVolume() async throws {
        let video = try await TestMedia.video(file("black.mp4"), durationMs: 2000, color: .black, audio: false)
        let voice = try RobustnessSupport.wav(file("voice.wav"), durationMs: 2000)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 2000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [
                ["uri": voice.absoluteString, "startMs": 0, "durationMs": 1000, "volume": 1],
                ["uri": voice.absoluteString, "startMs": 1000, "durationMs": 1000, "volume": 0.3],
            ]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))
        let reference = try await RobustnessSupport.rms(of: voice, from: 0.1, to: 0.9)
        try await RobustnessSupport.assertHeld(out, from: 0, to: 1, near: reference, "the first take")
        let quiet = try await RobustnessSupport.levels(of: out, from: 1.1, to: 2)
        XCTAssertTrue(quiet.allSatisfy { abs($0 - 0.3 * reference) < 0.1 * reference },
                      "the second take should play at 0.3 throughout, measured \(quiet)")
    }

    // MARK: - Overlay opacity

    func testAHalfOpacityWhiteOverlayOverBlackIsHalfGrey() async throws {
        let black = try await TestMedia.video(file("black.mp4"), durationMs: 1000, color: .black, audio: false)
        let png = try RobustnessSupport.pngDataURL(width: 90, height: 160, color: .white)
        let options = TestSpecs.spec([TestSpecs.clip("v", black, outMs: 1000)], [
            "overlays": [["id": "o", "png": png, "cx": 0.5, "cy": 0.5, "wPx": 360, "hPx": 640,
                          "rotationDeg": 0, "startMs": 0, "endMs": 1000, "opacity": 0.5]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        // Half of white, as the preview's globalAlpha and Android's setAlphaScale draw it. Scaling all
        // four channels drew a quarter of it, about 64.
        let middle = try await TestMedia.color(of: out, at: 0.5)
        XCTAssertTrue(middle.near(TestMedia.RGB(r: 128, g: 128, b: 128), tolerance: 24), "expected ~50% grey, got \(middle)")
    }

    func testOverlayOpacityScalesAlphaAndNotColour() throws {
        let overlay = ComposeOverlay(id: "o", png: try RobustnessSupport.pngDataURL(width: 4, height: 4, color: .white),
                                     cx: 0.5, cy: 0.5, wPx: 4, hPx: 4, rotationDeg: 0,
                                     startMs: 0, endMs: 1000, opacity: 0.5)
        let placed = try XCTUnwrap(OverlayBitmap.decode(overlay, render: CGSize(width: 4, height: 4)))

        let black = CIImage(color: .black).cropped(to: CGRect(x: 0, y: 0, width: 4, height: 4))
        let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(placed.image.composited(over: black), toBitmap: &pixel, rowBytes: 4,
                       bounds: CGRect(x: 2, y: 2, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
        XCTAssertEqual(Double(pixel[0]), 128, accuracy: 2, "white at 0.5 over black should be half grey")
        XCTAssertEqual(pixel[3], 255)
    }
}

// MARK: - Helpers for this file and the picture tests

/// What these tests need beyond `TestSupport`, under a name of their own so that nothing another
/// test file adds to `TestMedia` or `TestRender` can collide with it.
enum RobustnessSupport {
    /// Parses `options` and runs the builder alone, for a test that expects it to throw. The job
    /// folder is removed afterwards.
    @discardableResult
    static func build(_ options: [String: Any]) async throws -> BuiltComposition {
        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        return try await CompositionBuilder.build(spec)
    }

    /// A 440 Hz mono 16-bit WAV, written byte by byte so that nothing about the file depends on the
    /// name it is given - which is the whole point of the tests that use it.
    static func wav(_ url: URL, durationMs: Int64, rate: Int = 44_100) throws -> URL {
        let count = rate * Int(durationMs) / 1000
        var data = Data()
        func text(_ s: String) { data.append(contentsOf: Array(s.utf8)) }
        func u32(_ v: Int) { withUnsafeBytes(of: UInt32(v).littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: Int) { withUnsafeBytes(of: UInt16(v).littleEndian) { data.append(contentsOf: $0) } }
        text("RIFF"); u32(36 + count * 2); text("WAVE")
        text("fmt "); u32(16); u16(1); u16(1); u32(rate); u32(rate * 2); u16(2); u16(16)
        text("data"); u32(count * 2)
        for i in 0..<count {
            let sample = Int16(sin(2 * Double.pi * 440 * Double(i) / Double(rate)) * 8000)
            withUnsafeBytes(of: sample.littleEndian) { data.append(contentsOf: $0) }
        }
        try data.write(to: url)
        return url
    }

    /// The RMS level, 0...1, of a file's sound between two moments, decoded to PCM. 0 for a file
    /// with no sound at all.
    static func rms(of url: URL, from: Double, to: Double) async throws -> Double {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else { return 0 }
        let reader = try AVAssetReader(asset: asset)
        reader.timeRange = CMTimeRange(start: CMTime(seconds: from, preferredTimescale: 600),
                                       end: CMTime(seconds: to, preferredTimescale: 600))
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVLinearPCMBitDepthKey: 16,
            AVLinearPCMIsFloatKey: false,
            AVLinearPCMIsBigEndianKey: false,
            AVLinearPCMIsNonInterleaved: false,
        ])
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TestError("startReading") }
        var sum = 0.0
        var n = 0
        while let buffer = output.copyNextSampleBuffer() {
            guard let block = CMSampleBufferGetDataBuffer(buffer) else { continue }
            let length = CMBlockBufferGetDataLength(block)
            var samples = [Int16](repeating: 0, count: length / 2)
            CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: samples.count * 2, destination: &samples)
            for s in samples {
                let v = Double(s) / 32768
                sum += v * v
            }
            n += samples.count
        }
        return n == 0 ? 0 : (sum / Double(n)).squareRoot()
    }

    /// The RMS level of every 100 ms between two moments, in order. A mean over a whole clip cannot
    /// tell a level held to the clip's end from one fading out across it; this can.
    static func levels(of url: URL, from: Double, to: Double) async throws -> [Double] {
        var levels: [Double] = []
        var start = from
        while start < to - 0.001 {
            levels.append(try await rms(of: url, from: start, to: min(to, start + 0.1)))
            start += 0.1
        }
        return levels
    }

    /// Fails unless every 100 ms between two moments is at least 85% of `reference`: what a level
    /// held from the start of a stretch to its end reads as, after AAC.
    static func assertHeld(_ url: URL, from: Double, to: Double, near reference: Double, _ what: String,
                           file: StaticString = #filePath, line: UInt = #line) async throws {
        let measured = try await levels(of: url, from: from, to: to)
        XCTAssertTrue(measured.allSatisfy { $0 >= 0.85 * reference },
                      "\(what) should hold \(reference) from \(from) s to \(to) s, measured \(measured)",
                      file: file, line: line)
    }

    /// A solid PNG as the `data:image/png;base64,...` URL an overlay carries.
    static func pngDataURL(width: Int, height: Int, color: TestMedia.RGB) throws -> String {
        let cs = CGColorSpace(name: CGColorSpace.sRGB)!
        guard let ctx = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: cs, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else {
            throw TestError("context")
        }
        ctx.setFillColor(TestMedia.srgb(color))
        ctx.fill(CGRect(x: 0, y: 0, width: width, height: height))
        let data = NSMutableData()
        guard let image = ctx.makeImage(),
              let dest = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
            throw TestError("png")
        }
        CGImageDestinationAddImage(dest, image, nil)
        guard CGImageDestinationFinalize(dest) else { throw TestError("png finalize") }
        return "data:image/png;base64," + (data as Data).base64EncodedString()
    }

    /// The volume ramp in force at `time`, or nil when there is none.
    static func ramp(of p: AVAudioMixInputParameters, at time: CMTime) -> (from: Float, to: Float, range: CMTimeRange)? {
        var from: Float = 0
        var to: Float = 0
        var range = CMTimeRange.zero
        guard p.getVolumeRamp(for: time, startVolume: &from, endVolume: &to, timeRange: &range) else { return nil }
        return (from, to, range)
    }
}
