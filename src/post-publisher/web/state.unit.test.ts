import { describe, expect, it } from 'vitest';

import type { PublishRequest, PublishState } from '../definitions';

import { errorMessage, parseCreatedPost, parseDownloadId } from './http';
import { computePercent, fileNameFor, initialState, lookupUrlFor } from './state';

/**
 * The bar, the filename and the server's answers - the three things a browser and a phone have to
 * agree about for a post made on either to look the same to the customer and to the backend.
 */

function request(over: Partial<PublishRequest> = {}): PublishRequest {
  return {
    pendingPostId: 'post-1',
    headers: { 'X-Token': 'redacted' },
    uploadUrl: 'https://example.test/upload',
    uploads: [
      { uploadGuid: 'g-stitched', role: 'stitched', path: 'blob:abc', mimeType: 'video/mp4' },
      { uploadGuid: 'g-original', role: 'original', path: 'blob:def', mimeType: 'video/mp4' },
    ],
    createPost: { url: 'https://example.test/posts', bodyTemplate: '{"video":"$STITCHED"}' },
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
  it('holds the last five points back for the create call', () => {
    const state = withSizes([100, 100]);
    for (const upload of state.uploads) {
      upload.status = 'done';
      upload.bytesSent = 100;
    }
    // Every byte is in and the post does not exist yet, so it is 95 and not 100.
    expect(computePercent(state)).toBe(95);
  });

  it('is 100 only once the post exists', () => {
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
    expect(computePercent(state, new Map([['g-stitched', 500]]))).toBe(Math.floor(0.5 * 95));
  });

  it('falls back to the recorded percent before any size is known', () => {
    const state = withSizes([0, 0]);
    state.percent = 42;
    expect(computePercent(state)).toBe(42);
  });
});

describe('fileNameFor', () => {
  it('names the file after its guid, keeping the extension the server keys on', () => {
    expect(fileNameFor({ uploadGuid: 'g1', path: 'file:///jobs/p/stitched.mp4' })).toBe('g1.mp4');
  });

  it('falls back to mp4 for a path with no extension, which a blob URL never has', () => {
    expect(fileNameFor({ uploadGuid: 'g1', path: 'blob:https://app.test/9b1c' })).toBe('g1.mp4');
  });

  it('ignores a query string', () => {
    expect(fileNameFor({ uploadGuid: 'g1', path: 'https://cdn.test/a.mov?token=x' })).toBe('g1.mov');
  });
});

describe('lookupUrlFor', () => {
  it('puts the guid in the template', () => {
    const url = lookupUrlFor(request({ lookupUrlTemplate: 'https://example.test/uploads/{uploadGuid}' }), 'g-stitched');
    expect(url).toBe('https://example.test/uploads/g-stitched');
  });

  it('answers null when the caller offered no template, so the file is simply sent again', () => {
    expect(lookupUrlFor(request(), 'g-stitched')).toBeNull();
  });
});

describe('reading what the server said', () => {
  it('takes a download id only when it is a real one', () => {
    expect(parseDownloadId('{"downloadId":12}')).toBe(12);
    expect(parseDownloadId('{"downloadId":0}')).toBeNull();
    expect(parseDownloadId('"something went wrong"')).toBeNull();
    expect(parseDownloadId('not json at all')).toBeNull();
  });

  it('reads a created post, defaulting published to false', () => {
    expect(parseCreatedPost('{"postId":5,"published":true}')).toEqual({
      postId: 5,
      published: true,
    });
    // The store holds posts for approval, which is the normal case, so absent means not published.
    expect(parseCreatedPost('{"postId":5}')).toEqual({ postId: 5, published: false });
    expect(parseCreatedPost('{"postId":0}')).toBeNull();
  });

  it('unquotes the bare JSON string an error comes back as', () => {
    expect(errorMessage('"the video is too long"')).toBe('the video is too long');
    expect(errorMessage('   ')).toBe('no response body');
    expect(errorMessage('{"error":"nope"}')).toBe('{"error":"nope"}');
  });
});
