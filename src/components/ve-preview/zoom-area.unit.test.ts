import { describe, expect, it } from 'vitest';

import { cameraAt } from '../../editor/camera';
import { MAX_ZOOM_SCALE, MIN_ZOOM_SCALE } from '../../editor/edit-manifest';
import { moveZoomArea, pinchZoomArea, resizeZoomArea, zoomArea, zoomCornerAt, zoomLevelLabel } from './zoom-area';

/**
 * The zoom area editor's arithmetic, on a 400x800 frame (a 9:16-ish stage). The box is only a way of
 * drawing (cx, cy, scale), so every case here is checked against the zoom it produces - and, where it
 * matters, against the camera that zoom compiles to: the area is exactly what fills the screen.
 */

const W = 400;
const H = 800;

describe('the zoom area', () => {
  it('is 1/scale of the frame each way, centred on the zoom', () => {
    expect(zoomArea({ cx: 0.5, cy: 0.5, scale: 2 })).toEqual({ x: 0.25, y: 0.25, w: 0.5, h: 0.5 });
    const a = zoomArea({ cx: 0.3, cy: 0.6, scale: 4 });
    expect(a.x).toBeCloseTo(0.175, 9);
    expect(a.y).toBeCloseTo(0.475, 9);
    expect(a.w).toBeCloseTo(0.25, 9);
    expect(a.h).toBeCloseTo(0.25, 9);
  });

  it('is exactly the part of the frame the camera brings to fill the screen', () => {
    // viewPoint maps the area's corners to the frame's: p' = 0.5 + (p - c) * s.
    const zoom = { cx: 0.3, cy: 0.7, scale: 2.5 };
    const view = cameraAt({ atMs: [0], scale: [zoom.scale], cx: [zoom.cx], cy: [zoom.cy] }, 0)!;
    const a = zoomArea(zoom);
    expect(0.5 + (a.x - view.cx) * view.scale).toBeCloseTo(0, 9);
    expect(0.5 + (a.y + a.h - view.cy) * view.scale).toBeCloseTo(1, 9);
  });

  it('follows a body drag and stops at the frame edge', () => {
    const moved = moveZoomArea({ cx: 0.5, cy: 0.5, scale: 2 }, 0.1, -0.05);
    expect(moved.cx).toBeCloseTo(0.6, 9);
    expect(moved.cy).toBeCloseTo(0.45, 9);
    expect(moved.scale).toBe(2);
    // Dragged far past the right and top edges: held so the box stays inside.
    const held = moveZoomArea({ cx: 0.5, cy: 0.5, scale: 2 }, 5, -5);
    expect(held).toEqual({ cx: 0.75, cy: 0.25, scale: 2 });
  });

  it('shrinks the box - more zoom - as the fingers pinch in, and grows it as they spread', () => {
    expect(pinchZoomArea({ cx: 0.5, cy: 0.5, scale: 2 }, 0.5).scale).toBe(4);
    expect(pinchZoomArea({ cx: 0.5, cy: 0.5, scale: 2 }, 1.25).scale).toBeCloseTo(1.6, 9);
    // Held to the zoom's own range, not the camera's 1..8.
    expect(pinchZoomArea({ cx: 0.5, cy: 0.5, scale: 2 }, 0.1).scale).toBe(MAX_ZOOM_SCALE);
    expect(pinchZoomArea({ cx: 0.5, cy: 0.5, scale: 2 }, 10).scale).toBe(MIN_ZOOM_SCALE);
  });

  it('pushes a centre back in when a spread makes the box too big for where it was', () => {
    const grown = pinchZoomArea({ cx: 0.85, cy: 0.15, scale: 4 }, 2);
    expect(grown.scale).toBe(2);
    expect(grown).toEqual({ cx: 0.75, cy: 0.25, scale: 2 });
  });

  it('resizes by a corner with the opposite corner held still', () => {
    const start = { cx: 0.5, cy: 0.5, scale: 2 }; // box 0.25..0.75 each way
    // The bottom-right corner dragged in by 0.1 both ways: side 0.5 -> 0.4, top-left stays at 0.25.
    const smaller = resizeZoomArea(start, 'bottomRight', -0.1, -0.1);
    const a = zoomArea(smaller);
    expect(a.x).toBeCloseTo(0.25, 9);
    expect(a.y).toBeCloseTo(0.25, 9);
    expect(a.w).toBeCloseTo(0.4, 9);
    expect(smaller.scale).toBeCloseTo(2.5, 9);
    // The top-left corner dragged out: the bottom-right corner (0.75, 0.75) is the anchor.
    const bigger = zoomArea(resizeZoomArea(start, 'topLeft', -0.1, -0.1));
    expect(bigger.x + bigger.w).toBeCloseTo(0.75, 9);
    expect(bigger.y + bigger.h).toBeCloseTo(0.75, 9);
    expect(bigger.w).toBeCloseTo(0.6, 9);
  });

  it('stops a corner resize at the frame edge and at the zoom range, still anchored', () => {
    const start = { cx: 0.5, cy: 0.5, scale: 2 };
    // Out past the bottom-right edge: the room beyond the anchor (0.75) caps the side.
    const edge = zoomArea(resizeZoomArea(start, 'bottomRight', 1, 1));
    expect(edge.x).toBeCloseTo(0.25, 9);
    expect(edge.w).toBeCloseTo(0.75, 9);
    // Collapsed: never smaller than MAX_ZOOM_SCALE allows.
    const tiny = resizeZoomArea(start, 'bottomRight', -1, -1);
    expect(tiny.scale).toBeCloseTo(MAX_ZOOM_SCALE, 9);
    expect(zoomArea(tiny).x).toBeCloseTo(0.25, 9);
    // From the middle, a big spread is capped by MIN_ZOOM_SCALE before the frame edge.
    const wide = resizeZoomArea({ cx: 0.5, cy: 0.5, scale: 4 }, 'topLeft', -1, -1);
    expect(wide.scale).toBeGreaterThanOrEqual(MIN_ZOOM_SCALE);
  });

  it("finds a corner within a finger's reach, inside or out, and the body elsewhere", () => {
    const zoom = { cx: 0.5, cy: 0.5, scale: 2 }; // box 100..300 x 200..600 px
    expect(zoomCornerAt(zoom, 100, 200, W, H)).toBe('topLeft');
    expect(zoomCornerAt(zoom, 310, 190, W, H)).toBe('topRight');
    expect(zoomCornerAt(zoom, 90, 610, W, H)).toBe('bottomLeft');
    expect(zoomCornerAt(zoom, 300, 600, W, H)).toBe('bottomRight');
    expect(zoomCornerAt(zoom, 200, 400, W, H)).toBeNull();
    expect(zoomCornerAt(zoom, 200, 200, W, H)).toBeNull();
    expect(zoomCornerAt(zoom, 100, 200, 0, H)).toBeNull();
  });

  it('keeps a body to drag on a small box: the corner bands shrink to a third of its side', () => {
    const zoom = { cx: 0.5, cy: 0.5, scale: 4 }; // 205 px stage: box ~51 px wide
    const w = 205;
    const h = 364;
    const left = (0.5 - 0.125) * w;
    const top = (0.5 - 0.125) * h;
    expect(zoomCornerAt(zoom, left + 5, top + 5, w, h)).toBe('topLeft');
    expect(zoomCornerAt(zoom, w / 2, h / 2, w, h)).toBeNull();
  });

  it('labels the level with one decimal', () => {
    expect(zoomLevelLabel(2)).toBe('2.0x');
    expect(zoomLevelLabel(1.26)).toBe('1.3x');
  });
});
