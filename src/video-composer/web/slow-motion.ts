import type { PlannedClip } from './plan';
import { sourceTimeUs } from './plan';

/**
 * Slow motion that moves: which two SOURCE frames an instant of a slowed clip is made from, and how
 * far it is from one to the other.
 *
 * A clip slowed below 1x runs out of frames. 30 fps footage at 0.5x has fifteen distinct pictures in
 * each second of the post and at 0.3x about nine, and an engine that draws "whatever frame the source
 * has at this moment" - which is every engine this package has, see `ComposeOutput.fps` - repeats each
 * of them two or three times over. That is the stutter a template's 0.3x hit on the beat had, and the
 * camera move over it made it worse: a zoom that glides across a picture that jerks.
 *
 * So an instant of a slowed clip is drawn from TWO source frames. For the source time `s` the output
 * instant maps to: frame A is the last one presented at or before `s`, frame B is the one after it,
 * and the picture is `mix(A, B, w)` with `w` the fraction of the way from A's timestamp to B's that
 * `s` has come. The mixing itself is one step, in `frame-interpolation.ts`, so a later phase can put
 * motion-compensated interpolation there without touching any of this: which frames, and how far
 * between them, is the same question whatever answers it.
 *
 * The frames are the source's REAL ones, at their real timestamps - read from the container, not
 * assumed from a nominal rate - because a phone's recording is rarely the constant 30 fps it says it
 * is: low light stretches frames, and a clip whose frames were taken to be evenly spaced would be
 * blended by the wrong amounts and lurch where the recording did.
 *
 * The rules every engine keeps, so the preview, the web export and the Android export agree (the
 * Android half is `SlowMotion.kt`):
 *
 *  - ONLY a video clip slower than 1x is synthesised. At 1x or faster every output frame already has a
 *    source frame of its own to be, and a picture has one frame; both are drawn exactly as they were
 *    before any of this existed - the same draw, the same pixels.
 *  - Only the clip's OWN frames take part: those stamped at or after its in point and before its out
 *    point. Android's decoder is handed the trimmed clip and never sees another, and a frame the
 *    customer trimmed away has no business in the picture - not even blended in at a sixth.
 *  - A is the last of those at or before `s`, B the one after it, `w` how far from A's time to B's
 *    `s` has come.
 *  - Before the clip's first frame - an in point between two frames - that first frame is HELD, and
 *    after its last frame the last is held: there is no frame on the other side to blend with.
 *  - `w` is taken on the SOURCE timeline, so a variable frame rate is blended by the time that actually
 *    passed between the two frames.
 *
 * Where the engines still differ is only where on the source timeline the output's frames fall: the
 * web export draws at the post's own frame instants (`atUs = index / fps`), as it always has, and
 * Android at instants counted from each slowed clip's first frame. That is a fraction of a frame of
 * phase, the same fraction the two already differ by at 1x.
 */

/**
 * The weight below which B is not drawn at all. A 1/512 mix moves no 8-bit value by a whole step, so
 * the frame is A's to the eye and to the encoder, and B need not be decoded for it - which is every
 * output instant that lands exactly on a source frame, the first frame of every slowed clip among
 * them.
 */
export const MIN_TWEEN_WEIGHT = 1 / 512;

/**
 * Two timestamps closer than this are one frame. A container can carry the same presentation time
 * twice - a duplicated packet, an edit - and a pair of frames zero seconds apart has no fraction
 * between them.
 */
const SAME_FRAME_S = 1e-6;

/** The two frames an instant is made from. Indices are into the clip's file's frame times. */
export interface FramePair {
  /** The last frame at or before the instant. */
  a: number;
  /** The frame after A, or -1 where A is the file's last. */
  b: number;
  /** 0..1 from A towards B; 0 wherever B is not drawn. */
  weight: number;
}

/**
 * Whether a planned clip is drawn from synthesised frames: a video slower than 1x, and nothing else.
 * Every other clip takes the path it always took.
 */
export function isSlowMotion(clip: PlannedClip): boolean {
  return clip.speed < 1 && !clip.clip.image;
}

/**
 * The frame times of a file, as the renderer searches them: ascending, each frame once, in SECONDS on
 * the media element's timeline - which is the container's presentation timeline, edit list applied.
 *
 * A demuxer hands packets over in DECODE order, and a stream with B-frames presents them in another,
 * so the list is sorted here rather than trusted. Anything that is not a finite number is dropped.
 */
export function frameTimes(timestamps: Iterable<number>): Float64Array {
  const sorted = [...timestamps].filter(Number.isFinite).sort((x, y) => x - y);
  const kept: number[] = [];
  for (const time of sorted) {
    const last = kept[kept.length - 1];
    if (last === undefined || time - last > SAME_FRAME_S) kept.push(time);
  }
  return Float64Array.from(kept);
}

/** The piece of a file a clip plays, in source seconds: from its in point, up to but not including its out point. */
export interface SourceWindow {
  from: number;
  to: number;
}

/**
 * The frames an instant `seconds` into the SOURCE is made from, or null for a file with no frames.
 *
 * `window` is the clip's own piece of the file, and only frames inside it are used - see the rules
 * at the top of this file. A clip too short to hold a single frame of its own (a trim that falls
 * between two) is the frame that covers the instant, alone, which is what the plain path draws.
 *
 * Binary searches, because a minute of 60 fps footage is 3600 frames and the render asks once per
 * output frame per slowed layer.
 */
export function framePairAt(times: ArrayLike<number>, seconds: number, window?: SourceWindow): FramePair | null {
  const count = times.length;
  if (count === 0) return null;
  // The clip's first and last frames: at or after its in point, and before its out point. The
  // tolerance is the one two frames are told apart by, so a frame stamped a rounding error before an
  // in point computed in microseconds is still the clip's.
  const first = window ? firstAtOrAfter(times, window.from - SAME_FRAME_S) : 0;
  const last = window ? firstAtOrAfter(times, window.to - SAME_FRAME_S) - 1 : count - 1;
  if (first > last) return { a: lastAtOrBefore(times, seconds, 0, count - 1), b: -1, weight: 0 };
  // Before the clip's first frame, and after its last, the frame there is is held.
  if (!(seconds + SAME_FRAME_S >= (times[first] ?? 0))) return { a: first, b: -1, weight: 0 };
  const a = lastAtOrBefore(times, seconds, first, last);
  if (a >= last) return { a, b: -1, weight: 0 };
  const from = times[a] ?? 0;
  const to = times[a + 1] ?? from;
  const span = to - from;
  const raw = span > 0 ? (seconds - from) / span : 0;
  const weight = raw < MIN_TWEEN_WEIGHT ? 0 : Math.min(1, raw);
  return { a, b: a + 1, weight };
}

/**
 * The frames the instant `offsetIntoClipUs` into a slowed clip's place on the OUTPUT timeline is made
 * from: the renderer's own mapping to the source (`sourceTimeUs`, speed and trim applied), and then
 * [framePairAt] over the clip's own frames. The one call the render makes, and the one the unit tests
 * pin a clip's frames with.
 */
export function slowFramesAt(clip: PlannedClip, offsetIntoClipUs: number, times: ArrayLike<number>): FramePair | null {
  return framePairAt(times, sourceTimeUs(clip, Math.max(0, offsetIntoClipUs)) / 1_000_000, clipWindow(clip));
}

/** A planned clip's own piece of its file, in source seconds. */
export function clipWindow(clip: PlannedClip): SourceWindow {
  return { from: clip.inUs / 1_000_000, to: clip.outUs / 1_000_000 };
}

/**
 * The last index in `low..high` whose time is at or before `seconds` - give or take the tolerance two
 * frames are told apart by, so an instant computed in microseconds that lands a rounding error short
 * of a frame is that frame and not the end of the one before it - or `low` when none is.
 */
function lastAtOrBefore(times: ArrayLike<number>, seconds: number, low: number, high: number): number {
  while (low < high) {
    const middle = (low + high + 1) >> 1;
    if ((times[middle] ?? Infinity) <= seconds + SAME_FRAME_S) low = middle;
    else high = middle - 1;
  }
  return low;
}

/** The first index whose time is at or after `seconds`, or the count when none is. */
function firstAtOrAfter(times: ArrayLike<number>, seconds: number): number {
  let low = 0;
  let high = times.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((times[middle] ?? Infinity) < seconds) low = middle + 1;
    else high = middle;
  }
  return low;
}

/**
 * Where to put a media element so that it shows frame `index` and no other: the MIDDLE of the time
 * that frame is on screen, in seconds.
 *
 * A seek to a frame's own timestamp is a seek to the boundary between two frames, and which side a
 * browser lands on is the kind of thing that changes between versions and differs by a microsecond of
 * float rounding. The middle is half a frame from either edge, so it is that frame on every browser
 * and survives a demuxer and a decoder that disagree about a timestamp by less than half a frame. The
 * last frame, with nothing after it to measure against, is taken to last as long as the one before.
 */
export function frameSeekTarget(times: ArrayLike<number>, index: number): number {
  const at = times[index] ?? 0;
  const next = times[index + 1];
  if (next !== undefined) return (at + next) / 2;
  const before = times[index - 1];
  return before !== undefined ? at + (at - before) / 2 : at;
}
