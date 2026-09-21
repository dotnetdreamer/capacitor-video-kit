import type { Signal } from '@preact/signals-core';

import {
  MAX_SCALE,
  MIN_SCALE,
  clamp,
  findClip,
  isOverlayVisibleAt,
  type ClipFramingPatch,
  type EditOverlay,
  type EditPlacement,
  type EditRect,
} from '../../editor';
import {
  MIN_CLIP_RECT,
  MIN_CROP,
  cropStageBox,
  cropWindowBox,
  orWhole,
  pictureBox,
  placeClipRect,
  resizeCrop,
  scaleClipRect,
  scaleRect,
  slideRect,
  sourceFrameBox,
  type CropSide,
  type FrameBox,
} from '../../state/clip-framing';
import type { EditorStore } from '../../state/editor-store';
import type { OverlayBitmap } from '../../state/editor.types';

/** Further than this and a press is a drag, not a tap. */
const TAP_SLOP_PX = 8;
/** Longer than this and a press is not a tap either. */
const TAP_MS = 300;
/** A layer's centre snaps to the frame's centre line within this distance. */
const SNAP_PX = 6;
/** A rotation snaps to a quarter turn within this many degrees. */
const SNAP_DEG = 4;
/** A layer smaller than a fingertip is still grabbed by one: its hit box never shrinks below this. */
const MIN_HIT_PX = 44;
/** How far outside the layer's corner a handle's centre sits - `.pv__handle--*`'s offset plus half itself. */
const HANDLE_INSET_PX = 4;
/** Half of the circle a handle DRAWS (`.pv__handle` is 24px), as opposed to the finger target around it. */
const HANDLE_CIRCLE_PX = 12;
/**
 * How close to the edge of the area a handle may be drawn in its centre may sit: half of its 44px
 * finger target, so the whole target stays inside. That area is the preview's own box, not the
 * frame's - the chrome of a layer at the frame's edge is meant to hang over the black beside it -
 * but everything below the preview belongs to the shell's transport row, which paints after us and
 * therefore WINS any touch the chrome bleeds onto. A sticker dragged to the bottom of the frame put
 * its corner handle on the Play button; at full size it put it on Redo.
 */
const HANDLE_EDGE_PX = 22;

/**
 * How close to an edge of the crop window a finger has to land to take hold of THAT EDGE rather
 * than the picture behind it.
 *
 * A fingertip, near enough, and it has to be: the band is the whole target, there is no drawn
 * handle bigger than it, and a customer aiming at the edge of a small window must not pan the
 * picture instead. Anything landing outside every band pans, which is what the whole window did
 * before the edges could be taken hold of at all.
 */
const CROP_EDGE_GRAB_PX = 24;

/** Where the selection chrome may be drawn, in frame pixels - so negative left/top, past the frame. */
export interface ChromeBounds {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Mirrors `.pv__trash` in the stylesheet: its size and its distance from the frame's bottom edge. */
export const TRASH_SIZE_PX = 48;
export const TRASH_BOTTOM_PX = 20;
/** Generous on purpose: letting go of a layer "near" the bin should throw it away. */
const TRASH_HIT_RADIUS_PX = 40;

/** What the preview draws while a layer is being moved or turned. */
export interface SnapGuides {
  /** The vertical centre line: the layer is centred left to right. */
  x: boolean;
  /** The horizontal centre line. */
  y: boolean;
  /** A line through the layer's centre along its snapped angle. */
  rotation: { cx: number; cy: number; deg: number } | null;
}

export const NO_GUIDES: SnapGuides = { x: false, y: false, rotation: null };

/** The gesture's feedback, owned by the component so its template can read it. */
export interface GestureUi {
  /** A LAYER is being dragged, which is what puts the bin on screen. */
  dragging: Signal<boolean>;
  /** Anything is being dragged, a clip included, which is what takes the selection chrome off. */
  moving: Signal<boolean>;
  trashHot: Signal<boolean>;
  guides: Signal<SnapGuides>;
}

/** A layer's size on the frame, independent of how big the frame happens to be on screen. */
export interface LayerBox {
  /** Width as a fraction of the frame's width. */
  widthFrac: number;
  /** Width / height. */
  aspect: number;
}

/**
 * How big a layer's bitmap is drawn. `wPx` is its width on the OUTPUT frame, so a fraction of the
 * output width is a fraction of the preview frame too. While a pinch runs ahead of the redraw the
 * bitmap is the one drawn at an older scale, and is stretched by the ratio until the sharp one lands.
 */
export function layerBox(overlay: EditOverlay, bitmap: OverlayBitmap, outputWidth: number): LayerBox | null {
  if (!(bitmap.wPx > 0) || !(bitmap.hPx > 0) || !(outputWidth > 0)) return null;
  const drawnAt = bitmap.scale > 0 ? bitmap.scale : overlay.scale;
  return {
    widthFrac: (bitmap.wPx / outputWidth) * (overlay.scale / drawnAt),
    aspect: bitmap.wPx / bitmap.hPx,
  };
}

/** The CSS a layer (and its selection box) is placed with around its centre. */
export function layerTransform(rotationDeg: number): string {
  return `translate(-50%, -50%) rotate(${rotationDeg}deg)`;
}

/**
 * Anything on the frame the fingers can take hold of: a layer, or the video of the selected clip.
 *
 * The gestures below were written for layers and are kept generic over this instead of being
 * copied for clips, because a clip wants the same TikTok behaviour to the pixel - the same tap
 * slop, the same drag threshold, the same two-finger pinch anywhere on the frame, the same snap to
 * the centre lines. What differs is only where the box comes from and where the patch goes, and
 * that is what `kind` decides: a layer's box is its bitmap and its patch is `cx`/`cy`/`scale`, a
 * clip's box is its `rect` on the frame (or the whole frame, when it has none) and its patch is a
 * rectangle. Everything between the finger and those two points is shared.
 */
export interface Transformable {
  id: string;
  kind: 'overlay' | 'clip';
  /** Its centre on the frame, 0..1, top-left origin. */
  cx: number;
  cy: number;
  /** Its box: width as a fraction of the frame's, and its width / height as drawn. */
  widthFrac: number;
  aspect: number;
  /** Clockwise, as CSS means it, for a layer and for a clip alike. */
  rotationDeg: number;
  /** A second tap opens it for typing. Only a text layer does. */
  isText: boolean;
}

/** The part of a [Transformable] the hit tests and the handles measure. */
function boxOf(target: Transformable): LayerBox {
  return { widthFrac: target.widthFrac, aspect: target.aspect };
}

/** The selection box's three corner buttons, as `data-handle` names them in the template. */
export type SelectionHandle = 'delete' | 'edit' | 'transform';

/**
 * Whether a point on the frame (pixels from its top-left) falls on a layer's rotated box. The point
 * is turned back by the layer's rotation so the test is a plain rectangle.
 */
export function hitsLayer(
  px: number,
  py: number,
  frameWidth: number,
  frameHeight: number,
  overlay: Pick<EditOverlay, 'cx' | 'cy' | 'rotationDeg'>,
  box: LayerBox,
): boolean {
  return withinHitBox(toLayerSpace(px, py, frameWidth, frameHeight, overlay), box, frameWidth);
}

/** Where a handle is drawn, and how far that is from the corner it belongs to. */
export interface HandleSpot {
  /** Its centre on the frame, in pixels from the frame's top-left. */
  x: number;
  y: number;
  /** The same displacement in the LAYER's own turned frame, which is where the template applies it. */
  shiftX: number;
  shiftY: number;
}

/**
 * Where a handle actually sits. Its home is 4px outside its corner of the layer's box, turned with
 * the layer - but a corner past the area the chrome may use would put the handle over the shell's
 * controls (see [HANDLE_EDGE_PX]), so the centre is held inside `bounds` and the handle slides in
 * along with it. `shiftX`/`shiftY` are how far it moved, measured in the layer's own turned frame,
 * because that is the space the handle's CSS transform lives in.
 */
export function handleSpot(
  handle: SelectionHandle,
  overlay: Pick<EditOverlay, 'cx' | 'cy' | 'rotationDeg'>,
  box: LayerBox,
  frameWidth: number,
  frameHeight: number,
  bounds: ChromeBounds = { left: 0, top: 0, right: frameWidth, bottom: frameHeight },
): HandleSpot {
  const width = box.widthFrac * frameWidth;
  const height = width / box.aspect;
  // The handles turn with the layer, so their homes are constants in the layer's own frame.
  const local = {
    x: (handle === 'delete' ? -1 : 1) * (width / 2 + HANDLE_INSET_PX),
    y: (handle === 'transform' ? 1 : -1) * (height / 2 + HANDLE_INSET_PX),
  };
  const rad = (overlay.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const home = {
    x: overlay.cx * frameWidth + local.x * cos - local.y * sin,
    y: overlay.cy * frameHeight + local.x * sin + local.y * cos,
  };
  // Sideways only the drawn circle has to stay inside: what it is being kept out of is the black
  // beside the video, which is empty for a good 35px before the shell's circles start, so a finger
  // target hanging a little way into it still finds the handle. Up and down the shell's own rows
  // begin at once, and the whole target has to be clear of them.
  const held = {
    x: clampInside(home.x, bounds.left, bounds.right, HANDLE_CIRCLE_PX),
    y: clampInside(home.y, bounds.top, bounds.bottom, HANDLE_EDGE_PX),
  };
  const dx = held.x - home.x;
  const dy = held.y - home.y;
  return { x: held.x, y: held.y, shiftX: dx * cos + dy * sin, shiftY: -dx * sin + dy * cos };
}

/**
 * Whether a press that landed on a handle's button really belongs to the LAYER under it. A handle
 * draws a 24px circle but takes a 44px finger target around it, and on a small layer that target
 * covers the artwork itself - so a tap meant to pick up a 40px sticker deleted it, and a drag from
 * its middle resized it. A point inside the layer's hit box is the layer's; only the circle a handle
 * actually draws, which on a small layer does reach over the artwork, wins it back - and it is that
 * DRAWN circle wherever it ended up, so a handle held inside the stage takes its claim with it.
 */
export function pressBelongsToLayer(
  px: number,
  py: number,
  frameWidth: number,
  frameHeight: number,
  overlay: Pick<EditOverlay, 'cx' | 'cy' | 'rotationDeg'>,
  box: LayerBox,
  handle: SelectionHandle,
  bounds?: ChromeBounds,
): boolean {
  const spot = handleSpot(handle, overlay, box, frameWidth, frameHeight, bounds);
  if (distance({ x: px, y: py }, spot) <= HANDLE_CIRCLE_PX) return false;
  return withinHitBox(toLayerSpace(px, py, frameWidth, frameHeight, overlay), box, frameWidth);
}

/** An area too narrow to hold the handle (it never is on a phone) leaves only its middle. */
function clampInside(value: number, low: number, high: number, pad: number): number {
  const min = low + pad;
  const max = high - pad;
  return min >= max ? (low + high) / 2 : clamp(value, min, max);
}

export function snapToCentre(value: number, sizePx: number): { value: number; snapped: boolean } {
  return Math.abs(value - 0.5) * sizePx <= SNAP_PX ? { value: 0.5, snapped: true } : { value, snapped: false };
}

export function snapRotation(deg: number): { value: number; snapped: boolean } {
  const quarter = Math.round(deg / 90) * 90;
  return Math.abs(deg - quarter) <= SNAP_DEG ? { value: quarter, snapped: true } : { value: deg, snapped: false };
}

/** The shortest turn from `from` to `to`, in degrees, so a twist across +-180 does not flip. */
export function angleDelta(to: number, from: number): number {
  let delta = (to - from) % 360;
  if (delta > 180) delta -= 360;
  if (delta <= -180) delta += 360;
  return delta;
}

type TransformPatch = Partial<Record<'cx' | 'cy' | 'scale' | 'rotationDeg', number>>;

/** A change waiting for the next frame, and who it belongs to. */
type Pending =
  | { kind: 'overlay'; id: string; patch: TransformPatch }
  | { kind: 'clip'; id: string; patch: ClipFramingPatch };

/**
 * What a clip gesture is doing. `rect` moves and sizes the video's rectangle ON the frame; `crop`
 * leaves the rectangle alone and moves the source UNDER it, which is what the crop sheet is for.
 * Which one is running is decided by whether that sheet is open, so one set of fingers never has
 * to mean two things at once.
 */
type ClipMode = 'rect' | 'crop';

/**
 * A clip held by the fingers, measured once when they land.
 *
 * The rectangle and the crop are snapshots for the same reason the overlay drag keeps `cx0`/`cy0`:
 * every frame of the gesture is computed from where it STARTED plus how far the fingers have come,
 * so a rounding error cannot accumulate across a long drag. `source` is where the whole source
 * frame sat at that moment, which is the ruler a crop pan is measured against - and it stays true
 * for the length of the pan because a pan does not change the crop's size.
 */
interface ClipGrip {
  id: string;
  mode: ClipMode;
  rect0: EditPlacement;
  crop0: EditRect;
  /** The angle the fingers landed on, so a twist adds to it rather than starting from upright. */
  rot0: number;
  source: FrameBox;
  /**
   * Which edge or corner of the crop window the fingers landed on, or null for the picture itself.
   *
   * Set only while the crop sheet is open, and it is what separates the tool's two gestures: a
   * finger on the window's edge CROPS that side, a finger anywhere else PANS the source under the
   * window. Read once as the fingers land, like everything else here, so a drag cannot wander from
   * one to the other halfway through.
   */
  side: CropSide | null;
}

interface Point {
  x: number;
  y: number;
}

type Gesture =
  /** A finger down on empty frame: a tap toggles play or clears the selection. */
  | { kind: 'tap-empty'; x0: number; y0: number; t0: number }
  /**
   * A finger down on a layer that has not moved yet: a tap, or the start of a drag. `pointerId` is
   * the finger that owns it - a second finger that cannot pinch (an effect layer, a layer that has
   * left the screen) must not move the layer, nor end the gesture by lifting.
   */
  | {
      kind: 'press';
      pointerId: number;
      id: string;
      /** What lifting the finger without moving it means; see [onUp]. */
      tap: 'text' | 'empty' | 'none';
      x0: number;
      y0: number;
      t0: number;
      cx0: number;
      cy0: number;
      /** Set for a clip, null for a layer. */
      grip: ClipGrip | null;
    }
  | {
      kind: 'drag';
      pointerId: number;
      id: string;
      x0: number;
      y0: number;
      cx0: number;
      cy0: number;
      grip: ClipGrip | null;
    }
  /** Scale and rotation, from two fingers or from the corner handle's one. */
  | {
      kind: 'twist';
      source: 'pinch' | 'handle';
      id: string;
      /** Set for a clip, null for a layer. A clip is zoomed but never turned. */
      grip: ClipGrip | null;
      scale0: number;
      rot0: number;
      dist0: number;
      lastAngle: number;
      turned: number;
      /** Set once the fingers have turned the layer on purpose, beyond the snap distance. */
      twisted: boolean;
      centre: Point;
    }
  /** Finished (or given up on) while fingers are still down; waits for them all to lift. */
  | { kind: 'spent' };

/**
 * Moving, scaling and turning layers with the fingers, the way TikTok's preview does: press a layer
 * and drag it (with a bin to drop it in), pinch and twist anywhere on the frame for the selected
 * one, or use its corner handle one-handed.
 *
 * Every continuous gesture is ONE undo step: `beginGesture` when it starts, `previewOverlay` as it
 * moves, `endGesture` when it lifts. Pointer events fire faster than the screen refreshes, so the
 * manifest is written at most once a frame. Everything the listeners change is a signal, so a frame
 * of a drag repaints the pieces of the screen that read it and nothing else.
 */
export class OverlayGestures {
  private readonly pointers = new Map<number, Point>();
  /**
   * A lone finger resting on the delete or edit handle. It is left to the button - lifted, it is a
   * tap and the button's click does the work - but it is remembered, because a second finger joining
   * it makes the two a pinch.
   */
  private buttonPointer: { id: number; point: Point } | null = null;
  private gesture: Gesture | null = null;
  private pending: Pending | null = null;
  private frameRequest = 0;
  /** Set when a press on a handle was taken back by the layer under it; see [handleAt]. */
  private swallowClick = false;
  /** The cursor last written to the stage, so a mouse resting still costs no style writes. */
  private cursor = '';
  private destroyed = false;
  private readonly unlisten: Array<() => void> = [];

  /**
   * @param stage the frame's own box, plus the selection chrome that is allowed to draw outside it.
   *   Its rectangle IS the frame's, so a point measured from it is a point on the frame.
   */
  constructor(
    private readonly store: EditorStore,
    private readonly stage: HTMLElement,
    private readonly ui: GestureUi,
  ) {
    /*
     * Each of the four asks the cursor again once the gesture state has moved on, because all four
     * can change what the mouse is over without the mouse itself having moved: pressing takes hold
     * of something, releasing lets go of it, and a layer dropped under a still mouse leaves it over
     * something new. Left to `pointermove` alone the hand stayed closed after the button came up,
     * until the mouse was nudged.
     */
    this.listen('pointerdown', (e) => {
      this.onDown(e as PointerEvent);
      this.updateCursor(e as PointerEvent);
    });
    this.listen('pointermove', (e) => {
      this.onMove(e as PointerEvent);
      this.updateCursor(e as PointerEvent);
    });
    this.listen('pointerup', (e) => {
      this.onUp(e as PointerEvent);
      this.updateCursor(e as PointerEvent);
    });
    this.listen('pointercancel', (e) => {
      this.onUp(e as PointerEvent);
      this.updateCursor(e as PointerEvent);
    });
    // The mouse has left the picture, so whatever it was over is no longer under it.
    this.listen('pointerleave', () => this.setCursor(''));
    // On the way DOWN, so it can be stopped before it reaches the handle's own click handler.
    this.listen('click', (e) => this.onClick(e), true);
    // A long press on the video would otherwise open the WebView's image/video context menu.
    this.listen('contextmenu', (e) => e.preventDefault());
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    for (const off of this.unlisten) off();
    this.setCursor('');
    const gesture = this.gesture;
    if (gesture?.kind === 'drag' || gesture?.kind === 'twist') {
      this.flush();
      this.store.endGesture(gestureLabel(gesture));
    }
    if (this.frameRequest) cancelAnimationFrame(this.frameRequest);
    this.gesture = null;
  }

  /* ========================================================================================= */
  /* Pointer events                                                                            */
  /* ========================================================================================= */

  private onDown(e: PointerEvent): void {
    // While the text sheet is open the preview is only something to look at: a stray touch must not
    // move, select or delete anything behind the keyboard.
    if (this.destroyed || this.store.textEdit.value) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    this.swallowClick = false;
    const handle = this.handleAt(e);
    // The delete and edit handles are buttons, and a tap on one is their own click's business. Only
    // a FIRST finger, though: the handles sit on the layer's corners, right where the fingers go to
    // pinch a small sticker, and a finger that lands on one while another is down (or that another
    // joins, below) is half of a pinch - left out, the other finger dragged the layer instead.
    if ((handle === 'delete' || handle === 'edit') && this.pointers.size === 0) {
      if (e.isPrimary) this.buttonPointer = { id: e.pointerId, point: { x: e.clientX, y: e.clientY } };
      return;
    }

    e.preventDefault();
    // A new first finger while fingers are still on record means an up event went missing (the
    // WebView lost the pointer). Whatever that touch was doing is finished here rather than left open.
    if (e.isPrimary && this.pointers.size > 0) this.abandon();
    try {
      this.stage.setPointerCapture(e.pointerId);
    } catch {
      // A pointer that is already gone cannot be captured; its up event still arrives.
    }
    const resting = this.buttonPointer;
    this.buttonPointer = null;
    if (resting && !e.isPrimary && resting.id !== e.pointerId && this.pointers.size === 0) {
      // A second finger beside one resting on a handle: the pair is a pinch from the start. (A new
      // PRIMARY finger would mean the resting one lifted unseen.) The resting finger's own events
      // keep arriving - a touch stays with the element it went down on, which is inside the stage.
      this.pointers.set(resting.id, resting.point);
      this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
      this.beginPinch();
      return;
    }
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pointers.size === 1) this.beginOne(e, handle === 'transform');
    else if (this.pointers.size === 2) this.beginPinch();
  }

  private onMove(e: PointerEvent): void {
    if (this.buttonPointer?.id === e.pointerId) {
      this.buttonPointer.point = { x: e.clientX, y: e.clientY };
      return;
    }
    const point = this.pointers.get(e.pointerId);
    const gesture = this.gesture;
    if (!point || !gesture) return;
    point.x = e.clientX;
    point.y = e.clientY;

    switch (gesture.kind) {
      case 'tap-empty':
        if (distance(point, { x: gesture.x0, y: gesture.y0 }) > TAP_SLOP_PX) this.gesture = { kind: 'spent' };
        return;
      case 'press': {
        if (gesture.pointerId !== e.pointerId) return;
        if (distance(point, { x: gesture.x0, y: gesture.y0 }) <= TAP_SLOP_PX) return;
        this.store.beginGesture();
        // Both hide their own chrome, which is what `moving` says. Only a LAYER puts the bin on
        // screen: there is none for a clip (see [endDrag]), and a segment is not a thing that can
        // be thrown away by a gesture whose whole point was to move it. A clip's playback stops
        // here rather than on the press, so that a plain tap can still toggle it.
        this.set(this.ui.moving, true);
        if (gesture.grip) this.pausePlayback();
        else this.set(this.ui.dragging, true);
        const drag: Gesture = {
          kind: 'drag',
          pointerId: gesture.pointerId,
          id: gesture.id,
          x0: gesture.x0,
          y0: gesture.y0,
          cx0: gesture.cx0,
          cy0: gesture.cy0,
          grip: gesture.grip,
        };
        this.gesture = drag;
        this.moveDrag(drag, point);
        return;
      }
      case 'drag':
        if (gesture.pointerId !== e.pointerId) return;
        this.moveDrag(gesture, point);
        return;
      case 'twist':
        this.moveTwist(gesture);
        return;
      case 'spent':
        return;
    }
  }

  private onUp(e: PointerEvent): void {
    if (this.buttonPointer?.id === e.pointerId) this.buttonPointer = null;
    if (!this.pointers.delete(e.pointerId)) return;
    const cancelled = e.type === 'pointercancel';
    const gesture = this.gesture;

    switch (gesture?.kind) {
      case 'tap-empty':
        if (!cancelled && performance.now() - gesture.t0 < TAP_MS) this.tapEmpty();
        this.gesture = { kind: 'spent' };
        break;
      case 'press':
        // Another finger lifting leaves the press to the finger that owns it.
        if (gesture.pointerId !== e.pointerId) break;
        if (!cancelled && performance.now() - gesture.t0 < TAP_MS) {
          // The first tap on a layer selects it (done on press); a tap on a text that was already
          // selected opens it for typing, as TikTok does. A tap on the video is a tap on the frame
          // however the clip is framed - the selected clip covering it must not cost the customer
          // the tap that plays and pauses.
          if (gesture.tap === 'text') this.store.startEditText(gesture.id);
          else if (gesture.tap === 'empty') this.tapEmpty();
        }
        this.gesture = { kind: 'spent' };
        break;
      case 'drag':
        if (gesture.pointerId !== e.pointerId) break;
        this.endDrag(gesture, cancelled);
        break;
      case 'twist':
        if (gesture.source === 'handle' || this.pointers.size < 2) this.endTwist();
        break;
      default:
        break;
    }
    if (this.pointers.size === 0) this.gesture = null;
  }

  /* ========================================================================================= */
  /* Starting                                                                                  */
  /* ========================================================================================= */

  private beginOne(e: PointerEvent, onTransformHandle: boolean): void {
    const rect = this.stage.getBoundingClientRect();
    const now = performance.now();

    if (onTransformHandle) {
      const overlay = this.store.selectedOverlay.value;
      // With no layer selected the corner belongs to the CLIP, and drives the same `twist` the two
      // fingers drive - one finger swung about the rectangle's centre instead of two spread across
      // it. Everything downstream is shared: `moveTwist` sends a gesture carrying a grip to
      // `twistClip`, so the corner resizes and turns a video by the arithmetic that already exists.
      const grip = overlay ? null : this.selectedClipGrip();
      const spot = overlay
        ? overlay.kind === 'effect'
          ? null
          : { cx: overlay.cx, cy: overlay.cy }
        : grip
          ? { cx: grip.rect0.x + grip.rect0.w / 2, cy: grip.rect0.y + grip.rect0.h / 2 }
          : null;
      if (spot) {
        const centre = { x: rect.left + spot.cx * rect.width, y: rect.top + spot.cy * rect.height };
        const point = { x: e.clientX, y: e.clientY };
        this.pausePlayback();
        this.store.beginGesture();
        this.gesture = {
          kind: 'twist',
          source: 'handle',
          id: grip ? grip.id : overlay!.id,
          grip,
          scale0: overlay?.scale ?? 1,
          rot0: overlay?.rotationDeg ?? 0,
          dist0: Math.max(1, distance(point, centre)),
          lastAngle: angleOf(centre, point),
          turned: 0,
          twisted: false,
          centre,
        };
        return;
      }
    }

    // The crop sheet owns the frame while it is open: every touch pans or zooms the picture inside
    // its window, and nothing else on the frame can be picked up or selected out from under it.
    const cropping = this.cropGrip({ x: e.clientX - rect.left, y: e.clientY - rect.top }, rect);
    if (cropping) {
      this.gesture = {
        kind: 'press',
        pointerId: e.pointerId,
        id: cropping.id,
        tap: 'none',
        x0: e.clientX,
        y0: e.clientY,
        t0: now,
        cx0: 0,
        cy0: 0,
        grip: cropping,
      };
      return;
    }

    const hit = this.hitTest(e.clientX - rect.left, e.clientY - rect.top, rect);
    if (!hit) {
      this.gesture = { kind: 'tap-empty', x0: e.clientX, y0: e.clientY, t0: now };
      return;
    }

    if (hit.kind === 'clip') {
      const grip = this.clipGrip(hit.id, 'rect');
      if (!grip) {
        this.gesture = { kind: 'tap-empty', x0: e.clientX, y0: e.clientY, t0: now };
        return;
      }
      /*
       * Touching a video selects the segment it belongs to, the way every other editor does - and
       * the only way to reach a picture-in-picture layer without hunting for its row in the
       * timeline. The hit test above already picked the frontmost one under the finger.
       *
       * Selecting is ALL it does. `tap: 'none'` leaves a second touch on a segment that is already
       * selected inert, so a finger resting on the frame in the middle of an edit cannot put the
       * selection down or set the post playing; play and pause belong to the transport's button,
       * which is on screen the whole time. That is also why nothing is paused here - a drag pauses
       * when it becomes a drag, and a tap stays a tap.
       */
      if (!this.store.isSelected({ kind: 'clip', id: hit.id })) this.store.select({ kind: 'clip', id: hit.id });
      this.gesture = {
        kind: 'press',
        pointerId: e.pointerId,
        id: hit.id,
        tap: 'none',
        x0: e.clientX,
        y0: e.clientY,
        t0: now,
        cx0: hit.cx,
        cy0: hit.cy,
        grip,
      };
      return;
    }

    const wasSelected = this.store.isSelected({ kind: 'overlay', id: hit.id });
    if (this.store.playing.value) this.store.pause();
    // Re-selecting the selected layer would close a sheet that is open for it (opacity, say).
    if (!wasSelected) this.store.select({ kind: 'overlay', id: hit.id });
    this.gesture = {
      kind: 'press',
      pointerId: e.pointerId,
      id: hit.id,
      tap: wasSelected && hit.isText ? 'text' : 'none',
      x0: e.clientX,
      y0: e.clientY,
      t0: now,
      cx0: hit.cx,
      cy0: hit.cy,
      grip: null,
    };
  }

  /**
   * A second finger: the selected layer - or, with none selected, the clip the fingers may frame -
   * is pinched and twisted wherever the fingers are. No gesture yet means the first finger was
   * resting on a handle button.
   *
   * The grip is measured HERE rather than carried over from a drag that is already running, because
   * the drag has been moving the thing since it started and the pinch has to scale from where it is
   * now, not from where the finger first landed.
   */
  private beginPinch(): void {
    const gesture = this.gesture;
    if (gesture?.kind === 'twist' || gesture?.kind === 'spent') return;
    // A drag in progress lands its last position first; the pinch continues the same undo step.
    if (gesture?.kind === 'drag') this.flush();

    const pair = this.firstTwo();
    // The crop sheet's zoom comes first: while it is open the fingers are always the crop's, even
    // if a layer happens to be selected behind it.
    const grip = this.cropGrip() ?? (this.store.selectedOverlay.value ? null : this.selectedClipGrip());
    const overlay = grip ? null : this.store.selectedOverlay.value;
    const pinchable = grip ? true : !!overlay && overlay.kind !== 'effect' && this.isShown(overlay);
    if (!pair || !pinchable) {
      // Nothing to pinch. A drag carries on with its finger; anything else is no longer a tap.
      if (gesture?.kind !== 'drag') this.gesture = { kind: 'spent' };
      return;
    }

    if (gesture?.kind === 'drag') {
      this.set(this.ui.dragging, false);
      this.set(this.ui.moving, false);
      this.set(this.ui.trashHot, false);
      this.setGuides(NO_GUIDES);
    } else {
      this.store.beginGesture();
      this.pausePlayback();
    }
    const [a, b] = pair;
    this.gesture = {
      kind: 'twist',
      source: 'pinch',
      id: grip ? grip.id : overlay!.id,
      grip,
      scale0: overlay?.scale ?? 1,
      rot0: overlay?.rotationDeg ?? 0,
      dist0: Math.max(1, distance(a, b)),
      lastAngle: angleOf(a, b),
      turned: 0,
      twisted: false,
      centre: { x: 0, y: 0 },
    };
  }

  /* ========================================================================================= */
  /* Moving                                                                                    */
  /* ========================================================================================= */

  private moveDrag(gesture: Extract<Gesture, { kind: 'drag' }>, point: Point): void {
    // Read again rather than kept from the press: selecting the layer closes whatever sheet was open,
    // which resizes the stage under the finger. A rect from before that put the layer - and the bin
    // the drag aims at - on the frame as it used to be.
    const rect = this.stage.getBoundingClientRect();
    if (gesture.grip) {
      this.moveClipDrag(gesture.grip, gesture, point, rect);
      return;
    }
    const x = snapToCentre(gesture.cx0 + (point.x - gesture.x0) / rect.width, rect.width);
    const y = snapToCentre(gesture.cy0 + (point.y - gesture.y0) / rect.height, rect.height);

    const bin = {
      x: rect.left + rect.width / 2,
      y: rect.bottom - TRASH_BOTTOM_PX - TRASH_SIZE_PX / 2,
    };
    const overBin = distance(point, bin) <= TRASH_HIT_RADIUS_PX;
    if (overBin && !this.ui.trashHot.value) this.store.haptic('medium');
    this.set(this.ui.trashHot, overBin);
    // Over the bin the guides would only be noise.
    this.setGuides(overBin ? NO_GUIDES : { x: x.snapped, y: y.snapped, rotation: null });
    this.queue({ kind: 'overlay', id: gesture.id, patch: { cx: round(x.value, 4), cy: round(y.value, 4) } });
  }

  /**
   * Dragging the video itself. Which way that goes depends on what is being dragged: the clip's
   * rectangle follows the finger across the frame, while a crop's window stays where it is and the
   * SOURCE slides under it - the customer is moving the picture, so the part of it that is kept
   * moves the other way. `source` is the whole source frame's box at the start of the drag, which
   * turns a distance on screen into a distance across the source.
   */
  private moveClipDrag(
    grip: ClipGrip,
    gesture: Extract<Gesture, { kind: 'drag' }>,
    point: Point,
    rect: DOMRect,
  ): void {
    const dx = (point.x - gesture.x0) / rect.width;
    const dy = (point.y - gesture.y0) / rect.height;
    if (grip.mode === 'crop') {
      // An edge of the window: that side of the crop follows the finger and the other three stay
      // where they are. The distance is turned into a distance across the SOURCE by the box the
      // whole source frame occupied when the fingers landed, exactly as the pan below is.
      if (grip.side) {
        const crop = resizeCrop(grip.crop0, grip.side, dx / grip.source.w, dy / grip.source.h);
        this.queue({ kind: 'clip', id: grip.id, patch: { crop } });
        return;
      }
      const crop = slideRect(grip.crop0, grip.crop0.x - dx / grip.source.w, grip.crop0.y - dy / grip.source.h);
      this.queue({ kind: 'clip', id: grip.id, patch: { crop } });
      return;
    }
    const x = snapToCentre(gesture.cx0 + dx, rect.width);
    const y = snapToCentre(gesture.cy0 + dy, rect.height);
    this.setGuides({ x: x.snapped, y: y.snapped, rotation: null });
    // The angle the fingers landed on travels with the drag. Nothing else on the patch carries it -
    // a rectangle written without one is a rectangle put back upright - so a customer who turned a
    // video and then moved it would have watched it straighten as it went.
    const placed = placeClipRect(x.value, y.value, grip.rect0.w, grip.rect0.h, grip.rot0);
    this.queue({ kind: 'clip', id: grip.id, patch: { rect: placed } });
  }

  private moveTwist(gesture: Extract<Gesture, { kind: 'twist' }>): void {
    let dist: number;
    let angle: number;
    if (gesture.source === 'pinch') {
      const pair = this.firstTwo();
      if (!pair) return;
      dist = distance(pair[0], pair[1]);
      angle = angleOf(pair[0], pair[1]);
    } else {
      const point = this.pointers.values().next().value;
      if (!point) return;
      dist = distance(gesture.centre, point);
      angle = angleOf(gesture.centre, point);
    }
    // Accumulated a little at a time, so turning past half a revolution keeps going the same way.
    gesture.turned += angleDelta(angle, gesture.lastAngle);
    gesture.lastAngle = angle;

    if (gesture.grip) {
      this.twistClip(gesture.grip, dist / gesture.dist0, gesture.turned);
      return;
    }

    const overlay = this.store.manifest.value.overlays.find((o) => o.id === gesture.id);
    if (!overlay) {
      this.endTwist();
      return;
    }
    const scale = clamp((gesture.scale0 * dist) / gesture.dist0, MIN_SCALE, MAX_SCALE);
    const rotation = snapRotation(gesture.rot0 + gesture.turned);
    if (Math.abs(gesture.turned) > SNAP_DEG) gesture.twisted = true;
    // An upright layer is already "on" a quarter turn. Only a twist that actually turned it, or a
    // snap that moved it off where it started, earns the guide and the tick - not a plain resize.
    const showSnap = rotation.snapped && (gesture.twisted || rotation.value !== gesture.rot0);
    this.setGuides({
      x: false,
      y: false,
      rotation: showSnap ? { cx: overlay.cx, cy: overlay.cy, deg: rotation.value } : null,
    });
    this.queue({ kind: 'overlay', id: gesture.id, patch: { scale: round(scale, 3), rotationDeg: round(rotation.value, 1) } });
  }

  /**
   * Two fingers on a clip. Spreading them makes the picture bigger, which means a BIGGER rectangle
   * on the frame and a SMALLER window on the source - the same fingers, the opposite arithmetic,
   * which is why the mode is decided once when the fingers land and never re-read mid-pinch.
   *
   * Turning the fingers turns the video, the same way it turns a layer and through the same
   * `snapRotation`, which is what answers the objection this method used to carry: a pinch that
   * wobbles a degree off the axis snaps back to it rather than posting a video a degree crooked.
   * Only a twist that passed the snap threshold, or one that moved the clip off the angle it
   * started at, earns the guide - a plain resize must not draw one.
   *
   * The CROP mode is never turned. Turning the window sampled out of the source is a different
   * operation on different pixels, and no engine implements one, which is why the contract puts
   * the angle on the placement rectangle and not on a crop.
   */
  private twistClip(grip: ClipGrip, factor: number, turned: number): void {
    if (grip.mode === 'crop') {
      this.setGuides(NO_GUIDES);
      this.queue({ kind: 'clip', id: grip.id, patch: { crop: scaleRect(grip.crop0, 1 / factor, MIN_CROP) } });
      return;
    }
    const rotation = snapRotation(grip.rot0 + turned);
    const rect = scaleClipRect(grip.rect0, factor, MIN_CLIP_RECT, rotation.value);
    const showSnap = rotation.snapped && (Math.abs(turned) > SNAP_DEG || rotation.value !== grip.rot0);
    this.setGuides({
      x: false,
      y: false,
      rotation: showSnap ? { cx: rect.x + rect.w / 2, cy: rect.y + rect.h / 2, deg: rotation.value } : null,
    });
    this.queue({ kind: 'clip', id: grip.id, patch: { rect } });
  }

  /* ========================================================================================= */
  /* Ending                                                                                    */
  /* ========================================================================================= */

  private endDrag(gesture: Extract<Gesture, { kind: 'drag' }>, cancelled: boolean): void {
    this.flush();
    // No bin for a clip. Dragging the video to the bottom of the frame is how a customer puts it
    // there, and a timeline segment is deleted from the timeline or the clip row - not by a gesture
    // whose whole point was to move it.
    if (gesture.grip) {
      this.set(this.ui.moving, false);
      this.setGuides(NO_GUIDES);
      this.gesture = { kind: 'spent' };
      this.store.endGesture(gestureLabel(gesture));
      return;
    }
    const intoBin = this.ui.trashHot.value && !cancelled;
    this.set(this.ui.dragging, false);
    this.set(this.ui.moving, false);
    this.set(this.ui.trashHot, false);
    this.setGuides(NO_GUIDES);
    this.gesture = { kind: 'spent' };
    if (intoBin) {
      // The move is thrown away with the layer, so the undo step is "Delete", not "Move".
      this.store.cancelGesture();
      this.store.deleteOverlay(gesture.id);
    } else {
      this.store.endGesture('Move');
    }
  }

  private abandon(): void {
    const gesture = this.gesture;
    if (gesture?.kind === 'drag') this.endDrag(gesture, true);
    else if (gesture?.kind === 'twist') this.endTwist();
    this.pointers.clear();
    this.gesture = null;
  }

  private endTwist(): void {
    const gesture = this.gesture;
    this.flush();
    this.setGuides(NO_GUIDES);
    this.gesture = { kind: 'spent' };
    this.store.endGesture(gesture?.kind === 'twist' ? gestureLabel(gesture) : 'Transform');
  }

  /* ========================================================================================= */
  /* Helpers                                                                                   */
  /* ========================================================================================= */

  /**
   * The handle a press is on - or null when the press landed on a handle's oversized finger target
   * but inside the layer that handle belongs to, which takes it back (see [pressBelongsToLayer]).
   * The button's own click would still follow such a press, so it is swallowed on the way down.
   */
  /* ========================================================================================= */
  /* The cursor                                                                                */
  /* ========================================================================================= */

  /**
   * What the mouse is told it can take hold of, worked out from the SAME hit test a press uses.
   *
   * This cannot be a CSS rule, which is why it is here: the frame takes every pointer event on the
   * picture - each layer inside it is `pointer-events: none` - so the one element a rule could name
   * covers the whole video, most of which usually holds nothing. A cursor declared there would
   * promise a grip on empty picture. The hit test is what actually knows, and running the same one
   * means the hand can never appear anywhere a press would not in fact grab something.
   *
   * Only a mouse gets this far. A finger has no cursor to show, and every `pointermove` it sends is
   * a gesture that is already under way.
   */
  private updateCursor(e: PointerEvent): void {
    if (e.pointerType !== 'mouse') return;
    this.setCursor(this.cursorFor(e));
  }

  private cursorFor(e: PointerEvent): string {
    const gesture = this.gesture;
    if (gesture) {
      // The corner handle scales and turns, so it keeps the resize arrows for the whole drag rather
      // than becoming a hand halfway through it.
      if (gesture.kind === 'twist' && gesture.source === 'handle') return 'nwse-resize';
      // Anything with hold of something is the closed hand, wherever the mouse has carried it to -
      // including well off the layer, which is exactly where a cursor read off the element under
      // the pointer would have gone back to an arrow and read as the drag having been dropped.
      if (gesture.kind === 'press' || gesture.kind === 'drag' || gesture.kind === 'twist') return 'grabbing';
      // A press on empty frame, or a gesture that has given up: nothing is held.
      return '';
    }

    // The three corner buttons draw their own cursors in CSS, so ours has to get out of their way.
    // `handleOf` rather than `handleAt`, which decides who a press belongs to and has a side effect.
    if (handleOf(e.target)) return '';

    const rect = this.stage.getBoundingClientRect();
    const point = { x: e.clientX - rect.left, y: e.clientY - rect.top };

    // While the crop sheet is open the frame is the crop tool's: an edge of the window resizes that
    // side, and everywhere else pans the picture under it. Nothing else on the frame can be picked
    // up at all, so every point really is a grip of one kind or the other.
    const cropping = this.cropGrip(point, rect);
    if (cropping) return cropping.side ? CROP_CURSORS[cropping.side] : 'grab';

    return this.hitTest(point.x, point.y, rect) ? 'grab' : '';
  }

  private setCursor(cursor: string): void {
    if (cursor === this.cursor) return;
    this.cursor = cursor;
    this.stage.style.cursor = cursor;
  }

  private handleAt(e: PointerEvent): SelectionHandle | null {
    const handle = handleOf(e.target);
    if (!handle) return null;
    const overlay = this.store.selectedOverlay.value;
    const bitmap = overlay ? this.store.bitmaps.value.get(overlay.id) : undefined;
    const box = overlay && bitmap ? layerBox(overlay, bitmap, this.store.outputWidth.value) : null;
    if (!overlay || !box) return handle;
    const rect = this.stage.getBoundingClientRect();
    const mine = pressBelongsToLayer(
      e.clientX - rect.left,
      e.clientY - rect.top,
      rect.width,
      rect.height,
      overlay,
      box,
      handle,
      chromeBounds(this.stage, rect),
    );
    if (!mine) return handle;
    this.swallowClick = true;
    return null;
  }

  private onClick(e: Event): void {
    if (!this.swallowClick) return;
    this.swallowClick = false;
    e.stopPropagation();
    e.preventDefault();
  }

  /**
   * The top-most thing under a point on the frame: a layer, or - under all of them - the video the
   * point lands on. Effects cover the whole frame and are not grabbed.
   *
   * The videos come last because every layer is drawn over them and a layer's artwork must stay
   * grabbable where it lies on top of one. Among THEMSELVES they answer top down, so the picture a
   * customer can actually see at the point is the one that takes the touch - which is the whole of
   * what makes a split screen or a picture in picture reachable without going to the timeline.
   */
  private hitTest(px: number, py: number, rect: DOMRect): Transformable | null {
    const overlays = this.store.manifest.value.overlays;
    for (let i = overlays.length - 1; i >= 0; i--) {
      const overlay = overlays[i];
      if (overlay.kind === 'effect' || !this.isShown(overlay)) continue;
      const bitmap = this.store.bitmaps.value.get(overlay.id);
      const box = bitmap ? layerBox(overlay, bitmap, this.store.outputWidth.value) : null;
      if (box && hitsLayer(px, py, rect.width, rect.height, overlay, box)) {
        return {
          id: overlay.id,
          kind: 'overlay',
          cx: overlay.cx,
          cy: overlay.cy,
          widthFrac: box.widthFrac,
          aspect: box.aspect,
          rotationDeg: overlay.rotationDeg,
          isText: overlay.kind === 'text',
        };
      }
    }
    // Every video under the playhead, top down. `previewLayers` is the list the canvas draws, in
    // drawing order, so walking it backwards asks the frontmost picture first and can never hand
    // back a segment that is not on screen at this instant.
    const layers = this.store.previewLayers.value;
    for (let i = layers.length - 1; i >= 0; i--) {
      const target = this.clipTargetOf(layers[i].clipId, layers[i].rect);
      if (hitsLayer(px, py, rect.width, rect.height, target, boxOf(target))) return target;
    }
    // A segment selected from the timeline while the playhead sits somewhere else is on none of the
    // layers above, and its rectangle still has to answer the fingers that are already on it.
    const clip = this.clipTarget();
    if (clip && hitsLayer(px, py, rect.width, rect.height, clip, boxOf(clip))) return clip;
    return null;
  }

  /** The selected clip as something the fingers can move: the rectangle it is drawn in. */
  private clipTarget(): Transformable | null {
    const clip = this.store.selectedClip.value;
    return clip ? this.clipTargetOf(clip.id, clip.rect ?? null) : null;
  }

  /**
   * A clip's rectangle on the frame as something the fingers can move. `placement` is the segment's
   * own [EditClip.rect], and null is the whole frame standing upright - which is what a post nobody
   * has laid out still is, and why the base track answers for every point on the frame.
   */
  private clipTargetOf(id: string, placement: EditPlacement | null): Transformable {
    const rect = orWhole(placement);
    return {
      id,
      kind: 'clip',
      cx: rect.x + rect.w / 2,
      cy: rect.y + rect.h / 2,
      widthFrac: rect.w,
      aspect: (rect.w / rect.h) * this.store.frameAspect.value,
      rotationDeg: rect.rotationDeg ?? 0,
      isText: false,
    };
  }

  /**
   * The crop sheet's clip, gripped for a pan, a zoom or an edge - or null when that sheet is shut.
   *
   * `at` is where the finger landed, in the frame's own pixels, and is what decides which of the
   * three it is. A pinch has no single point and passes none, which is right: two fingers zoom the
   * window wherever they land.
   */
  private cropGrip(at?: Point, rect?: DOMRect): ClipGrip | null {
    if (this.store.panel.value !== 'crop') return null;
    const clip = this.store.cropClip.value;
    if (!clip) return null;
    const grip = this.clipGrip(clip.id, 'crop');
    if (!grip || !at || !rect) return grip;
    return { ...grip, side: cropSideAt(grip, at, rect) };
  }

  private selectedClipGrip(): ClipGrip | null {
    const clip = this.store.selectedClip.value;
    return clip ? this.clipGrip(clip.id, 'rect') : null;
  }

  /**
   * Everything a clip gesture needs, read off the manifest as the fingers land. The picture's box
   * comes from the same arithmetic the render uses, so a pan measured against it moves the crop by
   * exactly as much of the source as the customer saw go past.
   */
  private clipGrip(id: string, mode: ClipMode): ClipGrip | null {
    const clip = findClip(this.store.manifest.value, id);
    if (!clip) return null;
    const crop0 = orWhole(clip.crop);
    const rect0 = orWhole(clip.rect);
    const aspect = this.store.sourceAspect.value;
    const frameAspect = this.store.frameAspect.value;
    /*
     * Where the whole source sits on screen, which is the ruler every crop gesture is measured
     * against: a finger that moves a tenth of this box has moved the crop a tenth of the way across
     * the source.
     *
     * While the crop sheet is open that is the STAGE the preview draws the source on, and it stays
     * put for the whole gesture because nothing a crop changes goes into it. Outside the sheet
     * there is no stage - the preview is showing the finished post - so it is where the whole
     * source frame WOULD sit at the crop's own scale, which is the box this has always used.
     */
    const source =
      mode === 'crop'
        ? cropStageBox(aspect, rect0, frameAspect)
        : sourceFrameBox(pictureBox(aspect, crop0, rect0, this.store.clipFit(clip), frameAspect), crop0);
    // The angle is read once, here, for the same reason the mode is: a twist adds to where the
    // fingers landed, so re-reading it mid-pinch would compound the turn on every frame.
    return { id, mode, rect0, crop0, rot0: clip.rect?.rotationDeg ?? 0, source, side: null };
  }

  /** A tap on nothing: it puts the selection down, or plays and pauses when there is none. */
  private tapEmpty(): void {
    if (this.store.selection.value) this.store.select(null);
    else this.store.togglePlay();
  }

  /** On screen right now: inside its time window, and drawn. */
  private isShown(overlay: EditOverlay): boolean {
    return (
      isOverlayVisibleAt(overlay, this.store.playheadMs.value, this.store.totalMs.value) &&
      this.store.bitmaps.value.has(overlay.id)
    );
  }

  private pausePlayback(): void {
    if (this.store.playing.value) this.store.pause();
  }

  /** Writes the target at most once a frame, however fast the pointer events come. */
  private queue(next: Pending): void {
    const prev = this.pending;
    // Merged only into a patch for the same thing: a gesture that changed target mid-flight (a
    // drag that became a pinch on something else) must not carry the old fields across.
    this.pending =
      prev && prev.kind === next.kind && prev.id === next.id
        ? ({ ...next, patch: { ...prev.patch, ...next.patch } } as Pending)
        : next;
    if (this.frameRequest) return;
    this.frameRequest = requestAnimationFrame(() => {
      this.frameRequest = 0;
      this.flush();
    });
  }

  private flush(): void {
    if (this.frameRequest) {
      cancelAnimationFrame(this.frameRequest);
      this.frameRequest = 0;
    }
    const pending = this.pending;
    this.pending = null;
    if (!pending) return;
    if (pending.kind === 'overlay') this.store.previewOverlay(pending.id, pending.patch);
    else this.store.previewClipFraming(pending.id, pending.patch);
  }

  /** Updates the guides, with one tick of the haptic each time a line snaps on. */
  private setGuides(next: SnapGuides): void {
    const prev = this.ui.guides.value;
    const same =
      prev.x === next.x &&
      prev.y === next.y &&
      prev.rotation?.deg === next.rotation?.deg &&
      prev.rotation?.cx === next.rotation?.cx &&
      prev.rotation?.cy === next.rotation?.cy;
    if (same) return;
    if ((next.x && !prev.x) || (next.y && !prev.y) || (next.rotation && !prev.rotation)) {
      this.store.haptic('selection');
    }
    this.ui.guides.value = next;
  }

  private set(sig: Signal<boolean>, value: boolean): void {
    if (sig.value !== value) sig.value = value;
  }

  private firstTwo(): [Point, Point] | null {
    const it = this.pointers.values();
    const a = it.next().value;
    const b = it.next().value;
    return a && b ? [a, b] : null;
  }

  private listen(type: string, handler: (e: Event) => void, capture = false): void {
    this.stage.addEventListener(type, handler, capture);
    this.unlisten.push(() => this.stage.removeEventListener(type, handler, capture));
  }
}

/**
 * The area the selection chrome may be drawn in, measured from the frame's top-left.
 *
 * Sideways it is the frame itself. The black beside the video looks empty, but the shell floats its
 * Back and Next circles in it, and they paint after the preview: a layer scaled up put its duplicate
 * handle on Next, where a tap meant to copy a sticker rendered the edit and left the editor.
 *
 * Up and down it is the preview's whole box, which is taller than the frame. Nothing is drawn in the
 * band above or below the video, so a layer at the frame's edge keeps its handles out there, clear of
 * its own artwork - but the band ends where the shell's transport row begins, so no handle can land
 * on Play, Undo or Redo either.
 */
export function chromeBounds(stage: HTMLElement, rect: DOMRect): ChromeBounds {
  const host = stage.parentElement?.getBoundingClientRect();
  if (!host) return { left: 0, top: 0, right: rect.width, bottom: rect.height };
  return {
    left: 0,
    top: host.top - rect.top,
    right: rect.width,
    bottom: host.bottom - rect.top,
  };
}

/**
 * What one continuous gesture is called in the undo list. A clip says what it actually did to the
 * video, because "Move" and "Transform" are the language of layers and a customer looking for the
 * crop they just undid would not find it under either.
 */
function gestureLabel(gesture: Extract<Gesture, { kind: 'drag' | 'twist' }>): string {
  if (gesture.grip) return gesture.grip.mode === 'crop' ? 'Crop' : 'Reframe';
  return gesture.kind === 'drag' ? 'Move' : 'Transform';
}

/** What the mouse is told an edge of the crop window will do. */
const CROP_CURSORS: Record<CropSide, string> = {
  top: 'ns-resize',
  bottom: 'ns-resize',
  left: 'ew-resize',
  right: 'ew-resize',
  topLeft: 'nwse-resize',
  bottomRight: 'nwse-resize',
  topRight: 'nesw-resize',
  bottomLeft: 'nesw-resize',
};

/**
 * Which edge or corner of the crop window a finger landed on, or null for the picture inside it.
 *
 * The window is worked out from the grip rather than measured off the DOM, so this and the drag
 * that follows are reading one set of numbers: `source` is where the whole source frame sat when
 * the fingers landed, and the crop is the part of it that is kept, so the window is simply the one
 * inside the other.
 *
 * A CORNER wins over the two edges that meet at it, because a finger in the corner of a small
 * window is inside both bands and a customer aiming at a corner means the corner. Beyond a band's
 * width outside the window nothing is grabbed - a finger well off the window pans, as all of it
 * used to - and the bands are clamped to a third of the window so a small one cannot become all
 * edge with nothing left to pan by.
 */
function cropSideAt(grip: ClipGrip, at: Point, rect: DOMRect): CropSide | null {
  // The same box the sheet draws its window at, from the same function, so what a finger grabs and
  // what it can see are one rectangle.
  const box = cropWindowBox(grip.source, grip.crop0);
  const left = box.x * rect.width;
  const top = box.y * rect.height;
  const width = box.w * rect.width;
  const height = box.h * rect.height;
  const right = left + width;
  const bottom = top + height;

  const bandX = Math.min(CROP_EDGE_GRAB_PX, width / 3);
  const bandY = Math.min(CROP_EDGE_GRAB_PX, height / 3);

  // Outside the window by more than a band: the fingers are on the picture, not on its edge.
  if (at.x < left - bandX || at.x > right + bandX || at.y < top - bandY || at.y > bottom + bandY) return null;

  const onLeft = Math.abs(at.x - left) <= bandX;
  const onRight = Math.abs(at.x - right) <= bandX;
  const onTop = Math.abs(at.y - top) <= bandY;
  const onBottom = Math.abs(at.y - bottom) <= bandY;

  if (onTop && onLeft) return 'topLeft';
  if (onTop && onRight) return 'topRight';
  if (onBottom && onLeft) return 'bottomLeft';
  if (onBottom && onRight) return 'bottomRight';
  if (onTop) return 'top';
  if (onBottom) return 'bottom';
  if (onLeft) return 'left';
  if (onRight) return 'right';
  return null;
}

function handleOf(target: EventTarget | null): SelectionHandle | null {
  if (!(target instanceof Element)) return null;
  const name = target.closest('[data-handle]')?.getAttribute('data-handle');
  return name === 'delete' || name === 'edit' || name === 'transform' ? name : null;
}

/**
 * A point on the frame (pixels from its top-left) in the LAYER's own frame: measured from its
 * centre and turned back by its rotation, so every test against it is a plain rectangle.
 */
function toLayerSpace(
  px: number,
  py: number,
  frameWidth: number,
  frameHeight: number,
  overlay: Pick<EditOverlay, 'cx' | 'cy' | 'rotationDeg'>,
): Point {
  const dx = px - overlay.cx * frameWidth;
  const dy = py - overlay.cy * frameHeight;
  const rad = (overlay.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: dx * cos + dy * sin, y: -dx * sin + dy * cos };
}

/** A layer smaller than a fingertip keeps a fingertip's worth of hit box, centred on it. */
function withinHitBox(local: Point, box: LayerBox, frameWidth: number): boolean {
  const width = box.widthFrac * frameWidth;
  const height = width / box.aspect;
  return (
    Math.abs(local.x) <= Math.max(width, MIN_HIT_PX) / 2 && Math.abs(local.y) <= Math.max(height, MIN_HIT_PX) / 2
  );
}

function distance(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** Clockwise from the positive x axis, in degrees - the direction CSS `rotate()` turns. */
function angleOf(from: Point, to: Point): number {
  return (Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI;
}

function round(value: number, places: number): number {
  const k = 10 ** places;
  return Math.round(value * k) / k;
}
