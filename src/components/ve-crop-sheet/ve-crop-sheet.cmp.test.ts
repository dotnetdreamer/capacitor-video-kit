import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because half of what this sheet does is a shape: each chip
 * draws the box the finished picture comes out at, and the arithmetic that sizes it is in the
 * component precisely because a stylesheet cannot say "as big as it goes inside 44px" on its own.
 * The mock DOM measures every one of those boxes as nothing at all.
 *
 * The rest is the pair the whole port turns on: one tap is one undo step, and the row reads the
 * manifest back rather than remembering what was tapped.
 */

/** A 1080p landscape source, which is what `ve-preview` writes once the metadata arrives. */
const SOURCE_ASPECT = 16 / 9;

/** What the stylesheet fits every chip's box inside. */
const SHAPE_PX = 44;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function oneClip(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false }],
  };
}

async function mount(): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), oneClip());
  store.openPanel('crop');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-crop-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  // The frame is a component of its own and renders on its own schedule; everything the head holds
  // is read through its shadow root, which does not exist until it has.
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  return { store, sheet };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function chips(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.cs__ratio') ?? [])];
}

function chip(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = chips(sheet).find((button) => button.textContent === label);
  if (!found) throw new Error(`no ${label} chip`);
  return found;
}

function box(button: HTMLButtonElement): { w: number; h: number } {
  const rect = button.querySelector('.cs__shape')!.getBoundingClientRect();
  return { w: Math.round(rect.width), h: Math.round(rect.height) };
}

function crop(store: EditorStore) {
  return store.manifest.value.clips[0].crop;
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
}

/** What the preview writes from the `<video>` element's metadata, and nothing else in the editor does. */
async function metadataArrives(store: EditorStore, sheet: HTMLElement): Promise<void> {
  store.sourceAspect.value = SOURCE_ASPECT;
  await until('the ratios to wake up', () => !chip(sheet, 'Free').disabled);
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
});

describe('ve-crop-sheet', () => {
  it('draws no chrome of its own: the name, the tick and Reset all come from the frame', async () => {
    const { sheet } = await mount();

    expect(head(sheet, '.sheet__title')?.textContent).toBe('Crop');
    expect(head(sheet, '[aria-label="Done"]')).not.toBe(null);
    // "None" is what the frame calls that button, and it would tell a screen reader nothing here.
    expect(head(sheet, '.sheet__icon-btn--dim')?.getAttribute('aria-label')).toBe('Reset');
    expect(frame(sheet)?.shadowRoot?.querySelectorAll('.sheet__tab').length).toBe(0);
  });

  it('holds the ratios shut until the source has reported its shape', async () => {
    const { store, sheet } = await mount();

    expect(chips(sheet).every((button) => button.disabled)).toBe(true);
    chip(sheet, '1:1').click();
    await frames(2);
    // A ratio worked out against a shape nobody knows yet cuts the wrong part of the picture, and
    // the crop it wrote is what the render would encode.
    expect(crop(store)).toBe(undefined);
    expect(store.canUndo.value).toBe(false);

    await metadataArrives(store, sheet);
    expect(chips(sheet).some((button) => button.disabled)).toBe(false);
  });

  it('draws each chip at the shape the finished picture comes out at', async () => {
    const { store, sheet } = await mount();
    await metadataArrives(store, sheet);

    // Free is the source's own shape, which crops nothing, so on this clip it is 16:9 as well.
    expect(box(chip(sheet, 'Free'))).toEqual({ w: SHAPE_PX, h: Math.round(SHAPE_PX / SOURCE_ASPECT) });
    expect(box(chip(sheet, '1:1'))).toEqual({ w: SHAPE_PX, h: SHAPE_PX });
    expect(box(chip(sheet, '9:16'))).toEqual({ w: Math.round(SHAPE_PX * (9 / 16)), h: SHAPE_PX });
    expect(box(chip(sheet, '16:9'))).toEqual({ w: SHAPE_PX, h: Math.round(SHAPE_PX / (16 / 9)) });

    // Every label on the same line, which is the whole reason the boxes sit in a fixed row rather
    // than sizing their chip.
    const tops = chips(sheet).map((button) => Math.round(button.querySelector('.cs__ratio-label')!.getBoundingClientRect().top));
    expect(new Set(tops).size).toBe(1);
  });

  it('is one undo step per tap, and undo puts the picture back', async () => {
    const { store, sheet } = await mount();
    await metadataArrives(store, sheet);

    chip(sheet, '1:1').click();
    await until('the crop', () => crop(store) !== undefined);

    // A 1:1 picture out of a 16:9 source is a tall, narrow slice of it: the shape is the finished
    // picture's, never the crop's.
    const kept = crop(store)!;
    expect(SOURCE_ASPECT * (kept.w / kept.h)).toBeCloseTo(1, 2);

    store.undo();
    expect(crop(store)).toBe(undefined);
    // Nothing left behind it, which is what one tap being one step means.
    expect(store.canUndo.value).toBe(false);
  });

  it('reads the lit chip back off the manifest', async () => {
    const { store, sheet } = await mount();
    await metadataArrives(store, sheet);
    expect(chip(sheet, 'Free').getAttribute('aria-pressed')).toBe('true');

    chip(sheet, '9:16').click();
    await until('9:16 to light up', () => chip(sheet, '9:16').classList.contains('cs__ratio--on'));

    expect(chip(sheet, '9:16').getAttribute('aria-pressed')).toBe('true');
    expect(chips(sheet).filter((button) => button.classList.contains('cs__ratio--on')).length).toBe(1);

    // The undo puts the row back too, because nothing here remembers what was tapped.
    store.undo();
    await until('Free to light up again', () => chip(sheet, 'Free').classList.contains('cs__ratio--on'));
  });

  it('answers the frame: Reset clears the framing and the tick closes the sheet', async () => {
    const { store, sheet } = await mount();
    await metadataArrives(store, sheet);
    chip(sheet, '4:5').click();
    await until('the crop', () => crop(store) !== undefined);

    head(sheet, '.sheet__icon-btn--dim')!.click();
    await until('the crop to go', () => crop(store) === undefined);
    // The hint says so as well: with nothing framed there is no picture to move under the window,
    // so what it offers is the two ways to start one - an edge, or a shape.
    expect(sheet.shadowRoot?.querySelector('.cs__hint')?.textContent).toContain('pick a shape');

    head(sheet, '[aria-label="Done"]')!.click();
    await until('the panel to close', () => store.panel.value === null);
  });
});
