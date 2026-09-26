import { afterEach, describe, expect, it, vi } from 'vitest';

import { NEUTRAL_SIDE, type TransitionLook } from '../../editor/transitions';

import { FlowEstimator } from './optical-flow-gl';
import { Painter, WHOLE_FRAME, type LayerDraw, type LayerSource, type PainterOptions } from './painter';

/**
 * A slowed clip's missing frame, drawn by the real painter from two frames with real MOTION between
 * them, on the GPU - where it follows the motion (`optical-flow.ts`, `frame-interpolation.ts`) - and on
 * the 2D fallback, which keeps phase 1's cross-fade.
 *
 * What is pinned:
 *
 *  - a textured square that moves `d` between A and B is drawn ONCE, `d/2` along, halfway - where the
 *    cross-fade draws it twice at half strength - and the background it leaves is background;
 *  - where nothing moves, and across a cut the flow cannot explain, the picture is the cross-fade;
 *  - the flow is a property of the PAIR: worked out once however many frames are drawn from it, and
 *    worked out again for the next pair;
 *  - only a pair of held pictures (bitmaps) has a flow, a transition's outgoing side has one like any
 *    layer, and a painter told to blend draws the cross-fade;
 *  - the 2D fallback draws the cross-fade, as it always has.
 *
 * `painter-slow-motion.cmp.test.ts` still holds everything phase 1 promised - the one-frame path to the
 * bit, the placement, the grade and the opacity - with the flow on: its frames are flat or still, where
 * the flow's answer is the cross-fade.
 */

const W = 128;
const H = 128;
const SQUARE = 40;
const TOP = 44;
/** Where the square is in A, and how far it moves by B. */
const LEFT = 30;
const MOVE = 16;

/** A little generator so every run draws the same texture. */
function random(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Cells of random colour between `low` and `high`: a texture with an edge everywhere, which is what a
 * flow can follow. The square is lighter than the background, as a subject usually is: at the pyramid's
 * coarse levels, where the cells average away, that is what is left to see it move by.
 */
function texture(seed: number, width: number, height: number, cell: number, low = 0, high = 255): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  const next = random(seed);
  for (let y = 0; y < height; y += cell) {
    for (let x = 0; x < width; x += cell) {
      const channel = () => Math.floor(low + next() * (high - low + 1));
      ctx.fillStyle = `rgb(${channel()}, ${channel()}, ${channel()})`;
      ctx.fillRect(x, y, cell, cell);
    }
  }
  return canvas;
}

const BACKGROUND = texture(1, W, H, 4, 0, 130);
const PATCH = texture(2, SQUARE, SQUARE, 5, 150, 255);

/** The picture with the square `left` pixels in. */
function scene(left: number, background: HTMLCanvasElement = BACKGROUND): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(background, 0, 0);
  ctx.drawImage(PATCH, left, TOP);
  return canvas;
}

function layer(source: LayerSource, over: Partial<LayerDraw> = {}): LayerDraw {
  return { source, sourceWidth: W, sourceHeight: H, framing: { fit: 'contain' }, dest: WHOLE_FRAME, opacity: 1, ...over };
}

function pixels(painter: Painter): Uint8ClampedArray {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(painter.frame, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
}

function painterFor(gpu: boolean, options: PainterOptions = {}): Painter {
  let painter: Painter;
  if (gpu) {
    painter = new Painter({ width: W, height: H }, undefined, options);
  } else {
    const real = HTMLCanvasElement.prototype.getContext;
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string, opts?: unknown) {
      return type === 'webgl2' ? null : (real as (this: HTMLCanvasElement, type: string, opts?: unknown) => RenderingContext | null).call(this, type, opts);
    } as typeof real);
    try {
      painter = new Painter({ width: W, height: H }, undefined, options);
    } finally {
      spy.mockRestore();
    }
  }
  painter.setColour(null, { filter: 'none', tints: [] });
  return painter;
}

function paint(gpu: boolean, draws: LayerDraw[], options: PainterOptions = {}): Uint8ClampedArray {
  const painter = painterFor(gpu, options);
  try {
    painter.paintLayers(draws);
    return pixels(painter);
  } finally {
    painter.dispose();
  }
}

/** The mean difference over every channel of every pixel. */
function meanDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += 4) {
    for (let c = 0; c < 3; c++) sum += Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
    count += 3;
  }
  return sum / count;
}

/** The same over a rectangle only. */
function regionDifference(a: Uint8ClampedArray, b: Uint8ClampedArray, x0: number, y0: number, w: number, h: number): number {
  let sum = 0;
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) sum += Math.abs((a[i + c] ?? 0) - (b[i + c] ?? 0));
    }
  }
  return sum / (w * h * 3);
}

function largestDifference(a: Uint8ClampedArray, b: Uint8ClampedArray): number {
  let most = 0;
  for (let i = 0; i < a.length; i++) most = Math.max(most, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return most;
}

const bitmaps: ImageBitmap[] = [];
async function held(canvas: HTMLCanvasElement): Promise<ImageBitmap> {
  const bitmap = await createImageBitmap(canvas);
  bitmaps.push(bitmap);
  return bitmap;
}

afterEach(() => {
  for (const bitmap of bitmaps.splice(0)) bitmap.close();
  vi.restoreAllMocks();
});

describe('a slowed frame that follows the motion, on the GPU', () => {
  it('draws the moving square once, halfway, where the cross-fade draws it twice at half strength', async () => {
    const a = await held(scene(LEFT));
    const b = await held(scene(LEFT + MOVE));
    const truth = paint(true, [layer(scene(LEFT + MOVE / 2))]);
    const flow = paint(true, [layer(a, { tween: { source: b, weight: 0.5 } })]);
    const blend = paint(true, [layer(a, { tween: { source: b, weight: 0.5 } })], { interpolation: 'blend' });

    const flowError = meanDifference(flow, truth);
    const blendError = meanDifference(blend, truth);
    // Not zero: the square's edges are where the flow, worked at a working size and spread over the
    // frame by bilinear filtering, is softest. Well under half the cross-fade's error everywhere else.
    expect(flowError, `flow ${flowError.toFixed(2)} against the cross-fade's ${blendError.toFixed(2)}`).toBeLessThan(blendError * 0.4);
    expect(flowError).toBeLessThan(4);

    // The strip the square has LEFT by halfway - its first MOVE / 2 columns in A - is background again.
    // The cross-fade still has half the square there: the ghost.
    const strip = [LEFT + 1, TOP + 2, MOVE / 2 - 2, SQUARE - 4] as const;
    expect(regionDifference(flow, truth, ...strip)).toBeLessThan(8);
    expect(regionDifference(blend, truth, ...strip)).toBeGreaterThan(25);
    // And the strip it has not reached yet - B's last MOVE / 2 columns - is background too.
    const ahead = [LEFT + SQUARE + MOVE / 2 + 1, TOP + 2, MOVE / 2 - 2, SQUARE - 4] as const;
    expect(regionDifference(flow, truth, ...ahead)).toBeLessThan(8);
    expect(regionDifference(blend, truth, ...ahead)).toBeGreaterThan(25);
  });

  it('follows it a quarter and three quarters of the way too', async () => {
    const a = await held(scene(LEFT));
    const b = await held(scene(LEFT + MOVE));
    for (const weight of [0.25, 0.75]) {
      const truth = paint(true, [layer(scene(LEFT + MOVE * weight))]);
      const flow = paint(true, [layer(a, { tween: { source: b, weight } })]);
      const blend = paint(true, [layer(a, { tween: { source: b, weight } })], { interpolation: 'blend' });
      expect(meanDifference(flow, truth), `at ${weight}`).toBeLessThan(meanDifference(blend, truth) / 2);
    }
  });

  it('is the cross-fade where nothing moves', async () => {
    const still = await held(scene(LEFT));
    const again = await held(scene(LEFT));
    const flow = paint(true, [layer(still, { tween: { source: again, weight: 0.5 } })]);
    const blend = paint(true, [layer(still, { tween: { source: again, weight: 0.5 } })], { interpolation: 'blend' });
    expect(largestDifference(flow, blend)).toBeLessThanOrEqual(1);
  });

  it('is the cross-fade across a cut, which no motion explains', async () => {
    const before = await held(scene(LEFT));
    const after = await held(scene(LEFT + MOVE, texture(7, W, H, 6)));
    const flow = paint(true, [layer(before, { tween: { source: after, weight: 0.5 } })]);
    const blend = paint(true, [layer(before, { tween: { source: after, weight: 0.5 } })], { interpolation: 'blend' });
    expect(largestDifference(flow, blend)).toBeLessThanOrEqual(1);
  });

  it('works a pair out once however many frames are drawn from it, and the next pair again', async () => {
    const estimate = vi.spyOn(FlowEstimator.prototype, 'estimate');
    const frames = await Promise.all([0, 1, 2].map(k => held(scene(LEFT + k * MOVE))));
    const painter = painterFor(true);
    try {
      for (const weight of [0.25, 0.5, 0.75]) painter.paintLayers([layer(frames[0]!, { tween: { source: frames[1]!, weight } })]);
      expect(estimate).toHaveBeenCalledTimes(1);
      // The reader lets A go as it moves on, and the next pair is worked out afresh.
      painter.forget(frames[0]!);
      painter.paintLayers([layer(frames[1]!, { tween: { source: frames[2]!, weight: 0.5 } })]);
      expect(estimate).toHaveBeenCalledTimes(2);
    } finally {
      painter.dispose();
    }
  });

  it('keeps no flow for a pair that is not two held pictures: the cross-fade, as a playing element’s is', () => {
    const estimate = vi.spyOn(FlowEstimator.prototype, 'estimate');
    const flow = paint(true, [layer(scene(LEFT), { tween: { source: scene(LEFT + MOVE), weight: 0.5 } })]);
    const blend = paint(true, [layer(scene(LEFT), { tween: { source: scene(LEFT + MOVE), weight: 0.5 } })], { interpolation: 'blend' });
    expect(estimate).not.toHaveBeenCalled();
    expect(largestDifference(flow, blend)).toBe(0);
  });

  it('follows the motion on a transition’s outgoing side as on any layer', async () => {
    const a = await held(scene(LEFT));
    const b = await held(scene(LEFT + MOVE));
    const alone = paint(true, [layer(a, { tween: { source: b, weight: 0.5 } })]);
    // The incoming side at no alpha is not drawn, so the frame is the outgoing side alone.
    const look: TransitionLook = { alpha: 0, reveal: 1, from: { ...NEUTRAL_SIDE }, to: { ...NEUTRAL_SIDE } };
    const painter = painterFor(true);
    try {
      painter.paintLayers([{ kind: 'transition', from: layer(a, { tween: { source: b, weight: 0.5 } }), to: layer(scene(0)), look, transition: {} }]);
      expect(largestDifference(pixels(painter), alone)).toBeLessThanOrEqual(1);
    } finally {
      painter.dispose();
    }
  });
});

describe('a slowed frame on the 2D fallback', () => {
  it('is the cross-fade, two half squares, whatever the painter was asked for', async () => {
    const a = await held(scene(LEFT));
    const b = await held(scene(LEFT + MOVE));
    const asked = paint(false, [layer(a, { tween: { source: b, weight: 0.5 } })]);
    const blend = paint(false, [layer(a, { tween: { source: b, weight: 0.5 } })], { interpolation: 'blend' });
    expect(largestDifference(asked, blend)).toBe(0);
    const truth = paint(false, [layer(scene(LEFT + MOVE / 2))]);
    expect(regionDifference(asked, truth, LEFT + 1, TOP + 2, MOVE / 2 - 2, SQUARE - 4)).toBeGreaterThan(25);
  });
});
