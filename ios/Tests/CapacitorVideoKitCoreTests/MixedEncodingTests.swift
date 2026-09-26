@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// Clips of the same size whose streams were encoded differently, one after another.
///
/// Every base clip used to go on one composition track, and AVFoundation decodes a track through
/// one decompression session, which it can keep when the track moves on to the next file. For H.264
/// it did whenever the sequence parameter sets matched, and the next file was then decoded as if it
/// carried the first file's picture parameter set. In the app two 1080x1920 x264 files that differed
/// only in `crf` rendered the second as the first one's last frame for the whole of its 60 s. Here
/// the pair is written on the spot: the simulator's encoder at High profile, once with CABAC and once
/// with CAVLC, which gives the same SPS and a PPS that differs in `entropy_coding_mode_flag` - the
/// same failure, with the second clip drawn in the first one's colour. `CompositionBuilder` now
/// gives each format its own track (see `FormatTracks`), and these tests hold it to that on the base,
/// on the transition tails and on a layer, and to keeping one track where the formats match.
final class MixedEncodingTests: RenderTestCase {

    /// The two encodings: identical sequence parameter sets, different picture parameter sets.
    private static let cabac: [String: Any] = [AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                                               AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCABAC]
    private static let cavlc: [String: Any] = [AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
                                               AVVideoH264EntropyModeKey: AVVideoH264EntropyModeCAVLC]

    // MARK: - The base

    func testASameSizedClipEncodedDifferentlyShowsItsOwnPicture() async throws {
        let a = try await TestMedia.video(file("a.mp4"), durationMs: 1000, color: .red, audio: false,
                                          compression: Self.cabac)
        let b = try await TestMedia.video(file("b.mp4"), durationMs: 1000, color: .blue, audio: false,
                                          compression: Self.cavlc)
        try await assertSameSizeDifferentPPS(a, b)

        let options = TestSpecs.spec([
            TestSpecs.clip("a1", a, outMs: 1000),
            TestSpecs.clip("b", b, outMs: 1000),
            TestSpecs.clip("a2", a, outMs: 1000),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 3000, accuracy: 70)
        let first = try await TestMedia.color(of: out, at: 0.5)
        XCTAssertTrue(first.near(.red), "expected the first clip, got \(first)")
        // Drawn in the first clip's red while the two files shared one track.
        let middle = try await TestMedia.color(of: out, at: 1.5)
        XCTAssertTrue(middle.near(.blue), "expected the differently encoded clip at its midpoint, got \(middle)")
        // And back: the first file again, after the second.
        let end = try await TestMedia.color(of: out, at: 2.8)
        XCTAssertTrue(end.near(.red), "expected the first file again at the end, got \(end)")
    }

    func testClipsEncodedAlikeStayOnOneVideoTrack() async throws {
        // Two files written with the same settings, which is every clip one camera recorded: the
        // composition must be the one it always was, one video track that every instruction names.
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false,
                                            compression: Self.cabac)
        let green = try await TestMedia.video(file("green.mp4"), durationMs: 1000, color: .green, audio: false,
                                              compression: Self.cabac)
        let alike = try await RobustnessSupport.build(TestSpecs.spec([
            TestSpecs.clip("a", red, outMs: 1000),
            TestSpecs.clip("b", green, outMs: 1000),
            TestSpecs.clip("c", red, outMs: 500),
        ], ["durationMs": 3000]))
        let only = alike.composition.tracks(withMediaType: .video)
        XCTAssertEqual(only.count, 1, "clips encoded alike should share one video track")
        XCTAssertEqual(Set(Self.namedTracks(alike)), Set(only.map(\.trackID)))

        // A differently encoded file in the middle takes a track of its own, and only that clip.
        let blue = try await TestMedia.video(file("blue.mp4"), durationMs: 1000, color: .blue, audio: false,
                                             compression: Self.cavlc)
        let mixed = try await RobustnessSupport.build(TestSpecs.spec([
            TestSpecs.clip("a", red, outMs: 1000),
            TestSpecs.clip("b", blue, outMs: 1000),
            TestSpecs.clip("c", green, outMs: 1000),
        ]))
        XCTAssertEqual(mixed.composition.tracks(withMediaType: .video).count, 2)
        let named = Self.namedTracks(mixed)
        XCTAssertEqual(named.count, 3)
        XCTAssertEqual(named[0], named[2], "the two clips encoded alike should share a track")
        XCTAssertNotEqual(named[0], named[1], "the clip encoded differently should be on a track of its own")
    }

    func testWhatAFileSaysAboutItselfDoesNotSplitATrack() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red, audio: false,
                                            compression: Self.cabac)
        let real = try await TestTracks.format(of: red, .video)

        // The same stream as another file would describe it: ffmpeg writes a `btrt` box holding the
        // file's own bitrate, names itself, and keeps the whole sample entry verbatim besides.
        let other = try Self.redescribed(real) { ext in
            var atoms = ext[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String] as? [String: Any] ?? [:]
            atoms["btrt"] = Data([0, 0, 0x10, 0, 0, 0x01, 0x86, 0xa0, 0, 0, 0xc3, 0x50])
            ext[kCMFormatDescriptionExtension_SampleDescriptionExtensionAtoms as String] = atoms
            ext[kCMFormatDescriptionExtension_FormatName as String] = "Lavc60.3.100 libx264"
            ext[kCMFormatDescriptionExtension_VerbatimISOSampleEntry as String] = Data(repeating: 7, count: 64)
        }
        XCTAssertFalse(CMFormatDescriptionEqual(real, otherFormatDescription: other),
                       "the copy should differ from the file's own description")
        XCTAssertTrue(VideoFormat.decodesAlike(real, other), "a bitrate box and a name should not split a track")

        // What the decoder is handed still does.
        let blue = try await TestMedia.video(file("blue.mp4"), durationMs: 500, color: .blue, audio: false,
                                             compression: Self.cavlc)
        let cavlc = try await TestTracks.format(of: blue, .video)
        XCTAssertFalse(VideoFormat.decodesAlike(real, cavlc), "another picture parameter set should split a track")
        let retagged = try Self.redescribed(real) { ext in
            ext[kCMFormatDescriptionExtension_ColorPrimaries as String] = kCMFormatDescriptionColorPrimaries_P3_D65
        }
        XCTAssertFalse(VideoFormat.decodesAlike(real, retagged), "another colour tag should split a track")
    }

    // MARK: - Transition tails and layers

    func testEachTransitionTailIsDrawnFromItsOwnFile() async throws {
        let a = try await TestMedia.video(file("a.mp4"), durationMs: 2000, color: .red, audio: false,
                                          compression: Self.cabac)
        let b = try await TestMedia.video(file("b.mp4"), durationMs: 2000, color: .blue, audio: false,
                                          compression: Self.cavlc)
        try await assertSameSizeDifferentPPS(a, b)

        // Each transition holds its outgoing side for the whole window, so the tail is all a frame
        // inside one shows. The two tails come from the two files and share the tail track unless
        // they are kept apart the way the base clips are.
        func hold(from: [String: Any]) -> [String: Any] {
            ["kind": "dissolve", "from": from, "curves": ["alpha": [0.0, 0.0]]]
        }
        let options = TestSpecs.spec([
            TestSpecs.clip("a1", a, outMs: 600),
            TestSpecs.clip("b", b, outMs: 1000, ["transitionIn": hold(from: TestSpecs.clip("a1", a, inMs: 600, outMs: 1000))]),
            TestSpecs.clip("a2", a, outMs: 1000, ["transitionIn": hold(from: TestSpecs.clip("b", b, inMs: 1000, outMs: 1400))]),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 2600, accuracy: 70)
        // 600...1000 is the first window, drawn from the first file's tail.
        let firstTail = try await TestMedia.color(of: out, at: 0.8)
        XCTAssertTrue(firstTail.near(.red), "expected the first clip's tail, got \(firstTail)")
        let second = try await TestMedia.color(of: out, at: 1.3)
        XCTAssertTrue(second.near(.blue), "expected the differently encoded clip, got \(second)")
        // 1600...2000 is the second window, drawn from the second file's tail.
        let secondTail = try await TestMedia.color(of: out, at: 1.8)
        XCTAssertTrue(secondTail.near(.blue), "expected the differently encoded clip's tail, got \(secondTail)")
        let last = try await TestMedia.color(of: out, at: 2.3)
        XCTAssertTrue(last.near(.red), "expected the first file again, got \(last)")
    }

    func testALayerOfDifferentlyEncodedClipsShowsEachOfThem() async throws {
        let base = try await TestMedia.video(file("green.mp4"), durationMs: 2000, color: .green, audio: false,
                                             compression: Self.cabac)
        let a = try await TestMedia.video(file("a.mp4"), durationMs: 1000, color: .red, audio: false,
                                          compression: Self.cabac)
        let b = try await TestMedia.video(file("b.mp4"), durationMs: 1000, color: .blue, audio: false,
                                          compression: Self.cavlc)
        let options = TestSpecs.spec([TestSpecs.clip("base", base, outMs: 2000)], [
            "tracks": [["id": "layer", "z": 1, "clips": [
                TestSpecs.clip("a", a, outMs: 1000),
                TestSpecs.clip("b", b, outMs: 1000),
            ]]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let first = try await TestMedia.color(of: out, at: 0.5)
        XCTAssertTrue(first.near(.red), "expected the layer's first clip, got \(first)")
        let second = try await TestMedia.color(of: out, at: 1.5)
        XCTAssertTrue(second.near(.blue), "expected the layer's differently encoded clip, got \(second)")
    }

    // MARK: - Helpers

    /// The pair these tests are about, checked rather than assumed: the same picture size, and
    /// format descriptions that differ only in the picture parameter set. Should the simulator's
    /// encoder ever write different sequence parameter sets for the two settings, the decoder would
    /// be rebuilt between them anyway and these tests would no longer catch what they are for.
    private func assertSameSizeDifferentPPS(_ a: URL, _ b: URL,
                                            file: StaticString = #filePath, line: UInt = #line) async throws {
        let fa = try await TestTracks.format(of: a, .video)
        let fb = try await TestTracks.format(of: b, .video)
        let sa = CMVideoFormatDescriptionGetDimensions(fa), sb = CMVideoFormatDescriptionGetDimensions(fb)
        XCTAssertTrue(sa.width == sb.width && sa.height == sb.height, "the two files should be the same size",
                      file: file, line: line)
        XCTAssertFalse(CMFormatDescriptionEqual(fa, otherFormatDescription: fb),
                       "the two files should be encoded differently", file: file, line: line)
        let pa = Self.parameterSets(fa), pb = Self.parameterSets(fb)
        XCTAssertEqual(pa.first, pb.first, "the two files should share their SPS", file: file, line: line)
        XCTAssertNotEqual(pa.dropFirst().first, pb.dropFirst().first, "the two files should differ in their PPS",
                          file: file, line: line)
    }

    /// Every H.264 parameter set a format description carries, SPS first.
    private static func parameterSets(_ format: CMFormatDescription) -> [Data] {
        var count = 0
        CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: 0, parameterSetPointerOut: nil,
                                                           parameterSetSizeOut: nil, parameterSetCountOut: &count,
                                                           nalUnitHeaderLengthOut: nil)
        return (0..<count).compactMap { i in
            var bytes: UnsafePointer<UInt8>?
            var size = 0
            CMVideoFormatDescriptionGetH264ParameterSetAtIndex(format, parameterSetIndex: i,
                                                               parameterSetPointerOut: &bytes,
                                                               parameterSetSizeOut: &size, parameterSetCountOut: nil,
                                                               nalUnitHeaderLengthOut: nil)
            return bytes.map { Data(bytes: $0, count: size) }
        }
    }

    /// `format` again, with the same codec and size and its extensions changed by `change`.
    private static func redescribed(_ format: CMFormatDescription,
                                    _ change: (inout [String: Any]) -> Void) throws -> CMFormatDescription {
        var ext = CMFormatDescriptionGetExtensions(format) as? [String: Any] ?? [:]
        change(&ext)
        let size = CMVideoFormatDescriptionGetDimensions(format)
        var out: CMFormatDescription?
        let status = CMVideoFormatDescriptionCreate(allocator: kCFAllocatorDefault,
                                                    codecType: CMFormatDescriptionGetMediaSubType(format),
                                                    width: size.width, height: size.height,
                                                    extensions: ext as CFDictionary, formatDescriptionOut: &out)
        guard status == noErr, let out else { throw TestError("format description: \(status)") }
        return out
    }

    /// The source track each instruction draws its bottom layer from, in order.
    private static func namedTracks(_ built: BuiltComposition) -> [CMPersistentTrackID] {
        built.videoComposition.instructions.compactMap { ($0 as? EditInstruction)?.layers.first?.trackID }
    }
}
