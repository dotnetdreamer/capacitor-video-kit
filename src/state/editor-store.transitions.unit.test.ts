import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TRANSITION_MS, emptyManifest, type EditClip, type EditManifest } from '../editor';
import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { EditorStore } from './editor-store';

/*
 * The transition sheet as the store runs it. Three four-second clips, a, b and c, so the boundary
 * into b sits at 4000 and the one into c at 8000 until a transition pulls them in.
 */
function clip(id: string, extra: Partial<EditClip> = {}): EditClip {
  return { id, clipKey: id, inMs: 0, outMs: 4000, speed: 1, volume: 1, muted: false, ...extra };
}

const sources: EditorSource[] = ['a', 'b', 'c'].map(key => ({ key, fileName: `${key}.mp4` }));

describe('EditorStore transitions', () => {
  let store: EditorStore;

  function load(clips: EditClip[] = [clip('a'), clip('b'), clip('c')]): EditManifest {
    const manifest = { ...emptyManifest(), clips };
    store.load(sources, new Map(clips.map(c => [c.clipKey, 4000])), manifest);
    return manifest;
  }

  const kinds = () => store.manifest.value.clips.map(c => c.transitionIn?.kind ?? null);

  beforeEach(() => {
    store = new EditorStore(resolveEditorHost({}));
  });

  it('opens the sheet on a boundary, names it by its incoming clip, and puts the preview there', () => {
    load();
    store.openTransition('b');
    expect(store.panel.value).toBe('transition');
    expect(store.transitionTarget.value).toBe('b');
    expect(store.targetBoundary.value).toMatchObject({ clipId: 'b', index: 1, transition: null, maxMs: 2000, atMs: 4000 });
    expect(store.playheadMs.value).toBe(4000);
  });

  it('has no boundary in front of the first clip', () => {
    load();
    store.openTransition('a');
    expect(store.panel.value).toBeNull();
    expect(store.boundaryOf('a')).toBeNull();
  });

  it('folds everything done in the sheet into one undo step', () => {
    load();
    store.openTransition('b');
    store.chooseTransition('dissolve');
    store.chooseTransition('slide-left');
    store.setTransitionDuration(800);
    store.chooseTransition('blur');
    expect(kinds()).toEqual([null, 'blur', null]);
    expect(store.manifest.value.clips[1].transitionIn?.durationMs).toBe(800);
    store.closePanel();

    store.undo();
    expect(kinds()).toEqual([null, null, null]);
    expect(store.canUndo.value).toBe(false);
  });

  it('bumps the revision for every change, folded or not, so drafts follow the sheet', () => {
    load();
    const before = store.revision.value;
    store.openTransition('b');
    store.chooseTransition('dissolve');
    store.chooseTransition('blur');
    expect(store.revision.value).toBe(before + 2);
  });

  it('starts a new step after an undo inside the sheet', () => {
    load();
    store.openTransition('b');
    store.chooseTransition('dissolve');
    store.undo();
    store.chooseTransition('blur');
    store.chooseTransition('spin');
    store.closePanel();
    expect(kinds()).toEqual([null, 'spin', null]);
    store.undo();
    expect(kinds()).toEqual([null, null, null]);
  });

  it('keeps the steps of two visits to the sheet apart', () => {
    load();
    store.openTransition('b');
    store.chooseTransition('dissolve');
    store.closePanel();
    store.openTransition('c');
    store.chooseTransition('blur');
    store.closePanel();
    store.undo();
    expect(kinds()).toEqual([null, 'dissolve', null]);
  });

  it('gives a new transition the last duration chosen, held to what the clips can take', () => {
    load([clip('a'), clip('b'), clip('c', { outMs: 900 })]);
    store.openTransition('b');
    store.chooseTransition('dissolve');
    expect(store.manifest.value.clips[1].transitionIn?.durationMs).toBe(DEFAULT_TRANSITION_MS);
    store.setTransitionDuration(1500);
    store.closePanel();
    store.openTransition('c');
    store.chooseTransition('dissolve');
    // c is 900 ms, so the boundary into it holds 400 ms at most.
    expect(store.targetBoundary.value?.maxMs).toBe(400);
    expect(store.manifest.value.clips[2].transitionIn?.durationMs).toBe(400);
  });

  it('takes a transition off with None', () => {
    load();
    store.openTransition('b');
    store.chooseTransition('dissolve');
    store.removeTransition();
    expect(kinds()).toEqual([null, null, null]);
  });

  it('applies to every boundary as a step of its own', () => {
    load();
    store.openTransition('b');
    store.chooseTransition('white');
    store.applyTransitionToAll();
    expect(kinds()).toEqual([null, 'white', 'white']);
    expect(store.toast.value?.text).toBe('Transition applied to all clips');
    store.closePanel();
    store.undo();
    expect(kinds()).toEqual([null, 'white', null]);
    store.applyTransitionToAll();
    expect(kinds()).toEqual([null, 'white', null]);
  });

  it('shuts the sheet when a clip is selected, or when its boundary is undone away', () => {
    load();
    store.openTransition('b');
    store.select({ kind: 'clip', id: 'a' });
    expect(store.panel.value).toBeNull();
    expect(store.transitionTarget.value).toBeNull();

    // A duplicate made, its boundary opened, and the duplicate undone: the boundary is gone with it.
    store.duplicateSelectedClip();
    const copy = store.manifest.value.clips[1].id;
    store.openTransition(copy);
    expect(store.targetBoundary.value?.index).toBe(1);
    store.undo();
    expect(store.panel.value).toBeNull();
    expect(store.transitionTarget.value).toBeNull();
  });

  it('describes the transition under the playhead for the preview, and nothing outside it', () => {
    load();
    store.openTransition('b');
    store.chooseTransition('dissolve');
    store.closePanel();
    // b now starts at 3500, with the transition running to 4000.
    store.seek(3750);
    const t = store.previewTransition.value!;
    expect(t).toMatchObject({ clipId: 'b', startMs: 3500, durationMs: 500 });
    expect(t.progress).toBeCloseTo(0.5);
    expect(t.from).toMatchObject({ trackId: null, clipId: 'a', clipKey: 'a', sourceMs: 3750 });
    expect(t.transition.kind).toBe('dissolve');
    expect(store.previewLayers.value[0]).toMatchObject({ clipId: 'b', sourceMs: 250 });
    store.seek(4100);
    expect(store.previewTransition.value).toBeNull();
    expect(store.totalMs.value).toBe(11_500);
  });
});
