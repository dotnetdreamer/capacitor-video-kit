import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/*
 * The platform and the plugin, stood in for. `registerPlugin` hands back a proxy that a spy cannot
 * attach to, and `@capacitor/core` is not installed under that name here at all (`tsconfig.json`
 * says why), so the module is replaced whole: one platform to answer with, and one plugin whose
 * `checkMedia` each case sets.
 */
const bridge = vi.hoisted(() => ({
  platform: 'ios',
  checkMedia: vi.fn<(options: { uri: string }) => Promise<{ exists: boolean; uri: string }>>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => bridge.platform },
  registerPlugin: () => ({ checkMedia: bridge.checkMedia }),
  WebPlugin: class {},
}));

import { currentMediaUri } from './current-media';

const BEFORE = '5E68153E-1C2D-4E5F-8A9B-0C1D2E3F4A5B';
const AFTER = 'ED43CA12-6B7C-4D8E-9F0A-1B2C3D4E5F6A';

/** A retained copy's name as `retainMedia` answers it, in the container `uuid`. */
const picked = (uuid: string) =>
  `file:///private/var/mobile/Containers/Data/Application/${uuid}/Library/Application%20Support/videokit-picked/A1.mp4`;

describe('currentMediaUri', () => {
  beforeEach(() => {
    bridge.platform = 'ios';
    bridge.checkMedia.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers with the name iOS found the file under in this install', async () => {
    bridge.checkMedia.mockResolvedValue({ exists: true, uri: picked(AFTER) });

    expect(await currentMediaUri(picked(BEFORE))).toBe(picked(AFTER));
    expect(bridge.checkMedia).toHaveBeenCalledWith({ uri: picked(BEFORE) });
  });

  it('reads a container out of a simulator path as well as a phone one', async () => {
    const simulator = `/Users/qa/Library/Developer/CoreSimulator/Devices/D/data/Containers/Data/Application/${BEFORE}/Library/clip.mov`;
    bridge.checkMedia.mockResolvedValue({ exists: true, uri: simulator.replace(BEFORE, AFTER) });

    expect(await currentMediaUri(simulator)).toBe(simulator.replace(BEFORE, AFTER));
  });

  /*
   * A poster stored as the WebView showed it. `checkMedia` reads only a file name, so it is asked
   * about the file, and the answer goes back into the same URL.
   */
  it('moves a URL the local server serves the file by, and keeps it that URL', async () => {
    const served = (uuid: string) => picked(uuid).replace('file://', 'capacitor://localhost/_capacitor_file_');
    bridge.checkMedia.mockResolvedValue({ exists: true, uri: picked(AFTER) });

    expect(await currentMediaUri(served(BEFORE))).toBe(served(AFTER));
    expect(bridge.checkMedia).toHaveBeenCalledWith({ uri: picked(BEFORE) });
  });

  it('answers such a URL as it came when the file has not moved, whatever the app named its server', async () => {
    const served = `app://media.example/_capacitor_file_/private/var/mobile/Containers/Data/Application/${BEFORE}/Library/poster.jpg`;
    bridge.checkMedia.mockImplementation(async ({ uri }) => ({ exists: true, uri }));

    expect(await currentMediaUri(served)).toBe(served);
    expect(bridge.checkMedia).toHaveBeenCalledWith({
      uri: `file:///private/var/mobile/Containers/Data/Application/${BEFORE}/Library/poster.jpg`,
    });
  });

  /* Android and a browser never name a container, so they must never pay for the question. */
  it('asks nothing off iOS, whatever the name', async () => {
    bridge.platform = 'android';
    expect(await currentMediaUri(picked(BEFORE))).toBe(picked(BEFORE));

    bridge.platform = 'web';
    expect(await currentMediaUri('blob:https://example.test/abc')).toBe('blob:https://example.test/abc');

    expect(bridge.checkMedia).not.toHaveBeenCalled();
  });

  it('asks nothing on iOS about a name with no container in it', async () => {
    expect(await currentMediaUri('content://media/external/video/media/12')).toBe('content://media/external/video/media/12');
    expect(await currentMediaUri('file:///beach.mp4')).toBe('file:///beach.mp4');
    // A folder of the same name that is not an install's: no UUID after it.
    expect(await currentMediaUri('/Containers/Data/Application/current/clip.mp4')).toBe('/Containers/Data/Application/current/clip.mp4');

    expect(bridge.checkMedia).not.toHaveBeenCalled();
  });

  /* A draft must still open when the question cannot be asked; the clip is then reported by its own name. */
  it('answers the name as it came when the call fails', async () => {
    bridge.checkMedia.mockRejectedValue(new Error('not implemented on ios'));

    expect(await currentMediaUri(picked(BEFORE))).toBe(picked(BEFORE));
  });
});
