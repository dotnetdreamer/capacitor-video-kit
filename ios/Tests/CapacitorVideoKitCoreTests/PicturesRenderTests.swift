@preconcurrency import AVFoundation
import ImageIO
import UniformTypeIdentifiers
import XCTest
@testable import CapacitorVideoKitCore

/// Pictures on the timeline, rendered end to end on the simulator: the "Acceptance - Render" list in
/// `ios/PICTURES.md`, and the web's "a picture on the timeline, end to end".
final class PicturesRenderTests: RenderTestCase {

    /// A picture clip as `toComposeSpec` sends one: from 0 unless told otherwise, at 1x, silent.
    private func picture(_ key: String, _ url: URL, inMs: Int64 = 0, outMs: Int64, fit: String = "cover",
                         _ extra: [String: Any] = [:]) -> [String: Any] {
        var more: [String: Any] = ["image": true, "muted": true]
        for (k, v) in extra { more[k] = v }
        return TestSpecs.clip(key, url, inMs: inMs, outMs: outMs, fit: fit, more)
    }

    /// A picture of one colour all over.
    private func solid(_ name: String, _ color: TestMedia.RGB, type: UTType = .png) throws -> URL {
        try TestMedia.picture(file(name), type: type, left: color, middle: color, right: color)
    }

    /// The linear dissolve: the incoming side drawn at an alpha running from 0 to 1 across the window.
    private func dissolve(from: [String: Any]) -> [String: Any] {
        ["kind": "dissolve", "from": from, "curves": ["alpha": [0.0, 1.0]]]
    }

    /// Half of each side, as a dissolve looks halfway through. H.264 is lossy, so "half" is a wide
    /// band either side of 128 - and still nowhere near the pure colour a cut would leave there.
    private func assertHalfRedHalfBlue(_ c: TestMedia.RGB, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue((70...190).contains(c.r) && (70...190).contains(c.b) && c.g < 60,
                      "expected a red and blue blend, got \(c)", file: file, line: line)
    }

    // MARK: - 1. A picture between moments of video

    func testAPictureAfterAVideoRunsItsOwnLengthEdgeToEdge() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let blue = try solid("blue.png", .blue)
        let options = TestSpecs.spec([
            TestSpecs.clip("v", red, outMs: 500),
            picture("p", blue, outMs: 1000),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        // The picture's length is its own, never clamped against a probed one it does not have.
        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 1500, accuracy: 70)

        let onVideo = try await TestMedia.color(of: out, at: 0.25)
        XCTAssertTrue(onVideo.near(.red), "expected the video, got \(onVideo)")
        // Filled: a landscape picture covers the portrait frame to all four edges.
        for (x, y) in [(0.5, 0.5), (0.03, 0.03), (0.97, 0.97), (0.5, 0.02), (0.5, 0.98)] {
            let onPicture = try await TestMedia.color(of: out, at: 1.0, x: x, y: y)
            XCTAssertTrue(onPicture.near(.blue), "expected the picture at (\(x), \(y)), got \(onPicture)")
        }
    }

    func testACoverPictureKeepsItsOwnShape() async throws {
        // 600x400, red, blue and green thirds, covering a 360x640 frame: scaled to 960x640 and cut
        // to its middle 360, which shows the last 20 px of red, then blue to x = 340, then green. A
        // still written at the output's shape would have been stretched instead, all three thirds
        // in view.
        let bands = try TestMedia.picture(file("bands.png"), type: .png, left: .red, middle: .blue, right: .green)
        let (out, _) = try await TestRender.render(TestSpecs.spec([picture("p", bands, outMs: 800)]),
                                                   to: file("out.mp4"))

        let left = try await TestMedia.color(of: out, at: 0.4, x: 0.02)
        XCTAssertTrue(left.near(.red), "expected a sliver of red at the left edge, got \(left)")
        for x in [0.1, 0.5, 0.9] {
            let middle = try await TestMedia.color(of: out, at: 0.4, x: x)
            XCTAssertTrue(middle.near(.blue), "expected blue at x = \(x), got \(middle)")
        }
        let right = try await TestMedia.color(of: out, at: 0.4, x: 0.98)
        XCTAssertTrue(right.near(.green), "expected a sliver of green at the right edge, got \(right)")
    }

    // MARK: - 2. Pictures alone

    func testPicturesAloneRenderWithNoSound() async throws {
        let green = try solid("green.png", .green)
        let blue = try solid("blue.jpg", .blue, type: .jpeg)
        let options = TestSpecs.spec([picture("a", green, outMs: 600), picture("b", blue, outMs: 600)])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 1200, accuracy: 70)
        XCTAssertFalse(probed.hasAudio, "pictures have no sound, and nothing else was asked for")
        let first = try await TestMedia.color(of: out, at: 0.3)
        XCTAssertTrue(first.near(.green), "expected the first picture, got \(first)")
        let second = try await TestMedia.color(of: out, at: 0.9)
        XCTAssertTrue(second.near(.blue), "expected the second picture, got \(second)")
    }

    func testPicturesAloneCarryTheirMusic() async throws {
        let green = try solid("green.png", .green)
        let music = try RobustnessSupport.wav(file("tone.wav"), durationMs: 2000)
        let options = TestSpecs.spec([picture("a", green, outMs: 1000)], [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 0, "inMs": 0, "outMs": 2000,
                                "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertTrue(probed.hasAudio)
        let level = try await RobustnessSupport.rms(of: out, from: 0.2, to: 0.8)
        XCTAssertGreaterThan(level, 0.05, "the music should be heard over the picture")
    }

    // MARK: - 3. Dissolves both ways

    func testADissolveFromAPictureIntoAVideo() async throws {
        let blue = try solid("blue.png", .blue)
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        // Lowered as `compose.ts` lowers it: the picture stops at 600, where the video starts, and
        // its last 400 ms travel on the video as the transition's outgoing side.
        let batchId = "batch-\(UUID().uuidString)"
        defer { JobFolders.cleanup(batchId: batchId) }
        let options = TestSpecs.spec([
            picture("p", blue, outMs: 600),
            TestSpecs.clip("v", red, outMs: 1000, ["transitionIn": dissolve(from: picture("p", blue, inMs: 600, outMs: 1000))]),
        ], batchId: batchId)
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"), keepJob: true)

        // One still serves the picture and its outgoing side, and runs to the later of their ends.
        let stills = try FileManager.default.contentsOfDirectory(at: PictureStills.folder(batchId),
                                                                 includingPropertiesForKeys: nil)
        XCTAssertEqual(stills.count, 1)
        let stillTracks = try await AVURLAsset(url: try XCTUnwrap(stills.first)).loadTracks(withMediaType: .video)
        let stillTrack = try XCTUnwrap(stillTracks.first)
        let stillRange = try await stillTrack.load(.timeRange)
        XCTAssertGreaterThanOrEqual(msOf(stillRange.end), 1000)

        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 1600, accuracy: 70)
        let before = try await TestMedia.color(of: out, at: 0.3)
        XCTAssertTrue(before.near(.blue), "expected the picture before the window, got \(before)")
        // 800 ms is exactly halfway through the 600...1000 window.
        let middle = try await TestMedia.color(of: out, at: 0.8)
        assertHalfRedHalfBlue(middle)
        let after = try await TestMedia.color(of: out, at: 1.3)
        XCTAssertTrue(after.near(.red), "expected the video after the window, got \(after)")
    }

    func testADissolveFromAVideoIntoAPicture() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let blue = try solid("blue.png", .blue)
        let options = TestSpecs.spec([
            TestSpecs.clip("v", red, outMs: 600),
            picture("p", blue, outMs: 1000, ["transitionIn": dissolve(from: TestSpecs.clip("v", red, inMs: 600, outMs: 1000))]),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 1600, accuracy: 70)
        let before = try await TestMedia.color(of: out, at: 0.3)
        XCTAssertTrue(before.near(.red), "expected the video before the window, got \(before)")
        let middle = try await TestMedia.color(of: out, at: 0.8)
        assertHalfRedHalfBlue(middle)
        let after = try await TestMedia.color(of: out, at: 1.3)
        XCTAssertTrue(after.near(.blue), "expected the picture after the window, got \(after)")
    }

    // MARK: - 4. A picture on a layer

    func testAPictureOnALayerIsPlacedAndTurned() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red, audio: false)
        let green = try solid("green.png", .green)
        // The middle quarter of a 360x640 frame, 180x320, turned a quarter: it then spans 320x180
        // about the same centre.
        let options = TestSpecs.spec([TestSpecs.clip("base", red, outMs: 1000)], [
            "tracks": [["id": "pip", "z": 1, "clips": [
                picture("p", green, outMs: 1000, ["rect": ["x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5, "rotationDeg": 90]]),
            ]]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let middle = try await TestMedia.color(of: out, at: 0.5)
        XCTAssertTrue(middle.near(.green), "expected the picture in the middle, got \(middle)")
        // Inside the turned rectangle and outside the upright one...
        let wide = try await TestMedia.color(of: out, at: 0.5, x: 0.12, y: 0.5)
        XCTAssertTrue(wide.near(.green), "expected the turned picture to reach sideways, got \(wide)")
        // ...and the other way about.
        let tall = try await TestMedia.color(of: out, at: 0.5, x: 0.5, y: 0.3)
        XCTAssertTrue(tall.near(.red), "expected the base above the turned picture, got \(tall)")
        let corner = try await TestMedia.color(of: out, at: 0.5, x: 0.05, y: 0.05)
        XCTAssertTrue(corner.near(.red), "expected the base in the corner, got \(corner)")
    }

    // MARK: - 5. Orientation and HEIC

    func testAPictureWithExifOrientationSixRendersUpright() async throws {
        // Stored 600x400 with red on the left; orientation 6 shows it a quarter turn clockwise, so
        // upright it is portrait with red at the TOP.
        let photo = try TestMedia.picture(file("portrait.jpg"), type: .jpeg, width: 600, height: 400,
                                          left: .red, middle: .blue, right: .green, orientation: 6)
        let batchId = "batch-\(UUID().uuidString)"
        defer { JobFolders.cleanup(batchId: batchId) }
        let (out, _) = try await TestRender.render(TestSpecs.spec([picture("p", photo, outMs: 1000)], batchId: batchId),
                                                   to: file("out.mp4"), keepJob: true)

        let top = try await TestMedia.color(of: out, at: 0.5, x: 0.5, y: 0.15)
        XCTAssertTrue(top.near(.red), "expected red at the top, got \(top)")
        let middle = try await TestMedia.color(of: out, at: 0.5, x: 0.5, y: 0.5)
        XCTAssertTrue(middle.near(.blue), "expected blue in the middle, got \(middle)")
        let bottom = try await TestMedia.color(of: out, at: 0.5, x: 0.5, y: 0.85)
        XCTAssertTrue(bottom.near(.green), "expected green at the bottom, got \(bottom)")

        // The turn is in the still's pixels, not in a transform: portrait, and upright as stored.
        let still = try XCTUnwrap(try FileManager.default.contentsOfDirectory(
            at: PictureStills.folder(batchId), includingPropertiesForKeys: nil).first)
        let tracks = try await AVURLAsset(url: still).loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let (size, transform) = try await track.load(.naturalSize, .preferredTransform)
        XCTAssertLessThan(size.width, size.height)
        XCTAssertTrue(transform.isIdentity)
        let audio = try await AVURLAsset(url: still).loadTracks(withMediaType: .audio)
        XCTAssertTrue(audio.isEmpty, "a still has no sound track")
    }

    func testAHeicPictureRenders() async throws {
        let writable = CGImageDestinationCopyTypeIdentifiers() as? [String] ?? []
        try XCTSkipUnless(writable.contains(UTType.heic.identifier), "this simulator cannot write HEIC")
        let photo = try solid("photo.heic", .blue, type: .heic)
        let (out, _) = try await TestRender.render(TestSpecs.spec([picture("p", photo, outMs: 800)]),
                                                   to: file("out.mp4"))
        let middle = try await TestMedia.color(of: out, at: 0.4)
        XCTAssertTrue(middle.near(.blue), "expected the HEIC picture, got \(middle)")
    }

    func testAPictureNamedAsAVideoStillDecodes() async throws {
        // `prepareJob` names an input that arrived without an extension `.mp4`, pictures included.
        let photo = try solid("pic.jpg", .green, type: .jpeg)
        let misnamed = file("seg-2.mp4")
        try FileManager.default.moveItem(at: photo, to: misnamed)
        let (out, _) = try await TestRender.render(TestSpecs.spec([picture("p", misnamed, outMs: 800)]),
                                                   to: file("out.mp4"))
        let middle = try await TestMedia.color(of: out, at: 0.4)
        XCTAssertTrue(middle.near(.green), "expected the picture, got \(middle)")
    }

    // MARK: - 6. A picture that will not decode

    func testABrokenPictureFailsNamingItsClip() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let broken = file("broken.jpg")
        try Data("not a picture".utf8).write(to: broken)
        let options = TestSpecs.spec([
            TestSpecs.clip("v", red, outMs: 500),
            picture("seg-broken", broken, outMs: 1000),
        ])
        do {
            try await RobustnessSupport.build(options)
            XCTFail("a picture that will not decode should fail the build")
        } catch let error as BuildError {
            guard case .unreadable(let key, _) = error else { return XCTFail("expected unreadable, got \(error)") }
            XCTAssertEqual(key, "seg-broken")
            XCTAssertEqual(error.asFailure.code, .unreadableInput)
            XCTAssertEqual(error.asFailure.clipKey, "seg-broken")
        }
    }

    func testABrokenVideoBeforeABrokenPictureIsTheClipBlamed() async throws {
        // Android's preflight opens videos and pictures in one pass, in spec order, and fails on
        // the first that will not open. A still written up front would have blamed the picture.
        let video = file("broken.mp4")
        try Data("not a video".utf8).write(to: video)
        let picture = file("broken.jpg")
        try Data("not a picture".utf8).write(to: picture)
        let options = TestSpecs.spec([
            TestSpecs.clip("video-first", video, outMs: 500),
            self.picture("picture-second", picture, outMs: 1000),
        ])
        do {
            try await RobustnessSupport.build(options)
            XCTFail("a post whose inputs will not open should fail the build")
        } catch BuildError.unreadable(let key, _) {
            XCTAssertEqual(key, "video-first")
        }
    }

    func testCancellingWhileStillsAreWrittenLeavesNoPartOfOne() async throws {
        // Six photos at the area cap for a 1080x1920 output, so there is time to cancel between the
        // first still starting and the last one finishing.
        var clips: [[String: Any]] = []
        for i in 0..<6 {
            let photo = try TestMedia.picture(file("photo-\(i).png"), type: .png, width: 4000, height: 3000,
                                              left: .red, middle: .blue, right: .green)
            clips.append(picture("p\(i)", photo, outMs: 1000))
        }
        let batchId = "batch-\(UUID().uuidString)"
        let spec = try TestCalls.parse(TestSpecs.spec(clips, width: 1080, height: 1920, batchId: batchId))
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(batchId))
        defer { JobFolders.cleanup(batchId: batchId) }

        let build = Task { _ = try await CompositionBuilder.build(spec) }
        // Cancelled as soon as the first still appears on disk, which is while the stills are
        // being written.
        let folder = PictureStills.folder(batchId)
        while (try? FileManager.default.contentsOfDirectory(atPath: folder.path))?.isEmpty ?? true {
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        build.cancel()
        do {
            try await build.value
            XCTFail("a cancelled build should not finish")
        } catch is CancellationError {
            // What the registry reads as `cancelled`, or as the stop reason it recorded.
        }

        // Whatever is left is a whole still, never the start of one.
        let left = try FileManager.default.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)
        XCTAssertLessThan(left.count, clips.count, "the cancel should have stopped the stills")
        for still in left {
            let tracks = try await AVURLAsset(url: still).loadTracks(withMediaType: .video)
            let track = try XCTUnwrap(tracks.first, "\(still.lastPathComponent) is not a whole still")
            let range = try await track.load(.timeRange)
            XCTAssertGreaterThanOrEqual(msOf(range.end), 1000)
        }
    }

    // MARK: - 7. No pictures, no extra work

    func testASpecWithoutPicturesWritesNoStills() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let plain = "batch-\(UUID().uuidString)"
        defer { JobFolders.cleanup(batchId: plain) }
        try await TestRender.render(TestSpecs.spec([TestSpecs.clip("v", red, outMs: 500)], batchId: plain),
                                    to: file("plain.mp4"), keepJob: true)
        XCTAssertFalse(FileManager.default.fileExists(atPath: PictureStills.folder(plain).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: RenderInputs.folder(plain).path),
                       "a video named for what it is needs no link")

        // And the same check does see the folder when there is a picture, so the one above means
        // something.
        let blue = try solid("blue.png", .blue)
        let withPicture = "batch-\(UUID().uuidString)"
        defer { JobFolders.cleanup(batchId: withPicture) }
        try await TestRender.render(TestSpecs.spec([TestSpecs.clip("v", red, outMs: 500), picture("p", blue, outMs: 500)],
                                                   batchId: withPicture),
                                    to: file("picture.mp4"), keepJob: true)
        XCTAssertTrue(FileManager.default.fileExists(atPath: PictureStills.folder(withPicture).path))
    }

    // MARK: - The working files go with the render

    // Through the registry, as `compose` runs a render: `TestRender` keeps the folders, above, so
    // their absence here is `JobRegistry.run` deleting them.

    func testARenderThatFinishesLeavesNoStillsOrLinks() async throws {
        let blue = try solid("blue.png", .blue)
        // A WAV named `.m4a`, which `RenderInputs` links under `.wav` into `named/`.
        let music = try RobustnessSupport.wav(file("music.m4a"), durationMs: 1000)
        let batchId = "batch-\(UUID().uuidString)"
        defer { JobFolders.cleanup(batchId: batchId) }
        let spec = try TestCalls.parse(TestSpecs.spec([picture("p", blue, outMs: 800)], batchId: batchId, [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 0, "inMs": 0, "outMs": 1000,
                                "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]],
        ]))

        let state = try await renderThroughRegistry(spec)

        XCTAssertEqual(state["state"] as? String, "done", "\(state)")
        XCTAssertTrue(FileManager.default.fileExists(atPath: JobFolders.stitched(batchId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: PictureStills.folder(batchId).path))
        XCTAssertFalse(FileManager.default.fileExists(atPath: RenderInputs.folder(batchId).path))
    }

    func testABuildThatFailsAfterAStillLeavesNoStills() async throws {
        // The picture's still is written first, and the broken video after it fails the build.
        let blue = try solid("blue.png", .blue)
        let broken = file("broken.mp4")
        try Data("not a video".utf8).write(to: broken)
        let batchId = "batch-\(UUID().uuidString)"
        defer { JobFolders.cleanup(batchId: batchId) }
        let spec = try TestCalls.parse(TestSpecs.spec([picture("p", blue, outMs: 500),
                                                       TestSpecs.clip("v", broken, outMs: 500)], batchId: batchId))

        // Built on its own, which deletes nothing, the same spec leaves its still behind: so there
        // is a still to delete, and its absence below is the registry's doing.
        do {
            _ = try await CompositionBuilder.build(spec)
            XCTFail("a broken video should fail the build")
        } catch {
            // What the registry reports as `failed`, below.
        }
        let stills = try FileManager.default.contentsOfDirectory(atPath: PictureStills.folder(batchId).path)
        XCTAssertEqual(stills.count, 1, "the still should be written before the video fails")

        let state = try await renderThroughRegistry(spec)

        XCTAssertEqual(state["state"] as? String, "failed", "\(state)")
        XCTAssertEqual((state["error"] as? [String: Any])?["clipKey"] as? String, "v")
        XCTAssertFalse(FileManager.default.fileExists(atPath: PictureStills.folder(batchId).path))
    }

    /// Starts `spec` through the registry, as `compose` does, and answers `getState`'s answer once
    /// the render has ended.
    private func renderThroughRegistry(_ spec: ComposeSpec) async throws -> [String: Any] {
        JobRegistry.shared.start(spec: spec)
        for _ in 0..<600 {
            if let state = JobRegistry.shared.stateJSON(spec.jobId),
               let name = state["state"] as? String, ["done", "failed", "interrupted"].contains(name) {
                return state
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw TestError("the render never ended")
    }

    // MARK: - Sound around a picture

    func testAPictureBetweenTwoVideosIsSilentAndTheirSoundStaysInPlace() async throws {
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let green = try await TestMedia.video(file("green.mp4"), durationMs: 1000, color: .green)
        let blue = try solid("blue.png", .blue)
        let options = TestSpecs.spec([
            TestSpecs.clip("a", red, outMs: 1000),
            picture("p", blue, outMs: 1000),
            TestSpecs.clip("b", green, outMs: 1000),
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let probed = try await TestMedia.probe(out)
        XCTAssertTrue(probed.hasAudio)
        XCTAssertEqual(Double(probed.durationMs), 3000, accuracy: 70)
        // Each video at its own level for the whole of its length. A single volume point per clip
        // faded the first video out across all of it, toward the picture's silence.
        let reference = try await RobustnessSupport.rms(of: red, from: 0.1, to: 0.9)
        try await RobustnessSupport.assertHeld(out, from: 0, to: 1, near: reference, "the first video")
        // From 100 ms in, past the moment AAC smears the step at the cut.
        try await RobustnessSupport.assertHeld(out, from: 2.1, to: 3, near: reference, "the last video")
        let over = try await RobustnessSupport.levels(of: out, from: 1.1, to: 1.9)
        XCTAssertTrue(over.allSatisfy { $0 < 0.01 }, "the picture should be silent, measured \(over)")
        let onPicture = try await TestMedia.color(of: out, at: 1.5)
        XCTAssertTrue(onPicture.near(.blue), "expected the picture, got \(onPicture)")
    }

    func testAPictureAfterAVideoOnALayerLeavesTheVideosSoundWhole() async throws {
        let base = try await TestMedia.video(file("black.mp4"), durationMs: 2000, color: .black, audio: false)
        let red = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let blue = try solid("blue.png", .blue)
        let options = TestSpecs.spec([TestSpecs.clip("base", base, outMs: 2000)], [
            "tracks": [["id": "layer", "z": 1, "clips": [
                TestSpecs.clip("v", red, outMs: 1000),
                picture("p", blue, outMs: 1000),
            ]]],
        ])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        let reference = try await RobustnessSupport.rms(of: red, from: 0.1, to: 0.9)
        try await RobustnessSupport.assertHeld(out, from: 0, to: 1, near: reference, "the layer's video")
        let over = try await RobustnessSupport.levels(of: out, from: 1.1, to: 2)
        XCTAssertTrue(over.allSatisfy { $0 < 0.01 }, "the layer's picture should be silent, measured \(over)")
    }
}
