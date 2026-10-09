import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { SOUND_EFFECTS, emptyManifest, findAudioClip, type EditAudioClip, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';
import type { EditorSelection } from '../../state/editor.types';

import { SOUND_EFFECT_ICONS } from './effect-icons';

/*
 * The Audio effects sheet in a browser: the tiles a finger taps, the head's "none", and what each
 * leaves in the manifest and the history. What the effect does to the sound is
 * `sound-effects.unit.test.ts`'s; this is the sheet a customer chooses it on.
 */

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/** A twenty-second post with an older edit's one sound and two sounds on a lane. */
function withSounds(): EditManifest {
  const sound = (id: string, startMs: number): EditAudioClip => ({
    id,
    uri: `file:///${id}.m4a`,
    fileName: `${id}.m4a`,
    sourceDurationMs: 4000,
    inMs: 0,
    outMs: 0,
    startMs,
    endMs: 0,
    volume: 0.8,
    loop: false,
    fadeOutMs: 0,
  });
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-0', clipKey: 'clip-a', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false }],
    durationMs: 20_000,
    music: sound('old', 0),
    audioTracks: [{ id: 'lane', clips: [sound('line', 0), sound('next', 9000)] }],
  };
}

/** The sheet with `selection` selected, as the sound rows' Effects tile leaves it. */
async function mount(selection: EditorSelection | null): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), withSounds());
  // Selected first: `select` closes an open panel, because a sheet about the old sound says nothing
  // about the new one.
  if (selection) store.select(selection);
  store.openPanel('audioEffects');

  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);
  const sheet = document.createElement('ve-audio-effects-sheet');
  Object.assign(sheet, { ctx });
  column.append(sheet);
  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  return { store, sheet };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function tiles(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.afx__tile') ?? [])];
}

function tile(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = tiles(sheet).find(button => button.textContent === label);
  if (!found) throw new Error(`no ${label} tile`);
  return found;
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
});

describe('ve-audio-effects-sheet', () => {
  const lineOf = (store: EditorStore) => findAudioClip(store.manifest.value, 'line');

  it('offers every effect as a tile with a sign of its own', async () => {
    const { sheet } = await mount({ kind: 'audio', id: 'line' });
    expect(head(sheet, '.sheet__title')?.textContent).toBe('Audio effects');
    expect(tiles(sheet).map(button => button.textContent)).toEqual(SOUND_EFFECTS.map(preset => preset.label));
    for (const preset of SOUND_EFFECTS) expect(SOUND_EFFECT_ICONS[preset.id]).toBeDefined();
    expect(tiles(sheet).every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('puts the selected sound through the effect tapped, in one undo step named for it', async () => {
    const { store, sheet } = await mount({ kind: 'audio', id: 'line' });

    tile(sheet, 'Megaphone').click();
    expect(lineOf(store)?.effect).toBe('megaphone');
    // That sound alone, and still selected.
    expect(findAudioClip(store.manifest.value, 'next')).not.toHaveProperty('effect');
    expect(store.manifest.value.music).not.toHaveProperty('effect');
    expect(store.selection.value).toEqual({ kind: 'audio', id: 'line' });
    await until('the tile to show it', () => tile(sheet, 'Megaphone').getAttribute('aria-pressed') === 'true');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Megaphone');
    expect(lineOf(store)).not.toHaveProperty('effect');
  });

  it('takes the effect off with the head’s none, named as Loop off is', async () => {
    const { store, sheet } = await mount({ kind: 'audio', id: 'line' });
    tile(sheet, 'Megaphone').click();

    const none = head(sheet, '[aria-label="No effect"]');
    expect(none).not.toBe(null);
    none!.click();
    expect(lineOf(store)).not.toHaveProperty('effect');
    await until('the tile to let go', () => tile(sheet, 'Megaphone').getAttribute('aria-pressed') === 'false');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Effect off');
    expect(lineOf(store)?.effect).toBe('megaphone');
  });

  it('records nothing for the effect the sound already has, or for none on a sound with none', async () => {
    const { store, sheet } = await mount({ kind: 'audio', id: 'line' });
    head(sheet, '[aria-label="No effect"]')!.click();
    expect(store.canUndo.value).toBe(false);

    tile(sheet, 'Megaphone').click();
    tile(sheet, 'Megaphone').click();
    store.undo();
    expect(store.canUndo.value).toBe(false);
  });

  it('works on an older edit’s one sound too', async () => {
    const { store, sheet } = await mount({ kind: 'music' });
    tile(sheet, 'Megaphone').click();
    expect(store.manifest.value.music?.effect).toBe('megaphone');
    expect(lineOf(store)).not.toHaveProperty('effect');
  });

  it('asks for a sound rather than offering effects for nothing', async () => {
    const { sheet } = await mount(null);
    expect(sheet.shadowRoot?.querySelector('.afx__empty')?.textContent).toBe('Select a sound first');
    expect(tiles(sheet)).toHaveLength(0);
    expect(head(sheet, '[aria-label="No effect"]')).toBe(null);
  });

  it('closes the panel on the frame’s tick', async () => {
    const { store, sheet } = await mount({ kind: 'audio', id: 'line' });
    head(sheet, '[aria-label="Done"]')!.click();
    expect(store.panel.value).toBe(null);
  });
});
