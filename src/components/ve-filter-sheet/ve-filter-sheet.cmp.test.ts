import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { cssFor, emptyManifest, neutralAdjust, resolveFilterOps, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM. Two of the things this sheet promises are measurements: the
 * chosen preset is brought into the middle of a row that scrolls sideways, which needs a row with a
 * width and a scroll position, and the strength slider is a finger on a laid out bar. The mock DOM
 * answers both with zero and every assertion below would pass whatever the sheet did.
 *
 * The rest is what a filter sheet has to get right however it is drawn: one tap is one undo step,
 * the row reads the manifest back rather than remembering what was tapped, and the thumbnails show
 * the preset as it will actually land.
 */

/** A vintage preset, so the sheet has a category other than Trending to open on. */
const APPLIED = { id: 'retro', label: 'Retro', category: 'Vintage' };

/** Trending holds seven presets and the first of them is Original, which the row never draws. */
const TRENDING_LABELS = ['Crisp', 'Vivid', 'Warm', 'Golden', 'Cool', 'Fade'];

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function manifest(filterId: string, filterIntensity = 1): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false }],
    filterId,
    filterIntensity,
  };
}

async function mount(filterId = 'none', filterIntensity = 1): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), manifest(filterId, filterIntensity));
  store.openPanel('filters');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-filter-sheet');
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

function tab(sheet: HTMLElement, label: string): HTMLButtonElement {
  const tabs = [...(frame(sheet)?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.sheet__tab') ?? [])];
  const found = tabs.find(button => button.textContent === label);
  if (!found) throw new Error(`no ${label} tab`);
  return found;
}

function activeTab(sheet: HTMLElement): string | undefined {
  return frame(sheet)?.shadowRoot?.querySelector('.sheet__tab--on')?.textContent ?? undefined;
}

function row(sheet: HTMLElement): HTMLElement {
  return sheet.shadowRoot!.querySelector<HTMLElement>('.fs__row')!;
}

function thumbs(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.fs__thumb') ?? [])];
}

function labels(sheet: HTMLElement): (string | null)[] {
  return thumbs(sheet).map(button => button.querySelector('.fs__label')?.textContent ?? null);
}

function thumb(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = thumbs(sheet).find(button => button.querySelector('.fs__label')?.textContent === label);
  if (!found) throw new Error(`no ${label} thumbnail`);
  return found;
}

function strengthRow(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector<HTMLElement>('.fs__strength') ?? null;
}

function slider(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector<HTMLElement>('ve-slider') ?? null;
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

describe('ve-filter-sheet', () => {
  it('opens on the customer’s own category rather than on Trending', async () => {
    const { sheet } = await mount(APPLIED.id);

    expect(activeTab(sheet)).toBe(APPLIED.category);
    expect(labels(sheet)).toContain(APPLIED.label);
    expect(thumb(sheet, APPLIED.label).getAttribute('aria-pressed')).toBe('true');
  });

  it('brings the chosen preset into the middle of a row that does not fit on the screen', async () => {
    // Fourth of Trending's six, so a row left at its start would show only its edge - and far
    // enough from the end that the middle is somewhere the row can actually scroll to.
    const { sheet } = await mount('golden');

    const strip = row(sheet);
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    await until('the row to be centred on it', () => strip.scrollLeft > 0);

    const chosen = thumb(sheet, 'Golden').getBoundingClientRect();
    const box = strip.getBoundingClientRect();
    expect(Math.abs(chosen.left + chosen.width / 2 - (box.left + box.width / 2))).toBeLessThanOrEqual(1);
  });

  it('never offers Original among the thumbnails, because the head’s icon is that choice', async () => {
    const { sheet } = await mount();

    expect(labels(sheet)).toEqual(TRENDING_LABELS);
    expect(head(sheet, '.sheet__icon-btn--dim')?.getAttribute('aria-label')).toBe('None');
  });

  it('draws each thumbnail at full strength, which is what tapping it gives', async () => {
    // A filter already dialled well down: the tiles still answer "what would this look like".
    const { sheet } = await mount('vivid', 0.2);
    const expected = cssFor(resolveFilterOps({ filterId: 'vivid', filterIntensity: 1, adjust: neutralAdjust() }));

    const picture = thumb(sheet, 'Vivid').querySelector<HTMLElement>('.fs__img')!;

    expect(picture.style.filter).toBe(expected.filter);
    // No filmstrip has been cut, so the tile shows its own stand-in rather than a broken image.
    expect(picture.classList.contains('fs__img--fallback')).toBe(true);
    expect(thumb(sheet, 'Vivid').querySelector('img')).toBe(null);
  });

  it('is one undo step per tap, and takes the strength back to full', async () => {
    const { store, sheet } = await mount('vivid', 0.2);

    thumb(sheet, 'Warm').click();

    expect(store.manifest.value.filterId).toBe('warm');
    // Choosing a look is choosing all of it; the slider is for backing off afterwards.
    expect(store.manifest.value.filterIntensity).toBe(1);
    await until('the row to follow', () => thumb(sheet, 'Warm').getAttribute('aria-pressed') === 'true');
    expect(thumbs(sheet).filter(button => button.classList.contains('fs__thumb--on'))).toHaveLength(1);

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Filter');
    expect(store.manifest.value.filterId).toBe('vivid');
    expect(store.manifest.value.filterIntensity).toBe(0.2);
    expect(store.canUndo.value).toBe(false);
  });

  it('shows the strength row only once there is a filter to weaken', async () => {
    const { store, sheet } = await mount();
    expect(strengthRow(sheet)).toBe(null);

    thumb(sheet, 'Crisp').click();
    await until('the strength row', () => strengthRow(sheet) !== null);

    expect(strengthRow(sheet)!.querySelector('.fs__strength-label')?.textContent).toBe('Intensity');
    expect(strengthRow(sheet)!.querySelector('.fs__strength-value')?.textContent).toBe('100');
    expect(store.manifest.value.filterId).toBe('crisp');
  });

  it('is one undo step per strength drag, named for what it changed', async () => {
    const { store, sheet } = await mount('vivid', 0.8);
    expect(strengthRow(sheet)!.querySelector('.fs__strength-value')?.textContent).toBe('80');

    drag(sheet, 80, 45);

    expect(store.manifest.value.filterIntensity).toBeCloseTo(0.45, 6);
    await until('the readout to follow', () => strengthRow(sheet)!.querySelector('.fs__strength-value')?.textContent === '45');

    store.undo();
    // The row says Intensity because that is the word beside the slider; the history says what
    // was changed.
    expect(store.toast.value?.text).toBe('Undo: Filter strength');
    expect(store.manifest.value.filterIntensity).toBe(0.8);
    expect(store.canUndo.value).toBe(false);
  });

  it('clears the filter from the head, taking the strength row with it', async () => {
    const { store, sheet } = await mount('vivid', 0.4);

    head(sheet, '.sheet__icon-btn--dim')!.click();

    expect(store.manifest.value.filterId).toBe('none');
    await until('the strength row to go', () => strengthRow(sheet) === null);
    store.undo();
    expect(store.manifest.value.filterId).toBe('vivid');
  });

  it('records nothing when there is no filter to clear', async () => {
    const { store, sheet } = await mount();

    head(sheet, '.sheet__icon-btn--dim')!.click();

    expect(store.canUndo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
  });

  it('shows a category’s own presets and starts its row at the beginning', async () => {
    const { sheet } = await mount('golden');
    await until('the row to be centred on Golden', () => row(sheet).scrollLeft > 0);

    tab(sheet, 'Vintage').click();
    await until('the vintage presets', () => labels(sheet).includes(APPLIED.label));

    expect(labels(sheet)).toEqual(['Retro', 'Polaroid', '1970']);
    expect(activeTab(sheet)).toBe('Vintage');
    // A new row started part way along would hide its first presets.
    expect(row(sheet).scrollLeft).toBe(0);
    // Switching tabs is browsing, not choosing: nothing has been applied.
    expect(thumbs(sheet).some(button => button.classList.contains('fs__thumb--on'))).toBe(false);
  });

  it('closes the panel on the frame’s tick', async () => {
    const { store, sheet } = await mount('vivid');

    head(sheet, '[aria-label="Done"]')!.click();

    expect(store.panel.value).toBe(null);
  });
});
