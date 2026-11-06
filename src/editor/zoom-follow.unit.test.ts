import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MAX_CAMERA_KEYS, type ComposeCamera } from '../video-composer/definitions';
import { cameraAt, IDENTITY_VIEW, viewPoint } from './camera';
import { toComposeSpec } from './compose';
import {
  defaultClipEdit,
  emptyManifest,
  MAX_ZOOM_SCALE,
  normaliseManifest,
  normaliseZoom,
  sameZoomFollow,
  type EditClip,
  type EditManifest,
  type EditTrack,
  type EditZoom,
  type TextOverlay,
  type ZoomFollow,
  type ZoomFraming,
} from './edit-manifest';
import { duplicateZoom, updateZoom } from './edit-ops';
import { compileLayoutMotions } from './layout-motion';
import { overlayMotionAt } from './motion';
import type { RasterContext } from './raster-context';
import { compileLayerMotion, trackedPoseAt, trackedThingAt, type TrackScene } from './track-motion';
import { compileCamera, easeValue, followPaths, followReframes, followRest, followViewAt, viewBetween, type CameraFollow, type FollowPath } from './zoom';

/*
 * Follow cam: a zoom that follows a track, compiled into the same camera keys every other zoom is.
 * These pin what it promises the render - a key every frame of the post, ramps blended frame by frame
 * from the whole frame, the view held inside the PICTURE (a 16:9 shot contained in a 9:16 post is
 * reframed at 256/81 with no bar), framings sized to the thing, an operator's move, the key cap, a
 * least level under any framing (a punch-in that follows) and a most over it - and that a post with no
 * zoom that follows compiles exactly as it did before following existed.
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

describe('a follow held at a least level (minScale): a punch-in that follows', () => {
  /** [follows] at `framing`, the camera held at least `minScale` close. */
  const floored = (framing: ZoomFraming, minScale: number, over: Partial<EditZoom> = {}): EditZoom => follows(framing, { follow: { trackId: 'k', framing, minScale }, ...over });

  it('closes in on a picture that fills its frame for the whole shot too, panning with the thing', () => {
    const m = post(walk(TALL, across()), [floored('fill', 1.15)]);
    const path = pathOf(m);
    for (const view of path.views) {
      expect(view.scale).toBeCloseTo(1.15, 9);
      const half = 0.5 / view.scale;
      expect(view.cx - half).toBeGreaterThanOrEqual(-1e-9);
      expect(view.cx + half).toBeLessThanOrEqual(1 + 1e-9);
    }
    expect(followViewAt(path, 1000).cx).toBeLessThan(0.45);
    expect(followViewAt(path, 9000).cx).toBeGreaterThan(0.55);
    // A camera, where the whole shot of the same picture is none.
    expect(compileCamera(m.zooms, 10_000, followOf(m))).not.toBeNull();
  });

  it('raises a framing that frames wider than the floor to it, and leaves one that frames closer alone', () => {
    // The thing's box 0.2 of the height, which Medium frames at 2.25.
    const small = (zoom: EditZoom) => pathOf(post(walk(TALL, () => 0.5), [zoom])).views;
    expect(small(floored('mid', 1.5))).toEqual(small(follows('mid')));
    for (const view of small(floored('mid', 3))) expect(view.scale).toBeCloseTo(3, 9);
    // Somebody filling most of the frame, whom Medium does not close in on at all.
    const big = (zoom: EditZoom) => pathOf(post(walk(TALL, () => 0.5, () => 0.5, 10_000, 100, { w: 0.3, h: 0.8 }), [zoom])).views;
    expect(big(follows('mid')).every(view => view.scale === 1)).toBe(true);
    for (const view of big(floored('mid', 1.2))) expect(view.scale).toBeCloseTo(1.2, 9);
  });

  it('closes in past the floor from rest, the way it would from any level it held', () => {
    // Walking away: 0.8 of the height at first and 0.2 at last, so Medium asks 1, then 1.3 at about 7.4 s, then 2.25.
    const away = walk(TALL, () => 0.5);
    away.scale = away.atMs.map(t => 4 - (3 * t) / 10_000);
    const views = pathOf(post(away, [floored('mid', 1.3)])).views;
    expect(views[0].scale).toBeCloseTo(1.3, 9);
    for (let i = 1; i < views.length; i++) expect(views[i].scale).toBeGreaterThanOrEqual(views[i - 1].scale - 1e-12);
    expect(views[views.length - 1].scale).toBeGreaterThan(1.6);
    // Off the floor gathering speed, never already climbing: its first steps up are a fraction of the steady climb's.
    const off = views.findIndex(view => view.scale > 1.3 + 1e-9);
    expect(off).toBeGreaterThan(0);
    for (let i = off; i < off + 5; i++) expect(views[i].scale - views[i - 1].scale, `frame ${i}`).toBeLessThan(1e-3);
  });

  it('changes nothing where the picture already asks for more: a wide shot contained in a tall post', () => {
    const wide = (zoom: EditZoom) => pathOf(post(walk(WIDE, across()), [zoom])).views;
    expect(wide(floored('fill', 1.15))).toEqual(wide(follows('fill')));
  });

  it('is kept by the model over 1, at four decimals, held to the most the editor offers', () => {
    const zoom = floored('mid', 1.15);
    expect(normaliseZoom(zoom).follow).toBe(zoom.follow);
    const kept = (minScale: unknown, framing: unknown = 'mid') => normaliseZoom({ ...zoom, follow: { trackId: 'k', framing, minScale } as ZoomFollow }).follow;
    expect(kept(1.123456)).toStrictEqual({ trackId: 'k', framing: 'mid', minScale: 1.1235 });
    expect(kept(9)).toStrictEqual({ trackId: 'k', framing: 'mid', minScale: MAX_ZOOM_SCALE });
    expect(kept(1.4, 'wide')).toStrictEqual({ trackId: 'k', framing: 'fill', minScale: 1.4 });
    for (const none of [1, 0.8, 1.00004, -2, Number.NaN, Infinity, '1.2', null, undefined]) {
      expect(kept(none), String(none)).toStrictEqual({ trackId: 'k', framing: 'mid' });
    }
    const read = normaliseManifest(JSON.parse(JSON.stringify(post(walk(WIDE, across()), [zoom]))));
    expect(read.zooms[0].follow).toStrictEqual({ trackId: 'k', framing: 'mid', minScale: 1.15 });
  });

  it('tells two floors apart: the same one is no change, another is one, and a copy of the zoom keeps it', () => {
    const m = post(walk(TALL, () => 0.5), [floored('mid', 1.15, { endMs: 4000 })]);
    expect(sameZoomFollow({ trackId: 'k', framing: 'mid', minScale: 1.15 }, { trackId: 'k', framing: 'mid' })).toBe(false);
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'mid', minScale: 1.15 } })).toBe(m);
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'mid', minScale: 1.3 } }).zooms[0].follow).toStrictEqual({ trackId: 'k', framing: 'mid', minScale: 1.3 });
    // A framing picked in the zoom sheet is a follow without one, so the sheet's framings mean what they say.
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'close' } }).zooms[0].follow).toStrictEqual({ trackId: 'k', framing: 'close' });
    expect(duplicateZoom(m, 'f', 'g', 10_000)!.zooms[1].follow).toStrictEqual({ trackId: 'k', framing: 'mid', minScale: 1.15 });
  });
});

describe('a follow held to a most level (maxScale): never closer than the template allows', () => {
  /** [follows] at `framing`, its follow given the levels in `limits`. */
  const limited = (framing: ZoomFraming, limits: Pick<ZoomFollow, 'minScale' | 'maxScale'>, over: Partial<EditZoom> = {}): EditZoom =>
    follows(framing, { follow: { trackId: 'k', framing, ...limits }, ...over });

  /** Walking away: 0.8 of the height at first and 0.2 at last, so Medium asks 1 at first and 2.25 at the end. */
  function away(): EditTrack {
    const track = walk(TALL, () => 0.5);
    track.scale = track.atMs.map(t => 4 - (3 * t) / 10_000);
    return track;
  }

  it('stops a framing that would close in further at the cap, and leaves one that frames wider alone', () => {
    // A speck the finder took for somebody: Close frames it at the most there is.
    const speck = (zoom: EditZoom) => pathOf(post(walk(TALL, () => 0.5, () => 0.5, 10_000, 100, { w: 0.02, h: 0.05 }), [zoom])).views;
    for (const view of speck(follows('close'))) expect(view.scale).toBeCloseTo(MAX_ZOOM_SCALE, 9);
    for (const view of speck(limited('close', { maxScale: 1.6 }))) expect(view.scale).toBeCloseTo(1.6, 9);
    const small = (zoom: EditZoom) => pathOf(post(walk(TALL, () => 0.5), [zoom])).views;
    expect(small(limited('mid', { maxScale: 3 }))).toEqual(small(follows('mid')));
  });

  it('never frames wider than the fill: a wide shot contained in a tall post shows no bar under any cap', () => {
    for (const view of pathOf(post(walk(WIDE, across()), [limited('mid', { maxScale: 1.2 })])).views) {
      expect(view.scale).toBeCloseTo(256 / 81, 9);
      expect(view.cy).toBeCloseTo(0.5, 9);
    }
  });

  it('eases up to the cap and settles there, never past it, and holds between a floor and a cap', () => {
    const views = pathOf(post(away(), [limited('mid', { maxScale: 1.6 })])).views;
    for (let i = 1; i < views.length; i++) {
      expect(views[i].scale).toBeGreaterThanOrEqual(views[i - 1].scale - 1e-12);
      expect(views[i].scale).toBeLessThanOrEqual(1.6 + 1e-9);
    }
    expect(views[views.length - 1].scale).toBeGreaterThan(1.5);
    // Slowing into it rather than stopped at it dead: each of its last steps no bigger than the one before.
    const last = views.slice(-11).map(view => view.scale);
    for (let i = 2; i < last.length; i++) expect(last[i]! - last[i - 1]!).toBeLessThanOrEqual(last[i - 1]! - last[i - 2]! + 1e-12);
    const between = pathOf(post(away(), [limited('mid', { minScale: 1.3, maxScale: 1.5 })])).views;
    expect(between[0].scale).toBeCloseTo(1.3, 9);
    for (const view of between) {
      expect(view.scale).toBeGreaterThanOrEqual(1.3 - 1e-9);
      expect(view.scale).toBeLessThanOrEqual(1.5 + 1e-9);
    }
    expect(between[between.length - 1].scale).toBeGreaterThan(1.45);
  });

  it('is kept by the model over 1, at four decimals, held to the most the editor offers and never under the floor', () => {
    const zoom = limited('close', { minScale: 1.15, maxScale: 1.6 });
    expect(normaliseZoom(zoom).follow).toBe(zoom.follow);
    const kept = (minScale: unknown, maxScale: unknown) => normaliseZoom({ ...zoom, follow: { trackId: 'k', framing: 'close', minScale, maxScale } as ZoomFollow }).follow;
    expect(kept(undefined, 1.654321)).toStrictEqual({ trackId: 'k', framing: 'close', maxScale: 1.6543 });
    expect(kept(undefined, 7)).toStrictEqual({ trackId: 'k', framing: 'close', maxScale: MAX_ZOOM_SCALE });
    for (const none of [1, 0.5, 1.00004, Number.NaN, Infinity, '1.6', null, undefined]) {
      expect(kept(undefined, none), String(none)).toStrictEqual({ trackId: 'k', framing: 'close' });
    }
    // A cap under the floor is raised to it: the camera holds the floor, the one level both allow.
    expect(kept(1.3, 1.2)).toStrictEqual({ trackId: 'k', framing: 'close', minScale: 1.3, maxScale: 1.3 });
    const read = normaliseManifest(JSON.parse(JSON.stringify(post(walk(WIDE, across()), [zoom]))));
    expect(read.zooms[0].follow).toStrictEqual({ trackId: 'k', framing: 'close', minScale: 1.15, maxScale: 1.6 });
  });

  it('tells two caps apart, keeps one through a copy, and loses it to a framing picked in the zoom sheet', () => {
    const m = post(walk(TALL, () => 0.5), [limited('close', { maxScale: 1.6 }, { endMs: 4000 })]);
    expect(sameZoomFollow({ trackId: 'k', framing: 'close', maxScale: 1.6 }, { trackId: 'k', framing: 'close' })).toBe(false);
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'close', maxScale: 1.6 } })).toBe(m);
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'close', maxScale: 2 } }).zooms[0].follow).toStrictEqual({ trackId: 'k', framing: 'close', maxScale: 2 });
    expect(updateZoom(m, 'f', { follow: { trackId: 'k', framing: 'mid' } }).zooms[0].follow).toStrictEqual({ trackId: 'k', framing: 'mid' });
    expect(duplicateZoom(m, 'f', 'g', 10_000)!.zooms[1].follow).toStrictEqual({ trackId: 'k', framing: 'close', maxScale: 1.6 });
  });
});
