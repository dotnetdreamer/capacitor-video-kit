import type * as TasksVision from '@mediapipe/tasks-vision';

import { encodeSubjectTrack } from '../../editor/subject-track';
import { loadableUrl } from '../../web-runtime/files';
import { decodePicture, releasePicture, type DecodedPicture } from '../../web-runtime/picture';
import type { FindSubjectsOptions, FindSubjectsResult } from '../definitions';

import { absolute, afterLoads, download, importTasksVision, messageOf, namesAVideo, onePixel, streamOf, Turns, webLabelingFiles } from './labels';
import { FrameReader } from './media';
import { componentsOf, subjectGrid, SubjectTracker, toGrid } from './subject-tracker';

/**
 * `findSubjects` in a browser: MediaPipe's selfie segmenter, which finds PEOPLE, run over the frames
 * of a video - [DEFAULT_FPS] a second - or over a picture, its masks split into the people who do not
 * touch ([componentsOf]) and followed through the footage by the tracker every engine shares.
 *
 * It is brought the way `labelMedia`'s classifier is (see `labels.ts`): MediaPipe's runtime and
 * WebAssembly from the same files the host already serves for that, and the model - 250 KB - from
 * beside them ([configureWebSubjects]). Nothing is fetched until a search starts. It runs on the CPU,
 * for the classifier's reason: the editor asking is playing video. MediaPipe still takes every
 * picture in through a WebGL context, so a browser without WebGL refuses as `unsupported`.
 *
 * The track is written as a `blob:` URL the page holds, which is what the preview and the web render
 * read. A page that asks again for the same file - the sheet opened twice, a render after the
 * preview - is answered from the one it made, with `cached` set; a reload makes it again.
 */

/** Frames looked at a second when the call does not say: a person moves little in a tenth of a second. */
export const DEFAULT_FPS = 10;

/** The longest edge a frame is drawn at before the segmenter sees it; the model itself sees 256. */
const LOOK_SIZE = 384;

/** Where the segmenter's model is served. */
export interface WebSubjectsFiles {
  /** MediaPipe's selfie segmenter as the kit ships it: `web-assets/labeling/selfie_segmenter.tflite`. */
  modelUrl: string;
}

let files: WebSubjectsFiles = { modelUrl: 'labeling/selfie_segmenter.tflite' };

/**
 * Tells `findSubjects` in a browser where the segmenter's model is, when it is not at the default
 * `labeling/selfie_segmenter.tflite` beside the page. MediaPipe's runtime and WebAssembly are the
 * ones `configureWebLabeling` points at. Takes effect at the next search.
 */
export function configureWebSubjects(next: Partial<WebSubjectsFiles>): void {
  files = { ...files, ...next };
  segmenter = null;
}

/** The segmenter could not start or stopped: no WebAssembly, no WebGL, its files not served. */
export class SubjectsUnavailableError extends Error {}

/** The file will not open as a picture or a video, or the browser decodes no picture in it. */
export class SubjectsUnreadableError extends Error {}

/** A search [stopFindingSubjectsInBrowser] stopped. */
export class SubjectsCancelledError extends Error {}

interface Segmenter {
  readonly segmenter: TasksVision.ImageSegmenter;
  /** VIDEO mode wants a timestamp that only ever increases, across every search the segmenter runs. */
  clock: number;
}

let segmenter: Promise<Segmenter> | null = null;

/** One search at a time: the segmenter is one, and a phone's browser has one decoder to spare. */
const turns = new Turns(1);

/** The tracks this page has made, by file and rate, and the searches running or waiting. */
const made = new Map<string, Promise<FindSubjectsResult>>();
const running = new Map<string, { uri: string; abort: AbortController }>();

/**
 * Finds the subjects of `options.uri`, telling `onProgress` how far it has got, 0..1.
 * Rejects with [SubjectsUnavailableError], [SubjectsUnreadableError] or [SubjectsCancelledError].
 */
export function findSubjectsInBrowser(options: FindSubjectsOptions, onProgress: (progress: number) => void): Promise<FindSubjectsResult> {
  const fps = clampFps(options.fps);
  const key = `${options.uri}|${fps}|${options.kind ?? ''}`;
  const earlier = made.get(key);
  if (earlier) return earlier.then(result => ({ ...result, cached: true }));
  const abort = new AbortController();
  running.set(key, { uri: options.uri, abort });
  const search = (async (): Promise<FindSubjectsResult> => {
    await turns.take();
    try {
      if (abort.signal.aborted) throw new SubjectsCancelledError('stopped before it started');
      return await look(options, fps, onProgress, abort.signal);
    } finally {
      turns.done();
      running.delete(key);
    }
  })();
  made.set(key, search);
  // A search that failed is not the answer for next time: the next call looks again.
  search.catch(() => {
    if (made.get(key) === search) made.delete(key);
  });
  return search;
}

/** Stops every search whose uri is not in `keep`, answering how many it stopped. */
export function stopFindingSubjectsInBrowser(keep: readonly string[] = []): number {
  const kept = new Set(keep);
  let stopped = 0;
  for (const search of running.values()) {
    if (kept.has(search.uri) || search.abort.signal.aborted) continue;
    search.abort.abort();
    stopped++;
  }
  return stopped;
}

async function look(options: FindSubjectsOptions, fps: number, onProgress: (progress: number) => void, signal: AbortSignal): Promise<FindSubjectsResult> {
  const engine = await segmenterOnce();
  if (options.kind === 'image' || (options.kind === undefined && !(await namesAVideo(options.uri)))) {
    const picture = await openPicture(options.uri, options.kind === 'image');
    if (picture) {
      try {
        const grid = subjectGrid(picture.width, picture.height);
        const tracker = new SubjectTracker(grid.width, grid.height);
        const cells = new Uint8Array(grid.width * grid.height);
        segmentInto(engine, picture.bitmap, cells, grid.width, grid.height);
        tracker.add(0, cells, componentsOf(cells, grid.width, grid.height));
        onProgress(1);
        return written(tracker.finish({ engine: 'mediapipe', kind: 'image', durationMs: 0, fps: 0, subjectKind: 'person' }));
      } finally {
        releasePicture(picture);
      }
    }
  }

  let reader: FrameReader;
  try {
    reader = await FrameReader.open(options.uri);
  } catch (error) {
    throw new SubjectsUnreadableError(`the browser could not open ${options.uri}: ${messageOf(error)}`);
  }
  try {
    if (!(reader.width > 0 && reader.height > 0)) throw new SubjectsUnreadableError(`the browser decodes no picture in ${options.uri}`);
    const durationMs = Number.isFinite(reader.video.duration) ? reader.video.duration * 1000 : 0;
    const grid = subjectGrid(reader.width, reader.height);
    const tracker = new SubjectTracker(grid.width, grid.height);
    const cells = new Uint8Array(grid.width * grid.height);
    const scale = Math.min(1, LOOK_SIZE / Math.max(reader.width, reader.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(reader.width * scale));
    canvas.height = Math.max(1, Math.round(reader.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new SubjectsUnavailableError('this browser will not draw a video frame to a canvas');

    const times: number[] = [];
    for (let t = 0; t < Math.max(1, durationMs); t += 1000 / fps) times.push(Math.round(t));
    let last = -1;
    for (const [i, timeMs] of times.entries()) {
      if (signal.aborted) throw new SubjectsCancelledError('stopped');
      if (reader.video.error) break;
      if (!(await reader.seek(timeMs / 1000, 0)) || timeMs <= last) continue;
      last = timeMs;
      ctx.drawImage(reader.video, 0, 0, canvas.width, canvas.height);
      segmentInto(engine, canvas, cells, grid.width, grid.height);
      tracker.add(timeMs, cells, componentsOf(cells, grid.width, grid.height));
      onProgress((i + 1) / times.length);
    }
    if (tracker.frames === 0) throw new SubjectsUnreadableError(`no frame of ${options.uri} could be read`);
    return written(tracker.finish({ engine: 'mediapipe', kind: 'video', durationMs, fps, subjectKind: 'person' }));
  } finally {
    reader.close();
  }
}

/**
 * One picture through the segmenter, its person mask brought onto the grid as foreground (1) where
 * the model is at least half sure. A segmenter that throws is broken for every picture after this
 * one too: it is let go, and this search refuses as unavailable.
 */
function segmentInto(engine: Segmenter, image: TexImageSource, cells: Uint8Array, width: number, height: number): void {
  let result: TasksVision.ImageSegmenterResult;
  try {
    result = engine.segmenter.segmentForVideo(image, ++engine.clock);
  } catch (error) {
    segmenter = null;
    throw new SubjectsUnavailableError(`the segmenter stopped working: ${messageOf(error)}`);
  }
  try {
    // One mask, the person, from the selfie model; a model with a background mask first has the person last.
    const masks = result.confidenceMasks ?? [];
    const mask = masks[masks.length > 1 ? 1 : 0];
    if (!mask) {
      cells.fill(0);
      return;
    }
    toGrid(mask.getAsFloat32Array(), mask.width, mask.height, cells, width, height, 0.5);
  } finally {
    result.close();
  }
}

/** The track's bytes as a `blob:` URL, and the answer that names it. */
function written(content: ReturnType<SubjectTracker['finish']>): FindSubjectsResult {
  const bytes = encodeSubjectTrack(content);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  return {
    engine: 'mediapipe',
    uri: url,
    cached: false,
    kind: content.meta.kind,
    width: content.width,
    height: content.height,
    frames: content.frames.length,
    durationMs: content.meta.durationMs,
    subjects: content.meta.subjects,
  };
}

/** The file as a picture, upright, or null when it is not one and may be a video. */
async function openPicture(uri: string, said: boolean): Promise<DecodedPicture | null> {
  try {
    return await decodePicture(await loadableUrl(uri), LOOK_SIZE);
  } catch (error) {
    if (said) throw new SubjectsUnreadableError(`the browser could not open the picture ${uri}: ${messageOf(error)}`);
    return null;
  }
}

function segmenterOnce(): Promise<Segmenter> {
  if (segmenter) return segmenter;
  const from = { labeling: webLabelingFiles(), subjects: files };
  const promise = afterLoads(() => load(from.labeling.wasmBaseUrl, from.subjects.modelUrl, from.labeling)).catch((error: unknown) => {
    if (segmenter === promise) segmenter = null;
    throw new SubjectsUnavailableError(`the segmenter would not load: ${messageOf(error)}`);
  });
  segmenter = promise;
  return promise;
}

async function load(wasmBaseUrl: string, modelUrl: string, labeling: ReturnType<typeof webLabelingFiles>): Promise<Segmenter> {
  if (typeof WebAssembly !== 'object') throw new Error('this browser has no WebAssembly');
  const model = download(absolute(modelUrl));
  model.catch(() => undefined);
  const { FilesetResolver, ImageSegmenter } = await importTasksVision(labeling);
  const fileset = await FilesetResolver.forVisionTasks(absolute(wasmBaseUrl).replace(/\/+$/, ''));
  const canvas = document.createElement('canvas');
  const created = await ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: streamOf(model), delegate: 'CPU' },
    canvas,
    runningMode: 'VIDEO',
    outputConfidenceMasks: true,
    outputCategoryMask: false,
  });
  // Created is not working: one pixel finds out here, as the classifier's load does.
  const engine: Segmenter = { segmenter: created, clock: 0 };
  try {
    created.segmentForVideo(onePixel(), ++engine.clock).close();
  } catch (error) {
    try {
      created.close();
    } catch {
      // Nothing more to let go of.
    }
    throw new Error(`it will not run in this browser: ${messageOf(error)}`);
  }
  canvas.addEventListener('webglcontextlost', () => {
    if (segmenter) segmenter = null;
  });
  return engine;
}

function clampFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) return DEFAULT_FPS;
  return Math.min(30, Math.max(1, Math.round(fps)));
}
