import { describe, expect, it } from 'vitest';

import type { PublishRequest, PublishState } from '../definitions';

import { errorMessage, hasValueAt, parseRemoteId, valueAt } from './http';
import { computePercent, fieldsFor, fileNameFor, initialState, lookupUrlFor, uploadUrlFor } from './state';

/**
 * The bar, the filename, the resolved request and the server's answers - the things a browser and
 * a phone have to agree about for a batch sent from either to look the same to the customer and to
 * the backend.
 */

function request(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    batchId: 'batch-1',
    headers: { 'X-Token': 'redacted' },
    upload: { url: 'https://example.test/upload', method: 'POST', idPath: 'downloadId' },
    uploads: [
      { uploadId: 'u-main', tag: 'main', path: 'blob:abc', mimeType: 'video/mp4' },
      { uploadId: 'u-clip', tag: 'clip', path: 'blob:def', mimeType: 'video/mp4' },
    ],
    finalize: { url: 'https://example.test/posts', bodyTemplate: '{"video":"$ID:u-main"}' },
    ...over,
  };
}

function withSizes(sizes: number[]): PublishState {
  const state = initialState(request());
  state.uploads.forEach((upload, index) => {
    upload.bytesTotal = sizes[index] ?? 0;
  });
  return state;
}

describe('computePercent', () => {
  it('holds the last five points back for the finalize call', () => {
    const state = withSizes([100, 100]);
    for (const upload of state.uploads) {
      upload.status = 'done';
      upload.bytesSent = 100;
    }
    // Every byte is in and the finalize call has not answered, so it is 95 and not 100.
    expect(computePercent(state)).toBe(95);
  });

  it('is 100 only once the batch is done', () => {
    const state = withSizes([100]);
    state.phase = 'done';
    expect(computePercent(state)).toBe(100);
  });

  it('counts bytes across every file, not files finished', () => {
    const state = withSizes([100, 300]);
    const first = state.uploads[0];
    if (first) {
      first.status = 'done';
      first.bytesSent = 100;
    }
    // One of two files is in, but it is a quarter of the bytes.
    expect(computePercent(state)).toBe(Math.floor(0.25 * 95));
  });

  it('prefers a live counter to the last one that happened to be persisted', () => {
    const state = withSizes([1000]);
    const first = state.uploads[0];
    if (first) first.bytesSent = 100;
    expect(computePercent(state, new Map([['u-main', 500]]))).toBe(Math.floor(0.5 * 95));
  });

  it('falls back to the recorded percent before any size is known', () => {
    const state = withSizes([0, 0]);
    state.percent = 42;
    expect(computePercent(state)).toBe(42);
  });
});

describe('initialState', () => {
  it('defaults an untagged upload to the empty tag rather than dropping the field', () => {
    const state = initialState(request({ uploads: [{ uploadId: 'u-1', path: 'blob:a', mimeType: 'video/mp4' }] }));
    expect(state.uploads[0]?.tag).toBe('');
    expect(state.uploads[0]?.remoteId).toBeUndefined();
  });
});

describe('fileNameFor', () => {
  it('names the file after its upload id, keeping the extension', () => {
    expect(fileNameFor({ uploadId: 'u1', path: 'file:///jobs/p/main.mp4' })).toBe('u1.mp4');
  });

  it('falls back to mp4 for a path with no extension, which a blob URL never has', () => {
    expect(fileNameFor({ uploadId: 'u1', path: 'blob:https://app.test/9b1c' })).toBe('u1.mp4');
  });

  it('ignores a query string', () => {
    expect(fileNameFor({ uploadId: 'u1', path: 'https://cdn.test/a.mov?token=x' })).toBe('u1.mov');
  });

  it('lets the caller name the file outright', () => {
    expect(fileNameFor({ uploadId: 'u1', path: 'blob:abc', fileName: 'holiday.mp4' })).toBe('holiday.mp4');
  });
});

describe('uploadUrlFor', () => {
  it('uses the transport URL when the file names none', () => {
    const req = request();
    expect(uploadUrlFor(req, req.uploads[0]!)).toBe('https://example.test/upload');
  });

  it('expands the placeholders, percent-encoded because it is a URL', () => {
    const req = request({ upload: { url: 'https://s3.test/bucket/{uploadId}/{fileName}' } });
    expect(uploadUrlFor(req, { uploadId: 'a/b', path: 'x.mp4', mimeType: 'video/mp4' })).toBe('https://s3.test/bucket/a%2Fb/a%2Fb.mp4');
  });

  it('lets one file carry its own signed URL, which is how presigning works', () => {
    const req = request();
    const signed = { uploadId: 'u-main', path: 'blob:abc', mimeType: 'video/mp4', url: 'https://r2.test/put?sig=abc' };
    expect(uploadUrlFor(req, signed)).toBe('https://r2.test/put?sig=abc');
  });
});

describe('fieldsFor', () => {
  it('expands the placeholders and leaves them literal, since a field is not a URL', () => {
    const req = request({ upload: { url: 'https://example.test/upload', fields: { qquuid: '{uploadId}', qqfilename: '{fileName}' } } });
    expect(fieldsFor(req, { uploadId: 'a/b', path: 'x.mov', mimeType: 'video/mp4' })).toEqual({
      qquuid: 'a/b',
      qqfilename: 'a/b.mov',
    });
  });

  it('lets one file override a transport field', () => {
    const req = request({ upload: { url: 'https://example.test/upload', fields: { kind: 'video', album: '1' } } });
    expect(fieldsFor(req, { uploadId: 'u1', path: 'x.mp4', mimeType: 'video/mp4', fields: { album: '9' } })).toEqual({
      kind: 'video',
      album: '9',
    });
  });
});

describe('lookupUrlFor', () => {
  it('puts the upload id in the template', () => {
    const req = request({ upload: { url: 'https://example.test/upload', lookupUrlTemplate: 'https://example.test/uploads/{uploadId}' } });
    expect(lookupUrlFor(req, 'u-main')).toBe('https://example.test/uploads/u-main');
  });

  it('answers null when the caller offered no template, so the file is simply sent again', () => {
    expect(lookupUrlFor(request(), 'u-main')).toBeNull();
  });
});

describe('reading what the server said', () => {
  it('keeps the JSON type of an id, because the finalize body depends on it', () => {
    expect(parseRemoteId('{"downloadId":12}', 'downloadId')).toBe(12);
    expect(parseRemoteId('{"id":"abc"}', 'id')).toBe('abc');
    expect(parseRemoteId('{"data":{"id":7}}', 'data.id')).toBe(7);
  });

  it('answers null for an id that is not there, so the caller is told rather than guessed at', () => {
    expect(parseRemoteId('{"downloadId":null}', 'downloadId')).toBeNull();
    expect(parseRemoteId('{"id":""}', 'id')).toBeNull();
    expect(parseRemoteId('"something went wrong"', 'downloadId')).toBeNull();
    expect(parseRemoteId('not json at all', 'downloadId')).toBeNull();
    // No path configured is the presigned case, where the id never comes from the body.
    expect(parseRemoteId('{"downloadId":12}', undefined)).toBeNull();
  });

  it('walks a dotted path and gives up on anything that is not an object', () => {
    expect(valueAt({ a: { b: 1 } }, 'a.b')).toBe(1);
    expect(valueAt({ a: [1] }, 'a.b')).toBeUndefined();
    expect(valueAt(undefined, 'a')).toBeUndefined();
  });

  it('checks a required path only when the caller named one', () => {
    expect(hasValueAt('{"postId":5}', 'postId')).toBe(true);
    expect(hasValueAt('{"postId":null}', 'postId')).toBe(false);
    expect(hasValueAt('', undefined)).toBe(true);
  });

  it('unquotes the bare JSON string an error comes back as', () => {
    expect(errorMessage('"the video is too long"')).toBe('the video is too long');
    expect(errorMessage('   ')).toBe('no response body');
    expect(errorMessage('{"error":"nope"}')).toBe('{"error":"nope"}');
  });
});
