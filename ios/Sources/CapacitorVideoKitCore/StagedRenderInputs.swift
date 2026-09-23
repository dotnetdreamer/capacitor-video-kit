import Foundation

/// Files a render reads an input from when the page holds that input only as bytes: the iOS half of
/// `stageRenderInput` and `releaseRenderInputs`, as `StagedRenderInputs.kt` is Android's.
///
/// WHY THIS EXISTS AT ALL. A sound the page made or read in - the browser sound library's WAV, a
/// track picked through a file input - lives behind a `blob:` URL, which names memory inside the web
/// view and nothing AVFoundation can open. The render needs a file, so the page writes one through
/// here: the package's `withNativeRenderInputs` reads each blob and sends its bytes over as base64, a
/// megabyte at a time, the first chunk making a new file and every later one appended to it, and
/// releases the files once the render has finished, failed or been cancelled. A megabyte at a time
/// because the bridge carries a call as one string: a three minute WAV sent whole is thirty megabytes
/// held several times over - the blob, its base64, the bridge's copy, the decoded bytes - on a phone
/// that is about to start an encoder.
///
/// The folder is the kit's own, `tmp/videokit-render-inputs`, and both calls act only inside it. Each
/// takes a name from the page and does something to the file it names, and without that rule a page
/// could append to any file the app can write - a draft store, the customer's sound library - or
/// delete one. So an append must name a file directly in the folder, which only this makes, and a
/// release passes over every name that is not one. The check is made on paths with every link and
/// `..` resolved, so neither gets out. `tmp` rather than Caches, the counterpart of the `cacheDir`
/// Android keeps its folder in, because `tmp` is iOS's folder for files that need not outlive the
/// launch that wrote them, which a staged input is, and iOS empties it by itself while the app is
/// not running.
///
/// A new file is named with the extension the page gives, because AVFoundation picks its reader by
/// a file's extension and refuses a file that has none. That is only the better first guess:
/// `RenderInputs` reads the first bytes of every input and opens one named wrongly under a name that
/// is right, so a page that sends no extension, or the wrong one, still renders.
///
/// Nothing but the page's release normally deletes a file here. A render whose app was killed before
/// the page could release its inputs leaves them behind, and `JobFolders.sweep` clears anything here
/// older than a day on the next launch: long past any render that could still be reading one, and
/// soon enough that a leftover never matters.
///
/// Every function here touches the disk, so the plugin calls each from its staging queue, never
/// inline on the Capacitor queue, and in the order the calls came (see
/// `VideoComposerPlugin.staging`).
enum StagedRenderInputs {

    /// tmp/videokit-render-inputs/
    ///
    /// Built on `JobFolders.home`, so the names handed out here are spelled as every other name the
    /// kit hands out. A pure path getter: `stage` makes the folder before its first file.
    static var folder: URL {
        JobFolders.home.appendingPathComponent("tmp/videokit-render-inputs", isDirectory: true)
    }

    /// A call the page got wrong - a name outside the folder, data that is not base64, an extension
    /// that is not one - which the plugin answers `invalid_spec`. Its own type so that a disk that
    /// refused a write, which is not the page's mistake, cannot be answered the same way.
    struct Refused: Error {
        let message: String
    }

    // MARK: - stage

    /// Writes one chunk and answers the file it went into, named as the folder names it.
    ///
    /// Without `uri` the chunk starts a new file, `<uuid>` plus the extension when there is one; with
    /// it, the chunk is appended to the file `uri` names, which must be one this made and still there.
    /// An append to nothing is refused rather than begun again, because a file that lost its head
    /// opens as a broken sound, and the page would rather be told than render one. `extension` is
    /// checked on every chunk and used only on the first: the name is settled once the file exists.
    ///
    /// Every chunk is decoded on its own. `FileReader` pads each one it encodes, so the chunks cannot
    /// be joined as text and decoded once, but their bytes join as they are.
    static func stage(_ data: String, onto uri: String?, extension raw: String?) throws -> URL {
        let suffix = try extensionName(raw).map { "." + $0 } ?? ""
        let target: URL
        if let uri {
            guard let file = staged(uri), isFile(file) else {
                throw Refused(message: "\(uri) is not a render input staged here")
            }
            target = file
        } else {
            target = folder.appendingPathComponent(UUID().uuidString + suffix, isDirectory: false)
        }
        guard let bytes = Data(base64Encoded: data) else { throw Refused(message: "data is not base64") }

        guard uri != nil else {
            try JobFolders.ensure(folder)
            do {
                try bytes.write(to: target)
            } catch {
                // A new file the write failed on is deleted here, because the page never learned its
                // name and so can never release it.
                try? FileManager.default.removeItem(at: target)
                throw error
            }
            return target
        }
        // An append that failed leaves its file, whose name the page holds and releases like any
        // other.
        let handle = try FileHandle(forWritingTo: target)
        defer { try? handle.close() }
        try handle.seekToEnd()
        try handle.write(contentsOf: bytes)
        return target
    }

    // MARK: - release

    /// Deletes every file `uris` names in the folder, and passes over every other name. Never throws:
    /// a file that will not go is the launch sweep's, and the render it fed is over either way, so
    /// the page is not told.
    static func release(_ uris: [String]) {
        for uri in uris {
            guard let file = staged(uri), isFile(file) else { continue }
            do {
                try FileManager.default.removeItem(at: file)
            } catch {
                NSLog("[CapacitorVideoKitCore] could not release render input %@: %@",
                      file.path, error.localizedDescription)
            }
        }
    }

    // MARK: - Names

    /// The file `uri` names when it sits directly in `folder`, spelled as a new one's name is, or nil
    /// for any other name: a file elsewhere, the folder itself, a file in a folder below it, a URI of
    /// another scheme. Whether the file exists is the caller's question.
    ///
    /// A `file://` URI and a bare path are both read, through `JobFolders.fileURL(from:)` as every
    /// other name the plugin opens. Both sides have their links and `..` resolved before they are
    /// compared, and what comes back is built from `folder` rather than from `uri`, so a name the page
    /// sends in some other spelling of the same file - `/private/var` for `/var` - is answered in the
    /// one the page was first given.
    static func staged(_ uri: String) -> URL? {
        guard let url = JobFolders.fileURL(from: uri) else { return nil }
        let resolved = url.standardizedFileURL.resolvingSymlinksInPath()
        guard resolved.deletingLastPathComponent().path == folder.resolvingSymlinksInPath().path else {
            return nil
        }
        return folder.appendingPathComponent(resolved.lastPathComponent, isDirectory: false)
    }

    /// The extension a new file is named with, without its dot, or nil for none.
    ///
    /// Taken with or without a leading dot, because both are how an extension is written and the two
    /// mean the same file. Anything but letters and digits is refused rather than cleaned: it becomes
    /// part of a path, and a caller that sends `../x` has a bug worth hearing about. The same rule as
    /// Android's `StagedRenderInputs.extension`, so one page is refused on both or neither.
    static func extensionName(_ raw: String?) throws -> String? {
        guard let raw else { return nil }
        let bare = raw.hasPrefix(".") ? String(raw.dropFirst()) : raw
        guard !bare.isEmpty else { return nil }
        guard bare.range(of: "^[A-Za-z0-9]{1,16}$", options: .regularExpression) != nil else {
            throw Refused(message: "\(raw) is not an extension")
        }
        return bare
    }

    /// A file that is there and is not a folder: the folder is never a staged input, and a name for
    /// it is never appended to or deleted.
    private static func isFile(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && !isDirectory.boolValue
    }
}
