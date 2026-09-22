package net.dotnetdreamer.videokit.publisher

/**
 * Fills the finalize body with ids that did not exist when the caller wrote it.
 *
 * The caller hands over its complete JSON with `"$ID:<uploadId>"`, `"$IDS:<tag>"` and `"$IDS"`
 * where the ids go; those are replaced textually, quotes and all, so a string placeholder becomes
 * a bare JSON value. Doing it this way means the native side never has to understand the body's
 * schema - it can gain fields, change names or move things around without this plugin knowing,
 * which matters a lot for something that runs from a persisted record days later.
 *
 * Plain string work, never a regular expression: the body carries text the customer wrote (a
 * title, a comment) that may contain anything at all, and a `$` in it must stay a `$`.
 *
 * `"$IDS:<tag>"` is the one token scanned for rather than built, because it has to answer `[]` for
 * a tag nothing in this batch carries - the batch where the render failed and there are no clips
 * to name. Building the token only from the tags present would leave that one untouched, and a
 * literal `"$IDS:clip"` arriving at somebody's server is a 400 with a baffling message.
 */
object TemplateFill {

    private const val TAG_PREFIX = "\"\$IDS:"
    const val ALL_IDS = "\"\$IDS\""

    fun idToken(uploadId: String): String = "\"\$ID:$uploadId\""

    fun fill(template: String, uploads: List<UploadState>): String {
        var body = template
        for (upload in uploads) {
            val remoteId = upload.remoteId ?: continue
            body = body.replace(idToken(upload.uploadId), remoteId.toJsonLiteral())
        }
        body = fillTags(body, uploads)
        return body.replace(ALL_IDS, jsonArray(uploads))
    }

    /** Every `"$IDS:<tag>"`, replaced with the ids carrying it - an empty array when none do. */
    private fun fillTags(template: String, uploads: List<UploadState>): String {
        val out = StringBuilder(template.length)
        var from = 0

        while (true) {
            val at = template.indexOf(TAG_PREFIX, from)
            if (at < 0) break
            val close = template.indexOf('"', at + TAG_PREFIX.length)
            // An unterminated token is not a token. Leaving the rest alone is the safe reading.
            if (close < 0) break

            val tag = template.substring(at + TAG_PREFIX.length, close)
            out.append(template, from, at).append(jsonArray(uploads.filter { it.tag == tag }))
            from = close + 1
        }

        out.append(template, from, template.length)
        return out.toString()
    }

    // The separator is spelled out: joinToString defaults to ", " and would put stray spaces
    // inside the JSON array.
    private fun jsonArray(uploads: List<UploadState>): String = uploads
        .mapNotNull { it.remoteId?.toJsonLiteral() }
        .joinToString(separator = ",", prefix = "[", postfix = "]")
}
