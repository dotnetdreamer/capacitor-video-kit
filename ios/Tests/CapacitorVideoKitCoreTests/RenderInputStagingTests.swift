import Capacitor
import XCTest
@testable import CapacitorVideoKitCore

/// `stageRenderInput` and `releaseRenderInputs`: a render input written a chunk at a time into the
/// kit's own folder, in the order the chunks were sent, and nothing outside that folder ever written
/// to or deleted, whatever name the page sends - and the launch sweep that clears what a killed
/// render left there, with the picked songs beside it.
///
/// The staging folder and the audio folder are emptied before and after every test, so what a test
/// finds in them is only what it put there.
final class RenderInputStagingTests: XCTestCase {

    /// Files and folders this test placed outside the two folders, removed in `tearDown`.
    private var placed: [URL] = []

    private let longAgo = Date().addingTimeInterval(-2 * 24 * 60 * 60)

    override func setUpWithError() throws {
        for folder in [StagedRenderInputs.folder, AudioFilePicker.folder] { try? FileManager.default.removeItem(at: folder) }
    }

    override func tearDownWithError() throws {
        for url in placed { try? FileManager.default.removeItem(at: url) }
        placed = []
        for folder in [StagedRenderInputs.folder, AudioFilePicker.folder] { try? FileManager.default.removeItem(at: folder) }
    }

    // MARK: - stage

    func testStartsANewFileNamedWithTheExtensionAndAppendsToIt() throws {
        let first = try StagedRenderInputs.stage(base64([1, 2, 3]), onto: nil, extension: ".wav")

        XCTAssertEqual(first.deletingLastPathComponent().path, StagedRenderInputs.folder.path)
        XCTAssertNotNil(UUID(uuidString: first.deletingPathExtension().lastPathComponent), first.lastPathComponent)
        XCTAssertEqual(first.pathExtension, "wav")

        XCTAssertEqual(try StagedRenderInputs.stage(base64([4, 5]), onto: first.absoluteString, extension: ".wav"), first)
        // A bare path names it too, and a later chunk's extension changes nothing.
        XCTAssertEqual(try StagedRenderInputs.stage(base64([6]), onto: first.path, extension: "mp3"), first)
        XCTAssertEqual(try Data(contentsOf: first), Data([1, 2, 3, 4, 5, 6]))

        let second = try StagedRenderInputs.stage(base64([7]), onto: nil, extension: ".wav")
        XCTAssertNotEqual(second, first, "every input is a file of its own")
    }

    func testTakesAnExtensionWithOrWithoutItsDotOrNoneAtAll() throws {
        XCTAssertEqual(try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "m4a").pathExtension, "m4a")
        XCTAssertEqual(try StagedRenderInputs.stage(base64([1]), onto: nil, extension: ".MOV").pathExtension, "MOV")
        for raw in [nil, "", "."] as [String?] {
            let file = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: raw)
            XCTAssertEqual(file.pathExtension, "", String(describing: raw))
            XCTAssertNotNil(UUID(uuidString: file.lastPathComponent))
        }
    }

    func testRefusesAnExtensionThatIsNotOne() throws {
        for raw in ["../x", "a.b", "wav ", "x/y", "..", String(repeating: "a", count: 17), "wäv"] {
            XCTAssertEqual(refusal { try StagedRenderInputs.stage(base64([1]), onto: nil, extension: raw) },
                           "\(raw) is not an extension")
        }
        XCTAssertEqual(staged(), [], "nothing written")
    }

    func testRefusesDataThatIsNotBase64AndLeavesNothingBehind() throws {
        XCTAssertEqual(refusal { try StagedRenderInputs.stage("not base64!", onto: nil, extension: "wav") },
                       "data is not base64")
        XCTAssertEqual(staged(), [])

        // An append of the same is refused before a byte is written.
        let file = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        XCTAssertNotNil(refusal { try StagedRenderInputs.stage("%%%", onto: file.absoluteString, extension: nil) })
        XCTAssertEqual(try Data(contentsOf: file), Data([1]))
    }

    func testAnEmptyChunkIsAnEmptyFile() throws {
        let file = try StagedRenderInputs.stage("", onto: nil, extension: "wav")
        XCTAssertEqual(try Data(contentsOf: file), Data())
    }

    func testRefusesToAppendToAnythingButAStagedFileThatIsThere() throws {
        let folder = StagedRenderInputs.folder
        let home = URL(fileURLWithPath: NSHomeDirectory())
        let outside = try place(home.appendingPathComponent("Documents/vk-test-\(UUID().uuidString).wav"))
        let besideFolder = try place(home.appendingPathComponent("tmp/vk-test-\(UUID().uuidString).wav"))
        let file = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        let nested = folder.appendingPathComponent("inner/clip.wav")
        try FileManager.default.createDirectory(at: nested.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1]).write(to: nested)
        // A link in the folder to a file outside it, which only something other than the kit could
        // have made: the name is in the folder, the file is not.
        let link = folder.appendingPathComponent("link.wav")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)

        for uri in [outside.absoluteString, outside.path,
                    folder.path + "/../" + besideFolder.lastPathComponent,
                    folder.absoluteString, folder.path, nested.absoluteString, link.absoluteString,
                    folder.appendingPathComponent("\(UUID().uuidString).wav").absoluteString,
                    file.lastPathComponent, "content://media/external/audio/media/42", ""] {
            XCTAssertEqual(refusal { try StagedRenderInputs.stage(base64([9]), onto: uri, extension: nil) },
                           "\(uri) is not a render input staged here")
        }
        for untouched in [outside, besideFolder, nested, file] {
            XCTAssertEqual(try Data(contentsOf: untouched), Data([1]), untouched.lastPathComponent)
        }
    }

    func testAnswersAStagedFileInTheSpellingItWasFirstGiven() throws {
        let file = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        let folder = StagedRenderInputs.folder.path
        for spelling in ["file://" + file.path, "file://localhost" + file.path,
                         folder + "/./" + file.lastPathComponent,
                         folder + "/../videokit-render-inputs/" + file.lastPathComponent] {
            XCTAssertEqual(try StagedRenderInputs.stage(base64([2]), onto: spelling, extension: nil).absoluteString,
                           file.absoluteString, spelling)
        }
        XCTAssertEqual(try Data(contentsOf: file), Data([1, 2, 2, 2, 2]))
    }

    // MARK: - release

    func testReleaseDeletesTheNamedStagedFilesAndNothingElse() throws {
        let folder = StagedRenderInputs.folder
        let released = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        let byPath = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: nil)
        let kept = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        let outside = try place(URL(fileURLWithPath: NSHomeDirectory())
            .appendingPathComponent("Documents/vk-test-\(UUID().uuidString).wav"))
        let link = folder.appendingPathComponent("link.wav")
        try FileManager.default.createSymbolicLink(at: link, withDestinationURL: outside)

        StagedRenderInputs.release([
            released.absoluteString, released.absoluteString, byPath.path,
            outside.absoluteString, link.absoluteString, folder.absoluteString,
            folder.path + "/../../Documents/" + outside.lastPathComponent,
            "content://media/external/audio/media/42", "",
        ])

        XCTAssertFalse(exists(released))
        XCTAssertFalse(exists(byPath))
        XCTAssertTrue(exists(kept), "not named")
        XCTAssertTrue(exists(outside), "never anything outside the folder, by any name")
        XCTAssertTrue(exists(folder))
    }

    // MARK: - The launch sweep

    func testTheLaunchSweepClearsStagedInputsADayOldAndEveryPickedSong() throws {
        let oldInput = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        try date(oldInput, longAgo)
        let freshInput = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        let songs = AudioFilePicker.folder
        try FileManager.default.createDirectory(at: songs, withIntermediateDirectories: true)
        let oldSong = songs.appendingPathComponent("\(UUID().uuidString).mp3")
        let freshSong = songs.appendingPathComponent("\(UUID().uuidString).mp3")
        for song in [oldSong, freshSong] { try Data([1]).write(to: song) }
        try date(oldSong, longAgo)

        JobFolders.sweep(now: Date())

        XCTAssertFalse(exists(oldInput))
        XCTAssertTrue(exists(freshInput), "a render may still be reading it")
        XCTAssertFalse(exists(oldSong))
        XCTAssertFalse(exists(freshSong), "read by a page that is gone, however recently")
    }

    // MARK: - Through the plugin

    func testStageRenderInputAnswersTheFileAndRefusesWhatThePageGotWrong() throws {
        let answer = try PluginCalls.resolve(VideoComposerPlugin.stageRenderInput,
                                             ["data": base64([1, 2]), "extension": ".wav"])
        let uri = try XCTUnwrap(answer["uri"] as? String)
        XCTAssertTrue(uri.hasPrefix("file://"), uri)
        let appended = try PluginCalls.resolve(VideoComposerPlugin.stageRenderInput, ["data": base64([3]), "uri": uri])
        XCTAssertEqual(appended["uri"] as? String, uri)
        let file = try XCTUnwrap(JobFolders.fileURL(from: uri))
        XCTAssertEqual(try Data(contentsOf: file), Data([1, 2, 3]))

        for (options, message) in [
            ([:], "data is required"),
            (["data": "!"], "data is not base64"),
            (["data": base64([1]), "extension": "../x"], "../x is not an extension"),
            (["data": base64([1]), "uri": "file:///etc/hosts"], "file:///etc/hosts is not a render input staged here"),
        ] as [([String: Any], String)] {
            let rejection = try PluginCalls.reject(VideoComposerPlugin.stageRenderInput, options)
            XCTAssertEqual(rejection.code, "invalid_spec", message)
            XCTAssertEqual(rejection.message, message)
        }
    }

    func testChunksSentWithoutWaitingAreWrittenInTheOrderTheyWereSent() throws {
        let first = try PluginCalls.resolve(VideoComposerPlugin.stageRenderInput, ["data": base64([0]), "extension": "wav"])
        let uri = try XCTUnwrap(first["uri"] as? String)
        let file = try XCTUnwrap(JobFolders.fileURL(from: uri))
        // One plugin, as a page has, handed every call before any has answered.
        let plugin = VideoComposerPlugin()
        let sent = Sent()

        let chunks = (1..<60).map { UInt8($0) }
        let written = chunks.map { sent.call(plugin.stageRenderInput, ["data": base64([$0]), "uri": uri]) }
        XCTAssertEqual(XCTWaiter.wait(for: written, timeout: 10), .completed)
        XCTAssertEqual(try Data(contentsOf: file), Data([0] + chunks))

        // A release sent straight after the last chunk finds every chunk written: had it run first,
        // the chunks after it would have been refused as naming nothing staged.
        let more = (60..<70).map { sent.call(plugin.stageRenderInput, ["data": base64([UInt8($0)]), "uri": uri]) }
        let released = sent.call(plugin.releaseRenderInputs, ["uris": [uri]])
        XCTAssertEqual(XCTWaiter.wait(for: more + [released], timeout: 10), .completed)
        XCTAssertEqual(sent.rejections, [])
        XCTAssertFalse(exists(file))
    }

    func testReleaseRenderInputsRequiresUrisAndPassesOverTheRest() throws {
        let rejection = try PluginCalls.reject(VideoComposerPlugin.releaseRenderInputs, [:])
        XCTAssertEqual(rejection.code, "invalid_spec")
        XCTAssertEqual(rejection.message, "uris is required")

        let file = try StagedRenderInputs.stage(base64([1]), onto: nil, extension: "wav")
        _ = try PluginCalls.resolve(VideoComposerPlugin.releaseRenderInputs, ["uris": [42, file.absoluteString] as [Any]])
        XCTAssertFalse(exists(file))
        _ = try PluginCalls.resolve(VideoComposerPlugin.releaseRenderInputs, ["uris": [String]()])
    }

    // MARK: - Helpers

    /// Calls handed to a plugin one after another without waiting for any, as a page that does not
    /// await sends them, and every rejection among them.
    private final class Sent: @unchecked Sendable {
        private let lock = NSLock()
        private var messages: [String] = []

        var rejections: [String] {
            lock.lock()
            defer { lock.unlock() }
            return messages
        }

        /// Hands `method` a call with `options`, and answers what is fulfilled when it settles.
        func call(_ method: (CAPPluginCall) -> Void, _ options: [String: Any]) -> XCTestExpectation {
            let settled = XCTestExpectation(description: "settled")
            let call = CAPPluginCall(
                callbackId: UUID().uuidString, methodName: "test",
                options: JSTypes.coerceDictionaryToJSObject(options) ?? [:],
                success: { _, _ in settled.fulfill() },
                error: { [self] error in
                    lock.lock()
                    messages.append(error?.message ?? "")
                    lock.unlock()
                    settled.fulfill()
                })!
            method(call)
            return settled
        }
    }

    private func base64(_ bytes: [UInt8]) -> String {
        Data(bytes).base64EncodedString()
    }

    /// The message `body` was refused with, or nil when it was not refused.
    private func refusal(_ body: () throws -> Any) -> String? {
        do {
            _ = try body()
            return nil
        } catch let refused as StagedRenderInputs.Refused {
            return refused.message
        } catch {
            XCTFail("not a refusal: \(error)")
            return nil
        }
    }

    /// The names in the staging folder.
    private func staged() -> [String] {
        (try? FileManager.default.contentsOfDirectory(atPath: StagedRenderInputs.folder.path)) ?? []
    }

    /// A file outside the two folders holding one byte, removed in `tearDown`.
    private func place(_ url: URL) throws -> URL {
        try FileManager.default.createDirectory(at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
        try Data([1]).write(to: url)
        placed.append(url)
        return url
    }

    private func date(_ url: URL, _ date: Date) throws {
        try FileManager.default.setAttributes([.modificationDate: date], ofItemAtPath: url.path)
    }

    private func exists(_ url: URL) -> Bool {
        FileManager.default.fileExists(atPath: url.path)
    }
}
