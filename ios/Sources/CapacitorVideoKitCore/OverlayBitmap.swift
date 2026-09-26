import CoreGraphics
import CoreImage
import Foundation
import ImageIO

/// One overlay, decoded and fully placed into render space, with the window it is visible for.
///
/// The window is stored in MICROSECONDS because the compositor compares it against
/// `request.compositionTime` converted the same way: converting to a millisecond timescale instead
/// truncates, which can move a boundary by up to a millisecond against Android for nothing.
struct PlacedOverlay: @unchecked Sendable {
    /// The layer placed at REST, once: what every frame of a still layer composites, and every frame
    /// of a moving one at which its motion leaves it where it was put.
    let image: CIImage
    let startUs: Int64
    let endUs: Int64
    /// What a MOVING layer is placed again from on the frames its motion moves it, or nil for a layer
    /// that stands still - every overlay of every spec written before layers moved, which then
    /// reaches the compositor with nothing to evaluate and nothing to test but this nil.
    var moving: MovingOverlay? = nil

    /// The layer at output time `tUs`: placed where its motion has it, or the image placed once when
    /// it has none or is at rest there. nil when the motion has shrunk it to nothing or faded it out,
    /// which leaves the frame as it was.
    func frame(atUs tUs: Int64, render: CGSize) -> CIImage? {
        guard let moving,
              let sample = OverlayMotionMath.sample(moving.motion, atMs: Double(tUs) / 1000) else { return image }
        return moving.placed(at: sample, render: render)
    }
}

/// A moving overlay's decoded bitmap and resting placement, KEPT rather than baked, so it can be
/// placed again per frame: the one decode every layer gets, then one transform and one alpha a frame,
/// which Core Image fuses into a single resample of the bitmap exactly as it does for a still layer.
struct MovingOverlay: @unchecked Sendable {
    /// The decoded PNG, colour management off, before its opacity and before any placement.
    let base: CIImage
    /// Bitmap pixels to output pixels, per axis: `wPx / width` and `hPx / height` of what decoded.
    let sx: CGFloat
    let sy: CGFloat
    /// The resting size in output pixels, `wPx` x `hPx`.
    let w: CGFloat
    let h: CGFloat
    /// The resting centre, turn and opacity, in the wire's terms.
    let cx: Double
    let cy: Double
    let rotationDeg: Double
    let opacity: Double
    let motion: ComposeOverlayMotion

    /// The layer where `sample` has it: the contract's three numbers added and two multiplied. The
    /// size multiplies the bitmap's stretch - and so the half-size the placement centres it by - which
    /// makes the size and the turn act about the layer's own centre; the offsets move that centre in
    /// fractions of the frame, y down as the wire has it; the turn is added to the layer's own; and
    /// the opacity multiplies the layer's own, on the alpha alone, before the geometry, exactly as
    /// `OverlayBitmap.decode` applies a still layer's. nil when there is nothing left to draw.
    func placed(at sample: OverlayMotionSample, render: CGSize) -> CIImage? {
        let alpha = opacity * sample.opacity
        let k = CGFloat(sample.scale)
        guard alpha > 0, k > 0 else { return nil }
        let placement = OverlayBitmap.placement(sx: sx * k, sy: sy * k, w: w * k, h: h * k,
                                                rotationDeg: rotationDeg + sample.rotation,
                                                cx: cx + sample.x, cy: cy + sample.y, render: render)
        return Alpha.scaled(base, by: alpha).transformed(by: placement)
    }
}

enum OverlayBitmap {

    /// The parser has already checked this prefix; it is re-checked here because `decode` is also
    /// the last thing standing between a malformed data URL and `Data(base64Encoded:)`.
    private static let pngDataURLPrefix = "data:image/png;base64,"

    /// Decodes the data URL and folds scale, centring, rotation and translation into ONE affine so
    /// Core Image resamples the bitmap exactly once.
    ///
    /// Returns nil when the overlay is fully transparent: iOS rebuilds the plan per export, so an
    /// invisible layer can simply leave the list. (Android keeps it at `alphaScale = 0` only because
    /// its effect chain is fixed for the whole render.) The decode still runs first, so a broken PNG
    /// fails the job on both platforms whatever its opacity says. A motion changes none of that: it
    /// MULTIPLIES the opacity, so a layer at 0 stays at 0 through every move it has.
    ///
    /// Throws `BuildError.invalidOverlay(o.id)`, which the registry turns into a `failed` event with
    /// code `unknown`. It is NOT a call rejection: `compose` has already resolved by the time the
    /// plan is built, and the overlay is not an input file.
    static func decode(_ o: ComposeOverlay, render: CGSize) throws -> PlacedOverlay? {
        // `.ignoreUnknownCharacters` mirrors Android's `Base64.DEFAULT`, which tolerates the
        // whitespace some WebView builds fold into a long data URL. Without it a perfectly good PNG
        // fails to decode and the customer loses a render for a line break.
        guard o.png.hasPrefix(pngDataURLPrefix),
              let comma = o.png.firstIndex(of: ","),
              let data = Data(base64Encoded: String(o.png[o.png.index(after: comma)...]),
                              options: [.ignoreUnknownCharacters]),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let cg = CGImageSourceCreateImageAtIndex(source, 0,
                                                       [kCGImageSourceShouldCache: false] as CFDictionary)
        else { throw BuildError.invalidOverlay(o.id) }

        guard o.opacity > 0 else { return nil }

        // No colour management on the overlay either, for the same reason as the video frame: the
        // preview blends these bitmaps over the filtered picture in gamma-encoded sRGB, so anything
        // that linearises them on the way in moves the result away from what was approved.
        let decoded = CIImage(cgImage: cg, options: [.colorSpace: NSNull()])

        // The extent of what ACTUALLY decoded, never the size the manifest asked for. The rasteriser
        // deliberately ships half-resolution PNGs for soft effects (`effectRasterScale` is 0.5 for
        // gradients, glows and grain), up to 1.5x ones for a layer whose motion magnifies it,
        // caps any bitmap side at 1.5x the output's larger side, and rounds its canvas up with
        // `Math.ceil`, so a vignette on a 720x1280 render arrives as a 360x640 PNG still claiming
        // 720x1280. sx and sy are taken independently so an odd-sized PNG halved by the decoder
        // cannot drift in one axis.
        let bw = decoded.extent.width, bh = decoded.extent.height
        guard bw > 0, bh > 0 else { throw BuildError.invalidOverlay(o.id) }
        let sx = CGFloat(o.wPx) / bw
        let sy = CGFloat(o.hPx) / bh

        // Opacity before the geometry, while the image is still small and axis aligned, and on the
        // ALPHA alone: `Alpha.scaled`, the call every video layer's opacity goes through. The
        // colour rows are left alone because `CIColorMatrix` does not act on premultiplied values -
        // it unpremultiplies, multiplies and premultiplies again - so scaling all four channels
        // would attenuate the colour once in the matrix and again in the premultiply, and an overlay
        // at 50% would come out at a quarter of its colour. Scaling the alpha row is source-over at
        // `k * a`, which is what a CSS `opacity` on the layer does in the preview and what
        // Android's `setAlphaScale` does; `Alpha` records the measurement. The filter has no bias,
        // so the transparent surround stays transparent and the extent is unchanged.
        let img = Alpha.scaled(decoded, by: o.opacity)

        let w = CGFloat(o.wPx), h = CGFloat(o.hPx)
        let atRest = OverlayBitmap.placement(sx: sx, sy: sy, w: w, h: h, rotationDeg: o.rotationDeg,
                                             cx: o.cx, cy: o.cy, render: render)

        // A moving layer keeps what it was placed FROM, so the compositor can place it again on every
        // frame its motion moves it. Kept only for one: nil is what a still layer carries, and the
        // compositor then composites `image` as it always has.
        let moving = o.motion.map {
            MovingOverlay(base: decoded, sx: sx, sy: sy, w: w, h: h, cx: o.cx, cy: o.cy,
                          rotationDeg: o.rotationDeg, opacity: o.opacity, motion: $0)
        }

        return PlacedOverlay(image: img.transformed(by: atRest),
                             startUs: o.startMs * 1000,
                             endUs: o.endMs * 1000,
                             moving: moving)
    }

    /// The one affine that places a bitmap on the render: stretched to its size, centred on the
    /// origin, turned, and carried to its centre. A still layer is placed through it once, with its
    /// own numbers; a moving one through it again on every frame, with the motion's folded in.
    ///
    /// Two sign flips, in two different places, and no flip at all on x:
    ///   cx/cy are the CENTRE in 0...1 with a TOP-LEFT origin and y DOWN, while Core Image is
    ///   y UP, so the vertical position is (1 - cy) * H;
    ///   rotationDeg is CLOCKWISE like CSS rotate(), while a positive angle in a y-up space turns
    ///   counter-clockwise, so the angle is negated.
    /// Android performs the same two flips into its own -1...1 GL space in `RenderPlan.build`, and
    /// `OverlayPose.moved` the same two again on a motion's numbers.
    ///
    /// Concatenation order is A-then-B (Core Graphics multiplies row vectors: p' = p * A * B), so
    /// this reads top to bottom as it happens. Scale FIRST and rotate second: rotating first and
    /// then scaling non-uniformly would shear a stretched overlay. Step 2 translates by half of
    /// `w`/`h`, the SCALED size, because step 1 has already run.
    static func placement(sx: CGFloat, sy: CGFloat, w: CGFloat, h: CGFloat, rotationDeg: Double,
                          cx: Double, cy: Double, render: CGSize) -> CGAffineTransform {
        CGAffineTransform(scaleX: sx, y: sy)
            .concatenating(CGAffineTransform(translationX: -w / 2, y: -h / 2))
            .concatenating(CGAffineTransform(rotationAngle: -CGFloat(rotationDeg) * .pi / 180))
            .concatenating(CGAffineTransform(translationX: CGFloat(cx) * render.width,
                                             y: (1 - CGFloat(cy)) * render.height))
    }
}
