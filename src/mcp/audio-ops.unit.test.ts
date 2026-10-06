import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest } from '../editor/edit-manifest';
import { applyEditOps, type EditOp } from './ops';
import { summariseManifest } from './summary';
import { OP_REFERENCE } from './tools';

/*
 * An agent places sounds on the audio lanes where the editor's own controls would: a lane plays one
 * sound at a time, so a sound that overlaps another opens a lane of its own and one that follows it
 * shares its lane - and a sound the lanes cannot hold is refused with the reason, never dropped.
 */

/** Twenty seconds of video, and nothing else. */
const post = (): EditManifest => ({ ...emptyManifest(), clips: [defaultClipEdit('v', 20_000)] });

/** A five-second file, played once from `startMs`. */
const sound = (name: string, startMs: number) => ({ uri: `file:///${name}.m4a`, fileName: `${name}.m4a`, sourceDurationMs: 5000, startMs });

const add = (id: string, startMs: number, extra: Record<string, unknown> = {}): EditOp => ({ op: 'addAudio', id, sound: sound(id, startMs), ...extra });

const lanesOf = (manifest: EditManifest): string[] => (manifest.audioTracks ?? []).map(track => `${track.id}: ${track.clips.map(clip => `${clip.id}@${clip.startMs}`).join(' ')}`);

describe('the audio lane ops', () => {
  it('puts a following sound on the same lane and an overlapping one on a lane of its own', () => {
    const manifest = applyEditOps(post(), [add('a', 0), add('b', 5000), add('c', 2000)]);
    expect(lanesOf(manifest)).toEqual(['lane-a: a@0 b@5000', 'lane-c: c@2000']);
  });

  it('puts a sound on the lane it is told to, and refuses one that would meet a neighbour there', () => {
    const two = applyEditOps(post(), [add('a', 0), add('c', 2000)]);
    expect(lanesOf(applyEditOps(two, [add('d', 8000, { trackId: 'lane-c' })]))).toEqual(['lane-a: a@0', 'lane-c: c@2000 d@8000']);
    expect(() => applyEditOps(two, [add('d', 3000, { trackId: 'lane-c' })])).toThrow(/"d" does not fit on lane "lane-c" at 3000ms/);
    expect(() => applyEditOps(two, [add('d', 0, { trackId: 'nope' })])).toThrow(/no audio lane "nope" - lanes on this post: lane-a, lane-c/);
    expect(() => applyEditOps(two, [add('a', 9000)])).toThrow(/sound id "a" is already on this post/);
  });

  it("carries a post's music onto the lanes as their first sound", () => {
    const manifest = applyEditOps(post(), [{ op: 'setMusic', music: sound('old', 0) }, add('a', 1000)]);
    expect(manifest.music).toBeNull();
    expect(lanesOf(manifest)).toEqual(['legacy-audio-track: legacy-music@0', 'lane-a: a@1000']);
  });

  it('patches, moves and removes a sound, keeping each lane free of overlaps', () => {
    const manifest = applyEditOps(post(), [add('a', 0), add('b', 5000)]);
    expect(applyEditOps(manifest, [{ op: 'patchAudio', id: 'a', patch: { volume: 0.3 } }]).audioTracks?.[0]?.clips[0]?.volume).toBe(0.3);
    expect(() => applyEditOps(manifest, [{ op: 'patchAudio', id: 'a', patch: { startMs: 3000 } }])).toThrow(/"a" would meet another sound on its lane/);

    const moved = applyEditOps(manifest, [{ op: 'moveAudioToTrack', id: 'b', target: { kind: 'new', index: 1 }, atMs: 1000 }]);
    expect(lanesOf(moved)).toEqual(['lane-a: a@0', 'lane-b: b@1000']);
    expect(lanesOf(applyEditOps(moved, [{ op: 'removeAudio', id: 'b' }]))).toEqual(['lane-a: a@0']);
    expect(() => applyEditOps(manifest, [{ op: 'removeAudio', id: 'zz' }])).toThrow(/no sound "zz" on the audio lanes - sounds on this post: a, b/);
  });

  it('lists every lane and its sounds in the summary, and says so when there are none', () => {
    const summary = summariseManifest(applyEditOps(post(), [add('a', 0), add('b', 2000)]));
    expect(summary).toMatch(
      /\nAudio lanes: 2 lanes \(sounds on one lane play one after another; lanes play together\)\n {2}lane "lane-a": 1 sound\n {4}"a" a\.m4a, from 0ms, at 0ms on the post, 100%; heard /,
    );
    expect(summary).toMatch(/\n {2}lane "lane-b": 1 sound\n {4}"b" b\.m4a, from 0ms, at 2000ms \(0:02\.0\) on the post/);
    expect(summariseManifest(post())).toMatch(/\nMusic: none\nAudio lanes: none\nVoiceover: none/);
  });

  it('has a line in the op reference for each op', () => {
    for (const op of ['addAudio', 'patchAudio', 'moveAudioToTrack', 'removeAudio']) expect(OP_REFERENCE[op]).toBeTruthy();
  });
});
