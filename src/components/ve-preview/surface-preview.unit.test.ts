import { describe, expect, it } from 'vitest';

import { squareToQuad } from '../../editor/homography';
import { quadCells, quadHomography } from '../../video-composer/web/quad-layers';

import { quadTransform } from './layer-motion';
import { gripSurface, scaleSurface, surfaceGripAt } from './overlay-gestures';

/*
 * The preview's half of a flat surface: taking hold of four corners on the frame, and drawing a layer on its
 * quad through CSS - and the web render's arithmetic for the same quad.
 */

/** A quad on a 400 by 700 frame, a little off square. */
const CORNERS = [0.2, 0.3, 0.8, 0.28, 0.78, 0.7, 0.22, 0.72];

describe('four corners on the frame', () => {
  it('takes the corner a finger lands near, the quad from inside it, and nothing off it', () => {
    expect(surfaceGripAt(CORNERS, 0.2 * 400 + 5, 0.3 * 700 - 4, 400, 700)).toBe(0);
    expect(surfaceGripAt(CORNERS, 0.78 * 400 - 10, 0.7 * 700 + 6, 400, 700)).toBe(2);
    expect(surfaceGripAt(CORNERS, 200, 350, 400, 700)).toBe('move');
    expect(surfaceGripAt(CORNERS, 10, 10, 400, 700)).toBeNull();
  });

  it('moves one corner held to the frame, or the whole quad as far as the frame lets it', () => {
    const moved = gripSurface(CORNERS, 1, 0.5, -0.1);
    expect(moved[2]).toBe(1);
    expect(moved[3]).toBeCloseTo(0.18, 9);
    expect(moved.slice(0, 2)).toEqual([0.2, 0.3]);
    const whole = gripSurface(CORNERS, 'move', -0.5, 0);
    // The left-most corner stops at the frame's edge, and the quad keeps its shape.
    expect(Math.min(whole[0]!, whole[6]!)).toBeCloseTo(0, 9);
    expect(whole[2]! - whole[0]!).toBeCloseTo(CORNERS[2]! - CORNERS[0]!, 9);
  });

  it('grows a quad about its middle for a pinch', () => {
    const grown = scaleSurface([0.4, 0.4, 0.6, 0.4, 0.6, 0.6, 0.4, 0.6], 2);
    expect(grown.map(v => Math.round(v * 1e9) / 1e9)).toEqual([0.3, 0.3, 0.7, 0.3, 0.7, 0.7, 0.3, 0.7]);
  });
});

describe('a layer on its quad in CSS', () => {
  /** Where the `matrix3d` puts the box's point (`x`, `y`). */
  function through(transform: string, x: number, y: number): { x: number; y: number } {
    const m = transform.slice('matrix3d('.length, -1).split(',').map(Number);
    // Column by column: x' = m0 x + m4 y + m12, y' = m1 x + m5 y + m13, w = m3 x + m7 y + m15.
    const w = m[3]! * x + m[7]! * y + m[15]!;
    return { x: (m[0]! * x + m[4]! * y + m[12]!) / w, y: (m[1]! * x + m[5]! * y + m[13]!) / w };
  }

  it('takes the box corner to corner onto the quad', () => {
    const transform = quadTransform(CORNERS, 400, 700, 120, 80)!;
    const box = [
      [0, 0],
      [120, 0],
      [120, 80],
      [0, 80],
    ];
    box.forEach(([x, y], k) => {
      const p = through(transform, x!, y!);
      expect(p.x).toBeCloseTo(CORNERS[2 * k]! * 400, 3);
      expect(p.y).toBeCloseTo(CORNERS[2 * k + 1]! * 700, 3);
    });
  });

  it('draws nothing for a quad an engine would not draw', () => {
    expect(quadTransform([0.2, 0.2, 0.8, 0.8, 0.8, 0.2, 0.2, 0.8], 400, 700, 120, 80)).toBeNull();
    expect(quadTransform([0.1, 0.5, 0.5, 0.5, 0.9, 0.5, 0.5, 0.6], 400, 700, 120, 80)).toBeNull();
  });
});

describe('a layer on its quad in a web render', () => {
  it('is drawn through the homography of its square onto the quad, and not at all folded', () => {
    const frame = { width: 400, height: 700 };
    const h = quadHomography(CORNERS, frame)!;
    expect(h).toEqual(squareToQuad(CORNERS.map((v, k) => v * (k % 2 === 0 ? 400 : 700))));
    expect(quadHomography([0.2, 0.2, 0.8, 0.8, 0.8, 0.2, 0.2, 0.8], frame)).toBeNull();
  });

  it('is cut into more cells on the 2D canvas the more it is foreshortened, and one for a parallelogram', () => {
    const frame = { width: 1080, height: 1920 };
    expect(quadCells(quadHomography([0.2, 0.2, 0.8, 0.2, 0.8, 0.6, 0.2, 0.6], frame)!, frame)).toBe(1);
    const mild = quadCells(quadHomography([0.2, 0.2, 0.8, 0.25, 0.8, 0.55, 0.2, 0.6], frame)!, frame);
    const strong = quadCells(quadHomography([0.2, 0.2, 0.8, 0.35, 0.8, 0.45, 0.2, 0.6], frame)!, frame);
    expect(mild).toBeGreaterThan(1);
    expect(strong).toBeGreaterThan(mild);
    expect(strong).toBeLessThanOrEqual(24);
  });
});
