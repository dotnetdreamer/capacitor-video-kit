import { describe, expect, it } from 'vitest';
import type { RasterContext } from './raster-context';
import { toComposeSpec } from './compose';
import { addAudioClip, audioClipWindow, moveAudioClip, moveAudioClipToTrack, patchAudioClip, removeAudioClip, reorderAudioClip, replaceAudioClip, setAudioLoop } from './edit-ops';
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
    expect(spec.audio.musicTracks?.map(track => track.map(clip => clip.uri))).toEqual([['file:///legacy.m4a', 'file:///b.m4a'], ['file:///a.m4a']]);
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

  it('replaces the file under a sound, keeping its place, level and fades, and stops it before the next one', () => {
    const lane: EditManifest = {
      ...post(),
      audioTracks: [{ id: 'at-1', clips: [sound('a', 1000, { inMs: 500, phaseMs: 200, volume: 0.4, fadeInMs: 300, fadeOutMs: 700 }), sound('b', 9000)] }],
    };
    const file = { uri: 'file:///long.m4a', fileName: 'long.m4a', sourceDurationMs: 30_000 };
    const replaced = replaceAudioClip(lane, 'a', file)!;
    // The trim was cut from the old file, so it goes; everything set on the sound itself stays.
    expect(replaced.audioTracks?.[0]?.clips[0]).toEqual({ ...sound('a', 1000, { volume: 0.4, fadeInMs: 300, fadeOutMs: 700 }), ...file, endMs: 9000 });
    expect(audioClipWindow(replaced.audioTracks![0]!.clips[0]!, 20_000)).toEqual({ startMs: 1000, endMs: 9000 });
    // The last sound on its lane has nothing to stop for, and a stop it already had is kept.
    expect(replaceAudioClip(lane, 'b', file)?.audioTracks?.[0]?.clips[1]?.endMs).toBe(0);
    const stopped = { ...lane, audioTracks: [{ id: 'at-1', clips: [sound('a', 1000, { endMs: 3000 })] }] };
    expect(replaceAudioClip(stopped, 'a', file)?.audioTracks?.[0]?.clips[0]?.endMs).toBe(3000);
    expect(replaceAudioClip(lane, 'missing', file)).toBeNull();
  });

  it('requires a render when an otherwise untouched video has added audio', () => {
    const before = post();
    const durations = new Map([['video', 20_000]]);
    expect(isUntouched(before, durations, 9 / 16)).toBe(true);
    const withAudio = addAudioClip(before, sound('a', 0), 'at-1')!;
    expect(isUntouched(withAudio, durations, 9 / 16)).toBe(false);
  });
});

describe('reordering sounds on a lane', () => {
  const onLane = (...clips: EditAudioClip[]): EditManifest => ({ ...post(), audioTracks: [{ id: 'at-1', clips }] });
  const places = (manifest: EditManifest) => manifest.audioTracks![0]!.clips.map(clip => [clip.id, clip.startMs]);

  it('swaps packed clips in either direction even when there is no free gap', () => {
    const original = onLane(sound('a', 0, { sourceDurationMs: 10_000 }), sound('b', 10_000, { sourceDurationMs: 10_000 }));
    const firstToLast = reorderAudioClip(original, 'a', 1);
    const lastToFirst = reorderAudioClip(original, 'b', 0);
    expect(places(firstToLast)).toEqual([['b', 0], ['a', 10_000]]);
    expect(lastToFirst).toEqual(firstToLast);
    expect(reorderAudioClip(firstToLast, 'a', 0)).toEqual(original);
    expect(places(original)).toEqual([['a', 0], ['b', 10_000]]);
  });

  it('keeps unequal lengths, boundary gaps and the lane span when crossing several clips', () => {
    const original = onLane(
      sound('a', 1000, { sourceDurationMs: 2000 }),
      sound('b', 5000, { sourceDurationMs: 4000 }),
      sound('c', 11_000, { sourceDurationMs: 1000 }),
    );
    const reordered = reorderAudioClip(original, 'a', 2);
    expect(places(reordered)).toEqual([['b', 1000], ['c', 7000], ['a', 10_000]]);
    expect(reordered.audioTracks![0]!.clips.map(clip => audioClipWindow(clip, 20_000).endMs - clip.startMs)).toEqual([4000, 1000, 2000]);
    expect(audioClipWindow(reordered.audioTracks![0]!.clips[2]!, 20_000).endMs).toBe(12_000);
    expect(reorderAudioClip(original, 'c', 0).audioTracks![0]!.clips.map(clip => [clip.id, clip.startMs])).toEqual([['c', 1000], ['a', 4000], ['b', 8000]]);
  });

  it('changes only the crossed block and keeps other clips and lanes by reference', () => {
    const a = sound('a', 1000, { sourceDurationMs: 2000 });
    const b = sound('b', 5000, { sourceDurationMs: 4000 });
    const before = sound('before', 0, { sourceDurationMs: 500 });
    const after = sound('after', 11_000, { sourceDurationMs: 1000 });
    const otherLane = { id: 'at-2', clips: [sound('other', 0)] };
    const original = { ...onLane(before, a, b, after), audioTracks: [{ id: 'at-1', clips: [before, a, b, after] }, otherLane] };
    const reordered = reorderAudioClip(original, 'a', 2);
    expect(places(reordered)).toEqual([['before', 0], ['b', 1000], ['a', 7000], ['after', 11_000]]);
    expect(reordered.audioTracks![0]!.clips[0]).toBe(before);
    expect(reordered.audioTracks![0]!.clips[3]).toBe(after);
    expect(reordered.audioTracks![1]).toBe(otherLane);
    expect(reordered.clips).toBe(original.clips);
  });

  it('carries source trims, phase, speed, level and fades while shifting an explicit stop', () => {
    const a = sound('a', 1000, { sourceDurationMs: 14_000, inMs: 1000, outMs: 9000, phaseMs: 1000, speed: 2, endMs: 4000, volume: 0.4, fadeInMs: 300, fadeOutMs: 700 });
    const original = onLane(a, sound('b', 5000, { sourceDurationMs: 2000 }));
    const reordered = reorderAudioClip(original, 'a', 1);
    expect(places(reordered)).toEqual([['b', 1000], ['a', 4000]]);
    expect(reordered.audioTracks![0]!.clips[1]).toEqual({ ...a, startMs: 4000, endMs: 7000 });
    expect(normaliseManifest(reordered).audioTracks).toEqual(reordered.audioTracks);
  });

  it('keeps a bounded loop bounded when its stop reaches the post end', () => {
    const original = onLane(sound('a', 0, { loop: true, endMs: 8000, phaseMs: 300, fadeOutMs: 700 }), sound('b', 8000, { sourceDurationMs: 12_000 }));
    const reordered = reorderAudioClip(original, 'a', 1);
    expect(reordered.audioTracks![0]!.clips).toEqual([
      sound('b', 0, { sourceDurationMs: 12_000 }),
      sound('a', 12_000, { loop: true, endMs: 20_000, phaseMs: 300, fadeOutMs: 700 }),
    ]);
    const extended = { ...reordered, durationMs: 30_000 };
    expect(audioClipWindow(extended.audioTracks![0]!.clips[1]!, 30_000).endMs).toBe(20_000);
    expect(normaliseManifest(extended).audioTracks).toEqual(reordered.audioTracks);
  });

  it.each([{ loop: true }, { sourceDurationMs: 0 }])('bounds a to-end sound moved before its neighbour (%j)', options => {
    const original = onLane(sound('a', 1000, { sourceDurationMs: 2000 }), sound('b', 5000, { ...options, phaseMs: 300, fadeInMs: 400, fadeOutMs: 600 }));
    const reordered = reorderAudioClip(original, 'b', 0);
    expect(places(reordered)).toEqual([['b', 1000], ['a', 18_000]]);
    expect(reordered.audioTracks![0]!.clips[0]).toEqual({ ...original.audioTracks![0]!.clips[1], startMs: 1000, endMs: 16_000 });
    expect(audioClipWindow(reordered.audioTracks![0]!.clips[0]!, 20_000)).toEqual({ startMs: 1000, endMs: 16_000 });
    const extended = normaliseManifest({ ...reordered, durationMs: 30_000 });
    expect(extended.audioTracks).toHaveLength(1);
    expect(extended.audioTracks).toEqual(reordered.audioTracks);
  });

  it('reserves fractional-speed lengths without overlapping or moving the block after them', () => {
    const after = sound('after', 4500, { sourceDurationMs: 1000 });
    const original = onLane(
      sound('a', 0, { sourceDurationMs: 5000, speed: 3 }),
      sound('b', 1667, { sourceDurationMs: 4000, speed: 3 }),
      sound('c', 3001, { sourceDurationMs: 1000 }),
      after,
    );
    const reordered = reorderAudioClip(original, 'a', 2);
    expect(places(reordered)).toEqual([['b', 0], ['c', 1334], ['a', 2334], ['after', 4500]]);
    const clips = reordered.audioTracks![0]!.clips;
    expect(audioClipWindow(clips[0]!, 20_000).endMs).toBeLessThanOrEqual(clips[1]!.startMs);
    expect(audioClipWindow(clips[1]!, 20_000).endMs).toBeLessThanOrEqual(clips[2]!.startMs);
    expect(Math.ceil(audioClipWindow(clips[2]!, 20_000).endMs)).toBe(4001);
    expect(clips[3]).toBe(after);
    expect(normaliseManifest(reordered).audioTracks).toEqual(reordered.audioTracks);
  });

  it('swaps a longer-than-post file using its played length and stops its hidden tail safely', () => {
    const a = sound('a', 0, { sourceDurationMs: 2000 });
    const b = sound('b', 2000, { sourceDurationMs: 12_000, inMs: 1000, outMs: 10_000, phaseMs: 1000, volume: 0.4, fadeInMs: 200, fadeOutMs: 300 });
    const original = { ...onLane(a, b), clips: [defaultClipEdit('video', 6000, 'seg-1')] };
    const reordered = reorderAudioClip(original, 'b', 0);
    expect(places(reordered)).toEqual([['b', 0], ['a', 4000]]);
    expect(reordered.audioTracks![0]!.clips).toEqual([{ ...b, startMs: 0, endMs: 4000 }, { ...a, startMs: 4000 }]);
    expect(reorderAudioClip(original, 'a', 1)).toEqual(reordered);
    expect(reordered.audioTracks![0]!.clips.map(clip => audioClipWindow(clip, 6000).endMs - clip.startMs)).toEqual([4000, 2000]);
    expect(normaliseManifest(reordered).audioTracks).toEqual(reordered.audioTracks);
    const extended = normaliseManifest({ ...reordered, durationMs: 30_000 });
    expect(extended.audioTracks).toHaveLength(1);
    expect(audioClipWindow(extended.audioTracks![0]!.clips[0]!, 30_000).endMs).toBe(4000);
    expect(extended.audioTracks).toEqual(reordered.audioTracks);
  });

  it('leaves an untouched sound outside a shortened post where it was', () => {
    const outside = sound('outside', 10_000, { sourceDurationMs: 1000 });
    const original = {
      ...onLane(sound('a', 0, { sourceDurationMs: 500 }), sound('b', 500, { sourceDurationMs: 12_000, speed: 3 }), outside),
      clips: [defaultClipEdit('video', 3000, 'seg-1')],
    };
    const reordered = reorderAudioClip(original, 'b', 0);
    expect(places(reordered)).toEqual([['b', 0], ['a', 2500], ['outside', 10_000]]);
    expect(reordered.audioTracks![0]!.clips[0]!.endMs).toBe(2500);
    expect(reordered.audioTracks![0]!.clips[2]).toBe(outside);
    expect(normaliseManifest(reordered).audioTracks).toEqual(reordered.audioTracks);
    expect(reorderAudioClip(original, 'outside', 0)).toBe(original);
  });

  it('returns the original manifest for missing clips, unchanged order and invalid lengths', () => {
    const original = onLane(sound('a', 0), sound('b', 5000));
    expect(reorderAudioClip(original, 'a', 0)).toBe(original);
    expect(reorderAudioClip(original, 'missing', 1)).toBe(original);
    expect(reorderAudioClip(original, 'a', Number.NaN)).toBe(original);
    expect(reorderAudioClip(original, 'a', Number.POSITIVE_INFINITY)).toBe(original);
    const noLength = { ...emptyManifest(), audioTracks: [{ id: 'at-1', clips: [sound('a', 0), sound('b', 5000, { loop: true })] }] };
    expect(reorderAudioClip(noLength, 'b', 0)).toBe(noLength);
    const overlapping = onLane(sound('a', 0), sound('b', 1000));
    expect(reorderAudioClip(overlapping, 'a', 1)).toBe(overlapping);
  });
});
