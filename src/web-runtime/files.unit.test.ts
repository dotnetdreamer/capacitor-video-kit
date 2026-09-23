import { afterEach, describe, expect, it, vi } from 'vitest';

import { resolve } from './files';

/**
 * A `fetch` that answers with this status and these bytes.
 *
 * Not a real `Response`: its constructor refuses a status outside 200 to 599, and status 0 is the
 * very answer under test - what WebKit's `fetch` makes of a response Capacitor's iOS server sends
 * with no HTTP status at all.
 */
function answer(status: number, bytes: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({
      ok: status >= 200 && status < 300,
      status,
      blob: async () => new Blob(bytes ? [bytes] : [], { type: 'video/mp4' }),
    })),
  );
}

describe('resolve', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads a file served with a status', async () => {
    answer(200, 'mp4 bytes');
    const blob = await resolve('https://example.test/clip.mp4');
    expect(await blob.text()).toBe('mp4 bytes');
  });

  /* Capacitor's iOS server hands a whole video or sound back with no HTTP status, which fetch calls 0. */
  it('reads a file whose answer has no status, when the bytes came with it', async () => {
    answer(0, 'mp4 bytes');
    const blob = await resolve('capacitor://localhost/_capacitor_file_/var/mobile/clip.mp4');
    expect(blob.size).toBe('mp4 bytes'.length);
  });

  /* The same server's answer for a file of no bytes is status 0 as well, and nothing anybody meant. */
  it('refuses an answer with no status and nothing in it', async () => {
    answer(0, '');
    await expect(resolve('capacitor://localhost/_capacitor_file_/var/mobile/empty.mp4')).rejects.toThrow('nothing came back');
  });

  it('still refuses a real HTTP error, bytes or not', async () => {
    answer(404, 'Not found');
    await expect(resolve('https://example.test/gone.mp4')).rejects.toThrow('HTTP 404');

    answer(500, '');
    await expect(resolve('https://example.test/broken.mp4')).rejects.toThrow('HTTP 500');
  });
});
