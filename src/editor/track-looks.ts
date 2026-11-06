import { SUBJECT_TRACK_MAGIC, SUBJECT_TRACK_VERSION, type ComposeFocus, type ComposeFocusSubject } from '../video-composer/definitions';
import { subjectGrid } from '../video-composer/web/subject-tracker';

import type { EditClip, EditManifest, EditTrack, TrackLook } from './edit-manifest';
import { FOCUS_MAX_SIGMA, focusChangesPicture } from './focus';
import { pathAt, trackPath } from './overlay-track';

/**
 * Looks that follow a track ([EditTrack.look]) - a face blurred, a thing spotlit, a thing left in colour in a
 * grey world - drawn by the Focus engine every platform already has, so nothing native knows a look exists.
 *
 * A segment whose source has looked tracks is handed a focus ([ComposeFocus]) like a focused segment's, and
 * its subject track is MADE here off the tracks' paths instead of found by `findSubjects`: each thing an
 * ellipse a little larger than its box, ringed by ids of its own whose levels fall away, so its edge feathers
 * rather than steps. The web, Android and iOS draw that with arithmetic they already have, and the preview
 * reads the very same bytes, so what the customer sees on the frame is what is posted.
 *
 * ONE FOCUS A SEGMENT. A focus has one blur, one grey, one dark and one way round, so a segment's looks are
 * drawn as one of two focuses: its blurs as an inverted one - the things softened, the world as it is - or its
 * spotlights and pops as a plain one - the things as they are, the world dimmed and greyed. A segment showing
 * both draws only its blurs, privacy first: a blur hides something, and hiding it matters more than any light
 * on something else. Several blurs soften as much as the strongest of them asks, and several spotlights dim,
 * and pops grey, as much as theirs do. A segment's own Focus ([EditClip.focus]) wins over every look on it.
 *
 * THE FRAMES are the looked tracks' own samples, so the reader, which fades from one frame's cells to the
 * next's rather than moving them (the contract's step 3), only ever fades across one sample's worth of
 * movement. And one frame either side of each track's span, on which the look is off: every cell the world
 * for a blur, and every cell [LOOK_KEPT] for a spotlight or a pop, whose world would otherwise be dimmed round
 * nothing. So a look starts and stops on the frame its track does, rather than fading in or out over a trim
 * that runs past it. Where the tracker lost the thing, the look stays on along the path it was carried on: a
 * face blurred where it probably is beats a face shown because it was hard to see.
 *
 * The frames cover each track's whole span, not the segment's trim, and the one key is at 0, so a trim
 * dragged, a cut, or a second segment over the same footage asks for the very bytes already made: they are
 * made again only when a track's path, the tracks a segment draws or their way round changes ([MADE]).
 */

/** How much larger than the ellipse inside the thing's box a look reaches: room for an ear, a chin, a wing the box cut off. */
export const LOOK_REACH = 1.15;

/**
 * How far past the shape a look's soft edge reaches, a share of its radius: a penumbra nearly half as wide again
 * as the shape, as a film's follow-spot throws round a performer, so a spotlight falls away into the dark rather
 * than stopping at a line, and a blur fades out round a face instead of ending in an oval. Only ever outward: the
 * shape itself has the look in full - lit, popped, or for a blur softened through and through - and a wider edge
 * only takes the look further round it.
 */
export const LOOK_FEATHER = 0.45;

/**
 * How far into its look each ring of a shape is, from the middle out, one id each: the middle the whole way, then
 * twenty rings spread evenly across [LOOK_FEATHER], each a twentieth further down a straight line from 1 to 0, read
 * at its middle (0.975, 0.925 ... 0.025). Past the last ring is the world.
 *
 * A STRAIGHT LINE because every engine eases the mask it reads, `e = m * m * (3 - 2 * m)` ([ComposeFocus] step 4):
 * a straight fall comes out of that a smoothstep, the soft shoulder and toe of a penumbra, where levels that were a
 * smoothstep already would be eased twice into a harder edge. TWENTY because on a person in a phone's shot each ring
 * is then a cell or two of the grid wide, so the reader's blend between cell centres runs them into one slope rather
 * than a stair. The five rings over a tenth of the radius this replaced fell a quarter of the look at a time across
 * a few cells - an edge, along which the grid's six-pixel cells showed. More rings would buy little a cell can show,
 * and each is an id: twenty-one leave room for twelve tracks a segment ([MOST_LOOKED]), past the most a post keeps.
 */
export const LOOK_RINGS: readonly number[] = [
  1, 0.975, 0.925, 0.875, 0.825, 0.775, 0.725, 0.675, 0.625, 0.575, 0.525, 0.475, 0.425, 0.375, 0.325, 0.275, 0.225, 0.175, 0.125, 0.075, 0.025,
];

/** Each ring's outer edge as a squared radius, the shape's own edge being 1: the middle, then the feather in even steps. */
const RING_EDGES = LOOK_RINGS.map((_, k) => (1 + (k * LOOK_FEATHER) / (LOOK_RINGS.length - 1)) ** 2);

/**
 * The id every cell of a spotlight's or a pop's frame has where no thing is on screen at all: in focus, so the
 * world is left as it is, not dimmed round nothing. A blur needs none - its world is the background, 0.
 */
export const LOOK_KEPT = 1;

/** The most tracks one segment's looks draw: every ring of every one an id of its own, 1..255. */
const MOST_LOOKED = Math.floor((255 - LOOK_KEPT) / LOOK_RINGS.length);

/**
 * Frames closer than this to the one kept before are left out, unless a look starts or stops on them: two
 * tracks read at frames of their own, or footage at 60 fps, would otherwise double the file for nothing the
 * reader's cross-fade does not already draw.
 */
const MIN_FRAME_GAP_MS = 20;

/** A cell of [encodeLooks]'s row that no ring reaches. */
const NO_RING = 255;

/** [SUBJECT_TRACK_MAGIC]'s header: the bytes before the JSON. */
const HEADER_BYTES = 20;

/**
 * The looks last made, by the first looked track's samples - the array the manifest keeps until a track's
 * path changes - so the preview's redraws, every segment over the footage and the render all read the bytes
 * made once. A few for each track, the newest first: two shapes a customer goes back and forth between, a
 * blur and a spotlight, are both kept. Kept as long as the samples are, undo's included, which is why only
 * a few.
 */
const MADE = new WeakMap<readonly number[], SegmentLook[]>();

/** How many looks [MADE] keeps for one track. */
const MADE_PER_TRACK = 2;

/** What a segment's looks are drawn from: see [segmentLook]. */
export interface SegmentLook {
  /** The subject track the looks are drawn from, laid out as [SUBJECT_TRACK_MAGIC] says. */
  readonly bytes: Uint8Array;
  /** The focus that reads it, all but the `uri` the bytes are given: one key, each ring at its own level. */
  readonly focus: Omit<ComposeFocus, 'uri'>;
  /** What the bytes were made from, so a later [segmentLook] can hand them back unmade. */
  readonly shape: readonly unknown[];
}

/** The fields of a segment its looks are worked out from. */
export type LookedClip = Pick<EditClip, 'clipKey' | 'inMs' | 'outMs' | 'image' | 'focus'>;

/** Whether any track on the post has a look: a post with none has no work done for looks anywhere. */
export function hasTrackLooks(manifest: Pick<EditManifest, 'tracks'>): boolean {
  return !!manifest.tracks?.some(track => track.look);
}

/**
 * The looks segment `clip` shows, as a subject track and the focus that reads it - or null for a segment with
 * none: no looked track of its source over its trim, or a Focus of its own, which wins.
 *
 * The bytes are handed back unmade while the tracks' paths, the tracks drawn and their way round are the
 * same ([MADE]) - a strength dragged makes a new focus and nothing else - and the very look while nothing at
 * all changed, so a caller can keep whatever it built from it.
 */
export function segmentLook(clip: LookedClip, tracks: readonly EditTrack[] | undefined): SegmentLook | null {
  const group = lookGroup(clip, tracks);
  if (!group) return null;
  const shape = lookShape(clip, group);
  const focus = lookFocus(group);
  const key = group.tracks[0]!.atMs;
  const known = MADE.get(key) ?? [];
  const same = known.find(look => sameList(look.shape, shape));
  const look = same && sameLookFocus(same.focus, focus) ? same : { bytes: same?.bytes ?? encodeLooks(clip, group), focus, shape };
  if (known[0] !== look) MADE.set(key, [look, ...known.filter(other => other !== same)].slice(0, MADE_PER_TRACK));
  return look;
}

/** Every segment's looks, by segment id ([segmentLook]): what a render hands each one. Empty for a post with no look. */
export function segmentLooks(manifest: Pick<EditManifest, 'clips' | 'videoTracks' | 'tracks'>): Map<string, SegmentLook> {
  const looks = new Map<string, SegmentLook>();
  if (!hasTrackLooks(manifest)) return looks;
  for (const clip of [...manifest.clips, ...manifest.videoTracks.flatMap(track => track.clips)]) {
    const look = segmentLook(clip, manifest.tracks);
    if (look) looks.set(clip.id, look);
  }
  return looks;
}

/** The tracks a segment's looks are drawn from, and which way round. */
interface LookGroup {
  /** Blurs: the things are softened and the world kept. Otherwise the things are kept and the world dimmed or greyed. */
  invert: boolean;
  tracks: EditTrack[];
}

/** The looked tracks segment `clip` draws: its blurs, or failing those its spotlights and pops. Null for none. */
function lookGroup(clip: LookedClip, tracks: readonly EditTrack[] | undefined): LookGroup | null {
  if (!tracks || focusChangesPicture(clip.focus)) return null;
  const on = tracks.filter(track => track.look && track.clipKey === clip.clipKey && onSegment(track, clip));
  if (on.length === 0) return null;
  const blurs = on.filter(track => track.look!.kind === 'blur');
  const group = blurs.length > 0 ? blurs : on;
  return { invert: blurs.length > 0, tracks: group.slice(0, MOST_LOOKED) };
}

/**
 * Whether a track's thing is on the segment at all: where its span meets the trim, and on the whole of it for a
 * track of one sample - a picture's - as `trackStretches` has it.
 */
function onSegment(track: EditTrack, clip: LookedClip): boolean {
  const at = track.atMs;
  if (at.length <= 1) return at.length === 1;
  return at[0]! <= clip.outMs && at[at.length - 1]! >= clip.inMs;
}

/**
 * What the bytes of a segment's looks are made from, as values and the tracks' own arrays: the same list is
 * the same bytes. Not the trim, which the frames do not depend on.
 */
function lookShape(clip: LookedClip, group: LookGroup): unknown[] {
  const shape: unknown[] = [group.invert, clip.image === true];
  for (const track of group.tracks) shape.push(track.atMs, track.x, track.y, track.scale, track.box.w, track.box.h, track.aspect, track.smooth, track.seams);
  return shape;
}

/**
 * The focus a segment's looks are read with: one key, at 0, which holds for ever - for a video and for a
 * picture, whose wire trim starts there ([ComposeClip.image]) alike - each ring of each track at its level,
 * and the look's own strength: a blur's sigma as `compileFocus` scales one, a spotlight's dark and a pop's
 * grey as they are.
 */
function lookFocus(group: LookGroup): Omit<ComposeFocus, 'uri'> {
  const rings = LOOK_RINGS.length;
  const first = firstId(group);
  const subjects: ComposeFocusSubject[] = group.invert ? [] : [{ id: LOOK_KEPT, focus: [1] }];
  for (let j = 0; j < group.tracks.length; j++) {
    for (let k = 0; k < rings; k++) subjects.push({ id: first + j * rings + k, focus: [LOOK_RINGS[k]!] });
  }
  const focus: Omit<ComposeFocus, 'uri'> = {
    atMs: [0],
    subjects,
    blur: group.invert ? round4(strongest(group.tracks, 'blur') * FOCUS_MAX_SIGMA) : 0,
  };
  // In the order `compileFocus` writes them, and only what says something, for its reason.
  if (group.invert) {
    focus.invert = true;
    return focus;
  }
  const mono = strongest(group.tracks, 'pop');
  if (mono > 0) focus.mono = round4(mono);
  const dim = strongest(group.tracks, 'spotlight');
  if (dim > 0) focus.dim = round4(dim);
  return focus;
}

/** The first track's middle id: after [LOOK_KEPT] for a spotlight or a pop, 1 for a blur. */
function firstId(group: LookGroup): number {
  return group.invert ? 1 : LOOK_KEPT + 1;
}

/** The strongest look of kind `kind` among `tracks`, 0 for none. */
function strongest(tracks: readonly EditTrack[], kind: TrackLook['kind']): number {
  let most = 0;
  for (const track of tracks) if (track.look?.kind === kind && track.look.amount > most) most = track.look.amount;
  return most;
}

function sameLookFocus(a: Omit<ComposeFocus, 'uri'>, b: Omit<ComposeFocus, 'uri'>): boolean {
  return (
    a.blur === b.blur &&
    a.mono === b.mono &&
    a.dim === b.dim &&
    a.invert === b.invert &&
    sameList(a.atMs, b.atMs) &&
    a.subjects.length === b.subjects.length &&
    a.subjects.every((subject, i) => subject.id === b.subjects[i]!.id && sameList(subject.focus, b.subjects[i]!.focus))
  );
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * The times the subject track has frames at, SOURCE ms, whole and strictly increasing: every track's samples,
 * and the instant either side of its span, on which its look is off. A picture's one frame is at 0, where its
 * key is, and so is the one frame of footage whose tracks are all of one sample, which holds throughout.
 */
function lookTimes(tracks: readonly EditTrack[], picture: boolean): number[] {
  if (picture) return [0];
  // Each time, and whether a look starts or stops on it, which keeps it however close the frame before is.
  const wanted = new Map<number, boolean>();
  const want = (t: number, edge: boolean): void => {
    if (t >= 0) wanted.set(t, edge || wanted.get(t) === true);
  };
  for (const track of tracks) {
    const at = track.atMs;
    const n = at.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) want(Math.round(at[i]!), i === 0 || i === n - 1);
    want(Math.round(at[0]!) - 1, true);
    want(Math.round(at[n - 1]!) + 1, true);
  }
  if (wanted.size === 0) return [0];
  const times: number[] = [];
  for (const t of [...wanted.keys()].sort((a, b) => a - b)) {
    const kept = times[times.length - 1];
    if (kept === undefined || wanted.get(t) === true || t - kept >= MIN_FRAME_GAP_MS) times.push(t);
  }
  return times;
}

/**
 * The subject track of a segment's looks: every frame drawn straight into its runs, a row at a time, and never
 * as a grid. `encodeSubjectTrack` takes every frame's grid at once, and a minute of footage tracked at 30 fps is
 * 1800 of them - a hundred megabytes on a phone - where here one row is kept, and each frame costs only the
 * cells its shapes reach. The layout is [SUBJECT_TRACK_MAGIC]'s, its JSON left out: it lists what an engine
 * found, for a reader that shows the subjects, and nobody found these.
 */
function encodeLooks(clip: LookedClip, group: LookGroup): Uint8Array {
  const tracks = group.tracks;
  const { width, height } = subjectGrid(tracks[0]!.aspect, 1);
  const times = lookTimes(tracks, clip.image === true);
  const paths = tracks.map(track => trackPath(track));
  const rings = LOOK_RINGS.length;
  const first = firstId(group);
  // Where no thing is on screen at all, every cell is left as it is: the background for a blur, which keeps
  // its world, and the kept id for a spotlight or a pop, which would otherwise dim and grey the whole frame.
  const idle = group.invert ? 0 : LOOK_KEPT;

  // One frame's shapes, and one row of cells, made once and filled again for every frame.
  const n = tracks.length;
  const cx = new Float64Array(n);
  const cy = new Float64Array(n);
  const rx = new Float64Array(n);
  const ry = new Float64Array(n);
  const base = new Uint16Array(n);
  const rowId = new Uint8Array(width);
  const rowRing = new Uint8Array(width).fill(NO_RING);
  // Where each ring of the shape being drawn starts and ends on the row, the rings inside it included.
  const spanFrom = new Int32Array(rings);
  const spanTo = new Int32Array(rings);
  /** Ring `ring`, id `id`, over cells `from..to` of the row, wherever no shape has put a ring further in. */
  const paint = (from: number, to: number, ring: number, id: number): void => {
    for (let c = from; c <= to; c++) {
      if (ring <= rowRing[c]!) {
        rowRing[c] = ring;
        rowId[c] = id;
      }
    }
  };
  // Each track's span as the frames' whole ms have it: off before its first sample and after its last, on
  // throughout for a track of one sample.
  const starts = tracks.map(track => (track.atMs.length > 1 ? Math.round(track.atMs[0]!) : -Infinity));
  const ends = tracks.map(track => (track.atMs.length > 1 ? Math.round(track.atMs[track.atMs.length - 1]!) : Infinity));

  const out = new RunWriter();
  const offsets = new Uint32Array(times.length);
  for (let f = 0; f < times.length; f++) {
    offsets[f] = out.length;
    const t = times[f]!;
    let shapes = 0;
    for (let j = 0; j < n; j++) {
      if (t < starts[j]! || t > ends[j]!) continue;
      const track = tracks[j]!;
      const here = pathAt(paths[j]!, t);
      // Half the box, grown: the ellipse inside it, a little larger, in fractions of the frame's width and height.
      const halfW = (track.box.w * here.scale * LOOK_REACH) / 2;
      const halfH = (track.box.h * here.scale * LOOK_REACH) / 2;
      if (!(halfW > 0 && halfH > 0)) continue;
      cx[shapes] = here.x;
      cy[shapes] = here.y;
      rx[shapes] = halfW;
      ry[shapes] = halfH;
      base[shapes] = first + j * rings;
      shapes++;
    }
    if (shapes === 0) {
      out.put(idle, width * height);
      out.endFrame();
      continue;
    }
    for (let gy = 0; gy < height; gy++) {
      // Cells are inside a ring when their CENTRE is, as `toGrid` reads a segmenter's mask.
      const v = (gy + 0.5) / height;
      let lo = width;
      let hi = -1;
      for (let s = 0; s < shapes; s++) {
        const dv = (v - cy[s]!) / ry[s]!;
        const dv2 = dv * dv;
        // Each ring's cells on this row, from the outermost in. A ring that misses the row has no smaller one inside it.
        let inner = rings;
        for (let k = rings - 1; k >= 0; k--) {
          const reach = RING_EDGES[k]! - dv2;
          if (!(reach > 0)) break;
          const half = rx[s]! * Math.sqrt(reach);
          const x0 = Math.max(0, Math.ceil((cx[s]! - half) * width - 0.5));
          const x1 = Math.min(width - 1, Math.floor((cx[s]! + half) * width - 0.5));
          if (x1 < x0) break;
          spanFrom[k] = x0;
          spanTo[k] = x1;
          inner = k;
        }
        if (inner === rings) continue;
        if (spanFrom[rings - 1]! < lo) lo = spanFrom[rings - 1]!;
        if (spanTo[rings - 1]! > hi) hi = spanTo[rings - 1]!;
        // Then each ring over only the cells it adds round the one inside it, so every cell is visited once a shape -
        // twenty rings cost hardly more than one - and ends on the innermost ring of any shape that covers it.
        paint(spanFrom[inner]!, spanTo[inner]!, inner, base[s]! + inner);
        for (let k = inner + 1; k < rings; k++) {
          paint(spanFrom[k]!, spanFrom[k - 1]! - 1, k, base[s]! + k);
          paint(spanTo[k - 1]! + 1, spanTo[k]!, k, base[s]! + k);
        }
      }
      if (hi < 0) {
        out.put(0, width);
        continue;
      }
      out.put(0, lo);
      for (let c = lo; c <= hi; c++) out.put(rowId[c]!, 1);
      out.put(0, width - 1 - hi);
      rowId.fill(0, lo, hi + 1);
      rowRing.fill(NO_RING, lo, hi + 1);
    }
    out.endFrame();
  }

  const frames = times.length;
  const file = new Uint8Array(HEADER_BYTES + 8 * frames + out.length);
  const view = new DataView(file.buffer);
  for (let i = 0; i < 4; i++) file[i] = SUBJECT_TRACK_MAGIC.charCodeAt(i);
  file[4] = SUBJECT_TRACK_VERSION;
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  view.setUint32(12, frames, true);
  // J, at 16, stays 0: no JSON.
  let at = HEADER_BYTES;
  for (const time of times) {
    view.setUint32(at, time, true);
    at += 4;
  }
  for (let f = 0; f < frames; f++) {
    view.setUint32(at, offsets[f]!, true);
    at += 4;
  }
  file.set(out.bytes.subarray(0, out.length), at);
  return file;
}

/**
 * A subject track's frames as they are written: each frame's cells as runs of a value byte and an unsigned
 * LEB128 run ([SUBJECT_TRACK_MAGIC]), into one buffer that doubles when it fills. A run is held back until a
 * different value ends it, so a row of one value joins the rows either side of it.
 */
class RunWriter {
  bytes = new Uint8Array(1 << 16);
  length = 0;
  private value = -1;
  private run = 0;

  /** `count` more cells of `value`. */
  put(value: number, count: number): void {
    if (count <= 0) return;
    if (value === this.value) {
      this.run += count;
      return;
    }
    this.flush();
    this.value = value;
    this.run = count;
  }

  /** The frame's last run written: the next [put] starts a new frame's first. */
  endFrame(): void {
    this.flush();
    this.value = -1;
    this.run = 0;
  }

  private flush(): void {
    if (this.run <= 0) return;
    // A value byte and at most five of run.
    if (this.length + 6 > this.bytes.length) {
      const grown = new Uint8Array(this.bytes.length * 2);
      grown.set(this.bytes);
      this.bytes = grown;
    }
    this.bytes[this.length++] = this.value;
    let rest = this.run;
    while (rest >= 0x80) {
      this.bytes[this.length++] = (rest & 0x7f) | 0x80;
      rest >>>= 7;
    }
    this.bytes[this.length++] = rest;
  }
}

function round4(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}
