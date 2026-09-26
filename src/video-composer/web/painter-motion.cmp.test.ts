import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEUTRAL_MOTION, compileOverlayMotion, overlayMotionAt, type OverlayMotionSample } from '../../editor/motion';

import { Painter, WHOLE_FRAME, type LayerDraw, type OverlayDraw } from './painter';

/**
 * A layer's motion drawn by the real painter in a real browser, on both of its paths, and read back
 * in pixels - the camera's fixture, turned on the overlays.
 *
 * What is pinned is the contract in `ComposeOverlayMotion`: the offset moves the centre in fractions
 * of the frame, the scale sizes the bitmap about that centre, the turn is ADDED to the layer's own and
 * the opacity MULTIPLIED into it; no motion, or one at rest, is the still path to the bit; and a layer
 * scaled or faded to nothing is not drawn at all.
 */

const W = 100;
const H = 100;

const BLACK: [number, number, number] = [0, 0, 0];
const WHITE: [number, number, number] = [255, 255, 255];

function solid(colour: string, width: number, height = width): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, width, height);
  return canvas;
}

function background(): LayerDraw {
  const source = solid('#000', 10);
  return { source, sourceWidth: 10, sourceHeight: 10, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1 };
}

/** A 10 x 10 white square, centred on the frame, upright and opaque unless told otherwise. */
function square(over: Partial<OverlayDraw> = {}): OverlayDraw {
  return { bitmap: solid('#fff', 10), cx: 0.5, cy: 0.5, wPx: 10, hPx: 10, rotationDeg: 0, opacity: 1, ...over };
}

function pixels(painter: Painter): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = painter.frame.width;
  canvas.height = painter.frame.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(painter.frame, 0, 0);
  return ctx.getImageData(0, 0, canvas.width, canvas.height).data;
}

function pixel(frame: Uint8ClampedArray, x: number, y: number): [number, number, number] {
  const i = (y * W + x) * 4;
  return [frame[i] ?? 0, frame[i + 1] ?? 0, frame[i + 2] ?? 0];
}

function near(actual: [number, number, number], expected: [number, number, number], tolerance = 6): void {
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

/** One frame: black, then `overlay`. */
function paint(painter: Painter, overlay: OverlayDraw): Uint8ClampedArray {
  painter.paintLayers([background()]);
  painter.paintOverlay(overlay);
  return pixels(painter);
}

const moved = (over: Partial<OverlayMotionSample>): OverlayMotionSample => ({ ...NEUTRAL_MOTION, ...over });

for (const gpu of [true, false]) {
  describe(`a moving layer drawn ${gpu ? 'over the GPU picture' : 'by the 2D fallback'}`, () => {
    let painter: Painter | null = null;
    afterEach(() => {
      painter?.dispose();
      painter = null;
    });

    it('takes the still path exactly when there is no motion, or it is at rest', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      const plain = paint(painter, square({ rotationDeg: 17, opacity: 0.7 }));
      expect(paint(painter, square({ rotationDeg: 17, opacity: 0.7, motion: null }))).toEqual(plain);
      expect(paint(painter, square({ rotationDeg: 17, opacity: 0.7, motion: { ...NEUTRAL_MOTION } }))).toEqual(plain);
    });

    it('moves the centre by fractions of the frame, right and DOWN', () => {
      painter = painterFor(gpu);
      const frame = paint(painter, square({ motion: moved({ x: 0.2, y: -0.3 }) }));
      // From (50, 50) to (70, 20).
      near(pixel(frame, 70, 20), WHITE);
      near(pixel(frame, 50, 50), BLACK);
      near(pixel(frame, 66, 20), WHITE);
      near(pixel(frame, 63, 20), BLACK);
    });

    it('sizes the bitmap about its own centre', () => {
      painter = painterFor(gpu);
      const frame = paint(painter, square({ cx: 0.3, motion: moved({ scale: 2 }) }));
      // 20 x 20 about (30, 50): 20..40 across.
      near(pixel(frame, 22, 50), WHITE);
      near(pixel(frame, 38, 50), WHITE);
      near(pixel(frame, 17, 50), BLACK);
      near(pixel(frame, 43, 50), BLACK);
      near(pixel(frame, 30, 42), WHITE);
    });

    it('adds its turn to the layer own, clockwise', () => {
      painter = painterFor(gpu);
      const bar = (rotationDeg: number, rotation: number) => ({
        bitmap: solid('#fff', 40, 6),
        cx: 0.5,
        cy: 0.5,
        wPx: 40,
        hPx: 6,
        rotationDeg,
        opacity: 1,
        motion: moved({ rotation }),
      });
      // 30 degrees of its own and 60 of motion: standing up.
      let frame = paint(painter, bar(30, 60));
      near(pixel(frame, 50, 35), WHITE);
      near(pixel(frame, 50, 65), WHITE);
      near(pixel(frame, 35, 50), BLACK);
      // 45 and 0 against 0 and 45: the same bar.
      frame = paint(painter, bar(45, 0));
      const own = pixels(painter);
      paint(painter, bar(0, 45));
      expect(pixels(painter)).toEqual(own);
      // Clockwise in a y-down frame: the right end goes DOWN.
      near(pixel(frame, 60, 60), WHITE);
      near(pixel(frame, 60, 40), BLACK);
    });

    it('multiplies its opacity into the layer own, on the alpha', () => {
      painter = painterFor(gpu);
      const frame = paint(painter, square({ opacity: 0.5, motion: moved({ opacity: 0.5 }) }));
      near(pixel(frame, 50, 50), [64, 64, 64], 3);
    });

    it('draws nothing for a layer scaled or faded to nothing', () => {
      painter = painterFor(gpu);
      const empty = paint(painter, square({ opacity: 0 }));
      expect(paint(painter, square({ motion: moved({ scale: 0 }) }))).toEqual(empty);
      expect(paint(painter, square({ motion: moved({ opacity: 0 }) }))).toEqual(empty);
    });

    it('is where the compiled motion says at each moment, read by the sampler the render uses', () => {
      painter = painterFor(gpu);
      const motion = compileOverlayMotion({ startMs: 0, endMs: 2000 }, { in: { id: 'slide-left', durationMs: 500 } }, 'text')!;
      // At the start of the slide the layer is 12% of the frame to the right and transparent.
      const start = paint(painter, square({ motion: overlayMotionAt(motion, 0) }));
      near(pixel(start, 62, 50), BLACK);
      // Half way it is most of the way home and nearly opaque.
      const half = paint(painter, square({ motion: overlayMotionAt(motion, 250) }));
      const expected = overlayMotionAt(motion, 250)!;
      const x = Math.round(50 + expected.x * W);
      expect(pixel(half, x, 50)[0]).toBeGreaterThan(200);
      // Home and still once it lands.
      expect(overlayMotionAt(motion, 600)).toBeNull();
      expect(paint(painter, square({ motion: overlayMotionAt(motion, 600) }))).toEqual(paint(painter, square()));
    });
  });
}
