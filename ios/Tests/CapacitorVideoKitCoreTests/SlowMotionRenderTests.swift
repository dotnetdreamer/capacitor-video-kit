@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// Smooth slow motion end to end: specs built by the real builder and drawn by the real compositor, read back
/// frame by frame BEFORE any encoder (`TestComposed.frames`), in the three modes the builder takes:
/// `.off` - the engine as it was, repeated frames - `.blend` and `.flow`.
///
/// What is held here is the contract in `ComposeOutput.fps` (definitions.ts), iOS side:
///  - a clip that is NOT slowed - 1x, faster, a picture, a transition out of a 1x clip, a 1x layer - draws
///    today's frames BYTE FOR BYTE in every mode;
///  - a slowed clip keeps today's frame count and frame times, draws its on-a-frame instants as today's frames
///    byte for byte (the frame source's colour is the composition's), and invents the instants between them;
///  - the weights follow the frames' REAL timestamps, and only the clip's OWN frames take part;
///  - base clips, extra layers and transition tails alike;
///  - a frame source that fails draws today's frames and the export still succeeds; a flow that fails draws the
///    cross-fade;
///  - both engines (the writer and the AVAssetExportSession fallback) render through it.
///
/// The media is written on the spot at 128x128, the render is 128x128 and every clip is `cover`, so a source
/// pixel is an output pixel and a frame's pixels can be compared across modes without a resample in between.
final class SlowMotionRenderTests: RenderTestCase {

    static let side = 128

    // MARK: - Helpers

    /// A 30 fps video of `count` frames whose frame `i` carries `i` (`TestMedia.indexPicture`), with B-frames.
    func indexVideo(_ name: String, _ count: Int, times: [CMTime]? = nil) async throws -> URL {
        try await TestMedia.frames(file(name), width: Self.side, height: Self.side,
                                   times: times ?? TestMedia.evenTimes(count), reorder: true) {
            TestMedia.indexPicture($0, width: Self.side, height: Self.side)
        }
    }

    func spec(_ clips: [[String: Any]], _ extra: [String: Any] = [:]) -> [String: Any] {
        TestSpecs.spec(clips, width: Self.side, height: Self.side, fps: 30, extra)
    }

    func clip(_ key: String, _ url: URL, inMs: Int64 = 0, outMs: Int64, speed: Double = 1,
              _ extra: [String: Any] = [:]) -> [String: Any] {
        var more = extra
        more["speed"] = speed
        return TestSpecs.clip(key, url, inMs: inMs, outMs: outMs, fit: "cover", more)
    }

    /// Builds `options` in `mode` and reads every frame the compositor draws. `prepare` sees the built plan
    /// before a frame is drawn, which is where a test sets a `SlowMotionTestFaults`.
    func composed(_ options: [String: Any], _ mode: SlowMotionMode,
                  prepare: (BuiltComposition) -> Void = { _ in }) async throws -> (frames: [ComposedFrame], built: BuiltComposition) {
        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let built = try await CompositionBuilder.build(spec, slowMotion: mode)
        prepare(built)
        return (try TestComposed.frames(built), built)
    }

    /// Every `SlowClip` the build attached, to its layers and its transition tails, once each.
    func slowClips(_ built: BuiltComposition) -> [SlowClip] {
        var seen = Set<ObjectIdentifier>()
        var clips: [SlowClip] = []
        for case let instruction as EditInstruction in built.videoComposition.instructions {
            for clip in instruction.layers.compactMap(\.slow) + [instruction.transition?.tail.slow].compactMap({ $0 })
            where seen.insert(ObjectIdentifier(clip)).inserted {
                clips.append(clip)
            }
        }
        return clips
    }

    /// The same frames at the same times, byte for byte - reported by the first frame that is not, rather than
    /// by printing two arrays of pixels.
    func assertSameFrames(_ got: [ComposedFrame], _ want: [ComposedFrame], _ label: String,
                          file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(got.map(\.seconds), want.map(\.seconds), "\(label): frame times", file: file, line: line)
        for (k, (g, w)) in zip(got, want).enumerated() where g != w {
            XCTFail("\(label): frame \(k) at \(g.seconds) differs by up to \(g.largestDifference(w))", file: file, line: line)
            return
        }
    }

    /// Frame `between` against the cross-fade of `a` and `b` at `weight`, per channel: the largest distance
    /// from `a (1 - w) + b w`, in code values, over the whole frame or over the square `inside` (in pixels, from
    /// the top left).
    func distanceFromMix(_ between: ComposedFrame, _ a: ComposedFrame, _ b: ComposedFrame, _ weight: Double,
                         inside: (x: Int, y: Int, side: Int)? = nil) -> Double {
        let box = inside ?? (x: 0, y: 0, side: between.width)
        var worst = 0.0
        for y in box.y..<(box.y + box.side) {
            for x in box.x..<(box.x + box.side) {
                for c in 0..<3 {
                    let i = (y * between.width + x) * 4 + c
                    let exact = Double(a.bgra[i]) * (1 - weight) + Double(b.bgra[i]) * weight
                    worst = max(worst, abs(Double(between.bgra[i]) - exact))
                }
            }
        }
        return worst
    }

    func index(_ frame: ComposedFrame) -> Int { TestMedia.indexOf(frame.bgra, width: frame.width, height: frame.height) }

    // MARK: - a. Nothing that is not slowed changes

    func testClipsThatAreNotSlowedDrawTodaysFramesByteForByteInEveryMode() async throws {
        let video = try await indexVideo("v.mp4", 60)
        let other = try await indexVideo("w.mp4", 45)
        let picture = try TestMedia.picture(file("p.png"), type: .png, width: Self.side, height: Self.side)
        let pictureClip: (Int64, [String: Any]) -> [String: Any] = { outMs, extra in
            var more: [String: Any] = ["image": true, "muted": true]
            for (k, v) in extra { more[k] = v }
            return self.clip("p", picture, outMs: outMs, more)
        }
        let cases: [(String, [String: Any])] = [
            ("a 1x video", spec([clip("v", video, outMs: 1000)])),
            ("a 2x video", spec([clip("v", video, outMs: 2000, speed: 2)])),
            ("a picture", spec([pictureClip(1000, [:])])),
            // A picture whose spec says 0.5x is still one frame: never slowed.
            ("a picture asking for 0.5x", spec([pictureClip(500, ["speed": 0.5])])),
            ("a 1x video into a picture over a 1x tail", spec([
                clip("v", video, outMs: 1000),
                pictureClip(1000, ["transitionIn": ["kind": "dissolve", "from": clip("v", video, inMs: 1000, outMs: 1500),
                                                    "curves": ["alpha": [0.0, 1.0]]]]),
            ])),
            ("a 1x base under a 1x layer", spec([clip("v", video, outMs: 1500)], [
                "tracks": [["id": "pip", "z": 1, "opacity": 0.7, "startMs": 300, "clips": [
                    clip("w", other, inMs: 100, outMs: 1000, ["rect": ["x": 0.1, "y": 0.2, "w": 0.5, "h": 0.4]]),
                ]]],
            ])),
        ]
        for (label, options) in cases {
            let off = try await composed(options, .off)
            XCTAssertFalse(off.frames.isEmpty, label)
            for mode in [SlowMotionMode.blend, .flow] {
                let drawn = try await composed(options, mode)
                XCTAssertTrue(slowClips(drawn.built).isEmpty, "\(label) \(mode): nothing is slowed, nothing attached")
                assertSameFrames(drawn.frames, off.frames, "\(label) \(mode)")
            }
        }
    }

    // MARK: - b. A slowed clip: today's cadence, today's frames on a frame, the cross-fade between

    func testASlowedClipKeepsItsFramesAndTimesAndCrossFadesBetweenThem() async throws {
        let video = try await indexVideo("v.mp4", 30)
        let options = spec([clip("v", video, outMs: 1000, speed: 0.5)])
        let off = try await composed(options, .off)
        let blend = try await composed(options, .blend)
        XCTAssertTrue(slowClips(off.built).isEmpty, ".off attaches nothing")
        XCTAssertEqual(slowClips(blend.built).count, 1)

        // Today's cadence: 2 s of output at 30 fps, every frame where it was.
        XCTAssertEqual(off.frames.count, 60)
        XCTAssertEqual(blend.frames.map(\.seconds), off.frames.map(\.seconds))

        for k in 0..<60 {
            let s = Double(k) / 60   // where instant k falls in the source
            if k % 2 == 0 || k == 59 {
                // On a source frame (or held on the last one): the frame itself, and the very bytes the
                // composition's own frame has - the frame source converts colour exactly as the export does.
                XCTAssertEqual(index(off.frames[k]), min(29, k / 2), "off \(k)")
                XCTAssertTrue(blend.frames[k] == off.frames[k], "on-a-frame instant \(k) (s \(s)) differs by \(blend.frames[k].largestDifference(off.frames[k]))")
            } else {
                // Halfway between frames (k - 1) / 2 and (k + 1) / 2, which `.off` draws at k - 1 and k + 1.
                let a = off.frames[k - 1], b = off.frames[k + 1]
                XCTAssertTrue(blend.frames[k] != a, "in-between \(k) is not A")
                XCTAssertTrue(blend.frames[k] != b, "in-between \(k) is not B")
                XCTAssertLessThanOrEqual(distanceFromMix(blend.frames[k], a, b, 0.5), 1, "in-between \(k) is the cross-fade of its neighbours")
            }
        }
    }

    /// The same on-a-frame identity for a clip recorded turned - a quarter turn in its `preferredTransform`, as
    /// every portrait phone recording carries - and landscape, contained in a portrait render: the frame source
    /// hands over the STORED picture, as the composition does, and the orientation and the fit are applied after
    /// it to both alike.
    func testATurnedSlowedClipKeepsTodaysFramesOnAFrame() async throws {
        let video = try await TestMedia.frames(file("turned.mp4"), width: 128, height: 64, times: TestMedia.evenTimes(20),
                                               reorder: true, transform: CGAffineTransform(a: 0, b: 1, c: -1, d: 0, tx: 64, ty: 0)) {
            TestMedia.indexPicture($0, width: 128, height: 64)
        }
        let options = spec([TestSpecs.clip("v", video, outMs: 600, fit: "contain", ["speed": 0.5])])
        let off = try await composed(options, .off)
        let blend = try await composed(options, .blend)
        XCTAssertEqual(slowClips(blend.built).count, 1)
        XCTAssertEqual(blend.frames.map(\.seconds), off.frames.map(\.seconds))
        XCTAssertEqual(off.frames.count, 36)
        for k in stride(from: 0, to: 36, by: 2) {
            XCTAssertTrue(blend.frames[k] == off.frames[k], "on-a-frame instant \(k) differs by \(blend.frames[k].largestDifference(off.frames[k]))")
        }
        for k in stride(from: 1, to: 35, by: 2) {
            XCTAssertLessThanOrEqual(distanceFromMix(blend.frames[k], off.frames[k - 1], off.frames[k + 1], 0.5), 1, "instant \(k)")
        }
    }

    // MARK: - c. Layers and transition tails are slowed motion too

    func testASlowedLayerClipIsSynthesised() async throws {
        let base = try await indexVideo("base.mp4", 60)
        let layer = try await indexVideo("layer.mp4", 30)
        let options = spec([clip("base", base, outMs: 2000)], [
            "tracks": [["id": "pip", "z": 1, "startMs": 500, "clips": [
                clip("l", layer, outMs: 500, speed: 0.5, ["rect": ["x": 0.25, "y": 0.25, "w": 0.5, "h": 0.5]]),
            ]]],
        ])
        let off = try await composed(options, .off)
        let blend = try await composed(options, .blend)
        XCTAssertEqual(slowClips(blend.built).count, 1, "the layer's clip, and only it")
        XCTAssertEqual(blend.frames.map(\.seconds), off.frames.map(\.seconds))
        for k in 0..<off.frames.count {
            // The layer's own source time: it starts at 500 ms, at half speed. Its last own frame is 14
            // (frame 15 is at its out point), so from j = 28 on it holds frame 14 as the composition does.
            let j = k - 15
            let between = j >= 0 && j < 28 && j % 2 == 1
            if between {
                XCTAssertTrue(blend.frames[k] != off.frames[k], "the layer's in-between instant \(k) is invented")
                // Inside the layer's rectangle: the base under it is a 1x clip, a new frame at every instant.
                XCTAssertLessThanOrEqual(distanceFromMix(blend.frames[k], off.frames[k - 1], off.frames[k + 1], 0.5,
                                                         inside: (x: 32, y: 32, side: 64)), 1, "frame \(k)")
            } else {
                XCTAssertTrue(blend.frames[k] == off.frames[k], "frame \(k) differs by \(blend.frames[k].largestDifference(off.frames[k]))")
            }
        }
    }

    func testASlowedTransitionTailIsSynthesised() async throws {
        let outgoing = try await indexVideo("out.mp4", 60)
        let incoming = try await indexVideo("in.mp4", 30)
        let options = spec([
            clip("a", outgoing, outMs: 1000),
            // The outgoing clip's last half second at half speed, dissolved under the incoming clip for 1 s.
            clip("b", incoming, outMs: 1000, ["transitionIn": [
                "kind": "dissolve", "from": clip("a", outgoing, inMs: 1000, outMs: 1500, speed: 0.5),
                "curves": ["alpha": [0.0, 1.0]],
            ]]),
        ])
        let off = try await composed(options, .off)
        let blend = try await composed(options, .blend)
        let tails = blend.built.videoComposition.instructions.compactMap { ($0 as? EditInstruction)?.transition?.tail.slow }
        XCTAssertFalse(tails.isEmpty, "the tail carries its SlowClip")
        XCTAssertEqual(slowClips(blend.built).count, 1, "the tail, and only it")
        XCTAssertEqual(blend.frames.map(\.seconds), off.frames.map(\.seconds))
        var invented = 0
        for k in 0..<off.frames.count {
            let j = k - 30   // the window's own frames
            if j >= 0, j % 2 == 1, j < 28 {
                // The tail between two of its frames, under an incoming side that is the same in both modes.
                if blend.frames[k] != off.frames[k] { invented += 1 }
            } else {
                XCTAssertTrue(blend.frames[k] == off.frames[k], "frame \(k) differs by \(blend.frames[k].largestDifference(off.frames[k]))")
            }
        }
        // Late in the window the tail is almost faded out, and a mix at that weight can round to the same bytes.
        XCTAssertGreaterThanOrEqual(invented, 10, "in-between instants of the tail drawn from its own two frames")
    }

    // MARK: - d. Real timestamps

    /// Frame 9 lasts two frame durations. At 0.5x the four output instants across it are a quarter of the way
    /// apart on the SOURCE clock, so their weights are 0, 1/4, 1/2 and 3/4 - where an even-spacing assumption
    /// would have them jump between 0 and 1/2.
    func testTheWeightsFollowTheFramesRealTimes() async throws {
        let times = (0..<30).map { i in CMTime(value: CMTimeValue(i < 10 ? i : i + 1) * 20, timescale: 600) }
        let video = try await indexVideo("vfr.mp4", 30, times: times)
        let options = spec([clip("v", video, outMs: 1000, speed: 0.5)])
        let off = try await composed(options, .off)
        let blend = try await composed(options, .blend)
        // Frame 9 is at 0.3 s, instant 18; frame 10 at 0.3667 s, instant 22.
        XCTAssertEqual(index(off.frames[18]), 9)
        XCTAssertEqual(index(off.frames[22]), 10)
        XCTAssertTrue(blend.frames[18] == off.frames[18])
        XCTAssertTrue(blend.frames[22] == off.frames[22])
        for (k, weight) in [(19, 0.25), (20, 0.5), (21, 0.75)] {
            XCTAssertLessThanOrEqual(distanceFromMix(blend.frames[k], off.frames[18], off.frames[22], weight), 1,
                                     "instant \(k) is \(weight) of the way from frame 9 to frame 10")
        }
    }

    // MARK: - e. Only the clip's own frames

    /// An in point between frames 1 and 2 and an out point between frames 17 and 18: the instants before frame 2
    /// hold frame 2 - the composition shows frame 1 there, which the customer trimmed away - and the instants
    /// after frame 17 hold frame 17, with frame 18 never mixed in.
    func testTheClipsOwnFramesAloneAreDrawnAndHeldAtBothEnds() async throws {
        let video = try await indexVideo("v.mp4", 30)
        let options = spec([clip("v", video, inMs: 50, outMs: 590, speed: 0.5)])
        let off = try await composed(options, .off)
        let blend = try await composed(options, .blend)
        XCTAssertEqual(off.frames.count, 33)
        XCTAssertEqual(blend.frames.map(\.seconds), off.frames.map(\.seconds))

        XCTAssertEqual(index(off.frames[0]), 1, "the composition's frame at the in point is the trimmed-away frame 1")
        XCTAssertEqual(index(blend.frames[0]), 2, "held on the clip's first own frame")
        XCTAssertEqual(blend.frames[0].bgra, blend.frames[1].bgra, "instant 0 is frame 2 alone, as instant 1 is")

        XCTAssertEqual(index(blend.frames[31]), 17)
        XCTAssertEqual(blend.frames[32].bgra, blend.frames[31].bgra, "after its last own frame the clip holds it: frame 18 never contributes")
        XCTAssertTrue(blend.frames[32] == off.frames[32])
    }

    // MARK: - f. A frame source that fails

    func testAFrameSourceThatFailsDrawsTodaysFramesAndTheExportSucceeds() async throws {
        let video = try await indexVideo("v.mp4", 30)
        let options = spec([clip("v", video, outMs: 1000, speed: 0.5)])
        let off = try await composed(options, .off)
        for mode in [SlowMotionMode.blend, .flow] {
            let failed = try await composed(options, mode) { $0.plan.slowMotionFaults.failsDecoders = true }
            XCTAssertEqual(slowClips(failed.built).count, 1)
            assertSameFrames(failed.frames, off.frames, "\(mode) with its decoder failing")
        }

        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let built = try await CompositionBuilder.build(spec)
        built.plan.slowMotionFaults.failsDecoders = true
        let out = file("failed.mp4")
        let result = try await Exporter.export(built, to: out, tmpDir: JobFolders.exportTmp(spec.batchId), spec: spec,
                                               onProgress: { _ in })
        XCTAssertLessThanOrEqual(abs(result.durationMs - 2000), 40)
        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(probed.width, Self.side)
    }

    // MARK: - g. The fallback engine draws slow motion too

    /// `AVAssetExportSession` builds its own compositor from the same video composition, so a slowed clip is
    /// drawn through the same path: read back off the file it wrote, every in-between frame's grey is halfway
    /// between its neighbours', where `.off` repeats each frame.
    func testTheExportSessionEngineDrawsASlowedClipsInBetweenFrames() async throws {
        let video = try await indexVideo("v.mp4", 30)
        let options = spec([clip("v", video, outMs: 1000, speed: 0.5)])

        func greys(_ mode: SlowMotionMode) async throws -> [Double] {
            let spec = try TestCalls.parse(options)
            try JobFolders.ensure(JobFolders.root)
            try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
            defer { JobFolders.cleanup(batchId: spec.batchId) }
            let built = try await CompositionBuilder.build(spec, slowMotion: mode)
            let out = file("preset-\(mode).mp4")
            try await PresetEngine.encode(built, to: out, tmpDir: JobFolders.exportTmp(spec.batchId), spec: spec,
                                          onProgress: { _ in })
            return try await decodedGreys(out)
        }
        let off = try await greys(.off)
        let blend = try await greys(.blend)
        XCTAssertEqual(off.count, 60)
        XCTAssertEqual(blend.count, 60)
        for k in stride(from: 1, to: 57, by: 2) {
            // `.off` repeats: the in-between instant is the frame before it.
            XCTAssertEqual(off[k], off[k - 1], accuracy: 3, "off \(k) repeats")
            let middle = (blend[k - 1] + blend[k + 1]) / 2
            XCTAssertEqual(blend[k], middle, accuracy: 3, "blend \(k) is halfway between its neighbours")
            XCTAssertGreaterThan(abs(blend[k] - blend[k - 1]), 6, "blend \(k) is not a repeat")
        }
    }

    /// The bottom half's mean green, frame by frame, off an encoded file.
    func decodedGreys(_ url: URL) async throws -> [Double] {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: [
            kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        ])
        reader.add(output)
        XCTAssertTrue(reader.startReading())
        var greys: [Double] = []
        while let sample = output.copyNextSampleBuffer() {
            guard let buffer = CMSampleBufferGetImageBuffer(sample) else { continue }
            let w = CVPixelBufferGetWidth(buffer), h = CVPixelBufferGetHeight(buffer)
            let frame = ComposedFrame(seconds: 0, width: w, height: h, bgra: TestComposed.bgra(buffer))
            greys.append(frame.mean(x: w / 4, y: h * 5 / 8, w: w / 2, h: h / 4))
        }
        return greys
    }

    // MARK: - h. The optical flow, end to end

    /// A textured square moving 16 pixels a frame over a textured background, slowed to 0.5x. Halfway between two
    /// frames the flow draws ONE square halfway along, where the cross-fade draws two at half strength - held
    /// against a second file that really has the square halfway, drawn by the unslowed engine. And a flow that
    /// fails for every pair draws the cross-fade, byte for byte.
    func testTheFlowDrawsOneSquareHalfwayAndFallsBackToTheCrossFade() async throws {
        let background = Picture.texture(1, Self.side, Self.side, 4, 0, 130)
        let patch = Picture.texture(2, 32, 32, 4, 150, 255)
        func scene(_ left: Int) -> [UInt8] {
            var picture = background
            picture.draw(patch, x: left, y: 48)
            return picture.rgba
        }
        let moving = try await TestMedia.frames(file("moving.mp4"), width: Self.side, height: Self.side,
                                                times: TestMedia.evenTimes(6), bitrate: 20_000_000) { scene(8 + 16 * $0) }
        let truth = try await TestMedia.frames(file("truth.mp4"), width: Self.side, height: Self.side,
                                               times: TestMedia.evenTimes(12), bitrate: 20_000_000) { scene(8 + 8 * $0) }
        let slowed = spec([clip("m", moving, outMs: 200, speed: 0.5)])
        let flow = try await composed(slowed, .flow)
        let blend = try await composed(slowed, .blend)
        let real = try await composed(spec([clip("t", truth, outMs: 400)]), .off)
        XCTAssertEqual(flow.frames.count, 12)
        XCTAssertEqual(real.frames.count, 12)

        func meanDifference(_ a: ComposedFrame, _ b: ComposedFrame, x: Int, y: Int, w: Int, h: Int) -> Double {
            var sum = 0
            for yy in y..<(y + h) {
                for xx in x..<(x + w) {
                    for c in 0..<3 { sum += abs(Int(a.bgra[(yy * a.width + xx) * 4 + c]) - Int(b.bgra[(yy * b.width + xx) * 4 + c])) }
                }
            }
            return Double(sum) / Double(w * h * 3)
        }
        for k in [1, 3, 5, 7, 9] {
            let left = 8 + 8 * k   // where the square really is at instant k
            let flowError = meanDifference(flow.frames[k], real.frames[k], x: 0, y: 0, w: Self.side, h: Self.side)
            let blendError = meanDifference(blend.frames[k], real.frames[k], x: 0, y: 0, w: Self.side, h: Self.side)
            // The strip the square has LEFT by halfway, and the strip it has not reached yet: background in the
            // truth, background in the flow's frame, half a square in the cross-fade's.
            let behind = (x: left - 7, y: 50, w: 6, h: 28)
            let ahead = (x: left + 33, y: 50, w: 6, h: 28)
            let flowBehind = meanDifference(flow.frames[k], real.frames[k], x: behind.x, y: behind.y, w: behind.w, h: behind.h)
            let blendBehind = meanDifference(blend.frames[k], real.frames[k], x: behind.x, y: behind.y, w: behind.w, h: behind.h)
            let flowAhead = meanDifference(flow.frames[k], real.frames[k], x: ahead.x, y: ahead.y, w: ahead.w, h: ahead.h)
            let blendAhead = meanDifference(blend.frames[k], real.frames[k], x: ahead.x, y: ahead.y, w: ahead.w, h: ahead.h)
            print(String(format: "[flow] instant %d: whole %.2f vs cross-fade %.2f; behind %.2f vs %.2f; ahead %.2f vs %.2f",
                         k, flowError, blendError, flowBehind, blendBehind, flowAhead, blendAhead))
            // 0.5 rather than the 0.4 `FlowEstimatorTests` holds uncompressed pictures to: both files went through
            // H.264 here, which adds its own error to the flow's frame and the truth's alike. The strips below
            // are what tell one square from two.
            XCTAssertLessThan(flowError, blendError * 0.5, "instant \(k): the flow against the truth, and the cross-fade")
            XCTAssertLessThan(flowBehind, 10, "instant \(k): the square has left this strip")
            XCTAssertGreaterThan(blendBehind, 25, "instant \(k): the cross-fade still has half a square there")
            XCTAssertLessThan(flowAhead, 10, "instant \(k): the square has not reached this strip")
            XCTAssertGreaterThan(blendAhead, 25, "instant \(k): the cross-fade already has half a square there")
        }
        // On a source frame the flow draws the frame itself, as the cross-fade does.
        for k in [0, 2, 4, 6, 8, 10, 11] { XCTAssertTrue(flow.frames[k] == blend.frames[k], "instant \(k)") }

        let failing = try await composed(slowed, .flow) { $0.plan.slowMotionFaults.failsFlows = true }
        assertSameFrames(failing.frames, blend.frames, "a flow that fails for every pair")
    }
}
