import Foundation

/// The two-value union of `PublishError.phase` in `definitions.ts`. Never `queued`, never `done`,
/// never `render`: those belong to the record's own phase or to the composer.
struct ErrorRecord: Codable, Sendable {
    var code: String
    var message: String
    var httpStatus: Int?
    var phase: String
    var uploadId: String?
    var retryable: Bool
}

struct UploadRecord: Codable, Sendable {
    var uploadId: String
    var tag: String
    var path: String
    var mimeType: String
    var url: String?
    var fileName: String?
    var fields: [String: String] = [:]
    var status: String
    /// The server's id for the stored file, keeping the JSON type it arrived as.
    var remoteId: RemoteId?
    var httpStatus: Int?
    var bytesSent: Int64 = 0
    /// The BODY's length, not the video's. For a multipart POST that is a few hundred bytes more
    /// than the file. Both counters are in the same unit so the percentage is unaffected, but
    /// anything displaying this as "MB of video" is a little out.
    var bytesTotal: Int64 = 0
    var bodyPath: String?
    /// `<batchId>|<attempts>|upload|<uploadId>`, the durable join across a relaunch:
    /// `taskIdentifier` is only stable inside one session object.
    var taskDescription: String?
    /// Native re-sends of this file after a transient error, capped at 3.
    var sendAttempts: Int = 0
    var lastError: ErrorRecord?
}

struct PublishRecord: Codable, Sendable {
    /// Bumped from 1: the request and state shapes changed when the backend coupling went. A
    /// version 1 record describes a transaction this code can no longer carry out, so it fails to
    /// decode and is dropped, and the batch is re-queued by the caller rather than resumed wrongly.
    var version: Int = 2
    var batchId: String
    var headers: [String: String]

    /// The transport, flattened. Kept flat rather than nested because every one of these is read
    /// on its own in the hot path, and a record is decoded on every progress tick.
    var uploadUrl: String
    var uploadMethod: String = UploadMethod.post.rawValue
    var fileField: String = defaultFileField
    var uploadFields: [String: String] = [:]
    var idPath: String?
    var lookupUrlTemplate: String?

    var finalizeUrl: String
    var finalizeMethod: String = UploadMethod.post.rawValue
    var bodyTemplate: String
    var requirePath: String?

    var uploads: [UploadRecord]
    var phase: String
    var percent: Int = 0
    var attempts: Int = 0
    /// The finalize response, verbatim. Stored as text rather than as a decoded value because
    /// `Any` is not `Codable`, and parsed back only when the state crosses the bridge.
    var resultBody: String?
    var error: ErrorRecord?
    /// Has JS been told about a terminal phase yet. The only thing that stops the replay on a fresh
    /// plugin instance from repeating forever.
    var acked: Bool = false
    var finalizeTaskDescription: String?
    var finalizeAttempts: Int = 0
    /// Epoch SECONDS. They never cross the bridge; only the 30 day sweep reads them.
    var createdAt: Double
    var updatedAt: Double
}

extension PublishRecord {
    /// The record read back as the request it came from, so the URL and field resolvers live in
    /// one place rather than being re-derived on both sides of the process boundary.
    func asRequest() -> PublishRequest {
        PublishRequest(
            batchId: batchId,
            headers: headers,
            upload: PublishTransport(
                url: uploadUrl,
                method: UploadMethod(rawValue: uploadMethod) ?? .post,
                fileField: fileField,
                fields: uploadFields,
                idPath: idPath,
                lookupUrlTemplate: lookupUrlTemplate
            ),
            uploads: uploads.map {
                PublishUpload(uploadId: $0.uploadId, tag: $0.tag, path: $0.path, mimeType: $0.mimeType,
                              url: $0.url, fileName: $0.fileName, fields: $0.fields)
            },
            finalize: PublishFinalize(
                url: finalizeUrl,
                method: UploadMethod(rawValue: finalizeMethod) ?? .post,
                bodyTemplate: bodyTemplate,
                requirePath: requirePath
            )
        )
    }
}

/// One JSON file per batch at `Library/Application Support/background-publisher/<safeId>.json`.
///
/// One file rather than one shared document because a single corrupt write must not lose every
/// in-flight batch, and because each atomic write then stays small enough to be cheap on the
/// progress path. It also matches Android's layout, so the two engines' records read the same.
///
/// The lock exists for exactly one caller: `JobFolders.sweepOnLaunch` reads `holdsUnfinished` from
/// a utility queue while everything else in the publisher runs on `PublisherSession.queue`.
final class PublishStore: @unchecked Sendable {
    static let shared = PublishStore()

    /// 30 days, matching Android's `DONE_RETENTION_MS`. A finished record is what tells a late
    /// `getState` that the batch succeeded, so it outlives the upload by a long way.
    private static let doneRetention: TimeInterval = 30 * 24 * 60 * 60

    private let lock = NSLock()
    private var records: [String: PublishRecord] = [:]
    private var loaded = false

    /// Library/Application Support/background-publisher/, below `JobFolders.applicationSupport`
    /// so that a test that puts a folder of its own there moves this too.
    static var root: URL {
        JobFolders.applicationSupport.appendingPathComponent("background-publisher", isDirectory: true)
    }

    /// The request bodies: the multipart envelopes, or the copies a raw PUT sends. Deliberately NOT
    /// the composer's job folder: `PublishRequest` carries no jobDir, and `VideoComposer.cleanup`
    /// would delete a live body out from under a running upload task.
    static func bodiesDir(_ batchId: String) -> URL {
        root.appendingPathComponent("bodies", isDirectory: true)
            .appendingPathComponent(bodiesName(batchId), isDirectory: true)
    }

    /// `PublishModels.safe` keeps `.`, so on its own it would make the bodies of a batch called `..`
    /// the store's own root, and `delete` - which `clear` makes for any id at all - would take every
    /// record and every body with it. `JobFolders.childName` makes that `__`, and `.` `_`, and leaves
    /// every other name as it has always been.
    private static func bodiesName(_ batchId: String) -> String {
        JobFolders.childName(PublishModels.safe(batchId))
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
                  let record = try? decoder.decode(PublishRecord.self, from: data),
                  // An older record names fields this build no longer sends. Dropping it is the
                  // right outcome: the caller re-queues rather than resuming a request that can no
                  // longer be built. A version 1 record fails to decode anyway; this is explicit.
                  record.version == 2 else {
                // A record that cannot be read stalls its batch forever, so it goes rather than
                // staying as a permanent "something is in flight". Android does the same.
                try? fm.removeItem(at: file)
                continue
            }
            records[record.batchId] = record
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
        records[stamped.batchId] = stamped
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
            "batchId": r.batchId,
            "phase": r.phase,
            "percent": percent(r),
            "attempts": r.attempts,
            "uploads": r.uploads.map { u -> [String: Any] in
                var d: [String: Any] = [
                    "uploadId": u.uploadId,
                    "tag": u.tag,
                    "status": u.status,
                    "bytesSent": u.bytesSent,
                    "bytesTotal": u.bytesTotal,
                ]
                if let v = u.remoteId { d["remoteId"] = v.jsonValue }
                if let v = u.httpStatus { d["httpStatus"] = v }
                return d
            },
        ]
        if let v = Self.decodeResult(r.resultBody) { out["result"] = v }
        if let e = r.error {
            var d: [String: Any] = [
                "code": e.code,
                "message": e.message,
                "phase": e.phase,
                "retryable": e.retryable,
            ]
            if let v = e.httpStatus { d["httpStatus"] = v }
            if let v = e.uploadId { d["uploadId"] = v }
            out["error"] = d
        }
        return out
    }

    /// The finalize response as something that can cross the bridge, or nil when there was none and
    /// when it was not JSON. `fragmentsAllowed` because a body of `5` or `"ok"` is a perfectly good
    /// answer from somebody's server, and refusing it would lose the only thing they sent.
    static func decodeResult(_ body: String?) -> Any? {
        guard let body, !body.isEmpty, let data = body.data(using: .utf8) else { return nil }
        guard let parsed = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else { return nil }
        return parsed is NSNull ? nil : parsed
    }

    /// Bytes-weighted and capped at 95 until the finalize call has answered. Nothing reaches 100 on
    /// the strength of the files alone, because "uploaded" is not "done" and showing otherwise is a
    /// lie the customer notices; 97 is the number Android's finalize worker puts on the wire.
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
        if r.phase == Phase.finalizing { return r.finalizeTaskDescription != nil ? 97 : max(base, 95) }
        return base
    }

    /// Whether a publish that is not done - queued, uploading, creating, failed or cancelled - owns
    /// the job folder called `folder`, for `JobFolders.isSweepable`, which must never delete one.
    ///
    /// Asked by the FOLDER's name, because that is all the sweep has, and matched through
    /// `JobFolders.folderName`, the one function that names a batch's folder: the records are keyed
    /// by the raw batch id, and `post:1`'s folder is `post_1`, so a lookup of the folder name among
    /// the keys found only the ids that needed no renaming. Not through `PublishModels.safe`, which
    /// names the record files and keeps a whole `Character` as one underscore where `sanitize`
    /// makes one of every UTF-16 unit, so the two part ways over an emoji or an accent written as a
    /// combining mark. Every record that lands in the folder is asked, since two ids can share one
    /// (`post:1` and `post_1`), and one of them not done is enough to keep it.
    func holdsUnfinished(folder: String) -> Bool {
        // Self-initialising, because this is the one entry point that can arrive before the session
        // has been built. Answering false there would tell the composer's sweep that a batch nobody
        // has answered yet is garbage. `load()` takes the lock itself and returns at once when it
        // has already run, so the two acquisitions are sequential and never nested.
        load()
        lock.lock()
        defer { lock.unlock() }
        return records.values.contains { $0.phase != Phase.done && JobFolders.folderName($0.batchId) == folder }
    }

    /* ---------------------------------------------------------------------------------------- */

    private static func file(for batchId: String) -> URL {
        root.appendingPathComponent(PublishModels.safe(batchId) + ".json")
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
        try? data.write(to: Self.file(for: r.batchId), options: [.atomic])
    }

    private func sweepLocked() {
        let now = Date().timeIntervalSince1970
        // Snapshot first: this loop removes from the dictionary it is walking.
        for r in Array(records.values) where r.phase == Phase.done && r.updatedAt > 0 {
            guard now - r.updatedAt > Self.doneRetention else { continue }
            records.removeValue(forKey: r.batchId)
            try? FileManager.default.removeItem(at: Self.file(for: r.batchId))
            try? FileManager.default.removeItem(at: Self.bodiesDir(r.batchId))
        }
        // Bodies whose record is gone. A 100 MB body left behind by a cleared batch would
        // otherwise sit in Application Support until the app is deleted.
        let live = Set(records.keys.map(Self.bodiesName))
        let bodies = Self.root.appendingPathComponent("bodies", isDirectory: true)
        let dirs = (try? FileManager.default.contentsOfDirectory(at: bodies, includingPropertiesForKeys: nil)) ?? []
        for dir in dirs where !live.contains(dir.lastPathComponent) {
            try? FileManager.default.removeItem(at: dir)
        }
    }
}
