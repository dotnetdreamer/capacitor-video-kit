import { describe, expect, it } from 'vitest';

import type { SubjectInfo } from '../video-composer/definitions';
import { normaliseEditTrack } from './overlay-track';
import { MIN_SEEN_CELLS, SEEN_SHARE, subjectRun } from './subject-run';
import { encodeSubjectTrack, parseSubjectTrack, type SubjectTrack, type SubjectTrackMeta } from './subject-track';
import { trackFromRun } from './track-motion';

/*
 * A subject followed through a window of its subject track, as a template follows somebody the phone found.
 * These pin what the run promises the track made of it: a sample a frame of the window and one either side,
 * the middle of the subject's robust box, its size by height against the frame of the median height, a sliver
 * or a speck not taken for it, its gaps written as the tracker writes them and coasted across - on tracks of
 * solid rectangles, written and read back exactly as `findSubjects` writes them.
 *
 * The grid is 64x36 cells (16:9), a frame every 100 ms.
 */

const W = 64;
const H = 36;

/** Subject `id`'s cells (1 where it names none) as a solid rectangle, in cells from the grid's top-left. */
interface Blob {
  id?: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** One frame of the grid: each blob cut to it, later ones on top. */
function frame(...blobs: Blob[]): Uint8Array {
  const cells = new Uint8Array(W * H);
  for (const blob of blobs) {
    for (let j = Math.max(0, blob.y); j < Math.min(H, blob.y + blob.h); j++) {
      for (let i = Math.max(0, blob.x); i < Math.min(W, blob.x + blob.w); i++) cells[j * W + i] = blob.id ?? 1;
    }
  }
  return cells;
}

/** Somebody 8 cells wide and 20 high unless said otherwise, the top-left at column `x` and row `y`. */
const person = (x: number, y = 8, w = 8, h = 20): Blob => ({ x, y, w, h });

function info(id: number): SubjectInfo {
  return { id, kind: 'person', startMs: 0, endMs: 1000, peakMs: 0, box: { x: 0, y: 0, w: 0.2, h: 0.5 }, area: 0.1 };
}

/** The track of `frames`: a frame every 100 ms, subjects 1 and 2 listed, unless said otherwise (`null`: JSON that lists none). */
function trackOf(frames: Uint8Array[], options: { times?: number[]; kind?: 'video' | 'image'; subjects?: SubjectInfo[] | null } = {}): SubjectTrack {
  const times = options.times ?? frames.map((_, k) => k * 100);
  const subjects = options.subjects === undefined ? [info(1), info(2)] : options.subjects;
  const meta = { engine: 'mediapipe', kind: options.kind ?? 'video', durationMs: times[times.length - 1]!, fps: 10, subjects } as SubjectTrackMeta;
  return parseSubjectTrack(encodeSubjectTrack({ width: W, height: H, times, frames, meta }));
}

/** Somebody walking right 4 cells a frame, from column 4 at 0 ms to column 44 at 1000 ms. */
const walking = (): Uint8Array[] => Array.from({ length: 11 }, (_, k) => frame(person(4 + 4 * k)));

const round5 = (v: number) => Math.round(v * 1e5) / 1e5;

describe('subjectRun', () => {
  it('follows a subject across the frame, a sample a frame of the window and one either side of it', () => {
    const run = subjectRun(trackOf(walking()), { fromMs: 250, toMs: 650 })!;
    expect(run.atMs).toEqual([200, 300, 400, 500, 600, 700]);
    expect(run.x).toEqual([2, 3, 4, 5, 6, 7].map(k => round5((8 + 4 * k) / W)));
    expect(run.y).toEqual(run.atMs.map(() => 0.5));
    expect(run.scale).toEqual(run.atMs.map(() => 1));
    expect(run.turn).toEqual(run.atMs.map(() => 0));
    expect(run.sure).toEqual(run.atMs.map(() => 100));
    expect(run.lost).toEqual([]);
    expect(run.subjectId).toBe(1);
    expect(run.aspect).toBe(W / H);
    expect(run.box).toEqual({ w: 8 / W, h: round5(20 / H) });
    expect(run.seen).toBe(1);
    // Every frame as tall: the anchor is the median of the six in time order, the third.
    expect(run.anchorMs).toBe(400);
  });

  it('reads each frame once, in order', () => {
    const track = trackOf(walking());
    const read: number[] = [];
    const frameOf = track.frame.bind(track);
    track.frame = (index: number) => {
      read.push(index);
      return frameOf(index);
    };
    subjectRun(track, { fromMs: 250, toMs: 650 });
    expect(read).toEqual([2, 3, 4, 5, 6, 7]);
  });

  it('spans a window between two frames with those two, and one past either end with the frame there is', () => {
    const track = trackOf(walking());
    expect(subjectRun(track, { fromMs: 130, toMs: 170 })!.atMs).toEqual([100, 200]);
    expect(subjectRun(track, { fromMs: 300, toMs: 300 })!.atMs).toEqual([200, 300, 400]);
    expect(subjectRun(track, { fromMs: 0, toMs: 1000 })!.atMs).toEqual(walking().map((_, k) => k * 100));
    expect(subjectRun(track, { fromMs: 5000, toMs: 6000 })!.atMs).toEqual([1000]);
    const late = trackOf(walking(), { times: walking().map((_, k) => 1000 + k * 100) });
    expect(subjectRun(late, { fromMs: 0, toMs: 500 })!.atMs).toEqual([1000]);
    // Either way round.
    expect(subjectRun(track, { fromMs: 650, toMs: 250 })!.atMs).toEqual([200, 300, 400, 500, 600, 700]);
  });

  it("takes the middle of a robust box, the finder's strays left out", () => {
    // Three stray cells of the subject in far corners of each frame: under a fiftieth of its cells.
    const strays: Blob[] = [
      { x: 0, y: 0, w: 2, h: 1 },
      { x: 63, y: 35, w: 1, h: 1 },
    ];
    const run = subjectRun(trackOf([frame(person(20), ...strays), frame(person(24), ...strays)]), { fromMs: 0, toMs: 100 })!;
    expect(run.x).toEqual([24 / W, 28 / W]);
    expect(run.y).toEqual([0.5, 0.5]);
    expect(run.box).toEqual({ w: 8 / W, h: round5(20 / H) });
  });

  it('sizes it by its height against the seen frame of the median height, never by its width or area', () => {
    // Arms out (twice as wide), standing, crouched (half as tall), turned side on (half as wide), nearer.
    const shapes = [person(16, 8, 16, 20), person(20), person(20, 18, 8, 10), person(22, 8, 4, 20), person(20, 4, 8, 30)];
    const run = subjectRun(trackOf(shapes.map(blob => frame(blob))), { fromMs: 0, toMs: 400 })!;
    expect(run.scale).toEqual([1, 1, 0.5, 1, 1.5]);
    // By height - 10, 20, 20, 20, 30 - the middle is the second of the frames 20 high: standing.
    expect(run.anchorMs).toBe(100);
    expect(run.box).toEqual({ w: 8 / W, h: round5(20 / H) });
    expect(run.sure).toEqual([100, 100, 100, 100, 100]);
  });

  it('loses a subject where it is gone, writing the stretch as the tracker does, and carries it across', () => {
    const frames = walking().map((cells, k) => (k === 4 || k === 5 ? frame() : cells));
    const run = subjectRun(trackOf(frames), { fromMs: 0, toMs: 1000 })!;
    expect(run.sure).toEqual([100, 100, 100, 100, 0, 0, 100, 100, 100, 100, 100]);
    expect(run.lost).toEqual([400, 500]);
    expect(run.seen).toBe(9 / 11);
    // Carried on at the speed it had rather than held where it was last seen: where it would have been.
    expect(run.x[4]).toBeCloseTo((8 + 16) / W, 4);
    expect(run.x[5]).toBeCloseTo((8 + 20) / W, 4);
    expect(run.y[4]).toBeCloseTo(0.5, 5);
    expect(run.scale[4]).toBe(1);
    // A run that only coasted, never jumped: each sample a step of the walk on from the one before.
    for (let k = 1; k < run.x.length; k++) expect(run.x[k]! - run.x[k - 1]!).toBeCloseTo(4 / W, 4);
  });

  it('writes a lone unseen frame as a millisecond, and drifts on past the last sighting', () => {
    const frames = walking().slice(0, 6);
    frames[2] = frame();
    frames[5] = frame();
    const run = subjectRun(trackOf(frames), { fromMs: 0, toMs: 500 })!;
    expect(run.lost).toEqual([200, 201, 500, 501]);
    // On the way it was going, slowing, rather than stopping dead or carrying on at full speed.
    expect(run.x[5]).toBeGreaterThan(run.x[4]! + 1 / W);
    expect(run.x[5]).toBeLessThan(run.x[4]! + 4 / W);
  });

  it('does not take a sliver going out of shot for the subject, though it has cells to spare', () => {
    // Sinking out of the bottom of the shot: at 500 ms only its top two rows are left, 16 of its 160 cells.
    const sinking = (lastY: number) => [8, 10, 12, 14, 16, lastY].map(y => frame(person(28, y)));
    expect(16).toBeGreaterThanOrEqual(MIN_SEEN_CELLS);
    expect(16).toBeLessThan(SEEN_SHARE * 160);
    const run = subjectRun(trackOf(sinking(34)), { fromMs: 0, toMs: 500 })!;
    expect(run.sure).toEqual([100, 100, 100, 100, 100, 0]);
    expect(run.lost).toEqual([500, 501]);
    // Its size held, not the sliver's two rows of twenty, and its middle carried on down, not at the edge.
    expect(run.scale[5]).toBe(1);
    expect(run.y[5]).toBeGreaterThan(run.y[4]!);
    expect(run.y[5]).toBeLessThan(34 / H);
    // Six rows of it are still it, and sized as they are.
    const piece = subjectRun(trackOf(sinking(30)), { fromMs: 0, toMs: 500 })!;
    expect(piece.sure[5]).toBe(100);
    expect(piece.scale[5]).toBe(0.3);
  });

  it('sees nobody in a speck under the floor, even where the speck is all the subject there is', () => {
    const specks = [frame({ x: 10, y: 10, w: 2, h: 3 }), frame({ x: 12, y: 10, w: 2, h: 3 })];
    expect(subjectRun(trackOf(specks), { fromMs: 0, toMs: 100 })).toBeNull();
    expect(subjectRun(trackOf([frame({ x: 10, y: 10, w: 3, h: 3 })]), { fromMs: 0, toMs: 0 })!.sure).toEqual([100]);
    // A speck where it is gone is not a sighting of it either.
    const run = subjectRun(trackOf([frame(person(10)), frame({ x: 50, y: 2, w: 2, h: 3 }), frame(person(18))]), { fromMs: 0, toMs: 200 })!;
    expect(run.sure).toEqual([100, 0, 100]);
    expect(run.x[1]).toBeCloseTo(18 / W, 4);
  });

  it('follows the subject with the most cells, or the one asked for', () => {
    // Subject 1 small and moving, subject 2 large and still.
    const frames = [0, 1, 2, 3, 4].map(k => frame({ id: 1, x: 2 + 2 * k, y: 2, w: 4, h: 6 }, { id: 2, x: 40, y: 10, w: 10, h: 20 }));
    const track = trackOf(frames);
    const big = subjectRun(track, { fromMs: 0, toMs: 400 })!;
    expect(big.subjectId).toBe(2);
    expect(big.x).toEqual(big.atMs.map(() => round5(45 / W)));
    const small = subjectRun(track, { fromMs: 0, toMs: 400, subjectId: 1 })!;
    expect(small.subjectId).toBe(1);
    expect(small.x).toEqual([0, 1, 2, 3, 4].map(k => round5((4 + 2 * k) / W)));
    expect(small.y).toEqual(small.atMs.map(() => round5(5 / H)));
    expect(small.box).toEqual({ w: 4 / W, h: round5(6 / H) });
  });

  it('picks among the subjects the track lists, and among any it holds where it lists none', () => {
    // Subject 3 has the most cells, but the finder's list names only 1 and 2.
    const frames = [frame({ id: 1, x: 2, y: 2, w: 6, h: 10 }, { id: 3, x: 30, y: 4, w: 20, h: 30 })];
    expect(subjectRun(trackOf(frames), { fromMs: 0, toMs: 0 })!.subjectId).toBe(1);
    expect(subjectRun(trackOf(frames, { subjects: null }), { fromMs: 0, toMs: 0 })!.subjectId).toBe(3);
    expect(subjectRun(trackOf(frames, { subjects: [] }), { fromMs: 0, toMs: 0 })).toBeNull();
    // Asked for by its id, it is followed whatever the list says.
    expect(subjectRun(trackOf(frames), { fromMs: 0, toMs: 0, subjectId: 3 })!.subjectId).toBe(3);
  });

  it('is null for an id no cell can hold, a subject never there, a window that is no window, and nobody at all', () => {
    const track = trackOf([frame(person(10)), frame(person(12))]);
    for (const subjectId of [0, -1, 1.5, 256, Number.NaN]) expect(subjectRun(track, { fromMs: 0, toMs: 100, subjectId }), String(subjectId)).toBeNull();
    expect(subjectRun(track, { fromMs: 0, toMs: 100, subjectId: 2 })).toBeNull();
    expect(subjectRun(track, { fromMs: Number.NaN, toMs: 100 })).toBeNull();
    expect(subjectRun(trackOf([frame(), frame()]), { fromMs: 0, toMs: 100 })).toBeNull();
  });

  it("gives a picture's one frame as one sample, wherever the window is", () => {
    const picture = trackOf([frame(person(30))], { kind: 'image' });
    for (const window of [
      { fromMs: 0, toMs: 3000 },
      { fromMs: 500, toMs: 2500 },
    ]) {
      expect(subjectRun(picture, window)).toEqual({
        atMs: [0],
        x: [34 / W],
        y: [0.5],
        scale: [1],
        turn: [0],
        sure: [100],
        lost: [],
        anchorMs: 0,
        subjectId: 1,
        aspect: W / H,
        box: { w: 8 / W, h: round5(20 / H) },
        seen: 1,
      });
    }
  });

  it('makes a track the editor keeps exactly as it is', () => {
    // Growing a row a frame, and gone for two frames.
    const frames = walking().map((_, k) => (k === 4 || k === 5 ? frame() : frame(person(4 + 4 * k, 8, 8, 16 + k))));
    for (const toMs of [1000, 300]) {
      const run = subjectRun(trackOf(frames), { fromMs: 0, toMs })!;
      const track = trackFromRun({ ...run, clipId: 'a', clipKey: 'a' }, 'k', 'Rider', 0);
      expect(normaliseEditTrack(track), `to ${toMs}`).toBe(track);
    }
  });
});
