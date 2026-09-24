import Foundation
import Photos
import UIKit
import UniformTypeIdentifiers

/**
 The photo library's videos - and its pictures, when a host asks for them - READ, for a host that
 draws its own gallery. The other direction from `Gallery`, which only ever writes one.

 A host wants this for the order: `PHPickerViewController` answers with a set, and the order somebody
 tapped their clips in - the order they want them on the timeline - is gone by the time it comes back.

 THE ONE THING THAT IS DIFFERENT FROM ANDROID. An item in the library is a `PHAsset`, which has an
 identifier and no path: nothing in this plugin can open `ph://...`, because `JobFolders.fileURL`
 takes a file and AVFoundation and ImageIO need one too. So `resolve` copies the asset's resource
 into the app's own storage and answers with THAT file. On Android the same call hands back the
 MediaStore URI unchanged, which is why it exists as a separate step at all: a host calls it for
 every pick, and only pays for a copy on the platform that needs one.

 The copy lands in Application Support rather than Caches, because a draft stores the path it was
 given and a cache the system empties would leave that draft pointing at nothing. One folder per
 asset and one file per VERSION of it (`copyURL`), so picking the same video again reuses the copy,
 and picking it again after an edit in Photos makes a new one instead of serving the old cut. Nothing
 in this file deletes a copy, because a draft may still be pointing at an older version: the host,
 which knows what its drafts use, deletes the rest through `releaseMedia` and `sweepMedia`
 (`RetainedMedia`), as it does the picks `retainMedia` kept.

 Needs `NSPhotoLibraryUsageDescription` in the host's `Info.plist`: iOS terminates an app that asks
 for read access without one.
 */
enum GalleryLibrary {

    /// One item of the library: a video, or - when pictures were asked for - a picture. Android's
    /// `GalleryLibrary.Video`, `image` flag and all.
    struct Video {
        let id: String
        let fileName: String
        let durationMs: Int64
        let image: Bool
    }

    enum LibraryError: Error {
        /// The person said no, or the library is switched off for this app in Settings.
        case permissionDenied
        /// The asset has gone from the library since it was listed.
        case notFound(String)
        /// The asset is there but has nothing that can be read as a video or a picture - or iCloud
        /// would not hand it over.
        case unreadable(String)
    }

    /// What the host may see: everything, the items the person chose, or nothing.
    static var access: String {
        switch PHPhotoLibrary.authorizationStatus(for: .readWrite) {
        case .authorized: return "granted"
        case .limited: return "limited"
        default: return "denied"
        }
    }

    /// Asks when the person has not been asked yet; otherwise answers with what they said last time.
    ///
    /// One grant for videos and pictures alike, which is why this takes no `images` flag: Android
    /// needs one because pictures are a second permission there, and the photo library is not.
    static func requestAccess() async -> String {
        if PHPhotoLibrary.authorizationStatus(for: .readWrite) == .notDetermined {
            _ = await PHPhotoLibrary.requestAuthorization(for: .readWrite)
        }
        return access
    }

    /**
     One page of the library, newest first, and how many items it holds in all: its videos, or its
     videos and pictures together when `images` is set.

     A `PHFetchResult` is lazy, so fetching the whole library to read sixty rows of it costs nothing
     like sixty times the library. It is fetched again for every page rather than kept, because a
     kept one goes stale the moment the person records something, and an index into a stale result
     is a different video.

     With pictures it is ONE fetch over both kinds rather than one per kind merged here, for the
     reason Android gives for its one query: two results paged by position cannot be merged into
     one position without reading both from the start every page. Newest first by `creationDate`
     either way, which is the order the Photos app shows; Android orders by the date a file was
     added, which PhotoKit has no public key for.
     */
    static func list(offset: Int, limit: Int, images: Bool = false) throws -> (videos: [Video], total: Int) {
        guard canRead else { throw LibraryError.permissionDenied }

        let options = PHFetchOptions()
        options.sortDescriptors = [NSSortDescriptor(key: "creationDate", ascending: false)]
        let assets: PHFetchResult<PHAsset>
        if images {
            options.predicate = NSPredicate(format: "mediaType == %d || mediaType == %d",
                                            PHAssetMediaType.image.rawValue, PHAssetMediaType.video.rawValue)
            assets = PHAsset.fetchAssets(with: options)
        } else {
            assets = PHAsset.fetchAssets(with: .video, options: options)
        }
        let total = assets.count
        guard offset < total else { return ([], total) }

        var videos: [Video] = []
        let end = min(total, offset + limit)
        assets.enumerateObjects(at: IndexSet(integersIn: offset..<end), options: []) { asset, _, _ in
            let image = asset.mediaType == .image
            videos.append(Video(
                id: asset.localIdentifier,
                fileName: listedName(of: asset),
                // A picture has no length, and `PHAsset.duration` already says 0 for one; spelled out
                // so the contract's "always 0 for a picture" does not rest on that.
                durationMs: image ? 0 : Int64((asset.duration * 1000).rounded()),
                image: image
            ))
        }
        return (videos, total)
    }

    /**
     A poster frame for one video, or a small copy of one picture, as a JPEG in Caches.

     Photos' own image manager rather than `Thumbnailer`: it serves most of a grid from thumbnails
     the library already keeps, without opening a decoder the editor's preview is competing for, and
     it serves pictures exactly as it serves videos. Network access is allowed so an item that lives
     only in iCloud still gets a tile.

     `maxSize` is the LONG edge, as the contract says and as Android's `loadThumbnail(Size(maxSize,
     maxSize))` treats it: the frame is fitted inside a `maxSize` square, never filled over one.
     `.exact` because `.fast` is free to answer with something larger than it was asked for.
     */
    static func thumbnail(id: String, maxSize: Int) async throws -> URL {
        guard canRead else { throw LibraryError.permissionDenied }

        let target = thumbnailURL(id: id, maxSize: maxSize)
        try FileManager.default.createDirectory(at: target.deletingLastPathComponent(),
                                                withIntermediateDirectories: true)
        if FileManager.default.fileExists(atPath: target.path) { return target }

        let asset = try fetch(id)
        let options = PHImageRequestOptions()
        // One callback, with the finished image: `.opportunistic` would call twice, and the first
        // answer is a blurry placeholder this would then write to disk as the thumbnail.
        options.deliveryMode = .highQualityFormat
        options.resizeMode = .exact
        options.isNetworkAccessAllowed = true

        let size = CGSize(width: maxSize, height: maxSize)
        let image: UIImage? = await withCheckedContinuation { continuation in
            PHImageManager.default().requestImage(
                for: asset, targetSize: size, contentMode: .aspectFit, options: options
            ) { image, _ in
                continuation.resume(returning: image)
            }
        }

        guard let data = image?.jpegData(compressionQuality: 0.8) else {
            throw LibraryError.unreadable("that video has no frame to show")
        }
        // Atomic, so a second request for the same item never reads a half-written file.
        try data.write(to: target, options: .atomic)
        return target
    }

    /**
     A file the rest of the plugin can open, for one asset: its video, or for a picture its image
     in the format it is stored in (a HEIC stays a HEIC - the renderer decodes it), copied out of the
     library into the app's own storage. Downloaded from iCloud first when that is where it lives.

     Two resolves of the same asset at once - a double tap, a host resolving a page ahead - each
     write a partial of their own, and whichever lands second finds the other's copy already in
     place, which is the same bytes and therefore a success.

     Every copy this answers with has been through `RetainedMedia.handOut`, whether it was made just
     now or found made before, so the host's sweep, which may be running while the pick is made,
     never takes it. It is not dated again: a copy reused keeps the date it was first written, which
     `Thumbnailer` signs its filmstrip by.
     */
    static func resolve(id: String) async throws -> (url: URL, fileName: String) {
        guard canRead else { throw LibraryError.permissionDenied }

        let asset = try fetch(id)
        let image = asset.mediaType == .image
        guard let resources = resources(of: asset) else {
            throw LibraryError.unreadable(image ? "that asset holds no picture" : "that asset holds no video")
        }
        let name = displayName(of: resources)
        let edited = resources.copied.type == .fullSizeVideo || resources.copied.type == .fullSizePhoto

        let folder = copiesFolder
        try JobFolders.ensure(folder)
        let onDisk = name.isEmpty ? fallbackName(for: resources.copied, image: image) : name
        let target = copyURL(in: folder, id: id, edited: edited, modified: asset.modificationDate, name: onDisk)
        let versionFolder = target.deletingLastPathComponent()
        if RetainedMedia.handOut(target) { return (target, name) }

        // An original an earlier version of the kit already copied is the same bytes, so it is
        // linked in under the new name rather than downloaded and stored a second time. A hard
        // link, so the old path a draft may hold keeps working and neither outlives the other's
        // deletion; it fails, and the copy below goes ahead, when there is no old copy to link.
        if !edited, !name.isEmpty, (try? RetainedMedia.handOut(target, placing: {
            try FileManager.default.createDirectory(at: versionFolder, withIntermediateDirectories: true)
            try FileManager.default.linkItem(at: legacyCopyURL(in: folder, id: id, name: name), to: target)
        })) == true {
            return (target, name)
        }

        // Under a temporary name of its own, then moved: a copy cut short - no space, iCloud gone
        // away - must not leave a file here that the next pick of the same item would take as
        // finished. In `tmp/`, which is on the same volume, so the move is a rename, and which the
        // system empties, so a partial whose app was killed mid copy does not stay forever.
        let partial = FileManager.default.temporaryDirectory
            .appendingPathComponent("videokit-gallery-\(UUID().uuidString).part")

        let options = PHAssetResourceRequestOptions()
        options.isNetworkAccessAllowed = true
        do {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                PHAssetResourceManager.default().writeData(for: resources.copied, toFile: partial,
                                                           options: options) { error in
                    if let error {
                        continuation.resume(throwing: LibraryError.unreadable(ErrorMapping.describe(error)))
                    } else {
                        continuation.resume()
                    }
                }
            }
            // The folder is made with the move, not before the download, which from iCloud can take
            // minutes: `RetainedMedia.sweep` removes a folder it finds empty, and may meanwhile have
            // taken the one the link above made.
            try RetainedMedia.handOut(target) {
                try FileManager.default.createDirectory(at: versionFolder, withIntermediateDirectories: true)
                try FileManager.default.moveItem(at: partial, to: target)
            }
        } catch {
            try? FileManager.default.removeItem(at: partial)
            // A concurrent resolve of the same version got there first.
            guard RetainedMedia.handOut(target) else { throw error }
        }
        return (target, name)
    }

    /**
     The tile for one item at one size: `Library/Caches/videokit-gallery-thumbnails/<id>-fit<maxSize>.jpg`.

     `fit` because earlier versions of the kit kept tiles in this folder as `<id>-<maxSize>.jpg`,
     FILLED over the square, so the short edge was `maxSize` and the long one more. Those tiles
     would otherwise be served as they are for as long as the system leaves Caches alone; under a
     name of their own they are simply never read again, and go when Caches is next purged.
     */
    static func thumbnailURL(id: String, maxSize: Int) -> URL {
        FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("videokit-gallery-thumbnails", isDirectory: true)
            .appendingPathComponent("\(safeName(id))-fit\(maxSize).jpg", isDirectory: false)
    }

    /// Library/Application Support/videokit-gallery/
    static var copiesFolder: URL {
        FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("videokit-gallery", isDirectory: true)
    }

    /**
     Where the copy of one version of one asset lives: `<folder>/<id>/<version>/<name>`.

     An item nobody has edited is copied from its original, which Photos never changes, so it has
     one version, `original`, whatever else happens to the asset. An edited one is copied from its
     edit, and there the modification date is what tells two versions apart: Photos changes it when
     the person edits the item again, and nothing else about the asset does change then - the
     identifier stays and the edited resource keeps its name, `FullSizeRender.mov`, however many
     times it is edited - so a copy keyed without it would hand back the first edit forever. The
     date changes on smaller things too, a favourite or a caption, and for an edited item those
     cost one fresh copy, which is the cheap side of the trade. Reverting the edit goes back to
     `original`, and to the copy of it already there.

     The file itself carries the item's own name, so `lastPathComponent` is `IMG_0042.MOV` to
     everything that reads it - the sound library's `sourceName`, a save's default name - rather
     than something only this folder understands.
     */
    static func copyURL(in folder: URL, id: String, edited: Bool, modified: Date?, name: String) -> URL {
        let version = edited
            ? modified.map { String(Int64(($0.timeIntervalSince1970 * 1000).rounded())) } ?? "edited"
            : "original"
        return folder
            .appendingPathComponent(safeName(id), isDirectory: true)
            .appendingPathComponent(version, isDirectory: true)
            .appendingPathComponent(name, isDirectory: false)
    }

    /**
     Where earlier versions of this kit kept their one copy of an asset: `<folder>/<id>-<name>`,
     flat, and named after the resource that was copied.

     That name is what says which bytes the file holds. The copy of an item that had been edited is
     called `FullSizeRender`, and which edit it holds nobody can now say; one called after the
     original's own name was copied from the original, which Photos never changes, and is exactly
     what `copyURL` would download again. Drafts made before still point at these files, so they
     are left where they are.
     */
    static func legacyCopyURL(in folder: URL, id: String, name: String) -> URL {
        folder.appendingPathComponent("\(safeName(id))-\(name)", isDirectory: false)
    }

    /**
     What an item is called: the ORIGINAL resource's name, the one the person took it under and
     the Photos app shows (`IMG_0042.MOV`), never the edited resource's, which Photos calls
     `FullSizeRender` for every edit there has ever been.

     With the extension of the bytes that are actually copied, when that is a different format: an
     edited RAW or ProRAW picture is copied as its rendered JPEG or HEIC, and a file called `.DNG`
     that holds a JPEG is a name that lies to everything that goes by it. A name is one path
     component, so a separator in one - an imported file can carry anything - is replaced.
     */
    static func displayName(original: String, copied: String) -> String {
        let originalExtension = (original as NSString).pathExtension
        let copiedExtension = (copied as NSString).pathExtension
        var name: String
        if original.isEmpty {
            name = copied
        } else if copiedExtension.isEmpty
                    || originalExtension.caseInsensitiveCompare(copiedExtension) == .orderedSame {
            name = original
        } else {
            name = "\((original as NSString).deletingPathExtension).\(copiedExtension)"
        }
        name = name.replacingOccurrences(of: "/", with: "_")
        return name == "." || name == ".." ? "" : name
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

    /**
     The two resources that matter for one asset: the one to COPY, which is the version the Photos
     app shows - edits included - and the original when there are none; and the ORIGINAL, which is
     only ever asked for its name. `.fullSizePhoto` and `.photo` for a picture, `.fullSizeVideo`
     and `.video` for a video.
     */
    private static func resources(of asset: PHAsset) -> (copied: PHAssetResource, original: PHAssetResource)? {
        let all = PHAssetResource.assetResources(for: asset)
        let (edited, originalType): (PHAssetResourceType, PHAssetResourceType) =
            asset.mediaType == .image ? (.fullSizePhoto, .photo) : (.fullSizeVideo, .video)
        let original = all.first { $0.type == originalType }
        guard let copied = all.first(where: { $0.type == edited }) ?? original else { return nil }
        return (copied, original ?? copied)
    }

    /// The names `list` has already worked out, keyed by the asset AND its modification date.
    ///
    /// `PHAssetResource.assetResources(for:)` is a query of the Photos database per asset, which
    /// `PHFetchResult` does not prefetch, and it was the one expensive thing in a row: a page of
    /// sixty was sixty of them, and page 0 is listed again every time the gallery opens. The name
    /// depends on nothing but the resources' file names, and those change only when the item is
    /// edited or reverted, which moves `modificationDate`, so an edited item misses here and gets its
    /// new extension exactly as it did before. Anything else that moves the date is only a miss.
    ///
    /// `NSCache` because `list` runs on the cooperative pool and two pages can be listed at once;
    /// it is thread-safe and gives the memory back under pressure. A row with no name is never
    /// kept, so an asset whose resources were not there yet is asked again next time.
    private static let nameCache: NSCache<NSString, NSString> = {
        let cache = NSCache<NSString, NSString>()
        cache.countLimit = 2000
        return cache
    }()

    private static func listedName(of asset: PHAsset) -> String {
        let key = "\(asset.localIdentifier)|\(asset.modificationDate?.timeIntervalSince1970 ?? 0)" as NSString
        if let hit = nameCache.object(forKey: key) { return hit as String }
        guard let found = resources(of: asset) else { return "" }
        let name = displayName(of: found)
        if !name.isEmpty { nameCache.setObject(name as NSString, forKey: key) }
        return name
    }

    private static func displayName(of resources: (copied: PHAssetResource, original: PHAssetResource)) -> String {
        displayName(original: resources.original.originalFilename, copied: resources.copied.originalFilename)
    }

    /// A file name for a copy whose asset carries none at all, with the extension its type says:
    /// AVFoundation goes by the extension, and a clip with none is a clip it will not open.
    private static func fallbackName(for resource: PHAssetResource, image: Bool) -> String {
        let stem = image ? "picture" : "video"
        guard let ext = UTType(resource.uniformTypeIdentifier)?.preferredFilenameExtension else {
            return image ? "\(stem).jpg" : "\(stem).mov"
        }
        return "\(stem).\(ext)"
    }

    /// A local identifier carries slashes, which a file name cannot.
    private static func safeName(_ id: String) -> String {
        String(id.map { $0.isLetter || $0.isNumber ? $0 : "_" })
    }
}
