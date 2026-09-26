import XCTest
@testable import CapacitorVideoKitCore

/// The maths the flow's kernels do, as the iOS engine keeps it, pinned to the SAME cases and the same
/// numbers as `optical-flow.unit.test.ts` holds the web engine's to and `OpticalFlowTest.kt` the
/// Android engine's - case for case, in the same order, with the same precision (`close` is vitest's
/// `toBeCloseTo`) - so the three copies cannot drift. `OpticalFlow.FLOW` itself is held to the
/// TypeScript's `FLOW` as text by `build/optical-flow-parity.unit.test.ts`.
///
/// The two other files end on the shader TEXT - GLSL ES 1.00 in every pass, `SAMPLE` as the one word
/// each engine defines. Metal cannot share that text, so those cases have no twin here; the kernels are
/// pinned by what they draw instead (`FlowEstimatorTests`). The cases after the MARK "iOS only" are
/// Swift's own: behaviour the other two languages get from their runtime and Swift has to spell out.
final class OpticalFlowTests: XCTestCase {

    private typealias Vec2 = OpticalFlow.Vec2

    /// vitest's `toBeCloseTo(expected, digits)`: within half a unit of the `digits`-th decimal place.
    private func close(_ actual: Double, _ expected: Double, _ digits: Int = 9, _ what: String = "",
                       file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertEqual(actual, expected, accuracy: 0.5 * pow(10, -Double(digits)), what, file: file, line: line)
    }

    /// `close` in optical-flow.unit.test.ts: each component to `digits` places.
    private func close(_ actual: Vec2, _ expected: Vec2, _ digits: Int = 9,
                       file: StaticString = #filePath, line: UInt = #line) {
        close(actual.x, expected.x, digits, "x of \(actual)", file: file, line: line)
        close(actual.y, expected.y, digits, "y of \(actual)", file: file, line: line)
    }

    // MARK: - The pyramid

    func testWorksAPortraitClipAt180x320WhateverItsResolutionAndHalvesItFourTimes() {
        let portrait = [
            FlowSize(width: 180, height: 320),
            FlowSize(width: 90, height: 160),
            FlowSize(width: 45, height: 80),
            FlowSize(width: 23, height: 40),
            FlowSize(width: 12, height: 20),
        ]
        XCTAssertEqual(OpticalFlow.pyramid(width: 720, height: 1280), portrait)
        XCTAssertEqual(OpticalFlow.pyramid(width: 1080, height: 1920), portrait)
        XCTAssertEqual(OpticalFlow.pyramid(width: 2160, height: 3840), portrait)
    }

    func testTurnsWithTheClip() {
        XCTAssertEqual(OpticalFlow.pyramid(width: 1920, height: 1080), [
            FlowSize(width: 320, height: 180),
            FlowSize(width: 160, height: 90),
            FlowSize(width: 80, height: 45),
            FlowSize(width: 40, height: 23),
            FlowSize(width: 20, height: 12),
        ])
    }

    func testNeverEnlargesASmallFrameAndStopsBeforeALevelWouldBeTooSmallToHoldAWindow() {
        XCTAssertEqual(OpticalFlow.pyramid(width: 200, height: 100), [
            FlowSize(width: 200, height: 100),
            FlowSize(width: 100, height: 50),
            FlowSize(width: 50, height: 25),
            FlowSize(width: 25, height: 13),
        ])
        XCTAssertEqual(OpticalFlow.pyramid(width: 64, height: 64).map(\.width), [64, 32, 16, 8])
        XCTAssertEqual(OpticalFlow.pyramid(width: 1, height: 1), [FlowSize(width: 1, height: 1)])
        XCTAssertEqual(OpticalFlow.pyramid(width: 0, height: 720), [])
    }

    func testTilesEachWorkingTexelWith2x2ReadsOfTheFrameAnExactBoxAt4To1And6To1And12To1() {
        let portrait = FlowSize(width: 180, height: 320)
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 360, height: 640, working: portrait), 1)
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 720, height: 1280, working: portrait), 2)
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 1080, height: 1920, working: portrait), 3)
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 1440, height: 2560, working: portrait), 4)
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 2160, height: 3840, working: portrait), 6)
        // Never more than the pass is written for, and one plain read where the frame is the working size.
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 4320, height: 7680, working: portrait), OpticalFlow.FLOW.maxLumaTaps)
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 200, height: 100, working: FlowSize(width: 200, height: 100)), 1)
    }

    func testIteratesFinestFirstAndALevelPastTheListTakesItsLastNumber() {
        XCTAssertEqual(OpticalFlow.FLOW.iterations, [3, 3, 4, 5, 5])
        XCTAssertEqual([0, 1, 2, 3, 4, 9].map { OpticalFlow.iterationsAt($0) }, [3, 3, 4, 5, 5, 5])
    }

    // MARK: - Where the missing frame reads its neighbours

    func testIsBySuperSloMosApproximationAFractionTBackAlongTheMotionAndTheRestForward() {
        let (toA, toB) = OpticalFlow.intermediateFlows(f01: [4, -2], f10: [-4, 2], t: 0.25)
        close(toA, [-1, 0.5])
        close(toB, [3, -1.5])
        // Not symmetric where the two flows disagree: each term takes its own share.
        let skew = OpticalFlow.intermediateFlows(f01: [4, 0], f10: [0, 0], t: 0.5)
        close(skew.toA, [-1, 0])
        close(skew.toB, [1, 0])
    }

    private let size = FlowSize(width: 100, height: 100)

    /// A picture moving steadily by `d` texels: every point's forward flow is d, backward -d.
    private func uniform(_ d: Vec2) -> OpticalFlow.FlowField {
        let w = Double(size.width)
        let h = Double(size.height)
        return { _ in SIMD4(d.x / w, d.y / h, -d.x / w, -d.y / h) }
    }

    func testLandsByTrackingExactlyWhereTheApproximationDoesWhereverTheMotionIsUniform() {
        for t in [0.25, 0.5, 0.75] {
            let uv: Vec2 = [0.4, 0.6]
            let tracked = OpticalFlow.trackPoints(uniform([6, -3]), uv: uv, t: t, size: size)
            let (toA, toB) = OpticalFlow.intermediateFlows(f01: [0.06, -0.03], f10: [-0.06, 0.03], t: t)
            close(tracked.pa, uv + toA)
            close(tracked.pb, uv + toB)
            close(tracked.missA, 0)
            close(tracked.missB, 0)
            close(tracked.flowA, [6, -3])
            close(tracked.flowB, [-6, 3])
        }
    }

    /// A block moving right by 20 texels over a still background: in A it covers x 30..50, in B 50..70.
    /// Halfway, it covers 40..60.
    private let block: OpticalFlow.FlowField = { point in
        let inA = point.x >= 0.3 && point.x <= 0.5
        let inB = point.x >= 0.5 && point.x <= 0.7
        return SIMD4(inA ? 0.2 : 0, 0, inB ? -0.2 : 0, 0)
    }

    func testFindsTheBlockInAWhereTheLinearApproximationAtTheBlocksEdgeReadsTheBackground() {
        // Just inside the block's left edge halfway: a point of the block, which A has 10 texels back.
        let uv: Vec2 = [0.42, 0.5]
        let tracked = OpticalFlow.trackPoints(block, uv: uv, t: 0.5, size: size)
        close(tracked.pa, [0.32, 0.5])
        close(tracked.missA, 0)
        // The linear approximation reads F10 = 0 at uv (B has background there) and sends A's read only
        // halfway back: 5 texels, not 10 - the halo tracking removes.
        let f = block(uv)
        close(OpticalFlow.intermediateFlows(f01: f.lowHalf, f10: f.highHalf, t: 0.5).toA, [-0.05, 0])
    }

    func testKnowsWhenNoPointOfALandsOnAPixelTheBackgroundTheBlockHasJustUncovered() {
        // 35 halfway is background B has and A had under the block.
        let tracked = OpticalFlow.trackPoints(block, uv: [0.35, 0.5], t: 0.5, size: size)
        close(tracked.missB, 0)
        XCTAssertGreaterThan(tracked.missA, OpticalFlow.FLOW.missHigh)
        XCTAssertEqual(OpticalFlow.landed(miss: tracked.missA, inside: OpticalFlow.insideFrame(tracked.pa)), 0)
        XCTAssertEqual(OpticalFlow.landed(miss: tracked.missB, inside: OpticalFlow.insideFrame(tracked.pb)), 1)
    }

    // MARK: - The round trip, and how far the flow is trusted

    func testClosesForATexelTheBackwardFlowBringsBackAndNotForOneItDoesNot() {
        XCTAssertEqual(OpticalFlow.consistencyRatio(forward: [3, 0], back: [-3, 0]), 0)
        // 9 over 0.01 * 9 + 0.5: hidden.
        close(OpticalFlow.consistencyRatio(forward: [3, 0], back: [0, 0]), 15.254237288, 8)
        // A long motion is allowed a longer miss.
        close(OpticalFlow.consistencyRatio(forward: [40, 0], back: [-39, 0]), 1 / (0.01 * (1600 + 1521) + 0.5), 12)
    }

    func testReadsVisibilityOffTheRatioSeenTo1HiddenFrom4ASmoothstepBetween() {
        XCTAssertEqual(OpticalFlow.visibility(0), 1)
        XCTAssertEqual(OpticalFlow.visibility(1), 1)
        close(OpticalFlow.visibility(2.5), 0.5, 12)
        XCTAssertEqual(OpticalFlow.visibility(4), 0)
        XCTAssertEqual(OpticalFlow.visibility(OpticalFlow.OFF_FRAME), 0)
    }

    func testTrustsAPairFullyUntilAQuarterOfItFailsOrItsLumaDisagreesBy006AndNotAtAllPastHalfOr012() {
        XCTAssertEqual(OpticalFlow.pairTrust(bad: 0, residual: 0), 1)
        XCTAssertEqual(OpticalFlow.pairTrust(bad: 0.25, residual: 0.06), 1)
        XCTAssertEqual(OpticalFlow.pairTrust(bad: 0.5, residual: 0), 0)
        XCTAssertEqual(OpticalFlow.pairTrust(bad: 0, residual: 0.12), 0)
        close(OpticalFlow.pairTrust(bad: 0.375, residual: 0), 0.5, 12)
        close(OpticalFlow.pairTrust(bad: 0.375, residual: 0.09), 0.25, 12)
    }

    func testBringsBToAsExposureAFactorOfTwoAtMostEitherWay() {
        close(OpticalFlow.exposureGain(stdA: 0.15, stdB: 0.1), 1.5, 12)
        XCTAssertEqual(OpticalFlow.exposureGain(stdA: 0.3, stdB: 0.1), 2)
        XCTAssertEqual(OpticalFlow.exposureGain(stdA: 0.1, stdB: 0.3), 0.5)
        // Two flat frames have no spread between them to match.
        XCTAssertEqual(OpticalFlow.exposureGain(stdA: 0, stdB: 0), 0.5)
    }

    // MARK: - The weights

    func testAreTheCrossFadesWhereBothPointsAreFoundAndSeen() {
        let w = OpticalFlow.synthesisWeights(t: 0.25, landedA: 1, landedB: 1, seenA: 1, seenB: 1, motion: 5, trust: 1)
        close(w.wA / (w.wA + w.wB), 0.75, 12)
        XCTAssertEqual(w.confidence, 1)
    }

    func testPreferThePointSeenInBothFramesOverOneHiddenInTheOtherByTheHiddenWeight() {
        let w = OpticalFlow.synthesisWeights(t: 0.5, landedA: 1, landedB: 1, seenA: 1, seenB: 0, motion: 5, trust: 1)
        let hidden = OpticalFlow.FLOW.hiddenWeight
        close(w.wA / w.wB, (1 + hidden) / hidden, 12)
    }

    func testTakeAPointSeenInOnlyItsOwnFrameWhenItIsAllThereIs() {
        let w = OpticalFlow.synthesisWeights(t: 0.5, landedA: 0, landedB: 1, seenA: 0, seenB: 0, motion: 5, trust: 1)
        XCTAssertEqual(w.wA, 0)
        XCTAssertGreaterThan(w.wB, 0)
        XCTAssertEqual(w.confidence, 1)
    }

    func testAreTheCrossFadeWhereNothingMovesWhereNeitherPointWasFoundAndOnAPairNotTrusted() {
        XCTAssertEqual(OpticalFlow.synthesisWeights(t: 0.5, landedA: 1, landedB: 1, seenA: 1, seenB: 1,
                                                    motion: 0.1, trust: 1).confidence, 0)
        close(OpticalFlow.synthesisWeights(t: 0.5, landedA: 1, landedB: 1, seenA: 1, seenB: 1,
                                           motion: 0.175, trust: 1).confidence, 0.5, 12)
        XCTAssertEqual(OpticalFlow.synthesisWeights(t: 0.5, landedA: 0, landedB: 0, seenA: 1, seenB: 1,
                                                    motion: 5, trust: 1).confidence, 0)
        XCTAssertEqual(OpticalFlow.synthesisWeights(t: 0.5, landedA: 1, landedB: 1, seenA: 1, seenB: 1,
                                                    motion: 5, trust: 0).confidence, 0)
    }

    func testCountAPointAsFoundUpToHalfATexelOffAndNotFromAWholeTexel() {
        XCTAssertEqual(OpticalFlow.landed(miss: 0.5, inside: 1), 1)
        close(OpticalFlow.landed(miss: 0.75, inside: 1), 0.5, 12)
        XCTAssertEqual(OpticalFlow.landed(miss: 1, inside: 1), 0)
        XCTAssertEqual(OpticalFlow.landed(miss: 0, inside: 0), 0)
        XCTAssertEqual(OpticalFlow.insideFrame([0, 1]), 1)
        XCTAssertEqual(OpticalFlow.insideFrame([-0.001, 0.5]), 0)
    }

    // MARK: - iOS only

    /// `FLOW` with the two list-like knobs replaced, for the cases below that need another setting.
    private func settings(iterations: [Int] = OpticalFlow.FLOW.iterations,
                          trackIterations: Int = OpticalFlow.FLOW.trackIterations) -> FlowSettings {
        let f = OpticalFlow.FLOW
        return FlowSettings(maxSide: f.maxSide, maxLevels: f.maxLevels, minSide: f.minSide, iterations: iterations,
                            maxLumaTaps: f.maxLumaTaps, radius: f.radius, windowStep: f.windowStep,
                            spatialSigma: f.spatialSigma, rangeSigma: f.rangeSigma, lambda: f.lambda,
                            maxStep: f.maxStep, median: f.median, consistencyAlpha: f.consistencyAlpha,
                            consistencyBeta: f.consistencyBeta, occlusionLow: f.occlusionLow,
                            occlusionHigh: f.occlusionHigh, badLow: f.badLow, badHigh: f.badHigh,
                            residualLow: f.residualLow, residualHigh: f.residualHigh, fillRadius: f.fillRadius,
                            fillStep: f.fillStep, supportLow: f.supportLow, supportHigh: f.supportHigh,
                            trackIterations: trackIterations, missLow: f.missLow, missHigh: f.missHigh,
                            hiddenWeight: f.hiddenWeight, motionLow: f.motionLow, motionHigh: f.motionHigh)
    }

    /// GLSL's smoothstep outside its edges, and the TypeScript's and the Kotlin's answer for a NaN and
    /// for a zero-width edge - which Swift's own `min` and `max` would get wrong (see `smoothstep`).
    func testSmoothstepIsGLSLsOutsideItsEdgesAndKeepsANaNAsBothTwinsDo() {
        XCTAssertEqual(OpticalFlow.smoothstep(1, 4, -5), 0)
        XCTAssertEqual(OpticalFlow.smoothstep(1, 4, 1), 0)
        XCTAssertEqual(OpticalFlow.smoothstep(1, 4, 2.5), 0.5)
        XCTAssertEqual(OpticalFlow.smoothstep(1, 4, 4), 1)
        XCTAssertEqual(OpticalFlow.smoothstep(1, 4, 400), 1)
        XCTAssertEqual(OpticalFlow.smoothstep(0, 1, 0.25), 0.15625)
        XCTAssertTrue(OpticalFlow.smoothstep(0, 1, .nan).isNaN)
        // The reason the clamp is written out: the library's pair turns the NaN into 0.
        XCTAssertEqual(Swift.min(1.0, Swift.max(0.0, Double.nan)), 0)
        // A zero-width edge is a step, and x on it is 0/0, as `(x - e0) / (e1 - e0)` is in JavaScript.
        XCTAssertEqual(OpticalFlow.smoothstep(1, 1, 0.5), 0)
        XCTAssertEqual(OpticalFlow.smoothstep(1, 1, 1.5), 1)
        XCTAssertTrue(OpticalFlow.smoothstep(1, 1, 1).isNaN)
    }

    /// Half a texel of working size is rounded UP, as JavaScript's `Math.round` and Kotlin's
    /// `floor(x + 0.5)` round it: 1280x722 is 320 x 180.5, and 181 in every engine.
    func testRoundsAHalfTexelOfWorkingSizeUpAsJavaScriptAndKotlinDo() {
        XCTAssertEqual(OpticalFlow.pyramid(width: 1280, height: 722).first, FlowSize(width: 320, height: 181))
        XCTAssertEqual(OpticalFlow.pyramid(width: 722, height: 1280).first, FlowSize(width: 181, height: 320))
    }

    /// Where the TypeScript would hand the kernel a NaN or an Infinity, `Int(_:)` would trap.
    func testLumaTapsOfAWorkingSizeWithAZeroSideIsAnAnswerNotATrap() {
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 0, height: 0, working: FlowSize(width: 0, height: 0)), 1)
        XCTAssertEqual(OpticalFlow.lumaTaps(width: 720, height: 1280, working: FlowSize(width: 0, height: 320)),
                       OpticalFlow.FLOW.maxLumaTaps)
    }

    /// The TypeScript's `list[Math.min(level, list.length - 1)] ?? 1`, where Kotlin would throw.
    func testIterationsAtALevelBeforeTheFirstOrOnAnEmptyListIsOne() {
        XCTAssertEqual(OpticalFlow.iterationsAt(-1), 1)
        XCTAssertEqual(OpticalFlow.iterationsAt(0, settings: settings(iterations: [])), 1)
        XCTAssertEqual(OpticalFlow.iterationsAt(7, settings: settings(iterations: [2])), 2)
    }

    /// `trackPoints` reads the flow exactly where, and as often as, the synthesis kernel samples it:
    /// once at the pixel, twice per re-seek, and once at each found point.
    func testTrackPointsReadsTheFlowAsOftenAsTheKernelSamplesIt() {
        for (iterations, reads) in [(0, 3), (1, 5), (2, 7)] {
            var count = 0
            let field: OpticalFlow.FlowField = { _ in
                count += 1
                return SIMD4(0.06, -0.03, -0.06, 0.03)
            }
            let tracked = OpticalFlow.trackPoints(field, uv: [0.4, 0.6], t: 0.25, size: size,
                                                  settings: settings(trackIterations: iterations))
            XCTAssertEqual(count, reads, "trackIterations \(iterations)")
            // Uniform motion settles at once, however many times it is re-sought.
            close(tracked.pa, [0.4 - 0.25 * 0.06, 0.6 + 0.25 * 0.03])
            close(tracked.missA, 0)
        }
    }
}
