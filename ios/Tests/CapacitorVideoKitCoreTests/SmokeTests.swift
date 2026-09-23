import XCTest
@testable import CapacitorVideoKitCore

/// The harness itself: that a spec parses, that a render runs end to end on the simulator, that a
/// pixel read back off the result is the colour that went in, and that a source with sound can be
/// written at any length a test needs.
final class SmokeTests: RenderTestCase {

    func testParsesAMinimalSpec() throws {
        let url = file("a.mp4")
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", url, outMs: 1000)]))
        XCTAssertEqual(spec.clips.count, 1)
        XCTAssertEqual(spec.clips[0].outMs, 1000)
        XCTAssertEqual(spec.output.width, 360)
    }

    func testRendersOneVideoClip() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let options = TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 1000)])
        let (out, result) = try await TestRender.render(options, to: file("out.mp4"))

        XCTAssertEqual(result.width, 360)
        XCTAssertEqual(result.height, 640)
        let probed = try await TestMedia.probe(out)
        XCTAssertEqual(Double(probed.durationMs), 1000, accuracy: 70)
        XCTAssertTrue(probed.hasAudio)
        let middle = try await TestMedia.color(of: out, at: 0.5)
        XCTAssertTrue(middle.near(.red), "expected red, got \(middle)")
    }

    func testWritesASourceWithSoundLongerThanTwoSeconds() async throws {
        // Past a second or two, a writer given all of its picture before any of its sound stalls
        // for good on the simulator (see `TestMedia.video`).
        let source = try await TestMedia.video(file("long.mp4"), durationMs: 6000, color: .blue)
        let probed = try await TestMedia.probe(source)
        XCTAssertEqual(Double(probed.durationMs), 6000, accuracy: 70)
        XCTAssertTrue(probed.hasAudio)
    }
}
