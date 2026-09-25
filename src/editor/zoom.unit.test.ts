import { describe, expect, it } from 'vitest';

import type { ComposeCamera, ComposeSpec } from '../video-composer/definitions';
import { cameraAt, normaliseCamera } from './camera';
import { toComposeSpec } from './compose';
import {
  MANIFEST_VERSION,
  MAX_ZOOMS,
  MIN_ZOOM_MS,
  ZOOM_CHAIN_GAP_MS,
  defaultClipEdit,
  emptyManifest,
  isUntouched,
  normaliseManifest,
  type EditManifest,
  type EditZoom,
} from './edit-manifest';
import { addZoom, cutPostTo, deleteZoom, duplicateZoom, setZoomWindow, trimClip, updateZoom } from './edit-ops';
import type { RasterContext } from './raster-context';
import { compileCamera, easeValue, viewBetween, zoomSlots } from './zoom';

/*
 * A zoom is compiled ONCE, here, into the camera track every engine only interpolates. So these pin
 * the moves themselves - the hold is the area, a ramp squeezes into a short window, touching zooms pan
 * without passing through the whole frame, every key stays on the frame - and the model rules around
 * them: the absent wire key, the migration, and the one-lane ops.
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
    return (
      camera.scale[i] >= 1 - eps &&
      camera.cx[i] >= half - eps &&
      camera.cx[i] <= 1 - half + eps &&
      camera.cy[i] >= half - eps &&
      camera.cy[i] <= 1 - half + eps
    );
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
      const camera = compileCamera(
        [zoom('a', 0, 2000, { cx: 0, cy: 0, scale: 4, ease }), zoom('b', 2000, 4000, { cx: 1, cy: 1, scale: 1.1, ease })],
        10_000,
      )!;
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
    expect(MANIFEST_VERSION).toBe(10);
    expect(m.zooms).toEqual([]);
  });

  it('clamps, sorts, fixes ids and resolves overlaps', () => {
    const m = normaliseManifest({
      zooms: [
        { id: 'b', startMs: 5000, endMs: 8000, cx: 0.95, cy: 0.5, scale: 2, rampMs: 9000, ease: 'wobbly' },
        { id: 'a', startMs: 1000, endMs: 5500, cx: 0.5, cy: 0.5, scale: 99, rampMs: -5, ease: 'steady' },
        { id: 'a', startMs: 9000, endMs: 9200, cx: 0.5, cy: 0.5, scale: 2, rampMs: 0, ease: 'smooth' },
        { id: 'x', startMs: 'soon', endMs: 3 },
        null,
      ],
    });
    expect(m.zooms.map((z) => z.id)).toEqual(['a', 'b']);
    const [a, b] = m.zooms;
    expect(a).toMatchObject({ startMs: 1000, endMs: 5500, scale: 4, rampMs: 0, ease: 'steady' });
    // Started where the earlier one ends; the centre slid back on the frame at 2x; ramp held; ease defaulted.
    expect(b).toMatchObject({ startMs: 5500, endMs: 8000, cx: 0.75, rampMs: 2000, ease: 'smooth' });
  });
});

describe('the zoom ops', () => {
  it('adds a zoom shortened to the room before the next one, and refuses without room', () => {
    const m = post([zoom('b', 5000, 7000)]);
    const added = addZoom(m, zoom('a', 3000, 6000), 10_000)!;
    expect(added.zooms.map((z) => [z.id, z.startMs, z.endMs])).toEqual([
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
    expect(next.zooms.map((z) => [z.id, z.startMs, z.endMs])).toEqual([
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
    expect(cut.zooms.map((z) => [z.id, z.startMs, z.endMs])).toEqual([
      ['a', 1000, 3000],
      ['b', 4000, 5000],
    ]);
    // Less than MIN_ZOOM_MS left of b: dropped.
    expect(cutPostTo(m, 4200).zooms.map((z) => z.id)).toEqual(['a']);
  });
});
