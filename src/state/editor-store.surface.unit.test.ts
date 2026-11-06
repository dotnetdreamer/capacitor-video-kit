import { beforeEach, describe, expect, it, vi } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditClip, type EditManifest, type EditOverlay, type EditTrack, type ImageOverlay } from '../editor';
import { surfacePlacement } from '../editor/surface';
import { resolveEditorHost } from '../host/defaults';
import type { EditorRenderHost, EditorSource } from '../host/host.types';
import { TrackStoppedError, type TrackFrame, type TrackFrameSource } from '../video-composer/web/track-frames';

import { EditorStore } from './editor-store';

/*
 * Flat surfaces as the store drives them: what the Track sheet offers, the four corners it takes, the run
 * that follows them and the surface it lands, a surface tracked again whole, and a layer put on one. The
 * footage is made up - a still, textured picture read a frame at a time - so a surface on it stays put.
 */

const W = 90;
const H = 160;
const STEP = 1000 / 30;

function hash(x: number, y: number): number {
  let h = Math.imul(x, 374761393) + Math.imul(y, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}

const PICTURE = (() => {
  const out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const gx = x / 4;
      const gy = y / 4;
      const x0 = Math.floor(gx);
      const y0 = Math.floor(gy);
      const fx = gx - x0;
      const fy = gy - y0;
      const top = hash(x0, y0) + (hash(x0 + 1, y0) - hash(x0, y0)) * fx;
      const bottom = hash(x0, y0 + 1) + (hash(x0 + 1, y0 + 1) - hash(x0, y0 + 1)) * fx;
      out[y * W + x] = 30 + 190 * (top + (bottom - top) * fy);
    }
  }
  return out;
})();

function footage(): { open: (uri: string) => Promise<TrackFrameSource>; read: () => number } {
  let read = 0;
  const source: TrackFrameSource = {
    width: W,
    height: H,
    aspect: 720 / 1280,
    durationMs: 20_000,
    async *frames(fromMs: number, toMs: number, signal: AbortSignal): AsyncGenerator<TrackFrame> {
      for (let k = Math.floor(fromMs / STEP + 1e-9); k * STEP <= toMs + 1e-9; k++) {
        await new Promise(resolve => setTimeout(resolve, 1));
        if (signal.aborted) throw new TrackStoppedError('stopped');
        read++;
        yield { timeMs: k * STEP, luma: PICTURE };
      }
    },
    close() {},
  };
  return { open: async () => source, read: () => read };
}

function clip(id: string, outMs: number): EditClip {
  return defaultClipEdit(id, outMs);
}

/** Surface "s" of clip "a": a quad standing still in the middle, a sample every 100 ms for 4 s. */
function surface(): EditTrack {
  const atMs = Array.from({ length: 41 }, (_, i) => i * 100);
  return {
    id: 's',
    name: 'Surface 1',
    hue: 3,
    clipId: 'a',
    clipKey: 'a',
    aspect: 720 / 1280,
    box: { w: 0.6, h: 0.4 },
    atMs,
    x: atMs.map(() => 0.5),
    y: atMs.map(() => 0.5),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    smooth: 0,
    corners: atMs.flatMap(() => [0.2, 0.3, 0.8, 0.3, 0.8, 0.7, 0.2, 0.7]),
  };
}

/** Four corners on the picture: a quad a little off square, as one put on a phone's screen is. */
const CORNERS = [0.22, 0.3, 0.8, 0.28, 0.78, 0.7, 0.2, 0.72];

describe('EditorStore flat surfaces', () => {
  let store: EditorStore;
  let made: ReturnType<typeof footage>;

  function load(clips: EditClip[], overlays: EditOverlay[], tracks?: EditTrack[]): void {
    const sources: EditorSource[] = clips.map(c => ({ key: c.clipKey, fileName: `${c.clipKey}.mp4`, playbackUrl: `https://example.test/${c.clipKey}.mp4` }));
    const m: EditManifest = { ...emptyManifest(), clips, overlays, ...(tracks ? { tracks } : {}) };
    m.output = { width: 720, height: 1280, fps: 30 };
    store.load(sources, new Map(clips.map(c => [c.clipKey, c.outMs])), m);
    for (const c of clips) store.noteSourceShape(c.clipKey, 720 / 1280);
  }

  async function until(done: () => boolean): Promise<void> {
    for (let i = 0; i < 5000 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 2));
    if (!done()) throw new Error('timed out');
  }

  beforeEach(() => {
    store = new EditorStore(resolveEditorHost());
    store.attachPlayer({
      seek: ms => (store.playheadMs.value = ms),
      play: () => (store.playing.value = true),
      pause: () => (store.playing.value = false),
    });
    made = footage();
    store.openTrackFootage = made.open;
    store.renderFeatures.value = ['overlayQuad'];
  });

  it('asks the export what it draws, once, and offers Flat surface only where it draws one', async () => {
    const asked = vi.fn(async () => ['peopleMatte', 'overlayQuad'] as const);
    const render = { isSupported: async () => true, render: async () => Promise.reject(new Error('no')), renderFeatures: asked } as unknown as EditorRenderHost;
    const own = new EditorStore(resolveEditorHost({ render } as never));
    expect(own.canTrackSurfaces.value).toBe(false);
    own.loadRenderFeatures();
    own.loadRenderFeatures();
    await until(() => own.canTrackSurfaces.value);
    expect(asked).toHaveBeenCalledTimes(1);
    expect(own.renderFeatures.value).toEqual(['overlayQuad', 'peopleMatte']);
    // A host that cannot say offers none of it.
    const none = new EditorStore(resolveEditorHost());
    none.loadRenderFeatures();
    expect(none.canTrackSurfaces.value).toBe(false);
  });

  it('puts four corners on the box, and takes them only while they make a surface', () => {
    load([clip('a', 4000)], []);
    store.seek(1000);
    store.openNewTrack();
    store.renderFeatures.value = [];
    store.setTrackAimKind('surface');
    expect(store.trackAimKind.value).toBe('box');
    store.renderFeatures.value = ['overlayQuad'];
    store.setTrackAimKind('surface');
    expect(store.trackAimKind.value).toBe('surface');
    expect(store.surfaceAiming.value).toBe(true);
    const aim = store.trackAim.value!;
    expect(store.surfaceAim.value![0]).toBeCloseTo(aim.cx - aim.w / 2, 9);
    expect(store.surfaceAim.value![5]).toBeCloseTo(aim.cy + aim.h / 2, 9);
    // A bow tie is no surface; nor are corners all but on top of each other.
    expect(store.setSurfaceAim([0.2, 0.2, 0.8, 0.8, 0.8, 0.2, 0.2, 0.8])).toBe(false);
    expect(store.setSurfaceAim([0.5, 0.5, 0.51, 0.5, 0.51, 0.51, 0.5, 0.51])).toBe(false);
    expect(store.setSurfaceAim(CORNERS)).toBe(true);
    expect(store.shownSurfaceAim()).toEqual(CORNERS);
    store.setTrackAimKind('box');
    expect(store.surfaceAim.value).toBeNull();
  });

  it('tracks the surface under the corners and lands Surface 1, its corners at every sample', async () => {
    load([clip('a', 4000)], []);
    store.seek(1000);
    store.openNewTrack();
    store.setTrackAimKind('surface');
    store.setSurfaceAim(CORNERS);
    await store.startTracking();
    const track = store.tracks.value[0]!;
    expect(track.name).toBe('Surface 1');
    expect(track.atMs.length).toBe(121);
    expect(track.corners!.length).toBe(8 * track.atMs.length);
    // A still picture: the surface stays where its corners were put.
    for (let k = 0; k < 8; k++) expect(track.corners![8 * 60 + k]).toBeCloseTo(CORNERS[k]!, 2);
    expect(store.trackShown.value?.id).toBe(track.id);
    expect(store.trackAimKind.value).toBe('box');
    expect(store.surfaceThing.value).not.toBeNull();
    expect(store.surfaceRunning.value).toBe(false);
  });

  it('keeps what a surface run found the moment the sheet shuts under it', async () => {
    load([clip('a', 10_000)], []);
    store.seek(3000);
    store.openNewTrack();
    store.setTrackAimKind('surface');
    store.setSurfaceAim(CORNERS);
    const running = store.startTracking();
    await until(() => made.read() >= 8);
    expect(store.surfaceRunning.value).toBe(true);
    store.closePanel();
    expect(store.tracks.value[0]?.corners?.length).toBeGreaterThanOrEqual(8 * 7);
    expect(store.surfaceRunning.value).toBe(false);
    expect(store.trackRun.value).toBeNull();
    await running;
  });

  it('puts a photo pinned to a surface on it, filling it', () => {
    load([clip('a', 4000)], [], [surface()]);
    store.seek(1000);
    store.pinNextTo('s');
    const id = store.addLayer<ImageOverlay>('Photo', { kind: 'image', uri: 'file:///p.jpg', fileName: 'p.jpg', aspect: 1.5, cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1 })!;
    const layer = store.manifest.value.overlays.find(o => o.id === id)!;
    expect(layer.follow).toMatchObject({ trackId: 's', onSurface: true });
    const wPx = Math.round(720 * 0.5 * layer.scale);
    const placed = surfacePlacement(layer, store.trackScene.value, { wPx, hPx: Math.round(wPx / 1.5) })!;
    const whole = [0, 0, 1, 0, 1, 1, 0, 1];
    placed.plane.forEach((v, k) => expect(Math.abs(v - whole[k]!), `corner value ${k}`).toBeLessThan(0.01));
  });

  it('tracks a surface again whole from its own sheet, keeping its name and colour', async () => {
    load([clip('a', 4000)], [], [surface()]);
    store.seek(1000);
    store.openTrackSheet('s');
    expect(store.surfaceAiming.value).toBe(true);
    store.retrackSurface();
    expect(store.trackAimMoved.value).toBe(true);
    [0.2, 0.3, 0.8, 0.3, 0.8, 0.7, 0.2, 0.7].forEach((v, k) => expect(store.surfaceAim.value![k]).toBeCloseTo(v, 9));
    await store.startTracking();
    const track = store.tracks.value[0]!;
    expect(track).toMatchObject({ id: 's', name: 'Surface 1', hue: 3 });
    expect(track.atMs.length).toBe(121);
    expect(track.corners!.length).toBe(8 * 121);
    expect(store.trackAimMoved.value).toBe(false);
    expect(store.surfaceAim.value).toBeNull();
  });
});
