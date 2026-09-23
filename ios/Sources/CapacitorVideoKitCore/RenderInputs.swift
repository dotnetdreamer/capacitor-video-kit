import CryptoKit
import Foundation

/// The file a render input is opened from, when its own name would not open.
///
/// `AVURLAsset` chooses its reader by the file's EXTENSION and never looks at the bytes: a file with
/// no extension fails every load with -11828 (`fileFormatNotRecognized`), and a WAV, an MP3 or a CAF
/// named `.m4a` or `.mp4` fails with -11829 (`failedToParse`), whatever is inside. Both are ordinary
/// input. The contract asks only for a readable `file://` (`definitions.ts`), a host that keeps the
/// browser's sound library hands music over as a blob and writes it to a render input named
/// `render-input-<uuid>` with no extension at all, and `prepareJob` names an input that arrived
/// without one `.m4a` or `.mp4` by guess (`JobFolders.defaultExtension`). Android's Media3 sniffs the
/// content and opens all of them, so without this the same post that renders there fails here as
/// `unreadable_input`.
///
/// So the builder asks this first, once per distinct file: the first bytes are read, and a file
/// whose name does not already say what they are is LINKED into the job folder under a name that
/// does and opened from there. A hard link costs no time and no bytes while the original is there,
/// though it keeps those bytes on disk when the host deletes the original first. A copy is the
/// fallback for a source a link cannot reach, such as one on another volume. The original is never
/// touched. The links are the render's alone: `JobRegistry.run` deletes them once the export has
/// finished, failed or been cancelled, or the build has thrown, and a render whose app was killed
/// leaves them for `JobFolders.cleanup` or the launch sweep. iOS 17's
/// `AVURLAssetOverrideMIMETypeKey` would say the same thing without a file, but the package's floor
/// is iOS 16 and one path is easier to trust than two.
enum RenderInputs {

    /// Where the links live: beside the render's other working files, so they share its lifetime.
    static func folder(_ batchId: String) -> URL {
        JobFolders.jobDir(batchId).appendingPathComponent("named", isDirectory: true)
    }

    /// `url` itself when its name already opens what it holds, or when its bytes are nothing this
    /// knows - AVFoundation then fails it as it always did, with an error that names the clip. Any
    /// other answer is a link to it under the right extension.
    ///
    /// Never throws. A link that cannot be made answers `url`, so the failure the customer sees is
    /// the one AVFoundation gives for the file itself rather than one about a folder they never
    /// heard of.
    static func openable(_ url: URL, batchId: String) -> URL {
        guard let kind = sniff(url) else { return url }
        if kind.opens.contains(url.pathExtension.lowercased()) { return url }

        let dir = folder(batchId)
        let named = dir.appendingPathComponent("\(stableName(for: url.path)).\(kind.ext)")
        let fm = FileManager.default
        do {
            try JobFolders.ensure(dir)
            // A retry of a post whose app was killed mid render finds the link from last time.
            // Made again rather than trusted, because the name is a digest of the source's PATH,
            // and a host may write new bytes there.
            try? fm.removeItem(at: named)
            do {
                try fm.linkItem(at: url, to: named)
            } catch {
                try fm.copyItem(at: url, to: named)
            }
            return named
        } catch {
            return url
        }
    }

    /// A short name for a file this module writes about `value`, the same on every run: a picture's
    /// still is named after its `uri`, a link after its source's path. The first half of a SHA-256
    /// in hex, because `hashValue` is seeded per process and a name has to survive a retry.
    static func stableName(for value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).prefix(16).map { String(format: "%02x", $0) }.joined()
    }

    // MARK: - Sniffing

    /// What a file's first bytes say it is: the extension to link it under, and every extension that
    /// already opens it. AVFoundation reads the ISO media family through one reader whatever the
    /// name within it, so a QuickTime movie called `.mp4` or an AAC track called `.mp4` is left as it
    /// is - measured on this SDK, and those are the names `prepareJob` gives such files.
    private struct Kind {
        let ext: String
        let opens: Set<String>
    }

    private static let isoMedia: Set<String> = ["mp4", "m4a", "m4v", "m4b", "mov", "qt", "3gp", "3g2"]

    /// The containers AVFoundation opens that a phone or a browser hands over. Anything else - WebM,
    /// Ogg, Matroska - is nothing iOS can decode by any name, and answers nil.
    private static func sniff(_ url: URL) -> Kind? {
        guard let handle = try? FileHandle(forReadingFrom: url) else { return nil }
        defer { try? handle.close() }
        guard let data = try? handle.read(upToCount: 12), data.count >= 4 else { return nil }
        let head = [UInt8](data)

        func ascii(_ range: Range<Int>) -> String {
            guard range.upperBound <= head.count else { return "" }
            return String(decoding: head[range], as: UTF8.self)
        }

        if ascii(4..<8) == "ftyp" {
            // The brand only picks the name: every one of them is read by the same reader.
            let brand = ascii(8..<12)
            let ext = brand == "qt  " ? "mov" : (brand.hasPrefix("M4A") || brand.hasPrefix("M4B") ? "m4a" : "mp4")
            return Kind(ext: ext, opens: isoMedia)
        }
        if ascii(0..<4) == "RIFF", ascii(8..<12) == "WAVE" { return Kind(ext: "wav", opens: ["wav", "wave"]) }
        if ascii(0..<4) == "caff" { return Kind(ext: "caf", opens: ["caf"]) }
        if ascii(0..<4) == "FORM", ["AIFF", "AIFC"].contains(ascii(8..<12)) {
            return Kind(ext: "aiff", opens: ["aif", "aiff", "aifc"])
        }
        if ascii(0..<4) == "fLaC" { return Kind(ext: "flac", opens: ["flac"]) }
        if ascii(0..<3) == "ID3" { return Kind(ext: "mp3", opens: ["mp3"]) }
        if head[0] == 0xFF {
            // Both are a run of set sync bits, and the two bits after the version tell them apart:
            // ADTS always writes its layer as 00, which MPEG audio reserves and never writes.
            if head[1] & 0xF6 == 0xF0 { return Kind(ext: "aac", opens: ["aac", "adts"]) }
            if head[1] & 0xE0 == 0xE0 { return Kind(ext: "mp3", opens: ["mp3"]) }
        }
        return nil
    }
}
