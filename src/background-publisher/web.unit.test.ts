import { describe, expect, it, vi } from 'vitest';

/*
 * `@capacitor/core` is not installed under that name here (`tsconfig.json` says why), and all the
 * browser plugin takes from it is the base class, which does nothing these calls reach.
 */
vi.mock('@capacitor/core', () => ({ WebPlugin: class {} }));

import type { BackgroundPublisherPlugin, PublishRequest } from './definitions';
import { BackgroundPublisherWeb } from './web';

/*
 * The ids iOS files under some other batch's name - its bodies folder and its job folder's done
 * marker are both named from the id - refused before anything is read or stored, as both phones
 * refuse them. A browser keeps a batch under an IndexedDB key that nothing climbs out of, but a call
 * a phone refuses is refused here too.
 */
describe('batch ids, in a browser', () => {
  const plugin: BackgroundPublisherPlugin = new BackgroundPublisherWeb();
  const refused = ['', '.', '..'];

  function request(batchId: string): PublishRequest {
    return {
      batchId,
      headers: {},
      upload: { url: 'https://example.test/upload' },
      uploads: [{ uploadId: 'u1', tag: '', path: 'blob:https://example.test/u1', mimeType: 'video/mp4' }],
      finalize: { url: 'https://example.test/create', bodyTemplate: '{}' },
    };
  }

  it('refuses a publish of an id that names no job folder of its own', async () => {
    for (const batchId of refused) {
      await expect(plugin.publish(request(batchId))).rejects.toMatchObject({
        code: 'invalid_request',
        message: 'invalid_request:batchId',
      });
    }
  });

  it('refuses the same ids to every call addressed by one', async () => {
    for (const batchId of refused) {
      for (const call of [
        () => plugin.getState({ batchId }),
        () => plugin.cancel({ batchId }),
        () => plugin.retry({ batchId }),
        () => plugin.clear({ batchId }),
      ]) {
        await expect(call(), batchId).rejects.toMatchObject({ code: 'invalid_request', message: 'invalid_request:batchId' });
      }
    }
  });
});
