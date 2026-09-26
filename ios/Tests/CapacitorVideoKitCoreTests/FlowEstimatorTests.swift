import CoreVideo
@testable import CapacitorVideoKitCore
import Metal
import simd
import XCTest

/// The Metal flow on real GPU work, pinned the way painter-optical-flow.cmp.test.ts pins the web
/// engine's: ORIENTATION first (a Metal port's likeliest bug is a flipped y), then a moving square drawn
/// once, the cross-fade where nothing moves and across a cut, u_flowOn = 0 as the cross-fade, the grade
/// in the luma pass, the pass order of optical-flow-gl.ts, and the fallbacks. Every test runs on the
/// machine's real Metal device; one without Metal skips them.
final class FlowEstimatorTests: XCTestCase {

    // painter-optical-flow.cmp.test.ts's scene.
    static let W = 128, H = 128, SQUARE = 40, TOP = 44, LEFT = 30, MOVE = 16
    static let BACKGROUND = Picture.texture(1, W, H, 4, 0, 130)
    static let PATCH = Picture.texture(2, SQUARE, SQUARE, 5, 150, 255)

    /// The picture with the square `left` pixels in.
    static func scene(_ left: Int, _ background: Picture = BACKGROUND) -> Picture {
        var picture = background
        picture.draw(PATCH, x: left, y: TOP)
        return picture
    }

    var estimator: FlowEstimator!

    override func setUpWithError() throws {
        guard let estimator = FlowEstimator() else { throw XCTSkip("no Metal flow on this machine") }
        self.estimator = estimator
    }

    /// The frame at `weight` between `a` and `b`: with the flow, and with the same kernel told the flow is off.
    func draw(_ a: Picture, _ b: Picture, weight: Double, grade: FlowGrade = .identity) throws -> (flow: Picture, blend: Picture, result: FlowResult) {
        let pa = a.pixelBuffer, pb = b.pixelBuffer
        let result = try XCTUnwrap(estimator.estimate(frameA: pa, frameB: pb, width: a.width, height: a.height, grade: grade))
        let flowOut = try XCTUnwrap(TestPixels.buffer(width: a.width, height: a.height))
        let blendOut = try XCTUnwrap(TestPixels.buffer(width: a.width, height: a.height))
        XCTAssertTrue(estimator.synthesize(frameA: pa, frameB: pb, flow: result, weight: weight, into: flowOut))
        XCTAssertTrue(estimator.synthesize(frameA: pa, frameB: pb, flow: result, weight: weight, into: blendOut, flowOn: false))
        return (Picture(flowOut), Picture(blendOut), result)
    }

    /// Texel (x, y) of an rgba16Float texture.
    func texel(_ texels: [Float], _ texture: MTLTexture, _ x: Int, _ y: Int) -> SIMD4<Float> {
        let i = (y * texture.width + x) * 4
        return SIMD4(texels[i], texels[i + 1], texels[i + 2], texels[i + 3])
    }

    func median(_ values: [Float]) -> Float { values.sorted()[values.count / 2] }

    // MARK: - Orientation, before anything else

    /// A textured picture moved DOWN `d` rows between A and B has a forward flow of +d/height in y at the
    /// picture - texture coordinates, +y down, the web engine's convention (it uploads frames without
    /// UNPACK_FLIP_Y, so its row 0 is the picture's top, as a CVPixelBuffer's is) - no motion in x, and a
    /// backward flow of -d/height; and the frame halfway is the picture moved d/2 down. A y flip anywhere
    /// in the port (a viewport, a texture origin, a row order) turns the sign, and the halfway frame then
    /// lands d/2 UP: the blend's error or worse.
    func testAPatternMovedDownHasAPositiveYFlowAndLandsHalfwayDown() throws {
        let width = 96, height = 160, d = 6
        // A tall pattern; A shows its rows d ..< d + height, B its rows 0 ..< height, so B(y) = A(y - d).
        // (2d spare rows: the "moved up" picture below reads d/2 past A's.)
        let pattern = Picture.texture(3, width, height + 2 * d, 4)
        let a = pattern.rows(from: d, count: height)
        let b = pattern.rows(from: 0, count: height)
        let truth = pattern.rows(from: d / 2, count: height)
        let drawn = try draw(a, b, weight: 0.5)

        let flow = try XCTUnwrap(estimator.readHalfFloats(drawn.result.flow))
        XCTAssertEqual(drawn.result.width, width)
        XCTAssertEqual(drawn.result.height, height)
        var fx: [Float] = [], fy: [Float] = [], bx: [Float] = [], by: [Float] = []
        for y in 40..<120 {
            for x in 24..<72 {
                let t = texel(flow, drawn.result.flow, x, y)
                fx.append(t.x * Float(width)); fy.append(t.y * Float(height))
                bx.append(t.z * Float(width)); by.append(t.w * Float(height))
            }
        }
        XCTAssertEqual(median(fy), Float(d), accuracy: 0.1, "forward y, in texels: +d is DOWN")
        XCTAssertEqual(median(fx), 0, accuracy: 0.1, "forward x")
        XCTAssertEqual(median(by), -Float(d), accuracy: 0.1, "backward y")
        XCTAssertEqual(median(bx), 0, accuracy: 0.1, "backward x")

        // The halfway frame, away from the rows only one frame has: d/2 down, not the blend's two ghosts.
        let flowError = regionDifference(drawn.flow, truth, 0, 8, width, height - 16)
        let blendError = regionDifference(drawn.blend, truth, 0, 8, width, height - 16)
        let upError = regionDifference(drawn.flow, pattern.rows(from: d + d / 2, count: height), 0, 8, width, height - 16)
        XCTAssertLessThan(flowError, 2, "flow \(flowError) against the truth")
        XCTAssertLessThan(flowError, blendError * 0.2, "flow \(flowError) against the cross-fade's \(blendError)")
        XCTAssertGreaterThan(upError, blendError, "the picture moved d/2 UP would be the flipped port's answer")
    }

    /// The same for x: moved RIGHT d columns is +d/width in x. With the y test it pins that x and y are
    /// not swapped (the frame is not square).
    func testAPatternMovedRightHasAPositiveXFlow() throws {
        let width = 96, height = 160, d = 6
        let pattern = Picture.texture(4, width + d, height, 4)
        let a = pattern.columns(from: d, count: width)
        let b = pattern.columns(from: 0, count: width)
        let drawn = try draw(a, b, weight: 0.5)
        let flow = try XCTUnwrap(estimator.readHalfFloats(drawn.result.flow))
        var fx: [Float] = [], fy: [Float] = []
        for y in 40..<120 {
            for x in 24..<72 {
                let t = texel(flow, drawn.result.flow, x, y)
                fx.append(t.x * Float(width)); fy.append(t.y * Float(height))
            }
        }
        XCTAssertEqual(median(fx), Float(d), accuracy: 0.1)
        XCTAssertEqual(median(fy), 0, accuracy: 0.1)
        let truth = pattern.columns(from: d / 2, count: width)
        XCTAssertLessThan(regionDifference(drawn.flow, truth, 8, 0, width - 16, height), 2)
    }

    // MARK: - painter-optical-flow.cmp.test.ts, case for case

    /// 'draws the moving square once, halfway, where the cross-fade draws it twice at half strength'.
    func testTheMovingSquareIsDrawnOnceHalfwayNotTwiceAtHalfStrength() throws {
        let S = Self.self
        let truth = S.scene(S.LEFT + S.MOVE / 2)
        let drawn = try draw(S.scene(S.LEFT), S.scene(S.LEFT + S.MOVE), weight: 0.5)
        let flowError = meanDifference(drawn.flow, truth)
        let blendError = meanDifference(drawn.blend, truth)
        XCTAssertLessThan(flowError, blendError * 0.4, "flow \(flowError) against the cross-fade's \(blendError)")
        XCTAssertLessThan(flowError, 4)

        // The strip the square has LEFT by halfway is background again; the cross-fade still has half the square there.
        let strip = (S.LEFT + 1, S.TOP + 2, S.MOVE / 2 - 2, S.SQUARE - 4)
        XCTAssertLessThan(regionDifference(drawn.flow, truth, strip.0, strip.1, strip.2, strip.3), 8)
        XCTAssertGreaterThan(regionDifference(drawn.blend, truth, strip.0, strip.1, strip.2, strip.3), 25)
        // And the strip it has not reached yet.
        let ahead = (S.LEFT + S.SQUARE + S.MOVE / 2 + 1, S.TOP + 2, S.MOVE / 2 - 2, S.SQUARE - 4)
        XCTAssertLessThan(regionDifference(drawn.flow, truth, ahead.0, ahead.1, ahead.2, ahead.3), 8)
        XCTAssertGreaterThan(regionDifference(drawn.blend, truth, ahead.0, ahead.1, ahead.2, ahead.3), 25)
    }

    /// 'follows it a quarter and three quarters of the way too'.
    func testItFollowsTheSquareAQuarterAndThreeQuartersOfTheWay() throws {
        let S = Self.self
        for weight in [0.25, 0.75] {
            let truth = S.scene(S.LEFT + Int(Double(S.MOVE) * weight))
            let drawn = try draw(S.scene(S.LEFT), S.scene(S.LEFT + S.MOVE), weight: weight)
            XCTAssertLessThan(meanDifference(drawn.flow, truth), meanDifference(drawn.blend, truth) / 2, "at \(weight)")
        }
    }

    /// 'is the cross-fade where nothing moves'.
    func testItIsTheCrossFadeWhereNothingMoves() throws {
        let drawn = try draw(Self.scene(Self.LEFT), Self.scene(Self.LEFT), weight: 0.5)
        XCTAssertLessThanOrEqual(largestDifference(drawn.flow, drawn.blend), 1)
    }

    /// Static NOISE: one still 720x1280 picture with fresh noise on every frame (+-5 per channel, the
    /// benchmark's `noise=alls=5`), as the benchmark's static scene and a phone's sensor have it. Nothing
    /// moves, so the flow finds nothing and draws the cross-fade.
    ///
    /// Measured, and a property of the ALGORITHM rather than of this port (the luma pass's box is what
    /// averages the noise away, and it is 4x4 pixels only at 4:1): the same noise on SMALLER frames does
    /// find motion - at 360x640 (2:1, one bilinear read a texel) 1% of working texels move more than
    /// motionLow and 0.01% of channels differ from the blend by up to 8; at 180x320 (1:1) a third of the
    /// texels move. Whether the web engine does the same there has not been checked.
    func testStaticNoiseIsTheCrossFade() throws {
        let width = 720, height = 1280, amplitude = 5
        let still = Picture.texture(5, width, height, 8, 40, 215)
        func noisy(_ seed: UInt32) -> Picture {
            var picture = still
            let next = Picture.random(seed)
            for i in 0..<(width * height) {
                for c in 0..<3 {
                    let value = Int(picture.rgba[i * 4 + c]) + Int((next() * Double(2 * amplitude + 1)).rounded(.down)) - amplitude
                    picture.rgba[i * 4 + c] = UInt8(min(255, max(0, value)))
                }
            }
            return picture
        }
        for weight in [0.25, 0.5, 0.75] {
            let drawn = try draw(noisy(11), noisy(12), weight: weight)
            XCTAssertLessThanOrEqual(largestDifference(drawn.flow, drawn.blend), 1, "at \(weight)")
        }
    }

    /// 'is the cross-fade across a cut, which no motion explains' - and the pair's trust says so.
    func testACutIsTheCrossFadeAndIsNotTrusted() throws {
        let S = Self.self
        let drawn = try draw(S.scene(S.LEFT), S.scene(S.LEFT + S.MOVE, Picture.texture(7, S.W, S.H, 6)), weight: 0.5)
        XCTAssertLessThanOrEqual(largestDifference(drawn.flow, drawn.blend), 1)
        let visibility = try XCTUnwrap(estimator.readHalfFloats(drawn.result.visibility))
        XCTAssertLessThan(texel(visibility, drawn.result.visibility, 64, 64).z, 0.01, "trust")
        let trust = try XCTUnwrap(estimator.scratches.last.flatMap { estimator.readHalfFloats($0.trust) })
        XCTAssertLessThan(trust[0], 0.01)
        XCTAssertGreaterThan(trust[1], 0.5, "most of the frame fails the round trip")
    }

    /// u_flowOn = 0 is phase 1's cross-fade EXACTLY: the same bytes whether a flow is bound or not (the
    /// branch never reads it), and every byte the nearest to A (1 - w) + B w - except an exact tie (x.5,
    /// 46% of channels at w = 0.5), which goes up or down by the float rounding of `mix` in the kernel,
    /// as it does in the GL engines' `mix` (Metal took 72% of the static scene's ties up).
    func testFlowOffIsTheCrossFadeExactly() throws {
        let S = Self.self
        let a = S.scene(S.LEFT), b = S.scene(S.LEFT + S.MOVE, Picture.texture(9, S.W, S.H, 3))
        for weight in [0.25, 0.5, 0.75, 1.0 / 3.0] {
            let drawn = try draw(a, b, weight: weight)
            let none = try XCTUnwrap(TestPixels.buffer(width: a.width, height: a.height))
            XCTAssertTrue(estimator.synthesize(frameA: a.pixelBuffer, frameB: b.pixelBuffer, flow: nil, weight: weight, into: none))
            XCTAssertEqual(Picture(none).rgba, drawn.blend.rgba, "flowOn = 0 with a flow bound and with none, at \(weight)")
            var off = 0, ties = 0, up = 0, even = 0
            for i in 0..<a.rgba.count where i % 4 != 3 {
                let exact = Double(a.rgba[i]) * (1 - weight) + Double(b.rgba[i]) * weight
                let got = Double(drawn.blend.rgba[i])
                XCTAssertLessThanOrEqual(abs(got - exact), 0.5 + 1e-4, "channel \(i) at \(weight)")
                if abs(exact - exact.rounded(.down) - 0.5) < 1e-4 {
                    ties += 1
                    if got > exact { up += 1 }
                    if Int(got) % 2 == 0 { even += 1 }
                } else if got != exact.rounded() {
                    off += 1
                }
            }
            XCTAssertEqual(off, 0, "bytes not the nearest to mix(A, B, w) at \(weight) (ties \(ties): \(up) up, \(even) even)")
        }
    }

    // MARK: - The luma pass and its grade

    /// The luma pass sees the frames through the grade exactly as the GLSL does -
    /// `dot(clamp(M * rgb + offset, 0, 1), (0.299, 0.587, 0.114))` - with M applied as `M * v` from a
    /// ROW-major ColorMatrix: contrast 1.5 (m = 1.5 I, b = -0.25) and a sepia whose rows differ, which
    /// fails if the matrix is transposed anywhere between the ColorMatrix and the kernel.
    func testTheLumaPassAppliesTheGradeAsTheGLSLDoes() throws {
        let width = 64, height = 48 // the working size itself: one read per texel, taps = 1
        let a = Picture.texture(21, width, height, 1), b = Picture.texture(22, width, height, 1)
        let contrast = FlowGrade(rowMajor: [1.5, 0, 0, 0, 1.5, 0, 0, 0, 1.5], bias: [-0.25, -0.25, -0.25])
        let sepia = FlowGrade(rowMajor: [0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131], bias: [0.02, -0.03, 0.05])
        let rows: [String: ([Double], [Double])] = [
            "identity": ([1, 0, 0, 0, 1, 0, 0, 0, 1], [0, 0, 0]),
            "contrast": ([1.5, 0, 0, 0, 1.5, 0, 0, 0, 1.5], [-0.25, -0.25, -0.25]),
            "sepia": ([0.393, 0.769, 0.189, 0.349, 0.686, 0.168, 0.272, 0.534, 0.131], [0.02, -0.03, 0.05]),
        ]
        var lumas: [String: [Float]] = [:]
        for (name, grade) in [("identity", FlowGrade.identity), ("contrast", contrast), ("sepia", sepia)] {
            _ = try XCTUnwrap(estimator.estimate(frameA: a.pixelBuffer, frameB: b.pixelBuffer, width: width, height: height, grade: grade))
            let scratch = try XCTUnwrap(estimator.scratches.last)
            XCTAssertEqual(scratch.pyramid[0].width, width)
            let luma = try XCTUnwrap(estimator.readHalfFloats(scratch.pyramid[0]))
            lumas[name] = luma
            let (m, bias) = rows[name]!
            func expected(_ picture: Picture, _ i: Int) -> Float {
                let rgb = (0..<3).map { Double(picture.rgba[i * 4 + $0]) / 255 }
                let graded = (0..<3).map { row in min(1, max(0, m[row * 3] * rgb[0] + m[row * 3 + 1] * rgb[1] + m[row * 3 + 2] * rgb[2] + bias[row])) }
                return Float(graded[0] * 0.299 + graded[1] * 0.587 + graded[2] * 0.114)
            }
            var worst: Float = 0
            for i in 0..<(width * height) {
                worst = max(worst, abs(luma[i * 4] - expected(a, i)), abs(luma[i * 4 + 1] - expected(b, i)))
            }
            // Half-float storage: 11 significant bits, so at most 2^-11 off in 0..1.
            XCTAssertLessThan(worst, 0.0005, "\(name): the luma pass against the GLSL's formula")
        }
        XCTAssertNotEqual(lumas["identity"], lumas["contrast"])
    }

    /// With the frame four times the working size (1280x720 -> 320x180) the luma pass takes 2 x 2
    /// bilinear reads a texel, each exactly between four pixels: an exact 4x4 box over the texel's
    /// footprint. Off by half a texel anywhere (texel centres, the uv of a thread) and a per-pixel random
    /// picture tells at once.
    func testTheLumaPassIsAnExactBoxAtFourToOne() throws {
        let width = 1280, height = 720
        let a = Picture.texture(31, width, height, 1)
        _ = try XCTUnwrap(estimator.estimate(frameA: a.pixelBuffer, frameB: a.pixelBuffer, width: width, height: height))
        let scratch = try XCTUnwrap(estimator.scratches.last)
        XCTAssertEqual(scratch.sizes[0], FlowSize(width: 320, height: 180))
        XCTAssertEqual(OpticalFlow.lumaTaps(width: width, height: height, working: scratch.sizes[0]), 2)
        let luma = try XCTUnwrap(estimator.readHalfFloats(scratch.pyramid[0]))
        var worst: Float = 0
        for ty in stride(from: 0, to: 180, by: 7) {
            for tx in stride(from: 0, to: 320, by: 5) {
                var sum = 0.0
                for y in (ty * 4)..<(ty * 4 + 4) {
                    for x in (tx * 4)..<(tx * 4 + 4) {
                        let i = (y * width + x) * 4
                        sum += (0.299 * Double(a.rgba[i]) + 0.587 * Double(a.rgba[i + 1]) + 0.114 * Double(a.rgba[i + 2])) / 255
                    }
                }
                worst = max(worst, abs(luma[(ty * 320 + tx) * 4] - Float(sum / 16)))
            }
        }
        XCTAssertLessThan(worst, 0.002)
    }

    // MARK: - The orchestration

    /// The passes of one pair at 720x1280, in optical-flow-gl.ts's order: 40 of them.
    func testThePassesRunInTheWebEnginesOrder() throws {
        let a = Picture.texture(41, 720, 1280, 8)
        _ = try XCTUnwrap(estimator.estimate(frameA: a.pixelBuffer, frameB: a.pixelBuffer, width: 720, height: 1280))
        var expected: [FlowPass] = [.luma, .down, .down, .down, .down, .exposure, .gradient, .gradient, .gradient, .gradient, .gradient]
        for level in stride(from: 4, through: 0, by: -1) {
            expected += Array(repeating: .lucasKanade, count: [3, 3, 4, 5, 5][level]) + [.median]
        }
        expected += [.consistency, .fill, .trust, .visibility]
        XCTAssertEqual(estimator.passLog, expected)
        XCTAssertEqual(estimator.passLog.count, 40)
    }

    /// One compute encoder for the whole pair gives the very bytes one encoder per pass gives: Metal's
    /// hazard tracking orders the dispatches of a serial encoder as encoder boundaries would.
    func testOneEncoderMatchesOneEncoderPerPass() throws {
        let S = Self.self
        let a = S.scene(S.LEFT).pixelBuffer, b = S.scene(S.LEFT + S.MOVE).pixelBuffer
        let shared = try XCTUnwrap(estimator.estimate(frameA: a, frameB: b, width: S.W, height: S.H))
        estimator.encoderPerPass = true
        let separate = try XCTUnwrap(estimator.estimate(frameA: a, frameB: b, width: S.W, height: S.H))
        estimator.encoderPerPass = false
        XCTAssertEqual(estimator.readHalfFloats(shared.flow), estimator.readHalfFloats(separate.flow))
        XCTAssertEqual(estimator.readHalfFloats(shared.visibility), estimator.readHalfFloats(separate.visibility))
    }

    /// The scratch is kept for two frame sizes at once, least recently used dropped first.
    func testScratchIsKeptForTwoSizes() throws {
        for (w, h) in [(64, 64), (96, 64), (64, 64), (128, 64)] {
            let p = Picture.texture(51, w, h, 4).pixelBuffer
            _ = try XCTUnwrap(estimator.estimate(frameA: p, frameB: p, width: w, height: h))
        }
        XCTAssertEqual(estimator.scratches.map { "\($0.width)x\($0.height)" }, ["64x64", "128x64"])
    }

    // MARK: - Fallbacks: nil, never a crash

    func testNoDeviceIsNoEstimator() {
        XCTAssertNil(FlowEstimator(device: nil))
    }

    func testAFrameThatIsNotWhatItSaysIsNoFlow() throws {
        let p = Picture.texture(61, 64, 64, 4).pixelBuffer
        XCTAssertNil(estimator.estimate(frameA: p, frameB: p, width: 32, height: 64))
        var yuv: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, 64, 64, kCVPixelFormatType_420YpCbCr8BiPlanarFullRange,
                            [kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any]] as CFDictionary, &yuv)
        XCTAssertNil(estimator.estimate(frameA: try XCTUnwrap(yuv), frameB: p, width: 64, height: 64))
        let out = try XCTUnwrap(TestPixels.buffer(width: 64, height: 64))
        XCTAssertFalse(estimator.synthesize(frameA: try XCTUnwrap(yuv), frameB: p, flow: nil, weight: 0.5, into: out))
    }

    // MARK: - The generated MSL and its uniforms

    func testTheUniformsAreLaidOutAsTheMSLStruct() {
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_size), 0)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_sourceTexel), 8)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_fresh), 16)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_taps), 20)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_flowOn), 24)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_w), 28)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_flowSize), 32)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_matrix), 48)
        XCTAssertEqual(MemoryLayout<PassUniforms>.offset(of: \.u_offset), 96)
        XCTAssertEqual(MemoryLayout<PassUniforms>.stride, 112)
    }

    /// The settings are spliced into the MSL as `glslFloat` splices them into the GLSL.
    func testTheSettingsAreSplicedIntoTheKernels() {
        XCTAssertEqual(OpticalFlowShaders.mslFloat(1), "1.0")
        XCTAssertEqual(OpticalFlowShaders.mslFloat(100), "100.0")
        XCTAssertEqual(OpticalFlowShaders.mslFloat(0.004), "0.004")
        XCTAssertEqual(OpticalFlowShaders.mslFloat(1 / (2 * 0.2 * 0.2)), "12.499999999999998") // JavaScript's String() of it
        let passes = OpticalFlowShaders.passes()
        XCTAssertEqual(Set(passes.keys), Set(FlowPass.allCases))
        for (name, source) in passes { XCTAssertTrue(source.contains("kernel void \(name.kernelName)("), name.rawValue) }
        XCTAssertTrue(passes[.lucasKanade]!.contains("float a = h.x + 0.004;"))
        XCTAssertTrue(passes[.lucasKanade]!.contains("for (int j = -2; j <= 2; j += 1)"))
        XCTAssertTrue(passes[.fill]!.contains("for (int i = -6; i <= 6; i += 2)"))
        XCTAssertTrue(passes[.consistency]!.contains(": \(OpticalFlowShaders.mslFloat(OpticalFlow.OFF_FRAME));"))
        XCTAssertTrue(OpticalFlowShaders.interpolation().contains("for (int i = 0; i < 1; i++)"))
        let s = OpticalFlow.FLOW
        let other = FlowSettings(maxSide: s.maxSide, maxLevels: s.maxLevels, minSide: s.minSide, iterations: s.iterations,
                                 maxLumaTaps: s.maxLumaTaps, radius: 3, windowStep: s.windowStep, spatialSigma: s.spatialSigma,
                                 rangeSigma: s.rangeSigma, lambda: 0.01, maxStep: s.maxStep, median: s.median,
                                 consistencyAlpha: s.consistencyAlpha, consistencyBeta: s.consistencyBeta, occlusionLow: s.occlusionLow,
                                 occlusionHigh: s.occlusionHigh, badLow: s.badLow, badHigh: s.badHigh, residualLow: s.residualLow,
                                 residualHigh: s.residualHigh, fillRadius: s.fillRadius, fillStep: s.fillStep, supportLow: s.supportLow,
                                 supportHigh: s.supportHigh, trackIterations: s.trackIterations, missLow: s.missLow, missHigh: s.missHigh,
                                 hiddenWeight: s.hiddenWeight, motionLow: s.motionLow, motionHigh: s.motionHigh)
        let changed = OpticalFlowShaders.passes(other)[.lucasKanade]!
        XCTAssertTrue(changed.contains("float a = h.x + 0.01;"))
        XCTAssertTrue(changed.contains("for (int j = -3; j <= 3; j += 1)"))
        // And a whole estimator builds from it: every kernel compiles for other settings too.
        XCTAssertNotNil(FlowEstimator(settings: other))
    }

    /// The row-major ColorMatrix becomes the columns of the kernel's mat3.
    func testAGradeFromARowMajorMatrixIsStoredByColumns() {
        let grade = FlowGrade(rowMajor: [1, 2, 3, 4, 5, 6, 7, 8, 9], bias: [0.1, 0.2, 0.3])
        XCTAssertEqual(grade.matrix.columns.0, SIMD3(1, 4, 7))
        XCTAssertEqual(grade.matrix.columns.1, SIMD3(2, 5, 8))
        XCTAssertEqual(grade.matrix * SIMD3<Float>(1, 0, 0), SIMD3(1, 4, 7), "M * e_x is the first column: row r gets m[r*3]")
        XCTAssertEqual(FlowGrade(rowMajor: [1], bias: []), .identity)
    }
}
