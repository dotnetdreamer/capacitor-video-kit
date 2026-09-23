import XCTest
@testable import CapacitorVideoKitCore

/// Which failures the publisher sends again on its own, before the caller hears of them.
final class PublishResendTests: XCTestCase {

    /// Android's workers and the web runner stop at once on a 401 or 403: the same token would meet
    /// the same answer, and only the caller's `retry()` brings a new one.
    func testAnAuthFailureWaitsForTheCaller() {
        for status in [401, 403] {
            let e = failure(FailureCode.auth, status: status, retryable: true)
            XCTAssertTrue(e.retryable)
            XCTAssertFalse(PublisherSession.resends(e))
        }
    }

    func testATransientFailureIsSentAgain() {
        XCTAssertTrue(PublisherSession.resends(failure(FailureCode.http, status: 503, retryable: true)))
        XCTAssertTrue(PublisherSession.resends(failure(FailureCode.network, status: nil, retryable: true)))
        XCTAssertTrue(PublisherSession.resends(failure(FailureCode.unknown, status: nil, retryable: true)))
    }

    func testAFinalFailureIsNotSentAgain() {
        XCTAssertFalse(PublisherSession.resends(failure(FailureCode.http, status: 404, retryable: false)))
        XCTAssertFalse(PublisherSession.resends(failure(FailureCode.serverRejected, status: 400, retryable: false)))
        XCTAssertFalse(PublisherSession.resends(PublisherSession.bodyFailure(UploadBodyError.sourceMissing("clip-1"),
                                                                             uploadId: "clip-1")))
    }

    private func failure(_ code: String, status: Int?, retryable: Bool) -> ErrorRecord {
        ErrorRecord(code: code, message: "", httpStatus: status, phase: Phase.uploading,
                    uploadId: "clip-1", retryable: retryable)
    }
}
