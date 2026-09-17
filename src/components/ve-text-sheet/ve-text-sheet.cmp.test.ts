import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest, type TextOverlay } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import type { EditorKeyboardHost } from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because this sheet is a text field and a keyboard: the field
 * is deliberately NOT bound to the layer's text, so what is under test is that typing leaves the
 * element and the caret alone, and every button in the sheet cancels its own mousedown so that
 * tapping it does not take the focus off the field and drop the keyboard. Neither has any meaning
 * where there is no focus and no selection.
 *
 * The store's part of it is the one gesture: `startNewText` opens it, every keystroke and every
 * style tap is a live change inside it, and the tick lands the whole edit as a single undo step.
 * This sheet never commits and never ends that gesture itself.
 */

const MAX_TEXT_LENGTH = 200;

/**
 * A keyboard's height, as a host reports it. Chosen inside the panel's own 240..300 range, so what
 * is measured below is the sheet's arithmetic rather than one of its clamps.
 */
const KEYBOARD_PX = 280;

/** How long the sheet gives a keyboard to settle before it measures the room it really took. */
const KEYBOARD_SETTLE_MS = 180;

/** Two UTF-16 units each, so a cap counted in the wrong unit cuts one in half. */
const EMOJI = '\u{1F600}';

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function textLayer(id: string, text: string): TextOverlay {
  return {
    id,
    kind: 'text',
    text,
    styleId: 'classic',
    color: '#ffffff',
    effect: 'shadow',
    align: 'center',
    cx: 0.5,
    cy: 0.45,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 0,
    endMs: 0,
  };
}

function manifest(overlays: TextOverlay[]): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 6000, speed: 1, volume: 1, muted: false }],
    overlays,
  };
}

interface FakeKeyboard {
  readonly host: EditorKeyboardHost;
  /** What a host reports: a height above zero is willShow and didShow, zero is willHide and didHide. */
  report(heightPx: number): void;
}

/**
 * A keyboard the test drives. The browser's own default reports zero for ever, which is exactly
 * what a desktop looks like - and the sheet then treats every panel as being on its own, so none of
 * the room keeping below would run at all.
 */
function fakeKeyboard(): FakeKeyboard {
  let listener: ((heightPx: number) => void) | null = null;
  return {
    host: {
      subscribe(fn) {
        listener = fn;
        fn(0);
        return () => {
          listener = null;
        };
      },
    },
    report: (heightPx: number) => listener?.(heightPx),
  };
}

/**
 * The sheet over a store that has already opened the edit, which is the only way it is ever
 * reached: `startNewText` and `startEditText` create or pick the layer and open ONE gesture around
 * the whole edit before the panel is opened.
 */
async function mount(existing?: TextOverlay, keyboard?: EditorKeyboardHost): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost(keyboard ? { platform: { keyboard } } : {});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 6000]]), manifest(existing ? [existing] : []));
  if (existing) store.startEditText(existing.id);
  else store.startNewText();

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'display: flex; flex-direction: column; width: 393px; height: 520px';
  document.body.append(column);

  const sheet = document.createElement('ve-text-sheet');
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

function field(sheet: HTMLElement): HTMLTextAreaElement {
  return sheet.shadowRoot!.querySelector<HTMLTextAreaElement>('.ts__field')!;
}

function button(sheet: HTMLElement, label: string): HTMLButtonElement {
  const found = sheet.shadowRoot!.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
  if (!found) throw new Error(`no ${label} button`);
  return found;
}

function panel(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector<HTMLElement>('.ts__panel') ?? null;
}

function layer(store: EditorStore): TextOverlay {
  return store.manifest.value.overlays[0] as TextOverlay;
}

/** Types the way a customer does: the field holds the whole value and reports it once. */
function type(sheet: HTMLElement, text: string): void {
  const input = field(sheet);
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 3000): Promise<void> {
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

describe('ve-text-sheet', () => {
  it('brings its own head: one tick, beside the field rather than in the frame', async () => {
    const { sheet } = await mount();

    expect(frame(sheet)?.shadowRoot?.querySelector('.sheet__head')).toBe(null);
    expect(frame(sheet)?.shadowRoot?.querySelectorAll('[aria-label="Done"]')).toHaveLength(0);
    expect(sheet.shadowRoot?.querySelectorAll('[aria-label="Done"]')).toHaveLength(1);
    expect(field(sheet).getAttribute('aria-label')).toBe('Text');
    expect(field(sheet).maxLength).toBe(MAX_TEXT_LENGTH);
    // Nothing to style yet, so no panel has taken the keyboard's place.
    expect(panel(sheet)).toBe(null);
  });

  it('types into the layer live, and lands the whole edit as one undo step', async () => {
    const { store, sheet } = await mount();

    type(sheet, 'Best');
    expect(layer(store).text).toBe('Best');
    type(sheet, 'Best pizza');
    expect(layer(store).text).toBe('Best pizza');
    // Every keystroke is inside the one gesture the store opened, so nothing has landed yet.
    expect(store.canUndo.value).toBe(false);

    button(sheet, 'Done').click();

    expect(store.canUndo.value).toBe(true);
    expect(store.panel.value).toBe(null);
    expect(store.textEdit.value).toBe(null);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Add text');
    // The layer was born inside the gesture, so undoing removes it entirely.
    expect(store.manifest.value.overlays).toHaveLength(0);
  });

  it('leaves no trace when a new text is finished empty', async () => {
    const { store, sheet } = await mount();
    type(sheet, 'a');
    type(sheet, '');

    button(sheet, 'Done').click();

    expect(store.manifest.value.overlays).toHaveLength(0);
    // Not an "Add text" step that undoes nothing: the snapshot is put back instead.
    expect(store.canUndo.value).toBe(false);
    expect(store.dirty.value).toBe(false);
    expect(store.panel.value).toBe(null);
  });

  it('names the step for what it was, when an existing layer is edited', async () => {
    const { store, sheet } = await mount(textLayer('text-1', 'Best pizza'));
    expect(field(sheet).value).toBe('Best pizza');

    type(sheet, 'Best pizza in town');
    button(sheet, 'Done').click();

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Edit text');
    expect(layer(store).text).toBe('Best pizza');
  });

  it('never writes the text back into the field, so the caret stays where it was', async () => {
    const { sheet } = await mount(textLayer('text-1', 'Best pizza'));
    const input = field(sheet);

    input.value = 'Best pizza here';
    input.setSelectionRange(4, 4);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await until('a repaint', () => true);
    for (let i = 0; i < 3; i += 1) await new Promise(resolve => requestAnimationFrame(resolve));

    // The same element, with the same value and the same caret: echoing the layer's text back into
    // `value` on every keystroke would fight the keyboard's composition and move the caret to the end.
    expect(field(sheet)).toBe(input);
    expect(input.value).toBe('Best pizza here');
    expect(input.selectionStart).toBe(4);
  });

  it('caps the stored text by code points, so an emoji is never cut in half', async () => {
    const { store, sheet } = await mount();

    // `maxlength` is not enforced while an IME is still composing, so the cap is applied again here.
    type(sheet, EMOJI.repeat(MAX_TEXT_LENGTH + 1));

    expect([...layer(store).text]).toHaveLength(MAX_TEXT_LENGTH);
    expect(layer(store).text).toBe(EMOJI.repeat(MAX_TEXT_LENGTH));
  });

  it('opens the font panel where the layer’s own style lives, and picks live', async () => {
    const { store, sheet } = await mount();

    button(sheet, 'Font').click();
    await until('the panel', () => panel(sheet) !== null);

    // Classic is in the Trending list, so that is the tab the grid opens on.
    expect(sheet.shadowRoot?.querySelector('.sheet__tab--on')?.textContent).toBe('Trending');
    const tile = sheet.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Neon"]')!;
    expect(button(sheet, 'Font').getAttribute('aria-pressed')).toBe('true');

    tile.click();

    expect(layer(store).styleId).toBe('neon');
    // Still inside the one gesture: only the tick lands any of this.
    expect(store.canUndo.value).toBe(false);
    await until('the tile to light up', () => tile.getAttribute('aria-pressed') === 'true');
  });

  it('replaces the panel rather than patching one into another', async () => {
    const { sheet } = await mount();
    button(sheet, 'Font').click();
    await until('the font panel', () => sheet.shadowRoot?.querySelector('.ts__font-grid') !== null);
    const first = panel(sheet);

    button(sheet, 'Colour').click();
    await until('the colour panel', () => sheet.shadowRoot?.querySelector('.ts__colours') !== null);

    // Keyed by which panel is open: patched in place, the font tab strip would be left standing
    // above a grid of swatches.
    expect(panel(sheet)).not.toBe(first);
    expect(sheet.shadowRoot?.querySelector('.ts__tabs')).toBe(null);
    expect(sheet.shadowRoot?.querySelector('.ts__font-grid')).toBe(null);
  });

  it('writes a colour live and reads the swatch back off the layer', async () => {
    const { store, sheet } = await mount();
    button(sheet, 'Colour').click();
    await until('the colour panel', () => sheet.shadowRoot?.querySelector('.ts__colours') !== null);

    const pick = sheet.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="#ff3b5c"]')!;
    expect(sheet.shadowRoot?.querySelector('[aria-label="#ffffff"]')?.getAttribute('aria-checked')).toBe('true');

    pick.click();

    expect(layer(store).color).toBe('#ff3b5c');
    await until('the swatch to follow', () => pick.getAttribute('aria-checked') === 'true');
    expect(sheet.shadowRoot?.querySelectorAll('.ts__colour--on')).toHaveLength(1);
  });

  it('keeps background and stroke out of each other’s way, sharing one field', async () => {
    const { store, sheet } = await mount();
    button(sheet, 'Background').click();
    await until('the background panel', () => sheet.shadowRoot?.querySelector('.ts__effects') !== null);

    // The layer starts with a shadow, which is a stroke rather than a background, so the background
    // panel already reads None. Tapping it must not quietly take the shadow away.
    expect(layer(store).effect).toBe('shadow');
    const nones = [...sheet.shadowRoot!.querySelectorAll<HTMLButtonElement>('.ts__effect')];
    expect(nones[0].getAttribute('aria-checked')).toBe('true');
    nones[0].click();
    expect(layer(store).effect).toBe('shadow');

    nones[1].click();
    expect(layer(store).effect).toBe('plate');

    button(sheet, 'Stroke').click();
    await until('the stroke panel', () => sheet.shadowRoot?.querySelector('[aria-label="Stroke"]')?.getAttribute('aria-pressed') === 'true');
    // A text on a plate has no stroke, so the stroke panel reads None - and its None must not take
    // the plate away either.
    const strokes = [...sheet.shadowRoot!.querySelectorAll<HTMLButtonElement>('.ts__effect')];
    expect(strokes[0].getAttribute('aria-checked')).toBe('true');
    strokes[0].click();
    expect(layer(store).effect).toBe('plate');

    strokes[2].click();
    expect(layer(store).effect).toBe('outline');
  });

  it('cycles the alignment rather than opening a panel for it', async () => {
    const { store, sheet } = await mount();

    button(sheet, 'Alignment: center').click();
    expect(layer(store).align).toBe('left');
    await until('the glyph to follow', () => sheet.shadowRoot?.querySelector('[aria-label="Alignment: left"]') !== null);

    button(sheet, 'Alignment: left').click();
    expect(layer(store).align).toBe('right');
    await until('the glyph to follow', () => sheet.shadowRoot?.querySelector('[aria-label="Alignment: right"]') !== null);

    button(sheet, 'Alignment: right').click();
    expect(layer(store).align).toBe('center');
    // The keyboard is left where it is, so there is never a panel in its place.
    expect(panel(sheet)).toBe(null);
  });

  it('cancels every button’s mousedown, because losing the focus drops the keyboard', async () => {
    const { sheet } = await mount();
    button(sheet, 'Font').click();
    await until('the font panel', () => sheet.shadowRoot?.querySelector('.ts__font-grid') !== null);

    const buttons = [
      button(sheet, 'Done'),
      button(sheet, 'Font'),
      button(sheet, 'Colour'),
      button(sheet, 'Show keyboard'),
      sheet.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Neon"]')!,
      sheet.shadowRoot!.querySelector<HTMLButtonElement>('.sheet__tab')!,
    ];

    for (const el of buttons) {
      const event = new MouseEvent('mousedown', { bubbles: true, cancelable: true });
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    }
  });

  it('goes back to typing when the keyboard button is pressed', async () => {
    const { sheet } = await mount();
    button(sheet, 'Font').click();
    await until('the panel', () => panel(sheet) !== null);

    button(sheet, 'Show keyboard').click();

    await until('the panel to go', () => panel(sheet) === null);
    // The button is only there while a panel has taken the keyboard's place.
    expect(sheet.shadowRoot?.querySelector('[aria-label="Show keyboard"]')).toBe(null);
  });

  it('keeps room under itself for a keyboard the WebView did not make room for', async () => {
    const keyboard = fakeKeyboard();
    const { sheet } = await mount(undefined, keyboard.host);
    expect(sheet.shadowRoot?.querySelector('.ts__keyboard-room')).toBe(null);

    keyboard.report(KEYBOARD_PX);
    await until('the sheet to measure the room', () => sheet.shadowRoot?.querySelector('.ts__keyboard-room') !== null, 2000);

    // The window did not shrink, so the keyboard is drawn over the bottom of the page and the sheet
    // keeps that much room under itself. A WebView that DID shrink needs none, and padding one that
    // already resized floats the sheet a whole keyboard too high.
    const room = sheet.shadowRoot!.querySelector<HTMLElement>('.ts__keyboard-room')!;
    expect(room.style.height).toBe(`${KEYBOARD_PX}px`);
  });

  it('holds a panel at nothing until the keyboard has given its room back', async () => {
    const keyboard = fakeKeyboard();
    const { sheet } = await mount(undefined, keyboard.host);
    keyboard.report(KEYBOARD_PX);
    await new Promise(resolve => setTimeout(resolve, KEYBOARD_SETTLE_MS + 60));

    button(sheet, 'Font').click();
    await until('the panel', () => panel(sheet) !== null);
    // For this moment both are on screen. At its full height the panel squeezed the preview to half
    // its size and let it spring back.
    expect(panel(sheet)!.style.height).toBe('0px');

    keyboard.report(0);
    await until('the panel to take the room', () => panel(sheet)!.style.height !== '0px');

    // As tall as the room the keyboard took, less the padding the resting sheet keeps at the bottom
    // anyway: the panel then ends exactly where the keyboard's top edge was, so swapping one for the
    // other barely moves the preview above.
    const pad = parseFloat(getComputedStyle(frame(sheet)!).paddingBottom) || 0;
    expect(panel(sheet)!.style.height).toBe(`${Math.round(KEYBOARD_PX - pad)}px`);
    expect(sheet.shadowRoot?.querySelector('.ts__keyboard-room')).toBe(null);
  });

  it('reloads the field when the edit moves to another layer under it', async () => {
    const first = textLayer('text-1', 'Best pizza');
    const { store, sheet } = await mount(first);
    expect(field(sheet).value).toBe('Best pizza');

    // The shell keeps this sheet mounted for as long as the panel is text, so tapping a different
    // text layer on the preview carries on in the same instance - and the field, which is never
    // bound, has to be reloaded by hand.
    store.preview(m => ({ ...m, overlays: [...m.overlays, textLayer('text-2', 'Open now')] }));
    store.startEditText('text-2');
    await until('the field to be reloaded', () => field(sheet).value === 'Open now');

    type(sheet, 'Open late');
    expect((store.manifest.value.overlays[1] as TextOverlay).text).toBe('Open late');
    expect((store.manifest.value.overlays[0] as TextOverlay).text).toBe('Best pizza');
  });
});
