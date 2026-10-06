import type * as TasksVision from '@mediapipe/tasks-vision';

import { extensionOf, FILE_SCHEME, loadableUrl, readFile } from '../../web-runtime/files';
import { decodePicture, type DecodedPicture } from '../../web-runtime/picture';
import type { LabeledFrame, LabelMediaOptions, LabelMediaResult, MediaLabel } from '../definitions';

import { FrameReader } from './media';

/**
 * `labelMedia` in a browser: MediaPipe's image classifier running EfficientNet-Lite0 (int8), on the
 * CPU through WebAssembly, so the pictures never leave the page, as they never leave a phone. What
 * does leave it is MediaPipe's own report of how it is used, which it sends to Google whatever a
 * host does; `docs/media.md` says what is in it and what that asks of a host.
 *
 * A browser has no recogniser of its own to ask, so this one is BROUGHT, entirely from files the host
 * serves beside its page: MediaPipe's JavaScript (`vision_bundle.mjs`), its WebAssembly (about 11 MB,
 * one of a SIMD and a non-SIMD build, whichever the browser runs) and the model (5.3 MB). NONE of it
 * is in the host's bundle - the runtime is imported from its URL at the first call, never by the
 * bundler - so an app that also ships to phones, where this never runs, carries not a byte of it.
 * Nothing is fetched until something is labeled - or [prepareWebLabeling] asks - and the browser
 * caches it all after that. The model is fetched beside the runtime and the WebAssembly rather than
 * after them ([load]), since the first call waits for all three. [configureWebLabeling] says where
 * the files are; `docs/media.md` says which and how to serve them.
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
 * The model runs on the CPU and not the GPU: the editor behind a label call is playing video, and the
 * model runs in tens of milliseconds a frame on the CPU, where on the GPU it would compete with that
 * video for the one thing a phone's browser has least of. That does NOT make it a classifier without
 * WebGL. MediaPipe takes every picture in through a WebGL context of its own, whichever runs the
 * model, so a browser with no WebGL - switched off, or a GPU on its blocklist - cannot run it, and a
 * context the browser takes back (a GPU reset, too many contexts on one page) stops it. So the kit
 * hands MediaPipe that context's canvas itself, an ordinary one of the document's: left to choose,
 * MediaPipe takes an `OffscreenCanvas` wherever one exists, and an in-app browser on iOS 16 has one
 * with no WebGL. A load then tries the classifier once, on a single pixel, before it counts as
 * loaded, so a browser that cannot run it refuses at the load - `unsupported`, as everywhere a
 * recogniser is missing - rather than failing every clip after it with an error nobody can act on;
 * and a classifier that stops working later, or loses its context, is let go ([retire]) and loaded
 * again by the next call.
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

/** A classifier loaded, and who is using it right now. */
interface Engine {
  readonly classifier: TasksVision.ImageClassifier;
  /** When it was ready, on `performance.now()`'s clock: a call made before then counts its budget from here. */
  readonly readyAt: number;
  /** Looks holding it right now. It is closed only once there are none ([release]). */
  users: number;
  /** Let go ([retire]): no look is given it from now on, and it closes when the last one using it is done. */
  retired: boolean;
  /** Its WebGL context has gone, so whatever it says from now on is not to be believed. */
  lost: boolean;
  closed: boolean;
}

/**
 * The classifier, loading or loaded: once per page, at the first call. Every call shares it, so
 * the first two clips of a page wait on one download, not two.
 */
let loading: Promise<Engine> | null = null;

/** What [loading] came to, until it is let go. */
let current: Engine | null = null;

/**
 * Every load started so far, settled or not. A new one starts only once the last has settled,
 * because MediaPipe's loader hands its WebAssembly over through one global (`self.ModuleFactory`,
 * set by the script it injects and cleared once read), and two loads running over each other can
 * take each other's - one of them failing with "ModuleFactory not set". [configureWebLabeling]
 * while a load is running is how two would otherwise meet.
 */
let loads: Promise<unknown> = Promise.resolve();

/** The last load's failure, which is the answer, without another try, until `until`; see [FAILED_LOAD_KEPT_MS]. */
let failed: { error: LabelingUnavailableError; until: number } | null = null;

/**
 * How long a load that failed stays the answer before one is tried again. A host warms the
 * recogniser up as its picker opens ([prepareWebLabeling]) and asks about the clips once they are
 * picked, seconds later, and a load that failed at the first would fail at the second: WebKit, which
 * keeps no record of a failed import, would fetch the whole runtime again just to be told so. Long
 * enough to cover a pick, short enough that a phone that was offline for a moment gets its scenes on
 * the next try. New files ([configureWebLabeling]) are tried at once.
 */
const FAILED_LOAD_KEPT_MS = 60_000;

/**
 * How many times the runtime's import has failed, by its URL, so the next try asks for it under a
 * URL of its own; see [load].
 */
const importFailures = new Map<string, number>();

/**
 * Tells `labelMedia` in a browser where the classifier's files are, when they are not at the default
 * `labeling/vision_bundle.mjs`, `labeling/wasm/` and `labeling/efficientnet_lite0.tflite` beside the
 * page. Takes effect at the next call. A classifier already loaded from the old place is let go once
 * the looks using it have finished - never under them, which would fail them - and one still loading
 * finishes before the next load starts, so two never run at once.
 */
export function configureWebLabeling(next: Partial<WebLabelingFiles>): void {
  files = { ...files, ...next };
  failed = null;
  const previous = loading;
  loading = null;
  current = null;
  void previous?.then(retire, () => undefined);
}

/**
 * Starts loading the recogniser now, so it is there when a call needs it. The runtime and the model
 * are some 17 MB the first time, and a host that knows a label call is coming - a picker about to
 * open - saves its customer that wait.
 *
 * Resolves true once the recogniser is ready and false when it will not load, and never rejects, so
 * a host that only wants it started can call it and forget it. A host that waits on it before timing
 * its own label calls keeps a slow first download out of their time; one that does not wait is
 * answered all the same, the call waiting for the load it shares. A load that failed is the answer
 * for a minute before it is tried again ([FAILED_LOAD_KEPT_MS]).
 *
 * For a browser only: a phone has a recogniser of its own, and there this would fetch files for nothing.
 */
export function prepareWebLabeling(): Promise<boolean> {
  return classifierOnce().then(
    () => true,
    () => false,
  );
}

/**
 * The engine could not start, or stopped: no WebAssembly, no WebGL, its files not where
 * [configureWebLabeling] says, or a classifier that failed in use.
 */
export class LabelingUnavailableError extends Error {}

/** The file will not open as a picture or a video, or the browser decodes no picture in it. */
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
 * (`MediaLabels.LOOK_BUDGET_MS`): past it no new frame is started, and no seek is waited on for
 * longer than is left of it. The first frame is the exception, tried however long it takes, so a
 * slow file still gets its one look.
 *
 * It counts frames TRIED, not frames read. A video whose seeks never land would otherwise try every
 * frame it planned, each for as long as a seek is ever waited on (8 s), and hold one of the two turns
 * for most of a minute while every clip behind it waited.
 *
 * Counted from the call, its wait for a turn included, since the page's own wait began then too - but
 * not the recogniser's download, which a phone never has: a call made while that runs counts from
 * the moment it is ready, so the first clips a page asks about are not judged on one frame each
 * because the network was slow.
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
  const calledAt = performance.now();
  await turns.take();
  try {
    const engine = await take();
    try {
      return await lookAt(options, engine, Math.max(calledAt, engine.readyAt) + LOOK_BUDGET_MS);
    } finally {
      release(engine);
    }
  } finally {
    turns.done();
  }
}

async function lookAt(options: LabelMediaOptions, engine: Engine, deadline: number): Promise<LabelMediaResult> {
  const frames = clampFrames(options.frames);
  const minConfidence = clampConfidence(options.minConfidence);

  if (options.kind === 'image' || (options.kind === undefined && !(await namesAVideo(options.uri)))) {
    const picture = await openPicture(options.uri, options.kind === 'image');
    if (picture) {
      try {
        return { engine: 'mediapipe', kind: 'image', frames: [{ timeMs: 0, labels: look(engine, picture.bitmap, minConfidence) }] };
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
    /*
     * Opened is not the same as seen. A `<video>` is ready as soon as ANY of its tracks is, so a file
     * whose picture the browser has no decoder for - HEVC in a Chrome without one, an iPhone clip on
     * Linux - opens as its sound alone, with no size. Every frame drawn from it would be empty, and
     * the model, which always spreads its confidence over something, would label the empty frame:
     * scenes made up from nothing, where a phone that cannot read a file says so.
     */
    if (!(reader.width > 0 && reader.height > 0)) throw new LabelingUnreadableError(`the browser decodes no picture in ${options.uri}`);
    const durationMs = Number.isFinite(reader.video.duration) ? reader.video.duration * 1000 : 0;
    const canvas = frameCanvas(reader.width, reader.height);
    /*
     * Kept for reading back, because every frame drawn on it is read back: first by [drewNothing],
     * then by MediaPipe taking it in. A canvas left to the browser lives on the GPU, and each read of
     * one waits for the GPU to finish and copy the pixels across - Chromium says so in the console
     * from the second read on, once for every clip - where one kept in memory is read where it is
     * drawn.
     */
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new LabelingUnavailableError('this browser will not draw a video frame to a canvas');

    const looked: LabeledFrame[] = [];
    let tried = 0;
    let blank = 0;
    for (const timeMs of planTimes(durationMs, options.timesMs, frames)) {
      if (tried > 0 && performance.now() >= deadline) break;
      // A decoder that has failed never lands another seek, and each would be waited on in full.
      if (reader.video.error) break;
      tried++;
      // A frame that will not seek is left out rather than failing the clip, as the filmstrip does.
      const seek = await seekWithin(reader, timeMs, tried === 1 ? null : deadline - performance.now());
      if (seek === 'late') break;
      if (seek === 'missed') continue;
      // Emptied first: a frame that draws nothing would otherwise leave the one before it standing,
      // to be looked at a second time as though it were this one.
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(reader.video, 0, 0, canvas.width, canvas.height);
      if (drewNothing(ctx, canvas, options.uri)) {
        blank++;
        continue;
      }
      looked.push({ timeMs, labels: look(engine, canvas, minConfidence) });
    }
    if (looked.length === 0) {
      throw new LabelingUnreadableError(blank > 0 ? `the browser decodes no picture in ${options.uri}` : `no frame of ${options.uri} could be read`);
    }
    return { engine: 'mediapipe', kind: 'video', frames: looked };
  } finally {
    reader.close();
  }
}

/**
 * Puts the reader on `timeMs`, waiting no longer than `withinMs` where there is a limit: 'late' when
 * the time ran out first, which ends the look. The seek that ran out is not called off - a `<video>`
 * cannot be - but the reader is closed straight after, which empties the element under it.
 */
async function seekWithin(reader: FrameReader, timeMs: number, withinMs: number | null): Promise<'landed' | 'missed' | 'late'> {
  const seek = reader.seek(timeMs / 1000, 0).then((landed): 'landed' | 'missed' => (landed ? 'landed' : 'missed'));
  if (withinMs === null) return seek;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([seek, new Promise<'late'>(done => (timer = setTimeout(() => done('late'), Math.max(0, withinMs))))]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Whether a frame drawn on the canvas left it empty: every pixel still transparent, which no decoded
 * frame is - a black one is opaque black - and which is what a video whose picture the browser did
 * not decode leaves. Such a frame is left out rather than looked at (see [lookAt]).
 */
function drewNothing(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, uri: string): boolean {
  let pixels: Uint8ClampedArray;
  try {
    pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  } catch (error) {
    // A frame the page may not read back is one the classifier may not read either - WebGL refuses
    // a tainted canvas the way `getImageData` does - and that is the file's doing, not the engine's.
    throw new LabelingUnreadableError(`the browser will not let a frame of ${uri} be read: ${messageOf(error)}`);
  }
  for (let alpha = 3; alpha < pixels.length; alpha += 4) {
    if (pixels[alpha] !== 0) return false;
  }
  return true;
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

/**
 * What the classifier makes of one picture. A classifier that throws, or whose context has gone, is
 * broken for every picture after this one too: it is let go, so the next call loads another, and
 * this one refuses as unavailable - which a host reads as "no scenes here" - rather than failing the
 * clip in words that say nothing about the clip.
 */
function look(engine: Engine, image: TexImageSource, minConfidence: number): MediaLabel[] {
  if (engine.lost) throw new LabelingUnavailableError('the image classifier lost its WebGL context');
  let result: TasksVision.ImageClassifierResult;
  try {
    result = engine.classifier.classify(image);
  } catch (error) {
    retire(engine);
    throw new LabelingUnavailableError(`the image classifier stopped working: ${messageOf(error)}`);
  }
  const categories = result.classifications[0]?.categories ?? [];
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

/** What a file's name says it is when its type does not say: the containers phones and cameras record in. */
const VIDEO_EXTENSIONS = new Set(['mp4', 'm4v', 'mov', 'qt', 'webm', 'mkv', '3gp', '3g2', 'avi', 'mpg', 'mpeg', 'ogv', 'mts', 'm2ts']);

/**
 * Whether a file asked about with no `kind` is a video by its own type, or failing one by its name,
 * so it is never read as a picture.
 *
 * A picture is tried first because it is one decode where a video is several seeks, and a video
 * normally refuses to decode as one. Not in WebKit: its `<img>` plays MP4 - Safari's "video in img" -
 * and would hand the clip's FIRST frame back as a photograph, the one frame [planTimes] never looks
 * at, where Chrome and Firefox answer a clip for the same file. The type is asked for where it costs
 * nothing: the page's own `blob:` and `data:` URLs, whose answer carries the type the file was given,
 * and the kit's stored files. Anywhere else the name is all there is to go on without a download.
 *
 * Only a type that names a picture or a video is believed. Anything else says nothing about which
 * the file is - `application/octet-stream`, the type a file is given by whatever stored it without
 * knowing what it held, is an MP4 as readily as a JPEG - so the name is asked, as it is for a file
 * with no type at all.
 */
async function namesAVideo(uri: string): Promise<boolean> {
  const type = await typeOf(uri);
  if (type.startsWith('video/')) return true;
  if (type.startsWith('image/')) return false;
  return VIDEO_EXTENSIONS.has(extensionOf(uri, ''));
}

/** The type the file was given, lower case, or '' where it has none or it cannot be asked cheaply. */
async function typeOf(uri: string): Promise<string> {
  try {
    if (uri.startsWith(FILE_SCHEME)) return ((await readFile(uri))?.type ?? '').toLowerCase();
    if (!/^(blob|data):/i.test(uri)) return '';
    const response = await fetch(uri);
    // Only the header is wanted: the body is let go unread rather than copied for nothing.
    void response.body?.cancel().catch(() => undefined);
    return (response.headers.get('content-type') ?? '').toLowerCase();
  } catch {
    return '';
  }
}

function frameCanvas(width: number, height: number): HTMLCanvasElement {
  const scale = Math.min(1, LOOK_SIZE / Math.max(1, width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  return canvas;
}

/** The classifier for one look, held until [release]: the one loaded, or loading, or a new load. */
async function take(): Promise<Engine> {
  for (;;) {
    const engine = await classifierOnce();
    // Let go between being handed over and being taken, by [configureWebLabeling] or a lost
    // context: the next one is already the one to have.
    if (engine.retired) continue;
    engine.users++;
    return engine;
  }
}

function release(engine: Engine): void {
  engine.users--;
  if (engine.retired && engine.users === 0) close(engine);
}

/**
 * Lets a classifier go: no look is given it from now on, the next call loads another, and it is
 * closed once the looks already using it are done.
 */
function retire(engine: Engine): void {
  engine.retired = true;
  if (current === engine) {
    current = null;
    loading = null;
  }
  if (engine.users === 0) close(engine);
}

function close(engine: Engine): void {
  if (engine.closed) return;
  engine.closed = true;
  try {
    engine.classifier.close();
  } catch {
    // A classifier whose context has gone may not close cleanly; it is let go either way.
  }
}

function classifierOnce(): Promise<Engine> {
  if (loading) return loading;
  if (failed && performance.now() < failed.until) return Promise.reject(failed.error);
  failed = null;
  const from = files;
  const promise: Promise<Engine> = loads
    .then(() => load(from))
    .then(
      ({ classifier, canvas }) => {
        const engine: Engine = { classifier, readyAt: performance.now(), users: 0, retired: false, lost: false, closed: false };
        canvas.addEventListener('webglcontextlost', () => {
          engine.lost = true;
          retire(engine);
        });
        if (loading === promise) current = engine;
        return engine;
      },
      (error: unknown) => {
        const refusal = new LabelingUnavailableError(`the image classifier would not load: ${messageOf(error)}`);
        if (loading === promise) {
          loading = null;
          failed = { error: refusal, until: performance.now() + FAILED_LOAD_KEPT_MS };
        }
        throw refusal;
      },
    );
  loading = promise;
  loads = promise.catch(() => undefined);
  return promise;
}

async function load(from: WebLabelingFiles): Promise<{ classifier: TasksVision.ImageClassifier; canvas: HTMLCanvasElement }> {
  if (typeof WebAssembly !== 'object') throw new Error('this browser has no WebAssembly');
  /*
   * The model is 5 MB of the 17 and needs nothing from the rest, so it downloads beside the runtime
   * and the WebAssembly. Handed MediaPipe as a path, it would be fetched only once the WebAssembly
   * was running, 11 MB later - on a slow connection, seconds a first call spent waiting. MediaPipe
   * reads a model given as a stream only once its WebAssembly is up, so by then the download has
   * been running all along, and is often done.
   */
  const model = download(absolute(from.modelUrl));
  // Read below, or never if the runtime fails first: then its failure is not one to report as well.
  model.catch(() => undefined);

  // From its URL, never through the bundler: a host's build carries none of MediaPipe (see above).
  const url = absolute(from.runtimeUrl);
  let runtime: typeof TasksVision;
  try {
    runtime = (await import(/* @vite-ignore */ /* webpackIgnore: true */ runtimeUrl(url))) as typeof TasksVision;
  } catch (error) {
    importFailures.set(url, (importFailures.get(url) ?? 0) + 1);
    throw error;
  }
  const { FilesetResolver, ImageClassifier } = runtime;
  const fileset = await FilesetResolver.forVisionTasks(absolute(from.wasmBaseUrl).replace(/\/+$/, ''));
  const canvas = document.createElement('canvas');
  const classifier = await ImageClassifier.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: streamOf(model), delegate: 'CPU' },
    canvas,
    runningMode: 'IMAGE',
    maxResults: MAX_RESULTS,
  });
  /*
   * Created is not working. Without WebGL MediaPipe still creates the classifier - it only logs that
   * it could not get a context - and then throws at every picture it is shown. One pixel finds that
   * out here, where it is a load that failed and the answer is `unsupported`.
   */
  try {
    classifier.classify(onePixel());
  } catch (error) {
    try {
      classifier.close();
    } catch {
      // Nothing more to let go of.
    }
    throw new Error(`it will not run in this browser: ${messageOf(error)}`);
  }
  return { classifier, canvas };
}

/**
 * The runtime's URL, or the same URL with a query of its own once importing it has failed. Chromium
 * and Firefox keep a module whose fetch failed in the page's module map, so importing the same URL
 * again rejects at once without asking the network - a phone offline for a moment would be without
 * scenes until a reload. (WebKit keeps no such record and would fetch it again anyway.) The bundle
 * imports nothing relative to itself, so the query changes nothing else; and once a URL has loaded it
 * is the one used from then on, so a load after a lost context is answered from the module map
 * rather than fetched again.
 */
function runtimeUrl(url: string): string {
  const failures = importFailures.get(url) ?? 0;
  if (failures === 0) return url;
  const retry = new URL(url);
  retry.searchParams.set('retry', String(failures));
  return retry.href;
}

async function download(url: string): Promise<Uint8Array> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`the model at ${url} answered ${response.status}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** A download as the stream MediaPipe reads a model from: one chunk, once it has all arrived. */
function streamOf(bytes: Promise<Uint8Array>): ReadableStreamDefaultReader<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        controller.enqueue(await bytes);
        controller.close();
      } catch (error) {
        controller.error(error);
      }
    },
  }).getReader();
}

/** A picture of one opaque pixel, for [load] to try the classifier on. */
function onePixel(): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.fillStyle = '#808080';
    ctx.fillRect(0, 0, 1, 1);
  }
  return canvas;
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
