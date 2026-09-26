import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { MAX_ZOOM_RAMP_MS, MAX_ZOOM_SCALE, MIN_ZOOM_SCALE, emptyManifest, type EditManifest, type EditZoom } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because two of the three controls are sliders, and a slider's
 * value is a question about where a finger landed on a laid out bar.
 *
 * What is under test is what the sheet promises the store and the phone: the level and the ramp are
 * written live and each drag is ONE undo step; the chosen curve is in the tile's NAME and never in
 * `aria-pressed`, which the A13's WebView loses; the readouts say `2.0x` and `Instant`; and the sheet
 * stays short enough for the picture above it to be worth dragging a box on.
 */

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function zoom(over: Partial<EditZoom> = {}): EditZoom {
  return { id: 'zm-1', startMs: 1000, endMs: 5000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 700, ease: 'smooth', ...over };
}

function manifestWith(zooms: EditZoom[]): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 10_000, speed: 1, volume: 1, muted: false }],
    zooms,
  };
}

/** The sheet over a store holding one zoom, opened the way the tool row opens it. */
async function mount(z: EditZoom | null = zoom()): Promise<{ store: EditorStore; sheet: HTMLElement; ctx: EditorContext; column: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 10_000]]), manifestWith(z ? [z] : []));
  if (z) store.openZoom(z.id);
  else store.openPanel('zoom');

  // The A13's editor column, with the compact sheet's own cap as its height.
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 340px; display: flex; flex-direction: column';
  document.body.append(column);
  mounted.push({ store, column });

  const sheet = await mountSheet(ctx, column);
  return { store, sheet, ctx, column };
}

/**
 * A sheet element of its own over `ctx`, as the editor puts one in each time the zoom panel opens:
 * it swaps the sheet for the tool row when the panel closes, so every Edit is a new element.
 */
async function mountSheet(ctx: EditorContext, column: HTMLElement): Promise<HTMLElement> {
  const sheet = document.createElement('ve-zoom-sheet');
  Object.assign(sheet, { ctx });
  column.append(sheet);

  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  for (const s of sliders(sheet)) await (s as StencilElement).componentOnReady?.();
  return sheet;
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function sliders(sheet: HTMLElement): HTMLElement[] {
  return Array.from(sheet.shadowRoot?.querySelectorAll<HTMLElement>('ve-slider') ?? []);
}

function slider(sheet: HTMLElement, label: string): HTMLElement {
  return sheet.shadowRoot!.querySelector<HTMLElement>(`ve-slider[aria-label="${label}"]`)!;
}

function readout(sheet: HTMLElement, which: 'level' | 'ramp'): string {
  return sheet.shadowRoot!.querySelector(`[data-readout="${which}"]`)!.textContent!.trim();
}

function chip(sheet: HTMLElement, ease: string): HTMLButtonElement {
  return sheet.shadowRoot!.querySelector<HTMLButtonElement>(`[data-ease="${ease}"]`)!;
}

function current(store: EditorStore): EditZoom {
  return store.manifest.value.zooms[0];
}

let pointerId = 0;

/** One whole drag along a bar, from one fraction of it to another, exactly as a finger does it. */
function drag(el: HTMLElement, from: number, to: number): void {
  const bar = el.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
  const at = (f: number) => bar.left + f * bar.width;
  pointerId += 1;
  const fire = (type: string, clientX: number) => el.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX, bubbles: true }));
  fire('pointerdown', at(from));
  fire('pointermove', at((from + to) / 2));
  fire('pointermove', at(to));
  fire('pointerup', at(to));
}

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

/** Where a level sits along the level bar, 0..1. */
const levelAt = (scale: number) => (scale - MIN_ZOOM_SCALE) / (MAX_ZOOM_SCALE - MIN_ZOOM_SCALE);

describe('ve-zoom-sheet', () => {
  it('shows the level, the three curves, the ramp and the one line about the box', async () => {
    const { sheet } = await mount();

    expect(head(sheet, '.sheet__title')?.textContent).toBe('Zoom');
    expect(head(sheet, '[aria-label="Done"]')).not.toBe(null);
    expect(readout(sheet, 'level')).toBe('2.0x');
    expect(readout(sheet, 'ramp')).toBe('0.7s');
    expect(sliders(sheet).map(s => s.getAttribute('aria-label'))).toEqual(['Zoom level', 'Zoom ramp']);
    const text = sheet.shadowRoot!.textContent!;
    expect(text).toContain('Level');
    expect(text).toContain('Smoothness');
    expect(text).toContain('Ramp');
    expect(sheet.shadowRoot!.querySelector('.zs__hint')!.textContent!.trim()).toBe('Drag or pinch the box on the video to pick the area');
  });

  it('says a tap brings the box back once the timeline has moved the picture to the zoomed result', async () => {
    const { store, sheet } = await mount();
    const hint = () => sheet.shadowRoot!.querySelector('.zs__hint')!.textContent!.trim();

    store.seek(2500);
    await until('the result hint', () => hint() === 'Tap the video to change the area');
    store.showZoomArea();
    await until('the area hint', () => hint() === 'Drag or pinch the box on the video to pick the area');
  });

  it('puts the chosen curve in the name, never in aria-pressed', async () => {
    const { store, sheet } = await mount();

    expect(chip(sheet, 'smooth').getAttribute('aria-label')).toBe('Smooth, selected');
    expect(chip(sheet, 'snappy').getAttribute('aria-label')).toBe('Snappy');
    expect(chip(sheet, 'steady').getAttribute('aria-label')).toBe('Steady');

    chip(sheet, 'snappy').click();
    expect(current(store).ease).toBe('snappy');
    await until('the name to follow', () => chip(sheet, 'snappy').getAttribute('aria-label') === 'Snappy, selected');
    expect(chip(sheet, 'smooth').getAttribute('aria-label')).toBe('Smooth');
    expect(sheet.shadowRoot!.querySelector('[aria-pressed]')).toBe(null);
  });

  it('writes the level live and makes the whole drag one undo step', async () => {
    const { store, sheet } = await mount();
    expect(store.canUndo.value).toBe(false);

    drag(slider(sheet, 'Zoom level'), levelAt(2), levelAt(3));

    expect(current(store).scale).toBeCloseTo(3, 1);
    await until('the readout', () => readout(sheet, 'level') === `${current(store).scale.toFixed(1)}x`);

    // A second drag of the same slider is a step of its own, not folded into the first.
    drag(slider(sheet, 'Zoom level'), levelAt(3), levelAt(2.5));
    expect(current(store).scale).toBeCloseTo(2.5, 1);

    store.undo();
    expect(current(store).scale).toBeCloseTo(3, 1);
    store.undo();
    expect(current(store).scale).toBe(2);
    // Two drags, two steps, and nothing behind them.
    expect(store.canUndo.value).toBe(false);
  });

  /*
   * What the iOS simulator showed: Level 2.0x to 3.0x, Done, Edit, 4.0x, Done, and one Undo went all
   * the way back to 2.0x. The sheet counted its own drags for the keys, the run they fold into is the
   * store's and outlived it, so the second sheet's first drag had the first sheet's first key and
   * joined its undo step.
   */
  it('keeps a drag in a sheet opened again out of the step the last sheet made', async () => {
    const { store, sheet, ctx, column } = await mount();

    drag(slider(sheet, 'Zoom level'), levelAt(2), levelAt(3));
    expect(current(store).scale).toBeCloseTo(3, 1);

    // Done, then Edit on the bar: the editor takes this sheet out and puts a new one in.
    head(sheet, '[aria-label="Done"]')!.click();
    expect(store.panel.value).toBe(null);
    sheet.remove();
    store.openZoom(current(store).id);
    const again = await mountSheet(ctx, column);

    drag(slider(again, 'Zoom level'), levelAt(3), levelAt(4));
    expect(current(store).scale).toBeCloseTo(4, 1);

    store.undo();
    expect(current(store).scale).toBeCloseTo(3, 1);
    store.undo();
    expect(current(store).scale).toBe(2);
    expect(store.canUndo.value).toBe(false);
  });

  it('writes the ramp, and reads a ramp of nothing as Instant', async () => {
    const { store, sheet } = await mount();

    drag(slider(sheet, 'Zoom ramp'), 700 / MAX_ZOOM_RAMP_MS, 0);

    expect(current(store).rampMs).toBe(0);
    await until('Instant', () => readout(sheet, 'ramp') === 'Instant');

    drag(slider(sheet, 'Zoom ramp'), 0, 1500 / MAX_ZOOM_RAMP_MS);
    expect(current(store).rampMs).toBe(1500);
    await until('the seconds', () => readout(sheet, 'ramp') === '1.5s');
  });

  it('keeps a template push-in a push-in when its ramp is dragged, even through nothing and back', async () => {
    // A push-in held to the cut, longer than the slider reaches: the readout says what is stored.
    const { store, sheet } = await mount(zoom({ rampMs: 4000, rampOutMs: 0 }));
    expect(readout(sheet, 'ramp')).toBe('4.0s');

    drag(slider(sheet, 'Zoom ramp'), 1, 1000 / MAX_ZOOM_RAMP_MS);
    expect(current(store)).toMatchObject({ rampMs: 1000, rampOutMs: 0 });
    await until('the seconds', () => readout(sheet, 'ramp') === '1.0s');

    // One drag down to Instant and back up is scaled from where it began, not from the 0 it passed.
    const bar = slider(sheet, 'Zoom ramp');
    const track = bar.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
    const at = (ms: number) => track.left + (ms / MAX_ZOOM_RAMP_MS) * track.width;
    pointerId += 1;
    const fire = (type: string, ms: number) => bar.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX: at(ms), bubbles: true }));
    fire('pointerdown', 1000);
    fire('pointermove', 0);
    expect(current(store)).toMatchObject({ rampMs: 0, rampOutMs: 0 });
    fire('pointermove', 1500);
    fire('pointerup', 1500);
    expect(current(store)).toMatchObject({ rampMs: 1500, rampOutMs: 0 });
  });

  it('scales a pull-out by its ramp out, the one the slider shows', async () => {
    const { store, sheet } = await mount(zoom({ rampMs: 0, rampOutMs: 1600 }));
    expect(readout(sheet, 'ramp')).toBe('1.6s');

    drag(slider(sheet, 'Zoom ramp'), 1600 / MAX_ZOOM_RAMP_MS, 800 / MAX_ZOOM_RAMP_MS);
    expect(current(store)).toMatchObject({ rampMs: 0, rampOutMs: 800 });
    await until('the seconds', () => readout(sheet, 'ramp') === '0.8s');
  });

  it('closes the panel on the tick', async () => {
    const { store, sheet } = await mount();
    head(sheet, '[aria-label="Done"]')!.click();
    expect(store.panel.value).toBe(null);
  });

  it('asks the shell to close when there is no zoom to set', async () => {
    const { store, sheet } = await mount(null);
    expect(sliders(sheet)).toEqual([]);
    await until('the panel to close itself', () => store.panel.value === null);
  });

  it('closes when undo takes the zoom away', async () => {
    const { store } = await mount(null);
    await until('the empty sheet to close', () => store.panel.value === null);
    store.seek(2000);
    store.addZoomAtPlayhead();
    expect(store.panel.value).toBe('zoom');

    store.undo();
    await until('the sheet to close', () => store.panel.value === null);
  });

  it('stays short enough to leave the picture on screen', async () => {
    const { sheet } = await mount();
    await new Promise(resolve => requestAnimationFrame(resolve));
    const body = sheet.shadowRoot!.querySelector<HTMLElement>('.zs')!;
    const headEl = frame(sheet)!.shadowRoot!.querySelector<HTMLElement>('.sheet__head');
    const total = body.getBoundingClientRect().height + (headEl?.getBoundingClientRect().height ?? 53);
    // The transition sheet's compact figure, which this one is budgeted well inside.
    expect(total).toBeLessThanOrEqual(259);
  });
});
