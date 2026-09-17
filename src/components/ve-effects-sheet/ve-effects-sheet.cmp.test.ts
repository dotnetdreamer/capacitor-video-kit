import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because the previews are the sheet: they live outside the
 * vdom, are drawn by hand onto canvases by a budgeted rAF pump, and are only drawn at all for the
 * cells an IntersectionObserver says are inside the frame's own scroller. The mock DOM has no
 * layout, no observer and no canvas, so a sheet that drew nothing would pass every other test
 * anyone could write.
 *
 * The rest is what a picker has to get right: one tap is one undo step, a second tap swaps the look
 * in place rather than stacking another layer, and the grid reads the manifest back.
 */

/** Trending borrows this many from each of the four categories, in the categories' own order. */
const TRENDING = ['Vignette', 'Soft edges', 'Film grain', 'Scratches', 'Warm leak', 'Cool leak', 'Polaroid', 'Film strip'];

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function manifest(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 6000, speed: 1, volume: 1, muted: false }],
  };
}

async function mount(): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 6000]]), manifest());
  store.openPanel('effects');

  /*
   * The editor's own column on the phone it was drawn for, with a height as well as a width: the
   * frame's scrolling body is this sheet's observer root, and a root with no height reports nothing
   * on screen and no preview is ever drawn.
   */
  const column = document.createElement('div');
  column.style.cssText = 'display: flex; flex-direction: column; width: 393px; height: 520px';
  document.body.append(column);

  const sheet = document.createElement('ve-effects-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
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

function body(sheet: HTMLElement): HTMLElement {
  return frame(sheet)!.shadowRoot!.querySelector<HTMLElement>('.sheet__body')!;
}

function tab(sheet: HTMLElement, label: string): HTMLButtonElement {
  const tabs = [...(frame(sheet)?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.sheet__tab') ?? [])];
  const found = tabs.find(button => button.textContent === label);
  if (!found) throw new Error(`no ${label} tab`);
  return found;
}

function cells(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.fx__cell') ?? [])];
}

function labels(sheet: HTMLElement): (string | null)[] {
  return cells(sheet).map(button => button.querySelector('.fx__label')?.textContent ?? null);
}

function cell(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = cells(sheet).find(button => button.querySelector('.fx__label')?.textContent === label);
  if (!found) throw new Error(`no ${label} cell`);
  return found;
}

/** Types into the frame's search field the way a customer does, one whole value at a time. */
function search(sheet: HTMLElement, text: string): void {
  const input = frame(sheet)!.shadowRoot!.querySelector('input')!;
  input.value = text;
  input.dispatchEvent(new Event('input'));
}

/** Whether a preview has actually been painted, rather than only sized. */
function painted(canvas: HTMLCanvasElement): boolean {
  const g = canvas.getContext('2d');
  if (!g || canvas.width === 0) return false;
  return g.getImageData(0, 0, canvas.width, canvas.height).data.some(byte => byte !== 0);
}

function effectLayers(store: EditorStore) {
  return store.manifest.value.overlays.filter(layer => layer.kind === 'effect');
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 3000): Promise<void> {
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

describe('ve-effects-sheet', () => {
  it('opens on Trending, which borrows two from each category', async () => {
    const { sheet } = await mount();

    expect(labels(sheet)).toEqual(TRENDING);
    expect(frame(sheet)?.shadowRoot?.querySelector('.sheet__tab--on')?.textContent).toBe('Trending');
  });

  it('draws a preview onto every cell that is on screen', async () => {
    const { sheet } = await mount();
    const canvases = [...sheet.shadowRoot!.querySelectorAll<HTMLCanvasElement>('canvas.fx__canvas')];

    await until('the canvases to be sized', () => canvases.every(canvas => canvas.width > 0 && canvas.height > 0));
    await until('the first row to be drawn', () => painted(canvases[0]));
    expect(painted(canvases[1])).toBe(true);

    // A repaint that leaves the grid alone must leave the pixels alone with it. The sizes are the
    // canvas's own pixels, written once by the component: a render that set `width` or `height`
    // again would clear the preview while the component still believed it was drawn, and nothing
    // would ever draw it a second time.
    cell(sheet, 'Vignette').click();
    await until('the cell to light up', () => cell(sheet, 'Vignette').getAttribute('aria-pressed') === 'true');
    for (let i = 0; i < 3; i += 1) await new Promise(resolve => requestAnimationFrame(resolve));

    expect(canvases[0].isConnected).toBe(true);
    expect(painted(canvases[0])).toBe(true);
    expect(painted(canvases[1])).toBe(true);
  });

  it('adds a layer on the first tap, one undo step named after the look', async () => {
    const { store, sheet } = await mount();

    cell(sheet, 'Vignette').click();

    expect(effectLayers(store)).toHaveLength(1);
    expect(effectLayers(store)[0]).toMatchObject({ effectId: 'vignette', opacity: 1 });
    // Left selected on the video, which is where the customer's eyes go next.
    expect(store.selection.value).toEqual({ kind: 'overlay', id: effectLayers(store)[0].id });
    // The sheet stays open either way, so trying one look after another is a row of taps.
    expect(store.panel.value).toBe('effects');
    await until('the cell to light up', () => cell(sheet, 'Vignette').getAttribute('aria-pressed') === 'true');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Vignette');
    expect(effectLayers(store)).toHaveLength(0);
    expect(store.canUndo.value).toBe(false);
  });

  it('swaps the look of the selected layer rather than stacking a second one', async () => {
    const { store, sheet } = await mount();
    cell(sheet, 'Vignette').click();
    const id = effectLayers(store)[0].id;
    await until('the cell to light up', () => cell(sheet, 'Vignette').getAttribute('aria-pressed') === 'true');

    cell(sheet, 'Scratches').click();

    expect(effectLayers(store)).toHaveLength(1);
    expect(effectLayers(store)[0]).toMatchObject({ id, effectId: 'scratches' });
    await until('the grid to follow', () => cell(sheet, 'Scratches').getAttribute('aria-pressed') === 'true');
    expect(cells(sheet).filter(button => button.classList.contains('fx__cell--on'))).toHaveLength(1);

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Effect');
    expect(effectLayers(store)[0].effectId).toBe('vignette');
  });

  it('records nothing for the look that is already on', async () => {
    const { store, sheet } = await mount();
    cell(sheet, 'Vignette').click();
    await until('the cell to light up', () => cell(sheet, 'Vignette').getAttribute('aria-pressed') === 'true');
    const before = store.manifest.value;

    cell(sheet, 'Vignette').click();

    expect(store.manifest.value).toBe(before);
  });

  it('searches across every category and lets no tab claim the results', async () => {
    const { sheet } = await mount();

    search(sheet, 'leak');
    await until('the results', () => labels(sheet).length === 2);

    // Both are in Light, but "film" below crosses two categories, which is why no tab is underlined.
    expect(labels(sheet)).toEqual(['Warm leak', 'Cool leak']);
    expect(frame(sheet)?.shadowRoot?.querySelector('.sheet__tab--on')).toBe(null);

    search(sheet, 'film');
    await until('the wider results', () => labels(sheet).length === 3);
    expect(labels(sheet)).toEqual(['Film grain', 'Old film', 'Film strip']);
  });

  it('says so rather than showing an empty grid', async () => {
    const { sheet } = await mount();

    search(sheet, 'kaleidoscope');
    await until('the message', () => sheet.shadowRoot?.querySelector('.fx__empty') !== null);

    expect(sheet.shadowRoot?.querySelector('.fx__empty')?.textContent).toBe('No effects found');
    expect(cells(sheet)).toHaveLength(0);
  });

  it('shows a category on its tab, and starts its grid at the top', async () => {
    const { sheet } = await mount();
    body(sheet).scrollTop = 200;
    await until('the grid to be scrolled', () => body(sheet).scrollTop > 0);

    tab(sheet, 'Frames').click();
    await until('the frames', () => labels(sheet).length === 6);

    expect(labels(sheet)).toEqual(['Polaroid', 'Film strip', 'Rounded', 'Neon', 'Hearts', 'Viewfinder']);
    // A tab switch that kept the scroll would open the new grid part way down it.
    await until('the grid to be back at the top', () => body(sheet).scrollTop === 0);
  });

  it('is a way back out of a search as well', async () => {
    const { sheet } = await mount();
    search(sheet, 'leak');
    await until('the results', () => labels(sheet).length === 2);

    tab(sheet, 'Basic').click();
    await until('the basic looks', () => labels(sheet).length === 4);

    expect(labels(sheet)).toEqual(['Vignette', 'Soft edges', 'Spotlight', 'Dreamy']);
    expect(frame(sheet)!.shadowRoot!.querySelector('input')!.value).toBe('');
  });

  it('takes the effect off with None, and closes when there is none to take off', async () => {
    const { store, sheet } = await mount();
    cell(sheet, 'Vignette').click();
    await until('the cell to light up', () => cell(sheet, 'Vignette').getAttribute('aria-pressed') === 'true');

    head(sheet, '.sheet__icon-btn--dim')!.click();

    expect(effectLayers(store)).toHaveLength(0);
    expect(store.selection.value).toBe(null);
    // Removing it is the change; the sheet stays open for the next look.
    expect(store.panel.value).toBe('effects');
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Delete');

    const fresh = await mount();
    head(fresh.sheet, '.sheet__icon-btn--dim')!.click();
    // Nothing to undo, so None can only mean "I am done here".
    expect(fresh.store.canUndo.value).toBe(false);
    expect(fresh.store.panel.value).toBe(null);
  });

  it('closes the panel on the frame’s tick', async () => {
    const { store, sheet } = await mount();

    head(sheet, '[aria-label="Done"]')!.click();

    expect(store.panel.value).toBe(null);
  });
});
