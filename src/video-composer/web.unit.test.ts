import { afterEach, describe, expect, it, vi } from 'vitest';

/*
 * `@capacitor/core` is not installed under that name here (`tsconfig.json` says why), and all the
 * browser plugin takes from it is the base class, which does nothing these calls reach.
 */
vi.mock('@capacitor/core', () => ({ WebPlugin: class {} }));

/*
 * The recogniser itself runs in a real browser (`web/labels.cmp.test.ts`); here it answers whatever a
 * test says, so what the plugin does around it - checking the call, naming the failure - is what runs.
 */
vi.mock('./web/labels', async importOriginal => ({
  ...(await importOriginal<typeof import('./web/labels')>()),
  labelMediaInBrowser: vi.fn(),
}));

import type { LabelMediaResult } from './definitions';
import type { VideoComposerPlugin } from './plugin';
import { VideoComposerWeb } from './web';
import { labelMediaInBrowser, LabelingUnavailableError, LabelingUnreadableError } from './web/labels';

/*
 * A browser's job folders are IndexedDB keys, which nothing climbs out of, but a batch id a phone
 * refuses is refused here too, in the phone's words, before anything is copied or deleted.
 */
describe('job folders, in a browser', () => {
  const plugin: VideoComposerPlugin = new VideoComposerWeb();
  const refusals = [
    ['..', "batchId cannot be '.' or '..'"],
    ['.', "batchId cannot be '.' or '..'"],
    ['', 'batchId is required'],
  ] as const;

  it('refuses the ids that name no folder of their own to prepareJob and cleanup', async () => {
    for (const [batchId, message] of refusals) {
      await expect(plugin.prepareJob({ batchId, inputs: [] })).rejects.toMatchObject({ code: 'invalid_spec', message });
      await expect(plugin.cleanup({ batchId })).rejects.toMatchObject({ code: 'invalid_spec', message });
    }
    await expect(plugin.cleanup({} as never)).rejects.toMatchObject({ code: 'invalid_spec', message: 'batchId is required' });
  });
});

/*
 * The five calls a host that keeps picks makes on every platform, as a browser answers them: the
 * honest answers rather than refusals, and the same refusals as the phones for a call that is wrong.
 */
describe('keeping picked media, in a browser', () => {
  // Through the interface, which is all a host ever holds.
  const plugin: VideoComposerPlugin = new VideoComposerWeb();

  it('says a pick in a page has no name that outlives it, and hands the name back', async () => {
    await expect(plugin.retainMedia({ uri: 'blob:https://example.test/a' })).resolves.toEqual({
      uri: 'blob:https://example.test/a',
      durable: false,
    });
    await expect(plugin.retainMedia({ uri: '' })).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  /* The host keeps the bytes in a browser, so only the host can say whether they are still there. */
  it('answers any name as still there and as it came, and no name as nothing', async () => {
    await expect(plugin.checkMedia({ uri: 'videokit-file:/drafts/clip.mp4' })).resolves.toEqual({
      exists: true,
      uri: 'videokit-file:/drafts/clip.mp4',
    });
    await expect(plugin.checkMedia({ uri: '' })).resolves.toEqual({ exists: false, uri: '' });
  });

  it('needs no permission to go on reading what the page holds', async () => {
    await expect(plugin.requestMediaAccess({ images: true })).resolves.toEqual({ granted: true });
    await expect(plugin.requestMediaAccess()).resolves.toEqual({ granted: true });
  });

  it('deletes nothing, and refuses the arguments iOS would refuse', async () => {
    await expect(plugin.releaseMedia({ uris: [] })).resolves.toBeUndefined();
    await expect(plugin.sweepMedia({ keep: [], before: Date.now() })).resolves.toEqual({ removed: 0 });

    await expect(plugin.releaseMedia({} as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.sweepMedia({ before: Date.now() } as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.sweepMedia({ keep: [] } as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.sweepMedia({ keep: [], before: Number.NaN })).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  /*
   * A `keep` that names something where a list belongs meant to spare it, and misread as absent would
   * delete what it was there to keep, wherever deleting happens. A null names nothing, and is read as
   * left out, as Android reads it and as Capacitor's getters read a JSON null on both phones.
   */
  it("takes a release's keep list, reads a null one as left out, and refuses one that is not a list", async () => {
    await expect(plugin.releaseMedia({ uris: ['blob:https://example.test/a'], keep: ['blob:https://example.test/a'] })).resolves.toBeUndefined();
    await expect(plugin.releaseMedia({ uris: [], keep: undefined })).resolves.toBeUndefined();
    await expect(plugin.releaseMedia({ uris: [], keep: null } as never)).resolves.toBeUndefined();

    // In the words iOS and Android refuse it with, so a host's log reads the same on all three.
    await expect(plugin.releaseMedia({ uris: [], keep: 'blob:https://example.test/a' } as never)).rejects.toMatchObject({
      code: 'invalid_spec',
      message: 'keep must be a list of uris',
    });
    await expect(plugin.releaseMedia({ uris: [], keep: { uri: 'blob:https://example.test/a' } } as never)).rejects.toMatchObject({
      code: 'invalid_spec',
    });
  });
});

/*
 * The three calls a page has no use for, refused with the code Capacitor gives a call a platform
 * does not have, so a host that asks anyway can tell "not here" from "went wrong".
 */
describe('the native-only calls, in a browser', () => {
  const plugin: VideoComposerPlugin = new VideoComposerWeb();

  it('has no document picker of its own: a page picks a sound through a file input', async () => {
    await expect(plugin.pickAudioFile()).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
  });

  it('stages no render inputs, because its engine reads a blob as it is', async () => {
    await expect(plugin.stageRenderInput({ data: 'c291bmQ=' })).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
    await expect(plugin.releaseRenderInputs({ uris: [] })).rejects.toMatchObject({ code: 'UNIMPLEMENTED' });
  });
});

/* A page's Downloads are the browser's: the file is handed to its download under the name asked for. */
describe('saveToDownloads, in a browser', () => {
  const plugin: VideoComposerPlugin = new VideoComposerWeb();

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  /** The name of every download the page started, in order. */
  function watchDownloads(): string[] {
    const names: string[] = [];
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:https://example.test/copy');
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => undefined);
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      names.push(this.download);
    });
    return names;
  }

  it('refuses a call without a file, as a phone does', async () => {
    await expect(plugin.saveToDownloads({ uri: '' })).rejects.toMatchObject({ code: 'invalid_spec', message: 'uri is required' });
    await expect(plugin.saveToDownloads({} as never)).rejects.toMatchObject({ code: 'invalid_spec' });
  });

  it('downloads the file under the name it was given, and says it was saved', async () => {
    const sound = new Blob(['RIFF'], { type: 'audio/wav' });
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => sound })));
    const downloads = watchDownloads();

    await expect(plugin.saveToDownloads({ uri: 'blob:https://example.test/a', fileName: 'holiday.wav' })).resolves.toEqual({
      saved: true,
      uri: 'blob:https://example.test/a',
    });
    expect(downloads).toEqual(['holiday.wav']);
  });

  it("names a file it was given no name for after the URL's last segment", async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob(['RIFF']) })));
    const downloads = watchDownloads();

    await plugin.saveToDownloads({ uri: 'https://example.test/sounds/beach%20day.m4a' });

    expect(downloads).toEqual(['beach day.m4a']);
  });

  it('reports a file it could not read as unreadable_input, and downloads nothing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    const downloads = watchDownloads();

    await expect(plugin.saveToDownloads({ uri: 'blob:https://example.test/gone' })).rejects.toMatchObject({ code: 'unreadable_input' });
    expect(downloads).toEqual([]);
  });
});

/*
 * A page brings its own recogniser (`web/labels.ts`). The call is checked the way a phone checks it
 * before anything loads, and each way the recogniser can fail is named as a phone names it: one that
 * cannot start is `unsupported`, which `describeMedia` turns into null, and a file that will not open
 * is `unreadable_input`.
 */
describe('labelMedia, in a browser', () => {
  const plugin: VideoComposerPlugin = new VideoComposerWeb();
  const engine = vi.mocked(labelMediaInBrowser);

  it('refuses a call without a file, or with a kind it cannot be, as a phone does and before loading anything', async () => {
    engine.mockClear();
    await expect(plugin.labelMedia({ uri: '' })).rejects.toMatchObject({ code: 'invalid_spec', message: 'uri is required' });
    await expect(plugin.labelMedia({} as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.labelMedia({ uri: 'blob:https://example.test/a', kind: 'audio' as never })).rejects.toMatchObject({
      code: 'invalid_spec',
    });
    expect(engine).not.toHaveBeenCalled();
  });

  it("answers with the recogniser's labels, under its own engine's name", async () => {
    const answer: LabelMediaResult = {
      engine: 'mediapipe',
      kind: 'image',
      frames: [{ timeMs: 0, labels: [{ label: 'golden retriever', confidence: 0.61 }] }],
    };
    engine.mockResolvedValueOnce(answer);
    await expect(plugin.labelMedia({ uri: 'blob:https://example.test/a', kind: 'image' })).resolves.toEqual(answer);
    expect(engine).toHaveBeenLastCalledWith({ uri: 'blob:https://example.test/a', kind: 'image' });
  });

  it('is unsupported where the recogniser will not start, and unreadable where the file will not open', async () => {
    engine.mockRejectedValueOnce(new LabelingUnavailableError('no WebAssembly'));
    await expect(plugin.labelMedia({ uri: 'blob:https://example.test/a' })).rejects.toMatchObject({ code: 'unsupported' });
    engine.mockRejectedValueOnce(new LabelingUnreadableError('not a picture or a video'));
    await expect(plugin.labelMedia({ uri: 'blob:https://example.test/a' })).rejects.toMatchObject({
      code: 'unreadable_input',
    });
  });
});

/*
 * A page makes no preview copy: its only transcoder decodes no faster, on the phones a copy is for,
 * than the seeks it would be saving. The call is checked as Android checks it, and then refused with
 * the code `composerMediaHost` reads as "not on this platform", so the preview plays the clip itself.
 */
describe('previewProxy, in a browser', () => {
  const plugin: VideoComposerPlugin = new VideoComposerWeb();

  it('refuses a call without a clip as a phone does, and every other call as unsupported', async () => {
    await expect(plugin.previewProxy({ uri: '' })).rejects.toMatchObject({ code: 'invalid_spec', message: 'uri is required' });
    await expect(plugin.previewProxy({} as never)).rejects.toMatchObject({ code: 'invalid_spec', message: 'uri is required' });
    await expect(plugin.previewProxy(undefined as never)).rejects.toMatchObject({ code: 'invalid_spec' });
    await expect(plugin.previewProxy({ uri: 'blob:https://example.test/a' })).rejects.toMatchObject({ code: 'unsupported' });
    await expect(plugin.previewProxy({ uri: 'file:///clip.mp4', shortSide: 360, maxFps: 30 })).rejects.toMatchObject({
      code: 'unsupported',
    });
  });
});
