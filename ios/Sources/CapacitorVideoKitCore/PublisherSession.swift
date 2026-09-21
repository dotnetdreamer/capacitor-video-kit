import Capacitor
import Foundation

/// The failures the publisher raises at its own boundary, before any request is on the wire.
enum PublishError: Error {
    case fileMissing(String)
    case notFound(String)
    case noVideo
    case missingId(String)
    case badTemplate
}

/// Why a task could not be created. Separate from `PublishError` because these are recoverable
/// states of one upload rather than answers to a plugin call.
private enum EnqueueFailure: Error {
    case fileMissing(String)
    case badURL(String)
    case sessionInvalid
}

/// Reading the server's answers.
///
/// They are JSON served as `text/plain`, and an error comes back as a bare JSON string rather than
/// an object, so nothing here trusts the content type.
enum PublisherHttp {

    /// Unwraps one level of string encoding before giving up. The body is flat camelCase JSON
    /// today, but a proxy, or anything that ever puts an `Accept` back on the request, wraps it in
    /// a JSON string literal instead, and a silent parse failure there turns a successful upload
    /// into a failed post.
    static func parseObject(_ body: Data) -> [String: Any]? {
        guard !body.isEmpty,
              let any = try? JSONSerialization.jsonObject(with: body, options: [.fragmentsAllowed]) else { return nil }
        if let object = any as? [String: Any] { return object }
        if let text = any as? String, let inner = text.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: inner, options: [.fragmentsAllowed]) as? [String: Any] {
            return object
        }
        return nil
    }

    /// Whatever the server said, as something worth showing a developer. An error body is usually a
    /// quoted JSON string, so the quotes come off. A JSON object body is kept verbatim: it is for a
    /// developer to read, not a customer.
    static func errorMessage(_ body: Data) -> String {
        let raw = String(data: body, encoding: .utf8) ?? ""
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "no response body" }
        if trimmed.count >= 2, trimmed.hasPrefix("\""), trimmed.hasSuffix("\"") {
            return String(trimmed.dropFirst().dropLast())
        }
        return String(trimmed.prefix(500))
    }
}

/// Collects the byName answers, which arrive on the ephemeral session's own queue rather than ours.
private final class LookupResults: @unchecked Sendable {
    private let lock = NSLock()
    private var ids: [String: Int] = [:]

    func put(_ uploadGuid: String, _ downloadId: Int) {
        lock.lock()
        ids[uploadGuid] = downloadId
        lock.unlock()
    }

    func take() -> [String: Int] {
        lock.lock()
        defer { lock.unlock() }
        return ids
    }
}

/// The one background `URLSession` and everything that hangs off it.
///
/// The reason any of this is native: the customer taps Post and goes straight back to scrolling, or
/// locks the phone. A WebView upload dies the moment the page is frozen, so the whole transaction -
/// every file, then the create call - is handed to the platform and outlives the app.
///
/// Ownership is simple on purpose. ONE serial `OperationQueue` is both the session's delegate queue
/// and the owner of every record, buffer and task, so nothing in this file needs a lock. The only
/// lock in the slice lives inside `PublishStore`, and it is there for the composer's folder sweep,
/// which reads a phase from a utility queue.
public final class PublisherSession: NSObject, URLSessionDelegate, URLSessionTaskDelegate,
                                     URLSessionDataDelegate, @unchecked Sendable {

    public static let shared = PublisherSession()

    /// Fixed for the life of the app. Changing it orphans every transfer in flight when the new
    /// build lands: the system keeps delivering them to a session object that no longer exists.
    static let identifier = "net.dotnetdreamer.videokit.postpublisher"

    let queue: OperationQueue = {
        let q = OperationQueue()
        q.maxConcurrentOperationCount = 1
        q.name = "net.dotnetdreamer.videokit.postpublisher"
        return q
    }()

    let store = PublishStore.shared

    private var session: URLSession!
    /// Guards every task creation site. A task created on an invalidated session raises an
    /// Objective C exception, which kills the app rather than failing the chain.
    private var sessionValid = true
    private var buffers: [Int: Data] = [:]
    private var completionHandler: (() -> Void)?
    private var finishedEventsAwaitingHandler = false
    private weak var emitter: PostPublisherPlugin?
    private var lastEmitted: [String: (String, Int)] = [:]
    private var lastEmitAt: [String: TimeInterval] = [:]
    private var lastPersistedPercent: [String: Int] = [:]
    /// Task descriptions that have already reported in this process. The second half of the guard
    /// that stops the launch reconcile inventing orphans out of finished work.
    private var completedSinceLaunch = Set<String>()

    /// A one-shot recovery GET is not worth caching, and 15 s is generous for a row lookup. It is a
    /// separate session because a background session cannot run a data task at all.
    private lazy var lookupSession: URLSession = {
        let cfg = URLSessionConfiguration.ephemeral
        cfg.timeoutIntervalForRequest = 15
        cfg.timeoutIntervalForResource = 30
        return URLSession(configuration: cfg)
    }()

    private override init() {
        super.init()
        session = URLSession(configuration: Self.makeConfiguration(), delegate: self, delegateQueue: queue)
        store.load()
        // Not synchronously: a task that finished while we were gone is still listed by
        // getAllTasks until its callback fires, so an immediate reconcile marks every upload
        // task_missing, emits a spurious publishFailed, and then has the real completions flip the
        // uploads to done while the phase stays failed.
        DispatchQueue.global().asyncAfter(deadline: .now() + 2) { [weak self] in
            guard let self else { return }
            self.queue.addOperation { self.reconcileOrphans(afterLaunch: true) }
        }
    }

    /// Every flag has a reason, and both `init` and the reconstruction after an invalidation come
    /// through here so the two can never drift.
    private static func makeConfiguration() -> URLSessionConfiguration {
        let cfg = URLSessionConfiguration.background(withIdentifier: identifier)
        // The customer just tapped Post. Never hold the transfer back for wifi and a charger.
        cfg.isDiscretionary = false
        // Without this we are not relaunched when the last task finishes, so the create call would
        // wait until the customer happened to reopen the app.
        cfg.sessionSendsLaunchEvents = true
        // The total budget for one transfer including all the waiting. A background session always
        // waits for connectivity, so airplane mode stalls rather than fails.
        cfg.timeoutIntervalForResource = 24 * 60 * 60
        cfg.allowsCellularAccess = true
        return cfg
    }

    /// Called from `didFinishLaunching`. Recreating the session is what makes the system deliver
    /// the delegate messages for tasks that finished while the app was gone.
    public static func warmUp() { _ = shared }

    /// Called from `application(_:handleEventsForBackgroundURLSession:completionHandler:)`.
    public static func handleEvents(identifier: String, completionHandler: @escaping () -> Void) {
        guard identifier == Self.identifier else { completionHandler(); return }
        shared.queue.addOperation {
            if shared.finishedEventsAwaitingHandler {
                // The replay finished before UIKit handed us the handler. warmUp() is what creates
                // that race and it is still right to keep, so the flag is what makes the two
                // orderings commute.
                shared.finishedEventsAwaitingHandler = false
                DispatchQueue.main.async(execute: completionHandler)
            } else {
                shared.completionHandler = completionHandler
            }
        }
    }

    /* ==================================== plugin surface ==================================== */

    func attach(emitter plugin: PostPublisherPlugin) { emitter = plugin }

    func detach(_ plugin: PostPublisherPlugin) {
        if emitter === plugin { emitter = nil }
    }

    /// A post that finished while no WebView was attached has been waiting to say so.
    func replayUnacked() {
        for r in store.all() where !r.acked {
            if r.phase == Phase.done, let postId = r.postId {
                emit(PublishEvent.finished,
                     ["pendingPostId": r.pendingPostId, "postId": postId, "published": r.published ?? false],
                     retain: true)
            } else if r.phase == Phase.failed, let e = r.error {
                emit(PublishEvent.failed, failedPayload(r.pendingPostId, e), retain: true)
            }
        }
    }

    func publish(_ request: PublishRequest) throws {
        // Fail now, loudly, rather than in a worker an hour later with the app closed.
        for u in request.uploads {
            guard let url = PublishModels.fileURL(u.path), Thumbnailer.fileBytes(url) > 0 else {
                throw PublishError.fileMissing(u.uploadGuid)
            }
        }

        let id = request.pendingPostId
        guard let existing = store[id] else {
            let now = Date().timeIntervalSince1970
            let record = PublishRecord(
                pendingPostId: id,
                headers: request.headers,
                uploadUrl: request.uploadUrl,
                lookupUrlTemplate: request.lookupUrlTemplate,
                createUrl: request.createUrl,
                bodyTemplate: request.bodyTemplate,
                uploads: request.uploads.map(Self.uploadRecord),
                phase: Phase.queued,
                attempts: 1,
                createdAt: now,
                updatedAt: now
            )
            store[id] = record
            enqueueMissing(id)
            return
        }

        // Already going. Saying yes again is what keeps a retried call from double-posting.
        if Phase.inFlight.contains(existing.phase) { return }

        if existing.phase == Phase.done {
            // Android restarts here, and because the fresh record has no postId its create worker's
            // idempotence guard cannot fire, so it makes a SECOND post. Re-announce instead, so a
            // caller that missed the first event still hears it.
            if let postId = existing.postId {
                emit(PublishEvent.finished,
                     ["pendingPostId": id, "postId": postId, "published": existing.published ?? false],
                     retain: true)
            }
            return
        }

        var r = existing
        r.headers = request.headers
        r.uploadUrl = request.uploadUrl
        r.lookupUrlTemplate = request.lookupUrlTemplate
        r.createUrl = request.createUrl
        r.bodyTemplate = request.bodyTemplate
        // An id obtained before a previous attempt was abandoned is still good, and carrying it
        // over is the whole safety property here: a file with a downloadId is never sent again.
        r.uploads = request.uploads.map { u in
            guard var kept = existing.uploads.first(where: { $0.uploadGuid == u.uploadGuid }) else {
                return Self.uploadRecord(u)
            }
            kept.role = u.role
            kept.path = u.path
            kept.mimeType = u.mimeType
            if let pictureId = u.pictureId { kept.pictureId = pictureId }
            return kept
        }
        r.attempts += 1
        r.phase = Phase.uploading
        r.error = nil
        r.acked = false
        r.createTaskDescription = nil
        r.createAttempts = 0
        store[id] = r
        restart(id)
    }

    func state(for pendingPostId: String) -> [String: Any]? {
        guard var r = store[pendingPostId] else { return nil }
        let projection = store.state(r)
        // Android's rule exactly: a terminal outcome the caller has now read must not be replayed
        // at it again on the next plugin instance.
        if !r.acked, r.phase == Phase.done || r.phase == Phase.failed || r.phase == Phase.cancelled {
            r.acked = true
            store[pendingPostId] = r
        }
        return projection
    }

    func cancel(pendingPostId: String) {
        guard var r = store[pendingPostId] else { return }
        r.phase = Phase.cancelled
        // No error is recorded: the phase already says what happened, and a code of `cancelled` in
        // the error slot reads as a failure to anything showing state.
        r.error = nil
        r.acked = true
        r.createTaskDescription = nil
        // Persist BEFORE cancelling, so the completions that follow see the cancelled phase and
        // stay quiet. Upload statuses are left alone: one that was mid-flight may well have landed
        // on the server, and that is exactly what the byName lookup needs to know on a later retry.
        store[pendingPostId] = r
        lastEmitted[pendingPostId] = nil
        lastEmitAt[pendingPostId] = nil
        cancelTasks(for: pendingPostId)
        // Deliberately no event: cancel is usually the first half of a discard, and a failure
        // arriving between the two halves reads as something going wrong.
    }

    func retry(pendingPostId: String, headers: [String: String]) throws {
        guard store[pendingPostId] != nil else { throw PublishError.notFound(pendingPostId) }
        hasLiveTasks(pendingPostId) { [weak self] live in
            guard let self, var r = self.store[pendingPostId] else { return }
            // The new values win, but the map is merged rather than replaced: a caller sending only
            // a refreshed token keeps everything else it set at publish time.
            r.headers.merge(headers) { _, new in new }
            if live, r.phase == Phase.uploading || r.phase == Phase.creating {
                // A JS reconcile that fires on resume must not restart a healthy chain.
                self.store[pendingPostId] = r
                return
            }
            r.attempts += 1
            r.error = nil
            r.acked = false
            r.phase = Phase.uploading
            r.createTaskDescription = nil
            r.createAttempts = 0
            self.store[pendingPostId] = r
            self.restart(pendingPostId)
        }
    }

    func clear(pendingPostId: String) {
        lastEmitted[pendingPostId] = nil
        lastEmitAt[pendingPostId] = nil
        lastPersistedPercent[pendingPostId] = nil
        cancelTasks(for: pendingPostId)
        // Only the record and our own envelopes go; the customer's media belongs to whoever put it
        // there.
        store.delete(pendingPostId)
    }

    /* ======================================= enqueue ======================================== */

    /// Lookups FIRST, then the reset to `queued`.
    ///
    /// The byName filter keys off the persisted status of the last attempt, so clearing it first
    /// would throw away the very evidence that says "this one may already be on the server".
    private func restart(_ id: String) {
        recoverIds(for: id) { [weak self] recovered in
            guard let self, var r = self.store[recovered] else { return }
            for i in r.uploads.indices where r.uploads[i].downloadId == nil {
                r.uploads[i].status = UploadStatus.queued
                r.uploads[i].bytesSent = 0
                r.uploads[i].lastError = nil
                r.uploads[i].sendAttempts = 0
            }
            self.store[recovered] = r
            self.enqueueMissing(recovered)
        }
    }

    /// Every upload without an id goes at once, and a failure does NOT cancel its siblings.
    ///
    /// Android is strictly sequential and stops at the first failure. That would discard three good
    /// downloadIds over one bad file, and a 401 fails them all within seconds anyway. The
    /// background session has its own rate limiter, so "all at once" is a request, not a promise.
    private func enqueueMissing(_ id: String) {
        guard var r = store[id] else { return }
        var enqueued = false
        for i in r.uploads.indices where r.uploads[i].downloadId == nil {
            do {
                let task = try makeUploadTask(&r, index: i)
                task.resume()
                enqueued = true
            } catch {
                r.uploads[i].status = UploadStatus.failed
                r.uploads[i].lastError = enqueueFailure(error, guid: r.uploads[i].uploadGuid)
            }
        }
        if enqueued, r.phase != Phase.uploading { r.phase = Phase.uploading }
        settle(&r)
    }

    private func makeUploadTask(_ r: inout PublishRecord, index i: Int) throws -> URLSessionUploadTask {
        guard sessionValid else { throw EnqueueFailure.sessionInvalid }
        guard let url = URL(string: r.uploadUrl) else { throw EnqueueFailure.badURL(r.uploadUrl) }
        let u = r.uploads[i]
        let envelope: WrittenEnvelope
        do {
            envelope = try MultipartEnvelope.write(uploadGuid: u.uploadGuid, path: u.path,
                                                   mimeType: u.mimeType, pictureId: u.pictureId,
                                                   into: PublishStore.bodiesDir(r.pendingPostId))
        } catch {
            throw EnqueueFailure.fileMissing(u.uploadGuid)
        }

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        // The caller's own headers go on first, so the content type we depend on cannot be
        // clobbered by one the caller happened to send.
        for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("multipart/form-data; boundary=\(envelope.boundary)", forHTTPHeaderField: "Content-Type")
        // Nothing sets an Accept. URLSession's own */* is what makes the server's MVC skip content
        // negotiation and answer with StringOutputFormatter, which is how the body arrives as flat
        // JSON; pinning it to application/json serialises that JSON a second time and every 2xx
        // then parses as a failure.

        // uploadTask(with:fromFile:) is the ONLY task factory allowed on a background session. A
        // Data body, a stream body and any data task are unsupported once the app is not running.
        let task = session.uploadTask(with: req, fromFile: envelope.url)
        let desc = "\(r.pendingPostId)|\(r.attempts)|upload|\(u.uploadGuid)"
        task.taskDescription = desc

        r.uploads[i].taskDescription = desc
        r.uploads[i].envelopePath = envelope.url.path
        r.uploads[i].bytesTotal = envelope.length
        r.uploads[i].bytesSent = 0
        r.uploads[i].status = UploadStatus.queued
        r.uploads[i].httpStatus = nil
        r.uploads[i].lastError = nil
        return task
    }

    /// The create call travels as an upload task in the SAME background session, not a foreground
    /// request: it runs at the end of a chain that may well complete while the app is suspended, and
    /// a foreground request would simply never be sent. Starting a task from inside a background
    /// wake is allowed, though the session's rate limiter can hold it for a long time; the chain
    /// still completes, it just sits in `creating` while the app is away.
    private func enqueueCreate(_ r: inout PublishRecord, delay: TimeInterval?) throws {
        guard sessionValid else { throw EnqueueFailure.sessionInvalid }
        let ids = try TemplateFill.ids(r.uploads)
        let filled = TemplateFill.fill(r.bodyTemplate, stitched: ids.stitched, originals: ids.originals)
        // The template is the caller's, so a body that does not parse is a caller bug and no amount
        // of retrying fixes it.
        guard let data = filled.data(using: .utf8),
              (try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed])) != nil else {
            throw PublishError.badTemplate
        }
        guard let url = URL(string: r.createUrl) else { throw EnqueueFailure.badURL(r.createUrl) }

        let dir = PublishStore.bodiesDir(r.pendingPostId)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let file = dir.appendingPathComponent("create-post.json")
        try data.write(to: file, options: [.atomic])

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        for (k, v) in r.headers { req.setValue(v, forHTTPHeaderField: k) }
        req.setValue("application/json; charset=utf-8", forHTTPHeaderField: "Content-Type")

        let task = session.uploadTask(with: req, fromFile: file)
        let desc = "\(r.pendingPostId)|\(r.attempts)|create"
        task.taskDescription = desc
        if let delay { task.earliestBeginDate = Date().addingTimeInterval(delay) }
        r.createTaskDescription = desc
        r.phase = Phase.creating
        r.percent = 97
        task.resume()
    }

    /* ====================================== settlement ====================================== */

    /// Runs after every upload outcome. `publishFailed` fires exactly once, when the last task
    /// settles, which is why the decision lives in one place.
    private func settle(_ r: inout PublishRecord) {
        if r.uploads.contains(where: { $0.status == UploadStatus.queued || $0.status == UploadStatus.uploading }) {
            store[r.pendingPostId] = r
            emitProgress(r)
            return
        }
        guard r.uploads.allSatisfy({ $0.downloadId != nil }) else {
            let first = r.uploads.first(where: { $0.status == UploadStatus.failed })?.lastError
            fail(&r, first ?? ErrorRecord(code: FailureCode.unknown, message: "no error recorded",
                                          httpStatus: nil, phase: Phase.uploading,
                                          uploadGuid: nil, retryable: true))
            return
        }
        // The post exists, or its call is already out. Never create it twice.
        guard r.postId == nil, r.createTaskDescription == nil else {
            store[r.pendingPostId] = r
            return
        }
        do {
            try enqueueCreate(&r, delay: nil)
            store[r.pendingPostId] = r
            emitProgress(r)
        } catch {
            fail(&r, createFailure(error))
        }
    }

    private func fail(_ r: inout PublishRecord, _ e: ErrorRecord) {
        r.phase = Phase.failed
        r.error = e
        r.acked = false
        store[r.pendingPostId] = r
        lastEmitted[r.pendingPostId] = nil
        lastEmitAt[r.pendingPostId] = nil
        emit(PublishEvent.failed, failedPayload(r.pendingPostId, e), retain: true)
    }

    /* ================================== delegate callbacks ================================== */

    public func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                           totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
        guard let parsed = parseUpload(task.taskDescription),
              var r = store[parsed.id], parsed.attempts == r.attempts,
              let i = r.uploads.firstIndex(where: { $0.uploadGuid == parsed.guid }) else { return }
        r.uploads[i].status = UploadStatus.uploading
        r.uploads[i].bytesSent = totalBytesSent
        if totalBytesExpectedToSend > 0 { r.uploads[i].bytesTotal = totalBytesExpectedToSend }
        if r.phase == Phase.queued { r.phase = Phase.uploading }

        // Progress is not worth an fsync. The record on disk only has to be good enough to resume
        // from, so it is written every 5 points and the in-memory copy carries the live number.
        let percent = store.percent(r)
        let persist = abs(percent - (lastPersistedPercent[parsed.id] ?? -100)) >= 5
        if persist { lastPersistedPercent[parsed.id] = percent }
        store.update(r, persist: persist)

        let now = Date().timeIntervalSince1970
        guard now - (lastEmitAt[parsed.id] ?? 0) >= 0.5 else { return }
        lastEmitAt[parsed.id] = now
        emitProgress(r)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        // An upload task is still a data task for delivery, and the body can arrive in pieces.
        buffers[dataTask.taskIdentifier, default: Data()].append(data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        let body = buffers.removeValue(forKey: task.taskIdentifier) ?? Data()
        guard let desc = task.taskDescription else { return }
        completedSinceLaunch.insert(desc)
        let http = task.response as? HTTPURLResponse
        guard let id = desc.split(separator: "|", omittingEmptySubsequences: false).first.map(String.init),
              var r = store[id] else { return }

        if r.phase == Phase.cancelled {
            // We cancelled it. No event, no state change; the phase already says what happened.
            removeEnvelope(matching: desc, in: r)
            return
        }

        if let parsed = parseUpload(desc) {
            // A stale attempt. Without this check a cancel followed by a retry lets the cancelled
            // task's completion mark the LIVE upload failed, which shows the customer a failure
            // while the real upload is still running.
            guard parsed.attempts == r.attempts else {
                removeEnvelope(matching: desc, in: r)
                return
            }
            completeUpload(&r, guid: parsed.guid, http: http, body: body, error: error)
        } else if let parsed = parseCreate(desc) {
            guard parsed.attempts == r.attempts else { return }
            completeCreate(&r, http: http, body: body, error: error)
        }
    }

    public func urlSessionDidFinishEvents(forBackgroundURLSession session: URLSession) {
        reconcileOrphans(afterLaunch: false)
        guard let handler = completionHandler else {
            finishedEventsAwaitingHandler = true
            return
        }
        completionHandler = nil
        // UIKit wants it on main. Calling it lets the system snapshot the app and re-suspend it;
        // calling it early snapshots a half-updated app, and never calling it gets the app killed
        // and lengthens the rate limiter's delay on the next wake.
        DispatchQueue.main.async(execute: handler)
    }

    public func urlSession(_ session: URLSession, didBecomeInvalidWithError error: Error?) {
        sessionValid = false
        let detail = error.map { "\($0)" } ?? "no reason given"
        // Rebuild FIRST, so the settle below can enqueue the create call rather than failing a
        // chain whose files are all on the server already.
        self.session = URLSession(configuration: Self.makeConfiguration(), delegate: self, delegateQueue: queue)
        sessionValid = true

        for snapshot in store.all() where snapshot.phase == Phase.uploading || snapshot.phase == Phase.creating {
            var r = snapshot
            for i in r.uploads.indices
            where r.uploads[i].status == UploadStatus.queued || r.uploads[i].status == UploadStatus.uploading {
                r.uploads[i].status = UploadStatus.failed
                r.uploads[i].lastError = ErrorRecord(code: FailureCode.network,
                                                     message: "session_invalidated \(detail)",
                                                     httpStatus: nil, phase: Phase.uploading,
                                                     uploadGuid: r.uploads[i].uploadGuid, retryable: true)
            }
            // The create task went with the session, so let settle raise a new one.
            r.createTaskDescription = nil
            settle(&r)
        }
    }

    /* ==================================== completions ======================================= */

    private func completeUpload(_ r: inout PublishRecord, guid: String, http: HTTPURLResponse?,
                                body: Data, error: Error?) {
        guard let i = r.uploads.firstIndex(where: { $0.uploadGuid == guid }) else { return }
        r.uploads[i].httpStatus = http?.statusCode

        if let error {
            r.uploads[i].status = UploadStatus.failed
            r.uploads[i].lastError = classify(error, phase: Phase.uploading, guid: guid)
        } else if let code = http?.statusCode, (200..<300).contains(code) {
            if let json = PublisherHttp.parseObject(body),
               let downloadId = (json["downloadId"] as? NSNumber)?.intValue, downloadId > 0 {
                r.uploads[i].status = UploadStatus.done
                r.uploads[i].downloadId = downloadId
                r.uploads[i].bytesSent = r.uploads[i].bytesTotal
                r.uploads[i].lastError = nil
                if let pictureId = (json["pictureId"] as? NSNumber)?.intValue, pictureId > 0 {
                    r.uploads[i].pictureId = pictureId
                }
            } else {
                // The bytes landed but the answer did not survive. Retryable on purpose: the byName
                // lookup can still recover the id without re-sending 100 MB.
                r.uploads[i].status = UploadStatus.failed
                r.uploads[i].lastError = ErrorRecord(
                    code: FailureCode.http,
                    message: "no downloadId in the response: \(PublisherHttp.errorMessage(body))",
                    httpStatus: code, phase: Phase.uploading, uploadGuid: guid, retryable: true)
            }
        } else {
            r.uploads[i].status = UploadStatus.failed
            r.uploads[i].lastError = classifyHTTP(http?.statusCode ?? 0, body: body,
                                                  phase: Phase.uploading, guid: guid, creating: false)
        }

        if resendUpload(&r, index: i) { return }
        removeEnvelope(r.uploads[i])
        settle(&r)
    }

    /// Android's `retryOrFail`: record the error, keep the phase, emit NOTHING, so the caller shows
    /// "waiting" rather than "it failed". A background session already waits for connectivity, so
    /// only a hard error (a reset mid-body, a 5xx) ever reaches this.
    private func resendUpload(_ r: inout PublishRecord, index i: Int) -> Bool {
        guard let e = r.uploads[i].lastError, e.retryable, r.uploads[i].sendAttempts < 3 else { return false }
        let attempt = r.uploads[i].sendAttempts + 1
        guard let task = try? makeUploadTask(&r, index: i) else { return false }
        r.uploads[i].sendAttempts = attempt
        // makeUploadTask clears the error; put it back, because getState should still show why the
        // chain is taking longer than it looks.
        r.uploads[i].lastError = e
        // earliestBeginDate is the only way to delay a task that has to survive suspension.
        task.earliestBeginDate = Date().addingTimeInterval(attempt == 1 ? 30 : 60)
        task.resume()
        store[r.pendingPostId] = r
        return true
    }

    private func completeCreate(_ r: inout PublishRecord, http: HTTPURLResponse?, body: Data, error: Error?) {
        r.createTaskDescription = nil

        if let error {
            finishCreate(&r, failure: classify(error, phase: Phase.creating, guid: nil))
            return
        }
        guard let code = http?.statusCode else {
            finishCreate(&r, failure: ErrorRecord(code: FailureCode.unknown, message: "no response",
                                                  httpStatus: nil, phase: Phase.creating,
                                                  uploadGuid: nil, retryable: true))
            return
        }
        guard (200..<300).contains(code) else {
            finishCreate(&r, failure: classifyHTTP(code, body: body, phase: Phase.creating,
                                                   guid: nil, creating: true))
            return
        }
        // `published` is read from the FLAT body. CamelCaseActionResult serialises only the payload;
        // the `.data` the Angular app reads is a client-side wrapper.
        guard let json = PublisherHttp.parseObject(body),
              let postId = (json["postId"] as? NSNumber)?.intValue, postId > 0 else {
            // Deliberately NOT retryable: the post may well exist, and a retry would make a second.
            removeCreateBody(r)
            fail(&r, ErrorRecord(code: FailureCode.http,
                                 message: "no postId in the response: \(PublisherHttp.errorMessage(body))",
                                 httpStatus: code, phase: Phase.creating, uploadGuid: nil, retryable: false))
            return
        }

        removeCreateBody(r)
        let published = (json["published"] as? NSNumber)?.boolValue ?? false
        r.phase = Phase.done
        r.percent = 100
        r.postId = postId
        r.published = published
        r.error = nil
        r.acked = false
        r.createAttempts = 0
        store[r.pendingPostId] = r
        lastEmitted[r.pendingPostId] = nil
        lastEmitAt[r.pendingPostId] = nil
        lastPersistedPercent[r.pendingPostId] = nil
        // The composer's sweep deletes a job folder carrying this marker once it is a day old. It
        // is the only licence it has to delete a folder whose post is finished.
        try? Data().write(to: JobFolders.doneMarker(r.pendingPostId))
        emit(PublishEvent.finished,
             ["pendingPostId": r.pendingPostId, "postId": postId, "published": published],
             retain: true)
    }

    /// Three attempts on the create call as well, for the same reason Android splits the chain into
    /// two workers: re-sending a hundred megabytes because a create call got a 503 is indefensible.
    private func finishCreate(_ r: inout PublishRecord, failure: ErrorRecord) {
        if failure.retryable, r.createAttempts < 3 {
            let attempt = r.createAttempts + 1
            if (try? enqueueCreate(&r, delay: attempt == 1 ? 30 : 60)) != nil {
                r.createAttempts = attempt
                store[r.pendingPostId] = r
                return
            }
        }
        removeCreateBody(r)
        fail(&r, failure)
    }

    /* ==================================== recovery ========================================== */

    /// A record in `uploading` or `creating` whose tasks are neither live nor freshly completed has
    /// lost them: killed between the record write and `resume()`, or the session was purged.
    private func reconcileOrphans(afterLaunch: Bool) {
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            let live = Set(tasks.compactMap { $0.taskDescription })
            self.queue.addOperation {
                for snapshot in self.store.all()
                where snapshot.phase == Phase.uploading || snapshot.phase == Phase.creating {
                    var r = snapshot
                    var changed = false
                    for i in r.uploads.indices
                    where r.uploads[i].downloadId == nil && r.uploads[i].status != UploadStatus.queued {
                        guard let desc = r.uploads[i].taskDescription,
                              !live.contains(desc), !self.completedSinceLaunch.contains(desc) else { continue }
                        r.uploads[i].status = UploadStatus.failed
                        r.uploads[i].lastError = ErrorRecord(code: FailureCode.network, message: "task_missing",
                                                             httpStatus: nil, phase: Phase.uploading,
                                                             uploadGuid: r.uploads[i].uploadGuid, retryable: true)
                        changed = true
                    }
                    if let desc = r.createTaskDescription,
                       !live.contains(desc), !self.completedSinceLaunch.contains(desc) {
                        r.createTaskDescription = nil
                        changed = true
                    }
                    guard changed else { continue }
                    let id = r.pendingPostId
                    self.store[id] = r
                    // Ask the server what it already has before writing any of this off. A force
                    // quit otherwise re-sends every file the server is already holding.
                    self.recoverIds(for: id) { recovered in
                        guard var settled = self.store[recovered] else { return }
                        self.settle(&settled)
                    }
                }
            }
        }
    }

    /// The byName lookup, for every ATTEMPTED upload with no id.
    ///
    /// Wider than Android, which only looks up an upload whose persisted status is `uploading`, and
    /// the difference is what makes a force quit cheap: `RetryOptions` gives JS no channel for
    /// handing a recovered id back, so without this the next attempt re-sends everything.
    private func recoverIds(for id: String, then: @escaping (String) -> Void) {
        guard let r = store[id] else { then(id); return }
        let template = r.lookupUrlTemplate ?? ""
        let pending = r.uploads.filter {
            $0.downloadId == nil
                && ($0.status == UploadStatus.uploading || $0.status == UploadStatus.failed || $0.bytesSent > 0)
        }
        // An upload that never left the phone cannot be on the server, so asking is a round trip
        // for nothing.
        guard !template.isEmpty, !pending.isEmpty else { then(id); return }

        let results = LookupResults()
        let group = DispatchGroup()
        for u in pending {
            group.enter()
            lookupDownloadId(template: template, headers: r.headers, guid: u.uploadGuid) { downloadId in
                if let downloadId { results.put(u.uploadGuid, downloadId) }
                group.leave()
            }
        }
        // Never resume a task before the lookups answer, or a recovered file is sent twice anyway.
        group.notify(queue: DispatchQueue.global()) { [weak self] in
            guard let self else { return }
            self.queue.addOperation {
                let found = results.take()
                if !found.isEmpty, var r = self.store[id] {
                    for (guid, downloadId) in found {
                        guard let i = r.uploads.firstIndex(where: { $0.uploadGuid == guid }) else { continue }
                        r.uploads[i].downloadId = downloadId
                        r.uploads[i].status = UploadStatus.done
                        r.uploads[i].bytesSent = r.uploads[i].bytesTotal
                        r.uploads[i].lastError = nil
                    }
                    self.store[id] = r
                }
                then(id)
            }
        }
    }

    /// Substitution is a plain replace of the literal `{uploadGuid}`, matching Android. No
    /// percent-encoding and no URLComponents: a guid is already URL safe, and encoding it would
    /// produce a path the controller cannot parse.
    private func lookupDownloadId(template: String, headers: [String: String], guid: String,
                                  completion: @escaping (Int?) -> Void) {
        guard let url = URL(string: template.replacingOccurrences(of: "{uploadGuid}", with: guid)) else {
            completion(nil)
            return
        }
        var req = URLRequest(url: url)
        req.httpMethod = "GET"
        for (k, v) in headers { req.setValue(v, forHTTPHeaderField: k) }
        // A lookup failure is never fatal: 404 means the server does not have it, and anything else
        // falls through to sending the file again.
        lookupSession.dataTask(with: req) { data, response, _ in
            guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode),
                  let data, let json = PublisherHttp.parseObject(data),
                  let downloadId = (json["downloadId"] as? NSNumber)?.intValue, downloadId > 0 else {
                completion(nil)
                return
            }
            completion(downloadId)
        }.resume()
    }

    /* ================================== classification ====================================== */

    private func classify(_ error: Error, phase: String, guid: String?) -> ErrorRecord {
        let ns = error as NSError
        if ns.domain == NSURLErrorDomain {
            switch ns.code {
            case NSURLErrorCancelled:
                // The system sets this key only when IT cancelled. A task.cancel() of ours carries
                // no reason, and the contract defines `cancelled` as "cancel() was called", so a
                // force quit reported as `cancelled` would describe something the customer never
                // did.
                if let reason = (ns.userInfo[NSURLErrorBackgroundTaskCancelledReasonKey] as? NSNumber)?.intValue {
                    let message: String
                    switch reason {
                    case NSURLErrorCancelledReasonUserForceQuitApplication: message = "force_quit"
                    case NSURLErrorCancelledReasonBackgroundUpdatesDisabled: message = "background_updates_disabled"
                    case NSURLErrorCancelledReasonInsufficientSystemResources: message = "insufficient_resources"
                    default: message = "system_cancelled_\(reason)"
                    }
                    return ErrorRecord(code: FailureCode.network, message: message, httpStatus: nil,
                                       phase: phase, uploadGuid: guid, retryable: true)
                }
                return ErrorRecord(code: FailureCode.cancelled, message: "cancelled", httpStatus: nil,
                                   phase: phase, uploadGuid: guid, retryable: true)

            case NSURLErrorNotConnectedToInternet, NSURLErrorNetworkConnectionLost, NSURLErrorTimedOut,
                 NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost, NSURLErrorDNSLookupFailed,
                 NSURLErrorDataNotAllowed, NSURLErrorInternationalRoamingOff,
                 NSURLErrorSecureConnectionFailed, NSURLErrorBackgroundSessionWasDisconnected,
                 NSURLErrorResourceUnavailable:
                return ErrorRecord(code: FailureCode.network, message: "\(ns.code) \(ns.localizedDescription)",
                                   httpStatus: nil, phase: phase, uploadGuid: guid, retryable: true)

            case NSURLErrorFileDoesNotExist, NSURLErrorNoPermissionsToReadFile:
                return ErrorRecord(code: FailureCode.fileMissing, message: ns.localizedDescription,
                                   httpStatus: nil, phase: phase, uploadGuid: guid, retryable: false)

            default:
                break
            }
        }
        if ns.domain == NSCocoaErrorDomain, ns.code == NSFileReadNoSuchFileError || ns.code == NSFileNoSuchFileError {
            return ErrorRecord(code: FailureCode.fileMissing, message: ns.localizedDescription,
                               httpStatus: nil, phase: phase, uploadGuid: guid, retryable: false)
        }
        return ErrorRecord(code: FailureCode.unknown,
                           message: "\(ns.domain) \(ns.code) \(ns.localizedDescription)",
                           httpStatus: nil, phase: phase, uploadGuid: guid, retryable: true)
    }

    /// `retryable` in one sentence: true when handing the same job back to the platform, possibly
    /// with a fresh token, could plausibly work; false when nothing the caller can do without
    /// changing the request would help.
    private func classifyHTTP(_ status: Int, body: Data, phase: String, guid: String?,
                              creating: Bool) -> ErrorRecord {
        let message = PublisherHttp.errorMessage(body)
        switch status {
        case 0:
            return ErrorRecord(code: FailureCode.unknown, message: "no response", httpStatus: nil,
                               phase: phase, uploadGuid: guid, retryable: true)
        case 400:
            // A post the server rejected is the caller's to fix. A 400 on an upload means the
            // envelope was wrong, which sending it again cannot change either.
            return ErrorRecord(code: creating ? FailureCode.serverRejected : FailureCode.http,
                               message: message, httpStatus: status, phase: phase,
                               uploadGuid: guid, retryable: false)
        case 401, 403:
            // The token expired mid-job. Retryable, but only once the caller has a new one, so it
            // stops here rather than burning attempts against a wall.
            return ErrorRecord(code: FailureCode.auth, message: message, httpStatus: status,
                               phase: phase, uploadGuid: guid, retryable: true)
        case 408, 425, 429, 500...599:
            return ErrorRecord(code: FailureCode.http, message: message, httpStatus: status,
                               phase: phase, uploadGuid: guid, retryable: true)
        default:
            return ErrorRecord(code: FailureCode.http, message: message, httpStatus: status,
                               phase: phase, uploadGuid: guid, retryable: false)
        }
    }

    private func createFailure(_ error: Error) -> ErrorRecord {
        let message: String
        switch error {
        case PublishError.noVideo: message = "no uploaded video to post"
        case PublishError.missingId(let guid): message = "upload \(guid) has no id"
        case PublishError.badTemplate: message = "the filled body is not valid JSON"
        case EnqueueFailure.badURL(let url): message = "create url is not usable: \(url)"
        case EnqueueFailure.sessionInvalid: message = "session_invalidated"
        default: message = "\(error)"
        }
        return ErrorRecord(code: FailureCode.unknown, message: message, httpStatus: nil,
                           phase: Phase.creating, uploadGuid: nil, retryable: false)
    }

    private func enqueueFailure(_ error: Error, guid: String) -> ErrorRecord {
        switch error {
        case EnqueueFailure.fileMissing(let missing):
            return ErrorRecord(code: FailureCode.fileMissing, message: "missing \(missing)", httpStatus: nil,
                               phase: Phase.uploading, uploadGuid: missing, retryable: false)
        case EnqueueFailure.badURL(let url):
            return ErrorRecord(code: FailureCode.unknown, message: "upload url is not usable: \(url)",
                               httpStatus: nil, phase: Phase.uploading, uploadGuid: guid, retryable: false)
        default:
            return ErrorRecord(code: FailureCode.network, message: "session_invalidated", httpStatus: nil,
                               phase: Phase.uploading, uploadGuid: guid, retryable: true)
        }
    }

    /* ====================================== events ========================================== */

    /// `phase` is clamped to the event's two-value union. A record can legitimately be `queued`,
    /// and putting that on the wire breaks the pill's switch.
    func emitProgress(_ r: PublishRecord) {
        guard Phase.inFlight.contains(r.phase) else { return }
        let percent = store.percent(r)
        let phase = (r.phase == Phase.creating) ? Phase.creating : Phase.uploading
        if let last = lastEmitted[r.pendingPostId], last.0 == phase, last.1 == percent { return }
        lastEmitted[r.pendingPostId] = (phase, percent)
        emit(PublishEvent.progress,
             ["pendingPostId": r.pendingPostId, "phase": phase, "percent": percent],
             retain: false)
    }

    /// No `retryable` and no `uploadGuid` on the event; both live on `PublishState.error` and are
    /// read through `getState`.
    private func failedPayload(_ pendingPostId: String, _ e: ErrorRecord) -> [String: Any] {
        var payload: [String: Any] = [
            "pendingPostId": pendingPostId,
            "phase": e.phase,
            "code": e.code,
            "message": e.message,
        ]
        if let httpStatus = e.httpStatus { payload["httpStatus"] = httpStatus }
        return payload
    }

    private func emit(_ event: String, _ payload: [String: Any], retain: Bool) {
        // No bridge attached. Drop it: the record on disk is the source of truth and a fresh plugin
        // instance replays whatever has not been acknowledged, so a lost event is never load
        // bearing. A buffer on top of that replay would deliver terminal events twice.
        guard let plugin = emitter else { return }
        plugin.emit(event, payload, retain: retain)
    }

    /* ======================================= helpers ======================================== */

    private static func uploadRecord(_ u: PublishUpload) -> UploadRecord {
        UploadRecord(uploadGuid: u.uploadGuid, role: u.role, path: u.path, mimeType: u.mimeType,
                     pictureId: u.pictureId, status: UploadStatus.queued)
    }

    /// `"<pendingPostId>|<attempts>|upload|<uploadGuid>"`. The id is split off at the FIRST
    /// separator and the guid at the last, because neither is guaranteed to be free of one.
    private func parseUpload(_ desc: String?) -> (id: String, attempts: Int, guid: String)? {
        guard let desc else { return nil }
        let parts = desc.split(separator: "|", maxSplits: 3, omittingEmptySubsequences: false)
        guard parts.count == 4, parts[2] == "upload", let attempts = Int(parts[1]) else { return nil }
        return (String(parts[0]), attempts, String(parts[3]))
    }

    private func parseCreate(_ desc: String?) -> (id: String, attempts: Int)? {
        guard let desc else { return nil }
        let parts = desc.split(separator: "|", omittingEmptySubsequences: false)
        guard parts.count == 3, parts[2] == "create", let attempts = Int(parts[1]) else { return nil }
        return (String(parts[0]), attempts)
    }

    private func hasLiveTasks(_ id: String, completion: @escaping (Bool) -> Void) {
        session.getAllTasks { [weak self] tasks in
            guard let self else { return }
            let live = tasks.contains { ($0.taskDescription ?? "").hasPrefix("\(id)|") }
            self.queue.addOperation { completion(live) }
        }
    }

    private func cancelTasks(for id: String) {
        session.getAllTasks { tasks in
            for task in tasks where (task.taskDescription ?? "").hasPrefix("\(id)|") { task.cancel() }
        }
    }

    private func removeEnvelope(_ u: UploadRecord) {
        guard let path = u.envelopePath else { return }
        try? FileManager.default.removeItem(atPath: path)
    }

    /// Only when the completing task owned the file the record still points at. A stale attempt's
    /// envelope carries the same name as the live one, because the writer names it after the guid
    /// and overwrites in place, so deleting on the strength of the name alone would pull the body
    /// out from under a running task.
    private func removeEnvelope(matching desc: String, in r: PublishRecord) {
        guard let parsed = parseUpload(desc),
              let u = r.uploads.first(where: { $0.uploadGuid == parsed.guid }),
              u.taskDescription == desc else { return }
        removeEnvelope(u)
    }

    private func removeCreateBody(_ r: PublishRecord) {
        let file = PublishStore.bodiesDir(r.pendingPostId).appendingPathComponent("create-post.json")
        try? FileManager.default.removeItem(at: file)
    }
}
