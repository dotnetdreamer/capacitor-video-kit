import Foundation
import XCTest
@testable import CapacitorVideoKitCore

/// The matte track is a file three engines read and three write - the editor's preview reads the one
/// this side writes - so its layout is held here byte for byte, case for case with
/// `src/editor/matte-track.unit.test.ts` and Android's `MatteTrackTest.kt`: the header, the JSON, the
/// tables, the packets, the same refusals and the same mix of two frames. Then the pieces of `findMatte`
/// that are arithmetic: the grid, the summary, the smoothing and the reading of a mask onto the grid.
final class MatteTrackTests: XCTestCase {

    /// The reference tests' `META`.
    private let meta = MatteTrackMeta(engine: "mlkit", kind: "video", target: "subject", durationMs: 1000, fps: 10,
                                      coverage: 0.5, box: MatteBox(x: 0, y: 0, w: 0.5, h: 1))

    /// `JSON.stringify(META)` in the TS test: what every engine writes for it, key for key.
    private let metaJSON = #"{"engine":"mlkit","kind":"video","target":"subject","durationMs":1000,"fps":10,"coverage":0.5,"box":{"x":0,"y":0,"w":0.5,"h":1}}"#

    /// A 4x2 grid: the left half `left`, the right half `right`.
    private func halves(_ left: UInt8, _ right: UInt8) -> [UInt8] {
        [left, left, right, right, left, left, right, right]
    }

    private func encoded(times: [Double], frames: [[UInt8]], meta: MatteTrackMeta? = nil) throws -> Data {
        try MatteTrack.encode(MatteTrackContent(width: 4, height: 2, times: times, frames: frames, meta: meta ?? self.meta))
    }

    private func u16(_ b: [UInt8], _ at: Int) -> Int { Int(b[at]) | Int(b[at + 1]) << 8 }
    private func u32(_ b: [UInt8], _ at: Int) -> Int {
        Int(b[at]) | Int(b[at + 1]) << 8 | Int(b[at + 2]) << 16 | Int(b[at + 3]) << 24
    }
    private func put16(_ b: inout [UInt8], _ at: Int, _ v: Int) {
        b[at] = UInt8(v & 0xff); b[at + 1] = UInt8((v >> 8) & 0xff)
    }
    private func put32(_ b: inout [UInt8], _ at: Int, _ v: Int) {
        for k in 0..<4 { b[at + k] = UInt8((v >> (8 * k)) & 0xff) }
    }
    private func le32(_ v: Int) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * $0)) & 0xff) } }

    private func assertRefused(_ bytes: [UInt8], _ words: String? = nil, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try MatteTrack.parse(Data(bytes)), file: file, line: line) { error in
            guard let refused = error as? MatteTrackError else {
                return XCTFail("not a MatteTrackError: \(error)", file: file, line: line)
            }
            if let words { XCTAssertTrue(refused.description.contains(words), refused.description, file: file, line: line) }
        }
    }

    // MARK: - Packets

    func testCodesARunOfThreeOrMoreAsItsCountAndItsByteAndTheRestAsLiterals() {
        XCTAssertEqual(MatteTrack.encodePackets([0, 0, 0, 0]), [9, 0])
        XCTAssertEqual(MatteTrack.encodePackets([10, 20, 30]), [6, 10, 20, 30])
        // Two the same are not worth a run: they ride in the literals either side.
        XCTAssertEqual(MatteTrack.encodePackets([5, 5, 255, 255, 255, 255, 7]), [4, 5, 5, 9, 255, 2, 7])
    }

    func testWritesCountsPast63AsLEB128() {
        // 300 << 1 | 1 = 601 = 0b100_1011001: 0xD9 (89 | 0x80), then 4.
        XCTAssertEqual(MatteTrack.encodePackets([UInt8](repeating: 255, count: 300)), [0xd9, 4, 255])
    }

    func testDecodesExactlyWhatItCodedEdgesAndAll() throws {
        let cells: [UInt8] = (0..<5000).map { i in
            let x = i % 100
            return x < 40 ? 0 : (x > 60 ? 255 : UInt8(jsRound(Double(x - 40) / 20 * 255)))
        }
        let packets = MatteTrack.encodePackets(cells)
        var out = [UInt8](repeating: 0, count: cells.count)
        try MatteTrack.decodePackets(packets, start: 0, end: packets.count, into: &out)
        XCTAssertEqual(out, cells)
        // The two ends ride in runs, so the frame costs about its soft edge and a few bytes a row.
        XCTAssertLessThan(packets.count, cells.count / 3)
    }

    func testRefusesPacketsThatStopShortOverrunLeaveBytesOverOrStopInAVarint() {
        var out = [UInt8](repeating: 0, count: 4)
        // A run of 3 into 4 cells: short. A run of 5: over. A count of 0. Four literals promised, two
        // given. A run with no byte to repeat. A varint that never ends.
        for bad: [UInt8] in [[7, 1], [11, 1], [1, 1, 9, 1], [8, 1, 2], [9], [0x89]] {
            XCTAssertThrowsError(try MatteTrack.decodePackets(bad, start: 0, end: bad.count, into: &out), "\(bad)") {
                XCTAssertTrue($0 is MatteTrackError)
            }
            XCTAssertThrowsError(try MatteTrack.checkPackets(bad, start: 0, end: bad.count, cells: 4), "\(bad)")
        }
    }

    // MARK: - The file

    func testLaysOutTheHeaderTheJSONTheTimesTheOffsetsAndTheFrames() throws {
        let bytes = [UInt8](try encoded(times: [0, 100], frames: [halves(255, 0), halves(0, 255)]))
        XCTAssertEqual(String(decoding: bytes[0..<4], as: UTF8.self), "VKMT")
        XCTAssertEqual(bytes[4], 1)
        XCTAssertEqual(bytes[5], 0)
        XCTAssertEqual(u16(bytes, 6), 4)
        XCTAssertEqual(u16(bytes, 8), 2)
        XCTAssertEqual(u16(bytes, 10), 0)
        XCTAssertEqual(u32(bytes, 12), 2)
        let json = u32(bytes, 16)
        XCTAssertEqual(String(decoding: bytes[20..<(20 + json)], as: UTF8.self), metaJSON)
        XCTAssertEqual(MatteTrack.readMeta(Array(bytes[20..<(20 + json)])), meta)
        let timesAt = 20 + json
        XCTAssertEqual(u32(bytes, timesAt), 0)
        XCTAssertEqual(u32(bytes, timesAt + 4), 100)
        XCTAssertEqual(u32(bytes, timesAt + 8), 0)
        // No run of three in a frame of halves: each is one packet of eight literals, nine bytes.
        XCTAssertEqual(u32(bytes, timesAt + 12), 9)
        XCTAssertEqual(Array(bytes[(timesAt + 16)..<(timesAt + 25)]), [16, 255, 255, 0, 0, 255, 255, 0, 0])
        XCTAssertEqual(bytes.count, timesAt + 16 + 18)
    }

    /// The whole file, every byte, as `encodeMatteTrack` in the TS writes it for the same content: what
    /// lets the editor's preview read a track this side made.
    func testWritesTheSameBytesAsTheReferenceWriter() throws {
        let json = Array(metaJSON.utf8)
        var expected: [UInt8] = Array("VKMT".utf8) + [1, 0, 4, 0, 2, 0, 0, 0] + le32(2) + le32(json.count)
        expected += json
        expected += le32(0) + le32(100)
        expected += le32(0) + le32(9)
        expected += [16, 255, 255, 0, 0, 255, 255, 0, 0]
        expected += [16, 0, 0, 255, 255, 0, 0, 255, 255]
        XCTAssertEqual([UInt8](try encoded(times: [0, 100], frames: [halves(255, 0), halves(0, 255)])), expected)
        // And the frames already coded, as a video's search hands them over, make the same file.
        let coded = MatteTrackCoded(width: 4, height: 2, times: [0, 100],
                                    packets: [MatteTrack.encodePackets(halves(255, 0)), MatteTrack.encodePackets(halves(0, 255))],
                                    meta: meta)
        XCTAssertEqual([UInt8](try MatteTrack.encode(coded)), expected)
    }

    func testLeavesTheBoxOutOfTheJSONWhereThereIsNone() throws {
        let none = MatteTrackMeta(engine: "vision", kind: "image", target: "people", durationMs: 0, fps: 0, coverage: 0, box: nil)
        XCTAssertEqual(String(decoding: MatteTrack.metaJSON(none), as: UTF8.self),
                       #"{"engine":"vision","kind":"image","target":"people","durationMs":0,"fps":0,"coverage":0}"#)
        let some = MatteTrackMeta(engine: "vision", kind: "video", target: "subject", durationMs: 4321, fps: 9,
                                  coverage: 0.1875, box: MatteBox(x: 0.25, y: 0.1, w: 0.5, h: 0.9))
        XCTAssertEqual(String(decoding: MatteTrack.metaJSON(some), as: UTF8.self),
                       #"{"engine":"vision","kind":"video","target":"subject","durationMs":4321,"fps":9,"coverage":0.1875,"box":{"x":0.25,"y":0.1,"w":0.5,"h":0.9}}"#)
    }

    func testReadsBackEveryFrameItsTimesAndItsJSON() throws {
        let track = try MatteTrack.parse(try encoded(times: [0, 100, 250], frames: [halves(255, 0), halves(128, 128), halves(0, 255)]))
        XCTAssertEqual([track.width, track.height, track.frameCount], [4, 2, 3])
        XCTAssertEqual(track.times, [0, 100, 250])
        XCTAssertEqual(track.meta, meta)
        XCTAssertEqual(try track.frame(1), halves(128, 128))
        XCTAssertEqual(try track.frame(2), halves(0, 255))
        XCTAssertNoThrow(try track.checkFrames())
        // A frame asked for again is the one kept, not decoded again.
        let decoded = track.decodes
        XCTAssertEqual(try track.frame(1), halves(128, 128))
        XCTAssertEqual(track.decodes, decoded)
    }

    func testReadsDataThatIsASliceOfALargerBuffer() throws {
        let bytes = try encoded(times: [0, 100], frames: [halves(255, 0), halves(0, 255)])
        var padded = Data(count: 8)
        padded.append(bytes)
        padded.append(Data(count: 16))
        let slice = padded[8..<(8 + bytes.count)]
        XCTAssertEqual(slice.startIndex, 8)
        XCTAssertEqual(try MatteTrack.parse(slice).frame(1), halves(0, 255))
    }

    func testRefusesWhatIsNotAMatteTrack() throws {
        let good = [UInt8](try encoded(times: [0], frames: [halves(255, 0)]))
        func broken(_ edit: (inout [UInt8]) -> Void) -> [UInt8] {
            var copy = good
            edit(&copy)
            return copy
        }
        assertRefused(Array(good[0..<10]), "too short")
        assertRefused(broken { $0[0] = 0x57 }, "not a matte track")
        assertRefused(broken { $0[4] = 2 }, "version 2")
        assertRefused(broken { put16(&$0, 6, 0) }, "no cells")
        assertRefused(broken { put32(&$0, 12, 0) }, "no frames")
        assertRefused(broken { put32(&$0, 12, 1000) }, "run past its end")
        assertRefused(broken { put16(&$0, 6, 4096); put16(&$0, 8, 4096) }, "too large")
        XCTAssertGreaterThan(4096 * 4096, MatteTrack.maxCells)
        // Android's four, the same way: a magic, a version, no cells, more frames than the file holds.
        let changes: [(inout [UInt8]) -> Void] = [
            { $0[0] = 0x57 },
            { $0[4] = 2 },
            { $0[6] = 0; $0[7] = 0 },
            { $0[12] = 0xe8; $0[13] = 3 },
        ]
        for change in changes { assertRefused(broken(change)) }
    }

    func testRefusesTimesThatGoBackAndOffsetsPastTheEnd() throws {
        let two = [UInt8](try encoded(times: [0, 100], frames: [halves(255, 0), halves(0, 255)]))
        let json = u32(two, 16)
        var back = two
        put32(&back, 20 + json + 4, 0)
        assertRefused(back, "times go back")
        var past = two
        put32(&past, 20 + json + 12, 9999)
        assertRefused(past, "offsets")
    }

    func testKeepsATrackWhoseJSONIsDamagedDrawable() throws {
        var bytes = [UInt8](try encoded(times: [0], frames: [halves(255, 0)]))
        let json = u32(bytes, 16)
        for i in 20..<(20 + json) { bytes[i] = 0x20 }
        bytes[20] = 0x7b // '{'
        let track = try MatteTrack.parse(Data(bytes))
        XCTAssertNil(track.meta)
        XCTAssertEqual(try track.frame(0), halves(255, 0))
    }

    func testRefusesADamagedFrameWhenItIsDrawnAndEveryOneWhenChecked() throws {
        let bytes = [UInt8](try encoded(times: [0, 100], frames: [halves(255, 0), halves(0, 255)]))
        // The second frame's packet header promises eight literals; one byte short of them now.
        let track = try MatteTrack.parse(Data(bytes[0..<(bytes.count - 1)]))
        XCTAssertNoThrow(try track.frame(0))
        XCTAssertThrowsError(try track.frame(1)) { XCTAssertTrue($0 is MatteTrackError) }
        XCTAssertThrowsError(try track.checkFrames())
        // The render's pre-flight looks only where it is asked to.
        XCTAssertNoThrow(try track.validate(from: 0, through: 0))
        XCTAssertThrowsError(try track.validate(from: 0, through: 1))
        XCTAssertThrowsError(try track.frame(7), "a frame the track does not have")
    }

    func testRoundsTimesToWholeMillisecondsAndRefusesAContentThatDoesNotAddUp() throws {
        let track = try MatteTrack.parse(try encoded(times: [0, 66.6667, 133.4], frames: [halves(1, 0), halves(1, 0), halves(0, 1)]))
        XCTAssertEqual(track.times, [0, 67, 133])
        XCTAssertThrowsError(try MatteTrack.encode(MatteTrackContent(width: 4, height: 2, times: [0], frames: [[1]], meta: meta)))
        XCTAssertThrowsError(try MatteTrack.encode(MatteTrackContent(width: 4, height: 2, times: [], frames: [], meta: meta)))
        XCTAssertThrowsError(try MatteTrack.encode(MatteTrackContent(width: 4, height: 2, times: [0, 1], frames: [halves(0, 0)], meta: meta)))
    }

    // MARK: - matteAt

    private func twoFrames() throws -> MatteTrack {
        try MatteTrack.parse(try encoded(times: [100, 200], frames: [halves(255, 0), halves(0, 255)]))
    }

    func testHoldsTheFirstFrameBeforeItAndTheLastAfterIt() throws {
        let track = try twoFrames()
        XCTAssertEqual(try matteAt(track, 0), halves(255, 0))
        XCTAssertEqual(try matteAt(track, 100), halves(255, 0))
        XCTAssertEqual(try matteAt(track, 200), halves(0, 255))
        XCTAssertEqual(try matteAt(track, 9999), halves(0, 255))
        XCTAssertEqual(track.span(.nan), FrameSpan(from: 0, to: 0, weight: 0))
    }

    func testMixesTheTwoFramesEitherSideByHowFarBetweenThemTheInstantIsRounded() throws {
        let track = try twoFrames()
        XCTAssertEqual(try matteAt(track, 150), halves(128, 128))
        XCTAssertEqual(try matteAt(track, 125), halves(191, 64))
        XCTAssertEqual(track.span(125), FrameSpan(from: 0, to: 1, weight: 0.25))
    }

    func testIsOneFrameAtEveryInstantForAPicture() throws {
        let picture = try MatteTrack.parse(try encoded(times: [0], frames: [halves(255, 0)],
                                                       meta: MatteTrackMeta(engine: "vision", kind: "image", target: "subject",
                                                                            durationMs: 0, fps: 0, coverage: 0.5, box: nil)))
        XCTAssertEqual(try matteAt(picture, 12_345), halves(255, 0))
        XCTAssertEqual(picture.meta?.kind, "image")
    }

    func testFillsTheArrayItIsHanded() throws {
        var out = [UInt8](repeating: 9, count: 8)
        try matteAt(try twoFrames(), 150, into: &out)
        XCTAssertEqual(out, halves(128, 128))
    }

    // MARK: - Grids, summaries, smoothing

    func testPutsTheLongSideOnTheGridAndTheOtherInProportion() {
        XCTAssertTrue(matteGrid(width: 1080, height: 1920, longSide: 512) == (288, 512))
        XCTAssertTrue(matteGrid(width: 4000, height: 3000, longSide: 1024) == (1024, 768))
        XCTAssertTrue(matteGrid(width: 10, height: 100_000, longSide: 512) == (1, 512))
        XCTAssertTrue(matteGrid(width: 0, height: 100, longSide: 512) == (512, 512))
    }

    func testSaysHowMuchOfTheFrameTheSubjectCoversAndWhereOverTheWholeFootage() {
        // A 4x2 grid, the subject in the left column of one frame and the top-right cell of the other.
        let a: [UInt8] = [255, 0, 0, 0, 255, 0, 0, 0]
        let b: [UInt8] = [0, 0, 0, 200, 0, 0, 0, 100]
        let both = summariseMatte([a, b], width: 4, height: 2)
        XCTAssertEqual(both.coverage, 0.1875)
        XCTAssertEqual(both.box, MatteBox(x: 0, y: 0, w: 1, h: 1))
        let one = summariseMatte([b], width: 4, height: 2)
        XCTAssertEqual(one.coverage, 0.125)
        XCTAssertEqual(one.box, MatteBox(x: 0.75, y: 0, w: 0.25, h: 0.5))
        // Nothing at even odds: no box.
        let none = summariseMatte([[UInt8](repeating: 127, count: 8)], width: 4, height: 2)
        XCTAssertEqual(none.coverage, 0)
        XCTAssertNil(none.box)
    }

    func testSmoothsOnlyWhereThePictureStayedTheSame() {
        var cells: [UInt8] = [255, 255]
        MatteFrames.smooth(&cells, luma: [10, 200], previous: [0, 0], previousLuma: [10, 10])
        // Still: 35% of the new answer. Moved by 190 of 255: all of it. Android's case.
        XCTAssertEqual(cells, [89, 255])
    }

    func testReadsAMaskOntoTheGridBilinearlyAtEachCellsCentre() {
        // A 2x1 mask, 0 then 1, read onto 4 cells: centres at 1/8, 3/8, 5/8, 7/8 of the frame, which are
        // -0.25, 0.25, 0.75 and 1.25 of a mask pixel past the first centre - clamped at the two ends.
        let mask = MatteConfidence(width: 2, height: 1, values: [0, 1])
        XCTAssertEqual(mask.onto(width: 4, height: 1), [0, 64, 191, 255])
        // A grid the mask's own size is the mask, rounded to bytes.
        let same = MatteConfidence(width: 2, height: 2, values: [0, 0.5, 1, 0.25])
        XCTAssertEqual(same.onto(width: 2, height: 2), [0, 128, 255, 64])
        XCTAssertEqual(MatteConfidence.empty.onto(width: 3, height: 2), [UInt8](repeating: 0, count: 6))
    }

    func testReadsAHalfFloatByItsBits() {
        XCTAssertEqual(MatteConfidence.halfToFloat(0x0000), 0)
        XCTAssertEqual(MatteConfidence.halfToFloat(0x3c00), 1)
        XCTAssertEqual(MatteConfidence.halfToFloat(0x3800), 0.5)
        XCTAssertEqual(MatteConfidence.halfToFloat(0xc000), -2)
        XCTAssertEqual(MatteConfidence.halfToFloat(0x0001), Float(1) / 16_777_216)
        XCTAssertTrue(MatteConfidence.halfToFloat(0x7c00).isInfinite)
    }

    func testHoldsTheRateToOneToThirtyWholeAndLowersItForALongClip() {
        XCTAssertEqual(MatteFinder.fps(nil, target: "subject"), 10)
        XCTAssertEqual(MatteFinder.fps(nil, target: "people"), 15)
        XCTAssertEqual(MatteFinder.fps(.nan, target: "subject"), 10)
        XCTAssertEqual(MatteFinder.fps(0, target: "subject"), 1)
        XCTAssertEqual(MatteFinder.fps(120, target: "people"), 30)
        XCTAssertEqual(MatteFinder.fps(12.5, target: "subject"), 13)
        // 1800 frames at the most: a minute at 10 is 600 and stays at 10; 200 s is looked at 9 times a second.
        XCTAssertEqual(MatteFinder.rate(10, durationMs: 60_000), 10)
        XCTAssertEqual(MatteFinder.rate(10, durationMs: 200_000), 9)
        XCTAssertEqual(MatteFinder.rate(10, durationMs: 3_600_000), 1)
        XCTAssertEqual(MatteFinder.rate(10, durationMs: 0), 10)
    }

    func testAMatteSearchOnAnOSWithNoSubjectSegmenterKeepsPeople() {
        XCTAssertEqual(MatteSegmenters.target(for: "people"), "people")
        if #available(iOS 17.0, *) {
            XCTAssertEqual(MatteSegmenters.target(for: "subject"), "subject")
            XCTAssertTrue(MatteSegmenters.model(for: "subject").hasPrefix("instance-"))
        } else {
            XCTAssertEqual(MatteSegmenters.target(for: "subject"), "people")
        }
        XCTAssertTrue(MatteSegmenters.model(for: "people").hasPrefix("person-"))
    }
}
