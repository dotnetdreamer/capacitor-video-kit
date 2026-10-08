import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest, type EditMusic, type EditVideoTrack, type TextOverlay } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';
import type { Peaks } from '../../web-runtime/waveform';

/*
 * The timeline as more than one row of video: what the rows are, and the long press that carries a
 * segment off the row it is on and onto another - or onto a layer of its own opened between two.
 *
 * A browser rather than the mock DOM, because the whole gesture is measured: which layer a drop
 * lands on is read from where the rows really are on the screen against where the finger really is,
 * and in a mock DOM every rectangle is zero and every answer would be the first row.
 */

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function segment(id: string, clipKey: string) {
  return { id, clipKey, inMs: 0, outMs: 4000, speed: 1, volume: 1, muted: false };
}

function layer(id: string, z: number, clips: { id: string; key: string }[]): EditVideoTrack {
  return { id, clips: clips.map(c => segment(c.id, c.key)), startMs: 0, z, opacity: 1 };
}

/** Three segments on the base track: the post as the editor opens it, with room to move one off. */
function fixture(videoTracks: EditVideoTrack[] = []): EditManifest {
  return {
    ...emptyManifest(),
    clips: [segment('seg-a', 'clip-a'), segment('seg-b', 'clip-b'), segment('seg-c', 'clip-c')],
    videoTracks,
  };
}

async function mount(videoTracks: EditVideoTrack[] = []): Promise<{ store: EditorStore; tl: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  const keys = ['clip-a', 'clip-b', 'clip-c', 'clip-x', 'clip-y'];
  store.load(
    keys.map(key => ({ key, fileName: `${key}.mp4` })),
    new Map(keys.map(key => [key, 4000])),
    fixture(videoTracks),
  );

  // The editor's own column on the phone it was drawn for, and the height `ve-editor` gives the
  // timeline: the rows have to be where they really are or none of this measures anything.
  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 286px';
  document.body.append(column);

  const tl = document.createElement('ve-timeline');
  // The column's height is the timeline's only if the host takes it, as `.ve__timeline` does in the
  // editor. Left alone the host is a block of no height that clips everything in it out of reach of
  // a finger, and the lanes have no view to pan in.
  tl.style.height = '100%';
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(tl, { ctx });
  column.append(tl);
  mounted.push({ store, column });
  await (tl as StencilElement).componentOnReady?.();
  await frames(2);
  return { store, tl };
}

function root(tl: HTMLElement): ShadowRoot {
  return tl.shadowRoot!;
}

function rows(tl: HTMLElement): HTMLElement[] {
  return [...root(tl).querySelectorAll<HTMLElement>('[data-vrow]')];
}

function row(tl: HTMLElement, name: string): HTMLElement {
  const found = root(tl).querySelector<HTMLElement>(`[data-vrow="${name}"]`);
  if (!found) throw new Error(`no ${name} row`);
  return found;
}

function segmentEl(tl: HTMLElement, id: string): HTMLElement {
  const found = root(tl).querySelector<HTMLElement>(`.seg[data-id="${id}"]`);
  if (!found) throw new Error(`no ${id} segment`);
  return found;
}

function centre(el: Element): { x: number; y: number } {
  const rect = el.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

function pointer(on: Element, type: string, x: number, y: number): void {
  on.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: 'touch', isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise(resolve => requestAnimationFrame(resolve));
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/**
 * The component behind the element. Through Stencil's own host ref, because in the lazy build the
 * element and the component are two objects and nothing else hands the component out.
 *
 * Not by the host ref's `$lazyInstance$`: `npm test` builds with `--prod`, which renames every
 * `$...$` field of Stencil's to a letter, so that name is only there in a dev build. What survives
 * the minifier is the method both ends are given: the instance is the one object on the host ref,
 * other than the element itself, whose own `__stencil__getHostRef` hands back that same host ref.
 */
type WithHostRef = { __stencil__getHostRef?: () => object };

function instanceOf<T>(tl: HTMLElement): T {
  const hostRef = (tl as HTMLElement & WithHostRef).__stencil__getHostRef?.();
  const instance =
    hostRef &&
    Object.values(hostRef).find((v): v is T & WithHostRef => typeof v === 'object' && v !== null && v !== tl && (v as WithHostRef).__stencil__getHostRef?.() === hostRef);
  if (!instance) throw new Error('no component instance');
  return instance;
}

/**
 * Counts the timeline's renders, from the hook every one of them ends in. Stencil looks
 * `componentDidRender` up by name on the instance at the end of every render, so a wrapper put on
 * the instance is the one it calls. A render that changes nothing on the page is exactly what is
 * being counted, and no DOM observer can see one of those.
 */
function countRenders(tl: HTMLElement): () => number {
  type Instance = { componentDidRender?: () => void };
  const instance = instanceOf<Instance>(tl);
  const original = instance.componentDidRender;
  if (!original) throw new Error('no componentDidRender to count');
  let count = 0;
  instance.componentDidRender = function (this: Instance) {
    count += 1;
    original.call(this);
  };
  return () => count;
}

/** Waits out whatever the last change set going, until five frames pass without a render. */
async function settle(renders: () => number): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    const before = renders();
    await frames(5);
    if (renders() === before) return;
  }
  throw new Error('the timeline never stopped rendering');
}

/** What the tests below read off the component: the memoised views, by reference. */
type Views = {
  trimHandles: { value: unknown };
  musicLane: { value: unknown };
  musicHandles: { value: unknown };
  clipWaves: { value: unknown };
};

/**
 * A long press on a segment, then the finger carried to `(x, y)`. Leaves the finger DOWN, so a test
 * can look at what the timeline is showing before deciding to let go.
 */
async function lift(tl: HTMLElement, id: string, to: { x: number; y: number }): Promise<void> {
  const from = centre(segmentEl(tl, id));
  pointer(segmentEl(tl, id), 'pointerdown', from.x, from.y);
  await until('the lift', () => root(tl).querySelector('.tl--reordering') !== null);
  pointer(root(tl).querySelector('.tl__scroller')!, 'pointermove', to.x, to.y);
  await frames(2);
}

function drop(tl: HTMLElement, at: { x: number; y: number }): void {
  pointer(root(tl).querySelector('.tl__scroller')!, 'pointerup', at.x, at.y);
}

/** Five video layers over the base track: more rows than the timeline has room for. */
function fiveLayers(): EditVideoTrack[] {
  return [1, 2, 3, 4, 5].map(n => layer(`vt-${n}`, n, [{ id: `seg-${n}`, key: n % 2 ? 'clip-x' : 'clip-y' }]));
}

/** How far up the rows are panned, read off the transform the component writes on their column. */
function pannedBy(column: HTMLElement): number {
  return -Number(/translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(column.style.transform)?.[1] ?? 0);
}

/**
 * A finger put down on `on` and swiped `by` px straight up, held still long enough at the end to leave
 * no fling behind it, and let go.
 */
async function swipeUp(tl: HTMLElement, on: Element, from: { x: number; y: number }, by: number): Promise<void> {
  const scroller = root(tl).querySelector('.tl__scroller')!;
  pointer(on, 'pointerdown', from.x, from.y);
  pointer(scroller, 'pointermove', from.x, from.y - 20);
  await frames(1);
  pointer(scroller, 'pointermove', from.x, from.y - by);
  await frames(2);
  await new Promise(resolve => setTimeout(resolve, 120));
  pointer(scroller, 'pointerup', from.x, from.y - by);
  await frames(2);
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
});

describe('the rows', () => {
  it('draws the base track and nothing else while the post is one video', async () => {
    const { tl } = await mount();
    expect(rows(tl).map(r => r.dataset.vrow)).toEqual(['base']);
  });

  it('draws a row for every layer, nearest the base track first', async () => {
    // Stored out of order on purpose: `z` is the drawing order, and the rows have to agree with it
    // rather than with whichever order the layers happen to sit in the manifest.
    const { tl } = await mount([layer('vt-2', 2, [{ id: 'seg-y', key: 'clip-y' }]), layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    expect(rows(tl).map(r => r.dataset.vrow)).toEqual(['base', 'vt-1', 'vt-2']);
  });

  /*
   * More rows than fit pan up and down, and the pan is kept inside the rows - but only when the
   * timeline renders, and a timeline that only gets TALLER renders nothing: a split screen's divider
   * dragged, a window made taller. Rows panned to their end were left past the new one, with a band
   * of black under the last of them, until something else repainted.
   */
  it('keeps the rows panned inside themselves when the timeline gets taller', async () => {
    const { tl } = await mount(fiveLayers());
    const view = root(tl).querySelector<HTMLElement>('.tl__content')!;
    const column = root(tl).querySelector<HTMLElement>('.tl__rows')!;
    const room = () => column.offsetHeight - view.clientHeight;
    const panned = () => pannedBy(column);
    expect(room()).toBeGreaterThan(0);

    // Up past the end, held still long enough to leave no fling behind it, and let go.
    const box = view.getBoundingClientRect();
    const x = box.left + 20;
    const y = box.top + 20;
    pointer(view, 'pointerdown', x, y);
    pointer(view, 'pointermove', x, y - 20);
    await frames(1);
    pointer(view, 'pointermove', x, y - 600);
    await frames(2);
    await new Promise(resolve => setTimeout(resolve, 120));
    pointer(view, 'pointerup', x, y - 600);
    await until('the rows to be panned to their end', () => panned() > 0 && Math.abs(panned() - room()) < 0.5);
    // Letting go asks for a render of its own, which clamps; the timeline has to get taller after it
    // has landed, as it would in the hand, or that render does the job this test is about.
    await frames(3);

    tl.parentElement!.style.height = '600px';
    await until('the view to take the new height', () => room() <= 0);
    await frames(2);

    expect(panned()).toBeLessThanOrEqual(Math.max(0, room()) + 0.5);
  });

  /*
   * Rows at the top have nothing to be clamped into, and measuring how far they COULD pan reads the
   * lanes' height straight after the patch - a layout forced on every render, every frame of a pinch
   * zoom among them. Rows that are panned are still clamped, by the test above.
   */
  it('does not measure the rows on a render while they are not panned', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    const column = root(tl).querySelector<HTMLElement>('.tl__rows')!;
    expect(column.style.transform).toBe('');
    const renders = countRenders(tl);
    await settle(renders);

    const measured = vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get');
    try {
      const before = renders();
      store.toggleOriginalMuted();
      await until('a render', () => renders() > before);
      await frames(1);

      expect(measured.mock.contexts.filter(el => el === column)).toHaveLength(0);
      expect(column.style.transform).toBe('');
    } finally {
      measured.mockRestore();
    }
  });

  /*
   * The ruler and the filmstrip used to stand still while everything under them panned, so with
   * more rows than fit only the lanes moved. The whole timeline is one column now, and a swipe that
   * starts on the filmstrip - which used to do nothing - pans it like a swipe anywhere else.
   */
  it('pans the ruler and the filmstrip with the lanes, and the add button with the filmstrip', async () => {
    const { tl } = await mount(fiveLayers());
    const ruler = root(tl).querySelector<HTMLElement>('.tl__ruler')!;
    const add = root(tl).querySelector<HTMLElement>('.tl__add')!;
    const tops = () => [ruler, row(tl, 'base'), row(tl, 'vt-5'), add].map(el => el.getBoundingClientRect().top);
    const before = tops();

    const from = centre(segmentEl(tl, 'seg-a'));
    await swipeUp(tl, segmentEl(tl, 'seg-a'), from, 60);

    const moved = tops().map((top, i) => before[i] - top);
    expect(moved[0]).toBeGreaterThan(40);
    for (const by of moved) expect(by).toBeCloseTo(moved[0], 0);
  });

  /*
   * A segment on the base track is selected from outside the timeline too - by touching the video on
   * the preview, by Edit, by Crop - and with the filmstrip panned out of sight the selection would be
   * on a row nobody can see.
   */
  it('brings the filmstrip back into view, with the ruler over it, when a segment on it is selected', async () => {
    const { store, tl } = await mount(fiveLayers());
    const column = root(tl).querySelector<HTMLElement>('.tl__rows')!;
    const view = root(tl).querySelector<HTMLElement>('.tl__content')!;
    await swipeUp(tl, view, centre(row(tl, 'vt-3')), 600);
    const top = view.getBoundingClientRect().top;
    await until('the filmstrip to be panned out of sight', () => row(tl, 'base').getBoundingClientRect().bottom <= top);

    store.select({ kind: 'clip', id: 'seg-b' });
    await until('the rows back at the top', () => pannedBy(column) === 0);
    expect(root(tl).querySelector('.tl__ruler')!.getBoundingClientRect().top).toBeCloseTo(top, 0);
  });
});

describe('the playhead', () => {
  /*
   * `ve-editor` does not render the timeline at all while a tall sheet or full screen is up, so
   * closing one makes a new `<ve-timeline>` with the playhead wherever it was left. The effect that
   * scrolls the lanes to the playhead first runs when the element is connected, before there is a
   * scroller to scroll, and ran again only when the playhead, the zoom or the width changed - so the
   * new timeline came up at 00:00 under a clock reading 00:06, and the next Cut or take acted on a
   * moment the screen was not showing.
   */
  it('is under the centre line of a timeline made while it is away from the start', async () => {
    const { store, tl } = await mount();
    const scroller = (el: HTMLElement) => root(el).querySelector<HTMLElement>('.tl__scroller')!;
    const at = (6000 / 1000) * store.pps.value;
    store.seek(6000);
    await until('the lanes to follow the seek', () => Math.abs(scroller(tl).scrollLeft - at) < 1);

    // What closing a tall sheet does: the element goes, and a new one is made on the same context.
    // As wide as the window, as the timeline is on a phone. The width starts out as
    // `window.innerWidth` and is measured on the first layout, and a narrower column changed it
    // there, which ran the effect again and hid the bug.
    const column = tl.parentElement!;
    column.style.width = `${window.innerWidth}px`;
    tl.remove();
    const again = document.createElement('ve-timeline');
    again.style.height = '100%';
    Object.assign(again, { ctx: (tl as HTMLElement & { ctx: EditorContext }).ctx });
    column.append(again);
    await (again as StencilElement).componentOnReady?.();
    await frames(2);

    expect(Math.abs(scroller(again).scrollLeft - at)).toBeLessThan(1);
    // Brought there by the timeline, not by a scroll read back as a seek.
    expect(store.playheadMs.value).toBe(6000);
  });
});

describe('the take being recorded', () => {
  /*
   * The bar of a voiceover take grows with the playhead, which is written thirty times a second for
   * the whole of the take. It used to be drawn by the render, so every tile and lane was drawn again
   * on each of those writes while the recorder and the preview were fighting for the same thread.
   * Its width is written onto the bar itself now, and has to come out exactly as it did.
   */
  const MIN_ITEM_PX = 28;

  function bar(tl: HTMLElement): HTMLElement | null {
    return root(tl).querySelector<HTMLElement>('.item--recording');
  }

  function pad(tl: HTMLElement): number {
    return root(tl).querySelector<HTMLElement>('.tl__scroller')!.clientWidth / 2;
  }

  it('grows with the playhead without drawing the timeline again', async () => {
    const { store, tl } = await mount();
    const renders = countRenders(tl);
    const pps = store.pps.value;
    store.recordingFromMs.value = 1000;
    await until('the recording bar', () => bar(tl) !== null);
    // Nothing recorded yet: the playhead is behind where the take starts, and the bar is its least.
    expect(parseFloat(bar(tl)!.style.width)).toBeCloseTo(MIN_ITEM_PX, 3);
    expect(parseFloat(bar(tl)!.style.left)).toBeCloseTo(pad(tl) + pps, 3);
    await settle(renders);

    const before = renders();
    // All well inside the first half-screen of scroll, so the lanes keep the tiles they have.
    for (const to of [1200, 1500, 1800, 2100]) {
      store.playheadMs.value = to;
      expect(parseFloat(bar(tl)!.style.width)).toBeCloseTo(Math.max(MIN_ITEM_PX, ((to - 1000) / 1000) * pps), 3);
      await frames(1);
    }
    await frames(3);

    expect(renders()).toBe(before);
    expect(parseFloat(bar(tl)!.style.left)).toBeCloseTo(pad(tl) + pps, 3);
  });

  it('keeps both ends in step when the timeline is zoomed mid-take', async () => {
    const { store, tl } = await mount();
    store.playheadMs.value = 2000;
    // Made after the playhead had moved on: the bar has its width from the moment it is made.
    store.recordingFromMs.value = 1000;
    await until('the recording bar', () => bar(tl) !== null);
    expect(parseFloat(bar(tl)!.style.width)).toBeCloseTo(store.pps.value, 3);

    const pps = store.pps.value * 2;
    store.pps.value = pps;
    await until('the bar to move', () => Math.abs(parseFloat(bar(tl)!.style.left) - (pad(tl) + pps)) < 0.01);

    expect(parseFloat(bar(tl)!.style.width)).toBeCloseTo(pps, 3);
  });

  it('goes when the take stops, and a new take starts a new bar', async () => {
    const { store, tl } = await mount();
    store.recordingFromMs.value = 0;
    store.playheadMs.value = 1000;
    await until('the recording bar', () => bar(tl) !== null);
    expect(parseFloat(bar(tl)!.style.width)).toBeCloseTo(store.pps.value, 3);

    store.recordingFromMs.value = null;
    await until('the bar to go', () => bar(tl) === null);

    store.recordingFromMs.value = 1000;
    await until('the new bar', () => bar(tl) !== null);
    // The new take starts at the playhead, so it is its least - not the width the last one ended on.
    expect(parseFloat(bar(tl)!.style.width)).toBeCloseTo(MIN_ITEM_PX, 3);
  });
});

describe('a voiceover take', () => {
  it('is an image named Voiceover, a name Android’s WebView passes on', async () => {
    const { store, tl } = await mount();
    expect(store.addVoiceover({ id: 'vo-1', uri: 'take.m4a', startMs: 0, durationMs: 2000, volume: 1 })).toBe(true);
    const take = () => root(tl).querySelector<HTMLElement>('[data-hit="voice"][data-id="vo-1"]');
    await until('the take', () => take() !== null);

    // A label on a div with no role reached Android with no name, so editor-voiceover.yaml could
    // not tap "Voiceover". As an image the label is the content description there, and the
    // VoiceOver label on iOS.
    expect(take()!.getAttribute('role')).toBe('img');
    expect(take()!.getAttribute('aria-label')).toBe('Voiceover');
  });
});

describe('carrying a segment to another layer', () => {
  it('opens a layer of its own when the segment is let go in the gap under the base track', async () => {
    const { store, tl } = await mount();
    const base = row(tl, 'base').getBoundingClientRect();

    await lift(tl, 'seg-b', { x: base.left + 200, y: base.bottom + 12 });

    // The gap is underlined before anything is committed: the customer has to see where it lands.
    expect(row(tl, 'base').classList.contains('tl__vrow--drop-under')).toBe(true);

    drop(tl, { x: base.left + 200, y: base.bottom + 12 });
    await frames(2);

    expect(store.manifest.value.clips.map(c => c.id)).toEqual(['seg-a', 'seg-c']);
    expect(store.manifest.value.videoTracks).toHaveLength(1);
    expect(store.manifest.value.videoTracks[0].clips.map(c => c.id)).toEqual(['seg-b']);
  });

  it('keeps opening layers, one for each segment carried down', async () => {
    const { store, tl } = await mount();
    const base = row(tl, 'base').getBoundingClientRect();

    await lift(tl, 'seg-b', { x: base.left + 200, y: base.bottom + 12 });
    drop(tl, { x: base.left + 200, y: base.bottom + 12 });
    await until('the first layer', () => rows(tl).length === 2);

    const under = rows(tl)[1].getBoundingClientRect();
    await lift(tl, 'seg-c', { x: base.left + 200, y: under.bottom + 12 });
    drop(tl, { x: base.left + 200, y: under.bottom + 12 });
    await until('the second layer', () => rows(tl).length === 3);

    expect(store.manifest.value.clips.map(c => c.id)).toEqual(['seg-a']);
    expect(store.manifest.value.videoTracks.map(t => t.clips.map(c => c.id))).toEqual([['seg-b'], ['seg-c']]);
  });

  it('joins a layer that is already there when the segment is let go on its row', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    const target = centre(row(tl, 'vt-1'));

    await lift(tl, 'seg-b', target);

    // A row is outlined rather than underlined: the segment joins what is already on it.
    expect(row(tl, 'vt-1').classList.contains('tl__vrow--drop')).toBe(true);
    expect(row(tl, 'vt-1').classList.contains('tl__vrow--drop-under')).toBe(false);

    drop(tl, target);
    await frames(2);

    expect(store.manifest.value.videoTracks).toHaveLength(1);
    expect(store.manifest.value.videoTracks[0].clips.map(c => c.id)).toContain('seg-b');
    expect(store.manifest.value.clips.map(c => c.id)).toEqual(['seg-a', 'seg-c']);
  });

  it('carries a segment on a layer back onto the base track', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    const base = centre(row(tl, 'base'));

    await lift(tl, 'seg-x', base);
    drop(tl, base);
    await frames(2);

    expect(store.manifest.value.clips.map(c => c.id)).toContain('seg-x');
    // A layer with nothing left on it goes: an empty row is one a customer cannot get rid of.
    expect(store.manifest.value.videoTracks).toEqual([]);
  });

  it('puts the segment back when it is lifted clear above the timeline', async () => {
    const { store, tl } = await mount();
    const before = store.manifest.value;
    const base = row(tl, 'base').getBoundingClientRect();

    await lift(tl, 'seg-b', { x: base.left + 200, y: base.top - 80 });
    await frames(2);

    expect(store.manifest.value).toBe(before);
    expect(root(tl).querySelector('.tl--reordering')).toBeNull();
  });

  it('never empties the base track', async () => {
    // The base track is what fixes how long the post runs, so its last segment does not lift at all.
    const { store, tl } = await mount();
    store.commit('Trim to one', m => ({ ...m, clips: [m.clips[0]] }));
    await frames(2);
    const base = row(tl, 'base').getBoundingClientRect();

    const from = centre(segmentEl(tl, 'seg-a'));
    pointer(segmentEl(tl, 'seg-a'), 'pointerdown', from.x, from.y);
    await new Promise(resolve => setTimeout(resolve, 500));

    expect(root(tl).querySelector('.tl--reordering')).toBeNull();
    pointer(root(tl).querySelector('.tl__scroller')!, 'pointerup', base.left + 200, base.bottom + 12);
  });
});

/*
 * Every layer is trimmed and moved on its own, by the same two handles the base track has.
 *
 * The zoom opens at 64 pixels per second of output, so 64 px of finger is one second and the
 * expectations below are readable as times. Grab points are kept clear of both sides of the
 * viewport, where a drag would start scrolling the timeline under itself.
 */
describe('trimming and moving a layer', () => {
  const PPS_PX_PER_S = 64;

  function grab(el: Element, into = 54): { x: number; y: number } {
    const rect = el.getBoundingClientRect();
    return { x: rect.left + into, y: rect.top + rect.height / 2 };
  }

  async function dragBy(tl: HTMLElement, on: Element, from: { x: number; y: number }, dx: number): Promise<void> {
    const scroller = root(tl).querySelector('.tl__scroller')!;
    pointer(on, 'pointerdown', from.x, from.y);
    pointer(scroller, 'pointermove', from.x + dx, from.y);
    await frames(3);
    pointer(scroller, 'pointerup', from.x + dx, from.y);
    await frames(2);
  }

  function handles(tl: HTMLElement, rowName: string): HTMLElement[] {
    return [...row(tl, rowName).querySelectorAll<HTMLElement>('.handle')];
  }

  it('gives a selected layer segment its own two handles, in its own row', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);

    store.select({ kind: 'clip', id: 'seg-x' });
    await until('the handles', () => handles(tl, 'vt-1').length === 2);

    // And nowhere else: a nudge is one row's ripple, and the base track is not the row being held.
    expect(handles(tl, 'base')).toHaveLength(0);
  });

  it('carries the whole layer along the timeline when its segment is dragged sideways', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    store.select({ kind: 'clip', id: 'seg-x' });
    await until('the selection', () => segmentEl(tl, 'seg-x').classList.contains('seg--selected'));

    await dragBy(tl, segmentEl(tl, 'seg-x'), grab(segmentEl(tl, 'seg-x')), PPS_PX_PER_S);

    // A second of finger is a second of timeline. The segment did not move inside the layer: a track
    // is a sequence with no gaps in it, so what moved is the layer's own start.
    expect(store.videoTrack.value!.startMs).toBeCloseTo(1000, -2);
    expect(store.videoTrack.value!.clips.map(c => c.id)).toEqual(['seg-x']);
  });

  it('moves the in point and the layer together from the left handle', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    store.select({ kind: 'clip', id: 'seg-x' });
    await until('the handles', () => handles(tl, 'vt-1').length === 2);
    const handle = row(tl, 'vt-1').querySelector('.handle--in')!;

    await dragBy(tl, handle, grab(handle, 22), PPS_PX_PER_S);

    // The edge followed the finger, so the second of footage that was under it is gone and what is
    // left is still where it was on the video. A trim that moved only the in point would have left
    // the edge where it was and shortened the layer from its far end instead.
    expect(store.videoTrack.value!.clips[0].inMs).toBeCloseTo(1000, -2);
    expect(store.videoTrack.value!.startMs).toBeCloseTo(1000, -2);
    expect(store.videoTrack.value!.clips[0].outMs).toBe(4000);
  });

  it('shortens the layer from the right handle without moving its start', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    store.select({ kind: 'clip', id: 'seg-x' });
    await until('the handles', () => handles(tl, 'vt-1').length === 2);
    const handle = row(tl, 'vt-1').querySelector('.handle--out')!;

    await dragBy(tl, handle, grab(handle, 22), -PPS_PX_PER_S);

    expect(store.videoTrack.value!.clips[0].outMs).toBeCloseTo(3000, -2);
    expect(store.videoTrack.value!.startMs).toBe(0);
  });
});

/*
 * The tail: the post running on past its base track, so there is somewhere to put a video that plays
 * AFTER the footage on the bottom row rather than only beside it.
 *
 * Dragged at the furthest zoom out, where a twelve second post is 72 px wide and its end is on the
 * screen: at the zoom the editor opens on, the end of this fixture is 768 px past the right edge.
 */
describe('the end of the post', () => {
  const FURTHEST_OUT_PPS = 6;

  function grip(tl: HTMLElement): HTMLElement {
    const found = root(tl).querySelector<HTMLElement>('[data-hit="end"]');
    if (!found) throw new Error('no end grip');
    return found;
  }

  async function zoomRightOut(store: EditorStore, tl: HTMLElement): Promise<void> {
    store.pps.value = FURTHEST_OUT_PPS;
    await until('the end to come on screen', () => grip(tl).getBoundingClientRect().left < 330);
  }

  async function dragGrip(tl: HTMLElement, dx: number): Promise<void> {
    const scroller = root(tl).querySelector('.tl__scroller')!;
    const rect = grip(tl).getBoundingClientRect();
    const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    pointer(grip(tl), 'pointerdown', from.x, from.y);
    pointer(scroller, 'pointermove', from.x + dx, from.y);
    await frames(3);
    pointer(scroller, 'pointerup', from.x + dx, from.y);
    await frames(2);
  }

  it('is dragged out past the base track, leaving the footage alone', async () => {
    const { store, tl } = await mount();
    expect(store.totalMs.value).toBe(12_000);
    await zoomRightOut(store, tl);

    // 6 px per second, so 60 px of finger is ten seconds of black on the end.
    await dragGrip(tl, 60);

    expect(store.totalMs.value).toBeCloseTo(22_000, -3);
    expect(store.baseMs.value).toBe(12_000);
    expect(store.manifest.value.clips).toHaveLength(3);
  });

  it('cuts the post when it is dragged back inside the footage', async () => {
    // It used to stop dead here, and that is what made the grip read as broken: a post nobody had
    // stretched was already sitting on the floor, so the first thing anybody tries - pulling the
    // end in to shorten the video - moved nothing and said nothing about why.
    const { store, tl } = await mount();
    await zoomRightOut(store, tl);
    expect(store.totalMs.value).toBe(12_000);

    // 6 px per second, so 60 px of finger is ten seconds off the end.
    await dragGrip(tl, -60);

    expect(store.totalMs.value).toBeCloseTo(2000, -3);
    // Cut, not merely hidden: two of the three four-second segments are gone with it.
    expect(store.manifest.value.clips).toHaveLength(1);
    expect(store.baseMs.value).toBeCloseTo(2000, -3);
  });

  it('cuts every row at the same instant, layers with the footage', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    await zoomRightOut(store, tl);

    await dragGrip(tl, -60);

    // A layer is cut where the base is, and an empty one is taken off rather than left as a lane
    // with nothing in it.
    for (const track of store.manifest.value.videoTracks) {
      expect(track.clips.length).toBeGreaterThan(0);
    }
    expect(store.totalMs.value).toBeCloseTo(2000, -3);
  });

  it('puts the whole cut back as one undo step', async () => {
    // Every row it touched, undone together: the drag is one gesture, so pulling too far costs one
    // tap to get back rather than one per clip.
    const { store, tl } = await mount();
    await zoomRightOut(store, tl);

    await dragGrip(tl, -60);
    expect(store.manifest.value.clips).toHaveLength(1);

    store.undo();

    expect(store.manifest.value.clips).toHaveLength(3);
    expect(store.totalMs.value).toBe(12_000);
  });

  it('shows the stretch with no footage in it', async () => {
    const { store, tl } = await mount();
    expect(root(tl).querySelector('.tl__tail')).toBeNull();

    store.setPostDuration(20_000);
    await until('the tail', () => root(tl).querySelector('.tl__tail') !== null);

    // It starts where the filmstrip stops, and runs to the end of the post.
    const tail = root(tl).querySelector<HTMLElement>('.tl__tail')!;
    expect(parseFloat(tail.style.width)).toBeCloseTo((8000 / 1000) * store.pps.value, 0);
  });

  it('gives a layer somewhere past the footage to be', async () => {
    const { store } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    store.setPostDuration(20_000);

    store.setTrackStart('vt-1', 16_000);

    // Before the tail existed this clamped back to the base track's end, and a layer could only ever
    // be placed where the footage underneath it already reached.
    expect(store.videoTrack.value!.startMs).toBe(16_000);
  });
});

/*
 * The picture of a sound on its bar.
 *
 * A browser rather than the mock DOM for the same reason the rest of this file needs one: which
 * bars get built is decided by the render window, and the render window is measured off the real
 * width of a real scroller. In a mock DOM every rectangle is zero and there would be no window to
 * clip to.
 *
 * Measurements are written straight into `store.waveforms` rather than decoded. Decoding is
 * `web-runtime/waveform.cmp.test.ts`'s job; what is being tested here is the drawing.
 */
describe('the waveform on an audio bar', () => {
  /** Twenty seconds of source, loud in the middle and quiet at both ends. */
  const PEAKS: Peaks = {
    stepMs: 10,
    peaks: Uint8Array.from({ length: 2000 }, (_, i) => (i > 600 && i < 1400 ? 255 : 12)),
    durationMs: 20_000,
    max: 255,
  };

  function music(over: Partial<EditMusic> = {}): EditMusic {
    return { uri: 'blob:tune', fileName: 'tune.mp3', sourceDurationMs: 20_000, inMs: 0, outMs: 0, startMs: 0, endMs: 0, volume: 0.8, loop: true, fadeOutMs: 0, ...over };
  }

  function wave(tl: HTMLElement): SVGPathElement | null {
    return root(tl).querySelector<SVGPathElement>('[data-hit="music"] .item__wave path');
  }

  /** The height of every bar in the path, in the 100-unit lane the viewBox describes. */
  function barHeights(path: SVGPathElement): number[] {
    return [...(path.getAttribute('d') ?? '').matchAll(/v([\d.]+)/g)].map(m => Number(m[1]));
  }

  async function withMusic(over: Partial<EditMusic> = {}, peaks: Peaks | null = PEAKS) {
    const mountedTl = await mount();
    const { store } = mountedTl;
    /*
     * Seeded BEFORE the track goes on, which is not tidiness: adding music wakes the manifest
     * watcher in `EditorMedia`, and it would try to read `blob:tune` - a URL no one minted - and
     * record the failure as `null` over the top of this. A measurement already in the map is the
     * one thing that stops it, so this is also where that guard gets exercised.
     */
    if (peaks !== null) store.waveforms.value = new Map(store.waveforms.value).set('blob:tune', peaks);
    store.setMusic(music(over));
    await frames(2);
    return mountedTl;
  }

  it('draws nothing until the track has been measured', async () => {
    const { tl } = await withMusic({}, null);

    // The bar itself is there; it simply keeps the colour it has always had.
    expect(root(tl).querySelector('[data-hit="music"]')).not.toBeNull();
    expect(wave(tl)).toBeNull();
  });

  it('draws nothing for a file that could not be measured', async () => {
    // `null` in the map is "measured, and there is nothing to draw" - a codec with no decoder
    // here, or a file too big to decode. It reads on screen exactly like not-yet-measured, and it
    // is the map that tells the two apart so nothing tries the same file again.
    const { store, tl } = await withMusic({}, null);
    store.waveforms.value = new Map(store.waveforms.value).set('blob:tune', null);
    await frames(2);

    expect(root(tl).querySelector('[data-hit="music"]')).not.toBeNull();
    expect(wave(tl)).toBeNull();
  });

  it('draws the sound once it has been measured', async () => {
    const { tl } = await withMusic();

    await until('the waveform', () => wave(tl) !== null);
    const heights = barHeights(wave(tl)!);

    expect(heights.length).toBeGreaterThan(20);
    // Loud in the middle and quiet at the ends: the shape has to come through as more than one height.
    expect(new Set(heights).size).toBeGreaterThan(1);
    expect(Math.max(...heights)).toBeGreaterThan(Math.min(...heights) * 3);
  });

  it('sizes the drawing to the slice it draws, in real pixels across and percent down', async () => {
    const { tl } = await withMusic();
    await until('the waveform', () => wave(tl) !== null);
    const svg = root(tl).querySelector('[data-hit="music"] .item__wave')!;

    const width = Number(svg.getAttribute('width'));
    expect(width).toBeGreaterThan(0);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${width} 100`);
    // Normalised height is what lets the 40 px lane and the 36 px compact one share one path.
    expect(svg.getAttribute('preserveAspectRatio')).toBe('none');
    expect(svg.getAttribute('height')).toBe('100%');
  });

  it('keeps the drawing out of the way of the press that drags the bar', async () => {
    const { tl } = await withMusic();
    await until('the waveform', () => wave(tl) !== null);
    const clip = root(tl).querySelector('[data-hit="music"] .item__wave-clip')!;

    // A child that could swallow a touch is a drag that never starts.
    expect(getComputedStyle(clip).pointerEvents).toBe('none');
    expect(clip.getAttribute('aria-hidden')).toBe('true');
    // And it clips, so a full-height bar cannot paint outside the bar's rounded corner.
    expect(getComputedStyle(clip).overflow).toBe('hidden');
  });

  it('redraws when the timeline is zoomed', async () => {
    const { store, tl } = await withMusic();
    await until('the waveform', () => wave(tl) !== null);
    const before = wave(tl)!.getAttribute('d');

    store.pps.value = store.pps.value * 2;
    await until('a redraw', () => wave(tl)!.getAttribute('d') !== before);

    expect(wave(tl)!.getAttribute('d')).not.toBe(before);
  });

  it('redraws when the track is trimmed', async () => {
    const { store, tl } = await withMusic();
    await until('the waveform', () => wave(tl) !== null);
    const before = wave(tl)!.getAttribute('d');

    // Trimming re-periodises a looping track: every pass after the first shows something new.
    store.previewMusic({ outMs: 3000 });
    await until('a redraw', () => wave(tl)!.getAttribute('d') !== before);

    expect(wave(tl)!.getAttribute('d')).not.toBe(before);
  });

  it('goes away with the track it belongs to', async () => {
    const { store, tl } = await withMusic();
    await until('the waveform', () => wave(tl) !== null);

    store.removeMusic();
    await until('the bar to go', () => root(tl).querySelector('[data-hit="music"]') === null);

    expect(wave(tl)).toBeNull();
  });

  /*
   * The sound is a field of the manifest, and a sticker pinched or dragged on the stage writes the
   * manifest on every frame. The sound bar, its handles and its wave are exactly where they were,
   * and the whole timeline used to be drawn again around them on each of those frames.
   */
  it('draws nothing again while a layer is moved on the stage', async () => {
    const { store, tl } = await withMusic();
    await until('the waveform', () => wave(tl) !== null);
    const sticker = store.addSticker({ emoji: '🔥' })!;
    store.select({ kind: 'music' });
    await until('the sound bar handles', () => root(tl).querySelector('[data-hit="music-start"]') !== null);
    const renders = countRenders(tl);
    await settle(renders);

    const views = instanceOf<Views>(tl);
    const lane = views.musicLane.value;
    const handles = views.musicHandles.value;
    const before = renders();
    for (const cx of [0.3, 0.35, 0.4, 0.45, 0.5]) {
      store.previewOverlay(sticker, { cx });
      await frames(1);
    }
    await frames(3);

    expect(views.musicLane.value).toBe(lane);
    expect(views.musicHandles.value).toBe(handles);
    expect(renders()).toBe(before);
    store.endGesture('Move');
  });

  /*
   * A sound goes on looping, and a looping one had no end handle at all: its bar always ran to the
   * end of the video, so the only trim anyone could make was at the start. The handle now sets
   * where the repeats STOP, and leaves the section being repeated as it was.
   */
  it('gives a looping track an end handle that sets where it stops', async () => {
    const { store, tl } = await withMusic({ loop: true });
    // The end of the video, 12 s, two seconds right of the centre line and inside the viewport.
    store.seek(10_000);
    await frames(3);
    store.select({ kind: 'music' });
    await until('the end handle', () => root(tl).querySelector('[data-hit="music-end"]') !== null);
    const bar = root(tl).querySelector<HTMLElement>('[data-hit="music"]')!;
    const widthBefore = bar.getBoundingClientRect().width;

    const handle = root(tl).querySelector<HTMLElement>('[data-hit="music-end"]')!;
    const rect = handle.getBoundingClientRect();
    const from = { x: rect.left + 20, y: rect.top + rect.height / 2 };
    const scroller = root(tl).querySelector('.tl__scroller')!;
    pointer(handle, 'pointerdown', from.x, from.y);
    pointer(scroller, 'pointermove', from.x - 64, from.y);
    await frames(3);
    pointer(scroller, 'pointerup', from.x - 64, from.y);
    await frames(2);

    // A second earlier at 64 px a second, still looping, the section untouched.
    const after = store.manifest.value.music!;
    expect(after.endMs).toBeCloseTo(11_000, -2);
    expect(after.loop).toBe(true);
    expect(after.outMs).toBe(0);
    await until('the bar to follow the handle', () => Math.abs(bar.getBoundingClientRect().width - (widthBefore - 64)) < 2);

    store.undo();
    expect(store.manifest.value.music!.endMs).toBe(0);
  });

  it('draws a measured silence as a hairline rather than as nothing', async () => {
    const silent: Peaks = { stepMs: 10, peaks: new Uint8Array(2000), durationMs: 20_000, max: 0 };
    const { tl } = await withMusic({}, silent);

    await until('the waveform', () => wave(tl) !== null);
    const heights = barHeights(wave(tl)!);

    // Every bar at the floor: "measured, and there is nothing here", which a bar with no path at
    // all could not say.
    expect(heights.length).toBeGreaterThan(20);
    expect(new Set(heights)).toEqual(new Set([3]));
  });
});

/*
 * LightCut's white dots: one on every cut of the base track, and the way in to a transition.
 *
 * The fixture's three four-second segments put the cuts at 4 and 8 seconds, 256 px apart at the
 * zoom the editor opens on. The labels are asserted whole, because Maestro matches them as
 * full-string regexes and a reworded one is a flow that silently stops finding its dot.
 */
describe('the transition dots', () => {
  function dots(tl: HTMLElement): HTMLButtonElement[] {
    return [...root(tl).querySelectorAll<HTMLButtonElement>('.tl__trans')];
  }

  function dot(tl: HTMLElement, into: string): HTMLButtonElement {
    const found = root(tl).querySelector<HTMLButtonElement>(`.tl__trans[data-id="${into}"]`);
    if (!found) throw new Error(`no dot in front of ${into}`);
    return found;
  }

  function mouse(on: Element, type: string, x: number, y: number): void {
    on.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true, clientX: x, clientY: y, bubbles: true, cancelable: true }));
  }

  it('puts one dot on every cut, named for the two clips it sits between', async () => {
    const { tl } = await mount();

    expect(dots(tl)).toHaveLength(2);
    expect(dots(tl).map(d => d.getAttribute('aria-label'))).toEqual(['Transition between clip 1 and clip 2', 'Transition between clip 2 and clip 3']);
    // Named by the INCOMING clip, which is the one that holds the transition.
    expect(dots(tl).map(d => d.dataset.id)).toEqual(['seg-b', 'seg-c']);
    // No toggle state on the dots: an old Android WebView drops the whole name of a labelled toggle.
    expect(dots(tl).every(d => !d.hasAttribute('aria-pressed'))).toBe(true);
  });

  it('centres each dot on the gap it marks, on the filmstrip', async () => {
    const { tl } = await mount();

    for (const [before, after] of [
      ['seg-a', 'seg-b'],
      ['seg-b', 'seg-c'],
    ]) {
      const left = segmentEl(tl, before).getBoundingClientRect();
      const right = segmentEl(tl, after).getBoundingClientRect();
      const circle = centre(dot(tl, after));
      expect(Math.abs(circle.x - (left.right + right.left) / 2)).toBeLessThanOrEqual(1);
      expect(Math.abs(circle.y - (right.top + right.height / 2))).toBeLessThanOrEqual(1);
    }
  });

  it('opens the transition sheet on its own cut when it is tapped', async () => {
    const { store, tl } = await mount();
    const at = centre(dot(tl, 'seg-c'));

    pointer(dot(tl, 'seg-c'), 'pointerdown', at.x, at.y);
    pointer(dot(tl, 'seg-c'), 'pointerup', at.x, at.y);

    expect(store.panel.value).toBe('transition');
    expect(store.transitionTarget.value).toBe('seg-c');
    expect(store.targetBoundary.value?.index).toBe(2);
    await until('the dot to show it is open', () => dot(tl, 'seg-c').classList.contains('tl__trans--open'));
    expect(dot(tl, 'seg-b').classList.contains('tl__trans--open')).toBe(false);
  });

  it('opens nothing for a finger held on it and let go, the click after the lift included', async () => {
    const { store, tl } = await mount();
    const target = dot(tl, 'seg-b');
    const at = centre(target);

    pointer(target, 'pointerdown', at.x, at.y);
    // Past the long press, which everywhere else on the timeline lifts what is under the finger.
    await new Promise(resolve => setTimeout(resolve, 450));
    pointer(target, 'pointerup', at.x, at.y);
    target.click();
    await frames(2);

    expect(store.panel.value).toBeNull();
    expect(store.transitionTarget.value).toBeNull();

    // And a tap straight after it still opens it.
    pointer(target, 'pointerdown', at.x, at.y);
    pointer(target, 'pointerup', at.x, at.y);
    expect(store.transitionTarget.value).toBe('seg-b');
  });

  it('opens from the keyboard as well, since it has no click of its own', async () => {
    const { store, tl } = await mount();

    dot(tl, 'seg-b').focus();
    const event = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, composed: true });
    dot(tl, 'seg-b').dispatchEvent(event);

    expect(store.panel.value).toBe('transition');
    expect(store.transitionTarget.value).toBe('seg-b');
    // Taken, so the editor's own shortcuts do not also read it.
    expect(event.defaultPrevented).toBe(true);
  });

  it('leaves a swipe that starts on a dot to the browser, which scrolls instead of opening it', async () => {
    const { store, tl } = await mount();
    const at = centre(dot(tl, 'seg-b'));

    // The row's `pan-x` is what hands a sideways swipe to the browser; a dot that took it for itself
    // would be a dead patch of filmstrip that neither scrolls nor seeks.
    expect(getComputedStyle(dot(tl, 'seg-b')).touchAction).not.toBe('none');

    // What the browser does with a finger that moves sideways: the move, then a cancel as it claims
    // the gesture for its own scroll.
    pointer(dot(tl, 'seg-b'), 'pointerdown', at.x, at.y);
    pointer(dot(tl, 'seg-b'), 'pointermove', at.x - 60, at.y);
    pointer(dot(tl, 'seg-b'), 'pointercancel', at.x - 60, at.y);
    pointer(dot(tl, 'seg-b'), 'pointerup', at.x - 60, at.y);
    await frames(2);

    expect(store.panel.value).toBeNull();
  });

  it('pulls the timeline along under a mouse dragged from a dot, and does not open it', async () => {
    const { store, tl } = await mount();
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    const before = scroller.scrollLeft;
    const at = centre(dot(tl, 'seg-b'));

    mouse(dot(tl, 'seg-b'), 'pointerdown', at.x, at.y);
    mouse(scroller, 'pointermove', at.x - 80, at.y);
    await frames(3);
    mouse(scroller, 'pointerup', at.x - 80, at.y);
    await frames(2);

    expect(scroller.scrollLeft).toBeGreaterThan(before + 40);
    expect(store.panel.value).toBeNull();
  });

  it('gives the selected segment’s two edges to its trim handles', async () => {
    const { store, tl } = await mount();

    store.select({ kind: 'clip', id: 'seg-b' });
    await until('both of its dots to go', () => dots(tl).length === 0);

    store.select({ kind: 'clip', id: 'seg-a' });
    // The first segment has one cut, on its right; the other cut is not its to take.
    await until('the far dot to come back', () => dots(tl).length === 1);
    expect(dots(tl)[0].dataset.id).toBe('seg-c');
  });

  it('goes when the segments either side are drawn too narrow to carry it', async () => {
    const { store, tl } = await mount();

    // Six pixels a second: every segment is 24 px wide, less the gap - narrower than the dot.
    store.pps.value = 6;
    await until('the dots to go', () => dots(tl).length === 0);

    store.pps.value = 64;
    await until('the dots to come back', () => dots(tl).length === 2);
  });

  it('opens from a bare click as well, which is how a screen reader presses a button', async () => {
    const { store, tl } = await mount();

    // TalkBack's double tap and switch access both arrive as a click with no pointer events before
    // it, so the pointer path never hears them.
    dot(tl, 'seg-b').click();

    expect(store.panel.value).toBe('transition');
    expect(store.transitionTarget.value).toBe('seg-b');
  });

  it('opens once for a tap, though the browser follows the tap with a click', async () => {
    const { store, tl } = await mount();
    const opened: string[] = [];
    const open = store.openTransition.bind(store);
    store.openTransition = (id: string) => {
      opened.push(id);
      open(id);
    };
    const target = dot(tl, 'seg-b');
    const at = centre(target);

    pointer(target, 'pointerdown', at.x, at.y);
    pointer(target, 'pointerup', at.x, at.y);
    target.click();

    expect(opened).toEqual(['seg-b']);
  });

  it('leaves a short segment between two dots enough of itself to be selected', async () => {
    const { store, tl } = await mount();
    // A second, then a 0.6 s piece of the kind a split leaves: 33 px drawn at the opening zoom. Two
    // full 44 px targets on its two cuts would cover every pixel of it, and a tap anywhere on it
    // would open a transition instead of selecting it.
    store.commit('Shorten', m => ({
      ...m,
      clips: m.clips.map(c => (c.id === 'seg-a' ? { ...c, outMs: 1000 } : c.id === 'seg-b' ? { ...c, outMs: 600 } : c)),
    }));
    await until('both of its dots', () => dots(tl).length === 2 && segmentEl(tl, 'seg-b').getBoundingClientRect().width < 40);

    const at = centre(segmentEl(tl, 'seg-b'));
    const hit = root(tl).elementFromPoint(at.x, at.y);
    expect(hit).not.toBeNull();
    pointer(hit!, 'pointerdown', at.x, at.y);
    pointer(hit!, 'pointerup', at.x, at.y);

    expect(store.panel.value).toBeNull();
    expect(store.selection.value).toEqual({ kind: 'clip', id: 'seg-b' });
  });

  it('is never a smaller target than the circle it draws', async () => {
    const { store, tl } = await mount();
    store.commit('Shorten', m => ({ ...m, clips: m.clips.map(c => (c.id === 'seg-b' ? { ...c, outMs: 600 } : c)) }));
    await until('the narrower targets', () => dots(tl).length === 2 && dots(tl).every(d => d.getBoundingClientRect().width < 44));

    for (const d of dots(tl)) {
      const target = d.getBoundingClientRect();
      const circle = d.querySelector('.tl__trans-dot')!.getBoundingClientRect();
      expect(target.width).toBeGreaterThanOrEqual(circle.width - 0.5);
      // Still centred on the cut.
      expect(Math.abs(target.left + target.width / 2 - (circle.left + circle.width / 2))).toBeLessThanOrEqual(0.5);
    }
  });

  it('keeps out of reach while a voiceover take is running', async () => {
    const { store, tl } = await mount();

    // A tap on one would shut the voiceover sheet under the take and stop it.
    store.recordingFromMs.value = 0;
    await until('the dots to go', () => dots(tl).length === 0);

    store.recordingFromMs.value = null;
    await until('the dots to come back', () => dots(tl).length === 2);
  });

  it('keeps out of the way while an edge is trimmed', async () => {
    const { store, tl } = await mount();
    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the handles', () => root(tl).querySelector('.handle--out') !== null && dots(tl).length === 1);

    const handle = root(tl).querySelector<HTMLElement>('.handle--out')!;
    const at = centre(handle);
    pointer(handle, 'pointerdown', at.x, at.y);
    await until('the trim to take the row', () => root(tl).querySelector('.tl--drag-resize') !== null);
    expect(getComputedStyle(dot(tl, 'seg-c')).visibility).toBe('hidden');

    pointer(handle, 'pointerup', at.x, at.y);
    await until('the dot to come back', () => getComputedStyle(dot(tl, 'seg-c')).visibility === 'visible');
  });

  it('keeps out of the way while a segment is lifted', async () => {
    const { tl } = await mount();
    const base = row(tl, 'base').getBoundingClientRect();

    await lift(tl, 'seg-a', { x: base.left + 200, y: base.bottom + 12 });

    expect(getComputedStyle(dot(tl, 'seg-c')).visibility).toBe('hidden');
    drop(tl, { x: base.left + 200, y: base.top - 80 });
  });

  it('wears the transition once one is chosen, and the cut moves in by the overlap', async () => {
    const { store, tl } = await mount();
    const widthBefore = segmentEl(tl, 'seg-a').getBoundingClientRect().width;

    store.openTransition('seg-b');
    store.chooseTransition('slide-left');
    await until('the new name', () => dot(tl, 'seg-b').getAttribute('aria-label') === 'Slide left transition between clip 1 and clip 2');

    expect(dot(tl, 'seg-b').classList.contains('tl__trans--set')).toBe(true);
    // A property rather than an attribute: the icon's name is not reflected.
    expect((dot(tl, 'seg-b').querySelector('ve-icon') as (HTMLElement & { name?: string }) | null)?.name).toBe('transition');
    // The other cut is still a plain one.
    expect(dot(tl, 'seg-c').getAttribute('aria-label')).toBe('Transition between clip 2 and clip 3');

    // Half a second of overlap at 64 px a second: the outgoing segment is drawn 32 px shorter, and
    // the dot is still on the gap between it and the next.
    const overlapPx = (store.targetBoundary.value!.effectiveMs / 1000) * store.pps.value;
    expect(overlapPx).toBeCloseTo(32, 5);
    const left = segmentEl(tl, 'seg-a').getBoundingClientRect();
    expect(left.width).toBeCloseTo(widthBefore - overlapPx, 0);
    const right = segmentEl(tl, 'seg-b').getBoundingClientRect();
    expect(Math.abs(centre(dot(tl, 'seg-b')).x - (left.right + right.left) / 2)).toBeLessThanOrEqual(1);

    // And back to a plain cut with None.
    store.removeTransition();
    await until('the plain name', () => dot(tl, 'seg-b').getAttribute('aria-label') === 'Transition between clip 1 and clip 2');
    expect(dot(tl, 'seg-b').querySelector('ve-icon')).toBeNull();
  });
});

/*
 * The music lane's placeholder, and the one thing it opens. WebKit on iOS aims the click that follows
 * a tap at whatever is under the finger AFTER the lift, and the Sound sheet comes up where the lane
 * was: a sheet opened on the pointer's way up took that click, on Extract from video, and opened the
 * video picker over itself. So nothing may open before the click, and the click is what opens it.
 */
describe('the Add sound bar', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function addSound(tl: HTMLElement): HTMLButtonElement {
    const found = root(tl).querySelector<HTMLButtonElement>('[data-hit="add-sound"]');
    if (!found) throw new Error('no Add sound');
    return found;
  }

  it('opens the Sound sheet on the click that follows a tap, and not a moment before', async () => {
    const opened = vi.spyOn(EditorMedia.prototype, 'openSound');
    const { store, tl } = await mount();
    const target = addSound(tl);
    const at = centre(target);

    pointer(target, 'pointerdown', at.x, at.y);
    pointer(target, 'pointerup', at.x, at.y);
    // Nothing is up yet for the click to land in, wherever the browser aims it.
    expect(store.panel.value).toBeNull();

    target.click();
    expect(store.panel.value).toBe('sound');
    expect(opened).toHaveBeenCalledTimes(1);
  });

  it('opens from a bare click as well, which is how a key or a screen reader presses it', async () => {
    const { store, tl } = await mount();

    addSound(tl).click();

    expect(store.panel.value).toBe('sound');
  });

  it('opens nothing for the click after a mouse drag that ended over it', async () => {
    const { store, tl } = await mount();
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    const target = addSound(tl);
    const at = centre(target);
    const mouse = (on: Element, type: string, x: number): void => {
      on.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', button: 0, isPrimary: true, clientX: x, clientY: at.y, bubbles: true, cancelable: true }));
    };

    // A scrub that starts and ends on the bar, which runs the whole length of the video.
    mouse(target, 'pointerdown', at.x);
    mouse(scroller, 'pointermove', at.x - 60);
    await frames(2);
    mouse(scroller, 'pointerup', at.x - 60);
    target.click();
    await frames(2);

    expect(store.panel.value).toBeNull();
  });
});

describe('the timeline add button', () => {
  afterEach(() => vi.restoreAllMocks());

  it('offers Video and Audio, and sends each choice to its picker', async () => {
    const addVideo = vi.spyOn(EditorMedia.prototype, 'addClip').mockResolvedValue();
    const addAudio = vi.spyOn(EditorMedia.prototype, 'openSound');
    const { store, tl } = await mount();
    const add = root(tl).querySelector<HTMLButtonElement>('.tl__add')!;
    // Named by its own words: an `aria-label` beside `aria-haspopup` is no name on Android's WebView.
    expect(add.hasAttribute('aria-label')).toBe(false);
    expect(add.textContent?.trim()).toBe('Add to timeline');
    expect(add.querySelector('.tl__hidden-name')!.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    expect(add.getAttribute('aria-haspopup')).toBe('menu');
    expect(add.getAttribute('aria-expanded')).toBe('false');

    add.click();
    await until('the add choices', () => root(tl).querySelectorAll('.tl__add-menu button').length === 2);
    expect(add.getAttribute('aria-expanded')).toBe('true');
    expect(root(tl).querySelector('.tl__add-menu')!.getAttribute('role')).toBe('menu');
    const choices = [...root(tl).querySelectorAll<HTMLButtonElement>('.tl__add-menu button')];
    expect(choices.map(choice => choice.textContent)).toEqual(['Video', 'Audio']);
    expect(choices.map(choice => choice.getAttribute('role'))).toEqual(['menuitem', 'menuitem']);
    choices[1].click();
    expect(addAudio).toHaveBeenCalledTimes(1);
    expect(addVideo).not.toHaveBeenCalled();
    expect(store.panel.value).toBe('sound');

    store.closePanel();
    add.click();
    await until('the video choice', () => !!root(tl).querySelector('.tl__add-menu button'));
    root(tl).querySelector<HTMLButtonElement>('.tl__add-menu button')!.click();
    expect(addVideo).toHaveBeenCalledTimes(1);
  });

  /** The last segment selected, the end of the video under the centre line, and that segment's end handle. */
  async function lastSegmentOnTheLine(tl: HTMLElement, store: EditorStore): Promise<HTMLElement> {
    store.select({ kind: 'clip', id: 'seg-c' });
    store.seek(12_000);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    await until('the end of the video under the line', () => Math.abs(scroller.scrollLeft - 12 * store.pps.value) < 1);
    await until('the end handle', () => !!row(tl, 'base').querySelector('.handle--out'));
    return row(tl, 'base').querySelector<HTMLElement>('.handle--out')!;
  }

  /*
   * The button follows the end of the video, and it stood 12 px past it - inside the finger target of
   * the last segment's end handle, which reaches 30 px out past the edge. It was the one that got the
   * press, so the last clip could hardly be pulled any longer.
   */
  it('stands clear of the end handle of the last segment, so the clip can be pulled longer', async () => {
    const { store, tl } = await mount();
    const handle = await lastSegmentOnTheLine(tl, store);
    const target = handle.getBoundingClientRect();
    const add = root(tl).querySelector<HTMLElement>('.tl__add')!.getBoundingClientRect();

    expect(add.left).toBeGreaterThanOrEqual(target.right);
    // The handle's outermost pixel is its own, which is where a thumb reaching for the edge lands.
    expect(root(tl).elementFromPoint(target.right - 2, target.top + target.height / 2)).toBe(handle);
  });

  it('gets out of the way while an edge is pulled, and comes back after', async () => {
    const { store, tl } = await mount();
    const handle = await lastSegmentOnTheLine(tl, store);
    const add = root(tl).querySelector<HTMLElement>('.tl__add')!;
    const at = centre(handle);

    pointer(handle, 'pointerdown', at.x, at.y);
    await until('the trim to take the row', () => root(tl).querySelector('.tl--drag-resize') !== null);
    expect(getComputedStyle(add).pointerEvents).toBe('none');
    await until('the button to fade', () => getComputedStyle(add).opacity === '0');

    pointer(handle, 'pointerup', at.x, at.y);
    await until('the button to come back', () => getComputedStyle(add).pointerEvents === 'auto' && getComputedStyle(add).opacity === '1');
  });
});

describe('the timeline add button under a compact sheet', () => {
  it('stays on the slim timeline, with its choices in a row beside it', async () => {
    const { tl } = await mount();
    // What ve-editor gives the timeline while a compact sheet is open.
    tl.parentElement!.style.height = '96px';
    (tl as HTMLElement & { compact: boolean }).compact = true;
    await until('the compact timeline', () => !!root(tl).querySelector('.tl--compact'));
    const add = root(tl).querySelector<HTMLButtonElement>('.tl__add');
    expect(add).not.toBeNull();

    add!.click();
    await until('the add choices', () => !!root(tl).querySelector('.tl__add-menu'));
    const host = tl.getBoundingClientRect();
    const menu = root(tl).querySelector('.tl__add-menu')!.getBoundingClientRect();
    const button = add!.getBoundingClientRect();
    // All of it inside the 96px the timeline has - the host clips anything past that - and none of
    // it over the button.
    expect(menu.top).toBeGreaterThanOrEqual(host.top);
    expect(menu.bottom).toBeLessThanOrEqual(host.bottom);
    expect(menu.right).toBeLessThanOrEqual(button.left);
    expect([...root(tl).querySelectorAll('.tl__add-menu button')].map(choice => choice.textContent)).toEqual(['Video', 'Audio']);
  });
});

describe('audio lanes', () => {
  function packedSounds(store: EditorStore, secondDurationMs = 2000) {
    store.pps.value = 24;
    const sound = (fileName: string, startMs: number): EditMusic => ({
      uri: `blob:${fileName}`, fileName, sourceDurationMs: 2000,
      inMs: 0, outMs: 0, startMs, endMs: 0, volume: 0.8, loop: false, fadeOutMs: 0,
    });
    const first = store.addAudioClip(sound('first', 0))!;
    const second = store.addAudioClip({ ...sound('second', 2000), sourceDurationMs: secondDurationMs })!;
    return { first, second };
  }

  async function holdAudio(tl: HTMLElement, store: EditorStore, id: string) {
    store.select(null);
    await frames(2);
    const item = root(tl).querySelector<HTMLElement>(`[data-hit="audio"][data-id="${id}"]`)!;
    const from = centre(item);
    pointer(item, 'pointerdown', from.x, from.y);
    await until('the audio lift', () => root(tl).querySelector('.tl__reorder') !== null);
    return from;
  }

  function audioRowEl(tl: HTMLElement, id: string): HTMLElement {
    const found = root(tl).querySelector<HTMLElement>(`[data-arow="${id}"]`);
    if (!found) throw new Error(`no ${id} audio row`);
    return found;
  }

  function heldIndex(tl: HTMLElement): number | undefined {
    return instanceOf<{ clipReorder: { value: { to: number } | null } }>(tl).clipReorder.value?.to;
  }

  it('lifts a sound into the video rail and swaps in either direction only on release', async () => {
    const { store, tl } = await mount();
    const { first, second } = packedSounds(store);
    const before = store.manifest.value;
    const from = await holdAudio(tl, store, first);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    const lane = audioRowEl(tl, before.audioTracks![0]!.id);
    const tile = root(tl).querySelector<HTMLElement>('.rtile--lifted')!;
    const neighbour = root(tl).querySelector<HTMLElement>('.tl__reorder-rail .rtile')!;
    expect(tile.offsetWidth).toBe(32);
    expect(tile.offsetHeight).toBe(32);
    expect(getComputedStyle(tile).boxShadow).not.toBe('none');
    expect(neighbour.style.transform).toBe('translateX(40px)');
    expect(getComputedStyle(lane).visibility).toBe('hidden');
    expect(getComputedStyle(row(tl, 'base')).visibility).toBe('visible');
    expect(store.selection.value).toBeNull();
    pointer(scroller, 'pointermove', from.x + 40, from.y);
    await until('the second rail slot', () => heldIndex(tl) === 1);
    await frames(2);
    expect(neighbour.style.transform).toBe('translateX(0px)');
    expect(store.manifest.value).toBe(before);
    expect(scroller.scrollLeft).toBe(0);
    pointer(scroller, 'pointerup', from.x + 40, from.y);
    expect(store.manifest.value.audioTracks![0]!.clips.map(clip => [clip.id, clip.startMs])).toEqual([[second, 0], [first, 2000]]);
    store.undo();
    expect(store.manifest.value).toBe(before);
    expect(store.toast.value?.text).toBe('Undo: Reorder audio');
    store.redo();
    const swapped = store.manifest.value;
    const back = await holdAudio(tl, store, first);
    pointer(scroller, 'pointermove', back.x - 40, back.y);
    await until('the first rail slot', () => heldIndex(tl) === 0);
    expect(store.manifest.value).toBe(swapped);
    pointer(scroller, 'pointerup', back.x - 40, back.y);
    expect(store.manifest.value.audioTracks![0]!.clips.map(clip => [clip.id, clip.startMs])).toEqual([[first, 0], [second, 2000]]);
    store.undo();
    expect(store.manifest.value).toBe(swapped);
    expect(store.toast.value?.text).toBe('Undo: Reorder audio');
  });

  it('keeps a lone sound lifted and carries it into a lane below the stack', async () => {
    const { store, tl } = await mount();
    const { first } = packedSounds(store);
    store.removeSelectedAudio();
    const before = store.manifest.value;
    const from = await holdAudio(tl, store, first);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    pointer(scroller, 'pointermove', from.x + 48, from.y);
    await frames(2);
    expect(root(tl).querySelector('.rtile--lifted')).not.toBeNull();
    expect(root(tl).querySelectorAll('.tl__reorder-rail .rtile')).toHaveLength(0);
    expect(heldIndex(tl)).toBe(0);
    expect(store.manifest.value).toBe(before);
    const lane = audioRowEl(tl, before.audioTracks![0]!.id);
    const below = lane.getBoundingClientRect().bottom + 80;
    pointer(scroller, 'pointermove', from.x + 48, below);
    await until('the lane below the stack', () => lane.classList.contains('tl__vrow--drop-under'));
    expect(getComputedStyle(root(tl).querySelector<HTMLElement>('.tl__reorder-rail')!).display).toBe('none');
    expect(store.manifest.value).toBe(before);
    pointer(scroller, 'pointerup', from.x + 48, below);
    expect(store.manifest.value.audioTracks![0]!.clips).toHaveLength(1);
    expect(store.manifest.value.audioTracks![0]!.clips[0]!.startMs).toBe(2000);
    expect(store.selectedAudio.value?.id).toBe(first);
    store.undo();
    expect(store.manifest.value).toBe(before);
    expect(store.toast.value?.text).toBe('Undo: Move audio to layer');
  });

  it('carries an eight second sound past its shorter neighbour by one compact tile', async () => {
    const { store, tl } = await mount();
    const { first, second } = packedSounds(store, 8000);
    const before = store.manifest.value;
    const from = await holdAudio(tl, store, second);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    pointer(scroller, 'pointermove', from.x - 40, from.y);
    await until('long sound over the first rail slot', () => heldIndex(tl) === 0);
    expect(store.manifest.value).toBe(before);
    expect(scroller.scrollLeft).toBe(0);
    pointer(scroller, 'pointerup', from.x - 40, from.y);
    expect(store.manifest.value.audioTracks![0]!.clips.map(clip => [clip.id, clip.startMs])).toEqual([[second, 0], [first, 8000]]);
  });

  it('commits the last rail position when released before the next animation frame', async () => {
    const { store, tl } = await mount();
    const { first, second } = packedSounds(store);
    const before = store.manifest.value;
    const from = await holdAudio(tl, store, first);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    pointer(scroller, 'pointermove', from.x + 40, from.y);
    pointer(scroller, 'pointerup', from.x + 40, from.y);
    expect(store.manifest.value.audioTracks![0]!.clips.map(clip => clip.id)).toEqual([second, first]);
    store.undo();
    expect(store.manifest.value).toBe(before);
  });

  it('returns home and cancels above the stack or on pointercancel without changing audio', async () => {
    const { store, tl } = await mount();
    const { first } = packedSounds(store);
    const before = store.manifest.value;
    const from = await holdAudio(tl, store, first);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    pointer(scroller, 'pointermove', from.x + 40, from.y);
    await until('the other rail slot', () => heldIndex(tl) === 1);
    pointer(scroller, 'pointermove', from.x, from.y);
    await until('the original rail slot', () => heldIndex(tl) === 0);
    pointer(scroller, 'pointerup', from.x, from.y);
    expect(store.manifest.value).toBe(before);
    const again = await holdAudio(tl, store, first);
    pointer(scroller, 'pointermove', again.x + 40, again.y);
    await until('the next held rail slot', () => heldIndex(tl) === 1);
    pointer(scroller, 'pointercancel', again.x + 40, again.y);
    expect(store.manifest.value).toBe(before);
    const above = await holdAudio(tl, store, first);
    const lane = audioRowEl(tl, before.audioTracks![0]!.id);
    pointer(scroller, 'pointermove', above.x, lane.getBoundingClientRect().top - 80);
    await until('the cancelled lift', () => root(tl).querySelector('.tl__reorder') === null);
    expect(store.manifest.value).toBe(before);
    expect(getComputedStyle(lane).visibility).toBe('visible');
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Add audio');
  });

  it('switches from the reorder rail to another lane and back before committing a transfer', async () => {
    const { store, tl } = await mount();
    const { first, second } = packedSounds(store);
    const other = store.addAudioClip({ ...store.selectedAudio.value!, fileName: 'other', uri: 'blob:other', startMs: 0 })!;
    const before = store.manifest.value;
    const target = store.manifest.value.audioTracks![1]!.id;
    const from = await holdAudio(tl, store, first);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    pointer(scroller, 'pointermove', from.x + 40, from.y);
    await until('the reordered rail', () => heldIndex(tl) === 1);
    const to = centre(audioRowEl(tl, target));
    pointer(scroller, 'pointermove', from.x + 40, to.y);
    await until('the destination lane', () => audioRowEl(tl, target).classList.contains('tl__vrow--drop'));
    const lane = audioRowEl(tl, before.audioTracks![0]!.id);
    const rail = root(tl).querySelector<HTMLElement>('.tl__reorder-rail')!;
    expect(getComputedStyle(rail).display).toBe('none');
    expect(getComputedStyle(lane).visibility).toBe('visible');
    expect(Number(getComputedStyle(lane.querySelector<HTMLElement>(`[data-id="${first}"]`)!).opacity)).toBeLessThan(1);
    expect(store.manifest.value).toBe(before);
    pointer(scroller, 'pointermove', from.x + 40, from.y);
    await until('back on the source rail', () => !root(tl).querySelector('.tl--dropping'));
    expect(getComputedStyle(rail).display).not.toBe('none');
    expect(getComputedStyle(lane).visibility).toBe('hidden');
    expect(heldIndex(tl)).toBe(1);
    // Release on the destination without waiting for its next animation frame.
    pointer(scroller, 'pointermove', from.x + 48, to.y);
    pointer(scroller, 'pointerup', from.x + 48, to.y);
    expect(store.manifest.value.audioTracks!.map(track => track.clips.map(clip => clip.id))).toEqual([[second], [other, first]]);
    expect(store.manifest.value.audioTracks![0]!.clips[0]!.startMs).toBe(2000);
    expect(store.selectedAudio.value?.id).toBe(first);
    store.undo();
    expect(store.manifest.value).toBe(before);
    expect(store.toast.value?.text).toBe('Undo: Move audio to layer');
  });

  it('opens a lane in the gap between audio rows and below the last row', async () => {
    const { store, tl } = await mount();
    const { first, second } = packedSounds(store);
    const other = store.addAudioClip({ ...store.selectedAudio.value!, fileName: 'other', uri: 'blob:other', startMs: 0 })!;
    const before = store.manifest.value;
    const sourceId = before.audioTracks![0]!.id;
    const targetId = before.audioTracks![1]!.id;
    const from = await holdAudio(tl, store, first);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    const gap = (audioRowEl(tl, sourceId).getBoundingClientRect().bottom + audioRowEl(tl, targetId).getBoundingClientRect().top) / 2;
    pointer(scroller, 'pointermove', from.x, gap);
    await until('the gap between audio rows', () => audioRowEl(tl, sourceId).classList.contains('tl__vrow--drop-under'));
    expect(store.manifest.value).toBe(before);
    pointer(scroller, 'pointerup', from.x, gap);
    expect(store.manifest.value.audioTracks!.map(track => track.clips.map(clip => clip.id))).toEqual([[second], [first], [other]]);
    store.undo();
    expect(store.manifest.value).toBe(before);
    const again = await holdAudio(tl, store, first);
    const last = audioRowEl(tl, targetId);
    const below = last.getBoundingClientRect().bottom + 80;
    pointer(scroller, 'pointermove', again.x, below);
    await until('the gap below all audio rows', () => last.classList.contains('tl__vrow--drop-under'));
    expect(store.manifest.value).toBe(before);
    pointer(scroller, 'pointerup', again.x, below);
    expect(store.manifest.value.audioTracks!.map(track => track.clips.map(clip => clip.id))).toEqual([[second], [other], [first]]);
    store.undo();
    expect(store.manifest.value).toBe(before);
  });

  it('slides the compact rail at the edge without scrolling the timeline or moving audio', async () => {
    const { store, tl } = await mount();
    store.pps.value = 24;
    let first: string | null = null;
    for (let i = 0; i < 12; i += 1) {
      const id = store.addAudioClip({
        uri: `blob:sound-${i}`, fileName: `sound-${i}`, sourceDurationMs: 500,
        inMs: 0, outMs: 0, startMs: i * 500, endMs: 0, volume: 0.8, loop: false, fadeOutMs: 0,
      })!;
      first ??= id;
    }
    const before = store.manifest.value;
    const from = await holdAudio(tl, store, first!);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    const overlay = root(tl).querySelector<HTMLElement>('.tl__reorder')!;
    const origin = Number.parseFloat(overlay.style.getPropertyValue('--ox'));
    const edge = scroller.getBoundingClientRect().right - 3;
    pointer(scroller, 'pointermove', edge, from.y);
    await until('the rail to slide left', () => Number.parseFloat(overlay.style.getPropertyValue('--ox')) < origin - 20);
    expect(scroller.scrollLeft).toBe(0);
    expect(store.manifest.value).toBe(before);
    pointer(scroller, 'pointercancel', edge, from.y);
    expect(store.manifest.value).toBe(before);
  });

  it('keeps video rows independent when audio shares their clip and track IDs', async () => {
    const { store, tl } = await mount([layer('vt-1', 1, [{ id: 'seg-x', key: 'clip-x' }])]);
    const { first } = packedSounds(store);
    const other = store.addAudioClip({ ...store.selectedAudio.value!, fileName: 'other', uri: 'blob:other', startMs: 0 })!;
    store.commit('Colliding domain IDs', m => ({
      ...m,
      audioTracks: m.audioTracks!.map((track, i) => i === 0 ? {
        ...track, id: 'vt-1', clips: track.clips.map(clip => clip.id === first ? { ...clip, id: 'seg-a' } : clip),
      } : track),
    }));
    const before = store.manifest.value;
    const from = await holdAudio(tl, store, 'seg-a');
    expect(getComputedStyle(audioRowEl(tl, 'vt-1')).visibility).toBe('hidden');
    expect(getComputedStyle(row(tl, 'vt-1')).visibility).toBe('visible');
    expect(getComputedStyle(row(tl, 'base')).visibility).toBe('visible');
    const destination = audioRowEl(tl, before.audioTracks![1]!.id);
    const to = centre(destination);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    pointer(scroller, 'pointermove', from.x, to.y);
    await until('the audio destination without a video cue', () => destination.classList.contains('tl__vrow--drop'));
    expect(root(tl).querySelector('[data-vrow].tl__vrow--drop')).toBeNull();
    expect(root(tl).querySelector('[data-vrow].tl__vrow--drop-under')).toBeNull();
    expect(getComputedStyle(segmentEl(tl, 'seg-a')).opacity).toBe('1');
    expect(store.manifest.value).toBe(before);
    pointer(scroller, 'pointerup', from.x, to.y);
    await frames(2);
    expect(store.manifest.value.clips).toBe(before.clips);
    expect(store.manifest.value.videoTracks).toBe(before.videoTracks);
    expect(store.manifest.value.audioTracks![1]!.clips.map(clip => clip.id)).toEqual([other, 'seg-a']);
    store.undo();
    expect(store.manifest.value).toBe(before);
  });

  it('shows sequential clips together, overlaps on another lane, and drops a clip between lanes', async () => {
    const { store, tl } = await mount();
    store.pps.value = 24;
    const sound = (fileName: string, startMs: number) => ({
      uri: `blob:${fileName}`,
      fileName,
      sourceDurationMs: 2000,
      inMs: 0,
      outMs: 0,
      startMs,
      endMs: 0,
      volume: 0.8,
      loop: false,
      fadeOutMs: 0,
    });
    const first = store.addAudioClip(sound('first', 0))!;
    const firstRow = store.manifest.value.audioTracks![0]!.id;
    const second = store.addAudioClip(sound('second', 2000), firstRow)!;
    const third = store.addAudioClip(sound('third', 0))!;
    const secondRow = store.manifest.value.audioTracks![1]!.id;

    await until('three audio bars', () => root(tl).querySelectorAll('[data-hit="audio"]').length === 3);
    expect(root(tl).querySelectorAll(`[data-arow="${firstRow}"] [data-hit="audio"]`).length).toBe(2);
    expect(root(tl).querySelectorAll(`[data-arow="${secondRow}"] [data-hit="audio"]`).length).toBe(1);
    expect(store.manifest.value.audioTracks![0]!.clips.map(clip => clip.id)).toEqual([first, second]);

    store.select({ kind: 'audio', id: second });
    await frames(2);
    const clip = root(tl).querySelector<HTMLElement>(`[data-hit="audio"][data-id="${second}"]`)!;
    const from = centre(clip);
    const to = centre(root(tl).querySelector<HTMLElement>(`[data-arow="${secondRow}"]`)!);
    const scroller = root(tl).querySelector<HTMLElement>('.tl__scroller')!;
    pointer(clip, 'pointerdown', from.x, from.y);
    pointer(scroller, 'pointermove', from.x + 48, to.y);
    await frames(2);
    pointer(scroller, 'pointerup', from.x + 48, to.y);
    await until('audio dropped', () => store.manifest.value.audioTracks![1]!.clips.length === 2);

    expect(store.manifest.value.audioTracks![0]!.clips.map(clip => clip.id)).toEqual([first]);
    expect(store.manifest.value.audioTracks![1]!.clips.map(clip => clip.id)).toEqual([third, second]);
    expect(store.manifest.value.audioTracks![1]!.clips[1]!.startMs).toBe(4000);
  });
});

/*
 * A video's own sound, on its filmstrip - and what turning that sound off does to it.
 */
describe('the waveform on a video clip', () => {
  const PEAKS: Peaks = {
    stepMs: 10,
    peaks: Uint8Array.from({ length: 400 }, (_, i) => (i > 120 && i < 280 ? 255 : 16)),
    durationMs: 4000,
    max: 255,
  };

  function waveOf(tl: HTMLElement, id: string): SVGPathElement | null {
    return root(tl).querySelector<SVGPathElement>(`.seg[data-id="${id}"] .seg__wave path`);
  }

  async function withClipSound() {
    const mounted = await mount();
    // Seeded before anything asks for it, so the real decoder is never reached: `clip-a` has no
    // file behind it here, and a measurement already in the map is what stops the watcher trying.
    mounted.store.waveforms.value = new Map(mounted.store.waveforms.value).set('clip:clip-a', PEAKS);
    await frames(2);
    return mounted;
  }

  it('draws the sound inside a video on its own segment', async () => {
    const { tl } = await withClipSound();

    await until('the clip waveform', () => waveOf(tl, 'seg-a') !== null);
    const d = waveOf(tl, 'seg-a')!.getAttribute('d') ?? '';
    const heights = [...d.matchAll(/v([\d.]+)/g)].map(m => Number(m[1]));

    expect(heights.length).toBeGreaterThan(10);
    // Loud in the middle, quiet at the ends: more than one height, or it is not a waveform.
    expect(new Set(heights).size).toBeGreaterThan(1);
  });

  it('draws nothing for a video whose sound was never measured', async () => {
    const { tl } = await mount();

    expect(root(tl).querySelector('.seg[data-id="seg-a"]')).not.toBeNull();
    expect(waveOf(tl, 'seg-a')).toBeNull();
  });

  it('takes every wave away when the original sound is switched off, and puts them back', async () => {
    // The speaker beside the video row: one toggle, every clip.
    const { store, tl } = await withClipSound();
    await until('the clip waveform', () => waveOf(tl, 'seg-a') !== null);

    store.toggleOriginalMuted();
    await until('the wave to go', () => waveOf(tl, 'seg-a') === null);

    store.toggleOriginalMuted();
    await until('the wave to come back', () => waveOf(tl, 'seg-a') !== null);
  });

  it('takes the wave away at zero volume, and puts it back above it', async () => {
    // Turning a clip down to nothing is the same statement as muting it, and has to read the same.
    const { store, tl } = await withClipSound();
    await until('the clip waveform', () => waveOf(tl, 'seg-a') !== null);

    store.setVolume({ kind: 'clip', id: 'seg-a' }, 0, false);
    await until('the wave to go', () => waveOf(tl, 'seg-a') === null);

    store.setVolume({ kind: 'clip', id: 'seg-a' }, 0.6, false);
    await until('the wave to come back', () => waveOf(tl, 'seg-a') !== null);
  });

  /*
   * The Volume sheet's slider writes the manifest on every step of the drag, with the segment
   * selected. The wave's shape is drawn against the file's own loudest peak and never depended on
   * the level, and the trim handles are where they were - so a drag that only stays heard has
   * nothing on the timeline to redraw, and used to redraw all of it on every step.
   */
  it('draws nothing again while the volume is dragged, until the sound goes', async () => {
    const { store, tl } = await withClipSound();
    await until('the clip waveform', () => waveOf(tl, 'seg-a') !== null);
    store.select({ kind: 'clip', id: 'seg-a' });
    await until('the trim handles', () => root(tl).querySelector('[data-hit="clip-in"]') !== null);
    const renders = countRenders(tl);
    await settle(renders);

    const views = instanceOf<Views>(tl);
    const handles = views.trimHandles.value;
    const waves = views.clipWaves.value;
    const path = waveOf(tl, 'seg-a')!.getAttribute('d');
    const before = renders();
    for (const v of [0.9, 0.8, 0.7, 0.6, 0.5]) {
      store.setVolume({ kind: 'clip', id: 'seg-a' }, v, true);
      await frames(1);
    }
    await frames(3);

    expect(views.trimHandles.value).toBe(handles);
    expect(views.clipWaves.value).toBe(waves);
    expect(renders()).toBe(before);
    expect(waveOf(tl, 'seg-a')!.getAttribute('d')).toBe(path);

    // Down to nothing and back up, still in the same drag: the picture goes and comes back as it always did.
    store.setVolume({ kind: 'clip', id: 'seg-a' }, 0, true);
    await until('the wave to go', () => waveOf(tl, 'seg-a') === null);
    store.setVolume({ kind: 'clip', id: 'seg-a' }, 0.4, true);
    await until('the wave to come back', () => waveOf(tl, 'seg-a') !== null);
    expect(waveOf(tl, 'seg-a')!.getAttribute('d')).toBe(path);
    store.endGesture('Volume');
  });

  it('leaves the other segments of the same source alone when one is silenced', async () => {
    // Every segment here is a different source, so use the one that shares nothing: muting seg-a
    // must not touch seg-b, which has its own clip and its own sound.
    const { store, tl } = await withClipSound();
    store.waveforms.value = new Map(store.waveforms.value).set('clip:clip-b', PEAKS);
    await until('both waveforms', () => waveOf(tl, 'seg-a') !== null && waveOf(tl, 'seg-b') !== null);

    store.setVolume({ kind: 'clip', id: 'seg-a' }, 0, false);
    await until('the first to go', () => waveOf(tl, 'seg-a') === null);

    expect(waveOf(tl, 'seg-b')).not.toBeNull();
  });
});

/*
 * The zoom row: one bar per zoom on a fixed row under the filmstrip, named with its level and its
 * state, and retimed by the same handles a layer has. At 64 px a second, as above.
 */
describe('the zoom row', () => {
  /** A 3 s zoom from 1 s, added the way the tool row adds one, then let go of. */
  async function withZoom(): Promise<{ store: EditorStore; tl: HTMLElement; id: string }> {
    const { store, tl } = await mount();
    store.seek(1000);
    store.addZoomAtPlayhead();
    const id = store.manifest.value.zooms[0].id;
    store.closePanel();
    store.select(null);
    await until('the zoom row', () => !!root(tl).querySelector('[data-row="zoom"] .item--zoom'));
    return { store, tl, id };
  }

  function bar(tl: HTMLElement): HTMLElement {
    return root(tl).querySelector<HTMLElement>('[data-row="zoom"] .item--zoom')!;
  }

  it('is not there without a zoom', async () => {
    const { tl } = await mount();
    expect(root(tl).querySelector('[data-row="zoom"]')).toBeNull();
  });

  it('draws the zoom over its window, named with its level and never aria-pressed', async () => {
    const { tl } = await withZoom();
    const el = bar(tl);
    expect(el.getAttribute('aria-label')).toBe('Zoom 2.0x');
    expect(el.hasAttribute('aria-pressed')).toBe(false);
    // 3 s at 64 px a second.
    expect(el.getBoundingClientRect().width).toBeCloseTo(192, 0);
    // Not a video row, so a dropped segment never takes it for one.
    expect(root(tl).querySelector('[data-row="zoom"]')!.hasAttribute('data-vrow')).toBe(false);
  });

  it('opens the zoom on a tap and names it selected, with its two handles', async () => {
    const { store, tl, id } = await withZoom();
    const at = centre(bar(tl));
    pointer(bar(tl), 'pointerdown', at.x, at.y);
    pointer(bar(tl), 'pointerup', at.x, at.y);

    expect(store.selection.value).toEqual({ kind: 'zoom', id });
    expect(store.panel.value).toBe('zoom');
    await until('the name to follow', () => bar(tl).getAttribute('aria-label') === 'Zoom 2.0x, selected');
    expect(root(tl).querySelectorAll('[data-row="zoom"] .handle').length).toBe(2);
  });

  /**
   * The zoom's end handle dragged half a second later, a whole drag from finger down to finger up.
   * The playhead is put at 3 s first, which brings the end in from the right side of the viewport,
   * where a drag would start scrolling the timeline under itself.
   */
  async function dragEndLater(store: EditorStore, tl: HTMLElement, id: string): Promise<void> {
    store.seek(3000);
    await frames(3);
    store.select({ kind: 'zoom', id });
    await until('the handles', () => !!root(tl).querySelector('[data-row="zoom"] .handle--out'));
    const handle = root(tl).querySelector<HTMLElement>('[data-row="zoom"] .handle--out')!;
    const rect = handle.getBoundingClientRect();
    const from = { x: rect.left + 20, y: rect.top + rect.height / 2 };
    const scroller = root(tl).querySelector('.tl__scroller')!;
    pointer(handle, 'pointerdown', from.x, from.y);
    pointer(scroller, 'pointermove', from.x + 32, from.y);
    await frames(3);
    pointer(scroller, 'pointerup', from.x + 32, from.y);
    await frames(2);
  }

  it('retimes the end by its handle as one undo step', async () => {
    const { store, tl, id } = await withZoom();
    await dragEndLater(store, tl, id);

    // Half a second at 64 px a second.
    const zoom = store.manifest.value.zooms[0];
    expect(zoom.startMs).toBe(1000);
    expect(zoom.endMs).toBeCloseTo(4500, -2);

    store.undo();
    expect(store.manifest.value.zooms[0].endMs).toBe(4000);
  });

  /*
   * The editor takes the timeline out in full screen and under the tall sheets and puts a new one
   * in after. The drags used to be counted by the timeline for their keys, so the new one's first
   * drag had the old one's first key and folded into its undo step.
   */
  it('keeps a drag on a timeline mounted again out of the step the last one made', async () => {
    const { store, tl, id } = await withZoom();
    await dragEndLater(store, tl, id);
    expect(store.manifest.value.zooms[0].endMs).toBeCloseTo(4500, -2);

    const column = tl.parentElement!;
    const { ctx } = tl as HTMLElement & { ctx: EditorContext };
    tl.remove();
    const again = document.createElement('ve-timeline');
    again.style.height = '100%';
    Object.assign(again, { ctx });
    column.append(again);
    await (again as StencilElement).componentOnReady?.();
    await frames(2);

    await dragEndLater(store, again, id);
    expect(store.manifest.value.zooms[0].endMs).toBeCloseTo(5000, -2);

    store.undo();
    expect(store.manifest.value.zooms[0].endMs).toBeCloseTo(4500, -2);
    store.undo();
    expect(store.manifest.value.zooms[0].endMs).toBe(4000);
  });
});

/*
 * What kind of thing each lane is, read off the glyph at its head: the lanes used to be told apart
 * by colour alone, and a text lane and an effect lane are two shades of pink.
 */
describe('the lane glyphs', () => {
  function laneEl(tl: HTMLElement, id: string): HTMLElement {
    const found = root(tl).querySelector<HTMLElement>(`[data-hit="layer"][data-id="${id}"]`);
    if (!found) throw new Error(`no ${id} lane`);
    return found;
  }

  function glyphOf(lane: HTMLElement): HTMLElement | null {
    return lane.querySelector<HTMLElement>('.item__kind');
  }

  /** One layer of every kind, from the start of the post to its end. */
  async function withLayers(caption = 'Full send') {
    const mountedTl = await mount();
    const { store } = mountedTl;
    const text = store.addLayer<TextOverlay>('Text', {
      kind: 'text',
      text: caption,
      styleId: 'classic',
      color: '#ffffff',
      effect: 'shadow',
      align: 'center',
      cx: 0.5,
      cy: 0.5,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
    })!;
    const sticker = store.addSticker({ emoji: '🔥' })!;
    const photo = store.addImage('file:///photo.jpg', 'photo.jpg', 1)!;
    const effect = store.addEffect('vignette', 'Vignette')!;
    store.select(null);
    await until('a lane for every layer', () => root(mountedTl.tl).querySelectorAll('[data-hit="layer"]').length === 4);
    return { ...mountedTl, ids: { text, sticker, photo, effect } };
  }

  it('leads every lane with the glyph of what it carries', async () => {
    const { tl, ids } = await withLayers();

    expect(glyphOf(laneEl(tl, ids.text))?.dataset.glyph).toBe('text');
    expect(glyphOf(laneEl(tl, ids.sticker))?.dataset.glyph).toBe('happy');
    expect(glyphOf(laneEl(tl, ids.photo))?.dataset.glyph).toBe('image');
    expect(glyphOf(laneEl(tl, ids.effect))?.dataset.glyph).toBe('sparkles');
    // First in the label, before the sticker's own picture or the text's words.
    for (const id of Object.values(ids)) {
      expect(laneEl(tl, id).querySelector('.item__label')!.firstElementChild!.classList.contains('item__kind')).toBe(true);
    }
  });

  it('shows the words beside the glyph on a lane with room for them', async () => {
    const { tl, ids } = await withLayers();
    const lane = laneEl(tl, ids.text);
    const text = lane.querySelector<HTMLElement>('.item__text')!;

    expect(lane.classList.contains('item--glyph')).toBe(false);
    expect(text.getBoundingClientRect().width).toBeGreaterThan(40);
    expect(text.getBoundingClientRect().left).toBeGreaterThan(glyphOf(lane)!.getBoundingClientRect().right);
  });

  it('draws a lane too short for a label as its glyph alone, centred', async () => {
    const { store, tl, ids } = await withLayers();
    // Twelve seconds at 6 px a second is a 72 px bar.
    store.pps.value = 6;
    const lane = () => laneEl(tl, ids.text);
    await until('the short lane', () => lane().classList.contains('item--glyph'));

    const bar = lane().getBoundingClientRect();
    const glyph = glyphOf(lane())!.getBoundingClientRect();
    expect(glyph.left + glyph.width / 2).toBeCloseTo(bar.left + bar.width / 2, 0);
    expect(lane().querySelector('.item__text')!.getBoundingClientRect().width).toBeLessThanOrEqual(1);
    // Out of sight, and still what a screen reader finds the layer by.
    expect(lane().textContent).toContain('Full send');

    store.pps.value = 64;
    await until('the label back', () => !lane().classList.contains('item--glyph'));
  });

  it('never lets the label push the glyph out of a lane', async () => {
    const { store, tl, ids } = await withLayers('A caption far too long to fit on any lane at all');
    // 12 s at 8 px a second is 96 px: room for the glyph and a few letters, not the whole line.
    store.pps.value = 8;
    await frames(3);
    const lane = laneEl(tl, ids.text);
    const bar = lane.getBoundingClientRect();
    const glyph = glyphOf(lane)!.getBoundingClientRect();

    expect(lane.classList.contains('item--glyph')).toBe(false);
    expect(glyph.width).toBe(24);
    expect(glyph.left).toBeGreaterThanOrEqual(bar.left);
    expect(glyph.right).toBeLessThanOrEqual(bar.right);
  });
});

/*
 * A layer's animation on its lane: the in and the out drawn the way the zoom bar draws its camera's
 * ramps, a fade at each end, from the spans the render plays them in - so a caption that pops in has
 * a soft head, one that cuts in a hard one, and a layer too short for both is squeezed as it is in
 * the file.
 */
describe('the lane ramps', () => {
  function laneEl(tl: HTMLElement, id: string): HTMLElement {
    const found = root(tl).querySelector<HTMLElement>(`[data-hit="layer"][data-id="${id}"]`);
    if (!found) throw new Error(`no ${id} lane`);
    return found;
  }

  function ramp(tl: HTMLElement, id: string, which: 'in' | 'out'): number {
    return laneEl(tl, id).querySelector<HTMLElement>(`.item__ramp--${which}`)!.getBoundingClientRect().width;
  }

  it('draws an in and an out at the length they play, and nothing on a layer that cuts', async () => {
    const { store, tl } = await mount();
    const id = store.addSticker({ emoji: '🔥' })!;
    store.select(null);
    await until('the lane', () => !!root(tl).querySelector(`[data-hit="layer"][data-id="${id}"]`));
    expect(ramp(tl, id, 'in')).toBe(0);
    expect(ramp(tl, id, 'out')).toBe(0);

    store.commitOverlay(id, { animation: { in: { id: 'pop', durationMs: 500 }, out: { id: 'fade', durationMs: 1000 } } }, 'Animation');
    const pps = store.pps.value;
    await until('the ramps', () => Math.abs(ramp(tl, id, 'in') - 0.5 * pps) < 0.5);
    expect(ramp(tl, id, 'out')).toBeCloseTo(pps, 0);
    // Drawing, not a control: nothing to read and nothing to press.
    expect(laneEl(tl, id).querySelector('.item__ramp--in')!.getAttribute('aria-hidden')).toBe('true');
  });

  it('squeezes the in and the out together on a layer too short for both, as the render does', async () => {
    const { store, tl } = await mount();
    const id = store.addSticker({ emoji: '🔥' })!;
    store.select(null);
    await until('the lane', () => !!root(tl).querySelector(`[data-hit="layer"][data-id="${id}"]`));
    // 600 ms for 500 in and 1000 out: both at two fifths, 200 and 400.
    store.commitOverlay(id, { startMs: 0, endMs: 600, animation: { in: { id: 'pop', durationMs: 500 }, out: { id: 'fade', durationMs: 1000 } } }, 'Animation');
    const pps = store.pps.value;
    await until('the ramps', () => Math.abs(ramp(tl, id, 'in') - 0.2 * pps) < 0.5);
    expect(ramp(tl, id, 'out')).toBeCloseTo(0.4 * pps, 0);
  });
});
