@preconcurrency import AVFoundation
import CoreVideo
import XCTest
@testable import CapacitorVideoKitCore

/// `findSubjects`: which frames are looked at and how they are turned upright - checked with a
/// segmenter of the tests' own, which finds the bright part of a frame, because Vision's do not run in
/// the simulator - the searches' queue, the cache, the launch sweep, and every way the call refuses.
final class SubjectFinderTests: RenderTestCase {

    // MARK: - A segmenter that runs anywhere

    /// Instance 1 wherever the upright frame it is shown is bright, the background elsewhere.
    private final class Bright: SubjectSegmenter {
        let subjectKind = "subject"

        func mask(of frame: CVPixelBuffer) throws -> SubjectMask {
            CVPixelBufferLockBaseAddress(frame, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
            let width = CVPixelBufferGetWidth(frame), height = CVPixelBufferGetHeight(frame)
            let stride = CVPixelBufferGetBytesPerRow(frame)
            let base = CVPixelBufferGetBaseAddress(frame)!.assumingMemoryBound(to: UInt8.self)
            var values = [UInt8](repeating: 0, count: width * height)
            for y in 0..<height {
                for x in 0..<width {
                    let p = base + y * stride + x * 4
                    values[y * width + x] = (Int(p[0]) + Int(p[1]) + Int(p[2])) / 3 > 128 ? 1 : 0
                }
            }
            return SubjectMask(width: width, height: height, values: values, instances: 1)
        }
    }

    /// A 30 fps video, stored `width` x `height`, white on the columns before `split` (a fraction) and
    /// black after, written with `transform`.
    private func video(_ name: String, durationMs: Int64 = 1000, width: Int = 320, height: Int = 240,
                       split: Double = 1.0 / 3, transform: CGAffineTransform = .identity,
                       times: [CMTime]? = nil) async throws -> URL {
        var rgba = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width where Double(x) >= split * Double(width) {
                let i = (y * width + x) * 4
                rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0
            }
        }
        let frameTimes = times ?? TestMedia.evenTimes(Int(durationMs * 30 / 1000))
        return try await TestMedia.frames(file(name), width: width, height: height, times: frameTimes,
                                          transform: transform) { _ in rgba }
    }

    private func analyse(_ url: URL, kind: MediaLabelsResult.Kind = .video, fps: Double = 15,
                         progress: @escaping SubjectFinder.Progress = { _ in },
                         cancelled: @escaping @Sendable () -> Bool = { false }) async throws -> SubjectTrackContent {
        try await SubjectFinder.analyse(SubjectRequest(url: url, kind: kind, fps: fps), segmenter: { Bright() },
                                        progress: progress, cancelled: cancelled)
    }

    // MARK: - Which frames

    func testLooksAtTheFirstFrameAtOrAfterEachTimeStampedWithItsOwn() async throws {
        let url = try await video("clip.mp4", durationMs: 1000)
        let tenth = try await analyse(url, fps: 10)
        XCTAssertEqual(tenth.times, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900])
        // At 15 a second, every other frame of 30: their own times, to the millisecond.
        let fifteenth = try await analyse(url, fps: 15)
        XCTAssertEqual(fifteenth.times, [0, 67, 133, 200, 267, 333, 400, 467, 533, 600, 667, 733, 800, 867, 933])
        XCTAssertEqual(fifteenth.meta.kind, "video")
        XCTAssertEqual(fifteenth.meta.fps, 15)
        XCTAssertEqual(fifteenth.meta.durationMs, 1000)
        XCTAssertEqual(fifteenth.meta.engine, "vision")
    }

    func testAFootageWithFewerFramesThanTheRateLooksAtEachOfThemOnce() async throws {
        // Ten frames a second at irregular times, looked at fifteen times a second.
        let times = [0, 90, 210, 300, 400, 500, 610, 700, 800, 905].map { CMTime(value: CMTimeValue($0), timescale: 1000) }
        let url = try await video("vfr.mp4", times: times)
        let content = try await analyse(url, fps: 15)
        XCTAssertEqual(content.times, [0, 90, 210, 300, 400, 500, 610, 700, 800, 905])
    }

    func testTurnsAFrameUprightBeforeItIsLookedAt() async throws {
        // Stored 320 x 240, white on its left third, turned a quarter clockwise as a phone held upright
        // writes it: upright it is 240 x 320, white across the TOP third.
        let url = try await video("turned.mp4", transform: CGAffineTransform(rotationAngle: .pi / 2))
        let content = try await analyse(url)
        XCTAssertEqual(content.width, 240)
        XCTAssertEqual(content.height, 320)
        let frame = content.frames[0]
        XCTAssertEqual(frame[20 * content.width + 120], 1, "the top third is the subject")
        XCTAssertEqual(frame[300 * content.width + 120], 0, "the bottom is not")
        XCTAssertEqual(frame[20 * content.width + 5], 1, "across the whole width")
        let subject = try XCTUnwrap(content.meta.subjects.first)
        XCTAssertEqual(subject.box.x, 0)
        XCTAssertEqual(subject.box.y, 0)
        XCTAssertEqual(subject.box.w, 1)
        XCTAssertEqual(subject.box.h, 0.3333, accuracy: 0.01)
    }

    func testAPictureIsLookedAtOnceUprightByItsOrientationTag() async throws {
        // Stored 600 x 400, white on its left third, orientation 6: upright 400 x 600, white on TOP.
        let url = try TestMedia.picture(file("photo.jpg"), left: .white, middle: .black, right: .black, orientation: 6)
        let content = try await analyse(url, kind: .image)
        XCTAssertEqual(content.times, [0])
        XCTAssertEqual(content.width, 213)
        XCTAssertEqual(content.height, 320)
        XCTAssertEqual(content.meta.kind, "image")
        XCTAssertEqual(content.meta.durationMs, 0)
        XCTAssertEqual(content.meta.fps, 0)
        XCTAssertEqual(content.frames[0][30 * 213 + 100], 1)
        XCTAssertEqual(content.frames[0][300 * 213 + 100], 0)
        XCTAssertEqual(content.meta.subjects.map(\.id), [1])
    }

    func testReportsHowFarItHasGotAndStopsBetweenTwoFramesWhenAsked() async throws {
        let url = try await video("clip.mp4", durationMs: 1000)
        let heard = Heard()
        _ = try await analyse(url, fps: 10, progress: { heard.add($0) })
        XCTAssertEqual(heard.values.count, 10)
        XCTAssertEqual(heard.values.last, 1)
        XCTAssertEqual(heard.values, heard.values.sorted())

        let asked = Heard()
        do {
            _ = try await analyse(url, fps: 10, progress: { asked.add($0) }, cancelled: { asked.values.count >= 3 })
            XCTFail("a stopped search answered")
        } catch is CancellationError {
            XCTAssertEqual(asked.values.count, 3)
        }
    }

    func testAVideoWithNoFrameOrNoPictureIsUnreadable() async throws {
        let sound = try await TestMedia.sound(file("tone.m4a"), durationMs: 500)
        do {
            _ = try await analyse(sound)
            XCTFail("a sound was looked at")
        } catch SubjectFinder.FindError.unreadable {}
        do {
            _ = try await analyse(file("never.mp4"))
            XCTFail("a missing file was looked at")
        } catch SubjectFinder.FindError.unreadable {}
        do {
            _ = try await analyse(file("never.jpg"), kind: .image)
            XCTFail("a missing picture was looked at")
        } catch SubjectFinder.FindError.unreadable {}
    }

    // MARK: - The searches

    /// A stand-in for the work, held at a gate per file until the test lets it go, and logging the
    /// order the searches started in.
    private final class FakeWork: @unchecked Sendable {
        private let lock = NSLock()
        private var started: [String] = []
        private var open: Set<String> = []

        var log: [String] { lock.lock(); defer { lock.unlock() }; return started }

        func release(_ name: String) { lock.lock(); open.insert(name); lock.unlock() }

        private func isOpen(_ name: String) -> Bool { lock.lock(); defer { lock.unlock() }; return open.contains(name) }

        /// A synchronous leaf, for the reason `SubjectSearches` keeps its own: no lock across an await.
        private func record(_ name: String) { lock.lock(); started.append(name); lock.unlock() }

        func run(_ request: SubjectRequest, progress: SubjectFinder.Progress, cancelled: () -> Bool) async throws -> SubjectFinding {
            let name = request.url.lastPathComponent
            record(name)
            progress(0.1)
            progress(0.2)
            while !isOpen(name) {
                if cancelled() { throw CancellationError() }
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            return SubjectFinding(engine: "vision", uri: "file:///\(name).vkst", cached: false, kind: request.kind.rawValue,
                                  width: 320, height: 180, frames: 3, durationMs: 1000, subjects: [])
        }
    }

    private final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [Double] = []
        var values: [Double] { lock.lock(); defer { lock.unlock() }; return list }
        func add(_ value: Double) { lock.lock(); list.append(value); lock.unlock() }
    }

    private func searches(_ work: FakeWork) -> SubjectSearches {
        SubjectSearches(model: { "test" }, work: { request, _, progress, cancelled in
            try await work.run(request, progress: progress, cancelled: cancelled)
        })
    }

    private func until(_ condition: @escaping () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<1000 where !condition() { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(condition(), "never happened", file: file, line: line)
    }

    func testASecondCallForTheSameFileJoinsTheFirstAndBothAreAnswered() async throws {
        let work = FakeWork()
        let queue = searches(work)
        let url = file("a.mp4")
        let first = Heard(), second = Heard()
        async let a = queue.find(uri: "first", url: url, kind: .video, fps: 15, progress: { first.add($0) })
        try await until { queue.waiting == 1 }
        async let b = queue.find(uri: "second", url: url, kind: .video, fps: 15, progress: { second.add($0) })
        try await until { queue.waiting == 2 }
        work.release("a.mp4")
        let (one, two) = try await (a, b)
        XCTAssertEqual(work.log, ["a.mp4"], "one search for both")
        XCTAssertEqual(one.uri, two.uri)
        // Progress at most every quarter second, and a last word of 1 for each name.
        XCTAssertEqual(first.values, [0.1, 1])
        XCTAssertEqual(second.values.last, 1)
    }

    func testSearchesRunOneAtATimeInTheOrderAsked() async throws {
        let work = FakeWork()
        let queue = searches(work)
        async let a = queue.find(uri: "a", url: file("a.mp4"), kind: .video, fps: 15, progress: { _ in })
        try await until { work.log == ["a.mp4"] }
        async let b = queue.find(uri: "b", url: file("b.mp4"), kind: .video, fps: 15, progress: { _ in })
        async let c = queue.find(uri: "c", url: file("c.mp4"), kind: .video, fps: 15, progress: { _ in })
        try await until { queue.waiting == 3 }
        try await Task.sleep(nanoseconds: 50_000_000)
        XCTAssertEqual(work.log, ["a.mp4"], "nothing starts while one runs")
        work.release("b.mp4")
        work.release("c.mp4")
        work.release("a.mp4")
        _ = try await (a, b, c)
        XCTAssertEqual(work.log.first, "a.mp4")
        XCTAssertEqual(Set(work.log), ["a.mp4", "b.mp4", "c.mp4"])
        XCTAssertEqual(queue.waiting, 0)
    }

    func testStoppingCancelsEverySearchNotKeptWaitingOrRunning() async throws {
        let work = FakeWork()
        let queue = searches(work)
        let running = Task { try await queue.find(uri: "a", url: self.file("a.mp4"), kind: .video, fps: 15, progress: { _ in }) }
        try await until { work.log == ["a.mp4"] }
        let waiting = Task { try await queue.find(uri: "b", url: self.file("b.mp4"), kind: .video, fps: 15, progress: { _ in }) }
        try await until { queue.waiting == 2 }

        // Keep the one running: the waiting one is answered at once, and never starts.
        XCTAssertEqual(queue.stop(keep: ["a"]), 1)
        do {
            _ = try await waiting.value
            XCTFail("a stopped search answered")
        } catch is CancellationError {}
        XCTAssertEqual(work.log, ["a.mp4"])

        // And then everything: the running one stops between two of its frames.
        XCTAssertEqual(queue.stop(keep: nil), 1)
        do {
            _ = try await running.value
            XCTFail("a stopped search answered")
        } catch is CancellationError {}
        XCTAssertEqual(queue.stop(keep: nil), 0, "nothing is left to stop")

        // A call after the stop is a new search.
        work.release("a.mp4")
        let again = try await queue.find(uri: "a", url: file("a.mp4"), kind: .video, fps: 15, progress: { _ in })
        XCTAssertEqual(again.uri, "file:///a.mp4.vkst")
    }

    func testAFileWhoseTrackIsKeptIsAnsweredAtOnceWithoutASearch() async throws {
        let work = FakeWork()
        let queue = searches(work)
        let url = try await video("kept.mp4")
        let request = SubjectRequest(url: url, kind: .video, fps: 12)
        let key = SubjectCache.key(for: request, model: "test")
        let content = try await analyse(url, fps: 12)
        let written = try SubjectCache.write(content, key: key)
        defer { try? FileManager.default.removeItem(at: SubjectCache.file(key)) }
        XCTAssertFalse(written.cached)

        let heard = Heard()
        let answer = try await queue.find(uri: "kept", url: url, kind: nil, fps: 12, progress: { heard.add($0) })
        XCTAssertTrue(answer.cached)
        XCTAssertEqual(answer.uri, written.uri)
        XCTAssertEqual(answer.frames, content.frames.count)
        XCTAssertEqual(answer.width, content.width)
        XCTAssertEqual(answer.subjects, content.meta.subjects)
        XCTAssertEqual(work.log, [], "nothing was looked at")
        XCTAssertEqual(heard.values, [1])
        // The answer is the shape the bridge sends.
        let json = answer.json
        XCTAssertEqual(json["engine"] as? String, "vision")
        XCTAssertEqual(json["cached"] as? Bool, true)
        XCTAssertEqual(json["kind"] as? String, "video")
        XCTAssertEqual((json["subjects"] as? [[String: Any]])?.first?["id"] as? Int, 1)

        // Another rate, another track.
        XCTAssertNotEqual(SubjectCache.key(for: SubjectRequest(url: url, kind: .video, fps: 15), model: "test"), key)
        // A picture's rate is no part of it.
        XCTAssertEqual(SubjectCache.key(for: SubjectRequest(url: url, kind: .image, fps: 15), model: "test"),
                       SubjectCache.key(for: SubjectRequest(url: url, kind: .image, fps: 3), model: "test"))
    }

    func testAKeptFileThatIsNotATrackIsFoundAgain() throws {
        let key = "damaged-\(UUID().uuidString)"
        try FileManager.default.createDirectory(at: SubjectCache.folder, withIntermediateDirectories: true)
        try Data("VKST but not really".utf8).write(to: SubjectCache.file(key))
        defer { try? FileManager.default.removeItem(at: SubjectCache.file(key)) }
        XCTAssertNil(SubjectCache.hit(key))
    }

    func testTheLaunchSweepLetsGoOfATrackNothingHasAskedForInAWeek() throws {
        let folder = JobFolders.subjectsDir()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let old = folder.appendingPathComponent("\(UUID().uuidString).vkst")
        let recent = folder.appendingPathComponent("\(UUID().uuidString).vkst")
        for url in [old, recent] { try Data([1]).write(to: url) }
        defer { for url in [old, recent] { try? FileManager.default.removeItem(at: url) } }
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-8 * 24 * 60 * 60)], ofItemAtPath: old.path)
        try FileManager.default.setAttributes([.modificationDate: Date().addingTimeInterval(-2 * 24 * 60 * 60)], ofItemAtPath: recent.path)

        let walked = expectation(description: "the launch sweep's walk")
        JobFolders.sweepOnLaunch { walked.fulfill() }
        wait(for: [walked], timeout: 60)

        XCTAssertFalse(FileManager.default.fileExists(atPath: old.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: recent.path), "a draft opened two days ago still wants it")
    }

    // MARK: - Refusals

    func testRefusesACallWithNoFileOrAKindThatIsNeitherOfTheTwo() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.findSubjects, [:])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "uri is required")
        let url = try TestMedia.picture(file("photo.jpg"))
        let kind = try PluginCalls.reject(VideoComposerPlugin.findSubjects, ["uri": url.absoluteString, "kind": "audio"])
        XCTAssertEqual(kind.code, "invalid_spec")
    }

    func testReportsAFileThatIsNotThereOrHoldsNoPictureAsUnreadable() throws {
        for kind in ["image", "video"] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.findSubjects,
                                                   ["uri": file("never written.mp4").absoluteString, "kind": kind])
            XCTAssertEqual(rejection.code, "unreadable_input", kind)
        }
        let text = file("notes.txt")
        try Data("not a picture and not a video".utf8).write(to: text)
        XCTAssertEqual(try PluginCalls.reject(VideoComposerPlugin.findSubjects, ["uri": text.absoluteString]).code, "unreadable_input")
        XCTAssertEqual(try PluginCalls.reject(VideoComposerPlugin.findSubjects,
                                              ["uri": "content://media/external/images/media/7"]).code, "unreadable_input")
    }

    func testStoppingWithNothingToStopAnswersNoneAndNeverRejects() throws {
        let answer = try PluginCalls.resolve(VideoComposerPlugin.stopFindingSubjects, ["keep": "not a list"])
        XCTAssertEqual(answer["stopped"] as? Int, 0)
        XCTAssertEqual(try PluginCalls.resolve(VideoComposerPlugin.stopFindingSubjects, [:])["stopped"] as? Int, 0)
    }

    func testHoldsTheRateToOneToThirty() {
        XCTAssertEqual(SubjectFinder.fps(nil), 15)
        XCTAssertEqual(SubjectFinder.fps(.nan), 15)
        XCTAssertEqual(SubjectFinder.fps(0), 1)
        XCTAssertEqual(SubjectFinder.fps(120), 30)
        XCTAssertEqual(SubjectFinder.fps(12.5), 12.5)
    }

    #if targetEnvironment(simulator)

    // MARK: - The simulator

    /// Vision's segmenters do not run in the simulator (`SubjectSegmenters.simulatorHasNoSegmenter`),
    /// so the call refuses as a platform with none - once the file has been read.
    func testRefusesAsUnsupportedInTheSimulatorOnceTheFileHasBeenRead() async throws {
        let picture = try TestMedia.picture(file("photo.jpg"))
        let clip = try await video("clip.mp4")
        for (url, kind) in [(picture, MediaLabelsResult.Kind.image), (clip, .video)] {
            do {
                _ = try await SubjectFinder.analyse(SubjectRequest(url: url, kind: kind, fps: 15))
                XCTFail("\(url.lastPathComponent) was looked at in the simulator")
            } catch let SubjectFinder.FindError.unsupported(message) {
                XCTAssertEqual(message, SubjectSegmenters.simulatorHasNoSegmenter)
            }
        }
        for url in [picture, clip] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.findSubjects, ["uri": url.absoluteString, "fps": 400])
            XCTAssertEqual(rejection.code, "unsupported")
            XCTAssertEqual(rejection.message, SubjectSegmenters.simulatorHasNoSegmenter)
        }
    }

    #else

    // MARK: - What Vision finds, on a device

    func testFindsTheSubjectsOfAPictureAndKeepsTheTrack() throws {
        let url = try TestMedia.picture(file("photo.jpg"), left: .white, middle: .black, right: .black)
        let answer = try PluginCalls.resolve(VideoComposerPlugin.findSubjects, ["uri": url.absoluteString])
        XCTAssertEqual(answer["engine"] as? String, "vision")
        XCTAssertEqual(answer["kind"] as? String, "image")
        XCTAssertEqual(answer["frames"] as? Int, 1)
        XCTAssertEqual(answer["width"] as? Int, 320)
        XCTAssertEqual(answer["height"] as? Int, 213)
        XCTAssertEqual(answer["cached"] as? Bool, false)
        let track = try XCTUnwrap(JobFolders.fileURL(from: try XCTUnwrap(answer["uri"] as? String)))
        XCTAssertNoThrow(try SubjectTrack.parse(try Data(contentsOf: track)))
        let again = try PluginCalls.resolve(VideoComposerPlugin.findSubjects, ["uri": url.absoluteString])
        XCTAssertEqual(again["cached"] as? Bool, true)
        try? FileManager.default.removeItem(at: track)
    }

    #endif
}
