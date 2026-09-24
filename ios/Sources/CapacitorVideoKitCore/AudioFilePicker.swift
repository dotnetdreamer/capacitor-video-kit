import Foundation
import UIKit
import UniformTypeIdentifiers

/// A song from the phone's files, for `pickAudioFile`: the document picker, and the copy of what it
/// picked that the page reads.
///
/// WHY A NATIVE PICKER. The kit's browser media host picks a sound through an `<input type="file">`,
/// and WKWebView cannot be trusted with one. It copies the chosen file into a
/// `tmp/WKFileUploadPanel-*` folder of its own before the page is told, and that copy fails without a
/// word when the same song is picked again about a minute after the first time: the page is handed a
/// File of 0 bytes, and a good song reads as one the app cannot use. Measured on an iOS 26.5
/// simulator, and it is exactly Replace on a track somebody has just set up. An input that asked for
/// `audio/*` greyed out every file besides. So on iOS the host's picker (`defaults.ts`) asks for this
/// instead, which goes straight to the document picker for any audio file and makes the copy itself.
/// Android's WebView is not WebKit and its file input works, so `pickAudioFile` is refused there as
/// `unimplemented` (`VideoComposerPlugin.kt`), and the web has no native side to ask.
///
/// WHY IT OPENS THE SONG IN PLACE. Asked for a copy (`asCopy: true`), the document picker makes
/// one of its own in `tmp/<bundle id>-Inbox/` before it answers, and that copy fails much as the web
/// view's does: when the same file is picked again about a minute after the first time - 57 to
/// 63 s apart, on the same iOS 26.5 simulator - iOS's own picker code deletes its fresh copy 8 to
/// 60 ms after making it, about 0.6 s before `documentPicker(_:didPickDocumentsAt:)` is called.
/// The name it answers has nothing behind it, taking the file fails (`NSCocoaErrorDomain` 4), and
/// a good M4A reads as one the app cannot use, on exactly the Replace this picker is here for. So
/// the picker opens the song where it is (`asCopy: false`), and `keep` makes the only copy there
/// is, from the person's own file, which nothing but the person deletes. A re-pick 60.5 s after
/// the first, which failed every time with a copy, passes opened in place.
///
/// What that gives up is the picker's own download. Asked for a copy, the picker fetches a song
/// still in iCloud, or at another app's file provider, inside its own sheet, with a progress bar
/// and a cancel, before it answers. Opened in place, it answers with the file where it is,
/// downloaded or not, and the download is the coordinated read `keep` makes after the sheet has
/// gone: nothing native shows its progress, nothing can cancel it, and it has no deadline, since
/// any deadline short enough to matter would also fail a long song on a slow network, which is
/// the one case the wait is for. The kit's editor waits for the answer and asks for no second pick
/// meanwhile (`EditorMedia.pickMusic`), so a download that stalls holds that one pick; a host that
/// asks again before it answers waits behind it on `copies`, as would the clear of a bridge loaded
/// meanwhile. A download that fails - offline, say - rejects `unknown`, which a host reads as a
/// song the app cannot use though the song is good. Losing the song on every Replace made about a
/// minute after the first pick is worse than all of that.
///
/// The copy is the page's to read, once, as soon as it is answered: the host's picker reads its
/// bytes into a `Blob`, and nothing after that learns the song came in another way, which is why the
/// contract has a host never keep the name. So it lives in `tmp/videokit-audio/`, and goes without
/// being asked for: the next pick clears the folder before it puts its own song there (`keep`), and
/// the plugin clears whatever is left when it loads (`clearOnLoad`). Capacitor loads a plugin as a
/// bridge registers it, before that bridge loads its page - once a launch, in an app with one
/// bridge - and a web view reload only resets the bridge (see `VideoComposerPlugin.load`). By either
/// time the page it was answered to has read it - a person has been through the picker again
/// since, or that page was a bridge's that is gone, in practice an earlier launch's - so a page that
/// has read the bytes has no call to make, and one song at most is on disk here beside the page's
/// `Blob`. A page reloaded after a pick leaves its song here until the next pick or the next launch,
/// which is still one song. iOS may also purge `tmp` while the app is not running. Every write and
/// every clear of the folder is made on one queue (`copies`), so neither ever takes a song another
/// is still writing.
///
/// Main-actor bound, because the picker is UIKit's, and every callback of it comes on main. The file
/// work is not: it runs on `copies`, off main (`VideoComposerPlugin.pickAudioFile`).
@MainActor
final class AudioFilePicker: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {

    // MARK: - The copy

    /// tmp/videokit-audio/
    ///
    /// Built on `JobFolders.home`, so the names handed out here are spelled as every other name the
    /// kit hands out. A pure path getter: `keep` makes the folder before its first file.
    nonisolated static var folder: URL {
        JobFolders.home.appendingPathComponent("tmp/videokit-audio", isDirectory: true)
    }

    /// The `pickAudioFile` answer for a cancel: nothing was picked, which is an answer rather than a
    /// failure, as a cancel is for every other picker a host uses.
    nonisolated static var cancelled: [String: Any] { ["cancelled": true] }

    /// Where every `keep` and every clear of `folder` is made, one at a time and in the order they
    /// were asked for. Each of them empties the folder, so two at once could take a song the other
    /// is still writing. Two keeps would overlap only for a host that asks again before its last
    /// pick has answered and a person quick enough to pick in between. A keep and the clear on load
    /// would overlap only for a host that builds a second bridge while the first one's page is still
    /// copying a song - `load()` runs as a bridge registers the plugin, before its page is loaded,
    /// and not when the web view reloads (see `VideoComposerPlugin.load`) - or for a clear made any
    /// later than the load (`clearOnLoad`). Either would cost the song.
    nonisolated static let copies = DispatchQueue(label: "net.dotnetdreamer.videokit.audio", qos: .userInitiated)

    /// Deletes every song in `folder`, whatever its age, and leaves the folder. For `keep`, before it
    /// puts the next one there, and for `clearOnLoad`: see the type's doc for why no song is wanted
    /// by then. Best effort, as every sweep is: a song that would not delete is tried again by the
    /// next pick or the next load. Made on `copies` by every caller but the tests.
    nonisolated static func clear() {
        let fm = FileManager.default
        for song in (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: song)
        }
    }

    /// `clear`, for the plugin's `load`, queued on `copies` at once rather than made where the rest
    /// of the launch sweep runs (`JobFolders.sweepOnLaunch`).
    ///
    /// Queued at the moment of the load, it comes after every `keep` asked for before it and before
    /// every one asked for after it. `load()` runs as a bridge registers the plugin, before the
    /// bridge loads its page (see `VideoComposerPlugin.load`), so that is exactly the line between
    /// the songs pages that are gone were answered and the songs the new page will be. Made at the
    /// end of the sweep instead, after it has walked every job folder, it could land after the new
    /// page's first pick and take the song that pick was answered, and made off the queue it could
    /// take a song halfway through being copied.
    nonisolated static func clearOnLoad() {
        copies.async { clear() }
    }

    /// Copies the song the picker opened into `folder` under a name of its own, and answers the copy.
    ///
    /// Clears the folder first (`clear`): the song there is the last pick's, which its page read as
    /// it was answered, long before a person could get through the picker again. The plugin runs
    /// this on `copies`, so the clear never takes a song another `keep` is still writing.
    ///
    /// A copy, always, and never a move: the picker opens the song where it is (see the type's doc),
    /// so `picked` is the person's own file - in iCloud Drive, in another app's folder, or in this
    /// app's own Documents for a host that shares them with the Files app - and is not the kit's to
    /// take away, wherever it is. The copy is read inside the file's security scope, without which a
    /// file the picker opened outside the app cannot be read at all, and the scope is closed again
    /// however the copy ends; a URL with no scope answers false to the opening, is copied all the
    /// same, and is not closed. The read is a coordinated one (`NSFileCoordinator`), as Apple asks
    /// of every file a document picker opens: iCloud or the file's provider downloads the file, or
    /// finishes writing it, before the copy starts, and hands over the URL to read it by. A song
    /// still in iCloud is downloaded here, on `copies`, with no progress, no cancel and no deadline,
    /// and the page waits for it (the type's doc says what that costs). A copy that fails takes its
    /// half-written file with it, and leaves the pick as it was.
    ///
    /// Named `<uuid>.<ext>`: a UUID because two songs called `Track 1.mp3` from two albums are two
    /// picks, and the picked extension because the local server that plays the file to the page, and
    /// AVFoundation when a host renders it, both take a file's type from its name (see
    /// `RenderInputs`). A song with no extension is named by the UUID alone.
    ///
    /// `mimeType` is the type iOS gives the extension, for the page: its `Blob` needs one, and the
    /// local server's response for a whole file carries none.
    ///
    /// `opening` and `closing` are the picked URL's own `startAccessingSecurityScopedResource` and
    /// `stopAccessingSecurityScopedResource`, and parameters for the tests alone, which have no URL
    /// a picker opened and count the two instead.
    nonisolated static func keep(
        _ picked: URL,
        opening: (URL) -> Bool = { $0.startAccessingSecurityScopedResource() },
        closing: (URL) -> Void = { $0.stopAccessingSecurityScopedResource() }
    ) throws -> PickedAudioFile {
        var target = folder.appendingPathComponent(UUID().uuidString, isDirectory: false)
        if !picked.pathExtension.isEmpty { target.appendPathExtension(picked.pathExtension) }
        clear()
        try JobFolders.ensure(folder)
        let scoped = opening(picked)
        defer { if scoped { closing(picked) } }
        do {
            try copyCoordinated(picked, to: target)
        } catch {
            try? FileManager.default.removeItem(at: target)
            throw error
        }

        let mimeType = picked.pathExtension.isEmpty
            ? nil
            : UTType(filenameExtension: picked.pathExtension)?.preferredMIMEType
        return PickedAudioFile(url: target, fileName: picked.lastPathComponent, mimeType: mimeType)
    }

    /// Copies `source` to `target` under a coordinated read of `source`, for `keep`: see there for
    /// why coordinated. Throws the coordination's own error when the read could not be coordinated,
    /// in which case the copy was never tried, and otherwise the copy's.
    private nonisolated static func copyCoordinated(_ source: URL, to target: URL) throws {
        var coordinating: NSError?
        var copying: Error?
        NSFileCoordinator().coordinate(readingItemAt: source, options: [], error: &coordinating) { readable in
            do {
                try FileManager.default.copyItem(at: readable, to: target)
            } catch {
                copying = error
            }
        }
        if let failure = coordinating ?? copying { throw failure }
    }

    // MARK: - The picker

    /// How long a picker asked for may take to come up before it is taken for one UIKit dropped.
    ///
    /// UIKit puts a document picker up late: it is a view of another process, and nothing of the
    /// presentation shows - no `presentingViewController`, no presented view controller on the
    /// presenter - until that process has answered, which was measured at 1.1 s and at 2.6 s in the
    /// test process. A picker is open from the moment it is asked for (`isOpen`), so a second call
    /// in that time is refused rather than taken for a picker that went away. One that is still not
    /// up once this has passed is one UIKit dropped after it was asked for - asked while the view
    /// controller under it was in the middle of a transition, which UIKit says only in the log - and
    /// `present` answers it as a cancel then (`settleIfNeverShown`). Nothing else would: no delegate
    /// hears of a picker that never came up, and a page that asks for one pick at a time and waits
    /// for each answer before it asks again, as the kit's editor does (`EditorMedia.pickMusic`),
    /// would never ask again. Ten seconds is nearly four times the longest wait measured.
    static let presentationGrace: TimeInterval = 10

    /// Called once, with what was picked, or nil for a cancel. Nil once it has been.
    private var finish: ((URL?) -> Void)?

    private let controller: UIDocumentPickerViewController

    /// When `present` asked UIKit for the picker, on `ProcessInfo.systemUptime`'s clock; nil
    /// before.
    private var askedAt: TimeInterval?

    /// Whether UIKit has said the picker is up, which it says by calling the presentation's
    /// completion once the picker has finished coming on screen.
    private var isShown = false

    /// A picker for one audio file, which calls `finish` when the person has picked one or gone back.
    ///
    /// Opening the file in place (`asCopy: false`), so that iOS makes no copy of its own to lose on
    /// a re-pick (see the type's doc) and hands over the person's file with a security scope for
    /// `keep` to read it in; and `.audio` - `public.audio` - so every sound the phone can name is
    /// offered and nothing else is.
    init(finish: @escaping (URL?) -> Void) {
        controller = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: false)
        self.finish = finish
        super.init()
        controller.allowsMultipleSelection = false
        controller.delegate = self
        // Swiping the sheet away is a cancel too, and is told here rather than to the picker's own
        // delegate. `settle` takes whichever arrives first.
        controller.presentationController?.delegate = self
    }

    /// Whether the picker is open: presented, or asked for and on its way up. The plugin refuses a
    /// second picker while one is, rather than stacking two and answering one of them, and answers
    /// one that is not - gone without a word from UIKit, or never come up - as a cancel.
    ///
    /// Presented is UIKit's own `presentingViewController`, and it is enough whatever else has or
    /// has not been heard. The presentation's completion is not: it was measured never arriving in
    /// the test process for a picker presented from 1.1 s to past 15 s, and a picker on screen taken
    /// for one gone would be answered as a cancel with a second stacked over it, and its pick lost.
    /// On its way up is from the moment `present` asks UIKit for it until UIKit says it is up
    /// (`isShown`), and at most `presentationGrace`: see there for why UIKit's own state cannot
    /// tell a picker on its way up from one that went. `now` is a parameter for the tests; the
    /// plugin takes the clock.
    func isOpen(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        if controller.presentingViewController != nil { return true }
        if isShown { return false }
        guard let askedAt else { return false }
        return now - askedAt < Self.presentationGrace
    }

    /// Answers a cancel for a picker UIKit never put up, which `present` asks for once
    /// `presentationGrace` has passed: see there for why nothing else would answer it.
    ///
    /// A picker UIKit has presented, or said was up, is left to the answers UIKit gives its
    /// delegate: a pick is told only once the person has picked, however long they take, and a
    /// cancel made here ahead of it would throw that pick away.
    func settleIfNeverShown() {
        guard !isShown, controller.presentingViewController == nil else { return }
        settle(nil)
    }

    /// Presents the picker over whatever `presenter` already shows, and answers whether UIKit was
    /// asked to.
    ///
    /// Over the top of what is shown because UIKit presents nothing from a view controller that is
    /// presenting something else, passing over one on its way out because a picker put over it
    /// would go with it. Refused when that view controller is in no window, which UIKit presents
    /// nothing from and says so only in the log, so that the plugin rejects at once rather than
    /// leave the page waiting on an answer nobody will give. The check comes BEFORE UIKit is asked,
    /// and has to: UIKit puts the picker up late (`presentationGrace`), so nothing about the picker
    /// says it is up by the time `present` returns. A check after it found nothing up, rejected the
    /// call, and left a picker coming up whose pick nobody would take, which is how lighsnip's song
    /// picks were lost on the simulator. A refusal still spends the picker, dropping `finish`
    /// uncalled, so that nothing can answer a call the plugin has already rejected.
    ///
    /// Open (`isOpen`) from before UIKit is asked, so that a second call while it comes up finds it
    /// open, and answered as a cancel if UIKit has not put it up by the end of `presentationGrace`
    /// (`settleIfNeverShown`), since a window found now is no promise that UIKit will present.
    /// That wait holds the picker weakly: one answered sooner has nothing left for it to do.
    func present(from presenter: UIViewController) -> Bool {
        var top = presenter
        while let shown = top.presentedViewController, !shown.isBeingDismissed { top = shown }
        guard top.viewIfLoaded?.window != nil else {
            finish = nil
            return false
        }
        askedAt = ProcessInfo.processInfo.systemUptime
        top.present(controller, animated: true) { [weak self] in self?.isShown = true }
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(Self.presentationGrace * 1_000_000_000))
            self?.settleIfNeverShown()
        }
        return true
    }

    /// Calls `finish` with `picked`, the first time only. A pick and a dismissal can both be told for
    /// the one picker, and the plugin settles a picker that went away without telling either (see
    /// `VideoComposerPlugin.pickAudioFile`).
    func settle(_ picked: URL?) {
        guard let finish else { return }
        self.finish = nil
        finish(picked)
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        // No URL is nothing picked: a cancel by another name. A URL past the first, which a picker
        // of one file should never send, and a pick told after the picker was answered - settled as
        // gone, or refused - are left where they are: each is the person's own file, opened in
        // place, with no copy made of it and no scope opened on it to close.
        settle(urls.first)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        settle(nil)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        settle(nil)
    }
}

/// One song `AudioFilePicker.keep` put in `AudioFilePicker.folder`.
struct PickedAudioFile {
    /// The copy.
    let url: URL
    /// What the file was called where it was picked, extension included: the name to show.
    let fileName: String
    /// Nil for a file iOS has no MIME type for: one with no extension, or a CAF, which iOS types as
    /// audio and names no MIME type for.
    let mimeType: String?

    /// The `pickAudioFile` answer, `mimeType` left out when there is none.
    var json: [String: Any] {
        var json: [String: Any] = ["cancelled": false, "uri": url.absoluteString, "fileName": fileName]
        if let mimeType { json["mimeType"] = mimeType }
        return json
    }
}
