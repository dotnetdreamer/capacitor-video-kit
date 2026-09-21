import Foundation

struct WrittenEnvelope: Sendable {
    let url: URL
    let boundary: String
    /// The whole envelope, which is what becomes the upload's `bytesTotal`. URLSession takes the
    /// top level Content-Length from the file on disk, which is what keeps the request unchunked.
    let length: Int64
}

enum EnvelopeError: Error { case sourceMissing(String) }

/// The multipart body, written to disk rather than held in memory.
///
/// A background session hands the FILE to `nsurlsessiond`, a different process, so the body has to
/// exist on disk and must not change while the task runs. That constraint is also the reason this
/// streams: a 100 MB video read into a `Data` is exactly the jetsam the background transport exists
/// to avoid.
enum MultipartEnvelope {

    /// Part order is `qquuid`, `qqfilename`, `pictureId`, then the file LAST.
    ///
    /// The server (`DownloadController.AsyncUpload`) buffers the whole form before reading any of
    /// it, takes the first file part whatever it is called, and never reads `qquuid` at all, so the
    /// order is free. The file last is the shape the browser client already sends: every small
    /// field is on the wire before anything has to hold 100 MB to reach a later one.
    ///
    /// No per-part `Content-Length`. Browsers do not send one, `MultipartReader` ignores it, and
    /// leaving it out keeps these bytes identical to what `media.service.ts` produces today.
    static func write(uploadGuid: String, path: String, mimeType: String,
                      pictureId: Int?, into dir: URL) throws -> WrittenEnvelope {
        guard let src = PublishModels.fileURL(path),
              FileManager.default.fileExists(atPath: src.path) else {
            throw EnvelopeError.sourceMissing(uploadGuid)
        }

        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("\(PublishModels.safe(uploadGuid)).body")
        try? fm.removeItem(at: dest)
        fm.createFile(atPath: dest.path, contents: nil)

        // Long enough that it cannot occur inside an mp4 by chance, and still inside the 70
        // character limit RFC 2046 puts on a boundary.
        let boundary = "VideoKitBoundary-" + UUID().uuidString
        let name = PublishModels.fileName(guid: uploadGuid, path: path)

        let out = try FileHandle(forWritingTo: dest)
        defer { try? out.close() }

        var head = ""
        head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"qquuid\"\r\n\r\n\(uploadGuid)\r\n"
        head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"qqfilename\"\r\n\r\n\(name)\r\n"
        if let pictureId, pictureId > 0 {
            head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"pictureId\"\r\n\r\n\(pictureId)\r\n"
        }
        // `filename=` on this part is the recovery key: the server stores it, minus the extension,
        // as Download.Filename, and that is what `download/byName/<uploadGuid>` finds later.
        // Changing it breaks recovery in a way nothing catches until a customer loses a post.
        head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"qqfile\"; filename=\"\(name)\"\r\n"
        head += "Content-Type: \(mimeType)\r\n\r\n"
        try out.write(contentsOf: Data(head.utf8))

        let input = try FileHandle(forReadingFrom: src)
        defer { try? input.close() }
        while true {
            let chunk = try autoreleasepool { try input.read(upToCount: 1 << 20) }
            guard let chunk, !chunk.isEmpty else { break }
            try out.write(contentsOf: chunk)
        }

        // CRLF before the closing delimiter and after it, both required.
        try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))

        // The write offset rather than a stat: it is the same number without a second trip to the
        // filesystem, and it is read while the handle is still open.
        let size = Int64(try out.offset())
        return WrittenEnvelope(url: dest, boundary: boundary, length: size)
    }
}
