@preconcurrency import AVFoundation
import Foundation
import os

/// The encode half of a render: one attempt at turning a built composition into the file at `url`.
///
/// Two engines conform. `WriterEngine` is the one every render starts with, because it is the one
/// that encodes at the rate the spec asks for; `PresetEngine` is `AVAssetExportSession`, kept as the
/// single fallback for an encoder that turns the writer's settings down. Neither decides anything
/// about retrying: an engine makes one attempt, and `Exporter` is where the second one is decided.
protocol RenderEngine {
    /// For the log, which is the only place the two are told apart once a render has finished.
    static var name: String { get }

    /// Writes the whole of `built` to `url`, reporting the fraction of the timeline reached as it
    /// goes. Throws `CancellationError` when the task is cancelled, and leaves nothing at `url`
    /// whenever it throws. A cancel too late to stop the file may be answered with the finished
    /// file instead; `Exporter` is what turns that into a cancel.
    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws
}

enum Exporter {

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Exporter")

    /// Encodes with the writer engine, falls back to the preset session once when the encoder turns
    /// the writer down, and describes the file that results.
    ///
    /// There is no size ceiling anywhere on this path, and that is the contract rather than an
    /// omission: `MAX_UPLOAD_BYTES` in `edit-manifest.ts` is one host's limit and "is NOT applied to
    /// anything here", and a host with a limit expresses it by the ladder rungs it offers. Android
    /// and the web engine encode at the spec's rates with no limit either.
    ///
    /// The fallback is Android's one relaxed retry (`VideoComposerPlugin.kt`, `onError`): an
    /// encoder that refuses the request is given one more go with settings it picks for itself. A
    /// preset is that here, and it picks its own bitrate, which is why the move is logged - the
    /// file it writes is not the rate the ladder asked for.
    ///
    /// `shouldStop` is asked before that retry, and it exists because `Task.isCancelled` answers too
    /// late. When the app is backgrounded the registry writes the stop reason synchronously inside
    /// the notification, but the cancellation of this task is a hop behind it. Without the
    /// predicate the first thing a backgrounded render could do is build an export session and a
    /// second Metal context and run them into the same wall, which burns the suspension window the
    /// registry needs to report `interrupted` at all.
    ///
    /// `engines` is the seam the tests use to make the first attempt fail on purpose; every real
    /// caller takes the default.
    static func export(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       shouldStop: @escaping @Sendable () -> Bool = { false },
                       engines: (first: RenderEngine.Type, fallback: RenderEngine.Type) = (WriterEngine.self, PresetEngine.self),
                       onProgress: @escaping @Sendable (Double) -> Void) async throws -> ComposeResult {
        var engine = engines.first
        do {
            try await engine.encode(built, to: url, tmpDir: tmpDir, spec: spec, onProgress: onProgress)
        } catch {
            guard !Task.isCancelled, !shouldStop(), isRetryable(error) else { throw error }
            log.error("\(engine.name, privacy: .public) was refused, encoding once more with \(engines.fallback.name, privacy: .public), which picks its own bitrate: \(ErrorMapping.describe(error), privacy: .public)")
            engine = engines.fallback
            try await engine.encode(built, to: url, tmpDir: tmpDir, spec: spec, onProgress: onProgress)
        }
        // A cancel that lands while the file is being closed finds nothing left to stop - the
        // writer's pass that moves the index to the front takes seconds on a long 4K file - and the
        // engine hands back a finished file. It is still a cancel: the contract's `cancel` "emits
        // `failed` with code `cancelled`", and Android writes exactly that the moment it is asked,
        // whatever its encoder was doing. The preset session already throws for a cancel during
        // its own closing pass, so this also makes the two engines agree.
        if Task.isCancelled {
            try? FileManager.default.removeItem(at: url)
            throw CancellationError()
        }
        // Neither engine promises to report 1. The registry clamps what it emits to 0.99 and lets
        // the `completed` event take the bar to 100.
        onProgress(1)

        let result = try await ResultBuilder.describe(url, spec: spec, jobId: spec.jobId, totalMs: built.totalMs)
        logDeliveredRate(result, spec: spec, engine: engine.name, totalMs: built.totalMs)
        return result
    }

    /// What landed on disk against what the ladder asked for. For the writer the two should agree
    /// to within what a variable rate spends on the content; for the preset fallback this line is
    /// the whole record of how far it strayed.
    private static func logDeliveredRate(_ result: ComposeResult, spec: ComposeSpec,
                                         engine: String, totalMs: Int64) {
        let seconds = Double(max(totalMs, result.durationMs)) / 1000
        guard seconds > 0 else { return }
        let delivered = Int64((Double(result.bytes) * 8 / seconds).rounded())
        log.info("export \(engine, privacy: .public) \(result.width)x\(result.height) \(result.durationMs) ms \(result.bytes) bytes, delivered \(delivered) bps against a ladder of \(spec.output.videoBitrate + spec.output.audioBitrate) bps")
    }

    /// Android retries `ENCODER_INIT_FAILED` and `ENCODING_FORMAT_UNSUPPORTED` once with relaxed
    /// settings, and these are the AVFoundation members of that family: no encoder for the request,
    /// the encoder busy, or the encoder refusing the settings - the last is what the writer throws
    /// when it turns a configuration down before the first frame, and what AVFoundation answers an
    /// append with when the encoder only finds out at the first sample. A failure to encode a frame
    /// the encoder had accepted is not retried, on either platform.
    private static func isRetryable(_ error: Error) -> Bool {
        guard let av = error as? AVError else { return false }
        switch av.code {
        case .encoderNotFound, .encoderTemporarilyUnavailable, .unsupportedOutputSettings:
            return true
        default:
            return false
        }
    }
}

/// `AVAssetExportSession` at the preset that matches the render size: the fallback, and the engine
/// every render used before `WriterEngine`.
///
/// A preset takes no bitrate, no key-frame interval and no profile, so the file it writes is the
/// preset's idea of the size rather than the spec's. It is kept because it is the one other door
/// AVFoundation has to the same composition, and an encoder that turns the writer's explicit
/// settings down can still take the settings a preset chooses for itself - the bet Android's
/// relaxed retry makes too.
enum PresetEngine: RenderEngine {

    static let name = "AVAssetExportSession"

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Exporter")

    /// Presets are "fits inside" boxes, not landscape boxes: a 720x1280 render size under
    /// `AVAssetExportPreset1280x720` comes out 720x1280. That is why the choice is made on the
    /// longer edge.
    static func preset(width: Int, height: Int) -> String {
        switch max(width, height) {
        case ...1280: return AVAssetExportPreset1280x720
        case ...1920: return AVAssetExportPreset1920x1080
        default: return AVAssetExportPresetHighestQuality
        }
    }

    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        // The session refuses to start when the output already exists. The writer removes its own
        // partial when it fails, so this is the belt to that brace.
        try? FileManager.default.removeItem(at: url)
        // "The export will fail if the URL points to a location that is not a directory, does not
        // exist, ..." - AVAssetExportSession.h on directoryForTemporaryFiles.
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

        let session = try session(for: built, spec: spec, tmpDir: tmpDir)
        log.info("\(session.presetName, privacy: .public) picks its own rate; the ladder asked for \(spec.output.videoBitrate) bps")

        // Unstructured on purpose, and therefore NOT cancelled when the render task is: the
        // sequence would otherwise keep the session alive past the export. Cancelled by the
        // `defer`, whichever way the export ends.
        let monitor = progressMonitor(session, onProgress: onProgress)
        defer { monitor.cancel() }
        do {
            // Cancelling the enclosing Task is what cancels the export: the back-deployed body
            // installs a withTaskCancellationHandler that calls cancelExport() and then throws
            // CancellationError, never an AVError. Never call cancelExport() by hand.
            try await session.export(to: url, as: .mp4)
        } catch {
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    /// The session, configured and not yet started.
    ///
    /// `fileLengthLimit` is left at its default of none, and deliberately: a limit is a host's
    /// policy, and a session that meets one stops writing and hands back a video cut short rather
    /// than a smaller one.
    static func session(for built: BuiltComposition, spec: ComposeSpec, tmpDir: URL) throws -> AVAssetExportSession {
        let presetName = preset(width: spec.output.width, height: spec.output.height)
        guard let session = AVAssetExportSession(asset: built.composition, presetName: presetName) else {
            throw ExportError.presetUnavailable
        }
        // Assigning an outputFileType outside supportedFileTypes raises an ObjC
        // NSInvalidArgumentException, which Swift cannot catch: it is a crash, not a throw.
        // export(to:as:) assigns it for us on the way in, so the check has to happen here.
        guard session.supportedFileTypes.contains(.mp4) else { throw ExportError.fileTypeUnsupported }

        // Both of these are declared `copy`, so the session takes an immutable snapshot and
        // mutating `built` after this line changes nothing.
        session.videoComposition = built.videoComposition
        session.audioMix = built.audioMix
        session.shouldOptimizeForNetworkUse = true       // moov atom first, the feed streams it
        session.timeRange = CMTimeRange(start: .zero, duration: ms(built.totalMs))
        session.directoryForTemporaryFiles = tmpDir
        // canPerformMultiplePassesOverSourceMediaData stays at its default false: a second pass
        // doubles an already slow export for quality the ladder never asked for.
        return session
    }

    /// How often the export is asked where it has got to, in seconds, on both of the paths below.
    private static let progressInterval: TimeInterval = 0.25

    /// Progress is the one thing in this engine that has no single spelling across the range of iOS
    /// the package supports. `states(updateInterval:)` reports a `Progress` the session keeps up to
    /// date; underneath it there is only the session's own `progress` property, read on a timer.
    /// Both paths deliver the same fractions to the same callback, so nothing above this function
    /// knows which one ran.
    private static func progressMonitor(_ session: AVAssetExportSession,
                                        onProgress: @escaping @Sendable (Double) -> Void) -> Task<Void, Never> {
        if #available(iOS 18.0, *) {
            return Task {
                for await state in session.states(updateInterval: progressInterval) {
                    guard case .exporting(let progress) = state else { continue }  // .pending and .waiting carry no number
                    let fraction = progress.fractionCompleted
                    if fraction.isFinite { onProgress(min(1, max(0, fraction))) }
                }
            }
        } else {
            // An `else` rather than an early return, so that the compiler knows this line is
            // reached only below 18 and the deprecated call below is not a warning in a host whose
            // own deployment target is 18 or later.
            return Task { await pollProgress(session, onProgress: onProgress) }
        }
    }

    /// The pre iOS 18 half of the pair above.
    ///
    /// It is marked deprecated at the same version as the two properties it reads, which is what
    /// keeps `status` and `progress` from warning on every build: a deprecated API used inside a
    /// declaration deprecated in the same release is not a diagnostic. The loop ends itself at a
    /// terminal status so that a caller who forgets to cancel it does not leave it spinning.
    @available(iOS, deprecated: 18.0, message: "states(updateInterval:) carries the progress from iOS 18")
    private static func pollProgress(_ session: AVAssetExportSession,
                                     onProgress: @escaping @Sendable (Double) -> Void) async {
        while !Task.isCancelled {
            switch session.status {
            case .completed, .failed, .cancelled:
                return
            case .exporting:
                let fraction = Double(session.progress)
                if fraction.isFinite { onProgress(min(1, max(0, fraction))) }
            default:
                break                                   // .unknown and .waiting carry no number
            }
            do {
                try await Task.sleep(nanoseconds: UInt64(progressInterval * 1_000_000_000))
            } catch {
                return                                  // cancelled mid sleep, which is the normal exit
            }
        }
    }
}

/// Reads the finished file back and turns it into the `completed` payload, after checking that the
/// file is as long as the timeline it was made from.
enum ResultBuilder {

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Exporter")

    /// `totalMs` is the composition's real duration (`BuiltComposition.totalMs`), which can be less
    /// than `spec.totalOutputMs` when a clip's `outMs` was clamped to its file. It is used for the
    /// truncation guard, and as the duration reported when the finished file cannot be measured.
    static func describe(_ url: URL, spec: ComposeSpec, jobId: String, totalMs: Int64) async throws -> ComposeResult {
        let probed = try? await Thumbnailer.probe(url)
        let bytes = Thumbnailer.fileBytes(url)
        let measured = probed?.durationMs ?? 0

        // How big the file is is not checked here or anywhere else in the package. A size ceiling
        // is the host's policy, expressed by the rungs it offers, and a render refused for its size
        // after the whole encode is a render the customer waited for and cannot have.

        // The truncation guard, and it only applies when the duration was actually measured: a
        // probe that failed tells us nothing about the file's length, and failing a good render on
        // the strength of a fallback number would be worse than shipping an unverified one.
        if measured > 0, abs(measured - totalMs) > 250 {
            log.error("export produced \(measured) ms against a \(totalMs) ms timeline")
            throw ExportError.truncated(produced: measured, expected: totalMs)
        }

        // Android's finalizeJob fallbacks, field for field: the plan's duration and the spec's
        // dimensions when the read-back says nothing useful. The plan's duration is `totalMs`, the
        // composition's real length, which is what Android's `plan.totalUs` is; the spec's
        // `totalOutputMs` is an upper bound for a disk estimate, and runs long whenever a clip's
        // trim was clamped to its file.
        let durationMs = measured > 0 ? measured : totalMs
        let width = (probed?.width ?? 0) > 0 ? probed!.width : spec.output.width
        let height = (probed?.height ?? 0) > 0 ? probed!.height : spec.output.height

        // Sibling of the render, which is the job folder, so this is the same file
        // `JobFolders.poster(batchId)` names whether the render is still the .part or has
        // already been moved to stitched.mp4.
        let posterURL = url.deletingLastPathComponent().appendingPathComponent("poster.jpg")
        let posterAt = min(spec.posterAtMs, max(0, durationMs - 1))
        // "" and never a black JPEG: JS reads `result.posterUri || undefined` and lets the server
        // cut its own, while a black poster becomes the post's thumbnail forever.
        let posterUri = await Thumbnailer.poster(from: url, atMs: posterAt, to: posterURL)
            ? posterURL.absoluteString : ""

        return ComposeResult(jobId: jobId, uri: url.absoluteString, posterUri: posterUri,
                             durationMs: durationMs, width: width, height: height, bytes: bytes)
    }
}

/// Everything that can go wrong on the way to a `failed` event, in one place, so the two platforms
/// tell the customer the same story about the same fault.
enum ErrorMapping {

    /// The order is load bearing. `ErrorMapping.kt` checks the disk-full cause chain before it even
    /// looks at what kind of throwable it has, because ENOSPC surfaces as an errno buried in a
    /// cause and never as its own code; our own stop reason goes above that, because a cancel must
    /// read as `cancelled` whatever AVFoundation threw on the way out.
    static func failure(for error: Error, stopReason: StopReason?) -> ComposeFailure {
        // 1. What WE decided, before anything the framework says.
        if let stopReason {
            switch stopReason {
            case .cancelled:
                return ComposeFailure(code: .cancelled, message: "cancelled")
            case .interrupted:
                return ComposeFailure(code: .interrupted, message: "did_enter_background")
            case .timeout:
                // Above the cancelled row on purpose: the stall watch cancels the task, so the
                // error arriving here is a CancellationError like any other.
                return ComposeFailure(code: .unknown, message: "timeout")
            }
        }
        // 2. Task cancellation with no stop reason: a torn-down parent, or a race we lost.
        if error is CancellationError {
            return ComposeFailure(code: .cancelled, message: "cancelled")
        }
        // 3. Our own build errors, which carry the clip key no AVError will ever have.
        if let build = error as? BuildError { return build.asFailure }
        // 4. Disk full, wherever it is hiding.
        if isOutOfSpace(error) {
            return ComposeFailure(code: .noSpace, message: describe(error),
                                  nativeCode: (error as NSError).code)
        }
        // 5. The AVError taxonomy.
        if let av = error as? AVError {
            // Match on the case, never on the raw value: the number moved between SDKs and the two
            // port sheets disagree about which it is.
            return ComposeFailure(code: code(for: av.code), message: describe(error),
                                  nativeCode: av.code.rawValue)
        }
        // 6. Our own export guards.
        if let export = error as? ExportError { return export.asFailure }
        // 7. Everything else.
        return ComposeFailure(code: .unknown, message: describe(error),
                              nativeCode: (error as NSError).code)
    }

    /// `failure(for:stopReason:)` for an error the encode threw, with the clip it happened in.
    ///
    /// Android attaches `blameClip(job)` to every `ExportException`. Here only an `unreadable_input`
    /// gets one, because that is the one code whose clip key JS acts on - it offers to pick that clip
    /// again - and the contract sets the key only "when the failure can be blamed on one clip". A
    /// decoder giving up can be; an encoder refusing a frame size or a full disk cannot, and naming
    /// whichever clip happened to be on screen would send the customer to replace a clip that was
    /// never the problem. A key the error already carries is kept.
    static func exportFailure(for error: Error, cursor: FrameCursor, spec: ComposeSpec) -> ComposeFailure {
        var failure = failure(for: error, stopReason: nil)
        if failure.code == .unreadableInput, failure.clipKey == nil {
            failure.clipKey = blamedClip(atUs: cursor.us, in: spec)
        }
        return failure
    }

    /// Android's `blameClip`: the last base clip that starts at or before `atUs`, or the first clip
    /// when no frame has been drawn yet.
    ///
    /// The clips are laid out from the spec with `totalOutputMs`'s arithmetic, each one's length
    /// scaled by its speed and rounded to the millisecond on its own, because that is the sum
    /// Android's `prefixOutUs` is. It runs long of the built composition only where a clip's trim
    /// ran past its file, which the editor's own trims never do. Past the base track's end, in a
    /// post stretched by `durationMs`, it is the last clip, as it is on Android.
    ///
    /// The layers are not asked. Android's blame reads the base clips alone, and a failure on a
    /// layer names the base clip under it on both platforms.
    ///
    /// It is a best guess in exactly Android's sense - right when the fault is in the clip being
    /// drawn - and on this platform it is a guess with a known blind side. AVFoundation reads ahead
    /// of the frame being drawn, and decodes the SOUND a long way ahead: a clip whose audio data is
    /// damaged was measured failing the render a tenth of a second in, while the clip before it was
    /// still on screen, and it is that earlier clip this names. Damaged picture data, in the same
    /// measurement, was concealed by the decoder and did not fail the render at all.
    static func blamedClip(atUs: Int64?, in spec: ComposeSpec) -> String? {
        guard let first = spec.clips.first else { return nil }
        guard let at = atUs, at > 0 else { return first.key }
        var blamed = first.key
        var startUs: Int64 = 0
        for clip in spec.clips {
            guard startUs <= at else { break }
            blamed = clip.key
            // The same isFinite gate `totalOutputMs` keeps: `Int64(Double.infinity)` traps.
            let scaled = Double(clip.outMs - clip.inMs) / clip.speed
            guard scaled.isFinite else { continue }
            startUs += Int64(scaled.rounded(.toNearestOrAwayFromZero)) * 1000
        }
        return blamed
    }

    /// The Android column of this table is `ExportException`'s code for the same customer-facing
    /// fault, so a render that fails on both platforms produces the same `code` on both.
    private static func code(for code: AVError.Code) -> ComposeFailureCode {
        switch code {
        case .diskFull:
            return .noSpace

        case .operationInterrupted, .mediaServicesWereReset, .sessionWasInterrupted:
            return .interrupted

        case .fileFormatNotRecognized, .failedToParse, .decodeFailed, .undecodableMediaData,
             .decoderNotFound, .decoderTemporarilyUnavailable, .contentIsProtected, .noSourceTrack,
             .invalidSourceMedia, .failedToLoadMediaData, .failedToLoadSampleData:
            return .unreadableInput

        case .encoderNotFound, .encoderTemporarilyUnavailable, .exportFailed, .encodeFailed,
             .invalidVideoComposition, .videoCompositorFailed, .unsupportedOutputSettings:
            return .encoder

        case .fileAlreadyExists, .fileTypeDoesNotSupportSampleReferences,
             .maximumNumberOfSamplesForFileFormatReached, .invalidOutputURLPathExtension:
            return .muxer

        case .formatUnsupported, .incompatibleAsset, .operationNotSupportedForAsset,
             .operationNotSupportedForPreset:
            return .unsupported

        case .operationCancelled:
            return .cancelled

        default:
            return .unknown
        }
    }

    /// `"<domain> <code>: <localizedDescription>"`, plus the same again for the first underlying
    /// error. Mirrors `ErrorMapping.describe` on Android, and it is what the customer-facing copy
    /// ends up quoting, so keep it one line.
    static func describe(_ error: Error) -> String {
        let e = error as NSError
        let head = "\(e.domain) \(e.code): \(e.localizedDescription)"
        guard let cause = e.userInfo[NSUnderlyingErrorKey] as? NSError else { return head }
        return "\(head) (caused by \(cause.domain) \(cause.code): \(cause.localizedDescription))"
    }

    /// Mirrors `ErrorMapping.hasNoSpaceCause`. The errno hides in a cause rather than in the error
    /// AVFoundation hands back, so walk the chain, bounded the way Android bounds it.
    static func isOutOfSpace(_ error: Error) -> Bool {
        var current: NSError? = error as NSError
        var depth = 0
        while let e = current, depth < 12 {                     // MAX_CAUSE_DEPTH = 12
            if e.domain == AVFoundationErrorDomain, e.code == AVError.Code.diskFull.rawValue { return true }
            if e.domain == NSCocoaErrorDomain, e.code == NSFileWriteOutOfSpaceError { return true }
            if e.domain == NSPOSIXErrorDomain, e.code == Int(ENOSPC) { return true }
            let text = e.localizedDescription
            if text.contains("ENOSPC") || text.range(of: "No space left", options: .caseInsensitive) != nil {
                return true
            }
            current = e.userInfo[NSUnderlyingErrorKey] as? NSError
            depth += 1
        }
        return false
    }
}
