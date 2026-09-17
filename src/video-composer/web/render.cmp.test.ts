import { describe, expect, it, type TestContext } from 'vitest';

import type { ComposeSpec } from '../definitions';

import { renderSupport, resetRenderSupport } from './capabilities';
import { Mp4Writer } from './mp4';
import { Painter } from './painter';
import { renderSpec } from './render';

/**
 * The renderer, in a real browser, end to end.
 *
 * Everything else about the web engine is pinned by unit tests over pure functions, and one thing
 * cannot be: whether the file the muxer writes is a file a player will OPEN. A wrong box order, a
 * wrong chunk offset and a wrong sample description all read the same way to a `<video>` - it
 * refuses - so the only honest check is to hand one to the browser and see.
 *
 * The source footage is made by this file, with the same encoder and the same muxer the render
 * uses. That is deliberate rather than convenient: it round-trips the container through the
 * browser's own demuxer, so a muxer that wrote something only it could read fails here rather than
 * in a customer's feed.
 */

const SOURCE_WIDTH = 160;
const SOURCE_HEIGHT = 120;
const SOURCE_FRAMES = 12;
const SOURCE_FPS = 12;

/** Renders take seconds, not milliseconds: a seek and a decode per frame is the whole design. */
const RENDER_TIMEOUT_MS = 60_000;

/**
 * The support for one output size, probed fresh.
 *
 * `renderSupport` caches, because a page renders one size and asking the platform twice costs an
 * encoder allocation. A test suite renders several, so it resets first - otherwise the first size
 * asked for is the answer every later case gets, which is how a suite comes to pass by testing
 * nothing.
 */
async function supportFor(width: number, height: number, fps: number) {
  resetRenderSupport();
  return await renderSupport(width, height, fps);
}

/**
 * Marks the case skipped rather than returning green.
 *
 * A test that quietly returns when the platform cannot do the thing reports a tick for work it did
 * not do, and a suite of those is worse than no suite: it is a suite that says the renderer works
 * on a machine where it was never run. `ctx.skip()` puts the reason in the report instead.
 */
function needs(ctx: TestContext, able: boolean, why: string): void {
  if (!able) ctx.skip(why);
}

/** The encoder's own description, copied into a buffer a `Blob` will take. */
function describedBytes(source: AllowSharedBufferSource): Uint8Array<ArrayBuffer> {
  if (ArrayBuffer.isView(source)) {
    const view = source as ArrayBufferView;
    return new Uint8Array(view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer);
  }
  return new Uint8Array((source as ArrayBuffer).slice(0));
}

/** A short solid-colour MP4, written the way the renderer writes one. */
async function makeSourceVideo(colour: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');

  const support = await renderSupport(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_FPS);
  if (!support.supported) throw new Error(support.reason);

  const writer = new Mp4Writer();
  let track = -1;
  const encoder = new VideoEncoder({
    output: (chunk, metadata) => {
      if (track < 0) {
        const description = metadata?.decoderConfig?.description;
        if (!description) throw new Error('no avcC');
        track = writer.addVideoTrack({
          width: SOURCE_WIDTH,
          height: SOURCE_HEIGHT,
          description: describedBytes(description),
          bitrate: 1_000_000,
        });
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      writer.addSample(track, {
        data,
        timestampUs: chunk.timestamp,
        durationUs: chunk.duration ?? Math.round(1_000_000 / SOURCE_FPS),
        isSync: chunk.type === 'key',
      });
    },
    error: error => {
      throw error;
    },
  });
  encoder.configure({
    codec: support.videoCodec,
    width: SOURCE_WIDTH,
    height: SOURCE_HEIGHT,
    bitrate: 1_000_000,
    framerate: SOURCE_FPS,
    avc: { format: 'avc' },
  });

  for (let i = 0; i < SOURCE_FRAMES; i++) {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
    const frame = new VideoFrame(canvas, {
      timestamp: Math.round((i * 1_000_000) / SOURCE_FPS),
      duration: Math.round(1_000_000 / SOURCE_FPS),
    });
    encoder.encode(frame, { keyFrame: i === 0 });
    frame.close();
  }
  await encoder.flush();
  encoder.close();
  return writer.finalize();
}

/**
 * Whether this browser can DECODE H.264 at all.
 *
 * Not the same question as whether it can encode it, and the gap is real in exactly the browser
 * this suite runs in: Chromium's open-source build carries OpenH264 for encoding and no proprietary
 * decoder, so it will happily write an MP4 it cannot play. Asserting playback there would fail on a
 * file that is perfectly good, so the playback checks ask first - and say so when they skip.
 */
function canDecodeAvc(): boolean {
  const video = document.createElement('video');
  return video.canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
}

/** What a `<video>` makes of a file: its length and picture size, or null when it will not open. */
function openable(url: string): Promise<{ durationMs: number; width: number; height: number } | null> {
  return new Promise(resolve => {
    const video = document.createElement('video');
    let settled = false;
    const done = (value: { durationMs: number; width: number; height: number } | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      video.removeAttribute('src');
      video.load();
      resolve(value);
    };
    const timer = setTimeout(() => done(null), 10_000);
    video.preload = 'auto';
    video.muted = true;
    video.onloadeddata = () =>
      done({
        durationMs: Number.isFinite(video.duration) ? Math.round(video.duration * 1000) : 0,
        width: video.videoWidth,
        height: video.videoHeight,
      });
    video.onerror = () => done(null);
    video.src = url;
  });
}

function spec(uri: string, over: Partial<ComposeSpec> = {}): ComposeSpec {
  return {
    jobId: 'job-1',
    pendingPostId: 'post-1',
    clips: [{ key: 'c1', uri, inMs: 0, outMs: 500, speed: 1, volume: 1, muted: false, fit: 'contain' }],
    // Small and even: this is about the container and the pipeline, not about throughput.
    output: { width: 160, height: 284, fps: 10, videoBitrate: 800_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: { originalMuted: true, originalVolume: 1, music: null, voiceover: [] },
    posterAtMs: 100,
    ...over,
  };
}

describe('the web renderer, end to end', () => {
  it('reports honestly whether this browser can render at all', async () => {
    const support = await supportFor(720, 1280, 30);
    if (!support.supported) {
      // The one case where saying no IS the correct behaviour, and it has to say why.
      expect(support.reason.length).toBeGreaterThan(0);
      return;
    }
    expect(support.videoCodec).toMatch(/^avc1\./);
  });

  it(
    'writes an MP4 the browser itself will open',
    async ctx => {
      const support = await supportFor(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_FPS);
      needs(ctx, support.supported, support.reason);

      const blob = await makeSourceVideo('#c00');
      expect(blob.type).toBe('video/mp4');
      expect(blob.size).toBeGreaterThan(0);

      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');
      const url = URL.createObjectURL(blob);
      try {
        const opened = await openable(url);
        // The whole reason this test exists: a container only this package can read is not a
        // container.
        expect(opened).not.toBeNull();
        expect(opened?.width).toBe(SOURCE_WIDTH);
        expect(opened?.height).toBe(SOURCE_HEIGHT);
        expect(opened?.durationMs).toBeGreaterThan(500);
      } finally {
        URL.revokeObjectURL(url);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'renders a spec into a playable video with a poster',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      // A render reads its source through a `<video>`, so this case needs the decoder as well as
      // the encoder - unlike the muxer check above, which only needs bytes.
      needs(ctx, support.supported, support.reason);
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      const source = URL.createObjectURL(await makeSourceVideo('#0a0'));
      try {
        const seen: number[] = [];
        const outcome = await renderSpec(spec(source), {
          signal: new AbortController().signal,
          onProgress: progress => seen.push(progress),
        });

        expect(outcome.width).toBe(160);
        expect(outcome.height).toBe(284);
        // Half a second of source, which is what the clip asked for.
        expect(outcome.durationMs).toBe(500);
        expect(outcome.blob.size).toBeGreaterThan(0);
        // The bar moved, and it ended where it should.
        expect(seen[seen.length - 1]).toBe(1);

        const url = URL.createObjectURL(outcome.blob);
        try {
          const opened = await openable(url);
          expect(opened).not.toBeNull();
          expect(opened?.width).toBe(160);
          expect(opened?.height).toBe(284);
          // The file's own length has to be the length the result claims, or the video outlasts the
          // sound that was mixed to it.
          expect(opened?.durationMs).toBe(outcome.durationMs);
        } finally {
          URL.revokeObjectURL(url);
        }

        expect(outcome.poster).not.toBeNull();
        expect(outcome.poster?.type).toBe('image/jpeg');
      } finally {
        URL.revokeObjectURL(source);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'stops when the caller cancels',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.supported, support.reason);
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      const source = URL.createObjectURL(await makeSourceVideo('#00a'));
      const controller = new AbortController();
      try {
        const running = renderSpec(spec(source, { jobId: 'job-2' }), {
          signal: controller.signal,
          onProgress: () => controller.abort(),
        });
        await expect(running).rejects.toMatchObject({ code: 'cancelled' });
      } finally {
        URL.revokeObjectURL(source);
      }
    },
    RENDER_TIMEOUT_MS,
  );
});

describe('the painter', () => {
  /** One pixel of the finished frame, which is the only way to check geometry and colour at once. */
  function pixelAt(painter: Painter, x: number, y: number): [number, number, number] {
    const canvas = document.createElement('canvas');
    canvas.width = painter.frame.width;
    canvas.height = painter.frame.height;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('no canvas');
    ctx.drawImage(painter.frame, 0, 0);
    const data = ctx.getImageData(x, y, 1, 1).data;
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  }

  /** A solid square, standing in for a frame of video. */
  function square(colour: string, size = 100): HTMLCanvasElement {
    const canvas = document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, size, size);
    return canvas;
  }

  it('letterboxes a square source into a tall frame, and leaves the bars BLACK', () => {
    const painter = new Painter({ width: 100, height: 200 });
    // Half brightness with a red bias. Applied to the finished frame this would colour the bars;
    // applied to the picture, which is what both native engines do, it must not.
    painter.setColour({ m: [0.5, 0, 0, 0, 0.5, 0, 0, 0, 0.5], o: [0.5, 0, 0] }, { filter: 'brightness(0.5)', tints: ['rgba(255, 0, 0, 0.5)'] });
    painter.paintLayers([
      {
        source: square('#fff'),
        sourceWidth: 100,
        sourceHeight: 100,
        framing: { fit: 'contain' },
        dest: { x: 0, y: 0, w: 1, h: 1 },
        opacity: 1,
      },
    ]);

    // The middle is the picture: white through a half-strength matrix with a red bias.
    const [r, g, b] = pixelAt(painter, 50, 100);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(100);
    expect(g).toBeLessThan(170);
    expect(b).toBeGreaterThan(100);
    expect(b).toBeLessThan(170);

    // The top is a bar, and a bar is a piece of the output standing for no piece of the source.
    expect(pixelAt(painter, 50, 5)).toEqual([0, 0, 0]);
    painter.dispose();
  });

  it('puts an extra layer where its rectangle says, over the base', () => {
    const painter = new Painter({ width: 100, height: 100 });
    painter.setColour(null, { filter: 'none', tints: [] });
    painter.paintLayers([
      {
        source: square('#00f'),
        sourceWidth: 100,
        sourceHeight: 100,
        framing: { fit: 'cover' },
        dest: { x: 0, y: 0, w: 1, h: 1 },
        opacity: 1,
      },
      {
        source: square('#fff'),
        sourceWidth: 100,
        sourceHeight: 100,
        framing: { fit: 'cover' },
        // Bottom right quarter.
        dest: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
        opacity: 1,
      },
    ]);

    const [, , base] = pixelAt(painter, 25, 25);
    expect(base).toBeGreaterThan(200);
    const [r, g, b] = pixelAt(painter, 75, 75);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    painter.dispose();
  });

  it('draws an overlay at its centre, at its own size', () => {
    const painter = new Painter({ width: 100, height: 100 });
    painter.setColour(null, { filter: 'none', tints: [] });
    painter.paintLayers([]);
    painter.paintOverlay({
      bitmap: square('#ff0', 10),
      cx: 0.25,
      cy: 0.25,
      wPx: 20,
      hPx: 20,
      rotationDeg: 0,
      opacity: 1,
    });

    // Centred a quarter in, twenty pixels across: 15..35 is inside it and 50,50 is not.
    const [r, g, b] = pixelAt(painter, 25, 25);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeLessThan(60);
    expect(pixelAt(painter, 50, 50)).toEqual([0, 0, 0]);
    painter.dispose();
  });
});
