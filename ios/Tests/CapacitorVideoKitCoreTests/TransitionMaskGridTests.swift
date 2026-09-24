import Foundation
import XCTest
@testable import CapacitorVideoKitCore

/// `TransitionMath.maskGrid` works each frame's constants out once and fills its rows in parallel.
/// Neither may move a single cell: every grid here is compared byte for byte against the reference,
/// which is `maskAlpha` - the line-for-line port of transitions.ts - asked cell by cell, in order,
/// exactly as `maskGrid` used to.
final class TransitionMaskGridTests: XCTestCase {

    /// The grid as it was built before the constants were hoisted: one `maskAlpha` per cell.
    private func reference(_ mask: ComposeTransitionMask, reveal: Double, w: Double, h: Double,
                           longSide: Int = TransitionMath.maskGridLongSide) -> TransitionMath.MaskGrid {
        let k = min(1, Double(max(1, longSide)) / max(w, h, 1))
        let columns = max(1, Int((w * k).rounded()))
        let rows = max(1, Int((h * k).rounded()))
        let cellW = w / Double(columns)
        let cellH = h / Double(rows)
        var values = [UInt8](repeating: 0, count: columns * rows)
        for row in 0..<rows {
            let qy = (Double(row) + 0.5) * cellH
            for column in 0..<columns {
                let qx = (Double(column) + 0.5) * cellW
                let m = TransitionMath.maskAlpha(mask, reveal, qx, qy, w, h)
                let unit = m >= 0 ? min(1, m) : 0
                values[row * columns + column] = UInt8((unit * 255).rounded())
            }
        }
        return TransitionMath.MaskGrid(columns: columns, rows: rows, values: values)
    }

    private static let shapes: [ComposeTransitionMask.Shape] = [.linear, .circle, .diamond, .clock, .blinds, .split]

    private func assertSame(_ mask: ComposeTransitionMask, reveal: Double, w: Double, h: Double, longSide: Int,
                            file: StaticString = #filePath, line: UInt = #line) {
        let got = TransitionMath.maskGrid(mask, reveal: reveal, width: w, height: h, longSide: longSide)
        let want = reference(mask, reveal: reveal, w: w, h: h, longSide: longSide)
        XCTAssertEqual(got.columns, want.columns, file: file, line: line)
        XCTAssertEqual(got.rows, want.rows, file: file, line: line)
        XCTAssertTrue(got.values == want.values,
                      "\(mask.shape) at \(mask.angleDeg) deg, invert \(mask.invert), reveal \(reveal), \(w)x\(h)",
                      file: file, line: line)
    }

    /// Every shape, angle, direction and reveal, on a coarser grid so the sweep stays quick: the
    /// cells still sit at the output pixels of a real 1080x1920 or 1920x1080 frame, and a render
    /// smaller than the grid is evaluated at its own size.
    func testEveryShapeMatchesTheReferenceCellForCell() {
        let sizes: [(Double, Double)] = [(1080, 1920), (1920, 1080), (150, 85)]
        for shape in Self.shapes {
            for angle in [0.0, 37, 90, 180, 270] {
                for invert in [false, true] {
                    for reveal in [0.0, 0.37, 1] {
                        for (w, h) in sizes {
                            let mask = ComposeTransitionMask(shape: shape, angleDeg: angle, count: 7,
                                                             feather: 0.08, invert: invert)
                            assertSame(mask, reveal: reveal, w: w, h: h, longSide: 120)
                        }
                    }
                }
            }
        }
    }

    /// And every shape once at the grid the compositor really uses.
    func testEveryShapeMatchesTheReferenceAtTheRealGrid() {
        for shape in Self.shapes {
            let mask = ComposeTransitionMask(shape: shape, angleDeg: 37, count: 7, feather: 0.08, invert: false)
            assertSame(mask, reveal: 0.37, w: 1080, h: 1920, longSide: TransitionMath.maskGridLongSide)
        }
    }

    /// The feather's clamp and a reveal outside 0...1 go through the same arithmetic as the port.
    func testClampedFeatherAndRevealMatchTheReference() {
        for feather in [0.0, 0.0005, 0.5, 2] {
            for reveal in [-0.5, 1.5, 0.5] {
                let mask = ComposeTransitionMask(shape: .linear, angleDeg: 123, count: 1,
                                                 feather: feather, invert: false)
                let got = TransitionMath.maskGrid(mask, reveal: reveal, width: 720, height: 1280)
                XCTAssertTrue(got.values == reference(mask, reveal: reveal, w: 720, h: 1280).values,
                              "feather \(feather), reveal \(reveal)")
            }
        }
    }

    /// A third of a second of a masked transition at 30 fps on a 1080x1920 post, through `maskGrid`...
    func testMaskGridSpeed() {
        let mask = ComposeTransitionMask(shape: .circle, angleDeg: 37, count: 1, feather: 0.08, invert: false)
        measure {
            for i in 0..<10 {
                _ = TransitionMath.maskGrid(mask, reveal: Double(i) / 9, width: 1080, height: 1920)
            }
        }
    }

    /// ...and through the per-cell reference, for comparison.
    func testReferenceSpeed() {
        let mask = ComposeTransitionMask(shape: .circle, angleDeg: 37, count: 1, feather: 0.08, invert: false)
        measure {
            for i in 0..<10 {
                _ = reference(mask, reveal: Double(i) / 9, w: 1080, h: 1920)
            }
        }
    }
}
