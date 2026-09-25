@preconcurrency import AVFoundation
import XCTest
@testable import CapacitorVideoKitCore

/// How an export ends when it does not simply succeed: the one fallback to the preset session and
/// the cases that must not take it, a cancel partway through - including into a render whose frames
/// have stopped coming, and as its file closes - and the host's size ceiling, `output.maxBytes`,
/// which fails a render `too_large` when it is set and holds nothing back when it is not.
final class ExportFailureTests: RenderTestCase {

    // MARK: - The poster

    /// The exporter's own description of the file is thrown away by the registry, which describes
    /// the finished file again and cuts the poster there. So the exporter cuts none - it used to cut
    /// the same frame into the same poster.jpg a second time - while still measuring the file.
    func testTheExportPassCutsNoPosterAndTheFinalDescribeCutsOne() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 1000)]))
        defer { job.cleanup() }

        let result = try await Exporter.export(job.built, to: file("out.mp4"), tmpDir: job.tmpDir, spec: job.spec) { _ in }
        XCTAssertEqual(result.posterUri, "")
        XCTAssertFalse(FileManager.default.fileExists(atPath: file("poster.jpg").path))
        XCTAssertEqual(Double(result.durationMs), 1000, accuracy: 70, "the probe still runs")
        XCTAssertGreaterThan(result.bytes, 0)

        let final = try await ResultBuilder.describe(file("out.mp4"), spec: job.spec, jobId: job.spec.jobId,
                                                     totalMs: job.built.totalMs)
        XCTAssertEqual(final.posterUri, file("poster.jpg").absoluteString)
        XCTAssertTrue(FileManager.default.fileExists(atPath: file("poster.jpg").path))
    }

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

    // MARK: - The size ceiling

    func testTheCeilingAloneDecidesWhetherTheSameRenderFails() async throws {
        // Eight seconds of noise at 4 Mbps, about four megabytes finished: long enough that a render
        // stopped at its first look at the file is stopped a long way short of the end.
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 8000, audio: true)
        func spec(maxBytes: Double?) throws -> ComposeSpec {
            var output: [String: Any] = ["width": 360, "height": 640, "fps": 30,
                                         "videoBitrate": 4_000_000, "audioBitrate": 128_000]
            if let maxBytes { output["maxBytes"] = maxBytes }
            return try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 8000)],
                                                      ["output": output]))
        }

        let unlimited = try spec(maxBytes: nil)
        let free = try await Registry.render(unlimited)
        defer { JobFolders.cleanup(batchId: unlimited.batchId) }
        XCTAssertEqual(free["state"] as? String, "done", "\(free)")
        let bytes = try XCTUnwrap((free["result"] as? [String: Any])?["bytes"] as? Int64)
        XCTAssertGreaterThan(bytes, 2_000_000, "the render the ceilings below are measured against")

        // Just over the finished size. The look at the file while it is written counts what the
        // writer has written and nothing else, so a render that fits is not stopped for one that
        // only seemed not to: a file counted twice, or a stale one counted with it, would fail here.
        let roomy = try spec(maxBytes: (Double(bytes) * 1.03).rounded(.down))
        let fits = try await Registry.render(roomy)
        defer { JobFolders.cleanup(batchId: roomy.batchId) }
        XCTAssertEqual(fits["state"] as? String, "done", "\(fits)")

        // Just under it, which only the end of the render can find out: by the last look at the
        // file, or by the check of the finished one.
        let snug = Int64((Double(bytes) * 0.97).rounded(.down))
        let justUnder = try spec(maxBytes: Double(snug))
        let past = try await Registry.render(justUnder)
        defer { JobFolders.cleanup(batchId: justUnder.batchId) }
        XCTAssertEqual(past["state"] as? String, "failed", "\(past)")
        let pastError = try XCTUnwrap(past["error"] as? [String: Any])
        XCTAssertEqual(pastError["code"] as? String, "too_large")
        let pastMessage = try XCTUnwrap(pastError["message"] as? String)
        XCTAssertGreaterThan(try XCTUnwrap(Self.reachedBytes(pastMessage, max: snug), pastMessage), snug, pastMessage)
        XCTAssertFalse(FileManager.default.fileExists(atPath: JobFolders.stitched(justUnder.batchId).path),
                       "a render past its ceiling was moved into place")

        let tight = try spec(maxBytes: 200_000)
        let over = try await Registry.render(tight)
        defer { JobFolders.cleanup(batchId: tight.batchId) }
        XCTAssertEqual(over["state"] as? String, "failed", "\(over)")
        let error = try XCTUnwrap(over["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "too_large")
        let message = try XCTUnwrap(error["message"] as? String)
        let reached = try XCTUnwrap(Self.reachedBytes(message, max: 200_000), message)
        XCTAssertGreaterThan(reached, 200_000, message)
        // Stopped as the file grew, not at the end: well short of the finished size, and of the
        // end of the timeline.
        XCTAssertLessThan(reached, bytes / 2, message)
        XCTAssertLessThan(over["progress"] as? Double ?? 1, 0.9, "\(over)")
        XCTAssertFalse(FileManager.default.fileExists(atPath: JobFolders.part(tight.batchId, jobId: tight.jobId).path),
                       "the part file was left behind")
        XCTAssertFalse(FileManager.default.fileExists(atPath: JobFolders.stitched(tight.batchId).path),
                       "a render past its ceiling was moved into place")
        XCTAssertEqual(Self.files(in: JobFolders.exportTmp(tight.batchId)), [], "the writer's temporary file was left behind")
    }

    func testAFinishedFilePastTheCeilingIsDeletedAndFailsTooLarge() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 1000)], [
            "output": ["width": 360, "height": 640, "fps": 30, "videoBitrate": 2_000_000, "audioBitrate": 128_000,
                       "maxBytes": Double(GrownEngine.size - 1)],
        ]))
        defer { job.cleanup() }
        let out = file("out.mp4")

        do {
            _ = try await Exporter.export(job.built, to: out, tmpDir: job.tmpDir, spec: job.spec,
                                          engines: (GrownEngine.self, MustNotRunEngine.self)) { _ in }
            XCTFail("a file past its ceiling was described")
        } catch {
            let failure = ErrorMapping.failure(for: error, stopReason: nil)
            XCTAssertEqual(failure.code, .tooLarge)
            XCTAssertEqual(failure.message, "too_large max=\(GrownEngine.size - 1) bytes=\(GrownEngine.size)")
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "the file past its ceiling was kept")
    }

    func testAFileAtItsCeilingOrWithNoneOfAnySizeIsDescribed() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 1000, color: .red)
        let output: [String: Any] = ["width": 360, "height": 640, "fps": 30,
                                     "videoBitrate": 2_000_000, "audioBitrate": 128_000]
        var atCeiling = output
        atCeiling["maxBytes"] = Double(GrownEngine.size)

        // Past the 100 MiB the package used to refuse whatever the host wanted, and exactly at a
        // ceiling, which is the most a file may have rather than more than it.
        for output in [output, atCeiling] {
            let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 1000)], ["output": output]))
            defer { job.cleanup() }
            let result = try await Exporter.export(job.built, to: file("out.mp4"), tmpDir: job.tmpDir, spec: job.spec,
                                                   engines: (GrownEngine.self, MustNotRunEngine.self)) { _ in }
            XCTAssertEqual(result.bytes, GrownEngine.size, "\(output)")
            XCTAssertEqual(Double(result.durationMs), 1000, accuracy: 70)
        }
    }

    func testThePresetSessionIsHandedTheCeiling() async throws {
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 500, color: .red)
        let unlimited = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 500)]))
        defer { unlimited.cleanup() }
        let limited = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 500)], [
            "output": ["width": 360, "height": 640, "fps": 30, "videoBitrate": 2_000_000, "audioBitrate": 128_000,
                       "maxBytes": 100_000_000],
        ]))
        defer { limited.cleanup() }

        // Zero is AVAssetExportSession's "no limit". A host that sets none gets none, as lighsnip
        // does; the 90 MiB the session once carried for every host cut a long render short.
        let free = try PresetEngine.session(for: unlimited.built, spec: unlimited.spec, tmpDir: unlimited.tmpDir)
        XCTAssertEqual(free.fileLengthLimit, 0)
        let held = try PresetEngine.session(for: limited.built, spec: limited.spec, tmpDir: limited.tmpDir)
        XCTAssertEqual(held.fileLengthLimit, 100_000_000)
    }

    func testTheFallbacksFinishedFileIsHeldToTheCeiling() async throws {
        // The session given a limit below what its sound alone takes, which it was measured
        // overshooting: the check of the finished file is what fails it.
        let source = try await TestMedia.noise(file("noise.mp4"), durationMs: 4000, audio: true)
        let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 4000)], [
            "output": ["width": 360, "height": 640, "fps": 30, "videoBitrate": 4_000_000, "audioBitrate": 128_000,
                       "maxBytes": 100_000],
        ]))
        defer { job.cleanup() }
        let out = file("out.mp4")

        do {
            _ = try await Exporter.export(job.built, to: out, tmpDir: job.tmpDir, spec: job.spec,
                                          engines: (RefusedEngine.self, PresetEngine.self)) { _ in }
            XCTFail("the fallback's file past its ceiling was described")
        } catch {
            let failure = ErrorMapping.failure(for: error, stopReason: nil)
            XCTAssertEqual(failure.code, .tooLarge, "\(error)")
            XCTAssertNotNil(Self.reachedBytes(failure.message, max: 100_000), failure.message)
        }
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "the file past its ceiling was kept")
    }

    func testAFallbackCutShortUnderACeilingFailsTooLarge() async throws {
        // Two seconds of timeline, and a fallback that hands back half a second of it, as a session
        // that met its `fileLengthLimit` by stopping would.
        let source = try await TestMedia.video(file("red.mp4"), durationMs: 2000, color: .red)
        _ = try await TestMedia.video(CutShortEngine.short, durationMs: 500, color: .red)
        defer { try? FileManager.default.removeItem(at: CutShortEngine.short) }
        let shortBytes = Exporter.size(of: CutShortEngine.short)
        let output: [String: Any] = ["width": 360, "height": 640, "fps": 30,
                                     "videoBitrate": 2_000_000, "audioBitrate": 128_000]
        var held = output
        held["maxBytes"] = 100_000_000
        let out = file("out.mp4")
        func failure(_ output: [String: Any],
                     _ engines: (first: RenderEngine.Type, fallback: RenderEngine.Type)) async throws -> ComposeFailure? {
            let job = try await Job(TestSpecs.spec([TestSpecs.clip("seg-1", source, outMs: 2000)], ["output": output]))
            defer { job.cleanup() }
            do {
                _ = try await Exporter.export(job.built, to: out, tmpDir: job.tmpDir, spec: job.spec,
                                              engines: engines) { _ in }
                return nil
            } catch {
                return ErrorMapping.failure(for: error, stopReason: nil)
            }
        }

        // The limit is what cut it, so it is the ceiling the customer is told about, at the size it
        // stopped at.
        let cut = try await failure(held, (RefusedEngine.self, CutShortEngine.self))
        XCTAssertEqual(cut?.code, .tooLarge)
        XCTAssertEqual(cut?.message, "too_large max=100000000 bytes=\(shortBytes)")
        XCTAssertFalse(FileManager.default.fileExists(atPath: out.path), "the file the ceiling cut short was kept")

        // With no ceiling the fallback had no limit to stop at, and the writer stops itself at one
        // rather than hand back a short file: either way a short file is an encoder that stopped.
        let unlimited = try await failure(output, (RefusedEngine.self, CutShortEngine.self))
        XCTAssertEqual(unlimited?.code, .encoder)
        XCTAssertEqual(unlimited?.message.hasPrefix("truncated "), true, unlimited?.message ?? "described")
        let writer = try await failure(held, (CutShortEngine.self, MustNotRunEngine.self))
        XCTAssertEqual(writer?.code, .encoder)
        XCTAssertEqual(writer?.message.hasPrefix("truncated "), true, writer?.message ?? "described")
    }

    func testTheParserReadsOnlyANumberOfAtLeastOneByteAsACeiling() throws {
        func ceiling(_ value: Any?) throws -> Int64? {
            var output: [String: Any] = ["width": 360, "height": 640, "fps": 30,
                                         "videoBitrate": 2_000_000, "audioBitrate": 128_000]
            if let value { output["maxBytes"] = value }
            let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", file("a.mp4"), outMs: 1000)],
                                                          ["output": output]))
            return spec.output.maxBytes
        }
        // Every one of these is no ceiling, and none of them is a refusal: a host that sends a bad
        // limit has still asked for a video.
        XCTAssertNil(try ceiling(nil), "absent")
        XCTAssertNil(try ceiling(NSNull()), "null")
        XCTAssertNil(try ceiling(0), "zero")
        XCTAssertNil(try ceiling(-100_000_000), "negative")
        XCTAssertNil(try ceiling(Double.nan), "NaN")
        XCTAssertNil(try ceiling(Double.infinity), "infinite")
        XCTAssertNil(try ceiling("100000000"), "not a number")
        // Under one byte once rounded down, as the web's `byteCeiling` reads it: a ceiling of 0
        // would fail every render the web engine renders with no ceiling at all.
        XCTAssertNil(try ceiling(0.5), "a fraction under one")

        XCTAssertEqual(try ceiling(100_000_000), 100_000_000)
        XCTAssertEqual(try ceiling(1000.7), 1000, "a file has no fraction of a byte")
        XCTAssertEqual(try ceiling(1e30), Int64.max, "past what a file can reach")
    }

    func testTheDiskIsAskedForNoMoreThanTheCeilingLetsTheFileReach() throws {
        // Ten minutes at 12 Mbps, which the bitrate says is about a gigabyte.
        func spec(maxBytes: Double?) throws -> ComposeSpec {
            var output: [String: Any] = ["width": 1080, "height": 1920, "fps": 30,
                                         "videoBitrate": 11_808_000, "audioBitrate": 192_000]
            if let maxBytes { output["maxBytes"] = maxBytes }
            return try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("seg-1", file("a.mp4"), outMs: 600_000)],
                                                      ["output": output]))
        }
        let mib: Int64 = 1024 * 1024
        // Android's figures: the bitrate product and fifteen percent more, the container, the margin.
        let uncapped = Int64(12_000_000.0 / 8 * 600 * 1.15) + 4 * mib + 20 * mib
        XCTAssertEqual(JobRegistry.bytesNeeded(for: try spec(maxBytes: nil)), uncapped)

        // A 100 MB ceiling: the ceiling and a fifth, half a second of the bitrate and the container
        // past it, and the same margin.
        let slack = Int64(12_000_000.0 / 8 * 1.15 * 0.5) + 4 * mib
        XCTAssertEqual(JobRegistry.bytesNeeded(for: try spec(maxBytes: 100_000_000)),
                       Int64(100_000_000.0 * 1.2 + Double(slack)) + 20 * mib)

        // A ceiling the estimate never reaches changes nothing.
        XCTAssertEqual(JobRegistry.bytesNeeded(for: try spec(maxBytes: 5e9)), uncapped)
        XCTAssertEqual(JobRegistry.bytesNeeded(for: try spec(maxBytes: 1e30)), uncapped)
    }

    /// The bytes a `too_large` message says the file reached, when the message is exactly the
    /// contract's `too_large max=<maxBytes> bytes=<bytes>` for `max`; nil for any other text.
    private static func reachedBytes(_ message: String, max: Int64) -> Int64? {
        let prefix = "too_large max=\(max) bytes="
        guard message.hasPrefix(prefix) else { return nil }
        let digits = message.dropFirst(prefix.count)
        guard !digits.isEmpty, digits.allSatisfy(\.isNumber) else { return nil }
        return Int64(digits)
    }

    /// Every file in `folder` and below it, by its path inside it; empty when there is no folder.
    private static func files(in folder: URL) -> [String] {
        guard let walker = FileManager.default.enumerator(at: folder, includingPropertiesForKeys: [.isRegularFileKey])
        else { return [] }
        return walker.compactMap { item -> String? in
            guard let url = item as? URL,
                  (try? url.resourceValues(forKeys: [.isRegularFileKey]))?.isRegularFile == true else { return nil }
            return url.path.replacingOccurrences(of: folder.path + "/", with: "")
        }
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

/// The writer's real file, grown past 100 MiB without writing 100 MiB: the extension is a hole in a
/// sparse file, and the size is what the checks read back. The front of the file is the writer's,
/// index first, so it still reads as a one second video.
private enum GrownEngine: RenderEngine {
    static let name = "grown"
    static let size: Int64 = 110 * 1024 * 1024

    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        try await WriterEngine.encode(built, to: url, tmpDir: tmpDir, spec: spec, onProgress: onProgress)
        let handle = try FileHandle(forWritingTo: url)
        try handle.truncate(atOffset: UInt64(size))
        try handle.close()
    }
}

/// A session that met its limit by stopping: hands back `short`, a video the test made shorter than
/// the timeline, in place of the render.
private enum CutShortEngine: RenderEngine {
    static let name = "cut-short"
    static let short = FileManager.default.temporaryDirectory.appendingPathComponent("vk-cut-short.mp4")

    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        try? FileManager.default.removeItem(at: url)
        try FileManager.default.copyItem(at: short, to: url)
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

/// A render started through the registry, as `compose` starts one.
private enum Registry {
    /// Starts `spec` and answers `getState`'s answer once the render has ended.
    static func render(_ spec: ComposeSpec) async throws -> [String: Any] {
        JobRegistry.shared.start(spec: spec)
        for _ in 0..<1200 {
            if let state = JobRegistry.shared.stateJSON(spec.jobId),
               let name = state["state"] as? String, ["done", "failed", "interrupted"].contains(name) {
                return state
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw TestError("the render never ended")
    }
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
