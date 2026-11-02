import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { emptyManifest, type EditManifest, type EditOverlay, type EditTrack, type OverlayFollow } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because one of the sheet's promises is about laid out boxes: it
 * keeps one height whatever it shows, so the picture the box is dragged on does not move under the
 * finger. The rest is what each of its five faces says and what each control asks the store for.
 *
 * The store's own tracking - runs, pins, fixes - is its unit test's business, so the controls that set
 * one off are answered here by stand-ins that note what they were asked; the ones that only write a field
 * of the manifest (the name) go through the real store.
 */

const mounted: { store: EditorStore; media: EditorMedia; column: HTMLElement }[] = [];

type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

/** A track over the clip's first five seconds, a sample a second. */
function track(over: Partial<EditTrack> = {}): EditTrack {
  return {
    id: 'trk-a',
    name: 'Runner',
    hue: 1,
    clipId: 'seg-a',
    clipKey: 'clip-a',
    aspect: 9 / 16,
    box: { w: 0.2, h: 0.1 },
    atMs: [0, 1000, 2000, 3000, 4000, 5000],
    x: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    y: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
    scale: [1, 1, 1, 1, 1, 1],
    turn: [0, 0, 0, 0, 0, 0],
    ...over,
  };
}

const FOLLOWING: OverlayFollow = { trackId: 'trk-a', pin: { atMs: 0, dx: 0, dy: -0.1 } };

function caption(follow?: OverlayFollow): EditOverlay {
  return {
    id: 't',
    kind: 'text',
    text: 'Runner',
    styleId: 'classic',
    color: '#ffffff',
    effect: 'shadow',
    align: 'center',
    cx: 0.5,
    cy: 0.4,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 0,
    endMs: 6000,
    ...(follow ? { follow } : {}),
  } as EditOverlay;
}

function manifest(tracks: EditTrack[], overlays: EditOverlay[]): EditManifest {
  return {
    ...emptyManifest(),
    clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 10_000, speed: 1, volume: 1, muted: false }],
    overlays,
    ...(tracks.length > 0 ? { tracks } : {}),
  };
}

/** The ways in: the main row's Track tool, a layer's Track tool, and a track's own row. */
const openNew = (store: EditorStore) => store.openNewTrack();
const openOnLayer = (store: EditorStore) => {
  store.select({ kind: 'overlay', id: 't' });
  store.openTrack();
};
const openOnTrack = (store: EditorStore) => store.openTrackSheet('trk-a');

/** The sheet over a store holding `m`, opened by `open`, in the A13's editor column at the compact sheet's cap. */
async function mount(m: EditManifest, open: (store: EditorStore) => void): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const host = resolveEditorHost({});
  const store = new EditorStore(host);
  const media = new EditorMedia(store, host);
  const ctx: EditorContext = { store, media };
  store.load([{ key: 'clip-a', fileName: 'a.mp4' }], new Map([['clip-a', 10_000]]), m);
  open(store);

  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 340px; display: flex; flex-direction: column';
  document.body.append(column);
  mounted.push({ store, media, column });

  const sheet = document.createElement('ve-track-sheet');
  Object.assign(sheet, { ctx });
  column.append(sheet);
  await (sheet as StencilElement).componentOnReady?.();
  await (frame(sheet) as StencilElement | null)?.componentOnReady?.();
  return { store, sheet };
}

function frame(sheet: HTMLElement): HTMLElement | null {
  return sheet.shadowRoot?.querySelector('ve-sheet') ?? null;
}

function head(sheet: HTMLElement, selector: string): HTMLElement | null {
  return frame(sheet)?.shadowRoot?.querySelector<HTMLElement>(selector) ?? null;
}

function el<T extends HTMLElement = HTMLElement>(sheet: HTMLElement, selector: string): T | null {
  return sheet.shadowRoot?.querySelector<T>(selector) ?? null;
}

function text(sheet: HTMLElement, selector: string): string | null {
  return el(sheet, selector)?.textContent?.trim() ?? null;
}

/** Every button in the sheet's body by what it is called: its label, or its own words. */
function button(sheet: HTMLElement, name: string): HTMLButtonElement | null {
  const all = Array.from(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  return all.find(b => (b.getAttribute('aria-label') ?? b.textContent?.trim()) === name) ?? null;
}

/** The sheet's height as the editor's column gives it room: the frame's head and the body. */
function height(sheet: HTMLElement): number {
  const body = el(sheet, '.tk')!;
  const headEl = frame(sheet)!.shadowRoot!.querySelector<HTMLElement>('.sheet__head');
  return body.getBoundingClientRect().height + (headEl?.getBoundingClientRect().height ?? 53);
}

async function until(what: string, ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = performance.now() + ms;
  while (!ready()) {
    if (performance.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise(resolve => requestAnimationFrame(resolve));
  }
}

afterEach(() => {
  for (const { store, media, column } of mounted.splice(0)) {
    media.dispose();
    store.dispose();
    column.remove();
  }
});

describe('ve-track-sheet', () => {
  it('aims a new track: one line, the people finder, and Track', async () => {
    const { store, sheet } = await mount(manifest([], []), openNew);
    let started = 0;
    let looked = 0;
    store.startTracking = async () => {
      started++;
    };
    store.findTrackPeople = () => {
      looked++;
    };

    expect(head(sheet, '.sheet__title')?.textContent).toBe('Track');
    expect(text(sheet, '.tk__hint')).toBe('Tap what to follow, or drag a box');
    expect(head(sheet, '.sheet__icon-btn--dim')).toBe(null);
    expect(el(sheet, '.tk__head')).toBe(null);

    button(sheet, 'Track')!.click();
    expect(started).toBe(1);
    button(sheet, 'Find people')!.click();
    expect(looked).toBe(1);

    store.trackPeople.value = 'finding';
    await until('the looking', () => text(sheet, '.tk__note') === 'Finding people...');
    expect(button(sheet, 'Find people')).toBe(null);
    store.trackPeople.value = 'ready';
    await until('the people', () => text(sheet, '.tk__note') === 'Tap a person to follow');
    store.trackPeople.value = 'none';
    await until('nobody', () => text(sheet, '.tk__note') === 'No people found');
    store.trackPeople.value = 'unavailable';
    await until('no line at all', () => el(sheet, '.tk__people') === null);
  });

  it('asks a layer that follows nothing which track to follow, or for a new one', async () => {
    const { store, sheet } = await mount(manifest([track(), track({ id: 'trk-b', name: 'Ball', hue: 2 })], [caption()]), openOnLayer);
    const chosen: (string | null)[] = [];
    store.chooseTrack = trackId => {
      chosen.push(trackId);
    };

    expect(store.trackChoosing.value).toBe(true);
    expect(text(sheet, '.tk__hint')).toBe('Pick what the text follows');
    expect(Array.from(sheet.shadowRoot!.querySelectorAll('.tk__chips .tk__chip')).map(chip => chip.textContent!.trim())).toEqual(['Runner', 'Ball', 'New track']);
    expect(el(sheet, '[data-track="trk-b"]')!.style.getPropertyValue('--tk-hue')).toBe('var(--ve-track-2)');
    expect(head(sheet, '.sheet__icon-btn--dim')).toBe(null);

    el(sheet, '[data-track="trk-b"]')!.click();
    button(sheet, 'New track')!.click();
    expect(chosen).toEqual(['trk-b', null]);
  });

  it('says how far a run has got, on a bar in the track colour for a fix, and stops it', async () => {
    const { store, sheet } = await mount(manifest([track()], []), openNew);
    let stopped = 0;
    store.stopTracking = () => {
      stopped++;
    };

    store.trackRun.value = { trackId: null, overlayId: null, clipId: 'seg-a', clipKey: 'clip-a', outputMs: 0, mode: 'new', progress: 0.42 };
    await until('the run', () => text(sheet, '.tk__status') === 'Tracking 42%');
    expect(el(sheet, '[role="progressbar"]')!.getAttribute('aria-valuenow')).toBe('42');
    expect(el(sheet, '.tk__bar--fix')).toBe(null);
    expect(head(sheet, '.sheet__icon-btn--dim')).toBe(null);
    button(sheet, 'Stop')!.click();
    expect(stopped).toBe(1);

    store.trackRun.value = null;
    store.openTrackSheet('trk-a');
    store.trackRun.value = { trackId: 'trk-a', overlayId: null, clipId: 'seg-a', clipKey: 'clip-a', outputMs: 2000, mode: 'fix', progress: 0.5 };
    await until('the fix', () => text(sheet, '.tk__status') === 'Tracking 50%');
    expect(el(sheet, '.tk__bar--fix')).not.toBe(null);
    expect(el(sheet, '.tk')!.style.getPropertyValue('--tk-hue')).toBe('var(--ve-track-1)');
    // The name over the run is words, not a way to rename the track part way through.
    expect(text(sheet, '.tk__name')).toBe('Runner');
    expect(el(sheet, 'button.tk__name')).toBe(null);
  });

  it('says how sure the track is, and takes the playhead to the next spot to check', async () => {
    const sure = await mount(manifest([track()], []), openOnTrack);
    expect(text(sure.sheet, '.tk__health')).toBe('Sure the whole way');
    expect(button(sure.sheet, 'Next spot')).toBe(null);

    const one = await mount(manifest([track({ sure: [100, 100, 20, 20, 100, 100] })], []), openOnTrack);
    expect(text(one.sheet, '.tk__health')).toBe('1 spot to check');

    const two = await mount(manifest([track({ sure: [100, 20, 100, 100, 20, 100] })], []), openOnTrack);
    const asked: string[] = [];
    two.store.fixNextSpot = trackId => {
      asked.push(trackId);
    };
    expect(text(two.sheet, '.tk__health')).toBe('2 spots to check');
    button(two.sheet, 'Next spot')!.click();
    expect(asked).toEqual(['trk-a']);
  });

  it('on a layer that follows the track: Smooth, Follow with switches that say they are on, and Remove tracking', async () => {
    const { store, sheet } = await mount(manifest([track()], [caption({ ...FOLLOWING, scaleWith: true })]), openOnLayer);
    const asked: { scaleWith?: boolean; turnWith?: boolean }[] = [];
    store.setTrackFollow = patch => {
      asked.push(patch);
    };
    let unpinned = 0;
    store.unpinLayer = () => {
      unpinned++;
    };

    expect(button(sheet, 'Rename Runner')).not.toBe(null);
    expect(text(sheet, '[data-readout="smooth"]')).toBe('30%');
    expect(Array.from(sheet.shadowRoot!.querySelectorAll('.tk__word')).map(word => word.textContent)).toEqual(['Smooth', 'Follow']);
    expect(Array.from(sheet.shadowRoot!.querySelectorAll('[role="switch"]')).map(chip => chip.getAttribute('aria-label'))).toEqual(['Size, on', 'Rotation']);
    expect(sheet.shadowRoot!.querySelector('[aria-pressed]')).toBe(null);
    expect(text(sheet, '.tk__face .tk__hint')).toBe('Drag the box to fix the track from here');

    button(sheet, 'Size, on')!.click();
    button(sheet, 'Rotation')!.click();
    expect(asked).toEqual([{ scaleWith: false }, { turnWith: true }]);

    head(sheet, '[aria-label="Remove tracking"]')!.click();
    expect(unpinned).toBe(1);
  });

  it('on a track with no layer: no Follow, and Remove track', async () => {
    const { store, sheet } = await mount(manifest([track()], []), openOnTrack);
    const removed: string[] = [];
    store.deleteTrack = trackId => {
      removed.push(trackId);
    };

    expect(Array.from(sheet.shadowRoot!.querySelectorAll('.tk__word')).map(word => word.textContent)).toEqual(['Smooth']);
    expect(head(sheet, '[aria-label="Remove tracking"]')).toBe(null);
    head(sheet, '[aria-label="Remove track"]')!.click();
    expect(removed).toEqual(['trk-a']);
  });

  it('renames the track from its name: Enter and a tap away keep what was typed, Escape does not', async () => {
    const { store, sheet } = await mount(manifest([track()], []), openOnTrack);
    const field = () => el<HTMLInputElement>(sheet, '.tk__field');
    const name = () => store.manifest.value.tracks?.[0]?.name;
    const typing = async (what: string): Promise<HTMLInputElement> => {
      await until('the field, focused with the name selected', () => {
        const input = field();
        return !!input && sheet.shadowRoot!.activeElement === input && input.selectionStart === 0 && input.selectionEnd === input.value.length;
      });
      const input = field()!;
      input.value = what;
      return input;
    };
    const key = (input: HTMLInputElement, which: string) => input.dispatchEvent(new KeyboardEvent('keydown', { key: which, bubbles: true, composed: true, cancelable: true }));

    button(sheet, 'Rename Runner')!.click();
    expect(store.trackRenaming.value).toBe(true);
    const first = await typing('Dog');
    expect(first.maxLength).toBe(24);
    expect(first.getAttribute('aria-label')).toBe('Track name');
    key(first, 'Enter');
    expect(name()).toBe('Dog');
    expect(store.trackRenaming.value).toBe(false);
    await until('the name back', () => button(sheet, 'Rename Dog') !== null);

    // Rename on the track's row opens the field the same way.
    store.trackRenaming.value = true;
    key(await typing('Cat'), 'Escape');
    expect(name()).toBe('Dog');
    await until('the name back', () => field() === null);

    store.trackRenaming.value = true;
    (await typing('Rex')).blur();
    expect(name()).toBe('Rex');
  });

  it('offers to fix the track once its box is moved, and puts the box back on Cancel', async () => {
    const { store, sheet } = await mount(manifest([track()], []), openOnTrack);
    let started = 0;
    store.startTracking = async () => {
      started++;
    };

    store.setTrackAim({ cx: 0.3, cy: 0.3, w: 0.2, h: 0.1 });
    await until('the fix', () => text(sheet, '.tk__face .tk__hint') === 'Fixes the track both ways from here');
    // The name stays over it; how sure the track is does not, until the box is back.
    expect(button(sheet, 'Rename Runner')).not.toBe(null);
    expect(el(sheet, '.tk__health')).toBe(null);
    button(sheet, 'Fix track')!.click();
    expect(started).toBe(1);

    button(sheet, 'Cancel')!.click();
    expect(store.trackAimMoved.value).toBe(false);
    await until('the track again', () => text(sheet, '.tk__face .tk__hint') === 'Drag the box to fix the track from here');
  });

  it('keeps one height whatever it shows, inside the compact budget', async () => {
    const onLayer = await mount(manifest([track()], [caption(FOLLOWING)]), openOnLayer);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const tall = height(onLayer.sheet);
    expect(tall).toBeLessThanOrEqual(259);

    // The box dragged off the track is the moment that matters: a finger is on the picture above.
    onLayer.store.setTrackAim({ cx: 0.3, cy: 0.3, w: 0.2, h: 0.1 });
    await until('the fix', () => button(onLayer.sheet, 'Fix track') !== null);
    expect(height(onLayer.sheet)).toBe(tall);
    onLayer.store.trackRun.value = { trackId: 'trk-a', overlayId: null, clipId: 'seg-a', clipKey: 'clip-a', outputMs: 0, mode: 'fix', progress: 0.1 };
    await until('the run', () => button(onLayer.sheet, 'Stop') !== null);
    expect(height(onLayer.sheet)).toBe(tall);

    const onTrack = await mount(manifest([track()], []), openOnTrack);
    await new Promise(resolve => requestAnimationFrame(resolve));
    const short = height(onTrack.sheet);
    expect(short).toBeLessThan(tall);
    onTrack.store.setTrackAim({ cx: 0.3, cy: 0.3, w: 0.2, h: 0.1 });
    await until('the fix', () => button(onTrack.sheet, 'Fix track') !== null);
    expect(height(onTrack.sheet)).toBe(short);

    // Nothing in a face reaches past the body: each one fits the height it is given.
    for (const face of Array.from(onTrack.sheet.shadowRoot!.querySelectorAll<HTMLElement>('.tk__face'))) expect(face.scrollHeight).toBeLessThanOrEqual(face.clientHeight);
  });

  it('closes itself when the track it shows is gone and there is nothing else to show', async () => {
    const { store } = await mount(manifest([track()], []), openOnTrack);
    expect(store.panel.value).toBe('track');
    store.manifest.value = { ...store.manifest.value, tracks: [] };
    await until('the sheet to close', () => store.panel.value === null);
  });
});
