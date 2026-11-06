import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultClipEdit, emptyManifest, encodeSubjectTrack, type EditClip, type EditManifest, type EditOverlay, type StickerOverlay } from '../editor';
import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import type { FindSubjectsResult } from '../video-composer/definitions';

import { EditorStore } from './editor-store';

/*
 * Layers behind the people, as the store drives them: who offers the tool, the people looked for before a layer
 * goes behind them, one undo step, nobody found, and the mask the preview draws the people back with.
 */

/** Somebody in the middle of a 9:16 source, the whole of its two seconds. */
const PEOPLE = encodeSubjectTrack({
  width: 180,
  height: 320,
  times: [0, 1000, 2000],
  frames: [0, 1, 2].map(() => {
    const cells = new Uint8Array(180 * 320);
    for (let y = 100; y < 300; y++) cells.fill(1, y * 180 + 60, y * 180 + 120);
    return cells;
  }),
  meta: { engine: 'mediapipe', kind: 'video', durationMs: 2000, fps: 1, subjects: [] },
});

function found(key: string, subjects: number): FindSubjectsResult {
  return {
    engine: 'mediapipe',
    uri: `blob:people/${key}`,
    cached: false,
    kind: 'video',
    width: 180,
    height: 320,
    frames: 3,
    durationMs: 2000,
    subjects: Array.from({ length: subjects }, (_, i) => ({ id: i + 1, kind: 'person' as const, startMs: 0, endMs: 2000, peakMs: 0, box: { x: 0.3, y: 0.3, w: 0.3, h: 0.6 }, area: 0.2 })),
  };
}

const sticker: StickerOverlay = { id: 'k', kind: 'sticker', emoji: null, assetId: 'heart', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 1500 };
const effect: EditOverlay = { id: 'fx', kind: 'effect', effectId: 'leak', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0 };

describe('EditorStore layers behind the people', () => {
  let store: EditorStore;
  let searches: { key: string; land: (subjects: number) => void }[];

  function load(clips: EditClip[], overlays: EditOverlay[]): void {
    const sources: EditorSource[] = clips.map(c => ({ key: c.clipKey, fileName: `${c.clipKey}.mp4`, playbackUrl: `https://example.test/${c.clipKey}.mp4` }));
    const m: EditManifest = { ...emptyManifest(), clips, overlays };
    m.output = { width: 720, height: 1280, fps: 30 };
    store.load(sources, new Map(clips.map(c => [c.clipKey, c.outMs])), m);
    for (const c of clips) store.noteSourceShape(c.clipKey, 9 / 16);
  }

  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 500 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    if (!done()) throw new Error('timed out');
  }

  beforeEach(() => {
    searches = [];
    const findSubjects = vi.fn(
      (source: EditorSource) =>
        new Promise<FindSubjectsResult | null>(resolve => {
          searches.push({ key: source.key, land: subjects => resolve(found(source.key, subjects)) });
        }),
    );
    const media = { ...resolveEditorHost().media, findSubjects };
    store = new EditorStore(resolveEditorHost({ media, platform: { fileUrl: (uri: string) => uri } } as never));
    store.attachPlayer({ seek: ms => (store.playheadMs.value = ms), play: () => (store.playing.value = true), pause: () => (store.playing.value = false) });
    store.renderFeatures.value = ['overlayQuad', 'peopleMatte'];
    vi.stubGlobal('fetch', vi.fn(async (uri: string) => ({ ok: true, status: 200, blob: async () => new Blob([uri.startsWith('blob:people/') ? (PEOPLE as BlobPart) : '']) })));
  });

  afterEach(() => {
    store.dispose();
    vi.unstubAllGlobals();
  });

  it('is offered only where the export puts the people back and the platform can find them', () => {
    expect(store.canPutBehind.value).toBe(true);
    store.renderFeatures.value = ['overlayQuad'];
    expect(store.canPutBehind.value).toBe(false);
    const finder = new EditorStore(resolveEditorHost({ media: { ...resolveEditorHost().media, findSubjects: undefined } } as never));
    finder.renderFeatures.value = ['peopleMatte'];
    expect(finder.canPutBehind.value).toBe(false);
  });

  it('finds the people under the layer first, then puts it behind them as one undo step', async () => {
    load([defaultClipEdit('a', 2000), defaultClipEdit('b', 2000)], [sticker]);
    const before = store.revision.value;
    store.setLayerBehind('k', true);
    expect(searches.map(s => s.key)).toEqual(['a']);
    expect(store.behindPending.value).toBe('k');
    expect(store.toast.value?.text).toBe('Finding people...');
    expect(store.manifest.value.overlays[0]!.behind).toBeUndefined();
    // Asked again while they are looked for: said again, and nothing more looked for.
    store.setLayerBehind('k', true);
    expect(searches.length).toBe(1);

    searches[0]!.land(1);
    await until(() => store.manifest.value.overlays[0]!.behind === true);
    expect(store.behindPending.value).toBeNull();
    // Found: the word that they were being looked for comes down with them.
    expect(store.toast.value).toBeNull();
    expect(store.revision.value).toBe(before + 1);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Behind people');
    expect(store.manifest.value.overlays[0]!.behind).toBeUndefined();
  });

  it('leaves the layer where it is when nobody is found, and says so', async () => {
    load([defaultClipEdit('a', 2000)], [sticker]);
    const before = store.revision.value;
    store.setLayerBehind('k', true);
    searches[0]!.land(0);
    await until(() => store.behindPending.value === null);
    expect(store.toast.value?.text).toBe('No people found');
    expect(store.manifest.value.overlays[0]!.behind).toBeUndefined();
    expect(store.revision.value).toBe(before);
  });

  it('goes behind at once where the people are known, and back over the picture as one step', () => {
    load([defaultClipEdit('a', 2000)], [sticker]);
    store.setLayerBehind('k', true);
    searches[0]!.land(1);
    return until(() => store.manifest.value.overlays[0]!.behind === true).then(() => {
      store.setLayerBehind('k', false);
      expect(store.manifest.value.overlays[0]!.behind).toBeUndefined();
      store.setLayerBehind('k', true);
      expect(searches.length).toBe(1);
      expect(store.manifest.value.overlays[0]!.behind).toBe(true);
    });
  });

  it('never puts an effect behind anybody', () => {
    load([defaultClipEdit('a', 2000)], [effect]);
    store.setLayerBehind('fx', true);
    expect(searches.length).toBe(0);
    expect(store.manifest.value.overlays[0]!.behind).toBeUndefined();
  });

  it('hands the preview the people at an instant a layer is behind them, and nothing elsewhere', async () => {
    load([defaultClipEdit('a', 2000)], [{ ...sticker, behind: true }]);
    expect(store.behindShown.value).toBe(true);
    // Not found yet: nobody to put back.
    expect(store.peopleMaskAt(500)?.any).toBe(false);
    store.setLayerBehind('k', false);
    store.setLayerBehind('k', true);
    searches[0]!.land(1);
    await until(() => store.manifest.value.overlays[0]!.behind === true);
    const mask = store.peopleMaskAt(500)!;
    expect(mask.any).toBe(true);
    expect([mask.width, mask.height]).toEqual([180, 320]);
    expect(mask.cells[200 * 180 + 90]).toBe(1);
    expect(store.peopleMaskAt(1800)).toBeNull();
    store.seek(500);
    expect(store.peopleMaskNow.value?.any).toBe(true);
    store.renderFeatures.value = [];
    expect(store.peopleMaskAt(500)).toBeNull();
  });
});
