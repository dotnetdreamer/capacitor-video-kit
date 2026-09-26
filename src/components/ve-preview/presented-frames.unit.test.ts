import { afterEach, describe, expect, it, vi } from 'vitest';

import { PresentedFrames, tweenWeight } from './presented-frames';

/**
 * The arithmetic half of the preview's slow motion: how far from one presented frame to the next the
 * picture is, from the wall time since the later one was presented. The half that follows a real
 * element is pinned in the browser test beside this.
 */

describe('tweenWeight', () => {
  it('runs from 0 as a frame is presented to 1 as the next one is due', () => {
    // 30 fps footage at 0.3x: a new frame every 111 ms of wall time.
    const interval = 1 / 30;
    expect(tweenWeight(0, 0.3, interval)).toBe(0);
    expect(tweenWeight(1000 / 18, 0.3, interval)).toBeCloseTo(0.5, 9);
    expect(tweenWeight(1000 / 9, 0.3, interval)).toBeCloseTo(1, 9);
  });

  it('holds at the later frame, alone, while the next one is late', () => {
    expect(tweenWeight(500, 0.3, 1 / 30)).toBe(1);
  });

  it('measures the interval in the footage’s own time, so a long frame of a variable rate takes longer', () => {
    expect(tweenWeight(100, 0.5, 0.1)).toBeCloseTo(0.5, 9);
    expect(tweenWeight(100, 0.5, 0.05)).toBeCloseTo(1, 9);
  });

  it('is 0 for anything that is not a real interval, rate or elapsed time', () => {
    expect(tweenWeight(50, 0.3, 0)).toBe(0);
    expect(tweenWeight(50, 0.3, -0.1)).toBe(0);
    expect(tweenWeight(50, 0, 0.1)).toBe(0);
    expect(tweenWeight(-5, 0.3, 0.1)).toBe(0);
    expect(tweenWeight(Number.NaN, 0.3, 0.1)).toBe(0);
  });
});

/**
 * An element whose frames are presented when the test says so, and a `createImageBitmap` whose
 * copies land when the test says so: the whole of the timing `PresentedFrames` depends on, scripted.
 */
function scripted() {
  let callback: ((now: number, metadata: { mediaTime: number }) => void) | null = null;
  const video = {
    paused: false,
    seeking: false,
    ended: false,
    currentSrc: 'blob:clip',
    videoWidth: 16,
    videoHeight: 9,
    playbackRate: 0.5,
    requestVideoFrameCallback(next: typeof callback) {
      callback = next;
      return 1;
    },
  };
  const copies: { mediaTime: number; land: () => void }[] = [];
  let presenting = 0;
  vi.stubGlobal('createImageBitmap', () => {
    const bitmap = {
      width: 16,
      height: 9,
      mediaTime: presenting,
      closed: false,
      close() {
        this.closed = true;
      },
    };
    return new Promise(resolve => copies.push({ mediaTime: presenting, land: () => resolve(bitmap) }));
  });
  return {
    video: video as unknown as HTMLVideoElement,
    element: video,
    /** Presents the frame at `mediaTime`, `now` ms into the wall clock. */
    present(mediaTime: number, now: number) {
      presenting = mediaTime;
      const run = callback;
      callback = null;
      run?.(now, { mediaTime });
    },
    /** Lets the copy of the frame at `mediaTime` land. */
    async land(mediaTime: number) {
      copies.find(copy => copy.mediaTime === mediaTime)?.land();
      await Promise.resolve();
      await Promise.resolve();
    },
  };
}

type Copy = { mediaTime: number; closed: boolean };
const timeOf = (bitmap: ImageBitmap | null | undefined) => (bitmap as unknown as Copy | null | undefined)?.mediaTime;

describe('PresentedFrames, frame by frame', () => {
  afterEach(() => vi.unstubAllGlobals());

  // 12 fps footage at 0.5x: a frame every 83.3 ms of footage, every 166.7 ms of wall time.
  const F = 1 / 12;

  it('draws the element until a frame is reported, then HOLDS that frame until the pair is gathered', async () => {
    const clip = scripted();
    const frames = new PresentedFrames();
    expect(frames.tween(clip.video, 0)).toBeNull();
    clip.present(0, 10);
    await clip.land(0);
    // Held, not the element: the element is a step ahead of its reports, and what follows runs a
    // frame behind it, so drawing it now and the pair next would step the picture back.
    const held = frames.tween(clip.video, 20)!;
    expect(timeOf(held.from)).toBe(0);
    expect(held.weight).toBe(0);
    frames.destroy();
  });

  it('blends the frame before towards the frame now across the frame now’s time on screen', async () => {
    const clip = scripted();
    const frames = new PresentedFrames();
    frames.tween(clip.video, 0);
    clip.present(0, 0);
    await clip.land(0);
    frames.tween(clip.video, 100);
    clip.present(F, 167);
    await clip.land(F);
    const start = frames.tween(clip.video, 167)!;
    expect(timeOf(start.from)).toBe(0);
    expect(timeOf(start.to)).toBe(F);
    expect(start.weight).toBe(0);
    const half = frames.tween(clip.video, 167 + 250 / 3)!;
    expect(half.weight).toBeCloseTo(0.5, 6);
    // The next frame is late: B alone, held, until it comes.
    expect(frames.tween(clip.video, 600)!.weight).toBe(1);
    frames.destroy();
  });

  it('lets the element stand in for a copy still being made, early on - and holds A rather than trust it late', async () => {
    const clip = scripted();
    const frames = new PresentedFrames();
    frames.tween(clip.video, 0);
    clip.present(0, 0);
    await clip.land(0);
    frames.tween(clip.video, 100);
    clip.present(F, 167);
    // F's copy has not landed. Early in its time on screen the element is certainly showing it...
    const early = frames.tween(clip.video, 200)!;
    expect(timeOf(early.from)).toBe(0);
    expect(early.to).toBeNull();
    expect(early.weight).toBeGreaterThan(0);
    // ...but past half of it the element may already be on the NEXT frame, a step before it is
    // reported, and A is held alone instead.
    const late = frames.tween(clip.video, 167 + 120)!;
    expect(timeOf(late.from)).toBe(0);
    expect(late.weight).toBe(0);
    await clip.land(F);
    expect(timeOf(frames.tween(clip.video, 167 + 130)!.to)).toBe(F);
    frames.destroy();
  });

  it('never blends across a jump: a seek back, a leap forward, or a new source starts over', async () => {
    const clip = scripted();
    const frames = new PresentedFrames();
    frames.tween(clip.video, 0);
    clip.present(1, 0);
    await clip.land(1);
    frames.tween(clip.video, 50);
    // Back: a seek. The frame before is not the one before this one.
    clip.present(0.5, 100);
    await clip.land(0.5);
    expect(frames.tween(clip.video, 110)).toMatchObject({ weight: 0 });
    expect(timeOf(frames.tween(clip.video, 110)!.from)).toBe(0.5);
    // Forward, further than any real frame: the same.
    clip.present(2, 200);
    await clip.land(2);
    expect(timeOf(frames.tween(clip.video, 210)!.from)).toBe(2);
    expect(frames.tween(clip.video, 210)!.weight).toBe(0);
    // Another file on the element: nothing at all until its frames are reported.
    clip.element.currentSrc = 'blob:other';
    expect(frames.tween(clip.video, 220)).toBeNull();
    frames.destroy();
  });

  it('draws the element as it is while paused or seeking', async () => {
    const clip = scripted();
    const frames = new PresentedFrames();
    frames.tween(clip.video, 0);
    clip.present(0, 0);
    await clip.land(0);
    frames.tween(clip.video, 100);
    clip.present(F, 167);
    await clip.land(F);
    clip.element.paused = true;
    expect(frames.tween(clip.video, 200)).toBeNull();
    clip.element.paused = false;
    clip.element.seeking = true;
    expect(frames.tween(clip.video, 210)).toBeNull();
    frames.destroy();
  });

  it('lets every copy go once nobody asks, and when destroyed', async () => {
    const clip = scripted();
    const dropped: number[] = [];
    const frames = new PresentedFrames(bitmap => dropped.push(timeOf(bitmap)!));
    frames.tween(clip.video, 0);
    clip.present(0, 0);
    await clip.land(0);
    frames.tween(clip.video, 100);
    clip.present(F, 167);
    await clip.land(F);
    // Not asked since 100 ms: the next report finds it idle, and it lets both frames go.
    clip.present(2 * F, 400);
    expect(dropped.sort()).toEqual([0, F]);
    // And a new start after that is a new start.
    expect(frames.tween(clip.video, 410)).toBeNull();
    frames.destroy();
  });
});

describe('PresentedFrames without the browser support it needs', () => {
  it('answers nothing, and asks nothing of the element, where there is no requestVideoFrameCallback', () => {
    // An old WebView's element: no frame callback. Nothing may be registered, and nothing may throw.
    const element = { paused: false, seeking: false, ended: false, currentSrc: 'blob:x', videoWidth: 10, videoHeight: 10, playbackRate: 0.3 } as unknown as HTMLVideoElement;
    const frames = new PresentedFrames();
    expect(frames.tween(element, 0)).toBeNull();
    expect(frames.tween(element, 16)).toBeNull();
    frames.destroy();
  });
});
