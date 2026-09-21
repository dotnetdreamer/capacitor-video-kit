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
    let image: CIImage
    let startUs: Int64
    let endUs: Int64
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
    /// fails the job on both platforms whatever its opacity says.
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
        var img = CIImage(cgImage: cg, options: [.colorSpace: NSNull()])

        // The extent of what ACTUALLY decoded, never the size the manifest asked for. The rasteriser
        // deliberately ships half-resolution PNGs for soft effects (`effectRasterScale` is 0.5 for
        // gradients, glows and grain), caps any bitmap side at 1.5x the output's larger side, and
        // rounds its canvas up with `Math.ceil`, so a vignette on a 720x1280 render arrives as a
        // 360x640 PNG still claiming 720x1280. sx and sy are taken independently so an odd-sized
        // PNG halved by the decoder cannot drift in one axis.
        let bw = img.extent.width, bh = img.extent.height
        guard bw > 0, bh > 0 else { throw BuildError.invalidOverlay(o.id) }
        let sx = CGFloat(o.wPx) / bw
        let sy = CGFloat(o.hPx) / bh

        // Opacity as a FOUR-channel multiply, before the geometry, while the image is still small
        // and axis aligned. Core Image images are premultiplied, so source-over with a foreground
        // scaled by k is `dst * (1 - k*a) + k*src.rgb`, which is exactly source-over at alpha k*a -
        // what a CSS `opacity` on the layer does and what Android's `setAlphaScale` does. Scaling
        // only the alpha vector, which is the obvious-looking thing, leaves the colour unattenuated
        // and gives a faded overlay a bright halo. This filter has no bias, so the transparent
        // surround stays transparent and the extent is unchanged.
        if o.opacity < 1 {
            let k = CGFloat(min(1, max(0, o.opacity)))
            img = img.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: k, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: k, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: k, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: k),
            ])
        }

        // Two sign flips, in two different places, and no flip at all on x:
        //   cx/cy are the CENTRE in 0...1 with a TOP-LEFT origin and y DOWN, while Core Image is
        //   y UP, so the vertical position is (1 - cy) * H;
        //   rotationDeg is CLOCKWISE like CSS rotate(), while a positive angle in a y-up space turns
        //   counter-clockwise, so the angle is negated.
        // Android performs the same two flips into its own -1...1 GL space in `RenderPlan.build`.
        //
        // Concatenation order is A-then-B (Core Graphics multiplies row vectors: p' = p * A * B), so
        // this reads top to bottom as it happens. Scale FIRST and rotate second: rotating first and
        // then scaling non-uniformly would shear a stretched overlay. Step 2 translates by half of
        // wPx/hPx, the SCALED size, because step 1 has already run.
        let w = CGFloat(o.wPx), h = CGFloat(o.hPx)
        let placement = CGAffineTransform(scaleX: sx, y: sy)
            .concatenating(CGAffineTransform(translationX: -w / 2, y: -h / 2))
            .concatenating(CGAffineTransform(rotationAngle: -CGFloat(o.rotationDeg) * .pi / 180))
            .concatenating(CGAffineTransform(translationX: CGFloat(o.cx) * render.width,
                                             y: (1 - CGFloat(o.cy)) * render.height))

        return PlacedOverlay(image: img.transformed(by: placement),
                             startUs: o.startMs * 1000,
                             endUs: o.endMs * 1000)
    }
}
