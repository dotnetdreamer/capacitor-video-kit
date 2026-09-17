import type { ComposeFit, ComposeRect } from '../definitions';

/** What an absent `crop` or `rect` means: all of it. */
export const FULL_FRAME: ComposeRect = { x: 0, y: 0, w: 1, h: 1 };

export interface Frame {
  width: number;
  height: number;
}

export interface Framing {
  fit: ComposeFit;
  crop?: ComposeRect;
  rect?: ComposeRect;
}

/**
 * Which part of the ORIENTED source frame the OUTPUT frame shows, in fractions of the source with
 * a top-left origin and y down - crop, fit and rect folded into ONE rectangle.
 *
 * A straight port of `RenderPlan.sourceWindow`, and it has to stay one: the whole promise of this
 * package is that the same manifest produces the same picture on a phone and in a browser, and the
 * one place that could quietly stop being true is the arithmetic that decides which pixels of the
 * source land where.
 *
 * The result is deliberately allowed OUTSIDE 0..1. A letterbox bar is a piece of the output that
 * corresponds to no piece of the source, so a clip letterboxed top and bottom returns a window with
 * a negative y and a height above 1, and the sampler is expected to paint black wherever the window
 * falls off the source - which is exactly what GL's clamp-to-border does natively and what
 * [sampleIsInside] checks for here.
 *
 * `fit` is measured on the CROPPED picture against the destination rectangle, both in real pixels,
 * because a ratio of two shapes cannot be taken in fractions of two different frames. COVER
 * overflows its rectangle and, with one window and nothing to clip against, the only place the
 * overflow can go is out of the source window - so COVER narrows the crop to the destination's
 * shape instead of scaling past it. The picture that reaches the screen is the same either way.
 */
export function sourceWindow(
  clip: Framing,
  frame: Frame,
  inputWidth: number,
  inputHeight: number,
): ComposeRect {
  const crop = clip.crop ?? FULL_FRAME;
  const rect = clip.rect ?? FULL_FRAME;

  // One pixel floors everywhere, so a hand-built spec cannot divide by zero below and turn the
  // window into NaN, which would show up as a black clip and nothing else.
  const picW = Math.max(1, crop.w * inputWidth);
  const picH = Math.max(1, crop.h * inputHeight);
  const boxW = Math.max(1, rect.w * frame.width);
  const boxH = Math.max(1, rect.h * frame.height);

  // src maps onto dst exactly, with no part of the picture left over: the whole of the fit is in
  // the pair, and what follows is the same three lines for either fit.
  let src: ComposeRect;
  let dst: ComposeRect;
  if (clip.fit === 'cover') {
    const scale = Math.max(boxW / picW, boxH / picH);
    // What the destination can actually show of the picture, back in source fractions. The min()
    // is only there because the axis the scale came from divides out to the crop's own side and
    // float arithmetic can land a hair over it.
    const visW = Math.min(boxW / scale / inputWidth, crop.w);
    const visH = Math.min(boxH / scale / inputHeight, crop.h);
    src = { x: crop.x + (crop.w - visW) / 2, y: crop.y + (crop.h - visH) / 2, w: visW, h: visH };
    dst = rect;
  } else {
    const scale = Math.min(boxW / picW, boxH / picH);
    const drawW = (picW * scale) / frame.width;
    const drawH = (picH * scale) / frame.height;
    src = crop;
    dst = { x: rect.x + (rect.w - drawW) / 2, y: rect.y + (rect.h - drawH) / 2, w: drawW, h: drawH };
  }

  // src sits on dst, so source fractions per output fraction is the ratio of their sides; running
  // that back out to the whole output frame says where its corners sit on the source. The window's
  // aspect is the OUTPUT's by construction, which is what lets the caller declare the output size
  // and get no distortion out of it.
  const kx = src.w / dst.w;
  const ky = src.h / dst.h;
  return { x: src.x - dst.x * kx, y: src.y - dst.y * ky, w: kx, h: ky };
}

/**
 * The same window as a destination rectangle in OUTPUT pixels, for the 2D canvas path.
 *
 * `drawImage` takes a source rectangle and a destination rectangle and cannot sample outside the
 * image, so the window has to be turned back into the pair it came from: the part of the source
 * that actually exists, and where on the frame it lands. Everything the window asks for outside the
 * source is a letterbox bar, and a bar is simply a piece of the frame nothing is drawn on - which
 * is why the caller clears to black first and this returns null for a window that misses the source
 * altogether.
 */
export function drawRects(
  window: ComposeRect,
  frame: Frame,
  inputWidth: number,
  inputHeight: number,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null {
  // The window in source fractions, clipped to the source that exists.
  const x0 = Math.max(0, window.x);
  const y0 = Math.max(0, window.y);
  const x1 = Math.min(1, window.x + window.w);
  const y1 = Math.min(1, window.y + window.h);
  if (!(x1 > x0) || !(y1 > y0) || !(window.w > 0) || !(window.h > 0)) return null;

  // Where that clipped piece lands on the frame, as fractions of it, then in pixels.
  const dx0 = (x0 - window.x) / window.w;
  const dy0 = (y0 - window.y) / window.h;
  const dx1 = (x1 - window.x) / window.w;
  const dy1 = (y1 - window.y) / window.h;

  return {
    sx: x0 * inputWidth,
    sy: y0 * inputHeight,
    sw: (x1 - x0) * inputWidth,
    sh: (y1 - y0) * inputHeight,
    dx: dx0 * frame.width,
    dy: dy0 * frame.height,
    dw: (dx1 - dx0) * frame.width,
    dh: (dy1 - dy0) * frame.height,
  };
}

/** Whether a normalised sample coordinate falls on the source at all, rather than on a bar. */
export function sampleIsInside(u: number, v: number): boolean {
  return u >= 0 && u <= 1 && v >= 0 && v <= 1;
}
