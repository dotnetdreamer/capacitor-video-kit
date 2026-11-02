import { describe, expect, it } from 'vitest';

import { MAX_OVERLAY_MOTION_KEYS, type ComposeCamera, type ComposeOverlayMotion } from '../video-composer/definitions';
import { toComposeSpec } from './compose';
import {
  defaultClipEdit,
  defaultPictureEdit,
  emptyManifest,
  MAX_SCALE,
  MIN_SCALE,
  normaliseManifest,
  type EditClip,
  type EditManifest,
  type EditOverlay,
  type EditTrack,
  type OverlayFollow,
  type TextOverlay,
} from './edit-manifest';
import { duplicateOverlay, patchOverlay, splitOverlayAt } from './edit-ops';
import { compileLayoutMotions } from './layout-motion';
import { compileOverlayMotion, normaliseOverlayMotion, overlayMotionAt } from './motion';
import { cutTrackAt, MAX_SMOOTH_MS, mendTrack, normaliseEditTrack, pathAt, SEAM_REACH_MS, trackPath } from './overlay-track';
import type { RasterContext } from './raster-context';
import {
  combineMotions,
  compileLayerMotion,
  compileTrackMotion,
  followedTrack,
  followersOf,
  followPatch,
  outputMsOf,
  refollowAt,
  repinOverlay,
  trackById,
  trackedFootage,
  trackedPoseAt,
  trackedThingAt,
  trackFromRun,
  trackStretches,
  unfollowOverlay,
  type TrackRunResult,
  type TrackScene,
} from './track-motion';

/*
 * A 720x1280 post over one 10 s clip of the same shape, so a source fraction is an output fraction until
 * something - a trim, a zoom, a layout - says otherwise. Its one track, "k", has the thing walk from the
 * left to the right at mid height, one sample a second, and the text follows it a tenth of the frame
 * above it.
 */

const ASPECT = 720 / 1280;

function walk(overrides: Partial<EditTrack> = {}): EditTrack {
  const atMs = Array.from({ length: 11 }, (_, i) => i * 1000);
  return {
    id: 'k',
    name: 'Track 1',
    hue: 0,
    clipId: 'a',
    clipKey: 'a',
    aspect: ASPECT,
    box: { w: 0.2, h: 0.1 },
    atMs,
    x: atMs.map(t => 0.2 + (0.6 * t) / 10_000),
    y: atMs.map(() => 0.5),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    smooth: 0,
    ...overrides,
  };
}

/** Following track "k" a tenth of the frame above the thing, pinned on its first sample. */
function follow(overrides: Partial<OverlayFollow> = {}): OverlayFollow {
  return { trackId: 'k', pin: { atMs: 0, dx: 0, dy: -0.1 }, ...overrides };
}

function post(clips: EditClip[] = [defaultClipEdit('a', 10_000)], tracks: EditTrack[] = [walk()]): EditManifest {
  const m = emptyManifest();
  m.output = { width: 720, height: 1280, fps: 30 };
  m.clips = clips;
  m.tracks = tracks;
  return m;
}

/** The post over the one 10 s clip, with `tracks` for its tracks. */
function on(...tracks: EditTrack[]): EditManifest {
  return post(undefined, tracks);
}

function text(follows: OverlayFollow | null = follow(), overrides: Partial<TextOverlay> = {}): TextOverlay {
  return {
    id: 't',
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
    ...(follows ? { follow: follows } : {}),
    ...overrides,
  };
}

function scene(m: EditManifest, camera: ComposeCamera | null = null): TrackScene {
  return { manifest: m, camera, layout: compileLayoutMotions(m) };
}

/** Where a layer is drawn at `t` on the wire: its centre plus its motion's offset there. */
function drawnAt(overlay: EditOverlay, motion: ComposeOverlayMotion | null, t: number): { x: number; y: number } {
  const pose = overlayMotionAt(motion, t);
  return { x: overlay.cx + (pose?.x ?? 0), y: overlay.cy + (pose?.y ?? 0) };
}

/** `a` on post `ma` and `b` on post `mb` drawn alike at every one of `times`: to a fiftieth of a pixel on the 720x1280 post. */
function alike(a: EditOverlay, ma: EditManifest, b: EditOverlay, mb: EditManifest, times: number[], label: string): void {
  for (const t of times) {
    const p = trackedPoseAt(a, scene(ma), t)!;
    const q = trackedPoseAt(b, scene(mb), t)!;
    expect(Math.abs(q.cx - p.cx) * 720, `x at ${t}, ${label}`).toBeLessThan(0.02);
    expect(Math.abs(q.cy - p.cy) * 1280, `y at ${t}, ${label}`).toBeLessThan(0.02);
    expect(q.scale, `size at ${t}, ${label}`).toBeCloseTo(p.scale, 5);
    expect(q.rotationDeg, `turn at ${t}, ${label}`).toBeCloseTo(p.rotationDeg, 2);
  }
}

/** A frame every 33 ms for 10 s: the thing walking right and bobbing, growing and turning a little. */
function filmed(overrides: Partial<EditTrack> = {}): EditTrack {
  const atMs = Array.from({ length: 301 }, (_, i) => Math.round(i * 33.3));
  return walk({
    atMs,
    x: atMs.map(t => 0.3 + (0.4 * t) / 10_000),
    y: atMs.map(t => 0.5 + 0.05 * Math.sin(t / 700)),
    scale: atMs.map(t => 1 + t / 50_000),
    turn: atMs.map(t => (20 * t) / 10_000),
    smooth: 0.3,
    ...overrides,
  });
}

/**
 * A run over `track`'s frames `from` to `to` (indices), the box put on the frame at `anchor`: the thing
 * found `dx` of the frame right of where [filmed] has it, its size and turn measured against the anchor
 * frame's, as a run measures them.
 */
function rerun(track: EditTrack, from: number, to: number, anchor: number, dx = 0.08): TrackRunResult {
  const atMs = track.atMs.slice(from, to + 1);
  const anchorMs = track.atMs[anchor]!;
  const at = pathAt(trackPath(track), anchorMs);
  return {
    clipId: 'a',
    clipKey: 'a',
    aspect: ASPECT,
    box: { w: 0.2, h: 0.1 },
    atMs,
    x: atMs.map(t => 0.3 + (0.4 * t) / 10_000 + dx),
    y: atMs.map(t => 0.5 + 0.05 * Math.sin(t / 700)),
    scale: atMs.map(t => (1 + t / 50_000) / at.scale),
    turn: atMs.map(t => (20 * t) / 10_000 - at.turn),
    sure: atMs.map(() => 100),
    lost: [],
    anchorMs,
  };
}

describe('normaliseEditTrack', () => {
  it('hands a track already in shape back as the very object', () => {
    const track = walk();
    expect(normaliseEditTrack(track)).toBe(track);
  });

  it('leaves out samples that go back in time or are not numbers, and holds the rest to their ranges', () => {
    const track = normaliseEditTrack({ ...walk(), atMs: [0, 500, 400, 900], x: [0.1, 0.2, 0.3, Number.NaN], y: [0.5, 9, 0.5, 0.5], scale: [1, 1, 1, 1], turn: [0, 0, 0, 0] })!;
    expect(track.atMs).toEqual([0, 500]);
    expect(track.y).toEqual([0.5, 3]);
  });

  it('refuses what is not a track', () => {
    expect(normaliseEditTrack(undefined)).toBeUndefined();
    expect(normaliseEditTrack({ ...walk(), id: '' })).toBeUndefined();
    expect(normaliseEditTrack({ ...walk(), clipId: '' })).toBeUndefined();
    expect(normaliseEditTrack({ ...walk(), x: [0.5] })).toBeUndefined();
    expect(normaliseEditTrack({ ...walk(), box: { w: 0, h: 0.1 } })).toBeUndefined();
  });

  it('is read from a draft with the layers that follow it, and is never followed by an effect', () => {
    const m = post();
    m.overlays = [text(), { ...text(), id: 'e', kind: 'effect', effectId: 'grain' } as unknown as EditOverlay];
    const read = normaliseManifest(JSON.parse(JSON.stringify(m)));
    expect(read.tracks).toEqual([walk()]);
    expect(read.overlays[0]!.follow).toEqual(follow());
    expect(read.overlays[1]!.follow).toBeUndefined();
  });
});

describe('trackPath', () => {
  it('smooths a shaking path and leaves a steady one alone', () => {
    // A frame every 33 ms, as a tracker reads 30 fps footage, shaking a fiftieth of the frame each way.
    const atMs = Array.from({ length: 90 }, (_, i) => Math.round(i * 33.3));
    const shaky = walk({
      smooth: 0.6,
      atMs,
      x: atMs.map(() => 0.5),
      y: atMs.map((_, i) => 0.5 + (i % 2 ? 0.02 : -0.02)),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const path = trackPath(shaky);
    for (const y of Array.from(path.y.slice(10, 80))) expect(Math.abs(y - 0.5)).toBeLessThan(0.002);
    const steady = trackPath(walk({ smooth: 1 }));
    expect(pathAt(steady, 5000).x).toBeCloseTo(0.5, 6);
    expect(pathAt(steady, 0).x).toBeCloseTo(0.2, 2);
  });

  it('smooths a steady move onto itself all the way to its first and last frames', () => {
    // A weighted mean would drag the first frame toward the later ones: a fifth of a sigma's worth of
    // the move ahead of the thing, here 0.02 of the frame - fourteen pixels.
    const atMs = Array.from({ length: 61 }, (_, i) => Math.round(i * 33.3));
    const steady = trackPath(walk({ atMs, x: atMs.map(t => 0.2 + t / 10_000), y: atMs.map(() => 0.5), scale: atMs.map(() => 1), turn: atMs.map(() => 0), smooth: 1 }));
    expect(steady.x[0]).toBeCloseTo(0.2, 6);
    expect(steady.x[60]).toBeCloseTo(0.2 + atMs[60]! / 10_000, 6);
  });
});

describe('a following layer on the post', () => {
  it('follows the thing, holding its place against it', () => {
    const m = post();
    const pose = trackedPoseAt(text(), scene(m), 5000)!;
    expect(pose.cx).toBeCloseTo(0.5, 6);
    expect(pose.cy).toBeCloseTo(0.4, 6);
    const motion = compileTrackMotion(text(), scene(m), { startMs: 0, endMs: 10_000 })!;
    expect(drawnAt(text(), motion, 5000).x).toBeCloseTo(0.5, 4);
    expect(drawnAt(text(), motion, 10_000).x).toBeCloseTo(0.8, 4);
    // A key a frame, at 30 fps.
    expect(motion.atMs.length).toBeGreaterThan(290);
  });

  it('reads the footage through the clip trim and speed', () => {
    const clip = { ...defaultClipEdit('a', 10_000), inMs: 2000, speed: 2 };
    const m = post([clip]);
    // Output 1 s is source 4 s at twice the speed: 0.2 + 0.6 * 0.4.
    expect(trackedPoseAt(text(), scene(m), 1000)!.cx).toBeCloseTo(0.44, 6);
  });

  it('is carried by a zoom into the clip', () => {
    const m = post();
    const camera: ComposeCamera = { atMs: [0], scale: [2], cx: [0.5], cy: [0.5] };
    const pose = trackedPoseAt(text(), scene(m, camera), 5000)!;
    // The text is 0.1 above the frame's middle on the footage, so 0.2 above it through a 2x zoom.
    expect(pose.cx).toBeCloseTo(0.5, 6);
    expect(pose.cy).toBeCloseTo(0.3, 6);
  });

  it('follows on across a cut through the tracked clip', () => {
    const left = { ...defaultClipEdit('a', 10_000), outMs: 5000 };
    const right = { ...defaultClipEdit('a', 10_000, 'a2'), inMs: 5000 };
    const m = post([left, right]);
    expect(trackedPoseAt(text(), scene(m), 7500)!.cx).toBeCloseTo(0.65, 6);
  });

  it('follows footage laid out in half of the frame', () => {
    const clip: EditClip = { ...defaultClipEdit('b', 10_000), rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: 'contain' };
    const m = on(walk({ clipId: 'b', clipKey: 'b', x: walk().x.map(() => 0.5) }));
    m.videoTracks = [{ id: 't1', clips: [clip], startMs: 0, z: 1, opacity: 1 }];
    // The picture fills the right half's width and is centred down it: 360x640 at (360, 320).
    const pose = trackedPoseAt(text(follow({ pin: { atMs: 0, dx: 0, dy: 0 } })), scene(m), 3000)!;
    expect(pose.cx).toBeCloseTo(0.75, 6);
    expect(pose.cy).toBeCloseTo(0.5, 6);
  });

  it('grows and turns with the thing only when asked to', () => {
    const growing = on(walk({ scale: walk().atMs.map(t => 1 + t / 10_000), x: walk().x.map(() => 0.5) }));
    expect(trackedPoseAt(text(follow(), { cx: 0.5 }), scene(growing), 10_000)!.cy).toBeCloseTo(0.4, 6);
    const grown = trackedPoseAt(text(follow({ scaleWith: true }), { cx: 0.5 }), scene(growing), 10_000)!;
    expect(grown.cy).toBeCloseTo(0.3, 6);
    expect(grown.scale).toBeCloseTo(2, 6);

    const turning = on(walk({ turn: walk().atMs.map(t => (90 * t) / 10_000), x: walk().x.map(() => 0.5) }));
    const turned = trackedPoseAt(text(follow({ turnWith: true }), { cx: 0.5 }), scene(turning), 10_000)!;
    // A tenth of the HEIGHT above, turned a quarter clockwise, is a tenth of the height to the right.
    expect(turned.cx).toBeCloseTo(0.5 + 0.1 / ASPECT, 6);
    expect(turned.cy).toBeCloseTo(0.5, 6);
    expect(turned.rotationDeg).toBeCloseTo(90, 6);
  });

  it('follows the outgoing clip on under a dissolve, past the end of its own slot', () => {
    // A one-second dissolve into a second clip: the first clip's slot ends at 9 s, its picture at 10.
    const m = post([defaultClipEdit('a', 10_000), { ...defaultClipEdit('b', 10_000), transitionIn: { kind: 'dissolve', durationMs: 1000 } }]);
    const layer = text(follow(), { endMs: 12_000 });
    expect(trackedFootage(walk(), scene(m), 9500)!.sourceMs).toBe(9500);
    expect(trackedPoseAt(layer, scene(m), 9500)!.cx).toBeCloseTo(0.2 + 0.6 * 0.95, 6);
    // Held where its picture ends, once the dissolve is over.
    expect(trackedFootage(walk(), scene(m), 10_500)!.sourceMs).toBe(10_000);
    const motion = compileTrackMotion(layer, scene(m), { startMs: 0, endMs: 12_000 })!;
    expect(drawnAt(layer, motion, 9500).x).toBeCloseTo(0.2 + 0.6 * 0.95, 4);
  });

  it('holds where the clip left it outside the clip', () => {
    const m = post([{ ...defaultClipEdit('a', 10_000), outMs: 4000 }, defaultClipEdit('z', 3000)]);
    const atEnd = trackedPoseAt(text(), scene(m), 4000)!;
    expect(trackedPoseAt(text(), scene(m), 6000)).toEqual(atEnd);
  });

  it('stands where it was put once its footage is gone', () => {
    const m = post([defaultClipEdit('z', 3000)]);
    expect(trackedPoseAt(text(), scene(m), 1000)).toBeNull();
    expect(compileTrackMotion(text(), scene(m), { startMs: 0, endMs: 3000 })).toBeNull();
  });

  it('stands where it was put when the track it follows is not on the post', () => {
    const m = on(walk({ id: 'j' }));
    expect(followedTrack(m, text())).toBeNull();
    expect(trackedPoseAt(text(), scene(m), 5000)).toBeNull();
    expect(compileTrackMotion(text(), scene(m), { startMs: 0, endMs: 10_000 })).toBeNull();
  });

  it('finds the track a layer follows, and the layers that follow a track', () => {
    const m = on(walk(), walk({ id: 'j', name: 'Track 2', hue: 1 }));
    expect(followedTrack(m, text())).toEqual({ track: m.tracks![0], follow: follow() });
    expect(followedTrack(m, text(follow({ trackId: 'j' })))!.track).toBe(m.tracks![1]);
    expect(followedTrack(m, text(null))).toBeNull();
    expect(trackById(m, 'j')).toBe(m.tracks![1]);
    expect(trackById(m, 'gone')).toBeNull();
    expect(trackById(m, null)).toBeNull();
    expect(trackById(emptyManifest(), 'k')).toBeNull();
    const name = text();
    const heart = text(follow({ trackId: 'j' }), { id: 'h' });
    const still = text(null, { id: 's' });
    expect(followersOf([name, heart, still], 'k')).toEqual([name]);
    expect(followersOf([name, heart, still], 'j')).toEqual([heart]);
    expect(followersOf([name, heart, still], 'gone')).toEqual([]);
  });

  it('moves every layer that follows one track, each from its own place against the thing', () => {
    const m = post();
    const name = text();
    const heart = text(follow({ pin: { atMs: 2000, dx: 0.1, dy: 0.05 } }), { id: 'h' });
    for (const t of [3000, 8000]) {
      const x = 0.2 + (0.6 * t) / 10_000;
      expect(trackedPoseAt(name, scene(m), t)!.cx, `name at ${t}`).toBeCloseTo(x, 6);
      expect(trackedPoseAt(name, scene(m), t)!.cy, `name at ${t}`).toBeCloseTo(0.4, 6);
      expect(trackedPoseAt(heart, scene(m), t)!.cx, `heart at ${t}`).toBeCloseTo(x + 0.1, 6);
      expect(trackedPoseAt(heart, scene(m), t)!.cy, `heart at ${t}`).toBeCloseTo(0.55, 6);
    }
  });

  it('draws the box round the thing, turned with it only when asked', () => {
    const track = walk({ x: walk().x.map(() => 0.5), turn: walk().atMs.map(t => (90 * t) / 10_000) });
    const m = on(track);
    const thing = trackedThingAt(track, scene(m), 10_000)!;
    expect(thing.sourceMs).toBe(10_000);
    expect(thing.cx).toBeCloseTo(0.5, 6);
    expect(thing.corners[0]!.x).toBeCloseTo(0.4, 6);
    expect(thing.corners[2]!.y).toBeCloseTo(0.55, 6);
    // A quarter turn clockwise: the box's top-left corner comes round to its top right, its width down the frame.
    const turned = trackedThingAt(track, scene(m), 10_000, true)!;
    expect(turned.cx).toBeCloseTo(0.5, 6);
    expect(turned.corners[0]!.x).toBeCloseTo(0.5 + 0.05 / ASPECT, 6);
    expect(turned.corners[0]!.y).toBeCloseTo(0.5 - 0.1 * ASPECT, 6);
  });
});

describe('moving a following layer', () => {
  it('moves the pin without moving the layer anywhere when nothing is changed', () => {
    const m = on(walk({ scale: walk().atMs.map(t => 1 + t / 20_000), turn: walk().atMs.map(t => t / 500) }));
    const layer = text(follow({ scaleWith: true, turnWith: true }));
    const repinned = { ...layer, ...repinOverlay(layer, scene(m), 3000) } as EditOverlay;
    expect(repinned.follow!.pin.atMs).toBe(3000);
    expect(repinned.follow!.trackId).toBe('k');
    for (const t of [0, 2000, 6500, 10_000]) {
      const a = trackedPoseAt(layer, scene(m), t)!;
      const b = trackedPoseAt(repinned, scene(m), t)!;
      expect(b.cx).toBeCloseTo(a.cx, 4);
      expect(b.cy).toBeCloseTo(a.cy, 4);
      expect(b.scale).toBeCloseTo(a.scale, 4);
      expect(b.rotationDeg).toBeCloseTo(a.rotationDeg, 3);
    }
  });

  it('keeps following the thing from wherever it is dragged to', () => {
    const m = post();
    const layer = text();
    const moved = { ...layer, ...repinOverlay(layer, scene(m), 3000, { cx: 0.38 + 0.1, cy: 0.4 - 0.05 }) } as EditOverlay;
    expect(trackedPoseAt(moved, scene(m), 3000)!.cx).toBeCloseTo(0.48, 6);
    expect(trackedPoseAt(moved, scene(m), 8000)!.cx).toBeCloseTo(0.68 + 0.1, 4);
    expect(trackedPoseAt(moved, scene(m), 8000)!.cy).toBeCloseTo(0.35, 4);
  });

  it('stands still where it is when it is taken off its track', () => {
    const patch = unfollowOverlay(text(), scene(post()), 5000);
    expect('follow' in patch).toBe(true);
    expect(patch.follow).toBeUndefined();
    expect(patch.cx).toBeCloseTo(0.5, 6);
    expect(patch.cy).toBeCloseTo(0.4, 6);
    // Its footage gone, it already stands where it was put.
    expect(unfollowOverlay(text(), scene(post([defaultClipEdit('z', 3000)])), 1000)).toEqual({ follow: undefined });
  });

  it('keeps the layer where it is shown when the path is smoothed differently, pinned to its shown pose', () => {
    const atMs = Array.from({ length: 301 }, (_, i) => Math.round(i * 33.3));
    const shaky = walk({
      atMs,
      x: atMs.map((t, i) => 0.3 + (0.4 * t) / 10_000 + (i % 2 ? 0.01 : -0.01)),
      y: atMs.map(() => 0.5),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
      smooth: 0,
    });
    const layer = text(follow(), { cx: 0.3, cy: 0.4 });
    const at = 4321;
    const shown = trackedPoseAt(layer, scene(on(shaky)), at)!;
    const smoothed = on({ ...shaky, smooth: 0.9 });
    const pinned = { ...layer, ...repinOverlay(layer, scene(smoothed), at, shown) } as EditOverlay;
    const after = trackedPoseAt(pinned, scene(smoothed), at)!;
    // To the pin's own precision: it is kept to a hundred-thousandth of the frame.
    expect(after.cx).toBeCloseTo(shown.cx, 5);
    expect(after.cy).toBeCloseTo(shown.cy, 5);
  });
});

describe('a new track from a run', () => {
  function run(overrides: Partial<TrackRunResult> = {}): TrackRunResult {
    const atMs = Array.from({ length: 11 }, (_, i) => i * 1000);
    return {
      clipId: 'a',
      clipKey: 'a',
      aspect: ASPECT,
      box: { w: 0.2, h: 0.1 },
      atMs,
      x: atMs.map(t => 0.3 + (0.4 * t) / 10_000),
      y: atMs.map(() => 0.6),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
      sure: atMs.map(() => 100),
      lost: [],
      anchorMs: 2000,
      ...overrides,
    };
  }

  it('is named and coloured, and already as the manifest keeps it, saying nothing of a sureness that never wavered', () => {
    const track = trackFromRun(run(), 'k2', 'Track 2', 1);
    expect(track).toMatchObject({ id: 'k2', name: 'Track 2', hue: 1, clipId: 'a', clipKey: 'a', aspect: ASPECT, box: { w: 0.2, h: 0.1 } });
    expect(track.atMs.length).toBe(11);
    expect('sure' in track).toBe(false);
    expect('lost' in track).toBe(false);
    expect('smooth' in track).toBe(false);
    expect(normaliseEditTrack(track)).toBe(track);
  });

  it('keeps how sure the run was, where it lost the thing, and the smoothing asked for', () => {
    const sure = [100, 90, 40, 0, 0, 60, 100, 100, 100, 100, 100];
    const track = trackFromRun(run({ sure, lost: [3000, 4000] }), 'k3', 'Track 3', 2, 0.5);
    expect(track.sure).toEqual(sure);
    expect(track.lost).toEqual([3000, 4000]);
    expect(track.smooth).toBe(0.5);
    expect(normaliseEditTrack(track)).toBe(track);
  });

  it('pins a layer where it stands on the frame the box was drawn on', () => {
    const track = trackFromRun(run(), 'k2', 'Track 2', 1);
    const m = on(track);
    const still = text(null, { cx: 0.5, cy: 0.2 });
    const patch = followPatch(still, track, scene(m), 2000)!;
    expect(patch.follow!.trackId).toBe('k2');
    const tracked = { ...still, ...patch } as EditOverlay;
    expect(trackedPoseAt(tracked, scene(m), 2000)!.cx).toBeCloseTo(0.5, 6);
    expect(trackedPoseAt(tracked, scene(m), 2000)!.cy).toBeCloseTo(0.2, 6);
    // The thing moves 0.04 a second; the layer with it.
    expect(trackedPoseAt(tracked, scene(m), 7000)!.cx).toBeCloseTo(0.7, 6);
  });

  it('moves a layer from the track it followed onto another where it is drawn, following as it did unless told otherwise', () => {
    const other = trackFromRun(run(), 'k2', 'Track 2', 1);
    const m = on(walk({ scale: walk().atMs.map(t => 1 + t / 10_000) }), other);
    const layer = text(follow({ scaleWith: true }));
    const drawn = trackedPoseAt(layer, scene(m), 5000)!;
    const moved = { ...layer, ...followPatch(layer, other, scene(m), 5000) } as EditOverlay;
    expect(moved.follow!.trackId).toBe('k2');
    expect(moved.follow!.scaleWith).toBe(true);
    const now = trackedPoseAt(moved, scene(m), 5000)!;
    expect(now.cx).toBeCloseTo(drawn.cx, 5);
    expect(now.cy).toBeCloseTo(drawn.cy, 5);
    expect(now.scale).toBeCloseTo(drawn.scale, 5);
    expect(followPatch(layer, other, scene(m), 5000, { scaleWith: false })!.follow!.scaleWith).toBeUndefined();
    expect(followPatch(layer, other, scene(m), 5000, { turnWith: true })!.follow!.turnWith).toBe(true);
  });

  it('pins nothing to a track whose footage has left the post, and never an effect', () => {
    const gone = trackFromRun(run({ clipId: 'gone', clipKey: 'gone' }), 'k2', 'Track 2', 1);
    expect(followPatch(text(null), gone, scene(on(walk(), gone)), 2000)).toBeNull();
    const effect = { ...text(null), kind: 'effect', effectId: 'grain' } as unknown as EditOverlay;
    expect(followPatch(effect, walk(), scene(post()), 2000)).toBeNull();
  });
});

describe('a mended track', () => {
  it('moves nothing from further before the run than the smoothing reaches, at any smoothing', () => {
    for (const smooth of [0.3, 1]) {
      const old = filmed({ smooth });
      const run = rerun(old, 180, 300, 180);
      const mended = mendTrack(old, run);
      const layer = text(follow({ pin: { atMs: 0, dx: 0.05, dy: -0.1 }, scaleWith: true, turnWith: true }), { cx: 0.35, cy: 0.4 });
      // Three sigmas, and the frame after an instant read between two.
      const reach = 3 * smooth * MAX_SMOOTH_MS + 40;
      const from = run.atMs[0]!;
      alike(layer, on(old), layer, on(mended), [0, 2000, from - reach - 400, from - reach], `smooth ${smooth}`);
      // From the handover on, the path is the run's: the thing 0.08 right of where the old one had it.
      const was = trackedThingAt(old, scene(on(old)), 8000)!;
      const now = trackedThingAt(mended, scene(on(mended)), 8000)!;
      expect(now.cx - was.cx).toBeCloseTo(0.08, 3);
    }
  });

  it('hands over to the run and back to the old path without a jump', () => {
    const old = filmed({ smooth: 0 });
    const run = rerun(old, 120, 210, 165);
    const mended = mendTrack(old, run);
    const was = (t: number) => trackedThingAt(old, scene(on(old)), t)!.cx;
    const now = (t: number) => trackedThingAt(mended, scene(on(mended)), t)!.cx;
    const xs = old.atMs.slice(100, 231).map(now);
    const steps = xs.slice(1).map((x, i) => Math.abs(x - xs[i]!));
    // The thing walks 0.0013 of the frame a frame; the run puts it 0.08 over, which a handover with no
    // blend would do in one frame.
    expect(Math.max(...steps)).toBeLessThan(0.02);
    expect(now(run.atMs[0]!)).toBeCloseTo(was(run.atMs[0]!), 4);
    expect(now(run.atMs.at(-1)!)).toBeCloseTo(was(run.atMs.at(-1)!), 4);
    expect(now(old.atMs[165]!) - was(old.atMs[165]!)).toBeCloseTo(0.08, 4);
  });

  it('puts a layer pinned before it back on the thing from the handover on', () => {
    const truth = filmed({ smooth: 0 });
    // The old path slipped at 4 s: from there on 0.05 to the left of the thing. The fix runs from 5 s.
    const slipped = { ...truth, x: truth.x.map((x, i) => (truth.atMs[i]! > 4000 ? x - 0.05 : x)) };
    const from = truth.atMs.findIndex(t => t >= 5000);
    const mended = mendTrack(slipped, rerun(slipped, from, 300, from + 30, 0));
    const layer = text();
    expect(trackedPoseAt(layer, scene(on(mended)), 2000)).toEqual(trackedPoseAt(layer, scene(on(slipped)), 2000));
    const there = trackedPoseAt(layer, scene(on(mended)), 8000)!;
    expect(there.cx).toBeCloseTo(0.3 + 0.4 * 0.8, 4);
    expect(there.cy).toBeCloseTo(0.5 + 0.05 * Math.sin(8000 / 700) - 0.1, 4);
  });

  it('moves nothing before a second run from earlier either', () => {
    const old = filmed({ smooth: 0.6 });
    const once = mendTrack(old, rerun(old, 180, 300, 180));
    const twice = mendTrack(once, rerun(once, 120, 300, 120));
    const layer = text(follow({ pin: { atMs: 0, dx: 0.05, dy: -0.1 }, scaleWith: true, turnWith: true }), { cx: 0.35, cy: 0.4 });
    const reach = 3 * 0.6 * MAX_SMOOTH_MS + 40;
    const from = old.atMs[120]!;
    alike(layer, on(old), layer, on(twice), [1000, from - reach - 300, from - reach], 'mended before the first');
  });
});

describe('a path mended before version 21', () => {
  /** `track` as a version-20 mend left it from frame `index` on: a later run's samples there, 0.08 right, and a seam keeping what the earlier path went on to do. */
  function seamed(track: EditTrack, index: number): EditTrack {
    const kept = cutTrackAt(track, track.atMs[index]!);
    return {
      ...track,
      atMs: [...kept.atMs, ...track.atMs.slice(index)],
      x: [...kept.x, ...track.x.slice(index).map(x => x + 0.08)],
      y: [...kept.y, ...track.y.slice(index)],
      scale: [...kept.scale, ...track.scale.slice(index)],
      turn: [...kept.turn, ...track.turn.slice(index)],
      seams: kept.seams,
    };
  }

  it('moves nothing before its seam, however close to it, at any smoothing', () => {
    for (const smooth of [0.3, 1]) {
      const old = filmed({ smooth });
      const after = seamed(old, 180);
      const layer = text(follow({ pin: { atMs: 0, dx: 0.05, dy: -0.1 }, scaleWith: true, turnWith: true }), { cx: 0.35, cy: 0.4 });
      const seam = old.atMs[180]!;
      alike(layer, on(old), layer, on(after), [0, 2000, seam - 900, seam - 400, seam - 100, seam - 20, seam - 1], `smooth ${smooth}`);
      const was = trackedThingAt(old, scene(on(old)), 8000)!;
      const now = trackedThingAt(after, scene(on(after)), 8000)!;
      expect(now.cx - was.cx).toBeCloseTo(0.08, 3);
    }
  });

  it('is read back from a draft as it was written, and a seam out of place is left out', () => {
    const after = seamed(filmed(), 180);
    const seams = after.seams!;
    expect(seams.length).toBe(1);
    expect(seams[0]!.atMs).toBe(after.atMs[180]);
    // What the earlier path went on to do, from the seam as far as the widest smoothing reaches.
    expect(seams[0]!.then.atMs[0]).toBe(after.atMs[180]);
    expect(seams[0]!.then.atMs.at(-1)!).toBeLessThanOrEqual(seams[0]!.atMs + SEAM_REACH_MS);
    expect(seams[0]!.then.atMs.at(-1)!).toBeGreaterThan(seams[0]!.atMs + SEAM_REACH_MS - 40);
    expect(normaliseEditTrack(after)).toBe(after);
    expect(normaliseManifest(JSON.parse(JSON.stringify(on(after)))).tracks).toEqual([after]);
    const odd = normaliseEditTrack({ ...after, seams: [{ atMs: -5, then: seams[0]!.then }, seams[0], { atMs: 4000, then: 'x' }] })!;
    expect(odd.seams).toEqual([seams[0]]);
    const unshaped = normaliseEditTrack({ ...after, seams: [{ atMs: seams[0]!.atMs, then: { atMs: [1], x: [] } }] })!;
    expect(unshaped.seams).toEqual([{ atMs: seams[0]!.atMs, then: { atMs: [], x: [], y: [], scale: [], turn: [] } }]);
  });
});

describe('a layer pinned inside a mended stretch', () => {
  /** Track "k" mended over 3 s to 6 s, the box put on the frame at 4.5 s, the thing found 0.08 right of where it was. */
  function mendedMiddle(smooth: number): { old: EditTrack; run: TrackRunResult; mended: EditTrack } {
    const old = filmed({ smooth });
    const from = old.atMs.findIndex(t => t >= 3000);
    const to = old.atMs.findIndex(t => t >= 6000);
    const run = rerun(old, from, to, Math.round((from + to) / 2));
    return { old, run, mended: mendTrack(old, run) };
  }

  /** Following the thing a little right of it and a tenth above, growing and turning with it, pinned at 4.5 s. */
  const pinned = (): EditOverlay => text(follow({ pin: { atMs: 4500, dx: 0.05, dy: -0.1 }, scaleWith: true, turnWith: true }), { cx: 0.5, cy: 0.4, rotationDeg: 10 });

  /** `layer` moved onto `after` at SOURCE `atMs` the way a fix moves it: its follow, and the turn it had come through. */
  function refollowed(layer: EditOverlay, before: EditTrack, after: EditTrack, atMs: number): EditOverlay {
    const moved = refollowAt(before, after, layer.follow!, atMs);
    return { ...layer, follow: moved.follow, rotationDeg: layer.rotationDeg + moved.turn } as EditOverlay;
  }

  it('is drawn where it was everywhere outside the stretch, moved onto the mended path at its edge', () => {
    const { old, run, mended } = mendedMiddle(0);
    const from = run.atMs[0]!;
    const to = run.atMs.at(-1)!;
    const after = refollowed(pinned(), old, mended, from);
    expect(after.follow!.trackId).toBe('k');
    expect(after.follow!.pin.atMs).toBe(from);
    alike(pinned(), on(old), after, on(mended), [0, 1500, from, to + 100, 8000, 10_000], 'outside');
    // Inside, it rides the mended path: 0.08 right of where the slipping one drew it.
    const was = trackedPoseAt(pinned(), scene(on(old)), 4500)!;
    const now = trackedPoseAt(after, scene(on(mended)), 4500)!;
    expect(now.cx - was.cx).toBeCloseTo(0.08, 4);
    expect(now.cy).toBeCloseTo(was.cy, 4);
    expect(now.scale).toBeCloseTo(was.scale, 4);
    expect(now.rotationDeg).toBeCloseTo(was.rotationDeg, 2);
  });

  it('is drawn where it was outside a smoothed stretch when moved over where the two drawn paths still agree', () => {
    // Smoothing reaches three sigmas into the handover, so drawn, the two paths part that far out.
    const { old, run, mended } = mendedMiddle(0.3);
    const reach = 3 * 0.3 * MAX_SMOOTH_MS + 40;
    const from = run.atMs[0]!;
    const to = run.atMs.at(-1)!;
    const after = refollowed(pinned(), old, mended, from - reach);
    alike(pinned(), on(old), after, on(mended), [0, 1500, from - reach, to + reach, 8000, 10_000], 'outside');
  });
});

describe('where a track is on the post', () => {
  /** The thing seen only from `fromMs` to `toMs` of its footage. */
  function seen(fromMs: number, toMs: number, overrides: Partial<EditTrack> = {}): EditTrack {
    return walk({ atMs: [fromMs, toMs], x: [0.4, 0.6], y: [0.5, 0.5], scale: [1, 1], turn: [0, 0], ...overrides });
  }

  it('is a stretch of the post over the part of the track its segment plays, through the trim and the speed', () => {
    const trimmed = post([{ ...defaultClipEdit('a', 10_000), inMs: 2000, outMs: 8000 }]);
    const [stretch] = trackStretches(walk(), trimmed);
    expect(trackStretches(walk(), trimmed)).toEqual([{ startMs: 0, endMs: 6000, fromMs: 2000, toMs: 8000 }]);
    expect(outputMsOf(stretch!, 5000)).toBe(3000);
    expect(trackStretches(seen(3000, 7000), post())).toEqual([{ startMs: 3000, endMs: 7000, fromMs: 3000, toMs: 7000 }]);
    const fast = trackStretches(walk(), post([{ ...defaultClipEdit('a', 10_000), speed: 2 }]));
    expect(fast).toEqual([{ startMs: 0, endMs: 5000, fromMs: 0, toMs: 10_000 }]);
    expect(outputMsOf(fast[0]!, 4000)).toBe(2000);
  });

  it('is a stretch on each segment of a cut clip, in time order', () => {
    const left = { ...defaultClipEdit('a', 10_000), outMs: 5000 };
    const right = { ...defaultClipEdit('a', 10_000, 'a2'), inMs: 5000 };
    const stretches = trackStretches(seen(2000, 8000), post([left, defaultClipEdit('z', 3000), right]));
    expect(stretches).toEqual([
      { startMs: 2000, endMs: 5000, fromMs: 2000, toMs: 5000 },
      { startMs: 8000, endMs: 11_000, fromMs: 5000, toMs: 8000 },
    ]);
    expect(outputMsOf(stretches[1]!, 6500)).toBe(9500);
  });

  it('is the whole of every segment showing a picture, for a track of the picture', () => {
    const picture = defaultPictureEdit('p');
    const m = post([defaultClipEdit('a', 2000), picture]);
    const still = walk({ clipId: 'p', clipKey: 'p', atMs: [picture.inMs + 500], x: [0.5], y: [0.5], scale: [1], turn: [0] });
    const stretches = trackStretches(still, m);
    expect(stretches).toEqual([{ startMs: 2000, endMs: 5000, fromMs: picture.inMs, toMs: picture.outMs }]);
    expect(outputMsOf(stretches[0]!, picture.inMs + 1500)).toBe(3500);
  });

  it('is offset by where its lane starts, on a video over the main one', () => {
    const m = post();
    m.videoTracks = [{ id: 'v1', clips: [defaultClipEdit('b', 4000)], startMs: 1500, z: 1, opacity: 1 }];
    expect(trackStretches(seen(0, 4000, { clipId: 'b', clipKey: 'b' }), m)).toEqual([{ startMs: 1500, endMs: 5500, fromMs: 0, toMs: 4000 }]);
  });

  it('is nowhere once its footage has left the post, or its segment has been trimmed off the part it covers', () => {
    expect(trackStretches(walk(), post([defaultClipEdit('z', 3000)]))).toEqual([]);
    expect(trackStretches(seen(3000, 5000), post([{ ...defaultClipEdit('a', 10_000), outMs: 2000 }]))).toEqual([]);
  });
});

describe('a layer the thing has grown past the sizes a customer can pick', () => {
  /** A frame every 33 ms for 10 s: the thing walking right and growing to twice its size. */
  function growth(grows = (t: number) => 1 + t / 10_000): EditTrack {
    const atMs = Array.from({ length: 301 }, (_, i) => Math.round(i * 33.3));
    return walk({
      atMs,
      x: atMs.map(t => 0.3 + (0.4 * t) / 10_000),
      y: atMs.map(() => 0.5),
      scale: atMs.map(grows),
      turn: atMs.map(() => 0),
      smooth: 0.3,
    });
  }

  /** A text following it at 4x, growing with it. */
  function growing(): EditOverlay {
    return text(follow({ scaleWith: true }), { cx: 0.3, cy: 0.4, scale: 4 });
  }

  /** `layer` on post `m` with `patch` on it, through the manifest and back out of a draft, as the store and a reload leave it. */
  function patched(m: EditManifest, layer: EditOverlay, patch: Partial<EditOverlay>): EditOverlay {
    return normaliseManifest(JSON.parse(JSON.stringify(patchOverlay({ ...m, overlays: [layer] }, 't', patch)))).overlays[0]!;
  }

  /** `a` on post `ma` and `b` on post `mb` drawn the same size at every one of `times`. */
  function sameSize(a: EditOverlay, ma: EditManifest, b: EditOverlay, mb: EditManifest, times: number[], label: string): void {
    for (const t of times) expect(trackedPoseAt(b, scene(mb), t)!.scale, `size at ${t}, ${label}`).toBeCloseTo(trackedPoseAt(a, scene(ma), t)!.scale, 4);
  }

  /** A run from frame 270 of `track` on, finding the thing a little right and growing no more since the anchor. */
  function lateRun(track: EditTrack): TrackRunResult {
    const later = track.atMs.slice(270);
    return {
      clipId: 'a',
      clipKey: 'a',
      aspect: ASPECT,
      box: { w: 0.2, h: 0.1 },
      atMs: later,
      x: later.map(t => 0.3 + (0.4 * t) / 10_000 + 0.03),
      y: later.map(() => 0.5),
      scale: later.map(() => 1),
      turn: later.map(() => 0),
      sure: later.map(() => 100),
      lost: [],
      anchorMs: later[0]! + 10,
    };
  }

  it('keeps its size everywhere when it is moved where it is drawn past them', () => {
    const m = on(growth());
    const layer = growing();
    const shown = trackedPoseAt(layer, scene(m), 10_000)!;
    expect(shown.scale).toBeGreaterThan(MAX_SCALE);
    const moved = patched(m, layer, repinOverlay(layer, scene(m), 10_000, { cx: shown.cx + 0.05, cy: shown.cy })!);
    sameSize(layer, m, moved, m, [0, 3000, 7000, 10_000], 'moved');
    expect(trackedPoseAt(moved, scene(m), 10_000)!.cx).toBeCloseTo(shown.cx + 0.05, 4);
    expect(moved.scale).toBeLessThanOrEqual(MAX_SCALE);
  });

  it('keeps its size everywhere when the track is mended where it is drawn past them', () => {
    const old = growth();
    const run = lateRun(old);
    const mended = mendTrack(old, run);
    const layer = growing();
    sameSize(layer, on(old), layer, on(mended), [0, 4000, 8600], 'mended');
    // From the handover on, the size the run found: the thing's where the old path had it at the anchor,
    // and no growing since.
    const there = trackedPoseAt(layer, scene(on(mended)), 9500)!.scale;
    expect(there).toBeGreaterThan(MAX_SCALE);
    expect(there).toBeCloseTo(4 * pathAt(trackPath(old), run.anchorMs).scale, 3);
  });

  it('keeps its size everywhere when the track is mended round where it is pinned', () => {
    const old = growth();
    const m = on(old);
    // Pinned at 9.5 s, where it is drawn at more than seven times its size.
    const layer = patched(m, growing(), repinOverlay(growing(), scene(m), 9500)!);
    expect(layer.scale).toBe(MAX_SCALE);
    expect(layer.follow!.pin.grow).toBeGreaterThan(1);
    const run = lateRun(old);
    const mended = mendTrack(old, run);
    const moved = refollowAt(old, mended, layer.follow!, run.atMs[0]! - (3 * 0.3 * MAX_SMOOTH_MS + 40));
    const after = patched(on(mended), layer, { follow: moved.follow, rotationDeg: layer.rotationDeg + moved.turn });
    sameSize(layer, m, after, on(mended), [0, 4000, 8600], 'mended round its pin');
    expect(after.scale).toBeLessThanOrEqual(MAX_SCALE);
  });

  it('keeps its size on the frame a whole new run starts from', () => {
    const layer = growing();
    const atMs = Array.from({ length: 31 }, (_, i) => 9000 + Math.round(i * 33.3));
    const fresh = trackFromRun(
      {
        clipId: 'a',
        clipKey: 'a',
        aspect: ASPECT,
        box: { w: 0.2, h: 0.1 },
        atMs,
        x: atMs.map(() => 0.6),
        y: atMs.map(() => 0.5),
        scale: atMs.map(() => 1),
        turn: atMs.map(() => 0),
        sure: atMs.map(() => 100),
        lost: [],
        anchorMs: 9500,
      },
      'k2',
      'Track 2',
      1,
    );
    const m = on(growth(), fresh);
    const after = patched(m, layer, followPatch(layer, fresh, scene(m), 9500)!);
    expect(after.follow!.trackId).toBe('k2');
    sameSize(layer, m, after, m, [9500], 'tracked again');
    expect(after.scale).toBeLessThanOrEqual(MAX_SCALE);
  });

  it('keeps its size where Size is turned off there, and from then on everywhere', () => {
    const m = on(growth());
    const layer = growing();
    const pinned = repinOverlay(layer, scene(m), 10_000)!;
    const off = patched(m, layer, { ...pinned, follow: { ...pinned.follow!, scaleWith: undefined } });
    const drawn = trackedPoseAt(layer, scene(m), 10_000)!.scale;
    for (const t of [0, 5000, 10_000]) expect(trackedPoseAt(off, scene(m), t)!.scale, `size at ${t}`).toBeCloseTo(drawn, 4);
  });

  it('keeps a layer the thing has shrunk below them the same way', () => {
    // A tenth of its size by the end, the layer following it at 1x: drawn at a tenth there.
    const m = on(growth(t => 1 - (0.9 * t) / 10_000));
    const layer = { ...growing(), scale: 1 } as EditOverlay;
    const shown = trackedPoseAt(layer, scene(m), 10_000)!;
    expect(shown.scale).toBeLessThan(MIN_SCALE);
    const moved = patched(m, layer, repinOverlay(layer, scene(m), 10_000, { cx: shown.cx - 0.05, cy: shown.cy })!);
    sameSize(layer, m, moved, m, [0, 5000, 10_000], 'moved');
  });

  it('stands at the biggest size a customer can pick once taken off its track where it is drawn past it', () => {
    const m = on(growth());
    const layer = growing();
    const shown = trackedPoseAt(layer, scene(m), 10_000)!;
    const off = unfollowOverlay(layer, scene(m), 10_000);
    expect(off.scale).toBe(MAX_SCALE);
    expect(off.cx).toBeCloseTo(shown.cx, 6);
    expect(off.cy).toBeCloseTo(shown.cy, 6);
  });
});

describe('a following layer on the wire', () => {
  const context = {
    output: emptyManifest().output,
    textStyle: () => ({}),
    stickerUrl: () => '',
    fileUrl: (u: string) => u,
    drawn: () => ({ png: 'data:image/png;base64,x', wPx: 100, hPx: 40 }),
  } as unknown as RasterContext;

  it('is sent the same motion the preview reads, its animation and its track as one', async () => {
    const m = post();
    m.overlays = [text(follow(), { animation: { in: { id: 'fade', durationMs: 400 } } })];
    const spec = await toComposeSpec(m, new Map([['a', 'file:///a.mp4']]), { jobId: 'j', batchId: 'b' }, context);
    const sent = spec.overlays[0]!;
    const expected = compileLayerMotion(m.overlays[0]!, scene(m), { startMs: 0, endMs: 10_000 });
    expect(sent.motion).toEqual(expected);
    // Faded in at the start, then walking with the thing.
    expect(overlayMotionAt(sent.motion, 0)!.opacity).toBeCloseTo(0, 3);
    expect(drawnAt(m.overlays[0]!, sent.motion!, 5000).x).toBeCloseTo(0.5, 4);
  });

  it('keeps an animation step a step', () => {
    const track: ComposeOverlayMotion = { atMs: [0, 1000], x: [0, 0.1], y: [0, 0] };
    const animation: ComposeOverlayMotion = { atMs: [0, 500, 500, 1000], opacity: [1, 1, 0, 0] };
    const both = combineMotions(track, animation)!;
    expect(overlayMotionAt(both, 499.9)!.opacity).toBeCloseTo(1, 3);
    expect(overlayMotionAt(both, 500)!.opacity).toBe(0);
    expect(overlayMotionAt(both, 750)!.x).toBeCloseTo(0.075, 6);
    expect(combineMotions(track, null)).toBe(track);
    expect(combineMotions(null, animation)).toBe(animation);
  });

  it('keeps the keys where the track starts and stops moving, with an animation keyed close to them', () => {
    // Two seconds. The thing stands until 0.8 s, dashes across a third of the frame by 1.2 s, and stands
    // again: a track that holds, moves and holds. Half-second fades in and out put keys at 0.5 s and 1.5 s,
    // each nearer than any of the track's own keys to the one where a hold ends or begins.
    const atMs = Array.from({ length: 13 }, (_, i) => 800 + Math.round(i * 33.3));
    const dash = walk({
      atMs,
      x: atMs.map(t => 0.3 + (0.4 * (t - 800)) / 400),
      y: atMs.map(() => 0.5),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const m = post([defaultClipEdit('a', 2000)], [dash]);
    const layer = text(follow({ pin: { atMs: 800, dx: 0, dy: -0.1 } }), { endMs: 2000, animation: { in: { id: 'fade', durationMs: 500 }, out: { id: 'fade', durationMs: 500 } } });
    m.overlays = [layer];
    const window = { startMs: 0, endMs: 2000 };
    const track = compileTrackMotion(layer, scene(m), window)!;
    const animation = compileOverlayMotion(window, layer.animation, 'text')!;
    const both = compileLayerMotion(layer, scene(m), window)!;
    const none = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    // Every 5 ms, the two drawn together where each puts it: to a quarter of a pixel.
    for (let t = 0; t <= 2000; t += 5) {
      const a = overlayMotionAt(track, t) ?? none;
      const b = overlayMotionAt(animation, t) ?? none;
      const c = overlayMotionAt(both, t) ?? none;
      expect(Math.abs(c.x - (a.x + b.x)) * 720, `x at ${t}`).toBeLessThan(0.25);
      expect(Math.abs(c.y - (a.y + b.y)) * 1280, `y at ${t}`).toBeLessThan(0.25);
      expect(c.opacity, `opacity at ${t}`).toBeCloseTo(b.opacity, 4);
    }
  });

  it('fits a long tracked layer with a busy loop under the keys the wire takes', () => {
    // Seventy seconds of a thing tracked at 30 fps, and a layer that pops in and pulses throughout: each
    // keyed on its own fits, the two together do not.
    const atMs = Array.from({ length: 2101 }, (_, i) => Math.round(i * 33.3));
    const long = walk({
      atMs,
      x: atMs.map(t => 0.2 + (0.6 * t) / 70_000),
      y: atMs.map(t => 0.5 + 0.02 * Math.sin(t / 300)),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const m = post([defaultClipEdit('a', 70_000)], [long]);
    const layer = text(follow(), { endMs: 70_000, animation: { in: { id: 'pop', durationMs: 470 }, loop: { id: 'pulse', periodMs: 600 } } });
    m.overlays = [layer];
    const window = { startMs: 0, endMs: 70_000 };
    const track = compileTrackMotion(layer, scene(m), window)!;
    const animation = compileOverlayMotion(window, layer.animation, 'text')!;
    expect(track.atMs.length + animation.atMs.length).toBeGreaterThan(MAX_OVERLAY_MOTION_KEYS);
    const motion = compileLayerMotion(layer, scene(m), window)!;
    expect(motion.atMs.length).toBeLessThanOrEqual(MAX_OVERLAY_MOTION_KEYS);
    // And it still draws the layer where the thing and the pulse together put it.
    for (const t of [250, 10_000, 35_123, 69_000]) {
      const a = overlayMotionAt(track, t)!;
      const b = overlayMotionAt(animation, t)!;
      const both = overlayMotionAt(motion, t)!;
      expect(both.x, `x at ${t}`).toBeCloseTo(a.x + b.x, 3);
      expect(both.y, `y at ${t}`).toBeCloseTo(a.y + b.y, 3);
      expect(both.scale, `size at ${t}`).toBeCloseTo(a.scale * b.scale, 3);
    }
    // What every engine's reader refuses past the cap, it takes.
    expect(normaliseOverlayMotion(motion)).toEqual(motion);
  });

  it('fits a layer whose loop alone is keyed to the cap, with no key sent twice', () => {
    // A hundred seconds tracked and a pulse five times a second: the pulse alone takes every key the wire
    // has, so the track can only be read where the pulse is keyed - and the layer's last key, which both
    // have, must go once.
    const end = 99_967;
    const atMs = Array.from({ length: Math.floor(end / 33.3) + 1 }, (_, i) => Math.round(i * 33.3));
    const long = walk({
      atMs,
      x: atMs.map(t => 0.2 + (0.6 * t) / end),
      y: atMs.map(t => 0.5 + 0.02 * Math.sin(t / 300)),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const m = post([defaultClipEdit('a', end)], [long]);
    const layer = text(follow(), { endMs: end, animation: { loop: { id: 'pulse', periodMs: 200 } } });
    m.overlays = [layer];
    const window = { startMs: 0, endMs: end };
    const animation = compileOverlayMotion(window, layer.animation, 'text')!;
    expect(animation.atMs.length).toBe(MAX_OVERLAY_MOTION_KEYS);
    const motion = compileLayerMotion(layer, scene(m), window)!;
    expect(motion.atMs.length).toBeLessThanOrEqual(MAX_OVERLAY_MOTION_KEYS);
    expect(normaliseOverlayMotion(motion)).toEqual(motion);
    const channels = (['x', 'y', 'scale', 'rotation', 'opacity'] as const).filter(c => motion[c]);
    for (let i = 1; i < motion.atMs.length; i++) {
      const again = motion.atMs[i] === motion.atMs[i - 1] && channels.every(c => motion[c]![i] === motion[c]![i - 1]);
      expect(again, `key ${i} at ${motion.atMs[i]} repeats the one before it`).toBe(false);
    }
    // Where the pulse is keyed, the layer is where the thing and the pulse together put it.
    const track = compileTrackMotion(layer, scene(m), window)!;
    const none = { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 };
    for (const i of [0, 1, 7, 2999, 5998, 5999]) {
      const t = animation.atMs[i]!;
      const a = overlayMotionAt(track, t) ?? none;
      const b = overlayMotionAt(animation, t) ?? none;
      const both = overlayMotionAt(motion, t) ?? none;
      expect(both.x, `x at ${t}`).toBeCloseTo(a.x + b.x, 4);
      expect(both.y, `y at ${t}`).toBeCloseTo(a.y + b.y, 4);
      expect(both.scale, `size at ${t}`).toBeCloseTo(a.scale * b.scale, 3);
    }
  });

  it('fits every loop at its fastest on a long tracked layer, flickering in and out as well', () => {
    const end = 99_967;
    const atMs = Array.from({ length: Math.floor(150_000 / 33.3) + 1 }, (_, i) => Math.round(i * 33.3));
    const long = walk({
      atMs,
      x: atMs.map(t => 0.2 + (0.6 * t) / 150_000),
      y: atMs.map(t => 0.5 + 0.02 * Math.sin(t / 300)),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const m = post([defaultClipEdit('a', 150_000)], [long]);
    const loops = ['pulse', 'beat', 'heartbeat', 'float', 'sway', 'wiggle', 'shake', 'spin', 'breathe'];
    const cases = [
      ...loops.map(id => ({ endMs: end, fps: 30, animation: { loop: { id, periodMs: 200 } } })),
      { endMs: 150_000, fps: 60, animation: { in: { id: 'flicker', durationMs: 100 }, loop: { id: 'shake', periodMs: 200 }, out: { id: 'flicker', durationMs: 100 } } },
    ];
    for (const { endMs, fps, animation } of cases) {
      const layer = text(follow(), { endMs, animation });
      m.overlays = [layer];
      m.output = { ...m.output, fps };
      const motion = compileLayerMotion(layer, scene(m), { startMs: 0, endMs })!;
      const name = `${animation.loop.id} over ${endMs} ms at ${fps} fps`;
      expect(motion.atMs.length, name).toBeLessThanOrEqual(MAX_OVERLAY_MOTION_KEYS);
      expect(normaliseOverlayMotion(motion), name).toEqual(motion);
    }
  });

  it('leaves a layer with no track exactly as it was sent before', () => {
    const m = post();
    const layer = text(null, { animation: { loop: { id: 'pulse', periodMs: 1000 } } });
    expect(compileLayerMotion(layer, scene(m), { startMs: 0, endMs: 10_000 })).toEqual(compileOverlayMotion({ startMs: 0, endMs: 10_000 }, layer.animation, 'text'));
  });

  it('sends a layer whose track is gone as its animation alone', () => {
    const m = on(walk({ id: 'j' }));
    const layer = text(follow(), { animation: { loop: { id: 'pulse', periodMs: 1000 } } });
    expect(compileLayerMotion(layer, scene(m), { startMs: 0, endMs: 10_000 })).toEqual(compileOverlayMotion({ startMs: 0, endMs: 10_000 }, layer.animation, 'text'));
  });
});

describe('the edit ops keep a follow', () => {
  it('on both halves of a cut layer, and on a copy, nudged with it, all on the one track', () => {
    const m = post();
    m.overlays = [text()];
    const cut = splitOverlayAt(m, 't', 4000, 't2', 10_000)!;
    expect(cut.overlays.map(o => o.follow)).toEqual([follow(), follow()]);
    expect(cut.tracks).toBe(m.tracks);
    const copied = duplicateOverlay(m, 't', 'c')!;
    expect(copied.overlays[1]!.follow!.trackId).toBe('k');
    expect(copied.overlays[1]!.follow!.pin.dy).toBeCloseTo(-0.05, 6);
    expect(followersOf(copied.overlays, 'k').map(o => o.id)).toEqual(['t', 'c']);
  });

  it('as no change when a patch does not touch it, and off when one takes it away', () => {
    const m = post();
    m.overlays = [text()];
    expect(patchOverlay(m, 't', { follow: m.overlays[0]!.follow })).toBe(m);
    expect(patchOverlay(m, 't', { follow: undefined }).overlays[0]!.follow).toBeUndefined();
    expect('follow' in patchOverlay(m, 't', { follow: undefined }).overlays[0]!).toBe(false);
  });
});
