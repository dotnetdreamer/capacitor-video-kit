import { describe, expect, it } from 'vitest';

import { VideoHold } from './preview-media';

/*
 * A browser rather than the mock DOM, because a hold is a `<canvas>` drawn from a `<video>`: there
 * is no 2d context to get and no `drawImage` to call in the mock one.
 *
 * Both of these are about the hold coming DOWN, which is the half nothing was watching. A hold that
 * stays up is a still picture over a preview that is playing; a hold that comes down early is the
 * black flash the whole canvas exists to cover, so being wrong in either direction is visible.
 */

/** How long the reveal's own timer is given, plus room for a slow frame. */
const REVEAL_MS = 34;

/**
 * Stands in for a loaded element and for its presented frames.
 *
 * `requestVideoFrameCallback` is modelled rather than stubbed away, because what is pinned below is
 * that a callback the hold armed and did not use is CANCELLED: a fake that only remembers the
 * function would report the same thing whether it was cancelled or not. So this one is a queue, and
 * `presentFrame` runs whatever is still in it - which is what the element does on its next frame.
 */
function standInForVideo(): {
  video: HTMLVideoElement;
  canvas: HTMLCanvasElement;
  presentFrame: () => void;
  armed: () => number;
} {
  const video = document.createElement('video');
  // A frame to copy: `raise` takes the element's own size and refuses an element with nothing on it.
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 /* HAVE_ENOUGH_DATA */ });
  Object.defineProperty(video, 'videoWidth', { configurable: true, get: () => 640 });
  Object.defineProperty(video, 'videoHeight', { configurable: true, get: () => 360 });

  const queue = new Map<number, () => void>();
  let next = 1;
  Object.assign(video, {
    requestVideoFrameCallback: (callback: () => void) => {
      const handle = next;
      next += 1;
      queue.set(handle, callback);
      return handle;
    },
    cancelVideoFrameCallback: (handle: number) => {
      queue.delete(handle);
    },
  });

  return {
    video,
    canvas: document.createElement('canvas'),
    presentFrame: () => {
      const due = [...queue.values()];
      queue.clear();
      for (const callback of due) callback();
    },
    armed: () => queue.size,
  };
}

async function until(what: string, ready: () => boolean, ms = 1000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

describe('VideoHold', () => {
  it('lowers itself when it is destroyed, so the next one is not born blank and up', () => {
    const { video, canvas } = standInForVideo();
    let holding = false;
    const hold = new VideoHold(video, canvas, on => (holding = on), 5000);

    hold.raise();
    expect(holding).toBe(true);

    // What `PreviewPlayer.attachFollower` does every time the second video's element goes away: a
    // remove, an undo of Add video, a source that changed under it.
    hold.destroy();

    // The component's signal is what the render reads, and the canvas it puts the class on next is
    // a NEW one with nothing drawn into it. Left on, it covers the whole frame with 300x150 of
    // blank, and the hold that owns that canvas has never been raised, so nothing will lower it.
    expect(holding).toBe(false);
  });

  it('cancels the reveal it did not use, so a late frame cannot lower the NEXT hold', async () => {
    const { video, canvas, presentFrame, armed } = standInForVideo();
    let holding = false;
    const hold = new VideoHold(video, canvas, on => (holding = on), 5000);

    // A hold over a source change that ends with the element PAUSED: the frame callback never
    // fires, because a paused element presents nothing, and the timer behind it does the lowering.
    hold.raise();
    hold.lower();
    expect(armed()).toBe(1);
    await until('the reveal timer to lower the first hold', () => !holding, REVEAL_MS + 500);

    // The next clip change, while that callback is still queued on the element.
    hold.raise();
    expect(holding).toBe(true);

    // The element presents a frame at last - the customer pressed Play. It belongs to the hold that
    // came down two edits ago, and lowering this one on it drops the held frame before the new
    // source has painted, which is the black flash the hold is there to cover.
    presentFrame();
    expect(holding).toBe(true);
  });
});
