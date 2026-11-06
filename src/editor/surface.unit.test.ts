import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest, type EditOverlay, type EditTrack, type ImageOverlay, type StickerOverlay } from './edit-manifest';
import { applyH, fitH, fourPointH, invertH, isConvexQuad, quadMiddle, squareToQuad } from './homography';
import { compileLayoutMotions } from './layout-motion';
import { overlayMotionAt } from './motion';
import {
  bestFit,
  compileOverlayQuad,
  isSurfaceTrack,
  nextSurfaceName,
  normaliseOverlayQuad,
  placeOnSurface,
  quadAt,
  seenAspect,
  surfaceAspect,
  surfaceCornersAt,
  surfaceFollowPatch,
  surfaceOf,
  surfaceQuadAt,
} from './surface';
import type { TrackScene } from './track-motion';

/*
 * A 720x1280 post over one 10 s clip of the same shape, so a source fraction is an output fraction. Its
 * surface, "s", is a card in perspective - its right edge further off than its left - sliding right, one
 * sample every 100 ms.
 */

const ASPECT = 720 / 1280;

function quadAtMs(t: number): number[] {
  const x = 0.3 + (0.04 * t) / 1000;
  return [x - 0.15, 0.44, x + 0.15, 0.46, x + 0.15, 0.54, x - 0.15, 0.56];
}

function surface(overrides: Partial<EditTrack> = {}, cornersOf = quadAtMs): EditTrack {
  const atMs = Array.from({ length: 101 }, (_, i) => i * 100);
  const corners = atMs.flatMap(t => cornersOf(t));
  const middle = atMs.map((_, i) => quadMiddle(corners.slice(8 * i, 8 * i + 8)) ?? { x: corners[8 * i]!, y: corners[8 * i + 1]! });
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
    ...overrides,
  };
}

function post(track: EditTrack = surface()): EditManifest {
  const m = emptyManifest();
  m.output = { width: 720, height: 1280, fps: 30 };
  m.clips = [defaultClipEdit('a', 10_000)];
  m.tracks = [track];
  return m;
}

function scene(m: EditManifest): TrackScene {
  return { manifest: m, camera: null, layout: compileLayoutMotions(m) };
}

const common = { cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0 };
const photo: ImageOverlay = { ...common, id: 'p', kind: 'image', uri: 'file:///p.jpg', fileName: 'p.jpg', aspect: 1.5 };
const sticker: StickerOverlay = { ...common, id: 'k', kind: 'sticker', emoji: null, assetId: 'heart' };

/** `layer` put on the surface at `outputMs`, and the post with it. */
function placed(layer: EditOverlay, outputMs = 2000, bitmap: { wPx: number; hPx: number } | null = null): { m: EditManifest; layer: EditOverlay } {
  const m = post();
  const patch = placeOnSurface(layer, m.tracks![0]!, scene(m), outputMs, bitmap)!;
  const on = { ...layer, ...patch } as EditOverlay;
  m.overlays = [on];
  return { m, layer: on };
}

/** The bitmap the rasteriser draws a photo at `scale` with: half the frame wide at 1x, its own shape. */
function photoBitmap(layer: EditOverlay): { wPx: number; hPx: number } {
  const wPx = Math.round(720 * 0.5 * layer.scale);
  return { wPx, hPx: Math.round(wPx / 1.5) };
}

function far(a: number[], b: number[]): number {
  let most = 0;
  for (let k = 0; k < 8; k++) most = Math.max(most, Math.abs(a[k]! - b[k]!) * (k % 2 === 0 ? 720 : 1280));
  return most;
}

/** Whether point (`x`, `y`) is inside the convex quad `c`. */
function inside(c: number[], x: number, y: number): boolean {
  let sign = 0;
  for (let k = 0; k < 4; k++) {
    const ax = c[2 * k]!;
    const ay = c[2 * k + 1]!;
    const bx = c[(2 * k + 2) % 8]!;
    const by = c[(2 * k + 3) % 8]!;
    const s = Math.sign((bx - ax) * (y - ay) - (by - ay) * (x - ax));
    if (s !== 0 && sign !== 0 && s !== sign) return false;
    if (s !== 0) sign = s;
  }
  return true;
}

describe('homographies', () => {
  const quad = [100, 80, 420, 120, 400, 300, 90, 260];

  it('takes the unit square onto a quad, and back', () => {
    const h = squareToQuad(quad)!;
    expect(applyH(h, 0, 0).x).toBeCloseTo(100, 9);
    expect(applyH(h, 1, 1).y).toBeCloseTo(300, 9);
    const back = invertH(h)!;
    const p = applyH(back, 90, 260);
    expect(p.x).toBeCloseTo(0, 9);
    expect(p.y).toBeCloseTo(1, 9);
    expect(squareToQuad([0, 0, 1, 1, 2, 2, 3, 3])).toBeNull();
  });

  it('finds the map four points make, and fits one to many in least squares', () => {
    const from = [10, 10, 200, 20, 190, 180, 15, 170];
    const truth = fourPointH(from, quad)!;
    const xs: number[] = [];
    const ys: number[] = [];
    const tx: number[] = [];
    const ty: number[] = [];
    for (let i = 0; i < 40; i++) {
      const x = 20 + ((i * 37) % 170);
      const y = 20 + ((i * 53) % 150);
      const p = applyH(truth, x, y);
      xs.push(x);
      ys.push(y);
      tx.push(p.x + 0.05 * Math.sin(i * 1.7));
      ty.push(p.y + 0.05 * Math.cos(i * 2.3));
    }
    const fit = fitH(xs, ys, tx, ty, Array.from({ length: 40 }, (_, i) => i), 40)!;
    for (let i = 0; i < 4; i++) {
      const a = applyH(fit, from[2 * i]!, from[2 * i + 1]!);
      expect(Math.hypot(a.x - quad[2 * i]!, a.y - quad[2 * i + 1]!)).toBeLessThan(0.1);
    }
  });

  it('tells a convex quad from a folded or flattened one', () => {
    expect(isConvexQuad(quad)).toBe(true);
    expect(isConvexQuad([100, 80, 400, 300, 420, 120, 90, 260])).toBe(false);
    expect(isConvexQuad([0, 0, 1, 0, 2, 0, 0, 1])).toBe(false);
  });
});

describe('seenAspect', () => {
  /**
   * A 2 by 1.2 card four units off a camera with a 1.2-height focal length on a 16:9 frame, turned `yaw`
   * degrees round its upright and then `pitch` round its level: in units of the frame's height.
   */
  function card(yaw: number, pitch = 0): number[] {
    const r = (yaw * Math.PI) / 180;
    const p = (pitch * Math.PI) / 180;
    return [
      [-1, -0.6],
      [1, -0.6],
      [1, 0.6],
      [-1, 0.6],
    ].flatMap(([x, y]) => {
      const X = x! * Math.cos(r);
      const depth = x! * Math.sin(r);
      const Y = y! * Math.cos(p) - depth * Math.sin(p);
      const Z = 4 + y! * Math.sin(p) + depth * Math.cos(p);
      return [0.89 + (1.2 * X) / Z, 0.5 + (1.2 * Y) / Z];
    });
  }

  it('finds the shape of a card turned two ways, its focal length from how it is seen', () => {
    for (const [yaw, pitch] of [
      [25, 15],
      [40, -20],
      [-30, 25],
    ]) {
      expect(Math.abs(seenAspect(card(yaw!, pitch!), { x: 0.89, y: 0.5 })! - 2 / 1.2), `at ${yaw} and ${pitch} degrees`).toBeLessThan(0.03);
    }
  });

  it('finds the shape of a card swung round on its upright, with the camera it was filmed by', () => {
    for (const yaw of [0, 20, 35, 50]) expect(Math.abs(seenAspect(card(yaw), { x: 0.89, y: 0.5 }, 1.2)! - 2 / 1.2), `at ${yaw} degrees`).toBeLessThan(0.02);
  });
});

describe('a surface track', () => {
  it('is one with a quad for every sample', () => {
    expect(isSurfaceTrack(surface())).toBe(true);
    expect(isSurfaceTrack({ ...surface(), corners: undefined })).toBe(false);
    expect(isSurfaceTrack({ ...surface(), corners: [1, 2, 3] })).toBe(false);
    expect(nextSurfaceName([{ name: 'Surface 1' }, { name: 'Track 1' }])).toBe('Surface 2');
  });

  it('reads its corners between samples in a straight line, the ends held', () => {
    const track = surface();
    expect(surfaceCornersAt(track, 150)![0]).toBeCloseTo(0.3 + 0.006 - 0.15, 9);
    expect(surfaceCornersAt(track, -50)).toEqual(quadAtMs(0));
    expect(surfaceCornersAt(track, 20_000)![2]).toBeCloseTo(quadAtMs(10_000)[2]!, 9);
  });

  it('is drawn through the clip onto the frame', () => {
    const m = post();
    const at = surfaceQuadAt(m.tracks![0]!, null, scene(m), 5000)!;
    expect(far(at.corners, quadAtMs(5000))).toBeLessThan(1e-6);
  });
});

describe('a layer on a surface', () => {
  it('is a photo filling the surface, cut to its shape, riding it', () => {
    const { m, layer } = placed(photo);
    expect(layer.follow!.onSurface).toBe(true);
    const compiled = compileOverlayQuad(layer, scene(m), { startMs: 0, endMs: 10_000 }, photoBitmap(layer))!;
    expect(compiled.cut).not.toBeNull();
    expect(compiled.wPx / compiled.hPx).toBeCloseTo(surfaceAspect(m.tracks![0]!), 1);
    for (const t of [2000, 500, 6000, 9900]) {
      expect(far(quadAt(compiled.quad, t)!, surfaceQuadAt(m.tracks![0]!, null, scene(m), t)!.corners), `at ${t}`).toBeLessThan(1.5);
    }
  });

  it('is a sticker in the middle of the surface, inside it', () => {
    // A sticker 245 px wide at 1x, drawn at the size it is put on the surface at.
    const { m, layer } = placed(sticker, 2000, { wPx: 245, hPx: 245 });
    const size = Math.round(245 * layer.scale);
    const compiled = compileOverlayQuad(layer, scene(m), { startMs: 0, endMs: 10_000 }, { wPx: size, hPx: size })!;
    expect(compiled.cut).toBeNull();
    const there = surfaceQuadAt(m.tracks![0]!, null, scene(m), 2000)!.corners;
    const quad = quadAt(compiled.quad, 2000)!;
    const a = quadMiddle(quad)!;
    const b = quadMiddle(there)!;
    expect(Math.abs(a.x - b.x) * 720).toBeLessThan(0.5);
    expect(Math.abs(a.y - b.y) * 1280).toBeLessThan(0.5);
    for (let k = 0; k < 4; k++) expect(inside(there, quad[2 * k]!, quad[2 * k + 1]!), `corner ${k}`).toBe(true);
  });

  it('is keyed once a frame, strictly in time order', () => {
    const { m, layer } = placed(sticker);
    const { quad } = compileOverlayQuad(layer, scene(m), { startMs: 0, endMs: 10_000 }, { wPx: 120, hPx: 80 })!;
    expect(quad.atMs.length).toBeGreaterThan(295);
    expect(quad.corners.length).toBe(8 * quad.atMs.length);
    for (let i = 1; i < quad.atMs.length; i++) expect(quad.atMs[i]!).toBeGreaterThan(quad.atMs[i - 1]!);
  });

  it('holds the last good quad where the surface goes edge on', () => {
    // At 5 s its quad flattens into a line: no engine would draw it.
    const m = post(surface({}, t => (t === 5000 ? [0.3, 0.5, 0.4, 0.5, 0.5, 0.5, 0.6, 0.5] : quadAtMs(t))));
    const patch = placeOnSurface(sticker, m.tracks![0]!, scene(m), 2000)!;
    const layer = { ...sticker, ...patch } as EditOverlay;
    m.overlays = [layer];
    const { quad } = compileOverlayQuad(layer, scene(m), { startMs: 0, endMs: 10_000 }, { wPx: 120, hPx: 80 })!;
    for (let i = 0; i < quad.atMs.length; i++) {
      const c = quad.corners.slice(8 * i, 8 * i + 8).map((v, k) => v * (k % 2 === 0 ? 720 : 1280));
      expect(isConvexQuad(c), `key at ${quad.atMs[i]}`).toBe(true);
    }
  });

  it('carries its best fit as its motion, for a build that draws no quads', () => {
    const { m, layer } = placed(sticker);
    const compiled = compileOverlayQuad(layer, scene(m), { startMs: 0, endMs: 10_000 }, { wPx: 120, hPx: 80 })!;
    for (const t of [1000, 7000]) {
      const pose = overlayMotionAt(compiled.motion, t)!;
      const quad = quadAt(compiled.quad, t)!;
      const fit = bestFit(quad, 0, { width: 720, height: 1280 }, 120, 80);
      expect(layer.cx + pose.x).toBeCloseTo(fit.cx, 3);
      expect(layer.cy + pose.y).toBeCloseTo(fit.cy, 3);
      expect(pose.scale).toBeCloseTo(fit.scale, 2);
    }
  });

  it('keeps where it is drawn when dropped on a surface, and is drawn on it from there', () => {
    const m = post();
    m.overlays = [sticker];
    const patch = surfaceFollowPatch(sticker, m.tracks![0]!, scene(m), 2000)!;
    expect(patch.cx).toBeCloseTo(0.5, 6);
    expect(patch.follow).toMatchObject({ trackId: 's', onSurface: true, scaleWith: true, turnWith: true });
  });

  it('is no layer on a surface without its follow saying so, or on a track with no corners', () => {
    const { m, layer } = placed(sticker);
    const flat = { ...layer, follow: { ...layer.follow!, onSurface: undefined } } as EditOverlay;
    expect(surfaceOf(m, flat)).toBeNull();
    expect(compileOverlayQuad(flat, scene(m), { startMs: 0, endMs: 10_000 }, { wPx: 120, hPx: 80 })).toBeNull();
    const plain = post({ ...surface(), corners: undefined });
    plain.overlays = [layer];
    expect(compileOverlayQuad(layer, scene(plain), { startMs: 0, endMs: 10_000 }, { wPx: 120, hPx: 80 })).toBeNull();
  });
});

describe('a quad on the wire', () => {
  const quad = { atMs: [0, 100], corners: [0, 0, 1, 0, 1, 1, 0, 1, 0.2, 0, 1.2, 0, 1.2, 1, 0.2, 1] };

  it('is read in straight lines between its keys, the ends held', () => {
    expect(quadAt(quad, 50)![0]).toBeCloseTo(0.1, 9);
    expect(quadAt(quad, -10)![0]).toBe(0);
    expect(quadAt(quad, 500)![0]).toBe(0.2);
    expect(quadAt(null, 0)).toBeNull();
  });

  it('is refused unless its keys go strictly forward with eight finite corners each', () => {
    expect(normaliseOverlayQuad(quad)).toEqual(quad);
    expect(normaliseOverlayQuad({ ...quad, atMs: [0, 0] })).toBeNull();
    expect(normaliseOverlayQuad({ ...quad, corners: quad.corners.slice(1) })).toBeNull();
    expect(normaliseOverlayQuad({ ...quad, corners: [...quad.corners.slice(1), Number.NaN] })).toBeNull();
    expect(normaliseOverlayQuad({ atMs: [], corners: [] })).toBeNull();
    expect(normaliseOverlayQuad('quad')).toBeNull();
  });
});
