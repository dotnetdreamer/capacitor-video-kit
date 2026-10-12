import CoreGraphics
import CoreImage
import CoreMedia
import Foundation
import os

// A clip's FOCUS in the render: some of its subjects kept sharp while everything else is blurred,
// greyed and darkened, drawn by `ComposeFocus`'s contract in `definitions.ts` - whose eight steps are
// not repeated here - as the FIRST thing done to the oriented source frame. `EditCompositor` hands
// each focused layer's oriented picture to `FocusClip.focused` before the grade, the crop, the fit,
// the turn and the camera, and everything after it treats the focused picture as the footage; a
// transition's outgoing side is a clip like any other and carries its own.
//
// Three parts:
//  - `FocusTracks`, the pre-flight: every focused clip's subject track read and its header parsed
//    before a frame is drawn, a track that will not read failing the render as `unreadable_input`
//    naming the clip, as footage that will not read does.
//  - `FocusClip`, one per timeline entry the builder lays: the focus, its track, and the entry's own
//    time mapping, which turns the compositor's OUTPUT time into the SOURCE time the keys and the
//    track's frames are in.
//  - `FocusRender`, steps 4 to 8 in built-in Core Image filters.

/// The subject tracks a render's focused clips are drawn from, each file read once.
enum FocusTracks {
    /// Every focused clip's track, by its `uri`, read in `ComposeSpec.everyClip`'s order - the base
    /// clips, the transitions' outgoing sides, the layers - which is the order the web engine reads
    /// them in, after every clip's footage has been opened, so a post with a broken track and broken
    /// footage names the same clip on both. Empty for a spec with no focus, which reads nothing.
    ///
    /// Throws `BuildError.unreadable` naming the first clip that needs a track that is missing, is not
    /// a subject track, or is one this build cannot read.
    static func load(_ spec: ComposeSpec) throws -> [String: SubjectTrack] {
        var tracks: [String: SubjectTrack] = [:]
        for clip in spec.everyClip {
            guard let focus = clip.focus, tracks[focus.uri] == nil else { continue }
            tracks[focus.uri] = try read(focus.uri, for: clip.key)
        }
        return tracks
    }

    /// One track, its header and tables parsed; `key` is the clip a failure names.
    static func read(_ uri: String, for key: String) throws -> SubjectTrack {
        guard let url = JobFolders.fileURL(from: uri) else {
            throw BuildError.unreadable(key, "subject track: unsupported uri")
        }
        let data: Data
        do {
            data = try Data(contentsOf: url)
        } catch {
            throw BuildError.unreadable(key, "subject track: \(ErrorMapping.describe(error))")
        }
        do {
            return try SubjectTrack.parse(data)
        } catch {
            throw BuildError.unreadable(key, "subject track: \(error)")
        }
    }
}

/// One focused clip - a base clip, a transition's outgoing side or a layer's clip - as the builder laid
/// it: what the compositor needs to focus its frames.
///
/// IMMUTABLE in everything but two scratch arrays, and a class for its identity, as `SlowClip` is: the
/// builder makes ONE per timeline entry, and every `EditLayer` the instructions cut from that entry -
/// a clip split by another layer's boundaries is several instructions - carries the same instance, so
/// the track is validated once and the scratch is shared rather than made per instruction.
///
/// SOURCE TIME. The compositor knows only the output instant. The entry's `inserted` range is the
/// source the builder handed `insertTimeRange` and `placed` the output range it landed on after
/// `scaleTimeRange`, so the source instant is the straight line the composition plays the clip by -
/// `SlowMotion.sourceSeconds`, the builder's own millisecond rounding in it - and then HELD to the
/// clip's own trim: from its in-point to a microsecond short of the end of what was inserted, as the
/// web holds `sourceTimeUs` to `outUs - 1`. That one rule covers every shape the builder lays:
///  - a clip at any speed, trimmed or not: the line;
///  - a layer cut to the base's end, and a transition's tail cut to its window: their ranges ARE the
///    cut ones;
///  - a clip held on its footage's last frame (`CompositionBuilder.lastFrame`, an in-point past the
///    end of its file): its inserted range lies before its in-point, so the hold puts every instant at
///    the in-point, where the web puts it - the keys there, and the track's last frame, which holds;
///  - a picture: its still starts at its wire in-point, 0, and plays at 1x, so the instant is the time
///    into the clip, which is where `compileFocus` moved its keys, and its track has one frame;
///  - a slowed clip: the frame the compositor synthesises between two source frames is focused at its
///    own source time, the contract's second reading of a slowed clip;
///  - the stretch of a post past its footage: never drawn - no instruction names a layer there.
final class FocusClip: @unchecked Sendable {
    let key: String
    let focus: ComposeFocus
    let track: SubjectTrack

    // The ranges in Double seconds, and the hold in milliseconds, worked out once rather than per frame.
    private let insertedStart: Double
    private let insertedDuration: Double
    private let placedStart: Double
    private let placedDuration: Double
    private let lowMs: Double
    private let highMs: Double

    /// The levels and the grid of the frame being drawn, reused frame to frame. Behind `lock`, which the
    /// compositor's one serial queue never contends; it is there so that nothing else ever can.
    private let lock = NSLock()
    private var levels = [Float](repeating: 0, count: 256)
    private var grid: [UInt8] = []

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "Focus")
    private static let warned = OnceFlag()

    /// `inserted` and `placed` are the entry's ranges as the builder laid it. Throws
    /// `BuildError.unreadable` naming the clip when a frame of the track the clip can reach does not
    /// decode: checked here, once, so a damaged track fails the render before anything is encoded
    /// rather than part of the way through it.
    init(clip: ComposeClip, focus: ComposeFocus, track: SubjectTrack, inserted: CMTimeRange, placed: CMTimeRange) throws {
        key = clip.key
        self.focus = focus
        self.track = track
        insertedStart = inserted.start.seconds
        insertedDuration = inserted.duration.seconds
        placedStart = placed.start.seconds
        placedDuration = placed.duration.seconds
        lowMs = Double(clip.inMs)
        highMs = max(lowMs, inserted.end.seconds * 1000 - 0.001)
        do {
            try track.validate(from: track.span(lowMs).from, through: track.span(highMs).to)
        } catch {
            throw BuildError.unreadable(clip.key, "subject track: \(error)")
        }
    }

    /// The SOURCE instant, in ms of the clip's file, that output instant `tUs` shows: see the class.
    func sourceMs(atUs tUs: Int64) -> Double {
        let s = SlowMotion.sourceSeconds(composition: Double(tUs) / 1_000_000, placedStart: placedStart,
                                         placedDuration: placedDuration, insertedStart: insertedStart,
                                         insertedDuration: insertedDuration) * 1000
        guard s.isFinite else { return lowMs }
        return min(highMs, max(lowMs, s))
    }

    /// The contract's steps 1 to 3 at the instant output time `tUs` shows - the levels, then the grid -
    /// as 0...255 a cell. Throws only for a frame that does not decode, which `init` has ruled out.
    func mask(atUs tUs: Int64) throws -> [UInt8] {
        let s = sourceMs(atUs: tUs)
        lock.lock()
        defer { lock.unlock() }
        focusLevels(atMs: focus.atMs, subjects: focus.subjects, at: s, into: &levels)
        try focusMask(track, levels: levels, at: s, invert: focus.invert, into: &grid)
        return grid
    }

    /// `frame`, the layer's ORIENTED source picture at output time `tUs`, focused: steps 4 to 8.
    func focused(_ frame: CIImage, atUs tUs: Int64) -> CIImage {
        let cells: [UInt8]
        do {
            cells = try mask(atUs: tUs)
        } catch {
            // Validated when the clip was laid, so this is a bug rather than a file; the frame is drawn
            // as the footage rather than failing a render over it, and it is said once.
            if Self.warned.setOnce() {
                Self.log.error("focus: a subject track frame would not decode mid-render, drawn unfocused: \(String(describing: error), privacy: .public)")
            }
            return frame
        }
        // In focus everywhere - a subject filling the frame - is `e = 1` at every pixel, and the frame
        // exactly: nothing is blurred that nothing would show.
        if !cells.contains(where: { $0 != 255 }) { return frame }
        return FocusRender.focused(frame, mask: cells, columns: track.width, rows: track.height,
                                   blur: focus.blur, mono: focus.mono, dim: focus.dim)
    }
}

/// Steps 4 to 8 of `ComposeFocus`'s contract on one frame, in built-in Core Image filters - no kernel of
/// our own, because a Metal kernel needs a metallib the Swift package cannot build and the CIKernel
/// language is deprecated (`TransitionRender` says the same).
///
/// Every filter here runs in the compositor's context, with colour management off, so it works on the
/// stored, gamma-encoded values the contract is written in. What is exact and what is not:
///  - THE MASK is the cell grid as an 8-bit grey image stretched over the frame and sampled LINEARLY,
///    its edges clamped (`TransitionRender.gridImage`): a pixel's value is the bilinear interpolation
///    between cell centres, step 4 to the letter.
///  - THE EASE `e = m * m * (3 - 2 * m)` is `CIColorPolynomial` with the coefficients (0, 0, 3, -2),
///    and the weight `1 - e` the same with (1, 0, -3, 2): the cubic itself, not a curve through points.
///  - THE WEIGHTING is premultiplied alpha. The frame drawn at alpha `1 - e` over clear is `(C * w, w)`;
///    a Gaussian blur of a premultiplied image blurs all four channels alike, so its result is
///    `(G(C * w), G(w))`, and unpremultiplying it is `G(C * w) / G(w)` - step 5's `B`, in one blur.
///    Where `G(w)` is below 1/1024 the division is never made: those pixels are swapped for opaque
///    black first, so nothing divides by a weight of nothing, and then for `C`, as the contract has it.
///  - THE GAUSSIAN is `CIGaussianBlur`, edges clamped, at sigma `blur * min(Ws, Hs)` of the oriented
///    source's own pixels. It is Core Image's approximation of one - the contract allows that.
///  - GREY and DARK are one `CIColorMatrix`: the luma row on all three channels mixed in by `mono`,
///    the whole scaled by `1 - dim`.
///  - THE MIX is `CIBlendWithMask` of the frame over `B` through `e`, then held to 0...1.
/// `FocusRenderTests` holds this, through a context configured as the compositor's, to the contract
/// worked in double precision with an exact Gaussian: within 0.012 (three code values) with a blur of a
/// few pixels and 0.02 with one under a pixel, all of it the Gaussian's approximation, and within 0.006
/// without one. On the compositor's own frames the grey is the footage's Rec. 709 luma to within a
/// couple of code values.
enum FocusRender {
    /// Step 5's floor: where the blurred weight is below this, nothing out of focus is near enough to
    /// say what is behind the pixel, and the frame's own colour stands.
    static let minWeight: CGFloat = 1.0 / 1024

    /// How sharply `minWeight` is told apart. Core Image works a kernel in 32-bit floats whatever its
    /// intermediates are stored in, and the blurred weight comes out of an intermediate in the context's
    /// working format - half precision, which `FocusRenderTests` checks is a float format at all - whose
    /// step at `minWeight` is 2^-20. This is 2^20, so one such step below `minWeight` is already a whole 1
    /// after the clamp and no weight that format can hold lands between 0 and 1; `edge * minWeight` is
    /// exactly 1024.
    private static let edge: CGFloat = 1_048_576

    /// `frame` focused through `mask`, a `columns` x `rows` grid of 0...255 values over it - what
    /// `focusMask` made for this instant - with `blur`, `mono` and `dim` as the parser left them.
    /// Opaque, over the frame's own extent.
    static func focused(_ frame: CIImage, mask: [UInt8], columns: Int, rows: Int,
                        blur: Double, mono: Double, dim: Double) -> CIImage {
        let rect = frame.extent
        guard !rect.isInfinite, rect.width > 0, rect.height > 0,
              let m = TransitionRender.gridImage(mask, columns: columns, rows: rows, over: rect) else { return frame }
        let ease = polynomial(m, 0, 0, 3, -2)

        // What is out of focus: the frame itself until blurred.
        var soft = frame
        let sigma = blur * Double(min(rect.width, rect.height))
        if sigma > 0 {
            soft = weightedBlur(frame, weight: polynomial(m, 1, 0, -3, 2), sigma: sigma, rect: rect)
        }
        if mono > 0 || dim > 0 {
            soft = greyAndDark(soft, mono: mono, dim: dim)
        }
        return frame
            .applyingFilter("CIBlendWithMask", parameters: [
                "inputBackgroundImage": soft,
                "inputMaskImage": ease,
            ])
            .applyingFilter("CIColorClamp")
            .cropped(to: rect)
    }

    /// Step 5: `G(C * w) / G(w)`, and `C` where `G(w)` is below `minWeight`. Opaque, over `rect`.
    static func weightedBlur(_ frame: CIImage, weight: CIImage, sigma: Double, rect: CGRect) -> CIImage {
        let clear = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)).cropped(to: rect)
        let black = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 1)).cropped(to: rect)
        let white = CIImage(color: CIColor(red: 1, green: 1, blue: 1, alpha: 1)).cropped(to: rect)

        // `(C * w, w)`: the frame at alpha `w` over clear, premultiplied as everything in Core Image is.
        let weighted = frame.applyingFilter("CIBlendWithMask", parameters: [
            "inputBackgroundImage": clear,
            "inputMaskImage": weight,
        ])
        // `(G(C * w), G(w))`. Clamped first, so the frame's edges blur against themselves - the
        // contract's clamped edges, for the colour and the weight alike.
        let blurred = weighted.clampedToExtent().applyingGaussianBlur(sigma: sigma).cropped(to: rect)

        // `G(w)` as an opaque grey, read off the alpha without dividing anything: white kept where the
        // blurred weight is (source-in), then laid on black.
        let reach = white
            .applyingFilter("CISourceInCompositing", parameters: ["inputBackgroundImage": blurred])
            .composited(over: black)
        // 1 where `G(w) < minWeight`, 0 elsewhere.
        let none = reach
            .applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: -edge, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: -edge, y: 0, z: 0, w: 0),
                "inputBVector": CIVector(x: -edge, y: 0, z: 0, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputBiasVector": CIVector(x: edge * minWeight, y: edge * minWeight, z: edge * minWeight, w: 1),
            ])
            .applyingFilter("CIColorClamp")
        // The division, made only where there is a weight to divide by: elsewhere opaque black stands
        // in, and divides to black. `settingAlphaOne` because the unpremultiplied colour is the answer
        // and its alpha, the blurred weight, has done its work.
        let divided = black
            .applyingFilter("CIBlendWithMask", parameters: [
                "inputBackgroundImage": blurred,
                "inputMaskImage": none,
            ])
            .applyingFilter("CIUnpremultiply")
            .settingAlphaOne(in: rect)
        // And the frame's own colour where there was none.
        return frame
            .applyingFilter("CIBlendWithMask", parameters: [
                "inputBackgroundImage": divided,
                "inputMaskImage": none,
            ])
            .cropped(to: rect)
    }

    /// Steps 6 and 7 in one matrix: `mix(B, Y, mono) * (1 - dim)`, `Y` the Rec. 709 luma on all three
    /// channels. `B` is opaque, so the unpremultiply `CIColorMatrix` does on the way in changes nothing.
    static func greyAndDark(_ image: CIImage, mono: Double, dim: Double) -> CIImage {
        let keep = CGFloat(1 - dim)
        let m = CGFloat(mono)
        let own = 1 - m
        let r = 0.2126 * m, g = 0.7152 * m, b = 0.0722 * m
        return image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: (own + r) * keep, y: g * keep, z: b * keep, w: 0),
            "inputGVector": CIVector(x: r * keep, y: (own + g) * keep, z: b * keep, w: 0),
            "inputBVector": CIVector(x: r * keep, y: g * keep, z: (own + b) * keep, w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 0),
        ])
    }

    /// `a0 + a1 * v + a2 * v^2 + a3 * v^3` on the three colour channels of an opaque grey image, alpha
    /// held at 1: the ease and the weight, exactly.
    private static func polynomial(_ image: CIImage, _ a0: CGFloat, _ a1: CGFloat, _ a2: CGFloat, _ a3: CGFloat) -> CIImage {
        let coefficients = CIVector(x: a0, y: a1, z: a2, w: a3)
        return image.applyingFilter("CIColorPolynomial", parameters: [
            "inputRedCoefficients": coefficients,
            "inputGreenCoefficients": coefficients,
            "inputBlueCoefficients": coefficients,
            "inputAlphaCoefficients": CIVector(x: 1, y: 0, z: 0, w: 0),
        ])
    }
}
