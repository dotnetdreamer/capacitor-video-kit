import { describe, expect, it } from 'vitest';

import type { ComposeMatte } from '../video-composer/definitions';

import { toComposeSpec } from './compose';
import { defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest, type EditOverlay, type StickerOverlay } from './edit-manifest';
import { duplicateOverlay, patchOverlay, splitOverlayAt } from './edit-ops';
import type { RasterContext } from './raster-context';

/* Layers behind the people, from the manifest to the wire. */

const sticker: StickerOverlay = { id: 'k', kind: 'sticker', emoji: null, assetId: 'heart', cx: 0.4, cy: 0.6, scale: 1, rotationDeg: 5, opacity: 0.9, startMs: 1000, endMs: 4000 };

const effect: EditOverlay = { id: 'fx', kind: 'effect', effectId: 'leak', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0 };

const MATTE: ComposeMatte = { uri: 'blob:app/matte', atMs: [0], subjects: [{ id: 1, focus: [1] }] };

function post(overlays: EditOverlay[]): EditManifest {
  const m = emptyManifest();
  m.output = { width: 720, height: 1280, fps: 30 };
  m.clips = [defaultClipEdit('a', 10_000)];
  m.overlays = overlays;
  return m;
}

const context = {
  output: { width: 720, height: 1280, fps: 30 },
  textStyle: () => ({}),
  stickerUrl: () => '',
  fileUrl: (u: string) => u,
  drawn: () => ({ png: 'data:image/png;base64,x', wPx: 100, hPx: 100 }),
} as unknown as RasterContext;

function spec(m: EditManifest, matte: ComposeMatte | null = null) {
  return toComposeSpec(m, new Map([['a', 'file:///a.mp4']]), { jobId: 'j', batchId: 'b' }, context, {}, new Map(), new Map(), matte);
}

describe('a layer behind the people', () => {
  it('leaves a post with nobody behind byte for byte as it was, a matte handed in or not', async () => {
    const m = post([sticker, effect]);
    const plain = JSON.stringify(await toComposeSpec(m, new Map([['a', 'file:///a.mp4']]), { jobId: 'j', batchId: 'b' }, context));
    expect(JSON.stringify(await spec(m, MATTE))).toBe(plain);
    expect(plain).not.toContain('behind');
    expect(plain).not.toContain('matte');
  });

  it('goes on the wire behind, as its last key, and the post with the matte', async () => {
    const sent = await spec(post([{ ...sticker, behind: true }, effect]), MATTE);
    expect(Object.keys(sent.overlays[0]!).at(-1)).toBe('behind');
    expect(sent.overlays[0]!.behind).toBe(true);
    expect(sent.overlays[1]!.behind).toBeUndefined();
    expect(sent.matte).toEqual(MATTE);
  });

  it('is sent behind with no matte where the people are not known, which every engine draws on top', async () => {
    const sent = await spec(post([{ ...sticker, behind: true }]));
    expect(sent.overlays[0]!.behind).toBe(true);
    expect('matte' in sent).toBe(false);
  });

  it('is never an effect, which covers the frame', async () => {
    const forced = { ...effect, behind: true } as unknown as EditOverlay;
    const sent = await spec(post([forced]), MATTE);
    expect(sent.overlays[0]!.behind).toBeUndefined();
    expect('matte' in sent).toBe(false);
  });
});

describe('behind in the manifest', () => {
  it('is read back only as a real true, and never on an effect', () => {
    const raw = { ...post([]), overlays: [{ ...sticker, behind: true }, { ...sticker, id: 'k2', behind: 'yes' }, { ...effect, behind: true }] };
    const m = normaliseManifest(JSON.parse(JSON.stringify(raw)));
    expect(m.overlays.map(o => o.behind)).toEqual([true, undefined, undefined]);
    expect('behind' in m.overlays[1]!).toBe(false);
  });

  it('is kept by a duplicate and by both halves of a cut, and taken off by a patch of undefined', () => {
    const m = post([{ ...sticker, behind: true }]);
    expect(duplicateOverlay(m, 'k', 'k2')!.overlays.map(o => o.behind)).toEqual([true, true]);
    expect(splitOverlayAt(m, 'k', 2500, 'k3', 10_000)!.overlays.map(o => o.behind)).toEqual([true, true]);
    const off = patchOverlay(m, 'k', { behind: undefined });
    expect('behind' in off.overlays[0]!).toBe(false);
    // Already behind: no change, and no undo step.
    expect(patchOverlay(m, 'k', { behind: true })).toBe(m);
  });
});
