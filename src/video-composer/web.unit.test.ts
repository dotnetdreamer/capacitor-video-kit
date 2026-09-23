import { describe, expect, it, vi } from 'vitest';

/*
 * `@capacitor/core` is not installed under that name here (`tsconfig.json` says why), and all the
 * browser plugin takes from it is the base class, which does nothing these calls reach.
 */
vi.mock('@capacitor/core', () => ({ WebPlugin: class {} }));

import type { VideoComposerPlugin } from './plugin';
import { VideoComposerWeb } from './web';

/*
 * The five calls a host that keeps picks makes on every platform, as a browser answers them: the
 * honest answers rather than refusals, and the same refusals as the phones for a call that is wrong.
 */
describe('keeping picked media, in a browser', () => {
  // Through the interface, which is all a host ever holds.
  const plugin: VideoComposerPlugin = new VideoComposerWeb();

  it('says a pick in a page has no name that outlives it, and hands the name back', async () => {
    await expect(plugin.retainMedia({ uri: 'blob:https://example.test/a' })).resolves.toEqual({
      uri: 'blob:https://example.test/a',
      durable: false,
    });
    await expect(plugin.retainMedia({ uri: '' })).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  /* The host keeps the bytes in a browser, so only the host can say whether they are still there. */
  it('answers any name as still there and as it came, and no name as nothing', async () => {
    await expect(plugin.checkMedia({ uri: 'videokit-file:/drafts/clip.mp4' })).resolves.toEqual({
      exists: true,
      uri: 'videokit-file:/drafts/clip.mp4',
    });
    await expect(plugin.checkMedia({ uri: '' })).resolves.toEqual({ exists: false, uri: '' });
  });

  it('needs no permission to go on reading what the page holds', async () => {
    await expect(plugin.requestMediaAccess({ images: true })).resolves.toEqual({ granted: true });
    await expect(plugin.requestMediaAccess()).resolves.toEqual({ granted: true });
  });

  it('deletes nothing, and refuses the arguments iOS would refuse', async () => {
    await expect(plugin.releaseMedia({ uris: [] })).resolves.toBeUndefined();
    await expect(plugin.sweepMedia({ keep: [], before: Date.now() })).resolves.toEqual({ removed: 0 });

    await expect(plugin.releaseMedia({} as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.sweepMedia({ before: Date.now() } as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.sweepMedia({ keep: [] } as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.sweepMedia({ keep: [], before: Number.NaN })).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  /*
   * A `keep` that names something where a list belongs meant to spare it, and misread as absent would
   * delete what it was there to keep, wherever deleting happens. A null names nothing, and is read as
   * left out, as Android reads it and as Capacitor's getters read a JSON null on both phones.
   */
  it('takes a release\'s keep list, reads a null one as left out, and refuses one that is not a list', async () => {
    await expect(plugin.releaseMedia({ uris: ['blob:https://example.test/a'], keep: ['blob:https://example.test/a'] })).resolves.toBeUndefined();
    await expect(plugin.releaseMedia({ uris: [], keep: undefined })).resolves.toBeUndefined();
    await expect(plugin.releaseMedia({ uris: [], keep: null } as never)).resolves.toBeUndefined();

    await expect(plugin.releaseMedia({ uris: [], keep: 'blob:https://example.test/a' } as never)).rejects.toMatchObject({
      code: 'invalid_spec',
    });
    await expect(plugin.releaseMedia({ uris: [], keep: { uri: 'blob:https://example.test/a' } } as never)).rejects.toMatchObject({
      code: 'invalid_spec',
    });
  });
});

/*
 * The three calls a page has no use for, refused with the code Capacitor gives a call a platform
 * does not have, so a host that asks anyway can tell "not here" from "went wrong".
 */
describe('the native-only calls, in a browser', () => {
  const plugin: VideoComposerPlugin = new VideoComposerWeb();

  it('has no document picker of its own: a page picks a sound through a file input', async () => {
    await expect(plugin.pickAudioFile()).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
  });

  it('stages no render inputs, because its engine reads a blob as it is', async () => {
    await expect(plugin.stageRenderInput({ data: 'c291bmQ=' })).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
    await expect(plugin.releaseRenderInputs({ uris: [] })).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
  });
});
