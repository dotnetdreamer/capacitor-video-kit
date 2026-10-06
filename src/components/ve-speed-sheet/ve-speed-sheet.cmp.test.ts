import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, findAudioClip, type EditAudioClip, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';
import type { EditorSelection } from '../../state/editor.types';

/*
 * A browser rather than the mock DOM, and `speed-curve.unit.test.ts` beside this file is why: the
 * arithmetic is already pinned down without a document, so what is left is everything the curve
 * cannot answer. A finger on a laid out bar, and the one measurement this sheet owns - the 1x mark
 * drawn under the track, which is placed from `ve-slider`'s own edge constant and has to end up
 * exactly where the knob rests at 1x. Off by the edge inset, it still looks like a scale, and the
 * only way to see it is to measure both.
 */

/** Where the selected segment starts, so a drag has room in both directions. */
const START_SPEED = 1;

/** The slider unit 1x sits on: the scale is logarithmic and 0.25x..4x puts it dead centre. */
const ONE_X_UNITS = 50;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function manifest(clips: number): EditManifest {
  return {
    ...emptyManifest(),
    clips: Array.from({ length: clips }, (_, i) => ({
      id: `seg-${i}`,
      clipKey: 'clip-a',
      inMs: 0,
      outMs: 5000,
      speed: START_SPEED,
      volume: 1,
      muted: false,
    })),
  };
}

/** The sheet over a store with the segment selected, which is the state the toolbar hands it. */
async function mount(select = true, clips = 2): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  return mountOn(manifest(clips), select ? { kind: 'clip', id: 'seg-0' } : null);
}

/** A four-second sound at the start of a twenty-second post, and another on its lane from `nextAt`. */
function withSounds(nextAt: number): EditManifest {
  const sound = (id: string, startMs: number): EditAudioClip => ({
    id,
    uri: `file:///${id}.m4a`,
    fileName: `${id}.m4a`,
    sourceDurationMs: 4000,
    inMs: 0,
    outMs: 0,
    startMs,
    endMs: 0,
    volume: 0.8,
    loop: false,
    fadeOutMs: 0,
  });
  return { ...manifest(1), durationMs: 20_000, music: sound('old', 0), audioTracks: [{ id: 'lane', clips: [sound('song', 0), sound('next', nextAt)] }] };
}

/** The sheet over `m` with `selection` selected, as the toolbar's Speed tile leaves it. */
async function mountOn(m: EditManifest, selection: EditorSelection | null): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), m);
  // Selected first: `select` closes an open speed panel, because a sheet about the old segment says
  // nothing about the new one.
  if (selection) store.select(selection);
  store.openPanel('speed');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-speed-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  await (slider(sheet) as StencilElement | null)?.componentOnReady?.();
  return { store, sheet };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function slider(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector<HTMLElement>('ve-slider') ?? null;
}

function chips(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.speed__chip') ?? [])];
}

function chip(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = chips(sheet).find(button => button.textContent === label);
  if (!found) throw new Error(`no ${label} chip`);
  return found;
}

function readout(sheet: HTMLElement): string | undefined {
  return sheet.shadowRoot?.querySelector('.speed__value')?.textContent ?? undefined;
}

function speedOf(store: EditorStore, index = 0): number {
  return store.manifest.value.clips[index].speed;
}

/** A box's midpoint across, which is what "lines up with" means for a mark and a knob. */
function centreX(el: Element): number {
  const rect = el.getBoundingClientRect();
  return rect.left + rect.width / 2;
}

let pointerId = 0;

/** One whole drag along the bar, in the slider's own 0..100 units, exactly as a finger does it. */
function drag(sheet: HTMLElement, from: number, to: number): void {
  const bar = slider(sheet)!.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
  const at = (value: number) => bar.left + (value / 100) * bar.width;
  pointerId += 1;
  fire(sheet, 'pointerdown', at(from));
  fire(sheet, 'pointermove', at(to));
  fire(sheet, 'pointerup', at(to));
}

function fire(sheet: HTMLElement, type: string, clientX: number): void {
  slider(sheet)!.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX, bubbles: true }));
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

describe('ve-speed-sheet', () => {
  it('draws the 1x mark exactly where the knob rests at 1x', async () => {
    const { sheet } = await mount();
    const knob = slider(sheet)!.shadowRoot!.querySelector('.sl__knob')!;
    const mark = sheet.shadowRoot!.querySelector('.speed__scale-one')!;

    expect(mark.textContent).toBe('1x');
    // The bar stops SLIDER_EDGE_PX inside the row at either end, so the mark is placed along that
    // shorter run and not along the whole width. Measured from the row instead, it would sit a few
    // pixels off the detent the knob actually sticks to.
    expect(Math.abs(centreX(mark) - centreX(knob))).toBeLessThanOrEqual(1);
  });

  it('shows the segment’s own speed, in speeds rather than in slider units', async () => {
    const { sheet } = await mount();

    expect(readout(sheet)).toBe('1x');
    expect(slider(sheet)?.getAttribute('aria-valuenow')).toBe(String(ONE_X_UNITS));
    expect(slider(sheet)?.getAttribute('aria-valuetext')).toBe('1x');
    expect(chip(sheet, '1x').getAttribute('aria-checked')).toBe('true');
    expect(chips(sheet).filter(button => button.classList.contains('speed__chip--on'))).toHaveLength(1);
  });

  it('is one undo step per chip, and the row reads the manifest back', async () => {
    const { store, sheet } = await mount();

    chip(sheet, '2x').click();
    expect(speedOf(store)).toBe(2);
    await until('the row to follow', () => chip(sheet, '2x').getAttribute('aria-checked') === 'true');
    expect(readout(sheet)).toBe('2x');
    expect(chip(sheet, '1x').getAttribute('aria-checked')).toBe('false');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Speed');
    expect(speedOf(store)).toBe(START_SPEED);
    // Nothing left behind it, which is what one tap being one step means.
    expect(store.canUndo.value).toBe(false);
  });

  it('records nothing for the chip the segment is already on', async () => {
    const { store, sheet } = await mount();

    chip(sheet, '1x').click();

    expect(store.canUndo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
  });

  it('turns a whole drag into one speed and one undo step', async () => {
    const { store, sheet } = await mount();

    // Three quarters along a scale where 0.25x..4x is four doublings: 0.25 times 2 to the third.
    drag(sheet, ONE_X_UNITS, 75);

    expect(speedOf(store)).toBe(2);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Speed');
    expect(speedOf(store)).toBe(START_SPEED);
    expect(store.canUndo.value).toBe(false);
  });

  it('sticks the knob to 1x, so a finger near the middle lands on it exactly', async () => {
    const { store, sheet } = await mount();
    chip(sheet, '2x').click();
    await until('the knob to move', () => slider(sheet)?.getAttribute('aria-valuenow') !== String(ONE_X_UNITS));

    drag(sheet, 75, ONE_X_UNITS + 2);

    // 52 units is 1.06x on the curve; the detent is what makes it exactly 1.
    expect(speedOf(store)).toBe(1);
  });

  it('offers every segment the selected one’s speed, as one step, and only when there are siblings', async () => {
    const { store, sheet } = await mount();
    chip(sheet, '1.5x').click();
    await until('the button', () => sheet.shadowRoot?.querySelector('.sheet__apply-all') !== null);

    sheet.shadowRoot!.querySelector<HTMLButtonElement>('.sheet__apply-all')!.click();

    expect(store.manifest.value.clips.map(clip => clip.speed)).toEqual([1.5, 1.5]);
    expect(store.toast.value?.text).toBe('Speed applied to all clips');
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Speed for all');
    expect(speedOf(store, 1)).toBe(START_SPEED);

    // One segment is the whole video, so the offer would do nothing and is not made.
    const alone = await mount(true, 1);
    expect(alone.sheet.shadowRoot?.querySelector('.sheet__apply-all')).toBe(null);
  });

  it('records nothing when every segment already has the speed, and says so', async () => {
    const { store, sheet } = await mount();

    sheet.shadowRoot!.querySelector<HTMLButtonElement>('.sheet__apply-all')!.click();

    expect(store.canUndo.value).toBe(false);
    expect(store.toast.value?.text).toBe('All clips already have this speed');
  });

  it('asks for a segment rather than drawing a slider over nothing', async () => {
    const { sheet } = await mount(false);

    expect(sheet.shadowRoot?.querySelector('.speed__empty')?.textContent).toBe('Select a clip first');
    expect(slider(sheet)).toBe(null);
    expect(chips(sheet)).toHaveLength(0);
    // The frame is still the frame: the sheet has a name and a tick whether or not it has a segment.
    expect(head(sheet, '.sheet__title')?.textContent).toBe('Speed');
  });

  it('closes the panel on the frame’s tick', async () => {
    const { store, sheet } = await mount();

    head(sheet, '[aria-label="Done"]')!.click();

    expect(store.panel.value).toBe(null);
  });
});

/*
 * The same sheet for a sound: the Audio tools row's Speed tile opens it on a sound on a lane, and the
 * Sound tools row's on an older edit's one sound. Its name says which, and a sound has nothing to give
 * its speed to, so there is no offer to.
 */
describe('ve-speed-sheet for a sound', () => {
  const songOf = (store: EditorStore) => findAudioClip(store.manifest.value, 'song');

  it('names the sound it is about, and sets that sound’s speed in one step', async () => {
    const { store, sheet } = await mountOn(withSounds(9000), { kind: 'audio', id: 'song' });

    expect(head(sheet, '.sheet__title')?.textContent).toBe('Audio speed');
    expect(readout(sheet)).toBe('1x');
    expect(sheet.shadowRoot?.querySelector('.sheet__apply-all')).toBe(null);

    chip(sheet, '2x').click();
    expect(songOf(store)?.speed).toBe(2);
    await until('the row to follow', () => readout(sheet) === '2x');
    // The clips are not what it was about.
    expect(speedOf(store)).toBe(START_SPEED);

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Speed');
    expect(songOf(store)).not.toHaveProperty('speed');
  });

  it('slows a sound only as far as the next one on its lane', async () => {
    const { store, sheet } = await mountOn(withSounds(6000), { kind: 'audio', id: 'song' });

    // Four seconds at 0.5x would run to eight, over `next` at six.
    chip(sheet, '0.5x').click();
    expect(songOf(store)).toMatchObject({ speed: 0.5, endMs: 6000 });
    expect(findAudioClip(store.manifest.value, 'next')?.startMs).toBe(6000);
  });

  it('takes the stop away again when a drag slows a sound into its neighbour and brings it back', async () => {
    const { store, sheet } = await mountOn(withSounds(6000), { kind: 'audio', id: 'song' });
    const bar = slider(sheet)!.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
    const at = (value: number) => bar.left + (value / 100) * bar.width;

    // Down at 1x, over to 0.5x - stopped at the neighbour - and on up to 2x, then let go.
    pointerId += 1;
    fire(sheet, 'pointerdown', at(ONE_X_UNITS));
    fire(sheet, 'pointermove', at(25));
    expect(songOf(store)).toMatchObject({ speed: 0.5, endMs: 6000 });
    fire(sheet, 'pointermove', at(75));
    fire(sheet, 'pointerup', at(75));

    expect(songOf(store)).toMatchObject({ speed: 2, endMs: 0 });
    store.undo();
    expect(songOf(store)).toMatchObject({ endMs: 0 });
    expect(songOf(store)).not.toHaveProperty('speed');
  });

  it('names an older edit’s one sound, and sets its speed', async () => {
    const { store, sheet } = await mountOn(withSounds(9000), { kind: 'music' });

    expect(head(sheet, '.sheet__title')?.textContent).toBe('Sound speed');
    chip(sheet, '1.5x').click();
    expect(store.manifest.value.music?.speed).toBe(1.5);
  });
});
