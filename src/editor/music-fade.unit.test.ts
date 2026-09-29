import { describe, expect, it } from 'vitest';

import { toComposeSpec } from './compose';
import { defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest, type EditMusic } from './edit-manifest';
import { musicFadeAt, patchMusic } from './edit-ops';
import type { RasterContext } from './raster-context';

/*
 * A sound's fades: up from silence where it starts on the post, down to it where it stops, each a
 * straight line and their product where they overlap - [ComposeMusic]'s rule. They belong to the
 * whole window the sound is heard in, never to one repetition of a loop: a seam plays no part, and a
 * fade out reaches silence exactly at the stop however short the last pass is. The render draws
 * them; `musicFadeAt` is what the preview hears, so it has to be the same curve.
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

  it('runs a fade in longer than the section on across its seams, up to the level', () => {
    const m = music({ fadeInMs: 6000 });
    expect(musicFadeAt(m, 3999, 20_000)).toBeCloseTo(3999 / 6000, 6);
    // The second repetition takes up the line where the first left it, rather than jumping.
    expect(musicFadeAt(m, 4000, 20_000)).toBeCloseTo(4000 / 6000, 6);
    expect(musicFadeAt(m, 5000, 20_000)).toBeCloseTo(5000 / 6000, 6);
    expect(musicFadeAt(m, 6000, 20_000)).toBe(1);
    expect(musicFadeAt(m, 12_000, 20_000)).toBe(1);
  });

  it('comes up over the first part of a short section that loops, crossing a seam', () => {
    // An 800 ms section under a 3 s fade in: four seams before the level.
    const m = music({ outMs: 800, fadeInMs: 3000 });
    expect(musicFadeAt(m, 500, 20_000)).toBeCloseTo(500 / 3000, 6);
    expect(musicFadeAt(m, 1500, 20_000)).toBeCloseTo(0.5, 6);
    expect(musicFadeAt(m, 2500, 20_000)).toBeCloseTo(2500 / 3000, 6);
    expect(musicFadeAt(m, 4000, 20_000)).toBe(1);
  });

  it('goes down to silence at the end of what is heard', () => {
    const m = music({ fadeOutMs: 1000 });
    expect(musicFadeAt(m, 19_000, 20_000)).toBe(1);
    expect(musicFadeAt(m, 19_500, 20_000)).toBeCloseTo(0.5, 6);
    expect(musicFadeAt(m, 19_999, 20_000)).toBeCloseTo(0.001, 6);
    expect(musicFadeAt(m, 20_000, 20_000)).toBe(0);
  });

  it('fades out at the sound’s own stop when it has one', () => {
    const m = music({ endMs: 9000, fadeOutMs: 1000 });
    expect(musicFadeAt(m, 8500, 20_000)).toBeCloseTo(0.5, 6);
    expect(musicFadeAt(m, 9000, 20_000)).toBe(0);
  });

  /*
   * THE FADE OUT WAS LOST ON iOS. WebKit reads a 12 s song as 11975 ms, so a 60 s post was five
   * passes and a 125 ms sixth, and a fade out that belonged to the last pass was a 1.0 to 0.9875
   * slope over its 125 ms before a hard cut. Belonging to the window, it is the same fade on every
   * engine however the song's length was read.
   */
  it('reaches silence at the end of a post that is a sliver longer than a whole number of passes', () => {
    const m = music({ sourceDurationMs: 11_975, outMs: 0, fadeOutMs: 10_000 });
    expect(musicFadeAt(m, 50_000, 60_000)).toBe(1);
    expect(musicFadeAt(m, 55_000, 60_000)).toBeCloseTo(0.5, 6);
    // Either side of the last seam, at 59875, the line runs straight on.
    expect(musicFadeAt(m, 59_874, 60_000)).toBeCloseTo(0.0126, 6);
    expect(musicFadeAt(m, 59_875, 60_000)).toBeCloseTo(0.0125, 6);
    expect(musicFadeAt(m, 60_000, 60_000)).toBe(0);
  });

  it('fades all the way out at a stop just past a seam', () => {
    // Repetitions at 0, 4 and 8 s; the stop is 200 ms into the third, a fifth of the fade.
    const m = music({ endMs: 8200, fadeOutMs: 1000 });
    expect(musicFadeAt(m, 7199, 20_000)).toBe(1);
    expect(musicFadeAt(m, 7700, 20_000)).toBeCloseTo(0.5, 6);
    expect(musicFadeAt(m, 7999, 20_000)).toBeCloseTo(0.201, 6);
    expect(musicFadeAt(m, 8000, 20_000)).toBeCloseTo(0.2, 6);
    expect(musicFadeAt(m, 8100, 20_000)).toBeCloseTo(0.1, 6);
    expect(musicFadeAt(m, 8200, 20_000)).toBe(0);
  });

  it('starts a fade out longer than the sound below the level, and still ends it in silence', () => {
    const m = music({ loop: false, outMs: 3000, fadeOutMs: 10_000 });
    expect(musicFadeAt(m, 0, 20_000)).toBeCloseTo(0.3, 6);
    expect(musicFadeAt(m, 3000, 20_000)).toBe(0);
  });

  it('multiplies the two where they overlap on a sound that plays once', () => {
    const m = music({ loop: false, fadeInMs: 3000, fadeOutMs: 3000 });
    expect(musicFadeAt(m, 2000, 20_000)).toBeCloseTo((2 / 3) * (2 / 3), 6);
  });

  it('multiplies them too on a loop stopped inside its first pass', () => {
    // A 30 s section stopped at 3 s, 2 s up and 2 s down: 0.75 x 0.75 in the middle.
    const m = music({ outMs: 30_000, endMs: 3000, fadeInMs: 2000, fadeOutMs: 2000 });
    expect(musicFadeAt(m, 1500, 20_000)).toBeCloseTo(0.5625, 6);
    expect(musicFadeAt(m, 1000, 20_000)).toBeCloseTo(0.5, 6);
    expect(musicFadeAt(m, 2000, 20_000)).toBeCloseTo(0.5, 6);
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

  /*
   * The page's measure of a song is not the file's: WebKit reads a 12 s m4a as 11975 ms. Sent as the
   * section's end, it cut 25 ms off every pass on iOS and clicked at every seam, so a sound that is
   * not trimmed at its end is sent as "to the end of the file" and each engine reads the file.
   */
  it('asks for the end of the file, not the length the page measured, for a sound not trimmed at its end', async () => {
    const outMs = (await wire(music({ sourceDurationMs: 11_975, outMs: 0 }))).audio.music?.outMs ?? 0;
    expect(outMs).toBeGreaterThan(20_000);
  });

  it('sends a trim the customer made as it is', async () => {
    expect((await wire(music({ sourceDurationMs: 11_975, outMs: 9000 }))).audio.music?.outMs).toBe(9000);
  });
});
