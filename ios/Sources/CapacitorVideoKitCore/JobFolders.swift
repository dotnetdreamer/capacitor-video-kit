import Foundation

/// Why `prepareJob` gave up. The plugin hands `message` and `code` straight to `call.reject`, so
/// both strings are Android's verbatim: `io`, `no_space`, `unsupported_uri`, `file_missing`, and
/// `invalid_spec` for an argument the caller got wrong.
struct PrepareFailure: Error {
    let message: String
    let code: String
}

/// One relocated input, echoed back to JS. The `key` is exactly the key that came in, never
/// sanitised, because JS maps its manifest by that key; only the FILE NAME is sanitised.
struct PreparedInput: Sendable {
    let key: String
    let uri: String
}

/// Where a batch's files live, and how they get there.
///
/// The rule the whole feature rests on: once a post is pending, every byte it needs is inside one
/// app-private folder that nothing but `cleanup` deletes. The camera plugin's own housekeeping
/// deletes its captures, the file picker's temporary copy dies with the pick, and the customer can
/// clear their library - so inputs are moved in (when they are ours) or copied in (when they are
/// not) before anything depends on them.
///
/// Android roots this at `filesDir`. iOS roots it at Application Support rather than Caches: the
/// system purges Caches under disk pressure, and a half-purged job folder is a post that can never
/// be retried. Application Support is backed up by default though, so every directory we create is
/// marked excluded, or a 40 MB working file rides into iCloud.
enum JobFolders {

    // MARK: - Constants

    /// Headroom demanded on top of the summed input sizes before `prepareJob` writes anything.
    /// Deliberately NOT the 20 MiB the compose pre-flight uses: two checks, two numbers, and
    /// merging them makes a device that fails on Android pass here.
    static let freeSpaceHeadroomBytes: Int64 = 32 * 1024 * 1024

    /// Cache entries older than this are swept on plugin load.
    static let cacheTTL: TimeInterval = 24 * 60 * 60

    /// Job folders whose post finished this long ago are swept. Only folders carrying the marker
    /// the publisher writes when a post is created are eligible.
    static let doneTTL: TimeInterval = 24 * 60 * 60

    /// A folder with no marker at all goes only after this long, and only when nothing in the
    /// process or on disk still claims it. An unmarked folder is either a post parked behind a
    /// Retry button or the leftovers of a render whose app was killed.
    static let orphanTTL: TimeInterval = 7 * 24 * 60 * 60

    /// The marker the publisher writes on `completeCreate`. `.published` is what an older build
    /// wrote; the sweep accepts it so those folders are not stranded forever.
    private static let doneMarkerName = ".done"
    private static let legacyDoneMarkerName = ".published"

    // MARK: - Paths

    /// Library/Application Support/video-batches/
    ///
    /// This is a pure path getter: Application Support does not exist on a fresh install and
    /// `urls(for:in:)` does not create it, so nothing may write here without `ensure` first.
    static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("video-batches", isDirectory: true)
    }

    static func jobDir(_ batchId: String) -> URL {
        root.appendingPathComponent(sanitize(batchId), isDirectory: true)
    }

    static func inputsDir(_ batchId: String) -> URL {
        jobDir(batchId).appendingPathComponent("in", isDirectory: true)
    }

    static func stitched(_ batchId: String) -> URL {
        jobDir(batchId).appendingPathComponent("stitched.mp4")
    }

    static func poster(_ batchId: String) -> URL {
        jobDir(batchId).appendingPathComponent("poster.jpg")
    }

    /// The export writes here and the finished file is moved to `stitched.mp4`, so a process that
    /// dies mid render never leaves a file that looks finished to the publisher.
    static func part(_ batchId: String, jobId: String) -> URL {
        jobDir(batchId).appendingPathComponent("render-\(sanitize(jobId)).mp4.part")
    }

    /// `AVAssetExportSession.directoryForTemporaryFiles`. It lives inside the job folder so
    /// `cleanup` removes it for free; it has no Android counterpart.
    static func exportTmp(_ batchId: String) -> URL {
        jobDir(batchId).appendingPathComponent("export-tmp", isDirectory: true)
    }

    static func doneMarker(_ batchId: String) -> URL {
        jobDir(batchId).appendingPathComponent(doneMarkerName)
    }

    /// Caches, not Application Support: a thumbnail strip is worth regenerating and is exactly what
    /// the system should be allowed to reclaim.
    static func thumbsDir() -> URL { caches("video-composer/thumbs") }

    static func voiceDir() -> URL { caches("video-composer/voice") }

    private static func caches(_ relative: String) -> URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent(relative, isDirectory: true)
    }

    // MARK: - Names and URIs

    /// Android is `s.replace(Regex("[^A-Za-z0-9._-]"), "_")`, which runs over UTF-16 code units, so
    /// an astral character there becomes TWO underscores. Matching that is why this counts
    /// `UTF16.width` instead of appending one underscore per scalar: the two platforms have to
    /// agree on a file name, not merely produce a safe one.
    ///
    /// This is also what keeps a `vo:<id>` key from becoming a path separator: it lands as `vo_<id>`.
    static func sanitize(_ s: String) -> String {
        var out = ""
        out.reserveCapacity(s.count)
        for scalar in s.unicodeScalars {
            let isSafe = (scalar >= "A" && scalar <= "Z")
                || (scalar >= "a" && scalar <= "z")
                || (scalar >= "0" && scalar <= "9")
                || scalar == "." || scalar == "_" || scalar == "-"
            if isSafe {
                out.unicodeScalars.append(scalar)
            } else {
                out += String(repeating: "_", count: UTF16.width(scalar))
            }
        }
        return out
    }

    /// `file://` goes through `URL(string:)` so its percent-encoding is decoded once and correctly;
    /// a bare `/path` is taken literally. Anything else - notably Android's `content://` - has no
    /// iOS meaning and must be reported rather than guessed at.
    static func fileURL(from uri: String) -> URL? {
        if uri.hasPrefix("file://") { return URL(string: uri) }
        if uri.hasPrefix("/") { return URL(fileURLWithPath: uri) }
        return nil
    }

    // MARK: - Directory creation

    /// Creates the directory when it is missing and keeps it out of iCloud. Call it for `root` and
    /// for the job folder from `prepareJob` AND from the top of `JobRegistry.run`: the app's real
    /// render path never calls `prepareJob`, so compose is usually what creates the folder.
    static func ensure(_ url: URL) throws {
        var isDirectory: ObjCBool = false
        if !FileManager.default.fileExists(atPath: url.path, isDirectory: &isDirectory) {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
        // Best effort on purpose. A backup flag that would not set is not a reason to fail a render
        // that is otherwise ready to go.
        var mutable = url
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? mutable.setResourceValues(values)
    }

    // MARK: - Free space

    /// nil means "could not tell", and every caller treats that as ALLOW, which is what Android's
    /// `Long.MAX_VALUE` fallback does.
    ///
    /// `volumeAvailableCapacityForImportantUsage` rather than `volumeAvailableCapacity`: it counts
    /// the space the system would purge for a write it considers important, and a render the
    /// customer is waiting on is exactly that. The key needs a URL that EXISTS, and on a fresh
    /// install neither the job folder nor Application Support does, so walk up to the first
    /// ancestor that is there.
    static func freeBytes(at url: URL) -> Int64? {
        var probe = url.standardizedFileURL
        while !FileManager.default.fileExists(atPath: probe.path), probe.pathComponents.count > 1 {
            probe = probe.deletingLastPathComponent()
        }
        let values = try? probe.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage
    }

    // MARK: - prepareJob

    /// Relocates every input into the job folder.
    ///
    /// Idempotent by design: an input already at its destination, or whose source is gone but whose
    /// destination is there, is echoed back untouched. That is what makes a second `prepareJob`
    /// after a crash harmless, and JS does retry it.
    static func prepareJob(batchId: String,
                           inputs: [(key: String, uri: String)]) throws -> (jobDir: URL, inputs: [PreparedInput]) {
        let jobDir = self.jobDir(batchId)
        let inDir = inputsDir(batchId)
        do {
            try ensure(root)
            try ensure(jobDir)
            try ensure(inDir)
        } catch {
            throw PrepareFailure(message: "could not create \(inDir.path)", code: Reject.io)
        }

        // Size every input before a single byte moves, so a disk that cannot take the whole set
        // fails cleanly instead of half way through. An input whose size will not read counts 0
        // rather than failing, and a file that is going to be MOVED is counted too - Android
        // over-counts the same way, and the 32 MiB headroom is the real point of the check.
        var neededBytes: Int64 = 0
        for input in inputs {
            if let url = fileURL(from: input.uri) { neededBytes += sizeOf(url) }
        }
        let needed = neededBytes + freeSpaceHeadroomBytes
        if let available = freeBytes(at: root), available < needed {
            throw PrepareFailure(message: "no_space need=\(needed) free=\(available)", code: Reject.noSpace)
        }

        var placed: [PreparedInput] = []
        placed.reserveCapacity(inputs.count)
        for input in inputs {
            placed.append(try place(key: input.key, uri: input.uri, into: inDir))
        }
        return (jobDir, placed)
    }

    private static func place(key: String, uri: String, into inDir: URL) throws -> PreparedInput {
        guard let source = fileURL(from: uri) else {
            throw PrepareFailure(message: "unsupported_uri:\(key)", code: Reject.unsupportedUri)
        }

        let ext = source.pathExtension.isEmpty ? defaultExtension(for: key) : source.pathExtension
        let dest = inDir.appendingPathComponent("\(sanitize(key)).\(ext)")

        // Already where it belongs, including the case where a previous run moved it there.
        if source.standardizedFileURL.path == dest.standardizedFileURL.path {
            return PreparedInput(key: key, uri: dest.absoluteString)
        }

        let fm = FileManager.default
        if !fm.fileExists(atPath: source.path) {
            guard fm.fileExists(atPath: dest.path) else {
                throw PrepareFailure(message: "file_missing:\(key)", code: Reject.fileMissing)
            }
            return PreparedInput(key: key, uri: dest.absoluteString)
        }

        do {
            // copyItem and moveItem both throw when the destination exists, and a destination that
            // exists is the normal case on a retry.
            try? fm.removeItem(at: dest)
            if SoundLibrary.owns(source) {
                // A sound the customer keeps is app-owned and is still COPIED: moving it, or
                // copying and then deleting it below, would take it out of their library the first
                // time a post used it. See `SoundLibrary.owns`.
                try fm.copyItem(at: source, to: dest)
            } else if isAppOwned(source) {
                // The whole container is one volume, so this is a rename and a failure is real.
                try fm.moveItem(at: source, to: dest)
            } else {
                try fm.copyItem(at: source, to: dest)
                removeIfInOurContainer(source)
            }
        } catch {
            throw PrepareFailure(message: "could not place \(key): \(error.localizedDescription)", code: Reject.io)
        }
        return PreparedInput(key: key, uri: dest.absoluteString)
    }

    /// Nothing reads the extension for dispatch, but `AVURLAsset` uses it as a hint, so a
    /// wrong-but-plausible container beats the design doc's `bin`.
    private static func defaultExtension(for key: String) -> String {
        (key.hasPrefix("vo:") || key == "music") ? "m4a" : "mp4"
    }

    private static func sizeOf(_ url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values?.fileSize ?? 0)
    }

    /// True when we may MOVE the file rather than copy it.
    ///
    /// Narrower than Android's "any app-owned directory" on purpose. Exactly three prefixes:
    ///   Documents/                      camera-preview writes cpcp_video_<id>.mp4 here
    ///   Library/Application Support/    our own job folders
    ///   Library/Caches/video-composer/  our own voice takes and thumbs
    /// `tmp/<uuid>/` and `Library/Caches/<uuid>/` are excluded even though they are inside the
    /// container: that is where the file picker copies a pick, and the thumbnailer or a preview
    /// <video> element may still be reading it. Yanking a file mid read is worse than one copy.
    ///
    /// The `.standardizedFileURL` on both sides is load bearing. On device `NSHomeDirectory()`
    /// answers `/private/var/...` while `FileManager.urls(for:in:)` answers `/var/...`; comparing
    /// them raw makes this false for our OWN folders and turns every move into a copy.
    static func isAppOwned(_ url: URL) -> Bool {
        let path = url.standardizedFileURL.path
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.path
        guard path.hasPrefix(home + "/") else { return false }
        let relative = String(path.dropFirst(home.count + 1))
        return relative.hasPrefix("Documents/")
            || relative.hasPrefix("Library/Application Support/")
            || relative.hasPrefix("Library/Caches/video-composer/")
    }

    /// After a copy, the source is deleted only when it is inside our container. Deleting what is
    /// not ours is not our call, and the net effect for a picked file is still a move.
    private static func removeIfInOurContainer(_ url: URL) {
        let path = url.standardizedFileURL.path
        let home = URL(fileURLWithPath: NSHomeDirectory()).standardizedFileURL.path
        guard path.hasPrefix(home + "/") else { return }
        try? FileManager.default.removeItem(at: url)
    }

    // MARK: - cleanup

    /// A missing folder is not an error: the contract calls `cleanup` idempotent and JS calls it on
    /// every discard, whether or not anything was ever written.
    static func cleanup(batchId: String) {
        try? FileManager.default.removeItem(at: jobDir(batchId))
    }

    // MARK: - sweep

    /// Housekeeping on plugin load. Hops to its own queue: `load()` runs on the Capacitor queue,
    /// which is shared by every plugin in the app, and walking a folder tree there stalls them all.
    static func sweepOnLaunch() {
        DispatchQueue.global(qos: .utility).async {
            sweep(now: Date())
        }
    }

    /// Deliberately conservative about job folders, because the alternative is deleting the files
    /// behind a post the customer can still retry. Three rules, in order:
    ///
    /// 1. cache entries older than 24 h
    /// 2. a job folder carrying the done marker, 24 h after the marker was written
    /// 3. an unmarked job folder after 7 days, and only when nothing still claims it
    static func sweep(now: Date) {
        let fm = FileManager.default
        // A missing root is the normal state on a fresh install, and `contentsOfDirectory` throws
        // on one. Nothing to sweep is not a failure.
        let folders = (try? fm.contentsOfDirectory(at: root,
                                                   includingPropertiesForKeys: [.isDirectoryKey],
                                                   options: [.skipsHiddenFiles])) ?? []
        for folder in folders {
            let isDirectory = (try? folder.resourceValues(forKeys: [.isDirectoryKey]))?.isDirectory ?? false
            guard isDirectory else { continue }
            guard isSweepable(folder, now: now) else { continue }
            do {
                try fm.removeItem(at: folder)
            } catch {
                NSLog("[CapacitorVideoKitCore] sweep could not delete %@: %@", folder.path, error.localizedDescription)
            }
        }
        sweepCache(thumbsDir(), now: now)
        sweepCache(voiceDir(), now: now)
    }

    /// The folder name IS the sanitised batchId, which is what both of the guards below are
    /// asked about: `JobRegistry` compares it against its jobs' sanitised ids, and `PublishStore`
    /// names its records by `PublishModels.safe`, whose character class is the same as `sanitize`'s,
    /// so sanitising an already sanitised id is a no-op.
    static func isSweepable(_ folder: URL, now: Date) -> Bool {
        let id = folder.lastPathComponent

        // A render in flight, or a terminal outcome JS has not collected yet, owns this folder.
        // Android never needed this check because its sweep runs once at load() with nothing in
        // flight; on iOS load() also fires on a WebView reload, which CAN happen mid render.
        if JobRegistry.shared.hasLiveJob(batchId: id) { return false }

        // A publish that is queued, uploading, creating, failed or cancelled keeps its files
        // however old they are. A failed publish the customer has not answered yet is not garbage,
        // and deleting it turns their next Retry into `file_missing` for a post they never
        // discarded.
        if let phase = PublishStore.shared.phase(for: id), phase != Phase.done { return false }

        if let marker = markerDate(in: folder) {
            return now.timeIntervalSince(marker) > doneTTL
        }
        return now.timeIntervalSince(newestModified(folder)) > orphanTTL
    }

    private static func markerDate(in folder: URL) -> Date? {
        for name in [doneMarkerName, legacyDoneMarkerName] {
            let marker = folder.appendingPathComponent(name)
            guard FileManager.default.fileExists(atPath: marker.path) else { continue }
            let values = try? marker.resourceValues(forKeys: [.contentModificationDateKey])
            return values?.contentModificationDate ?? Date.distantPast
        }
        return nil
    }

    /// The age of an unmarked folder counts from the NEWEST file anywhere inside it, not from the
    /// folder's own mtime, so a folder something is still writing into is never swept out from
    /// under it. An empty folder falls back to its own date.
    private static func newestModified(_ url: URL) -> Date {
        let fm = FileManager.default
        var newest = modified(url)
        guard let walker = fm.enumerator(at: url,
                                         includingPropertiesForKeys: [.contentModificationDateKey],
                                         options: []) else { return newest }
        for case let child as URL in walker {
            let date = modified(child)
            if date > newest { newest = date }
        }
        return newest
    }

    private static func modified(_ url: URL) -> Date {
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        return values?.contentModificationDate ?? Date.distantPast
    }

    private static func sweepCache(_ dir: URL, now: Date) {
        let fm = FileManager.default
        let entries = (try? fm.contentsOfDirectory(at: dir,
                                                   includingPropertiesForKeys: [.contentModificationDateKey],
                                                   options: [])) ?? []
        for entry in entries where now.timeIntervalSince(modified(entry)) > cacheTTL {
            try? fm.removeItem(at: entry)
        }
    }
}
