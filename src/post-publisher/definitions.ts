/**
 * `choisy-post-publisher` - uploads a finished post's files and creates the post, natively.
 *
 * The reason this is not `fetch` in a service worker: the customer taps Post and immediately goes
 * back to scrolling, switches apps, or locks the phone. A WebView upload dies the moment the page
 * is frozen. So the whole transaction - every file, then the create call - is handed to the
 * platform's own background machinery and survives the app being backgrounded, swiped away, or
 * killed for memory.
 *
 * Because it survives the app, it cannot depend on JavaScript being alive to drive it: the request,
 * including the auth header and the body template, is persisted natively and the placeholders are
 * filled in once the upload ids are known.
 */
import type { PluginListenerHandle } from '@capacitor/core';

/* -------------------------------------------------------------------------------------------- */
/* Request                                                                                        */
/* -------------------------------------------------------------------------------------------- */

/** `stitched` is the post's own video; `original` clips follow it in timeline order. */
export type PublishUploadRole = 'stitched' | 'original';

export interface PublishUpload {
  /** The caller's own id for this file. Also the uploaded filename, which is how it is recovered. */
  uploadGuid: string;
  role: PublishUploadRole;
  /** `file://` path of the file to send. */
  path: string;
  mimeType: string;
  /** A thumbnail already uploaded for this file, if there is one. */
  pictureId?: number;
}

export interface PublishCreatePost {
  url: string;
  /**
   * The full create-post JSON, with `"$STITCHED"`, `"$ORIGINALS"` and `"$ALL"` standing in for ids
   * that do not exist yet. They are replaced textually, quotes included, once every upload has
   * answered - `"$STITCHED"` becomes a bare number and the other two become arrays.
   */
  bodyTemplate: string;
}

export interface PublishRequest {
  pendingPostId: string;
  /** Sent on every request. In practice `X-Token`; kept general so the plugin owns no auth scheme. */
  headers: Record<string, string>;
  /** Absolute URL of the upload endpoint. */
  uploadUrl: string;
  /**
   * Absolute URL template for looking an upload up by its guid, with `{uploadGuid}` where the id
   * goes. Used to recover the id of a file that finished uploading while the app was dead, instead
   * of sending it a second time. Optional; without it such a file is simply uploaded again.
   */
  lookupUrlTemplate?: string;
  /** Sent in order, stitched first. */
  uploads: PublishUpload[];
  createPost: PublishCreatePost;
}

/* -------------------------------------------------------------------------------------------- */
/* State                                                                                          */
/* -------------------------------------------------------------------------------------------- */

export type PublishPhase = 'queued' | 'uploading' | 'creating' | 'done' | 'failed' | 'cancelled';

export type PublishUploadStatus = 'queued' | 'uploading' | 'done' | 'failed';

export interface PublishUploadState {
  uploadGuid: string;
  role: PublishUploadRole;
  status: PublishUploadStatus;
  /** Set once the server has accepted the file. Its presence is what stops a re-send. */
  downloadId?: number;
  pictureId?: number;
  httpStatus?: number;
  bytesSent: number;
  bytesTotal: number;
}

export type PublishFailureCode =
  | 'network'
  | 'http'
  | 'auth'
  | 'server_rejected'
  | 'file_missing'
  | 'cancelled'
  | 'unknown';

export interface PublishError {
  code: PublishFailureCode;
  message: string;
  httpStatus?: number;
  /** Which half of the job was running. */
  phase: 'uploading' | 'creating';
  uploadGuid?: string;
  /** False when trying again cannot help - a rejected post, a file that is gone. */
  retryable: boolean;
}

export interface PublishState {
  pendingPostId: string;
  phase: PublishPhase;
  /** 0..100 across the whole job; only reaches 100 once the post exists. */
  percent: number;
  uploads: PublishUploadState[];
  postId?: number;
  /** False when the store holds posts for approval, which is the normal case. */
  published?: boolean;
  error?: PublishError;
  /** How many times this post has been handed to the platform. */
  attempts: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Events                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export interface PublishProgressEvent {
  pendingPostId: string;
  phase: 'uploading' | 'creating';
  percent: number;
}

export interface PublishFinishedEvent {
  pendingPostId: string;
  postId: number;
  published: boolean;
}

export interface PublishFailedEvent {
  pendingPostId: string;
  phase: 'uploading' | 'creating';
  code: PublishFailureCode;
  message: string;
  httpStatus?: number;
}

/* -------------------------------------------------------------------------------------------- */
/* Plugin                                                                                         */
/* -------------------------------------------------------------------------------------------- */

export interface PendingPostIdOptions {
  pendingPostId: string;
}

export interface RetryOptions extends PendingPostIdOptions {
  /** Replaces the stored headers - how a refreshed token gets in after an auth failure. */
  headers?: Record<string, string>;
}

export interface PostPublisherPlugin {
  /**
   * Persists the request and hands it to the platform. Resolves as soon as it is queued; calling it
   * again for a post already in flight is a no-op, so a retried call cannot double-post.
   */
  publish(request: PublishRequest): Promise<void>;

  /** `null` when nothing is known about this post - it never started, or its record was cleared. */
  getState(options: PendingPostIdOptions): Promise<{ state: PublishState | null }>;

  /** Stops the job. Upload ids already obtained are kept, so a retry does not re-send those files. */
  cancel(options: PendingPostIdOptions): Promise<void>;

  /** Re-queues from wherever it stopped, skipping files the server already has. */
  retry(options: RetryOptions): Promise<void>;

  /** Forgets the record entirely. Does not touch the files. */
  clear(options: PendingPostIdOptions): Promise<void>;

  addListener(
    eventName: 'publishProgress',
    listener: (event: PublishProgressEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'publishFinished',
    listener: (event: PublishFinishedEvent) => void,
  ): Promise<PluginListenerHandle>;
  addListener(
    eventName: 'publishFailed',
    listener: (event: PublishFailedEvent) => void,
  ): Promise<PluginListenerHandle>;

  removeAllListeners(): Promise<void>;
}
