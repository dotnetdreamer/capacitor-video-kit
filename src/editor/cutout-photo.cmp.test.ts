import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditOverlay } from './edit-manifest';
import { resetCutoutWorker } from './cutout-worker';
import { rasteriseOverlay } from './overlay-raster';
import type { RasterContext, RasterMatte } from './raster-context';

/*
 * A cut-out photo as the preview and the render both draw it, in a real browser: its matte finer than
 * its bitmap, as a photo's always is, brought down to the bitmap's pixels and cut out in a worker, then
 * trimmed to the subject. Only the subject is left, and the main thread never ran the cutout.
 */

/** A disc 50 across in the middle of a 200 x 100 photo. */
const DISC = (x: number, y: number): boolean => Math.hypot(x - 100, y - 50) < 25;

/** A block 100 x 50 in the middle of a 200 x 100 photo, its edges on whole pixels. */
const BLOCK = (x: number, y: number): boolean => x >= 50 && x < 150 && y >= 25 && y < 75;

/** A 200 x 100 photo, red wherever `inside` and blue elsewhere, as a data URL the rasteriser can load. */
function photoUrl(inside: (x: number, y: number) => boolean): string {
  const canvas = document.createElement('canvas');
  canvas.width = 200;
  canvas.height = 100;
  const g = canvas.getContext('2d')!;
  const pixels = g.createImageData(200, 100);
  for (let y = 0; y < 100; y++) {
    for (let x = 0; x < 200; x++) pixels.data.set(inside(x + 0.5, y + 0.5) ? [224, 32, 16, 255] : [16, 48, 192, 255], (y * 200 + x) * 4);
  }
  g.putImageData(pixels, 0, 0);
  return canvas.toDataURL('image/png');
}

/** The same shape as a matte of `scale` cells a pixel of the photo: twice as fine by default, as a photo's is finer than its layer. */
function matteOf(inside: (x: number, y: number) => boolean, scale = 2): RasterMatte {
  const width = 200 * scale;
  const height = 100 * scale;
  const cells = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) if (inside((x + 0.5) / scale, (y + 0.5) / scale)) cells[y * width + x] = 255;
  }
  return { width, height, meta: { coverage: 0.1 }, frame: () => cells };
}

/** A 400 x 400 frame, on which a photo at scale 1 is 200 pixels across. */
function contextWith(matte: RasterMatte, url: string): RasterContext {
  return {
    output: { width: 400, height: 400 },
    textStyle: () => ({ id: 'classic', label: 'Classic', family: 'sans-serif', fallback: '', weight: 400 }),
    stickerUrl: () => '',
    fileUrl: () => url,
    matte: async () => matte,
  };
}

const PHOTO = { id: 'ph', kind: 'image', uri: 'file:///p.png', fileName: 'p.png', aspect: 2, cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0, cutout: {} } as EditOverlay;

/** The alpha of the bitmap a raster's PNG holds, as a function of a point 0..1 across and down it. */
async function alphaOf(png: string): Promise<(u: number, v: number) => number> {
  const image = new Image();
  image.src = png;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(image, 0, 0);
  const data = g.getImageData(0, 0, canvas.width, canvas.height).data;
  return (u, v) => data[(Math.min(canvas.height - 1, Math.floor(v * canvas.height)) * canvas.width + Math.min(canvas.width - 1, Math.floor(u * canvas.width))) * 4 + 3]! / 255;
}

afterEach(() => {
  resetCutoutWorker();
  vi.unstubAllGlobals();
});

describe('a cut-out photo', () => {
  it('is cut out in a worker from a matte finer than its bitmap, and trimmed to the subject', async () => {
    let workers = 0;
    const Real = globalThis.Worker;
    vi.stubGlobal(
      'Worker',
      class extends Real {
        constructor(url: string | URL, options?: WorkerOptions) {
          super(url, options);
          workers++;
        }
      },
    );

    const raster = await rasteriseOverlay(PHOTO, contextWith(matteOf(DISC), photoUrl(DISC)));

    expect(workers).toBe(1);
    // The disc is 50 across in a photo 200 pixels across the frame: the trim leaves the disc and the
    // soft edge the refinement gives it, a few pixels at most, and the corners round it see-through.
    expect(raster.wPx).toBeGreaterThanOrEqual(50);
    expect(raster.wPx).toBeLessThanOrEqual(60);
    expect(raster.hPx).toBeGreaterThanOrEqual(50);
    expect(raster.hPx).toBeLessThanOrEqual(60);
    const alpha = await alphaOf(raster.png);
    expect(alpha(0.5, 0.5)).toBe(1);
    expect(alpha(0.05, 0.05)).toBe(0);
    expect(alpha(0.95, 0.95)).toBe(0);
  });

  /* Every two by two of the fine matte agrees, so brought down it IS the coarse one: a cell out of step would show. */
  it('comes out the same from a matte twice as fine as from that matte at the bitmap\'s own size', async () => {
    const url = photoUrl(BLOCK);
    const fine = await rasteriseOverlay(PHOTO, contextWith(matteOf(BLOCK, 2), url));
    const own = await rasteriseOverlay(PHOTO, contextWith(matteOf(BLOCK, 1), url));

    expect({ wPx: fine.wPx, hPx: fine.hPx }).toEqual({ wPx: own.wPx, hPx: own.hPx });
    expect(fine.png).toBe(own.png);
  });
});
