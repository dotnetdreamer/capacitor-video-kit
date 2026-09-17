import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { defaultClipEdit, emptyManifest, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';
import { SEEK_EPSILON_S } from './preview-media';

/*
 * A browser rather than the mock DOM, because what is being pinned here happens between a render and
 * the two `<video>` elements it has just moved, and the mock DOM has neither.
 *
 * The bug: a layout preset writes a rectangle onto every clip of both tracks, so both elements are
 * given a new box while the playhead does not move by a millisecond. `resync` therefore finds the
 * base element on exactly the time it is already on and seeks nothing, quite correctly - and a
 * PAUSED element paints nothing of its own accord, so WKWebView left the base track's picture in the
 * shape of its old box and black inside its new one. The export of the same manifest was right,
 * which is what said the composition was never the problem.
 *
 * So these assert that a frame was ASKED FOR, not that the box is right. The box was right all
 * along; it was the picture that was missing, and the only thing that makes a paused element decode
 * and present one is a seek to a position it is not already on.
 */

/** What every element in the editor is handed, and what a `<video>` here is stood in for by. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/** A paused element parked a second into its clip, which is the state the bug needs. */
const PARKED_S = 1;
const DURATION_S = 5;

/** Every `currentTime` written to one element, which is the preview asking it for a frame. */
interface Seeks {
  video: HTMLVideoElement;
  at: number[];
}

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

function manifest(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [defaultClipEdit('clip-a', 5000, 'seg-a')],
    videoTracks: [
      { id: 'track-1', clips: [defaultClipEdit('clip-b', 4000, 'seg-b')], startMs: 0, z: 1, opacity: 1 },
    ],
  };
}

async function mount(): Promise<{ store: EditorStore; preview: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load(
    [
      { key: 'clip-a', fileName: 'a.mp4' },
      { key: 'clip-b', fileName: 'b.mp4' },
    ],
    new Map([
      ['clip-a', 5000],
      ['clip-b', 4000],
    ]),
    manifest(),
  );

  /* The editor's own column on the phone it was drawn for, so a box is a measurement. */
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 720px';
  document.body.append(column);

  const preview = document.createElement('ve-preview');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(preview, { ctx });
  column.append(preview);

  mounted.push({ store, column });
  await (preview as StencilElement).componentOnReady?.();
  return { store, preview };
}

function videos(preview: HTMLElement): HTMLVideoElement[] {
  return [...preview.querySelectorAll('video')];
}

/**
 * Stands in for a loaded element and writes down every seek the preview asks of it.
 *
 * There is no file to play in a test runner, so the two things the repaint depends on are said here
 * instead: the element is paused, and it is holding a frame. Everything above them is the real
 * component, the real store and the real player.
 */
function watchSeeks(video: HTMLVideoElement): Seeks {
  const at: number[] = [];
  let position = PARKED_S;
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => position,
    set: (value: number) => {
      position = value;
      at.push(value);
    },
  });
  Object.defineProperty(video, 'readyState', { configurable: true, get: () => 4 /* HAVE_ENOUGH_DATA */ });
  Object.defineProperty(video, 'duration', { configurable: true, get: () => DURATION_S });
  return { video, at };
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise(resolve => requestAnimationFrame(resolve));
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
});

describe('ve-preview repaints an element whose box has moved', () => {
  it('asks both paused elements for a frame when a layout preset moves them', async () => {
    const { store, preview } = await mount();
    const [baseEl, extraEl] = videos(preview);
    expect(extraEl).toBeDefined();
    const base = watchSeeks(baseEl);
    const extra = watchSeeks(extraEl);

    store.applyLayoutPreset('track-1', 'splitTopBottom', 'Top and bottom');

    await until('the base element to be asked for a frame', () => base.at.length > 0);
    await until('the second layer to be asked for a frame', () => extra.at.length > 0);
    // The box really did move, which is the half of it that was already working.
    expect(baseEl.style.height).toBe('50%');
    expect(extraEl.style.top).toBe('50%');
    // A seek to where the element already is may be answered with nothing at all, so the frame is
    // asked for from a position it is not on - and from near enough that the picture does not move.
    for (const seeks of [base, extra]) {
      expect(seeks.at[0]).not.toBe(PARKED_S);
      expect(Math.abs(seeks.at[0] - PARKED_S)).toBeLessThan(SEEK_EPSILON_S);
    }
  });

  it('asks for nothing on a render that moves neither box', async () => {
    const { store, preview } = await mount();
    const [baseEl, extraEl] = videos(preview);
    const base = watchSeeks(baseEl);
    const extra = watchSeeks(extraEl);

    // A repaint of the whole component that leaves both elements exactly where they were: a frame
    // per render would be a decode per render, on an element that already has the right picture.
    store.fullscreen.value = true;

    await until('the stage to go full screen', () => !!preview.querySelector('.pv__stage--full'));
    await frames(3);
    expect(base.at).toEqual([]);
    expect(extra.at).toEqual([]);
  });
});
