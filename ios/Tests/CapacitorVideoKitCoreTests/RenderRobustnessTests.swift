@preconcurrency import AVFoundation
import CoreImage
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CapacitorVideoKitCore

/// Specs the other engines render and this one used to refuse or render wrongly: inputs named so that
/// AVFoundation will not open them, music trimmed past its file, music fades across a loop's seams
/// and where they overlap, a clip whose in-point is past its footage, a clip's sound fading out
/// toward a silent neighbour, the parser's track defaults, and an overlay's opacity.
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

    func testExtraMusicLanesMixSequentialAndOverlappingClips() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 2000, color: .red, audio: false)
        let sound = try RobustnessSupport.wav(file("tone.wav"), durationMs: 2000)
        func clip(_ start: Int, _ end: Int) -> [String: Any] {
            ["uri": sound.absoluteString, "startMs": start, "endMs": end,
             "inMs": 0, "outMs": 2000, "volume": 0.25, "loop": false,
             "fadeInMs": 0, "fadeOutMs": 0]
        }
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 2000)], [
            "audio": ["music": NSNull(), "voiceover": [Any](),
                      "musicTracks": [[clip(0, 700), clip(1000, 1700)], [clip(500, 1500)] ]],
        ])
        let parsed = try TestCalls.parse(options)
        XCTAssertEqual(parsed.audio.musicTracks.map(\.count), [2, 1])
        XCTAssertEqual(parsed.inputURIs.filter { $0 == sound.absoluteString }.count, 3)

        let built = try await RobustnessSupport.build(options)
        let tracks = built.composition.tracks(withMediaType: .audio)
        XCTAssertEqual(tracks.count, 3)
        XCTAssertEqual(built.audioMix?.inputParameters.count, 3)
        let starts = tracks.flatMap { $0.segments.filter { !$0.isEmpty }.map { $0.timeMapping.target.start.seconds } }.sorted()
        XCTAssertEqual(starts.count, 3)
        for (actual, expected) in zip(starts, [0.0, 0.5, 1.0]) {
            XCTAssertEqual(actual, expected, accuracy: 0.001)
        }
    }

    func testInvalidExtraMusicClipNamesItsLaneAndIndex() throws {
        let options = TestSpecs.spec([TestSpecs.clip("v", file("a.mp4"), outMs: 2000)], [
            "audio": ["musicTracks": [[["uri": file("tone.wav").absoluteString,
                                        "inMs": 500, "outMs": 0]]]],
        ])
        XCTAssertThrowsError(try TestCalls.parse(options)) { error in
            XCTAssertEqual((error as? SpecError)?.path, "audio.musicTracks[0][0].outMs")
        }

        // Past the first lane and the first sound, and the other field MusicDTO checks. Capacitor's
        // decoder hands an array element an empty `codingPath`, so the index has to come from the loop.
        let good: [String: Any] = ["uri": file("tone.wav").absoluteString, "inMs": 0, "outMs": 1000]
        let second = TestSpecs.spec([TestSpecs.clip("v", file("a.mp4"), outMs: 2000)], [
            "audio": ["musicTracks": [[good], [good, ["uri": "", "inMs": 0, "outMs": 1000]]]],
        ])
        XCTAssertThrowsError(try TestCalls.parse(second)) { error in
            XCTAssertEqual((error as? SpecError)?.path, "audio.musicTracks[1][1].uri")
        }
    }

    func testMusicPhaseDefaultsToZeroAndRetainsSignedValues() throws {
        let url = file("a.mp4")
        var music: [String: Any] = ["uri": file("tone.wav").absoluteString, "inMs": 200, "outMs": 1000]
        func parse() throws -> ComposeSpec {
            try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("v", url, outMs: 1000)], [
                "audio": ["music": music],
            ]))
        }

        XCTAssertEqual(try parse().audio.music?.phaseMs, 0)
        music["phaseMs"] = -400
        XCTAssertEqual(try parse().audio.music?.phaseMs, -400)
        music["phaseMs"] = 1150
        XCTAssertEqual(try parse().audio.music?.phaseMs, 1150)
    }

    func testMusicPhaseOffsetsOnlyTheFirstLoopPass() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 2000, color: .red, audio: false)
        let music = try RobustnessSupport.wav(file("tone.wav"), durationMs: 1200)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 2000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 100, "inMs": 200,
                                "outMs": 1000, "phaseMs": -500, "endMs": 1750,
                                "volume": 1, "loop": true, "fadeInMs": 0, "fadeOutMs": 0]],
        ])
        let built = try await RobustnessSupport.build(options)
        let track = try XCTUnwrap(built.composition.tracks(withMediaType: .audio).first)
        let passes = track.segments.filter { !$0.isEmpty }
        // -500 wraps to 300 inside an 800 ms section: first 500...1000, then the
        // full 200...1000, then the last 350 ms up to the output stop at 1750.
        let expected: [(source: Double, target: Double, duration: Double)] = [
            (0.5, 0.1, 0.5), (0.2, 0.6, 0.8), (0.2, 1.4, 0.35),
        ]
        XCTAssertEqual(passes.count, expected.count)
        for (pass, want) in zip(passes, expected) {
            XCTAssertEqual(pass.timeMapping.source.start.seconds, want.source, accuracy: 0.001)
            XCTAssertEqual(pass.timeMapping.target.start.seconds, want.target, accuracy: 0.001)
            XCTAssertEqual(pass.timeMapping.target.duration.seconds, want.duration, accuracy: 0.001)
        }
    }

    func testNonLoopingMusicPhasePlaysOnlyTheRemainder() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 2000, color: .red, audio: false)
        let music = try RobustnessSupport.wav(file("tone.wav"), durationMs: 1200)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 2000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 100, "inMs": 200,
                                "outMs": 1000, "phaseMs": 1150,
                                "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]],
        ])
        let built = try await RobustnessSupport.build(options)
        let track = try XCTUnwrap(built.composition.tracks(withMediaType: .audio).first)
        let passes = track.segments.filter { !$0.isEmpty }
        XCTAssertEqual(passes.count, 1)
        let pass = try XCTUnwrap(passes.first)
        XCTAssertEqual(pass.timeMapping.source.start.seconds, 0.55, accuracy: 0.001)
        XCTAssertEqual(pass.timeMapping.target.start.seconds, 0.1, accuracy: 0.001)
        XCTAssertEqual(pass.timeMapping.target.duration.seconds, 0.45, accuracy: 0.001)
    }

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

    func testLoopedMusicStopsAtItsOwnStop() async throws {
        let video = try await TestMedia.video(file("red.mp4"), durationMs: 2000, color: .red, audio: false)
        let music = try RobustnessSupport.wav(file("tone.wav"), durationMs: 500)
        // A half-second piece repeating from the start, told to stop at 1.2 s of a two-second post.
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 2000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 0, "inMs": 0, "outMs": 500, "endMs": 1200,
                                "volume": 1, "loop": true, "fadeInMs": 0, "fadeOutMs": 0]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 2000, accuracy: 70, "the stop shortens the music, never the video")
        let repeating = try await RobustnessSupport.rms(of: out, from: 0.6, to: 1.1)
        XCTAssertGreaterThan(repeating, 0.05, "the second pass should be heard")
        let after = try await RobustnessSupport.rms(of: out, from: 1.4, to: 1.9)
        XCTAssertLessThan(after, 0.01, "nothing should be heard past the stop")
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

    /*
     * The fades belong to the window the music is heard in, not to a repetition: every engine draws
     * `volume * min(1, (t - start) / fadeIn) * min(1, (end - t) / fadeOut)` (ComposeMusic). The
     * render tests below hear it; these read the ramps it is drawn with.
     */

    func testAMusicFadeLongerThanTheMusicStillEndsInSilence() {
        // Played once, 600 ms of it from 1 s.
        let once = CMTimeRange(start: ms(1000), duration: ms(600))

        // `(end - t) / fadeOut`: the music starts 600 ms from its end, 60% of the way up a 1000 ms
        // fade, and comes down from there to silence at its end.
        let out = AVMutableAudioMixInputParameters()
        Fades.apply(out, heard: once, volume: 0.8, fadeInMs: 0, fadeOutMs: 1000)
        let fadeOut = RobustnessSupport.ramp(of: out, at: ms(1300))
        XCTAssertEqual(fadeOut?.range, once, "a fade-out longer than the music runs the whole of it")
        XCTAssertEqual(Double(fadeOut?.from ?? -1), 0.48, accuracy: 0.001)
        XCTAssertEqual(fadeOut?.to, 0)

        // And `(t - start) / fadeIn` up: 600 ms of a 900 ms fade reaches two thirds.
        let into = AVMutableAudioMixInputParameters()
        Fades.apply(into, heard: once, volume: 1, fadeInMs: 900, fadeOutMs: 0)
        let fadeIn = RobustnessSupport.ramp(of: into, at: ms(1300))
        XCTAssertEqual(fadeIn?.range, once)
        XCTAssertEqual(fadeIn?.from, 0)
        XCTAssertEqual(Double(fadeIn?.to ?? -1), 2.0 / 3.0, accuracy: 0.001)
    }

    func testOverlappingFadesMultiplyAsEveryOtherEngineDoes() {
        // 400 ms up and 400 ms down over 600 ms: up alone until 1.2 s, both from 1.2 s to 1.4 s,
        // and down alone after that.
        let once = CMTimeRange(start: ms(1000), duration: ms(600))
        let both = AVMutableAudioMixInputParameters()
        Fades.apply(both, heard: once, volume: 1, fadeInMs: 400, fadeOutMs: 400)
        XCTAssertEqual(RobustnessSupport.ramp(of: both, at: ms(1100))?.range,
                       CMTimeRange(start: ms(1000), duration: ms(200)))
        XCTAssertEqual(RobustnessSupport.ramp(of: both, at: ms(1500))?.range,
                       CMTimeRange(start: ms(1400), duration: ms(200)))
        // Where both move the level is their product, 0.75 x 0.75 in the middle, where the halves
        // this drew before reached the full level. Drawn in short pieces, so every moment of it is
        // within a hair of the curve and never a ramp longer than a piece.
        for t in stride(from: 1201.0, to: 1400.0, by: 7.0) {
            let at = CMTime(seconds: t / 1000, preferredTimescale: 1_000_000)
            let want = Double(Fades.gain(at: t / 1000, start: 1, end: 1.6, volume: 1, fadeIn: 0.4, fadeOut: 0.4))
            let got = RobustnessSupport.volume(of: both, at: at)
            XCTAssertEqual(Double(got ?? -1), want, accuracy: 0.01, "the level at \(t) ms")
        }
        XCTAssertEqual(Double(RobustnessSupport.volume(of: both, at: ms(1300)) ?? -1), 0.5625, accuracy: 0.002)
        let piece = RobustnessSupport.ramp(of: both, at: CMTime(seconds: 1.303, preferredTimescale: 1_000_000))
        XCTAssertLessThan(piece?.range.duration.seconds ?? 1, 0.01)
    }

    func testALoopedMusicsFadesRunAcrossItsSeams() {
        // A 300 ms piece looped across a second: 0-300, 300-600, 600-900 and a last pass of 100 ms.
        // Nothing here knows where the seams are, which is the point: the fades are the second's.
        let heard = CMTimeRange(start: .zero, duration: ms(1000))

        // The fade out starts in the pass before the last and reaches silence at the end, where
        // it used to cover only the last 100 ms and stop at three quarters of the level.
        let out = AVMutableAudioMixInputParameters()
        Fades.apply(out, heard: heard, volume: 1, fadeInMs: 0, fadeOutMs: 400)
        let fadeOut = RobustnessSupport.ramp(of: out, at: ms(950))
        XCTAssertEqual(fadeOut?.range, CMTimeRange(start: ms(600), duration: ms(400)))
        XCTAssertEqual(fadeOut?.from, 1)
        XCTAssertEqual(fadeOut?.to, 0)

        // The fade in runs on across the first seam to the level, rather than stopping at 300/500
        // of it and jumping at the seam.
        let into = AVMutableAudioMixInputParameters()
        Fades.apply(into, heard: heard, volume: 1, fadeInMs: 500, fadeOutMs: 0)
        let fadeIn = RobustnessSupport.ramp(of: into, at: ms(400))
        XCTAssertEqual(fadeIn?.range, CMTimeRange(start: .zero, duration: ms(500)))
        XCTAssertEqual(fadeIn?.from, 0)
        XCTAssertEqual(fadeIn?.to, 1)
    }

    /*
     * A loop stopped 50 ms past a seam: the last pass is a sliver, shorter than the fade. The fade out
     * used to hang off that pass alone, so the music played at full level to the seam and then cut
     * off at 95% of it. Android drops a pass shorter than a frame and fades the one before; with the
     * fade on the window, every engine reaches silence at the stop whatever the last pass is.
     */
    func testAFadeOutReachesSilenceWhenTheLastPassIsASliver() async throws {
        let video = try await TestMedia.video(file("black.mp4"), durationMs: 3000, color: .black, audio: false)
        let tone = try RobustnessSupport.wav(file("tone.wav"), durationMs: 1000)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 3000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": tone.absoluteString, "startMs": 0, "inMs": 0, "outMs": 1000, "endMs": 2050,
                                "volume": 1, "loop": true, "fadeInMs": 0, "fadeOutMs": 1000]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let reference = try await RobustnessSupport.rms(of: tone, from: 0.1, to: 0.9)
        try await RobustnessSupport.assertHeld(out, from: 0.1, to: 1.0, near: reference, "the music before its fade")
        // Half way down the fade, which starts in the second pass, at 1.05 s.
        let half = try await RobustnessSupport.rms(of: out, from: 1.5, to: 1.6)
        XCTAssertEqual(half / reference, 0.5, accuracy: 0.12, "half way through the fade out")
        // The last 100 ms before the stop are the last tenth of the fade, not the full level.
        let end = try await RobustnessSupport.rms(of: out, from: 1.95, to: 2.05)
        XCTAssertLessThan(end / reference, 0.15, "the fade out should reach silence at the stop")
    }

    /*
     * The preview multiplies a fade in by a fade out where they overlap, and so do Android and the
     * web. iOS used to give each half of the music, reaching the full level in the middle: about 5 dB
     * louder than what was previewed.
     */
    func testAShortSoundWithBothFadesPeaksWhereThePreviewDoes() async throws {
        let video = try await TestMedia.video(file("black.mp4"), durationMs: 2000, color: .black, audio: false)
        let tone = try RobustnessSupport.wav(file("tone.wav"), durationMs: 1500)
        let options = TestSpecs.spec([TestSpecs.clip("v", video, outMs: 2000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": tone.absoluteString, "startMs": 0, "inMs": 0, "outMs": 600_000,
                                "volume": 1, "loop": false, "fadeInMs": 1000, "fadeOutMs": 1000]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let reference = try await RobustnessSupport.rms(of: tone, from: 0.1, to: 0.9)
        // 0.75 x 0.75 at 0.75 s, and 0.5 x 1 a quarter of a second before it, where the halves this
        // drew before read 1 and 0.67.
        let middle = try await RobustnessSupport.rms(of: out, from: 0.7, to: 0.8)
        XCTAssertEqual(middle / reference, 0.5625, accuracy: 0.08, "the middle of the sound")
        let early = try await RobustnessSupport.rms(of: out, from: 0.45, to: 0.55)
        XCTAssertEqual(early / reference, 0.5, accuracy: 0.08, "a quarter of a second before the middle")
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

    /// The volume a ramp gives at `time`, along the straight line it draws; nil when no ramp is in
    /// force there.
    static func volume(of p: AVAudioMixInputParameters, at time: CMTime) -> Float? {
        guard let r = ramp(of: p, at: time), r.range.duration > .zero else { return nil }
        let into = (time - r.range.start).seconds / r.range.duration.seconds
        return r.from + (r.to - r.from) * Float(into)
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
