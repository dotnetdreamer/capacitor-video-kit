import Capacitor
import UIKit
import XCTest
@testable import CapacitorVideoKitCore

/// `pickAudioFile`, as far as it goes without a person: that the picker opens a song in place,
/// where a picked song is copied to and what the copy is called, that the pick itself is copied and
/// never moved or deleted, wherever it is and however the copy ends, that it is read as whoever
/// presents it has saved it, that a copy that fails leaves nothing of itself, that its security
/// scope is closed whenever it was opened, that no song outlives the next pick or the next load and
/// no load takes one halfway through being copied, the answer for a pick and for a cancel, every
/// way the picker can end coming to exactly one answer, the refusals when there is nothing to
/// present the picker from or it is in no window, that a picker is open from the moment UIKit is
/// asked for it and for as long as UIKit has it presented, and that one UIKit never put up is
/// answered as a cancel. A pick needs a person, and is not tested here: a presenter that records
/// what it is asked for stands in for UIKit, the one real presentation is only looked at, and a
/// file beside the app's container, with its scope counted, stands in for one the picker opened.
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

    func testCopiesASongOpenedInPlaceIntoTheAudioFolderAndLeavesItAsItWas() throws {
        // Where a song the picker opens in place is: outside this app's container, in another
        // app's folder or a file provider's, and read only inside its security scope.
        let pick = try pickFolder().appendingPathComponent("Song One.mp3")
        try Data([1, 2, 3]).write(to: pick)
        let modified = try modificationDate(pick)
        var opened: [URL] = []
        var closed: [URL] = []

        let kept = try AudioFilePicker.keep(pick, opening: { opened.append($0); return true },
                                            closing: { closed.append($0) })

        XCTAssertEqual(kept.url.deletingLastPathComponent().path, AudioFilePicker.folder.path)
        XCTAssertNotNil(UUID(uuidString: kept.url.deletingPathExtension().lastPathComponent), kept.url.lastPathComponent)
        XCTAssertEqual(kept.url.pathExtension, "mp3")
        XCTAssertEqual(kept.fileName, "Song One.mp3", "the name to show is the one it was picked by")
        XCTAssertEqual(kept.mimeType, "audio/mpeg")
        XCTAssertEqual(try Data(contentsOf: kept.url), Data([1, 2, 3]))
        XCTAssertEqual(try Data(contentsOf: pick), Data([1, 2, 3]), "the person's own file, never the kit's to move")
        XCTAssertEqual(try modificationDate(pick), modified, "read, and never written")
        XCTAssertEqual(opened, [pick], "read inside its scope")
        XCTAssertEqual(closed, [pick], "and the scope closed once the copy was made")
    }

    func testCopiesASongInsideTheAppAndNeverMovesIt() throws {
        // A host that shares its Documents with the Files app offers them in the picker, and a song
        // there is still the person's; so is one in `tmp`, which a move would once have taken.
        let documents = try place(JobFolders.home.appendingPathComponent("Documents/vk-test-\(UUID().uuidString).m4a"))
        let scratch = try place(FileManager.default.temporaryDirectory.appendingPathComponent("vk-test-\(UUID().uuidString).m4a"))

        for pick in [documents, scratch] {
            XCTAssertNotNil(JobFolders.containerRelativePath(pick), "the check needs a file inside the container")
            let kept = try AudioFilePicker.keep(pick)
            XCTAssertEqual(try Data(contentsOf: kept.url), Data([1]))
            XCTAssertTrue(FileManager.default.fileExists(atPath: pick.path), "\(pick.lastPathComponent) was moved")
        }
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
        // One file picked twice, as Replace on a track just set up picks it.
        let pick = try write("Track 1.m4a", in: try pickFolder())
        let first = try AudioFilePicker.keep(pick)
        let second = try AudioFilePicker.keep(pick)

        XCTAssertNotEqual(first.url, second.url, "a name is never handed out twice")
        XCTAssertFalse(FileManager.default.fileExists(atPath: first.url.path), "its page read it when it was answered")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: AudioFilePicker.folder.path),
                       [second.url.lastPathComponent])
        XCTAssertTrue(FileManager.default.fileExists(atPath: pick.path))
    }

    func testReadsTheSongAsItsPresenterSavesItRatherThanAsTheDiskHadIt() throws {
        // A song somebody else still has changes to, as iCloud or a file provider has one it is
        // still bringing down: a coordinated read asks them to save first, and a plain copy would
        // take the bytes the disk had before they did.
        let pick = try write("song.m4a", in: try pickFolder())
        let presenter = SavingPresenter(pick, saving: Data([2, 2]))
        NSFileCoordinator.addFilePresenter(presenter)
        defer { NSFileCoordinator.removeFilePresenter(presenter) }

        let kept = try AudioFilePicker.keep(pick)

        XCTAssertTrue(presenter.wasAsked, "the read was never coordinated with the song's presenter")
        XCTAssertEqual(try Data(contentsOf: kept.url), Data([2, 2]), "copied what the disk had before the save")
    }

    func testACopyThatFailsPartWayTakesWhatItWroteWithIt() throws {
        // A pick the copy gets partway into before it fails: a folder with a part inside that
        // nobody may read, so the copy has made the folder, and may have copied the rest, by the
        // time it stops - as a song cut off halfway through its bytes leaves half a file.
        let pick = try pickFolder().appendingPathComponent("album.m4a", isDirectory: true)
        try FileManager.default.createDirectory(at: pick, withIntermediateDirectories: true)
        try write("readable", in: pick)
        let locked = try write("locked", in: pick)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: locked.path)
        var closed = 0

        XCTAssertThrowsError(try AudioFilePicker.keep(pick, opening: { _ in true }, closing: { _ in closed += 1 }))

        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: AudioFilePicker.folder.path), [],
                       "a half-written copy was left behind")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: pick.path).sorted(), ["locked", "readable"],
                       "the pick is the person's, whatever became of the copy")
        XCTAssertEqual(closed, 1)
    }

    func testASongWithNowhereToBeCopiedToFailsAndLeavesThePickAsItWas() throws {
        let pick = try write("song.mp3", in: try pickFolder())
        // A file where the folder belongs, so the copy has nowhere to go.
        try FileManager.default.createDirectory(at: AudioFilePicker.folder.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        try Data([9]).write(to: AudioFilePicker.folder)
        var opened = 0
        var closed = 0

        XCTAssertThrowsError(try AudioFilePicker.keep(pick, opening: { _ in opened += 1; return true },
                                                      closing: { _ in closed += 1 }))

        XCTAssertEqual(try Data(contentsOf: pick), Data([1]), "the person's own file, whatever became of the copy")
        XCTAssertEqual(opened, 1)
        XCTAssertEqual(closed, 1, "a scope left open by a failed copy")
    }

    func testASongGoneBeforeItWasReadFailsAndClosesItsScope() throws {
        // Deleted, or moved away by its provider, between the pick and the read.
        let gone = try pickFolder().appendingPathComponent("gone.m4a")
        var opened = 0
        var closed = 0

        XCTAssertThrowsError(try AudioFilePicker.keep(gone, opening: { _ in opened += 1; return true },
                                                      closing: { _ in closed += 1 }))

        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: AudioFilePicker.folder.path), [],
                       "nothing half-written is left")
        XCTAssertEqual(opened, 1)
        XCTAssertEqual(closed, 1, "a scope left open by a failed read")
    }

    func testAScopeThatWouldNotOpenIsNotClosedAndTheSongIsCopiedAllTheSame() throws {
        // A URL with no scope to open, as a file of the app's own has none.
        let pick = try write("song.wav", in: try pickFolder())
        var closed = 0

        let kept = try AudioFilePicker.keep(pick, opening: { _ in false }, closing: { _ in closed += 1 })

        XCTAssertEqual(try Data(contentsOf: kept.url), Data([1]))
        XCTAssertEqual(closed, 0, "closed a scope that was never opened")
    }

    func testEveryLoadTakesEverySongWhateverItsAge() throws {
        let song = try AudioFilePicker.keep(try write("song.mp3", in: try pickFolder()))

        load()
        AudioFilePicker.copies.sync {}

        XCTAssertFalse(FileManager.default.fileExists(atPath: song.url.path), "the page it was answered to is gone")
    }

    func testTheLoadsClearWaitsForAKeepAskedForBeforeIt() throws {
        let pick = try write("song.mp3", in: try pickFolder())
        let kept = Held<PickedAudioFile>()
        // A keep asked for before the load and not yet begun, as one of an earlier bridge's page is
        // while a long song still in iCloud is downloaded and copied ahead of it. Held by suspending
        // the queue rather than by blocking a keep on it, which the thread performance checker
        // reports as an inversion and spends seconds symbolicating.
        AudioFilePicker.copies.suspend()
        AudioFilePicker.copies.async { kept.value = try? AudioFilePicker.keep(pick) }

        // The whole of the load, its walk of the job folders included, while the keep waits: a
        // clear made anywhere but behind it on its queue has been made by now, before the song.
        load()
        AudioFilePicker.copies.resume()
        AudioFilePicker.copies.sync {}

        let song = try XCTUnwrap(kept.value, "the keep failed")
        XCTAssertFalse(FileManager.default.fileExists(atPath: song.url.path), "the page it was answered to is gone")
    }

    func testASongKeptAfterTheLoadIsLeftForItsPage() throws {
        let pick = try write("song.mp3", in: try pickFolder())

        let walked = expectation(description: "the load's walk of the job folders")
        JobFolders.sweepOnLaunch { walked.fulfill() }
        let song = try AudioFilePicker.copies.sync { try AudioFilePicker.keep(pick) }
        // Kept before the walk ends, which a clear at the end of the walk would take.
        wait(for: [walked], timeout: 60)
        AudioFilePicker.copies.sync {}

        XCTAssertTrue(FileManager.default.fileExists(atPath: song.url.path), "the new page's song was cleared")
    }

    func testNamesATypeTheRenderNamesAnExtensionFor() throws {
        // The types `withNativeRenderInputs` names a staged copy's extension after, when a host
        // renders the song from the page's bytes.
        let named: Set<String> = [
            "audio/wav", "audio/wave", "audio/x-wav", "audio/vnd.wave", "audio/mpeg", "audio/mp3",
            "audio/mp4", "audio/x-m4a", "audio/aac", "audio/aiff", "audio/x-aiff", "audio/x-caf",
            "audio/flac", "audio/x-flac",
        ]
        // A folder for each, because a pick stays where it was and `song.mp3` and `song.MP3` are
        // one name to a disk that ignores case, as the simulator's does.
        for ext in ["mp3", "m4a", "wav", "aiff", "aif", "aac", "flac", "MP3"] {
            let kept = try AudioFilePicker.keep(try write("song.\(ext)", in: try pickFolder()))
            let mimeType = try XCTUnwrap(kept.mimeType, ext)
            XCTAssertTrue(named.contains(mimeType), "\(ext): \(mimeType)")
            XCTAssertEqual(kept.url.pathExtension, ext, "the extension as it was picked, case and all")
        }
        // iOS types a CAF as audio but has no MIME type for it, so the answer carries none rather
        // than a guess: the render reads what the bytes are either way (`RenderInputs`).
        XCTAssertNil(try AudioFilePicker.keep(try write("song.caf", in: try pickFolder())).mimeType)
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
    func testThePickerOpensTheSongInPlace() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let presenter = RecordingPresenter()
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }

        XCTAssertTrue(AudioFilePicker { _ in }.present(from: presenter))

        // Asked for a copy, iOS deletes its own on a re-pick about a minute after the first: see
        // `AudioFilePicker`'s doc. The mode is how UIKit says which of the two a picker does.
        let document = try XCTUnwrap(presenter.asked.first?.controller as? UIDocumentPickerViewController)
        let inPlace = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: false)
        let copying = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
        XCTAssertNotEqual(mode(inPlace), mode(copying), "the mode cannot tell opening in place from copying")
        XCTAssertEqual(mode(document), mode(inPlace))
    }

    @MainActor
    func testEveryWayThePickerEndsComesToOneAnswer() throws {
        let document = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: false)
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
    func testAPickTheAnswerCannotTakeIsLeftWhereItIs() throws {
        let document = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: false)
        // Where the picker opens a song, and one inside the app too, where `tmp` once held the
        // picker's copies and deleting them was right.
        let elsewhere = try pickFolder()
        let taken = try write("taken.mp3", in: elsewhere)
        let extra = try write("extra.mp3", in: elsewhere)
        let late = try write("late.mp3", in: elsewhere)
        let scratch = try place(FileManager.default.temporaryDirectory.appendingPathComponent("vk-test-\(UUID().uuidString).mp3"))
        var answers: [URL?] = []
        let picker = AudioFilePicker { answers.append($0) }

        picker.documentPicker(document, didPickDocumentsAt: [taken, extra, scratch])
        picker.documentPicker(document, didPickDocumentsAt: [late])

        XCTAssertEqual(answers, [taken])
        for url in [taken, extra, scratch, late] {
            XCTAssertTrue(FileManager.default.fileExists(atPath: url.path), "\(url.lastPathComponent) is the person's own")
        }
    }

    @MainActor
    func testAPickerNotAskedForIsNotOpen() {
        XCTAssertFalse(AudioFilePicker { _ in }.isOpen())
    }

    @MainActor
    func testAPresenterInNoWindowIsRefusedBeforeUIKitIsAsked() throws {
        let document = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: false)
        var answers: [URL?] = []
        let picker = AudioFilePicker { answers.append($0) }
        // A view controller in no window, which UIKit presents nothing from.
        let presenter = RecordingPresenter()

        XCTAssertFalse(picker.present(from: presenter))
        // Never asked, so no picker can come up after the plugin has rejected the call, and take a
        // pick nobody will be told of.
        XCTAssertTrue(presenter.asked.isEmpty, "UIKit was asked for a picker the call was refused")
        XCTAssertFalse(picker.isOpen())

        picker.documentPickerWasCancelled(document)
        picker.documentPicker(document, didPickDocumentsAt: [URL(fileURLWithPath: "/tmp/a.mp3")])
        XCTAssertEqual(answers, [], "the plugin has rejected the call already")
    }

    @MainActor
    func testAPickerIsOpenFromTheMomentUIKitIsAskedForIt() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let presenter = RecordingPresenter()
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }
        let picker = AudioFilePicker { _ in }

        let before = ProcessInfo.processInfo.systemUptime
        XCTAssertTrue(picker.present(from: presenter))
        let after = ProcessInfo.processInfo.systemUptime

        XCTAssertEqual(presenter.asked.count, 1)
        XCTAssertTrue(presenter.asked.first?.controller is UIDocumentPickerViewController)
        // Not up - UIKit leaves a document picker for a moment - and open all the same, so that a
        // second tap meanwhile is refused `already_picking` rather than taken for a picker gone.
        XCTAssertTrue(picker.isOpen())
        XCTAssertTrue(picker.isOpen(now: before + AudioFilePicker.presentationGrace - 1))
        // Never come up at all: a presentation UIKit refused after it was asked, which must not
        // refuse every pick after it.
        XCTAssertFalse(picker.isOpen(now: after + AudioFilePicker.presentationGrace))

        // Up, by UIKit's word, and then gone without one: open no longer, well inside the grace.
        presenter.asked.first?.completion?()
        XCTAssertFalse(picker.isOpen(), "a picker gone without a word would refuse every pick after it")
    }

    @MainActor
    func testAPickerUIKitNeverPutUpIsAnsweredAsACancel() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let presenter = RecordingPresenter()
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            window.rootViewController = nil
        }

        // Asked for and never put up, as UIKit drops a presentation asked for mid-transition: what
        // `present` does once the grace has passed answers it, so a page waiting on it can ask again.
        var dropped: [URL?] = []
        let never = AudioFilePicker { dropped.append($0) }
        XCTAssertTrue(never.present(from: presenter))
        never.settleIfNeverShown()
        XCTAssertEqual(dropped, [nil])

        // Put up, by UIKit's word: left to what UIKit tells the delegate, which a pick may still be.
        var left: [URL?] = []
        let shown = AudioFilePicker { left.append($0) }
        XCTAssertTrue(shown.present(from: presenter))
        presenter.asked.last?.completion?()
        shown.settleIfNeverShown()
        XCTAssertEqual(left, [], "a picker UIKit put up was answered ahead of its delegate")
    }

    @MainActor
    func testAPickerUIKitHasPresentedIsOpenWhateverElseIsHeard() throws {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 400, height: 800))
        let presenter = UIViewController()
        window.rootViewController = presenter
        window.makeKeyAndVisible()
        defer {
            presenter.dismiss(animated: false)
            window.isHidden = true
            window.rootViewController = nil
        }
        var answers: [URL?] = []
        let picker = AudioFilePicker { answers.append($0) }
        let asked = ProcessInfo.processInfo.systemUptime

        XCTAssertTrue(picker.present(from: presenter))
        // UIKit's own word that the picker is presented, which in the test process comes a second
        // or two late and without the presentation's completion ever being called.
        let presented = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            presenter.presentedViewController != nil
        }, object: nil)
        wait(for: [presented], timeout: 30)

        // Long past the grace: a picker on screen taken for one gone would be answered as a cancel,
        // and have the next pick stacked over it.
        XCTAssertTrue(picker.isOpen(now: asked + AudioFilePicker.presentationGrace * 2))
        picker.settleIfNeverShown()
        XCTAssertEqual(answers, [], "a picker on screen was answered as a cancel")
    }

    // MARK: - Through the plugin

    func testPickAudioFileRefusesWhenThereIsNoScreenToShowThePickerOn() throws {
        // A plugin with no bridge under it has no view controller, as a bridge with no screen has none.
        let rejection = try PluginCalls.reject(VideoComposerPlugin.pickAudioFile, [:])
        XCTAssertEqual(rejection.code, "UNAVAILABLE")
        XCTAssertEqual(rejection.message, "there is no screen to show the audio picker on")
    }

    // MARK: - Helpers

    /// What `load()` does to the songs, to its end: the launch sweep, waited for.
    private func load() {
        let walked = expectation(description: "the load's walk of the job folders")
        JobFolders.sweepOnLaunch { walked.fulfill() }
        wait(for: [walked], timeout: 60)
    }

    /// A new folder outside this app's container, where a song the picker opens in place is:
    /// another app's folder, or a file provider's. Made beside the container, which the simulator
    /// lets a test write to.
    private func pickFolder() throws -> URL {
        let folder = JobFolders.home.deletingLastPathComponent()
            .appendingPathComponent("vk-test-picks-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        placed.append(folder)
        XCTAssertNil(JobFolders.containerRelativePath(folder), "the check needs a folder outside the container")
        return folder
    }

    private func write(_ name: String, in folder: URL) throws -> URL {
        let url = folder.appendingPathComponent(name)
        try Data([1]).write(to: url)
        return url
    }

    /// A one-byte file at `url`, its folder made if need be, removed in `tearDown`.
    private func place(_ url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1]).write(to: url)
        placed.append(url)
        return url
    }

    private func modificationDate(_ url: URL) throws -> Date? {
        try url.resourceValues(forKeys: [.contentModificationDateKey]).contentModificationDate
    }

    /// Which of the two a picker does with a pick, opening it in place or copying it, by UIKit's
    /// `documentPickerMode`, for comparing one picker's with another's. Read through a protocol
    /// because the property and its type are deprecated as a way to ASK for a mode, which `asCopy`
    /// now does, and naming either warns; the property is still the one public word on which
    /// mode a picker is in.
    @MainActor
    private func mode<Picker: PickerMode>(_ picker: Picker) -> Picker.Mode {
        picker.documentPickerMode
    }
}

/// `UIDocumentPickerViewController.documentPickerMode`, for `AudioFilePickerTests.mode`, with its
/// type inferred rather than named.
@MainActor
private protocol PickerMode {
    associatedtype Mode: Equatable
    var documentPickerMode: Mode { get }
}

extension UIDocumentPickerViewController: PickerMode {}

/// A presenter of one file with changes it has not saved yet, as an app editing a song presents it,
/// or a provider still bringing one down: asked to save by a coordinated read, it writes `saving`
/// over the file before the read goes ahead, and remembers it was asked.
private final class SavingPresenter: NSObject, NSFilePresenter, @unchecked Sendable {
    let presentedItemOperationQueue = OperationQueue()
    private let file: URL
    private let saving: Data
    private let asked = Held<Bool>()

    init(_ file: URL, saving: Data) {
        self.file = file
        self.saving = saving
    }

    var presentedItemURL: URL? { file }

    var wasAsked: Bool { asked.value ?? false }

    func savePresentedItemChanges(completionHandler: @escaping (Error?) -> Void) {
        asked.value = true
        do {
            try saving.write(to: file)
            completionHandler(nil)
        } catch {
            completionHandler(error)
        }
    }
}

/// A view controller that records what it is asked to present over itself and presents nothing:
/// UIKit as far as the picker can see it, with the completion UIKit calls once a presentation is up
/// kept for the test to call.
private final class RecordingPresenter: UIViewController {
    private(set) var asked: [(controller: UIViewController, completion: (() -> Void)?)] = []

    override func present(_ viewControllerToPresent: UIViewController, animated flag: Bool,
                          completion: (() -> Void)? = nil) {
        asked.append((viewControllerToPresent, completion))
    }
}

/// A value written on one queue and read on another.
private final class Held<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Value?

    var value: Value? {
        get { lock.lock(); defer { lock.unlock() }; return held }
        set { lock.lock(); held = newValue; lock.unlock() }
    }
}
