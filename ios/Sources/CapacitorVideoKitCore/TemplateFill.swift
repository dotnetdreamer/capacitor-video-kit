import Foundation

/// The caller hands over its complete JSON with `"$ID:<uploadId>"`, `"$IDS:<tag>"` and `"$IDS"`
/// standing in for ids that do not exist yet. They are replaced textually, quotes included, so a
/// JSON string becomes a bare value or a bare array.
///
/// That is what lets the native side fill a body days later without understanding one field of the
/// caller's schema, which matters when the record outlives the process that wrote it.
enum TemplateFill {
    static let tagPrefix = "\"$IDS:"
    static let allIdsToken = "\"$IDS\""

    static func idToken(_ uploadId: String) -> String { "\"$ID:\(uploadId)\"" }

    /// Plain string replacement, never a regular expression. The body carries customer-written text
    /// - a title, a comment - and a `$` in it has to stay a `$`. The quotes on the tokens are also
    /// what makes `"Best $5 pizza"` and a stray `$IDX` survive untouched.
    static func fill(_ template: String, uploads: [UploadRecord]) -> String {
        var body = template
        for upload in uploads {
            guard let remoteId = upload.remoteId else { continue }
            body = body.replacingOccurrences(of: idToken(upload.uploadId), with: remoteId.jsonLiteral)
        }
        body = fillTags(body, uploads: uploads)
        return body.replacingOccurrences(of: allIdsToken, with: array(uploads))
    }

    /// Every `"$IDS:<tag>"`, replaced with the ids carrying it - an empty array when none do.
    ///
    /// Scanned for rather than built, because it has to answer `[]` for a tag nothing in this batch
    /// carries: the batch where the render failed and there are no clips to name. Building the
    /// token only from the tags present would leave that one untouched, and a literal
    /// `"$IDS:clip"` arriving at somebody's server is a 400 with a baffling message.
    private static func fillTags(_ template: String, uploads: [UploadRecord]) -> String {
        var out = ""
        var cursor = template.startIndex

        while let open = template.range(of: tagPrefix, range: cursor..<template.endIndex) {
            // An unterminated token is not a token. Leaving the rest alone is the safe reading.
            guard let close = template.range(of: "\"", range: open.upperBound..<template.endIndex) else { break }
            let tag = String(template[open.upperBound..<close.lowerBound])
            out += template[cursor..<open.lowerBound]
            out += array(uploads.filter { $0.tag == tag })
            cursor = close.upperBound
        }

        out += template[cursor...]
        return out
    }

    /// Whether every upload has an id. The one thing about the body that IS checked: a token
    /// naming nothing is left alone, because at this level a typo and a sentence look identical.
    static func missingId(_ uploads: [UploadRecord]) -> String? {
        uploads.first(where: { $0.remoteId == nil })?.uploadId
    }

    /// The separator is spelled out because the default `", "` would put stray spaces inside a JSON
    /// array that a strict parser on the other end has no reason to accept.
    private static func array(_ uploads: [UploadRecord]) -> String {
        "[" + uploads.compactMap { $0.remoteId?.jsonLiteral }.joined(separator: ",") + "]"
    }
}
