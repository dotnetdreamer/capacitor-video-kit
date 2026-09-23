import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest, type EditMusic, type EditVideoTrack } from '../../editor';
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
    const { tl } = await mount([1, 2, 3, 4, 5].map(n => layer(`vt-${n}`, n, [{ id: `seg-${n}`, key: n % 2 ? 'clip-x' : 'clip-y' }])));
    const view = root(tl).querySelector<HTMLElement>('.tl__lanes-view')!;
    const lanes = root(tl).querySelector<HTMLElement>('.tl__lanes')!;
    const room = () => lanes.offsetHeight - view.clientHeight;
    const panned = () => -Number(/translate3d\([^,]+,\s*(-?[\d.]+)px/.exec(lanes.style.transform)?.[1] ?? 0);
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
    return { uri: 'blob:tune', fileName: 'tune.mp3', sourceDurationMs: 20_000, inMs: 0, outMs: 0, startMs: 0, volume: 0.8, loop: true, fadeOutMs: 0, ...over };
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
