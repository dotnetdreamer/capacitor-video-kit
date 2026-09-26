import { beforeEach, describe, expect, it } from 'vitest';
import { emptyManifest, type EditClip, type EditManifest, type EditOverlay } from '../editor';

import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { EditorStore } from './editor-store';

/*
 * The store's animation actions are the contract the animation sheet codes against: a tile puts a
 * preset on one part at the preset's own length, None takes that part off and leaves the others, the
 * slider sets a length live, the whole visit is ONE undo step, and every choice plays its move on the
 * frame from where it shows. No player is attached here, so a seek is exactly where the playhead goes
 * and a play goes nowhere - which is what lets an audition's first seek be read back.
 */

function clip(id: string, inMs: number, outMs: number): EditClip {
  return { id, clipKey: id, inMs, outMs, speed: 1, volume: 1, muted: false };
}

function sticker(over: Partial<EditOverlay> = {}): EditOverlay {
  return {
    id: 'st',
    kind: 'sticker',
    emoji: '🍕',
    assetId: null,
    cx: 0.5,
    cy: 0.5,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 2000,
    endMs: 6000,
    ...over,
  } as EditOverlay;
}

describe('EditorStore animation', () => {
  let store: EditorStore;
  const sources: EditorSource[] = [{ key: 'a', fileName: 'a.mp4' }];

  function load(overlays: EditOverlay[] = [sticker()]): void {
    const base: EditManifest = { ...emptyManifest(), clips: [clip('a', 0, 10_000)], overlays };
    store.load(sources, new Map([['a', 10_000]]), base);
  }

  const layer = () => store.manifest.value.overlays[0];

  /** Opens the sheet the way the tool row does: on the selected layer. */
  function open(id = 'st'): void {
    store.select({ kind: 'overlay', id });
    store.openAnimation();
  }

  beforeEach(() => {
    store = new EditorStore(resolveEditorHost());
    load();
  });

  it('opens on the selected layer, and puts the playhead on it when it is not on screen', () => {
    store.seek(8000);
    open();
    expect(store.panel.value).toBe('animation');
    expect(store.playheadMs.value).toBe(2000);

    // Already on screen: the playhead is the customer's and stays where it is.
    store.closePanel();
    store.seek(4500);
    open();
    expect(store.playheadMs.value).toBe(4500);
  });

  it('puts a preset on a part at the preset’s own length, and plays the move from just before it', () => {
    open();
    store.chooseAnimation('in', 'pop');
    expect(layer().animation).toEqual({ in: { id: 'pop', durationMs: 470 } });
    // The audition starts a moment before the layer arrives.
    expect(store.playheadMs.value).toBe(1700);

    store.chooseAnimation('loop', 'beat');
    expect(layer().animation).toEqual({ in: { id: 'pop', durationMs: 470 }, loop: { id: 'beat', periodMs: 500 } });
    // A loop plays from where it starts, which is where the in lands.
    expect(store.playheadMs.value).toBe(2470);

    store.chooseAnimation('out', 'sink');
    expect(layer().animation?.out).toEqual({ id: 'sink', durationMs: 400 });
    // An out from a moment before it starts to leave: 6000 - 400 - 300.
    expect(store.playheadMs.value).toBe(5300);
  });

  it('gives a new preset its own length, and keeps the length of the one the part already has', () => {
    open();
    store.chooseAnimation('in', 'pop');
    store.setAnimationMs('in', 1200);
    expect(layer().animation?.in).toEqual({ id: 'pop', durationMs: 1200 });

    // Tapped again, it plays again and changes nothing.
    const before = store.manifest.value;
    store.chooseAnimation('in', 'pop');
    expect(store.manifest.value).toBe(before);

    // Another preset starts at its own, not at the pop's 1200: a stamp is a stamp at 200 ms.
    store.chooseAnimation('in', 'stamp');
    expect(layer().animation?.in).toEqual({ id: 'stamp', durationMs: 200 });
  });

  it('takes one part off with None, and the key with the last one', () => {
    load([sticker({ animation: { in: { id: 'fade', durationMs: 500 }, loop: { id: 'pulse', periodMs: 1000 } } })]);
    open();
    store.removeAnimation('in');
    expect(layer().animation).toEqual({ loop: { id: 'pulse', periodMs: 1000 } });
    store.removeAnimation('loop');
    expect('animation' in layer()).toBe(false);
    // Nothing left to take: no step, no change.
    const before = store.manifest.value;
    store.removeAnimation('out');
    expect(store.manifest.value).toBe(before);
  });

  it('is one undo step for everything done in one visit, slider drags included', () => {
    open();
    store.chooseAnimation('in', 'slam');
    store.chooseAnimation('in', 'drop');
    // A drag, as the slider drives it: a gesture of live values.
    store.beginGesture();
    store.setAnimationMs('in', 900, true);
    store.setAnimationMs('in', 1100, true);
    store.endGesture('Animation duration');
    store.chooseAnimation('loop', 'float');
    expect(layer().animation).toEqual({ in: { id: 'drop', durationMs: 1100 }, loop: { id: 'float', periodMs: 1500 } });

    store.closePanel();
    store.undo();
    expect('animation' in layer()).toBe(false);
    expect(store.canUndo.value).toBe(false);
    expect(store.toast.value?.text).toBe('Undo: Animation');
  });

  it('makes a step of its own for anything done after the sheet has closed', () => {
    open();
    store.chooseAnimation('in', 'fade');
    store.closePanel();
    store.select({ kind: 'overlay', id: 'st' });
    store.openAnimation();
    store.chooseAnimation('out', 'fade');

    store.undo();
    expect(layer().animation).toEqual({ in: { id: 'fade', durationMs: 500 } });
    store.undo();
    expect('animation' in layer()).toBe(false);
  });

  it('holds the lengths to the ranges the engines take', () => {
    open();
    store.chooseAnimation('in', 'fade');
    store.setAnimationMs('in', 5);
    expect(layer().animation?.in?.durationMs).toBe(100);
    store.chooseAnimation('loop', 'spin');
    store.setAnimationMs('loop', 99_000);
    expect(layer().animation?.loop?.periodMs).toBe(4000);
    // A length on a part the layer does not have is nothing to set.
    const before = store.manifest.value;
    store.setAnimationMs('out', 700);
    expect(store.manifest.value).toBe(before);
  });

  it('closes when another thing is selected, and when undo takes the layer away', () => {
    load([sticker(), sticker({ id: 'st-2' })]);
    open();
    store.select({ kind: 'overlay', id: 'st-2' });
    expect(store.panel.value).toBeNull();

    // A layer added and then animated: the first undo takes the moves back, the second the layer,
    // and the sheet goes with it.
    const id = store.addSticker({ emoji: '🔥' })!;
    store.openAnimation();
    store.chooseAnimation('in', 'pop');
    expect(store.manifest.value.overlays.find(o => o.id === id)?.animation?.in?.id).toBe('pop');
    store.undo();
    expect(store.panel.value).toBe('animation');
    store.undo();
    expect(store.manifest.value.overlays.find(o => o.id === id)).toBeUndefined();
    expect(store.panel.value).toBeNull();
  });

  it('leaves a new text started over it its own gesture, so Cancel still leaves no trace', () => {
    open();
    store.chooseAnimation('in', 'pop');
    // The text sheet opening over this one, with the new layer already in its gesture.
    store.startNewText();
    expect(store.panel.value).toBe('text');
    store.cancelText();
    expect(store.manifest.value.overlays).toHaveLength(1);
    // And nothing between the animation and the start: one undo takes the visit back, and that is all.
    store.undo();
    expect('animation' in layer()).toBe(false);
    expect(store.canUndo.value).toBe(false);
  });

  it('refuses an id the catalogue does not have', () => {
    open();
    const before = store.manifest.value;
    store.chooseAnimation('in', 'teleport');
    expect(store.manifest.value).toBe(before);
  });
});
