@preconcurrency import AVFoundation
import AudioToolbox
import Foundation

/// The encoder every render goes through first: the composition read back frame by frame through
/// `EditCompositor`, and written at the rate, key-frame spacing and profile the spec asks for.
///
/// It exists because a preset picks its own bitrate and nothing about `AVAssetExportSession` lets it
/// be told otherwise. The spec's `output` is Android's encoder request field for field - VBR at
/// `videoBitrate`, a key frame every second, AAC at `audioBitrate`, see `newTransformer` in
/// `CompositionBuilder.kt` - and the quality sheet's size estimate is that same arithmetic, so an
/// engine that ignored it would give one quality chip a different file on each platform.
///
/// The shape is the usual reader-writer pairing. One `AVAssetReader` over the composition, with a
/// video-composition output that draws every frame through the compositor and an audio-mix output
/// that mixes every sound track through the audio mix; one `AVAssetWriter` with an input for each;
/// and a pump per input, on its own serial queue, driven by `requestMediaDataWhenReady`. The two
/// pumps run at the same time because they have to: the writer interleaves, so it stops asking for
/// video while the audio is behind, and a single loop that fed one input to the end before starting
/// the other would wait forever.
enum WriterEngine: RenderEngine {

    static let name = "AVAssetWriter"

    /// 48 kHz stereo whatever the sources are. The audio-mix output resamples and up- or down-mixes
    /// every track to this on its way out, so the encoder is handed exactly the format it encodes
    /// and converts nothing itself. AAC takes the same bitrates at 44.1 and 48 kHz (measured: 64 to
    /// 320 kbps in the same thirteen steps at both), so nothing about the bitrate decides the rate,
    /// and 48 kHz is the rate video audio is normally carried at.
    static let audioSampleRate = 48_000
    static let audioChannels = 2

    static func encode(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
                       onProgress: @escaping @Sendable (Double) -> Void) async throws {
        // The writer refuses to start over an existing file, and a part left by a render the
        // process died in the middle of is exactly that.
        try? FileManager.default.removeItem(at: url)
        // Where the writer does the second pass that puts the index at the front of the file. In
        // the job folder rather than the system's temporary directory, so a render that dies midway
        // leaves nothing behind that `JobFolders.cleanup` does not also delete.
        try FileManager.default.createDirectory(at: tmpDir, withIntermediateDirectories: true)

        do {
            let transfer = try Transfer(built, to: url, tmpDir: tmpDir, spec: spec, onProgress: onProgress)
            // An already cancelled task runs `onCancel` before `run`, which then finds the flag set
            // and throws without starting anything.
            try await withTaskCancellationHandler {
                try await transfer.run()
            } onCancel: {
                transfer.cancel()
            }
        } catch {
            // `cancelWriting` deletes what it wrote; a writer that failed on its own does not, and
            // a half-written file is precisely what must never reach the move to stitched.mp4.
            try? FileManager.default.removeItem(at: url)
            throw error
        }
    }

    /// H.264 at the render size, the spec's rate and a one second key-frame interval, tagged BT.709.
    ///
    /// High profile with the level left to the encoder, which is what Android ends up with: its
    /// `DefaultEncoderFactory` ignores a requested profile and picks High on API 29 and up wherever
    /// the encoder offers it. A fixed level would be wrong at one end of the ladder or the other,
    /// since 720p30 fits 3.1 and 4K60 needs 5.2.
    ///
    /// The colour tags repeat what the video composition already declares, and they matter for the
    /// same reason there: `EditCompositor` renders into buffers tagged 709, and a file left
    /// untagged is guessed at by every player that opens it.
    static func videoSettings(_ spec: ComposeSpec, renderSize: CGSize) -> [String: Any] {
        [
            AVVideoCodecKey: AVVideoCodecType.h264,
            AVVideoWidthKey: Int(renderSize.width),
            AVVideoHeightKey: Int(renderSize.height),
            AVVideoCompressionPropertiesKey: [
                // An average, which is VideoToolbox's variable rate: the encoder spends less on a
                // still shot and more on a busy one, as Android's BITRATE_MODE_VBR does.
                AVVideoAverageBitRateKey: spec.output.videoBitrate,
                // Seconds rather than frames, Android's `setiFrameIntervalSeconds(1f)`, so the
                // spacing is the same whatever `fps` the ladder picked.
                AVVideoMaxKeyFrameIntervalDurationKey: 1,
                AVVideoExpectedSourceFrameRateKey: spec.output.fps,
                AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel,
            ] as [String: Any],
            AVVideoColorPropertiesKey: [
                AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2,
                AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2,
                AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2,
            ],
        ]
    }

    /// AAC-LC at the bitrate the encoder will actually take nearest the one asked for.
    static func audioSettings(bitrate: Int) -> [String: Any] {
        [
            AVFormatIDKey: kAudioFormatMPEG4AAC,
            AVSampleRateKey: audioSampleRate,
            AVNumberOfChannelsKey: audioChannels,
            AVEncoderBitRateKey: aacBitrate(near: bitrate),
        ]
    }

    /// What the audio-mix output hands the writer: interleaved 16-bit PCM in the encoder's own rate
    /// and channel count, so the mix is the only place any conversion happens.
    static let pcmSettings: [String: Any] = [
        AVFormatIDKey: kAudioFormatLinearPCM,
        AVSampleRateKey: audioSampleRate,
        AVNumberOfChannelsKey: audioChannels,
        AVLinearPCMBitDepthKey: 16,
        AVLinearPCMIsFloatKey: false,
        AVLinearPCMIsBigEndianKey: false,
        AVLinearPCMIsNonInterleaved: false,
    ]

    /// The same two keys `EditCompositor.requiredPixelBufferAttributesForRenderContext` asks its
    /// render context for, so the frame the compositor drew is the frame the reader hands over,
    /// with no conversion in between.
    static let frameSettings: [String: Any] = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferMetalCompatibilityKey as String: true,
    ]

    /// The requested AAC bitrate moved onto one the encoder accepts, or left alone when the encoder
    /// will not say which it accepts.
    ///
    /// Not a nicety. The AAC encoder takes a fixed set of rates for a given channel count, and a
    /// rate outside the set - 32 kbps stereo, or 500 kbps - passes every up-front check the writer
    /// has and then fails the first append with -11861, measured. Android's `setEnableFallback`
    /// resolves the same mismatch before the export starts; this is that move, made here. A rate
    /// between two steps goes to the nearer one, and to the lower of the two on a tie.
    static func aacBitrate(near requested: Int) -> Int {
        var best: Int?
        for range in applicableAACBitrates {
            let candidate = min(max(requested, Int(range.mMinimum)), Int(range.mMaximum))
            if let current = best, abs(current - requested) <= abs(candidate - requested) { continue }
            best = candidate
        }
        return best ?? requested
    }

    /// Asked of the encoder once per process rather than written down, because the list is the
    /// encoder's and not ours: a future one that widens it is taken at its word.
    ///
    /// Every entry is a range. On every system measured each one is a single rate with its minimum
    /// equal to its maximum, and the property also pads the array it fills with empty ranges, which
    /// is what the `mMaximum > 0` filter throws away.
    private static let applicableAACBitrates: [AudioValueRange] = {
        let channels = UInt32(audioChannels)
        var pcm = AudioStreamBasicDescription(
            mSampleRate: Float64(audioSampleRate), mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kLinearPCMFormatFlagIsSignedInteger | kLinearPCMFormatFlagIsPacked,
            mBytesPerPacket: 2 * channels, mFramesPerPacket: 1, mBytesPerFrame: 2 * channels,
            mChannelsPerFrame: channels, mBitsPerChannel: 16, mReserved: 0)
        var aac = AudioStreamBasicDescription(
            mSampleRate: Float64(audioSampleRate), mFormatID: kAudioFormatMPEG4AAC,
            mFormatFlags: 0, mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0,
            mChannelsPerFrame: channels, mBitsPerChannel: 0, mReserved: 0)
        var converter: AudioConverterRef?
        guard AudioConverterNew(&pcm, &aac, &converter) == noErr, let converter else { return [] }
        defer { AudioConverterDispose(converter) }

        var size: UInt32 = 0
        guard AudioConverterGetPropertyInfo(converter, kAudioConverterApplicableEncodeBitRates,
                                            &size, nil) == noErr, size > 0 else { return [] }
        var ranges = [AudioValueRange](repeating: AudioValueRange(),
                                       count: Int(size) / MemoryLayout<AudioValueRange>.size)
        guard AudioConverterGetProperty(converter, kAudioConverterApplicableEncodeBitRates,
                                        &size, &ranges) == noErr else { return [] }
        return ranges.filter { $0.mMaximum > 0 }
    }()

    /// What a setup the writer will not take is thrown as. `unsupportedOutputSettings` is the code
    /// AVFoundation itself gives an encoder that refuses its settings, and the one `Exporter` falls
    /// back on - which is the point: a configuration the writer turns down before the first frame
    /// is the case the preset session is there to catch.
    fileprivate static func refused(_ what: String) -> AVError {
        AVError(.unsupportedOutputSettings, userInfo: [NSLocalizedDescriptionKey: "the writer refused \(what)"])
    }
}

/// One input's half of the transfer: where its samples come from, where they go, and the queue its
/// pump runs on.
///
/// `ended` is guarded by `Transfer.lock`; everything else is immutable, which is what makes the
/// `@unchecked Sendable` honest.
private final class Lane: @unchecked Sendable {
    let output: AVAssetReaderOutput
    let input: AVAssetWriterInput
    let queue: DispatchQueue
    /// Whether this lane's samples are what progress is measured by. The video lane's are: the
    /// frames are the slow half, and a mix that has raced ahead says nothing about how long the
    /// render has left, which is the same reason Android reads progress off its frames.
    let reportsProgress: Bool
    var ended = false

    init(output: AVAssetReaderOutput, input: AVAssetWriterInput, label: String, reportsProgress: Bool) {
        self.output = output
        self.input = input
        self.queue = DispatchQueue(label: "net.dotnetdreamer.videokit.writer.\(label)", qos: .userInitiated)
        self.reportsProgress = reportsProgress
    }
}

/// One render's reader, writer and pumps, and the single place the transfer ends.
///
/// Every way it can end - the reader running out, the writer failing, the reader failing, the task
/// being cancelled - comes down to the same move: each lane is ended ON ITS OWN QUEUE, and whichever
/// lane ends last closes the file or throws it away. Ending a lane on its own queue is what makes
/// that safe. The queue is serial and the pump runs on it, so once a lane has ended nothing is in
/// flight on it or ever will be, and `cancelReading` and `cancelWriting`, neither of which may run
/// alongside a pump, run only after both have.
///
/// A cancel is the one ending whose caller is not made to wait for that; see `cancel`.
private final class Transfer: @unchecked Sendable {
    /// How long a cancel waits for the lanes to end before it answers without them.
    ///
    /// A pump that is mid-sample when the cancel lands finishes that sample in a frame's time: on
    /// the simulator both lanes had ended within a hundredth of a second of every cancel measured.
    /// Half a second is fifty times that, so the ordinary cancel is still answered by `close`, after
    /// the partial is gone, and a pump that has not come back by then is waiting for a frame that
    /// is not coming. The time an ordinary cancel does take is spent in `close`, in `cancelWriting`,
    /// measured at up to a second and a half. That comes after both lanes have ended and is not cut
    /// short: it is bounded, and it is the writer letting go of its files in the job folder that a
    /// `cleanup` may be about to delete.
    private static let cancelGrace: DispatchTimeInterval = .milliseconds(500)

    private let reader: AVAssetReader
    private let writer: AVAssetWriter
    private let lanes: [Lane]
    private let totalMs: Int64
    private let onProgress: @Sendable (Double) -> Void

    /// Guards every `var` below and every lane's `ended`, and is never held across a call into
    /// AVFoundation that can wait on another thread - except in `start`, on purpose; see there.
    private let lock = NSLock()
    private var continuation: CheckedContinuation<Void, Error>?
    private var started = false
    private var cancelled = false
    /// Set with the last lane's `ended`, in the same locked section. From then on the answer is
    /// `close`'s to give, whichever branch it takes, and `abandon` stands aside.
    private var closing = false
    /// The first failure seen, reader or writer. Recorded when it is seen rather than read back off
    /// the status at the end, because cancelling the reader to stop the other lane may move a
    /// failed reader's status on and lose the error that mattered.
    private var failure: Error?
    /// Asks the writer, twice a second, whether it has failed on its own. The encoders run behind
    /// the appends, so a writer can fail after every append has succeeded, and a failed writer
    /// makes no input ready again: nothing would ever call a pump to find out, and the render would
    /// sit silent until the registry's stall watch called it a timeout instead of the writer's
    /// own error.
    private var watch: DispatchSourceTimer?

    init(_ built: BuiltComposition, to url: URL, tmpDir: URL, spec: ComposeSpec,
         onProgress: @escaping @Sendable (Double) -> Void) throws {
        self.totalMs = built.totalMs
        self.onProgress = onProgress

        // The same range the composition was built to, which can be shorter than the spec's total
        // when a clip's trim was clamped to its file.
        let reader = try AVAssetReader(asset: built.composition)
        reader.timeRange = CMTimeRange(start: .zero, duration: ms(built.totalMs))

        let writer = try AVAssetWriter(outputURL: url, fileType: .mp4)
        writer.shouldOptimizeForNetworkUse = true            // moov atom first, the feed streams it
        writer.directoryForTemporaryFiles = tmpDir

        // Every check below is a `can` ahead of the call it guards, because each of those calls
        // raises an Objective-C exception rather than throwing when the answer is no, and Swift
        // cannot catch one of those: it is a crash, not a failure.
        let frames = AVAssetReaderVideoCompositionOutput(videoTracks: built.composition.tracks(withMediaType: .video),
                                                         videoSettings: WriterEngine.frameSettings)
        // `copy`, like the session's: the output takes a snapshot, and the instructions in it still
        // reference the one `RenderPlan`, which is how the compositor the output builds reaches the
        // overlays and the job's frame cursor.
        frames.videoComposition = built.videoComposition
        // Nothing downstream writes to a frame, so the copy would buy nothing but a memcpy of every
        // 4K frame.
        frames.alwaysCopiesSampleData = false
        guard reader.canAdd(frames) else { throw WriterEngine.refused("the composed video output") }
        reader.add(frames)

        let videoSettings = WriterEngine.videoSettings(spec, renderSize: built.videoComposition.renderSize)
        guard writer.canApply(outputSettings: videoSettings, forMediaType: .video) else {
            throw WriterEngine.refused("the video settings")
        }
        let videoInput = AVAssetWriterInput(mediaType: .video, outputSettings: videoSettings)
        videoInput.expectsMediaDataInRealTime = false
        guard writer.canAdd(videoInput) else { throw WriterEngine.refused("the video input") }
        writer.add(videoInput)
        var lanes = [Lane(output: frames, input: videoInput, label: "video", reportsProgress: true)]

        // No sound track, no audio lane, and no audio track in the file: the same file the preset
        // session writes for a timeline of silent clips, and what Android's `videoSeqHasAudio`
        // decides the same way. The builder has already removed every audio track that received
        // no segment, so a track here is one with something on it.
        let soundTracks = built.composition.tracks(withMediaType: .audio)
        if !soundTracks.isEmpty {
            let mix = AVAssetReaderAudioMixOutput(audioTracks: soundTracks, audioSettings: WriterEngine.pcmSettings)
            mix.audioMix = built.audioMix
            // The contract preserves pitch across a speed change (D3), and this is the output-side
            // half of what `CompositionBuilder` asks of each track's mix parameters.
            mix.audioTimePitchAlgorithm = .spectral
            mix.alwaysCopiesSampleData = false
            guard reader.canAdd(mix) else { throw WriterEngine.refused("the mixed audio output") }
            reader.add(mix)

            let audioSettings = WriterEngine.audioSettings(bitrate: spec.output.audioBitrate)
            guard writer.canApply(outputSettings: audioSettings, forMediaType: .audio) else {
                throw WriterEngine.refused("the audio settings")
            }
            let audioInput = AVAssetWriterInput(mediaType: .audio, outputSettings: audioSettings)
            audioInput.expectsMediaDataInRealTime = false
            guard writer.canAdd(audioInput) else { throw WriterEngine.refused("the audio input") }
            writer.add(audioInput)
            lanes.append(Lane(output: mix, input: audioInput, label: "audio", reportsProgress: false))
        }

        self.reader = reader
        self.writer = writer
        self.lanes = lanes
    }

    /// Returns when the file is closed, and throws when it is not: `CancellationError` for a
    /// cancel, otherwise the reader's or the writer's own error for `ErrorMapping` to read.
    func run() async throws {
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            lock.lock()
            self.continuation = continuation
            lock.unlock()
            start()
        }
    }

    /// Stops the transfer from any thread. Safe before `start`, during it and after the end.
    ///
    /// The reader is NOT cancelled from here, tempting as it is to hand a pump parked inside
    /// `copyNextSampleBuffer` its nil at once. `cancelReading` on one thread while another is inside
    /// `copyNextSampleBuffer` frees the composed frame the second one is taking out of the reader -
    /// measured, as a crash in `CMVideoFormatDescriptionMatchesImageBuffer` under the video pump.
    /// The lanes are ended behind whatever their pumps are doing instead.
    ///
    /// That is normally one composed frame, and it is not always: a pump sits in that call for as
    /// long as the frame it asked for does not come, which is what a wedged decoder or GPU looks
    /// like, and exactly the render the registry's stall watch cancels. A cancel that waited for the
    /// lanes would then never be answered - no `failed` event, and a JS `cancel()` or
    /// `discardLastRender` that never settles - where the preset session's `cancelExport` reaches
    /// its compositor and returns in a moment. So the answer waits `cancelGrace` for the lanes and
    /// is then given without them, by `abandon`.
    ///
    /// The transfer outlives that answer, and still ends the usual way. The `end` blocks `stop`
    /// queued behind the stuck pump hold on to it, and whenever the pump comes back they close it
    /// as they close any cancelled transfer, reader and writer cancelled.
    func cancel() {
        lock.lock()
        cancelled = true
        let running = started
        lock.unlock()
        // Before `start` the flag is the whole of it: `start` checks it under the same lock.
        guard running else { return }
        stop(because: nil)
        DispatchQueue.global(qos: .userInitiated).asyncAfter(deadline: .now() + Self.cancelGrace) { [self] in
            abandon()
        }
    }

    /// A cancel's answer when the lanes have not both ended within `cancelGrace`.
    ///
    /// Not once the file is closing. Both lanes have ended by then and nothing is stuck, so `close`
    /// is left to answer, which it does whichever branch it took: `encode` must never delete a file
    /// the writer is still in the middle of finishing.
    private func abandon() {
        lock.lock()
        let closing = self.closing
        lock.unlock()
        guard !closing else { return }
        resolve(CancellationError())
    }

    /// Everything from starting the reader to registering the pumps, under the lock, so that a
    /// `cancel` arriving midway waits for the end of it and finds a transfer it can stop, rather
    /// than ending a lane whose writer has not started - which `markAsFinished` answers with an
    /// exception. Nothing in here waits on another thread that could want the lock.
    private func start() {
        lock.lock()
        if cancelled {
            lock.unlock()
            resolve(CancellationError())
            return
        }
        var refusal: Error?
        if !reader.startReading() {
            refusal = reader.error ?? AVError(.unknown)
        } else if !writer.startWriting() {
            reader.cancelReading()
            refusal = writer.error ?? AVError(.unknown)
        } else {
            writer.startSession(atSourceTime: .zero)
            started = true
            let timer = DispatchSource.makeTimerSource(queue: .global(qos: .utility))
            timer.schedule(deadline: .now() + .milliseconds(500), repeating: .milliseconds(500))
            timer.setEventHandler { [weak self] in
                guard let self, self.writer.status == .failed else { return }
                self.stop(because: self.writer.error ?? AVError(.unknown))
            }
            timer.resume()
            watch = timer
            for lane in lanes {
                // Weak, because the input holds on to this block and this object holds the input.
                // `encode` keeps the transfer alive until it has resolved, and the `end` blocks a
                // stop queues keep it alive after that until both lanes have ended, which between
                // them is as long as a pump has anything to do.
                lane.input.requestMediaDataWhenReady(on: lane.queue) { [weak self] in self?.pump(lane) }
            }
        }
        lock.unlock()
        if let refusal { resolve(refusal) }
    }

    /// Feeds one input for as long as it will take more, on that lane's queue.
    ///
    /// AVFoundation calls this again whenever the input is ready after returning, so the loop ends
    /// on readiness and the lane ends only on the reader running out or something going wrong.
    private func pump(_ lane: Lane) {
        while lane.input.isReadyForMoreMediaData {
            guard isLive(lane) else { return }
            guard let sample = lane.output.copyNextSampleBuffer() else {
                // Out of samples: the end of the range, a cancel, or a reader that failed. Only the
                // last is a failure, and it has to be caught now, while the status still says so.
                if reader.status == .failed {
                    stop(because: reader.error ?? AVError(.unknown))
                } else {
                    end(lane)
                }
                return
            }
            guard lane.input.append(sample) else {
                // The writer has failed; its status and error say why.
                stop(because: writer.error ?? AVError(.unknown))
                return
            }
            if lane.reportsProgress { report(sample) }
        }
    }

    private func isLive(_ lane: Lane) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return !cancelled && failure == nil && !lane.ended
    }

    /// Records why the transfer is stopping, if it is a failure and the first one, and ends every
    /// lane, each on its own queue behind whatever that lane's pump is doing. The reader is left
    /// alone until `close`, for the reason `cancel` gives.
    ///
    /// A failure, unlike a cancel, is answered only once both lanes have ended. A failure is what
    /// `Exporter` falls back on, the fallback writes to the same `url`, and a writer that is still
    /// writing deletes its file when it is cancelled: answered early, a stuck transfer could close
    /// late and delete the fallback's file as its own. A failure that meets a stuck lane is still
    /// answered, because nothing moves after it: the stall watch cancels the render, and the cancel
    /// is answered at once.
    private func stop(because error: Error?) {
        lock.lock()
        if failure == nil, let error { failure = error }
        lock.unlock()
        for lane in lanes {
            lane.queue.async { [self] in end(lane) }
        }
    }

    /// On `lane.queue`, always, and at most once per lane. The last lane to end closes the file.
    private func end(_ lane: Lane) {
        lock.lock()
        guard !lane.ended else {
            lock.unlock()
            return
        }
        lane.ended = true
        let last = lanes.allSatisfy { $0.ended }
        if last { closing = true }
        lock.unlock()

        // Only a writer that is still writing can be told an input is done; a failed one has
        // nothing left to finish.
        if writer.status == .writing { lane.input.markAsFinished() }
        if last { close() }
    }

    /// Both lanes have ended, so nothing is appending, and nothing will again.
    ///
    /// A cancel that arrives from here on does not stop the close. What is left is the writer
    /// finishing the file, which needs no GPU and is bounded by one pass over it, and cancelling a
    /// writer halfway through `finishWriting` is nothing AVFoundation says it survives. The file is
    /// closed and handed back, and `Exporter` throws it away for a task that was cancelled
    /// meanwhile, so the cancel still ends as a cancel.
    private func close() {
        lock.lock()
        let cancelled = self.cancelled
        let failure = self.failure
        lock.unlock()

        if cancelled || failure != nil {
            // Both of these must not run alongside the lanes - the reader's alongside a
            // `copyNextSampleBuffer`, the writer's alongside an append - which is why they are
            // here, after both lanes, and nowhere else. `cancelWriting` deletes the partial file.
            reader.cancelReading()
            if writer.status == .writing { writer.cancelWriting() }
            resolve(cancelled ? CancellationError() : failure)
            return
        }

        // Ends the file at the timeline's length rather than at the last sample's start: the last
        // frame then lasts its full frame, and the container is as long as the composition.
        writer.endSession(atSourceTime: ms(totalMs))
        writer.finishWriting { [self] in
            resolve(writer.status == .completed ? nil : (writer.error ?? AVError(.unknown)))
        }
    }

    /// The output-timeline time of the frame just written, as a fraction of the timeline.
    private func report(_ sample: CMSampleBuffer) {
        let pts = CMSampleBufferGetPresentationTimeStamp(sample)
        guard pts.isNumeric, totalMs > 0 else { return }
        let fraction = pts.seconds * 1000 / Double(totalMs)
        if fraction.isFinite { onProgress(min(1, max(0, fraction))) }
    }

    /// Resumes the caller exactly once, whichever path gets here first.
    private func resolve(_ error: Error?) {
        lock.lock()
        let continuation = self.continuation
        self.continuation = nil
        let watch = self.watch
        self.watch = nil
        lock.unlock()
        watch?.cancel()
        if let error {
            continuation?.resume(throwing: error)
        } else {
            continuation?.resume()
        }
    }
}
