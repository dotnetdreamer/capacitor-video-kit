import { describe, expect, it } from 'vitest';

import { MAX_OVERLAY_MOTION_KEYS, type ComposeCamera, type ComposeOverlayMotion } from '../video-composer/definitions';
import { toComposeSpec } from './compose';
import {
  defaultClipEdit,
  emptyManifest,
  MAX_SCALE,
  MIN_SCALE,
  normaliseManifest,
  type EditClip,
  type EditManifest,
  type EditOverlay,
  type OverlayTrack,
  type TextOverlay,
} from './edit-manifest';
import { duplicateOverlay, patchOverlay, splitOverlayAt } from './edit-ops';
import { compileLayoutMotions } from './layout-motion';
import { compileOverlayMotion, normaliseOverlayMotion, overlayMotionAt } from './motion';
import { normaliseOverlayTrack, pathAt, SEAM_REACH_MS, trackPath } from './overlay-track';
import type { RasterContext } from './raster-context';
import {
  combineMotions,
  compileLayerMotion,
  compileTrackMotion,
  repinOverlay,
  trackedFootage,
  trackedPoseAt,
  trackedThingAt,
  untrackOverlay,
  withTrackRun,
  type TrackRunResult,
  type TrackScene,
} from './track-motion';

/*
 * A 720x1280 post over one 10 s clip of the same shape, so a source fraction is an output fraction until
 * something - a trim, a zoom, a layout - says otherwise. The thing walks from the left to the right at
 * mid height, one sample a second, and the text sits a tenth of the frame above it.
 */

const ASPECT = 720 / 1280;

function post(clips: EditClip[] = [defaultClipEdit('a', 10_000)]): EditManifest {
  const m = emptyManifest();
  m.output = { width: 720, height: 1280, fps: 30 };
  m.clips = clips;
  return m;
}

function walk(overrides: Partial<OverlayTrack> = {}): OverlayTrack {
  const atMs = Array.from({ length: 11 }, (_, i) => i * 1000);
  return {
    clipId: 'a',
    clipKey: 'a',
    aspect: ASPECT,
    box: { w: 0.2, h: 0.1 },
    atMs,
    x: atMs.map(t => 0.2 + (0.6 * t) / 10_000),
    y: atMs.map(() => 0.5),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    pin: { atMs: 0, dx: 0, dy: -0.1 },
    smooth: 0,
    ...overrides,
  };
}

function text(track: OverlayTrack | null = walk(), overrides: Partial<TextOverlay> = {}): TextOverlay {
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
    ...(track ? { track } : {}),
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

describe('normaliseOverlayTrack', () => {
  it('hands a track already in shape back as the very object', () => {
    const track = walk();
    expect(normaliseOverlayTrack(track)).toBe(track);
  });

  it('leaves out samples that go back in time or are not numbers, and holds the rest to their ranges', () => {
    const track = normaliseOverlayTrack({ ...walk(), atMs: [0, 500, 400, 900], x: [0.1, 0.2, 0.3, Number.NaN], y: [0.5, 9, 0.5, 0.5], scale: [1, 1, 1, 1], turn: [0, 0, 0, 0] })!;
    expect(track.atMs).toEqual([0, 500]);
    expect(track.y).toEqual([0.5, 3]);
  });

  it('refuses what is not a track', () => {
    expect(normaliseOverlayTrack(undefined)).toBeUndefined();
    expect(normaliseOverlayTrack({ ...walk(), clipId: '' })).toBeUndefined();
    expect(normaliseOverlayTrack({ ...walk(), x: [0.5] })).toBeUndefined();
    expect(normaliseOverlayTrack({ ...walk(), pin: { atMs: 0, dx: 'up', dy: 0 } })).toBeUndefined();
  });

  it('is read from a draft on a text, a sticker and a photo, and never on an effect', () => {
    const m = post();
    m.overlays = [text(), { ...text(), id: 'e', kind: 'effect', effectId: 'grain' } as unknown as EditOverlay];
    const read = normaliseManifest(JSON.parse(JSON.stringify(m)));
    expect(read.overlays[0]!.track).toEqual(walk());
    expect(read.overlays[1]!.track).toBeUndefined();
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

describe('a tracked layer on the post', () => {
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
    const m = post();
    const clip: EditClip = { ...defaultClipEdit('b', 10_000), rect: { x: 0.5, y: 0, w: 0.5, h: 1 }, fit: 'contain' };
    m.videoTracks = [{ id: 't1', clips: [clip], startMs: 0, z: 1, opacity: 1 }];
    const track = walk({ clipId: 'b', clipKey: 'b', x: walk().x.map(() => 0.5), pin: { atMs: 0, dx: 0, dy: 0 } });
    // The picture fills the right half's width and is centred down it: 360x640 at (360, 320).
    const pose = trackedPoseAt(text(track), scene(m), 3000)!;
    expect(pose.cx).toBeCloseTo(0.75, 6);
    expect(pose.cy).toBeCloseTo(0.5, 6);
  });

  it('grows and turns with the thing only when asked to', () => {
    const m = post();
    const growing = walk({ scale: walk().atMs.map(t => 1 + t / 10_000), x: walk().x.map(() => 0.5) });
    expect(trackedPoseAt(text(growing, { cx: 0.5 }), scene(m), 10_000)!.cy).toBeCloseTo(0.4, 6);
    const grown = trackedPoseAt(text({ ...growing, scaleWith: true }, { cx: 0.5 }), scene(m), 10_000)!;
    expect(grown.cy).toBeCloseTo(0.3, 6);
    expect(grown.scale).toBeCloseTo(2, 6);

    const turning = walk({ turn: walk().atMs.map(t => (90 * t) / 10_000), x: walk().x.map(() => 0.5), turnWith: true });
    const turned = trackedPoseAt(text(turning, { cx: 0.5 }), scene(m), 10_000)!;
    // A tenth of the HEIGHT above, turned a quarter clockwise, is a tenth of the height to the right.
    expect(turned.cx).toBeCloseTo(0.5 + 0.1 / ASPECT, 6);
    expect(turned.cy).toBeCloseTo(0.5, 6);
    expect(turned.rotationDeg).toBeCloseTo(90, 6);
  });

  it('follows the outgoing clip on under a dissolve, past the end of its own slot', () => {
    // A one-second dissolve into a second clip: the first clip's slot ends at 9 s, its picture at 10.
    const m = post([defaultClipEdit('a', 10_000), { ...defaultClipEdit('b', 10_000), transitionIn: { kind: 'dissolve', durationMs: 1000 } }]);
    const layer = text(walk(), { endMs: 12_000 });
    expect(trackedFootage(layer.track!, scene(m), 9500)!.sourceMs).toBe(9500);
    expect(trackedPoseAt(layer, scene(m), 9500)!.cx).toBeCloseTo(0.2 + 0.6 * 0.95, 6);
    // Held where its picture ends, once the dissolve is over.
    expect(trackedFootage(layer.track!, scene(m), 10_500)!.sourceMs).toBe(10_000);
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

  it('draws the box round the thing, turned with it', () => {
    const m = post();
    const thing = trackedThingAt(walk({ x: walk().x.map(() => 0.5) }), scene(m), 2000)!;
    expect(thing.cx).toBeCloseTo(0.5, 6);
    expect(thing.corners[0]!.x).toBeCloseTo(0.4, 6);
    expect(thing.corners[2]!.y).toBeCloseTo(0.55, 6);
  });
});

describe('moving a tracked layer', () => {
  it('moves the pin without moving the layer anywhere when nothing is changed', () => {
    const m = post();
    const layer = text(walk({ scaleWith: true, turnWith: true, scale: walk().atMs.map(t => 1 + t / 20_000), turn: walk().atMs.map(t => t / 500) }));
    const repinned = { ...layer, ...repinOverlay(layer, scene(m), 3000) } as EditOverlay;
    expect(repinned.track!.pin.atMs).toBe(3000);
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

  it('stands still where it is when its track is taken off', () => {
    const m = post();
    const patch = untrackOverlay(text(), scene(m), 5000);
    expect(patch.track).toBeUndefined();
    expect(patch.cx).toBeCloseTo(0.5, 6);
  });
});

describe('a tracking run', () => {
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
      lost: [],
      anchorMs: 2000,
      ...overrides,
    };
  }

  it('pins a layer where it stands on the frame the box was drawn on', () => {
    const m = post();
    const still = text(null, { cx: 0.5, cy: 0.2 });
    const tracked = { ...still, ...withTrackRun(still, scene(m), 2000, run()) } as EditOverlay;
    expect(trackedPoseAt(tracked, scene(m), 2000)!.cx).toBeCloseTo(0.5, 6);
    expect(trackedPoseAt(tracked, scene(m), 2000)!.cy).toBeCloseTo(0.2, 6);
    // The thing moves 0.04 a second; the layer with it.
    expect(trackedPoseAt(tracked, scene(m), 7000)!.cx).toBeCloseTo(0.7, 6);
  });

  it('mends a path from where it slipped, leaving the layer on the thing and nothing before it moved', () => {
    const m = post();
    const layer = text();
    // The old path: true until 4 s, then 0.05 to the left of the thing. The mend starts at 6 s.
    const mend = run({ atMs: [6000, 7000, 8000], x: [0.56, 0.62, 0.68], y: [0.5, 0.5, 0.5], scale: [1, 1, 1], turn: [0, 0, 0], anchorMs: 6000 });
    const slipped = text(walk({ x: walk().x.map((x, i) => (i > 4 ? x - 0.05 : x)) }));
    const mended = { ...slipped, ...withTrackRun(slipped, scene(m), 6000, mend, 'from') } as EditOverlay;
    expect(trackedPoseAt(mended, scene(m), 2000)!.cx).toBeCloseTo(trackedPoseAt(slipped, scene(m), 2000)!.cx, 6);
    expect(trackedPoseAt(mended, scene(m), 8000)!.cx).toBeCloseTo(0.68, 6);
    expect(trackedPoseAt(mended, scene(m), 8000)!.cy).toBeCloseTo(0.4, 6);
    expect(layer.track!.atMs.length).toBe(11);
  });

  it('mends a smoothed path that grows and turns without moving the layer anywhere before the mend', () => {
    const m = post();
    // A frame every 33 ms for 10 s: growing a tenth and turning 30 degrees over it, smoothed hard.
    const atMs = Array.from({ length: 301 }, (_, i) => Math.round(i * 33.3));
    const following = walk({
      atMs,
      x: atMs.map(t => 0.3 + (0.4 * t) / 10_000),
      y: atMs.map(() => 0.5),
      scale: atMs.map(t => 1 + t / 100_000),
      turn: atMs.map(t => (30 * t) / 10_000),
      scaleWith: true,
      turnWith: true,
      smooth: 0.8,
      pin: { atMs: 0, dx: 0.05, dy: -0.1 },
    });
    const layer = text(following, { cx: 0.35, cy: 0.4 });
    // The mend is asked for a little after a frame starts, so its first frame - the one on screen at the
    // anchor - is a frame the old path already has a sample at.
    const mendAt = atMs[180]! + 20;
    const later = atMs.filter(t => t >= atMs[180]!);
    const mend = run({
      atMs: later,
      x: later.map(t => 0.3 + (0.4 * t) / 10_000 + 0.03),
      y: later.map(() => 0.5),
      scale: later.map(() => 1),
      turn: later.map(() => 0),
      anchorMs: mendAt,
    });
    // Through the manifest, as the store puts it there, so the path is the one a draft would hold.
    const doc = post();
    doc.overlays = [layer];
    const patched = patchOverlay(doc, 't', withTrackRun(layer, scene(doc), mendAt, mend, 'from')!);
    const mended = patched.overlays[0]!;
    expect(mended.track!.atMs.length).toBe(301);
    // Before the mend the layer is where it was - to the pin's own precision, a hundred-thousandth of the
    // frame, which a half-step tolerance would leave to how the rounding happened to fall.
    for (const t of [500, 2000, 4000]) {
      const a = trackedPoseAt(layer, scene(m), t)!;
      const b = trackedPoseAt(mended, scene(m), t)!;
      expect(Math.abs(b.cx - a.cx), `x at ${t}`).toBeLessThan(2e-5);
      expect(Math.abs(b.cy - a.cy), `y at ${t}`).toBeLessThan(2e-5);
      expect(b.scale, `scale at ${t}`).toBeCloseTo(a.scale, 5);
      expect(b.rotationDeg, `turn at ${t}`).toBeCloseTo(a.rotationDeg, 3);
    }
  });

  it('keeps the layer where it is shown when the path is smoothed differently, pinned to its shown pose', () => {
    const m = post();
    const atMs = Array.from({ length: 301 }, (_, i) => Math.round(i * 33.3));
    const shaky = walk({
      atMs,
      x: atMs.map((t, i) => 0.3 + (0.4 * t) / 10_000 + (i % 2 ? 0.01 : -0.01)),
      y: atMs.map(() => 0.5),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
      smooth: 0,
    });
    const layer = text(shaky, { cx: 0.3, cy: 0.4 });
    const at = 4321;
    const shown = trackedPoseAt(layer, scene(m), at)!;
    const smoothed = { ...layer, track: { ...shaky, smooth: 0.9 } } as EditOverlay;
    const pinned = { ...smoothed, ...repinOverlay(smoothed, scene(m), at, shown) } as EditOverlay;
    const after = trackedPoseAt(pinned, scene(m), at)!;
    // To the pin's own precision: it is kept to a hundred-thousandth of the frame.
    expect(after.cx).toBeCloseTo(shown.cx, 5);
    expect(after.cy).toBeCloseTo(shown.cy, 5);
  });
});

describe('a mended path', () => {
  /** A frame every 33 ms for 10 s: the thing walking right and bobbing, growing and turning a little. */
  function filmed(overrides: Partial<OverlayTrack> = {}): OverlayTrack {
    const atMs = Array.from({ length: 301 }, (_, i) => Math.round(i * 33.3));
    return walk({
      atMs,
      x: atMs.map(t => 0.3 + (0.4 * t) / 10_000),
      y: atMs.map(t => 0.5 + 0.05 * Math.sin(t / 700)),
      scale: atMs.map(t => 1 + t / 50_000),
      turn: atMs.map(t => (20 * t) / 10_000),
      scaleWith: true,
      turnWith: true,
      smooth: 0.3,
      pin: { atMs: 0, dx: 0.05, dy: -0.1 },
      ...overrides,
    });
  }

  /** A run from the frame at `index` on, finding the thing 0.08 of the frame right of where the old path had it. */
  function mendFrom(track: OverlayTrack, index: number): TrackRunResult {
    const later = track.atMs.slice(index);
    return {
      clipId: 'a',
      clipKey: 'a',
      aspect: ASPECT,
      box: { w: 0.2, h: 0.1 },
      atMs: later,
      x: later.map(t => 0.3 + (0.4 * t) / 10_000 + 0.08),
      y: later.map(t => 0.5 + 0.05 * Math.sin(t / 700)),
      scale: later.map(() => 1),
      turn: later.map(() => 0),
      lost: [],
      // A little after its first frame starts, as a playhead is.
      anchorMs: track.atMs[index]! + 10,
    };
  }

  /** The layer mended by `run`, through the manifest and back out of a draft, as the store and a reload leave it. */
  function mended(layer: EditOverlay, run: TrackRunResult): EditOverlay {
    const doc = post();
    doc.overlays = [layer];
    const patched = patchOverlay(doc, 't', withTrackRun(layer, scene(doc), run.anchorMs, run, 'from')!);
    return normaliseManifest(JSON.parse(JSON.stringify(patched))).overlays[0]!;
  }

  /** The two drawn alike at every one of `times`: to a fiftieth of a pixel on the 720x1280 post. */
  function alike(a: EditOverlay, b: EditOverlay, times: number[], label: string): void {
    const m = post();
    for (const t of times) {
      const p = trackedPoseAt(a, scene(m), t)!;
      const q = trackedPoseAt(b, scene(m), t)!;
      expect(Math.abs(q.cx - p.cx) * 720, `x at ${t}, ${label}`).toBeLessThan(0.02);
      expect(Math.abs(q.cy - p.cy) * 1280, `y at ${t}, ${label}`).toBeLessThan(0.02);
      expect(q.scale, `size at ${t}, ${label}`).toBeCloseTo(p.scale, 5);
      expect(q.rotationDeg, `turn at ${t}, ${label}`).toBeCloseTo(p.rotationDeg, 3);
    }
  }

  it('moves nothing before the mend, however close to it, at any smoothing', () => {
    for (const smooth of [0.3, 1]) {
      const layer = text(filmed({ smooth }), { cx: 0.35, cy: 0.4 });
      const run = mendFrom(layer.track!, 180);
      const after = mended(layer, run);
      const seam = run.atMs[0]!;
      alike(layer, after, [0, 2000, seam - 900, seam - 400, seam - 100, seam - 20, seam - 1], `smooth ${smooth}`);
      // From the mend on, the path is the later run's: the thing 0.08 right of where the old one had it.
      const m = post();
      const was = trackedThingAt(layer.track!, scene(m), 8000)!;
      const now = trackedThingAt(after.track!, scene(m), 8000)!;
      expect(now.cx - was.cx).toBeCloseTo(0.08, 3);
    }
  });

  it('smooths the part before a mend as it would have been, when the smoothing is changed after it', () => {
    const layer = text(filmed({ scaleWith: undefined, turnWith: undefined }), { cx: 0.35, cy: 0.4 });
    const run = mendFrom(layer.track!, 180);
    const after = mended(layer, run);
    const hard = (o: EditOverlay) => ({ ...o, track: { ...o.track!, smooth: 1 } }) as EditOverlay;
    const seam = run.atMs[0]!;
    alike(hard(layer), hard(after), [3000, seam - 500, seam - 100, seam - 1], 'smoothed harder');
  });

  it('keeps the path before a second mend, made before the first or at it', () => {
    const layer = text(filmed({ smooth: 0.6 }), { cx: 0.35, cy: 0.4 });
    const first = mendFrom(layer.track!, 180);
    const once = mended(layer, first);
    const before = mendFrom(once.track!, 120);
    const twice = mended(once, before);
    alike(layer, twice, [1000, before.atMs[0]! - 300, before.atMs[0]! - 1], 'mended before the first');
    expect(twice.track!.seams!.map(seam => seam.atMs)).toEqual([before.atMs[0]]);
    const again = mended(once, mendFrom(once.track!, 180));
    alike(layer, again, [1000, first.atMs[0]! - 300, first.atMs[0]! - 1], 'mended at the first');
  });

  it('is read back from a draft as it was written, and a seam out of place is left out', () => {
    const layer = text(filmed(), { cx: 0.35, cy: 0.4 });
    const after = mended(layer, mendFrom(layer.track!, 180));
    const seams = after.track!.seams!;
    expect(seams.length).toBe(1);
    expect(seams[0]!.atMs).toBe(layer.track!.atMs[180]);
    // What the earlier path went on to do, from the seam as far as the widest smoothing reaches.
    expect(seams[0]!.then.atMs[0]).toBe(layer.track!.atMs[180]);
    expect(seams[0]!.then.atMs.at(-1)!).toBeLessThanOrEqual(seams[0]!.atMs + SEAM_REACH_MS);
    expect(seams[0]!.then.atMs.at(-1)!).toBeGreaterThan(seams[0]!.atMs + SEAM_REACH_MS - 40);
    expect(normaliseOverlayTrack(after.track)).toBe(after.track);
    const odd = normaliseOverlayTrack({ ...after.track!, seams: [{ atMs: -5, then: seams[0]!.then }, seams[0], { atMs: 4000, then: 'x' }] })!;
    expect(odd.seams).toEqual([seams[0]]);
    const unshaped = normaliseOverlayTrack({ ...after.track!, seams: [{ atMs: seams[0]!.atMs, then: { atMs: [1], x: [] } }] })!;
    expect(unshaped.seams).toEqual([{ atMs: seams[0]!.atMs, then: { atMs: [], x: [], y: [], scale: [], turn: [] } }]);
  });
});

describe('a layer the thing has grown past the sizes a customer can pick', () => {
  /** A frame every 33 ms for 10 s: the thing walking right and growing to twice its size, a layer following it at 4x. */
  function growing(grows = (t: number) => 1 + t / 10_000): EditOverlay {
    const atMs = Array.from({ length: 301 }, (_, i) => Math.round(i * 33.3));
    const track = walk({
      atMs,
      x: atMs.map(t => 0.3 + (0.4 * t) / 10_000),
      y: atMs.map(() => 0.5),
      scale: atMs.map(grows),
      turn: atMs.map(() => 0),
      scaleWith: true,
      smooth: 0.3,
    });
    return text(track, { cx: 0.3, cy: 0.4, scale: 4 });
  }

  /** `layer` with `patch` on it, through the manifest and back out of a draft, as the store and a reload leave it. */
  function patched(layer: EditOverlay, patch: Partial<EditOverlay>): EditOverlay {
    const doc = post();
    doc.overlays = [layer];
    return normaliseManifest(JSON.parse(JSON.stringify(patchOverlay(doc, 't', patch)))).overlays[0]!;
  }

  /** The two drawn the same size at every one of `times`. */
  function sameSize(a: EditOverlay, b: EditOverlay, times: number[], label: string): void {
    const m = post();
    for (const t of times) expect(trackedPoseAt(b, scene(m), t)!.scale, `size at ${t}, ${label}`).toBeCloseTo(trackedPoseAt(a, scene(m), t)!.scale, 4);
  }

  it('keeps its size everywhere when it is moved where it is drawn past them', () => {
    const m = post();
    const layer = growing();
    const shown = trackedPoseAt(layer, scene(m), 10_000)!;
    expect(shown.scale).toBeGreaterThan(MAX_SCALE);
    const moved = patched(layer, repinOverlay(layer, scene(m), 10_000, { cx: shown.cx + 0.05, cy: shown.cy })!);
    sameSize(layer, moved, [0, 3000, 7000, 10_000], 'moved');
    expect(trackedPoseAt(moved, scene(m), 10_000)!.cx).toBeCloseTo(shown.cx + 0.05, 4);
    expect(moved.scale).toBeLessThanOrEqual(MAX_SCALE);
  });

  it('keeps its size everywhere when the path is mended where it is drawn past them', () => {
    const m = post();
    const layer = growing();
    const later = layer.track!.atMs.slice(270);
    const run: TrackRunResult = {
      clipId: 'a',
      clipKey: 'a',
      aspect: ASPECT,
      box: { w: 0.2, h: 0.1 },
      atMs: later,
      x: later.map(t => 0.3 + (0.4 * t) / 10_000 + 0.03),
      y: later.map(() => 0.5),
      scale: later.map(() => 1),
      turn: later.map(() => 0),
      lost: [],
      anchorMs: later[0]! + 10,
    };
    const after = patched(layer, withTrackRun(layer, scene(m), run.anchorMs, run, 'from')!);
    sameSize(layer, after, [0, 4000, 8900], 'mended');
    // From the mend on, the size the later run found: the thing's size where the earlier path left it, at
    // the run's first frame a moment before the anchor, and no growing since.
    const there = trackedPoseAt(after, scene(m), run.anchorMs)!.scale;
    expect(there).toBeGreaterThan(MAX_SCALE);
    expect(there).toBeCloseTo(trackedPoseAt(layer, scene(m), run.anchorMs)!.scale, 2);
  });

  it('keeps its size on the frame a whole new run starts from', () => {
    const m = post();
    const layer = growing();
    const atMs = Array.from({ length: 31 }, (_, i) => 9000 + Math.round(i * 33.3));
    const run: TrackRunResult = {
      clipId: 'a',
      clipKey: 'a',
      aspect: ASPECT,
      box: { w: 0.2, h: 0.1 },
      atMs,
      x: atMs.map(() => 0.6),
      y: atMs.map(() => 0.5),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
      lost: [],
      anchorMs: 9500,
    };
    const after = patched(layer, withTrackRun(layer, scene(m), 9500, run, 'all')!);
    sameSize(layer, after, [9500], 'tracked again');
  });

  it('keeps its size where Size is turned off there, and from then on everywhere', () => {
    const m = post();
    const layer = growing();
    const pinned = repinOverlay(layer, scene(m), 10_000)!;
    const off = patched(layer, { ...pinned, track: { ...pinned.track!, scaleWith: undefined } });
    const drawn = trackedPoseAt(layer, scene(m), 10_000)!.scale;
    for (const t of [0, 5000, 10_000]) expect(trackedPoseAt(off, scene(m), t)!.scale, `size at ${t}`).toBeCloseTo(drawn, 4);
  });

  it('keeps a layer the thing has shrunk below them the same way', () => {
    const m = post();
    // A tenth of its size by the end, the layer following it at 1x: drawn at a tenth there.
    const layer = { ...growing(t => 1 - (0.9 * t) / 10_000), scale: 1 } as EditOverlay;
    const shown = trackedPoseAt(layer, scene(m), 10_000)!;
    expect(shown.scale).toBeLessThan(MIN_SCALE);
    const moved = patched(layer, repinOverlay(layer, scene(m), 10_000, { cx: shown.cx - 0.05, cy: shown.cy })!);
    sameSize(layer, moved, [0, 5000, 10_000], 'moved');
  });
});

describe('a tracked layer on the wire', () => {
  const context = {
    output: emptyManifest().output,
    textStyle: () => ({}),
    stickerUrl: () => '',
    fileUrl: (u: string) => u,
    drawn: () => ({ png: 'data:image/png;base64,x', wPx: 100, hPx: 40 }),
  } as unknown as RasterContext;

  it('is sent the same motion the preview reads, its animation and its track as one', async () => {
    const m = post();
    m.overlays = [text(walk(), { animation: { in: { id: 'fade', durationMs: 400 } } })];
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
    const m = post([defaultClipEdit('a', 2000)]);
    const atMs = Array.from({ length: 13 }, (_, i) => 800 + Math.round(i * 33.3));
    const dash = walk({
      atMs,
      x: atMs.map(t => 0.3 + (0.4 * (t - 800)) / 400),
      y: atMs.map(() => 0.5),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
      pin: { atMs: 800, dx: 0, dy: -0.1 },
    });
    const layer = text(dash, { endMs: 2000, animation: { in: { id: 'fade', durationMs: 500 }, out: { id: 'fade', durationMs: 500 } } });
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
    const m = post([defaultClipEdit('a', 70_000)]);
    const atMs = Array.from({ length: 2101 }, (_, i) => Math.round(i * 33.3));
    const long = walk({
      atMs,
      x: atMs.map(t => 0.2 + (0.6 * t) / 70_000),
      y: atMs.map(t => 0.5 + 0.02 * Math.sin(t / 300)),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const layer = text(long, { endMs: 70_000, animation: { in: { id: 'pop', durationMs: 470 }, loop: { id: 'pulse', periodMs: 600 } } });
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
    const m = post([defaultClipEdit('a', end)]);
    const atMs = Array.from({ length: Math.floor(end / 33.3) + 1 }, (_, i) => Math.round(i * 33.3));
    const long = walk({
      atMs,
      x: atMs.map(t => 0.2 + (0.6 * t) / end),
      y: atMs.map(t => 0.5 + 0.02 * Math.sin(t / 300)),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const layer = text(long, { endMs: end, animation: { loop: { id: 'pulse', periodMs: 200 } } });
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
    const m = post([defaultClipEdit('a', 150_000)]);
    const atMs = Array.from({ length: Math.floor(150_000 / 33.3) + 1 }, (_, i) => Math.round(i * 33.3));
    const long = walk({
      atMs,
      x: atMs.map(t => 0.2 + (0.6 * t) / 150_000),
      y: atMs.map(t => 0.5 + 0.02 * Math.sin(t / 300)),
      scale: atMs.map(() => 1),
      turn: atMs.map(() => 0),
    });
    const loops = ['pulse', 'beat', 'heartbeat', 'float', 'sway', 'wiggle', 'shake', 'spin', 'breathe'];
    const cases = [
      ...loops.map(id => ({ endMs: end, fps: 30, animation: { loop: { id, periodMs: 200 } } })),
      { endMs: 150_000, fps: 60, animation: { in: { id: 'flicker', durationMs: 100 }, loop: { id: 'shake', periodMs: 200 }, out: { id: 'flicker', durationMs: 100 } } },
    ];
    for (const { endMs, fps, animation } of cases) {
      const layer = text(long, { endMs, animation });
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
});

describe('the edit ops keep a track', () => {
  it('on both halves of a cut layer, and on a copy, nudged with it', () => {
    const m = post();
    m.overlays = [text()];
    const cut = splitOverlayAt(m, 't', 4000, 't2', 10_000)!;
    expect(cut.overlays.map(o => o.track)).toEqual([walk(), walk()]);
    const copied = duplicateOverlay(m, 't', 'c')!;
    expect(copied.overlays[1]!.track!.pin.dy).toBeCloseTo(-0.05, 6);
  });

  it('as no change when a patch does not touch it, and off when one takes it away', () => {
    const m = post();
    m.overlays = [text()];
    expect(patchOverlay(m, 't', { track: m.overlays[0]!.track })).toBe(m);
    expect(patchOverlay(m, 't', { track: undefined }).overlays[0]!.track).toBeUndefined();
    expect('track' in patchOverlay(m, 't', { track: undefined }).overlays[0]!).toBe(false);
  });
});
