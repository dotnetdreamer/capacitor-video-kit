import { afterEach, describe, expect, it } from 'vitest';

import type { EditorContext } from '../../bridge/editor-context';
import { defaultClipEdit, emptyManifest, estimatedBytes, outputFor } from '../../editor';
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
    // A social host posts to a feed with an upload limit and has no business offering 4K; another app on
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

  /*
   * A host's upload limit, against this five second post. It is set between what 720P and 1080P
   * are estimated to come to, so every rung above the first is over it, and so is 720P at 60fps,
   * which is twice the rate. Marked, and never greyed: the estimate is a rate the encoder may spend
   * less than, and the render is what measures the real file.
   */
  describe('under a host\'s size ceiling', () => {
    const at720 = estimatedBytes(5000, outputFor('9:16', '720p', 30));
    const at1080 = estimatedBytes(5000, outputFor('9:16', '1080p', 30));
    const maxBytes = Math.round((at720 + at1080) / 2);

    function everyRung(): VideoEditorHost {
      return {
        media: hostRefusing4K().media,
        output: { maxBytes },
      };
    }

    function marked(chip: HTMLButtonElement): boolean {
      return chip.querySelector('.qs__hint--over') !== null;
    }

    it('marks only the rungs whose estimate is over the ceiling, and leaves every one of them choosable', async () => {
      const { sheet } = await mount(everyRung());
      await frames(4);

      const resolution = chips(sheet, 'Resolution');
      expect(resolution.map(marked)).toEqual([false, true, true, true]);
      expect(resolution.every((chip) => !chip.disabled)).toBe(true);
      expect(resolution[1].textContent).toContain('Over');
      expect(chips(sheet, 'Frame rate').map(marked)).toEqual([false, true]);
      // The chosen frame is under, so there is nothing to explain yet.
      expect(sheet.shadowRoot?.textContent).not.toContain('too big to post');
    });

    it('takes a rung over the ceiling when it is chosen, and says under the size what that may mean', async () => {
      const { store, sheet } = await mount(everyRung());
      await frames(4);

      chips(sheet, 'Resolution')[1].click();
      await frames(2);

      expect(store.output.value).toEqual(outputFor('9:16', '1080p', 30));
      expect(sheet.shadowRoot?.querySelector('.qs__note--over')?.textContent).toContain('May be too big to post.');
    });

    it('marks nothing for a host that set no ceiling', async () => {
      const { sheet } = await mount({ media: hostRefusing4K().media });
      await frames(4);

      expect([...chips(sheet, 'Resolution'), ...chips(sheet, 'Frame rate')].some(marked)).toBe(false);
      expect(sheet.shadowRoot?.querySelector('.qs__note--over')).toBeNull();
    });

    /* Rounded down it is a ceiling of 0, which every rung is over: a typo's worth of fraction. */
    it('marks nothing for a ceiling under one byte, which is no ceiling', async () => {
      const { sheet } = await mount({ media: hostRefusing4K().media, output: { maxBytes: 0.5 } });
      await frames(4);

      expect([...chips(sheet, 'Resolution'), ...chips(sheet, 'Frame rate')].some(marked)).toBe(false);
      expect(sheet.shadowRoot?.querySelector('.qs__note--over')).toBeNull();
    });
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
