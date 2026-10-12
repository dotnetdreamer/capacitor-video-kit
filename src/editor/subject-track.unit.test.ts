import { describe, expect, it } from 'vitest';

import { SUBJECT_TRACK_MAGIC, SUBJECT_TRACK_VERSION } from '../video-composer/definitions';
import { decodeRuns, encodeRuns, encodeSubjectTrack, focusLevels, focusMask, parseSubjectTrack, SubjectTrackError, type SubjectTrackMeta } from './subject-track';

/*
 * The subject track is a file three engines read and two write, so its layout is held here byte for
 * byte: the header, the tables, the runs. [focusMask] and [focusLevels] are the contract's steps 1 to
 * 3, which every engine computes the same way before it uploads a mask.
 */

const META: SubjectTrackMeta = { engine: 'mediapipe', kind: 'video', durationMs: 1000, fps: 10, subjects: [{ id: 1, kind: 'person', startMs: 0, endMs: 900, peakMs: 300, box: { x: 0, y: 0, w: 0.5, h: 1 }, area: 0.5 }] };

/** A 4x2 grid: the left half subject `left`, the right half subject `right`. */
const halves = (left: number, right: number): Uint8Array => Uint8Array.from([left, left, right, right, left, left, right, right]);

describe('runs', () => {
  it('codes a value and its run, the run as LEB128', () => {
    expect([...encodeRuns(Uint8Array.from([0, 0, 0, 5, 5]))]).toEqual([0, 3, 5, 2]);
    const long = new Uint8Array(300).fill(7);
    // 300 = 0b10_0101100: 0xAC (44 | 0x80), then 2.
    expect([...encodeRuns(long)]).toEqual([7, 0xac, 2]);
  });

  it('decodes exactly what it coded', () => {
    const cells = Uint8Array.from({ length: 1000 }, (_, i) => (i % 97 < 40 ? 0 : i % 3));
    const runs = encodeRuns(cells);
    const out = new Uint8Array(cells.length);
    decodeRuns(runs, 0, runs.length, out);
    expect(out).toEqual(cells);
  });

  it('refuses runs that do not fill the grid, overrun it or stop in a varint', () => {
    const out = new Uint8Array(4);
    expect(() => decodeRuns(Uint8Array.from([1, 3]), 0, 2, out)).toThrow(SubjectTrackError);
    expect(() => decodeRuns(Uint8Array.from([1, 5]), 0, 2, out)).toThrow(SubjectTrackError);
    expect(() => decodeRuns(Uint8Array.from([1, 0x84]), 0, 2, out)).toThrow(SubjectTrackError);
    expect(() => decodeRuns(Uint8Array.from([1, 0, 1, 4]), 0, 4, out)).toThrow(SubjectTrackError);
  });
});

describe('subject track file', () => {
  const bytes = encodeSubjectTrack({ width: 4, height: 2, times: [0, 100, 250], frames: [halves(1, 0), halves(0, 1), halves(2, 2)], meta: META });

  it('lays the header out as the contract has it', () => {
    const view = new DataView(bytes.buffer);
    expect(String.fromCharCode(...bytes.subarray(0, 4))).toBe(SUBJECT_TRACK_MAGIC);
    expect(bytes[4]).toBe(SUBJECT_TRACK_VERSION);
    expect(bytes[5]).toBe(0);
    expect(view.getUint16(6, true)).toBe(4);
    expect(view.getUint16(8, true)).toBe(2);
    expect(view.getUint16(10, true)).toBe(0);
    expect(view.getUint32(12, true)).toBe(3);
    const json = view.getUint32(16, true);
    expect(JSON.parse(new TextDecoder().decode(bytes.subarray(20, 20 + json)))).toEqual(META);
    // The times, then the offsets: the first frame at 0 of the data.
    expect([0, 1, 2].map(i => view.getUint32(20 + json + 4 * i, true))).toEqual([0, 100, 250]);
    expect(view.getUint32(20 + json + 12, true)).toBe(0);
  });

  it('reads back every frame, its times and its JSON', () => {
    const track = parseSubjectTrack(bytes);
    expect([track.width, track.height, track.frameCount]).toEqual([4, 2, 3]);
    expect([...track.times]).toEqual([0, 100, 250]);
    expect(track.meta).toEqual(META);
    expect(track.frame(0)).toEqual(halves(1, 0));
    expect(track.frame(1)).toEqual(halves(0, 1));
    expect(track.frame(2)).toEqual(halves(2, 2));
    // A frame asked for again is the one kept.
    expect(track.frame(1)).toBe(track.frame(1));
  });

  it('reads an ArrayBuffer and a Uint8Array that is a view into a larger buffer', () => {
    const padded = new Uint8Array(bytes.length + 16);
    padded.set(bytes, 8);
    expect(parseSubjectTrack(padded.subarray(8, 8 + bytes.length)).frame(2)).toEqual(halves(2, 2));
    expect(parseSubjectTrack(bytes.slice().buffer).frameCount).toBe(3);
  });

  it('refuses what is not a subject track it can read', () => {
    const broken = (edit: (copy: Uint8Array, view: DataView) => void): Uint8Array => {
      const copy = bytes.slice();
      edit(copy, new DataView(copy.buffer));
      return copy;
    };
    expect(() => parseSubjectTrack(new Uint8Array(10))).toThrow(SubjectTrackError);
    expect(() => parseSubjectTrack(broken(copy => (copy[0] = 0x41)))).toThrow(/not a subject track/);
    expect(() => parseSubjectTrack(broken(copy => (copy[4] = 2)))).toThrow(/version 2/);
    expect(() => parseSubjectTrack(broken((_, view) => view.setUint16(6, 0, true)))).toThrow(SubjectTrackError);
    expect(() => parseSubjectTrack(broken((_, view) => view.setUint32(12, 0, true)))).toThrow(SubjectTrackError);
    expect(() =>
      parseSubjectTrack(
        broken((_, view) => {
          view.setUint16(6, 2000, true);
          view.setUint16(8, 2000, true);
        }),
      ),
    ).toThrow(/too large/);
    expect(() => parseSubjectTrack(broken((_, view) => view.setUint32(16, 1 << 20, true)))).toThrow(/past its end/);
    const json = new DataView(bytes.buffer).getUint32(16, true);
    expect(() => parseSubjectTrack(broken((_, view) => view.setUint32(20 + json + 4, 0, true)))).toThrow(/go back/);
    expect(() => parseSubjectTrack(broken((_, view) => view.setUint32(20 + json + 16, 9999, true)))).toThrow(/offsets/);
  });

  it('still draws when its JSON is damaged, only with nothing to list', () => {
    const json = new DataView(bytes.buffer).getUint32(16, true);
    const copy = bytes.slice();
    copy[20] = 0x7b; // '{'
    copy[21] = 0x7b;
    const track = parseSubjectTrack(copy);
    expect(track.meta).toBeNull();
    expect(json).toBeGreaterThan(2);
    expect(track.frame(0)).toEqual(halves(1, 0));
  });

  it('refuses a frame whose runs do not add up when it is drawn, not when it is opened', () => {
    const json = new DataView(bytes.buffer).getUint32(16, true);
    const data = 20 + json + 24;
    const copy = bytes.slice();
    // The first frame's first run made one cell too long.
    copy[data + 1] = copy[data + 1]! + 1;
    const track = parseSubjectTrack(copy);
    expect(() => track.frame(0)).toThrow(SubjectTrackError);
  });
});

describe('span', () => {
  const track = parseSubjectTrack(encodeSubjectTrack({ width: 4, height: 2, times: [100, 200, 400], frames: [halves(1, 0), halves(0, 1), halves(2, 2)], meta: META }));

  it('holds the first frame before it and the last after it', () => {
    expect(track.span(0)).toEqual({ from: 0, to: 0, weight: 0 });
    expect(track.span(100)).toEqual({ from: 0, to: 0, weight: 0 });
    expect(track.span(400)).toEqual({ from: 2, to: 2, weight: 0 });
    expect(track.span(9000)).toEqual({ from: 2, to: 2, weight: 0 });
  });

  it('finds the frames either side and how far between them', () => {
    expect(track.span(150)).toEqual({ from: 0, to: 1, weight: 0.5 });
    expect(track.span(200)).toEqual({ from: 1, to: 2, weight: 0 });
    expect(track.span(350)).toEqual({ from: 1, to: 2, weight: 0.75 });
  });

  it('is one frame for ever on a picture', () => {
    const picture = parseSubjectTrack(encodeSubjectTrack({ width: 4, height: 2, times: [0], frames: [halves(1, 0)], meta: { ...META, kind: 'image' } }));
    expect(picture.span(-5)).toEqual({ from: 0, to: 0, weight: 0 });
    expect(picture.span(123456)).toEqual({ from: 0, to: 0, weight: 0 });
  });
});

describe('focusLevels', () => {
  const focus = {
    atMs: [1000, 2000, 3000, 3000],
    subjects: [
      { id: 1, focus: [1, 0, 0, 1] },
      { id: 2, focus: [0, 1, 1, 0] },
    ],
  };

  it('reads the keys as a camera is read', () => {
    const at = (ms: number) => [...focusLevels(focus, ms).subarray(0, 3)];
    expect(at(0)).toEqual([0, 1, 0]);
    expect(at(1500)).toEqual([0, 0.5, 0.5]);
    expect(at(2500)).toEqual([0, 0, 1]);
    // Two keys at one time are a step: the later wins at that time.
    expect(at(2999)).toEqual([0, 0, 1]);
    expect(at(3000)).toEqual([0, 1, 0]);
    expect(at(9000)).toEqual([0, 1, 0]);
  });

  it('leaves the background and every subject not listed out of focus', () => {
    const levels = focusLevels({ atMs: [0], subjects: [{ id: 3, focus: [0.25] }] }, 0);
    expect(levels[0]).toBe(0);
    expect(levels[1]).toBe(0);
    expect(levels[3]).toBe(0.25);
    expect(levels[255]).toBe(0);
  });

  it('holds a level to 0..1', () => {
    const levels = focusLevels({ atMs: [0], subjects: [{ id: 1, focus: [7] }, { id: 2, focus: [-1] }] }, 0);
    expect([levels[1], levels[2]]).toEqual([1, 0]);
  });
});

describe('focusMask', () => {
  const track = parseSubjectTrack(encodeSubjectTrack({ width: 4, height: 2, times: [0, 100], frames: [halves(1, 0), halves(0, 1)], meta: META }));
  const oneInFocus = focusLevels({ atMs: [0], subjects: [{ id: 1, focus: [1] }] }, 0);

  it('is the subject in focus where it is, and 0 elsewhere', () => {
    expect([...focusMask(track, oneInFocus, 0, false)]).toEqual([255, 255, 0, 0, 255, 255, 0, 0]);
    expect([...focusMask(track, oneInFocus, 100, false)]).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
  });

  it('mixes the frames either side by how far between them the instant is', () => {
    expect([...focusMask(track, oneInFocus, 25, false)]).toEqual([191, 191, 64, 64, 191, 191, 64, 64]);
  });

  it('turns over for invert', () => {
    expect([...focusMask(track, oneInFocus, 0, true)]).toEqual([0, 0, 255, 255, 0, 0, 255, 255]);
  });

  it('fills the array it is handed', () => {
    const out = new Uint8Array(8).fill(9);
    expect(focusMask(track, oneInFocus, 0, false, out)).toBe(out);
    expect(out[2]).toBe(0);
  });
});
