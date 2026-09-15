package net.dotnetdreamer.choisy.postpublisher

/**
 * Fills the create-post body with ids that did not exist when the caller wrote it.
 *
 * The caller hands over its complete JSON with `"$STITCHED"`, `"$ORIGINALS"` and `"$ALL"` where the
 * upload ids go; those are replaced textually, quotes and all, so a string placeholder becomes a
 * bare number or a bare array. Doing it this way means the native side never has to understand the
 * post's schema - it can gain fields, change names or move things around without this plugin
 * knowing, which matters a lot for something that runs from a persisted record days later.
 *
 * Plain string replacement, never a regular expression: the body carries customer-written text
 * (a post title, a comment) that may contain anything at all, and a `$` in it must stay a `$`.
 */
object TemplateFill {

    const val STITCHED = "\"\$STITCHED\""
    const val ORIGINALS = "\"\$ORIGINALS\""
    const val ALL = "\"\$ALL\""

    fun fill(template: String, stitched: Int, originals: List<Int>): String {
        val all = listOf(stitched) + originals
        return template
            .replace(STITCHED, stitched.toString())
            .replace(ORIGINALS, originals.toJsonArray())
            .replace(ALL, all.toJsonArray())
    }

    // The separator is spelled out: joinToString defaults to ", " and would put stray spaces inside
    // the JSON array.
    private fun List<Int>.toJsonArray(): String =
        joinToString(separator = ",", prefix = "[", postfix = "]")
}
