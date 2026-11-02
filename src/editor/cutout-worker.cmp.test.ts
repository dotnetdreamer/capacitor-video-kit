import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CutoutPhotoJob } from './cutout-photo';
import { cutoutPhotoInWorker, resetCutoutWorker } from './cutout-worker';
import type { RasterisedOverlay } from './raster-context';

/*
 * A cut-out photo drawn in a real worker, in a real browser. What matters is that the worker is not a
 * second engine: it runs the same function as the main thread and its bitmap holds the main thread's
 * pixels, and where a worker cannot run, or fails, the photo is still drawn - here, as it was before
 * there was a worker. Every worker the page starts is counted, so a pass is the worker's own.
 */

/** A 120 x 80 photo: a red disc on a blue ground, decoded and ready to draw. */
async function photo(): Promise<HTMLImageElement> {
  const canvas = document.createElement('canvas');
  canvas.width = 120;
  canvas.height = 80;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#1030c0';
  g.fillRect(0, 0, 120, 80);
  g.fillStyle = '#e02010';
  g.beginPath();
  g.arc(60, 40, 22, 0, Math.PI * 2);
  g.fill();
  const image = new Image();
  image.src = canvas.toDataURL('image/png');
  await image.decode();
  return image;
}

/** The disc as a matte twice as fine as the photo, and a look for the rest. */
function jobFor(look: Partial<CutoutPhotoJob> = {}): CutoutPhotoJob {
  const cells = new Uint8Array(240 * 160);
  for (let y = 0; y < 160; y++) for (let x = 0; x < 240; x++) if (Math.hypot((x + 0.5) / 2 - 60, (y + 0.5) / 2 - 40) < 22) cells[y * 240 + x] = 255;
  return { wPx: 120, hPx: 80, k: 1, cells, matteWidth: 240, matteHeight: 160, soft: 0.2, shift: 0, outline: null, shadow: null, ...look };
}

const WITH_EVERYTHING: Partial<CutoutPhotoJob> = { outline: { color: [1, 1, 1], width: 0.012 }, shadow: { blur: 0.035, drop: 0.018, color: 'rgba(0, 0, 0, 0.42)' } };

/** A bitmap's size and its decoded RGBA, which is what two encoders of the same pixels agree on. */
async function pixelsOf(raster: RasterisedOverlay | null): Promise<{ wPx: number; hPx: number; rgba: number[] }> {
  expect(raster).not.toBeNull();
  const image = new Image();
  image.src = raster!.png;
  await image.decode();
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(image, 0, 0);
  return { wPx: raster!.wPx, hPx: raster!.hPx, rgba: [...g.getImageData(0, 0, canvas.width, canvas.height).data] };
}

/** The photo drawn on the main thread: the page with no `Worker` to start. */
async function drawnHere(image: HTMLImageElement, job: CutoutPhotoJob): Promise<RasterisedOverlay | null> {
  vi.stubGlobal('Worker', undefined);
  try {
    return await cutoutPhotoInWorker(image, job);
  } finally {
    vi.unstubAllGlobals();
    resetCutoutWorker();
  }
}

/** Counts the workers the page starts, each working as it would. */
function countWorkers(): { started: number } {
  const counts = { started: 0 };
  const Real = globalThis.Worker;
  vi.stubGlobal(
    'Worker',
    class extends Real {
      constructor(url: string | URL, options?: WorkerOptions) {
        super(url, options);
        counts.started++;
      }
    },
  );
  return counts;
}

afterEach(() => {
  resetCutoutWorker();
  vi.unstubAllGlobals();
});

describe('a cut-out photo drawn in a worker', () => {
  it('holds the pixels the main thread draws', async () => {
    const image = await photo();
    const here = await pixelsOf(await drawnHere(image, jobFor()));
    const counts = countWorkers();

    const there = await pixelsOf(await cutoutPhotoInWorker(image, jobFor()));

    expect(counts.started).toBe(1);
    expect(there).toEqual(here);
  });

  it('holds them with a line round the subject and a shadow under it', async () => {
    const image = await photo();
    const here = await pixelsOf(await drawnHere(image, jobFor(WITH_EVERYTHING)));
    countWorkers();

    const there = await pixelsOf(await cutoutPhotoInWorker(image, jobFor(WITH_EVERYTHING)));

    expect(there).toEqual(here);
  });

  it('draws photos asked for together in one worker, each its own', async () => {
    const image = await photo();
    const looks = [jobFor(), jobFor(WITH_EVERYTHING), jobFor({ soft: 0.8, shift: -0.5 })];
    const here = [];
    for (const job of looks) here.push(await pixelsOf(await drawnHere(image, job)));
    const counts = countWorkers();

    const there = await Promise.all(looks.map(job => cutoutPhotoInWorker(image, job)));

    expect(counts.started).toBe(1);
    for (const [at, raster] of there.entries()) expect(await pixelsOf(raster)).toEqual(here[at]);
  });

  it('draws the photo here where the page refuses the worker it made', async () => {
    const image = await photo();
    const here = await pixelsOf(await drawnHere(image, jobFor()));
    vi.stubGlobal(
      'Worker',
      class {
        constructor() {
          throw new DOMException('refused by the page', 'SecurityError');
        }
      },
    );

    expect(await pixelsOf(await cutoutPhotoInWorker(image, jobFor()))).toEqual(here);
  });

  it('draws every photo waiting on a worker that fails here instead, and every one after it', async () => {
    const image = await photo();
    const here = await pixelsOf(await drawnHere(image, jobFor()));
    const made: unknown[] = [];
    vi.stubGlobal(
      'Worker',
      class {
        onerror: ((event: Event) => void) | null = null;
        onmessage = null;
        onmessageerror = null;
        constructor() {
          made.push(this);
        }
        postMessage(): void {
          setTimeout(() => this.onerror?.(new Event('error', { cancelable: true })));
        }
        terminate(): void {}
      },
    );

    const waiting = await Promise.all([cutoutPhotoInWorker(image, jobFor()), cutoutPhotoInWorker(image, jobFor())]);
    const after = await cutoutPhotoInWorker(image, jobFor());

    for (const raster of [...waiting, after]) expect(await pixelsOf(raster)).toEqual(here);
    expect(made).toHaveLength(1);
  });
});
