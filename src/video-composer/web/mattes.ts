import { encodeMatteTrack, matteGrid, summariseMatte, type MatteTrackContent } from '../../editor/matte-track';
import { loadableUrl } from '../../web-runtime/files';
import { decodePicture, releasePicture, type DecodedPicture } from '../../web-runtime/picture';
import { MATTE_GRID, type FindMatteOptions, type FindMatteResult, type MatteStage } from '../definitions';

import { messageOf, namesAVideo } from './labels';
import { FrameReader } from './media';
import { SubjectsCancelledError, SubjectsUnavailableError, SubjectsUnreadableError, personConfidence, readySegmenter, segmenterTurns, type PersonConfidence } from './subjects';

/**
 * `findMatte` in a browser: MediaPipe's selfie segmenter - the one `findSubjects` runs, from the same
 * files, sharing its one search at a time - kept SOFT: each frame's person confidence brought onto the
 * matte grid as it is, where `findSubjects` thresholds it into subjects. It finds people, so every
 * matte it makes keeps `people` whatever was asked, and says so in [FindMatteResult.target].
 *
 * The model looks at 256 x 256 whatever it is shown, so a picture is decoded no larger than [LOOK_SIZE]
 * and its grid is the video's [MATTE_GRID]: a larger grid would only hold the same answer upscaled. The
 * edge the contract's refinement then takes from the frame itself is where the detail comes from.
 *
 * The track is a `blob:` URL the page holds, which is what the preview and the web render read. Asked
 * again for the same file the page answers from the one it made, with `cached` set; a reload makes it
 * again.
 */

/** Frames looked at a second when the call does not say: a person moves little in a tenth of a second. */
export const DEFAULT_MATTE_FPS = 10;

/** The longest edge a frame or picture is drawn at before the segmenter sees it. */
const LOOK_SIZE = 512;

/** The mattes this page has made, by file, rate and kind, and the searches running or waiting. */
const made = new Map<string, Promise<FindMatteResult>>();
const running = new Map<string, { uri: string; abort: AbortController }>();

/**
 * The matte of `options.uri`, telling `onProgress` how far it has got. Rejects with
 * `SubjectsUnavailableError`, `SubjectsUnreadableError` or `SubjectsCancelledError`, as a search for
 * subjects does: the two share their engine and its refusals.
 */
export function findMatteInBrowser(options: FindMatteOptions, onProgress: (stage: MatteStage, progress: number) => void): Promise<FindMatteResult> {
  const fps = clampFps(options.fps);
  const key = `${options.uri}|${fps}|${options.kind ?? ''}`;
  const earlier = made.get(key);
  if (earlier) return earlier.then(result => ({ ...result, cached: true }));
  const abort = new AbortController();
  running.set(key, { uri: options.uri, abort });
  const search = (async (): Promise<FindMatteResult> => {
    await segmenterTurns.take();
    try {
      if (abort.signal.aborted) throw new SubjectsCancelledError('stopped before it started');
      onProgress('preparing', 0);
      await readySegmenter();
      onProgress('preparing', 1);
      return await look(options, fps, onProgress, abort.signal);
    } finally {
      segmenterTurns.done();
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
export function stopFindingMattesInBrowser(keep: readonly string[] = []): number {
  const kept = new Set(keep);
  let stopped = 0;
  for (const search of running.values()) {
    if (kept.has(search.uri) || search.abort.signal.aborted) continue;
    search.abort.abort();
    stopped++;
  }
  return stopped;
}

async function look(options: FindMatteOptions, fps: number, onProgress: (stage: MatteStage, progress: number) => void, signal: AbortSignal): Promise<FindMatteResult> {
  if (options.kind === 'image' || (options.kind === undefined && !(await namesAVideo(options.uri)))) {
    const picture = await openPicture(options.uri, options.kind === 'image');
    if (picture) {
      try {
        const grid = matteGrid(picture.width, picture.height, MATTE_GRID);
        const cells = new Uint8Array(grid.width * grid.height);
        onto(await personConfidence(picture.bitmap), cells, grid.width, grid.height);
        onProgress('looking', 1);
        return written({ width: grid.width, height: grid.height, times: [0], frames: [cells], meta: meta('image', 0, 0, [cells], grid) });
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
    const grid = matteGrid(reader.width, reader.height, MATTE_GRID);
    const scale = Math.min(1, LOOK_SIZE / Math.max(reader.width, reader.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(reader.width * scale));
    canvas.height = Math.max(1, Math.round(reader.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new SubjectsUnavailableError('this browser will not draw a video frame to a canvas');

    const wanted: number[] = [];
    for (let t = 0; t < Math.max(1, durationMs); t += 1000 / fps) wanted.push(Math.round(t));
    const times: number[] = [];
    const frames: Uint8Array[] = [];
    for (const [i, timeMs] of wanted.entries()) {
      if (signal.aborted) throw new SubjectsCancelledError('stopped');
      if (reader.video.error) break;
      if (!(await reader.seek(timeMs / 1000, 0)) || timeMs <= (times[times.length - 1] ?? -1)) continue;
      ctx.drawImage(reader.video, 0, 0, canvas.width, canvas.height);
      const cells = new Uint8Array(grid.width * grid.height);
      onto(await personConfidence(canvas), cells, grid.width, grid.height);
      times.push(timeMs);
      frames.push(cells);
      onProgress('looking', (i + 1) / wanted.length);
    }
    canvas.width = 0;
    canvas.height = 0;
    if (frames.length === 0) throw new SubjectsUnreadableError(`no frame of ${options.uri} could be read`);
    return written({ width: grid.width, height: grid.height, times, frames, meta: meta('video', durationMs, fps, frames, grid) });
  } finally {
    reader.close();
  }
}

/** The JSON a track carries, its coverage and box measured off its frames. */
function meta(kind: 'video' | 'image', durationMs: number, fps: number, frames: readonly Uint8Array[], grid: { width: number; height: number }): MatteTrackContent['meta'] {
  return { engine: 'mediapipe', kind, target: 'people', durationMs: Math.round(durationMs), fps, ...summariseMatte(frames, grid.width, grid.height) };
}

/**
 * A confidence mask brought onto a `width` x `height` grid: each cell the mask read bilinearly at the
 * cell's centre, 0..255. No mask is no subject.
 */
export function onto(mask: PersonConfidence | null, cells: Uint8Array, width: number, height: number): void {
  if (!mask) {
    cells.fill(0);
    return;
  }
  const { values, width: mw, height: mh } = mask;
  for (let cy = 0; cy < height; cy++) {
    const gy = Math.min(mh - 1, Math.max(0, ((cy + 0.5) * mh) / height - 0.5));
    const y0 = Math.floor(gy);
    const y1 = Math.min(mh - 1, y0 + 1);
    const fy = gy - y0;
    for (let cx = 0; cx < width; cx++) {
      const gx = Math.min(mw - 1, Math.max(0, ((cx + 0.5) * mw) / width - 0.5));
      const x0 = Math.floor(gx);
      const x1 = Math.min(mw - 1, x0 + 1);
      const fx = gx - x0;
      const top = values[y0 * mw + x0]! * (1 - fx) + values[y0 * mw + x1]! * fx;
      const bottom = values[y1 * mw + x0]! * (1 - fx) + values[y1 * mw + x1]! * fx;
      cells[cy * width + cx] = Math.round(Math.min(1, Math.max(0, top * (1 - fy) + bottom * fy)) * 255);
    }
  }
}

/** The track's bytes as a `blob:` URL, and the answer that names it. */
function written(content: MatteTrackContent): FindMatteResult {
  const bytes = encodeMatteTrack(content);
  const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: 'application/octet-stream' }));
  const result: FindMatteResult = {
    engine: 'mediapipe',
    uri: url,
    cached: false,
    kind: content.meta.kind,
    target: 'people',
    width: content.width,
    height: content.height,
    frames: content.frames.length,
    durationMs: content.meta.durationMs,
    coverage: content.meta.coverage,
  };
  if (content.meta.box) result.box = content.meta.box;
  return result;
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

function clampFps(fps: number | undefined): number {
  if (fps === undefined || !Number.isFinite(fps)) return DEFAULT_MATTE_FPS;
  return Math.min(30, Math.max(1, Math.round(fps)));
}
