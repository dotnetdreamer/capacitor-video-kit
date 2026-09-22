import type { PublishRequest, PublishUpload } from '../definitions';

import { DEFAULT_FILE_FIELD, fieldsFor, fileNameFor, lookupUrlFor, uploadUrlFor } from './state';

/**
 * The transport, and the little bit of reading the server's answers need.
 *
 * Nothing here knows a field name or a response key: both come out of the request, because the
 * whole point of this plugin is that it works against a backend it was not written for. What it
 * does own is the two shapes bytes travel in - a multipart POST and a raw PUT - and the rule that
 * nothing trusts a content type. Servers that answer JSON as `text/plain`, or report an error as
 * a bare JSON string rather than an object, are common enough that parsing has to be attempted
 * rather than announced.
 *
 * The upload goes through `XMLHttpRequest` and not `fetch`, which is the one place this file is
 * deliberately old-fashioned. `fetch` has no upload progress: the promise settles when the response
 * arrives, and between sending the first byte of a hundred-megabyte video and that moment it
 * reports nothing at all. `xhr.upload.onprogress` is the only way a browser will say how far a
 * request body has actually gone, and a progress bar that sits at zero for four minutes is not a
 * progress bar. (`fetch` with a `ReadableStream` body can be instrumented, but it needs HTTP/2 and
 * `duplex: 'half'`, and it is not supported outside Chromium.)
 */

/** A response as far as this plugin cares: a status and a body. */
export interface HttpResponse {
  status: number;
  body: string;
}

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

/**
 * Sends one file, reporting bytes as they leave.
 *
 * `PUT` sends the bytes and nothing else, with the file's own content type - which is what a
 * presigned URL is signed for, and why adding an envelope there would break the signature. `POST`
 * builds the multipart form the transport describes: the text parts first, in the order given,
 * then the file last. File-last is the order a streaming multipart parser wants, since it can
 * read every small field before it has to decide what to do with a large one.
 */
export function uploadFile(request: PublishRequest, upload: PublishUpload, blob: Blob, options: { signal: AbortSignal; onBytes(sent: number): void }): Promise<HttpResponse> {
  const method = request.upload.method ?? 'POST';
  const url = uploadUrlFor(request, upload);
  const fileName = fileNameFor(upload);

  let body: Blob | FormData;
  if (method === 'PUT') {
    body = blob;
  } else {
    const form = new FormData();
    for (const [name, value] of Object.entries(fieldsFor(request, upload))) {
      form.append(name, value);
    }
    form.append(request.upload.fileField ?? DEFAULT_FILE_FIELD, blob, fileName);
    body = form;
  }

  return new Promise<HttpResponse>((resolveWith, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, url, true);

    for (const [name, value] of Object.entries(request.headers ?? {})) {
      setHeader(xhr, name, value);
    }
    // For a multipart POST, never `Content-Type`: the browser writes it, boundary and all, and
    // setting it by hand is how a body comes to be sent with a boundary the server cannot find.
    // For a PUT the opposite holds - a presigned URL is usually signed over the content type.
    if (method === 'PUT') setHeader(xhr, 'Content-Type', upload.mimeType);

    const onAbort = (): void => xhr.abort();
    options.signal.addEventListener('abort', onAbort, { once: true });
    const done = (): void => options.signal.removeEventListener('abort', onAbort);

    xhr.upload.onprogress = event => options.onBytes(event.loaded);
    xhr.onload = () => {
      done();
      resolveWith({ status: xhr.status, body: xhr.responseText ?? '' });
    };
    xhr.onerror = () => {
      done();
      // A browser deliberately tells a page nothing about why a request failed, so there is nothing
      // more specific to report than this.
      reject(new NetworkError('the connection failed'));
    };
    xhr.ontimeout = () => {
      done();
      reject(new NetworkError('the connection timed out'));
    };
    xhr.onabort = () => {
      done();
      reject(new DOMException('cancelled', 'AbortError'));
    };
    xhr.send(body);
  });
}

function setHeader(xhr: XMLHttpRequest, name: string, value: string): void {
  try {
    xhr.setRequestHeader(name, value);
  } catch {
    // A header the browser forbids a page to set. Nothing can be done about it here, and the
    // request is still worth sending: the one this plugin actually needs is the auth header,
    // which is not on the forbidden list.
  }
}

/** The finalize call. Plain `fetch`: there is no body worth watching go. */
export async function sendJson(url: string, method: 'POST' | 'PUT', headers: Record<string, string>, body: string, signal: AbortSignal): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json; charset=utf-8' },
      body,
      signal,
    });
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new NetworkError(error instanceof Error ? error.message : 'the connection failed');
  }
  return { status: response.status, body: await response.text() };
}

/** Asks whether the server already has a file, so a lost response is not a second upload. */
export async function lookupRemoteId(request: PublishRequest, uploadId: string, signal: AbortSignal): Promise<string | number | null> {
  const url = lookupUrlFor(request, uploadId);
  if (!url) return null;
  try {
    const response = await fetch(url, { method: 'GET', headers: request.headers ?? {}, signal });
    if (!response.ok) return null;
    return parseRemoteId(await response.text(), request.upload.idPath);
  } catch {
    // A lookup that fails means only "we do not know", and the answer to that is to send the file.
    return null;
  }
}

/**
 * The server's id for a stored file, read from wherever the caller said it lives.
 *
 * The JSON type is kept rather than flattened to text: an id that came back as a number has to go
 * into the finalize body as a number, and there is no way to recover that later from a string.
 */
export function parseRemoteId(body: string, idPath: string | undefined): string | number | null {
  if (!idPath) return null;
  const value = valueAt(parseJson(body), idPath);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return value.length > 0 ? value : null;
  return null;
}

/** Whether a 2xx body carries what the caller said it must. */
export function hasValueAt(body: string, path: string | undefined): boolean {
  if (!path) return true;
  const value = valueAt(parseJson(body), path);
  return value !== undefined && value !== null && value !== '';
}

/** Walks a dotted path - `downloadId`, `data.id` - through a parsed body. */
export function valueAt(json: unknown, path: string): unknown {
  let current = json;
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/** The body as JSON, or undefined when it is not JSON at all. Never throws. */
export function parseJson(body: string): unknown {
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return undefined;
  }
}

/** The longest error message worth putting in a log line. */
const MAX_MESSAGE_CHARS = 500;

/**
 * Whatever the server said, as something worth showing a developer. An error body is often a
 * quoted JSON string, so the quotes come off.
 */
export function errorMessage(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length === 0) return 'no response body';
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1);
  }
  return trimmed.slice(0, MAX_MESSAGE_CHARS);
}
