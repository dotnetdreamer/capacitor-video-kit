@preconcurrency import AVFoundation
import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import Metal

/// Everything the compositor needs that is the same for every frame of the job.
///
/// AVFoundation instantiates a custom compositor by calling a bare `init()`, so there is no way to
/// hand it anything: whatever it needs travels on the instruction, and whatever is shared travels on
/// one plan that every instruction references. Immutable after init, which is what makes the
/// `@unchecked Sendable` honest.
final class RenderPlan: @unchecked Sendable {
    let renderSize: CGSize
    let colorMatrix: ColorMatrix
    let overlays: [PlacedOverlay]

    /// Decodes every overlay ONCE, here, on the thread that builds the composition. Decoding inside
    /// the compositor would put a PNG decode on the render path thirty times a second.
    /// Throws `BuildError.invalidOverlay` when a PNG will not decode.
    init(spec: ComposeSpec) throws {
        let size = CGSize(width: spec.output.width, height: spec.output.height)
        renderSize = size
        colorMatrix = ColorMatrix.fold(spec.filter)
        // compactMap, because a fully transparent overlay decodes to nil rather than to an
        // invisible image the compositor would blend for nothing.
        overlays = try spec.overlays.compactMap { try OverlayBitmap.decode($0, render: size) }
    }
}

/// One instruction per clip, covering that clip's range of the OUTPUT timeline.
///
/// `AVMutableVideoCompositionLayerInstruction` plays no part in this engine. The moment
/// `customVideoCompositorClass` is set, AVFoundation hands this object and the raw source frames to
/// our compositor and reads no layer instruction at all, so orientation, fit, colour and overlays
/// all happen in `EditCompositor.render`. That is the single biggest structural difference from the
/// usual AVFoundation tutorial.
final class EditInstruction: NSObject, AVVideoCompositionInstructionProtocol, @unchecked Sendable {
    let timeRange: CMTimeRange
    let enablePostProcessing: Bool = false

    /// MUST be true. It tells the engine the output changes WITHIN the instruction, so the
    /// compositor is asked for every frame. With false, one composed frame can be reused for the
    /// whole clip and an overlay that appears mid-clip would never show up. Nothing here actually
    /// tweens; that is the only reason the flag is set.
    let containsTweening: Bool = true

    let requiredSourceTrackIDs: [NSValue]?

    /// Must stay invalid. A valid value tells the engine to pass the source frame straight through
    /// and bypass the compositor entirely: no colour, no overlays, no fit.
    let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid

    let trackID: CMPersistentTrackID
    let orientation: CGImagePropertyOrientation
    let fit: Fit
    let plan: RenderPlan

    init(timeRange: CMTimeRange, trackID: CMPersistentTrackID,
         orientation: CGImagePropertyOrientation, fit: Fit, plan: RenderPlan) {
        self.timeRange = timeRange
        self.trackID = trackID
        self.requiredSourceTrackIDs = [NSNumber(value: trackID)]
        self.orientation = orientation
        self.fit = fit
        self.plan = plan
        super.init()
    }
}

enum CompositorError: Error { case badInstruction, noBuffer }

/// The custom `AVVideoCompositing` that draws every output frame.
///
/// Safe to instantiate more than once per process: the exporter's one relaxed-preset retry builds a
/// fresh `AVAssetExportSession`, which builds a fresh compositor.
final class EditCompositor: NSObject, AVVideoCompositing, @unchecked Sendable {

    // Both dictionaries must carry a pixel format or AVFoundation raises an ObjC exception. 32BGRA
    // is what Core Image renders into without a conversion, and the Metal flag keeps the buffers
    // usable by the GPU-backed CIContext below.
    var sourcePixelBufferAttributes: [String: any Sendable]? = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferMetalCompatibilityKey as String: true,
    ]

    var requiredPixelBufferAttributesForRenderContext: [String: any Sendable] = [
        kCVPixelBufferPixelFormatTypeKey as String: Int(kCVPixelFormatType_32BGRA),
        kCVPixelBufferMetalCompatibilityKey as String: true,
    ]

    // Left at false on purpose. The framework then tone maps HLG and PQ gallery picks down to
    // BT.709 SDR before we ever see them, which is the iOS analogue of Android's
    // HDR_MODE_TONE_MAP_HDR_TO_SDR: an HDR source renders slightly flat instead of failing.
    var supportsHDRSourceFrames: Bool { false }
    var supportsWideColorSourceFrames: Bool { false }

    /// AVFoundation is explicitly allowed to call `startRequest` again before the previous request
    /// has finished, so every frame is rendered on this one serial queue.
    private let queue = DispatchQueue(label: "net.dotnetdreamer.choisy.videokit.compositor",
                                      qos: .userInitiated)

    /// Guards `cancelled` alone. It is read on `queue` and written by whatever thread AVFoundation
    /// calls `cancelAllPendingVideoCompositionRequests` on, which is never `queue`.
    private let lock = NSLock()
    private var cancelled = false

    /// ONE context for the life of the compositor. Building a `CIContext` per frame is the classic
    /// way to make this forty times slower than it needs to be and to leak tens of megabytes a
    /// minute of shader and texture cache.
    ///
    /// Colour management is OFF, all the way through, and this is the single most important line in
    /// the colour path. Core Image's default working space is extended sRGB with LINEAR gamma, while
    /// the CSS maths, Chromium's `ctx.filter` and Android's shader all operate on the gamma-encoded
    /// values. Measured on this SDK against the browser's answer, over eight presets and six
    /// patches: the default context misses by 26+ code values, an sRGB working space by up to 8, and
    /// management off by at most 1. The harness tolerance is 6.
    ///
    /// The identity case renders perfectly under all three, so `filter: []` proves nothing here;
    /// `crisp` on rgb(30,30,30) is the cheapest check that bites (expected 20, linear gives 0).
    private let ci: CIContext = {
        let options: [CIContextOption: Any] = [
            .workingColorSpace: NSNull(),   // no linearisation and no matching on the way in
            .outputColorSpace: NSNull(),    // none on the way out either
            .cacheIntermediates: false,     // 30 overlays x 30 fps otherwise pins a lot of textures
            .name: "ChoisyEditCompositor",
        ]
        // Every device and simulator this ships to has Metal; the CPU context is a last resort that
        // renders correctly and slowly rather than a crash on some future configuration.
        if let device = MTLCreateSystemDefaultDevice() {
            return CIContext(mtlDevice: device, options: options)
        }
        return CIContext(options: options)
    }()

    /// Required by the protocol, and deliberately empty: `render` reads `request.renderContext`
    /// straight off the request that carried it, which needs no stored state and cannot go stale.
    func renderContextChanged(_ newRenderContext: AVVideoCompositionRenderContext) {}

    func startRequest(_ request: AVAsynchronousVideoCompositionRequest) {
        queue.async {
            // Each frame allocates a pixel buffer and a filter graph. Without the pool the peak
            // footprint of a long export is set by how fast the autorelease pool at the top of the
            // thread happens to drain.
            autoreleasepool {
                self.lock.lock()
                let stop = self.cancelled
                self.lock.unlock()
                if stop { request.finishCancelledRequest(); return }
                do {
                    request.finish(withComposedVideoFrame: try self.render(request))
                } catch {
                    request.finish(with: error)
                }
            }
        }
    }

    /// Sets the flag, then blocks until the queue has drained so that every request already in
    /// flight is answered before this returns. The flag is cleared afterwards because AVFoundation
    /// reuses the compositor after a cancellation (a seek, for instance); leaving it set would
    /// cancel every remaining frame of the export.
    func cancelAllPendingVideoCompositionRequests() {
        lock.lock(); cancelled = true; lock.unlock()
        queue.sync {}
        lock.lock(); cancelled = false; lock.unlock()
    }

    private func render(_ request: AVAsynchronousVideoCompositionRequest) throws -> CVPixelBuffer {
        guard let instr = request.videoCompositionInstruction as? EditInstruction else {
            throw CompositorError.badInstruction
        }
        let ctx = request.renderContext
        guard let dst = ctx.newPixelBuffer() else { throw CompositorError.noBuffer }
        let rect = CGRect(origin: .zero, size: ctx.size)

        var image: CIImage
        if let src = request.sourceFrame(byTrackID: instr.trackID) {
            var pic = CIImage(cvPixelBuffer: src, options: [.colorSpace: NSNull()])
                .oriented(instr.orientation)
            // The colour goes on the PICTURE, before the letterbox bars exist. Applied to the
            // finished frame instead, any op with a non-zero bias paints the bars: `golden` carries
            // b = [0.1595, 0.1108, 0.0261], which gives rgb(41, 28, 7) bars, and a fade gives grey
            // ones. `contain` is the default fit, so that is the common case and not an edge case.
            // A colour matrix commutes with the scale and translate in `place`, so moving it earlier
            // leaves the picture itself identical.
            pic = instr.plan.colorMatrix.apply(to: pic)
            image = Placement.place(pic, into: rect, fit: instr.fit)
        } else {
            // A gap the timeline maths should never produce, drawn black rather than thrown.
            image = CIImage(color: .black).cropped(to: rect)
        }

        // Microseconds, matching Android's `presentationTimeUs in startUs until endUs` exactly.
        // `compositionTime` is OUTPUT-timeline time, which is what the overlay windows are in.
        let tUs = CMTimeConvertScale(request.compositionTime,
                                     timescale: 1_000_000, method: .roundTowardZero).value
        for ov in instr.plan.overlays where ov.startUs <= tUs && tUs < ov.endUs {
            image = ov.image.composited(over: image)   // spec order is drawing order, later on top
        }

        // The four-argument render with `colorSpace: nil`, never `render(_:toCVPixelBuffer:)`: the
        // two-argument form matches to the BUFFER's colour space, and the render context tags its
        // buffers 709, which would undo everything the unmanaged context just bought.
        ci.render(image, to: dst, bounds: rect, colorSpace: nil)
        return dst
    }
}

enum Orientation {

    /// The source's `preferredTransform` maps stored pixels into display space in a y-DOWN frame, so
    /// its linear part is exactly one of the eight EXIF orientation matrices and a table on the
    /// signs is exact for all eight. Deriving it from `atan2(b, a)` plus a determinant test, which
    /// the design doc does, gets all four MIRRORED rows wrong in pairs.
    ///
    /// `CIImage.oriented(_:)` wants the orientation that DESCRIBES the stored data and returns the
    /// upright image, which is the y-convention-safe route. Never apply `preferredTransform` to a
    /// `CIImage` directly: it is y-down and Core Image is y-up, so the picture comes out flipped.
    static func imageOrientation(_ t: CGAffineTransform) -> CGImagePropertyOrientation {
        func sgn(_ v: CGFloat) -> Int { v > 0.001 ? 1 : (v < -0.001 ? -1 : 0) }
        switch (sgn(t.a), sgn(t.b), sgn(t.c), sgn(t.d)) {
        case (1, 0, 0, 1):    return .up
        case (-1, 0, 0, 1):   return .upMirrored
        case (-1, 0, 0, -1):  return .down
        case (1, 0, 0, -1):   return .downMirrored
        case (0, 1, 1, 0):    return .leftMirrored
        case (0, 1, -1, 0):   return .right          // 90 CW, the iPhone portrait case
        case (0, -1, -1, 0):  return .rightMirrored
        case (0, -1, 1, 0):   return .left
        default:              return .up             // scaled or skewed: ignore it, do not guess
        }
    }
}

enum Placement {

    /// `frame` is already oriented. Returns an image whose extent is exactly `render`, on black.
    ///
    /// `contain` is `min(sx, sy)`, Android's `LAYOUT_SCALE_TO_FIT`; `cover` is `max(sx, sy)`, its
    /// `LAYOUT_SCALE_TO_FIT_WITH_CROP`. Everything reads `frame.extent` and never the track's
    /// `naturalSize`, which is what makes one video track carrying clips of mixed resolutions safe,
    /// and what keeps the fit right for a source whose buffer the engine had to convert.
    static func place(_ frame: CIImage, into render: CGRect, fit: Fit) -> CIImage {
        let normalise = CGAffineTransform(translationX: -frame.extent.origin.x,
                                          y: -frame.extent.origin.y)
        let src = frame.transformed(by: normalise).extent
        guard src.width > 0, src.height > 0 else { return CIImage(color: .black).cropped(to: render) }

        let sx = render.width / src.width
        let sy = render.height / src.height
        let s = (fit == .cover) ? max(sx, sy) : min(sx, sy)
        // Do NOT round these. A 1920x1080 source contained into 720x1280 lands on a half-pixel
        // offset of 437.5; Core Image resamples it without complaint, and rounding it would stop
        // `contain` and `cover` being each other's mirror.
        let tx = (render.width - src.width * s) / 2
        let ty = (render.height - src.height * s) / 2

        return frame
            .transformed(by: normalise
                .concatenating(CGAffineTransform(scaleX: s, y: s))
                .concatenating(CGAffineTransform(translationX: tx, y: ty)))
            .cropped(to: render)
            .composited(over: CIImage(color: .black).cropped(to: render))
    }
}
