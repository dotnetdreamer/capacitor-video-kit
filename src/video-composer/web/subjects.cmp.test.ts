import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { parseSubjectTrack } from '../../editor/subject-track';

import { configureWebLabeling, type WebLabelingFiles } from './labels';
import { configureWebSubjects, findSubjectsInBrowser, stopFindingSubjectsInBrowser, SubjectsCancelledError, SubjectsUnavailableError } from './subjects';

/*
 * `findSubjects` in a browser, for real: MediaPipe's runtime and its selfie segmenter loaded in
 * Chromium from the files a host serves, a picture decoded and a clip seeked frame by frame. Whether
 * the model finds a person in a drawing is not the point - there is none to find - so these hold the
 * shape of the answer and of the track it writes, that a second call is answered from the first, that
 * a search can be stopped, and that a missing model is a refusal rather than an answer.
 */
const LABELING: WebLabelingFiles = {
  runtimeUrl: '/node_modules/@mediapipe/tasks-vision/vision_bundle.mjs',
  wasmBaseUrl: '/node_modules/@mediapipe/tasks-vision/wasm',
  modelUrl: '/web-assets/labeling/efficientnet_lite0.tflite',
};
const MODEL = '/web-assets/labeling/selfie_segmenter.tflite';

beforeAll(() => {
  configureWebLabeling(LABELING);
  configureWebSubjects({ modelUrl: MODEL });
});
afterAll(() => configureWebSubjects({ modelUrl: MODEL }));

/** A drawing of a landscape as a `blob:` URL a picker would hand over: nobody in it. */
async function picture(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 480;
  canvas.height = 640;
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#7ec8f0';
  ctx.fillRect(0, 0, 480, 300);
  ctx.fillStyle = '#3f8f4a';
  ctx.fillRect(0, 300, 480, 340);
  const blob = await new Promise<Blob>(resolve => canvas.toBlob(b => resolve(b!), 'image/jpeg', 0.9));
  return URL.createObjectURL(blob);
}

/** A second of that drawing moving, recorded as a WebM. */
async function clip(): Promise<string> {
  const canvas = document.createElement('canvas');
  canvas.width = 240;
  canvas.height = 320;
  const ctx = canvas.getContext('2d')!;
  const recorder = new MediaRecorder(canvas.captureStream(30), { mimeType: 'video/webm' });
  const chunks: Blob[] = [];
  recorder.ondataavailable = event => chunks.push(event.data);
  const stopped = new Promise<void>(resolve => (recorder.onstop = () => resolve()));
  recorder.start();
  const started = performance.now();
  while (performance.now() - started < 1000) {
    const t = (performance.now() - started) / 1000;
    ctx.fillStyle = '#7ec8f0';
    ctx.fillRect(0, 0, 240, 320);
    ctx.fillStyle = '#3f8f4a';
    ctx.fillRect(0, 200 - 60 * t, 240, 120 + 60 * t);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
  recorder.stop();
  await stopped;
  return URL.createObjectURL(new Blob(chunks, { type: 'video/webm' }));
}

describe('findSubjects in a browser, with MediaPipe', () => {
  it('reads a picture: one frame, a grid of SUBJECT_GRID on its longer side, a track that parses', async () => {
    const result = await findSubjectsInBrowser({ uri: await picture(), kind: 'image' }, () => undefined);
    expect(result.engine).toBe('mediapipe');
    expect(result.kind).toBe('image');
    expect(result.frames).toBe(1);
    expect([result.width, result.height]).toEqual([240, 320]);
    expect(result.cached).toBe(false);
    expect(result.subjects).toEqual([]);
    const track = parseSubjectTrack(await (await fetch(result.uri)).arrayBuffer());
    expect([track.width, track.height, track.frameCount]).toEqual([240, 320, 1]);
    expect(track.meta?.kind).toBe('image');
    expect(track.frame(0).every(cell => cell === 0)).toBe(true);
  }, 60_000);

  it('looks at a clip frame by frame in time order, telling how far it has got, and answers again from what it made', async () => {
    const uri = await clip();
    const progress: number[] = [];
    const result = await findSubjectsInBrowser({ uri, fps: 10 }, value => progress.push(value));
    expect(result.kind).toBe('video');
    expect(result.frames).toBeGreaterThan(3);
    expect(progress.length).toBeGreaterThan(0);
    expect(progress[progress.length - 1]).toBe(1);
    expect(progress).toEqual([...progress].sort((a, b) => a - b));
    const track = parseSubjectTrack(await (await fetch(result.uri)).arrayBuffer());
    expect([...track.times]).toEqual([...track.times].sort((a, b) => a - b));
    const again = await findSubjectsInBrowser({ uri, fps: 10 }, () => undefined);
    expect(again.cached).toBe(true);
    expect(again.uri).toBe(result.uri);
  }, 60_000);

  it('stops a search it is asked to, and keeps the ones it is told to keep', async () => {
    const uri = await clip();
    const search = findSubjectsInBrowser({ uri, fps: 30 }, () => undefined);
    expect(stopFindingSubjectsInBrowser([uri])).toBe(0);
    expect(stopFindingSubjectsInBrowser()).toBe(1);
    await expect(search).rejects.toBeInstanceOf(SubjectsCancelledError);
    // A search that was stopped is not the answer next time.
    await expect(findSubjectsInBrowser({ uri, fps: 30 }, () => undefined)).resolves.toMatchObject({ cached: false });
  }, 60_000);

  it('refuses as unavailable where the model is not served', async () => {
    configureWebSubjects({ modelUrl: '/web-assets/labeling/missing.tflite' });
    try {
      await expect(findSubjectsInBrowser({ uri: await picture(), kind: 'image' }, () => undefined)).rejects.toBeInstanceOf(SubjectsUnavailableError);
    } finally {
      configureWebSubjects({ modelUrl: MODEL });
    }
  }, 60_000);
});
