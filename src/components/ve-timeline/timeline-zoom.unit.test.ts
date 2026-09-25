import { describe, expect, it } from 'vitest';

import { zoomDragWindow } from './timeline-drags';
import { MIN_ITEM_PX, zoomBar, zoomBarLabel, zoomNeighbours, zoomSnapTargets } from './timeline-geometry';

/*
 * The zoom row's arithmetic, at a readable scale: 50 px a second with no padding, so every x below
 * reads as a time (100 px is 2 s).
 */
const PPS = 50;

describe('zoomBar', () => {
  it('places the bar at its window and draws its ramps inside it', () => {
    expect(zoomBar({ startMs: 2000, endMs: 6000, rampInMs: 1000, rampOutMs: 500 }, PPS, 0)).toEqual({ x: 100, w: 200, rampInPx: 50, rampOutPx: 25 });
  });

  it('is measured from the padding, as everything on the timeline is', () => {
    expect(zoomBar({ startMs: 0, endMs: 1000, rampInMs: 0, rampOutMs: 0 }, PPS, 196).x).toBe(196);
  });

  it('never draws narrower than any other item, and scales the ramps down with it', () => {
    // 200 ms is 10 px, floored to the item minimum; the two 100 ms ramps would be 10 px together
    // and still fit, so they keep their size.
    const short = zoomBar({ startMs: 0, endMs: 200, rampInMs: 100, rampOutMs: 100 }, PPS, 0);
    expect(short.w).toBe(MIN_ITEM_PX);
    expect(short.rampInPx + short.rampOutPx).toBeLessThanOrEqual(short.w);
  });

  it('never lets the two ramps draw past each other', () => {
    const bar = zoomBar({ startMs: 0, endMs: 1000, rampInMs: 2000, rampOutMs: 2000 }, PPS, 0);
    expect(bar.rampInPx + bar.rampOutPx).toBeLessThanOrEqual(bar.w + 0.1);
    expect(bar.rampInPx).toBeCloseTo(bar.rampOutPx, 5);
  });

  it('draws an instant zoom with no ramps at all', () => {
    const bar = zoomBar({ startMs: 0, endMs: 3000, rampInMs: 0, rampOutMs: 0 }, PPS, 0);
    expect(bar.rampInPx).toBe(0);
    expect(bar.rampOutPx).toBe(0);
  });
});

describe('zoomNeighbours', () => {
  const zooms = [
    { id: 'a', startMs: 0, endMs: 2000 },
    { id: 'b', startMs: 3000, endMs: 5000 },
    { id: 'c', startMs: 8000, endMs: 9000 },
  ];

  it('stops a zoom at the end of the one before and the start of the one after', () => {
    expect(zoomNeighbours(zooms, 'b', 20_000)).toEqual({ lo: 2000, hi: 8000 });
  });

  it('uses the start and the end of the post where there is no neighbour', () => {
    expect(zoomNeighbours(zooms, 'a', 20_000)).toEqual({ lo: 0, hi: 3000 });
    expect(zoomNeighbours(zooms, 'c', 20_000)).toEqual({ lo: 5000, hi: 20_000 });
  });

  it('answers the whole post for a zoom that is not there', () => {
    expect(zoomNeighbours(zooms, 'gone', 20_000)).toEqual({ lo: 0, hi: 20_000 });
  });
});

describe('zoomSnapTargets', () => {
  it('offers the other zooms edges and never the dragged zoom own', () => {
    const zooms = [
      { id: 'a', startMs: 0, endMs: 2000 },
      { id: 'b', startMs: 3000, endMs: 5000 },
    ];
    expect(zoomSnapTargets(zooms, 'b')).toEqual([0, 2000]);
  });
});

describe('zoomDragWindow', () => {
  it('moves the start and keeps the end', () => {
    expect(zoomDragWindow('start', 2000, 6000, 3000, 0, 10_000, 500)).toEqual({ startMs: 3000, endMs: 6000 });
  });

  it('moves the end and keeps the start', () => {
    expect(zoomDragWindow('end', 2000, 6000, 7000, 0, 10_000, 500)).toEqual({ startMs: 2000, endMs: 7000 });
  });

  it('never makes the window shorter than the minimum', () => {
    expect(zoomDragWindow('start', 2000, 6000, 5900, 0, 10_000, 500)).toEqual({ startMs: 5500, endMs: 6000 });
    expect(zoomDragWindow('end', 2000, 6000, 2100, 0, 10_000, 500)).toEqual({ startMs: 2000, endMs: 2500 });
  });

  it('stops each edge at the neighbours', () => {
    expect(zoomDragWindow('start', 2000, 6000, 500, 1000, 8000, 500)).toEqual({ startMs: 1000, endMs: 6000 });
    expect(zoomDragWindow('end', 2000, 6000, 9500, 1000, 8000, 500)).toEqual({ startMs: 2000, endMs: 8000 });
  });

  it('keeps the length of a moved window against either neighbour', () => {
    expect(zoomDragWindow('move', 2000, 5000, 6000, 1000, 8000, 500)).toEqual({ startMs: 5000, endMs: 8000 });
    expect(zoomDragWindow('move', 2000, 5000, -400, 1000, 8000, 500)).toEqual({ startMs: 1000, endMs: 4000 });
  });

  it('answers whole milliseconds', () => {
    const w = zoomDragWindow('move', 2000, 5000, 3333.6, 0, 10_000, 500);
    expect(w).toEqual({ startMs: 3334, endMs: 6334 });
  });
});

describe('zoomBarLabel', () => {
  it('names the level with one decimal, and says when the zoom is selected', () => {
    expect(zoomBarLabel(2, false)).toBe('Zoom 2.0x');
    expect(zoomBarLabel(2.5, true)).toBe('Zoom 2.5x, selected');
  });
});
