import XCTest
@testable import CapacitorVideoKitCore

/// `JobFolders.fileURL(from:)`, which every file the plugin opens goes through, and the rule
/// `prepareJob` follows for moving an input or copying it.
final class JobFoldersFileURLTests: RenderTestCase {

    /// Files this test put inside the app container, outside the per-test folder, removed in
    /// `tearDown` whether the test passed or not.
    private var placed: [URL] = []

    override func tearDownWithError() throws {
        for url in placed { try? FileManager.default.removeItem(at: url) }
        placed = []
        try super.tearDownWithError()
    }

    // MARK: - Reading a URI

    func testTakesARawSpaceLiterally() {
        // From iOS 17 `URL(string:)` gets this right too; it is iOS 16, where it answers nil, that
        // the hand reading is for, and this pins the answer on whichever runtime runs it.
        XCTAssertEqual(JobFolders.fileURL(from: "file:///tmp/my clip.mp4")?.path, "/tmp/my clip.mp4")
    }

    func testTakesARawHashAsPartOfTheName() {
        // URL(string:) would read `#2.mp4` as a fragment and open `/tmp/clip`.
        XCTAssertEqual(JobFolders.fileURL(from: "file:///tmp/clip#2.mp4")?.path, "/tmp/clip#2.mp4")
    }

    func testTakesARawQuestionMarkAsPartOfTheName() {
        // URL(string:) would read `?.mp4` as a query and open `/tmp/what`.
        XCTAssertEqual(JobFolders.fileURL(from: "file:///tmp/what?.mp4")?.path, "/tmp/what?.mp4")
    }

    func testDecodesAPercentEncodedURIOnce() {
        XCTAssertEqual(JobFolders.fileURL(from: "file:///tmp/my%20clip%232.mp4")?.path, "/tmp/my clip#2.mp4")
        // Once: `%2520` is an encoded `%20`, which is part of the name.
        XCTAssertEqual(JobFolders.fileURL(from: "file:///tmp/a%2520b.mp4")?.path, "/tmp/a%20b.mp4")
    }

    func testKeepsAPercentSignThatStartsNoEscape() {
        XCTAssertEqual(JobFolders.fileURL(from: "file:///tmp/100% done.mp4")?.path, "/tmp/100% done.mp4")
    }

    func testReadsWhatTheKitItselfHandsOut() throws {
        let url = file("render one#2.mp4")
        try Data([1]).write(to: url)
        XCTAssertEqual(JobFolders.fileURL(from: url.absoluteString)?.standardizedFileURL.path,
                       url.standardizedFileURL.path)
    }

    func testTakesAPlainPathLiterally() {
        XCTAssertEqual(JobFolders.fileURL(from: "/tmp/my clip#2.mp4")?.path, "/tmp/my clip#2.mp4")
    }

    func testReadsLocalhostAsThisMachine() {
        XCTAssertEqual(JobFolders.fileURL(from: "file://localhost/tmp/a.mp4")?.path, "/tmp/a.mp4")
    }

    func testRefusesWhatIsNotAFile() {
        XCTAssertNil(JobFolders.fileURL(from: "content://media/external/video/media/42"))
        XCTAssertNil(JobFolders.fileURL(from: "ph://9F983DBA-EC35-42B8-8773-B597CF782EDD/L0/001"))
        XCTAssertNil(JobFolders.fileURL(from: "file://server/share/a.mp4"))
        XCTAssertNil(JobFolders.fileURL(from: "relative/a.mp4"))
    }

    // MARK: - A container that has moved

    func testRebasesAStaleDeviceContainerOntoThisOne() throws {
        let (real, relative) = try placeInContainer("clip one#1.mp4")
        let stale = "file:///private/var/mobile/Containers/Data/Application/\(UUID().uuidString)/"
            + relative.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!
        XCTAssertEqual(JobFolders.fileURL(from: stale)?.standardizedFileURL.path, real.standardizedFileURL.path)
    }

    func testRebasesAStaleSimulatorContainerOntoThisOne() throws {
        let (real, relative) = try placeInContainer("clip.mp4")
        let stale = "/Users/someone/Library/Developer/CoreSimulator/Devices/\(UUID().uuidString)/data"
            + "/Containers/Data/Application/\(UUID().uuidString)/\(relative)"
        XCTAssertEqual(JobFolders.fileURL(from: stale)?.standardizedFileURL.path, real.standardizedFileURL.path)
    }

    func testAnswersTheGivenPathWhenTheFileIsInNeitherContainer() {
        let stale = "/private/var/mobile/Containers/Data/Application/\(UUID().uuidString)"
            + "/Documents/gone-\(UUID().uuidString).mp4"
        XCTAssertEqual(JobFolders.fileURL(from: stale)?.path, stale)
    }

    func testLeavesAPathWhoseFileIsThereAlone() throws {
        let url = file("here.mp4")
        try Data([1]).write(to: url)
        XCTAssertEqual(JobFolders.rebased(url), url)
    }

    func testRebasesOnlyAfterAnApplicationContainerUUID() throws {
        let (_, relative) = try placeInContainer("clip.mp4")
        let notAContainer = "/private/var/mobile/Containers/Data/Application/not-a-uuid/\(relative)"
        XCTAssertEqual(JobFolders.fileURL(from: notAContainer)?.path, notAContainer)
    }

    // MARK: - Moving or copying

    func testMovesOnlyWhatWasWrittenForOnePost() {
        let home = URL(fileURLWithPath: NSHomeDirectory())
        XCTAssertTrue(JobFolders.isAppOwned(home.appendingPathComponent("Documents/cpcp_video_1.mp4")))
        XCTAssertTrue(JobFolders.isAppOwned(JobFolders.root.appendingPathComponent("b/in/seg-1.mp4")))
        XCTAssertTrue(JobFolders.isAppOwned(JobFolders.voiceDir().appendingPathComponent("take.m4a")))

        XCTAssertFalse(JobFolders.isAppOwned(GalleryLibrary.copiesFolder.appendingPathComponent("id/1/IMG_0042.MOV")))
        XCTAssertFalse(JobFolders.isAppOwned(SoundLibrary.dir.appendingPathComponent("snd-1.m4a")))
        XCTAssertFalse(JobFolders.isAppOwned(
            home.appendingPathComponent("Library/Application Support/video-batches-old/x.mp4")))
        XCTAssertFalse(JobFolders.isAppOwned(home.appendingPathComponent("tmp/pick/x.mp4")))
        XCTAssertFalse(JobFolders.isAppOwned(home.appendingPathComponent("Library/Caches/pick/x.mp4")))
        XCTAssertFalse(JobFolders.isAppOwned(URL(fileURLWithPath: "/elsewhere/Documents/x.mp4")))
    }

    func testPrepareJobCopiesGalleryCopiesAndSoundsAndMovesTheRest() throws {
        let batchId = "jobfolders-test-\(UUID().uuidString)"
        placed.append(JobFolders.jobDir(batchId))

        let galleryFolder = GalleryLibrary.copiesFolder.appendingPathComponent("test-\(UUID().uuidString)")
        placed.append(galleryFolder)
        let gallery = try write(galleryFolder.appendingPathComponent("1700000000000/IMG_0042.MOV"), byte: 1)

        let sound = try write(SoundLibrary.dir.appendingPathComponent("test-\(UUID().uuidString).m4a"), byte: 2)
        placed.append(sound)

        let pickFolder = FileManager.default.temporaryDirectory
            .appendingPathComponent("test-pick-\(UUID().uuidString)")
        placed.append(pickFolder)
        let pick = try write(pickFolder.appendingPathComponent("clip.mp4"), byte: 3)

        let otherJob = JobFolders.jobDir("jobfolders-other-\(UUID().uuidString)")
        placed.append(otherJob)
        let render = try write(otherJob.appendingPathComponent("stitched.mp4"), byte: 4)

        let prepared = try JobFolders.prepareJob(batchId: batchId, inputs: [
            (key: "seg-1", uri: gallery.absoluteString),
            (key: "music", uri: sound.absoluteString),
            (key: "seg-2", uri: pick.absoluteString),
            (key: "seg-3", uri: render.absoluteString),
        ])
        let placedInputs = Dictionary(uniqueKeysWithValues: prepared.inputs.map { ($0.key, $0.uri) })

        // Copied and kept: a draft still points at the gallery copy, and the sound is the customer's.
        XCTAssertTrue(FileManager.default.fileExists(atPath: gallery.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sound.path))
        // Copied and then removed: the file picker's scratch copy.
        XCTAssertFalse(FileManager.default.fileExists(atPath: pick.path))
        // Moved: a job folder's own file.
        XCTAssertFalse(FileManager.default.fileExists(atPath: render.path))

        for (key, byte) in [("seg-1", 1), ("music", 2), ("seg-2", 3), ("seg-3", 4)] {
            let uri = try XCTUnwrap(placedInputs[key], key)
            let dest = try XCTUnwrap(JobFolders.fileURL(from: uri))
            XCTAssertEqual(try Data(contentsOf: dest), Data([UInt8(byte)]), key)
        }
        XCTAssertTrue(placedInputs["seg-1"]?.hasSuffix("/in/seg-1.MOV") ?? false)
    }

    // MARK: - Helpers

    /// A real file under `NSHomeDirectory()/Library/Caches/`, and its path below the home folder.
    private func placeInContainer(_ name: String) throws -> (URL, String) {
        let folderName = "vk-rebase-\(UUID().uuidString)"
        let relative = "Library/Caches/\(folderName)/\(name)"
        let folder = URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Caches/\(folderName)")
        placed.append(folder)
        let url = try write(folder.appendingPathComponent(name), byte: 9)
        return (url, relative)
    }

    @discardableResult
    private func write(_ url: URL, byte: UInt8) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([byte]).write(to: url)
        return url
    }
}
