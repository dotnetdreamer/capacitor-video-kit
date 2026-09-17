/**
 * The smallest IndexedDB that will do, as promises.
 *
 * Why IndexedDB at all, in a package whose native halves have a filesystem: everything the web
 * implementations promise that a `fetch` in a page cannot - a render whose result survives a
 * reload, an upload that picks itself up where the tab was closed - rests on the bytes and the
 * record still being there after the page has gone. `localStorage` holds strings and blocks the
 * main thread; the Cache API is keyed by request and evicted as a cache; OPFS is the better store
 * for large files but its synchronous handles only exist inside a worker, and the render already
 * has to run where `<video>` and `<canvas>` are. IndexedDB stores a `Blob` without copying it into
 * the JavaScript heap, which is the one property a 100 MB video actually needs.
 *
 * Deliberately not a wrapper library: four calls, one database, no schema migrations beyond the
 * initial `onupgradeneeded`, and a caller that can read every line of it.
 */

/** Bumped only to ADD a store. Anything else would need a migration, and there is nothing to migrate. */
const DB_VERSION = 1;
const DB_NAME = 'choisy-video-kit';

/** Durable bytes: rendered videos, posters, and every file an upload still has to send. */
export const FILES_STORE = 'files';
/** Render job records, so a finished render can still be read after a reload. */
export const JOBS_STORE = 'jobs';
/** Publish records: the whole request, its auth header and how far it got. */
export const PUBLISH_STORE = 'publish';

let opening: Promise<IDBDatabase | null> | null = null;

/**
 * The database, or null where there is no IndexedDB to open - a page in a private window that
 * blocks storage, a document with an opaque origin, a server-side render.
 *
 * Null rather than a rejection because every caller has the same answer to it: do the volatile
 * thing instead. A render still renders and an upload still uploads in a tab with no storage; what
 * is lost is only their surviving the tab.
 */
export function database(): Promise<IDBDatabase | null> {
  if (opening) return opening;
  opening = new Promise<IDBDatabase | null>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(null);
      return;
    }
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      // Safari in a private window throws from open() itself rather than firing onerror.
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      for (const store of [FILES_STORE, JOBS_STORE, PUBLISH_STORE]) {
        if (!db.objectStoreNames.contains(store)) db.createObjectStore(store);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    // Another tab holding an older version open. Nothing here can fix that, and a null database is
    // already the "carry on without persistence" path.
    request.onblocked = () => resolve(null);
  });
  return opening;
}

/** One value, or undefined for a key that was never written or a database that would not open. */
export async function idbGet<T>(store: string, key: string): Promise<T | undefined> {
  const db = await database();
  if (!db) return undefined;
  return transact<T | undefined>(db, store, 'readonly', (objectStore) => objectStore.get(key));
}

/** Whether the value was written. False is a full disk or no database, and is never a throw. */
export async function idbPut(store: string, key: string, value: unknown): Promise<boolean> {
  const db = await database();
  if (!db) return false;
  try {
    await transact(db, store, 'readwrite', (objectStore) => objectStore.put(value, key));
    return true;
  } catch {
    // QuotaExceededError is the one that matters, and the caller's answer to it is always the
    // same: keep going in memory and let the operation fail on its own terms if it must.
    return false;
  }
}

export async function idbDelete(store: string, key: string): Promise<void> {
  const db = await database();
  if (!db) return;
  try {
    await transact(db, store, 'readwrite', (objectStore) => objectStore.delete(key));
  } catch {
    /* A key that will not delete is a key that is already gone as far as any caller is concerned. */
  }
}

/** Every key in a store, in IndexedDB's own order, which for strings is lexicographic. */
export async function idbKeys(store: string): Promise<string[]> {
  const db = await database();
  if (!db) return [];
  try {
    const keys = await transact<IDBValidKey[]>(db, store, 'readonly', (objectStore) =>
      objectStore.getAllKeys(),
    );
    return keys.filter((key): key is string => typeof key === 'string');
  } catch {
    return [];
  }
}

/** Every value in a store. Used by the sweeps, which have to look at each record to judge it. */
export async function idbValues<T>(store: string): Promise<T[]> {
  const db = await database();
  if (!db) return [];
  try {
    return await transact<T[]>(db, store, 'readonly', (objectStore) => objectStore.getAll());
  } catch {
    return [];
  }
}

/**
 * One request inside one transaction.
 *
 * The transaction's own `onerror` is listened for as well as the request's: a `put` that exceeds
 * the quota fails the transaction rather than the request in some browsers, and without both the
 * promise would never settle.
 */
function transact<T>(
  db: IDBDatabase,
  store: string,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let transaction: IDBTransaction;
    try {
      transaction = db.transaction(store, mode);
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)));
      return;
    }
    const request = run(transaction.objectStore(store));
    request.onsuccess = () => resolve(request.result as T);
    request.onerror = () => reject(request.error ?? new Error('indexeddb request failed'));
    transaction.onabort = () => reject(transaction.error ?? new Error('indexeddb transaction aborted'));
  });
}
