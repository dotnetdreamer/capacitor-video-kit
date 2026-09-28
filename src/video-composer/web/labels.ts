import type * as TasksVision from '@mediapipe/tasks-vision';

import { loadableUrl } from '../../web-runtime/files';
import { decodePicture, type DecodedPicture } from '../../web-runtime/picture';
import type { LabeledFrame, LabelMediaOptions, LabelMediaResult, MediaLabel } from '../definitions';

import { FrameReader } from './media';

/**
 * `labelMedia` in a browser: MediaPipe's image classifier running EfficientNet-Lite0 (int8), on the
 * CPU through WebAssembly, so the pictures never leave the page, as they never leave a phone.
 *
 * A browser has no recogniser of its own to ask, so this one is BROUGHT, entirely from files the host
 * serves beside its page: MediaPipe's JavaScript (`vision_bundle.mjs`), its WebAssembly (about 11 MB,
 * one of a SIMD and a non-SIMD build, whichever the browser runs) and the model (5.3 MB). NONE of it
 * is in the host's bundle - the runtime is imported from its URL at the first call, never by the
 * bundler - so an app that also ships to phones, where this never runs, carries not a byte of it.
 * Nothing is fetched until something is labeled, and the browser caches it all after that.
 * [configureWebLabeling] says where the files are; `docs/media.md` says which and how to serve them.
 *
 * It keeps the phones' pace ([AT_ONCE], [LOOK_BUDGET_MS]): two looks at a time, and a video looked at
 * for 8 s at most before the frames read so far are the answer.
 *
 * The model knows ImageNet's 1000 classes and names them as ImageNet does (`golden retriever`,
 * `seashore`, `web site`); `scenes.ts` reads them through a table of their own. Its scores are ONE
 * softmax over those classes, so they add up to 1 and a picture's confidence is split between the
 * classes that fit it - a dog is 0.4 one breed and 0.3 another - which is why the default floor is
 * 0.02 here where the phones' engines, which score every label on its own, use 0.1.
 *
 * The CPU and not the GPU: the editor behind a label call is playing video, and a WebGL context of
 * the classifier's own would compete with it for the one thing a phone's browser has least of,
 * while the model runs in tens of milliseconds a frame on the CPU.
 */

/** Where the classifier's files are served: relative to the page, or absolute. */
export interface WebLabelingFiles {
  /** MediaPipe's JavaScript, `vision_bundle.mjs` from `@mediapipe/tasks-vision`. */
  runtimeUrl: string;
  /**
   * The folder holding MediaPipe's `vision_wasm_internal.js`/`.wasm` and
   * `vision_wasm_nosimd_internal.js`/`.wasm`, from `@mediapipe/tasks-vision/wasm`.
   */
  wasmBaseUrl: string;
  /** EfficientNet-Lite0 as the kit ships it: `web-assets/labeling/efficientnet_lite0.tflite`. */
  modelUrl: string;
}

let files: WebLabelingFiles = {
  runtimeUrl: 'labeling/vision_bundle.mjs',
  wasmBaseUrl: 'labeling/wasm',
  modelUrl: 'labeling/efficientnet_lite0.tflite',
};

/** The classifier, loaded once per page on the first call; a failed load is forgotten so the next call tries again. */
let loading: Promise<TasksVision.ImageClassifier> | null = null;

/**
 * Tells `labelMedia` in a browser where the classifier's files are, when they are not at the default
 * `labeling/vision_bundle.mjs`, `labeling/wasm/` and `labeling/efficientnet_lite0.tflite` beside the
 * page. Takes effect at the next call; a classifier already loaded from the old place is let go.
 */
export function configureWebLabeling(next: Partial<WebLabelingFiles>): void {
  files = { ...files, ...next };
  void loading?.then(
    classifier => classifier.close(),
    () => undefined,
  );
  loading = null;
}

/**
 * Starts loading the recogniser now, so it is there when a call needs it. The runtime and the model
 * are some 17 MB the first time, and a host that knows a label call is coming - a picker about to
 * open - saves its customer that wait. Never fails: a load that does is the next call's to report.
 * For a browser only: a phone has a recogniser of its own, and there this would fetch files for nothing.
 */
export function prepareWebLabeling(): void {
  classifierOnce().catch(() => undefined);
}

/** The engine could not start: no WebAssembly, or its files are not where [configureWebLabeling] says. */
export class LabelingUnavailableError extends Error {}

/** The file will not open as a picture or a video. */
export class LabelingUnreadableError extends Error {}

/** The longest edge a frame or a picture is drawn at before it is looked at. The model sees 224 px, so this is about the cost of the copy. */
const LOOK_SIZE = 448;

const DEFAULT_FRAMES = 5;
const MAX_FRAMES = 20;
const DEFAULT_MIN_CONFIDENCE = 0.02;

/** How many classes the classifier hands back, strongest first: every one that matters of a softmax over 1000. */
const MAX_RESULTS = 25;

/** How many looks run at once, the rest waiting their turn: each holds a `<video>`, as on a phone (`MediaLabels.AT_ONCE`). */
export const AT_ONCE = 2;

/**
 * How long a video is looked at before the frames read so far are the answer, as on a phone
 * (`MediaLabels.LOOK_BUDGET_MS`): past it no new frame is started, and the first is always read,
 * however long it takes. Counted from the call, its wait for a turn and a first call's download
 * included, since the page's own wait began then too.
 */
export const LOOK_BUDGET_MS = 8_000;

/**
 * Turns to take, [size] at a time. A turn given back goes straight to the call waiting longest, so a
 * call arriving at that moment cannot slip in ahead of it and make one more than [size].
 */
export class Turns {
  private running = 0;
  private readonly waiting: (() => void)[] = [];

  constructor(private readonly size: number) {}

  /** Resolves when it is this caller's turn; the caller gives it back with [done]. */
  async take(): Promise<void> {
    if (this.running < this.size) {
      this.running++;
      return;
    }
    await new Promise<void>(resolve => this.waiting.push(resolve));
  }

  done(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.running--;
  }
}

const turns = new Turns(AT_ONCE);

export async function labelMediaInBrowser(options: LabelMediaOptions): Promise<LabelMediaResult> {
  const deadline = performance.now() + LOOK_BUDGET_MS;
  await turns.take();
  try {
    return await lookAt(options, deadline);
  } finally {
    turns.done();
  }
}

async function lookAt(options: LabelMediaOptions, deadline: number): Promise<LabelMediaResult> {
  const frames = clampFrames(options.frames);
  const minConfidence = clampConfidence(options.minConfidence);
  const classifier = await classifierOnce();

  if (options.kind !== 'video') {
    const picture = await openPicture(options.uri, options.kind === 'image');
    if (picture) {
      try {
        return { engine: 'mediapipe', kind: 'image', frames: [{ timeMs: 0, labels: look(classifier, picture.bitmap, minConfidence) }] };
      } finally {
        if ('close' in picture.bitmap) picture.bitmap.close();
      }
    }
  }

  let reader: FrameReader;
  try {
    reader = await FrameReader.open(options.uri);
  } catch (error) {
    throw new LabelingUnreadableError(`the browser could not open ${options.uri}: ${messageOf(error)}`);
  }
  try {
    const durationMs = Number.isFinite(reader.video.duration) ? reader.video.duration * 1000 : 0;
    const canvas = frameCanvas(reader.width, reader.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new LabelingUnavailableError('this browser will not draw a video frame to a canvas');

    const looked: LabeledFrame[] = [];
    for (const timeMs of planTimes(durationMs, options.timesMs, frames)) {
      if (looked.length > 0 && performance.now() > deadline) break;
      // A frame that will not seek is left out rather than failing the clip, as the filmstrip does.
      if (!(await reader.seek(timeMs / 1000, 0))) continue;
      ctx.drawImage(reader.video, 0, 0, canvas.width, canvas.height);
      looked.push({ timeMs, labels: look(classifier, canvas, minConfidence) });
    }
    if (looked.length === 0) throw new LabelingUnreadableError(`no frame of ${options.uri} could be read`);
    return { engine: 'mediapipe', kind: 'video', frames: looked };
  } finally {
    reader.close();
  }
}

/**
 * The times the phones look at, number for number: the ones asked for, in order and each once, or
 * `frames` of them, each at the middle of its own equal share of the clip, so none is the first
 * frame or the last, where a camera is still being raised or already lowered.
 */
export function planTimes(durationMs: number, timesMs: readonly number[] | undefined, frames: number): number[] {
  const end = Math.max(0, durationMs);
  if (timesMs && timesMs.length > 0) {
    const asked = timesMs.map(time => (Number.isFinite(time) ? Math.max(0, Math.round(time)) : 0));
    return [...new Set(asked.map(time => (end > 0 ? Math.min(time, Math.floor(end)) : time)))].sort((a, b) => a - b);
  }
  return [...new Set(Array.from({ length: frames }, (_, i) => Math.round((end * (2 * i + 1)) / (2 * frames))))];
}

function look(classifier: TasksVision.ImageClassifier, image: TexImageSource, minConfidence: number): MediaLabel[] {
  const categories = classifier.classify(image).classifications[0]?.categories ?? [];
  return categories
    .filter(category => category.score >= minConfidence && category.categoryName)
    .sort((a, b) => b.score - a.score || a.categoryName.localeCompare(b.categoryName))
    .map(category => ({ label: category.categoryName, confidence: Math.round(category.score * 1000) / 1000 }));
}

/**
 * The file as a picture, upright and no bigger than [LOOK_SIZE], or null when it is not one and may
 * be a video. A file the caller SAID is a picture and will not decode is unreadable, not a video.
 */
async function openPicture(uri: string, said: boolean): Promise<DecodedPicture | null> {
  try {
    return await decodePicture(await loadableUrl(uri), LOOK_SIZE);
  } catch (error) {
    if (said) throw new LabelingUnreadableError(`the browser could not open the picture ${uri}: ${messageOf(error)}`);
    return null;
  }
}

function frameCanvas(width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, LOOK_SIZE / Math.max(1, width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

function classifierOnce(): Promise<TasksVision.ImageClassifier> {
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw new LabelingUnavailableError(`the image classifier would not load: ${messageOf(error)}`);
  });
  return loading;
}

async function load(): Promise<TasksVision.ImageClassifier> {
  if (typeof WebAssembly !== 'object') throw new Error('this browser has no WebAssembly');
  // From its URL, never through the bundler: a host's build carries none of MediaPipe (see above).
  const runtime = (await import(/* @vite-ignore */ /* webpackIgnore: true */ absolute(files.runtimeUrl))) as typeof TasksVision;
  const { FilesetResolver, ImageClassifier } = runtime;
  const fileset = await FilesetResolver.forVisionTasks(absolute(files.wasmBaseUrl).replace(/\/+$/, ''));
  return await ImageClassifier.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: absolute(files.modelUrl), delegate: 'CPU' },
    runningMode: 'IMAGE',
    maxResults: MAX_RESULTS,
  });
}

function absolute(url: string): string {
  return new URL(url, document.baseURI).href;
}

function clampFrames(frames: number | undefined): number {
  if (frames === undefined || !Number.isFinite(frames)) return DEFAULT_FRAMES;
  return Math.min(MAX_FRAMES, Math.max(1, Math.round(frames)));
}

function clampConfidence(confidence: number | undefined): number {
  if (confidence === undefined || !Number.isFinite(confidence)) return DEFAULT_MIN_CONFIDENCE;
  return Math.min(1, Math.max(0, confidence));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message || error.name : String(error);
}
