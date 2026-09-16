import Foundation

/// The caller hands over its complete create-post JSON with `"$STITCHED"`, `"$ORIGINALS"` and
/// `"$ALL"` standing in for ids that do not exist yet. They are replaced textually, quotes
/// included, so a JSON string becomes a bare number or a bare array.
///
/// That is what lets the native side fill a body days later without understanding one field of the
/// post's schema, which matters when the record outlives the process that wrote it.
enum TemplateFill {
    static let stitchedToken  = "\"$STITCHED\""
    static let originalsToken = "\"$ORIGINALS\""
    static let allToken       = "\"$ALL\""

    /// Plain string replacement, never a regular expression. The body carries customer-written text
    /// - a post title, a comment - and a `$` in it has to stay a `$`. The quotes on the tokens are
    /// also what makes `"Best $5 pizza"` and a stray `$STITCHEDX` survive untouched.
    static func fill(_ template: String, stitched: Int, originals: [Int]) -> String {
        template
            .replacingOccurrences(of: stitchedToken, with: String(stitched))
            .replacingOccurrences(of: originalsToken, with: array(originals))
            .replacingOccurrences(of: allToken, with: array([stitched] + originals))
    }

    /// The stitched upload's id, falling back to the first upload's when nothing carries that role.
    ///
    /// The fallback is the "post the original clips" path after a render failed: there is no
    /// stitched video, and the server treats the first id as the post's own video anyway. In that
    /// case the first upload has effectively been promoted into the stitched slot, so it must not
    /// also appear in `originals`.
    static func ids(_ uploads: [UploadRecord]) throws -> (stitched: Int, originals: [Int]) {
        let roleStitched = uploads.first(where: { $0.role == Role.stitched })
        guard let stitched = roleStitched?.downloadId ?? uploads.first?.downloadId else {
            throw PublishError.noVideo
        }
        let rest = roleStitched != nil
            ? uploads.filter { $0.role == Role.original }
            : Array(uploads.dropFirst())
        let originals = try rest.map { u -> Int in
            guard let id = u.downloadId else { throw PublishError.missingId(u.uploadGuid) }
            return id
        }
        return (stitched, originals)
    }

    /// The separator is spelled out because the default `", "` would put stray spaces inside a JSON
    /// array that a strict parser on the other end has no reason to accept.
    private static func array(_ ids: [Int]) -> String {
        "[" + ids.map(String.init).joined(separator: ",") + "]"
    }
}
