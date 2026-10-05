import { describe, expect, it } from 'vitest';

import { MIN_LAYER_MS, emptyManifest, normaliseManifest, type EditMusic } from './edit-manifest';
import { patchMusic } from './edit-ops';

/*
 * A stored sound whose section or stop is under MIN_LAYER_MS: one `patchMusic` would refuse every
 * change to, handing the manifest back as it was. Every control on the music goes through that one
 * function - the volume, both fades, Loop, Start here, the drag - so read as it was stored, such a
 * sound could be neither heard nor changed. The reader clears the end that breaks the rule instead,
 * to 0: to the end of the track for a section, until the end for a stop.
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

const read = (m: EditMusic) => normaliseManifest({ ...emptyManifest(), music: m });

describe('reading a stored sound whose stop is not after its start', () => {
  it('keeps a looping start trim beyond one source cycle when reopening a draft', () => {
    expect(read(music({ sourceDurationMs: 4000, outMs: 0, startMs: 10_000, phaseMs: 10_000 })).music).toMatchObject({
      startMs: 10_000,
      phaseMs: 10_000,
      inMs: 0,
      outMs: 0,
    });
  });

  it('keeps a negative phase so the render can wrap it against its own file length', () => {
    expect(read(music({ startMs: 0, phaseMs: -5000 })).music?.phaseMs).toBe(-5000);
  });

  it('clears a stop before the start, at it, or less than MIN_LAYER_MS after it', () => {
    for (const endMs of [1000, 2000, 2000 + MIN_LAYER_MS - 1]) {
      expect(read(music({ startMs: 2000, endMs })).music?.endMs, `endMs ${endMs}`).toBe(0);
    }
  });

  it('keeps a stop MIN_LAYER_MS after the start, measured in whole milliseconds as patchMusic measures it', () => {
    expect(read(music({ startMs: 2000, endMs: 2000 + MIN_LAYER_MS })).music?.endMs).toBe(2000 + MIN_LAYER_MS);
    // 99.6ms raw, 100ms once rounded - which is what patchMusic would keep.
    expect(read(music({ startMs: 2000, endMs: 2099.6 })).music?.endMs).toBe(2099.6);
  });

  it('clears a section that ends at or too soon after its start, and keeps one that does not', () => {
    expect(read(music({ inMs: 5000, outMs: 3000 })).music?.outMs).toBe(0);
    expect(read(music({ inMs: 5000, outMs: 5000 + MIN_LAYER_MS - 1 })).music?.outMs).toBe(0);
    expect(read(music({ inMs: 5000, outMs: 5000 + MIN_LAYER_MS })).music?.outMs).toBe(5000 + MIN_LAYER_MS);
  });

  it('leaves everything else about the sound as it was', () => {
    const next = read(music({ startMs: 2000, endMs: 1000, volume: 0.5, fadeInMs: 800, fadeOutMs: 1200 })).music;
    expect(next).toEqual(music({ startMs: 2000, endMs: 0, volume: 0.5, fadeInMs: 800, fadeOutMs: 1200 }));
  });

  it('can be changed again once read, where the stored one could not', () => {
    const stored = { ...emptyManifest(), music: music({ startMs: 2000, endMs: 1000 }) };
    // What the editor's controls met before: every change refused.
    expect(patchMusic(stored, { volume: 0.3 })).toBe(stored);
    expect(patchMusic(normaliseManifest(stored), { volume: 0.3 }).music?.volume).toBe(0.3);
  });
});
