import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { configureWebLabeling, labelMediaInBrowser, LabelingUnavailableError, type WebLabelingFiles } from './labels';

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
});
