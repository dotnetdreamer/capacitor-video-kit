import XCTest
@testable import CapacitorVideoKitCore

/// Which two recorded frames every output frame of a slowed clip is made from, and how far between
/// them - the part of slow motion that is arithmetic - held to the WEB engine's answers:
/// `slow-motion.unit.test.ts` case for case, in its order, with the same inputs and the same numbers.
///
/// Where the web asks `slowFramesAt(plannedClip, offsetIntoClipUs, times)`, iOS asks the same question
/// the way its compositor will: the clip as the builder lays it (`Slowed`: the source range it inserted
/// and the ms-rounded output range it placed it on), and the output instant as the composition presents
/// it (`k / fps` exactly, `vc.frameDuration` being `1 / fps`). Same table, same answers.
///
/// Then the cases of Android's `SlowMotionTest.kt` whose rules are the web's too, re-expressed on the
/// source timeline, and the iOS-only ones: the builder's millisecond rounding and why the mapping needs
/// no clamp. `frameSeekTarget` has no twin here: it aims a browser's media element at a frame, and the
/// iOS reader decodes frames rather than seeking to them.
final class SlowMotionTests: XCTestCase {

    // MARK: - The clip as the builder lays it

    /// A constant-rate grid: `count` frames at `fps`, starting at 0. `grid` in the TypeScript test.
    private func grid(_ fps: Double, _ count: Int) -> [Double] {
        (0..<count).map { Double($0) / fps }
    }

    /// The whole milliseconds the builder scales `sourceMs` of a clip at `speed` onto - the line in
    /// `CompositionBuilder` that places every slowed base clip:
    /// `max(1, Int64((Double(sourceMs) / speed).rounded(.toNearestOrAwayFromZero)))`.
    private func placedMs(_ sourceMs: Int64, _ speed: Double) -> Int64 {
        max(1, Int64((Double(sourceMs) / speed).rounded(.toNearestOrAwayFromZero)))
    }

    /// A slowed clip on the composition: `inserted` is the source range the builder inserted, `placed`
    /// the output range `scaleTimeRange` put it on, both in seconds the way the compositor will read
    /// them off their `CMTime`s (`ms(x)` is `x` over a timescale of 1000).
    private struct Slowed {
        let insertedStart: Double
        let insertedDuration: Double
        let placedStart: Double
        let placedDuration: Double

        func pair(_ times: [Double], at t: Double) -> FramePair? {
            SlowMotion.slowFramesAt(times, composition: t, placedStart: placedStart, placedDuration: placedDuration,
                                    insertedStart: insertedStart, insertedDuration: insertedDuration)
        }

        func source(at t: Double) -> Double {
            SlowMotion.sourceSeconds(composition: t, placedStart: placedStart, placedDuration: placedDuration,
                                     insertedStart: insertedStart, insertedDuration: insertedDuration)
        }
    }

    /// `inMs ..< outMs` of a file at `speed`, placed at `atMs` on the output: what `planned({...})` is to
    /// the TypeScript test. The clips there are the post's only clip, so they start at output zero.
    private func slowed(inMs: Int64 = 0, outMs: Int64 = 1000, speed: Double, atMs: Int64 = 0) -> Slowed {
        Slowed(insertedStart: Double(inMs) / 1000, insertedDuration: Double(outMs - inMs) / 1000,
               placedStart: Double(atMs) / 1000, placedDuration: Double(placedMs(outMs - inMs, speed)) / 1000)
    }

    /// Output frame `k`'s composition time at `fps`: `k / fps`, as the composition's own clock presents
    /// it. The TypeScript's `outputUs` is the same instant rounded to the microsecond.
    private func output(_ k: Int, _ fps: Int) -> Double {
        Double(k) / Double(fps)
    }

    /// `[a, weight]` for the first `n` output frames of `clip`, weights to three places: `frames` in the
    /// TypeScript test, counted from the clip's own start.
    private func frames(_ clip: Slowed, _ times: [Double], _ fps: Int, _ n: Int, from: Int = 0) -> [[Double]] {
        (0..<n).map { i in
            let pair = clip.pair(times, at: clip.placedStart + output(from + i, fps))!
            return [Double(pair.a), (pair.weight * 1000).rounded() / 1000]
        }
    }

    // MARK: - Which clips are synthesised

    func testAVideoSlowerThan1xAndNothingElse() {
        XCTAssertTrue(SlowMotion.isSlowMotion(speed: 0.5, image: false, held: false))
        XCTAssertTrue(SlowMotion.isSlowMotion(speed: 0.3, image: false, held: false))
        // 1x and faster already have a recorded frame for every output frame, and are drawn exactly as
        // they always were.
        XCTAssertFalse(SlowMotion.isSlowMotion(speed: 1, image: false, held: false))
        XCTAssertFalse(SlowMotion.isSlowMotion(speed: 2, image: false, held: false))
        // A picture has one frame, whatever a hand-written spec says its speed is.
        XCTAssertFalse(SlowMotion.isSlowMotion(speed: 0.5, image: true, held: false))
        // iOS only: a held clip - an in point at or past the footage's end - is one frame too.
        XCTAssertFalse(SlowMotion.isSlowMotion(speed: 0.5, image: false, held: true))
        XCTAssertFalse(SlowMotion.isSlowMotion(speed: .nan, image: false, held: false))
    }

    // MARK: - The frames and weights of a slowed clip

    func testAt05xOn30fpsFootageIntoA30fpsPostEveryOtherOutputFrameIsHalfwayBetweenTwo() {
        let times = grid(30, 90)
        XCTAssertEqual(frames(slowed(speed: 0.5), times, 30, 6), [
            [0, 0],
            [0, 0.5],
            [1, 0],
            [1, 0.5],
            [2, 0],
            [2, 0.5],
        ])
    }

    func testAt03xANewPictureOnEveryOutputFrameWhereThePlainPathRepeatedEachFrameThreeOrFourTimes() {
        let times = grid(30, 90)
        let made = frames(slowed(speed: 0.3), times, 30, 8)
        XCTAssertEqual(made, [
            [0, 0],
            [0, 0.3],
            [0, 0.6],
            [0, 0.9],
            [1, 0.2],
            [1, 0.5],
            [1, 0.8],
            [2, 0.1],
        ])
        // No two neighbouring output frames are the same picture.
        for i in 1..<made.count { XCTAssertNotEqual(made[i], made[i - 1]) }
    }

    func testIsIndependentOfTheOutputRate05xIntoA60fpsPostIsFourStepsAFrame() {
        XCTAssertEqual(frames(slowed(speed: 0.5), grid(30, 90), 60, 5), [
            [0, 0],
            [0, 0.25],
            [0, 0.5],
            [0, 0.75],
            [1, 0],
        ])
    }

    func testStartsOnTheFrameAtTheClipsInPointAlone() {
        // An in point exactly on frame 30: the first output frame IS that frame, with nothing mixed in -
        // the same first frame the plain path draws.
        let clip = slowed(inMs: 1000, outMs: 2000, speed: 0.3)
        XCTAssertEqual(clip.pair(grid(30, 90), at: clip.placedStart), FramePair(a: 30, b: 31, weight: 0))
    }

    func testHoldsTheClipsFirstFrameWhileItsInPointIsBetweenTwoFramesAndNeverBlendsInTheOneBeforeIt() {
        // In at 1020 ms, between frame 30 (1000) and frame 31 (1033.3). Frame 30 was trimmed away, so the
        // clip's first frame is 31, and it stands until it is due - Android's lead, to the frame.
        let clip = slowed(inMs: 1020, outMs: 2000, speed: 0.3)
        XCTAssertEqual(frames(clip, grid(30, 90), 30, 3), [
            [31, 0],
            [31, 0],
            [31, 0.2],
        ])
        XCTAssertNil(clip.pair(grid(30, 90), at: clip.placedStart)?.b)
    }

    func testHoldsTheClipsLastFrameRatherThanBlendInFootagePastItsOutPoint() {
        // 0..1000 ms at 0.5x is two seconds of post; its last output frame at 30 fps is 1966.7 ms in,
        // 983.3 ms into the source, halfway from frame 29 to frame 30 - and frame 30, at 1000 ms, is
        // the first frame the out point cuts away. So 29 is held, as Android holds its tail.
        let clip = slowed(outMs: 1000, speed: 0.5)
        XCTAssertEqual(clip.placedDuration, 2)
        XCTAssertEqual(clip.pair(grid(30, 90), at: output(59, 30)), FramePair(a: 29, b: nil, weight: 0))
        // Ten milliseconds more of the clip, and frame 30 is its own: blended towards.
        let longer = slowed(outMs: 1010, speed: 0.5).pair(grid(30, 90), at: output(59, 30))!
        XCTAssertEqual(longer.a, 29)
        XCTAssertEqual(longer.b, 30)
        XCTAssertEqual(longer.weight, 0.5, accuracy: 0.00005)
    }

    func testDrawsTheFilesLastFrameAloneWithNothingAfterItToBlendTowards() {
        // The file ends at frame 29, and so does the clip.
        let clip = slowed(outMs: 1000, speed: 0.5)
        XCTAssertEqual(clip.pair(grid(30, 30), at: output(59, 30)), FramePair(a: 29, b: nil, weight: 0))
    }

    func testDrawsAClipTooShortToHoldAFrameOfItsOwnFromTheFrameThatCoversItAlone() {
        // 1010..1020 ms lies wholly between frames 30 and 31.
        XCTAssertEqual(SlowMotion.framePairAt(grid(30, 90), seconds: 1.015, window: SourceWindow(from: 1.01, to: 1.02)),
                       FramePair(a: 30, b: nil, weight: 0))
        // And through the builder's placement of it: forty milliseconds of 0.25x at 400 ms, both of the
        // output's instants in it.
        let clip = slowed(inMs: 1010, outMs: 1020, speed: 0.25, atMs: 400)
        XCTAssertEqual(clip.placedDuration, 0.04)
        for k in 12...13 {
            XCTAssertEqual(clip.pair(grid(30, 90), at: output(k, 30)), FramePair(a: 30, b: nil, weight: 0), "k \(k)")
        }
    }

    // MARK: - framePairAt

    private let thirty = (0..<30).map { Double($0) / 30 }

    func testIsTheFrameItselfAloneAtItsOwnTimestamp() {
        XCTAssertEqual(SlowMotion.framePairAt(thirty, seconds: 10.0 / 30), FramePair(a: 10, b: 11, weight: 0))
    }

    func testIsTheFractionOfTheWayToTheNextFrameBetweenTwo() {
        let pair = SlowMotion.framePairAt(thirty, seconds: 10.25 / 30)!
        XCTAssertEqual(pair.a, 10)
        XCTAssertEqual(pair.b, 11)
        XCTAssertEqual(pair.weight, 0.25, accuracy: 5e-10)
    }

    func testTakesAnInstantARoundingErrorShortOfAFrameAsThatFrame() {
        // 1/3 of a second, computed from microseconds the way the web's render computes it.
        XCTAssertEqual(SlowMotion.framePairAt(thirty, seconds: 333_333.0 / 1_000_000), FramePair(a: 10, b: 11, weight: 0))
    }

    func testDrawsAWeightTooSmallForAny8BitValueToShowAsNoneSoBIsNeverDecodedForIt() {
        let tiny = (10 + SlowMotion.MIN_TWEEN_WEIGHT / 2) / 30
        XCTAssertEqual(SlowMotion.framePairAt(thirty, seconds: tiny)?.weight, 0)
        // iOS only: the two tolerances themselves, which every engine shares.
        XCTAssertEqual(SlowMotion.MIN_TWEEN_WEIGHT, 1.0 / 512)
        XCTAssertEqual(SlowMotion.SAME_FRAME_S, 1e-6)
    }

    func testIsTheFirstFrameAloneBeforeIt() {
        XCTAssertEqual(SlowMotion.framePairAt([0.1, 0.2, 0.3], seconds: 0), FramePair(a: 0, b: nil, weight: 0))
    }

    func testIsNothingForAFileWithNoFrames() {
        XCTAssertNil(SlowMotion.framePairAt([], seconds: 0.5))
    }

    func testWeighsAVariableFrameRateByTheTimeThatReallyPassedBetweenTheTwoFrames() {
        // A phone in low light: 30 fps, then one frame held for twice as long, then 30 fps again.
        let vfr = [0, 1.0 / 30, 3.0 / 30, 4.0 / 30]
        // Halfway through the long frame is halfway between it and the next - not three quarters of the
        // way, which a constant 30 fps would have said.
        let pair = SlowMotion.framePairAt(vfr, seconds: 2.0 / 30)!
        XCTAssertEqual(pair.a, 1)
        XCTAssertEqual(pair.b, 2)
        XCTAssertEqual(pair.weight, 0.5, accuracy: 5e-10)
    }

    // MARK: - frameTimes

    func testSortsADecodeOrderListIntoPresentationOrderOnceEach() {
        // B-frames: I P B B, stored in decode order, and a packet the container carries twice.
        let times = SlowMotion.frameTimes([0, 3.0 / 30, 1.0 / 30, 2.0 / 30, 2.0 / 30, .nan])
        XCTAssertEqual(times, [0, 1.0 / 30, 2.0 / 30, 3.0 / 30])
    }

    // MARK: - Android's SlowMotionTest, on the web's rules

    /// "half speed doubles the frames, every other one a source frame and the rest even halves": 500 ms
    /// of source at 0.5x fills a second of output. Frame 14 is the clip's last own frame - frame 15, at
    /// 500 ms, is the out point - so it is drawn alone on its own instant and then held, as Android's
    /// tail holds it.
    func testHalfSpeedDoublesTheFramesEveryOtherOneASourceFrameAndTheRestEvenHalves() {
        let clip = slowed(outMs: 500, speed: 0.5)
        XCTAssertEqual(clip.placedDuration, 1)
        let made = (0..<30).map { clip.pair(grid(30, 90), at: output($0, 30))! }
        for (k, pair) in made.enumerated() where k < 28 {
            XCTAssertEqual(pair.a, k / 2, "k \(k)")
            XCTAssertEqual(pair.b, k / 2 + 1, "k \(k)")
            XCTAssertEqual(pair.weight, k % 2 == 0 ? 0 : 0.5, accuracy: 1e-9, "k \(k)")
        }
        XCTAssertEqual(made[28], FramePair(a: 14, b: nil, weight: 0))
        XCTAssertEqual(made[29], FramePair(a: 14, b: nil, weight: 0))
    }

    /// "at 0.3x each instant is weighted by where it falls between its two neighbours": nine source
    /// frames fill a second of output, each weight is the instant's own fraction of its pair, and the
    /// first ones are 0.3, 0.6 and 0.9.
    func testAt03xEachInstantIsWeightedByWhereItFallsBetweenItsTwoNeighbours() {
        let times = grid(30, 90)
        let clip = slowed(outMs: 300, speed: 0.3)
        XCTAssertEqual(clip.placedDuration, 1)
        for k in 0..<30 {
            let t = output(k, 30)
            let pair = clip.pair(times, at: t)!
            guard let b = pair.b, pair.weight > 0 else { continue }
            let s = clip.source(at: t)
            XCTAssertEqual(pair.weight, (s - times[pair.a]) / (times[b] - times[pair.a]), accuracy: 1e-9, "k \(k)")
            XCTAssertTrue(pair.weight > 0 && pair.weight < 1, "k \(k)")
        }
        XCTAssertEqual(clip.pair(times, at: output(1, 30))!.weight, 0.3, accuracy: 1e-9)
        XCTAssertEqual(clip.pair(times, at: output(2, 30))!.weight, 0.6, accuracy: 1e-9)
        XCTAssertEqual(clip.pair(times, at: output(3, 30))!.weight, 0.9, accuracy: 1e-9)
        // Frame 8, at 266.7 ms, is the last the 300 ms out point keeps; from 270 ms on it is held.
        XCTAssertEqual(clip.pair(times, at: output(27, 30)), FramePair(a: 8, b: nil, weight: 0))
    }

    /// "a slowed clip comes out at the output cadence, one interval apart, whatever the speed" and
    /// "other output rates are honoured": the cadence itself is the composition's (`vc.frameDuration`),
    /// so what is left to pin is that every one of its instants is a NEW picture - a different pair or
    /// a different weight from the instant before - at every speed and rate, until the clip's last own
    /// frame, from where it is held.
    func testEveryInstantIsANewPictureWhateverTheSpeedAndTheOutputRateUntilTheLastFrameIsHeld() {
        let times = grid(30, 900)
        for fps in [24, 25, 30, 60] {
            for speed in [0.25, 0.3, 0.4, 0.5, 0.6, 0.93] {
                // 1.5 s of output, placed where the builder's millisecond cursor might put it.
                let clip = slowed(outMs: Int64((1500 * speed).rounded()), speed: speed, atMs: 2345)
                let first = Int((clip.placedStart * Double(fps)).rounded(.up))
                let end = clip.placedStart + clip.placedDuration
                var previous: FramePair?
                var k = first
                while output(k, fps) < end {
                    let pair = clip.pair(times, at: output(k, fps))!
                    if let previous, pair.b != nil {
                        XCTAssertNotEqual(pair, previous, "\(fps) fps, \(speed)x, k \(k)")
                    }
                    previous = pair
                    k += 1
                }
                // At the output's rate: 1.5 s of it is 1.5 * fps instants, give or take the one the
                // clip's phase on the grid adds or takes.
                XCTAssertLessThanOrEqual(abs(Double(k - first) - 1.5 * Double(fps)), 1, "\(fps) fps, \(speed)x")
            }
        }
    }

    /// "nothing is ever stamped outside the item": on the web's rules, no instant ever draws a frame
    /// from outside the clip's own window. An in point 11.3 ms before frame 1 is held on frame 1, and
    /// the tail holds the last frame before the out point.
    func testNoInstantEverDrawsAFrameFromOutsideTheClip() {
        let times = grid(30, 900)
        for speed in [0.25, 0.3, 0.5] {
            let clip = slowed(inMs: 22, outMs: 22 + Int64((1670 * speed).rounded()), speed: speed, atMs: 7830)
            let window = clip.insertedStart ..< clip.insertedStart + clip.insertedDuration
            let end = clip.placedStart + clip.placedDuration
            var k = Int((clip.placedStart * 30).rounded(.up))
            XCTAssertEqual(clip.pair(times, at: output(k, 30)), FramePair(a: 1, b: nil, weight: 0), "\(speed)x")
            var last: FramePair?
            while output(k, 30) < end {
                let pair = clip.pair(times, at: output(k, 30))!
                XCTAssertTrue(window.contains(times[pair.a]), "\(speed)x, k \(k): a \(pair.a)")
                if let b = pair.b { XCTAssertTrue(window.contains(times[b]), "\(speed)x, k \(k): b \(b)") }
                last = pair
                k += 1
            }
            XCTAssertNil(last?.b, "\(speed)x: the tail holds")
            XCTAssertEqual(last?.weight, 0)
        }
    }

    /// "the tail holds the last frame out to the end of the item": a 0.25x clip whose last source frame
    /// lands 120 ms of output before its end. On a four-frame file and on a longer one the out point
    /// trims, the same three instants hold the same frame.
    func testTheTailHoldsTheLastFrameOutToTheEndOfTheClip() {
        let clip = slowed(outMs: 130, speed: 0.25)
        XCTAssertEqual(clip.placedDuration, 0.52)
        for times in [grid(30, 4), grid(30, 90)] {
            let after = (0..<16).filter { output($0, 30) > 0.4 }
            XCTAssertEqual(after, [13, 14, 15])
            for k in after { XCTAssertEqual(clip.pair(times, at: output(k, 30)), FramePair(a: 3, b: nil, weight: 0)) }
        }
    }

    /// "a frame that does not come after the one before it is passed over, never drawn": on the web's
    /// rules a DUPLICATE is dropped, and a frame out of order is SORTED into place rather than passed
    /// over - a reader hands samples over in decode order. The instant at 166.7 ms is still a quarter of
    /// the way from 133.3 ms to 266.7 ms.
    func testADuplicateFrameIsDroppedAndOneOutOfOrderIsSortedIntoPlace() {
        let times = SlowMotion.frameTimes([0, 0.133333, 0.133333, 0.1, 0.266667])
        XCTAssertEqual(times, [0, 0.1, 0.133333, 0.266667])
        let pair = SlowMotion.framePairAt(times, seconds: 0.166667)!
        XCTAssertEqual(pair.a, 2)
        XCTAssertEqual(pair.b, 3)
        XCTAssertEqual(pair.weight, 0.25, accuracy: 1e-4)
    }

    /// "a source already at the output rate is drawn frame for frame": 60 fps at 0.5x into 30 fps.
    /// Nothing is missing, so every instant is a recorded frame, alone.
    func testASourceAlreadyAtTheOutputRateIsDrawnFrameForFrame() {
        let clip = slowed(outMs: 500, speed: 0.5)
        for k in 0..<30 {
            let pair = clip.pair(grid(60, 120), at: output(k, 30))!
            XCTAssertEqual(pair.a, k)
            XCTAssertEqual(pair.weight, 0)
        }
    }

    /// "an item with no frames at all ends at once": there is no pair to draw.
    func testAClipWithNoFramesAtAllHasNoPair() {
        XCTAssertNil(slowed(speed: 0.5).pair([], at: 0.1))
    }

    // MARK: - iOS only: the builder's placement

    /// The builder rounds the scaled length to whole milliseconds, so 1000 ms at 0.3x is placed on
    /// 3333 ms and PLAYS at 1000/3333 = 0.30003x. Mapped through what the builder inserted and placed,
    /// the placed range's end lands exactly on the out point, as `scaleTimeRange` plays it; mapped
    /// through the spec's 0.3, source time falls behind by 3 µs per 100 ms of output - 99 µs by the last
    /// instant, 100 µs at the end - and `w` drifts by more than the weight B is dropped under.
    func testMapsThroughTheInsertedAndPlacedRangesNotThroughTheSpecsSpeed() {
        let clip = slowed(outMs: 1000, speed: 0.3)
        XCTAssertEqual(placedMs(1000, 0.3), 3333)
        XCTAssertEqual(clip.placedDuration, 3.333)
        XCTAssertEqual(clip.source(at: 0), 0)
        XCTAssertEqual(clip.source(at: clip.placedDuration), 1, accuracy: 1e-12)
        XCTAssertEqual(clip.placedDuration * 0.3, 0.9999, accuracy: 1e-12)
        // The drift at the last instant, k = 99 at 3.3 s: 3.3 / 3.333 - 3.3 * 0.3.
        XCTAssertEqual(clip.source(at: output(99, 30)) - output(99, 30) * 0.3, 99.009901e-6, accuracy: 1e-11)
        // At 3.2 s, both put the instant between frames 28 and 29, at different weights.
        let s = clip.source(at: output(96, 30))
        let pair = SlowMotion.framePairAt(grid(30, 90), seconds: s, window: SourceWindow(from: 0, to: 1))!
        let bySpeed = SlowMotion.framePairAt(grid(30, 90), seconds: output(96, 30) * 0.3,
                                             window: SourceWindow(from: 0, to: 1))!
        XCTAssertEqual(pair.a, 28)
        XCTAssertEqual(bySpeed.a, 28)
        XCTAssertEqual(bySpeed.weight, 0.8, accuracy: 1e-9)
        XCTAssertEqual(pair.weight, 0.802880288, accuracy: 1e-9)
        XCTAssertGreaterThan(pair.weight - bySpeed.weight, SlowMotion.MIN_TWEEN_WEIGHT)
        // A speed whose scaled length is a whole number of milliseconds has nothing to drift by.
        for speed in [0.25, 0.5] {
            let exact = slowed(outMs: 1000, speed: speed)
            XCTAssertEqual(exact.source(at: 1.5), 1.5 * speed, accuracy: 1e-15, "\(speed)x")
        }
    }

    /// The web clamps source time to `outUs - 1` before it looks for a pair. iOS does not, because the
    /// window rules make every instant at or past the clip's last own frame the same answer: the last
    /// frame, held alone. Before the in point, the hold-first rule draws the web's picture too.
    func testNeedsNoClampAtTheOutPointBecauseTheWindowAlreadyHoldsTheLastFrame() {
        let times = grid(30, 90)
        let window = SourceWindow(from: 0, to: 1)
        let clamped = SlowMotion.framePairAt(times, seconds: 1 - 1e-6, window: window)
        XCTAssertEqual(clamped, FramePair(a: 29, b: nil, weight: 0))
        for s in [0.9667, 1.0 - 1e-7, 1, 1.0 + 1e-7, 1.02, 1.5, 30] {
            XCTAssertEqual(SlowMotion.framePairAt(times, seconds: s, window: window), clamped, "s \(s)")
        }
        // Through the mapping: an instant at, or past, the end of the placed range.
        let clip = slowed(outMs: 1000, speed: 0.3)
        for t in [clip.placedDuration, clip.placedDuration + 0.001, clip.placedDuration + 1] {
            XCTAssertEqual(clip.pair(times, at: t), clamped, "t \(t)")
        }
        // Before the placed range, where the web clamps the offset to 0: the clip's first frame, alone.
        let late = slowed(inMs: 1000, outMs: 2000, speed: 0.3, atMs: 5000)
        let atStart = late.pair(times, at: late.placedStart)!
        let before = late.pair(times, at: late.placedStart - 0.01)!
        XCTAssertEqual(before.a, atStart.a)
        XCTAssertEqual(before.weight, 0)
        XCTAssertEqual(atStart, FramePair(a: 30, b: 31, weight: 0))
    }

    /// Where a Double can go wrong: a NaN instant, a window that is NaN, a placement of no length, and a
    /// chain of near-duplicate times - each an answer, never a trap or an index out of range.
    func testDegenerateInputsHaveAnswers() {
        let times = grid(30, 90)
        XCTAssertEqual(SlowMotion.framePairAt(times, seconds: .nan, window: SourceWindow(from: 1, to: 2)),
                       FramePair(a: 30, b: nil, weight: 0))
        XCTAssertEqual(SlowMotion.framePairAt(times, seconds: 0.5, window: SourceWindow(from: .nan, to: .nan)),
                       FramePair(a: 15, b: nil, weight: 0))
        XCTAssertEqual(SlowMotion.sourceSeconds(composition: 3, placedStart: 1, placedDuration: 0,
                                                insertedStart: 0.25, insertedDuration: 1), 0.25)
        // Each time is measured against the last one KEPT, so the chain keeps its first and every one
        // a whole tolerance on from the one before it.
        XCTAssertEqual(SlowMotion.frameTimes([0, 0.6e-6, 1.2e-6, 1.8e-6, 2.4e-6]), [0, 1.2e-6, 2.4e-6])
        XCTAssertEqual(SlowMotion.frameTimes([Double.infinity, -.infinity, 0.5]), [0.5])
    }
}

// MARK: - The iOS side's own wiring

extension SlowMotionTests {

    /// A transition tail the builder CUT to a short incoming clip: in 1000, out 1500 at 0.5x under a 600 ms
    /// incoming clip is inserted as 300 ms of source over 600 ms. The web plans that tail as the whole from-clip
    /// and cuts only its length (`planTransition` in plan.ts), so its window is [1.0, 1.5) and its last instant
    /// before the cut is a blend towards frame 39 at 1.3 - which is the clip's own. Mapped through the inserted
    /// span as the window, the same instant would hold frame 38 alone.
    func testACutTailBlendsTowardsItsClipsNextFramePastTheCut() {
        let times = grid(30, 90)
        let t = 2.0 + 17.0 / 30   // the tail placed at 2 s; its 18th instant
        let wide = SlowMotion.slowFramesAt(times, composition: t, placedStart: 2, placedDuration: 0.6,
                                           insertedStart: 1, insertedDuration: 0.3,
                                           window: SourceWindow(from: 1, to: 1.5))
        XCTAssertEqual(wide?.a, 38)
        XCTAssertEqual(wide?.b, 39)
        XCTAssertEqual(wide?.weight ?? 0, 0.5, accuracy: 1e-9)
        // The window defaults to the inserted span, which is every base clip's and every layer's.
        let cut = SlowMotion.slowFramesAt(times, composition: t, placedStart: 2, placedDuration: 0.6,
                                          insertedStart: 1, insertedDuration: 0.3)
        XCTAssertEqual(cut, FramePair(a: 38, b: nil, weight: 0))
        // Every earlier instant of the tail is the same either way.
        for k in 0..<17 {
            let at = 2.0 + Double(k) / 30
            XCTAssertEqual(SlowMotion.slowFramesAt(times, composition: at, placedStart: 2, placedDuration: 0.6,
                                                   insertedStart: 1, insertedDuration: 0.3,
                                                   window: SourceWindow(from: 1, to: 1.5)),
                           SlowMotion.slowFramesAt(times, composition: at, placedStart: 2, placedDuration: 0.6,
                                                   insertedStart: 1, insertedDuration: 0.3), "instant \(k)")
        }
    }

    /// The post's grade reaches the flow's luma pass through `RenderPlan.flowGrade`, as the web hands its luma
    /// pass `FlowGrade`: the folded colour matrix by ROWS - so the kernel's `M * rgb` is `ColorMatrix`'s own
    /// `m * rgb + b` - and its bias; the identity for a post with none. A grade changes which pairs the flow
    /// trusts and never a pixel an ungraded test would see, so this is held here, on the plan.
    func testThePlanHandsThePostsGradeToTheFlowsLumaPass() throws {
        func grade(_ filter: [[String: Any]]) throws -> FlowGrade {
            let url = URL(fileURLWithPath: "/nonexistent/v.mp4")
            let spec = try TestCalls.parse(TestSpecs.spec([TestSpecs.clip("v", url, outMs: 1000)], ["filter": filter]))
            return try RenderPlan(spec: spec).flowGrade
        }
        XCTAssertEqual(try grade([]), .identity)

        // contrast a: m = a I, b = 0.5 - 0.5 a.
        let contrast = try grade([["op": "contrast", "amount": 1.5]])
        XCTAssertEqual(contrast, FlowGrade(rowMajor: [1.5, 0, 0, 0, 1.5, 0, 0, 0, 1.5], bias: [-0.25, -0.25, -0.25]))
        XCTAssertNotEqual(contrast, .identity)

        // Sepia's rows differ, so a transposed matrix - or the matrix and the bias swapped, which is no grade
        // at all - cannot pass for it.
        let folded = ColorMatrix.fold([.sepia(1), .brightness(0.9)])
        let sepia = try grade([["op": "sepia", "amount": 1], ["op": "brightness", "amount": 0.9]])
        XCTAssertEqual(sepia, FlowGrade(rowMajor: folded.m, bias: folded.b))
        XCTAssertNotEqual(sepia, FlowGrade(rowMajor: [0, 3, 6, 1, 4, 7, 2, 5, 8].map { folded.m[$0] }, bias: folded.b))
        XCTAssertNotEqual(sepia, .identity)
        let rgb: [Double] = [0.2, 0.5, 0.7]
        let graded = sepia.matrix * SIMD3<Float>(rgb.map(Float.init)) + sepia.offset
        for row in 0..<3 {
            let want = (0..<3).reduce(folded.b[row]) { $0 + folded.m[row * 3 + $1] * rgb[$1] }
            XCTAssertEqual(Double(graded[row]), want, accuracy: 1e-6, "row \(row)")
        }
    }
}
