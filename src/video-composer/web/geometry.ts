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
export function sourceWindow(clip: Framing, frame: Frame, inputWidth: number, inputHeight: number): ComposeRect {
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
 * that may be drawn, and where on the frame it lands. Everything the window asks for outside that
 * is a letterbox bar, and a bar is simply a piece of the frame nothing is drawn on - which is why
 * the caller clears to black first and this returns null for a window that misses it altogether.
 *
 * `kept` is the part of the source the clip's CROP keeps, and the whole frame for a clip that has
 * no crop. It is the bound rather than the source's own edges, and that distinction is the whole
 * reason this takes an argument at all: a window is worked out so that the KEPT picture lands on
 * the destination rectangle, but it goes on mapping past that rectangle in both directions, and
 * what lies immediately outside is the part of the source the customer just cropped away. Bounded
 * only by the source, a clip cropped to half its height drew the other half into its own letterbox
 * bars - on the frame, in the preview, and in the finished file.
 */
export function drawRects(
  window: ComposeRect,
  frame: Frame,
  inputWidth: number,
  inputHeight: number,
  kept: ComposeRect = FULL_FRAME,
): { sx: number; sy: number; sw: number; sh: number; dx: number; dy: number; dw: number; dh: number } | null {
  // The window in source fractions, clipped to the part of the source that may be drawn.
  const x0 = Math.max(kept.x, window.x);
  const y0 = Math.max(kept.y, window.y);
  const x1 = Math.min(kept.x + kept.w, window.x + window.w);
  const y1 = Math.min(kept.y + kept.h, window.y + window.h);
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

/**
 * Whether a normalised sample coordinate falls on the part of the source that may be drawn, rather
 * than on a bar. `kept` is the clip's crop, and the whole frame for a clip that has none; see
 * [drawRects] for why the source's own edges are not the bound.
 */
export function sampleIsInside(u: number, v: number, kept: ComposeRect = FULL_FRAME): boolean {
  return u >= kept.x && u <= kept.x + kept.w && v >= kept.y && v <= kept.y + kept.h;
}

/**
 * Where a LAYER's picture actually lands inside the rectangle it was given, in fractions of the
 * output frame - the rectangle itself when the picture fills it, and the picture's own shape
 * centred in it when it does not.
 *
 * This is what stops an extra layer from carrying black bars over the picture beneath it. A layer
 * is drawn into its own destination and the destination is blacked before the picture goes on
 * (see `Painter.paintLayers2d`, and the shader's alpha outside `u_kept`), which is right for the
 * base track - its bars ARE the post's background, and there is nothing under them - and wrong for
 * every layer above it, where the bars are opaque black over somebody else's video.
 *
 * The painter says it blacks them "exactly as they do natively". That is not true, and it is worth
 * writing down because it is the reason this function exists rather than a transparent bar. Media3
 * gives a layer a `Presentation` the size of its rectangle and letterboxes inside it, but the
 * padding is TRANSPARENT: `BaseGlShaderProgram` clears through `GlUtil.clearFocusedBuffers`, which
 * is `(0, 0, 0, 0)` - there is a `clearFocusedBuffersOpaque` for opaque black and Media3 does not
 * call it here - and `LayerCompositor` then blends that texture over the base. So a letterboxed
 * layer has ALWAYS shown the base through its bars on Android. The web was the odd one out.
 *
 * Rather than give the web a transparent bar of its own, take the bars away: `contain` into a
 * destination that already IS the picture's shape draws all of it, exactly, edge to edge, and there
 * is no bar left to be any colour. The picture on screen is identical - `contain` centres it in the
 * rectangle either way - and what changes is only how much of the output the layer claims as its
 * own. That lands the web on the same picture the native engines were already producing.
 *
 * `cover` is handed back unchanged: it fills its rectangle by definition and what hangs over is
 * clipped, so a cover layer has no bars to begin with.
 *
 * `frameAspect` is the output's width / height. Everything here is a ratio, so the frame needs no
 * pixel count - a frame of `frameAspect` by 1 gives the same answer as one of 720 by 1280.
 */
export function pictureDest(dest: ComposeRect, clip: Framing, frameAspect: number, inputWidth: number, inputHeight: number): ComposeRect {
  if (clip.fit === 'cover') return dest;
  if (!(inputWidth > 0) || !(inputHeight > 0) || !(frameAspect > 0)) return dest;
  const crop = clip.crop ?? FULL_FRAME;
  // The CROPPED picture's shape, which is not the source's: a crop that keeps a tall slice of a
  // landscape video makes a tall picture, and it is the picture that has to fit.
  const picW = Math.max(1, crop.w * inputWidth);
  const picH = Math.max(1, crop.h * inputHeight);
  const aspect = picW / picH;
  // The rectangle in frame units - width in units of the frame's height, so a ratio taken against
  // the picture's is a ratio of two shapes and not of two different frames.
  const boxW = dest.w * frameAspect;
  const boxH = dest.h;
  if (!(boxW > 0) || !(boxH > 0)) return dest;
  const w = Math.min(boxW, boxH * aspect);
  const h = w / aspect;
  return {
    x: dest.x + (boxW - w) / 2 / frameAspect,
    y: dest.y + (boxH - h) / 2,
    w: w / frameAspect,
    h,
  };
}
