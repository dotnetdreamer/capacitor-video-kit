@preconcurrency import AVFoundation
import Foundation
import os

/// The encode half of a render, behind a protocol so the preset engine can be swapped for an
/// `AVAssetWriter` one without touching the registry.
///
/// The trigger for building that second conformance is written down rather than left to taste:
/// when the delivered rate logged below is more than 1.5x the ladder on a real device, when the
/// 100 MiB cap fires on a timeline the product considers normal, or when the ladder has to be
/// honoured literally for parity with Android, which sets the bitrate on the encoder directly.
protocol RenderEngine {
    /// `shouldStop` is part of the contract rather than an Exporter detail: any engine has a point
    /// where it decides to try again, and every engine has to stop deciding that once the app is on
    /// its way to the background.
    static func export(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       shouldStop: @escaping @Sendable () -> Bool,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws -> ComposeResult
}

enum Exporter: RenderEngine {

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Exporter")

    /// 0.9 of the app's own 100 MiB upload ceiling. Apple documents this as a limit the session
    /// aims at and tells you to test the output, never as rate control, so it is a belt beside the
    /// two braces in `ResultBuilder.describe` rather than the thing that keeps files small.
    static let fileLengthLimit: Int64 = 94_371_840

    /// `media.service.ts` and `video-record.component.ts` both refuse anything over this
    /// client-side, so a render above it cannot be posted at all. A clean failure is recoverable
    /// through the flow's "post the originals" path; an oversized success is not.
    static let hardCapBytes: Int64 = 104_857_600

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

    /// Android retries an encoder refusal once with `VideoEncoderSettings.DEFAULT`, which lets the
    /// factory pick its own size and rate. A preset session has no settings to relax, so the
    /// equivalent move is stepping the preset down once.
    static func fallbackPreset() -> String { AVAssetExportPresetMediumQuality }

    /// `shouldStop` is asked before the one retry, and it exists because `Task.isCancelled` answers
    /// too late. When the app is backgrounded the registry writes the stop reason synchronously
    /// inside the notification, but the cancellation of this task is a hop behind it. Without the
    /// predicate the first thing a backgrounded render does is build a second export session and a
    /// second Metal context and run them into the same wall, which burns the suspension window the
    /// registry needs to report `interrupted` at all - `.exportFailed` is both what a backgrounded
    /// export throws and a member of `isRetryable`.
    static func export(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       shouldStop: @escaping @Sendable () -> Bool = { false },
                       onProgress: @escaping @Sendable (Double) -> Void) async throws -> ComposeResult {
        var attempt = 0
        while true {
            attempt += 1
            let presetName = attempt == 1
                ? preset(width: spec.output.width, height: spec.output.height)
                : fallbackPreset()

            // The session refuses to start when the output already exists, and a partial from the
            // previous attempt is exactly the case this loop creates.
            try? FileManager.default.removeItem(at: url)
            // "The export will fail if the URL points to a location that is not a directory, does
            // not exist, ..." - AVAssetExportSession.h on directoryForTemporaryFiles.
            try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

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
            session.fileLengthLimit = fileLengthLimit
            session.timeRange = CMTimeRange(start: .zero, duration: ms(built.totalMs))
            session.directoryForTemporaryFiles = tmpDir
            // canPerformMultiplePassesOverSourceMediaData stays at its default false: a second pass
            // doubles an already slow export for quality the ladder never asked for.

            try await checkDurationFits(session, totalMs: built.totalMs, preset: presetName)

            // Unstructured on purpose, and therefore NOT cancelled when the render task is: the
            // sequence would otherwise keep the session alive past the export. Cancelled by hand on
            // both paths below.
            let monitor = progressMonitor(session, onProgress: onProgress)

            do {
                // Cancelling the enclosing Task is what cancels the export: the back-deployed body
                // installs a withTaskCancellationHandler that calls cancelExport() and then throws
                // CancellationError, never an AVError. Never call cancelExport() by hand.
                try await session.export(to: url, as: .mp4)
                monitor.cancel()
                // The sequence can end without ever reporting 1. The registry clamps what it emits
                // to 0.99 and lets the `completed` event take the bar to 100.
                onProgress(1)

                let result = try await ResultBuilder.describe(url, spec: spec, jobId: spec.jobId,
                                                              totalMs: built.totalMs)
                logDeliveredRate(result, spec: spec, preset: presetName, totalMs: built.totalMs)
                return result
            } catch {
                monitor.cancel()
                if attempt == 1, !Task.isCancelled, !shouldStop(), isRetryable(error) {
                    log.error("export failed on \(presetName, privacy: .public), retrying once with the fallback preset: \(ErrorMapping.describe(error), privacy: .public)")
                    continue
                }
                throw error
            }
        }
    }

    /// How often the export is asked where it has got to, in seconds, on both of the paths below.
    private static let progressInterval: TimeInterval = 0.25

    /// Progress is the one thing in this file that has no single spelling across the range of iOS
    /// the package supports. `states(updateInterval:)` is the whole reason a floor above 18 was
    /// ever written down, and it reports a `Progress` the session keeps up to date; underneath it
    /// there is only the session's own `progress` property, read on a timer. Both paths deliver the
    /// same fractions to the same callback, so nothing above this function knows which one ran.
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

    /// `fileLengthLimit` is a ceiling, not a bitrate control, so a long timeline can come back
    /// truncated at the limit instead of encoded smaller. The estimate is the one place the session
    /// will say so BEFORE spending two minutes producing half a video.
    ///
    /// An estimate the session declines to make (an indefinite CMTime, or an error) allows the
    /// export, the same way an unreadable free-space figure allows a job.
    private static func checkDurationFits(_ session: AVAssetExportSession, totalMs: Int64,
                                          preset: String) async throws {
        guard totalMs > 0 else { return }
        // The `try?` covers the estimate's own failure only; the ExportError below is thrown after
        // it, where nothing can swallow it.
        guard let estimate = try? await session.estimatedMaximumDuration, estimate.isNumeric else { return }
        let seconds = estimate.seconds
        guard seconds.isFinite else { return }
        let needed = Double(totalMs) / 1000
        // One percent of slack: the estimate is an estimate, and refusing a render that would have
        // fitted is the worse error of the two.
        guard seconds < needed * 0.99 else { return }
        let maxMs = Int64((seconds * 1000).rounded())
        log.error("preset \(preset, privacy: .public) can only carry \(maxMs) ms under a \(fileLengthLimit) byte limit, timeline is \(totalMs) ms")
        throw ExportError.tooLongForPreset(maxMs: maxMs, neededMs: totalMs)
    }

    /// Guard G2, and the only measurement that can decide whether the writer engine is worth
    /// building: the preset picks its own rate, so this is the difference between what the ladder
    /// asked for and what landed on disk.
    private static func logDeliveredRate(_ result: ComposeResult, spec: ComposeSpec,
                                         preset: String, totalMs: Int64) {
        let seconds = Double(max(totalMs, result.durationMs)) / 1000
        guard seconds > 0 else { return }
        let delivered = Int64((Double(result.bytes) * 8 / seconds).rounded())
        log.info("export \(preset, privacy: .public) \(result.width)x\(result.height) \(result.durationMs) ms \(result.bytes) bytes, delivered \(delivered) bps against a ladder of \(spec.output.videoBitrate + spec.output.audioBitrate) bps")
    }

    /// Android retries `ENCODER_INIT_FAILED` and `ENCODING_FORMAT_UNSUPPORTED` once with relaxed
    /// settings. These are the AVFoundation members of that family, plus `.exportFailed`, which is
    /// the one transient export failure that has been seen to succeed on a second run.
    private static func isRetryable(_ error: Error) -> Bool {
        guard let av = error as? AVError else { return false }
        switch av.code {
        case .exportFailed, .encoderNotFound, .encoderTemporarilyUnavailable, .unsupportedOutputSettings:
            return true
        default:
            return false
        }
    }
}

/// Reads the finished file back and turns it into the `completed` payload, applying the two guards
/// that stand in for a bitrate the preset engine cannot set.
enum ResultBuilder {

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Exporter")

    /// `totalMs` is the composition's real duration (`BuiltComposition.totalMs`), which can be less
    /// than `spec.totalOutputMs` when a clip's `outMs` was clamped to its file. It is used for the
    /// truncation guard and for nothing else.
    static func describe(_ url: URL, spec: ComposeSpec, jobId: String, totalMs: Int64) async throws -> ComposeResult {
        let probed = try? await Thumbnailer.probe(url)
        let bytes = Thumbnailer.fileBytes(url)
        let measured = probed?.durationMs ?? 0

        // Guard G1. Checked before the poster is cut, because a file this size is not going to be
        // posted whatever its first frame looks like.
        if bytes > Exporter.hardCapBytes { throw ExportError.overCap(bytes: bytes) }

        // The truncation guard, and it only applies when the duration was actually measured: a
        // probe that failed tells us nothing about the file's length, and failing a good render on
        // the strength of a fallback number would be worse than shipping an unverified one.
        if measured > 0, abs(measured - totalMs) > 250 {
            log.error("export produced \(measured) ms against a \(totalMs) ms timeline")
            throw ExportError.truncated(produced: measured, expected: totalMs)
        }

        // Android's finalizeJob fallbacks, field for field: the plan's duration and the spec's
        // dimensions when the read-back says nothing useful.
        let durationMs = measured > 0 ? measured : spec.totalOutputMs
        let width = (probed?.width ?? 0) > 0 ? probed!.width : spec.output.width
        let height = (probed?.height ?? 0) > 0 ? probed!.height : spec.output.height

        // Sibling of the render, which is the job folder, so this is the same file
        // `JobFolders.poster(pendingPostId)` names whether the render is still the .part or has
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
                // Above the cancelled row on purpose: the wall-clock budget cancels the task, so
                // the error arriving here is a CancellationError like any other.
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
            let message = av.code == .maximumFileSizeReached ? "file_length_limit" : describe(error)
            return ComposeFailure(code: code(for: av.code), message: message,
                                  nativeCode: av.code.rawValue)
        }
        // 6. Our own export guards.
        if let export = error as? ExportError { return export.asFailure }
        // 7. Everything else.
        return ComposeFailure(code: .unknown, message: describe(error),
                              nativeCode: (error as NSError).code)
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

        // Not a container write failure, whatever the file-size wording suggests: the muxer did its
        // job and the encoder was handed a budget it could not meet. Seeing this is the strongest
        // signal there is that the writer engine needs building.
        case .maximumFileSizeReached:
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
