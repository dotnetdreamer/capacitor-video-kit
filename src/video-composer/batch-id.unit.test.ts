import { describe, expect, it } from 'vitest';

import { batchIdRefusal } from './batch-id';

/*
 * The rule `JobFolders.batchIdRefusal` holds to on iOS and Android, pinned by `JobFolderNamesTests`
 * and `JobFolderNamesTest` with the same ids and the same words.
 */
describe('batchIdRefusal', () => {
  it('refuses the ids that name no folder of their own, in the native words', () => {
    expect(batchIdRefusal('..')).toBe("batchId cannot be '.' or '..'");
    expect(batchIdRefusal('.')).toBe("batchId cannot be '.' or '..'");
    expect(batchIdRefusal('')).toBe('batchId is required');
    expect(batchIdRefusal(undefined)).toBe('batchId is required');
    expect(batchIdRefusal(7)).toBe('batchId is required');
  });

  it('takes every other id, dots and separators included, which natively is a folder of its own', () => {
    for (const id of ['post-1', 'batch-3f2a.9', '...', '.x', '__', '../x', 'a/../..', '/', 'x/..']) {
      expect(batchIdRefusal(id), id).toBeNull();
    }
  });
});
