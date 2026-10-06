import { describe, expect, it } from 'vitest';
import type { RasterContext } from './raster-context';
import { toComposeSpec } from './compose';
import { addAudioClip, audioClipWindow, moveAudioClip, moveAudioClipToTrack, patchAudioClip, removeAudioClip, setAudioLoop } from './edit-ops';
import { defaultClipEdit, emptyManifest, isUntouched, normaliseManifest, type EditAudioClip, type EditManifest } from './edit-manifest';

const post = (): EditManifest => ({
  ...emptyManifest(),
  clips: [defaultClipEdit('video', 20_000, 'seg-1')],
});

const sound = (id: string, startMs: number, over: Partial<EditAudioClip> = {}): EditAudioClip => ({
  id,
  uri: `file:///${id}.m4a`,
  fileName: `${id}.m4a`,
  sourceDurationMs: 5000,
  inMs: 0,
  outMs: 0,
  startMs,
  endMs: 0,
  volume: 0.8,
  loop: false,
  fadeOutMs: 0,
  ...over,
});

describe('independent audio lanes', () => {
  it('places sequential sounds on one lane and overlapping sounds on another', () => {
    const first = addAudioClip(post(), sound('a', 1000), 'at-1')!;
    const second = addAudioClip(first, sound('b', 6000), 'at-2')!;
    const third = addAudioClip(second, sound('c', 2000), 'at-3')!;

    expect(third.audioTracks?.map(track => track.clips.map(clip => clip.id))).toEqual([['a', 'b'], ['c']]);
    expect(audioClipWindow(third.audioTracks![0]!.clips[1]!, 20_000)).toEqual({ startMs: 6000, endMs: 11_000 });
    expect(third.music).toBeNull();
  });

  it('moves a sound along its lane without covering its neighbour', () => {
    const first = addAudioClip(post(), sound('a', 1000), 'at-1')!;
    const second = addAudioClip(first, sound('b', 9000), 'at-2')!;
    const moved = moveAudioClip(second, 'a', 7000);
    expect(moved.audioTracks?.[0]?.clips[0]?.startMs).toBe(4000);
    expect(patchAudioClip(moved, 'a', { startMs: 8000 })).toBe(moved);
  });

  it('carries sounds between existing and newly opened lanes', () => {
    const a = addAudioClip(post(), sound('a', 1000), 'at-1')!;
    const b = addAudioClip(a, sound('b', 2000), 'at-2')!;
    const together = moveAudioClipToTrack(b, 'b', { kind: 'track', trackId: 'at-1' }, 2000, 'unused')!;
    expect(together.audioTracks?.map(track => track.clips.map(clip => clip.id))).toEqual([['a', 'b']]);
    expect(together.audioTracks?.[0]?.clips[1]?.startMs).toBe(6000);
    const apart = moveAudioClipToTrack(together, 'b', { kind: 'new', index: 1 }, 2000, 'at-3')!;
    expect(apart.audioTracks?.map(track => track.id)).toEqual(['at-1', 'at-3']);
    expect(apart.audioTracks?.[1]?.clips[0]?.startMs).toBe(2000);
    expect(removeAudioClip(apart, 'b').audioTracks?.map(track => track.id)).toEqual(['at-1']);
  });

  it('reopens old drafts without an audioTracks key and preserves every sound in damaged rows', () => {
    const old = normaliseManifest({ ...post(), version: 13 });
    expect(old).not.toHaveProperty('audioTracks');
    const restored = normaliseManifest({ ...post(), audioTracks: [{ id: 'at-1', clips: [sound('a', 0), sound('b', 1000)] }] });
    expect(restored.audioTracks?.flatMap(track => track.clips.map(clip => clip.id)).sort()).toEqual(['a', 'b']);
    expect(restored.audioTracks).toHaveLength(2);
  });

  it('moves legacy music into a stable first lane when adding a sound, without playing it twice', async () => {
    const withLegacy = { ...post(), music: sound('legacy', 0) };
    const withAudio = addAudioClip(addAudioClip(withLegacy, sound('a', 0), 'at-1')!, sound('b', 5000), 'at-2')!;
    const spec = await toComposeSpec(withAudio, new Map([['video', 'file:///video.mp4']]), { jobId: 'j', batchId: 'b' }, {} as RasterContext);
    expect(withAudio.music).toBeNull();
    expect(withAudio.audioTracks?.map(track => track.clips.map(clip => clip.id))).toEqual([['legacy-music', 'b'], ['a']]);
    expect(addAudioClip(withLegacy, sound('a', 0), 'at-1')?.audioTracks?.[0]?.id).toBe('legacy-audio-track');
    expect(spec.audio.music).toBeNull();
    expect(spec.audio.musicTracks?.map(track => track.map(clip => clip.uri))).toEqual([
      ['file:///legacy.m4a', 'file:///b.m4a'],
      ['file:///a.m4a'],
    ]);
    expect(spec.audio.musicTracks?.flat().filter(clip => clip.uri === 'file:///legacy.m4a')).toHaveLength(1);
    const old = await toComposeSpec(withLegacy, new Map([['video', 'file:///video.mp4']]), { jobId: 'j', batchId: 'b' }, {} as RasterContext);
    expect(old.audio).not.toHaveProperty('musicTracks');
    expect(old.audio.music?.uri).toBe('file:///legacy.m4a');
  });

  it('keeps legacy music and its IDs untouched when an addition cannot land', () => {
    const legacy = { ...post(), music: sound('legacy', 0), audioTracks: [{ id: 'legacy-audio-track', clips: [sound('legacy-music', 0)] }] };
    const placed = addAudioClip(legacy, sound('new', 10_000), 'at-1')!;
    expect(placed.audioTracks?.[0]?.id).toBe('legacy-audio-track-1');
    expect(placed.audioTracks?.[0]?.clips[0]?.id).toBe('legacy-music-1');
    expect(addAudioClip(legacy, sound('new', 20_000), 'at-1')).toBeNull();
    expect(legacy.music?.uri).toBe('file:///legacy.m4a');
  });

  it('takes a sound as the first layer of a post that has no length yet', () => {
    const first = addAudioClip(emptyManifest(), sound('a', 0), 'at-1');
    expect(first?.audioTracks?.map(track => track.clips.map(clip => clip.id))).toEqual([['a']]);
    // Both start at 0, so the second goes beside the first rather than over it.
    const second = addAudioClip(first!, sound('b', 0), 'at-2');
    expect(second?.audioTracks?.map(track => track.clips.map(clip => clip.id))).toEqual([['a'], ['b']]);
    expect(patchAudioClip(second!, 'a', { volume: 0.3 }).audioTracks?.[0]?.clips[0]?.volume).toBe(0.3);
  });

  it('keeps sounds on one lane apart over their whole length, not just what a short post hears', () => {
    // A 10 s post whose lane holds 'a' at 12..17 s, none of which is heard yet.
    const short: EditManifest = {
      ...emptyManifest(),
      clips: [defaultClipEdit('video', 10_000, 'seg-1')],
      audioTracks: [{ id: 'at-1', clips: [sound('a', 12_000)] }],
    };
    // 8..14 s meets 'a' as soon as the post is long enough to hear both, so it takes a lane of its own.
    const added = addAudioClip(short, sound('b', 8000, { sourceDurationMs: 6000 }), 'at-2');
    expect(added?.audioTracks?.map(track => track.clips.map(clip => clip.id))).toEqual([['a'], ['b']]);
  });

  it('loops a sound up to the next one on its lane, and to the end of the post with none after it', () => {
    const lane = addAudioClip(addAudioClip(post(), sound('a', 1000), 'at-1')!, sound('b', 9000), 'at-1')!;
    const looped = setAudioLoop(lane, 'a', true);
    expect(looped.audioTracks?.[0]?.clips[0]).toMatchObject({ loop: true, endMs: 9000 });
    expect(audioClipWindow(looped.audioTracks![0]!.clips[0]!, 20_000)).toEqual({ startMs: 1000, endMs: 9000 });
    expect(setAudioLoop(lane, 'b', true).audioTracks?.[0]?.clips[1]).toMatchObject({ loop: true, endMs: 0 });
    expect(setAudioLoop(looped, 'a', false).audioTracks?.[0]?.clips[0]?.loop).toBe(false);
  });

  it('requires a render when an otherwise untouched video has added audio', () => {
    const before = post();
    const durations = new Map([['video', 20_000]]);
    expect(isUntouched(before, durations, 9 / 16)).toBe(true);
    const withAudio = addAudioClip(before, sound('a', 0), 'at-1')!;
    expect(isUntouched(withAudio, durations, 9 / 16)).toBe(false);
  });
});
