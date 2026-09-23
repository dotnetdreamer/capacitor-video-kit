import { afterEach, describe, expect, it } from 'vitest';

import { ClipMedia, StillPicture } from './clip-media';

/*
 * A picture has to play like a clip for the preview's player to hold it at all - be the clock
 * through its own segment, sit ready on the spare before its cut, be the outgoing side of a
 * transition. Everything the player reads off a `<video>` is pinned here against a real decode in a
 * real browser: the size once it has loaded, a clock that runs while it plays and stands still while
 * it is paused, a seek answered the way a video answers one, and a slot that speaks for whichever of
 * its two it is showing.
 */

const made: string[] = [];

async function pictureUrl(width = 64, height = 48, colour = '#f00'): Promise<string> {
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

function next(target: EventTarget, type: string, ms = 5000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`no ${type}`)), ms);
    target.addEventListener(
      type,
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

afterEach(() => {
  for (const url of made.splice(0)) URL.revokeObjectURL(url);
});

describe('StillPicture', () => {
  it('says it has loaded, at the picture size, once it has decoded', async () => {
    const still = new StillPicture();
    still.src = await pictureUrl(64, 48);
    const loaded = next(still, 'loadedmetadata');
    still.load();
    expect(still.readyState).toBe(0);
    await loaded;

    expect([still.videoWidth, still.videoHeight]).toEqual([64, 48]);
    expect(still.readyState).toBe(4);
    expect(still.bitmap).not.toBeNull();
    still.clear();
  });

  it('answers a file that is not a picture with an error, as a video that will not open does', async () => {
    const still = new StillPicture();
    still.src = URL.createObjectURL(new Blob(['not a picture'], { type: 'image/png' }));
    made.push(still.src);
    const failed = next(still, 'error');
    still.load();
    await failed;
    expect(still.error).not.toBeNull();
    expect(still.bitmap).toBeNull();
  });

  it('runs a clock while it plays, stands still while paused, and at the rate it is given', async () => {
    const still = new StillPicture();
    still.currentTime = 10;
    await next(still, 'seeked');

    await wait(60);
    expect(still.currentTime).toBe(10);

    await still.play();
    await wait(200);
    const played = still.currentTime - 10;
    expect(played).toBeGreaterThan(0.15);
    expect(played).toBeLessThan(0.6);

    still.pause();
    const pausedAt = still.currentTime;
    await wait(80);
    expect(still.currentTime).toBe(pausedAt);

    still.playbackRate = 2;
    await still.play();
    await wait(200);
    expect(still.currentTime - pausedAt).toBeGreaterThan(0.3);
    still.clear();
  });

  it('answers a seek a task later, never inside the write, as the player expects of a video', async () => {
    const still = new StillPicture();
    let answered = false;
    still.addEventListener('seeked', () => (answered = true));
    still.currentTime = 5;
    expect(still.seeking).toBe(true);
    expect(answered).toBe(false);
    await next(still, 'seeked');
    expect(still.seeking).toBe(false);
    expect(still.currentTime).toBe(5);
  });
});

describe('ClipMedia', () => {
  function slot(): { media: ClipMedia; element: HTMLVideoElement } {
    const element = document.createElement('video');
    element.muted = true;
    return { media: new ClipMedia(element), element };
  }

  it('speaks for its video element until it is told to show a picture', async () => {
    const { media, element } = slot();
    expect(media.isPicture).toBe(false);
    expect(media.drawable).toBe(element);

    media.showPicture(true);
    media.src = await pictureUrl(30, 20);
    const loaded = next(media, 'loadedmetadata');
    media.load();
    await loaded;

    expect([media.videoWidth, media.videoHeight]).toEqual([30, 20]);
    expect(media.drawable).toBe(media.still.bitmap);
    // The element was stripped on the way, which is what hands a phone's decoder back.
    expect(element.getAttribute('src')).toBeNull();
    media.dispose();
  });

  it('forwards only the live one of its two', async () => {
    const { media, element } = slot();
    media.showPicture(true);
    let heard = 0;
    media.addEventListener('pause', () => (heard += 1));

    element.dispatchEvent(new Event('pause'));
    expect(heard).toBe(0);

    media.still.dispatchEvent(new Event('pause'));
    expect(heard).toBe(1);
    media.dispose();
  });

  it('lets the picture go when it goes back to being a video', async () => {
    const { media } = slot();
    media.showPicture(true);
    media.src = await pictureUrl();
    const loaded = next(media, 'loadedmetadata');
    media.load();
    await loaded;
    const bitmap = media.still.bitmap as ImageBitmap;

    media.showPicture(false);
    expect(media.still.bitmap).toBeNull();
    // A closed bitmap reports no size, which is how the painter knows to drop its texture.
    expect(bitmap.width).toBe(0);
    media.dispose();
  });
});
