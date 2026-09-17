import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { MAX_LAYERS } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * The mechanism test as much as the component's: `SignalWatcher` is what turns a write to the store
 * into a repaint, every component in this package is built on it, and nothing has proved it until
 * an element has actually repainted in a browser. This is the cheapest place to watch it happen -
 * one signal in, one line of text out - which is why it is here rather than beside the watcher.
 *
 * A browser rather than the mock DOM for the rest of it too: that the message centres, that it does
 * not wrap when it would have fitted, and that a tap passes through it are all questions about
 * layout, and the mock DOM answers every one of them yes.
 */

/** The editor's own column on the phone it was drawn for, so the room either side is a measurement. */
const STAGE_WIDTH = 393;

const mounted: { store: EditorStore; stage: HTMLElement }[] = [];

/** What the lazy build gives every element of its own, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

async function mount(): Promise<{ store: EditorStore; toast: HTMLElement; stage: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const ctx: EditorContext = { store, media: new EditorMedia(store, host) };

  /* What the shell's stage is: the positioned box this component places itself against. */
  const stage = document.createElement('div');
  stage.style.cssText = `position: relative; width: ${STAGE_WIDTH}px; height: 300px`;
  document.body.append(stage);

  const toast = document.createElement('ve-toast');
  // Set before the element is in the document, which is the order every parent in the editor sets
  // it in and the one the first render assumes.
  Object.assign(toast, { ctx });
  stage.append(toast);

  mounted.push({ store, stage });
  // The shadow root is there from the moment the element connects and the render fills it after,
  // so anything read before this is read too early.
  await (toast as StencilElement).componentOnReady?.();
  return { store, toast, stage };
}

function pill(toast: HTMLElement): HTMLElement | null {
  return toast.shadowRoot?.querySelector<HTMLElement>('.pill') ?? null;
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) await new Promise((resolve) => requestAnimationFrame(resolve));
}

async function shown(toast: HTMLElement, text: string): Promise<HTMLElement> {
  await until(`"${text}"`, () => pill(toast)?.textContent === text);
  return pill(toast)!;
}

afterEach(() => {
  for (const { store, stage } of mounted.splice(0)) {
    store.dispose();
    stage.remove();
  }
});

describe('ve-toast', () => {
  it('holds the live region open while it has nothing to say', async () => {
    const { toast } = await mount();

    expect(toast.getAttribute('role')).toBe('status');
    expect(toast.getAttribute('aria-live')).toBe('polite');
    expect(pill(toast)).toBe(null);
  });

  it('paints a message written to the store after it had rendered', async () => {
    const { store, toast } = await mount();
    expect(pill(toast)).toBe(null);

    store.showToast('Original sound off');

    const shownPill = await shown(toast, 'Original sound off');
    expect(shownPill.isConnected).toBe(true);
  });

  it('replaces the element for a second message, so the slide plays again', async () => {
    const { store, toast } = await mount();
    store.showToast('Undo: Add text');
    const first = await shown(toast, 'Undo: Add text');

    store.showToast('Redo: Add text');
    const second = await shown(toast, 'Redo: Add text');

    // A new element is what replays a CSS animation. Two identical sentences in a row would look
    // like no change at all to the vdom without the id the store keeps.
    expect(second).not.toBe(first);
    expect(first.isConnected).toBe(false);
  });

  it('goes when the store says so, holding no clock of its own', async () => {
    const { store, toast } = await mount();
    store.showToast('Stop recording first', 120);
    await shown(toast, 'Stop recording first');

    await until('the message to go', () => pill(toast) === null);
  });

  it('keeps a long message on one line, which is why it is centred with auto margins', async () => {
    const { store, toast, stage } = await mount();
    store.showToast(`You can add up to ${MAX_LAYERS} layers`);
    const box = (await shown(toast, `You can add up to ${MAX_LAYERS} layers`)).getBoundingClientRect();
    const room = stage.getBoundingClientRect();

    // Wider than half the stage and still one line, which is the pair a `left: 50%` and a translate
    // could not give: that box only had the room to the right of its left edge to size itself into,
    // so this message wrapped there however much room the stage really had.
    expect(box.width).toBeGreaterThan(STAGE_WIDTH / 2);
    expect(box.height).toBeLessThan(50);
    expect(Math.abs(box.left - room.left - (room.right - box.right))).toBeLessThan(1);
  });

  it('keeps the longest message inside the stage, padding and all', async () => {
    const { store, toast, stage } = await mount();
    const longest = "That audio file can't be used. Try an MP3 or M4A.";
    store.showToast(longest, 2400);
    const box = (await shown(toast, longest)).getBoundingClientRect();
    const room = stage.getBoundingClientRect();

    // 24px of stage either side, measured over the painted box rather than its content: without
    // `box-sizing: border-box` the padding sits outside the max-width and eats 16px of each margin.
    expect(box.width).toBeLessThanOrEqual(STAGE_WIDTH - 48);
    expect(box.left - room.left).toBeGreaterThanOrEqual(24);
    expect(Math.abs(box.left - room.left - (room.right - box.right))).toBeLessThan(1);
  });

  it('lets a tap through to the video under it', async () => {
    const { store, toast, stage } = await mount();
    const video = document.createElement('div');
    video.style.cssText = 'position: absolute; inset: 0';
    stage.prepend(video);

    store.showToast('Hold a clip to move it', 2200);
    const box = (await shown(toast, 'Hold a clip to move it')).getBoundingClientRect();

    expect(document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)).toBe(video);
  });

  it('paints nothing more once it is out of the document', async () => {
    const { store, toast } = await mount();
    store.showToast('Already on top');
    await shown(toast, 'Already on top');

    toast.remove();
    store.showToast('Already at the bottom');
    await frames(3);

    // Still the message it painted last. An element out of the document has dropped its watcher in
    // `disconnectedCallback`, so the write reaches nothing: no repaint, and no store held alive by
    // an effect belonging to an element nobody can see.
    expect(pill(toast)?.textContent).toBe('Already on top');
  });
});
