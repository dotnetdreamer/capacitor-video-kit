import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest } from '../../editor';
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

function applyToAll(sheet: HTMLElement): HTMLButtonElement | null {
  return sheet.shadowRoot?.querySelector<HTMLButtonElement>('.sheet__apply-all') ?? null;
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
    await until('the button to offer to unmute', () => muteButton(sheet)?.getAttribute('aria-label') === 'Unmute');

    muteButton(sheet)!.click();

    // 0.6, not 0.8 and not zero: the level was remembered when the gesture opened, which is the
    // whole reason `ve-slider` promises `veGestureStart` before its first live value.
    expect(store.manifest.value.clips[0]).toMatchObject({ volume: START_LEVEL, muted: false });
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Unmute');
  });

  it('gives a clip that was already silent a level to come back to', async () => {
    const { store, sheet } = await mount({ kind: 'clip', id: 'seg-0' }, 2, 0, true);
    expect(muteButton(sheet)?.getAttribute('aria-label')).toBe('Unmute');

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

  it('mutes music by taking it to zero, since nothing in the manifest remembers where it was', async () => {
    const { store, sheet } = await mount({ kind: 'music' });

    muteButton(sheet)!.click();
    expect(store.manifest.value.music?.volume).toBe(0);
    await until('the button to offer to unmute', () => muteButton(sheet)?.getAttribute('aria-label') === 'Unmute');

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
