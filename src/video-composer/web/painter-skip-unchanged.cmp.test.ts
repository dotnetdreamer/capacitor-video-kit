import { BufferTarget, CanvasSource, Output, Quality, WebMOutputFormat } from 'mediabunny';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';

import { Painter, WHOLE_FRAME, type LayerDraw } from './painter';

/**
 * `PainterOptions.skipUnchangedVideo`: the live preview paints every animation frame, and a PLAYING
 * `<video>` still showing the frame its texture was last filled with is not uploaded again. Pinned
 * here with the real painter, a real element playing a real file, and the painter's own GL context
 * watched for uploads:
 *
 *  - a playing element painted twice inside one of its frames is uploaded once, and the second paint
 *    is still that frame, pixel for pixel what a painter without the option draws;
 *  - the next frame of it is uploaded as soon as the element shows it;
 *  - the same moment of ANOTHER file on the same element - which is what a preview copy taking the
 *    clip's place is - is uploaded, because a frame is told apart by its file as well as its time;
 *  - a paused element is uploaded on every paint, option or not: the skip is for playback alone;
 *  - without the option a playing element is uploaded on every paint, as it always was.
 *
 * Whether two paints fell inside one frame is read off the element itself, before and after them,
 * rather than assumed from how quickly they ran: a frame that turned over in between is a case that
 * proves nothing either way, and it is simply tried again.
 *
 * The fixtures are WebM/VP8, one colour a second, because an open-source Chromium can decode no H.264
 * and a second is a frame long enough to paint twice inside on any machine.
 */

const W = 64;
const H = 64;
const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];
const GREEN: [number, number, number] = [0, 255, 0];

/** A second of each colour, in order. */
async function colours(...each: string[]): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'vp8', quality: new Quality({ bitrate: 500_000 }) });
  output.addVideoTrack(source);
  await output.start();
  for (const [i, colour] of each.entries()) {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, W, H);
    await source.add(i, 1);
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('no fixture');
  const url = URL.createObjectURL(new Blob([buffer], { type: 'video/webm' }));
  urls.push(url);
  return url;
}

const urls: string[] = [];
const videos: HTMLVideoElement[] = [];
const painters: Painter[] = [];

afterEach(() => {
  vi.restoreAllMocks();
  for (const painter of painters.splice(0)) painter.dispose();
  for (const video of videos.splice(0)) {
    video.pause();
    video.removeAttribute('src');
    video.load();
    video.remove();
  }
  for (const url of urls.splice(0)) URL.revokeObjectURL(url);
});

function canPlayVp8(): boolean {
  return document.createElement('video').canPlayType('video/webm; codecs="vp8"') !== '';
}

/** A muted element in the document with `url` loaded and a picture to give. */
async function element(url: string): Promise<HTMLVideoElement> {
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  document.body.appendChild(video);
  videos.push(video);
  await pointAt(video, url);
  return video;
}

async function pointAt(video: HTMLVideoElement, url: string): Promise<void> {
  const loaded = new Promise<void>((resolve, reject) => {
    video.addEventListener('loadeddata', () => resolve(), { once: true });
    video.addEventListener('error', () => reject(new Error('fixture would not load')), { once: true });
  });
  video.src = url;
  video.load();
  await loaded;
}

async function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const seeked = new Promise<void>(resolve => video.addEventListener('seeked', () => resolve(), { once: true }));
  video.currentTime = seconds;
  await seeked;
}

/** Polls a frame at a time until `ready`, or fails naming what never happened. */
async function until(what: string, ready: () => boolean, ms = 10_000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/**
 * Playing from the top, and showing a frame of it. At a tenth of real speed by default, so each
 * colour is ten seconds of wall time: long enough for a case to be on the frame it expects however
 * slowly a loaded machine gets to it.
 */
async function playFromTop(video: HTMLVideoElement, rate = 0.1): Promise<void> {
  video.currentTime = 0;
  video.playbackRate = rate;
  await video.play();
  await until('the element to be playing with a frame', () => !video.paused && !video.seeking && video.readyState >= 2 && shownAt(video) !== null);
}

/** The media timestamp of the frame the element is showing, as the painter reads it; null for none. */
function shownAt(video: HTMLVideoElement): number | null {
  try {
    const frame = new VideoFrame(video);
    const timestamp = frame.timestamp;
    frame.close();
    return timestamp;
  } catch {
    return null;
  }
}

/** A painter at the fixture's size, and the calls its own GL context makes to upload `video`. */
function painterWith(ctx: TestContext, video: HTMLVideoElement, skipUnchangedVideo?: boolean) {
  const painter = new Painter({ width: W, height: H }, undefined, skipUnchangedVideo === undefined ? {} : { skipUnchangedVideo });
  painters.push(painter);
  painter.setColour(null, { filter: 'none', tints: [] });
  const gl = (painter as unknown as { gl: WebGL2RenderingContext | null }).gl;
  if (!gl || !painter.usesGpu) ctx.skip('this browser gives the painter no WebGL2');
  const texImage2D = vi.spyOn(gl!, 'texImage2D');
  return {
    painter,
    /** How many times `video` itself has been uploaded, whatever else the context was given. */
    uploads: () => texImage2D.mock.calls.filter(call => call.at(-1) === video).length,
  };
}

function layer(video: HTMLVideoElement): LayerDraw {
  return { source: video, sourceWidth: W, sourceHeight: H, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1 };
}

/** Every pixel of the painter's frame. */
function pixels(painter: Painter): Uint8ClampedArray {
  const read = document.createElement('canvas');
  read.width = W;
  read.height = H;
  const ctx = read.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(painter.frame, 0, 0);
  return ctx.getImageData(0, 0, W, H).data;
}

function centre(painter: Painter): [number, number, number] {
  const data = pixels(painter);
  const at = ((H / 2) * W + W / 2) * 4;
  return [data[at] ?? 0, data[at + 1] ?? 0, data[at + 2] ?? 0];
}

/** Each fixture colour by the second it starts at, which is its frame's timestamp. */
function colourShownAt(timestamp: number, order: ReadonlyArray<[number, number, number]>): [number, number, number] {
  const colour = order[Math.round(timestamp / 1_000_000)];
  if (!colour) throw new Error(`no frame of the fixture at ${timestamp}`);
  return colour;
}

/** VP8 is 4:2:0 and lossy: a solid colour comes back within a few steps of itself. */
function near(actual: [number, number, number], expected: [number, number, number], tolerance = 24): void {
  for (let c = 0; c < 3; c++) expect(Math.abs(actual[c]! - expected[c]!), `channel ${c} of [${actual}] against [${expected}]`).toBeLessThanOrEqual(tolerance);
}

/**
 * Runs `paints` until the element showed one frame from before the first paint to after the last,
 * and says how many uploads that try took and which frame it was. A try that straddled a frame is
 * thrown away and made again.
 */
async function insideOneFrame(video: HTMLVideoElement, uploads: () => number, paints: () => void): Promise<{ uploaded: number; frame: number }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const before = shownAt(video);
    const counted = uploads();
    paints();
    const after = shownAt(video);
    if (before !== null && before === after && !video.paused) return { uploaded: uploads() - counted, frame: before };
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  throw new Error('the element never held one frame for as long as two paints');
}

describe('a painter that skips unchanged video frames', () => {
  it('uploads a playing element once per frame of it, and draws the frame it kept', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const video = await element(await colours('#f00', '#00f', '#0f0'));
    const skipping = painterWith(ctx, video, true);
    const plain = painterWith(ctx, video);
    await playFromTop(video);

    let kept: Uint8ClampedArray | null = null;
    let drawn: Uint8ClampedArray | null = null;
    const { uploaded } = await insideOneFrame(
      video,
      () => skipping.uploads() + plain.uploads(),
      () => {
        skipping.painter.paintLayers([layer(video)]);
        skipping.painter.paintLayers([layer(video)]);
        kept = pixels(skipping.painter);
        // The same frame from a painter that uploads it every time.
        plain.painter.paintLayers([layer(video)]);
        drawn = pixels(plain.painter);
      },
    );

    // One for the skipping painter's first paint, none for its second, one for the plain painter.
    expect(uploaded).toBe(2);
    expect(kept).toEqual(drawn);
    near(centre(skipping.painter), RED);
  }, 30_000);

  it('uploads the next frame as soon as the element shows it', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const order = [RED, BLUE, GREEN];
    const video = await element(await colours('#f00', '#00f', '#0f0'));
    const { painter, uploads } = painterWith(ctx, video, true);
    await playFromTop(video);
    painter.paintLayers([layer(video)]);
    near(centre(painter), RED);
    const onRed = uploads();

    // On to the next frame the element shows. Which one that is is the browser's choice - a
    // renderer may pass straight over a frame it is late for - so it is read off the element.
    video.playbackRate = 4;
    await until('the element to show another frame', () => (shownAt(video) ?? 0) > 0);
    const before = shownAt(video);
    painter.paintLayers([layer(video)]);
    const after = shownAt(video);

    // Whatever frame the painter found, it was not the red one its texture holds.
    expect(uploads()).toBe(onRed + 1);
    if (before === after && before !== null) near(centre(painter), colourShownAt(before, order));
    else expect(centre(painter)[0]).toBeLessThan(60);
  }, 30_000);

  /*
   * What a preview copy taking the clip's place looks like to the painter: the same element, a new
   * file, and a frame at the very moment the old file's last upload was - the first frame of each.
   */
  it('uploads the same moment of another file on the same element', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const video = await element(await colours('#f00', '#00f', '#0f0'));
    const other = await colours('#0f0', '#f00', '#00f');
    const { painter, uploads } = painterWith(ctx, video, true);
    await playFromTop(video);
    const first = shownAt(video);
    painter.paintLayers([layer(video)]);
    near(centre(painter), RED);
    const before = uploads();

    video.pause();
    await pointAt(video, other);
    await playFromTop(video);
    // A case that proves nothing unless the two frames share a timestamp.
    if (shownAt(video) !== first) ctx.skip('the other file was not caught on the same moment');
    painter.paintLayers([layer(video)]);

    expect(uploads()).toBe(before + 1);
    near(centre(painter), GREEN);
  }, 30_000);

  it('uploads a paused element on every paint', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const video = await element(await colours('#f00', '#00f'));
    const { painter, uploads } = painterWith(ctx, video, true);
    await seekTo(video, 0.5);

    painter.paintLayers([layer(video)]);
    painter.paintLayers([layer(video)]);
    expect(uploads()).toBe(2);
    near(centre(painter), RED);

    await seekTo(video, 1.5);
    painter.paintLayers([layer(video)]);
    expect(uploads()).toBe(3);
    near(centre(painter), BLUE);

    // And back to a frame this texture has held before: still uploaded, and still right.
    await seekTo(video, 0.5);
    painter.paintLayers([layer(video)]);
    expect(uploads()).toBe(4);
    near(centre(painter), RED);
  }, 30_000);

  it('is off unless asked for: a playing element is uploaded on every paint', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const video = await element(await colours('#f00', '#00f', '#0f0'));
    const { painter, uploads } = painterWith(ctx, video);
    await playFromTop(video);

    const { uploaded } = await insideOneFrame(video, uploads, () => {
      painter.paintLayers([layer(video)]);
      painter.paintLayers([layer(video)]);
    });

    expect(uploaded).toBe(2);
    near(centre(painter), RED);
  }, 30_000);
});
