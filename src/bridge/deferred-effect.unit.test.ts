import { effect, signal } from '@preact/signals-core';
import { describe, expect, it, vi } from 'vitest';

import { emptyManifest, removeOverlay, type EditClip, type EditManifest, type StickerOverlay } from '../editor';
import { resolveEditorHost } from '../host/defaults';
import type { EditorSource } from '../host/host.types';
import { EditorStore } from '../state/editor-store';
import { closeWhenGone, deferredEffect } from './deferred-effect';

/**
 * Lets everything already queued run. The resolve is queued behind whatever the code under test
 * queued, and awaiting it costs another turn, so a run scheduled by a run has landed too.
 */
const settle = (): Promise<void> => new Promise((resolve) => queueMicrotask(resolve));

function clip(id: string, outMs: number): EditClip {
  return { id, clipKey: id, inMs: 0, outMs, speed: 1, volume: 1, muted: false };
}

function sticker(id: string): StickerOverlay {
  return { id, kind: 'sticker', emoji: 'x', assetId: null, cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 4000 };
}

const SOURCES: EditorSource[] = [{ key: 'a', fileName: 'a.mp4' }];

/** A store holding one four second clip, which is as much of an edit as history needs. */
function openStore(extra: Partial<EditManifest> = {}): EditorStore {
  const store = new EditorStore(resolveEditorHost());
  store.load(SOURCES, new Map([['a', 4000]]), { ...emptyManifest(), clips: [clip('a', 4000)], ...extra });
  return store;
}

describe('deferredEffect', () => {
  it('reads its dependencies at once and does the work on the next microtask', async () => {
    const name = signal('a');
    const run = vi.fn();

    const stop = deferredEffect(() => name.value, run);
    expect(run).not.toHaveBeenCalled();

    // Angular ran a constructor effect once after the first change detection pass, so the opening
    // run is part of the contract and not a leftover.
    await settle();
    expect(run).toHaveBeenCalledExactlyOnceWith('a');

    stop();
  });

  it('runs once for a burst of writes, on the value the last of them left', async () => {
    const a = signal(1);
    const b = signal(2);
    const c = signal(3);
    const deps = vi.fn(() => a.value + b.value + c.value);
    const run = vi.fn();

    const stop = deferredEffect(deps, run);
    await settle();
    deps.mockClear();
    run.mockClear();

    a.value = 10;
    b.value = 20;
    c.value = 30;
    expect(deps).toHaveBeenCalledTimes(3);
    expect(run).not.toHaveBeenCalled();

    await settle();
    expect(run).toHaveBeenCalledExactlyOnceWith(60);

    stop();
  });

  it('does not depend on what the work reads, only on what the dependencies read', async () => {
    const watched = signal(0);
    const ignored = signal(0);
    const run = vi.fn(() => {
      ignored.value;
    });

    const stop = deferredEffect(() => watched.value, run);
    await settle();
    run.mockClear();

    // A microtask carries no effect context, so the work may read the whole store without widening
    // the dependencies. That is what makes an `untracked()` call inside a `run` body redundant.
    ignored.value = 1;
    await settle();
    expect(run).not.toHaveBeenCalled();

    watched.value = 1;
    await settle();
    expect(run).toHaveBeenCalledTimes(1);

    stop();
  });

  it('queues a fresh run for a write the work makes itself', async () => {
    const count = signal(0);
    const seen: number[] = [];
    const stop = deferredEffect(
      () => count.value,
      (value) => {
        seen.push(value);
        if (value === 0) count.value = 1;
      },
    );

    await settle();
    await settle();
    expect(seen).toEqual([0, 1]);

    stop();
  });

  it('drops a queued run once it has been disposed', async () => {
    const name = signal('a');
    const run = vi.fn();
    const stop = deferredEffect(() => name.value, run);

    stop();
    await settle();
    expect(run).not.toHaveBeenCalled();

    // Nothing is watched any more either, which is what keeps a sheet unmounted mid drag from
    // reaching the store it no longer belongs to.
    name.value = 'b';
    await settle();
    expect(run).not.toHaveBeenCalled();
  });

  it('is safe to dispose twice, which is what a double disconnect does', () => {
    const stop = deferredEffect(() => 1, vi.fn());
    stop();
    expect(() => stop()).not.toThrow();
  });

  it('never sees the store part way through a commit', async () => {
    const store = openStore();
    const plain: Array<{ canUndo: boolean; fit: string }> = [];
    const deferred: Array<{ canUndo: boolean; fit: string }> = [];
    const look = () => ({ canUndo: store.canUndo.value, fit: store.manifest.value.fit });

    const stopPlain = effect(() => {
      plain.push(look());
    });
    const stop = deferredEffect(look, (state) => {
      deferred.push(state);
    });
    await settle();
    plain.length = 0;
    deferred.length = 0;

    store.commit('Fill frame', (m) => ({ ...m, fit: 'cover' }));

    // `commit` pushes the history entry before it writes the manifest, so a plain effect runs twice
    // and the first of the two is a store contradicting itself: an undo step for a change that has
    // not been made yet. A body acting on that reads the manifest it was meant to replace.
    expect(plain).toEqual([
      { canUndo: true, fit: 'contain' },
      { canUndo: true, fit: 'cover' },
    ]);
    expect(deferred).toEqual([]);

    await settle();
    expect(deferred).toEqual([{ canUndo: true, fit: 'cover' }]);

    stopPlain();
    stop();
  });

  it('leaves a gesture as the one undo step it is', async () => {
    const store = openStore();
    // The shape a sheet's effect has: read the manifest, change something else because of what it
    // says. Guarded so it settles, since a body writing what it reads runs again on its own write.
    const stop = deferredEffect(
      () => store.manifest.value.fit,
      (fit) => {
        if (fit === 'cover') store.commit('Original sound off', (m) => (m.originalMuted ? m : { ...m, originalMuted: true }));
      },
    );
    await settle();

    store.beginGesture();
    store.preview((m) => ({ ...m, fit: 'cover' }));
    store.endGesture('Fill frame');
    await settle();
    stop();

    // Two steps, the drag's own and the one the body made, in the order they happened.
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Original sound off');
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Fill frame');
    expect(store.canUndo.value).toBe(false);
  });

  it('is the difference between that and a drag landing under a name nobody chose', async () => {
    const store = openStore();
    const stopPlain = effect(() => {
      if (store.manifest.value.fit === 'cover') {
        store.commit('Original sound off', (m) => (m.originalMuted ? m : { ...m, originalMuted: true }));
      }
    });

    store.beginGesture();
    store.preview((m) => ({ ...m, fit: 'cover' }));
    store.endGesture('Fill frame');
    stopPlain();

    // The body ran inside `preview`, so `commit` reached `flushGesture` with the finger still down:
    // the drag was closed early under the store's fallback label and `endGesture` was left with
    // nothing to record. This is the regression the microtask exists to prevent.
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Original sound off');
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Change');
    expect(store.canUndo.value).toBe(false);
  });
});

describe('closeWhenGone', () => {
  it('leaves the panel alone while the layer is still there', async () => {
    const store = openStore({ overlays: [sticker('st1')] });
    store.selection.value = { kind: 'overlay', id: 'st1' };
    store.openPanel('opacity');

    const stop = closeWhenGone(
      () => !store.selectedOverlay.value,
      () => store.closePanel(),
    );
    await settle();
    expect(store.panel.value).toBe('opacity');

    store.commitOverlay('st1', { opacity: 0.4 }, 'Opacity');
    await settle();
    expect(store.panel.value).toBe('opacity');

    stop();
  });

  it('closes a microtask after the layer goes, not inside the change that removed it', async () => {
    const store = openStore({ overlays: [sticker('st1')] });
    store.selection.value = { kind: 'overlay', id: 'st1' };
    store.openPanel('opacity');
    const stop = closeWhenGone(
      () => !store.selectedOverlay.value,
      () => store.closePanel(),
    );
    await settle();

    store.commit('Delete', (m) => removeOverlay(m, 'st1'));
    // Still open, because a sheet must not take itself off the screen from inside the store's own
    // write, which is what unmounting a component from inside its effect body comes to.
    expect(store.panel.value).toBe('opacity');

    await settle();
    expect(store.panel.value).toBe(null);

    stop();
  });

  it('closes a sheet mounted for something that is already missing', async () => {
    const store = openStore();
    store.openPanel('opacity');

    const stop = closeWhenGone(
      () => !store.selectedOverlay.value,
      () => store.closePanel(),
    );
    expect(store.panel.value).toBe('opacity');

    await settle();
    expect(store.panel.value).toBe(null);

    stop();
  });

  it('stops for good when the close disposes it, which is what unmounting does', async () => {
    const gone = signal(true);
    const close = vi.fn(() => {
      stop();
    });
    const stop = closeWhenGone(() => gone.value, close);

    await settle();
    expect(close).toHaveBeenCalledTimes(1);

    gone.value = false;
    gone.value = true;
    await settle();
    expect(close).toHaveBeenCalledTimes(1);
  });
});
