import AVFoundation
import Foundation
import os

/// The customer's own sound library: audio taken out of videos, kept until they delete it.
///
/// `SoundLibrary.kt` in every respect that a caller can see, and the folder IS the library on both:
/// one audio file and one `.json` beside it per sound, named after the same id, so nothing can hold
/// an index that disagrees with what is on the disk. It lives in Application Support rather than
/// Caches because the system may reclaim Caches whenever it likes, and a library that empties itself
/// while the phone is low on space is not a library.
///
/// The one real difference from Android is what the extraction costs. `MediaExtractor` hands Android
/// the compressed samples and `MediaMuxer` writes them straight into an `.m4a`, so nothing is
/// decoded. `AVAssetExportSession` offers no such door: `AVAssetExportPresetAppleM4A` is the only
/// audio-only output it has and it re-encodes to AAC. The result is the same file to everything
/// downstream, and the cost is one pass over a track that is a few megabytes.
///
/// Not excluded from backup, unlike everything in `JobFolders`. A render's inputs are a job's and
/// can be made again; a sound the customer took out of a video six months ago and has been using
/// since cannot, and losing the lot on a device restore is not something they would forgive.
enum SoundLibrary {

    private static let log = Logger(subsystem: "net.dotnetdreamer.videokit", category: "SoundLibrary")

    /// Refused past this, so a half-written export never becomes a row that plays nothing.
    private static let headroomBytes: Int64 = 8 * 1024 * 1024

    struct Sound {
        let id: String
        let url: URL
        let fileName: String
        let durationMs: Int64
        let savedAt: Int64
        let sourceName: String?
    }

    enum SoundError: Error {
        case noSpace(needed: Int64, free: Int64)
        case exportFailed(String)
    }

    /// Library/Application Support/sounds/
    static var dir: URL {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("sounds", isDirectory: true)
    }

    /// Where a `keep: false` extraction goes: this edit only, and the system may reclaim it.
    static var cacheDir: URL {
        let base = FileManager.default.urls(for: .cachesDirectory, in: .userDomainMask)[0]
        return base.appendingPathComponent("video-composer/sounds", isDirectory: true)
    }

    // MARK: - Extract

    /// Writes the video's audio track out on its own.
    ///
    /// Returns nil when the video HAS no audio track, which is a normal fact about a normal file
    /// rather than a failure: a caller that reported an error for it would be telling the customer
    /// their video is broken. Everything that does go wrong throws.
    static func extract(from source: URL, fileName: String?, keep: Bool) async throws -> Sound? {
        let asset = AVURLAsset(url: source)
        let audioTracks = try await asset.loadTracks(withMediaType: .audio)
        guard !audioTracks.isEmpty else { return nil }

        let folder = keep ? dir : cacheDir
        try ensure(folder)
        let needed = fileBytes(source) / 8 + headroomBytes
        if let free = JobFolders.freeBytes(at: folder), free < needed {
            throw SoundError.noSpace(needed: needed, free: free)
        }

        let id = newId()
        let target = folder.appendingPathComponent("\(id).m4a")
        // The session refuses to start when its output already exists, which an id collision or a
        // previous failed attempt could leave behind.
        try? FileManager.default.removeItem(at: target)

        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw SoundError.exportFailed("no AppleM4A preset on this device")
        }
        // Assigning an unsupported outputFileType raises an ObjC exception Swift cannot catch, so
        // it is checked rather than attempted. `export(to:as:)` assigns it on the way in.
        guard session.supportedFileTypes.contains(.m4a) else {
            throw SoundError.exportFailed("this video's audio cannot be written as m4a")
        }

        do {
            try await session.export(to: target, as: .m4a)
        } catch {
            // A partial `.m4a` has no `moov` atom: it is not a shorter sound but a file nothing can
            // open, and one left in the library would be a row that never plays.
            try? FileManager.default.removeItem(at: target)
            throw error
        }

        let durationMs = (try? await Thumbnailer.probe(target).durationMs) ?? 0
        // Android reads the content resolver's DISPLAY_NAME here. The file's own name is the same
        // thing on iOS, a photo library pick included: `GalleryLibrary.copyURL` names its copy
        // after the item, `IMG_0042.MOV`, rather than after anything of its own.
        let sourceName = source.lastPathComponent
        let sound = Sound(id: id,
                          url: target,
                          fileName: fileName?.isEmpty == false ? fileName! : (withoutExtension(sourceName) ?? "Sound"),
                          durationMs: durationMs,
                          savedAt: Int64(Date().timeIntervalSince1970 * 1000),
                          sourceName: sourceName.isEmpty ? nil : sourceName)
        if keep { writeRecord(sound, in: folder) }
        return sound
    }

    // MARK: - List and delete

    /// Every kept sound, newest first. A record whose audio file has gone is swept as it is read.
    static func list() -> [Sound] {
        let folder = dir
        let entries = (try? FileManager.default.contentsOfDirectory(at: folder,
                                                                    includingPropertiesForKeys: nil)) ?? []
        var sounds: [Sound] = []
        for record in entries where record.pathExtension == "json" {
            guard let sound = readRecord(record, in: folder),
                  FileManager.default.fileExists(atPath: sound.url.path) else {
                // Unreadable or orphaned. Either way it is a row that would play nothing, and the
                // record is the only thing left to remove.
                try? FileManager.default.removeItem(at: record)
                continue
            }
            sounds.append(sound)
        }
        return sounds.sorted { $0.savedAt > $1.savedAt }
    }

    /// Idempotent: an id that is already gone is not an error, because the caller wanted it gone.
    static func delete(id: String) {
        let folder = dir
        let safe = JobFolders.sanitize(id)
        for url in [folder.appendingPathComponent("\(safe).m4a"), folder.appendingPathComponent("\(safe).json")] {
            try? FileManager.default.removeItem(at: url)
        }
    }

    // MARK: - Records

    private static func writeRecord(_ sound: Sound, in folder: URL) {
        var json: [String: Any] = [
            "id": sound.id,
            "file": sound.url.lastPathComponent,
            "fileName": sound.fileName,
            "durationMs": sound.durationMs,
            "savedAt": sound.savedAt,
        ]
        if let sourceName = sound.sourceName { json["sourceName"] = sourceName }
        do {
            let data = try JSONSerialization.data(withJSONObject: json)
            try data.write(to: folder.appendingPathComponent("\(sound.id).json"))
        } catch {
            // The audio is written and is what the caller is about to play. A sound with no record
            // is one that will not be in the list next time, which is not worth failing over.
            log.error("could not write record for \(sound.id, privacy: .public): \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func readRecord(_ record: URL, in folder: URL) -> Sound? {
        guard let data = try? Data(contentsOf: record),
              let json = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any],
              let id = json["id"] as? String, !id.isEmpty,
              let name = json["file"] as? String, !name.isEmpty else { return nil }
        let sourceName = json["sourceName"] as? String
        return Sound(id: id,
                     url: folder.appendingPathComponent(name),
                     fileName: json["fileName"] as? String ?? "Sound",
                     durationMs: (json["durationMs"] as? NSNumber)?.int64Value ?? 0,
                     savedAt: (json["savedAt"] as? NSNumber)?.int64Value ?? 0,
                     sourceName: (sourceName?.isEmpty ?? true) ? nil : sourceName)
    }

    // MARK: - Small things

    /// Creates the folder. Deliberately without `isExcludedFromBackup`; the type's docblock says why.
    private static func ensure(_ url: URL) throws {
        if !FileManager.default.fileExists(atPath: url.path) {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        }
    }

    private static func fileBytes(_ url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.fileSizeKey])
        return Int64(values?.fileSize ?? 0)
    }

    private static func withoutExtension(_ name: String) -> String? {
        let stem = (name as NSString).deletingPathExtension
        return stem.isEmpty ? nil : stem
    }

    private static func newId() -> String {
        "snd-\(String(Int64(Date().timeIntervalSince1970 * 1000), radix: 36))-\(String(Int.random(in: 0...0xFFFF), radix: 16))"
    }
}
