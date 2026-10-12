import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditClip, type EditManifest } from './edit-manifest';
import { slipClip, timelineSlots } from './edit-ops';

/*
 * A slip: the same length of a clip, from another point in it - the Trim sheet's whole promise, and
 * the easy one to break with an edge that gives way at the end of the source and quietly shortens
 * the segment.
 */

const TEN_S = 10_000;

/** Three segments, the middle one 2..5 s of a ten second clip: a segment somebody has trimmed. */
function post(middle: Partial<EditClip> = {}): EditManifest {
  return {
    ...emptyManifest(),
    clips: [defaultClipEdit('a', 4000), { ...defaultClipEdit('b', TEN_S), inMs: 2000, outMs: 5000, ...middle }, defaultClipEdit('c', 4000)],
  };
}

function clipOf(manifest: EditManifest, id: string): EditClip | undefined {
  return manifest.clips.find(clip => clip.id === id);
}

describe('slipClip', () => {
  it('plays the same length of the clip from another point in it', () => {
    expect(clipOf(slipClip(post(), 'b', 6000, TEN_S), 'b')).toMatchObject({ inMs: 6000, outMs: 9000 });
  });

  it('moves nothing on the timeline', () => {
    const before = post({ transitionIn: { kind: 'dissolve', durationMs: 400 } });
    const after = slipClip(before, 'b', 6000, TEN_S);
    const place = (m: EditManifest) => timelineSlots(m).map(slot => [slot.clip.id, slot.startMs, slot.durationMs, slot.transitionInMs]);

    expect(place(after)).toEqual(place(before));
    expect(clipOf(after, 'a')).toBe(clipOf(before, 'a'));
    expect(clipOf(after, 'c')).toBe(clipOf(before, 'c'));
    expect(clipOf(after, 'b')?.transitionIn).toEqual({ kind: 'dissolve', durationMs: 400 });
  });

  /* Where a trim would let the far edge give way, and the segment would come out shorter. */
  it('stops at either end of the clip, at the length it has', () => {
    expect(clipOf(slipClip(post(), 'b', 9000, TEN_S), 'b')).toMatchObject({ inMs: 7000, outMs: 10_000 });
    expect(clipOf(slipClip(post(), 'b', -500, TEN_S), 'b')).toMatchObject({ inMs: 0, outMs: 3000 });
  });

  it('slides a segment at another speed by its footage, so it still plays for as long', () => {
    const fast = post({ speed: 2 });
    const after = slipClip(fast, 'b', 1000, TEN_S);

    expect(clipOf(after, 'b')).toMatchObject({ inMs: 1000, outMs: 4000, speed: 2 });
    expect(timelineSlots(after)[1].durationMs).toBe(timelineSlots(fast)[1].durationMs);
  });

  it('slides a segment on a layer', () => {
    const layered: EditManifest = {
      ...post(),
      videoTracks: [{ id: 'track-1', clips: [{ ...defaultClipEdit('d', TEN_S), inMs: 0, outMs: 2000 }], startMs: 1000, z: 1, opacity: 1 }],
    };

    expect(slipClip(layered, 'd', 5000, TEN_S).videoTracks[0].clips[0]).toMatchObject({ inMs: 5000, outMs: 7000 });
  });

  it('goes as far as asked on a clip whose length is not known', () => {
    expect(clipOf(slipClip(post(), 'b', 50_000, 0), 'b')).toMatchObject({ inMs: 50_000, outMs: 53_000 });
  });

  it('answers the same manifest when nothing moves, and for a picture, which has no time to slide', () => {
    const before = post();
    expect(slipClip(before, 'b', 2000, TEN_S)).toBe(before);
    expect(slipClip(before, 'missing', 2000, TEN_S)).toBe(before);

    const still = post({ image: true, inMs: 1_800_000, outMs: 1_803_000 });
    expect(slipClip(still, 'b', 0, TEN_S)).toBe(still);
  });
});
