import { emptyManifest } from '../editor';
import { describe, expect, it } from 'vitest';

import { resolveEditorHost } from '../host/defaults';
import { stickerUrl } from '../data/stickers';
import { setEditorAssetPath } from '../index';
import { EditorStore } from './editor-store';
import { OverlayBitmaps } from './overlay-bitmap';

/*
 * Drawing a layer needs a canvas and an `Image`, so what a bitmap comes out looking like is a
 * browser test and belongs next to the preview that drives it. What is worth holding here is that
 * the thing can be built and taken down at all: it starts an effect in its constructor that reads
 * the store, so a field that is initialised in the wrong order fails on the very first change and
 * nowhere else.
 */
describe('OverlayBitmaps', () => {
  function open(): { store: EditorStore; bitmaps: OverlayBitmaps } {
    const host = resolveEditorHost();
    const store = new EditorStore(host);
    store.load([], new Map(), emptyManifest());
    return { store, bitmaps: new OverlayBitmaps(store, host) };
  }

  it('watches the store from the moment it is built', async () => {
    const { store, bitmaps } = open();

    store.commit('Filter', (m) => ({ ...m, filterId: 'noir' }));
    await bitmaps.ensureFresh();

    expect(store.bitmaps.value.size).toBe(0);
    bitmaps.dispose();
  });

  it('draws with the editor\'s own stickers and text styles, which the render must also use', () => {
    const { bitmaps } = open();
    // Outside a loaded component Stencil has no resources URL to resolve against, so an asset base
    // has to be given before anything asks for one.
    setEditorAssetPath('https://example.test/editor/');

    expect(bitmaps.rasterContext.stickerUrl('crown')).toBe(stickerUrl('crown'));
    expect(stickerUrl('crown')).toBe('https://example.test/editor/assets/stickers/crown.svg');
    expect(bitmaps.rasterContext.textStyle('classic').family).toBe('VE Inter');
    expect(bitmaps.rasterContext.output.width).toBeGreaterThan(0);

    bitmaps.dispose();
  });

  it('is safe to dispose twice, which is what a double disconnect does', () => {
    const { bitmaps } = open();

    bitmaps.dispose();
    expect(() => bitmaps.dispose()).not.toThrow();
  });
});
