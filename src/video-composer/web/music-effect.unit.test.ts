import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SoundEffectRunner, soundEffectPreset } from '../../editor/sound-effects';
import type { ComposeMusic, ComposeSpec } from '../definitions';

import { MIX_SAMPLE_RATE, mixdown } from './audio';
import { buildPlan } from './plan';

/*
 * A sound's effect as the web mix applies it: each repetition through the effect from a state of its
 * own, after any stretch and before the sound's level and fades - [ComposeMusic.effect]'s order, and
 * the order both native engines run their processors in.
 *
 * The decoder is stood in for, as in `music-fades.unit.test.ts`, by one that "decodes"
 * `file:///sine-<hz>-<ms>.m4a` into that many milliseconds of a tone at [LEVEL], so the mix can be
 * held against the reference runner on exactly the samples it was handed.
 */

const LEVEL = 0.5;
const megaphone = soundEffectPreset('megaphone')!.effect;

function tone(hz: number, ms: number): Float32Array {
  const out = new Float32Array(Math.round((ms * MIX_SAMPLE_RATE) / 1000));
  for (let i = 0; i < out.length; i++) out[i] = LEVEL * Math.sin((2 * Math.PI * hz * i) / MIX_SAMPLE_RATE);
  return out;
}

function treated(samples: Float32Array): Float32Array {
  const copy = samples.slice();
  new SoundEffectRunner(megaphone, MIX_SAMPLE_RATE).process([copy, copy.slice()]);
  return copy;
}

function post(music: Partial<ComposeMusic> & Pick<ComposeMusic, 'uri'>, videoMs: number): ComposeSpec {
  return {
    jobId: 'j',
    batchId: 'p',
    clips: [{ key: 'v', uri: 'file:///v.mp4', inMs: 0, outMs: videoMs, speed: 1, volume: 1, muted: false, fit: 'contain' }],
    output: { width: 720, height: 1280, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: {
      originalMuted: true,
      originalVolume: 1,
      music: { startMs: 0, inMs: 0, outMs: 3_600_000, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0, effect: megaphone, ...music },
      voiceover: [],
    },
    posterAtMs: 0,
  };
}

async function mixOf(spec: ComposeSpec): Promise<Float32Array[]> {
  const mix = await mixdown(buildPlan(spec, new Map()), new AbortController().signal);
  if (!mix) throw new Error('nothing was mixed');
  return mix.channels;
}

/** The largest difference between two stretches of samples. */
function worst(a: Float32Array, b: Float32Array): number {
  let most = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) most = Math.max(most, Math.abs((a[i] ?? 0) - (b[i] ?? 0)));
  return most;
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
        const match = /sine-(\d+)-(\d+)/.exec(uri);
        if (!match) throw new Error('no audio track');
        const channel = tone(Number(match[1]), Number(match[2]));
        return { numberOfChannels: 1, sampleRate: MIX_SAMPLE_RATE, length: channel.length, duration: channel.length / MIX_SAMPLE_RATE, getChannelData: () => channel };
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('a sound’s effect in the web mix', () => {
  it('is the reference arithmetic on the very samples the sound plays, from both speakers', async () => {
    const [left, right] = await mixOf(post({ uri: 'file:///sine-440-1000.m4a' }, 2000));
    const expected = treated(tone(440, 1000));
    expect(worst(left!.subarray(0, expected.length), expected)).toBeLessThan(1e-6);
    expect(Array.from(right!.subarray(0, expected.length))).toEqual(Array.from(left!.subarray(0, expected.length)));
    // And the effect changed the sound: a megaphone is not a 440 Hz tone at the same level.
    expect(worst(expected, tone(440, 1000))).toBeGreaterThan(0.05);
  });

  it('comes before the level and the fades, so a fade takes the treated sound down', async () => {
    const [left] = await mixOf(post({ uri: 'file:///sine-700-1000.m4a', volume: 0.5, fadeOutMs: 600 }, 2000));
    const expected = treated(tone(700, 1000));
    const n = expected.length;
    const fadeFrom = n - Math.round(0.6 * MIX_SAMPLE_RATE);
    for (let i = 0; i < n; i++) {
      const fade = i < fadeFrom ? 1 : Math.max(0, 1 - (i - fadeFrom) / (n - fadeFrom));
      expected[i] = expected[i]! * 0.5 * fade;
    }
    expect(worst(left!.subarray(0, n), expected)).toBeLessThan(1e-6);
  });

  it('starts afresh with every repetition of a loop, as each native pass does', async () => {
    const [left] = await mixOf(post({ uri: 'file:///sine-500-400.m4a', loop: true }, 1000));
    const pass = treated(tone(500, 400));
    const n = pass.length;
    expect(worst(left!.subarray(0, n), pass)).toBeLessThan(1e-6);
    expect(worst(left!.subarray(n, 2 * n), pass)).toBeLessThan(1e-6);
  });

  it('leaves a sound with no effect exactly as it always mixed', async () => {
    const plain = post({ uri: 'file:///sine-440-500.m4a' }, 1000);
    delete plain.audio.music!.effect;
    const [left] = await mixOf(plain);
    expect(Array.from(left!.subarray(0, MIX_SAMPLE_RATE / 2))).toEqual(Array.from(tone(440, 500)));
  });
});
