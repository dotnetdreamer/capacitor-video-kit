import Capacitor
import Foundation

/// The record's own phase, the six-value `PublishPhase` of `definitions.ts`.
///
/// `ErrorRecord.phase` is a DIFFERENT, two-value union and the two are never assigned across: a
/// chain that fails while still `queued` records `uploading` on the error, because that is the step
/// that would have run next.
enum Phase {
    static let queued = "queued", uploading = "uploading", creating = "creating"
    static let done = "done", failed = "failed", cancelled = "cancelled"

    /// What `publish()` treats as "already going", matching Android's IN_FLIGHT set. Saying yes
    /// again to one of these is what keeps a retried JS call from double-posting.
    static let inFlight: Set<String> = [queued, uploading, creating]
}

enum UploadStatus { static let queued = "queued", uploading = "uploading", done = "done", failed = "failed" }

enum Role { static let stitched = "stitched", original = "original" }

enum FailureCode {
    static let network = "network", http = "http", auth = "auth"
    static let serverRejected = "server_rejected", fileMissing = "file_missing"
    static let cancelled = "cancelled", unknown = "unknown"
}

struct PublishUpload: Sendable {
    let uploadGuid: String
    let role: String
    let path: String
    let mimeType: String
    let pictureId: Int?
}

struct PublishRequest: Sendable {
    let pendingPostId: String
    let headers: [String: String]
    let uploadUrl: String
    let lookupUrlTemplate: String?
    let createUrl: String
    let bodyTemplate: String
    let uploads: [PublishUpload]
}

/// Always rejected with code `invalid_request`; only the message varies.
struct PublishRequestError: Error { let message: String }

enum PublishModels {

    /// Reproduces `PublishRequest.from` in `PublishModels.kt`: the same checks in the same order,
    /// throwing the same strings. They are the only diagnostic the JS side gets, and both engines
    /// are read by the same log reader.
    ///
    /// Deliberately not `call.decode(_:)`. A `DecodingError` from `JSValueDecoder` arrives with an
    /// empty coding path, so it cannot say `invalid_request:uploads[1].role`, which is the whole
    /// value of these messages.
    static func parse(_ call: CAPPluginCall) throws -> PublishRequest {
        guard let pendingPostId = call.getString("pendingPostId"), !pendingPostId.isEmpty else {
            throw PublishRequestError(message: "invalid_request:pendingPostId")
        }
        guard let uploadUrl = call.getString("uploadUrl"), !uploadUrl.isEmpty else {
            throw PublishRequestError(message: "invalid_request:uploadUrl")
        }
        guard let rawUploads = call.getArray("uploads"), !rawUploads.isEmpty else {
            throw PublishRequestError(message: "invalid_request:uploads")
        }

        var uploads: [PublishUpload] = []
        uploads.reserveCapacity(rawUploads.count)
        for (i, raw) in rawUploads.enumerated() {
            guard let o = raw as? JSObject else {
                throw PublishRequestError(message: "invalid_request:uploads[\(i)]")
            }
            guard let uploadGuid = string(o["uploadGuid"]), !uploadGuid.isEmpty else {
                throw PublishRequestError(message: "invalid_request:uploads[\(i)].uploadGuid")
            }
            guard let path = string(o["path"]), !path.isEmpty else {
                throw PublishRequestError(message: "invalid_request:uploads[\(i)].path")
            }
            // org.json's optString(key, default) only falls back when the key is absent, so an
            // explicit empty string would fail Android's check too.
            let role = string(o["role"]) ?? Role.original
            guard role == Role.stitched || role == Role.original else {
                throw PublishRequestError(message: "invalid_request:uploads[\(i)].role")
            }
            uploads.append(PublishUpload(
                uploadGuid: uploadGuid,
                role: role,
                path: path,
                mimeType: string(o["mimeType"]) ?? "application/octet-stream",
                // optInt(..., 0).takeIf { it > 0 }: a 0 and an unparseable value both mean "none".
                pictureId: int(o["pictureId"]).flatMap { $0 > 0 ? $0 : nil }
            ))
        }

        guard let createPost = call.getObject("createPost") else {
            throw PublishRequestError(message: "invalid_request:createPost")
        }
        guard let createUrl = string(createPost["url"]), !createUrl.isEmpty else {
            throw PublishRequestError(message: "invalid_request:createPost.url")
        }
        guard let bodyTemplate = string(createPost["bodyTemplate"]), !bodyTemplate.isEmpty else {
            throw PublishRequestError(message: "invalid_request:createPost.bodyTemplate")
        }

        return PublishRequest(
            pendingPostId: pendingPostId,
            headers: headers(call.getObject("headers")),
            uploadUrl: uploadUrl,
            // An empty template is the same as an absent one: the feature is simply off.
            lookupUrlTemplate: call.getString("lookupUrlTemplate").flatMap { $0.isEmpty ? nil : $0 },
            createUrl: createUrl,
            bodyTemplate: bodyTemplate,
            uploads: uploads
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

    /// `<guid>.<ext>`, Android's `fileNameFor`. This is the recovery key: the server stores the
    /// name without its extension as `Download.Filename`, which is what `download/byName/<guid>`
    /// looks up later. `URL.pathExtension` is not a substitute, because it neither strips a query
    /// nor applies the 8 character sanity cap that keeps a path like `a.thisisnotanextension` from
    /// becoming the stored extension.
    static func fileName(guid: String, path: String) -> String {
        let noQuery = String(path.prefix(while: { $0 != "?" }))
        let lastSegment = noQuery.split(separator: "/", omittingEmptySubsequences: false)
            .last.map(String.init) ?? noQuery
        guard let dot = lastSegment.lastIndex(of: "."),
              dot != lastSegment.index(before: lastSegment.endIndex) else {
            return "\(guid).mp4"
        }
        let ext = String(lastSegment[lastSegment.index(after: dot)...])
        guard !ext.isEmpty, ext.count <= 8 else { return "\(guid).mp4" }
        return "\(guid).\(ext)"
    }

    /// Android reads every header value with `optString`, so a JSON number arrives as its decimal
    /// text rather than being dropped. Anything else becomes an empty string, never a nil that
    /// would later box into a payload.
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

    /// The bridge boxes every JSON number as an `NSNumber`, so a plain `as? Int` is enough for an
    /// integer but not for one that came over as a double. A numeric string is accepted because
    /// org.json's `optInt` accepts one.
    private static func int(_ v: JSValue?) -> Int? {
        if let n = v as? NSNumber { return n.intValue }
        if let s = v as? String { return Int(s) }
        return nil
    }
}
