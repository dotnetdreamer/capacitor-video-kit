import { describe, expect, it } from 'vitest';

import { timelineSlots, type EditClip, type TimelineSlot } from '../../editor';
import { continuesInPlace, slotIndexAt } from './preview-player';

/**
 * The two decisions the frame loop makes at a segment's edge: which segment a time belongs to, and
 * whether the next one carries on where this one stopped. Neither is arithmetic anybody can see go
 * wrong - a slip in the first plays the wrong clip for a frame, a slip in the second puts a load and
 * a black flash in the middle of a split the customer made to cut a single shot in two.
 */
function clip(id: string, clipKey: string, inMs: number, outMs: number, speed = 1): EditClip {
  return { id, clipKey, inMs, outMs, speed, volume: 1, muted: false };
}

/** Two halves of one shot, split at 2000ms of the source, then a second file after them. */
const SPLIT = timelineSlots({
  clips: [clip('a1', 'one', 0, 2000), clip('a2', 'one', 2000, 5000), clip('b', 'two', 0, 3000)],
});

function slotsOf(clips: EditClip[]): TimelineSlot[] {
  return timelineSlots({ clips });
}

describe('slotIndexAt', () => {
  it('has no answer for an empty timeline', () => {
    expect(slotIndexAt([], 0)).toBe(-1);
  });

  it('gives the segment the time falls inside', () => {
    expect(slotIndexAt(SPLIT, 0)).toBe(0);
    expect(slotIndexAt(SPLIT, 1999)).toBe(0);
    // A boundary belongs to the segment it starts, never to the one it ends.
    expect(slotIndexAt(SPLIT, 2000)).toBe(1);
    expect(slotIndexAt(SPLIT, 4999)).toBe(1);
    expect(slotIndexAt(SPLIT, 5000)).toBe(2);
  });

  it('gives the last segment the very end of the timeline, and anything past it', () => {
    // 8000ms is the whole post: no segment CONTAINS it, and a paused playhead sits there.
    expect(slotIndexAt(SPLIT, 8000)).toBe(2);
    expect(slotIndexAt(SPLIT, 99_999)).toBe(2);
  });

  it('measures in output time, so a sped-up segment is shorter than its trim', () => {
    // Four seconds of source at 2x is two seconds of the post.
    const fast = slotsOf([clip('a', 'one', 0, 4000, 2), clip('b', 'two', 0, 1000)]);
    expect(slotIndexAt(fast, 1999)).toBe(0);
    expect(slotIndexAt(fast, 2001)).toBe(1);
  });
});

describe('continuesInPlace', () => {
  it('is the two halves of a split: same file, and the cut is the same instant', () => {
    expect(continuesInPlace(SPLIT[0], SPLIT[1])).toBe(true);
  });

  it('allows the millisecond a split can round away', () => {
    const rounded = slotsOf([clip('a1', 'one', 0, 2000), clip('a2', 'one', 2001, 5000)]);
    expect(continuesInPlace(rounded[0], rounded[1])).toBe(true);
    const gapped = slotsOf([clip('a1', 'one', 0, 2000), clip('a2', 'one', 2002, 5000)]);
    expect(continuesInPlace(gapped[0], gapped[1])).toBe(false);
  });

  it('is not two segments of the same file that jump', () => {
    const jump = slotsOf([clip('a1', 'one', 0, 2000), clip('a2', 'one', 4000, 5000)]);
    expect(continuesInPlace(jump[0], jump[1])).toBe(false);
  });

  it('is never two different files, however the trims line up', () => {
    expect(continuesInPlace(SPLIT[1], SPLIT[2])).toBe(false);
  });
});
