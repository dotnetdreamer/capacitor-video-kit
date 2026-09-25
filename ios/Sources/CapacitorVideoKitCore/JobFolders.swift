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
/// clear their library - so inputs are moved in (when they are ours and made for this one post) or
/// copied in (when they are not, or are kept for more than one: see `isAppOwned`) before anything
/// depends on them.
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

    /// This app's container, spelled the way `FileManager.urls(for:in:)` spells every folder in it.
    ///
    /// WHY ONE SPELLING. On a device `/var` is a link to `/private/var`, so every folder in the
    /// container has two names, and the system's APIs do not agree on one: `urls(for:in:)` answers
    /// `/var/mobile/Containers/...`, the URLs a picker hands over and `FileManager.temporaryDirectory`
    /// are seen spelled `/private/var/...`, and `NSHomeDirectory()` is promised to match neither. Both
    /// names open the same files, but a host compares names as strings - a `keep` list, a draft
    /// asking whether a clip is already in it - so a name built on one is a different clip from the
    /// same name built on the other. Every name the kit hands out is built on `urls(for:in:)`
    /// (`pickedFolder`, `copiesFolder`, `root`, the caches), so this is too, and so is everything
    /// built on this: the name `rebased` moves a stored path to, and the `tmp` folders of
    /// `StagedRenderInputs` and `AudioFilePicker`, which is why neither starts from
    /// `temporaryDirectory`. The simulator spells every one of them alike, so there the difference
    /// cannot be seen at all.
    static var home: URL {
        FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0].deletingLastPathComponent()
    }

    /// Library/Application Support, where `root` and the publisher's `PublishStore.root` are made.
    ///
    /// A variable only so that a test can put a temporary folder in its place, and nothing but a
    /// test sets it: `JobFolderNamesTests` does, before it cleans up `..` and the ids like it, so
    /// that a regression that lets one out of `video-batches` deletes a folder of the test's own
    /// rather than the simulator's Application Support, which a deliberately broken build (a
    /// mutation run) once did to the test simulator's. Falls back to the path iOS always answers, rather than trapping, should the lookup ever
    /// come back empty.
    static var applicationSupport: URL = FileManager.default
        .urls(for: .applicationSupportDirectory, in: .userDomainMask).first
        ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support", isDirectory: true)

    /// Library/Application Support/video-batches/
    ///
    /// This is a pure path getter: Application Support does not exist on a fresh install and
    /// `urls(for:in:)` does not create it, so nothing may write here without `ensure` first.
    static var root: URL {
        applicationSupport.appendingPathComponent("video-batches", isDirectory: true)
    }

    /// `root`/`folderName(batchId)`, and never anywhere else.
    ///
    /// Every path the kit builds for a batch - its inputs, its render, its poster, its done marker,
    /// the folder `cleanup` deletes - is built on this one, so this is the one place that has to be
    /// sure a batch id cannot name a folder outside `root`. `folderName` is what makes it so; the
    /// check is what keeps it so whatever `folderName` becomes, because the answer is handed to
    /// `removeItem` and a folder outside `root` is Application Support or more. Standardizing is
    /// what turns a `..` into the folder it names, and it leaves every name `folderName` makes as it
    /// is. Android's `JobFolders.dir` makes the same check.
    static func jobDir(_ batchId: String) -> URL {
        let root = self.root
        let dir = root.appendingPathComponent(folderName(batchId), isDirectory: true)
        precondition(dir.standardizedFileURL.deletingLastPathComponent().path == root.standardizedFileURL.path,
                     "a job folder outside video-batches: \(dir.path)")
        return dir
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

    /// Every character outside `[A-Za-z0-9._-]` becomes `_`, one for each UTF-16 unit it takes, so
    /// an astral character - an emoji - becomes TWO underscores. That was written to match Android's
    /// `JobFolders.safeSegment`, `s.replace(Regex("[^A-Za-z0-9._-]"), "_")`, on the belief that the
    /// JVM's regex runs over UTF-16 units. It does not: `java.util.regex` matches a surrogate pair as
    /// the one code point it is, so Android makes ONE underscore of an astral character, and
    /// `"a😀b"` is `a_b` there and `a__b` here. The two agree for every character in the Basic
    /// Multilingual Plane, one underscore per code point, which covers accents, combining marks and
    /// every script an id is likely to be written in; the web's `safeSegment`, a JavaScript regex
    /// with no `u` flag, does run over UTF-16 units and agrees with this. Left as it is, because a
    /// changed rule moves every folder it has already named, and drafts and hosts hold those names;
    /// a phone's folders never meet the other platform's, so the difference names no wrong folder.
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

    /// The name of `batchId`'s folder below `root`: `sanitize(batchId)`, the name every folder has
    /// had since the first build and drafts and hosts still hold, unless that would be a name a path
    /// reads as somewhere else. `sanitize` keeps `.`, as it must for an id such as `post-1.2`, so it
    /// answers `.` for `.` and `..` for `..`. `root` + `..` is Application Support itself, which
    /// `cleanup` of a batch called `..` would delete whole, and the empty name is `root`, every
    /// post's folder at once. `childName` turns those three into underscores.
    ///
    /// Every way in keeps the three ids from getting here (`batchIdRefusal`): `compose`,
    /// `prepareJob`, `cleanup` and the publisher refuse them, and `startVoiceRecording` files such a
    /// take in the voice cache. This is for a path that forgets to ask, so that no route leads
    /// outside `root` all the same. Android's `JobFolders.folderName` is the same rule.
    static func folderName(_ batchId: String) -> String {
        childName(sanitize(batchId))
    }

    /// `name`, made a name that can only be a child of the folder it is put in: the empty name, `.`
    /// and `..` become one underscore per character of the name, and at least one. Every other name
    /// is left exactly as it is. For the two folder names built from an id with `.` kept in it: a
    /// batch's (`folderName`) and the publisher's bodies folder (`PublishStore.bodiesDir`).
    static func childName(_ name: String) -> String {
        name.isEmpty || name == "." || name == ".."
            ? String(repeating: "_", count: max(1, name.count))
            : name
    }

    /// Why `compose`, `prepareJob` and `cleanup` refuse `batchId` as `invalid_spec`, or nil when it
    /// names a folder of its own below `root`. Only an id `folderName` has to rename is refused:
    /// `""`, `.` and `..`, the only ids `sanitize` makes one of those three names of, since it keeps
    /// every `.` and turns every character outside its set into at least one underscore. Refused
    /// rather than renamed, because the renamed folder is some other batch's - `..` would be filed
    /// under, and cleaned up with, the batch called `__`. Every other id is accepted and keeps the
    /// folder it has always had, `../x` included: that is `.._x`, a folder inside `root` like any
    /// other. Android's `JobFolders.batchIdRefusal` and the web's (`video-composer/batch-id.ts`)
    /// answer the same strings. The publisher refuses the same ids as `invalid_request`
    /// (`PublishModels.parse`), and `startVoiceRecording` reads one as no batch
    /// (`VoiceRecorder.folder(for:)`).
    static func batchIdRefusal(_ batchId: String) -> String? {
        if batchId.isEmpty { return "batchId is required" }
        let name = sanitize(batchId)
        return childName(name) == name ? nil : "batchId cannot be '.' or '..'"
    }

    /// The file a URI names: `file://` or a bare `/path`. Anything else - notably Android's
    /// `content://` - has no iOS meaning and must be reported rather than guessed at.
    ///
    /// `file://` is read by hand rather than through `URL(string:)`, which gets two kinds of URI a
    /// host builds by hand wrong. On iOS 16 it answers nil for a raw space, where iOS 17 encodes the
    /// space for the caller; and on every version it takes a raw `#` as the start of a fragment and
    /// a raw `?` as the start of a query, so `clip#2.mp4` quietly opens `clip`. So a URI with a `%`
    /// in it is decoded once, which is what every URI this kit hands out needs (`absoluteString`
    /// encodes), and one without is taken literally, which is what a hand-built one needs. One whose
    /// `%` signs do not all start valid escapes is taken literally too: it was never encoded.
    ///
    /// Then `rebased`, for a path that names a container this app no longer has.
    static func fileURL(from uri: String) -> URL? {
        read(uri).map { rebased(URL(fileURLWithPath: $0.path)) }
    }

    /// `uri` naming the file `fileURL(from:)` opens for it, written the way `uri` was written.
    ///
    /// `uri` itself unless `rebased` moved it: a stored name whose container this install no longer
    /// has, for a file that is in this one. The moved name is a bare path for a bare path, and for a
    /// `file://` URI it is encoded as the kit encodes one (`absoluteString`) when `uri` was encoded,
    /// and literal when it was not, so the answer reads back through `fileURL(from:)` exactly as `uri`
    /// did. `RetainedMedia.check` answers it, for a host that stored the name before an update.
    static func rebasedURI(_ uri: String) -> String {
        guard let read = read(uri) else { return uri }
        let named = URL(fileURLWithPath: read.path)
        let moved = rebased(named)
        guard moved.path != named.path else { return uri }
        guard uri.hasPrefix("file://") else { return moved.path }
        return read.encoded ? moved.absoluteString : "file://" + moved.path
    }

    /// The path `uri` is read as, by the rule `fileURL(from:)` describes, and whether that took
    /// decoding. Nil for anything that is not a file.
    private static func read(_ uri: String) -> (path: String, encoded: Bool)? {
        if uri.hasPrefix("file://") {
            var rest = Substring(uri.dropFirst("file://".count))
            // `file://localhost/...` is RFC 8089's other spelling of the same file.
            if rest.hasPrefix("localhost/") { rest = rest.dropFirst("localhost".count) }
            guard rest.hasPrefix("/") else { return nil }
            if rest.contains("%"), let decoded = rest.removingPercentEncoding { return (decoded, true) }
            return (String(rest), false)
        }
        return uri.hasPrefix("/") ? (uri, false) : nil
    }

    /// A path into an app container that has since moved, pointed at the same place in this one.
    ///
    /// An iOS app's data container is `.../Containers/Data/Application/<UUID>/`, and the UUID is
    /// not promised to survive an app update or a restore onto a new phone - but a host stores
    /// absolute paths: a draft keeps the gallery copy or the picked file it was made from, a post
    /// keeps its render. So a file that is not where the path says, when the path names a
    /// container, is looked for under `home` with everything after the UUID kept. The path is
    /// answered unchanged when the file is not there either, so what the caller then reports as
    /// missing is the path it was actually given. The same pattern holds on a device
    /// (`/private/var/mobile/Containers/...`) and in the simulator (`.../data/Containers/...`).
    ///
    /// The moved path is spelled as `home` is, whichever way the stored one was, so it is the very
    /// name the kit would hand out for that file today: `RetainedMedia.check` answers it, and a host
    /// that finds it equal to a name it was given since takes the two for the one file they are.
    /// `home` is a parameter only so a test can hand it a container spelled otherwise, as a device
    /// spells one and the simulator never does; every caller takes the default.
    static func rebased(_ url: URL, home: URL = JobFolders.home) -> URL {
        let fm = FileManager.default
        if fm.fileExists(atPath: url.path) { return url }
        let parts = url.pathComponents
        guard let at = (0..<max(0, parts.count - 4)).first(where: { i in
            parts[i] == "Containers" && parts[i + 1] == "Data" && parts[i + 2] == "Application"
                && UUID(uuidString: parts[i + 3]) != nil
        }) else { return url }
        var moved = home
        for part in parts[(at + 4)...] { moved.appendPathComponent(part) }
        return fm.fileExists(atPath: moved.path) ? moved : url
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
            if isAppOwned(source) {
                // The whole container is one volume, so this is a rename and a failure is real.
                try fm.moveItem(at: source, to: dest)
            } else {
                try fm.copyItem(at: source, to: dest)
                removeIfScratch(source)
            }
        } catch {
            throw PrepareFailure(message: "could not place \(key): \(error.localizedDescription)", code: Reject.io)
        }
        return PreparedInput(key: key, uri: dest.absoluteString)
    }

    /// A guess, for an input that arrived without an extension, and a better one than the design
    /// doc's `bin`: `AVURLAsset` picks its reader by the extension and never looks at the bytes, so a
    /// file with none fails every load with -11828, and one whose extension names the wrong container
    /// - a WAV named `.m4a` - fails with -11829. A guess that turns out wrong is put right when the
    /// composition is built: `RenderInputs` reads the file's first bytes and opens it under a name
    /// that says what they are.
    private static func defaultExtension(for key: String) -> String {
        (key.hasPrefix("vo:") || key == "music") ? "m4a" : "mp4"
    }

    private static func sizeOf(_ url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values?.fileSize ?? 0)
    }

    /// True when we may MOVE the file rather than copy it: when it was written for one post and
    /// nothing else will want it at that path afterwards.
    ///
    /// Narrower than Android's "any app-owned directory" on purpose. Exactly three prefixes:
    ///   Documents/                                  camera-preview writes cpcp_video_<id>.mp4 here
    ///   Library/Application Support/video-batches/  our own job folders
    ///   Library/Caches/video-composer/              our own voice takes and thumbs
    /// The rest of Application Support is ours too, and is kept there on purpose: the sound
    /// library (`SoundLibrary.dir`), the photo library copies and the picked files a draft points at
    /// (`GalleryLibrary.copiesFolder`, `RetainedMedia.pickedFolder`), and whatever the host itself
    /// files there. A post takes a COPY of those, because a sound moved into a job folder is a row in
    /// the customer's library that plays nothing from the next post on, and a gallery copy or a
    /// retained pick moved into one is a draft whose clip `cleanup` deletes. That is also Android's
    /// rule: a sound is copied there, and a gallery pick or a retained one is a `content://` row that
    /// is only ever read.
    /// `tmp/<uuid>/` and `Library/Caches/<uuid>/` are excluded even though they are inside the
    /// container: that is where the file picker copies a pick, and the thumbnailer or a preview
    /// <video> element may still be reading it. Yanking a file mid read is worse than one copy.
    static func isAppOwned(_ url: URL) -> Bool {
        guard let relative = containerRelativePath(url) else { return false }
        return relative.hasPrefix("Documents/")
            || relative.hasPrefix("Library/Application Support/video-batches/")
            || relative.hasPrefix("Library/Caches/video-composer/")
    }

    /// After a copy, the source is deleted only when it is a scratch copy in our own container -
    /// under `tmp/` or `Library/Caches/`, where the file picker leaves a pick - so the net effect
    /// for a picked file is still a move. Deleting what is not ours is not our call, and what is
    /// ours anywhere else is being kept on purpose (see `isAppOwned`).
    static func removeIfScratch(_ url: URL) {
        guard let relative = containerRelativePath(url),
              relative.hasPrefix("tmp/") || relative.hasPrefix("Library/Caches/") else { return }
        try? FileManager.default.removeItem(at: url)
    }

    /// The path below `home`, or nil for a file outside this app's container.
    ///
    /// The `.standardizedFileURL` on both sides is load bearing. On device a name the kit built is
    /// spelled `/var/...` (see `home`), while one from anywhere else - a picker, `temporaryDirectory`,
    /// `NSHomeDirectory()` - may be spelled `/private/var/...`; comparing them raw makes every file
    /// look foreign, which turns every move into a copy. Standardizing drops the `/private`.
    /// `RetainedMedia` compares its copies by this path for the same reason.
    static func containerRelativePath(_ url: URL) -> String? {
        let path = url.standardizedFileURL.path
        let home = self.home.standardizedFileURL.path
        guard path.hasPrefix(home + "/") else { return nil }
        return String(path.dropFirst(home.count + 1))
    }

    // MARK: - cleanup

    /// A missing folder is not an error: the contract calls `cleanup` idempotent and JS calls it on
    /// every discard, whether or not anything was ever written. What goes is `jobDir(batchId)` and
    /// nothing else - never `root`, nor anything above it, whatever the id (see `jobDir`).
    static func cleanup(batchId: String) {
        try? FileManager.default.removeItem(at: jobDir(batchId))
    }

    // MARK: - sweep

    /// Housekeeping on plugin load. Hops to its own queue: `load()` runs on main, inside
    /// `CAPBridgeViewController.loadView` (see `VideoComposerPlugin.load`), and walking a folder tree
    /// there would hold up the app's first screen. The picked songs are cleared too, on the queue
    /// their copies are made on, and queued before the walk starts rather than after it ends
    /// (`AudioFilePicker.clearOnLoad` says why).
    ///
    /// The copies kept for a host, in `videokit-picked/` and `videokit-gallery/`, are never looked
    /// at here, however old: whether a draft still uses one is something only the host knows, and it
    /// says so through `sweepMedia` (`RetainedMedia.sweep`).
    ///
    /// `done` is called on the sweep's queue once the walk has ended. It is for the tests, which
    /// wait on it to see what the walk left; the plugin passes none.
    static func sweepOnLaunch(then done: (@Sendable () -> Void)? = nil) {
        AudioFilePicker.clearOnLoad()
        DispatchQueue.global(qos: .utility).async {
            sweep(now: Date())
            done?()
        }
    }

    /// Deliberately conservative about job folders, because the alternative is deleting the files
    /// behind a post the customer can still retry. Three rules, in order:
    ///
    /// 1. cache entries and staged render inputs older than 24 h
    /// 2. a job folder carrying the done marker, 24 h after the marker was written
    /// 3. an unmarked job folder after 7 days, and only when nothing still claims it
    ///
    /// The staged inputs (`StagedRenderInputs`) are in `tmp`, which iOS may purge while the app is
    /// not running and never while it runs. `load()` runs as a bridge registers the plugin and not
    /// when the web view reloads (see `VideoComposerPlugin.load`), so in an app with one bridge this
    /// comes before any render of the launch; a bridge built later in the same process runs it
    /// again while a render of the first one's may still be reading its inputs. A day is long past
    /// any render, so nothing here needs to know who still holds a name. Android's
    /// `JobFolders.sweep` clears its staged inputs by the same rule.
    ///
    /// The picked songs beside them are not this walk's: `sweepOnLaunch` clears them whatever their
    /// age, on the queue their copies are made on (`AudioFilePicker.clearOnLoad`).
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
        sweepCache(StagedRenderInputs.folder, now: now)
    }

    /// The folder name IS `folderName(batchId)`, not the batch id, so both of the guards below
    /// are asked about it by that name and match it through `folderName`: `JobRegistry` against its
    /// jobs' folder names, and `PublishStore` against the folder names of its records, which are
    /// keyed by the RAW id. Asked by the raw id instead, `post:1` - whose folder is `post_1` - would
    /// never match, and a failed publish of it would lose its files to the week-old sweep.
    static func isSweepable(_ folder: URL, now: Date) -> Bool {
        let id = folder.lastPathComponent

        // A render in flight, or a terminal outcome JS has not collected yet, owns this folder.
        // Android never needed this check because its sweep runs once at load() with nothing in
        // flight. On iOS load() runs once per bridge, not on a web view reload (see
        // `VideoComposerPlugin.load`), and a bridge built later in the same process sweeps while
        // the registry, which outlives every plugin, may still hold a render of the first one's.
        if JobRegistry.shared.hasLiveJob(batchId: id) { return false }

        // A publish that is queued, uploading, creating, failed or cancelled keeps its files
        // however old they are. A failed publish the customer has not answered yet is not garbage,
        // and deleting it turns their next Retry into `file_missing` for a post they never
        // discarded.
        if PublishStore.shared.holdsUnfinished(folder: id) { return false }

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
