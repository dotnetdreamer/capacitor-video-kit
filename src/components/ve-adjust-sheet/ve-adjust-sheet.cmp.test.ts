import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, neutralAdjust, type EditAdjust, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import type { HapticKind } from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM. Two of this sheet's promises are shape: all six properties
 * are on screen at once - a row that scrolled hid Fade off the edge of a 393px screen and gave no
 * sign there was more of it - and the fill runs out from the middle of a two sided scale rather
 * than from its left end. Neither has a value to read; both are boxes to measure.
 *
 * The rest is the sheet's own two questions, which no stylesheet can answer: which property the one
 * slider is pointed at, and what happens to a drag when that changes under it.
 */

/** The property the sheet opens on, and the one every drag below starts from. */
const FIRST = { id: 'brightness' as const, label: 'Brightness' };

/** Its starting value, on the slider's whole-number scale and in the manifest's own fraction. */
const START_UNITS = 24;
const START_VALUE = START_UNITS / 100;

/** Two taps this close together are a double tap, measured by hand rather than with `dblclick`. */
const DOUBLE_TAP_MS = 320;

const LABELS = ['Brightness', 'Contrast', 'Saturation', 'Warmth', 'Tint', 'Fade'];

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function manifest(adjust: Partial<EditAdjust>): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 5000, speed: 1, volume: 1, muted: false }],
    adjust: { ...neutralAdjust(), ...adjust },
  };
}

interface Fixture {
  readonly store: EditorStore;
  readonly sheet: HTMLElement;
  /** Every buzz the sheet asked for, in order, so the detent can be counted rather than assumed. */
  readonly haptics: HapticKind[];
}

async function mount(adjust: Partial<EditAdjust> = {}): Promise<Fixture> {
  const haptics: HapticKind[] = [];
  const host = resolveEditorHost({ platform: { haptic: (kind: HapticKind) => haptics.push(kind) } });
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), manifest(adjust));
  store.openPanel('adjust');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-adjust-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  await (slider(sheet) as StencilElement | null)?.componentOnReady?.();
  return { store, sheet, haptics };
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

function props(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.as__prop') ?? [])];
}

function prop(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = props(sheet).find(button => button.querySelector('.as__prop-label')?.textContent === label);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

function adjustOf(store: EditorStore): EditAdjust {
  return store.manifest.value.adjust;
}

let pointerId = 0;

/** Presses the bar at a value in the slider's own units and hands back the rest of the gesture. */
function press(el: HTMLElement, value: number): { move(to: number): void; lift(to: number): void } {
  const bar = el.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
  const min = Number(el.getAttribute('aria-valuemin'));
  const max = Number(el.getAttribute('aria-valuemax'));
  const at = (v: number) => bar.left + ((v - min) / (max - min)) * bar.width;
  const send = (type: string, v: number) => {
    el.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX: at(v), bubbles: true }));
  };
  pointerId += 1;
  send('pointerdown', value);
  return {
    move: (to: number) => send('pointermove', to),
    lift: (to: number) => {
      send('pointermove', to);
      send('pointerup', to);
    },
  };
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

describe('ve-adjust-sheet', () => {
  it('keeps all six properties on screen at once', async () => {
    const { sheet } = await mount();
    const row = sheet.shadowRoot!.querySelector<HTMLElement>('.as__props')!;
    const box = row.getBoundingClientRect();

    expect(props(sheet).map(button => button.querySelector('.as__prop-label')?.textContent)).toEqual(LABELS);
    // Nothing sideways to discover: a row that scrolled hid Fade off the edge with no sign of it.
    expect(row.scrollWidth).toBe(row.clientWidth);
    for (const button of props(sheet)) {
      const rect = button.getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(box.left - 0.5);
      expect(rect.right).toBeLessThanOrEqual(box.right + 0.5);
    }
  });

  it('points the one slider at the property that was tapped', async () => {
    const { store, sheet, haptics } = await mount({ brightness: START_VALUE, fade: 0.3 });

    expect(slider(sheet)?.getAttribute('aria-label')).toBe(FIRST.label);
    expect(slider(sheet)?.getAttribute('aria-valuenow')).toBe(String(START_UNITS));
    expect(prop(sheet, FIRST.label).getAttribute('aria-pressed')).toBe('true');

    prop(sheet, 'Fade').click();
    await until('the slider to follow', () => slider(sheet)?.getAttribute('aria-label') === 'Fade');

    // Fade only goes one way, so its scale has no negative half and no neutral mark behind it.
    expect(slider(sheet)?.getAttribute('aria-valuemin')).toBe('0');
    expect(slider(sheet)?.getAttribute('aria-valuenow')).toBe('30');
    expect(sheet.shadowRoot?.querySelector('.as__zero')).toBe(null);
    expect(haptics).toEqual(['selection']);
    // Pointing the slider somewhere is not a change to anything.
    expect(store.canUndo.value).toBe(false);
  });

  it('runs the fill out from the neutral point of a two sided scale', async () => {
    const { sheet } = await mount({ brightness: START_VALUE, fade: 0.3 });
    const fill = () => slider(sheet)!.shadowRoot!.querySelector<HTMLElement>('.sl__fill')!;

    expect(sheet.shadowRoot?.querySelector('.as__zero')).not.toBe(null);
    expect(fill().style.left).toBe('50%');
    expect(fill().style.width).toBe('12%');

    prop(sheet, 'Fade').click();
    await until('the slider to follow', () => slider(sheet)?.getAttribute('aria-label') === 'Fade');

    // One sided, so the fill is an ordinary one from the left end.
    expect(fill().style.left).toBe('0%');
    expect(fill().style.width).toBe('30%');
  });

  it('signs the value above the knob, and only where a sign means anything', async () => {
    const { sheet } = await mount({ brightness: START_VALUE, fade: 0.3 });
    expect(slider(sheet)?.getAttribute('aria-valuetext')).toBe(`+${START_UNITS}`);

    press(slider(sheet)!, START_UNITS).lift(-START_UNITS);
    await until('the knob to move', () => slider(sheet)?.getAttribute('aria-valuenow') === String(-START_UNITS));
    // U+2212, the minus sign, rather than the hyphen a keyboard offers.
    expect(slider(sheet)?.getAttribute('aria-valuetext')).toBe(`−${START_UNITS}`);

    prop(sheet, 'Fade').click();
    await until('the slider to follow', () => slider(sheet)?.getAttribute('aria-label') === 'Fade');
    expect(slider(sheet)?.getAttribute('aria-valuetext')).toBe('30');
  });

  it('is one undo step per drag, named after the property', async () => {
    const { store, sheet } = await mount({ brightness: START_VALUE });

    press(slider(sheet)!, START_UNITS).lift(60);

    expect(adjustOf(store).brightness).toBeCloseTo(0.6, 6);
    store.undo();
    expect(store.toast.value?.text).toBe(`Undo: ${FIRST.label}`);
    expect(adjustOf(store).brightness).toBe(START_VALUE);
    expect(store.canUndo.value).toBe(false);
  });

  it('ticks once on the way back through neutral, and not on the way out of it', async () => {
    const { sheet, haptics } = await mount({ brightness: START_VALUE });

    const back = press(slider(sheet)!, START_UNITS);
    back.move(0);
    back.lift(-START_UNITS);
    // One detent, at the crossing: the second half of that drag was already on the other side.
    expect(haptics).toEqual(['selection']);

    // A property that has not been touched, so this drag starts at neutral rather than passing it.
    prop(sheet, 'Contrast').click();
    await until('the slider to follow', () => slider(sheet)?.getAttribute('aria-label') === 'Contrast');
    haptics.length = 0;

    const out = press(slider(sheet)!, 0);
    out.move(30);
    out.lift(60);
    // Leaving neutral is not passing back through it, so nothing buzzes on the way out.
    expect(haptics).toEqual([]);
  });

  it('leaves a drag with the property it began on when another is tapped mid drag', async () => {
    const { store, sheet } = await mount({ brightness: START_VALUE });
    const first = slider(sheet)!;

    const drag = press(first, START_UNITS);
    drag.move(70);
    prop(sheet, 'Contrast').click();
    await until('the slider to be replaced', () => slider(sheet) !== first);
    // The old element is gone but a finger is still down on it; what is left of the drag reaches
    // nothing rather than writing brightness's value into contrast.
    drag.lift(-70);

    expect(adjustOf(store).brightness).toBeCloseTo(0.7, 6);
    expect(adjustOf(store).contrast).toBe(0);
    store.undo();
    expect(store.toast.value?.text).toBe(`Undo: ${FIRST.label}`);
    expect(adjustOf(store).brightness).toBe(START_VALUE);
    expect(store.canUndo.value).toBe(false);
  });

  it('puts one property back on a double tap, and says so', async () => {
    const { store, sheet, haptics } = await mount({ brightness: START_VALUE, contrast: 0.5 });
    haptics.length = 0;

    prop(sheet, FIRST.label).click();
    prop(sheet, FIRST.label).click();

    expect(adjustOf(store).brightness).toBe(0);
    // Nothing else goes with it; the head's Reset is the button that clears all six.
    expect(adjustOf(store).contrast).toBe(0.5);
    // A double tap leaves nothing on screen to show for itself, so the sheet says what it did.
    expect(store.toast.value?.text).toBe(`${FIRST.label} reset`);
    expect(haptics).toContain('light');

    store.undo();
    expect(store.toast.value?.text).toBe(`Undo: Reset ${FIRST.label}`);
    expect(adjustOf(store).brightness).toBe(START_VALUE);
  });

  it('is two separate taps once they are far enough apart', async () => {
    const { store, sheet } = await mount({ brightness: START_VALUE });

    prop(sheet, FIRST.label).click();
    await new Promise(resolve => setTimeout(resolve, DOUBLE_TAP_MS + 60));
    prop(sheet, FIRST.label).click();

    expect(adjustOf(store).brightness).toBe(START_VALUE);
    expect(store.canUndo.value).toBe(false);
  });

  it('keeps a dot on every property that is not at neutral', async () => {
    const { store, sheet } = await mount({ brightness: START_VALUE, fade: 0.3 });

    const dotted = () =>
      props(sheet)
        .filter(button => button.querySelector('.as__dot'))
        .map(button => button.querySelector('.as__prop-label')?.textContent);
    expect(dotted()).toEqual([FIRST.label, 'Fade']);

    // The head's button is called "None" by the frame, which here would say nothing about what it
    // does, so this sheet renames it.
    expect(head(sheet, '.sheet__icon-btn--dim')?.getAttribute('aria-label')).toBe('Reset');
    head(sheet, '.sheet__icon-btn--dim')!.click();

    expect(adjustOf(store)).toEqual(neutralAdjust());
    await until('the dots to go', () => dotted().length === 0);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Reset adjust');
  });

  it('records nothing when there is nothing to reset', async () => {
    const { store, sheet, haptics } = await mount();
    haptics.length = 0;

    head(sheet, '.sheet__icon-btn--dim')!.click();

    expect(store.canUndo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
    // Nothing moved on screen either, so the buzz would have been the only answer - and it is owed
    // only when there was something to answer for.
    expect(haptics).toEqual([]);
  });

  it('closes the panel on the frame’s tick', async () => {
    const { store, sheet } = await mount();

    head(sheet, '[aria-label="Done"]')!.click();

    expect(store.panel.value).toBe(null);
  });
});
