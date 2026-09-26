import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { afterEach, describe, expect, it, type TestContext } from 'vitest';

import { PresentedFrames } from './presented-frames';

/**
 * The preview's half of slow motion on a real `<video>`, really playing slowed in a real browser:
 * the frame the element presented before the one it shows now, held as a bitmap, and the weight
 * towards the one it shows now - and nothing at all wherever that cannot be had.
 *
 * The footage is a grey ramp, so which of two frames is the EARLIER one is a matter of which is
 * darker, and a held frame that was not the one before would show up as the wrong grey.
 */

const FPS = 12;
const FRAMES = 24;

async function rampVideo(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 48;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const output = new Output({ format: new Mp4OutputFormat({ fastStart: 'in-memory' }), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'avc', quality: new Quality({ bitrate: 500_000 }) });
  output.addVideoTrack(source);
  await output.start();
  for (let i = 0; i < FRAMES; i++) {
    const grey = Math.round((255 * i) / (FRAMES - 1));
    ctx.fillStyle = `rgb(${grey}, ${grey}, ${grey})`;
    ctx.fillRect(0, 0, 64, 48);
    await source.add(i / FPS, 1 / FPS);
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('no fixture');
  return URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
}

/** The grey at the middle of whatever `source` shows now. */
function greyOf(source: CanvasImageSource): number {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 4;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(source, 0, 0, 4, 4);
  return ctx.getImageData(2, 2, 1, 1).data[1] ?? 0;
}

function canDecodeAvc(): boolean {
  return document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
}

const opened: { video: HTMLVideoElement; url: string }[] = [];

/** A muted element in the document on the ramp, loaded and parked on its first frame. */
async function element(): Promise<HTMLVideoElement> {
  const url = await rampVideo();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.style.width = '64px';
  document.body.appendChild(video);
  opened.push({ video, url });
  const loaded = new Promise<void>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('fixture would not load')), { once: true });
  });
  video.src = url;
  await loaded;
  return video;
}

afterEach(() => {
  for (const { video, url } of opened.splice(0)) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
});

interface Answer {
  from: ImageBitmap;
  to: ImageBitmap | null;
  weight: number;
  fromGrey: number;
  /** Frame B's grey: its copy's, or the element's while there is no copy. */
  toGrey: number;
  /** The grey the painter would draw: A and B mixed at the weight. */
  shown: number;
  /** The element's own grey at the same moment, which is what the preview drew before this. */
  element: number;
}

/** Asks `frames` on every animation frame for `ms`, the way the compositor does, and collects the answers. */
function askEveryFrame(frames: PresentedFrames, video: HTMLVideoElement, ms: number): Promise<Answer[]> {
  const answers: Answer[] = [];
  return new Promise(resolve => {
    const started = performance.now();
    const tick = (time: number) => {
      const pair = frames.tween(video, time);
      if (pair) {
        const fromGrey = greyOf(pair.from);
        const toGrey = greyOf(pair.to ?? video);
        answers.push({ ...pair, fromGrey, toGrey, shown: fromGrey * (1 - pair.weight) + toGrey * pair.weight, element: greyOf(video) });
      }
      if (performance.now() - started < ms) requestAnimationFrame(tick);
      else resolve(answers);
    };
    requestAnimationFrame(tick);
  });
}

describe('the frames a slowed element is drawn between', () => {
  it('are two neighbouring frames, the earlier first, with a weight that runs 0..1 across the later one', async (ctx: TestContext) => {
    if (!canDecodeAvc()) ctx.skip('this browser cannot decode H.264');
    const video = await element();
    if (typeof video.requestVideoFrameCallback !== 'function') ctx.skip('this browser has no requestVideoFrameCallback');
    const dropped: ImageBitmap[] = [];
    const frames = new PresentedFrames(bitmap => dropped.push(bitmap));
    try {
      video.playbackRate = 0.5;
      await video.play();
      // At 0.5x a 12 fps ramp presents a new frame every 167 ms: well over a second holds several.
      const answers = await askEveryFrame(frames, video, 1500);
      expect(answers.length).toBeGreaterThan(10);
      const step = 255 / (FRAMES - 1);
      const pairs = answers.filter(answer => answer.weight > 0);
      for (const answer of answers) {
        expect(answer.weight).toBeGreaterThanOrEqual(0);
        expect(answer.weight).toBeLessThanOrEqual(1);
      }
      for (const answer of pairs) {
        // A is the EARLIER frame: darker on a rising ramp. Usually by one frame's step; by two or
        // three where a loaded machine did not present the frames between, and the pair is then the
        // two frames it did present - never further apart than a jump is allowed to be.
        expect(answer.toGrey - answer.fromGrey).toBeGreaterThan(step / 2);
        expect(answer.toGrey - answer.fromGrey).toBeLessThan(step * 3.5);
      }
      expect(pairs.some(answer => answer.toGrey - answer.fromGrey < step * 1.5)).toBe(true);
      // Across one pair the weight only rises; a new pair starts it again.
      for (let i = 1; i < answers.length; i++) {
        if (answers[i]!.from === answers[i - 1]!.from) expect(answers[i]!.weight).toBeGreaterThanOrEqual(answers[i - 1]!.weight);
      }
      expect(new Set(answers.map(answer => answer.from)).size).toBeGreaterThan(2);
      // What is drawn from two copies never steps BACK: each is the frame its callback named, so a
      // pair is always the frame before and the frame after. (A pair with the element in it did step
      // back once a frame, the element's picture running a step ahead of its callbacks; see
      // `PresentedTween`.) And it moves between the element's frames: more distinct pictures than the
      // element itself showed.
      for (let i = 1; i < answers.length; i++) {
        if (answers[i]!.to && answers[i - 1]!.to) expect(answers[i]!.shown, `answer ${i}`).toBeGreaterThanOrEqual(answers[i - 1]!.shown - 1);
      }
      const distinct = (values: number[]) => new Set(values.map(Math.round)).size;
      expect(distinct(answers.map(answer => answer.shown))).toBeGreaterThan(distinct(answers.map(answer => answer.element)));
      // Each frame it moved past was given back as it went.
      expect(dropped.length).toBeGreaterThan(0);
    } finally {
      frames.destroy();
    }
  }, 30_000);

  it('is nothing while the element is paused: the paused frame is the exact one', async (ctx: TestContext) => {
    if (!canDecodeAvc()) ctx.skip('this browser cannot decode H.264');
    const video = await element();
    if (typeof video.requestVideoFrameCallback !== 'function') ctx.skip('this browser has no requestVideoFrameCallback');
    const frames = new PresentedFrames();
    try {
      video.playbackRate = 0.5;
      await video.play();
      await askEveryFrame(frames, video, 800);
      video.pause();
      expect(frames.tween(video, performance.now())).toBeNull();
    } finally {
      frames.destroy();
    }
  }, 30_000);

  it('is nothing, and never throws, where the browser has no requestVideoFrameCallback', async (ctx: TestContext) => {
    if (!canDecodeAvc()) ctx.skip('this browser cannot decode H.264');
    const video = await element();
    // An old WebView: the element simply has no such method.
    Object.defineProperty(video, 'requestVideoFrameCallback', { value: undefined, configurable: true });
    const frames = new PresentedFrames();
    try {
      video.playbackRate = 0.5;
      await video.play();
      const answers = await askEveryFrame(frames, video, 500);
      expect(answers).toEqual([]);
      // ...and playback went on regardless.
      expect(video.paused).toBe(false);
      expect(video.currentTime).toBeGreaterThan(0);
    } finally {
      frames.destroy();
    }
  }, 30_000);

  it('gives back every frame it holds when it is destroyed', async (ctx: TestContext) => {
    if (!canDecodeAvc()) ctx.skip('this browser cannot decode H.264');
    const video = await element();
    if (typeof video.requestVideoFrameCallback !== 'function') ctx.skip('this browser has no requestVideoFrameCallback');
    const dropped: ImageBitmap[] = [];
    const frames = new PresentedFrames(bitmap => dropped.push(bitmap));
    video.playbackRate = 0.5;
    await video.play();
    const answers = await askEveryFrame(frames, video, 800);
    const held = answers.at(-1)?.from;
    expect(held).toBeDefined();
    frames.destroy();
    expect(dropped).toContain(held);
    // Closed, which is how a bitmap says it has let its pixels go.
    expect(held!.width).toBe(0);
  }, 30_000);
});
