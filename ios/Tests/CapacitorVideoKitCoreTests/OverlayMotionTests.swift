import CoreGraphics
import CoreImage
import XCTest
@testable import CapacitorVideoKitCore

/// A layer's motion on iOS: the wire read by `normaliseOverlayMotion`'s rules in Android's order and
/// words, the keys read by `overlayMotionAt`'s, and a moving layer placed by the compositor's own
/// affine and read back in pixels. The same cases as `motion.unit.test.ts` and Android's
/// `OverlayMotionTest`.
final class OverlayMotionTests: RenderTestCase {

    // MARK: - The wire

    /// A spec with one 100 x 50 layer carrying `motion`, or none when it is nil.
    private func spec(_ motion: Any?, _ extra: [String: Any] = [:]) -> [String: Any] {
        var overlay: [String: Any] = ["id": "o", "png": "data:image/png;base64,AAAA", "cx": 0.5, "cy": 0.5,
                                      "wPx": 100, "hPx": 50, "rotationDeg": 0, "startMs": 0, "endMs": 2000,
                                      "opacity": 1]
        if let motion { overlay["motion"] = motion }
        for (k, v) in extra { overlay[k] = v }
        return TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 2000)], ["overlays": [overlay]])
    }

    private func motionOf(_ motion: Any?) throws -> ComposeOverlayMotion? {
        try TestCalls.parse(spec(motion)).overlays[0].motion
    }

    private func assertRefused(_ motion: Any?, _ path: String, message: String? = nil,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try motionOf(motion), file: file, line: line) { error in
            let refusal = error as? SpecError
            XCTAssertEqual(refusal?.path, path, file: file, line: line)
            if let message { XCTAssertEqual(refusal?.message, message, file: file, line: line) }
        }
    }

    func testNoMotionANullOneNoTimesAndOneThatMovesNothingAreNone() throws {
        XCTAssertNil(try motionOf(nil))
        XCTAssertNil(try motionOf(NSNull()))
        XCTAssertNil(try motionOf([String: Any]()))
        XCTAssertNil(try motionOf(["atMs": [Any]()]))
        XCTAssertNil(try motionOf(["atMs": [0, 500]]))
        XCTAssertNil(try motionOf(["atMs": [0, 500], "scale": [1, 1], "x": [0, 0]]))
    }

    func testAMotionIsClampedItsUnreadableValuesAreNeutralAndStillChannelsAreLeftOff() throws {
        let motion = try XCTUnwrap(try motionOf([
            "atMs": [0, 250, 250.5],
            "x": [-9, 9, 0.12],
            "y": [0, 0, 0],
            "scale": [-1, 99, "big"] as [Any],
            "rotation": [-9999, 30, "x"] as [Any],
            "opacity": [2, 0.5, 1],
        ] as [String: Any]))
        XCTAssertEqual(motion.atMs, [0, 250, 250.5])
        XCTAssertEqual(motion.x, [-4, 4, 0.12])
        XCTAssertNil(motion.y)
        XCTAssertEqual(motion.scale, [0, 20, 1])
        XCTAssertEqual(motion.rotation, [-3600, 30, 0])
        XCTAssertEqual(motion.opacity, [1, 0.5, 1])
    }

    func testAMotionOfTheWrongShapeIsRefusedWithItsPathInTheContractsOrder() {
        assertRefused([1, 2], "overlays[0].motion")
        assertRefused("pop", "overlays[0].motion")
        assertRefused(["atMs": 5], "overlays[0].motion.atMs")
        assertRefused(["atMs": [0, 1], "x": [0]] as [String: Any], "overlays[0].motion.x")
        // The channels in order: scale before opacity, however the object holds them.
        assertRefused(["atMs": [0, 1], "opacity": [0], "scale": [1]] as [String: Any], "overlays[0].motion.scale")
        assertRefused(["atMs": [0, 1], "scale": 2] as [String: Any], "overlays[0].motion.scale")
        // Unknown keys after the channels: a broken channel is named first.
        assertRefused(["atMs": [0, 1], "glow": [0, 1]] as [String: Any], "overlays[0].motion.glow")
        assertRefused(["atMs": [0, 1], "glow": [0, 1], "y": [0]] as [String: Any], "overlays[0].motion.y")
    }

    func testTooManyKeysAreRefusedInAndroidsWords() throws {
        let n = ComposeSpecParser.maxOverlayMotionKeys + 1
        let times = (0..<n).map { Double($0) }
        assertRefused(["atMs": times, "x": [Double](repeating: 0.1, count: n)] as [String: Any],
                      "overlays[0].motion",
                      message: "invalid_spec:overlays[0].motion at most \(ComposeSpecParser.maxOverlayMotionKeys) keys")
        let fits = try XCTUnwrap(try motionOf(["atMs": Array(times.dropLast()),
                                               "x": [Double](repeating: 0.1, count: n - 1)] as [String: Any]))
        XCTAssertEqual(fits.atMs.count, ComposeSpecParser.maxOverlayMotionKeys)
    }

    func testATimeThatIsNotANumberOrGoesBackIsRefusedWithItsIndex() throws {
        assertRefused(["atMs": [0, "1s"] as [Any], "x": [0, 1]] as [String: Any], "overlays[0].motion.atMs[1]")
        assertRefused(["atMs": [0, 500, 499], "x": [0, 1, 1]] as [String: Any], "overlays[0].motion.atMs[2]")
        // Equal times are a step, not a fault.
        XCTAssertNotNil(try motionOf(["atMs": [0, 500, 500], "x": [0, 1, 0]] as [String: Any]))
    }

    func testTheMotionIsReadAfterTheRestOfTheLayer() {
        XCTAssertThrowsError(try TestCalls.parse(spec(["atMs": "x"], ["wPx": 0]))) { error in
            XCTAssertEqual((error as? SpecError)?.path, "overlays[0].wPx")
        }
    }

    // MARK: - Reading the keys

    private let keys = ComposeOverlayMotion(atMs: [100, 200, 200, 300], x: [0.1, 0.2, 0, 0], y: nil,
                                            scale: nil, rotation: nil, opacity: [0, 1, 1, 0.5])

    func testTheKeysAreReadInStraightLinesTheEndsHoldAndEqualTimesAreAStep() throws {
        XCTAssertEqual(OverlayMotionMath.sample(keys, atMs: 0),
                       OverlayMotionSample(x: 0.1, y: 0, scale: 1, rotation: 0, opacity: 0))
        let mid = try XCTUnwrap(OverlayMotionMath.sample(keys, atMs: 150))
        XCTAssertEqual(mid.x, 0.15, accuracy: 1e-12)
        XCTAssertEqual(mid.opacity, 0.5, accuracy: 1e-12)
        // The later of the two keys at 200 wins, and there the layer is at rest.
        XCTAssertNil(OverlayMotionMath.sample(keys, atMs: 200))
        XCTAssertEqual(try XCTUnwrap(OverlayMotionMath.sample(keys, atMs: 250)).opacity, 0.75, accuracy: 1e-12)
        XCTAssertEqual(try XCTUnwrap(OverlayMotionMath.sample(keys, atMs: 1e9)).opacity, 0.5)
    }

    func testALongTrackIsSearchedToTheRightPair() throws {
        let n = 5000
        let long = ComposeOverlayMotion(atMs: (0..<n).map { Double($0) * 10 }, x: nil, y: nil,
                                        scale: (0..<n).map { 1 + Double($0 % 2) }, rotation: nil, opacity: nil)
        XCTAssertEqual(try XCTUnwrap(OverlayMotionMath.sample(long, atMs: 43_212.5)).scale, 1.75, accuracy: 1e-9)
    }

    // MARK: - Placing a moving layer

    /// A 100 x 100 frame, black, with a 10 x 10 white layer at the centre moved by `sample`.
    private func frame(_ sample: OverlayMotionSample?, cx: Double = 0.5, cy: Double = 0.5,
                       w: Int = 10, h: Int = 10, rotationDeg: Double = 0, opacity: Double = 1) throws -> CIImage {
        let motion = ComposeOverlayMotion(atMs: [0], x: [sample?.x ?? 0], y: [sample?.y ?? 0],
                                          scale: [sample?.scale ?? 1], rotation: [sample?.rotation ?? 0],
                                          opacity: [sample?.opacity ?? 1])
        let overlay = ComposeOverlay(id: "o", png: try RobustnessSupport.pngDataURL(width: w, height: h, color: .white),
                                     cx: cx, cy: cy, wPx: w, hPx: h, rotationDeg: rotationDeg,
                                     startMs: 0, endMs: 1000, opacity: opacity, motion: motion)
        let render = CGSize(width: 100, height: 100)
        let placed = try XCTUnwrap(OverlayBitmap.decode(overlay, render: render))
        var image = CIImage(color: .black).cropped(to: CGRect(origin: .zero, size: render))
        if let layer = placed.frame(atUs: 0, render: render) { image = layer.composited(over: image) }
        return image
    }

    /// The red channel at (x, y) counted from the TOP left, as the wire counts: Core Image is y-UP,
    /// so the one pixel rendered is row `99 - y` of its 100 x 100 frame.
    private func red(_ image: CIImage, _ x: Int, _ y: Int) -> UInt8 {
        let context = CIContext(options: [.workingColorSpace: NSNull(), .outputColorSpace: NSNull()])
        var pixel = [UInt8](repeating: 0, count: 4)
        context.render(image, toBitmap: &pixel, rowBytes: 4,
                       bounds: CGRect(x: x, y: 99 - y, width: 1, height: 1), format: .RGBA8, colorSpace: nil)
        return pixel[0]
    }

    func testAMotionMovesTheCentreByFractionsOfTheFrameRightAndDown() throws {
        let pixels = try frame(OverlayMotionSample(x: 0.2, y: -0.3, scale: 1, rotation: 0, opacity: 1))
        // From (50, 50) to (70, 20), counted from the top.
        XCTAssertGreaterThan(red(pixels, 70, 20), 240)
        XCTAssertGreaterThan(red(pixels, 66, 20), 240)
        XCTAssertLessThan(red(pixels, 63, 20), 16)
        XCTAssertLessThan(red(pixels, 50, 50), 16)
    }

    func testAMotionSizesTheLayerAboutItsOwnCentre() throws {
        let pixels = try frame(OverlayMotionSample(x: 0, y: 0, scale: 2, rotation: 0, opacity: 1), cx: 0.3)
        // 20 x 20 about (30, 50): 20...40 across.
        XCTAssertGreaterThan(red(pixels, 22, 50), 240)
        XCTAssertGreaterThan(red(pixels, 38, 50), 240)
        XCTAssertLessThan(red(pixels, 17, 50), 16)
        XCTAssertLessThan(red(pixels, 43, 50), 16)
    }

    func testAMotionAddsItsTurnToTheLayersOwnClockwise() throws {
        // A 40 x 6 bar at 30 degrees of its own and 60 of motion: standing up.
        let upright = try frame(OverlayMotionSample(x: 0, y: 0, scale: 1, rotation: 60, opacity: 1),
                                w: 40, h: 6, rotationDeg: 30)
        XCTAssertGreaterThan(red(upright, 50, 35), 240)
        XCTAssertGreaterThan(red(upright, 50, 65), 240)
        XCTAssertLessThan(red(upright, 35, 50), 16)
        // 45 degrees clockwise in a y-down frame: the right end goes DOWN.
        let turned = try frame(OverlayMotionSample(x: 0, y: 0, scale: 1, rotation: 45, opacity: 1), w: 40, h: 6)
        XCTAssertGreaterThan(red(turned, 60, 60), 240)
        XCTAssertLessThan(red(turned, 60, 40), 16)
    }

    func testAMotionMultipliesItsOpacityIntoTheLayersOwnOnTheAlpha() throws {
        let pixels = try frame(OverlayMotionSample(x: 0, y: 0, scale: 1, rotation: 0, opacity: 0.5), opacity: 0.5)
        XCTAssertEqual(Double(red(pixels, 50, 50)), 64, accuracy: 3)
    }

    func testALayerShrunkOrFadedToNothingIsNotDrawn() throws {
        let shrunk = try frame(OverlayMotionSample(x: 0, y: 0, scale: 0, rotation: 0, opacity: 1))
        let faded = try frame(OverlayMotionSample(x: 0, y: 0, scale: 1, rotation: 0, opacity: 0))
        XCTAssertLessThan(red(shrunk, 50, 50), 16)
        XCTAssertLessThan(red(faded, 50, 50), 16)
    }

    func testAStillLayerKeepsNothingToMoveAndALayerAtRestIsTheImagePlacedOnce() throws {
        let png = try RobustnessSupport.pngDataURL(width: 10, height: 10, color: .white)
        let still = ComposeOverlay(id: "o", png: png, cx: 0.5, cy: 0.5, wPx: 10, hPx: 10, rotationDeg: 0,
                                   startMs: 0, endMs: 1000, opacity: 1)
        let render = CGSize(width: 100, height: 100)
        XCTAssertNil(try XCTUnwrap(OverlayBitmap.decode(still, render: render)).moving)
        // At rest the moving path hands back the very image the still path placed.
        var resting = still
        resting.motion = ComposeOverlayMotion(atMs: [0, 500], x: [0.1, 0], y: nil, scale: nil, rotation: nil, opacity: nil)
        let placed = try XCTUnwrap(OverlayBitmap.decode(resting, render: render))
        XCTAssertNotNil(placed.moving)
        XCTAssertTrue(placed.frame(atUs: 700_000, render: render) === placed.image)
        XCTAssertFalse(placed.frame(atUs: 0, render: render) === placed.image)
    }
}
