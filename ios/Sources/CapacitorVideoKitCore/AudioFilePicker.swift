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
/// The copy is the page's to read, once, as soon as it is answered: the host's picker reads its
/// bytes into a `Blob`, and nothing after that learns the song came in another way, which is why the
/// contract has a host never keep the name. So it lives in `tmp/videokit-audio/`, and goes without
/// being asked for: the next pick clears the folder before it puts its own song there (`keep`), and
/// `JobFolders.sweep` clears whatever is left when the plugin next loads. By either time the page
/// it was answered to has read it - a person has been through the picker again since, or that page
/// has been replaced - so a page that has read the bytes has no call to make, and one song at most
/// is on disk here beside the page's `Blob`. iOS may also purge `tmp` while the app is not running.
///
/// Main-actor bound, because the picker is UIKit's, and every callback of it comes on main. The file
/// work is not, and the plugin runs it off main (`VideoComposerPlugin.pickAudioFile`).
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

    /// Deletes every song in `folder`, whatever its age, and leaves the folder. For `keep`, before it
    /// puts the next one there, and for `JobFolders.sweep`: see the type's doc for why no song is
    /// wanted by then. Best effort, as every sweep is: a song that would not delete is tried again by
    /// the next pick or the next load.
    nonisolated static func clear() {
        let fm = FileManager.default
        for song in (try? fm.contentsOfDirectory(at: folder, includingPropertiesForKeys: nil)) ?? [] {
            try? fm.removeItem(at: song)
        }
    }

    /// Puts what the picker picked in `folder` under a name of its own, and answers it.
    ///
    /// Clears the folder first (`clear`): the song there is the last pick's, which its page read as
    /// it was answered, long before a person could get through the picker again. The plugin makes one
    /// of these at a time (`VideoComposerPlugin.audioCopies`), so a clear never takes a song another
    /// `keep` is still writing.
    ///
    /// Moved when it is in this app's container, as the picker's copy is: `asCopy` has iOS copy the
    /// file into the app's `tmp` before it answers and leave that copy for the app to deal with, so
    /// moving it keeps one song on disk rather than two, and the move is a rename. Copied from
    /// anywhere else, because a file outside the container is not the app's to take away. A move or
    /// a copy that fails takes the half-written copy with it, and the picker's own copy too, by
    /// `JobFolders.removeIfScratch`'s rule, because its folder is one no sweep looks in.
    ///
    /// Named `<uuid>.<ext>`: a UUID because two songs called `Track 1.mp3` from two albums are two
    /// picks, and the picked extension because the local server that plays the file to the page, and
    /// AVFoundation when a host renders it, both take a file's type from its name (see
    /// `RenderInputs`). A song with no extension is named by the UUID alone.
    ///
    /// `mimeType` is the type iOS gives the extension, for the page: its `Blob` needs one, and the
    /// local server's response for a whole file carries none.
    nonisolated static func keep(_ picked: URL) throws -> PickedAudioFile {
        let fm = FileManager.default
        var target = folder.appendingPathComponent(UUID().uuidString, isDirectory: false)
        if !picked.pathExtension.isEmpty { target.appendPathExtension(picked.pathExtension) }
        clear()
        try JobFolders.ensure(folder)
        do {
            if JobFolders.containerRelativePath(picked) != nil {
                try fm.moveItem(at: picked, to: target)
            } else {
                // `asCopy` promises a file in the container, so this is for a picker that ever breaks
                // the promise: a document picker URL from outside the sandbox reads only between these
                // two calls. For any other URL the first answers false, and the second is not made.
                let scoped = picked.startAccessingSecurityScopedResource()
                defer { if scoped { picked.stopAccessingSecurityScopedResource() } }
                try fm.copyItem(at: picked, to: target)
            }
        } catch {
            try? fm.removeItem(at: target)
            JobFolders.removeIfScratch(picked)
            throw error
        }

        let mimeType = picked.pathExtension.isEmpty
            ? nil
            : UTType(filenameExtension: picked.pathExtension)?.preferredMIMEType
        return PickedAudioFile(url: target, fileName: picked.lastPathComponent, mimeType: mimeType)
    }

    // MARK: - The picker

    /// Called once, with what was picked, or nil for a cancel. Nil once it has been.
    private var finish: ((URL?) -> Void)?

    private let controller: UIDocumentPickerViewController

    /// A picker for one audio file, which calls `finish` when the person has picked one or gone back.
    ///
    /// `asCopy` so the picked file is the app's own from the start, with no security scope to hold
    /// open while it is read, and `.audio` - `public.audio` - so every sound the phone can name is
    /// offered and nothing else is.
    init(finish: @escaping (URL?) -> Void) {
        controller = UIDocumentPickerViewController(forOpeningContentTypes: [.audio], asCopy: true)
        self.finish = finish
        super.init()
        controller.allowsMultipleSelection = false
        controller.delegate = self
        // Swiping the sheet away is a cancel too, and is told here rather than to the picker's own
        // delegate. `settle` takes whichever arrives first.
        controller.presentationController?.delegate = self
    }

    /// Whether the picker is up: presented and not yet gone. The plugin refuses a second picker while
    /// this one is, rather than stacking two and answering one of them.
    var isOnScreen: Bool {
        controller.presentingViewController != nil
    }

    /// Presents the picker over whatever `presenter` already shows, and answers whether it went up.
    ///
    /// Over the top of what is shown because UIKit presents nothing from a view controller that is
    /// presenting something else, passing over one on its way out because a picker put over it would
    /// go with it. UIKit still refuses some presentations - from a view whose window is gone, in the
    /// middle of another transition - and says so only in the log, and a picker that never went up
    /// never calls back. So a refusal answers false for the plugin to reject at once, rather than
    /// leave the page waiting on an answer nobody will give, and spends the picker: `finish` is dropped
    /// uncalled, so a presentation UIKit made after all cannot answer a call already refused.
    func present(from presenter: UIViewController) -> Bool {
        var top = presenter
        while let shown = top.presentedViewController, !shown.isBeingDismissed { top = shown }
        top.present(controller, animated: true)
        guard isOnScreen else {
            finish = nil
            return false
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
        // No URL is nothing picked: a cancel by another name.
        let taken = finish == nil ? nil : urls.first
        settle(urls.first)
        // A pick told after the picker was answered - settled as gone, or refused - is a copy nobody
        // will ask for, and so is any past the first, which a picker of one file should never send.
        // `asCopy` left each in `tmp/<bundle id>-Inbox/`, which no sweep looks in, so they go now.
        for url in urls where url != taken { JobFolders.removeIfScratch(url) }
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
