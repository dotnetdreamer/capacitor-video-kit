@preconcurrency import AVFoundation
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import Metal
import os

/// The compositor's mutable side of slow motion: everything a slowed clip needs from one frame to the next that
/// cannot travel on the instruction, because AVFoundation builds `EditCompositor` with a bare `init()` and the
/// instructions are immutable.
///
/// Per `SlowClip` in use (keyed by its identity, see `SlowClip`):
///  - a `ClipFrameDecoder`, which reads the clip's own frames forward and holds the two it read last - the
///    current pair's A and B;
///  - the current pair's optical flow, keyed by A's index: estimated once, on the pair's first output frame that
///    needs it, reused by every frame drawn between A and B, and replaced when A moves on. A nil flow is a pair
///    the GPU could not estimate, remembered so that it is not tried again frame after frame.
/// Shared by every clip:
///  - the `FlowEstimator`, made the first time a flow is actually needed - mode `.flow`, a weight above zero and
///    a B to move towards - so a post with no slowed clip, or one rendered `.blend`, never compiles a kernel;
///  - one `CVPixelBufferPool` per frame size for the pictures the flow synthesises: 32BGRA, IOSurface-backed and
///    Metal-compatible, so the synthesis writes into them through the texture cache and Core Image reads them
///    as it reads a source frame.
///
/// CONFINED TO THE COMPOSITOR'S SERIAL QUEUE, and not thread-safe: `AVAssetReader` is `NS_SWIFT_NONSENDABLE`,
/// Metal command encoding is single-threaded here, and every call arrives from `EditCompositor.render`. Nothing
/// outlives a render but the decoders, the flows and the pools: Core Image's render into the output buffer is
/// complete when it returns (measured), so a pooled buffer drawn into a frame is free again by the next one.
///
/// FAILURES NEVER REACH THE EXPORT. A decoder that throws marks its clip failed for the rest of the job, and
/// every frame of it from then on is `request.sourceFrame` - the frame the engine drew before slow motion was
/// synthesised. A pair the flow cannot estimate, or a synthesis that fails, is drawn as the cross-fade. Each is
/// said once per process.
final class SlowMotionState {
    private let device: MTLDevice?

    /// The live clips, by identity, each with its decoder and the current pair's flow. The `SlowClip` itself is
    /// held so that its identity cannot be reused while the entry exists.
    private struct Live {
        let clip: SlowClip
        let decoder: ClipFrameDecoder
        /// A's index and the pair's flow; nil flow is a pair that could not be estimated.
        var flow: (a: Int, result: FlowResult?)?
    }
    private var live: [ObjectIdentifier: Live] = [:]

    /// Clips whose frames could not be read, held for the same reason. Never retried in this job: a clip that
    /// changes between its own frames and the composition's partway through would flicker between two decodes.
    private var failed: [ObjectIdentifier: SlowClip] = [:]

    private var estimator: FlowEstimator?
    /// Whether making `estimator` has been tried; a device that cannot run the flow is asked once.
    private var estimatorTried = false

    private struct Size: Hashable { let width: Int; let height: Int }
    private var pools: [Size: CVPixelBufferPool] = [:]

    /// How many pair flows this state has asked the estimator for, and how many clips and pools it holds right
    /// now. TESTS ONLY (`SlowMotionTests` holds a pair's flow to one estimate however many frames draw it, and
    /// `keep` to releasing what the clip held); nothing on the render path reads them.
    private(set) var estimates = 0
    var liveCount: Int { live.count }
    var poolCount: Int { pools.count }

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "SlowMotion")
    private static let decoderWarned = OnceFlag()
    private static let poolWarned = OnceFlag()

    /// `device` is the compositor's, the one its CIContext renders on, so the flow's textures and Core Image's
    /// live on one GPU device.
    init(device: MTLDevice?) {
        self.device = device
    }

    /// Releases the decoder and the flow of every clip not in `named`: called at the top of every render with the
    /// clips that frame's instruction names. A clip's instructions are contiguous on the output timeline, so a
    /// clip the current one does not name is finished, and holding its decoder would hold two decoded frames and
    /// a reader for nothing. When no clip is left the flow's pools go too, and so does the estimator's scratch
    /// (`FlowEstimator.dispose`), while the estimator itself and its compiled kernels stay for the next slowed
    /// clip of the render: a long post with one early slowed clip holds none of it for the rest of the export.
    func keep(only named: Set<ObjectIdentifier>) {
        // The common frame - no slowed clip live, none named - costs this one test.
        if live.isEmpty && pools.isEmpty { return }
        for id in live.keys where !named.contains(id) { live[id] = nil }
        if live.isEmpty {
            pools.removeAll()
            estimator?.dispose()
        }
    }

    /// The source picture of `clip` at composition time `t`, as a CIImage made the way the compositor makes one
    /// from a source frame (no colour space: management is off): A alone where the weight is 0 or there is no B,
    /// otherwise the cross-fade (`.blend`) or the flow's picture (`.flow`, the cross-fade where the flow fails).
    ///
    /// nil means "draw today's frame": the clip failed, now or earlier in the job. Never throws.
    func picture(of clip: SlowClip, at t: CMTime, mode: SlowMotionMode, grade: FlowGrade,
                 faults: SlowMotionTestFaults) -> CIImage? {
        let id = ObjectIdentifier(clip)
        if failed[id] != nil || mode == .off { return nil }

        let pair: FramePair
        let frameA: CVPixelBuffer
        var frameB: CVPixelBuffer?
        do {
            guard let found = clip.pair(at: t) else { throw ClipFrameError.noFrames }
            pair = found
            var entry: Live
            if let hit = live[id] {
                entry = hit
            } else {
                if faults.failsDecoders { throw ClipFrameError.readerFailed(underlying: nil) }
                entry = Live(clip: clip, decoder: clip.decoder(), flow: nil)
            }
            // Every picture of a slowed clip comes from its own decoder, A alone included, so a clip never mixes
            // its decoder's pictures with the composition's.
            frameA = try entry.decoder.frame(pair.a)
            if let b = pair.b, pair.weight > 0 { frameB = try entry.decoder.frame(b) }
            // A flow is only ever for the pair it was estimated on.
            if let kept = entry.flow, kept.a != pair.a { entry.flow = nil }
            live[id] = entry
        } catch {
            live[id] = nil
            failed[id] = clip
            if Self.decoderWarned.setOnce() {
                Self.log.error("slow motion: a slowed clip's own frames could not be read, it is drawn from the composition's for the rest of the render: \(String(describing: error), privacy: .public)")
            }
            return nil
        }

        let a = CIImage(cvPixelBuffer: frameA, options: [.colorSpace: NSNull()])
        guard let frameB else { return a }
        if mode == .flow, let flowed = flowPicture(id, pair: pair, frameA: frameA, frameB: frameB, grade: grade,
                                                   faults: faults) {
            return flowed
        }
        return FrameBlend.mix(a, CIImage(cvPixelBuffer: frameB, options: [.colorSpace: NSNull()]), weight: pair.weight)
    }

    /// The flow's picture for `pair`, or nil to draw the cross-fade instead: no estimator on this device, a pair
    /// the GPU could not estimate, no buffer to draw into, or a synthesis that failed.
    private func flowPicture(_ id: ObjectIdentifier, pair: FramePair, frameA: CVPixelBuffer, frameB: CVPixelBuffer,
                             grade: FlowGrade, faults: SlowMotionTestFaults) -> CIImage? {
        guard let estimator = flowEstimator() else { return nil }
        let width = CVPixelBufferGetWidth(frameA), height = CVPixelBufferGetHeight(frameA)
        let flow: FlowResult?
        if let kept = live[id]?.flow, kept.a == pair.a {
            flow = kept.result
        } else {
            // The pair's first frame that needs it. The estimate commits one command buffer and waits for it,
            // so a GPU error costs this pair its flow (nil) rather than drawing garbage.
            estimates += 1
            faults.saw(grade)
            flow = faults.failsFlows ? nil
                : estimator.estimate(frameA: frameA, frameB: frameB, width: width, height: height, grade: grade)
            live[id]?.flow = (a: pair.a, result: flow)
        }
        guard let flow, let out = pooledBuffer(width: width, height: height),
              estimator.synthesize(frameA: frameA, frameB: frameB, flow: flow, weight: pair.weight, into: out)
        else { return nil }
        // `synthesize` has waited for its command buffer, so the pixels are in `out` before Core Image, on its
        // own command queue, ever reads it.
        return CIImage(cvPixelBuffer: out, options: [.colorSpace: NSNull()])
    }

    private func flowEstimator() -> FlowEstimator? {
        if !estimatorTried {
            estimatorTried = true
            // Logs by itself, once per process, when this device cannot run the flow - no device included,
            // which is why the optional goes in as it is.
            estimator = FlowEstimator(device: device)
        }
        return estimator
    }

    /// A free buffer of the pool for this size, made on first use.
    private func pooledBuffer(width: Int, height: Int) -> CVPixelBuffer? {
        let size = Size(width: width, height: height)
        if pools[size] == nil {
            let attributes: [String: Any] = [
                kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
                kCVPixelBufferWidthKey as String: width,
                kCVPixelBufferHeightKey as String: height,
                kCVPixelBufferMetalCompatibilityKey as String: true,
                kCVPixelBufferIOSurfacePropertiesKey as String: [String: Any](),
            ]
            var pool: CVPixelBufferPool?
            CVPixelBufferPoolCreate(kCFAllocatorDefault, nil, attributes as CFDictionary, &pool)
            pools[size] = pool
        }
        var buffer: CVPixelBuffer?
        guard let pool = pools[size],
              CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer) == kCVReturnSuccess else {
            if Self.poolWarned.setOnce() {
                Self.log.error("slow motion: no \(width)x\(height) buffer for a synthesised frame; it is cross-faded")
            }
            return nil
        }
        return buffer
    }
}

/// TESTS ONLY: failures the tests cannot otherwise make happen on demand, set on a built composition's plan
/// before it is rendered, and the one thing the render cannot show them in its pixels. The render never sets
/// either switch; both are false on every plan the app builds.
///
/// A decoder that fails and a GPU that cannot estimate a pair are the two fallbacks the contract promises - the
/// export succeeds and the frames are today's, or the cross-fade - and neither can be provoked through AVFoundation
/// or Metal in a test without breaking the composition's own reading of the same file along with it. So this is
/// the one narrow hook: per job (it hangs off the `RenderPlan`), never global, read on the compositor's queue.
final class SlowMotionTestFaults: @unchecked Sendable {
    private let lock = NSLock()
    private var decoders = false
    private var flows = false
    private var grade: FlowGrade?

    /// The grade the last pair's flow was asked to estimate through (`RenderPlan.flowGrade` as it reached the
    /// estimator), or nil before any was. A grade changes which pairs the flow trusts, never a pixel the tests can
    /// tell from an ungraded estimate on their own, so this is how a test sees that the post's grade got there.
    var lastGrade: FlowGrade? {
        lock.lock(); defer { lock.unlock() }; return grade
    }

    /// Recorded by `SlowMotionState` as it asks for each pair's flow; see `lastGrade`.
    func saw(_ grade: FlowGrade) {
        lock.lock(); self.grade = grade; lock.unlock()
    }

    /// Every slowed clip's decoder fails as it is made.
    var failsDecoders: Bool {
        get { lock.lock(); defer { lock.unlock() }; return decoders }
        set { lock.lock(); decoders = newValue; lock.unlock() }
    }

    /// Every pair's flow estimate fails.
    var failsFlows: Bool {
        get { lock.lock(); defer { lock.unlock() }; return flows }
        set { lock.lock(); flows = newValue; lock.unlock() }
    }
}
