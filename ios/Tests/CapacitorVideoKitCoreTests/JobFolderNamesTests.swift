import Capacitor
import XCTest
@testable import CapacitorVideoKitCore

/// Which folder a batch id names, and that no id at all names one outside `video-batches`.
///
/// The rule it protects: `JobFolders.cleanup` deletes the folder it is given, so an id naming the
/// folder above `video-batches` - `..` did, and `.` and the empty id named `video-batches` itself -
/// takes every post, and Application Support with them. Every id that does name a folder keeps the
/// one it always had, because drafts and hosts hold on to it. Android's `JobFolderNamesTest` pins
/// the same.
///
/// The names are checked against the real `root`, as paths only: nothing is written there. Every
/// test that writes or deletes - `cleanup` of `..` above all - first puts a folder of its own in
/// Application Support's place (`temporaryApplicationSupport`), with a file beside `video-batches`
/// and another batch's folder inside it standing where the real Application Support and every other
/// post would be. Run against the real one, a regression that let an id out deleted the test
/// simulator's Application Support, which a mutation run once did.
final class JobFolderNamesTests: RenderTestCase {

    /// Application Support as it was before the test, put back in `tearDown` whatever happened.
    private var applicationSupport: URL!

    /// Every id that ever named a path outside its job folder, and the ones a page could send next.
    private let hostile = ["..", ".", "", "../x", "a/../..", "../..", "/", "./..", "x/.."]

    /// The ids every plugin refuses, with the words it refuses each in (`JobFolders.batchIdRefusal`).
    private let refusals = [("..", "batchId cannot be '.' or '..'"), (".", "batchId cannot be '.' or '..'"),
                            ("", "batchId is required")]

    override func setUpWithError() throws {
        try super.setUpWithError()
        applicationSupport = JobFolders.applicationSupport
    }

    override func tearDownWithError() throws {
        JobFolders.applicationSupport = applicationSupport
        try super.tearDownWithError()
    }

    /// A folder inside this test's own in Application Support's place, for the rest of the test,
    /// and so for `JobFolders.root` and `PublishStore.root` below it.
    private func temporaryApplicationSupport() throws {
        let base = file("Application Support")
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)
        JobFolders.applicationSupport = base
    }

    // MARK: - Names

    func testAnIdThatNamesAFolderKeepsTheFolderItAlwaysHad() {
        let names = [
            ("post-1", "post-1"),
            ("batch-3f2a.9", "batch-3f2a.9"),
            ("post 1", "post_1"),
            ("vo:abc", "vo_abc"),
            ("...", "..."),
            (".x", ".x"),
            ("__", "__"),
            ("../x", ".._x"),
            ("a/../..", "a_.._.."),
        ]
        for (id, name) in names {
            XCTAssertEqual(JobFolders.folderName(id), name, id)
            XCTAssertEqual(JobFolders.jobDir(id), JobFolders.root.appendingPathComponent(name, isDirectory: true), id)
            XCTAssertNil(JobFolders.batchIdRefusal(id), id)
        }
    }

    func testTheIdsThatNameNoFolderOfTheirOwnAreRefusedAndNamedOneInsideAllTheSame() {
        XCTAssertEqual(JobFolders.batchIdRefusal(".."), "batchId cannot be '.' or '..'")
        XCTAssertEqual(JobFolders.batchIdRefusal("."), "batchId cannot be '.' or '..'")
        XCTAssertEqual(JobFolders.batchIdRefusal(""), "batchId is required")

        XCTAssertEqual(JobFolders.jobDir(".."), JobFolders.root.appendingPathComponent("__", isDirectory: true))
        XCTAssertEqual(JobFolders.jobDir("."), JobFolders.root.appendingPathComponent("_", isDirectory: true))
        XCTAssertEqual(JobFolders.jobDir(""), JobFolders.root.appendingPathComponent("_", isDirectory: true))
    }

    func testNoIdNamesAPathOutsideItsFolderInVideoBatches() {
        let root = JobFolders.root.standardizedFileURL.path
        for id in hostile {
            let dir = JobFolders.jobDir(id).standardizedFileURL
            XCTAssertEqual(dir.deletingLastPathComponent().path, root, id)
            let paths = [
                JobFolders.inputsDir(id), JobFolders.stitched(id), JobFolders.poster(id),
                JobFolders.part(id, jobId: id), JobFolders.exportTmp(id), JobFolders.doneMarker(id),
                PictureStills.folder(id), RenderInputs.folder(id),
            ]
            for path in paths {
                XCTAssertEqual(path.standardizedFileURL.deletingLastPathComponent().path, dir.path, "\(id): \(path.path)")
            }
        }
    }

    // MARK: - cleanup and prepareJob

    func testCleanupOfAnyIdDeletesNothingOutsideItsOwnFolder() throws {
        try temporaryApplicationSupport()
        let outside = try write(dir.appendingPathComponent("outside.txt"))
        let besideRoot = try write(JobFolders.root.deletingLastPathComponent().appendingPathComponent("beside.txt"))
        let neighbour = try write(JobFolders.jobDir("neighbour").appendingPathComponent("stitched.mp4"))
        let own = try write(JobFolders.jobDir("../x").appendingPathComponent("stitched.mp4"))

        for id in hostile { JobFolders.cleanup(batchId: id) }

        let fm = FileManager.default
        XCTAssertTrue(fm.fileExists(atPath: outside.path), "a file above Application Support was deleted")
        XCTAssertTrue(fm.fileExists(atPath: besideRoot.path), "a file beside video-batches was deleted")
        XCTAssertTrue(fm.fileExists(atPath: neighbour.path), "another batch's folder was deleted")
        XCTAssertFalse(fm.fileExists(atPath: own.path), "`../x` names a folder of its own and cleanup still deletes it")
    }

    func testPrepareJobFilesAnIdWithDotsInItInsideVideoBatches() throws {
        try temporaryApplicationSupport()
        let prepared = try JobFolders.prepareJob(batchId: "../x", inputs: [])
        XCTAssertEqual(prepared.jobDir, JobFolders.root.appendingPathComponent(".._x", isDirectory: true))
        XCTAssertTrue(FileManager.default.fileExists(atPath: JobFolders.inputsDir("../x").path))
    }

    // MARK: - Through the plugin

    func testCleanupAndPrepareJobRefuseAnIdThatNamesNoFolderOfItsOwn() throws {
        try temporaryApplicationSupport()
        let methods: [(String, PluginCalls.Method)] = [
            ("cleanup", VideoComposerPlugin.cleanup), ("prepareJob", VideoComposerPlugin.prepareJob),
        ]
        for (name, method) in methods {
            for (id, message) in refusals {
                let rejection = try PluginCalls.reject(method, ["batchId": id, "inputs": [Any]()])
                XCTAssertEqual(rejection.code, "invalid_spec", "\(name) \(id)")
                XCTAssertEqual(rejection.message, message, "\(name) \(id)")
            }
        }
    }

    func testPrepareJobThroughThePluginStillTakesAnIdWithDotsInIt() throws {
        try temporaryApplicationSupport()
        let prepared = try PluginCalls.resolve(VideoComposerPlugin.prepareJob, ["batchId": "../x", "inputs": [Any]()])
        XCTAssertEqual(prepared["jobDir"] as? String, JobFolders.jobDir("../x").absoluteString)
    }

    func testComposeRefusesAnIdThatNamesNoFolderOfItsOwn() throws {
        try temporaryApplicationSupport()
        for id in ["..", ".", ""] {
            let spec = TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 1000)], batchId: id)
            let rejection = try PluginCalls.reject(VideoComposerPlugin.compose, spec)
            XCTAssertEqual(rejection.code, "invalid_spec", id)
            XCTAssertEqual(rejection.message, "invalid_spec:batchId", id)
        }
        let spec = TestSpecs.spec([TestSpecs.clip("a", file("a.mp4"), outMs: 1000)], batchId: "../x")
        XCTAssertEqual(try TestCalls.parse(spec).batchId, "../x")
    }

    // MARK: - The publisher

    func testClearingAPublishCalledDotDotKeepsEveryOtherOne() throws {
        // First, and at the real root: the store loads once a process, and its sweep of bodies with
        // no record has then run before one is placed.
        PublishStore.shared.load()
        try temporaryApplicationSupport()
        let bodies = PublishStore.root.appendingPathComponent("bodies", isDirectory: true)
        for id in ["..", "."] {
            XCTAssertEqual(PublishStore.bodiesDir(id).standardizedFileURL.deletingLastPathComponent().path,
                           bodies.standardizedFileURL.path, id)
        }
        let record = try write(PublishStore.root.appendingPathComponent("other.json"))
        let body = try write(bodies.appendingPathComponent("other/body.bin"))

        PublishStore.shared.delete("..")
        PublishStore.shared.delete(".")

        XCTAssertTrue(FileManager.default.fileExists(atPath: record.path), "another publish's record was deleted")
        XCTAssertTrue(FileManager.default.fileExists(atPath: body.path), "another publish's body was deleted")
    }

    func testPublishRefusesAnIdThatNamesNoFolderOfItsOwn() throws {
        func request(_ batchId: String) -> CAPPluginCall {
            TestCalls.call(["batchId": batchId,
                            "upload": ["url": "https://example.test/upload"],
                            "uploads": [["uploadId": "u1", "path": "/tmp/u1.mp4"]],
                            "finalize": ["url": "https://example.test/create", "bodyTemplate": "{}"]],
                           method: "publish")
        }
        for (id, _) in refusals {
            XCTAssertThrowsError(try PublishModels.parse(request(id)), id) { error in
                XCTAssertEqual((error as? PublishRequestError)?.message, "invalid_request:batchId", id)
            }
        }
        // Every other id is a batch like any other, as it is to the composer.
        XCTAssertEqual(try PublishModels.parse(request("../x")).batchId, "../x")
    }

    func testThePublishersOtherCallsRefuseTheSameIds() throws {
        // Loaded at the real root first, as above; then a regression that let `..` through to
        // `clear` would delete inside this test's own folder.
        PublishStore.shared.load()
        try temporaryApplicationSupport()
        let methods: [(String, (BackgroundPublisherPlugin) -> (CAPPluginCall) -> Void)] = [
            ("getState", BackgroundPublisherPlugin.getState), ("cancel", BackgroundPublisherPlugin.cancel),
            ("retry", BackgroundPublisherPlugin.retry), ("clear", BackgroundPublisherPlugin.clear),
        ]
        for (name, method) in methods {
            for (id, message) in refusals {
                let rejection = try PluginCalls.reject(BackgroundPublisherPlugin(), method, ["batchId": id])
                XCTAssertEqual(rejection.code, "invalid_request", "\(name) \(id)")
                XCTAssertEqual(rejection.message, message, "\(name) \(id)")
            }
        }
    }

    // MARK: - A voice take

    func testAVoiceTakeForAnIdThatNamesNoFolderOfItsOwnGoesIntoTheVoiceCache() {
        for id in [nil, "", ".", ".."] {
            XCTAssertEqual(VoiceRecorder.folder(for: id), JobFolders.voiceDir(), id ?? "nil")
        }
        XCTAssertEqual(VoiceRecorder.folder(for: "post-1"), JobFolders.inputsDir("post-1"))
        XCTAssertEqual(VoiceRecorder.folder(for: "../x"), JobFolders.root.appendingPathComponent(".._x/in", isDirectory: true))
    }

    // MARK: - The sweep

    func testAnUnfinishedPublishKeepsTheFolderItsIdIsRenamedTo() throws {
        // `post:1`'s folder is `post_1`. The sweep has only the folder's name, and a record is keyed
        // by the raw id, so looking the name up among the keys found nothing and let the folder of a
        // failed publish go at a week old, turning its Retry into `file_missing`.
        let id = "vk-test:\(UUID().uuidString)"
        let folder = file(JobFolders.folderName(id))
        XCTAssertNotEqual(folder.lastPathComponent, id)
        let stale = try write(folder.appendingPathComponent("stitched.mp4"))
        let weekAndADay = Date().addingTimeInterval(-(JobFolders.orphanTTL + 24 * 60 * 60))
        for url in [stale, folder] {
            try FileManager.default.setAttributes([.modificationDate: weekAndADay], ofItemAtPath: url.path)
        }
        // Never persisted, and forgotten again whatever happens, in a folder of this test's own
        // once the store has loaded at the real root.
        let store = PublishStore.shared
        store.load()
        try temporaryApplicationSupport()
        defer { store.delete(id) }
        var record = PublishRecord(batchId: id, headers: [:], uploadUrl: "https://example.test/u",
                                   finalizeUrl: "https://example.test/f", bodyTemplate: "{}",
                                   uploads: [], phase: Phase.failed, createdAt: 0, updatedAt: 0)
        store.update(record, persist: false)
        XCTAssertFalse(JobFolders.isSweepable(folder, now: Date()), "a failed publish's folder was sweepable")

        // Done, it is an unmarked folder like any other, and a week and a day is past its time.
        record.phase = Phase.done
        store.update(record, persist: false)
        XCTAssertTrue(JobFolders.isSweepable(folder, now: Date()))
    }

    // MARK: - Helpers

    /// A one-byte file at `url`, its folders made.
    private func write(_ url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1]).write(to: url)
        return url
    }
}
