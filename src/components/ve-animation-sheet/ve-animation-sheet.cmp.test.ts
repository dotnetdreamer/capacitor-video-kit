// The browser provider's own types, which are what give `cdp()` a `send` to switch a media setting with.
/// <reference types="@vitest/browser-playwright" />
import { afterEach, describe, expect, it } from 'vitest';
import { cdp } from 'vitest/browser';

import type { EditorContext } from '../../bridge/editor-context';
import {
  MAX_OVERLAY_LOOP_MS,
  MAX_OVERLAY_MOVE_MS,
  MIN_OVERLAY_LOOP_MS,
  MIN_OVERLAY_MOVE_MS,
  OVERLAY_ANIMATIONS,
  emptyManifest,
  type EditManifest,
  type EditOverlay,
} from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';
import type { OverlayBitmap } from '../../state/editor.types';

/*
 * A browser rather than the mock DOM. The chosen tile is brought into the middle of a row that
 * scrolls sideways, the length is a finger on a laid out bar, and the tiles move frame by frame - in
 * a mock DOM every one of those answers nothing.
 *
 * What is under test is what the sheet promises the store and the phone: a tile puts its preset on
 * the part on screen and None takes that part off; the chosen tile is in its NAME and never in
 * `aria-pressed`, which the A13's WebView loses; the slider sets the length live and a whole visit is
 * one undo step; an effect is offered a fade and nothing else; the tiles really move; and the sheet
 * stays short enough for the move to be watched on the picture above it.
 *
 * The sheet is opened the way the tool row opens it, through `openAnimation`, because that is what
 * starts the history group the visit folds into.
 */

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function sticker(over: Partial<EditOverlay> = {}): EditOverlay {
  return {
    id: 'st-1',
    kind: 'sticker',
    emoji: '🍕',
    assetId: null,
    cx: 0.5,
    cy: 0.42,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 1000,
    endMs: 5000,
    ...over,
  } as EditOverlay;
}

function effect(over: Partial<EditOverlay> = {}): EditOverlay {
  return { id: 'fx-1', kind: 'effect', effectId: 'vignette', cx: 0.5, cy: 0.5, scale: 1, rotationDeg: 0, opacity: 1, startMs: 0, endMs: 0, ...over } as EditOverlay;
}

function manifestWith(overlays: EditOverlay[]): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 6000, speed: 1, volume: 1, muted: false }],
    overlays,
  };
}

/** The sheet over a store holding `overlay`, selected, opened as the Animation tile opens it. */
async function mount(overlay: EditOverlay | null = sticker()) {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 6000]]), manifestWith(overlay ? [overlay] : []));
  if (overlay) {
    store.select({ kind: 'overlay', id: overlay.id });
    store.openAnimation();
  } else {
    store.openPanel('animation');
  }

  // The A13's editor column, with the compact sheet's own cap as its height.
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 340px; display: flex; flex-direction: column';
  document.body.append(column);

  const sheet = document.createElement('ve-animation-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);
  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  const bar = sheet.shadowRoot?.querySelector('ve-slider') as StencilElement | null;
  await bar?.componentOnReady?.();
  return { store, sheet };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function tabs(sheet: HTMLElement): string[] {
  return [...(frame(sheet)?.shadowRoot?.querySelectorAll('.sheet__tab') ?? [])].map(button => button.textContent ?? '');
}

function tab(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = [...(frame(sheet)?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.sheet__tab') ?? [])].find(button => button.textContent === label);
  if (!found) throw new Error(`no ${label} tab`);
  return found;
}

function activeTab(sheet: HTMLElement): string | undefined {
  return frame(sheet)?.shadowRoot?.querySelector('.sheet__tab--on')?.textContent ?? undefined;
}

function row(sheet: HTMLElement): HTMLElement {
  return sheet.shadowRoot!.querySelector<HTMLElement>('.an__row')!;
}

function tiles(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.an__tile') ?? [])];
}

function labels(sheet: HTMLElement): (string | null)[] {
  return tiles(sheet).map(button => button.querySelector('.an__label')?.textContent ?? null);
}

function names(sheet: HTMLElement): (string | null)[] {
  return tiles(sheet).map(button => button.getAttribute('aria-label'));
}

function tile(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = tiles(sheet).find(button => button.querySelector('.an__label')?.textContent === label);
  if (!found) throw new Error(`no ${label} tile`);
  return found;
}

function lengthRow(sheet: HTMLElement): HTMLElement {
  return sheet.shadowRoot!.querySelector<HTMLElement>('.an__length')!;
}

function readout(sheet: HTMLElement): string | null {
  return sheet.shadowRoot?.querySelector('[data-readout="length"]')?.textContent?.trim() ?? null;
}

function slider(sheet: HTMLElement): HTMLElement {
  return sheet.shadowRoot!.querySelector<HTMLElement>('ve-slider')!;
}

function layer(store: EditorStore): EditOverlay {
  return store.manifest.value.overlays[0];
}

let pointerId = 300;

/** One whole drag along the bar, as a fraction of it at each end, exactly as a finger does it. */
function drag(sheet: HTMLElement, from: number, to: number): void {
  const bar = slider(sheet).shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
  const at = (fraction: number) => bar.left + fraction * bar.width;
  pointerId += 1;
  for (const [type, x] of [
    ['pointerdown', at(from)],
    ['pointermove', at((from + to) / 2)],
    ['pointermove', at(to)],
    ['pointerup', at(to)],
  ] as const) {
    slider(sheet).dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX: x, bubbles: true }));
  }
}

/**
 * Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. The
 * deadline is generous on purpose: it is only ever reached by a machine running the whole suite at
 * once, and a wait that gives up early there fails a test with nothing wrong.
 */
async function until(what: string, ready: () => boolean, ms = 5000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/** A flat picture as a data URL, standing in for a layer's bitmap. */
function picture(width: number, height: number): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  g.fillStyle = '#ff3b6b';
  g.fillRect(0, 0, width, height);
  return canvas.toDataURL('image/png');
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.closePanel();
    store.dispose();
    column.remove();
  }
});

describe('ve-animation-sheet', () => {
  it('opens a still layer on In, with None chosen and a tile for every entrance', async () => {
    const { sheet } = await mount();

    expect(tabs(sheet)).toEqual(['In', 'Out', 'Loop']);
    expect(activeTab(sheet)).toBe('In');
    expect(labels(sheet)).toEqual(['None', ...OVERLAY_ANIMATIONS.in.map(preset => preset.label)]);
    expect(names(sheet)[0]).toBe('None, selected');
    expect(
      names(sheet)
        .slice(1)
        .every(name => !name?.endsWith(', selected')),
    ).toBe(true);
    // None is a tile in the row, and the frame's own None in the head is not drawn beside it.
    expect(head(sheet, '.sheet__icon-btn--dim')).toBeNull();
    expect(head(sheet, '[aria-label="Done"]')).not.toBeNull();
  });

  it('puts a preset on with a tap, and moves the choice into the tile’s name', async () => {
    const { store, sheet } = await mount();

    tile(sheet, 'Pop').click();

    expect(layer(store).animation).toEqual({ in: { id: 'pop', durationMs: 470 } });
    await until('the name to follow', () => tile(sheet, 'Pop').getAttribute('aria-label') === 'Pop, selected');
    expect(tile(sheet, 'None').getAttribute('aria-label')).toBe('None');
    expect(tiles(sheet).filter(button => button.classList.contains('an__tile--on'))).toHaveLength(1);
    // Never `aria-pressed`: on the A13's WebView its changes never reach Android's tree.
    expect(sheet.shadowRoot!.querySelector('[aria-pressed]')).toBeNull();
    // And the move played on the frame, from a moment before the layer arrives.
    expect(store.playheadMs.value).toBe(700);
  });

  it('takes the part off with None, and leaves the others', async () => {
    const { store, sheet } = await mount(sticker({ animation: { in: { id: 'fade', durationMs: 500 }, loop: { id: 'pulse', periodMs: 1000 } } }));
    expect(names(sheet)).toContain('Fade, selected');

    tile(sheet, 'None').click();

    expect(layer(store).animation).toEqual({ loop: { id: 'pulse', periodMs: 1000 } });
    await until('None to be chosen', () => tile(sheet, 'None').getAttribute('aria-label') === 'None, selected');
  });

  it('switches the row with the tabs, each at its own tiles and starting at the first', async () => {
    const { sheet } = await mount();
    row(sheet).scrollLeft = 200;

    tab(sheet, 'Out').click();
    await until('the out row', () => labels(sheet)[1] === OVERLAY_ANIMATIONS.out[0].label && labels(sheet).length === OVERLAY_ANIMATIONS.out.length + 1);
    expect(labels(sheet)).toEqual(['None', ...OVERLAY_ANIMATIONS.out.map(preset => preset.label)]);
    expect(row(sheet).scrollLeft).toBe(0);
    expect(activeTab(sheet)).toBe('Out');

    tab(sheet, 'Loop').click();
    await until('the loop row', () => labels(sheet)[1] === 'Pulse');
    expect(labels(sheet)).toEqual(['None', ...OVERLAY_ANIMATIONS.loop.map(preset => preset.label)]);
  });

  it('opens on the part the layer has, with its tile brought into the middle of the row', async () => {
    const { sheet } = await mount(sticker({ animation: { loop: { id: 'breathe', periodMs: 2000 } } }));

    expect(activeTab(sheet)).toBe('Loop');
    expect(tile(sheet, 'Breathe').getAttribute('aria-label')).toBe('Breathe, selected');
    const strip = row(sheet);
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    await until('the row to be scrolled to it', () => strip.scrollLeft > 0);
  });

  it('holds the length out of reach until the part has a move, saying what a tap would start at', async () => {
    const { sheet } = await mount();

    expect(lengthRow(sheet).classList.contains('an__length--off')).toBe(true);
    expect(lengthRow(sheet).getAttribute('aria-disabled')).toBe('true');
    expect(getComputedStyle(lengthRow(sheet)).pointerEvents).toBe('none');
    expect(slider(sheet).tabIndex).toBe(-1);
    // Not `inert`: Chrome 99 ignores it, and a WebView that honours it hides the readout.
    expect(lengthRow(sheet).hasAttribute('inert')).toBe(false);
    expect(readout(sheet)).toBe('0.5s');
    expect(sheet.shadowRoot!.textContent).toContain('Duration');

    tile(sheet, 'Flicker').click();
    await until('the row to wake', () => !lengthRow(sheet).classList.contains('an__length--off'));
    expect(slider(sheet).tabIndex).toBe(0);
    expect(slider(sheet).getAttribute('aria-label')).toBe('Animation duration');
    expect(readout(sheet)).toBe('0.8s');
  });

  it('sets the duration live with the slider, and the chosen tile moves at it', async () => {
    const { store, sheet } = await mount(sticker({ animation: { in: { id: 'rise', durationMs: 500 } } }));
    const span = MAX_OVERLAY_MOVE_MS - MIN_OVERLAY_MOVE_MS;

    drag(sheet, (500 - MIN_OVERLAY_MOVE_MS) / span, (1500 - MIN_OVERLAY_MOVE_MS) / span);

    expect(layer(store).animation?.in).toEqual({ id: 'rise', durationMs: 1500 });
    await until('the readout', () => readout(sheet) === '1.5s');
    const glyph = tile(sheet, 'Rise').querySelector<HTMLElement>('.an__glyph')!;
    expect(glyph.dataset.ms).toBe('1500');
    // The other tiles move at their own presets' lengths.
    expect(tile(sheet, 'Drop').querySelector<HTMLElement>('.an__glyph')!.dataset.ms).toBe('600');
  });

  it('runs Speed right for faster on Loop, and reads it as the length of one cycle', async () => {
    const { store, sheet } = await mount(sticker({ animation: { loop: { id: 'pulse', periodMs: 1000 } } }));
    expect(sheet.shadowRoot!.textContent).toContain('Speed');
    expect(slider(sheet).getAttribute('aria-label')).toBe('Animation speed');
    expect(readout(sheet)).toBe('1.0s');
    const span = MAX_OVERLAY_LOOP_MS - MIN_OVERLAY_LOOP_MS;
    // Where the knob sits for a 1 s cycle, counted from the slow end.
    const at = (periodMs: number) => (MAX_OVERLAY_LOOP_MS - periodMs) / span;
    expect(Number(slider(sheet).getAttribute('aria-valuenow'))).toBe(MIN_OVERLAY_LOOP_MS + MAX_OVERLAY_LOOP_MS - 1000);

    // Right, towards fast: a shorter cycle.
    drag(sheet, at(1000), at(500));
    expect(layer(store).animation?.loop).toEqual({ id: 'pulse', periodMs: 500 });
    await until('the readout', () => readout(sheet) === '0.5s');
    expect(slider(sheet).getAttribute('aria-valuetext')).toBe('0.5s');
  });

  it('is one undo step for everything done in one visit', async () => {
    const { store, sheet } = await mount();

    tile(sheet, 'Slam').click();
    tile(sheet, 'Swing').click();
    await until('the row to wake', () => !lengthRow(sheet).classList.contains('an__length--off'));
    const span = MAX_OVERLAY_MOVE_MS - MIN_OVERLAY_MOVE_MS;
    drag(sheet, (600 - MIN_OVERLAY_MOVE_MS) / span, (1000 - MIN_OVERLAY_MOVE_MS) / span);
    tab(sheet, 'Loop').click();
    await until('the loop row', () => labels(sheet)[1] === 'Pulse');
    tile(sheet, 'Wiggle').click();
    expect(layer(store).animation).toEqual({ in: { id: 'swing', durationMs: 1000 }, loop: { id: 'wiggle', periodMs: 1000 } });

    head(sheet, '[aria-label="Done"]')!.click();
    expect(store.panel.value).toBeNull();

    store.undo();
    expect('animation' in layer(store)).toBe(false);
    expect(store.canUndo.value).toBe(false);
  });

  it('offers an effect a fade in and a fade out, and nothing to loop', async () => {
    const { store, sheet } = await mount(effect());

    expect(tabs(sheet)).toEqual(['In', 'Out']);
    expect(labels(sheet)).toEqual(['None', 'Fade']);
    tile(sheet, 'Fade').click();
    expect(layer(store).animation).toEqual({ in: { id: 'fade', durationMs: 500 } });

    tab(sheet, 'Out').click();
    await until('the out row', () => activeTab(sheet) === 'Out');
    expect(labels(sheet)).toEqual(['None', 'Fade']);
    tile(sheet, 'Fade').click();
    expect(layer(store).animation?.out).toEqual({ id: 'fade', durationMs: 400 });
  });

  it('draws the layer’s own bitmap on every tile, and moves it', async () => {
    const { store, sheet } = await mount();
    const png = picture(40, 20);
    const bitmap: OverlayBitmap = { png, wPx: 240, hPx: 120, key: 'k', scale: 1, frameW: 720, frameH: 1280 };
    store.bitmaps.value = new Map([['st-1', bitmap]]);

    await until('the bitmap on the tiles', () => tile(sheet, 'Pop').querySelector('img')?.getAttribute('src') === png);
    const img = tile(sheet, 'Pop').querySelector('img')!;
    // Fitted into the glyph box with the layer's own shape: as wide as the box, half as tall again.
    expect(img.getBoundingClientRect().width).toBeCloseTo(48, 0);
    expect(img.getBoundingClientRect().height).toBeCloseTo(24, 0);

    // The pop tile arrives, holds and goes round again: over a pass it is seen both off the tile
    // and part way through the move, which is to say it moves.
    const glyph = tile(sheet, 'Pop').querySelector<HTMLElement>('.an__glyph')!;
    const seen = new Set<string>();
    await until('the tile to move', () => {
      seen.add(`${glyph.style.opacity}|${glyph.style.transform}`);
      return glyph.style.opacity === '0' && [...seen].some(style => style.includes('scale('));
    });
  });

  it('holds every tile at rest for a customer who has asked for less motion', async () => {
    const { sheet } = await mount();
    const glyph = () => tile(sheet, 'Slide left').querySelector<HTMLElement>('.an__glyph')!;
    const session = cdp();
    try {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await until('the tile at rest', () => glyph().style.transform === 'none' && glyph().style.opacity === '1');
      // And staying there for longer than a pass of the tile.
      const pass = performance.now() + 1800;
      while (performance.now() < pass) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        expect(glyph().style.opacity).toBe('1');
      }

      // And moving again once the setting allows it, which nothing but the setting's own change starts.
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await until('the tile to move again', () => glyph().style.opacity !== '1');
    } finally {
      await session.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    }
  }, 20_000);

  it('closes with the tick', async () => {
    const { store, sheet } = await mount();
    head(sheet, '[aria-label="Done"]')!.click();
    expect(store.panel.value).toBeNull();
  });

  it('asks the shell to close when there is no layer to animate', async () => {
    const { store, sheet } = await mount(null);
    expect(tiles(sheet)).toEqual([]);
    await until('the panel to close itself', () => store.panel.value === null);
  });

  it('stays short enough to leave the picture on screen', async () => {
    const { sheet } = await mount();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const body = sheet.shadowRoot!.querySelector<HTMLElement>('.an')!;
    const headEl = frame(sheet)!.shadowRoot!.querySelector<HTMLElement>('.sheet__head');
    const total = body.getBoundingClientRect().height + (headEl?.getBoundingClientRect().height ?? 53);
    // The transition sheet's compact figure, which this one is budgeted well inside.
    expect(total).toBeLessThanOrEqual(259);
  });
});
