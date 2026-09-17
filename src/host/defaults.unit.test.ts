import { afterEach, describe, expect, it, vi } from 'vitest';

import { editorDebug, setEditorDebug } from './debug';
import { browserMediaHost, envSafeAreaInsets, resolveEditorHost } from './defaults';
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

  it('leaves the render null, because a browser has no answer for "encode this"', () => {
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

/**
 * One clip through the real picker, which is the only door into the URLs this host minted: it is a
 * hidden `<input type="file">`, so the test plays the customer choosing a file in it.
 */
async function pickVideoFile(media: EditorMediaHost, fileName: string): Promise<EditorSource> {
  const picked = media.pickVideo();
  const inputs = Array.from(document.querySelectorAll('input'));
  const input = inputs[inputs.length - 1] as HTMLInputElement;
  Object.defineProperty(input, 'files', {
    value: [new File(['video'], fileName, { type: 'video/mp4' })],
    configurable: true,
  });
  input.dispatchEvent(new Event('change'));

  const source = await picked;
  if (!source) throw new Error(`the picker refused ${fileName}`);
  return source;
}
