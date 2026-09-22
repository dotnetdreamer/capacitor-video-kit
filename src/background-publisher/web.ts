import { WebPlugin } from '@capacitor/core';

import { describe } from '../web-runtime/files';

import type { BackgroundPublisherPlugin, BatchOptions, PublishRequest, PublishState, RetryOptions } from './definitions';
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
 *   IndexedDB when the batch is queued. A `blob:` URL dies with its document, so a record naming
 *   one would come back after a reload pointing at nothing.
 * - An upload that has an id from the server is never sent again, which is the invariant the native
 *   workers are built on and the reason a resumed batch does not re-send a hundred megabytes.
 * - A batch still in flight when the tab closed is picked up the next time the page opens.
 * - A Web Lock keeps two tabs off one batch, so the app open twice cannot send twice.
 *
 * What it still cannot do is upload while the tab is closed. A host that needs that on the web
 * needs a service worker with Background Fetch, which only Chromium has and which belongs to the
 * application rather than to this package. `getState` answering honestly is how a host tells: a
 * batch left in `uploading` with the page reopened is one this plugin is about to resume.
 */
export class BackgroundPublisherWeb extends WebPlugin implements BackgroundPublisherPlugin {
  private readonly driving = new Set<string>();

  constructor() {
    super();
    void this.load();
  }

  /**
   * Persists the request and starts it. Resolves as soon as it is queued; calling it again for a
   * batch already in flight is a no-op, so a retried call cannot send twice.
   */
  async publish(request: PublishRequest): Promise<void> {
    const checked = validate(request);

    const existing = await loadEntry(checked.batchId);
    if (existing && IN_FLIGHT.includes(existing.state.phase)) {
      // Already going. Saying yes again is what keeps a retried call from sending twice; picking
      // it back up covers the case where the record outlived the page that was driving it.
      if (!this.driving.has(checked.batchId)) void this.drive(checked.batchId);
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
    void this.drive(checked.batchId);
  }

  /** `null` when nothing is known about this batch - it never started, or its record was cleared. */
  async getState(options: BatchOptions): Promise<{ state: PublishState | null }> {
    const batchId = required(options?.batchId, 'batchId');
    const entry = await loadEntry(batchId);
    if (!entry) return { state: null };

    // Fold in the live byte counters: the record is written every few percent, and the caller
    // asking right now wants the current number, not the last persisted one.
    const live = bytesFor(batchId);
    if (live.size > 0) {
      for (const upload of entry.state.uploads) {
        const bytes = live.get(upload.uploadId) ?? 0;
        if (bytes > upload.bytesSent) upload.bytesSent = bytes;
      }
      entry.state.percent = computePercent(entry.state, live);
    }
    if (TERMINAL.includes(entry.state.phase) && !entry.acked) {
      await updateEntry(batchId, stored => {
        stored.acked = true;
      });
    }
    return { state: entry.state };
  }

  /** Stops the job. Ids already obtained are kept, so a retry does not re-send those files. */
  async cancel(options: BatchOptions): Promise<void> {
    const batchId = required(options?.batchId, 'batchId');
    abort(batchId);
    await updateEntry(batchId, entry => {
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
    const batchId = required(options?.batchId, 'batchId');
    const updated = await updateEntry(batchId, entry => {
      if (options.headers) {
        entry.request.headers = { ...entry.request.headers, ...options.headers };
      }
      delete entry.state.error;
      entry.state.phase = 'queued';
      entry.state.attempts += 1;
      entry.acked = false;
      for (const upload of entry.state.uploads) {
        // Anything without an id goes back in the queue; anything with one is already done.
        if (upload.remoteId === undefined) upload.status = 'queued';
      }
    });
    if (!updated) throw coded(`nothing to retry for ${batchId}`, 'not_found');
    void this.drive(batchId);
  }

  /** Forgets the record entirely. Does not touch the caller's own files - only our copies. */
  async clear(options: BatchOptions): Promise<void> {
    const batchId = required(options?.batchId, 'batchId');
    abort(batchId);
    await deleteEntry(batchId);
  }

  /* ------------------------------------------------------------------------------------------ */

  private async drive(batchId: string): Promise<void> {
    this.driving.add(batchId);
    try {
      await run(batchId, (event, data) => this.notifyListeners(event, data, true));
    } finally {
      this.driving.delete(batchId);
    }
  }

  /**
   * Sweeps stale records and picks up whatever was in flight when the page last closed.
   *
   * The events those resumed jobs emit are RETAINED, which is what lets a host that attaches its
   * listener a tick after the plugin loads still hear about a batch that finished in the meantime -
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
  const batchId = required(request.batchId, 'batchId');

  const transport = request.upload;
  if (!transport || typeof transport !== 'object') throw invalidRequest('upload');
  const transportUrl = required(transport.url, 'upload.url');
  const method = transport.method ?? 'POST';
  if (method !== 'POST' && method !== 'PUT') throw invalidRequest('upload.method');

  if (!Array.isArray(request.uploads) || request.uploads.length === 0) {
    throw invalidRequest('uploads');
  }
  const uploads = request.uploads.map((upload, index) => {
    const path = `uploads[${index}]`;
    if (!upload || typeof upload !== 'object') throw invalidRequest(path);
    if (!upload.uploadId) throw invalidRequest(`${path}.uploadId`);
    if (!upload.path) throw invalidRequest(`${path}.path`);
    return {
      uploadId: upload.uploadId,
      tag: upload.tag ?? '',
      path: upload.path,
      mimeType: upload.mimeType || 'application/octet-stream',
      ...(upload.url ? { url: upload.url } : {}),
      ...(upload.fileName ? { fileName: upload.fileName } : {}),
      ...(upload.fields ? { fields: upload.fields } : {}),
    };
  });

  const finalizeStep = request.finalize;
  if (!finalizeStep) throw invalidRequest('finalize');
  if (!finalizeStep.url) throw invalidRequest('finalize.url');
  if (!finalizeStep.bodyTemplate) throw invalidRequest('finalize.bodyTemplate');
  const finalizeMethod = finalizeStep.method ?? 'POST';
  if (finalizeMethod !== 'POST' && finalizeMethod !== 'PUT') throw invalidRequest('finalize.method');

  return {
    batchId,
    headers: request.headers ?? {},
    upload: {
      url: transportUrl,
      method,
      ...(transport.fileField ? { fileField: transport.fileField } : {}),
      ...(transport.fields ? { fields: transport.fields } : {}),
      ...(transport.idPath ? { idPath: transport.idPath } : {}),
      ...(transport.lookupUrlTemplate ? { lookupUrlTemplate: transport.lookupUrlTemplate } : {}),
    },
    uploads,
    finalize: {
      url: finalizeStep.url,
      method: finalizeMethod,
      bodyTemplate: finalizeStep.bodyTemplate,
      ...(finalizeStep.requirePath ? { requirePath: finalizeStep.requirePath } : {}),
    },
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
