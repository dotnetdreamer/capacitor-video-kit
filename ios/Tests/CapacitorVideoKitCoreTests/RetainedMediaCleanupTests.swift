import Capacitor
import XCTest
@testable import CapacitorVideoKitCore

/// `releaseMedia` and `sweepMedia`: which of the kit's copies go when a host says it has stopped
/// using them, which stay, and that nothing outside the two copy folders is ever touched - by them,
/// or by the job folder housekeeping that runs beside them.
///
/// Both copy folders are emptied before and after every test. A sweep deletes everything in them
/// that it is not told to keep, and its count is only worth checking against a folder that holds
/// nothing but this test's files. What `handOut` remembers is not emptied, because it lasts as long
/// as the process, so a copy a test hands out has a name no other test uses.
final class RetainedMediaCleanupTests: XCTestCase {

    /// Files and folders this test placed outside the copy folders, removed in `tearDown`.
    private var placed: [URL] = []

    /// Old enough for any sweep in these tests to take, and far enough from `before` that no clock
    /// rounding can move it across.
    private let longAgo = Date().addingTimeInterval(-2 * 24 * 60 * 60)

    override func setUpWithError() throws {
        for folder in RetainedMedia.copyFolders { try? FileManager.default.removeItem(at: folder) }
    }

    override func tearDownWithError() throws {
        for url in placed { try? FileManager.default.removeItem(at: url) }
        placed = []
        for folder in RetainedMedia.copyFolders { try? FileManager.default.removeItem(at: folder) }
    }

    // MARK: - release

    func testReleaseDeletesTheKitsCopiesByAnyNameTheyWereStoredUnder() throws {
        let picked = try copy("videokit-picked/\(UUID().uuidString).mov")
        let item = GalleryLibrary.copiesFolder.appendingPathComponent("item", isDirectory: true)
        let gallery = try copy("videokit-gallery/item/1700000000000/IMG_0042.MOV")
        let sibling = try copy("videokit-gallery/item/original/IMG_0042.MOV")

        RetainedMedia.release([picked.absoluteString, stale(gallery)])

        XCTAssertFalse(exists(picked))
        XCTAssertFalse(exists(gallery), "a name from before an update still finds its copy")
        XCTAssertFalse(exists(gallery.deletingLastPathComponent()), "the version folder it emptied goes with it")
        XCTAssertTrue(exists(sibling), "a copy nobody named stays")
        XCTAssertTrue(exists(item))
        for folder in RetainedMedia.copyFolders { XCTAssertTrue(exists(folder), "the copy folders stay") }

        // The last copy of an item takes the item's folder too, and stops at the copy folder.
        RetainedMedia.release([sibling.path])
        XCTAssertFalse(exists(item))
        XCTAssertTrue(exists(GalleryLibrary.copiesFolder))
    }

    func testReleaseNeverDeletesAnythingElse() throws {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let documents = try place(home.appendingPathComponent("Documents/vk-test-\(UUID().uuidString).mov"))
        let caches = try place(home.appendingPathComponent("Library/Caches/vk-test-\(UUID().uuidString)/clip.mp4"))
        let support = try place(home.appendingPathComponent(
            "Library/Application Support/vk-test-\(UUID().uuidString)/clip.mp4"))
        let sound = try place(SoundLibrary.dir.appendingPathComponent("vk-test-\(UUID().uuidString).m4a"))
        let render = try place(JobFolders.jobDir("vk-test-\(UUID().uuidString)").appendingPathComponent("stitched.mp4"))
        placed += [caches, support, render].map { $0.deletingLastPathComponent() }
        let pickedFolder = RetainedMedia.pickedFolder
        // There, so that a name which climbs out of it through `..` names a real file.
        try JobFolders.ensure(pickedFolder)
        let item = try copy("videokit-gallery/item/original/IMG_0042.MOV")

        RetainedMedia.release([
            documents.absoluteString, caches.absoluteString, support.path, sound.absoluteString,
            render.absoluteString,
            // Named THROUGH a copy folder, but not in one.
            pickedFolder.path + "/../" + support.deletingLastPathComponent().lastPathComponent + "/clip.mp4",
            // The folders, which are not copies.
            pickedFolder.absoluteString, GalleryLibrary.copiesFolder.absoluteString,
            item.deletingLastPathComponent().absoluteString,
            "content://media/external/video/media/42", "videokit-picked/clip.mov", "",
        ])

        for file in [documents, caches, support, sound, render, item] {
            XCTAssertTrue(exists(file), file.path)
        }
    }

    // MARK: - sweep

    func testSweepKeepsWhatIsNamedAndWhatIsNewAndDeletesTheRest() throws {
        let keptPick = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)
        let oldPick = try copy("videokit-picked/\(UUID().uuidString).mp4", dated: longAgo)
        let freshPick = try copy("videokit-picked/\(UUID().uuidString).mov")
        let keptGallery = try copy("videokit-gallery/kept/original/IMG_0001.MOV", dated: longAgo)
        let oldGallery = try copy("videokit-gallery/old/1700000000000/IMG_0002.MOV", dated: longAgo)
        let legacyGallery = try copy("videokit-gallery/legacy-IMG_0003.MOV", dated: longAgo)
        let emptyFolder = GalleryLibrary.copiesFolder.appendingPathComponent("empty/original", isDirectory: true)
        try FileManager.default.createDirectory(at: emptyFolder, withIntermediateDirectories: true)
        let outside = try place(URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Documents/vk-test-\(UUID().uuidString).mov"), dated: longAgo)

        let removed = RetainedMedia.sweep(keep: [
            keptPick.absoluteString,
            // Stored before an update, in another container.
            stale(keptGallery),
            // Names that keep nothing, and break nothing.
            outside.absoluteString, "content://media/external/video/media/42", "",
            RetainedMedia.pickedFolder.appendingPathComponent("gone.mov").absoluteString,
        ], before: Date().addingTimeInterval(-60 * 60))

        XCTAssertEqual(removed, 3)
        XCTAssertTrue(exists(keptPick))
        XCTAssertTrue(exists(keptGallery), "a name from before an update still keeps its copy")
        XCTAssertTrue(exists(freshPick), "a copy dated after `before` is being picked right now")
        XCTAssertFalse(exists(oldPick))
        XCTAssertFalse(exists(oldGallery))
        XCTAssertFalse(exists(legacyGallery))
        XCTAssertFalse(exists(oldGallery.deletingLastPathComponent().deletingLastPathComponent()),
                       "the item folder it left empty")
        XCTAssertFalse(exists(emptyFolder.deletingLastPathComponent()), "an empty folder, however deep")
        XCTAssertTrue(exists(keptGallery.deletingLastPathComponent()))
        XCTAssertTrue(exists(outside), "nothing outside the copy folders is ever swept")
        for folder in RetainedMedia.copyFolders { XCTAssertTrue(exists(folder), "the copy folders stay") }
    }

    func testSweepKeepsACopyByEveryWayItsNameIsWritten() throws {
        let played = try copy("videokit-picked/\(UUID().uuidString).MOV", dated: longAgo)
        let withFragment = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)
        let oneSlash = try copy("videokit-picked/\(UUID().uuidString).mp4", dated: longAgo)
        let relativeName = "videokit-gallery/\(UUID().uuidString)/original/IMG_0042.MOV"
        let relative = try copy(relativeName, dated: longAgo)
        let playedStale = try copy("videokit-gallery/\(UUID().uuidString)/original/IMG 0043.MOV", dated: longAgo)
        let unnamed = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)

        let removed = RetainedMedia.sweep(keep: [
            // The URL a web view plays a file by, `Capacitor.convertFileSrc`'s, and the same with
            // the fragment a host adds to have iOS draw the first frame.
            playback(played.path), playback(withFragment.path) + "#t=0.1",
            "file:" + oneSlash.path,
            // Relative to Application Support, the way the two folders are matched.
            relativeName,
            // Played in another install's container.
            playback(stale(playedStale)),
        ], before: Date())

        XCTAssertEqual(removed, 1)
        for kept in [played, withFragment, oneSlash, relative, playedStale] {
            XCTAssertTrue(exists(kept), kept.lastPathComponent)
        }
        XCTAssertFalse(exists(unnamed))
    }

    func testSweepPassesOverWhatThisProcessHandedOutWhateverItsDate() throws {
        // A pick `retain` moved in, then dated as though long ago.
        let pickerFolder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        placed.append(pickerFolder)
        let retained = RetainedMedia.retain(try place(pickerFolder.appendingPathComponent("clip.mov")).absoluteString)
        let pick = try XCTUnwrap(JobFolders.fileURL(from: retained.uri))
        try FileManager.default.setAttributes([.modificationDate: longAgo], ofItemAtPath: pick.path)
        // A gallery copy made in an earlier launch, which `resolve` found on disk and handed out.
        let item = "videokit-gallery/\(UUID().uuidString)"
        let reused = try copy("\(item)/original/IMG_0042.MOV", dated: longAgo)
        XCTAssertTrue(RetainedMedia.handOut(reused))
        XCTAssertFalse(RetainedMedia.handOut(reused.deletingLastPathComponent().appendingPathComponent("gone.MOV")),
                       "a copy that is not there is not handed out")
        let sibling = try copy("\(item)/1700000000000/IMG_0042.MOV", dated: longAgo)

        let removed = RetainedMedia.sweep(keep: [], before: Date())

        XCTAssertEqual(removed, 1)
        XCTAssertTrue(exists(pick))
        XCTAssertTrue(exists(reused))
        XCTAssertFalse(exists(sibling), "handed out by nobody")

        // The host saying it is done with one still deletes it.
        RetainedMedia.release([retained.uri])
        XCTAssertFalse(exists(pick))
    }

    func testSweepKeepsWhatARenderStillInProgressReads() async throws {
        let clip = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)
        let music = try copy("videokit-gallery/\(UUID().uuidString)/original/song.m4a", dated: longAgo)
        let batchId = "retained-test-\(UUID().uuidString)"
        placed.append(JobFolders.jobDir(batchId))
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("v", clip, outMs: 500)], batchId: batchId, [
            "audio": ["originalMuted": false, "originalVolume": 1, "voiceover": [Any](),
                      "music": ["uri": music.absoluteString, "startMs": 0, "inMs": 0, "outMs": 500,
                                "volume": 1, "loop": false, "fadeInMs": 0, "fadeOutMs": 0]],
        ]))

        JobRegistry.shared.start(spec: spec)

        // Three bytes are no video, so the render fails, but nothing collects that outcome until
        // below: running or failed, the job is live here either way.
        XCTAssertEqual(RetainedMedia.sweep(keep: [], before: Date()), 0)
        XCTAssertTrue(exists(clip))
        XCTAssertTrue(exists(music))

        var state: String?
        for _ in 0..<600 {
            state = JobRegistry.shared.stateJSON(spec.jobId)?["state"] as? String
            if ["done", "failed", "interrupted"].contains(state ?? "") { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        XCTAssertEqual(state, "failed")

        // Collected, so nothing reads them any more.
        XCTAssertEqual(RetainedMedia.sweep(keep: [], before: Date()), 2)
        XCTAssertFalse(exists(clip))
        XCTAssertFalse(exists(music))
    }

    func testSweepWithNothingToDoRemovesNothing() throws {
        XCTAssertEqual(RetainedMedia.sweep(keep: [], before: Date()), 0, "no folders yet")
        let fresh = try copy("videokit-picked/\(UUID().uuidString).mov")
        XCTAssertEqual(RetainedMedia.sweep(keep: [], before: Date().addingTimeInterval(-60)), 0)
        XCTAssertTrue(exists(fresh))
    }

    // MARK: - Through the plugin

    func testSweepMediaReadsBeforeAsMillisecondsAndAnswersTheCount() throws {
        let old = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)
        let kept = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)
        let before = (Date().timeIntervalSince1970 - 60 * 60) * 1000

        let answer = try PluginCalls.resolve(VideoComposerPlugin.sweepMedia,
                                             ["keep": [kept.absoluteString], "before": before])

        XCTAssertEqual(answer["removed"] as? Int, 1)
        XCTAssertFalse(exists(old))
        XCTAssertTrue(exists(kept))
    }

    func testSweepMediaRefusesAMissingArgumentRatherThanGuessing() throws {
        let pick = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)
        let now = Date().timeIntervalSince1970 * 1000
        for (options, message) in [(["before": now], "keep is required"),
                                   (["keep": [String]()], "before is required")] as [([String: Any], String)] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.sweepMedia, options)
            XCTAssertEqual(rejection.code, "invalid_spec")
            XCTAssertEqual(rejection.message, message)
        }
        XCTAssertTrue(exists(pick))
    }

    func testReleaseMediaDeletesTheNamedCopies() throws {
        let pick = try copy("videokit-picked/\(UUID().uuidString).mov")
        _ = try PluginCalls.resolve(VideoComposerPlugin.releaseMedia, ["uris": [pick.absoluteString, "content://x"]])
        XCTAssertFalse(exists(pick))

        let rejection = try PluginCalls.reject(VideoComposerPlugin.releaseMedia, [:])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "uris is required")
    }

    // MARK: - The job folders leave the copies alone

    func testAPostCopiesARetainedPickAndLeavesItForTheDraft() throws {
        XCTAssertFalse(JobFolders.isAppOwned(RetainedMedia.pickedFolder.appendingPathComponent("clip.mov")))

        let pick = try copy("videokit-picked/\(UUID().uuidString).mov")
        let batchId = "retained-test-\(UUID().uuidString)"
        placed.append(JobFolders.jobDir(batchId))
        let prepared = try JobFolders.prepareJob(batchId: batchId, inputs: [(key: "seg-1", uri: pick.absoluteString)])

        XCTAssertTrue(exists(pick), "a draft still points at it")
        let placedInput = try XCTUnwrap(prepared.inputs.first.flatMap { JobFolders.fileURL(from: $0.uri) })
        XCTAssertEqual(try Data(contentsOf: placedInput), try Data(contentsOf: pick))
    }

    func testTheLaunchSweepNeverLooksInTheCopyFolders() throws {
        let pick = try copy("videokit-picked/\(UUID().uuidString).mov", dated: longAgo)
        let gallery = try copy("videokit-gallery/item/original/IMG_0042.MOV", dated: longAgo)

        // A month from now, when every TTL the launch sweep knows has long run out.
        JobFolders.sweep(now: Date().addingTimeInterval(30 * 24 * 60 * 60))

        XCTAssertTrue(exists(pick))
        XCTAssertTrue(exists(gallery))
    }

    // MARK: - Helpers

    /// A copy at `relative` below Application Support, as `retain` or `resolve` would leave one.
    private func copy(_ relative: String, dated date: Date? = nil) throws -> URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(relative)
        try write(url, dated: date)
        return url
    }

    /// A file outside the copy folders, removed in `tearDown`. A folder made for it is the caller's
    /// to add to `placed`.
    private func place(_ url: URL, dated date: Date? = nil) throws -> URL {
        try write(url, dated: date)
        placed.append(url)
        return url
    }

    private func write(_ url: URL, dated date: Date?) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: url)
        if let date { try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path) }
    }

    /// `url`'s bare path in another install's container, on a phone's layout.
    private func stale(_ url: URL) -> String {
        "/private/var/mobile/Containers/Data/Application/\(UUID().uuidString)/"
            + JobFolders.containerRelativePath(url)!
    }

    /// The URL a web view plays the file at `path` by, as `Capacitor.convertFileSrc` writes it.
    private func playback(_ path: String) -> String {
        "capacitor://localhost/_capacitor_file_" + path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }
}
