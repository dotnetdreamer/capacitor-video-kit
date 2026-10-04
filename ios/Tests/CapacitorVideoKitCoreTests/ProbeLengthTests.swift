@preconcurrency import AVFoundation
import Foundation
import XCTest
@testable import CapacitorVideoKitCore

/// How long `Thumbnailer.probe` says a file is: a sound to the end of its audio TRACK, and anything
/// with a picture to the end of the asset, as it always was.
///
/// WHY A SOUND IS MEASURED BY ITS TRACK. AVFoundation reads the seeded 12 s tone, `qa-sample.m4a`
/// (ffmpeg's AAC: 1024 samples of priming trimmed by an edit list, and a roll sample group), as an
/// asset of 11975 ms whose one audio track runs the full 12000 ms the edit list presents - it takes
/// the asset's length as the track's less the 2112 samples of priming its own encoder would have put
/// there, where this file has 1024. The render loops music at the track's end
/// (`CompositionBuilder.audioSource`) and the editor lays a picked sound's loop at `probe`'s answer,
/// so the two have to be the same number; answered with the asset's, the preview's loop came round
/// 25 ms a pass ahead of the render's. A file with a picture keeps the asset's length: that is the
/// clip's length on the timeline, and a video whose sound stops early is still as long as its
/// picture.
///
/// The sound here is made the way AVFoundation writes one and then rewritten the way ffmpeg writes
/// one, because a file AVFoundation wrote reads the same both ways and could not tell the two rules
/// apart. Measured on 2026-09-29 with the same rewrite on the Mac's AVFoundation: 1500 ms of tone reads
/// as an asset of 1475 ms and a track of 1500, as the seed reads 11975 and 12000.
final class ProbeLengthTests: RenderTestCase {

    /// 1.5 s at 44.1 kHz, the length of the tone every test here writes.
    private let toneSamples = 66_150

    func testASoundIsAsLongAsItsAudioTrackWhereTheAssetReadsShort() async throws {
        let url = try await TestMedia.sound(file("tone.m4a"), durationMs: 1500)
        try FfmpegStyleSound.rewrite(url, primingSamples: 1024, presentedSamples: toneSamples)

        // The file is the kind the test is about: AVFoundation's two lengths for it disagree.
        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let assetMs = msOf(try await asset.load(.duration))
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        let track = try XCTUnwrap(tracks.first)
        let trackEndMs = msOf(try await track.load(.timeRange).end)
        XCTAssertEqual(trackEndMs, 1500, "the edit list presents 1.5 s")
        XCTAssertLessThan(assetMs, trackEndMs, "AVFoundation was expected to read the asset short of its track, as it reads qa-sample.m4a")

        let probed = try await Thumbnailer.probe(url)
        XCTAssertEqual(probed.durationMs, 1500, "the audio track's end, where the render loops it, not the asset's \(assetMs)")
        XCTAssertTrue(probed.hasAudio)
        XCTAssertFalse(probed.hasVideo)
        XCTAssertEqual(probed.width, 0)
        XCTAssertEqual(probed.height, 0)
    }

    func testASoundAVFoundationWroteIsItsOwnLength() async throws {
        let url = try await TestMedia.sound(file("tone.m4a"), durationMs: 1500)

        let probed = try await Thumbnailer.probe(url)
        XCTAssertEqual(probed.durationMs, 1500)
        XCTAssertTrue(probed.hasAudio)
        XCTAssertFalse(probed.hasVideo)
    }

    /// A clip whose sound stops half way is as long as its picture: the rule for a sound is for a file
    /// with no picture at all.
    func testAVideoIsAsLongAsTheAssetEvenWhereItsSoundEndsFirst() async throws {
        let url = try await TestMedia.video(file("clip.mp4"), durationMs: 1000, color: .red, soundMs: 500)

        let asset = AVURLAsset(url: url, options: [AVURLAssetPreferPreciseDurationAndTimingKey: true])
        let assetMs = msOf(try await asset.load(.duration))
        let tracks = try await asset.loadTracks(withMediaType: .audio)
        let track = try XCTUnwrap(tracks.first)
        let soundEndMs = msOf(try await track.load(.timeRange).end)
        XCTAssertLessThan(soundEndMs, 900, "the file's sound was meant to stop before its picture")

        let probed = try await Thumbnailer.probe(url)
        XCTAssertEqual(probed.durationMs, assetMs)
        XCTAssertEqual(probed.durationMs, 1000)
        XCTAssertTrue(probed.hasVideo)
        XCTAssertTrue(probed.hasAudio)
        XCTAssertEqual(probed.width, 320)
        XCTAssertEqual(probed.height, 240)
    }
}

/// Rewrites an `.m4a` that `TestMedia.sound` wrote into the kind ffmpeg writes, which is most sounds
/// anybody picks: the priming trimmed by an edit list instead of an iTunSMPB note, the movie and the
/// track as long as the edit list, and a roll sample group (every AAC frame needs the one before it).
/// The roll group is what makes AVFoundation read the track to the end of the edit list - without
/// it the track reads as short as the asset (measured) - so the rewrite has all three, as ffmpeg's
/// files do.
///
/// Only the header moves. AVAssetWriter puts `moov` after `mdat`, so the boxes put into it shift no
/// sample's offset; that is checked, not assumed.
private enum FfmpegStyleSound {
    private struct Box {
        let type: String
        let at: Int
        let size: Int
    }

    static func rewrite(_ url: URL, primingSamples: Int, presentedSamples: Int) throws {
        var d = try Data(contentsOf: url)

        func u32(_ at: Int) -> Int { d[at..<at + 4].reduce(0) { $0 << 8 | Int($1) } }
        func be32(_ v: Int) -> Data { withUnsafeBytes(of: UInt32(truncatingIfNeeded: v).bigEndian) { Data($0) } }
        func box(_ type: String, _ body: Data) -> Data { be32(8 + body.count) + Data(type.utf8) + body }
        /// The boxes directly inside the bytes from `from` to `to`.
        func children(_ from: Int, _ to: Int) -> [Box] {
            var out: [Box] = []
            var at = from
            while at + 8 <= to {
                var size = u32(at)
                // A 64-bit size, which is how AVAssetWriter writes its `mdat`.
                if size == 1 { size = u32(at + 8) << 32 | u32(at + 12) }
                out.append(Box(type: String(decoding: d[at + 4..<at + 8], as: UTF8.self), at: at, size: size))
                guard size >= 8 else { break }
                at += size
            }
            return out
        }
        /// Every box down `path`, the outermost first.
        func chain(_ path: [String]) throws -> [Box] {
            var out: [Box] = []
            var (from, to) = (0, d.count)
            for type in path {
                guard let found = children(from, to).first(where: { $0.type == type }) else { throw TestError("no \(type) in \(url.lastPathComponent)") }
                out.append(found)
                (from, to) = (found.at + 8, found.at + found.size)
            }
            return out
        }
        /// `bytes` put in at `at`, and every box in `ancestors` grown by as much.
        func insert(_ bytes: Data, at: Int, into ancestors: [Box]) {
            d.insert(contentsOf: bytes, at: at)
            for ancestor in ancestors { d.replaceSubrange(ancestor.at..<ancestor.at + 4, with: be32(ancestor.size + bytes.count)) }
        }

        let moov = try chain(["moov"])[0]
        guard moov.at + moov.size == d.count else { throw TestError("moov is not last, so growing it would move the samples") }

        // No iTunSMPB: the `udta` that holds it becomes padding of the same size.
        if let udta = children(moov.at + 8, moov.at + moov.size).first(where: { $0.type == "udta" }) {
            d.replaceSubrange(udta.at + 4..<udta.at + 8, with: Data("free".utf8))
        }

        // The movie and the track as long as the edit list will present, in the movie's timescale.
        let mvhd = try chain(["moov", "mvhd"])[1]
        let tkhd = try chain(["moov", "trak", "tkhd"])[2]
        guard d[mvhd.at + 8] == 0, d[tkhd.at + 8] == 0 else { throw TestError("a version 1 mvhd or tkhd, which this does not rewrite") }
        let movieScale = u32(mvhd.at + 20)
        let presented = presentedSamples * movieScale / 44_100
        d.replaceSubrange(mvhd.at + 24..<mvhd.at + 28, with: be32(presented))
        d.replaceSubrange(tkhd.at + 28..<tkhd.at + 32, with: be32(presented))

        // The roll group, at the end of the sample table: one entry, a roll of -1, for every frame.
        let stbl = try chain(["moov", "trak", "mdia", "minf", "stbl"])
        let stsz = try chain(["moov", "trak", "mdia", "minf", "stbl", "stsz"]).last!
        let frames = u32(stsz.at + 16)
        let sgpd = box("sgpd", Data([1, 0, 0, 0]) + Data("roll".utf8) + be32(2) + be32(1) + Data([0xFF, 0xFF]))
        let sbgp = box("sbgp", Data([0, 0, 0, 0]) + Data("roll".utf8) + be32(1) + be32(frames) + be32(1))
        insert(sgpd + sbgp, at: stbl.last!.at + stbl.last!.size, into: stbl)

        // The edit list, straight after the track header: the priming skipped, then what is heard.
        let track = try chain(["moov", "trak", "tkhd"])
        let elst = box("elst", Data([0, 0, 0, 0]) + be32(1) + be32(presented) + be32(primingSamples) + be32(0x0001_0000))
        insert(box("edts", elst), at: track[2].at + track[2].size, into: Array(track.prefix(2)))

        try d.write(to: url)
    }
}
