@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// How an export ends when it does not simply succeed: the one fallback to the preset session and
/// the cases that must not take it, a cancel partway through - including into a render whose frames
/// have stopped coming, and as its file closes - and the absence of any size ceiling.
final class ExportFailureTests: RenderTestCase {

    // MARK: - The fallback

    func testARefusedWriterFallsBackToThePresetOnce() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 1000)]))
        defer { job.cleanup() }

        let result = try await Exporter.export(job.built, to: file("out.mp4"), tmpDir: job.tmpDir, spec: job.spec,
                                               engines: (RefusedEngine.self, PresetEngine.self)) { _ in }

        XCTAssertEqual(Double(result.durationMs), 1000, accuracy: 70)
        let middle = try await TestMedia.color(of: file("out.mp4"), at: 0.5)
        XCTAssertTrue(middle.near(.red), "expected red, got \(middle)")
    }

    func testAFailureThatIsNotTheEncodersIsNotRetried() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 500)]))
        defer { job.cleanup() }

        do {
            _ = try await Exporter.export(job.built, to: file("out.mp4"), tmpDir: job.tmpDir, spec: job.spec,
                                          engines: (UnreadableEngine.self, MustNotRunEngine.self)) { _ in }
            XCTFail("an export whose only engine failed reported success")
        } catch let error as AVError {
            XCTAssertEqual(error.code, .decodeFailed)
        }
    }

    func testAStoppingJobIsNotRetried() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 500)]))
        defer { job.cleanup() }

        do {
            _ = try await Exporter.export(job.built, to: file("out.mp4"), tmpDir: job.tmpDir, spec: job.spec,
                                          shouldStop: { true },
                                          engines: (RefusedEngine.self, MustNotRunEngine.self)) { _ in }
            XCTFail("an export whose only engine failed reported success")
        } catch let error as AVError {
            XCTAssertEqual(error.code, .unsupportedOutputSettings)
        }
    }

    // MARK: - Cancelling

    func testCancellingMidExportThrowsAndLeavesNoPartFile() async throws {
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 6000, audio: true)
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 6000)]))
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        // The registry's own part file, so this is the path a cancelled render must not leave behind.
        let part = JobFolders.part(spec.batchId, jobId: spec.jobId)

        let underway = expectation(description: "a fifth of the way in")
        let once = FirstTime()
        let render = Task {
            let built = try await CompositionBuilder.build(spec)
            return try await Exporter.export(built, to: part, tmpDir: JobFolders.exportTmp(spec.batchId),
                                             spec: spec) { fraction in
                if fraction >= 0.2, once.claim() { underway.fulfill() }
            }
        }
        await fulfillment(of: [underway], timeout: 120)
        render.cancel()

        do {
            _ = try await render.value
            XCTFail("a cancelled export reported success")
        } catch {
            XCTAssertTrue(error is CancellationError, "threw \(error)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path), "the part file was left behind")
    }

    func testCancellingARenderWhoseFramesHaveStoppedComingIsAnsweredAtOnce() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 3000, color: .red, audio: false)
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 3000)]))
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let part = JobFolders.part(spec.batchId, jobId: spec.jobId)

        // Ten frames and then nothing: every later request is held unanswered, which is what a
        // wedged decoder or GPU looks like from the reader, and the video pump sits inside
        // `copyNextSampleBuffer` waiting for a frame that is not coming.
        WithheldFrames.shared.reset(drawing: 10)
        let written = expectation(description: "the tenth frame written")
        let once = FirstTime()
        let render = Task {
            let built = try await CompositionBuilder.build(spec)
            built.videoComposition.customVideoCompositorClass = WithholdingCompositor.self
            return try await Exporter.export(built, to: part, tmpDir: JobFolders.exportTmp(spec.batchId),
                                             spec: spec) { fraction in
                // The tenth frame starts 0.3 s into three seconds.
                if fraction >= 0.099, once.claim() { written.fulfill() }
            }
        }
        // The reader asks for frames ahead of the pump, so the first held request says nothing
        // about where the pump is. The tenth frame written does, and the pump is then a moment
        // away from asking for the eleventh.
        await fulfillment(of: [written], timeout: 60)
        try await Task.sleep(nanoseconds: 300_000_000)

        let answered = expectation(description: "the cancel answered")
        let thrown = Thrown()
        Task {
            do { _ = try await render.value } catch { thrown.error = error }
            answered.fulfill()
        }
        let cancelledAt = ProcessInfo.processInfo.systemUptime
        render.cancel()
        await fulfillment(of: [answered], timeout: 10)
        let waited = ProcessInfo.processInfo.systemUptime - cancelledAt

        XCTAssertLessThan(waited, 1.5, "the cancel waited \(waited) s for a frame")
        XCTAssertTrue(thrown.error is CancellationError, "threw \(String(describing: thrown.error))")
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path), "the part file was left behind")
        // A reader cancelled while the frames were still held would be a transfer that closed on
        // time, and a test that never had a stuck pump to answer without.
        XCTAssertFalse(WithheldFrames.shared.cancelledWhileHolding, "the render was never stuck")

        // Let go, and the transfer the cancel stopped waiting for still closes the usual way: its
        // reader is cancelled, which is what reaches the compositor as a cancel of everything.
        let closed = expectation(description: "the reader cancelled")
        WithheldFrames.shared.release { closed.fulfill() }
        await fulfillment(of: [closed], timeout: 10)
        XCTAssertFalse(FileManager.default.fileExists(atPath: part.path), "the closing transfer left a file")
    }

    func testACancelThatLandsAsTheFileClosesIsStillACancel() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 500)]))
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        defer { JobFolders.cleanup(batchId: spec.batchId) }
        let out = file("out.mp4")

        let closing = expectation(description: "the file closing")
        let once = FirstTime()
        let render = Task {
            let built = try await CompositionBuilder.build(spec)
            return try await Exporter.export(built, to: out, tmpDir: JobFolders.exportTmp(spec.batchId), spec: spec,
                                             engines: (ClosesAnywayEngine.self, MustNotRunEngine.self)) { _ in
                if once.claim() { closing.fulfill() }
            }
        }
        await fulfillment(of: [closing], timeout: 60)
        render.cancel()

        do {
            _ = try await render.value
            XCTFail("a render cancelled while its file closed reported success")
        } catch {
            XCTAssertTrue(error is CancellationError, "threw \(error)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "the closed file was kept")
    }

    // MARK: - No size ceiling

    func testThePresetSessionCarriesNoFileLengthLimit() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 500)]))
        defer { job.cleanup() }

        let session = try PresetEngine.session(for: job.built, spec: job.spec, tmpDir: job.tmpDir)
        // Zero is AVAssetExportSession's "no limit". The session used to carry 90 MiB, which cut a
        // long or high-rate render short instead of encoding it.
        XCTAssertEqual(session.fileLengthLimit, 0)
    }

    func testAFileOverTheOldCeilingIsDescribedNotRefused() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let options = TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 1000)])
        let (out, _) = try await TestRender.render(options, to: file("out.mp4"))

        // Grown past the 100 MiB the package used to refuse after the whole encode, without writing
        // 100 MiB: the extension is a hole in a sparse file, and the size is what is read back.
        let ceiling: UInt64 = 104_857_600
        let handle = try FileHandle(forWritingTo: out)
        try handle.truncate(atOffset: ceiling + 10 * 1024 * 1024)
        try handle.close()

        // A fresh URL, because a URL caches the resource values it has been asked for, and this one
        // was asked for its size when the render described it.
        let grown = URL(fileURLWithPath: out.path)
        let spec = try TestCalls.parse(options)
        let result = try await ResultBuilder.describe(grown, spec: spec, jobId: spec.jobId, totalMs: 1000)
        XCTAssertGreaterThan(UInt64(result.bytes), ceiling)
        XCTAssertEqual(Double(result.durationMs), 1000, accuracy: 70)
    }
}

// MARK: - Engines for the fallback seam

/// Turns the request down the way the writer does before its first frame.
private enum RefusedEngine: RenderEngine {
    static let name = "refused"
    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        throw AVError(.unsupportedOutputSettings)
    }
}

/// Fails the way a clip that will not decode does, which no second engine can fix.
private enum UnreadableEngine: RenderEngine {
    static let name = "unreadable"
    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        throw AVError(.decodeFailed)
    }
}

/// The writer as it is when a cancel arrives after the last sample: under way, and closing its file
/// whatever happens to the task meanwhile.
private enum ClosesAnywayEngine: RenderEngine {
    static let name = "closes-anyway"
    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        onProgress(0.99)
        while !Task.isCancelled { try? await Task.sleep(nanoseconds: 1_000_000) }
        FileManager.default.createFile(atPath: url.path, contents: Data(count: 1024))
    }
}

private enum MustNotRunEngine: RenderEngine {
    static let name = "must-not-run"
    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        XCTFail("the fallback ran")
        throw TestError("the fallback ran")
    }
}

// MARK: - Helpers

/// A spec parsed and built, with its job folder, for the tests that call `Exporter` directly.
private struct Job {
    let spec: ComposeSpec
    let built: BuiltComposition

    var tmpDir: URL { JobFolders.exportTmp(spec.batchId) }

    init(_ options: [String: Any]) async throws {
        spec = try TestCalls.parse(options)
        try JobFolders.ensure(JobFolders.root)
        try JobFolders.ensure(JobFolders.jobDir(spec.batchId))
        built = try await CompositionBuilder.build(spec)
    }

    func cleanup() { JobFolders.cleanup(batchId: spec.batchId) }
}

/// True for the first caller only, from any thread.
final class FirstTime: @unchecked Sendable {
    private let lock = NSLock()
    private var claimed = false

    func claim() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard !claimed else { return false }
        claimed = true
        return true
    }
}

/// Whatever a task threw, written on one task and read on another.
private final class Thrown: @unchecked Sendable {
    private let lock = NSLock()
    private var held: Error?

    var error: Error? {
        get { lock.lock(); defer { lock.unlock() }; return held }
        set { lock.lock(); held = newValue; lock.unlock() }
    }
}

// MARK: - A compositor that stops answering

/// Draws the frames `WithheldFrames` allows and then answers nothing more, a cancel of everything
/// included, until the test lets go of what it holds.
private final class WithholdingCompositor: NSObject, AVVideoCompositing, @unchecked Sendable {
    /// `EditCompositor`'s own pair, which is what the writer engine's reader asks for.
    private static let pixels: [String: any Sendable] = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferMetalCompatibilityKey as String: true,
    ]

    var sourcePixelBufferAttributes: [String: any Sendable]? = WithholdingCompositor.pixels
    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = WithholdingCompositor.pixels

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        guard !WithheldFrames.shared.hold(request) else { return }
        guard let frame = request.renderContext.newPixelBuffer() else {
            request.finish(with: TestError("no pixel buffer"))
            return
        }
        request.finish(withComposedVideoFrame: frame)
    }

    func cancelAllPendingVideoCompositionRequests() {
        WithheldFrames.shared.cancelledAll()
    }
}

/// What the withholding compositor may draw and what it is holding. Shared, because AVFoundation
/// builds the compositor itself with a bare `init()` and there is no handing it anything.
private final class WithheldFrames: @unchecked Sendable {
    static let shared = WithheldFrames()

    private let lock = NSLock()
    private var allowance = 0
    private var holding = false
    private var held: [AVAsynchronousVideoCompositionRequest] = []
    private var onCancelAll: (() -> Void)?
    private var cancelledEarly = false

    func reset(drawing frames: Int) {
        lock.lock()
        allowance = frames
        holding = true
        held = []
        onCancelAll = nil
        cancelledEarly = false
        lock.unlock()
    }

    /// True when `request` is held rather than drawn.
    func hold(_ request: AVAsynchronousVideoCompositionRequest) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        guard holding, allowance == 0 else {
            allowance = max(0, allowance - 1)
            return false
        }
        held.append(request)
        return true
    }

    /// Answers every held request as cancelled and draws whatever is asked for after it;
    /// `onCancelAll` hears the next cancel of everything.
    func release(onCancelAll: @escaping () -> Void) {
        lock.lock()
        let requests = held
        held = []
        holding = false
        self.onCancelAll = onCancelAll
        lock.unlock()
        for request in requests { request.finishCancelledRequest() }
    }

    /// Whether the compositor was told to cancel everything while it held a frame back. AVFoundation
    /// also says that once as reading starts, before it has asked for a single frame, and that one
    /// says nothing about the render, so it is not counted.
    var cancelledWhileHolding: Bool {
        lock.lock()
        defer { lock.unlock() }
        return cancelledEarly
    }

    func cancelledAll() {
        lock.lock()
        if holding, !held.isEmpty { cancelledEarly = true }
        let heard = onCancelAll
        onCancelAll = nil
        lock.unlock()
        heard?()
    }
}
