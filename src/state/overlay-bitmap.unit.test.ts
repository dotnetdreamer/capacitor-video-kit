import { emptyManifest, encodeMatteTrack, matteKey, outputFor, parseMatteTrack, rasteriseOverlay, type EditOverlay } from '../editor';
import { describe, expect, it, vi } from 'vitest';

import { resolveEditorHost } from '../host/defaults';
import { stickerUrl } from '../data/stickers';
import { setEditorAssetPath } from '../index';
import { EditorStore } from './editor-store';
import type { MatteState } from './editor.types';
import { OverlayBitmaps } from './overlay-bitmap';

/*
 * The mock DOM has no 2D canvas, so the rasteriser is replaced by one that reports what it was
 * asked to draw. What these tests hold is WHEN a layer is drawn and what the bitmap is labelled
 * with, not what it looks like.
 */
vi.mock('../editor', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../editor')>();
  return {
    ...actual,
    rasteriseOverlay: vi.fn(async (overlay: EditOverlay) => ({
      png: `data:image/png;base64,${overlay.id}@${overlay.scale}`,
      wPx: 100,
      hPx: 100,
    })),
  };
});
const rasterise = vi.mocked(rasteriseOverlay);

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

/*
 * The render places the preview's bitmap instead of drawing its own only when drawing again would
 * give the same PNG: same key, same frame, and not a layer that waits for a font.
 */
describe('OverlayBitmaps handing its bitmaps to a render', () => {
  const at = (id: string, extra: Partial<EditOverlay>): EditOverlay =>
    ({ id, cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0, ...extra }) as EditOverlay;
  const sticker = at('st', { kind: 'sticker', emoji: null, assetId: 'crown' });
  const emoji = at('em', { kind: 'sticker', emoji: '🔥', assetId: null });
  const photo = at('ph', { kind: 'image', uri: 'file:///p.jpg', fileName: 'p.jpg', aspect: 1 });
  const effect = at('fx', { kind: 'effect', effectId: 'vhs' });
  const text = at('tx', { kind: 'text', text: 'hi', styleId: 'classic', color: '#fff', effect: 'none', align: 'center' });

  async function open(overlays: EditOverlay[]): Promise<{ store: EditorStore; bitmaps: OverlayBitmaps }> {
    rasterise.mockClear();
    const host = resolveEditorHost();
    const store = new EditorStore(host);
    store.load([], new Map(), { ...emptyManifest(), overlays });
    const bitmaps = new OverlayBitmaps(store, host);
    await bitmaps.ensureFresh();
    return { store, bitmaps };
  }

  it('labels every bitmap with the frame it was drawn against', async () => {
    const { store, bitmaps } = await open([sticker, effect]);
    const { width, height } = store.manifest.value.output;

    for (const id of ['st', 'fx']) {
      expect(store.bitmaps.value.get(id)).toMatchObject({ frameW: width, frameH: height });
    }
    bitmaps.dispose();
  });

  it('hands back the photos, stickers and effects it drew for exactly this frame', async () => {
    const { store, bitmaps } = await open([sticker, photo, effect]);
    const raster = bitmaps.renderContext(store.manifest.value.output);

    for (const layer of [sticker, photo, effect]) {
      const shown = store.bitmaps.value.get(layer.id);
      expect(raster.drawn?.(layer)).toEqual({ png: shown?.png, wPx: shown?.wPx, hPx: shown?.hPx });
    }
    // Everything else about the context is the preview's own.
    expect(raster.output).toEqual(store.manifest.value.output);
    expect(raster.stickerUrl('crown')).toBe(bitmaps.rasterContext.stickerUrl('crown'));
    bitmaps.dispose();
  });

  it('never hands back text or emoji, which can have been drawn before their font arrived', async () => {
    const { store, bitmaps } = await open([text, emoji]);
    const raster = bitmaps.renderContext(store.manifest.value.output);

    expect(store.bitmaps.value.has('tx')).toBe(true);
    expect(store.bitmaps.value.has('em')).toBe(true);
    expect(raster.drawn?.(text)).toBeNull();
    expect(raster.drawn?.(emoji)).toBeNull();
    bitmaps.dispose();
  });

  it('hands back nothing for a layer that is not what the render is about to place', async () => {
    const { store, bitmaps } = await open([sticker]);
    const raster = bitmaps.renderContext(store.manifest.value.output);

    expect(raster.drawn?.({ ...sticker, scale: 1.5 })).toBeNull();
    expect(raster.drawn?.(at('other', { kind: 'sticker', emoji: null, assetId: 'crown' }))).toBeNull();
    bitmaps.dispose();
  });

  it('hands back nothing for another frame, even when the key does not name the frame', async () => {
    const { store, bitmaps } = await open([effect]);
    const drawnFor = store.manifest.value.output;
    const bigger = outputFor('9:16', '1080p', 30);
    expect(bigger.width).not.toBe(drawnFor.width);

    // An effect's key has no frame in it, so the preview keeps the bitmap it drew for the old frame.
    store.setOutput(bigger);
    await bitmaps.ensureFresh();
    expect(store.bitmaps.value.get('fx')).toMatchObject({ frameW: drawnFor.width, frameH: drawnFor.height });
    expect(bitmaps.renderContext(bigger).drawn?.(effect)).toBeNull();
    // A frame of the same width and another height is another frame too.
    expect(bitmaps.renderContext({ ...drawnFor, height: drawnFor.height + 2 }).drawn?.(effect)).toBeNull();
    bitmaps.dispose();
  });

  it('keeps the frame a bitmap was drawn for when it comes back out of the recent cache', async () => {
    const { store, bitmaps } = await open([effect]);
    const drawnFor = store.manifest.value.output;
    const bigger = outputFor('9:16', '1080p', 30);

    store.setOutput(bigger);
    // Taken off and put back: the same key, so the bitmap drawn for the OLD frame is reused.
    store.commit('Remove', (m) => ({ ...m, overlays: [] }));
    await bitmaps.ensureFresh();
    store.commit('Add', (m) => ({ ...m, overlays: [effect] }));
    rasterise.mockClear();
    await bitmaps.ensureFresh();

    expect(rasterise).not.toHaveBeenCalled();
    expect(store.bitmaps.value.get('fx')).toMatchObject({ frameW: drawnFor.width, frameH: drawnFor.height });
    expect(bitmaps.renderContext(bigger).drawn?.(effect)).toBeNull();
    bitmaps.dispose();
  });
});

/*
 * Compare in the Cutout sheet shows a cut-out photo as it was, background and all, so the photo's
 * bitmap carries the photo whole beside it - the one it had a moment ago wherever that is still kept.
 */
describe('OverlayBitmaps keeping a cut-out photo whole, for Compare', () => {
  const photo = { id: 'ph', kind: 'image', uri: 'file:///p.jpg', fileName: 'p.jpg', aspect: 1, cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0 } as EditOverlay;
  const cut = { ...photo, cutout: {} } as EditOverlay;
  const matte: MatteState = {
    status: 'ready',
    result: { engine: 'mlkit', uri: 'file:///cache/matte-tracks/p.vkmt', cached: false, kind: 'image', target: 'subject', width: 2, height: 2, frames: 1, durationMs: 0, coverage: 0.5 },
    track: parseMatteTrack(encodeMatteTrack({ width: 2, height: 2, times: [0], frames: [Uint8Array.of(255, 0, 255, 0)], meta: { engine: 'mlkit', kind: 'image', target: 'subject', durationMs: 0, fps: 0, coverage: 0.5 } })),
  };

  async function open(overlays: EditOverlay[]): Promise<{ store: EditorStore; bitmaps: OverlayBitmaps }> {
    rasterise.mockClear();
    const host = resolveEditorHost();
    const store = new EditorStore(host);
    store.load([], new Map(), { ...emptyManifest(), overlays });
    store.mattes.value = new Map([[matteKey('file:///p.jpg', 'subject'), matte]]);
    const bitmaps = new OverlayBitmaps(store, host);
    await bitmaps.ensureFresh();
    return { store, bitmaps };
  }

  it('keeps the bitmap the photo had before it was cut out, drawing nothing more for it', async () => {
    const { store, bitmaps } = await open([photo]);
    const before = store.bitmaps.value.get('ph');
    rasterise.mockClear();

    store.commit('Cutout', (m) => ({ ...m, overlays: [cut] }));
    await bitmaps.ensureFresh();

    expect(rasterise).toHaveBeenCalledTimes(1);
    expect(rasterise.mock.calls[0]?.[0]).toMatchObject({ cutout: {} });
    expect(store.bitmaps.value.get('ph')?.whole).toEqual({ png: before?.png, wPx: before?.wPx, hPx: before?.hPx });
    bitmaps.dispose();
  });

  it('draws the photo whole once for a draft opened with its cutout made', async () => {
    const { store, bitmaps } = await open([cut]);

    expect(rasterise.mock.calls.map(([overlay]) => 'cutout' in overlay)).toEqual([true, false]);
    expect(store.bitmaps.value.get('ph')?.whole).toBeDefined();
    bitmaps.dispose();
  });

  it('never hands the photo whole to a render', async () => {
    const { store, bitmaps } = await open([cut]);
    const drawn = bitmaps.renderContext(store.manifest.value.output).drawn?.(cut);

    expect(drawn && Object.keys(drawn).sort()).toEqual(['hPx', 'png', 'wPx']);
    bitmaps.dispose();
  });
});
