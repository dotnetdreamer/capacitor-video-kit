import { describe, expect, it } from 'vitest';

import { toComposeSpec } from './compose';
import { defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest, type EditMusic } from './edit-manifest';
import { musicFadeAt, patchMusic } from './edit-ops';
import type { RasterContext } from './raster-context';

/*
 * A sound's fades: up from silence at the start of the first repetition, down to it at the end of
 * the last. The render draws them; `musicFadeAt` is what the preview hears, so it has to be the same
 * ramps - including the two edges [ComposeMusic] spells out, a fade in longer than the first
 * repetition and a last repetition shorter than the fade out.
 */

/** Four seconds of a thirty second track, looping from the start of the post, with no fades. */
function music(over: Partial<EditMusic> = {}): EditMusic {
  return {
    uri: 'file:///song.m4a',
    fileName: 'song.m4a',
    sourceDurationMs: 30_000,
    inMs: 0,
    outMs: 4000,
    startMs: 0,
    endMs: 0,
    volume: 1,
    loop: true,
    fadeOutMs: 0,
    ...over,
  };
}

describe('musicFadeAt', () => {
  it('leaves the level alone with no fades', () => {
    for (const ms of [0, 3999, 4000, 10_000, 19_999]) expect(musicFadeAt(music(), ms, 20_000)).toBe(1);
  });

  it('comes up from silence from where the sound starts on the post', () => {
    const m = music({ startMs: 2000, fadeInMs: 1000 });
    expect(musicFadeAt(m, 1500, 20_000)).toBe(0);
    expect(musicFadeAt(m, 2000, 20_000)).toBe(0);
    expect(musicFadeAt(m, 2500, 20_000)).toBeCloseTo(0.5, 6);
    expect(musicFadeAt(m, 3000, 20_000)).toBe(1);
  });

  it('fades in the first repetition only, so a fade longer than it stops short of the level', () => {
    const m = music({ fadeInMs: 6000 });
    expect(musicFadeAt(m, 3999, 20_000)).toBeCloseTo(3999 / 6000, 6);
    // The second repetition starts at the level, as it does in the render.
    expect(musicFadeAt(m, 4000, 20_000)).toBe(1);
  });

  it('goes down to silence at the end of what is heard', () => {
    const m = music({ fadeOutMs: 1000 });
    expect(musicFadeAt(m, 19_000, 20_000)).toBe(1);
    expect(musicFadeAt(m, 19_500, 20_000)).toBeCloseTo(0.5, 6);
    expect(musicFadeAt(m, 19_999, 20_000)).toBeCloseTo(0.001, 6);
  });

  it('fades out at the sound’s own stop when it has one', () => {
    const m = music({ endMs: 9000, fadeOutMs: 1000 });
    expect(musicFadeAt(m, 8500, 20_000)).toBeCloseTo(0.5, 6);
  });

  it('starts a fade out no earlier than the last repetition, which then ends above silence', () => {
    // Repetitions at 0, 4, 8, 12 and 16 s; the last is half a second, shorter than the fade.
    const m = music({ endMs: 16_500, fadeOutMs: 1000 });
    expect(musicFadeAt(m, 15_999, 20_000)).toBe(1);
    expect(musicFadeAt(m, 16_000, 20_000)).toBe(1);
    expect(musicFadeAt(m, 16_499, 20_000)).toBeCloseTo(0.501, 6);
  });

  it('multiplies the two where they overlap on a sound that plays once', () => {
    const m = music({ loop: false, fadeInMs: 3000, fadeOutMs: 3000 });
    expect(musicFadeAt(m, 2000, 20_000)).toBeCloseTo((2 / 3) * (2 / 3), 6);
  });
});

describe('patchMusic', () => {
  const post = (m: EditMusic): EditManifest => ({ ...emptyManifest(), music: m });

  it('sets a fade in, in whole milliseconds', () => {
    expect(patchMusic(post(music()), { fadeInMs: 999.6 }).music?.fadeInMs).toBe(1000);
  });

  it('does not give music that never had a fade in one, so a volume change stays a volume change', () => {
    expect(patchMusic(post(music()), { volume: 0.5 }).music).not.toHaveProperty('fadeInMs');
  });

  it('is no change when the fade is already that', () => {
    const before = post(music({ fadeInMs: 1000 }));
    expect(patchMusic(before, { fadeInMs: 1000 })).toBe(before);
  });
});

describe('reading a stored post', () => {
  it('keeps a fade in it finds', () => {
    expect(normaliseManifest({ ...emptyManifest(), music: music({ fadeInMs: 1000 }) }).music?.fadeInMs).toBe(1000);
  });

  it('reads a sound saved before fades in existed as it was, with no fade in', () => {
    expect(normaliseManifest({ ...emptyManifest(), music: music() }).music).not.toHaveProperty('fadeInMs');
  });
});

describe('on the wire', () => {
  const uris = new Map([['v', 'file:///v.mp4']]);
  const wire = (m: EditMusic) =>
    toComposeSpec(
      { ...emptyManifest(), clips: [{ ...defaultClipEdit('v', 20_000, 'a'), inMs: 0, outMs: 20_000 }], music: m },
      uris,
      { jobId: 'j', batchId: 'b' },
      {} as RasterContext,
    );

  it('sends the fade in, which every engine already draws', async () => {
    expect((await wire(music({ fadeInMs: 1000, fadeOutMs: 1000 }))).audio.music).toMatchObject({ fadeInMs: 1000, fadeOutMs: 1000 });
  });

  it('sends no fade in for a sound without one', async () => {
    expect((await wire(music())).audio.music?.fadeInMs).toBe(0);
  });
});
