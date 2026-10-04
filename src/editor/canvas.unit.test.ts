import { describe, expect, it } from 'vitest';

import type { ComposeClip, ComposeSpec } from '../video-composer/definitions';
import { buildPlan } from '../video-composer/web/plan';
import { SpecError, validateSpec } from '../video-composer/web/spec';
import { toComposeSpec } from './compose';
import { BACKGROUND_COLORS, backgroundRgb, defaultClipEdit, emptyManifest, isUntouched, normaliseBackground, normaliseManifest, type EditManifest } from './edit-manifest';
import { setBackground } from './edit-ops';
import type { RasterContext } from './raster-context';

/*
 * The canvas a post is painted on, end to end on the TypeScript side: the stored colour, the op, the
 * spec it becomes, the shortcut that posts a file as it is, and what the web engine reads back - plus
 * the clip keys a moving rectangle travels under, read at every path the browser's reader reaches.
 */

const post = (over: Partial<EditManifest> = {}): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('a', 4000, 'seg-a')], ...over });

describe('the stored colour', () => {
  it('keeps a colour as lower case #rrggbb and drops black and anything that is not one', () => {
    expect(normaliseBackground('#FFFFFF')).toBe('#ffffff');
    expect(normaliseBackground('#000000')).toBeUndefined();
    expect(normaliseBackground('white')).toBeUndefined();
    expect(normaliseBackground('#fff')).toBeUndefined();
    expect(normaliseBackground(12)).toBeUndefined();
  });

  it('is three 0..1 channels on the wire', () => {
    expect(backgroundRgb('#ff8000')).toEqual([1, 0.502, 0]);
    expect(backgroundRgb('#ffffff')).toEqual([1, 1, 1]);
  });

  it('offers black first, and every colour it offers is one the manifest keeps', () => {
    expect(BACKGROUND_COLORS[0].colour).toBe('#000000');
    for (const swatch of BACKGROUND_COLORS.slice(1)) expect(normaliseBackground(swatch.colour)).toBe(swatch.colour);
  });

  it('is set, re-set as no change, and put back to black as no key at all', () => {
    const m = post();
    const white = setBackground(m, '#FFFFFF');
    expect(white.background).toBe('#ffffff');
    expect(setBackground(white, '#ffffff')).toBe(white);
    const black = setBackground(white, '#000000');
    expect('background' in black).toBe(false);
    expect(setBackground(m, null)).toBe(m);
  });

  it('reads back from a draft, and a black or broken one has no key', () => {
    expect(normaliseManifest({ ...post(), background: '#F2F2F7' }).background).toBe('#f2f2f7');
    expect('background' in normaliseManifest({ ...post(), background: '#000000' })).toBe(false);
    expect('background' in normaliseManifest({ ...post(), background: 'blue' })).toBe(false);
  });
});

describe('the spec', () => {
  const uris = new Map([['a', 'file:///a.mp4']]);
  const context = { output: emptyManifest().output, textStyle: () => ({}), stickerUrl: () => '', fileUrl: (u: string) => u } as unknown as RasterContext;
  const wire = (m: EditManifest): Promise<ComposeSpec> => toComposeSpec(m, uris, { jobId: 'j', batchId: 'b' }, context);

  it('sends a black canvas exactly as it always has: no key', async () => {
    expect('background' in (await wire(post()))).toBe(false);
  });

  it('sends a coloured canvas as three channels', async () => {
    expect((await wire(post({ background: '#ffffff' }))).background).toEqual([1, 1, 1]);
  });

  it('renders a contained clip on a coloured canvas, because its bars are the canvas', () => {
    const durations = new Map([['a', 4000]]);
    const contained = post({ fit: 'contain', background: '#ffffff' });
    // A landscape source in the upright frame: bars above and below.
    expect(isUntouched(contained, durations, 16 / 9)).toBe(false);
    expect(isUntouched({ ...contained, background: undefined }, durations, 16 / 9)).toBe(true);
    // A source the frame's own shape has no bars, so the canvas shows nowhere.
    expect(isUntouched(contained, durations, 720 / 1280)).toBe(true);
  });
});

describe('the web engine', () => {
  function clip(over: Partial<ComposeClip> = {}): ComposeClip {
    return { key: 'c', uri: 'file:///a.mp4', inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'cover', ...over };
  }
  function spec(over: Partial<ComposeSpec> = {}): ComposeSpec {
    return {
      jobId: 'j',
      batchId: 'p',
      clips: [clip()],
      output: { width: 720, height: 1280, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
      filter: [],
      overlays: [],
      audio: { originalMuted: false, originalVolume: 1, music: null, voiceover: [] },
      posterAtMs: 0,
      ...over,
    };
  }
  function pathOf(input: ComposeSpec): string {
    try {
      validateSpec(input);
    } catch (error) {
      expect(error).toBeInstanceOf(SpecError);
      return (error as SpecError).path;
    }
    throw new Error('not refused');
  }

  it('reads a background clamped, leaves black off, and refuses one of the wrong shape', () => {
    expect(validateSpec(spec({ background: [2, 0.5, -1] })).background).toEqual([1, 0.5, 0]);
    expect('background' in validateSpec(spec())).toBe(false);
    expect(pathOf(spec({ background: [1, 1] as unknown as [number, number, number] }))).toBe('background');
    expect(pathOf(spec({ background: 'white' as unknown as [number, number, number] }))).toBe('background');
  });

  it('plans black for a spec with no background', () => {
    expect(buildPlan(validateSpec(spec()), new Map()).background).toEqual([0, 0, 0]);
    expect(buildPlan(validateSpec(spec({ background: [1, 1, 1] })), new Map()).background).toEqual([1, 1, 1]);
  });

  it('reads a moving rectangle on a layer clip and on a transition tail, at their own paths', () => {
    const keys = { atMs: [0, 100], x: [0, 0], y: [1, 0.5], w: [1, 1], h: [0.5, 0.5] };
    const layered = validateSpec(spec({ tracks: [{ id: 't', z: 1, clips: [clip({ rectMotion: keys })] }] }));
    expect(layered.tracks?.[0].clips[0].rectMotion).toEqual(keys);
    const broken = { ...keys, atMs: [100, 50] };
    expect(pathOf(spec({ tracks: [{ id: 't', z: 1, clips: [clip({ rectMotion: broken })] }] }))).toBe('tracks[0].clips[0].rectMotion.atMs[1]');
    expect(pathOf(spec({ clips: [clip({ rectMotion: { ...keys, w: [1] } })] }))).toBe('clips[0].rectMotion.w');
    // A layer's moving rectangle travels on its placement, and the clip it carries has none.
    const plan = buildPlan(layered, new Map());
    expect(plan.tracks[0].placements[0].motion).toEqual(keys);
    expect(plan.tracks[0].clips[0].clip.rectMotion).toBeUndefined();
  });
});
