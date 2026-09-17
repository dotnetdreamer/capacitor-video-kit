import { describe, expect, it } from 'vitest';

import { handleSpot, hitsLayer, pressBelongsToLayer, type LayerBox } from './overlay-gestures';

/**
 * The frame the tests measure on, and a layer centred in it. A 40px-wide square on a 400px frame is
 * the case the handles used to steal: their finger targets are 44px across, wider than the artwork.
 */
const FRAME_W = 400;
const FRAME_H = 800;
const CX = FRAME_W / 2;
const CY = FRAME_H / 2;

const upright = { cx: 0.5, cy: 0.5, rotationDeg: 0 };
const small: LayerBox = { widthFrac: 0.1, aspect: 1 };
const large: LayerBox = { widthFrac: 0.5, aspect: 1 };

/** A point given as an offset from the layer's centre, in frame pixels. */
function at(dx: number, dy: number): [number, number] {
  return [CX + dx, CY + dy];
}

describe('hitsLayer', () => {
  it('grabs a layer smaller than a fingertip from a fingertip around it', () => {
    // The sticker is 40px; the hit box never shrinks below 44.
    expect(hitsLayer(...at(21, 21), FRAME_W, FRAME_H, upright, small)).toBe(true);
    expect(hitsLayer(...at(23, 0), FRAME_W, FRAME_H, upright, small)).toBe(false);
  });

  it('turns the point back by the rotation of the layer', () => {
    const turned = { cx: 0.5, cy: 0.5, rotationDeg: 90 };
    const tall: LayerBox = { widthFrac: 0.1, aspect: 0.25 };
    // 40 wide and 160 tall upright, so 160 wide and 40 tall once it is on its side.
    expect(hitsLayer(...at(70, 0), FRAME_W, FRAME_H, turned, tall)).toBe(true);
    expect(hitsLayer(...at(70, 0), FRAME_W, FRAME_H, upright, tall)).toBe(false);
  });
});

describe('pressBelongsToLayer', () => {
  it('gives the middle of a small layer to the layer, not to the handles over it', () => {
    for (const handle of ['delete', 'edit', 'transform'] as const) {
      expect(pressBelongsToLayer(...at(0, 0), FRAME_W, FRAME_H, upright, small, handle)).toBe(true);
    }
  });

  it('gives each handle the circle it draws, even on a small layer', () => {
    // Every handle's centre sits 4px outside its corner of the 40px box.
    expect(pressBelongsToLayer(...at(-24, -24), FRAME_W, FRAME_H, upright, small, 'delete')).toBe(false);
    expect(pressBelongsToLayer(...at(24, -24), FRAME_W, FRAME_H, upright, small, 'edit')).toBe(false);
    expect(pressBelongsToLayer(...at(24, 24), FRAME_W, FRAME_H, upright, small, 'transform')).toBe(false);
    // And the rest of the drawn circle, not only its middle.
    expect(pressBelongsToLayer(...at(-30, -30), FRAME_W, FRAME_H, upright, small, 'delete')).toBe(false);
  });

  it('keeps the enlarged target for a press beside the layer', () => {
    // Outside the box and outside the drawn circle, but still on the handle's finger target.
    expect(pressBelongsToLayer(...at(-120, -100), FRAME_W, FRAME_H, upright, large, 'delete')).toBe(false);
  });

  it('leaves a big layer its own corners', () => {
    // 20px inside the corner of a 200px layer: the finger target reached this far in, and a tap
    // meant for the artwork deleted the layer.
    expect(pressBelongsToLayer(...at(-80, -80), FRAME_W, FRAME_H, upright, large, 'delete')).toBe(true);
    expect(pressBelongsToLayer(...at(-104, -104), FRAME_W, FRAME_H, upright, large, 'delete')).toBe(false);
  });

  it('turns with the layer', () => {
    const upsideDown = { cx: 0.5, cy: 0.5, rotationDeg: 180 };
    // The same point is artwork while the sticker is upright and the delete circle once it is turned.
    expect(pressBelongsToLayer(...at(17, 17), FRAME_W, FRAME_H, upright, small, 'delete')).toBe(true);
    expect(pressBelongsToLayer(...at(17, 17), FRAME_W, FRAME_H, upsideDown, small, 'delete')).toBe(false);
  });

  it('follows a handle that was held inside the stage', () => {
    // A sticker at the bottom of the frame: its corner handle's home is off the stage, so it slid up.
    const low = { cx: 0.5, cy: 0.97, rotationDeg: 0 };
    const spot = handleSpot('transform', low, small, FRAME_W, FRAME_H);
    expect(spot.y).toBe(FRAME_H - 22);
    expect(pressBelongsToLayer(spot.x, spot.y, FRAME_W, FRAME_H, low, small, 'transform')).toBe(false);
    // And the artwork it slid over is still the layer's, apart from the circle itself.
    expect(pressBelongsToLayer(CX + 18, low.cy * FRAME_H + 18, FRAME_W, FRAME_H, low, small, 'transform')).toBe(true);
  });
});

describe('handleSpot', () => {
  it('leaves a handle alone while its corner is on the stage', () => {
    const spot = handleSpot('delete', upright, small, FRAME_W, FRAME_H);
    expect(spot.x).toBe(CX - 24);
    expect(spot.y).toBe(CY - 24);
    expect(spot.shiftX).toBe(0);
    expect(spot.shiftY).toBe(0);
  });

  it('holds every handle of an oversized layer inside the stage', () => {
    // Wider and taller than the frame: all three corners are off it.
    const huge: LayerBox = { widthFrac: 1.4, aspect: 9 / 16 };
    for (const handle of ['delete', 'edit', 'transform'] as const) {
      const spot = handleSpot(handle, upright, huge, FRAME_W, FRAME_H);
      expect(spot.x).toBeGreaterThanOrEqual(12);
      expect(spot.x).toBeLessThanOrEqual(FRAME_W - 12);
      expect(spot.y).toBeGreaterThanOrEqual(22);
      expect(spot.y).toBeLessThanOrEqual(FRAME_H - 22);
    }
  });

  it('lets the chrome hang above and below the frame, but not beside it', () => {
    // The preview is taller than the frame and the bands above and below it are empty, so a layer at
    // the frame's edge keeps its handles out there. Sideways is the shell's Back and Next circles.
    const tall = { left: 0, top: -60, right: FRAME_W, bottom: FRAME_H + 60 };
    const edge = { cx: 0.5, cy: 0.99, rotationDeg: 0 };
    expect(handleSpot('transform', edge, small, FRAME_W, FRAME_H, tall).y).toBe(0.99 * FRAME_H + 24);
    expect(handleSpot('edit', { ...edge, cx: 0.99 }, small, FRAME_W, FRAME_H, tall).x).toBe(FRAME_W - 12);
  });

  it('measures the shift in the layer’s own turned frame', () => {
    // On its side, so a handle pushed DOWN the screen has moved along the layer's own -x.
    const turned = { cx: 0.5, cy: 0.99, rotationDeg: 90 };
    const spot = handleSpot('transform', turned, small, FRAME_W, FRAME_H);
    expect(spot.y).toBe(FRAME_H - 22);
    // A quarter turn leaves float dust rather than a clean zero, and here it carries a minus sign,
    // which `toBe` would separate from 0 by Object.is.
    expect(spot.shiftY).toBeCloseTo(0);
    expect(spot.shiftX).toBeLessThan(0);
  });
});
