import CoreVideo
import Foundation
import Metal
import os
import simd

/// The colour matrix the luma pass sees the frames through: `FlowGrade` in optical-flow-gl.ts. The web
/// hands its luma pass the post's colour matrix because the flow's thresholds are in luma and a graded
/// picture is what the eye - and the Android engine, whose frames arrive graded - compares; the frames
/// themselves are still mixed ungraded and graded after, as a recorded frame is.
struct FlowGrade: Equatable, Sendable {
    /// `M` of `clamp(M * rgb + offset, 0, 1)`, as simd stores it: by COLUMNS, like the GLSL mat3.
    var matrix: simd_float3x3
    var offset: SIMD3<Float>

    static let identity = FlowGrade(matrix: matrix_identity_float3x3, offset: .zero)

    init(matrix: simd_float3x3, offset: SIMD3<Float>) {
        self.matrix = matrix
        self.offset = offset
    }

    /// From a ROW-major 3x3 and its bias - `ColorMatrix.m` / `ColorMatrix.b`, `m[row * 3 + col]` - which
    /// is the transpose of how the matrix is stored: column `c` is `(m[c], m[3 + c], m[6 + c])`. Anything
    /// that is not nine and three numbers is the identity, rather than a crash in the middle of an export.
    init(rowMajor m: [Double], bias b: [Double]) {
        guard m.count == 9, b.count == 3 else {
            self = .identity
            return
        }
        matrix = simd_float3x3(columns: (
            SIMD3(Float(m[0]), Float(m[3]), Float(m[6])),
            SIMD3(Float(m[1]), Float(m[4]), Float(m[7])),
            SIMD3(Float(m[2]), Float(m[5]), Float(m[8]))))
        offset = SIMD3(Float(b[0]), Float(b[1]), Float(b[2]))
    }
}

/// `FlowUniforms` in the MSL (`OpticalFlowShaders.header`), byte for byte: every uniform any pass or the
/// synthesis reads, in one struct handed to each dispatch with `setBytes`. Swift lays a struct out in
/// declaration order at natural alignment, which for these members is MSL's layout too
/// (FlowEstimatorTests holds the offsets to the MSL struct's: 0, 8, 16, 20, 24, 28, 32, 40, 48, 96; 112).
struct PassUniforms {
    /// The target's size in texels. Set by `pass` for every pass, as optical-flow-gl.ts sets `u_size`.
    var u_size: SIMD2<Float> = .zero
    var u_sourceTexel: SIMD2<Float> = .zero
    var u_fresh: Float = 0
    var u_taps: Float = 1
    var u_flowOn: Float = 0
    var u_w: Float = 0
    var u_flowSize: SIMD2<Float> = .zero
    var u_unused: SIMD2<Float> = .zero
    /// The grade matrix's three COLUMNS (xyz; w unused), `mat3(c0, c1, c2)` in the kernel.
    var u_matrix: (SIMD4<Float>, SIMD4<Float>, SIMD4<Float>) = (SIMD4(1, 0, 0, 0), SIMD4(0, 1, 0, 0), SIMD4(0, 0, 1, 0))
    var u_offset: SIMD4<Float> = .zero

    init(sourceTexel: SIMD2<Float> = .zero, fresh: Float = 0, taps: Float = 1, grade: FlowGrade? = nil) {
        u_sourceTexel = sourceTexel
        u_fresh = fresh
        u_taps = taps
        if let grade {
            let c = grade.matrix.columns
            u_matrix = (SIMD4(c.0, 0), SIMD4(c.1, 0), SIMD4(c.2, 0))
            u_offset = SIMD4(grade.offset, 0)
        }
    }
}

/// A pair's answer: `FlowResult` in optical-flow-gl.ts. Both textures are rgba16Float at the working
/// size of the pair's frames, private to the GPU, and belong to the caller: they are ARC-owned and go
/// when it drops the object, which is what the web's `FlowEstimator.release(result)` does by hand.
final class FlowResult {
    /// Forward flow (A to B) in xy and backward flow (B to A) in zw, in texture coordinates (+y is down).
    let flow: MTLTexture
    /// How visible A's texel is in B (x), B's in A (y), and the pair's trust (z).
    let visibility: MTLTexture
    let width: Int
    let height: Int

    init(flow: MTLTexture, visibility: MTLTexture, width: Int, height: Int) {
        self.flow = flow
        self.visibility = visibility
        self.width = width
        self.height = height
    }
}

/// The iOS engine's half of optical-flow.ts, on Metal: `FlowEstimator` in optical-flow-gl.ts (and
/// `FlowInterpolator` in FlowInterpolator.kt), pass for pass. It decides only which texture each pass
/// reads and writes; what each pass does, and why, is optical-flow.ts, and the kernels are
/// OpticalFlowShaders.swift.
///
/// CONTRACT
///  - `estimate` works out one PAIR: all forty passes (at 720x1280) in ONE command buffer, waited on,
///    and hands back a `FlowResult` - or nil, and then the caller draws that pair as phase 1's
///    cross-fade. Nil is never an error the export sees: no Metal device, a kernel that will not
///    compile, a half-float texture that will not write, a texture that cannot be had, a CVPixelBuffer
///    the texture cache refuses, a command buffer that fails - each costs the pair its flow, never the
///    frame, and nothing here traps.
///  - `synthesize` draws one output frame from the pair into a caller's 32BGRA pixel buffer: the
///    interpolation kernel once per pixel, ONE command buffer, waited on, so Core Image can read the
///    buffer as soon as it returns. `flow == nil` or `flowOn == false` is the plain cross-fade
///    `mix(A, B, w)` - the kernel's `u_flowOn < 0.5` branch, which never reads the flow.
///  - Not thread-safe: one estimator belongs to one serial queue (the compositor's).
///
/// FRAMES arrive as 32BGRA IOSurface-backed CVPixelBuffers and become bgra8Unorm textures through ONE
/// CVMetalTextureCache - no copy. CoreVideo's header is explicit that a CVMetalTexture must be retained
/// for as long as the GPU uses its image, or the cache may recycle it under the kernel: each call keeps
/// every CVMetalTexture it made in the command buffer's completed handler, and flushes the cache after.
///
/// SCRATCH - the pyramids, gradients, the two flows every level bounces between, the round-trip test,
/// the exposure and the trust - is kept per frame size for up to `scratchSizes` sizes at once, least
/// recently used dropped first, as `SCRATCH_SIZES` on the web: a slowed clip allocates its textures
/// once, not per pair. At 720x1280 - or 1080x1920 or 4K: the working size is 180x320 whatever the
/// frame, five levels down to 12x20 - that is 23 rgba16Float textures, 3.30 MiB as Metal allocates them
/// on an M1 Pro, plus 0.94 MiB per live result (flow + visibility).
///
/// SAMPLING, ORIENTATION, PRECISION: see OpticalFlowShaders. Everything flow-side is rgba16Float with a
/// linear, clamp-to-edge sampler, which is what the GL engines' RGBA16F + LINEAR + CLAMP_TO_EDGE are.
final class FlowEstimator {

    /// How many frame sizes the scratch is kept for at once: `SCRATCH_SIZES` in optical-flow-gl.ts.
    static let scratchSizes = 2

    let device: MTLDevice
    let queue: MTLCommandQueue
    let settings: FlowSettings

    private let pipelines: [FlowPass: MTLComputePipelineState]
    private let interpolate: MTLComputePipelineState
    private let textureCache: CVMetalTextureCache
    /// What the synthesis binds for the flow when there is none, because a kernel argument must be bound
    /// to something: the `u_flowOn < 0.5` branch returns before it is read.
    private let noFlow: MTLTexture

    /// The scratch for one frame size: `Scratch` in optical-flow-gl.ts.
    final class Scratch {
        let width: Int
        let height: Int
        let sizes: [FlowSize]
        let pyramid: [MTLTexture]
        let gradient: [MTLTexture]
        /// Two per level: the flow being refined bounces between them.
        let flow: [(MTLTexture, MTLTexture)]
        let consistency: MTLTexture
        let exposure: MTLTexture
        let trust: MTLTexture

        init(width: Int, height: Int, sizes: [FlowSize], pyramid: [MTLTexture], gradient: [MTLTexture],
             flow: [(MTLTexture, MTLTexture)], consistency: MTLTexture, exposure: MTLTexture, trust: MTLTexture) {
            self.width = width
            self.height = height
            self.sizes = sizes
            self.pyramid = pyramid
            self.gradient = gradient
            self.flow = flow
            self.consistency = consistency
            self.exposure = exposure
            self.trust = trust
        }
    }

    /// By size, least recently used first; see `scratchSizes`.
    private(set) var scratches: [Scratch] = []

    /// The passes of the last `estimate`, in the order they were encoded. TESTS ONLY:
    /// `FlowEstimatorTests.testThePassesRunInTheWebEnginesOrder` holds it to optical-flow-gl.ts's order.
    /// The render never reads it; it costs one array append per pass.
    private(set) var passLog: [FlowPass] = []

    /// TESTS ONLY, never set by the render: one compute encoder per pass instead of one for the whole
    /// pair. The answer must be identical (`FlowEstimatorTests.testOneEncoderMatchesOneEncoderPerPass`),
    /// which is the proof that Metal's hazard tracking orders the dispatches of one serial encoder the way
    /// separate encoders are ordered.
    var encoderPerPass = false

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "OpticalFlow")
    /// Two flags, not one: the line that says the flow is ON is said once per process, and so is the
    /// first reason it could NOT be had - each on its own flag, so that an estimator that fails after
    /// another one has succeeded still says why its compositor's slowed frames are cross-faded. On one
    /// shared flag, whichever came first silenced the other for the life of the process.
    private static let announcedOn = OnceFlag()
    private static let unavailable = OnceFlag()
    private static let warned = OnceFlag()

    /// An estimator on `device` (the compositor's, shared with its CIContext), or nil where this device
    /// cannot run the flow. The first estimator that is made says so once per process, and the first
    /// that cannot be made says why, once per process, whatever came before it (`fellBack`). Compiling
    /// the eleven kernels is done once per process and device (see `pipeline`), so a second estimator
    /// costs only its textures.
    init?(device: MTLDevice? = MTLCreateSystemDefaultDevice(), queue: MTLCommandQueue? = nil,
          settings: FlowSettings = OpticalFlow.FLOW) {
        guard let device else {
            Self.fellBack("optical flow: no Metal device; slowed frames are cross-faded")
            return nil
        }
        guard let queue = queue ?? device.makeCommandQueue() else {
            Self.fellBack("optical flow: no command queue; slowed frames are cross-faded")
            return nil
        }
        var cache: CVMetalTextureCache?
        guard CVMetalTextureCacheCreate(kCFAllocatorDefault, nil, device, nil, &cache) == kCVReturnSuccess,
              let cache else {
            Self.fellBack("optical flow: no CVMetalTextureCache; slowed frames are cross-faded")
            return nil
        }
        // `pipeline` says why a kernel is missing, once per process; see there.
        var built: [FlowPass: MTLComputePipelineState] = [:]
        for (name, source) in OpticalFlowShaders.passes(settings) {
            guard let pipeline = Self.pipeline(device, source: source, function: name.kernelName) else { return nil }
            built[name] = pipeline
        }
        guard let interpolate = Self.pipeline(device, source: OpticalFlowShaders.interpolation(settings),
                                              function: OpticalFlowShaders.interpolateKernel) else { return nil }
        guard let noFlow = Self.halfFloatTexture(device, width: 1, height: 1) else {
            Self.fellBack("optical flow: no rgba16Float texture on this device; slowed frames are cross-faded")
            return nil
        }
        self.device = device
        self.queue = queue
        self.settings = settings
        self.pipelines = built
        self.interpolate = interpolate
        self.textureCache = cache
        self.noFlow = noFlow
        // A device can list rgba16Float as writable and still not round-trip what a kernel writes;
        // better to find out now, on one texel, than halfway through the first pair.
        guard probe() else {
            Self.fellBack("optical flow: rgba16Float kernel writes do not round-trip; slowed frames are cross-faded")
            return nil
        }
        if Self.announcedOn.setOnce() { Self.log.info("optical flow: on (\(device.name, privacy: .public))") }
    }

    // MARK: - A pair

    /// The flow between `frameA` and `frameB`, two 32BGRA pictures of one `width` x `height` frame, seen
    /// through `grade` (the post's colour matrix; the identity for none): every pass of optical-flow.ts,
    /// in order, in one command buffer. Nil when any of it could not be done; see the class comment.
    func estimate(frameA: CVPixelBuffer, frameB: CVPixelBuffer, width: Int, height: Int,
                  grade: FlowGrade = .identity) -> FlowResult? {
        guard CVPixelBufferGetWidth(frameA) == width, CVPixelBufferGetHeight(frameA) == height,
              CVPixelBufferGetWidth(frameB) == width, CVPixelBufferGetHeight(frameB) == height,
              let a = texture(frameA), let b = texture(frameB) else {
            Self.warn("optical flow: a frame is not a \(width)x\(height) IOSurface 32BGRA buffer; that pair is cross-faded")
            return nil
        }
        return estimate(frameA: a.texture, frameB: b.texture, grade: grade, keeping: [a.image, b.image])
    }

    /// The same for two frames that already are textures (bgra8Unorm or any other format a kernel samples
    /// as normalised RGB), of one size.
    func estimate(frameA: MTLTexture, frameB: MTLTexture, grade: FlowGrade = .identity) -> FlowResult? {
        estimate(frameA: frameA, frameB: frameB, grade: grade, keeping: [])
    }

    private func estimate(frameA: MTLTexture, frameB: MTLTexture, grade: FlowGrade,
                          keeping images: [CVMetalTexture]) -> FlowResult? {
        passLog.removeAll(keepingCapacity: true)
        let width = frameA.width, height = frameA.height
        guard frameB.width == width, frameB.height == height,
              let scratch = scratchFor(width: width, height: height),
              let result = newResult(scratch.sizes[0]),
              let commandBuffer = queue.makeCommandBuffer() else {
            Self.warn("optical flow: no half-float textures or command buffer at \(width)x\(height); that pair is cross-faded")
            return nil
        }
        commandBuffer.label = "optical flow: pair"
        let run = Run(commandBuffer: commandBuffer, perPass: encoderPerPass)
        encode(run, scratch: scratch, result: result, frameA: frameA, frameB: frameB, width: width, height: height, grade: grade)
        run.end()
        guard !run.failed else {
            Self.warn("optical flow: a pass could not be encoded; that pair is cross-faded")
            return nil
        }
        guard finish(commandBuffer, keeping: images) else { return nil }
        return result
    }

    /// Every pass, in optical-flow-gl.ts's order: `FlowEstimator.estimate` there, `run` in
    /// FlowInterpolator.kt. One `pass` call per statement, with the web's names, so the parity test can
    /// read the order off this text as it reads it off the Kotlin.
    private func encode(_ run: Run, scratch: Scratch, result: FlowResult, frameA: MTLTexture, frameB: MTLTexture,
                        width: Int, height: Int, grade: FlowGrade) {
        func pass(_ name: FlowPass, into target: MTLTexture, inputs: [MTLTexture], _ uniforms: PassUniforms = PassUniforms()) {
            self.pass(run, name, into: target, inputs: inputs, uniforms)
        }
        let levels = scratch.sizes.count

        pass(.luma, into: scratch.pyramid[0], inputs: [frameA, frameB], PassUniforms(taps: Float(OpticalFlow.lumaTaps(width: width, height: height, working: scratch.sizes[0], settings: settings)), grade: grade))
        for level in stride(from: 1, to: levels, by: 1) {
            let source = scratch.pyramid[level - 1]
            pass(.down, into: scratch.pyramid[level], inputs: [source], PassUniforms(sourceTexel: SIMD2(1 / Float(source.width), 1 / Float(source.height))))
        }
        pass(.exposure, into: scratch.exposure, inputs: [scratch.pyramid[levels - 1]])
        for level in 0..<levels { pass(.gradient, into: scratch.gradient[level], inputs: [scratch.pyramid[level]]) }

        // Coarse to fine. `estimate` is whichever texture holds the latest flow; at the start of a level it
        // is the coarser level's answer, which the first iteration reads through bilinear filtering. The
        // coarsest level's first iteration has none and is told so; its flow input is the exposure texel
        // only because a kernel argument must be bound to something that is not this pass's target.
        var estimate: MTLTexture?
        for level in stride(from: levels - 1, through: 0, by: -1) {
            let (ping, pong) = scratch.flow[level]
            let bounce = { (index: Int) -> MTLTexture in index % 2 == 0 ? ping : pong }
            let iterations = OpticalFlow.iterationsAt(level, settings: settings)
            for i in 0..<iterations {
                let target = bounce(i)
                pass(.lucasKanade, into: target, inputs: [scratch.pyramid[level], scratch.gradient[level], estimate ?? scratch.exposure, scratch.exposure], PassUniforms(fresh: estimate == nil ? 1 : 0))
                estimate = target
            }
            // `estimate!` rather than an `if let`, so the call reads as the web's and the Kotlin's do and the
            // parity test can compare it; the condition on the line above is what makes it safe.
            if settings.median, estimate != nil {
                let target = bounce(iterations)
                pass(.median, into: target, inputs: [estimate!])
                estimate = target
            }
        }

        // The round trip is tested on the flow as estimated, and the texels it fails are then filled in
        // from their neighbours into the answer; see the `fill` pass.
        let estimated = estimate ?? scratch.exposure
        pass(.consistency, into: scratch.consistency, inputs: [estimated, scratch.pyramid[0], scratch.exposure])
        pass(.fill, into: result.flow, inputs: [estimated, scratch.consistency, scratch.pyramid[0], scratch.exposure])
        pass(.trust, into: scratch.trust, inputs: [scratch.consistency])
        pass(.visibility, into: result.visibility, inputs: [scratch.consistency, scratch.trust])
    }

    /// Frees the scratch of every size, keeping the compiled kernels: the next `estimate` allocates its
    /// size's scratch again. Results already handed out stay valid until their owner drops them - a
    /// `FlowResult` is ARC-owned and needs no call to free it. `SlowMotionState` calls this when the last
    /// slowed clip of a render is done, so a long post with one early slowed clip does not hold the
    /// pyramid for the rest of the export.
    func dispose() {
        scratches.removeAll()
    }

    // MARK: - A frame

    /// One output frame at `weight` (0 is A, 1 is B) between `frameA` and `frameB`, drawn into `output`
    /// (32BGRA, any size - the pixel at (x, y) is the pair's picture at ((x, y) + 0.5) / size): the
    /// flow's picture where `flow` is given and `flowOn`, the cross-fade otherwise. False when it could not
    /// be drawn, and then `output` holds nothing to use and the caller draws phase 1's cross-fade itself.
    @discardableResult
    func synthesize(frameA: CVPixelBuffer, frameB: CVPixelBuffer, flow: FlowResult?, weight: Double,
                    into output: CVPixelBuffer, flowOn: Bool = true) -> Bool {
        guard let a = texture(frameA), let b = texture(frameB), let out = texture(output) else { return false }
        return synthesize(frameA: a.texture, frameB: b.texture, flow: flow, weight: weight, into: out.texture, flowOn: flowOn,
                          keeping: [a.image, b.image, out.image])
    }

    /// The same into a caller's texture: bgra8Unorm (or rgba8Unorm), made with `.shaderWrite`.
    @discardableResult
    func synthesize(frameA: MTLTexture, frameB: MTLTexture, flow: FlowResult?, weight: Double,
                    into output: MTLTexture, flowOn: Bool = true) -> Bool {
        synthesize(frameA: frameA, frameB: frameB, flow: flow, weight: weight, into: output, flowOn: flowOn,
                   keeping: [])
    }

    private func synthesize(frameA: MTLTexture, frameB: MTLTexture, flow: FlowResult?, weight: Double, into output: MTLTexture,
                            flowOn: Bool, keeping images: [CVMetalTexture]) -> Bool {
        guard output.usage.contains(.shaderWrite), output.pixelFormat == .bgra8Unorm || output.pixelFormat == .rgba8Unorm,
              let commandBuffer = queue.makeCommandBuffer(),
              let encoder = commandBuffer.makeComputeCommandEncoder() else { return false }
        commandBuffer.label = "optical flow: frame"
        var uniforms = PassUniforms()
        uniforms.u_size = SIMD2(Float(output.width), Float(output.height))
        uniforms.u_w = Float(weight)
        uniforms.u_flowOn = flow != nil && flowOn ? 1 : 0
        uniforms.u_flowSize = SIMD2(Float(flow?.width ?? 1), Float(flow?.height ?? 1))
        encoder.setComputePipelineState(interpolate)
        encoder.setTexture(frameA, index: 0)
        encoder.setTexture(frameB, index: 1)
        encoder.setTexture(flow?.flow ?? noFlow, index: 2)
        encoder.setTexture(flow?.visibility ?? noFlow, index: 3)
        encoder.setTexture(output, index: OpticalFlowShaders.targetIndex)
        encoder.setBytes(&uniforms, length: MemoryLayout<PassUniforms>.stride, index: 0)
        Self.dispatch(encoder, interpolate, over: output)
        encoder.endEncoding()
        return finish(commandBuffer, keeping: images)
    }

    // MARK: - Passes

    /// One pair's encoding: one compute encoder for every pass (or one per pass, see `encoderPerPass`),
    /// and whether anything along the way could not be had.
    private final class Run {
        let commandBuffer: MTLCommandBuffer
        let perPass: Bool
        private var shared: MTLComputeCommandEncoder?
        private(set) var failed = false

        init(commandBuffer: MTLCommandBuffer, perPass: Bool) {
            self.commandBuffer = commandBuffer
            self.perPass = perPass
        }

        func encoder() -> MTLComputeCommandEncoder? {
            if perPass { return commandBuffer.makeComputeCommandEncoder() }
            if shared == nil { shared = commandBuffer.makeComputeCommandEncoder() }
            return shared
        }

        func done(_ encoder: MTLComputeCommandEncoder) {
            if perPass { encoder.endEncoding() }
        }

        func fail() { failed = true }

        func end() {
            shared?.endEncoding()
            shared = nil
        }
    }

    /// One pass: `name` into `target`, reading `inputs` at texture indices 0, 1, ... in its sampler
    /// order, with `u_size` set to the target's size as optical-flow-gl.ts sets it.
    private func pass(_ run: Run, _ name: FlowPass, into target: MTLTexture, inputs: [MTLTexture], _ uniforms: PassUniforms) {
        passLog.append(name)
        guard let pipeline = pipelines[name], let encoder = run.encoder() else {
            run.fail()
            return
        }
        var uniforms = uniforms
        uniforms.u_size = SIMD2(Float(target.width), Float(target.height))
        encoder.setComputePipelineState(pipeline)
        // Every input slot is set, the unused ones to nil, so no texture of an earlier pass stays bound
        // where the hazard tracking would see a read that is not there.
        for index in 0..<4 { encoder.setTexture(index < inputs.count ? inputs[index] : nil, index: index) }
        encoder.setTexture(target, index: OpticalFlowShaders.targetIndex)
        encoder.setBytes(&uniforms, length: MemoryLayout<PassUniforms>.stride, index: 0)
        Self.dispatch(encoder, pipeline, over: target)
        run.done(encoder)
    }

    /// The whole target in whole threadgroups. `dispatchThreads` would size the edge groups to fit, but
    /// only on GPUs with non-uniform threadgroups (Apple4 and later); the iOS Simulator's device is an
    /// Apple2-like one, so the grid is rounded up here and each kernel skips the threads past its edge.
    private static func dispatch(_ encoder: MTLComputeCommandEncoder, _ pipeline: MTLComputePipelineState, over target: MTLTexture) {
        let width = max(1, pipeline.threadExecutionWidth)
        let height = max(1, min(8, pipeline.maxTotalThreadsPerThreadgroup / width))
        let groups = MTLSize(width: (target.width + width - 1) / width, height: (target.height + height - 1) / height, depth: 1)
        encoder.dispatchThreadgroups(groups, threadsPerThreadgroup: MTLSize(width: width, height: height, depth: 1))
    }

    /// Commits, waits, and says whether the GPU finished without an error. The CVMetalTextures are held
    /// by the completed handler, so the images they wrap cannot be recycled while a kernel reads them.
    private func finish(_ commandBuffer: MTLCommandBuffer, keeping images: [CVMetalTexture]) -> Bool {
        commandBuffer.addCompletedHandler { _ in withExtendedLifetime(images) {} }
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
        CVMetalTextureCacheFlush(textureCache, 0)
        guard commandBuffer.status == .completed, commandBuffer.error == nil else {
            Self.warn("optical flow: a command buffer failed (\(commandBuffer.error.map { "\($0)" } ?? "no error")); that pair is cross-faded")
            return false
        }
        return true
    }

    // MARK: - Textures

    /// `pixelBuffer` as a bgra8Unorm texture, through the cache (no copy), with the CVMetalTexture that
    /// keeps its image from being recycled. Nil for a buffer that is not IOSurface-backed 32BGRA.
    private func texture(_ pixelBuffer: CVPixelBuffer) -> (texture: MTLTexture, image: CVMetalTexture)? {
        guard CVPixelBufferGetPixelFormatType(pixelBuffer) == kCVPixelFormatType_32BGRA else { return nil }
        // Read and write: the same call makes the synthesis's output texture.
        let attributes = [kCVMetalTextureUsage: MTLTextureUsage([.shaderRead, .shaderWrite]).rawValue] as CFDictionary
        var image: CVMetalTexture?
        guard CVMetalTextureCacheCreateTextureFromImage(kCFAllocatorDefault, textureCache, pixelBuffer, attributes, .bgra8Unorm,
                                                        CVPixelBufferGetWidth(pixelBuffer), CVPixelBufferGetHeight(pixelBuffer),
                                                        0, &image) == kCVReturnSuccess,
              let image, let texture = CVMetalTextureGetTexture(image) else { return nil }
        return (texture, image)
    }

    private func scratchFor(width: Int, height: Int) -> Scratch? {
        if let index = scratches.firstIndex(where: { $0.width == width && $0.height == height }) {
            let kept = scratches.remove(at: index)
            scratches.append(kept)
            return kept
        }
        while scratches.count >= Self.scratchSizes { scratches.removeFirst() }
        let sizes = OpticalFlow.pyramid(width: width, height: height, settings: settings)
        guard !sizes.isEmpty else { return nil }
        func make(_ size: FlowSize) -> MTLTexture? { Self.halfFloatTexture(device, width: size.width, height: size.height) }
        let pyramid = sizes.compactMap(make)
        let gradient = sizes.compactMap(make)
        let flow: [(MTLTexture, MTLTexture)] = sizes.compactMap { size in
            guard let ping = make(size), let pong = make(size) else { return nil }
            return (ping, pong)
        }
        guard pyramid.count == sizes.count, gradient.count == sizes.count, flow.count == sizes.count,
              let consistency = make(sizes[0]),
              let exposure = make(FlowSize(width: 1, height: 1)),
              let trust = make(FlowSize(width: 1, height: 1)) else {
            Self.warn("optical flow: no half-float textures at \(width)x\(height); slowed frames are cross-faded")
            return nil
        }
        let scratch = Scratch(width: width, height: height, sizes: sizes, pyramid: pyramid, gradient: gradient, flow: flow,
                              consistency: consistency, exposure: exposure, trust: trust)
        scratches.append(scratch)
        return scratch
    }

    private func newResult(_ size: FlowSize) -> FlowResult? {
        guard let flow = Self.halfFloatTexture(device, width: size.width, height: size.height),
              let visibility = Self.halfFloatTexture(device, width: size.width, height: size.height) else { return nil }
        return FlowResult(flow: flow, visibility: visibility, width: size.width, height: size.height)
    }

    /// An rgba16Float texture the passes can read (bilinear) and write, private to the GPU: half floats
    /// hold the flow's sign and its sub-texel fraction, which eight bits cannot, and are what the GL
    /// engines' RGBA16F targets hold.
    static func halfFloatTexture(_ device: MTLDevice, width: Int, height: Int) -> MTLTexture? {
        let descriptor = MTLTextureDescriptor.texture2DDescriptor(pixelFormat: .rgba16Float, width: width, height: height, mipmapped: false)
        descriptor.usage = [.shaderRead, .shaderWrite]
        descriptor.storageMode = .private
        return device.makeTexture(descriptor: descriptor)
    }

    // MARK: - Reading back (tests only)

    /// Every texel of an rgba16Float texture as floats, rgba, row by row from the top; nil on any failure.
    /// TESTS ONLY (`FlowEstimatorTests` reads flows, visibilities, lumas and the trust texel with it); the
    /// render never reads a texture back.
    func readHalfFloats(_ texture: MTLTexture) -> [Float]? {
        guard texture.pixelFormat == .rgba16Float else { return nil }
        let bytesPerRow = texture.width * 8
        guard let buffer = device.makeBuffer(length: bytesPerRow * texture.height, options: .storageModeShared),
              let commandBuffer = queue.makeCommandBuffer(), let blit = commandBuffer.makeBlitCommandEncoder() else { return nil }
        blit.copy(from: texture, sourceSlice: 0, sourceLevel: 0, sourceOrigin: MTLOrigin(x: 0, y: 0, z: 0),
                  sourceSize: MTLSize(width: texture.width, height: texture.height, depth: 1),
                  to: buffer, destinationOffset: 0, destinationBytesPerRow: bytesPerRow, destinationBytesPerImage: bytesPerRow * texture.height)
        blit.endEncoding()
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
        guard commandBuffer.status == .completed else { return nil }
        let halves = buffer.contents().bindMemory(to: UInt16.self, capacity: texture.width * texture.height * 4)
        return (0..<(texture.width * texture.height * 4)).map { Self.float(fromHalf: halves[$0]) }
    }

    /// IEEE 754 binary16 to Float, written out because `Float16` is not available on every Mac this builds on.
    static func float(fromHalf bits: UInt16) -> Float {
        let sign: Float = bits & 0x8000 != 0 ? -1 : 1
        let exponent = Int((bits >> 10) & 0x1f)
        let fraction = Float(bits & 0x3ff)
        switch exponent {
        case 0: return sign * fraction * powf(2, -24)
        case 31: return fraction == 0 ? sign * .infinity : .nan
        default: return sign * (1 + fraction / 1024) * powf(2, Float(exponent - 15))
        }
    }

    // MARK: - Compiling

    /// How every kernel is compiled: FAST MATH OFF. With it on (Metal's default), the compiler may assume
    /// no NaN or infinity ever appears, divide as if no divisor were zero, reassociate sums and use the
    /// fast (lower-precision) exp - and the flow's maths leans on exactly those: `exp` of large negative
    /// window weights, `max(det, 1e-12)` guarding a near-singular solve, `smoothstep`s whose inputs can be
    /// OFF_FRAME, sums over 25 and 49 taps whose order sets the last bits the median then compares. The
    /// GL engines give no fast-math licence to their compilers, and the numbers are held to theirs.
    /// `mathMode = .safe` where it exists (iOS 18, macOS 15), `fastMathEnabled = false` before that.
    static func compileOptions() -> MTLCompileOptions {
        let options = MTLCompileOptions()
        if #available(iOS 18.0, macOS 15.0, *) {
            options.mathMode = .safe
        } else {
            options.fastMathEnabled = false
        }
        return options
    }

    private static let pipelineLock = NSLock()
    private static var pipelineCache: [String: MTLComputePipelineState] = [:]

    /// `function` of `source`, compiled for `device` once per process: the MSL is compiled at run time
    /// (`makeLibrary(source:)`), which needs no metallib build step in a SwiftPM package, and costs its
    /// compile once rather than per estimator. Nil, logged once, when it will not compile.
    static func pipeline(_ device: MTLDevice, source: String, function: String) -> MTLComputePipelineState? {
        let key = "\(device.registryID)/\(function)/\(source)"
        pipelineLock.lock()
        defer { pipelineLock.unlock() }
        if let kept = pipelineCache[key] { return kept }
        do {
            let library = try device.makeLibrary(source: source, options: compileOptions())
            guard let kernel = library.makeFunction(name: function) else {
                fellBack("optical flow: no kernel \(function); slowed frames are cross-faded")
                return nil
            }
            let pipeline = try device.makeComputePipelineState(function: kernel)
            pipelineCache[key] = pipeline
            return pipeline
        } catch {
            fellBack("optical flow: \(function) did not compile (\(error)); slowed frames are cross-faded")
            return nil
        }
    }

    /// Writes a known texel with the probe kernel and reads it back; see `OpticalFlowShaders.probe`.
    private func probe() -> Bool {
        guard let pipeline = Self.pipeline(device, source: OpticalFlowShaders.probe, function: OpticalFlowShaders.probeKernel),
              let target = Self.halfFloatTexture(device, width: 1, height: 1),
              let commandBuffer = queue.makeCommandBuffer(), let encoder = commandBuffer.makeComputeCommandEncoder() else { return false }
        var uniforms = PassUniforms()
        uniforms.u_size = SIMD2(1, 1)
        encoder.setComputePipelineState(pipeline)
        encoder.setTexture(target, index: OpticalFlowShaders.targetIndex)
        encoder.setBytes(&uniforms, length: MemoryLayout<PassUniforms>.stride, index: 0)
        Self.dispatch(encoder, pipeline, over: target)
        encoder.endEncoding()
        commandBuffer.commit()
        commandBuffer.waitUntilCompleted()
        guard commandBuffer.status == .completed, let texel = readHalfFloats(target) else { return false }
        return texel == [0.25, -0.5, 1.5, 1.0]
    }

    /// Why an estimator could not be made - no device, queue, texture cache, kernel or half-float
    /// target - and so why a compositor's slowed frames are cross-faded: the FIRST such reason in the
    /// process, as an error, as `warn` says a pair's. On its own flag, so it is said even when an earlier
    /// estimator was made and said the flow was on (`announcedOn`).
    private static func fellBack(_ message: String) {
        guard unavailable.setOnce() else { return }
        log.error("\(message, privacy: .public)")
    }

    /// The first pair that fell back to the cross-fade, and why: said once per process, not once per pair.
    private static func warn(_ message: String) {
        guard warned.setOnce() else { return }
        log.error("\(message, privacy: .public)")
    }
}

/// A flag that is set once, from any thread: what makes a log line say something once per process
/// rather than once per frame. The optical flow's and the slow-motion frame source's fallbacks use it.
final class OnceFlag: @unchecked Sendable {
    private let lock = NSLock()
    private var set = false

    /// True the first time only.
    func setOnce() -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if set { return false }
        set = true
        return true
    }
}
