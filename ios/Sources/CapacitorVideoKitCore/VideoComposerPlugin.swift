import Capacitor
import Foundation
import UIKit
import VideoToolbox

/// The bridge surface of the video composer. Argument reading, rejections and event forwarding
/// only: every decision lives in `ComposeSpecParser`, `JobRegistry`, `JobFolders`, `Thumbnailer` or
/// `VoiceRecorder`, so this file stays readable next to the Kotlin it mirrors.
///
/// Capacitor calls each `@objc func` on its own serial queue, shared with every other plugin in the
/// app and never main, so nothing here does file or AV work inline: a method either answers from
/// memory or hands off to a `Task`. The one exception is `systemInsets`, which has to hop to main
/// because UIKit says so.
@objc(VideoComposerPlugin)
public class VideoComposerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoComposerPlugin"
    public let jsName = "VideoComposer"

    /// Fifteen entries. A method missing from this list is rejected by the bridge before this class
    /// is consulted, which is exactly what used to happen to `systemInsets`: the `@objc func` alone
    /// changes nothing. `addListener` / `removeListener` / `removeAllListeners` are special-cased
    /// by `CapacitorBridge.handleJSCall` before the list is read and stay off it.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "compose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "thumbnails", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extractAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteSound", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startVoiceRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopVoiceRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encodeSupport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "systemInsets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise),
    ]

    /// Android reads 160 from `call.getInt("maxHeight") ?: 160`; the editor relies on the default
    /// because its filmstrip never sends one.
    private static let defaultThumbnailHeight = 160

    override public func load() {
        // The registry outlives this instance. `load()` runs again on every WebView reload, and
        // `attach` is where an outcome that finished while no bridge was up gets replayed.
        JobRegistry.shared.attach(emitter: self)
        JobFolders.sweepOnLaunch()
    }

    deinit {
        JobRegistry.shared.detach(self)
        // A page reload in the middle of a take must not leave the microphone open.
        Task { await VoiceRecorder.shared.abandon() }
    }

    /// The registry's only way back to JS. `completed` and `failed` are retained until consumed, so
    /// an outcome that lands while the editor is being rebuilt is handed to the next listener.
    func emit(_ name: String, _ data: [String: Any], retain: Bool) {
        notifyListeners(name, data: data, retainUntilConsumed: retain)
    }

    // MARK: - compose

    @objc func compose(_ call: CAPPluginCall) {
        let spec: ComposeSpec
        do {
            spec = try ComposeSpecParser.parse(call)
        } catch let error as SpecError {
            call.reject(error.message, Reject.invalidSpec)
            return
        } catch {
            call.reject(error.localizedDescription, Reject.invalidSpec)
            return
        }

        // `jobId` is the contract's idempotency key: composing twice with one id starts one render.
        // Presence is the whole test, whatever state that job is in, and the answer is the same
        // payload a fresh compose gives. Rejecting here would be worse than useless - the app's
        // only real caller turns ANY compose rejection into "we could not build your video", so a
        // safe retry would read as a failure to the customer.
        guard !JobRegistry.shared.exists(spec.jobId) else {
            call.resolve(["jobId": spec.jobId])
            return
        }

        // The task is created inside `start`, before this call resolves, so a cancel arriving in
        // the next microsecond has something to cancel.
        JobRegistry.shared.start(spec: spec)
        call.resolve(["jobId": spec.jobId])

        // Everything that can still go wrong arrives as a `failed` EVENT. A malformed spec is a bug
        // in the caller; a render that cannot finish is an outcome, and the two are not reported
        // through the same channel.
    }

    // MARK: - cancel, getState

    @objc func cancel(_ call: CAPPluginCall) {
        guard let jobId = call.getString("jobId"), !jobId.isEmpty else {
            call.reject("jobId is required", Reject.invalidSpec)
            return
        }
        Task {
            // Awaited on purpose: JS calls `cleanup` the moment this resolves, and a directory
            // delete racing an export that is still flushing leaves a folder that will not go away.
            await JobRegistry.shared.cancel(jobId, reason: .cancelled)
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        guard let jobId = call.getString("jobId"), !jobId.isEmpty else {
            call.reject("jobId is required", Reject.invalidSpec)
            return
        }
        guard let state = JobRegistry.shared.stateJSON(jobId) else {
            // The documented signal that the process restarted. JS then starts over from its own
            // persisted manifest with a new jobId.
            call.reject("no job with id \(jobId)", Reject.jobNotFound)
            return
        }
        call.resolve(state)
    }

    // MARK: - probe, thumbnails

    @objc func probe(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        guard let url = JobFolders.fileURL(from: uri) else {
            call.reject("unreadable uri \(uri)", Reject.unreadableInput)
            return
        }
        Task {
            do {
                let result = try await Thumbnailer.probe(url)
                call.resolve(result.json)
            } catch {
                call.reject(ErrorMapping.describe(error), Reject.unreadableInput)
            }
        }
    }

    @objc func thumbnails(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        // An EMPTY array is legal and answers an empty `uris`; only an absent key is an error.
        guard let requested = call.getArray("timesMs") else {
            call.reject("timesMs is required", Reject.invalidSpec)
            return
        }
        guard let url = JobFolders.fileURL(from: uri) else {
            call.reject("unreadable uri \(uri)", Reject.unreadableInput)
            return
        }

        // Android reads each entry as a long that defaults to 0 and coerces to at least 0, so a
        // negative or non-numeric entry becomes the first frame rather than an error. The filmstrip
        // would rather show something.
        let timesMs: [Int64] = requested.map { value in
            guard let number = value as? NSNumber else { return 0 }
            return max(0, number.int64Value)
        }
        let maxHeight = call.getInt("maxHeight") ?? Self.defaultThumbnailHeight
        let precise = call.getBool("precise") ?? false

        Task {
            do {
                let urls = try await Thumbnailer.thumbnails(url,
                                                            timesMs: timesMs,
                                                            maxHeight: maxHeight,
                                                            precise: precise)
                call.resolve(["uris": urls.map { $0.absoluteString }])
            } catch {
                call.reject(ErrorMapping.describe(error), Reject.unreadableInput)
            }
        }
    }

    // MARK: - Sound library

    @objc func extractAudio(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        guard let url = JobFolders.fileURL(from: uri) else {
            call.reject("unreadable uri \(uri)", Reject.unreadableInput)
            return
        }
        let fileName = call.getString("fileName")
        let keep = call.getBool("keep") ?? true

        Task {
            do {
                guard let sound = try await SoundLibrary.extract(from: url, fileName: fileName, keep: keep) else {
                    // No audio track. A normal answer about a normal file, so it resolves rather
                    // than rejecting: the editor says so plainly and stays where it is.
                    call.resolve(["hasAudio": false])
                    return
                }
                var json = Self.soundJson(sound)
                json["hasAudio"] = true
                call.resolve(json)
            } catch let error as SoundLibrary.SoundError {
                switch error {
                case let .noSpace(needed, free):
                    call.reject("no_space need=\(needed) free=\(free)", Reject.noSpace)
                case let .exportFailed(message):
                    call.reject(message, Reject.unreadableInput)
                }
            } catch {
                call.reject(ErrorMapping.describe(error), Reject.unreadableInput)
            }
        }
    }

    @objc func listSounds(_ call: CAPPluginCall) {
        Task {
            call.resolve(["sounds": SoundLibrary.list().map { Self.soundJson($0) }])
        }
    }

    @objc func deleteSound(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required", Reject.invalidSpec)
            return
        }
        Task {
            SoundLibrary.delete(id: id)
            call.resolve()
        }
    }

    /// One sound, in the shape `SavedSoundResult` describes. `hasAudio` is the caller's to add.
    private static func soundJson(_ sound: SoundLibrary.Sound) -> [String: Any] {
        var json: [String: Any] = [
            "id": sound.id,
            "uri": sound.url.absoluteString,
            "fileName": sound.fileName,
            "durationMs": sound.durationMs,
            "savedAt": sound.savedAt,
        ]
        if let sourceName = sound.sourceName { json["sourceName"] = sourceName }
        return json
    }

    // MARK: - Voice

    @objc func startVoiceRecording(_ call: CAPPluginCall) {
        let requested = call.getString("pendingPostId")
        let pendingPostId = (requested?.isEmpty ?? true) ? nil : requested
        Task {
            do {
                // The permission prompt happens inside this one await, so the JS promise still
                // settles exactly once whether or not the customer is asked.
                try await VoiceRecorder.shared.start(pendingPostId: pendingPostId)
                call.resolve()
            } catch let error as VoiceError {
                switch error {
                case .alreadyRecording:
                    call.reject("already_recording", Reject.alreadyRecording)
                case .permissionDenied:
                    call.reject("microphone permission denied", Reject.permissionDenied)
                default:
                    call.reject("recording_failed", Reject.recordingFailed)
                }
            } catch {
                call.reject("recording_failed", Reject.recordingFailed)
            }
        }
    }

    @objc func stopVoiceRecording(_ call: CAPPluginCall) {
        Task {
            do {
                let take = try await VoiceRecorder.shared.stop()
                call.resolve(["uri": take.url.absoluteString, "durationMs": take.durationMs])
            } catch let error as VoiceError {
                switch error {
                case .notRecording:
                    call.reject("not recording", Reject.notRecording)
                default:
                    call.reject("recording_failed", Reject.recordingFailed)
                }
            } catch {
                call.reject("recording_failed", Reject.recordingFailed)
            }
        }
    }

    // MARK: - capabilities, systemInsets

    @objc func capabilities(_ call: CAPPluginCall) {
        // `avc1` with no profile, matching Android, because the preset exporter does not set one
        // and cannot promise High 4.0. The lab compares this string across the two platforms
        // literally, so it becomes `avc1.640028` on the day the AVAssetWriter engine lands and not
        // a moment sooner.
        call.resolve([
            "supported": true,
            "videoCodec": "avc1",
            "audioCodec": "mp4a.40.2",
            "container": "mp4",
            "voiceRecording": true,
        ])
    }

    /// Which of the frames an editor would like to offer this device's encoder will actually take.
    ///
    /// iOS has no table to read, unlike Android's `MediaCodecInfo`: the only honest way to find out
    /// whether VideoToolbox will encode 4K60 on THIS device is to ask it for that encoder and see
    /// whether it hands one over. So that is what happens - a compression session is created at the
    /// size and thrown away again, which allocates nothing on the GPU because no frame is ever fed
    /// to it and takes well under a millisecond per rung.
    ///
    /// The rate is not part of what a session is created with, so a frame's `fps` is carried
    /// through untouched rather than probed: an encoder that takes a size takes it at both rates on
    /// every device Apple ships, and the expensive half of 60 fps is the number of frames rather
    /// than the encoder's willingness to accept them.
    ///
    /// Never rejects. A frame this device will not take is a row that says so, with a sentence for
    /// the customer, which is what the ladder greys out.
    @objc func encodeSupport(_ call: CAPPluginCall) {
        let frames = call.getArray("frames", JSObject.self) ?? []
        var answers: [JSObject] = []
        for frame in frames {
            let width = frame["width"] as? Int ?? 0
            let height = frame["height"] as? Int ?? 0
            let fps = frame["fps"] as? Int ?? 30
            var answer: JSObject = ["width": width, "height": height, "fps": fps]
            if width <= 0 || height <= 0 {
                answer["supported"] = false
                answer["reason"] = "That is not a frame."
            } else if canEncode(width: width, height: height) {
                answer["supported"] = true
            } else {
                answer["supported"] = false
                answer["reason"] = "\(min(width, height))P is more than this device's encoder can take."
            }
            answers.append(answer)
        }
        call.resolve(["frames": answers])
    }

    /// Whether VideoToolbox will give us an H.264 encoder at this size, asked by asking for one.
    ///
    /// The session is invalidated straight away: it is the CREATION that answers the question, and
    /// a session left open holds an encoder the rest of the system could be using.
    private func canEncode(width: Int, height: Int) -> Bool {
        var session: VTCompressionSession?
        let status = VTCompressionSessionCreate(
            allocator: kCFAllocatorDefault,
            width: Int32(width),
            height: Int32(height),
            codecType: kCMVideoCodecType_H264,
            encoderSpecification: nil,
            imageBufferAttributes: nil,
            compressedDataAllocator: nil,
            outputCallback: nil,
            refcon: nil,
            compressionSessionOut: &session)
        if let session {
            VTCompressionSessionInvalidate(session)
        }
        return status == noErr && session != nil
    }

    /// How much of the WebView the system bars actually cover.
    ///
    /// `UIView.safeAreaInsets` IS the overlap of the safe area with that view's own bounds, which
    /// is the semantics the contract asks for: a WebView laid out clear of the bars reports 0 and
    /// the editor never double-pads. Android has no per-view safe area and computes the overlap by
    /// hand against the decor view, and it divides by `displayMetrics.density` - on iOS one CSS
    /// pixel IS one point, so there is nothing to divide and nothing to port.
    @objc func systemInsets(_ call: CAPPluginCall) {
        // `.async` and never `.sync`: a main-thread wait from the Capacitor queue deadlocks.
        DispatchQueue.main.async { [weak self] in
            guard let view: UIView = self?.bridge?.webView ?? self?.bridge?.viewController?.view else {
                // No view is not an error. The editor falls back to its own env() padding, which is
                // right often enough, and a rejection here would be noise in every log.
                call.resolve(["top": 0, "bottom": 0])
                return
            }
            let insets = view.safeAreaInsets
            call.resolve(["top": Double(insets.top), "bottom": Double(insets.bottom)])
        }
    }

    // MARK: - prepareJob, cleanup

    @objc func prepareJob(_ call: CAPPluginCall) {
        guard let pendingPostId = call.getString("pendingPostId"), !pendingPostId.isEmpty else {
            call.reject("pendingPostId is required", Reject.invalidSpec)
            return
        }
        guard let raw = call.getArray("inputs") else {
            call.reject("inputs is required", Reject.invalidSpec)
            return
        }

        var inputs: [(key: String, uri: String)] = []
        inputs.reserveCapacity(raw.count)
        for (index, element) in raw.enumerated() {
            // An element that is not an object at all is skipped, matching Android's
            // `optJSONObject(i) ?: continue`; an object missing a field is a caller bug and says so.
            var object: [String: Any]?
            if let typed = element as? JSObject { object = typed }
            else if let loose = element as? [String: Any] { object = loose }
            guard let object else { continue }

            guard let key = object["key"] as? String, !key.isEmpty,
                  let uri = object["uri"] as? String, !uri.isEmpty else {
                call.reject("inputs[\(index)] needs a key and a uri", Reject.invalidSpec)
                return
            }
            inputs.append((key: key, uri: uri))
        }

        Task {
            do {
                let prepared = try JobFolders.prepareJob(pendingPostId: pendingPostId, inputs: inputs)
                // Keys are echoed back exactly as they came in, never sanitised: JS maps its
                // manifest by the key it sent. Only the file name on disk is sanitised.
                call.resolve([
                    "jobDir": prepared.jobDir.absoluteString,
                    "inputs": prepared.inputs.map { ["key": $0.key, "uri": $0.uri] },
                ])
            } catch let failure as PrepareFailure {
                call.reject(failure.message, failure.code)
            } catch {
                call.reject("could not place inputs for \(pendingPostId): \(error.localizedDescription)",
                            Reject.io)
            }
        }
    }

    @objc func cleanup(_ call: CAPPluginCall) {
        guard let pendingPostId = call.getString("pendingPostId"), !pendingPostId.isEmpty else {
            call.reject("pendingPostId is required", Reject.invalidSpec)
            return
        }
        Task {
            // Cancels every job for the post with its events suppressed, forgets them so a later
            // `getState` answers `job_not_found`, and only then deletes the folder. Idempotent: a
            // folder that was never created resolves just the same.
            await JobRegistry.shared.cleanup(pendingPostId: pendingPostId)
            call.resolve()
        }
    }
}
