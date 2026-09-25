import { afterEach, describe, expect, it, vi } from 'vitest';

import { cameraAt, type CameraView } from '../../editor/camera';
import { NEUTRAL_SIDE, compileTransition, lookAt, type TransitionLook } from '../../editor/transitions';

import { throughCamera, withCamera } from './camera-draw';
import { Painter, WHOLE_FRAME, type LayerDraw, type TransitionDraw } from './painter';

/**
 * The camera - a customer's zoom - drawn by the real painter in a real browser, on the GPU and on
 * the 2D fallback, and read back in pixels.
 *
 * The fixture is a source in four coloured QUADRANTS, because a zoom is a statement about WHERE: a
 * solid colour passes a camera pointed at the wrong corner, a camera with its sign flipped, and one
 * that does nothing at all. What is pinned is the contract in `ComposeCamera`:
 *
 *  - the area around (cx, cy), 1/scale of the frame, fills the frame;
 *  - no camera is the old path to the bit;
 *  - the SOURCE is sampled through the camera, so detail finer than the output survives a zoom;
 *  - an overlay is not moved;
 *  - on a transition the camera acts inside each side, and the transition's move stays on the screen.
 */

const W = 100;
const H = 100;

const RED: [number, number, number] = [255, 0, 0];
const GREEN: [number, number, number] = [0, 255, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const WHITE: [number, number, number] = [255, 255, 255];

/** TL red, TR green, BL blue, BR white. */
function quadrants(size = 200): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const half = size / 2;
  for (const [x, y, colour] of [
    [0, 0, '#f00'],
    [half, 0, '#0f0'],
    [0, half, '#00f'],
    [half, half, '#fff'],
  ] as const) {
    ctx.fillStyle = colour;
    ctx.fillRect(x, y, half, half);
  }
  return canvas;
}

function solid(colour: string, size = 100): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, size, size);
  return canvas;
}

/** One-pixel black and white columns: detail a zoom of an output-size frame would smear to grey. */
function stripes(size = 400): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, size, size);
  ctx.fillStyle = '#fff';
  for (let x = 0; x < size; x += 2) ctx.fillRect(x, 0, 1, size);
  return canvas;
}

function layer(source: HTMLCanvasElement, over: Partial<LayerDraw> = {}): LayerDraw {
  return {
    source,
    sourceWidth: source.width,
    sourceHeight: source.height,
    framing: { fit: 'contain' },
    dest: WHOLE_FRAME,
    opacity: 1,
    ...over,
  };
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

const view = (scale: number, cx: number, cy: number): CameraView => ({ scale, cx, cy });

describe('the camera helpers', () => {
  it('hand back the very same draws for no camera, so a frame outside every zoom is untouched', () => {
    const draws = [layer(solid('#f00'))];
    expect(throughCamera(draws, null)).toBe(draws);
    expect(throughCamera(draws, view(1, 0.5, 0.5))).toBe(draws);
    expect(withCamera(draws[0]!, undefined)).toBe(draws[0]);
  });

  it('put the camera on every layer and on BOTH sides of a transition, and copy rather than mutate', () => {
    const base = layer(solid('#f00'));
    const side = layer(solid('#00f'));
    const transition: TransitionDraw = { kind: 'transition', from: side, to: base, look: lookAt(compileTransition('dissolve')!.curves, 0.5), transition: {} };
    const zoom = view(2, 0.25, 0.25);
    const [t, l] = throughCamera<LayerDraw | TransitionDraw>([transition, base], zoom) as [TransitionDraw, LayerDraw];
    expect(t.from?.camera).toBe(zoom);
    expect(t.to?.camera).toBe(zoom);
    expect(l.camera).toBe(zoom);
    expect(base.camera).toBeUndefined();
    expect(transition.from?.camera).toBeUndefined();
  });
});

for (const gpu of [true, false]) {
  describe(`a zoom drawn ${gpu ? 'on the GPU' : 'by the 2D fallback'}`, () => {
    let painter: Painter | null = null;
    afterEach(() => {
      painter?.dispose();
      painter = null;
    });

    it('fills the frame with the area it is pointed at', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      const source = quadrants();
      painter.paintLayers([layer(source, { camera: view(2, 0.25, 0.25) })]);
      let frame = pixels(painter);
      for (const [x, y] of [
        [5, 5],
        [50, 50],
        [94, 94],
        [94, 5],
        [5, 94],
      ] as const) {
        near(pixel(frame, x, y), RED);
      }

      painter.paintLayers([layer(source, { camera: view(2, 0.75, 0.25) })]);
      frame = pixels(painter);
      near(pixel(frame, 5, 5), GREEN);
      near(pixel(frame, 94, 94), GREEN);

      // Centred at 2x the four quadrants still meet in the middle, each twice its size: the frame
      // shows the middle half of the source, so a probe at a quarter is still well inside red.
      painter.paintLayers([layer(source, { camera: view(2, 0.5, 0.5) })]);
      frame = pixels(painter);
      near(pixel(frame, 25, 25), RED);
      near(pixel(frame, 75, 25), GREEN);
      near(pixel(frame, 25, 75), BLUE);
      near(pixel(frame, 75, 75), WHITE);
      // Just off the centre reads the source twice as close to it: (40, 40) shows (45, 45).
      near(pixel(frame, 40, 40), RED);
      near(pixel(frame, 60, 60), WHITE);
    });

    it('takes the old path exactly when there is no camera', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      const source = quadrants();
      painter.paintLayers([layer(source, { rotationDeg: 17, framing: { fit: 'cover', rect: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } } })]);
      const plain = pixels(painter);
      painter.paintLayers([layer(source, { rotationDeg: 17, framing: { fit: 'cover', rect: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } }, camera: view(1, 0.5, 0.5) })]);
      const identity = pixels(painter);
      painter.paintLayers([layer(source, { rotationDeg: 17, framing: { fit: 'cover', rect: { x: 0.1, y: 0.2, w: 0.6, h: 0.5 } }, camera: null })]);
      const none = pixels(painter);
      expect(identity).toEqual(plain);
      expect(none).toEqual(plain);
    });

    it('does not leave a zoom behind for the next layer drawn without one', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      const source = quadrants();
      painter.paintLayers([layer(source)]);
      const plain = pixels(painter);
      painter.paintLayers([layer(source, { camera: view(3, 0.3, 0.3) })]);
      painter.paintLayers([layer(source)]);
      expect(pixels(painter)).toEqual(plain);
    });

    it('reads the SOURCE through the camera, so detail finer than the output survives', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      // 400 source columns into 100 output ones is four to a pixel, grey. At 4x the visible area is
      // 100 source columns, one per output pixel, and they must still alternate.
      painter.paintLayers([layer(stripes(), { camera: view(4, 0.5, 0.5) })]);
      const frame = pixels(painter);
      let sharp = 0;
      for (let x = 10; x < 90; x++) {
        if (Math.abs(pixel(frame, x, 50)[0] - pixel(frame, x + 1, 50)[0]) > 200) sharp++;
      }
      // Every adjacent pair on the GPU; the 2D canvas is allowed its own resampler, but not grey.
      expect(sharp).toBeGreaterThan(gpu ? 78 : 60);
    });

    it('zooms an extra layer about the same point, and cuts a base rectangle in its zoomed place', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      // A green layer on the middle half of the frame fills all of it at 2x about the centre.
      const extra = layer(solid('#0f0'), { dest: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
      painter.paintLayers([extra]);
      near(pixel(pixels(painter), 10, 10), [0, 0, 0]);
      painter.paintLayers([{ ...extra, camera: view(2, 0.5, 0.5) }]);
      let frame = pixels(painter);
      near(pixel(frame, 3, 3), GREEN);
      near(pixel(frame, 96, 96), GREEN);

      // A base clip cut to a rectangle 0.4..0.6 across: at 2x about the centre it spans 0.3..0.7.
      const boxed = layer(solid('#fff'), { framing: { fit: 'cover', rect: { x: 0.4, y: 0.4, w: 0.2, h: 0.2 } } });
      painter.paintLayers([{ ...boxed, camera: view(2, 0.5, 0.5) }]);
      frame = pixels(painter);
      near(pixel(frame, 33, 50), WHITE);
      near(pixel(frame, 66, 50), WHITE);
      near(pixel(frame, 25, 50), [0, 0, 0]);
      near(pixel(frame, 75, 50), [0, 0, 0]);
    });

    it('leaves an overlay where it was put', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      painter.paintLayers([layer(quadrants(), { camera: view(2, 0.25, 0.25) })]);
      painter.paintOverlay({ bitmap: solid('#ff0', 10), cx: 0.8, cy: 0.8, wPx: 10, hPx: 10, rotationDeg: 0, opacity: 1 });
      const frame = pixels(painter);
      // Its own size at its own place: yellow from 75 to 85, and the zoomed red just outside it.
      near(pixel(frame, 80, 80), [255, 255, 0]);
      near(pixel(frame, 76, 76), [255, 255, 0]);
      near(pixel(frame, 72, 80), RED);
      near(pixel(frame, 88, 80), RED);
    });

    it('acts inside each side of a transition, and the transition still moves on the screen', () => {
      painter = painterFor(gpu);
      expect(painter.usesGpu).toBe(gpu);
      const zoom = view(2, 0.25, 0.25);
      const from = layer(quadrants());
      const to = layer(solid('#00f'), { framing: { fit: 'cover' } });

      // A dissolve halfway: the outgoing side is its zoomed frame - all red - so every pixel is half
      // red and half blue. With the camera over the mix instead, or not at all, the bottom right
      // would be half white.
      const look: TransitionLook = { alpha: 0.5, reveal: 1, from: { ...NEUTRAL_SIDE }, to: { ...NEUTRAL_SIDE } };
      painter.paintLayers(throughCamera<LayerDraw | TransitionDraw>([{ kind: 'transition', from, to, look, transition: {} }], zoom));
      let frame = pixels(painter);
      near(pixel(frame, 10, 10), [128, 0, 128], 8);
      near(pixel(frame, 85, 85), [128, 0, 128], 8);

      // A slide left halfway: the incoming side covers the right half OF THE SCREEN, as it does with
      // no zoom, and the outgoing zoomed red, darkened a little, is on the left.
      const compiled = compileTransition('slide-left')!;
      const slide: TransitionDraw = { kind: 'transition', from, to, look: lookAt(compiled.curves, 0.5), transition: compiled };
      painter.paintLayers(throughCamera<LayerDraw | TransitionDraw>([slide], zoom));
      frame = pixels(painter);
      expect(pixel(frame, 80, 50)[2]).toBeGreaterThan(240);
      const left = pixel(frame, 15, 50);
      expect(left[0]).toBeGreaterThan(150);
      expect(left[1]).toBeLessThan(20);
      expect(left[2]).toBeLessThan(20);
    });
  });
}

describe('the camera at a moment', () => {
  it('is what the painter is handed each frame, null outside every zoom', () => {
    const camera = { atMs: [0, 1000, 2000, 3000], scale: [1, 2, 2, 1], cx: [0.5, 0.25, 0.25, 0.5], cy: [0.5, 0.25, 0.25, 0.5] };
    expect(cameraAt(camera, 0)).toBeNull();
    expect(cameraAt(camera, 1500)).toEqual({ scale: 2, cx: 0.25, cy: 0.25 });
    expect(cameraAt(camera, 500)?.scale).toBeCloseTo(1.5);
    expect(cameraAt(camera, 4000)).toBeNull();
  });
});
