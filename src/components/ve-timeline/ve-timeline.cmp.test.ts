import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest, type EditVideoTrack } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

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
  column.style.cssText = 'width: 393px; height: 250px';
  document.body.append(column);

  const tl = document.createElement('ve-timeline');
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
