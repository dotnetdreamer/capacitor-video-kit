import { afterEach, describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest } from '../../editor';
import type { EditorRenderHost, EditorSource, RenderRequest, VideoEditorHost } from '../../host/host.types';

/*
 * A browser rather than the mock DOM, because what is pinned here is a MEASUREMENT: where the bottom
 * of the editor's column lands on a phone whose bars the host has measured.
 *
 * The bug: the column is `height: 100%` with the status bar's inset as padding on top, and in the
 * default box a padding is added to a height rather than taken out of it. On a phone with a 59px top
 * inset the editor was therefore 59px taller than the window, and a column that never scrolls simply
 * puts what does not fit where nothing can reach it. The toolbar's labels were cut off by the edge of
 * the screen, and the layout sheet's last row - Swap and Remove - sat half under it and could not be
 * tapped, while every rule inside that reserves the home indicator's strip did its job perfectly on a
 * box that was already too long.
 */

/** An iPhone 17 Pro's window and bars in CSS pixels, which is the phone this was reported on. */
const SCREEN = { width: 402, height: 874 };
const SAFE_TOP = 59;
const SAFE_BOTTOM = 34;

/** What every element in the editor is handed, and the only honest wait for a first paint. */
type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

const mounted: HTMLElement[] = [];

const SOURCES: EditorSource[] = [
  { key: 'clip-a', fileName: 'a.mp4' },
  { key: 'clip-b', fileName: 'b.mp4' },
];

/**
 * A host that answers the two things this test needs and nothing else: how long a source is, since
 * there is no file to measure, and what the bars cover, which is the whole point.
 */
const HOST: VideoEditorHost = {
  media: {
    pickVideo: async () => null,
    pickImage: async () => null,
    pickAudio: async () => null,
    probeDuration: async () => 5000,
    thumbnails: async () => [],
  },
  platform: {
    measureInsets: async () => ({ top: SAFE_TOP, bottom: SAFE_BOTTOM }),
  },
};

/** Two videos on the frame, so the Layout tool opens its sheet rather than a picker. */
function manifest(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [defaultClipEdit('clip-a', 5000, 'seg-a')],
    videoTracks: [{ id: 'track-1', clips: [defaultClipEdit('clip-b', 4000, 'seg-b')], startMs: 0, z: 1, opacity: 1 }],
  };
}

async function mount(host: VideoEditorHost = HOST): Promise<{ editor: HTMLElement; window: DOMRect }> {
  /* The WebView's own window, which is what the editor is told to be the height of. */
  const column = document.createElement('div');
  column.style.cssText = `width: ${SCREEN.width}px; height: ${SCREEN.height}px`;
  document.body.append(column);

  const editor = document.createElement('ve-editor');
  Object.assign(editor, { sources: SOURCES, manifest: manifest(), host });
  column.append(editor);

  mounted.push(column);
  await (editor as StencilElement).componentOnReady?.();
  await until('the editor to finish loading its sources', () => !!inside(editor, 've-toolbar'));
  await until('the measured insets to land', () => editor.style.getPropertyValue('--ve-safe-top') === `${SAFE_TOP}px`);
  return { editor, window: column.getBoundingClientRect() };
}

function inside<T extends HTMLElement>(editor: HTMLElement, selector: string): T | null {
  return editor.shadowRoot?.querySelector<T>(selector) ?? null;
}

/** Polls a frame at a time, because a repaint is Stencil's to schedule and not ours to await. */
async function until(what: string, ready: () => boolean, ms = 4000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

afterEach(() => {
  for (const column of mounted.splice(0)) column.remove();
});

/*
 * What a host that cannot render is told, and what it is NOT told silently.
 *
 * The bug: the editor finished on the spot when its host answered `isSupported()` false, handing
 * back a manifest and no video. The app's upload flow then takes the first clip as the post's own,
 * so a two layer post was published as whichever raw clip happened to be first, with the other one
 * filed beside it as a source - and nobody was asked or told anything at any point.
 *
 * `HOST` has no `render` at all, which is exactly that case, and `manifest()` is two videos on the
 * frame, which is a post no single clip of it can stand in for.
 */
describe('ve-editor with nothing to render on', () => {
  it('asks before posting an edit it cannot build, rather than finishing silently', async () => {
    const { editor } = await mount();
    const done: CustomEvent[] = [];
    editor.addEventListener('veDone', event => done.push(event as CustomEvent));

    inside<HTMLButtonElement>(editor, '.ve__round--next')!.click();
    await until('the question about the missing renderer', () => !!inside(editor, 've-alert'));

    const alert = inside(editor, 've-alert')!;
    expect(alert.getAttribute('header') ?? (alert as unknown as { header: string }).header).toContain('Can’t build your video');
    // Still in the editor: nothing has been handed back while the question is on screen.
    expect(done.length).toBe(0);
  });

  it('posts the clips unedited once that has been chosen, and says so by sending no video', async () => {
    const { editor } = await mount();
    const done: CustomEvent[] = [];
    editor.addEventListener('veDone', event => done.push(event as CustomEvent));

    inside<HTMLButtonElement>(editor, '.ve__round--next')!.click();
    await until('the question about the missing renderer', () => !!inside(editor, 've-alert'));

    const buttons = [...(inside(editor, 've-alert')!.shadowRoot?.querySelectorAll('button') ?? [])];
    buttons.find(button => button.textContent?.includes('Post without edits'))!.click();
    await until('the editor to finish', () => done.length > 0);

    // No `stitched`: the host is told in the only way that matters that what it has is the clips,
    // not the edit. What it must never get is a rendered-looking answer that is one of the clips.
    expect(done[0].detail.stitched).toBeUndefined();
    expect(done[0].detail.manifest.videoTracks.length).toBe(1);
  });

  it('keeps the editor exactly as it was when the question is declined', async () => {
    const { editor } = await mount();
    const done: CustomEvent[] = [];
    editor.addEventListener('veDone', event => done.push(event as CustomEvent));

    inside<HTMLButtonElement>(editor, '.ve__round--next')!.click();
    await until('the question about the missing renderer', () => !!inside(editor, 've-alert'));

    const buttons = [...(inside(editor, 've-alert')!.shadowRoot?.querySelectorAll('button') ?? [])];
    buttons.find(button => button.textContent?.includes('Keep editing'))!.click();
    await until('the question to go', () => !inside(editor, 've-alert'));

    expect(done.length).toBe(0);
    expect(inside(editor, 've-toolbar')).not.toBeNull();
  });
});

/**
 * A render the test holds open: it reports whatever progress it is told to, and finishes, fails or
 * stays pending until it is told otherwise - which is how a real encode looks from here.
 */
function heldRender() {
  let request: RenderRequest | null = null;
  let settle: { resolve: (video: EditorSource) => void; reject: (error: unknown) => void } | null = null;
  const render: EditorRenderHost = {
    isSupported: async () => true,
    render: received =>
      new Promise<EditorSource>((resolve, reject) => {
        request = received;
        settle = { resolve, reject };
      }),
  };
  return {
    host: { ...HOST, render } as VideoEditorHost,
    started: () => request !== null,
    report: (progress: number) => request!.onProgress(progress),
    aborted: () => request!.signal.aborted,
    finish: (video: EditorSource) => settle!.resolve(video),
    fail: (error: unknown) => settle!.reject(error),
  };
}

/*
 * The export screen: a still of the post with the figure on it, and a wash over the part still to
 * be built that draws back as the figure climbs. Its arrow is the way out of a render, and the way
 * out has to leave the edit exactly as it was.
 */
describe('ve-editor while the video is built', () => {
  const RENDERED: EditorSource = { key: 'edited', fileName: 'edited.mp4' };

  async function exporting() {
    const held = heldRender();
    const { editor } = await mount(held.host);
    const done: CustomEvent[] = [];
    editor.addEventListener('veDone', event => done.push(event as CustomEvent));
    inside<HTMLButtonElement>(editor, '.ve__round--next')!.click();
    await until('the render to start', held.started);
    await until('the export screen', () => !!inside(editor, '.ve__export'));
    return { editor, held, done };
  }

  it('shows the figure on the still, and washes out only what is still to come', async () => {
    const { editor, held } = await exporting();

    held.report(0.4);
    await until('the figure to move', () => inside(editor, '.ve__export-pct')?.textContent === '40%');

    const bar = inside(editor, '.ve__export-still')!;
    expect(bar.getAttribute('role')).toBe('progressbar');
    expect(bar.getAttribute('aria-valuenow')).toBe('40');
    // Sixty per cent of the still is left to build, so sixty per cent of it is under the wash.
    expect(inside<HTMLElement>(editor, '.ve__export-wash')!.style.transform).toBe('scaleX(0.6)');
    // The editor is still there under it, hidden rather than gone.
    expect(inside(editor, '.ve')!.getAttribute('aria-hidden')).toBe('true');
    expect(inside(editor, 've-toolbar')).not.toBeNull();
    // And the focus came with the screen. Left on Next, Chrome refuses the `aria-hidden` above and
    // keeps the whole editor in the accessibility tree.
    expect(editor.shadowRoot!.activeElement).toBe(bar);
  });

  it('calls the render off from its arrow and goes back to the edit, asking nothing', async () => {
    const { editor, held, done } = await exporting();

    inside<HTMLButtonElement>(editor, '.ve__export-back')!.click();
    await until('the export screen to go', () => !inside(editor, '.ve__export'));

    expect(held.aborted()).toBe(true);
    expect(inside(editor, '.ve')!.hasAttribute('aria-hidden')).toBe(false);
    expect(inside(editor, 've-toolbar')).not.toBeNull();
    // Back on the button that started it, rather than nowhere.
    await until('the focus to return to Next', () => editor.shadowRoot!.activeElement === inside(editor, '.ve__round--next'));

    // The host settling afterwards - a file it finished anyway, or a failure for the cancel - is
    // not news to somebody already back in the edit: no video handed over, and no question.
    held.fail(new Error('cancelled'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(done.length).toBe(0);
    expect(inside(editor, 've-alert')).toBeNull();
  });

  it('ignores a file that lands after the render was called off', async () => {
    const { editor, held, done } = await exporting();

    inside<HTMLButtonElement>(editor, '.ve__export-back')!.click();
    await until('the export screen to go', () => !inside(editor, '.ve__export'));
    held.finish(RENDERED);
    await new Promise(resolve => setTimeout(resolve, 50));

    expect(done.length).toBe(0);
  });

  it('hands the finished video over when the render completes', async () => {
    const { held, done } = await exporting();

    held.finish(RENDERED);
    await until('the editor to finish', () => done.length > 0);

    expect(done[0].detail.stitched).toBe(RENDERED);
  });
});

describe('ve-editor fits the window it is given', () => {
  it('keeps its column inside the window once the status bar has been measured', async () => {
    const { editor, window } = await mount();
    const column = inside(editor, '.ve')!;

    const box = column.getBoundingClientRect();
    // The inset is INSIDE the height. Anything else is a column longer than the screen, and the
    // overflow is at the bottom, where the tools are.
    expect(Math.round(box.height)).toBe(SCREEN.height);
    expect(box.bottom).toBeLessThanOrEqual(window.bottom + 0.5);
  });

  it('keeps the layout sheet clear of the home indicator, Swap and Remove included', async () => {
    const { editor, window } = await mount();
    const toolbar = inside(editor, 've-toolbar')!;
    await (toolbar as StencilElement).componentOnReady?.();

    toolbar.shadowRoot!.querySelector<HTMLButtonElement>('[data-tile="layout"]')!.click();

    await until('the layout sheet to open', () => !!inside(editor, 've-layout-sheet'));
    const sheet = inside(editor, 've-layout-sheet')!;
    await (sheet as StencilElement).componentOnReady?.();
    await until('the sheet to draw its actions', () => !!sheet.shadowRoot?.querySelector('.ls__action'));

    const actions = [...sheet.shadowRoot!.querySelectorAll<HTMLButtonElement>('.ls__action')];
    expect(actions.map(button => button.textContent?.trim())).toEqual(['Swap', 'Remove']);
    for (const button of actions) {
      const box = button.getBoundingClientRect();
      expect(box.height).toBeGreaterThan(0);
      // Above the home indicator's strip, which is the only part of the sheet a finger cannot use.
      expect(box.bottom).toBeLessThanOrEqual(window.bottom - SAFE_BOTTOM + 0.5);
    }
  });
});
