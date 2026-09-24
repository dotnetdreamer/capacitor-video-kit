import Foundation
import UIKit

/// One background task assertion, endable exactly once.
///
/// It exists as a class rather than a local `var` plus a closure because the expiration handler is
/// `@Sendable`: a closure that captures and mutates a local `var` is four warnings in Swift 5 mode
/// and four errors in Swift 6. `@unchecked` is honest here - the field is only ever touched from
/// the main thread, which is where UIKit calls the expiration handler and where the one other
/// caller hops through `MainActor.run` to get.
private final class BackgroundAssertion: @unchecked Sendable {
    private var token: UIBackgroundTaskIdentifier = .invalid

    func begin(name: String) {
        token = UIApplication.shared.beginBackgroundTask(withName: name) { [weak self] in
            self?.end()
        }
    }

    func end() {
        guard token != .invalid else { return }
        UIApplication.shared.endBackgroundTask(token)
        token = .invalid
    }
}

/// One render, from the moment `compose` accepts it until JS has seen how it ended.
///
/// Every mutable field here is guarded by the single `NSLock` inside `JobRegistry`, which is why
/// this is a class with bare `var`s and no locking of its own: Kotlin marks the same fields
/// `@Volatile` on a `ConcurrentHashMap` entry, and one lock in one place is the Swift equivalent
/// that does not invite a second, re-entrant one.
final class ComposeJob: @unchecked Sendable {
    let id: String
    let batchId: String
    let jobDir: URL
    /// What the export writes. It is moved to `outputURL` only once it is whole, so a process that
    /// dies mid render never leaves a file the publisher would happily upload.
    let partURL: URL
    let outputURL: URL
    let posterURL: URL
    let spec: ComposeSpec
    /// `systemUptime`, not `Date()`: the retention sweep measures an elapsed interval and the wall
    /// clock can move under it.
    let createdAt: TimeInterval

    var state: JobState = .pending
    var progress: Double = 0
    var lastEmittedProgress: Double = 0
    /// What WE decided, recorded before anything AVFoundation threw. The catch path reads this
    /// first, so a cancel, a backgrounding and a stalled render all report themselves rather than
    /// whatever `CancellationError` the export happened to raise.
    var stopReason: StopReason?
    /// When the export last reported any movement. Reset when the job starts rendering.
    var stall = StallWatch(startedAt: 0)
    /// Set by `cleanup` and checked in `emit`. On Android the silence after a cleanup is an
    /// accident of the Media3 API; on iOS the run task's catch block WILL run, so without this we
    /// would emit a `failed` event Android never sends, rejecting a promise nobody holds.
    var suppressEvents = false
    /// Set once JS has seen the terminal outcome by asking for it. It is the only thing that stops
    /// `attach` replaying that outcome forever.
    var acked = false
    var terminalAt: TimeInterval = 0
    /// The SAME dictionary the `completed` event carried, so `getState` and the event can never
    /// disagree.
    var result: [String: Any]?
    /// The SAME dictionary the `failed` event carried.
    var error: [String: Any]?
    var task: Task<Void, Never>?

    var isTerminal: Bool { state == .done || state == .failed || state == .interrupted }
    /// Still rendering, or ended with an outcome JS has not collected yet. See
    /// `JobRegistry.hasLiveJob` and `JobRegistry.liveInputURIs` for what that keeps.
    var isLive: Bool { !isTerminal || !acked }

    init(spec: ComposeSpec) {
        self.id = spec.jobId
        self.batchId = spec.batchId
        self.jobDir = JobFolders.jobDir(spec.batchId)
        self.partURL = JobFolders.part(spec.batchId, jobId: spec.jobId)
        self.outputURL = JobFolders.stitched(spec.batchId)
        self.posterURL = JobFolders.poster(spec.batchId)
        self.spec = spec
        self.createdAt = ProcessInfo.processInfo.systemUptime
    }
}

/// Whether a render is still moving, judged by the one signal every engine gives: the fraction of
/// the timeline it reports.
///
/// ANY change counts as movement, backwards included. The exporter's fallback starts its second
/// engine from zero, and a render that has just begun again is the opposite of a wedged one.
struct StallWatch {
    /// How long a render may report no movement at all before it is called wedged.
    ///
    /// Generous on purpose, because killing a render that would have finished is the worse of the
    /// two mistakes. The longest silence a healthy render has is the writer closing the file: with
    /// the index moved to the front for streaming, that is a second pass over the whole file, which
    /// for ten minutes of 4K60 at the ladder's 41 Mbps is three gigabytes - seconds of flash
    /// storage, not minutes. Every other stretch of a healthy render reports a frame at a time.
    static let limit: TimeInterval = 90

    /// `StallWatch.limit` everywhere but the tests, which cannot wait a minute and a half.
    private let limit: TimeInterval
    private var lastFraction: Double = -1
    private var lastMovedAt: TimeInterval

    /// `startedAt` counts as movement: a render that never reports a single frame has stalled
    /// `limit` after it started.
    init(startedAt: TimeInterval, limit: TimeInterval = StallWatch.limit) {
        self.limit = limit
        lastMovedAt = startedAt
    }

    mutating func heard(_ fraction: Double, at now: TimeInterval) {
        guard fraction != lastFraction else { return }
        lastFraction = fraction
        lastMovedAt = now
    }

    func isStalled(at now: TimeInterval) -> Bool {
        now - lastMovedAt > limit
    }
}

/// The render jobs, held for the whole process rather than for the life of a plugin instance.
///
/// A bridge built later in the same process loads a fresh `CAPPlugin` while an export may still be
/// running, and an outcome stored on the dead instance reaches nobody - retained events are
/// retained on that instance. So the outcome lives here, and the next plugin instance replays
/// whatever JS has not acknowledged. A web view reload keeps the instance it has (see
/// `VideoComposerPlugin.load`), and its retained events with it. Under that sit two more nets:
/// `getState` can always be asked, and if even the process died, `getState` answers
/// `job_not_found` and JS restarts from its own manifest.
///
/// ONE non-recursive `NSLock` guards every field of every job. Keep locked sections leaf level,
/// copy the emitter out before calling into it, and never call a locked method from inside a locked
/// one: `NSLock` is not recursive and the second acquisition deadlocks the render.
final class JobRegistry: @unchecked Sendable {
    static let shared = JobRegistry()

    /// Terminal jobs are forgotten after this long. On iOS the process rarely lives 24 h, so the
    /// count cap below is the bound that actually fires; both are cheap.
    private static let terminalTTL: TimeInterval = 24 * 60 * 60
    private static let terminalCap = 20

    /// The bar only ever moves on a 1 % step, which caps a whole render at 100 events whatever the
    /// export reports.
    private static let progressStep = 0.01

    /// How often the stall watch looks. A stalled render is stopped this much later than
    /// `StallWatch.limit` at the outside, and one whose unwind is stuck as well is ended one look
    /// after that; against that limit, both are nothing.
    private static let stallCheckInterval: TimeInterval = 5

    private let lock = NSLock()
    private var jobs: [String: ComposeJob] = [:]
    /// Weak: the plugin belongs to a bridge that is torn down on every navigation, and holding it
    /// strongly here would keep a dead WebView's plugin alive for the life of the process.
    private weak var emitter: VideoComposerPlugin?
    private var observers: [NSObjectProtocol] = []
    private var idleTimerHeld = false
    /// True between `didEnterBackground` and `willEnterForeground`. Guarded by `lock` like every
    /// other mutable field here. It exists for one narrow race: a job registered after
    /// `interruptAll` took its snapshot would otherwise render on into a background that cannot
    /// give it a GPU, and report AVFoundation's refusal as `encoder`.
    private var backgrounded = false

    private init() {
        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.didEnterBackgroundNotification,
            object: nil,
            // `queue: nil` runs the block SYNCHRONOUSLY on the posting thread, which for this
            // notification is main. Passing `.main` instead only looks equivalent: it enqueues onto
            // the run loop even when we are already on main, and that hop is long enough for
            // AVFoundation to fail the export first, from the other side, as -11820 `exportFailed`
            // rather than -11847 `operationInterrupted`. That maps to `encoder`, and the customer
            // is told their video could not be made when all that happened is they took a call.
            queue: nil
        ) { [weak self] _ in
            // Screen lock and Home both land here. Metal is denied to a backgrounded process and
            // the encoder is handed back, so the export cannot survive: stop it now and report a
            // clean `interrupted` rather than wait for AVFoundation's -11847.
            self?.interruptAll()
        })

        observers.append(NotificationCenter.default.addObserver(
            forName: UIApplication.willEnterForegroundNotification,
            object: nil,
            queue: nil
        ) { [weak self] _ in
            self?.enteredForeground()
        })

        // `willResignActiveNotification` is deliberately NOT a trigger. Control Centre, a call
        // banner and Face ID all leave the process in the foreground with the GPU available, and
        // killing a render for a pulled-down notification shade would be maddening.
    }

    deinit {
        for token in observers { NotificationCenter.default.removeObserver(token) }
    }

    // MARK: - Emitter

    /// Called from `VideoComposerPlugin.load()`, which runs as a bridge registers the plugin: once
    /// a launch in an app with one bridge, with nothing here to replay yet, and again for a bridge
    /// built later in the same process, which is handed what the page of an earlier one never
    /// collected. A web view reload does not load the plugin again (see `VideoComposerPlugin.load`).
    func attach(emitter plugin: VideoComposerPlugin) {
        var replays: [(name: String, data: [String: Any])] = []
        lock.lock()
        emitter = plugin
        sweepLocked()
        // Replay is the ONLY delivery mechanism for a missed terminal event. There is no queue of
        // undelivered events, because every terminal outcome is already stored on its job.
        for job in jobs.values where job.isTerminal && !job.acked && !job.suppressEvents {
            guard let payload = job.result ?? job.error else { continue }
            replays.append((job.state == .done ? ComposeEvent.completed : ComposeEvent.failed, payload))
        }
        lock.unlock()

        for replay in replays {
            plugin.emit(replay.name, replay.data, retain: true)
        }
    }

    /// A bridge built after another loads a plugin of its own, which can attach BEFORE the old one
    /// deallocates, so clearing the emitter unconditionally from `deinit` would unhook the live
    /// bridge.
    func detach(_ plugin: VideoComposerPlugin) {
        lock.lock()
        if emitter === plugin { emitter = nil }
        lock.unlock()
    }

    // MARK: - Reads

    func exists(_ jobId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return jobs[jobId] != nil
    }

    /// For `JobFolders.sweep`, which knows the post only by its folder name (`JobFolders.folderName`).
    ///
    /// "Live" includes a terminal job JS has not collected yet: its `stitched.mp4` and poster are
    /// the whole point of the folder, and deleting them while the outcome is still unacknowledged
    /// hands the customer a `file_missing` for a render that actually succeeded.
    func hasLiveJob(batchId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return jobs.values.contains { job in
            guard job.batchId == batchId
                    || JobFolders.folderName(job.batchId) == batchId else { return false }
            return job.isLive
        }
    }

    /// For `RetainedMedia.sweep`, which keeps the copies a render reads: the name of every file a
    /// live job opens, as its spec gives it.
    ///
    /// Live as `hasLiveJob` counts it, so an outcome JS has not collected keeps its inputs as well as
    /// its folder: JS may answer a `failed` by composing the same clips again.
    func liveInputURIs() -> [String] {
        lock.lock()
        defer { lock.unlock() }
        return jobs.values.filter(\.isLive).flatMap(\.spec.inputURIs)
    }

    /// nil when the registry has no such job, which is what the plugin turns into `job_not_found`.
    func stateJSON(_ jobId: String) -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        guard let job = jobs[jobId] else { return nil }
        // A job the backgrounding handler has condemned but whose export has not finished unwinding
        // yet is reported as `interrupted` NOW, without being taken terminal here.
        //
        // The two halves of that sentence both matter. Reporting early is what stops a suspension
        // that wins the unwind leaving JS looking at `rendering` for an exporter that no longer
        // exists, which is a spinner that never ends. Not taking it terminal is what leaves the
        // unwinding task the sole owner of the terminal write, so `job.task` survives for `cancel`
        // to await, `setState` further down `run` cannot resurrect a finished job, and a render that
        // actually completed while the screen was locked still gets to report `done` - the comment
        // above `ResultBuilder.describe` promises exactly that and it is worth keeping.
        let projected = (!job.isTerminal && job.stopReason == .interrupted) ? JobState.interrupted : job.state
        var out: [String: Any] = [
            "jobId": job.id,
            "state": projected.rawValue,
            "progress": job.progress,
        ]
        if let result = job.result { out["result"] = result }
        if let error = job.error {
            out["error"] = error
        } else if projected == .interrupted {
            // A projected job is by construction not terminal, so `job.error` has not been written
            // yet. Answering `interrupted` with no error object would be a shape no other route
            // produces and one Android never produces at all: its `interruptAll` finishes the job
            // and writes the error in the same breath. A caller reads `code` off this, so it gets
            // the same two values `finishStopped` will persist a moment later.
            out["error"] = ComposeFailure(code: .interrupted, message: "did_enter_background")
                .json(jobId: job.id)
        }
        // Asking is acknowledging. This and `cleanup` are the only two places that ack, and an
        // unacked terminal job is replayed on every `attach` until one of them runs.
        if job.isTerminal { job.acked = true }
        return out
    }

    // MARK: - Lifecycle

    /// Registers the job and starts it. The task is created and stored INSIDE the lock, before
    /// `compose` has resolved, because a `cancel` arriving in the window between registering and
    /// storing the task finds nothing to cancel and the render runs to completion as `done`.
    ///
    /// Assumes a fresh jobId: the plugin has already answered a repeat id from `exists`.
    func start(spec: ComposeSpec) {
        let job = ComposeJob(spec: spec)
        lock.lock()
        jobs[job.id] = job
        job.task = Task.detached(priority: .userInitiated) { [weak self] in
            await self?.run(job)
        }
        lock.unlock()
        refreshIdleTimer()
    }

    /// Awaits the export actually stopping before returning. `discardLastRender` calls `cleanup`
    /// the moment this resolves, and a directory delete racing a writer that is still flushing
    /// leaves a folder that will not go away.
    ///
    /// Safe and silent on an unknown id and on a job that has already finished.
    func cancel(_ jobId: String, reason: StopReason) async {
        guard let task = markStopped(jobId, reason: reason) else { return }
        task.cancel()
        await task.value
    }

    /// Synchronous on purpose. A lock must never be held across a suspension point, so every
    /// locked section in this file is a leaf that hands its caller a value and lets go.
    private func markStopped(_ jobId: String, reason: StopReason) -> Task<Void, Never>? {
        lock.lock()
        defer { lock.unlock() }
        guard let job = jobs[jobId], !job.isTerminal else { return nil }
        if job.stopReason == nil { job.stopReason = reason }
        return job.task
    }

    /// Cancels and forgets every job for that post with its events suppressed, then deletes the
    /// folder. JS is deliberately throwing the work away, so a `failed { cancelled }` arriving
    /// afterwards would reject a promise nobody is holding.
    func cleanup(batchId: String) async {
        let tasks = forget(batchId: batchId)
        for task in tasks { task.cancel() }
        for task in tasks { await task.value }

        JobFolders.cleanup(batchId: batchId)
        refreshIdleTimer()
    }

    private func forget(batchId: String) -> [Task<Void, Never>] {
        lock.lock()
        defer { lock.unlock() }
        let victims = jobs.values.filter { $0.batchId == batchId }
        for job in victims {
            if job.stopReason == nil { job.stopReason = .cancelled }
            job.acked = true
            job.suppressEvents = true
            // Forgotten now, so a later `getState` answers `job_not_found` and JS knows to start
            // over rather than wait on an outcome that is never coming.
            jobs.removeValue(forKey: job.id)
        }
        return victims.compactMap { $0.task }
    }

    // MARK: - The render

    private func run(_ job: ComposeJob) async {
        // A job registered after `interruptAll` took its snapshot has no stop reason of its own, so
        // it is condemned here instead. Starting an export the system will refuse a GPU for buys a
        // confusing `encoder` failure in place of the honest answer.
        condemnIfBackgrounded(job)
        // A cancel can land between `start` storing the task and this body being scheduled.
        if let reason = stopReason(of: job) { finishStopped(job, reason: reason); return }

        do {
            // The app's real caller deliberately never calls `prepareJob` - the originals still
            // belong to the record step at that point - so the job folder normally does not exist
            // yet and compose is what creates it. Never a `job_dir_missing` rejection.
            try JobFolders.ensure(JobFolders.root)
            try JobFolders.ensure(job.jobDir)
        } catch {
            fail(job, ComposeFailure(code: .unknown,
                                     message: "could not create \(job.jobDir.path): \(ErrorMapping.describe(error))"))
            return
        }

        // The stop reason is checked before the disk figure, not after: once `getState` has begun
        // projecting `interrupted` for this job, a terminal event carrying any other code would
        // contradict an answer JS has already been given.
        if let reason = stopReason(of: job) { finishStopped(job, reason: reason); return }
        if let failure = spaceFailure(for: job) { fail(job, failure); return }

        let built: BuiltComposition
        do {
            built = try await CompositionBuilder.build(job.spec)
        } catch {
            // A build can fail after it has written a still or a link for the inputs it got to.
            removeWorkingFiles(of: job)
            let reason = stopReason(of: job)
            if let reason { finishStopped(job, reason: reason); return }
            fail(job, ErrorMapping.failure(for: error, stopReason: nil))
            return
        }

        if let reason = stopReason(of: job) {
            removeWorkingFiles(of: job)
            finishStopped(job, reason: reason)
            return
        }
        setState(job, .rendering)

        // A render is given as long as it keeps moving, and stopped only once it has not moved for
        // `StallWatch.limit`. Something upstream is then wedged, and `unknown` / `timeout` is a far
        // better answer than a spinner the customer stares at until they kill the app.
        //
        // There is no deadline on top of that. A render that keeps reporting frames is by definition
        // not wedged, only slow, and how slow is too slow is the customer's call - they have the
        // cancel button - not a multiple of the timeline this file could pick: 4K60 with fifteen
        // layers on the oldest phone the package supports is slow and correct. Android has no
        // deadline at all.
        let watchdog = watchForStall(job)

        do {
            // The exporter describes the part file it has just written, without a poster; that
            // result is thrown away and the finished file is described again below at its final
            // path, poster and all, because `uri` has to be stitched.mp4 and the poster belongs
            // beside it.
            _ = try await Exporter.export(built,
                                          to: job.partURL,
                                          tmpDir: JobFolders.exportTmp(job.batchId),
                                          spec: job.spec,
                                          shouldStop: { [weak self] in
                                              self?.stopReason(of: job) != nil
                                          }) { [weak self] value in
                self?.report(progress: value, for: job)
            }
            watchdog.cancel()
        } catch {
            watchdog.cancel()
            try? FileManager.default.removeItem(at: job.partURL)
            removeWorkingFiles(of: job)
            if let reason = stopReason(of: job) { finishStopped(job, reason: reason); return }
            // The plan is the one the compositor recorded its frames on, so its cursor says how far
            // THIS job's timeline had got when the encode gave up.
            fail(job, ErrorMapping.exportFailure(for: error, cursor: built.plan.cursor, spec: job.spec))
            return
        }
        removeWorkingFiles(of: job)

        do {
            try? FileManager.default.removeItem(at: job.outputURL)
            try FileManager.default.moveItem(at: job.partURL, to: job.outputURL)
        } catch {
            // Same reasoning as the disk check: a job already condemned reports what it was
            // condemned for, not what the move happened to hit on the way down.
            if let reason = stopReason(of: job) { finishStopped(job, reason: reason); return }
            fail(job, ComposeFailure(code: .unknown, message: "could not move the render into place"))
            return
        }

        // From here the render is finished and on disk. The output is never deleted on this path
        // and the stop reason is never consulted again: locking the screen while the poster frame
        // is being cut must not destroy a render the customer waited two minutes for.
        do {
            let result = try await ResultBuilder.describe(job.outputURL,
                                                          spec: job.spec,
                                                          jobId: job.id,
                                                          totalMs: built.totalMs)
            finish(job, state: .done, event: ComposeEvent.completed, payload: result.json)
        } catch {
            fail(job, ErrorMapping.failure(for: error, stopReason: stopReason(of: job)))
        }
    }

    /// Deletes the files `CompositionBuilder` wrote for this render alone: a still for each picture
    /// (`PictureStills.folder`) and a link for each input whose name AVFoundation would refuse
    /// (`RenderInputs.folder`). Nothing reads them once the export has returned, or once the build
    /// has thrown, and a post of twelve photos is several megabytes that would otherwise wait in the
    /// job folder for `cleanup` or the launch sweep.
    ///
    /// Called by `run` BEFORE the terminal event, never after it: JS may answer `failed` with a new
    /// compose for the same post at once, and that render writes into these same folders. For the
    /// same reason it leaves them alone while another job of the post is still pending or rendering,
    /// which is the case when a stalled export comes back only after the watch has ended its job and
    /// the retry has started. A render whose app is killed leaves them for `cleanup` and the sweep,
    /// with the rest of the job folder.
    private func removeWorkingFiles(of job: ComposeJob) {
        lock.lock()
        let shared = jobs.values.contains { $0 !== job && $0.batchId == job.batchId && !$0.isTerminal }
        lock.unlock()
        guard !shared else { return }
        try? FileManager.default.removeItem(at: PictureStills.folder(job.batchId))
        try? FileManager.default.removeItem(at: RenderInputs.folder(job.batchId))
    }

    /// Refuses a render the disk has no room for, before it starts. A free space we cannot read
    /// ALLOWS, matching Android's `Long.MAX_VALUE`.
    private func spaceFailure(for job: ComposeJob) -> ComposeFailure? {
        let needed = Self.bytesNeeded(for: job.spec)
        guard let available = JobFolders.freeBytes(at: job.jobDir), available < needed else { return nil }
        var failure = ComposeFailure(code: .noSpace, message: "no_space need=\(needed) free=\(available)")
        // The SHORTFALL, not the total need: it is the figure the copy names, and "free up 40 MB"
        // is actionable where "this needs 260 MB" is not.
        failure.needBytes = needed - available
        return failure
    }

    /// The room on disk `spec` asks for, in Android's arithmetic exactly (`VideoComposerPlugin.kt`
    /// and `SizeCeiling.diskEstimate`), so a device that refuses a render on one platform refuses
    /// it on the other. The 1.15 multiplies the bitrate product only and that product is truncated
    /// before the 4 MiB of container overhead is added; the further 20 MiB is working margin for
    /// the export's temporary files.
    ///
    /// With a host's ceiling (`output.maxBytes`) the estimate is never more than the file can reach
    /// before it is stopped: the ceiling and a fifth, plus what one look at the file (`Transfer`'s
    /// half second, Android's `PROGRESS_POLL_MS`) lets past it and the container's 4 MiB. Without
    /// that, a long post on a nearly full phone would be refused `no_space` for a file the ceiling
    /// keeps far smaller - a refusal by estimate, which is exactly what holding the ceiling against
    /// the file itself is there to avoid. The fifth is Android's, for the gap its muxer can leave
    /// ahead of the samples; the writer here leaves none, and the figure is kept so the two agree.
    ///
    /// Neither figure counts the writer's last pass, which holds the file on disk twice for a
    /// while: the temporary file every sample went into, and beside it the copy with the index at
    /// the front that becomes the part file (see `Transfer.watchSize`) - 8.6 MB at once for a
    /// 4.3 MB file, measured. A disk with room for the file once and not twice gets through the
    /// encode and fails `no_space` on that pass, with a ceiling or without one, and a ceiling lets
    /// more renders through to find that out, because it asks for less. It is left at Android's
    /// figure all the same: Android's muxer writes its file in place, with the room for the index
    /// kept ahead of the samples and no second pass, and one post should be refused up front on
    /// both platforms or on neither.
    static func bytesNeeded(for spec: ComposeSpec) -> Int64 {
        let totalSeconds = max(1.0, Double(spec.totalOutputMs) / 1000.0)
        let bitrate = Double(spec.output.videoBitrate + spec.output.audioBitrate)
        let containerBytes: Int64 = 4 * 1024 * 1024
        var estimateBytes = Int64(bitrate / 8.0 * totalSeconds * 1.15) + containerBytes
        if let maxBytes = spec.output.maxBytes {
            // Worked in doubles, as Android works it, so a ceiling near the largest Int64 cannot
            // overflow into a small one.
            let slackBytes = Int64(bitrate / 8.0 * 1.15 * 0.5) + containerBytes
            let most = Double(maxBytes) * 1.2 + Double(slackBytes)
            if most < Double(estimateBytes) { estimateBytes = Int64(most) }
        }
        return estimateBytes + 20 * 1024 * 1024
    }

    // MARK: - State transitions

    private func stopReason(of job: ComposeJob) -> StopReason? {
        lock.lock()
        defer { lock.unlock() }
        return job.stopReason
    }

    private func condemnIfBackgrounded(_ job: ComposeJob) {
        lock.lock()
        if backgrounded, job.stopReason == nil { job.stopReason = .interrupted }
        lock.unlock()
    }

    /// The stall watch for one job, started as the job begins rendering and cancelled by `run` the
    /// moment the export returns or throws.
    ///
    /// A stall is answered in two steps. The reason goes in and the task is cancelled, which
    /// unwinds the export in a moment and lets `run` write the terminal state, as it does for every
    /// other stop, with `job.task` still there for a `cancel` or a `cleanup` to await. But a render
    /// that has stopped moving is a render something is stuck in, and the unwind can be stuck in
    /// the same place, so when `run` has not taken over by the next look the terminal state is
    /// written from here. That is what Android's `cancel` does every time, because Transformer
    /// sends nothing after a cancel either, and it is the difference between `failed { unknown,
    /// timeout }` and a job that says `rendering` for the rest of the process.
    ///
    /// The reason written is the job's own, which is `timeout` unless a cancel or a backgrounding
    /// got there first and has been stuck in the same unwind since.
    ///
    /// Internal rather than private, with the two figures as parameters, for the tests alone.
    func watchForStall(_ job: ComposeJob, limit: TimeInterval = StallWatch.limit,
                       every interval: TimeInterval = stallCheckInterval) -> Task<Void, Never> {
        lock.lock()
        job.stall = StallWatch(startedAt: ProcessInfo.processInfo.systemUptime, limit: limit)
        lock.unlock()

        let nanoseconds = UInt64(interval * 1_000_000_000)
        return Task { [weak self] in
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: nanoseconds)
                guard !Task.isCancelled, let self else { return }
                guard self.hasStalled(job) else { continue }
                // The reason goes in BEFORE the cancel, so the `CancellationError` that comes back
                // is read as a timeout and not as something the customer asked for.
                self.setStopReason(job, .timeout)
                self.cancelTask(job)

                try? await Task.sleep(nanoseconds: nanoseconds)
                // `run` cancels this task the moment the export comes back, either way, so still
                // being here is the export not having come back.
                guard !Task.isCancelled else { return }
                if let reason = self.stopReason(of: job) { self.finishStopped(job, reason: reason) }
                return
            }
        }
    }

    private func hasStalled(_ job: ComposeJob) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return job.stall.isStalled(at: ProcessInfo.processInfo.systemUptime)
    }

    private func setStopReason(_ job: ComposeJob, _ reason: StopReason) {
        lock.lock()
        if job.stopReason == nil { job.stopReason = reason }
        lock.unlock()
    }

    private func cancelTask(_ job: ComposeJob) {
        lock.lock()
        let task = job.task
        lock.unlock()
        task?.cancel()
    }

    private func setState(_ job: ComposeJob, _ state: JobState) {
        lock.lock()
        job.state = state
        lock.unlock()
        refreshIdleTimer()
    }

    /// The three outcomes we decided on ourselves, with the exact codes and messages the contract
    /// names. `interrupted` is a STATE, never an event: the event is `failed` either way and the
    /// state is picked from the code.
    private func finishStopped(_ job: ComposeJob, reason: StopReason) {
        try? FileManager.default.removeItem(at: job.partURL)
        switch reason {
        case .cancelled:
            fail(job, ComposeFailure(code: .cancelled, message: "cancelled by caller"))
        case .interrupted:
            fail(job, ComposeFailure(code: .interrupted, message: "did_enter_background"))
        case .timeout:
            fail(job, ComposeFailure(code: .unknown, message: "timeout"))
        }
    }

    private func fail(_ job: ComposeJob, _ failure: ComposeFailure) {
        try? FileManager.default.removeItem(at: job.partURL)
        let state: JobState = failure.code == .interrupted ? .interrupted : .failed
        finish(job, state: state, event: ComposeEvent.failed, payload: failure.json(jobId: job.id))
    }

    /// The single terminal writer. Everything that ends a job goes through here, which is what
    /// keeps `getState` and the event payload identical.
    private func finish(_ job: ComposeJob, state: JobState, event: String, payload: [String: Any]) {
        lock.lock()
        // A job can only go terminal once. A watchdog firing the same instant the export throws
        // would otherwise emit two terminal events for one render.
        guard !job.isTerminal else {
            lock.unlock()
            return
        }
        job.state = state
        job.terminalAt = ProcessInfo.processInfo.systemUptime
        if state == .done {
            job.result = payload
            // Forced to 1 only here. A failed or interrupted job keeps the progress it reached,
            // which is what the editor shows beside its retry button.
            job.progress = 1
        } else {
            job.error = payload
        }
        job.task = nil
        lock.unlock()

        emit(job, event, payload, retain: true)
        refreshIdleTimer()
    }

    // MARK: - Progress

    /// Internal rather than private for the stall tests, which move a job the way an export does.
    func report(progress value: Double, for job: ComposeJob) {
        guard value.isFinite else { return }
        // Clamped to 0.99 because `completed` is what takes the bar to 100. Without the clamp a
        // 1.0 progress event can arrive after the completion and the bar walks backwards.
        let clamped = min(0.99, max(0, value))

        var payload: [String: Any]?
        lock.lock()
        // The raw value, every time, and not the 1 % steps the bar moves by: at 4K60 on a slow
        // phone a single step of a long post can take longer than the watch allows.
        job.stall.heard(value, at: ProcessInfo.processInfo.systemUptime)
        if job.state == .rendering, clamped >= job.lastEmittedProgress + Self.progressStep {
            job.lastEmittedProgress = clamped
            job.progress = clamped
            payload = ["jobId": job.id, "progress": clamped]
        }
        lock.unlock()

        guard let payload else { return }
        emit(job, ComposeEvent.progress, payload, retain: false)
    }

    // MARK: - Events

    /// Nothing is queued when no bridge is attached. A progress percentage is worth nothing by the
    /// time a listener comes back, and a terminal outcome is already on the job, where `attach`
    /// replays it from.
    private func emit(_ job: ComposeJob, _ name: String, _ data: [String: Any], retain: Bool) {
        lock.lock()
        let target = job.suppressEvents ? nil : emitter
        lock.unlock()
        target?.emit(name, data, retain: retain)
    }

    // MARK: - Backgrounding and the idle timer

    /// Runs synchronously on main, inside the notification, and the ordering is the whole point.
    ///
    /// The ONLY state this writes is the stop reason, and it writes it before anything else can
    /// observe the job. That is what makes the difference between `interrupted` and `encoder`:
    /// AVFoundation is about to fail the export from the other side because Metal is denied to a
    /// backgrounded process, and every catch site in `run` consults the reason first. Whoever
    /// writes the reason first wins, so we write it with no suspension point in the way.
    ///
    /// It deliberately does NOT take the job terminal. The unwinding task stays the sole owner of
    /// the terminal write, which keeps `cancel` able to await it, keeps `setState` further down
    /// `run` from resurrecting a finished job, and leaves a render that completed during the lock
    /// screen free to report `done`. `getState` covers the gap by projecting `interrupted` for a
    /// condemned job that has not finished unwinding. The one unwind that does not own it is one
    /// that never comes back, which `watchForStall` ends from outside.
    private func interruptAll() {
        lock.lock()
        // Set before the snapshot is taken so a `start` that lands after this point is condemned by
        // `run` rather than rendering on into the background and reporting AVFoundation's -11820.
        backgrounded = true
        let active = jobs.values.filter { !$0.isTerminal }
        for job in active where job.stopReason == nil { job.stopReason = .interrupted }
        let tasks = active.compactMap { $0.task }
        lock.unlock()

        for task in tasks { task.cancel() }

        // The render itself is deliberately NOT given an assertion (see `refreshIdleTimer`): one
        // cannot hand the GPU back. This is a different thing and a much shorter one - the few
        // hundred milliseconds an already-dead export needs to unwind, emit its `failed` event and
        // let go of its files, plus the actor hop that closes the microphone.
        let assertion = BackgroundAssertion()
        assertion.begin(name: "videokit.interrupt")

        Task {
            // FIRST, ahead of the render unwind it does not depend on. A microphone left open in
            // the background is the kind of thing App Review notices, and a take that keeps
            // recording behind the lock screen is not one anybody wanted. Sequenced after the
            // unwind it would be skipped entirely whenever the assertion expires first.
            await VoiceRecorder.shared.abandon()
            for task in tasks { await task.value }
            await MainActor.run { assertion.end() }
        }
    }

    /// Cleared on the way back in so a job started after the app returns is not condemned by a flag
    /// left over from the last time the screen locked.
    private func enteredForeground() {
        lock.lock()
        backgrounded = false
        lock.unlock()
    }

    /// Held while any job is pending or rendering. There is no foreground assertion of any kind
    /// here on purpose: a background task assertion does not give the compositor its GPU back, so
    /// it buys a confusing -11847 instead of a clean `interrupted`.
    private func refreshIdleTimer() {
        lock.lock()
        let anyActive = jobs.values.contains { !$0.isTerminal }
        let changed = idleTimerHeld != anyActive
        if changed { idleTimerHeld = anyActive }
        lock.unlock()

        guard changed else { return }
        // UIApplication is main-thread only, and `.sync` from the Capacitor queue deadlocks.
        DispatchQueue.main.async {
            UIApplication.shared.isIdleTimerDisabled = anyActive
        }
    }

    // MARK: - Retention

    /// Caller holds the lock. A non-terminal job is never swept, whatever its age.
    private func sweepLocked() {
        let now = ProcessInfo.processInfo.systemUptime
        for (id, job) in jobs where job.isTerminal && job.terminalAt > 0
            && now - job.terminalAt > Self.terminalTTL {
            jobs.removeValue(forKey: id)
        }

        // The TTL above measures uptime, and this process is killed minutes after it leaves the
        // screen, so 24 h is effectively unreachable on iOS and the count cap is the bound that
        // actually fires.
        let terminals = jobs.values.filter { $0.isTerminal }
        guard terminals.count > Self.terminalCap else { return }
        let doomed = terminals.sorted { $0.terminalAt < $1.terminalAt }
            .prefix(terminals.count - Self.terminalCap)
        for job in doomed { jobs.removeValue(forKey: job.id) }
    }
}
