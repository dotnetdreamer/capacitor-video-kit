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
/// exist on disk and must not change while the task runs. That is why even the `PUT` path takes a
/// private copy rather than pointing at the caller's own file: whatever the caller does to its file
/// afterwards, the task in flight sends what was there when its body was written. The caller's file
/// is still needed until the batch is done, as it is on Android and the web, because every later
/// send - a resend after a 503, a `retry()`, a restart after a relaunch - writes its body from that
/// file again. It is also why nothing here reads a whole file into memory: a 100 MB video read into
/// a `Data` is exactly the jetsam the background transport exists to avoid.
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
    ///
    /// Only a source that is not there, or is empty, throws `UploadBodyError`. Everything else
    /// arrives as the error the filesystem raised, because a full disk and a missing file ask the
    /// caller for different things, and `PublisherSession.bodyFailure` is what tells them apart.
    static func write(request: PublishRequest, upload: PublishUpload, into dir: URL) throws -> WrittenBody {
        // Asked again rather than trusted from `publish()`: this runs for every send, and the
        // caller's file can have gone, or been emptied by a render redone over it, in between.
        guard let src = PublishModels.sourceFile(upload.path) else {
            throw UploadBodyError.sourceMissing(upload.uploadId)
        }

        let fm = FileManager.default
        try fm.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent("\(PublishModels.safe(upload.uploadId)).body")
        try? fm.removeItem(at: dest)

        do {
            switch request.upload.method {
            case .put: return try verbatim(src, to: dest, contentType: upload.mimeType)
            case .post: return try envelope(request, upload, from: src, to: dest)
            }
        } catch {
            // A body cut short, by a full disk most often, is worse than none: it sits on the very
            // space a retry needs until the batch is cleared.
            try? fm.removeItem(at: dest)
            throw error
        }
    }

    /// The file verbatim, so a clone where one will do rather than a stream.
    ///
    /// On APFS `copyItem` shares the source's blocks instead of copying them, so the private copy
    /// costs no space and next to no time, and the bodies live on the same volume as anything the
    /// app wrote itself. It is still a private copy: a clone is copy-on-write, so the caller
    /// deleting or rewriting its own file afterwards leaves this one exactly as it was. Across
    /// volumes the same call makes a real copy, which is slower and still correct. `src` arrives
    /// with its links already followed, which matters here: `copyItem` copies a link as the link.
    ///
    /// A clone also keeps the source's data protection class, which `copyfile` carries over on
    /// purpose, where a file written here takes the class every new file gets. That matters when
    /// the caller's file is locked down harder than `completeUntilFirstUserAuthentication`.
    /// `nsurlsessiond` reads the body while the phone is locked, and a `complete` body would fail
    /// the upload the moment the screen goes off, which is the one situation the background
    /// transport exists for. Such a file is streamed instead, as every body was before clones.
    private static func verbatim(_ src: URL, to dest: URL, contentType: String) throws -> WrittenBody {
        let protection = try FileManager.default.attributesOfItem(atPath: src.path)[.protectionKey]
        if clones(protection as? FileProtectionType) {
            try FileManager.default.copyItem(at: src, to: dest)
        } else {
            try stream(src, to: dest)
        }
        return WrittenBody(url: dest, contentType: contentType, length: Thumbnailer.fileBytes(dest))
    }

    /// A plain copy, a megabyte at a time, into a file created here, so it takes the class a new
    /// file gets rather than the source's.
    static func stream(_ src: URL, to dest: URL) throws {
        try Data().write(to: dest)
        let out = try FileHandle(forWritingTo: dest)
        defer { try? out.close() }
        try copy(from: src, into: out)
    }

    /// Whether a clone of a file protected this way can still be read with the phone locked. No
    /// class at all is what a volume without data protection reports.
    static func clones(_ protection: FileProtectionType?) -> Bool {
        switch protection {
        case nil, FileProtectionType.none?, FileProtectionType.completeUntilFirstUserAuthentication?: return true
        default: return false
        }
    }

    private static func envelope(_ request: PublishRequest, _ upload: PublishUpload,
                                 from src: URL, to dest: URL) throws -> WrittenBody {
        // An empty write rather than `createFile`, whose Bool says only that something went wrong:
        // this throws the reason, and the reason is what decides whether a retry can help.
        try Data().write(to: dest)
        let out = try FileHandle(forWritingTo: dest)
        defer { try? out.close() }

        // Long enough that it cannot occur inside an mp4 by chance, and still inside the 70
        // character limit RFC 2046 puts on a boundary.
        let boundary = "VideoKitBoundary-" + UUID().uuidString
        let name = PublishModels.fileName(upload)

        var head = ""
        for (field, value) in orderedFields(request, upload) {
            head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(field)\"\r\n\r\n\(value)\r\n"
        }
        // `filename=` on this part is what a server keys its own lookup on, which is what makes an
        // upload findable again after a response was lost. Changing it breaks recovery in a way
        // nothing catches until a customer loses a batch.
        head += "--\(boundary)\r\nContent-Disposition: form-data; name=\"\(request.upload.fileField)\"; filename=\"\(name)\"\r\n"
        head += "Content-Type: \(upload.mimeType)\r\n\r\n"
        try out.write(contentsOf: Data(head.utf8))

        try copy(from: src, into: out)

        // CRLF before the closing delimiter and after it, both required.
        try out.write(contentsOf: Data("\r\n--\(boundary)--\r\n".utf8))

        // The write offset rather than a stat: it is the same number without a second trip to the
        // filesystem, and it is read while the handle is still open.
        let size = Int64(try out.offset())
        return WrittenBody(url: dest, contentType: "multipart/form-data; boundary=\(boundary)", length: size)
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
