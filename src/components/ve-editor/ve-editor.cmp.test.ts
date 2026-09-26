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

async function mount(host: VideoEditorHost = HOST, screen = SCREEN, post: EditManifest = manifest()): Promise<{ editor: HTMLElement; window: DOMRect }> {
  /* The WebView's own window, which is what the editor is told to be the height of. */
  const column = document.createElement('div');
  column.style.cssText = `width: ${screen.width}px; height: ${screen.height}px`;
  document.body.append(column);

  const editor = document.createElement('ve-editor');
  Object.assign(editor, { sources: SOURCES, manifest: post, host });
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
  let renders = 0;
  let settle: { resolve: (video: EditorSource) => void; reject: (error: unknown) => void } | null = null;
  const render: EditorRenderHost = {
    isSupported: async () => true,
    render: received =>
      new Promise<EditorSource>((resolve, reject) => {
        request = received;
        renders++;
        settle = { resolve, reject };
      }),
  };
  return {
    host: { ...HOST, render } as VideoEditorHost,
    started: () => request !== null,
    request: () => request,
    renders: () => renders,
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

  it('asks for no size ceiling on behalf of a host that set none', async () => {
    const { held } = await exporting();

    expect(held.request()).not.toHaveProperty('maxBytes');
  });
});

/*
 * A host's upload limit. The editor hands it to the render, which is what holds the file to it, and
 * a render that passes it comes back `too_large` - which the customer is told as a video too big to
 * post, with the edit itself as the way out, because trying again builds the same file.
 */
describe("ve-editor under a host's size ceiling", () => {
  const MAX_BYTES = 100 * 1024 * 1024;

  async function exportingUnderCeiling() {
    const held = heldRender();
    const { editor } = await mount({ ...held.host, output: { maxBytes: MAX_BYTES } });
    inside<HTMLButtonElement>(editor, '.ve__round--next')!.click();
    await until('the render to start', held.started);
    return { editor, held };
  }

  it("hands the host's ceiling to the render, for the spec it builds", async () => {
    const { held } = await exportingUnderCeiling();

    expect(held.request()?.maxBytes).toBe(MAX_BYTES);
  });

  it('says a video past the ceiling is too big to post, and goes back to the edit rather than retry', async () => {
    const { editor, held } = await exportingUnderCeiling();

    // As a host's own copy of the class arrives: another bundle's error, of which only the name and
    // the code survive.
    held.fail(Object.assign(new Error(`too_large max=${MAX_BYTES} bytes=${MAX_BYTES + 1}`), { name: 'RenderFailedError', code: 'too_large' }));
    await until('the question about the file', () => !!inside(editor, 've-alert'));

    const alert = inside(editor, 've-alert') as HTMLElement & { message: string };
    expect(alert.getAttribute('message') ?? alert.message).toContain('This video is too big to post.');

    const buttons = [...(alert.shadowRoot?.querySelectorAll('button') ?? [])];
    buttons.find(button => button.textContent?.includes('Keep editing'))!.click();
    await until('the question to go', () => !inside(editor, 've-alert'));

    expect(held.renders()).toBe(1);
    expect(inside(editor, '.ve__export')).toBeNull();
    expect(inside(editor, 've-toolbar')).not.toBeNull();
  });
});

/*
 * What the render draws its layers with. Only the editor's bundle can make it - the sticker URLs in
 * it resolve against the Stencil runtime the editor was loaded with, which the render host at the
 * package root has none of - so the editor hands it over, and a render passes it on as it comes.
 * A context on the wrong frame draws every layer at the wrong pixel size: a 1080p post's caption
 * drawn for 720p and burned in soft.
 */
describe('ve-editor hands its render the raster context', () => {
  it("makes it for the frame the post renders at, with the host's own fileUrl", async () => {
    const held = heldRender();
    const fileUrl = (uri: string) => `https://localhost/_capacitor_file_${uri}`;
    const output = { width: 1080, height: 1920, fps: 30 };
    const { editor } = await mount({ ...held.host, platform: { ...HOST.platform, fileUrl } }, SCREEN, { ...manifest(), output });
    inside<HTMLButtonElement>(editor, '.ve__round--next')!.click();
    await until('the render to start', held.started);

    const { manifest: rendered, raster } = held.request()!;
    expect(rendered.output).toEqual(output);
    expect(raster.output).toEqual(output);
    expect(raster.fileUrl).toBe(fileUrl);
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

  /*
   * The trade the tool row made: its tiles came down from 80px to 52 so that the layers would have
   * the room, and the timeline is the only thing that got it. Two stylesheets hold the two halves
   * (the row's height in ve-toolbar.css, the timeline's `+ 36px` in ve-editor.css), and a change to
   * one of them alone breaks nothing that throws: the stage quietly takes the difference and every
   * row of the timeline moves, which is what the device scripts tap by position.
   */
  it('gives the layers the height the tool row gave up, and the video none of it', async () => {
    const { editor } = await mount();
    const toolbar = inside(editor, 've-toolbar')!;
    const timeline = inside(editor, 've-timeline')!;
    await (toolbar as StencilElement).componentOnReady?.();

    const row = toolbar.getBoundingClientRect();
    const lanes = timeline.getBoundingClientRect();
    const tile = toolbar.shadowRoot!.querySelector('.tile')!.getBoundingClientRect();
    // `vh` is the browser's window, not the column the editor was mounted in.
    const before = Math.min(250, globalThis.innerHeight * 0.31);

    expect(tile.height).toBe(52);
    // 4 + 52 + 4, over the home indicator's strip.
    expect(row.height).toBe(60 + SAFE_BOTTOM);
    expect(lanes.height).toBeCloseTo(before + 36, 1);
    expect(lanes.bottom).toBeCloseTo(row.top, 1);
    // What the two of them took before the change, to the pixel: the stage above is untouched.
    expect(lanes.height + row.height).toBeCloseTo(before + 96 + SAFE_BOTTOM, 1);
  });

  /*
   * The column never scrolls, so on a window too short for everything in it - a phone on its side,
   * a split screen - something has to give. It used to be the tool row, cut off by the bottom of the
   * screen with its labels gone; it is the timeline now, whose lanes pan anyway.
   */
  it('lets the timeline give way on a short window rather than cut off the tools', async () => {
    const { editor, window } = await mount(HOST, { width: SCREEN.width, height: 480 });
    const toolbar = inside(editor, 've-toolbar')!;
    await (toolbar as StencilElement).componentOnReady?.();

    const tiles = [...toolbar.shadowRoot!.querySelectorAll('.tile')].map(tile => tile.getBoundingClientRect());
    const timeline = inside(editor, 've-timeline')!.getBoundingClientRect();
    const stage = inside(editor, '.ve__stage')!.getBoundingClientRect();

    expect(tiles.length).toBeGreaterThan(0);
    for (const tile of tiles) {
      expect(tile.height).toBe(52);
      expect(tile.bottom).toBeLessThanOrEqual(window.bottom - SAFE_BOTTOM + 0.5);
    }
    expect(timeline.height).toBeLessThan(Math.min(250, globalThis.innerHeight * 0.31) + 36);
    expect(stage.height).toBeGreaterThanOrEqual(120);
  });

  it('never gives the timeline less than its ruler and base track', async () => {
    // Too short for even that: 59 + 130 + 52 + 94 leaves 65 of 400.
    const { editor } = await mount(HOST, { width: SCREEN.width, height: 400 });
    // The tool row's height is what the timeline gives way to, and it has none until it has drawn.
    await (inside(editor, 've-toolbar') as StencilElement).componentOnReady?.();

    expect(inside(editor, 've-timeline')!.getBoundingClientRect().height).toBe(90);
  });

  /*
   * The trade above, on a WebView too old for container queries (Chrome 104 and before, which is
   * what an A13 ships with). There `container-type` is ignored, the stage's content counts toward
   * its flex basis, and that content is the whole preview frame: the column overflowed, the stage
   * and the timeline shared the shrink, and the video took back most of what the tool row gave up.
   * The browser these tests run in has container queries, so what such an engine sees is put in by
   * hand - no containment, and a frame far taller than the stage - and nothing may move.
   */
  it('keeps the same layout on a WebView without container queries', async () => {
    const { editor } = await mount();
    await (inside(editor, 've-toolbar') as StencilElement).componentOnReady?.();
    const layout = () => ['.ve__stage', 've-timeline', 've-toolbar'].map(selector => inside(editor, selector)!.getBoundingClientRect().toJSON());
    const modern = layout();

    const old = document.createElement('style');
    // `!important` because the component's own sheets are adopted, and those come after this one.
    old.textContent = '.ve__stage { container-type: normal !important } .ve__stage::before { content: ""; display: block; height: 900px }';
    editor.shadowRoot!.append(old);

    expect(layout()).toEqual(modern);
  });
});

/*
 * Zoom on a host that does not offer it, through the element a host actually places: `editing.zoom`
 * goes in on `host` and nowhere else. What goes is every way to put a NEW zoom in. A zoom the post
 * already has - a draft from before the host turned it off, a manifest built elsewhere - is still on
 * the timeline and still the customer's to change or take out, because hiding it would leave a
 * camera move in the preview that nothing on screen can reach.
 */
describe('ve-editor on a host that does not offer Zoom', () => {
  const NO_ZOOM: VideoEditorHost = { ...HOST, editing: { zoom: false } };

  /** `manifest()` with a 2.0x zoom over its first two and a half seconds. */
  function zoomed(): EditManifest {
    return { ...manifest(), zooms: [{ id: 'zm-1', startMs: 500, endMs: 3000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 400, ease: 'smooth' }] };
  }

  function toolIds(editor: HTMLElement): string[] {
    const tiles = inside(editor, 've-toolbar')?.shadowRoot?.querySelectorAll<HTMLButtonElement>('.tb__track .tile') ?? [];
    return [...tiles].map(tile => tile.dataset.tile!);
  }

  function zoomBar(editor: HTMLElement): HTMLButtonElement | null {
    return inside(editor, 've-timeline')?.shadowRoot?.querySelector<HTMLButtonElement>('[data-row="zoom"] .item--zoom') ?? null;
  }

  it('leaves Zoom off the tool row, where a host that says nothing keeps it beside Crop', async () => {
    const on = await mount();
    await until('the tool row', () => toolIds(on.editor).length > 0);
    expect(toolIds(on.editor).slice(0, 4)).toEqual(['edit', 'crop', 'zoom', 'layout']);

    const off = await mount(NO_ZOOM);
    await until('the tool row', () => toolIds(off.editor).length > 0);
    expect(toolIds(off.editor)).toEqual(toolIds(on.editor).filter(id => id !== 'zoom'));
  });

  it('still shows a zoom the post already has, and lets it be changed, deleted and brought back', async () => {
    const { editor } = await mount(NO_ZOOM, SCREEN, zoomed());
    const changes: EditManifest[] = [];
    editor.addEventListener('veChange', event => changes.push((event as CustomEvent).detail.manifest));

    await until('the zoom on the timeline', () => !!zoomBar(editor));
    expect(zoomBar(editor)!.getAttribute('aria-label')).toBe('Zoom 2.0x');

    // A tap opens it in its sheet, and the sheet still changes it.
    zoomBar(editor)!.click();
    await until('the zoom sheet', () => !!inside(editor, 've-zoom-sheet'));
    const sheet = inside(editor, 've-zoom-sheet')!;
    await (sheet as StencilElement).componentOnReady?.();
    await until('the sheet to draw its chips', () => !!sheet.shadowRoot?.querySelector('[data-ease="snappy"]'));
    sheet.shadowRoot!.querySelector<HTMLButtonElement>('[data-ease="snappy"]')!.click();
    await until('the change to be filed', () => changes.at(-1)?.zooms[0]?.ease === 'snappy');

    // Done leaves it selected, on its own row: Edit and Delete, and no Duplicate to add a second.
    sheet.shadowRoot!.querySelector('ve-sheet')!.shadowRoot!.querySelector<HTMLButtonElement>('[aria-label="Done"]')!.click();
    await until('the zoom row', () => toolIds(editor).includes('delete'));
    expect(toolIds(editor)).toEqual(['edit', 'delete']);

    inside(editor, 've-toolbar')!.shadowRoot!.querySelector<HTMLButtonElement>('[data-tile="delete"]')!.click();
    await until('the zoom to go', () => !zoomBar(editor));
    expect(changes.at(-1)!.zooms).toEqual([]);

    inside<HTMLButtonElement>(editor, '[aria-label="Undo"]')!.click();
    await until('the zoom to come back', () => !!zoomBar(editor));
    expect(changes.at(-1)!.zooms).toMatchObject([{ id: 'zm-1', ease: 'snappy', startMs: 500, endMs: 3000 }]);
  });
});
