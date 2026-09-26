@preconcurrency import AVFoundation
import CoreImage
import CoreImage.CIFilterBuiltins
import CoreMedia
import CoreVideo
import Foundation
import os

// The frame source of slow motion: a slowed clip's REAL frame times, and its decoded frames by index.
//
// `EditCompositor.render` is handed one frame per track per output instant - `request.sourceFrame(byTrackID:)` -
// with no timestamp and no neighbour. Phase 1 and phase 2 both need two neighbouring source frames and where the
// instant falls between them, on the file's own clock. Nothing on `AVAsynchronousVideoCompositionRequest` gives
// either, on any iOS from 16 to 26: `sourceSampleBuffer(byTrackID:)` is for sample-DATA tracks and answers nil for
// a video track (measured), and the iOS 26 additions (`sourceReadOnlyPixelBuffer`, `sourceReadySampleBuffer`,
// tagged buffers) are the same one frame in new clothes. So a slowed clip reads its own file, twice over: once for
// the list of frame times, which is cheap, and once for the pictures, which is a second decode of the clip.
//
// Everything here is on the TRACK timeline of the source asset: the timeline `insertTimeRange(_:of:at:)` takes
// its range on, with the track's edit list applied. That is the one thing the two AVFoundation paths into a file
// disagree on, and it is the trap in this file (see `ClipFrameListing`).

/// The frames of one clip's file as the renderer searches them: ascending, each frame once, merged exactly as
/// `SlowMotion.frameTimes` merges them, on the source track's timeline.
///
/// `seconds` is what `SlowMotion.framePairAt` searches and `stamps` is the same list as exact `CMTime`s, which
/// is what a reader is started at: a `CMTime` round-tripped through a Double can land a tick either side of the
/// frame it names, and a reader started a tick late skips the frame. `stamps[i]` is `seconds[i]` always.
struct ClipFrameTimes: Sendable {
    let seconds: [Double]
    let stamps: [CMTime]

    var count: Int { seconds.count }
}

enum ClipFrameError: Error {
    /// The track has no frame at all in or before the window: nothing to draw from.
    case noFrames
    /// A reader would not start, or failed part-way; `underlying` is its `error`.
    case readerFailed(underlying: Error?)
    /// The decoder ran past frame `index` without ever delivering it, or finished before it. The listing and
    /// the decoder disagree about the file, which is a reason to stop trusting this clip rather than to guess.
    case missingFrame(index: Int)
}

enum ClipFrameListing {

    /// The frames of `track` a clip playing `window` of it can be drawn from: every frame presented before
    /// `window.end`, from the last one presented at or before `window.start` onwards, on the TRACK timeline.
    ///
    /// The frame at or before the in point is included on purpose, although it is not the clip's own:
    /// `framePairAt` draws "the frame that covers the instant" for a clip too short to hold a frame of its own,
    /// and that frame is this one. In every other case `framePairAt`'s window keeps it out of the picture; this
    /// list only has to contain it.
    ///
    /// Throws `noFrames` when nothing is presented before the out point - there is nothing to draw from, and the
    /// clip keeps today's path - and `readerFailed` when the fallback read will not run.
    ///
    /// `segments` is `track.segments` and `cursors` is `track.canProvideSampleCursors`, both loaded by the caller
    /// (the builder, which is async: `try await video.load(.segments, .canProvideSampleCursors)`). On iOS both are
    /// async-only properties in Swift, and this has to be callable from a synchronous context.
    ///
    /// Two routes to the same answer, and the tests prove they give the SAME list:
    ///
    /// - `AVSampleCursor` (iOS 16+, what `cursors` says the track supports): positioned by
    ///   `makeSampleCursor(presentationTimeStamp:)` at the last sample presented at or before the in point -
    ///   exactly, because the builder opens every asset with `AVURLAssetPreferPreciseDurationAndTimingKey` - and
    ///   stepped forward in presentation order. It reads the sample table and decodes nothing: a whole 90-frame
    ///   file lists in 0.04 ms on an M1 Pro, a 6 s window (180 frames, 720x1280 or 1080p) in 0.2 ms, on macOS and
    ///   on the iOS 16.4 simulator alike.
    /// - A compressed read (`AVAssetReaderTrackOutput` with nil `outputSettings`): the documented way to get
    ///   samples with their timestamps without decoding them. It hands them over in DECODE order and from the
    ///   sync sample before the window - measured, [1.4, 1.7) of a 1 s GOP comes back as 22 or 23 samples
    ///   from 1.0 - so the list is sorted and cut here. 8.5-11 ms for a 6 s window on the Mac, 22-28 ms on the
    ///   iOS 16.4 simulator: forty to a hundred times the cursor, so the fallback only.
    ///
    /// THE TRAP. Both routes answer in the track's MEDIA time, before its edit list, while a decoding reader and
    /// the composition work in TRACK time, after it. Any H.264 or HEVC file with B-frames written by ffmpeg, and
    /// plenty written by other tools, carries an edit list whose media time is the reorder delay, so the first
    /// frame is stored at media time 0.0667 and presented at 0. Skip the mapping below and every frame time in
    /// such a file is two frames late, every A is the wrong picture and every w is off by the same amount -
    /// measured, 0.0667 s on the test media. Each sample is therefore mapped through the segment that holds
    /// it (`CMTimeMapTimeFromRangeToRange`, which also honours a scaled edit), clamped to where that segment
    /// starts on the track as a decoding reader clamps it, and dropped if it falls outside every segment.
    static func frames(of track: AVAssetTrack, in asset: AVAsset, segments: [AVAssetTrackSegment],
                       window: CMTimeRange, cursors: Bool) throws -> ClipFrameTimes {
        // Only the non-empty segments that reach the window's part of the track: an empty edit has no media, and
        // a segment wholly after the out point can contribute nothing. One whose end is before the in point can
        // still hold the frame that covers the in point, so it is kept.
        let live = segments.filter { !$0.isEmpty && $0.timeMapping.target.start < window.end }
        var found: [CMTime] = []
        if cursors {
            for segment in live { found += cursorTimes(track, segment: segment, window: window) }
        } else {
            found = try compressedTimes(track, in: asset, segments: live, window: window)
        }
        let times = cut(found, to: window)
        guard times.count > 0 else { throw ClipFrameError.noFrames }
        return times
    }

    /// The samples of one segment on the track timeline, through a sample cursor.
    private static func cursorTimes(_ track: AVAssetTrack, segment: AVAssetTrackSegment,
                                    window: CMTimeRange) -> [CMTime] {
        let map = segment.timeMapping
        // Where the in point is in this segment's MEDIA, so the cursor lands on the frame covering it; a
        // segment that starts after the in point is read from its own start.
        let from = CMTimeMaximum(window.start, map.target.start)
        let until = CMTimeMinimum(window.end, map.target.end)
        let mediaFrom = CMTimeMapTimeFromRangeToRange(from, fromRange: map.target, toRange: map.source)
        guard let cursor = track.makeSampleCursor(presentationTimeStamp: mediaFrom) else { return [] }
        var times: [CMTime] = []
        // Bounded by the segment's media as well as by the out point: a cursor steps through the whole
        // track, past where this edit stops using it.
        repeat {
            let pts = cursor.presentationTimeStamp
            guard pts.isNumeric, pts < map.source.end else { break }
            let t = trackTime(pts, map)
            guard t < until else { break }
            times.append(t)
        } while cursor.stepInPresentationOrder(byCount: 1) == 1
        return times
    }

    /// The same list through a compressed read, for a track that cannot provide cursors.
    private static func compressedTimes(_ track: AVAssetTrack, in asset: AVAsset, segments: [AVAssetTrackSegment],
                                        window: CMTimeRange) throws -> [CMTime] {
        let reader: AVAssetReader
        do { reader = try AVAssetReader(asset: asset) } catch { throw ClipFrameError.readerFailed(underlying: error) }
        // The reader's range is on the TRACK timeline and reaches back to the sync sample before it by itself.
        reader.timeRange = window
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw ClipFrameError.readerFailed(underlying: nil) }
        reader.add(output)
        guard reader.startReading() else { throw ClipFrameError.readerFailed(underlying: reader.error) }
        defer { reader.cancelReading() }
        var times: [CMTime] = []
        while let buffer = output.copyNextSampleBuffer() {
            // A compressed buffer may carry several samples, and the reader also hands over buffers with NONE -
            // an `EditBoundary` marker at each end of the range, measured - whose timing is not a frame's.
            let count = CMSampleBufferGetNumSamples(buffer)
            guard count > 0 else { continue }
            var timing = [CMSampleTimingInfo](repeating: CMSampleTimingInfo(), count: count)
            var filled = 0
            guard CMSampleBufferGetSampleTimingInfoArray(buffer, entryCount: count, arrayToFill: &timing,
                                                         entriesNeededOut: &filled) == noErr else { continue }
            for info in timing.prefix(filled) {
                let pts = info.presentationTimeStamp
                guard pts.isNumeric,
                      let segment = segments.first(where: { $0.timeMapping.source.containsTime(pts) })
                        ?? segments.first(where: { pts < $0.timeMapping.source.start })
                else { continue }
                times.append(trackTime(pts, segment.timeMapping))
            }
        }
        if reader.status == .failed { throw ClipFrameError.readerFailed(underlying: reader.error) }
        return times
    }

    /// A media timestamp on the track timeline through its segment, clamped to the segment's start the way a
    /// decoding reader stamps the frame that is already on screen when an edit begins.
    private static func trackTime(_ media: CMTime, _ map: CMTimeMapping) -> CMTime {
        CMTimeMaximum(map.target.start, CMTimeMapTimeFromRangeToRange(media, fromRange: map.source, toRange: map.target))
    }

    /// Sorted, merged as `SlowMotion.frameTimes` merges, and cut to the window: from the last frame at or before
    /// the in point, up to but not including the out point.
    static func cut(_ found: [CMTime], to window: CMTimeRange) -> ClipFrameTimes {
        let sorted = found.filter { $0.isNumeric }.sorted { $0 < $1 }
        var stamps: [CMTime] = []
        var seconds: [Double] = []
        for t in sorted {
            let s = t.seconds
            // Measured against the last one KEPT, like `frameTimes`, so the Double list below is exactly
            // `SlowMotion.frameTimes(sorted.map(\.seconds))` - a test holds it to that.
            if let last = seconds.last, !(s - last > SlowMotion.SAME_FRAME_S) { continue }
            stamps.append(t)
            seconds.append(s)
        }
        let start = window.start.seconds, end = window.end.seconds
        // The last frame at or before the in point, within the tolerance two frames are told apart by.
        let first = seconds.lastIndex { $0 <= start + SlowMotion.SAME_FRAME_S } ?? 0
        let last = (seconds.firstIndex { $0 >= end } ?? seconds.count) - 1
        guard first <= last else { return ClipFrameTimes(seconds: [], stamps: []) }
        return ClipFrameTimes(seconds: Array(seconds[first...last]), stamps: Array(stamps[first...last]))
    }
}

/// A one-clip composition over a slowed clip's WHOLE source track, converted the way the export converts it:
/// where a `ClipFrameDecoder` reads its pictures from. Immutable once made, so one instance can be shared by
/// every reader of the clip and made wherever is convenient - the builder, which already has the loaded track,
/// is the natural place, and it makes one per source file however many slowed clips cut from it.
///
/// WHY A COMPOSITION AND NOT A TRACK READER. A slowed clip's frames are drawn in place of the frames
/// `request.sourceFrame` hands the compositor, so they must be those frames byte for byte - otherwise a clip
/// changes colour the moment it slows down, and every on-a-frame instant of a slowed clip differs from the same
/// clip at 1x. Measured against the frames AVFoundation hands a custom compositor with EditCompositor's settings
/// (32BGRA, Metal-compatible, `supportsHDRSourceFrames` and `supportsWideColorSourceFrames` false, the video
/// composition's BT.709 triple):
///
/// - an `AVAssetReaderTrackOutput` asked for 32BGRA plus that triple as `AVVideoColorPropertiesKey`: on macOS 26
///   byte-identical for 709- and 601-tagged SDR, but NOT for HDR. On an HLG and a PQ file it differs on 4-5% of
///   pixels, up to 255 code values, mean 1.9 and 2.2: the reader's conversion (the same one
///   VTPixelTransferSession makes - measured identical to it) gamut-maps saturated BT.2020 colours differently
///   from the composition, yellow turning orange. Without the 709 key it is worse (mean 6.9 and 9.1). On the
///   iOS 16.4 simulator the same reader is off by 2 on the 601-tagged file, by 16 on HLG, and cannot decode the
///   PQ file at all (-11821): not even stable across OS versions.
/// - this: the clip's track in a one-track `AVComposition` read through an
///   `AVAssetReaderVideoCompositionOutput` whose video composition is the export's colour triple, frame timing
///   taken from the source track, and a pass-through compositor with EditCompositor's source attributes: the
///   SAME conversion by construction, and measured byte-identical on 709, 601, HLG, PQ and rotated files on
///   both runtimes, with every source frame delivered once at its real presentation time on CFR and VFR files.
///
/// An iPhone records HLG by default, so the common gallery pick is exactly the case a track reader gets wrong.
/// `SlowMotionRenderTests` holds the SDR case in the kit, upright and turned: a slowed clip's on-a-frame
/// instants draw the contract's frame A, and that is byte for byte the frame the composition converts. A is
/// also the composition's OWN frame at that instant - `.off`'s - except where AVFoundation's scaled-segment
/// mapping rounds an exact coincidence of the source time with a frame's time down to the frame before
/// (measured: a 90 kHz VFR file at 0.3x, 4 of 300 instants); there this draws the later frame, as the web does,
/// so identity with `.off` inside a slowed window is not a test of anything. `SlowMotionFramesTests` holds
/// the shared source format that makes the colour match (`CompositorSourceFormat`); the HDR and 601 probes
/// need files the tests cannot write, and their numbers are recorded with the stage that measured them.
///
/// The track is inserted whole at its own start, so this composition's timeline IS the source track's timeline:
/// the frame times `ClipFrameListing` lists, the clip's window and every reader's time range need no mapping.
/// Where the track has an empty edit - before its first frame, for a file whose video starts after its sound,
/// or in the middle - the composition composes with no source frame, and `ClipFramePassthrough` answers with a
/// blank that the decoder never delivers.
final class ClipFrameComposition: @unchecked Sendable {
    let composition: AVComposition
    let videoComposition: AVVideoComposition
    /// Held for the composition's sake, strongly and on purpose: `AVAssetTrack.asset` is weak and an
    /// `AVComposition` does NOT keep the assets its segments come from alive, and a reader over one whose source
    /// asset has gone fails at `startReading` with -11841 (invalid video composition) - measured, when a test let
    /// its `AVURLAsset` go after building this. Every `SlowClip` holds its file through this.
    let source: AVAsset

    /// `asset` is the asset `track` belongs to and `trackRange` the track's whole time range. `colorPrimaries`,
    /// `transferFunction` and `yCbCrMatrix` must be the export's own video composition's (`OutputColor`): parity
    /// is only as good as that match.
    init(asset: AVAsset, track: AVAssetTrack, trackRange: CMTimeRange, naturalSize: CGSize, nominalFrameRate: Float,
         colorPrimaries: String, transferFunction: String, yCbCrMatrix: String) throws {
        source = asset
        let comp = AVMutableComposition()
        guard let video = comp.addMutableTrack(withMediaType: .video,
                                               preferredTrackID: kCMPersistentTrackID_Invalid) else {
            throw ClipFrameError.readerFailed(underlying: nil)
        }
        try video.insertTimeRange(trackRange, of: track, at: trackRange.start)
        let vc = AVMutableVideoComposition()
        vc.renderSize = naturalSize
        // The source track sets the timing - every one of its frames, at its own time, VFR included (measured:
        // 90 of 90 frames, each at ffprobe's pts within 4.4e-7 s, whatever frameDuration is). frameDuration
        // then only matters over an empty edit, where the engine composes at this rate with no source frame -
        // `ClipFramePassthrough` answers those instants with a blank the decoder never delivers; the source's
        // own nominal rate is the natural one, 30 when the file does not say.
        vc.sourceTrackIDForFrameTiming = video.trackID
        let fps = nominalFrameRate.isFinite && nominalFrameRate > 0 ? nominalFrameRate : 30
        vc.frameDuration = CMTime(value: 1, timescale: CMTimeScale(max(1, min(1000, fps.rounded()))))
        vc.customVideoCompositorClass = ClipFramePassthrough.self
        vc.colorPrimaries = colorPrimaries
        vc.colorTransferFunction = transferFunction
        vc.colorYCbCrMatrix = yCbCrMatrix
        vc.instructions = [ClipFramePassthrough.Instruction(
            timeRange: CMTimeRange(start: .zero, end: trackRange.end), trackID: video.trackID)]
        composition = comp.copy() as! AVComposition
        videoComposition = vc.copy() as! AVVideoComposition
    }
}

/// The compositor of a `ClipFrameComposition`: hands each source frame back untouched, so what comes out of the
/// reader is exactly what AVFoundation converted it to on the way in - which, because its source attributes and
/// its HDR and wide-colour answers are EditCompositor's (`CompositorSourceFormat`, shared by construction and
/// held equal by `SlowMotionFramesTests`), is exactly what EditCompositor itself is handed. That is the whole of
/// the parity.
final class ClipFramePassthrough: NSObject, AVVideoCompositing, @unchecked Sendable {
    var sourcePixelBufferAttributes: [String: any Sendable]? = CompositorSourceFormat.attributes
    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = CompositorSourceFormat.attributes
    var supportsHDRSourceFrames: Bool { CompositorSourceFormat.supportsHDR }
    var supportsWideColorSourceFrames: Bool { CompositorSourceFormat.supportsWideColor }

    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    // Synchronous: there is nothing to render, only a buffer to hand back, so there is no queue to hop to and
    // nothing a cancellation could interrupt.
    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        if let id = request.sourceTrackIDs.first,
           let frame = request.sourceFrame(byTrackID: CMPersistentTrackID(truncating: id)) {
            request.finish(withComposedVideoFrame: frame)
            return
        }
        // No source frame: an instant before the track's first frame, or inside an empty edit of it. The
        // composition's one instruction covers [0, the track's end) - empty edits included, at the start of a
        // file whose video begins after its sound, or in the middle of one cut and rejoined - and the engine
        // composes there with nothing to hand over. And a decoder reads there on purpose: it starts every
        // reader just BEFORE the frame it wants (see `ClipFrameDecoder.start`), which for a file whose first
        // frame is later than zero is inside that empty edit.
        //
        // An error here would fail the whole reader, and the decoder with it - the whole slowed clip back to
        // repeated frames for one instant nobody draws. So the instant gets a blank picture instead. Its
        // contents never matter: it is stamped at a time that is no listed frame's - the reader's restamped
        // start, or a time before the next listed frame - so `ClipFrameDecoder.read` skips it, and nothing
        // the clip draws, its frame times or `.off`'s frames change.
        if let blank = request.renderContext.newPixelBuffer() {
            request.finish(withComposedVideoFrame: blank)
        } else {
            request.finish(with: ClipFrameError.readerFailed(underlying: nil))
        }
    }

    func cancelAllPendingVideoCompositionRequests() {}

    final class Instruction: NSObject, AVVideoCompositionInstructionProtocol, @unchecked Sendable {
        let timeRange: CMTimeRange
        let enablePostProcessing = false
        let containsTweening = true
        let requiredSourceTrackIDs: [NSValue]?
        // Invalid on purpose: a pass-through instruction skips the compositor AND, with it, the guarantee that
        // the frame went through the conversion a custom compositor's frames go through.
        let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid
        init(timeRange: CMTimeRange, trackID: CMPersistentTrackID) {
            self.timeRange = timeRange
            requiredSourceTrackIDs = [NSNumber(value: trackID)]
        }
    }
}

/// Decodes one slowed clip's frames by INDEX into its `ClipFrameTimes`, forward, holding the last two.
///
/// The compositor asks for frames in the order output time visits them, and a slowed clip visits each source
/// frame several times over (at 0.3x each pair is drawn three or four times) and moves on one frame at a time.
/// So this keeps the two most recent frames it decoded, which is exactly A and B, and reads forward whenever a
/// newer one is wanted. Asking for an EARLIER frame than the reader has passed - which an export never does, and a
/// cancelled and restarted request stream can - starts a fresh reader at that frame. Nothing is decoded twice in
/// the common case, and nothing is decoded ahead of need.
///
/// NOT thread safe, and not meant to be: AVAssetReader is `NS_SWIFT_NONSENDABLE`, and the compositor renders
/// every frame on one serial queue. The compositor creates one per slowed clip on that queue, calls it only
/// from that queue, and drops it there.
///
/// Every failure throws, and the compositor answers any throw by drawing that clip the way it always has, from
/// `request.sourceFrame`, for the rest of the job. A picture that is a frame out is worse than one that stutters.
final class ClipFrameDecoder {

    /// 32BGRA because it is what the compositor's CIContext reads without a conversion and what the flow's Metal
    /// textures are made from, and the format the compositor's own source frames are in; Metal-compatible and
    /// IOSurface-backed so a `CVMetalTextureCache` can wrap them without a copy.
    static let pixelAttributes: [String: any Sendable] = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferMetalCompatibilityKey as String: true,
        kCVPixelBufferIOSurfacePropertiesKey as String: [String: any Sendable](),
    ]

    private let source: ClipFrameComposition
    let frames: ClipFrameTimes
    /// Where reading stops: the clip's out point, past which no frame of this clip is ever wanted.
    private let end: CMTime

    private var reader: AVAssetReader?
    private var output: AVAssetReaderOutput?
    /// The time the current reader was started at when that is no listed frame's (see `start`): a picture the
    /// reader stamps with exactly this time is the one already on screen there, restamped, and is skipped.
    /// `.invalid` when the start IS a frame's time - only ever the file's first frame at zero, with nothing
    /// before it to restamp.
    private var restamped: CMTime = .invalid
    /// The index the next matching decoded frame will be: every frame before it has been delivered or passed.
    private var next = 0
    /// At most two, oldest first: the sliding window.
    private var held: [(index: Int, frame: CVPixelBuffer)] = []

    /// How many readers this decoder has started, and how many pictures they decoded. TESTS ONLY
    /// (`SlowMotionFramesTests` - `testReadingForwardAnswersEveryFrameWithItsOwnPicture`,
    /// `testASlowedClipsAccessPatternReadsEachFrameOnce` and `testAnEarlierFrameStartsAFreshReaderAndALaterOneDoesNot`
    /// - holds a forward pass to one reader and each frame to one decode); neither is part of the contract and the
    /// render never reads them.
    private(set) var starts = 0
    private(set) var decoded = 0

    /// `frames` is the clip's `ClipFrameListing` answer and `end` its out point, both on the source track's
    /// timeline, which is `source`'s timeline too. `source` keeps the file's asset alive.
    init(source: ClipFrameComposition, frames: ClipFrameTimes, end: CMTime) {
        self.source = source
        self.frames = frames
        self.end = end
    }

    deinit { reader?.cancelReading() }

    /// The decoded frame `index` of `frames`, 32BGRA, converted as the export converts the frames it hands the
    /// compositor. The same buffer is answered for the same index while it is held, so A and B of one pair cost
    /// one decode each however many output frames draw them.
    ///
    /// The buffer belongs to the reader's pool and is not written again while anyone holds it; a caller may keep
    /// it past the next call (a pending CIImage does) at the cost of the pool growing by one.
    func frame(_ index: Int) throws -> CVPixelBuffer {
        // A throw, not a precondition: an index the listing does not have is a bug in the caller, and a bug in
        // the render path must cost a stutter, never the app.
        guard index >= 0, index < frames.count else { throw ClipFrameError.missingFrame(index: index) }
        if let hit = held.first(where: { $0.index == index }) { return hit.frame }
        // Earlier than what the reader has already passed: a fresh reader at that frame. Forward is always
        // read through, never sought: a slowed clip moves a frame at a time, and a restart costs the decode from
        // the previous sync sample, which is more than the few frames any forward step skips.
        if reader == nil || index < next { try start(at: index) }
        return try read(until: index)
    }

    /// Drops the reader and both frames. The decoder stays usable; the next `frame` starts a reader again.
    func release() {
        reader?.cancelReading()
        reader = nil
        output = nil
        held.removeAll()
        next = 0
    }

    private func start(at index: Int) throws {
        release()

        // Started just BEFORE the frame, never on it. A decoding reader's first picture is the one on screen at
        // the range's start, restamped with the start's time - and when the start is exactly a frame's time it
        // is the frame before, restamped one tick early (measured on a track reader and on this composition
        // alike: [1.4, ...) of a 30 fps file begins with frame 41 at 1.399989, then frame 42 at 1.4). On a fine
        // enough timescale that tick is inside the tolerance and the previous picture would pass for the one
        // asked for. Halfway back to the previous listed frame (a millisecond back for the first) is a time that
        // is no frame's, so whatever the reader restamps to it is recognisably not a listed frame and is
        // skipped; everything after it arrives on its real time. For a file whose first frame is later than
        // zero, a millisecond back is inside the empty edit before it, where the reader's first picture is
        // `ClipFramePassthrough`'s blank, stamped with exactly this time and skipped the same way.
        let at = frames.stamps[index]
        let back: CMTime = index > 0
            ? CMTimeMultiplyByRatio(CMTimeSubtract(at, frames.stamps[index - 1]), multiplier: 1, divisor: 2)
            : CMTime(value: 1, timescale: 1000)
        let from = CMTimeMaximum(.zero, CMTimeSubtract(at, back))
        // To the out point and no further: frames after it are never this clip's. (Never shorter than the frame
        // asked for, for the frame-before-the-in-point case, whose own time can be at the out point's.)
        // And never past the composition. A track reader intersects its range with the asset by itself; a
        // composition reader whose range reaches past the last instruction fails at `startReading` with -11841,
        // invalid video composition (measured).
        let until = CMTimeMinimum(CMTimeMaximum(end, CMTimeAdd(at, CMTime(value: 1, timescale: 1000))),
                                  source.composition.duration)

        let reader: AVAssetReader
        do {
            reader = try AVAssetReader(asset: source.composition)
        } catch {
            throw ClipFrameError.readerFailed(underlying: error)
        }
        let output = AVAssetReaderVideoCompositionOutput(
            videoTracks: source.composition.tracks(withMediaType: .video),
            videoSettings: Self.pixelAttributes as [String: Any])
        output.videoComposition = source.videoComposition
        reader.timeRange = CMTimeRange(start: from, end: until)
        // Nothing here writes into a decoded frame, so the reader may hand over its own buffers.
        output.alwaysCopiesSampleData = false
        guard reader.canAdd(output) else { throw ClipFrameError.readerFailed(underlying: nil) }
        reader.add(output)
        guard reader.startReading() else { throw ClipFrameError.readerFailed(underlying: reader.error) }
        self.reader = reader
        self.output = output
        restamped = from == at ? .invalid : from
        next = index
        starts += 1
    }

    private func read(until index: Int) throws -> CVPixelBuffer {
        guard let reader, let output else { throw ClipFrameError.readerFailed(underlying: nil) }
        let tolerance = SlowMotion.SAME_FRAME_S
        while true {
            guard let sample = output.copyNextSampleBuffer() else {
                // End of the range or a failure: either way the frame asked for never came.
                if reader.status == .failed { throw ClipFrameError.readerFailed(underlying: reader.error) }
                throw ClipFrameError.missingFrame(index: index)
            }
            guard let frame = CMSampleBufferGetImageBuffer(sample) else { continue }
            decoded += 1
            let pts = CMSampleBufferGetPresentationTimeStamp(sample)
            // The picture already on screen at the reader's start, restamped to it: not a listed frame.
            if pts == restamped { continue }
            let t = pts.seconds
            // Before the next listed frame: a picture the listing merged away (a second sample within
            // SAME_FRAME_S of a kept one) or one a coarse timescale restamped. Not the next frame either way.
            if t < frames.seconds[next] - tolerance { continue }
            // Past it: the listing has a frame this reader never produced.
            if t > frames.seconds[next] + tolerance { throw ClipFrameError.missingFrame(index: next) }
            let got = next
            next += 1
            held.append((got, frame))
            if held.count > 2 { held.removeFirst() }
            if got == index { return frame }
            // Frames between the one held and the one asked for are read through; `next` bounds the loop, since
            // it only grows and the caller's index is below `frames.count`.
            if next >= frames.count { throw ClipFrameError.missingFrame(index: index) }
        }
    }
}

/// Phase 1 of slow motion on iOS: the picture between two source frames is `A * (1 - w) + B * w`, per channel, on
/// the gamma-encoded values - the web's `mix(a, b, w)` and Android's, taken here in Core Image so the result is
/// one more CIImage and everything after it in `placedPicture` (orientation, colour, crop, fit, spin, camera,
/// opacity, transitions) is untouched.
enum FrameBlend {

    /// `A` and `B` mixed by `weight` (0 is A, 1 is B), as a CIImage over A's extent.
    ///
    /// CIMix and not CIDissolveTransition, although both are `mix`. Measured through EditCompositor's own context
    /// (working and output colour space NSNull, Metal) into a 32BGRA buffer with `render(_:to:bounds:colorSpace:
    /// nil)`, over all 65,536 (a, b) pairs of 8-bit values in each channel: at w = 0.25, 0.5, 0.75, 0.3, 1/3 and
    /// 0.9 both come out within 0.5 of the exact value - correctly rounded, the only disagreement with
    /// `round(exact)` being which way an exact .5 goes - and never a code value further. At w = 1/512 + 1e-4,
    /// the smallest weight that is ever drawn, CIDissolveTransition strays to 0.524 while CIMix stays at 0.499.
    /// A colour-matrix-plus-addition formulation also holds 0.5 but is two filters and a premultiplied sum where
    /// this is one.
    ///
    /// Colour management is off in the context, so this mixes the stored, gamma-encoded values - the thing the
    /// web and Android mix. Both frames must come in as the compositor's frames do,
    /// `CIImage(cvPixelBuffer:options: [.colorSpace: NSNull()])`, and both are opaque, so premultiplication
    /// changes nothing.
    ///
    /// The caller decides when B is drawn at all: a weight under `SlowMotion.MIN_TWEEN_WEIGHT` is A alone and
    /// never reaches here, which keeps every on-a-frame instant the contract's frame A itself, byte for byte -
    /// the frame the composition converts. That is `.off`'s frame at the instant too, except where AVFoundation
    /// rounds an exact coincidence of the source time with a frame's time down to the frame before (see
    /// `ClipFrameComposition`); there A is the later frame, as on the web.
    static func mix(_ a: CIImage, _ b: CIImage, weight: Double) -> CIImage {
        let filter = CIFilter.mix()
        filter.backgroundImage = a
        filter.inputImage = b
        filter.amount = Float(min(1, max(0, weight)))
        // A's extent, which is B's too - two frames of one track share a size - and cropped so that a filter
        // that ever widened it could not change what `Placement` measures.
        return (filter.outputImage ?? a).cropped(to: a.extent)
    }
}

// MARK: - A slowed clip, as the builder laid it

/// How slowed clips are drawn. Internal and not on the wire: speed < 1 is the whole signal a spec gives, and
/// every render the app makes is `.flow`. The other two exist for the tests and the benchmark, which measure
/// each phase against the others on the same build.
enum SlowMotionMode: Sendable {
    /// Today's engine exactly: no `SlowClip` is attached anywhere, so the composition, its instructions and
    /// every pixel are what they were before slow motion was synthesised - a slowed clip repeats the source
    /// frame the composition shows at each instant.
    case off
    /// Phase 1: an instant between two source frames is their cross-fade (`FrameBlend.mix`).
    case blend
    /// Phase 2: the optical flow's picture (`FlowEstimator`), which falls back to the cross-fade for a pair it
    /// cannot estimate. The engine's default.
    case flow
}

/// One slowed clip - a base clip, an extra layer's clip or a transition's outgoing tail - as the builder laid it,
/// with what the compositor needs to draw it from its own frames rather than from the one frame the composition
/// hands it.
///
/// A slowed clip is a VIDEO clip whose clamped speed is below 1, which is not a picture and not held (an in point
/// at or past the end of its footage, drawn as its last frame): `SlowMotion.isSlowMotion`. Every other clip has
/// no `SlowClip` and takes the path it always took.
///
/// IMMUTABLE, and a class for its identity: the builder makes ONE per slowed timeline entry, and every
/// `EditLayer` the instructions cut from that entry - a clip split by another layer's boundaries is several
/// instructions - carries the same instance. The compositor keys its mutable side (a decoder, the current pair's
/// flow) by `ObjectIdentifier` of it, so one decoder follows the clip across the cuts, and releases it as soon
/// as an instruction no longer names it.
///
/// The time mapping is the one the composition PLAYS, not the one the spec asked for. `inserted` is the source
/// range the builder handed `insertTimeRange` (after the out-point clamp, a layer's cut to the base's end, a
/// tail's span) and `placed` the output range it landed on after `scaleTimeRange` - whose length the builder
/// rounded to whole milliseconds. Composition time `t` is source time
/// `inserted.start + (t - placed.start) * inserted.duration / placed.duration` (`SlowMotion.sourceSeconds`);
/// mapped through `spec.speed` instead, the source time drifts off the frame the composition is showing by up
/// to a fraction of a frame and the weights with it.
final class SlowClip: @unchecked Sendable {
    /// The clip's frames on its source track's timeline: every frame presented before `window`'s end, from the
    /// one presented at or before its start. `SlowMotion.framePairAt` keeps the clip to its OWN frames.
    let frames: ClipFrameTimes
    /// The one-clip composition its decoders read from; shared with every other slowed clip of the same file.
    /// It holds the file's asset, which nothing else here needs to.
    let source: ClipFrameComposition
    /// The SOURCE range the builder inserted, on the source track's timeline.
    let inserted: CMTimeRange
    /// The OUTPUT range it was placed on after scaling.
    let placed: CMTimeRange
    /// The clip's OWN piece of its file - the frames it may be drawn from - on the source track's timeline:
    /// `clipWindow` of the web's planned clip, [in, out). The same as `inserted` for a base clip (`[in, outEff)`)
    /// and an extra layer's (`[in, cut)`, the web's `cutTo`); wider for a transition tail the builder CUT to a
    /// short incoming clip, whose inserted span stops where the tail does while the web still plans it as the
    /// whole from-clip. The frames past the cut are then the clip's own, and the last instants of the tail
    /// blend towards them as the web's do instead of holding the last frame before the cut.
    let window: CMTimeRange

    // The ranges in Double seconds, converted once rather than per frame.
    private let insertedStart: Double
    private let insertedDuration: Double
    private let placedStart: Double
    private let placedDuration: Double
    private let own: SourceWindow

    /// `window` defaults to `inserted`, which is every clip but a cut transition tail.
    init(frames: ClipFrameTimes, source: ClipFrameComposition, inserted: CMTimeRange, placed: CMTimeRange,
         window: CMTimeRange? = nil) {
        self.frames = frames
        self.source = source
        self.inserted = inserted
        self.placed = placed
        self.window = window ?? inserted
        insertedStart = inserted.start.seconds
        insertedDuration = inserted.duration.seconds
        placedStart = placed.start.seconds
        placedDuration = placed.duration.seconds
        own = SourceWindow(from: self.window.start.seconds, to: self.window.end.seconds)
    }

    /// The frames composition instant `t` is drawn from: A, B and the weight between them, as indices into
    /// `frames`. nil only for a clip with no frames, which the builder never attaches.
    func pair(at t: CMTime) -> FramePair? {
        SlowMotion.slowFramesAt(frames.seconds, composition: t.seconds,
                                placedStart: placedStart, placedDuration: placedDuration,
                                insertedStart: insertedStart, insertedDuration: insertedDuration, window: own)
    }

    /// A new decoder over this clip's frames, which reads nothing until it is first asked for one.
    func decoder() -> ClipFrameDecoder {
        ClipFrameDecoder(source: source, frames: frames, end: window.end)
    }
}

/// The builder's side of making `SlowClip`s, for one build: the source-track properties only a slowed clip needs,
/// loaded once per FILE however many slowed clips are cut from it, and the one-clip composition shared by all of
/// them.
///
/// NEVER a reason for a build to fail. Anything that goes wrong making a `SlowClip` - a property that will not
/// load, a track with no frames in the clip's window, a composition that will not take the track - answers nil,
/// and the clip is then drawn exactly as the engine drew it before slow motion was synthesised: its repeated
/// frames are a worse picture, not a broken one. Said once per process, not once per clip.
final class SlowClipSources {
    private struct Loaded {
        let segments: [AVAssetTrackSegment]
        let cursors: Bool
        let composition: ClipFrameComposition
    }

    /// By asset, which the builder's `SourceCache` hands out once per `uri`.
    private var loaded: [ObjectIdentifier: Loaded] = [:]

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "SlowMotion")
    private static let warned = OnceFlag()

    /// The `SlowClip` for `inserted` of `track` (whose whole range is `trackRange`) placed on `placed`, drawn from
    /// the frames of `window` (`inserted` when nil; see `SlowClip.window`), or nil when one cannot be made; see
    /// the class comment.
    func clip(asset: AVURLAsset, track: AVAssetTrack, trackRange: CMTimeRange,
              inserted: CMTimeRange, placed: CMTimeRange, window: CMTimeRange? = nil) async -> SlowClip? {
        do {
            let source: Loaded
            if let hit = loaded[ObjectIdentifier(asset)] {
                source = hit
            } else {
                // Only here, for a file a slowed clip is cut from: every other clip's load is exactly what it
                // was. The sample cursors and the edit list are async-only properties in Swift, which is one
                // reason the listing is made here, where the builder is async anyway, and not in the compositor.
                let (segments, cursors, size, fps) = try await track.load(.segments, .canProvideSampleCursors,
                                                                          .naturalSize, .nominalFrameRate)
                let composition = try ClipFrameComposition(asset: asset, track: track, trackRange: trackRange,
                                                           naturalSize: size, nominalFrameRate: fps,
                                                           colorPrimaries: OutputColor.primaries,
                                                           transferFunction: OutputColor.transferFunction,
                                                           yCbCrMatrix: OutputColor.yCbCrMatrix)
                source = Loaded(segments: segments, cursors: cursors, composition: composition)
                loaded[ObjectIdentifier(asset)] = source
            }
            let frames = try ClipFrameListing.frames(of: track, in: asset, segments: source.segments,
                                                     window: window ?? inserted, cursors: source.cursors)
            return SlowClip(frames: frames, source: source.composition, inserted: inserted, placed: placed,
                            window: window)
        } catch {
            if Self.warned.setOnce() {
                Self.log.error("slow motion: a slowed clip keeps its repeated frames, its frame list could not be made: \(String(describing: error), privacy: .public)")
            }
            return nil
        }
    }
}
