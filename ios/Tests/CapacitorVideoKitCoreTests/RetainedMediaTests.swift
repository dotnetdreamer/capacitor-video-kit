import Capacitor
import XCTest
@testable import CapacitorVideoKitCore

/// `retainMedia`, `checkMedia` and `requestMediaAccess`: where a picked file goes, what a stored name
/// is answered with after the app's container has moved, and the grant iOS never has to ask for.
///
/// Every file is placed where a picker or the kit really puts one - Caches, tmp, Application Support
/// - because those folders are the whole of what `retain` decides by. Each is removed in `tearDown`
/// whether the test passed or not.
final class RetainedMediaTests: XCTestCase {

    /// Files and folders this test placed in the app container, removed in `tearDown`.
    private var placed: [URL] = []

    override func tearDownWithError() throws {
        for url in placed { try? FileManager.default.removeItem(at: url) }
        placed = []
    }

    // MARK: - retain: a pick in Caches or tmp

    func testMovesAPickFromCachesIntoThePickedFolder() throws {
        let pickerFolder = try folder(in: .caches)
        let pick = try write(pickerFolder.appendingPathComponent("IMG_0001.MOV"), [1, 2, 3])
        try date(pick, Date(timeIntervalSince1970: 1_000_000_000))

        let retained = RetainedMedia.retain(pick.absoluteString)

        XCTAssertTrue(retained.durable)
        XCTAssertTrue(retained.uri.hasPrefix("file://"), retained.uri)
        let moved = try XCTUnwrap(JobFolders.fileURL(from: retained.uri))
        placed.append(moved)
        XCTAssertEqual(moved.deletingLastPathComponent().standardizedFileURL.path,
                       RetainedMedia.pickedFolder.standardizedFileURL.path)
        // Its own name, so a second pick of another IMG_0001.MOV cannot replace it, and the
        // extension it came with, which AVFoundation opens it by.
        XCTAssertNotNil(UUID(uuidString: moved.deletingPathExtension().lastPathComponent), moved.lastPathComponent)
        XCTAssertEqual(moved.pathExtension, "MOV")
        XCTAssertEqual(try Data(contentsOf: moved), Data([1, 2, 3]))
        XCTAssertFalse(exists(pick), "a move, not a copy")
        XCTAssertFalse(exists(pickerFolder), "the picker's folder is empty now, and nobody's")

        // Read off a fresh URL, so nothing cached from the move can answer instead of the disk.
        let values = try URL(fileURLWithPath: moved.path)
            .resourceValues(forKeys: [.isExcludedFromBackupKey, .contentModificationDateKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
        let modified = try XCTUnwrap(values.contentModificationDate)
        XCTAssertLessThan(abs(modified.timeIntervalSinceNow), 60, "dated when it was moved in, not when it was shot")
    }

    func testMovesAPickFromTmpAndTakesABarePath() throws {
        let pickerFolder = try folder(in: .tmp)
        let pick = try write(pickerFolder.appendingPathComponent("clip one.mp4"), [4])

        let retained = RetainedMedia.retain(pick.path)

        XCTAssertTrue(retained.durable)
        let moved = try XCTUnwrap(JobFolders.fileURL(from: retained.uri))
        placed.append(moved)
        XCTAssertEqual(moved.deletingLastPathComponent().lastPathComponent, "videokit-picked")
        XCTAssertEqual(moved.pathExtension, "mp4")
        XCTAssertEqual(try Data(contentsOf: moved), Data([4]))
        XCTAssertFalse(exists(pickerFolder))
    }

    func testKeepsAFolderThatIsNotThePickersOwn() throws {
        // One level deeper than a picker's `Caches/<UUID>/`, so not the picker's: left where it is,
        // empty or not.
        let outer = try folder(in: .caches)
        let inner = outer.appendingPathComponent("inner", isDirectory: true)
        let pick = try write(inner.appendingPathComponent("clip.mp4"), [5])
        // A picker's folder that still holds another file stays as well.
        let shared = try folder(in: .caches)
        let first = try write(shared.appendingPathComponent("a.mp4"), [6])
        let second = try write(shared.appendingPathComponent("b.mp4"), [7])

        for retained in [RetainedMedia.retain(pick.absoluteString), RetainedMedia.retain(first.absoluteString)] {
            XCTAssertTrue(retained.durable)
            placed.append(try XCTUnwrap(JobFolders.fileURL(from: retained.uri)))
        }

        XCTAssertTrue(exists(inner))
        XCTAssertTrue(exists(second))
    }

    func testMovesAPickNamedInAContainerThisInstallNoLongerHas() throws {
        let pickerFolder = try folder(in: .caches)
        let pick = try write(pickerFolder.appendingPathComponent("clip.mov"), [8])

        let retained = RetainedMedia.retain(stale(pick, deviceLayout: true))

        XCTAssertTrue(retained.durable)
        let moved = try XCTUnwrap(JobFolders.fileURL(from: retained.uri))
        placed.append(moved)
        XCTAssertEqual(moved.deletingLastPathComponent().lastPathComponent, "videokit-picked")
        XCTAssertFalse(exists(pick))
    }

    // MARK: - retain: everything else

    func testLeavesAFileElsewhereInTheContainerWhereItIs() throws {
        let documents = try write(container("Documents/vk-test-\(UUID().uuidString).mov"), [9])
        let galleryItem = GalleryLibrary.copiesFolder.appendingPathComponent("vk-test-\(UUID().uuidString)")
        placed.append(galleryItem)
        let gallery = try write(galleryItem.appendingPathComponent("original/IMG_0042.MOV"), [10])
        let picked = try write(RetainedMedia.pickedFolder.appendingPathComponent("\(UUID().uuidString).mov"), [11])

        for file in [documents, gallery, picked] {
            let retained = RetainedMedia.retain(file.absoluteString)
            XCTAssertEqual(retained.uri, file.absoluteString, "answered as it came")
            XCTAssertTrue(retained.durable, file.path)
            XCTAssertTrue(exists(file), "left where it is")
        }
    }

    func testAnswersEverythingElseAsItCameAndNotDurable() throws {
        let missing = container("Library/Caches/vk-test-\(UUID().uuidString)/gone.mp4")
        let pickerFolder = try folder(in: .caches)
        // Outside the container: the test bundle is built into DerivedData, not into the app's data.
        let outside = try XCTUnwrap(Bundle(for: Self.self).executableURL)
        XCTAssertNil(JobFolders.containerRelativePath(outside), "the check needs a file outside the container")

        for uri in [missing.absoluteString, missing.path, outside.absoluteString, pickerFolder.absoluteString,
                    "content://media/external/video/media/42", "https://example.com/clip.mp4",
                    "capacitor://localhost/_capacitor_file_/clip.mp4", "clip.mp4"] {
            let retained = RetainedMedia.retain(uri)
            XCTAssertEqual(retained.uri, uri)
            XCTAssertFalse(retained.durable, uri)
        }
        XCTAssertTrue(exists(outside))
        XCTAssertTrue(exists(pickerFolder), "a folder is never media, and never moved")
    }

    // MARK: - check

    func testAnswersACurrentNameAsItCame() throws {
        let copy = try write(RetainedMedia.pickedFolder.appendingPathComponent("\(UUID().uuidString).mov"), [1])

        for uri in [copy.absoluteString, copy.path] {
            let checked = RetainedMedia.check(uri)
            XCTAssertTrue(checked.exists)
            XCTAssertEqual(checked.uri, uri)
        }
    }

    func testRebasesAStaleContainerOntoThisOneKeepingTheWayItWasWritten() throws {
        let copy = try write(RetainedMedia.pickedFolder.appendingPathComponent("\(UUID().uuidString).mov"), [1])

        // The kit's own spelling - `Application%20Support` - on a phone's layout comes back encoded.
        let encoded = RetainedMedia.check(stale(copy, deviceLayout: true))
        XCTAssertTrue(encoded.exists)
        XCTAssertEqual(encoded.uri, copy.absoluteString)

        // A bare path on the simulator's layout comes back a bare path.
        let bare = RetainedMedia.check(stale(copy, deviceLayout: false))
        XCTAssertTrue(bare.exists)
        XCTAssertEqual(bare.uri, copy.path)

        // A `file://` name written by hand, with its space raw, comes back raw.
        let literal = RetainedMedia.check("file://" + stale(copy, deviceLayout: false))
        XCTAssertTrue(literal.exists)
        XCTAssertEqual(literal.uri, "file://" + copy.path)
        XCTAssertTrue(literal.uri.contains("Application Support"), literal.uri)

        // Whatever the spelling, the answer opens the file.
        for uri in [encoded.uri, bare.uri, literal.uri] {
            XCTAssertEqual(JobFolders.fileURL(from: uri)?.standardizedFileURL.path, copy.standardizedFileURL.path)
        }
    }

    func testAnswersAMissingFileAsItCame() throws {
        let gone = RetainedMedia.pickedFolder.appendingPathComponent("\(UUID().uuidString).mov")
        for uri in [gone.absoluteString, stale(gone, deviceLayout: true), "content://media/external/video/media/42", ""] {
            let checked = RetainedMedia.check(uri)
            XCTAssertFalse(checked.exists, uri)
            XCTAssertEqual(checked.uri, uri)
        }
    }

    func testAnswersAFolderAsNotThere() throws {
        let folder = try folder(in: .caches)
        XCTAssertFalse(RetainedMedia.check(folder.absoluteString).exists)
    }

    // MARK: - Through the plugin

    func testRetainMediaRequiresAURI() throws {
        for options: [String: Any] in [[:], ["uri": ""]] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.retainMedia, options)
            XCTAssertEqual(rejection.code, "invalid_spec")
            XCTAssertEqual(rejection.message, "uri is required")
        }
    }

    func testRetainMediaAnswersTheNewNameAndWhetherItLasts() throws {
        let pickerFolder = try folder(in: .tmp)
        let pick = try write(pickerFolder.appendingPathComponent("clip.mp4"), [1])

        let answer = try PluginCalls.resolve(VideoComposerPlugin.retainMedia, ["uri": pick.absoluteString])

        let uri = try XCTUnwrap(answer["uri"] as? String)
        placed.append(try XCTUnwrap(JobFolders.fileURL(from: uri)))
        XCTAssertNotEqual(uri, pick.absoluteString)
        XCTAssertEqual(answer["durable"] as? Bool, true)

        let unmoved = try PluginCalls.resolve(VideoComposerPlugin.retainMedia, ["uri": "content://media/1"])
        XCTAssertEqual(unmoved["uri"] as? String, "content://media/1")
        XCTAssertEqual(unmoved["durable"] as? Bool, false)
    }

    func testCheckMediaNeverRejects() throws {
        let copy = try write(RetainedMedia.pickedFolder.appendingPathComponent("\(UUID().uuidString).mov"), [1])
        let there = try PluginCalls.resolve(VideoComposerPlugin.checkMedia, ["uri": stale(copy, deviceLayout: true)])
        XCTAssertEqual(there["exists"] as? Bool, true)
        XCTAssertEqual(there["uri"] as? String, copy.absoluteString)

        let nothing = try PluginCalls.resolve(VideoComposerPlugin.checkMedia, [:])
        XCTAssertEqual(nothing["exists"] as? Bool, false)
        XCTAssertEqual(nothing["uri"] as? String, "")
    }

    func testRequestMediaAccessIsGrantedWithoutAsking() throws {
        for options: [String: Any] in [[:], ["images": true]] {
            let answer = try PluginCalls.resolve(VideoComposerPlugin.requestMediaAccess, options)
            XCTAssertEqual(answer["granted"] as? Bool, true)
        }
    }

    // MARK: - Helpers

    private enum Root { case caches, tmp }

    /// A new folder directly in Caches or tmp, as the file picker makes one per pick.
    private func folder(in root: Root) throws -> URL {
        let base = root == .tmp
            ? FileManager.default.temporaryDirectory
            : FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        let url = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        placed.append(url)
        return url
    }

    /// `relative` below this app's container.
    private func container(_ relative: String) -> URL {
        URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent(relative)
    }

    /// The name `url` would have had in another install's container: the kit's encoded `file://` URI
    /// on a phone's layout, or a bare path on the simulator's.
    private func stale(_ url: URL, deviceLayout: Bool) -> String {
        let relative = JobFolders.containerRelativePath(url)!
        let other = UUID().uuidString
        if deviceLayout {
            return "file:///private/var/mobile/Containers/Data/Application/\(other)/"
                + relative.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)!
        }
        return "/Users/someone/Library/Developer/CoreSimulator/Devices/\(UUID().uuidString)/data"
            + "/Containers/Data/Application/\(other)/\(relative)"
    }

    @discardableResult
    private func write(_ url: URL, _ bytes: [UInt8]) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data(bytes).write(to: url)
        placed.append(url)
        return url
    }

    private func date(_ url: URL, _ date: Date) throws {
        try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }
}
