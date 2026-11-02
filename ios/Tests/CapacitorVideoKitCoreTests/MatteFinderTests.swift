@preconcurrency import AVFoundation
import CoreVideo
import XCTest
@testable import CapacitorVideoKitCore

/// `findMatte`: which frames are looked at, how they are turned upright and onto the grid, and how an
/// engine that looks at each frame on its own is smoothed - checked with a segmenter of the tests' own,
/// which is sure wherever the frame is bright, because Vision's do not run in the simulator - then the
/// searches' queue, the cache, the launch sweep, and every way the call refuses. `SubjectFinderTests`'
/// arrangement, case for case where the two finders share one.
final class MatteFinderTests: RenderTestCase {

    // MARK: - Segmenters that run anywhere

    /// Sure (1) wherever the upright frame it is shown is bright, and not at all elsewhere.
    private final class Bright: MatteSegmenter {
        let target: String
        let smooth: Bool

        init(target: String, smooth: Bool) {
            self.target = target
            self.smooth = smooth
        }

        func confidence(of frame: CVPixelBuffer) throws -> MatteConfidence {
            CVPixelBufferLockBaseAddress(frame, .readOnly)
            defer { CVPixelBufferUnlockBaseAddress(frame, .readOnly) }
            let width = CVPixelBufferGetWidth(frame), height = CVPixelBufferGetHeight(frame)
            let stride = CVPixelBufferGetBytesPerRow(frame)
            let base = CVPixelBufferGetBaseAddress(frame)!.assumingMemoryBound(to: UInt8.self)
            var values = [Float](repeating: 0, count: width * height)
            for y in 0..<height {
                for x in 0..<width {
                    let p = base + y * stride + x * 4
                    values[y * width + x] = (Int(p[0]) + Int(p[1]) + Int(p[2])) / 3 > 128 ? 1 : 0
                }
            }
            return MatteConfidence(width: width, height: height, values: values)
        }
    }

    /// Sure of everything on its even frames and of nothing on its odd ones: the flicker a segmenter
    /// that looks at each frame on its own can have on footage that does not move.
    private final class Flicker: MatteSegmenter, @unchecked Sendable {
        let target = "subject"
        let smooth: Bool
        private var count = 0

        init(smooth: Bool) { self.smooth = smooth }

        func confidence(of frame: CVPixelBuffer) throws -> MatteConfidence {
            defer { count += 1 }
            return MatteConfidence(width: 1, height: 1, values: [count % 2 == 0 ? 1 : 0])
        }
    }

    /// A 30 fps video, stored `width` x `height`, white on the columns before `split` (a fraction) and
    /// black after, written with `transform`.
    private func video(_ name: String, durationMs: Int64 = 1000, width: Int = 320, height: Int = 240,
                       split: Double = 1.0 / 3, transform: CGAffineTransform = .identity) async throws -> URL {
        var rgba = [UInt8](repeating: 255, count: width * height * 4)
        for y in 0..<height {
            for x in 0..<width where Double(x) >= split * Double(width) {
                let i = (y * width + x) * 4
                rgba[i] = 0; rgba[i + 1] = 0; rgba[i + 2] = 0
            }
        }
        return try await TestMedia.frames(file(name), width: width, height: height,
                                          times: TestMedia.evenTimes(Int(durationMs * 30 / 1000)),
                                          transform: transform) { _ in rgba }
    }

    private func analyse(_ url: URL, kind: MediaLabelsResult.Kind = .video, target: String = "subject", fps: Double = 10,
                         segmenter: @escaping MatteFinder.MakeSegmenter = { target, _ in Bright(target: target, smooth: true) },
                         progress: @escaping MatteFinder.Progress = { _ in },
                         cancelled: @escaping @Sendable () -> Bool = { false }) async throws -> MatteTrackCoded {
        try await MatteFinder.analyse(MatteRequest(url: url, kind: kind, target: target, fps: fps), segmenter: segmenter,
                                      progress: progress, cancelled: cancelled)
    }

    /// The coded frames read back through the track they make.
    private func track(_ coded: MatteTrackCoded) throws -> MatteTrack {
        try MatteTrack.parse(try MatteTrack.encode(coded))
    }

    // MARK: - Which frames, and the grid

    func testLooksAtTheFirstFrameAtOrAfterEachTimeOnTheVideoGrid() async throws {
        let url = try await video("clip.mp4", durationMs: 1000)
        let coded = try await analyse(url, fps: 10)
        XCTAssertEqual(coded.times, [0, 100, 200, 300, 400, 500, 600, 700, 800, 900])
        // 512 cells on the longer side, whatever the footage's size: 320 x 240 is 512 x 384.
        XCTAssertEqual(coded.width, 512)
        XCTAssertEqual(coded.height, 384)
        XCTAssertEqual(coded.meta.kind, "video")
        XCTAssertEqual(coded.meta.engine, "vision")
        XCTAssertEqual(coded.meta.target, "subject")
        XCTAssertEqual(coded.meta.fps, 10)
        XCTAssertEqual(coded.meta.durationMs, 1000)
        let cells = try track(coded).frame(0)
        XCTAssertEqual(cells[192 * 512 + 50], 255, "the white third is the subject")
        XCTAssertEqual(cells[192 * 512 + 400], 0, "the black is not")
        XCTAssertEqual(coded.meta.coverage, 1.0 / 3, accuracy: 0.01)
        let box = try XCTUnwrap(coded.meta.box)
        XCTAssertEqual(box.x, 0)
        XCTAssertEqual(box.y, 0)
        XCTAssertEqual(box.h, 1)
        XCTAssertEqual(box.w, 1.0 / 3, accuracy: 0.01)
    }

    func testTurnsAFrameUprightBeforeItIsLookedAt() async throws {
        // Stored 320 x 240, white on its left third, turned a quarter clockwise as a phone held upright
        // writes it: upright it is 240 x 320, white across the TOP third.
        let url = try await video("turned.mp4", transform: CGAffineTransform(rotationAngle: .pi / 2))
        let coded = try await analyse(url)
        XCTAssertEqual(coded.width, 384)
        XCTAssertEqual(coded.height, 512)
        let cells = try track(coded).frame(0)
        XCTAssertEqual(cells[30 * 384 + 192], 255, "the top third is the subject")
        XCTAssertEqual(cells[480 * 384 + 192], 0, "the bottom is not")
        XCTAssertEqual(cells[30 * 384 + 5], 255, "across the whole width")
    }

    func testAPictureIsLookedAtOnceUprightAtThePictureGridOfWhatItKeeps() async throws {
        // Stored 600 x 400, white on its left third, orientation 6: upright 400 x 600, white on TOP.
        let url = try TestMedia.picture(file("photo.jpg"), left: .white, middle: .black, right: .black, orientation: 6)
        let subject = try await analyse(url, kind: .image, target: "subject")
        XCTAssertEqual(subject.times, [0])
        XCTAssertEqual(subject.width, 683)
        XCTAssertEqual(subject.height, 1024)
        XCTAssertEqual(subject.meta.kind, "image")
        XCTAssertEqual(subject.meta.durationMs, 0)
        XCTAssertEqual(subject.meta.fps, 0)
        let cells = try track(subject).frame(0)
        XCTAssertEqual(cells[60 * 683 + 300], 255)
        XCTAssertEqual(cells[900 * 683 + 300], 0)
        // People look at a picture at the video's grid, as Android has them.
        let people = try await analyse(url, kind: .image, target: "people")
        XCTAssertEqual(people.width, 341)
        XCTAssertEqual(people.height, 512)
        XCTAssertEqual(people.meta.target, "people")
    }

    func testSmoothsAnEngineThatLooksAtEachFrameOnItsOwnWhereThePictureStaysTheSame() async throws {
        let url = try await video("still.mp4", durationMs: 1000)
        // Footage that does not move: each new answer is 35% of what is kept.
        let smoothed = try track(try await analyse(url, fps: 10, segmenter: { _, _ in Flicker(smooth: true) }))
        XCTAssertEqual(try smoothed.frame(0)[0], 255)
        XCTAssertEqual(try smoothed.frame(1)[0], 166)
        XCTAssertEqual(try smoothed.frame(2)[0], 197)
        // An engine that smooths itself is kept as it answers.
        let kept = try track(try await analyse(url, fps: 10, segmenter: { _, _ in Flicker(smooth: false) }))
        XCTAssertEqual([try kept.frame(0)[0], try kept.frame(1)[0], try kept.frame(2)[0]], [255, 0, 255])
    }

    func testReportsHowFarItHasGotAndStopsBetweenTwoFramesWhenAsked() async throws {
        let url = try await video("clip.mp4", durationMs: 1000)
        let heard = Heard()
        _ = try await analyse(url, fps: 10, progress: { heard.add($0) })
        // A 0 as the looking starts, then one for each of the ten frames.
        XCTAssertEqual(heard.values.count, 11)
        XCTAssertEqual(heard.values.first, 0)
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
        } catch MatteFinder.FindError.unreadable {}
        do {
            _ = try await analyse(file("never.mp4"))
            XCTFail("a missing file was looked at")
        } catch MatteFinder.FindError.unreadable {}
        do {
            _ = try await analyse(file("never.jpg"), kind: .image)
            XCTFail("a missing picture was looked at")
        } catch MatteFinder.FindError.unreadable {}
    }

    // MARK: - The searches

    /// A stand-in for the work, held at a gate per file until the test lets it go, and logging the order
    /// the searches started in.
    private final class FakeWork: @unchecked Sendable {
        private let lock = NSLock()
        private var started: [String] = []
        private var open: Set<String> = []

        var log: [String] { lock.lock(); defer { lock.unlock() }; return started }

        func release(_ name: String) { lock.lock(); open.insert(name); lock.unlock() }

        private func isOpen(_ name: String) -> Bool { lock.lock(); defer { lock.unlock() }; return open.contains(name) }

        private func record(_ name: String) { lock.lock(); started.append(name); lock.unlock() }

        func run(_ request: MatteRequest, progress: MatteFinder.Progress, cancelled: () -> Bool) async throws -> MatteFinding {
            let name = request.url.lastPathComponent
            record(name)
            progress(0.1)
            progress(0.2)
            while !isOpen(name) {
                if cancelled() { throw CancellationError() }
                try await Task.sleep(nanoseconds: 5_000_000)
            }
            let meta = MatteTrackMeta(engine: "vision", kind: request.kind.rawValue, target: request.target, durationMs: 1000,
                                      fps: request.fps, coverage: 0.4, box: MatteBox(x: 0, y: 0, w: 0.5, h: 1))
            let track = try MatteTrack.parse(try MatteTrack.encode(MatteTrackContent(width: 4, height: 2, times: [0],
                                                                                     frames: [[255, 0, 0, 0, 255, 0, 0, 0]], meta: meta)))
            return MatteFinding(track: track, meta: meta, uri: "file:///\(name).vkmt", cached: false)
        }
    }

    private final class Heard: @unchecked Sendable {
        private let lock = NSLock()
        private var list: [Double] = []
        var values: [Double] { lock.lock(); defer { lock.unlock() }; return list }
        func add(_ value: Double) { lock.lock(); list.append(value); lock.unlock() }
    }

    /// The searches, keeping whatever `keeps` says is kept here, with the model left out of it.
    private func searches(_ work: FakeWork, keeps: @escaping @Sendable (String) -> String = { $0 }) -> MatteSearches {
        MatteSearches(target: keeps, model: { _ in "test" }, work: { request, _, progress, cancelled in
            try await work.run(request, progress: progress, cancelled: cancelled)
        })
    }

    private func until(_ condition: @escaping () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<1000 where !condition() { try await Task.sleep(nanoseconds: 5_000_000) }
        XCTAssertTrue(condition(), "never happened", file: file, line: line)
    }

    func testASecondCallForTheSameTrackJoinsTheFirstAndBothAreAnswered() async throws {
        let work = FakeWork()
        let queue = searches(work)
        let url = file("a.mp4")
        let first = Heard(), second = Heard()
        async let a = queue.find(uri: "first", url: url, kind: .video, target: "subject", fps: 10, progress: { first.add($0) })
        try await until { queue.waiting == 1 }
        async let b = queue.find(uri: "second", url: url, kind: .video, target: "subject", fps: 10, progress: { second.add($0) })
        try await until { queue.waiting == 2 }
        work.release("a.mp4")
        let (one, two) = try await (a, b)
        XCTAssertEqual(work.log, ["a.mp4"], "one search for both")
        XCTAssertEqual(one.uri, two.uri)
        // Progress at most every quarter second, and a last word of 1 for each name.
        XCTAssertEqual(first.values, [0.1, 1])
        XCTAssertEqual(second.values.last, 1)
        // The answer is the shape the bridge sends.
        XCTAssertEqual(one.json["coverage"] as? Double, 0.4)
        XCTAssertEqual((one.json["box"] as? [String: Any])?["w"] as? Double, 0.5)
        XCTAssertEqual(one.json["target"] as? String, "subject")
    }

    func testKeepingTheSubjectAndThePeopleAreTwoSearchesWhereTheyAreTwoTracks() async throws {
        let work = FakeWork()
        let queue = searches(work)
        let url = file("a.mp4")
        async let subject = queue.find(uri: "a", url: url, kind: .video, target: "subject", fps: 10, progress: { _ in })
        try await until { work.log.count == 1 }
        async let people = queue.find(uri: "a", url: url, kind: .video, target: "people", fps: 15, progress: { _ in })
        try await until { queue.waiting == 2 }
        work.release("a.mp4")
        let (s, p) = try await (subject, people)
        XCTAssertEqual(work.log, ["a.mp4", "a.mp4"], "two tracks, two searches")
        XCTAssertEqual(s.target, "subject")
        XCTAssertEqual(p.target, "people")
    }

    func testOnAnOSThatKeepsOnlyPeopleASubjectCallJoinsAPeopleCallAndEachIsToldUnderItsOwnTarget() async throws {
        let work = FakeWork()
        // iOS 16: whatever is asked, people are kept.
        let queue = searches(work, keeps: { _ in "people" })
        let url = file("a.mp4")
        let asSubject = Heard(), asPeople = Heard()
        async let s = queue.find(uri: "a", url: url, kind: .video, target: "subject", fps: 10, progress: { asSubject.add($0) })
        try await until { queue.waiting == 1 }
        async let p = queue.find(uri: "a", url: url, kind: .video, target: "people", fps: 10, progress: { asPeople.add($0) })
        try await until { queue.waiting == 2 }
        work.release("a.mp4")
        let (one, two) = try await (s, p)
        XCTAssertEqual(work.log, ["a.mp4"], "one track, one search")
        XCTAssertEqual(one.target, "people")
        XCTAssertEqual(two.target, "people")
        XCTAssertEqual(asSubject.values.last, 1)
        XCTAssertEqual(asPeople.values.last, 1)
    }

    func testStoppingCancelsEverySearchNotKeptWaitingOrRunning() async throws {
        let work = FakeWork()
        let queue = searches(work)
        let running = Task { try await queue.find(uri: "a", url: self.file("a.mp4"), kind: .video, target: "subject", fps: 10, progress: { _ in }) }
        try await until { work.log == ["a.mp4"] }
        let waiting = Task { try await queue.find(uri: "b", url: self.file("b.mp4"), kind: .video, target: "subject", fps: 10, progress: { _ in }) }
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
    }

    // MARK: - The cache

    private func coded(target: String = "subject") -> MatteTrackCoded {
        MatteTrackCoded(width: 4, height: 2, times: [0, 100],
                        packets: [MatteTrack.encodePackets([255, 255, 0, 0, 255, 255, 0, 0]),
                                  MatteTrack.encodePackets([0, 0, 255, 255, 0, 0, 255, 255])],
                        meta: MatteTrackMeta(engine: "vision", kind: "video", target: target, durationMs: 1000, fps: 10,
                                             coverage: 0.5, box: MatteBox(x: 0, y: 0, w: 1, h: 1)))
    }

    func testAKeptTrackIsAnsweredAtOnceWithoutASearch() async throws {
        let work = FakeWork()
        let queue = searches(work)
        let url = try await video("kept.mp4")
        let key = MatteCache.key(for: MatteRequest(url: url, kind: .video, target: "subject", fps: 12), model: "test")
        let written = try MatteCache.write(coded(), key: key)
        defer { try? FileManager.default.removeItem(at: MatteCache.file(key)) }
        XCTAssertFalse(written.cached)
        XCTAssertEqual(written.frames, 2)

        let heard = Heard()
        let answer = try await queue.find(uri: "kept", url: url, kind: nil, target: "subject", fps: 12, progress: { heard.add($0) })
        XCTAssertTrue(answer.cached)
        XCTAssertEqual(answer.uri, written.uri)
        XCTAssertEqual(answer.width, 4)
        XCTAssertEqual(answer.coverage, 0.5)
        XCTAssertEqual(work.log, [], "nothing was looked at")
        XCTAssertEqual(heard.values, [1])
        // The track is kept where the WebView reads it from: a file in the app's caches.
        XCTAssertTrue(answer.uri.hasPrefix("file://"))
        XCTAssertTrue(answer.uri.contains("/Library/Caches/video-composer/mattes/"), answer.uri)
    }

    func testTheKeyIsTheFileHowItIsReadWhatItKeepsAndTheModel() throws {
        let url = file("a.mp4")
        try Data([1, 2, 3]).write(to: url)
        let base = MatteCache.key(for: MatteRequest(url: url, kind: .video, target: "subject", fps: 10), model: "m")
        XCTAssertNotEqual(MatteCache.key(for: MatteRequest(url: url, kind: .video, target: "people", fps: 10), model: "m"), base)
        XCTAssertNotEqual(MatteCache.key(for: MatteRequest(url: url, kind: .video, target: "subject", fps: 15), model: "m"), base)
        XCTAssertNotEqual(MatteCache.key(for: MatteRequest(url: url, kind: .video, target: "subject", fps: 10), model: "n"), base)
        // A picture's rate is no part of it.
        XCTAssertEqual(MatteCache.key(for: MatteRequest(url: url, kind: .image, target: "subject", fps: 3), model: "m"),
                       MatteCache.key(for: MatteRequest(url: url, kind: .image, target: "subject", fps: 30), model: "m"))
    }

    func testAKeptFileThatIsNotATrackIsFoundAgain() throws {
        let key = "damaged-\(UUID().uuidString)"
        try FileManager.default.createDirectory(at: MatteCache.folder, withIntermediateDirectories: true)
        try Data("VKMT but not really".utf8).write(to: MatteCache.file(key))
        defer { try? FileManager.default.removeItem(at: MatteCache.file(key)) }
        XCTAssertNil(MatteCache.hit(key))
    }

    func testTheCacheIsHeldToItsCeilingOldestFirstNeverWhatWasJustKeptOrIsInUse() throws {
        // A folder of the test's own, so nothing else the simulator's cache holds takes part.
        let folder = file("mattes")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let now = Date()
        func kept(_ name: String, ageHours: Double) throws -> URL {
            let url = folder.appendingPathComponent("\(name)-\(UUID().uuidString).vkmt")
            try Data(count: 1000).write(to: url)
            try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-ageHours * 3600)], ofItemAtPath: url.path)
            return url
        }
        let oldest = try kept("oldest", ageHours: 30)
        let older = try kept("older", ageHours: 20)
        let recent = try kept("recent", ageHours: 1)
        let fresh = try kept("fresh", ageHours: 25)
        let orphan = folder.appendingPathComponent(".\(UUID().uuidString).tmp")
        try Data(count: 10).write(to: orphan)
        try FileManager.default.setAttributes([.modificationDate: now.addingTimeInterval(-3600)], ofItemAtPath: orphan.path)
        // Four tracks of a kilobyte each against a ceiling of one and a half: every track that may go goes,
        // oldest first, and the two that may not stay although the folder is still over it.
        MatteCache.trim(keep: fresh, now: now, limit: 1500, in: folder)
        XCTAssertFalse(FileManager.default.fileExists(atPath: oldest.path), "the oldest goes first")
        XCTAssertFalse(FileManager.default.fileExists(atPath: older.path), "then the next that may go")
        XCTAssertTrue(FileManager.default.fileExists(atPath: fresh.path), "never the one just kept")
        XCTAssertTrue(FileManager.default.fileExists(atPath: recent.path), "never one asked for in the last two hours")
        XCTAssertFalse(FileManager.default.fileExists(atPath: orphan.path), "a half-written file half an hour old is gone")
    }

    func testTheLaunchSweepLetsGoOfATrackNothingHasAskedForInAWeek() throws {
        let folder = JobFolders.mattesDir()
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let old = folder.appendingPathComponent("\(UUID().uuidString).vkmt")
        let recent = folder.appendingPathComponent("\(UUID().uuidString).vkmt")
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

    func testRefusesACallWithNoFileOrAKindOrTargetItDoesNotKnow() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.findMatte, [:])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "uri is required")
        let url = try TestMedia.picture(file("photo.jpg"))
        let kind = try PluginCalls.reject(VideoComposerPlugin.findMatte, ["uri": url.absoluteString, "kind": "audio"])
        XCTAssertEqual(kind.code, "invalid_spec")
        XCTAssertEqual(kind.message, "kind must be 'video' or 'image'")
        let target = try PluginCalls.reject(VideoComposerPlugin.findMatte, ["uri": url.absoluteString, "target": "pets"])
        XCTAssertEqual(target.code, "invalid_spec")
        XCTAssertEqual(target.message, "target must be 'subject' or 'people'")
    }

    func testReportsAFileThatIsNotThereOrHoldsNoPictureAsUnreadable() throws {
        for kind in ["image", "video"] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.findMatte,
                                                   ["uri": file("never written.mp4").absoluteString, "kind": kind])
            XCTAssertEqual(rejection.code, "unreadable_input", kind)
        }
        let text = file("notes.txt")
        try Data("not a picture and not a video".utf8).write(to: text)
        XCTAssertEqual(try PluginCalls.reject(VideoComposerPlugin.findMatte, ["uri": text.absoluteString]).code, "unreadable_input")
        XCTAssertEqual(try PluginCalls.reject(VideoComposerPlugin.findMatte,
                                              ["uri": "content://media/external/images/media/7"]).code, "unreadable_input")
    }

    func testStoppingWithNothingToStopAnswersNoneAndNeverRejects() throws {
        let answer = try PluginCalls.resolve(VideoComposerPlugin.stopFindingMattes, ["keep": "not a list"])
        XCTAssertEqual(answer["stopped"] as? Int, 0)
        XCTAssertEqual(try PluginCalls.resolve(VideoComposerPlugin.stopFindingMattes, [:])["stopped"] as? Int, 0)
    }

    #if targetEnvironment(simulator)

    // MARK: - The simulator

    /// Vision's segmenters do not run in the simulator (`SubjectSegmenters.simulatorHasNoSegmenter`), so
    /// the call refuses as a platform with none - once the file has been read.
    func testRefusesAsUnsupportedInTheSimulatorOnceTheFileHasBeenRead() async throws {
        let picture = try TestMedia.picture(file("photo.jpg"))
        let clip = try await video("clip.mp4")
        for (url, kind) in [(picture, MediaLabelsResult.Kind.image), (clip, .video)] {
            do {
                _ = try await MatteFinder.analyse(MatteRequest(url: url, kind: kind, target: "subject", fps: 10))
                XCTFail("\(url.lastPathComponent) was looked at in the simulator")
            } catch let MatteFinder.FindError.unsupported(message) {
                XCTAssertEqual(message, MatteSegmenters.simulatorHasNoSegmenter)
            }
        }
        for url in [picture, clip] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.findMatte, ["uri": url.absoluteString, "fps": 400])
            XCTAssertEqual(rejection.code, "unsupported")
            XCTAssertEqual(rejection.message, MatteSegmenters.simulatorHasNoSegmenter)
        }
    }

    #else

    // MARK: - What Vision finds, on a device

    func testFindsTheMatteOfAPictureAndKeepsTheTrack() throws {
        let url = try TestMedia.picture(file("photo.jpg"), left: .white, middle: .black, right: .black)
        let answer = try PluginCalls.resolve(VideoComposerPlugin.findMatte, ["uri": url.absoluteString])
        XCTAssertEqual(answer["engine"] as? String, "vision")
        XCTAssertEqual(answer["kind"] as? String, "image")
        XCTAssertEqual(answer["frames"] as? Int, 1)
        XCTAssertEqual(answer["cached"] as? Bool, false)
        // iOS 17 keeps whatever stands out, on the picture grid; iOS 16 only people, on the video's.
        let subject = MatteSegmenters.target(for: "subject") == "subject"
        XCTAssertEqual(answer["target"] as? String, subject ? "subject" : "people")
        XCTAssertEqual(answer["width"] as? Int, subject ? 1024 : 512)
        XCTAssertEqual(answer["height"] as? Int, subject ? 683 : 341)
        let track = try XCTUnwrap(JobFolders.fileURL(from: try XCTUnwrap(answer["uri"] as? String)))
        XCTAssertNoThrow(try MatteTrack.parse(try Data(contentsOf: track)))
        let again = try PluginCalls.resolve(VideoComposerPlugin.findMatte, ["uri": url.absoluteString])
        XCTAssertEqual(again["cached"] as? Bool, true)
        try? FileManager.default.removeItem(at: track)
    }

    #endif
}
