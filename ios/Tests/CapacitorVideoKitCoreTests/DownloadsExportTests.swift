import Capacitor
import XCTest
@testable import CapacitorVideoKitCore

/// `saveToDownloads` as far as it goes without a sheet on the screen: the name a file is saved
/// under, the named copy the sheet is handed and its release, and every way the call refuses before
/// anything is presented. The sheet itself is the system's, and is checked by hand.
final class DownloadsExportTests: RenderTestCase {

    /// Staged copies this test made, released in `tearDown` whatever happened.
    private var staged: [URL] = []

    override func tearDownWithError() throws {
        staged.forEach(DownloadsExport.release)
        try super.tearDownWithError()
    }

    // MARK: - The name

    func testANameIsANameAndNeverAPathAsOnAndroid() {
        let source = URL(fileURLWithPath: "/tmp/9F2C.wav")
        XCTAssertEqual(DownloadsExport.name(" holiday.wav ", source: source), "holiday.wav")
        XCTAssertEqual(DownloadsExport.name("a/../x.wav", source: source), "a_.._x.wav")
        XCTAssertEqual(DownloadsExport.name("a\\b.wav", source: source), "a_b.wav")
        XCTAssertEqual(DownloadsExport.name("..", source: source), "download")
        XCTAssertEqual(DownloadsExport.name(" . ", source: source), "download")
    }

    func testANameFallsBackToTheSourcesOwn() {
        let source = URL(fileURLWithPath: "/tmp/9F2C.wav")
        XCTAssertEqual(DownloadsExport.name(nil, source: source), "9F2C.wav")
        XCTAssertEqual(DownloadsExport.name("   ", source: source), "9F2C.wav")
    }

    // MARK: - The named copy

    func testStagesTheFileUnderItsNameAloneInAFolderOfItsOwn() throws {
        let sound = file("9F2C.wav")
        try Data([1, 2, 3]).write(to: sound)

        let copy = try DownloadsExport.stage(sound, as: "holiday.wav")
        staged.append(copy)

        XCTAssertEqual(copy.lastPathComponent, "holiday.wav")
        XCTAssertEqual(try Data(contentsOf: copy), Data([1, 2, 3]))
        XCTAssertEqual(copy.deletingLastPathComponent().deletingLastPathComponent().standardizedFileURL.path,
                       DownloadsExport.folder.standardizedFileURL.path)

        let second = try DownloadsExport.stage(sound, as: "holiday.wav")
        staged.append(second)
        XCTAssertNotEqual(second.deletingLastPathComponent(), copy.deletingLastPathComponent(),
                          "two saves of one name are two folders, not one file written twice")
    }

    func testReleaseTakesTheCopysFolderAndLeavesTheSource() throws {
        let sound = file("9F2C.wav")
        try Data([1]).write(to: sound)
        let copy = try DownloadsExport.stage(sound, as: "holiday.wav")

        DownloadsExport.release(copy)

        XCTAssertFalse(FileManager.default.fileExists(atPath: copy.deletingLastPathComponent().path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: sound.path), "the source is not the sheet's to take")
    }

    func testReleaseLeavesAnythingItDidNotStage() throws {
        let sound = file("keep me.wav")
        try Data([1]).write(to: sound)

        DownloadsExport.release(sound)

        XCTAssertTrue(FileManager.default.fileExists(atPath: sound.path))
        XCTAssertTrue(FileManager.default.fileExists(atPath: dir.path))
    }

    func testRefusesToStageAFileThatIsNotThereOrIsAFolder() {
        for missing in [file("never written.wav"), dir!] {
            XCTAssertThrowsError(try DownloadsExport.stage(missing, as: "x.wav")) { error in
                guard case DownloadsExport.StageError.unreadable = error else {
                    return XCTFail("expected unreadable, got \(error)")
                }
            }
        }
    }

    // MARK: - Through the plugin

    func testRequiresAURI() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToDownloads, [:])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "uri is required")
    }

    func testReportsAURIThatIsNotAFileAsUnreadable() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToDownloads,
                                               ["uri": "content://media/external/downloads/1"])
        XCTAssertEqual(rejection.code, "unreadable_input")
    }

    func testRefusesWhenThereIsNoScreenToShowTheSheetOn() throws {
        // A plugin with no bridge under it has no view controller, as a bridge with no screen has none.
        let sound = file("9F2C.wav")
        try Data([1]).write(to: sound)
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToDownloads,
                                               ["uri": sound.absoluteString, "fileName": "holiday.wav"])
        XCTAssertEqual(rejection.code, "UNAVAILABLE")
        XCTAssertEqual(rejection.message, "there is no screen to show the save sheet on")
    }
}
