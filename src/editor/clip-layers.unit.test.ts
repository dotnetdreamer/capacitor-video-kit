import { describe, expect, it } from 'vitest';

import {
  MAX_POST_MS,
  MAX_VIDEO_TRACKS,
  defaultClipEdit,
  emptyManifest,
  totalDurationMs,
  type EditManifest,
  type EditVideoTrack,
} from './edit-manifest';
import { moveClip, moveClipToTrack, setPostDuration, type ClipDropTarget } from './edit-ops';

/*
 * Carrying a segment off the layer it is on, which is the whole of what makes the timeline more than
 * one row of video: a post opened with every clip on the base track, and the only way to a second
 * picture on the frame was a picker that added one.
 *
 * Every manifest below is built from four-second segments, so the arithmetic in the expectations is
 * readable: the second segment of a track starts at 4000 and the third at 8000.
 */
const FOUR_S = 4000;

function seg(key: string, id = key) {
  return defaultClipEdit(key, FOUR_S, id);
}

function layer(id: string, z: number, clips: string[], startMs = 0): EditVideoTrack {
  return { id, clips: clips.map(c => seg(c)), startMs, z, opacity: 1 };
}

/** Three segments on the base track and nothing over them: the post as the editor opens it. */
function oneTrack(): EditManifest {
  return { ...emptyManifest(), clips: [seg('a'), seg('b'), seg('c')] };
}

function ids(clips: readonly { id: string }[]): string[] {
  return clips.map(clip => clip.id);
}

function move(m: EditManifest, clipId: string, target: ClipDropTarget, atMs: number): EditManifest {
  const next = moveClipToTrack(m, clipId, target, atMs, 'vt-new');
  expect(next).not.toBeNull();
  return next as EditManifest;
}

describe('moveClipToTrack, onto a layer of its own', () => {
  it('takes the segment off the base track and gives it a layer starting where it was dropped', () => {
    const next = move(oneTrack(), 'b', { kind: 'new', index: 0 }, 4000);

    expect(ids(next.clips)).toEqual(['a', 'c']);
    expect(next.videoTracks).toHaveLength(1);
    expect(next.videoTracks[0]).toMatchObject({ id: 'vt-new', startMs: 4000, z: 1, opacity: 1 });
    expect(ids(next.videoTracks[0].clips)).toEqual(['b']);
  });

  it('keeps what the segment is, framing included', () => {
    // A layer arrives unplaced, covering the frame, exactly as `addVideoTrack` leaves the one it
    // opens: a rectangle guessed here is an arrangement the customer never asked for.
    const m = oneTrack();
    m.clips[1] = { ...m.clips[1], speed: 2, volume: 0.4, muted: true, crop: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } };

    const moved = move(m, 'b', { kind: 'new', index: 0 }, 0).videoTracks[0].clips[0];

    expect(moved).toEqual(m.clips[1]);
  });

  it('opens the layer at the row the drop was under, and renumbers the stack to match', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x']), layer('vt-2', 2, ['y'])] };

    // The gap under the first layer, which is row 1 counting the base track as row 0.
    const next = move(m, 'b', { kind: 'new', index: 1 }, 0);

    expect(next.videoTracks.map(t => t.id)).toEqual(['vt-1', 'vt-new', 'vt-2']);
    // `z` is the drawing order all four engines read and the rows are drawn in the same order: a row
    // moved without its number moving with it is a timeline that disagrees with the frame.
    expect(next.videoTracks.map(t => t.z)).toEqual([1, 2, 3]);
  });

  it('never lands a layer before the start of the post', () => {
    expect(move(oneTrack(), 'b', { kind: 'new', index: 0 }, -5000).videoTracks[0].startMs).toBe(0);
  });

  it('refuses the last segment of the base track', () => {
    // The base track is what fixes how long the post runs. Emptied, there is nothing for the layers
    // to be cut to and no video at all.
    const one: EditManifest = { ...emptyManifest(), clips: [seg('a')] };
    expect(moveClipToTrack(one, 'a', { kind: 'new', index: 0 }, 0, 'vt-new')).toBeNull();
  });

  it('refuses a layer past the cap', () => {
    const full = Array.from({ length: MAX_VIDEO_TRACKS - 1 }, (_, i) => layer(`vt-${i}`, i + 1, [`x${i}`, `y${i}`]));
    const m: EditManifest = { ...oneTrack(), videoTracks: full };
    expect(moveClipToTrack(m, 'b', { kind: 'new', index: 0 }, 0, 'vt-new')).toBeNull();
  });

  it('lets a layer that this move empties pay for the one it opens', () => {
    // One layer goes as another arrives, so the cap is not passed at any point. Refusing here would
    // be a customer unable to move the layers they already have.
    const full = Array.from({ length: MAX_VIDEO_TRACKS - 2 }, (_, i) => layer(`vt-${i}`, i + 1, [`x${i}`, `y${i}`]));
    const m: EditManifest = { ...oneTrack(), videoTracks: [...full, layer('alone', MAX_VIDEO_TRACKS - 1, ['solo'])] };

    const next = move(m, 'solo', { kind: 'new', index: 0 }, 2000);

    expect(next.videoTracks).toHaveLength(MAX_VIDEO_TRACKS - 1);
    expect(ids(next.videoTracks[0].clips)).toEqual(['solo']);
  });

  it('slides a one-segment layer along the timeline rather than replacing it', () => {
    // The only segment of a layer, put back in the gap that layer already filled. Nothing has been
    // replaced: it keeps its id, and with it its opacity and anything open on it.
    const m: EditManifest = { ...oneTrack(), videoTracks: [{ ...layer('vt-1', 1, ['x']), opacity: 0.5 }] };

    const next = move(m, 'x', { kind: 'new', index: 0 }, 6000);

    expect(next.videoTracks).toHaveLength(1);
    expect(next.videoTracks[0]).toMatchObject({ id: 'vt-1', startMs: 6000, opacity: 0.5 });
  });

  it('counts the gaps as the customer saw them, not as the lift leaves them', () => {
    // Lifting the only segment off the first layer takes that row away, and every gap under it moves
    // up one. The drop was aimed at the gap under the SECOND layer, which is where it has to land.
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x']), layer('vt-2', 2, ['y'])] };

    const next = move(m, 'x', { kind: 'new', index: 2 }, 0);

    expect(next.videoTracks.map(t => t.id)).toEqual(['vt-2', 'vt-new']);
    expect(next.videoTracks.map(t => t.z)).toEqual([1, 2]);
  });
});

describe('moveClipToTrack, onto a layer that is already there', () => {
  it('drops the segment into that layer at the place the time it was let go falls', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x', 'y'], 1000)] };

    // The layer starts at 1000 and its two segments run 1000..5000 and 5000..9000. Let go at 7500 is
    // past the halfway line of the second one, so the gap after it.
    const next = move(m, 'b', { kind: 'track', trackId: 'vt-1' }, 7500);

    expect(ids(next.clips)).toEqual(['a', 'c']);
    expect(ids(next.videoTracks[0].clips)).toEqual(['x', 'y', 'b']);
    // A sequence has no gaps in it, so a drop inside one leaves the layer's own start alone.
    expect(next.videoTracks[0].startMs).toBe(1000);
  });

  it('drops before a segment when the time is in its first half', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x', 'y'], 1000)] };
    expect(ids(move(m, 'b', { kind: 'track', trackId: 'vt-1' }, 5500).videoTracks[0].clips)).toEqual(['x', 'b', 'y']);
  });

  it('carries a segment back onto the base track', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x', 'y'])] };

    const next = move(m, 'x', { kind: 'base' }, 4000);

    expect(ids(next.clips)).toEqual(['a', 'x', 'b', 'c']);
    expect(ids(next.videoTracks[0].clips)).toEqual(['y']);
  });

  it('drops the layer a move empties', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x'])] };
    expect(move(m, 'x', { kind: 'base' }, 0).videoTracks).toEqual([]);
  });

  it('refuses a drop back onto the row the segment came from', () => {
    // Which place in its own row a segment takes is the sideways half of the same drag, and
    // `moveClip` is what answers that.
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x', 'y'])] };
    expect(moveClipToTrack(m, 'b', { kind: 'base' }, 0, 'vt-new')).toBeNull();
    expect(moveClipToTrack(m, 'x', { kind: 'track', trackId: 'vt-1' }, 0, 'vt-new')).toBeNull();
  });

  it('refuses a segment and a layer it has never heard of', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x'])] };
    expect(moveClipToTrack(m, 'nope', { kind: 'base' }, 0, 'vt-new')).toBeNull();
    expect(moveClipToTrack(m, 'b', { kind: 'track', trackId: 'gone' }, 0, 'vt-new')).toBeNull();
  });
});

describe('moveClip, on whichever row the segment is on', () => {
  it('reorders the base track', () => {
    expect(ids(moveClip(oneTrack(), 'c', 0).clips)).toEqual(['c', 'a', 'b']);
  });

  it('reorders a layer without touching the base track', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x', 'y', 'z'])] };

    const next = moveClip(m, 'z', 0);

    expect(ids(next.videoTracks[0].clips)).toEqual(['z', 'x', 'y']);
    expect(next.clips).toBe(m.clips);
  });

  it('is the same manifest when nothing moves', () => {
    const m: EditManifest = { ...oneTrack(), videoTracks: [layer('vt-1', 1, ['x', 'y'])] };
    expect(moveClip(m, 'b', 1)).toBe(m);
    expect(moveClip(m, 'x', 0)).toBe(m);
    expect(moveClip(m, 'nope', 0)).toBe(m);
  });
});

/*
 * The tail: the post running on past its base track, with a black frame where there is no footage.
 *
 * It is what makes a layer placeable anywhere rather than only where the base already reaches - a
 * second video that plays AFTER the first had nowhere to be dragged to before it.
 */
describe('setPostDuration', () => {
  it('pulls the end past the base track', () => {
    const m = oneTrack();
    expect(totalDurationMs(m)).toBe(12_000);

    const longer = setPostDuration(m, 20_000);

    expect(longer.durationMs).toBe(20_000);
    expect(totalDurationMs(longer)).toBe(20_000);
    // The base track is untouched: what the tail adds is room, not footage.
    expect(longer.clips).toBe(m.clips);
  });

  it('never cuts into the base track', () => {
    expect(setPostDuration(oneTrack(), 5000).durationMs).toBe(0);
    expect(totalDurationMs(setPostDuration(oneTrack(), 5000))).toBe(12_000);
  });

  it('stores no tail at all once the end is back inside the base track', () => {
    // 0 and "as long as the base track" are the same post, and only one of them can be the stored
    // one, or a manifest carrying a redundant number would reach the wire as a spec that says
    // something where today's says nothing.
    const stretched = setPostDuration(oneTrack(), 20_000);
    expect(setPostDuration(stretched, 12_000).durationMs).toBe(0);
  });

  it('stops at the ceiling rather than wherever a finger was carried', () => {
    expect(setPostDuration(oneTrack(), MAX_POST_MS * 10).durationMs).toBe(MAX_POST_MS);
  });

  it('is the same manifest when nothing changes', () => {
    const m = oneTrack();
    expect(setPostDuration(m, 12_000)).toBe(m);
    const stretched = setPostDuration(m, 20_000);
    expect(setPostDuration(stretched, 20_000)).toBe(stretched);
  });

  it('gives a layer somewhere past the base track to be', () => {
    // The whole point of the tail, in one assertion: a layer laid after the base track's last frame
    // used to be a layer every engine cut away to nothing.
    const m = setPostDuration(oneTrack(), 20_000);
    const moved = moveClipToTrack(m, 'b', { kind: 'new', index: 0 }, 16_000, 'vt-new');

    expect(moved!.videoTracks[0].startMs).toBe(16_000);
    // And it still ends inside the post, which is what every engine cuts to.
    expect(moved!.videoTracks[0].startMs).toBeLessThan(totalDurationMs(moved!));
  });
});
