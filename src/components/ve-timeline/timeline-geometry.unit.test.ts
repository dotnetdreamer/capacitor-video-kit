import { describe, expect, it } from 'vitest';

import type { Filmstrip } from '../../state/editor.types';
import {
  DROP_CANCEL_PX,
  SEGMENT_GAP_PX,
  TRANSITION_DOT_CIRCLE_PX,
  TRANSITION_DOT_HIT_PX,
  TRANSITION_DOT_MIN_SEGMENT_PX,
  cutX,
  dotFits,
  dotHitWidth,
  durationChip,
  dropTargetAt,
  frameUrl,
  nearestSnap,
  snapTargets,
  rulerLabel,
  rulerStepMs,
  segmentTiles,
  touchDistance,
  type DropRow,
} from './timeline-geometry';

/**
 * One filmstrip frame a second, and a zoom at which one tile is also one second of output: 50 px
 * per second and a 50 px tile. Every expected `x` below is therefore readable as a time, which is
 * the only way an arithmetic slip in this file is visible to a reader.
 */
const STRIP: Filmstrip = { stepMs: 1000, urls: ['f0', 'f1', 'f2', 'f3', 'f4'] };
const PPS = 50;
const TILE_W = 50;

/** A four second clip at the left edge of the content, with the whole of it on screen. */
function tilesOf(over: Partial<Parameters<typeof segmentTiles>[0]> = {}) {
  return segmentTiles({
    inMs: 0,
    outMs: 4000,
    speed: 1,
    pps: PPS,
    tileW: TILE_W,
    segX: 0,
    winLeft: -1000,
    winRight: 1000,
    strip: STRIP,
    ...over,
  });
}

describe('segmentTiles', () => {
  it('lays one tile per tile-width of output and samples each from its own source time', () => {
    expect(tilesOf()).toEqual([
      { key: 0, x: 0, url: 'f0' },
      { key: 1, x: 50, url: 'f1' },
      { key: 2, x: 100, url: 'f2' },
      { key: 3, x: 150, url: 'f3' },
    ]);
  });

  it('anchors the grid to source time, so a trim slides the segment over still pictures', () => {
    // Half a second trimmed off the head is 25 px at this zoom. The keys do not change and no tile
    // re-samples: every one has moved left by exactly that 25 px, which is the segment's edge
    // sliding over a grid that stayed where it was.
    expect(tilesOf({ inMs: 500 })).toEqual([
      { key: 0, x: -25, url: 'f0' },
      { key: 1, x: 25, url: 'f1' },
      { key: 2, x: 75, url: 'f2' },
      { key: 3, x: 125, url: 'f3' },
    ]);
  });

  it('keeps the first tile even when the trim cuts most of it away', () => {
    // 1900 ms in is nearly two whole tiles, but tile 1 still covers source second 1, so it is drawn
    // at a negative x with only its last tenth showing rather than being dropped and re-keyed.
    const tiles = tilesOf({ inMs: 1900 });
    expect(tiles[0]).toEqual({ key: 1, x: -45, url: 'f1' });
  });

  it('draws only the tiles the window asks for, plus one of slack at each end', () => {
    // The window is 100..140, which strictly needs tile 2 alone. The slack is what stops a tile
    // popping in at the edge of the screen on every frame of a scroll.
    expect(tilesOf({ winLeft: 100, winRight: 140 }).map((t) => t.key)).toEqual([1, 2, 3]);
  });

  it('measures the window against the segment, not the content', () => {
    // The same window over a segment that starts 100 px further right picks the tiles 100 px
    // earlier in the clip.
    expect(tilesOf({ segX: 100, winLeft: 200, winRight: 240 }).map((t) => t.key)).toEqual([1, 2, 3]);
  });

  it('covers more source per tile as the clip is sped up', () => {
    // Four seconds of source at 2x is two seconds of output: two tiles, sampled two seconds apart.
    expect(tilesOf({ speed: 2 })).toEqual([
      { key: 0, x: 0, url: 'f0' },
      { key: 1, x: 50, url: 'f2' },
    ]);
  });

  it('treats a speed of zero as 1x', () => {
    expect(tilesOf({ speed: 0 })).toEqual(tilesOf({ speed: 1 }));
  });

  it('still lays the tiles out while the frames are being cut', () => {
    // The grey placeholders have to be the right size and in the right place, or the strip jumps
    // when the pictures arrive.
    expect(tilesOf({ strip: undefined })).toEqual([
      { key: 0, x: 0, url: null },
      { key: 1, x: 50, url: null },
      { key: 2, x: 100, url: null },
      { key: 3, x: 150, url: null },
    ]);
  });

  it('holds the last frame it has rather than dropping the tail of the strip', () => {
    const short: Filmstrip = { stepMs: 1000, urls: ['f0', 'f1'] };
    expect(tilesOf({ strip: short }).map((t) => t.url)).toEqual(['f0', 'f1', 'f1', 'f1']);
  });

  it('draws nothing for a segment with no length, no zoom or no tile', () => {
    expect(tilesOf({ outMs: 0 })).toEqual([]);
    expect(tilesOf({ inMs: 4000 })).toEqual([]);
    expect(tilesOf({ pps: 0 })).toEqual([]);
    expect(tilesOf({ tileW: 0 })).toEqual([]);
  });
});

describe('snapTargets', () => {
  /*
   * What a dragged edge is held to. The base track's boundaries were the whole list, so a segment
   * on a layer had nothing to meet: splitting a video and carrying half of it onto a layer of its
   * own leaves two pictures that are meant to join exactly, and the timeline would let them miss.
   */
  /*
   * Deliberately disjoint numbers: the layer begins at 7 s and ends at 10, and NOTHING else on the
   * post is at either. A layer whose boundaries happened to coincide with the base's would pass
   * these whether or not the layers were read at all.
   */
  const post = {
    totalMs: 20000,
    // The base: two segments, 4 s then 2 s, so boundaries at 0, 4 and 6.
    rows: [
      { startMs: 0, durationsMs: [4000, 2000] },
      // A layer that begins at 7 s carrying one 3 s segment: 7 and 10.
      { startMs: 7000, durationsMs: [3000] },
    ],
  };

  it('holds 0 and the end of the post', () => {
    const targets = snapTargets(post);
    expect(targets).toContain(0);
    expect(targets).toContain(20000);
  });

  it('holds every boundary on the BASE track', () => {
    const targets = snapTargets(post);
    expect(targets).toContain(4000);
    expect(targets).toContain(6000);
  });

  it('holds where a LAYER begins and where each of its segments ends', () => {
    const targets = snapTargets(post);
    // Neither of these is a boundary of the base track or the end of the post.
    expect(targets).toContain(7000);
    expect(targets).toContain(10000);
  });

  it('measures a layer from its own start, not from the beginning of the post', () => {
    const late = snapTargets({ totalMs: 30000, rows: [{ startMs: 5000, durationsMs: [2000, 3000] }] });
    // 5 s in, then 2 s, then 3 more: the boundaries are 5, 7 and 10 - never 2 and 5.
    expect(late).toContain(5000);
    expect(late).toContain(7000);
    expect(late).toContain(10000);
    expect(late).not.toContain(2000);
  });

  it('snaps a second video to the end of the one beside it on its own layer, which is the point', () => {
    const two = snapTargets({ totalMs: 30000, rows: [{ startMs: 7000, durationsMs: [3000] }] });
    // Dragged to 9950, fifty milliseconds short of where the first one on that layer ends.
    expect(nearestSnap([9950], two, 100)).toEqual({ shiftMs: 50, target: 10000 });
  });

  it('snaps to the end of the timeline', () => {
    expect(nearestSnap([19950], snapTargets(post), 100)).toEqual({ shiftMs: 50, target: 20000 });
  });
});

describe('nearestSnap', () => {
  it('sticks an edge to a target that is within the threshold', () => {
    // 100 px per second, so 50 ms is 5 px and inside the 8 px threshold.
    expect(nearestSnap([1000], [1050], 100)).toEqual({ shiftMs: 50, target: 1050 });
  });

  it('leaves an edge alone when nothing is close enough', () => {
    expect(nearestSnap([1000], [2000], 100)).toBeNull();
    expect(nearestSnap([1000], [], 100)).toBeNull();
  });

  it('measures the threshold in pixels, so the same gap snaps at one zoom and not at another', () => {
    // The whole point of snapping in pixels: at the furthest zoom out everything is within a
    // finger's width of everything else, and a snap there would be a nuisance rather than a help.
    expect(nearestSnap([1000], [1050], 200)).toBeNull();
    expect(nearestSnap([1000], [1050], 10)).toEqual({ shiftMs: 50, target: 1050 });
  });

  it('picks the nearest target when several are in reach', () => {
    expect(nearestSnap([1000], [1060, 1020, 980], 100)).toEqual({ shiftMs: 20, target: 1020 });
  });

  it('lets whichever edge of a moving window comes near something decide the shift', () => {
    // A layer being dragged offers both its edges. Its end is 40 ms from the target, so the whole
    // window moves 40 ms and it is the end that lands on the line.
    expect(nearestSnap([1000, 3000], [3040], 100)).toEqual({ shiftMs: 40, target: 3040 });
  });

  it('returns a shift that is signed towards the target', () => {
    expect(nearestSnap([1000], [960], 100)).toEqual({ shiftMs: -40, target: 960 });
  });

  it('keeps the first edge it was given when two are equally close', () => {
    // The edges are passed start first, so a window that fits exactly between two lines holds its
    // start against the earlier one instead of flickering between them.
    expect(nearestSnap([1000, 3000], [1040, 3040], 100)).toEqual({ shiftMs: 40, target: 1040 });
  });

  it('takes a threshold of its own', () => {
    expect(nearestSnap([1000], [1300], 100, 8)).toBeNull();
    expect(nearestSnap([1000], [1300], 100, 30)).toEqual({ shiftMs: 300, target: 1300 });
  });
});

describe('rulerStepMs', () => {
  it('opens the labels out as the zoom closes in', () => {
    expect(rulerStepMs(6)).toBe(15000);
    expect(rulerStepMs(64)).toBe(1000);
    expect(rulerStepMs(128)).toBe(500);
    expect(rulerStepMs(320)).toBe(500);
  });

  it('falls back to the widest spacing rather than crowding the labels', () => {
    expect(rulerStepMs(1)).toBe(30000);
  });
});

describe('rulerLabel', () => {
  it('reads as minutes and seconds', () => {
    expect(rulerLabel(0)).toBe('00:00');
    expect(rulerLabel(7000)).toBe('00:07');
    expect(rulerLabel(65000)).toBe('01:05');
  });

  it('shows the tenth only on the half-second labels of the closest zoom', () => {
    expect(rulerLabel(7500)).toBe('00:07.5');
  });
});

describe('durationChip', () => {
  it('reads to a tenth of a second', () => {
    expect(durationChip(7900)).toBe('7.9s');
    expect(durationChip(12345)).toBe('12.3s');
  });

  it('never reads as a negative length', () => {
    expect(durationChip(-500)).toBe('0.0s');
  });
});

describe('frameUrl', () => {
  it('takes the frame the source time falls in', () => {
    expect(frameUrl(STRIP, 0)).toBe('f0');
    expect(frameUrl(STRIP, 1999)).toBe('f1');
  });

  it('holds the ends rather than reading off the strip', () => {
    expect(frameUrl(STRIP, -1000)).toBe('f0');
    expect(frameUrl(STRIP, 99_000)).toBe('f4');
  });

  it('has nothing to show while a clip is still being cut', () => {
    expect(frameUrl(undefined, 0)).toBeNull();
    expect(frameUrl({ stepMs: 0, urls: ['f0'] }, 0)).toBeNull();
    expect(frameUrl({ stepMs: 1000, urls: [] }, 0)).toBeNull();
    expect(frameUrl({ stepMs: 1000, urls: [''] }, 0)).toBeNull();
  });
});

describe('touchDistance', () => {
  const touch = (clientX: number, clientY: number) => ({ clientX, clientY }) as Touch;

  it('measures between the two fingers of a pinch', () => {
    expect(touchDistance([touch(0, 0), touch(3, 4)])).toBe(5);
  });

  it('is zero until there are two fingers', () => {
    expect(touchDistance([])).toBe(0);
    expect(touchDistance([touch(0, 0)])).toBe(0);
  });
});

/*
 * The vertical half of a lifted segment: which video layer the finger is over, and which gap between
 * two of them would open a layer that is not there yet.
 *
 * A timeline with a 56 px filmstrip at the top and two 40 px layer rows under it, 8 px apart, which
 * is what the component lays out at its default sizes.
 */
const ROWS: DropRow[] = [
  { trackId: null, top: 100, bottom: 156 },
  { trackId: 'vt-1', top: 164, bottom: 204 },
  { trackId: 'vt-2', top: 212, bottom: 252 },
];

describe('dropTargetAt', () => {
  it('lands on the row the finger is over', () => {
    expect(dropTargetAt(120, ROWS)).toEqual({ kind: 'base' });
    expect(dropTargetAt(180, ROWS)).toEqual({ kind: 'track', trackId: 'vt-1' });
    expect(dropTargetAt(230, ROWS)).toEqual({ kind: 'track', trackId: 'vt-2' });
  });

  it('opens a layer in the gap under a row, counting the base track as row 0', () => {
    // Between the filmstrip and the first layer: a new layer directly under the base track.
    expect(dropTargetAt(160, ROWS)).toEqual({ kind: 'new', index: 0 });
    expect(dropTargetAt(208, ROWS)).toEqual({ kind: 'new', index: 1 });
  });

  it('borrows a few pixels from the rows on each side of a gap', () => {
    // The gap itself is 8 px, which no thumb can hit. The foot of the row above it and the head of
    // the row below both mean the gap, or a new layer could only ever be made past the last row.
    expect(dropTargetAt(150, ROWS)).toEqual({ kind: 'new', index: 0 });
    expect(dropTargetAt(170, ROWS)).toEqual({ kind: 'new', index: 0 });
    expect(dropTargetAt(145, ROWS)).toEqual({ kind: 'base' });
    expect(dropTargetAt(175, ROWS)).toEqual({ kind: 'track', trackId: 'vt-1' });
  });

  it('reads everything below the last row as a layer at the bottom of the stack', () => {
    // A finger carried down past the lanes has said which way it is going; a drag that stops
    // working the further it is carried is a drag that reads as broken.
    expect(dropTargetAt(300, ROWS)).toEqual({ kind: 'new', index: 2 });
    expect(dropTargetAt(9000, ROWS)).toEqual({ kind: 'new', index: 2 });
  });

  it('is nothing at all once the segment is lifted clear above the stack', () => {
    expect(dropTargetAt(100 - DROP_CANCEL_PX - 1, ROWS)).toBeNull();
    // Just inside it is still the base track: the row a finger is a little above is the row it is on.
    expect(dropTargetAt(100 - DROP_CANCEL_PX + 1, ROWS)).toEqual({ kind: 'base' });
  });

  it('has nowhere to put anything with no rows measured', () => {
    expect(dropTargetAt(120, [])).toBeNull();
  });

  it('opens the first layer of a post that has none', () => {
    const only: DropRow[] = [{ trackId: null, top: 100, bottom: 156 }];
    expect(dropTargetAt(120, only)).toEqual({ kind: 'base' });
    expect(dropTargetAt(200, only)).toEqual({ kind: 'new', index: 0 });
  });
});

/*
 * The dot on a cut. At 50 px per second and a pad of 200, a cut at four seconds is 400 px into the
 * content, and the gap the segment before it leaves is the five pixels just left of that.
 */
describe('cutX', () => {
  it('puts the dot in the middle of the gap the segment before it leaves', () => {
    expect(cutX(200, 4000, PPS)).toBe(400 - SEGMENT_GAP_PX / 2);
  });

  it('moves with the zoom and the pad, because it is a time and not a place', () => {
    expect(cutX(0, 4000, 100)).toBe(400 - SEGMENT_GAP_PX / 2);
    expect(cutX(150, 0, PPS)).toBe(150 - SEGMENT_GAP_PX / 2);
  });

  it('sits half way between the segment before it and the one after', () => {
    // The segment after the cut is drawn from `pad + start * pps`, and the one before stops a gap
    // short of that; the dot's centre is exactly between the two edges.
    const after = 200 + (4000 / 1000) * PPS;
    const beforeEnds = after - SEGMENT_GAP_PX;
    expect(cutX(200, 4000, PPS)).toBe((after + beforeEnds) / 2);
  });
});

describe('dotFits', () => {
  const slots = [
    { startMs: 0, durationMs: 4000 },
    { startMs: 4000, durationMs: 4000 },
    { startMs: 8000, durationMs: 4000 },
  ];

  it('has room on every cut at an ordinary zoom', () => {
    expect(dotFits(slots, 1, PPS)).toBe(true);
    expect(dotFits(slots, 2, PPS)).toBe(true);
  });

  it('has no cut in front of the first segment or past the last', () => {
    expect(dotFits(slots, 0, PPS)).toBe(false);
    expect(dotFits(slots, 3, PPS)).toBe(false);
  });

  it('gives way when a neighbour is drawn narrower than the dot needs', () => {
    // Four seconds drawn a gap short: the zoom at which that is exactly the minimum, then a little under.
    const fits = ((TRANSITION_DOT_MIN_SEGMENT_PX + SEGMENT_GAP_PX) / 4000) * 1000;
    expect(dotFits(slots, 1, fits)).toBe(true);
    expect(dotFits(slots, 1, fits * 0.95)).toBe(false);
  });

  it('counts the last segment at its full width, since it leaves no gap behind it', () => {
    const tail = [
      { startMs: 0, durationMs: 4000 },
      { startMs: 4000, durationMs: 520 },
    ];
    // 520 ms at 50 px per second is 26 px, and the last segment gives nothing back to a cut after it.
    expect(dotFits(tail, 1, PPS)).toBe(true);
    // The same 26 px in the middle of the track gives a gap to the next cut, and is too narrow.
    const inner = [...tail, { startMs: 4520, durationMs: 4000 }];
    expect(dotFits(inner, 1, PPS)).toBe(false);
  });
});

/*
 * The dot's finger target. It sits over the segments either side of its cut, so every pixel of it
 * is a pixel of those segments that no longer selects them.
 */
describe('dotHitWidth', () => {
  it('is the whole finger target between segments with room for it', () => {
    const slots = [
      { startMs: 0, durationMs: 4000 },
      { startMs: 4000, durationMs: 4000 },
    ];
    expect(dotHitWidth(slots, 1, PPS)).toBe(TRANSITION_DOT_HIT_PX);
  });

  it('leaves a short segment between two dots a third of itself, whichever cut it is', () => {
    // 0.6 s at the opening zoom of 64 px a second, drawn a gap short: 33.4 px, with a dot on each end.
    const slots = [
      { startMs: 0, durationMs: 4000 },
      { startMs: 4000, durationMs: 600 },
      { startMs: 4600, durationMs: 4000 },
    ];
    const drawn = 0.6 * 64 - SEGMENT_GAP_PX;
    const reach = (cut: number) => (dotHitWidth(slots, cut, 64) - SEGMENT_GAP_PX) / 2;
    expect(reach(1)).toBeCloseTo(drawn / 3, 10);
    expect(reach(2)).toBeCloseTo(drawn / 3, 10);
    expect(drawn - reach(1) - reach(2)).toBeGreaterThanOrEqual(drawn / 3 - 1e-9);
  });

  it('never gets narrower than the circle it carries, even at the narrowest a dot is drawn', () => {
    const at = (px: number) => [
      { startMs: 0, durationMs: 4000 },
      { startMs: 4000, durationMs: ((px + SEGMENT_GAP_PX) / PPS) * 1000 },
      { startMs: 8000, durationMs: 4000 },
    ];
    expect(dotHitWidth(at(TRANSITION_DOT_MIN_SEGMENT_PX), 1, PPS)).toBeGreaterThanOrEqual(TRANSITION_DOT_CIRCLE_PX);
    expect(dotHitWidth(at(4), 1, PPS)).toBe(TRANSITION_DOT_CIRCLE_PX);
  });

  it('grows with the zoom until it is the whole target', () => {
    const slots = [
      { startMs: 0, durationMs: 4000 },
      { startMs: 4000, durationMs: 600 },
    ];
    let last = 0;
    for (const pps of [40, 60, 80, 100, 120]) {
      const width = dotHitWidth(slots, 1, pps);
      expect(width).toBeGreaterThanOrEqual(last);
      last = width;
    }
    expect(last).toBe(TRANSITION_DOT_HIT_PX);
  });

  it('is the circle alone where there is no cut', () => {
    const slots = [{ startMs: 0, durationMs: 4000 }];
    expect(dotHitWidth(slots, 0, PPS)).toBe(TRANSITION_DOT_CIRCLE_PX);
    expect(dotHitWidth(slots, 1, PPS)).toBe(TRANSITION_DOT_CIRCLE_PX);
  });
});
