import CoreGraphics
import CoreImage
import Foundation

/// The colour pipeline as pure arithmetic: `out = clamp(m * rgb + b, 0, 1)` on gamma-encoded sRGB.
///
/// Every filter and every Adjust control in the editor is a CSS Filter Effects operation, and the
/// constants below are the ones out of that spec rather than each platform's own idea of
/// "saturation". That is the whole reason the frames this plugin encodes agree with the preview the
/// customer approved: the browser, the Android shader and this file evaluate the same arithmetic on
/// the same gamma-encoded values.
struct ColorMatrix: Equatable, Sendable {

    /// Row-major 3x3, `m[row * 3 + col]`. Alpha is never touched, so a 4x5 would be four dead rows.
    var m: [Double] = [1, 0, 0, 0, 1, 0, 0, 0, 1]
    var b: [Double] = [0, 0, 0]

    static let identity = ColorMatrix()

    /// Compared with an epsilon rather than `==` on the arrays: a caller is allowed to send
    /// `[{op:'brightness',amount:1}]`, and a fold of several no-op matrices lands a few ULPs off
    /// the exact identity. Missing that costs two Core Image filters on every frame.
    private static let epsilon = 1e-6

    var isIdentity: Bool {
        for row in 0..<3 {
            for col in 0..<3 where abs(m[row * 3 + col] - (row == col ? 1 : 0)) > Self.epsilon {
                return false
            }
            if abs(b[row]) > Self.epsilon { return false }
        }
        return true
    }

    /// `next` applied AFTER self: `c2 = N (M c + b) + nb`, so `M' = N M` and `b' = N b + nb`.
    func then(_ next: ColorMatrix) -> ColorMatrix {
        var out = ColorMatrix()
        for row in 0..<3 {
            for col in 0..<3 {
                out.m[row * 3 + col] = (0..<3).reduce(0.0) { $0 + next.m[row * 3 + $1] * m[$1 * 3 + col] }
            }
        }
        for row in 0..<3 {
            out.b[row] = next.b[row] + (0..<3).reduce(0.0) { $0 + next.m[row * 3 + $1] * b[$1] }
        }
        return out
    }

    /// Folds the ordered list into one matrix; the FIRST entry is applied FIRST, which makes it the
    /// RIGHTMOST factor of the product. Get the direction backwards and `[brightness 2,
    /// contrast 0.5]` renders as `[contrast 0.5, brightness 2]`, which on grey 100 is 164 instead
    /// of 228. The list arrives already ordered by `resolveFilterOps` (which moves every tint to the
    /// end, because the preview can only draw a tint as a layer on top of a CSS-filtered video), so
    /// never re-sort it here.
    static func fold(_ ops: [FilterOp]) -> ColorMatrix {
        ops.reduce(ColorMatrix.identity) { $0.then(matrix(for: $1)) }
    }

    /// Only for the unit tests and the golden-frame script. The render never walks pixels; it hands
    /// the same numbers to `CIColorMatrix` and lets the GPU do it.
    func apply(_ rgb: (Double, Double, Double)) -> (Double, Double, Double) {
        func row(_ i: Int) -> Double {
            min(1, max(0, m[i * 3] * rgb.0 + m[i * 3 + 1] * rgb.1 + m[i * 3 + 2] * rgb.2 + b[i]))
        }
        return (row(0), row(1), row(2))
    }

    // MARK: - CSS Filter Effects

    /// The luminance weights CSS uses for `saturate` and `hue-rotate`, which are defined through SVG
    /// `feColorMatrix` and written with these rounded values.
    private static let lr = 0.213, lg = 0.715, lb = 0.072

    /// ...and the DIFFERENT ones it uses for `grayscale`, which the spec writes out as a literal
    /// matrix in the sRGB primaries. Chromium implements both literally and so does the shipped
    /// Kotlin, so both triples belong in this file. Reusing `saturate(1 - a)` for grayscale, as the
    /// iOS design doc does, is off by 0.05 of a code value: harmless in itself, but this is the file
    /// the next person copies from.
    private static let gr = 0.2126, gg = 0.7152, gb = 0.0722

    static func matrix(for op: FilterOp) -> ColorMatrix {
        switch op {
        case .brightness(let a):
            return ColorMatrix(m: [a, 0, 0, 0, a, 0, 0, 0, a], b: [0, 0, 0])

        case .contrast(let a):
            let t = 0.5 - 0.5 * a
            return ColorMatrix(m: [a, 0, 0, 0, a, 0, 0, 0, a], b: [t, t, t])

        // Every row sums to exactly 1 at any `s`, so grey is a fixed point of saturate. Worth an
        // assertion in the tests: it catches a transposed or mistyped weight immediately.
        case .saturate(let s):
            return ColorMatrix(m: [
                lr + (1 - lr) * s, lg - lg * s,       lb - lb * s,
                lr - lr * s,       lg + (1 - lg) * s, lb - lb * s,
                lr - lr * s,       lg - lg * s,       lb + (1 - lb) * s,
            ], b: [0, 0, 0])

        case .grayscale(let a):
            let s = 1 - a
            return ColorMatrix(m: [
                gr + (1 - gr) * s, gg - gg * s,       gb - gb * s,
                gr - gr * s,       gg + (1 - gg) * s, gb - gb * s,
                gr - gr * s,       gg - gg * s,       gb + (1 - gb) * s,
            ], b: [0, 0, 0])

        case .sepia(let a):
            let s = 1 - a
            return ColorMatrix(m: [
                0.393 + 0.607 * s, 0.769 - 0.769 * s, 0.189 - 0.189 * s,
                0.349 - 0.349 * s, 0.686 + 0.314 * s, 0.168 - 0.168 * s,
                0.272 - 0.272 * s, 0.534 - 0.534 * s, 0.131 + 0.869 * s,
            ], b: [0, 0, 0])

        // The three coefficients +0.143, +0.140 and -0.283 are NOT derived from lr/lg/lb. They are
        // spec constants of the hue-rotate matrix; do not "simplify" them into the weights.
        case .hueRotate(let degrees):
            let rad = degrees * .pi / 180
            let c = cos(rad), n = sin(rad)
            return ColorMatrix(m: [
                lr + 0.787 * c - lr * n, lg - lg * c - lg * n,       lb - lb * c + 0.928 * n,
                lr - lr * c + 0.143 * n, lg + 0.285 * c + 0.140 * n, lb - lb * c - 0.283 * n,
                lr - lr * c - 0.787 * n, lg - lg * c + lg * n,       lb + 0.928 * c + lb * n,
            ], b: [0, 0, 0])

        // A source-over fill of rgba(r, g, b, alpha), which is literally what the web preview paints
        // over the filtered video. CSS has no tint function, which is why it is a custom op.
        case .tint(let r, let g, let bl, let alpha):
            let keep = 1 - alpha
            return ColorMatrix(m: [keep, 0, 0, 0, keep, 0, 0, 0, keep],
                               b: [alpha * Double(r) / 255,
                                   alpha * Double(g) / 255,
                                   alpha * Double(bl) / 255])
        }
    }
}

extension ColorMatrix {

    /// `CIColorMatrix` computes `s.r = dot(s, RVector)` for each channel and then adds
    /// `biasVector`, so the three RGB rows go in the xyz of the colour vectors with `w = 0`, alpha
    /// passes through with `AVector = (0, 0, 0, 1)`, and the bias carries no alpha term. That is the
    /// exact iOS spelling of the GL shader Android runs.
    ///
    /// The clamp is not optional. Core Image runs a float pipeline while CSS clamps after every op,
    /// and an out-of-range intermediate survives the letterbox composite and every overlay blend
    /// before the 8-bit write finally clips it: a base pixel at 1.3 under a 50 % overlay comes out
    /// `0.5 * overlay + 0.65` instead of `0.5 * overlay + 0.5`. `vivid` on saturated blue and `noir`
    /// on anything bright both reach here with shipped presets.
    func apply(to image: CIImage) -> CIImage {
        guard !isIdentity else { return image }
        let matrixed = image.applyingFilter("CIColorMatrix", parameters: [
            "inputRVector": CIVector(x: CGFloat(m[0]), y: CGFloat(m[1]), z: CGFloat(m[2]), w: 0),
            "inputGVector": CIVector(x: CGFloat(m[3]), y: CGFloat(m[4]), z: CGFloat(m[5]), w: 0),
            "inputBVector": CIVector(x: CGFloat(m[6]), y: CGFloat(m[7]), z: CGFloat(m[8]), w: 0),
            "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 1),
            "inputBiasVector": CIVector(x: CGFloat(b[0]), y: CGFloat(b[1]), z: CGFloat(b[2]), w: 0),
        ])
        // These are already CIColorClamp's defaults; they are passed so the intent is on the page.
        let clamped = matrixed.applyingFilter("CIColorClamp", parameters: [
            "inputMinComponents": CIVector(x: 0, y: 0, z: 0, w: 0),
            "inputMaxComponents": CIVector(x: 1, y: 1, z: 1, w: 1),
        ])
        // A non-zero bias is defined over the infinite plane, so the filter widens the extent to
        // infinity. Cropping back keeps the placement maths in `Placement.place` reading a real
        // frame rectangle instead of an infinite one.
        return clamped.cropped(to: image.extent)
    }
}
