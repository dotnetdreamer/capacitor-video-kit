import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { MAX_MUSIC_FADE_MS, MIN_MUSIC_FADE_MS, MUSIC_FADE_MS, emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import type { VolumeTarget } from '../../state/editor.types';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because the level is set by a finger on a laid out bar: with
 * no layout the bar is nothing wide, every drag below lands on `min`, and the assertions would pass
 * whatever the sheet did with the value.
 *
 * Three kinds of target share one sheet and only a clip carries a `muted` flag of its own, so the
 * mute button means two different things and both are tested here. The level to come BACK to is the
 * thing most easily lost: it is remembered when the gesture opens, before the first live value has
 * had a chance to move it.
 */

/** Where every target starts: away from both ends, so a drag has room either way. */
const START_LEVEL = 0.6;

/** What unmuting brings a track back to when the sheet never saw it anywhere else. */
const DEFAULT_RESTORE_VOLUME = 0.8;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function manifest(clips: number, level = START_LEVEL, muted = false): EditManifest {
  return {
    ...emptyManifest(),
    clips: Array.from({ length: clips }, (_, i) => ({
      id: `seg-${i}`,
      clipKey: 'clip-a',
      inMs: 0,
      outMs: 5000,
      speed: 1,
      volume: level,
      muted,
    })),
    music: {
      uri: 'music.m4a',
      fileName: 'music.m4a',
      sourceDurationMs: 30_000,
      inMs: 0,
      outMs: 0,
      startMs: 0,
      endMs: 0,
      volume: START_LEVEL,
      loop: true,
      fadeOutMs: 0,
    },
    voiceovers: [{ id: 'vo-1', uri: 'take.m4a', startMs: 0, durationMs: 2000, volume: START_LEVEL }],
  };
}

/**
 * The sheet over a store whose volume target is already set, which is the state `store.openVolume`
 * hands it. Pass no target for the case the sheet has to survive: the thing it was adjusting gone.
 */
async function mount(target?: VolumeTarget, clips = 2, level = START_LEVEL, muted = false): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), manifest(clips, level, muted));
  if (target) store.openVolume(target);
  else store.openPanel('volume');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-volume-sheet');
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

function muteButton(sheet: HTMLElement): HTMLButtonElement | null {
  return sheet.shadowRoot?.querySelector<HTMLButtonElement>('.vol__mute') ?? null;
}

/**
 * A button's name as its content makes it: the text inside it, less anything `aria-hidden`. With no
 * `aria-label` on the button this is the accessible name every browser computes, and it is the only
 * name of a toggle that Android's WebView passes on (see `.sheet__hidden-name`).
 */
function textName(el: Element | null | undefined): string {
  if (!el) return '';
  let out = '';
  for (const node of el.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) out += node.textContent ?? '';
    else if (node instanceof Element && node.getAttribute('aria-hidden') !== 'true') out += textName(node);
  }
  return out.trim();
}

function applyToAll(sheet: HTMLElement): HTMLButtonElement | null {
  return sheet.shadowRoot?.querySelector<HTMLButtonElement>('.sheet__apply-all') ?? null;
}

/**
 * The music's fade switch named `label`, alone ("Fade in", off) or with its length ("Fade in 1.0s",
 * on) - the name a screen reader and a Maestro flow find it by.
 */
function fadeSwitch(sheet: HTMLElement, label: string): HTMLButtonElement | null {
  const all = sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('[role="switch"]') ?? [];
  return [...all].find(button => new RegExp(`^${label}( \\d+\\.\\ds)?$`).test(button.getAttribute('aria-label') ?? '')) ?? null;
}

/** The length slider in that fade's row, there whether the fade is on or not. */
function fadeSlider(sheet: HTMLElement, label: string): HTMLElement | null {
  return sheet.shadowRoot?.querySelector<HTMLElement>(`ve-slider[aria-label="${label} duration"]`) ?? null;
}

/** The length read out beside that slider. */
function fadeValue(sheet: HTMLElement, label: string): string | null {
  return fadeSlider(sheet, label)?.parentElement?.querySelector('.vol__fade-value')?.textContent ?? null;
}

/** A drag of `target` from one end of its bar PAST the other, which lands on that end wherever the bar is. */
function dragPastEnd(target: HTMLElement, toward: 'min' | 'max'): void {
  const bar = target.shadowRoot!.querySelector('.sl__track')!.getBoundingClientRect();
  // From the middle, which is a press on the bar and so a jump, then on past the end.
  const from = bar.left + bar.width / 2;
  const to = toward === 'max' ? bar.right + 40 : bar.left - 40;
  pointerId += 1;
  for (const [type, x] of [
    ['pointerdown', from],
    ['pointermove', to],
    ['pointerup', to],
  ] as const) {
    target.dispatchEvent(new PointerEvent(type, { pointerId, isPrimary: true, clientX: x, bubbles: true }));
  }
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

describe('ve-volume-sheet', () => {
  it('says which sound is being changed, because nothing else on screen does', async () => {
    const clip = await mount({ kind: 'clip', id: 'seg-0' });
    expect(head(clip.sheet, '.sheet__title')?.textContent).toBe('Clip volume');

    const music = await mount({ kind: 'music' });
    expect(head(music.sheet, '.sheet__title')?.textContent).toBe('Sound volume');

    const voice = await mount({ kind: 'voice', id: 'vo-1' });
    expect(head(voice.sheet, '.sheet__title')?.textContent).toBe('Voiceover volume');
  });

  it('writes the knob’s whole percent as the fraction the target keeps, one drag one step', async () => {
    const { store, sheet } = await mount({ kind: 'clip', id: 'seg-0' });
    expect(slider(sheet)?.getAttribute('aria-valuetext')).toBe('60%');

    drag(sheet, 60, 85);

    expect(store.manifest.value.clips[0].volume).toBeCloseTo(0.85, 6);
    // Only the target, never its siblings: that is what the "apply to all" button is for.
    expect(store.manifest.value.clips[1].volume).toBe(START_LEVEL);

    store.undo();
    expect(store.manifest.value.clips[0].volume).toBe(START_LEVEL);
    expect(store.toast.value?.text).toBe('Undo: Volume');
    expect(store.canUndo.value).toBe(false);
  });

  it('brings a clip dragged to silence back to the level it was dragged from', async () => {
    const { store, sheet } = await mount({ kind: 'clip', id: 'seg-0' });

    // Dragged to zero: silent AND muted, because a clip at zero with the flag off would be unmuted
    // by the button into a silence that looks like the button doing nothing.
    drag(sheet, 60, 0);
    expect(store.manifest.value.clips[0]).toMatchObject({ volume: 0, muted: true });
    await until('the button to offer to unmute', () => textName(muteButton(sheet)) === 'Unmute');

    muteButton(sheet)!.click();

    // 0.6, not 0.8 and not zero: the level was remembered when the gesture opened, which is the
    // whole reason `ve-slider` promises `veGestureStart` before its first live value.
    expect(store.manifest.value.clips[0]).toMatchObject({ volume: START_LEVEL, muted: false });
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Unmute');
  });

  it('gives a clip that was already silent a level to come back to', async () => {
    const { store, sheet } = await mount({ kind: 'clip', id: 'seg-0' }, 2, 0, true);
    expect(textName(muteButton(sheet))).toBe('Unmute');

    muteButton(sheet)!.click();

    // The sheet never saw this one anywhere but at zero, and unmuting it to a silent zero would
    // look like the button doing nothing.
    expect(store.manifest.value.clips[0]).toMatchObject({ volume: DEFAULT_RESTORE_VOLUME, muted: false });
  });

  it('mutes a clip with its own flag, leaving the level alone', async () => {
    const { store, sheet } = await mount({ kind: 'clip', id: 'seg-0' });

    muteButton(sheet)!.click();

    expect(store.manifest.value.clips[0]).toMatchObject({ volume: START_LEVEL, muted: true });
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Mute');
    expect(store.manifest.value.clips[0].muted).toBe(false);
  });

  it('names the mute button by its own words, which Android’s WebView passes on, and says it is pressed', async () => {
    const { sheet } = await mount({ kind: 'clip', id: 'seg-0' });
    const button = () => muteButton(sheet)!;

    // No `aria-label`: beside `aria-pressed` it was the name everywhere except Android, where the
    // button arrived as a ToggleButton with no name and the flows could not find "Mute".
    expect(button().hasAttribute('aria-label')).toBe(false);
    expect(textName(button())).toBe('Mute');
    expect(button().getAttribute('aria-pressed')).toBe('false');

    // The words are for a reader only. The icon is still the whole of what is seen, in the middle
    // of the button, because the hidden copy takes no room in its grid.
    const words = button().querySelector('.sheet__hidden-name')!;
    expect(words.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    const box = button().getBoundingClientRect();
    const icon = button().querySelector('ve-icon')!.getBoundingClientRect();
    expect(icon.left + icon.width / 2).toBeCloseTo(box.left + box.width / 2, 0);
    expect(icon.top + icon.height / 2).toBeCloseTo(box.top + box.height / 2, 0);

    button().click();
    await until('the button to offer to unmute', () => textName(button()) === 'Unmute');
    expect(button().getAttribute('aria-pressed')).toBe('true');
    expect(button().hasAttribute('aria-label')).toBe(false);
  });

  it('mutes music by taking it to zero, since nothing in the manifest remembers where it was', async () => {
    const { store, sheet } = await mount({ kind: 'music' });

    muteButton(sheet)!.click();
    expect(store.manifest.value.music?.volume).toBe(0);
    await until('the button to offer to unmute', () => textName(muteButton(sheet)) === 'Unmute');

    muteButton(sheet)!.click();
    expect(store.manifest.value.music?.volume).toBe(START_LEVEL);
  });

  it('offers every clip the selected one’s level, as one step, and only when there are siblings', async () => {
    const { store, sheet } = await mount({ kind: 'clip', id: 'seg-0' });
    drag(sheet, 60, 30);
    await until('the button', () => applyToAll(sheet) !== null);

    applyToAll(sheet)!.click();

    expect(store.manifest.value.clips.map(clip => clip.volume)).toEqual([0.3, 0.3]);
    expect(store.toast.value?.text).toBe('Volume applied to all clips');
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Volume for all');
    expect(store.manifest.value.clips[1].volume).toBe(START_LEVEL);

    // Nothing to spread a level across: the offer is not made at all.
    const alone = await mount({ kind: 'clip', id: 'seg-0' }, 1);
    expect(applyToAll(alone.sheet)).toBe(null);
  });

  it('records nothing when every clip already has the level, and says so', async () => {
    const { store, sheet } = await mount({ kind: 'clip', id: 'seg-0' });

    applyToAll(sheet)!.click();

    expect(store.canUndo.value).toBe(false);
    expect(store.toast.value?.text).toBe('All clips already have this volume');
  });

  it('switches the music’s fade in and fade out, each one step with its own name', async () => {
    const { store, sheet } = await mount({ kind: 'music' });
    expect(fadeSwitch(sheet, 'Fade in')?.getAttribute('aria-checked')).toBe('false');
    expect(fadeSwitch(sheet, 'Fade out')?.getAttribute('aria-checked')).toBe('false');

    fadeSwitch(sheet, 'Fade in')!.click();
    expect(store.manifest.value.music).toMatchObject({ fadeInMs: MUSIC_FADE_MS, fadeOutMs: 0 });
    await until('the switch to follow', () => fadeSwitch(sheet, 'Fade in')?.getAttribute('aria-checked') === 'true');

    fadeSwitch(sheet, 'Fade out')!.click();
    expect(store.manifest.value.music).toMatchObject({ fadeInMs: MUSIC_FADE_MS, fadeOutMs: MUSIC_FADE_MS });
    await until('the switch to follow', () => fadeSwitch(sheet, 'Fade out')?.getAttribute('aria-checked') === 'true');

    fadeSwitch(sheet, 'Fade in')!.click();
    expect(store.manifest.value.music?.fadeInMs).toBe(0);

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Fade in off');
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Fade out on');
    expect(store.manifest.value.music?.fadeOutMs).toBe(0);
  });

  it('reads a fade’s length in its switch, and sets it with the slider beside it, one drag one step', async () => {
    const { store, sheet } = await mount({ kind: 'music' });
    // Off: the name alone, and the slider out of reach at the length switching it on brings.
    expect(fadeSwitch(sheet, 'Fade in')?.getAttribute('aria-label')).toBe('Fade in');
    expect(fadeSlider(sheet, 'Fade in')?.getAttribute('aria-disabled')).toBe('true');
    expect(fadeValue(sheet, 'Fade in')).toBe('1.0s');

    fadeSwitch(sheet, 'Fade in')!.click();
    await until('the slider to wake', () => fadeSlider(sheet, 'Fade in')?.getAttribute('aria-disabled') !== 'true');
    expect(fadeSwitch(sheet, 'Fade in')?.getAttribute('aria-label')).toBe('Fade in 1.0s');

    dragPastEnd(fadeSlider(sheet, 'Fade in')!, 'max');
    expect(store.manifest.value.music?.fadeInMs).toBe(MAX_MUSIC_FADE_MS);
    await until('the name to follow', () => fadeSwitch(sheet, 'Fade in')?.getAttribute('aria-label') === 'Fade in 10.0s');
    expect(fadeValue(sheet, 'Fade in')).toBe('10.0s');

    dragPastEnd(fadeSlider(sheet, 'Fade in')!, 'min');
    expect(store.manifest.value.music?.fadeInMs).toBe(MIN_MUSIC_FADE_MS);

    // Each drag is its own step, named after the slider; the switch before them is another.
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Fade in duration');
    expect(store.manifest.value.music?.fadeInMs).toBe(MAX_MUSIC_FADE_MS);
    store.undo();
    expect(store.manifest.value.music?.fadeInMs).toBe(MUSIC_FADE_MS);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Fade in on');
  });

  it('brings a fade switched off and on again back at the length it was set to', async () => {
    const { store, sheet } = await mount({ kind: 'music' });
    fadeSwitch(sheet, 'Fade out')!.click();
    await until('the slider to wake', () => fadeSlider(sheet, 'Fade out')?.getAttribute('aria-disabled') !== 'true');
    dragPastEnd(fadeSlider(sheet, 'Fade out')!, 'max');

    fadeSwitch(sheet, 'Fade out')!.click();
    expect(store.manifest.value.music?.fadeOutMs).toBe(0);
    // Off, the slider stays where it was left, dimmed and out of reach, and so does its length.
    await until('the slider to sleep', () => fadeSlider(sheet, 'Fade out')?.getAttribute('aria-disabled') === 'true');
    expect(fadeSwitch(sheet, 'Fade out')?.getAttribute('aria-label')).toBe('Fade out');
    expect(fadeValue(sheet, 'Fade out')).toBe('10.0s');
    dragPastEnd(fadeSlider(sheet, 'Fade out')!, 'min');
    expect(store.manifest.value.music?.fadeOutMs).toBe(0);

    fadeSwitch(sheet, 'Fade out')!.click();
    expect(store.manifest.value.music?.fadeOutMs).toBe(MAX_MUSIC_FADE_MS);
  });

  it('offers fades on the music only, since no engine fades a clip or a take', async () => {
    const clip = await mount({ kind: 'clip', id: 'seg-0' });
    expect(fadeSwitch(clip.sheet, 'Fade in')).toBe(null);
    expect(fadeSwitch(clip.sheet, 'Fade out')).toBe(null);

    const voice = await mount({ kind: 'voice', id: 'vo-1' });
    expect(fadeSwitch(voice.sheet, 'Fade in')).toBe(null);
    expect(fadeSwitch(voice.sheet, 'Fade out')).toBe(null);
  });

  it('draws no control with no target, and asks the shell to close', async () => {
    const { store, sheet } = await mount();

    // A mute button over nothing would be a control whose press reached no sound at all.
    expect(muteButton(sheet)).toBe(null);
    expect(slider(sheet)).toBe(null);
    // Deferred on purpose: run inside the write that took the target away, this would be closing
    // the panel from inside the undo that is still finishing.
    await until('the panel to close itself', () => store.panel.value === null);
  });
});
