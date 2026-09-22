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

/// One video layer's clips after they have been placed, and what the instructions need to name it.
/// The base track is always the first of these and carries z 0 and full opacity.
private struct LayerTimeline {
    let trackID: CMPersistentTrackID
    let z: Int
    let opacity: Double
    let entries: [TimelineEntry]
}

/// One transition on the OUTPUT timeline: where it runs, what runs under it, and how it is drawn.
///
/// The window starts where the incoming clip starts and lasts `min(tail, incoming)`, which on every
/// spec the editor builds is simply the tail's own length. Windows never overlap one another, and
/// that is structural rather than hoped for: each lies inside its incoming clip's placed range, and
/// the base clips' ranges do not overlap.
private struct TransitionWindow {
    /// Which base entry is the incoming clip.
    let entry: Int
    let startMs: Int64
    let durMs: Int64
    /// The outgoing clip's tail as it was placed on the tail track: `range` IS the window.
    let tail: TimelineEntry
    let tailTrackID: CMPersistentTrackID
    let transition: ComposeTransition

    var endMs: Int64 { startMs + durMs }
    var range: CMTimeRange { CMTimeRange(start: ms(startMs), duration: ms(durMs)) }
}

/// The one extra video track every outgoing tail of a post is laid on, and the one extra audio track
/// its sound goes to, each created on the first tail that needs it.
///
/// One of each is enough because the editor holds every transition to half of either clip it joins:
/// a clip's own incoming and outgoing transitions then never overlap, so the tails never do either,
/// and a composition track - which holds segments that do not overlap - can hold every one of them.
/// A post without transitions never creates either track, which is what keeps its composition the
/// one this engine has always built.
private final class TailTracks {
    private(set) var video: AVMutableCompositionTrack?
    private(set) var audio: AVMutableCompositionTrack?
    /// Its own parameters, because the tails fade OUT while the base clips fade in, and one set of
    /// parameters holds one volume at a time.
    private(set) var params: AVMutableAudioMixInputParameters?
    /// Where the last tail laid down ends. An insert is an insert and not an overwrite, so a tail
    /// starting before this would push the one before it later instead of sitting beside it.
    var endMs: Int64 = 0

    func videoTrack(in comp: AVMutableComposition) throws -> AVMutableCompositionTrack {
        if let existing = video { return existing }
        guard let created = comp.addMutableTrack(withMediaType: .video,
                                                 preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw BuildError.internalFailure("transition video track")
        }
        video = created
        return created
    }

    func audioTrack(in comp: AVMutableComposition) throws -> AVMutableCompositionTrack {
        if let existing = audio { return existing }
        guard let created = comp.addMutableTrack(withMediaType: .audio,
                                                 preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw BuildError.internalFailure("transition audio track")
        }
        let p = AVMutableAudioMixInputParameters(track: created)
        // `.spectral` for the reason the base clips' sound carries it: a tail keeps its clip's speed,
        // and the contract preserves pitch across a speed change.
        p.audioTimePitchAlgorithm = .spectral
        audio = created
        params = p
        return created
    }
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
/// The shape mirrors Android's: one video track holding the base clips back to back, one more for
/// each extra layer, and at most one audio track for each of those, for the music and for the
/// voiceovers. Concurrent Media3 sequences are how Android mixes; parallel composition tracks and
/// one `AVAudioMix` is how AVFoundation mixes. Neither platform needs a mixer of ours.
///
/// A post with transitions adds one video track and one audio track more, holding every outgoing
/// clip's tail at the moment its transition starts (see `TailTracks`). The base track is laid exactly
/// as it is without them, because the spec arrives with each outgoing clip already stopping where the
/// next one starts.
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
        let tails = TailTracks()
        var entries: [TimelineEntry] = []
        var windows: [TransitionWindow] = []
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

            // The outgoing clip's last moments, laid UNDER this clip's first ones. After this clip
            // is placed rather than before, because the window is `min(tail, this clip)` and this
            // clip's placed length is only known now. The parser never sets a transition on the
            // first clip; the count test says the same thing here, where a stray one would lay a
            // tail with nothing to come out of.
            if let transition = clip.transitionIn, entries.count > 1 {
                let window = try await addTail(transition, under: placed, entry: entries.count - 1,
                                               to: comp, tracks: tails, cache: cache, audio: spec.audio)
                if let window { windows.append(window) }
            }
        }

        // The TAIL: the post running on past its footage, so a layer can be laid AFTER the base
        // track rather than only beside it.
        //
        // A composition is as long as its longest track, and an empty range at the END of a track is
        // a documented no-op - so the length has to be claimed with media. One frame of the last
        // clip is appended and then SCALED across the whole tail: two operations on a range that is
        // already in the track, rather than an insert at a time past its end whose behaviour is not
        // worth depending on. Nothing after it ripples, because there is nothing after it.
        //
        // None of those pixels are ever drawn. `merged` gives every instant past the base's last
        // ENTRY an instruction with no layers in it - the tail adds media but no entry - and
        // `EditCompositor.render` starts each frame on black. So the tail composites to exactly the
        // black frame Android's trailing gap leaves there, and the browser renderer with it.
        //
        // A failure here is not a failure of the render: the post is then as long as its footage,
        // which is a shorter video than was asked for rather than a wrong one, and the same answer
        // an engine that ignored the key would give.
        let asked = ms(max(0, spec.durationMs))
        if asked > cursor, let last = entries.last {
            let source = last.source.videoRange
            let frame = CMTimeMinimum(CMTime(value: 1, timescale: 30), source.duration)
            do {
                try video.insertTimeRange(CMTimeRange(start: source.start, duration: frame),
                                          of: last.source.videoTrack, at: cursor)
                video.scaleTimeRange(CMTimeRange(start: cursor, duration: frame),
                                     toDuration: asked - cursor)
                cursor = asked
            } catch {
                // Left as it was: the composition is its footage and nothing is out of place.
            }
        }

        let total = cursor
        let totalMs = max(1, msOf(total))
        // The bottom layer, and the only one whose length counts: `totalMs` is the output's length
        // and every extra layer is cut to it.
        let base = LayerTimeline(trackID: video.trackID, z: 0, opacity: 1, entries: entries)
        var layers = [base]

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
            //
            // A clip a transition leads into FADES in instead, a straight line from silence to its
            // level across the window, while the outgoing clip's tail fades out on its own track
            // underneath: a crossfade, linear in amplitude like `Fades` and Android's
            // `RampGainProvider`. The ramp takes the place of the step rather than following it,
            // because a ramp sets the volume over its whole range, start included.
            for (index, e) in entries.enumerated() {
                if let window = windows.first(where: { $0.entry == index }) {
                    p.setVolumeRamp(fromStartVolume: 0, toEndVolume: e.gain, timeRange: window.range)
                } else {
                    p.setVolume(e.gain, at: e.range.start)
                }
            }
            params.append(p)
        }
        // The tails' own fades were set as each was laid (see `addTail`).
        if let p = tails.params { params.append(p) }

        // Ramps on one set of parameters must never overlap: AVFoundation leaves that undefined. They
        // cannot here, because every window lies inside its incoming clip and the clips do not
        // overlap, and the tails lie inside those same windows - which is exactly what this checks.
        assert(TransitionTiming.disjoint(entries.indices.map { index -> (startMs: Int64, endMs: Int64) in
            let startMs = msOf(entries[index].range.start)
            return (startMs: startMs, endMs: windows.first(where: { $0.entry == index })?.endMs ?? startMs)
        }), "a base clip's fade-in overlaps the next clip's volume")
        assert(TransitionTiming.disjoint(windows.map { (startMs: $0.startMs, endMs: $0.endMs) }),
               "two transition tails overlap")

        // Fifteen of these at the outside, which is where the parser stops counting. Each one gets
        // its own composition track and its own audio track, and nothing here is written for a
        // particular number of them: what makes N layers work rather than two is that the layers
        // array below is what the instructions are cut from.
        //
        // Nothing counts decoders either. A device that cannot open one more fails the export
        // through the AVError taxonomy in `Exporter`, with a code and a message, which is the honest
        // answer: the count is the customer's, and refusing a layout up front that this phone might
        // well have rendered is not.
        for track in spec.tracks ?? [] {
            guard let extra = try await addLayer(track, to: comp, cache: cache,
                                                 audio: spec.audio, totalMs: totalMs) else { continue }
            layers.append(extra.layer)
            if let p = extra.params { params.append(p) }
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

        // Absent means exactly today, decided here and never again: with no extra layer and no
        // transition there is no second timeline to merge, and this is the instruction list the
        // engine has always built - one per base clip, naming one source track and carrying one
        // layer. A transition retires it, because a window's end is a cut that no base clip has.
        if layers.count == 1 && windows.isEmpty {
            var instructions = base.entries.map { EditInstruction(timeRange: $0.range,
                                                                  layers: [editLayer($0, of: base, plan: plan)],
                                                                  plan: plan) }
            // A post stretched past its footage with no layer over the stretch. The instructions
            // must reach the composition's end all the same, and the stretch is black, which is an
            // instruction with no layers in it - the one `merged` gives the same instant.
            let footageEnd = base.entries.last?.range.end ?? .zero
            if total > footageEnd {
                instructions.append(EditInstruction(timeRange: CMTimeRange(start: footageEnd, end: total),
                                                     layers: [],
                                                     plan: plan))
            }
            vc.instructions = instructions
        } else {
            vc.instructions = merged(layers, windows: windows, totalMs: totalMs, plan: plan)
        }

        // The instructions must tile the timeline exactly, and a gap costs an
        // AVError.invalidVideoComposition (-11841) at export time - a number, with nothing to say
        // which instant was missing. So this is checked in EVERY build and thrown as a sentence.
        // Apple's own validator (`isValidForTracks:assetDuration:timeRange:validationDelegate:`)
        // says the same thing through a deprecated selector and a delegate; a loop here is cheaper.
        if let problem = tilingProblem(vc.instructions.map { $0.timeRange }, total: total) {
            throw BuildError.internalFailure(problem)
        }

        return BuiltComposition(composition: comp,
                                videoComposition: vc,
                                audioMix: audioMix,
                                totalMs: totalMs,
                                plan: plan)
    }

    /// What is wrong with the instruction ranges as a tiling of `[0, total)`, as a sentence for the
    /// failure, or nil when they tile it exactly: each starting where the last one ended, none of
    /// them empty (a zero-length instruction is the same -11841 as a gap), and the last ending at
    /// the composition's end.
    private static func tilingProblem(_ ranges: [CMTimeRange], total: CMTime) -> String? {
        var edge = CMTime.zero
        for range in ranges {
            if range.start != edge {
                return "video composition instruction gap or overlap at \(edge.seconds)s"
            }
            if range.duration <= .zero {
                return "empty video composition instruction at \(edge.seconds)s"
            }
            edge = range.end
        }
        if edge != total {
            return "instructions end at \(edge.seconds)s but the composition ends at \(total.seconds)s"
        }
        return nil
    }

    /// Lays the outgoing clip's tail - `transition.from` - on the tail track under the incoming clip,
    /// which has just been placed at `placed`, and answers the window it runs for. nil draws a cut.
    ///
    /// The tail goes in exactly as a base clip does: its source range clamped to its file, inserted
    /// at the incoming clip's start, then scaled by its own speed straight away. Straight away for the
    /// base clips' reason - `scaleTimeRange` ripples everything after the range it touches - though
    /// here nothing is ever after it, because every tail goes in later on the timeline than the one
    /// before. Its sound goes to the tail audio track at the same instant, clamped and scaled the
    /// same way, and fades from its level to silence across the window.
    ///
    /// Two things turn a transition into a cut rather than a failure, both of them a file that is
    /// shorter than the manifest believed: a tail that lies entirely past the end of its file, and a
    /// tail that would start before the one before it has finished. The second cannot happen on a
    /// spec the editor built, and is refused here because the insert would otherwise push the
    /// earlier tail later and take its picture out of step with the window it was drawn for.
    private static func addTail(_ transition: ComposeTransition,
                                under placed: CMTimeRange,
                                entry index: Int,
                                to comp: AVMutableComposition,
                                tracks tails: TailTracks,
                                cache: SourceCache,
                                audio: ComposeAudio) async throws -> TransitionWindow? {
        let from = transition.from
        let startMs = msOf(placed.start)
        guard startMs >= tails.endMs else { return nil }

        let src = try await cache.source(for: from)
        // Clamped to the VIDEO TRACK's end, for the base clips' reason: `insertTimeRange` does not
        // validate a range against its source, and over-reaching renders a black tail.
        let outMsEff = min(from.outMs, msOf(src.videoRange.end))
        let speed = min(maxSpeed, max(minSpeed, from.speed))
        guard let span = TransitionTiming.tail(sourceMs: outMsEff - from.inMs,
                                               speed: speed,
                                               roomMs: msOf(placed.duration)) else { return nil }

        let srcRange = CMTimeRange(start: ms(from.inMs), duration: ms(span.sourceMs))
        let video = try tails.videoTrack(in: comp)
        do {
            try video.insertTimeRange(srcRange, of: src.videoTrack, at: placed.start)
        } catch {
            // The tail's key is the outgoing clip's own, which is the clip a customer can do
            // something about.
            throw BuildError.unreadable(from.key, "insert: \(error)")
        }

        let tailGain = gain(of: from, audio)
        var audioTrack: AVMutableCompositionTrack?
        if tailGain > 0, let at = src.audioTrack, let aRange = src.audioRange {
            // Clamped to the audio track's own end, as every clip's sound is.
            let aEnd = CMTimeMinimum(srcRange.end, aRange.end)
            if aEnd > srcRange.start {
                let track = try tails.audioTrack(in: comp)
                // Inserted at the absolute output time, not at this track's end: the track is empty
                // between tails, and AVFoundation writes that empty segment itself. A failure drops
                // the tail's sound and keeps its picture, as a base clip's would.
                if (try? track.insertTimeRange(CMTimeRange(start: srcRange.start, end: aEnd),
                                               of: at, at: placed.start)) != nil {
                    audioTrack = track
                }
            }
        }

        var range = CMTimeRange(start: placed.start, duration: srcRange.duration)
        if speed != 1 {
            let scaled = ms(span.placedMs)
            video.scaleTimeRange(range, toDuration: scaled)
            // Only when this tail put sound in: otherwise the range is empty on that track, or runs
            // past its end, and there is nothing to scale.
            audioTrack?.scaleTimeRange(range, toDuration: scaled)
            range = CMTimeRange(start: placed.start, duration: scaled)
        }
        if audioTrack != nil {
            tails.params?.setVolumeRamp(fromStartVolume: tailGain, toEndVolume: 0, timeRange: range)
        }
        tails.endMs = msOf(range.end)

        return TransitionWindow(entry: index,
                                startMs: startMs,
                                durMs: span.placedMs,
                                tail: TimelineEntry(clip: from, source: src, range: range, gain: tailGain),
                                tailTrackID: video.trackID,
                                transition: transition)
    }

    /// Lays one extra layer onto its own composition track and answers where its clips landed.
    ///
    /// The shape is the base track's, with three differences. It starts at `startMs` rather than at
    /// zero, and nothing pads the gap: the track is empty before the first insert and AVFoundation
    /// writes that empty segment itself, which is what "the layer contributes nothing before its
    /// first clip" means in composition terms. Its sound goes to an audio track of its own, because
    /// it plays at the same time as the base's and one composition track cannot hold two things at
    /// once. And it is CUT at the base's end - the base decides the length of the output, so a
    /// layer that would run past it is trimmed rather than allowed to extend it.
    ///
    /// Answers nil when the layer contributes nothing at all, which is a layer starting after the
    /// base has ended. Nothing is added to the composition in that case: an empty video track is
    /// the same -11838 at export time that an empty audio track is.
    private static func addLayer(_ track: ComposeTrack,
                                 to comp: AVMutableComposition,
                                 cache: SourceCache,
                                 audio: ComposeAudio,
                                 totalMs: Int64) async throws
        -> (layer: LayerTimeline, params: AVMutableAudioMixInputParameters?)? {

        // Both tracks and the parameters are created on the first clip that actually needs them,
        // the way `addVoiceovers` creates its own, so a layer that turns out to contribute nothing
        // leaves no empty track behind for the exporter to choke on.
        var videoTrack: AVMutableCompositionTrack?
        var audioTrack: AVMutableCompositionTrack?
        var params: AVMutableAudioMixInputParameters?
        var entries: [TimelineEntry] = []
        var cursor = ms(track.startMs)

        for clip in track.clips {
            // What is left of the base, which is all the room this layer has. Once that is gone the
            // rest of the layer is cut: the base's length is the output's length.
            let roomMs = totalMs - msOf(cursor)
            guard roomMs > 0 else { break }

            let src = try await cache.source(for: clip)

            // Clamped to the VIDEO TRACK's end for the same reason the base clips are: nothing
            // validates a range against its source, and over-reaching renders a black tail.
            let outMsEff = min(clip.outMs, msOf(src.videoRange.end))
            guard outMsEff > clip.inMs else { throw BuildError.unreadable(clip.key, "empty range") }

            let speed = min(maxSpeed, max(minSpeed, clip.speed))
            // The cut to the base's end is made in SOURCE milliseconds, before the insert, so that
            // the speed change still means what the manifest said and so that nothing is demuxed
            // that no frame will ever show.
            let roomSrcMs = Int64((Double(roomMs) * speed).rounded(.toNearestOrAwayFromZero))
            let cutMs = min(outMsEff, clip.inMs + roomSrcMs)
            // Out of room rather than out of media, so the layer simply ends here. The clip is not
            // at fault and there is nothing to report.
            guard cutMs > clip.inMs else { break }

            let srcRange = CMTimeRange(start: ms(clip.inMs), end: ms(cutMs))

            let dest: AVMutableCompositionTrack
            if let existing = videoTrack {
                dest = existing
            } else {
                guard let created = comp.addMutableTrack(withMediaType: .video,
                                                         preferredTrackID: kCMPersistentTrackID_Invalid) else {
                    throw BuildError.internalFailure("layer video track")
                }
                videoTrack = created
                dest = created
            }
            do {
                try dest.insertTimeRange(srcRange, of: src.videoTrack, at: cursor)
            } catch {
                throw BuildError.unreadable(clip.key, "insert: \(error)")
            }

            let clipGain = gain(of: clip, audio)
            if clipGain > 0, let at = src.audioTrack, let aRange = src.audioRange {
                // Clamped to the audio track's own end, as the base clips' sound is: a file whose
                // sound stops before its picture is common enough to plan for.
                let aEnd = CMTimeMinimum(srcRange.end, aRange.end)
                if aEnd > srcRange.start {
                    let destAudio: AVMutableCompositionTrack
                    if let existing = audioTrack {
                        destAudio = existing
                    } else {
                        guard let created = comp.addMutableTrack(withMediaType: .audio,
                                                                 preferredTrackID: kCMPersistentTrackID_Invalid) else {
                            throw BuildError.internalFailure("layer audio track")
                        }
                        let p = AVMutableAudioMixInputParameters(track: created)
                        p.audioTimePitchAlgorithm = .spectral
                        audioTrack = created
                        params = p
                        destAudio = created
                    }
                    // A failure must not fail the render: the clip still has a picture, and Android
                    // would have dropped its audio too.
                    try? destAudio.insertTimeRange(CMTimeRange(start: srcRange.start, end: aEnd),
                                                   of: at, at: cursor)
                }
            }

            var placed = CMTimeRange(start: cursor, duration: srcRange.duration)
            if speed != 1 {
                // Clamped to the room left as well as floored at a millisecond: the source cut
                // above is a rounded number, and a rounding millisecond either way must not push
                // the layer past the base it was cut to.
                let scaledMs = min(roomMs, max(1, Int64((Double(cutMs - clip.inMs) / speed)
                    .rounded(.toNearestOrAwayFromZero))))
                let scaled = ms(scaledMs)
                dest.scaleTimeRange(placed, toDuration: scaled)
                audioTrack?.scaleTimeRange(placed, toDuration: scaled)
                placed = CMTimeRange(start: cursor, duration: scaled)
            }

            entries.append(TimelineEntry(clip: clip, source: src, range: placed, gain: clipGain))
            cursor = placed.end
        }

        guard let videoTrack else { return nil }
        // A step per clip, including the silent ones, exactly as the base track's are set.
        if let p = params { for e in entries { p.setVolume(e.gain, at: e.range.start) } }
        return (LayerTimeline(trackID: videoTrack.trackID,
                              z: track.z,
                              opacity: track.opacity,
                              entries: entries), params)
    }

    /// One clip of one layer as the compositor sees it. The rectangle and its angle are resolved
    /// into render pixels and radians HERE, at build time, so that a clip carrying neither a crop
    /// nor a rect costs the compositor nothing but a nil test per frame.
    private static func editLayer(_ e: TimelineEntry, of layer: LayerTimeline,
                                  plan: RenderPlan) -> EditLayer {
        EditLayer(trackID: layer.trackID,
                  orientation: Orientation.imageOrientation(e.source.preferredTransform),
                  fit: e.clip.fit,
                  crop: e.clip.crop,
                  rect: e.clip.rect,
                  opacity: layer.opacity,
                  render: plan.renderSize)
    }

    /// The outgoing side of one transition as the compositor draws it: the tail's clip on the tail
    /// track, framed exactly as that clip was framed on the base track a moment earlier, and at full
    /// opacity, because it IS the base while the transition runs.
    private static func editTransition(_ w: TransitionWindow, plan: RenderPlan) -> EditTransition {
        let t = w.transition
        return EditTransition(tail: EditLayer(trackID: w.tailTrackID,
                                              orientation: Orientation.imageOrientation(w.tail.source.preferredTransform),
                                              fit: w.tail.clip.fit,
                                              crop: w.tail.clip.crop,
                                              rect: w.tail.clip.rect,
                                              opacity: 1,
                                              render: plan.renderSize),
                              startUs: w.startMs * 1000,
                              durationUs: w.durMs * 1000,
                              curves: t.curves,
                              mask: t.mask,
                              fromTint: t.fromTint,
                              toTint: t.toTint)
    }

    /// The instruction timeline for two layers or more, or for any base track with a transition on it.
    ///
    /// An instruction names the source tracks it needs and the geometry of each, and both have to
    /// hold still for the whole of its range, so the cut points are the UNION of every layer's clip
    /// boundaries rather than the base's alone. Between two neighbouring cuts each layer is either
    /// showing exactly one clip or showing nothing at all, which is exactly what one instruction
    /// can describe.
    ///
    /// A transition window adds its END as a cut - its start is the incoming clip's start, a cut
    /// already - and every instruction inside it carries the window, so the base is drawn as the two
    /// sides of the transition instead of as one clip. A layer's boundary inside a window splits it
    /// into several instructions, which is why the window travels whole rather than as the part of it
    /// each instruction covers: the compositor measures progress against the window itself.
    private static func merged(_ layers: [LayerTimeline], windows: [TransitionWindow], totalMs: Int64,
                               plan: RenderPlan) -> [EditInstruction] {
        // Bottom to top by z, and a tie breaks on the order the spec listed them in, which is what
        // `ComposeTrack.z` promises. The base is first in this array and carries z 0, so it stays
        // under anything that ties with it. This is the whole of the ordering: with one extra layer
        // z was reliably 1 and any sort would have done, and with fifteen it is the only thing
        // saying which picture is on top.
        let ordered = layers.enumerated()
            .sorted { $0.element.z == $1.element.z ? $0.offset < $1.offset : $0.element.z < $1.element.z }
            .map { $0.element }

        // Milliseconds rather than CMTime: every boundary in here was built from a whole
        // millisecond, so nothing is lost, and the union needs something it can de-duplicate on.
        var cutsMs: Set<Int64> = [0, totalMs]
        for layer in ordered {
            for e in layer.entries {
                cutsMs.insert(msOf(e.range.start))
                cutsMs.insert(msOf(e.range.end))
            }
        }
        for w in windows {
            cutsMs.insert(w.startMs)
            cutsMs.insert(w.endMs)
        }
        let cuts = cutsMs.sorted()

        // Once per window rather than once per instruction: a window split by a layer's boundary is
        // still one transition, drawn from one description.
        let transitions = windows.map { editTransition($0, plan: plan) }
        // The base is `layers[0]`, which is where `build` put it.
        let baseTrackID = layers.first?.trackID

        return (0..<(cuts.count - 1)).map { i in
            let startMs = cuts[i]
            let drawn = ordered.compactMap { layer -> EditLayer? in
                // The clip this layer is showing at that instant, or none at all: before its first
                // clip and after its last a layer contributes nothing, not even a black frame, and
                // an instruction that does not name its track is how that is said.
                guard let e = layer.entries.first(where: {
                    msOf($0.range.start) <= startMs && startMs < msOf($0.range.end)
                }) else { return nil }
                return editLayer(e, of: layer, plan: plan)
            }
            // The compositor draws a transition in place of the FIRST layer, so one is attached only
            // when that layer is the base. Inside a window it always is - the incoming clip is on the
            // base there, and the base sorts under everything - and the test keeps a mistake in that
            // reasoning from drawing a transition in place of some other layer's clip.
            let transition: EditTransition? = drawn.first?.trackID == baseTrackID
                ? windows.firstIndex(where: { $0.startMs <= startMs && startMs < $0.endMs }).map { transitions[$0] }
                : nil
            return EditInstruction(timeRange: CMTimeRange(start: ms(startMs), end: ms(cuts[i + 1])),
                                   layers: drawn,
                                   transition: transition,
                                   plan: plan)
        }
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
