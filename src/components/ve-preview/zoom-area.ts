import { clampView, type CameraView } from '../../editor/camera';
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from '../../editor/edit-manifest';
import type { FrameBox } from '../../state/clip-framing';

/**
 * The zoom AREA editor's arithmetic: the box drawn over the unzoomed frame while a zoom is being
 * edited, and what each gesture on it does to the zoom's `cx`, `cy` and `scale`.
 *
 * Pure, and framework-free, so the gestures, the box the page draws and the unit tests all read the
 * same numbers. Everything is in 0..1 fractions of the OUTPUT frame, top-left, y down - the space
 * the manifest, the camera and every other piece of preview chrome is in.
 *
 * The area always has the output's own shape: at scale `s` it is `1/s` of the frame's width AND
 * `1/s` of its height, so in fractions it is a square even on a 9:16 post. That is the whole reason
 * the zoom stores a centre and a scale rather than a rectangle - a rectangle could be given a shape
 * the output cannot show, and a centre and a scale cannot. The box is then only a way of drawing
 * `(cx, cy, scale)`, and every gesture below goes box -> view -> [clampView], so the one rule that
 * keeps the area inside the frame (the parser's own) is applied in one place.
 */

/** The four corners a finger can resize the area by. */
export type ZoomCorner = 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';

export const ZOOM_CORNERS: readonly ZoomCorner[] = ['topLeft', 'topRight', 'bottomLeft', 'bottomRight'];

/**
 * How far from a corner, in screen pixels, a finger still takes that corner rather than the body -
 * capped at a third of the box's side (see [zoomCornerAt]) so a small box keeps a middle to drag.
 * A little wider than the crop window's edge band, because a corner is a smaller target than an edge.
 */
export const ZOOM_CORNER_GRAB_PX = 28;

/** The part of a zoom the area editor changes. */
export interface ZoomAreaView {
  cx: number;
  cy: number;
  scale: number;
}

/**
 * A view made legal for a ZOOM, which is narrower than a camera: `scale` to
 * [MIN_ZOOM_SCALE]..[MAX_ZOOM_SCALE] (the camera itself allows 1..8), then the centre held so the
 * area stays inside the frame, by [clampView]. The store clamps again on the way in; clamping here
 * too is what keeps the box under the finger from drawing somewhere the store will not put it.
 */
export function clampZoomView(view: ZoomAreaView): ZoomAreaView {
  const scale = Number.isFinite(view.scale) ? Math.min(MAX_ZOOM_SCALE, Math.max(MIN_ZOOM_SCALE, view.scale)) : MIN_ZOOM_SCALE;
  const held: CameraView = clampView({ scale, cx: view.cx, cy: view.cy });
  return { cx: held.cx, cy: held.cy, scale: held.scale };
}

/** The area a view shows, as a box on the unzoomed frame: `1/scale` wide and high, centred on (cx, cy). */
export function zoomArea(view: ZoomAreaView): FrameBox {
  const side = 1 / view.scale;
  return { x: view.cx - side / 2, y: view.cy - side / 2, w: side, h: side };
}

/**
 * A drag of the box's body by (`dx`, `dy`) frame fractions from where it started: the area follows
 * the finger, and stops at the frame's edge rather than leaving it. Measured from the START of the
 * drag every frame, so a long drag cannot accumulate rounding.
 */
export function moveZoomArea(view0: ZoomAreaView, dx: number, dy: number): ZoomAreaView {
  return clampZoomView({ cx: view0.cx + dx, cy: view0.cy + dy, scale: view0.scale });
}

/**
 * A pinch: the fingers spread by `factor` (1 = unmoved) since they landed.
 *
 * Direct manipulation of the BOX: spreading makes the box bigger - which is LESS zoom - and pinching
 * in makes it smaller and the zoom stronger, the way the box itself would behave if it were a thing
 * on the glass. The centre stays where it was unless the bigger box would leave the frame, in which
 * case it is pushed back in.
 */
export function pinchZoomArea(view0: ZoomAreaView, factor: number): ZoomAreaView {
  if (!(factor > 0) || !Number.isFinite(factor)) return clampZoomView(view0);
  return clampZoomView({ cx: view0.cx, cy: view0.cy, scale: view0.scale / factor });
}

/**
 * A corner dragged by (`dx`, `dy`) frame fractions, with the OPPOSITE corner held still - the way
 * every resize box behaves, and the one-finger path to the zoom level that a test driver which
 * cannot pinch (Maestro) can take.
 *
 * The area has to keep its shape, so the corner cannot simply follow the finger: the side is the
 * mean of how far the finger went along each axis, outward counting as growth. It is held between
 * the smallest box ([MAX_ZOOM_SCALE]) and the smaller of the largest box ([MIN_ZOOM_SCALE]) and the
 * room the frame leaves beyond the anchor, so the anchor genuinely never moves.
 */
export function resizeZoomArea(view0: ZoomAreaView, corner: ZoomCorner, dx: number, dy: number): ZoomAreaView {
  const a = zoomArea(view0);
  const sx = corner === 'topRight' || corner === 'bottomRight' ? 1 : -1;
  const sy = corner === 'bottomLeft' || corner === 'bottomRight' ? 1 : -1;
  // The anchor is the corner opposite the one being dragged.
  const ax = sx > 0 ? a.x : a.x + a.w;
  const ay = sy > 0 ? a.y : a.y + a.h;
  const room = Math.min(sx > 0 ? 1 - ax : ax, sy > 0 ? 1 - ay : ay);
  const largest = Math.min(1 / MIN_ZOOM_SCALE, room);
  const smallest = Math.min(1 / MAX_ZOOM_SCALE, largest);
  const wanted = a.w + (sx * dx + sy * dy) / 2;
  const side = Math.min(largest, Math.max(smallest, wanted));
  const x = sx > 0 ? ax : ax - side;
  const y = sy > 0 ? ay : ay - side;
  return clampZoomView({ cx: x + side / 2, cy: y + side / 2, scale: 1 / side });
}

/**
 * Which corner of the area a point is on, or null for anywhere else.
 *
 * `x`, `y` are in the frame's own PIXELS and `width`, `height` are the frame's pixel size, because a
 * finger's reach is a pixel distance: a band of [ZOOM_CORNER_GRAB_PX] around each corner, inside or
 * out, capped at a third of the box's shorter side on screen so the four bands never meet and a
 * small box - about 50 px at 4x on the smallest stage - still has a body to drag.
 */
export function zoomCornerAt(view: ZoomAreaView, x: number, y: number, width: number, height: number): ZoomCorner | null {
  if (!(width > 0) || !(height > 0)) return null;
  const a = zoomArea(view);
  const left = a.x * width;
  const top = a.y * height;
  const right = (a.x + a.w) * width;
  const bottom = (a.y + a.h) * height;
  const band = Math.min(ZOOM_CORNER_GRAB_PX, Math.min(right - left, bottom - top) / 3);
  const nearLeft = Math.abs(x - left) <= band;
  const nearRight = Math.abs(x - right) <= band;
  const nearTop = Math.abs(y - top) <= band;
  const nearBottom = Math.abs(y - bottom) <= band;
  if (nearTop && nearLeft) return 'topLeft';
  if (nearTop && nearRight) return 'topRight';
  if (nearBottom && nearLeft) return 'bottomLeft';
  if (nearBottom && nearRight) return 'bottomRight';
  return null;
}

/**
 * The level the box's pill shows: one decimal and a plain `x`, `2.0x` - plain ASCII so a test driver
 * can type the text it is looking for.
 */
export function zoomLevelLabel(scale: number): string {
  return `${(Math.round(scale * 10) / 10).toFixed(1)}x`;
}

/** The cursor a mouse over a corner is shown; the body is `move`. */
export const ZOOM_CORNER_CURSORS: Readonly<Record<ZoomCorner, string>> = {
  topLeft: 'nwse-resize',
  bottomRight: 'nwse-resize',
  topRight: 'nesw-resize',
  bottomLeft: 'nesw-resize',
};
