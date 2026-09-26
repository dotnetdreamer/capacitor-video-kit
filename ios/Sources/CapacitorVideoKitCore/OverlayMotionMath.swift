import Foundation

/// A layer's motion read at one moment - the pure half of it, with nothing that touches Core Image.
///
/// THE TYPESCRIPT IS AUTHORITATIVE, the policy `CameraMath` states: `overlayMotionAt` and
/// `isNeutralMotion` in `src/editor/motion.ts` are ported here line for line, and so is Android's
/// `OverlayMotion.at`. A difference between them is a bug in THIS file. The contract every engine
/// implements is the doc comment of `ComposeOverlayMotion` in `src/video-composer/definitions.ts`.
enum OverlayMotionMath {

    /// Below this a channel is at rest: `isNeutralMotion`'s epsilon. It keeps float dust at the foot
    /// of a move from putting a still layer through the moving path for a frame.
    static let neutralEpsilon: Double = 1e-6

    /// Whether a sample leaves the layer exactly where the static path draws it.
    static func isNeutral(_ s: OverlayMotionSample) -> Bool {
        abs(s.x) <= neutralEpsilon && abs(s.y) <= neutralEpsilon && abs(s.scale - 1) <= neutralEpsilon &&
            abs(s.rotation) <= neutralEpsilon && abs(s.opacity - 1) <= neutralEpsilon
    }

    /// The motion at output time `ms`, `overlayMotionAt` line for line - which is `cameraAt`, and
    /// `CameraMath.pose`: the end keys HOLD, every channel is read in a straight line between the keys
    /// either side, and keys sharing a time are a STEP with the later one winning. nil for a moment
    /// where the layer is at rest, so the caller composites the image it placed once, and the frame is
    /// pixel-identical to the one a still layer gives.
    ///
    /// A binary search, because a long looping layer compiles to thousands of keys and this runs for
    /// every output frame. Milliseconds as a Double, for the reason `CameraMath.pose` gives.
    static func sample(_ m: ComposeOverlayMotion, atMs ms: Double) -> OverlayMotionSample? {
        let at = m.atMs
        let n = at.count
        if n == 0 { return nil }
        let s: OverlayMotionSample
        if !(ms > at[0]) {
            // At or before the first key. Equal times are a step to the LAST key sharing that time.
            // Written `!(ms > first)` so a NaN lands here, on a real key, rather than in the lerp.
            var i = 0
            while i + 1 < n && at[i + 1] <= ms { i += 1 }
            s = key(m, i)
        } else if ms >= at[n - 1] {
            s = key(m, n - 1)
        } else {
            // at[0] < ms < at[n - 1], so n >= 2 here and both indices below are in range. The
            // invariant is at[lo] <= ms < at[hi]; it ends with the last key at or before `ms`.
            var lo = 0
            var hi = n - 1
            while hi - lo > 1 {
                let mid = (lo + hi) >> 1
                if at[mid] <= ms { lo = mid } else { hi = mid }
            }
            let span: Double = at[lo + 1] - at[lo]
            let f: Double = span > 0 ? (ms - at[lo]) / span : 1
            s = OverlayMotionSample(x: lerp(m.x, 0, lo, f),
                                    y: lerp(m.y, 0, lo, f),
                                    scale: lerp(m.scale, 1, lo, f),
                                    rotation: lerp(m.rotation, 0, lo, f),
                                    opacity: lerp(m.opacity, 1, lo, f))
        }
        return isNeutral(s) ? nil : s
    }

    private static func key(_ m: ComposeOverlayMotion, _ i: Int) -> OverlayMotionSample {
        OverlayMotionSample(x: m.x?[i] ?? 0,
                            y: m.y?[i] ?? 0,
                            scale: m.scale?[i] ?? 1,
                            rotation: m.rotation?[i] ?? 0,
                            opacity: m.opacity?[i] ?? 1)
    }

    private static func lerp(_ values: [Double]?, _ neutral: Double, _ lo: Int, _ f: Double) -> Double {
        guard let values else { return neutral }
        let a = values[lo]
        return a + (values[lo + 1] - a) * f
    }
}

/// Where a layer's motion has it at one moment: the five channels of `OverlayMotionSample` in the
/// TypeScript, in the wire's terms - offsets in fractions of the output (y DOWN), a size about the
/// layer's centre, CLOCKWISE degrees added to its own and an opacity multiplied into its own.
struct OverlayMotionSample: Equatable, Sendable {
    let x: Double
    let y: Double
    let scale: Double
    let rotation: Double
    let opacity: Double
}
