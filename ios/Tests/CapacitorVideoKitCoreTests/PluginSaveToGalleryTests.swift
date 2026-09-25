import Capacitor
import XCTest
@testable import CapacitorVideoKitCore

/// `saveToGallery` through the plugin, as far as it goes without the photo library: every way it
/// refuses before PhotoKit is asked anything, with the code a host switches on.
final class PluginSaveToGalleryTests: RenderTestCase {

    func testRequiresAURI() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToGallery, [:])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "uri is required")
    }

    func testRefusesAnUnknownDirectoryAsAndroidDoes() throws {
        let video = file("render.mp4")
        try Data([1]).write(to: video)
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToGallery,
                                               ["uri": video.absoluteString, "directory": "pictures"])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "directory is movies or dcim, not: pictures")
    }

    func testRefusesANestedAlbumAsAndroidDoes() throws {
        let video = file("render.mp4")
        try Data([1]).write(to: video)
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToGallery,
                                               ["uri": video.absoluteString, "album": "LightSnip/2026"])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "album is one folder name, not a path: LightSnip/2026")
    }

    func testChecksTheOptionsBeforeTheFile() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToGallery,
                                               ["uri": "content://media/external/video/media/1", "directory": "sdcard"])
        XCTAssertEqual(rejection.code, "invalid_spec")
    }

    func testReportsAURIThatIsNotAFileAsUnreadable() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToGallery,
                                               ["uri": "content://media/external/video/media/1", "directory": "dcim"])
        XCTAssertEqual(rejection.code, "unreadable_input")
    }

    func testReportsAMissingFileAsUnreadableBeforeAskingForAccess() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.saveToGallery,
                                               ["uri": file("never written.mp4").absoluteString, "album": "LightSnip"])
        XCTAssertEqual(rejection.code, "unreadable_input")
        XCTAssertTrue(rejection.message.hasPrefix("there is no file to read at "), rejection.message)
    }
}

/// One plugin method run the way the bridge runs it, on a plugin with no bridge under it, and
/// waited for until it settles - at once for a method that answers inline, later for one that
/// hands off to a `Task`. A `VideoComposerPlugin` unless another plugin is handed over.
enum PluginCalls {
    typealias Method = (VideoComposerPlugin) -> (CAPPluginCall) -> Void

    private enum Outcome {
        case resolved([String: Any])
        case rejected(message: String, code: String?)
    }

    /// What the method resolved with; a rejection fails the test with its message.
    static func resolve(_ method: Method, _ options: [String: Any]) throws -> [String: Any] {
        switch try run(method, options) {
        case let .resolved(data): return data
        case let .rejected(message, code): throw TestError("rejected \(code ?? "nil"): \(message)")
        }
    }

    /// What the method rejected with; resolving fails the test.
    static func reject(_ method: Method, _ options: [String: Any]) throws -> (message: String, code: String?) {
        try reject(VideoComposerPlugin(), method, options)
    }

    /// What a method of `plugin` rejected with; resolving fails the test.
    static func reject<Plugin: CAPPlugin>(_ plugin: Plugin, _ method: (Plugin) -> (CAPPluginCall) -> Void,
                                          _ options: [String: Any]) throws -> (message: String, code: String?) {
        switch try run(plugin, method, options) {
        case let .resolved(data): throw TestError("resolved with \(data)")
        case let .rejected(message, code): return (message, code)
        }
    }

    private static func run(_ method: Method, _ options: [String: Any]) throws -> Outcome {
        try run(VideoComposerPlugin(), method, options)
    }

    private static func run<Plugin: CAPPlugin>(_ plugin: Plugin, _ method: (Plugin) -> (CAPPluginCall) -> Void,
                                               _ options: [String: Any]) throws -> Outcome {
        let settled = XCTestExpectation(description: "the call settles")
        let lock = NSLock()
        var outcome: Outcome?
        let call = CAPPluginCall(
            callbackId: "test", methodName: "test",
            options: JSTypes.coerceDictionaryToJSObject(options) ?? [:],
            success: { result, _ in
                lock.lock(); outcome = .resolved(result?.data ?? [:]); lock.unlock()
                settled.fulfill()
            },
            error: { error in
                lock.lock(); outcome = .rejected(message: error?.message ?? "", code: error?.code); lock.unlock()
                settled.fulfill()
            })!
        method(plugin)(call)
        _ = XCTWaiter.wait(for: [settled], timeout: 10)
        lock.lock()
        defer { lock.unlock() }
        guard let outcome else { throw TestError("the call never settled") }
        return outcome
    }
}
