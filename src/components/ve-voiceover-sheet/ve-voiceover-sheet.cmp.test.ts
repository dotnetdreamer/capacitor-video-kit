import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest } from '../../editor';
import { browserMediaHost, resolveEditorHost } from '../../host/defaults';
import type { EditorVoiceHost } from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because a take is a clock: the watch loop runs on
 * `requestAnimationFrame`, the elapsed time is only written when its tenth changes, and the take
 * ends itself against the playhead the preview is moving. None of that runs without a real frame
 * callback.
 *
 * The microphone is the host's, so it is a fake here and the assertions are about what the sheet
 * asks it for and what it does with the answer - including the answers that are failures, which are
 * four different sentences and the only feedback a failed take gets.
 */

/** The whole video, and so the room a take started at 0 has. */
const TOTAL_MS = 6000;

/** What the fake recorder says it wrote, long enough to be a take rather than a slip of the finger. */
const TAKE_MS = 1200;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

interface FakeVoice extends EditorVoiceHost {
  readonly calls: string[];
}

interface VoiceBehaviour {
  /** Rejections to hand back from `start`, in order; anything left is a resolve. */
  startFails?: unknown[];
  stopFails?: boolean;
  durationMs?: number;
}

function fakeVoice(behaviour: VoiceBehaviour = {}): FakeVoice {
  const calls: string[] = [];
  const startFails = [...(behaviour.startFails ?? [])];
  return {
    calls,
    async start() {
      calls.push('start');
      const failure = startFails.shift();
      if (failure) throw failure;
    },
    async stop() {
      calls.push('stop');
      if (behaviour.stopFails) throw new Error('recorder failed');
      return { uri: 'take.m4a', durationMs: behaviour.durationMs ?? TAKE_MS };
    },
  };
}

function manifest(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: TOTAL_MS, speed: 1, volume: 1, muted: false }],
  };
}

interface Fixture {
  readonly store: EditorStore;
  readonly sheet: HTMLElement;
  readonly voice: FakeVoice;
  /** What the sheet asked the transport to do, which is how "it pauses on the way in" is read. */
  readonly transport: string[];
}

/**
 * The sheet over a store with a transport attached, because this is the one sheet that drives
 * playback: a take runs against the video and ends when the video does.
 */
async function mount(options: { at?: number; voice?: FakeVoice | null } = {}): Promise<Fixture> {
  const voice = options.voice === undefined ? fakeVoice() : options.voice;
  const host = resolveEditorHost({ media: { ...browserMediaHost(), voice: voice ?? undefined } });
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', TOTAL_MS]]), manifest());

  const transport: string[] = [];
  /* Stands in for `ve-preview`, which is what owns the media elements and the playhead. */
  store.attachPlayer({
    seek: (ms: number) => {
      transport.push(`seek ${Math.round(ms)}`);
      store.playheadMs.value = ms;
    },
    play: () => {
      transport.push('play');
      store.playing.value = true;
    },
    pause: () => {
      transport.push('pause');
      store.playing.value = false;
    },
  });
  store.playheadMs.value = options.at ?? 0;
  store.playing.value = true;
  store.openPanel('voiceover');

  /* The editor's own column on the phone it was drawn for, so a width is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'display: flex; flex-direction: column; width: 393px; height: 420px';
  document.body.append(column);

  const sheet = document.createElement('ve-voiceover-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  return { store, sheet, voice: voice ?? fakeVoice(), transport };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function recordButton(sheet: HTMLElement): HTMLButtonElement {
  return sheet.shadowRoot!.querySelector<HTMLButtonElement>('.vo__record')!;
}

function status(sheet: HTMLElement): string {
  return sheet.shadowRoot!.querySelector('.vo__status')!.textContent!.trim();
}

function deleteLast(sheet: HTMLElement): HTMLButtonElement | null {
  return sheet.shadowRoot?.querySelector<HTMLButtonElement>('.vo__delete') ?? null;
}

function takesLabel(sheet: HTMLElement): string | undefined {
  return sheet.shadowRoot?.querySelector('.vo__takes-count')?.textContent?.trim();
}

function takes(store: EditorStore) {
  return store.manifest.value.voiceovers;
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 3000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/** Starts a take and waits until the microphone is really on. */
async function record(sheet: HTMLElement, store: EditorStore): Promise<void> {
  recordButton(sheet).click();
  await until('the take to begin', () => store.recordingFromMs.value !== null);
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
});

describe('ve-voiceover-sheet', () => {
  it('stops the video on the way in, because the customer is about to choose where to speak', async () => {
    const { store, sheet, transport } = await mount();

    // Before the first render, which reads the room at the playhead this leaves behind.
    expect(transport[0]).toBe('pause');
    expect(store.playing.value).toBe(false);
    expect(head(sheet, '.sheet__title')?.textContent).toBe('Voiceover');
    expect(status(sheet)).toBe('Tap to record from 00:00');
    expect(recordButton(sheet).disabled).toBe(false);
  });

  it('will not record where a take has nowhere to go, and says where to move', async () => {
    const { sheet } = await mount({ at: TOTAL_MS });

    expect(recordButton(sheet).disabled).toBe(true);
    expect(status(sheet)).toBe('Move the playhead to an empty spot');
  });

  it('runs the take against the video and lands it where it was recorded', async () => {
    const { store, sheet, voice } = await mount();

    await record(sheet, store);
    // The timeline draws the take growing in red off this, and the shell refuses Next while it is
    // set, so it is what says a take is outstanding rather than the sheet's own phase.
    expect(store.recordingFromMs.value).toBe(0);
    expect(store.playing.value).toBe(true);
    expect(voice.calls).toEqual(['start']);
    await until('the clock', () => status(sheet).startsWith('Recording'));

    recordButton(sheet).click();
    await until('the take to land', () => takes(store).length === 1);

    expect(voice.calls).toEqual(['start', 'stop']);
    expect(takes(store)[0]).toMatchObject({ uri: 'take.m4a', startMs: 0, durationMs: TAKE_MS, volume: 1 });
    // Cleared on every path out, so nothing is left refusing Next.
    expect(store.recordingFromMs.value).toBe(null);
    // The playhead carries on from the end of the take, so the next tap records the next line.
    expect(store.playheadMs.value).toBe(TAKE_MS);
    expect(store.selection.value).toEqual({ kind: 'voice', id: takes(store)[0].id });
    await until('the count', () => takesLabel(sheet) === '1 take');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Voiceover');
    expect(takes(store)).toHaveLength(0);
  });

  it('gives a recorder left running by an earlier page one chance to let go', async () => {
    const stale = Object.assign(new Error('busy'), { code: 'already_recording' });
    const voice = fakeVoice({ startFails: [stale] });
    const { store, sheet } = await mount({ voice });

    await record(sheet, store);

    // Nobody can place what that recorder was holding, so it is stopped, thrown away and retried.
    expect(voice.calls).toEqual(['start', 'stop', 'start']);
    expect(store.recordingFromMs.value).toBe(0);
  });

  it('tells the customer where to turn the microphone on', async () => {
    const denied = Object.assign(new Error('Recording permission denied'), { code: 'permission_denied' });
    const { store, sheet } = await mount({ voice: fakeVoice({ startFails: [denied] }) });

    recordButton(sheet).click();
    await until('the toast', () => store.toast.value !== null);

    expect(store.toast.value?.text).toBe('Microphone access is off. Turn it on in Settings to record a voiceover.');
    expect(store.recordingFromMs.value).toBe(null);
    expect(takes(store)).toHaveLength(0);
  });

  it('calls a stop the recorder refused a short take rather than a broken microphone', async () => {
    const { store, sheet } = await mount({ voice: fakeVoice({ stopFails: true }) });
    await record(sheet, store);

    recordButton(sheet).click();
    await until('the answer', () => store.recordingFromMs.value === null);

    // Android's MediaRecorder cannot finish a file shorter than about 300ms and fails the stop
    // instead of handing back a tiny take.
    expect(store.toast.value?.text).toBe('That take was too short');
    expect(takes(store)).toHaveLength(0);
    // Back where the take began, so the next tap re-records the same line.
    expect(store.playheadMs.value).toBe(0);
    await until('the button to come back', () => recordButton(sheet).disabled === false);
  });

  it('refuses a take the recorder measured as nothing at all', async () => {
    const { store, sheet } = await mount({ voice: fakeVoice({ durationMs: 40 }) });
    await record(sheet, store);

    recordButton(sheet).click();
    await until('the answer', () => store.recordingFromMs.value === null);

    expect(store.toast.value?.text).toBe('That take was too short');
    expect(takes(store)).toHaveLength(0);
    expect(store.canUndo.value).toBe(false);
  });

  it('removes the last take and goes back to where it started', async () => {
    const { store, sheet } = await mount();
    await record(sheet, store);
    recordButton(sheet).click();
    await until('the take to land', () => takes(store).length === 1);
    await until('the button', () => deleteLast(sheet)?.disabled === false);

    deleteLast(sheet)!.click();

    expect(takes(store)).toHaveLength(0);
    expect(store.playheadMs.value).toBe(0);
    expect(store.selection.value).toBe(null);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Delete voiceover');
    expect(takes(store)).toHaveLength(1);
  });

  it('keeps a take in progress when the sheet is closed on the tick', async () => {
    const { store, sheet } = await mount();
    await record(sheet, store);

    head(sheet, '[aria-label="Done"]')!.click();

    expect(store.panel.value).toBe(null);
    // Losing a take to a tap on the tick would be far worse than having one more to delete.
    await until('the take to land anyway', () => takes(store).length === 1);
    expect(store.recordingFromMs.value).toBe(null);
  });

  it('keeps a take in progress when the element itself goes', async () => {
    const { store, sheet } = await mount();
    await record(sheet, store);

    sheet.remove();

    // The stop reaches the recorder synchronously and puts the take in the store when it answers,
    // which outlives this element - and is why the shell renders this sheet at a fixed position.
    await until('the take to land anyway', () => takes(store).length === 1);
    expect(store.recordingFromMs.value).toBe(null);
  });

  it('switches the clips’ own sound off, as one undo step', async () => {
    const { store, sheet } = await mount();
    const mute = sheet.shadowRoot!.querySelector<HTMLButtonElement>('.vo__mute')!;
    expect(mute.getAttribute('role')).toBe('switch');
    expect(mute.getAttribute('aria-checked')).toBe('false');

    mute.click();

    expect(store.manifest.value.originalMuted).toBe(true);
    expect(store.toast.value?.text).toBe('Original sound off');
    await until('the switch to follow', () => mute.getAttribute('aria-checked') === 'true');

    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Mute original sound');
    expect(store.manifest.value.originalMuted).toBe(false);
  });

  it('tells the customer the microphone would not start when the host has no recorder', async () => {
    const { store, sheet } = await mount({ voice: null });

    recordButton(sheet).click();
    await until('the toast', () => store.toast.value !== null);

    expect(store.toast.value?.text).toBe('The microphone could not be started.');
    expect(store.recordingFromMs.value).toBe(null);
  });
});
