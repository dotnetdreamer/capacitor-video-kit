import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decodePicture, measurePicture, pictureThumbnail } from './picture';

/*
 * An `<img>` that loads (or fails) a turn after its `src` is set and counts its decodes. A probe only
 * asks for a picture's size, which an image has at `onload`; the full decode it used to wait for as
 * well was thrown away the moment the size was read. The drawing paths still wait for theirs.
 */
class FakeImage {
  static next: { width: number; height: number } | 'error' = { width: 3000, height: 4000 };
  static decodes = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  crossOrigin: string | null = null;
  naturalWidth = 0;
  naturalHeight = 0;

  set src(_url: string) {
    const outcome = FakeImage.next;
    queueMicrotask(() => {
      if (outcome === 'error') {
        this.onerror?.();
        return;
      }
      this.naturalWidth = outcome.width;
      this.naturalHeight = outcome.height;
      this.onload?.();
    });
  }

  decode(): Promise<void> {
    FakeImage.decodes++;
    return Promise.resolve();
  }

  removeAttribute(): void {}
}

describe('measurePicture', () => {
  beforeEach(() => {
    FakeImage.next = { width: 3000, height: 4000 };
    FakeImage.decodes = 0;
    vi.stubGlobal('Image', FakeImage);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads the size at load, without decoding the pixels', async () => {
    expect(await measurePicture('blob:photo')).toEqual({ width: 3000, height: 4000 });
    expect(FakeImage.decodes).toBe(0);
  });

  it('calls a file that will not load, or has no size, unreadable', async () => {
    FakeImage.next = 'error';
    expect(await measurePicture('blob:gone')).toBeNull();
    FakeImage.next = { width: 0, height: 0 };
    expect(await measurePicture('blob:empty')).toBeNull();
    expect(await measurePicture('')).toBeNull();
  });

  it('still decodes before drawing a picture or its filmstrip tile', async () => {
    // The mock DOM has no 2D canvas, so both stop just after the decode; the decode is the point.
    await decodePicture('blob:photo', 1080).catch(() => undefined);
    await pictureThumbnail('blob:photo', 80).catch(() => undefined);
    expect(FakeImage.decodes).toBe(2);
  });
});
