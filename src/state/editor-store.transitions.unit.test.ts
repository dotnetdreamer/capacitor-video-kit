import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_TRANSITION_MS, emptyManifest, type EditClip, type EditManifest } from '../editor';
import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { EditorStore } from './editor-store';
import type { EditorPlayer } from './editor.types';

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

  /**
   * A player that does at once what the preview's does in a frame or two: a seek lands, and play and
   * pause say so on `playing`. What it was asked to do, in order, is in the list it hands back.
   */
  function attachPlayer(): string[] {
    const calls: string[] = [];
    const player: EditorPlayer = {
      seek: ms => {
        calls.push(`seek ${ms}`);
        store.playheadMs.value = ms;
      },
      play: () => {
        calls.push('play');
        store.playing.value = true;
      },
      pause: () => {
        calls.push('pause');
        store.playing.value = false;
      },
    };
    store.attachPlayer(player);
    return calls;
  }

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

  describe('the visit’s one undo step', () => {
    it('keeps a change made outside the sheet out of it', () => {
      load();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      // The mute on the timeline, tapped with the sheet still open.
      store.toggleOriginalMuted();
      store.closePanel();

      store.undo();
      expect(store.manifest.value.originalMuted).toBe(false);
      expect(kinds()).toEqual([null, 'dissolve', null]);
      store.undo();
      expect(kinds()).toEqual([null, null, null]);
      expect(store.canUndo.value).toBe(false);
    });

    it('starts a step of its own for what the sheet does after that change', () => {
      load();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      store.toggleOriginalMuted();
      store.chooseTransition('blur');
      store.chooseTransition('spin');
      store.closePanel();

      store.undo();
      expect(kinds()).toEqual([null, 'dissolve', null]);
      expect(store.manifest.value.originalMuted).toBe(true);
      store.undo();
      expect(store.manifest.value.originalMuted).toBe(false);
      expect(kinds()).toEqual([null, 'dissolve', null]);
      store.undo();
      expect(kinds()).toEqual([null, null, null]);
      expect(store.canUndo.value).toBe(false);
    });

    it('keeps a drag that is not the sheet’s out of it', () => {
      const before = load();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      store.beginGesture();
      store.previewFilterIntensity(0.25);
      store.endGesture('Filter strength');
      store.closePanel();

      store.undo();
      expect(store.manifest.value.filterIntensity).toBe(before.filterIntensity);
      expect(kinds()).toEqual([null, 'dissolve', null]);
    });

    it('folds the duration slider’s drags in, even one a tile tap closes while it is held', () => {
      load();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      // The slider's own shape: its gesture, its live values, and the label it ends with.
      store.beginGesture();
      store.setTransitionDuration(800, true);
      store.endGesture('Transition duration');
      // Still held when a tile is tapped: the tap closes the gesture as 'Change' on its way in.
      store.beginGesture();
      store.setTransitionDuration(1200, true);
      store.chooseTransition('blur');
      expect(store.manifest.value.clips[1].transitionIn).toEqual({ kind: 'blur', durationMs: 1200 });
      store.closePanel();

      store.undo();
      expect(kinds()).toEqual([null, null, null]);
      expect(store.canUndo.value).toBe(false);
    });
  });

  describe('the playhead, as the boundary moves under it', () => {
    it('follows the middle of the transition to its new length, committed and live', () => {
      load();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      // The audition has taken it to just before the window.
      expect(store.playheadMs.value).toBe(2900);

      // A second long: b starts at 3000, and the middle is half way through the second.
      store.setTransitionDuration(1000);
      expect(store.playheadMs.value).toBe(3500);

      store.beginGesture();
      store.setTransitionDuration(1500, true);
      expect(store.playheadMs.value).toBe(3250);
      store.endGesture('Transition duration');
      expect(store.playheadMs.value).toBe(3250);
    });

    it('goes back to the cut when the transition is taken off', () => {
      load();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      store.removeTransition();
      expect(store.playheadMs.value).toBe(4000);
    });

    it('follows the boundary along when Apply to all dresses the cuts before it', () => {
      load();
      store.openTransition('c');
      store.chooseTransition('dissolve');
      store.applyTransitionToAll();
      // b's transition pulls c in by another 500: c starts at 7000, its window runs to 7500.
      expect(store.targetBoundary.value?.atMs).toBe(7000);
      expect(store.playheadMs.value).toBe(7250);
    });

    it('ends a running audition first, so it cannot park on the old middle later', async () => {
      load();
      const calls = attachPlayer();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      expect(store.playing.value).toBe(true);

      store.setTransitionDuration(1000);
      expect(store.playing.value).toBe(false);
      expect(calls.slice(-2)).toEqual(['pause', 'seek 3500']);

      // Played on by the customer, past where the audition would have stopped: nothing takes the
      // playhead back to the 500 ms transition's middle.
      store.play();
      store.playheadMs.value = 5000;
      await Promise.resolve();
      expect(store.playheadMs.value).toBe(5000);
      expect(store.playing.value).toBe(true);
    });

    it('leaves the customer’s own playback where it is', async () => {
      load();
      const calls = attachPlayer();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      // The audition runs to its end and parks.
      store.playheadMs.value = 4500;
      await Promise.resolve();
      expect(store.playing.value).toBe(false);

      store.play();
      store.playheadMs.value = 6000;
      const seen = calls.length;
      store.setTransitionDuration(1000);
      expect(calls.slice(seen)).toEqual([]);
      expect(store.playheadMs.value).toBe(6000);
    });
  });

  describe('a split near a transition', () => {
    function dissolveIntoB(): void {
      load();
      store.openTransition('b');
      store.chooseTransition('dissolve');
      store.closePanel();
    }

    it('puts the playhead on the cut it made inside the window, which the shrunk transition moved', () => {
      dissolveIntoB();
      store.seek(3750);
      store.splitAtPlayhead();

      const [, left, right] = store.manifest.value.clips;
      // b's first 250 ms holds the transition now, and half of it is 100 ms at the slider's step.
      expect([left.id, left.inMs, left.outMs]).toEqual(['b', 0, 250]);
      expect(store.boundaryOf('b')?.effectiveMs).toBe(100);
      // a runs to 3900, b's short piece to 4150, and the cut just made is there.
      expect(store.playheadMs.value).toBe(4150);
      expect(store.previewLayers.value[0].clipId).toBe(right.id);
      expect(store.selection.value).toEqual({ kind: 'clip', id: right.id });
    });

    it('does the same for a split just after the window', () => {
      dissolveIntoB();
      store.seek(4100);
      store.splitAtPlayhead();

      const right = store.manifest.value.clips[2];
      expect(store.boundaryOf('b')?.effectiveMs).toBe(300);
      expect(store.playheadMs.value).toBe(4300);
      expect(store.previewLayers.value[0].clipId).toBe(right.id);
    });
  });
});
