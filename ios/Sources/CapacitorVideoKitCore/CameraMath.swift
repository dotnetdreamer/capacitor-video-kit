import CoreGraphics
import Foundation

/// The camera's pure maths: where the camera is at an output time, and the one affine that puts a
/// video layer where the camera sees it. Nothing here touches Core Image, AVFoundation or a frame.
///
/// THE TYPESCRIPT IS AUTHORITATIVE. `cameraAt`, `clampView` and `isIdentityView` in
/// `src/editor/camera.ts` are ported here line for line, the same policy `TransitionMath` states:
/// there is no Swift test target in this package, the TypeScript tests pin those functions, and a
/// difference between the two is therefore a bug in THIS file. The contract every engine implements
/// is the doc comment of `ComposeCamera` in `src/video-composer/definitions.ts`.
///
/// Hand-check vectors (720x1280 output, CI's y-UP pixels, `transform(_:in:)`):
///   - pose (scale 2, cx 0.5, cy 0.5): the frame centre (360, 640) stays put, and the top-left
///     quarter's corner (180, 960) - wire point (0.25, 0.25) - lands on (0, 1280), the top-left.
///   - pose (scale 2, cx 0.25, cy 0.25), OFF CENTRE, the case that catches a missing y flip: the
///     wire point (0.25, 0.25) is CI point (180, 960), and it lands on the frame centre (360, 640);
///     the wire point (0, 0), CI point (0, 1280), lands on (0, 1280), the top-left corner.
///   Getting either the flip or the concatenation order wrong moves both of those.
enum CameraMath {

    /// Below this a pose is the whole frame: `IDENTITY_EPSILON` in the TypeScript. It keeps float
    /// dust at the foot of a ramp from switching the camera on for a frame, which would resample an
    /// untouched picture through a transform a rounding error away from the identity.
    static let identityEpsilon: Double = 1e-4

    /// Whether a pose leaves the frame as it is. `isIdentityView`.
    static func isIdentity(_ p: CameraPose) -> Bool {
        p.scale <= 1 + identityEpsilon
    }

    /// A pose held inside the frame, `clampView`: `scale` to 1...`maxCameraScale` and each centre to
    /// `0.5 / scale ... 1 - 0.5 / scale`, so the visible area never leaves the frame. A non-finite
    /// number falls back to the whole frame rather than failing, exactly as the TypeScript does.
    ///
    /// That feasible set is convex, which is why clamping every KEY is enough: every straight line
    /// between two clamped keys stays inside it, so no interpolated frame can show anything outside
    /// the output frame and nothing here or in the compositor needs a second clip for it.
    static func clamped(scale: Double, cx: Double, cy: Double) -> CameraPose {
        let s: Double = scale.isFinite ? min(ComposeSpecParser.maxCameraScale, max(1, scale)) : 1
        let half: Double = 0.5 / s
        let x: Double = cx.isFinite ? min(1 - half, max(half, cx)) : 0.5
        let y: Double = cy.isFinite ? min(1 - half, max(half, cy)) : 0.5
        return CameraPose(scale: s, cx: x, cy: y)
    }

    /// The camera at output time `ms`, `cameraAt` line for line: the end keys HOLD, every field is
    /// read in a straight line between the keys either side, and keys sharing a time are a STEP with
    /// the later one winning. nil for a moment where the frame is whole, so the caller takes the
    /// path it took before cameras existed for that frame and the frame is pixel-identical to it.
    ///
    /// A binary search, because a long post compiles to thousands of keys and this runs for every
    /// output frame. Time stays a Double in MILLISECONDS on purpose: converting a hand-built key to
    /// microseconds could overflow, and `Int64(Double)` traps where a Double comparison cannot.
    static func pose(_ track: CameraTrack, atMs ms: Double) -> CameraPose? {
        let at = track.atMs
        let n = at.count
        if n == 0 { return nil }
        let view: CameraPose
        if !(ms > at[0]) {
            // At or before the first key. Equal times are a step to the LAST key sharing that time.
            // Written `!(ms > first)` rather than `ms <= first` so a NaN lands here, on a real key,
            // instead of reaching the interpolation with it.
            var i = 0
            while i + 1 < n && at[i + 1] <= ms { i += 1 }
            view = track.poses[i]
        } else if ms >= at[n - 1] {
            view = track.poses[n - 1]
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
            let a = track.poses[lo]
            let b = track.poses[lo + 1]
            view = CameraPose(scale: lerp(a.scale, b.scale, f),
                              cx: lerp(a.cx, b.cx, f),
                              cy: lerp(a.cy, b.cy, f))
        }
        return isIdentity(view) ? nil : view
    }

    /// The camera as ONE affine in `frame`'s Core Image pixels (y-UP), ready to be folded into a
    /// layer's placement.
    ///
    /// The contract is `p' = 0.5 + (p - c) * scale` per axis in the wire's y-DOWN fractions. In
    /// pixels that is `q = (P - C) * scale + centre`, where `C` is the camera's centre in the SAME
    /// y-up pixels as `P`, so the only place the wire's y-down has to be undone is `C`'s y:
    /// `cy` is measured down from the TOP, which in Core Image sits at `minY + (1 - cy) * height`.
    /// A centred camera (cy = 0.5) is its own mirror and hides a missing flip; the second vector in
    /// the header is the one that catches it - the same trap `Placement.destination` warns about.
    ///
    /// `A.concatenating(B)` applies A FIRST, so this reads top to bottom as it happens: bring the
    /// camera's centre to the origin, magnify about it, carry it to the frame's centre. Reversed,
    /// it would magnify about the frame's corner. It is a uniform scale plus a translate and never
    /// a rotation, which is what lets `CGRect.applying` map a layer's clip rectangle through it
    /// exactly.
    static func transform(_ p: CameraPose, in frame: CGRect) -> CGAffineTransform {
        let z = CGFloat(p.scale)
        let centreX = frame.minX + CGFloat(p.cx) * frame.width
        let centreY = frame.minY + (1 - CGFloat(p.cy)) * frame.height
        return CGAffineTransform(translationX: -centreX, y: -centreY)
            .concatenating(CGAffineTransform(scaleX: z, y: z))
            .concatenating(CGAffineTransform(translationX: frame.midX, y: frame.midY))
    }

    private static func lerp(_ a: Double, _ b: Double, _ f: Double) -> Double {
        a + (b - a) * f
    }
}

/// Where the camera is at one moment: `scale` >= 1, and the point (`cx`, `cy`) of the unzoomed
/// frame, in the wire's 0..1 TOP-LEFT fractions, that it brings to the frame's centre. `CameraView`
/// in the TypeScript.
struct CameraPose: Equatable, Sendable {
    let scale: Double
    let cx: Double
    let cy: Double
}

/// A spec's camera as the compositor reads it, built ONCE with the plan and immutable after that,
/// which is what keeps `RenderPlan`'s `@unchecked Sendable` honest.
///
/// nil - the failable init - is the ABSENT path, decided here once and never per frame: a spec with
/// no `camera` key, which is every spec written before zoom existed, and a camera that never leaves
/// the whole frame. The parser already drops the second, so this is the second line of defence
/// behind it, the way `EditLayer.spin` backs up the parser's angle checks.
struct CameraTrack: Sendable {
    /// Output-timeline milliseconds, non-decreasing: the parser rejected anything else.
    let atMs: [Double]
    /// One per entry of `atMs`, each already clamped by the parser.
    let poses: [CameraPose]

    init?(_ keys: [ComposeCameraKey]?) {
        guard let keys, !keys.isEmpty else { return nil }
        let poses: [CameraPose] = keys.map { CameraPose(scale: $0.scale, cx: $0.cx, cy: $0.cy) }
        guard poses.contains(where: { !CameraMath.isIdentity($0) }) else { return nil }
        self.atMs = keys.map { $0.atMs }
        self.poses = poses
    }
}
