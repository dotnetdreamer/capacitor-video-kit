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
/// `@unchecked Sendable` honest - `cursor` included, because the reference never changes and the
/// object behind it guards itself.
final class RenderPlan: @unchecked Sendable {
    let renderSize: CGSize
    let colorMatrix: ColorMatrix
    let overlays: [PlacedOverlay]

    /// Where the compositor has got to on THIS job's output timeline, read when the encode fails.
    let cursor = FrameCursor()

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

/// The output-timeline instant of the last frame the compositor was asked to draw for one job, which
/// is Android's `job.lastFrameUs` and exists for the same reason: an error out of the encode names a
/// fault and never a clip, and how far the timeline had got is the only thing that can say which
/// clip was being read when it happened.
///
/// It hangs off the `RenderPlan` rather than off the compositor or a global. AVFoundation builds the
/// compositor itself, once per reader or session and with a bare `init()`, so the compositor has
/// nothing it could hand the job; a global would have two concurrent jobs writing over each other's
/// frame. The plan is the one object every instruction of this job shares and no other job does.
///
/// Written on the compositor's queue and read on whichever thread the failure surfaces on, so the
/// value is behind its own lock rather than the registry's.
final class FrameCursor: @unchecked Sendable {
    private let lock = NSLock()
    private var lastUs: Int64?

    /// Microseconds, like `request.compositionTime` is read everywhere else in the compositor.
    func record(_ us: Int64) {
        lock.lock()
        lastUs = us
        lock.unlock()
    }

    /// nil until the first frame has been asked for, which a failure that surfaces before the encode
    /// has drawn anything leaves it at.
    var us: Int64? {
        lock.lock()
        defer { lock.unlock() }
        return lastUs
    }
}

/// One video layer of one instruction: which source track its picture comes from, and everything
/// about how that picture is drawn.
struct EditLayer {
    let trackID: CMPersistentTrackID
    let orientation: CGImagePropertyOrientation
    let fit: Fit

    /// The part of the oriented source frame to keep, still in the wire's normalised y-DOWN
    /// fractions because the frame's pixel size is not known until a frame actually arrives. nil is
    /// the whole frame, and nil is what every spec written before crop existed carries.
    let crop: ComposeRect?

    /// Where the cropped picture is drawn, already in RENDER PIXELS and already flipped into Core
    /// Image's y-UP space. Resolved when the composition is built rather than in `render`: the
    /// rectangle cannot change between frames, and the whole point of keeping it an optional is
    /// that a clip with no rect reaches the compositor with nothing to compute and nothing to test
    /// but a nil.
    let dst: CGRect?

    /// How far `dst` is turned, in RADIANS, already negated into Core Image's y-UP space and ready
    /// to hand to `CGAffineTransform(rotationAngle:)`.
    ///
    /// nil is a clip that stands exactly as it was drawn, and nil is what reaches `render` for every
    /// spec written before the angle existed. Decided HERE, once per plan, never per frame: it is
    /// what keeps an untouched clip on the arithmetic it has always taken.
    let spin: CGFloat?

    /// The opacity of the whole layer this clip belongs to. The base track is 1, which `Alpha`
    /// hands straight back, so the common frame pays nothing for the feature.
    let opacity: Double

    init(trackID: CMPersistentTrackID, orientation: CGImagePropertyOrientation, fit: Fit,
         crop: ComposeRect?, rect: ComposePlacement?, opacity: Double, render: CGSize) {
        self.trackID = trackID
        self.orientation = orientation
        self.fit = fit
        self.crop = crop
        // `render` is what `vc.renderSize` is set to, and the render context the compositor is
        // handed is built from that, so this is the same rectangle `render` measures per frame. The
        // rectangle is resolved into PIXELS before anything turns it, because an angle applied to
        // the normalised fractions would shear a square window into a rhombus on a 720x1280 frame
        // while the preview, which turns it in CSS pixels, would not.
        self.dst = rect.map { Placement.destination($0.bounds, in: CGRect(origin: .zero, size: render)) }
        self.spin = EditLayer.spin(of: rect)
        self.opacity = opacity
    }

    /// The angle as Core Image wants it, or nil for a picture that is not turned at all.
    ///
    /// Two things collapse to nil, and both have to: an ABSENT angle, which is every clip the editor
    /// has ever sent, and a whole number of turns, which is the same upright rectangle by the
    /// manifest's own definition and would otherwise be resampled through a transform whose cosine
    /// is a rounding error away from 1.
    ///
    /// The sign is `OverlayBitmap`'s, for the same reason: the wire's degrees run CLOCKWISE as CSS
    /// `rotate()` does, while a positive angle in a y-up space turns counter-clockwise. A turned
    /// video and a turned sticker have to agree, and this is the line that makes them.
    private static func spin(of rect: ComposePlacement?) -> CGFloat? {
        // `isFinite` is the second line of defence behind the parser, which already answers nil for
        // a NaN: a non-finite angle here would put a NaN into the transform and take the frame with
        // it, and NaN fails the whole-turn test below rather than passing it.
        guard let deg = rect?.rotationDeg, deg.isFinite,
              deg.truncatingRemainder(dividingBy: 360) != 0 else { return nil }
        return -CGFloat(deg) * .pi / 180
    }
}

/// A transition the base is in the middle of, as one instruction carries it: the outgoing side and
/// everything needed to draw it against the incoming side, which is the instruction's first layer.
///
/// Built once per window by the builder and shared, unchanged, by every instruction the window was
/// split into, which is why it carries the WINDOW's start and length rather than the instruction's:
/// progress is measured against the transition, not against whichever piece of it a frame is in.
struct EditTransition {
    /// The outgoing clip's tail, on the tail track, framed as that clip was on the base.
    let tail: EditLayer
    /// The window on the output timeline, in microseconds like `request.compositionTime` is read.
    let startUs: Int64
    let durationUs: Int64
    let curves: ComposeTransitionCurves
    let mask: ComposeTransitionMask?
    let fromTint: ComposeRGB
    let toTint: ComposeRGB
}

/// One instruction per stretch of the OUTPUT timeline over which every layer holds still.
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
    /// whole clip and an overlay that appears mid-clip would never show up - and a transition, which
    /// is the one thing in this engine that genuinely tweens, would freeze on its first frame.
    let containsTweening: Bool = true

    let requiredSourceTrackIDs: [NSValue]?

    /// Must stay invalid. A valid value tells the engine to pass the source frame straight through
    /// and bypass the compositor entirely: no colour, no overlays, no fit.
    let passthroughTrackID: CMPersistentTrackID = kCMPersistentTrackID_Invalid

    /// BOTTOM first: the builder has already sorted them by z, so drawing them in order is the
    /// whole of the z handling. One entry is the whole of what this engine built before a second
    /// video track existed.
    let layers: [EditLayer]

    /// The transition the base is in the middle of over this stretch, or nil for every instruction
    /// outside a window, which is every instruction of a post without transitions. When it is set,
    /// `layers[0]` is the base's clip - the incoming side - and is drawn together with
    /// `transition.tail` in place of on its own; every layer after it is drawn as it always is.
    let transition: EditTransition?

    let plan: RenderPlan

    init(timeRange: CMTimeRange, layers: [EditLayer], transition: EditTransition? = nil,
         plan: RenderPlan) {
        self.timeRange = timeRange
        self.layers = layers
        self.transition = transition
        // Only the layers that actually have a clip at this instant, which is what lets a layer
        // that has not started yet cost the engine no decode at all - and the tail track only
        // inside a window, which is the only place it has anything on it.
        var trackIDs = layers.map { NSNumber(value: $0.trackID) }
        if let tail = transition?.tail { trackIDs.append(NSNumber(value: tail.trackID)) }
        self.requiredSourceTrackIDs = trackIDs
        self.plan = plan
        super.init()
    }
}

enum CompositorError: Error { case badInstruction, noBuffer }

/// The custom `AVVideoCompositing` that draws every output frame.
///
/// Safe to instantiate more than once per process: the exporter's one fallback builds a fresh
/// `AVAssetExportSession` after the writer engine's reader has given up, and it builds a fresh
/// compositor.
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
    private let queue = DispatchQueue(label: "net.dotnetdreamer.videokit.compositor",
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
            .name: "VideoKitEditCompositor",
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

        // Microseconds, matching Android's `presentationTimeUs in startUs until endUs` exactly.
        // `compositionTime` is OUTPUT-timeline time, which is what the overlay windows are in and
        // what a transition window is in. Read up here because a transition needs it before the
        // layers are drawn, not only the overlays after them.
        let tUs = CMTimeConvertScale(request.compositionTime,
                                     timescale: 1_000_000, method: .roundTowardZero).value
        // Before a single layer is drawn, so that a frame whose drawing throws still counts as the
        // frame the job had reached.
        instr.plan.cursor.record(tUs)

        // Black under every layer. With one layer it is the same black `Placement` used to hold
        // behind its picture, and the frame a source that arrived nil has always produced; with two
        // it is what shows wherever neither layer reaches.
        var image = CIImage(color: .black).cropped(to: rect)
        var layers = instr.layers[...]

        // Inside a transition window the base is not one clip but two: the outgoing clip's tail and
        // the incoming clip, each as its WHOLE frame - picture and bars together - moved, softened
        // and tinted by where the transition has got to, and blended. That frame takes the place of
        // the black and the first layer; every other layer is then drawn over it as it always is,
        // so a sticker or a picture-in-picture sits still while the base changes under it.
        if let transition = instr.transition, let incoming = layers.first {
            let p = TransitionMath.progress(tUs: tUs, startUs: transition.startUs,
                                            durationUs: transition.durationUs)
            image = TransitionRender.frame(from: wholeFrame(transition.tail, request, plan: instr.plan, rect: rect),
                                           to: wholeFrame(incoming, request, plan: instr.plan, rect: rect),
                                           look: TransitionMath.look(transition.curves, p),
                                           transition: transition,
                                           rect: rect)
            layers = layers.dropFirst()
        }

        for layer in layers {
            // nil for a track that has no frame at this instant. The layer is skipped and the frame
            // is still rendered: a hole in one layer is not a reason to fail an export.
            guard let src = request.sourceFrame(byTrackID: layer.trackID),
                  let picture = placedPicture(of: layer, from: src, plan: instr.plan, rect: rect)
            else { continue }
            image = Alpha.scaled(picture, by: layer.opacity).composited(over: image)
        }

        for ov in instr.plan.overlays where ov.startUs <= tUs && tUs < ov.endUs {
            image = ov.image.composited(over: image)   // spec order is drawing order, later on top
        }

        // The four-argument render with `colorSpace: nil`, never `render(_:toCVPixelBuffer:)`: the
        // two-argument form matches to the BUFFER's colour space, and the render context tags its
        // buffers 709, which would undo everything the unmanaged context just bought.
        ci.render(image, to: dst, bounds: rect, colorSpace: nil)
        return dst
    }

    /// One layer's picture, oriented, graded and placed, TRANSPARENT everywhere it does not reach -
    /// exactly what every layer of every frame has always been drawn as - or nil when there is no
    /// picture to place at all.
    private func placedPicture(of layer: EditLayer, from src: CVPixelBuffer, plan: RenderPlan,
                               rect: CGRect) -> CIImage? {
        var pic = CIImage(cvPixelBuffer: src, options: [.colorSpace: NSNull()])
            .oriented(layer.orientation)
        // The colour goes on the PICTURE, before the letterbox bars exist. Applied to the
        // finished frame instead, any op with a non-zero bias paints the bars: `golden` carries
        // b = [0.1595, 0.1108, 0.0261], which gives rgb(41, 28, 7) bars, and a fade gives grey
        // ones. `contain` is the default fit, so that is the common case and not an edge case.
        // A colour matrix commutes with the scale and translate in `placed`, so moving it
        // earlier leaves the picture itself identical.
        //
        // The wire calls the filter SPEC level - one grade of the composed frame rather than one
        // per track - and this is still that. The matrix is affine and a source-over blend is a
        // weighted average of the two pictures, so grading each layer before the blend and
        // grading the blend afterwards give the same pixels. What differs is only the black
        // underneath, and leaving that ungraded is the whole point.
        pic = plan.colorMatrix.apply(to: pic)
        // The crop is the one step that genuinely cannot move: it decides which pixels the fit
        // is measuring, so it happens inside `placed` and ahead of everything. Both it and
        // `dst` are nil for a clip that fills the frame, which is every spec written before
        // this feature; the absence was decided when the instruction was built, and all that is
        // left here is the coalesce.
        return Placement.placed(pic, crop: layer.crop, into: layer.dst ?? rect,
                                fit: layer.fit, spin: layer.spin)
    }

    /// One side of a transition: the layer's WHOLE output frame, black with its picture drawn on it
    /// exactly as a lone base clip is drawn, which is what the contract moves, blurs and tints.
    ///
    /// nil only when the track has no frame at this instant, which `TransitionRender.frame` answers
    /// by drawing the other side alone. A clip whose picture places to nothing is not that: it is a
    /// clip that contributes nothing, and its whole frame is black.
    private func wholeFrame(_ layer: EditLayer, _ request: AVAsynchronousVideoCompositionRequest,
                            plan: RenderPlan, rect: CGRect) -> CIImage? {
        guard let src = request.sourceFrame(byTrackID: layer.trackID) else { return nil }
        let black = CIImage(color: .black).cropped(to: rect)
        guard let picture = placedPicture(of: layer, from: src, plan: plan, rect: rect) else { return black }
        // Cropped to the render: a picture placed half off the frame hangs past it, and the frame the
        // contract moves and blurs is the render rectangle and nothing more.
        return Alpha.scaled(picture, by: layer.opacity).composited(over: black).cropped(to: rect)
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

    /// Turns a wire rectangle - normalised, TOP-LEFT origin, y DOWN - into a rectangle of `frame` in
    /// Core Image's coordinates, which are y-UP from the bottom-left. A crop is inside 0...1 and a
    /// placement need not be: a picture drawn off the edge of the output comes through here with a
    /// negative origin or a side past the frame, and the render bounds are what cut it off.
    ///
    /// The flip is the whole reason this function exists, and it is the single easiest thing in this
    /// file to get wrong. `r.y` names the rectangle's TOP edge measured downwards from the top, so
    /// its BOTTOM edge - which is the origin Core Image wants - sits at `1 - (y + h)` measured
    /// upwards from the bottom. Pass `r.y` straight through instead and every centred rectangle
    /// still looks perfect, because a centred rectangle is its own mirror; the first off-centre crop
    /// is the one that comes out reflected, by which point the maths is long since believed.
    ///
    /// x needs no such treatment: both systems run x to the right.
    static func destination(_ r: ComposeRect, in frame: CGRect) -> CGRect {
        CGRect(x: frame.minX + r.x * frame.width,
               y: frame.minY + (1 - r.y - r.h) * frame.height,
               width: r.w * frame.width,
               height: r.h * frame.height)
    }

    /// `frame` is already oriented. Returns the picture placed where it belongs, cropped to `dst`
    /// and TRANSPARENT everywhere else, or nil when there is no picture to place at all.
    ///
    /// Nothing black is composited in here: `EditCompositor.render` starts every frame on black and
    /// draws the layers over it, which for a single layer is the same two operations in the same
    /// order this function used to perform itself, and for two is the only way an upper layer can
    /// leave the one underneath showing around it.
    ///
    /// `contain` is `min(sx, sy)`, Android's `LAYOUT_SCALE_TO_FIT`; `cover` is `max(sx, sy)`, its
    /// `LAYOUT_SCALE_TO_FIT_WITH_CROP`. Everything reads `frame.extent` and never the track's
    /// `naturalSize`, which is what makes one video track carrying clips of mixed resolutions safe,
    /// and what keeps the fit right for a source whose buffer the engine had to convert.
    ///
    /// `crop` is the part of the oriented frame to keep and is applied FIRST, so the fit measures
    /// what the customer kept rather than what the camera shot. `dst` is where the result lands. A
    /// clip with neither carries `crop == nil` and `dst` equal to the whole render frame, and that
    /// is not an approximation of the old arithmetic, it is the same arithmetic: `dst.minX` and
    /// `dst.minY` are zero and add nothing, and `dst.width`/`dst.height` ARE the render size.
    ///
    /// `spin` turns the finished rectangle about its own centre and is the LAST thing to happen
    /// here, which is what makes the fit a property of the upright rectangle: fitting into the
    /// turned rectangle's bounding box instead would swell and shrink the picture as the customer
    /// spins it. It is also why the clip to `dst` happens before the turn rather than after, so
    /// `cover` still overflows into the rectangle's own edges and is cut there, and the cut travels
    /// with the picture.
    static func placed(_ frame: CIImage, crop: ComposeRect?, into dst: CGRect,
                       fit: Fit, spin: CGFloat?) -> CIImage? {
        // CROP FIRST, against the frame's own extent, and with the same y flip `destination` does
        // and for the same reason: `crop.y` is measured from the TOP of the picture while
        // `extent.minY` is its bottom. Cropping rather than transforming keeps the source pixels
        // where they are, so the scale below is still measured on real pixels and nothing is
        // resampled twice.
        var picture = frame
        if let c = crop {
            picture = frame.cropped(to: destination(c, in: frame.extent))
        }

        let normalise = CGAffineTransform(translationX: -picture.extent.origin.x,
                                          y: -picture.extent.origin.y)
        let src = picture.transformed(by: normalise).extent
        // A zero-sized source is a clip that contributes nothing rather than a failure, which is
        // what both engines do with one. It leaves whatever is underneath it showing.
        guard src.width > 0, src.height > 0 else { return nil }

        let sx = dst.width / src.width
        let sy = dst.height / src.height
        let s = (fit == .cover) ? max(sx, sy) : min(sx, sy)
        // Do NOT round these. A 1920x1080 source contained into 720x1280 lands on a half-pixel
        // offset of 437.5; Core Image resamples it without complaint, and rounding it would stop
        // `contain` and `cover` being each other's mirror.
        let tx = dst.minX + (dst.width - src.width * s) / 2
        let ty = dst.minY + (dst.height - src.height * s) / 2

        let upright = picture
            .transformed(by: normalise
                .concatenating(CGAffineTransform(scaleX: s, y: s))
                .concatenating(CGAffineTransform(translationX: tx, y: ty)))
            // Clipped to the DESTINATION and not to the whole frame. `cover` overflows on purpose,
            // and a picture placed on half the frame must not spill over the other half. With no
            // rect the destination IS the whole frame and this is the line that was always here.
            .cropped(to: dst)

        // Every clip that is not turned leaves by this line, with the transform it has always had.
        guard let spin else { return upright }

        // About the rectangle's CENTRE: to the origin, turn, and back. Concatenation is A-then-B, so
        // this reads top to bottom as it happens, exactly as `OverlayBitmap` builds its own. The
        // corners may now hang outside the output frame, and that is correct - the frame crops them,
        // which is why nothing clamps the angle against the room left.
        return upright.transformed(by: CGAffineTransform(translationX: -dst.midX, y: -dst.midY)
            .concatenating(CGAffineTransform(rotationAngle: spin))
            .concatenating(CGAffineTransform(translationX: dst.midX, y: dst.midY)))
    }
}

enum Alpha {

    /// A layer at `opacity`, ready to be composited over what is beneath it.
    ///
    /// The ALPHA ROW alone, and nothing on the colour rows. `CIColorMatrix` unpremultiplies before
    /// it multiplies and premultiplies again afterwards, so this is source-over at `k * a` - what a
    /// CSS `opacity` on the layer does and what Android's alpha scale does. Measured on this SDK
    /// with colour management off, blue at k = 0.5 over red: the alpha row gives rgb(128, 0, 128)
    /// and scaling all four channels gives rgb(128, 0, 64), because the colour is then attenuated
    /// once by the matrix and once by the premultiply. The filter carries no bias, so anything
    /// transparent stays transparent and the extent is unchanged.
    ///
    /// An opacity of 1 hands the image straight back, the way `ColorMatrix.apply` hands back an
    /// identity: every frame of every single-layer render goes through here.
    static func scaled(_ image: CIImage, by opacity: Double) -> CIImage {
        let k = CGFloat(min(1, max(0, opacity)))
        guard k < 1 else { return image }
        return image.applyingFilter("CIColorMatrix", parameters: [
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: k),
        ])
    }
}
