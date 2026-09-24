import { afterEach, describe, expect, it, vi } from 'vitest';

import { extractAudio } from './sounds';

/*
 * The one thing about `extractAudio` that is not the browser's own decoder: what it hands that
 * decoder. Web Audio exists in neither the mock DOM these run in nor Node, so the context is stood
 * in for, and the real decode is left to a browser.
 */
describe('extractAudio', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /* A whole video is the largest allocation here, and a copy of it would be a second one alive during the decode. */
  it('hands the decoder the very bytes it read, not a copy of them', async () => {
    const bytes = new ArrayBuffer(16);
    const blob = { size: bytes.byteLength, arrayBuffer: async () => bytes };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => blob })),
    );
    const decodeAudioData = vi.fn(async (_data: ArrayBuffer) => ({ length: 0, numberOfChannels: 0, duration: 0 }));
    vi.stubGlobal(
      'AudioContext',
      class {
        decodeAudioData = decodeAudioData;
        close = async () => undefined;
      },
    );

    // Decoded to nothing, which is a video with no sound: null, and the argument is what is asked about.
    await expect(extractAudio('blob:app/clip')).resolves.toBeNull();

    expect(decodeAudioData).toHaveBeenCalledTimes(1);
    expect(decodeAudioData.mock.calls[0]?.[0]).toBe(bytes);
  });
});
