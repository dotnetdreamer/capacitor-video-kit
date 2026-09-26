import { describe, expect, it } from 'vitest';

import type { ComposeCamera } from '../video-composer/definitions';
import { cameraAt, clampView, isIdentityView, normaliseCamera, unviewPoint, viewPoint } from './camera';

/*
 * [cameraAt] is the preview's reading of the wire and the web engine's, so it has to read the
 * [ComposeCamera] contract to the letter: ends hold, straight lines between keys, equal times a step
 * with the later key winning. [normaliseCamera] is the parser's rules, shared by the tests and the
 * web engine.
 */

const cam = (keys: [number, number, number, number][]): ComposeCamera => ({
  atMs: keys.map(k => k[0]),
  scale: keys.map(k => k[1]),
  cx: keys.map(k => k[2]),
  cy: keys.map(k => k[3]),
});

describe('cameraAt', () => {
  const camera = cam([
    [1000, 1, 0.5, 0.5],
    [2000, 3, 0.25, 0.75],
    [3000, 3, 0.25, 0.75],
    [3000, 2, 0.5, 0.5],
    [4000, 1, 0.5, 0.5],
  ]);

  it('is null with no camera and at the whole frame', () => {
    expect(cameraAt(null, 0)).toBeNull();
    expect(cameraAt(undefined, 0)).toBeNull();
    expect(cameraAt({ atMs: [], scale: [], cx: [], cy: [] }, 0)).toBeNull();
    expect(cameraAt(camera, 0)).toBeNull();
    expect(cameraAt(camera, 1000)).toBeNull();
    expect(cameraAt(camera, 9000)).toBeNull();
  });

  it('interpolates every field in a straight line', () => {
    expect(cameraAt(camera, 1500)).toEqual({ scale: 2, cx: 0.375, cy: 0.625 });
    expect(cameraAt(camera, 2500)).toEqual({ scale: 3, cx: 0.25, cy: 0.75 });
  });

  it('steps at equal times, the later key winning', () => {
    expect(cameraAt(camera, 2999.999)!.scale).toBeCloseTo(3, 6);
    expect(cameraAt(camera, 3000)).toEqual({ scale: 2, cx: 0.5, cy: 0.5 });
    expect(cameraAt(camera, 3500)).toEqual({ scale: 1.5, cx: 0.5, cy: 0.5 });
  });

  it('holds the end keys', () => {
    const held = cam([
      [1000, 2, 0.4, 0.6],
      [2000, 2, 0.6, 0.4],
    ]);
    expect(cameraAt(held, 0)).toEqual({ scale: 2, cx: 0.4, cy: 0.6 });
    expect(cameraAt(held, 5000)).toEqual({ scale: 2, cx: 0.6, cy: 0.4 });
    // A step on the very first key.
    const first = cam([
      [0, 1, 0.5, 0.5],
      [0, 2, 0.5, 0.5],
    ]);
    expect(cameraAt(first, 0)!.scale).toBe(2);
  });

  it('finds the right pair in a long track (binary search)', () => {
    const n = 10_000;
    const long: ComposeCamera = { atMs: [], scale: [], cx: [], cy: [] };
    for (let i = 0; i < n; i++) {
      long.atMs.push(i * 10);
      long.scale.push(1 + (i % 2));
      long.cx.push(0.5);
      long.cy.push(0.5);
    }
    // Key 4321 is odd (scale 2), 4322 even (scale 1): a quarter of the way is 1.75.
    expect(cameraAt(long, 43_212.5)!.scale).toBeCloseTo(1.75, 9);
  });
});

describe('the view maths', () => {
  it('maps a point through the view and back', () => {
    const view = { scale: 2, cx: 0.25, cy: 0.75 };
    expect(viewPoint(view, 0.25, 0.75)).toEqual({ x: 0.5, y: 0.5 });
    expect(viewPoint(view, 0, 0.5)).toEqual({ x: 0, y: 0 });
    const p = unviewPoint(view, 0.9, 0.1);
    const back = viewPoint(view, p.x, p.y);
    expect(back.x).toBeCloseTo(0.9, 12);
    expect(back.y).toBeCloseTo(0.1, 12);
  });

  it('holds a view on the frame', () => {
    expect(clampView({ scale: 20, cx: 0, cy: 1 })).toEqual({ scale: 8, cx: 0.0625, cy: 0.9375 });
    expect(clampView({ scale: 0.5, cx: 0.1, cy: 0.9 })).toEqual({ scale: 1, cx: 0.5, cy: 0.5 });
    expect(clampView({ scale: NaN, cx: NaN, cy: 0.5 })).toEqual({ scale: 1, cx: 0.5, cy: 0.5 });
    expect(isIdentityView({ scale: 1.00001, cx: 0.3, cy: 0.3 })).toBe(true);
    expect(isIdentityView({ scale: 1.1, cx: 0.5, cy: 0.5 })).toBe(false);
  });
});

describe('normaliseCamera', () => {
  it('clamps every key and drops a camera that never zooms', () => {
    const out = normaliseCamera(
      cam([
        [0, 1, 0.5, 0.5],
        [100, 10, -1, 2],
      ]),
    )!;
    expect(out).toEqual(
      cam([
        [0, 1, 0.5, 0.5],
        [100, 8, 0.0625, 0.9375],
      ]),
    );
    expect(
      normaliseCamera(
        cam([
          [0, 1, 0.2, 0.2],
          [100, 0.5, 0.5, 0.5],
        ]),
      ),
    ).toBeNull();
    expect(normaliseCamera(null)).toBeNull();
  });

  it('rejects what no engine could honour', () => {
    expect(() => normaliseCamera({ atMs: [0, 1], scale: [2], cx: [0.5, 0.5], cy: [0.5, 0.5] })).toThrow();
    expect(() =>
      normaliseCamera(
        cam([
          [100, 2, 0.5, 0.5],
          [50, 2, 0.5, 0.5],
        ]),
      ),
    ).toThrow();
    expect(() => normaliseCamera(cam([[NaN, 2, 0.5, 0.5]]))).toThrow();
    const n = 20_001;
    expect(() => normaliseCamera({ atMs: Array.from({ length: n }, (_, i) => i), scale: Array(n).fill(2), cx: Array(n).fill(0.5), cy: Array(n).fill(0.5) })).toThrow();
  });
});
