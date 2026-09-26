import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_ZOOM_MS, DEFAULT_ZOOM_SCALE, MIN_ZOOM_MS, emptyManifest, type EditClip, type EditManifest, type EditZoom } from '../editor';

import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { EditorStore } from './editor-store';

/*
 * The store's zoom actions are the contract the zoom sheet, the timeline lane and the preview code
 * against: one undo step per action, a slider's run of steps folded into one, the sheet closing when
 * its zoom goes, and the camera off while the area is being drawn.
 */

function clip(id: string, inMs: number, outMs: number): EditClip {
  return { id, clipKey: id, inMs, outMs, speed: 1, volume: 1, muted: false };
}

function zoom(id: string, startMs: number, endMs: number): EditZoom {
  return { id, startMs, endMs, cx: 0.5, cy: 0.5, scale: 2, rampMs: 500, ease: 'smooth' };
}

describe('EditorStore zooms', () => {
  let store: EditorStore;
  const sources: EditorSource[] = [{ key: 'a', fileName: 'a.mp4' }];

  function load(extra: Partial<EditManifest> = {}): EditManifest {
    const base = { ...emptyManifest(), clips: [clip('a', 0, 10_000)], ...extra };
    store.load(sources, new Map([['a', 10_000]]), base);
    return base;
  }

  beforeEach(() => {
    store = new EditorStore(resolveEditorHost());
    load();
  });

  it('adds a zoom at the playhead as one step, selected with its sheet open', () => {
    store.seek(2000);
    const revision = store.revision.value;
    store.addZoomAtPlayhead();
    const [z] = store.zooms.value;
    expect(z).toMatchObject({ startMs: 2000, endMs: 2000 + DEFAULT_ZOOM_MS, scale: DEFAULT_ZOOM_SCALE, cx: 0.5, cy: 0.5, ease: 'smooth' });
    expect(store.selectedZoom.value).toBe(z);
    expect(store.panel.value).toBe('zoom');
    expect(store.revision.value).toBe(revision + 1);
    expect(store.camera.value).not.toBeNull();
    store.undo();
    expect(store.zooms.value).toEqual([]);
    expect(store.selection.value).toBeNull();
    expect(store.panel.value).toBeNull();
  });

  it('says so when there is no room', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    store.seek(2000);
    store.addZoomAtPlayhead();
    expect(store.zooms.value).toHaveLength(1);
    expect(store.toast.value?.text).toBe('No room for a zoom here');
    store.seek(10_000 - MIN_ZOOM_MS + 10);
    store.addZoomAtPlayhead();
    expect(store.zooms.value).toHaveLength(1);
  });

  it('folds a run of coalesced updates into one undo step', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    const drag = store.coalesceKey('drag');
    store.updateZoom('z', { cx: 0.6 }, { coalesce: drag });
    store.updateZoom('z', { cx: 0.7 }, { coalesce: drag });
    store.updateZoom('z', { cx: 0.74 }, { coalesce: drag });
    expect(store.zooms.value[0].cx).toBe(0.74);
    store.updateZoom('z', { scale: 3 });
    expect(store.canUndo.value).toBe(true);
    store.undo();
    expect(store.zooms.value[0]).toMatchObject({ cx: 0.74, scale: 2 });
    store.undo();
    expect(store.zooms.value[0].cx).toBe(0.5);
    expect(store.canUndo.value).toBe(false);
  });

  it('starts a new step for a different coalesce key', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    store.updateZoom('z', { rampMs: 800 }, { coalesce: store.coalesceKey('ramp') });
    store.setZoomWindow('z', 1000, 5000, { coalesce: store.coalesceKey('edge') });
    store.undo();
    expect(store.zooms.value[0]).toMatchObject({ rampMs: 800, endMs: 4000 });
  });

  it('never hands out the same coalesce key twice, whatever the gesture is called', () => {
    const keys = [store.coalesceKey('zoom-level'), store.coalesceKey('zoom-level'), store.coalesceKey('zoom-ramp')];
    expect(new Set(keys).size).toBe(3);
    // A load starts a new post, not a new count: the store is what outlives the components asking.
    load();
    expect(keys).not.toContain(store.coalesceKey('zoom-level'));
  });

  /*
   * The run a key folds into lives here, and the sheet, the timeline and the preview that pass the
   * keys come and go under it: the sheet every time its panel closes, the timeline in full screen.
   * Each of them used to count its own gestures for the key, so a new one started the count again
   * and its first gesture folded into the old one's undo step - Level 2.0x to 3.0x, Done, Edit,
   * 4.0x, and one Undo went back to 2.0x. A key taken from the store is one no earlier gesture had.
   */
  it('keeps a gesture in a sheet opened again out of the step the last sheet made', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    store.openZoom('z');
    const first = store.coalesceKey('zoom-level');
    store.updateZoom('z', { scale: 2.5 }, { coalesce: first });
    store.updateZoom('z', { scale: 3 }, { coalesce: first });
    store.closePanel();

    store.openZoom('z');
    store.updateZoom('z', { scale: 4 }, { coalesce: store.coalesceKey('zoom-level') });

    store.undo();
    expect(store.zooms.value[0].scale).toBe(3);
    store.undo();
    expect(store.zooms.value[0].scale).toBe(2);
    expect(store.canUndo.value).toBe(false);
  });

  it('keeps a window drag out of the step the drag before it made, with nothing between them', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    const first = store.coalesceKey('zoom-window');
    store.setZoomWindow('z', 1000, 4500, { coalesce: first });
    store.setZoomWindow('z', 1000, 5000, { coalesce: first });
    store.setZoomWindow('z', 1000, 6000, { coalesce: store.coalesceKey('zoom-window') });

    store.undo();
    expect(store.zooms.value[0].endMs).toBe(5000);
    store.undo();
    expect(store.zooms.value[0].endMs).toBe(4000);
  });

  it('deletes the selected zoom from Delete and closes its sheet', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    store.openZoom('z');
    expect(store.panel.value).toBe('zoom');
    store.deleteSelection();
    expect(store.zooms.value).toEqual([]);
    expect(store.panel.value).toBeNull();
    expect(store.selection.value).toBeNull();
  });

  it('duplicates straight after, and says so without room', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    store.duplicateZoom('z');
    expect(store.zooms.value.map(z => [z.startMs, z.endMs])).toEqual([
      [1000, 4000],
      [4000, 7000],
    ]);
    store.duplicateZoom(store.zooms.value[0].id);
    expect(store.toast.value?.text).toBe('No room for a copy after this zoom');
  });

  it('keeps the camera off in the crop sheet, and in the zoom sheet while the area is drawn', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    expect(store.cameraLive.value).toBe(true);
    store.openZoom('z');
    expect(store.zoomView.value).toBe('area');
    expect(store.cameraLive.value).toBe(false);
    store.playing.value = true;
    expect(store.cameraLive.value).toBe(true);
    store.playing.value = false;
    store.openPanel('crop');
    expect(store.cameraLive.value).toBe(false);
  });

  it('shows the zoomed picture in the zoom sheet once the playhead is moved, and the box again on a touch', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    // Outside the sheet a paused scrub is always zoomed.
    store.seek(2500);
    expect(store.cameraLive.value).toBe(true);

    store.openZoom('z');
    expect(store.cameraLive.value).toBe(false);
    // Dragging the timeline with the sheet open is looking at the move: the camera comes on, paused.
    store.seek(2000);
    expect(store.playing.value).toBe(false);
    expect(store.zoomView.value).toBe('result');
    expect(store.cameraLive.value).toBe(true);
    // A touch on the video goes back to drawing the area.
    store.showZoomArea();
    expect(store.cameraLive.value).toBe(false);
    // Play in the sheet leaves the result on screen where it is stopped.
    store.play();
    expect(store.zoomView.value).toBe('result');
    // Reopening the sheet (a tap on the bar) starts on the area again.
    store.openZoom('z');
    expect(store.zoomView.value).toBe('area');
    expect(store.cameraLive.value).toBe(false);
  });

  it('closes the sheet when another thing is selected', () => {
    load({ zooms: [zoom('z', 1000, 4000)] });
    store.openZoom('z');
    store.select({ kind: 'clip', id: 'a' });
    expect(store.panel.value).toBeNull();
  });
});
