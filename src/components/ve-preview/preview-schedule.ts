import { clamp, type TimelineSlot } from '../../editor';

/**
 * The arithmetic of playing the base track on TWO elements: what happens at the boundary ahead,
 * when the incoming clip goes onto the spare element, when that element is started so its clock is
 * already running at the boundary, where an element's position puts the playhead, and how two
 * clips share the speaker across a transition.
 *
 * Pure, so the numbers every frame of playback turns on are pinned down without a decoder. The
 * player is the one caller; see [PreviewPlayer] for what is done with them.
 */

/**
 * How long before a boundary the incoming clip is put on the spare element.
 *
 * Long enough for a load and a frame-exact seek on the slowest phone this runs on - the seek alone
 * is 390-460 ms on the Redmi Note 7, and the load comes before it - with room left over; short
 * enough that somebody watching a long clip is not holding a second decoder busy for a clip that is
 * still minutes away.
 */
export const PRELOAD_AHEAD_MS = 1500;

/**
 * The longest start stall worth planning around. A `play()` that takes longer than this to get the
 * clock moving is a phone in trouble, not a latency, and starting the next clip earlier still would
 * only make it run ahead everywhere else.
 */
export const MAX_START_LEAD_MS = 400;

/**
 * How far, in OUTPUT milliseconds, a transition's outgoing tail may be out of step with the clock
 * before anything is done about it - the same allowance a layer's element gets, and for the same
 * reason: a frame or two apart is invisible, and every correction costs something.
 */
export const TAIL_DRIFT_MS = 80;

/**
 * Past this, a tail is SEEKED back into step rather than eased there. A seek stalls the element it
 * is made on, and in the middle of a transition that is the outgoing picture stopping dead, so it is
 * kept for a tail that is hopelessly out - a phone that dropped a quarter of a second somewhere.
 */
export const TAIL_SEEK_MS = 400;

/** How quickly a tail is eased back: the rate that closes this much drift in a second. */
const CATCH_UP_MS = 500;
/** The most a tail's rate is moved by to catch up. A quarter faster is invisible on footage in motion. */
const MAX_CATCH_UP = 0.25;

/**
 * The playback rate, as a multiple of the clip's own speed, that brings a tail `behindMs` behind the
 * clock back into step: 1 inside [TAIL_DRIFT_MS], faster when it is behind, slower when it is ahead.
 *
 * Eased and not seeked, because the tail is on screen while it is corrected. The drift it corrects is
 * almost always the one the handover left - the incoming element's start stall guessed a few tens of
 * milliseconds wrong - and a rate a little off one closes that over a few frames with nothing to see,
 * where a seek would freeze the outgoing picture mid-transition for as long as the decoder took.
 */
export function catchUpRate(behindMs: number): number {
  if (!Number.isFinite(behindMs) || Math.abs(behindMs) <= TAIL_DRIFT_MS) return 1;
  return 1 + clamp(behindMs / CATCH_UP_MS, -MAX_CATCH_UP, MAX_CATCH_UP);
}

/**
 * What the base track does where one of its segments ends:
 *
 *  - `end`: nothing follows; the post ends, or its tail starts.
 *  - `split`: the next segment picks the same file up at the same instant, so the element simply
 *    plays on - no load, no seek, no second element.
 *  - `cut`: anything else with no transition. The next clip starts on the spare element.
 *  - `transition`: the next clip starts on the spare element while this one plays on UNDER it for
 *    the length of the transition. A transition is checked before a split, because the two halves of
 *    a split with a transition between them are two moments of one file on screen at once, and one
 *    element cannot be at two moments of its file.
 */
export type BoundaryKind = 'end' | 'split' | 'cut' | 'transition';

export function boundaryKind(slot: TimelineSlot, next: TimelineSlot | undefined): BoundaryKind {
  if (!next) return 'end';
  if (next.transitionInMs > 0) return 'transition';
  return continuesInPlace(slot, next) ? 'split' : 'cut';
}

/** The segment playing at `ms`; the very end of the timeline belongs to the last one. */
export function slotIndexAt(slots: readonly TimelineSlot[], ms: number): number {
  if (!slots.length) return -1;
  const index = slots.findIndex(slot => ms < slot.startMs + slot.durationMs);
  return index >= 0 ? index : slots.length - 1;
}

/** Whether `next` picks up the same source exactly where `slot` leaves it - the two halves of a split. */
export function continuesInPlace(slot: TimelineSlot, next: TimelineSlot): boolean {
  return slot.clip.clipKey === next.clip.clipKey && Math.abs(next.clip.inMs - slot.clip.outMs) <= 1;
}

/**
 * Where on the output timeline an element playing `slot`'s clip has got to, from its position in the
 * file.
 *
 * NOT held to the slot. Past the slot's end is the next slot's time, and that is the answer the
 * compositor wants: the frame loop that moves the playhead on and the one that paints run in two
 * animation-frame callbacks in no fixed order, so the painter can be the first to see the clock cross
 * a boundary, and it has to be able to paint the far side of it from the same reading.
 */
export function outputMsAt(slot: TimelineSlot, sourceMs: number): number {
  return slot.startMs + (sourceMs - slot.clip.inMs) / (slot.clip.speed || 1);
}

/**
 * Where in its FILE a slot's own stretch of the timeline ends: the clip's out point, less the tail
 * the next clip's transition starts over. It is the out point itself at a cut, and where a
 * transition hands the clock to the incoming clip otherwise.
 */
export function slotEndSourceMs(slot: TimelineSlot): number {
  return slot.clip.inMs + slot.durationMs * (slot.clip.speed || 1);
}

/** Whether, at output `at`, the incoming clip of `next` should already be waiting on the spare element. */
export function preloadDue(at: number, next: TimelineSlot): boolean {
  return next.startMs - at <= PRELOAD_AHEAD_MS;
}

/**
 * Whether the spare element, waiting on the first frame of `next`, should be started now.
 *
 * `leadMs` is how long this element's clock stands still after a `play()`, as last measured: started
 * that far ahead of the boundary, the stall is over by the time the boundary arrives and the incoming
 * clip is already moving on its first frame. Started AT the boundary, it would sit on that frame for
 * the whole stall - 100 to 200 ms on an Android WebView, which is exactly the hitch at every cut this
 * exists to take away.
 */
export function prerollDue(at: number, next: TimelineSlot, leadMs: number): boolean {
  return at >= next.startMs - clamp(leadMs, 0, MAX_START_LEAD_MS);
}

/**
 * The two clips' shares of the sound at progress `p` through a transition: linear both ways, so the
 * two always add up to one - the same ramps the export's mixdown lays the tail and the incoming clip
 * down with, so a clip dissolving into more of the same scene neither dips nor swells at the join.
 */
export function crossfade(progress: number): { from: number; to: number } {
  const p = Number.isFinite(progress) ? clamp(progress, 0, 1) : 0;
  return { from: 1 - p, to: p };
}

/**
 * How long an element's clock stood still after `play()`: the wall time since, less the footage it
 * has covered in it.
 *
 * Null for a reading that cannot be a stall - an element that went BACKWARDS (it was seeked), or one
 * that covered a good deal more footage than the time allowed (it was seeked forwards) - and for one
 * past [MAX_START_LEAD_MS], which is a phone stuttering rather than an output starting up.
 */
export function startStallMs(elapsedMs: number, advancedSourceMs: number, rate: number): number | null {
  if (!(elapsedMs > 0) || !Number.isFinite(advancedSourceMs) || advancedSourceMs < 0) return null;
  const stall = elapsedMs - advancedSourceMs / (rate || 1);
  // A few milliseconds under nothing is the two clocks being read a moment apart; more is a jump.
  if (stall < -40 || stall > MAX_START_LEAD_MS) return null;
  return Math.max(0, stall);
}

/**
 * The lead to plan the next start with, from the stall just measured and the one before it. Halfway
 * between the two, so one garbage-collection pause landing inside a measurement cannot throw the next
 * boundary off by the length of that pause.
 */
export function nextLeadMs(previous: number | undefined, stall: number): number {
  const next = previous === undefined ? stall : (previous + stall) / 2;
  return clamp(next, 0, MAX_START_LEAD_MS);
}
