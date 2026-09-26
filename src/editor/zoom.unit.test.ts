import { describe, expect, it } from 'vitest';

import type { ComposeCamera, ComposeSpec } from '../video-composer/definitions';
import { cameraAt, normaliseCamera } from './camera';
import { toComposeSpec } from './compose';
import {
  MANIFEST_VERSION,
  MAX_STORED_ZOOM_RAMP_MS,
  MAX_ZOOMS,
  MIN_STORED_ZOOM_SCALE,
  MIN_ZOOM_MS,
  MIN_ZOOM_SCALE,
  ZOOM_CHAIN_GAP_MS,
  defaultClipEdit,
  emptyManifest,
  isUntouched,
  normaliseManifest,
  type EditManifest,
  type EditZoom,
} from './edit-manifest';
import { addZoom, cutPostTo, deleteZoom, duplicateZoom, setZoomWindow, trimClip, updateZoom, zoomRampMs, zoomRampPatch } from './edit-ops';
import type { RasterContext } from './raster-context';
import { compileCamera, easeValue, viewBetween, zoomSlots } from './zoom';

/*
 * A zoom is compiled ONCE, here, into the camera track every engine only interpolates. So these pin
 * the moves themselves - the hold is the area, a ramp squeezes into a short window, touching zooms pan
 * without passing through the whole frame, every key stays on the frame - and the model rules around
 * them: the absent wire key, the migration, and the one-lane ops.
 *
 * Then the two things a template's camera needs on top: a ramp out of its own (a push-in held to the
 * cut, a pull-out), and a zoom kept apart from its neighbours, so each clip's move starts at its cut.
 */

function zoom(id: string, startMs: number, endMs: number, extra: Partial<EditZoom> = {}): EditZoom {
  return { id, startMs, endMs, cx: 0.3, cy: 0.4, scale: 2, rampMs: 500, ease: 'smooth', ...extra };
}

function post(zooms: EditZoom[] = [], lengthMs = 10_000): EditManifest {
  return { ...emptyManifest(), clips: [defaultClipEdit('v', lengthMs)], zooms };
}

/** Every key's visible area inside the frame (to the six decimals the keys are rounded to). */
function everyKeyOnFrame(camera: ComposeCamera): boolean {
  return camera.atMs.every((_, i) => {
    const half = 0.5 / camera.scale[i];
    const eps = 1e-6;
    return camera.scale[i] >= 1 - eps && camera.cx[i] >= half - eps && camera.cx[i] <= 1 - half + eps && camera.cy[i] >= half - eps && camera.cy[i] <= 1 - half + eps;
  });
}

describe('compileCamera', () => {
  it('is null with no zooms, and with none visible', () => {
    expect(compileCamera([], 10_000)).toBeNull();
    expect(compileCamera([zoom('z', 12_000, 14_000)], 10_000)).toBeNull();
  });

  it('holds exactly the area between the ramps, and is the whole frame outside the window', () => {
    const camera = compileCamera([zoom('z', 1000, 4000)], 10_000)!;
    expect(camera).not.toBeNull();
    expect(cameraAt(camera, 500)).toBeNull();
    expect(cameraAt(camera, 1000)).toBeNull();
    for (const t of [1500, 2500, 3500]) {
      const view = cameraAt(camera, t)!;
      expect(view.scale).toBeCloseTo(2, 6);
      expect(view.cx).toBeCloseTo(0.3, 6);
      expect(view.cy).toBeCloseTo(0.4, 6);
    }
    expect(cameraAt(camera, 4000)).toBeNull();
    expect(cameraAt(camera, 6000)).toBeNull();
    // Moving in between 1000 and 1500: zoomed some, not all the way.
    const mid = cameraAt(camera, 1250)!;
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(2);
    expect(everyKeyOnFrame(camera)).toBe(true);
  });

  it('samples a ramp at least 60 times a second, keys never going back in time', () => {
    const camera = compileCamera([zoom('z', 1000, 4000, { rampMs: 1000 })], 10_000)!;
    for (let i = 1; i < camera.atMs.length; i++) {
      expect(camera.atMs[i]).toBeGreaterThanOrEqual(camera.atMs[i - 1]);
      // Only a move needs the density; the hold is two keys a straight line apart. Times are kept
      // to the thousandth of a millisecond.
      if (camera.scale[i] !== camera.scale[i - 1]) expect(camera.atMs[i] - camera.atMs[i - 1]).toBeLessThanOrEqual(1000 / 60 + 0.002);
    }
  });

  it('squeezes the ramps into a window too short for them', () => {
    const [slot] = zoomSlots([zoom('z', 1000, 1800, { rampMs: 2000 })], 10_000);
    expect(slot.rampInMs).toBe(400);
    expect(slot.rampOutMs).toBe(400);
    const camera = compileCamera([zoom('z', 1000, 1800, { rampMs: 2000 })], 10_000)!;
    expect(cameraAt(camera, 1400)!.scale).toBeCloseTo(2, 6);
    expect(cameraAt(camera, 1800)).toBeNull();
  });

  it('cuts a zoom running past the end of the post at the end, ramps and all', () => {
    const [slot] = zoomSlots([zoom('z', 8000, 14_000, { rampMs: 500 })], 10_000);
    expect(slot).toMatchObject({ startMs: 8000, endMs: 10_000, rampInMs: 500, rampOutMs: 500 });
  });

  it('pans between zooms that touch, never passing through the whole frame', () => {
    const a = zoom('a', 1000, 3000, { cx: 0.25, cy: 0.25 });
    const b = zoom('b', 3000, 5000, { cx: 0.75, cy: 0.75, scale: 3 });
    const slots = zoomSlots([a, b], 10_000);
    expect(slots[0].chainedOut).toBe(true);
    expect(slots[1].chainedIn).toBe(true);
    const camera = compileCamera([a, b], 10_000)!;
    for (let t = 1500; t <= 4500; t += 25) {
      const view = cameraAt(camera, t);
      expect(view, `at ${t}`).not.toBeNull();
      expect(view!.scale).toBeGreaterThanOrEqual(2 - 1e-6);
    }
    expect(cameraAt(camera, 2500)!.cx).toBeCloseTo(0.25, 6);
    expect(cameraAt(camera, 3500)!.cx).toBeCloseTo(0.75, 6);
    expect(cameraAt(camera, 3500)!.scale).toBeCloseTo(3, 6);
    expect(everyKeyOnFrame(camera)).toBe(true);
  });

  it('pans across a gap shorter than the chain gap, and zooms out across a longer one', () => {
    const near = zoomSlots([zoom('a', 1000, 3000), zoom('b', 3000 + ZOOM_CHAIN_GAP_MS - 1, 6000)], 10_000);
    expect(near[0].chainedOut).toBe(true);
    const far = [zoom('a', 1000, 3000), zoom('b', 3000 + ZOOM_CHAIN_GAP_MS, 6000)];
    expect(zoomSlots(far, 10_000)[0].chainedOut).toBe(false);
    expect(cameraAt(compileCamera(far, 10_000)!, 3000 + ZOOM_CHAIN_GAP_MS / 2)).toBeNull();
  });

  it('makes a ramp of 0 a step: two keys at one time', () => {
    const camera = compileCamera([zoom('z', 1000, 3000, { rampMs: 0 })], 10_000)!;
    expect(camera.atMs).toEqual([1000, 1000, 3000, 3000]);
    expect(camera.scale).toEqual([1, 2, 2, 1]);
    expect(cameraAt(camera, 999)).toBeNull();
    expect(cameraAt(camera, 1000)!.scale).toBe(2);
    expect(cameraAt(camera, 2999)!.scale).toBe(2);
    expect(cameraAt(camera, 3000)).toBeNull();
  });

  it('keeps every key on the frame for an area in a corner, at every ease', () => {
    for (const ease of ['smooth', 'snappy', 'steady'] as const) {
      const camera = compileCamera([zoom('a', 0, 2000, { cx: 0, cy: 0, scale: 4, ease }), zoom('b', 2000, 4000, { cx: 1, cy: 1, scale: 1.1, ease })], 10_000)!;
      expect(everyKeyOnFrame(camera)).toBe(true);
      // Already what a parser would make of it: nothing to clamp beyond the six-decimal rounding.
      const parsed = normaliseCamera(camera)!;
      expect(parsed.atMs).toEqual(camera.atMs);
      parsed.cx.forEach((cx, i) => expect(Math.abs(cx - camera.cx[i])).toBeLessThan(1e-6));
      parsed.cy.forEach((cy, i) => expect(Math.abs(cy - camera.cy[i])).toBeLessThan(1e-6));
    }
  });

  it('stays under the key cap at the most zooms with the longest ramps', () => {
    const zooms = Array.from({ length: MAX_ZOOMS }, (_, i) => zoom(`z${i}`, i * 6000, i * 6000 + 4000, { rampMs: 2000 }));
    const camera = compileCamera(zooms, MAX_ZOOMS * 6000)!;
    expect(camera.atMs.length).toBeLessThanOrEqual(20_000);
  });
});

describe('the eases and the path', () => {
  it('start at 0 and land on 1', () => {
    for (const ease of ['smooth', 'snappy', 'steady'] as const) {
      expect(easeValue(ease, 0)).toBe(0);
      expect(easeValue(ease, 1)).toBeCloseTo(1, 12);
      expect(easeValue(ease, 0.5)).toBeGreaterThan(0);
      expect(easeValue(ease, 0.5)).toBeLessThan(1);
    }
    expect(easeValue('snappy', 0.25)).toBeGreaterThan(easeValue('smooth', 0.25));
  });

  it('zooms into the area with no sideways swing: the area fixed point stays put', () => {
    // From the whole frame into the area at the right edge, (0.75, 0.5) at 2x: its right edge is
    // x = 1, which the whole frame's is as well, so every view on the way keeps x = 1 at the right.
    for (const e of [0.1, 0.3, 0.6, 0.9]) {
      const view = viewBetween({ scale: 1, cx: 0.5, cy: 0.5 }, { scale: 2, cx: 0.75, cy: 0.5 }, e);
      expect(view.cx + 0.5 / view.scale).toBeCloseTo(1, 9);
      expect(view.cy).toBeCloseTo(0.5, 9);
    }
  });
});

describe('the wire', () => {
  const uris = new Map([['v', 'file:///v.mp4']]);
  const wire = (m: EditManifest): Promise<ComposeSpec> => toComposeSpec(m, uris, { jobId: 'j', batchId: 'b' }, {} as RasterContext);

  it("has no 'camera' key without a visible zoom", async () => {
    expect('camera' in (await wire(post()))).toBe(false);
    expect('camera' in (await wire(post([zoom('z', 20_000, 22_000)])))).toBe(false);
  });

  it('carries the compiled camera with one', async () => {
    const spec = await wire(post([zoom('z', 1000, 4000)]));
    expect(spec.camera).toEqual(compileCamera([zoom('z', 1000, 4000)], 10_000));
  });

  it('is not untouched with a visible zoom, and is with one parked past the end', () => {
    const durations = new Map([['v', 10_000]]);
    expect(isUntouched(post(), durations, 720 / 1280)).toBe(true);
    expect(isUntouched(post([zoom('z', 1000, 4000)]), durations, 720 / 1280)).toBe(false);
    expect(isUntouched(post([zoom('z', 20_000, 22_000)]), durations, 720 / 1280)).toBe(true);
  });
});

describe('normaliseManifest', () => {
  it('reads a version-9 manifest as having no zooms', () => {
    const m = normaliseManifest({ version: 9, clips: [defaultClipEdit('v', 5000)] });
    expect(m.version).toBe(MANIFEST_VERSION);
    // At least the version zooms arrived in; later keys (layer animation, 11) bump it again.
    expect(MANIFEST_VERSION).toBeGreaterThanOrEqual(10);
    expect(m.zooms).toEqual([]);
  });

  it('clamps, sorts, fixes ids and resolves overlaps', () => {
    const m = normaliseManifest({
      zooms: [
        { id: 'b', startMs: 5000, endMs: 8000, cx: 0.95, cy: 0.5, scale: 2, rampMs: 90_000, ease: 'wobbly' },
        { id: 'a', startMs: 1000, endMs: 5500, cx: 0.5, cy: 0.5, scale: 99, rampMs: -5, ease: 'steady' },
        { id: 'a', startMs: 9000, endMs: 9150, cx: 0.5, cy: 0.5, scale: 2, rampMs: 0, ease: 'smooth' },
        { id: 'x', startMs: 'soon', endMs: 3 },
        null,
      ],
    });
    expect(m.zooms.map(z => z.id)).toEqual(['a', 'b']);
    const [a, b] = m.zooms;
    expect(a).toMatchObject({ startMs: 1000, endMs: 5500, scale: 4, rampMs: 0, ease: 'steady' });
    // Started where the earlier one ends; the centre slid back on the frame at 2x; ramp held; ease defaulted.
    expect(b).toMatchObject({ startMs: 5500, endMs: 8000, cx: 0.75, rampMs: MAX_STORED_ZOOM_RAMP_MS, ease: 'smooth' });
    // Neither has a ramp out or a chain of its own, and neither gets an empty key for one.
    expect('rampOutMs' in a || 'chain' in a || 'rampOutMs' in b || 'chain' in b).toBe(false);
  });

  it('keeps a ramp out and a chain kept apart, and holds them to what they can be', () => {
    const m = normaliseManifest({
      zooms: [
        { id: 'a', startMs: 1000, endMs: 5000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 4000, rampOutMs: 0, ease: 'steady', chain: false },
        { id: 'b', startMs: 5000, endMs: 8000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 0, rampOutMs: 90_000.4, ease: 'steady', chain: true },
        { id: 'c', startMs: 8000, endMs: 9000, cx: 0.5, cy: 0.5, scale: 2, rampMs: 300, rampOutMs: 'soon', ease: 'steady', chain: 'no' },
      ],
    });
    const [a, b, c] = m.zooms;
    // Beyond the slider's two seconds: a push-in runs the whole of its window.
    expect(a).toMatchObject({ rampMs: 4000, rampOutMs: 0, chain: false });
    expect(b.rampOutMs).toBe(MAX_STORED_ZOOM_RAMP_MS);
    // `true` is the default and is not stored; anything that is not a number or `false` is dropped.
    expect('chain' in b).toBe(false);
    expect('rampOutMs' in c || 'chain' in c).toBe(false);
    expect(normaliseManifest(JSON.parse(JSON.stringify(m))).zooms).toEqual(m.zooms);
  });

  it("keeps a template's gentle push under the editor's own smallest zoom", () => {
    const m = normaliseManifest({
      zooms: [
        { id: 'ken', startMs: 0, endMs: 1000, cx: 0.5, cy: 0.5, scale: 1.04, rampMs: 1000, rampOutMs: 0, ease: 'steady', chain: false },
        { id: 'dust', startMs: 1000, endMs: 2000, cx: 0.5, cy: 0.5, scale: 1.001, rampMs: 1000, ease: 'steady' },
      ],
    });
    // A Ken Burns on a one-beat photo stays the drift it was written as, not the editor's 1.1 lurch.
    expect(m.zooms[0].scale).toBe(1.04);
    expect(MIN_ZOOM_SCALE).toBeGreaterThan(1.04);
    // Below the stored floor it is held there rather than becoming a zoom that shows nothing.
    expect(m.zooms[1].scale).toBe(MIN_STORED_ZOOM_SCALE);
  });
});

describe('two ramps', () => {
  it('runs a different ramp out from the ramp in', () => {
    const z = zoom('z', 1000, 4000, { rampMs: 1000, rampOutMs: 300 });
    const [slot] = zoomSlots([z], 10_000);
    expect(slot).toMatchObject({ rampInMs: 1000, rampOutMs: 300 });
    const camera = compileCamera([z], 10_000)!;
    expect(cameraAt(camera, 1000)).toBeNull();
    const moving = cameraAt(camera, 1500)!.scale;
    expect(moving).toBeGreaterThan(1);
    expect(moving).toBeLessThan(2);
    // The hold runs from the end of the long ramp in to the start of the short ramp out.
    for (const t of [2000, 3000, 3700]) expect(cameraAt(camera, t)!.scale).toBeCloseTo(2, 6);
    const leaving = cameraAt(camera, 3850)!.scale;
    expect(leaving).toBeGreaterThan(1);
    expect(leaving).toBeLessThan(2);
    expect(cameraAt(camera, 4000)).toBeNull();
    expect(everyKeyOnFrame(camera)).toBe(true);
  });

  it('squeezes the two in proportion when they do not fit, and two equal ones exactly as before', () => {
    const [uneven] = zoomSlots([zoom('z', 1000, 2000, { rampMs: 1500, rampOutMs: 500 })], 10_000);
    expect(uneven.rampInMs).toBe(750);
    expect(uneven.rampOutMs).toBe(250);
    // A push-in asking for more than its window keeps all of it, where halving would stop it half way.
    const [push] = zoomSlots([zoom('z', 1000, 2000, { rampMs: 5000, rampOutMs: 0 })], 10_000);
    expect(push).toMatchObject({ rampInMs: 1000, rampOutMs: 0 });
    const [even] = zoomSlots([zoom('z', 1000, 1800, { rampMs: 2000, rampOutMs: 2000 })], 10_000);
    expect(even).toMatchObject({ rampInMs: 400, rampOutMs: 400 });
    // An absent ramp out is the ramp in, so a zoom from before either existed plays as it did.
    expect(zoomSlots([zoom('z', 1000, 1800, { rampMs: 2000 })], 10_000)[0]).toMatchObject({ rampInMs: 400, rampOutMs: 400 });
  });

  it('holds a push-in to the cut, then steps to the whole frame', () => {
    const push = zoom('z', 1000, 4000, { rampMs: 3000, rampOutMs: 0, ease: 'steady' });
    const camera = compileCamera([push], 10_000)!;
    expect(cameraAt(camera, 1000)).toBeNull();
    // Moving the whole window, and always further in.
    let last = 1;
    for (let t = 1100; t < 4000; t += 100) {
      const scale = cameraAt(camera, t)!.scale;
      expect(scale, `at ${t}`).toBeGreaterThan(last);
      last = scale;
    }
    expect(cameraAt(camera, 3999)!.scale).toBeGreaterThan(1.99);
    // Two keys at the cut: the area, then the whole frame.
    const n = camera.atMs.length;
    expect(camera.atMs.slice(n - 2)).toEqual([4000, 4000]);
    expect(camera.scale.slice(n - 2)).toEqual([2, 1]);
    expect(cameraAt(camera, 4000)).toBeNull();
  });

  it('punches in on one beat: a short snappy ramp in, held, and a cut out at the end of the window', () => {
    // Half a beat at 100 BPM, a beat at 200: far under the editor's own shortest zoom, and kept.
    const punch = zoom('p', 2000, 2300, { cx: 0.5, cy: 0.5, scale: 1.3, rampMs: 90, rampOutMs: 0, ease: 'snappy' });
    const m = normaliseManifest({ clips: [defaultClipEdit('v', 10_000)], zooms: [punch, zoom('blip', 4000, 4150)] });
    expect(m.zooms.map(z => [z.id, z.startMs, z.endMs])).toEqual([['p', 2000, 2300]]);

    const [slot] = zoomSlots(m.zooms, 10_000);
    expect(slot).toMatchObject({ rampInMs: 90, rampOutMs: 0 });
    const camera = compileCamera(m.zooms, 10_000)!;
    expect(cameraAt(camera, 2000)).toBeNull();
    // Most of the way in at once, as a spring released does, and all the way by 90 ms.
    expect(cameraAt(camera, 2030)!.scale).toBeGreaterThan(1.15);
    for (const t of [2090, 2200, 2299]) expect(cameraAt(camera, t)!.scale).toBeCloseTo(1.3, 6);
    const n = camera.atMs.length;
    expect(camera.atMs.slice(n - 2)).toEqual([2300, 2300]);
    expect(camera.scale.slice(n - 2)).toEqual([1.3, 1]);
    expect(cameraAt(camera, 2300)).toBeNull();
  });

  it('starts a pull-out on its area and moves out for the whole window', () => {
    const pull = zoom('z', 1000, 4000, { rampMs: 0, rampOutMs: 3000, ease: 'steady' });
    const camera = compileCamera([pull], 10_000)!;
    expect(camera.atMs.slice(0, 2)).toEqual([1000, 1000]);
    expect(camera.scale.slice(0, 2)).toEqual([1, 2]);
    expect(cameraAt(camera, 999)).toBeNull();
    expect(cameraAt(camera, 1000)).toMatchObject({ scale: 2, cx: 0.3, cy: 0.4 });
    let last = 2;
    for (let t = 1100; t < 4000; t += 100) {
      const scale = cameraAt(camera, t)!.scale;
      expect(scale, `at ${t}`).toBeLessThan(last);
      last = scale;
    }
    expect(cameraAt(camera, 4000)).toBeNull();
  });
});

describe('zooms kept apart', () => {
  const a = (extra: Partial<EditZoom> = {}) => zoom('a', 1000, 3000, { cx: 0.25, cy: 0.25, ...extra });
  const b = (extra: Partial<EditZoom> = {}) => zoom('b', 3000, 5000, { cx: 0.75, cy: 0.75, ...extra });

  it('are never chained, whichever of the two says so', () => {
    for (const [first, second] of [
      [a({ chain: false }), b()],
      [a(), b({ chain: false })],
      [a({ chain: false }), b({ chain: false })],
    ]) {
      const slots = zoomSlots([first, second], 10_000);
      expect(slots[0].chainedOut).toBe(false);
      expect(slots[1].chainedIn).toBe(false);
    }
  });

  it('step straight from one area to the next where they touch with no ramps between them', () => {
    const camera = compileCamera([a({ rampOutMs: 0, chain: false }), b({ rampMs: 0, chain: false })], 10_000)!;
    // No pan: the first area to the very last moment, the second from the boundary on.
    for (const t of [2000, 2500, 2999]) expect(cameraAt(camera, t)).toMatchObject({ scale: 2, cx: 0.25, cy: 0.25 });
    for (const t of [3000, 3500, 4000]) expect(cameraAt(camera, t)).toMatchObject({ scale: 2, cx: 0.75, cy: 0.75 });
    expect(everyKeyOnFrame(camera)).toBe(true);
  });

  it('give each clip its own push-in rather than panning across the second', () => {
    const pushes = [a({ rampMs: 2000, rampOutMs: 0, chain: false }), b({ rampMs: 2000, rampOutMs: 0, chain: false })];
    const camera = compileCamera(pushes, 10_000)!;
    // The first push reaches its area at the cut, and the second starts again from the whole frame.
    expect(cameraAt(camera, 2999)!.cx).toBeCloseTo(0.25, 2);
    expect(cameraAt(camera, 3000)).toBeNull();
    // Half way through the second push its centre is on the straight line from the frame's middle
    // to its own area - nowhere near the first area a pan would have come from.
    const mid = cameraAt(camera, 4000)!;
    expect(mid.scale).toBeGreaterThan(1);
    expect(mid.scale).toBeLessThan(2);
    expect(mid.cx).toBeGreaterThan(0.5);
    expect(mid.cx).toBeCloseTo(mid.cy, 6);
    // Chained, the same two would have panned: the camera never back at the whole frame.
    const panned = compileCamera([a({ rampMs: 2000, rampOutMs: 0 }), b({ rampMs: 2000, rampOutMs: 0 })], 10_000)!;
    expect(cameraAt(panned, 3000)).not.toBeNull();
    expect(cameraAt(panned, 3000)!.cx).toBeCloseTo(0.25, 6);
  });

  it('climbs a stair of punches inside one shot, and keeps apart from the shots either side', () => {
    // A template's shot punched in three times on the beat: 'out' on the first step, open between,
    // 'in' on the last. The push-in before it and the one after it keep both sides.
    const zooms = [
      zoom('before', 0, 1000, { cx: 0.5, cy: 0.5, scale: 1.1, rampMs: 1000, rampOutMs: 0, ease: 'steady', chain: false }),
      zoom('step-1', 1000, 1500, { cx: 0.5, cy: 0.5, scale: 1.06, rampMs: 90, rampOutMs: 0, ease: 'snappy', chain: 'out' }),
      zoom('step-2', 1500, 2000, { cx: 0.5, cy: 0.5, scale: 1.12, rampMs: 90, rampOutMs: 0, ease: 'snappy' }),
      zoom('step-3', 2000, 2500, { cx: 0.5, cy: 0.5, scale: 1.18, rampMs: 90, rampOutMs: 0, ease: 'snappy', chain: 'in' }),
      zoom('after', 2500, 3500, { cx: 0.5, cy: 0.5, scale: 1.1, rampMs: 1000, rampOutMs: 0, ease: 'steady' }),
    ];
    expect(zoomSlots(zooms, 10_000).map(s => [s.id, s.chainedIn, s.chainedOut])).toEqual([
      ['before', false, false],
      ['step-1', false, true],
      ['step-2', true, true],
      ['step-3', true, false],
      // Open on both sides, and still stepped: the stair's last step keeps its after side.
      ['after', false, false],
    ]);

    const camera = compileCamera(zooms, 10_000)!;
    // Every step grows from the one before it: the camera never falls back to the whole frame
    // inside the shot, and each step has landed within its 90 ms.
    for (let t = 1100; t < 2500; t += 20) expect(cameraAt(camera, t), `at ${t}`).not.toBeNull();
    for (let t = 1500; t < 2500; t += 10) expect(cameraAt(camera, t)!.scale, `at ${t}`).toBeGreaterThanOrEqual(1.06 - 1e-6);
    expect(cameraAt(camera, 1600)!.scale).toBeCloseTo(1.12, 6);
    expect(cameraAt(camera, 2100)!.scale).toBeCloseTo(1.18, 6);
    // Both cuts step: the push before holds to its end, and the push after starts from the whole frame.
    expect(cameraAt(camera, 999)!.scale).toBeCloseTo(1.1, 2);
    expect(cameraAt(camera, 2500)).toBeNull();
    expect(normaliseManifest(post(zooms)).zooms.map(z => z.chain)).toEqual([false, 'out', undefined, 'in', undefined]);
  });

  it('step at both cuts around a drift that pans inside its own clip', () => {
    // A template's three clips: a push-in, a drift made of two chained zooms, and another push-in.
    // The clips either side are kept apart, the drift's two halves are not.
    const zooms = [
      zoom('push-1', 0, 2000, { cx: 0.25, cy: 0.25, rampMs: 2000, rampOutMs: 0, ease: 'steady', chain: false }),
      zoom('drift-a', 2000, 3000, { cx: 0.4, cy: 0.5, scale: 1.5, rampMs: 0, rampOutMs: 0, ease: 'steady', chain: true }),
      zoom('drift-b', 3000, 5000, { cx: 0.6, cy: 0.5, scale: 1.5, rampMs: 2000, rampOutMs: 0, ease: 'steady', chain: true }),
      zoom('push-2', 5000, 7000, { cx: 0.75, cy: 0.75, rampMs: 2000, rampOutMs: 0, ease: 'steady', chain: false }),
    ];
    const slots = zoomSlots(zooms, 10_000);
    expect(slots.map(s => [s.id, s.chainedIn, s.chainedOut])).toEqual([
      ['push-1', false, false],
      ['drift-a', false, true],
      ['drift-b', true, false],
      ['push-2', false, false],
    ]);

    const camera = compileCamera(zooms, 10_000)!;
    // The first cut: the push-in's area to its last moment, then straight onto the drift's.
    expect(cameraAt(camera, 1999)!.cx).toBeCloseTo(0.25, 2);
    expect(cameraAt(camera, 2000)).toMatchObject({ scale: 1.5, cx: 0.4, cy: 0.5 });
    expect(cameraAt(camera, 2999)).toMatchObject({ scale: 1.5, cx: 0.4, cy: 0.5 });
    // The drift: a pan at one level, never the whole frame, from the first half's area to the second's.
    for (let t = 3000; t < 5000; t += 50) {
      const view = cameraAt(camera, t)!;
      expect(view, `at ${t}`).not.toBeNull();
      expect(view.scale).toBeCloseTo(1.5, 6);
      expect(view.cx).toBeGreaterThanOrEqual(0.4 - 1e-6);
      expect(view.cx).toBeLessThanOrEqual(0.6 + 1e-6);
    }
    expect(cameraAt(camera, 4000)!.cx).toBeCloseTo(0.5, 6);
    // The second cut: the drift's end, then the whole frame, where the next push-in starts from.
    expect(cameraAt(camera, 4999)!.cx).toBeCloseTo(0.6, 3);
    expect(cameraAt(camera, 5000)).toBeNull();
    const pushing = cameraAt(camera, 6000)!;
    expect(pushing.scale).toBeGreaterThan(1);
    expect(pushing.scale).toBeLessThan(2);
    expect(pushing.cx).toBeGreaterThan(0.5);
    expect(pushing.cx).toBeCloseTo(pushing.cy, 6);
    expect(everyKeyOnFrame(camera)).toBe(true);
    expect(normaliseCamera(camera)).not.toBeNull();
  });
});

describe('the ramp the sheet sets', () => {
  it('is the one ramp of a zoom with one', () => {
    const one = zoom('z', 0, 3000, { rampMs: 700 });
    expect(zoomRampMs(one)).toBe(700);
    expect(zoomRampPatch(one, 1200)).toEqual({ rampMs: 1200 });
  });

  it('scales both of a zoom with two, keeping its shape', () => {
    const push = zoom('z', 0, 4000, { rampMs: 4000, rampOutMs: 0 });
    expect(zoomRampMs(push)).toBe(4000);
    expect(zoomRampPatch(push, 1000)).toEqual({ rampMs: 1000, rampOutMs: 0 });
    const pull = zoom('z', 0, 4000, { rampMs: 0, rampOutMs: 3000 });
    expect(zoomRampMs(pull)).toBe(3000);
    expect(zoomRampPatch(pull, 1500)).toEqual({ rampMs: 0, rampOutMs: 1500 });
    expect(zoomRampPatch(zoom('z', 0, 4000, { rampMs: 500, rampOutMs: 1000 }), 700)).toEqual({ rampMs: 350, rampOutMs: 700 });
    // Nothing to keep the shape of: both take the value.
    expect(zoomRampPatch(zoom('z', 0, 4000, { rampMs: 0, rampOutMs: 0 }), 600)).toEqual({ rampMs: 600, rampOutMs: 600 });
  });

  it('lands through updateZoom, and a chain can be set and put back', () => {
    const m = post([zoom('a', 1000, 5000, { rampMs: 4000, rampOutMs: 0 })]);
    const quicker = updateZoom(m, 'a', zoomRampPatch(m.zooms[0], 800));
    expect(quicker.zooms[0]).toMatchObject({ rampMs: 800, rampOutMs: 0 });
    const apart = updateZoom(m, 'a', { chain: false });
    expect(apart.zooms[0].chain).toBe(false);
    expect(updateZoom(apart, 'a', { chain: false })).toBe(apart);
    expect('chain' in updateZoom(apart, 'a', { chain: true }).zooms[0]).toBe(false);
  });
});

describe('the zoom ops', () => {
  it('adds a zoom shortened to the room before the next one, and refuses without room', () => {
    const m = post([zoom('b', 5000, 7000)]);
    const added = addZoom(m, zoom('a', 3000, 6000), 10_000)!;
    expect(added.zooms.map(z => [z.id, z.startMs, z.endMs])).toEqual([
      ['a', 3000, 5000],
      ['b', 5000, 7000],
    ]);
    expect(addZoom(m, zoom('c', 5500, 8000), 10_000)).toBeNull();
    expect(addZoom(m, zoom('c', 4700, 8000), 10_000)).toBeNull();
    expect(addZoom(m, zoom('c', 9800, 12_000), 10_000)).toBeNull();
  });

  it('refuses at the cap', () => {
    const zooms = Array.from({ length: MAX_ZOOMS }, (_, i) => zoom(`z${i}`, i * 600, i * 600 + 500));
    expect(addZoom(post(zooms, 60_000), zoom('more', 59_000, 59_900), 60_000)).toBeNull();
  });

  it('updates the look, the same manifest when nothing changed', () => {
    const m = post([zoom('a', 1000, 3000)]);
    expect(updateZoom(m, 'a', { scale: 2 })).toBe(m);
    expect(updateZoom(m, 'nope', { scale: 3 })).toBe(m);
    const next = updateZoom(m, 'a', { scale: 10, cx: 0.99 });
    expect(next.zooms[0]).toMatchObject({ scale: 4, cx: 0.875, startMs: 1000, endMs: 3000 });
    // A centre held at an edge whose bound is not a four-decimal number is still a fixed point, so
    // setting the same thing again is no change (and no undo step).
    const edge = updateZoom(m, 'a', { scale: 3, cx: 0.99, cy: 0.001 });
    expect(edge.zooms[0]).toMatchObject({ cx: 0.8333, cy: 0.1667 });
    expect(updateZoom(edge, 'a', { scale: 3, cx: 0.99, cy: 0.001 })).toBe(edge);
    expect(updateZoom(edge, 'a', { cx: edge.zooms[0].cx })).toBe(edge);
  });

  it('stops a window at its neighbours and keeps its length when dragged whole', () => {
    const m = post([zoom('a', 1000, 2000), zoom('b', 3000, 4000), zoom('c', 6000, 7000)]);
    expect(setZoomWindow(m, 'b', 500, 4000, 10_000).zooms[1]).toMatchObject({ startMs: 2000, endMs: 4000 });
    expect(setZoomWindow(m, 'b', 3000, 9000, 10_000).zooms[1]).toMatchObject({ startMs: 3000, endMs: 6000 });
    expect(setZoomWindow(m, 'b', 5500, 6500, 10_000).zooms[1]).toMatchObject({ startMs: 5000, endMs: 6000 });
    expect(setZoomWindow(m, 'b', 3000, 3100, 10_000).zooms[1]).toMatchObject({ startMs: 3000, endMs: 3000 + MIN_ZOOM_MS });
    expect(setZoomWindow(m, 'b', 3000, 4000, 10_000)).toBe(m);
  });

  it('duplicates straight after the original, or not at all', () => {
    const m = post([zoom('a', 1000, 3000), zoom('b', 4000, 6000)]);
    const next = duplicateZoom(m, 'a', 'a2', 10_000)!;
    expect(next.zooms.map(z => [z.id, z.startMs, z.endMs])).toEqual([
      ['a', 1000, 3000],
      ['a2', 3000, 4000],
      ['b', 4000, 6000],
    ]);
    expect(duplicateZoom(post([zoom('a', 1000, 3000), zoom('b', 3200, 6000)]), 'a', 'a2', 10_000)).toBeNull();
  });

  it('deletes', () => {
    const m = post([zoom('a', 1000, 3000)]);
    expect(deleteZoom(m, 'a').zooms).toEqual([]);
    expect(deleteZoom(m, 'nope')).toBe(m);
  });

  it('leaves zooms alone for clip ops, on the output timeline like overlays', () => {
    const m = post([zoom('a', 1000, 3000)]);
    expect(trimClip(m, m.clips[0].id, 500, 8000, 10_000).zooms).toBe(m.zooms);
  });

  it('cuts zooms with the post', () => {
    const m = { ...post([zoom('a', 1000, 3000), zoom('b', 4000, 6000), zoom('c', 7000, 9000)]), clips: [defaultClipEdit('v', 10_000)] };
    const cut = cutPostTo(m, 5000);
    expect(cut.zooms.map(z => [z.id, z.startMs, z.endMs])).toEqual([
      ['a', 1000, 3000],
      ['b', 4000, 5000],
    ]);
    // Less than MIN_ZOOM_MS left of b: dropped.
    expect(cutPostTo(m, 4200).zooms.map(z => z.id)).toEqual(['a']);
    // A punch shorter than that to begin with is kept whole by a cut that never reached it.
    const punched = { ...m, zooms: [zoom('p', 1000, 1300, { rampMs: 90, rampOutMs: 0 }), ...m.zooms.slice(1)] };
    expect(cutPostTo(punched, 5000).zooms.map(z => [z.id, z.startMs, z.endMs])).toEqual([
      ['p', 1000, 1300],
      ['b', 4000, 5000],
    ]);
  });
});
