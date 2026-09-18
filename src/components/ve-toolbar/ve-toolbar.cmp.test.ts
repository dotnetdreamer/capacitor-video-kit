import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because three of the things this row has to get right are
 * only true in one: the tiles scroll sideways and a new set of them has to start at its own first
 * tile, the focus walks the row under the arrow keys, and the Sound menu's tap catcher has to cover
 * the whole editor rather than the toolbar it is drawn inside.
 *
 * The rest is the part of the toolbar that is easy to lose in a port and annoying to notice: which
 * tools a selection gets, which of them are dimmed, and that a dimmed one still answers.
 */

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/**
 * Two segments over two sources, a second video on a layer of its own, a text layer under a
 * sticker, a music bed and one voiceover: the smallest edit that has all six rows in it.
 */
function fixture(): EditManifest {
  return {
    ...emptyManifest(),
    fit: 'cover',
    clips: [
      { id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false },
      { id: 'seg-b', clipKey: 'clip-b', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false },
    ],
    videoTracks: [
      {
        id: 'track-1',
        clips: [{ id: 'seg-c', clipKey: 'clip-c', inMs: 0, outMs: 4000, speed: 1, volume: 0, muted: true }],
        startMs: 1000,
        z: 1,
        opacity: 1,
      },
    ],
    overlays: [
      {
        id: 'ov-text',
        kind: 'text',
        text: 'Hidden gem',
        styleId: 'classic',
        color: '#ffffff',
        effect: 'none',
        align: 'center',
        cx: 0.5,
        cy: 0.22,
        scale: 1,
        rotationDeg: 0,
        opacity: 1,
        startMs: 0,
        endMs: 3200,
      },
      {
        id: 'ov-sticker',
        kind: 'sticker',
        emoji: null,
        assetId: 'hidden-gem',
        cx: 0.68,
        cy: 0.7,
        scale: 1,
        rotationDeg: 0,
        opacity: 1,
        startMs: 0,
        endMs: 0,
      },
    ],
    music: {
      uri: 'guitar.mp3',
      fileName: 'guitar.mp3',
      sourceDurationMs: 22883,
      inMs: 0,
      outMs: 0,
      startMs: 0,
      volume: 0.45,
      loop: true,
      fadeOutMs: 0,
    },
    voiceovers: [{ id: 'vo-1', uri: 'take.webm', startMs: 500, durationMs: 1200, volume: 1 }],
  };
}

async function mount(): Promise<{ store: EditorStore; bar: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  const sources = [
    { key: 'clip-a', fileName: 'a.mp4' },
    { key: 'clip-b', fileName: 'b.mp4' },
    { key: 'clip-c', fileName: 'c.mp4' },
  ];
  store.load(
    sources,
    new Map([
      ['clip-a', 5000],
      ['clip-b', 5000],
      ['clip-c', 5000],
    ]),
    fixture(),
  );

  /* The editor's own column on the phone it was drawn for, so the row really does overflow. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const bar = document.createElement('ve-toolbar');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(bar, { ctx });
  column.append(bar);

  mounted.push({ store, column });
  await (bar as StencilElement).componentOnReady?.();
  return { store, bar };
}

function root(bar: HTMLElement): ShadowRoot {
  return bar.shadowRoot!;
}

function tiles(bar: HTMLElement): HTMLButtonElement[] {
  return [...root(bar).querySelectorAll<HTMLButtonElement>('.tb__track .tile')];
}

function ids(bar: HTMLElement): string[] {
  return tiles(bar).map((tile) => tile.dataset.tile!);
}

function tile(bar: HTMLElement, id: string): HTMLButtonElement {
  const found = root(bar).querySelector<HTMLButtonElement>(`[data-tile="${id}"]`);
  if (!found) throw new Error(`no ${id} tile`);
  return found;
}

function label(bar: HTMLElement): string | null {
  return root(bar).querySelector('.tb')!.getAttribute('aria-label');
}

function menuItems(bar: HTMLElement): HTMLButtonElement[] {
  return [...root(bar).querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
}

function press(on: Element, key: string): void {
  on.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
});

describe('ve-toolbar on a desktop', () => {
  it('scrolls the row with a plain wheel, which is the only way a mouse can reach the end of it', async () => {
    const { bar } = await mount();
    const scroller = root(bar).querySelector('.tb__scroller') as HTMLElement;
    // The row has to actually overflow for there to be anything to reach; the root row does.
    await until('the row to overflow', () => scroller.scrollWidth > scroller.clientWidth);

    scroller.dispatchEvent(new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true }));

    // A wheel sends deltaY and this row scrolls in x: no browser turns one into the other, so
    // without this the last tools were unreachable - the scrollbar is hidden, there is no touch to
    // flick with, and shift+wheel is not something anybody should have to know.
    expect(scroller.scrollLeft).toBeGreaterThan(0);
  });

  it('leaves the wheel to the page once the row has run out', async () => {
    const { bar } = await mount();
    const scroller = root(bar).querySelector('.tb__scroller') as HTMLElement;
    await until('the row to overflow', () => scroller.scrollWidth > scroller.clientWidth);
    scroller.scrollLeft = scroller.scrollWidth;

    const event = new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
    scroller.dispatchEvent(event);

    // Swallowed at the end, a scroll that began on the toolbar would stop dead rather than doing
    // what the customer meant.
    expect(event.defaultPrevented).toBe(false);
  });
});

describe('ve-toolbar', () => {
  it('shows the tools for whatever is selected, and a way back out of them', async () => {
    const { store, bar } = await mount();

    expect(label(bar)).toBe('Editing tools');
    expect(ids(bar)).toEqual([
      'edit',
      'crop',
      'layout',
      'sound',
      'text',
      'effects',
      'overlay',
      'stickers',
      'filters',
      'adjust',
      'magic',
      'captions',
    ]);
    // Nothing to step back out to, so no chevron at all.
    expect(root(bar).querySelector('.tile--collapse')).toBe(null);

    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    expect(ids(bar)).toContain('split');
    expect(root(bar).querySelector('.tile--collapse')!.getAttribute('aria-label')).toBe('Close clip tools');

    // A segment on the second video layer gets a shorter row: split, join, duplicate and reorder
    // all rearrange the base track and have nothing to rearrange here.
    store.select({ kind: 'clip', id: 'seg-c' });
    await until('the video layer row', () => label(bar) === 'Video layer tools');
    expect(ids(bar)).toEqual(['layout', 'crop', 'speed', 'volume', 'start-here', 'replace', 'delete']);
    expect(tile(bar, 'delete').textContent).toContain('Remove');

    store.select({ kind: 'overlay', id: 'ov-text' });
    await until('the text layer row', () => label(bar) === 'Text layer tools');
    expect(ids(bar)).toContain('edit-text');

    store.select({ kind: 'music' });
    await until('the sound row', () => label(bar) === 'Sound tools');
    expect(ids(bar)).toEqual(['volume', 'loop', 'start-here', 'replace', 'delete']);

    store.select({ kind: 'voice', id: 'vo-1' });
    await until('the voiceover row', () => label(bar) === 'Voiceover tools');
    expect(ids(bar)).toEqual(['volume', 'record', 'delete']);

    store.select(null);
    store.toolbarMode.value = 'text';
    await until('the text row', () => label(bar) === 'Text tools');
    expect(ids(bar)).toEqual(['add-text', 'captions']);
    root(bar).querySelector<HTMLButtonElement>('.tile--collapse')!.click();
    await until('the root row', () => label(bar) === 'Editing tools');
  });

  it('dims a tool that cannot do anything, and still lets it answer', async () => {
    const { store, bar } = await mount();

    // The sticker is the top layer, so Forward and To front have nowhere to go.
    store.select({ kind: 'overlay', id: 'ov-sticker' });
    await until('the layer row', () => label(bar) === 'Sticker tools');
    const forward = tile(bar, 'forward');
    expect(forward.classList.contains('tile--dim')).toBe(true);
    expect(forward.getAttribute('aria-disabled')).toBe('true');
    // Never the `disabled` attribute: a disabled button swallows the tap and explains nothing, and
    // the explanation is the whole point of dimming it rather than hiding it.
    expect(forward.disabled).toBe(false);

    forward.click();
    await frames(2);
    expect(store.toast.value?.text).toBe('Already on top');
    expect(store.canUndo.value).toBe(false);
  });

  it('keeps the second video behind Layout, dimmed with a reason when there is no room for one', async () => {
    const { store, bar } = await mount();

    // With a second video on the frame it is the Layout sheet.
    tile(bar, 'layout').click();
    await frames(2);
    expect(store.panel.value).toBe('layout');
    store.closePanel();

    // Without one the tile asks for the video first, and a post with no clip slot left cannot have
    // one. It stays in a row people learn by position and says which cap bit.
    store.removeVideoTrack('track-1');
    store.maxClips.value = 2;
    await until('the tile to dim', () => tile(bar, 'layout').classList.contains('tile--dim'));
    tile(bar, 'layout').click();
    await until('the reason', () => store.toast.value !== null);
    expect(store.toast.value?.text).toBe('You can add up to 2 clips');
    expect(store.panel.value).toBe(null);
  });

  it('says a tool is not built yet instead of shipping a button that does nothing', async () => {
    const { store, bar } = await mount();

    const magic = tile(bar, 'magic');
    expect(magic.getAttribute('aria-label')).toBe('Magic, coming soon');
    magic.click();
    await frames(2);
    expect(store.toast.value?.text).toBe('Magic is coming soon');
    expect(store.canUndo.value).toBe(false);
    expect(store.panel.value).toBe(null);
  });

  it('names the fit tool after what a tap will do', async () => {
    const { store, bar } = await mount();

    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    expect(tile(bar, 'fit').textContent).toContain('Fit');

    tile(bar, 'fit').click();
    await until('the label to turn over', () => tile(bar, 'fit').textContent!.includes('Fill'));
    // On the SEGMENT that is selected, which is whose tools row this tile is in. The post's own fit
    // is what every other segment falls back on, and a tap here must not move those.
    expect(store.manifest.value.clips.find(clip => clip.id === 'seg-a')?.fit).toBe('contain');
    expect(store.manifest.value.fit).toBe('cover');
  });

  it('rebuilds the row when the row changes and not when the manifest does', async () => {
    const { store, bar } = await mount();
    store.select({ kind: 'overlay', id: 'ov-sticker' });
    await until('the layer row', () => label(bar) === 'Sticker tools');

    /*
     * One click listener is bound per tile per render pass, because each tile's handler closes over
     * its own tile object and the vdom swaps a listener whose function has changed. Counting them
     * is therefore counting the renders, which is the thing this component is built around: a drag
     * on the preview rewrites the manifest on every frame, and a row derived from the manifest
     * rather than from a handful of small computed values would repaint sixty times a second on the
     * phone that needs those frames for the drag.
     */
    const bound = { count: 0 };
    const add = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, fn, options) {
      if (type === 'click' && this instanceof HTMLButtonElement && this.classList.contains('tile')) bound.count += 1;
      return add.call(this, type, fn, options);
    };
    try {
      for (let i = 0; i < 60; i += 1) {
        store.previewOverlay('ov-sticker', { cx: 0.4 + i * 0.001 });
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await frames(2);
      expect(bound.count).toBe(0);

      // And it does repaint when one of those values changes: at the bottom of the drawing order
      // the sticker's Forward tile wakes up and its Backward tile dims.
      store.moveSelectedLayer('back');
      await until('the row to turn over', () => !tile(bar, 'forward').classList.contains('tile--dim'));
      expect(bound.count).toBeGreaterThan(0);
      expect(tile(bar, 'backward').classList.contains('tile--dim')).toBe(true);
    } finally {
      EventTarget.prototype.addEventListener = add;
    }
  });

  it('starts a new set of tools at its first tile, and leaves a repaint where it was', async () => {
    const { store, bar } = await mount();
    const scroller = root(bar).querySelector<HTMLElement>('.tb__scroller')!;
    expect(scroller.scrollWidth).toBeGreaterThan(scroller.clientWidth);
    // The reset for the row already on screen lands a paint after the row itself, so a test that
    // scrolls the moment the tiles appear is racing the thing it is about to measure.
    await frames(3);

    scroller.scrollLeft = 200;
    // A repaint that is not a new row: the Sound tile takes its held down look. The row would jump
    // back under the finger if the scroll reset ran on every paint rather than on a new row.
    store.soundMenuOpen.value = true;
    await until('the pressed tile', () => tile(bar, 'sound').classList.contains('tile--pressed'));
    await frames(3);
    expect(scroller.scrollLeft).toBe(200);

    store.soundMenuOpen.value = false;
    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    await until('the row to go back to its first tile', () => scroller.scrollLeft === 0);
  });

  it('opens the Sound menu over the whole editor and gives the tile its focus back', async () => {
    const { store, bar } = await mount();

    const sound = tile(bar, 'sound');
    expect(sound.getAttribute('aria-haspopup')).toBe('menu');
    expect(sound.getAttribute('aria-expanded')).toBe('false');

    sound.click();
    await until('the menu', () => menuItems(bar).length === 3);
    expect(menuItems(bar).map((item) => item.textContent!.trim())).toEqual(['Add sound', 'Sound effect', 'Voiceover']);
    expect(tile(bar, 'sound').getAttribute('aria-expanded')).toBe('true');
    // A tap opened it, so the focus stays on the row: taking it would show a focus ring nobody
    // asked for, and the arrow keys are for the customer who did.
    expect(root(bar).activeElement).toBe(null);

    // Fixed rather than absolute, so a tap anywhere in the editor closes the menu instead of
    // landing on the preview behind it.
    const catcher = root(bar).querySelector<HTMLElement>('.tb__catcher')!;
    expect(getComputedStyle(catcher).position).toBe('fixed');
    catcher.click();
    await until('the menu to close', () => menuItems(bar).length === 0);

    sound.click();
    await until('the menu', () => menuItems(bar).length === 3);
    press(root(bar).querySelector('.tb__menu')!, 'Escape');
    await until('the menu to close', () => menuItems(bar).length === 0);
    expect(store.soundMenuOpen.value).toBe(false);
    expect(root(bar).activeElement).toBe(tile(bar, 'sound'));
  });

  it('walks the row with the arrow keys', async () => {
    const { bar } = await mount();
    const toolbar = root(bar).querySelector('.tb')!;

    tile(bar, 'edit').focus();
    press(toolbar, 'ArrowRight');
    // The question is asked of this shadow root: `document.activeElement` is the host element for
    // every one of these presses, and an index of -1 would leave the focus where it was.
    expect(root(bar).activeElement).toBe(tile(bar, 'crop'));

    press(toolbar, 'End');
    expect(root(bar).activeElement).toBe(tile(bar, 'captions'));
    press(toolbar, 'ArrowRight');
    expect(root(bar).activeElement).toBe(tile(bar, 'captions'));
    press(toolbar, 'Home');
    expect(root(bar).activeElement).toBe(tile(bar, 'edit'));
    press(toolbar, 'ArrowLeft');
    expect(root(bar).activeElement).toBe(tile(bar, 'edit'));
  });
});
