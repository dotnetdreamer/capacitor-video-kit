import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposeMusic, ComposeSpec } from '../definitions';

import { MIX_SAMPLE_RATE, mixdown } from './audio';
import { buildPlan } from './plan';

/*
 * The music's fades as the web mix applies them, sample by sample: one pair of fades over the whole
 * window the music is heard in, `volume * clamp((t - start) / fadeIn) * clamp((stop - t) / fadeOut)`
 * - ComposeMusic's rule, and the preview's `musicFadeAt` - with the loop's seams playing no part.
 *
 * Web Audio is not in the mock DOM, so the decoder is stood in for by one that "decodes"
 * `file:///tone-<ms>.m4a` into that many milliseconds of a constant level. The mix at any sample is
 * then that level times the gain there, and a sample of silence where the music should play is a
 * repetition that was never laid.
 */

const LEVEL = 0.5;

function post(music: Partial<ComposeMusic> & Pick<ComposeMusic, 'uri'>, videoMs: number): ComposeSpec {
  return {
    jobId: 'j',
    batchId: 'p',
    clips: [{ key: 'v', uri: 'file:///v.mp4', inMs: 0, outMs: videoMs, speed: 1, volume: 1, muted: false, fit: 'contain' }],
    output: { width: 720, height: 1280, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: {
      // The clip's own sound off, so the music is all there is to hear.
      originalMuted: true,
      originalVolume: 1,
      music: { startMs: 0, inMs: 0, outMs: 3_600_000, volume: 1, loop: true, fadeInMs: 0, fadeOutMs: 0, ...music },
      voiceover: [],
    },
    posterAtMs: 0,
  };
}

/** The gain the mix left on the music at an output time, read off the left channel. */
async function gainsOf(spec: ComposeSpec): Promise<(ms: number) => number> {
  const mix = await mixdown(buildPlan(spec, new Map()), new AbortController().signal);
  if (!mix) throw new Error('nothing was mixed');
  const left = mix.channels[0];
  return (ms: number) => (left?.[Math.round((ms * MIX_SAMPLE_RATE) / 1000)] ?? Number.NaN) / LEVEL;
}

beforeEach(() => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (uri: string) => ({ ok: true, status: 200, blob: async () => new Blob([uri]) })),
  );
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      async decodeAudioData(bytes: ArrayBuffer) {
        const uri = new TextDecoder().decode(bytes);
        const ms = Number(/tone-(\d+)/.exec(uri)?.[1]);
        if (!(ms > 0)) throw new Error('no audio track');
        const channel = new Float32Array(Math.round((ms * MIX_SAMPLE_RATE) / 1000)).fill(LEVEL);
        return { numberOfChannels: 1, sampleRate: MIX_SAMPLE_RATE, length: channel.length, duration: ms / 1000, getChannelData: () => channel };
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the music fades in the web mix', () => {
  /*
   * WebKit reads a 12 s song as 11975 ms. The spec now asks for the end of the file rather than that
   * number, and the mix loops the file at the length it decoded - here 11975, the worst case, which
   * leaves a 60 s post a 125 ms last pass. The fade out used to belong to that pass alone.
   */
  it('reaches silence at the end of a post a sliver longer than a whole number of passes', async () => {
    const gain = await gainsOf(post({ uri: 'file:///tone-11975.m4a', fadeOutMs: 10_000 }, 60_000));
    // Laid at the decoded length: every pass is heard, not one pass as long as the asked end.
    for (const ms of [1000, 11_974, 11_976, 30_000, 47_000]) expect(gain(ms)).toBeCloseTo(1, 4);
    expect(gain(55_000)).toBeCloseTo(0.5, 4);
    // Straight on across the last seam, at 59875.
    expect(gain(59_874)).toBeCloseTo(0.0126, 3);
    expect(gain(59_876)).toBeCloseTo(0.0124, 3);
    expect(gain(59_999.98)).toBeLessThan(0.0001);
  });

  it('fades all the way out at a stop just past a seam', async () => {
    // A 4 s section stopped at 8.2 s: the last pass is 200 ms of a 1 s fade.
    const gain = await gainsOf(post({ uri: 'file:///tone-4000.m4a', outMs: 4000, endMs: 8200, fadeOutMs: 1000 }, 10_000));
    expect(gain(7000)).toBeCloseTo(1, 4);
    expect(gain(7700)).toBeCloseTo(0.5, 4);
    expect(gain(8100)).toBeCloseTo(0.1, 4);
    expect(gain(8199.98)).toBeLessThan(0.0001);
    expect(gain(8300)).toBe(0);
  });

  it('runs a fade in longer than the section on across its seams', async () => {
    const gain = await gainsOf(post({ uri: 'file:///tone-800.m4a', outMs: 800, fadeInMs: 3000 }, 6000));
    expect(gain(500)).toBeCloseTo(500 / 3000, 4);
    // Into the second and fourth passes at the level the line has reached, not back at the full level.
    expect(gain(1500)).toBeCloseTo(0.5, 4);
    expect(gain(2500)).toBeCloseTo(2500 / 3000, 4);
    expect(gain(4000)).toBeCloseTo(1, 4);
  });

  it('multiplies overlapping fades on a sound that plays once, and ends it where the file ends', async () => {
    const gain = await gainsOf(post({ uri: 'file:///tone-3000.m4a', loop: false, fadeInMs: 2000, fadeOutMs: 2000 }, 10_000));
    expect(gain(1000)).toBeCloseTo(0.5, 4);
    expect(gain(1500)).toBeCloseTo(0.75 * 0.75, 4);
    expect(gain(2000)).toBeCloseTo(0.5, 4);
    expect(gain(2999.98)).toBeLessThan(0.0001);
    expect(gain(3500)).toBe(0);
  });

  it('holds a fade out longer than the music to its slope, starting below the level', async () => {
    const gain = await gainsOf(post({ uri: 'file:///tone-3000.m4a', loop: false, fadeOutMs: 10_000 }, 10_000));
    expect(gain(0)).toBeCloseTo(0.3, 4);
    expect(gain(1500)).toBeCloseTo(0.15, 4);
  });
});
