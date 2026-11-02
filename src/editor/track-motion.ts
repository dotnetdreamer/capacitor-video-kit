import { MAX_OVERLAY_MOTION_KEYS, type ComposeCamera, type ComposeOverlayMotion } from '../video-composer/definitions';
import { FULL_FRAME, pictureDest } from '../video-composer/web/geometry';
import { LayerMap } from '../video-composer/web/layer-map';

import { cameraAt } from './camera';
import { MAX_SCALE, MIN_SCALE, type EditClip, type EditManifest, type EditOverlay, type EditTrack, type OverlayFollow } from './edit-manifest';
import { timelineSlots, type TimelineSlot } from './edit-ops';
import { layoutRectAt, type LayoutMotions } from './layout-motion';
import { compileOverlayMotion, overlayMotionAt } from './motion';
import { pathAt, pinAt, pinnedPoint, trackPath, type RunSamples } from './overlay-track';

/**
 * What following a track ([OverlayFollow] of an [EditTrack]) does to a layer on the post: where the layer
 * is at every instant, LOWERED to the same [ComposeOverlayMotion] keys an animation is, so the web, Android
 * and iOS render it with the arithmetic they already have and the preview reads the very keys the render
 * is handed. A track draws nothing itself; only what follows it moves.
 *
 * The path is in the footage's own terms, so placing the layer at an output instant means finding the
 * footage there and drawing the path's point the way the painter draws the footage itself: the clip's
 * trim and speed to the source instant, then its crop, fit, rectangle (moving, where an arrangement
 * opens), turn and the camera through [LayerMap], the painter's placement as arithmetic. The layer is
 * pinned to the footage, so a zoom into the clip carries the caption with the thing it names.
 *
 * Outside its own segment the footage is not on screen, and the layer holds where the segment's nearer
 * end left it - after the segment's transition tail, where one follows it: the outgoing clip plays on
 * under the next one's dissolve, and the layer goes on following it there.
 */

/** The parts of the post a track is drawn through. */
export interface TrackScene {
  manifest: Pick<EditManifest, 'clips' | 'videoTracks' | 'output' | 'fit' | 'tracks'>;
  /** The post's camera, compiled: `compileCamera(manifest.zooms, totalMs)`. */
  camera: ComposeCamera | null;
  /** Every clip's arrangement keys: `compileLayoutMotions(manifest)`. */
  layout: LayoutMotions;
}

/** The followed footage at one output instant: how its source is drawn, and which source instant it shows. */
export interface Footage {
  map: LayerMap;
  sourceMs: number;
  clip: EditClip;
  /** The instant the footage was read at: the one asked, held inside the segment's own time on screen. */
  outputMs: number;
}

/** One lane of video: the base track or one of the layers over it, and where its clips start. */
interface Lane {
  base: boolean;
  clips: EditClip[];
  startMs: number;
}

/** The lane the followed segment is on, or failing that the first one playing its source. */
function laneOf(manifest: Pick<EditManifest, 'clips' | 'videoTracks'>, track: Pick<EditTrack, 'clipId' | 'clipKey'>): Lane | null {
  const lanes: Lane[] = [{ base: true, clips: manifest.clips, startMs: 0 }, ...manifest.videoTracks.map(t => ({ base: false, clips: t.clips, startMs: t.startMs }))];
  return lanes.find(lane => lane.clips.some(clip => clip.id === track.clipId)) ?? lanes.find(lane => lane.clips.some(clip => clip.clipKey === track.clipKey)) ?? null;
}

/**
 * The source instant segment `slot` shows at lane instant `localMs`, its transition tail included: the
 * last of the clip, which plays on under the next one's transition after the segment's own slot is over.
 */
export function sourceMsThrough(slot: TimelineSlot, localMs: number): number {
  const clip = slot.clip;
  const into = Math.min(Math.max(localMs - slot.startMs, 0), Math.max(0, slot.durationMs) + slot.tailMs);
  return Math.min(clip.outMs, Math.max(clip.inMs, clip.inMs + into * (clip.speed || 1)));
}

/**
 * Where the followed footage is at output instant `outputMs`: the segment of its lane on screen then when
 * that segment plays the same source - a cut through a tracked clip leaves both halves showing the path -
 * and otherwise the followed segment itself, through its transition tail and then held at its nearer
 * end. Null when neither is on the post any more.
 */
export function trackedFootage(track: Pick<EditTrack, 'clipId' | 'clipKey' | 'aspect'>, scene: TrackScene, outputMs: number): Footage | null {
  const manifest = scene.manifest;
  const lane = laneOf(manifest, track);
  if (!lane) return null;
  const slots = timelineSlots({ clips: lane.clips });
  if (slots.length === 0) return null;
  const local = outputMs - lane.startMs;
  const last = slots[slots.length - 1]!;
  const end = last.startMs + last.durationMs;
  let slot: TimelineSlot | undefined = local >= 0 && local <= end ? (slots.find(s => local < s.startMs + s.durationMs) ?? last) : undefined;
  if (!slot || slot.clip.clipKey !== track.clipKey) slot = slots.find(s => s.clip.id === track.clipId) ?? slots.find(s => s.clip.clipKey === track.clipKey);
  if (!slot) return null;
  const into = Math.min(slot.startMs + Math.max(0, slot.durationMs) + slot.tailMs, Math.max(slot.startMs, local));
  const at = lane.startMs + into;
  const clip = slot.clip;

  // The painter's own geometry for the clip at that instant (`layerDraw` in the preview, the plan in a
  // render): a base clip is cut to its rectangle inside the whole frame, a layer drawn into it.
  const output = manifest.output;
  const sourceWidth = track.aspect * 1000;
  const sourceHeight = 1000;
  const rect = layoutRectAt(scene.layout, clip, at) ?? undefined;
  const fit = clip.fit ?? manifest.fit;
  const crop = clip.crop ?? undefined;
  const framing = lane.base ? { fit, crop, rect } : { fit, crop };
  const dest = lane.base ? FULL_FRAME : pictureDest(rect ?? FULL_FRAME, framing, output.width / output.height, sourceWidth, sourceHeight);
  const map = new LayerMap({ framing, dest, sourceWidth, sourceHeight, rotationDeg: rect?.rotationDeg ?? 0, camera: cameraAt(scene.camera, at) }, output);
  return { map, sourceMs: sourceMsThrough(slot, into), clip, outputMs: at };
}

/** One stretch of the post where a track's footage plays inside the track's span: output ms, and the SOURCE ms shown at either end. */
export interface TrackStretch {
  startMs: number;
  endMs: number;
  fromMs: number;
  toMs: number;
}

/**
 * Where a track's thing is on the post: one stretch per segment of its lane playing its source inside the
 * track's span, in time order - what the timeline draws a track's row over. A track of a picture (one
 * sample) is on for the whole of every segment showing the picture.
 */
export function trackStretches(track: Pick<EditTrack, 'clipId' | 'clipKey' | 'atMs'>, manifest: Pick<EditManifest, 'clips' | 'videoTracks'>): TrackStretch[] {
  const lane = laneOf(manifest, track);
  if (!lane || track.atMs.length === 0) return [];
  const first = track.atMs[0]!;
  const last = track.atMs[track.atMs.length - 1]!;
  const still = track.atMs.length === 1;
  const out: TrackStretch[] = [];
  for (const slot of timelineSlots({ clips: lane.clips })) {
    const clip = slot.clip;
    if (clip.clipKey !== track.clipKey) continue;
    const speed = clip.speed || 1;
    const fromMs = still ? clip.inMs : Math.max(clip.inMs, first);
    const toMs = still ? clip.outMs : Math.min(clip.outMs, last);
    if (!(toMs > fromMs)) continue;
    out.push({ startMs: lane.startMs + slot.startMs + (fromMs - clip.inMs) / speed, endMs: lane.startMs + slot.startMs + (toMs - clip.inMs) / speed, fromMs, toMs });
  }
  return out;
}

/** The output instant a stretch shows SOURCE instant `sourceMs` at. */
export function outputMsOf(stretch: TrackStretch, sourceMs: number): number {
  const span = stretch.toMs - stretch.fromMs;
  return span > 0 ? stretch.startMs + ((sourceMs - stretch.fromMs) * (stretch.endMs - stretch.startMs)) / span : stretch.startMs;
}

/** A tracked layer as it is drawn at one instant: its centre on the frame, its size and its angle. */
export interface TrackedPose {
  cx: number;
  cy: number;
  scale: number;
  rotationDeg: number;
}

/** The track a layer follows, and how: null for a layer that follows none, or one the post does not have. */
export function followedTrack(manifest: Pick<EditManifest, 'tracks'>, overlay: Pick<EditOverlay, 'follow'>): { track: EditTrack; follow: OverlayFollow } | null {
  const follow = overlay.follow;
  if (!follow) return null;
  const track = manifest.tracks?.find(t => t.id === follow.trackId);
  return track ? { track, follow } : null;
}

/** The track with id `trackId`, or null. */
export function trackById(manifest: Pick<EditManifest, 'tracks'>, trackId: string | null | undefined): EditTrack | null {
  return (trackId && manifest.tracks?.find(t => t.id === trackId)) || null;
}

/** The layers following track `trackId`, bottom to top. */
export function followersOf<T extends Pick<EditOverlay, 'follow'>>(overlays: readonly T[], trackId: string): T[] {
  return overlays.filter(overlay => overlay.follow?.trackId === trackId);
}

/**
 * Where a following layer is drawn at output instant `outputMs`, before its animation does anything: what
 * a selection box, a hit test and a drag take hold of. Null for a layer that follows nothing, and for one
 * whose footage is no longer on the post, which is drawn where it was put.
 */
export function trackedPoseAt(overlay: Pick<EditOverlay, 'follow' | 'scale' | 'rotationDeg'>, scene: TrackScene, outputMs: number): TrackedPose | null {
  const followed = followedTrack(scene.manifest, overlay);
  if (!followed) return null;
  const { track, follow } = followed;
  const footage = trackedFootage(track, scene, outputMs);
  if (!footage) return null;
  const point = pinnedPoint(track, follow, trackPath(track), footage.sourceMs);
  const out = footage.map.toOutput(point.x, point.y);
  const output = scene.manifest.output;
  return { cx: out.x / output.width, cy: out.y / output.height, scale: overlay.scale * point.scale, rotationDeg: overlay.rotationDeg + point.turn };
}

/**
 * The thing a track follows as it is drawn at output instant `outputMs`: its middle and its box's four
 * corners on the frame, 0..1 of it. What the Track sheet draws its box and path with.
 *
 * Turned with the thing only when `turned` - a layer that turns with it is being looked at. The tracker
 * reads a turn off how the points inside the box move round each other, and a thing that changes shape - a
 * flower opening, a person walking - moves them round as surely as one that turns, so its turn wanders
 * tens of degrees on footage where nothing turned. Left out, the box is never drawn askew for nothing.
 */
export function trackedThingAt(
  track: EditTrack,
  scene: TrackScene,
  outputMs: number,
  turned = false,
): { cx: number; cy: number; corners: { x: number; y: number }[]; sourceMs: number } | null {
  const footage = trackedFootage(track, scene, outputMs);
  if (!footage) return null;
  const here = pathAt(trackPath(track), footage.sourceMs);
  const output = scene.manifest.output;
  const toFrame = (u: number, v: number) => {
    const out = footage.map.toOutput(u, v);
    return { x: out.x / output.width, y: out.y / output.height };
  };
  const middle = toFrame(here.x, here.y);
  const rad = turned ? (here.turn * Math.PI) / 180 : 0;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  // Half the box in units of the source's height, turned there, and back into fractions.
  const hw = (track.box.w * here.scale * track.aspect) / 2;
  const hh = (track.box.h * here.scale) / 2;
  const corners = [
    [-hw, -hh],
    [hw, -hh],
    [hw, hh],
    [-hw, hh],
  ].map(([x, y]) => toFrame(here.x + (x! * cos - y! * sin) / track.aspect, here.y + x! * sin + y! * cos));
  return { cx: middle.x, cy: middle.y, corners, sourceMs: footage.sourceMs };
}

/** Channels rounded as they go on the wire: far below a pixel, a ten-thousandth of a size, a hundredth of a degree. */
function roundTo(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f + 0;
}

/**
 * A following layer's move over its window on the wire, `window`, as motion keys - one per frame of the
 * post's `fps`, the window's two ends included - or null for a layer that follows nothing, whose footage is
 * gone, or that the track never moves. Coarser where a long window would pass `maxKeys`.
 *
 * Offsets against the layer's own `cx`/`cy`, a size against its own `scale` and a turn added to its own
 * `rotationDeg`: the wire's meaning, so the layer is drawn by exactly the path every moving layer takes.
 */
export function compileTrackMotion(
  overlay: EditOverlay,
  scene: TrackScene,
  window: { startMs: number; endMs: number },
  fps = scene.manifest.output.fps,
  maxKeys = MAX_OVERLAY_MOTION_KEYS,
): ComposeOverlayMotion | null {
  const followed = followedTrack(scene.manifest, overlay);
  if (!followed || overlay.kind === 'effect') return null;
  if (!trackedFootage(followed.track, scene, window.startMs)) return null;
  const span = window.endMs - window.startMs;
  if (!(span > 0)) return null;
  let step = 1000 / Math.max(1, Math.min(120, fps || 30));
  while (span / step + 2 > maxKeys && step < span) step *= 2;
  // The frames of the post inside the window, aligned to the post's own frame clock, and both ends.
  const times = [window.startMs];
  for (let t = Math.floor(window.startMs / step + 1) * step; t < window.endMs - 0.5; t += step) times.push(t);
  times.push(window.endMs);
  const motion = trackKeysAt(overlay, scene, times);
  if (!motion) return null;
  const held = withoutHolds(motion);
  return isStill(held) ? null : held;
}

/** A following layer's keys at exactly the output instants `times`, in order; null where its footage is gone throughout. */
function trackKeysAt(overlay: EditOverlay, scene: TrackScene, times: readonly number[]): ComposeOverlayMotion | null {
  const followed = followedTrack(scene.manifest, overlay);
  if (!followed) return null;
  const { track, follow } = followed;
  const output = scene.manifest.output;
  const path = trackPath(track);
  const atMs: number[] = [];
  const x: number[] = [];
  const y: number[] = [];
  const scale: number[] = [];
  const rotation: number[] = [];
  for (const t of times) {
    const footage = trackedFootage(track, scene, t);
    if (!footage) continue;
    const point = pinnedPoint(track, follow, path, footage.sourceMs);
    const out = footage.map.toOutput(point.x, point.y);
    atMs.push(roundTo(t, 3));
    x.push(roundTo(out.x / output.width - overlay.cx, 5));
    y.push(roundTo(out.y / output.height - overlay.cy, 5));
    scale.push(roundTo(point.scale, 4));
    rotation.push(roundTo(point.turn, 2));
  }
  if (atMs.length === 0) return null;
  const motion: ComposeOverlayMotion = { atMs, x, y };
  if (follow.scaleWith || follow.pin.grow !== undefined) motion.scale = scale;
  if (follow.turnWith) motion.rotation = rotation;
  return motion;
}

/** The keys with every one that only repeats both its neighbours taken out: the wire reads the same line. */
function withoutHolds(motion: ComposeOverlayMotion): ComposeOverlayMotion {
  const channels = (['x', 'y', 'scale', 'rotation', 'opacity'] as const).filter(name => motion[name]);
  const n = motion.atMs.length;
  if (n <= 2) return motion;
  const keep: number[] = [0];
  const same = (i: number, j: number) => channels.every(name => motion[name]![i] === motion[name]![j]);
  for (let i = 1; i < n - 1; i++) if (!(same(i, i - 1) && same(i, i + 1))) keep.push(i);
  keep.push(n - 1);
  if (keep.length === n) return motion;
  const out: ComposeOverlayMotion = { atMs: keep.map(i => motion.atMs[i]!) };
  for (const name of channels) out[name] = keep.map(i => motion[name]![i]!);
  return out;
}

/** Whether every key leaves the layer exactly where it was put. */
function isStill(motion: ComposeOverlayMotion): boolean {
  const zero = (values?: number[]) => !values || values.every(v => Math.abs(v) < 1e-6);
  const one = (values?: number[]) => !values || values.every(v => Math.abs(v - 1) < 1e-6);
  return zero(motion.x) && zero(motion.y) && one(motion.scale) && zero(motion.rotation) && one(motion.opacity);
}

/**
 * How far from the line between the keys either side a key may be and still be left out, channel by
 * channel - x, y, size, turn, opacity: a tenth of a pixel on a 1080-wide frame, a ten-thousandth of a
 * size, a hundredth of a degree.
 */
const LINE_SLACK = [1e-4, 1e-4, 1e-4, 0.01, 1e-4] as const;

/** Half the wire's grain: both kinds of key are timed to a thousandth of a millisecond, so nearer than this is the same instant. */
const SAME_INSTANT_MS = 5e-4;

/** One key of a layer's whole motion: its five channels, and whether it is a track key the animation's keys may stand in for. */
interface MotionKey {
  t: number;
  v: [number, number, number, number, number];
  spare: boolean;
}

/**
 * A layer's track and its animation as ONE motion: the offsets added, the sizes multiplied, the turns
 * added, the animation's opacity kept. Every key of each is a key of the two, with the other read there -
 * except a track key with an animation key near it (within half the way to the track's next key either
 * side) that the line between the keys kept either side already draws: a long layer's keys would
 * otherwise double, past what the wire takes. Where the track turns a corner - starts or stops moving,
 * jumps at a mend - its key draws what no such line does, and stays. A track key at the very instant of an
 * animation key goes always: that key reads the track there exactly, so this one could only repeat it -
 * or, after an animation's step, undo the step. An animation's step (two keys at one time) is kept as the
 * step it is. Either alone comes back as it is.
 */
export function combineMotions(track: ComposeOverlayMotion | null, animation: ComposeOverlayMotion | null): ComposeOverlayMotion | null {
  if (!track) return animation;
  if (!animation) return track;
  const animTimes = animation.atMs;
  type Sample = { x: number; y: number; scale: number; rotation: number; opacity: number };
  const read = (motion: ComposeOverlayMotion, t: number): Sample => overlayMotionAt(motion, t) ?? { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
  const own = (motion: ComposeOverlayMotion, i: number): Sample => ({
    x: motion.x?.[i] ?? 0,
    y: motion.y?.[i] ?? 0,
    scale: motion.scale?.[i] ?? 1,
    rotation: motion.rotation?.[i] ?? 0,
    opacity: motion.opacity?.[i] ?? 1,
  });
  const keyOf = (t: number, tr: Sample, an: Sample, spare: boolean): MotionKey => ({
    t,
    v: [tr.x + an.x, tr.y + an.y, tr.scale * an.scale, tr.rotation + an.rotation, an.opacity],
    spare,
  });
  const keys: MotionKey[] = animation.atMs.map((t, i) => keyOf(t, read(track, t), own(animation, i), false));
  const n = track.atMs.length;
  track.atMs.forEach((t, i) => {
    if (anyKeyIn(animTimes, t - SAME_INSTANT_MS, t + SAME_INSTANT_MS)) return;
    const lo = i > 0 ? (t + track.atMs[i - 1]!) / 2 : t;
    const hi = i + 1 < n ? (t + track.atMs[i + 1]!) / 2 : t;
    keys.push(keyOf(t, own(track, i), read(animation, t), anyKeyIn(animTimes, lo, hi)));
  });
  // Stable, so an animation's step keeps its two keys in their order.
  keys.sort((a, b) => a.t - b.t);
  // A spare key goes only while the line from the last key kept to the key after it draws it - and every
  // key left out since - within LINE_SLACK. The animation's keys always stay, so that is never far.
  const kept: MotionKey[] = [];
  let skipped: MotionKey[] = [];
  keys.forEach((key, j) => {
    const last = kept[kept.length - 1];
    const next = keys[j + 1];
    if (key.spare && last && next && [...skipped, key].every(k => onLine(last, next, k))) {
      skipped.push(key);
      return;
    }
    kept.push(key);
    skipped = [];
  });
  const sized = !!(track.scale || animation.scale);
  const turned = !!(track.rotation || animation.rotation);
  const faded = !!animation.opacity;
  const out: ComposeOverlayMotion = { atMs: kept.map(k => k.t), x: kept.map(k => roundTo(k.v[0], 5)), y: kept.map(k => roundTo(k.v[1], 5)) };
  if (sized) out.scale = kept.map(k => roundTo(k.v[2], 4));
  if (turned) out.rotation = kept.map(k => roundTo(k.v[3], 2));
  if (faded) out.opacity = kept.map(k => roundTo(k.v[4], 4));
  return out;
}

/** Whether the straight line from key `a` to key `b` draws key `k`, between them, within LINE_SLACK. */
function onLine(a: MotionKey, b: MotionKey, k: MotionKey): boolean {
  const span = b.t - a.t;
  if (!(span > 0)) return false;
  const f = (k.t - a.t) / span;
  return k.v.every((v, c) => Math.abs(a.v[c]! + (b.v[c]! - a.v[c]!) * f - v) <= LINE_SLACK[c]!);
}

/** Whether sorted `times` has one in `lo..hi`, both ends in. */
function anyKeyIn(times: readonly number[], lo: number, hi: number): boolean {
  let a = 0;
  let b = times.length;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (times[mid]! < lo) a = mid + 1;
    else b = mid;
  }
  return a < times.length && times[a]! <= hi;
}

/**
 * Everything a layer does while it is on screen, as the wire carries it: its track and its animation
 * compiled over its wire `window` and made one ([combineMotions]). The ONE place a layer's motion is
 * made, for the render and for the preview alike. Null for a layer that stands still.
 *
 * Never past [MAX_OVERLAY_MOTION_KEYS], which a render refuses: a long layer whose loop is keyed more
 * finely than the post's frames has the track read at half the rate, and half again, until the two fit -
 * and, with an animation keyed to the cap on its own, read only where the animation has its keys.
 */
export function compileLayerMotion(overlay: EditOverlay, scene: TrackScene, window: { startMs: number; endMs: number }): ComposeOverlayMotion | null {
  const animation = compileOverlayMotion(window, overlay.animation, overlay.kind);
  for (let room = MAX_OVERLAY_MOTION_KEYS; ; room = Math.floor(room / 2)) {
    const track = compileTrackMotion(overlay, scene, window, scene.manifest.output.fps, room);
    const motion = combineMotions(track, animation);
    if (!track || !motion || motion.atMs.length <= MAX_OVERLAY_MOTION_KEYS) return motion;
    if (room <= 2) {
      // Every key of the track read there falls on one of the animation's and goes, which leaves the
      // animation's own count - held to the cap where it was made. Checked all the same: past the cap a
      // render refuses the whole post, where the layer with its animation alone still plays.
      const fitted = combineMotions(trackKeysAt(overlay, scene, animation!.atMs), animation);
      return fitted && fitted.atMs.length <= MAX_OVERLAY_MOTION_KEYS ? fitted : animation;
    }
  }
}

/** The part of a layer a gesture changes, as the customer sees it at the playhead. */
export type ShownPose = Partial<Record<'cx' | 'cy' | 'scale' | 'rotationDeg', number>>;

/**
 * A size a tracked layer is drawn at, as its own `scale` - the nearest a customer can pick - and the
 * pin's [TrackPin.grow] for the rest. Growing with the thing can draw a layer past MIN_SCALE..MAX_SCALE,
 * and a size put in `scale` alone would be held to them there, shrinking or growing the layer everywhere.
 */
function sizeAt(drawn: number): { scale: number; grow: number } {
  const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, drawn));
  return { scale, grow: roundTo(drawn / scale, 6) };
}

/**
 * A following layer moved, sized or turned on the frame at output instant `outputMs`: `shown` is what the
 * customer put it at THERE, as they see it. Answers the patch that draws it so - the pin moved to that
 * instant with the layer's centre against the thing there, and `cx`, `cy`, `scale` and `rotationDeg`
 * the drawn ones (`scale` times the pin's `grow`) - so everywhere else it keeps following the thing from
 * its new place. Null where the footage is gone, and the shown values are then the layer's own.
 *
 * Moving the pin without moving the layer changes nothing anywhere: the layer at any other instant is
 * the same point of the footage, grown and turned from the new pin exactly as it was from the old.
 */
export function repinOverlay(overlay: EditOverlay, scene: TrackScene, outputMs: number, shown: ShownPose = {}): Partial<EditOverlay> | null {
  const followed = followedTrack(scene.manifest, overlay);
  if (!followed) return null;
  const { track, follow } = followed;
  const footage = trackedFootage(track, scene, outputMs);
  if (!footage) return null;
  const path = trackPath(track);
  const point = pinnedPoint(track, follow, path, footage.sourceMs);
  const out = footage.map.toOutput(point.x, point.y);
  const output = scene.manifest.output;
  const cx = shown.cx ?? out.x / output.width;
  const cy = shown.cy ?? out.y / output.height;
  const size = sizeAt(shown.scale ?? overlay.scale * point.scale);
  const rotationDeg = shown.rotationDeg ?? overlay.rotationDeg + point.turn;
  const source = footage.map.toSourceAnywhere(cx * output.width, cy * output.height);
  return { cx, cy, scale: size.scale, rotationDeg, follow: { ...follow, pin: pinAt(path, footage.sourceMs, source.u, source.v, size.grow) } };
}

/**
 * The patch that takes a layer off its track and leaves it standing where it is drawn at `outputMs`, rather
 * than jumping back to where it was last put - at the size it is drawn there, held to MIN_SCALE..MAX_SCALE
 * as every layer that follows nothing is.
 */
export function unfollowOverlay(overlay: EditOverlay, scene: TrackScene, outputMs: number): Partial<EditOverlay> & { follow: undefined } {
  const pose = trackedPoseAt(overlay, scene, outputMs);
  if (!pose) return { follow: undefined };
  return { ...pose, scale: Math.min(MAX_SCALE, Math.max(MIN_SCALE, pose.scale)), follow: undefined };
}

/** What a tracking run found: one sample per frame read, in time order, the thing's box where scale is 1. */
export interface TrackRunResult extends RunSamples {
  clipId: string;
  clipKey: string;
  aspect: number;
  box: { w: number; h: number };
}

/** A new track from a run's path: named, coloured, and smoothed as `smooth` says (the default when absent). */
export function trackFromRun(run: TrackRunResult, id: string, name: string, hue: number, smooth?: number): EditTrack {
  const track: EditTrack = {
    id,
    name,
    hue,
    clipId: run.clipId,
    clipKey: run.clipKey,
    aspect: run.aspect,
    box: run.box,
    atMs: run.atMs,
    x: run.x,
    y: run.y,
    scale: run.scale,
    turn: run.turn,
  };
  if (run.sure.some(s => s < 100)) track.sure = run.sure;
  if (run.lost.length > 0) track.lost = run.lost;
  if (smooth !== undefined) track.smooth = smooth;
  return track;
}

/**
 * The patch that pins `overlay` to `track` exactly where it is drawn at `outputMs` now - through whatever
 * track it followed before - so pinning never moves a layer on the frame the customer is looking at. Its
 * way of following (`scaleWith`, `turnWith`) is taken from `flags`, or kept from the follow it had. Null
 * for an effect, and where the track's footage is not on the post at all. `scene` must already hold
 * `track`, and still hold any track the layer followed before.
 */
export function followPatch(
  overlay: EditOverlay,
  track: EditTrack,
  scene: TrackScene,
  outputMs: number,
  flags: { scaleWith?: boolean; turnWith?: boolean } = {},
): Partial<EditOverlay> | null {
  if (overlay.kind === 'effect') return null;
  const before = trackedPoseAt(overlay, scene, outputMs) ?? { cx: overlay.cx, cy: overlay.cy, scale: overlay.scale, rotationDeg: overlay.rotationDeg };
  const footage = trackedFootage(track, scene, outputMs);
  if (!footage) return null;
  const output = scene.manifest.output;
  const source = footage.map.toSourceAnywhere(before.cx * output.width, before.cy * output.height);
  const size = sizeAt(before.scale);
  const follow: OverlayFollow = { trackId: track.id, pin: pinAt(trackPath(track), footage.sourceMs, source.u, source.v, size.grow) };
  if (flags.scaleWith ?? overlay.follow?.scaleWith) follow.scaleWith = true;
  if (flags.turnWith ?? overlay.follow?.turnWith) follow.turnWith = true;
  return { cx: before.cx, cy: before.cy, scale: size.scale, rotationDeg: before.rotationDeg, follow };
}

/**
 * A follow moved from `before`'s path onto `after`'s at SOURCE instant `atMs`, the layer drawn there exactly
 * where `before` drew it - its offset from the thing, its size and its turn - with the turn it had come
 * through handed back (`turn`) for the layer's own angle. Wherever the two paths agree, the layer is then
 * drawn where it was: what keeps a mend from moving a layer pinned inside the mended stretch anywhere
 * outside it.
 */
export function refollowAt(before: EditTrack, after: EditTrack, follow: OverlayFollow, atMs: number): { follow: OverlayFollow; turn: number } {
  const was = pinnedPoint(before, follow, trackPath(before), atMs);
  const here = pathAt(trackPath(after), atMs);
  const pin: OverlayFollow['pin'] = { atMs: Math.round(atMs), dx: roundTo(was.x - here.x, 5), dy: roundTo(was.y - here.y, 5) };
  if (Math.abs(was.scale - 1) > 1e-6) pin.grow = roundTo(was.scale, 6);
  return { follow: { ...follow, pin }, turn: roundTo(was.turn, 2) };
}
