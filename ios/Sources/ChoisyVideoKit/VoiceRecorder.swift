@preconcurrency import AVFoundation
import Foundation
import os

enum VoiceError: Error {
    case alreadyRecording, permissionDenied, notRecording
    case recordingFailed(String)

    /// The machine word JS switches on. `errorCode()` in the voiceover sheet reads `code` and falls
    /// back to `message`, so Capacitor's reject gets this as its second argument every time.
    var word: String {
        switch self {
        case .alreadyRecording: return "already_recording"
        case .permissionDenied: return "permission_denied"
        case .notRecording: return "not_recording"
        case .recordingFailed: return "recording_failed"
        }
    }

    /// The first argument to `call.reject`. It is the word for everything JS recovers from, and
    /// prose only where the contract asks for prose.
    var message: String {
        switch self {
        case .permissionDenied: return "microphone permission denied"
        case .notRecording: return "not recording"
        case .alreadyRecording, .recordingFailed: return word
        }
    }

    /// For the log only. JS matches the word exactly, so the reason a take failed must never reach
    /// the reject.
    var detail: String {
        if case .recordingFailed(let d) = self { return d }
        return word
    }
}

/// The microphone, as the module's only actor.
///
/// It is process-wide rather than per-plugin because a WebView reload builds a fresh `CAPPlugin`
/// while a take is still open, and an `AVAudioRecorder` owned by the dead instance keeps the
/// microphone. Both entry points are already `async`, so the actor costs nothing and closes the
/// hole where two concurrent `start` calls both pass the same nil check.
actor VoiceRecorder {

    static let shared = VoiceRecorder()

    private static let log = Logger(subsystem: "net.dotnetdreamer.choisy", category: "VoiceRecorder")

    /// Matches Android's `MediaRecorder` configuration exactly in container and codec, so a take
    /// recorded on either platform mixes into the same timeline the same way. The `.m4a` extension
    /// is what makes `AVAudioRecorder` write an MPEG-4 container rather than a raw ADTS stream.
    private static let settings: [String: Any] = [
        AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
        AVSampleRateKey: 44_100,
        AVNumberOfChannelsKey: 1,
        AVEncoderBitRateKey: 96_000,
        AVEncoderAudioQualityKey: AVAudioQuality.high.rawValue,
    ]

    private var recorder: AVAudioRecorder?
    private var fileURL: URL?
    private var startedAt: TimeInterval = 0
    private var previous: (AVAudioSession.Category, AVAudioSession.Mode, AVAudioSession.CategoryOptions)?
    private var interruptionToken: NSObjectProtocol?

    // MARK: - Start

    /// Opens a take. `pendingPostId` decides only where the file lands: inside the job folder when
    /// the caller already has one, so `prepareJob` never has to relocate it, and the voice cache
    /// otherwise.
    func start(pendingPostId: String?) async throws {
        guard recorder == nil else { throw VoiceError.alreadyRecording }

        try await requestPermission()

        let dir = pendingPostId.map { JobFolders.inputsDir($0) } ?? JobFolders.voiceDir()
        do {
            try JobFolders.ensure(dir)
        } catch {
            throw VoiceError.recordingFailed("could not create \(dir.path): \(error)")
        }
        // Lowercase uuid, matching Android's file-name shape so the folders sheet's `vo:<id>`
        // relocation matches on both platforms.
        let url = dir.appendingPathComponent("vo-\(UUID().uuidString.lowercased()).m4a")

        let session = AVAudioSession.sharedInstance()
        previous = (session.category, session.mode, session.categoryOptions)
        do {
            // playAndRecord because the editor keeps playing the timeline through the WebView while
            // the customer talks, and defaultToSpeaker because without it that playback moves to
            // the ear receiver the moment the category changes. No Bluetooth HFP option: it drags
            // both input and output onto a narrowband route and wrecks the thing being recorded
            // against.
            try session.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker])
            try session.setActive(true)
        } catch {
            restoreSession()
            throw VoiceError.recordingFailed("audio session: \(error)")
        }

        do {
            let recorder = try AVAudioRecorder(url: url, settings: Self.settings)
            guard recorder.record() else {
                restoreSession()
                try? FileManager.default.removeItem(at: url)
                throw VoiceError.recordingFailed("record() refused to start")
            }
            self.recorder = recorder
            self.fileURL = url
            // Monotonic, like Android's SystemClock.elapsedRealtime(): a clock change mid-take
            // cannot make the fallback duration negative.
            self.startedAt = ProcessInfo.processInfo.systemUptime
            observeInterruptions()
        } catch let error as VoiceError {
            throw error
        } catch {
            restoreSession()
            try? FileManager.default.removeItem(at: url)
            throw VoiceError.recordingFailed("AVAudioRecorder: \(error)")
        }
    }

    /// `.undetermined` prompts, `.denied` rejects without prompting.
    ///
    /// The `AVAudioApplication` pair is the iOS 17 replacement; `AVAudioSession.recordPermission`
    /// and its request are deprecated and would warn.
    private func requestPermission() async throws {
        switch AVAudioApplication.shared.recordPermission {
        case .denied:
            throw VoiceError.permissionDenied
        case .undetermined:
            if await AVAudioApplication.requestRecordPermission() == false {
                throw VoiceError.permissionDenied
            }
        default:
            break
        }
    }

    // MARK: - Stop

    /// Closes the take and measures the FILE, never the wall clock.
    ///
    /// The voiceover sheet computes `leadInMs = clamp(wallMs - fileMs, 0, 400)` and places the take
    /// at `from + lead`, so that subtraction IS its measurement of the recorder's warm-up. Handing
    /// back a wall clock here would make the lead-in zero and push every take late by the warm-up.
    /// Returning 0 is legal: JS falls back to its own clock and sets `lead = 0`.
    ///
    /// There is deliberately no minimum length. Android has none, and JS already decides twice
    /// (`placeTake` drops anything under `MIN_LAYER_MS`, and the catch path treats a tap under
    /// `SHORT_TAP_MS` as a tap rather than a failure). A third, invisible native threshold that
    /// agrees with neither would be worse than none.
    func stop() async throws -> (url: URL, durationMs: Int64) {
        guard let recorder = self.recorder, let url = self.fileURL else { throw VoiceError.notRecording }
        let elapsedMs = Int64(max(0, (ProcessInfo.processInfo.systemUptime - startedAt) * 1000))

        // Clear state BEFORE anything that can throw. JS recovers from `already_recording` by
        // calling stop() and starting again, and a stop that leaves the recorder installed breaks
        // that recovery for the rest of the process.
        self.recorder = nil
        self.fileURL = nil
        removeInterruptionObserver()
        recorder.stop()
        restoreSession()

        guard Thumbnailer.fileBytes(url) > 0 else {
            try? FileManager.default.removeItem(at: url)
            throw VoiceError.recordingFailed("the take is missing or empty")
        }

        // One load of a short m4a's duration, well inside the 8 second timeout JS wraps this call
        // in. A probe that says nothing is not a failure, it is a fallback.
        let probed = (try? await Thumbnailer.probe(url).durationMs) ?? 0
        return (url, probed > 0 ? probed : elapsedMs)
    }

    /// Drops an open take and deletes the partial file. Called from the plugin's `deinit` and from
    /// the registry's background observer: a microphone left open behind a backgrounded app is the
    /// kind of thing App Review notices.
    func abandon() {
        let url = fileURL
        recorder?.stop()
        recorder = nil
        fileURL = nil
        removeInterruptionObserver()
        restoreSession()
        if let url {
            try? FileManager.default.removeItem(at: url)
            Self.log.info("abandoned an open voice take")
        }
    }

    // MARK: - Session and interruptions

    /// Puts the category back exactly as it was found. The session is deliberately NOT deactivated:
    /// the WebView's `<video>` elements share it and would lose their route, which shows up as a
    /// silent feed after a voiceover.
    private func restoreSession() {
        guard let previous else { return }
        self.previous = nil
        try? AVAudioSession.sharedInstance().setCategory(previous.0, mode: previous.1, options: previous.2)
    }

    /// A phone call ends the take. Whatever was captured is kept and the next `stop()` returns it,
    /// which is why the recorder is stopped but not cleared here.
    private func observeInterruptions() {
        interruptionToken = NotificationCenter.default.addObserver(
            forName: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance(),
            queue: nil
        ) { note in
            guard let raw = note.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt,
                  AVAudioSession.InterruptionType(rawValue: raw) == .began else { return }
            // Reach for the singleton rather than capturing self: the block outlives the take, and
            // capturing an actor here would keep it alive and need a hop of its own anyway.
            Task { await VoiceRecorder.shared.interruptionBegan() }
        }
    }

    private func interruptionBegan() {
        guard recorder != nil else { return }
        Self.log.info("audio session interrupted, closing the take")
        recorder?.stop()
    }

    private func removeInterruptionObserver() {
        guard let interruptionToken else { return }
        self.interruptionToken = nil
        NotificationCenter.default.removeObserver(interruptionToken)
    }
}
