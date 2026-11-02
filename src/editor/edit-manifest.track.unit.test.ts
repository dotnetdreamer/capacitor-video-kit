import { describe, expect, it } from 'vitest';

import { defaultClipEdit, emptyManifest, MANIFEST_VERSION, normaliseManifest, type EditManifest } from './edit-manifest';
import { compileLayoutMotions } from './layout-motion';
import { MAX_TRACKS, TRACK_HUES } from './overlay-track';
import { trackedPoseAt, type TrackScene } from './track-motion';

/*
 * Drafts from before tracks were layers of their own. Version 20 kept a tracked layer's path and its pin
 * together in the layer's own `track`; read today, each such path is a track of the post ("Track 1",
 * "Track 2", in layer order) that its layer follows, pinned exactly as it was, so the draft plays back as
 * it did. The post is 720x1280 over one 10 s clip of the same shape, and the thing walks from the left to
 * the right at mid height.
 */

const ASPECT = 720 / 1280;
const AT_MS = Array.from({ length: 11 }, (_, i) => i * 1000);

/** A version-20 layer's own track: the thing walking right, the layer pinned a tenth of the frame above it. */
function layerTrack(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    clipId: 'a',
    clipKey: 'a',
    aspect: ASPECT,
    box: { w: 0.2, h: 0.1 },
    atMs: AT_MS,
    x: AT_MS.map(t => 0.2 + (0.6 * t) / 10_000),
    y: AT_MS.map(() => 0.5),
    scale: AT_MS.map(() => 1),
    turn: AT_MS.map(() => 0),
    pin: { atMs: 0, dx: 0, dy: -0.1 },
    smooth: 0,
    ...overrides,
  };
}

/** A text layer as a draft keeps one, with whatever else `extra` says: a version-20 `track`, a `follow`. */
function layer(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    kind: 'text',
    text: 'Runner',
    styleId: 'classic',
    color: '#ffffff',
    effect: 'shadow',
    align: 'center',
    cx: 0.2,
    cy: 0.4,
    scale: 1,
    rotationDeg: 0,
    opacity: 1,
    startMs: 0,
    endMs: 0,
    ...extra,
  };
}

/** A draft of `version` over the 10 s clip, with `overlays` on it and whatever else `extra` says, as JSON hands it back. */
function draft(version: number, overlays: Record<string, unknown>[], extra: Record<string, unknown> = {}): unknown {
  return JSON.parse(JSON.stringify({ ...emptyManifest(), version, output: { width: 720, height: 1280, fps: 30 }, clips: [defaultClipEdit('a', 10_000)], overlays, ...extra }));
}

/** A version-21 track of the post: the thing walking right. */
function track(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const { pin: _pin, ...path } = layerTrack();
  return { ...path, id, name: 'Track 1', hue: 0, ...overrides };
}

function scene(m: EditManifest): TrackScene {
  return { manifest: m, camera: null, layout: compileLayoutMotions(m) };
}

describe('a version-20 draft with tracked layers', () => {
  it('reads a layer\'s own track as Track 1 of the post, which the layer follows pinned as it was', () => {
    const read = normaliseManifest(draft(20, [layer('t', { track: layerTrack({ pin: { atMs: 2000, dx: 0.05, dy: -0.1, grow: 1.5 }, scaleWith: true, turnWith: true }) })]));
    expect(read.version).toBe(MANIFEST_VERSION);
    expect(read.tracks).toHaveLength(1);
    const track = read.tracks![0]!;
    expect(track).toMatchObject({ id: 'trk-t', name: 'Track 1', hue: 0, clipId: 'a', clipKey: 'a', atMs: AT_MS, smooth: 0 });
    expect(Object.keys(track)).not.toContain('pin');
    expect(Object.keys(track)).not.toContain('scaleWith');
    const overlay = read.overlays[0]!;
    expect(overlay.follow).toEqual({ trackId: 'trk-t', pin: { atMs: 2000, dx: 0.05, dy: -0.1, grow: 1.5 }, scaleWith: true, turnWith: true });
    expect('track' in overlay).toBe(false);
  });

  it('plays a migrated layer back where version 20 drew it', () => {
    const plain = normaliseManifest(draft(20, [layer('t', { track: layerTrack() })]));
    const pose = trackedPoseAt(plain.overlays[0]!, scene(plain), 5000)!;
    expect(pose.cx).toBeCloseTo(0.5, 6);
    expect(pose.cy).toBeCloseTo(0.4, 6);

    const middle = AT_MS.map(() => 0.5);
    const growing = normaliseManifest(draft(20, [layer('t', { cx: 0.5, track: layerTrack({ x: middle, scale: AT_MS.map(t => 1 + t / 10_000), scaleWith: true }) })]));
    const grown = trackedPoseAt(growing.overlays[0]!, scene(growing), 10_000)!;
    expect(grown.cy).toBeCloseTo(0.3, 6);
    expect(grown.scale).toBeCloseTo(2, 6);

    const turning = normaliseManifest(draft(20, [layer('t', { cx: 0.5, track: layerTrack({ x: middle, turn: AT_MS.map(t => (90 * t) / 10_000), turnWith: true }) })]));
    const turned = trackedPoseAt(turning.overlays[0]!, scene(turning), 10_000)!;
    // A tenth of the HEIGHT above, turned a quarter clockwise, is a tenth of the height to the right.
    expect(turned.cx).toBeCloseTo(0.5 + 0.1 / ASPECT, 6);
    expect(turned.cy).toBeCloseTo(0.5, 6);
    expect(turned.rotationDeg).toBeCloseTo(90, 6);
  });

  it('makes two tracked layers Track 1 and Track 2, in the first two colours, each following its own', () => {
    const read = normaliseManifest(draft(20, [layer('a1', { track: layerTrack() }), layer('plain'), layer('b2', { track: layerTrack({ pin: { atMs: 0, dx: 0.1, dy: 0 } }) })]));
    expect(read.tracks!.map(t => [t.id, t.name, t.hue])).toEqual([
      ['trk-a1', 'Track 1', 0],
      ['trk-b2', 'Track 2', 1],
    ]);
    expect(read.overlays.map(o => o.follow?.trackId)).toEqual(['trk-a1', undefined, 'trk-b2']);
    expect(read.overlays[2]!.follow!.pin).toEqual({ atMs: 0, dx: 0.1, dy: 0 });
  });

  it('makes no more than MAX_TRACKS tracks, the layers past them standing where they were put', () => {
    const layers = Array.from({ length: MAX_TRACKS + 2 }, (_, i) => layer(`l${i}`, { track: layerTrack() }));
    const read = normaliseManifest(draft(20, layers));
    expect(read.tracks).toHaveLength(MAX_TRACKS);
    expect(read.tracks!.map(t => t.hue)).toEqual(Array.from({ length: MAX_TRACKS }, (_, i) => i % TRACK_HUES));
    expect(read.tracks!.at(-1)!.name).toBe(`Track ${MAX_TRACKS}`);
    expect(read.overlays.filter(o => o.follow)).toHaveLength(MAX_TRACKS);
    expect(read.overlays.at(-1)!.follow).toBeUndefined();
    expect(read.overlays.at(-1)!.cx).toBe(0.2);
  });

  it('makes nothing of a track that is not one, and never of an effect\'s', () => {
    const effect = { ...layer('e', { track: layerTrack() }), kind: 'effect', effectId: 'grain' };
    const read = normaliseManifest(draft(20, [layer('t', { track: layerTrack({ pin: undefined }) }), effect]));
    expect('tracks' in read).toBe(false);
    expect(read.overlays.map(o => o.follow)).toEqual([undefined, undefined]);
  });

  it('names a migrated track apart from a track the draft already has', () => {
    const read = normaliseManifest(draft(21, [layer('t', { track: layerTrack() })], { tracks: [track('trk-t', { name: 'Dog' })] }));
    expect(read.tracks!.map(t => [t.id, t.name, t.hue])).toEqual([
      ['trk-t', 'Dog', 0],
      ['trk-t-2', 'Track 2', 1],
    ]);
    expect(read.overlays[0]!.follow!.trackId).toBe('trk-t-2');
  });
});

describe('a version-21 draft', () => {
  it('is read back as it was written, its tracks and its follows the same', () => {
    const migrated = normaliseManifest(draft(20, [layer('a1', { track: layerTrack({ scaleWith: true }) }), layer('b2', { track: layerTrack() })]));
    const again = normaliseManifest(JSON.parse(JSON.stringify(migrated)));
    expect(again).toEqual(migrated);
  });

  it('drops a follow that names a track the post does not have, leaving the layer where it was put', () => {
    const follow = { trackId: 'gone', pin: { atMs: 0, dx: 0, dy: -0.1 } };
    const none = normaliseManifest(draft(21, [layer('t', { follow })]));
    expect('follow' in none.overlays[0]!).toBe(false);
    expect(none.overlays[0]!.cx).toBe(0.2);
    expect('tracks' in none).toBe(false);
    const other = normaliseManifest(draft(21, [layer('t', { follow }), layer('u', { follow: { ...follow, trackId: 'k' } })], { tracks: [track('k')] }));
    expect(other.overlays.map(o => o.follow?.trackId)).toEqual([undefined, 'k']);
  });

  it('keeps the first of two tracks with one id, and no more than MAX_TRACKS', () => {
    const tracks = [track('k'), track('k', { name: 'Again' }), ...Array.from({ length: MAX_TRACKS + 1 }, (_, i) => track(`t${i}`))];
    const read = normaliseManifest(draft(21, [], { tracks }));
    expect(read.tracks).toHaveLength(MAX_TRACKS);
    expect(read.tracks![0]!.name).toBe('Track 1');
    expect(new Set(read.tracks!.map(t => t.id)).size).toBe(MAX_TRACKS);
  });

  it('never has an effect follow a track', () => {
    const effect = { ...layer('e', { follow: { trackId: 'k', pin: { atMs: 0, dx: 0, dy: 0 } } }), kind: 'effect', effectId: 'grain' };
    const read = normaliseManifest(draft(21, [effect], { tracks: [track('k')] }));
    expect(read.overlays[0]!.follow).toBeUndefined();
    expect(read.tracks).toHaveLength(1);
  });
});
