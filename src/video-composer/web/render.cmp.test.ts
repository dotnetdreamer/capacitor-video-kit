import { BufferTarget, CanvasSource, Mp4OutputFormat, Output, Quality } from 'mediabunny';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';

import { compileTransition } from '../../editor/transitions';
import type { ComposeClip, ComposeSpec } from '../definitions';

import { renderSupport, resetRenderSupport } from './capabilities';
import { Painter, isTransitionDraw, type LayerSource } from './painter';
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
    batchId: 'post-1',
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

/** Whether `event` arrived within `timeoutMs`; an `error` is a no. */
function arrives(element: HTMLMediaElement, event: string, timeoutMs: number): Promise<boolean> {
  return new Promise(resolve => {
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      element.removeEventListener(event, yes);
      element.removeEventListener('error', no);
      resolve(ok);
    };
    const yes = (): void => done(true);
    const no = (): void => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    element.addEventListener(event, yes);
    element.addEventListener('error', no);
  });
}

/**
 * One pixel of a finished file at a moment, as the browser decodes it - which is the only honest
 * way to ask what a render put in a frame. Null when the file will not open or seek.
 */
async function pixelOfVideo(url: string, seconds: number, x: number, y: number): Promise<[number, number, number] | null> {
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  const loaded = arrives(video, 'loadeddata', 10_000);
  video.src = url;
  try {
    if (!(await loaded)) return null;
    const seeked = arrives(video, 'seeked', 10_000);
    video.currentTime = seconds;
    if (!(await seeked)) return null;
    // `seeked` says the time moved, not that the frame at it has been painted; one frame callback,
    // where there is one, is the difference.
    await new Promise<void>(resolve => {
      if (typeof video.requestVideoFrameCallback !== 'function') return resolve();
      const timer = setTimeout(resolve, 200);
      video.requestVideoFrameCallback(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;
    ctx.drawImage(video, 0, 0);
    const data = ctx.getImageData(x, y, 1, 1).data;
    return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
  } finally {
    video.removeAttribute('src');
    video.load();
  }
}

/** A solid-colour PNG, as a picture a customer might put on the timeline. */
async function makePicture(colour: string, width = 90, height = 120): Promise<Blob> {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  ctx.fillStyle = colour;
  ctx.fillRect(0, 0, width, height);
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
  if (!blob) throw new Error('no picture');
  return blob;
}

describe('a picture on the timeline, end to end', () => {
  it(
    'holds the picture for its segment between two moments of video, and runs the whole post',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.supported, support.reason);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      const green = URL.createObjectURL(await makeSourceVideo('#0f0'));
      const blue = URL.createObjectURL(await makePicture('#00f'));
      try {
        // Half a second of green video, then a second of the blue picture - sent as `toComposeSpec`
        // sends one: from 0, silent, at 1x. Filled, so the frame is the picture's edge to edge.
        const video: ComposeClip = { key: 'v', uri: green, inMs: 0, outMs: 500, speed: 1, volume: 1, muted: false, fit: 'cover' };
        const picture: ComposeClip = { key: 'p', uri: blue, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: true, fit: 'cover', image: true };
        const outcome = await renderSpec(spec(green, { jobId: 'job-picture', clips: [video, picture] }), {
          signal: new AbortController().signal,
          onProgress: () => undefined,
        });

        // The picture's length is its own, never clamped against a probed one it does not have.
        expect(outcome.durationMs).toBe(1500);

        const url = URL.createObjectURL(outcome.blob);
        try {
          const onVideo = await pixelOfVideo(url, 0.25, 80, 142);
          const onPicture = await pixelOfVideo(url, 1.0, 80, 142);
          expect(onVideo).not.toBeNull();
          expect(onPicture).not.toBeNull();
          // Green, then blue: the picture is drawn where its segment is and nowhere else.
          expect(onVideo![1]).toBeGreaterThan(150);
          expect(onVideo![2]).toBeLessThan(90);
          expect(onPicture![2]).toBeGreaterThan(150);
          expect(onPicture![1]).toBeLessThan(90);
        } finally {
          URL.revokeObjectURL(url);
        }
      } finally {
        URL.revokeObjectURL(green);
        URL.revokeObjectURL(blue);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'fails naming the clip when a picture will not decode, as a video that will not open does',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.supported, support.reason);

      const broken = URL.createObjectURL(new Blob(['not a picture'], { type: 'image/png' }));
      try {
        const picture: ComposeClip = { key: 'p', uri: broken, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: true, fit: 'cover', image: true };
        await expect(
          renderSpec(spec(broken, { jobId: 'job-broken-picture', clips: [picture] }), {
            signal: new AbortController().signal,
            onProgress: () => undefined,
          }),
        ).rejects.toMatchObject({ code: 'unreadable_input', clipKey: 'p' });
      } finally {
        URL.revokeObjectURL(broken);
      }
    },
    RENDER_TIMEOUT_MS,
  );
});

describe('a transition, end to end', () => {
  it(
    'dissolves one clip into the next in the finished file, and runs the lowered length',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.supported, support.reason);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      const red = URL.createObjectURL(await makeSourceVideo('#f00'));
      const blue = URL.createObjectURL(await makeSourceVideo('#00f'));
      try {
        /*
         * A second of red, then a second of blue, with a 400 ms dissolve between them - lowered the
         * way `compose.ts` lowers it: red is sent stopping at 600, where blue starts, and its last
         * 400 ms travel on blue as the transition's tail. The post is 1600 ms, not 2000.
         */
        const redClip: ComposeClip = { key: 'red', uri: red, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'contain' };
        const dissolve = JSON.parse(JSON.stringify(compileTransition('dissolve'))) as NonNullable<ReturnType<typeof compileTransition>>;
        const outcome = await renderSpec(
          spec(red, {
            jobId: 'job-transition',
            clips: [
              { ...redClip, outMs: 600 },
              { ...redClip, key: 'blue', uri: blue, transitionIn: { ...dissolve, from: { ...redClip, inMs: 600 } } },
            ],
          }),
          { signal: new AbortController().signal, onProgress: () => {} },
        );
        expect(outcome.durationMs).toBe(1600);

        const url = URL.createObjectURL(outcome.blob);
        try {
          const opened = await openable(url);
          expect(opened?.durationMs).toBe(1600);

          // The 160x120 picture sits in the middle of the 160x284 frame; this is its centre.
          const at = (seconds: number) => pixelOfVideo(url, seconds, 80, 142);

          // At 10 fps the frame drawn at 800 ms is the one exactly halfway through the window, where
          // a dissolve is half of each. H.264 is lossy, so "half" is a wide band either side of 128 -
          // and still nowhere near the pure red or pure blue a cut, or a window in the wrong place,
          // would leave there.
          const middle = await at(0.85);
          expect(middle).not.toBeNull();
          const [r, g, b] = middle!;
          expect(r).toBeGreaterThan(70);
          expect(r).toBeLessThan(190);
          expect(b).toBeGreaterThan(70);
          expect(b).toBeLessThan(190);
          expect(g).toBeLessThan(60);

          // Before the window, red alone; after it, blue alone.
          const before = await at(0.35);
          expect(before?.[0]).toBeGreaterThan(200);
          expect(before?.[2]).toBeLessThan(60);
          const after = await at(1.35);
          expect(after?.[2]).toBeGreaterThan(200);
          expect(after?.[0]).toBeLessThan(60);
        } finally {
          URL.revokeObjectURL(url);
        }
      } finally {
        URL.revokeObjectURL(red);
        URL.revokeObjectURL(blue);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'gives each element’s texture back as its reader lets go of it, rather than holding all of them to the end',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.supported, support.reason);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      const red = URL.createObjectURL(await makeSourceVideo('#f00'));
      const blue = URL.createObjectURL(await makeSourceVideo('#00f'));
      const forget = vi.spyOn(Painter.prototype, 'forget');
      const paint = vi.spyOn(Painter.prototype, 'paintLayers');
      try {
        // The dissolve above: red to 600, blue from 600, red's tail under blue until 1000, and blue
        // alone for the 600 ms after that.
        const redClip: ComposeClip = { key: 'red', uri: red, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'contain' };
        const dissolve = JSON.parse(JSON.stringify(compileTransition('dissolve'))) as NonNullable<ReturnType<typeof compileTransition>>;
        await renderSpec(
          spec(red, {
            jobId: 'job-textures',
            clips: [
              { ...redClip, outMs: 600 },
              { ...redClip, key: 'blue', uri: blue, transitionIn: { ...dissolve, from: { ...redClip, inMs: 600 } } },
            ],
          }),
          { signal: new AbortController().signal, onProgress: () => {} },
        );

        const drawn = new Set<LayerSource>();
        for (const [layers] of paint.mock.calls) {
          for (const layer of layers) {
            if (!isTransitionDraw(layer)) drawn.add(layer.source);
            else for (const side of [layer.from, layer.to]) if (side) drawn.add(side.source);
          }
        }
        // Three elements: the base track's on red, the base track's on blue, and the tail's.
        expect(drawn.size).toBe(3);
        // Every one of them is forgotten, and all but the base track's last - still on screen when
        // the final frame is drawn - while there were still frames to draw.
        const forgotten = forget.mock.calls.map(([source]) => source);
        expect([...drawn].every(source => forgotten.includes(source))).toBe(true);
        const lastPaint = paint.mock.invocationCallOrder.at(-1) ?? 0;
        const early = forget.mock.calls.filter((_, i) => (forget.mock.invocationCallOrder[i] ?? Infinity) < lastPaint);
        expect(new Set(early.map(([source]) => source)).size).toBe(2);
      } finally {
        forget.mockRestore();
        paint.mockRestore();
        URL.revokeObjectURL(red);
        URL.revokeObjectURL(blue);
      }
    },
    RENDER_TIMEOUT_MS,
  );

  it(
    'crossfades the sound across the same window, linearly both ways',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
      needs(ctx, support.audioCodec.length > 0, 'this browser encodes no audio');
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      // Sound-only clips: a <video> opens a WAV and gives it no picture, so the frames are black and
      // everything under test is in the audio track. One clip is a tone and the other silence, so
      // whichever of the two fades is the only thing to be heard.
      const tone = URL.createObjectURL(makeTone(1, 440));
      const silence = URL.createObjectURL(makeTone(1, 440, 48_000, 0));
      const dissolve = JSON.parse(JSON.stringify(compileTransition('dissolve'))) as NonNullable<ReturnType<typeof compileTransition>>;

      /** The loudness, as RMS, of the finished file between two moments of it. */
      async function loudness(outgoing: string, incoming: string): Promise<(fromMs: number, toMs: number) => number> {
        const a: ComposeClip = { key: 'a', uri: outgoing, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'contain' };
        const outcome = await renderSpec(
          spec(outgoing, {
            jobId: `job-crossfade-${outgoing === tone ? 'out' : 'in'}`,
            clips: [
              { ...a, outMs: 600 },
              { ...a, key: 'b', uri: incoming, transitionIn: { ...dissolve, from: { ...a, inMs: 600 } } },
            ],
            audio: { originalMuted: false, originalVolume: 1, music: null, voiceover: [] },
          }),
          { signal: new AbortController().signal, onProgress: () => {} },
        );
        expect(outcome.hasAudio).toBe(true);
        const decoded = await new OfflineAudioContext(2, 1, 48_000).decodeAudioData(await outcome.blob.arrayBuffer());
        const channel = decoded.getChannelData(0);
        return (fromMs, toMs) => {
          const from = Math.round((fromMs / 1000) * decoded.sampleRate);
          const to = Math.min(channel.length, Math.round((toMs / 1000) * decoded.sampleRate));
          let sum = 0;
          for (let i = from; i < to; i++) sum += (channel[i] ?? 0) ** 2;
          return Math.sqrt(sum / Math.max(1, to - from));
        };
      }

      try {
        // The window is 600..1000 ms. A linear fade out runs 1 -> 0 across it, so its first quarter
        // is about three quarters as loud as before it and its last quarter about a quarter - with
        // room either side for AAC and for the encoder's own priming delay.
        const out = await loudness(tone, silence);
        const full = out(250, 550);
        expect(full).toBeGreaterThan(0.3);
        expect(out(650, 750) / full).toBeGreaterThan(0.5);
        expect(out(650, 750) / full).toBeLessThan(0.92);
        expect(out(850, 950) / full).toBeGreaterThan(0.05);
        expect(out(850, 950) / full).toBeLessThan(0.45);
        expect(out(1100, 1500) / full).toBeLessThan(0.05);

        // ...and the incoming clip fades in across the same window, the mirror image.
        const into = await loudness(silence, tone);
        const after = into(1100, 1500);
        expect(after).toBeGreaterThan(0.3);
        expect(into(250, 550) / after).toBeLessThan(0.05);
        expect(into(650, 750) / after).toBeGreaterThan(0.05);
        expect(into(650, 750) / after).toBeLessThan(0.45);
        expect(into(850, 950) / after).toBeGreaterThan(0.5);
        expect(into(850, 950) / after).toBeLessThan(0.92);
      } finally {
        URL.revokeObjectURL(tone);
        URL.revokeObjectURL(silence);
      }
    },
    RENDER_TIMEOUT_MS,
  );
});

/** A tone as a WAV, which `decodeAudioData` reads on every browser. Stands in for a music track. */
function makeTone(seconds: number, hz: number, rate = 48_000, level = 20_000): Blob {
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
    view.setInt16(44 + i * 2, Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * level), true);
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

  it('draws NOTHING outside a crop - the part cropped away is not a letterbox bar', () => {
    /*
     * A window is worked out so the KEPT picture lands on the destination rectangle, and it goes on
     * mapping past that rectangle in both directions. What lies immediately outside it is the part
     * of the source the customer just cropped away, and a sampler bounded only by the SOURCE drew
     * it - so a clip cropped to half its height came out showing the other half in its own bars,
     * in the preview and in the finished file alike. The crop tool was the one place it was
     * unmissable: the window said one thing and the picture said another.
     */
    const painter = new Painter({ width: 100, height: 200 });
    painter.setColour(null, { filter: 'none', tints: [] });
    // A source with a WHITE top half and a grey bottom half, cropped to the bottom half alone.
    const source = square('#808080', 100);
    const ctx = source.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, 100, 50);

    painter.paintLayers([
      {
        source,
        sourceWidth: 100,
        sourceHeight: 100,
        framing: { fit: 'contain', crop: { x: 0, y: 0.5, w: 1, h: 0.5 } },
        dest: { x: 0, y: 0, w: 1, h: 1 },
        opacity: 1,
      },
    ]);

    // The kept half is 2:1, so on a 100x200 frame it lands 100 wide and 50 tall, centred: y 75..125.
    const [r, g, b] = pixelAt(painter, 50, 100);
    expect(r).toBeGreaterThan(100);
    expect(r).toBeLessThan(160);
    expect(g).toBe(r);
    expect(b).toBe(r);

    // Above and below that band is a BAR. The half that was cropped away is white, so drawing it
    // there is the exact failure, and black is the only right answer.
    expect(pixelAt(painter, 50, 40)).toEqual([0, 0, 0]);
    expect(pixelAt(painter, 50, 160)).toEqual([0, 0, 0]);
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

  it('turns a layer about its rectangle, in OUTPUT PIXELS rather than in fractions', () => {
    // A frame that is not square, which is the whole of the trap: an angle applied in 0..1
    // coordinates shears a rectangle, and 100x200 is far enough from square for it to show.
    const painter = new Painter({ width: 100, height: 200 });
    painter.setColour(null, { filter: 'none', tints: [] });
    painter.paintLayers([
      {
        source: square('#fff'),
        sourceWidth: 100,
        sourceHeight: 100,
        framing: { fit: 'cover' },
        // 40 x 30 pixels, centred at (50, 85). Turned a quarter, that is 30 x 40 about the same
        // point: x 35..65, y 65..105.
        dest: { x: 0.3, y: 0.35, w: 0.4, h: 0.15 },
        opacity: 1,
        rotationDeg: 90,
      },
    ]);

    // Inside the turned rectangle and OUTSIDE the upright one, which is what says it turned at all.
    const [r, g, b] = pixelAt(painter, 50, 68);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeGreaterThan(200);
    expect(b).toBeGreaterThan(200);
    // Where the upright rectangle reached and the turned one does not.
    expect(pixelAt(painter, 32, 85)).toEqual([0, 0, 0]);
    // The two that separate a turn in PIXELS from a turn in fractions. Turned in normalised space,
    // this layer would come out 15 x 80 pixels rather than 30 x 40 - narrower here, taller there.
    expect(pixelAt(painter, 60, 85)[0]).toBeGreaterThan(200);
    expect(pixelAt(painter, 50, 110)).toEqual([0, 0, 0]);
    painter.dispose();
  });

  it("cuts a base-track clip at its RECTANGLE, which fitting it COVER makes it overflow", () => {
    // A square source into a rectangle half the frame wide and half of it tall, on a frame that is
    // not square: fitted `cover`, the picture is 50 across and 50 down inside a rectangle that is
    // 50 by 25, so 12 or so of it hangs over each side. Every engine cuts it at the rectangle, and
    // the browser one did not: its destination is the WHOLE FRAME - a base clip's rectangle is
    // folded into the source window rather than becoming a quad - and the only edge the sampler
    // knows about on its own is the source's.
    const painter = new Painter({ width: 100, height: 100 });
    painter.setColour(null, { filter: 'none', tints: [] });
    painter.paintLayers([
      {
        source: square('#fff'),
        sourceWidth: 100,
        sourceHeight: 100,
        framing: { fit: 'cover', rect: { x: 0.25, y: 0.375, w: 0.5, h: 0.25 } },
        dest: { x: 0, y: 0, w: 1, h: 1 },
        opacity: 1,
      },
    ]);

    // Inside the rectangle: the picture.
    expect(pixelAt(painter, 50, 50)[0]).toBeGreaterThan(200);
    // Just past its top and bottom edges, where the overflow would have landed.
    expect(pixelAt(painter, 50, 33)).toEqual([0, 0, 0]);
    expect(pixelAt(painter, 50, 66)).toEqual([0, 0, 0]);
    painter.dispose();
  });

  it("turns a base-track clip about its RECTANGLE's centre, not the frame's", () => {
    const painter = new Painter({ width: 100, height: 100 });
    painter.setColour(null, { filter: 'none', tints: [] });
    painter.paintLayers([
      {
        source: square('#fff'),
        sourceWidth: 100,
        sourceHeight: 100,
        // The base track's rectangle stays in the FRAMING and its destination is the whole frame,
        // so the pivot cannot be read off `dest`: this rectangle's centre is (25, 25), the frame's
        // is (50, 50), and a half turn about the wrong one moves the picture to the far corner.
        framing: { fit: 'cover', rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
        dest: { x: 0, y: 0, w: 1, h: 1 },
        opacity: 1,
        rotationDeg: 180,
      },
    ]);

    // A half turn about its own centre is the rectangle it started in.
    expect(pixelAt(painter, 25, 25)[0]).toBeGreaterThan(200);
    expect(pixelAt(painter, 75, 75)).toEqual([0, 0, 0]);
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

  it('lets go of a source’s texture when told to, and makes a new one if the source comes back', ctx => {
    const painter = new Painter({ width: 100, height: 100 });
    needs(ctx, painter.usesGpu, 'this browser gives the painter no WebGL2, so it keeps no textures');
    painter.setColour(null, { filter: 'none', tints: [] });
    const created = vi.spyOn(WebGL2RenderingContext.prototype, 'createTexture');
    const deleted = vi.spyOn(WebGL2RenderingContext.prototype, 'deleteTexture');
    try {
      const source = square('#f00');
      const layer = { source, sourceWidth: 100, sourceHeight: 100, framing: { fit: 'contain' as const }, dest: { x: 0, y: 0, w: 1, h: 1 }, opacity: 1 };
      painter.paintLayers([layer]);
      painter.paintLayers([layer]);
      // One texture a source, kept from frame to frame.
      expect(created).toHaveBeenCalledTimes(1);

      painter.forget(source);
      expect(deleted).toHaveBeenCalledTimes(1);
      expect(deleted.mock.calls[0]?.[0]).toBe(created.mock.results[0]?.value);
      // A second time has nothing left to let go of.
      painter.forget(source);
      expect(deleted).toHaveBeenCalledTimes(1);

      painter.paintLayers([layer]);
      expect(created).toHaveBeenCalledTimes(2);
      expect(pixelAt(painter, 50, 50)).toEqual([255, 0, 0]);
    } finally {
      created.mockRestore();
      deleted.mockRestore();
      painter.dispose();
    }
  });
});

describe('a zoom, end to end', () => {
  /** A picture in four coloured quarters - TL red, TR green, BL blue, BR white - at the output's shape. */
  async function quartered(width: number, height: number): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no canvas');
    for (const [x, y, colour] of [
      [0, 0, '#f00'],
      [0.5, 0, '#0f0'],
      [0, 0.5, '#00f'],
      [0.5, 0.5, '#fff'],
    ] as const) {
      ctx.fillStyle = colour;
      ctx.fillRect(x * width, y * height, width / 2, height / 2);
    }
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('no picture');
    return blob;
  }

  it(
    'magnifies the area the camera is on from the moment it starts, and not before',
    async ctx => {
      const support = await supportFor(160, 284, 10);
      needs(ctx, support.supported, support.reason);
      needs(ctx, support.engine === 'webcodecs', 'the fixture needs a WebCodecs encoder');
      needs(ctx, canDecodeAvc(), 'this browser cannot decode H.264');

      const uri = URL.createObjectURL(await quartered(160, 284));
      try {
        const picture: ComposeClip = { key: 'p', uri, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: true, fit: 'cover', image: true };
        // The whole frame until half a second, then - a step - 2x on the top-left quarter.
        const camera = { atMs: [0, 500, 500], scale: [1, 1, 2], cx: [0.5, 0.5, 0.25], cy: [0.5, 0.5, 0.25] };
        const outcome = await renderSpec(spec(uri, { jobId: 'job-zoom', clips: [picture], camera }), {
          signal: new AbortController().signal,
          onProgress: () => undefined,
        });
        const url = URL.createObjectURL(outcome.blob);
        try {
          const before = await pixelOfVideo(url, 0.25, 120, 213);
          const after = await pixelOfVideo(url, 0.75, 120, 213);
          expect(before).not.toBeNull();
          expect(after).not.toBeNull();
          // Unzoomed, the bottom right is the white quarter.
          expect(Math.min(...before!)).toBeGreaterThan(180);
          // Zoomed on the top-left quarter, the bottom right of the frame is red.
          expect(after![0]).toBeGreaterThan(150);
          expect(after![1]).toBeLessThan(90);
          expect(after![2]).toBeLessThan(90);
        } finally {
          URL.revokeObjectURL(url);
        }
      } finally {
        URL.revokeObjectURL(uri);
      }
    },
    RENDER_TIMEOUT_MS,
  );
});
