import Foundation
import Photos

/**
 A finished video, put where the phone's own gallery will show it.

 The photo library IS the gallery on iOS - there is no folder a file can be written into that
 anything indexes, so a copy into the app's own Documents is a video only this app can open. What
 counts is a `PHAssetCreationRequest`, which is what puts the video in Recents; the album, when one
 is asked for, is a `PHAssetCollection` the new asset is then added to, because an album here holds
 references rather than files.

 `directory` has no meaning on this platform and is ignored. On Android it chooses between the two
 folders a gallery indexes; iOS has one library and no folders in it, so honouring the option would
 mean inventing a distinction that does not exist. The contract says as much.
 */
enum Gallery {

    enum GalleryError: Error {
        /// The person said no, or the library is switched off for this app in Settings.
        case permissionDenied
        /// No file at that URL, or nothing that can be read as one.
        case unreadable(String)
        /// The library refused the write, with whatever it said about why.
        case saveFailed(String)
    }

    /**
     Copies `url` into the photo library and answers with the new asset's local identifier.

     An identifier rather than a path, which is all iOS ever gives out: the file itself lives inside
     the library, where no app reaches it directly.
     */
    static func save(url: URL, fileName: String?, album: String?) async throws -> String {
        guard FileManager.default.fileExists(atPath: url.path) else {
            throw GalleryError.unreadable("there is no file at \(url.path)")
        }

        /*
         A separator in the album name would be a caller asking for a nested album, which the photo
         library cannot express at all. Refused rather than flattened, so the same options do the
         same thing on both platforms instead of quietly doing different ones.
         */
        let albumName = album?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty
        if let albumName, albumName.contains("/") || albumName.contains("\\") {
            throw GalleryError.saveFailed("album is one name, not a path: \(albumName)")
        }

        try await requestAddPermission()

        /*
         Named through a copy in a temporary folder, because `PHAssetCreationRequest` takes a file
         and reads the name off it - there is no "call it this" option. A copy rather than a move,
         since the source is the app's own render and the caller may still want it.
         */
        let source = try named(url, as: fileName)
        defer { if source != url { try? FileManager.default.removeItem(at: source) } }

        let collection = albumName.flatMap { albumCollection(named: $0) }

        return try await withCheckedThrowingContinuation { continuation in
            var identifier: String?
            PHPhotoLibrary.shared().performChanges {
                guard let request = PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: source),
                      let placeholder = request.placeholderForCreatedAsset else {
                    return
                }
                identifier = placeholder.localIdentifier

                if let collection, let add = PHAssetCollectionChangeRequest(for: collection) {
                    add.addAssets([placeholder] as NSArray)
                }
            } completionHandler: { done, error in
                if let error {
                    continuation.resume(throwing: GalleryError.saveFailed(ErrorMapping.describe(error)))
                } else if done, let identifier {
                    continuation.resume(returning: identifier)
                } else {
                    continuation.resume(throwing: GalleryError.saveFailed("the photo library refused the video"))
                }
            }
        }
    }

    /**
     Permission to ADD, which is narrower than permission to read.

     `.addOnly` is what this call actually needs. Asking for `.readWrite` would put a prompt in
     front of the person about every photo they own in exchange for writing one video.
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

    /// `url` itself when the caller named nothing, or a copy in a temporary folder under that name.
    private static func named(_ url: URL, as fileName: String?) throws -> URL {
        guard let fileName = fileName?.trimmingCharacters(in: .whitespacesAndNewlines).nilIfEmpty,
              fileName != url.lastPathComponent else {
            return url
        }

        let folder = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("videokit-gallery-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)

        let target = folder.appendingPathComponent(fileName)
        try FileManager.default.copyItem(at: url, to: target)
        return target
    }
}

private extension String {
    var nilIfEmpty: String? { isEmpty ? nil : self }
}
