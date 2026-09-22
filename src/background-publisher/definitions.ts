/**
 * `videokit-background-publisher` - uploads a batch of files and makes one finalizing call,
 * natively, in a way that survives the app being killed.
 *
 * The reason this is not `fetch` in a service worker: the customer taps the button and immediately
 * goes back to scrolling, switches apps, or locks the phone. A WebView upload dies the moment the
 * page is frozen. So the whole transaction - every file, then the finalize call - is handed to the
 * platform's own background machinery and survives the app being backgrounded, swiped away, or
 * killed for memory.
 *
 * Because it survives the app, it cannot depend on JavaScript being alive to drive it. Everything
 * the transaction needs - the URLs, the auth header, the field names, the body template - is
 * persisted natively as DATA, and the placeholders are filled in once the ids are known. That is
 * also why this plugin knows nothing whatsoever about your backend: there is no callback it could
 * ask, hours later, in a process your code is not running in. If it cannot be written down, it
 * cannot be used here.
 *
 * Nothing in this file names a domain. The plugin moves files and then makes one more call; what
 * the files are and what the call creates is entirely yours.
 */
import type { PluginListenerHandle } from '@capacitor/core';

/* -------------------------------------------------------------------------------------------- */
/* Request                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/**
 * How the bytes go up.
 *
 * - `POST` sends a multipart form: the file in `fileField`, plus whatever `fields` say.
 * - `PUT` sends the file as the raw request body, with no envelope at all. This is the shape every
 *   presigned URL wants - S3, R2, GCS, Azure - and there each file carries its own signed `url`.
 */
export type UploadMethod = 'POST' | 'PUT';

/**
 * The upload endpoint, described rather than assumed.
 *
 * Two placeholders may appear in `url`, in `fields` values and in `lookupUrlTemplate`:
 * `{uploadId}` and `{fileName}`. They are percent-encoded in URLs and left literal in form fields.
 */
export interface PublishTransport {
  /** Absolute URL, or a template. An upload's own `url` wins over this one. */
  url: string;

  /** Default `POST`. */
  method?: UploadMethod;

  /** `POST` only: the multipart part that carries the bytes. Default `file`. */
  fileField?: string;

  /**
   * `POST` only: text parts sent with every file, all of them before the file part.
   *
   * This is where a server's own upload convention goes. Fine Uploader's, for instance, is
   * `{ qquuid: '{uploadId}', qqfilename: '{fileName}' }` with `fileField: 'qqfile'`.
   *
   * The order the fields appear in among themselves is not promised - iOS receives them as a
   * dictionary and has none to preserve. No multipart parser depends on it; only the file being
   * last is guaranteed, so a streaming reader sees every small field before a large one.
   */
  fields?: Record<string, string>;

  /**
   * Dotted path to the server's id for the stored file in a JSON response - `downloadId`, or
   * `data.id`. The value's JSON type is kept, so a number stays a number when it reaches the
   * finalize template.
   *
   * Omit it when the URL already decides where the file landed, which is the presigned case: the
   * upload's own `uploadId` becomes its id and nothing is parsed out of the response.
   */
  idPath?: string;

  /**
   * Absolute URL template, with `{uploadId}` where the id goes, for asking whether the server
   * already has a file whose response was lost. Used after a process death to avoid sending the
   * same bytes twice. Optional; without it such a file is simply uploaded again.
   */
  lookupUrlTemplate?: string;
}

export interface PublishUpload {
  /** Your own id for this file. Also the default uploaded filename, and the finalize token key. */
  uploadId: string;

  /**
   * A free-form label, for grouping in the finalize template - `"$IDS:<tag>"` collects every id
   * carrying this one. The plugin never interprets it; the only rule is that it may not contain a
   * double quote, because that is what ends the token. Defaults to `''`.
   */
  tag?: string;

  /** `file://` path of the file to send. */
  path: string;

  mimeType: string;

  /** Overrides the transport's `url` for this file alone - one presigned URL per file. */
  url?: string;

  /** Overrides the default `<uploadId>.<ext>`. */
  fileName?: string;

  /** `POST` only: extra parts for this file, merged over the transport's, these winning. */
  fields?: Record<string, string>;
}

export interface PublishFinalize {
  url: string;

  /** Default `POST`. */
  method?: 'POST' | 'PUT';

  /**
   * The complete JSON body, with tokens standing in for ids that do not exist yet. Each is
   * replaced textually, quotes included, so a string placeholder becomes a bare JSON value:
   *
   * - `"$ID:<uploadId>"` - that one upload's id.
   * - `"$IDS:<tag>"` - a JSON array of the ids tagged that way, in the order they were given, and
   *   `[]` when nothing in this batch carries the tag.
   * - `"$IDS"` - a JSON array of every id, in the order they were given.
   *
   * Replacement is by literal string, never a pattern: the body carries text your customer wrote,
   * which may contain anything at all, and a `$` in it must stay a `$`. The same rule is why a
   * token naming an upload that is not in the batch is left exactly as it is rather than being
   * hunted for - the plugin cannot tell a typo from a sentence - so check your ids. Every upload
   * in the batch must have an id before this body is sent, and that IS enforced.
   */
  bodyTemplate: string;

  /**
   * Dotted path that must carry a value in a 2xx response, or the call counts as
   * `server_rejected`. For a server that reports failure in the body of a 200. Optional.
   */
  requirePath?: string;
}

export interface PublishRequest {
  /** Your id for this batch. Everything - state, events, cancel, retry - is addressed by it. */
  batchId: string;

  /** Sent on every request in the batch, uploads and finalize alike. */
  headers: Record<string, string>;

  upload: PublishTransport;

  /** Sent one at a time, in this order. */
  uploads: PublishUpload[];

  finalize: PublishFinalize;
}

/* -------------------------------------------------------------------------------------------- */
/* State                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export type PublishPhase = 'queued' | 'uploading' | 'finalizing' | 'done' | 'failed' | 'cancelled';

export type PublishUploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface PublishUploadState {
  uploadId: string;
  tag: string;
  status: PublishUploadStatus;

  /**
   * The server's id for the stored file, once it has one. Its presence is what stops a re-send.
   *
   * The JSON type the server used is kept: an id that arrived as a number goes back into the
   * finalize body as a number, and one that arrived as a string goes back quoted. Without a
   * transport `idPath` this is the upload's own `uploadId`.
   */
  remoteId?: string | number;

  httpStatus?: number;
  bytesSent: number;
  bytesTotal: number;
}

export type PublishFailureCode = 'network' | 'http' | 'auth' | 'server_rejected' | 'file_missing' | 'cancelled' | 'unknown';

export interface PublishError {
  code: PublishFailureCode;
  message: string;
  httpStatus?: number;
  /** Which half of the job was running. */
  phase: 'uploading' | 'finalizing';
  uploadId?: string;
  /** False when trying again cannot help - a rejected body, a file that is gone. */
  retryable: boolean;
}

export interface PublishState {
  batchId: string;
  phase: PublishPhase;
  /** 0..100 across the whole job; only reaches 100 once the finalize call has answered. */
  percent: number;
  uploads: PublishUploadState[];

  /**
   * The finalize response, parsed, once the job is done. Whatever your server sent back - this
   * plugin reads nothing out of it beyond `finalize.requirePath`, if you set one.
   */
  result?: unknown;

  error?: PublishError;
  /** How many times this batch has been handed to the platform. */
  attempts: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Events                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export interface PublishProgressEvent {
  batchId: string;
  phase: 'uploading' | 'finalizing';
  percent: number;
}

export interface PublishFinishedEvent {
  batchId: string;
  /** The finalize response, parsed. Absent when the body was not JSON. */
  result?: unknown;
}

export interface PublishFailedEvent {
  batchId: string;
  phase: 'uploading' | 'finalizing';
  code: PublishFailureCode;
  message: string;
  httpStatus?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Plugin                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export interface BatchOptions {
  batchId: string;
}

export interface RetryOptions extends BatchOptions {
  /** Replaces the stored headers - how a refreshed token gets in after an auth failure. */
  headers?: Record<string, string>;
}

export interface BackgroundPublisherPlugin {
  /**
   * Persists the request and hands it to the platform. Resolves as soon as it is queued; calling
   * it again for a batch already in flight is a no-op, so a retried call cannot send twice.
   */
  publish(request: PublishRequest): Promise<void>;

  /** `null` when nothing is known about this batch - it never started, or its record was cleared. */
  getState(options: BatchOptions): Promise<{ state: PublishState | null }>;

  /** Stops the job. Ids already obtained are kept, so a retry does not re-send those files. */
  cancel(options: BatchOptions): Promise<void>;

  /** Re-queues from wherever it stopped, skipping files the server already has. */
  retry(options: RetryOptions): Promise<void>;

  /** Forgets the record entirely. Does not touch the files. */
  clear(options: BatchOptions): Promise<void>;

  addListener(eventName: 'publishProgress', listener: (event: PublishProgressEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'publishFinished', listener: (event: PublishFinishedEvent) => void): Promise<PluginListenerHandle>;
  addListener(eventName: 'publishFailed', listener: (event: PublishFailedEvent) => void): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
