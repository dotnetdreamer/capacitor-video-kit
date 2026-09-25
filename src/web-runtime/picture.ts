/**
 * A picture on the timeline, decoded in the page.
 *
 * Three things need one - the preview, which holds it on screen for as long as its segment runs; the
 * browser render, which draws it into every frame of that segment; and the filmstrip, which tiles
 * it along the timeline - and all three want the same two answers: the picture the right way up, and
 * not a pixel bigger than it has to be. Both are settled here once.
 *
 * THE RIGHT WAY UP. A phone photo is stored sideways more often than not, with an EXIF tag saying
 * which way to turn it. An `<img>` applies that tag when it decodes - `image-orientation: from-image`
 * is every engine's default, and `naturalWidth` is measured after it - and `drawImage` of that
 * element keeps it. So the picture is drawn once onto a canvas, and what comes out is upright pixels
 * with no tag left to disagree about. `createImageBitmap(blob)` straight off the file would be one
 * step shorter and is exactly the step whose EXIF handling has changed between engine versions.
 *
 * NOT BIGGER THAN IT HAS TO BE. A 50 megapixel photo is 200 MB decoded. The painter re-uploads a
 * `<video>` every frame because a video moves, and a picture drawn from at full size would cost that
 * upload for a still - so the long side is capped by the caller, at what the place drawing it can
 * actually show.
 */

/** A photo that has neither loaded nor failed after this long is treated as one that failed. */
const DECODE_TIMEOUT_MS = 15_000;

export interface DecodedPicture {
  /** Upright, and no larger than was asked for. An `ImageBitmap` wherever the engine can make one. */
  bitmap: ImageBitmap | HTMLCanvasElement;
  width: number;
  height: number;
}

/** Whether a host source is a picture rather than a video. Absent `kind` is a video. */
export function isPictureSource(source: { kind?: string } | null | undefined): boolean {
  return source?.kind === 'image';
}

/**
 * The picture at `url`, upright, with its long side at most `maxEdge`. Rejects when it cannot be
 * decoded, which is the same answer for a file that has gone and for one that is not a picture.
 */
export async function decodePicture(url: string, maxEdge: number): Promise<DecodedPicture> {
  const image = await loadImage(url);
  try {
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) throw new Error('the picture has no size');
    const scale = Math.min(1, Math.max(1, maxEdge) / Math.max(naturalWidth, naturalHeight));
    const width = Math.max(1, Math.round(naturalWidth * scale));
    const height = Math.max(1, Math.round(naturalHeight * scale));

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D canvas to draw the picture on');
    context.drawImage(image, 0, 0, width, height);

    if (typeof createImageBitmap === 'function') {
      try {
        const bitmap = await createImageBitmap(canvas);
        // The canvas's pixels are copied into the bitmap; this lets the copy go at once rather
        // than whenever the canvas is collected.
        canvas.width = 0;
        canvas.height = 0;
        return { bitmap, width, height };
      } catch {
        // An engine that will not make one from a canvas still draws the canvas itself.
      }
    }
    return { bitmap: canvas, width, height };
  } finally {
    image.removeAttribute('src');
  }
}

/** A small JPEG of the picture, `maxHeight` tall at most, for a filmstrip tile. */
export async function pictureThumbnail(url: string, maxHeight: number): Promise<string> {
  const image = await loadImage(url);
  try {
    const naturalWidth = image.naturalWidth;
    const naturalHeight = image.naturalHeight;
    if (!(naturalWidth > 0) || !(naturalHeight > 0)) throw new Error('the picture has no size');
    const height = Math.max(1, Math.min(maxHeight, naturalHeight));
    const width = Math.max(1, Math.round((naturalWidth / naturalHeight) * height));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('no 2D canvas to draw the picture on');
    context.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL('image/jpeg', 0.75);
  } finally {
    image.removeAttribute('src');
  }
}

/**
 * The picture's upright size, or null when it will not decode. The cheap question a probe asks: is
 * this file still there, and is it a picture at all.
 *
 * Answered at `onload`, without the `decode()` the drawing paths wait for. The answer does not
 * depend on it: the size is known, EXIF-upright, as soon as the image has loaded, and a `decode()`
 * that fails has always counted as loaded (see [loadImage]). What skipping it saves is a
 * full-resolution decode per picture - a 12 MP photo is ~48 MB of pixels - that was thrown away the
 * moment the size was read, on the path an editor opening a draft of photos waits on, once per
 * photo and all at once. (The one case it answers differently is a decode still running after
 * [DECODE_TIMEOUT_MS]: that picture was called unreadable, and is now the size it is.)
 */
export async function measurePicture(url: string): Promise<{ width: number; height: number } | null> {
  try {
    const image = await loadImage(url, { decode: false });
    const size = { width: image.naturalWidth, height: image.naturalHeight };
    image.removeAttribute('src');
    return size.width > 0 && size.height > 0 ? size : null;
  } catch {
    return null;
  }
}

/**
 * Decodes one picture through an `<img>`, which is the path that honours its EXIF orientation.
 *
 * A picture from another origin is asked for with CORS, for the reason the render's own `<video>` is:
 * one drawn without it taints every canvas it touches, and a tainted canvas is one WebGL refuses and
 * a render cannot read back. A picture from this page's own origin - a blob, the host's own file
 * server - is asked for plainly, because there is nothing for CORS to protect there.
 */
function loadImage(url: string, { decode = true }: { decode?: boolean } = {}): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    if (!url) {
      reject(new Error('there is no file behind this picture'));
      return;
    }
    const image = new Image();
    if (crossOrigin(url)) image.crossOrigin = 'anonymous';
    let settled = false;
    const finish = (error: Error | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      image.onload = null;
      image.onerror = null;
      if (error) reject(error);
      else resolve(image);
    };
    const timer = setTimeout(() => finish(new Error(`the picture at ${url} did not load`)), DECODE_TIMEOUT_MS);
    image.onload = () => {
      // `onload` says the bytes are in; `decode()` says the pixels are, so the first draw does not
      // stall on a decode of its own. An engine without it has decoded by `onload` anyway.
      if (decode && typeof image.decode === 'function') {
        image.decode().then(
          () => finish(null),
          () => finish(null),
        );
      } else {
        finish(null);
      }
    };
    image.onerror = () => finish(new Error(`the picture at ${url} could not be decoded`));
    image.src = url;
  });
}

function crossOrigin(url: string): boolean {
  if (!/^https?:/i.test(url) || typeof location === 'undefined') return false;
  try {
    return new URL(url, location.href).origin !== location.origin;
  } catch {
    return false;
  }
}
