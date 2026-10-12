import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, encodeSubjectTrack, type EditFocus, type EditManifest, type FindSubjectsResult } from '../../editor';
import { browserMediaHost, resolveEditorHost } from '../../host/defaults';
import type { EditorSource } from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, for the zoom sheet's reasons: the look is three sliders, and a
 * slider's value is a question about where a finger landed on a laid out bar. The subjects come the
 * way they come in the editor: the host's search, answered when the test says, with a real subject
 * track behind it that `EditorMedia` reads and parses.
 *
 * What is under test is what the sheet promises the customer and the store: it says how far the
 * search has got and why there is nothing to choose when there is not; each subject has a chip whose
 * NAME says whether it is in focus; a tap is a step of its own and a drag of a slider is one; a change
 * of focus is made at the playhead and taken off by its chip; Remove focus takes the focus off and
 * closes; and the sheet leaves the picture on screen.
 */

const mounted: { store: EditorStore; media: EditorMedia; column: HTMLElement }[] = [];

type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/** One search the test answers: its progress callback, and the two ways it can end. */
interface Search {
  progress: (value: number) => void;
  resolve: (result: FindSubjectsResult | null) => void;
  reject: (error: unknown) => void;
}

const GRID_W = 32;
const GRID_H = 18;

/** A track of two frames, 0 and 5000 ms, with subject 1 on the left half and subject 2 on the right. */
function track(subjects: number): FindSubjectsResult {
  const cells = new Uint8Array(GRID_W * GRID_H);
  for (let y = 0; y < GRID_H; y++) {
    for (let x = 0; x < GRID_W; x++) {
      if (subjects >= 1 && x >= 4 && x < 12) cells[y * GRID_W + x] = 1;
      if (subjects >= 2 && x >= 20 && x < 28) cells[y * GRID_W + x] = 2;
    }
  }
  const infos = Array.from({ length: subjects }, (_, i) => ({
    id: i + 1,
    kind: 'person' as const,
    startMs: 0,
    endMs: 5000,
    peakMs: 0,
    box: { x: i === 0 ? 0.125 : 0.625, y: 0, w: 0.25, h: 1 },
    area: 0.25,
  }));
  const bytes = encodeSubjectTrack({
    width: GRID_W,
    height: GRID_H,
    times: [0, 5000],
    frames: [cells, cells],
    meta: { engine: 'mediapipe', kind: 'video', durationMs: 10_000, fps: 10, subjects: infos },
  });
  return {
    engine: 'mediapipe',
    uri: URL.createObjectURL(new Blob([bytes as BlobPart])),
    cached: false,
    kind: 'video',
    width: GRID_W,
    height: GRID_H,
    frames: 2,
    durationMs: 10_000,
    subjects: infos,
  };
}

function manifest(): EditManifest {
  return { ...emptyManifest(), clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 10_000, speed: 1, volume: 1, muted: false }] };
}

/** The sheet, opened the way the Focus tile opens it, over a host whose search the test answers. */
async function mount(): Promise<{ store: EditorStore; sheet: HTMLElement; search: Search }> {
  let search: Search | null = null;
  const host = resolveEditorHost({
    media: {
      ...browserMediaHost(),
      findSubjects: (_source: EditorSource, onProgress: (progress: number) => void) =>
        new Promise<FindSubjectsResult | null>((resolve, reject) => {
          search = { progress: onProgress, resolve, reject };
        }),
    },
  });
  const store = new EditorStore(host);
  const media = new EditorMedia(store, host);
  const ctx: EditorContext = { store, media };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 10_000]]), manifest());
  store.openFocus();

  // The A13's editor column, with the compact sheet's own cap as its height.
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 340px; display: flex; flex-direction: column';
  document.body.append(column);
  mounted.push({ store, media, column });

  const sheet = document.createElement('ve-focus-sheet');
  Object.assign(sheet, { ctx });
  column.append(sheet);
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();

  await until('the search to start', () => search !== null);
  return { store, sheet, search: search! };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function status(sheet: HTMLElement): string | null {
  return sheet.shadowRoot?.querySelector('.fs__status')?.textContent?.trim() ?? null;
}

function chip(sheet: HTMLElement, subject: number | 'all'): HTMLButtonElement | null {
  const root = sheet.shadowRoot!;
  if (subject === 'all') return root.querySelector<HTMLButtonElement>('.fs__chips .fs__chip:first-child');
  return root.querySelector<HTMLButtonElement>(`[data-subject="${subject}"]`);
}

function changes(sheet: HTMLElement): string[] {
  return Array.from(sheet.shadowRoot!.querySelectorAll('.fs__change-time')).map(el => el.textContent!.trim());
}

function focus(store: EditorStore): EditFocus | undefined {
  return store.manifest.value.clips[0]?.focus;
}

async function ready(sheet: HTMLElement, search: Search, subjects = 2): Promise<void> {
  search.resolve(track(subjects));
  await until('the chips', () => chip(sheet, 1) !== null);
}

async function openLook(sheet: HTMLElement): Promise<void> {
  head(sheet, '[role="tab"]:nth-child(2)')!.click();
  await until('the look', () => sheet.shadowRoot!.querySelectorAll('ve-slider').length === 3);
  for (const s of Array.from(sheet.shadowRoot!.querySelectorAll('ve-slider'))) await (s as StencilElement).componentOnReady?.();
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
  for (const { store, media, column } of mounted.splice(0)) {
    media.dispose();
    store.dispose();
    column.remove();
  }
});

describe('ve-focus-sheet', () => {
  it('puts the main subject in focus as it opens, and says how far the search has got', async () => {
    const { store, sheet, search } = await mount();

    expect(head(sheet, '.sheet__title')?.textContent).toBe('Focus');
    expect(head(sheet, '[aria-label="Remove focus"]')).not.toBe(null);
    expect(focus(store)).toMatchObject({ subjects: 'main' });
    expect(status(sheet)).toBe('Finding subjects 0%');

    search.progress(0.5);
    await until('the progress', () => status(sheet) === 'Finding subjects 50%');
    expect(sheet.shadowRoot!.querySelector('[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('50');
  });

  it('says why there is nothing to choose: no subjects, no segmenter, or a clip that would not read', async () => {
    const empty = await mount();
    empty.search.resolve(track(0));
    await until('no subjects', () => status(empty.sheet) === 'No subjects found in this clip');

    const none = await mount();
    none.search.resolve(null);
    await until('not available', () => status(none.sheet) === 'Focus is not available on this device');

    const broken = await mount();
    broken.search.reject(new Error('the decoder gave up'));
    await until('could not be read', () => status(broken.sheet) === 'This clip could not be read');
  });

  it('gives each subject a chip that says in its name whether it is in focus', async () => {
    const { sheet, search } = await mount();
    await ready(sheet, search);

    expect(chip(sheet, 1)!.getAttribute('aria-label')).toBe('Subject 1, in focus');
    expect(chip(sheet, 2)!.getAttribute('aria-label')).toBe('Subject 2');
    expect(chip(sheet, 'all')!.getAttribute('aria-label')).toBe('All subjects');
    expect(sheet.shadowRoot!.querySelector('.fs__hint')!.textContent!.trim()).toBe('Tap the video to choose who stays sharp');
    expect(sheet.shadowRoot!.querySelector('[aria-pressed]')).toBe(null);
  });

  it('puts a subject in and out of focus with a tap, each tap a step of its own', async () => {
    const { store, sheet, search } = await mount();
    await ready(sheet, search);

    chip(sheet, 2)!.click();
    expect(focus(store)?.subjects).toEqual([1, 2]);
    await until('the chips to follow', () => chip(sheet, 'all')!.getAttribute('aria-label') === 'All subjects, in focus');
    expect(chip(sheet, 2)!.getAttribute('aria-label')).toBe('Subject 2, in focus');

    // Every subject in already, so All takes them all out.
    chip(sheet, 'all')!.click();
    expect(focus(store)?.subjects).toEqual([]);
    await until('nobody in focus', () => chip(sheet, 1)!.getAttribute('aria-label') === 'Subject 1');

    chip(sheet, 'all')!.click();
    expect(focus(store)?.subjects).toBe('all');

    // Three taps, three steps.
    store.undo();
    expect(focus(store)?.subjects).toEqual([]);
    store.undo();
    expect(focus(store)?.subjects).toEqual([1, 2]);
    store.undo();
    expect(focus(store)?.subjects).toBe('main');
  });

  it('makes a change of focus at the playhead, and takes it off with its chip', async () => {
    const { store, sheet, search } = await mount();
    await ready(sheet, search);
    const here = () => sheet.shadowRoot!.querySelector<HTMLButtonElement>('.fs__here')!;

    // At the clip's very first frame there is nothing before it to change from.
    here().click();
    expect(store.toast.value?.text).toBe('Move the playhead into the clip first');
    expect(focus(store)?.changes ?? []).toEqual([]);

    store.seek(4000);
    here().click();
    expect(focus(store)?.changes).toEqual([expect.objectContaining({ atMs: 4000, subjects: 'main' })]);
    await until('its chip', () => changes(sheet).join() === '4.0s');

    // From the change on, a tap changes the change's subjects and leaves the clip's own alone.
    chip(sheet, 2)!.click();
    expect(focus(store)?.changes?.[0]?.subjects).toEqual([1, 2]);
    expect(focus(store)?.subjects).toBe('main');

    sheet.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Remove focus change at 4.0s"]')!.click();
    expect(focus(store)?.changes ?? []).toEqual([]);
    await until('the chip to go', () => changes(sheet).length === 0);
  });

  it('moves the playhead to a change when its time is tapped', async () => {
    const { store, sheet, search } = await mount();
    await ready(sheet, search);
    store.seek(6500);
    sheet.shadowRoot!.querySelector<HTMLButtonElement>('.fs__here')!.click();
    await until('its chip', () => changes(sheet).join() === '6.5s');

    store.seek(1000);
    sheet.shadowRoot!.querySelector<HTMLButtonElement>('.fs__change-time')!.click();
    expect(store.playheadMs.value).toBe(6500);
  });

  it('writes the look live, a drag as one undo step, and turns the focus inside out', async () => {
    const { store, sheet, search } = await mount();
    await ready(sheet, search);
    await openLook(sheet);
    const slider = (label: string) => sheet.shadowRoot!.querySelector<HTMLElement>(`ve-slider[aria-label="${label}"]`)!;
    const readout = (key: string) => sheet.shadowRoot!.querySelector(`[data-readout="${key}"]`)!.textContent!.trim();
    expect(readout('blur')).toBe('50%');
    expect(readout('mono')).toBe('0%');

    drag(slider('Focus blur'), 0.5, 0.8);
    expect(focus(store)?.blur).toBeCloseTo(0.8, 1);
    drag(slider('Focus grey'), 0, 0.6);
    expect(focus(store)?.mono).toBeCloseTo(0.6, 1);
    await until('the readouts', () => readout('blur') === `${Math.round(focus(store)!.blur * 100)}%` && readout('mono') === `${Math.round(focus(store)!.mono! * 100)}%`);

    const invert = sheet.shadowRoot!.querySelector<HTMLButtonElement>('[role="switch"]')!;
    expect(invert.getAttribute('aria-checked')).toBe('false');
    invert.click();
    expect(focus(store)?.invert).toBe(true);
    await until('the switch', () => invert.getAttribute('aria-checked') === 'true');

    // A step each: the switch, the grey drag, the blur drag.
    store.undo();
    expect(focus(store)?.invert).toBeFalsy();
    expect(focus(store)?.mono).toBeCloseTo(0.6, 1);
    store.undo();
    expect(focus(store)?.mono ?? 0).toBe(0);
    expect(focus(store)?.blur).toBeCloseTo(0.8, 1);
    store.undo();
    expect(focus(store)?.blur).toBe(0.5);
  });

  it('takes the focus off and closes on Remove focus', async () => {
    const { store, sheet, search } = await mount();
    await ready(sheet, search);

    head(sheet, '[aria-label="Remove focus"]')!.click();
    expect(focus(store)).toBeUndefined();
    expect(store.panel.value).toBe(null);
  });

  it('closes itself when undo takes the focus away', async () => {
    const { store, search } = await mount();
    search.resolve(track(1));
    store.undo();
    await until('the sheet to close', () => store.panel.value === null);
  });

  it('stays short enough to leave the picture the subjects are tapped on', async () => {
    const { sheet, search } = await mount();
    await ready(sheet, search);
    const height = () => {
      const body = sheet.shadowRoot!.querySelector<HTMLElement>('.fs')!;
      const headEl = frame(sheet)!.shadowRoot!.querySelector<HTMLElement>('.sheet__head');
      return body.getBoundingClientRect().height + (headEl?.getBoundingClientRect().height ?? 53);
    };
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(height()).toBeLessThanOrEqual(259);

    await openLook(sheet);
    await new Promise(resolve => requestAnimationFrame(resolve));
    expect(height()).toBeLessThanOrEqual(259);
  });
});
