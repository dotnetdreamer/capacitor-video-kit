import { WebPlugin } from '@capacitor/core';

import { describe } from '../web-runtime/files';

import type { PendingPostIdOptions, PostPublisherPlugin, PublishRequest, PublishState, RetryOptions } from './definitions';
import { abort, bytesFor, resumeAll, run } from './web/runner';
import { computePercent, IN_FLIGHT, TERMINAL } from './web/state';
import { allEntries, deleteEntry, freshEntry, loadEntry, saveEntry, stage, sweepPublishes, updateEntry } from './web/store';

/**
 * The background publisher, in a browser - where "background" means something smaller, and worth
 * being exact about.
 *
 * This plugin exists because a WebView upload dies the moment the page is frozen, so the whole
 * transaction is handed to the platform's own background machinery and survives the app being
 * swiped away or killed for memory. A browser has no such machinery. What it has instead, and what
 * this implementation uses, is durable storage and the next page load:
 *
 * - The request, the auth header, the body template and THE FILES THEMSELVES are copied into
 *   IndexedDB when the post is queued. A `blob:` URL dies with its document, so a record naming one
 *   would come back after a reload pointing at nothing.
 * - An upload that has an id from the server is never sent again, which is the invariant the native
 *   workers are built on and the reason a resumed post does not re-send a hundred megabytes.
 * - A post still in flight when the tab closed is picked up the next time the page opens.
 * - A Web Lock keeps two tabs off one post, so the app open twice cannot double-post.
 *
 * What it still cannot do is upload while the tab is closed. A host that needs that on the web
 * needs a service worker with Background Fetch, which only Chromium has and which belongs to the
 * application rather than to this package. `getState` answering honestly is how a host tells: a
 * post left in `uploading` with the page reopened is one this plugin is about to resume.
 */
export class PostPublisherWeb extends WebPlugin implements PostPublisherPlugin {
  private readonly driving = new Set<string>();

  constructor() {
    super();
    void this.load();
  }

  /**
   * Persists the request and starts it. Resolves as soon as it is queued; calling it again for a
   * post already in flight is a no-op, so a retried call cannot double-post.
   */
  async publish(request: PublishRequest): Promise<void> {
    const checked = validate(request);

    const existing = await loadEntry(checked.pendingPostId);
    if (existing && IN_FLIGHT.includes(existing.state.phase)) {
      // Already going. Saying yes again is what keeps a retried call from double-posting; picking
      // it back up covers the case where the record outlived the page that was driving it.
      if (!this.driving.has(checked.pendingPostId)) void this.drive(checked.pendingPostId);
      return;
    }

    // Fail now, loudly, with the page open, rather than mid-upload with nobody watching. This also
    // takes the durable copy the record is going to name.
    let staged: Awaited<ReturnType<typeof stage>>;
    try {
      staged = await stage(checked);
    } catch (error) {
      throw coded(describe(error), 'file_missing');
    }

    await saveEntry(freshEntry(staged.request, staged.sizes, existing));
    void this.drive(checked.pendingPostId);
  }

  /** `null` when nothing is known about this post - it never started, or its record was cleared. */
  async getState(options: PendingPostIdOptions): Promise<{ state: PublishState | null }> {
    const pendingPostId = required(options?.pendingPostId, 'pendingPostId');
    const entry = await loadEntry(pendingPostId);
    if (!entry) return { state: null };

    // Fold in the live byte counters: the record is written every few percent, and the caller
    // asking right now wants the current number, not the last persisted one.
    const live = bytesFor(pendingPostId);
    if (live.size > 0) {
      for (const upload of entry.state.uploads) {
        const bytes = live.get(upload.uploadGuid) ?? 0;
        if (bytes > upload.bytesSent) upload.bytesSent = bytes;
      }
      entry.state.percent = computePercent(entry.state, live);
    }
    if (TERMINAL.includes(entry.state.phase) && !entry.acked) {
      await updateEntry(pendingPostId, stored => {
        stored.acked = true;
      });
    }
    return { state: entry.state };
  }

  /** Stops the job. Upload ids already obtained are kept, so a retry does not re-send those files. */
  async cancel(options: PendingPostIdOptions): Promise<void> {
    const pendingPostId = required(options?.pendingPostId, 'pendingPostId');
    abort(pendingPostId);
    await updateEntry(pendingPostId, entry => {
      entry.state.phase = 'cancelled';
      // No error is recorded: the phase already says what happened, and a code of "cancelled" in
      // the error slot would show up as a failure in anything reading the state.
      delete entry.state.error;
      entry.acked = true;
    });
    // Deliberately no event: cancel is usually the first half of a discard, and a failure event
    // arriving between the two reads as something going wrong.
  }

  /** Re-queues from wherever it stopped, skipping files the server already has. */
  async retry(options: RetryOptions): Promise<void> {
    const pendingPostId = required(options?.pendingPostId, 'pendingPostId');
    const updated = await updateEntry(pendingPostId, entry => {
      if (options.headers) {
        entry.request.headers = { ...entry.request.headers, ...options.headers };
      }
      delete entry.state.error;
      entry.state.phase = 'queued';
      entry.state.attempts += 1;
      entry.acked = false;
      for (const upload of entry.state.uploads) {
        // Anything without an id goes back in the queue; anything with one is already done.
        if (!upload.downloadId) upload.status = 'queued';
      }
    });
    if (!updated) throw coded(`nothing to retry for ${pendingPostId}`, 'not_found');
    void this.drive(pendingPostId);
  }

  /** Forgets the record entirely. Does not touch the caller's own files - only our copies. */
  async clear(options: PendingPostIdOptions): Promise<void> {
    const pendingPostId = required(options?.pendingPostId, 'pendingPostId');
    abort(pendingPostId);
    await deleteEntry(pendingPostId);
  }

  /* ------------------------------------------------------------------------------------------ */

  private async drive(pendingPostId: string): Promise<void> {
    this.driving.add(pendingPostId);
    try {
      await run(pendingPostId, (event, data) => this.notifyListeners(event, data, true));
    } finally {
      this.driving.delete(pendingPostId);
    }
  }

  /**
   * Sweeps stale records and picks up whatever was in flight when the page last closed.
   *
   * The events those resumed jobs emit are RETAINED, which is what lets a host that attaches its
   * listener a tick after the plugin loads still hear about a post that finished in the meantime -
   * the same thing `replayUnacked` does natively.
   */
  private async load(): Promise<void> {
    try {
      await sweepPublishes();
      resumeAll(await allEntries(), (event, data) => this.notifyListeners(event, data, true));
    } catch {
      // A browser with no IndexedDB has nothing to sweep and nothing to resume, and a page that
      // cannot read its own storage still has to be able to publish.
    }
  }
}

/* -------------------------------------------------------------------------------------------- */

/** The same shape checks `PublishRequest.from` makes, with the same `invalid_request:` paths. */
function validate(input: PublishRequest): PublishRequest {
  const request = input as Partial<PublishRequest> | null | undefined;
  if (!request || typeof request !== 'object') throw invalidRequest('request');
  const pendingPostId = required(request.pendingPostId, 'pendingPostId');
  const uploadUrl = required(request.uploadUrl, 'uploadUrl');

  if (!Array.isArray(request.uploads) || request.uploads.length === 0) {
    throw invalidRequest('uploads');
  }
  const uploads = request.uploads.map((upload, index) => {
    const path = `uploads[${index}]`;
    if (!upload || typeof upload !== 'object') throw invalidRequest(path);
    if (!upload.uploadGuid) throw invalidRequest(`${path}.uploadGuid`);
    if (!upload.path) throw invalidRequest(`${path}.path`);
    if (upload.role !== 'stitched' && upload.role !== 'original') {
      throw invalidRequest(`${path}.role`);
    }
    return {
      uploadGuid: upload.uploadGuid,
      role: upload.role,
      path: upload.path,
      mimeType: upload.mimeType || 'application/octet-stream',
      ...(upload.pictureId && upload.pictureId > 0 ? { pictureId: upload.pictureId } : {}),
    };
  });

  const createPost = request.createPost;
  if (!createPost) throw invalidRequest('createPost');
  if (!createPost.url) throw invalidRequest('createPost.url');
  if (!createPost.bodyTemplate) throw invalidRequest('createPost.bodyTemplate');

  return {
    pendingPostId,
    headers: request.headers ?? {},
    uploadUrl,
    ...(request.lookupUrlTemplate ? { lookupUrlTemplate: request.lookupUrlTemplate } : {}),
    uploads,
    createPost: { url: createPost.url, bodyTemplate: createPost.bodyTemplate },
  };
}

function required(value: string | undefined, name: string): string {
  if (typeof value !== 'string' || value.length === 0) throw invalidRequest(name);
  return value;
}

function invalidRequest(path: string): Error {
  return coded(`invalid_request:${path}`, 'invalid_request');
}

/**
 * An `Error` carrying a `code`, which is what a Capacitor rejection looks like on the other side of
 * the bridge. A host that branches on `error.code` gets the same codes it gets from the phone.
 */
function coded(message: string, code: string): Error {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}
