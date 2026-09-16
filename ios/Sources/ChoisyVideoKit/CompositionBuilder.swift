@preconcurrency import AVFoundation
import CoreMedia

/// Everything the exporter needs to run one render, and nothing more.
///
/// Deliberately NOT `Sendable`: `AVMutableComposition` is `NS_SWIFT_NONSENDABLE`, and this value
/// crosses no isolation boundary - `JobRegistry` builds it and hands it to `Exporter` inside the
/// same detached Task.
struct BuiltComposition {
    let composition: AVMutableComposition
    let videoComposition: AVMutableVideoComposition
    let audioMix: AVMutableAudioMix?

    /// The composition's REAL duration, which can be shorter than `spec.totalOutputMs` when a
    /// clip's `outMs` ran past the end of its file and the trim was clamped. The exporter must use
    /// this for `session.timeRange`; the disk estimate and the wall-clock budget may keep using the
    /// spec's optimistic total, because over-estimating those is the safe direction.
    let totalMs: Int64

    /// Held so the decoded overlays outlive the export. The instructions only reference the plan,
    /// and nothing else in the module keeps it alive.
    let plan: RenderPlan
}

/// One clip's source, loaded once per distinct file.
///
/// The asset is stored, not just the tracks: `AVAssetTrack.asset` is a **weak** reference, so a
/// track whose asset has been released is a track pointing at nothing.
private struct SourceClip {
    let asset: AVURLAsset
    let videoTrack: AVAssetTrack
    let audioTrack: AVAssetTrack?
    let preferredTransform: CGAffineTransform
    let videoRange: CMTimeRange
    let audioRange: CMTimeRange?
}

/// A music or voiceover file, which needs no video track and no transform.
private struct AudioSource {
    let asset: AVURLAsset
    let track: AVAssetTrack
    let endMs: Int64
}

/// One clip's place on the OUTPUT timeline. This is Android's `PlannedClip`: `range` is its
/// `prefixOutUs` and `outDurUs` rolled into one `CMTimeRange`, after the speed change.
private struct TimelineEntry {
    let clip: ComposeClip
    let source: SourceClip
    let range: CMTimeRange
    let gain: Float
}

/// One entry per distinct `uri`. A split or a duplicated clip is two spec entries pointing at the
/// same file, and loading its tracks again would cost another demux for nothing.
private final class SourceCache {
    private var byURI: [String: SourceClip] = [:]

    func source(for clip: ComposeClip) async throws -> SourceClip {
        if let hit = byURI[clip.uri] { return hit }
        guard let url = JobFolders.fileURL(from: clip.uri) else {
            throw BuildError.unreadable(clip.key, "unsupported uri")
        }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        do {
            guard let video = try await asset.loadTracks(withMediaType: .video).first else {
                throw BuildError.unreadable(clip.key, "no video track")
            }
            let audio = try await asset.loadTracks(withMediaType: .audio).first
            // Both properties in one load, and the audio track's range preloaded here rather than
            // read at the call site: the synchronous `track.timeRange` is deprecated since iOS 16.
            let (transform, videoRange) = try await video.load(.preferredTransform, .timeRange)
            let audioRange = try await audio?.load(.timeRange)
            let source = SourceClip(asset: asset,
                                    videoTrack: video,
                                    audioTrack: audio,
                                    preferredTransform: transform,
                                    videoRange: videoRange,
                                    audioRange: audioRange)
            byURI[clip.uri] = source
            return source
        } catch let already as BuildError {
            throw already
        } catch {
            throw BuildError.unreadable(clip.key, "\(error)")
        }
    }
}

/// Turns a validated `ComposeSpec` into the three AVFoundation objects that do the work: the
/// composition (what media plays when), the audio mix (how loud each track is) and the video
/// composition (how each frame is drawn).
///
/// The shape mirrors Android's: one video track holding every clip back to back, plus at most one
/// audio track each for the clips' own sound, the music and the voiceovers. Concurrent Media3
/// sequences are how Android mixes; parallel composition tracks and one `AVAudioMix` is how
/// AVFoundation mixes. Neither platform needs a mixer of ours.
enum CompositionBuilder {
    /// The parser already clamps `clip.speed`, but the engine clamps again rather than trusting a
    /// spec that may have come from an older JS build.
    private static let minSpeed = 0.25
    private static let maxSpeed = 4.0

    /// A ceiling on the music loop. A trimmed piece is at least 1 ms, so a pathological manifest
    /// (in/out a millisecond apart, looping over a ten minute timeline) would otherwise ask for
    /// 600,000 segments and stall the build. Real music is seconds long and never comes near this.
    private static let maxMusicSlices = 10_000

    static func build(_ spec: ComposeSpec) async throws -> BuiltComposition {
        guard !spec.clips.isEmpty else { throw BuildError.internalFailure("spec has no clips") }

        // Built first, because it decodes every overlay PNG: a malformed overlay should fail the
        // job before we spend a second demuxing video.
        let plan = try RenderPlan(spec: spec)

        let comp = AVMutableComposition()
        guard let video = comp.addMutableTrack(withMediaType: .video,
                                               preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw BuildError.internalFailure("video track")
        }
        // `preferredTransform` and `naturalSize` stay at their defaults on purpose. A timeline can
        // mix a portrait and a landscape clip, so there is no single transform this track could
        // carry; orientation is per clip and travels on the EditInstruction to the compositor.

        // Decided from the spec alone, exactly like Android's `videoSeqHasAudio`, which is why the
        // empty-track sweep further down is mandatory rather than defensive.
        let wantsClipAudio = spec.clips.contains { gain(of: $0, spec.audio) > 0 }
        let clipAudio = wantsClipAudio
            ? comp.addMutableTrack(withMediaType: .audio, preferredTrackID: kCMPersistentTrackID_Invalid)
            : nil

        let cache = SourceCache()
        var entries: [TimelineEntry] = []
        var cursor = CMTime.zero

        for clip in spec.clips {
            let src = try await cache.source(for: clip)

            // Clamped to the VIDEO TRACK's end rather than `asset.duration`: for a file whose audio
            // runs past its picture the asset is the longer of the two, and the clamp would not
            // bite when it should. `insertTimeRange` does not validate the range against the
            // source - asking for 10 s of a 3 s file throws nothing and leaves a black tail the
            // compositor cannot fill - so this is the only thing standing between a manifest that
            // over-reaches and a broken render.
            let outMsEff = min(clip.outMs, msOf(src.videoRange.end))
            guard outMsEff > clip.inMs else { throw BuildError.unreadable(clip.key, "empty range") }

            // Asset-relative, starting at zero, because the editor's filmstrip comes from
            // AVAssetImageGenerator, which works in asset time. A trim must mean the same thing in
            // both places.
            let srcRange = CMTimeRange(start: ms(clip.inMs), end: ms(outMsEff))

            do {
                try video.insertTimeRange(srcRange, of: src.videoTrack, at: cursor)
            } catch {
                throw BuildError.unreadable(clip.key, "insert: \(error)")
            }

            let clipGain = gain(of: clip, spec.audio)
            if let ca = clipAudio, clipGain > 0, let at = src.audioTrack, let aRange = src.audioRange {
                // Clamped to the audio track's own end. A file whose sound stops before its picture
                // is common enough - a trimmed screen recording, a clip our recorder wrote with the
                // microphone denied - and asking for media that is not there is not worth the risk.
                let aEnd = CMTimeMinimum(srcRange.end, aRange.end)
                if aEnd > srcRange.start {
                    // Inserted at the absolute output cursor, not at this track's own end. When a
                    // previous clip contributed no audio the track is behind the cursor, and
                    // AVFoundation writes the empty segment itself because composition track
                    // segments must be contiguous. That is also why nothing here ever calls
                    // `insertEmptyTimeRange`, which is a documented no-op at the end of a track.
                    //
                    // A failure must not fail the render: the clip still has a picture, and Android
                    // would have dropped its audio too.
                    try? ca.insertTimeRange(CMTimeRange(start: srcRange.start, end: aEnd),
                                            of: at, at: cursor)
                }
            }

            var placed = CMTimeRange(start: cursor, duration: srcRange.duration)
            let speed = min(maxSpeed, max(minSpeed, clip.speed))
            if speed != 1 {
                // Recomputed from the CLAMPED range. Scaling the clamped media onto the duration
                // the manifest asked for would turn a 2 s overshoot into 2 s of slow motion with
                // the pitch algorithm dragged along; Android recomputes and lets the total shrink,
                // which is why `totalMs` can end up below `spec.totalOutputMs`.
                //
                // The 1 ms floor is the iOS place for Android's MIN_CLIP_US: a degenerate 1 ms clip
                // at 4x rounds to zero, and a zero-length scale is illegal while a zero-length
                // instruction is an instant -11841.
                let scaledMs = max(1, Int64((Double(outMsEff - clip.inMs) / speed)
                    .rounded(.toNearestOrAwayFromZero)))
                let scaled = ms(scaledMs)
                // Scaled immediately, before the next clip goes in. `scaleTimeRange` ripples
                // everything after the range it touches, so doing this in a second pass at the end
                // would be a different, and wrong, computation.
                video.scaleTimeRange(placed, toDuration: scaled)
                // Safe even when this clip contributed less audio than video: the factor applies to
                // whatever media is actually in the range, which is what keeps a short audio track
                // in sync with its picture.
                clipAudio?.scaleTimeRange(placed, toDuration: scaled)
                placed = CMTimeRange(start: cursor, duration: scaled)
            }

            entries.append(TimelineEntry(clip: clip, source: src, range: placed, gain: clipGain))
            cursor = placed.end
        }

        let total = cursor
        let totalMs = max(1, msOf(total))

        var params: [AVMutableAudioMixInputParameters] = []
        if let ca = clipAudio {
            let p = AVMutableAudioMixInputParameters(track: ca)
            // `.spectral`, and never `.varispeed`. The contract preserves pitch across a speed
            // change (D3), and varispeed is the one algorithm that does not; Apple's own header
            // calls spectral the best choice for scaled edits and it is already the offline export
            // default. The clip-audio track is the only scaled one, so it is the only place this
            // choice is audible - music and voice carry it for consistency, not effect.
            p.audioTimePitchAlgorithm = .spectral
            // A step per clip, including the silent ones. Setting 0 where nothing was inserted is
            // redundant today and is what stops a previous clip's 1.0 leaking forward if the insert
            // rule ever changes.
            for e in entries { p.setVolume(e.gain, at: e.range.start) }
            params.append(p)
        }

        if let music = spec.audio.music,
           let p = try await addMusic(music, to: comp, total: total) {
            params.append(p)
        }
        if let p = try await addVoiceovers(spec.audio.voiceover, to: comp, totalMs: totalMs) {
            params.append(p)
        }

        // An audio track that never received a segment makes AVAssetExportSession fail -11838
        // ("Operation Stopped", underlying -16976) before it writes a frame. This is not a corner
        // case: `wantsClipAudio` is decided from the spec, so a timeline of files that simply carry
        // no sound - a screen recording, a silent gallery pick - reaches here with an empty track
        // every time. Removing the track invalidates the parameters naming it, so they go together.
        for t in comp.tracks(withMediaType: .audio) where t.segments.isEmpty {
            comp.removeTrack(t)
            params.removeAll { $0.trackID == t.trackID }
        }

        var audioMix: AVMutableAudioMix?
        if !params.isEmpty {
            let mix = AVMutableAudioMix()
            mix.inputParameters = params
            audioMix = mix
        }

        let vc = AVMutableVideoComposition()
        // Plain init, never `videoComposition(propertiesOf:)` or the applyingCIFilters factory:
        // both derive renderSize and frameDuration from the source, and both refuse mutation. This
        // output is a fixed size at a fixed rate whatever the clips were shot at.
        vc.renderSize = plan.renderSize
        // fps is a MAXIMUM in the contract. The engine asks the compositor for one frame every
        // frameDuration, so a 60 fps source is decimated to it. A slower source is not
        // interpolated - the same picture is handed back again - and H.264 codes the repeat for
        // almost nothing. `sourceTrackIDForFrameTiming` stays invalid; pointing it at the video
        // track would pass a 60 fps source straight through and break the cap.
        vc.frameDuration = CMTime(value: 1, timescale: Int32(max(1, spec.output.fps)))
        vc.customVideoCompositorClass = EditCompositor.self
        // All three together, and only together. For a custom compositor these convert and tag the
        // source frames, so an HLG or PQ gallery pick arrives as 709 SDR instead of failing the
        // export. This is our analogue of Android's HDR_MODE_TONE_MAP_HDR_TO_SDR_USING_OPEN_GL.
        vc.colorPrimaries = AVVideoColorPrimaries_ITU_R_709_2
        vc.colorYCbCrMatrix = AVVideoYCbCrMatrix_ITU_R_709_2
        vc.colorTransferFunction = AVVideoTransferFunction_ITU_R_709_2
        // `renderScale` may only be other than 1 on a video composition set on an AVPlayerItem, and
        // `animationTool` is a Core Animation path we do not take - the overlays are already
        // bitmaps and the compositor draws them. Both stay at their defaults.
        //
        // AVMutableVideoCompositionLayerInstruction plays no part here either: the moment
        // `customVideoCompositorClass` is set, layer instructions are ignored and every transform -
        // orientation, fit, colour, overlays - happens inside EditCompositor.
        vc.instructions = entries.map { e in
            EditInstruction(timeRange: e.range,
                            trackID: video.trackID,
                            orientation: Orientation.imageOrientation(e.source.preferredTransform),
                            fit: e.clip.fit,
                            plan: plan)
        }

        #if DEBUG
        // The instructions must tile the timeline exactly, and a gap costs an
        // AVError.invalidVideoComposition (-11841) at export time. Apple's own validator
        // (`isValidForTracks:assetDuration:timeRange:validationDelegate:`) says the same thing
        // through a deprecated selector and a delegate; four lines here is cheaper and safer.
        var edge = CMTime.zero
        for instruction in vc.instructions {
            assert(instruction.timeRange.start == edge,
                   "video composition instruction gap or overlap at \(edge.seconds)s")
            edge = instruction.timeRange.end
        }
        assert(edge == total,
               "instructions end at \(edge.seconds)s but the composition ends at \(total.seconds)s")
        #endif

        return BuiltComposition(composition: comp,
                                videoComposition: vc,
                                audioMix: audioMix,
                                totalMs: totalMs,
                                plan: plan)
    }

    /// Android's `RenderPlan` gain, verbatim: a muted timeline or a muted clip is silent, and
    /// everything else is the clip's own volume scaled by the timeline's.
    private static func gain(of clip: ComposeClip, _ audio: ComposeAudio) -> Float {
        if audio.originalMuted || clip.muted { return 0 }
        return Float(min(1, max(0, clip.volume * audio.originalVolume)))
    }

    /// Lays the music out as explicit repetitions of the trimmed piece, which is what Android does:
    /// a looping sequence would repeat the leading gap, and a non-looping one longer than the video
    /// would extend the whole composition.
    private static func addMusic(_ m: ComposeMusic,
                                 to comp: AVMutableComposition,
                                 total: CMTime) async throws -> AVMutableAudioMixInputParameters? {
        // Music that starts after the video ends is not an error, it is a manifest whose timeline
        // got shorter after the track was picked. Android's planMusic returns null for it too.
        guard m.startMs < msOf(total) else { return nil }

        let src = try await audioSource(m.uri, key: "music")
        // The lab deliberately sends `outMs: 600000` against a track of a few seconds, so this
        // clamp carries real traffic. Handing the raw range to `insertTimeRange` is the single
        // most likely way to break the flow.
        let outEffMs = min(m.outMs, src.endMs)
        guard outEffMs > m.inMs else { throw BuildError.unreadable("music", "range outside file") }

        guard let track = comp.addMutableTrack(withMediaType: .audio,
                                               preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw BuildError.internalFailure("music track")
        }

        let piece = CMTimeRange(start: ms(m.inMs), end: ms(outEffMs))
        // Nothing pads the lead gap: the track is empty before the first insert and AVFoundation
        // writes that empty segment itself, which is Android's `addGap(leadGapUs)`.
        var at = ms(m.startMs)
        var slices = 0
        repeat {
            let room = total - at
            guard room > .zero else { break }
            // The last pass is clipped to the room left, never allowed past the end of the video.
            // That is Android's `lastLenUs = available - (reps - 1) * trackLen`.
            let slice = CMTimeRange(start: piece.start, duration: CMTimeMinimum(piece.duration, room))
            do {
                try track.insertTimeRange(slice, of: src.track, at: at)
            } catch {
                throw BuildError.unreadable("music", "insert: \(error)")
            }
            at = at + slice.duration
            slices += 1
        } while m.loop && at < total && slices < maxMusicSlices

        let presence = CMTimeRange(start: ms(m.startMs), end: at)
        guard presence.duration > .zero else { return nil }

        let p = AVMutableAudioMixInputParameters(track: track)
        p.audioTimePitchAlgorithm = .spectral
        // Android attaches the fade-in to the first repetition and the fade-out to the last, each
        // relative to that item's own start. On iOS this is one continuous track, so both windows
        // hang off the presence range instead - same two times, expressed once, and no fade at a
        // loop seam.
        Fades.apply(p,
                    presence: presence,
                    volume: Float(min(1, max(0, m.volume))),
                    fadeInMs: m.fadeInMs,
                    fadeOutMs: m.fadeOutMs)
        return p
    }

    /// All the takes onto one track, with one volume step each. The track and its parameters are
    /// created on the first take that survives the filter, so a list where every take is out of
    /// range adds nothing to the composition.
    private static func addVoiceovers(_ takes: [ComposeVoiceover],
                                      to comp: AVMutableComposition,
                                      totalMs: Int64) async throws -> AVMutableAudioMixInputParameters? {
        guard !takes.isEmpty else { return nil }

        var track: AVMutableCompositionTrack?
        var params: AVMutableAudioMixInputParameters?
        var cursorMs: Int64 = 0

        // Sorted by start, and an overlapping take is DROPPED rather than shifted.
        // `insertTimeRange(at:)` is an insert, not an overwrite: any media already at that time is
        // pushed later, so one out-of-order take would ripple every take after it, and its volume
        // step with it, silently. Android drops the offending take; the editor prevents overlaps in
        // the first place, so this only ever fires for a manifest that arrived broken.
        for take in takes.sorted(by: { $0.startMs < $1.startMs }) {
            if take.startMs >= totalMs { continue }
            if take.startMs < cursorMs { continue }

            let src = try await audioSource(take.uri, key: "voiceover")
            // Android's `min(source duration, totalUs - startUs)` with the manifest's own duration
            // folded in, which is what it does one level up in the parser.
            let lenMs = min(min(take.durationMs, src.endMs), totalMs - take.startMs)
            if lenMs <= 0 { continue }

            let dest: AVMutableCompositionTrack
            if let existing = track {
                dest = existing
            } else {
                guard let created = comp.addMutableTrack(withMediaType: .audio,
                                                         preferredTrackID: kCMPersistentTrackID_Invalid) else {
                    throw BuildError.internalFailure("voiceover track")
                }
                let p = AVMutableAudioMixInputParameters(track: created)
                p.audioTimePitchAlgorithm = .spectral
                track = created
                params = p
                dest = created
            }

            // Every take plays from its own beginning; the manifest trims by duration, not by an in
            // point.
            do {
                try dest.insertTimeRange(CMTimeRange(start: .zero, duration: ms(lenMs)),
                                         of: src.track, at: ms(take.startMs))
            } catch {
                throw BuildError.unreadable("voiceover", "insert: \(error)")
            }
            params?.setVolume(Float(min(1, max(0, take.volume))), at: ms(take.startMs))
            cursorMs = take.startMs + lenMs
        }
        return params
    }

    /// Opens a music or voiceover file and answers its single audio track plus that track's end in
    /// milliseconds. Every AVFoundation failure becomes `unreadable_input` with `key` as the
    /// `clipKey`, so a failure points at the part of the spec at fault rather than at a clip.
    private static func audioSource(_ uri: String, key: String) async throws -> AudioSource {
        guard let url = JobFolders.fileURL(from: uri) else {
            throw BuildError.unreadable(key, "unsupported uri")
        }
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        do {
            guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
                throw BuildError.unreadable(key, "no audio track")
            }
            let range = try await track.load(.timeRange)
            return AudioSource(asset: asset, track: track, endMs: msOf(range.end))
        } catch let already as BuildError {
            throw already
        } catch {
            throw BuildError.unreadable(key, "\(error)")
        }
    }
}

enum Fades {
    /// Android's `RampGainProvider` is a multiplicative curve evaluated per sample and linear in
    /// amplitude: `gain = level * fadeIn(t) * fadeOut(t)`. A `setVolumeRamp` between two scalars is
    /// that same straight line, so two ramps over the presence range reproduce it exactly.
    static func apply(_ p: AVMutableAudioMixInputParameters, presence: CMTimeRange,
                      volume: Float, fadeInMs: Int64, fadeOutMs: Int64) {
        // The plateau. A ramp holds its end volume afterwards, so the fade-in already carries the
        // level across the middle; this step is what sets the level when there is no fade-in at
        // all, because AVFoundation's volume before the first one set is 1.0, not ours. Setting it
        // at zero rather than at `presence.start` is harmless: the track is silent before then.
        p.setVolume(volume, at: .zero)

        // Android lets the two windows overlap on a very short item and multiplies them, because it
        // evaluates a function. AVFoundation cannot - overlapping ramps are undefined - so each
        // fade gets at most half the presence. With the v1 values (0 or 400 ms) any presence longer
        // than 800 ms is identical to Android.
        let halfMs = msOf(presence.duration) / 2
        let fadeIn = min(max(0, fadeInMs), halfMs)
        let fadeOut = min(max(0, fadeOutMs), halfMs)

        if fadeIn > 0 {
            p.setVolumeRamp(fromStartVolume: 0, toEndVolume: volume,
                            timeRange: CMTimeRange(start: presence.start, duration: ms(fadeIn)))
        }
        if fadeOut > 0 {
            p.setVolumeRamp(fromStartVolume: volume, toEndVolume: 0,
                            timeRange: CMTimeRange(start: presence.end - ms(fadeOut),
                                                   duration: ms(fadeOut)))
        }
    }
}
