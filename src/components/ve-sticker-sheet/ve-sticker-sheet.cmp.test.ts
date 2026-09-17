import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest, type StickerOverlay } from '../../editor';
import { setEditorAssetPath } from '../../host/asset-path';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because most of this sheet is a scroll position. The category
 * bar follows the grid through an IntersectionObserver over the frame's own scroller and jumps back
 * to a section when tapped, and both are questions about laid out boxes.
 *
 * The one below that has no other way of being caught is the section placeholder. Each section is
 * `content-visibility: auto`, so a section off screen is exactly as tall as its
 * `contain-intrinsic-size` says and no taller - which means a placeholder that disagrees with the
 * stylesheet aims every jump through the section it was meant to land on, by a few pixels per
 * section above it. Nothing throws and the grid looks perfect.
 */

/** Where the 34 sticker SVGs are served from, which `stickerUrl` resolves against. */
const ASSET_BASE = '/video-editor/';

const RECENT_KEY = 've.recentEmoji';

/** Mirrors the stylesheet: the heading, the cell, the columns, the row gap and the section padding. */
const STICKER_HEADING = 40;
const STICKER_CELL = 96;
const STICKER_COLUMNS = 3;
const STICKER_ROW_GAP = 8;
const SECTION_PAD_BOTTOM = 8;

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
  store.openPanel('stickers');

  /*
   * The editor's own column on the phone it was drawn for, with a height as well as a width: the
   * frame's scrolling body is what the observers watch and what the jumps scroll, and a body with
   * no height has no sections on screen and nowhere to scroll to.
   */
  const column = document.createElement('div');
  column.style.cssText = 'display: flex; flex-direction: column; width: 393px; height: 560px';
  document.body.append(column);

  const sheet = document.createElement('ve-sticker-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  // The scroller is asked for through a method, so the observers are a render behind the first paint.
  await until('the sections to be observed', () => sections(sheet).length > 0 && activeCategory(sheet) !== null);
  return { store, sheet };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function scroller(sheet: HTMLElement): HTMLElement {
  return frame(sheet)!.shadowRoot!.querySelector<HTMLElement>('.sheet__body')!;
}

function tab(sheet: HTMLElement, label: string): HTMLButtonElement {
  const tabs = [...(frame(sheet)?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.sheet__tab') ?? [])];
  const found = tabs.find(button => button.textContent === label);
  if (!found) throw new Error(`no ${label} tab`);
  return found;
}

function sections(sheet: HTMLElement): HTMLElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLElement>('[data-section]') ?? [])];
}

function section(sheet: HTMLElement, id: string): HTMLElement {
  const found = sections(sheet).find(el => el.dataset.section === id);
  if (!found) throw new Error(`no ${id} section`);
  return found;
}

function bar(sheet: HTMLElement): HTMLElement {
  return sheet.shadowRoot!.querySelector<HTMLElement>('.stk__bar')!;
}

function categories(sheet: HTMLElement): string[] {
  return [...bar(sheet).querySelectorAll<HTMLElement>('[data-bar]')].map(button => button.dataset.bar!);
}

function activeCategory(sheet: HTMLElement): string | null {
  return bar(sheet).querySelector<HTMLElement>('.stk__cat--on')?.dataset.bar ?? null;
}

function categoryButton(sheet: HTMLElement, id: string): HTMLButtonElement {
  const found = bar(sheet).querySelector<HTMLButtonElement>(`[data-bar="${id}"]`);
  if (!found) throw new Error(`no ${id} category`);
  return found;
}

function stickers(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.stk__sticker') ?? [])];
}

function stickerNamed(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = stickers(sheet).find(button => button.getAttribute('aria-label') === label);
  if (!found) throw new Error(`no ${label} sticker`);
  return found;
}

function emoji(sheet: HTMLElement, char: string): HTMLButtonElement {
  const found = [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.stk__emoji') ?? [])].find(
    button => button.textContent?.trim() === char,
  );
  if (!found) throw new Error(`no ${char} button`);
  return found;
}

/** Types into the frame's search field the way a customer does, one whole value at a time. */
function search(sheet: HTMLElement, text: string): void {
  const input = frame(sheet)!.shadowRoot!.querySelector('input')!;
  input.value = text;
  input.dispatchEvent(new Event('input'));
}

function layer(store: EditorStore): StickerOverlay {
  return store.manifest.value.overlays[0] as StickerOverlay;
}

/** What the component's own `sectionHeight` works out, written again from the stylesheet's numbers. */
function placeholderPx(count: number): number {
  const rows = Math.max(1, Math.ceil(count / STICKER_COLUMNS));
  return STICKER_HEADING + rows * STICKER_CELL + (rows - 1) * STICKER_ROW_GAP;
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 3000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

beforeEach(() => {
  // The 34 SVGs are resolved against this; with no base set at all, `stickerUrl` is entitled to
  // throw and the sheet shows "Stickers are unavailable" instead of a grid.
  setEditorAssetPath(ASSET_BASE);
  localStorage.removeItem(RECENT_KEY);
});

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
  localStorage.removeItem(RECENT_KEY);
});

describe('ve-sticker-sheet', () => {
  it('opens on the sticker sections, with a bar that matches them', async () => {
    const { sheet } = await mount();

    expect(sheet.shadowRoot?.querySelector('.stk__title')?.textContent).toBe('Recommended');
    expect(sections(sheet).map(el => el.dataset.section)).toEqual(['reactions', 'food', 'badges', 'shapes']);
    expect(categories(sheet)).toEqual(['reactions', 'food', 'badges', 'shapes']);
    expect(activeCategory(sheet)).toBe('reactions');
    expect(stickerNamed(sheet, 'Pizza').querySelector('img')?.getAttribute('src')).toBe(`${ASSET_BASE}assets/stickers/pizza.svg`);
  });

  it('stands a skipped section exactly as tall as the stylesheet lays it out', async () => {
    const { sheet } = await mount();
    const first = section(sheet, 'reactions');
    const declared = first.style.getPropertyValue('contain-intrinsic-size');

    // The first section is on screen, so this is its real laid out height rather than its
    // placeholder - which is the whole point of measuring it. A placeholder that disagrees aims
    // every jump through the section it was meant to land on.
    expect(declared).toBe(`auto ${placeholderPx(9)}px`);
    expect(first.offsetHeight).toBe(placeholderPx(9) + SECTION_PAD_BOTTOM);
    // The padding is deliberately left out of the placeholder, because `contain-intrinsic-size` is
    // an intrinsic INNER size and the section's own padding is added to it rather than counted in.
    expect(parseFloat(getComputedStyle(first).paddingBottom)).toBe(SECTION_PAD_BOTTOM);
  });

  it('adds the sticker and leaves the customer looking at it on the video', async () => {
    const { store, sheet } = await mount();

    stickerNamed(sheet, 'Crown').click();

    expect(layer(store)).toMatchObject({ kind: 'sticker', assetId: 'crown', emoji: null });
    expect(store.selection.value).toEqual({ kind: 'overlay', id: layer(store).id });
    // Closed on purpose: the new layer is on the video and moving it is what comes next.
    expect(store.panel.value).toBe(null);

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Sticker');
    expect(store.manifest.value.overlays).toHaveLength(0);
  });

  it('reads an emoji back off the button it was drawn in, from one listener per grid', async () => {
    const { store, sheet } = await mount();
    tab(sheet, 'Emoji').click();
    // Both tabs have a section called "food", so the wait is for the glyphs rather than for an id.
    await until('the emoji grids', () => sheet.shadowRoot?.querySelector('.stk__emoji') !== null);

    emoji(sheet, '\u{1F355}').click();

    expect(layer(store)).toMatchObject({ kind: 'sticker', emoji: '\u{1F355}', assetId: null });
    expect(store.panel.value).toBe(null);
    expect(JSON.parse(localStorage.getItem(RECENT_KEY) ?? '[]')).toEqual(['\u{1F355}']);
  });

  it('puts what was used last at the top of the emoji tab next time', async () => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(['\u{1F355}', '❤️']));
    const { sheet } = await mount();

    tab(sheet, 'Emoji').click();
    await until('the recents', () => sections(sheet)[0]?.dataset.section === 've-recent');

    expect(sections(sheet)[0].querySelector('.stk__heading')?.textContent).toBe('Recent');
    expect(categories(sheet)[0]).toBe('ve-recent');
    // A drawn icon rather than an emoji, because "recent" has no glyph of its own.
    expect(categoryButton(sheet, 've-recent').querySelector('ve-icon')).not.toBe(null);
  });

  it('keeps the two tabs’ sections apart although they share ids', async () => {
    const { sheet } = await mount();
    const before = section(sheet, 'food');

    tab(sheet, 'Emoji').click();
    await until('the emoji grids', () => sheet.shadowRoot?.querySelector('.stk__emoji') !== null);

    // Both tabs have a "food" section. Matched by that id alone, the vdom would patch one grid of
    // buttons into the other rather than replacing it, and the stickers would still be there.
    expect(section(sheet, 'food')).not.toBe(before);
    expect(stickers(sheet)).toHaveLength(0);
    expect(section(sheet, 'food').querySelectorAll('.stk__emoji').length).toBeGreaterThan(0);
  });

  it('searches across the sections, and says so when nothing matches', async () => {
    const { sheet } = await mount();

    search(sheet, 'delicious');
    await until('the results', () => sheet.shadowRoot?.querySelector('.stk__grid--results') !== null);

    expect(stickers(sheet).map(button => button.getAttribute('aria-label'))).toEqual(['Yum!', 'Tasty', "Chef's kiss"]);
    // A search crosses every section, so nothing in the bar is "where you are" any more.
    expect(sections(sheet)).toHaveLength(0);
    await until('the bar to let go', () => activeCategory(sheet) === null);

    search(sheet, 'kaleidoscope');
    await until('the message', () => sheet.shadowRoot?.querySelector('.stk__empty') !== null);
    expect(sheet.shadowRoot?.querySelector('.stk__empty')?.textContent).toBe('No stickers found');
  });

  it('jumps the grid to a tapped category and keeps the bar on it', async () => {
    const { sheet } = await mount();
    const area = scroller(sheet);

    categoryButton(sheet, 'badges').click();
    await until('the bar to follow', () => activeCategory(sheet) === 'badges');
    await until(
      'the section to reach the top',
      () => Math.abs(section(sheet, 'badges').getBoundingClientRect().top - area.getBoundingClientRect().top) <= 2,
    );

    expect(area.scrollTop).toBeGreaterThan(0);
    // The sections the smooth scroll passed on the way must not steal the highlight back.
    expect(activeCategory(sheet)).toBe('badges');
  });

  it('goes back to browsing when a category is tapped during a search', async () => {
    const { sheet } = await mount();
    search(sheet, 'delicious');
    await until('the results', () => sections(sheet).length === 0);

    categoryButton(sheet, 'shapes').click();

    await until('the sections to come back', () => sections(sheet).length === 4);
    expect(frame(sheet)!.shadowRoot!.querySelector('input')!.value).toBe('');
    await until(
      'the section to reach the top',
      () =>
        Math.abs(section(sheet, 'shapes').getBoundingClientRect().top - scroller(sheet).getBoundingClientRect().top) <= 2,
    );
    expect(activeCategory(sheet)).toBe('shapes');
  });

  it('closes the panel on the frame’s tick', async () => {
    const { store, sheet } = await mount();

    frame(sheet)!.shadowRoot!.querySelector<HTMLElement>('[aria-label="Done"]')!.click();

    expect(store.panel.value).toBe(null);
  });
});
