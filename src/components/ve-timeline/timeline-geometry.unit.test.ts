import { describe, expect, it } from 'vitest';

import type { Filmstrip } from '../../state/editor.types';
import {
  durationChip,
  frameUrl,
  nearestSnap,
  rulerLabel,
  rulerStepMs,
  segmentTiles,
  touchDistance,
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
