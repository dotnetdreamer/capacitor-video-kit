import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';

import type { ComposeSpec } from '../definitions';

import { renderSupport, resetRenderSupport } from './capabilities';
import { Painter } from './painter';
import { renderSpec } from './render';

/**
 * The renderer, in a real browser, end to end.
 *
 * Everything else about the web engine is pinned by unit tests over pure functions, and two things
 * cannot be: whether the file that comes out is a file a player will OPEN, and whether the frames in
 * it are the frames the geometry says. Both are answered here by handing the output back to the
 * browser and by reading pixels off the painter.
 *
 * The source footage is made with the same library the renderer muxes through, so the container is
 * round-tripped through the browser's own demuxer rather than only through the code that wrote it.
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
 * not do, and a suite of those is worse than no suite: it says the renderer works on a machine where
 * it was never run. `ctx.skip()` puts the reason in the report instead.
 */
function needs(ctx: TestContext, able: boolean, why: string): void {
  if (!able) ctx.skip(why);
}

/** A short solid-colour MP4, muxed the way the renderer muxes one. */
async function makeSourceVideo(colour: string): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = SOURCE_WIDTH;
  canvas.height = SOURCE_HEIGHT;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');

  const output = new Output({
    format: new Mp4OutputFormat({ fastStart: 'in-memory' }),
    target: new BufferTarget(),
  });
  const source = new CanvasSource(canvas, {
    codec: 'avc',
    quality: new Quality({ bitrate: 1_000_000 }),
  });
  output.addVideoTrack(source);
  await output.start();

  for (let i = 0; i < SOURCE_FRAMES; i++) {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, SOURCE_WIDTH, SOURCE_HEIGHT);
    await source.add(i / SOURCE_FPS, 1 / SOURCE_FPS);
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('no fixture');
  return new Blob([buffer], { type: 'video/mp4' });
}

/**
 * Whether this browser can DECODE H.264 at all.
 *
 * Not the same question as whether it can encode it, and the gap is real: an open-source Chromium
 * build can carry an encoder and no proprietary decoder, so it will happily write an MP4 it cannot
 * play. Asserting playback there would fail on a file that is perfectly good.
 */
function canDecodeAvc(): boolean {
  return document.createElement('video').canPlayType('video/mp4; codecs="avc1.42E01E"') !== '';
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
  it('reports honestly which engine this browser gets', async () => {
    const support = await supportFor(720, 1280, 30);
    if (!support.supported) {
      // The one case where saying no IS the correct behaviour, and it has to say why.
      expect(support.reason.length).toBeGreaterThan(0);
      expect(support.engine).toBe('none');
      return;
    }
    expect(['webcodecs', 'recorder']).toContain(support.engine);
    expect(['mp4', 'webm']).toContain(support.container);
    expect(support.videoCodec.length).toBeGreaterThan(0);
  });

  it(
    'writes a file the browser itself will open',
    async ctx => {
      const support = await supportFor(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_FPS);
      needs(ctx, support.supported, support.reason);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');

      const blob = await makeSourceVideo('#c00');
      expect(blob.size).toBeGreaterThan(0);

      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');
      const url = URL.createObjectURL(blob);
      try {
        const opened = await openable(url);
        // A container only this package can read is not a container.
        expect(opened).not.toBeNull();
        expect(opened?.width).toBe(SOURCE_WIDTH);
        expect(opened?.height).toBe(SOURCE_HEIGHT);
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
      // A render reads its source through a decoder, so this case needs one as well as an encoder.
      needs(ctx, support.supported, support.reason);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
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
        expect(outcome.mimeType).toBe('video/mp4');
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
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
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

/** A tone as a WAV, which `decodeAudioData` reads on every browser. Stands in for a music track. */
function makeTone(seconds: number, hz: number, rate = 48_000): Blob {
  const frames = Math.round(seconds * rate);
  const buffer = new ArrayBuffer(44 + frames * 2);
  const view = new DataView(buffer);
  const ascii = (at: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(at + i, text.charCodeAt(i));
  };
  ascii(0, 'RIFF');
  view.setUint32(4, 36 + frames * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, frames * 2, true);
  for (let i = 0; i < frames; i++) {
    // 0.61 of full scale, so the volume the spec asks for is visible in what comes back.
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 20_000), true);
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

describe('the soundtrack, through the container and back', () => {
  it(
    'muxes an audio track the browser can decode, at the volume and with the fade asked for',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
      needs(ctx, support.audioCodec.length > 0, 'this browser encodes no audio');
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      const source = URL.createObjectURL(await makeSourceVideo('#333'));
      const music = URL.createObjectURL(makeTone(2, 440));
      try {
        const outcome = await renderSpec(
          spec(source, {
            jobId: 'job-audio',
            clips: [{ ...spec(source).clips[0]!, outMs: 800 }],
            audio: {
              originalMuted: true,
              originalVolume: 1,
              voiceover: [],
              music: {
                uri: music,
                startMs: 0,
                inMs: 0,
                outMs: 2000,
                volume: 0.8,
                loop: true,
                fadeInMs: 0,
                fadeOutMs: 300,
              },
            },
          }),
          { signal: new AbortController().signal, onProgress: () => {} },
        );
        expect(outcome.hasAudio).toBe(true);

        // Decoding the FINISHED file is the check: an audio track the browser cannot read is a
        // sample description nobody can read, however well the bytes were written.
        const context = new OfflineAudioContext(2, 1, 48_000);
        const decoded = await context.decodeAudioData(await outcome.blob.arrayBuffer());
        expect(decoded.numberOfChannels).toBe(2);

        const channel = decoded.getChannelData(0);
        let peak = 0;
        for (let i = 0; i < channel.length; i++) peak = Math.max(peak, Math.abs(channel[i] ?? 0));
        // 0.8 of a tone at 0.61 of full scale is 0.49, and AAC is lossy but not by much.
        expect(peak).toBeGreaterThan(0.35);
        expect(peak).toBeLessThan(0.65);

        // The last few per cent carry the fade out, so they have to be quieter than the peak.
        let tail = 0;
        for (let i = Math.floor(channel.length * 0.97); i < channel.length; i++) {
          tail = Math.max(tail, Math.abs(channel[i] ?? 0));
        }
        expect(tail).toBeLessThan(peak * 0.5);
      } finally {
        URL.revokeObjectURL(source);
        URL.revokeObjectURL(music);
      }
    },
    RENDER_TIMEOUT_MS,
  );
});

describe('the MediaRecorder fallback', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    resetRenderSupport();
  });

  /**
   * Hides WebCodecs, which is the only way to exercise the fallback in a browser that has it.
   *
   * Worth doing rather than trusting: this path exists for the browsers this suite will never run
   * in, so if it is not tested here it is not tested anywhere, and "we have a fallback" would be a
   * claim rather than a fact.
   */
  function withoutWebCodecs(): void {
    vi.stubGlobal('VideoEncoder', undefined);
    vi.stubGlobal('AudioEncoder', undefined);
    resetRenderSupport();
  }

  it('is what a browser without WebCodecs gets, rather than a refusal', async () => {
    withoutWebCodecs();
    const support = await renderSupport(160, 284, 10);
    if (typeof MediaRecorder === 'undefined') {
      expect(support.supported).toBe(false);
      return;
    }
    expect(support.supported).toBe(true);
    expect(support.engine).toBe('recorder');
    expect(support.recorderMimeType.length).toBeGreaterThan(0);
  });

  it(
    'records a real video, in real time',
    async ctx => {
      // The fixture is made first, while the encoder is still there to make it with.
      const encoderSupport = await supportFor(SOURCE_WIDTH, SOURCE_HEIGHT, SOURCE_FPS);
      needs(ctx, encoderSupport.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');
      needs(ctx, typeof MediaRecorder !== 'undefined', 'this browser has no MediaRecorder');
      const source = URL.createObjectURL(await makeSourceVideo('#a0a'));

      withoutWebCodecs();
      const support = await renderSupport(160, 284, 10);
      needs(ctx, support.engine === 'recorder', 'the fallback did not take over');

      try {
        const started = performance.now();
        const outcome = await renderSpec(
          // Deliberately short: this one runs at the speed the video plays, and a test is not the
          // place to prove that a thirty-second post takes thirty seconds.
          spec(source, { jobId: 'job-rec', clips: [{ ...spec(source).clips[0]!, outMs: 300 }] }),
          { signal: new AbortController().signal, onProgress: () => {} },
        );
        const elapsed = performance.now() - started;

        expect(outcome.blob.size).toBeGreaterThan(0);
        expect(outcome.mimeType).toMatch(/^video\/(mp4|webm)/);
        expect(outcome.durationMs).toBe(300);
        // Real time is the cost, and it is the one behaviour that separates this engine from the
        // other: 300 ms of video cannot have been recorded in 50.
        expect(elapsed).toBeGreaterThan(250);

        const url = URL.createObjectURL(outcome.blob);
        try {
          const opened = await openable(url);
          expect(opened).not.toBeNull();
          expect(opened?.width).toBe(160);
          expect(opened?.height).toBe(284);
        } finally {
          URL.revokeObjectURL(url);
        }
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

  it('draws a layer that hangs off the frame, cut off at the edge', () => {
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
        // Half a frame wide, dragged so that half of IT is off the left edge: a quarter of the
        // output is covered and the rest of the layer is simply not there.
        dest: { x: -0.25, y: 0.25, w: 0.5, h: 0.5 },
        opacity: 1,
      },
    ]);

    // Inside the part that landed: white.
    const [r, g, b] = pixelAt(painter, 10, 50);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    // Past the layer's right edge, which is a quarter of the way across: the base shows.
    const [, , base] = pixelAt(painter, 40, 50);
    expect(base).toBeGreaterThan(200);
    expect(pixelAt(painter, 40, 50)[0]).toBeLessThan(60);
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
