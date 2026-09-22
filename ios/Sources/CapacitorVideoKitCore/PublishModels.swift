import Capacitor
import Foundation

/// The record's own phase, the six-value `PublishPhase` of `definitions.ts`.
///
/// `ErrorRecord.phase` is a DIFFERENT, two-value union and the two are never assigned across: a
/// chain that fails while still `queued` records `uploading` on the error, because that is the step
/// that would have run next.
enum Phase {
    static let queued = "queued", uploading = "uploading", finalizing = "finalizing"
    static let done = "done", failed = "failed", cancelled = "cancelled"

    /// What `publish()` treats as "already going", matching Android's IN_FLIGHT set. Saying yes
    /// again to one of these is what keeps a retried JS call from sending twice.
    static let inFlight: Set<String> = [queued, uploading, finalizing]
}

enum UploadStatus { static let queued = "queued", uploading = "uploading", done = "done", failed = "failed" }

enum FailureCode {
    static let network = "network", http = "http", auth = "auth"
    static let serverRejected = "server_rejected", fileMissing = "file_missing"
    static let cancelled = "cancelled", unknown = "unknown"
}

/// The multipart part that carries the bytes, when the transport does not name one.
let defaultFileField = "file"

/// How the bytes go up: `POST` a multipart form, or `PUT` the file as the raw body.
enum UploadMethod: String, Sendable {
    case post = "POST"
    case put = "PUT"

    static func parse(_ raw: String?, _ path: String) throws -> UploadMethod {
        guard let raw, !raw.isEmpty else { return .post }
        guard let method = UploadMethod(rawValue: raw.uppercased()) else {
            throw PublishRequestError(message: "invalid_request:\(path)")
        }
        return method
    }
}

/// An id the server gave a stored file, keeping the JSON type it arrived as.
///
/// The type is not cosmetic: it goes straight back into the caller's body template, and a row id
/// that left as `12` and comes back as `"12"` is a 400 from somebody's server.
struct RemoteId: Codable, Sendable, Equatable {
    let value: String
    let isNumber: Bool

    /// The id as a JSON value, ready to splice into the body.
    var jsonLiteral: String {
        guard !isNumber else { return value }
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "\"", with: "\\\"")
            .replacingOccurrences(of: "\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\r")
            .replacingOccurrences(of: "\t", with: "\t")
        return "\"\(escaped)\""
    }

    /// What goes in the record, and in the state the caller reads.
    var jsonValue: Any { isNumber ? (Int(value) ?? value as Any) : value }

    static func of(_ raw: Any?) -> RemoteId? {
        switch raw {
        case let n as NSNumber:
            // A Bool boxes as NSNumber too, and is never an id.
            if CFGetTypeID(n) == CFBooleanGetTypeID() { return nil }
            if n.doubleValue == n.doubleValue.rounded() { return RemoteId(value: String(n.int64Value), isNumber: true) }
            return RemoteId(value: n.stringValue, isNumber: true)
        case let s as String:
            return s.isEmpty ? nil : RemoteId(value: s, isNumber: false)
        default:
            return nil
        }
    }
}

struct PublishTransport: Sendable {
    let url: String
    let method: UploadMethod
    let fileField: String
    let fields: [String: String]
    let idPath: String?
    let lookupUrlTemplate: String?
}

struct PublishUpload: Sendable {
    let uploadId: String
    let tag: String
    let path: String
    let mimeType: String
    let url: String?
    let fileName: String?
    let fields: [String: String]
}

struct PublishFinalize: Sendable {
    let url: String
    let method: UploadMethod
    let bodyTemplate: String
    let requirePath: String?
}

struct PublishRequest: Sendable {
    let batchId: String
    let headers: [String: String]
    let upload: PublishTransport
    let uploads: [PublishUpload]
    let finalize: PublishFinalize
}

/// Always rejected with code `invalid_request`; only the message varies.
struct PublishRequestError: Error { let message: String }

enum PublishModels {

    /// Reproduces `PublishRequest.from` in `PublishModels.kt`: the same checks in the same order,
    /// throwing the same strings. They are the only diagnostic the JS side gets, and both engines
    /// are read by the same log reader.
    ///
    /// Deliberately not `call.decode(_:)`. A `DecodingError` from `JSValueDecoder` arrives with an
    /// empty coding path, so it cannot say `invalid_request:uploads[1].path`, which is the whole
    /// value of these messages.
    static func parse(_ call: CAPPluginCall) throws -> PublishRequest {
        guard let batchId = call.getString("batchId"), !batchId.isEmpty else {
            throw PublishRequestError(message: "invalid_request:batchId")
        }

        guard let rawTransport = call.getObject("upload") else {
            throw PublishRequestError(message: "invalid_request:upload")
        }
        guard let transportUrl = string(rawTransport["url"]), !transportUrl.isEmpty else {
            throw PublishRequestError(message: "invalid_request:upload.url")
        }
        let transport = PublishTransport(
            url: transportUrl,
            method: try UploadMethod.parse(string(rawTransport["method"]), "upload.method"),
            fileField: nonEmpty(rawTransport["fileField"]) ?? defaultFileField,
            fields: headers(rawTransport["fields"]),
            idPath: nonEmpty(rawTransport["idPath"]),
            // An empty template is the same as an absent one: the feature is simply off.
            lookupUrlTemplate: nonEmpty(rawTransport["lookupUrlTemplate"])
        )

        guard let rawUploads = call.getArray("uploads"), !rawUploads.isEmpty else {
            throw PublishRequestError(message: "invalid_request:uploads")
        }
        var uploads: [PublishUpload] = []
        uploads.reserveCapacity(rawUploads.count)
        for (i, raw) in rawUploads.enumerated() {
            guard let o = raw as? JSObject else {
                throw PublishRequestError(message: "invalid_request:uploads[\(i)]")
            }
            guard let uploadId = string(o["uploadId"]), !uploadId.isEmpty else {
                throw PublishRequestError(message: "invalid_request:uploads[\(i)].uploadId")
            }
            guard let path = string(o["path"]), !path.isEmpty else {
                throw PublishRequestError(message: "invalid_request:uploads[\(i)].path")
            }
            uploads.append(PublishUpload(
                uploadId: uploadId,
                // Any string at all: the plugin never interprets a tag.
                tag: string(o["tag"]) ?? "",
                path: path,
                mimeType: nonEmpty(o["mimeType"]) ?? "application/octet-stream",
                url: nonEmpty(o["url"]),
                fileName: nonEmpty(o["fileName"]),
                fields: headers(o["fields"])
            ))
        }

        guard let rawFinalize = call.getObject("finalize") else {
            throw PublishRequestError(message: "invalid_request:finalize")
        }
        guard let finalizeUrl = string(rawFinalize["url"]), !finalizeUrl.isEmpty else {
            throw PublishRequestError(message: "invalid_request:finalize.url")
        }
        guard let bodyTemplate = string(rawFinalize["bodyTemplate"]), !bodyTemplate.isEmpty else {
            throw PublishRequestError(message: "invalid_request:finalize.bodyTemplate")
        }

        return PublishRequest(
            batchId: batchId,
            headers: headers(call.getObject("headers")),
            upload: transport,
            uploads: uploads,
            finalize: PublishFinalize(
                url: finalizeUrl,
                method: try UploadMethod.parse(string(rawFinalize["method"]), "finalize.method"),
                bodyTemplate: bodyTemplate,
                requirePath: nonEmpty(rawFinalize["requirePath"])
            )
        )
    }

    /// Android's `s.replace(Regex("[^A-Za-z0-9._-]"), "_")`. Used for file names only; the id
    /// itself is always echoed back unmodified.
    static func safe(_ s: String) -> String {
        String(s.map { c in
            let keep = (c.isLetter && c.isASCII) || (c.isNumber && c.isASCII) || c == "." || c == "_" || c == "-"
            return keep ? c : "_"
        })
    }

    /// Android's `fileFor`: a `file:` scheme takes the URI's path, a null scheme takes the string
    /// as given. The percent-decode fallback matters because a picked file can carry spaces or a
    /// `#`, either of which defeats `URL(string:)` outright.
    static func fileURL(_ path: String) -> URL? {
        if path.hasPrefix("file://") {
            if let u = URL(string: path), u.isFileURL { return URL(fileURLWithPath: u.path) }
            let rest = String(path.dropFirst("file://".count))
            return URL(fileURLWithPath: rest.removingPercentEncoding ?? rest)
        }
        if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
        // A content:// style URI has no meaning on iOS, and guessing would upload the wrong bytes.
        return nil
    }

    /// `<uploadId>.<ext>`, unless the caller named the file itself - Android's `fileNameFor`.
    ///
    /// `URL.pathExtension` is not a substitute, because it neither strips a query nor applies the
    /// 8 character sanity cap that keeps a path like `a.thisisnotanextension` from becoming the
    /// stored extension.
    static func fileName(_ upload: PublishUpload) -> String {
        if let named = upload.fileName, !named.isEmpty { return named }
        return fileName(id: upload.uploadId, path: upload.path)
    }

    static func fileName(id: String, path: String) -> String {
        let noQuery = String(path.prefix(while: { $0 != "?" }))
        let lastSegment = noQuery.split(separator: "/", omittingEmptySubsequences: false)
            .last.map(String.init) ?? noQuery
        guard let dot = lastSegment.lastIndex(of: "."),
              dot != lastSegment.index(before: lastSegment.endIndex) else {
            return "\(id).mp4"
        }
        let ext = String(lastSegment[lastSegment.index(after: dot)...])
        guard !ext.isEmpty, ext.count <= 8 else { return "\(id).mp4" }
        return "\(id).\(ext)"
    }

    /// Android reads every header value with `optString`, so a JSON number arrives as its decimal
    /// text rather than being dropped. Anything else becomes an empty string, never a nil that
    /// would later box into a payload. Form fields are read the same way.
    static func headers(_ any: Any?) -> [String: String] {
        guard let any else { return [:] }
        var raw: [String: Any] = [:]
        if let d = any as? [String: Any] {
            raw = d
        } else if let d = any as? NSDictionary {
            for (k, v) in d { if let k = k as? String { raw[k] = v } }
        } else {
            return [:]
        }
        var out: [String: String] = [:]
        for (k, v) in raw {
            if let s = v as? String { out[k] = s } else if let n = v as? NSNumber { out[k] = n.stringValue } else { out[k] = "" }
        }
        return out
    }

    /* ---------------------------------------------------------------------------------------- */

    private static func string(_ v: JSValue?) -> String? {
        v as? String
    }

    private static func nonEmpty(_ v: JSValue?) -> String? {
        guard let s = v as? String, !s.isEmpty else { return nil }
        return s
    }
}

/// Resolving the request: the same three answers `state.ts` and `PublishModels.kt` give, because a
/// URL built one way here and another way there is a different object key.
extension PublishRequest {

    func uploadFor(_ uploadId: String) -> PublishUpload? {
        uploads.first { $0.uploadId == uploadId }
    }

    /// Where one file goes. The upload's own URL wins, which is how per-file presigning works.
    func uploadUrl(for upload: PublishUpload) -> String {
        PublishRequest.expandUrl(upload.url ?? self.upload.url,
                                 uploadId: upload.uploadId,
                                 fileName: PublishModels.fileName(upload))
    }

    /// The transport's parts and this file's own, the file's winning.
    func fields(for upload: PublishUpload) -> [String: String] {
        var merged = self.upload.fields
        for (name, value) in upload.fields { merged[name] = value }
        let name = PublishModels.fileName(upload)
        return merged.mapValues { PublishRequest.expandField($0, uploadId: upload.uploadId, fileName: name) }
    }

    /// The lookup URL for one upload, or nil when the caller did not offer a template.
    func lookupUrl(for uploadId: String) -> String? {
        guard let template = upload.lookupUrlTemplate else { return nil }
        let name = uploadFor(uploadId).map { PublishModels.fileName($0) } ?? ""
        return PublishRequest.expandUrl(template, uploadId: uploadId, fileName: name)
    }

    /// Percent-encoded, because it is going in a URL.
    static func expandUrl(_ template: String, uploadId: String, fileName: String) -> String {
        template
            .replacingOccurrences(of: "{uploadId}", with: encodeURIComponent(uploadId))
            .replacingOccurrences(of: "{fileName}", with: encodeURIComponent(fileName))
    }

    /// Left literal: a form field is not a URL.
    static func expandField(_ value: String, uploadId: String, fileName: String) -> String {
        value
            .replacingOccurrences(of: "{uploadId}", with: uploadId)
            .replacingOccurrences(of: "{fileName}", with: fileName)
    }

    /// `encodeURIComponent`, to the character.
    ///
    /// Not `addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)`, whose set is a
    /// different one: it leaves `/`, `:` and `@` alone, and a `/` that survives into an object key
    /// is a different key. The unreserved set is spelled out so the phone and the browser agree,
    /// which with a presigned URL is the difference between a valid signature and a 403.
    static func encodeURIComponent(_ value: String) -> String {
        let unreserved = CharacterSet(charactersIn:
            "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")
        return value.addingPercentEncoding(withAllowedCharacters: unreserved) ?? value
    }
}
