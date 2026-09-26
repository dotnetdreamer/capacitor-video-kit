import CoreVideo
import Foundation

/// The pictures of painter-optical-flow.cmp.test.ts, drawn the same way: the same little generator
/// (mulberry32), the same random cells, the same square, as RGBA8 arrays instead of canvases.
struct Picture {
    let width: Int
    let height: Int
    var rgba: [UInt8]

    init(width: Int, height: Int, rgba: [UInt8]? = nil) {
        self.width = width
        self.height = height
        self.rgba = rgba ?? [UInt8](repeating: 255, count: width * height * 4)
    }

    /// `random(seed)` in the TypeScript test: mulberry32, bit for bit.
    static func random(_ seed: UInt32) -> () -> Double {
        var s = seed
        return {
            s = s &+ 0x6d2b79f5
            var t = s
            t = (t ^ (t >> 15)) &* (t | 1)
            t ^= t &+ ((t ^ (t >> 7)) &* (t | 61))
            return Double(t ^ (t >> 14)) / 4294967296
        }
    }

    /// `texture(seed, width, height, cell, low, high)`: cells of random colour between `low` and `high`,
    /// the three channels drawn in r, g, b order per cell, cells row by row - as the canvas version fills them.
    static func texture(_ seed: UInt32, _ width: Int, _ height: Int, _ cell: Int, _ low: Int = 0, _ high: Int = 255) -> Picture {
        var picture = Picture(width: width, height: height)
        let next = random(seed)
        for y in stride(from: 0, to: height, by: cell) {
            for x in stride(from: 0, to: width, by: cell) {
                let channel = { UInt8(Double(low) + (next() * Double(high - low + 1)).rounded(.down)) }
                let r = channel(), g = channel(), b = channel()
                picture.fill(x: x, y: y, width: cell, height: cell, r: r, g: g, b: b)
            }
        }
        return picture
    }

    mutating func fill(x: Int, y: Int, width w: Int, height h: Int, r: UInt8, g: UInt8, b: UInt8) {
        for yy in max(0, y)..<min(height, y + h) {
            for xx in max(0, x)..<min(width, x + w) {
                let i = (yy * width + xx) * 4
                rgba[i] = r
                rgba[i + 1] = g
                rgba[i + 2] = b
                rgba[i + 3] = 255
            }
        }
    }

    /// `other` drawn with its top-left corner at (x, y), clipped.
    mutating func draw(_ other: Picture, x: Int, y: Int) {
        for yy in 0..<other.height where y + yy >= 0 && y + yy < height {
            for xx in 0..<other.width where x + xx >= 0 && x + xx < width {
                let from = (yy * other.width + xx) * 4
                let to = ((y + yy) * width + x + xx) * 4
                for c in 0..<4 { rgba[to + c] = other.rgba[from + c] }
            }
        }
    }

    /// Rows `top ..< top + height` of this picture.
    func rows(from top: Int, count: Int) -> Picture {
        Picture(width: width, height: count, rgba: Array(rgba[(top * width * 4)..<((top + count) * width * 4)]))
    }

    /// Columns `left ..< left + count` of this picture.
    func columns(from left: Int, count: Int) -> Picture {
        var out = Picture(width: count, height: height)
        for y in 0..<height {
            for x in 0..<count {
                for c in 0..<4 { out.rgba[(y * count + x) * 4 + c] = rgba[(y * width + left + x) * 4 + c] }
            }
        }
        return out
    }

    var pixelBuffer: CVPixelBuffer { TestPixels.buffer(rgba: rgba, width: width, height: height)! }

    init(_ buffer: CVPixelBuffer) {
        self.init(width: CVPixelBufferGetWidth(buffer), height: CVPixelBufferGetHeight(buffer), rgba: TestPixels.rgba(buffer))
    }
}

/// The mean difference over every colour channel of every pixel (`meanDifference` in the TypeScript test).
func meanDifference(_ a: Picture, _ b: Picture) -> Double {
    regionDifference(a, b, 0, 0, a.width, a.height)
}

/// The same over a rectangle only (`regionDifference`).
func regionDifference(_ a: Picture, _ b: Picture, _ x0: Int, _ y0: Int, _ w: Int, _ h: Int) -> Double {
    var sum = 0
    for y in y0..<(y0 + h) {
        for x in x0..<(x0 + w) {
            let i = (y * a.width + x) * 4
            for c in 0..<3 { sum += abs(Int(a.rgba[i + c]) - Int(b.rgba[i + c])) }
        }
    }
    return Double(sum) / Double(w * h * 3)
}

/// The largest difference of any channel of any pixel (`largestDifference`).
func largestDifference(_ a: Picture, _ b: Picture) -> Int {
    var most = 0
    for i in 0..<a.rgba.count { most = max(most, abs(Int(a.rgba[i]) - Int(b.rgba[i]))) }
    return most
}

/// 32BGRA pixel buffers to and from tightly packed RGBA8, byte for byte and with no colour conversion
/// either way, for the tests that hand the flow pictures and read its answers back.
enum TestPixels {

    /// An IOSurface-backed, Metal-compatible 32BGRA buffer: what the compositor's frame source hands the
    /// flow, and what its texture cache can wrap without a copy.
    static func buffer(width: Int, height: Int) -> CVPixelBuffer? {
        let attributes: [CFString: Any] = [
            kCVPixelBufferIOSurfacePropertiesKey: [:] as [CFString: Any],
            kCVPixelBufferMetalCompatibilityKey: true,
        ]
        var buffer: CVPixelBuffer?
        guard CVPixelBufferCreate(kCFAllocatorDefault, width, height, kCVPixelFormatType_32BGRA,
                                  attributes as CFDictionary, &buffer) == kCVReturnSuccess else { return nil }
        return buffer
    }

    /// `rgba` (tightly packed RGBA8, rows top first) in a new 32BGRA buffer.
    static func buffer(rgba: [UInt8], width: Int, height: Int) -> CVPixelBuffer? {
        guard rgba.count == width * height * 4, let buffer = buffer(width: width, height: height) else { return nil }
        CVPixelBufferLockBaseAddress(buffer, [])
        defer { CVPixelBufferUnlockBaseAddress(buffer, []) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return nil }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let i = (y * width + x) * 4
                row[x * 4] = rgba[i + 2]
                row[x * 4 + 1] = rgba[i + 1]
                row[x * 4 + 2] = rgba[i]
                row[x * 4 + 3] = rgba[i + 3]
            }
        }
        return buffer
    }

    /// The buffer's pixels as tightly packed RGBA8, rows top first. Row padding is skipped.
    static func rgba(_ buffer: CVPixelBuffer) -> [UInt8] {
        let width = CVPixelBufferGetWidth(buffer), height = CVPixelBufferGetHeight(buffer)
        CVPixelBufferLockBaseAddress(buffer, .readOnly)
        defer { CVPixelBufferUnlockBaseAddress(buffer, .readOnly) }
        guard let base = CVPixelBufferGetBaseAddress(buffer) else { return [] }
        let rowBytes = CVPixelBufferGetBytesPerRow(buffer)
        var out = [UInt8](repeating: 0, count: width * height * 4)
        for y in 0..<height {
            let row = base.advanced(by: y * rowBytes).assumingMemoryBound(to: UInt8.self)
            for x in 0..<width {
                let i = (y * width + x) * 4
                out[i] = row[x * 4 + 2]
                out[i + 1] = row[x * 4 + 1]
                out[i + 2] = row[x * 4]
                out[i + 3] = row[x * 4 + 3]
            }
        }
        return out
    }
}
