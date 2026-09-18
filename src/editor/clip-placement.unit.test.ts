import { describe, expect, it } from 'vitest';

import { toComposeSpec } from './compose';
import { setPostDuration } from './edit-ops';
import {
  DEFAULT_OUTPUT,
  MAX_VIDEO_TRACKS,
  defaultClipEdit,
  emptyManifest,
  isFullFrameRect,
  isUntouched,
  isUprightRect,
  normaliseManifest,
  normalisePlacement,
  sameRect,
  type EditManifest,
} from './edit-manifest';
import { addVideoTrack, findClip, resetClipFraming, setClipRect, setClipRotation } from './edit-ops';
import { applyLayoutPreset } from './layout-presets';
import type { RasterContext } from './raster-context';

/**
 * What a free canvas costs the wire, which is the whole question a placement angle raises: a clip
 * nobody turned has to reach the native engines as the bytes it always did, because that is what
 * lets a single unedited clip be posted with no re-encode at all.
 */

const URIS = new Map([['a', 'file:///a.mp4']]);

/** Enough of a host for a spec with no overlays in it; nothing here is ever asked for a bitmap. */
const RASTER: RasterContext = {
  output: DEFAULT_OUTPUT,
  textStyle: (id) => ({ id, label: id, family: 'Inter', fallback: 'sans-serif', weight: 400 }),
  stickerUrl: (assetId) => assetId,
  fileUrl: (uri) => uri,
};

function oneClip(): EditManifest {
  return { ...emptyManifest(), clips: [defaultClipEdit('a', 4000)] };
}

function spec(manifest: EditManifest) {
  return toComposeSpec(manifest, URIS, { jobId: 'j', pendingPostId: 'p' }, RASTER);
}

describe('a clip placement', () => {
  it('sends the clip nobody framed as the bytes it has always been', async () => {
    const manifest = oneClip();

    const wire = await spec(manifest);

    // Compared as text rather than field by field, keys and their order included: this is the
    // payload an engine's fast path is chosen by, and a key that appeared with a 0 in it would be
    // the same picture at the cost of a re-encode nobody asked for.
    expect(JSON.stringify(wire.clips)).toBe(
      JSON.stringify([
        { key: 'a', uri: 'file:///a.mp4', inMs: 0, outMs: 4000, speed: 1, volume: 1, muted: false, fit: 'contain' },
      ]),
    );
    expect(wire).not.toHaveProperty('tracks');
    expect(isUntouched(manifest, new Map([['a', 4000]]))).toBe(true);
  });

  it('sends a placed but upright clip with four numbers and no angle', async () => {
    const manifest = setClipRect(oneClip(), 'a', { x: 0, y: 0, w: 1, h: 0.5 });

    const wire = await spec(manifest);

    expect(JSON.stringify(wire.clips[0].rect)).toBe(JSON.stringify({ x: 0, y: 0, w: 1, h: 0.5 }));
  });

  it('sends the angle of a clip that was turned, and stops calling it untouched', async () => {
    const manifest = setClipRect(oneClip(), 'a', { x: 0.1, y: 0.2, w: 0.5, h: 0.5, rotationDeg: 12.5 });

    const wire = await spec(manifest);

    expect(wire.clips[0].rect).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.5, rotationDeg: 12.5 });
    expect(isUntouched(manifest, new Map([['a', 4000]]))).toBe(false);
  });

  it('turns a clip that is not placed anywhere in the frame it is drawn in', async () => {
    const manifest = setClipRotation(oneClip(), 'a', 8);

    expect(findClip(manifest, 'a')?.rect).toEqual({ x: 0, y: 0, w: 1, h: 1, rotationDeg: 8 });
    // The whole frame at an angle shows its corners, so it is a picture and not an absence.
    expect((await spec(manifest)).clips[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 1, rotationDeg: 8 });
  });

  it('leaves nothing behind when the clip is turned straight again', () => {
    const before = oneClip();

    const after = setClipRotation(setClipRotation(before, 'a', 33), 'a', 0);

    expect(after.clips[0]).not.toHaveProperty('rect');
    expect(JSON.stringify(after)).toBe(JSON.stringify(before));
  });

  it('counts a whole turn as no turn at all', () => {
    expect(setClipRotation(oneClip(), 'a', 360).clips[0]).not.toHaveProperty('rect');
    expect(isUprightRect({ x: 0, y: 0, w: 1, h: 1, rotationDeg: -720 })).toBe(true);
    expect(isFullFrameRect({ x: 0, y: 0, w: 1, h: 1, rotationDeg: 45 })).toBe(false);
    expect(sameRect({ x: 0, y: 0, w: 1, h: 0.5 }, { x: 0, y: 0, w: 1, h: 0.5, rotationDeg: 45 })).toBe(false);
  });

  it('keeps the angle through a save and a reopen, and holds it at four decimals', () => {
    const saved = JSON.parse(JSON.stringify(setClipRotation(oneClip(), 'a', 12.345678)));

    expect(normaliseManifest(saved).clips[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 1, rotationDeg: 12.3457 });
    // A rectangle written before angles existed reopens as the upright rectangle it was, with no
    // `rotationDeg` key defaulted onto it.
    expect(normalisePlacement({ x: 0, y: 0.5, w: 1, h: 0.5 })).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
  });

  it('takes the angle away with the rectangle, whether it is reset or laid out again', () => {
    const turned = setClipRect(oneClip(), 'a', { x: 0.1, y: 0.1, w: 0.4, h: 0.4, rotationDeg: 20 });

    expect(resetClipFraming(turned, 'a').clips[0]).not.toHaveProperty('rect');

    const withLayer = addVideoTrack(turned, defaultClipEdit('a', 2000, 'b'), 'vt')!;
    expect(applyLayoutPreset(withLayer, 'vt', 'full').clips[0]).not.toHaveProperty('rect');
  });
});

describe('how many videos a post may hold', () => {
  it('takes layers up to the cap and refuses the one past it', () => {
    let manifest = oneClip();
    for (let i = 0; i < MAX_VIDEO_TRACKS - 1; i++) {
      const next = addVideoTrack(manifest, defaultClipEdit('a', 2000, `layer-${i}`), `vt-${i}`);
      expect(next).not.toBeNull();
      manifest = next!;
    }

    expect(manifest.videoTracks.length).toBe(MAX_VIDEO_TRACKS - 1);
    expect(addVideoTrack(manifest, defaultClipEdit('a', 2000, 'over'), 'vt-over')).toBeNull();
  });

  it('gives each layer a place of its own in the drawing order, including after a removal', () => {
    let manifest = oneClip();
    manifest = addVideoTrack(manifest, defaultClipEdit('a', 2000, 'one'), 'vt-1')!;
    manifest = addVideoTrack(manifest, defaultClipEdit('a', 2000, 'two'), 'vt-2')!;
    // The layer from the middle goes, and the next one added must not land on a `z` still in use.
    manifest = { ...manifest, videoTracks: manifest.videoTracks.filter((track) => track.id === 'vt-2') };
    manifest = addVideoTrack(manifest, defaultClipEdit('a', 2000, 'three'), 'vt-3')!;

    expect(manifest.videoTracks.map((track) => track.z)).toEqual([2, 3]);
  });
});

describe('the post running on past its base track', () => {
  it('says nothing at all until the end has been pulled out', async () => {
    // A post nobody has stretched reaches the wire as the bytes this package has always sent, which
    // is what keeps every engine on the path it takes for one.
    expect('durationMs' in (await spec(oneClip()))).toBe(false);
  });

  it('sends the length the customer asked for', async () => {
    const wire = await spec(setPostDuration(oneClip(), 9000));

    expect(wire.durationMs).toBe(9000);
    // And the base track is exactly what it was: the tail is room, not footage.
    expect(wire.clips).toHaveLength(1);
    expect(wire.clips[0].outMs).toBe(4000);
  });

  it('measures the poster against the base track, not the black at the end', async () => {
    expect((await spec(setPostDuration(oneClip(), 60_000))).posterAtMs).toBe(500);
  });
});
