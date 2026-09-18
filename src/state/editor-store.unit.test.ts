import { beforeEach, describe, expect, it } from 'vitest';
import {
  MAX_LAYERS,
  MAX_VIDEO_TRACKS,
  emptyManifest,
  findOverlay,
  removeClip,
  type EditClip,
  type EditManifest,
  type EditMusic,
  type EditVideoTrack,
  type StickerOverlay,
  type TextOverlay,
} from '../editor';

import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { EditorStore } from './editor-store';

function clip(id: string, inMs: number, outMs: number, extra: Partial<EditClip> = {}): EditClip {
  return { id, clipKey: id, inMs, outMs, speed: 1, volume: 1, muted: false, ...extra };
}

function track(clips: EditClip[], extra: Partial<EditVideoTrack> = {}): EditVideoTrack {
  return { id: 'vt', clips, startMs: 0, z: 1, opacity: 1, ...extra };
}

function sticker(id: string, extra: Partial<StickerOverlay> = {}): StickerOverlay {
  return {
    id,
    kind: 'sticker',
    emoji: 'x',
    assetId: null,
    cx: 0.5,
    cy: 0.5,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 0,
    endMs: 0,
    ...extra,
  };
}

function text(id: string, value: string): TextOverlay {
  return {
    id,
    kind: 'text',
    text: value,
    styleId: 'classic',
    color: '#ffffff',
    effect: 'shadow',
    align: 'center',
    cx: 0.5,
    cy: 0.5,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 0,
    endMs: 0,
  };
}

const MUSIC: EditMusic = {
  uri: 'file:///m.mp3',
  fileName: 'm.mp3',
  sourceDurationMs: 0,
  inMs: 0,
  outMs: 0,
  startMs: 0,
  volume: 0.6,
  loop: true,
  fadeOutMs: 400,
};

describe('EditorStore', () => {
  let store: EditorStore;
  /** Clip a is 0..4000 of 4000 ms, clip b 0..2000 of 2000 ms: a 6 s video. */
  let base: EditManifest;

  const sources: EditorSource[] = [
    { key: 'a', fileName: 'a.mp4' },
    { key: 'b', fileName: 'b.mp4' },
  ];

  function load(extra: Partial<EditManifest> = {}): EditManifest {
    base = { ...emptyManifest(), clips: [clip('a', 0, 4000), clip('b', 0, 2000)], ...extra };
    store.load(sources, new Map([['a', 4000], ['b', 2000]]), base);
    return base;
  }

  const clipIds = () => store.manifest.value.clips.map((c) => c.id);
  const undoAll = () => {
    let steps = 0;
    while (store.canUndo.value) {
      store.undo();
      steps++;
    }
    return steps;
  };

  beforeEach(() => {
    // Was `TestBed.inject(EditorStore)`. With the store a plain class the only thing it needs is a
    // host, and the browser defaults are a real one: the store only ever asks it for a haptic.
    store = new EditorStore(resolveEditorHost());
    load();
  });

  it('starts clean', () => {
    expect(store.manifest.value).toBe(base);
    expect(store.totalMs.value).toBe(6000);
    expect(store.canUndo.value).toBe(false);
    expect(store.canRedo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
  });

  describe('commit', () => {
    it('does nothing for a change that is not possible or not a change', () => {
      expect(store.commit('Nothing', () => null)).toBe(false);
      expect(store.commit('Same', (m) => m)).toBe(false);
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
      expect(store.dirty.value).toBe(false);
    });

    it('makes a real change one undo step', () => {
      expect(store.commit('Fill frame', (m) => ({ ...m, fit: 'cover' }))).toBe(true);
      expect(store.manifest.value.fit).toBe('cover');
      expect(store.canUndo.value).toBe(true);
      expect(store.dirty.value).toBe(true);
    });

    it('does not record a patch that leaves every value as it was', () => {
      store.setClipSpeed('a', 1);
      store.setVolume({ kind: 'clip', id: 'a' }, 1, false);
      store.commitOverlay('nope', { cx: 0.2 }, 'Move');
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
    });
  });

  describe('gestures', () => {
    it('lands a whole gesture as ONE undo step', () => {
      store.beginGesture();
      store.previewFilterIntensity(0.8);
      store.previewFilterIntensity(0.5);
      store.previewFilterIntensity(0.3);
      expect(store.manifest.value.filterIntensity).toBe(0.3);
      expect(store.canUndo.value).toBe(false);
      store.endGesture('Filter strength');

      expect(store.canUndo.value).toBe(true);
      store.undo();
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
      expect(store.toast.value?.text).toBe('Undo: Filter strength');
    });

    it('records nothing for a gesture that changed nothing', () => {
      store.beginGesture();
      store.preview((m) => m);
      store.preview(() => null);
      store.endGesture('Nothing');
      expect(store.canUndo.value).toBe(false);

      // A trim dragged away and back onto exactly where it was.
      store.beginGesture();
      store.previewTrim('a', 1000, 4000);
      store.preview(() => base);
      store.endGesture('Trim');
      expect(store.canUndo.value).toBe(false);

      // A slider held at the value it already had.
      store.beginGesture();
      store.previewFilterIntensity(1);
      store.previewAdjust('brightness', 0);
      store.setVolume({ kind: 'clip', id: 'a' }, 1, true);
      store.endGesture('Adjust');
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
    });

    it('records nothing, and is not dirty, for a slider dragged away and back', () => {
      // Every live step rebuilds the manifest, so the gesture ends on a new object equal to the start.
      store.beginGesture();
      store.setClipSpeed('a', 1.5, true);
      store.setClipSpeed('a', 1, true);
      store.setVolume({ kind: 'clip', id: 'a' }, 0.4, true);
      store.setVolume({ kind: 'clip', id: 'a' }, 1, true);
      expect(store.manifest.value).not.toBe(base);
      store.endGesture('Speed');

      expect(store.canUndo.value).toBe(false);
      expect(store.manifest.value).toBe(base);
      expect(store.dirty.value).toBe(false);
    });

    it('puts back the starting manifest when cancelled', () => {
      store.beginGesture();
      store.previewTrim('a', 1000, 3000);
      expect(store.manifest.value.clips[0].inMs).toBe(1000);
      store.cancelGesture();
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
    });

    it('keeps the first snapshot when begun twice', () => {
      store.beginGesture();
      store.previewTrim('a', 500, 4000);
      store.beginGesture();
      store.previewTrim('a', 1000, 4000);
      store.endGesture('Trim');
      store.undo();
      expect(store.manifest.value).toBe(base);
    });

    it('closes an open gesture as its own step when something is committed', () => {
      store.beginGesture();
      store.previewAdjust('contrast', 0.4);
      store.toggleFit();
      expect(undoAll()).toBe(2);
      expect(store.manifest.value).toBe(base);
    });
  });

  describe('undo and redo', () => {
    it('cycles back and forth and a new commit clears redo', () => {
      store.toggleFit();
      const afterFit = store.manifest.value;
      store.toggleOriginalMuted();
      const afterMute = store.manifest.value;

      store.undo();
      expect(store.manifest.value).toBe(afterFit);
      expect(store.canRedo.value).toBe(true);
      store.undo();
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
      expect(store.dirty.value).toBe(false);
      expect(store.toast.value?.text).toBe('Undo: Fill frame');

      store.undo();
      expect(store.manifest.value).toBe(base);

      store.redo();
      expect(store.manifest.value).toBe(afterFit);
      store.redo();
      expect(store.manifest.value).toBe(afterMute);
      expect(store.canRedo.value).toBe(false);
      expect(store.toast.value?.text).toBe('Redo: Mute original sound');

      store.undo();
      expect(store.canRedo.value).toBe(true);
      store.commit('Filter', (m) => ({ ...m, filterId: 'noir' }));
      expect(store.canRedo.value).toBe(false);
      store.redo();
      expect(store.manifest.value.filterId).toBe('noir');
      expect(store.manifest.value.originalMuted).toBe(false);
    });

    it('keeps the last 50 steps', () => {
      for (let i = 1; i <= 60; i++) {
        store.commit(`Step ${i}`, (m) => ({ ...m, filterIntensity: i / 100 }));
      }
      expect(store.manifest.value.filterIntensity).toBe(0.6);
      expect(undoAll()).toBe(50);
      // The oldest ten steps fell off: undo stops at the state after step 10.
      expect(store.manifest.value.filterIntensity).toBe(0.1);
      expect(store.manifest.value).not.toBe(base);
    });

    it('drops a selection whose target is gone, and keeps one that is still there', () => {
      const id = store.addSticker({ emoji: 'x' });
      expect(store.selection.value).toEqual({ kind: 'overlay', id: id! });
      store.undo();
      expect(store.selection.value).toBeNull();

      store.select({ kind: 'clip', id: 'a' });
      store.toggleFit();
      store.undo();
      expect(store.selection.value).toEqual({ kind: 'clip', id: 'a' });
    });

    it('refuses both while a voiceover take is recording, and says why', () => {
      store.toggleFit();
      const afterFit = store.manifest.value;

      store.recordingFromMs.value = 2000;
      expect(store.historyLocked.value).toBe(true);
      store.undo();
      expect(store.manifest.value).toBe(afterFit);
      expect(store.toast.value?.text).toBe('Stop recording first');

      store.recordingFromMs.value = null;
      expect(store.historyLocked.value).toBe(false);
      store.undo();
      expect(store.manifest.value).toBe(base);

      store.recordingFromMs.value = 2000;
      store.redo();
      expect(store.manifest.value).toBe(base);
      expect(store.toast.value?.text).toBe('Stop recording first');

      store.recordingFromMs.value = null;
      store.redo();
      expect(store.manifest.value).toBe(afterFit);
    });

    it('keeps an earlier take that an undo mid-recording used to throw away for good', () => {
      store.addVoiceover({ id: 'v1', uri: 'file:///v1.m4a', startMs: 0, durationMs: 1000, volume: 1 });
      const withFirst = store.manifest.value;

      // A second take is running, and undo is pressed: it used to put the manifest back to before
      // the first take, and the second take's own commit then cleared the redo it was sitting in.
      store.recordingFromMs.value = 2000;
      store.undo();
      expect(store.manifest.value).toBe(withFirst);

      store.recordingFromMs.value = null;
      store.addVoiceover({ id: 'v2', uri: 'file:///v2.m4a', startMs: 2000, durationMs: 1000, volume: 1 });
      expect(store.manifest.value.voiceovers.map((take) => take.id)).toEqual(['v1', 'v2']);
    });

    it('pulls the playhead back inside a shorter video', () => {
      store.commit('Delete', (m) => removeClip(m, 'a'));
      store.playheadMs.value = 1500;
      store.undo();
      store.playheadMs.value = 5500;
      store.redo();
      expect(store.totalMs.value).toBe(2000);
      expect(store.playheadMs.value).toBe(2000);
    });
  });

  describe('clips', () => {
    it('splits at the playhead and selects the right-hand piece', () => {
      store.playheadMs.value = 1000;
      store.splitAtPlayhead();
      const [a, right, b] = store.manifest.value.clips;
      expect(clipIds().length).toBe(3);
      expect([a.id, a.inMs, a.outMs]).toEqual(['a', 0, 1000]);
      expect([right.clipKey, right.inMs, right.outMs]).toEqual(['a', 1000, 4000]);
      expect(b.id).toBe('b');
      expect(store.selection.value).toEqual({ kind: 'clip', id: right.id });
      expect(store.selectedClip.value).toBe(right);
      expect(store.canJoinSelected.value).toBe(false);

      store.select({ kind: 'clip', id: 'a' });
      expect(store.canJoinSelected.value).toBe(true);
    });

    it('splits the segment under the playhead in a later clip', () => {
      store.playheadMs.value = 4500;
      store.splitAtPlayhead();
      const clips = store.manifest.value.clips;
      expect(clips.map((c) => [c.clipKey, c.inMs, c.outMs])).toEqual([
        ['a', 0, 4000],
        ['b', 0, 500],
        ['b', 500, 2000],
      ]);
      expect(store.selection.value).toEqual({ kind: 'clip', id: clips[2].id });
    });

    it('explains a split too close to an edge and changes nothing', () => {
      store.playheadMs.value = 100;
      store.splitAtPlayhead();
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
      expect(store.selection.value).toBeNull();
      expect(store.toast.value?.text).toBe('Move the playhead further into the clip to split it');
    });
  });

  describe('text', () => {
    it('leaves no layer and no history when a new text is cancelled', () => {
      store.playheadMs.value = 3000;
      store.startNewText();
      const edit = store.textEdit.value;
      expect(edit?.isNew).toBe(true);
      expect(store.layerCount.value).toBe(1);
      expect(store.panel.value).toBe('text');
      expect(store.selection.value).toEqual({ kind: 'overlay', id: edit!.id });
      expect(store.manifest.value.overlays[0].startMs).toBe(3000);

      store.previewOverlay(edit!.id, { text: 'Hel' });
      store.cancelText();

      expect(store.manifest.value).toBe(base);
      expect(store.layerCount.value).toBe(0);
      expect(store.canUndo.value).toBe(false);
      expect(store.selection.value).toBeNull();
      expect(store.textEdit.value).toBeNull();
      expect(store.panel.value).toBeNull();
    });

    it('makes typing and styling a new text ONE undo step', () => {
      store.startNewText();
      const id = store.textEdit.value!.id;
      store.previewOverlay(id, { text: 'H' });
      store.previewOverlay(id, { text: 'Hi' });
      store.previewOverlay(id, { color: '#ff3b5c', styleId: 'neon' });
      store.finishText();

      const text = findOverlay(store.manifest.value, id) as TextOverlay;
      expect(text.text).toBe('Hi');
      expect(text.color).toBe('#ff3b5c');
      expect(text.styleId).toBe('neon');
      expect(store.textEdit.value).toBeNull();
      expect(store.panel.value).toBeNull();
      expect(store.selection.value).toEqual({ kind: 'overlay', id });

      expect(undoAll()).toBe(1);
      expect(store.manifest.value).toBe(base);
      expect(store.toast.value?.text).toBe('Undo: Add text');
      expect(store.selection.value).toBeNull();
    });

    it('starts a new text at 0 when the playhead is at the very end', () => {
      store.playheadMs.value = 5950;
      store.startNewText();
      expect(store.manifest.value.overlays[0].startMs).toBe(0);
      store.cancelText();
    });

    it('drops a new text left empty, without an undo step', () => {
      store.startNewText();
      store.previewOverlay(store.textEdit.value!.id, { text: '   ' });
      store.finishText();
      expect(store.layerCount.value).toBe(0);
      expect(store.selection.value).toBeNull();
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
    });

    it('still drops an empty new text after its gesture was closed by another change', () => {
      store.startNewText();
      const id = store.textEdit.value!.id;
      // A commit while the sheet is open closes the text gesture as its own step.
      store.toggleFit();
      store.finishText();
      expect(findOverlay(store.manifest.value, id)).toBeNull();
      expect(store.manifest.value.fit).toBe('cover');
      expect(store.textEdit.value).toBeNull();
      expect(undoAll()).toBe(3);
      expect(store.manifest.value).toBe(base);
    });

    it('deletes an existing text emptied by editing, as one undo step', () => {
      load({ overlays: [text('t1', 'Hello')] });
      store.startEditText('t1');
      expect(store.textEdit.value).toEqual({ id: 't1', isNew: false });
      store.previewOverlay('t1', { text: '' });
      store.finishText();
      expect(store.layerCount.value).toBe(0);
      expect(store.selection.value).toBeNull();

      expect(undoAll()).toBe(1);
      expect((findOverlay(store.manifest.value, 't1') as TextOverlay).text).toBe('Hello');
    });

    it('stays one undo step when a media change lands right after it, as the media service does', () => {
      // A picker's result arrives while a text is being typed. EditorMediaService finishes the text
      // first, so the layer lands as "Add text" and the media change is the step after it - rather
      // than the commit closing the open gesture and splitting Add text in two.
      store.startNewText();
      const id = store.textEdit.value!.id;
      store.previewOverlay(id, { text: 'Hi' });

      store.finishText();
      store.commit('Add clip', (m) => ({ ...m, fit: 'cover' }));

      expect(store.textEdit.value).toBeNull();
      store.undo();
      expect(store.manifest.value.fit).toBe('contain');
      expect((findOverlay(store.manifest.value, id) as TextOverlay).text).toBe('Hi');

      store.undo();
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
    });

    it('records nothing when an existing text is opened and closed unchanged', () => {
      load({ overlays: [text('s', 'Hi')] });
      store.startEditText('s');
      store.previewOverlay('s', { text: 'Hi' });
      store.finishText();
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
    });
  });

  describe('layers', () => {
    it('adds a layer from the playhead and selects it', () => {
      store.playheadMs.value = 2000;
      const id = store.addSticker({ assetId: 'heart' });
      const layer = findOverlay(store.manifest.value, id!) as StickerOverlay;
      expect([layer.startMs, layer.endMs, layer.assetId, layer.emoji]).toEqual([2000, 0, 'heart', null]);
      expect(store.selection.value).toEqual({ kind: 'overlay', id: id! });
      expect(store.canUndo.value).toBe(true);
    });

    it('refuses a layer past the cap and says why', () => {
      load({ overlays: Array.from({ length: MAX_LAYERS }, (_, i) => sticker(`s${i}`)) });
      expect(store.layersFull.value).toBe(true);
      expect(store.addSticker({ emoji: 'x' })).toBeNull();
      expect(store.addEffect('grain', 'Grain')).toBeNull();
      expect(store.toast.value?.text).toBe(`You can add up to ${MAX_LAYERS} layers`);
      expect(store.layerCount.value).toBe(MAX_LAYERS);
      expect(store.canUndo.value).toBe(false);

      store.startNewText();
      expect(store.textEdit.value).toBeNull();
      expect(store.panel.value).toBeNull();
      expect(store.layerCount.value).toBe(MAX_LAYERS);
    });

    it('moves the edge under the playhead with Start here / End here', () => {
      load({ overlays: [sticker('s', { startMs: 1000, endMs: 3000 })] });
      store.select({ kind: 'overlay', id: 's' });
      store.playheadMs.value = 1500;
      store.setSelectedOverlayEdge('start');
      store.playheadMs.value = 2500;
      store.setSelectedOverlayEdge('end');
      const layer = findOverlay(store.manifest.value, 's')!;
      expect([layer.startMs, layer.endMs]).toEqual([1500, 2500]);
    });

    it('moves the whole layer when the playhead is past its other edge', () => {
      load({ overlays: [sticker('s', { startMs: 1000, endMs: 2000 })] });
      store.select({ kind: 'overlay', id: 's' });
      store.playheadMs.value = 4000;
      store.setSelectedOverlayEdge('start');
      let layer = findOverlay(store.manifest.value, 's')!;
      expect([layer.startMs, layer.endMs]).toEqual([4000, 5000]);

      store.playheadMs.value = 3500;
      store.setSelectedOverlayEdge('end');
      layer = findOverlay(store.manifest.value, 's')!;
      expect([layer.startMs, layer.endMs]).toEqual([2500, 3500]);

      // Near the start of the video the length gives way, not the playhead.
      store.playheadMs.value = 400;
      store.setSelectedOverlayEdge('end');
      layer = findOverlay(store.manifest.value, 's')!;
      expect([layer.startMs, layer.endMs]).toEqual([0, 400]);
    });

    it('blames the cap, not the playhead, for a split refused at the cap', () => {
      load({ overlays: Array.from({ length: MAX_LAYERS }, (_, i) => sticker(`s${i}`)) });
      store.select({ kind: 'overlay', id: 's0' });
      store.playheadMs.value = 3000;
      store.splitSelectedOverlayAtPlayhead();
      expect(store.toast.value?.text).toBe(`You can add up to ${MAX_LAYERS} layers`);
      expect(store.layerCount.value).toBe(MAX_LAYERS);
      expect(store.canUndo.value).toBe(false);
    });
  });

  describe('setVolume', () => {
    beforeEach(() => {
      load({ music: MUSIC, voiceovers: [{ id: 'v1', uri: 'file:///v.m4a', startMs: 0, durationMs: 1000, volume: 1 }] });
    });

    it('sets a clip volume and mutes it at 0', () => {
      store.setVolume({ kind: 'clip', id: 'a' }, 0.4, false);
      expect(store.manifest.value.clips[0]).toEqual(clip('a', 0, 4000, { volume: 0.4 }));
      store.setVolume({ kind: 'clip', id: 'a' }, 0, false);
      expect(store.manifest.value.clips[0]).toEqual(clip('a', 0, 4000, { volume: 0, muted: true }));
      store.setVolume({ kind: 'clip', id: 'a' }, 1.7, false);
      expect(store.manifest.value.clips[0]).toEqual(clip('a', 0, 4000));
      expect(store.manifest.value.clips[1]).toBe(base.clips[1]);
      expect(undoAll()).toBe(3);
    });

    it('sets the music volume', () => {
      store.setVolume({ kind: 'music' }, 0.25, false);
      expect(store.manifest.value.music!.volume).toBe(0.25);
      expect(store.canUndo.value).toBe(true);
    });

    it('sets a voiceover volume', () => {
      store.setVolume({ kind: 'voice', id: 'v1' }, 0.3, false);
      expect(store.manifest.value.voiceovers[0].volume).toBe(0.3);
      store.setVolume({ kind: 'voice', id: 'nope' }, 0.3, false);
      expect(undoAll()).toBe(1);
    });

    it('switches the original sound from the timeline speaker, not from a volume target', () => {
      store.toggleOriginalMuted();
      expect(store.manifest.value.originalMuted).toBe(true);
      store.toggleOriginalMuted();
      expect(store.manifest.value.originalMuted).toBe(false);
      expect(undoAll()).toBe(2);
    });

    it('lands a live slider as one step', () => {
      store.beginGesture();
      store.setVolume({ kind: 'music' }, 0.5, true);
      store.setVolume({ kind: 'music' }, 0.1, true);
      store.endGesture('Volume');
      expect(store.manifest.value.music!.volume).toBe(0.1);
      expect(undoAll()).toBe(1);
      expect(store.manifest.value.music!.volume).toBe(0.6);
    });

    it('does nothing for music that is not there', () => {
      load();
      store.setVolume({ kind: 'music' }, 0.5, false);
      expect(store.manifest.value).toBe(base);
      expect(store.canUndo.value).toBe(false);
    });
  });

  describe('deleteSelection', () => {
    it('does nothing with nothing selected', () => {
      store.deleteSelection();
      expect(store.manifest.value).toBe(base);
    });

    it('deletes a clip, but never the last one', () => {
      store.select({ kind: 'clip', id: 'a' });
      store.deleteSelection();
      expect(clipIds()).toEqual(['b']);
      expect(store.selection.value).toBeNull();

      store.select({ kind: 'clip', id: 'b' });
      store.deleteSelection();
      expect(clipIds()).toEqual(['b']);
      expect(store.selection.value).toEqual({ kind: 'clip', id: 'b' });
      expect(store.toast.value?.text).toBe('A video needs at least one clip');
      expect(undoAll()).toBe(1);
    });

    it('deletes a layer', () => {
      load({ overlays: [sticker('s1'), sticker('s2')] });
      store.select({ kind: 'overlay', id: 's1' });
      store.deleteSelection();
      expect(store.manifest.value.overlays.map((o) => o.id)).toEqual(['s2']);
      expect(store.selection.value).toBeNull();
    });

    it('removes the music', () => {
      load({ music: MUSIC });
      store.select({ kind: 'music' });
      expect(store.musicSelected.value).toBe(true);
      store.deleteSelection();
      expect(store.manifest.value.music).toBeNull();
      expect(store.selection.value).toBeNull();
    });

    it('deletes a voiceover', () => {
      load({ voiceovers: [{ id: 'v1', uri: 'u', startMs: 0, durationMs: 1000, volume: 1 }] });
      store.select({ kind: 'voice', id: 'v1' });
      expect(store.selectedVoice.value?.id).toBe('v1');
      store.deleteSelection();
      expect(store.manifest.value.voiceovers).toEqual([]);
      expect(store.selection.value).toBeNull();
    });
  });

  describe('the second video layer', () => {
    describe('previewLayers', () => {
      it('is the one layer the preview has always drawn when there is no second video', () => {
        store.seek(1000);
        expect(store.previewLayers.value).toEqual([
          { trackId: null, clipId: 'a', clipKey: 'a', sourceMs: 1000, rect: null, crop: null, fit: 'contain', opacity: 1, z: 0 },
        ]);
      });

      it('is empty with no clips at all, and follows a trim and a speed into the source', () => {
        store.load([], new Map(), emptyManifest());
        expect(store.previewLayers.value).toEqual([]);

        load({ clips: [clip('a', 500, 4000, { speed: 2 })] });
        store.seek(1000);
        expect(store.previewLayers.value[0].sourceMs).toBe(2500);
      });

      it('puts the layers bottom to top by z, each in its own source', () => {
        load({ videoTracks: [track([clip('c', 0, 3000)], { startMs: 1000, opacity: 0.5 })] });
        store.seek(2000);

        expect(store.previewLayers.value).toEqual([
          { trackId: null, clipId: 'a', clipKey: 'a', sourceMs: 2000, rect: null, crop: null, fit: 'contain', opacity: 1, z: 0 },
          { trackId: 'vt', clipId: 'c', clipKey: 'c', sourceMs: 1000, rect: null, crop: null, fit: 'contain', opacity: 0.5, z: 1 },
        ]);
      });

      it('carries each clip its own framing, and the post\'s fit for a clip without one', () => {
        const crop = { x: 0.1, y: 0.1, w: 0.5, h: 0.5 };
        const rect = { x: 0, y: 0.5, w: 1, h: 0.5 };
        load({
          fit: 'cover',
          clips: [clip('a', 0, 4000, { rect: { x: 0, y: 0, w: 1, h: 0.5 } })],
          videoTracks: [track([clip('c', 0, 3000, { crop, rect, fit: 'contain' })])],
        });
        store.seek(0);

        const [base, extra] = store.previewLayers.value;
        expect(base.rect).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
        expect(base.crop).toBeNull();
        expect(base.fit).toBe('cover');
        expect(extra.crop).toEqual(crop);
        expect(extra.fit).toBe('contain');
      });

      it('contributes nothing at all before the layer starts', () => {
        load({ videoTracks: [track([clip('c', 0, 3000)], { startMs: 400 })] });
        store.seek(399);
        expect(store.previewLayers.value.length).toBe(1);
        store.seek(400);
        expect(store.previewLayers.value.map((layer) => layer.trackId)).toEqual([null, 'vt']);
      });

      it('leaves the base showing once the layer has ended', () => {
        load({ videoTracks: [track([clip('c', 0, 1000)])] });
        store.seek(999);
        expect(store.previewLayers.value.length).toBe(2);
        store.seek(1000);
        expect(store.previewLayers.value.map((layer) => layer.trackId)).toEqual([null]);
      });

      it('cuts a layer that runs past the base, and holds one that ends with it on the last frame', () => {
        load({ videoTracks: [track([clip('c', 0, 4000)], { startMs: 5000 })] });
        store.seek(6000);

        const layers = store.previewLayers.value;
        expect(layers.length).toBe(2);
        // A second of the layer is all that fits before the post ends, and the last frame is that
        // second's last rather than the clip's.
        expect(layers[1].sourceMs).toBe(1000);
      });
    });

    describe('the actions', () => {
      it('adds a layer and selects its clip', () => {
        const id = store.addVideoTrack(clip('c', 0, 3000));

        expect(id).toBeTruthy();
        expect(store.videoTrack.value?.clips.map((c) => c.id)).toEqual(['c']);
        expect(store.videoTracksFull.value).toBe(false);
        expect(store.selection.value).toEqual({ kind: 'clip', id: 'c' });
        expect(store.selectedClipTrackId.value).toBe(id);
        expect(store.dirty.value).toBe(true);
        expect(undoAll()).toBe(1);
      });

      it('refuses the layer that would go past the cap, and says so', () => {
        // Counted from MAX_VIDEO_TRACKS rather than written out, because the number is a ceiling on
        // absurdity and is expected to move again; what this test is about is the refusal.
        const room = MAX_VIDEO_TRACKS - 1;
        for (let i = 0; i < room; i++) expect(store.addVideoTrack(clip(`c${i}`, 0, 3000))).toBeTruthy();

        expect(store.videoTracksFull.value).toBe(true);
        expect(store.addVideoTrack(clip('over', 0, 1000))).toBeNull();
        expect(store.manifest.value.videoTracks.length).toBe(room);
        expect(store.toast.value?.text).toBe(`You can have ${MAX_VIDEO_TRACKS} videos on screen at once`);
        // Every layer that was accepted is a step of its own, and the refusal is not a step at all.
        expect(undoAll()).toBe(room);
      });

      it('stacks each new layer over the one before it', () => {
        store.addVideoTrack(clip('c', 0, 3000));
        store.addVideoTrack(clip('d', 0, 3000));

        expect(store.manifest.value.videoTracks.map((t) => t.z)).toEqual([1, 2]);
      });

      it('lays the two out, and takes the arrangement away with the layer', () => {
        const id = store.addVideoTrack(clip('c', 0, 3000))!;
        store.applyLayoutPreset(id, 'splitTopBottom', 'Top and bottom');
        expect(store.manifest.value.clips[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });

        store.removeVideoTrack(id);
        expect(store.manifest.value.videoTracks).toEqual([]);
        // Not "rect is undefined": the key has to be gone, or every engine loses the path it takes
        // for a post nobody has framed.
        expect(store.manifest.value.clips.every((c) => !('rect' in c))).toBe(true);
        expect(store.selection.value).toBeNull();
        // Add, lay out, remove - and the remove took the layout with it in the one step.
        expect(undoAll()).toBe(3);
      });

      it('moves and fades the layer, one undo step each', () => {
        load({ videoTracks: [track([clip('c', 0, 3000)])] });
        store.setTrackStart('vt', 1500);
        store.setTrackOpacity('vt', 0.4);

        expect(store.videoTrack.value).toMatchObject({ startMs: 1500, opacity: 0.4 });
        expect(undoAll()).toBe(2);
      });

      it('swaps the layers, and says so when the post changes length with them', () => {
        load({ videoTracks: [track([clip('c', 0, 3000)])] });
        store.seek(6000);
        store.swapTrackZ('vt');

        expect(store.manifest.value.clips.map((c) => c.id)).toEqual(['c']);
        expect(store.videoTrack.value?.clips.map((c) => c.id)).toEqual(['a', 'b']);
        expect(store.totalMs.value).toBe(3000);
        // The playhead was past the end of what the post has just become.
        expect(store.playheadMs.value).toBe(3000);
        expect(store.toast.value?.text).toBe('Your video is now 3.0s');
      });

      it('carries a segment onto a layer of its own, and back', () => {
        store.select({ kind: 'clip', id: 'b' });
        expect(store.moveClipToTrack('b', { kind: 'new', index: 0 }, 2000)).toBe(true);

        expect(store.manifest.value.clips.map((c) => c.id)).toEqual(['a']);
        expect(store.videoTrack.value).toMatchObject({ startMs: 2000, z: 1 });
        // The segment stays selected: the customer put it somewhere and the tools have to follow it.
        expect(store.selection.value).toEqual({ kind: 'clip', id: 'b' });

        expect(store.moveClipToTrack('b', { kind: 'base' }, 0)).toBe(true);
        expect(store.manifest.value.clips.map((c) => c.id)).toEqual(['b', 'a']);
        expect(store.manifest.value.videoTracks).toEqual([]);
        // One undo step each, and nothing else in between.
        expect(undoAll()).toBe(2);
      });

      it('refuses to empty the base track, and says why', () => {
        load({ clips: [clip('a', 0, 4000)] });

        expect(store.moveClipToTrack('a', { kind: 'new', index: 0 }, 0)).toBe(false);
        expect(store.toast.value?.text).toBe('A video needs at least one clip');
        expect(undoAll()).toBe(0);
      });

      it('refuses a layer past the cap, and says so', () => {
        const room = MAX_VIDEO_TRACKS - 1;
        for (let i = 0; i < room; i++) store.addVideoTrack(clip(`c${i}`, 0, 3000));

        expect(store.moveClipToTrack('b', { kind: 'new', index: 0 }, 0)).toBe(false);
        expect(store.toast.value?.text).toBe(`You can have ${MAX_VIDEO_TRACKS} videos on screen at once`);
      });

      it('deletes one segment of a layer that holds several', () => {
        load({ videoTracks: [track([clip('c', 0, 3000), clip('d', 0, 3000)])] });
        store.select({ kind: 'clip', id: 'c' });

        store.deleteSelectedClip();

        // The layer stays: only the segment the customer had selected has gone.
        expect(store.videoTrack.value?.clips.map((c) => c.id)).toEqual(['d']);
      });

      it('takes the layer and its arrangement off with its last segment', () => {
        load({ videoTracks: [track([clip('c', 0, 3000)])] });
        store.applyLayoutPreset('vt', 'splitTopBottom', 'Top and bottom');
        store.select({ kind: 'clip', id: 'c' });

        store.deleteSelectedClip();

        expect(store.manifest.value.videoTracks).toEqual([]);
        // A base left in half the frame with nothing beside it is a black band nobody asked for.
        expect(store.manifest.value.clips.every((c) => !('rect' in c))).toBe(true);
      });
    });
  });

  it('never throws for haptics on a host that has none', () => {
    for (const kind of ['light', 'medium', 'selection', 'success', 'warning'] as const) {
      expect(() => store.haptic(kind)).not.toThrow();
    }
  });
});
