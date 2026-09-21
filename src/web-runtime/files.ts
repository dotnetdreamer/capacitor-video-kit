/**
 * The web's answer to a job folder: durable bytes, and a URL the page can actually load.
 *
 * A browser has two ideas of "a file the app owns" and neither is both. A `blob:` URL is loadable
 * by every element on the page and dies with the document that minted it, so it cannot be what a
 * record written today names tomorrow. An IndexedDB entry survives the tab and cannot be handed to
 * a `<video>` at all. So this module keeps the bytes in IndexedDB and mints a `blob:` URL on
 * demand, and the two are tied together by a stable name that IS the durable identity:
 *
 *     videokit-file:/<folder>/<name>
 *
 * Every URI this package hands out for a file it owns is a `blob:` URL, because that is what a
 * caller can use without knowing anything about this scheme. The `videokit-file:` form is what gets
 * WRITTEN DOWN - in a job record, in a publish record - and [resolve] turns either one, plus an
 * `http(s):`, a `data:` and a bare path, back into bytes.
 *
 * The folder is the `pendingPostId`, exactly as `JobFolders` uses it natively, so `cleanup` is the
 * same one-line promise: the folder goes and everything in it goes with it.
 */
import { FILES_STORE, idbDelete, idbGet, idbKeys, idbPut } from './idb';

/** What a stored file is called when it is written down rather than handed over. */
export const FILE_SCHEME = 'videokit-file:';

/** Keys are echoed back to callers, so a `vo:<id>` key must not become a path separator. */
export function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, '_');
}

/** The durable name of one file. The same string on both sides of a reload. */
export function fileUri(folder: string, name: string): string {
  return `${FILE_SCHEME}/${safeSegment(folder)}/${safeSegment(name)}`;
}

/** The `folder` and `name` back out of a `videokit-file:` URI, or null for anything else. */
export function parseFileUri(uri: string): { folder: string; name: string } | null {
  if (!uri.startsWith(FILE_SCHEME)) return null;
  const path = uri.slice(FILE_SCHEME.length).replace(/^\/+/, '');
  const slash = path.indexOf('/');
  if (slash <= 0 || slash === path.length - 1) return null;
  return { folder: path.slice(0, slash), name: path.slice(slash + 1) };
}

/*
 * The `blob:` URLs this module minted, by durable name, so asking for the same file twice in one
 * page hands back one URL and one copy rather than two. They are revoked when the file is deleted
 * and never on their own: a `<video>` may still be playing one, and an editor's undo may bring a
 * clip that names it back from ten steps ago.
 */
const minted = new Map<string, string>();

/**
 * Writes bytes under a durable name and hands back a `blob:` URL for them.
 *
 * The URL comes back whether or not the write landed: a tab with no storage still renders and
 * still uploads, it just cannot do either across a reload. `durable` says which of the two
 * happened, for a caller that has to tell the customer.
 */
export async function putFile(
  folder: string,
  name: string,
  blob: Blob,
): Promise<{ uri: string; url: string; durable: boolean }> {
  const uri = fileUri(folder, name);
  const durable = await idbPut(FILES_STORE, uri, blob);
  return { uri, url: mint(uri, blob), durable };
}

/** The stored bytes, or null when nothing was written under that name. */
export async function readFile(uri: string): Promise<Blob | null> {
  const stored = await idbGet<Blob>(FILES_STORE, uri);
  return stored instanceof Blob ? stored : null;
}

/**
 * A loadable URL for a file written earlier, minting a fresh `blob:` for it if this document has
 * not seen it before. This is what makes a render readable again after a reload.
 */
export async function urlForFile(uri: string): Promise<string | null> {
  const existing = minted.get(uri);
  if (existing) return existing;
  const blob = await readFile(uri);
  return blob ? mint(uri, blob) : null;
}

/** Every durable name under one folder. */
export async function folderFiles(folder: string): Promise<string[]> {
  const prefix = `${FILE_SCHEME}/${safeSegment(folder)}/`;
  return (await idbKeys(FILES_STORE)).filter((key) => key.startsWith(prefix));
}

/** Deletes one file and gives back the memory its URL was holding. */
export async function deleteFile(uri: string): Promise<void> {
  await idbDelete(FILES_STORE, uri);
  revoke(uri);
}

/** Deletes a whole job folder. Idempotent, which is the whole of `cleanup`'s contract. */
export async function deleteFolder(folder: string): Promise<void> {
  for (const uri of await folderFiles(folder)) await deleteFile(uri);
}

/**
 * Bytes for anything a caller can name: a file this package stored, a `blob:` or `data:` URL from
 * a picker, an `http(s):` URL, or a bare path a native host would have understood.
 *
 * Rejects rather than resolving null, because every caller of this is about to depend on the bytes
 * and the reason it could not get them is the error the customer needs to see.
 */
export async function resolve(uri: string): Promise<Blob> {
  const stored = parseFileUri(uri);
  if (stored) {
    const blob = await readFile(uri);
    if (!blob) throw new Error(`no stored file at ${uri}`);
    return blob;
  }
  if (typeof fetch !== 'function') throw new Error('this page cannot read files');
  let response: Response;
  try {
    response = await fetch(uri);
  } catch (error) {
    // A revoked `blob:` URL, a cross-origin URL without CORS, an offline network: all arrive here
    // and all mean the same thing to the caller.
    throw new Error(`could not read ${uri}: ${describe(error)}`);
  }
  if (!response.ok) throw new Error(`could not read ${uri}: HTTP ${response.status}`);
  return await response.blob();
}

/**
 * A URL a `<video>`, an `<img>` or an `AudioContext` can load right now, for any of the same
 * forms. A `videokit-file:` URI becomes a `blob:`; everything else is already loadable and is handed
 * straight back, which is what makes this safe to run over a caller's own URLs.
 */
export async function loadableUrl(uri: string): Promise<string> {
  if (!uri.startsWith(FILE_SCHEME)) return uri;
  const url = await urlForFile(uri);
  if (!url) throw new Error(`no stored file at ${uri}`);
  return url;
}

/** `.mp4` out of a URL, for naming a stored file after the one it came from. */
export function extensionOf(uri: string, fallback: string): string {
  const path = uri.split('?')[0]?.split('#')[0] ?? '';
  const name = path.slice(path.lastIndexOf('/') + 1);
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return fallback;
  const extension = name.slice(dot + 1).toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(extension) ? extension : fallback;
}

/** Whatever was thrown, as something worth putting in a message. */
export function describe(error: unknown): string {
  if (error instanceof Error) return error.message || error.name;
  return String(error);
}

function mint(uri: string, blob: Blob): string {
  const existing = minted.get(uri);
  if (existing) return existing;
  const url = URL.createObjectURL(blob);
  minted.set(uri, url);
  return url;
}

function revoke(uri: string): void {
  const url = minted.get(uri);
  if (!url) return;
  minted.delete(uri);
  URL.revokeObjectURL(url);
}
