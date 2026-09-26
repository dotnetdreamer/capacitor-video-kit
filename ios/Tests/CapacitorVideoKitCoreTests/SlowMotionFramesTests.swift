@preconcurrency import AVFoundation
import CoreImage
import CoreVideo
import Metal
import XCTest
@testable import CapacitorVideoKitCore

/// A slowed clip's frame source, on files written here: its REAL frame times (`ClipFrameListing`), the right
/// decoded picture for each of them (`ClipFrameDecoder`), and the cross-fade of two (`FrameBlend`).
///
/// Every frame of the media carries its own index as bit stripes (`TestMedia.indexPicture`), so a picture a
/// frame out cannot pass. Two files: one at a constant 30 fps with B-FRAMES, which decodes out of presentation
/// order and may carry an edit list; one at a VARIABLE rate - frame 9 on screen for two frame durations, frames
/// from 40 on 0.37 of a frame late, and a 0/4/8 ms jitter from 60 - which is what a phone in low light records.
final class SlowMotionFramesTests: RenderTestCase {

    static let width = 128, height = 64

    /// The VFR file's frame times, in a 90 kHz timescale so every one of them is exact.
    static let vfrTimes: [CMTime] = (0..<90).map { i in
        var frames = Double(i)
        if i >= 10 { frames += 1 }            // frame 9 lasts two durations
        if i >= 40 { frames += 0.37 }         // a late frame, and everything after it
        var seconds = frames / 30
        if i >= 60 { seconds += 0.004 * Double(i % 3) }
        return CMTime(value: CMTimeValue((seconds * 90_000).rounded()), timescale: 90_000)
    }

    struct Opened {
        let asset: AVURLAsset
        let track: AVAssetTrack
        let range: CMTimeRange
        let segments: [AVAssetTrackSegment]
        let cursors: Bool
        let written: [CMTime]
    }

    func cfr() async throws -> Opened {
        let times = TestMedia.evenTimes(90)
        let url = try await TestMedia.frames(file("cfr.mp4"), width: Self.width, height: Self.height, times: times,
                                             reorder: true) { TestMedia.indexPicture($0, width: Self.width, height: Self.height) }
        return try await open(url, written: times)
    }

    func vfr() async throws -> Opened {
        let url = try await TestMedia.frames(file("vfr.mp4"), width: Self.width, height: Self.height, times: Self.vfrTimes,
                                             reorder: true) { TestMedia.indexPicture($0, width: Self.width, height: Self.height) }
        return try await open(url, written: Self.vfrTimes)
    }

    /// Opened the way the builder opens a file, with what `SlowClipSources` loads for a slowed one.
    func open(_ url: URL, written: [CMTime]) async throws -> Opened {
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let (range, segments, cursors) = try await track.load(.timeRange, .segments, .canProvideSampleCursors)
        return Opened(asset: asset, track: track, range: range, segments: segments, cursors: cursors, written: written)
    }

    func window(_ a: Double, _ b: Double) -> CMTimeRange {
        CMTimeRange(start: CMTime(seconds: a, preferredTimescale: 600_000), end: CMTime(seconds: b, preferredTimescale: 600_000))
    }

    func list(_ o: Opened, _ w: CMTimeRange, cursors: Bool) throws -> ClipFrameTimes {
        try ClipFrameListing.frames(of: o.track, in: o.asset, segments: o.segments, window: w, cursors: cursors)
    }

    /// The one-clip composition `SlowClipSources` makes for the file.
    func composition(_ o: Opened) async throws -> ClipFrameComposition {
        let (size, fps) = try await o.track.load(.naturalSize, .nominalFrameRate)
        return try ClipFrameComposition(asset: o.asset, track: o.track, trackRange: o.range, naturalSize: size,
                                        nominalFrameRate: fps, colorPrimaries: OutputColor.primaries,
                                        transferFunction: OutputColor.transferFunction,
                                        yCbCrMatrix: OutputColor.yCbCrMatrix)
    }

    func decoder(_ o: Opened, window w: CMTimeRange) async throws -> (ClipFrameDecoder, ClipFrameTimes) {
        let times = try list(o, w, cursors: o.cursors)
        return (ClipFrameDecoder(source: try await composition(o), frames: times, end: w.end), times)
    }

    func index(_ buffer: CVPixelBuffer) -> Int {
        TestMedia.indexOf(TestComposed.bgra(buffer), width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer))
    }

    // MARK: - The listing

    /// The whole file, through a sample cursor and through a compressed read: the same CMTimes, and the times the
    /// file was WRITTEN with, in presentation order, on the track's timeline - edit list or no edit list.
    func testTheListIsTheWrittenTimesOnBothRoutes() async throws {
        for o in [try await cfr(), try await vfr()] {
            XCTAssertTrue(o.cursors, "a file AVAssetWriter wrote can provide sample cursors")
            let viaCursor = try list(o, window(0, 1000), cursors: true)
            let viaReader = try list(o, window(0, 1000), cursors: false)
            XCTAssertEqual(viaCursor.count, 90)
            XCTAssertEqual(viaReader.stamps, viaCursor.stamps, "the two routes list the same CMTimes")
            for (got, want) in zip(viaCursor.seconds, o.written.map(\.seconds)) { XCTAssertEqual(got, want, accuracy: 1e-6) }
            XCTAssertEqual(viaCursor.seconds, SlowMotion.frameTimes(viaCursor.seconds))
            XCTAssertEqual(viaCursor.seconds, viaCursor.stamps.map(\.seconds))
            print("[frames] segments: \(o.segments.map { "media \($0.timeMapping.source.start.seconds) -> track \($0.timeMapping.target.start.seconds)" })")
            // Where the file has an edit list, the cursor itself answers in MEDIA time, before it: the mapping
            // above is what put the list on the track's timeline.
            if let map = o.segments.first?.timeMapping, map.source.start != map.target.start {
                let raw = try XCTUnwrap(o.track.makeSampleCursor(presentationTimeStamp: .zero)).presentationTimeStamp
                XCTAssertNotEqual(raw.seconds, viaCursor.seconds[0], accuracy: 1e-6)
            }
        }
    }

    /// The irregular times really are irregular in the file: a real-PTS list, not an even grid.
    func testTheVariableRateFileKeepsItsIrregularTimes() async throws {
        let t = try list(try await vfr(), window(0, 1000), cursors: true).seconds
        XCTAssertEqual(t[10] - t[9], 2.0 / 30, accuracy: 2e-5)
        XCTAssertEqual(t[40] - t[39], 1.37 / 30, accuracy: 2e-5)
        XCTAssertEqual((t[62] - t[61]) - (t[63] - t[62]), 0.012, accuracy: 2e-5)
    }

    /// A window cut mid-GOP and between frames: the frame covering the in point, then every frame before the out
    /// point, the same through both routes.
    func testAWindowIsCutToTheFrameCoveringTheInPointAndThoseBeforeTheOutPoint() async throws {
        for o in [try await cfr(), try await vfr()] {
            let all = try list(o, window(0, 1000), cursors: true).seconds
            for (a, b) in [(1.41, 1.69), (1.4, 1.7), (0, 0.2), (2.9, 3.5), (0.31, 0.32)] {
                let w = window(a, b)
                let c = try list(o, w, cursors: true)
                let r = try list(o, w, cursors: false)
                XCTAssertEqual(c.stamps, r.stamps, "[\(a), \(b)) both routes")
                let first = try XCTUnwrap(all.lastIndex { $0 <= a + 1e-6 })
                let last = (all.firstIndex { $0 >= b } ?? all.count) - 1
                XCTAssertEqual(c.seconds, Array(all[first...last]), "[\(a), \(b))")
            }
        }
    }

    /// The merge rule, on CMTimes: within 1e-6 s of the last KEPT one is the same frame; the first is kept.
    func testTimesWithinAMicrosecondAreOneFrame() {
        let s = { (x: Double) in CMTime(seconds: x, preferredTimescale: 1_000_000_000) }
        let got = ClipFrameListing.cut([s(0.1), s(0.0), s(0.0000005), s(0.0000009), s(0.0000015), s(0.2), .invalid, s(0.1000004)],
                                       to: window(0, 1))
        XCTAssertEqual(got.seconds, SlowMotion.frameTimes([0.1, 0.0, 0.0000005, 0.0000009, 0.0000015, 0.2, .nan, 0.1000004]))
        XCTAssertEqual(got.seconds, [0.0, 0.0000015, 0.1, 0.2])
        XCTAssertEqual(got.stamps.map(\.seconds), got.seconds)
    }

    func testAWindowWithNoFrameBeforeItsOutPointThrows() async throws {
        let o = try await cfr()
        for cursors in [true, false] {
            XCTAssertThrowsError(try list(o, CMTimeRange(start: .zero, duration: .zero), cursors: cursors)) {
                guard case ClipFrameError.noFrames = $0 else { return XCTFail("\($0)") }
            }
        }
    }

    // MARK: - The decoder

    /// Forward over the whole file: every index is its own picture, one reader, each frame decoded once.
    func testReadingForwardAnswersEveryFrameWithItsOwnPicture() async throws {
        for o in [try await cfr(), try await vfr()] {
            let (d, times) = try await decoder(o, window: window(0, 1000))
            for i in 0..<times.count { XCTAssertEqual(index(try d.frame(i)), i, "frame \(i)") }
            XCTAssertEqual(d.starts, 1, "one reader for a forward pass")
            XCTAssertLessThanOrEqual(d.decoded, times.count + 1, "each frame decoded once")
        }
    }

    /// The access pattern of a clip slowed to 0.3x: each output frame asks for A, then B when it is drawn.
    func testASlowedClipsAccessPatternReadsEachFrameOnce() async throws {
        for o in [try await cfr(), try await vfr()] {
            let w = window(0.5, 2.5)
            let (d, times) = try await decoder(o, window: w)
            let fileTimes = o.written.map(\.seconds)
            func fileIndex(_ t: Double) -> Int { fileTimes.firstIndex { abs($0 - t) < 1e-6 }! }
            var asked = 0
            for k in 0..<200 {
                let s = 0.5 + Double(k) / 30 * 0.3
                let pair = try XCTUnwrap(SlowMotion.framePairAt(times.seconds, seconds: s, window: SourceWindow(from: 0.5, to: 2.5)))
                XCTAssertEqual(index(try d.frame(pair.a)), fileIndex(times.seconds[pair.a]))
                if let b = pair.b, pair.weight > 0 { XCTAssertEqual(index(try d.frame(b)), fileIndex(times.seconds[b])) }
                asked += 1
            }
            XCTAssertEqual(d.starts, 1)
            // Every listed frame at most once, plus the picture a reader restamps to its start and is skipped.
            XCTAssertLessThanOrEqual(d.decoded, times.count + 1)
            XCTAssertEqual(asked, 200)
        }
    }

    func testAnEarlierFrameStartsAFreshReaderAndALaterOneDoesNot() async throws {
        let (d, _) = try await decoder(try await vfr(), window: window(0, 1000))
        XCTAssertEqual(index(try d.frame(50)), 50)
        XCTAssertEqual(index(try d.frame(51)), 51)
        XCTAssertEqual(d.starts, 1)
        XCTAssertEqual(index(try d.frame(50)), 50, "held: no restart")
        XCTAssertEqual(d.starts, 1)
        XCTAssertEqual(index(try d.frame(20)), 20, "earlier: restart")
        XCTAssertEqual(d.starts, 2)
        XCTAssertEqual(index(try d.frame(9)), 9, "earlier again, onto the frame that lasts two durations")
        XCTAssertEqual(index(try d.frame(10)), 10)
        XCTAssertEqual(d.starts, 3)
        XCTAssertEqual(index(try d.frame(0)), 0, "the file's first frame")
        XCTAssertEqual(index(try d.frame(89)), 89, "forward to the last")
        XCTAssertEqual(d.starts, 4)
        d.release()
        XCTAssertEqual(index(try d.frame(89)), 89, "after a release")
        XCTAssertEqual(d.starts, 5)
    }

    /// A window starting between frames: index 0 is the frame covering the in point (not the clip's own), index 1
    /// its first own frame.
    func testAWindowStartingBetweenFramesListsTheFrameCoveringItFirst() async throws {
        let (d, times) = try await decoder(try await cfr(), window: window(1.41, 1.69))
        XCTAssertEqual(times.count, 9)
        XCTAssertEqual(index(try d.frame(1)), 43)
        XCTAssertEqual(index(try d.frame(0)), 42)
        XCTAssertEqual(index(try d.frame(8)), 50)
    }

    /// A listed frame the file does not have throws rather than answering a neighbour, and so does an index the
    /// list does not have: a bug costs the clip its frames, never the app.
    func testAFrameTheFileDoesNotHaveThrows() async throws {
        let o = try await cfr()
        let (_, listed) = try await decoder(o, window: window(0, 1))
        var stamps = listed.stamps
        stamps.insert(CMTime(value: 1, timescale: 60), at: 1)   // between frames 0 and 1
        let broken = ClipFrameTimes(seconds: stamps.map(\.seconds), stamps: stamps)
        let d = ClipFrameDecoder(source: try await composition(o), frames: broken, end: CMTime(value: 1, timescale: 1))
        XCTAssertEqual(index(try d.frame(0)), 0)
        XCTAssertThrowsError(try d.frame(1))
        XCTAssertThrowsError(try d.frame(99))
        XCTAssertThrowsError(try d.frame(-1))
    }

    // MARK: - Tracks with empty edits

    /// A file whose video starts 0.2 s into its timeline, which is what a phone or ffmpeg writes when the video
    /// starts after the sound: an EMPTY edit from 0 to 0.2, then the media. An untrimmed clip of it starts at 0,
    /// before its first frame, and so does the reader for that frame - a millisecond before it, inside the empty
    /// edit, where the one-clip composition has no source frame to compose. That instant must not fail the
    /// reader: before `ClipFramePassthrough` answered it with a blank, frame 0 threw and the whole slowed clip
    /// went back to repeated frames.
    func testAFileWhoseVideoStartsLateIsReadFromItsFirstFrame() async throws {
        let times = (0..<36).map { CMTime(value: CMTimeValue(120 + 20 * $0), timescale: 600) }
        let url = try await TestMedia.frames(file("late.mp4"), width: Self.width, height: Self.height, times: times,
                                             reorder: true, sessionStart: .zero) {
            TestMedia.indexPicture($0, width: Self.width, height: Self.height)
        }
        let o = try await open(url, written: times)
        let first = try XCTUnwrap(o.segments.first)
        XCTAssertTrue(first.isEmpty, "the file starts with an empty edit")
        XCTAssertEqual(first.timeMapping.target.duration.seconds, 0.2, accuracy: 1e-6)

        // The whole file from zero, as an untrimmed clip plays it.
        let w = window(0, 1.4)
        let (d, listed) = try await decoder(o, window: w)
        XCTAssertEqual(listed.count, 36)
        XCTAssertEqual(listed.seconds[0], 0.2, accuracy: 1e-6, "the first frame is the file's first, at 0.2")
        for i in 0..<listed.count { XCTAssertEqual(index(try d.frame(i)), i, "frame \(i)") }
        XCTAssertEqual(d.starts, 1, "one reader, through the empty edit's blank")

        // And through the compositor's state, as an export draws the clip at 0.5x from in point 0: every instant
        // has a picture, the ones before the first frame hold it (the web's hold-first rule), and none of them
        // marks the clip failed.
        let clip = SlowClip(frames: listed, source: try await composition(o), inserted: w,
                            placed: CMTimeRange(start: .zero, duration: CMTime(value: 2800, timescale: 1000)))
        let state = SlowMotionState(device: MTLCreateSystemDefaultDevice())
        let faults = SlowMotionTestFaults()
        let ci = EditCompositor.context(on: MTLCreateSystemDefaultDevice())
        for k in 0..<84 {
            let t = CMTime(value: CMTimeValue(k), timescale: 30)
            let picture = try XCTUnwrap(state.picture(of: clip, at: t, mode: .blend, grade: .identity, faults: faults),
                                        "instant \(k)")
            if k < 12 {
                let out = try XCTUnwrap(TestPixels.buffer(width: Self.width, height: Self.height))
                ci.render(picture, to: out, bounds: CGRect(x: 0, y: 0, width: Self.width, height: Self.height), colorSpace: nil)
                XCTAssertEqual(index(out), 0, "instant \(k), before the first frame, holds it")
            }
        }
        XCTAssertEqual(state.liveCount, 1, "the clip is live, not failed")
    }

    /// An empty edit in the MIDDLE of a track - a file cut and rejoined with a gap, 1.0 to 1.5 s here - is read
    /// across in one pass: the reader composes blanks through the gap, which are no listed frame's and are
    /// skipped, and every frame after it arrives at its own time.
    func testReadingAcrossAnEmptyEditInTheMiddleDeliversEveryFrame() async throws {
        let o = try await cfr()
        let second = { (x: Double) in CMTime(value: CMTimeValue(x * 600), timescale: 600) }
        let comp = AVMutableComposition()
        let track = try XCTUnwrap(comp.addMutableTrack(withMediaType: .video, preferredTrackID: kCMPersistentTrackID_Invalid))
        try track.insertTimeRange(CMTimeRange(start: .zero, end: second(1)), of: o.track, at: .zero)
        try track.insertTimeRange(CMTimeRange(start: second(1), end: second(2)), of: o.track, at: second(1.5))
        let url = file("gap.mov")
        try? FileManager.default.removeItem(at: url)
        let session = try XCTUnwrap(AVAssetExportSession(asset: comp, presetName: AVAssetExportPresetPassthrough))
        try await session.export(to: url, as: .mov)
        let gap = try await open(url, written: [])
        XCTAssertTrue(gap.segments.contains { $0.isEmpty && abs($0.timeMapping.target.start.seconds - 1) < 1e-3 },
                      "the file keeps its empty edit at 1.0")

        let (d, listed) = try await decoder(gap, window: window(0.1, 2.4))
        XCTAssertFalse(listed.seconds.contains { $0 > 1 + 1e-6 && $0 < 1.5 - 1e-6 }, "no frame inside the gap")
        XCTAssertTrue(listed.seconds.contains { abs($0 - 1.5) < 1e-6 }, "frame 30 at 1.5, after the gap")
        for i in 0..<listed.count {
            // Frames 3... up to 29 before the gap, then 30... shifted by the gap's half second.
            let s = listed.seconds[i]
            let want = Int(((s < 1.25 ? s : s - 0.5) * 30).rounded())
            XCTAssertEqual(index(try d.frame(i)), want, "frame \(i) at \(s)")
        }
        XCTAssertEqual(d.starts, 1, "one reader across the gap")
    }

    // MARK: - The frames are the compositor's frames

    /// The frame source's pixels equal the frames EditCompositor is handed only while both compositors ask
    /// AVFoundation for the same thing: one `CompositorSourceFormat`, and the export's colour triple
    /// (`OutputColor`) on the one-clip composition. Changing EditCompositor's answers alone - HDR frames on, a
    /// different pixel format - would leave every SDR test byte-identical and turn a slowed HLG clip's colours.
    func testTheFrameSourceAsksForTheCompositorsSourceFormat() async throws {
        let edit = EditCompositor(), passthrough = ClipFramePassthrough()
        func same(_ a: [String: any Sendable]?, _ b: [String: any Sendable]?) -> Bool {
            NSDictionary(dictionary: a ?? [:]).isEqual(to: b ?? [:])
        }
        XCTAssertTrue(same(passthrough.sourcePixelBufferAttributes, edit.sourcePixelBufferAttributes))
        XCTAssertTrue(same(passthrough.requiredPixelBufferAttributesForRenderContext,
                           edit.requiredPixelBufferAttributesForRenderContext))
        XCTAssertEqual(passthrough.supportsHDRSourceFrames, edit.supportsHDRSourceFrames)
        XCTAssertEqual(passthrough.supportsWideColorSourceFrames, edit.supportsWideColorSourceFrames)

        let vc = try await composition(try await cfr()).videoComposition
        XCTAssertEqual(vc.colorPrimaries, OutputColor.primaries)
        XCTAssertEqual(vc.colorTransferFunction, OutputColor.transferFunction)
        XCTAssertEqual(vc.colorYCbCrMatrix, OutputColor.yCbCrMatrix)
    }

    // MARK: - The cross-fade

    /// `FrameBlend.mix` through the compositor's own context, rendered the way the compositor renders: every
    /// (a, b) pair of 8-bit values per channel comes out correctly rounded - within 0.5 of A (1 - w) + B w, which
    /// leaves only which way an exact .5 tie goes - at the everyday weights and at the smallest one ever drawn,
    /// where CIDissolveTransition strays to 0.524.
    func testTheCrossFadeIsCorrectlyRoundedForEveryPairOfValues() throws {
        let ci = EditCompositor.context(on: MTLCreateSystemDefaultDevice())
        let n = 256
        func buffer(_ fill: (Int, Int) -> (UInt8, UInt8, UInt8)) throws -> CVPixelBuffer {
            var rgba = [UInt8](repeating: 255, count: n * n * 4)
            for y in 0..<n {
                for x in 0..<n {
                    let (r, g, b) = fill(x, y)
                    rgba[(y * n + x) * 4] = r; rgba[(y * n + x) * 4 + 1] = g; rgba[(y * n + x) * 4 + 2] = b
                }
            }
            return try XCTUnwrap(TestPixels.buffer(rgba: rgba, width: n, height: n))
        }
        let a = try buffer { x, y in (UInt8(x), UInt8(y), UInt8((x + y) & 255)) }
        let b = try buffer { x, y in (UInt8(y), UInt8(x), UInt8(x)) }
        let pa = TestPixels.rgba(a), pb = TestPixels.rgba(b)
        func image(_ p: CVPixelBuffer) -> CIImage { CIImage(cvPixelBuffer: p, options: [.colorSpace: NSNull()]) }
        for w in [0.25, 0.5, 0.75, 1.0 / 512 + 1e-4, 0.3, 1.0 / 3, 0.9, 0.999] {
            let out = try XCTUnwrap(TestPixels.buffer(width: n, height: n))
            ci.render(FrameBlend.mix(image(a), image(b), weight: w), to: out, bounds: CGRect(x: 0, y: 0, width: n, height: n),
                      colorSpace: nil)
            let po = TestPixels.rgba(out)
            var worst = 0.0
            for i in 0..<po.count where i % 4 != 3 {
                worst = max(worst, abs(Double(po[i]) - ((1 - w) * Double(pa[i]) + w * Double(pb[i]))))
            }
            XCTAssertLessThanOrEqual(worst, 0.5 + 1e-9, "w \(w)")
        }
        // The end points are the frames themselves, byte for byte, and the extent is A's.
        for (w, frame) in [(0.0, pa), (1.0, pb)] {
            let out = try XCTUnwrap(TestPixels.buffer(width: n, height: n))
            ci.render(FrameBlend.mix(image(a), image(b), weight: w), to: out, bounds: CGRect(x: 0, y: 0, width: n, height: n),
                      colorSpace: nil)
            XCTAssertEqual(TestPixels.rgba(out), frame, "w \(w)")
        }
        XCTAssertEqual(FrameBlend.mix(image(a), image(b), weight: 0.5).extent, image(a).extent)
    }
}
