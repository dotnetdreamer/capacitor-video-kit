package net.dotnetdreamer.videokit.videocomposer

/**
 * The host's ceiling on the size of the finished file, [Output.maxBytes]: the rule and the words of
 * a `too_large` failure, apart from the plugin so both can be pinned on the JVM.
 *
 * WHY A HOST SETS ONE. A host that uploads the video has a server that refuses a file past some
 * size - choisy's takes nothing over 100 MB - and a render that finishes a little past it is a
 * customer who waited for a file they cannot post. It is the host's number and not the kit's,
 * because a host that keeps its videos on the phone has no such limit, and there a 4K render may
 * be as large as it comes out.
 *
 * WHY IT IS NOT REFUSED BY ESTIMATE. The encoder spends [Output.videoBitrate] as a VARIABLE rate,
 * so a post of still shots comes in well under what its bitrate and its length multiply out to. A
 * render refused on that product would be refused while the file it was going to make fitted. So
 * the ceiling is held against the file itself, twice: the plugin measures the file being written
 * on every progress poll and stops the export the moment it has grown past the ceiling, and
 * measures the finished file once more before reporting it, because the muxer writes the file's
 * index last, after the last poll. Either way the file is deleted and the render fails `too_large`.
 *
 * iOS holds a render to the same ceiling in its `WriterEngine`, and through `fileLengthLimit` in
 * its `AVAssetExportSession` fallback; the web counts the bytes its muxer hands out.
 */
object SizeCeiling {

    /**
     * The message a render that has written [bytes] fails `too_large` with when [maxBytes] is its
     * ceiling, or null while the file is within it - and always null with no ceiling at all.
     *
     * A file of exactly [maxBytes] is within it: the contract's ceiling is the most bytes the file
     * MAY have. The message is `too_large max=<ceiling> bytes=<bytes reached>` on every engine,
     * both numbers whole, because a log line read off two platforms is only comparable if it is the
     * same line. The bytes are those reached when the render was stopped, which on a stop
     * mid-export is how far past the ceiling one poll interval got, and not the size the finished
     * file would have had: nobody can know that without writing it.
     */
    fun tooLarge(bytes: Long, maxBytes: Long?): String? =
        if (maxBytes != null && bytes > maxBytes) "too_large max=$maxBytes bytes=$bytes" else null
}
