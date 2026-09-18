import { describe, expect, it } from 'vitest';

import type { PreviewVideoLayer } from '../../state/editor-store';
import { layerDraw, orderedLayers } from './preview-canvas';

/**
 * What the preview hands its compositor, which is the one thing that has to agree with `render.ts`
 * layer for layer. The pixels are pinned in the browser test beside this; these are the two shapes
 * that decide where those pixels land, and they are arithmetic.
 */

function layer(over: Partial<PreviewVideoLayer> = {}): PreviewVideoLayer {
  return {
    trackId: null,
    clipId: 'seg',
    clipKey: 'clip',
    sourceMs: 0,
    rect: null,
    crop: null,
    fit: 'contain',
    opacity: 1,
    z: 0,
    ...over,
  };
}

/** Stands in for a loaded element: the compositor reads nothing off it but its picture's shape. */
const source = { videoWidth: 1920, videoHeight: 1080 } as HTMLVideoElement;

describe('the preview compositor', () => {
  it('draws the base track first, whatever z a layer above it claims', () => {
    // The render draws the base and then the planned tracks, and both native engines do the same:
    // the base is the bottom of the stack and a layer cannot sort under it.
    const order = orderedLayers([
      layer({ trackId: 'under', clipId: 'a', z: -5 }),
      layer({ trackId: null, clipId: 'base', z: 0 }),
      layer({ trackId: 'over', clipId: 'b', z: 3 }),
    ]);
    expect(order.map((one) => one.clipId)).toEqual(['base', 'a', 'b']);
  });

  it("keeps the base track's rectangle in its FRAMING, drawn into the whole frame", () => {
    // `render.ts` places a base clip by folding its rectangle in with the crop and the fit, into a
    // destination that is the whole frame. Handing the rectangle over as a destination instead
    // would black the whole frame at the layer's opacity - the painter fills a layer's own frame
    // before drawing it - and wipe out nothing here, but everything under an extra layer.
    const draw = layerDraw(layer({ rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, fit: 'cover' }), source);
    expect(draw.dest).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    expect(draw.framing).toEqual({ fit: 'cover', crop: undefined, rect: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } });
  });

  it("makes an extra layer's rectangle its DESTINATION, as the plan does", () => {
    const draw = layerDraw(
      layer({ trackId: 'pip', rect: { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, crop: { x: 0, y: 0, w: 0.5, h: 1 }, opacity: 0.5 }),
      source,
    );
    expect(draw.dest).toEqual({ x: 0.5, y: 0.5, w: 0.5, h: 0.5 });
    // The rectangle is GONE from the framing: left on, it would place the picture inside the layer
    // a second time - the same thing `planTrack` takes it off the clip for.
    expect(draw.framing).toEqual({ fit: 'contain', crop: { x: 0, y: 0, w: 0.5, h: 1 } });
    expect(draw.opacity).toBe(0.5);
  });

  it('carries the angle off the rectangle for either kind of layer', () => {
    const rect = { x: 0.2, y: 0.2, w: 0.4, h: 0.4, rotationDeg: 30 };
    expect(layerDraw(layer({ rect }), source).rotationDeg).toBe(30);
    expect(layerDraw(layer({ trackId: 'pip', rect }), source).rotationDeg).toBe(30);
    // Absent is upright, which is the path a post that nobody framed takes.
    expect(layerDraw(layer(), source).rotationDeg).toBe(0);
  });

  it("takes the picture's shape off the element, which is what the fit is measured against", () => {
    const draw = layerDraw(layer(), source);
    expect(draw.sourceWidth).toBe(1920);
    expect(draw.sourceHeight).toBe(1080);
    expect(draw.source).toBe(source);
  });
});
