import { describe, expect, it } from 'vitest';

import { MATTE_TRACK_MAGIC, MATTE_TRACK_VERSION } from '../video-composer/definitions';
import {
  MAX_MATTE_CELLS,
  MatteTrackError,
  decodeMattePackets,
  encodeMattePackets,
  encodeMatteTrack,
  matteAt,
  matteGrid,
  parseMatteTrack,
  summariseMatte,
  type MatteTrackMeta,
} from './matte-track';

/*
 * The matte track is a file the web side and Android both write and both read, so its layout is held
 * here byte for byte: the header, the tables, the packets. [matteAt] is the contract's steps 1 and 2,
 * which every engine computes the same way before it uploads a matte.
 */

const META: MatteTrackMeta = { engine: 'mlkit', kind: 'video', target: 'subject', durationMs: 1000, fps: 10, coverage: 0.5, box: { x: 0, y: 0, w: 0.5, h: 1 } };

/** A 4x2 grid: the left half `left`, the right half `right`. */
const halves = (left: number, right: number): Uint8Array => Uint8Array.from([left, left, right, right, left, left, right, right]);

describe('packets', () => {
  it('codes a run of three or more as count << 1 | 1 and its byte, and the rest as literals', () => {
    expect([...encodeMattePackets(Uint8Array.from([0, 0, 0, 0]))]).toEqual([9, 0]);
    expect([...encodeMattePackets(Uint8Array.from([10, 20, 30]))]).toEqual([6, 10, 20, 30]);
    // Two the same are not worth a run: they ride in the literals either side.
    expect([...encodeMattePackets(Uint8Array.from([5, 5, 255, 255, 255, 255, 7]))]).toEqual([4, 5, 5, 9, 255, 2, 7]);
  });

  it('writes counts past 63 as LEB128', () => {
    const long = new Uint8Array(300).fill(255);
    // 300 << 1 | 1 = 601 = 0b100_1011001: 0xD9 (89 | 0x80), then 4.
    expect([...encodeMattePackets(long)]).toEqual([0xd9, 4, 255]);
  });

  it('decodes exactly what it coded, edges and all', () => {
    const cells = Uint8Array.from({ length: 5000 }, (_, i) => {
      const x = i % 100;
      return x < 40 ? 0 : x > 60 ? 255 : Math.round(((x - 40) / 20) * 255);
    });
    const packets = encodeMattePackets(cells);
    const out = new Uint8Array(cells.length);
    decodeMattePackets(packets, 0, packets.length, out);
    expect(out).toEqual(cells);
    // The two ends ride in runs, so the frame costs about its soft edge and a few bytes a row.
    expect(packets.length).toBeLessThan(cells.length / 3);
  });

  it('refuses packets that stop short, overrun the grid, leave bytes over or stop in a varint', () => {
    const out = new Uint8Array(4);
    // A run of 3 into 4 cells: short.
    expect(() => decodeMattePackets(Uint8Array.from([7, 1]), 0, 2, out)).toThrow(MatteTrackError);
    // A run of 5: over.
    expect(() => decodeMattePackets(Uint8Array.from([11, 1]), 0, 2, out)).toThrow(MatteTrackError);
    // A count of 0.
    expect(() => decodeMattePackets(Uint8Array.from([1, 1, 9, 1]), 0, 4, out)).toThrow(MatteTrackError);
    // Four literals promised, two given.
    expect(() => decodeMattePackets(Uint8Array.from([8, 1, 2]), 0, 3, out)).toThrow(MatteTrackError);
    // A run with no byte to repeat.
    expect(() => decodeMattePackets(Uint8Array.from([9]), 0, 1, out)).toThrow(MatteTrackError);
    // A varint that never ends.
    expect(() => decodeMattePackets(Uint8Array.from([0x89]), 0, 1, out)).toThrow(MatteTrackError);
  });
});

describe('the file', () => {
  it('lays out the header, the JSON, the times, the offsets and the frames', () => {
    const bytes = encodeMatteTrack({ width: 4, height: 2, times: [0, 100], frames: [halves(255, 0), halves(0, 255)], meta: META });
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe(MATTE_TRACK_MAGIC);
    expect(bytes[4]).toBe(MATTE_TRACK_VERSION);
    expect(bytes[5]).toBe(0);
    expect(view.getUint16(6, true)).toBe(4);
    expect(view.getUint16(8, true)).toBe(2);
    expect(view.getUint32(12, true)).toBe(2);
    const json = view.getUint32(16, true);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + json)))).toEqual(META);
    const timesAt = 20 + json;
    expect(view.getUint32(timesAt, true)).toBe(0);
    expect(view.getUint32(timesAt + 4, true)).toBe(100);
    expect(view.getUint32(timesAt + 8, true)).toBe(0);
    // No run of three in a frame of halves: each is one packet of eight literals, nine bytes.
    expect(view.getUint32(timesAt + 12, true)).toBe(9);
    expect([...bytes.subarray(timesAt + 16, timesAt + 25)]).toEqual([16, 255, 255, 0, 0, 255, 255, 0, 0]);
    expect(bytes.length).toBe(timesAt + 16 + 18);
  });

  it('reads back every frame, its times and its JSON', () => {
    const track = parseMatteTrack(encodeMatteTrack({ width: 4, height: 2, times: [0, 100, 250], frames: [halves(255, 0), halves(128, 128), halves(0, 255)], meta: META }));
    expect(track.width).toBe(4);
    expect(track.height).toBe(2);
    expect([...track.times]).toEqual([0, 100, 250]);
    expect(track.meta).toEqual(META);
    expect(track.frame(1)).toEqual(halves(128, 128));
    expect(track.frame(2)).toEqual(halves(0, 255));
    expect(() => track.checkFrames()).not.toThrow();
  });

  it('refuses what is not a matte track', () => {
    const good = encodeMatteTrack({ width: 4, height: 2, times: [0], frames: [halves(255, 0)], meta: META });
    const broken = (change: (bytes: Uint8Array, view: DataView) => void): Uint8Array => {
      const copy = good.slice();
      change(copy, new DataView(copy.buffer));
      return copy;
    };
    expect(() => parseMatteTrack(good.subarray(0, 10))).toThrow(/too short/);
    expect(() => parseMatteTrack(broken(b => (b[0] = 0x57)))).toThrow(/not a matte track/);
    expect(() => parseMatteTrack(broken(b => (b[4] = 2)))).toThrow(/version 2/);
    expect(() => parseMatteTrack(broken((_, v) => v.setUint16(6, 0, true)))).toThrow(/no cells/);
    expect(() => parseMatteTrack(broken((_, v) => v.setUint32(12, 0, true)))).toThrow(/no frames/);
    expect(() => parseMatteTrack(broken((_, v) => v.setUint32(12, 1000, true)))).toThrow(/run past its end/);
    expect(() => parseMatteTrack(broken((_, v) => (v.setUint16(6, 4096, true), v.setUint16(8, 4096, true))))).toThrow(/too large/);
    expect(4096 * 4096).toBeGreaterThan(MAX_MATTE_CELLS);
  });

  it('refuses times that go back and offsets past the end', () => {
    const two = encodeMatteTrack({ width: 4, height: 2, times: [0, 100], frames: [halves(255, 0), halves(0, 255)], meta: META });
    const json = new DataView(two.buffer).getUint32(16, true);
    const back = two.slice();
    new DataView(back.buffer).setUint32(20 + json + 4, 0, true);
    expect(() => parseMatteTrack(back)).toThrow(/times go back/);
    const past = two.slice();
    new DataView(past.buffer).setUint32(20 + json + 12, 9999, true);
    expect(() => parseMatteTrack(past)).toThrow(/offsets/);
  });

  it('keeps a track whose JSON is damaged drawable', () => {
    const bytes = encodeMatteTrack({ width: 4, height: 2, times: [0], frames: [halves(255, 0)], meta: META });
    const json = new DataView(bytes.buffer).getUint32(16, true);
    bytes.fill(0x20, 20, 20 + json);
    bytes[20] = 0x7b;
    const track = parseMatteTrack(bytes);
    expect(track.meta).toBeNull();
    expect(track.frame(0)).toEqual(halves(255, 0));
  });

  it('refuses a damaged frame when it is drawn, and every one when checked', () => {
    const bytes = encodeMatteTrack({ width: 4, height: 2, times: [0, 100], frames: [halves(255, 0), halves(0, 255)], meta: META });
    // The second frame's packet header promises eight literals; one byte short of them now.
    const track = parseMatteTrack(bytes.subarray(0, bytes.length - 1));
    expect(() => track.frame(0)).not.toThrow();
    expect(() => track.frame(1)).toThrow(MatteTrackError);
    expect(() => track.checkFrames()).toThrow(MatteTrackError);
  });
});

describe('matteAt', () => {
  const track = parseMatteTrack(encodeMatteTrack({ width: 4, height: 2, times: [100, 200], frames: [halves(255, 0), halves(0, 255)], meta: META }));

  it('holds the first frame before it and the last after it', () => {
    expect(matteAt(track, 0)).toEqual(halves(255, 0));
    expect(matteAt(track, 100)).toEqual(halves(255, 0));
    expect(matteAt(track, 200)).toEqual(halves(0, 255));
    expect(matteAt(track, 9999)).toEqual(halves(0, 255));
  });

  it('mixes the two frames either side by how far between them the instant is, rounded', () => {
    expect(matteAt(track, 150)).toEqual(halves(128, 128));
    expect(matteAt(track, 125)).toEqual(halves(191, 64));
  });

  it('is one frame at every instant for a picture', () => {
    const picture = parseMatteTrack(encodeMatteTrack({ width: 4, height: 2, times: [0], frames: [halves(255, 0)], meta: { ...META, kind: 'image' } }));
    expect(matteAt(picture, 12_345)).toEqual(halves(255, 0));
  });
});

describe('grids and summaries', () => {
  it('puts the long side on the grid and the other in proportion', () => {
    expect(matteGrid(1080, 1920, 512)).toEqual({ width: 288, height: 512 });
    expect(matteGrid(4000, 3000, 1024)).toEqual({ width: 1024, height: 768 });
    expect(matteGrid(10, 100_000, 512)).toEqual({ width: 1, height: 512 });
  });

  it('says how much of the frame the subject covers, and where over the whole footage', () => {
    // A 4x2 grid, the subject in the left column of one frame and the top-right cell of the other.
    const a = Uint8Array.from([255, 0, 0, 0, 255, 0, 0, 0]);
    const b = Uint8Array.from([0, 0, 0, 200, 0, 0, 0, 100]);
    expect(summariseMatte([a, b], 4, 2)).toEqual({ coverage: 0.1875, box: { x: 0, y: 0, w: 1, h: 1 } });
    expect(summariseMatte([b], 4, 2)).toEqual({ coverage: 0.125, box: { x: 0.75, y: 0, w: 0.25, h: 0.5 } });
  });

  it('gives no box where nothing stood out', () => {
    expect(summariseMatte([new Uint8Array(8).fill(127)], 4, 2)).toEqual({ coverage: 0 });
  });
});
