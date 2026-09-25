import Capacitor
import Foundation
import UIKit

/// The bridge surface of the video composer. Argument reading, rejections and event forwarding
/// only: every decision lives in `ComposeSpecParser`, `JobRegistry`, `JobFolders`, `Thumbnailer`,
/// `Gallery`, `GalleryLibrary`, `RetainedMedia`, `StagedRenderInputs`, `AudioFilePicker`,
/// `EncodeSupport` or `VoiceRecorder`, so this file stays readable next to the Kotlin it mirrors.
///
/// Capacitor calls each `@objc func` on its own serial queue, shared with every other plugin in the
/// app and never main, so nothing here does file or AV work inline: a method either answers from
/// memory or hands off to a `Task`, or to `staging` where the order of the calls matters. The
/// exceptions are `systemInsets` and `pickAudioFile`, which have to hop to main because UIKit says
/// so.
@objc(VideoComposerPlugin)
public class VideoComposerPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "VideoComposerPlugin"
    public let jsName = "VideoComposer"

    /// Twenty-eight entries. A method missing from this list is rejected by the bridge before this class
    /// is consulted, which is exactly what used to happen to `systemInsets`: the `@objc func` alone
    /// changes nothing. `addListener` / `removeListener` / `removeAllListeners` are special-cased
    /// by `CapacitorBridge.handleJSCall` before the list is read and stay off it.
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "compose", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cancel", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getState", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "probe", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "thumbnails", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "extractAudio", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listSounds", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "deleteSound", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "saveToGallery", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestGalleryAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "listGalleryVideos", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "galleryThumbnail", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resolveGalleryVideo", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "retainMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "checkMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "requestMediaAccess", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "sweepMedia", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pickAudioFile", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stageRenderInput", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "releaseRenderInputs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "startVoiceRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stopVoiceRecording", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "capabilities", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "encodeSupport", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "systemInsets", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "prepareJob", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "cleanup", returnType: CAPPluginReturnPromise),
    ]

    /// Android reads 160 from `call.getInt("maxHeight") ?: 160`; the editor relies on the default
    /// because its filmstrip never sends one.
    private static let defaultThumbnailHeight = 160

    override public func load() {
        // Capacitor iOS (8.5.2) calls `load()` as a bridge registers the plugin, on main, from the
        // bridge's init in `CAPBridgeViewController.loadView`, before the bridge loads its page: once
        // a launch in an app with one bridge. A web view reload does not call it again - a navigation
        // and a web content process that died only call `bridge.reset()`
        // (`WebViewDelegationHandler.swift:47` and `:166`), which drops the page's listeners and
        // stored calls and keeps this instance. The registry outlives every instance all the same,
        // and `attach` replays to a bridge built later in the same process whatever outcome the
        // page of an earlier one never collected.
        JobRegistry.shared.attach(emitter: self)
        JobFolders.sweepOnLaunch()
    }

    deinit {
        JobRegistry.shared.detach(self)
        // A bridge torn down in the middle of a take must not leave the microphone open. A web view
        // reload tears nothing down (see `load`), so this is not what closes a take a reload leaves.
        Task { await VoiceRecorder.shared.abandon() }
    }

    /// The registry's only way back to JS. `completed` and `failed` are retained until consumed, so
    /// an outcome that lands while the editor is being rebuilt is handed to the next listener.
    func emit(_ name: String, _ data: [String: Any], retain: Bool) {
        notifyListeners(name, data: data, retainUntilConsumed: retain)
    }

    // MARK: - compose

    @objc func compose(_ call: CAPPluginCall) {
        let spec: ComposeSpec
        do {
            spec = try ComposeSpecParser.parse(call)
        } catch let error as SpecError {
            call.reject(error.message, Reject.invalidSpec)
            return
        } catch {
            call.reject(error.localizedDescription, Reject.invalidSpec)
            return
        }

        // `jobId` is the contract's idempotency key: composing twice with one id starts one render.
        // Presence is the whole test, whatever state that job is in, and the answer is the same
        // payload a fresh compose gives. Rejecting here would be worse than useless - the app's
        // only real caller turns ANY compose rejection into "we could not build your video", so a
        // safe retry would read as a failure to the customer.
        guard !JobRegistry.shared.exists(spec.jobId) else {
            call.resolve(["jobId": spec.jobId])
            return
        }

        // The task is created inside `start`, before this call resolves, so a cancel arriving in
        // the next microsecond has something to cancel.
        JobRegistry.shared.start(spec: spec)
        call.resolve(["jobId": spec.jobId])

        // Everything that can still go wrong arrives as a `failed` EVENT. A malformed spec is a bug
        // in the caller; a render that cannot finish is an outcome, and the two are not reported
        // through the same channel.
    }

    // MARK: - cancel, getState

    @objc func cancel(_ call: CAPPluginCall) {
        guard let jobId = call.getString("jobId"), !jobId.isEmpty else {
            call.reject("jobId is required", Reject.invalidSpec)
            return
        }
        Task {
            // Awaited on purpose: JS calls `cleanup` the moment this resolves, and a directory
            // delete racing an export that is still flushing leaves a folder that will not go away.
            await JobRegistry.shared.cancel(jobId, reason: .cancelled)
            call.resolve()
        }
    }

    @objc func getState(_ call: CAPPluginCall) {
        guard let jobId = call.getString("jobId"), !jobId.isEmpty else {
            call.reject("jobId is required", Reject.invalidSpec)
            return
        }
        guard let state = JobRegistry.shared.stateJSON(jobId) else {
            // The documented signal that the process restarted. JS then starts over from its own
            // persisted manifest with a new jobId.
            call.reject("no job with id \(jobId)", Reject.jobNotFound)
            return
        }
        call.resolve(state)
    }

    // MARK: - probe, thumbnails

    @objc func probe(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        guard let url = JobFolders.fileURL(from: uri) else {
            call.reject("unreadable uri \(uri)", Reject.unreadableInput)
            return
        }
        Task {
            do {
                let result = try await Thumbnailer.probe(url)
                call.resolve(result.json)
            } catch {
                call.reject(ErrorMapping.describe(error), Reject.unreadableInput)
            }
        }
    }

    @objc func thumbnails(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        // An EMPTY array is legal and answers an empty `uris`; only an absent key is an error.
        guard let requested = call.getArray("timesMs") else {
            call.reject("timesMs is required", Reject.invalidSpec)
            return
        }
        guard let url = JobFolders.fileURL(from: uri) else {
            call.reject("unreadable uri \(uri)", Reject.unreadableInput)
            return
        }

        // Android reads each entry as a long that defaults to 0 and coerces to at least 0, so a
        // negative or non-numeric entry becomes the first frame rather than an error. The filmstrip
        // would rather show something.
        let timesMs: [Int64] = requested.map { value in
            guard let number = value as? NSNumber else { return 0 }
            return max(0, number.int64Value)
        }
        let maxHeight = call.getInt("maxHeight") ?? Self.defaultThumbnailHeight
        let precise = call.getBool("precise") ?? false

        Task {
            do {
                let urls = try await Thumbnailer.thumbnails(url,
                                                            timesMs: timesMs,
                                                            maxHeight: maxHeight,
                                                            precise: precise)
                call.resolve(["uris": urls.map { $0.absoluteString }])
            } catch {
                call.reject(ErrorMapping.describe(error), Reject.unreadableInput)
            }
        }
    }

    // MARK: - Sound library

    @objc func extractAudio(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        guard let url = JobFolders.fileURL(from: uri) else {
            call.reject("unreadable uri \(uri)", Reject.unreadableInput)
            return
        }
        let fileName = call.getString("fileName")
        let keep = call.getBool("keep") ?? true

        Task {
            do {
                guard let sound = try await SoundLibrary.extract(from: url, fileName: fileName, keep: keep) else {
                    // No audio track. A normal answer about a normal file, so it resolves rather
                    // than rejecting: the editor says so plainly and stays where it is.
                    call.resolve(["hasAudio": false])
                    return
                }
                var json = Self.soundJson(sound)
                json["hasAudio"] = true
                call.resolve(json)
            } catch let error as SoundLibrary.SoundError {
                switch error {
                case let .noSpace(needed, free):
                    call.reject("no_space need=\(needed) free=\(free)", Reject.noSpace)
                case let .exportFailed(message):
                    call.reject(message, Reject.unreadableInput)
                }
            } catch {
                call.reject(ErrorMapping.describe(error), Reject.unreadableInput)
            }
        }
    }

    @objc func listSounds(_ call: CAPPluginCall) {
        Task {
            call.resolve(["sounds": SoundLibrary.list().map { Self.soundJson($0) }])
        }
    }

    @objc func deleteSound(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required", Reject.invalidSpec)
            return
        }
        Task {
            SoundLibrary.delete(id: id)
            call.resolve()
        }
    }

    /// Copies a finished video into the photo library. See `Gallery` for why that is the only
    /// place on iOS where saving one means anything, and `Gallery.rejection` for the codes.
    @objc func saveToGallery(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        // The options before the file, as Android checks them: one it cannot honour is the
        // caller's mistake whatever the file turns out to be.
        let album: String?
        do {
            album = try Gallery.album(call.getString("album"), directory: call.getString("directory"))
        } catch {
            let rejection = Gallery.rejection(for: error)
            call.reject(rejection.message, rejection.code)
            return
        }
        guard let url = JobFolders.fileURL(from: uri) else {
            call.reject("unreadable uri \(uri)", Reject.unreadableInput)
            return
        }
        let fileName = call.getString("fileName")

        Task {
            do {
                let identifier = try await Gallery.save(url: url, fileName: fileName, album: album)
                call.resolve(["uri": identifier])
            } catch {
                let rejection = Gallery.rejection(for: error)
                call.reject(rejection.message, rejection.code)
            }
        }
    }

    // MARK: - Gallery library

    /// Asks to read the photo library when the person has not been asked, and answers with what the
    /// host may now see. Never rejects for a refusal: `denied` is an answer, and the host's fallback
    /// - the system picker - needs no permission at all.
    ///
    /// `images` is accepted and changes nothing: it asks Android for its second, pictures-only
    /// permission, and iOS's one photo library grant already covers pictures and videos alike.
    @objc func requestGalleryAccess(_ call: CAPPluginCall) {
        Task {
            call.resolve(["access": await GalleryLibrary.requestAccess()])
        }
    }

    /// A page of the library's videos, or of its videos and pictures together with `images`.
    @objc func listGalleryVideos(_ call: CAPPluginCall) {
        // Android clamps the same way, so a host gets the same page for the same numbers on both.
        let offset = max(0, call.getInt("offset") ?? 0)
        let limit = min(Self.maxGalleryPage, max(1, call.getInt("limit") ?? Self.defaultGalleryPage))
        let images = call.getBool("images") ?? false
        Task {
            do {
                let page = try GalleryLibrary.list(offset: offset, limit: limit, images: images)
                call.resolve(["videos": page.videos.map { Self.galleryVideoJson($0) }, "total": page.total])
            } catch {
                Self.rejectGallery(call, error)
            }
        }
    }

    /// One item, in the shape `GalleryVideo` describes. `kind` on every item, a video-only list's
    /// included, because Android always sends it and a host should not have to know which platform
    /// may leave it out.
    private static func galleryVideoJson(_ video: GalleryLibrary.Video) -> [String: Any] {
        ["id": video.id, "fileName": video.fileName, "durationMs": video.durationMs,
         "kind": video.image ? "image" : "video"]
    }

    @objc func galleryThumbnail(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required", Reject.invalidSpec)
            return
        }
        let maxSize = min(1024, max(64, call.getInt("maxSize") ?? Self.defaultGalleryThumbnail))
        Task {
            do {
                let url = try await GalleryLibrary.thumbnail(id: id, maxSize: maxSize)
                call.resolve(["uri": url.absoluteString])
            } catch {
                Self.rejectGallery(call, error)
            }
        }
    }

    /// The asset's video, or its picture, copied into the app's own storage: see `GalleryLibrary`
    /// for why iOS is the one platform that needs a copy before anything can read it.
    @objc func resolveGalleryVideo(_ call: CAPPluginCall) {
        guard let id = call.getString("id"), !id.isEmpty else {
            call.reject("id is required", Reject.invalidSpec)
            return
        }
        Task {
            do {
                let resolved = try await GalleryLibrary.resolve(id: id)
                call.resolve(["uri": resolved.url.absoluteString, "fileName": resolved.fileName])
            } catch {
                Self.rejectGallery(call, error)
            }
        }
    }

    private static func rejectGallery(_ call: CAPPluginCall, _ error: Error) {
        switch error {
        case GalleryLibrary.LibraryError.permissionDenied:
            call.reject("The photo library is not available to this app", Reject.permissionDenied)
        case let GalleryLibrary.LibraryError.notFound(message),
             let GalleryLibrary.LibraryError.unreadable(message):
            call.reject(message, Reject.unreadableInput)
        default:
            call.reject(ErrorMapping.describe(error), Reject.unreadableInput)
        }
    }

    /// A gallery page when the host does not say, and the most one answer carries. Match Android.
    private static let defaultGalleryPage = 60
    private static let maxGalleryPage = 500

    /// The long edge of a gallery thumbnail when the host does not say. Matches Android.
    private static let defaultGalleryThumbnail = 384

    /// One sound, in the shape `SavedSoundResult` describes. `hasAudio` is the caller's to add.
    private static func soundJson(_ sound: SoundLibrary.Sound) -> [String: Any] {
        var json: [String: Any] = [
            "id": sound.id,
            "uri": sound.url.absoluteString,
            "fileName": sound.fileName,
            "durationMs": sound.durationMs,
            "savedAt": sound.savedAt,
        ]
        if let sourceName = sound.sourceName { json["sourceName"] = sourceName }
        return json
    }

    // MARK: - Retained media

    /// The longest-lived name for a file a picker handed over. See `RetainedMedia` for why iOS moves
    /// the file where Android keeps a permission, and `RetainedMedia.retain` for every answer.
    ///
    /// Rejects only when there is no uri at all. Every other way a retain can fall short is an
    /// answer, `durable: false`, because the name still plays for the rest of the session.
    @objc func retainMedia(_ call: CAPPluginCall) {
        guard let uri = call.getString("uri"), !uri.isEmpty else {
            call.reject("uri is required", Reject.invalidSpec)
            return
        }
        Task {
            let retained = RetainedMedia.retain(uri)
            call.resolve(["uri": retained.uri, "durable": retained.durable])
        }
    }

    /// Whether a stored name still opens, and the name to open it by in this install, which is a
    /// different one only for a name stored before an update moved the app's container. Never
    /// rejects: a missing uri names nothing that opens.
    @objc func checkMedia(_ call: CAPPluginCall) {
        let uri = call.getString("uri") ?? ""
        Task {
            let checked = RetainedMedia.check(uri)
            call.resolve(["exists": checked.exists, "uri": checked.uri])
        }
    }

    /// Always granted, and asks nothing.
    ///
    /// On Android this is the right to go on reading a MediaStore name after a restart. iOS has no
    /// such right to ask for: PHPicker and the document picker run outside the app and hand over a
    /// copy, and `retainMedia` keeps that copy inside the app's own container, where nothing needs a
    /// permission to open it again. Asking for the photo library here would put up a prompt that
    /// changes nothing for the pick, and `images` means nothing on iOS for the same reason. A host
    /// that draws its own gallery asks `requestGalleryAccess`, which is another grant.
    @objc func requestMediaAccess(_ call: CAPPluginCall) {
        call.resolve(["granted": true])
    }

    /// Deletes the kit's own copies among `uris`, except those `keep` also names, and passes over
    /// every other name. See `RetainedMedia.release`.
    ///
    /// An absent `uris` is the caller's mistake and says so, as an absent `timesMs` does; an EMPTY
    /// one is legal and deletes nothing. An absent `keep` is legal too, and spares nothing: unlike
    /// `sweepMedia`'s, it cannot widen what goes, which is never more than `uris` names. A JSON null
    /// is absent - the bridge hands it over as `NSNull` - as Android's and the web's `releaseMedia`
    /// read it. A `keep` that is anything else and not a list is refused before anything is deleted,
    /// because `getArray` answers nil for it just as for an absent one: a host that put one name
    /// where the list belongs meant to spare that copy, and read as absent it would delete exactly
    /// what it was there to keep. An entry of either list that is not a string names nothing.
    @objc func releaseMedia(_ call: CAPPluginCall) {
        guard let uris = call.getArray("uris") else {
            call.reject("uris is required", Reject.invalidSpec)
            return
        }
        let given = call.options["keep"]
        let keep = call.getArray("keep")
        guard keep != nil || given == nil || given is NSNull else {
            call.reject("keep must be a list of uris", Reject.invalidSpec)
            return
        }
        let names = uris.compactMap { $0 as? String }
        let kept = (keep ?? []).compactMap { $0 as? String }
        Task {
            RetainedMedia.release(names, keep: kept)
            call.resolve()
        }
    }

    /// Deletes every copy of the kit's that `keep` does not name and that is dated before `before`,
    /// in milliseconds since the epoch. See `RetainedMedia.sweep`.
    ///
    /// Both are required, and an absent one is refused rather than given a default: `keep` read as
    /// empty would delete every copy a draft still uses, and `before` read as now would take a clip
    /// being picked this moment. An EMPTY `keep` is legal and means exactly what it says.
    @objc func sweepMedia(_ call: CAPPluginCall) {
        guard let keep = call.getArray("keep") else {
            call.reject("keep is required", Reject.invalidSpec)
            return
        }
        guard let before = call.getDouble("before"), before.isFinite else {
            call.reject("before is required", Reject.invalidSpec)
            return
        }
        let names = keep.compactMap { $0 as? String }
        Task {
            let removed = RetainedMedia.sweep(keep: names, before: Date(timeIntervalSince1970: before / 1000))
            call.resolve(["removed": removed])
        }
    }

    // MARK: - Audio picker

    /// The picker `pickAudioFile` has put up, until it answers. Touched on main only.
    private var audioPicker: AudioFilePicker?

    /// One audio file from the phone's files, through the document picker: `{ cancelled: true }` for
    /// a cancel, and otherwise the `file://` name of a copy the page reads, the name the file had and
    /// its type. See `AudioFilePicker` for why iOS has a native picker for this at all, and where the
    /// copy lives and for how long.
    ///
    /// Rejects `already_picking` while a picker it put up is still open - on screen, or asked for
    /// and still on its way up, which a double tap lands in - rather than stacking a second over it
    /// and leaving the first to answer nobody. A picker that is no longer open, gone without saying
    /// so or never come up, is answered as a cancel first, so one lost callback cannot refuse every
    /// pick after it (see `AudioFilePicker.isOpen`); one UIKit never put up is answered as a cancel
    /// on its own besides, once `AudioFilePicker.presentationGrace` has passed, so a page that waits
    /// for this answer before it asks again is not left waiting for good. With no view controller
    /// to present from - a bridge with no screen - it rejects as unavailable, which is Capacitor's
    /// own `UNAVAILABLE`, and so it does when the view controller is in no window, which UIKit
    /// would put nothing up over and so leave the call waiting for an answer that cannot come (see
    /// `AudioFilePicker.present`). A song that picked but would not copy rejects `no_space` or
    /// `unknown`, as `stageRenderInput` does.
    @objc func pickAudioFile(_ call: CAPPluginCall) {
        Task { @MainActor in
            self.presentAudioPicker(call)
        }
    }

    @MainActor
    private func presentAudioPicker(_ call: CAPPluginCall) {
        if let open = audioPicker {
            guard !open.isOpen() else {
                call.reject("the audio picker is already open", Reject.alreadyPicking)
                return
            }
            open.settle(nil)
        }
        guard let presenter = bridge?.viewController else {
            call.unavailable("there is no screen to show the audio picker on")
            return
        }
        let picker = AudioFilePicker { [weak self] picked in
            self?.audioPicker = nil
            guard let picked else {
                call.resolve(AudioFilePicker.cancelled)
                return
            }
            Self.keep(picked, answering: call)
        }
        guard picker.present(from: presenter) else {
            call.unavailable("the audio picker could not be shown")
            return
        }
        audioPicker = picker
    }

    /// Answers `call` with the copy `AudioFilePicker.keep` makes of `picked`, made off main - every
    /// song is a copy of every byte, and one still in iCloud a download first, while main is drawing
    /// the picker away - and on `AudioFilePicker.copies`, one song at a time and in turn with the
    /// clear each load makes.
    private static func keep(_ picked: URL, answering call: CAPPluginCall) {
        AudioFilePicker.copies.async {
            do {
                call.resolve(try AudioFilePicker.keep(picked).json)
            } catch {
                rejectWrite(call, error)
            }
        }
    }

    // MARK: - Render inputs

    /// Where `stageRenderInput` and `releaseRenderInputs` run, one call at a time and in the order the
    /// calls came, as Android's `stagingScope` runs them. The chunks of one input are appended in the
    /// order they were sent only if they are WRITTEN in that order: the Capacitor queue hands them
    /// over in order, and `Task`s would not keep it for a page that sends the next chunk before the
    /// last has answered. A release waits here behind any chunk still being written, so a release
    /// sent straight after the last append finds the file finished rather than racing it.
    private static let staging = DispatchQueue(label: "net.dotnetdreamer.videokit.staging", qos: .userInitiated)

    /// Writes one base64 chunk of a render input the page holds only as bytes, and answers the
    /// `file://` URI of the file it went into. Without `uri` the chunk starts a new file, named with
    /// `extension` when there is one; with it, the chunk is appended to the file `uri` names, which
    /// must be one this call made. See `StagedRenderInputs` for why there is such a file, and why it
    /// may only be one of the kit's own.
    ///
    /// Rejects `invalid_spec` for a call the page got wrong: no `data`, data that is not base64, an
    /// extension that is not one, a `uri` that names anything but a staged file that is still there.
    /// A disk that would not take the chunk is `no_space`, and any other failed write is `unknown`,
    /// in the system's words. Android's `stageRenderInput` gives each the same code.
    @objc func stageRenderInput(_ call: CAPPluginCall) {
        guard let data = call.getString("data") else {
            call.reject("data is required", Reject.invalidSpec)
            return
        }
        let uri = call.getString("uri")
        let fileExtension = call.getString("extension")
        Self.staging.async {
            do {
                let file = try StagedRenderInputs.stage(data, onto: uri, extension: fileExtension)
                call.resolve(["uri": file.absoluteString])
            } catch let refused as StagedRenderInputs.Refused {
                call.reject(refused.message, Reject.invalidSpec)
            } catch {
                Self.rejectWrite(call, error)
            }
        }
    }

    /// Deletes the staged render inputs among `uris`, and passes over every other name without a
    /// word: a page releases everything it staged in a `finally`, whatever became of each file, and a
    /// name that is not a staged file is one there is nothing to do about. An absent `uris` is refused
    /// as `releaseMedia` refuses one; an empty one is legal.
    @objc func releaseRenderInputs(_ call: CAPPluginCall) {
        guard let uris = call.getArray("uris") else {
            call.reject("uris is required", Reject.invalidSpec)
            return
        }
        let names = uris.compactMap { $0 as? String }
        Self.staging.async {
            StagedRenderInputs.release(names)
            call.resolve()
        }
    }

    /// A file the kit was writing for the page that would not write: `no_space` for a full disk,
    /// which a host tells the person about, and `unknown` for anything else, in the system's words.
    /// Android's `ErrorMapping.hasNoSpaceCause` draws the same line.
    private static func rejectWrite(_ call: CAPPluginCall, _ error: Error) {
        let code = ErrorMapping.isOutOfSpace(error) ? Reject.noSpace : ComposeFailureCode.unknown.rawValue
        call.reject(ErrorMapping.describe(error), code)
    }

    // MARK: - Voice

    /// `batchId` only says where the take is kept, and an id `compose` would refuse is a take with
    /// no batch rather than a refusal (`VoiceRecorder.folder(for:)`).
    @objc func startVoiceRecording(_ call: CAPPluginCall) {
        let batchId = call.getString("batchId")
        Task {
            do {
                // The permission prompt happens inside this one await, so the JS promise still
                // settles exactly once whether or not the customer is asked.
                try await VoiceRecorder.shared.start(batchId: batchId)
                call.resolve()
            } catch let error as VoiceError {
                switch error {
                case .alreadyRecording:
                    call.reject("already_recording", Reject.alreadyRecording)
                case .permissionDenied:
                    call.reject("microphone permission denied", Reject.permissionDenied)
                default:
                    call.reject("recording_failed", Reject.recordingFailed)
                }
            } catch {
                call.reject("recording_failed", Reject.recordingFailed)
            }
        }
    }

    @objc func stopVoiceRecording(_ call: CAPPluginCall) {
        Task {
            do {
                let take = try await VoiceRecorder.shared.stop()
                call.resolve(["uri": take.url.absoluteString, "durationMs": take.durationMs])
            } catch let error as VoiceError {
                switch error {
                case .notRecording:
                    call.reject("not recording", Reject.notRecording)
                default:
                    call.reject("recording_failed", Reject.recordingFailed)
                }
            } catch {
                call.reject("recording_failed", Reject.recordingFailed)
            }
        }
    }

    // MARK: - capabilities, systemInsets

    @objc func capabilities(_ call: CAPPluginCall) {
        // `avc1` with no profile or level, matching Android, because no single RFC 6381 string is
        // true of every render. The writer engine encodes H.264 High at a level the encoder chooses
        // for each render's frame size and rate - 720p30 fits 3.1, 4K60 needs 5.2 - and the preset
        // fallback picks a profile and a level of its own, so a string such as `avc1.640028` would
        // be a promise about some renders made in the name of all of them. The lab compares this
        // string across the two platforms literally.
        call.resolve([
            "supported": true,
            "videoCodec": "avc1",
            "audioCodec": "mp4a.40.2",
            "container": "mp4",
            "voiceRecording": true,
        ])
    }

    /// Which of the frames an editor would like to offer this device's encoder will actually take,
    /// at the rate it would be asked for. `EncodeSupport` asks VideoToolbox, both ways round, and
    /// keeps every answer for the life of the process.
    ///
    /// Never rejects. A frame this device will not take is a row that says so, with a sentence for
    /// the customer, which is what the ladder greys out.
    @objc func encodeSupport(_ call: CAPPluginCall) {
        let frames = call.getArray("frames", JSObject.self) ?? []
        var answers: [JSObject] = []
        for frame in frames {
            let width = frame["width"] as? Int ?? 0
            let height = frame["height"] as? Int ?? 0
            let fps = frame["fps"] as? Int ?? 30
            let support = EncodeSupport.shared.answer(width: width, height: height, fps: fps)
            var answer: JSObject = ["width": width, "height": height, "fps": fps, "supported": support.supported]
            if let reason = support.reason { answer["reason"] = reason }
            answers.append(answer)
        }
        call.resolve(["frames": answers])
    }

    /// How much of the WebView the system bars actually cover.
    ///
    /// `UIView.safeAreaInsets` IS the overlap of the safe area with that view's own bounds, which
    /// is the semantics the contract asks for: a WebView laid out clear of the bars reports 0 and
    /// the editor never double-pads. Android has no per-view safe area and computes the overlap by
    /// hand against the decor view, and it divides by `displayMetrics.density` - on iOS one CSS
    /// pixel IS one point, so there is nothing to divide and nothing to port.
    @objc func systemInsets(_ call: CAPPluginCall) {
        // `.async` and never `.sync`: a main-thread wait from the Capacitor queue deadlocks.
        DispatchQueue.main.async { [weak self] in
            guard let view: UIView = self?.bridge?.webView ?? self?.bridge?.viewController?.view else {
                // No view is not an error. The editor falls back to its own env() padding, which is
                // right often enough, and a rejection here would be noise in every log.
                call.resolve(["top": 0, "bottom": 0])
                return
            }
            let insets = view.safeAreaInsets
            call.resolve(["top": Double(insets.top), "bottom": Double(insets.bottom)])
        }
    }

    // MARK: - prepareJob, cleanup

    /// `batchId` is refused as `invalid_spec` when it is missing or names no folder of its own,
    /// `.` and `..` (`JobFolders.batchIdRefusal`), before anything is written: Android refuses the
    /// same ids with the same words.
    @objc func prepareJob(_ call: CAPPluginCall) {
        let batchId = call.getString("batchId") ?? ""
        if let refusal = JobFolders.batchIdRefusal(batchId) {
            call.reject(refusal, Reject.invalidSpec)
            return
        }
        guard let raw = call.getArray("inputs") else {
            call.reject("inputs is required", Reject.invalidSpec)
            return
        }

        var inputs: [(key: String, uri: String)] = []
        inputs.reserveCapacity(raw.count)
        for (index, element) in raw.enumerated() {
            // An element that is not an object at all is skipped, matching Android's
            // `optJSONObject(i) ?: continue`; an object missing a field is a caller bug and says so.
            var object: [String: Any]?
            if let typed = element as? JSObject { object = typed }
            else if let loose = element as? [String: Any] { object = loose }
            guard let object else { continue }

            guard let key = object["key"] as? String, !key.isEmpty,
                  let uri = object["uri"] as? String, !uri.isEmpty else {
                call.reject("inputs[\(index)] needs a key and a uri", Reject.invalidSpec)
                return
            }
            inputs.append((key: key, uri: uri))
        }

        Task {
            do {
                let prepared = try JobFolders.prepareJob(batchId: batchId, inputs: inputs)
                // Keys are echoed back exactly as they came in, never sanitised: JS maps its
                // manifest by the key it sent. Only the file name on disk is sanitised.
                call.resolve([
                    "jobDir": prepared.jobDir.absoluteString,
                    "inputs": prepared.inputs.map { ["key": $0.key, "uri": $0.uri] },
                ])
            } catch let failure as PrepareFailure {
                call.reject(failure.message, failure.code)
            } catch {
                call.reject("could not place inputs for \(batchId): \(error.localizedDescription)",
                            Reject.io)
            }
        }
    }

    /// Refuses `batchId` as `prepareJob` does, so a discard of `..` deletes nothing at all rather
    /// than the folder `JobFolders.folderName` would put it in, which is the batch `__`'s.
    @objc func cleanup(_ call: CAPPluginCall) {
        let batchId = call.getString("batchId") ?? ""
        if let refusal = JobFolders.batchIdRefusal(batchId) {
            call.reject(refusal, Reject.invalidSpec)
            return
        }
        Task {
            // Cancels every job for the post with its events suppressed, forgets them so a later
            // `getState` answers `job_not_found`, and only then deletes the folder. Idempotent: a
            // folder that was never created resolves just the same.
            await JobRegistry.shared.cleanup(batchId: batchId)
            call.resolve()
        }
    }
}
