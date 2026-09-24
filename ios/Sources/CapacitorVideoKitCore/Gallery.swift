import Foundation
import Photos
import UniformTypeIdentifiers

/**
 A finished video, put where the phone's own gallery will show it.

 The photo library IS the gallery on iOS - there is no folder a file can be written into that
 anything indexes, so a copy into the app's own Documents is a video only this app can open. What
 counts is a `PHAssetCreationRequest`, which is what puts the video in Recents; the album, when one
 is asked for, is a `PHAssetCollection` the new asset is then added to, because an album here holds
 references rather than files.

 `directory` is checked and then has no effect. On Android it chooses between the two folders a
 gallery indexes; iOS has one library and no folders in it, so honouring the option would mean
 inventing a distinction that does not exist. A value Android would refuse is refused here too,
 though, so a typo fails on both platforms rather than only on one.
 */
enum Gallery {

    enum GalleryError: Error {
        /// The person said no, or the library is switched off for this app in Settings.
        case permissionDenied
        /// An option that cannot be honoured: Android's `IllegalArgumentException`, `invalid_spec`
        /// on both.
        case invalidOption(String)
        /// No file at that URL, or nothing that can be read as one.
        case unreadable(String)
        /// The library answered neither with the video nor with an error saying why not.
        case saveFailed(String)
    }

    /**
     The album a save is filed under, or nil for none, once the options have been checked.

     Android's checks, in Android's order and with its words: `directory` first, then `album`. A
     separator in the album name would be a caller asking for a nested album, which the photo library
     cannot express at all, and `.` or `..` is a folder Android would make on disk below API 29 that
     is not a folder of its own - `..` puts the video beside `Movies` - though a photo library would
     take either as a title. Refused rather than flattened, so the same options do the same thing on
     both platforms instead of quietly doing different ones (Android's `Gallery.albumOf`).
     */
    static func album(_ album: String?, directory: String?) throws -> String? {
        switch directory?.lowercased() {
        case nil, "", "movies", "dcim":
            break
        default:
            throw GalleryError.invalidOption("directory is movies or dcim, not: \(directory ?? "")")
        }
        let name = album?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if let name, name.contains("/") || name.contains("\\") || name == "." || name == ".." {
            throw GalleryError.invalidOption("album is one folder name, not a path: \(name)")
        }
        return name
    }

    /**
     Copies `url` into the photo library and answers with the new asset's local identifier, as the
     `ph://` URI the contract documents.

     An identifier rather than a path, which is all iOS ever gives out: the file itself lives inside
     the library, where no app reaches it directly. `album` is what `album(_:directory:)` answered.

     The name is handed to PhotoKit with the file rather than put on a copy of it:
     `PHAssetResourceCreationOptions.originalFilename` is exactly "call it this", and a whole second
     video in a temporary folder is what a nearly full phone would fail to write.
     */
    static func save(url: URL, fileName: String?, album: String?) async throws -> String {
        guard FileManager.default.isReadableFile(atPath: url.path) else {
            throw GalleryError.unreadable("there is no file to read at \(url.path)")
        }

        let mayFile = try await requestPermission(album: album != nil)
        let collection = mayFile ? album.flatMap { albumCollection(named: $0) } : nil

        let options = PHAssetResourceCreationOptions()
        // Copied, never moved: the source is the app's own render and the caller may still want it.
        options.shouldMoveFile = false
        if let name = fileName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty {
            options.originalFilename = name
            // PhotoKit reads the type off the file's extension. A file a host kept without one
            // takes it from the name it is being saved under instead.
            let ext = (name as NSString).pathExtension
            if url.pathExtension.isEmpty, !ext.isEmpty, let type = UTType(filenameExtension: ext) {
                options.uniformTypeIdentifier = type.identifier
            }
        }

        return try await withCheckedThrowingContinuation { continuation in
            var identifier: String?
            PHPhotoLibrary.shared().performChanges {
                let request = PHAssetCreationRequest.forAsset()
                request.addResource(with: .video, fileURL: url, options: options)
                guard let placeholder = request.placeholderForCreatedAsset else { return }
                identifier = placeholder.localIdentifier

                if let collection, let add = PHAssetCollectionChangeRequest(for: collection) {
                    add.addAssets([placeholder] as NSArray)
                }
            } completionHandler: { done, error in
                if let error {
                    // As it came, so `rejection(for:)` can read the space and access codes off it.
                    continuation.resume(throwing: error)
                } else if done, let identifier {
                    continuation.resume(returning: "ph://\(identifier)")
                } else {
                    continuation.resume(throwing: GalleryError.saveFailed("the photo library refused the video"))
                }
            }
        }
    }

    /**
     The message and `code` a failed save is rejected with.

     Always one of `SaveToGalleryFailureCode`, plus the `invalid_spec` Android answers an option it
     cannot honour with - never `io`, which a host switching on that union has no case for. A full
     disk is `no_space` wherever it surfaces, so the host can say "free up space" rather than
     "try again"; a file PhotoKit cannot read as a video is `unreadable_input`, as a missing one is;
     and whatever else the library says is `unknown`, with its words as the message.
     */
    static func rejection(for error: Error) -> (message: String, code: String) {
        switch error {
        case GalleryError.permissionDenied:
            return ("The photo library is not available to this app", Reject.permissionDenied)
        case let GalleryError.invalidOption(message):
            return (message, Reject.invalidSpec)
        case let GalleryError.unreadable(message):
            return (message, Reject.unreadableInput)
        case let GalleryError.saveFailed(message):
            return (message, ComposeFailureCode.unknown.rawValue)
        default:
            break
        }

        let message = ErrorMapping.describe(error)
        if ErrorMapping.isOutOfSpace(error) { return (message, Reject.noSpace) }
        let nsError = error as NSError
        if nsError.domain == PHPhotosErrorDomain {
            switch PHPhotosError.Code(rawValue: nsError.code) {
            case .notEnoughSpace:
                return (message, Reject.noSpace)
            case .accessUserDenied, .accessRestricted:
                return (message, Reject.permissionDenied)
            case .invalidResource, .missingResource:
                return (message, Reject.unreadableInput)
            default:
                break
            }
        }
        return (message, ComposeFailureCode.unknown.rawValue)
    }

    /// What a save that was asked for an album does about it, given the read/write access held.
    enum AlbumStep: Equatable {
        /// Ask for read/write access before saving; the one prompt settles adding too.
        case ask
        /// File the video into the album.
        case file
        /// Save it to Recents and leave the album out.
        case skip
    }

    /**
     Whether an album can be had, and what it takes.

     Finding an album and making one both need read/write access, which add-only access does not
     include, so with add-only access PhotoKit refuses both and the album would be dropped without
     a word. So when read/write access has never been asked about, THAT is what is asked.

     Only when the host is allowed to ask, though: iOS terminates an app that asks for read/write
     access without `NSPhotoLibraryUsageDescription` in its `Info.plist`, and the README tells a
     host that only saves that `NSPhotoLibraryAddUsageDescription` is all it needs. Such a host's
     saves go to Recents with the album left out, rather than taking the app down on the first one.

     Only full access files into the album. With add-only access there is no album to be had; with a
     limited grant PhotoKit does not promise that an album made on an earlier save is visible, and
     not seeing it would make another album of the same name on every save. Either way the video is
     still saved, in Recents, and skipping the album on purpose beats a shelf of duplicates.
     */
    static func albumStep(readWrite: PHAuthorizationStatus, hostDeclaresReading: Bool) -> AlbumStep {
        guard hostDeclaresReading else { return .skip }
        switch readWrite {
        case .notDetermined: return .ask
        case .authorized: return .file
        default: return .skip
        }
    }

    /**
     Permission to add, and whether the video may be filed in an album as well (`albumStep`).

     `.addOnly` is all the save itself needs, and asking for `.readWrite` for that alone would put
     a prompt about every photo they own in front of the person in exchange for writing one video.
     With an album it is the one prompt, and it has a price: photo library access is one setting
     per app, so a person who answers it with Don't Allow may have refused adding along with
     reading, and then the save is refused with `permission_denied` where an add-only prompt might
     have been allowed.
     */
    private static func requestPermission(album: Bool) async throws -> Bool {
        let declared = hostDeclaresReading
        if album, albumStep(readWrite: PHPhotoLibrary.authorizationStatus(for: .readWrite),
                            hostDeclaresReading: declared) == .ask {
            _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        try await requestAddPermission()
        return album && albumStep(readWrite: PHPhotoLibrary.authorizationStatus(for: .readWrite),
                                  hostDeclaresReading: declared) == .file
    }

    /// Whether the host's `Info.plist` says why it reads the photo library, which is what lets it
    /// ask to at all.
    private static var hostDeclaresReading: Bool {
        Bundle.main.object(forInfoDictionaryKey: "NSPhotoLibraryUsageDescription") != nil
    }

    /**
     Permission to ADD, which is narrower than permission to read, asked for when it has not been
     settled - which after a read/write prompt it usually already has.
     */
    private static func requestAddPermission() async throws {
        let current = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        if current == .authorized || current == .limited { return }
        if current == .denied || current == .restricted { throw GalleryError.permissionDenied }

        let granted = await withCheckedContinuation { continuation in
            PHPhotoLibrary.requestAuthorization(for: .addOnly) { continuation.resume(returning: $0) }
        }
        guard granted == .authorized || granted == .limited else { throw GalleryError.permissionDenied }
    }

    /**
     The album by that name, made when there is not one yet.

     Nil when the library refused to make one, and nil is not a failure: the video is still saved,
     it is simply in Recents and nowhere else. An album is where a save is filed, not whether it
     happened, and losing the whole video over a folder would be the wrong trade.
     */
    private static func albumCollection(named name: String) -> PHAssetCollection? {
        let options = PHFetchOptions()
        options.predicate = NSPredicate(format: "localizedTitle = %@", name)
        let existing = PHAssetCollection.fetchAssetCollections(with: .album, subtype: .any, options: options)
        if let found = existing.firstObject { return found }

        var identifier: String?
        try? PHPhotoLibrary.shared().performChangesAndWait {
            let request = PHAssetCollectionChangeRequest.creationRequestForAssetCollection(withTitle: name)
            identifier = request.placeholderForCreatedAssetCollection.localIdentifier
        }
        guard let identifier else { return nil }
        return PHAssetCollection.fetchAssetCollections(
            withLocalIdentifiers: [identifier], options: nil
        ).firstObject
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
