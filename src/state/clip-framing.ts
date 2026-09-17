import { DEFAULT_OUTPUT, clamp, type EditFit, type EditRect } from '../editor';

/**
 * Where a cropped clip lands on the frame, in the editor's own coordinates.
 *
 * This is the preview's half of the render contract. The native engines take a clip's `crop` (the
 * part of the ORIENTED source to keep) and its `rect` (where that picture is drawn on the output
 * frame) and apply them in that order, fitting the cropped picture inside the rectangle; the same
 * arithmetic has to happen here or the customer is cropping blind. Everything below is in
 * FRACTIONS of the frame - 0..1, top-left origin, y down - so nothing here needs to know how big
 * the preview happens to be on screen, which is the same reason the manifest stores fractions.
 *
 * Absence is carried through rather than defaulted away: a clip with no crop and no rect goes
 * through [pictureBox] and comes out as the whole frame, which is exactly where today's code puts
 * it, and every caller keeps the fields missing on the way back into the manifest.
 */

/** The whole of something: no crop is a crop of all of it, and no rect is the whole frame. */
export const WHOLE_RECT: EditRect = { x: 0, y: 0, w: 1, h: 1 };

/**
 * How far in the fingers may zoom, as a fraction of the source frame. A tenth of a 1080p phone
 * video is 108px across blown up to the full width of the output, which is already softer than
 * anyone wants; below that the customer is only magnifying the encoder's mistakes.
 */
export const MIN_CROP = 0.1;

/**
 * The smallest a clip's rectangle on the frame may be pinched to. Not a degeneracy floor - the
 * manifest has one of those - but a usability one: a clip smaller than this cannot be grabbed
 * again without a fingertip covering all of it.
 */
export const MIN_CLIP_RECT = 0.12;

/** The output frame's shape, which is what `contain` and `cover` letterbox against. */
const FRAME_W = DEFAULT_OUTPUT.width;
const FRAME_H = DEFAULT_OUTPUT.height;

/**
 * The frame's own width / height. A box given in fractions of the frame is square in FRACTIONS long
 * before it is square on screen, so anything measuring a shape has to put this back in.
 */
export const FRAME_ASPECT = FRAME_W / FRAME_H;

/** A box on the frame, in fractions of it. The same four numbers an [EditRect] holds. */
export interface FrameBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A rectangle, or the whole of whatever it would have been a part of. */
export function orWhole(rect: EditRect | null | undefined): EditRect {
  return rect ?? WHOLE_RECT;
}

/**
 * Where the clip's PICTURE ends up on the frame: the source cropped to `crop`, then fitted into
 * `rect` the way `fit` says. `contain` leaves the frame's black showing around it, `cover` fills
 * the rectangle and lets the frame clip what hangs over.
 *
 * `sourceAspect` is the oriented source's width / height. Zero (the metadata has not arrived yet)
 * gives back the rectangle itself, which is where the picture will be within a frame or two and is
 * exactly what the preview showed before any of this existed.
 */
export function pictureBox(
  sourceAspect: number,
  crop: EditRect | null | undefined,
  rect: EditRect | null | undefined,
  fit: EditFit,
): FrameBox {
  const dest = orWhole(rect);
  if (!(sourceAspect > 0)) return { ...dest };
  const kept = orWhole(crop);
  // The cropped picture's shape. A crop that is wider than it is tall, as a fraction of the source,
  // makes the picture wider than the source was.
  const aspect = sourceAspect * (kept.w / kept.h);
  const destW = dest.w * FRAME_W;
  const destH = dest.h * FRAME_H;
  const w = fit === 'cover' ? Math.max(destW, destH * aspect) : Math.min(destW, destH * aspect);
  const h = w / aspect;
  return {
    x: dest.x + (destW - w) / 2 / FRAME_W,
    y: dest.y + (destH - h) / 2 / FRAME_H,
    w: w / FRAME_W,
    h: h / FRAME_H,
  };
}

/**
 * Where the WHOLE source frame would land if none of it were cropped away, at the scale the crop
 * put it at. That box is what the preview gives the `<video>` element: the element draws all of
 * the source, the frame clips it, and what is left inside the picture box is precisely the crop.
 * It is also the ruler a pan is measured with - a finger that moves a tenth of this box's width
 * has moved the crop a tenth of the way across the source.
 */
export function sourceFrameBox(picture: FrameBox, crop: EditRect | null | undefined): FrameBox {
  const kept = orWhole(crop);
  const w = picture.w / kept.w;
  const h = picture.h / kept.h;
  return { x: picture.x - kept.x * w, y: picture.y - kept.y * h, w, h };
}

/** A rectangle of the size given, centred where it is asked for and held inside the frame. */
export function placeRect(cx: number, cy: number, w: number, h: number): EditRect {
  const width = clamp(w, 0, 1);
  const height = clamp(h, 0, 1);
  return {
    x: round4(clamp(cx - width / 2, 0, 1 - width)),
    y: round4(clamp(cy - height / 2, 0, 1 - height)),
    w: round4(width),
    h: round4(height),
  };
}

/** The same rectangle somewhere else, held inside the frame - a pan, with its size untouched. */
export function slideRect(rect: EditRect, x: number, y: number): EditRect {
  return placeRect(x + rect.w / 2, y + rect.h / 2, rect.w, rect.h);
}

/**
 * A rectangle zoomed about its own centre. The factor is squeezed first rather than the result
 * clamped afterwards, so a pinch that would take one edge past the frame stops the whole rectangle
 * at that point instead of quietly changing its shape - the shape is the customer's aspect choice
 * and a pinch must never overwrite it.
 */
export function scaleRect(rect: EditRect, factor: number, min: number): EditRect {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const grow = Math.min(1 / rect.w, 1 / rect.h);
  const shrink = Math.max(min / rect.w, min / rect.h);
  const k = clamp(factor, Math.min(shrink, grow), grow);
  return placeRect(cx, cy, rect.w * k, rect.h * k);
}

/**
 * The largest crop of the source that gives a picture of `pictureAspect` (width / height of the
 * finished picture, not of the crop - a 1:1 crop of a landscape video is a tall, narrow slice of
 * it). Null asks for the source's own shape, which is the whole frame.
 *
 * Centred where the current crop is rather than in the middle of the source, so switching between
 * ratios keeps the part of the shot the customer has already chosen.
 */
export function cropForAspect(
  sourceAspect: number,
  pictureAspect: number | null,
  current: EditRect | null | undefined,
): EditRect {
  const now = orWhole(current);
  const cx = now.x + now.w / 2;
  const cy = now.y + now.h / 2;
  if (!pictureAspect || !(sourceAspect > 0)) return placeRect(cx, cy, 1, 1);
  const ratio = pictureAspect / sourceAspect;
  return ratio >= 1 ? placeRect(cx, cy, 1, 1 / ratio) : placeRect(cx, cy, ratio, 1);
}

/** One of the ratios the crop sheet offers. `aspect` is the finished picture's width / height. */
export interface CropPreset {
  id: string;
  label: string;
  /** Null is "the source's own shape", which crops nothing away for the sake of a ratio. */
  aspect: number | null;
}

export const CROP_PRESETS: readonly CropPreset[] = [
  { id: 'free', label: 'Free', aspect: null },
  { id: '1:1', label: '1:1', aspect: 1 },
  { id: '4:5', label: '4:5', aspect: 4 / 5 },
  { id: '9:16', label: '9:16', aspect: 9 / 16 },
  { id: '16:9', label: '16:9', aspect: 16 / 9 },
];

/**
 * Which preset the crop is on now, or null for a shape none of them names - which a pinch cannot
 * produce (it keeps the shape) but an older manifest or a future tool could.
 */
export function presetFor(sourceAspect: number, crop: EditRect | null | undefined): string | null {
  if (!(sourceAspect > 0)) return null;
  const kept = orWhole(crop);
  const aspect = sourceAspect * (kept.w / kept.h);
  for (const preset of CROP_PRESETS) {
    const want = preset.aspect ?? sourceAspect;
    // Relative, because 16:9 and 9:16 are as far apart in absolute terms as two ratios ever get
    // here while 4:5 and 1:1 are a fifth of a unit apart, and one tolerance has to serve both.
    if (Math.abs(aspect - want) <= want * 0.01) return preset.id;
  }
  return null;
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
