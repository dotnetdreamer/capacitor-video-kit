import { describe, expect, it } from 'vitest';

import { FRAME_SHARE, MAX_STRIP_WIDTHS, TILE_PX, clockTenths, spokenSeconds, startFromScroll, stripScale, stripTiles } from './slip-strip';

const STRIP = { stepMs: 1000, urls: ['f0', 'f1', 'f2', 'f3'] };

describe('stripScale', () => {
  it('puts the segment at its share of the strip', () => {
    expect(FRAME_SHARE).toBe(0.6);
    expect(stripScale(400, 2000, 30_000) * 2000).toBeCloseTo(240, 9);
  });

  /* Half a second of a five minute clip at 60% of the strip would be a strip hundreds of phones wide. */
  it('narrows the frame rather than make the strip longer than fifteen of itself', () => {
    expect(MAX_STRIP_WIDTHS).toBe(15);
    expect(stripScale(400, 500, 300_000) * 300_000).toBeCloseTo(400 * 15, 6);
  });

  it('fits a clip the segment plays all of into the frame', () => {
    expect(stripScale(400, 8000, 8000) * 8000).toBeCloseTo(240, 9);
  });

  it('is 0 until the strip has a width, and for a clip with no length', () => {
    expect(stripScale(0, 2000, 30_000)).toBe(0);
    expect(stripScale(400, 2000, 0)).toBe(0);
  });
});

describe('stripTiles', () => {
  it('lays square tiles along the clip, each showing the frame nearest its middle', () => {
    /* A sixteenth of a px a ms: a tile is 896 ms of the clip, and a 4 s clip is four tiles and a bit. */
    expect(stripTiles(4000, 1 / 16, STRIP)).toEqual([
      { x: 0, url: 'f0' },
      { x: TILE_PX, url: 'f1' },
      { x: 2 * TILE_PX, url: 'f2' },
      { x: 3 * TILE_PX, url: 'f3' },
      { x: 4 * TILE_PX, url: 'f3' },
    ]);
  });

  it('has tiles with no picture while the frames are still being cut', () => {
    expect(stripTiles(2000, 1 / 16, undefined).map(tile => tile.url)).toEqual([null, null, null]);
  });

  it('has none before the strip has a scale', () => {
    expect(stripTiles(4000, 0, STRIP)).toEqual([]);
  });
});

describe('startFromScroll', () => {
  it('is the part of the clip under the frame, in ms', () => {
    expect(startFromScroll(800, 0.08, 27_000)).toBe(10_000);
  });

  it('holds the part inside the clip, past either end of the strip', () => {
    expect(startFromScroll(-40, 0.08, 27_000)).toBe(0);
    expect(startFromScroll(9000, 0.08, 27_000)).toBe(27_000);
    expect(startFromScroll(800, 0, 27_000)).toBe(0);
  });
});

describe('clockTenths', () => {
  /* As the timeline's chip rounds a length, so the two never print the same part a tenth apart. */
  it('prints minutes, seconds and tenths, to the nearest tenth', () => {
    expect(clockTenths(0)).toBe('00:00.0');
    expect(clockTenths(12_449)).toBe('00:12.4');
    expect(clockTenths(12_450)).toBe('00:12.5');
    expect(clockTenths(58_063)).toBe('00:58.1');
    expect(clockTenths(59_960)).toBe('01:00.0');
    expect(clockTenths(75_300)).toBe('01:15.3');
    expect(clockTenths(-5)).toBe('00:00.0');
  });

  it('says it in seconds for a screen reader', () => {
    expect(spokenSeconds(12_449)).toBe('12.4 seconds');
    expect(spokenSeconds(0)).toBe('0 seconds');
  });
});
