import XCTest
@testable import CapacitorVideoKitCore

/// `ComposeClip.image` through the parser: a picture is silent at 1x whatever the rest of the clip
/// says, wherever the clip sits - the base track, a layer, or a transition's outgoing side. The
/// same cases as Android's `ComposeSpecParserTest`.
final class PicturesParserTests: RenderTestCase {

    /// A picture that asks for sound and a speed change, neither of which it can have.
    private func picture(_ key: String, inMs: Int64 = 0, outMs: Int64 = 1000) -> [String: Any] {
        TestSpecs.clip(key, file("photo.jpg"), inMs: inMs, outMs: outMs,
                       ["image": true, "speed": 2.5, "muted": false, "volume": 1])
    }

    func testAPictureOnTheBaseTrackIsSilentAtNormalSpeed() throws {
        let spec = try TestCalls.parse(TestSpecs.spec([picture("p")]))
        let clip = spec.clips[0]
        XCTAssertTrue(clip.image)
        XCTAssertEqual(clip.speed, 1)
        XCTAssertTrue(clip.muted)
    }

    func testAPictureOnALayerIsSilentAtNormalSpeed() throws {
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("v", file("a.mp4"), outMs: 1000)], [
            "tracks": [["id": "pip", "z": 1, "clips": [picture("p")]]],
        ]))
        let clip = try XCTUnwrap(spec.tracks?.first?.clips.first)
        XCTAssertTrue(clip.image)
        XCTAssertEqual(clip.speed, 1)
        XCTAssertTrue(clip.muted)
    }

    func testAPictureAsATransitionsOutgoingSideIsSilentAtNormalSpeed() throws {
        let spec = try TestCalls.parse(TestSpecs.spec([
            picture("p", outMs: 600),
            TestSpecs.clip("v", file("a.mp4"), outMs: 1000, [
                "transitionIn": ["kind": "dissolve", "from": picture("p", inMs: 600, outMs: 1000),
                                 "curves": ["alpha": [0.0, 1.0]]],
            ]),
        ]))
        let from = try XCTUnwrap(spec.clips[1].transitionIn?.from)
        XCTAssertTrue(from.image)
        XCTAssertEqual(from.inMs, 600)
        XCTAssertEqual(from.speed, 1)
        XCTAssertTrue(from.muted)
    }

    func testAClipWithoutTheKeyIsAVideoAndKeepsItsSpeedAndSound() throws {
        let spec = try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("v", file("a.mp4"), outMs: 1000, ["speed": 2.5]),
            // Anything that is not a boolean reads as a video, as `muted` reads leniently.
            TestSpecs.clip("w", file("b.mp4"), outMs: 1000, ["image": "yes"]),
        ]))
        XCTAssertFalse(spec.clips[0].image)
        XCTAssertEqual(spec.clips[0].speed, 2.5)
        XCTAssertFalse(spec.clips[0].muted)
        XCTAssertFalse(spec.clips[1].image)
    }

    func testAPictureKeepsEverythingButItsSpeedAndSound() throws {
        // Speed and sound are the only two things a picture cannot have. Its trim, framing, crop and
        // placement are the customer's and travel on untouched.
        let spec = try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("p", file("photo.jpg"), inMs: 200, outMs: 1400, fit: "contain", [
                "image": true, "speed": 2, "volume": 0.4,
                "crop": ["x": 0.1, "y": 0.2, "w": 0.5, "h": 0.6],
                "rect": ["x": 0.25, "y": 0.3, "w": 0.5, "h": 0.4, "rotationDeg": 30],
            ]),
        ]))
        let clip = spec.clips[0]
        XCTAssertEqual(clip.key, "p")
        XCTAssertEqual(clip.inMs, 200)
        XCTAssertEqual(clip.outMs, 1400)
        XCTAssertEqual(clip.fit, .contain)
        XCTAssertEqual(clip.volume, 0.4)
        let crop = try XCTUnwrap(clip.crop)
        XCTAssertEqual([crop.x, crop.y, crop.w, crop.h], [0.1, 0.2, 0.5, 0.6])
        let rect = try XCTUnwrap(clip.rect)
        XCTAssertEqual([rect.x, rect.y, rect.w, rect.h], [0.25, 0.3, 0.5, 0.4])
        XCTAssertEqual(rect.rotationDeg, 30)
        XCTAssertEqual(clip.speed, 1)
        XCTAssertTrue(clip.muted)
    }
}
