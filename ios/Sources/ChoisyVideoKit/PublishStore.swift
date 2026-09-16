import Foundation

/// The two-value union of `PublishError.phase` in `definitions.ts`. Never `queued`, never `done`,
/// never `render`: those belong to the record's own phase or to the composer.
struct ErrorRecord: Codable, Sendable {
    var code: String
    var message: String
    var httpStatus: Int?
    var phase: String
    var uploadGuid: String?
    var retryable: Bool
}

struct UploadRecord: Codable, Sendable {
    var uploadGuid: String
    var role: String
    var path: String
    var mimeType: String
    var pictureId: Int?
    var status: String
    var downloadId: Int?
    var httpStatus: Int?
    var bytesSent: Int64 = 0
    /// The ENVELOPE's length, not the video's. Both counters are in the same unit so the
    /// percentage is unaffected, but anything displaying this as "MB of video" is a few hundred
    /// bytes out.
    var bytesTotal: Int64 = 0
    var envelopePath: String?
    /// `<pendingPostId>|<attempts>|upload|<uploadGuid>`, the durable join across a relaunch:
    /// `taskIdentifier` is only stable inside one session object.
    var taskDescription: String?
    /// Native re-sends of this file after a transient error, capped at 3.
    var sendAttempts: Int = 0
    var lastError: ErrorRecord?
}

struct PublishRecord: Codable, Sendable {
    var version: Int = 1
    var pendingPostId: String
    var headers: [String: String]
    var uploadUrl: String
    var lookupUrlTemplate: String?
    var createUrl: String
    var bodyTemplate: String
    var uploads: [UploadRecord]
    var phase: String
    var percent: Int = 0
    var attempts: Int = 0
    var postId: Int?
    var published: Bool?
    var error: ErrorRecord?
    /// Has JS been told about a terminal phase yet. The only thing that stops the replay on a fresh
    /// plugin instance from repeating forever.
    var acked: Bool = false
    var createTaskDescription: String?
    var createAttempts: Int = 0
    /// Epoch SECONDS. They never cross the bridge; only the 30 day sweep reads them.
    var createdAt: Double
    var updatedAt: Double
}

/// One JSON file per post at `Library/Application Support/post-publisher/<safeId>.json`.
///
/// One file rather than one shared document because a single corrupt write must not lose every
/// in-flight post, and because each atomic write then stays small enough to be cheap on the
/// progress path. It also matches Android's layout, so the two engines' records read the same.
///
/// The lock exists for exactly one caller: `JobFolders.sweepOnLaunch` reads `phase(for:)` from a
/// utility queue while everything else in the publisher runs on `PublisherSession.queue`.
final class PublishStore: @unchecked Sendable {
    static let shared = PublishStore()

    /// 30 days, matching Android's `DONE_RETENTION_MS`. A finished record is what tells a late
    /// `getState` that the post exists, so it outlives the upload by a long way.
    private static let doneRetention: TimeInterval = 30 * 24 * 60 * 60

    private let lock = NSLock()
    private var records: [String: PublishRecord] = [:]
    private var loaded = false

    static var root: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? URL(fileURLWithPath: NSHomeDirectory()).appendingPathComponent("Library/Application Support")
        return base.appendingPathComponent("post-publisher", isDirectory: true)
    }

    /// The multipart envelopes and the create-post body. Deliberately NOT the composer's job
    /// folder: `PublishRequest` carries no jobDir, and `VideoComposer.cleanup` would delete a live
    /// envelope out from under a running upload task.
    static func bodiesDir(_ pendingPostId: String) -> URL {
        root.appendingPathComponent("bodies", isDirectory: true)
            .appendingPathComponent(PublishModels.safe(pendingPostId), isDirectory: true)
    }

    /// Reads every record into memory once, drops the ones that will not decode, and sweeps. Safe
    /// to call twice; the session calls it from `init`.
    func load() {
        lock.lock()
        defer { lock.unlock() }
        guard !loaded else { return }
        loaded = true

        Self.ensureRoot()
        let fm = FileManager.default
        let files = (try? fm.contentsOfDirectory(at: Self.root, includingPropertiesForKeys: nil)) ?? []
        let decoder = JSONDecoder()
        for file in files where file.pathExtension == "json" {
            guard let data = try? Data(contentsOf: file),
                  let record = try? decoder.decode(PublishRecord.self, from: data) else {
                // A record that cannot be read stalls its post forever, so it goes rather than
                // staying as a permanent "something is in flight". Android does the same.
                try? fm.removeItem(at: file)
                continue
            }
            records[record.pendingPostId] = record
        }
        sweepLocked()
    }

    subscript(id: String) -> PublishRecord? {
        get {
            lock.lock()
            defer { lock.unlock() }
            return records[id]
        }
        set {
            guard let newValue else { delete(id); return }
            update(newValue, persist: true)
        }
    }

    func all() -> [PublishRecord] {
        lock.lock()
        defer { lock.unlock() }
        return Array(records.values)
    }

    /// `persist: false` is the progress path: the in-memory record is what `getState` reads, and a
    /// byte counter is not worth an fsync. The record on disk only has to be good enough to resume
    /// from.
    func update(_ r: PublishRecord, persist: Bool) {
        lock.lock()
        defer { lock.unlock() }
        var stamped = r
        stamped.updatedAt = Date().timeIntervalSince1970
        records[stamped.pendingPostId] = stamped
        if persist { writeLocked(stamped) }
    }

    func delete(_ id: String) {
        lock.lock()
        defer { lock.unlock() }
        records.removeValue(forKey: id)
        try? FileManager.default.removeItem(at: Self.file(for: id))
        try? FileManager.default.removeItem(at: Self.bodiesDir(id))
    }

    /// The wire projection, keys exactly as `definitions.ts`. An absent optional is an absent key,
    /// never `NSNull`: a boxed nil fails `JSONSerialization.isValidJSONObject` and kills the whole
    /// call silently.
    func state(_ r: PublishRecord) -> [String: Any] {
        var out: [String: Any] = [
            "pendingPostId": r.pendingPostId,
            "phase": r.phase,
            "percent": percent(r),
            "attempts": r.attempts,
            "uploads": r.uploads.map { u -> [String: Any] in
                var d: [String: Any] = [
                    "uploadGuid": u.uploadGuid,
                    "role": u.role,
                    "status": u.status,
                    "bytesSent": u.bytesSent,
                    "bytesTotal": u.bytesTotal,
                ]
                if let v = u.downloadId { d["downloadId"] = v }
                if let v = u.pictureId { d["pictureId"] = v }
                if let v = u.httpStatus { d["httpStatus"] = v }
                return d
            },
        ]
        if let v = r.postId { out["postId"] = v }
        if let v = r.published { out["published"] = v }
        if let e = r.error {
            var d: [String: Any] = [
                "code": e.code,
                "message": e.message,
                "phase": e.phase,
                "retryable": e.retryable,
            ]
            if let v = e.httpStatus { d["httpStatus"] = v }
            if let v = e.uploadGuid { d["uploadGuid"] = v }
            out["error"] = d
        }
        return out
    }

    /// Bytes-weighted and capped at 95 until the post itself exists. Nothing reaches 100 on the
    /// strength of the files alone, because "uploaded" is not "posted" and showing otherwise is a
    /// lie the customer notices; 97 is the number Android's create worker puts on the wire.
    func percent(_ r: PublishRecord) -> Int {
        if r.phase == Phase.done { return 100 }
        let total = r.uploads.reduce(Int64(0)) { $0 + $1.bytesTotal }
        if total <= 0 { return min(max(r.percent, 0), 95) }
        let sent = r.uploads.reduce(Int64(0)) { acc, u in
            acc + (u.status == UploadStatus.done ? u.bytesTotal : min(max(u.bytesSent, 0), u.bytesTotal))
        }
        // Kotlin's Double.toInt() truncates toward zero and so does Swift's Int(Double). Rounding
        // here would show 10 percent for a job that has sent 9.5, and the four pinned values in the
        // Android tests (9, 47, 95, 100) would all move.
        let base = min(max(Int(Double(sent) / Double(total) * 95.0), 0), 95)
        if r.phase == Phase.creating { return r.createTaskDescription != nil ? 97 : max(base, 95) }
        return base
    }

    /// For `JobFolders.sweep`, which must never delete a folder whose post is still in flight or
    /// has failed and not yet been answered. nil means there is no record for that post at all.
    func phase(for pendingPostId: String) -> String? {
        // Self-initialising, because this is the one entry point that can arrive before the session
        // has been built. Answering nil there would tell the composer's sweep that a post nobody
        // has answered yet is garbage. `load()` takes the lock itself and returns at once when it
        // has already run, so the two acquisitions are sequential and never nested.
        load()
        lock.lock()
        defer { lock.unlock() }
        return records[pendingPostId]?.phase
    }

    /* ---------------------------------------------------------------------------------------- */

    private static func file(for pendingPostId: String) -> URL {
        root.appendingPathComponent(PublishModels.safe(pendingPostId) + ".json")
    }

    private static func ensureRoot() {
        var url = root
        try? FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        // A half-finished upload restored onto a new phone is noise, and the video it points at is
        // not in the backup either. Excluding the directory covers everything inside it.
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }

    /// `.atomic` writes a temp file beside the target and renames it into place, so a process
    /// killed mid-write leaves the previous record intact rather than a truncated one.
    private func writeLocked(_ r: PublishRecord) {
        Self.ensureRoot()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        guard let data = try? encoder.encode(r) else { return }
        try? data.write(to: Self.file(for: r.pendingPostId), options: [.atomic])
    }

    private func sweepLocked() {
        let now = Date().timeIntervalSince1970
        // Snapshot first: this loop removes from the dictionary it is walking.
        for r in Array(records.values) where r.phase == Phase.done && r.updatedAt > 0 {
            guard now - r.updatedAt > Self.doneRetention else { continue }
            records.removeValue(forKey: r.pendingPostId)
            try? FileManager.default.removeItem(at: Self.file(for: r.pendingPostId))
            try? FileManager.default.removeItem(at: Self.bodiesDir(r.pendingPostId))
        }
        // Envelopes whose record is gone. A 100 MB body left behind by a cleared post would
        // otherwise sit in Application Support until the app is deleted.
        let live = Set(records.keys.map { PublishModels.safe($0) })
        let bodies = Self.root.appendingPathComponent("bodies", isDirectory: true)
        let dirs = (try? FileManager.default.contentsOfDirectory(at: bodies, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs where !live.contains(dir.lastPathComponent) {
            try? FileManager.default.removeItem(at: dir)
        }
    }
}
