import { afterEach, describe, expect, it, vi } from 'vitest';

import { editorDebug, setEditorDebug } from './debug';
import { resolveEditorHost } from './defaults';
import type { EditorMediaHost, EditorSource } from './host.types';

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

  it('turns the package\'s console output on and off with the host that asked for it', () => {
    resolveEditorHost({ platform: { debug: true } });
    expect(editorDebug()).toBe(true);

    resolveEditorHost();
    expect(editorDebug()).toBe(false);
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
