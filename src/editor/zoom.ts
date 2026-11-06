import { MAX_CAMERA_KEYS, MAX_CAMERA_SCALE, type ComposeCamera } from '../video-composer/definitions';
import { clampView, IDENTITY_VIEW, type CameraView } from './camera';
import {
  MAX_ZOOM_SCALE,
  ZOOM_CHAIN_GAP_MS,
  clamp,
  zoomWindow,
  type EditClip,
  type EditManifest,
  type EditOutput,
  type EditTrack,
  type EditZoom,
  type ZoomEase,
  type ZoomFraming,
} from './edit-manifest';
import { pathAt, trackPath, type TrackPath } from './overlay-track';
import { trackedFootage, type Footage, type TrackScene } from './track-motion';

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
  /**
   * The ramps actually run: `rampMs` and `rampOutMs` (or `rampMs` again), squeezed IN PROPORTION when
   * the two do not fit the window, so a push-in stays a push-in however short its clip is cut.
   */
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
 * Two neighbours are chained when the gap between them is under [ZOOM_CHAIN_GAP_MS], the first lets
 * go of its after side and the second of its before side ([EditZoom.chain]: `false` keeps both sides,
 * `'in'` the after side, `'out'` the before side). Either one keeping its side is enough: a pan has
 * two ends, and a zoom kept apart from the one before it must not be dragged into it by that one's
 * wish to pan.
 *
 * Sorted and de-overlapped again here although a normalised manifest already is: a hand-built list
 * straight from a host must not make the camera two functions of time.
 */
export function zoomSlots(zooms: readonly EditZoom[], totalMs: number): ZoomSlot[] {
  const sorted = [...zooms].sort((a, b) => a.startMs - b.startMs);
  const slots: ZoomSlot[] = [];
  /** Whether each zoom will pan from the one before it, and on to the one after it. */
  const sides: { before: boolean; after: boolean }[] = [];
  for (const zoom of sorted) {
    const window = zoomWindow(zoom, totalMs);
    if (!window) continue;
    const prev = slots[slots.length - 1];
    const startMs = prev ? Math.max(window.startMs, prev.endMs) : window.startMs;
    const endMs = window.endMs;
    if (!(endMs > startMs)) continue;
    const [rampInMs, rampOutMs] = squeezedRamps(zoom, endMs - startMs);
    slots.push({ id: zoom.id, startMs, endMs, rampInMs, rampOutMs, chainedIn: false, chainedOut: false });
    sides.push({ before: zoom.chain !== false && zoom.chain !== 'out', after: zoom.chain !== false && zoom.chain !== 'in' });
  }
  for (let i = 1; i < slots.length; i++) {
    if (sides[i - 1].after && sides[i].before && slots[i].startMs - slots[i - 1].endMs < ZOOM_CHAIN_GAP_MS) {
      slots[i - 1].chainedOut = true;
      slots[i].chainedIn = true;
    }
  }
  return slots;
}

/**
 * A zoom's two ramps held inside a window `windowMs` long: as asked when they fit, and both scaled by
 * the same factor when they do not. In proportion rather than each held to half the window, which is
 * what a zoom with two equal ramps has always got and still gets: a push-in asking for the whole
 * window in and nothing out keeps the whole window, where halving would have stopped it half way.
 */
function squeezedRamps(zoom: EditZoom, windowMs: number): [number, number] {
  const rampIn = rampOf(zoom.rampMs, 0);
  const rampOut = rampOf(zoom.rampOutMs, rampIn);
  const both = rampIn + rampOut;
  if (!(both > windowMs)) return [rampIn, rampOut];
  const k = Math.max(0, windowMs) / both;
  return [rampIn * k, rampOut * k];
}

/** A stored ramp, or `fallback` for none: a hand-built list may carry `null` or a string. */
function rampOf(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, value) : fallback;
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
 * Each zoom is a move in from the whole frame over its in-ramp, a hold on its area, and a move back
 * out over its out-ramp, all inside its window. A ramp of 0 is a STEP: two keys at one time, which the
 * wire reads as a cut - so a push-in with no ramp out holds its area to the end of its window and cuts
 * to the whole frame there, and a pull-out with no ramp in is on its area from its first frame. Two
 * zooms closer than [ZOOM_CHAIN_GAP_MS] are one PAN instead, from where the first starts leaving to
 * where the second has arrived, with the second zoom's ease - the camera never passes through the
 * whole frame between them - unless either is kept apart ([EditZoom.chain] `false`), when each keeps
 * its own ramps and two touching at 0 cut straight from one area to the other.
 *
 * A zoom that FOLLOWS a track ([EditZoom.follow]) makes the same three moves on an area that moves:
 * given `follow` - what the footage is drawn through - it has a key every frame of the post across
 * its window, from its path ([followPaths]), and its ramps blend the whole frame into the moving view
 * frame by frame. Without `follow`, or with its thing gone from the post, it holds its own area like
 * any other zoom, so a post with no zoom that follows compiles exactly as it always did.
 */
export function compileCamera(zooms: readonly EditZoom[], totalMs: number, follow?: CameraFollow | null): ComposeCamera | null {
  return compileCameraWith(zooms, totalMs, followPaths(zooms, totalMs, follow));
}

/**
 * [compileCamera] from the paths [followPaths] made, for a caller that reads them too and would
 * otherwise make them twice. No paths is [compileCamera] with no `follow`, byte for byte.
 */
export function compileCameraWith(zooms: readonly EditZoom[], totalMs: number, paths: ReadonlyMap<string, FollowPath>): ComposeCamera | null {
  const slots = zoomSlots(zooms, totalMs);
  if (slots.length === 0) return null;
  const byId = new Map(zooms.map(zoom => [zoom.id, zoom]));
  // One key a frame of MOVEMENT, and the moves never overlap, so a camera only passes
  // [MAX_CAMERA_KEYS] when more than five minutes of it is moving - a template's push-ins across a
  // very long post, or a hand-built list - or when a follow runs past eleven minutes at 30 fps, since
  // a follow keys every frame. This loop coarsens the sampling for those, a follow's frames with it.
  for (let step = SAMPLE_MS, coarse = 1; ; step *= 2, coarse *= 2) {
    const keys = compileKeys(slots, byId, step, paths, coarse);
    if (keys.length <= MAX_CAMERA_KEYS || step > 10_000) {
      const camera = toCamera(keys.slice(0, MAX_CAMERA_KEYS));
      // A follow that closes in on nothing - the whole shot of a picture that already fills the
      // frame - is the absent camera, as a parser would make it, not a frame's worth of keys saying so.
      // [isUntouched] still counts the zoom: that costs a re-encode of a picture nobody moved, and can
      // never post a raw file under a camera that moves.
      return paths.size > 0 && camera.scale.every(scale => scale === 1) ? null : camera;
    }
  }
}

/** What the camera shows for one zoom: its area, held, or the path of one that follows, read at each instant. */
interface Shot {
  path: FollowPath | null;
  at(ms: number): CameraView;
}

function compileKeys(slots: ZoomSlot[], byId: Map<string, EditZoom>, step: number, paths: ReadonlyMap<string, FollowPath>, coarse: number): Key[] {
  const keys: Key[] = [];
  const push = (t: number, view: CameraView) => {
    const last = keys[keys.length - 1];
    // Never back in time, which every parser refuses: two ramps squeezed in proportion meet at a
    // moment float arithmetic can put a hair either side of itself.
    const time = Math.max(last ? last.t : -Infinity, Math.round(t * 1000) / 1000);
    if (last && last.t === time && sameView(last.view, view)) return;
    keys.push({ t: time, view });
  };
  const move = (from: Shot, to: Shot, t0: number, t1: number, ease: ZoomEase) => {
    const moving = from.path ?? to.path;
    if (!moving) {
      const a = from.at(t0);
      const b = to.at(t1);
      push(t0, a);
      const span = t1 - t0;
      if (span > 0) {
        const n = Math.max(1, Math.ceil(span / step));
        for (let k = 1; k < n; k++) push(t0 + (span * k) / n, viewBetween(a, b, easeValue(ease, k / n)));
      }
      push(t1, b);
      return;
    }
    // Either end moving: a key every frame of the post, each the blend of where the two are THEN.
    push(t0, from.at(t0));
    const span = t1 - t0;
    if (span > 0) {
      for (const t of framesInside(t0, t1, moving.stepMs * coarse)) push(t, viewBetween(from.at(t), to.at(t), easeValue(ease, (t - t0) / span)));
    }
    push(t1, to.at(t1));
  };
  const shotOf = (slot: ZoomSlot): Shot => {
    const path = paths.get(slot.id);
    if (path) return { path, at: ms => followViewAt(path, ms) };
    const zoom = byId.get(slot.id)!;
    const area = clampView({ scale: zoom.scale, cx: zoom.cx, cy: zoom.cy });
    return { path: null, at: () => area };
  };
  const whole: CameraView = { ...IDENTITY_VIEW };
  const identity: Shot = { path: null, at: () => whole };

  slots.forEach((slot, i) => {
    const zoom = byId.get(slot.id)!;
    const shot = shotOf(slot);
    if (!slot.chainedIn) move(identity, shot, slot.startMs, slot.startMs + slot.rampInMs, zoom.ease);
    // An area's hold needs no keys of its own: the key the move in ended on and the key the move out
    // starts from are both the area, and the wire interpolates a straight line between them. A
    // path's hold is a key every frame of the post between those two.
    const leaveAt = slot.endMs - slot.rampOutMs;
    if (shot.path) for (const t of framesInside(slot.startMs + slot.rampInMs, leaveAt, shot.path.stepMs * coarse)) push(t, shot.at(t));
    if (!slot.chainedOut) {
      move(shot, identity, leaveAt, slot.endMs, zoom.ease);
      return;
    }
    const next = slots[i + 1];
    const nextZoom = byId.get(next.id)!;
    const nextShot = shotOf(next);
    const arriveAt = next.startMs + next.rampInMs;
    if (slot.rampOutMs + next.rampInMs === 0) {
      // Both asked for a cut: hold this area through the gap and cut straight to the next one where
      // it starts, rather than inventing a slow pan across the gap that nobody asked for.
      push(leaveAt, shot.at(leaveAt));
      move(shot, nextShot, next.startMs, next.startMs, nextZoom.ease);
    } else {
      move(shot, nextShot, leaveAt, arriveAt, nextZoom.ease);
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

/* -------------------------------------------------------------------------------------------- */
/* Following a track                                                                              */
/* -------------------------------------------------------------------------------------------- */

/*
 * A following zoom aims where its thing is on the UNZOOMED frame - the track's path through the
 * footage's own placement ([trackedFootage]) with no camera at all, since a target read through the
 * camera being made would chase its own tail - and moves there the way a camera operator does: late
 * by a moment, leaning a little into where the thing is going, never past where it stops. The view is
 * then held inside the PICTURE of the clip the thing is in, not only inside the frame, so a wide shot
 * contained in a tall post is panned across with no bar ever on screen.
 *
 * Every engine samples the source through the camera, so the closer view stays sharp. A covered clip
 * has lost its sides before the camera sees it: reframing one wants its fit `contain`, which is the
 * store's to set when following starts.
 */

/**
 * What a following zoom ([EditZoom.follow]) is compiled against: the post's footage, its tracks and
 * how its clips are laid out. A [TrackScene] without the camera, which is what is being made.
 */
export type CameraFollow = Omit<TrackScene, 'camera'>;

/**
 * Where a following zoom's camera looks across its window as it plays, before either ramp blends it
 * with the whole frame: a view every frame of the post, on the post's frame clock, the window's two
 * ends included.
 */
export interface FollowPath {
  /** One frame of the post, in ms: the views are at its multiples. */
  stepMs: number;
  /** Output ms, increasing. */
  atMs: number[];
  views: CameraView[];
}

const NO_PATHS: ReadonlyMap<string, FollowPath> = new Map();

/**
 * How far behind a steadily moving thing the camera would trail with no lead: an operator's lag,
 * which is what makes the move read as a person's rather than as a crosshair stuck to the thing.
 */
const FOLLOW_LAG_MS = 350;

/** How far ahead along its path the camera aims: a little, so it eases into a move and still never overshoots the stop. */
const FOLLOW_LEAD_MS = 150;

/**
 * The level's own lag, twice the pan's: the thing's size wobbles with the tracker from frame to
 * frame, and a picture that breathes with it is the first thing anybody would notice.
 */
const FOLLOW_ZOOM_LAG_MS = 700;

/** How much of the frame's height the thing's box is given by the two framings that close in on it. */
const FRAMING_HEIGHT: Readonly<Record<Exclude<ZoomFraming, 'fill'>, number>> = { mid: 0.45, close: 0.7 };

/** The most of the frame's width the box is given by either, so a wide thing keeps both its ends. */
const FRAMING_WIDTH = 0.9;

/** A picture this close to filling the frame fills it: what is left of its bars is under a pixel. */
const FILLS_FRAME = 1e-3;

/** A rectangle on the unzoomed frame, 0..1 of it, top-left origin. */
interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const WHOLE_FRAME: Box = { x: 0, y: 0, w: 1, h: 1 };

/** The track zoom `zoom` follows, or null for one that follows nothing or a track the post does not have. */
export function zoomTrack(zoom: Pick<EditZoom, 'follow'>, manifest: Pick<EditManifest, 'tracks'>): EditTrack | null {
  const follow = zoom.follow;
  return (follow && manifest.tracks?.find(track => track.id === follow.trackId)) || null;
}

/**
 * Every following zoom's path among `zooms`, by id, over its window as it plays ([zoomSlots]). Empty
 * with no `follow`, or with no zoom following a track whose footage is on the post - and then
 * [compileCameraWith] is the camera this package has always compiled.
 */
export function followPaths(zooms: readonly EditZoom[], totalMs: number, follow: CameraFollow | null | undefined): ReadonlyMap<string, FollowPath> {
  if (!follow || !zooms.some(zoom => zoom.follow)) return NO_PATHS;
  const byId = new Map(zooms.map(zoom => [zoom.id, zoom]));
  const out = new Map<string, FollowPath>();
  for (const slot of zoomSlots(zooms, totalMs)) {
    const zoom = byId.get(slot.id);
    const path = zoom?.follow ? followPathOver(zoom, follow, slot.startMs, slot.endMs) : null;
    if (path) out.set(slot.id, path);
  }
  return out.size > 0 ? out : NO_PATHS;
}

/** The path [followPaths] makes for `zoom` among `zooms`, or null: one zoom's, for what reads only that one. */
export function followPath(zoom: EditZoom, zooms: readonly EditZoom[], totalMs: number, follow: CameraFollow): FollowPath | null {
  if (!zoom.follow) return null;
  const slot = zoomSlots(zooms, totalMs).find(one => one.id === zoom.id);
  return slot ? followPathOver(zoom, follow, slot.startMs, slot.endMs) : null;
}

/** A path's view at output ms `ms`: a straight line between the frames either side, the ends held outside it. */
export function followViewAt(path: FollowPath, ms: number): CameraView {
  const at = path.atMs;
  const n = at.length;
  if (!(ms > at[0])) return path.views[0];
  if (ms >= at[n - 1]) return path.views[n - 1];
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (at[mid] <= ms) lo = mid;
    else hi = mid;
  }
  const f = (ms - at[lo]) / (at[hi] - at[lo]);
  const a = path.views[lo];
  const b = path.views[hi];
  return { scale: a.scale + (b.scale - a.scale) * f, cx: a.cx + (b.cx - a.cx) * f, cy: a.cy + (b.cy - a.cy) * f };
}

/**
 * The still view a following zoom stores for where it cannot follow ([EditZoom.follow]): its path's
 * views averaged as rectangles, centre and width, which lands on the picture wherever every view of
 * the path was, the views that fit inside one rectangle being a convex set.
 */
export function followRest(path: FollowPath): CameraView {
  let width = 0;
  let cx = 0;
  let cy = 0;
  for (const view of path.views) {
    width += 1 / view.scale;
    cx += view.cx;
    cy += view.cy;
  }
  const n = path.views.length;
  return clampView({ scale: n / width, cx: cx / n, cy: cy / n });
}

/**
 * Whether segment `clip`, playing `track`'s footage, is a picture of another shape from the rectangle
 * it is drawn in - letterboxed by `contain`, or cut down by `cover` - so that following its thing is
 * REFRAMING the shot (`fill`, over the whole of a contained picture) rather than closing in on a frame
 * it already fills. Measured as the fit measures it: the cropped picture against the upright
 * rectangle, within the half a percent an encoder's rounded width is allowed everywhere else.
 */
export function followReframes(clip: Pick<EditClip, 'crop' | 'rect'>, track: Pick<EditTrack, 'aspect'>, output: Pick<EditOutput, 'width' | 'height'>): boolean {
  const crop = clip.crop;
  const picture = track.aspect * (crop && crop.w > 0 && crop.h > 0 ? crop.w / crop.h : 1);
  const rect = clip.rect;
  const frame = (output.width / output.height) * (rect && rect.w > 0 && rect.h > 0 ? rect.w / rect.h : 1);
  return picture > 0 && frame > 0 && Math.abs(picture - frame) > frame * 0.005;
}

/**
 * Where zoom `zoom` looks from `startMs` to `endMs`, a frame of the post at a time, or null when it
 * follows nothing the post still shows. Each frame aims at the thing [FOLLOW_LEAD_MS] ahead, eases
 * there through a [Follower], and is held inside the picture of the clip the thing is in at that
 * frame, with a level of at least the one that fills the frame with that picture.
 */
function followPathOver(zoom: EditZoom, follow: CameraFollow, startMs: number, endMs: number): FollowPath | null {
  const track = zoomTrack(zoom, follow.manifest);
  const framing = zoom.follow?.framing;
  if (!track || !framing || !(endMs > startMs)) return null;
  const scene: TrackScene = { ...follow, camera: null };
  if (!trackedFootage(track, scene, startMs)) return null;
  const output = follow.manifest.output;
  const stepMs = frameStep(output.fps);
  const path = trackPath(track);
  const atMs = [startMs, ...framesInside(startMs, endMs, stepMs), endMs];
  const views: CameraView[] = [];
  let pan: { x: Follower; y: Follower } | null = null;
  let level: Follower | null = null;
  let last = startMs;
  for (const t of atMs) {
    const now = trackedFootage(track, scene, t);
    const ahead = trackedFootage(track, scene, t + FOLLOW_LEAD_MS);
    if (!now || !ahead) return null;
    const picture = pictureOf(now, output);
    const fill = fillScale(picture);
    const thing = thingOf(ahead, track, path, output);
    const dt = t - last;
    last = t;
    pan ??= { x: new Follower(thing.cx, FOLLOW_LAG_MS), y: new Follower(thing.cy, FOLLOW_LAG_MS) };
    const cx = pan.x.to(thing.cx, dt);
    const cy = pan.y.to(thing.cy, dt);
    let scale = fill;
    if (framing !== 'fill') {
      // Eased as a magnification, so a push from 2x to 4x takes as long as one from 1x to 2x.
      const wanted = Math.log(framingScale(framing, thing, fill));
      level ??= new Follower(wanted, FOLLOW_ZOOM_LAG_MS);
      scale = Math.min(MAX_CAMERA_SCALE, Math.max(fill, Math.exp(level.to(wanted, dt))));
    }
    views.push(heldInside({ scale, cx, cy }, picture));
  }
  return { stepMs, atMs, views };
}

/** One frame of a post at `fps`, in ms: [compileTrackMotion]'s clock, so a follow's keys and a pinned layer's land on the same frames. */
function frameStep(fps: number): number {
  return 1000 / Math.max(1, Math.min(120, fps || 30));
}

/**
 * The frames of the post's clock - the multiples of `step` - strictly inside `fromMs..toMs`, leaving
 * out any within half a millisecond of either end, which the ends' own keys stand for.
 */
function framesInside(fromMs: number, toMs: number, step: number): number[] {
  const out: number[] = [];
  for (let k = Math.floor(fromMs / step) + 1; k * step < toMs - 0.5; k++) if (k * step > fromMs + 0.5) out.push(k * step);
  return out;
}

/**
 * The part of the unzoomed frame `footage` draws its picture on: its kept source mapped onto the
 * frame, cut to the rectangle it is drawn in and to the frame. A letterboxed clip's picture is the
 * band between its bars, a covered one's its whole rectangle. A turned picture is taken by its
 * bounding box, as near as an upright camera can hold to it. The whole frame when none of it is on it.
 */
function pictureOf(footage: Footage, output: Pick<EditOutput, 'width' | 'height'>): Box {
  const map = footage.map;
  const crop = footage.clip.crop;
  const u0 = clamp(crop ? crop.x : 0, 0, 1);
  const v0 = clamp(crop ? crop.y : 0, 0, 1);
  const u1 = clamp(crop ? crop.x + crop.w : 1, 0, 1);
  const v1 = clamp(crop ? crop.y + crop.h : 1, 0, 1);
  const drawn = boundsOf([map.toOutput(u0, v0), map.toOutput(u1, v0), map.toOutput(u1, v1), map.toOutput(u0, v1)]);
  const cut = boundsOf(map.outline());
  const x0 = Math.max(drawn.x0, cut.x0, 0) / output.width;
  const y0 = Math.max(drawn.y0, cut.y0, 0) / output.height;
  const x1 = Math.min(drawn.x1, cut.x1, output.width) / output.width;
  const y1 = Math.min(drawn.y1, cut.y1, output.height) / output.height;
  return x1 - x0 > 1e-6 && y1 - y0 > 1e-6 ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } : WHOLE_FRAME;
}

/** Where the thing is drawn on the unzoomed frame in `footage`: its middle, and its box's width and height there, 0..1 of the frame. */
function thingOf(footage: Footage, track: Pick<EditTrack, 'box'>, path: TrackPath, output: Pick<EditOutput, 'width' | 'height'>): { cx: number; cy: number; w: number; h: number } {
  const here = pathAt(path, footage.sourceMs);
  const map = footage.map;
  const middle = map.toOutput(here.x, here.y);
  const hw = (track.box.w * here.scale) / 2;
  const hh = (track.box.h * here.scale) / 2;
  const box = boundsOf([
    map.toOutput(here.x - hw, here.y - hh),
    map.toOutput(here.x + hw, here.y - hh),
    map.toOutput(here.x + hw, here.y + hh),
    map.toOutput(here.x - hw, here.y + hh),
  ]);
  return { cx: middle.x / output.width, cy: middle.y / output.height, w: (box.x1 - box.x0) / output.width, h: (box.y1 - box.y0) / output.height };
}

function boundsOf(points: readonly { x: number; y: number }[]): { x0: number; y0: number; x1: number; y1: number } {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const p of points) {
    x0 = Math.min(x0, p.x);
    y0 = Math.min(y0, p.y);
    x1 = Math.max(x1, p.x);
    y1 = Math.max(y1, p.y);
  }
  return { x0, y0, x1, y1 };
}

/**
 * The least level whose view fits inside `picture`: 1 for a picture that fills the frame, and 256/81
 * for a 16:9 one contained in a 9:16 post, whose picture is the whole width at 81/256 of the height.
 */
function fillScale(picture: Box): number {
  const scale = Math.max(1 / picture.w, 1 / picture.h);
  return scale <= 1 + FILLS_FRAME ? 1 : Math.min(MAX_CAMERA_SCALE, scale);
}

/** The level a framing closing in on the thing asks for: its box's share of the frame, never wider than `fill` or closer than [MAX_ZOOM_SCALE]. */
function framingScale(framing: Exclude<ZoomFraming, 'fill'>, thing: { w: number; h: number }, fill: number): number {
  const byHeight = thing.h > 0 ? FRAMING_HEIGHT[framing] / thing.h : Infinity;
  const byWidth = thing.w > 0 ? FRAMING_WIDTH / thing.w : Infinity;
  const wanted = Math.min(byHeight, byWidth);
  return Math.max(fill, Number.isFinite(wanted) ? Math.min(MAX_ZOOM_SCALE, wanted) : fill);
}

/**
 * `view` held INSIDE `picture`, so no bar shows: each centre kept half the view from the picture's
 * edges, or on the picture's middle where the view is the wider of the two (its level is never under
 * [fillScale], so that is float dust, or a picture past the camera's reach). Then [clampView], the
 * frame's own rule.
 */
function heldInside(view: CameraView, picture: Box): CameraView {
  const half = 0.5 / view.scale;
  const cx = picture.w > 2 * half ? clamp(view.cx, picture.x + half, picture.x + picture.w - half) : picture.x + picture.w / 2;
  const cy = picture.h > 2 * half ? clamp(view.cy, picture.y + half, picture.y + picture.h - half) : picture.y + picture.h / 2;
  return clampView({ scale: view.scale, cx, cy });
}

/**
 * A critically damped follower, `x'' = w^2 (target - x) - 2w x'`, stepped EXACTLY over each frame with
 * the target held at that frame's value, so the move is the same at any frame rate and any step.
 * Critically damped is the operator's move: it starts gently, trails a steady move by `lagMs`, and
 * never overshoots a thing that stops - every value it takes is a weighting of the targets it was
 * given, and its first is the first of them.
 */
class Follower {
  private x: number;
  private v = 0;
  private readonly w: number;

  constructor(x: number, lagMs: number) {
    this.x = x;
    this.w = 2 / lagMs;
  }

  to(target: number, dtMs: number): number {
    if (dtMs > 0) {
      const e = this.x - target;
      const c = this.v + this.w * e;
      const k = Math.exp(-this.w * dtMs);
      this.x = target + (e + c * dtMs) * k;
      this.v = (this.v - this.w * c * dtMs) * k;
    }
    return this.x;
  }
}
