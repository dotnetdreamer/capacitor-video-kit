import { describe, resolve } from '../../web-runtime/files';
import { holdPageOpen } from '../../web-runtime/leave-guard';
import type { PublishError, PublishFailureCode } from '../definitions';

import { errorMessage, lookupDownloadId, NetworkError, parseCreatedPost, parseDownloadId, postJson, uploadFile } from './http';
import { BACKOFF_MS, computePercent, CREATING_PERCENT, IN_FLIGHT, isRetryable, MAX_ATTEMPTS, uploadFor } from './state';
import { loadEntry, saveEntry, type PublishEntry } from './store';
import { fill } from './template-fill';

/**
 * Sends every file of one post, in order, then creates the post - the web's version of the two
 * chained workers.
 *
 * Two steps rather than one loop, for the reason `Workers.kt` gives: a failure creating the post
 * must retry only the create call. The uploads are the expensive part and are already done by the
 * time it runs, and re-sending a hundred megabytes because a create call got a 503 would be
 * indefensible.
 *
 * The invariant that makes all of this safe to re-run is the native one, unchanged: AN UPLOAD WITH
 * A `downloadId` IS NEVER SENT AGAIN. A reload, a dropped connection and a cancelled-then-retried
 * post all come back to this function, and each time it picks up exactly where the record says it
 * stopped. A file that was mid-flight when the page went is looked up by its guid first, because
 * the server may well have the whole thing already and only the response was lost.
 *
 * What is NOT the native behaviour, and cannot be: none of this survives the page. WorkManager can
 * restart a process to finish an upload with the app closed; a browser cannot run anything at all
 * once the tab is gone. So the retry ladder runs inside this function instead of being handed to
 * the platform, and a post interrupted by a closed tab resumes when the page is next opened, from
 * `resumeAll`.
 *
 * A Web Lock keeps two tabs off one post. Without it, a customer with the app open twice would
 * upload every file twice and create two posts, which is the one failure this plugin exists to
 * prevent.
 */

export type PublishEmitter = (event: 'publishProgress' | 'publishFinished' | 'publishFailed', data: object) => void;

/** How often the bar may move. Any faster is work rather than feedback. */
const PROGRESS_TICK_MS = 500;

/** The record is written far less often than the counter moves; it only has to be resumable. */
const PERSIST_EVERY_PERCENT = 5;

/** Byte counters for jobs running in THIS page, so `getState` can answer with the live number. */
const liveBytes = new Map<string, Map<string, number>>();

/** One abort per post, for `cancel`. */
const running = new Map<string, AbortController>();

const lastTick = new Map<string, number>();
const lastPercent = new Map<string, number>();
const lastPersisted = new Map<string, number>();

/** The live byte counters for one post, for `getState` to fold in. */
export function bytesFor(pendingPostId: string): ReadonlyMap<string, number> {
  return liveBytes.get(pendingPostId) ?? new Map<string, number>();
}

export function isRunning(pendingPostId: string): boolean {
  return running.has(pendingPostId);
}

export function abort(pendingPostId: string): void {
  running.get(pendingPostId)?.abort();
}

/**
 * Drives one post to a terminal state. Resolves when it stops, however it stops.
 *
 * Deliberately never rejects: every outcome is written to the record and announced as an event, and
 * a caller of `publish` has had its answer long before this finishes.
 */
export async function run(pendingPostId: string, emit: PublishEmitter): Promise<void> {
  if (running.has(pendingPostId)) return;
  const controller = new AbortController();
  running.set(pendingPostId, controller);
  liveBytes.set(pendingPostId, new Map());
  // An upload stops with the tab, so the customer is asked before the tab goes. It resumes on the
  // next page load either way - see `resumeAll` - but a post half sent is worth a question.
  const release = holdPageOpen(`uploading ${pendingPostId}`);

  try {
    await withLock(`videokit-publish-${pendingPostId}`, async () => {
      const entry = await loadEntry(pendingPostId);
      if (!entry || !IN_FLIGHT.includes(entry.state.phase)) return;
      const uploaded = await sendFiles(entry, controller.signal, emit);
      if (!uploaded) return;
      await createPost(entry, controller.signal, emit);
    });
  } catch (error) {
    // Only an unexpected failure reaches here - the two steps handle their own - and the record
    // still has to say something, or the post sits in `uploading` for ever.
    const entry = await loadEntry(pendingPostId);
    if (entry && IN_FLIGHT.includes(entry.state.phase)) {
      await failWith(entry, emit, {
        code: 'unknown',
        message: describe(error),
        phase: 'uploading',
        retryable: true,
      });
    }
  } finally {
    release();
    running.delete(pendingPostId);
    liveBytes.delete(pendingPostId);
    lastTick.delete(pendingPostId);
    lastPercent.delete(pendingPostId);
    lastPersisted.delete(pendingPostId);
  }
}

/**
 * Picks up every post that was in flight when the page last closed.
 *
 * Called once when the plugin loads. This is the whole of what a browser can offer in place of
 * WorkManager restarting a process: the work resumes the next time the customer is here.
 */
export function resumeAll(entries: readonly PublishEntry[], emit: PublishEmitter): void {
  for (const entry of entries) {
    if (!IN_FLIGHT.includes(entry.state.phase)) continue;
    void run(entry.request.pendingPostId, emit);
  }
}

/* -------------------------------------------------------------------------------------------- */

/** Every file, in order, stitched first. False when the job stopped before they were all in. */
async function sendFiles(entry: PublishEntry, signal: AbortSignal, emit: PublishEmitter): Promise<boolean> {
  const { request, state } = entry;
  state.phase = 'uploading';
  await saveEntry(entry);

  for (const upload of request.uploads) {
    const uploadState = uploadFor(state, upload.uploadGuid);
    if (!uploadState) {
      await failWith(entry, emit, {
        code: 'unknown',
        message: `no record for ${upload.uploadGuid}`,
        phase: 'uploading',
        uploadGuid: upload.uploadGuid,
        retryable: false,
      });
      return false;
    }

    // Already accepted by the server, this run or a previous one.
    if (uploadState.downloadId) continue;

    // Interrupted mid-flight: the server may have the file even though we never saw the answer.
    // Asking is a great deal cheaper than sending it again.
    if (uploadState.status === 'uploading') {
      const recovered = await lookupDownloadId(request, upload.uploadGuid, signal);
      if (recovered) {
        uploadState.downloadId = recovered;
        uploadState.status = 'done';
        uploadState.bytesSent = uploadState.bytesTotal;
        await saveEntry(entry);
        emitProgress(entry, emit);
        continue;
      }
    }

    let blob: Blob;
    try {
      blob = await resolve(upload.path);
      if (blob.size === 0) throw new Error('the file is empty');
    } catch {
      await failWith(entry, emit, {
        code: 'file_missing',
        message: `missing ${upload.uploadGuid}`,
        phase: 'uploading',
        uploadGuid: upload.uploadGuid,
        retryable: false,
      });
      return false;
    }

    uploadState.status = 'uploading';
    uploadState.bytesTotal = blob.size;
    await saveEntry(entry);

    const outcome = await attempt(entry, signal, emit, 'uploading', upload.uploadGuid, () =>
      uploadFile(request, upload, blob, {
        signal,
        onBytes: sent => onBytes(entry, upload.uploadGuid, sent, emit),
      }),
    );
    if (!outcome) return false;

    if (outcome.status >= 200 && outcome.status < 300) {
      const downloadId = parseDownloadId(outcome.body);
      if (!downloadId) {
        await failWith(entry, emit, {
          code: 'http',
          message: `no downloadId in the response: ${errorMessage(outcome.body)}`,
          phase: 'uploading',
          uploadGuid: upload.uploadGuid,
          httpStatus: outcome.status,
          retryable: false,
        });
        return false;
      }
      uploadState.downloadId = downloadId;
      uploadState.status = 'done';
      uploadState.httpStatus = outcome.status;
      uploadState.bytesSent = uploadState.bytesTotal;
      await saveEntry(entry);
      emitProgress(entry, emit);
      continue;
    }

    await failWith(entry, emit, {
      ...classify(outcome.status, outcome.body),
      phase: 'uploading',
      uploadGuid: upload.uploadGuid,
      httpStatus: outcome.status,
    });
    return false;
  }
  return true;
}

/** Fills the caller's body template with the ids the uploads produced, and creates the post. */
async function createPost(entry: PublishEntry, signal: AbortSignal, emit: PublishEmitter): Promise<void> {
  const { request, state } = entry;
  // Idempotent: if the post already exists, a rerun must not create a second one.
  if (state.postId) return;

  state.phase = 'creating';
  state.percent = CREATING_PERCENT;
  await saveEntry(entry);
  emit('publishProgress', {
    pendingPostId: request.pendingPostId,
    phase: 'creating',
    percent: CREATING_PERCENT,
  });

  const stitched = state.uploads.find(upload => upload.role === 'stitched')?.downloadId ?? state.uploads[0]?.downloadId;
  if (!stitched) {
    await failWith(entry, emit, {
      code: 'unknown',
      message: 'no uploaded video to post',
      phase: 'creating',
      retryable: false,
    });
    return;
  }

  const originals: number[] = [];
  for (const upload of state.uploads) {
    if (upload.role !== 'original') continue;
    if (!upload.downloadId) {
      await failWith(entry, emit, {
        code: 'unknown',
        message: `upload ${upload.uploadGuid} has no id`,
        phase: 'creating',
        retryable: false,
      });
      return;
    }
    originals.push(upload.downloadId);
  }

  const body = fill(request.createPost.bodyTemplate, stitched, originals);
  try {
    JSON.parse(body);
  } catch {
    // The template is the caller's, so a body that does not parse is a caller bug - and one no
    // amount of retrying fixes.
    await failWith(entry, emit, {
      code: 'unknown',
      message: 'the filled body is not valid JSON',
      phase: 'creating',
      retryable: false,
    });
    return;
  }

  const outcome = await attempt(entry, signal, emit, 'creating', undefined, () => postJson(request.createPost.url, request.headers ?? {}, body, signal));
  if (!outcome) return;

  if (outcome.status >= 200 && outcome.status < 300) {
    const created = parseCreatedPost(outcome.body);
    if (!created) {
      await failWith(entry, emit, {
        code: 'http',
        message: `no postId in the response: ${errorMessage(outcome.body)}`,
        phase: 'creating',
        httpStatus: outcome.status,
        retryable: false,
      });
      return;
    }
    state.phase = 'done';
    state.percent = 100;
    state.postId = created.postId;
    state.published = created.published;
    delete state.error;
    entry.acked = false;
    await saveEntry(entry);
    emit('publishFinished', {
      pendingPostId: request.pendingPostId,
      postId: created.postId,
      published: created.published,
    });
    return;
  }

  await failWith(entry, emit, {
    ...classify(outcome.status, outcome.body),
    phase: 'creating',
    httpStatus: outcome.status,
  });
}

/**
 * Runs one request with the retry ladder behind it, or null when the job has stopped.
 *
 * No event goes out while it is backing off - the caller shows "waiting for connection", not "it
 * failed" - until the attempts are actually used up, which is the discipline `retryOrFail` keeps
 * natively.
 */
async function attempt<T>(
  entry: PublishEntry,
  signal: AbortSignal,
  emit: PublishEmitter,
  phase: 'uploading' | 'creating',
  uploadGuid: string | undefined,
  send: () => Promise<T>,
): Promise<T | null> {
  for (let tries = 0; tries < MAX_ATTEMPTS; tries++) {
    if (signal.aborted) return null;
    try {
      return await send();
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') return null;
      if (!(error instanceof NetworkError)) {
        await failWith(entry, emit, {
          code: 'unknown',
          message: describe(error),
          phase,
          ...(uploadGuid ? { uploadGuid } : {}),
          retryable: true,
        });
        return null;
      }
      if (tries === MAX_ATTEMPTS - 1) {
        await failWith(entry, emit, {
          code: 'network',
          message: error.message,
          phase,
          ...(uploadGuid ? { uploadGuid } : {}),
          retryable: true,
        });
        return null;
      }
      // Recorded but not announced, so a caller reading the state can see what is happening while
      // the pill still says "waiting".
      entry.state.error = {
        code: 'network',
        message: error.message,
        phase,
        ...(uploadGuid ? { uploadGuid } : {}),
        retryable: true,
      };
      await saveEntry(entry);
      if (!(await sleep(BACKOFF_MS[tries] ?? 120_000, signal))) return null;
    }
  }
  return null;
}

/** An HTTP status, as one of the contract's failure codes. The same split both workers make. */
function classify(status: number, body: string): { code: PublishFailureCode; message: string; retryable: boolean } {
  const message = errorMessage(body);
  // The server looked at this post and said no. Sending it again changes nothing.
  if (status === 400) return { code: 'server_rejected', message, retryable: false };
  // The token expired mid-job. Retryable, but only once the caller has a new one - so it stops here
  // rather than burning attempts against a wall.
  if (status === 401 || status === 403) return { code: 'auth', message, retryable: true };
  if (status >= 500) return { code: 'http', message, retryable: true };
  return { code: 'http', message, retryable: false };
}

async function failWith(entry: PublishEntry, emit: PublishEmitter, failure: Omit<PublishError, 'retryable'> & { retryable?: boolean }): Promise<void> {
  const error: PublishError = {
    ...failure,
    retryable: failure.retryable ?? isRetryable(failure.code),
  };
  entry.state.phase = 'failed';
  entry.state.error = error;
  entry.acked = false;
  await saveEntry(entry);
  emit('publishFailed', {
    pendingPostId: entry.request.pendingPostId,
    phase: error.phase,
    code: error.code,
    message: error.message,
    ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
  });
}

/* -------------------------------------------------------------------------------------------- */

function onBytes(entry: PublishEntry, uploadGuid: string, sent: number, emit: PublishEmitter): void {
  const pendingPostId = entry.request.pendingPostId;
  liveBytes.get(pendingPostId)?.set(uploadGuid, sent);

  const now = Date.now();
  if (now - (lastTick.get(pendingPostId) ?? 0) < PROGRESS_TICK_MS) return;
  lastTick.set(pendingPostId, now);

  const percent = computePercent(entry.state, bytesFor(pendingPostId));
  if (percent === lastPercent.get(pendingPostId)) return;
  lastPercent.set(pendingPostId, percent);
  emit('publishProgress', { pendingPostId, phase: 'uploading', percent });

  if (percent - (lastPersisted.get(pendingPostId) ?? 0) >= PERSIST_EVERY_PERCENT) {
    lastPersisted.set(pendingPostId, percent);
    entry.state.percent = percent;
    const upload = uploadFor(entry.state, uploadGuid);
    if (upload) upload.bytesSent = sent;
    void saveEntry(entry);
  }
}

function emitProgress(entry: PublishEntry, emit: PublishEmitter): void {
  const pendingPostId = entry.request.pendingPostId;
  const percent = computePercent(entry.state, bytesFor(pendingPostId));
  entry.state.percent = percent;
  emit('publishProgress', { pendingPostId, phase: 'uploading', percent });
}

/**
 * Holds a named lock for the length of the work, so two tabs cannot drive one post.
 *
 * `navigator.locks` is the only cross-tab mutex a page has; a browser without it, or a page in a
 * context where it is unavailable, runs the work unguarded - which is what this plugin did before
 * and is better than not running it at all.
 */
async function withLock(name: string, work: () => Promise<void>): Promise<void> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') {
    await work();
    return;
  }
  await locks.request(name, { ifAvailable: true }, async lock => {
    // Null means another tab already holds it, and that tab is already doing this work.
    if (!lock) return;
    await work();
  });
}

/** Waits, unless the job is cancelled first. False means it was. */
function sleep(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolveWith => {
    if (signal.aborted) {
      resolveWith(false);
      return;
    }
    const done = (ok: boolean): void => {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolveWith(ok);
    };
    const onAbort = (): void => done(false);
    const timer = setTimeout(() => done(true), ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
