import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ComposeClip, ComposeSpec, StageRenderInputOptions } from './definitions';

/*
 * The platform and the plugin, stood in for, as `current-media.unit.test.ts` does and for its
 * reasons: one platform to answer with, and the two calls a render input goes through.
 */
const bridge = vi.hoisted(() => ({
  native: true,
  stageRenderInput: vi.fn<(options: StageRenderInputOptions) => Promise<{ uri: string }>>(),
  releaseRenderInputs: vi.fn<(options: { uris: string[] }) => Promise<void>>(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: () => bridge.native },
  registerPlugin: () => ({ stageRenderInput: bridge.stageRenderInput, releaseRenderInputs: bridge.releaseRenderInputs }),
  WebPlugin: class {},
}));

import { extensionFor, withNativeRenderInputs } from './render-inputs';

const MIB = 1024 * 1024;

/** The bytes behind each `blob:` URL the page holds, as `fetch` answers them. */
let blobs: Map<string, Blob>;
let fetchInput: ReturnType<typeof vi.fn>;

describe('withNativeRenderInputs', () => {
  beforeEach(() => {
    bridge.native = true;
    blobs = new Map([
      ['blob:app/clip', new Blob(['clip'], { type: 'video/mp4' })],
      ['blob:app/from', new Blob(['from'], { type: 'video/quicktime' })],
      ['blob:app/layer', new Blob(['layer'], { type: 'image/png' })],
      ['blob:app/music', new Blob(['music'], { type: 'audio/wav' })],
      ['blob:app/take', new Blob(['take'], { type: 'audio/mp4' })],
    ]);
    fetchInput = vi.fn(async (uri: string) => {
      const blob = blobs.get(uri);
      return blob ? { ok: true, status: 200, blob: async () => blob } : { ok: false, status: 404, blob: async () => new Blob() };
    });
    vi.stubGlobal('fetch', fetchInput);

    // A new file per call without `uri`, named as the native side names one; an append answers it.
    let files = 0;
    bridge.stageRenderInput.mockReset().mockImplementation(async ({ uri, extension }) => ({
      uri: uri ?? `file:///tmp/videokit-render-inputs/${++files}${extension ? `.${extension}` : ''}`,
    }));
    bridge.releaseRenderInputs.mockReset().mockResolvedValue();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('stages every blob the spec names, wherever it names one, and leaves the rest alone', async () => {
    const original = spec();
    const render = vi.fn(async (prepared: ComposeSpec) => prepared);

    const prepared = await withNativeRenderInputs(original, render);

    const staged = /^file:\/\/\/tmp\/videokit-render-inputs\//;
    expect(prepared.clips[0]?.uri).toMatch(staged);
    expect(prepared.clips[1]?.uri).toBe('file:///var/clip-b.mp4');
    expect(prepared.clips[1]?.transitionIn?.from.uri).toMatch(staged);
    expect(prepared.tracks?.[0]?.clips[0]?.uri).toMatch(staged);
    expect(prepared.tracks?.[0]?.clips[1]?.uri).toBe('content://media/external/video/media/7');
    expect(prepared.audio.music?.uri).toMatch(staged);
    expect(prepared.audio.voiceover[0]?.uri).toMatch(staged);
    expect(prepared.audio.voiceover[1]?.uri).toBe('file:///var/take-2.m4a');
    // Everything else about the spec is what the caller built.
    expect({ ...prepared, clips: [], tracks: [], audio: null }).toEqual({ ...original, clips: [], tracks: [], audio: null });
  });

  /* The editor keeps its playable URLs for Edit again, so the caller's spec must come back untouched. */
  it('renders a copy, never the spec it was given', async () => {
    const original = spec();
    const before = structuredClone(original);

    await withNativeRenderInputs(original, async (prepared) => expect(prepared).not.toBe(original));

    expect(original).toEqual(before);
  });

  it('stages a blob named several times once, and names it the same everywhere', async () => {
    const original = spec();
    original.clips[1]!.transitionIn!.from.uri = 'blob:app/clip';
    original.audio.voiceover[0]!.uri = 'blob:app/music';

    const prepared = await withNativeRenderInputs(original, async (copy) => copy);

    expect(prepared.clips[1]?.transitionIn?.from.uri).toBe(prepared.clips[0]?.uri);
    expect(prepared.audio.voiceover[0]?.uri).toBe(prepared.audio.music?.uri);
    expect(fetchInput.mock.calls.map(([uri]) => uri).sort()).toEqual(['blob:app/clip', 'blob:app/layer', 'blob:app/music']);
    expect(bridge.stageRenderInput).toHaveBeenCalledTimes(3);
  });

  /* No bridge message carries more than a mebibyte of bytes, so no one string holds a whole WAV. */
  it('sends a mebibyte of bytes per call, appending every chunk after the first to the same file', async () => {
    const bytes = new Uint8Array(2 * MIB + 3);
    for (let at = 0; at < bytes.length; at++) bytes[at] = at % 251;
    blobs.set('blob:app/music', new Blob([bytes], { type: 'audio/wav' }));
    const original = musicOnly('blob:app/music');

    const prepared = await withNativeRenderInputs(original, async (copy) => copy);

    const calls = bridge.stageRenderInput.mock.calls.map(([options]) => options);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toEqual({ data: base64Of(bytes.subarray(0, MIB)), extension: 'wav' });
    expect(calls[1]).toEqual({ data: base64Of(bytes.subarray(MIB, 2 * MIB)), uri: prepared.audio.music?.uri });
    expect(calls[2]).toEqual({ data: base64Of(bytes.subarray(2 * MIB)), uri: prepared.audio.music?.uri });
  });

  it('names a new file after its blob type, and gives a type it does not know no extension', async () => {
    blobs.set('blob:app/music', new Blob(['music'], { type: 'application/octet-stream' }));
    await withNativeRenderInputs(spec(), async () => undefined);

    const extensions = bridge.stageRenderInput.mock.calls.map(([options]) => options.extension);
    expect(extensions).toEqual(['mp4', 'mov', 'png', undefined, 'm4a']);
    expect(bridge.stageRenderInput.mock.calls[3]?.[0]).not.toHaveProperty('extension');
  });

  it('releases what it staged once the render has settled, and not a moment before', async () => {
    const render = vi.fn(async () => {
      expect(bridge.releaseRenderInputs).not.toHaveBeenCalled();
      return 'video';
    });

    await expect(withNativeRenderInputs(spec(), render)).resolves.toBe('video');

    expect(bridge.releaseRenderInputs).toHaveBeenCalledTimes(1);
    const staged = bridge.stageRenderInput.mock.results.map((result) => result.value);
    const uris = await Promise.all(staged);
    expect(bridge.releaseRenderInputs).toHaveBeenCalledWith({ uris: uris.map(({ uri }) => uri) });
  });

  it('releases after a render that fails, and rejects with that failure', async () => {
    const failure = new Error('encoder');

    await expect(withNativeRenderInputs(spec(), async () => Promise.reject(failure))).rejects.toBe(failure);

    expect(bridge.releaseRenderInputs).toHaveBeenCalledTimes(1);
  });

  /* A render cancelled mid way still reads its inputs until its terminal event, which is what it awaits. */
  it('releases after a cancelled render only once that render has settled', async () => {
    const controller = new AbortController();
    const render = vi.fn(
      () =>
        new Promise<never>((_, reject) => {
          controller.signal.addEventListener('abort', () => {
            expect(bridge.releaseRenderInputs).not.toHaveBeenCalled();
            reject(new Error('cancelled'));
          });
        }),
    );

    const rendering = withNativeRenderInputs(spec(), render, controller.signal);
    await vi.waitFor(() => expect(render).toHaveBeenCalled());
    controller.abort();

    await expect(rendering).rejects.toThrow('cancelled');
    expect(bridge.releaseRenderInputs).toHaveBeenCalledTimes(1);
  });

  it('does not start a render aborted while its inputs were being staged, and releases what was staged', async () => {
    const controller = new AbortController();
    bridge.stageRenderInput.mockImplementationOnce(async () => {
      controller.abort();
      return { uri: 'file:///tmp/videokit-render-inputs/first.mp4' };
    });
    const render = vi.fn();

    await expect(withNativeRenderInputs(spec(), render, controller.signal)).rejects.toThrow();

    expect(render).not.toHaveBeenCalled();
    expect(bridge.releaseRenderInputs).toHaveBeenCalledWith({ uris: ['file:///tmp/videokit-render-inputs/first.mp4'] });
  });

  it('stages nothing for a signal already aborted, and releases nothing', async () => {
    const controller = new AbortController();
    controller.abort(new Error('left the editor'));
    const render = vi.fn();

    await expect(withNativeRenderInputs(spec(), render, controller.signal)).rejects.toThrow('left the editor');

    expect(fetchInput).not.toHaveBeenCalled();
    expect(render).not.toHaveBeenCalled();
    expect(bridge.releaseRenderInputs).not.toHaveBeenCalled();
  });

  /* A file whose first chunk was written is released even when a later one fails to append. */
  it('releases a file whose append failed, and never starts the render', async () => {
    blobs.set('blob:app/music', new Blob([new Uint8Array(MIB + 1)], { type: 'audio/wav' }));
    bridge.stageRenderInput
      .mockImplementationOnce(async () => ({ uri: 'file:///tmp/videokit-render-inputs/music.wav' }))
      .mockRejectedValueOnce(new Error('no space'));
    const render = vi.fn();

    await expect(withNativeRenderInputs(musicOnly('blob:app/music'), render)).rejects.toThrow('no space');

    expect(render).not.toHaveBeenCalled();
    expect(bridge.releaseRenderInputs).toHaveBeenCalledWith({ uris: ['file:///tmp/videokit-render-inputs/music.wav'] });
  });

  it('refuses an empty blob or one that will not read, rather than rendering without it', async () => {
    blobs.set('blob:app/music', new Blob([]));
    await expect(withNativeRenderInputs(musicOnly('blob:app/music'), vi.fn())).rejects.toThrow('empty');

    await expect(withNativeRenderInputs(musicOnly('blob:app/revoked'), vi.fn())).rejects.toThrow('404');
    expect(bridge.stageRenderInput).not.toHaveBeenCalled();
  });

  /* A finished video is not an error because a temporary file could not be deleted: the launch sweep takes it. */
  it('answers the render even when the release fails', async () => {
    bridge.releaseRenderInputs.mockRejectedValue(new Error('bridge gone'));

    await expect(withNativeRenderInputs(spec(), async () => 'video')).resolves.toBe('video');
  });

  it('calls nothing and stages nothing for a spec with no blob in it', async () => {
    const original = musicOnly('file:///var/music.m4a');

    await expect(withNativeRenderInputs(original, async (copy) => copy)).resolves.toEqual(original);

    expect(fetchInput).not.toHaveBeenCalled();
    expect(bridge.stageRenderInput).not.toHaveBeenCalled();
    expect(bridge.releaseRenderInputs).not.toHaveBeenCalled();
  });

  /* The web engine reads a blob as it is, so off a phone the spec goes straight to the render. */
  it('hands a browser render the very spec it was given', async () => {
    bridge.native = false;
    const original = spec();
    const render = vi.fn(async (given: ComposeSpec) => given);

    await expect(withNativeRenderInputs(original, render)).resolves.toBe(original);

    expect(fetchInput).not.toHaveBeenCalled();
    expect(bridge.stageRenderInput).not.toHaveBeenCalled();
    expect(bridge.releaseRenderInputs).not.toHaveBeenCalled();
  });
});

describe('extensionFor', () => {
  it('maps each type a render input arrives as to the extension its file is named with', () => {
    expect(extensionFor('audio/wav')).toBe('wav');
    expect(extensionFor('audio/x-wav')).toBe('wav');
    expect(extensionFor('audio/vnd.wave')).toBe('wav');
    expect(extensionFor('audio/mpeg')).toBe('mp3');
    expect(extensionFor('audio/mp3')).toBe('mp3');
    expect(extensionFor('audio/mp4')).toBe('m4a');
    expect(extensionFor('audio/x-m4a')).toBe('m4a');
    expect(extensionFor('audio/x-caf')).toBe('caf');
    expect(extensionFor('audio/x-flac')).toBe('flac');
    expect(extensionFor('video/mp4')).toBe('mp4');
    expect(extensionFor('video/quicktime')).toBe('mov');
    expect(extensionFor('image/png')).toBe('png');
    expect(extensionFor('image/jpeg')).toBe('jpeg');
    expect(extensionFor('Audio/MP4; codecs="mp4a.40.2"')).toBe('m4a');
  });

  it('gives a type it does not know no extension rather than a guess', () => {
    expect(extensionFor('')).toBe('');
    expect(extensionFor('application/octet-stream')).toBe('');
    expect(extensionFor('image/svg+xml')).toBe('');
    expect(extensionFor('constructor')).toBe('');
  });
});

/** A clip with nothing about it but its name and its file. */
function clip(key: string, uri: string): ComposeClip {
  return { key, uri, inMs: 0, outMs: 1000, speed: 1, volume: 1, muted: false, fit: 'contain' };
}

/**
 * A spec naming a blob in every place one can be named, beside a file in each place a native name
 * can be: a base clip, a transition's outgoing side, a layer, the music and a take.
 */
function spec(): ComposeSpec {
  return {
    jobId: 'job',
    batchId: 'batch',
    clips: [
      clip('a', 'blob:app/clip'),
      { ...clip('b', 'file:///var/clip-b.mp4'), transitionIn: { kind: 'dissolve', from: clip('a', 'blob:app/from'), curves: { alpha: [0, 1] } } },
    ],
    tracks: [{ id: 'layer', z: 1, clips: [clip('c', 'blob:app/layer'), clip('d', 'content://media/external/video/media/7')] }],
    output: { width: 720, height: 1280, fps: 30, videoBitrate: 4_000_000, audioBitrate: 128_000 },
    filter: [],
    overlays: [],
    audio: {
      originalMuted: false,
      originalVolume: 1,
      music: { uri: 'blob:app/music', startMs: 0, inMs: 0, outMs: 1000, volume: 1, loop: false, fadeInMs: 0, fadeOutMs: 0 },
      voiceover: [
        { uri: 'blob:app/take', startMs: 0, durationMs: 1000, volume: 1 },
        { uri: 'file:///var/take-2.m4a', startMs: 1000, durationMs: 1000, volume: 1 },
      ],
    },
    posterAtMs: 0,
  };
}

/** A spec whose only media is its music, at `uri`. */
function musicOnly(uri: string): ComposeSpec {
  const only = spec();
  only.clips = [clip('a', 'file:///var/clip-a.mp4')];
  only.tracks = [];
  only.audio.music = { ...only.audio.music!, uri };
  only.audio.voiceover = [];
  return only;
}

function base64Of(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64');
}
