@preconcurrency import AVFoundation
import CoreMedia

/// The audio effect layers on iOS: the composition's whole mix read once, put through
/// `ComposeAudio.effects` (`AudioEffectRunner`), written to a PCM file, and laid back into the
/// composition as its only audio track, with no audio mix left to apply.
///
/// WHY A FILE. A window acts on the FINISHED mix - every clip's sound, every music pass, every lane and
/// voiceover at once - and AVFoundation never hands the summed mix to Swift inside an export:
/// `audioTapProcessor` belongs to one track's mix parameters, and `AVAssetExportSession`, the
/// fallback engine, mixes and encodes in one step. Mixed into a file first, both engines simply
/// encode what is already right, and the arithmetic sees what the contract says it sees: the mix at
/// 48 kHz stereo, held to -1...1 as 16-bit, exactly what `WriterEngine` would have encoded.
///
/// The file runs to the post's end, past where the last sound stopped, so a tail rings on after it.
/// It is a working file of the render's own ([RenderInputs.folder]), gone when the export is.
enum MixEffects {
    /// What the mix is read as and written back in: `WriterEngine.pcmSettings`.
    static let rate = Double(WriterEngine.audioSampleRate)
    static let channels = WriterEngine.audioChannels

    /// `built` with its audio put through `spec.audio.effects`, or `built` itself for a post with
    /// none, or with no audio track to put through them.
    static func apply(_ built: BuiltComposition, spec: ComposeSpec) async throws -> BuiltComposition {
        let windows = spec.audio.effects
        let comp = built.composition
        let tracks = comp.tracks(withMediaType: .audio)
        guard !windows.isEmpty, !tracks.isEmpty else { return built }

        let folder = RenderInputs.folder(spec.batchId)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let url = folder.appendingPathComponent("effects-\(JobFolders.sanitize(spec.jobId)).caf")
        try? FileManager.default.removeItem(at: url)

        let totalFrames = frameAt(Double(built.totalMs), rate: rate)
        try render(comp, mix: built.audioMix, tracks: tracks, windows: windows, totalFrames: totalFrames, to: url)

        // The file is the whole of the post's sound now: every track it was made from goes, and the
        // mix parameters naming them with it.
        for track in tracks { comp.removeTrack(track) }
        let asset = AVURLAsset(url: url)
        guard let source = try await asset.loadTracks(withMediaType: .audio).first,
              let track = comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw BuildError.internalFailure("audio effects track")
        }
        let length = try await source.load(.timeRange).duration
        let total = CMTime(value: built.totalMs, timescale: 1000)
        try track.insertTimeRange(CMTimeRange(start: .zero, duration: CMTimeMinimum(length, total)), of: source, at: .zero)
        return BuiltComposition(composition: comp,
                                videoComposition: built.videoComposition,
                                audioMix: nil,
                                totalMs: built.totalMs,
                                plan: built.plan)
    }

    /// Reads the mix of `tracks` under `mix`, runs the windows over it and writes it to `url`, padded
    /// with silence - through the windows too, for their tails - to `totalFrames`.
    private static func render(_ comp: AVMutableComposition, mix: AVAudioMix?, tracks: [AVCompositionTrack],
                               windows: [AudioEffectWindow], totalFrames: Int64, to url: URL) throws {
        let reader = try AVAssetReader(asset: comp)
        reader.timeRange = CMTimeRange(start: .zero, duration: CMTime(value: totalFrames, timescale: CMTimeScale(rate)))
        let output = AVAssetReaderAudioMixOutput(audioTracks: tracks, audioSettings: WriterEngine.pcmSettings)
        output.audioMix = mix
        // The default the writer's own output sets; a track's own parameters still win over it.
        output.audioTimePitchAlgorithm = .spectral
        guard reader.canAdd(output) else { throw BuildError.internalFailure("audio effects reader") }
        reader.add(output)

        guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: rate, channels: AVAudioChannelCount(channels), interleaved: true) else {
            throw BuildError.internalFailure("audio effects format")
        }
        let file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatInt16, interleaved: true)
        let runner = AudioEffectRunner(windows: windows, sampleRate: rate, channels: channels)
        var written: Int64 = 0
        var scratch: [Double] = []

        /// `frames` interleaved 16-bit frames through the windows and onto the file.
        func write(_ samples: UnsafePointer<Int16>, frames: Int) throws {
            guard frames > 0 else { return }
            let count = frames * channels
            if scratch.count < count { scratch = Array(repeating: 0, count: count) }
            try scratch.withUnsafeMutableBufferPointer { doubles in
                for i in 0..<count { doubles[i] = Double(samples[i]) / 32768 }
                runner.process(doubles.baseAddress!, count: frames)
                guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
                      let out = buffer.int16ChannelData?[0] else {
                    throw BuildError.internalFailure("audio effects buffer")
                }
                for i in 0..<count {
                    let v = (doubles[i] * 32768).rounded()
                    out[i] = Int16(max(-32768, min(32767, v)))
                }
                buffer.frameLength = AVAudioFrameCount(frames)
                try file.write(from: buffer)
            }
            written += Int64(frames)
        }

        /// Silence up to frame `upTo`, through the windows: a gap the mix left, or the post past its last sound.
        func silence(upTo: Int64) throws {
            let block = 4096
            let zeros = [Int16](repeating: 0, count: block * channels)
            while written < upTo {
                let frames = Int(min(Int64(block), upTo - written))
                try zeros.withUnsafeBufferPointer { try write($0.baseAddress!, frames: frames) }
            }
        }

        guard reader.startReading() else {
            throw BuildError.internalFailure("audio effects: \(reader.error.map { ErrorMapping.describe($0) } ?? "the mix could not be read")")
        }
        defer { reader.cancelReading() }
        while let sample = output.copyNextSampleBuffer() {
            if Task.isCancelled { throw CancellationError() }
            guard let block = CMSampleBufferGetDataBuffer(sample) else { continue }
            let frames = CMSampleBufferGetNumSamples(sample)
            var bytes = [Int16](repeating: 0, count: frames * channels)
            let status = bytes.withUnsafeMutableBytes { raw in
                CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: raw.count, destination: raw.baseAddress!)
            }
            guard status == kCMBlockBufferNoErr else { throw BuildError.internalFailure("audio effects: a mix buffer could not be read") }
            // Laid where its time says, so a gap in the mix is silence rather than a slip of the rest.
            let at = frameAt(CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(sample)) * 1000, rate: rate)
            if at > written { try silence(upTo: min(at, totalFrames)) }
            let skip = Int(max(0, written - at))
            let keep = min(frames - skip, Int(max(0, totalFrames - written)))
            if keep > 0 { try bytes.withUnsafeBufferPointer { try write($0.baseAddress! + skip * channels, frames: keep) } }
        }
        if reader.status == .failed {
            throw BuildError.internalFailure("audio effects: \(reader.error.map { ErrorMapping.describe($0) } ?? "the mix could not be read")")
        }
        try silence(upTo: totalFrames)
    }

}
