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
 *
 * Android needs nothing from the host for the transaction to outlive the app: WorkManager starts
 * from the manifest. iOS needs two lines in the host's `AppDelegate`, because the system hands a
 * finished transfer back to the app through it, and a plugin cannot be reached there - UIKit
 * usually connects no scene, and so builds no Capacitor bridge, when it relaunches an app in the
 * background for one. With `import CapacitorVideoKitCore`, `PublisherSession.warmUp()` goes in
 * `application(_:didFinishLaunchingWithOptions:)`, which makes the background session again at
 * every launch so it can deliver what finished while the app was gone, and
 * `application(_:handleEventsForBackgroundURLSession:completionHandler:)` passes its identifier and
 * handler to `PublisherSession.handleEvents(identifier:completionHandler:)`, which calls that
 * handler once everything has been delivered. Without them a finalize call that falls due while the
 * app is in the background waits until the customer next opens it, and iOS, never told that the app
 * has dealt with a wake, may hold back the ones that follow. The README has the code.
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

  /**
   * `file://` path of the file to send.
   *
   * A file that is missing or empty - 0 bytes counts as missing - is refused by `publish()` with
   * `file_missing` on every platform. On Android and iOS it then has to stay where it is, as it is,
   * until the batch is done: every send reads it again - an automatic resend after a 5xx or a
   * dropped connection, a `retry()`, a restart after the app was killed - and a file that has gone
   * or emptied by then fails the batch as `file_missing`, not retryable. iOS sends from a private
   * copy, so deleting or rewriting the file does not spoil a send already in flight there, but the
   * next send still reads the file. The web is the exception: a `blob:` URL dies with the page, so
   * `publish()` copies the bytes into IndexedDB and every send reads that copy.
   *
   * Percent-encoded, as the composer hands its results back: iOS takes a raw `#` or `?` in a
   * `file://` URI as part of the name, where Android's `Uri` cuts the path there.
   */
  path: string;

  mimeType: string;

  /** Overrides the transport's `url` for this file alone - one presigned URL per file. */
  url?: string;

  /**
   * Overrides the default `<uploadId>.<ext>`, where `<ext>` is the extension of the file `path`
   * names. Also what `{fileName}` stands for.
   */
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
   *
   * An id goes in as JSON: a number bare, a string quoted and escaped. The escaping is
   * `JSON.stringify`'s on the web and iOS, and Android's `JSONObject.quote` writes a `/` as `\/`
   * as well, so for an id with a slash in it the text differs while the JSON it parses to does not.
   */
  bodyTemplate: string;

  /**
   * Dotted path that must carry a value in a 2xx response, or the call counts as
   * `server_rejected`. For a server that reports failure in the body of a 200. Optional.
   */
  requirePath?: string;
}

export interface PublishRequest {
  /**
   * Your id for this batch. Everything - state, events, cancel, retry - is addressed by it.
   *
   * Refused as `invalid_request:batchId` when it is empty, `.` or `..`, on every platform, as the
   * composer refuses them (`ComposeSpec.batchId`): iOS files a batch's upload bodies and its job
   * folder's done marker under names made from the id, and those two would be some other batch's.
   * Usually the post's `ComposeSpec.batchId`, which a render has already refused them for.
   */
  batchId: string;

  /** Sent on every request in the batch, uploads and finalize alike. */
  headers: Record<string, string>;

  upload: PublishTransport;

  /**
   * The files, in the order `$IDS` and `$IDS:<tag>` list their ids on every platform.
   *
   * Not necessarily the order they are SENT in. Android and the web send them one at a time, in
   * this order, and stop at the first that fails. iOS hands every one that has no id yet to its
   * background session at once: the system decides how many go together and which arrives first,
   * and a failure does not stop the others, which keep the ids they get so a `retry()` does not
   * send them again. A server that cares about arrival order or about one upload at a time has to
   * be written for that.
   */
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

/**
 * Why a batch stopped.
 *
 * `auth` is a 401 or a 403. It is retryable, and no platform sends it again on its own: the same
 * request would carry the same token to the same answer, so the batch waits for `retry()` with new
 * `headers`. A dropped connection is sent again automatically before the batch fails as `network`,
 * and so is a 5xx on Android and iOS; the web fails a 5xx at once, as a retryable `http`.
 *
 * `file_missing` is a file that has gone or is empty, and is final. `unknown` whose message begins
 * `no_space` is iOS failing to write the private copy it sends from, on a full disk; it is
 * retryable once space is freed.
 */
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
  /**
   * The batch's [PublishRequest.batchId]. Missing, `.` or `..` is refused with `invalid_request`
   * rather than answered as a batch nothing is known about.
   */
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
