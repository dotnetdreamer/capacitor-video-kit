import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EditorSource, EditorVoiceHost, ThumbnailRequest } from '../host/host.types';

import type {
  DeleteSoundOptions,
  ExtractAudioOptions,
  ExtractAudioResult,
  ListSoundsResult,
  ProbeOptions,
  ProbeResult,
  ThumbnailsOptions,
  ThumbnailsResult,
  VoiceRecordingResult,
} from './definitions';

/*
 * The platform, the plugin and the browser host, stood in for. The platform is one answer a test
 * sets; the plugin is every composer call this host makes; and the browser host is a fake whose
 * members are mocks, one made per `browserMediaHost()` call, so a test can say which member the
 * editor was handed by identity - "the browser's own" is a claim about WHICH function, not about
 * what a file input does, which `host/defaults.unit.test.ts` covers. `real` swaps the fake for the
 * browser host itself, for the few tests about how the two fit together.
 */
const kit = vi.hoisted(() => {
  const fakeBrowserHost = () => ({
    pickVideo: vi.fn(async (): Promise<EditorSource | null> => null),
    pickMedia: vi.fn(async (): Promise<EditorSource | null> => null),
    pickImage: vi.fn(async () => null),
    pickAudio: vi.fn(async () => null),
    probeDuration: vi.fn(async (_source: EditorSource): Promise<number> => 0),
    thumbnails: vi.fn(async (_request: ThumbnailRequest): Promise<string[]> => ['data:image/jpeg;base64,browser']),
    sounds: { list: vi.fn(async () => []), extract: vi.fn(async () => null), remove: vi.fn(async () => undefined) },
    release: vi.fn(),
  });
  return {
    native: false,
    real: false,
    fakeBrowserHost,
    browsers: [] as ReturnType<typeof fakeBrowserHost>[],
    composer: {
      probe: vi.fn<(options: ProbeOptions) => Promise<ProbeResult>>(),
      thumbnails: vi.fn<(options: ThumbnailsOptions) => Promise<ThumbnailsResult>>(),
      listSounds: vi.fn<() => Promise<ListSoundsResult>>(),
      extractAudio: vi.fn<(options: ExtractAudioOptions) => Promise<ExtractAudioResult>>(),
      deleteSound: vi.fn<(options: DeleteSoundOptions) => Promise<void>>(),
      startVoiceRecording: vi.fn<() => Promise<void>>(),
      stopVoiceRecording: vi.fn<() => Promise<VoiceRecordingResult>>(),
    },
  };
});

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => kit.native },
  registerPlugin: () => kit.composer,
  WebPlugin: class {},
}));

vi.mock('../host/defaults', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../host/defaults')>();
  return {
    ...actual,
    browserMediaHost: () => {
      if (kit.real) return actual.browserMediaHost();
      const host = kit.fakeBrowserHost();
      kit.browsers.push(host);
      return host;
    },
  };
});

import { composerMediaHost, probeMediaDuration, type ComposerMediaHostOptions } from './media-host';

/** A clip a native picker handed over: the file itself, and the URL the WebView plays it by. */
const CLIP: EditorSource = {
  key: 'clip-1',
  fileName: 'holiday.mp4',
  sourcePath: 'file:///app/Library/Application%20Support/videokit-picked/9F2C.mp4',
  playbackUrl: 'capacitor://localhost/_capacitor_file_/app/Library/Application%20Support/videokit-picked/9F2C.mp4',
};

const TAKE = 'file:///app/Library/Caches/video-composer/voice/vo-1.m4a';

/** The host under test, and the browser host it was built on. */
function build(options?: ComposerMediaHostOptions) {
  const host = composerMediaHost(options);
  const browser = kit.browsers.at(-1);
  if (!browser) throw new Error('composerMediaHost built no browser host');
  return { host, browser };
}

function frames(source: EditorSource): ThumbnailRequest {
  return { source, timesMs: [0, 1000], maxHeight: 160, precise: true };
}

/** A composer rejection as Capacitor delivers one: an Error with the machine word on `code`. */
function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

beforeEach(() => {
  kit.native = false;
  kit.real = false;
  kit.browsers.length = 0;
  for (const call of Object.values(kit.composer)) call.mockReset();
  // The global Capacitor puts in the page, which is all `webViewUrl` reads.
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    convertFileSrc: (path: string) => path.replace('file://', 'capacitor://localhost/_capacitor_file_'),
  };
});

afterEach(() => {
  delete (globalThis as { Capacitor?: unknown }).Capacitor;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('composerMediaHost in a page', () => {
  it('is the browser host, member for member, when the host brought nothing', () => {
    const { host, browser } = build();

    expect(host.pickVideo).toBe(browser.pickVideo);
    expect(host.pickMedia).toBe(browser.pickMedia);
    expect(host.pickImage).toBe(browser.pickImage);
    expect(host.pickAudio).toBe(browser.pickAudio);
    expect(host.probeDuration).toBe(browser.probeDuration);
    expect(host.thumbnails).toBe(browser.thumbnails);
    expect(host.sounds).toBe(browser.sounds);
    expect(host.release).toBe(browser.release);
  });

  it('asks the composer nothing, even about a source with a path', async () => {
    const { host, browser } = build();

    await host.probeDuration(CLIP);
    await host.thumbnails(frames(CLIP));

    expect(browser.probeDuration).toHaveBeenCalledWith(CLIP);
    expect(kit.composer.probe).not.toHaveBeenCalled();
    expect(kit.composer.thumbnails).not.toHaveBeenCalled();
  });

  /* The web composer's take is a `videokit-file:` name, which the editor's preview cannot play. */
  it('has no voiceover recorder, so the editor does not offer the sheet', () => {
    expect('voice' in build().host).toBe(false);
  });

  /* The web composer keeps its sounds in the browser library's own IndexedDB store. */
  it('keeps the browser library when asked for the native one, which is the same library in a page', async () => {
    const { host, browser } = build({ sounds: 'native' });

    expect(host.sounds).toBe(browser.sounds);
    await host.sounds?.list();
    expect(kit.composer.listSounds).not.toHaveBeenCalled();
  });
});

describe('probing a source on a phone', () => {
  beforeEach(() => {
    kit.native = true;
  });

  it('asks the composer about the file itself, and rounds what it answers', async () => {
    kit.composer.probe.mockResolvedValue({ durationMs: 4200.6, width: 720, height: 1280, rotation: 0, hasAudio: true, hasVideo: true });
    const { host, browser } = build();

    await expect(host.probeDuration(CLIP)).resolves.toBe(4201);
    expect(kit.composer.probe).toHaveBeenCalledWith({ uri: CLIP.sourcePath });
    expect(browser.probeDuration).not.toHaveBeenCalled();
  });

  it('falls back on the page when the composer cannot read the file', async () => {
    kit.composer.probe.mockRejectedValue(coded('unreadable_input'));
    const { host, browser } = build();
    browser.probeDuration.mockResolvedValue(900);

    await expect(host.probeDuration(CLIP)).resolves.toBe(900);
    expect(browser.probeDuration).toHaveBeenCalledWith(CLIP);
  });

  it('rejects a file neither the composer nor the page can open, as the page worded it', async () => {
    kit.composer.probe.mockRejectedValue(coded('unreadable_input'));
    const { host, browser } = build();
    browser.probeDuration.mockRejectedValue(new Error('The browser could not open holiday.mp4'));

    await expect(host.probeDuration(CLIP)).rejects.toThrow('holiday.mp4');
  });

  it('asks the page about a file the composer opened with no length, which may know better', async () => {
    kit.composer.probe.mockResolvedValue({ durationMs: 0, width: 720, height: 1280, rotation: 0, hasAudio: true, hasVideo: true });
    const { host, browser } = build();
    browser.probeDuration.mockResolvedValue(3000);

    await expect(host.probeDuration(CLIP)).resolves.toBe(3000);
  });

  /* A rejection is the editor's "your clip has gone", which a file the composer opened has not. */
  it('calls that file 0 long rather than unreadable when the page cannot open it either', async () => {
    kit.composer.probe.mockResolvedValue({ durationMs: 0, width: 720, height: 1280, rotation: 0, hasAudio: true, hasVideo: true });
    const { host, browser } = build();
    browser.probeDuration.mockRejectedValue(new Error('The browser could not open holiday.mp4'));

    await expect(host.probeDuration(CLIP)).resolves.toBe(0);
  });

  it('has only the page for a source with no path', async () => {
    const { host, browser } = build();
    const picked: EditorSource = { key: 'web-1', fileName: 'a.mp4', playbackUrl: 'blob:capacitor://localhost/a' };
    browser.probeDuration.mockResolvedValue(1500);

    await expect(host.probeDuration(picked)).resolves.toBe(1500);
    expect(kit.composer.probe).not.toHaveBeenCalled();
  });
});

/*
 * The same probe on a URI, for a host's own pickers. The element it falls back on is the browser
 * host's own `mediaDuration`, which is not stood in for: what is, is the element `createElement`
 * answers it.
 */
describe('probeMediaDuration', () => {
  const TRACK = 'file:///app/tmp/picked/song.m4a';
  const SERVED_TRACK = 'capacitor://localhost/_capacitor_file_/app/tmp/picked/song.m4a';

  /** Every media element made from here on, as its tag and URL, each opening `seconds` long, or failing to on null. */
  function elementsOpen(seconds: number | null): { tag: string; src: string }[] {
    const opened: { tag: string; src: string }[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'video' && tag !== 'audio') return create(tag);
      const element = {
        duration: seconds ?? Number.NaN,
        onloadedmetadata: null as (() => void) | null,
        onerror: null as (() => void) | null,
        removeAttribute: () => undefined,
        load: () => undefined,
        set src(url: string) {
          opened.push({ tag, src: url });
          queueMicrotask(() => (seconds === null ? element.onerror?.() : element.onloadedmetadata?.()));
        },
      };
      return element as unknown as HTMLMediaElement;
    }) as typeof document.createElement);
    return opened;
  }

  function composerReads(durationMs: number): void {
    kit.composer.probe.mockResolvedValue({ durationMs, width: 0, height: 0, rotation: 0, hasAudio: true, hasVideo: false });
  }

  describe('on a phone', () => {
    beforeEach(() => {
      kit.native = true;
    });

    it('asks the composer about a device file, rounds what it answers, and opens nothing', async () => {
      composerReads(183_400.4);
      const opened = elementsOpen(1);

      await expect(probeMediaDuration(TRACK, 'audio')).resolves.toBe(183_400);
      expect(kit.composer.probe).toHaveBeenCalledWith({ uri: TRACK });
      expect(opened).toEqual([]);
    });

    it('asks the composer about a content URI and a bare path too', async () => {
      composerReads(1000);
      elementsOpen(1);

      await probeMediaDuration('content://com.android.providers.media.documents/document/audio%3A42', 'audio');
      await probeMediaDuration('/data/user/0/app/cache/song.mp3', 'audio');

      expect(kit.composer.probe.mock.calls.map(([options]) => options.uri)).toEqual([
        'content://com.android.providers.media.documents/document/audio%3A42',
        '/data/user/0/app/cache/song.mp3',
      ]);
    });

    it('falls back on the element of the kind asked for, through the local server, when the composer cannot read the file', async () => {
      kit.composer.probe.mockRejectedValue(coded('unreadable_input'));
      const opened = elementsOpen(12.5);

      await expect(probeMediaDuration(TRACK, 'audio')).resolves.toBe(12_500);
      expect(opened).toEqual([{ tag: 'audio', src: SERVED_TRACK }]);
    });

    it('asks the element about a file the composer opened with no length, and calls it 0 long when the element cannot open it', async () => {
      composerReads(0);
      elementsOpen(7);
      await expect(probeMediaDuration(TRACK, 'audio')).resolves.toBe(7000);

      vi.restoreAllMocks();
      elementsOpen(null);
      await expect(probeMediaDuration(TRACK, 'audio')).resolves.toBe(0);
    });

    /* Null is what a host refuses a pick for, before a render fails on it. */
    it('is null for a file neither the composer nor the element can open', async () => {
      kit.composer.probe.mockRejectedValue(coded('unreadable_input'));
      elementsOpen(null);

      await expect(probeMediaDuration(TRACK, 'audio')).resolves.toBeNull();
    });

    it('asks the composer nothing about a URL the page loads itself, a video by default', async () => {
      const opened = elementsOpen(3);

      await expect(probeMediaDuration('blob:capacitor://localhost/9b1c')).resolves.toBe(3000);
      expect(kit.composer.probe).not.toHaveBeenCalled();
      expect(opened).toEqual([{ tag: 'video', src: 'blob:capacitor://localhost/9b1c' }]);
    });
  });

  it('has only the element in a page, even for a device file', async () => {
    const opened = elementsOpen(2);

    await expect(probeMediaDuration(TRACK, 'audio')).resolves.toBe(2000);
    expect(kit.composer.probe).not.toHaveBeenCalled();
    expect(opened).toEqual([{ tag: 'audio', src: SERVED_TRACK }]);
  });

  it('is null for no URI at all, and opens nothing', async () => {
    kit.native = true;
    const opened = elementsOpen(1);

    await expect(probeMediaDuration('', 'audio')).resolves.toBeNull();
    expect(kit.composer.probe).not.toHaveBeenCalled();
    expect(opened).toEqual([]);
  });
});

describe('filmstrip frames on a phone', () => {
  beforeEach(() => {
    kit.native = true;
  });

  it('hands the composer\'s files back as URLs the WebView is allowed to load', async () => {
    kit.composer.thumbnails.mockResolvedValue({ uris: ['file:///app/Library/Caches/thumbs/0.jpg', 'file:///app/Library/Caches/thumbs/1000.jpg'] });
    const { host, browser } = build();
    const request = frames(CLIP);

    await expect(host.thumbnails(request)).resolves.toEqual([
      'capacitor://localhost/_capacitor_file_/app/Library/Caches/thumbs/0.jpg',
      'capacitor://localhost/_capacitor_file_/app/Library/Caches/thumbs/1000.jpg',
    ]);
    expect(kit.composer.thumbnails).toHaveBeenCalledWith({ uri: CLIP.sourcePath, timesMs: [0, 1000], maxHeight: 160, precise: true });
    // A copy: the editor's list is read-only, and the bridge is handed an array of its own.
    expect(kit.composer.thumbnails.mock.calls[0]?.[0].timesMs).not.toBe(request.timesMs);
    expect(browser.thumbnails).not.toHaveBeenCalled();
  });

  it('cuts them in the page for a source with no path, which the composer cannot open', async () => {
    const { host, browser } = build();
    const picked: EditorSource = { key: 'web-1', fileName: 'a.mp4', playbackUrl: 'blob:capacitor://localhost/a' };

    await expect(host.thumbnails(frames(picked))).resolves.toEqual(['data:image/jpeg;base64,browser']);
    expect(browser.thumbnails).toHaveBeenCalledWith(frames(picked));
    expect(kit.composer.thumbnails).not.toHaveBeenCalled();
  });

  /* The editor falls back on the poster frame for a strip that failed. */
  it('passes on a composer that could not cut them', async () => {
    kit.composer.thumbnails.mockRejectedValue(coded('unreadable_input'));

    await expect(build().host.thumbnails(frames(CLIP))).rejects.toThrow('unreadable_input');
  });
});

describe('the voiceover recorder on a phone', () => {
  beforeEach(() => {
    kit.native = true;
  });

  it('is the composer\'s, started as it is, with the codes the editor reads passed straight on', async () => {
    const voice = build().host.voice;
    if (!voice) throw new Error('no recorder on a phone');

    kit.composer.startVoiceRecording.mockResolvedValue(undefined);
    await voice.start();
    expect(kit.composer.startVoiceRecording).toHaveBeenCalledTimes(1);

    const busy = coded('already_recording');
    kit.composer.startVoiceRecording.mockRejectedValue(busy);
    await expect(voice.start()).rejects.toBe(busy);
  });

  it('hands a take back as an object URL over its bytes, typed as the recorder writes it', async () => {
    kit.composer.stopVoiceRecording.mockResolvedValue({ uri: TAKE, durationMs: 4200 });
    // What Capacitor's iOS local server answers for a whole file: no HTTP status and no type.
    const read = vi.fn().mockResolvedValue({ ok: false, status: 0, blob: async () => new Blob(['take']) });
    vi.stubGlobal('fetch', read);
    const minted: Blob[] = [];
    const mint = URL.createObjectURL.bind(URL);
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
      minted.push(blob as Blob);
      return mint(blob as Blob);
    });

    const take = await build().host.voice?.stop();

    expect(take).toEqual({ uri: expect.stringMatching(/^blob:/), durationMs: 4200 });
    expect(read).toHaveBeenCalledWith('capacitor://localhost/_capacitor_file_/app/Library/Caches/video-composer/voice/vo-1.m4a');
    // The type a render names its staged copy after: `m4a`.
    expect(minted.map((blob) => blob.type)).toEqual(['audio/mp4']);
  });

  /* The file still plays and still renders today; only a draft reopened after a day loses it. */
  it('keeps a take it cannot read into the page as its file, rather than losing it', async () => {
    kit.composer.stopVoiceRecording.mockResolvedValue({ uri: TAKE, durationMs: 4200 });
    const { host } = build();

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('Load failed')));
    await expect(host.voice?.stop()).resolves.toEqual({ uri: TAKE, durationMs: 4200 });

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob([]) }));
    await expect(host.voice?.stop()).resolves.toEqual({ uri: TAKE, durationMs: 4200 });
  });

  it('passes on a stop that failed, and reads nothing', async () => {
    const failed = coded('recording_failed');
    kit.composer.stopVoiceRecording.mockRejectedValue(failed);
    const read = vi.fn();
    vi.stubGlobal('fetch', read);

    await expect(build().host.voice?.stop()).rejects.toBe(failed);
    expect(read).not.toHaveBeenCalled();
  });

  /* A read that outlasts it would run the editor out of its own time for the stop, and lose the take. */
  it('hands a take that is slow to read back as its file, and mints nothing when the read comes in late', async () => {
    vi.useFakeTimers();
    kit.composer.stopVoiceRecording.mockResolvedValue({ uri: TAKE, durationMs: 4200 });
    let arrive: (response: unknown) => void = () => undefined;
    vi.stubGlobal('fetch', vi.fn(() => new Promise((settle) => { arrive = settle; })));
    const mint = vi.spyOn(URL, 'createObjectURL');
    const { host } = build();

    let settled = false;
    const stopped = host.voice?.stop().finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(2999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(stopped).resolves.toEqual({ uri: TAKE, durationMs: 4200 });

    arrive({ ok: true, status: 200, blob: async () => new Blob(['take']) });
    await vi.runAllTimersAsync();
    expect(mint).not.toHaveBeenCalled();
  });

  /* `openMicrophone` in the voiceover sheet stops it and throws the take away, and it may be minutes long. */
  it('hands back a recording a reloaded page left running as its file, unread', async () => {
    kit.composer.startVoiceRecording.mockRejectedValueOnce(coded('already_recording')).mockResolvedValue(undefined);
    kit.composer.stopVoiceRecording.mockResolvedValue({ uri: TAKE, durationMs: 600_000 });
    const read = vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['take']) });
    vi.stubGlobal('fetch', read);
    const voice = build().host.voice;
    if (!voice) throw new Error('no recorder on a phone');

    await expect(voice.start()).rejects.toMatchObject({ code: 'already_recording' });
    await expect(voice.stop()).resolves.toEqual({ uri: TAKE, durationMs: 600_000 });
    expect(read).not.toHaveBeenCalled();

    // The take recorded after it is the customer's, and read as any other.
    await voice.start();
    await expect(voice.stop()).resolves.toEqual({ uri: expect.stringMatching(/^blob:/), durationMs: 600_000 });
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads the take after a start refused for any other reason', async () => {
    kit.composer.startVoiceRecording.mockRejectedValue(coded('permission_denied'));
    kit.composer.stopVoiceRecording.mockResolvedValue({ uri: TAKE, durationMs: 4200 });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['take']) }));
    const voice = build().host.voice;
    if (!voice) throw new Error('no recorder on a phone');

    await expect(voice.start()).rejects.toMatchObject({ code: 'permission_denied' });
    await expect(voice.stop()).resolves.toEqual({ uri: expect.stringMatching(/^blob:/), durationMs: 4200 });
  });

  it('is none when the host turns it off', () => {
    expect('voice' in build({ voice: false }).host).toBe(false);
  });
});

describe('a recorder of the host\'s own', () => {
  const own: EditorVoiceHost = { start: async () => undefined, stop: async () => ({ uri: 'blob:own', durationMs: 1 }) };

  it('is used on a phone', () => {
    kit.native = true;
    expect(build({ voice: own }).host.voice).toBe(own);
  });

  it('is used in a page', () => {
    expect(build({ voice: own }).host.voice).toBe(own);
  });
});

describe('the sound library', () => {
  it('is the browser\'s by default, on a phone too', () => {
    kit.native = true;
    const { host, browser } = build();
    expect(host.sounds).toBe(browser.sounds);
  });

  it('is the host\'s own when it brings one, on either platform', () => {
    const own = { list: async () => [], extract: async () => null, remove: async () => undefined };
    expect(build({ sounds: own }).host.sounds).toBe(own);
    kit.native = true;
    expect(build({ sounds: own }).host.sounds).toBe(own);
  });
});

describe('the composer\'s sound library on a phone', () => {
  beforeEach(() => {
    kit.native = true;
  });

  function library() {
    const sounds = build({ sounds: 'native' }).host.sounds;
    if (!sounds) throw new Error('no library');
    return sounds;
  }

  it('lists the composer\'s sounds as it reports them, naming one it could not name', async () => {
    kit.composer.listSounds.mockResolvedValue({
      sounds: [
        { id: 's2', uri: 'file:///app/sounds/s2.m4a', fileName: '', durationMs: 0, savedAt: 20 },
        { id: 's1', uri: 'file:///app/sounds/s1.m4a', fileName: 'holiday', durationMs: 9000, savedAt: 10, sourceName: 'holiday.mp4' },
      ],
    });

    await expect(library().list()).resolves.toEqual([
      { id: 's2', uri: 'file:///app/sounds/s2.m4a', fileName: 'Sound', durationMs: 0, savedAt: 20 },
      { id: 's1', uri: 'file:///app/sounds/s1.m4a', fileName: 'holiday', durationMs: 9000, savedAt: 10, sourceName: 'holiday.mp4' },
    ]);
  });

  it('extracts from the file itself, under the video\'s name without its extension', async () => {
    kit.composer.extractAudio.mockResolvedValue({
      hasAudio: true,
      id: 's1',
      uri: 'file:///app/sounds/s1.m4a',
      fileName: 'holiday',
      durationMs: 9000,
      savedAt: 10,
    });

    await expect(library().extract(CLIP)).resolves.toEqual({
      id: 's1',
      uri: 'file:///app/sounds/s1.m4a',
      fileName: 'holiday',
      durationMs: 9000,
      savedAt: 10,
      sourceName: 'holiday.mp4',
    });
    expect(kit.composer.extractAudio).toHaveBeenCalledWith({ uri: CLIP.sourcePath, fileName: 'holiday' });
  });

  it('reads the URL of a source with no path', async () => {
    kit.composer.extractAudio.mockResolvedValue({ hasAudio: false });
    const picked: EditorSource = { key: 'web-1', fileName: 'clip', playbackUrl: 'blob:capacitor://localhost/a' };

    await library().extract(picked);

    expect(kit.composer.extractAudio).toHaveBeenCalledWith({ uri: 'blob:capacitor://localhost/a', fileName: 'clip' });
  });

  it('refuses a source with nothing behind it, and asks the composer nothing', async () => {
    await expect(library().extract({ key: 'k', fileName: 'gone.mp4' })).rejects.toThrow('gone.mp4');
    expect(kit.composer.extractAudio).not.toHaveBeenCalled();
  });

  it('answers null for a video with no sound in it, and for an answer it does not understand', async () => {
    kit.composer.extractAudio.mockResolvedValue({ hasAudio: false });
    await expect(library().extract(CLIP)).resolves.toBeNull();

    kit.composer.extractAudio.mockResolvedValue({ hasAudio: true, uri: 'file:///app/sounds/s1.m4a' });
    await expect(library().extract(CLIP)).resolves.toBeNull();
  });

  it('fills in what the composer left out', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1234);
    kit.composer.extractAudio.mockResolvedValue({ hasAudio: true, id: 's1', uri: 'file:///app/sounds/s1.m4a' });

    await expect(library().extract({ ...CLIP, fileName: '' })).resolves.toEqual({
      id: 's1',
      uri: 'file:///app/sounds/s1.m4a',
      fileName: 'Sound',
      durationMs: 0,
      savedAt: 1234,
    });
  });

  /* The composer then names the sound after the file it read, which says more than `Sound`. */
  it('leaves naming a sound from a source with no name to the composer', async () => {
    kit.composer.extractAudio.mockResolvedValue({ hasAudio: true, id: 's1', uri: 'file:///app/sounds/s1.m4a', fileName: '9F2C' });

    await expect(library().extract({ ...CLIP, fileName: '' })).resolves.toMatchObject({ fileName: '9F2C' });
    expect(kit.composer.extractAudio).toHaveBeenCalledWith({ uri: CLIP.sourcePath });
  });

  it('deletes by id', async () => {
    kit.composer.deleteSound.mockResolvedValue(undefined);
    await library().remove('s1');
    expect(kit.composer.deleteSound).toHaveBeenCalledWith({ id: 's1' });
  });
});

describe('the host\'s pickers', () => {
  /** A service that passes itself, as an Angular host would, and reads its own state in each pick. */
  class Pickers {
    readonly clip: EditorSource = { key: 'own-1', fileName: 'own.mp4', sourcePath: 'file:///own.mp4' };
    async pickVideo(): Promise<EditorSource | null> {
      return this.clip;
    }
    async pickMedia(): Promise<EditorSource | null> {
      return { ...this.clip, kind: 'image' };
    }
  }

  it('are used on a phone and in a page alike, each called on the object it came on', async () => {
    for (const native of [true, false]) {
      kit.native = native;
      const pickers = new Pickers();
      const { host, browser } = build({ pickers });

      await expect(host.pickVideo()).resolves.toBe(pickers.clip);
      await expect(host.pickMedia?.()).resolves.toEqual({ ...pickers.clip, kind: 'image' });
      // What the host did not bring stays the browser's.
      expect(host.pickImage).toBe(browser.pickImage);
      expect(host.pickAudio).toBe(browser.pickAudio);
      expect(browser.pickVideo).not.toHaveBeenCalled();
    }
  });

  /* So that with pictures on, the editor's clip pickers fall back on the host's own `pickVideo`. */
  it('leave out the browser\'s mixed picker for a host that brought a video picker and no other', () => {
    kit.native = true;
    const { host } = build({ pickers: { pickVideo: async () => null } });

    expect(host.pickMedia).toBeUndefined();
  });

  it('leave the browser\'s mixed picker to a host that brought no video picker', async () => {
    const pickImage = vi.fn(async () => null);
    const { host, browser } = build({ pickers: { pickImage } });

    expect(host.pickMedia).toBe(browser.pickMedia);
    await host.pickImage();
    expect(pickImage).toHaveBeenCalledTimes(1);
    expect(browser.pickImage).not.toHaveBeenCalled();
  });

  it('keep the browser\'s video picker for a host that brought only a mixed one', async () => {
    kit.native = true;
    const pickMedia = vi.fn(async (): Promise<EditorSource | null> => null);
    const { host, browser } = build({ pickers: { pickMedia } });

    expect(host.pickVideo).toBe(browser.pickVideo);
    await host.pickMedia?.();
    expect(pickMedia).toHaveBeenCalledTimes(1);
    expect(browser.pickMedia).not.toHaveBeenCalled();
  });
});

describe('giving back what the edit dropped', () => {
  const request = { kept: [CLIP], dropped: [{ key: 'clip-2', fileName: 'b.mp4', playbackUrl: 'blob:b' }] };

  it('runs the host\'s release after the browser host\'s own, with the same lists', () => {
    for (const native of [true, false]) {
      kit.native = native;
      const release = vi.fn();
      const { host, browser } = build({ release });

      host.release?.(request);

      expect(browser.release).toHaveBeenCalledWith(request);
      expect(release).toHaveBeenCalledWith(request);
      expect(browser.release.mock.invocationCallOrder[0]).toBeLessThan(release.mock.invocationCallOrder[0] ?? 0);
    }
  });

  it('is the browser host\'s alone when the host brought none', () => {
    kit.native = true;
    const { host, browser } = build();
    expect(host.release).toBe(browser.release);
  });
});

/*
 * Over the browser host itself rather than the fake, for what only shows where the two meet: the
 * browser probe the native one falls back on reading a source with only a path, and which members
 * of the browser host a host's own pickers leave standing.
 */
describe('composerMediaHost over the browser host itself', () => {
  beforeEach(() => {
    kit.real = true;
    kit.native = true;
  });

  /** Every `<video>` made from here on, as the URL it was pointed at, each opening `seconds` long. */
  function videosOpen(seconds: number): string[] {
    const opened: string[] = [];
    const create = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'video') return create(tag);
      const video = {
        duration: seconds,
        onloadedmetadata: null as (() => void) | null,
        onerror: null as (() => void) | null,
        removeAttribute: () => undefined,
        load: () => undefined,
        set src(url: string) {
          opened.push(url);
          queueMicrotask(() => video.onloadedmetadata?.());
        },
      };
      return video as unknown as HTMLVideoElement;
    }) as typeof document.createElement);
    return opened;
  }

  it('measures a source with only a path through Capacitor\'s local server when the composer cannot', async () => {
    kit.composer.probe.mockRejectedValue(coded('unreadable_input'));
    const opened = videosOpen(2.5);

    await expect(composerMediaHost().probeDuration({ key: 'a', fileName: 'a.mp4', sourcePath: CLIP.sourcePath })).resolves.toBe(2500);
    expect(kit.composer.probe).toHaveBeenCalledWith({ uri: CLIP.sourcePath });
    expect(opened).toEqual([CLIP.playbackUrl]);
  });

  it('keeps the browser\'s mixed picker, and drops it for a host that brought only a video picker', () => {
    expect(composerMediaHost().pickMedia).toBeTypeOf('function');

    const host = composerMediaHost({ pickers: { pickVideo: async () => null } });
    expect('pickMedia' in host).toBe(false);
    expect(host.pickImage).toBeTypeOf('function');
    expect(host.pickAudio).toBeTypeOf('function');
  });
});
