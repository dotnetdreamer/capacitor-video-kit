import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AUDIO_EFFECT_RAMP_MS, type ComposeAudioEffect, type ComposeMusic, type ComposeSpec } from '../video-composer/definitions';
import { buildPlan } from '../video-composer/web/plan';

import { COPY_RATES, CopySources, MAX_COPY_TAIL_MS, copyGroups, copySoundKey, copyTailMs, makeEffectCopy } from './effect-copy';

/*
 * The preview's copy of what audio effect layers make of the post's sound: the web render's own mix
 * over the layers' windows, through the windows' arithmetic, as a WAV on the post's timeline.
 *
 * Web Audio is not in the mock DOM, so decoding is stood in for as the web mix's tests stand it in:
 * `file:///tone-<ms>.m4a` "decodes" into that many milliseconds of a constant level, and every fetch is
 * counted, so a source read twice shows.
 */

const LEVEL = 0.5;
let fetches: string[] = [];

beforeEach(() => {
  fetches = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (uri: string) => {
      fetches.push(uri);
      return { ok: true, status: 200, blob: async () => new Blob([uri]) };
    }),
  );
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      constructor(
        readonly channels: number,
        readonly length: number,
        readonly sampleRate: number,
      ) {}
      async decodeAudioData(bytes: ArrayBuffer) {
        const uri = new TextDecoder().decode(bytes);
        const ms = Number(/tone-(\d+)/.exec(uri)?.[1]);
        if (!(ms > 0)) throw new Error('no audio track');
        const channel = new Float32Array(Math.round((ms * this.sampleRate) / 1000)).fill(LEVEL);
        return { numberOfChannels: 1, sampleRate: this.sampleRate, length: channel.length, duration: ms / 1000, getChannelData: () => channel };
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function post(sounds: Partial<ComposeMusic>[], videoMs = 20_000): ComposeSpec {
  return {
    jobId: 'j',
    batchId: 'b',
    clips: [{ key: 'v', uri: 'file:///v.mp4', inMs: 0, outMs: videoMs, speed: 1, volume: 1, muted: false, fit: 'contain' }],
    output: { width: 2, height: 2, fps: 30, videoBitrate: 0, audioBitrate: 0 },
    filter: [],
    overlays: [],
    audio: {
      // The clip's own sound off, so the sounds are all there is to hear.
      originalMuted: true,
      originalVolume: 1,
      music: null,
      musicTracks: [sounds.map(sound => ({ uri: 'file:///tone-20000.m4a', startMs: 0, inMs: 0, outMs: 3_600_000, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0, ...sound }))],
      voiceover: [],
    },
    posterAtMs: 0,
  };
}

/** The samples of a 16-bit WAV, frame by frame, as -1..1, from its first channel. */
async function samplesOf(blob: Blob): Promise<{ rate: number; at: (frame: number) => number; frames: number }> {
  const view = new DataView(await blob.arrayBuffer());
  const channels = view.getUint16(22, true);
  const rate = view.getUint32(24, true);
  const frames = view.getUint32(40, true) / (2 * channels);
  return { rate, frames, at: frame => view.getInt16(44 + frame * channels * 2, true) / 32768 };
}

const halve: ComposeAudioEffect['effect'] = { ops: [{ op: 'gain', db: -6.020599913279624 }] };

describe('which layers share a copy', () => {
  it('puts layers too close for one to ring out before the next into one copy, and keeps the rest apart', () => {
    const windows = [
      { startMs: 0, endMs: 1000 },
      { startMs: 1000 + MAX_COPY_TAIL_MS - 1, endMs: 8000 },
      { startMs: 8000 + MAX_COPY_TAIL_MS, endMs: 20_000 },
    ];
    expect(copyGroups(windows)).toEqual([[windows[0], windows[1]], [windows[2]]]);
    expect(copyGroups([])).toEqual([]);
  });

  it('puts stacked layers in one copy, in the order they stack, grouped by when they are heard', () => {
    // Bottom to top: a long one, one far later, and one stacked inside the first, which starts first.
    const long = { startMs: 1000, endMs: 9000 };
    const later = { startMs: 9000 + MAX_COPY_TAIL_MS, endMs: 20_000 };
    const inside = { startMs: 500, endMs: 2000 };
    expect(copyGroups([long, later, inside])).toEqual([[long, inside], [later]]);
    // A short layer under a long one does not end the group the long one is still heard in.
    const short = { startMs: 0, endMs: 100 };
    const over = { startMs: 0, endMs: 9000 };
    const after = { startMs: 100 + MAX_COPY_TAIL_MS + 1, endMs: 12_000 };
    expect(copyGroups([short, over, after])).toEqual([[short, over, after]]);
  });

  it('lets a copy ring on for its longest reverb, a moment without one, and never past the longest room', () => {
    expect(copyTailMs(null)).toBe(50);
    expect(copyTailMs({ ops: [{ op: 'reverb', decayMs: 3500, dampHz: 5500, wet: 0.5, dry: 0.8 }] })).toBe(3500);
    expect(copyTailMs({ ops: [{ op: 'reverb', decayMs: 20_000, dampHz: 5500, wet: 0.5, dry: 0.8 }] })).toBe(MAX_COPY_TAIL_MS);
  });
});

describe('what a copy is made of', () => {
  const windows = [{ startMs: 5000, endMs: 8000 }];

  it('is the same whatever is done far from the layer, and whatever its sliders say', () => {
    const near = buildPlan(post([{ startMs: 4000 }]), new Map());
    const far = buildPlan(post([{ startMs: 4000 }, { uri: 'file:///tone-1000.m4a', startMs: 18_000 }]), new Map());
    expect(copySoundKey(far, windows)).toBe(copySoundKey(near, windows));
  });

  it('is another for a sound moved under the layer, and for the layer moved', () => {
    const plan = buildPlan(post([{ startMs: 4000 }]), new Map());
    expect(copySoundKey(buildPlan(post([{ startMs: 4500 }]), new Map()), windows)).not.toBe(copySoundKey(plan, windows));
    expect(copySoundKey(buildPlan(post([{ startMs: 4000, volume: 0.5 }]), new Map()), windows)).not.toBe(copySoundKey(plan, windows));
    expect(copySoundKey(plan, [{ startMs: 5000, endMs: 9000 }])).not.toBe(copySoundKey(plan, windows));
  });

  it('is the same for the same layers stacked another way: the order is the effects', () => {
    const plan = buildPlan(post([{ startMs: 0 }]), new Map());
    const a = { startMs: 5000, endMs: 8000 };
    const b = { startMs: 2000, endMs: 6000 };
    expect(copySoundKey(plan, [a, b])).toBe(copySoundKey(plan, [b, a]));
    // And reads from just before the earliest, wherever it is in the stack.
    const early = buildPlan(post([{ startMs: 0 }, { uri: 'file:///tone-1000.m4a', startMs: 1500 }]), new Map());
    expect(copySoundKey(early, [a, b])).not.toBe(copySoundKey(plan, [a, b]));
  });
});

describe('a copy', () => {
  it('is the mix over the layer and its tail, put through the layer, from the layer’s start', async () => {
    const plan = buildPlan(post([{ startMs: 0 }]), new Map());
    const window: ComposeAudioEffect = { startMs: 1000, endMs: 3000, effect: halve };
    const made = (await makeEffectCopy(plan, [window], new CopySources(), new AbortController().signal))!;
    const rate = COPY_RATES[0]!;
    expect(made.startMs).toBe(1000);
    expect(made.endMs).toBe(3000 + copyTailMs(halve));
    const wav = await samplesOf(made.blob);
    expect(wav.rate).toBe(rate);
    expect(wav.frames).toBe(Math.round(((made.endMs - made.startMs) * rate) / 1000));
    // In at the mix itself, down over the ramp, halved inside, and back out to the mix at its end.
    expect(wav.at(0)).toBeCloseTo(LEVEL, 3);
    expect(wav.at(Math.round((AUDIO_EFFECT_RAMP_MS * rate) / 2000))).toBeCloseTo(LEVEL * 0.75, 2);
    expect(wav.at(rate)).toBeCloseTo(LEVEL / 2, 3);
    expect(wav.at(wav.frames - 1)).toBeCloseTo(LEVEL, 3);
  });

  it('starts at the earliest layer of a stack, wherever it is, and runs them in the order they stack', async () => {
    const plan = buildPlan(post([{ startMs: 0 }]), new Map());
    const windows: ComposeAudioEffect[] = [
      { startMs: 2000, endMs: 3000, effect: halve },
      { startMs: 1000, endMs: 4000, effect: halve },
    ];
    const made = (await makeEffectCopy(plan, windows, new CopySources(), new AbortController().signal))!;
    const rate = COPY_RATES[0]!;
    expect(made.startMs).toBe(1000);
    const wav = await samplesOf(made.blob);
    expect(wav.at(Math.round(0.5 * rate))).toBeCloseTo(LEVEL / 2, 3);
    expect(wav.at(Math.round(1.5 * rate))).toBeCloseTo(LEVEL / 4, 3);
    expect(wav.at(Math.round(2.5 * rate))).toBeCloseTo(LEVEL / 2, 3);
  });

  it('runs every window of a group, each on what the one before it left', async () => {
    const plan = buildPlan(post([{ startMs: 0 }]), new Map());
    const windows: ComposeAudioEffect[] = [
      { startMs: 1000, endMs: 2000, effect: halve },
      { startMs: 2000, endMs: 3000, effect: { ops: [{ op: 'gain', db: -12.041199826559248 }] } },
    ];
    const made = (await makeEffectCopy(plan, windows, new CopySources(), new AbortController().signal))!;
    const wav = await samplesOf(made.blob);
    expect(wav.at(Math.round(0.5 * wav.rate))).toBeCloseTo(LEVEL / 2, 3);
    expect(wav.at(Math.round(1.5 * wav.rate))).toBeCloseTo(LEVEL / 4, 3);
  });

  it('is not made over silence, which a layer changes nothing of', async () => {
    const plan = buildPlan(post([{ startMs: 10_000 }]), new Map());
    expect(await makeEffectCopy(plan, [{ startMs: 1000, endMs: 3000, effect: halve }], new CopySources(), new AbortController().signal)).toBeNull();
  });

  it('decodes a source once for every copy made from it', async () => {
    const plan = buildPlan(post([{ startMs: 0 }]), new Map());
    const sources = new CopySources();
    await makeEffectCopy(plan, [{ startMs: 1000, endMs: 3000, effect: halve }], sources, new AbortController().signal);
    await makeEffectCopy(plan, [{ startMs: 1000, endMs: 3000, speed: 0.7 }], sources, new AbortController().signal);
    expect(fetches.filter(uri => uri.includes('tone-20000'))).toHaveLength(1);
  });

  it('lets go of the least recently used source past its budget', async () => {
    const sources = new CopySources(() => false, 1);
    await sources.get('file:///tone-1000.m4a', false);
    await sources.get('file:///tone-2000.m4a', false);
    await sources.get('file:///tone-1000.m4a', false);
    expect(fetches).toEqual(['file:///tone-1000.m4a', 'file:///tone-2000.m4a', 'file:///tone-1000.m4a']);
  });

  it('is not made from a source too long to decode on a phone', async () => {
    const plan = buildPlan(post([{ startMs: 0 }]), new Map());
    const sources = new CopySources(uri => uri.includes('tone-20000'));
    sources.begin();
    expect(await makeEffectCopy(plan, [{ startMs: 1000, endMs: 3000, effect: halve }], sources, new AbortController().signal)).toBeNull();
    expect(sources.refused).toBe(true);
  });
});
