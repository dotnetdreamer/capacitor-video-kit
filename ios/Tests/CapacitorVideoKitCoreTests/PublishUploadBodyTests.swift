import Foundation
import XCTest
@testable import CapacitorVideoKitCore

/// The upload body on disk, and what the caller is told when one cannot be written.
final class PublishUploadBodyTests: RenderTestCase {

    // MARK: - PUT

    func testPutBodyIsTheFileVerbatim() throws {
        let source = try randomFile("clip.mp4", bytes: 3 << 20)
        let (request, upload) = batch(.put, source)

        let body = try UploadBody.write(request: request, upload: upload, into: file("bodies"))

        XCTAssertEqual(try Data(contentsOf: body.url), try Data(contentsOf: source))
        XCTAssertEqual(body.length, Int64(3 << 20))
        XCTAssertEqual(body.contentType, "video/mp4")
    }

    /// The reason the body is a copy at all: a task in flight sends what was there when its body
    /// was written, whatever the caller does to its own file meanwhile.
    func testPutBodyOutlivesTheCallerRewritingAndDeletingTheSource() throws {
        let source = try randomFile("clip.mp4", bytes: 1 << 20)
        let original = try Data(contentsOf: source)
        let (request, upload) = batch(.put, source)
        let body = try UploadBody.write(request: request, upload: upload, into: file("bodies"))

        let handle = try FileHandle(forWritingTo: source)
        try handle.write(contentsOf: Data(repeating: 0xAB, count: 4096))
        try handle.close()
        XCTAssertEqual(try Data(contentsOf: body.url), original)

        try FileManager.default.removeItem(at: source)
        XCTAssertEqual(try Data(contentsOf: body.url), original)
    }

    func testPutBodyThroughASymbolicLinkIsACopyOfTheTarget() throws {
        let target = try randomFile("target.mp4", bytes: 64 << 10)
        let link = file("link.mp4")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let (request, upload) = batch(.put, link)

        let body = try UploadBody.write(request: request, upload: upload, into: file("bodies"))

        let type = try FileManager.default.attributesOfItem(atPath: body.url.path)[.type] as? FileAttributeType
        XCTAssertEqual(type, .typeRegular)
        XCTAssertEqual(try Data(contentsOf: body.url), try Data(contentsOf: target))
    }

    func testRewritingABodyReplacesThePreviousOne() throws {
        let first = try randomFile("first.mp4", bytes: 10_000)
        let second = try randomFile("second.mp4", bytes: 5_000)
        let dir = file("bodies")
        let (firstRequest, firstUpload) = batch(.put, first)
        _ = try UploadBody.write(request: firstRequest, upload: firstUpload, into: dir)
        let (request, upload) = batch(.put, second)

        let body = try UploadBody.write(request: request, upload: upload, into: dir)

        XCTAssertEqual(try Data(contentsOf: body.url), try Data(contentsOf: second))
        XCTAssertEqual(body.length, 5_000)
    }

    /// A clone would keep a `complete` class, and `nsurlsessiond` could not read that body once
    /// the phone locked. It needs a volume that keeps the class, which the simulator's does not,
    /// so there it is skipped and `testStreamedCopyIsTheFileVerbatim` covers the copy itself.
    func testPutBodyOfATightlyProtectedFileTakesTheBodiesOwnClass() throws {
        let source = try randomFile("clip.mp4", bytes: 64 << 10)
        let fm = FileManager.default
        do {
            try fm.setAttributes([.protectionKey: FileProtectionType.complete], ofItemAtPath: source.path)
        } catch {
            throw XCTSkip("this volume has no data protection classes: \(error)")
        }
        guard protection(of: source) == .complete else { throw XCTSkip("this volume does not keep the class") }
        let (request, upload) = batch(.put, source)

        let body = try UploadBody.write(request: request, upload: upload, into: file("bodies"))

        XCTAssertNotEqual(protection(of: body.url), .complete)
        XCTAssertEqual(try Data(contentsOf: body.url), try Data(contentsOf: source))
        XCTAssertEqual(body.length, Int64(64 << 10))
    }

    /// The copy a tightly protected file gets instead of a clone, checked here directly because the
    /// simulator reports no class at all, so `write` never chooses it there.
    func testStreamedCopyIsTheFileVerbatim() throws {
        let source = try randomFile("clip.mp4", bytes: (3 << 20) + 17)
        let dest = file("streamed.body")

        try UploadBody.stream(source, to: dest)

        XCTAssertEqual(try Data(contentsOf: dest), try Data(contentsOf: source))
    }

    func testOnlyClassesReadableWhileLockedAreCloned() {
        XCTAssertTrue(UploadBody.clones(nil))
        XCTAssertTrue(UploadBody.clones(FileProtectionType.none))
        XCTAssertTrue(UploadBody.clones(.completeUntilFirstUserAuthentication))
        XCTAssertFalse(UploadBody.clones(.completeUnlessOpen))
        XCTAssertFalse(UploadBody.clones(.complete))
    }

    // MARK: - POST

    func testPostBodyIsTheFieldsThenTheFile() throws {
        let source = try randomFile("clip.mp4", bytes: 200_000)
        let (request, upload) = batch(.post, source, fields: ["qquuid": "{uploadId}", "a": "1"])

        let body = try UploadBody.write(request: request, upload: upload, into: file("bodies"))
        let bytes = try Data(contentsOf: body.url)

        let boundary = try XCTUnwrap(body.contentType.components(separatedBy: "boundary=").last)
        XCTAssertTrue(body.contentType.hasPrefix("multipart/form-data; "))
        let head = "--\(boundary)\r\nContent-Disposition: form-data; name=\"a\"\r\n\r\n1\r\n"
            + "--\(boundary)\r\nContent-Disposition: form-data; name=\"qquuid\"\r\n\r\nclip-1\r\n"
            + "--\(boundary)\r\nContent-Disposition: form-data; name=\"file\"; filename=\"clip-1.mp4\"\r\n"
            + "Content-Type: video/mp4\r\n\r\n"
        let tail = "\r\n--\(boundary)--\r\n"
        var expected = Data(head.utf8)
        expected.append(try Data(contentsOf: source))
        expected.append(Data(tail.utf8))
        XCTAssertEqual(bytes, expected)
        XCTAssertEqual(body.length, Int64(expected.count))
    }

    // MARK: - Failures

    func testMissingSourceIsFileMissingAndFinal() throws {
        let (request, upload) = batch(.put, file("gone.mp4"))

        XCTAssertThrowsError(try UploadBody.write(request: request, upload: upload, into: file("bodies"))) { error in
            let record = PublisherSession.bodyFailure(error, uploadId: upload.uploadId)
            XCTAssertEqual(record.code, FailureCode.fileMissing)
            XCTAssertEqual(record.message, "missing clip-1")
            XCTAssertFalse(record.retryable)
            XCTAssertEqual(record.phase, Phase.uploading)
            XCTAssertEqual(record.uploadId, "clip-1")
        }
    }

    /// Every send writes its body from the caller's file again, so a file deleted after the first
    /// one is missing for the next, as it is on Android and the web.
    func testTheNextSendReadsTheCallersFileAgain() throws {
        let source = try randomFile("clip.mp4", bytes: 10_000)
        let dir = file("bodies")
        let (request, upload) = batch(.put, source)
        _ = try UploadBody.write(request: request, upload: upload, into: dir)
        try FileManager.default.removeItem(at: source)

        XCTAssertThrowsError(try UploadBody.write(request: request, upload: upload, into: dir)) { error in
            let record = PublisherSession.bodyFailure(error, uploadId: upload.uploadId)
            XCTAssertEqual(record.code, FailureCode.fileMissing)
            XCTAssertFalse(record.retryable)
        }
    }

    /// Android's `length() == 0L` and the web runner's `blob.size === 0`: a render redone over the
    /// same path empties it first, and a presigned PUT would store the empty file as the video.
    func testEmptySourceIsFileMissingAndFinal() throws {
        let source = try randomFile("clip.mp4", bytes: 10_000)
        let dir = file("bodies")
        let (firstRequest, firstUpload) = batch(.put, source)
        _ = try UploadBody.write(request: firstRequest, upload: firstUpload, into: dir)
        try Data().write(to: source)

        for method in [UploadMethod.put, .post] {
            let (request, upload) = batch(method, source)
            XCTAssertThrowsError(try UploadBody.write(request: request, upload: upload, into: dir)) { error in
                let record = PublisherSession.bodyFailure(error, uploadId: upload.uploadId)
                XCTAssertEqual(record.code, FailureCode.fileMissing)
                XCTAssertEqual(record.message, "missing clip-1")
                XCTAssertFalse(record.retryable)
            }
        }
    }

    /// The size is the target's, not the link's own few dozen bytes.
    func testSymbolicLinkToAnEmptyFileIsMissing() throws {
        let target = file("empty.mp4")
        try Data().write(to: target)
        let link = file("link.mp4")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: target)
        let (request, upload) = batch(.put, link)

        XCTAssertNil(PublishModels.sourceFile(link.absoluteString))
        XCTAssertThrowsError(try UploadBody.write(request: request, upload: upload, into: file("bodies"))) { error in
            XCTAssertEqual(PublisherSession.bodyFailure(error, uploadId: upload.uploadId).code, FailureCode.fileMissing)
        }
    }

    func testDirectoryIsMissing() throws {
        let folder = file("folder.mp4")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        try Data(count: 10).write(to: folder.appendingPathComponent("inside"))

        XCTAssertNil(PublishModels.sourceFile(folder.absoluteString))
    }

    /// A source that is there but cannot be read says nothing about the caller's file being gone,
    /// and a half-written envelope must not be left holding the space.
    func testUnreadableSourceIsRetryableAndLeavesNoBody() throws {
        let source = try randomFile("clip.mp4", bytes: 10_000)
        try FileManager.default.setAttributes([.posixPermissions: 0], ofItemAtPath: source.path)
        defer { try? FileManager.default.setAttributes([.posixPermissions: 0o644], ofItemAtPath: source.path) }
        let dir = file("bodies")
        let (request, upload) = batch(.post, source)

        XCTAssertThrowsError(try UploadBody.write(request: request, upload: upload, into: dir)) { error in
            let record = PublisherSession.bodyFailure(error, uploadId: upload.uploadId)
            XCTAssertEqual(record.code, FailureCode.unknown)
            XCTAssertTrue(record.retryable)
            XCTAssertFalse(record.message.hasPrefix("no_space"))
        }
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.path), [])
    }

    func testFullDiskIsRetryableAndSaysNoSpace() {
        let direct = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteOutOfSpaceError)
        let buried = NSError(domain: NSCocoaErrorDomain, code: NSFileWriteUnknownError, userInfo: [
            NSUnderlyingErrorKey: NSError(domain: NSPOSIXErrorDomain, code: Int(ENOSPC)),
        ])
        for error in [direct, buried] {
            let record = PublisherSession.bodyFailure(error, uploadId: "clip-1")
            XCTAssertEqual(record.code, FailureCode.unknown)
            XCTAssertTrue(record.message.hasPrefix("no_space "), record.message)
            XCTAssertTrue(record.retryable)
            XCTAssertEqual(record.phase, Phase.uploading)
            XCTAssertEqual(record.uploadId, "clip-1")
            XCTAssertNil(record.httpStatus)
        }
    }

    func testAnyOtherWriteFailureIsRetryableUnknown() {
        let record = PublisherSession.bodyFailure(NSError(domain: NSCocoaErrorDomain, code: NSFileWriteNoPermissionError),
                                                  uploadId: "clip-1")
        XCTAssertEqual(record.code, FailureCode.unknown)
        XCTAssertTrue(record.message.hasPrefix(NSCocoaErrorDomain), record.message)
        XCTAssertTrue(record.retryable)
    }

    // MARK: - Helpers

    private func protection(of url: URL) -> FileProtectionType? {
        (try? FileManager.default.attributesOfItem(atPath: url.path))?[.protectionKey] as? FileProtectionType
    }

    private func randomFile(_ name: String, bytes: Int) throws -> URL {
        var data = Data(count: bytes)
        data.withUnsafeMutableBytes { arc4random_buf($0.baseAddress, bytes) }
        let url = file(name)
        try data.write(to: url)
        return url
    }

    /// One upload, `clip-1`, of `source`, sent the way `method` says.
    private func batch(_ method: UploadMethod, _ source: URL,
                       fields: [String: String] = [:]) -> (PublishRequest, PublishUpload) {
        let upload = PublishUpload(uploadId: "clip-1", tag: "clip", path: source.absoluteString,
                                   mimeType: "video/mp4", url: nil, fileName: nil, fields: [:])
        let request = PublishRequest(
            batchId: "batch-1",
            headers: [:],
            upload: PublishTransport(url: "https://example.test/upload", method: method, fileField: "file",
                                     fields: fields, idPath: nil, lookupUrlTemplate: nil),
            uploads: [upload],
            finalize: PublishFinalize(url: "https://example.test/finalize", method: .post,
                                      bodyTemplate: "{}", requirePath: nil))
        return (request, upload)
    }
}
