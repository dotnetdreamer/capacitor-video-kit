import { MAX_LAYERS, MAX_VIDEO_TRACKS, emptyManifest, type EditClip, type EditManifest } from '../editor';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveEditorHost } from '../host/defaults';
import type {
  EditorMediaHost,
  EditorSoundLibrary,
  EditorSource,
  ResolvedEditorHost,
  SavedSound,
} from '../host/host.types';
import { EditorMedia } from './editor-media';
import { EditorStore } from './editor-store';

function clip(id: string, inMs: number, outMs: number): EditClip {
  return { id, clipKey: id, inMs, outMs, speed: 1, volume: 1, muted: false };
}

/** A host that answers instantly and records what it was asked, so the order of calls is testable. */
function fakeMedia(overrides: Partial<EditorMediaHost> = {}): EditorMediaHost {
  return {
    pickVideo: vi.fn(async () => ({ key: 'picked', fileName: 'picked.mp4' })),
    pickImage: vi.fn(async () => ({ uri: 'blob:photo', fileName: 'photo.jpg', aspect: 1.5 })),
    pickAudio: vi.fn(async () => ({ uri: 'blob:music', fileName: 'music.mp3', sourceDurationMs: 9000 })),
    probeDuration: vi.fn(async () => 3000),
    thumbnails: vi.fn(async () => ['frame-0', 'frame-1', 'frame-2']),
    ...overrides,
  };
}

describe('EditorMedia', () => {
  let store: EditorStore;
  let host: ResolvedEditorHost;
  let media: EditorMedia;
  let base: EditManifest;

  const sources: EditorSource[] = [
    { key: 'a', fileName: 'a.mp4' },
    { key: 'b', fileName: 'b.mp4' },
  ];

  function open(mediaHost: EditorMediaHost = fakeMedia()): void {
    host = resolveEditorHost({ media: mediaHost });
    store = new EditorStore(host);
    media = new EditorMedia(store, host);
    base = { ...emptyManifest(), clips: [clip('a', 0, 4000), clip('b', 0, 2000)] };
    store.load(sources, new Map([['a', 4000]]), base);
  }

  beforeEach(() => open());

  describe('probe', () => {
    it('asks the host once and answers from the store after that', async () => {
      expect(await media.probe(sources[1])).toBe(3000);
      expect(store.durations.value.get('b')).toBe(3000);

      expect(await media.probe(sources[1])).toBe(3000);
      expect(host.media.probeDuration).toHaveBeenCalledTimes(1);
    });

    it('records a length of zero for a file the host could not open, without throwing', async () => {
      open(fakeMedia({ probeDuration: vi.fn(async () => { throw new Error('unreadable'); }) }));

      expect(await media.probe(sources[1])).toBe(0);
      expect(store.durations.value.get('b')).toBe(0);
    });
  });

  describe('adding a clip', () => {
    it('lands the source, commits it after the selection, and cuts its filmstrip', async () => {
      store.select({ kind: 'clip', id: 'a' });
      await media.addClip();

      expect(store.clips.value.map((source) => source.key)).toEqual(['a', 'b', 'picked']);
      expect(store.manifest.value.clips.map((c) => c.clipKey)).toEqual(['a', 'picked', 'b']);
      expect(store.selection.value?.kind).toBe('clip');
      expect(store.canUndo.value).toBe(true);
      expect(media.busy.value).toBe(false);

      await media.loadFilmstrip(store.clips.value[2]);
      expect(store.filmstrips.value.get('picked')?.urls).toEqual(['frame-0', 'frame-1', 'frame-2']);
    });

    it('changes nothing when the customer closed the picker', async () => {
      open(fakeMedia({ pickVideo: vi.fn(async () => null) }));
      await media.addClip();

      expect(store.clips.value).toEqual(sources);
      expect(store.manifest.value).toBe(base);
      expect(store.toast.value).toBeNull();
    });

    it('says so when the picker itself failed, which a cancel must never look like', async () => {
      open(fakeMedia({ pickVideo: vi.fn(async () => { throw new Error('no permission'); }) }));
      await media.addClip();

      expect(store.clips.value).toEqual(sources);
      expect(store.manifest.value).toBe(base);
      expect(store.toast.value?.text).toBe("That video can't be used. Try another one.");
    });

    it('refuses past the clip cap before opening the picker', async () => {
      store.maxClips.value = 2;
      await media.addClip();

      expect(host.media.pickVideo).not.toHaveBeenCalled();
      expect(store.toast.value?.text).toBe('You can add up to 2 clips');
    });
  });

  describe('adding a second video layer', () => {
    it('takes the source back out when the edit had no room for it', async () => {
      store.maxClips.value = 10;
      // The layers already on the post fill the cap, so the store refuses the next one and the
      // source it was picked for has nothing left referring to it.
      store.load(sources, new Map(), {
        ...base,
        videoTracks: Array.from({ length: MAX_VIDEO_TRACKS - 1 }, (_, i) => ({
          id: `vt${i}`,
          clips: [clip(`c${i}`, 0, 3000)],
          startMs: 0,
          z: i + 1,
          opacity: 1,
        })),
      });

      expect(await media.addVideoTrack()).toBeNull();
      expect(store.clips.value).toEqual(sources);
      expect(store.toast.value?.text).toBe(`You can have ${MAX_VIDEO_TRACKS} videos on screen at once`);
    });
  });

  describe('filmstrips', () => {
    it('joins a request already in flight rather than cutting the same clip twice', async () => {
      const first = media.loadFilmstrip(sources[0]);
      const second = media.loadFilmstrip(sources[0]);
      await Promise.all([first, second]);

      expect(host.media.thumbnails).toHaveBeenCalledTimes(1);
    });

    it('asks for frames on whole steps, and precisely only while the strip is short', async () => {
      await media.loadFilmstrip(sources[0]);

      const request = vi.mocked(host.media.thumbnails).mock.calls[0][0];
      expect(request.timesMs).toEqual([0, 1000, 2000, 3000]);
      expect(request.precise).toBe(true);
      expect(request.maxHeight).toBe(160);
    });

    it('falls back to the poster frame, through the host, when no frames came back', async () => {
      open(
        fakeMedia({
          thumbnails: vi.fn(async () => []),
          probeDuration: vi.fn(async () => 4000),
        }),
      );
      host.platform.fileUrl = (uri) => `native://${uri}`;

      await media.loadFilmstrip({ key: 'c', fileName: 'c.mp4', thumbnailUrl: 'file:///poster.jpg' });

      const strip = store.filmstrips.value.get('c');
      expect(strip?.urls).toEqual(['native://file:///poster.jpg']);
      // A step as long as the clip, so the one frame stands for all of it.
      expect(strip?.stepMs).toBe(4000);
    });

    it('leaves the strip absent when the host has neither frames nor a poster', async () => {
      open(fakeMedia({ thumbnails: vi.fn(async () => { throw new Error('no decoder'); }) }));
      await media.loadFilmstrip(sources[0]);

      expect(store.filmstrips.value.has('a')).toBe(false);
    });
  });

  describe('photos', () => {
    it('refuses at the layer cap before opening the picker', async () => {
      store.commit('Fill', (m) => ({
        ...m,
        overlays: Array.from({ length: MAX_LAYERS }, (_, i) => ({
          id: `s${i}`,
          kind: 'sticker' as const,
          emoji: 'x',
          assetId: null,
          cx: 0.5,
          cy: 0.5,
          scale: 1,
          rotationDeg: 0,
          opacity: 1,
          startMs: 0,
          endMs: 0,
        })),
      }));

      await media.pickPhoto();
      expect(host.media.pickImage).not.toHaveBeenCalled();
      expect(store.toast.value?.text).toBe(`You can add up to ${MAX_LAYERS} layers`);
    });

    it('adds the picked photo as a layer, at the aspect the host measured', async () => {
      await media.pickPhoto();

      const overlay = store.manifest.value.overlays[0];
      expect(overlay.kind).toBe('image');
      expect(overlay).toMatchObject({ uri: 'blob:photo', fileName: 'photo.jpg', aspect: 1.5 });
    });
  });

  describe('sound', () => {
    it('takes the track the host handed back, with its length', async () => {
      await media.pickMusic();

      expect(store.manifest.value.music).toMatchObject({
        uri: 'blob:music',
        fileName: 'music.mp3',
        sourceDurationMs: 9000,
      });
      expect(store.selection.value).toEqual({ kind: 'music' });
    });

    it('says so for a file that could not be read, and adds nothing', async () => {
      open(fakeMedia({ pickAudio: vi.fn(async () => { throw new Error('bad container'); }) }));
      await media.pickMusic();

      expect(store.manifest.value.music).toBeNull();
      expect(store.toast.value?.text).toBe("That audio file can't be used. Try an MP3 or M4A.");
    });

    it('keeps the volume the customer set when one track replaces another', async () => {
      await media.pickMusic();
      store.commitMusic({ volume: 0.25 }, 'Volume');
      await media.pickMusic();

      expect(store.manifest.value.music?.volume).toBe(0.25);
    });
  });

  describe('the sound library', () => {
    const saved: SavedSound = {
      id: 'snd-1',
      uri: 'file:///sounds/snd-1.m4a',
      fileName: 'holiday',
      durationMs: 12_000,
      savedAt: 1_700_000_000_000,
    };

    /** A library that answers instantly, so what the editor does with each answer is what is tested. */
    function fakeLibrary(overrides: Partial<EditorSoundLibrary> = {}): EditorSoundLibrary {
      return {
        list: vi.fn(async () => [saved]),
        extract: vi.fn(async () => saved),
        remove: vi.fn(async () => undefined),
        ...overrides,
      };
    }

    it('opens the sheet when the host keeps sounds, and the picker when it does not', () => {
      open(fakeMedia({ sounds: fakeLibrary() }));
      media.openSound();
      expect(store.panel.value).toBe('sound');

      open(fakeMedia());
      media.openSound();
      expect(store.panel.value).toBeNull();
      expect(host.media.pickAudio).toHaveBeenCalled();
    });

    it('reads the library into the list', async () => {
      open(fakeMedia({ sounds: fakeLibrary() }));
      await media.loadSounds();

      expect(media.sounds.value).toEqual([saved]);
      expect(media.soundsLoaded.value).toBe(true);
    });

    it('leaves the list alone but settles when the library will not answer', async () => {
      open(fakeMedia({ sounds: fakeLibrary({ list: vi.fn(async () => { throw new Error('no disk'); }) }) }));
      await media.loadSounds();

      expect(media.sounds.value).toEqual([]);
      expect(media.soundsLoaded.value).toBe(true);
    });

    it('extracts a video\'s sound, puts it on the post and keeps it in the list', async () => {
      const library = fakeLibrary();
      open(fakeMedia({ sounds: library }));
      await media.extractSound();

      expect(library.extract).toHaveBeenCalledWith(expect.objectContaining({ key: 'picked' }));
      expect(store.manifest.value.music).toMatchObject({ uri: saved.uri, fileName: 'holiday', sourceDurationMs: 12_000 });
      expect(media.sounds.value).toEqual([saved]);
      expect(media.extracting.value).toBe(false);
      expect(media.busy.value).toBe(false);
    });

    it('says a silent video is silent rather than broken, and adds nothing', async () => {
      open(fakeMedia({ sounds: fakeLibrary({ extract: vi.fn(async () => null) }) }));
      await media.extractSound();

      expect(store.manifest.value.music).toBeNull();
      expect(store.toast.value?.text).toBe('That video has no sound in it');
    });

    it('says so when the extraction failed, and adds nothing', async () => {
      open(fakeMedia({ sounds: fakeLibrary({ extract: vi.fn(async () => { throw new Error('no space'); }) }) }));
      await media.extractSound();

      expect(store.manifest.value.music).toBeNull();
      expect(store.toast.value?.text).toBe("That video's sound could not be saved. Try another one.");
      expect(media.extracting.value).toBe(false);
    });

    it('changes nothing when the customer closed the picker', async () => {
      const library = fakeLibrary();
      open(fakeMedia({ pickVideo: vi.fn(async () => null), sounds: library }));
      await media.extractSound();

      expect(library.extract).not.toHaveBeenCalled();
      expect(store.manifest.value.music).toBeNull();
    });

    it('uses a saved sound without touching the device', async () => {
      const library = fakeLibrary();
      open(fakeMedia({ sounds: library }));
      media.useSound(saved);

      expect(store.manifest.value.music).toMatchObject({ uri: saved.uri, fileName: 'holiday' });
      expect(store.selection.value).toEqual({ kind: 'music' });
      expect(host.media.pickAudio).not.toHaveBeenCalled();
    });

    it('drops a deleted sound from the list and leaves the post alone', async () => {
      const library = fakeLibrary();
      open(fakeMedia({ sounds: library }));
      await media.loadSounds();
      media.useSound(saved);
      await media.removeSound(saved.id);

      expect(library.remove).toHaveBeenCalledWith('snd-1');
      expect(media.sounds.value).toEqual([]);
      // The post keeps the track: the manifest holds the URI, not the library's record.
      expect(store.manifest.value.music?.uri).toBe(saved.uri);
    });

    it('puts the row back when the delete failed', async () => {
      open(fakeMedia({ sounds: fakeLibrary({ remove: vi.fn(async () => { throw new Error('read only'); }) }) }));
      await media.loadSounds();
      await media.removeSound(saved.id);

      expect(media.sounds.value).toEqual([saved]);
      expect(store.toast.value?.text).toBe('That sound could not be deleted');
    });
  });
});
