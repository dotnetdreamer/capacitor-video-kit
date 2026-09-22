import type { Peaks } from '../../web-runtime/waveform';

/*
 * Turning measured peaks into the picture on an audio bar.
 *
 * The audio half of `timeline-geometry.ts`, and free of the DOM for the same reason: all of this
 * is arithmetic, and arithmetic is worth testing on its own. Same coordinate system too - CONTENT
 * pixels, measured from the left edge of the scrolling content, where output time `t` sits at
 * `pad + t / 1000 * pps`.
 *
 * The one idea the whole file turns on: a waveform is measured in SOURCE time and drawn in OUTPUT
 * time, and those are not the same clock. Trimming a track changes which part of the source a bar
 * shows; moving it changes where on the screen that part lands; LOOPING makes one stretch of
 * source appear at several places at once. So every bar asks "what part of the file is heard
 * here?" rather than reading peaks straight off an index - which is [WaveSource]'s only job.
 */

/** A bar and the gap after it. 3 px of pitch is TikTok's, and reads as a wave rather than as bricks. */
export const WAVE_BAR_PX = 2;
export const WAVE_GAP_PX = 1;
export const WAVE_PITCH_PX = WAVE_BAR_PX + WAVE_GAP_PX;

/**
 * The drawing's own vertical units, which are NOT pixels.
 *
 * The SVG carries `viewBox="0 0 w 100"` with `preserveAspectRatio="none"`, so x is real pixels and
 * y is a percentage of whatever the lane happens to be. That is what lets the 40 px lane and the
 * 36 px compact one share one path with no measuring and no redraw when a sheet opens.
 */
export const WAVE_VIEW_H = 100;

/**
 * The loudest bar fills 76% of the lane, not all of it.
 *
 * A wave that touches both edges reads as clipping - as a file recorded too hot - and it leaves
 * the filename with nothing to sit on. The margin is what makes the bar still look like a bar.
 */
const WAVE_MAX_UNITS = 76;

/**
 * Even silence draws a hairline.
 *
 * This is the one distinction in the whole feature worth being careful about: a bar with a thin
 * line through it says "measured, and there is nothing here", and a bar with NOTHING through it
 * says "not measured yet". Collapsing the two would turn every quiet intro into a loading state.
 * 3 units of 100 is about 1.2 px at the normal lane height.
 */
const WAVE_MIN_UNITS = 3;

/**
 * How far a quiet track may be turned up to make its shape readable.
 *
 * Normalising at all is the point - the customer is looking for beats and pauses, not for absolute
 * level, and the complaint that starts this feature is that the bar looks flat. But an unbounded
 * gain turns a near-silent file into a wall of noise that means nothing, so the lift stops at 8x
 * (18 dB) and a genuinely quiet recording is allowed to look quiet.
 */
const WAVE_MAX_GAIN = 8;

/**
 * Where a moment of OUTPUT time falls inside the source file.
 *
 * A function rather than an `EditMusic`, because the voiceover lane wants the same painter with a
 * far simpler answer, and because it keeps this file from importing the manifest.
 */
export interface WaveSource {
  /** Source ms heard at this output ms, or null when this sound is not heard there at all. */
  at(outputMs: number): number | null;
  /**
   * Source ms at which the sound stops being heard for good.
   *
   * The LAST bar of any sound needs this: its right edge is past the end, so `at()` answers null
   * there and there is no other way to know how far to read. Getting it wrong is not subtle - it
   * first read to the end of the FILE, which ended a three-minute song under a fifteen-second post
   * on a bar as tall as a chorus two minutes after anything was audible.
   *
   * It is where the sound stops, NOT where the trim ends: a track cut short by the end of the post
   * stops earlier than its own out-point, and a repeating one stops partway through whichever pass
   * the post ends in.
   */
  endsAtMs: number;
  /**
   * The stretch of source that plays over and over, or null for a sound heard once.
   *
   * Needed because `at()` alone cannot describe a bar that straddles the seam where the track
   * starts over: its two edges map to source times that run BACKWARDS, and reading between them
   * would give an empty span in the one place two different parts of the track are heard at once.
   */
  repeat: { fromMs: number; toMs: number } | null;
}

/** One bar: where it starts, and how loud it is. */
export interface WaveBar {
  /** Left edge, relative to the drawn slice's own left edge. */
  x: number;
  /** 0..1 after normalising, where 0 is measured silence. */
  amp: number;
}

/** The slice of an audio bar that is worth drawing, and the path that draws it. */
export interface WaveView {
  /** Left edge of the slice, relative to the ITEM's own left edge. */
  x: number;
  /** Its width. The SVG's `width`, and the `w` of its `viewBox`. */
  w: number;
  /** The path, in a `0 0 w 100` viewBox. */
  d: string;
}

/**
 * The loudest measurement in `[fromMs, toMs)` of source time, 0..255.
 *
 * Past the end of what was measured it is 0, which is what draws a track whose length could not be
 * read: the picture simply stops where the samples do, instead of stretching or repeating to fill
 * a bar whose width came from somewhere else.
 *
 * The ends round OUTWARDS - `floor` at the start and `ceil` at the end - so a measurement the span
 * only partly covers still counts, and nothing is missed at the joins between bars. What it must
 * not do is round both ends outwards when the span ends exactly ON a boundary, which is the usual
 * case: bars are laid end to end, so `toMs` is the next bar's `fromMs`, and counting the bucket it
 * opens would draw every transient one bar wide on each side of where it happens.
 */
export function peakBetween(wave: Peaks, fromMs: number, toMs: number): number {
  const { peaks, stepMs } = wave;
  if (peaks.length === 0 || stepMs <= 0) return 0;

  // Wholly before the start of the sound is silence, not its first measurement. Unreachable from
  // `spanPeak`, whose source times never run below the trim, but this is exported on its own.
  if (Math.max(fromMs, toMs) < 0) return 0;

  const lo = Math.max(0, Math.min(fromMs, toMs));
  const hi = Math.max(lo, Math.max(fromMs, toMs));
  let i = Math.floor(lo / stepMs);
  if (i >= peaks.length) return 0;
  /*
   * At least `i`, so a span of no width still reads the one measurement it stands on.
   *
   * The nudge is not cosmetic. A bar's edges come from `px / pps * 1000`, which at most zooms is
   * not exact - at 64 px a second a bar meant to end at 500 ms ends at 500.00000000000006 - and a
   * bare `ceil` reads that as the next measurement having started. Every bar would then be one
   * measurement wide more than it should be, which is exactly the smear this rounding avoids.
   */
  const last = Math.min(peaks.length - 1, Math.max(i, Math.ceil(hi / stepMs - 1e-9) - 1));

  let best = 0;
  for (; i <= last; i++) if (peaks[i] > best) best = peaks[i];
  return best;
}

/**
 * The loudest part of the source heard across one bar, or null when nothing is heard there.
 *
 * Null and 0 are different answers and the caller must keep them apart: null is a bar that should
 * not be drawn at all (the item is wider than the sound, which `MIN_ITEM_PX` alone can cause), 0
 * is a bar that was measured and found silent.
 */
function spanPeak(wave: Peaks, source: WaveSource, fromMs: number, toMs: number): number | null {
  const a = source.at(fromMs);
  if (a === null) return null;

  const repeat = source.repeat;

  /*
   * A bar at least as wide as the repeat hears all of it, and this has to be asked FIRST.
   *
   * Zoomed out, one 3 px bar can span several passes of a short loop - and its two edges can then
   * land on the same place in the source, or even in order, which every test below would read as
   * an ordinary span and draw as the sliver between them. A bar covering the whole track five
   * times over must be as tall as the loudest thing in it.
   */
  if (repeat && toMs - fromMs >= repeat.toMs - repeat.fromMs) return peakBetween(wave, repeat.fromMs, repeat.toMs);

  const b = source.at(toMs);

  // The bar runs past the last moment this sound is heard, so read to exactly there and no further.
  if (b === null) return peakBetween(wave, a, Math.max(a, source.endsAtMs));

  if (b >= a) return peakBetween(wave, a, b);

  // Source time went backwards, so the bar straddles the seam where the track starts over.
  if (!repeat) return peakBetween(wave, a, a);
  // The ordinary seam: the tail of one repetition and the head of the next, both heard in this bar.
  return Math.max(peakBetween(wave, a, repeat.toMs), peakBetween(wave, repeat.fromMs, b));
}

/**
 * The bars of one audio item that fall inside `[winLeft, winRight)` (content px).
 *
 * Window-clipped for the same reason `segmentTiles` is, only more urgently: an audio item is a
 * SINGLE element spanning its whole window, and at `MAX_PPS` a three-minute track is 57 600 px
 * wide - past what a canvas will allocate, and around 19 000 bars if every one were drawn. What is
 * built instead is the viewport and a little either side, which is a few hundred bars whatever the
 * zoom and whatever the length of the track.
 *
 * The grid is anchored to the ITEM's left edge, not to content px. A sound dragged along the
 * timeline has to carry its picture with it; bars pinned to the content grid would instead have
 * the wave flowing backwards under a bar that was supposed to be moving.
 */
export function waveBars(args: {
  wave: Peaks;
  source: WaveSource;
  pps: number;
  /**
   * OUTPUT ms at the item's left edge - `music.startMs`, or a take's.
   *
   * Given rather than worked back out of `itemX - pad`, and that is not a shortcut. The item's
   * own x is `pad + startMs / 1000 * pps`, so undoing it is `(pad + s - pad) * 1000 / pps`, which
   * in IEEE-754 lands an ulp BELOW `startMs` about a quarter of the time. `at()` reads a hair
   * before the start as "not heard yet" and the whole first bar vanishes - and because it depends
   * on the zoom, it blinks in and out during a pinch.
   */
  itemStartMs: number;
  /** The item's left edge and width, content px. */
  itemX: number;
  itemW: number;
  winLeft: number;
  winRight: number;
}): { x: number; w: number; bars: WaveBar[] } | null {
  const { wave, source, pps, itemStartMs, itemX, itemW, winLeft, winRight } = args;
  if (pps <= 0 || itemW <= 0 || wave.peaks.length === 0) return null;

  // The item, clipped to what is worth drawing, expressed against the item's own left edge.
  const from = Math.max(0, winLeft - itemX);
  const to = Math.min(itemW, winRight - itemX);
  if (to <= from) return null;

  const firstK = Math.floor(from / WAVE_PITCH_PX);
  const lastK = Math.ceil(to / WAVE_PITCH_PX) - 1;
  if (lastK < firstK) return null;

  /*
   * One gain for the whole track, from the loudest bucket in the FILE rather than the loudest in
   * view. A per-view gain would make the wave breathe as the timeline scrolled, and would draw the
   * quiet intro of a loud song at the same height as its chorus.
   */
  const gain = wave.max > 0 ? Math.min(255 / wave.max, WAVE_MAX_GAIN) : 0;
  const msPerPx = 1000 / pps;

  const bars: WaveBar[] = [];
  for (let k = firstK; k <= lastK; k++) {
    const barX = k * WAVE_PITCH_PX;
    // Measured from the item's own start, so bar 0 begins exactly where the sound does.
    const fromMs = itemStartMs + barX * msPerPx;
    const toMs = itemStartMs + (barX + WAVE_PITCH_PX) * msPerPx;
    const peak = spanPeak(wave, source, fromMs, toMs);
    if (peak === null) continue;
    bars.push({ x: barX - firstK * WAVE_PITCH_PX, amp: Math.min(1, (peak * gain) / 255) });
  }
  if (!bars.length) return null;

  return { x: firstK * WAVE_PITCH_PX, w: (lastK - firstK + 1) * WAVE_PITCH_PX, bars };
}

/**
 * The bars as one path, mirrored about the middle of the lane.
 *
 * One `<path>` and not one element per bar: a few hundred nodes would go through the vdom on every
 * frame of every drag anywhere on the timeline, where a path is a single attribute that Stencil
 * compares as a string.
 */
export function wavePath(bars: readonly WaveBar[]): string {
  let d = '';
  for (const bar of bars) {
    const h = Math.max(WAVE_MIN_UNITS, bar.amp * WAVE_MAX_UNITS);
    const top = round((WAVE_VIEW_H - h) / 2);
    d += `M${round(bar.x)} ${top}h${WAVE_BAR_PX}v${round(h)}h${-WAVE_BAR_PX}z`;
  }
  return d;
}

/** Everything above, composed: the picture of one audio item as it is right now, or null. */
export function waveView(args: Parameters<typeof waveBars>[0]): WaveView | null {
  const built = waveBars(args);
  return built && { x: built.x, w: built.w, d: wavePath(built.bars) };
}

/** Two decimals is under a thousandth of a lane and keeps the path string short. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
