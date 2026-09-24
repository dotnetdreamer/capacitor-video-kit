import { describe, expect, it, vi } from 'vitest';

import { RenderFailedError } from './host.types';

describe('RenderFailedError', () => {
  /*
   * A page holds several copies of the class - the editor's bundle, `dist/components`, `/ui` and the
   * plugin at the root - and the editor has to hear the code from whichever one a host threw. A
   * fresh module registry is how a test gets a second copy of the same source.
   */
  it('is one class to instanceof in every copy of the package on the page', async () => {
    vi.resetModules();
    const copy = await import('./host.types');
    expect(copy.RenderFailedError).not.toBe(RenderFailedError);

    expect(new copy.RenderFailedError('too_large', 'too_large max=1 bytes=2')).toBeInstanceOf(RenderFailedError);
    expect(new RenderFailedError('no_space', 'full')).toBeInstanceOf(copy.RenderFailedError);
  });

  it('is not claimed by an error that only shares its name', () => {
    expect(new Error('full')).not.toBeInstanceOf(RenderFailedError);
    expect(Object.assign(new Error('full'), { name: 'RenderFailedError', code: 'no_space' })).not.toBeInstanceOf(RenderFailedError);
    expect(null).not.toBeInstanceOf(RenderFailedError);
  });

  it('keeps its brand out of what a log or a copy of it shows', () => {
    const error = new RenderFailedError('unreadable_input', 'clip a has no file', 'a');
    expect(Object.getOwnPropertySymbols({ ...error })).toEqual([]);
    expect({ ...error }).toMatchObject({ name: 'RenderFailedError', code: 'unreadable_input', sourceKey: 'a' });
  });

  it('still tests a subclass by its prototype chain', () => {
    class NoSpaceError extends RenderFailedError {}
    expect(new NoSpaceError('no_space', 'full')).toBeInstanceOf(RenderFailedError);
    expect(new RenderFailedError('no_space', 'full')).not.toBeInstanceOf(NoSpaceError);
  });
});
