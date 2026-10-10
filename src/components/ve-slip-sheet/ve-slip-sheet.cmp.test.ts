import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditClip, type EditManifest } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because what this sheet has to get right is a real scroll:
 * a strip laid out at a width, scrolled by the browser, and the part under a frame that has to be
 * exactly as long as the segment and exactly in the middle of it. The arithmetic alone is pinned
 * down in `slip-strip.unit.test.ts`.
 */

/** The width of the column the sheet is drawn in, which is the strip's: the test phone's. */
const VIEW_PX = 393;

/** The segment being trimmed: 2..5 s of a twenty second clip, after two seconds of another clip. */
const START_MS = 2000;
const LENGTH_MS = 3000;
const CLIP_MS = 20_000;

/** The scale the strip is laid out at: the segment at 60% of the strip. */
const PX_PER_MS = (VIEW_PX * 0.6) / LENGTH_MS;

const mounted: { store: EditorStore; column: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

function manifest(sourceMs = CLIP_MS): EditManifest {
  const segment = (id: string, clipKey: string, inMs: number, outMs: number): EditClip => ({ id, clipKey, inMs, outMs, speed: 1, volume: 1, muted: false });
  return {
    ...emptyManifest(),
    clips: [segment('seg-0', 'clip-b', 0, 2000), segment('seg-1', 'clip-a', sourceMs > LENGTH_MS ? START_MS : 0, sourceMs > LENGTH_MS ? START_MS + LENGTH_MS : LENGTH_MS)],
  };
}

/** The sheet over the second segment, as the toolbar's Trim tile leaves it. */
async function mount(sourceMs = CLIP_MS): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };
  store.load(
    [
      { key: 'clip-a', fileName: 'a.mp4' },
      { key: 'clip-b', fileName: 'b.mp4' },
    ],
    new Map([
      ['clip-a', sourceMs],
      ['clip-b', 2000],
    ]),
    manifest(sourceMs),
  );
  store.select({ kind: 'clip', id: 'seg-1' });
  store.openSlip();

  const column = document.createElement('div');
  column.style.cssText = `width: ${VIEW_PX}px`;
  document.body.append(column);

  const sheet = document.createElement('ve-slip-sheet');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(sheet, { ctx });
  column.append(sheet);

  mounted.push({ store, column });
  await (sheet as StencilElement).componentOnReady?.();
  await (sheet.shadowRoot?.querySelector('ve-sheet') as StencilElement | null)?.componentOnReady?.();
  return { store, sheet };
}

function part(sheet: HTMLElement, selector: string): HTMLElement {
  const found = sheet.shadowRoot?.querySelector<HTMLElement>(selector);
  if (!found) throw new Error(`no ${selector}`);
  return found;
}

function scroller(sheet: HTMLElement): HTMLElement {
  return part(sheet, '.slip__scroll');
}

function keys(sheet: HTMLElement): HTMLInputElement {
  return part(sheet, '.slip__keys') as HTMLInputElement;
}

function segment(store: EditorStore): EditClip {
  return store.manifest.value.clips[1];
}

/** Polls a frame at a time, because a repaint and a scroll event are the browser's to schedule. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

/** Waits for the strip to be measured and placed over the segment's part, which takes a frame or two. */
async function placed(sheet: HTMLElement): Promise<void> {
  await until('the strip to be placed', () => Math.abs(scroller(sheet).scrollLeft - START_MS * PX_PER_MS) < 1);
}

afterEach(() => {
  for (const { store, column } of mounted.splice(0)) {
    store.dispose();
    column.remove();
  }
});

describe('ve-slip-sheet', () => {
  it('draws a frame as long as the segment, in the middle of a strip as long as the clip', async () => {
    const { sheet } = await mount();
    await placed(sheet);

    const strip = part(sheet, '.slip__strip').getBoundingClientRect();
    const frame = part(sheet, '.slip__frame').getBoundingClientRect();
    expect(strip.width).toBe(VIEW_PX);
    expect(frame.width).toBeCloseTo(LENGTH_MS * PX_PER_MS, 1);
    expect(frame.left + frame.width / 2).toBeCloseTo(strip.left + strip.width / 2, 1);
    // The clip, with half the strip less half the frame either side, so either end reaches the frame.
    expect(part(sheet, '.slip__track').getBoundingClientRect().width).toBeCloseTo(CLIP_MS * PX_PER_MS + VIEW_PX - LENGTH_MS * PX_PER_MS, 0);
  });

  it('opens with the strip under the segment’s part, and says where that part is', async () => {
    const { sheet } = await mount();
    await placed(sheet);

    expect(part(sheet, '.slip__times').textContent).toBe('00:02.0 to 00:05.0');
    expect(part(sheet, '.slip__hint').textContent).toBe('Drag to choose the part that plays');
  });

  it('slides the segment with the strip, at its length, and makes the slide one undo step when it rests', async () => {
    const { store, sheet } = await mount();
    await placed(sheet);

    scroller(sheet).scrollLeft += 5000 * PX_PER_MS;
    await until('the part to follow the strip', () => segment(store).inMs > 6900);
    expect(segment(store).inMs).toBeCloseTo(7000, -1);
    expect(segment(store).outMs - segment(store).inMs).toBe(LENGTH_MS);
    // The preview stays on the segment's first frame, which is two seconds into the post.
    expect(store.playheadMs.value).toBe(2000);

    scroller(sheet).dispatchEvent(new Event('scrollend'));
    await until('the slide to be a step', () => store.canUndo.value);
    store.undo();
    expect(store.toast.value?.text).toBe('Undo: Trim');
    expect(segment(store).inMs).toBe(START_MS);
    // And the strip goes back under the part it shows.
    await placed(sheet);
  });

  it('holds the part inside the clip at the end of the strip', async () => {
    const { store, sheet } = await mount();
    await placed(sheet);

    scroller(sheet).scrollLeft = 100_000;
    await until('the part to reach the end', () => segment(store).outMs > CLIP_MS - 50);
    expect(segment(store).outMs).toBeLessThanOrEqual(CLIP_MS);
    expect(segment(store).outMs - segment(store).inMs).toBe(LENGTH_MS);
  });

  /* A scrolling element lets a finger drag it and not a mouse; the sheet does the mouse's dragging. */
  it('lets a mouse drag the strip, as one undo step', async () => {
    const { store, sheet } = await mount();
    await placed(sheet);
    const el = scroller(sheet);
    const pointer = (type: string, clientX: number) => new PointerEvent(type, { pointerId: 7, pointerType: 'mouse', button: 0, clientX, bubbles: true });

    el.dispatchEvent(pointer('pointerdown', 300));
    el.dispatchEvent(pointer('pointermove', 200));
    await until('the part to follow the mouse', () => segment(store).inMs > START_MS + 1000);
    el.dispatchEvent(pointer('pointerup', 200));

    expect(segment(store).inMs).toBeCloseTo(START_MS + 100 / PX_PER_MS, -1);
    expect(store.canUndo.value).toBe(true);
  });

  it('turns the strip with a wheel', async () => {
    const { store, sheet } = await mount();
    await placed(sheet);

    scroller(sheet).dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
    await until('the part to follow the wheel', () => segment(store).inMs > START_MS + 1000);
  });

  it('moves the part a step at a time from the keyboard, and puts the strip under it', async () => {
    const { store, sheet } = await mount();
    await placed(sheet);

    expect(keys(sheet).getAttribute('aria-label')).toBe('Start of part');
    expect(keys(sheet).getAttribute('aria-valuetext')).toBe('2 seconds');
    keys(sheet).value = '6000';
    keys(sheet).dispatchEvent(new Event('input', { bubbles: true }));

    expect(segment(store)).toMatchObject({ inMs: 6000, outMs: 9000 });
    await until('the strip to follow the keys', () => Math.abs(scroller(sheet).scrollLeft - 6000 * PX_PER_MS) < 1);
  });

  it('says so when the segment plays the whole clip, with nothing to slide', async () => {
    const { sheet } = await mount(LENGTH_MS);

    await until('the hint', () => part(sheet, '.slip__hint').textContent === 'The whole video plays');
    expect(keys(sheet).disabled).toBe(true);
  });

  it('plays the part from its first frame', async () => {
    const { store, sheet } = await mount();
    await placed(sheet);
    store.seek(0);

    const play = part(sheet, '.slip__play');
    expect(play.getAttribute('aria-label')).toBe('Play part');
    play.click();
    expect(store.playheadMs.value).toBe(2000);
  });

  it('asks for a clip when no video is selected', async () => {
    const { store, sheet } = await mount();
    store.select(null);

    await until('the empty sheet', () => sheet.shadowRoot?.querySelector('.slip__empty')?.textContent?.trim() === 'Select a clip first');
  });
});
