import Foundation

struct WrittenBody: Sendable {
    let url: URL
    /// The `Content-Type` the request carries, boundary and all for a multipart POST.
    let contentType: String
    /// The whole body, which is what becomes the upload's `bytesTotal`. URLSession takes the top
    /// level Content-Length from the file on disk, which is what keeps the request unchunked.
    let length: Int64
}

enum UploadBodyError: Error { case sourceMissing(String) }

/// The request body, written to disk rather than held in memory.
///
/// A background session hands the FILE to `nsurlsessiond`, a different process, so the body has to
/// exist on disk and must not change while the task runs. That constraint is also the reason this
/// streams: a 100 MB video read into a `Data` is exactly the jetsam the background transport exists
/// to avoid, and it is why even the `PUT` path takes a copy rather than pointing at the caller's
/// own file, which the caller is free to delete the moment `publish()` returns.
enum UploadBody {

    /// The body for one file, in whichever shape the transport asks for.
    ///
    /// `PUT` is the bytes and nothing else, with the file's own content type: that is what a
    /// presigned URL is signed for, and an envelope there would break the signature.
    ///
    /// `POST` writes the multipart form the transport describes - the caller's text parts first,
    /// in the order given, then the file LAST. Every small field is on the wire before anything
    /// has to hold 100 MB to reach a later one, which is also the shape the browser client sends.
    /// No per-part `Content-Length`: browsers do not send one and a reader that wanted it would
    /// already be broken against every other client.
    static func write(request: PublishRequest, upload: PublishUpload, into dir: URL) throws -> WrittenBody {
        guard let src = PublishModels.fileURL(upload.path),
              FileManager.default.fileExists(atPath: src.path) else {
            throw UploadBodyError.sourceMissing(upload.uploadId)
        }

        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("\(PublishModels.safe(upload.uploadId)).body")
        try? fm.removeItem(at: dest)
        fm.createFile(atPath: dest.path, contents: nil)

        let out = try FileHandle(forWritingTo: dest)
        defer { try? out.close() }

        let contentType: String
        switch request.upload.method {
        case .put:
            contentType = upload.mimeType
            try copy(from: src, into: out)

        case .post:
            // Long enough that it cannot occur inside an mp4 by chance, and still inside the 70
            // character limit RFC 2046 puts on a boundary.
            let boundary = "VideoKitBoundary-" + UUID().uuidString
            contentType = "multipart/form-data; boundary=\(boundary)"
            let name = PublishModels.fileName(upload)

            var head = ""
            for (field, value) in orderedFields(request, upload) {
                head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"\r\n\r\n\(value)\r\n"
            }
            // `filename=` on this part is what a server keys its own lookup on, which is what
            // makes an upload findable again after a response was lost. Changing it breaks
            // recovery in a way nothing catches until a customer loses a batch.
            head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(request.upload.fileField)\"; filename=\"\(name)\"\r\n"
            head += "Content-Type: \(upload.mimeType)\r\n\r\n"
            try out.write(contentsOf: Data(head.utf8))

            try copy(from: src, into: out)

            // CRLF before the closing delimiter and after it, both required.
            try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))
        }

        // The write offset rather than a stat: it is the same number without a second trip to the
        // filesystem, and it is read while the handle is still open.
        let size = Int64(try out.offset())
        return WrittenBody(url: dest, contentType: contentType, length: size)
    }

    /// The caller's fields, by name.
    ///
    /// Sorted rather than in the order they were written: the bridge hands them over as a
    /// dictionary, which has no order to preserve. Sorting at least makes a body reproducible, so
    /// a request and its retry diff cleanly against a server log. Multipart itself does not care,
    /// which is why the contract promises only that the fields come before the file.
    private static func orderedFields(_ request: PublishRequest, _ upload: PublishUpload) -> [(String, String)] {
        request.fields(for: upload).sorted { $0.key < $1.key }.map { ($0.key, $0.value) }
    }

    private static func copy(from src: URL, into out: FileHandle) throws {
        let input = try FileHandle(forReadingFrom: src)
        defer { try? input.close() }
        while true {
            let chunk = try autoreleasepool { try input.read(upToCount: 1 << 20) }
            guard let chunk, !chunk.isEmpty else { break }
            try out.write(contentsOf: chunk)
        }
    }
}
