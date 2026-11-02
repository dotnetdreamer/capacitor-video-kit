import { CUTOUT_EPSILON, CUTOUT_RADIUS } from '../video-composer/definitions';
import { cutoutKernel, cutoutPixels } from './cutout-pixels';
import { cutoutPhoto, type CutoutPhotoJob, type CutoutPhotoTools } from './cutout-photo';
import type { RasterisedOverlay } from './raster-context';

/**
 * A cut-out photo's bitmap ([cutoutPhoto]) drawn in a worker, so the second or two it costs a cheap phone
 * is not a second or two in which the editor stands still. Measured on a Galaxy A13, a photo with an
 * outline took two seconds on the main thread, in which no frame was drawn and no tap answered; with
 * only the arithmetic moved out, reading the photo back, bringing its matte down and encoding the PNG
 * still held the main thread for three hundred milliseconds. So the worker does all of it, on an
 * `OffscreenCanvas`, and the page only hands it the picture and takes the PNG back.
 *
 * The worker runs the same code as the main thread. Its script is [cutoutKernel]'s and [cutoutPhoto]'s
 * own source, both of which read nothing from outside themselves, so whatever a bundler or a minifier
 * made of the modules around them, the worker draws exactly what the main thread would. It is made the
 * first time it is needed and let go of after [IDLE_MS] with nothing to do.
 *
 * Where a page cannot start one - no `Worker`, a Content-Security-Policy that refuses `blob:` workers, no
 * `OffscreenCanvas` in one - or the one it started fails, the photo is drawn here, on the main thread, as
 * it always was, and so is every photo after it. A job is never lost to the worker: the page keeps the
 * photo, and draws it itself from that.
 */

/** How long a worker with nothing to do is kept: a run of edits to one photo reuses it, and an editor left alone gives its memory back. */
const IDLE_MS = 20_000;

/** The main thread's way of drawing: canvas elements, and the PNG an element encodes. */
const HERE: CutoutPhotoTools = {
  cutoutPixels,
  canvas(width, height) {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    return canvas;
  },
  async png(canvas) {
    return (canvas as HTMLCanvasElement).toDataURL('image/png');
  },
};

interface Job {
  /** The photo drawn on the main thread instead. */
  here: () => Promise<RasterisedOverlay | null>;
  resolve: (raster: RasterisedOverlay | null) => void;
  reject: (error: unknown) => void;
}

/** What the worker answers a photo with: its bitmap, or why it could not draw one. */
interface Answer {
  id: number;
  raster?: RasterisedOverlay | null;
  error?: string;
}

let worker: Worker | null = null;
let workerUrl = '';
/** Set once a worker could not be started or failed: every photo from then on is drawn on the main thread. */
let broken = false;
let nextId = 0;
const jobs = new Map<number, Job>();
let idleTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * [cutoutPhoto]'s bitmap of `image`, drawn in a worker where the page can run one and on the main
 * thread where it cannot. The same pixels either way.
 */
export async function cutoutPhotoInWorker(image: HTMLImageElement, job: CutoutPhotoJob): Promise<RasterisedOverlay | null> {
  const here = (): Promise<RasterisedOverlay | null> => cutoutPhoto(image, job, HERE);
  const thread = started();
  if (!thread || typeof createImageBitmap !== 'function') return here();
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(image);
  } catch {
    return here();
  }
  // The worker can have failed, and been let go of, while the picture was being copied for it.
  if (worker !== thread) {
    bitmap.close();
    return here();
  }
  return new Promise<RasterisedOverlay | null>((resolve, reject) => {
    const id = nextId++;
    jobs.set(id, { here, resolve, reject });
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    // The picture is handed over, the matte copied: the page still has the photo to draw it from itself.
    thread.postMessage({ id, bitmap, job }, [bitmap]);
  });
}

/** The worker, started if it is not running, or null where none can be. */
function started(): Worker | null {
  if (worker) return worker;
  if (broken || typeof Worker === 'undefined' || typeof Blob === 'undefined' || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') return null;
  try {
    workerUrl = URL.createObjectURL(new Blob([workerScript()], { type: 'text/javascript' }));
    const made = new Worker(workerUrl);
    made.onmessage = (event: MessageEvent<Answer>) => answered(event.data);
    // A script the page refused, or one that would not run: everything waiting on it is drawn here.
    made.onerror = event => {
      event.preventDefault();
      void giveUp();
    };
    made.onmessageerror = () => void giveUp();
    worker = made;
    return made;
  } catch {
    broken = true;
    stop();
    return null;
  }
}

function answered(answer: Answer): void {
  const job = jobs.get(answer.id);
  if (!job) return;
  jobs.delete(answer.id);
  if (answer.error === undefined) {
    job.resolve(answer.raster ?? null);
  } else {
    // The main thread either draws it, and the worker is what failed - no `OffscreenCanvas` in it, say -
    // or fails for the reason the worker did, and the photo fails as it would have here.
    job.here().then(raster => {
      job.resolve(raster);
      void giveUp();
    }, job.reject);
  }
  if (jobs.size === 0 && worker) idleTimer = setTimeout(stop, IDLE_MS);
}

/** No worker from now on, and every photo still waiting on one drawn here, one after another. */
async function giveUp(): Promise<void> {
  broken = true;
  stop();
  const waiting = [...jobs.values()];
  jobs.clear();
  for (const job of waiting) {
    try {
      job.resolve(await job.here());
    } catch (error) {
      job.reject(error);
    }
  }
}

function stop(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = null;
  worker?.terminate();
  worker = null;
  if (workerUrl) URL.revokeObjectURL(workerUrl);
  workerUrl = '';
}

/** The worker's whole script: the kernel, made with the contract's numbers, and the photo drawn on an `OffscreenCanvas`, one per message. */
function workerScript(): string {
  return `const kernel = (${cutoutKernel.toString()})(${CUTOUT_RADIUS}, ${CUTOUT_EPSILON});
const cutoutPhoto = (${cutoutPhoto.toString()});
const tools = {
  cutoutPixels: kernel.cutoutPixels,
  canvas: function (width, height) { return new OffscreenCanvas(width, height); },
  png: function (canvas) {
    return canvas.convertToBlob({ type: 'image/png' }).then(function (blob) { return new FileReaderSync().readAsDataURL(blob); });
  },
};
self.onmessage = function (event) {
  var message = event.data;
  cutoutPhoto(message.bitmap, message.job, tools).then(
    function (raster) {
      message.bitmap.close();
      self.postMessage({ id: message.id, raster: raster });
    },
    function (error) {
      message.bitmap.close();
      self.postMessage({ id: message.id, error: String((error && error.stack) || error) });
    },
  );
};
`;
}

/** Puts the worker back as it was at load: what the tests start from. */
export function resetCutoutWorker(): void {
  stop();
  broken = false;
  jobs.clear();
}
