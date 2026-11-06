import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, isUntouched, type EditManifest, type EditTrack } from './edit-manifest';

/*
 * A track's look changes the picture, so a clip whose only edit is a look must be rendered, never posted as
 * the file on disk: a blurred face posted unblurred is the worst way this fast path could fail. A track with
 * no look draws nothing, and leaves the fast path open.
 */

const post = (tracks?: EditTrack[]): EditManifest => ({
  ...emptyManifest(),
  clips: [defaultClipEdit('video', 20_000, 'seg-1')],
  ...(tracks ? { tracks } : {}),
});

const track = (over: Partial<EditTrack> = {}): EditTrack => ({
  id: 'trk-1',
  name: 'Track 1',
  hue: 0,
  clipId: 'seg-1',
  clipKey: 'video',
  aspect: 9 / 16,
  box: { w: 0.3, h: 0.2 },
  atMs: [0, 1000, 2000],
  x: [0.4, 0.5, 0.6],
  y: [0.5, 0.5, 0.5],
  scale: [1, 1, 1],
  turn: [0, 0, 0],
  ...over,
});

describe('a track look and the untouched fast path', () => {
  const durations = new Map([['video', 20_000]]);

  it('still posts a clip as the file when its only track has no look', () => {
    expect(isUntouched(post(), durations, 9 / 16)).toBe(true);
    expect(isUntouched(post([track()]), durations, 9 / 16)).toBe(true);
  });

  it('renders a clip whose track blurs, dims or greys something', () => {
    for (const kind of ['blur', 'spotlight', 'pop'] as const) {
      expect(isUntouched(post([track({ look: { kind, amount: 0.7 } })]), durations, 9 / 16)).toBe(false);
    }
  });
});
