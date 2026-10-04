import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureWebLabeling, labelMediaInBrowser, LabelingUnavailableError, prepareWebLabeling, type WebLabelingFiles } from './labels';

/*
 * The browser's recogniser, for real: MediaPipe's runtime and EfficientNet-Lite0 loaded in Chromium
 * from the files a host serves, a picture decoded and a clip seeked the way `labelMedia` does it.
 * What the model makes of a drawing is not the point - `scenes.unit.test.ts` holds its answers for
 * real photographs - so these hold the shape of the answer, and that a missing file is a refusal.
 */
const FILES: WebLabelingFiles = {
  runtimeUrl: '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs',
  wasmBaseUrl: '/node_modules/@mediapipe/tasks-vision/wasm',
  modelUrl: '/web-assets/labeling/efficientnet_lite0.tflite',
};

beforeAll(() => configureWebLabeling(FILES));
afterAll(() => configureWebLabeling(FILES));

/** A drawing: sky, sea and sand, as a `blob:` URL a picker would hand over. */
async function picture(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 480;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#7ec8f0';
  ctx.fillRect(0, 0, 640, 200);
  ctx.fillStyle = '#1e6fa8';
  ctx.fillRect(0, 200, 640, 120);
  ctx.fillStyle = '#e8d29a';
  ctx.fillRect(0, 320, 640, 160);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.9));
  return URL.createObjectURL(blob);
}

/** A second and a half of that drawing moving, recorded as a WebM, as a `blob:` URL. */
async function clip(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 240;
  const ctx = canvas.getContext('2d')!;
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => chunks.push(event.data);
  const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()));
  recorder.start();
  const started = performance.now();
  while (performance.now() - started < 1500) {
    const t = (performance.now() - started) / 1500;
    ctx.fillStyle = '#7ec8f0';
    ctx.fillRect(0, 0, 320, 240);
    ctx.fillStyle = '#e8d29a';
    ctx.fillRect(0, 160 - 40 * t, 320, 80 + 40 * t);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  recorder.stop();
  await stopped;
  return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
}

describe('labelMedia in a browser, with MediaPipe', () => {
  it('reads a picture: one frame at 0, ImageNet labels strongest first, none below the floor', async () => {
    const result = await labelMediaInBrowser({ uri: await picture(), kind: 'image' });
    expect(result.engine).toBe('mediapipe');
    expect(result.kind).toBe('image');
    expect(result.frames).toHaveLength(1);
    const [only] = result.frames;
    expect(only!.timeMs).toBe(0);
    expect(only!.labels.length).toBeGreaterThan(0);
    const confidences = only!.labels.map(label => label.confidence);
    expect(confidences).toEqual([...confidences].sort((a, b) => b - a));
    expect(confidences.every(c => c >= 0.02 && c <= 1)).toBe(true);
  }, 60_000);

  it('tells a clip from a picture by itself, and looks at its frames in time order', async () => {
    const result = await labelMediaInBrowser({ uri: await clip(), frames: 3 });
    expect(result.kind).toBe('video');
    expect(result.frames.length).toBeGreaterThan(0);
    const times = result.frames.map(frame => frame.timeMs);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  }, 60_000);

  it('refuses as unavailable, rather than failing strangely, when its model is not where it was told', async () => {
    configureWebLabeling({ modelUrl: '/web-assets/labeling/missing.tflite' });
    await expect(labelMediaInBrowser({ uri: await picture(), kind: 'image' })).rejects.toBeInstanceOf(LabelingUnavailableError);
    configureWebLabeling(FILES);
  }, 60_000);

  /*
   * A browser with WebGL switched off, or a GPU it blocks. MediaPipe still CREATES the classifier
   * there - it only logs that it got no context - and throws at every picture after, so this is the
   * load's own one-pixel try at work: refused at the load, as unavailable, not failed clip by clip.
   */
  it('refuses as unavailable at the load where the browser gives it no WebGL, and loads where it does', async () => {
    configureWebLabeling(FILES);
    const getContext = HTMLCanvasElement.prototype.getContext;
    const withoutWebGl = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
      return /webgl/i.test(type) ? null : (getContext as (...args: unknown[]) => unknown).call(this, type, ...rest);
    };
    HTMLCanvasElement.prototype.getContext = withoutWebGl as typeof getContext;
    try {
      expect(await prepareWebLabeling()).toBe(false);
      await expect(labelMediaInBrowser({ uri: await picture(), kind: 'image' })).rejects.toBeInstanceOf(LabelingUnavailableError);
    } finally {
      HTMLCanvasElement.prototype.getContext = getContext;
    }

    configureWebLabeling(FILES);
    expect(await prepareWebLabeling()).toBe(true);
  }, 60_000);

  /* A GPU reset, or a page holding more WebGL contexts than the browser allows: the oldest goes. */
  it('loads its classifier again after the browser takes its WebGL context back', async () => {
    // A load of its own, so the canvas MediaPipe is handed is made while this test is watching.
    configureWebLabeling(FILES);
    const canvases: HTMLCanvasElement[] = [];
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => {
      const element = createElement(tag, options);
      if (element instanceof HTMLCanvasElement) canvases.push(element);
      return element;
    }) as typeof document.createElement);
    try {
      expect((await labelMediaInBrowser({ uri: await picture(), kind: 'image' })).frames[0]!.labels.length).toBeGreaterThan(0);
    } finally {
      vi.restoreAllMocks();
    }

    // Every other canvas here has a 2D context already, and one of those asked for WebGL answers null.
    const context = canvases.map(canvas => canvas.getContext('webgl2') ?? canvas.getContext('webgl')).find(found => found !== null);
    expect(context).toBeTruthy();
    const lost = new Promise(resolve => context!.canvas.addEventListener('webglcontextlost', resolve, { once: true }));
    context!.getExtension('WEBGL_lose_context')!.loseContext();
    await lost;

    const again = await labelMediaInBrowser({ uri: await picture(), kind: 'image' });
    expect(again.frames[0]!.labels.length).toBeGreaterThan(0);
  }, 60_000);
});
