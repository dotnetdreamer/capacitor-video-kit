import { deleteFolder, describe, putFile, urlForFile } from '../../web-runtime/files';
import { idbDelete, idbGet, idbPut, idbValues, JOBS_STORE } from '../../web-runtime/idb';
import type { ComposeError, ComposeResult, ComposeSpec, JobState, JobStateName } from '../definitions';

import { RenderFailure, renderSpec } from './render';

/**
 * The register of renders, and the only thing in the web composer that outlives a page.
 *
 * Natively, `getState` rejects with `job_not_found` after a process restart, because a render lives
 * in a foreground service and dies with it. A browser can do BETTER than that, and this is where it
 * does: every job's record, and the finished video's bytes, go into IndexedDB as they are produced,
 * so a customer who reloads after a render has finished comes back to a finished render rather than
 * to one that has to happen again. What a browser cannot do is keep RENDERING while the page is
 * gone, so a job interrupted by a reload comes back as `interrupted` - the word the contract already
 * has for a render the platform stopped.
 *
 * The result is stored under its durable name and handed out as a `blob:` URL, because those are
 * the two different things a record and a caller each need. See `web-runtime/files.ts`.
 */

/** Terminal records are swept after a day, the same retention the native job folders keep. */
const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

/** What goes in the store. `result.uri` here is the DURABLE name, never a `blob:` URL. */
interface JobRecord {
  jobId: string;
  pendingPostId: string;
  state: JobStateName;
  progress: number;
  result?: ComposeResult;
  error?: ComposeError;
  /** Epoch milliseconds, for the sweep. */
  updatedAt: number;
}

/** How a running job is driven and cancelled, for as long as this page is the one running it. */
interface LiveJob {
  record: JobRecord;
  abort: AbortController;
}

export type JobEmitter = (event: 'progress' | 'completed' | 'failed', data: object) => void;

const live = new Map<string, LiveJob>();

/**
 * Starts a render, or answers the id of one already under way.
 *
 * Composing the same id twice starts ONE render; that is what makes a retry after a lost response
 * safe, and it is the same promise both native plugins make. A job already finished is not run
 * again either - the caller has an answer to that id already, and a second run would hand it a
 * second file.
 */
export async function startJob(spec: ComposeSpec, emit: JobEmitter): Promise<{ jobId: string }> {
  if (live.has(spec.jobId)) return { jobId: spec.jobId };

  const stored = await readRecord(spec.jobId);
  if (stored?.state === 'done') return { jobId: spec.jobId };

  const record: JobRecord = {
    jobId: spec.jobId,
    pendingPostId: spec.pendingPostId,
    state: 'pending',
    progress: 0,
    updatedAt: Date.now(),
  };
  const job: LiveJob = { record, abort: new AbortController() };
  live.set(spec.jobId, job);
  await save(record);

  // Deliberately not awaited: `compose()` resolves with the id as soon as the job is registered and
  // the outcome arrives as an event, which is the whole shape of the contract.
  void run(spec, job, emit);
  return { jobId: spec.jobId };
}

/**
 * What is known about a job, with the result's URL freshly minted for this document.
 *
 * Rejects the way the native plugins do for an id nobody has heard of - the caller has the manifest
 * and can start again, and nothing here can tell it more than that.
 */
export async function jobState(jobId: string): Promise<JobState> {
  const record = live.get(jobId)?.record ?? (await readRecord(jobId));
  if (!record) throw new Error(`no job with id ${jobId}`);
  const state: JobState = { jobId, state: record.state, progress: record.progress };
  if (record.result) state.result = await loadable(record.result);
  if (record.error) state.error = record.error;
  return state;
}

/** Stops a running render. Safe on unknown ids, exactly as the contract says. */
export function cancelJob(jobId: string): void {
  live.get(jobId)?.abort.abort();
}

/**
 * Forgets every job of one pending post and deletes its folder - the web half of `cleanup`.
 *
 * Anything still rendering into that folder is stopped first, because a render that finished
 * writing after the folder went would put its file back and leave it there for good.
 */
export async function cleanupPendingPost(pendingPostId: string): Promise<void> {
  for (const [jobId, job] of live) {
    if (job.record.pendingPostId !== pendingPostId) continue;
    job.abort.abort();
    live.delete(jobId);
  }
  for (const record of await idbValues<JobRecord>(JOBS_STORE)) {
    if (record?.pendingPostId === pendingPostId) await idbDelete(JOBS_STORE, record.jobId);
  }
  await deleteFolder(pendingPostId);
}

/**
 * Marks whatever was rendering when the page went away, and drops records nobody will read again.
 *
 * Called once when the plugin loads. A record left in `pending` or `rendering` cannot be either of
 * those any more - there is no page running it - so it becomes `interrupted`, which is the honest
 * answer and the one a host already knows how to put a Retry behind.
 */
export async function sweepJobs(): Promise<void> {
  const now = Date.now();
  for (const record of await idbValues<JobRecord>(JOBS_STORE)) {
    if (!record?.jobId || live.has(record.jobId)) continue;
    if (record.state === 'pending' || record.state === 'rendering') {
      await save({ ...record, state: 'interrupted' });
      continue;
    }
    const terminal = record.state === 'done' || record.state === 'failed';
    if (terminal && now - record.updatedAt > DONE_RETENTION_MS) {
      await idbDelete(JOBS_STORE, record.jobId);
    }
  }
}

/* -------------------------------------------------------------------------------------------- */

async function run(spec: ComposeSpec, job: LiveJob, emit: JobEmitter): Promise<void> {
  const { jobId, pendingPostId } = spec;
  try {
    job.record.state = 'rendering';
    await save(job.record);

    const outcome = await renderSpec(spec, {
      signal: job.abort.signal,
      onProgress: progress => {
        job.record.progress = progress;
        emit('progress', { jobId, progress });
      },
    });

    const video = await putFile(pendingPostId, `${jobId}.mp4`, outcome.blob);
    const poster = outcome.poster ? await putFile(pendingPostId, `${jobId}-poster.jpg`, outcome.poster) : null;

    const result: ComposeResult = {
      jobId,
      uri: video.uri,
      posterUri: poster?.uri ?? '',
      durationMs: outcome.durationMs,
      width: outcome.width,
      height: outcome.height,
      bytes: outcome.blob.size,
    };
    job.record.state = 'done';
    job.record.progress = 1;
    job.record.result = result;
    await save(job.record);

    // The event carries loadable URLs; the record keeps the durable names. A caller that never
    // listens asks `getState` for the same thing and gets URLs minted for whatever page it is on.
    emit('completed', await loadable(result));
  } catch (error) {
    const failure = error instanceof RenderFailure ? error : new RenderFailure('unknown', describe(error));
    const composeError: ComposeError = {
      jobId,
      code: failure.code,
      message: failure.message,
      ...(failure.clipKey ? { clipKey: failure.clipKey } : {}),
    };
    job.record.state = 'failed';
    job.record.error = composeError;
    await save(job.record);
    emit('failed', composeError);
  } finally {
    // The live entry goes, the record stays: `getState` reads the record, and holding the abort
    // controller and the spec after the job has ended would keep every source URL alive with them.
    live.delete(jobId);
  }
}

/** The result with `blob:` URLs a page can load, out of the durable names the record holds. */
async function loadable(result: ComposeResult): Promise<ComposeResult> {
  return {
    ...result,
    uri: (await urlForFile(result.uri)) ?? result.uri,
    posterUri: result.posterUri ? ((await urlForFile(result.posterUri)) ?? '') : '',
  };
}

async function readRecord(jobId: string): Promise<JobRecord | null> {
  const record = await idbGet<JobRecord>(JOBS_STORE, jobId);
  return record?.jobId ? record : null;
}

async function save(record: JobRecord): Promise<void> {
  record.updatedAt = Date.now();
  await idbPut(JOBS_STORE, record.jobId, { ...record });
}
