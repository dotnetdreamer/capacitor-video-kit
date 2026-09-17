import type { PublishRequest, PublishUpload } from '../definitions';

import { fileNameFor, lookupUrlFor } from './state';

/**
 * The transport, and the little bit of parsing the server's answers need.
 *
 * Worth knowing about the responses, and the reason this mirrors `PublisherHttp.kt` rather than
 * being three `fetch` calls: they are JSON, but served as `text/plain`, and an error comes back as
 * a bare JSON string rather than an object. So nothing here trusts the content type, and a body
 * that is not an object is treated as the error message.
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
 * The field names and their order are not ours to choose - they are what the server's uploader
 * expects - and the filename is load-bearing: the server stores the file under the name without its
 * extension, which is what makes an upload findable by its guid afterwards.
 */
export function uploadFile(request: PublishRequest, upload: PublishUpload, blob: Blob, options: { signal: AbortSignal; onBytes(sent: number): void }): Promise<HttpResponse> {
  const form = new FormData();
  const fileName = fileNameFor(upload);
  form.append('qquuid', upload.uploadGuid);
  form.append('qqfile', blob, fileName);
  form.append('qqfilename', fileName);
  if (upload.pictureId !== undefined && upload.pictureId > 0) {
    form.append('pictureId', String(upload.pictureId));
  }

  return new Promise<HttpResponse>((resolveWith, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', request.uploadUrl, true);
    // Never `Content-Type`: the browser writes it, boundary and all, and setting it by hand is how
    // a multipart body comes to be sent with a boundary the server cannot find.
    for (const [name, value] of Object.entries(request.headers ?? {})) {
      try {
        xhr.setRequestHeader(name, value);
      } catch {
        // A header the browser forbids a page to set. Nothing can be done about it here, and the
        // request is still worth sending: the one this plugin actually needs is the auth header,
        // which is not on the forbidden list.
      }
    }

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
    xhr.send(form);
  });
}

/** The create-post call. Plain `fetch`: there is no body worth watching go. */
export async function postJson(url: string, headers: Record<string, string>, body: string, signal: AbortSignal): Promise<HttpResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
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

/** Looks an upload up by its guid, so a lost response is not a second upload. */
export async function lookupDownloadId(request: PublishRequest, uploadGuid: string, signal: AbortSignal): Promise<number | null> {
  const url = lookupUrlFor(request, uploadGuid);
  if (!url) return null;
  try {
    const response = await fetch(url, { method: 'GET', headers: request.headers ?? {}, signal });
    if (!response.ok) return null;
    return parseDownloadId(await response.text());
  } catch {
    // A lookup that fails means only "we do not know", and the answer to that is to send the file.
    return null;
  }
}

export function parseDownloadId(body: string): number | null {
  const json = parseObject(body);
  const id = typeof json?.['downloadId'] === 'number' ? json['downloadId'] : 0;
  return id > 0 ? id : null;
}

export interface CreatedPost {
  postId: number;
  published: boolean;
}

export function parseCreatedPost(body: string): CreatedPost | null {
  const json = parseObject(body);
  const postId = typeof json?.['postId'] === 'number' ? json['postId'] : 0;
  if (postId <= 0) return null;
  return { postId, published: json?.['published'] === true };
}

/** The longest error message worth putting in a log line. */
const MAX_MESSAGE_CHARS = 500;

/**
 * Whatever the server said, as something worth showing a developer. An error body is usually a
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

function parseObject(body: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
