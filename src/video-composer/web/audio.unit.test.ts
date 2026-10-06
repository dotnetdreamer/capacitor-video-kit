import { BufferTarget, EncodedAudioPacketSource, EncodedPacket, Mp4OutputFormat, Output } from 'mediabunny';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposeClip, ComposeSpec } from '../definitions';

import { MIX_SAMPLE_RATE, mixdown, presentedSoundUs, sourceUses } from './audio';
import { buildPlan, type ProbedInput } from './plan';

/*
 * Which sources the mix decodes, and how often - not what it sounds like, which is
 * `render.cmp.test.ts`'s, through a real decoder. Web Audio is not in the mock DOM, so the context
 * is stood in for by one that "decodes" a file into a few seconds of samples made from its name, and
 * refuses the one file that stands for a video with no sound.
 */

const SILENT = 'file:///silent.mp4';

function clip(key: string, uri: string, inMs: number, outMs: number, over: Partial<ComposeClip> = {}): ComposeClip {
  return { key, uri, inMs, outMs, speed: 1, volume: 1, muted: false, fit: 'contain', ...over };
}

/**
 * A post that names most of its files more than once, in every place a mix asks for one: a clip
 * split around another, the transition tail that continues it, the same file on a layer, a file
 * with no sound twice, and one sound as both the music and a take.
 */
function post(): ComposeSpec {
  return {
    jobId: 'j',
    batchId: 'p',
    clips: [
      clip('a1', 'file:///a.mp4', 0, 500),
      clip('b', 'file:///b.mp4', 0, 2000, {
        transitionIn: { kind: 'dissolve', from: clip('a-tail', 'file:///a.mp4', 500, 1000), curves: { alpha: [0, 1] } },
      }),
      clip('a2', 'file:///a.mp4', 1000, 2000),
      clip('s1', SILENT, 0, 500),
      clip('s2', SILENT, 500, 1000),
    ],
    tracks: [{ id: 'layer', z: 1, clips: [clip('c', 'file:///c.mp4', 0, 1000), clip('a3', 'file:///a.mp4', 2000, 3000)] }],
    output: { width: 720, height: 1280, fps: 30, videoBitrate: 6_000_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: {
      originalMuted: false,
      originalVolume: 1,
      music: { uri: 'file:///m.m4a', startMs: 0, inMs: 0, outMs: 1000, volume: 0.5, loop: true, fadeInMs: 0, fadeOutMs: 0 },
      voiceover: [
        { uri: 'file:///v.m4a', startMs: 200, durationMs: 500, volume: 1 },
        { uri: 'file:///m.m4a', startMs: 1500, durationMs: 300, volume: 0.8 },
      ],
    },
    posterAtMs: 0,
  };
}

const probe: ProbedInput = { durationMs: 10_000, width: 1920, height: 1080, hasAudio: true, hasVideo: true };

function planOf(spec: ComposeSpec) {
  const uris = [...spec.clips, ...(spec.tracks ?? []).flatMap((track) => track.clips)].map((c) => c.uri);
  return buildPlan(spec, new Map(uris.map((uri) => [uri, probe])));
}

let decoded: Map<string, number>;

beforeEach(() => {
  decoded = new Map();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (uri: string) => ({ ok: true, status: 200, blob: async () => new Blob([uri]) })),
  );
  vi.stubGlobal(
    'OfflineAudioContext',
    class {
      async decodeAudioData(bytes: ArrayBuffer) {
        const uri = new TextDecoder().decode(bytes);
        decoded.set(uri, (decoded.get(uri) ?? 0) + 1);
        if (uri === SILENT) throw new Error('no audio track');
        const seed = [...uri].reduce((sum, char) => sum + char.charCodeAt(0), 0);
        const channel = Float32Array.from({ length: 4 * MIX_SAMPLE_RATE }, (_, i) => Math.sin((i + seed) / 50) * 0.25);
        return { numberOfChannels: 1, sampleRate: MIX_SAMPLE_RATE, length: channel.length, duration: 4, getChannelData: () => channel };
      }
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('sourceUses', () => {
  it('counts every ask the mix makes for a file, with the skip rules its loops use', () => {
    const spec = post();
    // Removed audio is never asked for, so it is not counted either.
    spec.clips.push(clip('muted', 'file:///muted.mp4', 0, 500, { muted: true }));

    expect(Object.fromEntries(sourceUses(planOf(spec)))).toEqual({
      'file:///a.mp4': 4,
      'file:///b.mp4': 1,
      [SILENT]: 2,
      'file:///c.mp4': 1,
      'file:///m.m4a': 2,
      'file:///v.m4a': 1,
    });
  });
});

describe('mixdown', () => {
  it('mixes legacy music with sequential clips and an overlapping lane', async () => {
    const spec = post();
    spec.clips = [clip('muted', 'file:///base.mp4', 0, 3000, { muted: true })];
    spec.tracks = [];
    spec.audio.voiceover = [];
    spec.audio.music = { uri: 'file:///legacy.m4a', startMs: 0, inMs: 0, outMs: 3000, volume: 0.1, loop: false, fadeInMs: 0, fadeOutMs: 0 };
    const sound = (uri: string, startMs: number, endMs: number) => ({
      uri, startMs, endMs, inMs: 0, outMs: endMs - startMs, volume: 0.2, loop: false, fadeInMs: 0, fadeOutMs: 0,
    });
    spec.audio.musicTracks = [
      [sound('file:///one.m4a', 0, 1000), sound('file:///two.m4a', 1000, 2000)],
      [sound('file:///overlap.m4a', 500, 1800)],
    ];
    const mix = await mixdown(planOf(spec), new AbortController().signal);
    const at = 1.25 * MIX_SAMPLE_RATE;
    const sample = (uri: string, offset: number) => {
      const seed = [...uri].reduce((sum, char) => sum + char.charCodeAt(0), 0);
      return Math.sin((offset + seed) / 50) * 0.25;
    };
    expect(mix?.channels[0]?.[at]).toBeCloseTo(
      sample('file:///legacy.m4a', at) * 0.1 +
      sample('file:///two.m4a', 0.25 * MIX_SAMPLE_RATE) * 0.2 +
      sample('file:///overlap.m4a', 0.75 * MIX_SAMPLE_RATE) * 0.2,
      5,
    );
    expect(decoded.get('file:///one.m4a')).toBe(1);
    expect(decoded.get('file:///two.m4a')).toBe(1);
    expect(decoded.get('file:///overlap.m4a')).toBe(1);
  });

  /*
   * Letting a source go after its last placement must never let it go BEFORE one: a count one short
   * would decode that file a second time. A file that would not decode is not tried twice either.
   */
  it('decodes every file once, however many placements ask for it', async () => {
    const mix = await mixdown(planOf(post()), new AbortController().signal);

    expect(mix).not.toBeNull();
    expect(Object.fromEntries(decoded)).toEqual({
      'file:///a.mp4': 1,
      'file:///b.mp4': 1,
      [SILENT]: 1,
      'file:///c.mp4': 1,
      'file:///m.m4a': 1,
      'file:///v.m4a': 1,
    });
  });
});

/*
 * Where a sound not trimmed at its end goes round, when the browser decodes more of the file than
 * the file presents. WebKit decodes the seeded 12 s tone (`qa-sample.m4a`: 518 AAC frames, 1024
 * samples of priming, presented as 529200 samples at 44.1 kHz) to 576226 samples at 48 kHz - the
 * priming trimmed, the last frame's padding kept - where Chromium, iOS and Android all have 12.000 s.
 * Looped at the decode, every pass on WebKit ended in 4.7 ms of silence and the seams drifted late.
 * The file here is laid out the same way, by mediabunny's own muxer, so its edit list is a real one;
 * the "decode" is WebKit's length, as a ramp, so where each pass starts can be read off the mix.
 */
describe('the music\'s length', () => {
  const TONE = 'file:///tone.m4a';
  const CLIP = 'file:///clip.mp4';
  /** What WebKit decoded `qa-sample.m4a` to, at the mix's rate. */
  const WEBKIT_DECODED = 576_226;
  /** 12.000 s at the mix's rate: where every other engine goes round. */
  const PRESENTED = 12 * MIX_SAMPLE_RATE;

  /** An AAC-LC `.m4a` of `frames` frames, `priming` samples of them before 0 and `padding` after the end. */
  async function aacFile(frames: number, priming: number, padding: number, sampleRate = 44_100): Promise<ArrayBuffer> {
    const output = new Output({ format: new Mp4OutputFormat(), target: new BufferTarget() });
    const source = new EncodedAudioPacketSource('aac');
    output.addAudioTrack(source);
    await output.start();
    // The payload is never decoded here; the AudioSpecificConfig says AAC-LC, 44.1 kHz, mono.
    const payload = new Uint8Array([0x21, 0x10, 0x04, 0x60, 0x8c, 0x1c]);
    const config = { decoderConfig: { codec: 'mp4a.40.2', sampleRate, numberOfChannels: 1, description: new Uint8Array([0x12, 0x08]) } };
    for (let i = 0; i < frames; i++) {
      const samples = i === frames - 1 ? 1024 - padding : 1024;
      await source.add(new EncodedPacket(payload, 'key', (i * 1024 - priming) / sampleRate, samples / sampleRate), i === 0 ? config : undefined);
    }
    await output.finalize();
    return output.target.buffer!;
  }

  /** Sample `i` of the stand-in decode: a ramp, so every sample says where in the file it came from. */
  const ramp = (i: number): number => (i + 1) / 1_000_000;

  /** Thirty seconds of a muted clip under `TONE`, not trimmed at its end, looping. */
  function tonePlan() {
    const spec = post();
    spec.clips = [clip('v', CLIP, 0, 30_000, { muted: true })];
    spec.tracks = [];
    spec.audio.music = { uri: TONE, startMs: 0, inMs: 0, outMs: 3_600_000, volume: 1, loop: true, fadeInMs: 0, fadeOutMs: 0 };
    spec.audio.voiceover = [];
    return buildPlan(spec, new Map([[CLIP, { ...probe, durationMs: 30_000 }]]));
  }

  /** `fetch` answers `bytes` for the tone, and the context decodes whatever it is given to `decodedLength` samples. */
  function serve(bytes: ArrayBuffer, decodedLength: number): void {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: true, status: 200, blob: async () => new Blob([bytes]) })),
    );
    vi.stubGlobal(
      'OfflineAudioContext',
      class {
        async decodeAudioData() {
          const channel = Float32Array.from({ length: decodedLength }, (_, i) => ramp(i));
          return { numberOfChannels: 1, sampleRate: MIX_SAMPLE_RATE, length: channel.length, duration: decodedLength / MIX_SAMPLE_RATE, getChannelData: () => channel };
        }
      },
    );
  }

  it('reads the length the container presents, without the priming or the padding', async () => {
    expect(await presentedSoundUs(await aacFile(518, 1024, 208))).toBe(12_000_000);
    // A file of no kind it reads, and one with no edit list to speak of.
    expect(await presentedSoundUs(new TextEncoder().encode('RIFF....WAVE').buffer)).toBeNull();
    expect(await presentedSoundUs(await aacFile(10, 0, 0))).toBe(Math.round(((10 * 1024) / 44_100) * 1_000_000));
  });

  it('goes round where the file presents its end, not where a decode that kept the padding ends', async () => {
    serve(await aacFile(518, 1024, 208), WEBKIT_DECODED);
    const out = (await mixdown(tonePlan(), new AbortController().signal))!.channels[0]!;

    // The last sample of the first pass, then the first of the second and of the third.
    expect(out[PRESENTED - 1]).toBeCloseTo(ramp(PRESENTED - 1), 6);
    expect(out[PRESENTED]).toBeCloseTo(ramp(0), 6);
    expect(out[2 * PRESENTED]).toBeCloseTo(ramp(0), 6);
  });

  it('keeps the decoded length where the container says nothing', async () => {
    serve(new TextEncoder().encode('not a container').buffer, WEBKIT_DECODED);
    const out = (await mixdown(tonePlan(), new AbortController().signal))!.channels[0]!;

    expect(out[PRESENTED]).toBeCloseTo(ramp(PRESENTED), 6);
    expect(out[WEBKIT_DECODED]).toBeCloseTo(ramp(0), 6);
  });
});
