import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import type { VideoEditorHost } from '../../host/host.types';
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
 * sticker, a music bed, one voiceover and one zoom: the smallest edit that has all seven rows in it.
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
    zooms: [{ id: 'zm-1', startMs: 1000, endMs: 4000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 700, ease: 'smooth' }],
  };
}

async function mount(given: VideoEditorHost = {}): Promise<{ store: EditorStore; bar: HTMLElement }> {
  const host = resolveEditorHost(given);
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
  return tiles(bar).map(tile => tile.dataset.tile!);
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
  for (let i = 0; i < count; i += 1) await new Promise(resolve => requestAnimationFrame(resolve));
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
  it('calls the tool that cuts a segment in two Cut, on the clip row and the layer row', async () => {
    const { store, bar } = await mount();

    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    expect(tile(bar, 'split').textContent?.trim()).toBe('Cut');

    store.select({ kind: 'overlay', id: 'ov-text' });
    await until('the text layer row', () => label(bar) === 'Text layer tools');
    expect(tile(bar, 'split').textContent?.trim()).toBe('Cut');
  });

  it('gives a picture no Speed and no Volume, on the base track and on a layer', async () => {
    const { store, bar } = await mount();
    const still = { image: true as const, inMs: 1_800_000, outMs: 1_803_000 };
    store.commit('Pictures', m => ({
      ...m,
      clips: [m.clips[0], { ...m.clips[1], ...still }],
      videoTracks: m.videoTracks.map(t => ({ ...t, clips: t.clips.map(c => ({ ...c, ...still })) })),
    }));

    store.select({ kind: 'clip', id: 'seg-b' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    expect(ids(bar)).not.toContain('speed');
    expect(ids(bar)).not.toContain('volume');
    // Everything else a segment has, a picture has.
    for (const id of ['split', 'transition', 'delete', 'duplicate', 'replace', 'crop', 'fit', 'filters', 'adjust']) {
      expect(ids(bar)).toContain(id);
    }

    // A video beside it keeps both.
    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the video row', () => ids(bar).includes('speed'));
    expect(ids(bar)).toContain('volume');

    store.select({ kind: 'clip', id: 'seg-c' });
    await until('the video layer row', () => label(bar) === 'Video layer tools');
    expect(ids(bar)).toEqual(['layout', 'crop', 'fit', 'start-here', 'replace', 'delete']);
  });

  it('shows the tools for whatever is selected, and a way back out of them', async () => {
    const { store, bar } = await mount();

    expect(label(bar)).toBe('Editing tools');
    expect(ids(bar)).toEqual(['edit', 'crop', 'zoom', 'layout', 'sound', 'text', 'effects', 'overlay', 'stickers', 'filters', 'adjust', 'magic', 'captions']);
    // Nothing to step back out to, so no chevron at all.
    expect(root(bar).querySelector('.tile--collapse')).toBe(null);

    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    expect(ids(bar)).toContain('split');
    expect(root(bar).querySelector('.tile--collapse')!.getAttribute('aria-label')).toBe('Close clip tools');

    // A segment on the second video layer gets a shorter row: split, join, duplicate and reorder
    // all rearrange the base track and have nothing to rearrange here. Fill/fit IS on it, though -
    // a layer sits on another picture, so it is the segment most likely to want filling its
    // rectangle, and for a while it was the one segment that could not be told to.
    store.select({ kind: 'clip', id: 'seg-c' });
    await until('the video layer row', () => label(bar) === 'Video layer tools');
    expect(ids(bar)).toEqual(['layout', 'crop', 'fit', 'speed', 'volume', 'start-here', 'replace', 'delete']);
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

  it('offers Animation on every layer row, and opens its sheet on the layer', async () => {
    const { store, bar } = await mount();

    store.select({ kind: 'overlay', id: 'ov-text' });
    await until('the text layer row', () => label(bar) === 'Text layer tools');
    // Beside Edit, ahead of the tools that move the layer in time or in the stack.
    expect(ids(bar).slice(0, 3)).toEqual(['edit-text', 'animation', 'split']);
    expect(tile(bar, 'animation').textContent?.trim()).toBe('Animation');

    store.select({ kind: 'overlay', id: 'ov-sticker' });
    await until('the sticker row', () => label(bar) === 'Sticker tools');
    expect(ids(bar)[0]).toBe('animation');

    tile(bar, 'animation').click();
    expect(store.panel.value).toBe('animation');
    // Still on the sticker: the sheet is about it.
    expect(store.selectedOverlay.value?.id).toBe('ov-sticker');
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

  it('opens the transition sheet on the cut into the selected segment, or out of the first one', async () => {
    const { store, bar } = await mount();

    // The second segment: the cut at its left edge, which is the one it holds.
    store.select({ kind: 'clip', id: 'seg-b' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    tile(bar, 'transition').click();
    expect(store.panel.value).toBe('transition');
    expect(store.transitionTarget.value).toBe('seg-b');
    // The sheet is about a cut and not a clip, so the segment lets go of the selection.
    expect(store.selection.value).toBeNull();
    store.closePanel();

    // The first segment has no cut in front of it, so it is the one after it.
    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the clip row again', () => label(bar) === 'Clip tools');
    tile(bar, 'transition').click();
    expect(store.transitionTarget.value).toBe('seg-b');
  });

  it('dims Transition on a video of one clip, and says what is missing', async () => {
    const { store, bar } = await mount();
    store.commit('Down to one', m => ({ ...m, clips: [m.clips[0]] }));

    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the clip row', () => label(bar) === 'Clip tools');
    await until('the tile to dim', () => tile(bar, 'transition').classList.contains('tile--dim'));

    tile(bar, 'transition').click();
    await until('the reason', () => store.toast.value !== null);
    expect(store.toast.value?.text).toBe('Add another clip to use a transition');
    expect(store.panel.value).toBeNull();
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
        await new Promise(resolve => requestAnimationFrame(resolve));
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

  /*
   * The tiles have no plate, so an edge of the screen that falls between two of them cuts nothing
   * off, and the tools past it look as if they are not there. The end that has more fades instead,
   * and a row that fits fades neither.
   */
  it('fades whichever end of the row still has tools past it', async () => {
    const { store, bar } = await mount();
    const scroller = root(bar).querySelector<HTMLElement>('.tb__scroller')!;
    const faded = () => ['before', 'after'].filter(end => scroller.classList.contains(`tb__scroller--${end}`)).join();

    await until('the end of the root row to fade', () => faded() === 'after');
    // The first row's scroll reset lands a paint late, and would undo the scroll below.
    await frames(3);

    scroller.scrollLeft = scroller.scrollWidth;
    await until('the start to fade instead', () => faded() === 'before');

    scroller.scrollLeft = 120;
    await until('both ends, from the middle', () => faded() === 'before,after');

    // Inside the track's end padding: not at the end of the scroll, but with no tool past the edge.
    scroller.scrollLeft = scroller.scrollWidth - scroller.clientWidth - 5;
    await until('the end to clear once the last tool is whole', () => faded() === 'before');

    store.toolbarMode.value = 'text';
    await until('the text row', () => ids(bar).join() === 'add-text,captions');
    await until('neither end of a row that fits', () => faded() === '');
  });

  it('opens the Sound menu over the whole editor and gives the tile its focus back', async () => {
    const { store, bar } = await mount();

    const sound = tile(bar, 'sound');
    expect(sound.getAttribute('aria-haspopup')).toBe('menu');
    expect(sound.getAttribute('aria-expanded')).toBe('false');

    sound.click();
    await until('the menu', () => menuItems(bar).length === 3);
    expect(menuItems(bar).map(item => item.textContent!.trim())).toEqual(['Add sound', 'Sound effect', 'Voiceover']);
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

  /*
   * A tile the arrow keys bring in from off the edge is scrolled only as far as it takes to show it,
   * which left it flush with the edge - under the fade there, its focus ring faded out with it.
   */
  it('stops a tile the arrow keys bring into view clear of the fade at the edge', async () => {
    const { bar } = await mount();
    const toolbar = root(bar).querySelector('.tb')!;
    const scroller = root(bar).querySelector<HTMLElement>('.tb__scroller')!;
    await frames(3);

    tile(bar, 'edit').focus();
    for (const id of ['crop', 'zoom', 'layout', 'sound', 'text', 'effects', 'overlay', 'stickers']) {
      press(toolbar, 'ArrowRight');
      expect(root(bar).activeElement).toBe(tile(bar, id));
      await frames(1);
      const edge = scroller.getBoundingClientRect();
      const box = tile(bar, id).getBoundingClientRect();
      expect(box.right).toBeLessThanOrEqual(edge.right - 32 + 0.5);
      expect(box.left).toBeGreaterThanOrEqual(edge.left);
    }
  });

  it('gives a selected zoom its own row, whose tiles act on that zoom', async () => {
    const { store, bar } = await mount();

    store.select({ kind: 'zoom', id: 'zm-1' });
    await until('the zoom row', () => label(bar) === 'Zoom tools');
    expect(ids(bar)).toEqual(['edit', 'duplicate', 'delete']);
    expect(root(bar).querySelector('.tile--collapse')!.getAttribute('aria-label')).toBe('Close zoom tools');

    tile(bar, 'edit').click();
    expect(store.panel.value).toBe('zoom');
    expect(store.selection.value).toEqual({ kind: 'zoom', id: 'zm-1' });
    store.closePanel();

    store.select({ kind: 'zoom', id: 'zm-1' });
    await until('the zoom row again', () => label(bar) === 'Zoom tools');
    tile(bar, 'delete').click();
    expect(store.manifest.value.zooms).toEqual([]);
    await until('the root row', () => label(bar) === 'Editing tools');
  });

  it('adds a zoom at the playhead from the root row', async () => {
    const { store, bar } = await mount();
    store.select(null);
    await until('the root row', () => label(bar) === 'Editing tools');
    const before = store.manifest.value.zooms.length;
    store.seek(6000);

    tile(bar, 'zoom').click();
    expect(store.manifest.value.zooms.length).toBe(before + 1);
    expect(store.panel.value).toBe('zoom');
    expect(store.selection.value?.kind).toBe('zoom');
  });
});

/*
 * A host that does not offer Zoom (`editing.zoom: false`), which is choisy's answer while the
 * feature is new. What goes is every way to put a NEW zoom in; a zoom the post already has is still
 * the customer's to open, change and delete.
 */
describe('ve-toolbar on a host that does not offer Zoom', () => {
  const NO_ZOOM: VideoEditorHost = { editing: { zoom: false } };

  it('takes the Zoom tile off the root row and leaves every other tile where it was', async () => {
    const on = await mount();
    expect(ids(on.bar)).toEqual(['edit', 'crop', 'zoom', 'layout', 'sound', 'text', 'effects', 'overlay', 'stickers', 'filters', 'adjust', 'magic', 'captions']);

    const off = await mount(NO_ZOOM);
    expect(label(off.bar)).toBe('Editing tools');
    expect(ids(off.bar)).toEqual(['edit', 'crop', 'layout', 'sound', 'text', 'effects', 'overlay', 'stickers', 'filters', 'adjust', 'magic', 'captions']);
    // Taken away rather than dimmed: there is nothing to hear a reason from and no tile to tap.
    expect(root(off.bar).querySelector('[data-tile="zoom"]')).toBeNull();
    expect(ids(off.bar)).toEqual(ids(on.bar).filter(id => id !== 'zoom'));
  });

  it('still gives a zoom the post already has its own row, without the copy that would add another', async () => {
    const { store, bar } = await mount(NO_ZOOM);

    store.select({ kind: 'zoom', id: 'zm-1' });
    await until('the zoom row', () => label(bar) === 'Zoom tools');
    expect(ids(bar)).toEqual(['edit', 'delete']);

    tile(bar, 'edit').click();
    expect(store.panel.value).toBe('zoom');
    expect(store.selection.value).toEqual({ kind: 'zoom', id: 'zm-1' });
    store.closePanel();

    store.select({ kind: 'zoom', id: 'zm-1' });
    await until('the zoom row again', () => label(bar) === 'Zoom tools');
    tile(bar, 'delete').click();
    expect(store.manifest.value.zooms).toEqual([]);
    await until('the root row', () => label(bar) === 'Editing tools');

    store.undo();
    expect(store.manifest.value.zooms.map(zoom => zoom.id)).toEqual(['zm-1']);
  });
});
