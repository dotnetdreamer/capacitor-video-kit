import Foundation

/// The files a host goes on naming after the launch that picked them: what `retainMedia`,
/// `checkMedia`, `releaseMedia` and `sweepMedia` do on iOS.
///
/// WHY A FILE IS MOVED HERE WHEN ANDROID MOVES NONE. A host that saves its work - a draft, an edit
/// left for later - stores the name of every clip in it, and the two systems break that name in
/// opposite ways. Android's photo picker hands over a permission and no file, and the permission
/// dies with the process, so Android's `RetainedMedia.kt` makes the permission last and copies
/// nothing. iOS hands over a file and no permission, because none is needed: a file picker plugin
/// such as `@capawesome/capacitor-file-picker` copies every PHPicker and document pick into
/// `Library/Caches/<UUID>/` and answers with that copy's `file://` URL. The copy belongs to this app
/// alone. But Caches is the one folder iOS empties by itself when the disk runs low, and it does so
/// while the app is not running. A draft that stored that URL would come back, some later day, to a
/// clip that was gone, and could not tell that clip from a video the customer had deleted.
///
/// So `retain` moves that copy into `Library/Application Support/videokit-picked/`, which iOS never
/// purges. The move is a rename on the same volume, not a second copy of the bytes. The file is
/// excluded from backup, because it is a copy of a video that is already in the customer's photo
/// library, and iCloud already holds it once. The photo library copies `GalleryLibrary.resolve` makes
/// live beside it in `videokit-gallery/`, for the same reasons and on the same terms.
///
/// What a kept copy costs is settled here too, for a host that says what it still uses:
///  - The name `retain` answers includes the install's container folder,
///    `Containers/Data/Application/<UUID>/`, and iOS gives an app a new one when it is updated, with
///    every file carried across - a phone on every App Store update, a simulator on every
///    `simctl install`. `check` answers the name a stored one has in THIS install, by
///    `JobFolders.rebased`'s rule, and the package's `currentMediaUri` asks it only for a name that
///    names a container.
///  - A copy stays until something deletes it, and nothing in iOS will. `release` deletes the copies
///    a host has stopped using, and `sweep` every copy that nothing still uses.
///
/// Android keeps no copies and the web has no files, so `releaseMedia` and `sweepMedia` answer there
/// without doing anything, and `requestMediaAccess`, which is Android's grant, is granted here
/// without a prompt (see `VideoComposerPlugin.requestMediaAccess`).
///
/// Every function here touches the disk, so the plugin calls each from a `Task`, never inline on
/// the Capacitor queue.
enum RetainedMedia {

    /// Library/Application Support/videokit-picked/
    ///
    /// Named as `GalleryLibrary.copiesFolder` is, for the kit and for what is in it. A pure path
    /// getter, like `JobFolders.root`: nothing writes here without `JobFolders.ensure` first.
    static var pickedFolder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("videokit-picked", isDirectory: true)
    }

    /// The folders whose files are the kit's own copies, kept for a host: everything `release` and
    /// `sweep` may delete is in one of these, and nothing outside them ever is.
    static var copyFolders: [URL] { [pickedFolder, GalleryLibrary.copiesFolder] }

    /// The copies `handOut` has given a host in this process, by their path below the container,
    /// and the lock every change to what is in `copyFolders` is made under.
    private static let handedOut = HandedOut()

    /// A class holding the lock and the paths together, for the reason `JobRegistry` holds its jobs
    /// behind its one lock: the paths cannot be reached without it. The lock is not recursive, so
    /// nothing run under it calls `locked` again.
    private final class HandedOut: @unchecked Sendable {
        private let lock = NSLock()
        private var paths: Set<String> = []

        func locked<T>(_ body: (inout Set<String>) throws -> T) rethrows -> T {
            lock.lock()
            defer { lock.unlock() }
            return try body(&paths)
        }
    }

    // MARK: - retain

    /// The longest-lived name this device will give for a file a picker handed over.
    ///
    /// `durable` is the honest half of the answer, as it is on Android: false means the name works
    /// now and may not after a restart, which a host needs to be told rather than find out. Every way
    /// this can fall short answers with the name as it came, because that name still plays for the
    /// rest of this session, and refusing it would break the pick today over a problem that only
    /// shows up tomorrow.
    ///
    /// `durable: true` promises the FILE, not the exact string. The file stays for as long as the host
    /// uses it, and the string names the container of this install, which `check` moves onto the
    /// current one when the host reads it back after an update.
    ///
    /// Answers:
    ///  - a file in Caches or tmp: moved, and the new name, durable. The picker's copies live there,
    ///    and so does anything else a plugin copied out for the moment, such as a voice take.
    ///  - a file anywhere else in this app's container, such as a gallery copy or a file retained
    ///    before: left where it is and answered as it came, durable, because iOS never empties those
    ///    folders by itself.
    ///  - anything else - a file that is already gone, a file outside the container, a folder, a name
    ///    that is not a file at all: answered as it came, and not durable.
    static func retain(_ uri: String) -> (uri: String, durable: Bool) {
        guard let url = JobFolders.fileURL(from: uri), isFile(url),
              let relative = JobFolders.containerRelativePath(url) else {
            return (uri, false)
        }
        guard relative.hasPrefix("Library/Caches/") || relative.hasPrefix("tmp/") else { return (uri, true) }

        do {
            return (try moveIntoPicked(url).absoluteString, true)
        } catch {
            // A full disk cannot stop a rename, so this is a folder that could not be made, or a file
            // that disappeared between the check above and the move. Either way the pick keeps the
            // name it came with, and the host is told that the name will not last.
            NSLog("[CapacitorVideoKitCore] retain could not move %@: %@", url.path, error.localizedDescription)
            return (uri, false)
        }
    }

    /// Moves a picked file to `videokit-picked/<uuid>.<ext>` and answers where it went.
    ///
    /// The extension is kept because AVFoundation picks its reader by the extension and refuses a
    /// file that has none (see `RenderInputs`). The new name is a UUID rather than the picker's own,
    /// because two picks of `IMG_0001.MOV` from two albums are two clips, and the second must not
    /// replace the first.
    ///
    /// The file is dated now. A move keeps the date the picker's copy carried, which can be the day
    /// the video was shot, and `sweep` spares every copy dated after the moment its host names, so
    /// a clip picked after that moment must not look older than it. The move and the date are one
    /// step to a sweep, because both are made through `handOut`, which also keeps this process's
    /// own sweeps off the copy whatever its date.
    private static func moveIntoPicked(_ url: URL) throws -> URL {
        let folder = pickedFolder
        try JobFolders.ensure(folder)
        var target = folder.appendingPathComponent(UUID().uuidString, isDirectory: false)
        if !url.pathExtension.isEmpty { target.appendPathExtension(url.pathExtension) }
        try handOut(target) {
            try FileManager.default.moveItem(at: url, to: target)
            // Best effort, as `JobFolders.ensure` is: a date that would not set is not a reason to
            // hand back a name that will not last.
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: target.path)
        }

        // Best effort too, and set on its own, so a flag that would not set cannot take the date
        // with it. The folder is already kept out of iCloud.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? target.setResourceValues(values)

        removeEmptyPickerFolder(url.deletingLastPathComponent())
        return target
    }

    /// The picker makes one `Caches/<UUID>/` folder per file and never removes it. Once the file has
    /// moved out, that folder is empty and belongs to nobody. It is removed only when it is empty and
    /// sits directly in Caches or tmp, so that nothing else can be caught by it.
    private static func removeEmptyPickerFolder(_ folder: URL) {
        guard let relative = JobFolders.containerRelativePath(folder) else { return }
        let parts = relative.split(separator: "/")
        let direct = (parts.count == 3 && parts[0] == "Library" && parts[1] == "Caches")
            || (parts.count == 2 && parts[0] == "tmp")
        guard direct, (try? FileManager.default.contentsOfDirectory(atPath: folder.path))?.isEmpty == true else {
            return
        }
        try? FileManager.default.removeItem(at: folder)
    }

    // MARK: - handOut

    /// Runs `place`, which puts `copy` where it is, and answers whether `copy` is there now. When it
    /// is, it is remembered as given to a host by this process. `retain` moves every pick in through
    /// this, and `GalleryLibrary.resolve` answers with no copy that has not been through it, whether
    /// it made the copy just now or found it made before.
    ///
    /// WHY IT IS REMEMBERED. A host sweeps as it starts, while the person may already be picking,
    /// and a clip picked then is in no draft yet. `sweep` passes over every copy remembered here,
    /// whatever its date. A date alone could not say that: a copy `resolve` finds on disk was made
    /// for a pick in an earlier launch and is dated then, and dating it again would change the
    /// signature `Thumbnailer` keeps its filmstrip under, so every pick of it would cut the strip
    /// again. `release` still deletes a copy handed out, because that is the host saying it is done
    /// with it. One handed out and then dropped without a word is left for a sweep in a later launch.
    ///
    /// WHY UNDER A LOCK. `place` and the remembering run under the lock `sweep` decides and deletes
    /// under. Otherwise a sweep that had read a copy as unused could delete it between `place`
    /// finding it and this remembering it, and a host would be handed the name of a file that was
    /// already gone. The folders `release` and `sweep` remove as empty are removed under it too, so
    /// a folder `place` has just made is never taken before its copy is in. Every sweep and release
    /// waits on `place`, so it does nothing slower than making a folder and a rename or a link.
    @discardableResult
    static func handOut(_ copy: URL, placing place: () throws -> Void) rethrows -> Bool {
        try handedOut.locked { paths in
            try place()
            guard isFile(copy) else { return false }
            if let path = ownPath(copy) { paths.insert(path) }
            return true
        }
    }

    /// `handOut` for a copy made before, found where it is: whether it is still there, and when it
    /// is, remembered as given to a host.
    static func handOut(_ copy: URL) -> Bool {
        handOut(copy, placing: {})
    }

    // MARK: - check

    /// Whether this name still opens, and the name it opens by in this install.
    ///
    /// Asked of the file itself, as Android opens a descriptor, rather than of any record about it.
    /// A file in this app's container either can be read or is gone - no grant can lapse on it - so
    /// being a readable file is the whole question. A name that is not a file has nothing on this
    /// side to open, and every way this fails gives the caller the same answer.
    ///
    /// The name is `JobFolders.rebasedURI`: a stored name whose container this install no longer has
    /// comes back in the current one when the file is there, and every other name comes back exactly
    /// as it came.
    static func check(_ uri: String) -> (exists: Bool, uri: String) {
        guard let url = JobFolders.fileURL(from: uri) else { return (false, uri) }
        return (isFile(url) && FileManager.default.isReadableFile(atPath: url.path), JobFolders.rebasedURI(uri))
    }

    // MARK: - release, sweep

    /// Deletes the copies among `uris` that the kit made for a host - retained picks in
    /// `videokit-picked/` and photo library copies in `videokit-gallery/` - except those `keep` also
    /// names, and passes over every other name, whatever it names. For a host that has just stopped
    /// using them, such as a deleted draft: it hands over everything that draft named in `uris`, and
    /// everything its other drafts still name in `keep`, because two drafts can share one pick, and
    /// working out which names only the deleted one used is exactly the comparison of names this
    /// makes by path and a host could only make by string.
    ///
    /// A name in `uris` is matched by where it points below Application Support, after
    /// `JobFolders.fileURL` has moved it onto this install's container, so a name stored before an
    /// update still finds its copy. A name `JobFolders.fileURL` cannot read is passed over, which
    /// leaves its copy to the next sweep. That costs some space until then, where the same misreading
    /// in `keep` would cost the clip, so `keep` is read as loosely as `sweep` reads its own
    /// (`keptPaths`): a name read more ways than it meant can only spare more. With no `keep`, every
    /// copy `uris` names goes. The folders a delete leaves empty go with it, up to the copy folder,
    /// which stays.
    ///
    /// One at a time, and a copy that will not delete is passed over: the copies are independent of
    /// each other, and one left behind is exactly what the host's next `sweep` is for. Each is
    /// deleted under `handOut`'s lock, for the folders it may leave empty.
    static func release(_ uris: [String], keep: [String] = []) {
        let kept = Set(keep.flatMap(keptPaths))
        for uri in uris {
            guard let url = JobFolders.fileURL(from: uri), isFile(url),
                  let path = ownPath(url), !kept.contains(path) else { continue }
            handedOut.locked { _ in
                try? FileManager.default.removeItem(at: url)
                removeEmptyFolders(from: url.deletingLastPathComponent())
            }
        }
    }

    /// Deletes every copy in `copyFolders` that nothing still uses and that is dated before `before`,
    /// then every folder there that is left empty, and answers how many copies went.
    ///
    /// WHY THERE HAS TO BE A SWEEP. A copy is a whole video, iOS never empties Application Support by
    /// itself, and most copies stop mattering without anyone saying so: the video a sound was only
    /// extracted from, a clip deleted from the edit, a clip replaced, an edit left without a draft, a
    /// draft whose app was killed before it saved. `release` sees only what a host knows it has just
    /// stopped using. What a host's saved state holds is the whole of what a copy can still be for,
    /// so a host that keeps drafts runs this as it starts, with every name they use, and whatever
    /// else is in the folders is a copy nothing will ask for again.
    ///
    /// Three things keep a copy, whatever its date:
    ///  - A name in `keep`, read by `keptPaths`: as `release` reads its `uris`, so a name stored
    ///    before an update still keeps its copy, and in every other way a copy's name is written, the
    ///    URL a web view plays it by among them, because a name misread here loses the clip for good.
    ///  - An input of a render still running, or of one whose outcome JS has not collected
    ///    (`JobRegistry.liveInputURIs`). A host's launch sweep runs again when the web view reloads,
    ///    which can happen mid render, and the edit being rendered may be in no draft. AVFoundation
    ///    reads on through a file it already has open, but the fallback engine and a retry open it
    ///    again.
    ///  - A copy this process has given a host (`handOut`): a clip picked while this runs, or earlier
    ///    in this launch and not saved yet.
    ///
    /// `before` is the host's own bound on the rest: a copy dated after it stays too. A copy whose
    /// date cannot be read stays as well, and one that will not delete now is found again by the
    /// next sweep, so neither is a failure.
    ///
    /// Each copy is checked against what this process handed out, and deleted, under `handOut`'s
    /// lock, and each empty folder is removed under it. The copy folders themselves stay, even
    /// empty, because `retain` and `resolve` make them once and then write into them. A folder below
    /// them is only ever one `resolve` item's, and `resolve` makes it in the same `handOut` that puts
    /// its copy in.
    static func sweep(keep: [String], before: Date) -> Int {
        let fm = FileManager.default
        let kept = Set((keep + JobRegistry.shared.liveInputURIs()).flatMap(keptPaths))
        var removed = 0
        for root in copyFolders {
            let keys: [URLResourceKey] = [.isDirectoryKey, .contentModificationDateKey]
            // A missing folder is the normal state until the first pick, and nothing to sweep.
            guard let walker = fm.enumerator(at: root, includingPropertiesForKeys: keys, options: []) else {
                continue
            }
            var folders: [URL] = []
            for case let url as URL in walker {
                let values = try? url.resourceValues(forKeys: Set(keys))
                if values?.isDirectory == true {
                    folders.append(url)
                    continue
                }
                guard let path = ownPath(url), !kept.contains(path),
                      let modified = values?.contentModificationDate, modified < before else { continue }
                let deleted = handedOut.locked { paths in
                    !paths.contains(path) && (try? fm.removeItem(at: url)) != nil
                }
                if deleted { removed += 1 }
            }
            // Deepest first, so a folder whose only content was an empty folder goes too.
            for folder in folders.sorted(by: { $0.pathComponents.count > $1.pathComponents.count }) {
                handedOut.locked { _ in _ = removeIfEmpty(folder) }
            }
        }
        return removed
    }

    /// Every path below the container that `name` could mean for one of the kit's copies: for the
    /// `keep` of `sweep` and of `release`, where a name read too narrowly deletes a clip a draft
    /// still uses.
    ///
    /// First as `release` reads a name in its `uris`, through `JobFolders.fileURL`, rebase and all.
    /// That reads only a `file://` URI and a bare path, so the name is then looked through for a copy
    /// folder's own path, and whatever follows `Library/Application Support/videokit-picked/` or
    /// `.../videokit-gallery/` in it is taken as the copy it means. A name that starts at one of the
    /// two folders, as a path relative to Application Support does, is read the same way. That
    /// reads the URL a web view plays a copy by (`capacitor://localhost/_capacitor_file_/...`),
    /// `file:` with one slash, and a path from any container, encoded or not and with a query or a
    /// fragment after it or not. A name read more ways than it meant can only keep more.
    private static func keptPaths(_ name: String) -> [String] {
        var paths: [String] = []
        if let url = JobFolders.fileURL(from: name), let own = ownPath(url) { paths.append(own) }
        let folders = copyFolders.compactMap(JobFolders.containerRelativePath)
        let spellings = [name, name.removingPercentEncoding].compactMap { $0 }
            .flatMap { [$0, String($0.prefix { $0 != "?" && $0 != "#" })] }
        for spelling in spellings.map({ "/" + $0 }) {
            for folder in folders {
                if let at = spelling.range(of: "/" + folder + "/") {
                    paths.append(String(spelling[spelling.index(after: at.lowerBound)...]))
                }
                let supportFolder = (folder as NSString).deletingLastPathComponent
                if spelling.hasPrefix("/" + (folder as NSString).lastPathComponent + "/") {
                    paths.append(supportFolder + spelling)
                }
            }
        }
        return paths
    }

    // MARK: - Paths

    /// Where `url` sits below this app's container, when that is inside one of `copyFolders`; nil
    /// for every other file, the copy folders themselves included. The path below the container is
    /// what `release` and `sweep` compare, because it is the same string for `/var/...` and
    /// `/private/var/...` (see `JobFolders.containerRelativePath`).
    private static func ownPath(_ url: URL) -> String? {
        guard let relative = JobFolders.containerRelativePath(url) else { return nil }
        let inside = copyFolders.contains { folder in
            JobFolders.containerRelativePath(folder).map { relative.hasPrefix($0 + "/") } ?? false
        }
        return inside ? relative : nil
    }

    /// `folder`, and each folder above it, while it is empty and below a copy folder. Under
    /// `handOut`'s lock only, as `removeIfEmpty` is.
    private static func removeEmptyFolders(from folder: URL) {
        var current = folder
        while ownPath(current) != nil, removeIfEmpty(current) {
            current = current.deletingLastPathComponent()
        }
    }

    /// Removes `folder` when it holds nothing, and answers whether it did. Under `handOut`'s lock
    /// only: `removeItem` takes a folder with everything in it, so nothing may be put in between the
    /// look and the removal.
    private static func removeIfEmpty(_ folder: URL) -> Bool {
        guard (try? FileManager.default.contentsOfDirectory(atPath: folder.path))?.isEmpty == true else {
            return false
        }
        return (try? FileManager.default.removeItem(at: folder)) != nil
    }

    /// A file that is there and is not a folder: a folder is never media, and a name for one is
    /// never retained, reported as there, or deleted as a copy.
    private static func isFile(_ url: URL) -> Bool {
        var isDirectory: ObjCBool = false
        return FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) && !isDirectory.boolValue
    }
}
