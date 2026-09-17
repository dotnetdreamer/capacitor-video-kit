import { render, describe, it, expect, vi, type RenderResult } from '@stencil/vitest';

import { emptyManifest, type EditClip } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import type { EditorSource, HapticKind } from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/**
 * A browser test rather than a unit test, because every promise this component makes is about a
 * pointer over a laid out box. The mock DOM measures the bar as zero wide, which the geometry
 * answers with `min` by design, so a drag there would be a drag from 0 to 0 and every one of these
 * assertions would pass without the component doing anything at all.
 *
 * The slider under test is wired up the way the Filter sheet wires one: `veLive` goes to the store
 * as a live change and the value the store settles on comes back as the `value` prop. That is the
 * whole contract six sheets are written against, so the test drives it rather than the component's
 * internals.
 */

const SOURCES: EditorSource[] = [{ key: 'a', fileName: 'a.mp4' }];

function clip(id: string): EditClip {
  return { id, clipKey: 'a', inMs: 0, outMs: 4000, speed: 1, volume: 1, muted: false };
}

interface Fixture {
  readonly slider: HTMLElement;
  readonly store: EditorStore;
  readonly haptics: HapticKind[];
  /** The bar's own box, which is what the knob travels along. */
  readonly track: DOMRect;
  /** Where the knob's centre sits for a slider value, in client coordinates. */
  at(value: number): number;
  readonly live: number[];
  readonly calls: string[];
  unmount(): void;
  setValue(value: number): Promise<void>;
}

/**
 * One slider on a 393px phone's sheet body, over a store holding one clip whose filter is at 40%.
 * Forty is chosen so that there is room to drag in both directions and neither end is one step away.
 */
async function mount(props: Record<string, unknown> = {}): Promise<Fixture> {
  const haptics: HapticKind[] = [];
  const host = resolveEditorHost({ platform: { haptic: (kind: HapticKind) => haptics.push(kind) } });
  const store = new EditorStore(host);
  store.load(SOURCES, new Map([['a', 4000]]), {
    ...emptyManifest(),
    clips: [clip('seg-a')],
    filterId: 'vivid',
    filterIntensity: 0.4,
  });

  const rendered: RenderResult<HTMLElement> = await render('<ve-slider></ve-slider>', {
    stageAttrs: { style: 'width: 353px' },
  });
  const slider = rendered.root;
  const live: number[] = [];
  const calls: string[] = [];

  slider.addEventListener('veGestureStart', () => calls.push('start'));
  slider.addEventListener('veLive', event => {
    const value = (event as CustomEvent<number>).detail;
    live.push(value);
    calls.push(`live ${value}`);
    store.previewFilterIntensity(value / 100);
    // What the sheet's own repaint does, set as the DOM property a framework binding would set:
    // the knob follows the manifest, not the finger.
    (slider as unknown as { value: number }).value = Math.round(store.manifest.value.filterIntensity * 100);
  });

  await rendered.setProps({
    ctx: { store, media: new EditorMedia(store, host) },
    value: 40,
    label: 'Filter strength',
    ...props,
  });

  const track = slider.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();

  return {
    slider,
    store,
    haptics,
    track,
    live,
    calls,
    at: (value: number) => track.left + (value / 100) * track.width,
    unmount: () => rendered.unmount(),
    setValue: (value: number) => rendered.setProps({ value }),
  };
}

let pointerId = 0;

function press(slider: HTMLElement, clientX: number): void {
  pointerId += 1;
  fire(slider, 'pointerdown', clientX);
}

function moveTo(slider: HTMLElement, clientX: number): void {
  fire(slider, 'pointermove', clientX);
}

function lift(slider: HTMLElement, clientX: number): void {
  fire(slider, 'pointerup', clientX);
}

function fire(slider: HTMLElement, type: string, clientX: number): void {
  slider.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX, bubbles: true }));
}

describe('ve-slider', () => {
  it('a press that never moves changes nothing and records no undo step', async () => {
    const { slider, store, at, live } = await mount();

    // Nine pixels off the knob's centre, which Ionic would already have read as a change of value.
    press(slider, at(40) - 9);
    lift(slider, at(40) - 9);

    expect(live).toEqual([]);
    expect(store.manifest.value.filterIntensity).toBe(0.4);
    expect(store.canUndo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
  });

  it('a drag records exactly one undo step', async () => {
    const { slider, store, at } = await mount();

    press(slider, at(40));
    moveTo(slider, at(52));
    moveTo(slider, at(64));
    moveTo(slider, at(70));
    lift(slider, at(70));

    expect(store.manifest.value.filterIntensity).toBeCloseTo(0.7, 6);
    expect(store.canUndo.value).toBe(true);

    store.undo();
    expect(store.manifest.value.filterIntensity).toBe(0.4);
    expect(store.canUndo.value).toBe(false);
  });

  it('a drag that ends back where it started records nothing', async () => {
    const { slider, store, at, live } = await mount();

    press(slider, at(40));
    moveTo(slider, at(70));
    moveTo(slider, at(40));
    lift(slider, at(40));

    expect(live).toEqual([70, 40]);
    expect(store.manifest.value.filterIntensity).toBe(0.4);
    expect(store.canUndo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
  });

  it('a press on the bar beyond the knob jumps to the finger and lands as one step', async () => {
    const { slider, store, at, live } = await mount();

    press(slider, at(90));
    lift(slider, at(90));

    expect(live).toEqual([90]);
    expect(store.manifest.value.filterIntensity).toBeCloseTo(0.9, 6);
    expect(store.canUndo.value).toBe(true);
  });

  it('opens its gesture before the first live value, which is what the volume sheet reads', async () => {
    const { slider, calls, at } = await mount();

    press(slider, at(90));
    lift(slider, at(90));

    expect(calls).toEqual(['start', 'live 90']);
  });

  it('keeps the knob under the finger rather than jumping it to the press', async () => {
    const { slider, live, at } = await mount();

    // Picked up 9px to the left of centre and moved exactly 10 slider units to the right: the value
    // travels by what the finger travelled, not to wherever the finger happens to be.
    press(slider, at(40) - 9);
    moveTo(slider, at(50) - 9);
    lift(slider, at(50) - 9);

    expect(live).toEqual([50]);
  });

  it('sticks to a snap point and ticks the phone once on the way in', async () => {
    const { slider, live, haptics, at } = await mount({ snap: [50], snapRadius: 3 });

    press(slider, at(40));
    moveTo(slider, at(48));
    moveTo(slider, at(51));
    moveTo(slider, at(60));
    lift(slider, at(60));

    expect(live).toEqual([50, 60]);
    expect(haptics).toEqual(['selection']);
  });

  it('closes an open gesture when it is unmounted, because undo can take the sheet away mid drag', async () => {
    const { slider, store, at, unmount } = await mount();

    press(slider, at(40));
    moveTo(slider, at(70));
    unmount();

    expect(store.canUndo.value).toBe(true);
    expect(store.manifest.value.filterIntensity).toBeCloseTo(0.7, 6);
  });

  it('puts the knob where the value prop says', async () => {
    const { slider, setValue } = await mount();

    await setValue(25);

    expect(knob(slider).style.left).toBe('25%');
    expect(fill(slider).style.left).toBe('0%');
    expect(fill(slider).style.width).toBe('25%');
  });

  it('fills out from `from`, which is what gives Adjust a bar that grows from its neutral point', async () => {
    const { slider, setValue } = await mount({ min: -100, max: 100, from: 0, value: 0 });

    await setValue(50);
    expect(fill(slider).style.left).toBe('50%');
    expect(fill(slider).style.width).toBe('25%');

    await setValue(-50);
    expect(fill(slider).style.left).toBe('25%');
    expect(fill(slider).style.width).toBe('25%');
  });

  it('announces itself as a slider carrying the value the sheet formats', async () => {
    const { slider } = await mount({ format: (value: number) => `${Math.round(value)}%` });

    expect(slider.getAttribute('role')).toBe('slider');
    expect(slider.getAttribute('aria-label')).toBe('Filter strength');
    expect(slider.getAttribute('aria-valuenow')).toBe('40');
    expect(slider.getAttribute('aria-valuetext')).toBe('40%');
    expect(slider.shadowRoot!.querySelector('.sl__pin')!.textContent).toBe('40%');
  });

  it('draws no value above the knob, and reserves no room for one, when the pin is off', async () => {
    const { slider } = await mount({ pin: 'none' });

    expect(slider.shadowRoot!.querySelector('.sl__pin')).toBeNull();
    expect(slider.getBoundingClientRect().height).toBe(44);
  });

  it('moves by one step on an arrow key, as one undo step', async () => {
    const { slider, store } = await mount();
    const spy = vi.fn();
    slider.addEventListener('veLive', spy);

    slider.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));

    expect(spy).toHaveBeenCalledTimes(1);
    expect(store.manifest.value.filterIntensity).toBeCloseTo(0.41, 6);
    expect(store.canUndo.value).toBe(true);
  });
});

function knob(slider: HTMLElement): HTMLElement {
  return slider.shadowRoot!.querySelector<HTMLElement>('.sl__knob')!;
}

function fill(slider: HTMLElement): HTMLElement {
  return slider.shadowRoot!.querySelector<HTMLElement>('.sl__fill')!;
}
