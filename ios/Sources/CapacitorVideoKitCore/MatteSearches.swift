import CryptoKit
import Foundation
import os

/// What `findMatte` resolves with: `FindMatteResult` in `definitions.ts`.
struct MatteFinding: Sendable {
    let engine: String
    /// The matte track, `file://` in the app's cache.
    let uri: String
    /// The track was already there, and nothing was looked at.
    let cached: Bool
    let kind: String
    /// What the track keeps: `people` wherever the engine found only people, whatever was asked.
    let target: String
    let width: Int
    let height: Int
    let frames: Int
    let durationMs: Double
    let coverage: Double
    let box: MatteBox?

    /// The answer a track gives, its description read off its JSON.
    init(track: MatteTrack, meta: MatteTrackMeta, uri: String, cached: Bool) {
        engine = meta.engine
        self.uri = uri
        self.cached = cached
        kind = meta.kind
        target = meta.target
        width = track.width
        height = track.height
        frames = track.frameCount
        durationMs = meta.durationMs
        coverage = meta.coverage
        box = meta.box
    }

    /// The fields of Android's `MatteFinder.Result.toJson`, `box` only where there is one.
    var json: [String: Any] {
        var out: [String: Any] = ["engine": engine, "uri": uri, "cached": cached, "kind": kind, "target": target,
                                  "width": width, "height": height, "frames": frames, "durationMs": durationMs,
                                  "coverage": coverage]
        if let box { out["box"] = ["x": box.x, "y": box.y, "w": box.w, "h": box.h] }
        return out
    }
}

/// Where matte tracks are kept between calls: `Library/Caches/video-composer/mattes/`, beside the subject
/// tracks, for their reasons - a track is worth finding again and is exactly what the system should be
/// allowed to reclaim, and Capacitor's file URL conversion serves a file from there to the WebView,
/// whose preview reads it. A host asks again before a render, which answers at once from a track still
/// here and looks again for one the system took. The launch sweep lets go of a track nothing has asked
/// for in a week (`JobFolders.sweep`), and the folder is held to `maxBytes` as each new track is kept
/// (`trim`), as Android holds its own: a matte's soft edge makes a track ten times a subject track's.
enum MatteCache {
    /// Changes whenever a track this build writes would differ from the last build's for the same file:
    /// the frames looked at, the way a mask is read onto the grid, the smoothing.
    static let version = 1

    /// Android's numbers: the folder's ceiling, how long a track asked for is safe from the trim - a
    /// render may be about to read it - and how long a half-written file is left before it is taken for
    /// one an app killed mid write left behind.
    static let maxBytes: Int64 = 200 * 1024 * 1024
    static let inUse: TimeInterval = 2 * 60 * 60
    static let orphanTmp: TimeInterval = 30 * 60

    static var folder: URL { JobFolders.mattesDir() }

    /// The key a track is kept under: the file - by its name, length and modification time, as a subject
    /// track's is (`SubjectCache.key`) - and everything else that changes the answer: the kind it is read
    /// as, the rate it is looked at (none for a picture), what it keeps and the model that looks. A
    /// `subject` search on iOS 16 is kept as the `people` track it makes, so it is answered from the same
    /// file a `people` search makes, and never from a subject track made on iOS 17.
    static func key(for request: MatteRequest, model: String) -> String {
        let values = try? request.url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = values?.fileSize ?? 0
        let modified = Int64(((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded())
        let fps = request.kind == .image ? 0 : request.fps
        let signature = "\(version)|\(request.url.absoluteString)|\(size)|\(modified)|\(request.kind.rawValue)|\(fps)|" +
            "\(request.target)|\(MatteFinder.engine)-\(model)"
        let digest = SHA256.hash(data: Data(signature.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func file(_ key: String) -> URL { folder.appendingPathComponent("\(key).vkmt") }

    /// The track kept under `key`, as the answer it was, or nil when there is none, or none this build
    /// can read: a file that is not a matte track, or one whose JSON is damaged and so cannot describe
    /// itself, is found again rather than answered half. A hit is touched, so the sweep and the trim
    /// count from the last time it was asked for and not from when it was found.
    static func hit(_ key: String) -> MatteFinding? {
        let url = file(key)
        guard let data = try? Data(contentsOf: url),
              let track = try? MatteTrack.parse(data),
              let meta = track.meta else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return MatteFinding(track: track, meta: meta, uri: url.absoluteString, cached: true)
    }

    /// Writes `content` under `key` and answers what was written. Whole or not at all: the bytes go to a
    /// hidden file beside it and are moved into place, so a search stopped, or an app killed, half way
    /// through a write leaves nothing a later call would read as a track. The folder is then trimmed,
    /// this track kept whatever it weighs.
    static func write(_ content: MatteTrackCoded, key: String) throws -> MatteFinding {
        let data = try MatteTrack.encode(content)
        let track = try MatteTrack.parse(data)
        let dir = folder
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = file(key)
        let tmp = dir.appendingPathComponent(".\(UUID().uuidString).tmp")
        do {
            try data.write(to: tmp)
            // A track already there is the same track, found by a search that raced this one.
            try? FileManager.default.removeItem(at: dest)
            try FileManager.default.moveItem(at: tmp, to: dest)
        } catch {
            try? FileManager.default.removeItem(at: tmp)
            throw error
        }
        trim(keep: dest, now: Date())
        return MatteFinding(track: track, meta: content.meta, uri: dest.absoluteString, cached: false)
    }

    /// Holds `dir` - the cache's folder but in a test - to `limit`, `maxBytes` but in a test: the tracks
    /// nobody has asked for longest go first, never `keep` and never one asked for in the last `inUse`. A
    /// half-written file older than `orphanTmp` goes whatever the total. Android's `MatteFinder.trim`.
    static func trim(keep: URL?, now: Date, limit: Int64 = maxBytes, in dir: URL = MatteCache.folder) {
        let fm = FileManager.default
        let keys: [URLResourceKey] = [.fileSizeKey, .contentModificationDateKey, .isRegularFileKey]
        guard let files = try? fm.contentsOfDirectory(at: dir, includingPropertiesForKeys: keys, options: []) else { return }
        var tracks: [(url: URL, size: Int64, modified: Date)] = []
        for url in files {
            guard let values = try? url.resourceValues(forKeys: Set(keys)), values.isRegularFile == true else { continue }
            let modified = values.contentModificationDate ?? now
            if url.lastPathComponent.hasPrefix("."), url.pathExtension == "tmp" {
                if now.timeIntervalSince(modified) > orphanTmp { try? fm.removeItem(at: url) }
                continue
            }
            guard url.pathExtension == "vkmt" else { continue }
            tracks.append((url, Int64(values.fileSize ?? 0), modified))
        }
        var total = tracks.reduce(Int64(0)) { $0 + $1.size }
        guard total > limit else { return }
        let kept = keep?.standardizedFileURL.path
        for track in tracks.sorted(by: { $0.modified < $1.modified }) {
            if total <= limit { break }
            if track.url.standardizedFileURL.path == kept || now.timeIntervalSince(track.modified) < inUse { continue }
            if (try? fm.removeItem(at: track.url)) != nil { total -= track.size }
        }
    }
}

/// `findMatte` and `stopFindingMattes`: the searches, ONE AT A TIME, in the order they were asked -
/// `SubjectSearches`' arrangement, for its reasons, and looking on the subject searches' own queue, so
/// one search of either kind looks at a time (`MatteFinder`).
///
/// A second call for the same track - the same key, which is the file, the kind, the rate, what it keeps
/// and the model - while one is waiting or running JOINS it, and every caller is answered by the one
/// search; each still hears progress under the `uri` and `target` it asked with, so a `subject` call and
/// a `people` call that iOS 16 answers with one track are both told. A call whose track is already kept
/// is answered at once, without queueing at all.
///
/// `stop(keep:)` is for a page that has moved on: every search, running or waiting, none of whose callers
/// asked by a `uri` in `keep` is stopped, and its callers are answered `CancellationError`. A waiting one
/// is answered at once; a running one between two frames, and its half-made track is never written.
///
/// There is no `preparing` stage here: Vision's models are on the device, with nothing to download, so
/// every progress event is `looking`.
final class MatteSearches: @unchecked Sendable {
    static let shared = MatteSearches()

    /// The work one search does: `MatteFinder` and `MatteCache`, or a test's stand-in.
    typealias Work = @Sendable (_ request: MatteRequest, _ key: String,
                                _ progress: @escaping MatteFinder.Progress,
                                _ cancelled: @escaping @Sendable () -> Bool) async throws -> MatteFinding

    /// How often a search's progress is passed on: about four times a second, and once more at 1.
    static let progressInterval: TimeInterval = SubjectSearches.progressInterval

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Matte")

    private struct Waiter {
        let uri: String
        let target: String
        let progress: MatteFinder.Progress
        let continuation: CheckedContinuation<MatteFinding, Error>

        /// The name an event goes out under: the `uri` and the `target` it was asked by.
        var name: String { "\(target)|\(uri)" }
    }

    /// Every mutable field behind the searches' `lock`, which is what makes the `@unchecked` honest.
    private final class Search: @unchecked Sendable {
        let key: String
        let request: MatteRequest
        var waiters: [Waiter]
        var started = false
        var stopped = false
        var lastProgress: TimeInterval = 0

        init(key: String, request: MatteRequest, waiter: Waiter) {
            self.key = key
            self.request = request
            waiters = [waiter]
        }
    }

    /// Guards every field below and every field of every `Search`. Held for list work only, never
    /// across a search or a resumption.
    private let lock = NSLock()
    private var searches: [Search] = []
    private var running = false
    private let work: Work
    private let target: @Sendable (String) -> String
    private let model: @Sendable (String) -> String

    init(target: @escaping @Sendable (String) -> String = { MatteSegmenters.target(for: $0) },
         model: @escaping @Sendable (String) -> String = { MatteSegmenters.model(for: $0) },
         work: @escaping Work = { try await MatteSearches.find($0, key: $1, progress: $2, cancelled: $3) }) {
        self.target = target
        self.model = model
        self.work = work
    }

    /// How many calls are waiting on a search, running or not. TESTS ONLY: the render never reads it.
    var waiting: Int {
        lock.lock()
        defer { lock.unlock() }
        return searches.reduce(0) { $0 + $1.waiters.count }
    }

    /// The matte of `url`, read as `kind` (sniffed from the file when nil, as `labelMedia` sniffs),
    /// keeping `target` - `subject` or `people`, as asked - at `fps`. `uri` is the name it was asked by,
    /// which `stop(keep:)` matches and every progress event carries, with `target`. Throws what the search
    /// threw, `CancellationError` for one that was stopped.
    func find(uri: String, url: URL, kind: MediaLabelsResult.Kind?, target asked: String, fps: Double,
              progress: @escaping MatteFinder.Progress) async throws -> MatteFinding {
        let keeps = target(asked)
        if keeps != asked {
            // Android says so in the same words when Play services has no subject segmenter.
            Self.log.info("the subject segmenter is not to be had on this iOS; keeping people instead")
        }
        let resolved = kind ?? MediaLabels.kind(of: url)
        let request = MatteRequest(url: url, kind: resolved, target: keeps, fps: resolved == .image ? 0 : fps)
        let key = MatteCache.key(for: request, model: model(keeps))
        if let hit = MatteCache.hit(key) {
            progress(1)
            return hit
        }
        return try await withCheckedThrowingContinuation { continuation in
            let waiter = Waiter(uri: uri, target: asked, progress: progress, continuation: continuation)
            lock.lock()
            if let same = searches.first(where: { $0.key == key && !$0.stopped }) {
                same.waiters.append(waiter)
                lock.unlock()
                return
            }
            searches.append(Search(key: key, request: request, waiter: waiter))
            let start = !running
            running = true
            lock.unlock()
            if start { Task.detached(priority: .userInitiated) { await self.runAll() } }
        }
    }

    /// Stops every search none of whose callers asked by a `uri` in `keep` - all of them when `keep` is
    /// nil - and answers how many searches it stopped. Never fails.
    @discardableResult
    func stop(keep: [String]?) -> Int {
        let kept = Set(keep ?? [])
        lock.lock()
        let stopping = searches.filter { search in
            !search.stopped && !search.waiters.contains { kept.contains($0.uri) }
        }
        for search in stopping { search.stopped = true }
        // A waiting search goes now; a running one is told, and goes between two frames.
        let waiting = stopping.filter { !$0.started }
        searches.removeAll { search in waiting.contains { $0 === search } }
        let answered = waiting.flatMap { $0.waiters }
        for search in waiting { search.waiters = [] }
        lock.unlock()
        for waiter in answered { waiter.continuation.resume(throwing: CancellationError()) }
        if !stopping.isEmpty { Self.log.info("stopped \(stopping.count) matte searches nobody wants any more") }
        return stopping.count
    }

    /// The queue, drained one search at a time; ends when it is empty, and is started again by the next
    /// call that finds it so. Every locked section is a synchronous leaf of its own, for the reason
    /// `JobRegistry` gives: a lock is never held across a suspension point.
    private func runAll() async {
        while let search = nextSearch() {
            let result: Result<MatteFinding, Error>
            do {
                result = .success(try await work(search.request, search.key,
                                                 { [weak self] fraction in self?.report(search, fraction) },
                                                 { [weak self] in self?.isStopped(search) ?? true }))
            } catch {
                result = .failure(error)
            }
            settle(search, with: result)
        }
    }

    /// The search to run next, marked started, or nil - and the queue marked idle - when there is none.
    private func nextSearch() -> Search? {
        lock.lock()
        defer { lock.unlock() }
        guard let search = searches.first else {
            running = false
            return nil
        }
        search.started = true
        return search
    }

    /// Answers every caller of a search that has finished: `CancellationError` if it was stopped in the
    /// meantime, its result otherwise, after a last progress of 1 for one that succeeded.
    private func settle(_ search: Search, with result: Result<MatteFinding, Error>) {
        lock.lock()
        searches.removeAll { $0 === search }
        let waiters = search.waiters
        search.waiters = []
        let stopped = search.stopped
        lock.unlock()

        if stopped {
            for waiter in waiters { waiter.continuation.resume(throwing: CancellationError()) }
            return
        }
        if case .success = result {
            // The last word on progress, once for every name the search was asked by.
            var told = Set<String>()
            for waiter in waiters where told.insert(waiter.name).inserted { waiter.progress(1) }
        }
        for waiter in waiters { waiter.continuation.resume(with: result) }
    }

    private func isStopped(_ search: Search) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return search.stopped
    }

    /// Passes `fraction` on to every name the search was asked by, at most every `progressInterval`.
    private func report(_ search: Search, _ fraction: Double) {
        let now = ProcessInfo.processInfo.systemUptime
        lock.lock()
        guard now - search.lastProgress >= Self.progressInterval, !search.stopped else {
            lock.unlock()
            return
        }
        search.lastProgress = now
        var told = Set<String>()
        let listeners = search.waiters.filter { told.insert($0.name).inserted }.map(\.progress)
        lock.unlock()
        let clamped = min(1, max(0, fraction))
        for listener in listeners { listener(clamped) }
    }

    /// The real work: the kept track if a search that raced this one has written it since the call
    /// looked, otherwise a look at every frame, written whole to the cache.
    static func find(_ request: MatteRequest, key: String, progress: @escaping MatteFinder.Progress,
                     cancelled: @escaping @Sendable () -> Bool) async throws -> MatteFinding {
        if let hit = MatteCache.hit(key) { return hit }
        let content = try await MatteFinder.analyse(request, progress: progress, cancelled: cancelled)
        // A search stopped while its last frame was looked at writes nothing.
        if cancelled() { throw CancellationError() }
        return try MatteCache.write(content, key: key)
    }
}
