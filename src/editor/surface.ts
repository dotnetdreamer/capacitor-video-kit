import { MAX_OVERLAY_MOTION_KEYS, MAX_OVERLAY_QUAD_KEYS, type ComposeOverlayMotion, type ComposeOverlayQuad } from '../video-composer/definitions';
import type { LayerMap } from '../video-composer/web/layer-map';

import { MAX_SCALE, MIN_SCALE, OVERLAY_BASE, type EditManifest, type EditOutput, type EditOverlay, type EditTrack, type OverlayFollow } from './edit-manifest';
import { applyH, isConvexQuad, quadArea, squareToQuad } from './homography';
import { compileOverlayMotion } from './motion';
import { MAX_SMOOTH_MS, pathAt, pinnedPoint, trackPath, trackSmooth } from './overlay-track';
import { combineMotions, followedTrack, followPatch, outputMsOf, trackedFootage, trackFromRun, trackStretches, type TrackRunResult, type TrackScene } from './track-motion';

/**
 * A layer pinned ON a flat surface ([OverlayFollow.onSurface] of a track with [EditTrack.corners]): a photo
 * on a phone's screen, a name on a sign, drawn in perspective as the surface is.
 *
 * The surface is its four corners at every sample, smoothed in time as a track's path is. At any instant
 * the homography that takes the unit square onto them is the surface's own plane, the unit square being
 * the whole surface; a layer on it is a rectangle in that plane, fixed, and drawn at each instant as that
 * rectangle through the homography then - through the clip's trim, crop, fit, placement and the camera to
 * the output frame, as any following layer is ([trackedFootage]).
 *
 * The rectangle is not stored. The layer keeps its centre, size and angle where it was drawn at the
 * follow's pin, as every following layer does, and those are read against the surface as it would look
 * seen square on there - a stand-in of the surface's own shape and area, at its middle, turned with its
 * top edge - so a layer moved, pinched or turned on the frame is moved, pinched or turned on the surface by
 * the very gestures and patches every following layer goes through. The surface's own shape, width over
 * height, is found from how the camera sees it ([seenAspect]); a photo is cut to it, so a photo pinned to
 * fill the surface fills it.
 *
 * On the wire a layer on a surface carries its quad ([ComposeOverlayQuad]) one key a post frame, and as its
 * `motion` the quad's best fit - middle, size and turn - for a build that draws no quads.
 */

/** The unit square's corners in a picture's order: the whole surface, in its own plane. */
const WHOLE: readonly number[] = Object.freeze([0, 0, 1, 0, 1, 1, 0, 1]);

/** How far into the surface a text or a sticker put on it may reach: most of it, never past its edges. */
const NATURAL_FILL = 0.8;

/** What a surface's run found: a run's path, and the surface's corners at every sample of it. */
export interface SurfaceRunResult extends TrackRunResult {
  /** Eight a sample, fractions of the oriented source: [EditTrack.corners]. */
  corners: number[];
}

/** Whether `track` follows a flat surface: it has a quad for every sample. */
export function isSurfaceTrack(track: Pick<EditTrack, 'corners' | 'atMs'> | null | undefined): boolean {
  return !!track && Array.isArray(track.corners) && track.atMs.length > 0 && track.corners.length === 8 * track.atMs.length;
}

/** "Surface 1", "Surface 2", ...: the name a new surface lands with, the lowest number no track of the post is called. */
export function nextSurfaceName(tracks: readonly Pick<EditTrack, 'name'>[]): string {
  const taken = new Set(tracks.map(t => t.name));
  for (let n = 1; ; n++) if (!taken.has(`Surface ${n}`)) return `Surface ${n}`;
}

/** The surface a layer is drawn on, and how it follows it: null for a layer that is not on one. */
export function surfaceOf(manifest: Pick<EditManifest, 'tracks'>, overlay: Pick<EditOverlay, 'follow' | 'kind'>): { track: EditTrack; follow: OverlayFollow } | null {
  if (overlay.kind === 'effect' || overlay.follow?.onSurface !== true) return null;
  const followed = followedTrack(manifest, overlay);
  return followed && isSurfaceTrack(followed.track) ? followed : null;
}

/** A new surface track from a run: [trackFromRun], with the corners. */
export function surfaceTrackFromRun(run: SurfaceRunResult, id: string, name: string, hue: number, smooth?: number): EditTrack {
  return { ...trackFromRun(run, id, name, hue, smooth), corners: run.corners };
}

const smoothedCorners = new WeakMap<EditTrack, Float64Array>();

/**
 * A surface's corners as drawn: each of the eight series smoothed in time exactly as a track's path is
 * (`trackPath`: a straight line fitted to the neighbours under a Gaussian, read at the sample), so the
 * quad and the middle a flat follower rides on agree. Made once per track object. Null for no surface.
 */
export function surfaceCorners(track: EditTrack): Float64Array | null {
  if (!isSurfaceTrack(track)) return null;
  const known = smoothedCorners.get(track);
  if (known) return known;
  const raw = track.corners!;
  const times = track.atMs;
  const n = times.length;
  const out = Float64Array.from(raw);
  const sigma = trackSmooth(track) * MAX_SMOOTH_MS;
  if (sigma > 1 && n >= 3) {
    const reach = 3 * sigma;
    const inv = 1 / (2 * sigma * sigma);
    const t0 = new Float64Array(8);
    const t1 = new Float64Array(8);
    let lo = 0;
    let hi = 0;
    for (let i = 0; i < n; i++) {
      const t = times[i]!;
      while (t - times[lo]! > reach) lo++;
      if (hi < i) hi = i;
      while (hi + 1 < n && times[hi + 1]! - t <= reach) hi++;
      let s0 = 0;
      let s1 = 0;
      let s2 = 0;
      t0.fill(0);
      t1.fill(0);
      for (let j = lo; j <= hi; j++) {
        const d = times[j]! - t;
        const w = Math.exp(-d * d * inv);
        s0 += w;
        s1 += w * d;
        s2 += w * d * d;
        for (let k = 0; k < 8; k++) {
          const v = raw[8 * j + k]!;
          t0[k]! += w * v;
          t1[k]! += w * d * v;
        }
      }
      const det = s0 * s2 - s1 * s1;
      const line = s2 > 0 && det > 1e-6 * s0 * s2;
      for (let k = 0; k < 8; k++) out[8 * i + k] = line ? (s2 * t0[k]! - s1 * t1[k]!) / det : t0[k]! / s0;
    }
  }
  smoothedCorners.set(track, out);
  return out;
}

/** The surface's corners at SOURCE `sourceMs`, fractions of the source: a straight line between the samples either side, the ends held. */
export function surfaceCornersAt(track: EditTrack, sourceMs: number): number[] | null {
  const c = surfaceCorners(track);
  if (!c) return null;
  const at = track.atMs;
  const n = at.length;
  const read = (i: number): number[] => Array.from(c.subarray(8 * i, 8 * i + 8));
  if (!(sourceMs > at[0]!)) return read(0);
  if (sourceMs >= at[n - 1]!) return read(n - 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! <= sourceMs) lo = mid;
    else hi = mid;
  }
  const f = (sourceMs - at[lo]!) / (at[hi]! - at[lo]!);
  const out = new Array<number>(8);
  for (let k = 0; k < 8; k++) out[k] = c[8 * lo + k]! + (c[8 * hi + k]! - c[8 * lo + k]!) * f;
  return out;
}

/** Fractions of a source `aspect` wide as units of its height, where both axes are the same size. */
function metric(c: ArrayLike<number>, aspect: number): number[] {
  return [c[0]! * aspect, c[1]!, c[2]! * aspect, c[3]!, c[4]! * aspect, c[5]!, c[6]! * aspect, c[7]!];
}

/**
 * A rectangle's own width over its height from the quad a camera sees it as (Zhang and He, "Whiteboard
 * scanning and image enhancement", 2007): the camera's focal length found from the quad, its middle taken as
 * the picture's (`centre`), and the rectangle's two sides measured through it. A quad turned about one axis
 * only - a screen swung round on its upright edge - has one pair of sides still parallel and says nothing of
 * the focal length; it is then `focal`, a phone camera's (about 0.8 of the frame's longer side), and so is
 * one found past any camera's. All but a parallelogram, it is the sides' own lengths that say. Units are the
 * quad's. Null for a quad that says nothing.
 */
export function seenAspect(c: ArrayLike<number>, centre: { x: number; y: number }, focal = 1.6 * Math.max(centre.x, centre.y)): number | null {
  const m1 = [c[0]! - centre.x, c[1]! - centre.y, 1];
  const m2 = [c[2]! - centre.x, c[3]! - centre.y, 1];
  const m4 = [c[4]! - centre.x, c[5]! - centre.y, 1];
  const m3 = [c[6]! - centre.x, c[7]! - centre.y, 1];
  const top = Math.hypot(c[2]! - c[0]!, c[3]! - c[1]!) + Math.hypot(c[4]! - c[6]!, c[5]! - c[7]!);
  const sides = Math.hypot(c[6]! - c[0]!, c[7]! - c[1]!) + Math.hypot(c[4]! - c[2]!, c[5]! - c[3]!);
  const edges = sides > 0 && top > 0 ? top / sides : null;
  const c14 = cross(m1, m4);
  const k2 = dot(c14, m3) / dot(cross(m2, m4), m3);
  const k3 = dot(c14, m2) / dot(cross(m3, m4), m2);
  if (!Number.isFinite(k2) || !Number.isFinite(k3) || !(k2 > 0) || !(k3 > 0)) return edges;
  const n2 = [k2 * m2[0]! - m1[0]!, k2 * m2[1]! - m1[1]!, k2 - 1];
  const n3 = [k3 * m3[0]! - m1[0]!, k3 * m3[1]! - m1[1]!, k3 - 1];
  if (Math.abs(n2[2]!) < 0.01 && Math.abs(n3[2]!) < 0.01) return edges;
  // Found from the quad only where both pairs of sides meet somewhere: otherwise the answer is noise.
  const longest = 2 * Math.max(centre.x, centre.y);
  let f2 = Math.abs(n2[2]!) > 0.02 && Math.abs(n3[2]!) > 0.02 ? -(n2[0]! * n3[0]! + n2[1]! * n3[1]!) / (n2[2]! * n3[2]!) : NaN;
  if (!(f2 > 0) || Math.sqrt(f2) < 0.3 * longest || Math.sqrt(f2) > 4 * longest) f2 = focal * focal;
  if (!(f2 > 0)) return edges;
  const w = Math.sqrt((n2[0]! * n2[0]! + n2[1]! * n2[1]!) / f2 + n2[2]! * n2[2]!);
  const h = Math.sqrt((n3[0]! * n3[0]! + n3[1]! * n3[1]!) / f2 + n3[2]! * n3[2]!);
  const aspect = w / h;
  return Number.isFinite(aspect) && aspect > 0 ? aspect : edges;
}

function cross(a: number[], b: number[]): number[] {
  return [a[1]! * b[2]! - a[2]! * b[1]!, a[2]! * b[0]! - a[0]! * b[2]!, a[0]! * b[1]! - a[1]! * b[0]!];
}

function dot(a: number[], b: number[]): number {
  return a[0]! * b[0]! + a[1]! * b[1]! + a[2]! * b[2]!;
}

const aspects = new WeakMap<EditTrack, number>();

/**
 * The surface's own width over its height, seen square on: [seenAspect] of its quads over the track - up to
 * a few dozen of them - and the middle answer, so one frame's wobble never changes how a photo is cut. One
 * number per track object; 1 where nothing says.
 */
export function surfaceAspect(track: EditTrack): number {
  const known = aspects.get(track);
  if (known !== undefined) return known;
  const corners = surfaceCorners(track);
  const n = track.atMs.length;
  const found: number[] = [];
  if (corners) {
    const every = Math.max(1, Math.floor(n / 48));
    for (let i = 0; i < n; i += every) {
      const a = seenAspect(metric(corners.subarray(8 * i, 8 * i + 8), track.aspect), { x: track.aspect / 2, y: 0.5 });
      if (a !== null && Number.isFinite(a) && a > 0) found.push(a);
    }
  }
  found.sort((a, b) => a - b);
  const middle = found.length > 0 ? found[(found.length - 1) >> 1]! : 1;
  const aspect = Math.min(20, Math.max(0.05, middle));
  aspects.set(track, aspect);
  return aspect;
}

/** The surface as it would look seen square on, standing in for it at one instant: in units of the source's height. */
interface StandIn {
  cx: number;
  cy: number;
  w: number;
  h: number;
  /** Clockwise degrees: its top edge's. */
  angle: number;
}

/**
 * The surface at SOURCE `sourceMs` as a rectangle of its own shape and its quad's area, at the middle its path
 * has there - the very point a flat follower is pinned against - turned as its top edge is.
 */
function standIn(track: EditTrack, sourceMs: number): StandIn | null {
  const corners = surfaceCornersAt(track, sourceMs);
  if (!corners) return null;
  const q = metric(corners, track.aspect);
  const area = Math.abs(quadArea(q));
  if (!(area > 0)) return null;
  const shape = surfaceAspect(track);
  const here = pathAt(trackPath(track), sourceMs);
  return { cx: here.x * track.aspect, cy: here.y, w: Math.sqrt(area * shape), h: Math.sqrt(area / shape), angle: (Math.atan2(q[3]! - q[1]!, q[2]! - q[0]!) * 180) / Math.PI };
}

/** How `map` draws the source round (`u`, `v`): output pixels per unit of the source's height, and the clockwise degrees it turns it. */
function drawnBy(map: LayerMap, aspect: number, u: number, v: number): { scale: number; turn: number } {
  const o = map.toOutput(u, v);
  const e = map.toOutput(u + 1 / aspect, v);
  return { scale: Math.hypot(e.x - o.x, e.y - o.y), turn: (Math.atan2(e.y - o.y, e.x - o.x) * 180) / Math.PI };
}

/**
 * The output instant a follow's pin is read at: where the post first shows SOURCE `sourceMs` of the track's
 * footage, or the nearest it comes to. A layer's size is kept in output pixels, and this is where those
 * pixels are measured against the footage.
 */
function pinOutputMs(track: EditTrack, manifest: TrackScene['manifest'], sourceMs: number): number | null {
  let best: ReturnType<typeof trackStretches>[number] | null = null;
  let gap = Infinity;
  for (const stretch of trackStretches(track, manifest)) {
    const off = sourceMs < stretch.fromMs ? stretch.fromMs - sourceMs : sourceMs > stretch.toMs ? sourceMs - stretch.toMs : 0;
    if (off < gap) {
      gap = off;
      best = stretch;
    }
  }
  return best ? outputMsOf(best, Math.min(best.toMs, Math.max(best.fromMs, sourceMs))) : null;
}

/** Where a layer is on its surface. */
export interface SurfacePlacement {
  /** The layer's rectangle in the surface's own plane, the unit square being the whole surface: eight numbers, its corners in the bitmap's order. */
  plane: number[];
  /** The part of the bitmap drawn, as fractions of it, or null for all of it: a photo is cut to the surface's shape. */
  cut: { x: number; y: number; w: number; h: number } | null;
}

/**
 * Where `overlay` is on its surface: its rectangle where it is drawn at the pin - its bitmap `bitmap.wPx` by
 * `bitmap.hPx`, times the pin's grow, at its own angle - read against the surface seen square on there. A
 * photo is the middle of itself in the surface's own shape (`cut` false leaves it whole). Null for a layer
 * not on a surface, or one whose footage is gone.
 */
export function surfacePlacement(overlay: EditOverlay, scene: TrackScene, bitmap: { wPx: number; hPx: number }, cut = true): SurfacePlacement | null {
  const on = surfaceOf(scene.manifest, overlay);
  if (!on || !(bitmap.wPx > 0) || !(bitmap.hPx > 0)) return null;
  const { track, follow } = on;
  const pinMs = follow.pin.atMs;
  const frame = standIn(track, pinMs);
  const outputMs = frame ? pinOutputMs(track, scene.manifest, pinMs) : null;
  const footage = outputMs !== null ? trackedFootage(track, scene, outputMs) : null;
  if (!frame || !footage) return null;
  const point = pinnedPoint(track, follow, trackPath(track), pinMs);
  const drawn = drawnBy(footage.map, track.aspect, point.x, point.y);
  if (!(drawn.scale > 0)) return null;
  let w = bitmap.wPx;
  let h = bitmap.hPx;
  let part: SurfacePlacement['cut'] = null;
  if (cut && overlay.kind === 'image') {
    const shape = surfaceAspect(track);
    const keepW = Math.min(1, shape / (w / h));
    const keepH = Math.min(1, w / h / shape);
    if (keepW < 1 - 1e-6 || keepH < 1 - 1e-6) {
      part = { x: (1 - keepW) / 2, y: (1 - keepH) / 2, w: keepW, h: keepH };
      w *= keepW;
      h *= keepH;
    }
  }
  const grow = follow.pin.grow ?? 1;
  const hw = (w * grow) / drawn.scale / 2;
  const hh = (h * grow) / drawn.scale / 2;
  const rad = ((overlay.rotationDeg - drawn.turn) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const fr = (frame.angle * Math.PI) / 180;
  const fc = Math.cos(fr);
  const fs = Math.sin(fr);
  const cx = point.x * track.aspect;
  const cy = point.y;
  const plane: number[] = [];
  for (const [sx, sy] of [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1],
  ] as const) {
    const qx = cx + sx * hw * cos - sy * hh * sin - frame.cx;
    const qy = cy + sx * hw * sin + sy * hh * cos - frame.cy;
    // Into the stand-in's own frame: turned back by its angle, then as shares of its size.
    plane.push((qx * fc + qy * fs) / frame.w + 0.5, (-qx * fs + qy * fc) / frame.h + 0.5);
  }
  return plane.every(Number.isFinite) ? { plane, cut: part } : null;
}

/**
 * Where `plane` - a rectangle in the surface's own plane, the whole surface for null - is drawn at output
 * instant `outputMs`: its four corners as fractions of the output frame, and the SOURCE instant the
 * footage shows there. Null where the footage is not on the post.
 */
export function surfaceQuadAt(track: EditTrack, plane: ArrayLike<number> | null, scene: TrackScene, outputMs: number): { corners: number[]; sourceMs: number } | null {
  const footage = trackedFootage(track, scene, outputMs);
  const corners = footage ? surfaceCornersAt(track, footage.sourceMs) : null;
  const h = corners ? squareToQuad(corners) : null;
  if (!footage || !h) return null;
  const output = scene.manifest.output;
  const p = plane ?? WHOLE;
  const out = new Array<number>(8);
  for (let k = 0; k < 4; k++) {
    const s = applyH(h, p[2 * k]!, p[2 * k + 1]!);
    if (!Number.isFinite(s.x) || !Number.isFinite(s.y)) return null;
    const o = footage.map.toOutput(s.x, s.y);
    out[2 * k] = o.x / output.width;
    out[2 * k + 1] = o.y / output.height;
  }
  return { corners: out, sourceMs: footage.sourceMs };
}

/** A layer on a surface as the wire carries it. */
export interface SurfaceQuad {
  quad: ComposeOverlayQuad;
  /** For a build that draws no quads: the quad's best fit a key, with the layer's animation. Null where it never moves. */
  motion: ComposeOverlayMotion | null;
  /** The part of the bitmap the quad is of: see [SurfacePlacement.cut]. */
  cut: SurfacePlacement['cut'];
  /** The bitmap's size on the wire: its cut part's, for a photo cut to the surface. */
  wPx: number;
  hPx: number;
}

/**
 * A layer on a surface over its wire `window`: its quad one key a post frame - the window's two ends
 * included, coarser where a long one would pass [MAX_OVERLAY_QUAD_KEYS], a key that only repeats both its
 * neighbours left out - and the motion an engine without quads draws instead. Null for a layer not on a
 * surface, or whose footage is gone. `bitmap` is its bitmap's size, which its rectangle is measured by.
 *
 * The keys are STRICTLY in time order, as every parser checks, and never a quad an engine would draw nothing
 * for: one that comes out folded, or with three corners in a line - a surface tilted edge on - holds the last
 * good quad instead, and the first good one stands in for any before it. Null where there is no good one.
 */
export function compileOverlayQuad(
  overlay: EditOverlay,
  scene: TrackScene,
  window: { startMs: number; endMs: number },
  bitmap: { wPx: number; hPx: number },
  options: { cut?: boolean; fps?: number; maxKeys?: number } = {},
): SurfaceQuad | null {
  const on = surfaceOf(scene.manifest, overlay);
  const placed = on ? surfacePlacement(overlay, scene, bitmap, options.cut ?? true) : null;
  const span = window.endMs - window.startMs;
  if (!on || !placed || !(span > 0)) return null;
  let step = 1000 / Math.max(1, Math.min(120, options.fps ?? (scene.manifest.output.fps || 30)));
  const maxKeys = options.maxKeys ?? MAX_OVERLAY_QUAD_KEYS;
  while (span / step + 2 > maxKeys && step < span) step *= 2;
  const times = [window.startMs];
  for (let t = Math.floor(window.startMs / step + 1) * step; t < window.endMs - 0.5; t += step) times.push(t);
  times.push(window.endMs);
  const output = scene.manifest.output;
  const atMs: number[] = [];
  const corners: number[] = [];
  let good: number[] | null = null;
  let waiting = 0;
  for (const t of times) {
    const at = surfaceQuadAt(on.track, placed.plane, scene, t);
    const ms = roundTo(t, 3);
    if (!at || (atMs.length > 0 && !(ms > atMs[atMs.length - 1]!))) continue;
    const rounded = at.corners.map(v => roundTo(v, 5));
    if (drawable(rounded, output)) {
      // The keys before the first good one stand in for it.
      if (!good) for (let k = 0; k < waiting; k++) corners.push(...rounded);
      good = rounded;
    } else if (!good) {
      atMs.push(ms);
      waiting++;
      continue;
    }
    atMs.push(ms);
    corners.push(...good);
  }
  if (!good || atMs.length === 0) return null;
  const quad = withoutHeldKeys({ atMs, corners });
  const wPx = placed.cut ? Math.max(1, Math.round(bitmap.wPx * placed.cut.w)) : bitmap.wPx;
  const hPx = placed.cut ? Math.max(1, Math.round(bitmap.hPx * placed.cut.h)) : bitmap.hPx;
  const animation = compileOverlayMotion(window, overlay.animation, overlay.kind);
  // The fit read at fewer and fewer of the quad's keys until it fits with the animation's under the cap.
  let motion: ComposeOverlayMotion | null = null;
  for (let every = 1; ; every *= 2) {
    motion = combineMotions(fittedMotion(quad, overlay, scene.manifest.output, wPx, hPx, every), animation);
    if (!motion || motion.atMs.length <= MAX_OVERLAY_MOTION_KEYS) break;
    if (every >= quad.atMs.length) {
      motion = animation;
      break;
    }
  }
  return { quad, motion, cut: placed.cut, wPx, hPx };
}

/** Whether an engine draws the quad `c` (fractions of `output`): convex, no three corners in a line, more than a speck. */
function drawable(c: readonly number[], output: Pick<EditOutput, 'width' | 'height'>): boolean {
  const px = c.map((v, k) => v * (k % 2 === 0 ? output.width : output.height));
  return isConvexQuad(px) && Math.abs(quadArea(px)) >= 1;
}

/** The keys with every one that only repeats both its neighbours taken out: the wire reads the same lines. */
function withoutHeldKeys(quad: ComposeOverlayQuad): ComposeOverlayQuad {
  const n = quad.atMs.length;
  if (n <= 2) return quad;
  const same = (i: number, j: number) => {
    for (let k = 0; k < 8; k++) if (quad.corners[8 * i + k] !== quad.corners[8 * j + k]) return false;
    return true;
  };
  const keep = [0];
  for (let i = 1; i < n - 1; i++) if (!(same(i, i - 1) && same(i, i + 1))) keep.push(i);
  keep.push(n - 1);
  if (keep.length === n) return quad;
  return { atMs: keep.map(i => quad.atMs[i]!), corners: keep.flatMap(i => quad.corners.slice(8 * i, 8 * i + 8)) };
}

/**
 * Where a bitmap `wPx` by `hPx` best stands in for the quad at key `i`, in least squares: the middle of the
 * quad (fractions of the frame), the size against the bitmap's and the clockwise turn (Umeyama's similarity,
 * no reflection).
 */
export function bestFit(corners: ArrayLike<number>, i: number, output: Pick<EditOutput, 'width' | 'height'>, wPx: number, hPx: number): { cx: number; cy: number; scale: number; turn: number } {
  const W = output.width;
  const H = output.height;
  let mx = 0;
  let my = 0;
  for (let k = 0; k < 4; k++) {
    mx += corners[8 * i + 2 * k]! * W;
    my += corners[8 * i + 2 * k + 1]! * H;
  }
  mx /= 4;
  my /= 4;
  const px = [-wPx / 2, wPx / 2, wPx / 2, -wPx / 2];
  const py = [-hPx / 2, -hPx / 2, hPx / 2, hPx / 2];
  let a = 0;
  let b = 0;
  for (let k = 0; k < 4; k++) {
    const qx = corners[8 * i + 2 * k]! * W - mx;
    const qy = corners[8 * i + 2 * k + 1]! * H - my;
    a += px[k]! * qx + py[k]! * qy;
    b += px[k]! * qy - py[k]! * qx;
  }
  const size = wPx * wPx + hPx * hPx;
  return { cx: mx / W, cy: my / H, scale: size > 0 ? Math.hypot(a, b) / size : 1, turn: (Math.atan2(b, a) * 180) / Math.PI };
}

/** The quad's best fit at every `every`th key (and its last) as motion keys against the layer's own centre and angle; null where it never moves. */
function fittedMotion(quad: ComposeOverlayQuad, overlay: EditOverlay, output: Pick<EditOutput, 'width' | 'height'>, wPx: number, hPx: number, every: number): ComposeOverlayMotion | null {
  const n = quad.atMs.length;
  const motion = { atMs: [] as number[], x: [] as number[], y: [] as number[], scale: [] as number[], rotation: [] as number[] };
  let last = 0;
  for (let i = 0; i < n; i = i === n - 1 ? n : Math.min(n - 1, i + every)) {
    const fit = bestFit(quad.corners, i, output, wPx, hPx);
    let turn = fit.turn - overlay.rotationDeg;
    // Unwrapped against the key before, so a turn through half round is not a spin the other way.
    if (motion.atMs.length > 0) {
      while (turn - last > 180) turn -= 360;
      while (turn - last < -180) turn += 360;
    }
    last = turn;
    motion.atMs.push(quad.atMs[i]!);
    motion.x.push(roundTo(fit.cx - overlay.cx, 5));
    motion.y.push(roundTo(fit.cy - overlay.cy, 5));
    motion.scale.push(roundTo(fit.scale, 4));
    motion.rotation.push(roundTo(turn, 2));
  }
  const still =
    motion.x.every(v => Math.abs(v) < 1e-6) && motion.y.every(v => Math.abs(v) < 1e-6) && motion.scale.every(v => Math.abs(v - 1) < 1e-6) && motion.rotation.every(v => Math.abs(v) < 1e-6);
  return still ? null : motion;
}

/**
 * A layer's quad at output time `ms`, read exactly as [ComposeOverlayQuad] states and as a motion is read:
 * the end keys held, each corner in a straight line between the keys either side. Null for no quad. The ONE
 * reading of the quad: the web render and the preview both call it, and draw nothing for one that is not
 * convex ([isConvexQuad]).
 */
export function quadAt(quad: ComposeOverlayQuad | null | undefined, ms: number): number[] | null {
  const at = quad?.atMs;
  const n = at?.length ?? 0;
  if (!quad || !at || n === 0 || quad.corners.length < 8 * n) return null;
  const c = quad.corners;
  const read = (i: number) => c.slice(8 * i, 8 * i + 8);
  if (!(ms > at[0]!)) {
    let i = 0;
    while (i + 1 < n && at[i + 1]! <= ms) i++;
    return read(i);
  }
  if (ms >= at[n - 1]!) return read(n - 1);
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid]! <= ms) lo = mid;
    else hi = mid;
  }
  const span = at[lo + 1]! - at[lo]!;
  const f = span > 0 ? (ms - at[lo]!) / span : 1;
  const out = new Array<number>(8);
  for (let k = 0; k < 8; k++) out[k] = c[8 * lo + k]! + (c[8 * (lo + 1) + k]! - c[8 * lo + k]!) * f;
  return out;
}

/**
 * A quad off the wire, or null for none: keys STRICTLY in time order, 1 to [MAX_OVERLAY_QUAD_KEYS] of them,
 * eight finite corners each, held to -4..4 of the frame. Anything else is no quad, and the layer is drawn by
 * its motion as a build without quads draws it.
 */
export function normaliseOverlayQuad(value: unknown): ComposeOverlayQuad | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const atMs = (value as Record<string, unknown>)['atMs'];
  const corners = (value as Record<string, unknown>)['corners'];
  if (!Array.isArray(atMs) || !Array.isArray(corners)) return null;
  const n = atMs.length;
  if (n === 0 || n > MAX_OVERLAY_QUAD_KEYS || corners.length !== 8 * n) return null;
  let last = -Infinity;
  for (const t of atMs) {
    if (typeof t !== 'number' || !Number.isFinite(t) || !(t > last)) return null;
    last = t;
  }
  if (!corners.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
  return { atMs: atMs.slice(), corners: (corners as number[]).map(v => Math.min(4, Math.max(-4, v))) };
}

/** The patch that pins `overlay` onto `track`'s surface exactly where it is drawn at `outputMs` ([followPatch]), drawn on the surface from there. */
export function surfaceFollowPatch(overlay: EditOverlay, track: EditTrack, scene: TrackScene, outputMs: number): Partial<EditOverlay> | null {
  if (!isSurfaceTrack(track)) return null;
  const patch = followPatch(overlay, track, scene, outputMs, { scaleWith: true, turnWith: true });
  return patch?.follow ? { ...patch, follow: { ...patch.follow, scaleWith: true, turnWith: true, onSurface: true } } : null;
}

/**
 * The patch that puts `overlay` ON `track`'s surface at output instant `outputMs` and pins it there: a photo
 * filling the surface, cut to its shape; a text or a sticker in its middle, as big against the surface as it is
 * against the frame at its own size - and, with its `bitmap` known, no bigger than most of the surface. Null
 * for an effect, a track that is no surface, and a surface not on screen then.
 */
export function placeOnSurface(overlay: EditOverlay, track: EditTrack, scene: TrackScene, outputMs: number, bitmap: { wPx: number; hPx: number } | null = null): Partial<EditOverlay> | null {
  if (overlay.kind === 'effect' || !isSurfaceTrack(track)) return null;
  const footage = trackedFootage(track, scene, outputMs);
  if (!footage) return null;
  const pinMs = Math.round(footage.sourceMs);
  const frame = standIn(track, pinMs);
  if (!frame) return null;
  const here = pathAt(trackPath(track), pinMs);
  const drawn = drawnBy(footage.map, track.aspect, here.x, here.y);
  const output = scene.manifest.output;
  if (!(drawn.scale > 0) || !(output.width > 0)) return null;
  const across = frame.w * drawn.scale;
  const down = frame.h * drawn.scale;
  let size: number;
  if (overlay.kind === 'image') {
    // As wide as the surface once cut to its shape: the photo whole is wider by what the cut takes off.
    const own = overlay.aspect > 0 && Number.isFinite(overlay.aspect) ? overlay.aspect : 1;
    const kept = Math.min(1, surfaceAspect(track) / own);
    size = across / (output.width * OVERLAY_BASE.image * kept);
  } else {
    size = overlay.scale * (across / output.width);
    if (bitmap && bitmap.wPx > 0 && bitmap.hPx > 0 && overlay.scale > 0) {
      const w = (bitmap.wPx * size) / overlay.scale;
      const h = (bitmap.hPx * size) / overlay.scale;
      size *= Math.min(1, (NATURAL_FILL * across) / w, (NATURAL_FILL * down) / h);
    }
  }
  if (!(size > 0) || !Number.isFinite(size)) return null;
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, size));
  const grow = roundTo(size / scale, 6);
  const at = footage.map.toOutput(here.x, here.y);
  const pin: OverlayFollow['pin'] = { atMs: pinMs, dx: 0, dy: 0 };
  if (grow !== 1) pin.grow = grow;
  return {
    cx: at.x / output.width,
    cy: at.y / output.height,
    scale,
    rotationDeg: roundTo(frame.angle + drawn.turn, 4),
    follow: { trackId: track.id, pin, scaleWith: true, turnWith: true, onSurface: true },
  };
}

function roundTo(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f + 0;
}
