import { describe, expect, it } from 'vitest';

import { timelineSlots, type EditClip } from '../../editor';
import {
  MAX_START_LEAD_MS,
  PRELOAD_AHEAD_MS,
  TAIL_DRIFT_MS,
  TAIL_SETTLED_MS,
  boundaryAfterSplits,
  boundaryKind,
  catchUpRate,
  easedTailRate,
  crossfade,
  nextLeadMs,
  outputMsAt,
  preloadDue,
  prerollDue,
  slotEndSourceMs,
  startStallMs,
} from './preview-schedule';

/**
 * The numbers the two base elements are run by. Nothing here is visible on its own - but a slip in
 * any of them is a freeze at a cut, a transition that starts a beat late, a tail that runs into
 * footage the clip was trimmed off, or two clips heard at once after the window has closed.
 */
function clip(id: string, clipKey: string, inMs: number, outMs: number, extra: Partial<EditClip> = {}): EditClip {
  return { id, clipKey, inMs, outMs, speed: 1, volume: 1, muted: false, ...extra };
}

describe('boundaryKind', () => {
  it('ends the base track after its last segment', () => {
    const [only] = timelineSlots({ clips: [clip('a', 'one', 0, 2000)] });
    expect(boundaryKind(only, undefined)).toBe('end');
  });

  it('plays straight on through the two halves of a split', () => {
    const [a, b] = timelineSlots({ clips: [clip('a', 'one', 0, 2000), clip('b', 'one', 2000, 4000)] });
    expect(boundaryKind(a, b)).toBe('split');
  });

  it('cuts to a different file, and to a jump in the same one', () => {
    const [a, b, c] = timelineSlots({ clips: [clip('a', 'one', 0, 2000), clip('b', 'two', 0, 2000), clip('c', 'two', 3000, 5000)] });
    expect(boundaryKind(a, b)).toBe('cut');
    expect(boundaryKind(b, c)).toBe('cut');
  });

  it('is a transition before it is a split: two moments of one file on screen take two elements', () => {
    const [a, b] = timelineSlots({
      clips: [clip('a', 'one', 0, 2000), clip('b', 'one', 2000, 4000, { transitionIn: { kind: 'dissolve', durationMs: 500 } })],
    });
    expect(boundaryKind(a, b)).toBe('transition');
  });
});

describe('where an element puts the clock', () => {
  const [a, b] = timelineSlots({
    clips: [clip('a', 'one', 1000, 5000, { speed: 2 }), clip('b', 'two', 0, 4000, { transitionIn: { kind: 'dissolve', durationMs: 500 } })],
  });

  it('counts output time from the clip in point at its own speed', () => {
    // Two seconds of output, half a second of which the next clip takes over.
    expect(a.durationMs).toBe(1500);
    expect(outputMsAt(a, 1000)).toBe(0);
    expect(outputMsAt(a, 3000)).toBe(1000);
  });

  it('runs on past the slot, into the time of the clip after it', () => {
    // The painter can be the first to see the clock cross; it has to be able to paint the far side.
    expect(outputMsAt(a, 5000)).toBe(2000);
    expect(outputMsAt(a, 5000)).toBeGreaterThan(b.startMs);
  });

  it("hands over where the next clip's transition starts, not at the out point", () => {
    // The last half second of output is 1000 ms of a 2x source: the tail the incoming clip covers.
    expect(slotEndSourceMs(a)).toBe(4000);
    expect(outputMsAt(a, slotEndSourceMs(a))).toBe(b.startMs);
    // With no transition after it, a slot ends on its out point exactly.
    expect(slotEndSourceMs(b)).toBe(4000);
  });
});

describe('the spare element, ahead of a boundary', () => {
  const [, next] = timelineSlots({ clips: [clip('a', 'one', 0, 5000), clip('b', 'two', 0, 3000)] });

  it('is loaded a second and a half before the boundary, and not before', () => {
    expect(next.startMs).toBe(5000);
    expect(preloadDue(5000 - PRELOAD_AHEAD_MS - 1, next)).toBe(false);
    expect(preloadDue(5000 - PRELOAD_AHEAD_MS, next)).toBe(true);
    expect(preloadDue(4999, next)).toBe(true);
  });

  it('is started one start stall early, so it is moving when the boundary comes', () => {
    expect(prerollDue(4879, next, 120)).toBe(false);
    expect(prerollDue(4880, next, 120)).toBe(true);
  });

  it('is never started earlier than the longest stall worth planning for', () => {
    expect(prerollDue(5000 - MAX_START_LEAD_MS - 1, next, 5000)).toBe(false);
    expect(prerollDue(5000 - MAX_START_LEAD_MS, next, 5000)).toBe(true);
    // A lead measured as nothing starts it on the boundary itself.
    expect(prerollDue(4999, next, -30)).toBe(false);
    expect(prerollDue(5000, next, -30)).toBe(true);
  });
});

describe('learning how long a start stalls', () => {
  it('is the wall time gone less the footage covered', () => {
    // 300 ms of wall time, 180 ms of footage: the clock stood still for 120.
    expect(startStallMs(300, 180, 1)).toBe(120);
    // At 2x, 360 ms of footage is 180 ms of real time.
    expect(startStallMs(300, 360, 2)).toBe(120);
  });

  it('reads a start that did not stall at all as none, whichever clock was read first', () => {
    expect(startStallMs(300, 310, 1)).toBe(0);
  });

  it('refuses a reading that cannot be a stall', () => {
    // Went backwards: somebody seeked it.
    expect(startStallMs(300, -500, 1)).toBeNull();
    // Covered far more than the time allowed: seeked forwards.
    expect(startStallMs(300, 900, 1)).toBeNull();
    // Stood still for longer than any output takes to start: a phone in trouble.
    expect(startStallMs(900, 10, 1)).toBeNull();
    expect(startStallMs(0, 0, 1)).toBeNull();
  });

  it('meets the last lead halfway, so one bad reading cannot throw the next boundary off', () => {
    expect(nextLeadMs(undefined, 150)).toBe(150);
    expect(nextLeadMs(100, 200)).toBe(150);
    expect(nextLeadMs(100, 10_000)).toBe(MAX_START_LEAD_MS);
  });
});

describe('two clips sharing the speaker across a transition', () => {
  it('fades the outgoing clip down as the incoming one comes up, the two always adding to one', () => {
    for (const p of [0, 0.1, 0.25, 0.5, 0.9, 1]) {
      const share = crossfade(p);
      expect(share.from + share.to).toBeCloseTo(1, 10);
      expect(share.to).toBeCloseTo(p, 10);
    }
  });

  it('holds the ends, and reads nonsense as the start', () => {
    expect(crossfade(-1)).toEqual({ from: 1, to: 0 });
    expect(crossfade(2)).toEqual({ from: 0, to: 1 });
    expect(crossfade(Number.NaN)).toEqual({ from: 1, to: 0 });
  });
});

describe('keeping a tail in step', () => {
  it('leaves a tail alone inside the allowance', () => {
    expect(catchUpRate(0)).toBe(1);
    expect(catchUpRate(TAIL_DRIFT_MS)).toBe(1);
    expect(catchUpRate(-TAIL_DRIFT_MS)).toBe(1);
  });

  it('runs a tail that is behind a little faster, and one that is ahead a little slower', () => {
    expect(catchUpRate(100)).toBeCloseTo(1.2, 6);
    expect(catchUpRate(-100)).toBeCloseTo(0.8, 6);
  });

  it('never moves the rate by more than a quarter', () => {
    expect(catchUpRate(1000)).toBe(1.25);
    expect(catchUpRate(-1000)).toBe(0.75);
    expect(catchUpRate(Number.NaN)).toBe(1);
  });
});

describe('easing a tail without setting its rate on every frame', () => {
  it('leaves a tail that is in step at its own rate', () => {
    expect(easedTailRate(0, 1)).toBe(1);
    expect(easedTailRate(TAIL_DRIFT_MS, 1)).toBe(1);
    expect(easedTailRate(Number.NaN, 1)).toBe(1);
  });

  it('moves the rate in whole steps, so a drift closing frame by frame changes it only now and then', () => {
    const rates = new Set<number>();
    // A tail 200 ms behind, closing a couple of milliseconds a frame.
    let current = 1;
    for (let behind = 200; behind > 0; behind -= 2) {
      current = easedTailRate(behind, current);
      rates.add(Math.round(current * 1000) / 1000);
    }
    expect(rates.size).toBeLessThanOrEqual(6);
    for (const rate of rates) expect(Math.round(rate * 20) / 20).toBeCloseTo(rate, 9);
  });

  it('keeps easing a tail it has started easing until the drift is all but gone, rather than flapping at the edge', () => {
    // Just inside the allowance on its way in: still eased, in the same direction.
    expect(easedTailRate(TAIL_DRIFT_MS - 10, 1.1)).toBeGreaterThan(1);
    expect(easedTailRate(-(TAIL_DRIFT_MS - 10), 0.9)).toBeLessThan(1);
    // Close enough: back to its own rate.
    expect(easedTailRate(TAIL_SETTLED_MS, 1.05)).toBe(1);
    // A tail at its own rate is not started on a drift inside the allowance.
    expect(easedTailRate(TAIL_DRIFT_MS - 10, 1)).toBe(1);
  });

  it('never moves the rate by more than a quarter, and never rounds a real drift away', () => {
    expect(easedTailRate(1000, 1)).toBe(1.25);
    expect(easedTailRate(-1000, 1)).toBe(0.75);
    expect(easedTailRate(TAIL_SETTLED_MS + 1, 1.05)).toBeCloseTo(1.05, 9);
  });
});

describe('the boundary past a ramp', () => {
  // A ramp is one segment per step of the same file, each picking up where the last left off.
  const slots = timelineSlots({
    clips: [
      clip('a', 'one', 0, 1000),
      clip('r1', 'two', 0, 400, { speed: 0.5 }),
      clip('r2', 'two', 400, 800, { speed: 0.25 }),
      clip('r3', 'two', 800, 1200, { speed: 0.5 }),
      clip('b', 'three', 0, 1000),
    ],
  });

  it('is the next cut when there is no ramp in the way', () => {
    expect(boundaryAfterSplits(slots, 0)).toBe(1);
  });

  it('looks past every step of a ramp to the cut after its last one', () => {
    expect(boundaryAfterSplits(slots, 1)).toBe(4);
    expect(boundaryAfterSplits(slots, 2)).toBe(4);
    expect(boundaryAfterSplits(slots, 3)).toBe(4);
  });

  it('is nothing when the base track ends first', () => {
    expect(boundaryAfterSplits(slots, 4)).toBe(-1);
    const ramp = timelineSlots({ clips: [clip('r1', 'two', 0, 400), clip('r2', 'two', 400, 800)] });
    expect(boundaryAfterSplits(ramp, 0)).toBe(-1);
  });
});
