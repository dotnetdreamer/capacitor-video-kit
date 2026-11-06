import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MAX_CAMERA_KEYS, type ComposeCamera } from '../video-composer/definitions';
import { cameraAt, IDENTITY_VIEW, viewPoint } from './camera';
import { toComposeSpec } from './compose';
import {
  defaultClipEdit,
  emptyManifest,
  normaliseManifest,
  normaliseZoom,
  type EditClip,
  type EditManifest,
  type EditTrack,
  type EditZoom,
  type TextOverlay,
  type ZoomFraming,
} from './edit-manifest';
import { updateZoom } from './edit-ops';
import { compileLayoutMotions } from './layout-motion';
import { overlayMotionAt } from './motion';
import type { RasterContext } from './raster-context';
import { compileLayerMotion, trackedPoseAt, trackedThingAt, type TrackScene } from './track-motion';
import { compileCamera, easeValue, followPaths, followReframes, followRest, followViewAt, viewBetween, type CameraFollow, type FollowPath } from './zoom';

/*
 * Follow cam: a zoom that follows a track, compiled into the same camera keys every other zoom is.
 * These pin what it promises the render - a key every frame of the post, ramps blended frame by frame
 * from the whole frame, the view held inside the PICTURE (a 16:9 shot contained in a 9:16 post is
 * reframed at 256/81 with no bar), framings sized to the thing, an operator's move, the key cap - and
 * that a post with no zoom that follows compiles exactly as it did before following existed.
 *
 * The post is 720x1280 at 30 fps over one 10 s clip, "a", contained; its track "k" has the thing at
 * mid height going from 0.1 to 0.9 of the source's width, a sample every 100 ms.
 */

const WIDE = 16 / 9;
const TALL = 9 / 16;
const FRAME_MS = 1000 / 30;

/** Track "k" of clip "a": the thing at `xAt(t)`, `yAt(t)` of the source at SOURCE ms `t`. */
function walk(aspect: number, xAt: (t: number) => number, yAt: (t: number) => number = () => 0.5, lengthMs = 10_000, every = 100, box = { w: 0.1, h: 0.2 }): EditTrack {
  const atMs = Array.from({ length: Math.floor(lengthMs / every) + 1 }, (_, i) => i * every);
  return {
    id: 'k',
    name: 'Rider',
    hue: 2,
    clipId: 'a',
    clipKey: 'a',
    aspect,
    box,
    atMs,
    x: atMs.map(xAt),
    y: atMs.map(yAt),
    scale: atMs.map(() => 1),
    turn: atMs.map(() => 0),
    smooth: 0,
  };
}

const across =
  (lengthMs = 10_000) =>
  (t: number) =>
    0.1 + (0.8 * t) / lengthMs;

function post(track: EditTrack, zooms: EditZoom[], clip: Partial<EditClip> = {}, lengthMs = 10_000): EditManifest {
  return {
    ...emptyManifest(),
    output: { width: 720, height: 1280, fps: 30 },
    fit: 'contain',
    clips: [{ ...defaultClipEdit('a', lengthMs), ...clip }],
    tracks: [track],
    zooms,
  };
}

/** Zoom "f" over the whole clip following "k", with no ramp unless `over` says otherwise. */
function follows(framing: ZoomFraming, over: Partial<EditZoom> = {}): EditZoom {
  return { id: 'f', startMs: 0, endMs: 10_000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 0, ease: 'smooth', follow: { trackId: 'k', framing }, ...over };
}

function followOf(m: EditManifest): CameraFollow {
  return { manifest: m, layout: compileLayoutMotions(m) };
}

function pathOf(m: EditManifest, id = 'f'): FollowPath {
  return followPaths(m.zooms, 10_000, followOf(m)).get(id)!;
}

/** A 16:9 picture contained in a 9:16 frame: the whole width, at 81/256 of the height, in the middle. */
const PICTURE_TOP = (1 - 81 / 256) / 2;
const PICTURE_BOTTOM = (1 + 81 / 256) / 2;

describe('a post with no zoom that follows', () => {
  function z(id: string, startMs: number, endMs: number, extra: Partial<EditZoom> = {}): EditZoom {
    return { id, startMs, endMs, cx: 0.3, cy: 0.4, scale: 2, rampMs: 500, ease: 'smooth', ...extra };
  }

  /** What these compiled to before following existed: the SHA-256 of each camera's JSON. */
  const CASES: { name: string; zooms: EditZoom[]; totalMs: number; sha: string }[] = [
    { name: 'one', zooms: [z('a', 1000, 4000)], totalMs: 10_000, sha: '6fdb672e6f998172899cd3ca1cbe8b6f259dc66e2f299d78ec2c409736a04fab' },
    {
      name: 'pan',
      zooms: [z('a', 1000, 3000, { cx: 0.25, cy: 0.25 }), z('b', 3000, 5000, { cx: 0.75, cy: 0.75, scale: 3 })],
      totalMs: 10_000,
      sha: '00db57aa689d9a14fc45206640e1346a7dbd86fb18eac949ec126c9113eaba66',
    },
    {
      name: 'steps',
      zooms: [
        z('a', 0, 2000, { rampMs: 0, chain: false }),
        z('b', 2000, 4000, { rampMs: 0, rampOutMs: 300, ease: 'snappy', chain: false }),
        z('c', 4500, 6000, { ease: 'steady', rampOutMs: 0 }),
      ],
      totalMs: 10_000,
      sha: '334991175093c2faaac06acfd4fa89f1531ccde73d22dbf039f907385f8dcc32',
    },
    {
      name: 'stair',
      zooms: [
        z('a', 0, 1000, { scale: 1.06, rampMs: 90, rampOutMs: 0, chain: 'out' }),
        z('b', 1000, 2000, { scale: 1.12, rampMs: 90, rampOutMs: 0 }),
        z('c', 2000, 3000, { scale: 1.18, rampMs: 90, rampOutMs: 0, chain: 'in' }),
        z('d', 3000, 4000, { rampMs: 0, rampOutMs: 0, cx: 0, cy: 1, scale: 4 }),
      ],
      totalMs: 10_000,
      sha: 'c65d027d70a5706a98bfbed1897a4465cd86626b5244768a57bb2e4a07c3f98a',
    },
    {
      name: 'long',
      zooms: Array.from({ length: 10 }, (_, i) => z(`l${i}`, i * 130_000, i * 130_000 + 120_000, { rampMs: 60_000 })),
      totalMs: 1_300_000,
      sha: '8ca34a898272edc298f49fdc7bf700808641e5da8a2f4c21e0fdc60f8128793d',
    },
    { name: 'past end', zooms: [z('a', 8000, 14_000, { rampMs: 1500 })], totalMs: 10_000, sha: '3658fe7fedb86dc012783a3ae28d877fffdc134cde32a437a1dab17faf1ccae7' },
  ];

  const sha = (camera: ComposeCamera | null) => createHash('sha256').update(JSON.stringify(camera)).digest('hex');
  const scene = followOf(post(walk(WIDE, across()), []));

  it('compiles byte for byte as before, with the post to follow through or without', () => {
    for (const c of CASES) {
      expect(sha(compileCamera(c.zooms, c.totalMs)), c.name).toBe(c.sha);
      expect(sha(compileCamera(c.zooms, c.totalMs, scene)), c.name).toBe(c.sha);
    }
  });

  it('holds each zoom on its own area when the track it follows is not on the post', () => {
    for (const c of CASES) {
      const gone = c.zooms.map(zoom => ({ ...zoom, follow: { trackId: 'gone', framing: 'mid' as const } }));
      expect(sha(compileCamera(gone, c.totalMs, scene)), c.name).toBe(c.sha);
    }
    const m = post(walk(WIDE, across()), [follows('fill', { cx: 0.3, scale: 3, rampMs: 500 })]);
    const noTrack = { ...m, tracks: [] };
    const { follow: _follow, ...still } = m.zooms[0];
    expect(compileCamera(noTrack.zooms, 10_000, followOf(noTrack))).toEqual(compileCamera([still], 10_000));
  });
});

describe('compileCamera following a track', () => {
  it('reframes a 16:9 shot contained in a 9:16 post at 256/81, panning across the whole width', () => {
    const m = post(walk(WIDE, across()), [follows('fill')]);
    const camera = compileCamera(m.zooms, 10_000, followOf(m))!;
    let held = 0;
    camera.atMs.forEach((_, i) => {
      if (camera.scale[i] === 1) return;
      held++;
      expect(camera.scale[i]).toBeCloseTo(256 / 81, 5);
      // The window is exactly the picture's height: no bar above or below it.
      expect(camera.cy[i]).toBeCloseTo(0.5, 6);
      const half = 0.5 / camera.scale[i];
      expect(camera.cx[i] - half).toBeGreaterThanOrEqual(-1e-6);
      expect(camera.cx[i] + half).toBeLessThanOrEqual(1 + 1e-6);
    });
    expect(held).toBeGreaterThan(290);
    // It pans with the thing, from the left of the shot to the right.
    expect(cameraAt(camera, 1000)!.cx).toBeLessThan(0.3);
    expect(cameraAt(camera, 9000)!.cx).toBeGreaterThan(0.7);
  });

  it('keys every frame of the post on its clock, its ramps blending from the whole frame frame by frame', () => {
    const m = post(walk(TALL, across()), [follows('mid', { startMs: 1000, endMs: 9000, rampMs: 1000 })]);
    const camera = compileCamera(m.zooms, 10_000, followOf(m))!;
    const path = pathOf(m);
    const n = camera.atMs.length;
    // The window's 8 s at 30 fps, both ends in: 241 keys.
    expect(n).toBe(241);
    expect([camera.atMs[0], camera.scale[0]]).toEqual([1000, 1]);
    expect([camera.atMs[n - 1], camera.scale[n - 1]]).toEqual([9000, 1]);
    for (let i = 1; i < n; i++) {
      const t = camera.atMs[i];
      expect(Math.abs(t / FRAME_MS - Math.round(t / FRAME_MS)), `key ${i} at ${t}`).toBeLessThan(1e-3);
      expect(t - camera.atMs[i - 1]).toBeLessThanOrEqual(FRAME_MS + 0.002);
    }
    // Half way up the ramp, the blend of the whole frame and where the thing is THEN.
    const i = camera.atMs.indexOf(1500);
    const blend = viewBetween({ ...IDENTITY_VIEW }, followViewAt(path, 1500), easeValue('smooth', 0.5));
    expect(camera.scale[i]).toBeCloseTo(blend.scale, 5);
    expect(camera.cx[i]).toBeCloseTo(blend.cx, 5);
    expect(camera.scale[i]).toBeGreaterThan(1.05);
    expect(camera.scale[i]).toBeLessThan(path.views[0].scale);
    // The ramp lands on the moving view, and the hold is the path.
    for (const t of [2000, 5000, 8000]) {
      const view = cameraAt(camera, t)!;
      expect(view.cx).toBeCloseTo(followViewAt(path, t).cx, 5);
      expect(view.scale).toBeCloseTo(followViewAt(path, t).scale, 5);
    }
  });

  it('holds the view inside the picture, not only inside the frame', () => {
    // Up at the top edge of the source, closed in far enough that the view could leave the picture.
    const m = post(
      walk(WIDE, across(), () => 0.05),
      [follows('mid')],
    );
    const camera = compileCamera(m.zooms, 10_000, followOf(m))!;
    camera.atMs.forEach((_, i) => {
      if (camera.scale[i] === 1) return;
      const half = 0.5 / camera.scale[i];
      expect(camera.scale[i]).toBeGreaterThanOrEqual(256 / 81 - 1e-6);
      expect(camera.cy[i] - half).toBeGreaterThanOrEqual(PICTURE_TOP - 1e-6);
      expect(camera.cy[i] + half).toBeLessThanOrEqual(PICTURE_BOTTOM + 1e-6);
    });
  });

  it('frames the thing at about 45% of the frame height for Medium and 70% for Close, held between the whole shot and 4x', () => {
    for (const [framing, share] of [
      ['mid', 0.45],
      ['close', 0.7],
    ] as const) {
      const m = post(
        walk(TALL, () => 0.5),
        [follows(framing)],
      );
      for (const view of pathOf(m).views) expect(0.2 * view.scale, framing).toBeCloseTo(share, 6);
    }
    const tiny = post(
      walk(
        TALL,
        () => 0.5,
        () => 0.5,
        10_000,
        100,
        { w: 0.02, h: 0.05 },
      ),
      [follows('close')],
    );
    for (const view of pathOf(tiny).views) expect(view.scale).toBeCloseTo(4, 9);
    // The whole shot of a picture that fills its frame moves nothing: the absent camera.
    const filled = post(walk(TALL, across()), [follows('fill')]);
    expect(pathOf(filled).views.every(view => view.scale === 1)).toBe(true);
    expect(compileCamera(filled.zooms, 10_000, followOf(filled))).toBeNull();
  });

  it('moves like an operator: a little ahead into a move, a moment behind in it, never past the stop', () => {
    // Still at 0.3 until 2 s, across to 0.7 by 4 s, still after.
    const xAt = (t: number) => (t <= 2000 ? 0.3 : t >= 4000 ? 0.7 : 0.3 + (0.4 * (t - 2000)) / 2000);
    const m = post(walk(TALL, xAt), [follows('mid')]);
    const path = pathOf(m);
    path.views.forEach((view, i) => {
      expect(view.cx).toBeGreaterThanOrEqual(0.3 - 1e-9);
      expect(view.cx).toBeLessThanOrEqual(0.7 + 1e-9);
      if (i > 0) expect(view.cx).toBeGreaterThanOrEqual(path.views[i - 1].cx - 1e-9);
    });
    expect(followViewAt(path, 2000).cx).toBeGreaterThan(0.3 + 1e-3);
    const moving = followViewAt(path, 3000).cx;
    expect(moving).toBeGreaterThan(0.45);
    expect(moving).toBeLessThan(0.5);
    expect(followViewAt(path, 6000).cx).toBeCloseTo(0.7, 3);
  });

  it('coarsens a follow too long to key every frame, staying under the cap and reaching the end', () => {
    const lengthMs = 15 * 60_000;
    const m = post(
      walk(TALL, across(lengthMs), () => 0.5, lengthMs, 1000),
      [follows('mid', { endMs: lengthMs })],
      {},
      lengthMs,
    );
    const camera = compileCamera(m.zooms, lengthMs, followOf(m))!;
    expect(camera.atMs.length).toBeLessThanOrEqual(MAX_CAMERA_KEYS);
    expect(camera.atMs.length).toBeGreaterThan(MAX_CAMERA_KEYS / 4);
    expect(camera.atMs[camera.atMs.length - 1]).toBe(lengthMs);
  });

  it('keeps a still view of the thing for where it cannot follow', () => {
    const rest = followRest(pathOf(post(walk(WIDE, across()), [follows('fill')])));
    expect(rest.scale).toBeCloseTo(256 / 81, 5);
    expect(rest.cy).toBeCloseTo(0.5, 6);
    expect(rest.cx).toBeGreaterThan(0.4);
    expect(rest.cx).toBeLessThan(0.6);
  });

  it('goes on the wire as the follow camera', async () => {
    const m = post(walk(WIDE, across()), [follows('fill', { rampMs: 400 })]);
    const spec = await toComposeSpec(m, new Map([['a', 'file:///a.mp4']]), { jobId: 'j', batchId: 'b' }, {} as RasterContext);
    expect(spec.camera).toEqual(compileCamera(m.zooms, 10_000, followOf(m)));
  });
});

describe('a layer pinned to the followed track', () => {
  it('stays on the thing under the moving camera, in the preview and on the wire', () => {
    const track = walk(WIDE, across());
    const text: TextOverlay = {
      id: 't',
      kind: 'text',
      text: 'Rider',
      styleId: 'classic',
      color: '#ffffff',
      effect: 'shadow',
      align: 'center',
      cx: 0.5,
      cy: 0.5,
      scale: 1,
      rotationDeg: 0,
      opacity: 1,
      startMs: 0,
      endMs: 10_000,
      follow: { trackId: 'k', pin: { atMs: 0, dx: 0, dy: 0 } },
    };
    const m: EditManifest = { ...post(track, [follows('fill', { rampMs: 600 })]), overlays: [text] };
    const layout = compileLayoutMotions(m);
    const camera = compileCamera(m.zooms, 10_000, { manifest: m, layout });
    const scene: TrackScene = { manifest: m, camera, layout };
    const bare: TrackScene = { manifest: m, camera: null, layout };
    for (const t of [300, 1000, 2500, 5000, 7500, 9800]) {
      const pose = trackedPoseAt(text, scene, t)!;
      const thing = trackedThingAt(track, bare, t)!;
      const view = cameraAt(camera, t);
      const drawn = view ? viewPoint(view, thing.cx, thing.cy) : { x: thing.cx, y: thing.cy };
      expect(pose.cx, `x at ${t}`).toBeCloseTo(drawn.x, 6);
      expect(pose.cy, `y at ${t}`).toBeCloseTo(drawn.y, 6);
      // Near the middle of the frame while the camera holds on it, between its two ramps.
      if (t >= 1000 && t <= 9000) expect(Math.abs(pose.cx - 0.5), `kept in frame at ${t}`).toBeLessThan(0.15);
      else expect(pose.cx > 0 && pose.cx < 1, `on the frame at ${t}`).toBe(true);
    }
    const motion = compileLayerMotion(text, scene, { startMs: 0, endMs: 10_000 });
    for (const t of [1000, 5000, 9000]) {
      const at = overlayMotionAt(motion, t)!;
      expect(text.cx + at.x).toBeCloseTo(trackedPoseAt(text, scene, t)!.cx, 3);
    }
  });
});

describe('a zoom that follows, in the model', () => {
  it('keeps its follow through normaliseZoom, the very object when it is in shape', () => {
    const zoom = follows('mid');
    expect(normaliseZoom(zoom).follow).toBe(zoom.follow);
    expect(normaliseZoom({ ...zoom, follow: { trackId: 'k', framing: 'wide' as ZoomFraming } }).follow).toEqual({ trackId: 'k', framing: 'fill' });
    expect('follow' in normaliseZoom({ ...zoom, follow: { trackId: '', framing: 'mid' } })).toBe(false);
    expect('follow' in normaliseZoom({ ...zoom, follow: undefined })).toBe(false);
    const read = normaliseManifest(JSON.parse(JSON.stringify(post(walk(WIDE, across()), [zoom]))));
    expect(read.zooms[0].follow).toEqual({ trackId: 'k', framing: 'mid' });
  });

  it('follows and lets go through updateZoom, the same follow again being no change', () => {
    const m = post(walk(WIDE, across()), [follows('mid')]);
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'mid' } })).toBe(m);
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'close' } }).zooms[0].follow).toEqual({ trackId: 'k', framing: 'close' });
    expect('follow' in updateZoom(m, 'f', { follow: null }).zooms[0]).toBe(false);
  });

  it('tells a shot to reframe from one that already fills its frame', () => {
    const output = { width: 720, height: 1280 };
    expect(followReframes({}, { aspect: WIDE }, output)).toBe(true);
    expect(followReframes({}, { aspect: 1082 / 1920 }, output)).toBe(false);
    expect(followReframes({ crop: { x: 0.34, y: 0, w: 81 / 256, h: 1 } }, { aspect: WIDE }, output)).toBe(false);
    expect(followReframes({ rect: { x: 0, y: 0, w: 1, h: 0.5 } }, { aspect: TALL }, output)).toBe(true);
  });
});
