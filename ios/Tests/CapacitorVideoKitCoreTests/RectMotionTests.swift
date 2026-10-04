import XCTest
@testable import CapacitorVideoKitCore

/// A split screen that opens and closes, on iOS: a clip's moving rectangle read off the wire by
/// `normaliseRectMotion`'s rules in Android's order, and its keys read by `rectMotionAt`'s. The same
/// cases as `layout-motion.unit.test.ts` and Android's `RectMotionTest`.
final class RectMotionTests: RenderTestCase {

    // MARK: - The wire

    /// A spec whose one clip carries `rectMotion`, or none when it is nil.
    private func spec(_ motion: Any?) -> [String: Any] {
        var clip = TestSpecs.clip("a", file("a.mp4"), outMs: 4000)
        clip["rect"] = ["x": 0, "y": 0.5, "w": 1, "h": 0.5]
        if let motion { clip["rectMotion"] = motion }
        return TestSpecs.spec([clip])
    }

    private func motionOf(_ motion: Any?) throws -> ComposeRectMotion? {
        try TestCalls.parse(spec(motion)).clips[0].rectMotion
    }

    private func keys(atMs: [Any] = [0, 100], x: [Any] = [0, 0], y: [Any] = [1, 0.5],
                      w: [Any] = [1, 1], h: [Any] = [0.5, 0.5]) -> [String: Any] {
        ["atMs": atMs, "x": x, "y": y, "w": w, "h": h]
    }

    private func assertRefused(_ motion: Any?, _ path: String,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try motionOf(motion), file: file, line: line) { error in
            XCTAssertEqual((error as? SpecError)?.path, path, file: file, line: line)
        }
    }

    func testNoMotionAndANullOneHoldStill() throws {
        XCTAssertNil(try motionOf(nil))
        XCTAssertNil(try motionOf(NSNull()))
    }

    func testAMotionIsReadWithEveryValueClamped() throws {
        let motion = try XCTUnwrap(try motionOf(keys(x: [9, -9], w: [-1, 5])))
        XCTAssertEqual(motion.atMs, [0, 100])
        XCTAssertEqual(motion.x, [4, -4])
        XCTAssertEqual(motion.y, [1, 0.5])
        XCTAssertEqual(motion.w, [0, 2])
        XCTAssertEqual(motion.h, [0.5, 0.5])
        // The resting rectangle is read as it always was, beside them.
        XCTAssertEqual(try TestCalls.parse(spec(keys())).clips[0].rect?.y, 0.5)
    }

    func testAMotionNoEngineCouldDrawIsRefusedNamingWhatBrokeInTheBrowsersOrder() {
        assertRefused("keys", "clips[0].rectMotion")
        assertRefused(["x": [0]] as [String: Any], "clips[0].rectMotion.atMs")
        assertRefused(keys(x: [0]), "clips[0].rectMotion.x")
        var tall = keys()
        tall["h"] = "tall"
        assertRefused(tall, "clips[0].rectMotion.h")
        var extra = keys()
        extra["zz"] = [Any]()
        extra["rotation"] = [Any]()
        assertRefused(extra, "clips[0].rectMotion.rotation")
        assertRefused(keys(atMs: [], x: [], y: [], w: [], h: []), "clips[0].rectMotion")
        assertRefused(keys(atMs: [100, 50]), "clips[0].rectMotion.atMs[1]")
        assertRefused(keys(atMs: [0, "soon"]), "clips[0].rectMotion.atMs[1]")
        assertRefused(keys(w: [1, NSNull()]), "clips[0].rectMotion.w[1]")
    }

    // MARK: - Reading the keys

    func testTheKeysAreReadInStraightLinesTheEndsHoldAndEqualTimesAreAStep() {
        let keys = ComposeRectMotion(atMs: [100, 200, 200, 300], x: [0, 1, 2, 3], y: [0, 0, 0, 0],
                                     w: [1, 1, 1, 1], h: [1, 1, 1, 1])
        XCTAssertEqual(keys.rect(atMs: 0).x, 0)
        XCTAssertEqual(keys.rect(atMs: 150).x, 0.5, accuracy: 1e-12)
        XCTAssertEqual(keys.rect(atMs: 200).x, 2)
        XCTAssertEqual(keys.rect(atMs: 250).x, 2.5, accuracy: 1e-12)
        XCTAssertEqual(keys.rect(atMs: 999).x, 3)
    }

    func testARectangleUnderHalfAPixelEitherWayDrawsNothing() {
        XCTAssertTrue(ComposeRectMotion.drawsNothing(ComposeRect(x: 0, y: 1, w: 1, h: 0), width: 720, height: 1280))
        XCTAssertTrue(ComposeRectMotion.drawsNothing(ComposeRect(x: 0, y: 0, w: 0.0001, h: 1), width: 720, height: 1280))
        XCTAssertFalse(ComposeRectMotion.drawsNothing(ComposeRect(x: 0, y: 0.99, w: 1, h: 0.001), width: 720, height: 1280))
    }
}
