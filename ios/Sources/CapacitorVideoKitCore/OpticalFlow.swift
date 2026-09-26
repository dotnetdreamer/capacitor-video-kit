import Foundation

// Optical flow for smooth slow motion: the iOS half of `optical-flow.ts`, which says what every pass
// does and why, and of Android's `OpticalFlow.kt`. This file is the part of it with no GPU in it - the
// settings, the pyramid's sizes, and the per-pixel maths the kernels do, as plain functions XCTest can
// pin against the numbers the TypeScript and the Kotlin are pinned to. The kernels themselves are
// `OpticalFlowShaders.swift` and their orchestration `FlowEstimator.swift`.
//
// ONE ALGORITHM, THREE ENGINES. The web painter and Media3 share their passes as GLSL ES 1.00 TEXT, and
// `build/optical-flow-parity.unit.test.ts` holds the Kotlin copy to the TypeScript line by line. Metal is
// not GLSL, so iOS cannot share the text; what it shares is everything the text is made of. Every
// constant a kernel is written with comes out of `OpticalFlow.FLOW`, which the same parity test reads
// out of THIS FILE as text and holds to the TypeScript's `FLOW` field for field, and every function
// below is a port of one in optical-flow.ts, named after it and pinned by `OpticalFlowTests` to the same
// cases and the same numbers as `optical-flow.unit.test.ts` and `OpticalFlowTest.kt`. So a threshold
// cannot change on iOS alone, and one changed in the TypeScript fails the parity test until it is copied
// in here. A difference between this file and the TypeScript is a bug in this file.
//
// The FLOW block below is read by a regular expression, not by a compiler: keep its opening line as it
// is, indented four spaces, then one `name: value,` per line, then a `)` alone indented four spaces,
// with no comment inside it. A comment belongs on the field in `FlowSettings`, where the parity test
// does not look, and no other line of this file may start the way the block's opening line does.

/// The knobs of the flow's passes: `FlowSettings` in optical-flow.ts and in OpticalFlow.kt, field for
/// field. Every engine renders with `OpticalFlow.FLOW`; the benchmark tries others.
struct FlowSettings: Equatable, Sendable {
    /// The working size's longer side, in texels. A frame smaller than this is worked at its own size.
    let maxSide: Int
    /// The most pyramid levels, the working size included.
    let maxLevels: Int
    /// No level is made whose shorter side would fall below this.
    let minSide: Int
    /// Lucas-Kanade iterations per level, FINEST FIRST; a level past the end takes the last number.
    let iterations: [Int]
    /// The most bilinear reads per axis the luma pass takes over one working texel's footprint: see
    /// `OpticalFlow.lumaTaps`.
    let maxLumaTaps: Int
    /// The window's reach either side of its centre, in texels of the level: 2 is 5x5.
    let radius: Int
    /// The step between the window's taps: 1 reads every texel of it, 2 every other one each way.
    let windowStep: Int
    /// The window's spatial fall-off, in texels.
    let spatialSigma: Double
    /// The window's fall-off in luma (0...1): how different a texel may look before it stops counting.
    let rangeSigma: Double
    /// Tikhonov regularisation of each 2x2 solve, in the units of the summed squared gradients.
    let lambda: Double
    /// The most one iteration may move an estimate, in texels of its level.
    let maxStep: Double
    /// Whether each level's flow is median-filtered before it seeds the next.
    let median: Bool
    /// The round-trip test: a miss counts when |F01 + F10'|^2 > alpha (|F01|^2 + |F10'|^2) + beta, in
    /// texels. See `OpticalFlow.consistencyRatio`.
    let consistencyAlpha: Double
    let consistencyBeta: Double
    /// A texel is fully visible below this round-trip ratio and fully hidden above the next.
    let occlusionLow: Double
    let occlusionHigh: Double
    /// The share of the frame failing the round trip above which a pair starts, and ends, being
    /// distrusted.
    let badLow: Double
    let badHigh: Double
    /// The mean luma disagreement after the flow above which a pair starts, and ends, being distrusted.
    let residualLow: Double
    let residualHigh: Double
    /// The occlusion fill's reach either side of a texel, and the step between its taps, in working
    /// texels.
    let fillRadius: Int
    let fillStep: Int
    /// Per pixel: how well at least one of the two points must have been found before the flow is used
    /// there.
    let supportLow: Double
    let supportHigh: Double
    /// How many times each point is re-sought along its flow after the first guess: see
    /// `OpticalFlow.trackPoints`.
    let trackIterations: Int
    /// How far from the pixel, in working texels, a found point's own flow may carry it and still
    /// count as found.
    let missLow: Double
    let missHigh: Double
    /// How much a point seen in only its own frame counts against one seen in both: see
    /// `OpticalFlow.synthesisWeights`.
    let hiddenWeight: Double
    /// Below this motion, in working texels, a pixel is the cross-fade; above the next, the flow's.
    let motionLow: Double
    let motionHigh: Double
}

/// A texture's size in texels: `FlowSize` in optical-flow.ts and OpticalFlow.kt.
struct FlowSize: Equatable, Sendable {
    let width: Int
    let height: Int
}

/// The flow's arithmetic, as static functions on a namespace the way Kotlin keeps it on
/// `object OpticalFlow`. Each one is the TypeScript function of the same name (the pyramid is
/// `flowPyramid` there), with the same arguments in the same order and `settings` defaulting to
/// `FLOW` in all three languages.
enum OpticalFlow {

    /// A point or a vector: in texture coordinates, 0...1 across the frame, or in texels where a
    /// function says so. `Vec2` in optical-flow.ts and OpticalFlow.kt.
    ///
    /// SIMD2 rather than a struct of our own because it is the standard library's, needs no import,
    /// and does its arithmetic lane by lane in the order it is written - the order the TypeScript
    /// writes each component in, so the two round alike: on the same inputs every function here
    /// answers the TypeScript's number to the bit, but for the last place of `hypot` in `trackPoints`,
    /// which JavaScript's `Math.hypot` and Darwin's round differently.
    typealias Vec2 = SIMD2<Double>

    /// The flow a texture holds at a point, in texture coordinates: forward (A to B) in `x` and `y`,
    /// backward (B to A) in `z` and `w` - the texture's own four channels, so `lowHalf` is GLSL's `.xy`
    /// and `highHalf` its `.zw`. `FlowField` in optical-flow.ts and OpticalFlow.kt; the tests stand a
    /// closure in for the texture.
    typealias FlowField = (Vec2) -> SIMD4<Double>

    /// What every engine renders with: `FLOW` in optical-flow.ts, which says how each value was chosen
    /// on the benchmark in `scripts/slow-motion-bench`, and `OpticalFlow.FLOW` in OpticalFlow.kt. The
    /// parity test holds this block to the TypeScript, field for field; change the TypeScript first.
    static let FLOW = FlowSettings(
        maxSide: 320,
        maxLevels: 5,
        minSide: 8,
        iterations: [3, 3, 4, 5, 5],
        maxLumaTaps: 6,
        radius: 2,
        windowStep: 1,
        spatialSigma: 1.5,
        rangeSigma: 0.2,
        lambda: 0.004,
        maxStep: 1.0,
        median: true,
        consistencyAlpha: 0.01,
        consistencyBeta: 0.5,
        occlusionLow: 1.0,
        occlusionHigh: 4.0,
        badLow: 0.25,
        badHigh: 0.5,
        residualLow: 0.06,
        residualHigh: 0.12,
        fillRadius: 6,
        fillStep: 2,
        supportLow: 0.1,
        supportHigh: 0.5,
        trackIterations: 1,
        missLow: 0.5,
        missHigh: 1.0,
        hiddenWeight: 0.2,
        motionLow: 0.1,
        motionHigh: 0.25
    )

    /// The round-trip ratio a texel whose flow takes it off the frame is given: hidden, whatever the
    /// test's thresholds. `OFF_FRAME` in optical-flow.ts and OpticalFlow.kt, and the literal the
    /// consistency kernel writes.
    static let OFF_FRAME: Double = 100

    // MARK: - The pyramid

    /// The pyramid for a `width` x `height` frame, the working size first: `flowPyramid` in
    /// optical-flow.ts, `OpticalFlow.pyramid` in OpticalFlow.kt.
    ///
    /// The frame scaled so its longer side is at most `maxSide` - never enlarged - and then each level
    /// half the last, ROUNDED UP so an odd size loses nothing off its edge, for as long as the shorter
    /// side stays at or above `minSide` and there are fewer than `maxLevels`. Always at least one level
    /// for a frame with pixels; empty for one without.
    ///
    /// The working size is rounded half UP, which is what JavaScript's `Math.round` does with a positive
    /// number and what Kotlin spells `floor(x + 0.5)`, and the rule is named here rather than left to a
    /// default because the halves are real: a 1280x722 recording scales to 320 x 180.5, which all three
    /// engines must call 181. `.toNearestOrEven` or an `Int(_:)` truncation would call it 180, and the
    /// flow would be estimated on a different grid from the web's.
    static func pyramid(width: Int, height: Int, settings: FlowSettings = FLOW) -> [FlowSize] {
        guard width >= 1, height >= 1 else { return [] }
        let scale = min(1, Double(settings.maxSide) / Double(max(width, height)))
        var level = FlowSize(width: max(1, Int((Double(width) * scale).rounded(.toNearestOrAwayFromZero))),
                             height: max(1, Int((Double(height) * scale).rounded(.toNearestOrAwayFromZero))))
        var levels = [level]
        while levels.count < settings.maxLevels {
            // `ceil(n / 2)` for a whole number of texels, without a trip through Double.
            let next = FlowSize(width: (level.width + 1) / 2, height: (level.height + 1) / 2)
            if min(next.width, next.height) < settings.minSide { break }
            levels.append(next)
            level = next
        }
        return levels
    }

    /// How many bilinear reads per axis the luma kernel takes over each working texel's footprint in a
    /// `width` x `height` frame worked at `working`: `lumaTaps` in optical-flow.ts and OpticalFlow.kt.
    ///
    /// Enough 2x2 reads to tile the footprint, which is an exact box filter wherever the frame is an
    /// even multiple of the working size - 2 at 4:1 (720x1280), 3 at 6:1 (1080x1920), 6 at 12:1
    /// (2160x3840) - and one plain read where the frame IS the working size. A fixed count cannot be
    /// right for every frame: two reads a side are the exact box at 4:1 and four single texels out of
    /// thirty-six at 6:1, which lets fine texture alias into every level of the pyramid. The `1e-6`
    /// keeps a ratio a rounding error past a whole number of reads from taking one more. At least 1, at
    /// most `maxLumaTaps`.
    ///
    /// A working size with a zero side - which `pyramid` never makes - is an answer rather than a trap
    /// in `Int(_:)`: an infinite ratio is `maxLumaTaps`, as the TypeScript's clamp makes it, and 0/0 is
    /// one read, where the TypeScript would hand the kernel the NaN as it is.
    static func lumaTaps(width: Int, height: Int, working: FlowSize, settings: FlowSettings = FLOW) -> Int {
        let ratio = max(Double(width) / Double(working.width), Double(height) / Double(working.height))
        let taps = (ratio / 2 - 1e-6).rounded(.up)
        guard taps.isFinite else { return taps > 0 ? settings.maxLumaTaps : 1 }
        return Int(min(Double(settings.maxLumaTaps), max(1, taps)))
    }

    /// Lucas-Kanade iterations at `level`, 0 being the working size: `iterationsAt` in optical-flow.ts
    /// and OpticalFlow.kt. A level past the end of `iterations` takes its last number; an empty list,
    /// or a level before the first, is one iteration, as the TypeScript's `?? 1` makes it.
    static func iterationsAt(_ level: Int, settings: FlowSettings = FLOW) -> Int {
        let list = settings.iterations
        let index = min(level, list.count - 1)
        return list.indices.contains(index) ? list[index] : 1
    }

    // MARK: - The maths the kernels do, as plain functions

    /// GLSL's `smoothstep`, including its behaviour outside the edges: 0 at and below `edge0`, 1 at
    /// and above `edge1`, and the cubic `3t^2 - 2t^3` between. `smoothstep` in optical-flow.ts and
    /// OpticalFlow.kt, which is the clamp written as `min(1, max(0, t))`.
    ///
    /// The clamp is written out as two comparisons rather than as Swift's `min` and `max` on purpose.
    /// JavaScript's `Math.max(0, NaN)` and Kotlin's `max(0.0, NaN)` are NaN, while Swift's `max(0, .nan)`
    /// is 0 - its `max` answers the first argument whenever the comparison is false - so the library
    /// functions would quietly turn a NaN into "fully below the edge" and disagree with both twins.
    /// Two comparisons that are both false for a NaN keep it, as they do. The same goes for a
    /// zero-width edge: an infinite `t` clamps to 0 or 1, and `x` exactly on the edge is 0/0, NaN, in
    /// all three.
    static func smoothstep(_ edge0: Double, _ edge1: Double, _ x: Double) -> Double {
        let r = (x - edge0) / (edge1 - edge0)
        let t = r < 0 ? 0 : (r > 1 ? 1 : r)
        return t * t * (3 - 2 * t)
    }

    /// Super SloMo's linear-motion approximation (Jiang et al. 2018, eq. 4): where the missing frame at
    /// `t` (0 is A, 1 is B) reads each neighbour, for the pixel whose forward flow is `f01` (A to B) and
    /// whose backward flow is `f10` (B to A), both read AT THE PIXEL:
    ///
    ///     F_t0 = -(1 - t) t F01 + t^2 F10
    ///     F_t1 = (1 - t)^2 F01 - t (1 - t) F10
    ///
    /// so the pixel `x` is A's at `x + toA` and B's at `x + toB`. For a point moving steadily by `d`
    /// (F01 = d, F10 = -d) that is `x - t d` and `x + (1 - t) d`: a fraction `t` back along its path
    /// into A and the rest of the way forward into B. `intermediateFlows` in optical-flow.ts and
    /// OpticalFlow.kt.
    ///
    /// NOT what any engine draws with - see `trackPoints`, which answers the same question by following
    /// the flow instead of reading it at the pixel, and which the benchmark found better on every
    /// moving scene. Kept because it is the answer the two must agree on wherever the motion is
    /// uniform, which is what the tests hold `trackPoints` to.
    static func intermediateFlows(f01: Vec2, f10: Vec2, t: Double) -> (toA: Vec2, toB: Vec2) {
        let u = 1 - t
        return (toA: -u * t * f01 + t * t * f10,
                toB: u * u * f01 - t * u * f10)
    }

    /// What `trackPoints` found: the object `trackPoints` returns in optical-flow.ts,
    /// `OpticalFlow.Tracked` in OpticalFlow.kt.
    struct Tracked: Equatable, Sendable {
        /// A's point, in texture coordinates.
        let pa: Vec2
        /// B's point, in texture coordinates.
        let pb: Vec2
        /// How far A's point's own flow leaves it from the pixel, in working texels.
        let missA: Double
        /// How far B's point's own flow leaves it from the pixel, in working texels.
        let missB: Double
        /// A's point's own forward motion, in working texels.
        let flowA: Vec2
        /// B's point's own backward motion, in working texels.
        let flowB: Vec2
    }

    /// The two recorded points the missing frame's pixel `uv` at `t` is drawn from, found by FOLLOWING
    /// the flow: `trackPoints` in optical-flow.ts and OpticalFlow.kt, and what the synthesis kernel
    /// does per pixel.
    ///
    /// The point `pa` of A whose own forward flow carries it to `uv` by `t` - `pa + t F01(pa) = uv` -
    /// and the point `pb` of B whose backward flow carries it to `uv` by `1 - t` -
    /// `pb + (1 - t) F10(pb) = uv`. Each is found by fixed-point iteration from the flow at the pixel,
    /// `pa <- uv - t F01(pa)`, `trackIterations` times after the first guess.
    ///
    /// WHY NOT `intermediateFlows`. That reads both flows at the pixel itself, which is right wherever
    /// the flow is smooth and wrong exactly where it matters: at the edge of a moving object the pixel's
    /// forward flow is the object's and its backward flow the background's, and the linear
    /// approximation mixes the two into a point that belongs to neither - a halo round everything that
    /// moves. Following each frame's own flow lands on a point of ONE surface in each frame; where the
    /// two frames land on different surfaces, `synthesisWeights` decides between them.
    ///
    /// `missA` and `missB` are how far, in working texels (`size`), each found point's own flow leaves
    /// it from `uv`: 0 for a point that is really there, and large where the iteration never settled -
    /// at the trailing edge of a moving object, where no point of that frame lands on `uv` at all.
    /// `flowA` and `flowB` are the found points' own motion, in working texels, which says whether
    /// anything moves there. `flowAt` is read where and as often as the kernel samples the flow: once at
    /// the pixel, twice per re-seek, and once at each found point.
    static func trackPoints(_ flowAt: FlowField, uv: Vec2, t: Double, size: FlowSize,
                            settings: FlowSettings = FLOW) -> Tracked {
        let u = 1 - t
        let here = flowAt(uv)
        var pa = uv - t * here.lowHalf
        var pb = uv - u * here.highHalf
        for _ in 0..<max(0, settings.trackIterations) {
            let fa = flowAt(pa)
            let fb = flowAt(pb)
            pa = uv - t * fa.lowHalf
            pb = uv - u * fb.highHalf
        }
        let fa = flowAt(pa)
        let fb = flowAt(pb)
        let texels = Vec2(Double(size.width), Double(size.height))
        let flowA = fa.lowHalf * texels
        let flowB = fb.highHalf * texels
        let missA = hypot((pa.x - uv.x) * texels.x + t * flowA.x, (pa.y - uv.y) * texels.y + t * flowA.y)
        let missB = hypot((pb.x - uv.x) * texels.x + u * flowB.x, (pb.y - uv.y) * texels.y + u * flowB.y)
        return Tracked(pa: pa, pb: pb, missA: missA, missB: missB, flowA: flowA, flowB: flowB)
    }

    /// The round-trip ratio of a texel whose flow is `forward` (in texels) and at whose destination the
    /// opposite flow is `back`: the miss squared over what the test allows (Sundaram et al. 2010,
    /// relative to the length of the motion, so a long motion is allowed a longer miss).
    /// `consistencyRatio` in optical-flow.ts and OpticalFlow.kt.
    ///
    /// At or below 1 the round trip closes; above it the texel is taken to be hidden in the other
    /// frame. A destination off the frame is `OFF_FRAME` and is never measured.
    static func consistencyRatio(forward: Vec2, back: Vec2, settings: FlowSettings = FLOW) -> Double {
        let mx = forward.x + back.x
        let my = forward.y + back.y
        let lengths = forward.x * forward.x + forward.y * forward.y + back.x * back.x + back.y * back.y
        return (mx * mx + my * my) / (settings.consistencyAlpha * lengths + settings.consistencyBeta)
    }

    /// How visible a texel is in the other frame, 1 to 0, from its round-trip ratio: fully seen to
    /// `occlusionLow`, fully hidden from `occlusionHigh`, a smoothstep between. `visibility` in
    /// optical-flow.ts and OpticalFlow.kt.
    static func visibility(_ ratio: Double, settings: FlowSettings = FLOW) -> Double {
        1 - smoothstep(settings.occlusionLow, settings.occlusionHigh, ratio)
    }

    /// How far the flow is trusted for a whole pair, 1 to 0: `bad` is the share of the frame that
    /// failed the round trip, `residual` the mean luma disagreement left after the flow. `pairTrust` in
    /// optical-flow.ts and OpticalFlow.kt.
    ///
    /// When most of the frame fails the round trip, or the flow leaves A and B disagreeing everywhere,
    /// the flow is not describing this pair at all - a cut inside a clip, a flash that changed more than
    /// brightness, a whip pan faster than the pyramid can follow - and the pair is drawn as the blend. A
    /// smoothstep rather than a switch, so a pair near the line does not flicker between the two looks
    /// from one pair to the next.
    static func pairTrust(bad: Double, residual: Double, settings: FlowSettings = FLOW) -> Double {
        (1 - smoothstep(settings.badLow, settings.badHigh, bad))
            * (1 - smoothstep(settings.residualLow, settings.residualHigh, residual))
    }

    /// The exposure pass's answer: the gain that brings B's luma spread to A's, clamped to a factor of
    /// two either way - beyond that the two frames are not one picture at two exposures, and the trust
    /// test will say so. A flat frame has no spread, and a flat B is left at the lower clamp.
    /// `exposureGain` in optical-flow.ts and OpticalFlow.kt.
    static func exposureGain(stdA: Double, stdB: Double) -> Double {
        min(2, max(0.5, stdA / max(stdB, 0.002)))
    }

    /// Whether a point is on the frame: 1 inside texture coordinates' 0...1 square, edges included,
    /// else 0 - a Double because the kernels multiply by it. `insideFrame` in optical-flow.ts and
    /// OpticalFlow.kt, and GLSL's `step(0.0, p.x) * step(0.0, p.y) * step(p.x, 1.0) * step(p.y, 1.0)`.
    static func insideFrame(_ point: Vec2) -> Double {
        point.x >= 0 && point.y >= 0 && point.x <= 1 && point.y <= 1 ? 1 : 0
    }

    /// How found a point is, 1 to 0, from how far its own flow leaves it from the pixel (`miss`, from
    /// `trackPoints`) and whether it is on the frame (`inside`, from `insideFrame`): found up to
    /// `missLow` texels off, not from `missHigh`. `landed` in optical-flow.ts and OpticalFlow.kt.
    static func landed(miss: Double, inside: Double, settings: FlowSettings = FLOW) -> Double {
        (1 - smoothstep(settings.missLow, settings.missHigh, miss)) * inside
    }

    /// The two points' weights and how far their picture is trusted over the cross-fade:
    /// `synthesisWeights`' answer in optical-flow.ts, `OpticalFlow.Weights` in OpticalFlow.kt.
    struct Weights: Equatable, Sendable {
        let wA: Double
        let wB: Double
        let confidence: Double
    }

    /// How the missing frame weighs the two points `trackPoints` found, and how far it trusts the
    /// result over the cross-fade: `synthesisWeights` in optical-flow.ts and OpticalFlow.kt.
    ///
    /// A point counts as FOUND (`landedA`, `landedB`, 1 to 0, from `landed`) when its own flow really
    /// does carry it to the pixel and it is on the frame. Each then weighs what it did in the
    /// cross-fade, `1 - t` for A and `t` for B, times how sure the round trip is that the point is seen
    /// in BOTH frames (`seenA`: A's point in B; `seenB`: B's point in A) plus a little (`hiddenWeight`).
    /// That is Super SloMo's visibility weighting (eq. 5) with the visibilities taken from the round
    /// trip rather than learned, and it settles the one real ambiguity: at the edge of a moving object
    /// A may land on the object and B on the background behind it, and the surface seen in both frames
    /// is the one IN FRONT - the background is the one the object hides in one of them. A point seen in
    /// only its own frame still counts when it is all there is - background the object has just
    /// uncovered, which only B has.
    ///
    ///     wA = (1 - t) landedA (hidden + seenA),   wB = t landedB (hidden + seenB)
    ///
    /// `confidence` is how far the flow's picture is used over the cross-fade here: the pair's `trust`,
    /// times whether ANYTHING moves (`motion`, the larger of the two points' own motion in working
    /// texels - where nothing moves the cross-fade is already the right answer, and it has the noise of
    /// two frames averaged rather than the flow's guess at a motion of nothing), times whether at least
    /// one point was found at all.
    static func synthesisWeights(t: Double, landedA: Double, landedB: Double, seenA: Double, seenB: Double,
                                 motion: Double, trust: Double, settings: FlowSettings = FLOW) -> Weights {
        Weights(wA: (1 - t) * landedA * (settings.hiddenWeight + seenA),
                wB: t * landedB * (settings.hiddenWeight + seenB),
                confidence: trust * smoothstep(settings.motionLow, settings.motionHigh, motion)
                    * smoothstep(settings.supportLow, settings.supportHigh, max(landedA, landedB)))
    }
}
