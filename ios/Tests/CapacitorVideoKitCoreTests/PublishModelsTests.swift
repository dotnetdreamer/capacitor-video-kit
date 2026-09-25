import Foundation
import XCTest
@testable import CapacitorVideoKitCore

/// The publisher's pure pieces: how a server id goes back into the finalize body and across the
/// bridge, and how a `path` from the caller becomes a file.
final class PublishModelsTests: XCTestCase {

    // MARK: - RemoteId.jsonLiteral

    func testStringIdWithControlCharactersRoundTripsThroughJSON() throws {
        let raw = "a\nb\tc\u{01}d\"e\\f/g\r\u{08}\u{0C}\u{1F}h\u{7F}é😀"
        let literal = RemoteId(value: raw, isNumber: false).jsonLiteral
        XCTAssertEqual(try parse(literal) as? String, raw)
    }

    func testEveryControlCharacterIsEscaped() throws {
        for code in 0..<0x20 {
            let raw = "x" + String(UnicodeScalar(UInt8(code))) + "y"
            let literal = RemoteId(value: raw, isNumber: false).jsonLiteral
            XCTAssertFalse(literal.unicodeScalars.contains { $0.value < 0x20 },
                           "U+\(String(format: "%04X", code)) left raw in \(literal.debugDescription)")
            XCTAssertEqual(try parse(literal) as? String, raw)
        }
    }

    /// The spelling `JSON.stringify` uses. Android's `JSONObject.quote` spells these the same and
    /// adds `\/` for a slash, which reads back as the same string.
    func testEscapesAreSpelledTheWayTheOtherEnginesSpellThem() {
        XCTAssertEqual(RemoteId(value: "a\"b\\c", isNumber: false).jsonLiteral, #""a\"b\\c""#)
        XCTAssertEqual(RemoteId(value: "\n\r\t\u{08}\u{0C}", isNumber: false).jsonLiteral, #""\n\r\t\b\f""#)
        XCTAssertEqual(RemoteId(value: "\u{01}\u{1F}", isNumber: false).jsonLiteral, #""\u0001\u001f""#)
    }

    func testNumericIdIsSplicedBare() {
        XCTAssertEqual(RemoteId(value: "12", isNumber: true).jsonLiteral, "12")
        XCTAssertEqual(RemoteId(value: "1.5", isNumber: true).jsonLiteral, "1.5")
    }

    func testFilledBodyWithAWhitespaceIdIsValidJSON() throws {
        let uploads = [
            upload("clip-1", tag: "clip", remoteId: RemoteId(value: "line\nbreak", isNumber: false)),
            upload("clip-2", tag: "clip", remoteId: RemoteId(value: "tab\there", isNumber: false)),
            upload("cover", tag: "cover", remoteId: RemoteId(value: "7", isNumber: true)),
        ]
        let template = #"{"one":"$ID:clip-1","clips":"$IDS:clip","all":"$IDS"}"#
        let body = try XCTUnwrap(parse(TemplateFill.fill(template, uploads: uploads)) as? [String: Any])

        XCTAssertEqual(body["one"] as? String, "line\nbreak")
        XCTAssertEqual(body["clips"] as? [String], ["line\nbreak", "tab\there"])
        let all = try XCTUnwrap(body["all"] as? [Any])
        XCTAssertEqual(all.count, 3)
        XCTAssertEqual((all[2] as? NSNumber)?.intValue, 7)
    }

    // MARK: - RemoteId.jsonValue

    func testNumericIdCrossesTheBridgeAsANumber() throws {
        XCTAssertEqual(try serialized(RemoteId(value: "12", isNumber: true)), #"{"v":12}"#)
        XCTAssertEqual(try serialized(RemoteId(value: "1.5", isNumber: true)), #"{"v":1.5}"#)
        // Past 2^53, where a detour through Double would change the digits.
        XCTAssertEqual(try serialized(RemoteId(value: "9007199254740993", isNumber: true)),
                       #"{"v":9007199254740993}"#)
    }

    func testStringIdStaysAStringEvenWhenItLooksNumeric() throws {
        XCTAssertEqual(try serialized(RemoteId(value: "12", isNumber: false)), #"{"v":"12"}"#)
        XCTAssertEqual(try serialized(RemoteId(value: "abc", isNumber: false)), #"{"v":"abc"}"#)
    }

    func testFractionalIdFromAResponseKeepsItsType() throws {
        let body = Data(#"{"data":{"id":1.5}}"#.utf8)
        let id = try XCTUnwrap(PublisherHttp.parseRemoteId(body, idPath: "data.id"))
        XCTAssertEqual(id, RemoteId(value: "1.5", isNumber: true))
        XCTAssertEqual(try serialized(id), #"{"v":1.5}"#)
    }

    func testStateProjectionCarriesTheNumber() throws {
        let record = PublishRecord(batchId: "b", headers: [:], uploadUrl: "https://example.test/u",
                                   finalizeUrl: "https://example.test/f", bodyTemplate: "{}",
                                   uploads: [upload("u1", tag: "", remoteId: RemoteId(value: "2.25", isNumber: true))],
                                   phase: Phase.uploading, createdAt: 0, updatedAt: 0)
        let state = PublishStore.shared.state(record)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(state))
        let uploads = try XCTUnwrap(state["uploads"] as? [[String: Any]])
        XCTAssertEqual((uploads[0]["remoteId"] as? NSNumber)?.doubleValue, 2.25)
    }

    // MARK: - PublishModels.fileURL

    func testUnencodedHashSpaceAndQuestionMarkAreKept() {
        XCTAssertEqual(PublishModels.fileURL("file:///tmp/My Clip #1.mp4")?.path, "/tmp/My Clip #1.mp4")
        XCTAssertEqual(PublishModels.fileURL("file:///tmp/what?.mp4")?.path, "/tmp/what?.mp4")
    }

    func testEncodedURIIsDecodedOnce() {
        XCTAssertEqual(PublishModels.fileURL("file:///tmp/My%20Clip%20%231.mp4")?.path, "/tmp/My Clip #1.mp4")
        XCTAssertEqual(PublishModels.fileURL("file:///tmp/caf%C3%A9.mp4")?.path, "/tmp/café.mp4")
        XCTAssertEqual(PublishModels.fileURL("file:///tmp/100%2525.mp4")?.path, "/tmp/100%25.mp4")
    }

    func testPartlyEncodedURIWithARawHashIsDecodedByHand() {
        XCTAssertEqual(PublishModels.fileURL("file:///tmp/My%20Clip%20#1.mp4")?.path, "/tmp/My Clip #1.mp4")
    }

    func testAStrayPercentIsTakenLiterally() {
        XCTAssertEqual(PublishModels.fileURL("file:///tmp/100%.mp4")?.path, "/tmp/100%.mp4")
    }

    func testEveryURITheKitHandsOutRoundTrips() {
        for name in ["plain.mp4", "a b.mp4", "#1.mp4", "what?.mp4", "50%.mp4", "café.mp4", "a%20b.mp4"] {
            let path = "/tmp/vk/" + name
            XCTAssertEqual(PublishModels.fileURL(URL(fileURLWithPath: path).absoluteString)?.path, path)
        }
    }

    func testHostFormBarePathAndForeignSchemes() {
        XCTAssertEqual(PublishModels.fileURL("file://localhost/tmp/a.mp4")?.path, "/tmp/a.mp4")
        XCTAssertEqual(PublishModels.fileURL("/tmp/a b#1.mp4")?.path, "/tmp/a b#1.mp4")
        XCTAssertNil(PublishModels.fileURL("content://media/external/video/1"))
        XCTAssertNil(PublishModels.fileURL("relative/a.mp4"))
    }

    /// The host is dropped before anything reads the path, so a raw `#` or `?` behind it cannot
    /// send the remainder off to be resolved against the working directory.
    func testHostFormKeepsWhatTheBarePathFormKeeps() {
        XCTAssertEqual(PublishModels.fileURL("file://localhost/tmp/a #1.mp4")?.path, "/tmp/a #1.mp4")
        XCTAssertEqual(PublishModels.fileURL("file://localhost/tmp/what?.mp4")?.path, "/tmp/what?.mp4")
        XCTAssertEqual(PublishModels.fileURL("file://localhost/tmp/a%20b.mp4")?.path, "/tmp/a b.mp4")
        XCTAssertEqual(PublishModels.fileURL("file://localhost/tmp/a%20#1.mp4")?.path, "/tmp/a #1.mp4")
    }

    func testAFileURIWithNoPathNamesNothing() {
        XCTAssertNil(PublishModels.fileURL("file://"))
        XCTAssertNil(PublishModels.fileURL("file://localhost"))
        XCTAssertNil(PublishModels.fileURL("file://a#b.mp4"))
    }

    // MARK: - PublishModels.fileName

    /// A raw `?` is part of the name `fileURL` resolves, so it cannot also be where the extension
    /// is cut off.
    func testFileNameTakesItsExtensionFromTheFileItSends() {
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "file:///x/clip?1.mov"), "u.mov")
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "file:///x/My%20Clip.MOV"), "u.MOV")
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "file://localhost/x/a #1.webm"), "u.webm")
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "/x/a.m4v"), "u.m4v")
    }

    func testFileNameFallsBackToMp4() {
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "file:///x/a.thisisnotanextension"), "u.mp4")
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "file:///x/noextension"), "u.mp4")
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "file:///x/trailing."), "u.mp4")
        XCTAssertEqual(PublishModels.fileName(id: "u", path: "content://media/external/video/1.mov"), "u.mp4")
    }

    func testANamedFileKeepsItsName() {
        let named = PublishUpload(uploadId: "u", tag: "", path: "file:///x/a.mov", mimeType: "video/quicktime",
                                  url: nil, fileName: "final cut.mov", fields: [:])
        XCTAssertEqual(PublishModels.fileName(named), "final cut.mov")
    }

    // MARK: - Helpers

    private func parse(_ json: String) throws -> Any {
        try JSONSerialization.jsonObject(with: Data(json.utf8), options: [.fragmentsAllowed])
    }

    /// The id as `getState` puts it on the wire, inside an object so the output is a whole document.
    private func serialized(_ id: RemoteId) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: ["v": id.jsonValue], options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    private func upload(_ id: String, tag: String, remoteId: RemoteId) -> UploadRecord {
        UploadRecord(uploadId: id, tag: tag, path: "/tmp/\(id).mp4", mimeType: "video/mp4",
                     status: UploadStatus.done, remoteId: remoteId)
    }
}
