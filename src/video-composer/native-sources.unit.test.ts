import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { GalleryVideo, ResolveGalleryVideoResult, RetainMediaResult } from './definitions';

/*
 * The platform and the plugin, stood in for, as `current-media.unit.test.ts` does and for its
 * reasons. `convertFileSrc` answers as iOS's local server names a file.
 */
const bridge = vi.hoisted(() => ({
  retainMedia: vi.fn<(options: { uri: string }) => Promise<RetainMediaResult>>(),
  resolveGalleryVideo: vi.fn<(options: { id: string }) => Promise<ResolveGalleryVideoResult>>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { convertFileSrc: (path: string) => path.replace(/^file:\/\//, 'capacitor://localhost/_capacitor_file_') },
  registerPlugin: () => ({ retainMedia: bridge.retainMedia, resolveGalleryVideo: bridge.resolveGalleryVideo }),
  WebPlugin: class {},
}));

import { setEditorDebug } from '../host/debug';

import { gallerySource, retainPickedFile } from './native-sources';

const CONTAINER = 'file:///var/mobile/Containers/Data/Application/5E68153E-1C2D-4E5F-8A9B-0C1D2E3F4A5B';

describe('retainPickedFile', () => {
  beforeEach(() => {
    bridge.retainMedia.mockReset();
  });

  /* iOS moves the picker's copy out of Caches, and the picker's own URL then names where it was. */
  it('plays a file iOS moved from its new name, and stores that name', async () => {
    const path = `${CONTAINER}/Library/Caches/7A2B/IMG_0042.MOV`;
    const kept = `${CONTAINER}/Library/Application%20Support/videokit-picked/0C1D.MOV`;
    bridge.retainMedia.mockResolvedValue({ uri: kept, durable: true });

    expect(await retainPickedFile({ path, webPath: 'capacitor://localhost/_capacitor_file_/old' })).toEqual({
      sourcePath: kept,
      playbackUrl: kept.replace('file://', 'capacitor://localhost/_capacitor_file_'),
      durable: true,
    });
    expect(bridge.retainMedia).toHaveBeenCalledWith({ uri: path });
  });

  /* Android swaps a photo-picker URI for the MediaStore one: another name for the same bytes, moved nowhere. */
  it('keeps playing from the picker\'s URL when the new name is not a moved file', async () => {
    bridge.retainMedia.mockResolvedValue({ uri: 'content://media/external/video/media/12', durable: true });

    expect(
      await retainPickedFile({ path: 'content://media/picker/0/42', webPath: 'http://localhost/_capacitor_content_/42' }),
    ).toEqual({
      sourcePath: 'content://media/external/video/media/12',
      playbackUrl: 'http://localhost/_capacitor_content_/42',
      durable: true,
    });
  });

  it('answers a name that did not change as it came, still playing from the picker\'s URL', async () => {
    const path = `${CONTAINER}/Library/Application%20Support/videokit-gallery/A/original/IMG_0001.MOV`;
    bridge.retainMedia.mockResolvedValue({ uri: path, durable: true });

    expect(await retainPickedFile({ path, webPath: 'capacitor://served' })).toEqual({
      sourcePath: path,
      playbackUrl: 'capacitor://served',
      durable: true,
    });
  });

  it('passes on what retaining said about a name that will not last', async () => {
    bridge.retainMedia.mockResolvedValue({ uri: 'content://media/picker/0/42', durable: false });

    expect((await retainPickedFile({ path: 'content://media/picker/0/42' })).durable).toBe(false);
  });

  /* A pick that worked must not be undone by the step that was only ever about tomorrow. */
  it('falls back to the picker\'s own names when retaining fails, and never throws', async () => {
    bridge.retainMedia.mockRejectedValue(new Error('not implemented on android'));

    expect(await retainPickedFile({ path: 'content://media/picker/0/42', webPath: 'http://served/42' })).toEqual({
      sourcePath: 'content://media/picker/0/42',
      playbackUrl: 'http://served/42',
      durable: false,
    });
  });

  /*
   * Said on the console, behind the package's debug switch, because nothing else says it: the pick
   * carries on as though it had worked, and the draft only finds out a launch later.
   *
   * The switch is thrown through a second copy of its module, which is how it happens in an app: the
   * editor's bundle sets it when it is handed its host, and this file reads the plugin bundle's copy.
   */
  it('says why retaining failed when the host asked to hear, and nothing when it did not', async () => {
    vi.resetModules();
    const editorsCopy = await import('../host/debug');
    expect(editorsCopy.setEditorDebug).not.toBe(setEditorDebug);

    const refusal = new Error('not implemented on android');
    bridge.retainMedia.mockRejectedValue(refusal);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      editorsCopy.setEditorDebug(false);
      await retainPickedFile({ path: 'content://media/picker/0/42' });
      expect(warn).not.toHaveBeenCalled();

      editorsCopy.setEditorDebug(true);
      await retainPickedFile({ path: 'content://media/picker/0/42' });
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('[retainPickedFile]'), 'content://media/picker/0/42', refusal);
    } finally {
      setEditorDebug(false);
      warn.mockRestore();
    }
  });

  it('asks nothing for a pick with no path, and answers what it can play', async () => {
    expect(await retainPickedFile({ webPath: 'blob:https://example.test/a' })).toEqual({
      playbackUrl: 'blob:https://example.test/a',
      durable: false,
    });
    expect(await retainPickedFile({})).toEqual({ durable: false });
    expect(bridge.retainMedia).not.toHaveBeenCalled();
  });

  it('plays a moved file even when the picker gave no URL of its own', async () => {
    const kept = `${CONTAINER}/Library/Application%20Support/videokit-picked/9F.m4a`;
    bridge.retainMedia.mockResolvedValue({ uri: kept, durable: true });

    expect((await retainPickedFile({ path: `${CONTAINER}/tmp/voice.m4a` })).playbackUrl).toBe(
      kept.replace('file://', 'capacitor://localhost/_capacitor_file_'),
    );
  });
});

describe('gallerySource', () => {
  beforeEach(() => {
    bridge.resolveGalleryVideo.mockReset();
  });

  const listed = (kind?: GalleryVideo['kind']): GalleryVideo => ({
    id: 'ph://A1B2',
    fileName: 'IMG_0042.MOV',
    durationMs: 4200,
    ...(kind ? { kind } : {}),
  });

  it('resolves the item and answers it as a source the editor opens, under the key it was given', async () => {
    const uri = `${CONTAINER}/Library/Application%20Support/videokit-gallery/A1B2/original/IMG_0042.MOV`;
    bridge.resolveGalleryVideo.mockResolvedValue({ uri, fileName: 'IMG_0042.MOV' });

    expect(await gallerySource(listed('video'), 'clip-1')).toEqual({
      key: 'clip-1',
      fileName: 'IMG_0042.MOV',
      sourcePath: uri,
      playbackUrl: uri.replace('file://', 'capacitor://localhost/_capacitor_file_'),
    });
    expect(bridge.resolveGalleryVideo).toHaveBeenCalledWith({ id: 'ph://A1B2' });
  });

  /* Without it the editor opens a picture as a video and reports it missing. */
  it('marks a picture as one, and leaves a video with no kind at all', async () => {
    bridge.resolveGalleryVideo.mockResolvedValue({ uri: 'content://media/external/images/media/3', fileName: 'beach.heic' });

    expect(await gallerySource(listed('image'), 'still')).toMatchObject({ kind: 'image', fileName: 'beach.heic' });
    expect(await gallerySource(listed(), 'clip')).not.toHaveProperty('kind');
  });

  it('takes the listing\'s name where the resolve found none', async () => {
    bridge.resolveGalleryVideo.mockResolvedValue({ uri: 'content://media/external/video/media/12', fileName: '' });

    expect((await gallerySource(listed('video'), 'clip')).fileName).toBe('IMG_0042.MOV');
  });

  it('rejects as the resolve does, for an item gone from the library since it was listed', async () => {
    const gone = Object.assign(new Error('gone'), { code: 'unreadable_input' });
    bridge.resolveGalleryVideo.mockRejectedValue(gone);

    await expect(gallerySource(listed('video'), 'clip')).rejects.toBe(gone);
  });
});
