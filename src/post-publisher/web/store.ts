import { deleteFolder, extensionOf, putFile, resolve, safeSegment } from '../../web-runtime/files';
import { idbDelete, idbGet, idbPut, idbValues, PUBLISH_STORE } from '../../web-runtime/idb';
import type { PublishRequest, PublishState } from '../definitions';

import { initialState, TERMINAL } from './state';

/**
 * One post's whole record: what to do, and how far it got.
 *
 * The native plugin persists the request - auth header, body template and all - because the upload
 * continues after the app is dead and cannot depend on JavaScript being alive to drive it. A
 * browser cannot make that promise, but it CAN make the smaller one that matters nearly as often:
 * the customer reloaded, or came back to the tab tomorrow, and the upload picks up where it stopped
 * instead of starting the hundred megabytes again. That needs the same record, and one more thing
 * the native plugin gets for free.
 *
 * That one more thing is the files. Natively the upload names a path inside an app-private folder
 * that nothing but `cleanup` deletes. In a browser it names a `blob:` URL, which dies with the
 * document that minted it - so a record that survived a reload would come back pointing at nothing.
 * `stage` is the answer: the bytes are copied into durable storage when the post is queued, and the
 * record names the copy.
 */

/** A record of a post that finished this long ago is swept. */
export const DONE_RETENTION_MS = 24 * 60 * 60 * 1000;

export interface PublishEntry {
  /** The caller's request, with every `path` rewritten to the durable copy. */
  request: PublishRequest;
  state: PublishState;
  /** False while a terminal outcome is still waiting to be told to somebody. */
  acked: boolean;
  /** Epoch milliseconds. */
  createdAt: number;
  updatedAt: number;
}

/** Where a post's staged files live. Its own folder, so `clear` can take the lot. */
export function stagingFolder(pendingPostId: string): string {
  return `publish-${safeSegment(pendingPostId)}`;
}

export async function loadEntry(pendingPostId: string): Promise<PublishEntry | null> {
  const entry = await idbGet<PublishEntry>(PUBLISH_STORE, pendingPostId);
  return entry?.request?.pendingPostId ? entry : null;
}

export async function saveEntry(entry: PublishEntry): Promise<void> {
  entry.updatedAt = Date.now();
  await idbPut(PUBLISH_STORE, entry.request.pendingPostId, entry);
}

/** Reads, changes and writes back in one step, or answers null for a post nobody has heard of. */
export async function updateEntry(pendingPostId: string, change: (entry: PublishEntry) => void): Promise<PublishEntry | null> {
  const entry = await loadEntry(pendingPostId);
  if (!entry) return null;
  change(entry);
  await saveEntry(entry);
  return entry;
}

/** Forgets the record and the copies it was holding. */
export async function deleteEntry(pendingPostId: string): Promise<void> {
  await idbDelete(PUBLISH_STORE, pendingPostId);
  await deleteFolder(stagingFolder(pendingPostId));
}

export function allEntries(): Promise<PublishEntry[]> {
  return idbValues<PublishEntry>(PUBLISH_STORE);
}

/**
 * Takes a copy of every file the post has to send, and hands back the request naming the copies.
 *
 * Rejects when a file cannot be read, which is deliberate and is the same refusal the native plugin
 * makes before it queues anything: fail now, loudly, with the app open, rather than in a worker an
 * hour later with nobody watching.
 *
 * The sizes come back with it because the bar needs them before the first byte moves - a percentage
 * of an unknown total is not a percentage.
 */
export async function stage(request: PublishRequest): Promise<{ request: PublishRequest; sizes: Map<string, number> }> {
  const folder = stagingFolder(request.pendingPostId);
  const sizes = new Map<string, number>();
  const uploads: PublishRequest['uploads'] = [];

  for (const upload of request.uploads) {
    const blob = await resolve(upload.path);
    if (blob.size === 0) throw new Error(`missing file for ${upload.uploadGuid}`);
    // Named after the guid, keeping the original extension: `fileNameFor` reads that extension back
    // off the path when it builds the multipart filename, and the server keys on it.
    const name = `${safeSegment(upload.uploadGuid)}.${extensionOf(upload.path, 'mp4')}`;
    const stored = await putFile(folder, name, blob);
    sizes.set(upload.uploadGuid, blob.size);
    uploads.push({ ...upload, path: stored.uri });
  }

  return { request: { ...request, uploads }, sizes };
}

/**
 * A fresh record for a request, carrying over any upload id a previous attempt already obtained.
 *
 * An id obtained before an attempt was abandoned is still good, and carrying it over is what stops
 * a retry from sending the same hundred megabytes a second time.
 */
export function freshEntry(request: PublishRequest, sizes: ReadonlyMap<string, number>, previous: PublishEntry | null): PublishEntry {
  const state = initialState(request);
  for (const upload of state.uploads) {
    upload.bytesTotal = sizes.get(upload.uploadGuid) ?? 0;
    const before = previous?.state.uploads.find(candidate => candidate.uploadGuid === upload.uploadGuid);
    if (before?.downloadId) {
      upload.downloadId = before.downloadId;
      upload.status = 'done';
      upload.bytesSent = upload.bytesTotal;
    }
  }
  state.attempts = (previous?.state.attempts ?? 0) + 1;
  const now = Date.now();
  return {
    request,
    state,
    acked: false,
    createdAt: previous?.createdAt ?? now,
    updatedAt: now,
  };
}

/** Drops records nobody will read again, with the files they were holding. */
export async function sweepPublishes(): Promise<void> {
  const now = Date.now();
  for (const entry of await allEntries()) {
    const pendingPostId = entry?.request?.pendingPostId;
    if (!pendingPostId) continue;
    if (!TERMINAL.includes(entry.state.phase)) continue;
    if (now - entry.updatedAt > DONE_RETENTION_MS) await deleteEntry(pendingPostId);
  }
}
