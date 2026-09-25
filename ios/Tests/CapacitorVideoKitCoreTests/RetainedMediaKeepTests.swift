import Capacitor
import XCTest
@testable import CapacitorVideoKitCore

/// `releaseMedia`'s `keep`, and the one spelling every name of a file is given in: what a release
/// spares because another draft still names a copy, however that draft wrote the name, and that a
/// name moved onto this install's container is the very name the kit hands out for the file today.
///
/// Both copy folders are emptied before and after every test, as `RetainedMediaCleanupTests` empties
/// them, so what a test finds in them is only what it put there.
final class RetainedMediaKeepTests: XCTestCase {

    /// Files and folders this test placed outside the copy folders, removed in `tearDown`.
    private var placed: [URL] = []

    override func setUpWithError() throws {
        for folder in RetainedMedia.copyFolders { try? FileManager.default.removeItem(at: folder) }
    }

    override func tearDownWithError() throws {
        for url in placed { try? FileManager.default.removeItem(at: url) }
        placed = []
        for folder in RetainedMedia.copyFolders { try? FileManager.default.removeItem(at: folder) }
    }

    // MARK: - keep

    func testReleaseSparesACopyKeepAlsoNames() throws {
        let shared = try copy("videokit-picked/\(UUID().uuidString).mov")
        let own = try copy("videokit-picked/\(UUID().uuidString).mov")
        let gallery = try copy("videokit-gallery/\(UUID().uuidString)/original/IMG_0042.MOV")
        let ownGallery = try copy("videokit-gallery/\(UUID().uuidString)/original/IMG_0043.MOV")

        RetainedMedia.release([shared.absoluteString, own.absoluteString, gallery.path, ownGallery.path],
                              keep: [shared.absoluteString, gallery.absoluteString])

        XCTAssertTrue(exists(shared), "another draft still names it")
        XCTAssertTrue(exists(gallery))
        XCTAssertFalse(exists(own))
        XCTAssertFalse(exists(ownGallery))
        XCTAssertFalse(exists(ownGallery.deletingLastPathComponent()), "the folder it emptied goes with it")
    }

    func testKeepIsReadInEveryWayASweepReadsIt() throws {
        let played = try copy("videokit-picked/\(UUID().uuidString).MOV")
        let withFragment = try copy("videokit-picked/\(UUID().uuidString).mov")
        let oneSlash = try copy("videokit-picked/\(UUID().uuidString).mp4")
        let relativeName = "videokit-gallery/\(UUID().uuidString)/original/IMG_0042.MOV"
        let relative = try copy(relativeName)
        let playedStale = try copy("videokit-gallery/\(UUID().uuidString)/original/IMG 0043.MOV")
        let storedStale = try copy("videokit-picked/\(UUID().uuidString).mov")
        let unnamed = try copy("videokit-picked/\(UUID().uuidString).mov")
        let all = [played, withFragment, oneSlash, relative, playedStale, storedStale, unnamed]

        RetainedMedia.release(all.map(\.absoluteString), keep: [
            // The URL a web view plays a file by, `Capacitor.convertFileSrc`'s, and the same with
            // the fragment a host adds to have iOS draw the first frame.
            playback(played.path), playback(withFragment.path) + "#t=0.1",
            "file:" + oneSlash.path,
            // Relative to Application Support, the way the two folders are matched.
            relativeName,
            // Played in another install's container, and stored in one.
            playback(stale(playedStale)), stale(storedStale),
        ])

        for kept in [played, withFragment, oneSlash, relative, playedStale, storedStale] {
            XCTAssertTrue(exists(kept), kept.lastPathComponent)
        }
        XCTAssertFalse(exists(unnamed), "named in `uris` and nowhere in `keep`")
    }

    func testKeepDeletesNothingOfItsOwn() throws {
        let kept = try copy("videokit-picked/\(UUID().uuidString).mov")
        let unnamed = try copy("videokit-picked/\(UUID().uuidString).mov")
        let outside = try place(URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Documents/vk-test-\(UUID().uuidString).mov"))

        RetainedMedia.release([], keep: [kept.absoluteString, outside.absoluteString])
        RetainedMedia.release([outside.absoluteString],
                              keep: ["", "content://media/external/video/media/42", "videokit-picked/"])

        for file in [kept, unnamed, outside] { XCTAssertTrue(exists(file), file.lastPathComponent) }
    }

    // MARK: - Through the plugin

    func testReleaseMediaReadsKeepAndPassesOverWhatIsNotAName() throws {
        let kept = try copy("videokit-picked/\(UUID().uuidString).mov")
        let released = try copy("videokit-picked/\(UUID().uuidString).mov")

        _ = try PluginCalls.resolve(VideoComposerPlugin.releaseMedia, [
            "uris": [kept.absoluteString, released.absoluteString],
            "keep": [42, playback(kept.path)] as [Any],
        ])

        XCTAssertTrue(exists(kept))
        XCTAssertFalse(exists(released))
    }

    func testReleaseMediaWithoutKeepReleasesEveryCopyItNames() throws {
        let first = try copy("videokit-picked/\(UUID().uuidString).mov")
        let second = try copy("videokit-gallery/\(UUID().uuidString)/original/IMG_0042.MOV")

        _ = try PluginCalls.resolve(VideoComposerPlugin.releaseMedia, ["uris": [first.absoluteString, second.path]])

        XCTAssertFalse(exists(first))
        XCTAssertFalse(exists(second))
    }

    func testReleaseMediaRefusesAKeepThatIsNotAListAndDeletesNothing() throws {
        let shared = try copy("videokit-picked/\(UUID().uuidString).mov")
        let own = try copy("videokit-picked/\(UUID().uuidString).mov")

        // One name where the list belongs is the likeliest mistake, and read as absent it would
        // delete the very copy it names.
        for keep: Any in [shared.absoluteString, 42, ["uri": shared.absoluteString]] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.releaseMedia, [
                "uris": [shared.absoluteString, own.absoluteString], "keep": keep,
            ])
            XCTAssertEqual(rejection.code, "invalid_spec", "\(keep)")
            XCTAssertEqual(rejection.message, "keep must be a list of uris")
        }

        XCTAssertTrue(exists(shared))
        XCTAssertTrue(exists(own))
    }

    func testReleaseMediaReadsANullKeepAsAbsent() throws {
        let released = try copy("videokit-picked/\(UUID().uuidString).mov")

        _ = try PluginCalls.resolve(VideoComposerPlugin.releaseMedia, ["uris": [released.absoluteString], "keep": NSNull()])

        XCTAssertFalse(exists(released), "a null names nothing to spare, as on Android and the web")
    }

    // MARK: - One spelling

    func testAMovedNameIsTheNameTheKitHandsOutForTheFile() throws {
        let pickerFolder = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        placed.append(pickerFolder)
        let fresh = RetainedMedia.retain(try place(pickerFolder.appendingPathComponent("clip one.mov")).absoluteString)
        XCTAssertTrue(fresh.durable)
        let file = try XCTUnwrap(JobFolders.fileURL(from: fresh.uri))

        // Stored in another install's container, on a phone's layout, where the stored name reads
        // `/private/var` and a fresh one `/var`.
        let encoded = RetainedMedia.check("file://" + stale(file, encoded: true))
        XCTAssertTrue(encoded.exists)
        XCTAssertEqual(encoded.uri, fresh.uri, "the same string, so a host takes the two for one file")

        let bare = RetainedMedia.check(stale(file))
        XCTAssertEqual(bare.uri, file.path)
        XCTAssertEqual(JobFolders.rebased(URL(fileURLWithPath: stale(file))), file)
    }

    func testAMovedNameIsSpelledAsHomeIsAndNotAsTheFileResolves() throws {
        // A device's two spellings of one container, which the simulator never has: a link standing
        // in for `/var`, and the folder it points at for `/private/var`.
        let temporary = FileManager.default.temporaryDirectory
        let container = temporary.appendingPathComponent("vk-container-\(UUID().uuidString)", isDirectory: true)
        let link = temporary.appendingPathComponent("vk-link-\(UUID().uuidString)", isDirectory: true)
        let relative = "Library/Application Support/videokit-picked/clip one.mov"
        _ = try place(container.appendingPathComponent(relative))
        placed.append(container)
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: container)
        placed.append(link)
        let stored = "/private/var/mobile/Containers/Data/Application/\(UUID().uuidString)/" + relative

        let moved = JobFolders.rebased(URL(fileURLWithPath: stored), home: link)

        XCTAssertEqual(moved.path, link.path + "/" + relative, "built on home as it is spelled, not resolved")
    }

    func testEveryFolderTheKitNamesFilesInIsSpelledAsHomeIs() throws {
        let home = JobFolders.home.path
        XCTAssertEqual(JobFolders.home.standardizedFileURL.path,
                       URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.path,
                       "one container, whichever way each spells it")
        for folder in [RetainedMedia.pickedFolder, GalleryLibrary.copiesFolder, JobFolders.root,
                       JobFolders.thumbsDir(), JobFolders.voiceDir(), SoundLibrary.dir,
                       StagedRenderInputs.folder, AudioFilePicker.folder] {
            XCTAssertTrue(folder.path.hasPrefix(home + "/"), folder.path)
        }
        XCTAssertEqual(StagedRenderInputs.folder.path, home + "/tmp/videokit-render-inputs")
        XCTAssertEqual(AudioFilePicker.folder.path, home + "/tmp/videokit-audio")
    }

    // MARK: - Helpers

    /// A copy at `relative` below Application Support, as `retain` or `resolve` would leave one.
    private func copy(_ relative: String) throws -> URL {
        let url = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent(relative)
        try write(url)
        return url
    }

    /// A file outside the copy folders, removed in `tearDown`.
    private func place(_ url: URL) throws -> URL {
        try write(url)
        placed.append(url)
        return url
    }

    private func write(_ url: URL) throws {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1, 2, 3]).write(to: url)
    }

    /// `url`'s path in another install's container on a phone's layout, percent-encoded as the kit
    /// encodes a `file://` URI when `encoded`.
    private func stale(_ url: URL, encoded: Bool = false) -> String {
        let relative = JobFolders.containerRelativePath(url)!
        return "/private/var/mobile/Containers/Data/Application/\(UUID().uuidString)/"
            + (encoded ? relative.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)! : relative)
    }

    /// The URL a web view plays the file at `path` by, as `Capacitor.convertFileSrc` writes it.
    private func playback(_ path: String) -> String {
        "capacitor://localhost/_capacitor_file_" + path.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }
}
