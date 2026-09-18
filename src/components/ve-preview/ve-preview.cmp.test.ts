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
 *
 * The second group is the tap that comes back to a black preview: Add video, which opens a picker,
 * which hides the page. WebKit purges every paused element's decoded frame while the page is away
 * and puts nothing back, so the base element came back with no picture and no seek could give it
 * one - see [onPageShown] - and the second element arrived on a source it was never seeked on, which
 * a WebView answers by presenting nothing at all. Neither is visible in Chromium, which composites
 * both cases as the frame they still hold, so what is asserted is again what was ASKED of the
 * elements: the base is pointed at its source again, and the second one is seeked as it lands.
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

function manifest(withTrack: boolean): EditManifest {
  const base = { ...emptyManifest(), clips: [defaultClipEdit('clip-a', 5000, 'seg-a')] };
  if (!withTrack) return base;
  return {
    ...base,
    videoTracks: [
      { id: 'track-1', clips: [defaultClipEdit('clip-b', 4000, 'seg-b')], startMs: 0, z: 1, opacity: 1 },
    ],
  };
}

async function mount(withTrack = true): Promise<{ store: EditorStore; preview: HTMLElement }> {
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
    manifest(withTrack),
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

/** One element's stand-in state: where it is, every position written to it, every load asked of it. */
interface Stood {
  position: number;
  at: number[];
  loads: number[];
}

/**
 * Stands in for the FILES, so the player's load path can run to its end in a test runner.
 *
 * Nothing here decides anything. Every element is given the state a loaded one would have (a frame,
 * a duration), `load()` answers with the metadata event the player's whole load path hangs off, and
 * every position written to any element is written down. It patches the prototype rather than the
 * elements because the second layer's `<video>` is created by a render and loaded in the same tick,
 * so there is no moment in between to reach that one in.
 */
function standInForFiles(): { of: (el: HTMLMediaElement) => Stood; restore: () => void } {
  const proto = HTMLMediaElement.prototype;
  const was = {
    currentTime: Object.getOwnPropertyDescriptor(proto, 'currentTime')!,
    readyState: Object.getOwnPropertyDescriptor(proto, 'readyState')!,
    duration: Object.getOwnPropertyDescriptor(proto, 'duration')!,
    load: proto.load,
  };
  const state = new WeakMap<HTMLMediaElement, Stood>();
  const of = (el: HTMLMediaElement): Stood => {
    const one = state.get(el) ?? { position: 0, at: [], loads: [] };
    state.set(el, one);
    return one;
  };

  Object.defineProperty(proto, 'currentTime', {
    configurable: true,
    get(this: HTMLMediaElement) {
      return of(this).position;
    },
    set(this: HTMLMediaElement, value: number) {
      const one = of(this);
      one.position = value;
      one.at.push(value);
    },
  });
  Object.defineProperty(proto, 'readyState', { configurable: true, get: () => 4 /* HAVE_ENOUGH_DATA */ });
  Object.defineProperty(proto, 'duration', { configurable: true, get: () => DURATION_S });
  // The real one is not called: with no file behind the src it would only end in an error event,
  // which the player would rightly read as a clip that cannot be played.
  proto.load = function (this: HTMLMediaElement) {
    of(this).loads.push(of(this).position);
    queueMicrotask(() => this.dispatchEvent(new Event('loadedmetadata')));
  };

  return {
    of,
    restore() {
      Object.defineProperty(proto, 'currentTime', was.currentTime);
      Object.defineProperty(proto, 'readyState', was.readyState);
      Object.defineProperty(proto, 'duration', was.duration);
      proto.load = was.load;
    },
  };
}

/**
 * The picker: the page goes away and comes back. What that costs is in [onPageShown], and the whole
 * of what the editor can see of it is these two events.
 */
async function pageAway(): Promise<void> {
  await pageIs('hidden');
  await pageIs('visible');
}

async function pageIs(state: DocumentVisibilityState): Promise<void> {
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => state });
  document.dispatchEvent(new Event('visibilitychange'));
  await frames(2);
}

/** What the picker's result does to the post: the second source, on a layer of its own, at the top. */
function addSecondVideo(store: EditorStore): void {
  store.addVideoTrack(defaultClipEdit('clip-b', 4000, 'seg-b'));
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

const standIns: { restore: () => void }[] = [];

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
  for (const stand of standIns.splice(0)) stand.restore();
  // Back to the document's own, which is what deleting an own property uncovers.
  Reflect.deleteProperty(document, 'visibilityState');
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

    // A repaint of the whole component that rewrites both elements' style and leaves both of them
    // exactly where they were: a frame per render would be a decode per render, on an element that
    // already has the right picture.
    store.setFilter('crisp');

    await until('the filter to reach the elements', () => baseEl.style.filter !== 'none');
    await frames(3);
    expect(base.at).toEqual([]);
    expect(extra.at).toEqual([]);
  });

  it('asks both elements for a frame when the stage itself changes size', async () => {
    const { store, preview } = await mount();
    const [baseEl, extraEl] = videos(preview);
    const base = watchSeeks(baseEl);
    const extra = watchSeeks(extraEl);

    // Full screen widens the stage, and every box in the frame is a percentage of it: both pictures
    // move and grow while not one number the views are compared on has changed. A sheet opening does
    // the same thing in the other direction, which is the one the customer sees.
    store.fullscreen.value = true;

    await until('the stage to go full screen', () => !!preview.querySelector('.pv__stage--full'));
    await until('the base element to be asked for a frame', () => base.at.length > 0);
    await until('the second layer to be asked for a frame', () => extra.at.length > 0);
    for (const seeks of [base, extra]) {
      expect(seeks.at[0]).not.toBe(PARKED_S);
      expect(Math.abs(seeks.at[0] - PARKED_S)).toBeLessThan(SEEK_EPSILON_S);
    }
  });
});

describe('ve-preview adding a second video while paused', () => {
  it('points the base element at its source again once the picker has given the page back', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mount(false);
    const baseEl = videos(preview)[0];
    await until('the base to load its clip', () => files.of(baseEl).loads.length > 0);
    await until('that load to end on a frame', () => files.of(baseEl).at.length > 0);
    const settled = { loads: files.of(baseEl).loads.length, at: files.of(baseEl).at.length };

    // The tap: a picker, which hides the page, and the source it comes back with.
    await pageAway();
    addSecondVideo(store);

    // A load, because a seek cannot cure what the page being hidden did to this element, and the
    // player cannot tell the two apart from in here: whatever it was showing, it is showing it
    // again only once the source has been put back on.
    await until('the base to be pointed at its source again', () => files.of(baseEl).loads.length > settled.loads);
    await until('the base to be asked for a frame', () => files.of(baseEl).at.length > settled.at);
    expect(files.of(baseEl).at.at(-1)).toBe(0);
    // The element that was reloaded is the one the first render made. The second layer arriving
    // beside it must not have made the vdom hand the player a different one.
    expect(videos(preview)[0]).toBe(baseEl);
  });

  it('asks the second layer for a frame as its source lands, at a playhead it is already on', async () => {
    const files = standInForFiles();
    standIns.push(files);
    const { store, preview } = await mount(false);
    const baseEl = videos(preview)[0];
    await until('the base to settle on its clip', () => files.of(baseEl).at.length > 0);

    addSecondVideo(store);

    await until('the second element to be written out', () => videos(preview).length > 1);
    const extraEl = videos(preview)[1];
    await until('the second layer to be asked for a frame', () => files.of(extraEl).at.length > 0);
    // Nothing had moved it: a new layer starts at 0 with the playhead on 0, so the only seek that
    // can have made this element present anything is the one a fresh source always gets.
    expect(store.playheadMs.value).toBe(0);
    expect(files.of(extraEl).at[0]).toBe(0);
  });
});
