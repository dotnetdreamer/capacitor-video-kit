import Foundation
import UIKit

/// A file on its way out of the app and into the person's own files, for `saveToDownloads`: the
/// system's save sheet, and the copy under the right name that it is handed.
///
/// WHY A SHEET. iOS has no Downloads folder an app can write into. The Downloads in the Files app is
/// a folder like any other, in iCloud Drive or On My iPhone, and an app reaches a place there only
/// through the document picker in its exporting mode: the person sees the Files app's own sheet,
/// picks the place - Downloads among the ones it offers - and taps Save. Android puts the file in its
/// Downloads without asking (`Downloads.kt`); here the person chooses, and backing out is an answer,
/// `saved: false`, rather than a failure.
///
/// WHY A COPY FIRST. The sheet names what it saves after the file it is handed, and what the kit
/// holds is named for the kit: a kept sound is `<id>.m4a`, a staged render input `<uuid>.wav`. So
/// `stage` puts the file under the name it should have, alone in a folder of its own in
/// `tmp/videokit-downloads/`, as a hard link where it can - the same volume, no bytes copied - and as
/// a copy where it cannot. The sheet exports a copy of that (`asCopy: true`), and `release` deletes
/// the folder once the sheet has answered. A save cut short by the app being killed leaves its folder
/// for the plugin's next load (`clearOnLoad`), and iOS may empty `tmp` before then besides.
///
/// Main-actor bound, because the sheet is UIKit's and every callback of it comes on main. The file
/// work is not: the plugin runs `stage` off main (`VideoComposerPlugin.saveToDownloads`).
@MainActor
final class DownloadsExport: NSObject, UIDocumentPickerDelegate, UIAdaptivePresentationControllerDelegate {

    /// How a sheet ended.
    enum Outcome {
        /// Saved where the person chose: the new file, when the sheet said where.
        case saved(URL?)
        /// Backed out of, swiped away, or never put up.
        case cancelled
    }

    enum StageError: Error {
        /// Nothing at the URL, or nothing that is a file: `unreadable_input`.
        case unreadable(String)
    }

    // MARK: - The copy

    /// tmp/videokit-downloads/, built on `JobFolders.home` for the reason `AudioFilePicker.folder` is.
    nonisolated static var folder: URL {
        JobFolders.home.appendingPathComponent("tmp/videokit-downloads", isDirectory: true)
    }

    /// What a file is called when neither the caller nor its source names it, as on Android.
    nonisolated static let defaultName = "download"

    /// The name the file is saved under: `fileName`, or else the source's own name, trimmed and made
    /// a NAME rather than a path. A `/` or `\` becomes `_`, and a name that is `.` or `..`, which
    /// names a folder, is `download` as a missing one is. Android's `Gallery.nameOf`, by the same
    /// rules in the same order, so one call saves one name on both.
    nonisolated static func name(_ fileName: String?, source: URL) -> String {
        let given = fileName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = (given.isEmpty ? source.lastPathComponent : given)
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "\\", with: "_")
        return name.isEmpty || name == "." || name == ".." ? defaultName : name
    }

    /// Puts `source` under `name`, alone in a new folder in `folder`, and answers the file to hand
    /// the sheet. Throws `unreadable` for a source that is not a file that can be read, and the file
    /// system's own error for a copy that failed, which takes its folder with it.
    nonisolated static func stage(_ source: URL, as name: String) throws -> URL {
        let fm = FileManager.default
        var isDirectory: ObjCBool = false
        guard fm.fileExists(atPath: source.path, isDirectory: &isDirectory), !isDirectory.boolValue,
              fm.isReadableFile(atPath: source.path) else {
            throw StageError.unreadable("there is no file to read at \(source.path)")
        }
        let own = folder.appendingPathComponent(UUID().uuidString, isDirectory: true)
        try JobFolders.ensure(own)
        let target = own.appendingPathComponent(name, isDirectory: false)
        do {
            try fm.linkItem(at: source, to: target)
        } catch {
            do {
                try fm.copyItem(at: source, to: target)
            } catch {
                try? fm.removeItem(at: own)
                throw error
            }
        }
        return target
    }

    /// Deletes the folder `stage` made for `staged`, and nothing that is not one of those folders.
    nonisolated static func release(_ staged: URL) {
        let own = staged.deletingLastPathComponent()
        guard own.deletingLastPathComponent().standardizedFileURL.path == folder.standardizedFileURL.path else { return }
        try? FileManager.default.removeItem(at: own)
    }

    /// Every folder `stage` left behind, for the plugin's load, when no sheet of this launch is up
    /// yet to want one. Off main, as the rest of the launch sweep is (`JobFolders.sweepOnLaunch`).
    nonisolated static func clearOnLoad() {
        DispatchQueue.global(qos: .utility).async {
            try? FileManager.default.removeItem(at: folder)
        }
    }

    // MARK: - The sheet

    /// How long a sheet asked for may take to come up before it is taken for one UIKit dropped. The
    /// save sheet is the same document picker `AudioFilePicker` puts up, a view of another process,
    /// and `AudioFilePicker.presentationGrace` has the measurements behind the number.
    static let presentationGrace: TimeInterval = 10

    /// Called once, with how the sheet ended. Nil once it has been.
    private var finish: ((Outcome) -> Void)?

    private let controller: UIDocumentPickerViewController

    /// When `present` asked UIKit for the sheet, on `ProcessInfo.systemUptime`'s clock; nil before.
    private var askedAt: TimeInterval?

    /// Whether UIKit has said the sheet is up, through the presentation's completion.
    private var isShown = false

    /// A sheet that saves a copy of `staged` wherever the person picks, and calls `finish` once it
    /// has, or once they have backed out.
    init(exporting staged: URL, finish: @escaping (Outcome) -> Void) {
        controller = UIDocumentPickerViewController(forExporting: [staged], asCopy: true)
        self.finish = finish
        super.init()
        controller.delegate = self
        // Swiping the sheet away is a cancel too, and is told here rather than to the picker's own
        // delegate. `settle` takes whichever arrives first.
        controller.presentationController?.delegate = self
    }

    /// Whether the sheet is open: presented, or asked for and on its way up, for at most
    /// `presentationGrace`. `AudioFilePicker.isOpen` says why UIKit's own state is not enough.
    func isOpen(now: TimeInterval = ProcessInfo.processInfo.systemUptime) -> Bool {
        if controller.presentingViewController != nil { return true }
        if isShown { return false }
        guard let askedAt else { return false }
        return now - askedAt < Self.presentationGrace
    }

    /// Answers a cancel for a sheet UIKit never put up, once `presentationGrace` has passed. A sheet
    /// UIKit did put up is left to its delegate, however long the person takes to pick a place.
    func settleIfNeverShown() {
        guard !isShown, controller.presentingViewController == nil else { return }
        settle(.cancelled)
    }

    /// Presents the sheet over whatever `presenter` already shows, and answers whether UIKit was
    /// asked to: refused for a view controller in no window, which UIKit presents nothing from,
    /// dropping `finish` uncalled so that nothing answers a call the plugin has rejected. The same
    /// steps, for the same reasons, as `AudioFilePicker.present`.
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

    /// Calls `finish` with `outcome`, the first time only.
    func settle(_ outcome: Outcome) {
        guard let finish else { return }
        self.finish = nil
        finish(outcome)
    }

    /// Told once the copy is where the person chose. In exporting mode this is only ever a save.
    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        settle(.saved(urls.first))
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        settle(.cancelled)
    }

    func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
        settle(.cancelled)
    }
}
