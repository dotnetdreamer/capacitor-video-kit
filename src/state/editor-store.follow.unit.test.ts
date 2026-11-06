import { beforeEach, describe, expect, it } from 'vitest';

import {
  DEFAULT_ZOOM_RAMP_MS,
  compileCamera,
  compileLayoutMotions,
  defaultClipEdit,
  emptyManifest,
  followPaths,
  followViewAt,
  type EditClip,
  type EditManifest,
  type EditTrack,
  type EditZoom,
  type FollowPath,
} from '../editor';
import { resolveEditorHost } from '../host/defaults';
import type { HapticKind } from '../host/host.types';
import { EditorStore } from './editor-store';

/*
 * Follow cam as the store drives it, for the track row's tile and the zoom sheet: the zoom it makes
 * and where it goes, the clip it contains in the same step, the framing it picks, the zoom it opens
 * instead when one already follows, the area it refuses while following, and what letting go leaves.
 *
 * A 720x1280 post at 30 fps that COVERS, over one 10 s clip "a" whose track "k" has the thing going
 * left to right at mid height.
 */

const WIDE = 16 / 9;
const TALL = 9 / 16;

function walk(aspect: number): EditTrack {
  const atMs = Array.from({ length: 101 }, (_, i) => i * 100);
  return {
    id: 'k',
    name: 'Rider',
    hue: 1,
    clipId: 'a',
    clipKey: 'a',
    aspect,
    box: { w: 0.1, h: 0.2 },
    atMs,
    x: atMs.map(t => 0.1 + (0.8 * t) / 10_000),
    y: atMs.map(() => 0.5),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    smooth: 0,
  };
}

function zoom(id: string, startMs: number, endMs: number): EditZoom {
  return { id, startMs, endMs, cx: 0.5, cy: 0.5, scale: 2, rampMs: 500, ease: 'smooth' };
}

describe('EditorStore follow cam', () => {
  let store: EditorStore;
  let haptics: HapticKind[];

  function load(track: EditTrack, over: Partial<EditManifest> = {}, clip: Partial<EditClip> = {}): void {
    const m: EditManifest = {
      ...emptyManifest(),
      output: { width: 720, height: 1280, fps: 30 },
      fit: 'cover',
      clips: [{ ...defaultClipEdit('a', 10_000), ...clip }],
      tracks: [track],
      ...over,
    };
    store.load([{ key: 'a', fileName: 'a.mp4' }], new Map([['a', 10_000]]), m);
  }

  const zooms = () => store.manifest.value.zooms;
  const clipA = () => store.manifest.value.clips[0]!;
  const following = () => zooms().find(z => z.follow)!;

  /** Zoom `id`'s path as the render would compile it from the post as it is now. */
  function pathOf(id: string): FollowPath {
    const m = store.manifest.value;
    return followPaths(m.zooms, store.totalMs.value, { manifest: m, layout: compileLayoutMotions(m) }).get(id)!;
  }

  beforeEach(() => {
    haptics = [];
    store = new EditorStore(resolveEditorHost({ platform: { haptic: (kind: HapticKind) => void haptics.push(kind) } }));
  });

  it('reframes a wide shot in a tall post: the whole shot, its clip contained in the same step, selected with its sheet open', () => {
    load(walk(WIDE));
    store.followCam('k');
    const z = following();
    expect(z).toMatchObject({ startMs: 0, endMs: 10_000, rampMs: 0, follow: { trackId: 'k', framing: 'fill' } });
    expect(clipA().fit).toBe('contain');
    expect(store.selection.value).toEqual({ kind: 'zoom', id: z.id });
    expect(store.panel.value).toBe('zoom');
    expect(haptics).toContain('success');
    // The still view it keeps for where it cannot follow: the whole shot's level, on the picture.
    expect(z.scale).toBeCloseTo(256 / 81, 3);
    expect(z.cy).toBeCloseTo(0.5, 4);
    // The preview's camera is the render's: the follow, compiled through the post as it now is.
    const m = store.manifest.value;
    expect(store.camera.value).toEqual(compileCamera(m.zooms, store.totalMs.value, { manifest: m, layout: compileLayoutMotions(m) }));
    expect(store.camera.value!.scale.some(scale => Math.abs(scale - 256 / 81) < 1e-5)).toBe(true);
    // One undo takes the zoom and the fit away together.
    store.undo();
    expect(zooms()).toEqual([]);
    expect(clipA().fit).toBeUndefined();
  });

  it('closes in on a shot that already fills its frame, and leaves its fit alone', () => {
    load(walk(TALL));
    store.followCam('k');
    const z = following();
    expect(z.follow).toEqual({ trackId: 'k', framing: 'mid' });
    expect(z.rampMs).toBe(DEFAULT_ZOOM_RAMP_MS);
    expect(clipA().fit).toBeUndefined();
  });

  it('goes in the longest room the other zooms leave over the track, and says so when there is none', () => {
    load(walk(WIDE), { zooms: [zoom('z', 0, 4000)] });
    store.followCam('k');
    expect(following()).toMatchObject({ startMs: 4000, endMs: 10_000 });

    load(walk(WIDE), { zooms: [zoom('z1', 0, 5000), zoom('z2', 5000, 10_000)] });
    const before = store.manifest.value;
    store.followCam('k');
    expect(store.manifest.value).toBe(before);
    expect(store.toast.value?.text).toBe('No room for a zoom on this track');
    expect(haptics).toContain('warning');
  });

  it('opens the zoom already following the track rather than making another, the tile named on', () => {
    load(walk(WIDE));
    store.select({ kind: 'track', id: 'k' });
    expect(store.followCamOn.value).toBe(false);
    store.followCam('k');
    const id = following().id;
    store.closePanel();
    store.select({ kind: 'track', id: 'k' });
    expect(store.followCamOn.value).toBe(true);
    store.followCam('k');
    expect(zooms()).toHaveLength(1);
    expect(store.selection.value).toEqual({ kind: 'zoom', id });
    expect(store.panel.value).toBe('zoom');
    // Nothing recorded for the second tap: one undo is the follow gone.
    store.undo();
    expect(zooms()).toEqual([]);
  });

  it('shows the moving view in the area box while the box is up', () => {
    load(walk(WIDE));
    store.followCam('k');
    const id = following().id;
    const path = pathOf(id);
    store.seek(2000);
    store.showZoomArea();
    expect(store.cameraLive.value).toBe(false);
    const early = store.selectedZoom.value!;
    expect(early.cx).toBeCloseTo(followViewAt(path, 2000).cx, 9);
    expect(early.scale).toBeCloseTo(followViewAt(path, 2000).scale, 9);
    store.seek(8000);
    store.showZoomArea();
    expect(store.selectedZoom.value!.cx).toBeGreaterThan(early.cx + 0.2);
    // With the picture zoomed on screen instead, the zoom is as stored.
    store.seek(5000);
    expect(store.cameraLive.value).toBe(true);
    expect(store.selectedZoom.value).toBe(following());
  });

  it('refuses an area to a zoom that follows, and changes its framing in one step', () => {
    load(walk(WIDE));
    store.followCam('k');
    const id = following().id;
    const whole = store.camera.value;
    const before = store.manifest.value;
    store.updateZoom(id, { cx: 0.2, cy: 0.3, scale: 1.5 });
    expect(store.manifest.value).toBe(before);
    store.updateZoom(id, { ease: 'steady' });
    expect(following().ease).toBe('steady');
    store.setZoomFollowFraming(id, 'close');
    expect(following().follow).toEqual({ trackId: 'k', framing: 'close' });
    expect(following().scale).toBeGreaterThan(256 / 81);
    expect(store.camera.value).not.toEqual(whole);
    expect(haptics).toContain('selection');
    store.undo();
    expect(following().follow?.framing).toBe('fill');
    expect(following().ease).toBe('steady');
  });

  it('lets go at the view its camera has at the playhead, in one step', () => {
    load(walk(WIDE));
    store.followCam('k');
    const id = following().id;
    const at = followViewAt(pathOf(id), 6000);
    store.seek(6000);
    store.stopZoomFollow(id);
    const z = zooms()[0]!;
    expect('follow' in z).toBe(false);
    expect(z.cx).toBeCloseTo(at.cx, 3);
    expect(z.cy).toBeCloseTo(at.cy, 3);
    expect(z.scale).toBeCloseTo(at.scale, 3);
    // An area again, which the box drags.
    store.updateZoom(id, { cx: 0.4 });
    expect(zooms()[0]!.cx).toBe(0.4);
    store.undo();
    store.undo();
    expect(zooms()[0]!.follow).toEqual({ trackId: 'k', framing: 'fill' });
  });

  it('holds its own still view once its track is taken off the post', () => {
    load(walk(WIDE));
    store.followCam('k');
    store.deleteTrack('k');
    const z = zooms()[0]!;
    const { follow: _follow, ...still } = z;
    expect(store.camera.value).toEqual(compileCamera([still], store.totalMs.value));
    store.select({ kind: 'zoom', id: z.id });
    expect(store.selectedZoomTrack.value).toBeNull();
  });
});
