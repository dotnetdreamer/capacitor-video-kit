@preconcurrency import AVFoundation
import Foundation
import ImageIO
import XCTest
@testable import CapacitorVideoKitCore

/// Which frame each filmstrip tile is: the one at its time, whatever `precise` says.
///
/// The editor asks for `precise: false` on any clip longer than six tiles, and that used to cut the
/// keyframe NEAREST each time - seconds from it either way in footage keyed far apart, so the strip
/// showed a shot a tile or two before the preview reached it. The clip here is that footage at its
/// plainest: a new colour every second and a keyframe every ten, so a keyframe strip repeats one
/// colour across most of its tiles, and every tile of an exact one is its own second's colour.
///
/// Each colour runs from half a second before its second to half a second after, so a tile's time
/// is the middle of a run: the first frame after a hard cut is the one an encoder codes worst, and
/// a test of which frame was cut should not be a test of how well it was coded.
final class FilmstripFramesTests: RenderTestCase {

    /// One colour per second, any two of them at least 127 apart on some channel. A tile comes back
    /// up to about 75 off on a channel (a frame this small is converted with another colour matrix
    /// than it was written with: green reads rgb(67,250,0)), so it is read as the NEAREST of them.
    private let seconds: [TestMedia.RGB] = [
        .red, .green, .blue, .white, .black,
        TestMedia.RGB(r: 255, g: 255, b: 0), TestMedia.RGB(r: 0, g: 255, b: 255),
        TestMedia.RGB(r: 255, g: 0, b: 255), TestMedia.RGB(r: 255, g: 128, b: 0),
        TestMedia.RGB(r: 128, g: 0, b: 255), TestMedia.RGB(r: 0, g: 128, b: 128),
        TestMedia.RGB(r: 128, g: 128, b: 128),
    ]

    func testEveryTileIsItsOwnSecondWhereKeyframesAreTenSecondsApart() async throws {
        let width = 192, height = 108, fps: Int32 = 30
        let url = try await TestMedia.frames(
            file("seconds.mp4"), width: width, height: height,
            times: TestMedia.evenTimes(seconds.count * Int(fps), fps: fps), reorder: true,
            compression: [AVVideoMaxKeyFrameIntervalKey: 10 * Int(fps), AVVideoMaxKeyFrameIntervalDurationKey: 10]
        ) { [seconds] i in
            let c = seconds[min(seconds.count - 1, (i + Int(fps) / 2) / Int(fps))]
            return (0..<(width * height)).flatMap { _ in [UInt8(c.r), UInt8(c.g), UInt8(c.b), 255] }
        }
        // The clip is the kind the test is about: no keyframe between 0 and 10 s, where a keyframe
        // strip would have shown the first second's colour or the eleventh's.
        let keyframes = try await keyframeTimesMs(url)
        XCTAssertEqual(keyframes.first, 0)
        XCTAssertEqual(keyframes.filter { $0 > 0 && $0 < 10_000 }, [], "keyframes at \(keyframes)")

        let times = (0..<seconds.count).map { Int64($0) * 1000 }
        let tiles = try await Thumbnailer.thumbnails(url, timesMs: times, maxHeight: 64, precise: false)
        defer { for tile in Set(tiles) { try? FileManager.default.removeItem(at: tile) } }

        XCTAssertEqual(tiles.count, times.count)
        let colors = try tiles.map(centreColor(of:))
        XCTAssertEqual(colors.map(nearestSecond(to:)), Array(seconds.indices), "the tiles' colours: \(colors)")
        for (tile, timeMs) in zip(tiles, times) {
            // Under the name a precise tile has, never the plain one older builds cut keyframes under.
            XCTAssertTrue(tile.lastPathComponent.hasSuffix("-\(timeMs)-64-p.jpg"), tile.lastPathComponent)
        }

        // Asked for precisely, the same tiles, straight from the cache.
        let precise = try await Thumbnailer.thumbnails(url, timesMs: times, maxHeight: 64, precise: true)
        XCTAssertEqual(precise, tiles)
    }

    /// The presentation times of the clip's sync samples, read off the compressed track, from its
    /// first frame: the media's own times start a frame late in a file with B-frames, where the edit
    /// list brings them back to zero.
    private func keyframeTimesMs(_ url: URL) async throws -> [Int64] {
        let asset = AVURLAsset(url: url)
        let tracks = try await asset.loadTracks(withMediaType: .video)
        let track = try XCTUnwrap(tracks.first)
        let reader = try AVAssetReader(asset: asset)
        let output = AVAssetReaderTrackOutput(track: track, outputSettings: nil)
        reader.add(output)
        guard reader.startReading() else { throw reader.error ?? TestError("startReading") }
        var times: [Int64] = []
        var first = Int64.max
        while let sample = output.copyNextSampleBuffer() {
            guard CMSampleBufferGetNumSamples(sample) > 0 else { continue }
            let time = msOf(CMSampleBufferGetPresentationTimeStamp(sample))
            first = min(first, time)
            let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
            let notSync = attachments?.first?[kCMSampleAttachmentKey_NotSync] as? Bool ?? false
            if !notSync { times.append(time) }
        }
        return times.map { $0 - first }.sorted()
    }

    /// The tile's colour, averaged over a 5x5 square at its centre, in sRGB.
    private func centreColor(of tile: URL) throws -> TestMedia.RGB {
        guard let source = CGImageSourceCreateWithURL(tile as CFURL, nil),
              let image = CGImageSourceCreateImageAtIndex(source, 0, nil) else { throw TestError("unreadable tile \(tile.lastPathComponent)") }
        let w = image.width, h = image.height
        var pixels = [UInt8](repeating: 0, count: w * h * 4)
        guard let ctx = CGContext(data: &pixels, width: w, height: h, bitsPerComponent: 8, bytesPerRow: w * 4,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { throw TestError("context") }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: w, height: h))
        var r = 0, g = 0, b = 0, n = 0
        for y in (h / 2 - 2)...(h / 2 + 2) {
            for x in (w / 2 - 2)...(w / 2 + 2) {
                let i = (y * w + x) * 4
                r += Int(pixels[i]); g += Int(pixels[i + 1]); b += Int(pixels[i + 2]); n += 1
            }
        }
        return TestMedia.RGB(r: r / n, g: g / n, b: b / n)
    }

    /// Which second's colour `c` is nearest, or -1 for one that is far from all of them.
    private func nearestSecond(to c: TestMedia.RGB) -> Int {
        func distance(_ s: TestMedia.RGB) -> Int { max(abs(s.r - c.r), abs(s.g - c.g), abs(s.b - c.b)) }
        let best = seconds.indices.min { distance(seconds[$0]) < distance(seconds[$1]) }!
        return distance(seconds[best]) < 90 ? best : -1
    }
}
