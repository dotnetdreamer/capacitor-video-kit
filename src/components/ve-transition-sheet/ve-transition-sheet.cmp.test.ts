import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { DEFAULT_TRANSITION_MS, emptyManifest, type EditClip, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM. The chosen tile is brought into the middle of a row that
 * scrolls sideways, the duration is a finger on a laid out bar, and the tiles are canvases whose
 * pixels are the point - in a mock DOM every one of those answers zero.
 *
 * Three clips, so the sheet has a cut to dress and another to apply it to. The sheet is opened the
 * way the dot opens it, through `openTransition`, because that is what starts the history group the
 * whole visit folds into.
 */

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function clip(id: string, clipKey: string, outMs = 4000): EditClip {
  return { id, clipKey, inMs: 0, outMs, speed: 1, volume: 1, muted: false };
}

function manifest(clips: EditClip[]): EditManifest {
  return { ...emptyManifest(), clips };
}

async function mount(clips: EditClip[] = [clip('seg-a', 'clip-a'), clip('seg-b', 'clip-b'), clip('seg-c', 'clip-c')], into = 'seg-b') {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  const keys = [...new Set(clips.map(c => c.clipKey))];
  store.load(
    keys.map(key => ({ key, fileName: `${key}.mp4` })),
    new Map(clips.map(c => [c.clipKey, c.outMs])),
    manifest(clips),
  );
  return { store, ...(await open(store, ctx, into)) };
}

async function open(store: EditorStore, ctx: EditorContext, into: string) {
  store.openTransition(into);

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; display: flex; flex-direction: column; height: 340px';
  document.body.append(column);

  const sheet = document.createElement('ve-transition-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);
  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  return { sheet, ctx };
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
  return sheet.shadowRoot!.querySelector<HTMLElement>('.ts__row')!;
}

function tiles(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.ts__tile') ?? [])];
}

function labels(sheet: HTMLElement): (string | null)[] {
  return tiles(sheet).map(button => button.querySelector('.ts__label')?.textContent ?? null);
}

function tile(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = tiles(sheet).find(button => button.querySelector('.ts__label')?.textContent === label);
  if (!found) throw new Error(`no ${label} tile`);
  return found;
}

function durationRow(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector<HTMLElement>('.ts__duration') ?? null;
}

function readout(sheet: HTMLElement): string | null {
  return sheet.shadowRoot?.querySelector('.ts__duration-value')?.textContent ?? null;
}

function slider(sheet: HTMLElement): HTMLElement {
  return sheet.shadowRoot!.querySelector<HTMLElement>('ve-slider')!;
}

function applyAll(sheet: HTMLElement): HTMLButtonElement | null {
  return sheet.shadowRoot?.querySelector<HTMLButtonElement>('.ts__apply-all') ?? null;
}

const kinds = (store: EditorStore) => store.manifest.value.clips.map(c => c.transitionIn?.kind ?? null);

let pointerId = 100;

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

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/** The colour at the middle of a tile's canvas, 0..255. */
function middle(canvas: HTMLCanvasElement): [number, number, number, number] {
  const g = canvas.getContext('2d')!;
  const [r, gr, b, a] = g.getImageData(Math.floor(canvas.width / 2), Math.floor(canvas.height / 2), 1, 1).data;
  return [r, gr, b, a];
}

/** A whole canvas's pixels, for telling one drawing from another. */
function pixels(canvas: HTMLCanvasElement): string {
  return Array.from(canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data).join(',');
}

function canvasOf(sheet: HTMLElement, label: string): HTMLCanvasElement {
  return tile(sheet, label).querySelector('canvas')!;
}

/** A flat colour as a frame URL, the way a filmstrip hands the sheet its pictures. */
function flat(colour: string): string {
  const canvas = document.createElement('canvas');
  canvas.width = 90;
  canvas.height = 160;
  const g = canvas.getContext('2d')!;
  g.fillStyle = colour;
  g.fillRect(0, 0, 90, 160);
  return canvas.toDataURL('image/png');
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.closePanel();
    store.dispose();
    column.remove();
  }
});

describe('ve-transition-sheet', () => {
  it('opens a plain cut on Basic, with None in the head and every basic transition in the row', async () => {
    const { sheet } = await mount();

    expect(activeTab(sheet)).toBe('Basic');
    expect(head(sheet, '.sheet__icon-btn--dim')?.getAttribute('aria-label')).toBe('None');
    expect(labels(sheet)).toEqual(['Dissolve', 'Blur', 'Black', 'White', 'Bloom', 'Slide left', 'Slide right', 'Slide up', 'Slide down']);
    expect(tiles(sheet).every(button => button.getAttribute('aria-pressed') === 'false')).toBe(true);
  });

  it('switches the row with the tabs, starting each at its first tile', async () => {
    const { sheet } = await mount();
    row(sheet).scrollLeft = 200;

    tab(sheet, 'Camera').click();
    await until('the camera row', () => labels(sheet)[0] === 'Zoom in');
    expect(labels(sheet)).toEqual(['Zoom in', 'Zoom out', 'Spin', 'Shake', 'Whip left', 'Whip right']);
    expect(row(sheet).scrollLeft).toBe(0);

    tab(sheet, 'Mask').click();
    await until('the mask row', () => labels(sheet)[0] === 'Wipe left');
    expect(labels(sheet)).toHaveLength(8);

    tab(sheet, 'Effect').click();
    await until('the effect row', () => labels(sheet)[0] === 'Flash');
    expect(labels(sheet)).toEqual(['Flash', 'Pixelate', 'Glitch', 'Burn']);
  });

  it('opens a dressed cut on its own tab, with its tile in the middle of the row', async () => {
    const clips = [clip('seg-a', 'clip-a'), { ...clip('seg-b', 'clip-b'), transitionIn: { kind: 'slide-down', durationMs: 800 } }, clip('seg-c', 'clip-c')];
    const { sheet } = await mount(clips);

    expect(activeTab(sheet)).toBe('Basic');
    expect(tile(sheet, 'Slide down').getAttribute('aria-pressed')).toBe('true');
    const strip = row(sheet);
    expect(strip.scrollWidth).toBeGreaterThan(strip.clientWidth);
    await until('the row to be scrolled to it', () => strip.scrollLeft > 0);
    // The last tile of nine cannot be brought quite to the middle; it is brought as far as the row goes.
    expect(strip.scrollLeft).toBe(strip.scrollWidth - strip.clientWidth);
  });

  it('puts a transition on the cut with a tap, and marks that tile', async () => {
    const { store, sheet } = await mount();

    tile(sheet, 'Slide left').click();

    expect(kinds(store)).toEqual([null, 'slide-left', null]);
    expect(store.manifest.value.clips[1].transitionIn?.durationMs).toBe(DEFAULT_TRANSITION_MS);
    await until('the tile to follow', () => tile(sheet, 'Slide left').getAttribute('aria-pressed') === 'true');
    expect(tiles(sheet).filter(button => button.classList.contains('ts__tile--on'))).toHaveLength(1);
  });

  it('takes the transition off with None', async () => {
    const { store, sheet } = await mount();
    tile(sheet, 'Dissolve').click();
    expect(kinds(store)).toEqual([null, 'dissolve', null]);

    head(sheet, '.sheet__icon-btn--dim')!.click();

    expect(kinds(store)).toEqual([null, null, null]);
    await until('no tile marked', () => tiles(sheet).every(button => button.getAttribute('aria-pressed') === 'false'));
  });

  it('shows the duration as a number a test can read, and holds the row out of reach on a plain cut', async () => {
    const { sheet } = await mount();

    // A plain cut: dimmed, inert, and saying what a transition would start at.
    expect(durationRow(sheet)!.classList.contains('ts__duration--off')).toBe(true);
    expect(durationRow(sheet)!.inert).toBe(true);
    expect(readout(sheet)).toBe('0.5s');

    tile(sheet, 'Dissolve').click();
    await until('the row to wake', () => !durationRow(sheet)!.classList.contains('ts__duration--off'));
    expect(durationRow(sheet)!.inert).toBe(false);
    expect(readout(sheet)).toBe('0.5s');
    expect(slider(sheet).getAttribute('aria-valuemax')).toBe('2000');
    expect(slider(sheet).getAttribute('aria-valuetext')).toBe('0.5s');
  });

  it('follows the slider live, and lands the drag as part of the visit', async () => {
    const { store, sheet } = await mount();
    tile(sheet, 'Dissolve').click();
    await until('the row to wake', () => !durationRow(sheet)!.inert);

    // 100 to 2000 ms across the bar, so the far end is two seconds.
    drag(sheet, (500 - 100) / 1900, 1);

    expect(store.manifest.value.clips[1].transitionIn).toEqual({ kind: 'dissolve', durationMs: 2000 });
    expect(store.targetBoundary.value?.effectiveMs).toBe(2000);
    await until('the readout', () => readout(sheet) === '2.0s');
  });

  it('is one undo step for everything done in one visit', async () => {
    const { store, sheet } = await mount();

    tile(sheet, 'Dissolve').click();
    tab(sheet, 'Camera').click();
    await until('the camera row', () => labels(sheet)[0] === 'Zoom in');
    tile(sheet, 'Spin').click();
    await until('the row to wake', () => !durationRow(sheet)!.inert);
    drag(sheet, (500 - 100) / 1900, (1200 - 100) / 1900);
    expect(store.manifest.value.clips[1].transitionIn).toEqual({ kind: 'spin', durationMs: 1200 });

    head(sheet, '[aria-label="Done"]')!.click();
    expect(store.panel.value).toBeNull();

    store.undo();
    expect(kinds(store)).toEqual([null, null, null]);
    expect(store.canUndo.value).toBe(false);
  });

  it('closes with the tick', async () => {
    const { store, sheet } = await mount();

    head(sheet, '[aria-label="Done"]')!.click();

    expect(store.panel.value).toBeNull();
    expect(store.transitionTarget.value).toBeNull();
  });

  it('puts the transition on every cut, as a step of its own, and says so', async () => {
    const { store, sheet } = await mount();
    tile(sheet, 'Blur').click();

    applyAll(sheet)!.click();

    expect(kinds(store)).toEqual([null, 'blur', 'blur']);
    expect(store.toast.value?.text).toBe('Transition applied to all clips');

    // Its own step: undo takes the other cut back and leaves the one being dressed.
    store.undo();
    expect(kinds(store)).toEqual([null, 'blur', null]);
  });

  it('offers nothing to apply everywhere when there is only the one cut', async () => {
    const { sheet } = await mount([clip('seg-a', 'clip-a'), clip('seg-b', 'clip-b')]);

    expect(applyAll(sheet)).toBeNull();
  });

  it('says so instead of offering a slider when the clips are too short to hold a transition', async () => {
    const { sheet } = await mount([clip('seg-a', 'clip-a', 150), clip('seg-b', 'clip-b', 150)]);

    expect(durationRow(sheet)).toBeNull();
    expect(sheet.shadowRoot?.querySelector('.ts__hint')?.textContent).toBe('These clips are too short for a transition');
  });

  it('draws the tiles on screen, leaves the rest until they are scrolled to, and keeps the chosen one moving', async () => {
    const { sheet } = await mount();
    const box = row(sheet).getBoundingClientRect();
    const onScreen = () => tiles(sheet).filter(button => button.getBoundingClientRect().left < box.right);
    const drawn = (button: HTMLButtonElement) => {
      const [r, , , a] = middle(button.querySelector('canvas')!);
      return a === 255 && r > 0;
    };

    // No filmstrip has been cut, so every tile is its stand-ins: never an empty black square.
    expect(onScreen().length).toBeGreaterThan(3);
    await until('the tiles on screen to be drawn', () => onScreen().every(drawn));
    // The last of nine is well past the right edge and the margin the observer draws ahead by.
    expect(drawn(tile(sheet, 'Slide down'))).toBe(false);
    row(sheet).scrollLeft = row(sheet).scrollWidth;
    await until('the far tile to be drawn once it is scrolled to', () => drawn(tile(sheet, 'Slide down')));

    tile(sheet, 'Slide left').click();
    const canvas = canvasOf(sheet, 'Slide left');
    const seen = new Set<string>();
    await until(
      'the tile to move',
      () => {
        seen.add(pixels(canvas));
        return seen.size >= 3;
      },
      3000,
    );
  });

  it('draws the customer’s own two frames through the transition', async () => {
    const { store, sheet } = await mount();
    // The outgoing clip is red and the incoming one blue; a dissolve's poster is half way.
    store.filmstrips.value = new Map([
      ['clip-a', { stepMs: 1000, urls: [flat('#f00'), flat('#f00'), flat('#f00'), flat('#f00')] }],
      ['clip-b', { stepMs: 1000, urls: [flat('#00f'), flat('#00f'), flat('#00f'), flat('#00f')] }],
    ]);

    const canvas = canvasOf(sheet, 'Dissolve');
    await until('the frames to be drawn in', () => {
      const [r, , b] = middle(canvas);
      return r > 100 && b > 100;
    });
    const [r, gr, b] = middle(canvas);
    expect(Math.abs(r - b)).toBeLessThanOrEqual(8);
    expect(gr).toBeLessThanOrEqual(4);

    // The same pair behind a wipe: red on the side the edge has not reached, blue behind it.
    tab(sheet, 'Mask').click();
    await until('the mask row', () => labels(sheet)[0] === 'Wipe left');
    const wipe = canvasOf(sheet, 'Wipe right');
    await until('the wipe to be drawn', () => {
      const g = wipe.getContext('2d')!;
      const w = wipe.width;
      const y = Math.floor(wipe.height / 2);
      const leftPx = g.getImageData(2, y, 1, 1).data;
      const rightPx = g.getImageData(w - 3, y, 1, 1).data;
      return leftPx[2] > 200 && leftPx[0] < 40 && rightPx[0] > 200 && rightPx[2] < 40;
    });
  });

  it('fits every row in the budget the compact sheet was drawn to', async () => {
    const { sheet } = await mount();
    tile(sheet, 'Dissolve').click();
    await until('the row to wake', () => !durationRow(sheet)!.inert);
    expect(applyAll(sheet)).not.toBeNull();

    // The figure `ve-transition-sheet.css` budgets against the shell's `min(340px, 42vh)`, safe
    // area aside. A row added to the sheet has to be paid for there before it can pass here.
    expect(Math.round(sheet.getBoundingClientRect().height)).toBeLessThanOrEqual(259);
  });

  it('follows another dot tapped while it is open', async () => {
    const clips = [clip('seg-a', 'clip-a'), clip('seg-b', 'clip-b'), { ...clip('seg-c', 'clip-c'), transitionIn: { kind: 'burn', durationMs: 500 } }];
    const { store, sheet } = await mount(clips);
    expect(activeTab(sheet)).toBe('Basic');

    store.openTransition('seg-c');

    await until('the other cut’s tab', () => activeTab(sheet) === 'Effect');
    expect(tile(sheet, 'Burn').getAttribute('aria-pressed')).toBe('true');
  });
});
