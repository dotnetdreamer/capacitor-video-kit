import Foundation
import Photos
import UIKit

/**
 The photo library's videos, READ, for a host that draws its own gallery - the other direction from
 `Gallery`, which only ever writes one.

 A host wants this for the order: `PHPickerViewController` answers with a set, and the order somebody
 tapped their clips in - the order they want them on the timeline - is gone by the time it comes back.

 THE ONE THING THAT IS DIFFERENT FROM ANDROID. A video in the library is a `PHAsset`, which has an
 identifier and no path: nothing in this plugin can open `ph://...`, because `JobFolders.fileURL`
 takes a file and AVFoundation needs one too. So `resolve` copies the asset's video resource into the
 app's own storage and answers with THAT file. On Android the same call hands back the MediaStore URI
 unchanged, which is why it exists as a separate step at all: a host calls it for every pick, and
 only pays for a copy on the platform that needs one.

 The copy lands in Application Support rather than Caches, because a draft stores the path it was
 given and a cache the system empties would leave that draft pointing at nothing. One file per asset,
 reused when the same video is picked again.

 Needs `NSPhotoLibraryUsageDescription` in the host's `Info.plist`: iOS terminates an app that asks
 for read access without one.
 */
enum GalleryLibrary {

    struct Video {
        let id: String
        let fileName: String
        let durationMs: Int64
    }

    enum LibraryError: Error {
        /// The person said no, or the library is switched off for this app in Settings.
        case permissionDenied
        /// The asset has gone from the library since it was listed.
        case notFound(String)
        /// The asset is there but has nothing that can be read as a video - or iCloud would not
        /// hand it over.
        case unreadable(String)
    }

    /// What the host may see: everything, the videos the person chose, or nothing.
    static var access: String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return "granted"
        case .limited: return "limited"
        default: return "denied"
        }
    }

    /// Asks when the person has not been asked yet; otherwise answers with what they said last time.
    static func requestAccess() async -> String {
        if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined {
            _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        return access
    }

    /**
     One page of the library, newest first, and how many videos it holds in all.

     A `PHFetchResult` is lazy, so fetching the whole library to read sixty rows of it costs nothing
     like sixty times the library. It is fetched again for every page rather than kept, because a
     kept one goes stale the moment the person records something, and an index into a stale result
     is a different video.
     */
    static func list(offset: Int, limit: Int) throws -> (videos: [Video], total: Int) {
        guard canRead else { throw LibraryError.permissionDenied }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets = PHAsset.fetchAssets(with: .video, options: options)
        let total = assets.count
        guard offset < total else { return ([], total) }

        var videos: [Video] = []
        let end = min(total, offset + limit)
        assets.enumerateObjects(at: IndexSet(integersIn: offset..<end), options: []) { asset, _, _ in
            videos.append(Video(
                id: asset.localIdentifier,
                fileName: fileName(of: asset),
                durationMs: Int64((asset.duration * 1000).rounded())
            ))
        }
        return (videos, total)
    }

    /**
     A poster frame for one video, as a JPEG in Caches.

     Photos' own image manager rather than `Thumbnailer`: it serves most of a grid from thumbnails
     the library already keeps, without opening a decoder the editor's preview is competing for.
     Network access is allowed so a video that lives only in iCloud still gets a tile.
     */
    static func thumbnail(id: String, maxSize: Int) async throws -> URL {
        guard canRead else { throw LibraryError.permissionDenied }

        let folder = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("videokit-gallery-thumbnails", isDirectory: true)
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let target = folder.appendingPathComponent("\(safeName(id))-\(maxSize).jpg")
        if FileManager.default.fileExists(atPath: target.path) { return target }

        let asset = try fetch(id)
        let options = PHImageRequestOptions()
        // One callback, with the finished image: `.opportunistic` would call twice, and the first
        // answer is a blurry placeholder this would then write to disk as the thumbnail.
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .fast
        options.isNetworkAccessAllowed = true

        let size = CGSize(width: maxSize, height: maxSize)
        let image: UIImage? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(
                for: asset, targetSize: size, contentMode: .aspectFill, options: options
            ) { image, _ in
                continuation.resume(returning: image)
            }
        }

        guard let data = image?.jpegData(compressionQuality: 0.8) else {
            throw LibraryError.unreadable("that video has no frame to show")
        }
        // Atomic, so a second request for the same video never reads a half-written file.
        try data.write(to: target, options: .atomic)
        return target
    }

    /**
     A file the rest of the plugin can open, for one asset: its video resource, copied out of the
     library into the app's own storage. Downloaded from iCloud first when that is where it lives.
     */
    static func resolve(id: String) async throws -> (url: URL, fileName: String) {
        guard canRead else { throw LibraryError.permissionDenied }

        let asset = try fetch(id)
        guard let resource = videoResource(of: asset) else {
            throw LibraryError.unreadable("that asset holds no video")
        }
        let name = resource.originalFilename

        let folder = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("videokit-gallery", isDirectory: true)
        try JobFolders.ensure(folder)
        let target = folder.appendingPathComponent("\(safeName(id))-\(name)")
        if FileManager.default.fileExists(atPath: target.path) { return (target, name) }

        // Under a temporary name, then moved: a copy cut short - no space, iCloud gone away - must
        // not leave a file here that the next pick of the same video would take as finished.
        let partial = target.appendingPathExtension("part")
        try? FileManager.default.removeItem(at: partial)

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            PHAssetResourceManager.default().writeData(for: resource, toFile: partial, options: options) { error in
                if let error {
                    continuation.resume(throwing: LibraryError.unreadable(ErrorMapping.describe(error)))
                } else {
                    continuation.resume()
                }
            }
        }

        try FileManager.default.moveItem(at: partial, to: target)
        return (target, name)
    }

    private static var canRead: Bool {
        let status = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        return status == .authorized || status == .limited
    }

    private static func fetch(_ id: String) throws -> PHAsset {
        guard let asset = PHAsset.fetchAssets(withLocalIdentifiers: [id], options: nil).firstObject else {
            throw LibraryError.notFound("that video is no longer in the library")
        }
        return asset
    }

    /// The version the Photos app shows - edits included - and the original when there are none.
    private static func videoResource(of asset: PHAsset) -> PHAssetResource? {
        let resources = PHAssetResource.assetResources(for: asset)
        return resources.first { $0.type == .fullSizeVideo } ?? resources.first { $0.type == .video }
    }

    private static func fileName(of asset: PHAsset) -> String {
        videoResource(of: asset)?.originalFilename ?? ""
    }

    /// A local identifier carries slashes, which a file name cannot.
    private static func safeName(_ id: String) -> String {
        String(id.map { $0.isLetter || $0.isNumber ? $0 : "_" })
    }
}
