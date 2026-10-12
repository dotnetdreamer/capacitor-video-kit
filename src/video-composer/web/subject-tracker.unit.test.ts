import { describe, expect, it } from 'vitest';

import { MAX_SUBJECTS, SUBJECT_GRID } from '../definitions';
import { componentsOf, FORGET_AFTER_MS, minInstanceCells, subjectGrid, SubjectTracker, toGrid } from './subject-tracker';

/*
 * The tracker is the reference the native engines port line for line, so its rules are held here as
 * cases each port runs too: what a speck is, what touching means, who is matched to whom, who is
 * forgotten, who was noise, and the order the survivors are numbered in.
 */

const W = 20;
const H = 10;

/** A W x H grid with each rectangle [x0, y0, x1, y1] (inclusive) filled with its value. */
function grid(...boxes: [number, number, number, number, number][]): Uint8Array {
  const out = new Uint8Array(W * H);
  for (const [x0, y0, x1, y1, value] of boxes) for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) out[y * W + x] = value;
  return out;
}

describe('subjectGrid', () => {
  it('puts SUBJECT_GRID cells on the longer side and the other in proportion', () => {
    expect(subjectGrid(1080, 1920)).toEqual({ width: 180, height: SUBJECT_GRID });
    expect(subjectGrid(1920, 1080)).toEqual({ width: SUBJECT_GRID, height: 180 });
    expect(subjectGrid(1000, 1000)).toEqual({ width: SUBJECT_GRID, height: SUBJECT_GRID });
    expect(subjectGrid(10_000, 1)).toEqual({ width: SUBJECT_GRID, height: 1 });
  });
});

describe('toGrid', () => {
  it('takes the pixel under each cell centre, stretched over the whole frame', () => {
    // A 4x4 mask, left half instance 1, read onto a 2x1 grid.
    const mask = [1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0];
    expect([...toGrid(mask, 4, 4, new Uint8Array(2), 2, 1)]).toEqual([1, 0]);
  });

  it('makes a confidence foreground at the threshold and above', () => {
    expect([...toGrid([0.49, 0.5, 0.9, 0.1], 4, 1, new Uint8Array(4), 4, 1, 0.5)]).toEqual([0, 1, 1, 0]);
  });
});

describe('componentsOf', () => {
  it('numbers the groups that touch in scan order, corners counting as touching', () => {
    const cells = grid([0, 0, 4, 9, 1], [5, 0, 9, 9, 1], [12, 0, 19, 9, 1]);
    expect(componentsOf(cells, W, H)).toBe(2);
    expect(cells[0]).toBe(1);
    expect(cells[9]).toBe(1);
    expect(cells[12]).toBe(2);
    // Diagonal neighbours are one group.
    const diagonal = grid([0, 0, 2, 2, 1], [3, 3, 5, 5, 1]);
    expect(componentsOf(diagonal, W, H)).toBe(1);
  });

  it('makes a speck background', () => {
    expect(minInstanceCells(W * H)).toBe(4);
    const cells = grid([0, 0, 0, 2, 1], [10, 0, 19, 9, 1]);
    expect(componentsOf(cells, W, H)).toBe(1);
    expect(cells[0]).toBe(0);
    expect(cells[10]).toBe(1);
  });
});

describe('SubjectTracker', () => {
  const finish = (tracker: SubjectTracker) => tracker.finish({ engine: 'mediapipe', kind: 'video', durationMs: 1000, fps: 10, subjectKind: 'person' });

  it('follows a subject that moves, by overlap, as one id', () => {
    const tracker = new SubjectTracker(W, H);
    for (let f = 0; f < 5; f++) tracker.add(f * 100, grid([f, 0, f + 6, 9, 1]), 1);
    const content = finish(tracker);
    expect(content.meta.subjects.map(s => s.id)).toEqual([1]);
    expect(content.frames.every(frame => frame.some(cell => cell === 1))).toBe(true);
    expect(content.meta.subjects[0]).toMatchObject({ startMs: 0, endMs: 400, kind: 'person' });
  });

  it('keeps two subjects apart even when the segmenter numbers them differently in each frame', () => {
    const tracker = new SubjectTracker(W, H);
    tracker.add(0, grid([0, 0, 5, 9, 1], [12, 0, 19, 9, 2]), 2);
    tracker.add(100, grid([0, 0, 5, 9, 2], [12, 0, 19, 9, 1]), 2);
    tracker.add(200, grid([0, 0, 5, 9, 1], [12, 0, 19, 9, 2]), 2);
    const content = finish(tracker);
    // The larger subject (the right one, 8 columns) is the main one, id 1, in every frame.
    for (const frame of content.frames) {
      expect(frame[12]).toBe(1);
      expect(frame[0]).toBe(2);
    }
  });

  it('starts somebody new for an instance that overlaps nobody', () => {
    const tracker = new SubjectTracker(W, H);
    tracker.add(0, grid([0, 0, 5, 9, 1]), 1);
    tracker.add(100, grid([0, 0, 5, 9, 1], [12, 0, 19, 9, 2]), 2);
    tracker.add(200, grid([0, 0, 5, 9, 1], [12, 0, 19, 9, 2]), 2);
    tracker.add(300, grid([0, 0, 5, 9, 1], [12, 0, 19, 9, 2]), 2);
    const subjects = finish(tracker).meta.subjects;
    expect(subjects).toHaveLength(2);
    expect(subjects.find(s => s.startMs === 100)).toBeTruthy();
  });

  it('forgets somebody gone longer than a second, and takes their return for somebody new', () => {
    const tracker = new SubjectTracker(W, H);
    for (let f = 0; f < 3; f++) tracker.add(f * 100, grid([0, 0, 9, 9, 1]), 1);
    for (let f = 0; f < 3; f++) tracker.add(1400 + f * 100, grid([0, 0, 9, 9, 1]), 1);
    const subjects = finish(tracker).meta.subjects;
    expect(subjects).toHaveLength(2);
    expect(subjects.map(s => [s.startMs, s.endMs])).toEqual([
      [0, 200],
      [1400, 1600],
    ]);
  });

  it('drops a subject seen in fewer than three frames, or too small to be one', () => {
    const tracker = new SubjectTracker(W, H);
    tracker.add(0, grid([0, 0, 9, 9, 1], [15, 0, 19, 9, 2]), 2);
    tracker.add(100, grid([0, 0, 9, 9, 1]), 1);
    tracker.add(200, grid([0, 0, 9, 9, 1]), 1);
    const content = finish(tracker);
    expect(content.meta.subjects.map(s => s.id)).toEqual([1]);
    // The blip's cells are background in the frame it was in.
    expect(content.frames[0]![15]).toBe(0);
  });

  it('keeps a picture subject seen in its one frame', () => {
    const tracker = new SubjectTracker(W, H);
    tracker.add(0, grid([2, 2, 8, 8, 1]), 1);
    const content = tracker.finish({ engine: 'vision', kind: 'image', durationMs: 0, fps: 0, subjectKind: 'subject' });
    expect(content.meta.subjects).toEqual([{ id: 1, kind: 'subject', startMs: 0, endMs: 0, peakMs: 0, box: { x: 0.1, y: 0.2, w: 0.35, h: 0.7 }, area: 0.245 }]);
  });

  it('keeps at most MAX_SUBJECTS, the largest', () => {
    const tracker = new SubjectTracker(W, H);
    // Ten subjects in two rows of five, each 2x4 with a gap, the later ones a column wider.
    const boxes: [number, number, number, number, number][] = [];
    for (let n = 0; n < 10; n++) {
      const row = n < 5 ? 0 : 5;
      const x = (n % 5) * 4;
      boxes.push([x, row, x + (n >= 8 ? 2 : 1), row + 3, n + 1]);
    }
    for (let f = 0; f < 3; f++) tracker.add(f * 100, grid(...boxes), 10);
    const subjects = finish(tracker).meta.subjects;
    expect(subjects).toHaveLength(MAX_SUBJECTS);
    // The two wider ones are first.
    expect(subjects.slice(0, 2).map(s => s.area)).toEqual([0.06, 0.06]);
  });

  /* What the iOS port found: 16 bits wrapped the 65,537th onto the first, whose cells then went to nobody. */
  it('keeps a subject its own past 65,535 provisional ones', () => {
    const tracker = new SubjectTracker(W, H);
    // A speck-sized somebody new in every frame, each forgotten before the next: noise, all of them.
    let t = 0;
    for (let n = 0; n < 65_536; n++, t += FORGET_AFTER_MS + 1) tracker.add(t, grid([0, 0, 1, 1, 1]), 1);
    // Then the one who is really there, for five frames.
    const start = t;
    for (let f = 0; f < 5; f++, t += 100) tracker.add(t, grid([10, 0, 19, 9, 1]), 1);

    const content = finish(tracker);
    expect(content.meta.subjects).toEqual([expect.objectContaining({ id: 1, startMs: start })]);
    expect(content.frames.at(-1)![5 * W + 15]).toBe(1);
  });
});
