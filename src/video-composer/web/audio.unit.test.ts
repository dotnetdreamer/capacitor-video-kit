import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposeClip, ComposeSpec } from '../definitions';

import { MIX_SAMPLE_RATE, mixdown, sourceUses } from './audio';
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
