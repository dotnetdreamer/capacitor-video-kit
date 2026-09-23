@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// Naming the clip a failure during the encode belongs to, which Android does with `blameClip` and
/// this engine used never to do at all.
final class ExportBlameTests: RenderTestCase {

    /// Three base clips at three speeds: 0...2 s at 1x, then 2 s of source at 2x (2...3 s), then
    /// 1 s at 0.5x (3...5 s), and a tail to 8 s.
    private func spec() throws -> ComposeSpec {
        try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("a", file("a.mp4"), outMs: 2000),
            TestSpecs.clip("b", file("b.mp4"), inMs: 1000, outMs: 3000, ["speed": 2]),
            TestSpecs.clip("c", file("c.mp4"), outMs: 1000, ["speed": 0.5]),
        ], ["durationMs": 8000]))
    }

    func testTheLastFrameIsMappedOntoTheBaseTimeline() throws {
        let spec = try spec()
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: 0, in: spec), "a")
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: 1_999_999, in: spec), "a")
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: 2_000_000, in: spec), "b")
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: 2_999_999, in: spec), "b")
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: 3_000_000, in: spec), "c")
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: 4_999_999, in: spec), "c")
        // Past the footage, in the tail, the last clip, as on Android.
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: 7_000_000, in: spec), "c")
    }

    func testNoFrameYetBlamesTheFirstClip() throws {
        XCTAssertEqual(ErrorMapping.blamedClip(atUs: nil, in: try spec()), "a")
    }

    func testAnUnreadableInputDuringTheEncodeCarriesTheClipKey() throws {
        let spec = try spec()
        let cursor = FrameCursor()
        cursor.record(2_500_000)

        let failure = ErrorMapping.exportFailure(for: AVError(.decodeFailed), cursor: cursor, spec: spec)
        XCTAssertEqual(failure.code, .unreadableInput)
        XCTAssertEqual(failure.clipKey, "b")
        XCTAssertEqual(failure.json(jobId: "j")["clipKey"] as? String, "b")
    }

    func testOnlyAnUnreadableInputIsBlamed() throws {
        let spec = try spec()
        let cursor = FrameCursor()
        cursor.record(2_500_000)

        // The encoder turning a frame down is the device's fault and not the clip's, and a cancel is
        // nobody's.
        let encoder = ErrorMapping.exportFailure(for: AVError(.encodeFailed), cursor: cursor, spec: spec)
        XCTAssertEqual(encoder.code, .encoder)
        XCTAssertNil(encoder.clipKey)
        XCTAssertNil(encoder.json(jobId: "j")["clipKey"])

        let cancelled = ErrorMapping.exportFailure(for: CancellationError(), cursor: cursor, spec: spec)
        XCTAssertEqual(cancelled.code, .cancelled)
        XCTAssertNil(cancelled.clipKey)
    }

    func testAKeyTheErrorAlreadyCarriesIsKept() throws {
        let cursor = FrameCursor()
        cursor.record(2_500_000)
        let failure = ErrorMapping.exportFailure(for: BuildError.unreadable("music", "no audio track"),
                                                 cursor: cursor, spec: try spec())
        XCTAssertEqual(failure.clipKey, "music")
    }

    func testTheCompositorRecordsHowFarTheRenderGot() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let options = TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 1000)])
        let spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let built = try await CompositionBuilder.build(spec)
        XCTAssertNil(built.plan.cursor.us)

        _ = try await Exporter.export(built, to: file("out.mp4"), tmpDir: JobFolders.exportTmp(spec.batchId),
                                      spec: spec) { _ in }
        // The last frame of a one second render at 30 fps starts a frame before its end.
        let last = try XCTUnwrap(built.plan.cursor.us)
        XCTAssertEqual(Double(last), 1_000_000 - 1_000_000.0 / 30, accuracy: 1_000)
    }
}
