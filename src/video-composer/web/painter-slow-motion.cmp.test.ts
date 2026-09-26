import { describe, expect, it, vi } from 'vitest';

import { NEUTRAL_SIDE, type TransitionLook } from '../../editor/transitions';

import { throughCamera } from './camera-draw';
import { Painter, WHOLE_FRAME, type LayerDraw, type LayerSource, type TransitionDraw } from './painter';

/**
 * A synthesised frame - a slowed clip's picture made from the two recorded frames either side of an
 * instant - drawn by the real painter in a real browser, on the GPU and on the 2D fallback, and read
 * back in pixels.
 *
 * What is pinned is [LayerDraw.tween]'s contract:
 *
 *  - the picture is `mix(A, B, w)` - half of red and half of blue is their average, on both paths;
 *  - no second frame, or a weight of 0, is the one-frame path TO THE BIT, which is what every clip at
 *    1x or faster and every picture is drawn by;
 *  - B is sampled at A's coordinates, so crop, fit, rectangle, turn and camera place the synthesised
 *    frame exactly where they place a recorded one;
 *  - the colour matrix grades the mixed picture, and the layer's opacity applies to it once;
 *  - a transition's outgoing side is blended like any layer;
 *  - a weight is never inherited by the layer drawn after it.
 */

const W = 100;
const H = 100;

function solid(colour: string, size = 64): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** Four coloured quadrants, `colours` in TL, TR, BL, BR order: a picture with a WHERE in it. */
function quadrants(colours: readonly [string, string, string, string], size = 200): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const half = size / 2;
  [
    [0, 0],
    [half, 0],
    [0, half],
    [half, half],
  ].forEach(([x, y], i) => {
    ctx.fillStyle = colours[i]!;
    ctx.fillRect(x!, y!, half, half);
  });
  return canvas;
}

function layer(source: LayerSource, width: number, height: number, over: Partial<LayerDraw> = {}): LayerDraw {
  return { source, sourceWidth: width, sourceHeight: height, framing: { fit: 'contain' }, dest: WHOLE_FRAME, opacity: 1, ...over };
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

function near(actual: [number, number, number], expected: [number, number, number], tolerance = 2): void {
  for (let c = 0; c < 3; c++) expect(Math.abs(actual[c]! - expected[c]!), `channel ${c} of [${actual}] against [${expected}]`).toBeLessThanOrEqual(tolerance);
}

/** The largest difference in any channel of any pixel between two frames. */
function largestDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let most = 0;
  for (let i = 0; i < a.length; i++) most = Math.max(most, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return most;
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

/** One frame of `draws` on a fresh painter, read back. */
function paint(gpu: boolean, draws: (LayerDraw | TransitionDraw)[], colour?: Parameters<Painter['setColour']>): Uint8ClampedArray {
  const painter = painterFor(gpu);
  try {
    if (colour) painter.setColour(...colour);
    painter.paintLayers(draws);
    return pixels(painter);
  } finally {
    painter.dispose();
  }
}

for (const gpu of [true, false]) {
  describe(`a synthesised frame, ${gpu ? 'on the GPU' : 'on the 2D fallback'}`, () => {
    it('draws on the path it says it does', () => {
      const painter = painterFor(gpu);
      try {
        // A browser without WebGL2 would run the 2D cases twice and call one of them the GPU's.
        if (gpu) expect(painter.usesGpu).toBe(true);
        else expect(painter.usesGpu).toBe(false);
      } finally {
        painter.dispose();
      }
    });

    it('is the AVERAGE of two solid frames halfway between them, and the right share either side', () => {
      const red = solid('#f00');
      const blue = solid('#00f');
      const half = paint(gpu, [layer(red, 64, 64, { tween: { source: blue, weight: 0.5 } })]);
      near(pixel(half, 50, 50), [128, 0, 128]);
      const quarter = paint(gpu, [layer(red, 64, 64, { tween: { source: blue, weight: 0.25 } })]);
      near(pixel(quarter, 50, 50), [191, 0, 64]);
      // All the way is frame B alone.
      const whole = paint(gpu, [layer(red, 64, 64, { tween: { source: blue, weight: 1 } })]);
      near(pixel(whole, 50, 50), [0, 0, 255], 0);
    });

    it('mixes bitmaps, which is what the export holds its frames as', async () => {
      const red = await createImageBitmap(solid('#f00'));
      const green = await createImageBitmap(solid('#0f0'));
      try {
        const half = paint(gpu, [layer(red, 64, 64, { tween: { source: green, weight: 0.5 } })]);
        near(pixel(half, 50, 50), [128, 128, 0]);
      } finally {
        red.close();
        green.close();
      }
    });

    it('is the one-frame path to the bit with no second frame, or a weight of nothing', () => {
      const source = quadrants(['#f00', '#0f0', '#00f', '#fff']);
      const other = solid('#ff0', 200);
      const framing = { fit: 'cover' as const, crop: { x: 0.1, y: 0.2, w: 0.7, h: 0.6 }, rect: { x: 0.1, y: 0.15, w: 0.8, h: 0.6 } };
      const plain = paint(gpu, [layer(source, 200, 200, { framing, rotationDeg: 20, opacity: 0.8 })]);
      for (const tween of [null, undefined, { source: other, weight: 0 }]) {
        const same = paint(gpu, [layer(source, 200, 200, { framing, rotationDeg: 20, opacity: 0.8, tween })]);
        expect(largestDifference(same, plain)).toBe(0);
      }
    });

    it('samples B where it samples A: crop, fit, rectangle, turn and camera place the mix exactly as the one frame', () => {
      const a = quadrants(['#f00', '#0f0', '#00f', '#fff']);
      const framing = { fit: 'cover' as const, crop: { x: 0.2, y: 0.1, w: 0.6, h: 0.7 }, rect: { x: 0.05, y: 0.1, w: 0.9, h: 0.7 } };
      const placed = (over: Partial<LayerDraw>) => throughCamera([layer(a, 200, 200, { framing, rotationDeg: 30, ...over })], { scale: 1.6, cx: 0.45, cy: 0.55 });
      // B the same picture as A: any B read from anywhere else would show here as a seam or a shift.
      const alone = paint(gpu, placed({}));
      const blended = paint(gpu, placed({ tween: { source: quadrants(['#f00', '#0f0', '#00f', '#fff']), weight: 0.5 } }));
      expect(largestDifference(blended, alone)).toBeLessThanOrEqual(1);

      // And B the same layout in other colours: every pixel is the mix of the colours A and B have at
      // that very place. The centre of the top-left quadrant of the picture as placed is red in A and
      // black in B; bottom-right is white in A and blue in B.
      const b = quadrants(['#000', '#f0f', '#0ff', '#00f']);
      const flat = (over: Partial<LayerDraw>) => [layer(a, 200, 200, { framing: { fit: 'cover' }, ...over })];
      const mixed = paint(gpu, flat({ tween: { source: b, weight: 0.5 } }));
      near(pixel(mixed, 25, 25), [128, 0, 0]);
      near(pixel(mixed, 75, 25), [128, 128, 128]);
      near(pixel(mixed, 25, 75), [0, 128, 255]);
      near(pixel(mixed, 75, 75), [128, 128, 255]);
    });

    it('grades the mixed picture with the colour matrix, and fades it by the layer’s opacity once', () => {
      const red = solid('#f00');
      const blue = solid('#00f');
      // Half brightness: the mix, then halved - never the halves of each mixed.
      const graded = paint(
        gpu,
        [layer(red, 64, 64, { tween: { source: blue, weight: 0.5 } })],
        [
          { m: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5], o: [0, 0, 0] },
          { filter: 'brightness(0.5)', tints: [] },
        ],
      );
      near(pixel(graded, 50, 50), [64, 0, 64]);

      // Half opacity over white: exactly what the same path draws for ONE frame that already is the
      // mix - not the mix of two half-transparent frames, which would let more of the white through.
      // Measured against the path's own one-frame drawing, because the fallback has always laid a
      // translucent layer's black down first where the shader does not; that is not this.
      const over = (top: LayerDraw) => paint(gpu, [layer(solid('#fff'), 64, 64, { framing: { fit: 'cover' } }), top]);
      const faded = over(layer(red, 64, 64, { framing: { fit: 'cover' }, opacity: 0.5, tween: { source: blue, weight: 0.5 } }));
      const premixed = over(layer(solid('#800080'), 64, 64, { framing: { fit: 'cover' }, opacity: 0.5 }));
      near(pixel(faded, 50, 50), pixel(premixed, 50, 50));
      if (gpu) near(pixel(faded, 50, 50), [191, 128, 191]);
    });

    it('never hands its weight on to the layer drawn after it', () => {
      const faded = paint(gpu, [
        layer(solid('#f00'), 64, 64, { dest: { x: 0, y: 0, w: 0.5, h: 1 }, framing: { fit: 'cover' }, tween: { source: solid('#00f'), weight: 0.5 } }),
        layer(solid('#0f0'), 64, 64, { dest: { x: 0.5, y: 0, w: 0.5, h: 1 }, framing: { fit: 'cover' } }),
      ]);
      near(pixel(faded, 25, 50), [128, 0, 128]);
      near(pixel(faded, 75, 50), [0, 255, 0], 0);
    });

    it('blends a transition’s outgoing side like any layer', () => {
      // The incoming side not drawn at all - no alpha - so the frame is the outgoing side alone.
      const look: TransitionLook = { alpha: 0, reveal: 1, from: { ...NEUTRAL_SIDE }, to: { ...NEUTRAL_SIDE } };
      const frame = paint(gpu, [
        {
          kind: 'transition',
          from: layer(solid('#f00'), 64, 64, { framing: { fit: 'cover' }, tween: { source: solid('#00f'), weight: 0.5 } }),
          to: layer(solid('#0f0'), 64, 64, { framing: { fit: 'cover' } }),
          look,
          transition: {},
        },
      ]);
      near(pixel(frame, 50, 50), [128, 0, 128]);
    });
  });
}
