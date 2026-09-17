import { describe, expect, it } from 'vitest';

import { fill } from './template-fill';

/**
 * The create-post body, filled with ids that did not exist when the caller wrote it.
 *
 * The two cases worth a test at all are the two a careless implementation gets wrong: a placeholder
 * that appears twice, and a `$` in the customer's own text.
 */
describe('fill', () => {
  it('replaces a placeholder with a bare number and bare arrays, quotes and all', () => {
    const body = fill('{"video":"$STITCHED","clips":"$ORIGINALS","all":"$ALL"}', 7, [8, 9]);
    expect(body).toBe('{"video":7,"clips":[8,9],"all":[7,8,9]}');
    // ...and what comes out is still JSON, which is what the create call is about to send.
    expect(JSON.parse(body)).toEqual({ video: 7, clips: [8, 9], all: [7, 8, 9] });
  });

  it('replaces EVERY occurrence, not just the first', () => {
    // `String.replace` with a string pattern replaces one. A body naming the same placeholder twice
    // would come back half filled and fail to parse.
    expect(fill('["$ALL","$ALL"]', 1, [2])).toBe('[[1,2],[1,2]]');
  });

  it('leaves a dollar in the customer own text alone', () => {
    const body = fill('{"title":"Best $5 burger $$$","video":"$STITCHED"}', 4, []);
    expect(JSON.parse(body)).toEqual({ title: 'Best $5 burger $$$', video: 4 });
  });

  it('writes an empty originals list as an empty array', () => {
    expect(fill('{"clips":"$ORIGINALS"}', 1, [])).toBe('{"clips":[]}');
  });

  it('puts no spaces inside the array', () => {
    // A default separator of ", " would be valid JSON and a different number of bytes, which is the
    // sort of difference that only ever shows up in someone else's diff.
    expect(fill('"$ALL"', 1, [2, 3])).toBe('[1,2,3]');
  });

  it('leaves a body with no placeholders exactly as it was', () => {
    const template = '{"title":"no ids here"}';
    expect(fill(template, 1, [2])).toBe(template);
  });
});
