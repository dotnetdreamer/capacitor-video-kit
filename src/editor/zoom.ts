import { MAX_CAMERA_KEYS, type ComposeCamera } from '../video-composer/definitions';
import { clampView, IDENTITY_VIEW, type CameraView } from './camera';
import { ZOOM_CHAIN_GAP_MS, zoomWindow, type EditZoom, type ZoomEase } from './edit-manifest';

/**
 * Zooms LOWERED to a camera track - the one place any easing happens.
 *
 * Every engine (web, Android, iOS) and the preview only interpolate straight lines between the keys
 * this file writes ([ComposeCamera]). That is the transitions precedent, and for the same reason:
 * three hand-written copies of an ease, a spring and a pan rule would drift apart one release at a
 * time, and the customer would see a different move in the preview from the one in their export.
 */

/** A zoom's place on the timeline as it PLAYS: cut to the post, with the ramps it really gets. */
export interface ZoomSlot {
  id: string;
  startMs: number;
  endMs: number;
  /** The ramps actually run, `min(rampMs, window / 2)`: a short window squeezes them. */
  rampInMs: number;
  rampOutMs: number;
  /** Whether the camera arrives by PANNING from the zoom before rather than from the whole frame. */
  chainedIn: boolean;
  /** Whether it leaves by panning to the next zoom rather than going back to the whole frame. */
  chainedOut: boolean;
}

/**
 * The visible zooms as they play, in order: cut to `0..totalMs`, invisible ones left out, ramps
 * squeezed into their window and chains marked. The timeline draws these and [compileCamera] compiles
 * them, so the lane can never show a ramp the render does not do.
 *
 * Sorted and de-overlapped again here although a normalised manifest already is: a hand-built list
 * straight from a host must not make the camera two functions of time.
 */
export function zoomSlots(zooms: readonly EditZoom[], totalMs: number): ZoomSlot[] {
  const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs);
  const slots: ZoomSlot[] = [];
  for (const zoom of sorted) {
    const window = zoomWindow(zoom, totalMs);
    if (!window) continue;
    const prev = slots[slots.length - 1];
    const startMs = prev ? Math.max(window.startMs, prev.endMs) : window.startMs;
    const endMs = window.endMs;
    if (!(endMs > startMs)) continue;
    const ramp = Math.max(0, Math.min(Number.isFinite(zoom.rampMs) ? zoom.rampMs : 0, (endMs - startMs) / 2));
    slots.push({ id: zoom.id, startMs, endMs, rampInMs: ramp, rampOutMs: ramp, chainedIn: false, chainedOut: false });
  }
  for (let i = 1; i < slots.length; i++) {
    if (slots[i].startMs - slots[i - 1].endMs < ZOOM_CHAIN_GAP_MS) {
      slots[i - 1].chainedOut = true;
      slots[i].chainedIn = true;
    }
  }
  return slots;
}

/** How far along an ease is at `p` (0..1 of the ramp), 0 at the start and exactly 1 at the end. */
export function easeValue(ease: ZoomEase, p: number): number {
  const t = p <= 0 ? 0 : p >= 1 ? 1 : p;
  switch (ease) {
    case 'steady':
      return t;
    case 'snappy':
      // A critically damped spring released at once: it leaves at full speed and settles with no
      // overshoot, which is what "snappy" feels like without the wobble a bouncier spring would put
      // into a picture of text. Divided by its own value at 1 so the ramp really lands on the area.
      return spring(t) / SPRING_AT_ONE;
    default:
      // easeInOutCubic: leaves rest gently and arrives gently - the move a camera operator makes.
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
  }
}

const SPRING_K = 8;
function spring(t: number): number {
  return 1 - (1 + SPRING_K * t) * Math.exp(-SPRING_K * t);
}
const SPRING_AT_ONE = spring(1);

/**
 * The view part of the way from `a` to `b`, at ease value `e` (0..1).
 *
 * Not a lerp of scale and centre. Lerping the scale makes the zoom rush at the start and crawl at the
 * end (the visible width goes as 1/scale), and lerping the centre while the scale changes swings the
 * picture sideways before it settles. So the move is made on the VISIBLE RECTANGLE: its width w = 1/s
 * goes GEOMETRICALLY (w1^(1-e) * w2^e - a constant perceived zoom speed), and its corner moves along
 * the straight segment in (x, y, w) between the two rectangles. A straight segment between two
 * rectangles inside the frame stays inside it (that set is convex), and a pure zoom closes in on the
 * area's own fixed point with no swing.
 */
export function viewBetween(a: CameraView, b: CameraView, e: number): CameraView {
  const w1 = 1 / a.scale;
  const w2 = 1 / b.scale;
  const x1 = a.cx - w1 / 2;
  const y1 = a.cy - w1 / 2;
  const x2 = b.cx - w2 / 2;
  const y2 = b.cy - w2 / 2;
  let w: number;
  let lambda: number;
  if (Math.abs(w1 - w2) > 1e-6) {
    w = Math.pow(w1, 1 - e) * Math.pow(w2, e);
    lambda = (w - w1) / (w2 - w1);
  } else {
    w = w1;
    lambda = e;
  }
  const x = x1 + (x2 - x1) * lambda;
  const y = y1 + (y2 - y1) * lambda;
  return clampView({ scale: 1 / w, cx: x + w / 2, cy: y + w / 2 });
}

/** One key of the camera being built. */
interface Key {
  t: number;
  view: CameraView;
}

/** The finest the moves are sampled: one key per frame at 60 fps, which no eye can tell from a curve. */
const SAMPLE_MS = 1000 / 60;

/**
 * The camera for a post's zooms, or `null` when none of them is visible - which is the ABSENT key on
 * the wire and every engine's old path, decided the same way as [isUntouched] decides it.
 *
 * Each zoom is a move in from the whole frame over its ramp, a hold on its area, and a move back out
 * over the same ramp, all inside its window. A ramp of 0 is a STEP: two keys at one time, which the
 * wire reads as a cut. Two zooms closer than [ZOOM_CHAIN_GAP_MS] are one PAN instead, from where the
 * first starts leaving to where the second has arrived, with the second zoom's ease - the camera never
 * passes through the whole frame between them.
 */
export function compileCamera(zooms: readonly EditZoom[], totalMs: number): ComposeCamera | null {
  const slots = zoomSlots(zooms, totalMs);
  if (slots.length === 0) return null;
  const byId = new Map(zooms.map((zoom) => [zoom.id, zoom]));
  // A post with the most zooms and the longest ramps stays far under [MAX_CAMERA_KEYS] at one key a
  // frame; this loop only coarsens the sampling for a hand-built list that would not.
  for (let step = SAMPLE_MS; ; step *= 2) {
    const keys = compileKeys(slots, byId, step);
    if (keys.length <= MAX_CAMERA_KEYS || step > 10_000) return toCamera(keys.slice(0, MAX_CAMERA_KEYS));
  }
}

function compileKeys(slots: ZoomSlot[], byId: Map<string, EditZoom>, step: number): Key[] {
  const keys: Key[] = [];
  const push = (t: number, view: CameraView) => {
    const time = Math.round(t * 1000) / 1000;
    const last = keys[keys.length - 1];
    if (last && last.t === time && sameView(last.view, view)) return;
    keys.push({ t: time, view });
  };
  const move = (from: CameraView, to: CameraView, t0: number, t1: number, ease: ZoomEase) => {
    push(t0, from);
    const span = t1 - t0;
    if (span > 0) {
      const n = Math.max(1, Math.ceil(span / step));
      for (let k = 1; k < n; k++) push(t0 + (span * k) / n, viewBetween(from, to, easeValue(ease, k / n)));
    }
    push(t1, to);
  };
  const viewOf = (slot: ZoomSlot): CameraView => {
    const zoom = byId.get(slot.id)!;
    return clampView({ scale: zoom.scale, cx: zoom.cx, cy: zoom.cy });
  };
  const identity: CameraView = { ...IDENTITY_VIEW };

  slots.forEach((slot, i) => {
    const zoom = byId.get(slot.id)!;
    const area = viewOf(slot);
    if (!slot.chainedIn) move(identity, area, slot.startMs, slot.startMs + slot.rampInMs, zoom.ease);
    // The hold needs no keys of its own: the key the move in ended on and the key the move out
    // starts from are both the area, and the wire interpolates a straight line between them.
    const leaveAt = slot.endMs - slot.rampOutMs;
    if (!slot.chainedOut) {
      move(area, identity, leaveAt, slot.endMs, zoom.ease);
      return;
    }
    const next = slots[i + 1];
    const nextZoom = byId.get(next.id)!;
    const arriveAt = next.startMs + next.rampInMs;
    if (slot.rampOutMs + next.rampInMs === 0) {
      // Both asked for a cut: hold this area through the gap and cut straight to the next one where
      // it starts, rather than inventing a slow pan across the gap that nobody asked for.
      push(leaveAt, area);
      move(area, viewOf(next), next.startMs, next.startMs, nextZoom.ease);
    } else {
      move(area, viewOf(next), leaveAt, arriveAt, nextZoom.ease);
    }
  });
  return keys;
}

function toCamera(keys: Key[]): ComposeCamera {
  const camera: ComposeCamera = { atMs: [], scale: [], cx: [], cy: [] };
  for (const key of keys) {
    camera.atMs.push(key.t);
    camera.scale.push(round6(key.view.scale));
    camera.cx.push(round6(key.view.cx));
    camera.cy.push(round6(key.view.cy));
  }
  return camera;
}

function sameView(a: CameraView, b: CameraView): boolean {
  return a.scale === b.scale && a.cx === b.cx && a.cy === b.cy;
}

/** Six decimals keep a long camera's JSON small and are far below a pixel on any frame. */
function round6(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
