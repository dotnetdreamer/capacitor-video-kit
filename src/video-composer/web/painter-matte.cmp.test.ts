import { describe, expect, it, vi } from 'vitest';

import { flatCorners, type MatteDraw } from './matte-pass';
import { Painter, WHOLE_FRAME, type LayerDraw } from './painter';

/**
 * The people put back over the layers behind them, drawn by the real painter in a real browser, on the GPU and on
 * the 2D fallback, and read back in pixels: the video, then the layers behind, then the video again where the
 * matte says people are, then the layers on surfaces nobody is behind. The matte here is a hard edge down the
 * middle - its left half a person - so the pixels well inside each half say what was drawn where.
 */

const W = 100;
const H = 100;

const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

function solid(colour: string, width = 100, height = 100): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function video(): LayerDraw {
  const source = solid('#f00');
  return { source, sourceWidth: source.width, sourceHeight: source.height, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1 };
}

/** A 10 x 10 grid whose left five columns are a person. */
function leftHalf(): MatteDraw {
  const mask = new Uint8Array(100);
  for (let y = 0; y < 10; y++) mask.fill(255, y * 10, y * 10 + 5);
  return { mask, maskWidth: 10, maskHeight: 10, maskKey: 'left' };
}

/** A layer over the whole frame, as a quad. */
function cover(colour: string) {
  return { bitmap: solid(colour), corners: [0, 0, 1, 0, 1, 1, 0, 1], opacity: 1 };
}

function pixel(painter: Painter, x: number, y: number): [number, number, number] {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(painter.frame, 0, 0);
  const data = ctx.getImageData(x, y, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
}

function near(actual: [number, number, number], expected: [number, number, number], tolerance = 8): void {
  for (let c = 0; c < 3; c++) expect(Math.abs(actual[c]! - expected[c]!), `channel ${c} of [${actual}] against [${expected}]`).toBeLessThanOrEqual(tolerance);
}

function painterFor(gpu: boolean): Painter {
  let painter: Painter;
  if (gpu) {
    painter = new Painter({ width: W, height: H });
  } else {
    const real = HTMLCanvasElement.prototype.getContext;
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string, options?: unknown) {
      return type === 'webgl2' ? null : (real as (this: HTMLCanvasElement, type: string, options?: unknown) => RenderingContext | null).call(this, type, options);
    } as typeof real);
    try {
      painter = new Painter({ width: W, height: H });
    } finally {
      spy.mockRestore();
    }
  }
  painter.setColour(null, { filter: 'none', tints: [] });
  return painter;
}

for (const gpu of [true, false]) {
  describe(`the people put back, ${gpu ? 'on the GPU' : 'on the 2D fallback'}`, () => {
    it('puts the video back over a layer behind where the people are, and leaves the layer elsewhere', () => {
      const painter = painterFor(gpu);
      painter.paintLayers([video()], { behind: [cover('#00f')], matte: leftHalf(), quads: [] });
      near(pixel(painter, 15, 50), RED);
      near(pixel(painter, 85, 50), BLUE);
    });

    it('draws a layer on a surface nobody is behind over the people', () => {
      const painter = painterFor(gpu);
      painter.paintLayers([video()], { behind: [cover('#00f')], matte: leftHalf(), quads: [{ ...cover('#0f0'), corners: [0, 0.8, 1, 0.8, 1, 1, 0, 1] }] });
      near(pixel(painter, 15, 50), RED);
      near(pixel(painter, 15, 90), GREEN);
    });

    it('draws a flat layer behind where its pose puts it', () => {
      const painter = painterFor(gpu);
      const corners = flatCorners({ cx: 0.75, cy: 0.25, wPx: 20, hPx: 20, rotationDeg: 0 }, null, { width: W, height: H })!;
      painter.paintLayers([video()], { behind: [{ bitmap: solid('#00f', 20, 20), corners, opacity: 1 }], matte: leftHalf(), quads: [] });
      near(pixel(painter, 75, 25), BLUE);
      near(pixel(painter, 75, 75), RED);
    });

    it('is the layer behind over everything with no matte, as an engine with no people draws it', () => {
      const painter = painterFor(gpu);
      painter.paintLayers([video()], { behind: [cover('#00f')], matte: null, quads: [] });
      near(pixel(painter, 15, 50), BLUE);
    });
  });
}
