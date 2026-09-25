import { MAX_CAMERA_KEYS, MAX_CAMERA_SCALE, type ComposeCamera } from '../video-composer/definitions';

/**
 * Where the camera is at one moment: `scale` >= 1 and the point (`cx`, `cy`) of the unzoomed frame,
 * in 0..1 output fractions, that it brings to the frame's centre. See [ComposeCamera].
 */
export interface CameraView {
  scale: number;
  cx: number;
  cy: number;
}

/** The whole frame, unmoved. */
export const IDENTITY_VIEW: Readonly<CameraView> = Object.freeze({ scale: 1, cx: 0.5, cy: 0.5 });

/** Below this a view is the whole frame; it keeps float dust from switching the camera on. */
const IDENTITY_EPSILON = 1e-4;

/** Whether a view leaves the frame as it is. */
export function isIdentityView(view: CameraView | null | undefined): boolean {
  return !view || view.scale <= 1 + IDENTITY_EPSILON;
}

/**
 * A view held inside the frame: `scale` to 1..[MAX_CAMERA_SCALE] and each centre to
 * `0.5 / scale .. 1 - 0.5 / scale`, the parser's rule. Non-finite numbers fall back to the whole frame.
 */
export function clampView(view: CameraView): CameraView {
  const scale = Number.isFinite(view.scale) ? Math.min(MAX_CAMERA_SCALE, Math.max(1, view.scale)) : 1;
  const half = 0.5 / scale;
  const cx = Number.isFinite(view.cx) ? Math.min(1 - half, Math.max(half, view.cx)) : 0.5;
  const cy = Number.isFinite(view.cy) ? Math.min(1 - half, Math.max(half, view.cy)) : 0.5;
  return { scale, cx, cy };
}

/**
 * The camera at output time `ms`, read exactly as [ComposeCamera] states: end keys hold, fields are
 * interpolated in a straight line between the keys either side, and keys at the same time are a step
 * with the later one winning. `null` for no camera, and for a moment where the frame is whole, so a
 * caller can take its old path for that frame.
 *
 * Binary search, because a long post compiles to thousands of keys and this runs every frame.
 */
export function cameraAt(camera: ComposeCamera | null | undefined, ms: number): CameraView | null {
  if (!camera) return null;
  const at = camera.atMs;
  const n = at.length;
  if (n === 0) return null;
  let view: CameraView;
  if (!(ms > at[0])) {
    // At or before the first key. Equal times are a step to the LAST key sharing that time.
    let i = 0;
    while (i + 1 < n && at[i + 1] <= ms) i++;
    view = keyView(camera, i);
  } else if (ms >= at[n - 1]) {
    view = keyView(camera, n - 1);
  } else {
    // The last key at or before `ms`: at[lo] <= ms < at[lo + 1].
    let lo = 0;
    let hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (at[mid] <= ms) lo = mid;
      else hi = mid;
    }
    const span = at[lo + 1] - at[lo];
    const f = span > 0 ? (ms - at[lo]) / span : 1;
    view = {
      scale: lerp(camera.scale[lo], camera.scale[lo + 1], f),
      cx: lerp(camera.cx[lo], camera.cx[lo + 1], f),
      cy: lerp(camera.cy[lo], camera.cy[lo + 1], f),
    };
  }
  return isIdentityView(view) ? null : view;
}

/**
 * Where a point of the unzoomed frame lands through `view`, both in 0..1 output fractions:
 * `p' = 0.5 + (p - c) * scale`, per axis.
 */
export function viewPoint(view: CameraView, x: number, y: number): { x: number; y: number } {
  return { x: 0.5 + (x - view.cx) * view.scale, y: 0.5 + (y - view.cy) * view.scale };
}

/** The inverse of [viewPoint]: the point of the unzoomed frame shown at output fraction (x, y). */
export function unviewPoint(view: CameraView, x: number, y: number): { x: number; y: number } {
  return { x: view.cx + (x - 0.5) / view.scale, y: view.cy + (y - 0.5) / view.scale };
}

/**
 * A camera track made safe to draw: the parser's rules shared by the web engine and the tests.
 * Every key clamped, times non-decreasing, all four arrays one length - or `null` when it moves
 * nothing, which is the absent path. Throws for a track no engine could honour: mismatched arrays,
 * non-finite or decreasing times, or more than [MAX_CAMERA_KEYS] keys.
 */
export function normaliseCamera(camera: ComposeCamera | null | undefined): ComposeCamera | null {
  if (!camera) return null;
  const n = camera.atMs?.length ?? 0;
  if (n === 0) return null;
  if (camera.scale?.length !== n || camera.cx?.length !== n || camera.cy?.length !== n) {
    throw new Error('camera: atMs, scale, cx and cy must all have the same length');
  }
  if (n > MAX_CAMERA_KEYS) throw new Error(`camera: at most ${MAX_CAMERA_KEYS} keys`);
  const out: ComposeCamera = { atMs: [], scale: [], cx: [], cy: [] };
  let moves = false;
  for (let i = 0; i < n; i++) {
    const t = camera.atMs[i];
    if (!Number.isFinite(t)) throw new Error(`camera: atMs[${i}] is not a number`);
    if (i > 0 && t < camera.atMs[i - 1]) throw new Error(`camera: atMs[${i}] goes back in time`);
    const view = clampView({ scale: camera.scale[i], cx: camera.cx[i], cy: camera.cy[i] });
    if (!isIdentityView(view)) moves = true;
    out.atMs.push(t);
    out.scale.push(view.scale);
    out.cx.push(view.cx);
    out.cy.push(view.cy);
  }
  return moves ? out : null;
}

function keyView(camera: ComposeCamera, i: number): CameraView {
  return { scale: camera.scale[i], cx: camera.cx[i], cy: camera.cy[i] };
}

function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}
