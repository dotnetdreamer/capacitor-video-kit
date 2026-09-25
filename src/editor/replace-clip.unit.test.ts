import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, type EditManifest } from './edit-manifest';
import { replaceClipSource, trimClip } from './edit-ops';

/*
 * Replace is a SWAP by default: a segment is a hole of a particular size in a sequence, and what
 * goes in it has to be that size, or swapping one shot for a longer take re-cuts everything after
 * it. An app that would rather take the whole of the new file says so through
 * `EditorEditingOptions.replaceKeepsLength`, and the last block below is that host.
 */

const TEN_S = 10_000;

/** Three four-second segments, which is a post as the editor hands one over. */
function post(): EditManifest {
  return {
    ...emptyManifest(),
    clips: [defaultClipEdit('a', 4000), defaultClipEdit('b', 4000), defaultClipEdit('c', 4000)],
  };
}

function clipOf(manifest: EditManifest, id: string) {
  return manifest.clips.find((clip) => clip.id === id);
}

describe('replaceClipSource', () => {
  it('keeps the length of the segment it is filling', () => {
    const next = replaceClipSource(post(), 'b', 'new', TEN_S);

    expect(clipOf(next, 'b')).toMatchObject({ clipKey: 'new', inMs: 0, outMs: 4000 });
  });

  it('leaves everything after it where it was', () => {
    const before = post();
    const next = replaceClipSource(before, 'b', 'new', TEN_S);

    expect(clipOf(next, 'c')).toEqual(clipOf(before, 'c'));
  });

  /* A segment somebody has already trimmed is that trim's length, not the source's. */
  it('keeps a trimmed length rather than the length of the file', () => {
    const trimmed = trimClip(post(), 'b', 1000, 2500, 4000);
    const next = replaceClipSource(trimmed, 'b', 'new', TEN_S);

    expect(clipOf(next, 'b')).toMatchObject({ inMs: 0, outMs: 1500 });
  });

  /* Nothing can claim frames a file does not have. */
  it('gives up what is not there when the new clip is shorter than the hole', () => {
    const next = replaceClipSource(post(), 'b', 'short', 1500);

    expect(clipOf(next, 'b')).toMatchObject({ clipKey: 'short', inMs: 0, outMs: 1500 });
  });

  it('keeps the speed and the sound the segment already had', () => {
    const before = post();
    before.clips[1] = { ...before.clips[1], speed: 2, muted: true, volume: 0.4 };
    const next = replaceClipSource(before, 'b', 'new', TEN_S);

    expect(clipOf(next, 'b')).toMatchObject({ speed: 2, muted: true, volume: 0.4 });
  });

  it('answers with the same manifest for a segment that is not there', () => {
    const before = post();
    expect(replaceClipSource(before, 'nope', 'new', TEN_S)).toBe(before);
  });
});

describe('replaceClipSource, for a host that does not want the length kept', () => {
  it('takes the whole of the new file', () => {
    const next = replaceClipSource(post(), 'b', 'new', TEN_S, false);

    expect(clipOf(next, 'b')).toMatchObject({ clipKey: 'new', inMs: 0, outMs: TEN_S });
  });

  it('takes the whole of it even where the segment had been trimmed', () => {
    const trimmed = trimClip(post(), 'b', 1000, 2500, 4000);
    const next = replaceClipSource(trimmed, 'b', 'new', TEN_S, false);

    expect(clipOf(next, 'b')).toMatchObject({ inMs: 0, outMs: TEN_S });
  });
});
