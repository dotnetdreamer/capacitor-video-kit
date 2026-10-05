import { describe, expect, it } from 'vitest';

import { toComposeSpec } from './compose';
import { MIN_LAYER_MS, defaultClipEdit, emptyManifest, normaliseManifest, type EditManifest, type EditMusic } from './edit-manifest';
import { musicMovedTo, musicSourceMsAt, musicWindow, patchMusic } from './edit-ops';
import type { RasterContext } from './raster-context';

/*
 * A sound's stop: `endMs`, where it goes quiet on the post. It is what the end handle of a LOOPING
 * sound sets - the section keeps repeating, and stops there instead of at the end of the video.
 */

/** Four seconds of a thirty second track, looping from the start of the post. */
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

describe('musicWindow', () => {
  it('runs a looping sound with no stop to the end of the video', () => {
    expect(musicWindow(music(), 20_000)).toEqual({ startMs: 0, endMs: 20_000 });
  });

  it('stops a looping sound at its stop, partway through a repeat', () => {
    expect(musicWindow(music({ startMs: 1000, endMs: 9500 }), 20_000)).toEqual({ startMs: 1000, endMs: 9500 });
  });

  it('holds a stop past the end of the video to the end of the video', () => {
    expect(musicWindow(music({ endMs: 25_000 }), 20_000)).toEqual({ startMs: 0, endMs: 20_000 });
  });

  it('stops a sound that plays once at whichever comes first, its section or its stop', () => {
    expect(musicWindow(music({ loop: false, endMs: 3000 }), 20_000).endMs).toBe(3000);
    expect(musicWindow(music({ loop: false, endMs: 9000 }), 20_000).endMs).toBe(4000);
  });

  it('is silent past the stop, and repeats the section before it', () => {
    const m = music({ endMs: 9500 });
    expect(musicSourceMsAt(m, 5000, 20_000)).toBe(1000);
    expect(musicSourceMsAt(m, 9499, 20_000)).toBe(1499);
    expect(musicSourceMsAt(m, 9500, 20_000)).toBeNull();
  });

  it('starts partway through a loop, then repeats its full section', () => {
    const m = music({ phaseMs: 2500 });
    expect(musicSourceMsAt(m, 0, 20_000)).toBe(2500);
    expect(musicSourceMsAt(m, 1499, 20_000)).toBe(3999);
    expect(musicSourceMsAt(m, 1500, 20_000)).toBe(0);
    expect(musicSourceMsAt(m, 5500, 20_000)).toBe(0);
  });

  it('plays only the rest of the first pass when looping is turned off', () => {
    const m = music({ loop: false, phaseMs: 2500 });
    expect(musicWindow(m, 20_000)).toEqual({ startMs: 0, endMs: 1500 });
    expect(musicSourceMsAt(m, 1000, 20_000)).toBe(3500);
    expect(musicSourceMsAt(m, 1500, 20_000)).toBeNull();
  });
});

describe('musicMovedTo', () => {
  it('carries the stop along, so what is heard keeps its length', () => {
    expect(musicMovedTo(music({ startMs: 1000, endMs: 6000 }), 3000, 20_000)).toEqual({ startMs: 3000, endMs: 8000 });
  });

  it('goes back to "until the end" once the stop reaches the end of the video', () => {
    expect(musicMovedTo(music({ startMs: 1000, endMs: 6000 }), 16_000, 20_000)).toEqual({ startMs: 16_000, endMs: 0 });
  });

  it('leaves a sound with no stop without one', () => {
    expect(musicMovedTo(music(), 2500.4, 20_000)).toEqual({ startMs: 2500, endMs: 0 });
  });
});

describe('patchMusic', () => {
  const post = (m: EditMusic): EditManifest => ({ ...emptyManifest(), music: m });

  it('sets a stop, in whole milliseconds', () => {
    expect(patchMusic(post(music()), { endMs: 7000.6 }).music?.endMs).toBe(7001);
  });

  it('refuses a stop that leaves less than MIN_LAYER_MS of sound', () => {
    const before = post(music({ startMs: 5000 }));
    expect(patchMusic(before, { endMs: 5000 + MIN_LAYER_MS - 1 })).toBe(before);
  });

  it('treats music built before the field existed as "until the end"', () => {
    const { endMs: _, ...old } = music();
    const next = patchMusic(post(old as EditMusic), { volume: 0.5 });
    expect(next.music?.endMs).toBe(0);
  });
});

describe('reading a stored post', () => {
  it('reads an older sound, which has no stop, as "until the end"', () => {
    const { endMs: _, ...old } = music();
    expect(normaliseManifest({ ...emptyManifest(), version: 11, music: old }).music?.endMs).toBe(0);
  });

  it('keeps a stop it finds', () => {
    expect(normaliseManifest({ ...emptyManifest(), music: music({ endMs: 8000 }) }).music?.endMs).toBe(8000);
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

  it('sends a stop that cuts the sound short', async () => {
    expect((await wire(music({ endMs: 9500 }))).audio.music?.endMs).toBe(9500);
  });

  it('sends the first-pass phase of a trimmed loop', async () => {
    expect((await wire(music({ phaseMs: 2500 }))).audio.music?.phaseMs).toBe(2500);
  });

  it('leaves the key off for a sound that plays to the end, so the spec is the one it always was', async () => {
    expect((await wire(music())).audio.music).not.toHaveProperty('endMs');
    expect((await wire(music({ endMs: 20_000 }))).audio.music).not.toHaveProperty('endMs');
  });
});
