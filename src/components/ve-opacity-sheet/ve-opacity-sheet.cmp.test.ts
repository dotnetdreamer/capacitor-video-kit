import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest, type EditOverlay } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because the only thing this sheet does is hand a slider to a
 * finger, and the slider's value is a question about where that finger landed on a laid out bar.
 * The mock DOM measures the bar as nothing wide, so every drag below would be a drag from 0 to 0
 * and would pass whatever the sheet did with it.
 *
 * What is actually under test is the pair of promises the sheet makes to the store: the whole drag
 * is ONE undo step carrying the name the customer saw on the sheet, and the percent on the knob is
 * written to the manifest as the fraction a layer's `opacity` is kept in.
 */

/** Where the layer starts, far enough from both ends that a drag has room either way. */
const START_OPACITY = 0.4;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function sticker(): EditOverlay {
  return {
    id: 'st-1',
    kind: 'sticker',
    emoji: '🍕',
    assetId: null,
    cx: 0.5,
    cy: 0.42,
    scale: 1,
    rotationDeg: 0,
    opacity: START_OPACITY,
    startMs: 0,
    endMs: 0,
  };
}

function effect(): EditOverlay {
  return {
    id: 'fx-1',
    kind: 'effect',
    effectId: 'vignette',
    cx: 0.5,
    cy: 0.5,
    scale: 1,
    rotationDeg: 0,
    opacity: START_OPACITY,
    startMs: 0,
    endMs: 0,
  };
}

function manifestWith(overlays: EditOverlay[]): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false }],
    overlays,
  };
}

/**
 * The sheet over a store holding one layer, selected, with the panel already open - which is the
 * state the shell hands it. Pass no layer for the case the sheet has to survive: nothing selected.
 */
async function mount(overlay?: EditOverlay): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), manifestWith(overlay ? [overlay] : []));
  // Selected first: `select` closes an open opacity panel, because a sheet about the old selection
  // says nothing about the new one.
  if (overlay) store.select({ kind: 'overlay', id: overlay.id });
  store.openPanel('opacity');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-opacity-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  // The frame and the slider are components of their own and render on their own schedule.
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  await (slider(sheet) as StencilElement | null)?.componentOnReady?.();
  return { store, sheet };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function slider(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector<HTMLElement>('ve-slider') ?? null;
}

function layer(store: EditorStore) {
  return store.manifest.value.overlays[0];
}

let pointerId = 0;

/** One whole drag along the bar, in the slider's own 0..100 units, exactly as a finger does it. */
function drag(sheet: HTMLElement, from: number, to: number): void {
  const bar = slider(sheet)!.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
  const at = (value: number) => bar.left + (value / 100) * bar.width;
  pointerId += 1;
  fire(sheet, 'pointerdown', at(from));
  fire(sheet, 'pointermove', at(to));
  fire(sheet, 'pointerup', at(to));
}

function fire(sheet: HTMLElement, type: string, clientX: number): void {
  slider(sheet)!.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX, bubbles: true }));
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

describe('ve-opacity-sheet', () => {
  it('calls itself Opacity over a sticker and Strength over an effect, in both places', async () => {
    const { sheet } = await mount(sticker());
    expect(head(sheet, '.sheet__title')?.textContent).toBe('Opacity');
    expect(slider(sheet)?.getAttribute('aria-label')).toBe('Opacity');

    const effects = await mount(effect());
    expect(head(effects.sheet, '.sheet__title')?.textContent).toBe('Strength');
    // The same word twice on purpose: the slider's label is what the undo step is named after.
    expect(slider(effects.sheet)?.getAttribute('aria-label')).toBe('Strength');
  });

  it('writes the knob’s whole percent as the manifest’s fraction', async () => {
    const { store, sheet } = await mount(sticker());
    expect(slider(sheet)?.getAttribute('aria-valuenow')).toBe('40');
    expect(slider(sheet)?.getAttribute('aria-valuetext')).toBe('40%');

    drag(sheet, 40, 70);

    expect(layer(store).opacity).toBeCloseTo(0.7, 6);
  });

  it('is one undo step per drag, named after what the customer was changing', async () => {
    const { store, sheet } = await mount(effect());

    drag(sheet, 40, 25);
    expect(layer(store).opacity).toBeCloseTo(0.25, 6);
    expect(store.canUndo.value).toBe(true);

    store.undo();
    expect(layer(store).opacity).toBe(START_OPACITY);
    // The word the sheet showed, not the word the manifest uses for the field.
    expect(store.toast.value?.text).toBe('Undo: Strength');
    // Nothing left behind it, which is what one drag being one step means.
    expect(store.canUndo.value).toBe(false);
  });

  it('records nothing for a press that never moves', async () => {
    const { store, sheet } = await mount(sticker());
    const bar = slider(sheet)!.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
    const onKnob = bar.left + 0.4 * bar.width;

    pointerId += 1;
    fire(sheet, 'pointerdown', onKnob);
    fire(sheet, 'pointerup', onKnob);

    expect(layer(store).opacity).toBe(START_OPACITY);
    expect(store.canUndo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
  });

  it('draws no slider with nothing selected, and asks the shell to close', async () => {
    const { store, sheet } = await mount();

    // A slider over nothing would be a control whose every move reached no layer at all.
    expect(slider(sheet)).toBe(null);
    expect(head(sheet, '.sheet__title')?.textContent).toBe('Opacity');
    // Deferred on purpose: run inside the write that emptied the selection, this would be closing
    // the panel from inside the undo that is still finishing.
    await until('the panel to close itself', () => store.panel.value === null);
  });

  it('closes the panel on the frame’s tick', async () => {
    const { store, sheet } = await mount(sticker());

    head(sheet, '[aria-label="Done"]')!.click();

    expect(store.panel.value).toBe(null);
  });
});
