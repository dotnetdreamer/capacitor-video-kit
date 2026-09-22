// The browser provider's own types, which are what give `cdp()` a `send` to switch a media setting with.
/// <reference types="@vitest/browser-playwright" />
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cdp } from 'vitest/browser';

import type { EditorContext } from '../../bridge/editor-context';
import { DEFAULT_TRANSITION_MS, TRANSITIONS, compileTransition, emptyManifest, lookAt, transitionPreset, type EditClip, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';
import { Painter, WHOLE_FRAME } from '../../video-composer/web/painter';

import { LOOP_HOLD_END_MS, LOOP_HOLD_START_MS, LOOP_RUN_MS, ThumbPainter, prepareFrame } from './transition-thumbs';

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

/** The duration row is there and in reach: the cut has a transition. */
function awake(sheet: HTMLElement): boolean {
  const found = durationRow(sheet);
  return !!found && !found.classList.contains('ts__duration--off');
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

/** A frame whose every pixel is `colour(x, y)`, as a frame URL. */
function structured(width: number, height: number, colour: (x: number, y: number) => [number, number, number]): string {
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d')!;
  const image = g.createImageData(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, gr, b] = colour(x, y);
      const at = (y * width + x) * 4;
      image.data.set([r, gr, b, 255], at);
    }
  }
  g.putImageData(image, 0, 0);
  return canvas.toDataURL('image/png');
}

/** A frame URL decoded and brought to a `cell` px tile's size, the way the sheet keeps it. */
async function preparedFrame(url: string, cell: number): Promise<HTMLCanvasElement> {
  const img = new Image();
  img.src = url;
  await img.decode();
  return prepareFrame(img, img.naturalWidth, img.naturalHeight, cell)!;
}

/** Any canvas's pixels as numbers, 0..255, RGBA. */
function pixelsOf(source: HTMLCanvasElement): number[] {
  const canvas = document.createElement('canvas');
  canvas.width = source.width;
  canvas.height = source.height;
  const g = canvas.getContext('2d', { willReadFrequently: true })!;
  g.drawImage(source, 0, 0);
  return Array.from(g.getImageData(0, 0, canvas.width, canvas.height).data);
}

function largestDifference(a: number[], b: number[]): number {
  if (a.length !== b.length) return 255;
  let worst = 0;
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i] - b[i]));
  return worst;
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
    expect(tiles(sheet).every(button => !button.getAttribute('aria-label')?.endsWith(', selected'))).toBe(true);
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
    expect(tile(sheet, 'Slide down').getAttribute('aria-label')).toBe('Slide down, selected');
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
    await until('the tile to follow', () => tile(sheet, 'Slide left').getAttribute('aria-label') === 'Slide left, selected');
    expect(tiles(sheet).filter(button => button.classList.contains('ts__tile--on'))).toHaveLength(1);
  });

  it('takes the transition off with None', async () => {
    const { store, sheet } = await mount();
    tile(sheet, 'Dissolve').click();
    expect(kinds(store)).toEqual([null, 'dissolve', null]);

    head(sheet, '.sheet__icon-btn--dim')!.click();

    expect(kinds(store)).toEqual([null, null, null]);
    await until('no tile marked', () => tiles(sheet).every(button => !button.getAttribute('aria-label')?.endsWith(', selected')));
  });

  it('shows the duration as a number a test can read, and holds the row out of reach on a plain cut', async () => {
    const { sheet } = await mount();

    // A plain cut: dimmed, out of a finger's reach and out of the tab order, and saying what a
    // transition would start at.
    expect(durationRow(sheet)!.classList.contains('ts__duration--off')).toBe(true);
    expect(durationRow(sheet)!.getAttribute('aria-disabled')).toBe('true');
    expect(getComputedStyle(durationRow(sheet)!).pointerEvents).toBe('none');
    expect(slider(sheet).tabIndex).toBe(-1);
    expect(slider(sheet).getAttribute('aria-disabled')).toBe('true');
    // Not `inert`: Chrome 99 ignores it, and a WebView that honours it hides the readout below from
    // the accessibility tree, which is where Maestro reads it.
    expect(durationRow(sheet)!.hasAttribute('inert')).toBe(false);
    expect(readout(sheet)).toBe('0.5s');

    tile(sheet, 'Dissolve').click();
    await until('the row to wake', () => awake(sheet));
    expect(durationRow(sheet)!.hasAttribute('aria-disabled')).toBe(false);
    expect(getComputedStyle(durationRow(sheet)!).pointerEvents).toBe('auto');
    expect(slider(sheet).tabIndex).toBe(0);
    expect(slider(sheet).hasAttribute('aria-disabled')).toBe(false);
    expect(readout(sheet)).toBe('0.5s');
    expect(slider(sheet).getAttribute('aria-valuemax')).toBe('2000');
    expect(slider(sheet).getAttribute('aria-valuetext')).toBe('0.5s');
  });

  it('keeps the slider out of the tab order on a plain cut, however often it is drawn again', async () => {
    // A shorter third clip, so the cut into it holds less and the slider is drawn again with a new range.
    const { store, sheet } = await mount([clip('seg-a', 'clip-a'), clip('seg-b', 'clip-b'), clip('seg-c', 'clip-c', 3000)]);
    expect(slider(sheet).tabIndex).toBe(-1);

    store.openTransition('seg-c');
    await until('the new range', () => slider(sheet).getAttribute('aria-valuemax') === '1500');
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(slider(sheet).tabIndex).toBe(-1);
    expect(slider(sheet).getAttribute('aria-disabled')).toBe('true');
  });

  it('follows the slider live, and lands the drag as part of the visit', async () => {
    const { store, sheet } = await mount();
    tile(sheet, 'Dissolve').click();
    await until('the row to wake', () => awake(sheet));

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
    await until('the row to wake', () => awake(sheet));
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
    await until('the pill to be offered', () => !applyAll(sheet)!.disabled);

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

  it('offers Apply to all only once the cut has a transition, keeping its place until then', async () => {
    // A transition on the other cut, which a tap on the pill from a plain cut used to take away.
    const clips = [clip('seg-a', 'clip-a'), clip('seg-b', 'clip-b'), { ...clip('seg-c', 'clip-c'), transitionIn: { kind: 'burn', durationMs: 500 } }];
    const { store, sheet } = await mount(clips);
    const pill = applyAll(sheet)!;

    // There, holding its band, and neither seen, heard nor pressed.
    expect(pill.disabled).toBe(true);
    expect(getComputedStyle(pill).visibility).toBe('hidden');
    pill.click();
    expect(kinds(store)).toEqual([null, null, 'burn']);
    expect(store.toast.value).toBeNull();
    // Laid out all the same: the sheet stacks up from the bottom of the screen, so a band that
    // arrived with the first tile would lift the row under the finger that tapped it.
    const band = pill.getBoundingClientRect().height;
    expect(band).toBe(36);

    tile(sheet, 'Dissolve').click();
    await until('the pill to be offered', () => !applyAll(sheet)!.disabled);
    expect(applyAll(sheet)).toBe(pill);
    expect(getComputedStyle(pill).visibility).toBe('visible');
    expect(pill.getBoundingClientRect().height).toBe(band);

    applyAll(sheet)!.click();
    expect(kinds(store)).toEqual([null, 'dissolve', 'dissolve']);
  });

  it('says so instead of offering a slider when the clips are too short to hold a transition', async () => {
    const { sheet } = await mount([clip('seg-a', 'clip-a', 150), clip('seg-b', 'clip-b', 150)]);

    expect(durationRow(sheet)).toBeNull();
    expect(sheet.shadowRoot?.querySelector('.ts__hint')?.textContent).toBe('These clips are too short for a transition');
  });

  it('says how long the one transition that fits runs, rather than offering a slider with nowhere to go', async () => {
    // 300 ms on one side: half of it is 150, which the slider's 100 ms step holds to 100 - both ends.
    const { store, sheet } = await mount([clip('seg-a', 'clip-a'), clip('seg-b', 'clip-b', 300)]);

    expect(store.targetBoundary.value?.maxMs).toBe(100);
    expect(durationRow(sheet)).toBeNull();
    expect(sheet.shadowRoot?.querySelector('.ts__hint')?.textContent).toBe('These clips are too short for more than a 0.1s transition');

    // Which is true: a tile still puts that one on.
    tile(sheet, 'Dissolve').click();
    expect(store.manifest.value.clips[1].transitionIn).toEqual({ kind: 'dissolve', durationMs: 100 });
    await until('the tile to follow', () => tile(sheet, 'Dissolve').getAttribute('aria-label') === 'Dissolve, selected');
    expect(durationRow(sheet)).toBeNull();
  });

  /*
   * Every wait here is for something the page does, polled a frame at a time, with room for a
   * machine running the whole suite at once: this test once missed a two second wait under that load
   * with nothing wrong. A generous deadline costs nothing when the page is quick, which it is.
   */
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
    await until('the tiles on screen to be drawn', () => onScreen().every(drawn), 8000);
    // The last of nine is well past the right edge and the margin the observer draws ahead by.
    expect(drawn(tile(sheet, 'Slide down'))).toBe(false);
    row(sheet).scrollLeft = row(sheet).scrollWidth;
    await until('the far tile to be drawn once it is scrolled to', () => drawn(tile(sheet, 'Slide down')), 8000);

    tile(sheet, 'Slide left').click();
    const canvas = canvasOf(sheet, 'Slide left');
    const seen = new Set<string>();
    // Three different pictures in the tile: its loop rests 280 ms and then runs for 1200, redrawn
    // about thirty times a second, so even a starved frame rate sees three of them within a loop.
    await until(
      'the tile to move',
      () => {
        seen.add(pixels(canvas));
        return seen.size >= 3;
      },
      12000,
    );
  }, 40_000);

  it('draws every tile exactly as the render’s painter draws that moment of that transition', async () => {
    const { store, sheet } = await mount();
    // Frames with structure - an edge, a gradient each way - so a tile that differed from the render
    // anywhere, in the framing, a direction or a blur, differs in the pixels compared.
    const outgoing = structured(90, 160, (x, y) => [x < 45 ? 230 : 40, Math.round((y / 159) * 255), 60]);
    const incoming = structured(90, 160, (x, y) => [30, Math.round((x / 89) * 255), y < 80 ? 240 : 90]);
    store.filmstrips.value = new Map([
      ['clip-a', { stepMs: 1000, urls: [outgoing, outgoing, outgoing, outgoing] }],
      ['clip-b', { stepMs: 1000, urls: [incoming, incoming, incoming, incoming] }],
    ]);

    const cell = canvasOf(sheet, 'Dissolve').width;
    const from = await preparedFrame(outgoing, cell);
    const to = await preparedFrame(incoming, cell);
    const painter = new Painter({ width: cell, height: cell });
    try {
      for (const category of ['Basic', 'Camera', 'Mask', 'Effect']) {
        tab(sheet, category).click();
        await until(`the ${category} row`, () => activeTab(sheet) === category, 8000);
        for (const button of tiles(sheet)) {
          // Every tile of the row, the ones past its right edge included.
          row(sheet).scrollLeft = button.offsetLeft - 16;
          const label = button.querySelector('.ts__label')!.textContent!;
          const preset = TRANSITIONS.find(p => p.label === label)!;
          const compiled = compileTransition(preset.id)!;
          // Built here as `web/render.ts` builds it, not by the sheet's own helper.
          painter.paintLayers([
            {
              kind: 'transition',
              from: { source: from, sourceWidth: from.width, sourceHeight: from.height, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1 },
              to: { source: to, sourceWidth: to.width, sourceHeight: to.height, framing: { fit: 'cover' }, dest: WHOLE_FRAME, opacity: 1 },
              look: lookAt(compiled.curves, preset.posterAt),
              transition: compiled,
            },
          ]);
          const expected = pixelsOf(painter.frame);
          const canvas = button.querySelector('canvas')!;
          let worst = 255;
          await until(
            `${label} to be drawn as the render draws it`,
            () => {
              worst = largestDifference(pixels(canvas).split(',').map(Number), expected);
              return worst <= 2;
            },
            8000,
          );
          expect(worst, label).toBeLessThanOrEqual(2);
        }
      }
    } finally {
      painter.dispose();
    }
  }, 60_000);

  it('draws every tile with one GL context, and gives it back as the sheet leaves, visit after visit', async () => {
    const real = HTMLCanvasElement.prototype.getContext;
    const contexts: WebGL2RenderingContext[] = [];
    const spy = vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement, type: string, options?: unknown) {
      const made = (real as (this: HTMLCanvasElement, type: string, options?: unknown) => RenderingContext | null).call(this, type, options);
      if (type === 'webgl2' && made && !contexts.includes(made as WebGL2RenderingContext)) contexts.push(made as WebGL2RenderingContext);
      return made;
    });
    try {
      const { sheet } = await mount();
      const drawn = (label: string) => middle(canvasOf(sheet, label))[3] === 255;
      await until('the first tiles', () => drawn('Dissolve') && drawn('Blur'), 8000);
      // A whole visit: other rows, a far tile scrolled to, and a chosen tile moving.
      tab(sheet, 'Mask').click();
      await until('the mask row to be drawn', () => labels(sheet)[0] === 'Wipe left' && drawn('Wipe left'), 8000);
      row(sheet).scrollLeft = row(sheet).scrollWidth;
      await until('the far tile', () => drawn('Blinds'), 8000);
      tile(sheet, 'Blinds').click();
      const seen = new Set<string>();
      await until('the chosen tile to move', () => seen.add(pixels(canvasOf(sheet, 'Blinds'))).size >= 3, 12000);

      expect(contexts).toHaveLength(1);
      expect(contexts[0].isContextLost()).toBe(false);

      sheet.remove();
      await until('the context to be given back', () => contexts[0].isContextLost(), 8000);

      // The dot tapped again is a new sheet, and a new sheet is one context of its own, given back
      // in its turn: a customer going from cut to cut never holds more than the one.
      const again = await mount();
      await until('the next visit’s tiles', () => middle(canvasOf(again.sheet, 'Dissolve'))[3] === 255, 8000);
      expect(contexts).toHaveLength(2);
      expect(contexts[1].isContextLost()).toBe(false);
      again.sheet.remove();
      await until('the next visit’s context to be given back', () => contexts[1].isContextLost(), 8000);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  /*
   * The system's own setting, switched while the sheet is open, through the browser rather than a
   * stand-in for `matchMedia`: what is under test is that the sheet hears the change at all.
   */
  it('rests the chosen tile on its still when the system asks for less motion, and moves it again when it stops', async () => {
    const { sheet } = await mount();
    tile(sheet, 'Slide left').click();
    const canvas = canvasOf(sheet, 'Slide left');
    const moving = (what: string) => {
      const seen = new Set<string>();
      return until(what, () => seen.add(pixels(canvas)).size >= 3, 12000);
    };
    await moving('the chosen tile to move');

    // Its still is every other tile's: the poster moment, here on the stand-ins, as no filmstrip has been cut.
    const still = document.createElement('canvas');
    still.width = canvas.width;
    still.height = canvas.height;
    const thumbs = new ThumbPainter(canvas.width);
    thumbs.drawThumb(still, null, null, 'slide-left', transitionPreset('slide-left')!.posterAt);
    thumbs.dispose();
    const expected = pixelsOf(still);
    const atStill = () => largestDifference(pixels(canvas).split(',').map(Number), expected) <= 2;

    const session = cdp();
    try {
      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
      await until('the chosen tile to rest on its still', atStill, 8000);
      // And to stay there for a whole turn of the loop, holds included, rather than pass through it.
      const turnEnds = performance.now() + LOOP_HOLD_START_MS + LOOP_RUN_MS + LOOP_HOLD_END_MS;
      while (performance.now() < turnEnds) {
        await new Promise(resolve => requestAnimationFrame(resolve));
        expect(atStill(), 'the still moved').toBe(true);
      }

      await session.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] });
      await moving('the chosen tile to move again');
    } finally {
      await session.send('Emulation.setEmulatedMedia', { media: '', features: [] });
    }
  }, 40_000);

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

  it('keeps a frame the cut it is on still shows when the cache fills, rather than decoding it again', async () => {
    const real = HTMLImageElement.prototype.decode;
    const decoded: string[] = [];
    const settled: string[] = [];
    const spy = vi.spyOn(HTMLImageElement.prototype, 'decode').mockImplementation(function (this: HTMLImageElement) {
      const src = this.src;
      decoded.push(src);
      return real.call(this).finally(() => settled.push(src));
    });
    try {
      // Every frame its own colour, so its own URL; the two of the last cut red and blue.
      const green = (i: number) => flat(`rgb(0, ${100 + i * 12}, 0)`);
      const [b, c0, c3, d0, d3, e0, e3, f0, f1] = [flat('#f00'), flat('#00f'), ...[0, 1, 2, 3, 4, 5, 6].map(green)];
      const clips = [
        // No filmstrip: that side is its stand-in, and the first cut has a single frame to decode.
        clip('seg-a', 'clip-a'),
        // Shorter than a filmstrip step, so it enters and leaves on the same frame - which is what
        // puts one frame on two cuts.
        { ...clip('seg-b', 'clip-b', 1500), inMs: 1000 },
        clip('seg-c', 'clip-c'),
        clip('seg-d', 'clip-d'),
        clip('seg-e', 'clip-e'),
        // One shot split in two, so the cut between them is one frame on both sides.
        clip('seg-f', 'clip-f', 1500),
        { ...clip('seg-g', 'clip-f'), inMs: 1500 },
      ];
      const { store, sheet } = await mount(clips, 'seg-b');
      store.filmstrips.value = new Map([
        ['clip-b', { stepMs: 1000, urls: ['', b, ''] }],
        ['clip-c', { stepMs: 1000, urls: [c0, '', '', c3] }],
        ['clip-d', { stepMs: 1000, urls: [d0, '', '', d3] }],
        ['clip-e', { stepMs: 1000, urls: [e0, '', '', e3] }],
        ['clip-f', { stepMs: 1000, urls: [f0, f1, '', ''] }],
      ]);
      const visit = async (cut: string, urls: string[]) => {
        store.openTransition(cut);
        await until(`the frames of ${cut}`, () => urls.every(url => settled.includes(url)), 8000);
      };
      // Eight frames, the full cache, with the shared one the first to have arrived.
      await visit('seg-b', [b]);
      await visit('seg-d', [c3, d0]);
      await visit('seg-e', [d3, e0]);
      await visit('seg-f', [e3, f0]);
      await visit('seg-g', [f1]);

      // The cut that shares it: one new frame, which must not push out the one it is shown beside.
      store.openTransition('seg-c');
      await until('the shared cut to be drawn', () => {
        const [r, , bl] = middle(canvasOf(sheet, 'Dissolve'));
        return r > 100 && bl > 100;
      }, 8000);
      expect(decoded.filter(url => url === b)).toHaveLength(1);
    } finally {
      spy.mockRestore();
    }
  }, 60_000);

  it('fits every row in the budget the compact sheet was drawn to', async () => {
    const { sheet } = await mount();
    tile(sheet, 'Dissolve').click();
    await until('the row to wake', () => awake(sheet));
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
    expect(tile(sheet, 'Burn').getAttribute('aria-label')).toBe('Burn, selected');
  });
});
