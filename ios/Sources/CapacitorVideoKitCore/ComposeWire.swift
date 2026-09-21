import Foundation

/// Everything that travels back out to JS, plus the two error types the render pipeline throws on
/// its way there.
///
/// Two rules hold for every payload built in this file and they are the reason the builders are
/// written out by hand rather than derived from `Encodable`:
///
/// 1. An absent optional is an ABSENT KEY, never a `null`. Android builds each payload with
///    `value?.let { put(key, it) }` and JS reads `event.clipKey ? ...`, so the two behave the same
///    for a missing key and for `undefined`.
/// 2. Nothing optional and nothing non-finite may enter the dictionary. `out["k"] = someOptional`
///    compiles and inserts a boxed nil, which fails `JSONSerialization.isValidJSONObject` inside
///    `PluginCallResult` and kills the entire call with no diagnostic. Always `if let`.

/// `job.state.name.lowercase()` on Android. The raw values are spelled out so that renaming a case
/// cannot silently change the wire.
enum JobState: String, Sendable { case pending, rendering, interrupted, done, failed }

/// What WE decided about a stopped render, recorded before AVFoundation threw anything. It is read
/// FIRST when a failure is classified, because a user cancel and a wall-clock timeout both surface
/// as a `CancellationError` and only this tells them apart.
enum StopReason: Sendable { case cancelled, interrupted, timeout }

/// Exactly the eight strings of the TypeScript `ComposeFailureCode` union.
enum ComposeFailureCode: String, Sendable {
    case unreadableInput = "unreadable_input"
    case encoder, muxer, interrupted, cancelled
    case noSpace = "no_space"
    case unsupported, unknown
}

struct ComposeResult: Sendable {
    let jobId: String
    let uri: String            // url.absoluteString
    /// "" when no frame could be cut, never null and never absent. JS does `posterUri || undefined`
    /// and lets the server cut its own thumbnail; a black placeholder JPEG would instead become the
    /// post's thumbnail forever.
    let posterUri: String
    let durationMs: Int64
    /// DISPLAY dimensions, read back off the finished file with its rotation already applied, not
    /// the requested output size.
    let width: Int
    let height: Int
    let bytes: Int64

    /// All seven keys, always present.
    var json: [String: Any] {
        [
            "jobId": jobId,
            "uri": uri,
            "posterUri": posterUri,
            "durationMs": durationMs,
            "width": width,
            "height": height,
            "bytes": bytes,
        ]
    }
}

struct ComposeFailure: Error, Sendable {
    let code: ComposeFailureCode
    let message: String
    var nativeCode: Int? = nil
    var clipKey: String? = nil
    /// The SHORTFALL, `needed - available`, and only on `no_space`. Not the total need: JS shows it
    /// as "free up N more".
    var needBytes: Int64? = nil

    /// `jobId` is a required field of the TypeScript `ComposeError`, including on the nested `error`
    /// inside a `getState` answer, so it is a parameter rather than an optional stored property.
    func json(jobId: String) -> [String: Any] {
        var out: [String: Any] = ["jobId": jobId, "code": code.rawValue, "message": message]
        if let n = nativeCode { out["nativeCode"] = n }
        if let k = clipKey { out["clipKey"] = k }
        if let b = needBytes { out["needBytes"] = b }
        return out
    }
}

/// Thrown by `CompositionBuilder`, `OverlayBitmap` and `RenderPlan`, i.e. by everything that runs
/// before a single frame is encoded.
enum BuildError: Error {
    case unreadable(String, String)   // (clipKey | "music" | "voiceover", detail)
    case invalidOverlay(String)       // overlay id
    case internalFailure(String)

    var asFailure: ComposeFailure {
        switch self {
        case .unreadable(let key, let detail):
            return ComposeFailure(code: .unreadableInput, message: detail, clipKey: key)
        case .invalidOverlay(let id):
            // `unknown`, not `unreadable_input`: an overlay is a bitmap the caller rasterised, not
            // an input file, and Android reports it this way. JS uses `unreadable_input` to offer
            // "pick that clip again", which would be the wrong offer here.
            return ComposeFailure(code: .unknown, message: "overlay \(id) could not be decoded")
        case .internalFailure(let what):
            return ComposeFailure(code: .unknown, message: what)
        }
    }
}

/// Thrown by `Exporter`. Every case here is an iOS-only guard around `AVAssetExportSession`, which
/// takes a preset rather than a bitrate and therefore has failure modes Android does not have.
enum ExportError: Error {
    case presetUnavailable
    case fileTypeUnsupported
    case overCap(bytes: Int64)                             // guard G1
    case tooLongForPreset(maxMs: Int64, neededMs: Int64)
    case truncated(produced: Int64, expected: Int64)
    case timedOut

    var asFailure: ComposeFailure {
        switch self {
        case .presetUnavailable:
            return ComposeFailure(code: .unsupported, message: "preset_unavailable")
        case .fileTypeUnsupported:
            return ComposeFailure(code: .unsupported, message: "mp4_unsupported")
        case .overCap(let bytes):
            return ComposeFailure(code: .unsupported, message: "output_over_cap bytes=\(bytes) limit=104857600")
        case .tooLongForPreset(let maxMs, let neededMs):
            return ComposeFailure(code: .unsupported,
                                  message: "timeline_too_long_for_preset max=\(maxMs) need=\(neededMs)")
        case .truncated(let produced, let expected):
            // The container closed cleanly and is short, which is an encoder that stopped early
            // rather than a muxer that could not write.
            return ComposeFailure(code: .encoder, message: "truncated \(produced)/\(expected)")
        case .timedOut:
            return ComposeFailure(code: .unknown, message: "timeout")
        }
    }
}

/// Android's companion object, verbatim. These are `code`, the SECOND argument to `call.reject`,
/// and JS switches on them, so they are not free text.
enum Reject {
    static let invalidSpec = "invalid_spec"
    static let jobNotFound = "job_not_found"
    static let unreadableInput = "unreadable_input"
    static let permissionDenied = "permission_denied"
    static let notRecording = "not_recording"
    static let recordingFailed = "recording_failed"
    static let alreadyRecording = "already_recording"
    static let io = "io"
    static let noSpace = "no_space"
    static let unsupportedUri = "unsupported_uri"
    static let fileMissing = "file_missing"
    static let invalidRequest = "invalid_request"
    static let notFound = "not_found"
}

/// Retention is what makes the editor's "add listeners, then call compose" pattern safe: a two
/// second clip can finish before the listener is attached, and a retained event is still delivered.
/// Progress is deliberately not retained, because a stale progress number arriving after a
/// `completed` would walk the bar backwards.
enum ComposeEvent {
    static let progress = "progress"      // retain FALSE
    static let completed = "completed"    // retain TRUE
    static let failed = "failed"          // retain TRUE
}

enum PublishEvent {
    static let progress = "publishProgress"   // retain FALSE
    static let finished = "publishFinished"   // retain TRUE
    static let failed = "publishFailed"       // retain TRUE
}
