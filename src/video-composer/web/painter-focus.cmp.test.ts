import { afterEach, describe, expect, it, vi } from 'vitest';

import { encodeSubjectTrack, parseSubjectTrack } from '../../editor/subject-track';

import { FocusFrames } from './focus-frames';
import type { FocusDraw } from './focus-gl';
import { Painter, WHOLE_FRAME, type LayerDraw } from './painter';

/**
 * A clip's focus drawn by the real painter in a real browser, on the GPU and on the 2D fallback, and
 * read back in pixels.
 *
 * The fixture is a frame whose LEFT half is the subject and whose right half is the world, both in
 * fine red and blue stripes, so each step of the contract shows as a colour: kept sharp, the stripes
 * stay red and blue; blurred, they average to purple; greyed, the purple loses its colour; darkened,
 * it goes towards black. What is pinned is `ComposeFocus`:
 *
 *  - the subject in focus is the frame itself, and the world is blurred, greyed and darkened;
 *  - the world's blur does not take in the subject's colour (the weighting), so a green subject
 *    leaves no green in the blur beside it;
 *  - `invert` turns it round;
 *  - focus acts on the SOURCE, before the crop: a layer cropped to the world shows only the world.
 */

const W = 80;
const H = 40;

/** Two-pixel red and blue columns across the whole frame: sharp, red or blue; blurred, purple. */
function stripes(left = '#f00', width = W, height = H): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  for (let x = 0; x < width; x += 2) {
    ctx.fillStyle = x % 4 === 0 ? '#f00' : '#00f';
    ctx.fillRect(x, 0, 2, height);
  }
  if (left !== '#f00') {
    ctx.fillStyle = left;
    ctx.fillRect(0, 0, width / 2, height);
  }
  return canvas;
}

/** A focus whose grid is the left half in focus (255) and the right half not (0). */
function halves(over: Partial<FocusDraw> = {}): FocusDraw {
  const maskWidth = 8;
  const maskHeight = 4;
  const mask = new Uint8Array(maskWidth * maskHeight);
  for (let y = 0; y < maskHeight; y++) for (let x = 0; x < maskWidth / 2; x++) mask[y * maskWidth + x] = 255;
  return { mask, maskWidth, maskHeight, maskKey: `halves:${Math.random()}`, blur: 0.1, mono: 0, dim: 0, ...over };
}

function layer(source: HTMLCanvasElement, over: Partial<LayerDraw> = {}): LayerDraw {
  return { source, sourceWidth: source.width, sourceHeight: source.height, framing: { fit: 'contain' }, dest: WHOLE_FRAME, opacity: 1, ...over };
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

/** The mean colour of a box, so a stripe pattern reads as what the eye sees there. */
function mean(frame: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number): [number, number, number] {
  const sum = [0, 0, 0];
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      sum[0] += frame[i]!;
      sum[1] += frame[i + 1]!;
      sum[2] += frame[i + 2]!;
      n++;
    }
  }
  return [sum[0]! / n, sum[1]! / n, sum[2]! / n];
}

/** How far the pixels of a box are from their mean: stripes are far, a blur near. */
function spread(frame: Uint8ClampedArray, x0: number, y0: number, x1: number, y1: number): number {
  const m = mean(frame, x0, y0, x1, y1);
  let total = 0;
  let n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * W + x) * 4;
      total += Math.abs(frame[i]! - m[0]) + Math.abs(frame[i + 2]! - m[2]);
      n++;
    }
  }
  return total / n;
}

function painterFor(gpu: boolean): Painter {
  if (gpu) return new Painter({ width: W, height: H });
  const real = HTMLCanvasElement.prototype.getContext;
  const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string, options?: unknown) {
    return type === 'webgl2' ? null : (real as (this: HTMLCanvasElement, type: string, options?: unknown) => RenderingContext | null).call(this, type, options);
  } as typeof real);
  try {
    return new Painter({ width: W, height: H });
  } finally {
    spy.mockRestore();
  }
}

let painters: Painter[] = [];
afterEach(() => {
  for (const painter of painters) painter.dispose();
  painters = [];
});

function painted(gpu: boolean, draw: LayerDraw): Uint8ClampedArray {
  const painter = painterFor(gpu);
  painters.push(painter);
  expect(painter.usesGpu).toBe(gpu);
  painter.paintLayers([draw]);
  return pixels(painter);
}

for (const gpu of [true, false]) {
  describe(`focus (${gpu ? 'GPU' : '2D fallback'})`, () => {
    it('keeps the subject sharp and blurs the world', () => {
      const frame = painted(gpu, layer(stripes(), { focus: halves() }));
      // The subject's stripes are as they were; the world's have run together.
      expect(spread(frame, 4, 8, 28, 32)).toBeGreaterThan(150);
      expect(spread(frame, 52, 8, 76, 32)).toBeLessThan(40);
      const world = mean(frame, 52, 8, 76, 32);
      expect(world[0]).toBeGreaterThan(80);
      expect(world[2]).toBeGreaterThan(80);
    });

    it('greys and darkens the world and leaves the subject its colour', () => {
      const grey = painted(gpu, layer(stripes(), { focus: halves({ mono: 1 }) }));
      const world = mean(grey, 52, 8, 76, 32);
      expect(Math.abs(world[0] - world[2])).toBeLessThan(12);
      expect(Math.abs(world[0] - world[1])).toBeLessThan(12);
      const dark = painted(gpu, layer(stripes(), { focus: halves({ blur: 0, dim: 1 }) }));
      expect(Math.max(...mean(dark, 52, 8, 76, 32))).toBeLessThan(6);
      expect(spread(dark, 4, 8, 28, 32)).toBeGreaterThan(150);
    });

    it('turns round with the mask the other way', () => {
      const focus = halves();
      const inverted = new Uint8Array(focus.mask.length);
      focus.mask.forEach((value, i) => (inverted[i] = 255 - value));
      const frame = painted(gpu, layer(stripes(), { focus: { ...focus, mask: inverted, maskKey: 'inverted' } }));
      expect(spread(frame, 4, 8, 28, 32)).toBeLessThan(40);
      expect(spread(frame, 52, 8, 76, 32)).toBeGreaterThan(150);
    });

    it('is the old path for a focus that changes nothing', () => {
      const plain = painted(gpu, layer(stripes()));
      const none = painted(gpu, layer(stripes(), { focus: halves({ blur: 0, mono: 0, dim: 0 }) }));
      expect([...none]).toEqual([...plain]);
    });

    it('focuses the source before the crop', () => {
      // Cropped to the world: the whole frame is the blurred half.
      const frame = painted(gpu, layer(stripes(), { focus: halves(), framing: { fit: 'cover', crop: { x: 0.5, y: 0, w: 0.5, h: 1 } } }));
      expect(spread(frame, 4, 8, 76, 32)).toBeLessThan(40);
    });
  });
}

describe('focus weighting (GPU)', () => {
  it('leaves none of a green subject in the blur beside it', () => {
    const frame = painted(true, layer(stripes('#0f0'), { focus: halves({ blur: 0.2 }) }));
    // Just right of the subject's edge, where a plain blur would mix green in.
    const beside = mean(frame, 44, 8, 52, 32);
    expect(beside[1]).toBeLessThan(25);
    // And the subject is still green.
    expect(mean(frame, 4, 8, 32, 32)[1]).toBeGreaterThan(230);
  });
});

describe('FocusFrames', () => {
  it('reads a track and a focus into what the painter draws', () => {
    const left = new Uint8Array(8 * 4);
    for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) left[y * 8 + x] = 1;
    const track = parseSubjectTrack(
      encodeSubjectTrack({ width: 8, height: 4, times: [0, 1000], frames: [left, left], meta: { engine: 'mediapipe', kind: 'video', durationMs: 1000, fps: 1, subjects: [] } }),
    );
    const frames = new FocusFrames(track, { uri: 'x', atMs: [0, 1000], subjects: [{ id: 1, focus: [1, 0] }], blur: 0.05, mono: 0.5 });
    const start = frames.at(0);
    expect(start.mask[0]).toBe(255);
    expect(start.mask[7]).toBe(0);
    expect([start.blur, start.mono, start.dim]).toEqual([0.05, 0.5, 0]);
    const middle = frames.at(500);
    expect(middle.mask[0]).toBe(128);
    expect(middle.maskKey).not.toBe(start.maskKey);
    // The same instant again is the same grid by its key.
    expect(frames.at(500).maskKey).toBe(middle.maskKey);
  });
});
