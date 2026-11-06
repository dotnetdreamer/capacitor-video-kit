import { describe, expect, it } from 'vitest';

import { MAX_SCALE, MIN_SCALE, compileLayoutMotions, emptyManifest, type EditManifest, type EditTrack, type TrackScene } from '../../editor';

import { aimGripAt, dropTargetAt, dropTargets, gripAim, handleSpot, hitsLayer, pinchedScale, pressBelongsToLayer, type DropTarget, type LayerBox } from './overlay-gestures';

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

describe('a pinch', () => {
  it('sizes a layer between the smallest and largest a customer can pick', () => {
    expect(pinchedScale(1, 2)).toBe(2);
    expect(pinchedScale(4, 2)).toBe(MAX_SCALE);
    expect(pinchedScale(1, 0.01)).toBe(MIN_SCALE);
  });

  it('never jumps a layer a track has drawn past them: it is made smaller, or bigger, and back', () => {
    expect(pinchedScale(8, 1)).toBe(8);
    expect(pinchedScale(8, 1.5)).toBe(8);
    expect(pinchedScale(8, 0.5)).toBe(4);
    expect(pinchedScale(0.1, 1)).toBe(0.1);
    expect(pinchedScale(0.1, 0.5)).toBe(0.1);
    expect(pinchedScale(0.1, 3)).toBeCloseTo(0.3, 9);
  });
});

describe("the Track sheet's box", () => {
  // A box a quarter of the frame across, in the middle: 100x200 on the 400x800 frame.
  const aim = { cx: 0.5, cy: 0.5, w: 0.25, h: 0.25 };

  it('is taken by a corner near enough to one, by its body inside it, and not at all outside it', () => {
    expect(aimGripAt(aim, 150, 300, FRAME_W, FRAME_H)).toBe('tl');
    expect(aimGripAt(aim, 250 + 20, 500 - 10, FRAME_W, FRAME_H)).toBe('br');
    expect(aimGripAt(aim, 250, 300, FRAME_W, FRAME_H)).toBe('tr');
    expect(aimGripAt(aim, 200, 400, FRAME_W, FRAME_H)).toBe('move');
    expect(aimGripAt(aim, 20, 20, FRAME_W, FRAME_H)).toBeNull();
  });

  it('moves a box too small to leave room between its corners when it is taken by its middle', () => {
    // 32x32 on the 400x800 frame: every point inside it is within a fingertip of a corner.
    const tiny = { cx: 0.5, cy: 0.5, w: 32 / FRAME_W, h: 32 / FRAME_H };
    expect(aimGripAt(tiny, 200, 400, FRAME_W, FRAME_H)).toBe('move');
    expect(aimGripAt(tiny, 205, 396, FRAME_W, FRAME_H)).toBe('move');
    // Its corners are still there for a finger nearer one than the middle, inside the box or out.
    expect(aimGripAt(tiny, 186, 386, FRAME_W, FRAME_H)).toBe('tl');
    expect(aimGripAt(tiny, 226, 426, FRAME_W, FRAME_H)).toBe('br');
    expect(aimGripAt(tiny, 200, 360, FRAME_W, FRAME_H)).toBeNull();
  });

  it('moves whole, or sizes by a corner with the opposite corner held', () => {
    expect(gripAim(aim, 'move', 0.1, -0.05)).toEqual({ cx: 0.6, cy: 0.45, w: 0.25, h: 0.25 });
    const pulled = gripAim(aim, 'br', 0.1, 0.05);
    expect(pulled.cx - pulled.w / 2).toBeCloseTo(0.375, 9);
    expect(pulled.cy - pulled.h / 2).toBeCloseTo(0.375, 9);
    expect(pulled.w).toBeCloseTo(0.35, 9);
    expect(pulled.h).toBeCloseTo(0.3, 9);
  });

  it('comes out the right way round when a corner is pulled past the opposite one', () => {
    const flipped = gripAim(aim, 'tl', 0.4, 0);
    expect(flipped.w).toBeCloseTo(0.15, 9);
    expect(flipped.cx - flipped.w / 2).toBeCloseTo(0.625, 9);
  });
});

describe('what a dragged layer can be dropped on', () => {
  /** A still thing in the middle of a 9:16 source over its first five seconds, a fifth of it across and a tenth down. */
  function track(id: string, over: Partial<EditTrack> = {}): EditTrack {
    return {
      id,
      name: id,
      hue: 2,
      clipId: 'seg-a',
      clipKey: 'clip-a',
      aspect: 9 / 16,
      box: { w: 0.2, h: 0.1 },
      atMs: [0, 1000, 2000, 3000, 4000, 5000],
      x: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      y: [0.5, 0.5, 0.5, 0.5, 0.5, 0.5],
      scale: [1, 1, 1, 1, 1, 1],
      turn: [0, 0, 0, 0, 0, 0],
      ...over,
    };
  }

  /** The 9:16 post a ten second clip of that source fills, with `tracks` on it. */
  function scene(tracks: EditTrack[]): TrackScene {
    const manifest: EditManifest = {
      ...emptyManifest(),
      clips: [{ id: 'seg-a', clipKey: 'clip-a', inMs: 0, outMs: 10_000, speed: 1, volume: 1, muted: false }],
      tracks,
    };
    return { manifest, camera: null, layout: compileLayoutMotions(manifest) };
  }

  it('boxes each thing where it is on the frame, with its name and colour', () => {
    const runner = track('runner');
    const [target] = dropTargets([runner], scene([runner]), 1000, null);
    expect(target).toMatchObject({ trackId: 'runner', name: 'runner', hue: 2 });
    // The source fills the frame exactly, so its fractions are the frame's.
    expect(target!.cx).toBeCloseTo(0.5, 6);
    expect(target!.cy).toBeCloseTo(0.5, 6);
    expect(target!.left).toBeCloseTo(0.4, 6);
    expect(target!.right).toBeCloseTo(0.6, 6);
    expect(target!.top).toBeCloseTo(0.45, 6);
    expect(target!.bottom).toBeCloseTo(0.55, 6);
    expect(target!.corners).toHaveLength(4);
  });

  it('leaves out the track the layer follows already, and one whose thing is not on screen at the playhead', () => {
    const later = track('later', { atMs: [6000, 7000, 8000], x: [0.5, 0.5, 0.5], y: [0.5, 0.5, 0.5], scale: [1, 1, 1], turn: [0, 0, 0] });
    const tracks = [track('runner'), track('dog'), later];
    const at = scene(tracks);
    expect(dropTargets(tracks, at, 1000, null).map(t => t.trackId)).toEqual(['runner', 'dog']);
    expect(dropTargets(tracks, at, 1000, 'runner').map(t => t.trackId)).toEqual(['dog']);
    expect(dropTargets(tracks, at, 7000, null).map(t => t.trackId)).toEqual(['later']);
  });
});

describe('letting a dragged layer go on a thing', () => {
  /** A target round the box from (`left`, `top`) to (`right`, `bottom`), its middle in the middle. */
  function target(trackId: string, left: number, top: number, right: number, bottom: number): DropTarget {
    return {
      trackId,
      name: trackId,
      hue: 0,
      corners: [
        { x: left, y: top },
        { x: right, y: top },
        { x: right, y: bottom },
        { x: left, y: bottom },
      ],
      left,
      top,
      right,
      bottom,
      cx: (left + right) / 2,
      cy: (top + bottom) / 2,
    };
  }

  // The 400x800 frame: its shorter side is its width, so the pad is 32px - 0.08 across and 0.04 down.
  const portrait = FRAME_W / FRAME_H;
  const face = target('face', 0.4, 0.4, 0.6, 0.5);

  it('takes a finger on the thing, and one a little way off it', () => {
    expect(dropTargetAt([face], 0.5, 0.45, portrait)?.trackId).toBe('face');
    expect(dropTargetAt([face], 0.33, 0.45, portrait)?.trackId).toBe('face');
    expect(dropTargetAt([face], 0.5, 0.53, portrait)?.trackId).toBe('face');
  });

  it('takes nothing for a finger well off every thing', () => {
    expect(dropTargetAt([face], 0.31, 0.45, portrait)).toBeNull();
    expect(dropTargetAt([face], 0.5, 0.55, portrait)).toBeNull();
    expect(dropTargetAt([], 0.5, 0.45, portrait)).toBeNull();
  });

  it('gives a finger where two overlap to the one whose middle is nearer', () => {
    const big = target('big', 0.2, 0.2, 0.8, 0.8);
    const small = target('small', 0.6, 0.6, 0.7, 0.7);
    expect(dropTargetAt([big, small], 0.64, 0.66, portrait)?.trackId).toBe('small');
    expect(dropTargetAt([small, big], 0.64, 0.66, portrait)?.trackId).toBe('small');
    expect(dropTargetAt([big, small], 0.45, 0.45, portrait)?.trackId).toBe('big');
  });

  it('pads as far across as down on a frame of any shape', () => {
    // 2:1, so the shorter side is the height: 0.04 across and 0.08 down.
    const thing = target('thing', 0.4, 0.4, 0.6, 0.6);
    expect(dropTargetAt([thing], 0.5, 0.33, 2)?.trackId).toBe('thing');
    expect(dropTargetAt([thing], 0.37, 0.5, 2)?.trackId).toBe('thing');
    expect(dropTargetAt([thing], 0.35, 0.5, 2)).toBeNull();
  });
});
