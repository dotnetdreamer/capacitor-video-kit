import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { SOUND_EFFECTS, emptyManifest, findAudioClip, type EditAudioClip, type EditAudioEffect, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

import { SOUND_EFFECT_ICONS } from './effect-icons';

/*
 * The Audio effects sheet in a browser: the tiles a finger taps, the head's "none", the sliders, and
 * what each leaves in the manifest and the history - a layer added, changed, taken away. What the
 * effect does to the sound is `audio-effect-windows.unit.test.ts`'s; this is the sheet a customer
 * chooses it on.
 */

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/** A twenty-second post with two sounds on a lane, and `layers` over them. */
function withSounds(layers: EditAudioEffect[] = []): EditManifest {
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
    audioTracks: [{ id: 'lane', clips: [sound('line', 0), sound('next', 9000)] }],
    ...(layers.length ? { audioEffects: layers } : {}),
  };
}

/** The sheet over a post with `layers`, the one `selected` selected and the playhead at `atMs`. */
async function mount(layers: EditAudioEffect[] = [], selected: string | null = null, atMs = 0): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), withSounds(layers));
  store.playheadMs.value = atMs;
  // Selected first: `select` closes the sheet unless a layer is what is selected.
  if (selected) store.select({ kind: 'audioEffect', id: selected });
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

/** The words beside the sheet's sliders, top to bottom, and the numbers at their ends. */
function controls(sheet: HTMLElement): { labels: string[]; values: string[] } {
  const rows = [...(sheet.shadowRoot?.querySelectorAll<HTMLElement>('.afx__control') ?? [])];
  return {
    labels: rows.map(row => row.querySelector('.afx__control-label')?.textContent ?? ''),
    values: rows.map(row => row.querySelector('.afx__control-value')?.textContent ?? ''),
  };
}

/** The slider in the row whose word is `label`. */
function sliderFor(sheet: HTMLElement, label: string): HTMLElement {
  const row = [...(sheet.shadowRoot?.querySelectorAll<HTMLElement>('.afx__control') ?? [])].find(
    one => one.querySelector('.afx__control-label')?.textContent === label,
  );
  const slider = row?.querySelector<HTMLElement>('ve-slider');
  if (!slider) throw new Error(`no ${label} slider`);
  return slider;
}

let pointerId = 0;

/**
 * One whole drag along a slider's bar, from `from` to `to` in its own units, exactly as a finger does
 * it - pressed on the knob, moved, lifted - which is one gesture and so one undo step.
 */
async function drag(sheet: HTMLElement, label: string, from: number, to: number): Promise<void> {
  const slider = sliderFor(sheet, label) as HTMLElement & { componentOnReady?: () => Promise<unknown>; min: number; max: number };
  await slider.componentOnReady?.();
  const bar = slider.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
  const at = (value: number) => bar.left + ((value - slider.min) / (slider.max - slider.min)) * bar.width;
  pointerId += 1;
  for (const [type, x] of [
    ['pointerdown', at(from)],
    ['pointermove', at(to)],
    ['pointerup', at(to)],
  ] as const) {
    slider.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX: x, bubbles: true }));
  }
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
  const layersOf = (store: EditorStore) => store.manifest.value.audioEffects ?? [];
  const megaphone = (over: Partial<EditAudioEffect> = {}): EditAudioEffect => ({ id: 'afx', startMs: 1000, endMs: 6000, effect: 'megaphone', ...over });

  it('offers every effect as a tile with a sign of its own, and says what one does', async () => {
    const { sheet } = await mount();
    expect(head(sheet, '.sheet__title')?.textContent).toBe('Audio effects');
    expect(tiles(sheet).map(button => button.textContent)).toEqual(SOUND_EFFECTS.map(preset => preset.label));
    for (const preset of SOUND_EFFECTS) expect(SOUND_EFFECT_ICONS[preset.id]).toBeDefined();
    expect(tiles(sheet).every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true);
    expect(sheet.shadowRoot?.querySelector('.afx__hint')?.textContent).toBe('An effect changes every sound it covers');
    // Nothing to take away yet.
    expect(head(sheet, '[aria-label="No effect"]')).toBe(null);
  });

  it('adds a layer from the playhead to the end with the tile tapped, selected, in one step named for it', async () => {
    const { store, sheet } = await mount([], null, 2000);
    tile(sheet, 'Megaphone').click();
    const [layer] = layersOf(store);
    expect(layer).toMatchObject({ startMs: 2000, endMs: 20_000, effect: 'megaphone' });
    expect(store.selection.value).toEqual({ kind: 'audioEffect', id: layer!.id });
    // Still open, now on the layer: its sliders come under the tiles.
    expect(store.panel.value).toBe('audioEffects');
    await until('the tile to show it', () => tile(sheet, 'Megaphone').getAttribute('aria-pressed') === 'true');
    await until('its sliders', () => controls(sheet).labels.length === 2);

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Megaphone');
    expect(layersOf(store)).toEqual([]);
  });

  it('stops a new layer short of the next one', async () => {
    const { store, sheet } = await mount([megaphone({ id: 'later', startMs: 8000, endMs: 9000 })], null, 2000);
    tile(sheet, 'Slow + reverb').click();
    expect(layersOf(store).map(({ startMs, endMs, effect }) => [startMs, endMs, effect])).toEqual([
      [2000, 8000, 'slowReverb'],
      [8000, 9000, 'megaphone'],
    ]);
  });

  it('changes the effect of the layer under the playhead when none is selected', async () => {
    const { store, sheet } = await mount([megaphone()], null, 3000);
    tile(sheet, 'Slow + reverb').click();
    expect(layersOf(store)).toEqual([megaphone({ effect: 'slowReverb' })]);
    expect(store.selection.value).toEqual({ kind: 'audioEffect', id: 'afx' });
  });

  it('gives the selected layer another effect at its defaults, sliders and Slow alike', async () => {
    const { store, sheet } = await mount([megaphone({ effect: 'slowReverb', speed: 0.6, effectSettings: { room: 90 } })], 'afx');
    tile(sheet, 'Megaphone').click();
    expect(layersOf(store)).toEqual([megaphone()]);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Megaphone');
  });

  it('takes the layer away with the head’s none, and the sheet with it', async () => {
    const { store, sheet } = await mount([megaphone()], 'afx');
    const none = head(sheet, '[aria-label="No effect"]');
    expect(none).not.toBe(null);
    none!.click();
    expect(layersOf(store)).toEqual([]);
    expect(store.selection.value).toBe(null);
    expect(store.panel.value).toBe(null);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Delete');
    expect(layersOf(store)).toEqual([megaphone()]);
  });

  it('records nothing for the effect the layer already has', async () => {
    const { store, sheet } = await mount([megaphone()], 'afx');
    tile(sheet, 'Megaphone').click();
    expect(store.canUndo.value).toBe(false);
  });

  it('shows the sliders of the selected layer’s effect, each named for what it changes', async () => {
    const { store, sheet } = await mount([megaphone()], 'afx');
    await until('the megaphone’s sliders', () => controls(sheet).labels.length === 2);
    expect(controls(sheet)).toEqual({ labels: ['Intensity', 'Tone'], values: ['50', '50'] });

    tile(sheet, 'Slow + reverb').click();
    expect(layersOf(store)[0]?.effect).toBe('slowReverb');
    await until('slow + reverb’s sliders', () => controls(sheet).labels.length === 3);
    expect(controls(sheet)).toEqual({ labels: ['Slow', 'Reverb', 'Room'], values: ['0.8x', '50', '50'] });
    expect(sliderFor(sheet, 'Room').getAttribute('aria-label')).toBe('Room size');
    expect(sliderFor(sheet, 'Slow').getAttribute('aria-label')).toBe('Slow speed');
  });

  it('moves a slider as one undo step named for it', async () => {
    const { store, sheet } = await mount([megaphone()], 'afx');
    await until('the sliders', () => controls(sheet).labels.length === 2);

    await drag(sheet, 'Intensity', 50, 80);
    expect(layersOf(store)[0]?.effectSettings).toEqual({ intensity: 80 });
    await until('the readout', () => controls(sheet).values[0] === '80');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Megaphone intensity');
    expect(layersOf(store)).toEqual([megaphone()]);
  });

  it('sets the layer’s Slow, and leaves every sound at its own speed', async () => {
    const { store, sheet } = await mount([megaphone({ effect: 'slowReverb' })], 'afx');
    await until('the sliders', () => controls(sheet).labels.length === 3);

    await drag(sheet, 'Slow', 80, 60);
    expect(layersOf(store)[0]?.speed).toBe(0.6);
    expect(findAudioClip(store.manifest.value, 'line')).not.toHaveProperty('speed');
    await until('the readout', () => controls(sheet).values[0] === '0.6x');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Slow speed');
    expect(layersOf(store)[0]).not.toHaveProperty('speed');
  });
});
