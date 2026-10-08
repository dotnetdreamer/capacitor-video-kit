import { describe, expect, it, vi } from 'vitest';

import type { DecodedPicture } from '../../web-runtime/picture';
import { PreviewPictures } from './preview-pictures';

/*
 * The preview's pictures are decoded once per file and shared by every slot that shows one, and the
 * ones nobody is showing are kept for a while: what made a template's split open on a frozen stage
 * was each half decoding its own copy of a photo the base track had just shown. Decoding is the
 * browser's, so it is stood in for here by a decode the test answers.
 */

/** A decoded picture of `width` x `height`, whose bitmap records being closed. */
function picture(width = 10, height = 10): DecodedPicture & { closed: () => boolean } {
  const close = vi.fn();
  const bitmap = { width, height, close } as unknown as ImageBitmap;
  return { bitmap, width, height, closed: () => close.mock.calls.length > 0 };
}

/** A decode the test settles by hand, one per call, in the order they were asked for. */
function decoder() {
  const calls: Array<{ url: string; resolve: (p: DecodedPicture) => void; reject: (e: Error) => void }> = [];
  const decode = vi.fn(
    (url: string) =>
      new Promise<DecodedPicture>((resolve, reject) => {
        calls.push({ url, resolve, reject });
      }),
  );
  return { decode, calls };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

describe('PreviewPictures', () => {
  it('decodes a picture once however many slots hold it, and hands every one the same picture', async () => {
    const { decode, calls } = decoder();
    const pictures = new PreviewPictures(2048, { decode });
    const first = pictures.hold('blob:a');
    const second = pictures.hold('blob:a');
    expect(decode).toHaveBeenCalledTimes(1);
    expect(first.picture).toBeNull();

    const decoded = picture();
    calls[0].resolve(decoded);
    expect(await first.ready).toBe(decoded);
    expect(await second.ready).toBe(decoded);
    // Asked for again now it is decoded: there at once, with no decode of its own.
    expect(pictures.hold('blob:a').picture).toBe(decoded);
    expect(decode).toHaveBeenCalledTimes(1);
  });

  it('keeps the pictures nobody holds up to its budget, letting the longest-unheld go first', async () => {
    const { decode, calls } = decoder();
    // Room for two 10x10 pictures and not three.
    const pictures = new PreviewPictures(2048, { decode, keptBytes: 2 * 10 * 10 * 4 });
    const [a, b, c] = ['blob:a', 'blob:b', 'blob:c'].map(url => pictures.hold(url));
    const decoded = [picture(), picture(), picture()];
    calls.forEach((call, i) => call.resolve(decoded[i]));
    await Promise.all([a.ready, b.ready, c.ready]);

    a.release();
    b.release();
    expect([pictures.has('blob:a'), pictures.has('blob:b')]).toEqual([true, true]);
    c.release();
    expect([pictures.has('blob:a'), pictures.has('blob:b'), pictures.has('blob:c')]).toEqual([false, true, true]);
    expect(decoded.map(p => p.closed())).toEqual([true, false, false]);
  });

  it('never lets a picture go while a slot holds it, however far over its budget', async () => {
    const { decode, calls } = decoder();
    const pictures = new PreviewPictures(2048, { decode, keptBytes: 0 });
    const held = pictures.hold('blob:a');
    const decoded = picture();
    calls[0].resolve(decoded);
    await held.ready;
    expect(pictures.has('blob:a')).toBe(true);

    held.release();
    held.release();
    expect(pictures.has('blob:a')).toBe(false);
    expect(decoded.closed()).toBe(true);
  });

  it('decodes ahead of a slot asking, so the slot that asks finds the picture ready', async () => {
    const { decode, calls } = decoder();
    const pictures = new PreviewPictures(2048, { decode });
    pictures.warm('blob:a');
    pictures.warm('blob:a');
    expect(decode).toHaveBeenCalledTimes(1);
    const decoded = picture();
    calls[0].resolve(decoded);
    await tick();

    expect(pictures.hold('blob:a').picture).toBe(decoded);
    expect(decoded.closed()).toBe(false);
  });

  it('tries a file again for the next slot after it would not decode', async () => {
    const { decode, calls } = decoder();
    const pictures = new PreviewPictures(2048, { decode });
    const first = pictures.hold('blob:a');
    calls[0].reject(new Error('not a picture'));
    await expect(first.ready).rejects.toThrow('not a picture');

    const again = pictures.hold('blob:a');
    expect(decode).toHaveBeenCalledTimes(2);
    const decoded = picture();
    calls[1].resolve(decoded);
    expect(await again.ready).toBe(decoded);
  });

  it('lets everything go when destroyed, a decode that lands afterwards included', async () => {
    const { decode, calls } = decoder();
    const pictures = new PreviewPictures(2048, { decode });
    const shown = pictures.hold('blob:a');
    const decodedA = picture();
    calls[0].resolve(decodedA);
    await shown.ready;
    const coming = pictures.hold('blob:b');

    pictures.destroy();
    expect(decodedA.closed()).toBe(true);

    const decodedB = picture();
    calls[1].resolve(decodedB);
    await expect(coming.ready).rejects.toThrow();
    expect(decodedB.closed()).toBe(true);
  });
});
