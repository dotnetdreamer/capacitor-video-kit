import CoreGraphics
import Foundation

/// The arithmetic of a clip-to-clip transition, with no Core Image and no AVFoundation in it.
///
/// Every function in here is a port of one in `src/editor/transitions.ts`, named after it and laid
/// out like it, so that a reviewer can hold the two side by side and check them line by line. That
/// is the whole of the testing this file can get: the package has no Swift test target and nothing
/// here can be compiled on the machine it was written on, while the TypeScript it mirrors is pinned
/// by `transitions.unit.test.ts`. A difference between the two is therefore a bug in THIS file.
///
/// What a transition looks like is not code in each engine. The editor samples every channel it
/// moves at evenly spaced moments of the window and sends the numbers; this engine reads them back
/// by straight-line interpolation and draws them through the same handful of operations every other
/// engine uses. Nothing in this file or the renderer beside it ever looks at a transition's `kind`,
/// which is what keeps the export in step with the preview when the catalogue grows.

/// One side of a transition - the outgoing clip or the incoming one - at one moment. `TransitionSide`
/// in transitions.ts, field for field, with the same neutral values.
///
/// Every field acts on the side's WHOLE output frame: its picture as it would be drawn with no
/// transition at all, together with the black around it. Moving the picture alone would leave the
/// bars of a letterboxed clip standing still while the picture slid out of them.
struct TransitionSide: Equatable, Sendable {
    /// Offset of the whole frame, as a fraction of the output width. Positive is right.
    var x: Double = 0
    /// Offset of the whole frame, as a fraction of the output height. Positive is DOWN, the wire's
    /// y; `TransitionMath.sideTransform` is the one place it becomes Core Image's y-up.
    var y: Double = 0
    /// Size about the frame's centre. 1 is as it is.
    var scale: Double = 1
    /// CLOCKWISE degrees about the frame's centre, measured in output pixels.
    var rotation: Double = 0
    /// Gaussian sigma, as a fraction of the output's SHORTER side. 0 is sharp.
    var blur: Double = 0
    /// Mosaic cell size, as a fraction of the shorter side, the cells laid out from the frame's
    /// centre. 0 is none.
    var pixelate: Double = 0
    /// Red and blue pulled apart sideways, each by this fraction of the output width. 0 is none.
    var split: Double = 0
    /// Multiplies the colour, clamped to 1, before `tint`. 1 is as it is.
    var gain: Double = 1
    /// 0...1 of the way towards the side's tint colour.
    var tint: Double = 0

    /// `NEUTRAL_SIDE`: a side exactly as it plays with no transition.
    static let neutral = TransitionSide()
}

/// Everything a transition is at one moment: `TransitionLook` in transitions.ts.
struct TransitionLook: Equatable, Sendable {
    /// How much of the incoming side is drawn over the outgoing one, 0...1, everywhere at once.
    let alpha: Double
    /// How far the mask has opened, 0...1. Meaningless without a mask.
    let reveal: Double
    let from: TransitionSide
    let to: TransitionSide
}

enum TransitionMath {

    /// The long side of the grid a mask is worked out on, per frame, before Core Image stretches it
    /// over the render. 480 is a cell of four output pixels on a 1080x1920 post, and every edge the
    /// catalogue draws is feathered over several times that, so the stretch is invisible; the grid
    /// is 130,000 evaluations of a sine, a cosine and a smoothstep, a few milliseconds of one core
    /// per frame of a masked transition, against the tens of milliseconds the encoder spends on it.
    static let maskGridLongSide = 480

    // MARK: - Reading the curves

    /// One curve at `p`: `sample` in transitions.ts, line for line.
    ///
    /// Absent is the neutral value, and `p` outside 0...1 (or not a number at all) holds the end
    /// sample, exactly as the TypeScript does. The parser has already held every curve to 2...121
    /// samples, but the one- and zero-sample branches are kept so this reads as a straight port.
    static func sample(_ values: [Double]?, _ p: Double, _ neutral: Double) -> Double {
        guard let values, !values.isEmpty else { return neutral }
        if values.count == 1 { return values[0] }
        let x = clamp01(p.isFinite ? p : 0) * Double(values.count - 1)
        // `Math.floor` of a value already held to 0...(n - 1), so the conversion cannot trap.
        let i = min(Int(x.rounded(.down)), values.count - 2)
        let f = x - Double(i)
        return values[i] + (values[i + 1] - values[i]) * f
    }

    /// The look at progress `p`: `lookAt` in transitions.ts. A channel the wire left out holds its
    /// neutral value, which is what makes a dissolve one curve on the wire rather than nineteen.
    static func look(_ curves: ComposeTransitionCurves, _ p: Double) -> TransitionLook {
        TransitionLook(alpha: sample(curves.alpha, p, 1),
                       reveal: sample(curves.reveal, p, 1),
                       from: side(curves.from, p),
                       to: side(curves.to, p))
    }

    /// `sideAt` in transitions.ts: every channel of one side at `p`, neutral where it was left out.
    static func side(_ curves: ComposeTransitionSideCurves?, _ p: Double) -> TransitionSide {
        guard let curves else { return .neutral }
        let n = TransitionSide.neutral
        return TransitionSide(x: sample(curves.x, p, n.x),
                              y: sample(curves.y, p, n.y),
                              scale: sample(curves.scale, p, n.scale),
                              rotation: sample(curves.rotation, p, n.rotation),
                              blur: sample(curves.blur, p, n.blur),
                              pixelate: sample(curves.pixelate, p, n.pixelate),
                              split: sample(curves.split, p, n.split),
                              gain: sample(curves.gain, p, n.gain),
                              tint: sample(curves.tint, p, n.tint))
    }

    /// How far through its window a transition is at output time `tUs`, 0...1: the contract's
    /// `p = clamp((t - start) / length, 0, 1)`.
    ///
    /// Measured against the WINDOW, never against the instruction the frame belongs to. A layer's
    /// clip boundary or a layer starting inside the window splits it into several instructions, and
    /// progress read off any one of them would restart at 0 at every split.
    static func progress(tUs: Int64, startUs: Int64, durationUs: Int64) -> Double {
        guard durationUs > 0 else { return 1 }
        return clamp01(Double(tUs - startUs) / Double(durationUs))
    }

    // MARK: - Masks

    /// `smoothstep` in transitions.ts, including its answer for a zero-width edge.
    static func smoothstep(_ e0: Double, _ e1: Double, _ x: Double) -> Double {
        if e1 == e0 { return x < e0 ? 0 : 1 }
        let t = clamp01((x - e0) / (e1 - e0))
        return t * t * (3 - 2 * t)
    }

    /// How much of the incoming side a mask lets through at output pixel (`qx`, `qy`) of a `w` x `h`
    /// frame, 0...1: `maskAlpha` in transitions.ts.
    ///
    /// The reveal is widened by the feather at both ends, so 0 lets nothing through and 1 lets
    /// everything through, soft edge and all. `feather` is clamped again here although the parser
    /// already did it, because the TypeScript does and a port that skipped it would read differently.
    static func maskAlpha(_ mask: ComposeTransitionMask, _ reveal: Double,
                          _ qx: Double, _ qy: Double, _ w: Double, _ h: Double) -> Double {
        let u = maskMeasure(mask, qx, qy, w, h)
        let fw = min(0.5, max(0.0005, mask.feather))
        let r = clamp01(reveal) * (1 + 2 * fw) - fw
        let inside = 1 - smoothstep(r - fw, r + fw, u)
        return mask.invert ? 1 - inside : inside
    }

    /// The shape's own measure of an output pixel, 0...1 across the frame: `maskMeasure` in
    /// transitions.ts.
    ///
    /// Everything is in output PIXELS and y-DOWN, the wire's space and the TypeScript's, so a circle
    /// is round on a portrait frame and `angleDeg` 90 travels downwards. Nothing here is flipped into
    /// Core Image's y-up: the grid below is laid out top row first, which is the order a `CGImage`
    /// holds its rows in, so the flip happens once, in the decode, where it cannot be got wrong.
    static func maskMeasure(_ mask: ComposeTransitionMask,
                            _ qx: Double, _ qy: Double, _ w: Double, _ h: Double) -> Double {
        let dx = qx - w / 2
        let dy = qy - h / 2
        let angle = mask.angleDeg * .pi / 180
        let cosA = cos(angle)
        let sinA = sin(angle)
        // The frame's extent along the direction, so `u` runs 0...1 from the edge it starts at to
        // the far one.
        let extent = abs(w * cosA) + abs(h * sinA)
        switch mask.shape {
        case .linear:
            return (dx * cosA + dy * sinA) / extent + 0.5
        case .circle:
            return hypot(dx, dy) / hypot(w / 2, h / 2)
        case .diamond:
            return (abs(dx) + abs(dy)) / (w / 2 + h / 2)
        case .clock:
            // Clockwise from twelve o'clock, in y-down pixels. `atan2(dx, -dy)` with its arguments in
            // that order is the TypeScript's, and C's `atan2` follows the same IEEE rules for the
            // signed zeros at the exact centre.
            let turn = atan2(dx, -dy) / (2 * .pi)
            return turn < 0 ? turn + 1 : turn
        case .blinds:
            // `count` is already a whole number 1...64, so `Math.max(1, Math.round(count))` is itself.
            let along = ((dx * cosA + dy * sinA) / extent + 0.5) * Double(max(1, mask.count))
            return along - along.rounded(.down)
        case .split:
            return abs(dx * cosA + dy * sinA) / (extent / 2)
        }
    }

    /// A mask worked out on a reduced grid, one byte per cell, TOP row first.
    struct MaskGrid {
        let columns: Int
        let rows: Int
        /// `columns * rows` values, 0 (the outgoing side only) to 255 (the incoming side only).
        let values: [UInt8]
    }

    /// `maskAlpha` over a grid whose long side is at most `longSide` cells, each cell evaluated at
    /// the output pixel under its CENTRE.
    ///
    /// The centre matters: stretched back over the render with linear sampling, a cell's value lands
    /// exactly where it was measured, so the stretch interpolates between true values instead of
    /// shifting the whole mask by half a cell. A render already smaller than the grid is evaluated
    /// at its own size.
    static func maskGrid(_ mask: ComposeTransitionMask, reveal: Double,
                         width w: Double, height h: Double,
                         longSide: Int = TransitionMath.maskGridLongSide) -> MaskGrid {
        let k = min(1, Double(max(1, longSide)) / max(w, h, 1))
        let columns = max(1, Int((w * k).rounded()))
        let rows = max(1, Int((h * k).rounded()))
        let cellW = w / Double(columns)
        let cellH = h / Double(rows)
        var values = [UInt8](repeating: 0, count: columns * rows)
        for row in 0..<rows {
            let qy = (Double(row) + 0.5) * cellH
            for column in 0..<columns {
                let qx = (Double(column) + 0.5) * cellW
                let m = maskAlpha(mask, reveal, qx, qy, w, h)
                // A NaN would trap in the conversion, and none can reach here - every divisor above
                // is a positive size - but `>= 0` is false for one, which sends it to 0 regardless.
                let unit = m >= 0 ? min(1, m) : 0
                values[row * columns + column] = UInt8((unit * 255).rounded())
            }
        }
        return MaskGrid(columns: columns, rows: rows, values: values)
    }

    // MARK: - Moving a side

    /// Where a side's whole frame is drawn, as the affine Core Image applies to it, or nil for a side
    /// that has not moved at all.
    ///
    /// This is the FORWARD map whose inverse is `sideSource` in transitions.ts. That function asks,
    /// for output pixel q in y-down pixels, `s = C + R(-rotation) (q - C - (x W, y H)) / scale`;
    /// solved for q it is `q = C + (x W, y H) + scale R(rotation) (s - C)`, and in Core Image's
    /// y-UP space the same map is `Q = C + (x W, -y H) + scale R'(-rotation) (S - C)`, R' being
    /// the ordinary counter-clockwise rotation `CGAffineTransform(rotationAngle:)` builds. So the two
    /// signs flip - the angle, because a positive angle in a y-up space turns counter-clockwise, and
    /// the y offset, because down is negative there - and nothing else does. `OverlayBitmap` and
    /// `EditLayer.spin` make the same two flips for the same reasons.
    ///
    /// Concatenation is A-then-B, so this reads top to bottom as it happens: to the centre, scale,
    /// turn, and out to the centre plus the offset. The scale is floored where `sideSource` floors
    /// it, so a scale of 0 is a speck rather than a singular matrix.
    static func sideTransform(_ side: TransitionSide, in frame: CGRect) -> CGAffineTransform? {
        guard side.x != 0 || side.y != 0 || side.scale != 1 || side.rotation != 0 else { return nil }
        let scale = CGFloat(side.scale > 1e-6 ? side.scale : 1e-6)
        return CGAffineTransform(translationX: -frame.midX, y: -frame.midY)
            .concatenating(CGAffineTransform(scaleX: scale, y: scale))
            .concatenating(CGAffineTransform(rotationAngle: -CGFloat(side.rotation) * .pi / 180))
            .concatenating(CGAffineTransform(translationX: frame.midX + CGFloat(side.x) * frame.width,
                                             y: frame.midY - CGFloat(side.y) * frame.height))
    }

    /// `clamp01` in transitions.ts, comparisons and all, so a NaN passes through it exactly as it
    /// passes through the TypeScript rather than being quietly turned into an end.
    private static func clamp01(_ v: Double) -> Double {
        v < 0 ? 0 : (v > 1 ? 1 : v)
    }
}

/// The timeline half of a transition, in whole milliseconds, for `CompositionBuilder`.
enum TransitionTiming {

    /// An output length for `sourceMs` of media at `speed`, rounded exactly as the base loop rounds a
    /// base clip's, so a tail and the clip it was cut from agree about what a millisecond of source
    /// is on the output timeline. A speed of exactly 1 is the media's own length, untouched.
    static func placedMs(sourceMs: Int64, speed: Double) -> Int64 {
        guard speed != 1 else { return sourceMs }
        return max(1, Int64((Double(sourceMs) / speed).rounded(.toNearestOrAwayFromZero)))
    }

    /// How much of an outgoing clip's tail is laid down under the incoming clip, and how long it
    /// then runs: the window.
    ///
    /// `sourceMs` is what the tail's file actually holds of the range the wire asked for, and
    /// `roomMs` is the incoming clip's placed length, which is all the room the tail has - the
    /// window is `min(tail, incoming)`. On a spec the editor built the tail always fits, because the
    /// editor held the transition to half of either clip; it only has to be cut when a file turned
    /// out shorter than the manifest believed and the incoming clip was clamped with it. The cut is
    /// taken off the tail's END and made in SOURCE milliseconds before anything is inserted, the way
    /// `addLayer` cuts a layer at the base's end, and the placed length is held to the room so a
    /// rounding millisecond can never carry it into the next clip.
    ///
    /// nil when there is nothing to lay: a tail entirely past the end of its file, or no room at all.
    /// Either is drawn as a cut, which is what an engine that ignored the transition would draw.
    static func tail(sourceMs: Int64, speed: Double, roomMs: Int64) -> (sourceMs: Int64, placedMs: Int64)? {
        guard sourceMs > 0, roomMs > 0 else { return nil }
        let whole = placedMs(sourceMs: sourceMs, speed: speed)
        if whole <= roomMs { return (sourceMs, whole) }
        let cut = speed == 1
            ? roomMs
            : min(sourceMs, max(1, Int64((Double(roomMs) * speed).rounded(.toNearestOrAwayFromZero))))
        return (cut, min(roomMs, placedMs(sourceMs: cut, speed: speed)))
    }

    /// True when every span starts at or after the end of the one before it and none runs
    /// backwards. Volume ramps on one set of audio mix parameters must never overlap - AVFoundation
    /// leaves that undefined - and this is what the builder asserts its ramps against.
    static func disjoint(_ spans: [(startMs: Int64, endMs: Int64)]) -> Bool {
        var edge = Int64.min
        for span in spans {
            if span.startMs < edge || span.endMs < span.startMs { return false }
            edge = span.endMs
        }
        return true
    }
}
