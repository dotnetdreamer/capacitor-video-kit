import { describe, resolve } from '../../web-runtime/files';
import { holdPageOpen } from '../../web-runtime/leave-guard';
import type { PublishError, PublishFailureCode } from '../definitions';

import { errorMessage, hasValueAt, lookupRemoteId, NetworkError, parseJson, parseRemoteId, sendJson, uploadFile } from './http';
import { BACKOFF_MS, computePercent, FINALIZING_PERCENT, IN_FLIGHT, isRetryable, MAX_ATTEMPTS, uploadFor } from './state';
import { loadEntry, saveEntry, type PublishEntry } from './store';
import { fill, type FillUpload } from './template-fill';

/**
 * Sends every file of one batch, in order, then makes the finalize call - the web's version of the
 * two chained workers.
 *
 * Two steps rather than one loop, for the reason `Workers.kt` gives: a failure finalizing must
 * retry only the finalize call. The uploads are the expensive part and are already done by the
 * time it runs, and re-sending a hundred megabytes because one call got a 503 would be
 * indefensible.
 *
 * The invariant that makes all of this safe to re-run is the native one, unchanged: AN UPLOAD WITH
 * A `remoteId` IS NEVER SENT AGAIN. A reload, a dropped connection and a cancelled-then-retried
 * batch all come back to this function, and each time it picks up exactly where the record says it
 * stopped. A file that was mid-flight when the page went is looked up first, because the server may
 * well have the whole thing already and only the response was lost.
 *
 * What is NOT the native behaviour, and cannot be: none of this survives the page. WorkManager can
 * restart a process to finish an upload with the app closed; a browser cannot run anything at all
 * once the tab is gone. So the retry ladder runs inside this function instead of being handed to
 * the platform, and a batch interrupted by a closed tab resumes when the page is next opened, from
 * `resumeAll`.
 *
 * A Web Lock keeps two tabs off one batch. Without it, a customer with the app open twice would
 * upload every file twice and finalize twice, which is the one failure this plugin exists to
 * prevent.
 */

export type PublishEmitter = (event: 'publishProgress' | 'publishFinished' | 'publishFailed', data: object) => void;

/** How often the bar may move. Any faster is work rather than feedback. */
const PROGRESS_TICK_MS = 500;

/** The record is written far less often than the counter moves; it only has to be resumable. */
const PERSIST_EVERY_PERCENT = 5;

/** Byte counters for jobs running in THIS page, so `getState` can answer with the live number. */
const liveBytes = new Map<string, Map<string, number>>();

/** One abort per batch, for `cancel`. */
const running = new Map<string, AbortController>();

const lastTick = new Map<string, number>();
const lastPercent = new Map<string, number>();
const lastPersisted = new Map<string, number>();

/** The live byte counters for one batch, for `getState` to fold in. */
export function bytesFor(batchId: string): ReadonlyMap<string, number> {
  return liveBytes.get(batchId) ?? new Map<string, number>();
}

export function isRunning(batchId: string): boolean {
  return running.has(batchId);
}

export function abort(batchId: string): void {
  running.get(batchId)?.abort();
}

/**
 * Drives one batch to a terminal state. Resolves when it stops, however it stops.
 *
 * Deliberately never rejects: every outcome is written to the record and announced as an event, and
 * a caller of `publish` has had its answer long before this finishes.
 */
export async function run(batchId: string, emit: PublishEmitter): Promise<void> {
  if (running.has(batchId)) return;
  const controller = new AbortController();
  running.set(batchId, controller);
  liveBytes.set(batchId, new Map());
  // An upload stops with the tab, so the customer is asked before the tab goes. It resumes on the
  // next page load either way - see `resumeAll` - but a batch half sent is worth a question.
  const release = holdPageOpen(`uploading ${batchId}`);

  try {
    await withLock(`videokit-publish-${batchId}`, async () => {
      const entry = await loadEntry(batchId);
      if (!entry || !IN_FLIGHT.includes(entry.state.phase)) return;
      const uploaded = await sendFiles(entry, controller.signal, emit);
      if (!uploaded) return;
      await finalize(entry, controller.signal, emit);
    });
  } catch (error) {
    // Only an unexpected failure reaches here - the two steps handle their own - and the record
    // still has to say something, or the batch sits in `uploading` for ever.
    const entry = await loadEntry(batchId);
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
    running.delete(batchId);
    liveBytes.delete(batchId);
    lastTick.delete(batchId);
    lastPercent.delete(batchId);
    lastPersisted.delete(batchId);
  }
}

/**
 * Picks up every batch that was in flight when the page last closed.
 *
 * Called once when the plugin loads. This is the whole of what a browser can offer in place of
 * WorkManager restarting a process: the work resumes the next time the customer is here.
 */
export function resumeAll(entries: readonly PublishEntry[], emit: PublishEmitter): void {
  for (const entry of entries) {
    if (!IN_FLIGHT.includes(entry.state.phase)) continue;
    void run(entry.request.batchId, emit);
  }
}

/* -------------------------------------------------------------------------------------------- */

/** Every file, in the order given. False when the job stopped before they were all in. */
async function sendFiles(entry: PublishEntry, signal: AbortSignal, emit: PublishEmitter): Promise<boolean> {
  const { request, state } = entry;
  state.phase = 'uploading';
  await saveEntry(entry);

  for (const upload of request.uploads) {
    const uploadState = uploadFor(state, upload.uploadId);
    if (!uploadState) {
      await failWith(entry, emit, {
        code: 'unknown',
        message: `no record for ${upload.uploadId}`,
        phase: 'uploading',
        uploadId: upload.uploadId,
        retryable: false,
      });
      return false;
    }

    // Already accepted by the server, this run or a previous one.
    if (uploadState.remoteId !== undefined) continue;

    // Interrupted mid-flight: the server may have the file even though we never saw the answer.
    // Asking is a great deal cheaper than sending it again.
    if (uploadState.status === 'uploading') {
      const recovered = await lookupRemoteId(request, upload.uploadId, signal);
      if (recovered !== null) {
        uploadState.remoteId = recovered;
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
        message: `missing ${upload.uploadId}`,
        phase: 'uploading',
        uploadId: upload.uploadId,
        retryable: false,
      });
      return false;
    }

    uploadState.status = 'uploading';
    uploadState.bytesTotal = blob.size;
    await saveEntry(entry);

    const outcome = await attempt(entry, signal, emit, 'uploading', upload.uploadId, () =>
      uploadFile(request, upload, blob, {
        signal,
        onBytes: sent => onBytes(entry, upload.uploadId, sent, emit),
      }),
    );
    if (!outcome) return false;

    if (outcome.status >= 200 && outcome.status < 300) {
      // Without an `idPath` the URL already decided where the file went - the presigned case - so
      // the upload's own id is its id, and nothing is read out of the response.
      const remoteId = request.upload.idPath ? parseRemoteId(outcome.body, request.upload.idPath) : upload.uploadId;
      if (remoteId === null) {
        await failWith(entry, emit, {
          code: 'http',
          message: `no id at ${request.upload.idPath} in the response: ${errorMessage(outcome.body)}`,
          phase: 'uploading',
          uploadId: upload.uploadId,
          httpStatus: outcome.status,
          retryable: false,
        });
        return false;
      }
      uploadState.remoteId = remoteId;
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
      uploadId: upload.uploadId,
      httpStatus: outcome.status,
    });
    return false;
  }
  return true;
}

/** Fills the caller's body template with the ids the uploads produced, and makes the call. */
async function finalize(entry: PublishEntry, signal: AbortSignal, emit: PublishEmitter): Promise<void> {
  const { request, state } = entry;
  // Idempotent: the call has already been made and answered, so a rerun must not repeat it. The
  // phase is the marker rather than a field of the response, because the response belongs to the
  // caller and may be empty - a 204 finishes a batch just as well as a body. Both native engines
  // use the same marker.
  if (state.phase === 'done') return;

  state.phase = 'finalizing';
  state.percent = FINALIZING_PERCENT;
  await saveEntry(entry);
  emit('publishProgress', {
    batchId: request.batchId,
    phase: 'finalizing',
    percent: FINALIZING_PERCENT,
  });

  const filled: FillUpload[] = [];
  for (const upload of state.uploads) {
    if (upload.remoteId === undefined) {
      await failWith(entry, emit, {
        code: 'unknown',
        message: `upload ${upload.uploadId} has no id`,
        phase: 'finalizing',
        retryable: false,
      });
      return;
    }
    filled.push({ uploadId: upload.uploadId, tag: upload.tag, remoteId: upload.remoteId });
  }

  const body = fill(request.finalize.bodyTemplate, filled);
  if (parseJson(body) === undefined) {
    // The template is the caller's, so a body that does not parse is a caller bug - and one no
    // amount of retrying fixes.
    await failWith(entry, emit, {
      code: 'unknown',
      message: 'the filled body is not valid JSON',
      phase: 'finalizing',
      retryable: false,
    });
    return;
  }

  const method = request.finalize.method ?? 'POST';
  const outcome = await attempt(entry, signal, emit, 'finalizing', undefined, () => sendJson(request.finalize.url, method, request.headers ?? {}, body, signal));
  if (!outcome) return;

  if (outcome.status >= 200 && outcome.status < 300) {
    // A server that reports failure in the body of a 200 - and there are many - is caught here,
    // but only when the caller said which field to look at. Guessing would be worse than nothing.
    if (!hasValueAt(outcome.body, request.finalize.requirePath)) {
      await failWith(entry, emit, {
        code: 'server_rejected',
        message: `nothing at ${request.finalize.requirePath} in the response: ${errorMessage(outcome.body)}`,
        phase: 'finalizing',
        httpStatus: outcome.status,
        retryable: false,
      });
      return;
    }
    // Absent rather than null when the body was not JSON: a 204 finishes a batch too, and a
    // caller reading `result` should be able to tell "nothing was sent" from "null was sent".
    // Both native engines leave the key out in the same case.
    const result = parseJson(outcome.body);
    state.phase = 'done';
    state.percent = 100;
    if (result !== undefined) state.result = result;
    delete state.error;
    entry.acked = false;
    await saveEntry(entry);
    emit('publishFinished', { batchId: request.batchId, ...(result !== undefined ? { result } : {}) });
    return;
  }

  await failWith(entry, emit, {
    ...classify(outcome.status, outcome.body),
    phase: 'finalizing',
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
  phase: 'uploading' | 'finalizing',
  uploadId: string | undefined,
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
          ...(uploadId ? { uploadId } : {}),
          retryable: true,
        });
        return null;
      }
      if (tries === MAX_ATTEMPTS - 1) {
        await failWith(entry, emit, {
          code: 'network',
          message: error.message,
          phase,
          ...(uploadId ? { uploadId } : {}),
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
        ...(uploadId ? { uploadId } : {}),
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
  // The server looked at this and said no. Sending it again changes nothing.
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
    batchId: entry.request.batchId,
    phase: error.phase,
    code: error.code,
    message: error.message,
    ...(error.httpStatus !== undefined ? { httpStatus: error.httpStatus } : {}),
  });
}

/* -------------------------------------------------------------------------------------------- */

function onBytes(entry: PublishEntry, uploadId: string, sent: number, emit: PublishEmitter): void {
  const batchId = entry.request.batchId;
  liveBytes.get(batchId)?.set(uploadId, sent);

  const now = Date.now();
  if (now - (lastTick.get(batchId) ?? 0) < PROGRESS_TICK_MS) return;
  lastTick.set(batchId, now);

  const percent = computePercent(entry.state, bytesFor(batchId));
  if (percent === lastPercent.get(batchId)) return;
  lastPercent.set(batchId, percent);
  emit('publishProgress', { batchId, phase: 'uploading', percent });

  if (percent - (lastPersisted.get(batchId) ?? 0) >= PERSIST_EVERY_PERCENT) {
    lastPersisted.set(batchId, percent);
    entry.state.percent = percent;
    const upload = uploadFor(entry.state, uploadId);
    if (upload) upload.bytesSent = sent;
    void saveEntry(entry);
  }
}

function emitProgress(entry: PublishEntry, emit: PublishEmitter): void {
  const batchId = entry.request.batchId;
  const percent = computePercent(entry.state, bytesFor(batchId));
  entry.state.percent = percent;
  emit('publishProgress', { batchId, phase: 'uploading', percent });
}

/**
 * Holds a named lock for the length of the work, so two tabs cannot drive one batch.
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
