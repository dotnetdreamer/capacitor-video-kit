import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIO_EFFECT_RAMP_MS, type ComposeAudioEffect, type ComposeMusic, type ComposeSpec } from '../definitions';

import { MIX_SAMPLE_RATE, mixWindow, mixdown, type AudioSourceReader, type DecodedSource } from './audio';
import { buildPlan } from './plan';
import { SpecError, validateSpec } from './spec';

/*
 * The audio effect windows in the web render: read off the spec by the shared rules, and run on the
 * finished mix - after it is held to -1..1, as both phones run theirs on a mix their mixer has already
 * held - so the render a browser makes is the one a phone makes. The arithmetic itself is
 * `audio-effect-windows.unit.test.ts`'s.
 *
 * Web Audio is not in the mock DOM, so decoding is stood in for as the music's tests stand it in.
 */

const LEVEL = 0.75;

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

function post(sounds: Partial<ComposeMusic>[], effects?: unknown, videoMs = 6000): ComposeSpec {
  return {
    jobId: 'j',
    batchId: 'b',
    clips: [{ key: 'v', uri: 'file:///v.mp4', inMs: 0, outMs: videoMs, speed: 1, volume: 1, muted: false, fit: 'contain' }],
    output: { width: 720, height: 1280, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: {
      originalMuted: true,
      originalVolume: 1,
      music: null,
      musicTracks: sounds.map(sound => [{ uri: 'file:///tone-5000.m4a', startMs: 0, inMs: 0, outMs: 3_600_000, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0, ...sound }]),
      voiceover: [],
      ...(effects !== undefined ? { effects: effects as ComposeAudioEffect[] } : {}),
    },
    posterAtMs: 0,
  };
}

const halve: ComposeAudioEffect['effect'] = { ops: [{ op: 'gain', db: -6.020599913279624 }] };

function refusal(spec: ComposeSpec): string {
  try {
    validateSpec(spec);
  } catch (error) {
    if (error instanceof SpecError) return error.message;
    throw error;
  }
  return 'accepted';
}

describe('the windows on the wire', () => {
  it('are read by the shared rules, a window that changes nothing left off and none no key at all', () => {
    const read = validateSpec(post([{}], [{ startMs: -5, endMs: 900, speed: 0.1, effect: halve }, { startMs: 900, endMs: 1000 }]));
    expect(read.audio.effects).toEqual([{ startMs: 0, endMs: 900, speed: 0.5, effect: halve }]);
    expect('effects' in validateSpec(post([{}])).audio).toBe(false);
    expect('effects' in validateSpec(post([{}], [])).audio).toBe(false);
  });

  it('are refused with the path that broke', () => {
    expect(refusal(post([{}], 'loud'))).toBe('invalid_spec:audio.effects');
    expect(refusal(post([{}], [{ startMs: 0, endMs: 0, effect: halve }]))).toBe('invalid_spec:audio.effects[0].endMs');
    expect(refusal(post([{}], [{ startMs: 0, endMs: 900, effect: { ops: [{ op: 'gain' }] } }]))).toBe('invalid_spec:audio.effects[0].effect.ops[0].db');
    expect(refusal(post([{}], [{ startMs: 0, endMs: 900, effect: { ops: new Array(17).fill({ op: 'gain', db: 1 }) } }]))).toBe(
      'invalid_spec:audio.effects[0].effect.ops at most 16 steps',
    );
    expect(refusal(post([{}], new Array(51).fill(0).map((_, i) => ({ startMs: i * 10, endMs: i * 10 + 5, effect: halve }))))).toBe('invalid_spec:audio.effects at most 50 windows');
    expect(refusal(post([{}], [{ startMs: 0, endMs: 900, effect: halve }, { startMs: 800, endMs: 1000, effect: halve }]))).toBe('invalid_spec:audio.effects[1].startMs');
  });
});

describe('the windows in the web mix', () => {
  const at = (mix: { channels: Float32Array[] }, ms: number) => mix.channels[0]![Math.round((ms * MIX_SAMPLE_RATE) / 1000)]!;

  it('run on the mix held to -1..1, as a phone’s mixer holds it', async () => {
    // Two sounds at 0.75 sum to 1.5, held to 1: halved, that is 0.5, where halving first would be 0.75.
    const mix = (await mixdown(buildPlan(validateSpec(post([{}, {}], [{ startMs: 1000, endMs: 3000, effect: halve }])), new Map()), new AbortController().signal))!;
    expect(at(mix, 500)).toBe(1);
    expect(at(mix, 2000)).toBeCloseTo(0.5, 6);
    expect(at(mix, 4000)).toBe(1);
  });

  it('come in and go out over the ramp, and change nothing outside the window and its tail', async () => {
    const mix = (await mixdown(buildPlan(validateSpec(post([{}], [{ startMs: 1000, endMs: 3000, effect: halve }])), new Map()), new AbortController().signal))!;
    expect(at(mix, 1000)).toBeCloseTo(LEVEL, 6);
    expect(at(mix, 1000 + AUDIO_EFFECT_RAMP_MS / 2)).toBeCloseTo(LEVEL * 0.75, 4);
    expect(at(mix, 2000)).toBeCloseTo(LEVEL / 2, 6);
    expect(at(mix, 3000)).toBeCloseTo(LEVEL, 6);
    expect(at(mix, 4900)).toBe(LEVEL);
  });

  it('play a slowed window from its start, and go back to where the timeline is after it', async () => {
    // A sound that steps from 0.75 to silence at 2 s: slowed to half from 1 s, the step is heard at 3 s.
    const mix = (await mixdown(buildPlan(validateSpec(post([{ uri: 'file:///tone-2000.m4a' }], [{ startMs: 1000, endMs: 4000, speed: 0.5 }])), new Map()), new AbortController().signal))!;
    expect(at(mix, 2500)).toBeCloseTo(LEVEL, 4);
    expect(at(mix, 3500)).toBeCloseTo(0, 4);
  });
});

describe('a stretch of the mix for the preview', () => {
  it('is that stretch of the dry mix, sample for sample, with only the sources heard there read', async () => {
    const spec = validateSpec(post([{}, { uri: 'file:///tone-1000.m4a', startMs: 5000 }], [{ startMs: 1000, endMs: 2000, effect: halve }]));
    const plan = buildPlan(spec, new Map());
    const dry = (await mixdown(buildPlan({ ...spec, audio: { ...spec.audio, effects: [] } }, new Map()), new AbortController().signal))!;
    const read: string[] = [];
    const reader: AudioSourceReader = {
      get: async (uri: string): Promise<DecodedSource | null> => {
        read.push(uri);
        const ms = Number(/tone-(\d+)/.exec(uri)?.[1]);
        return { sampleRate: MIX_SAMPLE_RATE, channels: [new Float32Array(Math.round((ms * MIX_SAMPLE_RATE) / 1000)).fill(LEVEL)] };
      },
      done: () => undefined,
      close: () => undefined,
    };
    const from = MIX_SAMPLE_RATE;
    const to = 3 * MIX_SAMPLE_RATE;
    const stretch = (await mixWindow(plan, from, to, MIX_SAMPLE_RATE, reader, new AbortController().signal))!;
    expect(stretch.length).toBe(to - from);
    for (let i = 0; i < stretch.length; i += 997) expect(stretch.channels[0]![i]).toBe(dry.channels[0]![from + i]);
    expect(read).toEqual(['file:///tone-5000.m4a']);
  });
});
