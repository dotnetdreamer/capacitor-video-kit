import { MAX_LAYERS, MAX_VIDEO_TRACKS, PICTURE_CLIP_MS, PICTURE_SOURCE_MS, emptyManifest, type EditClip, type EditManifest } from '../editor';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveEditorHost } from '../host/defaults';
import type { EditorMediaHost, EditorSoundLibrary, EditorSource, ResolvedEditorHost, SavedSound } from '../host/host.types';
import type { Peaks, extractPeaks } from '../web-runtime/waveform';
import { EditorMedia, type PictureReader } from './editor-media';
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

  /**
   * How audio is measured, injected. The real one needs Web Audio, which the mock DOM these run
   * in has none of, so every test gets a stub and the waveform ones get one they can steer.
   */
  let measure: ReturnType<typeof vi.fn>;

  /**
   * How pictures are read, injected for the reason audio is: the mock DOM decodes no image. Each
   * test gets one that answers at once with a picture of 4000x3000, unless it says otherwise.
   */
  let pictures: { measure: ReturnType<typeof vi.fn>; thumbnail: ReturnType<typeof vi.fn> };

  function open(
    mediaHost: EditorMediaHost = fakeMedia(),
    peaks: Peaks | null = null,
    options: { pictures?: boolean; decodes?: boolean } = {},
  ): void {
    host = resolveEditorHost({ media: mediaHost, editing: { pictures: options.pictures } });
    store = new EditorStore(host);
    measure = vi.fn(async () => peaks);
    pictures = {
      measure: vi.fn(async () => (options.decodes === false ? null : { width: 4000, height: 3000 })),
      thumbnail: vi.fn(async () => 'data:image/jpeg;base64,thumb'),
    };
    media = new EditorMedia(store, host, measure as unknown as typeof extractPeaks, pictures as unknown as PictureReader);
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
      open(
        fakeMedia({
          probeDuration: vi.fn(async () => {
            throw new Error('unreadable');
          }),
        }),
      );

      expect(await media.probe(sources[1])).toBe(0);
      expect(store.durations.value.get('b')).toBe(0);
    });
  });

  describe('adding a clip', () => {
    it('lands the source, commits it after the selection, and cuts its filmstrip', async () => {
      store.select({ kind: 'clip', id: 'a' });
      await media.addClip();

      expect(store.clips.value.map(source => source.key)).toEqual(['a', 'b', 'picked']);
      expect(store.manifest.value.clips.map(c => c.clipKey)).toEqual(['a', 'picked', 'b']);
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
      open(
        fakeMedia({
          pickVideo: vi.fn(async () => {
            throw new Error('no permission');
          }),
        }),
      );
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
      host.platform.fileUrl = uri => `native://${uri}`;

      await media.loadFilmstrip({ key: 'c', fileName: 'c.mp4', thumbnailUrl: 'file:///poster.jpg' });

      const strip = store.filmstrips.value.get('c');
      expect(strip?.urls).toEqual(['native://file:///poster.jpg']);
      // A step as long as the clip, so the one frame stands for all of it.
      expect(strip?.stepMs).toBe(4000);
    });

    it('leaves the strip absent when the host has neither frames nor a poster', async () => {
      open(
        fakeMedia({
          thumbnails: vi.fn(async () => {
            throw new Error('no decoder');
          }),
        }),
      );
      await media.loadFilmstrip(sources[0]);

      expect(store.filmstrips.value.has('a')).toBe(false);
    });
  });

  describe('waveforms', () => {
    const PEAKS: Peaks = { stepMs: 10, peaks: Uint8Array.of(0, 128, 255), durationMs: 30, max: 255 };

    /** Lets the manifest watcher run and the measurement it started settle. */
    const settle = () => new Promise(done => setTimeout(done, 0));

    it('measures a track as soon as the manifest has one', async () => {
      open(fakeMedia(), PEAKS);
      media.useSound({ id: 's1', uri: 'blob:tune', fileName: 'tune', durationMs: 5000, savedAt: 0 });
      await settle();

      expect(store.waveforms.value.get('blob:tune')).toEqual(PEAKS);
    });

    it('measures a track that was already on a draft being reopened', async () => {
      open(fakeMedia(), PEAKS);
      store.commit('Seed', m => ({
        ...m,
        music: { uri: 'blob:saved', fileName: 'saved', sourceDurationMs: 9000, inMs: 0, outMs: 0, startMs: 0, volume: 1, loop: true, fadeOutMs: 0 },
      }));
      await settle();

      expect(store.waveforms.value.get('blob:saved')).toEqual(PEAKS);
    });

    it('measures every voiceover take as well as the music', async () => {
      open(fakeMedia(), PEAKS);
      store.commit('Seed', m => ({
        ...m,
        voiceovers: [
          { id: 'v1', uri: 'blob:take-1', startMs: 0, durationMs: 800, volume: 1 },
          { id: 'v2', uri: 'blob:take-2', startMs: 900, durationMs: 400, volume: 1 },
        ],
      }));
      await settle();

      expect(store.waveforms.value.get('blob:take-1')).toEqual(PEAKS);
      expect(store.waveforms.value.get('blob:take-2')).toEqual(PEAKS);
    });

    it('joins a measurement already in flight rather than reading the file twice', async () => {
      open(fakeMedia(), PEAKS);
      await Promise.all([media.loadWaveform('blob:tune'), media.loadWaveform('blob:tune')]);

      expect(measure).toHaveBeenCalledTimes(1);
    });

    it('asks again for nothing it has already measured', async () => {
      open(fakeMedia(), PEAKS);
      await media.loadWaveform('blob:tune');
      await media.loadWaveform('blob:tune');

      expect(measure).toHaveBeenCalledTimes(1);
    });

    it('turns the URI into something readable through the host first', async () => {
      open(fakeMedia(), PEAKS);
      host.platform.fileUrl = uri => `native://${uri}`;
      await media.loadWaveform('videokit-file:sounds/one');

      expect(measure).toHaveBeenCalledWith('native://videokit-file:sounds/one', undefined, 0);
      // Still filed under the URI the manifest knows, not the one the platform made.
      expect(store.waveforms.value.has('videokit-file:sounds/one')).toBe(true);
    });

    it('remembers a file it could not measure, so nothing retries it for ever', async () => {
      // A codec with no decoder here, a file too big, a browser with no Web Audio: all arrive as
      // null, and all have to be recorded - the watcher runs on every edit, and an unrecorded
      // failure would start the same decode again on each one.
      open(fakeMedia(), null);
      await media.loadWaveform('blob:broken');

      expect(store.waveforms.value.has('blob:broken')).toBe(true);
      expect(store.waveforms.value.get('blob:broken')).toBeNull();

      await media.loadWaveform('blob:broken');
      expect(measure).toHaveBeenCalledTimes(1);
    });

    it('keeps measuring after one file throws, and does not come back to it', async () => {
      open(fakeMedia(), PEAKS);
      measure.mockRejectedValueOnce(new Error('unreadable'));

      await media.loadWaveform('blob:bad');
      await media.loadWaveform('blob:good');

      // The throw is recorded as null rather than left absent. The manifest watcher runs on every
      // write of the manifest - during a gesture, every frame - so a file it could not read has
      // to be remembered, or it would be tried again thirty times a second for ever.
      expect(store.waveforms.value.get('blob:bad')).toBeNull();
      await media.loadWaveform('blob:bad');
      expect(measure).toHaveBeenCalledTimes(2);

      // And it did not take the queue down with it.
      expect(store.waveforms.value.get('blob:good')).toEqual(PEAKS);
    });

    it('passes the track length through, so a file too long to decode is turned down early', async () => {
      open(fakeMedia(), PEAKS);
      await media.loadWaveform('blob:tune', 9_000);

      expect(measure).toHaveBeenCalledWith('blob:tune', undefined, 9_000);
    });

    it('publishes a new map rather than changing the one it has', async () => {
      // The timeline reads this through a signal, and a map mutated in place would not wake it.
      open(fakeMedia(), PEAKS);
      const before = store.waveforms.value;
      await media.loadWaveform('blob:tune');

      expect(store.waveforms.value).not.toBe(before);
      expect(before.has('blob:tune')).toBe(false);
    });

    it('keeps a measurement after its track is removed, so an undo shows it at once', async () => {
      open(fakeMedia(), PEAKS);
      media.useSound({ id: 's1', uri: 'blob:tune', fileName: 'tune', durationMs: 5000, savedAt: 0 });
      await settle();
      store.removeMusic();
      await settle();

      expect(store.waveforms.value.get('blob:tune')).toEqual(PEAKS);

      store.undo();
      await settle();
      expect(measure).toHaveBeenCalledTimes(1);
    });

    it('stops watching the manifest once the editor is disposed', async () => {
      open(fakeMedia(), PEAKS);
      media.dispose();
      media.useSound({ id: 's1', uri: 'blob:tune', fileName: 'tune', durationMs: 5000, savedAt: 0 });
      await settle();

      expect(measure).not.toHaveBeenCalled();
    });

    it('writes nothing that lands after the editor has gone', async () => {
      open(fakeMedia(), PEAKS);
      const job = media.loadWaveform('blob:tune');
      media.dispose();
      await job;

      expect(store.waveforms.value.has('blob:tune')).toBe(false);
    });
  });

  describe('photos', () => {
    it('refuses at the layer cap before opening the picker', async () => {
      store.commit('Fill', m => ({
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
      open(
        fakeMedia({
          pickAudio: vi.fn(async () => {
            throw new Error('bad container');
          }),
        }),
      );
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
      open(
        fakeMedia({
          sounds: fakeLibrary({
            list: vi.fn(async () => {
              throw new Error('no disk');
            }),
          }),
        }),
      );
      await media.loadSounds();

      expect(media.sounds.value).toEqual([]);
      expect(media.soundsLoaded.value).toBe(true);
    });

    it("extracts a video's sound, puts it on the post and keeps it in the list", async () => {
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
      open(
        fakeMedia({
          sounds: fakeLibrary({
            extract: vi.fn(async () => {
              throw new Error('no space');
            }),
          }),
        }),
      );
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
      open(
        fakeMedia({
          sounds: fakeLibrary({
            remove: vi.fn(async () => {
              throw new Error('read only');
            }),
          }),
        }),
      );
      await media.loadSounds();
      await media.removeSound(saved.id);

      expect(media.sounds.value).toEqual([saved]);
      expect(store.toast.value?.text).toBe('That sound could not be deleted');
    });
  });

  describe('pictures on the timeline', () => {
    const photo: EditorSource = { key: 'photo', fileName: 'photo.jpg', playbackUrl: 'blob:photo', kind: 'image' };

    function mixedMedia(): EditorMediaHost {
      return fakeMedia({ pickMedia: vi.fn(async () => photo) });
    }

    it('keeps to videos while the host has not allowed pictures, whatever pickers it has', async () => {
      const mediaHost = mixedMedia();
      open(mediaHost);
      await media.addClip();

      expect(mediaHost.pickMedia).not.toHaveBeenCalled();
      expect(mediaHost.pickVideo).toHaveBeenCalledTimes(1);
      expect(store.manifest.value.clips.map(c => c.clipKey)).toEqual(['a', 'b', 'picked']);
    });

    it('lands a picked picture as a three second picture segment, and selects it', async () => {
      const mediaHost = mixedMedia();
      open(mediaHost, null, { pictures: true });
      await media.addClip();

      const added = store.manifest.value.clips[2];
      expect(added).toMatchObject({ clipKey: 'photo', image: true, speed: 1 });
      expect(added.outMs - added.inMs).toBe(PICTURE_CLIP_MS);
      expect(store.selectedClip.value?.id).toBe(added.id);
      expect(mediaHost.pickVideo).not.toHaveBeenCalled();
      // A picture is never handed to the host's duration probe: it opens a <video>.
      expect(mediaHost.probeDuration).not.toHaveBeenCalled();
      expect(store.durations.value.get('photo')).toBe(PICTURE_SOURCE_MS);
    });

    it('falls back to the video picker for a host that allows pictures but has no picker for them', async () => {
      const mediaHost = fakeMedia();
      open(mediaHost, null, { pictures: true });
      await media.addClip();

      expect(mediaHost.pickVideo).toHaveBeenCalledTimes(1);
      expect(store.manifest.value.clips[2].image).toBeUndefined();
    });

    it('opens a picture as a second video layer, a picture segment on it', async () => {
      open(mixedMedia(), null, { pictures: true });
      const trackId = await media.addVideoTrack();

      const track = store.manifest.value.videoTracks.find(t => t.id === trackId);
      expect(track?.clips[0]).toMatchObject({ clipKey: 'photo', image: true });
    });

    it('replaces a video segment with a picture that plays as long as the segment did', async () => {
      open(mixedMedia(), null, { pictures: true });
      store.select({ kind: 'clip', id: 'b' });
      await media.replaceSelectedClip();

      const replaced = store.manifest.value.clips[1];
      expect(replaced).toMatchObject({ id: 'b', clipKey: 'photo', image: true });
      expect(replaced.outMs - replaced.inMs).toBe(2000);
    });

    it('cuts a filmstrip of one small frame, standing for every tile', async () => {
      open(mixedMedia(), null, { pictures: true });
      await media.loadFilmstrip(photo);

      expect(pictures.thumbnail).toHaveBeenCalledWith('blob:photo', expect.any(Number));
      expect(store.filmstrips.value.get('photo')).toEqual({ stepMs: PICTURE_SOURCE_MS, urls: ['data:image/jpeg;base64,thumb'] });
      expect(host.media.thumbnails).not.toHaveBeenCalled();
    });

    it('reports a picture that no longer decodes, as it does a video that no longer opens', async () => {
      open(mixedMedia(), null, { pictures: true, decodes: false });
      await media.probe(photo);

      expect(store.unreadable.value.has('photo')).toBe(true);
    });

    it('never hands a picture to the audio decoder', async () => {
      open(mixedMedia(), null, { pictures: true });
      await media.addClip();
      await Promise.resolve();

      const measured = measure.mock.calls.map(call => call[0]);
      expect(measured).not.toContain('blob:photo');
    });

    it('says so when the picker itself failed', async () => {
      open(
        fakeMedia({
          pickMedia: vi.fn(async () => {
            throw new Error('denied');
          }),
        }),
        null,
        { pictures: true },
      );
      await media.addClip();

      expect(store.manifest.value.clips).toHaveLength(2);
      expect(store.toast.value?.text).toBe("That file can't be used. Try another one");
    });
  });
});
