import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { defaultClipEdit, emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because the row of chips scrolls sideways and the opacity
 * slider is set by a finger on a laid out bar: with no layout every drag below lands on `min`.
 *
 * The one thing this file cannot check is the bug the sheet actually had. `remove` as a member name
 * replaced `HTMLElement.prototype.remove` on the element, so the vdom taking the sheet off the
 * screen threw the second video away instead - but only in the `dist-custom-elements` build, where
 * the class IS the element. `stencil-test` runs the lazy build, where it is a proxy, and the sheet
 * behaved perfectly here while failing in the application. That is pinned by the guard in
 * `build/element-members.unit.test.ts`, at the class declaration, which is what the two builds
 * share.
 */

const START_OPACITY = 0.8;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function manifest(withTrack: boolean): EditManifest {
  const base = { ...emptyManifest(), clips: [defaultClipEdit('clip-a', 5000, 'seg-a')] };
  if (!withTrack) return base;
  return {
    ...base,
    videoTracks: [
      {
        id: 'track-1',
        clips: [defaultClipEdit('clip-b', 4000, 'seg-b')],
        startMs: 0,
        z: 1,
        opacity: START_OPACITY,
      },
    ],
  };
}

async function mount(withTrack = true): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load(
    [
      { key: 'clip-a', fileName: 'a.mp4' },
      { key: 'clip-b', fileName: 'b.mp4' },
    ],
    new Map([
      ['clip-a', 5000],
      ['clip-b', 4000],
    ]),
    manifest(withTrack),
  );
  store.openPanel('layout');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-layout-sheet');
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

function tick(sheet: HTMLElement): HTMLButtonElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLButtonElement>('[aria-label="Done"]') ?? null;
}

function chips(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.ls__preset') ?? [])];
}

function chip(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = chips(sheet).find(button => button.querySelector('.ls__label')?.textContent === label);
  if (!found) throw new Error(`no chip labelled ${label}`);
  return found;
}

function action(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.ls__action') ?? [])].find(
    button => button.textContent?.includes(label),
  );
  if (!found) throw new Error(`no action labelled ${label}`);
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

describe('ve-layout-sheet', () => {
  it('writes a preset onto both layers as one undo step, and lights the chip it is on', async () => {
    const { store, sheet } = await mount();
    expect(chips(sheet).length).toBe(7);
    await until('the full frame chip to light', () => chip(sheet, 'Full frame').getAttribute('aria-pressed') === 'true');

    chip(sheet, 'Top and bottom').click();

    const track = store.videoTrack.value!;
    expect(store.manifest.value.clips[0].rect).toEqual({ x: 0, y: 0, w: 1, h: 0.5 });
    expect(track.clips[0].rect).toEqual({ x: 0, y: 0.5, w: 1, h: 0.5 });
    await until('the chip to light', () => chip(sheet, 'Top and bottom').getAttribute('aria-pressed') === 'true');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Layout Top and bottom');
    expect(store.manifest.value.clips[0].rect).toBeUndefined();
    expect(store.canUndo.value).toBe(false);
  });

  it('keeps the second video when the tick closes it, which is all the tick does', async () => {
    const { store, sheet } = await mount();
    chip(sheet, 'Corner top right').click();
    const arranged = store.manifest.value;

    tick(sheet)!.click();

    expect(store.panel.value).toBe(null);
    // The whole of what the tick means: the arrangement stands, and nothing was recorded for it.
    expect(store.manifest.value).toBe(arranged);
    expect(store.videoTrack.value).not.toBeNull();
    expect(store.manifest.value.videoTracks).toHaveLength(1);
  });

  it('takes the second video off from Remove, and puts the base back over the whole frame', async () => {
    const { store, sheet } = await mount();
    chip(sheet, 'Side by side').click();
    expect(store.manifest.value.clips[0].rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });

    action(sheet, 'Remove').click();

    expect(store.manifest.value.videoTracks).toHaveLength(0);
    // A base left in half the frame with nothing beside it is a black band nobody asked for.
    expect(store.manifest.value.clips[0].rect).toBeUndefined();
    expect(store.panel.value).toBe(null);
    expect(store.selection.value).toBe(null);
    // One step, so one undo brings the whole split screen back.
    store.undo();
    expect(store.manifest.value.videoTracks).toHaveLength(1);
    expect(store.manifest.value.clips[0].rect).toEqual({ x: 0, y: 0, w: 0.5, h: 1 });
  });

  it('swaps which video is on top, keeping both rectangles where they are', async () => {
    const { store, sheet } = await mount();
    chip(sheet, 'Top and bottom').click();

    action(sheet, 'Swap').click();

    expect(store.manifest.value.clips[0].clipKey).toBe('clip-b');
    expect(store.videoTrack.value?.clips[0].clipKey).toBe('clip-a');
    // The pair is matched either way round, so the arrangement still reads as the one it is.
    await until('the chip to stay lit', () => chip(sheet, 'Top and bottom').getAttribute('aria-pressed') === 'true');
  });

  it('closes itself when the layer it is about has gone, rather than sitting there empty', async () => {
    const { store, sheet } = await mount();
    expect(store.panel.value).toBe('layout');

    store.removeVideoTrack('track-1');
    store.openPanel('layout');

    await until('the sheet to close itself', () => store.panel.value === null);
    expect(sheet.shadowRoot?.querySelector('.ls')).toBeNull();
  });
});
