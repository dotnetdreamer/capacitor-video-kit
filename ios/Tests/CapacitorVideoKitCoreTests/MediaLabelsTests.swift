import CoreGraphics
import Foundation
import UniformTypeIdentifiers
import XCTest
@testable import CapacitorVideoKitCore

/// `labelMedia`: which frames are looked at, how a picture is told from a video and turned upright,
/// what Vision answers on this simulator, and every way the call refuses.
final class MediaLabelsTests: RenderTestCase {

    // MARK: - Which frames

    func testSpreadsTheFramesThroughTheClipEachInItsOwnShare() {
        let (times, tolerance) = MediaLabels.plan(durationMs: 10_000, timesMs: [], frames: 5)
        XCTAssertEqual(times, [1000, 3000, 5000, 7000, 9000])
        // Half the gap, so no frame can snap into its neighbour's share of the clip.
        XCTAssertEqual(tolerance, 1000)
    }

    func testHoldsTimesInsideTheClipAndAsksForEachOnce() {
        let (times, tolerance) = MediaLabels.plan(durationMs: 4000, timesMs: [-5, 1000, 1000, 99_999], frames: 5)
        XCTAssertEqual(times, [0, 1000, 3999])
        XCTAssertEqual(tolerance, 500)
    }

    func testLooksOnceAtTheMiddleForOneFrameAndAtTheStartForAClipOfNoLength() {
        XCTAssertEqual(MediaLabels.plan(durationMs: 6000, timesMs: [], frames: 1).times, [3000])
        XCTAssertEqual(MediaLabels.plan(durationMs: 6000, timesMs: [], frames: 1).toleranceMs, 3000)
        XCTAssertEqual(MediaLabels.plan(durationMs: 0, timesMs: [500], frames: 5).times, [0])
    }

    func testNeverLooksAtMoreThanTwentyFrames() {
        XCTAssertEqual(MediaLabels.plan(durationMs: 100_000, timesMs: [], frames: 50).times.count, 20)
        XCTAssertEqual(MediaLabels.plan(durationMs: 100_000, timesMs: [], frames: 0).times.count, 1)
    }

    // MARK: - Picture or video

    func testTellsAPictureFromAVideoByWhatTheFileHolds() async throws {
        let jpeg = try TestMedia.picture(file("photo.jpg"))
        let png = try TestMedia.picture(file("shot.png"), type: .png)
        let heic = try TestMedia.picture(file("photo.heic"), type: .heic)
        let video = try await TestMedia.video(file("clip.mp4"), durationMs: 1000, color: .red)
        // A staged render input can have no extension; ImageIO reads the first bytes.
        let bare = file("render-input")
        try FileManager.default.copyItem(at: jpeg, to: bare)

        XCTAssertEqual(MediaLabels.kind(of: jpeg), .image)
        XCTAssertEqual(MediaLabels.kind(of: png), .image)
        XCTAssertEqual(MediaLabels.kind(of: heic), .image)
        XCTAssertEqual(MediaLabels.kind(of: bare), .image)
        XCTAssertEqual(MediaLabels.kind(of: video), .video)
        XCTAssertEqual(MediaLabels.kind(of: file("never written.jpg")), .video)
    }

    func testTurnsAPictureUprightByItsOrientationTagAndDecodesItSmall() throws {
        // Stored 1600 x 1200 with orientation 6: a portrait photo as the camera wrote it.
        let url = try TestMedia.picture(file("portrait.jpg"), width: 1600, height: 1200, orientation: 6)
        let image = try MediaLabels.picture(url)
        XCTAssertEqual(image.height, MediaLabels.lookSize)
        XCTAssertEqual(image.width, 540)
    }

    // MARK: - Frames of a video

    func testCutsAVideoIntoDistinctFramesInTimeOrder() async throws {
        let url = try await TestMedia.video(file("clip.mp4"), durationMs: 3000, color: .blue)
        let frames = try await MediaLabels.videoFrames(url, options: .init(kind: nil, timesMs: [], frames: 3, minConfidence: 0.1))

        let times = frames.map(\.0)
        XCTAssertEqual(times.count, 3)
        XCTAssertEqual(times, times.sorted())
        XCTAssertEqual(Set(times).count, 3, "every frame from its own share of the clip: \(times)")
        // Each within half a share (500 ms) of the time asked for: 500, 1500, 2500.
        for (time, asked) in zip(times, [Int64(500), 1500, 2500]) {
            XCTAssertLessThanOrEqual(abs(time - asked), 500, "\(times)")
        }
        // Upright and small: a 320 x 240 source stays as it is, never above the look size.
        XCTAssertTrue(frames.allSatisfy { $0.1.width <= MediaLabels.lookSize && $0.1.height <= MediaLabels.lookSize })
    }

    func testCutsTheTimesItIsGiven() async throws {
        let url = try await TestMedia.video(file("clip.mp4"), durationMs: 2000, color: .green)
        let frames = try await MediaLabels.videoFrames(url, options: .init(kind: .video, timesMs: [200, 1800], frames: 5, minConfidence: 0.1))
        XCTAssertEqual(frames.count, 2)
        XCTAssertLessThan(frames[0].0, frames[1].0)
    }

    #if targetEnvironment(simulator)

    // MARK: - The simulator

    /// Vision's classifier answers nonsense in the simulator (`MediaLabels.simulatorHasNoClassifier`),
    /// so the call refuses as a platform with no recogniser - once the file has been read.
    func testRefusesAsUnsupportedInTheSimulatorOnceTheFileHasBeenRead() async throws {
        let picture = try TestMedia.picture(file("photo.jpg"))
        let video = try await TestMedia.video(file("clip.mp4"), durationMs: 1000, color: .red)
        for url in [picture, video] {
            do {
                _ = try await MediaLabels.label(url, options: .init(kind: nil, timesMs: [], frames: 2, minConfidence: 0.1))
                XCTFail("\(url.lastPathComponent) was labelled in the simulator")
            } catch let MediaLabels.LabelError.unsupported(message) {
                XCTAssertEqual(message, MediaLabels.simulatorHasNoClassifier)
            }
        }
        let rejection = try PluginCalls.reject(VideoComposerPlugin.labelMedia, ["uri": picture.absoluteString])
        XCTAssertEqual(rejection.code, "unsupported")
        XCTAssertEqual(rejection.message, MediaLabels.simulatorHasNoClassifier)
    }

    func testBringsNumbersIntoRangeRatherThanRefusingThem() throws {
        let url = try TestMedia.picture(file("photo.jpg"))
        // Refused for the platform, never for the numbers.
        let rejection = try PluginCalls.reject(VideoComposerPlugin.labelMedia,
                                               ["uri": url.absoluteString, "frames": 400, "minConfidence": 7, "timesMs": [-3, "x"]])
        XCTAssertEqual(rejection.code, "unsupported")
    }

    #else

    // MARK: - What Vision says, on a device

    func testLabelsAPictureOnce() async throws {
        let url = try TestMedia.picture(file("photo.jpg"))
        let result = try await MediaLabels.label(url, options: .init(kind: nil, timesMs: [], frames: 5, minConfidence: 0))

        XCTAssertEqual(result.kind, .image)
        XCTAssertEqual(result.frames.count, 1)
        XCTAssertEqual(result.frames[0].timeMs, 0)
        XCTAssertGreaterThanOrEqual(result.revision, 1)
        // Vision scores every label it knows, so a floor of 0 hands back its whole vocabulary.
        let labels = result.frames[0].labels
        XCTAssertEqual(labels.count, 1303)
        XCTAssertEqual(labels.map(\.confidence), labels.map(\.confidence).sorted(by: >))

        let json = result.json
        XCTAssertEqual(json["engine"] as? String, "vision")
        XCTAssertEqual(json["kind"] as? String, "image")
        XCTAssertEqual(json["revision"] as? Int, result.revision)
    }

    func testKeepsOnlyTheLabelsAtOrAboveTheFloor() async throws {
        let url = try TestMedia.picture(file("photo.jpg"))
        let result = try await MediaLabels.label(url, options: .init(kind: .image, timesMs: [], frames: 1, minConfidence: 0.05))
        XCTAssertTrue(result.frames[0].labels.allSatisfy { $0.confidence >= 0.05 })
        XCTAssertLessThan(result.frames[0].labels.count, 1303)
    }

    func testLabelsEveryFrameOfAVideo() async throws {
        let url = try await TestMedia.video(file("clip.mp4"), durationMs: 3000, color: .blue)
        let result = try await MediaLabels.label(url, options: .init(kind: nil, timesMs: [], frames: 3, minConfidence: 0.1))
        XCTAssertEqual(result.kind, .video)
        XCTAssertEqual(result.frames.count, 3)
    }

    func testBringsNumbersIntoRangeRatherThanRefusingThem() throws {
        let url = try TestMedia.picture(file("photo.jpg"))
        let answer = try PluginCalls.resolve(VideoComposerPlugin.labelMedia,
                                             ["uri": url.absoluteString, "frames": 400, "minConfidence": 7, "timesMs": [-3, "x"]])
        XCTAssertEqual(answer["kind"] as? String, "image")
        // A floor held at 1 keeps only a label Vision is certain of, which a flat picture has none of.
        let frames = answer["frames"] as? [[String: Any]]
        XCTAssertEqual(frames?.count, 1)
        XCTAssertEqual((frames?.first?["labels"] as? [Any])?.count, 0)
    }

    /// Opt in with `TEST_RUNNER_VK_LABEL_PHOTOS=<folder>` on `xcodebuild test` against a device: the
    /// folder of the photographs the scene tables were built against (lighsnip's
    /// `tools/template-lab/photos`), copied where the test can read them.
    func testRecognisesRealPhotographs() async throws {
        guard let folder = ProcessInfo.processInfo.environment["VK_LABEL_PHOTOS"], !folder.isEmpty else {
            throw XCTSkip("VK_LABEL_PHOTOS is not set")
        }
        let expected: [(file: String, label: String)] = [
            ("skate-3.jpg", "skating"),
            ("food-2.jpg", "food"),
            ("party-3.jpg", "fireworks"),
            ("birthday-1.jpg", "birthday_cake"),
            ("coffee-2.jpg", "coffee"),
            ("city-night-4.jpg", "skyscraper"),
        ]
        for (name, label) in expected {
            let url = URL(fileURLWithPath: folder).appendingPathComponent(name)
            let result = try await MediaLabels.label(url, options: .init(kind: nil, timesMs: [], frames: 5, minConfidence: 0.1))
            let found = result.frames[0].labels.first { $0.identifier == label }
            XCTAssertGreaterThan(found?.confidence ?? 0, 0.3, "\(name): \(label) in \(result.frames[0].labels.prefix(8).map(\.identifier))")
        }
    }

    #endif

    // MARK: - Refusals

    func testRefusesACallWithNoFile() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.labelMedia, [:])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "uri is required")
    }

    func testRefusesAKindThatIsNeitherOfTheTwo() throws {
        let url = try TestMedia.picture(file("photo.jpg"))
        let rejection = try PluginCalls.reject(VideoComposerPlugin.labelMedia, ["uri": url.absoluteString, "kind": "audio"])
        XCTAssertEqual(rejection.code, "invalid_spec")
    }

    func testReportsAFileThatIsNotThereAsUnreadable() throws {
        for kind in ["image", "video"] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.labelMedia,
                                                   ["uri": file("never written.mp4").absoluteString, "kind": kind])
            XCTAssertEqual(rejection.code, "unreadable_input", kind)
        }
    }

    func testReportsAFileThatHoldsNoPictureAsUnreadable() throws {
        let text = file("notes.txt")
        try Data("not a picture and not a video".utf8).write(to: text)
        let rejection = try PluginCalls.reject(VideoComposerPlugin.labelMedia, ["uri": text.absoluteString])
        XCTAssertEqual(rejection.code, "unreadable_input")
        let asPicture = try PluginCalls.reject(VideoComposerPlugin.labelMedia, ["uri": text.absoluteString, "kind": "image"])
        XCTAssertEqual(asPicture.code, "unreadable_input")
    }

    func testReportsAURIThatIsNotAFileAsUnreadable() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.labelMedia, ["uri": "content://media/external/images/media/7"])
        XCTAssertEqual(rejection.code, "unreadable_input")
    }
}
