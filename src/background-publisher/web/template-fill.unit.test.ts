import { describe, expect, it } from 'vitest';

import { fill, type FillUpload } from './template-fill';

/**
 * The finalize body, filled with ids that did not exist when the caller wrote it.
 *
 * The cases worth a test at all are the ones a careless implementation gets wrong: a token that
 * appears twice, a `$` in the customer's own text, and an id whose JSON type has to survive - a
 * number that comes back quoted is a 400 from somebody's server.
 */

const mainFile: FillUpload = { uploadId: 'u-main', tag: 'main', remoteId: 7 };
const clipA: FillUpload = { uploadId: 'u-a', tag: 'clip', remoteId: 8 };
const clipB: FillUpload = { uploadId: 'u-b', tag: 'clip', remoteId: 9 };

describe('fill', () => {
  it('replaces a token with a bare number and bare arrays, quotes and all', () => {
    const body = fill('{"video":"$ID:u-main","clips":"$IDS:clip","all":"$IDS"}', [mainFile, clipA, clipB]);
    expect(body).toBe('{"video":7,"clips":[8,9],"all":[7,8,9]}');
    // ...and what comes out is still JSON, which is what the finalize call is about to send.
    expect(JSON.parse(body)).toEqual({ video: 7, clips: [8, 9], all: [7, 8, 9] });
  });

  it('keeps a string id a string, quoted and escaped', () => {
    // The presigned case: the id is an object key, not a row number.
    const key: FillUpload = { uploadId: 'u-1', tag: '', remoteId: 'uploads/2026/"odd".mp4' };
    const body = fill('{"key":"$ID:u-1"}', [key]);
    expect(JSON.parse(body)).toEqual({ key: 'uploads/2026/"odd".mp4' });
  });

  it('replaces EVERY occurrence, not just the first', () => {
    // `String.replace` with a string pattern replaces one. A body naming the same token twice
    // would come back half filled and fail to parse.
    expect(fill('["$IDS","$IDS"]', [mainFile, clipA])).toBe('[[7,8],[7,8]]');
  });

  it('leaves a dollar in the customer own text alone', () => {
    const body = fill('{"title":"Best $5 burger $$$","video":"$ID:u-main"}', [mainFile]);
    expect(JSON.parse(body)).toEqual({ title: 'Best $5 burger $$$', video: 7 });
  });

  it('writes a tag nothing carries as an empty array', () => {
    expect(fill('{"clips":"$IDS:clip"}', [mainFile])).toBe('{"clips":[]}');
  });

  it('groups by tag rather than by position', () => {
    expect(fill('"$IDS:clip"', [clipA, mainFile, clipB])).toBe('[8,9]');
  });

  it('puts no spaces inside the array', () => {
    // A default separator of ", " would be valid JSON and a different number of bytes, which is the
    // sort of difference that only ever shows up in someone else's diff.
    expect(fill('"$IDS"', [mainFile, clipA, clipB])).toBe('[7,8,9]');
  });

  it('leaves a body with no tokens exactly as it was', () => {
    const template = '{"title":"no ids here"}';
    expect(fill(template, [mainFile])).toBe(template);
  });

  it('leaves a token naming nothing in the batch untouched, rather than guessing', () => {
    // A typo and a sentence look identical at this level, so it is left alone and the caller's
    // server is the one that complains. Documented on `bodyTemplate`.
    expect(fill('{"video":"$ID:typo"}', [mainFile])).toBe('{"video":"$ID:typo"}');
  });
});
