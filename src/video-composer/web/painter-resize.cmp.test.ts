import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';

import { compileTransition, lookAt } from '../../editor/transitions';
import type { Frame } from './geometry';
import { Painter, WHOLE_FRAME, type LayerDraw, type TransitionDraw } from './painter';

/*
 * A painter resized in place, which is what the editor's preview does every time a sheet or the
 * keyboard changes the size of the stage. It used to build a new painter for every size - a new GL
 * context, the layer program compiled again and the transitions' two programs linked again on the
 * next transition - which is a visible hitch on the paused frame the customer is looking at.
 *
 * What is pinned is that nothing about the picture changes: a painter resized to a size draws, pixel
 * for pixel, what a new painter built at that size draws, transitions and their blurred frame
 * targets included. And that a painter with no live context to keep says so, so the caller builds a
 * new one - which is what brings a lost GPU back.
 */

const A: Frame = { width: 90, height: 160 };
/** Smaller, as a sheet opening makes the stage - and not a halving of A, so no target is shared by accident. */
const B: Frame = { width: 72, height: 124 };

const made: Painter[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const painter of made.splice(0)) painter.dispose();
});

function painterAt(frame: Frame): Painter {
  const painter = new Painter(frame);
  painter.setColour(null, { filter: 'none', tints: [] });
  made.push(painter);
  return painter;
}

function paintSource(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const image = ctx.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b] = colour(x, y);
      const at = (y * width + x) * 4;
      image.data[at] = r;
      image.data[at + 1] = g;
      image.data[at + 2] = b;
      image.data[at + 3] = 255;
    }
  }
  ctx.putImageData(image, 0, 0);
  return canvas;
}

/** A square with an edge in every direction, so a picture put anywhere else by a stale size shows. */
const outgoing = paintSource(120, 120, (x, y) => [x < 40 ? 255 : 150, x < 60 ? 0 : 255, Math.round((y / 119) * 220)]);
const incoming = paintSource(60, 100, (x, y) => [Math.round((y / 99) * 180), Math.round((x / 59) * 255), x < 40 ? 255 : 90]);

function layerOf(source: HTMLCanvasElement, fit: 'contain' | 'cover'): LayerDraw {
  return { source, sourceWidth: source.width, sourceHeight: source.height, framing: { fit }, dest: WHOLE_FRAME, opacity: 1 };
}

function drawOf(kind: string, p: number): TransitionDraw {
  const compiled = compileTransition(kind);
  if (!compiled) throw new Error(`no transition ${kind}`);
  return { kind: 'transition', from: layerOf(outgoing, 'contain'), to: layerOf(incoming, 'cover'), look: lookAt(compiled.curves, p), transition: compiled };
}

/**
 * What one painter draws for each frame of a short sequence: a plain layer, a dissolve, and a blur,
 * the last being the one that halves its frame into targets of several sizes.
 */
const SEQUENCE: ReadonlyArray<ReadonlyArray<LayerDraw | TransitionDraw>> = [
  [layerOf(incoming, 'cover')],
  [drawOf('dissolve', 0.5)],
  [drawOf('blur', 0.35)],
];

function pixelsOf(painter: Painter): Uint8ClampedArray {
  const frame = painter.frame;
  const read = document.createElement('canvas');
  read.width = frame.width;
  read.height = frame.height;
  const ctx = read.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(frame, 0, 0);
  return ctx.getImageData(0, 0, frame.width, frame.height).data;
}

function paintAll(painter: Painter): Uint8ClampedArray[] {
  return SEQUENCE.map(layers => {
    painter.paintLayers(layers);
    return pixelsOf(painter);
  });
}

/** Skips a case that is about the GPU path in a browser that gives the painter none. */
function needsGpu(ctx: TestContext, painter: Painter): void {
  if (!painter.usesGpu) ctx.skip('this browser gives the painter no WebGL2');
}

describe('a painter resized in place', () => {
  it('draws at the new size exactly what a new painter of that size draws', ctx => {
    const contexts = vi.spyOn(HTMLCanvasElement.prototype, 'getContext');
    const resized = painterAt(A);
    needsGpu(ctx, resized);
    // At A first, so the transitions' programs and frame targets exist at a size that is then wrong.
    paintAll(resized);

    expect(resized.resize(B)).toBe(true);
    expect(resized.frame.width).toBe(B.width);
    expect(resized.frame.height).toBe(B.height);
    const atB = paintAll(resized);

    // And back, which is the sheet closing again.
    expect(resized.resize(A)).toBe(true);
    const backAtA = paintAll(resized);
    expect(resized.usesGpu).toBe(true);

    // One GL context across all three sizes: the whole point of resizing rather than rebuilding.
    const glContexts = contexts.mock.calls.filter(([kind]) => kind === 'webgl2').length;
    expect(glContexts).toBe(1);

    const freshB = paintAll(painterAt(B));
    const freshA = paintAll(painterAt(A));
    atB.forEach((frame, i) => expect(frame, `frame ${i} at B`).toEqual(freshB[i]));
    backAtA.forEach((frame, i) => expect(frame, `frame ${i} back at A`).toEqual(freshA[i]));
  });

  it('says it cannot, and changes nothing, when its context has been lost', ctx => {
    const painter = painterAt(A);
    needsGpu(ctx, painter);
    const gl = (painter as unknown as { gl: WebGL2RenderingContext | null }).gl;
    const lose = gl?.getExtension('WEBGL_lose_context');
    if (!lose) ctx.skip('this browser cannot lose a context on request');
    lose!.loseContext();

    // Lost while nothing was painting, so the painter has not noticed yet - and it must not carry a
    // dead context to the new size, where the next paint would drop it to the 2D path for good.
    expect(painter.resize(B)).toBe(false);
    expect(painter.frame.width).toBe(A.width);

    // And once a paint has dropped it to the 2D path, the same answer.
    painter.paintLayers([layerOf(incoming, 'cover')]);
    expect(painter.usesGpu).toBe(false);
    expect(painter.resize(B)).toBe(false);
  });
});
