import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { readFileBlob, readVoiceTake } from './read-file';

const TAKE = 'file:///app/Library/Caches/video-composer/voice/vo-1.m4a';
const SERVED = 'capacitor://localhost/_capacitor_file_/app/Library/Caches/video-composer/voice/vo-1.m4a';

/**
 * A `fetch` that answers with this status, these bytes and this type.
 *
 * Not a real `Response`: its constructor refuses a status outside 200 to 599, and status 0 is the
 * answer that matters most here - what WebKit's `fetch` makes of the iOS local server's answer for a
 * whole file, which has no HTTP status and no type.
 */
function answer(status: number, bytes: string, type = '') {
  const read = vi.fn(async (_url: string) => ({
    ok: status >= 200 && status < 300,
    status,
    blob: async () => new Blob(bytes ? [bytes] : [], { type }),
  }));
  vi.stubGlobal('fetch', read);
  return read;
}

beforeEach(() => {
  // The global a native side puts in the page, which is all `webViewUrl` reads.
  vi.stubGlobal('Capacitor', { convertFileSrc: (path: string) => path.replace('file://', 'capacitor://localhost/_capacitor_file_') });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('readFileBlob', () => {
  it('reads a device file through Capacitor\'s local server, taking an answer with no status as the file', async () => {
    const read = answer(0, 'take');

    const bytes = await readFileBlob(TAKE);

    expect(read).toHaveBeenCalledWith(SERVED);
    expect(await bytes.text()).toBe('take');
  });

  it('reads a URL the page loads as it is, with the type it came with', async () => {
    const read = answer(200, 'webm', 'video/webm');

    const bytes = await readFileBlob('blob:http://localhost/9b1c');

    expect(read).toHaveBeenCalledWith('blob:http://localhost/9b1c');
    expect(bytes.type).toBe('video/webm');
  });

  /* Nothing anybody picked, recorded or rendered is a file of no bytes, whatever the server said. */
  it('refuses an empty body, with a status or without one', async () => {
    answer(200, '');
    await expect(readFileBlob(TAKE)).rejects.toThrow(`could not read ${TAKE}: it is empty`);

    answer(0, '');
    await expect(readFileBlob(TAKE)).rejects.toThrow('nothing came back');
  });

  it('refuses an HTTP error, bytes or not, and a fetch that failed', async () => {
    answer(404, 'Not found');
    await expect(readFileBlob(TAKE)).rejects.toThrow('HTTP 404');

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    await expect(readFileBlob(TAKE)).rejects.toThrow('Load failed');
  });

  /* `fetch('')` is the page's own address, and would answer with the app's HTML as the file. */
  it('refuses no URI at all, and fetches nothing', async () => {
    const read = answer(200, '<html>');

    await expect(readFileBlob('')).rejects.toThrow('there is no file to read');
    expect(read).not.toHaveBeenCalled();
  });
});

describe('readVoiceTake', () => {
  it('types a take the server answered with no type as the recorder writes it', async () => {
    answer(0, 'take');

    const bytes = await readVoiceTake(TAKE);

    expect(bytes.type).toBe('audio/mp4');
    expect(await bytes.text()).toBe('take');
  });

  /* A server guessing from the extension may call an `.m4a` something else; the recorder knows. */
  it('types it as the recorder writes it whatever the server called it', async () => {
    answer(200, 'take', 'audio/mpeg');
    await expect(readVoiceTake(TAKE)).resolves.toMatchObject({ type: 'audio/mp4' });

    answer(200, 'take', 'audio/mp4');
    await expect(readVoiceTake(TAKE)).resolves.toMatchObject({ type: 'audio/mp4' });
  });

  it('rejects as the read does', async () => {
    answer(200, '');
    await expect(readVoiceTake(TAKE)).rejects.toThrow('it is empty');
  });
});
