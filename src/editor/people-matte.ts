import { SUBJECT_TRACK_MAGIC, SUBJECT_TRACK_VERSION, type ComposeCamera, type ComposeMatte, type SubjectInfo } from '../video-composer/definitions';
import { FULL_FRAME, pictureDest } from '../video-composer/web/geometry';
import { LayerMap } from '../video-composer/web/layer-map';
import { subjectGrid } from '../video-composer/web/subject-tracker';

import { cameraAt } from './camera';
import { overlayWireWindow } from './compose';
import { clipsDurationMs, totalDurationMs, type EditClip, type EditManifest, type EditOverlay, type EditRect } from './edit-manifest';
import { slotAt, timelineSlots, type TimelineSlot } from './edit-ops';
import { drawsNothing, layoutRectAt, type LayoutMotions } from './layout-motion';
import { encodeRuns, type SubjectTrack } from './subject-track';
import { sourceMsThrough } from './track-motion';

/**
 * Layers BEHIND the people in the picture ([OverlayCommon.behind]): where the people are on the OUTPUT frame at
 * an output instant, from the people Focus's finder found in each source, and the subject track an export is
 * handed of it ([ComposeSpec.matte]), so every engine puts the people back over the layers behind them with the
 * focus reader it already has and no clip's geometry at all.
 *
 * THE MASK at an instant is a grid over the output frame ([subjectGrid] of its shape), each cell a person or not.
 * The FRONT-most video layer whose picture covers the cell's centre decides it: the point is taken back to that
 * segment's source through the painter's own placement ([LayerMap]: the fit, the crop, the rectangle and its turn,
 * the camera), and the cell is a person where the source's subject track names a subject, in the frame of it
 * nearest the source instant shown. So a picture in front covers what is under it, people and all; a letterbox bar
 * is no picture, and the layer under it decides; and a source whose people were never found has nobody in it.
 * Inside a transition the base is its incoming clip, whose slot the instant is in.
 *
 * Worked out cell by cell over affine arithmetic rather than a [LayerMap] call a cell: each layer is six numbers
 * from the output pixel to the source point and four sides of the rectangle it is drawn in, which is the map's own
 * answer ([planeOf]) - a grid of a 1080x1920 post is 57,600 cells, a frame of a preview has a few milliseconds, and
 * a cheap phone has fewer. [PeopleMask] hands the last grid back untouched while nothing it was made from moved,
 * which is most frames of a playing preview: the finder read ten frames a second.
 *
 * THE EXPORT'S MATTE ([buildPeopleMatte]) is that grid at the instants [matteTimes] lists over the stretches a
 * layer is behind anyone: a frame a 30 fps frame of output, or the finder's own frames mapped onto the output
 * where those are fewer and nothing moves the picture, and a frame either side of every cut, so the reader's
 * fade between two frames never reaches across one. Every person is id 1, put back in full ([MATTE_KEYS]).
 */

/** The parts of the post the people are worked out through: what the painter draws the footage with. */
export interface PeopleScene {
  manifest: Pick<EditManifest, 'clips' | 'videoTracks' | 'output' | 'fit'> & Partial<Pick<EditManifest, 'durationMs'>>;
  /** The post's camera, compiled as the render compiles it; null for none, or a preview drawing without it. */
  camera: ComposeCamera | null;
  /** Every clip's arrangement keys: `compileLayoutMotions(manifest)`. */
  layout: LayoutMotions;
}

/** Where the people were found. */
export interface PeopleSources {
  /** Each source's people, by clip key: the subject track Focus's finder wrote. A source not here has nobody in it. */
  people: ReadonlyMap<string, SubjectTrack>;
  /** Each oriented source's width over its height, by clip key, where it is known; its track's grid stands in otherwise. */
  aspects?: ReadonlyMap<string, number>;
}

/** A layer's on-screen window on the output timeline, ms, `startMs <= t < endMs`. */
export interface MatteWindow {
  startMs: number;
  endMs: number;
}

/** The people at one output instant: see [PeopleMask.at]. */
export interface PeopleMaskFrame {
  width: number;
  height: number;
  /** 1 where a person is and 0 elsewhere, row by row from the output frame's top-left. The mask's own: read it, never keep it. */
  cells: Uint8Array;
  /** Whether any cell is a person. */
  any: boolean;
  /** Changes whenever [cells] does, so a reader that uploads them can skip a grid it already has. */
  version: number;
}

/** The longest one frame of an export's matte stands for, output ms: a frame at 30 fps. */
export const MATTE_STEP_MS = 1000 / 30;

/** The id every person has in an export's matte. */
export const MATTE_PERSON = 1;

/** An export's matte keys: one, at 0, holding for ever, with a person put back in full. A fresh copy each call. */
export function matteKeys(): Omit<ComposeMatte, 'uri'> {
  return { atMs: [0], subjects: [{ id: MATTE_PERSON, focus: [1] }] };
}

/** [SUBJECT_TRACK_MAGIC]'s header: the bytes before the JSON. */
const HEADER_BYTES = 20;

/** How far outside a side a cell's centre may be and still be on it, output pixels: a rounding's worth. */
const ON_EDGE_PX = 1e-6;

/* -------------------------------------------------------------------------------------------- */
/* Which layers are behind                                                                       */
/* -------------------------------------------------------------------------------------------- */

/** Whether `overlay` is drawn behind the people: its own [OverlayCommon.behind], and never an effect's. */
export function isBehind(overlay: Pick<EditOverlay, 'kind' | 'behind'>): boolean {
  return overlay.behind === true && overlay.kind !== 'effect';
}

/** Whether any layer of the post is behind the people: a post with none does no work for them anywhere. */
export function hasBehindLayers(manifest: Pick<EditManifest, 'overlays'>): boolean {
  return manifest.overlays.some(isBehind);
}

/**
 * Where on the OUTPUT timeline a layer is behind the people, as the wire carries the layers ([overlayWireWindow]),
 * merged and in time order: the stretches an export's matte has frames over. The layers the wire leaves out - an
 * empty text, one starting at the very end - are left out here too.
 */
export function behindWindows(manifest: Pick<EditManifest, 'overlays' | 'clips' | 'videoTracks'> & Partial<Pick<EditManifest, 'durationMs'>>): MatteWindow[] {
  const totalMs = Math.round(totalDurationMs(manifest));
  const windows: MatteWindow[] = [];
  for (const overlay of manifest.overlays) {
    if (!isBehind(overlay)) continue;
    if (overlay.kind === 'text' && overlay.text.trim().length === 0) continue;
    if (overlay.startMs >= totalMs - 1) continue;
    windows.push(overlayWireWindow(overlay, totalMs));
  }
  return mergeWindows(windows);
}

/** `windows` in time order, the ones that touch or overlap made one. */
export function mergeWindows(windows: readonly MatteWindow[]): MatteWindow[] {
  const sorted = [...windows].filter(w => w.endMs > w.startMs).sort((a, b) => a.startMs - b.startMs);
  const out: MatteWindow[] = [];
  for (const w of sorted) {
    const last = out[out.length - 1];
    if (last && w.startMs <= last.endMs) last.endMs = Math.max(last.endMs, w.endMs);
    else out.push({ startMs: w.startMs, endMs: w.endMs });
  }
  return out;
}

/* -------------------------------------------------------------------------------------------- */
/* The video layers                                                                              */
/* -------------------------------------------------------------------------------------------- */

/** One video layer drawn at an instant: the segment, whether it is the base's, and the source instant it shows. */
export interface DrawnFootage {
  clip: EditClip;
  /** On the base track, whose rectangle frames the picture inside the whole frame; a layer's rectangle is its destination. */
  base: boolean;
  sourceMs: number;
}

/**
 * The video layers drawn at output instant `outputMs`, bottom to top - [EditorStore.previewLayers]'s rule, which is the
 * painter's and the render's: the base track's segment while the base runs (its last one at the very end of a post no
 * longer than it), each layer's from its start to its own end or the post's, by `z` with the base at 0 and ties kept
 * in order. A layer at no opacity draws nothing anyone sees, and is left out.
 */
export function videoLayersAt(manifest: PeopleScene['manifest'], outputMs: number): DrawnFootage[] {
  const total = totalDurationMs(manifest);
  const layers: { footage: DrawnFootage; z: number }[] = [];
  const baseLen = clipsDurationMs(manifest.clips);
  const base = outputMs < baseLen || total <= baseLen ? slotAt(manifest, outputMs) : null;
  if (base) layers.push({ footage: footageOf(base, outputMs, true), z: 0 });
  for (const track of manifest.videoTracks) {
    if (!(track.opacity > 0)) continue;
    const into = outputMs - track.startMs;
    if (into < 0) continue;
    const cut = Math.min(totalDurationMs({ clips: track.clips }), total - track.startMs);
    if (cut <= 0) continue;
    if (into >= cut && !(outputMs >= total && track.startMs + cut >= total)) continue;
    const slot = slotAt({ clips: track.clips }, into);
    if (slot) layers.push({ footage: footageOf(slot, into, false), z: track.z });
  }
  return layers.sort((a, b) => a.z - b.z).map(layer => layer.footage);
}

function footageOf(slot: TimelineSlot, localMs: number, base: boolean): DrawnFootage {
  return { clip: slot.clip, base, sourceMs: slot.clip.image ? 0 : sourceMsThrough(slot, localMs) };
}

/**
 * The painter's placement of `footage` at output instant `outputMs` for a source of shape `aspect` (width over height)
 * - `trackedFootage`'s, and through it the preview's `layerDraw` and the render's plan - or null where its rectangle is
 * too thin to draw. A source of no known shape is taken to be its rectangle's, which it then fills whatever its fit.
 */
export function footageMap(scene: PeopleScene, footage: DrawnFootage, outputMs: number, aspect: number | null): LayerMap | null {
  const manifest = scene.manifest;
  const output = manifest.output;
  const clip = footage.clip;
  const rect = layoutRectAt(scene.layout, clip, outputMs) ?? undefined;
  if (rect && drawsNothing(rect, output.width, output.height)) return null;
  const fit = clip.fit ?? manifest.fit;
  const crop = clip.crop ?? undefined;
  const framing = footage.base ? { fit, crop, rect } : { fit, crop };
  const box = rect ?? FULL_FRAME;
  const shape = aspect !== null && aspect > 0 ? aspect : (box.w * output.width) / Math.max(1e-9, box.h * output.height);
  const sourceWidth = shape * 1000;
  const sourceHeight = 1000;
  const dest = footage.base ? FULL_FRAME : pictureDest(box, framing, output.width / output.height, sourceWidth, sourceHeight);
  return new LayerMap({ framing, dest, sourceWidth, sourceHeight, rotationDeg: rect?.rotationDeg ?? 0, camera: cameraAt(scene.camera, outputMs) }, output);
}

/* -------------------------------------------------------------------------------------------- */
/* The mask                                                                                      */
/* -------------------------------------------------------------------------------------------- */

/**
 * A layer's picture as arithmetic on output pixels: which source point is drawn at (x, y), and whether anything of
 * the source is drawn there at all - [LayerMap.toSource]'s two tests, inside the rectangle it is drawn in and inside
 * the part of the source its crop keeps.
 */
export interface Plane {
  /** The source point drawn at output pixel (x, y): `u = u0 + ux x + uy y`, and `v` likewise. */
  u0: number;
  ux: number;
  uy: number;
  v0: number;
  vx: number;
  vy: number;
  /** The drawn rectangle's four sides, three numbers each: `a + b x + c y` is how far inside that side, output pixels. */
  sides: Float64Array;
  /** The part of the source drawn, inside the source: its crop. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The frame of the source's subjects shown, or null for a source with nobody found in it. */
  cells: Uint8Array | null;
  gridWidth: number;
  gridHeight: number;
}

/**
 * [map] as a [Plane]: the source point at three output pixels, which an affine map is wholly said by, and the four
 * sides of [LayerMap.outline]. Null for a rectangle drawn as nothing - turned edge on, or shrunk to a line.
 */
export function planeOf(map: LayerMap, output: { width: number; height: number }, crop: EditRect | null | undefined, cells: Uint8Array | null, gridWidth: number, gridHeight: number): Plane | null {
  const o = map.toSourceAnywhere(0, 0);
  const across = map.toSourceAnywhere(output.width, 0);
  const down = map.toSourceAnywhere(0, output.height);
  const corners = map.outline();
  let area = 0;
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!;
    const b = corners[(k + 1) % 4]!;
    area += a.x * b.y - b.x * a.y;
  }
  if (!(Math.abs(area) > 1e-9)) return null;
  const turn = area > 0 ? 1 : -1;
  const sides = new Float64Array(12);
  for (let k = 0; k < 4; k++) {
    const a = corners[k]!;
    const b = corners[(k + 1) % 4]!;
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (!(length > 0)) return null;
    // The cross product of the side with the point, over the side's length: how far inside it, in pixels.
    const bx = (-turn * (b.y - a.y)) / length;
    const by = (turn * (b.x - a.x)) / length;
    sides[3 * k] = -(bx * a.x + by * a.y);
    sides[3 * k + 1] = bx;
    sides[3 * k + 2] = by;
  }
  const kept = crop ?? FULL_FRAME;
  return {
    u0: o.u,
    ux: (across.u - o.u) / output.width,
    uy: (down.u - o.u) / output.height,
    v0: o.v,
    vx: (across.v - o.v) / output.width,
    vy: (down.v - o.v) / output.height,
    sides,
    left: Math.max(0, kept.x),
    right: Math.min(1, kept.x + kept.w),
    top: Math.max(0, kept.y),
    bottom: Math.min(1, kept.y + kept.h),
    cells,
    gridWidth,
    gridHeight,
  };
}

/**
 * Whether plane `p` draws a picture at output pixel (x, y) - [LayerMap.toSource] answering anything but null - and, when
 * it does, whether a person is there: 1 for a person, 0 for none, and -1 where the plane draws nothing.
 */
export function planeAt(p: Plane, x: number, y: number): -1 | 0 | 1 {
  const s = p.sides;
  if (s[0]! + s[1]! * x + s[2]! * y < -ON_EDGE_PX) return -1;
  if (s[3]! + s[4]! * x + s[5]! * y < -ON_EDGE_PX) return -1;
  if (s[6]! + s[7]! * x + s[8]! * y < -ON_EDGE_PX) return -1;
  if (s[9]! + s[10]! * x + s[11]! * y < -ON_EDGE_PX) return -1;
  const u = p.u0 + p.ux * x + p.uy * y;
  const v = p.v0 + p.vx * x + p.vy * y;
  if (u < p.left || u > p.right || v < p.top || v > p.bottom) return -1;
  const cells = p.cells;
  if (!cells) return 0;
  const cx = Math.min(p.gridWidth - 1, Math.max(0, Math.floor(u * p.gridWidth)));
  const cy = Math.min(p.gridHeight - 1, Math.max(0, Math.floor(v * p.gridHeight)));
  return cells[cy * p.gridWidth + cx]! > 0 ? 1 : 0;
}

/** Every video layer drawn at `outputMs` as a [Plane], bottom to top, with the frame of its source's people shown. */
export function planesAt(scene: PeopleScene, sources: PeopleSources, outputMs: number): Plane[] {
  const output = scene.manifest.output;
  const planes: Plane[] = [];
  for (const footage of videoLayersAt(scene.manifest, outputMs)) {
    const key = footage.clip.clipKey;
    const track = sources.people.get(key) ?? null;
    const aspect = sources.aspects?.get(key) ?? (track ? track.width / track.height : null);
    const map = footageMap(scene, footage, outputMs, aspect);
    if (!map) continue;
    let cells: Uint8Array | null = null;
    if (track) {
      try {
        // The frame nearest the instant: a cell is somebody or nobody, and a frame between two is neither.
        const span = track.span(footage.sourceMs);
        cells = track.frame(span.weight < 0.5 ? span.from : span.to);
      } catch {
        // A frame that will not decode is nobody found there, rather than a picture with a hole in it.
        cells = null;
      }
    }
    const plane = planeOf(map, output, footage.clip.crop, cells, track?.width ?? 0, track?.height ?? 0);
    if (plane) planes.push(plane);
  }
  return planes;
}

/**
 * The people on the output frame, an instant at a time, keeping its grid: the same object every call, filled
 * again only when what it is made from has moved - a layer's placement, the frame of its people shown - so a
 * preview playing over a still camera works a grid out ten times a second, at the finder's own rate, and hands
 * the last one back on every frame between.
 */
export class PeopleMask {
  private cells = new Uint8Array(0);
  private width = 0;
  private height = 0;
  private any = false;
  private version = 0;
  /** What the grid was made from: every plane's numbers, and its frame of people, which a number cannot stand for. */
  private madeFrom: number[] = [];
  private madeCells: (Uint8Array | null)[] = [];

  /** How many grids have been worked out, rather than handed back unchanged. */
  get made(): number {
    return this.version;
  }

  /** The people at output instant `outputMs`. */
  at(scene: PeopleScene, sources: PeopleSources, outputMs: number): PeopleMaskFrame {
    const output = scene.manifest.output;
    const grid = subjectGrid(output.width, output.height);
    const planes = planesAt(scene, sources, outputMs);
    const from: number[] = [grid.width, grid.height, output.width, output.height];
    const cells: (Uint8Array | null)[] = [];
    for (const p of planes) {
      from.push(p.u0, p.ux, p.uy, p.v0, p.vx, p.vy, p.left, p.right, p.top, p.bottom, p.gridWidth, p.gridHeight);
      for (let k = 0; k < 12; k++) from.push(p.sides[k]!);
      cells.push(p.cells);
    }
    if (this.version > 0 && sameNumbers(from, this.madeFrom) && sameRefs(cells, this.madeCells)) return this.frame();
    this.madeFrom = from;
    this.madeCells = cells;
    if (this.width !== grid.width || this.height !== grid.height) {
      this.width = grid.width;
      this.height = grid.height;
      this.cells = new Uint8Array(grid.width * grid.height);
    }
    this.any = fillMask(this.cells, grid.width, grid.height, output, planes);
    this.version++;
    return this.frame();
  }

  private frame(): PeopleMaskFrame {
    return { width: this.width, height: this.height, cells: this.cells, any: this.any, version: this.version };
  }
}

/**
 * Each cell of a `width` x `height` grid over the output: 1 where the front-most plane that draws at the cell's
 * centre has a person, 0 elsewhere. Answers whether any cell is a person.
 */
function fillMask(out: Uint8Array, width: number, height: number, output: { width: number; height: number }, planes: readonly Plane[]): boolean {
  if (planes.length === 0 || !planes.some(p => p.cells)) {
    out.fill(0);
    return false;
  }
  const cellW = output.width / width;
  const cellH = output.height / height;
  let any = false;
  for (let gy = 0; gy < height; gy++) {
    const y = (gy + 0.5) * cellH;
    const row = gy * width;
    for (let gx = 0; gx < width; gx++) {
      const x = (gx + 0.5) * cellW;
      let value = 0;
      for (let k = planes.length - 1; k >= 0; k--) {
        const found = planeAt(planes[k]!, x, y);
        if (found < 0) continue;
        value = found;
        break;
      }
      out[row + gx] = value;
      if (value) any = true;
    }
  }
  return any;
}

function sameNumbers(a: readonly number[], b: readonly number[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function sameRefs(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/* -------------------------------------------------------------------------------------------- */
/* The sources                                                                                   */
/* -------------------------------------------------------------------------------------------- */

/** One video lane: where it starts and stops on the output, and its segments. */
interface Lane {
  startMs: number;
  endMs: number;
  slots: TimelineSlot[];
}

/** The base track and every layer that draws something, each cut where [videoLayersAt] cuts it. */
function lanesOf(manifest: PeopleScene['manifest']): Lane[] {
  const total = totalDurationMs(manifest);
  const lanes: Lane[] = [{ startMs: 0, endMs: clipsDurationMs(manifest.clips), slots: timelineSlots(manifest) }];
  for (const track of manifest.videoTracks) {
    if (!(track.opacity > 0)) continue;
    const cut = Math.min(totalDurationMs({ clips: track.clips }), total - track.startMs);
    if (cut <= 0) continue;
    lanes.push({ startMs: track.startMs, endMs: track.startMs + cut, slots: timelineSlots({ clips: track.clips }) });
  }
  return lanes;
}

/** Where `slot` of `lane` is on screen, output ms. */
function slotSpan(lane: Lane, slot: TimelineSlot): MatteWindow {
  const startMs = lane.startMs + slot.startMs;
  return { startMs, endMs: Math.min(lane.endMs, startMs + Math.max(0, slot.durationMs)) };
}

/**
 * Every source on screen while a layer is behind the people - on any video layer, the ones over the people
 * included, whose pictures cover them - by clip key, in the order first met: the sources whose people have to be
 * known before a layer can go behind them, and the ones an export's matte is made from.
 */
export function peopleSourceKeys(manifest: PeopleScene['manifest'], windows: readonly MatteWindow[]): string[] {
  const keys = new Set<string>();
  for (const lane of lanesOf(manifest)) {
    for (const slot of lane.slots) {
      const span = slotSpan(lane, slot);
      if (windows.some(w => w.startMs < span.endMs && span.startMs < w.endMs)) keys.add(slot.clip.clipKey);
    }
  }
  return [...keys];
}

/**
 * Whether anybody the finder found is on screen in `window`: a subject of a segment's source seen in the part of it
 * the segment shows there - anywhere in a picture, whose one frame holds throughout. `subjectsOf` is what the finder
 * answered for a source, or null where it has not answered.
 */
export function anyoneIn(manifest: PeopleScene['manifest'], window: MatteWindow, subjectsOf: (clipKey: string) => readonly SubjectInfo[] | null): boolean {
  for (const lane of lanesOf(manifest)) {
    for (const slot of lane.slots) {
      const span = slotSpan(lane, slot);
      const from = Math.max(span.startMs, window.startMs);
      const to = Math.min(span.endMs, window.endMs);
      if (!(to > from)) continue;
      const subjects = subjectsOf(slot.clip.clipKey);
      if (!subjects?.length) continue;
      const clip = slot.clip;
      if (clip.image) return true;
      const speed = clip.speed || 1;
      const sourceFrom = clip.inMs + (from - span.startMs) * speed;
      const sourceTo = clip.inMs + (to - span.startMs) * speed;
      if (subjects.some(subject => subject.startMs <= sourceTo && subject.endMs >= sourceFrom)) return true;
    }
  }
  return false;
}

/* -------------------------------------------------------------------------------------------- */
/* The export's matte                                                                            */
/* -------------------------------------------------------------------------------------------- */

/**
 * The output instants an export's matte has frames at, whole ms, strictly increasing, over `windows`:
 *
 *  - a frame every [MATTE_STEP_MS], or the frames the finder read of each segment's source mapped onto the output,
 *    whichever is coarser - the second only while nothing moves the picture between them, no camera and no
 *    arrangement moving, since a zoom moves the people across the frame between two of the finder's frames;
 *  - and, either way, a frame at each window's two ends and either side of every cut and every layer starting or
 *    stopping inside one, so the reader's fade between two frames never reaches across a change of picture.
 */
export function matteTimes(scene: PeopleScene, sources: PeopleSources, windows: readonly MatteWindow[]): number[] {
  const inside = (t: number): boolean => windows.some(w => t >= w.startMs && t < w.endMs);
  const events: number[] = [];
  const grid: number[] = [];
  for (const w of windows) {
    events.push(w.startMs, w.endMs - 1);
    for (let t = w.startMs; t < w.endMs; t += MATTE_STEP_MS) grid.push(t);
  }
  const found: number[] = [];
  for (const lane of lanesOf(scene.manifest)) {
    for (const edge of [lane.startMs, lane.endMs]) if (inside(edge)) events.push(edge - 1, edge);
    for (const slot of lane.slots) {
      const span = slotSpan(lane, slot);
      if (!windows.some(w => w.startMs < span.endMs && span.startMs < w.endMs)) continue;
      if (inside(span.startMs)) events.push(span.startMs - 1, span.startMs);
      const track = sources.people.get(slot.clip.clipKey);
      const clip = slot.clip;
      // A picture's one frame is the same people throughout the segment: its span's ends say all of it.
      if (!track || clip.image) continue;
      const speed = clip.speed || 1;
      for (const sourceMs of track.times) {
        if (sourceMs < clip.inMs || sourceMs > clip.outMs) continue;
        const t = span.startMs + (sourceMs - clip.inMs) / speed;
        if (t >= span.startMs && t < span.endMs && inside(t)) found.push(t);
      }
    }
  }
  const moving = scene.camera !== null || scene.layout.size > 0;
  const base = moving || found.length >= grid.length ? grid : found;
  const times = [...base, ...events].map(t => Math.round(t)).filter(t => t >= 0 && inside(t));
  times.sort((a, b) => a - b);
  const out: number[] = [];
  for (const t of times) if (out.length === 0 || t > out[out.length - 1]!) out.push(t);
  return out;
}

/** An export's matte: the subject track, and the keys that read it. */
export interface PeopleMatteFile {
  /** Laid out as [SUBJECT_TRACK_MAGIC] says, its grid over the OUTPUT frame and its times OUTPUT ms. */
  bytes: Uint8Array;
  /** All of the matte but the `uri` the bytes are given: [matteKeys]. */
  keys: Omit<ComposeMatte, 'uri'>;
  frames: number;
}

/** What an export's matte is made of, before a frame of it is: null for a post that needs none. */
interface MattePlan {
  times: number[];
  width: number;
  height: number;
}

function mattePlan(manifest: Pick<EditManifest, 'overlays'> & PeopleScene['manifest'], scene: PeopleScene, sources: PeopleSources): MattePlan | null {
  const windows = behindWindows(manifest);
  if (windows.length === 0) return null;
  // Nobody found anywhere behind a layer is a matte that puts nobody back: none is sent, and the layers are drawn on top.
  if (!peopleSourceKeys(manifest, windows).some(key => sources.people.has(key))) return null;
  const times = matteTimes(scene, sources, windows);
  if (times.length === 0) return null;
  const output = scene.manifest.output;
  const grid = subjectGrid(output.width, output.height);
  return { times, width: grid.width, height: grid.height };
}

/**
 * Each frame of the matte as its runs ([encodeRuns]), in time order. A frame whose grid did not change is the
 * very runs of the one before, so a minute of matte holds a kilobyte or two a frame and no grid of its own.
 */
function* matteRuns(scene: PeopleScene, sources: PeopleSources, times: readonly number[]): Generator<Uint8Array> {
  const mask = new PeopleMask();
  let runs: Uint8Array | null = null;
  let version = -1;
  for (const t of times) {
    const frame = mask.at(scene, sources, t);
    if (!runs || frame.version !== version) {
      runs = encodeRuns(frame.cells);
      version = frame.version;
    }
    yield runs;
  }
}

/**
 * The subject track of `frames`, written as `encodeSubjectTrack` writes one but from frames already run-length
 * coded, so no frame's grid is held: a minute of 30 frames a second is 1800 grids, a hundred megabytes on a phone.
 * Its JSON is left out, as the track looks' is: it lists what an engine found, for a reader that shows the
 * subjects, and nobody shows these.
 */
function writeMatte(plan: MattePlan, frames: readonly Uint8Array[]): Uint8Array {
  let data = 0;
  for (const runs of frames) data += runs.length;
  const n = plan.times.length;
  const file = new Uint8Array(HEADER_BYTES + 8 * n + data);
  const view = new DataView(file.buffer);
  for (let i = 0; i < 4; i++) file[i] = SUBJECT_TRACK_MAGIC.charCodeAt(i);
  file[4] = SUBJECT_TRACK_VERSION;
  view.setUint16(6, plan.width, true);
  view.setUint16(8, plan.height, true);
  view.setUint32(12, n, true);
  // J, at 16, stays 0: no JSON.
  let at = HEADER_BYTES;
  for (const t of plan.times) {
    view.setUint32(at, t, true);
    at += 4;
  }
  let offset = 0;
  for (const runs of frames) {
    view.setUint32(at, offset, true);
    at += 4;
    offset += runs.length;
  }
  for (const runs of frames) {
    file.set(runs, at);
    at += runs.length;
  }
  return file;
}

/** The last matte made, and what it was made from: an export of the same post again is handed the same bytes. */
let lastMatte: { from: unknown[]; file: PeopleMatteFile | null } | null = null;

/**
 * What a matte is made from, as values and the post's own arrays: the same list is the same bytes. The camera is
 * stood for by the zooms and tracks it is compiled from, since a render compiles it afresh.
 */
function matteFrom(manifest: Pick<EditManifest, 'overlays'> & PeopleScene['manifest'] & Partial<Pick<EditManifest, 'zooms' | 'tracks'>>, scene: PeopleScene, sources: PeopleSources): unknown[] {
  const from: unknown[] = [manifest.clips, manifest.videoTracks, manifest.output, manifest.fit, manifest.durationMs, manifest.zooms, manifest.tracks, scene.camera === null, scene.layout.size];
  for (const w of behindWindows(manifest)) from.push(w.startMs, w.endMs);
  for (const [key, track] of sources.people) from.push(key, track);
  for (const [key, aspect] of sources.aspects ?? []) from.push(key, aspect);
  return from;
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

type MatteManifest = Pick<EditManifest, 'overlays'> & PeopleScene['manifest'] & Partial<Pick<EditManifest, 'zooms' | 'tracks'>>;

/**
 * The matte an export of the post is handed - [PeopleMatteFile] - or null where it needs none: no layer behind
 * anybody, or nobody found in any source on screen behind one. All at once; [buildPeopleMatteAsync] gives the page
 * its turn between frames.
 */
export function buildPeopleMatte(manifest: MatteManifest, scene: PeopleScene, sources: PeopleSources): PeopleMatteFile | null {
  const from = matteFrom(manifest, scene, sources);
  if (lastMatte && sameList(lastMatte.from, from)) return lastMatte.file;
  const plan = mattePlan(manifest, scene, sources);
  const file = plan ? finishMatte(plan, [...matteRuns(scene, sources, plan.times)]) : null;
  lastMatte = { from, file };
  return file;
}

/**
 * [buildPeopleMatte], giving the page back its thread every `sliceMs` of work, so a long post's matte - a few
 * seconds of arithmetic on a phone - never freezes the export screen. Rejects with the signal's reason once it is
 * aborted.
 */
export async function buildPeopleMatteAsync(manifest: MatteManifest, scene: PeopleScene, sources: PeopleSources, options: { signal?: AbortSignal; sliceMs?: number } = {}): Promise<PeopleMatteFile | null> {
  const from = matteFrom(manifest, scene, sources);
  if (lastMatte && sameList(lastMatte.from, from)) return lastMatte.file;
  const plan = mattePlan(manifest, scene, sources);
  if (!plan) {
    lastMatte = { from, file: null };
    return null;
  }
  const slice = options.sliceMs ?? 8;
  const frames: Uint8Array[] = [];
  let since = now();
  for (const runs of matteRuns(scene, sources, plan.times)) {
    frames.push(runs);
    if (now() - since >= slice) {
      await new Promise(resolve => setTimeout(resolve, 0));
      options.signal?.throwIfAborted();
      since = now();
    }
  }
  const file = finishMatte(plan, frames);
  lastMatte = { from, file };
  return file;
}

function finishMatte(plan: MattePlan, frames: readonly Uint8Array[]): PeopleMatteFile {
  return { bytes: writeMatte(plan, frames), keys: matteKeys(), frames: frames.length };
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
