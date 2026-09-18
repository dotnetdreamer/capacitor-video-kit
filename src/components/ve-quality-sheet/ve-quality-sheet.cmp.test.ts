import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { defaultClipEdit, emptyManifest, outputFor } from '../../editor';
import { resolveEditorHost } from '../../host/defaults';
import type { EditorEncodeSupport, VideoEditorHost } from '../../host/host.types';
import { EditorMedia } from '../../state/editor-media';
import { EditorStore } from '../../state/editor-store';

/*
 * A browser rather than the mock DOM, because what is pinned here is what a customer can PRESS: a
 * rung this device cannot encode has to be unreachable, not merely drawn differently.
 *
 * The failure it guards against is the one a resolution ladder invites. A phone with no 4K encoder
 * takes the choice happily, the customer edits for a minute, and the render fails at the end - so
 * the ladder asks the host first and greys out what comes back refused, with the reason beside it.
 */

type StencilElement = HTMLElement & { componentOnReady?: () => Promise<unknown> };

const mounted: HTMLElement[] = [];

/** A host that refuses everything above 1080P, which is what an older phone answers. */
function hostRefusing4K(): VideoEditorHost {
  return {
    media: {
      pickVideo: async () => null,
      pickImage: async () => null,
      pickAudio: async () => null,
      probeDuration: async () => 5000,
      thumbnails: async () => [],
    },
    render: {
      isSupported: async () => true,
      render: async () => ({ key: 'a', fileName: 'a.mp4' }),
      encodeSupport: async (frames): Promise<readonly EditorEncodeSupport[]> =>
        frames.map((frame) => ({
          ...frame,
          supported: Math.min(frame.width, frame.height) <= 1080,
          reason: Math.min(frame.width, frame.height) <= 1080 ? undefined : 'This phone cannot encode 4K.',
        })),
    },
  };
}

async function mount(host: VideoEditorHost): Promise<{ store: EditorStore; sheet: HTMLElement }> {
  const resolved = resolveEditorHost(host);
  const store = new EditorStore(resolved);
  const ctx: EditorContext = { store, media: new EditorMedia(store, resolved) };
  store.load(
    [{ key: 'a', fileName: 'a.mp4' }],
    new Map([['a', 5000]]),
    { ...emptyManifest(), clips: [defaultClipEdit('a', 5000, 'seg-a')] },
  );

  const column = document.createElement('div');
  column.style.cssText = 'width: 393px; height: 400px';
  document.body.append(column);
  const sheet = document.createElement('ve-quality-sheet');
  Object.assign(sheet, { ctx });
  column.append(sheet);
  mounted.push(column);
  await (sheet as StencilElement).componentOnReady?.();
  return { store, sheet };
}

function chips(sheet: HTMLElement, group: string): HTMLButtonElement[] {
  return [...(sheet.shadowRoot?.querySelectorAll<HTMLButtonElement>(`[aria-label="${group}"] button`) ?? [])];
}

async function frames(count: number): Promise<void> {
  for (let i = 0; i < count; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
}

afterEach(() => {
  for (const column of mounted.splice(0)) column.remove();
});

describe('ve-quality-sheet', () => {
  it('greys out a rung this device refuses, and says why', async () => {
    const { sheet } = await mount(hostRefusing4K());
    await frames(4);

    const [p720, p1080, k27, k4] = chips(sheet, 'Resolution');
    expect(p720.disabled).toBe(false);
    expect(p1080.disabled).toBe(false);
    expect(k27.disabled).toBe(true);
    expect(k4.disabled).toBe(true);
    // A disabled chip with nothing beside it reads as a broken app rather than as a limit.
    expect(sheet.shadowRoot?.textContent).toContain('This phone cannot encode 4K.');
  });

  it('takes a rung the device does allow, and writes it on the post', async () => {
    const { store, sheet } = await mount(hostRefusing4K());
    await frames(4);

    chips(sheet, 'Resolution')[1].click();
    await frames(2);

    expect(store.output.value).toEqual(outputFor('9:16', '1080p', 30));
  });

  it('turns the canvas on its side without touching anything on it', async () => {
    const { store, sheet } = await mount(hostRefusing4K());
    await frames(4);

    chips(sheet, 'Shape')[1].click();
    await frames(2);

    // The same pixels, the other way up - and the clip is untouched, because every rectangle in a
    // manifest is a FRACTION of the frame and follows it rather than being rewritten.
    expect(store.output.value).toEqual({ width: 1280, height: 720, fps: 30 });
    expect(store.frameAspect.value).toBeCloseTo(1280 / 720, 6);
    expect(store.manifest.value.clips[0]).not.toHaveProperty('rect');
  });

  it('offers only the rungs this app allows, which is a different question from the device', async () => {
    // Choisy posts to a feed with an upload limit and has no business offering 4K; another app on
    // the same editor is built for 4K and says so. The plugin decides neither - it shows what the
    // host named, and the device probe then greys out what that device cannot encode.
    const { sheet } = await mount({ ...hostRefusing4K(), output: { qualities: ['720p', '1080p'] } });
    await frames(4);

    expect(chips(sheet, 'Resolution').map((chip) => chip.textContent)).toEqual(['720P', '1080P']);
  });

  it('shows no row at all for a choice of one, which is not a choice', async () => {
    const { sheet } = await mount({ ...hostRefusing4K(), output: { aspects: ['9:16'], fps: [30] } });
    await frames(4);

    expect(chips(sheet, 'Shape')).toEqual([]);
    expect(chips(sheet, 'Frame rate')).toEqual([]);
    expect(chips(sheet, 'Resolution').length).toBeGreaterThan(0);
  });

  it('offers the whole ladder to a host that has no answer about it', async () => {
    // An absent `encodeSupport` is a host saying nothing, and nothing is what every host said
    // before the frame was a choice. Greying the ladder out on silence would be the wrong default.
    const { sheet } = await mount({
      media: {
        pickVideo: async () => null,
        pickImage: async () => null,
        pickAudio: async () => null,
        probeDuration: async () => 5000,
        thumbnails: async () => [],
      },
    });
    await frames(4);

    expect(chips(sheet, 'Resolution').every((chip) => !chip.disabled)).toBe(true);
  });
});
