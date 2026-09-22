import type { PublishFailureCode, PublishPhase, PublishRequest, PublishState, PublishUpload, PublishUploadState } from '../definitions';

/**
 * The publish state, the arithmetic in it worth pinning down, and the small amount of resolving
 * the request needs before a request can be built from it.
 *
 * `computePercent` is a port of `PublishState.computePercent`, to the constant. The bar has to mean
 * the same thing on every platform, because the customer sees it in the same pill: bytes sent over
 * bytes to send, scaled into 0..95, with the last five points held back for the finalize call. A
 * batch is not 100 % until the finalize call has ANSWERED, however many bytes went up.
 *
 * The resolvers below are the other half of making this plugin backend-agnostic. A URL, a filename
 * and a form field may each name `{uploadId}` and `{fileName}`, and every platform has to expand
 * them identically or a presigned URL signed for one key uploads to another.
 */

/** Where the bar sits while the finalize call is in flight: the files are in, the batch is not. */
export const FINALIZING_PERCENT = 97;

/** Attempts per step, matching `Workers.MAX_ATTEMPTS`. */
export const MAX_ATTEMPTS = 3;

/** 30 s, 60 s, 120 s - the same ladder WorkManager's exponential policy climbs. */
export const BACKOFF_MS = [30_000, 60_000, 120_000];

/** The phases a job is still going in, so a second `publish` of one is a no-op. */
export const IN_FLIGHT: readonly PublishPhase[] = ['queued', 'uploading', 'finalizing'];

/** The phases nothing more will happen from on its own. */
export const TERMINAL: readonly PublishPhase[] = ['done', 'failed', 'cancelled'];

/** The multipart part carrying the bytes, when the transport does not name one. */
export const DEFAULT_FILE_FIELD = 'file';

export function initialState(request: PublishRequest): PublishState {
  return {
    batchId: request.batchId,
    phase: 'queued',
    percent: 0,
    uploads: request.uploads.map(upload => ({
      uploadId: upload.uploadId,
      tag: upload.tag ?? '',
      status: 'queued',
      bytesSent: 0,
      bytesTotal: 0,
    })),
    attempts: 0,
  };
}

export function uploadFor(state: PublishState, uploadId: string): PublishUploadState | undefined {
  return state.uploads.find(upload => upload.uploadId === uploadId);
}

/**
 * 0..100 across the whole job.
 *
 * `liveBytes` folds in counters that have moved since the record was last written: the record is
 * persisted every few percent, and a caller asking right now wants the current number rather than
 * the last one that happened to be saved.
 */
export function computePercent(state: PublishState, liveBytes: ReadonlyMap<string, number> = new Map()): number {
  if (state.phase === 'done') return 100;
  const total = state.uploads.reduce((sum, upload) => sum + upload.bytesTotal, 0);
  if (total <= 0) return clampPercent(state.percent);
  const sent = state.uploads.reduce((sum, upload) => {
    if (upload.status === 'done') return sum + upload.bytesTotal;
    return sum + Math.max(upload.bytesSent, liveBytes.get(upload.uploadId) ?? 0);
  }, 0);
  return clampPercent(Math.floor((sent / total) * 95));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 95 ? 95 : value;
}

/* -------------------------------------------------------------------------------------------- */
/* Resolving the request                                                                          */
/* -------------------------------------------------------------------------------------------- */

/**
 * `<uploadId>.<ext>`, unless the caller named the file itself.
 *
 * The extension is carried over from the path because some servers key on it, and because a
 * `.mp4` arriving as an extensionless blob is a support ticket. The fallback is `mp4` rather than
 * nothing: a name with no extension at all is the one case that has been seen to confuse a
 * server's content sniffing.
 */
export function fileNameFor(upload: Pick<PublishUpload, 'uploadId' | 'path'> & { fileName?: string }): string {
  if (upload.fileName) return upload.fileName;
  const path = upload.path.split('?')[0] ?? '';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const usable = extension.length > 0 && extension.length <= 8 ? extension : 'mp4';
  return `${upload.uploadId}.${usable}`;
}

/** A URL template with its placeholders filled, percent-encoded because it is a URL. */
export function expandUrl(template: string, uploadId: string, fileName: string): string {
  return template.replaceAll('{uploadId}', encodeURIComponent(uploadId)).replaceAll('{fileName}', encodeURIComponent(fileName));
}

/** A form-field value with its placeholders filled. Left literal: it is not going in a URL. */
export function expandField(value: string, uploadId: string, fileName: string): string {
  return value.replaceAll('{uploadId}', uploadId).replaceAll('{fileName}', fileName);
}

/** Where one file goes. The upload's own URL wins, which is how per-file presigned URLs work. */
export function uploadUrlFor(request: PublishRequest, upload: PublishUpload): string {
  return expandUrl(upload.url ?? request.upload.url, upload.uploadId, fileNameFor(upload));
}

/** The transport's parts and this file's own, the file's winning, in a stable order. */
export function fieldsFor(request: PublishRequest, upload: PublishUpload): Record<string, string> {
  const merged = { ...(request.upload.fields ?? {}), ...(upload.fields ?? {}) };
  const fileName = fileNameFor(upload);
  const expanded: Record<string, string> = {};
  for (const [name, value] of Object.entries(merged)) {
    expanded[name] = expandField(value, upload.uploadId, fileName);
  }
  return expanded;
}

/** The lookup URL for one upload, or null when the caller offered no template. */
export function lookupUrlFor(request: PublishRequest, uploadId: string): string | null {
  const template = request.upload.lookupUrlTemplate;
  if (!template) return null;
  const upload = request.uploads.find(candidate => candidate.uploadId === uploadId);
  return expandUrl(template, uploadId, upload ? fileNameFor(upload) : '');
}

/** Whether trying again could help. The same split the native workers make. */
export function isRetryable(code: PublishFailureCode): boolean {
  return code === 'network' || code === 'http' || code === 'auth';
}
