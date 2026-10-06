import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { defaultClipEdit, emptyManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import type { EditorMediaHost, EditorSoundLibrary, SavedSound } from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * The sheet where a sound comes from. What is worth a browser here is not layout but the rows: the
 * list is built from what a host handed over, and the delete is a two-tap gesture whose second tap
 * has to be a different element from the first.
 *
 * The preview player is deliberately not driven. `HTMLAudioElement.play` rejects in a headless
 * browser with no output device, and what the sheet does with that rejection - drop the pressed
 * state and say so - is asserted through the same path as a file that will not open.
 */

const SAVED: SavedSound[] = [
  { id: 'snd-1', uri: 'file:///sounds/snd-1.m4a', fileName: 'holiday', durationMs: 83_000, savedAt: Date.now() },
  { id: 'snd-2', uri: 'file:///sounds/snd-2.m4a', fileName: 'market', durationMs: 5000, savedAt: Date.now() - 86_400_000 },
];

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function library(overrides: Partial<EditorSoundLibrary> = {}): EditorSoundLibrary {
  return {
    list: vi.fn(async () => SAVED),
    extract: vi.fn(async () => SAVED[0]),
    remove: vi.fn(async () => undefined),
    ...overrides,
  };
}

function mediaHost(sounds: EditorSoundLibrary | undefined): EditorMediaHost {
  return {
    pickVideo: vi.fn(async () => ({ key: 'picked', fileName: 'picked.mp4' })),
    pickImage: vi.fn(async () => null),
    pickAudio: vi.fn(async () => ({ uri: 'blob:music', fileName: 'music.mp3', sourceDurationMs: 9000 })),
    probeDuration: vi.fn(async () => 3000),
    thumbnails: vi.fn(async () => []),
    ...(sounds ? { sounds } : {}),
  };
}

async function mount(sounds: EditorSoundLibrary | undefined = library()): Promise<{
  store: EditorStore;
  media: EditorMedia;
  sheet: HTMLElement;
}> {
  const host = resolveEditorHost({ media: mediaHost(sounds) });
  const store = new EditorStore(host);
  const media = new EditorMedia(store, host);
  const ctx: EditorContext = { store, media };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 5000]]), { ...emptyManifest(), clips: [defaultClipEdit('clip-a', 5000)] });
  store.openPanel('sound');

  const column = document.createElement('div');
  column.style.cssText = 'width: 393px';
  document.body.append(column);

  const sheet = document.createElement('ve-sound-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (sheet.shadowRoot?.querySelector('ve-sheet') as StencilElement | null)?.componentOnReady?.();
  return { store, media, sheet };
}

function rows(sheet: HTMLElement): HTMLElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLElement>('.snd__row') ?? [])];
}

function actions(sheet: HTMLElement): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('.snd__action') ?? [])];
}

function text(el: Element | null | undefined): string {
  return el?.textContent?.trim() ?? '';
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

describe('ve-sound-sheet', () => {
  it('lists what the host kept, newest first, with its length', async () => {
    const { sheet } = await mount();
    await until('the list', () => rows(sheet).length === 2);

    expect(rows(sheet).map(row => text(row.querySelector('.snd__name')))).toEqual(['holiday', 'market']);
    expect(text(rows(sheet)[0].querySelector('.snd__meta'))).toBe('1:23 · Today');
    expect(text(rows(sheet)[1].querySelector('.snd__meta'))).toBe('0:05 · Yesterday');
  });

  it('offers both doors, and says what each one does', async () => {
    const { sheet } = await mount();
    expect(actions(sheet).map(button => text(button.querySelector('.snd__action-title')))).toEqual(['Extract from video', 'From files']);
  });

  it('puts a tapped sound on the post and closes itself', async () => {
    const { store, sheet } = await mount();
    await until('the list', () => rows(sheet).length === 2);

    rows(sheet)[1].querySelector<HTMLButtonElement>('.snd__pick')!.click();

    expect(store.manifest.value.audioTracks?.[0]?.clips[0]).toMatchObject({ uri: SAVED[1].uri, fileName: 'market' });
    expect(store.panel.value).toBeNull();
  });

  it('marks the track the post is already using', async () => {
    const { store, sheet } = await mount();
    await until('the list', () => rows(sheet).length === 2);

    rows(sheet)[0].querySelector<HTMLButtonElement>('.snd__pick')!.click();
    store.openPanel('sound');
    await until('the tick', () => !!sheet.shadowRoot?.querySelector('.snd__in-use'));

    expect(rows(sheet)[0].querySelector('.snd__in-use')).not.toBeNull();
    expect(rows(sheet)[1].querySelector('.snd__in-use')).toBeNull();
    // A picture with a name. A label on a span with no role reached Android's WebView as a TextView
    // with no text; an image's label is its content description there, and its label in VoiceOver.
    const tick = rows(sheet)[0].querySelector('.snd__in-use')!;
    expect(tick.getAttribute('role')).toBe('img');
    expect(tick.getAttribute('aria-label')).toBe('On this post');
  });

  it('names each row’s Play button by its own words, which Android’s WebView passes on', async () => {
    const { sheet } = await mount();
    await until('the list', () => rows(sheet).length === 2);
    const play = rows(sheet).map(row => row.querySelector<HTMLButtonElement>('.snd__play')!);

    // No `aria-label`: beside `aria-pressed` it was the name everywhere except Android, where the
    // button arrived as a ToggleButton with no name and editor-sound-sheet.yaml stopped at "Play .*".
    expect(play.map(button => button.hasAttribute('aria-label'))).toEqual([false, false]);
    expect(play.map(textName)).toEqual(['Play holiday', 'Play market']);
    // Still a toggle, and not playing: the preview player is not driven here (see the top).
    expect(play.map(button => button.getAttribute('aria-pressed'))).toEqual(['false', 'false']);
    expect(play[0].querySelector('.sheet__hidden-name')!.getBoundingClientRect().width).toBeLessThanOrEqual(1);
  });

  it('takes two taps to delete, and the first one can be waited out', async () => {
    const remove = vi.fn(async () => undefined);
    const { sheet } = await mount(library({ remove }));
    await until('the list', () => rows(sheet).length === 2);

    rows(sheet)[0].querySelector<HTMLButtonElement>('.snd__bin')!.click();
    await until('the confirm', () => !!rows(sheet)[0].querySelector('.snd__confirm'));
    expect(remove).not.toHaveBeenCalled();

    rows(sheet)[0].querySelector<HTMLButtonElement>('.snd__confirm')!.click();
    expect(remove).toHaveBeenCalledWith('snd-1');
    await until('the row to go', () => rows(sheet).length === 1);
  });

  it('shows what the library is for while it is empty', async () => {
    const { sheet } = await mount(library({ list: vi.fn(async () => []) }));
    await until('the empty state', () => !!sheet.shadowRoot?.querySelector('.snd__empty p'));

    expect(text(sheet.shadowRoot?.querySelector('.snd__empty p'))).toContain('Sounds you take out of a video');
  });

  it('stays open when the customer backs out of the picker', async () => {
    const { store, sheet } = await mount(library({ extract: vi.fn(async () => null) }));
    await until('the list', () => rows(sheet).length === 2);

    actions(sheet)[0].click();
    await until('the extraction to finish', () => !actions(sheet)[0].disabled);

    expect(store.manifest.value.music).toBeNull();
    expect(store.panel.value).toBe('sound');
  });

  it('closes after a file adds an audio clip', async () => {
    const { store, sheet } = await mount();
    actions(sheet)[1].click();

    await until('the audio clip to land', () => (store.manifest.value.audioTracks?.[0]?.clips.length ?? 0) === 1);
    await until('the sheet to close', () => store.panel.value === null);
    expect(store.panel.value).toBeNull();
  });

  it('puts a file in place of the sound a Replace opened it for, and closes', async () => {
    const { store, sheet } = await mount();
    await until('the list', () => rows(sheet).length === 2);
    rows(sheet)[0].querySelector<HTMLButtonElement>('.snd__pick')!.click();
    const id = store.selectedAudio.value!.id;

    store.openSoundSheet({ kind: 'audio', id });
    await until('the sheet', () => actions(sheet).length === 2);
    actions(sheet)[1].click();

    await until('the sound to be replaced', () => store.selectedAudio.value?.uri !== SAVED[0].uri);
    await until('the sheet to close', () => store.panel.value === null);
    // In its place: the same sound, and still the only one.
    expect(store.manifest.value.audioTracks?.flatMap(track => track.clips.map(clip => clip.id))).toEqual([id]);
  });

  it('greys both doors while an extraction is running', async () => {
    let finish = (_: SavedSound | null) => undefined as void;
    const extract = vi.fn(
      () =>
        new Promise<SavedSound | null>(resolve => {
          finish = resolve;
        }),
    );
    const { sheet } = await mount(library({ extract }));

    actions(sheet)[0].click();
    await until('the buttons to grey', () => actions(sheet).every(button => button.disabled));
    expect(text(sheet.shadowRoot?.querySelector('.snd__action-title'))).toBe('Taking the sound out…');

    finish(SAVED[0]);
    await until('the buttons to come back', () => actions(sheet).every(button => !button.disabled), 3000);
  });
});
