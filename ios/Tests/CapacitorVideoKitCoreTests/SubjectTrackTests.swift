import Foundation
import XCTest
@testable import CapacitorVideoKitCore

/// The subject track is a file three engines read and two write, so its layout is held here byte for
/// byte, by the cases of `subject-track.unit.test.ts`: the header, the tables, the runs. `focusMask`
/// and `focusLevels` are the contract's steps 1 to 3, which every engine computes the same way before
/// it draws a mask.
final class SubjectTrackTests: XCTestCase {

    private let meta = SubjectTrackMeta(
        engine: "mediapipe", kind: "video", durationMs: 1000, fps: 10,
        subjects: [SubjectInfo(id: 1, kind: "person", startMs: 0, endMs: 900, peakMs: 300,
                               box: SubjectBox(x: 0, y: 0, w: 0.5, h: 1), area: 0.5)])

    /// A 4x2 grid: the left half subject `left`, the right half subject `right`.
    private func halves(_ left: UInt8, _ right: UInt8) -> [UInt8] {
        [left, left, right, right, left, left, right, right]
    }

    private func encoded(times: [Double], frames: [[UInt8]], kind: String = "video") throws -> Data {
        let m = SubjectTrackMeta(engine: meta.engine, kind: kind, durationMs: meta.durationMs, fps: meta.fps,
                                 subjects: meta.subjects)
        return try SubjectTrack.encode(SubjectTrackContent(width: 4, height: 2, times: times, frames: frames, meta: m))
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

    private func assertRefused(_ bytes: [UInt8], _ words: String? = nil,
                               file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertThrowsError(try SubjectTrack.parse(Data(bytes)), file: file, line: line) { error in
            guard let refused = error as? SubjectTrackError else {
                return XCTFail("not a SubjectTrackError: \(error)", file: file, line: line)
            }
            if let words { XCTAssertTrue(refused.description.contains(words), refused.description, file: file, line: line) }
        }
    }

    // MARK: - Runs

    func testCodesAValueAndItsRunTheRunAsLEB128() {
        XCTAssertEqual(SubjectTrack.encodeRuns([0, 0, 0, 5, 5]), [0, 3, 5, 2])
        // 300 = 0b10_0101100: 0xAC (44 | 0x80), then 2.
        XCTAssertEqual(SubjectTrack.encodeRuns([UInt8](repeating: 7, count: 300)), [7, 0xac, 2])
    }

    func testDecodesExactlyWhatItCoded() throws {
        let cells = (0..<1000).map { i in UInt8(i % 97 < 40 ? 0 : i % 3) }
        let runs = SubjectTrack.encodeRuns(cells)
        var out = [UInt8](repeating: 0, count: cells.count)
        try SubjectTrack.decodeRuns(runs, start: 0, end: runs.count, into: &out)
        XCTAssertEqual(out, cells)
    }

    func testRefusesRunsThatDoNotFillTheGridOverrunItOrStopInAVarint() {
        var out = [UInt8](repeating: 0, count: 4)
        for runs: [UInt8] in [[1, 3], [1, 5], [1, 0x84], [1, 0, 1, 4]] {
            XCTAssertThrowsError(try SubjectTrack.decodeRuns(runs, start: 0, end: runs.count, into: &out), "\(runs)") {
                XCTAssertTrue($0 is SubjectTrackError)
            }
        }
    }

    // MARK: - The file

    func testLaysTheHeaderOutAsTheContractHasIt() throws {
        let bytes = [UInt8](try encoded(times: [0, 100, 250], frames: [halves(1, 0), halves(0, 1), halves(2, 2)]))
        XCTAssertEqual(String(decoding: bytes[0..<4], as: UTF8.self), "VKST")
        XCTAssertEqual(bytes[4], 1)
        XCTAssertEqual(bytes[5], 0)
        XCTAssertEqual(u16(bytes, 6), 4)
        XCTAssertEqual(u16(bytes, 8), 2)
        XCTAssertEqual(u16(bytes, 10), 0)
        XCTAssertEqual(u32(bytes, 12), 3)
        let json = u32(bytes, 16)
        XCTAssertEqual(SubjectTrack.readMeta(Array(bytes[20..<(20 + json)])), meta)
        // The JSON is the reference's, key for key, whatever reads it.
        let parsed = try XCTUnwrap(try JSONSerialization.jsonObject(with: Data(bytes[20..<(20 + json)])) as? [String: Any])
        XCTAssertEqual(parsed["engine"] as? String, "mediapipe")
        XCTAssertEqual(parsed["durationMs"] as? Int, 1000)
        let subject = try XCTUnwrap((parsed["subjects"] as? [[String: Any]])?.first)
        XCTAssertEqual(subject["peakMs"] as? Int, 300)
        XCTAssertEqual((subject["box"] as? [String: Any])?["w"] as? Double, 0.5)
        // The times, then the offsets: the first frame at 0 of the data.
        XCTAssertEqual([0, 1, 2].map { u32(bytes, 20 + json + 4 * $0) }, [0, 100, 250])
        XCTAssertEqual(u32(bytes, 20 + json + 12), 0)
    }

    func testReadsBackEveryFrameItsTimesAndItsJSON() throws {
        let track = try SubjectTrack.parse(try encoded(times: [0, 100, 250], frames: [halves(1, 0), halves(0, 1), halves(2, 2)]))
        XCTAssertEqual([track.width, track.height, track.frameCount], [4, 2, 3])
        XCTAssertEqual(track.times, [0, 100, 250])
        XCTAssertEqual(track.meta, meta)
        XCTAssertEqual(try track.frame(0), halves(1, 0))
        XCTAssertEqual(try track.frame(1), halves(0, 1))
        XCTAssertEqual(try track.frame(2), halves(2, 2))
        // A frame asked for again is the one kept, not decoded again.
        let decoded = track.decodes
        XCTAssertEqual(try track.frame(1), halves(0, 1))
        XCTAssertEqual(track.decodes, decoded)
    }

    func testReadsDataThatIsASliceOfALargerBuffer() throws {
        let bytes = try encoded(times: [0, 100, 250], frames: [halves(1, 0), halves(0, 1), halves(2, 2)])
        var padded = Data(count: 8)
        padded.append(bytes)
        padded.append(Data(count: 16))
        // A slice keeps its parent's indices, so it starts at 8, not 0.
        let slice = padded[8..<(8 + bytes.count)]
        XCTAssertEqual(slice.startIndex, 8)
        XCTAssertEqual(try SubjectTrack.parse(slice).frame(2), halves(2, 2))
    }

    func testRefusesWhatIsNotASubjectTrackItCanRead() throws {
        let bytes = [UInt8](try encoded(times: [0, 100, 250], frames: [halves(1, 0), halves(0, 1), halves(2, 2)]))
        let json = u32(bytes, 16)
        func broken(_ edit: (inout [UInt8]) -> Void) -> [UInt8] {
            var copy = bytes
            edit(&copy)
            return copy
        }
        assertRefused([UInt8](repeating: 0, count: 10))
        assertRefused(broken { $0[0] = 0x41 }, "not a subject track")
        assertRefused(broken { $0[4] = 2 }, "version 2")
        assertRefused(broken { put16(&$0, 6, 0) })
        assertRefused(broken { put32(&$0, 12, 0) })
        assertRefused(broken { put16(&$0, 6, 2000); put16(&$0, 8, 2000) }, "too large")
        assertRefused(broken { put32(&$0, 16, 1 << 20) }, "past its end")
        assertRefused(broken { put32(&$0, 20 + json + 4, 0) }, "go back")
        assertRefused(broken { put32(&$0, 20 + json + 16, 9999) }, "offsets")
    }

    func testStillDrawsWhenItsJSONIsDamagedOnlyWithNothingToList() throws {
        var bytes = [UInt8](try encoded(times: [0, 100, 250], frames: [halves(1, 0), halves(0, 1), halves(2, 2)]))
        let json = u32(bytes, 16)
        bytes[20] = 0x7b // '{'
        bytes[21] = 0x7b
        let track = try SubjectTrack.parse(Data(bytes))
        XCTAssertNil(track.meta)
        XCTAssertGreaterThan(json, 2)
        XCTAssertEqual(try track.frame(0), halves(1, 0))
    }

    func testRefusesAFrameWhoseRunsDoNotAddUpWhenItIsDrawnNotWhenItIsOpened() throws {
        var bytes = [UInt8](try encoded(times: [0, 100, 250], frames: [halves(1, 0), halves(0, 1), halves(2, 2)]))
        let data = 20 + u32(bytes, 16) + 24
        // The first frame's first run made one cell too long.
        bytes[data + 1] += 1
        let track = try SubjectTrack.parse(Data(bytes))
        XCTAssertThrowsError(try track.frame(0)) { XCTAssertTrue($0 is SubjectTrackError) }
        // The render's pre-flight finds it without drawing it, and only where it is asked to look.
        XCTAssertThrowsError(try track.validate(from: 0, through: 2))
        XCTAssertNoThrow(try track.validate(from: 1, through: 2))
        XCTAssertThrowsError(try track.frame(7), "a frame the track does not have")
    }

    // MARK: - span

    func testHoldsTheFirstFrameBeforeItAndTheLastAfterIt() throws {
        let track = try SubjectTrack.parse(try encoded(times: [100, 200, 400], frames: [halves(1, 0), halves(0, 1), halves(2, 2)]))
        XCTAssertEqual(track.span(0), FrameSpan(from: 0, to: 0, weight: 0))
        XCTAssertEqual(track.span(100), FrameSpan(from: 0, to: 0, weight: 0))
        XCTAssertEqual(track.span(400), FrameSpan(from: 2, to: 2, weight: 0))
        XCTAssertEqual(track.span(9000), FrameSpan(from: 2, to: 2, weight: 0))
        XCTAssertEqual(track.span(.nan), FrameSpan(from: 0, to: 0, weight: 0))
    }

    func testFindsTheFramesEitherSideAndHowFarBetweenThem() throws {
        let track = try SubjectTrack.parse(try encoded(times: [100, 200, 400], frames: [halves(1, 0), halves(0, 1), halves(2, 2)]))
        XCTAssertEqual(track.span(150), FrameSpan(from: 0, to: 1, weight: 0.5))
        XCTAssertEqual(track.span(200), FrameSpan(from: 1, to: 2, weight: 0))
        XCTAssertEqual(track.span(350), FrameSpan(from: 1, to: 2, weight: 0.75))
    }

    func testIsOneFrameForEverOnAPicture() throws {
        let picture = try SubjectTrack.parse(try encoded(times: [0], frames: [halves(1, 0)], kind: "image"))
        XCTAssertEqual(picture.span(-5), FrameSpan(from: 0, to: 0, weight: 0))
        XCTAssertEqual(picture.span(123_456), FrameSpan(from: 0, to: 0, weight: 0))
    }

    // MARK: - focusLevels

    private let keys = (atMs: [1000.0, 2000, 3000, 3000],
                        subjects: [ComposeFocusSubject(id: 1, focus: [1, 0, 0, 1]),
                                   ComposeFocusSubject(id: 2, focus: [0, 1, 1, 0])])

    func testReadsTheKeysAsACameraIsRead() {
        func at(_ ms: Double) -> [Float] { Array(focusLevels(atMs: keys.atMs, subjects: keys.subjects, at: ms)[0..<3]) }
        XCTAssertEqual(at(0), [0, 1, 0])
        XCTAssertEqual(at(1500), [0, 0.5, 0.5])
        XCTAssertEqual(at(2500), [0, 0, 1])
        // Two keys at one time are a step: the later wins at that time.
        XCTAssertEqual(at(2999), [0, 0, 1])
        XCTAssertEqual(at(3000), [0, 1, 0])
        XCTAssertEqual(at(9000), [0, 1, 0])
    }

    func testLeavesTheBackgroundAndEverySubjectNotListedOutOfFocus() {
        let levels = focusLevels(atMs: [0], subjects: [ComposeFocusSubject(id: 3, focus: [0.25])], at: 0)
        XCTAssertEqual(levels[0], 0)
        XCTAssertEqual(levels[1], 0)
        XCTAssertEqual(levels[3], 0.25)
        XCTAssertEqual(levels[255], 0)
    }

    func testHoldsALevelTo0To1() {
        let levels = focusLevels(atMs: [0], subjects: [ComposeFocusSubject(id: 1, focus: [7]),
                                                       ComposeFocusSubject(id: 2, focus: [-1])], at: 0)
        XCTAssertEqual([levels[1], levels[2]], [1, 0])
    }

    // MARK: - focusMask

    private func twoFrames() throws -> SubjectTrack {
        try SubjectTrack.parse(try encoded(times: [0, 100], frames: [halves(1, 0), halves(0, 1)]))
    }

    private var oneInFocus: [Float] { focusLevels(atMs: [0], subjects: [ComposeFocusSubject(id: 1, focus: [1])], at: 0) }

    private func mask(_ track: SubjectTrack, at ms: Double, invert: Bool = false) throws -> [UInt8] {
        var out: [UInt8] = []
        try focusMask(track, levels: oneInFocus, at: ms, invert: invert, into: &out)
        return out
    }

    func testIsTheSubjectInFocusWhereItIsAnd0Elsewhere() throws {
        let track = try twoFrames()
        XCTAssertEqual(try mask(track, at: 0), [255, 255, 0, 0, 255, 255, 0, 0])
        XCTAssertEqual(try mask(track, at: 100), [0, 0, 255, 255, 0, 0, 255, 255])
    }

    func testMixesTheFramesEitherSideByHowFarBetweenThemTheInstantIs() throws {
        XCTAssertEqual(try mask(try twoFrames(), at: 25), [191, 191, 64, 64, 191, 191, 64, 64])
    }

    func testTurnsOverForInvert() throws {
        XCTAssertEqual(try mask(try twoFrames(), at: 0, invert: true), [0, 0, 255, 255, 0, 0, 255, 255])
    }

    func testFillsTheArrayItIsHanded() throws {
        var out = [UInt8](repeating: 9, count: 8)
        try focusMask(try twoFrames(), levels: oneInFocus, at: 0, invert: false, into: &out)
        XCTAssertEqual(out[2], 0)
        XCTAssertEqual(out[0], 255)
    }

    // MARK: - Writing what the tracker hands over

    func testRoundsTimesToWholeMillisecondsAndWritesNumbersAsJavaScriptDoes() throws {
        let m = SubjectTrackMeta(engine: "vision", kind: "video", durationMs: 1234, fps: 15,
                                 subjects: [SubjectInfo(id: 1, kind: "subject", startMs: 67, endMs: 400, peakMs: 133,
                                                        box: SubjectBox(x: 0.1, y: 0.2, w: 0.35, h: 0.7), area: 0.245)])
        let bytes = [UInt8](try SubjectTrack.encode(SubjectTrackContent(width: 4, height: 2, times: [0, 66.6667, 133.4],
                                                                       frames: [halves(1, 0), halves(1, 0), halves(0, 1)], meta: m)))
        let json = u32(bytes, 16)
        XCTAssertEqual(String(decoding: bytes[20..<(20 + json)], as: UTF8.self),
                       #"{"engine":"vision","kind":"video","durationMs":1234,"fps":15,"subjects":[{"id":1,"kind":"subject","startMs":67,"endMs":400,"peakMs":133,"box":{"x":0.1,"y":0.2,"w":0.35,"h":0.7},"area":0.245}]}"#)
        XCTAssertEqual(try SubjectTrack.parse(Data(bytes)).times, [0, 67, 133])
        XCTAssertThrowsError(try SubjectTrack.encode(SubjectTrackContent(width: 4, height: 2, times: [0], frames: [[1]], meta: m)))
        XCTAssertThrowsError(try SubjectTrack.encode(SubjectTrackContent(width: 4, height: 2, times: [], frames: [], meta: m)))
    }
}
