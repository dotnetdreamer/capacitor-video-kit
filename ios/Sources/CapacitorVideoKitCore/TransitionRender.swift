import CoreGraphics
import CoreImage
import Foundation

/// The Core Image half of a transition: one frame inside a window, drawn from two whole frames and a
/// `TransitionLook`, exactly as the contract on `ComposeTransition` in `definitions.ts` describes and
/// in the order `transitionPixel` in `transitions.ts` performs it.
///
/// That function works one output pixel at a time; this one works one IMAGE at a time, and the two
/// agree because every step of the pixel recipe is either a per-pixel colour operation - which
/// commutes with where the pixel came from - or a resampling that Core Image can do to a whole image
/// at once. Per side, the reference reads its colour at a source position `s`:
///
///   `s` is the output pixel moved back through the side's offset, turn and scale, then snapped to
///   the centre of its mosaic cell; the colour there is the frame BLURRED, with red read `split`
///   to the right of `s` and blue `split` to the left; then gain, clamp and tint.
///
/// Read inside out, that is: blur the frame, pull its red and blue apart, pixelate the result, grade
/// it, and only then move it. Every step before the move happens in the frame's own pixels, on an
/// image that is opaque across the whole render rectangle, which is what lets each one clamp at the
/// frame's edges the way the reference's `read` does. The move comes last and is the one step that
/// uncovers anything: outside the moved frame the side is transparent, and what shows there is
/// whatever is under it.
///
/// Every filter here is a built-in Core Image filter with its parameters passed by name, the way
/// `ColorMatrix` and `Alpha` already drive `CIColorMatrix`. There are no custom kernels: a Metal
/// kernel needs a metallib the Swift package cannot build, and the CIKernel language is deprecated.
enum TransitionRender {

    /// The base of one frame inside a window: the outgoing side over black, and the incoming side
    /// over that at `alpha` times the mask.
    ///
    /// `from` and `to` are the two sides' WHOLE frames, opaque over `rect`, and under a zoom each
    /// arrives ALREADY seen through the camera (`EditCompositor.wholeFrame`): nothing in this file
    /// knows the camera exists, and every step here - blur, split, pixelate, mask, move - acts in
    /// output pixels exactly as it does without one, so a zoom never magnifies a blur radius, a
    /// pixelate cell or a mask edge. When one of them has no
    /// frame at this instant - a source that has not delivered one at the very edge of a segment -
    /// the other is drawn ALONE, as it plays without the transition. That is a cut for a frame
    /// rather than a flash of black, which is what the contract's recipe would give for a side that
    /// is simply missing, and it is the smaller of the two glitches.
    static func frame(from: CIImage?, to: CIImage?, look: TransitionLook,
                      transition t: EditTransition, rect: CGRect) -> CIImage {
        let black = CIImage(color: .black).cropped(to: rect)
        guard let from, let to else { return (from ?? to ?? black).cropped(to: rect) }

        guard look.alpha > 0 else {
            return side(from, look.from, tint: t.fromTint, rect: rect).composited(over: black).cropped(to: rect)
        }
        let top = side(to, look.to, tint: t.toTint, rect: rect)

        // The incoming side at full strength, unmasked and unmoved, covers every pixel of the frame:
        // whatever the outgoing side would have drawn is hidden, so it is not drawn. This is the
        // second half of every dip, flash and burn, and it saves the blur the outgoing side often
        // carries there.
        if look.alpha >= 1, t.mask == nil, TransitionMath.sideTransform(look.to, in: rect) == nil {
            return top.cropped(to: rect)
        }

        let under = side(from, look.from, tint: t.fromTint, rect: rect).composited(over: black)
        var over = top
        if let mask = t.mask, let coverage = maskImage(mask, reveal: look.reveal, rect: rect) {
            // `CIBlendWithMask` interpolates between the image and the background by the mask's
            // green channel (this mask is grey, so every channel is the same number). Against a
            // TRANSPARENT background that interpolation is the incoming side's premultiplied pixels
            // times the mask - its coverage scaled, colour and alpha together - which is exactly an
            // alpha of `mask` for the source-over below, including wherever the side itself has been
            // moved off and is transparent. The background is transparent over the whole render
            // rather than `CIImage.empty()`, so the result's extent is the frame whichever way the
            // filter combines the extents of its inputs.
            let clear = CIImage(color: CIColor(red: 0, green: 0, blue: 0, alpha: 0)).cropped(to: rect)
            over = over.applyingFilter("CIBlendWithMask", parameters: [
                "inputBackgroundImage": clear,
                "inputMaskImage": coverage,
            ])
        }
        return Alpha.scaled(over, by: look.alpha).composited(over: under).cropped(to: rect)
    }

    /// One side - its whole frame - with its look applied: blurred, split, pixelated, graded and
    /// tinted in the frame's own pixels, then moved. Transparent wherever the moved frame is not.
    ///
    /// Each step is skipped at its neutral value, so a side that only slides costs one transform and
    /// a side at rest costs nothing but the crop.
    static func side(_ frame: CIImage, _ s: TransitionSide, tint: ComposeRGB, rect: CGRect) -> CIImage {
        let short = min(rect.width, rect.height)
        // Cut to the render first. A clip placed half off the frame arrives with its picture hanging
        // past the edge, and the reference's frame is W x H exactly: every clamp below has to clamp
        // at the FRAME's edge, not at the edge of whatever the placement left outside it.
        var image = frame.cropped(to: rect)

        // BLUR: sigma is a fraction of the SHORTER side, as CSS `blur()` takes its argument as a
        // standard deviation. `applyingGaussianBlur(sigma:)` is `CIGaussianBlur`, whose radius is
        // that same sigma. Clamped first so the frame's edges blur against themselves and not
        // against transparent black, which would darken a border the reference's clamped read never
        // darkens; cropped back so everything after this still measures the render rectangle.
        if s.blur > 0 {
            image = image.clampedToExtent()
                .applyingGaussianBlur(sigma: s.blur * Double(short))
                .cropped(to: rect)
        }

        // SPLIT: red from `split` of the width to the right, blue from as far to the left.
        if s.split != 0 {
            image = split(image, by: CGFloat(s.split) * rect.width, rect: rect)
        }

        // PIXELATE: cells `pixelate` of the shorter side across, laid out from the frame's centre,
        // each the colour at its own centre. The reference only snaps once a cell is wider than a
        // pixel, and so does this.
        if s.pixelate > 0 {
            let cell = CGFloat(s.pixelate) * short
            if cell > 1 { image = pixelated(image, cell: cell, rect: rect) }
        }

        // GAIN, then the clamp the reference applies with `min(1, rgb * gain)`. The clamp is not
        // optional for the reason it is not optional in `ColorMatrix.apply`: Core Image runs in
        // floating point, and a flash's gain of 6 would otherwise carry values far above 1 into the
        // tint and the blend.
        if s.gain != 1 {
            let g = CGFloat(s.gain)
            image = image.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: g, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: g, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: g, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            ]).applyingFilter("CIColorClamp", parameters: [
                "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
                "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
            ])
        }

        // TINT: `mix(rgb, tint colour, tint)`, which is `rgb * (1 - t) + colour * t` - a diagonal
        // matrix and a bias. The frame is opaque here, so the unpremultiply `CIColorMatrix` does on
        // the way in and the premultiply on the way out change nothing. The bias is defined over the
        // infinite plane and widens the extent to match, hence the crop.
        if s.tint > 0 {
            let t = CGFloat(s.tint)
            let keep = 1 - t
            image = image.applyingFilter("CIColorMatrix", parameters: [
                "inputRVector": CIVector(x: keep, y: 0, z: 0, w: 0),
                "inputGVector": CIVector(x: 0, y: keep, z: 0, w: 0),
                "inputBVector": CIVector(x: 0, y: 0, z: keep, w: 0),
                "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                "inputBiasVector": CIVector(x: t * CGFloat(tint.r), y: t * CGFloat(tint.g),
                                            z: t * CGFloat(tint.b), w: 0),
            ]).cropped(to: rect)
        }

        // MOVE, last. Cropped to the frame first so the move carries the frame and nothing beyond
        // it; past its edges the moved image is transparent, which is the contract's "outside the
        // frame the side is transparent", and the final crop cuts whatever the move carried off the
        // render.
        if let move = TransitionMath.sideTransform(s, in: rect) {
            image = image.cropped(to: rect).transformed(by: move)
        }
        return image.cropped(to: rect)
    }

    /// Red read `shift` pixels to the right, green where it is, blue `shift` pixels to the left.
    ///
    /// Each channel is isolated on an opaque image - `(r, 0, 0, 1)`, `(0, g, 0, 1)`, `(0, 0, b, 1)` -
    /// and the three are recombined with `CIMaximumCompositing`, a per-component maximum. With every
    /// other channel exactly 0 the maximum IS the channel, and with every alpha exactly 1 the result
    /// is opaque. Adding them instead (`CIAdditionCompositing`) would add the alphas too, and an
    /// alpha of 3 divides the colour by 3 the next time anything unpremultiplies it.
    ///
    /// The shifted copies read past the frame's edge, so they are read from the clamped image: the
    /// reference's `read` clamps there as well.
    private static func split(_ image: CIImage, by shift: CGFloat, rect: CGRect) -> CIImage {
        let clamped = image.clampedToExtent()
        // Moving an image right by d makes each pixel show what was d to its LEFT, so red, which
        // reads from the right, moves left.
        let red = channel(clamped.transformed(by: CGAffineTransform(translationX: -shift, y: 0)),
                          r: 1, g: 0, b: 0).cropped(to: rect)
        let green = channel(image, r: 0, g: 1, b: 0).cropped(to: rect)
        let blue = channel(clamped.transformed(by: CGAffineTransform(translationX: shift, y: 0)),
                           r: 0, g: 0, b: 1).cropped(to: rect)
        return red
            .applyingFilter("CIMaximumCompositing", parameters: ["inputBackgroundImage": green])
            .applyingFilter("CIMaximumCompositing", parameters: ["inputBackgroundImage": blue])
            .cropped(to: rect)
    }

    /// The image with only the channels switched on kept, alpha untouched.
    private static func channel(_ image: CIImage, r: CGFloat, g: CGFloat, b: CGFloat) -> CIImage {
        image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: r, y: 0, z: 0, w: 0),
            "inputGVector": CIVector(x: 0, y: g, z: 0, w: 0),
            "inputBVector": CIVector(x: 0, y: 0, z: b, w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
        ])
    }

    /// The mosaic: every pixel takes the colour at the centre of its `cell`-wide square, the squares
    /// laid out with a corner on the frame's centre, which is the reference's
    /// `C + (floor((s - C) / cell) + 0.5) * cell`.
    ///
    /// Built from two nearest-neighbour resamplings rather than `CIPixellate`, because Apple does
    /// not document where `CIPixellate` puts its cell corners or whether it averages a cell or reads
    /// one point of it, and either answer being the other way would put every cell half a cell away
    /// from the preview's. Here both are on the page:
    ///
    ///   1. to the centre and down by `cell`, read NEAREST: pixel k of the small image is sampled at
    ///      its own centre, `k + 0.5`, which lands on `C + (k + 0.5) * cell` - a cell centre;
    ///   2. that small image is rendered to a buffer of its own, so Core Image cannot fold the two
    ///      scales below into one and optimise the mosaic away;
    ///   3. back up by `cell` and out to the centre, read NEAREST again: output pixel P reads small
    ///      pixel `floor((P - C) / cell)`, the cell it lies in.
    ///
    /// The frame is clamped first so a part-cell at the edge, whose centre lies outside the frame,
    /// reads the edge colour as the reference's clamped `read` does. The cell lattice is symmetric
    /// about the centre, so it is the same lattice in Core Image's y-up space as in the wire's y-down.
    private static func pixelated(_ image: CIImage, cell: CGFloat, rect: CGRect) -> CIImage {
        let toCells = CGAffineTransform(translationX: -rect.midX, y: -rect.midY)
            .concatenating(CGAffineTransform(scaleX: 1 / cell, y: 1 / cell))
        // The frame in cell units, widened to whole cells so every part-cell at the edges exists.
        let cells = rect.applying(toCells).integral
        let small = image.clampedToExtent()
            .samplingNearest()
            .transformed(by: toCells)
            .cropped(to: cells)
            .insertingIntermediate()
        return small.clampedToExtent()
            .samplingNearest()
            .transformed(by: toCells.inverted())
            .cropped(to: rect)
    }

    /// The mask as a grey image over `rect`: `TransitionMath.maskGrid` worked out on a reduced grid
    /// and stretched over the render with linear sampling. nil only if Core Graphics refuses to wrap
    /// the bytes, and `frame` then reveals the incoming side unmasked.
    ///
    /// The grid goes through a `CGImage` rather than straight into `CIImage(bitmapData:)` because a
    /// `CGImage`'s first row is its TOP row - the order the grid is built in, y-down like the wire -
    /// and Core Image draws a `CGImage` upright. That is the one flip between the two spaces, made by
    /// the decode rather than by arithmetic that could be written the wrong way round. No colour
    /// space is applied on the way in, the rule every image in this engine follows, so a grey of 128
    /// is a mask of 128 / 255.
    ///
    /// The small image is clamped before it is stretched, so the outermost cells hold their value
    /// out to the frame's edge instead of fading into transparent black over the last half cell.
    static func maskImage(_ mask: ComposeTransitionMask, reveal: Double, rect: CGRect) -> CIImage? {
        let grid = TransitionMath.maskGrid(mask, reveal: reveal,
                                           width: Double(rect.width), height: Double(rect.height))
        guard let provider = CGDataProvider(data: Data(grid.values) as CFData),
              let cg = CGImage(width: grid.columns,
                               height: grid.rows,
                               bitsPerComponent: 8,
                               bitsPerPixel: 8,
                               bytesPerRow: grid.columns,
                               space: CGColorSpaceCreateDeviceGray(),
                               bitmapInfo: CGBitmapInfo(rawValue: CGImageAlphaInfo.none.rawValue),
                               provider: provider,
                               decode: nil,
                               shouldInterpolate: false,
                               intent: .defaultIntent)
        else { return nil }
        let small = CIImage(cgImage: cg, options: [.colorSpace: NSNull()])
        let stretch = CGAffineTransform(scaleX: rect.width / CGFloat(grid.columns),
                                        y: rect.height / CGFloat(grid.rows))
            .concatenating(CGAffineTransform(translationX: rect.minX, y: rect.minY))
        return small.clampedToExtent()
            .samplingLinear()
            .transformed(by: stretch)
            .cropped(to: rect)
    }
}
