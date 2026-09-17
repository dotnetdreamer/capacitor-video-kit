import { describe, expect, it } from 'vitest';

import { SEEK_EPSILON_S, repaintPaused } from './preview-media';

/**
 * The seek that puts a paused element's picture back after its box has moved. It has to land
 * somewhere the element is not already sitting - a WebView may answer a seek to the position it is
 * on with nothing at all, and nothing is what the bug was - and it has to stay close enough that the
 * frame that comes back is the frame that was there.
 */
function element(over: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  return { paused: true, readyState: 4, currentTime: 1, duration: 5, ...over } as unknown as HTMLVideoElement;
}

describe('repaintPaused', () => {
  it('moves a paused element holding a frame off the position it is on', () => {
    const video = element();
    repaintPaused(video);
    expect(video.currentTime).not.toBe(1);
    // Inside the tolerance the player seeks by, so the picture does not move and the next ordinary
    // seek is free to leave it here.
    expect(Math.abs(video.currentTime - 1)).toBeLessThan(SEEK_EPSILON_S);
  });

  it('moves backwards at the very end of the file, where there is no room ahead', () => {
    const video = element({ currentTime: 5, duration: 5 });
    repaintPaused(video);
    expect(video.currentTime).toBeLessThan(5);
    expect(video.currentTime).toBeGreaterThan(5 - SEEK_EPSILON_S);
  });

  it('moves forwards on a source whose length is not known', () => {
    const video = element({ currentTime: 2, duration: Number.NaN });
    repaintPaused(video);
    expect(video.currentTime).toBeGreaterThan(2);
  });

  it('leaves a playing element alone, because it presents frames of its own', () => {
    const video = element({ paused: false });
    repaintPaused(video);
    expect(video.currentTime).toBe(1);
  });

  it('leaves an element with no frame yet alone', () => {
    const video = element({ readyState: 1 /* HAVE_METADATA */ });
    repaintPaused(video);
    expect(video.currentTime).toBe(1);
  });
});
