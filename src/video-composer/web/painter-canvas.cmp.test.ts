import { describe, expect, it, vi } from 'vitest';

import { rectMotionAt } from '../../editor/layout-motion';
import type { ComposeRectMotion } from '../definitions';

import { Painter, WHOLE_FRAME, type LayerDraw } from './painter';

/**
 * The canvas a post is painted on, and a layer whose rectangle moves - drawn by the real painter in a
 * real browser, on the GPU and on the 2D fallback, and read back in pixels.
 *
 * What is pinned is `ComposeSpec.background` and `ComposeRectMotion`: the canvas is what shows
 * wherever no picture is drawn - around a placed clip and in its letterbox bars - and black when
 * nobody coloured it; a moving rectangle is drawn wherever its keys put it at the instant asked for.
 */

const W = 100;
const H = 100;

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];
const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];

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

function layer(source: HTMLCanvasElement, over: Partial<LayerDraw> = {}): LayerDraw {
  return { source, sourceWidth: source.width, sourceHeight: source.height, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1, ...over };
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

function near(actual: [number, number, number], expected: [number, number, number], tolerance = 6): void {
  for (let c = 0; c < 3; c++) expect(Math.abs(actual[c]! - expected[c]!), `channel ${c} of [${actual}] against [${expected}]`).toBeLessThanOrEqual(tolerance);
}

/** The painter, with or without its GPU; without is how the 2D fallback is reached here. */
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
  describe(`the canvas, ${gpu ? 'on the GPU' : 'on the 2D fallback'}`, () => {
    it('is black until a post colours it', () => {
      const painter = painterFor(gpu);
      painter.paintLayers([layer(solid('#f00'), { framing: { fit: 'cover', rect: { x: 0, y: 0, w: 1, h: 0.5 } } })]);
      near(pixel(painter, 50, 25), RED);
      near(pixel(painter, 50, 75), BLACK);
    });

    it('shows round a clip placed smaller than the frame, and with nothing drawn at all', () => {
      const painter = painterFor(gpu);
      painter.setBackground([1, 1, 1]);
      painter.paintLayers([layer(solid('#f00'), { framing: { fit: 'cover', rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.4 } } })]);
      near(pixel(painter, 50, 30), RED);
      near(pixel(painter, 50, 75), WHITE);
      near(pixel(painter, 4, 30), WHITE);
      painter.paintLayers([]);
      near(pixel(painter, 50, 50), WHITE);
    });

    it('is a contained clip letterbox bars', () => {
      const painter = painterFor(gpu);
      painter.setBackground([1, 1, 1]);
      // A 2:1 picture contained in a square frame: a band across the middle, bars above and below.
      painter.paintLayers([layer(solid('#f00', 200, 100), { framing: { fit: 'contain' } })]);
      near(pixel(painter, 50, 50), RED);
      near(pixel(painter, 50, 10), WHITE);
      near(pixel(painter, 50, 90), WHITE);
    });
  });

  describe(`a moving rectangle, ${gpu ? 'on the GPU' : 'on the 2D fallback'}`, () => {
    // The bottom half sliding up from under the bottom edge over 100 ms.
    const keys: ComposeRectMotion = { atMs: [0, 100], x: [0, 0], y: [1, 0.5], w: [1, 1], h: [0.5, 0.5] };

    it('is drawn where its keys put it at the instant asked for', () => {
      const painter = painterFor(gpu);
      painter.setBackground([1, 1, 1]);
      const at = (ms: number): void => painter.paintLayers([layer(solid('#00f'), { dest: rectMotionAt(keys, ms) })]);

      at(100);
      near(pixel(painter, 50, 75), BLUE);
      near(pixel(painter, 50, 25), WHITE);

      // Half way: the top of the picture is at three quarters of the frame.
      at(50);
      near(pixel(painter, 50, 90), BLUE);
      near(pixel(painter, 50, 60), WHITE);
    });
  });
}
