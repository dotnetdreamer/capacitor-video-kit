import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { Painter, WHOLE_FRAME } from '../video-composer/web/painter';
import { decodePicture, isStillPicture, releasePicture } from './picture';

/*
 * A picture decoded on WebKit stays on the canvas it was drawn on, kept in memory, because WebKit
 * hands WebGL a bitmap - or a canvas the GPU draws - by reading it back out of the GPU process
 * first: 50-62 ms for a 1080x1920 photo against 9-12 ms from memory (iOS 26.5 simulator,
 * 2026-10-07). The canvas is never drawn on again, so the painter uploads it once, as it does a
 * bitmap, and lets the texture go when the picture is let go of.
 *
 * Run in Chromium told it is WebKit: the engine is asked once, by its vendor, before anything is
 * decoded. Chromium itself keeps making bitmaps, which `clip-media.cmp.test.ts` covers.
 */

const made: string[] = [];

async function pictureUrl(width: number, height: number, colour = '#f00'): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  const url = URL.createObjectURL(blob!);
  made.push(url);
  return url;
}

let vendor: PropertyDescriptor | undefined;

beforeAll(() => {
  vendor = Object.getOwnPropertyDescriptor(Navigator.prototype, 'vendor');
  Object.defineProperty(Navigator.prototype, 'vendor', { configurable: true, get: () => 'Apple Computer, Inc.' });
});

afterAll(() => {
  if (vendor) Object.defineProperty(Navigator.prototype, 'vendor', vendor);
  for (const url of made.splice(0)) URL.revokeObjectURL(url);
});

describe('a picture decoded on WebKit', () => {
  it('stays on its canvas, upright and no bigger than asked for, as a still the painter knows', async () => {
    const picture = await decodePicture(await pictureUrl(3000, 2000), 2048);
    expect(picture.bitmap).toBeInstanceOf(HTMLCanvasElement);
    expect(isStillPicture(picture.bitmap)).toBe(true);
    expect([picture.width, picture.height]).toEqual([2048, 1365]);
    expect([picture.bitmap.width, picture.bitmap.height]).toEqual([2048, 1365]);

    releasePicture(picture);
    expect([picture.bitmap.width, picture.bitmap.height]).toEqual([0, 0]);
    expect(isStillPicture(document.createElement('canvas'))).toBe(false);
  });

  it('is uploaded once however often it is drawn, and its texture goes when it is let go of', async () => {
    const painter = new Painter({ width: 32, height: 32 });
    painter.setColour(null, { filter: 'none', tints: [] });
    const uploads = vi.spyOn(WebGL2RenderingContext.prototype, 'texImage2D');
    const drops = vi.spyOn(WebGL2RenderingContext.prototype, 'deleteTexture');
    try {
      const red = await decodePicture(await pictureUrl(32, 32, '#f00'), 2048);
      const draw = (source: HTMLCanvasElement) => painter.paintLayers([{ source, sourceWidth: 32, sourceHeight: 32, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1 }]);
      draw(red.bitmap as HTMLCanvasElement);
      draw(red.bitmap as HTMLCanvasElement);
      draw(red.bitmap as HTMLCanvasElement);
      const pictureUploads = () => uploads.mock.calls.filter(call => call[call.length - 1] instanceof HTMLCanvasElement).length;
      expect(pictureUploads()).toBe(1);

      // The frame is the picture: a still is drawn, not skipped.
      const probe = document.createElement('canvas');
      probe.width = 32;
      probe.height = 32;
      const ctx = probe.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(painter.frame, 0, 0);
      const [r, g, b] = ctx.getImageData(16, 16, 1, 1).data;
      expect([r, g, b]).toEqual([255, 0, 0]);

      // Let go of, and the next picture to arrive finds its texture and drops it.
      const dropsBefore = drops.mock.calls.length;
      releasePicture(red);
      const blue = await decodePicture(await pictureUrl(32, 32, '#00f'), 2048);
      draw(blue.bitmap as HTMLCanvasElement);
      expect(drops.mock.calls.length).toBe(dropsBefore + 1);
      expect(pictureUploads()).toBe(2);
    } finally {
      uploads.mockRestore();
      drops.mockRestore();
      painter.dispose();
    }
  });
});
