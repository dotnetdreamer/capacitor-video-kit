import type { ThumbnailsOptions, ThumbnailsResult } from '../definitions';

import { FrameReader } from './media';

/**
 * Filmstrip frames, cut with one `<video>` and one canvas.
 *
 * One element and one canvas for the whole strip rather than one each: a browser holds a small
 * number of hardware decoders and the preview behind the editor wants one of them, so a strip that
 * opened a decoder per tile would take the picture off the screen while it cut.
 *
 * `precise` is accepted and ignored, and that is the honest answer rather than a shrug. The option
 * exists because the native thumbnailers CHOOSE between seeking to a keyframe and decoding forward
 * to the exact frame, and the second costs roughly one decode of the clip. A browser makes no such
 * choice: `currentTime = t` always lands on the frame at `t`. So the web strip is always the
 * precise one, and the flag has nothing left to select.
 *
 * A tile that will not seek ENDS the strip rather than failing it. The editor draws a short strip
 * perfectly well - it falls back to the poster frame for the rest - and one awkward keyframe
 * costing the customer their whole filmstrip would be the worse trade.
 */

/** Matching the browser host's own filmstrip: small tiles, cheap to encode, good enough to scrub. */
const JPEG_QUALITY = 0.7;

export async function thumbnails(options: ThumbnailsOptions): Promise<ThumbnailsResult> {
  const times = options.timesMs ?? [];
  if (times.length === 0) return { uris: [] };

  const reader = await FrameReader.open(options.uri);
  try {
    if (reader.width <= 0 || reader.height <= 0) return { uris: [] };

    const height = Math.max(1, Math.min(options.maxHeight || 160, reader.height));
    const width = Math.max(1, Math.round((reader.width / reader.height) * height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return { uris: [] };

    const uris: string[] = [];
    for (const timeMs of times) {
      // No frame interval to dedupe against here: the caller asked for these times specifically, so
      // a zero forces every one of them to be seeked even when two land on the same frame.
      if (!(await reader.seek(Math.max(0, timeMs) / 1000, 0))) break;
      ctx.drawImage(reader.video, 0, 0, width, height);
      uris.push(canvas.toDataURL('image/jpeg', JPEG_QUALITY));
    }
    return { uris };
  } finally {
    reader.close();
  }
}
