import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { editorDebug, setEditorDebug } from './debug';
import { browserMediaHost, envSafeAreaInsets, pickMediaFiles, resolveEditorHost } from './defaults';
import type { EditorInsets, EditorMediaHost, EditorSource } from './host.types';

const stubMedia: EditorMediaHost = {
  pickVideo: async () => null,
  pickImage: async () => null,
  pickAudio: async () => null,
  probeDuration: async () => 0,
  thumbnails: async () => [],
};

describe('resolveEditorHost', () => {
  afterEach(() => {
    setEditorDebug(false);
  });

  it('gives an editor with no host at all a working one', () => {
    const host = resolveEditorHost();

    expect(host.media.pickVideo).toBeInstanceOf(Function);
    expect(host.media.probeDuration).toBeInstanceOf(Function);
    expect(host.media.thumbnails).toBeInstanceOf(Function);
    expect(host.platform.debug).toBe(false);
  });

  it('leaves the render null, because a render is supplied rather than found', () => {
    expect(resolveEditorHost().render).toBeNull();
    expect(resolveEditorHost({ media: stubMedia }).render).toBeNull();
  });

  it('takes the host over the default for every part the host supplied', () => {
    const render = { isSupported: async () => true, render: async () => ({ key: 'k', fileName: 'k.mp4' }) };
    const host = resolveEditorHost({
      media: stubMedia,
      render,
      platform: { fileUrl: (uri) => `native://${uri}` },
    });

    expect(host.media).toBe(stubMedia);
    expect(host.render).toBe(render);
    expect(host.platform.fileUrl('a.mp4')).toBe('native://a.mp4');
  });

  it('leaves a URL alone by default, which is what a blob URL from a file input needs', () => {
    expect(resolveEditorHost().platform.fileUrl('blob:https://example.test/abc')).toBe(
      'blob:https://example.test/abc',
    );
  });

  it('does nothing for a haptic, and says so without throwing', () => {
    expect(() => resolveEditorHost().platform.haptic('light')).not.toThrow();
  });

  it('registers a back handler that unsubscribes cleanly', () => {
    const unsubscribe = resolveEditorHost().platform.registerBackHandler(() => true);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('reports no keyboard where there is no visual viewport, rather than never reporting', () => {
    const heights: number[] = [];
    const unsubscribe = resolveEditorHost().platform.keyboard.subscribe((height) => heights.push(height));

    expect(heights).toEqual([0]);
    expect(() => unsubscribe()).not.toThrow();
  });

  it('has no confirm of its own, so the editor knows to present its own alert', () => {
    expect(resolveEditorHost().platform.confirm).toBeNull();

    const confirm = vi.fn(async () => 'cancel');
    const host = resolveEditorHost({ platform: { confirm } });
    expect(host.platform.confirm).not.toBeNull();
  });

  it('measures no insets of its own, so the editor keeps the env() padding it already has', () => {
    expect(resolveEditorHost().platform.measureInsets).toBeNull();
  });

  it('keeps a host measurement bound to the object it came off', async () => {
    class NativePlatform {
      private readonly bars: EditorInsets = { top: 47, bottom: 24 };
      measureInsets(): Promise<EditorInsets> {
        return Promise.resolve(this.bars);
      }
    }
    const measure = resolveEditorHost({ platform: new NativePlatform() }).platform.measureInsets;

    // Unbound, the call throws on `this` and the editor never learns what the bars cover.
    await expect(measure?.()).resolves.toEqual({ top: 47, bottom: 24 });
  });

  it('turns the package\'s console output on and off with the host that asked for it', () => {
    resolveEditorHost({ platform: { debug: true } });
    expect(editorDebug()).toBe(true);

    resolveEditorHost();
    expect(editorDebug()).toBe(false);
  });

  /*
   * A host's upload limit, which is no limit at all unless it is a positive number of bytes: a zero
   * read from a typo would fail every render and mark every rung of the quality sheet.
   */
  it('takes a size ceiling in whole bytes, and reads one that is not a positive number as none', () => {
    expect(resolveEditorHost({ output: { maxBytes: 104_857_600 } }).output.maxBytes).toBe(104_857_600);
    expect(resolveEditorHost({ output: { maxBytes: 5_000_000.7 } }).output.maxBytes).toBe(5_000_000);

    expect(resolveEditorHost().output.maxBytes).toBeNull();
    // A fraction under one byte is positive, and a ceiling of 0 once rounded down: none, as well.
    for (const none of [0, -1, 0.5, 0.999, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(resolveEditorHost({ output: { maxBytes: none } }).output.maxBytes).toBeNull();
    }
  });
});

describe('envSafeAreaInsets', () => {
  it('answers in numbers where the page resolves env() to nothing at all', async () => {
    await expect(envSafeAreaInsets()).resolves.toEqual({ top: 0, bottom: 0 });
  });

  it('takes its probe back out of the document, whatever the reading was', async () => {
    const before = document.body.children.length;
    await envSafeAreaInsets();
    expect(document.body.children.length).toBe(before);
  });
});

describe('the browser media host', () => {
  it('refuses a source it cannot open rather than calling it zero length', async () => {
    const source: EditorSource = { key: 'a', fileName: 'a.mp4', playbackUrl: '' };
    await expect(resolveEditorHost().media.probeDuration(source)).rejects.toThrow('a.mp4');
  });

  it('cuts no frames for a source with nothing to play', async () => {
    const urls = await resolveEditorHost().media.thumbnails({
      source: { key: 'a', fileName: 'a.mp4' },
      timesMs: [0, 1000],
      maxHeight: 160,
      precise: false,
    });
    expect(urls).toEqual([]);
  });
});

describe('the browser media host giving back what the edit dropped', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('revokes the object URL of a dropped clip it minted itself', async () => {
    const media = browserMediaHost();
    const dropped = await pickVideoFile(media, 'dropped.mp4');
    const kept = await pickVideoFile(media, 'kept.mp4');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    media.release?.({ kept: [kept], dropped: [dropped] });

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(revoke).toHaveBeenCalledWith(dropped.playbackUrl);
  });

  it('gives the same URL back once, so a second release costs nothing', async () => {
    const media = browserMediaHost();
    const dropped = await pickVideoFile(media, 'dropped.mp4');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    media.release?.({ kept: [], dropped: [dropped] });
    media.release?.({ kept: [], dropped: [dropped] });

    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('holds on to a URL a kept source still names', async () => {
    const media = browserMediaHost();
    const source = await pickVideoFile(media, 'twice.mp4');
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    // One picked file behind two keys is the case both lists are here for.
    media.release?.({ kept: [{ ...source, key: 'second' }], dropped: [source] });

    expect(revoke).not.toHaveBeenCalled();
  });

  it('leaves alone a URL the application handed in, because the page may still be playing it', () => {
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    browserMediaHost().release?.({
      kept: [],
      dropped: [{ key: 'a', fileName: 'a.mp4', playbackUrl: 'blob:https://example.test/theirs' }],
    });

    expect(revoke).not.toHaveBeenCalled();
  });
});

describe('the browser audio picker', () => {
  /*
   * `audio/*` on its own greys out every file in the Files picker a WKWebView opens, because WebKit
   * finds no file type for the wildcard. What makes a song choosable there is a type WebKit CAN map,
   * so the input has to name the formats as well - and still lead with the wildcard every other
   * engine goes by.
   */
  it('names the common formats by type and by extension, after audio/*', async () => {
    const picked = browserMediaHost().pickAudio();
    const input = lastInput();

    const accept = input.accept.split(',');
    expect(accept[0]).toBe('audio/*');
    for (const one of ['audio/mpeg', '.mp3', 'audio/mp4', '.m4a', '.aac', '.wav', '.aiff', '.caf', '.flac', 'audio/ogg']) {
      expect(accept).toContain(one);
    }

    input.dispatchEvent(new Event('cancel'));
    await expect(picked).resolves.toBeNull();
  });
});

/*
 * WKWebView's file input hands the page an empty file when a song is picked again about a minute
 * after the first time, so a Capacitor app on iOS picks a sound through the kit's own document
 * picker - and must still hand the editor what the input does: an object URL it can play, and how
 * long the sound runs. The bridge is the global the native side puts in the page, stood in for here.
 */
describe('the audio picker in a Capacitor app on iOS', () => {
  const COPY = 'file:///private/var/mobile/Containers/Data/Application/A/tmp/videokit-audio/9F2C.m4a';
  const SERVED = COPY.replace('file://', 'capacitor://localhost/_capacitor_file_');
  let nativePromise: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    nativePromise = vi.fn();
    installBridge('ios', nativePromise);
  });

  afterEach(() => {
    delete (globalThis as { Capacitor?: unknown }).Capacitor;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('reads the kit\'s copy into an object URL typed as the picker said, as the file input would answer', async () => {
    nativePromise.mockResolvedValue({ cancelled: false, uri: COPY, fileName: 'qa-sample.m4a', mimeType: 'audio/x-m4a' });
    // What Capacitor's local server really answers for a whole sound: no HTTP status at all.
    const read = vi.fn().mockResolvedValue({ ok: false, status: 0, blob: async () => new Blob(['sound']) });
    vi.stubGlobal('fetch', read);
    const minted = soundPlaysFor(12.5);
    const inputs = document.querySelectorAll('input').length;

    const picked = await browserMediaHost().pickAudio();

    expect(picked).toEqual({ uri: expect.stringMatching(/^blob:/), fileName: 'qa-sample.m4a', sourceDurationMs: 12500 });
    expect(read).toHaveBeenCalledWith(SERVED);
    // The type goes with the bytes, because a render names its staged copy after it.
    expect(minted.map((blob) => blob.type)).toEqual(['audio/x-m4a']);
    // One question of the bridge: the copy is read once and then left for the next pick or the
    // plugin's next load to delete.
    expect(nativePromise).toHaveBeenCalledTimes(1);
    expect(nativePromise).toHaveBeenCalledWith('VideoComposer', 'pickAudioFile', {});
    // And no file input, which is the thing that could not be trusted.
    expect(document.querySelectorAll('input').length).toBe(inputs);
  });

  it('answers a cancel with null, and reads nothing', async () => {
    nativePromise.mockResolvedValue({ cancelled: true });
    const read = vi.fn();
    vi.stubGlobal('fetch', read);

    await expect(browserMediaHost().pickAudio()).resolves.toBeNull();
    expect(read).not.toHaveBeenCalled();
  });

  /* A song of no bytes is what the WebKit failure looked like, and cannot be one anybody picked. */
  it('refuses an empty copy, whatever status the server gave it', async () => {
    nativePromise.mockResolvedValue({ cancelled: false, uri: COPY, fileName: 'qa-sample.m4a', mimeType: 'audio/x-m4a' });
    const minted = soundPlaysFor(12.5);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob([]) }));
    await expect(browserMediaHost().pickAudio()).rejects.toThrow('qa-sample.m4a is empty');

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 0, blob: async () => new Blob([]) }));
    await expect(browserMediaHost().pickAudio()).rejects.toThrow();

    expect(minted).toEqual([]);
  });

  it('refuses a copy the server would not serve', async () => {
    nativePromise.mockResolvedValue({ cancelled: false, uri: COPY, fileName: 'qa-sample.m4a' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 404, blob: async () => new Blob(['not found']) }));

    await expect(browserMediaHost().pickAudio()).rejects.toThrow('404');
  });

  it('gives back the URL of a sound the WebView cannot open, then refuses it', async () => {
    nativePromise.mockResolvedValue({ cancelled: false, uri: COPY, fileName: 'noise.caf', mimeType: 'audio/x-caf' });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => new Blob(['noise']) }));
    soundPlaysFor(null);
    const revoke = vi.spyOn(URL, 'revokeObjectURL');

    await expect(browserMediaHost().pickAudio()).rejects.toThrow('noise.caf');
    expect(revoke).toHaveBeenCalledTimes(1);
  });

  it('passes on a picker that failed, rather than calling it a cancel', async () => {
    const failure = new Error('could not present the picker');
    nativePromise.mockRejectedValue(failure);

    await expect(browserMediaHost().pickAudio()).rejects.toBe(failure);
  });

  /*
   * iOS's bridge answers nothing at all for a method the native side lacks, so asking one without
   * `pickAudioFile` would leave the pick, and the editor's busy state, waiting for good. The header
   * the method is looked up in is the plugin's own: another plugin's method of the same name is not it.
   */
  it('gives an iOS build without the kit\'s picker the file input, rather than a call nothing answers', async () => {
    const headers = installBridge('ios', nativePromise, ['retainMedia', 'stageRenderInput']);
    headers.push({ name: 'SomeOtherPlugin', methods: [{ name: 'pickAudioFile', rtype: 'promise' }] });
    const picked = browserMediaHost().pickAudio();
    const input = lastInput();

    expect(input.accept.split(',')[0]).toBe('audio/*');
    input.dispatchEvent(new Event('cancel'));
    await expect(picked).resolves.toBeNull();
    expect(nativePromise).not.toHaveBeenCalled();
  });

  it('gives an iOS page with no plugin headers at all the file input', async () => {
    installBridge('ios', nativePromise);
    delete (globalThis as { Capacitor?: { PluginHeaders?: unknown } }).Capacitor?.PluginHeaders;
    const picked = browserMediaHost().pickAudio();

    lastInput().dispatchEvent(new Event('cancel'));
    await expect(picked).resolves.toBeNull();
    expect(nativePromise).not.toHaveBeenCalled();
  });

  /* Android's WebView answers the input with a documents browser that works. */
  it('leaves every other platform the file input', async () => {
    installBridge('android', nativePromise);
    const picked = browserMediaHost().pickAudio();
    const input = lastInput();

    expect(input.accept.split(',')[0]).toBe('audio/*');
    input.dispatchEvent(new Event('cancel'));
    await expect(picked).resolves.toBeNull();
    expect(nativePromise).not.toHaveBeenCalled();
  });
});

describe('pickMediaFiles', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('answers a cancel with nothing, however the browser reports it', async () => {
    const cancelled = pickMediaFiles({ limit: 3 });
    lastInput().dispatchEvent(new Event('cancel'));
    await expect(cancelled).resolves.toEqual([]);

    const emptied = pickMediaFiles({ limit: 3 });
    choose(lastInput(), []);
    await expect(emptied).resolves.toEqual([]);
  });

  it('takes several files at once, in the order the browser lists them, each with its length', async () => {
    const lengths = answerDurations({ 'a.mp4': 4.2, 'b.mp4': 12 });
    const picked = pickMediaFiles({ limit: 5 });
    const input = lastInput();
    expect(input.multiple).toBe(true);
    expect(input.accept).toBe('video/*');
    choose(input, [video('a.mp4'), video('b.mp4')]);

    const files = await picked;
    expect(files.map(file => [file.source.fileName, file.durationMs])).toEqual([
      ['a.mp4', 4200],
      ['b.mp4', 12000],
    ]);
    expect(files.every(file => file.source.kind === 'video' && file.source.playbackUrl?.startsWith('blob:'))).toBe(true);
    // The same file chosen twice is two clips, so no two picks share a key.
    expect(new Set(files.map(file => file.source.key)).size).toBe(2);
    expect(lengths).toHaveLength(2);
  });

  it('keeps no more than the limit, and asks for one file when the limit is one', async () => {
    answerDurations({ 'a.mp4': 1, 'b.mp4': 1, 'c.mp4': 1 });
    const picked = pickMediaFiles({ limit: 2 });
    choose(lastInput(), [video('a.mp4'), video('b.mp4'), video('c.mp4')]);
    expect((await picked).map(file => file.source.fileName)).toEqual(['a.mp4', 'b.mp4']);

    const single = pickMediaFiles({ limit: 1 });
    const input = lastInput();
    expect(input.multiple).toBe(false);
    input.dispatchEvent(new Event('cancel'));
    await single;
  });

  /* A still has no length to find, and opening one as a video would only wait out the timeout. */
  it('offers pictures when asked, and hands one back as a still with no length and no probe', async () => {
    const lengths = answerDurations({ 'a.mp4': 2 });
    const picked = pickMediaFiles({ limit: 0, pictures: true });
    const input = lastInput();
    expect(input.accept).toBe('video/*,image/*');
    choose(input, [new File(['jpeg'], 'beach.jpg', { type: 'image/jpeg' }), video('a.mp4')]);

    const [still, clip] = await picked;
    expect(still.source).toMatchObject({ fileName: 'beach.jpg', kind: 'image' });
    expect(still.durationMs).toBe(0);
    expect(clip.durationMs).toBe(2000);
    expect(lengths).toEqual(['a.mp4']);
  });

  it('calls a video that never answers 0 long rather than waiting on it for good', async () => {
    vi.useFakeTimers();
    answerDurations({});
    const picked = pickMediaFiles({ limit: 1 });
    choose(lastInput(), [video('silent.mp4')]);

    await vi.advanceTimersByTimeAsync(10_000);
    expect((await picked).map(file => file.durationMs)).toEqual([0]);
  });
});

/** The input a picker just put in the page, which is where the customer chooses. */
function lastInput(): HTMLInputElement {
  const inputs = Array.from(document.querySelectorAll('input'));
  return inputs[inputs.length - 1] as HTMLInputElement;
}

/** The customer choosing these files in the picker. */
function choose(input: HTMLInputElement, files: File[]): void {
  Object.defineProperty(input, 'files', { value: files, configurable: true });
  input.dispatchEvent(new Event('change'));
}

function video(fileName: string): File {
  return new File(['video'], fileName, { type: 'video/mp4' });
}

/**
 * Every `<video>` the picker opens to measure a file, stood in for by one that reports the length
 * given for that file's name, in seconds, or never reports at all for a name that is not listed.
 * The mock DOM has no decoder, so this is the only way a length reaches the picker. Answers the
 * names it was asked about, in the order it was asked.
 */
function answerDurations(seconds: Record<string, number>): string[] {
  const asked: string[] = [];
  const names = new Map<string, string>();
  const mint = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    const url = mint(blob as Blob);
    if (blob instanceof File) names.set(url, blob.name);
    return url;
  });
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'video') return create(tag);
    const probe = {
      preload: '',
      muted: false,
      duration: Number.NaN,
      onloadedmetadata: null as (() => void) | null,
      onerror: null as (() => void) | null,
      removeAttribute: () => undefined,
      load: () => undefined,
      set src(url: string) {
        const name = names.get(url) ?? '';
        asked.push(name);
        if (!(name in seconds)) return;
        probe.duration = seconds[name];
        queueMicrotask(() => probe.onloadedmetadata?.());
      },
    };
    return probe as unknown as HTMLVideoElement;
  }) as typeof document.createElement);
  return asked;
}

/** One entry of `Capacitor.PluginHeaders`: a native plugin the app was built with, and its methods. */
interface PluginHeader {
  name: string;
  methods: { name: string; rtype: string }[];
}

/**
 * The global a Capacitor app's native side puts in the page, as the default host reads it, with the
 * `VideoComposer` header a build of the kit declares - `pickAudioFile` among its methods unless
 * `methods` says otherwise, as a build older than the call would. Answers the headers, for a test
 * that adds a plugin of its own.
 */
function installBridge(
  platform: string,
  nativePromise: ReturnType<typeof vi.fn>,
  methods: readonly string[] = ['retainMedia', 'pickAudioFile', 'stageRenderInput'],
): PluginHeader[] {
  const headers: PluginHeader[] = [{ name: 'VideoComposer', methods: methods.map((name) => ({ name, rtype: 'promise' })) }];
  (globalThis as { Capacitor?: unknown }).Capacitor = {
    getPlatform: () => platform,
    convertFileSrc: (path: string) => path.replace('file://', 'capacitor://localhost/_capacitor_file_'),
    nativePromise,
    PluginHeaders: headers,
  };
  return headers;
}

/**
 * Every `<audio>` the picker opens to measure a sound, stood in for by one that reports `seconds`,
 * or fails to open for null. Answers the blobs object URLs were minted for, in order, so a test can
 * read the type a sound was handed over with.
 */
function soundPlaysFor(seconds: number | null): Blob[] {
  const minted: Blob[] = [];
  const mint = URL.createObjectURL.bind(URL);
  vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: Blob | MediaSource) => {
    minted.push(blob as Blob);
    return mint(blob as Blob);
  });
  const create = document.createElement.bind(document);
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
    if (tag !== 'audio') return create(tag);
    const probe = {
      preload: '',
      muted: false,
      duration: seconds ?? Number.NaN,
      onloadedmetadata: null as (() => void) | null,
      onerror: null as (() => void) | null,
      removeAttribute: () => undefined,
      load: () => undefined,
      set src(_url: string) {
        queueMicrotask(() => (seconds === null ? probe.onerror?.() : probe.onloadedmetadata?.()));
      },
    };
    return probe as unknown as HTMLAudioElement;
  }) as typeof document.createElement);
  return minted;
}

/**
 * One clip through the real picker, which is the only door into the URLs this host minted: it is a
 * hidden `<input type="file">`, so the test plays the customer choosing a file in it.
 */
async function pickVideoFile(media: EditorMediaHost, fileName: string): Promise<EditorSource> {
  const picked = media.pickVideo();
  choose(lastInput(), [new File(['video'], fileName, { type: 'video/mp4' })]);

  const source = await picked;
  if (!source) throw new Error(`the picker refused ${fileName}`);
  return source;
}
