import Foundation
import UIKit

/// One render, from the moment `compose` accepts it until JS has seen how it ended.
///
/// Every mutable field here is guarded by the single `NSLock` inside `JobRegistry`, which is why
/// this is a class with bare `var`s and no locking of its own: Kotlin marks the same fields
/// `@Volatile` on a `ConcurrentHashMap` entry, and one lock in one place is the Swift equivalent
/// that does not invite a second, re-entrant one.
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
    /// first, so a cancel, a backgrounding and the wall-clock timeout all report themselves rather
    /// than whatever `CancellationError` the export happened to raise.
    var stopReason: StopReason?
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

/// The render jobs, held for the whole process rather than for the life of a plugin instance.
///
/// A WebView reload or a route change builds a fresh `CAPPlugin` while an export is still running,
/// and an outcome stored on the dead instance reaches nobody - retained events are retained on that
/// instance. So the outcome lives here, and the next plugin instance replays whatever JS has not
/// acknowledged. Under that sit two more nets: `getState` can always be asked, and if even the
/// process died, `getState` answers `job_not_found` and JS restarts from its own manifest.
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

    /// Called from `VideoComposerPlugin.load()`, which happens again on every WebView reload.
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

    /// A reload constructs the new plugin BEFORE the old one deallocates, so clearing the emitter
    /// unconditionally from `deinit` would unhook the live bridge.
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

    /// For `JobFolders.sweep`, which knows the post only by its folder name, i.e. the SANITISED id.
    ///
    /// "Live" includes a terminal job JS has not collected yet: its `stitched.mp4` and poster are
    /// the whole point of the folder, and deleting them while the outcome is still unacknowledged
    /// hands the customer a `file_missing` for a render that actually succeeded.
    func hasLiveJob(batchId: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return jobs.values.contains { job in
            guard job.batchId == batchId
                    || JobFolders.sanitize(job.batchId) == batchId else { return false }
            return !job.isTerminal || !job.acked
        }
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
            let reason = stopReason(of: job)
            if let reason { finishStopped(job, reason: reason); return }
            fail(job, ErrorMapping.failure(for: error, stopReason: nil))
            return
        }

        if let reason = stopReason(of: job) { finishStopped(job, reason: reason); return }
        setState(job, .rendering)

        // Three times real time plus half a minute. A render that has not finished by then is not
        // going to: something upstream is wedged, and `unknown` / `timeout` is a far better answer
        // than a spinner the customer stares at until they kill the app.
        let budgetSeconds = 3.0 * max(1.0, Double(job.spec.totalOutputMs) / 1000.0) + 30.0
        let watchdog = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(budgetSeconds * 1_000_000_000))
            guard !Task.isCancelled, let self else { return }
            // The reason goes in BEFORE the cancel, so the `CancellationError` that comes back is
            // read as a timeout and not as something the customer asked for.
            self.setStopReason(job, .timeout)
            self.cancelTask(job)
        }

        do {
            // The exporter describes the part file it has just written; that result is thrown away
            // and the finished file is described again below at its final path, because `uri` has
            // to be stitched.mp4 and the poster belongs beside it.
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
            if let reason = stopReason(of: job) { finishStopped(job, reason: reason); return }
            fail(job, ErrorMapping.failure(for: error, stopReason: nil))
            return
        }

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

    /// Android's arithmetic exactly, so a device that fails to render on one platform fails on the
    /// other. The 1.15 multiplies the bitrate product only and that product is truncated before the
    /// 4 MiB of container overhead is added; the further 20 MiB is working margin for the export's
    /// temporary files. A free space we cannot read ALLOWS, matching Android's `Long.MAX_VALUE`.
    private func spaceFailure(for job: ComposeJob) -> ComposeFailure? {
        let totalSeconds = max(1.0, Double(job.spec.totalOutputMs) / 1000.0)
        let bitrate = Double(job.spec.output.videoBitrate + job.spec.output.audioBitrate)
        let estimateBytes = Int64(bitrate / 8.0 * totalSeconds * 1.15) + 4 * 1024 * 1024
        let needed = estimateBytes + 20 * 1024 * 1024
        guard let available = JobFolders.freeBytes(at: job.jobDir), available < needed else { return nil }
        var failure = ComposeFailure(code: .noSpace, message: "no_space need=\(needed) free=\(available)")
        // The SHORTFALL, not the total need: it is the figure the copy names, and "free up 40 MB"
        // is actionable where "this needs 260 MB" is not.
        failure.needBytes = needed - available
        return failure
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

    private func report(progress value: Double, for job: ComposeJob) {
        guard value.isFinite else { return }
        // Clamped to 0.99 because `completed` is what takes the bar to 100. Without the clamp a
        // 1.0 progress event can arrive after the completion and the bar walks backwards.
        let clamped = min(0.99, max(0, value))

        var payload: [String: Any]?
        lock.lock()
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
    /// condemned job that has not finished unwinding.
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
