import { BufferTarget, CanvasSource, Output, Quality, WebMOutputFormat } from 'mediabunny';
import { afterEach, describe, expect, it, vi, type TestContext } from 'vitest';

import { GpuFrame, Painter, WHOLE_FRAME, type LayerDraw, type LayerSource } from './painter';

/**
 * The frames the live preview HOLDS of a slowed clip - `Painter.copyFrame` - made by the real painter
 * from a real playing-kind element, on the GPU and on the 2D fallback, and read back in pixels.
 *
 * What is pinned:
 *
 *  - a copy is the picture the element showed when it was made, and stays that picture after the
 *    element has moved on - which is the whole point of holding one;
 *  - two copies blend exactly as any pair of frames does (`LayerDraw.tween`);
 *  - on the GPU a copy is a texture ([GpuFrame]) that only its own painter can draw, and one that has
 *    been let go of is left out of a frame rather than sending the painter down the 2D path for good.
 *
 * The fixture is WebM/VP8 rather than MP4, because an open-source Chromium can decode no H.264.
 */

const W = 64;
const H = 64;
const RED: [number, number, number] = [255, 0, 0];
const BLUE: [number, number, number] = [0, 0, 255];

/** Two seconds: red for the first, blue for the second. */
async function redThenBlue(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('no canvas');
  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const source = new CanvasSource(canvas, { codec: 'vp8', quality: new Quality({ bitrate: 500_000 }) });
  output.addVideoTrack(source);
  await output.start();
  for (const [i, colour] of ['#f00', '#00f'].entries()) {
    ctx.fillStyle = colour;
    ctx.fillRect(0, 0, W, H);
    await source.add(i, 1);
  }
  await output.finalize();
  const buffer = (output.target as BufferTarget).buffer;
  if (!buffer) throw new Error('no fixture');
  return URL.createObjectURL(new Blob([buffer], { type: 'video/webm' }));
}

const opened: { video: HTMLVideoElement; url: string }[] = [];

async function element(): Promise<HTMLVideoElement> {
  const url = await redThenBlue();
  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
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

async function seekTo(video: HTMLVideoElement, seconds: number): Promise<void> {
  const seeked = new Promise<void>(resolve => video.addEventListener('seeked', () => resolve(), { once: true }));
  video.currentTime = seconds;
  await seeked;
}

afterEach(() => {
  for (const { video, url } of opened.splice(0)) {
    video.removeAttribute('src');
    video.load();
    video.remove();
    URL.revokeObjectURL(url);
  }
});

function canPlayVp8(): boolean {
  return document.createElement('video').canPlayType('video/webm; codecs="vp8"') !== '';
}

/** The painter, with or without its GPU; without is how the 2D fallback is reached here. */
function painterFor(gpu: boolean): Painter {
  let painter: Painter;
  if (gpu) {
    painter = new Painter({ width: W, height: H });
  } else {
    const real = HTMLCanvasElement.prototype.getContext;
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string, options?: unknown) {
      return type === 'webgl2' ? null : (real as (this: HTMLCanvasElement, type: string, options?: unknown) => RenderingContext | null).call(this, type, options);
    } as typeof real);
    try {
      painter = new Painter({ width: W, height: H });
    } finally {
      spy.mockRestore();
    }
  }
  painter.setColour(null, { filter: 'none', tints: [] });
  return painter;
}

function layer(source: LayerSource, over: Partial<LayerDraw> = {}): LayerDraw {
  return { source, sourceWidth: W, sourceHeight: H, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1, ...over };
}

/** The colour at the middle of the painter's frame after drawing `draw`. */
function paintedCentre(painter: Painter, draw: LayerDraw): [number, number, number] {
  painter.paintLayers([draw]);
  const canvas = document.createElement('canvas');
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('no canvas');
  ctx.drawImage(painter.frame, 0, 0);
  const data = ctx.getImageData(W / 2, H / 2, 1, 1).data;
  return [data[0] ?? 0, data[1] ?? 0, data[2] ?? 0];
}

/** VP8 is 4:2:0 and lossy: a solid colour comes back within a few steps of itself. */
function near(actual: [number, number, number], expected: [number, number, number], tolerance = 24): void {
  for (let c = 0; c < 3; c++) expect(Math.abs(actual[c]! - expected[c]!), `channel ${c} of [${actual}] against [${expected}]`).toBeLessThanOrEqual(tolerance);
}

for (const gpu of [true, false]) {
  describe(`a held frame, ${gpu ? 'on the GPU' : 'on the 2D fallback'}`, () => {
    it('is the picture the element showed when it was copied, after the element has moved on', async (ctx: TestContext) => {
      if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
      const video = await element();
      const painter = painterFor(gpu);
      try {
        if (gpu && !painter.usesGpu) ctx.skip('no WebGL2 here');
        await seekTo(video, 0.5);
        const copy = painter.copyFrame(video);
        expect(copy).not.toBeNull();
        expect(copy instanceof GpuFrame).toBe(gpu);
        expect([copy!.width, copy!.height]).toEqual([W, H]);
        await seekTo(video, 1.5);
        near(paintedCentre(painter, layer(copy!)), RED);
        near(paintedCentre(painter, layer(video)), BLUE);
        // And the copy did not send the painter anywhere: it is still on the path it started on.
        expect(painter.usesGpu).toBe(gpu);
      } finally {
        painter.dispose();
      }
    }, 30_000);

    it('blends with another copy exactly as two frames do', async (ctx: TestContext) => {
      if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
      const video = await element();
      const painter = painterFor(gpu);
      try {
        if (gpu && !painter.usesGpu) ctx.skip('no WebGL2 here');
        await seekTo(video, 0.5);
        const red = painter.copyFrame(video)!;
        await seekTo(video, 1.5);
        const blue = painter.copyFrame(video)!;
        near(paintedCentre(painter, layer(red, { tween: { source: blue, weight: 0.5 } })), [128, 0, 128]);
        near(paintedCentre(painter, layer(red, { tween: { source: blue, weight: 1 } })), BLUE);
      } finally {
        painter.dispose();
      }
    }, 30_000);
  });
}

describe('a held frame on the GPU, let go of', () => {
  it('can no longer be drawn, is left out of the frame, and does not send the painter to 2D', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const video = await element();
    const painter = painterFor(true);
    try {
      if (!painter.usesGpu) ctx.skip('no WebGL2 here');
      await seekTo(video, 0.5);
      const copy = painter.copyFrame(video)!;
      expect(painter.canDraw(copy)).toBe(true);
      painter.releaseFrame(copy);
      expect(painter.canDraw(copy)).toBe(false);
      // Left out: the frame is the black under every layer.
      near(paintedCentre(painter, layer(copy)), [0, 0, 0], 2);
      expect(painter.usesGpu).toBe(true);
      // A B that has gone is no B: A alone.
      const a = painter.copyFrame(video)!;
      near(paintedCentre(painter, layer(a, { tween: { source: copy, weight: 0.5 } })), RED);
      expect(painter.usesGpu).toBe(true);
      // Released twice, or by a painter that never made it: nothing happens.
      painter.releaseFrame(copy);
      // A texture given back is filled with the NEW picture when the next copy takes it...
      painter.releaseFrame(a);
      await seekTo(video, 1.5);
      const next = painter.copyFrame(video)!;
      near(paintedCentre(painter, layer(next)), BLUE);
      // ...and a copy still held keeps its own picture however many are made after it.
      await seekTo(video, 0.5);
      const held = painter.copyFrame(video)!;
      await seekTo(video, 1.5);
      painter.copyFrame(video);
      painter.copyFrame(video);
      near(paintedCentre(painter, layer(held)), RED);
      near(paintedCentre(painter, layer(next)), BLUE);
    } finally {
      painter.dispose();
    }
  }, 30_000);

  it('belongs to the painter that made it', async (ctx: TestContext) => {
    if (!canPlayVp8()) ctx.skip('this browser cannot play VP8');
    const video = await element();
    const maker = painterFor(true);
    const other = painterFor(true);
    try {
      if (!maker.usesGpu || !other.usesGpu) ctx.skip('no WebGL2 here');
      await seekTo(video, 0.5);
      const copy = maker.copyFrame(video)!;
      expect(other.canDraw(copy)).toBe(false);
      other.releaseFrame(copy);
      expect(maker.canDraw(copy)).toBe(true);
      near(paintedCentre(other, layer(copy)), [0, 0, 0], 2);
      expect(other.usesGpu).toBe(true);
      maker.dispose();
      expect(maker.canDraw(copy)).toBe(false);
    } finally {
      maker.dispose();
      other.dispose();
    }
  }, 30_000);
});
