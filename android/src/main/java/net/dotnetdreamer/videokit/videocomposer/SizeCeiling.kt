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
 * the ceiling is held against what is actually written, twice. While the export runs, every
 * progress poll asks about the bytes of encoded video and sound the muxer has been handed so far,
 * which [CountingMuxer] adds up, and stops the export the moment they are past the ceiling. Once it
 * has finished, the file itself is measured before it is reported, because it is those samples plus
 * the header and the index, which no count saw. Either way the file is deleted and the render fails
 * `too_large`.
 *
 * WHY NOT THE PART FILE'S LENGTH WHILE IT IS WRITTEN. Media3's own muxer (`Mp4Writer`, behind
 * `DefaultMuxer`) does not grow the file one sample at a time. It starts by holding 400,000 bytes
 * after the header for the index, so that the finished file starts to play before it has finished
 * downloading. Once the index outgrows that - after five to seven minutes of 30 fps video with
 * sound - it moves the index to the end, and from then on writes it again past a gap it leaves for
 * the samples to come, a fifth of the file at a time, which it trims only when the file is closed.
 * The length of a file being written can therefore be a fifth larger than the file it will become,
 * and a long post heading for 90 MB could read as past a 100 MB ceiling and be stopped for a file
 * that would have fitted. The muxer keeps every sample it is handed - all it drops is a video frame
 * ahead of the first key frame, which an encoder never produces - so every byte counted is in the
 * finished file, which holds more besides. The poll can only stop a render the finished-file check
 * would have failed anyway, and that check stays the one that sees the whole file.
 * `CountingMuxerTest` runs Media3's muxer on the JVM to pin both.
 *
 * iOS holds a render to the same ceiling in its `WriterEngine`, and through `fileLengthLimit` in
 * its `AVAssetExportSession` fallback; the web counts the packets its encoders hand its muxer, as
 * this engine does.
 */
object SizeCeiling {

    /**
     * The message a render that has written [bytes] fails `too_large` with when [maxBytes] is its
     * ceiling, or null while the file is within it - and always null with no ceiling at all.
     *
     * A file of exactly [maxBytes] is within it: the contract's ceiling is the most bytes the file
     * MAY have. The message is `too_large max=<ceiling> bytes=<bytes reached>` on every engine,
     * both numbers whole, because a log line read off two platforms is only comparable if it is the
     * same line. The bytes are those reached when the render was stopped: on a stop mid-export the
     * samples written by then, how far past the ceiling one poll interval got, and not the size the
     * finished file would have had, which nobody can know without writing it; on the finished file,
     * its size.
     */
    fun tooLarge(bytes: Long, maxBytes: Long?): String? =
        if (maxBytes != null && bytes > maxBytes) "too_large max=$maxBytes bytes=$bytes" else null

    /**
     * The room on disk a render asks for before it starts, given [estimate], what its bitrates and
     * its length multiply out to: all of it with no ceiling, and with [maxBytes] never more than
     * the part file can reach before the render is stopped.
     *
     * That is the ceiling, plus [slackBytes] for the samples one poll lets past it and for the
     * header and the index, plus the fifth `Mp4Writer` can leave ahead of the samples (see above),
     * counted whether or not the filesystem stores that gap. Without the cap a long post on a
     * nearly full phone would be refused `no_space` for a file the ceiling keeps far smaller: a
     * refusal by estimate, which is what holding the ceiling against the file is there to avoid.
     * Worked in doubles, so that a ceiling near the largest Long cannot overflow into a small one.
     */
    fun diskEstimate(estimate: Long, maxBytes: Long?, slackBytes: Long): Long {
        if (maxBytes == null) return estimate
        val most = maxBytes * 1.2 + slackBytes
        return if (most < estimate) most.toLong() else estimate
    }
}
