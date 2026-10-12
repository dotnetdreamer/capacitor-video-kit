import CryptoKit
import Foundation

/// What `findSubjects` resolves with: `FindSubjectsResult` in `definitions.ts`.
struct SubjectFinding: Sendable {
    let engine: String
    /// The subject track, `file://` in the app's cache.
    let uri: String
    /// The track was already there, and nothing was looked at.
    let cached: Bool
    let kind: String
    let width: Int
    let height: Int
    let frames: Int
    let durationMs: Double
    let subjects: [SubjectInfo]

    var json: [String: Any] {
        ["engine": engine, "uri": uri, "cached": cached, "kind": kind, "width": width, "height": height,
         "frames": frames, "durationMs": durationMs, "subjects": subjects.map(\.json)]
    }
}

/// Where subject tracks are kept between calls: `Library/Caches/video-composer/subjects/`, beside the
/// filmstrip's tiles, because a track is worth finding again and is exactly what the system should be
/// allowed to reclaim. A host asks again before a render, which answers at once from a track still
/// here and looks again for one the system took. The launch sweep lets go of a track nothing has asked
/// for in a week (`JobFolders.sweep`).
enum SubjectCache {
    /// Changes whenever a track this build writes would differ from the last build's for the same
    /// file: the tracker's rules, the frames looked at, the way a mask is read onto the grid.
    static let version = 1

    static var folder: URL { JobFolders.subjectsDir() }

    /// The key a track is kept under: the file - by its name, length and modification time, as the
    /// filmstrip's tiles are (`Thumbnailer.cacheKey`), so a file written again under the same name is
    /// never answered from the old one's track - and everything else that changes the answer: the kind
    /// it is read as, the rate it is looked at (none for a picture), and the model that looks.
    static func key(for request: SubjectRequest, model: String) -> String {
        let values = try? request.url.resourceValues(forKeys: [.fileSizeKey, .contentModificationDateKey])
        let size = values?.fileSize ?? 0
        let modified = Int64(((values?.contentModificationDate?.timeIntervalSince1970 ?? 0) * 1000).rounded())
        let fps = request.kind == .image ? 0 : request.fps
        let signature = "\(version)|\(request.url.absoluteString)|\(size)|\(modified)|\(request.kind.rawValue)|\(fps)|\(SubjectSegmenters.engine)-\(model)"
        let digest = SHA256.hash(data: Data(signature.utf8))
        return digest.map { String(format: "%02x", $0) }.joined()
    }

    static func file(_ key: String) -> URL { folder.appendingPathComponent("\(key).vkst") }

    /// The track kept under `key`, as the answer it was, or nil when there is none, or none this build
    /// can read: a file that is not a subject track, or one whose JSON is damaged and so cannot list
    /// its subjects, is found again rather than answered half. A hit is touched, so the sweep counts a
    /// week from the last time it was asked for and not from when it was found.
    static func hit(_ key: String) -> SubjectFinding? {
        let url = file(key)
        guard let data = try? Data(contentsOf: url),
              let track = try? SubjectTrack.parse(data),
              let meta = track.meta else { return nil }
        try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: url.path)
        return SubjectFinding(engine: meta.engine, uri: url.absoluteString, cached: true, kind: meta.kind,
                              width: track.width, height: track.height, frames: track.frameCount,
                              durationMs: meta.durationMs, subjects: meta.subjects)
    }

    /// Writes `content` under `key` and answers what was written. Whole or not at all: the bytes go to a
    /// hidden file beside it and are moved into place, so a search stopped, or an app killed, half way
    /// through a write leaves nothing a later call would read as a track.
    static func write(_ content: SubjectTrackContent, key: String) throws -> SubjectFinding {
        let data = try SubjectTrack.encode(content)
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
        return SubjectFinding(engine: content.meta.engine, uri: dest.absoluteString, cached: false,
                              kind: content.meta.kind, width: content.width, height: content.height,
                              frames: content.frames.count, durationMs: content.meta.durationMs,
                              subjects: content.meta.subjects)
    }
}

/// `findSubjects` and `stopFindingSubjects`: the searches, ONE AT A TIME, in the order they were asked.
///
/// A search is seconds of a phone's GPU for every few of footage, and two at once only make both slower
/// while the editor waits for the one on screen. So they queue. A second call for the same file - the
/// same key, which is the file, the kind, the rate and the model - while one is waiting or running JOINS
/// it rather than queueing a second, and every caller is answered by the one search. A call whose track
/// is already kept is answered at once, without queueing at all.
///
/// `stop(keep:)` is for a page that has moved on: every search, running or waiting, none of whose callers
/// asked by a `uri` in `keep` is stopped, and its callers are answered `CancellationError`. A waiting one
/// is answered at once; a running one between two frames, and its half-made track is never written.
final class SubjectSearches: @unchecked Sendable {
    static let shared = SubjectSearches()

    /// The work one search does: `SubjectFinder` and `SubjectCache`, or a test's stand-in.
    typealias Work = @Sendable (_ request: SubjectRequest, _ key: String,
                                _ progress: @escaping SubjectFinder.Progress,
                                _ cancelled: @escaping @Sendable () -> Bool) async throws -> SubjectFinding

    /// How often a search's progress is passed on: about four times a second, and once more at 1.
    static let progressInterval: TimeInterval = 0.25

    private struct Waiter {
        let uri: String
        let progress: SubjectFinder.Progress
        let continuation: CheckedContinuation<SubjectFinding, Error>
    }

    /// Every mutable field behind the searches' `lock`, which is what makes the `@unchecked` honest.
    private final class Search: @unchecked Sendable {
        let key: String
        let request: SubjectRequest
        var waiters: [Waiter]
        var started = false
        var stopped = false
        var lastProgress: TimeInterval = 0

        init(key: String, request: SubjectRequest, waiter: Waiter) {
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
    private let model: @Sendable () -> String

    init(model: @escaping @Sendable () -> String = { SubjectSegmenters.model },
         work: @escaping Work = { try await SubjectSearches.find($0, key: $1, progress: $2, cancelled: $3) }) {
        self.model = model
        self.work = work
    }

    /// How many calls are waiting on a search, running or not. TESTS ONLY: the render never reads it.
    var waiting: Int {
        lock.lock()
        defer { lock.unlock() }
        return searches.reduce(0) { $0 + $1.waiters.count }
    }

    /// The subjects of `url`, read as `kind` (sniffed from the file when nil, as `labelMedia` sniffs) at
    /// `fps`. `uri` is the name it was asked by, which `stop(keep:)` matches and every progress event
    /// carries. Throws what the search threw, `CancellationError` for one that was stopped.
    func find(uri: String, url: URL, kind: MediaLabelsResult.Kind?, fps: Double,
              progress: @escaping SubjectFinder.Progress) async throws -> SubjectFinding {
        let request = SubjectRequest(url: url, kind: kind ?? MediaLabels.kind(of: url), fps: fps)
        let key = SubjectCache.key(for: request, model: model())
        if let hit = SubjectCache.hit(key) {
            progress(1)
            return hit
        }
        return try await withCheckedThrowingContinuation { continuation in
            let waiter = Waiter(uri: uri, progress: progress, continuation: continuation)
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
        return stopping.count
    }

    /// The queue, drained one search at a time; ends when it is empty, and is started again by the next
    /// call that finds it so. Every locked section is a synchronous leaf of its own, for the reason
    /// `JobRegistry` gives: a lock is never held across a suspension point.
    private func runAll() async {
        while let search = nextSearch() {
            let result: Result<SubjectFinding, Error>
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
    private func settle(_ search: Search, with result: Result<SubjectFinding, Error>) {
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
            for waiter in waiters where told.insert(waiter.uri).inserted { waiter.progress(1) }
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
        let listeners = search.waiters.filter { told.insert($0.uri).inserted }.map(\.progress)
        lock.unlock()
        let clamped = min(1, max(0, fraction))
        for listener in listeners { listener(clamped) }
    }

    /// The real work: the kept track if a search that raced this one has written it since the call
    /// looked, otherwise a look at every frame, written whole to the cache.
    static func find(_ request: SubjectRequest, key: String, progress: @escaping SubjectFinder.Progress,
                     cancelled: @escaping @Sendable () -> Bool) async throws -> SubjectFinding {
        if let hit = SubjectCache.hit(key) { return hit }
        let content = try await SubjectFinder.analyse(request, progress: progress, cancelled: cancelled)
        // A search stopped while its last frame was looked at writes nothing.
        if cancelled() { throw CancellationError() }
        return try SubjectCache.write(content, key: key)
    }
}
