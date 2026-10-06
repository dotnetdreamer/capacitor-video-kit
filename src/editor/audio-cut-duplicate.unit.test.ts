import { describe, expect, it } from 'vitest';
import type { RasterContext } from './raster-context';
import { toComposeSpec } from './compose';
import {
  audioClipWindow,
  duplicateAudioClip,
  findAudioClip,
  joinContinuousAudio,
  moveAudioClip,
  musicAsAudioLane,
  musicSourceMsAt,
  patchAudioClip,
  setAudioLoop,
  splitAudioClipAt,
} from './edit-ops';
import { MIN_LAYER_MS, defaultClipEdit, emptyManifest, type EditAudioClip, type EditManifest } from './edit-manifest';

/*
 * Cut and Duplicate on a sound, as the audio row's tiles make them. A cut has to sound like nothing
 * happened - each half reads its file exactly where the sound would have - and a copy has to land
 * where a customer can see it: straight after the sound, on whichever lane has room for it.
 */

/** Twenty seconds of video. */
const post = (): EditManifest => ({
  ...emptyManifest(),
  clips: [defaultClipEdit('video', 20_000, 'seg-1')],
});

/** A five-second file, played once from `startMs`. */
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

const lanes = (...tracks: EditAudioClip[][]): EditManifest => ({
  ...post(),
  audioTracks: tracks.map((clips, index) => ({ id: `at-${index + 1}`, clips })),
});

const layout = (manifest: EditManifest | null): string[] =>
  (manifest?.audioTracks ?? []).map(track => `${track.id}: ${track.clips.map(clip => `${clip.id}@${clip.startMs}`).join(' ')}`);

/**
 * Where in its file the sound is heard at each 50 ms of the post, before and after the cut. Equal to
 * within the millisecond the cut rounds a sped-up sound's file position by.
 */
function expectPlaysAsBefore(before: EditAudioClip, left: EditAudioClip, right: EditAudioClip, cutMs: number): void {
  const total = 20_000;
  const { startMs, endMs } = audioClipWindow(before, total);
  for (let t = startMs; t < endMs; t += 50) {
    const was = musicSourceMsAt(before, t, total);
    const is = musicSourceMsAt(t < cutMs ? left : right, t, total);
    expect(is, `at ${t}ms`).not.toBeNull();
    expect(Math.abs(is! - was!), `at ${t}ms`).toBeLessThanOrEqual(1);
  }
  // Each half ends no later than the next thing on its lane may start, and short of it by under 1 ms.
  const leftHeard = audioClipWindow(left, total);
  const rightHeard = audioClipWindow(right, total);
  expect(leftHeard.startMs).toBe(startMs);
  expect(cutMs - leftHeard.endMs).toBeGreaterThanOrEqual(0);
  expect(cutMs - leftHeard.endMs).toBeLessThan(1);
  expect(rightHeard.startMs).toBe(cutMs);
  expect(endMs - rightHeard.endMs).toBeGreaterThanOrEqual(0);
  expect(endMs - rightHeard.endMs).toBeLessThan(1);
}

describe('cutting a sound', () => {
  it('cuts a sound played once in its file, the left half ending where the right half begins', () => {
    const a = sound('a', 1000, { inMs: 500, fadeInMs: 300, fadeOutMs: 700 });
    const cut = splitAudioClipAt(lanes([a]), 'a', 3000, 'b')!;
    expect(layout(cut)).toEqual(['at-1: a@1000 b@3000']);

    const [left, right] = cut.audioTracks![0]!.clips;
    // The left half keeps how the sound comes in, the right half how it goes out.
    expect(left).toEqual({ ...a, outMs: 2500, fadeOutMs: 0 });
    const { fadeInMs: _in, ...rest } = a;
    expect(right).toEqual({ ...rest, id: 'b', inMs: 2500, startMs: 3000 });
    expectPlaysAsBefore(a, left!, right!, 3000);
  });

  it('gives a stop to the right half, and leaves the left half free to loop up to it', () => {
    const a = sound('a', 0, { endMs: 4000 });
    const cut = splitAudioClipAt(lanes([a]), 'a', 1500, 'b')!;
    const [left, right] = cut.audioTracks![0]!.clips;
    expect(left).toMatchObject({ inMs: 0, outMs: 1500, endMs: 0 });
    expect(right).toMatchObject({ inMs: 1500, startMs: 1500, endMs: 4000 });
    expectPlaysAsBefore(a, left!, right!, 1500);
    // A stop left on the left half past the cut would turn Loop away without a word.
    expect(findAudioClip(setAudioLoop(cut, 'a', true), 'a')).toMatchObject({ loop: true, endMs: 1500 });
  });

  it('keeps a loop’s whole section in both halves, the right one taking the repeats up where they had got to', () => {
    // A three-second section, 1..4 s of the file, starting half a second in.
    const a = sound('a', 1000, { loop: true, inMs: 1000, outMs: 4000, phaseMs: 500 });
    const cut = splitAudioClipAt(lanes([a]), 'a', 9000, 'b')!;
    const [left, right] = cut.audioTracks![0]!.clips;
    expect(left).toEqual({ ...a, endMs: 9000 });
    // Eight seconds in is not wrapped to the section: each engine wraps it against the length it reads.
    expect(right).toMatchObject({ id: 'b', loop: true, inMs: 1000, outMs: 4000, startMs: 9000, endMs: 0, phaseMs: 8500 });
    expectPlaysAsBefore(a, left!, right!, 9000);
  });

  it('cuts a sped-up sound without the halves overlapping by the fraction of a millisecond', () => {
    // At 1.5x the cut at 333 ms is 499.5 ms into the file.
    const a = sound('a', 0, { speed: 1.5 });
    const cut = splitAudioClipAt(lanes([a, sound('c', 3334)]), 'a', 333, 'b')!;
    expect(layout(cut)).toEqual(['at-1: a@0 b@333 c@3334']);
    const [left, right] = cut.audioTracks![0]!.clips;
    expect(left).toMatchObject({ outMs: 499, speed: 1.5 });
    expect(right).toMatchObject({ inMs: 500, startMs: 333, speed: 1.5 });
    expect(audioClipWindow(left!, 20_000).endMs).toBeLessThanOrEqual(333);
    expectPlaysAsBefore(a, left!, right!, 333);
  });

  it('folds the phase of a sound played once into the left half’s in point', () => {
    const a = sound('a', 0, { phaseMs: 1000 });
    const cut = splitAudioClipAt(lanes([a]), 'a', 2000, 'b')!;
    const [left, right] = cut.audioTracks![0]!.clips;
    expect(left).toMatchObject({ inMs: 1000, outMs: 3000 });
    expect(left).not.toHaveProperty('phaseMs');
    expect(right).toMatchObject({ inMs: 3000, startMs: 2000 });
    expect(right).not.toHaveProperty('phaseMs');
    expectPlaysAsBefore(a, left!, right!, 2000);
  });

  it('leaves the other sounds on the lane, and every other lane, where they were', () => {
    const before = lanes([sound('x', 0, { outMs: 1000 }), sound('a', 2000), sound('y', 8000)], [sound('z', 500)]);
    const cut = splitAudioClipAt(before, 'a', 4000, 'b')!;
    expect(layout(cut)).toEqual(['at-1: x@0 a@2000 b@4000 y@8000', 'at-2: z@500']);
    expect(cut.audioTracks![1]).toBe(before.audioTracks![1]);
  });

  it('refuses a cut outside the sound, too near either end, or that leaves a half too little of its file', () => {
    const one = lanes([sound('a', 1000)]);
    expect(splitAudioClipAt(one, 'a', 500, 'b')).toBeNull();
    expect(splitAudioClipAt(one, 'a', 7000, 'b')).toBeNull();
    expect(splitAudioClipAt(one, 'a', 1000 + MIN_LAYER_MS - 1, 'b')).toBeNull();
    expect(splitAudioClipAt(one, 'a', 6000 - MIN_LAYER_MS + 1, 'b')).toBeNull();
    expect(splitAudioClipAt(one, 'a', 1000 + MIN_LAYER_MS, 'b')).not.toBeNull();
    expect(splitAudioClipAt(one, 'a', 6000 - MIN_LAYER_MS, 'b')).not.toBeNull();
    // At 0.25x, 300 ms of the post is 75 ms of the file: heard long enough, but trimmed too short.
    const slow = lanes([sound('a', 0, { speed: 0.25 })]);
    expect(splitAudioClipAt(slow, 'a', 300, 'b')).toBeNull();
    expect(splitAudioClipAt(slow, 'a', 400, 'b')).not.toBeNull();
    expect(splitAudioClipAt(one, 'missing', 3000, 'b')).toBeNull();
    expect(splitAudioClipAt(lanes([sound('a', 1000)], [sound('b', 0)]), 'a', 3000, 'b')).toBeNull();
  });
});

describe('duplicating a sound', () => {
  it('puts the copy straight after the sound on its own lane', () => {
    const a = sound('a', 1000, { volume: 0.4, fadeInMs: 200, fadeOutMs: 600, speed: 2 });
    const copied = duplicateAudioClip(lanes([a]), 'a', 'b', 'at-new')!;
    // Five seconds at 2x ends at 3.5 s.
    expect(layout(copied)).toEqual(['at-1: a@1000 b@3500']);
    expect(findAudioClip(copied, 'b')).toEqual({ ...a, id: 'b', startMs: 3500 });
  });

  it('takes the first lane with room when its own has none, and opens one under its own when no lane has', () => {
    const blocked = lanes([sound('a', 1000), sound('c', 7000)], [sound('d', 0)]);
    expect(layout(duplicateAudioClip(blocked, 'a', 'b', 'at-new'))).toEqual(['at-1: a@1000 c@7000', 'at-2: d@0 b@6000']);

    const full = lanes([sound('a', 1000), sound('c', 7000)], [sound('d', 4000)]);
    expect(layout(duplicateAudioClip(full, 'a', 'b', 'at-new'))).toEqual(['at-1: a@1000 c@7000', 'at-new: b@6000', 'at-2: d@4000']);
  });

  it('copies a sound heard to the end of the post where it is, onto another lane', () => {
    // A loop with no stop, which a template's score is.
    const score = sound('a', 0, { loop: true });
    const copied = duplicateAudioClip(lanes([score], [sound('e', 0)]), 'a', 'b', 'at-new')!;
    expect(layout(copied)).toEqual(['at-1: a@0', 'at-new: b@0', 'at-2: e@0']);
    expect(findAudioClip(copied, 'b')).toEqual({ ...score, id: 'b' });
    // And a sound played once that runs past the end.
    expect(layout(duplicateAudioClip(lanes([sound('a', 18_000)]), 'a', 'b', 'at-new'))).toEqual(['at-1: a@18000', 'at-new: b@18000']);
  });

  it('moves a stop with the copy, and makes one carried past the end "until the end"', () => {
    const stopped = duplicateAudioClip(lanes([sound('a', 1000, { loop: true, endMs: 4000 })]), 'a', 'b', 'at-new')!;
    expect(findAudioClip(stopped, 'b')).toMatchObject({ startMs: 4000, endMs: 7000 });

    const late = duplicateAudioClip(lanes([sound('a', 12_000, { loop: true, endMs: 17_000 })]), 'a', 'b', 'at-new')!;
    expect(findAudioClip(late, 'b')).toMatchObject({ startMs: 17_000, endMs: 0 });
    expect(layout(late)).toEqual(['at-1: a@12000 b@17000']);
  });

  it('starts the copy of a sped-up sound on the next whole millisecond', () => {
    // Five seconds at 3x is 1666.67 ms.
    expect(layout(duplicateAudioClip(lanes([sound('a', 0, { speed: 3 })]), 'a', 'b', 'at-new'))).toEqual(['at-1: a@0 b@1667']);
  });

  it('refuses a copy whose id or new lane is taken, or of a sound that is not there', () => {
    const one = lanes([sound('a', 1000)], [sound('c', 0, { loop: true })]);
    expect(duplicateAudioClip(one, 'a', 'c', 'at-new')).toBeNull();
    expect(duplicateAudioClip(one, 'missing', 'b', 'at-new')).toBeNull();
    // `c` plays to the end, so its copy needs a new lane, and `at-1` is not a new one.
    expect(duplicateAudioClip(one, 'c', 'b', 'at-1')).toBeNull();
  });
});

describe('the music on a lane', () => {
  const music = sound('m', 0, { loop: true });

  it('becomes the only sound on a new first lane, under the ids it is given', () => {
    const withMusic: EditManifest = { ...lanes([sound('x', 0)]), music };
    const moved = musicAsAudioLane(withMusic, 'mu', 'at-0')!;
    expect(moved.music).toBeNull();
    expect(layout(moved)).toEqual(['at-0: mu@0', 'at-1: x@0']);
    expect(findAudioClip(moved, 'mu')).toEqual({ ...music, id: 'mu' });
  });

  it('is refused with no music, or when either id is taken', () => {
    const withMusic: EditManifest = { ...lanes([sound('x', 0)]), music };
    expect(musicAsAudioLane(post(), 'mu', 'at-0')).toBeNull();
    expect(musicAsAudioLane(withMusic, 'x', 'at-0')).toBeNull();
    expect(musicAsAudioLane(withMusic, 'mu', 'at-1')).toBeNull();
  });
});

describe('the halves of a cut, as they are heard', () => {
  const halves = (manifest: EditManifest | null): EditAudioClip[] => manifest!.audioTracks![0]!.clips;

  it('join back into the sound they were cut from, played once or looping, at any speed', () => {
    const cases: [EditAudioClip, number][] = [
      [sound('a', 1000, { inMs: 500, fadeInMs: 300, fadeOutMs: 700 }), 3000],
      [sound('a', 0, { endMs: 4000 }), 1500],
      [sound('a', 0, { speed: 1.5 }), 333],
      [sound('a', 1000, { loop: true, inMs: 1000, outMs: 4000, phaseMs: 500 }), 9000],
      [sound('a', 1000, { loop: true, endMs: 15_000 }), 6000],
    ];
    for (const [a, atMs] of cases) {
      expect(joinContinuousAudio(halves(splitAudioClipAt(lanes([a]), 'a', atMs, 'b'))), `cut at ${atMs}`).toEqual([a]);
    }
    // A phase on a sound played once is folded into the in point by the cut, and stays folded.
    const { phaseMs: _phase, ...folded } = sound('a', 0, { phaseMs: 1000 });
    expect(joinContinuousAudio(halves(splitAudioClipAt(lanes([sound('a', 0, { phaseMs: 1000 })]), 'a', 2000, 'b')))).toEqual([{ ...folded, inMs: 1000 }]);
  });

  it('join a sound cut twice back into one', () => {
    const a = sound('a', 1000, { fadeOutMs: 500 });
    const twice = splitAudioClipAt(splitAudioClipAt(lanes([a]), 'a', 2000, 'b')!, 'b', 4000, 'c');
    expect(halves(twice)).toHaveLength(3);
    expect(joinContinuousAudio(halves(twice))).toEqual([a]);
  });

  it('stay apart once one of them is changed, moved or faded, and leave a copy after them alone', () => {
    const cut = splitAudioClipAt(lanes([sound('a', 0)]), 'a', 2000, 'b')!;
    expect(joinContinuousAudio(halves(patchAudioClip(cut, 'b', { volume: 0.3 })))).toHaveLength(2);
    expect(joinContinuousAudio(halves(patchAudioClip(cut, 'b', { speed: 2 })))).toHaveLength(2);
    expect(joinContinuousAudio(halves(patchAudioClip(cut, 'a', { fadeOutMs: 300 })))).toHaveLength(2);
    expect(joinContinuousAudio(halves(patchAudioClip(cut, 'b', { fadeInMs: 300 })))).toHaveLength(2);
    expect(joinContinuousAudio(halves(moveAudioClip(cut, 'b', 2500)))).toHaveLength(2);
    // The right half plays to the end of its file, so a copy after it starts the file over.
    const copied = duplicateAudioClip(cut, 'b', 'c', 'at-new')!;
    expect(joinContinuousAudio(halves(copied)).map(clip => clip.id)).toEqual(['a', 'c']);
  });
});

describe('a cut sound on the wire', () => {
  const raster = {} as RasterContext;
  const files = new Map([['video', 'file:///video.mp4']]);
  const spec = (manifest: EditManifest) => toComposeSpec(manifest, files, { jobId: 'j', batchId: 'b' }, raster);

  it('goes as the one sound it still is, so no engine has a seam to close', async () => {
    const once = sound('a', 1000, { inMs: 500, fadeInMs: 300, fadeOutMs: 700 });
    expect((await spec(splitAudioClipAt(lanes([once]), 'a', 3000, 'b')!)).audio.musicTracks).toEqual((await spec(lanes([once]))).audio.musicTracks);

    const looped = sound('a', 1000, { loop: true, inMs: 1000, outMs: 4000, phaseMs: 500 });
    expect((await spec(splitAudioClipAt(lanes([looped]), 'a', 9000, 'b')!)).audio.musicTracks).toEqual((await spec(lanes([looped]))).audio.musicTracks);
  });

  it('sends each half with its own trim, stop and fades once they differ', async () => {
    const once = splitAudioClipAt(lanes([sound('a', 1000, { inMs: 500, fadeInMs: 300, fadeOutMs: 700 })]), 'a', 3000, 'b')!;
    expect((await spec(patchAudioClip(once, 'b', { volume: 0.3 }))).audio.musicTracks?.[0]).toEqual([
      expect.objectContaining({ startMs: 1000, inMs: 500, outMs: 2500, fadeInMs: 300, fadeOutMs: 0, volume: 0.8 }),
      expect.objectContaining({ startMs: 3000, inMs: 2500, fadeInMs: 0, fadeOutMs: 700, volume: 0.3 }),
    ]);

    const looped = splitAudioClipAt(lanes([sound('a', 1000, { loop: true, inMs: 1000, outMs: 4000, phaseMs: 500 })]), 'a', 9000, 'b')!;
    const tracks = (await spec(patchAudioClip(looped, 'b', { volume: 0.3 }))).audio.musicTracks?.[0];
    expect(tracks).toEqual([
      expect.objectContaining({ startMs: 1000, phaseMs: 500, endMs: 9000, loop: true }),
      expect.objectContaining({ startMs: 9000, phaseMs: 8500, loop: true }),
    ]);
    expect(tracks?.[1]).not.toHaveProperty('endMs');
  });
});
