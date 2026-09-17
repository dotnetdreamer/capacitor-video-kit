import { render, describe, it, expect } from '@stencil/vitest';

import { activeElementDeep } from '../../bridge/active-element';
import type { SheetTab } from '../sheet.types';

/**
 * A browser test, because nearly everything this frame promises is shape: which of the two rows is
 * on screen, which of them the tick ended up in, whether the underline under the active tab was
 * drawn at all, whether the body really scrolls, and where the focus went. The mock DOM has no
 * layout, no focus and no scrolling, so it answers yes to all five whatever the component does.
 *
 * Eleven sheets sit in this frame and none of them can reach into its shadow root. So everything
 * here is read the way a sheet reads it: through a prop, through an event, or through one of the
 * three methods.
 */

/** The two tabs the volume and speed sheets show, which is the shape the head was drawn for. */
const TABS: readonly SheetTab[] = [
  { id: 'clip', label: 'Clip' },
  { id: 'all', label: 'All clips' },
];

function shadow(sheet: HTMLElement): ShadowRoot {
  return sheet.shadowRoot!;
}

function head(sheet: HTMLElement): HTMLElement | null {
  return shadow(sheet).querySelector('.sheet__head');
}

function searchRow(sheet: HTMLElement): HTMLElement | null {
  return shadow(sheet).querySelector('.sheet__search-row');
}

function field(sheet: HTMLElement): HTMLInputElement | null {
  return shadow(sheet).querySelector('input');
}

function body(sheet: HTMLElement): HTMLElement | null {
  return shadow(sheet).querySelector('.sheet__body');
}

function tabs(sheet: HTMLElement): HTMLElement[] {
  return [...shadow(sheet).querySelectorAll<HTMLElement>('.sheet__tab')];
}

/** The tick, found the way a screen reader finds it rather than by the class both buttons share. */
function ticks(sheet: HTMLElement): HTMLElement[] {
  return [...shadow(sheet).querySelectorAll<HTMLElement>('[aria-label="Done"]')];
}

function noneButton(sheet: HTMLElement): HTMLElement | null {
  return shadow(sheet).querySelector('.sheet__icon-btn--dim');
}

/**
 * Every press the frame reports, in the order it reported them, so one assertion covers both what
 * fired and what it carried. A sheet is handed nothing else: the frame draws the chrome and the
 * sheet decides what a press meant.
 */
function recordEvents(sheet: HTMLElement): [string, unknown][] {
  const fired: [string, unknown][] = [];
  for (const name of ['veNone', 'veTab', 'veSearch', 'veConfirm'] as const) {
    sheet.addEventListener(name, event => fired.push([name, (event as CustomEvent<unknown>).detail]));
  }
  return fired;
}

/** Types into the search field the way a customer does, one whole value at a time. */
function type(sheet: HTMLElement, text: string): void {
  const input = field(sheet)!;
  input.value = text;
  input.dispatchEvent(new Event('input'));
}

/** Polls a frame at a time, because a smooth scroll belongs to the browser and not to a promise. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

describe('ve-sheet', () => {
  it('draws the tick alone for a sheet that puts nothing else in the head', async () => {
    const { root } = await render<HTMLVeSheetElement>(<ve-sheet></ve-sheet>);

    expect(searchRow(root)).toBe(null);
    expect(ticks(root)).toHaveLength(1);
    expect(noneButton(root)).toBe(null);
    expect(shadow(root).querySelector('.sheet__title')).toBe(null);
    // The strip is in the head with no tabs in it, because it is also the spacer that holds the
    // tick at the right, and it does not call itself a tablist while it is only that.
    expect(shadow(root).querySelector('.sheet__tabs')!.hasAttribute('role')).toBe(false);
  });

  it('draws only the body for the sheet that brings its own chrome', async () => {
    const { root } = await render<HTMLVeSheetElement>(
      <ve-sheet showConfirm={false}>
        <p>Own panel</p>
      </ve-sheet>,
    );

    expect(head(root)).toBe(null);
    expect(searchRow(root)).toBe(null);
    expect(body(root)).not.toBe(null);
  });

  it('puts the none button, the divider, the name, the tabs and the tick in one order', async () => {
    const { root } = await render<HTMLVeSheetElement>(<ve-sheet heading="Volume" tabs={TABS} showNone={true}></ve-sheet>);

    expect([...head(root)!.children].map(child => child.className)).toEqual([
      'sheet__icon-btn sheet__icon-btn--dim',
      'sheet__divider',
      'sheet__title',
      'sheet__tabs',
      'sheet__icon-btn',
    ]);
    expect(shadow(root).querySelector('.sheet__title')!.textContent).toBe('Volume');
  });

  it('draws the divider only when there is a none button and tabs to keep apart', async () => {
    const { root, setProps } = await render<HTMLVeSheetElement>(<ve-sheet showNone={true}></ve-sheet>);
    expect(shadow(root).querySelector('.sheet__divider')).toBe(null);

    await setProps({ tabs: TABS });
    expect(shadow(root).querySelector('.sheet__divider')).not.toBe(null);

    await setProps({ showNone: false });
    expect(shadow(root).querySelector('.sheet__divider')).toBe(null);
  });

  it('underlines the active tab, says which one it is, and moves both when it changes', async () => {
    const { root, setProps } = await render<HTMLVeSheetElement>(<ve-sheet tabs={TABS} activeTab="clip"></ve-sheet>);

    expect(shadow(root).querySelector('.sheet__tabs')!.getAttribute('role')).toBe('tablist');
    expect(tabs(root).map(tab => tab.textContent)).toEqual(['Clip', 'All clips']);
    // Spelled out rather than compared to true, because the vdom removes an attribute set to
    // boolean false and a tab with no `aria-selected` is announced as a plain button.
    expect(tabs(root).map(tab => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);
    // The underline is a pseudo element on the modifier class, which is exactly the rule a hand
    // flattened stylesheet drops without a word: the tab keeps its label and loses its mark.
    expect(getComputedStyle(tabs(root)[0], '::after').height).toBe('3px');
    expect(getComputedStyle(tabs(root)[1], '::after').content).toBe('none');

    await setProps({ activeTab: 'all' });

    expect(tabs(root).map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
    expect(getComputedStyle(tabs(root)[1], '::after').height).toBe('3px');
  });

  it('underlines nothing while a search is what is on screen', async () => {
    const { root } = await render<HTMLVeSheetElement>(<ve-sheet tabs={TABS} activeTab={null}></ve-sheet>);

    expect(tabs(root).map(tab => tab.getAttribute('aria-selected'))).toEqual(['false', 'false']);
    expect(tabs(root).map(tab => getComputedStyle(tab, '::after').content)).toEqual(['none', 'none']);
  });

  it('calls the none button whatever the sheet calls it', async () => {
    const { root, setProps } = await render<HTMLVeSheetElement>(<ve-sheet showNone={true}></ve-sheet>);
    expect(noneButton(root)!.getAttribute('aria-label')).toBe('None');

    // What the crop and adjust sheets pass: they clear a setting rather than remove a thing, and
    // this is the whole of what replaced the two frames they waited to rewrite the button by hand.
    await setProps({ noneLabel: 'Reset' });

    expect(noneButton(root)!.getAttribute('aria-label')).toBe('Reset');
    expect(noneButton(root)!.textContent).toBe('');
  });

  it('draws no search row until a sheet gives it a placeholder', async () => {
    const { root, setProps } = await render<HTMLVeSheetElement>(<ve-sheet heading="Stickers"></ve-sheet>);
    expect(searchRow(root)).toBe(null);
    expect(field(root)).toBe(null);

    await setProps({ searchPlaceholder: 'Search stickers' });

    expect(searchRow(root)).not.toBe(null);
    expect(field(root)!.placeholder).toBe('Search stickers');
  });

  it('moves the tick into the search row, so a sheet with both rows shows one tick', async () => {
    const { root } = await render<HTMLVeSheetElement>(<ve-sheet heading="Stickers" tabs={TABS} showNone={true} searchPlaceholder="Search stickers"></ve-sheet>);

    const [tick] = ticks(root);
    expect(ticks(root)).toHaveLength(1);
    expect(searchRow(root)!.contains(tick)).toBe(true);
    // The head is still there with everything else in it, so the tick moved rather than the head
    // being dropped for having nothing left to hold.
    expect(head(root)).not.toBe(null);
    expect(tabs(root)).toHaveLength(2);
    // And it is below the search field it now belongs to, rather than above it.
    expect(searchRow(root)!.getBoundingClientRect().bottom).toBeLessThanOrEqual(head(root)!.getBoundingClientRect().top);
  });

  it('shows no tick at all on a sheet that has nothing to confirm', async () => {
    const { root, setProps } = await render<HTMLVeSheetElement>(<ve-sheet heading="Text" showConfirm={false} searchPlaceholder="Search"></ve-sheet>);
    expect(ticks(root)).toHaveLength(0);

    await setProps({ searchPlaceholder: null });

    expect(ticks(root)).toHaveLength(0);
  });

  it('keeps the field showing the text the sheet holds, clearing included', async () => {
    const { root, setProps } = await render<HTMLVeSheetElement>(<ve-sheet searchPlaceholder="Search stickers" searchValue=""></ve-sheet>);
    type(root, 'cat');

    // The sheet is the one that owns the text: it hears the change, keeps it, and hands it back.
    await setProps({ searchValue: 'cat' });
    expect(field(root)!.value).toBe('cat');

    // And clears it on its own account, which is what the sticker sheet's tab press does.
    await setProps({ searchValue: '' });
    expect(field(root)!.value).toBe('');
  });

  it('does not hand the head the search row when the search row goes', async () => {
    const { root, setProps } = await render<HTMLVeSheetElement>(<ve-sheet searchPlaceholder="Search stickers"></ve-sheet>);
    const firstRow = searchRow(root)!;
    const firstBody = body(root);
    expect(head(root)).toBe(null);

    await setProps({ searchPlaceholder: null, heading: 'Stickers' });

    // Both rows are divs and both are conditional. Matched by position instead of by key, the head
    // is not a new row: it is the search row with a different class on it, keeping the scroll
    // position, the focus and whatever else the browser hung on that element.
    expect(head(root)).not.toBe(firstRow);
    expect(field(root)).toBe(null);
    expect(searchRow(root)).toBe(null);
    expect(head(root)!.querySelector('.sheet__title')!.textContent).toBe('Stickers');
    // The body is the element two sheets hold on to across every repaint of the rows above it.
    expect(body(root)).toBe(firstBody);
  });

  it('reports every press with what the sheet needs in order to answer it', async () => {
    const { root } = await render<HTMLVeSheetElement>(<ve-sheet heading="Stickers" tabs={TABS} activeTab="clip" showNone={true} searchPlaceholder="Search stickers"></ve-sheet>);
    const fired = recordEvents(root);

    noneButton(root)!.click();
    tabs(root)[1].click();
    type(root, 'sun');
    ticks(root)[0].click();

    expect(fired).toEqual([
      ['veNone', null],
      ['veTab', 'all'],
      ['veSearch', 'sun'],
      ['veConfirm', null],
    ]);
  });

  it('hands back the box that scrolls, and scrolls it', async () => {
    const { root } = await render<HTMLVeSheetElement>(
      <ve-sheet heading="Effects" style={{ height: '200px' }}>
        <div id="grid" style={{ height: '1200px' }}></div>
      </ve-sheet>,
    );
    const grid = root.querySelector<HTMLElement>('#grid')!;

    const scroller = await root.bodyElement();

    // The same element the sheet's own IntersectionObserver takes as its root, which is only useful
    // if the sheet's content is inside it.
    expect(scroller).toBe(body(root));
    expect(grid.assignedSlot!.parentElement).toBe(scroller);
    expect(scroller!.scrollHeight).toBeGreaterThan(scroller!.clientHeight);

    await root.scrollBodyTo(300);
    expect(scroller!.scrollTop).toBe(300);

    await root.scrollBodyTo(0, 'smooth');
    await until('the smooth scroll to land', () => scroller!.scrollTop === 0);
  });

  it('takes the focus off the field, which is what drops the keyboard', async () => {
    const { root } = await render<HTMLVeSheetElement>(<ve-sheet searchPlaceholder="Search stickers"></ve-sheet>);
    const input = field(root)!;
    input.focus();
    expect(activeElementDeep()).toBe(input);

    await root.blurSearch();

    expect(shadow(root).activeElement).toBe(null);
    expect(activeElementDeep()).not.toBe(input);
  });

  it('leaves the focus alone when it is not in the field', async () => {
    const { root } = await render<HTMLElement>(
      <div>
        <button id="tool">Text</button>
        <ve-sheet searchPlaceholder="Search stickers"></ve-sheet>
      </div>,
    );
    const tool = root.querySelector<HTMLElement>('#tool')!;
    const sheet = root.querySelector<HTMLVeSheetElement>('ve-sheet')!;
    tool.focus();

    await sheet.blurSearch();

    // The sheets used to blur whatever `document.activeElement` named, which from outside a shadow
    // root is the outermost host: the keyboard went, and so did the focus on everything else.
    expect(activeElementDeep()).toBe(tool);
  });

  it('answers a sheet with no search field rather than throwing at it', async () => {
    const { root } = await render<HTMLVeSheetElement>(<ve-sheet heading="Crop"></ve-sheet>);

    await expect(root.blurSearch()).resolves.toBeUndefined();
    await expect(root.scrollBodyTo(40)).resolves.toBeUndefined();
  });
});
