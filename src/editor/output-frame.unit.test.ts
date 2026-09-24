import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OUTPUT,
  OUTPUT_QUALITIES,
  aspectOf,
  defaultClipEdit,
  emptyManifest,
  estimatedBytes,
  isUntouched,
  normaliseManifest,
  normaliseOutput,
  outputFor,
  qualityOf,
  videoBitrateFor,
} from './edit-manifest';
import { toComposeSpec, type ComposeSpecLimits } from './compose';
import type { RasterContext } from './raster-context';
import { resolveEditorHost } from '../host/defaults';
import type { ComposeSpec } from '../video-composer/definitions';

/**
 * The frame is a choice now, and it is the choice everything else in a manifest is measured
 * against. These pin the three things that go wrong quietly when it moves: a ladder that names a
 * size it does not produce, a bitrate that stayed where it was while the pixels quadrupled, and an
 * old post reopening as something other than the post it was.
 */

/** A source already the shape of [DEFAULT_OUTPUT], which `cover` therefore leaves alone. */
const UPRIGHT = DEFAULT_OUTPUT.width / DEFAULT_OUTPUT.height;

function onePost() {
  return { ...emptyManifest(), clips: [defaultClipEdit('a', 4000)] };
}

describe('the frame a post is rendered at', () => {
  it('stands the same rung up or lays it down, keeping the pixels', () => {
    expect(outputFor('9:16', '1080p', 30)).toEqual({ width: 1080, height: 1920, fps: 30 });
    expect(outputFor('16:9', '1080p', 30)).toEqual({ width: 1920, height: 1080, fps: 30 });
    // Named by the SHORT side, which is what lets one ladder read both ways round.
    expect(outputFor('16:9', '4k', 60)).toEqual({ width: 3840, height: 2160, fps: 60 });
  });

  it('reads a frame back as the shape and the rung it is', () => {
    for (const quality of OUTPUT_QUALITIES) {
      for (const aspect of ['9:16', '16:9'] as const) {
        const output = outputFor(aspect, quality.id, 30);
        expect(aspectOf(output)).toBe(aspect);
        expect(qualityOf(output).id).toBe(quality.id);
      }
    }
  });

  it('gives every frame even sides, which is what an H.264 encoder refuses to do without', () => {
    // A failure that would otherwise arrive at the END of a render, with the editing already done.
    for (const quality of OUTPUT_QUALITIES) {
      const output = outputFor('9:16', quality.id, 30);
      expect(output.width % 2).toBe(0);
      expect(output.height % 2).toBe(0);
    }
    expect(normaliseOutput({ width: 1081, height: 1921, fps: 30 })).toEqual({ width: 1082, height: 1922, fps: 30 });
  });

  it('takes an absent or absurd frame as the one every post used to have', () => {
    expect(normaliseOutput(undefined)).toEqual(DEFAULT_OUTPUT);
    expect(normaliseOutput({ width: 1e9, height: 1e9, fps: 999 }).width).toBe(3840);
    // A rate that is neither of the two on offer lands on the nearer one rather than being kept.
    expect(normaliseOutput({ width: 720, height: 1280, fps: 47 }).fps).toBe(60);
  });

  it('reopens a post written before the frame was a choice at the frame it was rendered at', () => {
    const old = { ...onePost() } as Record<string, unknown>;
    delete old['output'];

    expect(normaliseManifest(old).output).toEqual(DEFAULT_OUTPUT);
  });

  it('is a render in itself, so a clip that would have gone up untouched no longer does', () => {
    const durations = new Map([['a', 4000]]);
    expect(isUntouched(onePost(), durations, UPRIGHT)).toBe(true);

    // The customer asked for 1080P. Posting the file on disk would hand back whatever size THAT
    // happens to be, which is the one thing they said it was not.
    const bigger = { ...onePost(), output: outputFor('9:16', '1080p', 30) };
    expect(isUntouched(bigger, durations, UPRIGHT)).toBe(false);
  });

  /*
   * The post fills its frame, so whether the file on disk IS the post now depends on the shape of
   * the file. This is the one place in the package where that question is asked, and it is asked
   * about a picture nobody can get back once it has been posted.
   */
  it('posts a clip already the shape of the frame as it is, and renders one that would be cropped', () => {
    const durations = new Map([['a', 4000]]);
    const post = onePost();

    expect(post.fit).toBe('cover');
    expect(isUntouched(post, durations, UPRIGHT)).toBe(true);
    // Rounded to the even sides an encoder insists on: the same picture, and not a crop.
    expect(isUntouched(post, durations, 1082 / 1920)).toBe(true);

    // A landscape clip in an upright frame: `cover` takes the sides off it, and the file on disk is
    // the picture with them still on. Posting that hands back more than the preview showed.
    expect(isUntouched(post, durations, 16 / 9)).toBe(false);
    // Not measured yet. An unknown shape is rendered rather than guessed at.
    expect(isUntouched(post, durations)).toBe(false);

    // Contained, the file is the picture without the bars around it, which has always gone up as
    // it is whatever shape it happens to be.
    expect(isUntouched({ ...post, fit: 'contain' }, durations, 16 / 9)).toBe(true);
  });
});

describe('what a frame costs', () => {
  it('spends more on more pixels and on more frames, rather than holding one number', () => {
    const base = videoBitrateFor(outputFor('9:16', '720p', 30));
    const bigger = videoBitrateFor(outputFor('9:16', '1080p', 30));
    const faster = videoBitrateFor(outputFor('9:16', '720p', 60));

    // Roughly with the pixel count, which is what keeps 4K from being a bigger, softer 720p.
    expect(bigger / base).toBeCloseTo((1080 * 1920) / (720 * 1280), 1);
    expect(faster / base).toBeCloseTo(2, 1);
  });

  it("is decided by the frame alone, and never by somebody else's upload limit", () => {
    // The plugin has two apps: one posts to a feed with a 100MB ceiling, the other builds 4K
    // because that is what it is for. A bitrate quietly held down to the first app's limit made the
    // second app's 4K a bigger, softer 1080p. A host that has a limit expresses it by the rungs it
    // OFFERS and by a ceiling on the file, both of which it can explain to its customer, and
    // neither of which moves the rate.
    const long = 600_000;
    const perSecond = estimatedBytes(1000, outputFor('9:16', '4k', 60));

    expect(estimatedBytes(long, outputFor('9:16', '4k', 60))).toBeCloseTo(perSecond * 600, -6);
    expect(videoBitrateFor(outputFor('9:16', '4k', 60))).toBe(videoBitrateFor(outputFor('9:16', '4k', 60)));
  });

  it('holds a floor, so a tiny frame is not encoded into mush', () => {
    expect(videoBitrateFor({ width: 64, height: 64, fps: 30 })).toBe(1_200_000);
  });
});

describe('what a host allows', () => {
  it('offers the whole ladder to a host that says nothing', () => {
    const resolved = resolveEditorHost({});

    expect(resolved.output.qualities).toEqual(OUTPUT_QUALITIES.map((one) => one.id));
    expect(resolved.output.initial).toEqual(DEFAULT_OUTPUT);
  });

  it("offers exactly what a host names, in this package's own order", () => {
    const resolved = resolveEditorHost({ output: { qualities: ['4k', '720p'], fps: [30], aspects: ['9:16'] } });

    expect(resolved.output.qualities).toEqual(['720p', '4k']);
    expect(resolved.output.fps).toEqual([30]);
  });

  it('starts a post on a frame the host will actually offer', () => {
    // A post that opened on a rung its own editor does not show would leave the quality sheet with
    // nothing lit, and a customer with no way to understand what they were looking at.
    const resolved = resolveEditorHost({ output: { qualities: ['1080p'], initial: DEFAULT_OUTPUT } });

    expect(resolved.output.initial).toEqual(outputFor('9:16', '1080p', 30));
  });

  it('takes a list naming nothing it has as a host that said nothing at all', () => {
    // A typo in an app's configuration costs it the setting, never the feature: an empty row of
    // chips is a quality sheet nobody can use.
    const resolved = resolveEditorHost({ output: { qualities: ['8k'] } });

    expect(resolved.output.qualities).toEqual(OUTPUT_QUALITIES.map((one) => one.id));
  });
});

/*
 * The host's size ceiling on the wire. It is written only when there is one, so a host with no
 * upload limit sends exactly the spec it always sent, and an engine that has never heard of the key
 * is never handed one that means nothing.
 */
describe('the size ceiling a render is held to', () => {
  const uris = new Map([['a', 'file:///a.mp4']]);
  // No layers on the post, so nothing is drawn and the raster context is never asked for anything.
  const wire = (limits?: ComposeSpecLimits): Promise<ComposeSpec> =>
    toComposeSpec(onePost(), uris, { jobId: 'j', batchId: 'b' }, {} as RasterContext, limits);

  it('writes the host\'s ceiling as the output\'s, beside the rate it does not change', async () => {
    const capped = await wire({ maxBytes: 100 * 1024 * 1024 });
    const uncapped = await wire();

    expect(capped.output.maxBytes).toBe(104_857_600);
    expect(capped.output.videoBitrate).toBe(uncapped.output.videoBitrate);
  });

  it('writes no ceiling at all for a host that set none, or one that is not a positive number', async () => {
    expect((await wire()).output).not.toHaveProperty('maxBytes');
    expect((await wire({})).output).not.toHaveProperty('maxBytes');
    for (const none of [null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await wire({ maxBytes: none })).output).not.toHaveProperty('maxBytes');
    }
  });

  /* Positive, but a zero once rounded down to whole bytes, and a zero fails every render. */
  it('writes no ceiling for a fraction under one byte, and whole bytes for one over it', async () => {
    for (const none of [0.5, 0.999, Number.MIN_VALUE]) {
      expect((await wire({ maxBytes: none })).output).not.toHaveProperty('maxBytes');
    }
    expect((await wire({ maxBytes: 1.5 })).output.maxBytes).toBe(1);
  });
});
