import XCTest
@testable import CapacitorVideoKitCore

/// The registry's stall watch, which replaced a fixed wall-clock budget: a render is stopped for
/// going nowhere, never for being slow.
final class ExportStallTests: XCTestCase {

    func testARenderThatNeverMovesStallsAfterTheLimit() {
        let watch = StallWatch(startedAt: 100)
        XCTAssertFalse(watch.isStalled(at: 100 + StallWatch.limit))
        XCTAssertTrue(watch.isStalled(at: 100 + StallWatch.limit + 1))
    }

    func testMovementPutsTheStallOff() {
        var watch = StallWatch(startedAt: 100)
        watch.heard(0.1, at: 150)
        XCTAssertFalse(watch.isStalled(at: 150 + StallWatch.limit))
        XCTAssertTrue(watch.isStalled(at: 151 + StallWatch.limit))
    }

    func testTheSameFractionAgainIsNotMovement() {
        var watch = StallWatch(startedAt: 100)
        watch.heard(0.4, at: 150)
        // The preset engine is polled on a timer, and a wedged session reports its last fraction
        // over and over.
        watch.heard(0.4, at: 200)
        XCTAssertTrue(watch.isStalled(at: 151 + StallWatch.limit))
    }

    func testStartingAgainFromZeroIsMovement() {
        var watch = StallWatch(startedAt: 100)
        watch.heard(0.3, at: 150)
        // The fallback engine begins at the start of the timeline again.
        watch.heard(0, at: 300)
        XCTAssertFalse(watch.isStalled(at: 300 + StallWatch.limit))
    }

    func testASlowRenderThatKeepsMovingNeverStalls() {
        // Ten minutes of output rendered at a tenth of real time and heard from every three seconds:
        // far past the three times the timeline plus thirty seconds the old budget allowed, and
        // never still for long.
        var watch = StallWatch(startedAt: 0)
        var now: TimeInterval = 0
        var fraction = 0.0
        while fraction < 1 {
            now += 3
            fraction += 0.0005
            watch.heard(fraction, at: now)
            XCTAssertFalse(watch.isStalled(at: now + 1))
        }
        XCTAssertGreaterThan(now, 3 * 600 + 30)
    }

    // MARK: - The watch in the registry

    // The watch run the way `run` runs it, from the progress an export reports to the terminal
    // state, with a limit of a fraction of a second in place of a minute and a half.

    func testAJobIsStoppedOnlyOnceItStopsMoving() async throws {
        let job = try renderingJob()
        let watchdog = JobRegistry.shared.watchForStall(job, limit: 0.5, every: 0.05)

        // Four times the limit, reported through the path an export reports through.
        for step in 1...20 {
            try await Task.sleep(nanoseconds: 100_000_000)
            JobRegistry.shared.report(progress: Double(step) / 100, for: job)
        }
        XCTAssertFalse(job.isTerminal, "a job that kept moving was stopped")

        // Then silence, and nothing that will ever unwind: no task to cancel, as with an export
        // stuck for good. The watch writes the outcome itself.
        await watchdog.value
        XCTAssertEqual(job.state, .failed)
        XCTAssertEqual(job.stopReason, .timeout)
        XCTAssertEqual(job.error?["code"] as? String, "unknown")
        XCTAssertEqual(job.error?["message"] as? String, "timeout")
    }

    func testAnExportThatComesBackIsLeftToEndTheJob() async throws {
        let job = try renderingJob()
        let watch = WatchHolder()
        // Stands in for `run`: an export that answers its cancel, and the catch that stops the watch
        // before writing the outcome.
        let export = Task {
            while !Task.isCancelled { try? await Task.sleep(nanoseconds: 5_000_000) }
            watch.task?.cancel()
        }
        job.task = export
        watch.task = JobRegistry.shared.watchForStall(job, limit: 0.2, every: 0.05)

        await export.value
        await watch.task?.value
        XCTAssertEqual(job.stopReason, .timeout, "the export was cancelled without a reason")
        XCTAssertFalse(job.isTerminal, "the watch wrote the outcome over the unwind that owns it")
    }

    func testAStuckCancelIsEndedAsTheCancelItWas() async throws {
        let job = try renderingJob()
        // The customer's cancel got there first, and its unwind is what is stuck.
        job.stopReason = .cancelled
        let watchdog = JobRegistry.shared.watchForStall(job, limit: 0.2, every: 0.05)

        await watchdog.value
        XCTAssertEqual(job.state, .failed)
        XCTAssertEqual(job.error?["code"] as? String, "cancelled")
    }

    /// A job as `run` has it when the export starts. The watch needs nothing registered.
    private func renderingJob() throws -> ComposeJob {
        let spec = try TestCalls.parse(TestSpecs.spec([
            TestSpecs.clip("seg-1", URL(fileURLWithPath: "/nonexistent/seg-1.mp4"), outMs: 1000),
        ]))
        let job = ComposeJob(spec: spec)
        job.state = .rendering
        return job
    }
}

/// The watch's task, handed to the stand-in export that has to stop it.
private final class WatchHolder: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Task<Void, Never>?

    var task: Task<Void, Never>? {
        get { lock.lock(); defer { lock.unlock() }; return held }
        set { lock.lock(); held = newValue; lock.unlock() }
    }
}
