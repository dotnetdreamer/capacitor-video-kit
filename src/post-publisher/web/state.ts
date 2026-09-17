import type { PublishFailureCode, PublishPhase, PublishRequest, PublishState, PublishUploadState } from '../definitions';

/**
 * The publish state, and the one piece of arithmetic in it worth pinning down.
 *
 * A port of `PublishState.computePercent`, to the constant. The bar has to mean the same thing on
 * every platform, because the customer sees it in the same pill: bytes sent over bytes to send,
 * scaled into 0..95, with the last five points held back for the create call. A post is not 100 %
 * until the post EXISTS, however many bytes went up.
 */

/** Where the bar sits while the post is being created: the files are in, the post is not. */
export const CREATING_PERCENT = 97;

/** Attempts per step, matching `Workers.MAX_ATTEMPTS`. */
export const MAX_ATTEMPTS = 3;

/** 30 s, 60 s, 120 s - the same ladder WorkManager's exponential policy climbs. */
export const BACKOFF_MS = [30_000, 60_000, 120_000];

/** The phases a job is still going in, so a second `publish` of one is a no-op. */
export const IN_FLIGHT: readonly PublishPhase[] = ['queued', 'uploading', 'creating'];

/** The phases nothing more will happen from on its own. */
export const TERMINAL: readonly PublishPhase[] = ['done', 'failed', 'cancelled'];

export function initialState(request: PublishRequest): PublishState {
  return {
    pendingPostId: request.pendingPostId,
    phase: 'queued',
    percent: 0,
    uploads: request.uploads.map(upload => {
      const state: PublishUploadState = {
        uploadGuid: upload.uploadGuid,
        role: upload.role,
        status: 'queued',
        bytesSent: 0,
        bytesTotal: 0,
      };
      if (upload.pictureId !== undefined) state.pictureId = upload.pictureId;
      return state;
    }),
    attempts: 0,
  };
}

export function uploadFor(state: PublishState, uploadGuid: string): PublishUploadState | undefined {
  return state.uploads.find(upload => upload.uploadGuid === uploadGuid);
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
    return sum + Math.max(upload.bytesSent, liveBytes.get(upload.uploadGuid) ?? 0);
  }, 0);
  return clampPercent(Math.floor((sent / total) * 95));
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return value < 0 ? 0 : value > 95 ? 95 : value;
}

/** The lookup URL for one guid, or null when the caller offered no template. */
export function lookupUrlFor(request: PublishRequest, uploadGuid: string): string | null {
  const template = request.lookupUrlTemplate;
  if (!template) return null;
  return template.replaceAll('{uploadGuid}', encodeURIComponent(uploadGuid));
}

/**
 * `<uploadGuid>.<ext>` - the server keys on the name WITHOUT its extension, which is what makes an
 * upload findable by its guid afterwards, so the name is not ours to choose freely.
 */
export function fileNameFor(upload: { uploadGuid: string; path: string }): string {
  const path = upload.path.split('?')[0] ?? '';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  const extension = dot > 0 ? name.slice(dot + 1) : '';
  const usable = extension.length > 0 && extension.length <= 8 ? extension : 'mp4';
  return `${upload.uploadGuid}.${usable}`;
}

/** Whether trying again could help. The same split the native workers make. */
export function isRetryable(code: PublishFailureCode): boolean {
  return code === 'network' || code === 'http' || code === 'auth';
}
