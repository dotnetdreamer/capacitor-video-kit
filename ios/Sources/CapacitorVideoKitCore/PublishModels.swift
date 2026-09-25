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
    ///
    /// A string is escaped the way `JSON.stringify` escapes one: the quote, the backslash, and every
    /// control character below U+0020, which JSON does not allow raw inside a string. Android's
    /// `JSONObject.quote` escapes the same set and also writes `/` as `\/`, so its text can differ
    /// from this for an id such as `uploads/a.mp4`, while every parser reads the two back as the
    /// same string. Missing a control character is not cosmetic. The filled body is parsed before
    /// it goes out, so an id with a tab in it would fail the batch as a bad template, on iOS alone,
    /// over a body the caller wrote correctly.
    var jsonLiteral: String {
        guard !isNumber else { return value }
        var out = "\""
        for scalar in value.unicodeScalars {
            switch scalar {
            case "\"": out += "\\\""
            case "\\": out += "\\\\"
            case "\n": out += "\\n"
            case "\r": out += "\\r"
            case "\t": out += "\\t"
            case "\u{08}": out += "\\b"
            case "\u{0C}": out += "\\f"
            // Lower-case hex, as both of the other engines write it.
            case _ where scalar.value < 0x20: out += String(format: "\\u%04x", scalar.value)
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out + "\""
    }

    /// What goes in the record, and in the state the caller reads.
    ///
    /// A number crosses the bridge as a number, whole or not: `remoteId` is `string | number` in the
    /// contract, and an id of `1.5` read back as the string `"1.5"` is the flattening the type
    /// exists to prevent. The web engine keeps it a number too. Android answers `toLongOrNull()`
    /// and so still hands back the text for a fraction. Nothing here depends on that difference,
    /// because the finalize body is built from `jsonLiteral` either way.
    var jsonValue: Any {
        guard isNumber else { return value }
        if let whole = Int64(value) { return NSNumber(value: whole) }
        if let fraction = Double(value) { return NSNumber(value: fraction) }
        return value
    }

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
        // Empty, `.` or `..` (`JobFolders.batchIdRefusal`) as well as missing. The publisher files a
        // batch under names made from its id - its bodies folder (`PublishStore.bodiesDir`) and its
        // job folder's done marker (`JobFolders.doneMarker`) - and both rename `.` and `..` to `_`
        // and `__`, which are other batches' names: `clear` of `..` would delete the live bodies of
        // a publish called `__`, and a `..` publish that finished would mark `__`'s job folder done
        // for the sweep. Refused, as the composer's `prepareJob` refuses them, rather than renamed.
        guard let batchId = call.getString("batchId"), JobFolders.batchIdRefusal(batchId) == nil else {
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
    /// as given.
    ///
    /// `URL(string:)` is asked only when it cannot get the answer wrong. A host that builds the
    /// URI itself can leave a space, a `#` or a `?` unencoded, as a picked file's name often
    /// carries one. On iOS 16 a raw space makes `URL(string:)` return nil. A raw `#` or `?` is
    /// worse on every version: it parses as a fragment or a query, and the path comes back cut
    /// short, naming a different file or none. So a URI with no escape in it is taken as the path
    /// it already is, one with a `#` or a `?` is decoded by hand, and only a cleanly encoded one,
    /// such as every URI the kit itself hands out, is parsed.
    ///
    /// That is a deliberate difference from Android, whose `Uri.getPath` cuts at a raw `#` or `?`
    /// the way the parser here would. There `file:///x/My Clip #1.mp4` names `/x/My Clip ` and
    /// fails as missing, and `file:///x/a.mp4?v=2` names `/x/a.mp4`. Here the first is the file
    /// its name says, and the second is a file whose name ends in `?v=2`. A `#` in a picked file's
    /// name is ordinary, while a query on a `file:` URI is nothing the kit ever writes, so the name
    /// is read whole.
    static func fileURL(_ path: String) -> URL? {
        if path.hasPrefix("file://") {
            let rest = path.dropFirst("file://".count)
            // Whatever comes before the first `/` is the authority, `localhost` when there is one
            // at all. It names this machine, not a folder, and Android's `getPath` drops it the
            // same way. With no `/` there is no path, and resolving the remainder against the
            // working directory would name a file nobody meant.
            guard let slash = rest.firstIndex(of: "/") else { return nil }
            let raw = String(rest[slash...])
            if !raw.contains("%") { return URL(fileURLWithPath: raw) }
            if !rest.contains("#"), !rest.contains("?"), let u = URL(string: path), u.isFileURL {
                return URL(fileURLWithPath: u.path)
            }
            return URL(fileURLWithPath: raw.removingPercentEncoding ?? raw)
        }
        if path.hasPrefix("/") { return URL(fileURLWithPath: path) }
        // A content:// style URI has no meaning on iOS, and guessing would upload the wrong bytes.
        return nil
    }

    /// The file an upload sends, followed through any symbolic link, or nil when there is nothing
    /// to send: no such file, a directory, or an empty file.
    ///
    /// Empty counts as missing on every engine. Android's `UploadWorker` checks `length() == 0L`
    /// and the web runner `blob.size === 0`, because a render cut short, or one being redone over
    /// the same path, leaves exactly that behind, and a presigned `PUT` would store it without
    /// complaint. The link is followed first because a size read through one is the link's own, a
    /// few dozen bytes whatever it points at.
    static func sourceFile(_ path: String) -> URL? {
        guard let url = fileURL(path)?.resolvingSymlinksInPath(), Thumbnailer.fileBytes(url) > 0 else { return nil }
        return url
    }

    /// `<uploadId>.<ext>`, unless the caller named the file itself - Android's `fileNameFor`.
    ///
    /// `URL.pathExtension` is not a substitute, because it does not apply the 8 character sanity
    /// cap that keeps a path like `a.thisisnotanextension` from becoming the stored extension.
    static func fileName(_ upload: PublishUpload) -> String {
        if let named = upload.fileName, !named.isEmpty { return named }
        return fileName(id: upload.uploadId, path: upload.path)
    }

    /// The extension is read from the file `fileURL` resolves, not from the text of the path.
    /// Android's `fileNameFor` cuts the path at a `?` first, which agrees with its own `fileFor`.
    /// Here `fileURL` keeps a raw `?` as part of the name, so cutting there would send
    /// `file:///x/clip?1.mov` as `<id>.mp4` and put the wrong extension in a presigned URL's
    /// `{fileName}`. A path that names no file gets the default, as one without an extension does.
    static func fileName(id: String, path: String) -> String {
        guard let lastSegment = fileURL(path)?.lastPathComponent,
              let dot = lastSegment.lastIndex(of: "."),
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
