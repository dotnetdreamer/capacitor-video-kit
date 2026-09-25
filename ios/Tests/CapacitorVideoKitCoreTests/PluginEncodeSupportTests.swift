import XCTest
@testable import CapacitorVideoKitCore

/// `EncodeSupport`, the answer behind `encodeSupport`: both orientations, the rate, the sentence,
/// and the cache.
final class PluginEncodeSupportTests: XCTestCase {

    /// A probe that fits a LANDSCAPE frame up to `maxLong` x `maxShort` at up to `maxFps` and no
    /// portrait frame at all, and counts how often it was asked.
    private final class FakeEncoder {
        let maxLong: Int, maxShort: Int, maxFps: Int
        private(set) var asked: [String] = []

        init(maxLong: Int = 3840, maxShort: Int = 2160, maxFps: Int = 60) {
            self.maxLong = maxLong
            self.maxShort = maxShort
            self.maxFps = maxFps
        }

        func probe(_ width: Int, _ height: Int, _ fps: Int) -> EncodeSupport.Verdict {
            asked.append("\(width)x\(height)@\(fps)")
            // Landscape only, the way an encoder may state its limits.
            if height > width || width > maxLong || height > maxShort { return .sizeRefused }
            return fps > maxFps ? .rateRefused : .fits
        }
    }

    func testTriesAPortraitFrameTheOtherWayRound() {
        let encoder = FakeEncoder()
        let support = EncodeSupport(probe: encoder.probe)
        XCTAssertEqual(support.answer(width: 2160, height: 3840, fps: 30), .init(supported: true, reason: nil))
        XCTAssertEqual(encoder.asked, ["2160x3840@30", "3840x2160@30"])
    }

    func testAsksOnceForALandscapeFrameThatFits() {
        let encoder = FakeEncoder()
        let support = EncodeSupport(probe: encoder.probe)
        XCTAssertTrue(support.answer(width: 1920, height: 1080, fps: 60).supported)
        XCTAssertEqual(encoder.asked, ["1920x1080@60"])
    }

    func testNamesTheRateWhenTheRateIsWhatIsRefused() {
        let support = EncodeSupport(probe: FakeEncoder(maxFps: 30).probe)
        XCTAssertEqual(support.answer(width: 2160, height: 3840, fps: 60),
                       .init(supported: false, reason: "2160P at 60fps is more than this device's encoder can take."))
    }

    func testLeavesTheRateOutWhenTheSizeIsWhatIsRefused() {
        let support = EncodeSupport(probe: FakeEncoder().probe)
        XCTAssertEqual(support.answer(width: 7680, height: 4320, fps: 30),
                       .init(supported: false, reason: "4320P is more than this device's encoder can take."))
    }

    func testRefusesSomethingThatIsNotAFrameWithoutAsking() {
        let encoder = FakeEncoder()
        let support = EncodeSupport(probe: encoder.probe)
        XCTAssertEqual(support.answer(width: 0, height: 1080, fps: 30),
                       .init(supported: false, reason: "That is not a frame."))
        XCTAssertEqual(encoder.asked, [])
    }

    func testCachesEachSizeAndRate() {
        let encoder = FakeEncoder(maxFps: 30)
        let support = EncodeSupport(probe: encoder.probe)
        let first = support.answer(width: 1080, height: 1920, fps: 60)
        XCTAssertEqual(support.answer(width: 1080, height: 1920, fps: 60), first)
        XCTAssertEqual(encoder.asked.count, 2, "both orientations once, then the cache")

        _ = support.answer(width: 1080, height: 1920, fps: 30)
        XCTAssertEqual(encoder.asked.count, 4, "a different rate is a different question")
        _ = support.answer(width: 1080, height: 1920, fps: 30)
        XCTAssertEqual(encoder.asked.count, 4)
    }

    // MARK: - H.264 levels

    func testReadsTheHighestLevelOffTheEncodersList() {
        let listed = ["H264_Baseline_AutoLevel", "H264_Baseline_1_3", "H264_Main_5_2", "H264_High_5_1",
                      "H264_High_AutoLevel", "HEVC_Main_AutoLevel"]
        XCTAssertEqual(EncodeSupport.Level.highest(in: listed)?.name, "5_2")
        XCTAssertNil(EncodeSupport.Level.highest(in: ["H264_High_AutoLevel"]))
        XCTAssertNil(EncodeSupport.Level.highest(in: []))
    }

    func testHoldsAFrameAndARateToALevel() throws {
        let level52 = try XCTUnwrap(EncodeSupport.Level.table.first { $0.name == "5_2" })
        let level51 = try XCTUnwrap(EncodeSupport.Level.table.first { $0.name == "5_1" })

        XCTAssertEqual(level52.verdict(width: 3840, height: 2160, fps: 60), .fits)
        XCTAssertEqual(level52.verdict(width: 2160, height: 3840, fps: 60), .fits)
        XCTAssertEqual(level52.verdict(width: 3840, height: 2160, fps: 120), .rateRefused)
        XCTAssertEqual(level52.verdict(width: 1920, height: 1080, fps: 240), .fits)
        XCTAssertEqual(level52.verdict(width: 7680, height: 4320, fps: 30), .sizeRefused)

        XCTAssertEqual(level51.verdict(width: 3840, height: 2160, fps: 30), .fits)
        XCTAssertEqual(level51.verdict(width: 3840, height: 2160, fps: 60), .rateRefused)
    }

    // MARK: - VideoToolbox itself

    func testVideoToolboxTakesTheFramesEveryEditorOffers() {
        for (width, height, fps) in [(1280, 720, 30), (1920, 1080, 60), (1080, 1920, 60), (3840, 2160, 30)] {
            XCTAssertEqual(EncodeSupport.videoToolbox(width: width, height: height, fps: fps), .fits,
                           "\(width)x\(height)@\(fps)")
        }
    }

    func testVideoToolboxHoldsTheRateToTheLevelTheEncoderLists() {
        // A session takes any expected frame rate it is told, so these can only be refused by a
        // level read off the real encoder: were that read to come back empty, all of them would fit.
        // 1080p at 1000 fps is more macroblocks a second than any H.264 level allows, and 4K at
        // 120 more than 5.2 does - the encoder above already took 4K at 30, so it lists 5.1 or 5.2.
        XCTAssertEqual(EncodeSupport.videoToolbox(width: 1920, height: 1080, fps: 1000), .rateRefused)
        XCTAssertEqual(EncodeSupport.videoToolbox(width: 3840, height: 2160, fps: 120), .rateRefused)
        XCTAssertEqual(EncodeSupport.videoToolbox(width: 7680, height: 4320, fps: 30), .sizeRefused)
    }

    // MARK: - Through the plugin

    func testThePluginAnswersEveryFrameInOrderAndEchoesIt() throws {
        let frames: [[String: Any]] = [
            ["width": 1920, "height": 1080, "fps": 30],
            ["width": 0, "height": 0, "fps": 30],
            ["width": 1080, "height": 1920],
        ]
        let result = try PluginCalls.resolve(VideoComposerPlugin.encodeSupport, ["frames": frames])
        let answers = try XCTUnwrap(result["frames"] as? [[String: Any]])
        XCTAssertEqual(answers.count, 3)

        XCTAssertEqual(answers[0]["supported"] as? Bool, true)
        XCTAssertNil(answers[0]["reason"])
        XCTAssertEqual(answers[0]["fps"] as? Int, 30)

        XCTAssertEqual(answers[1]["supported"] as? Bool, false)
        XCTAssertEqual(answers[1]["reason"] as? String, "That is not a frame.")

        // No rate means 30, as on Android.
        XCTAssertEqual(answers[2]["fps"] as? Int, 30)
        XCTAssertEqual(answers[2]["width"] as? Int, 1080)
        XCTAssertEqual(answers[2]["height"] as? Int, 1920)
    }
}
