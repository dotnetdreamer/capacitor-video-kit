import Capacitor
import UIKit
import XCTest
@testable import CapacitorVideoKitCore

/// `pickAudioFile`, as far as it goes without a screen: where a picked song is put and what it is
/// called, that no song outlives the next pick or the next load and no copy the picker made is left
/// where no sweep looks, the answer for a pick and for a cancel, every way the picker can end coming
/// to exactly one answer, and the refusals when there is nothing to present the picker from or UIKit
/// will not present it. Presenting the picker itself needs a person to pick, and is not tested here.
final class AudioFilePickerTests: XCTestCase {

    /// Files and folders this test placed outside the audio folder, removed in `tearDown`.
    private var placed: [URL] = []

    override func setUpWithError() throws {
        try? FileManager.default.removeItem(at: AudioFilePicker.folder)
    }

    override func tearDownWithError() throws {
        for url in placed { try? FileManager.default.removeItem(at: url) }
        placed = []
        try? FileManager.default.removeItem(at: AudioFilePicker.folder)
    }

    // MARK: - keep

    func testMovesThePickersCopyIntoTheAudioFolderUnderANameOfItsOwn() throws {
        // Where `asCopy` leaves a pick: a folder of the system's in this app's `tmp`.
        let inbox = try inboxFolder()
        let pick = inbox.appendingPathComponent("Song One.mp3")
        try Data([1, 2, 3]).write(to: pick)

        let kept = try AudioFilePicker.keep(pick)

        XCTAssertEqual(kept.url.deletingLastPathComponent().path, AudioFilePicker.folder.path)
        XCTAssertNotNil(UUID(uuidString: kept.url.deletingPathExtension().lastPathComponent), kept.url.lastPathComponent)
        XCTAssertEqual(kept.url.pathExtension, "mp3")
        XCTAssertEqual(kept.fileName, "Song One.mp3", "the name to show is the one it was picked by")
        XCTAssertEqual(kept.mimeType, "audio/mpeg")
        XCTAssertEqual(try Data(contentsOf: kept.url), Data([1, 2, 3]))
        XCTAssertFalse(FileManager.default.fileExists(atPath: pick.path), "a move, so the song is on disk once")
    }

    func testCopiesAFileFromOutsideTheAppAndLeavesItWhereItIs() throws {
        // Outside the container, and with no extension: the test bundle's own executable.
        let outside = try XCTUnwrap(Bundle(for: Self.self).executableURL)
        XCTAssertNil(JobFolders.containerRelativePath(outside), "the check needs a file outside the container")

        let kept = try AudioFilePicker.keep(outside)

        XCTAssertTrue(FileManager.default.fileExists(atPath: outside.path), "not the app's to take away")
        XCTAssertEqual(try Data(contentsOf: kept.url), try Data(contentsOf: outside))
        XCTAssertNotNil(UUID(uuidString: kept.url.lastPathComponent), "no extension to keep, so none")
        XCTAssertEqual(kept.fileName, outside.lastPathComponent)
        XCTAssertNil(kept.mimeType)
    }

    func testEachPickClearsTheSongBeforeItAndIsNamedAfreshEvenForOneName() throws {
        let first = try AudioFilePicker.keep(try write("Track 1.m4a", in: try inboxFolder()))
        let second = try AudioFilePicker.keep(try write("Track 1.m4a", in: try inboxFolder()))

        XCTAssertNotEqual(first.url, second.url, "a name is never handed out twice")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.url.path), "its page read it when it was answered")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: AudioFilePicker.folder.path),
                       [second.url.lastPathComponent])
    }

    func testAPickThatWouldNotMoveLeavesNoCopyBehind() throws {
        let pick = try write("song.mp3", in: try inboxFolder())
        // A file where the folder belongs, so the move has nowhere to go.
        try FileManager.default.createDirectory(at: AudioFilePicker.folder.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data([9]).write(to: AudioFilePicker.folder)

        XCTAssertThrowsError(try AudioFilePicker.keep(pick))
        XCTAssertFalse(FileManager.default.fileExists(atPath: pick.path), "the picker's copy is in a folder no sweep looks in")
    }

    func testTheLaunchSweepTakesEverySongWhateverItsAge() throws {
        let song = try AudioFilePicker.keep(try write("song.mp3", in: try inboxFolder()))

        JobFolders.sweep(now: Date())

        XCTAssertFalse(FileManager.default.fileExists(atPath: song.url.path), "the page it was answered to is gone")
    }

    func testNamesATypeTheRenderNamesAnExtensionFor() throws {
        // The types `withNativeRenderInputs` names a staged copy's extension after, when a host
        // renders the song from the page's bytes.
        let named: Set<String> = [
            "audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave", "audio/mpeg", "audio/mp3",
            "audio/mp4", "audio/x-m4a", "audio/aac", "audio/aiff", "audio/x-aiff", "audio/x-caf",
            "audio/flac", "audio/x-flac",
        ]
        let inbox = try inboxFolder()
        for ext in ["mp3", "m4a", "wav", "aiff", "aif", "aac", "flac", "MP3"] {
            let kept = try AudioFilePicker.keep(try write("song.\(ext)", in: inbox))
            let mimeType = try XCTUnwrap(kept.mimeType, ext)
            XCTAssertTrue(named.contains(mimeType), "\(ext): \(mimeType)")
        }
        // iOS types a CAF as audio but has no MIME type for it, so the answer carries none rather
        // than a guess: the render reads what the bytes are either way (`RenderInputs`).
        XCTAssertNil(try AudioFilePicker.keep(try write("song.caf", in: inbox)).mimeType)
    }

    // MARK: - The answer

    func testAnswersAPickAndACancelInTheContractsShape() throws {
        let url = AudioFilePicker.folder.appendingPathComponent("\(UUID().uuidString).mp3")
        let picked = PickedAudioFile(url: url, fileName: "Song One.mp3", mimeType: "audio/mpeg").json
        XCTAssertEqual(picked["cancelled"] as? Bool, false)
        XCTAssertEqual(picked["uri"] as? String, url.absoluteString)
        XCTAssertEqual(picked["fileName"] as? String, "Song One.mp3")
        XCTAssertEqual(picked["mimeType"] as? String, "audio/mpeg")

        let untyped = PickedAudioFile(url: url, fileName: "song", mimeType: nil).json
        XCTAssertEqual(Set(untyped.keys), ["cancelled", "uri", "fileName"], "no type, no key")

        XCTAssertEqual(AudioFilePicker.cancelled as? [String: Bool], ["cancelled": true])
    }

    @MainActor
    func testEveryWayThePickerEndsComesToOneAnswer() throws {
        let document = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
        let sheet = UIPresentationController(presentedViewController: UIViewController(), presenting: nil)
        let a = URL(fileURLWithPath: "/tmp/a.mp3")
        let b = URL(fileURLWithPath: "/tmp/b.mp3")

        func answers(_ end: (AudioFilePicker) -> Void) -> [URL?] {
            var answers: [URL?] = []
            let picker = AudioFilePicker { answers.append($0) }
            end(picker)
            return answers
        }

        XCTAssertEqual(answers { $0.documentPicker(document, didPickDocumentsAt: [a, b]) }, [a], "the first of a pick")
        XCTAssertEqual(answers { $0.documentPicker(document, didPickDocumentsAt: []) }, [nil], "nothing picked")
        XCTAssertEqual(answers { $0.documentPickerWasCancelled(document) }, [nil])
        XCTAssertEqual(answers { $0.presentationControllerDidDismiss(sheet) }, [nil], "swiped away")
        XCTAssertEqual(answers {
            $0.documentPicker(document, didPickDocumentsAt: [a])
            $0.presentationControllerDidDismiss(sheet)
            $0.documentPickerWasCancelled(document)
            $0.settle(nil)
        }, [a], "told more than once, answered once")
        XCTAssertEqual(answers {
            $0.presentationControllerDidDismiss(sheet)
            $0.documentPicker(document, didPickDocumentsAt: [a])
        }, [nil])
    }

    @MainActor
    func testAPickTheAnswerCannotTakeIsDeleted() throws {
        let document = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
        let inbox = try inboxFolder()
        let taken = try write("taken.mp3", in: inbox)
        let extra = try write("extra.mp3", in: inbox)
        let late = try write("late.mp3", in: inbox)
        var answers: [URL?] = []
        let picker = AudioFilePicker { answers.append($0) }

        picker.documentPicker(document, didPickDocumentsAt: [taken, extra])
        picker.documentPicker(document, didPickDocumentsAt: [late])

        XCTAssertEqual(answers, [taken])
        XCTAssertTrue(FileManager.default.fileExists(atPath: taken.path), "the answer's to keep")
        XCTAssertFalse(FileManager.default.fileExists(atPath: extra.path), "past the first")
        XCTAssertFalse(FileManager.default.fileExists(atPath: late.path), "told after the answer")
    }

    @MainActor
    func testAPickerNotPresentedIsNotOnScreen() {
        XCTAssertFalse(AudioFilePicker { _ in }.isOnScreen)
    }

    @MainActor
    func testAPickerUIKitWouldNotPresentSaysSoAndNeverAnswers() throws {
        let document = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
        var answers: [URL?] = []
        let picker = AudioFilePicker { answers.append($0) }

        // A view controller in no window, which UIKit presents nothing from.
        XCTAssertFalse(picker.present(from: UIViewController()))
        XCTAssertFalse(picker.isOnScreen)

        picker.documentPickerWasCancelled(document)
        picker.documentPicker(document, didPickDocumentsAt: [URL(fileURLWithPath: "/tmp/a.mp3")])
        XCTAssertEqual(answers, [], "the plugin has rejected the call already")
    }

    // MARK: - Through the plugin

    func testPickAudioFileRefusesWhenThereIsNoScreenToShowThePickerOn() throws {
        // A plugin with no bridge under it has no view controller, as a bridge with no screen has none.
        let rejection = try PluginCalls.reject(VideoComposerPlugin.pickAudioFile, [:])
        XCTAssertEqual(rejection.code, "UNAVAILABLE")
        XCTAssertEqual(rejection.message, "there is no screen to show the audio picker on")
    }

    // MARK: - Helpers

    /// A new folder in this app's `tmp`, as the document picker makes one for its copies.
    private func inboxFolder() throws -> URL {
        let folder = FileManager.default.temporaryDirectory
            .appendingPathComponent("vk-test-Inbox-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        placed.append(folder)
        return folder
    }

    private func write(_ name: String, in folder: URL) throws -> URL {
        let url = folder.appendingPathComponent(name)
        try Data([1]).write(to: url)
        return url
    }
}
