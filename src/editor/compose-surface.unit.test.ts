import { describe, expect, it } from 'vitest';

import { toComposeSpec } from './compose';
import { defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest, type EditOverlay, type EditTrack, type StickerOverlay } from './edit-manifest';
import { isConvexQuad, quadMiddle } from './homography';
import { compileLayoutMotions } from './layout-motion';
import { mendTrack, normaliseEditTrack, normaliseOverlayFollow } from './overlay-track';
import type { RasterContext } from './raster-context';
import { placeOnSurface } from './surface';

/*
 * A 720x1280 post over one 10 s clip of the same shape. Its track "s" is a surface sliding right, one sample
 * every 100 ms; a sticker is put on it at 2 s.
 */

const ASPECT = 720 / 1280;

function quadAtMs(t: number): number[] {
  const x = 0.3 + (0.04 * t) / 1000;
  return [x - 0.15, 0.44, x + 0.15, 0.46, x + 0.15, 0.54, x - 0.15, 0.56];
}

function surface(): EditTrack {
  const atMs = Array.from({ length: 101 }, (_, i) => i * 100);
  const corners = atMs.flatMap(quadAtMs);
  const middle = atMs.map((_, i) => quadMiddle(corners.slice(8 * i, 8 * i + 8))!);
  return {
    id: 's',
    name: 'Surface 1',
    hue: 2,
    clipId: 'a',
    clipKey: 'a',
    aspect: ASPECT,
    box: { w: 0.3, h: 0.12 },
    atMs,
    x: middle.map(m => m.x),
    y: middle.map(m => m.y),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    smooth: 0,
    corners,
  };
}

const sticker: StickerOverlay = { id: 'k', kind: 'sticker', emoji: null, assetId: 'heart', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 0.8, startMs: 0, endMs: 0 };

function post(track: EditTrack, overlays: EditOverlay[]): EditManifest {
  const m = emptyManifest();
  m.output = { width: 720, height: 1280, fps: 30 };
  m.clips = [defaultClipEdit('a', 10_000)];
  m.tracks = [track];
  m.overlays = overlays;
  return m;
}

/** The sticker put on the surface at 2 s, as Pin sticker puts it. */
function onSurface(): EditOverlay {
  const m = post(surface(), []);
  const patch = placeOnSurface(sticker, surface(), { manifest: m, camera: null, layout: compileLayoutMotions(m) }, 2000)!;
  return { ...sticker, ...patch } as EditOverlay;
}

const context = {
  output: { width: 720, height: 1280, fps: 30 },
  textStyle: () => ({}),
  stickerUrl: () => '',
  fileUrl: (u: string) => u,
  drawn: () => ({ png: 'data:image/png;base64,x', wPx: 100, hPx: 100 }),
} as unknown as RasterContext;

function spec(m: EditManifest) {
  return toComposeSpec(m, new Map([['a', 'file:///a.mp4']]), { jobId: 'j', batchId: 'b' }, context);
}

describe('a layer on a surface on the wire', () => {
  it('is sent its quad a frame, strictly in time order, and its best fit as its motion', async () => {
    const sent = (await spec(post(surface(), [onSurface()]))).overlays[0]!;
    const quad = sent.quad!;
    expect(quad.atMs.length).toBeGreaterThan(295);
    expect(quad.corners.length).toBe(8 * quad.atMs.length);
    for (let i = 1; i < quad.atMs.length; i++) expect(quad.atMs[i]!).toBeGreaterThan(quad.atMs[i - 1]!);
    for (let i = 0; i < quad.atMs.length; i += 30) {
      expect(isConvexQuad(quad.corners.slice(8 * i, 8 * i + 8).map((v, k) => v * (k % 2 === 0 ? 720 : 1280)))).toBe(true);
    }
    expect(sent.motion?.atMs.length).toBe(quad.atMs.length);
    expect(sent.opacity).toBe(0.8);
    expect(Object.keys(sent).slice(-2)).toEqual(['motion', 'quad']);
  });

  it('leaves a post with no layer on a surface exactly as it was, corners or not', async () => {
    const layer = onSurface();
    const flat = { ...layer, follow: { trackId: 's', pin: layer.follow!.pin, scaleWith: true as const, turnWith: true as const } } as EditOverlay;
    const { corners: _gone, ...plain } = surface();
    const withCorners = await spec(post(surface(), [flat]));
    const without = await spec(post(plain, [flat]));
    expect(JSON.stringify(withCorners)).toBe(JSON.stringify(without));
    expect(withCorners.overlays[0]!.quad).toBeUndefined();
  });
});

describe('a surface in the manifest', () => {
  it('keeps its corners with its samples, and a follow says it is on it', () => {
    const track = surface();
    expect(normaliseEditTrack(track)).toBe(track);
    const read = normaliseManifest(JSON.parse(JSON.stringify(post(track, [onSurface()]))));
    expect(read.tracks![0]!.corners).toEqual(track.corners);
    expect(read.overlays[0]!.follow!.onSurface).toBe(true);
    expect(normaliseOverlayFollow({ trackId: 's', pin: { atMs: 0, dx: 0, dy: 0 }, onSurface: 'yes' })!.onSurface).toBeUndefined();
  });

  it('drops a sample whose corners cannot be read, and corners that do not match the samples', () => {
    const track = surface();
    const corners = track.corners!.slice();
    corners[8 * 3 + 2] = Number.NaN;
    const read = normaliseEditTrack({ ...track, corners })!;
    expect(read.atMs.length).toBe(track.atMs.length - 1);
    expect(read.corners!.length).toBe(8 * read.atMs.length);
    expect(normaliseEditTrack({ ...track, corners: corners.slice(8) })!.corners).toBeUndefined();
  });

  it('loses its corners when it is mended: a surface is tracked again whole', () => {
    const track = surface();
    const run = {
      atMs: [3000, 3100, 3200],
      x: [0.5, 0.5, 0.5],
      y: [0.5, 0.5, 0.5],
      scale: [1, 1, 1],
      turn: [0, 0, 0],
      sure: [100, 100, 100],
      lost: [],
      anchorMs: 3100,
    };
    expect(mendTrack(track, run).corners).toBeUndefined();
  });
});
